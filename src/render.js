// Video editing with ffmpeg: compilation (16:9), Shorts (9:16) and thumbnails.
const fs = require('fs');
const path = require('path');
const { run, fmtTime } = require('./util');
const { FFMPEG, FONT } = require('./config');
const { SAFE, buildAss } = require('./subtitles');
const fx = require('./fx');
const { log } = require('./db');

const FPS = 30;
// ffmpeg filter-graph escaping for values like a font path
const esc = (s) => String(s).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
const fontOpt = () => (FONT ? `fontfile='${esc(FONT)}':` : '');
// drawtext reads text from a file so emojis/quotes/colons never break the filter
function textFile(dir, name, text) { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; }
// split a caption into at most `lines` lines of ~`width` chars
function wrap(text, width, lines) {
  const words = String(text).trim().split(/\s+/); const out = []; let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > width && cur) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) out.push(cur);
  return out.slice(0, lines).join('\n');
}

// cut one segment to a normalized clip (same size/fps/audio so they concat cleanly)
// effects: whoosh on the cut, boom + animated emoji on the peak moment
async function cutSegment(src, seg, out, opts) {
  try { return await cutSegmentRaw(src, seg, out, opts); }
  catch (e) {
    if (opts.effects === false) throw e;
    log('Effektli montaj xato berdi, effektlarsiz qayta yig\'ilmoqda: ' + e.message.slice(0, 200), 'warn');
    return cutSegmentRaw(src, seg, out, { ...opts, effects: false });
  }
}
async function cutSegmentRaw(src, seg, out, { width = 1920, height = 1080, label, workDir, effects = true, emojis = false }) {
  const dur = seg.end - seg.start; const fd = 0.35;
  let vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS}` +
    `,fade=t=in:st=0:d=${fd},fade=t=out:st=${(dur - fd).toFixed(2)}:d=${fd}`;
  if (label) {
    const tf = textFile(workDir, path.basename(out) + '.txt', label);
    vf += `,drawtext=${fontOpt()}textfile='${esc(tf)}':fontsize=${Math.round(height / 22)}:fontcolor=white:borderw=4:bordercolor=black@0.85:x=40:y=40:enable='lt(t,3.5)'`;
  }
  const g = effects ? await fx.buildGraph(fx.planEvents({ dur, peakT: seg.peak - seg.start, peakEmoji: seg.emoji || '🔥', maxExtra: 0, emojis,
    area: { x: width - 620, y: 90, w: 560, h: 420, size: 260 } }), { vIn: 'v0', aIn: 'a0', firstIdx: 1, emojiSize: 260 }) : null;
  const fc = `[0:v]${vf}[v0];[0:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,afade=t=in:st=0:d=${fd},afade=t=out:st=${(dur - fd).toFixed(2)}:d=${fd}[a0]` +
    (g && g.filter ? ';' + g.filter : '');
  await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(seg.start), '-t', dur.toFixed(2), '-i', src, ...(g ? g.inputs : []),
    '-filter_complex', fc, '-map', `[${g ? g.vOut : 'v0'}]`, '-map', `[${g ? g.aOut : 'a0'}]`, '-t', dur.toFixed(2),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000', out]);
}

async function concat(parts, out, workDir) {
  const list = path.join(workDir, path.basename(out) + '.list');
  fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  // one pass of loudness normalization so the whole video sits at YouTube's -14 LUFS
  await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
    '-c:v', 'copy', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000', '-movflags', '+faststart', out]);
}

// horizontal compilation: segments in chronological order, numbered captions
async function renderCompilation(src, segments, out, workDir, onProgress = () => {}, { effects = true, emojis = false } = {}) {
  const ordered = [...segments].sort((a, b) => a.start - b.start); const parts = [];
  for (let i = 0; i < ordered.length; i++) {
    const p = path.join(workDir, `part_${i}.mp4`);
    await cutSegment(src, ordered[i], p, { label: ordered[i].caption ? `#${i + 1}  ${ordered[i].caption}` : `#${i + 1}`, workDir, effects, emojis });
    parts.push(p); onProgress((i + 1) / (ordered.length + 1));
  }
  await concat(parts, out, workDir);
  for (const p of parts) fs.rmSync(p, { force: true });
  onProgress(1);
}

// vertical Short, laid out around the YouTube Shorts UI (see SAFE in subtitles.js):
//   blurred full-frame background, gameplay band in the middle (zoomed in, sides cropped),
//   animated emojis in the upper part of the band (never under the like/comment column),
//   subtitles at the bottom of the band, synced word by word; sound effects mixed under the game audio.
//   No other text is burned in: the title lives in YouTube's own title field.
async function renderShort(src, seg, out, workDir, opts = {}) {
  try { return await renderShortRaw(src, seg, out, workDir, opts); }
  catch (e) {
    if (opts.effects === false && !(opts.words || []).length) throw e;
    log('Shorts effektlari bilan xato, oddiy variant yig\'ilmoqda: ' + e.message.slice(0, 200), 'warn');
    return renderShortRaw(src, seg, out, workDir, { ...opts, effects: false, words: [] });
  }
}
// split-screen crop boxes for a streamer webcam: cam on top (1080x640), gameplay below (1080x1280)
const CAM_H = 640, GAME_H = 1920 - CAM_H;
function facecamCrops(fc) {
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const ar = 1080 / CAM_H;
  // webcam: fill 1080x640 from inside the detected webcam box, keeping the face in view
  let cw = fc.w, ch = fc.h;
  if (cw / ch > ar) cw = ch * ar; else ch = cw / ar;
  const [fx, fy, fw, fh] = fc.face || [fc.x + fc.w / 2, fc.y + fc.h / 2, 0, 0];
  const cx = Math.min(Math.max(fx + fw / 2 - cw / 2, fc.x), fc.x + fc.w - cw);
  const cy = Math.min(Math.max(fy + fh / 2 - ch * 0.42, fc.y), fc.y + fc.h - ch);
  // gameplay: centre slice of the full frame, pushed away from the webcam side so the cam isn't shown twice
  const gw = Math.min(fc.width, fc.height * 1080 / GAME_H), camMid = fc.x + fc.w / 2;
  let gx = (fc.width - gw) / 2;
  if (camMid > fc.width * 0.6) gx = Math.max(0, Math.min(gx, fc.x - gw));          // cam on the right
  else if (camMid < fc.width * 0.4) gx = Math.min(fc.width - gw, Math.max(gx, fc.x + fc.w)); // cam on the left
  return { cam: { w: even(cw), h: even(ch), x: even(cx), y: even(cy) }, game: { w: even(gw), h: even(fc.height), x: even(gx) } };
}

async function renderShortRaw(src, seg, out, workDir, { words = [], accent = '#FFD400', style = 'pop', emoji = '', effects = true, emojis = false, facecam = null } = {}) {
  const dur = Math.min(58, seg.end - seg.start);
  const band = SAFE.band.h, bandY = SAFE.band.y;
  let fc;
  let emojiArea = { x: 70, y: bandY + 30, w: 800, h: 560, size: 300 };
  if (facecam) {
    // streamer layout (like popular gaming Shorts): webcam on top, a thin accent line, gameplay filling the rest
    const c = facecamCrops(facecam);
    fc = `[0:v]split[a][b];[a]crop=${c.cam.w}:${c.cam.h}:${c.cam.x}:${c.cam.y},scale=1080:${CAM_H}:flags=lanczos,setsar=1[cam];` +
      `[b]crop=${c.game.w}:${c.game.h}:${c.game.x}:0,scale=1080:${GAME_H}:flags=lanczos,setsar=1[game];` +
      `[cam][game]vstack,drawbox=x=0:y=${CAM_H - 4}:w=1080:h=8:color=${accent.replace('#', '0x')}:t=fill,fps=${FPS},fade=t=in:st=0:d=0.25[v0];`;
    emojiArea = { x: 70, y: CAM_H + 40, w: 800, h: 520, size: 300 };
  } else {
    fc = `[0:v]split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=25:2,eq=brightness=-0.15[bg];` +
      `[b]scale=-2:${band},crop='min(iw,1080)':${band}[fg];[bg][fg]overlay=(W-w)/2:${bandY},fps=${FPS},fade=t=in:st=0:d=0.25[v0];`;
  }
  fc += `[0:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0]`;
  let v = 'v0', a = 'a0', inputs = [];
  if (effects) {
    const events = fx.planEvents({ dur, peakT: (seg.peak ?? seg.start + dur / 2) - seg.start, peakEmoji: emoji || '😱', words, emojis,
      area: emojiArea });
    const g = await fx.buildGraph(events, { vIn: v, aIn: a, firstIdx: 1, emojiSize: 300 });
    if (g.filter) fc += ';' + g.filter;
    v = g.vOut; a = g.aOut; inputs = g.inputs;
  }
  if (words.length) {
    const ass = path.join(workDir, path.basename(out) + '.ass');
    fs.writeFileSync(ass, buildAss(words, dur, { accent, style }));
    fc += `;[${v}]subtitles=filename='${esc(ass)}'${FONT ? `:fontsdir='${esc(path.dirname(FONT))}'` : ''}[vs]`; v = 'vs';
  }
  fc += `;[${a}]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[aout]`;
  await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(seg.start), '-t', dur.toFixed(2), '-i', src, ...inputs,
    '-filter_complex', fc, '-map', `[${v}]`, '-map', '[aout]', '-t', dur.toFixed(2),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000', '-movflags', '+faststart', out]);
}

// 1280x720 thumbnail: punchy frame, darkened bottom, huge outlined text
async function renderThumbnail(src, atSec, text, out, workDir, { accent = '#FFD400', badge = '' } = {}) {
  const tf = textFile(workDir, path.basename(out) + '.txt', wrap(String(text).toUpperCase(), 14, 2));
  let vf = `scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,eq=saturation=1.45:contrast=1.18:brightness=0.02,unsharp=5:5:0.8,` +
    `drawbox=x=0:y=ih*0.52:w=iw:h=ih*0.48:color=black@0.45:t=fill,` +
    `drawtext=${fontOpt()}textfile='${esc(tf)}':fontsize=104:line_spacing=6:fontcolor=${accent.replace('#', '0x')}:borderw=9:bordercolor=black:x=48:y=h-text_h-52`;
  if (badge) {
    const bf = textFile(workDir, path.basename(out) + '.badge.txt', badge);
    vf += `,drawtext=${fontOpt()}textfile='${esc(bf)}':fontsize=46:fontcolor=white:box=1:boxcolor=0xE02020:boxborderw=14:x=w-text_w-40:y=36`;
  }
  await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, atSec)), '-i', src, '-frames:v', '1', '-vf', vf, '-q:v', '2', out]);
}

// small JPEG frames for the AI to look at
async function grabFrame(src, atSec, out, width = 512) {
  await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, atSec)), '-i', src, '-frames:v', '1',
    '-vf', `scale=${width}:-2`, '-q:v', '5', out]);
  return out;
}

module.exports = { facecamCrops, renderCompilation, renderShort, renderThumbnail, grabFrame, fmtTime };

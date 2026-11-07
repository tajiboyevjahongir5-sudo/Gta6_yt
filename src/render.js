// Video editing with ffmpeg: compilation (16:9), Shorts (9:16) and thumbnails.
const fs = require('fs');
const path = require('path');
const { run, fmtTime } = require('./util');
const { FFMPEG, FONT } = require('./config');

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
async function cutSegment(src, seg, out, { width = 1920, height = 1080, label, workDir }) {
  const dur = seg.end - seg.start; const fd = 0.35;
  let vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS}` +
    `,fade=t=in:st=0:d=${fd},fade=t=out:st=${(dur - fd).toFixed(2)}:d=${fd}`;
  if (label) {
    const tf = textFile(workDir, path.basename(out) + '.txt', label);
    vf += `,drawtext=${fontOpt()}textfile='${esc(tf)}':fontsize=${Math.round(height / 22)}:fontcolor=white:borderw=4:bordercolor=black@0.85:x=40:y=40:enable='lt(t,3.5)'`;
  }
  await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(seg.start), '-t', dur.toFixed(2), '-i', src,
    '-vf', vf, '-af', `aresample=48000,afade=t=in:st=0:d=${fd},afade=t=out:st=${(dur - fd).toFixed(2)}:d=${fd}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ac', '2', out]);
}

async function concat(parts, out, workDir) {
  const list = path.join(workDir, path.basename(out) + '.list');
  fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  // one pass of loudness normalization so the whole video sits at YouTube's -14 LUFS
  await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
    '-c:v', 'copy', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out]);
}

// horizontal compilation: segments in chronological order, numbered captions
async function renderCompilation(src, segments, out, workDir, onProgress = () => {}) {
  const ordered = [...segments].sort((a, b) => a.start - b.start); const parts = [];
  for (let i = 0; i < ordered.length; i++) {
    const p = path.join(workDir, `part_${i}.mp4`);
    await cutSegment(src, ordered[i], p, { label: ordered[i].caption ? `#${i + 1}  ${ordered[i].caption}` : `#${i + 1}`, workDir });
    parts.push(p); onProgress((i + 1) / (ordered.length + 1));
  }
  await concat(parts, out, workDir);
  for (const p of parts) fs.rmSync(p, { force: true });
  onProgress(1);
}

// vertical Short: blurred full-screen background + the gameplay centered + big title on top
async function renderShort(src, seg, title, out, workDir) {
  const dur = Math.min(58, seg.end - seg.start);
  const tf = textFile(workDir, path.basename(out) + '.txt', wrap(title, 18, 3));
  const fc = `[0:v]split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=25:2,eq=brightness=-0.12[bg];` +
    // gameplay zoomed in (sides cropped) so it fills ~half of the phone screen
    `[b]scale=-2:880,crop='min(iw,1080)':880[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2+60,fps=${FPS},` +
    `drawtext=${fontOpt()}textfile='${esc(tf)}':fontsize=78:line_spacing=10:fontcolor=white:borderw=6:bordercolor=black:x=(w-text_w)/2:y=230,` +
    `fade=t=in:st=0:d=0.25[v]`;
  await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(seg.start), '-t', dur.toFixed(2), '-i', src,
    '-filter_complex', fc, '-map', '[v]', '-map', '0:a?', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out]);
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

module.exports = { renderCompilation, renderShort, renderThumbnail, grabFrame, fmtTime };

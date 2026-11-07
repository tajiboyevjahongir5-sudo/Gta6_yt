// Sound effects + animated emojis for the edits.
// SFX are synthesized with ffmpeg on first use (no copyright issues). To use your own sounds, drop files with the
// same names into DATA_DIR/sfx (boom.wav, whoosh.wav, pop.wav, ding.wav) and they are used instead.
const fs = require('fs');
const path = require('path');
const { run } = require('./util');
const { FFMPEG, DATA_DIR } = require('./config');
const { log } = require('./db');

const SFX_DIR = path.join(DATA_DIR, 'sfx');
const EMOJI_DIR = path.join(DATA_DIR, 'emoji');
const PY = process.env.PYTHON_BIN || 'python3';
const ANIM = path.join(__dirname, '..', 'scripts', 'emoji_anim.py');

const SFX = {
  // deep impact: falling sine + low noise thump
  boom: ['-f', 'lavfi', '-i', "aevalsrc='0.9*sin(2*PI*(45+90*exp(-t*14))*t)*exp(-t*3.2)':s=48000:d=1.4",
    '-f', 'lavfi', '-i', 'anoisesrc=c=brown:a=0.6:d=0.35:r=48000', '-filter_complex', '[1]lowpass=f=300,afade=t=out:st=0.05:d=0.3[n];[0][n]amix=inputs=2:normalize=0,alimiter=limit=0.9'],
  // air swoosh: band-passed pink noise with a swelling envelope
  whoosh: ['-f', 'lavfi', '-i', 'anoisesrc=c=pink:a=0.8:d=0.55:r=48000', '-af', "highpass=f=400,lowpass=f=5000,volume='sin(PI*t/0.55)^2':eval=frame,alimiter=limit=0.8"],
  // bubbly pop for emojis
  pop: ['-f', 'lavfi', '-i', "aevalsrc='0.7*sin(2*PI*(1400-1100*t/0.09)*t)*exp(-t*35)':s=48000:d=0.15"],
  // bright ding
  ding: ['-f', 'lavfi', '-i', "aevalsrc='0.35*sin(2*PI*1568*t)*exp(-t*4)+0.18*sin(2*PI*3136*t)*exp(-t*6)':s=48000:d=1.1"],
};
async function sfx(name) {
  fs.mkdirSync(SFX_DIR, { recursive: true });
  for (const ext of ['wav', 'mp3', 'ogg']) { const f = path.join(SFX_DIR, `${name}.${ext}`); if (fs.existsSync(f)) return f; }
  const f = path.join(SFX_DIR, `${name}.wav`);
  await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...SFX[name], '-ac', '2', f]);
  return f;
}

// animated emoji -> folder of PNG frames (cached per emoji)
let emojiBroken = false;
async function emojiFrames(emoji) {
  if (emojiBroken) return null;
  const key = [...emoji].map((c) => c.codePointAt(0).toString(16)).join('-');
  const dir = path.join(EMOJI_DIR, key);
  if (fs.existsSync(path.join(dir, '000.png'))) return dir;
  try { await run(PY, [ANIM, emoji, dir]); return dir; }
  catch (e) {
    if (/ENOENT|No module named|cannot open resource/.test(e.message)) { emojiBroken = true; log('Emoji o\'chiq: python3-pil va fonts-noto-color-emoji kerak', 'warn'); }
    else log(`Emoji chizilmadi (${emoji}): ${e.message}`, 'warn');
    return null;
  }
}

// words in the (English) subtitles -> emoji reactions
const KEYWORDS = [
  [/\b(lol|lmao|haha+|funny|hilarious|joke)\b/i, '😂'], [/\b(dead|died|dies|kill(ed)?|rip)\b/i, '💀'],
  [/\b(cops?|police|sheriff|wanted|chase)\b/i, '🚓'], [/\b(what|omg|no way|wtf|bro)\b/i, '😱'],
  [/\b(crash(ed)?|explod\w*|boom|blew|bomb)\b/i, '💥'], [/\b(money|cash|rich|bank|heist|rob\w*)\b/i, '💰'],
  [/\b(fire|insane|crazy|sick|lit)\b/i, '🔥'], [/\b(car|drive|drift|speed|fast)\b/i, '🏎️'],
  [/\b(gun|shoot\w*|shot)\b/i, '🔫'], [/\b(run|go go|hurry|escape)\b/i, '🏃'], [/\b(love|beautiful|wow)\b/i, '😍'],
];
function emojiForText(text) { for (const [re, e] of KEYWORDS) if (re.test(text)) return e; return null; }

// plan the effects of one clip. peakT = loudest moment (seconds into the clip)
function planEvents({ dur, peakT, peakEmoji, words = [], area, maxExtra = 2, intro = true }) {
  const ev = [];
  if (intro) ev.push({ t: 0, sfx: 'whoosh', vol: 0.35 });
  const pt = Math.max(0.3, Math.min(dur - 1.5, peakT));
  ev.push({ t: pt - 0.05, sfx: 'boom', vol: 0.55 });
  if (peakEmoji) ev.push({ t: pt, emoji: peakEmoji, ...spot(area, 0) });
  let last = pt, extra = 0;
  for (const w of words) {
    if (extra >= maxExtra || w.start > dur - 1.5 || Math.abs(w.start - last) < 2.5) continue;
    const e = emojiForText(w.word);
    if (e && e !== peakEmoji) { ev.push({ t: w.start, emoji: e, ...spot(area, ++extra) }, { t: w.start, sfx: 'pop', vol: 0.5 }); last = w.start; }
  }
  return ev;
}
// emoji positions rotate between a few spots inside the allowed area (top-left of each emoji canvas)
function spot(area, i) {
  const spots = [[0.62, 0.05], [0.08, 0.12], [0.55, 0.38], [0.12, 0.45]];
  const [fx, fy] = spots[i % spots.length];
  return { x: Math.round(area.x + fx * (area.w - area.size)), y: Math.round(area.y + fy * (area.h - area.size)) };
}

// turn events into ffmpeg inputs + filter graph pieces.
// vIn/aIn are labels of the main video/audio; firstIdx = index of the first extra input.
async function buildGraph(events, { vIn, aIn, firstIdx, emojiSize = 300 }) {
  const inputs = []; const vParts = []; const aLabels = []; const aParts = [];
  let idx = firstIdx, v = vIn, k = 0;
  for (const e of events) {
    if (e.emoji) {
      const dir = await emojiFrames(e.emoji); if (!dir) continue;
      inputs.push('-framerate', '30', '-i', path.join(dir, '%03d.png'));
      const canvas = Math.round(emojiSize * 1.6);
      vParts.push(`[${idx}:v]format=rgba,setpts=PTS-STARTPTS+${e.t.toFixed(3)}/TB[em${k}];[${v}][em${k}]overlay=${e.x - (canvas - emojiSize) / 2}:${e.y - (canvas - emojiSize) / 2}:eof_action=pass:format=auto[vx${k}]`);
      v = `vx${k}`; idx++; k++;
    } else if (e.sfx) {
      try { inputs.push('-i', await sfx(e.sfx)); } catch (err) { log('SFX yaratilmadi: ' + err.message, 'warn'); continue; }
      const ms = Math.max(0, Math.round(e.t * 1000));
      aParts.push(`[${idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${e.vol ?? 0.5},adelay=${ms}|${ms}[sx${idx}]`);
      aLabels.push(`[sx${idx}]`); idx++;
    }
  }
  let a = aIn;
  if (aLabels.length) { aParts.push(`[${aIn}]${aLabels.join('')}amix=inputs=${aLabels.length + 1}:normalize=0:duration=first[amix]`); a = 'amix'; }
  return { inputs, filter: [...vParts, ...aParts].join(';'), vOut: v, aOut: a };
}

module.exports = { sfx, emojiFrames, emojiForText, planEvents, buildGraph };

// Word-by-word Shorts subtitles: speech -> words (faster-whisper) -> styled ASS file burned in by ffmpeg/libass.
const fs = require('fs');
const path = require('path');
const { run } = require('./util');
const { FFMPEG, FONT } = require('./config');
const { log } = require('./db');

// Where the YouTube Shorts UI sits on a 1080x1920 frame, measured from a real phone screenshot (iPhone, 2026):
//   right column (like / comment / save / share / remix): x >= ~935, from y ~1026 down
//   bottom block (search hint, @channel + Subscribe, title): y >= ~1634
//   top bar (back, search, menu): y <= ~125
// Layout built on it (same as popular GTA edit Shorts):
//   gameplay    band y 430..1430
//   subtitles   one line, bottom edge at y ~1400 (inside the gameplay band), left of the button column
// equal side margins keep the subtitle centred like the reference while still ending before the buttons (x 920 < 935)
const SAFE = { W: 1080, H: 1920, top: 125, bottom: 286, left: 160, right: 160, buttonsX: 935, buttonsY: 1026 };
SAFE.x0 = SAFE.left; SAFE.x1 = SAFE.W - SAFE.right; SAFE.cx = (SAFE.x0 + SAFE.x1) / 2; // 540
SAFE.band = { y: 430, h: 1000 };
SAFE.subBottom = 1400;   // subtitle baseline area: ~234px of clearance above the bottom block (room for a 2-line title)

const PY = process.env.PYTHON_BIN || 'python3';
const SCRIPT = path.join(__dirname, '..', 'scripts', 'transcribe.py');
let unavailable = false;

// words spoken inside [start, start+dur] of the source, with times relative to the clip
async function transcribe(src, start, dur, workDir, { model = 'small', lang = 'auto' } = {}) {
  if (unavailable) return [];
  const wav = path.join(workDir, `sub_${Math.round(start)}.wav`);
  try {
    await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(start), '-t', String(dur), '-i', src, '-vn', '-ac', '1', '-ar', '16000', wav]);
    const { out } = await run(PY, [SCRIPT, wav, '--model', model, '--lang', lang], { timeoutMs: 15 * 60000 });
    const j = JSON.parse(out);
    return (j.words || []).filter((w) => w.end > 0 && w.start < dur);
  } catch (e) {
    if (/ENOENT|ModuleNotFoundError|No module named/.test(e.message)) {
      unavailable = true; log('Subtitr o\'chiq: python3 + faster-whisper o\'rnatilmagan (pip install faster-whisper)', 'warn');
    } else log('Subtitr yaratilmadi: ' + e.message, 'warn');
    return [];
  } finally { fs.rmSync(wav, { force: true }); }
}

// group words into short phrases: <= 3 words, <= 18 chars, split on pauses
function phrases(words, { maxWords = 3, maxChars = 18, gap = 0.6 } = {}) {
  const out = []; let cur = [];
  for (const w of words) {
    const prev = cur[cur.length - 1];
    const text = cur.map((x) => x.word).join(' ');
    if (cur.length && (cur.length >= maxWords || (text + ' ' + w.word).length > maxChars || w.start - prev.end > gap)) { out.push(cur); cur = []; }
    cur.push(w);
  }
  if (cur.length) out.push(cur);
  return out;
}

const assTime = (t) => { t = Math.max(0, t); const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = (t % 60).toFixed(2).padStart(5, '0'); return `${h}:${String(m).padStart(2, '0')}:${s}`; };
const assText = (s, upper) => { const t = String(s).replace(/[{}\\]/g, '').replace(/\n/g, ' '); return upper ? t.toLocaleUpperCase('uz') : t; };
const assColor = (hex) => { const h = hex.replace('#', '').padEnd(6, '0'); return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase(); };

function fontFamily() {
  if (!FONT) return 'DejaVu Sans';
  try { return require('child_process').execFileSync('fc-scan', ['--format', '%{family[0]}', FONT]).toString().trim() || 'DejaVu Sans'; }
  catch (e) { return /DejaVu/i.test(FONT) ? 'DejaVu Sans' : path.basename(FONT).replace(/[-_ ]?(Bold|Black|Heavy).*$/i, '').replace(/\.[ot]tf$/i, ''); }
}

// ASS file. style 'clean' = like the reference Short (italic, white, soft shadow, sentence case);
// 'karaoke' = bold caps with the spoken word in the accent colour.
function buildAss(words, dur, { accent = '#FFD400', style = 'clean' } = {}) {
  const karaoke = style === 'karaoke';
  const size = karaoke ? 70 : 66;
  const marginV = SAFE.H - SAFE.subBottom; // alignment 2 = bottom-centre between MarginL and MarginR
  const sub = karaoke
    ? `Style: Sub,${fontFamily()},${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,6,3,2,${SAFE.left},${SAFE.right},${marginV},1`
    : `Style: Sub,${fontFamily()},${size},&H00FFFFFF,&H00FFFFFF,&H50000000,&H90000000,-1,-1,0,0,100,100,0,0,1,2.5,4,2,${SAFE.left},${SAFE.right},${marginV},1`;
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${SAFE.W}
PlayResY: ${SAFE.H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${sub}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const hi = assColor(accent); const lines = [];
  for (const ph of phrases(words, karaoke ? { maxChars: 16 } : { maxWords: 4, maxChars: 20 })) {
    const end = Math.min(dur, ph[ph.length - 1].end + 0.25);
    if (!karaoke) {
      let t = ph.map((x) => assText(x.word)).join(' '); t = t.charAt(0).toLocaleUpperCase('uz') + t.slice(1);
      lines.push(`Dialogue: 0,${assTime(ph[0].start)},${assTime(end)},Sub,,0,0,0,,{\\fad(80,80)}${t}`);
      continue;
    }
    // one event per word: the whole phrase stays, the spoken word turns accent-coloured and pops slightly
    ph.forEach((w, i) => {
      const s = i === 0 ? ph[0].start : w.start; const e = i < ph.length - 1 ? ph[i + 1].start : end;
      if (e <= s) return;
      const text = ph.map((x, k) => (k === i ? `{\\c${hi}\\fscx108\\fscy108}${assText(x.word, true)}{\\r}` : assText(x.word, true))).join(' ');
      lines.push(`Dialogue: 0,${assTime(s)},${assTime(e)},Sub,,0,0,0,,${text}`);
    });
  }
  return head + lines.join('\n') + '\n';
}

module.exports = { SAFE, transcribe, buildAss, phrases, fontFamily };

// Word-by-word Shorts subtitles: speech -> words (faster-whisper) -> styled ASS file burned in by ffmpeg/libass.
const fs = require('fs');
const path = require('path');
const { run } = require('./util');
const { FFMPEG, FONT } = require('./config');
const { log } = require('./db');

// YouTube Shorts UI covers parts of the 1080x1920 frame. Sources disagree, so these are the conservative values:
//   bottom 672px: channel name, Subscribe, title/description, sound
//   right 192px:  like / dislike / comment / share / remix column
//   top 288px:    search, menu
// Everything important (title, subtitles) must stay inside this box.
const SAFE = { W: 1080, H: 1920, top: 288, bottom: 672, left: 48, right: 192 };
SAFE.x0 = SAFE.left; SAFE.x1 = SAFE.W - SAFE.right; SAFE.y0 = SAFE.top; SAFE.y1 = SAFE.H - SAFE.bottom;
SAFE.cx = (SAFE.x0 + SAFE.x1) / 2; // 468: the visual center of the free area, not the frame center

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
const assText = (s) => String(s).replace(/[{}\\]/g, '').replace(/\n/g, ' ').toLocaleUpperCase('uz');
const assColor = (hex) => { const h = hex.replace('#', '').padEnd(6, '0'); return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase(); };

function fontFamily() {
  if (!FONT) return 'DejaVu Sans';
  try { return require('child_process').execFileSync('fc-scan', ['--format', '%{family[0]}', FONT]).toString().trim() || 'DejaVu Sans'; }
  catch (e) { return /DejaVu/i.test(FONT) ? 'DejaVu Sans' : path.basename(FONT).replace(/[-_ ]?(Bold|Black|Heavy).*$/i, '').replace(/\.[ot]tf$/i, ''); }
}

// ASS file: bottom-centered inside the safe box, current word highlighted
function buildAss(words, dur, { accent = '#FFD400', fontSize = 76 } = {}) {
  const marginV = SAFE.bottom + 28; // text baseline sits just above the description area
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${SAFE.W}
PlayResY: ${SAFE.H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,${fontFamily()},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,7,3,2,${SAFE.left},${SAFE.right},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const hi = assColor(accent); const lines = [];
  for (const ph of phrases(words)) {
    const end = Math.min(dur, ph[ph.length - 1].end + 0.25);
    // one event per word: the whole phrase stays, the spoken word turns yellow and pops slightly
    ph.forEach((w, i) => {
      const s = i === 0 ? ph[0].start : w.start; const e = i < ph.length - 1 ? ph[i + 1].start : end;
      if (e <= s) return;
      const text = ph.map((x, k) => (k === i ? `{\\c${hi}\\fscx108\\fscy108}${assText(x.word)}{\\r}` : assText(x.word))).join(' ');
      lines.push(`Dialogue: 0,${assTime(s)},${assTime(e)},Sub,,0,0,0,,${text}`);
    });
  }
  return head + lines.join('\n') + '\n';
}

module.exports = { SAFE, transcribe, buildAss, phrases, fontFamily };

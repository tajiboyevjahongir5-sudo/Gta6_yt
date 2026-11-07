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
// Speech -> words with timings. Recognition in the speaker's own language with a big Whisper model; if the video
// language is different (e.g. Russian speech, English channel) the AI translates phrase by phrase, fixing words
// Whisper misheard from the video's context. Timings stay Whisper's, so the subtitles still follow the voice.
async function transcribe(src, start, dur, workDir, { model = 'large-v3-turbo', lang = 'auto', to = 'en', context = {}, select = '' } = {}) {
  if (unavailable) return [];
  const wav = path.join(workDir, `sub_${Math.round(start)}.wav`);
  const hint = [context.title, context.subject].filter(Boolean).join('. ');
  try {
    // speech band + noise reduction + level: game music/explosions confuse recognition
    await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(start), '-t', String(dur), '-i', src, '-vn',
      // select: jump-cut Shorts - transcribe exactly the kept parts, so word times match the edited video
      '-af', (select ? `aselect='${select}',asetpts=N/SR/TB,` : '') + 'highpass=f=90,lowpass=f=7500,afftdn=nf=-25,dynaudnorm=f=150:g=15', '-ac', '1', '-ar', '16000', wav]);
    const asr = async (extra = []) => JSON.parse((await run(PY, [SCRIPT, wav, '--model', model, '--lang', lang, '--context', hint, ...extra],
      { timeoutMs: 20 * 60000 })).out);
    let j = await asr();
    let words = (j.words || []).filter((w) => w.end > 0 && w.start < dur);
    if (!words.length || !to || j.language === to) return words;
    const translated = await translateWords(words, j.language, to, context);
    if (translated) return translated;
    // no AI: Whisper's own speech -> English translation (less accurate)
    if (to === 'en') { j = await asr(['--to', 'en']); return (j.words || []).filter((w) => w.end > 0 && w.start < dur); }
    return words;
  } catch (e) {
    if (/ENOENT|ModuleNotFoundError|No module named/.test(e.message)) {
      unavailable = true; log('Subtitr o\'chiq: python3 + faster-whisper o\'rnatilmagan (pip install faster-whisper)', 'warn');
    } else log('Subtitr yaratilmadi: ' + e.message, 'warn');
    return [];
  } finally { fs.rmSync(wav, { force: true }); }
}

const LANG_NAMES = { en: 'English', ru: 'Russian', uz: 'Uzbek', tr: 'Turkish', kk: 'Kazakh', ky: 'Kyrgyz', tg: 'Tajik', de: 'German', es: 'Spanish' };
async function translateWords(words, from, to, context) {
  const ai = require('./ai');
  if (!ai.enabled()) return null;
  const groups = phrases(words, { maxWords: 6, maxChars: 34, gap: 0.7 });
  const lines = groups.map((g) => g.map((w) => w.word).join(' '));
  const r = await ai.generateJSON({
    schema: { type: 'object', additionalProperties: false, required: ['lines'],
      properties: { lines: { type: 'array', items: { type: 'string' } } } },
    maxTokens: 4000,
    parts: [{ text:
      `Subtitle lines from a ${LANG_NAMES[from] || from} speaker in the video "${context.title || ''}"${context.subject ? ` (${context.subject})` : ''}.\n` +
      `They come from automatic speech recognition, so some words may be misheard: fix them using the context.\n` +
      `Translate every line into short, natural spoken ${LANG_NAMES[to] || to} (keep the tone, slang and emotion; no quotes, no extra notes).\n` +
      `Return exactly ${lines.length} lines in "lines", in the same order, one per input line.\n\n` +
      lines.map((l, i) => `${i + 1}. ${l}`).join('\n') }],
  });
  const out = r?.data?.lines;
  if (!Array.isArray(out) || out.length !== lines.length) { log('Subtitr tarjimasi mos kelmadi, Whisper tarjimasi ishlatiladi', 'warn'); return null; }
  // spread each translated line's words over the time its original phrase was spoken (longer words get more time)
  const res = [];
  groups.forEach((g, i) => {
    const toks = String(out[i]).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (!toks.length) return;
    const t0 = g[0].start, t1 = g[g.length - 1].end, total = toks.reduce((a, w) => a + w.length + 1, 0);
    let t = t0;
    for (const w of toks) { const d = ((t1 - t0) * (w.length + 1)) / total; res.push({ word: w, start: +t.toFixed(2), end: +(t + d).toFixed(2) }); t += d; }
  });
  return res;
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

// ASS file. Styles:
//   'pop'     (default) words appear one by one exactly when spoken, each with a bouncy pop; the newest word in accent colour
//   'clean'   like the reference Short: italic white phrase, soft shadow
//   'karaoke' bold caps phrase, the spoken word in accent colour
function buildAss(words, dur, { accent = '#FFD400', style = 'pop' } = {}) {
  const karaoke = style === 'karaoke', pop = style === 'pop';
  const size = karaoke || pop ? 70 : 66;
  const marginV = SAFE.H - SAFE.subBottom; // alignment 2 = bottom-centre between MarginL and MarginR
  const sub = karaoke || pop
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
  const list = phrases(words, karaoke || pop ? { maxChars: 16 } : { maxWords: 4, maxChars: 20 });
  for (const [pi, ph] of list.entries()) {
    // a phrase stays 0.25s after its last word, but never overlaps the next phrase
    const end = Math.min(dur, ph[ph.length - 1].end + 0.25, list[pi + 1] ? list[pi + 1][0].start : Infinity);
    if (pop) {
      // event i shows words 0..i; word i pops (60% -> 118% -> 100%) and is accent-coloured, the earlier ones are white
      ph.forEach((w, i) => {
        const e = i < ph.length - 1 ? ph[i + 1].start : end;
        if (e <= w.start) return;
        const shown = ph.slice(0, i + 1).map((x, k) => (k === i
          ? `{\\c${hi}\\fscx60\\fscy60\\t(0,90,\\fscx118\\fscy118)\\t(90,170,\\fscx100\\fscy100)}${assText(x.word, true)}{\\r}`
          : assText(x.word, true))).join(' ');
        // invisible rest of the phrase keeps the line from jumping sideways as words are added
        const rest = ph.slice(i + 1).map((x) => assText(x.word, true)).join(' ');
        lines.push(`Dialogue: 0,${assTime(w.start)},${assTime(e)},Sub,,0,0,0,,${shown}${rest ? `{\\alpha&HFF&} ${rest}` : ''}`);
      });
      continue;
    }
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

const FACECAM = path.join(__dirname, '..', 'scripts', 'facecam.py');
async function detectFacecam(src) {
  try { const { out } = await run(PY, [FACECAM, src], { timeoutMs: 10 * 60000 }); const j = JSON.parse(out); return j.found ? j : null; }
  catch (e) { log('Webkamera aniqlanmadi: ' + e.message.slice(0, 200), 'warn'); return null; }
}

module.exports = { translateWords, detectFacecam, SAFE, transcribe, buildAss, phrases, fontFamily };

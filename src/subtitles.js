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
SAFE.subBottom = 1500;   // subtitle baseline: ~134px above the channel/description block (starts at ~1634)

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
    // Whisper often hears Uzbek as Turkish/Kazakh: when the channel is Uzbek and the speaker language is "auto",
    // tell it the language instead of letting it guess
    const spoken = lang !== 'auto' ? lang : (to === 'uz' ? 'uz' : 'auto');
    const asr = async (extra = []) => JSON.parse((await run(PY, [SCRIPT, wav, '--model', model, '--lang', spoken, '--context', hint, ...extra],
      { timeoutMs: 20 * 60000 })).out);
    let j = await asr();
    if (to === 'uz' && ['tr', 'kk', 'az', 'ky', 'tk', 'tg', 'ba', 'tt'].includes(j.language)) j.language = 'uz';
    let words = (j.words || []).filter((w) => w.end > 0 && w.start < dur);
    // Gemini listens to the whole clip and writes ALL the speech (Whisper misses and mishears a lot in Uzbek);
    // Whisper's word starts only sharpen the timing
    const full = (await geminiByRanges(wav, j.speech || [], words, to || j.language, context, dur, { model, spoken: j.language })) || (await geminiSubtitles(wav, words, to || j.language, context, dur));
    if (full) return lead(full);
    if (!words.length) return words;
    // the AI listens to the clip and fixes (same language) or translates each phrase; Whisper keeps the timing
    const fixed = await translateWords(words, j.language, to || j.language, context, wav);
    if (fixed) return lead(fixed);
    if (!to || j.language === to) return lead(words);
    // no AI: Whisper's own speech -> English translation (less accurate)
    if (to === 'en') { j = await asr(['--to', 'en']); return lead((j.words || []).filter((w) => w.end > 0 && w.start < dur)); }
    return lead(words);
  } catch (e) {
    if (/ENOENT|ModuleNotFoundError|No module named/.test(e.message)) {
      unavailable = true; log('Subtitr o\'chiq: python3 + faster-whisper o\'rnatilmagan (pip install faster-whisper)', 'warn');
    } else log('Subtitr yaratilmadi: ' + e.message, 'warn');
    return [];
  } finally { fs.rmSync(wav, { force: true }); }
}

// subtitles appear a hair before the voice (Whisper marks word starts a bit late; a tiny lead reads as in sync)
const lead = (ws, by = 0.08) => ws.map((w) => ({ ...w, start: Math.max(0, +(w.start - by).toFixed(2)), end: Math.max(0.05, +(w.end - by).toFixed(2)) }));

// Best path: VAD gives the exact speech ranges (ms precision); Gemini listens and writes what is said in EACH range.
// One answer per range -> nothing is skipped, and the timing comes from the audio itself, not from the AI.
async function geminiByRanges(wav, speech, words, to, context, dur, { model = 'large-v3-turbo', spoken = '' } = {}) {
  const ai = require('./ai');
  if (!ai.providers().includes('gemini') || !fs.existsSync(wav) || !speech.length) return null;
  // merge ranges closer than 0.25 s, split very long ones at word gaps later
  const ranges = [];
  for (const [a, b] of speech) { const last = ranges[ranges.length - 1]; if (last && a - last[1] < 0.25) last[1] = b; else ranges.push([a, b]); }
  const target = to === 'uz' ? 'Uzbek in LATIN script (o\' g\' sh ch; never Cyrillic, never Turkish spelling)' : (LANG_NAMES[to] || to);
  const r = await ai.generateJSON({
    schema: { type: 'object', additionalProperties: false, required: ['lines'], properties: { lines: { type: 'array', items: { type: 'string' } } } },
    maxTokens: 8000, quality: 'high',
    parts: [{ text: 'Audio of a gaming video clip:' }, { audio: wav }, { text:
      `Someone speaks in these ${ranges.length} time ranges (seconds from the start of the audio). After each range: what a rough ` +
      `automatic recogniser heard there (often wrong, only a hint for names and terms):\n` +
      ranges.map((x, i) => `${i + 1}. ${x[0].toFixed(2)}-${x[1].toFixed(2)}  (heard: ${words.filter((w) => w.start >= x[0] - 0.15 && w.start < x[1]).map((w) => w.word).join(' ') || '-'})`).join('\n') +
      (context.terms?.length ? `\n\nNames and terms that may be said in this video: ${context.terms.slice(0, 30).join(', ')}.` : '') +
      `\n\nTake your time: listen to each range carefully (more than once if needed) and understand the meaning before writing.` +
      `\nFor EACH range write exactly what is said in it, word for word and correctly spelled, in ${target}` +
      ` (if the speaker uses another language, translate naturally; keep slang, tone and emotion).` +
      ` Video: "${context.title || ''}"${context.subject ? ` (${context.subject})` : ''}.\n` +
      `Return "lines" with exactly ${ranges.length} items in the same order; an item may be "" only if the range is not speech (noise, music).` +
      ` No speaker names, no sound descriptions, no quotes.` }],
  });
  let lines = r?.data?.lines;
  if (!Array.isArray(lines) || lines.length !== ranges.length) { if (r) log('Subtitr: Gemini oraliqlar soni mos kelmadi', 'warn'); return null; }
  // second listen: the AI checks its own draft against the audio and fixes misheard words / spelling
  const chk = await ai.generateJSON({
    schema: { type: 'object', additionalProperties: false, required: ['lines'], properties: { lines: { type: 'array', items: { type: 'string' } } } },
    maxTokens: 8000, quality: 'high',
    parts: [{ text: 'Audio of a gaming video clip:' }, { audio: wav }, { text:
      `Below is a draft subtitle for each of ${ranges.length} speech ranges (seconds). Listen to every range again, slowly, and correct ` +
      `it: wrong or misheard words, missing words, extra words, spelling. The text must be exactly what is said (in ${target}), ` +
      `nothing invented. Keep a line unchanged if it is already right.` +
      (context.terms?.length ? ` Names and terms in this video: ${context.terms.slice(0, 30).join(', ')}.` : '') + `\n\n` +
      ranges.map((x, i) => `${i + 1}. ${x[0].toFixed(2)}-${x[1].toFixed(2)}: ${lines[i] || ''}`).join('\n') +
      `\n\nReturn "lines" with exactly ${ranges.length} items in the same order.` }],
  });
  if (Array.isArray(chk?.data?.lines) && chk.data.lines.length === ranges.length) {
    const changed = chk.data.lines.filter((l, i) => String(l).trim() !== String(lines[i]).trim()).length;
    lines = chk.data.lines; log(`Subtitr: ikkinchi tinglashda ${changed} ta qator tuzatildi`);
  }
  // the AI text per range -> tokens; then each token gets its time from the AUDIO by aligning its letters with the
  // letters Whisper heard (Whisper's word times are acoustic and precise, its spelling is what is often wrong)
  const toks = [];
  ranges.forEach(([a, b], i) => String(lines[i] || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
    .forEach((w) => toks.push({ word: w, a, b })));
  if (!toks.length) return null;
  // best: lay the correct text onto the audio with Whisper's aligner (only when the subtitles are in the spoken language)
  const same = !spoken || spoken === to || (to === 'uz' && ['tr', 'kk', 'az', 'ky', 'tk', 'uz'].includes(spoken));
  const forced = same ? await forceAlign(wav, ranges, lines, model, to) : null;
  const out = forced && forced.length >= toks.length * 0.7 ? mergeForced(forced, toks, words) : alignTokens(toks, words);
  if (!out.length) return null;
  if (!out.length) return null;
  log(`Subtitr: Gemini ${ranges.length} ta nutq oralig'ini yozdi`);
  return out;
}

// Whisper forced alignment (scripts/align.py): the known text -> the moment each word is spoken
const ALIGN = path.join(__dirname, '..', 'scripts', 'align.py');
async function forceAlign(wav, ranges, lines, model, lang) {
  const segFile = wav.replace(/\.wav$/, '') + '_segs.json';
  try {
    fs.writeFileSync(segFile, JSON.stringify(ranges.map(([a, b], i) => ({ a, b, text: String(lines[i] || '').replace(/\s+/g, ' ').trim() }))));
    const r = JSON.parse((await run(PY, [ALIGN, wav, segFile, '--model', model, '--lang', lang], { timeoutMs: 15 * 60000 })).out);
    log(`Subtitr: ${r.words.length} ta so'z ovozga majburiy tekislandi`);
    return r.words;
  } catch (e) { log('Subtitr: majburiy tekislash ishlamadi (' + String(e.message).slice(0, 160) + '), harf tekislash ishlatiladi', 'warn'); return null; }
  finally { fs.rmSync(segFile, { force: true }); }
}
// forced times for the tokens (same order); a token the aligner skipped gets a time from letter alignment
function mergeForced(forced, toks, words) {
  const fb = alignTokens(toks, words);
  let f = 0; const out = [];
  toks.forEach((t, k) => {
    const m = forced[f] && forced[f].word === t.word ? forced[f++] : null;
    let st = m ? m.start : fb[k].start, en = m ? m.end : fb[k].end;
    st = Math.max(t.a - 0.1, Math.min(t.b - 0.05, st));      // stay inside the speech range
    const prev = out[out.length - 1];
    if (prev && st < prev.start + 0.05) st = prev.start + 0.05;
    en = Math.max(st + 0.08, Math.min(en, st + 1.6, t.b + 0.15));
    out.push({ word: t.word, start: +st.toFixed(2), end: +en.toFixed(2) });
  });
  return out;
}

// --- letter-level alignment of the correct text (AI) to the timed recognition (Whisper) ---
const CYR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 's', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'e',
  ю: 'yu', я: 'ya', ў: 'o', қ: 'q', ғ: 'g', ҳ: 'h', ş: 'sh', ç: 'ch', ğ: 'g', ı: 'i', ö: 'o', ü: 'u', ä: 'a', é: 'e' };
const norm = (w) => [...String(w).toLowerCase()].map((c) => (c in CYR ? CYR[c] : c)).join('').replace(/[^a-z0-9]/g, '');
// sounds Whisper confuses in Uzbek: cheap substitutions
const SIM = new Set(['oa', 'ao', 'ou', 'uo', 'iy', 'yi', 'ie', 'ei', 'kq', 'qk', 'xh', 'hx', 'gk', 'kg', 'dt', 'td', 'bp', 'pb', 'sz', 'zs', 'vw', 'wv', 'jy', 'yj']);

function alignTokens(toks, words) {
  // Whisper letters with times (each word's span shared evenly by its letters)
  const wc = []; // {c, t}
  for (const w of words) {
    const n = norm(w.word); if (!n) continue;
    const d = Math.max(0.04, w.end - w.start);
    [...n].forEach((c, i) => wc.push({ c, t: w.start + (d * i) / n.length }));
  }
  // AI letters, each remembers its token
  const gc = []; // {c, k}
  toks.forEach((t, k) => [...norm(t.word)].forEach((c, p) => gc.push({ c, k, p })));
  const n = gc.length, m = wc.length;
  const matchT = new Array(toks.length).fill(null); // time of first matched letter + its offset in the token
  let matched = 0;
  if (n && m && n * m <= 4e6) {
    // edit distance (costs x2: equal 0, similar 1, other 2, gap 2), then walk back to pair letters
    const W = m + 1, D = new Int32Array((n + 1) * W);
    for (let j = 0; j <= m; j++) D[j] = j * 2;
    for (let i = 1; i <= n; i++) {
      D[i * W] = i * 2;
      for (let j = 1; j <= m; j++) {
        const x = gc[i - 1].c, y = wc[j - 1].c;
        const sub = x === y ? 0 : SIM.has(x + y) ? 1 : 2;
        D[i * W + j] = Math.min(D[(i - 1) * W + j - 1] + sub, D[(i - 1) * W + j] + 2, D[i * W + j - 1] + 2);
      }
    }
    const pos = new Array(toks.length).fill(-1); // letter index inside token of its first matched letter
    let i = n, j = m;
    while (i > 0 && j > 0) {
      const x = gc[i - 1].c, y = wc[j - 1].c; const sub = x === y ? 0 : SIM.has(x + y) ? 1 : 2;
      if (D[i * W + j] === D[(i - 1) * W + j - 1] + sub) {
        if (sub < 2) { const k = gc[i - 1].k; matched++;
          // walking backwards: the last assignment is the first letter of the token
          matchT[k] = wc[j - 1].t; pos[k] = gc[i - 1].p; }
        i--; j--;
      } else if (D[i * W + j] === D[(i - 1) * W + j] + 2) i--; else j--;
    }
    // first letter not matched -> step back by ~70 ms per letter
    matchT.forEach((t, k) => { if (t !== null && pos[k] > 0) matchT[k] = t - pos[k] * 0.07; });
  }
  const good = n && matched / n >= 0.3;
  // tokens without a reliable audio time: placed between their neighbours (or by letter share inside their range)
  const st = toks.map((t, k) => {
    const v = good ? matchT[k] : null;
    return v !== null && v >= t.a - 0.3 && v <= t.b + 0.1 ? Math.max(t.a, Math.min(t.b - 0.08, v)) : null;
  });
  const len = (k) => norm(toks[k].word).length + 1;
  for (let k = 0; k < toks.length; k++) {
    if (st[k] !== null) continue;
    let e = k; while (e < toks.length && st[e] === null && toks[e].a === toks[k].a) e++; // run of unknowns in this range
    const { a, b } = toks[k];
    const from = k > 0 && toks[k - 1].a === a && st[k - 1] !== null ? st[k - 1] + len(k - 1) * 0.06 : a;
    const to = e < toks.length && toks[e].a === a && st[e] !== null ? st[e] : b;
    const total = Array.from({ length: e - k }, (_, q) => len(k + q)).reduce((x, y) => x + y, 0) || 1;
    let t = Math.min(from, to); const span = Math.max(0, to - t);
    for (let q = k; q < e; q++) { st[q] = t; t += (span * len(q)) / total; }
    k = e - 1;
  }
  // keep order, minimum 60 ms per word; a word ends where the next starts (inside its range) or with its range
  const out = [];
  toks.forEach((t, k) => {
    const prev = out[out.length - 1];
    const s0 = Math.max(st[k], prev ? prev.start + 0.06 : 0);
    out.push({ word: t.word, start: s0, end: 0, b: t.b, a: t.a });
  });
  out.forEach((w, k) => {
    const nx = out[k + 1];
    const cap = w.start + Math.max(0.25, len(k) * 0.09 + 0.2);
    w.end = Math.max(w.start + 0.1, Math.min(nx && nx.a === w.a ? nx.start : w.b + 0.1, cap));
  });
  log(`Subtitr: ${good ? `ovoz bilan ${Math.round((matched / n) * 100)}% harf mos tushdi` : 'tekislash past, oraliq bo\'yicha taqsimlandi'}`);
  return out.map((w) => ({ word: w.word, start: +w.start.toFixed(2), end: +w.end.toFixed(2) }));
}

// Gemini transcribes (or translates) the clip into short timed phrases; phrase starts snap to Whisper's word starts
async function geminiSubtitles(wav, words, to, context, dur) {
  const ai = require('./ai');
  if (!ai.providers().includes('gemini') || !fs.existsSync(wav)) return null;
  const target = to === 'uz' ? 'Uzbek in LATIN script (o\' g\' sh ch; never Cyrillic, never Turkish spelling)' : (LANG_NAMES[to] || to);
  const r = await ai.generateJSON({
    schema: { type: 'object', additionalProperties: false, required: ['phrases'], properties: { phrases: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['start', 'end', 'text'],
      properties: { start: { type: 'number' }, end: { type: 'number' }, text: { type: 'string' } } } } } },
    maxTokens: 8000, quality: 'high',
    parts: [{ text: 'Audio of a gaming video clip:' }, { audio: wav }, { text:
      `Write subtitles for ALL the speech in this ${dur.toFixed(0)}-second audio (do not skip anything, including short shouts and laughs with words).` +
      ` Video: "${context.title || ''}"${context.subject ? ` (${context.subject})` : ''}.\n` +
      `Output language: ${target}. If the speaker uses another language, translate naturally; keep slang, tone and emotion.\n` +
      `Split into short subtitle phrases (max 5 words, max ~2.5 s each). start/end = seconds from the start of THIS audio, with decimals, as precise as you can.\n` +
      `No speaker names, no sound descriptions, no quotes.` }],
  });
  let ph = (r?.data?.phrases || []).filter((p) => p && p.text && String(p.text).trim() && p.end > p.start && p.start < dur + 1)
    .map((p) => ({ start: Math.max(0, +p.start), end: Math.min(dur, +p.end), text: String(p.text).replace(/\s+/g, ' ').trim() }))
    .sort((a, b) => a.start - b.start);
  if (!ph.length) return null;
  // snap each phrase start to the nearest real word start (±0.8 s), never before the previous phrase
  const starts = words.map((w) => w.start);
  let prevEnd = 0;
  ph = ph.map((p, i) => {
    let st = p.start;
    const near = starts.filter((t) => Math.abs(t - st) <= 0.8).sort((a, b) => Math.abs(a - st) - Math.abs(b - st))[0];
    if (near !== undefined) st = near;
    st = Math.max(st, prevEnd);
    const next = ph[i + 1] ? ph[i + 1].start : dur;
    const en = Math.max(st + 0.4, Math.min(p.end + (near !== undefined ? near - p.start : 0), next, dur));
    prevEnd = en;
    return { ...p, start: st, end: en };
  });
  // phrase -> words, time shared by word length
  // phrase -> words, each timed from the audio by letter alignment with Whisper
  const out = alignTokens(ph.flatMap((p) => p.text.split(' ').filter(Boolean).map((w) => ({ word: w, a: p.start, b: p.end }))), words);
  log(`Subtitr: Gemini ${ph.length} ta ibora yozdi`);
  return out;
}

const LANG_NAMES = { en: 'English', ru: 'Russian', uz: 'Uzbek', tr: 'Turkish', kk: 'Kazakh', ky: 'Kyrgyz', tg: 'Tajik', de: 'German', es: 'Spanish' };
async function translateWords(words, from, to, context, audio = null) {
  const ai = require('./ai');
  if (!ai.enabled()) return null;
  const groups = phrases(words, { maxWords: 6, maxChars: 34, gap: 0.7 });
  const lines = groups.map((g) => g.map((w) => w.word).join(' '));
  const same = from === to;
  const target = to === 'uz' ? 'Uzbek in LATIN script (oʻ/gʻ written as o\' and g\', sh, ch; never Cyrillic)' : (LANG_NAMES[to] || to);
  const parts = [];
  if (audio && fs.existsSync(audio)) parts.push({ text: 'The audio of the clip (listen to it):' }, { audio });
  parts.push({ text:
    `Subtitle lines from automatic speech recognition of ${LANG_NAMES[from] || from} speech in the video "${context.title || ''}"${context.subject ? ` (${context.subject})` : ''}.\n` +
    `Recognition is often wrong (especially for Uzbek and gaming slang). ${audio ? 'Listen to the audio and' : 'Using the context,'} ` +
    (same ? `write what is ACTUALLY said in each line, in ${target}.` : `translate what is ACTUALLY said in each line into short, natural spoken ${target}.`) + `\n` +
    `Keep the tone, slang and emotion. Keep each line short (it is on screen ~1-2 s). No quotes, no notes, no speaker names.\n` +
    `Return exactly ${lines.length} lines in "lines", same order, one per input line (if a line is just noise, return an empty string).\n\n` +
    lines.map((l, i) => `${i + 1}. [${groups[i][0].start.toFixed(1)}-${groups[i][groups[i].length - 1].end.toFixed(1)}s] ${l}`).join('\n') });
  const r = await ai.generateJSON({
    schema: { type: 'object', additionalProperties: false, required: ['lines'],
      properties: { lines: { type: 'array', items: { type: 'string' } } } },
    maxTokens: 4000, parts,
  });
  const out = r?.data?.lines;
  if (!Array.isArray(out) || out.length !== lines.length) { log('AI subtitr javobi mos kelmadi, Whisper matni ishlatiladi', 'warn'); return null; }
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
  let j;
  try { const { out } = await run(PY, [FACECAM, src], { timeoutMs: 10 * 60000 }); j = JSON.parse(out); }
  catch (e) { log('Webkamera aniqlanmadi: ' + e.message.slice(0, 200), 'warn'); return null; }
  if (!j.found) return null;
  try { await visionBox(src, j); } catch (e) { log('Webkamera: AI ramka tekshiruvi ishlamadi: ' + e.message.slice(0, 160), 'warn'); }
  return j;
}

// the AI looks at frames and marks the webcam rectangle (it "sees" where the camera picture ends and gameplay begins,
// which pixel statistics miss on some stream layouts); the pixel-found border is kept where it agrees (±2.5%)
async function visionBox(src, j) {
  const ai = require('./ai');
  if (!ai.providers().includes('gemini') || !j.times?.length) return;
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-'));
  try {
    const ts = [j.times[Math.floor(j.times.length * 0.25)], j.times[Math.floor(j.times.length * 0.75)]].filter((t, i, a) => a.indexOf(t) === i);
    const imgs = [];
    for (const [i, t] of ts.entries()) {
      const f = path.join(dir, `f${i}.jpg`);
      await run(FFMPEG, ['-y', '-v', 'error', '-ss', String(t), '-i', src, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '3', f]);
      if (fs.existsSync(f)) imgs.push(f);
    }
    if (!imgs.length) return;
    const r = await ai.generateJSON({
      schema: { type: 'object', additionalProperties: false, required: ['ymin', 'xmin', 'ymax', 'xmax'],
        properties: { ymin: { type: 'number' }, xmin: { type: 'number' }, ymax: { type: 'number' }, xmax: { type: 'number' } } },
      parts: [...imgs.map((f) => ({ image: f })), { text:
        `Frames from a gameplay live stream (${j.width}x${j.height}). The streamer's real-life webcam is overlaid on the game as a rectangle ` +
        `(the person sits at about x=${Math.round((j.face[0] + j.face[2] / 2) / j.width * 1000)}, y=${Math.round((j.face[1] + j.face[3] / 2) / j.height * 1000)} on a 0-1000 scale).\n` +
        `Give the bounding box of the webcam CAMERA PICTURE only: where the real room ends. Exclude any coloured frame/border line around it ` +
        `and exclude ALL game graphics next to it. Edges must be exact. Coordinates on a 0-1000 scale of the frame (ymin, xmin, ymax, xmax).` }],
    });
    const b = r?.data; if (!b) return;
    const X0 = b.xmin / 1000 * j.width, X1 = b.xmax / 1000 * j.width, Y0 = b.ymin / 1000 * j.height, Y1 = b.ymax / 1000 * j.height;
    const [fx, fy, fw, fh] = j.face, cx = fx + fw / 2, cy = fy + fh / 2;
    if (!(X1 - X0 > fw * 1.3 && Y1 - Y0 > fh * 1.3 && X0 < cx && cx < X1 && Y0 < cy && cy < Y1 && (X1 - X0) * (Y1 - Y0) < 0.8 * j.width * j.height)) {
      log(`Webkamera: AI ramkasi yuzga mos emas, e'tiborsiz (${Math.round(X0)},${Math.round(Y0)}-${Math.round(X1)},${Math.round(Y1)})`, 'warn'); return;
    }
    // pixel border lines agree with the AI -> exact pixel edge; otherwise the AI edge, 0.6% inside (never shows the border)
    const [L, R, T, B] = j.lines || [];
    const tolX = 0.025 * j.width, tolY = 0.025 * j.height, inX = 0.006 * j.width, inY = 0.006 * j.height;
    const x0 = L != null && Math.abs(L - X0) < tolX ? L + 4 : Math.max(0, X0 + (X0 < tolX ? 0 : inX));
    const x1 = R != null && Math.abs(R - X1) < tolX ? R - 4 : Math.min(j.width, X1 - (j.width - X1 < tolX ? 0 : inX));
    const y0 = T != null && Math.abs(T - Y0) < tolY ? T + 4 : Math.max(0, Y0 + (Y0 < tolY ? 0 : inY));
    const y1 = B != null && Math.abs(B - Y1) < tolY ? B - 4 : Math.min(j.height, Y1 - (j.height - Y1 < tolY ? 0 : inY));
    const before = `${j.x},${j.y} ${j.w}x${j.h}`;
    j.x = Math.max(0, Math.round(x0)); j.y = Math.max(0, Math.round(y0));
    j.w = Math.min(j.width - j.x, Math.round(x1 - x0)); j.h = Math.min(j.height - j.y, Math.round(y1 - y0));
    j.ai = true;
    log(`Webkamera: AI ramkasi ${j.x},${j.y} ${j.w}x${j.h} (piksel usuli: ${before})`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

module.exports = { alignTokens, mergeForced, geminiByRanges, geminiSubtitles, translateWords, detectFacecam, SAFE, transcribe, buildAss, phrases, fontFamily };

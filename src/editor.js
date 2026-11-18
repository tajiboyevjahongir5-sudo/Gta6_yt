// AI editor: instead of fixed rules (cut N seconds before / after the loudest second), the AI WATCHES and LISTENS
// to the stretch around a key moment (up to ~3 minutes, a light 360p copy) and decides the edit itself, like a
// human editor: which pieces tell the story (setup -> key moment -> reaction), what dead time to cut, where the
// most gripping 1-2 s for the cold open are, the meme text and the title. It follows:
//  - the style learned from the most-viewed Shorts of the niche / a channel (src/style.js)
//  - the owner's own editing rules (Settings -> "Montaj qoidalari")
//  - why the owner rejected earlier Shorts (feedback buttons) — so the same mistakes are not made again
// The renderer then cuts exactly these pieces. If anything is off, the rule-based edit is used instead.
const fs = require('fs');
const path = require('path');
const { db, getSettings, log } = require('./db');
const { run } = require('./util');
const { FFMPEG } = require('./config');
const ai = require('./ai');

db.exec('CREATE TABLE IF NOT EXISTS clip_feedback (clip_id INTEGER, reason TEXT, note TEXT, at INTEGER)');

// why a Short was rejected (bot buttons / Web App) -> what the editor should do differently
const REASONS = {
  boring: { uz: 'Zerikarli, qiziq joy yo\'q', rule: 'Pick only moments with a real payoff (a fail, a scare, a joke landing, a strong reaction). Skip ordinary gameplay.' },
  unclear: { uz: 'Voqea tushunarsiz', rule: 'Always include the setup: the viewer must understand what is going on before the key moment.' },
  short: { uz: 'Juda qisqa', rule: 'Make Shorts longer: give the story room (40-58 s), do not cut the build-up away.' },
  long: { uz: 'Juda cho\'zilgan', rule: 'Make Shorts tighter: cut every second of waiting, walking and silence.' },
  ending: { uz: 'Oxiri chala / reaksiya yo\'q', rule: 'Never end before the payoff: keep the reaction and what happens right after the key moment.' },
  cut: { uz: 'Gap o\'rtasida kesilgan', rule: 'Cut only between sentences, never in the middle of a word or a sentence.' },
  camera: { uz: 'Webkamera noto\'g\'ri', rule: '' },
  subs: { uz: 'Subtitr xato', rule: '' },
};
function addFeedback(clipId, reason, note = '') {
  db.prepare('INSERT INTO clip_feedback (clip_id, reason, note, at) VALUES (?, ?, ?, ?)').run(clipId, reason, String(note || '').slice(0, 300), Date.now());
}
// the owner's recent verdicts as rules for the AI (most frequent first)
function feedbackRules() {
  const rows = db.prepare('SELECT reason, COUNT(*) n FROM clip_feedback WHERE at > ? GROUP BY reason ORDER BY n DESC').all(Date.now() - 60 * 86400000);
  const notes = db.prepare("SELECT note FROM clip_feedback WHERE note != '' AND at > ? ORDER BY at DESC LIMIT 5").all(Date.now() - 60 * 86400000).map((r) => r.note);
  return [...rows.filter((r) => REASONS[r.reason]?.rule).map((r) => `${REASONS[r.reason].rule} (the owner rejected ${r.n} Short${r.n > 1 ? 's' : ''} for this)`),
    ...notes.map((n) => `Owner's comment on a rejected Short: "${n}"`)];
}

const PLAN = { type: 'object', additionalProperties: false, required: ['ok', 'story', 'parts', 'keyAt', 'hookAt', 'meme', 'title'],
  properties: {
    ok: { type: 'boolean', description: 'false if this stretch has no moment worth a Short' },
    story: { type: 'string', description: 'Uzbek, 1-2 sentences: what the Short shows, setup -> key moment -> payoff' },
    parts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['start', 'end', 'why'],
      properties: { start: { type: 'number' }, end: { type: 'number' }, why: { type: 'string' } } } },
    keyAt: { type: 'number', description: 'second in THIS clip of the key moment (the climax)' },
    hookAt: { type: 'number', description: 'second in THIS clip where the most gripping 1-2 s start (shown first as the cold open)' },
    meme: { type: 'string', description: 'short funny caption for the key moment in the channel language, max 6 words, or empty' },
    title: { type: 'string', description: 'Shorts title in the channel language, max 60 characters, true to the content, no clickbait it does not deliver' },
  } };

const LANG = { uz: 'Uzbek (Latin script)', ru: 'Russian', en: 'English' };

// light copy of the stretch for the AI (small enough to send inline: 360p, 10 fps, mono)
async function preview(src, from, len, dir) {
  const f = path.join(dir, `edit_${Math.round(from)}.mp4`);
  await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', from.toFixed(2), '-t', len.toFixed(2), '-i', src,
    '-vf', 'scale=-2:360,fps=10', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '33', '-maxrate', '350k', '-bufsize', '700k',
    '-c:a', 'aac', '-b:a', '48k', '-ac', '1', '-movflags', '+faststart', f], { timeoutMs: 10 * 60000 });
  return f;
}

// returns { parts: [{start,end}] (source seconds), peak, hook, meme, title, story } or null
async function planShort({ src, dir, peak, duration, heard, styleRules = [], title = '', subject = '', target = 50 }) {
  const s = getSettings();
  if (!s.aiEditor || !ai.providers().includes('gemini')) return null;
  const from = Math.max(0, Math.min(peak - 150, (heard?.start ?? peak) - 30));
  const to = Math.min(duration, Math.max(peak + 35, (heard?.end ?? peak) + 15));
  const len = to - from; if (len < 20) return null;
  const clip = await preview(src, from, len, dir);
  try {
    if (fs.statSync(clip).size > 18 * 1048576) { log('AI montajchi: parcha juda katta, oddiy montaj ishlatiladi', 'warn'); return null; }
    const own = String(s.editorRules || '').split('\n').map((x) => x.trim()).filter(Boolean);
    const fb = feedbackRules();
    const r = await ai.generateJSON({ schema: PLAN, quality: 'high', parts: [
      { text: `A ${Math.round(len)}-second stretch of a gameplay stream / video${title ? ` "${title}"` : ''}${subject ? ` (${subject})` : ''}. ` +
        `The detectors think the key moment is around ${(peak - from).toFixed(1)} s in this clip${heard?.why ? ` (heard: ${heard.why}${heard.quote ? `, "${heard.quote}"` : ''})` : ''}.` },
      { video: clip },
      { text:
        `You are a professional Shorts editor. Watch and listen to the whole clip, then edit ONE vertical Short from it that people watch to the end.\n` +
        `Story first: the viewer must understand what is going on (setup), see the key moment, and get the payoff (reaction, what happens right after). ` +
        `Cut dead time (waiting, walking, menus, silence) with jump cuts; keep whole sentences.\n` +
        `Rules for "parts": seconds of THIS clip, in time order, not overlapping, each at least 2 s, starting and ending between sentences; ` +
        `total ${Math.max(30, target - 10)}-${Math.min(58, target + 5)} s; the key moment and the reaction after it must be inside a part; ` +
        `the last part ends on the payoff, not before it. "why" = one short reason per part. ` +
        `If the detectors are wrong and the real key moment is elsewhere in the clip, use the real one. If nothing here is worth a Short, ok=false.\n` +
        (styleRules.length ? `\nHow the most-viewed Shorts of this niche are edited (follow this style):\n- ${styleRules.slice(0, 12).join('\n- ')}\n` : '') +
        (own.length ? `\nThe channel owner's editing rules (always follow):\n- ${own.join('\n- ')}\n` : '') +
        (fb.length ? `\nLearn from the owner's verdicts on earlier Shorts:\n- ${fb.join('\n- ')}\n` : '') +
        `\nWrite "story", "meme" and "title" in ${LANG[s.language] || s.language}.` }] });
    const p = r?.data;
    if (!p) return null;
    if (!p.ok) { log('AI montajchi: bu parchada Shorts uchun lahza yo\'q deb hisobladi'); return null; }
    // validate and clean the pieces
    let parts = (p.parts || []).map((x) => ({ start: Math.max(0, +x.start), end: Math.min(len, +x.end), why: x.why }))
      .filter((x) => x.end - x.start >= 1.5).sort((a, b) => a.start - b.start);
    parts = parts.reduce((acc, x) => { const last = acc[acc.length - 1]; if (last && x.start <= last.end + 0.3) { last.end = Math.max(last.end, x.end); } else acc.push({ ...x }); return acc; }, []);
    const total = parts.reduce((t, x) => t + x.end - x.start, 0);
    const key = +p.keyAt;
    const inside = (t) => parts.some((x) => t >= x.start - 0.2 && t <= x.end + 0.2);
    if (!parts.length || total < 22 || total > 70 || !(key >= 0 && key <= len) || !inside(key)) {
      log(`AI montajchi rejasi yaroqsiz (${parts.length} bo'lak, ${Math.round(total)} s) — oddiy montaj ishlatiladi`, 'warn');
      return null;
    }
    const hook = +p.hookAt >= 0 && inside(+p.hookAt) ? +p.hookAt : key;
    log(`AI montajchi: ${parts.length} bo'lak, ${Math.round(total)} s — ${String(p.story).slice(0, 140)}`);
    return { parts: parts.map((x) => ({ start: +(from + x.start).toFixed(2), end: +(from + x.end).toFixed(2), why: x.why })),
      peak: from + key, hook: from + hook, meme: String(p.meme || '').trim(), title: String(p.title || '').trim(), story: p.story };
  } finally { fs.rmSync(clip, { force: true }); }
}

module.exports = { planShort, addFeedback, feedbackRules, REASONS };

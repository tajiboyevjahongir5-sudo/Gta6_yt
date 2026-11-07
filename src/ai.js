// Claude looks at frames from each candidate moment, re-ranks them and writes the YouTube metadata.
// Without ANTHROPIC_API_KEY everything falls back to templates, so the pipeline still works.
const fs = require('fs');
const { ANTHROPIC_API_KEY, AI_MODEL } = require('./config');
const { log } = require('./db');

let client = null;
function getClient() {
  if (!ANTHROPIC_API_KEY) return null;
  if (!client) { const Anthropic = require('@anthropic-ai/sdk'); client = new Anthropic({ apiKey: ANTHROPIC_API_KEY }); }
  return client;
}

const LANG = { uz: "o'zbek (lotin)", ru: 'rus', en: 'ingliz' };
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['moments', 'long'],
  properties: {
    moments: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['index', 'score', 'caption', 'short_title'],
      properties: {
        index: { type: 'integer' },
        score: { type: 'integer', description: '0-10, qanchalik qiziq/kulgili/epik' },
        caption: { type: 'string', description: 'kompilyatsiyada ko\'rinadigan 2-5 so\'zli izoh' },
        short_title: { type: 'string', description: 'Shorts uchun nom, 70 belgigacha, #shorts siz' },
      } } },
    long: { type: 'object', additionalProperties: false, required: ['title', 'description', 'tags', 'thumb_text'],
      properties: {
        title: { type: 'string', description: '100 belgigacha, clickbait emas, lekin qiziqtiradigan' },
        description: { type: 'string', description: '3-6 qator: nima bo\'lishi, taym-kodlar alohida qo\'shiladi' },
        tags: { type: 'array', items: { type: 'string' } },
        thumb_text: { type: 'string', description: 'prevyudagi 2-4 so\'zli katta yozuv' },
      } },
  },
};

// candidates: [{start,end,peak,frames:[jpgPath,...]}]
async function rankAndDescribe({ candidates, source, settings }) {
  const c = getClient();
  if (!c || !settings.useAI) return null;
  const content = [];
  candidates.forEach((cand, i) => {
    content.push({ type: 'text', text: `Lahza #${i} (stream vaqti ${Math.round(cand.start)}–${Math.round(cand.end)} s, ovoz/harakat balli ${cand.score}):` });
    for (const f of cand.frames) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(f).toString('base64') } });
  });
  content.push({ type: 'text', text:
    `Bu "${source.title || 'stream'}" (${source.author || 'nomaʼlum muallif'}) uzun ${settings.game} streamidan avtomatik topilgan lahzalar.\n` +
    `Vazifa: 1) har bir lahzani 0-10 baholang (tomoshabin uchun qanchalik qiziq: kulgili, epik, kutilmagan, xaotik; ` +
    `menyu, yuklanish ekrani, AFK, qora ekran, kamera/chat ko'rinmasa past ball). ` +
    `2) Har biriga qisqa izoh va Shorts nomi yozing. 3) Kompilyatsiya video uchun YouTube nomi, tavsifi, 12-20 teg va prevyu yozuvini yozing.\n` +
    `Til: ${LANG[settings.language] || settings.language}. Teglarga ${settings.game} bilan bog'liq ingliz tilidagi mashhur qidiruv so'zlarini ham qo'shing. ` +
    `Kanal nomi: ${settings.channelName}. Original stream egasini kamsitmang, yolg'on va'da bermang.` });

  try {
    const res = await c.beta.messages.create({
      model: AI_MODEL,
      max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content }],
    });
    if (res.stop_reason === 'refusal') { log('AI so\'rovni rad etdi, shablon ishlatiladi', 'warn'); return null; }
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return JSON.parse(text);
  } catch (e) {
    log('AI xatosi: ' + (e.status ? e.status + ' ' : '') + e.message, 'warn');
    return null;
  }
}

// template metadata when AI is off
function templateMeta({ source, settings, count }) {
  const g = settings.game, who = source.author ? ` | ${source.author}` : '';
  const T = {
    uz: { title: `${g} — eng zo'r ${count} lahza${who}`, desc: `${g} streamidagi eng kulgili va epik lahzalar bir videoda!`, thumb: 'BUNI KO\'RING!', short: (i) => `${g}: kutilmagan lahza #${i + 1}` },
    ru: { title: `${g} — ${count} лучших моментов${who}`, desc: `Самые смешные и эпичные моменты стрима ${g} в одном видео!`, thumb: 'ЭТО ЖЕСТЬ!', short: (i) => `${g}: неожиданный момент #${i + 1}` },
    en: { title: `${g} — top ${count} moments${who}`, desc: `The funniest and most epic ${g} stream moments in one video!`, thumb: 'NO WAY!', short: (i) => `${g}: unexpected moment #${i + 1}` },
  }[settings.language] || null;
  const t = T || { title: `${g} highlights`, desc: '', thumb: g, short: (i) => `${g} #${i + 1}` };
  return { long: { title: t.title, description: t.desc, tags: [], thumb_text: t.thumb }, shortTitle: t.short };
}

module.exports = { rankAndDescribe, templateMeta, enabled: () => !!ANTHROPIC_API_KEY };

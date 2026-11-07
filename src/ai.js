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

const LANG = { uz: 'Uzbek (Latin script)', ru: 'Russian', en: 'English' };
// emojis we can animate (rendered from Noto Color Emoji)
const EMOJIS = ['😂', '💀', '🔥', '😱', '🚓', '💥', '💰', '🏎️', '🔫', '😍', '🤯', '😭', '👀', '🏃', '🤣', '😳'];
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['moments', 'long'],
  properties: {
    moments: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['index', 'score', 'caption', 'short_title', 'emoji'],
      properties: {
        index: { type: 'integer' },
        score: { type: 'integer', description: '0-10: how funny / epic / unexpected it is for a viewer' },
        caption: { type: 'string', description: '2-5 word caption shown in the compilation' },
        short_title: { type: 'string', description: 'Shorts title, max 70 chars, without #shorts' },
        emoji: { type: 'string', enum: EMOJIS, description: 'reaction emoji that pops up on the key moment' },
      } } },
    long: { type: 'object', additionalProperties: false, required: ['title', 'description', 'tags', 'thumb_text'],
      properties: {
        title: { type: 'string', description: 'max 100 chars, intriguing but not misleading' },
        description: { type: 'string', description: '3-6 lines about what happens; chapters are added separately' },
        tags: { type: 'array', items: { type: 'string' } },
        thumb_text: { type: 'string', description: '2-4 word big text for the thumbnail' },
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
    `These moments were found automatically in a long ${settings.game} stream "${source.title || 'stream'}" by ${source.author || 'unknown'}.\n` +
    `1) Score each moment 0-10 for a viewer (funny, epic, unexpected, chaotic score high; menus, loading screens, AFK, black screens score low). ` +
    `2) Give each a short caption, a Shorts title and one reaction emoji. ` +
    `3) Write the YouTube title, description, 12-20 tags and thumbnail text for the compilation video.\n` +
    `Write everything in ${LANG[settings.language] || settings.language}. Tags should include popular ${settings.game} search terms. ` +
    `Channel name: ${settings.channelName}. Do not mock the original streamer and do not promise things the video doesn't show.` });

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

module.exports = { rankAndDescribe, templateMeta, EMOJIS, getClient, LANG, enabled: () => !!ANTHROPIC_API_KEY };

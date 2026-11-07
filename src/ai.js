// The AI studies the whole source video — its YouTube title/description/tags, the speech transcript, frames spread over
// the full length and frames from each candidate moment — works out what the video actually is (which game, sport,
// vlog, podcast…), re-ranks the moments and writes metadata that matches THIS video.
// Providers: Google Gemini (free tier; can watch a public YouTube video directly) and Anthropic Claude.
// Without any key everything falls back to the source video's own metadata, so the pipeline still works.
const fs = require('fs');
const { ANTHROPIC_API_KEY, AI_MODEL, GEMINI_API_KEY, GEMINI_MODEL } = require('./config');
const { log, getSecret, getSettings } = require('./db');

// ---------- providers ----------
// Generic message parts: { text } | { image: '/path.jpg' }. Each provider converts them to its own format.
let client = null;
function getClient() {
  if (!ANTHROPIC_API_KEY) return null;
  if (!client) { const Anthropic = require('@anthropic-ai/sdk'); client = new Anthropic({ apiKey: ANTHROPIC_API_KEY }); }
  return client;
}
const geminiKey = () => getSecret('gemini_key') || GEMINI_API_KEY || '';
const b64 = (f) => fs.readFileSync(f).toString('base64');

async function callClaude({ parts, schema, effort = 'medium', maxTokens = 10000 }) {
  const c = getClient(); if (!c) throw new Error('Claude kaliti yo\'q');
  const res = await c.beta.messages.create({
    model: AI_MODEL, max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    output_config: { effort, format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: parts.filter((p) => !p.audio).map((p) => (p.image
      ? { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64(p.image) } } : { type: 'text', text: p.text })) }],
  });
  if (res.stop_reason === 'refusal') throw new Error('Claude so\'rovni rad etdi');
  return JSON.parse(res.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
}

// Gemini's structured output takes an OpenAPI-style schema: upper-case types, no additionalProperties
function toGeminiSchema(js) {
  if (Array.isArray(js)) return js.map(toGeminiSchema);
  if (!js || typeof js !== 'object') return js;
  const out = {};
  for (const [k, v] of Object.entries(js)) {
    if (k === 'additionalProperties') continue;
    if (k === 'type') out.type = String(v).toUpperCase();
    else if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    else if (k === 'items') out.items = toGeminiSchema(v);
    else out[k] = v;
  }
  return out;
}
// model ids change over time: try the configured one, then the "latest" alias, then known stable ones
const GEMINI_MODELS = () => [...new Set([GEMINI_MODEL, 'gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-2.0-flash'].filter(Boolean))];
let geminiWorking = null;
// youtube: { url, fps } — Gemini watches a public YouTube video itself (picture + sound), no download needed
async function callGemini({ parts, schema, youtube }) {
  const key = geminiKey(); if (!key) throw new Error('Gemini kaliti yo\'q');
  const gparts = parts.map((p) => (p.image ? { inlineData: { mimeType: 'image/jpeg', data: b64(p.image) } }
    : p.audio ? { inlineData: { mimeType: 'audio/wav', data: b64(p.audio) } } : { text: p.text }));
  const build = (withVideo) => ({
    contents: [{ role: 'user', parts: withVideo && youtube
      ? [{ fileData: { fileUri: youtube.url }, videoMetadata: { fps: youtube.fps || 0.5 } }, ...gparts] : gparts }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: toGeminiSchema(schema),
      ...(withVideo && youtube ? { mediaResolution: 'MEDIA_RESOLUTION_LOW' } : {}) },
  });
  let lastErr;
  const busy = (st) => st === 503 || st === 500 || st === 502 || st === 504;
  for (const withVideo of youtube ? [true, false] : [false]) {
    // a busy/unknown model -> the next one; when the "working" model is busy, the others get a chance too
    const models = geminiWorking ? [geminiWorking, ...GEMINI_MODELS().filter((m) => m !== geminiWorking)] : GEMINI_MODELS();
    let videoRefused = false;
    for (const model of models) {
      // Google's "high demand" 503s and dropped connections are short-lived: wait and retry (2 s, 5 s, 10 s)
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) await new Promise((res) => setTimeout(res, [0, 2000, 5000, 10000][attempt]));
        let r, j;
        try {
          r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(build(withVideo)) });
          j = await r.json().catch(() => ({}));
        } catch (e) { lastErr = new Error('Gemini bilan aloqa uzildi: ' + e.message); continue; }
        if (r.ok) {
          geminiWorking = model;
          const text = (j.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('');
          if (!text) { lastErr = new Error('Gemini bo\'sh javob qaytardi (' + (j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || '?') + ')'); break; }
          if (withVideo) log(`Gemini videoni to'liq ko'rdi (${model})`);
          return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
        }
        lastErr = new Error(`Gemini ${r.status}: ${j.error?.message || ''}`.slice(0, 300));
        if (r.status === 429) { lastErr.quota = true; throw lastErr; } // free daily/minute limit reached
        if (busy(r.status)) continue;                                   // retry the same model after a pause
        if (r.status !== 404) videoRefused = true;                      // e.g. video not public/too long
        break;                                                          // 404 (unknown model) or refused: next model / no video
      }
      if (videoRefused) break;
    }
  }
  throw lastErr;
}

// order: the owner's choice in settings; "auto" = Gemini first (free), then Claude
function providers() {
  const pref = getSettings().aiProvider || 'auto';
  const have = { gemini: !!geminiKey(), claude: !!ANTHROPIC_API_KEY };
  const order = pref === 'claude' ? ['claude', 'gemini'] : ['gemini', 'claude'];
  return order.filter((p) => have[p]);
}
const enabled = () => providers().length > 0;
async function generateJSON({ parts, schema, youtube, effort, maxTokens }) {
  for (const p of providers()) {
    try { return { data: p === 'gemini' ? await callGemini({ parts, schema, youtube }) : await callClaude({ parts, schema, effort, maxTokens }), provider: p }; }
    catch (e) { log(`AI (${p}) xatosi: ${e.message}${e.quota ? ' — bepul limit tugadi, keyingi variantga o\'tilmoqda' : ''}`, 'warn'); }
  }
  return null;
}

const LANG = { uz: 'Uzbek (Latin script)', ru: 'Russian', en: 'English' };
// emojis we can animate (rendered from Noto Color Emoji)
const EMOJIS = ['😂', '🤣', '💀', '🔥', '😱', '🤯', '😳', '😭', '😍', '👀', '💥', '💰', '🏎️', '🔫', '🚓', '🏃', '👏', '🎉', '🙌', '💪',
  '⚽', '🏀', '🎮', '🍔', '🐶', '❤️', '😡', '🥶', '🤔', '🙏'];
// YouTube category ids
const CATEGORIES = { gaming: '20', entertainment: '24', comedy: '23', sports: '17', people_blogs: '22', music: '10', education: '27',
  science_tech: '28', howto_style: '26', news_politics: '25', autos: '2', pets_animals: '15', travel: '19', film: '1' };

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['video', 'moments', 'long'],
  properties: {
    video: { type: 'object', additionalProperties: false, required: ['subject', 'category', 'summary', 'hashtags', 'badge'],
      properties: {
        subject: { type: 'string', description: 'what the video is: the exact game title, sport + teams, show name, or topic (e.g. "Minecraft", "Real Madrid vs Barcelona", "street food vlog")' },
        category: { type: 'string', enum: Object.keys(CATEGORIES) },
        summary: { type: 'string', description: '1-2 sentences: what happens in the source video' },
        hashtags: { type: 'array', items: { type: 'string' }, description: '3-5 hashtags without #, specific to this video' },
        badge: { type: 'string', description: 'max 12 chars label for the thumbnail corner (e.g. game name), or empty' },
      } },
    moments: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['index', 'score', 'caption', 'short_title', 'emoji', 'meme'],
      properties: {
        index: { type: 'integer' },
        score: { type: 'integer', description: '0-10: how interesting this moment is for a viewer of this kind of video' },
        caption: { type: 'string', description: '2-5 word caption of what happens in this moment' },
        short_title: { type: 'string', description: 'Shorts title for this moment: max 50 chars, punchy, makes people want to see what happens; no #shorts, no emojis spam' },
        emoji: { type: 'string', enum: EMOJIS, description: 'reaction emoji that pops up on the key moment' },
        meme: { type: 'string', description: 'meme-style punchline shown big on screen at the climax (2-6 words, like a human editor would write; funny, fits what happens; empty if nothing fits)' },
      } } },
    long: { type: 'object', additionalProperties: false, required: ['title', 'description', 'tags', 'thumb_text'],
      properties: {
        title: { type: 'string', description: 'max 100 chars, specific to this video, intriguing but not misleading' },
        description: { type: 'string', description: '3-6 lines about what happens; chapters are added separately' },
        tags: { type: 'array', items: { type: 'string' }, description: '12-20 search tags specific to this video' },
        thumb_text: { type: 'string', description: '2-4 word big text for the thumbnail' },
      } },
  },
};
// context: { meta: {title, description, tags, categories, channel, chapters, duration}, transcript, overview: [jpg], youtube: {url, fps} }
async function rankAndDescribe({ candidates, source, settings, context = {} }) {
  if (!enabled() || !settings.useAI) return null;
  const m = context.meta || {};
  const parts = [{ text:
    `SOURCE VIDEO\nTitle: ${m.title || source.title || '?'}\nChannel: ${m.channel || source.author || '?'}\n` +
    `Duration: ${Math.round((m.duration || 0) / 60)} min\nYouTube category: ${(m.categories || []).join(', ') || '?'}\n` +
    `Tags: ${(m.tags || []).slice(0, 30).join(', ') || '-'}\n` +
    (m.chapters?.length ? `Chapters: ${m.chapters.map((ch) => `${Math.round(ch.start_time)}s ${ch.title}`).join(' | ')}\n` : '') +
    `Description:\n${String(m.description || '').slice(0, 3000)}\n\n` +
    (context.transcript ? `TRANSCRIPT (auto captions, may be imperfect):\n${context.transcript}\n` : 'No transcript available.\n') +
    (context.youtube ? '\nThe full video itself is attached as well — watch and listen to it.\n' : '') }];
  if (context.overview?.length) {
    parts.push({ text: 'Frames spread over the whole video (start → end):' });
    for (const f of context.overview) parts.push({ image: f });
  }
  candidates.forEach((cand, i) => {
    parts.push({ text: `Candidate moment #${i} (${Math.round(cand.start)}–${Math.round(cand.end)} s, loudness/motion score ${cand.score}):` });
    for (const f of cand.frames) parts.push({ image: f });
  });
  parts.push({ text:
    `The candidate moments were found automatically by loudness and motion in the source video above.\n` +
    `1) First work out what this video really is from ALL the evidence (metadata, transcript, frames${context.youtube ? ', the video itself' : ''}): the exact game or topic. ` +
    `Never assume a game that the evidence doesn't show.` +
    (settings.game ? ` The channel owner says the topic is usually "${settings.game}" — use it only if the evidence agrees.` : '') + `\n` +
    `2) Score each moment 0-10 for a viewer of this kind of content (low for menus, loading screens, AFK, black screens, ads, silence).\n` +
    `3) Give each moment a caption, a Shorts title, one reaction emoji and a short meme punchline for its climax.\n` +
    `4) Write the YouTube title, description, tags and thumbnail text for a highlights compilation of this video. ` +
    `Everything must describe what is actually in this video; use real names (game, people, teams) when the evidence shows them.\n` +
    `Write in ${LANG[settings.language] || settings.language}. Channel name: ${settings.channelName}. ` +
    `Do not mock the original creator, do not invent events, do not use clickbait the video doesn't deliver.` });
  const r = await generateJSON({ parts, schema: SCHEMA, youtube: context.youtube });
  if (!r) return null;
  const out = r.data;
  if (!out?.video || !Array.isArray(out.moments) || !out.long) { log(`AI (${r.provider}) javobi to'liq emas, videoning o'z ma'lumotlari ishlatiladi`, 'warn'); return null; }
  out.video.categoryId = CATEGORIES[out.video.category] || '24';
  out.video.badge = String(out.video.badge || '').slice(0, 12);
  for (const mo of out.moments) if (!EMOJIS.includes(mo.emoji)) mo.emoji = '🔥';
  out.provider = r.provider;
  return out;
}

// no AI: build everything from the source video's own YouTube metadata
const YT_CATEGORY_IDS = { Gaming: '20', Entertainment: '24', Comedy: '23', Sports: '17', 'People & Blogs': '22', Music: '10',
  Education: '27', 'Science & Technology': '28', 'Howto & Style': '26', 'News & Politics': '25', 'Autos & Vehicles': '2',
  'Pets & Animals': '15', 'Travel & Events': '19', 'Film & Animation': '1' };
function cleanTitle(t) { return String(t || '').replace(/[|【】[\]#].*$/, '').replace(/\s+/g, ' ').trim().slice(0, 50) || 'Highlights'; }
function templateMeta({ source, settings, count, meta = {} }) {
  const subject = settings.game || cleanTitle(meta.title || source.title);
  const who = source.author ? ` | ${source.author}` : '';
  const T = {
    uz: { title: `${subject} — eng zo'r ${count} lahza${who}`, desc: `"${meta.title || source.title || subject}" videosidagi eng qiziq lahzalar bir joyda!`, thumb: 'BUNI KO\'RING!', short: (i) => `${subject}: lahza #${i + 1}` },
    ru: { title: `${subject} — ${count} лучших моментов${who}`, desc: `Самые интересные моменты из «${meta.title || source.title || subject}» в одном видео!`, thumb: 'ЭТО ЖЕСТЬ!', short: (i) => `${subject}: момент #${i + 1}` },
    en: { title: `${subject} — top ${count} moments${who}`, desc: `The best moments from "${meta.title || source.title || subject}" in one video!`, thumb: 'NO WAY!', short: (i) => `${subject}: moment #${i + 1}` },
  }[settings.language] || { title: `${subject} highlights`, desc: '', thumb: subject, short: (i) => `${subject} #${i + 1}` };
  const tags = [...(meta.tags || []).slice(0, 15), subject, ...(meta.categories || [])];
  const hashtags = (meta.tags || []).slice(0, 3).map((t) => t.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  return { long: { title: t(T.title), description: T.desc, tags, thumb_text: T.thumb }, shortTitle: T.short,
    video: { subject, summary: '', hashtags, badge: settings.game ? settings.game.slice(0, 12) : '', categoryId: YT_CATEGORY_IDS[(meta.categories || [])[0]] || '24' } };
}
const t = (s) => s.slice(0, 100);

module.exports = { rankAndDescribe, templateMeta, generateJSON, providers, geminiKey, EMOJIS, getClient, LANG, enabled };

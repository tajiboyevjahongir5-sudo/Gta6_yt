// The AI studies the whole source video — its YouTube title/description/tags, the speech transcript, frames spread over
// the full length and frames from each candidate moment — works out what the video actually is (which game, sport,
// vlog, podcast…), re-ranks the moments and writes metadata that matches THIS video.
// Without ANTHROPIC_API_KEY everything falls back to the source video's own metadata, so the pipeline still works.
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
      required: ['index', 'score', 'caption', 'short_title', 'emoji'],
      properties: {
        index: { type: 'integer' },
        score: { type: 'integer', description: '0-10: how interesting this moment is for a viewer of this kind of video' },
        caption: { type: 'string', description: '2-5 word caption of what happens in this moment' },
        short_title: { type: 'string', description: 'Shorts title for this moment, max 70 chars, without #shorts' },
        emoji: { type: 'string', enum: EMOJIS, description: 'reaction emoji that pops up on the key moment' },
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
const img = (f) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(f).toString('base64') } });

// context: { meta: {title, description, tags, categories, channel, chapters, duration}, transcript, overview: [jpg] }
async function rankAndDescribe({ candidates, source, settings, context = {} }) {
  const c = getClient();
  if (!c || !settings.useAI) return null;
  const m = context.meta || {};
  const content = [{ type: 'text', text:
    `SOURCE VIDEO\nTitle: ${m.title || source.title || '?'}\nChannel: ${m.channel || source.author || '?'}\n` +
    `Duration: ${Math.round((m.duration || 0) / 60)} min\nYouTube category: ${(m.categories || []).join(', ') || '?'}\n` +
    `Tags: ${(m.tags || []).slice(0, 30).join(', ') || '-'}\n` +
    (m.chapters?.length ? `Chapters: ${m.chapters.map((ch) => `${Math.round(ch.start_time)}s ${ch.title}`).join(' | ')}\n` : '') +
    `Description:\n${String(m.description || '').slice(0, 3000)}\n\n` +
    (context.transcript ? `TRANSCRIPT (auto captions, may be imperfect):\n${context.transcript}\n` : 'No transcript available.\n') }];
  if (context.overview?.length) {
    content.push({ type: 'text', text: `Frames spread over the whole video (start → end):` });
    for (const f of context.overview) content.push(img(f));
  }
  candidates.forEach((cand, i) => {
    content.push({ type: 'text', text: `Candidate moment #${i} (${Math.round(cand.start)}–${Math.round(cand.end)} s, loudness/motion score ${cand.score}):` });
    for (const f of cand.frames) content.push(img(f));
  });
  content.push({ type: 'text', text:
    `The candidate moments were found automatically by loudness and motion in the source video above.\n` +
    `1) First work out what this video really is from ALL the evidence (metadata, transcript, frames): the exact game or topic. ` +
    `Never assume a game that the evidence doesn't show.` +
    (settings.game ? ` The channel owner says the topic is usually "${settings.game}" — use it only if the evidence agrees.` : '') + `\n` +
    `2) Score each moment 0-10 for a viewer of this kind of content (low for menus, loading screens, AFK, black screens, ads, silence).\n` +
    `3) Give each moment a caption, a Shorts title and one reaction emoji.\n` +
    `4) Write the YouTube title, description, tags and thumbnail text for a highlights compilation of this video. ` +
    `Everything must describe what is actually in this video; use real names (game, people, teams) when the evidence shows them.\n` +
    `Write in ${LANG[settings.language] || settings.language}. Channel name: ${settings.channelName}. ` +
    `Do not mock the original creator, do not invent events, do not use clickbait the video doesn't deliver.` });

  try {
    const res = await c.beta.messages.create({
      model: AI_MODEL,
      max_tokens: 10000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content }],
    });
    if (res.stop_reason === 'refusal') { log('AI so\'rovni rad etdi, videoning o\'z ma\'lumotlari ishlatiladi', 'warn'); return null; }
    const out = JSON.parse(res.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
    out.video.categoryId = CATEGORIES[out.video.category] || '24';
    return out;
  } catch (e) {
    log('AI xatosi: ' + (e.status ? e.status + ' ' : '') + e.message, 'warn');
    return null;
  }
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

module.exports = { rankAndDescribe, templateMeta, EMOJIS, getClient, LANG, enabled: () => !!ANTHROPIC_API_KEY };

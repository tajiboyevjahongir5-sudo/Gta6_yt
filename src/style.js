// "Editor skill": for each niche (the game / topic of a video) the bot finds the Shorts that went viral in that niche
// on YouTube lately, the AI WATCHES them and writes down how they are edited (hook, length, pace, captions, zooms,
// effects, which moments they pick, title style). That guide is kept a week per niche and steers the next edits.
const { db, log } = require('./db');
const yt = require('./youtube');
const ai = require('./ai');

db.exec(`CREATE TABLE IF NOT EXISTS style_guides (key TEXT PRIMARY KEY, niche TEXT, data TEXT, at INTEGER)`);
const WEEK = 7 * 86400000;
const keyOf = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 60);

// most-viewed Shorts of the niche from the last 90 days (YouTube Data API search: 100 quota units, once a week per niche)
async function viralShorts(niche, max = 4) {
  const after = new Date(Date.now() - 90 * 86400000).toISOString();
  const q = encodeURIComponent(`${niche} #shorts`);
  const s = await yt.apiGet(`search?part=snippet&type=video&videoDuration=short&order=viewCount&maxResults=15&publishedAfter=${after}&q=${q}`);
  const ids = (s.items || []).map((i) => i.id?.videoId).filter(Boolean);
  if (!ids.length) return [];
  const v = await yt.apiGet('videos?part=snippet,statistics,contentDetails&id=' + ids.join(','));
  const sec = (d) => { const m = String(d || '').match(/PT(?:(\d+)M)?(?:(\d+)S)?/) || []; return (+m[1] || 0) * 60 + (+m[2] || 0); };
  return (v.items || []).map((x) => ({ id: x.id, title: x.snippet.title, channel: x.snippet.channelTitle, views: +(x.statistics.viewCount || 0), duration: sec(x.contentDetails.duration) }))
    .filter((x) => x.duration > 0 && x.duration <= 180).sort((a, b) => b.views - a.views).slice(0, max);
}

const SCHEMA = { type: 'object', additionalProperties: false,
  required: ['summary', 'hook', 'avgLength', 'cutsPerMinute', 'subtitleStyle', 'zoom', 'memeText', 'soundEffects', 'climaxFullscreen', 'momentRules', 'editingRules', 'titleStyle', 'notPossibleYet'],
  properties: {
    summary: { type: 'string', description: 'in Uzbek: 2-3 sentences, how the viral Shorts of this niche are edited' },
    hook: { type: 'string', enum: ['climax_first', 'question_or_text', 'straight_in', 'none'] },
    avgLength: { type: 'number', description: 'typical length in seconds' },
    cutsPerMinute: { type: 'number' },
    subtitleStyle: { type: 'string', enum: ['pop', 'karaoke', 'clean', 'none'], description: 'pop = words appear one by one, karaoke = phrase with the spoken word highlighted, clean = plain phrase' },
    zoom: { type: 'string', enum: ['none', 'light', 'strong'] },
    memeText: { type: 'boolean', description: 'big funny caption at the key moment' },
    soundEffects: { type: 'boolean' },
    climaxFullscreen: { type: 'boolean', description: 'at the key moment the gameplay/main picture takes the whole screen' },
    momentRules: { type: 'array', items: { type: 'string' }, description: 'max 6, English: what kind of moments these Shorts pick' },
    editingRules: { type: 'array', items: { type: 'string' }, description: 'max 6, English: concrete editing rules (pacing, structure, ending)' },
    titleStyle: { type: 'string', description: 'English: how the titles are written (length, words, questions, caps)' },
    notPossibleYet: { type: 'array', items: { type: 'string' }, description: 'in Uzbek: techniques they use that an automatic editor with cuts, zooms, captions and sound effects cannot do' },
  } };

let learning = {};
async function learn(niche) {
  const key = keyOf(niche);
  if (!key || !yt.connected() || !ai.providers().includes('gemini')) return null;
  const row = db.prepare('SELECT * FROM style_guides WHERE key = ?').get(key);
  if (row && Date.now() - row.at < WEEK) return JSON.parse(row.data);
  if (learning[key]) return learning[key];
  learning[key] = (async () => {
    const shorts = await viralShorts(niche);
    if (shorts.length < 2) { log(`Montaj uslubi: "${niche}" bo'yicha mashhur Shorts topilmadi`, 'warn'); return row ? JSON.parse(row.data) : null; }
    const r = await ai.generateJSON({
      schema: SCHEMA, quality: 'high',
      parts: [
        { text: `These are the most-viewed YouTube Shorts of the last 90 days in the niche "${niche}":` },
        ...shorts.flatMap((s, i) => [{ text: `#${i + 1} "${s.title}" — ${s.channel}, ${s.views} views, ${s.duration}s` }, { youtube: `https://www.youtube.com/watch?v=${s.id}` }]),
        { text: `Watch every one of them closely, like a professional short-form editor studying competitors. ` +
          `Work out what they have in common: how the first 1-2 seconds hook the viewer, length, cut pace, layout, captions (style, position), ` +
          `zooms, sound effects, music, meme text, how the key moment is shown, how they end, which kind of moments they choose, and how the titles are written. ` +
          `Describe only what you actually see in these videos.` },
      ],
    });
    const g = r?.data; if (!g) return row ? JSON.parse(row.data) : null;
    g.niche = niche; g.sources = shorts; g.at = Date.now();
    g.momentRules = (g.momentRules || []).slice(0, 6); g.editingRules = (g.editingRules || []).slice(0, 6);
    db.prepare('INSERT OR REPLACE INTO style_guides (key, niche, data, at) VALUES (?, ?, ?, ?)').run(key, niche, JSON.stringify(g), Date.now());
    log(`Montaj uslubi o'rganildi: "${niche}" — ${shorts.length} ta mashhur Shorts (${shorts.map((s) => Math.round(s.views / 1000) + 'K').join(', ')} ko'rish)`);
    return g;
  })().catch((e) => { log('Montaj uslubini o\'rganib bo\'lmadi: ' + e.message.slice(0, 200), 'warn'); return row ? JSON.parse(row.data) : null; })
    .finally(() => { delete learning[key]; });
  return learning[key];
}

// a learned guide -> this job's editing settings (only the knobs the editor really has; your own on/off choices for
// emojis, compilation etc. are not touched)
function overrides(g) {
  if (!g) return {};
  const o = {};
  if (g.avgLength >= 15) o.shortTarget = Math.round(Math.max(20, Math.min(58, g.avgLength)));
  o.hook = g.hook === 'climax_first' || g.hook === 'question_or_text';
  o.zoom = g.zoom !== 'none';
  o.memes = !!g.memeText;
  o.climaxFull = !!g.climaxFullscreen;
  if (g.subtitleStyle && g.subtitleStyle !== 'none') o.subtitleStyle = g.subtitleStyle;
  return o;
}
const rulesText = (g) => (g ? [...(g.momentRules || []), ...(g.editingRules || []), g.titleStyle ? 'Titles: ' + g.titleStyle : ''].filter(Boolean) : []);
const all = () => db.prepare('SELECT niche, data, at FROM style_guides ORDER BY at DESC LIMIT 20').all().map((r) => JSON.parse(r.data));
// the guide of the niche that is most likely for a new video (same words in the title), so moment picking can use it
function guess(text) {
  const t = keyOf(text); if (!t) return null;
  for (const g of all()) { const k = keyOf(g.niche); if (k && t.includes(k)) return g; }
  return null;
}

module.exports = { learn, overrides, rulesText, all, guess };

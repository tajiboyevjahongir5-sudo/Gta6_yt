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
async function viralShorts(niche, max = 8) {
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

// a channel given as @handle / youtube.com/@handle / channel URL: its own most-viewed Shorts (from its latest ~150 uploads)
function channelRef(text) {
  const t = String(text || '').trim();
  let m = t.match(/youtube\.com\/(@[\w.-]+)/i) || t.match(/^(@[\w.-]+)$/);
  if (m) return { handle: m[1] };
  m = t.match(/youtube\.com\/channel\/(UC[\w-]{20,})/i) || t.match(/^(UC[\w-]{20,})$/);
  return m ? { id: m[1] } : null;
}
async function channelShorts(ref, max = 12) {
  const c = await yt.apiGet('channels?part=snippet,contentDetails&' + (ref.id ? 'id=' + ref.id : 'forHandle=' + encodeURIComponent(ref.handle)));
  const ch = c.items?.[0]; if (!ch) throw new Error('Kanal topilmadi: ' + (ref.handle || ref.id));
  const up = ch.contentDetails?.relatedPlaylists?.uploads; const ids = []; let page = '';
  do { const j = await yt.apiGet(`playlistItems?part=contentDetails&maxResults=50&playlistId=${up}${page ? '&pageToken=' + page : ''}`);
    for (const it of j.items || []) ids.push(it.contentDetails.videoId); page = j.nextPageToken; } while (page && ids.length < 150);
  const sec = (d) => { const m = String(d || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/) || []; return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0); };
  const vids = [];
  for (let i = 0; i < ids.length; i += 50) {
    const v = await yt.apiGet('videos?part=snippet,statistics,contentDetails&id=' + ids.slice(i, i + 50).join(','));
    for (const x of v.items || []) vids.push({ id: x.id, title: x.snippet.title, channel: x.snippet.channelTitle, views: +(x.statistics.viewCount || 0), duration: sec(x.contentDetails.duration), published: Date.parse(x.snippet.publishedAt) });
  }
  return { title: ch.snippet.title, handle: ch.snippet.customUrl || ref.handle || '', shorts: vids.filter((x) => x.duration > 0 && x.duration <= 180).sort((a, b) => b.views - a.views).slice(0, max),
    longs: vids.filter((x) => x.duration > 180) };
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

const ANALYSIS = { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: {
  type: 'object', additionalProperties: false, required: ['n', 'whatHappens', 'whyInteresting', 'hook', 'structure', 'audio', 'emotion', 'techniques', 'momentType', 'titleRelation'],
  properties: {
    n: { type: 'number' },
    whatHappens: { type: 'string', description: 'Uzbek: what happens in the Short, short' },
    whyInteresting: { type: 'string', description: 'Uzbek: why people watch / share it (the real reason)' },
    hook: { type: 'string', description: 'Uzbek: what the first 1-2 seconds show / say' },
    structure: { type: 'string', description: 'Uzbek: setup -> key moment -> ending, with seconds' },
    audio: { type: 'string', description: 'Uzbek: what you HEAR that makes it work: words, laughs, screams, sound effects, music' },
    emotion: { type: 'string' },
    techniques: { type: 'array', items: { type: 'string' }, description: 'editing techniques actually used (cuts, zooms, captions, sfx, memes, layout)' },
    momentType: { type: 'string', enum: ['fail', 'win', 'prank', 'jumpscare', 'reaction', 'joke', 'argument', 'skill', 'story', 'other'] },
    titleRelation: { type: 'string', description: 'Uzbek: how the title relates to the content' } } } } } };
const MAPPING = { type: 'object', additionalProperties: false, required: ['found', 'startSec', 'endSec', 'why', 'cut', 'added'],
  properties: { found: { type: 'boolean' }, startSec: { type: 'number' }, endSec: { type: 'number' },
    why: { type: 'string', description: 'Uzbek: why the editor chose exactly this part of the long video' },
    cut: { type: 'string', description: 'Uzbek: what of that part was left out / shortened' },
    added: { type: 'string', description: 'Uzbek: what the Short adds that the long video does not have (captions, zoom, sfx, reorder)' } } };

// progress of a running study, for the Web App
const status = {};
const setStatus = (key, label, step) => { status[key] = { niche: label, step, at: Date.now() }; };

let learning = {};
async function learn(niche, { force = false } = {}) {
  const key = keyOf(niche);
  if (!key || !yt.connected() || !ai.providers().includes('gemini')) return null;
  const row = db.prepare('SELECT * FROM style_guides WHERE key = ?').get(key);
  if (!force && row && Date.now() - row.at < WEEK) return JSON.parse(row.data);
  if (learning[key]) return learning[key];
  learning[key] = (async () => {
    const ref = channelRef(niche);
    let shorts, longs = [], label = niche, who;
    setStatus(key, niche, 'Shorts qidirilmoqda');
    if (ref) { const c = await channelShorts(ref); shorts = c.shorts; longs = c.longs; label = `${c.title}${c.handle ? ' (' + c.handle + ')' : ''}`; who = `the channel "${c.title}"`; }
    else { shorts = await viralShorts(niche); who = `the niche "${niche}"`; }
    if (shorts.length < 2) { log(`Montaj uslubi: "${niche}" bo'yicha mashhur Shorts topilmadi`, 'warn'); if (ref) throw new Error('Bu kanalda Shorts topilmadi'); return row ? JSON.parse(row.data) : null; }

    // 1) every Short watched AND listened to in full, 3 at a time: what happens, why it works, hook, structure, sound
    const analyses = [];
    for (let i = 0; i < shorts.length; i += 3) {
      const part = shorts.slice(i, i + 3);
      setStatus(key, label, `Shorts ko'rilmoqda ${Math.min(i + 3, shorts.length)}/${shorts.length}`);
      const r = await ai.generateJSON({ schema: ANALYSIS, parts: [
        { text: `Popular YouTube Shorts of ${who}. Watch and LISTEN to each one in full, like a professional short-form editor studying why it went viral.` },
        ...part.flatMap((x, k) => [{ text: `Short n=${i + k + 1}: "${x.title}" — ${x.views} views, ${x.duration}s` }, { youtube: `https://www.youtube.com/watch?v=${x.id}` }]),
        { text: `For each Short answer: what happens; WHY it is interesting (the real reason people watch to the end and share); what the first 1-2 seconds do; ` +
          `the structure with seconds; what you hear that makes it work (words, laughter, screams, sound effects, music); the emotion; the editing techniques actually used; ` +
          `the type of moment; how the title relates to it. Only what you really see and hear.` }] });
      for (const it of r?.data?.items || []) { const x = part[Math.round(it.n) - 1 - i]; if (x) analyses.push({ ...it, id: x.id, title: x.title, views: x.views, duration: x.duration }); }
    }

    // 2) channel: which long video of the same channel each top Short was cut from, which part, and why that part
    const mappings = [];
    if (ref && longs.length) {
      const words = (t) => new Set(keyOf(t).split(' ').filter((w) => w.length > 3));
      for (const x of shorts.slice(0, 5)) {
        const cand = longs.filter((l) => l.published <= x.published + 3600000 && x.published - l.published < 45 * 86400000 && l.duration <= 3 * 3600)
          .map((l) => ({ ...l, sim: [...words(l.title)].filter((w) => words(x.title).has(w)).length, gap: x.published - l.published }))
          .sort((a, b) => b.sim - a.sim || a.gap - b.gap).slice(0, 2);
        for (const l of cand) {
          setStatus(key, label, `Manba qidirilmoqda: "${x.title.slice(0, 40)}"`);
          const r = await ai.generateJSON({ schema: MAPPING, parts: [
            { text: `A Short of ${who}:` }, { youtube: `https://www.youtube.com/watch?v=${x.id}` },
            { text: `A long video of the same channel ("${l.title}", ${Math.round(l.duration / 60)} min):` }, { youtube: `https://www.youtube.com/watch?v=${l.id}`, fps: l.duration > 1800 ? 0.1 : 0.25, low: true },
            { text: `Is the Short cut from this long video? If yes: start/end seconds of that part in the LONG video, why an editor chose exactly this part, ` +
              `what was cut out, and what the Short adds. If it is not from this video, found=false.` }] });
          const m = r?.data;
          if (m?.found) { mappings.push({ short: x.id, shortTitle: x.title, long: l.id, longTitle: l.title, start: Math.round(m.startSec), end: Math.round(m.endSec), why: m.why, cut: m.cut, added: m.added }); break; }
        }
      }
    }

    // 3) everything together -> the style guide the editor follows
    setStatus(key, label, 'Xulosa yozilmoqda');
    const r = await ai.generateJSON({
      schema: { ...SCHEMA, required: [...SCHEMA.required, 'whyTheyWork', 'clipPatterns'], properties: { ...SCHEMA.properties,
        whyTheyWork: { type: 'array', items: { type: 'string' }, description: 'Uzbek, max 6: the common reasons these Shorts are interesting' },
        clipPatterns: { type: 'array', items: { type: 'string' }, description: 'English, max 6: how a long video is turned into a Short here (which part is taken, where it starts and ends, what is cut)' } } },
      quality: 'high',
      parts: [{ text: `Study notes about ${analyses.length} popular Shorts of ${who} (each watched and listened to in full):\n` +
        analyses.map((a) => `- "${a.title}" (${a.views} views, ${a.duration}s, ${a.momentType}): ${a.whatHappens} | WHY: ${a.whyInteresting} | HOOK: ${a.hook} | ` +
          `STRUCTURE: ${a.structure} | SOUND: ${a.audio} | EMOTION: ${a.emotion} | TECHNIQUES: ${a.techniques.join(', ')} | TITLE: ${a.titleRelation}`).join('\n') +
        (mappings.length ? `\n\nWhere Shorts were cut from the channel's long videos:\n` + mappings.map((m) => `- "${m.shortTitle}" = ${m.start}-${m.end}s of "${m.longTitle}": ${m.why} | cut: ${m.cut} | added: ${m.added}`).join('\n') : '') +
        `\n\nWrite the editing style guide an automatic editor should follow to make Shorts like these: the common patterns, not one video.` }],
    });
    const g = r?.data; if (!g) return row ? JSON.parse(row.data) : null;
    Object.assign(g, { niche: label, channel: !!ref, sources: shorts, analyses, mappings, at: Date.now() });
    g.momentRules = (g.momentRules || []).slice(0, 6); g.editingRules = (g.editingRules || []).slice(0, 6); g.clipPatterns = (g.clipPatterns || []).slice(0, 6);
    db.prepare('INSERT OR REPLACE INTO style_guides (key, niche, data, at) VALUES (?, ?, ?, ?)').run(key, niche, JSON.stringify(g), Date.now());
    log(`Montaj uslubi o'rganildi: "${label}" — ${analyses.length} ta Shorts to'liq ko'rildi${mappings.length ? `, ${mappings.length} tasining manba videosi topildi` : ''}`);
    return g;
  })().catch((e) => { log('Montaj uslubini o\'rganib bo\'lmadi: ' + e.message.slice(0, 200), 'warn'); if (channelRef(niche)) throw e; return row ? JSON.parse(row.data) : null; })
    .finally(() => { delete learning[key]; delete status[key]; });
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
const rulesText = (g) => (g ? [...(g.momentRules || []), ...(g.clipPatterns || []), ...(g.editingRules || []), g.titleStyle ? 'Titles: ' + g.titleStyle : ''].filter(Boolean) : []);
const all = () => db.prepare('SELECT niche, data, at FROM style_guides ORDER BY at DESC LIMIT 20').all().map((r) => JSON.parse(r.data));
// the guide of the niche that is most likely for a new video (same words in the title), so moment picking can use it
function guess(text) {
  const t = keyOf(text); if (!t) return null;
  for (const g of all()) { const k = keyOf(g.niche); if (k && t.includes(k)) return g; }
  return null;
}

module.exports = { status: () => Object.values(status), channelRef, learn, overrides, rulesText, all, guess };

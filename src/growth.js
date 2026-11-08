// Channel growth: answers comments like the creator would, studies how the uploads perform every day (why a Short
// was or wasn't pushed by the algorithm, low likes/subs/comments), turns that into lessons the next edits follow,
// and tracks progress toward the YouTube Partner Program (monetization).
const { db, getSettings, setSettings, getSecret, setSecret, log } = require('./db');
const yt = require('./youtube');
const ai = require('./ai');
const tg = require('./telegram');

const DAY = 86400000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const LANG = { uz: "Uzbek (Latin script)", ru: 'Russian', en: 'English' };

// ---------------- comments ----------------
let replying = null;
async function replyComments({ force = false } = {}) {
  const s = getSettings();
  if (!yt.connected() || (!s.autoReply && !force) || replying) return replying;
  replying = (async () => {
    if (!yt.hasScope('youtube.force-ssl')) { log('Komentlarga javob: kanalni qayta ulang (komentlarga javob ruxsati kerak)', 'warn'); return { error: 'scope' }; }
    const me = (await yt.channelInfo())?.id;
    const used = db.prepare('SELECT COUNT(*) n FROM comment_replies WHERE skipped = 0 AND at > ?').get(Date.now() - DAY).n;
    let budget = Math.max(0, (s.repliesPerDay || 25) - used);
    if (!budget) return { replied: 0, reason: 'kunlik limit' };
    // newest videos first: that's where people talk and where a quick answer helps the most
    const vids = db.prepare('SELECT id, title FROM channel_videos WHERE published > ? ORDER BY published DESC LIMIT 15').all(Date.now() - 45 * DAY);
    const known = db.prepare('SELECT 1 FROM comment_replies WHERE comment_id = ?');
    const todo = [];
    for (const v of vids) {
      let threads = [];
      try { threads = await yt.commentThreads(v.id, 50); } catch (e) { if (/disabled/i.test(e.message)) continue; throw e; }
      for (const c of threads) {
        if (!c.text.trim() || c.authorChannel === me || c.replyAuthors.includes(me) || known.get(c.id)) continue;
        todo.push({ ...c, title: v.title });
      }
      if (todo.length >= budget * 2) break;
    }
    if (!todo.length) return { replied: 0 };
    const batch = todo.sort((a, b) => b.likes - a.likes || a.at - b.at).slice(0, Math.min(budget, 20));
    const r = await ai.generateJSON({
      schema: { type: 'object', additionalProperties: false, required: ['replies'], properties: { replies: { type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['n', 'skip', 'reply'],
        properties: { n: { type: 'number' }, skip: { type: 'boolean' }, reply: { type: 'string' } } } } } },
      parts: [{ text:
        `You are the owner of the YouTube channel "${s.channelName}" (short highlights of streams and videos). Answer your viewers' comments yourself, ` +
        `as a real person who loves the channel and its viewers: warm, natural, a little playful, specific to what the person wrote and to the video. ` +
        `Write in the commenter's language (Uzbek in Latin script if they write Uzbek; default ${LANG[s.language] || 'Uzbek'}). ` +
        `1-2 short sentences, like a human types: no hashtags, no links, no ads, no "As an AI", no copy-paste phrases, no more than one emoji (often none). ` +
        `Vary the wording between replies. When it fits, ask a short question back or invite them to say what moment they want next - conversation helps the video. ` +
        `Thank people for kind words without sounding like a bot. For criticism: friendly, honest, say you'll try to do better. ` +
        `Never promise giveaways, money or things you can't do. Set skip=true (reply "") for spam, scams, links/self-promotion, hate, insults, sexual content, ` +
        `or text that is impossible to understand.\n\n` +
        batch.map((c, i) => `${i + 1}. Video: "${c.title}"\n   ${c.author}: ${c.text.slice(0, 500)}`).join('\n') +
        `\n\nReturn one item per comment, n = its number.` }],
    });
    const list = r?.data?.replies || [];
    let replied = 0;
    const save = db.prepare('INSERT OR REPLACE INTO comment_replies (comment_id, video_id, comment, reply, skipped, at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const it of list) {
      const c = batch[Math.round(it.n) - 1]; if (!c) continue;
      const text = String(it.reply || '').trim();
      if (it.skip || !text) { save.run(c.id, c.videoId, c.text, '', 1, Date.now()); continue; }
      try { await yt.replyComment(c.id, text.slice(0, 1000)); save.run(c.id, c.videoId, c.text, text, 0, Date.now()); replied++; }
      catch (e) { log('Kommentga javob yozilmadi: ' + e.message, 'warn'); if (/quota/i.test(e.message)) break; }
      await new Promise((ok) => setTimeout(ok, 4000 + Math.random() * 6000)); // not all at once, like a person
    }
    if (replied) log(`Komentlarga ${replied} ta javob yozildi`);
    return { replied };
  })().finally(() => { replying = null; });
  return replying;
}

// ---------------- performance + monetization ----------------
async function tryAnalytics(params) {
  if (!yt.hasScope('yt-analytics.readonly')) return { rows: null, error: 'scope' };
  try { return { rows: await yt.analytics(params) }; }
  catch (e) { return { rows: null, error: /has not been used|disabled|accessNotConfigured/i.test(e.message) ? 'api' : e.message }; }
}

// YouTube Partner Program: 1,000 subscribers + (4,000 public watch hours in 12 months OR 10M public Shorts views in 90 days).
// Early tier (fan funding): 500 subscribers + 3 uploads in 90 days + (3,000 watch hours OR 3M Shorts views).
async function monetization() {
  const ch = await yt.channelInfo();
  const now = Date.now();
  const out = { subscribers: ch?.subscribers || 0, shortsViews90: null, watchHours365: null, uploads90: 0, source: 'analytics' };
  out.uploads90 = db.prepare('SELECT COUNT(*) n FROM channel_videos WHERE published > ?').get(now - 90 * DAY).n;
  const a90 = await tryAnalytics({ startDate: iso(now - 90 * DAY), endDate: iso(now), metrics: 'views', dimensions: 'creatorContentType' });
  const a365 = await tryAnalytics({ startDate: iso(now - 365 * DAY), endDate: iso(now), metrics: 'estimatedMinutesWatched', dimensions: 'creatorContentType' });
  if (a90.rows && a365.rows) {
    out.shortsViews90 = a90.rows.filter((r) => /SHORTS/i.test(r.creatorContentType)).reduce((x, r) => x + r.views, 0);
    out.watchHours365 = Math.round(a365.rows.filter((r) => !/SHORTS/i.test(r.creatorContentType)).reduce((x, r) => x + r.estimatedMinutesWatched, 0) / 60);
  } else {
    // without the Analytics API: lifetime views of Shorts published in the last 90 days (an estimate)
    out.source = 'estimate'; out.analyticsError = a90.error || a365.error;
    out.shortsViews90 = db.prepare('SELECT COALESCE(SUM(views),0) n FROM channel_videos WHERE duration <= 180 AND published > ?').get(now - 90 * DAY).n;
  }
  const pct = (v, goal) => (v == null ? null : Math.min(100, Math.round((v / goal) * 1000) / 10));
  out.full = { subs: pct(out.subscribers, 1000), shorts: pct(out.shortsViews90, 10e6), hours: pct(out.watchHours365, 4000) };
  out.early = { subs: pct(out.subscribers, 500), shorts: pct(out.shortsViews90, 3e6), hours: pct(out.watchHours365, 3000), uploads: pct(out.uploads90, 3) };
  return out;
}

let analyzing = null;
async function analyze() {
  if (!yt.connected() || analyzing) return analyzing;
  analyzing = (async () => {
    const s = getSettings();
    const now = Date.now();
    const vids = db.prepare('SELECT id, title, published, views, likes, comments, duration FROM channel_videos WHERE published > ? ORDER BY published DESC LIMIT 60')
      .all(now - 60 * DAY);
    if (vids.length < 3) return { skipped: 'kam video' };
    // per-video retention etc. (only with the Analytics API)
    const per = await tryAnalytics({ startDate: iso(now - 90 * DAY), endDate: iso(now), dimensions: 'video',
      metrics: 'views,averageViewDuration,averageViewPercentage,likes,comments,shares,subscribersGained', sort: '-views', maxResults: '200' });
    const byId = new Map((per.rows || []).map((r) => [r.video, r]));
    const lahza = new Map(db.prepare("SELECT youtube_id, kind, category, duration FROM clips WHERE youtube_id IS NOT NULL").all().map((c) => [c.youtube_id, c]));
    const rows = vids.map((v) => {
      const a = byId.get(v.id) || {}; const age = Math.max(1, Math.round((now - v.published) / 3600000));
      return `${v.duration <= 180 ? 'SHORT' : 'VIDEO'} ${v.duration}s | ${age}h old | views ${v.views} | likes ${v.likes} (${v.views ? ((v.likes / v.views) * 100).toFixed(1) : 0}%)` +
        ` | comments ${v.comments}` + (a.averageViewPercentage != null ? ` | avg watched ${Math.round(a.averageViewPercentage)}% (${Math.round(a.averageViewDuration)}s)` : '') +
        (a.subscribersGained != null ? ` | subs +${a.subscribersGained} | shares ${a.shares}` : '') + (lahza.has(v.id) ? ' | made by Lahza' : '') + ` | "${v.title}"`;
    });
    const mon = await monetization();
    const prev = getSecret('growthReport');
    const r = await ai.generateJSON({
      quality: 'high',
      schema: { type: 'object', additionalProperties: false, required: ['summary', 'diagnosis', 'lessons', 'idealShortSeconds', 'monetizationPlan'],
        properties: {
          summary: { type: 'string', description: '2-3 sentences: how the channel is doing and the main reason' },
          diagnosis: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['problem', 'evidence', 'fix'],
            properties: { problem: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' } } } },
          lessons: { type: 'array', items: { type: 'string' }, description: 'max 8 concrete rules for the NEXT Shorts: which moments to choose, hook in the first 2 s, length, titles' },
          idealShortSeconds: { type: 'number', description: 'best Short length for this channel right now, 20-58' },
          monetizationPlan: { type: 'array', items: { type: 'string' }, description: 'max 6 concrete steps to reach the Partner Program faster' } } },
      parts: [{ text:
        `You are a YouTube growth strategist for the channel "${s.channelName}" (gaming/stream highlights as Shorts and videos, language: ${LANG[s.language] || s.language}). ` +
        `Here is every upload of the last 60 days with its numbers:\n${rows.join('\n')}\n\n` +
        `Monetization progress: subscribers ${mon.subscribers}/1000, Shorts views in 90 days ${mon.shortsViews90 ?? '?'}/10,000,000` +
        `${mon.watchHours365 != null ? `, watch hours (12 months) ${mon.watchHours365}/4000` : ''}${mon.source === 'estimate' ? ' (Shorts views estimated)' : ''}.\n` +
        (prev?.lessons?.length ? `Lessons given yesterday: ${prev.lessons.join(' | ')}\n` : '') +
        `\nFind out WHY some uploads were pushed by the algorithm and others not, and why likes, comments and subscriptions are low or high. ` +
        `Use the evidence: views vs age, like rate (good Shorts ~4%+), comments, average % watched (Shorts: under ~70% means viewers swipe away — weak hook or too long; ` +
        `over 100% means rewatches), subs gained, title wording, length. Compare the best and the worst. Be specific and honest; ` +
        `do not invent numbers that are not above. If there is too little data, say so and give the safest rules.\n` +
        `Write everything in ${LANG.uz}.` }],
    });
    if (!r?.data) return { error: 'AI javob bermadi' };
    const rep = { ...r.data, at: now, monetization: mon, analytics: !!per.rows, analyticsError: per.error || null, videos: vids.length };
    rep.lessons = (rep.lessons || []).slice(0, 8);
    setSecret('growthReport', rep);
    if (s.autoTune && rep.idealShortSeconds >= 20 && rep.idealShortSeconds <= 58) setSettings({ shortTarget: Math.round(rep.idealShortSeconds) });
    log('Kanal tahlili tayyor: ' + rep.summary.slice(0, 160));
    await tg.notifyAdmins(`📈 <b>Kunlik tahlil</b>\n${tg.escHtml(rep.summary)}\n\n` +
      rep.diagnosis.slice(0, 3).map((d) => `• <b>${tg.escHtml(d.problem)}</b> → ${tg.escHtml(d.fix)}`).join('\n') +
      `\n\nKeyingi montajlarda hisobga olinadi. To'liq: Panel → Statistika`);
    return rep;
  })().finally(() => { analyzing = null; });
  return analyzing;
}

// lessons for the AI that picks moments and writes titles (src/ai.js rankAndDescribe)
function lessons() {
  const s = getSettings(); const r = getSecret('growthReport');
  return s.autoTune && r?.lessons?.length && Date.now() - r.at < 14 * DAY ? r.lessons : [];
}

function start(every) {
  every(3 * 3600000, () => replyComments());
  every(3600000, async () => { const r = getSecret('growthReport'); if (!r || Date.now() - r.at > 22 * 3600000) await analyze(); });
}

module.exports = { start, replyComments, analyze, monetization, lessons };

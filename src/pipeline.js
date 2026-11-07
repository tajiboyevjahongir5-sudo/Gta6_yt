// The whole factory: download -> find highlights -> AI rank + metadata -> edit -> approve -> scheduled upload -> stats.
const fs = require('fs');
const path = require('path');
const { db, getSettings, log, parseClip, updateRow } = require('./db');
const { WORK_DIR, OUT_DIR, YTDLP } = require('./config');
const { run, sleep, fmtTime, dayKey, TZ_OFFSET } = require('./util');
const { findHighlights } = require('./analyze');
const render = require('./render');
const ai = require('./ai');
const yt = require('./youtube');
const tg = require('./telegram');

// ---------------- jobs ----------------
function normalizeVideoUrl(url) { return String(url).trim(); }
function addJob(url, sourceId = null, meta = {}) {
  url = normalizeVideoUrl(url);
  if (!/^https?:\/\//.test(url)) throw new Error('Havola noto\'g\'ri');
  const dup = db.prepare("SELECT id, status FROM jobs WHERE url = ? AND status NOT IN ('failed')").get(url);
  if (dup) return { id: dup.id, duplicate: true };
  const t = Date.now();
  const r = db.prepare('INSERT INTO jobs (source_id, url, title, author, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sourceId, url, meta.title || null, meta.author || null, 'queued', t, t);
  log(`Navbatga qo'shildi #${r.lastInsertRowid}: ${meta.title || url}`);
  kick();
  return { id: Number(r.lastInsertRowid) };
}
const setJob = (id, patch) => updateRow('jobs', id, { ...patch, updated_at: Date.now() });

async function download(job, dir, quality) {
  const { out } = await run(YTDLP, ['--dump-single-json', '--no-playlist', '--no-warnings', job.url], { timeoutMs: 120000 });
  const meta = JSON.parse(out);
  if (meta.is_live || meta.live_status === 'is_live' || meta.live_status === 'is_upcoming') {
    const e = new Error('Efir hali tugamagan — tugagach avtomatik qayta urinadi'); e.waitLive = true; throw e; }
  setJob(job.id, { title: meta.title, author: meta.uploader || meta.channel, author_url: meta.uploader_url || meta.channel_url,
    video_id: meta.id, duration: meta.duration || null });
  const tmpl = path.join(dir, 'source.%(ext)s');
  await run(YTDLP, ['-f', `bv*[height<=${quality}][ext=mp4]+ba[ext=m4a]/bv*[height<=${quality}]+ba/b[height<=${quality}]/b`,
    '--merge-output-format', 'mp4', '--no-playlist', '--no-part', '--concurrent-fragments', '4', '--newline', '-o', tmpl, job.url], {
    onLine: (l) => { const m = l.match(/\[download\]\s+([\d.]+)%/); if (m) setJob(job.id, { progress: Number(m[1]) / 100 }); },
  });
  const file = fs.readdirSync(dir).find((f) => f.startsWith('source.') && !f.endsWith('.part') && !f.endsWith('.ytdl'));
  if (!file) throw new Error('Video yuklab olinmadi');
  return { file: path.join(dir, file), meta };
}

// choose final moments: AI score (if any) + loudness score, then fit into the target length
function chooseMoments(candidates, aiRes, settings) {
  const maxAudio = Math.max(...candidates.map((c) => c.score), 0.001);
  const byIdx = new Map((aiRes?.moments || []).map((m) => [m.index, m]));
  const scored = candidates.map((c, i) => {
    const a = byIdx.get(i);
    const final = a ? (a.score / 10) * 0.7 + (c.score / maxAudio) * 0.3 : c.score / maxAudio;
    return { ...c, final: Number(final.toFixed(3)), caption: a?.caption || '', shortTitle: a?.short_title || '', aiScore: a?.score ?? null };
  }).filter((c) => c.aiScore === null || c.aiScore >= 3).sort((a, b) => b.final - a.final);
  const picked = []; let total = 0;
  for (const c of scored) {
    if (picked.length >= settings.highlightCount) break;
    if (total + (c.end - c.start) > settings.targetMinutes * 60 * 1.15 && picked.length >= 3) break;
    picked.push(c); total += c.end - c.start;
  }
  return { picked, ranked: scored };
}

function creditLine(job) { return job.author ? `🎮 Original stream: ${job.author}${job.url ? ' — ' + job.url : ''}` : ''; }

async function processJob(job) {
  const settings = getSettings();
  const dir = path.join(WORK_DIR, String(job.id)); fs.mkdirSync(dir, { recursive: true });
  const outDir = path.join(OUT_DIR, String(job.id)); fs.mkdirSync(outDir, { recursive: true });

  setJob(job.id, { status: 'downloading', step: 'Yuklab olinmoqda', progress: 0, error: null });
  const { file: src } = await download(job, dir, settings.quality);
  job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
  const source = job.source_id ? db.prepare('SELECT * FROM sources WHERE id = ?').get(job.source_id) : null;
  if (source?.credit) job.author = source.credit;

  setJob(job.id, { status: 'analyzing', step: 'Qiziq lahzalar qidirilmoqda', progress: 0 });
  const { info, candidates } = await findHighlights(src, { count: settings.highlightCount, before: settings.clipBefore, after: settings.clipAfter },
    (p) => setJob(job.id, { progress: p }));
  setJob(job.id, { duration: info.duration });
  if (!candidates.length) throw new Error('Qiziq lahza topilmadi (video juda jim yoki qisqa)');

  let aiRes = null;
  if (ai.enabled() && settings.useAI) {
    setJob(job.id, { step: 'AI lahzalarni baholamoqda', progress: 0.2 });
    const cands = candidates.slice(0, 16);
    for (let i = 0; i < cands.length; i++) {
      cands[i].frames = [];
      for (const [k, t] of [cands[i].peak - 4, cands[i].peak + 1].entries())
        cands[i].frames.push(await render.grabFrame(src, Math.min(t, info.duration - 1), path.join(dir, `f${i}_${k}.jpg`)));
    }
    aiRes = await ai.rankAndDescribe({ candidates: cands, source: job, settings });
    candidates.length = cands.length;
  }
  const tpl = ai.templateMeta({ source: job, settings, count: settings.highlightCount });
  const { picked } = chooseMoments(candidates, aiRes, settings);
  const long = aiRes?.long || tpl.long;
  const tags = [...(long.tags || []), ...settings.defaultTags];
  const created = [];
  const status = settings.autoPublish ? 'approved' : 'draft';
  const ins = db.prepare(`INSERT INTO clips (job_id, kind, file, thumb, segments, duration, score, title, description, tags, thumb_text, status, privacy, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  setJob(job.id, { status: 'rendering', step: 'Montaj qilinmoqda', progress: 0 });
  const totalSteps = (settings.makeLong ? 1 : 0) + (settings.makeShorts ? Math.min(settings.shortsPerVideo, picked.length) : 0) || 1;
  let done = 0;
  if (settings.makeLong && picked.length >= 3) {
    const out = path.join(outDir, 'compilation.mp4');
    await render.renderCompilation(src, picked, out, dir, (p) => setJob(job.id, { progress: (done + p) / totalSteps }));
    const ordered = [...picked].sort((a, b) => a.start - b.start);
    let t = 0; const chapters = ordered.map((s, i) => { const line = `${fmtTime(t)} ${s.caption || 'Lahza #' + (i + 1)}`; t += s.end - s.start; return line; });
    const description = [long.description, '', '⏱ Taym-kodlar:', ...chapters, '', creditLine(job), '', settings.descriptionFooter].filter((x) => x !== undefined).join('\n');
    const best = picked[0];
    const thumb = path.join(outDir, 'compilation.jpg');
    await render.renderThumbnail(src, best.peak - 1, long.thumb_text, thumb, dir, { accent: settings.accent, badge: settings.game });
    const r = ins.run(job.id, 'long', out, thumb, JSON.stringify(ordered), t, best.final, long.title, description, JSON.stringify(tags), long.thumb_text, status, settings.privacy, Date.now());
    created.push(Number(r.lastInsertRowid)); done++;
  }
  if (settings.makeShorts) {
    for (let i = 0; i < Math.min(settings.shortsPerVideo, picked.length); i++) {
      const s = picked[i]; const title = s.shortTitle || tpl.shortTitle(i);
      const out = path.join(outDir, `short_${i + 1}.mp4`); const thumb = path.join(outDir, `short_${i + 1}.jpg`);
      await render.renderShort(src, s, title, out, dir);
      await render.grabFrame(out, 1.5, thumb, 540);
      const description = [title, '', creditLine(job), '', `#shorts #${settings.game.replace(/\s+/g, '')} #gaming`].join('\n');
      const r = ins.run(job.id, 'short', out, thumb, JSON.stringify([s]), Math.min(58, s.end - s.start), s.final,
        (title + ' #shorts').slice(0, 100), description, JSON.stringify([...tags.slice(0, 10), 'shorts']), '', status, settings.privacy, Date.now());
      created.push(Number(r.lastInsertRowid)); done++;
      setJob(job.id, { progress: done / totalSteps });
    }
  }
  if (!settings.keepSource) fs.rmSync(dir, { recursive: true, force: true });
  setJob(job.id, { status: 'done', step: `${created.length} ta klip tayyor`, progress: 1 });
  log(`#${job.id} tayyor: ${created.length} ta klip (${job.title || job.url})`);
  if (settings.autoPublish) for (const id of created) scheduleClip(id);
  for (const id of created) await announceClip(id);
}

async function announceClip(id) {
  const c = parseClip(db.prepare('SELECT * FROM clips WHERE id = ?').get(id)); if (!c) return;
  const kind = c.kind === 'short' ? '📱 Shorts' : '🎬 Kompilyatsiya';
  const when = c.scheduled_at ? `\n🗓 Yuklanadi: ${new Date(c.scheduled_at + TZ_OFFSET).toISOString().slice(5, 16).replace('T', ' ')}` : '';
  const caption = `${kind} • ${fmtTime(c.duration)}\n<b>${tg.escHtml(c.title)}</b>${when}`;
  const kb = c.status === 'draft' ? { inline_keyboard: [[{ text: '✅ Tasdiqlash', callback_data: 'ok:' + id }, { text: '🚀 Hozir yuklash', callback_data: 'now:' + id }],
    [{ text: '❌ Rad etish', callback_data: 'no:' + id }]] } : undefined;
  await tg.sendPhotoToAdmins(c.thumb, caption, kb);
}

// ---------------- scheduling & upload ----------------
// next free publish slot (Tashkent time), respecting the daily limit
function nextSlot(settings) {
  const taken = new Set(db.prepare("SELECT scheduled_at FROM clips WHERE status IN ('approved','uploading','published') AND scheduled_at IS NOT NULL").all().map((r) => r.scheduled_at));
  const perDay = {};
  for (const r of db.prepare("SELECT scheduled_at FROM clips WHERE status IN ('approved','uploading','published') AND scheduled_at IS NOT NULL").all()) {
    const d = dayKey(r.scheduled_at); perDay[d] = (perDay[d] || 0) + 1; }
  const times = (settings.publishTimes || []).filter((t) => /^\d{1,2}:\d{2}$/.test(t)).sort();
  if (!times.length) return Date.now();
  for (let day = 0; day < 60; day++) {
    const base = Date.now() + day * 86400000; const d = dayKey(base);
    if ((perDay[d] || 0) >= settings.dailyLimit) continue;
    for (const hm of times) {
      const [h, m] = hm.split(':').map(Number);
      const t = Date.parse(`${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`) - TZ_OFFSET;
      if (t > Date.now() + 60000 && !taken.has(t)) return t;
    }
  }
  return Date.now();
}
function scheduleClip(id, immediately = false) {
  const settings = getSettings();
  const t = immediately ? Date.now() : nextSlot(settings);
  updateRow('clips', id, { status: 'approved', scheduled_at: t, error: null });
  return t;
}

async function uploadClip(c) {
  const settings = getSettings();
  updateRow('clips', c.id, { status: 'uploading', error: null });
  try {
    let vid = null, lastErr;
    for (let attempt = 0; attempt < 3 && !vid; attempt++) {
      try { vid = await yt.upload({ file: c.file, title: c.title, description: c.description, tags: c.tags, privacy: c.privacy || settings.privacy, language: settings.language }); }
      catch (e) { lastErr = e; if (/quota/i.test(e.message)) break; await sleep(5000 * (attempt + 1)); }
    }
    if (!vid) throw lastErr;
    if (c.kind === 'long' && c.thumb) { try { await yt.setThumbnail(vid, c.thumb); } catch (e) { log(e.message, 'warn'); } }
    updateRow('clips', c.id, { status: 'published', youtube_id: vid, published_at: Date.now() });
    log(`YouTube'ga yuklandi: ${c.title} (https://youtu.be/${vid})`);
    await tg.notifyAdmins(`✅ Yuklandi: <b>${tg.escHtml(c.title)}</b>\nhttps://youtu.be/${vid}`);
  } catch (e) {
    const quota = /quota/i.test(e.message);
    // quota errors: keep it approved and try again tomorrow
    updateRow('clips', c.id, quota ? { status: 'approved', scheduled_at: Date.now() + 6 * 3600000, error: 'Kunlik YouTube limiti tugadi' } : { status: 'failed', error: e.message });
    log(`Yuklash xatosi (${c.title}): ${e.message}`, 'error');
    if (!quota) await tg.notifyAdmins(`⚠️ Yuklanmadi: <b>${tg.escHtml(c.title)}</b>\n${tg.escHtml(e.message)}`);
  }
}

// ---------------- stats ----------------
async function refreshStats() {
  if (!yt.connected()) return;
  try {
    const ch = await yt.channelInfo(true);
    if (ch) db.prepare('INSERT INTO channel_daily (day, subscribers, views, videos) VALUES (?, ?, ?, ?) ON CONFLICT(day) DO UPDATE SET subscribers=excluded.subscribers, views=excluded.views, videos=excluded.videos')
      .run(dayKey(), ch.subscribers, ch.views, ch.videos);
    const pub = db.prepare("SELECT id, youtube_id FROM clips WHERE status = 'published' AND youtube_id IS NOT NULL").all();
    const st = await yt.videoStats(pub.map((p) => p.youtube_id));
    const up = db.prepare('INSERT INTO stats_daily (day, clip_id, views, likes, comments) VALUES (?, ?, ?, ?, ?) ON CONFLICT(day, clip_id) DO UPDATE SET views=excluded.views, likes=excluded.likes, comments=excluded.comments');
    for (const p of pub) { const s = st[p.youtube_id]; if (!s) continue;
      updateRow('clips', p.id, { ...s, stats_at: Date.now() }); up.run(dayKey(), p.id, s.views, s.likes, s.comments); }
  } catch (e) { log('Statistika yangilanmadi: ' + e.message, 'warn'); }
}

// ---------------- sources (auto-watch channels) ----------------
function normalizeSourceUrl(url) {
  url = String(url).trim().replace(/\/+$/, '');
  if (/youtube\.com\/(@[\w.-]+|channel\/[\w-]+|c\/[\w-]+)$/.test(url)) return url + '/streams';
  if (/twitch\.tv\/[\w]+$/.test(url)) return url + '/videos?filter=archives';
  if (/kick\.com\/[\w-]+$/.test(url)) return url + '/videos';
  return url;
}
async function listSourceVideos(url) {
  const { out } = await run(YTDLP, ['--flat-playlist', '-I', '1:10', '-J', '--no-warnings', url], { timeoutMs: 120000 });
  const j = JSON.parse(out);
  return { name: j.channel || j.uploader || j.title, entries: (j.entries || []).map((e) => ({ id: e.id, title: e.title || '', duration: e.duration || null,
    url: e.url && /^https?:/.test(e.url) ? e.url : (e.webpage_url || (url.includes('youtube') ? 'https://www.youtube.com/watch?v=' + e.id : e.url)),
    live: e.live_status === 'is_live' || e.live_status === 'is_upcoming' })) };
}
async function addSource({ url, keyword = '', min_minutes = 20, permission = 0, credit = '' }) {
  url = normalizeSourceUrl(url);
  const { name, entries } = await listSourceVideos(url);
  // don't back-fill old videos: only streams that appear from now on
  const seen = entries.map((e) => e.id);
  const r = db.prepare('INSERT INTO sources (url, name, keyword, min_minutes, permission, credit, seen, last_checked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(url, name || url, keyword, min_minutes, permission ? 1 : 0, credit, JSON.stringify(seen), Date.now(), Date.now());
  log(`Manba qo'shildi: ${name || url}`);
  return { id: Number(r.lastInsertRowid), name, recent: entries.slice(0, 5) };
}
async function checkSources() {
  for (const s of db.prepare('SELECT * FROM sources WHERE active = 1').all()) {
    try {
      const { entries } = await listSourceVideos(s.url);
      const seen = new Set(JSON.parse(s.seen || '[]'));
      for (const e of entries) {
        if (seen.has(e.id) || e.live) continue; // live ones are picked up once they become a VOD
        seen.add(e.id);
        if (s.keyword && !e.title.toLowerCase().includes(s.keyword.toLowerCase())) continue;
        if (e.duration && e.duration < s.min_minutes * 60) continue;
        const r = addJob(e.url, s.id, { title: e.title, author: s.credit || s.name });
        if (!r.duplicate) await tg.notifyAdmins(`🆕 ${tg.escHtml(s.name)}: yangi stream topildi\n<b>${tg.escHtml(e.title)}</b>\nNavbatga qo'shildi (#${r.id})`);
      }
      db.prepare('UPDATE sources SET seen = ?, last_checked = ? WHERE id = ?').run(JSON.stringify([...seen].slice(-300)), Date.now(), s.id);
    } catch (e) { log(`Manba tekshirilmadi (${s.name}): ${e.message}`, 'warn'); }
  }
}

// ---------------- loops ----------------
let wake = null;
const kick = () => { if (wake) wake(); };
async function workerLoop() {
  // jobs interrupted by a restart go back to the queue
  db.prepare("UPDATE jobs SET status = 'queued' WHERE status IN ('downloading','analyzing','rendering')").run();
  db.prepare("UPDATE clips SET status = 'approved' WHERE status = 'uploading'").run();
  for (;;) {
    db.prepare("UPDATE jobs SET status = 'queued' WHERE status = 'waiting' AND updated_at < ?").run(Date.now() - 30 * 60000);
    const job = db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1").get();
    if (!job) { await new Promise((r) => { wake = r; setTimeout(r, 30000); }); continue; }
    try { await processJob(job); }
    catch (e) {
      if (e.waitLive) { setJob(job.id, { status: 'waiting', step: e.message }); continue; }
      setJob(job.id, { status: 'failed', error: e.message, step: 'Xato' });
      log(`#${job.id} xato: ${e.message}`, 'error');
      await tg.notifyAdmins(`⚠️ #${job.id} ishlanmadi: ${tg.escHtml(e.message)}`);
    }
  }
}
async function uploaderLoop() {
  for (;;) {
    try {
      if (yt.connected()) {
        const s = getSettings();
        const today = db.prepare("SELECT COUNT(*) n FROM clips WHERE published_at >= ?").get(Date.parse(dayKey() + 'T00:00:00Z') - TZ_OFFSET).n;
        const c = today < s.dailyLimit && db.prepare("SELECT * FROM clips WHERE status = 'approved' AND (scheduled_at IS NULL OR scheduled_at <= ?) ORDER BY scheduled_at LIMIT 1").get(Date.now());
        if (c) { await uploadClip(parseClip(c)); continue; }
      }
    } catch (e) { log('Yuklovchi xatosi: ' + e.message, 'error'); }
    await sleep(60000);
  }
}
function start() {
  workerLoop();
  uploaderLoop();
  const every = (ms, fn) => { const tick = () => fn().catch((e) => log(e.message, 'warn')).finally(() => setTimeout(tick, ms)); setTimeout(tick, 15000); };
  every(20 * 60000, checkSources);
  every(3 * 3600000, refreshStats);
}

module.exports = { start, addJob, addSource, checkSources, scheduleClip, refreshStats, announceClip, chooseMoments, normalizeSourceUrl, kick };

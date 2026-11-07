// The whole factory: download -> find highlights -> AI rank + metadata -> edit -> approve -> scheduled upload -> stats.
const fs = require('fs');
const path = require('path');
const { db, getSettings, log, parseClip, updateRow } = require('./db');
const { WORK_DIR, OUT_DIR, YTDLP, DATA_DIR } = require('./config');
// YouTube cookies (Netscape cookies.txt) uploaded in the web app: needed for age-restricted videos and when
// YouTube asks servers to "sign in to confirm you're not a bot"
const COOKIES = path.join(DATA_DIR, 'cookies.txt');
// yt-dlp rewrites the cookie file it is given, so it gets a copy and the uploaded file stays intact
function ytArgs() {
  // optional proxy (a residential proxy gets past YouTube's block on data-centre IPs), e.g. http://user:pass@host:port
  const proxy = process.env.YTDLP_PROXY ? ['--proxy', process.env.YTDLP_PROXY] : [];
  if (!fs.existsSync(COOKIES)) return proxy;
  const copy = path.join(DATA_DIR, 'cookies.run.txt'); fs.copyFileSync(COOKIES, copy);
  return [...proxy, '--cookies', copy];
}
// videos uploaded straight from the phone/computer (no YouTube download at all)
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
function saveCookies(text) {
  text = String(text || '').replace(/\r/g, '');
  const lines = text.split('\n').filter((l) => l.split('\t').length >= 7);
  if (!lines.length) throw new Error('Bu cookies.txt emas. "Get cookies.txt LOCALLY" kengaytmasi bilan Netscape formatida eksport qiling');
  if (!lines.some((l) => /youtube\.com|google\.com/.test(l))) throw new Error('Faylda youtube.com cookies yo\'q. YouTube sahifasida turib eksport qiling');
  fs.writeFileSync(COOKIES, (text.startsWith('# Netscape') ? '' : '# Netscape HTTP Cookie File\n') + text, { mode: 0o600 });
  log(`YouTube cookies yuklandi (${lines.length} ta)`);
  return lines.length;
}
// turn yt-dlp's long English errors into something actionable
function explainYtdlp(e) {
  const m = e.message;
  const why = ((m.match(/ERROR:[^|]*/) || [''])[0].replace(/^ERROR:\s*(\[\w+\]\s*[\w-]+:\s*)?/, '').split('. ')[0] || '').slice(0, 140);
  const wrap = (txt) => new Error(txt + (why ? ` (YouTube: ${why})` : ''));
  if (/confirm your age|age-restricted|Sign in to confirm|not a bot|cookies/i.test(m))
    return wrap(fs.existsSync(COOKIES)
      ? 'YouTube kirishni talab qildi, cookies eskirgan bo\'lishi mumkin: Sozlamalar → 🍪 YouTube cookies ni yangilang'
      : 'YouTube serverni bloklayapti (bot tekshiruvi yoki 18+): cookies.txt faylini botga yuboring yoki Sozlamalar → 🍪 YouTube cookies, keyin "Qayta urinish"');
  if (/Private video|members-only|Join this channel/i.test(m)) return wrap('Video yopiq yoki faqat a\'zolar uchun');
  if (/is not available|Video unavailable/i.test(m)) return wrap('Video mavjud emas yoki o\'chirilgan');
  return e;
}
const { run, sleep, fmtTime, dayKey, TZ_OFFSET } = require('./util');
const { findHighlights } = require('./analyze');
const render = require('./render');
const subs = require('./subtitles');
const ai = require('./ai');
const yt = require('./youtube');
const tg = require('./telegram');

// ---------------- jobs ----------------
function normalizeVideoUrl(url) { return String(url).trim(); }
function addJob(url, sourceId = null, meta = {}) {
  url = normalizeVideoUrl(url);
  if (!/^(https?:\/\/|upload:)/.test(url)) throw new Error('Havola noto\'g\'ri');
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

const BLOCKED = /confirm your age|Sign in to confirm|not a bot|cookies/i;
// YouTube sometimes blocks the default web client from data-centre IPs but lets other official clients through
const ALT_CLIENTS = ['--extractor-args', 'youtube:player_client=tv,web_safari,mweb'];
async function ytdlp(args, opts, state) {
  try { return await run(YTDLP, [...ytArgs(), ...(state.alt ? ALT_CLIENTS : []), ...args], opts); }
  catch (e) {
    if (state.alt || !BLOCKED.test(e.message)) throw explainYtdlp(e);
    state.alt = true;
    try { return await run(YTDLP, [...ytArgs(), ...ALT_CLIENTS, ...args], opts); } catch (e2) { throw explainYtdlp(e2); }
  }
}

async function download(job, dir, quality) {
  if (job.url.startsWith('upload:')) {
    const f = path.join(UPLOAD_DIR, path.basename(job.url.slice(7)));
    if (!fs.existsSync(f)) throw new Error('Yuklangan fayl topilmadi, qaytadan yuklang');
    const dest = path.join(dir, 'source' + (path.extname(f) || '.mp4'));
    fs.renameSync(f, dest);
    const title = (job.title || path.basename(f)).replace(/^\d+-/, '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
    const meta = { title, description: '', tags: [], categories: [], channel: '', duration: null, chapters: [] };
    setJob(job.id, { title, meta });
    return { file: dest, meta, transcript: '' };
  }
  const state = {};
  const { out } = await ytdlp(['--dump-single-json', '--no-playlist', '--no-warnings', job.url], { timeoutMs: 120000 }, state);
  const meta = JSON.parse(out);
  if (meta.is_live || meta.live_status === 'is_live' || meta.live_status === 'is_upcoming') {
    const e = new Error('Efir hali tugamagan — tugagach avtomatik qayta urinadi'); e.waitLive = true; throw e; }
  // what the AI needs to understand the video
  const keep = { title: meta.title, description: String(meta.description || '').slice(0, 5000), tags: (meta.tags || []).slice(0, 40),
    categories: meta.categories || [], channel: meta.channel || meta.uploader, duration: meta.duration, language: meta.language,
    chapters: (meta.chapters || []).slice(0, 60).map((c) => ({ start_time: c.start_time, title: c.title })) };
  setJob(job.id, { title: meta.title, author: meta.uploader || meta.channel, author_url: meta.uploader_url || meta.channel_url,
    video_id: meta.id, duration: meta.duration || null, meta: keep });
  const tmpl = path.join(dir, 'source.%(ext)s');
  await ytdlp(['-f', `bv*[height<=${quality}][ext=mp4]+ba[ext=m4a]/bv*[height<=${quality}]+ba/b[height<=${quality}]/b`,
    '--merge-output-format', 'mp4', '--no-playlist', '--no-part', '--concurrent-fragments', '4', '--newline', '-o', tmpl, job.url], {
    onLine: (l) => { const m = l.match(/\[download\]\s+([\d.]+)%/); if (m) setJob(job.id, { progress: Number(m[1]) / 100 }); },
  }, state);
  const file = fs.readdirSync(dir).find((f) => f.startsWith('source.') && /\.(mp4|mkv|webm)$/.test(f));
  if (!file) throw new Error('Video yuklab olinmadi');
  const transcript = await fetchTranscript(job.url, dir, state);
  return { file: path.join(dir, file), meta: keep, transcript };
}

// YouTube's own captions (manual or auto) as plain text — cheap way for the AI to "hear" the whole video
async function fetchTranscript(url, dir, state) {
  try {
    await ytdlp(['--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', 'en.*,ru.*,uz.*,.*-orig', '--sub-format', 'vtt',
      '--no-playlist', '--no-warnings', '-o', path.join(dir, 'subs.%(ext)s'), url], { timeoutMs: 120000 }, state);
  } catch (e) { return ''; }
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('subs.') && f.endsWith('.vtt'));
  // prefer the original-language track, then English
  const pick = files.find((f) => /-orig\.vtt$/.test(f)) || files.find((f) => /\.en/.test(f)) || files[0];
  if (!pick) return '';
  const lines = []; let last = '';
  for (let l of fs.readFileSync(path.join(dir, pick), 'utf8').split('\n')) {
    l = l.replace(/<[^>]+>/g, '').trim();
    if (!l || /-->|^WEBVTT|^Kind:|^Language:|^\d+$/.test(l) || l === last) continue;
    lines.push(l); last = l;
  }
  const text = lines.join(' ');
  // long streams: keep the start, middle and end so the AI sees the whole arc
  if (text.length <= 14000) return text;
  const k = 4600; const mid = Math.floor(text.length / 2);
  return `${text.slice(0, k)} … ${text.slice(mid - k / 2, mid + k / 2)} … ${text.slice(-k)}`;
}

// choose final moments: AI score (if any) + loudness score, then fit into the target length
function chooseMoments(candidates, aiRes, settings) {
  const maxAudio = Math.max(...candidates.map((c) => c.score), 0.001);
  const byIdx = new Map((aiRes?.moments || []).map((m) => [m.index, m]));
  const scored = candidates.map((c, i) => {
    const a = byIdx.get(i);
    const final = a ? (a.score / 10) * 0.7 + (c.score / maxAudio) * 0.3 : c.score / maxAudio;
    return { ...c, final: Number(final.toFixed(3)), caption: a?.caption || '', shortTitle: a?.short_title || '', emoji: a?.emoji || '', aiScore: a?.score ?? null };
  }).filter((c) => c.aiScore === null || c.aiScore >= 3).sort((a, b) => b.final - a.final);
  const picked = []; let total = 0;
  for (const c of scored) {
    if (picked.length >= settings.highlightCount) break;
    if (total + (c.end - c.start) > settings.targetMinutes * 60 * 1.15 && picked.length >= 3) break;
    picked.push(c); total += c.end - c.start;
  }
  return { picked, ranked: scored };
}

function creditLine(job) { return job.author ? `🎬 Original video: ${job.author}${job.url ? ' — ' + job.url : ''}` : ''; }

async function processJob(job) {
  const settings = getSettings();
  const dir = path.join(WORK_DIR, String(job.id)); fs.mkdirSync(dir, { recursive: true });
  const outDir = path.join(OUT_DIR, String(job.id)); fs.mkdirSync(outDir, { recursive: true });

  setJob(job.id, { status: 'downloading', step: 'Yuklab olinmoqda', progress: 0, error: null });
  const { file: src, meta, transcript } = await download(job, dir, settings.quality);
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
    // frames spread over the whole video, so the AI understands what it is, not just the loud bits
    const overview = [];
    for (let k = 1; k <= 8; k++) overview.push(await render.grabFrame(src, (info.duration * k) / 9, path.join(dir, `ov${k}.jpg`)));
    // public YouTube video, not too long: Gemini can watch the whole thing itself (fewer frames per second for long ones)
    const isYT = /youtube\.com|youtu\.be/.test(job.url) && !!job.video_id;
    const youtube = isYT && info.duration <= settings.aiWatchMaxMinutes * 60
      ? { url: `https://www.youtube.com/watch?v=${job.video_id}`, fps: info.duration <= 3600 ? 0.5 : 0.2 } : null;
    aiRes = await ai.rankAndDescribe({ candidates: cands, source: job, settings, context: { meta, transcript, overview, youtube } });
    if (aiRes) setJob(job.id, { step: `AI: ${aiRes.provider === 'gemini' ? 'Gemini' : 'Claude'}` });
    candidates.length = cands.length;
  }
  const tpl = ai.templateMeta({ source: job, settings, count: settings.highlightCount, meta });
  const video = aiRes?.video || tpl.video;
  setJob(job.id, { meta: { ...meta, subject: video.subject, summary: video.summary } });
  const hashtags = (video.hashtags || []).map((h) => '#' + String(h).replace(/[^\p{L}\p{N}_]/gu, '')).filter((h) => h.length > 1);
  const { picked } = chooseMoments(candidates, aiRes, settings);
  const long = aiRes?.long || tpl.long;
  const tags = [...(long.tags || []), video.subject, ...settings.defaultTags].filter(Boolean);
  const created = [];
  const status = settings.autoPublish ? 'approved' : 'draft';
  const ins = db.prepare(`INSERT INTO clips (job_id, kind, file, thumb, segments, duration, score, title, description, tags, thumb_text, status, privacy, created_at, category)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '${String(video.categoryId || '24').replace(/\D/g, '')}')`);

  setJob(job.id, { status: 'rendering', step: 'Montaj qilinmoqda', progress: 0 });
  const totalSteps = (settings.makeLong ? 1 : 0) + (settings.makeShorts ? Math.min(settings.shortsPerVideo, picked.length) : 0) || 1;
  let done = 0;
  if (settings.makeLong && picked.length >= 3) {
    const out = path.join(outDir, 'compilation.mp4');
    await render.renderCompilation(src, picked, out, dir, (p) => setJob(job.id, { progress: (done + p) / totalSteps }), { effects: settings.effects });
    const ordered = [...picked].sort((a, b) => a.start - b.start);
    let t = 0; const chapters = ordered.map((s, i) => { const line = `${fmtTime(t)} ${s.caption || (settings.language === 'uz' ? 'Lahza #' : 'Moment #') + (i + 1)}`; t += s.end - s.start; return line; });
    const description = [long.description, hashtags.length ? '\n' + hashtags.join(' ') : '', settings.language === 'uz' ? '⏱ Taym-kodlar:' : settings.language === 'ru' ? '⏱ Таймкоды:' : '⏱ Chapters:', ...chapters, '', creditLine(job), '', settings.descriptionFooter].filter((x) => x !== undefined).join('\n');
    const best = picked[0];
    const thumb = path.join(outDir, 'compilation.jpg');
    await render.renderThumbnail(src, best.peak - 1, long.thumb_text, thumb, dir, { accent: settings.accent, badge: video.badge || '' });
    const r = ins.run(job.id, 'long', out, thumb, JSON.stringify(ordered), t, best.final, long.title, description, JSON.stringify(tags), long.thumb_text, status, settings.privacy, Date.now());
    created.push(Number(r.lastInsertRowid)); done++;
  }
  if (settings.makeShorts) {
    for (let i = 0; i < Math.min(settings.shortsPerVideo, picked.length); i++) {
      const s = picked[i]; const title = s.shortTitle || tpl.shortTitle(i);
      const out = path.join(outDir, `short_${i + 1}.mp4`); const thumb = path.join(outDir, `short_${i + 1}.jpg`);
      const words = settings.subtitles ? await subs.transcribe(src, s.start, Math.min(58, s.end - s.start), dir, { model: settings.whisperModel, lang: settings.subtitleLang, to: settings.language === 'en' ? 'en' : '' }) : [];
      await render.renderShort(src, s, out, dir, { words, accent: settings.accent, style: settings.subtitleStyle, emoji: s.emoji, effects: settings.effects });
      await render.grabFrame(out, 1.5, thumb, 540);
      const description = [title, '', creditLine(job), '', ['#shorts', ...hashtags].join(' ')].join('\n');
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
      try { vid = await yt.upload({ file: c.file, title: c.title, description: c.description, tags: c.tags, privacy: c.privacy || settings.privacy, language: settings.language, categoryId: c.category || '24' }); }
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
  const { out } = await run(YTDLP, [...ytArgs(), '--flat-playlist', '-I', '1:10', '-J', '--no-warnings', url], { timeoutMs: 120000 }).catch((e) => { throw explainYtdlp(e); });
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

module.exports = { COOKIES, UPLOAD_DIR, saveCookies, start, addJob, addSource, checkSources, scheduleClip, refreshStats, announceClip, chooseMoments, normalizeSourceUrl, kick };

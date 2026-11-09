// The whole factory: download -> find highlights -> AI rank + metadata -> edit -> approve -> scheduled upload -> stats.
const fs = require('fs');
const path = require('path');
const { db, getSettings, log, parseClip, updateRow } = require('./db');
const { WORK_DIR, OUT_DIR, YTDLP, DATA_DIR, FFMPEG } = require('./config');
// YouTube cookies (Netscape cookies.txt) uploaded in the web app: needed for age-restricted videos and when
// YouTube asks servers to "sign in to confirm you're not a bot"
const COOKIES = path.join(DATA_DIR, 'cookies.txt');
// yt-dlp rewrites the cookie file it is given, so it gets a copy and the uploaded file stays intact
const COOKIES_RUN = path.join(DATA_DIR, 'cookies.run.txt');
const LOGIN_COOKIES = ['SID', '__Secure-1PSID', '__Secure-3PSID', 'LOGIN_INFO', 'SAPISID'];
const hasLogin = (text) => { const names = new Set(String(text).split('\n').map((l) => l.split('\t')[5])); return LOGIN_COOKIES.some((n) => names.has(n)); };
// proxy for YouTube (Web App → Sozlamalar → YouTube proxy, or YTDLP_PROXY env). YouTube blocks data-centre IPs
// (Railway, AWS…) with "Sign in to confirm you're not a bot"; downloader bots get past it with residential proxies.
const proxyUrl = () => require('./db').getSecret('ytProxy') || process.env.YTDLP_PROXY || '';
function normalizeProxy(u) {
  u = String(u || '').trim();
  if (!u) return '';
  // host:port:user:pass (how many shops hand them out) -> http://user:pass@host:port
  const parts = u.split(':');
  if (!/^\w+:\/\//.test(u) && parts.length === 4) u = `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
  else if (!/^\w+:\/\//.test(u)) u = 'http://' + u;
  const x = new URL(u);
  if (!/^(https?|socks5h?|socks4a?):$/.test(x.protocol) || !x.hostname || !x.port) throw new Error('Proxy formati: http://user:parol@host:port yoki host:port:user:parol');
  return u;
}
// a proxy works if YouTube gives a public video's formats through it without the bot check
async function testProxy(u) {
  const t0 = Date.now();
  const { out } = await run(YTDLP, ['--proxy', u, '-J', '--skip-download', '--no-warnings', '--socket-timeout', '20', 'https://www.youtube.com/watch?v=jNQXAC9IVRw'], { timeoutMs: 90000 })
    .catch((e) => { throw new Error(/not a bot|Sign in/i.test(e.message) ? 'Bu proxy\'ni ham YouTube bloklayapti (data-markaz IP). Rezidensial/mobil proxy kerak'
      : /407|Proxy Authentication/i.test(e.message) ? 'Proxy login/parol noto\'g\'ri' : /timed out|Unable to connect|Connection refused|Tunnel/i.test(e.message) ? 'Proxy\'ga ulanib bo\'lmadi' : e.message.slice(-200)); });
  const j = JSON.parse(out);
  const best = Math.max(0, ...(j.formats || []).map((f) => f.height || 0));
  return { ok: true, ms: Date.now() - t0, best };
}
function setProxy(u) { require('./db').setSecret('ytProxy', u || null); log(u ? 'YouTube proxy saqlandi' : 'YouTube proxy o\'chirildi'); }
function ytArgs(useCookies = true, warp = false) {
  // optional proxy (a residential proxy gets past YouTube's block on data-centre IPs), e.g. http://user:pass@host:port
  const px = proxyUrl() || (warp ? require('./warp').url() : ''); const proxy = px ? ['--proxy', px] : [];
  if (!useCookies || !fs.existsSync(COOKIES)) return proxy;
  fs.copyFileSync(COOKIES, COOKIES_RUN);
  return [...proxy, '--cookies', COOKIES_RUN];
}
// YouTube rotates session cookies; yt-dlp writes the new ones into the file it was given. Keep them,
// otherwise the saved cookies go stale and YouTube asks to "sign in" again.
function keepRotatedCookies() {
  try {
    if (!fs.existsSync(COOKIES_RUN) || !fs.existsSync(COOKIES)) return;
    const t = fs.readFileSync(COOKIES_RUN, 'utf8');
    if (hasLogin(t) && t !== fs.readFileSync(COOKIES, 'utf8')) fs.writeFileSync(COOKIES, t, { mode: 0o600 });
  } catch (e) { /* keep the old file */ }
}
let cookieAlertAt = 0;
async function runYt(args, opts) {
  try { return await run(YTDLP, args, opts); }
  catch (e) {
    // cookies are there but YouTube still wants a sign-in: the session is dead, tell the owner once a day
    if (fs.existsSync(COOKIES) && /Sign in to confirm|not a bot/i.test(e.message) && Date.now() - cookieAlertAt > 86400000) {
      cookieAlertAt = Date.now();
      tg.notifyAdmins('🍪 YouTube cookies ishlamay qoldi (YouTube yana "bot emasligingizni tasdiqlang" deyapti).\n\n' +
        'Yangi cookies oling va shu botga yuboring: /cookies — yo\'riqnoma.\n<b>Muhim:</b> eksportdan keyin inkognito oynani darhol yoping va bu akkaunt bilan boshqa joyda YouTube ochmang.').catch(() => {});
    }
    throw e;
  } finally { keepRotatedCookies(); }
}
// downloaded/uploaded source videos are kept a few days so "Qayta tayyorlash" (re-render) is instant
const SOURCES_DIR = path.join(DATA_DIR, 'sources');
const SOURCE_DAYS = 3;
function keptSource(jobId) {
  const f = path.join(SOURCES_DIR, `${jobId}.mp4`), j = path.join(SOURCES_DIR, `${jobId}.json`);
  return fs.existsSync(f) && fs.existsSync(j) ? { file: f, info: JSON.parse(fs.readFileSync(j, 'utf8')) } : null;
}
function removeKeptSource(jobId) { for (const e of ['mp4', 'json']) fs.rmSync(path.join(SOURCES_DIR, `${jobId}.${e}`), { force: true }); }
function cleanOldSources() {
  if (!fs.existsSync(SOURCES_DIR)) return;
  for (const f of fs.readdirSync(SOURCES_DIR)) {
    const p = path.join(SOURCES_DIR, f);
    if (Date.now() - fs.statSync(p).mtimeMs > SOURCE_DAYS * 86400000) fs.rmSync(p, { force: true });
  }
}
// videos uploaded straight from the phone/computer (no YouTube download at all)
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
// one copy of the database a day (settings, YouTube/AI keys, clip history), the last 7 kept
function backupDb() {
  try {
    const dir = path.join(DATA_DIR, 'backup'); fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `lahza-${dayKey()}.db`);
    if (fs.existsSync(f)) return;
    db.exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`);
    for (const old of fs.readdirSync(dir).filter((x) => /^lahza-.*\.db$/.test(x)).sort().slice(0, -7)) fs.rmSync(path.join(dir, old), { force: true });
  } catch (e) { log('Baza nusxasi olinmadi: ' + e.message.slice(0, 120), 'warn'); }
}
// Disk hygiene. Clip files are only needed until they are on YouTube (plus a few days to re-check them):
//  - published clips: video + preview deleted after keepClipDays (the thumbnail and the YouTube link stay)
//  - rejected clips: everything after 3 days
//  - forgotten uploads and work folders of jobs that are not running: after 3 days
function cleanOldFiles() {
  const s = getSettings(); const DAY = 86400000; const now = Date.now(); let freed = 0;
  const rm = (f) => { try { if (f && fs.existsSync(f)) { freed += fs.statSync(f).size; fs.rmSync(f, { force: true }); } } catch (e) {} };
  const prev = (f) => (f ? f.replace(/\.mp4$/i, '') + '.preview.mp4' : null);
  for (const c of db.prepare("SELECT id, file FROM clips WHERE status = 'published' AND published_at < ? AND file IS NOT NULL").all(now - (s.keepClipDays || 7) * DAY)) {
    rm(c.file); rm(prev(c.file));
  }
  for (const c of db.prepare("SELECT id, file, thumb FROM clips WHERE status = 'rejected' AND created_at < ?").all(now - 3 * DAY)) {
    rm(c.file); rm(prev(c.file)); rm(c.thumb);
  }
  const old = (p) => { try { return now - fs.statSync(p).mtimeMs > 3 * DAY; } catch (e) { return false; } };
  if (fs.existsSync(UPLOAD_DIR)) {
    const inUse = new Set(db.prepare("SELECT url FROM jobs WHERE status IN ('queued','downloading','analyzing','rendering','waiting') AND url LIKE 'upload:%'").all().map((j) => j.url.slice(7)));
    for (const f of fs.readdirSync(UPLOAD_DIR)) if (!inUse.has(f) && old(path.join(UPLOAD_DIR, f))) rm(path.join(UPLOAD_DIR, f));
  }
  if (fs.existsSync(WORK_DIR)) {
    const active = new Set(db.prepare("SELECT id FROM jobs WHERE status IN ('queued','downloading','analyzing','rendering','waiting')").all().map((j) => String(j.id)));
    for (const d of fs.readdirSync(WORK_DIR)) { const p = path.join(WORK_DIR, d); if (!active.has(d) && old(p)) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} } }
  }
  if (freed > 50 * 1048576) log(`Disk tozalandi: ${Math.round(freed / 1048576)} MB bo'shatildi (eski kliplar)`);
  return freed;
}
function saveCookies(text) {
  text = String(text || '').replace(/\r/g, '');
  const lines = text.split('\n').filter((l) => l.split('\t').length >= 7);
  if (!lines.length) throw new Error('Bu cookies.txt emas. "Get cookies.txt LOCALLY" kengaytmasi bilan Netscape formatida eksport qiling');
  // must be exported on youtube.com while signed in: needs YouTube-domain lines and a login cookie
  if (!lines.some((l) => /(^|\s|\.)youtube\.com\t/.test(l)))
    throw new Error('Faylda youtube.com cookies yo\'q — boshqa sahifada eksport qilingan. youtube.com sahifasida turib Export qiling (fayl nomi www.youtube.com_cookies.txt bo\'ladi)');
  if (!hasLogin(lines.join('\n')))
    throw new Error('Bu cookies akkauntga kirilmagan holda olingan. youtube.com da Sign in qiling (tepada avatar chiqsin), keyin Export qiling');
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
      ? 'YouTube bu cookies\'ni endi qabul qilmayapti (Google sessiyani bekor qilgan — server IP\'si o\'zgarganda shunday bo\'ladi). Doimiy yechim: Sozlamalar → YouTube proxy. Hozircha: yangi cookies yuboring yoki videoni downloader botdan shu botga forward qiling'
      : 'YouTube serverni bloklayapti (bot tekshiruvi): doimiy yechim — Sozlamalar → YouTube proxy. Yoki cookies.txt yuboring, yoki videoni downloader botdan shu botga forward qiling');
  if (/HTTP Error 403|Forbidden/i.test(m)) return wrap('YouTube yuqori sifatdagi videoni berishni rad etdi (403), barcha HD usullar sinaldi. Variantlar: 10-20 daqiqadan keyin "Qayta urinish"; cookies\'ni yangilash; videoni 📁 fayl qilib yuklash; yoki Sozlamalar → "Past sifatga ruxsat" (360p)');
  if (/Private video|members-only|Join this channel/i.test(m)) return wrap('Video yopiq yoki faqat a\'zolar uchun');
  if (/is not available|Video unavailable/i.test(m)) return wrap('Video mavjud emas yoki o\'chirilgan');
  return e;
}
const { run, sleep, fmtTime, dayKey, TZ_OFFSET } = require('./util');
const { findHighlights, storyParts, storyAfter, pickSegments, camReaction } = require('./analyze');
const render = require('./render');
const subs = require('./subtitles');
const ai = require('./ai');
const yt = require('./youtube');
const tg = require('./telegram');
const style = require('./style');

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
const lastProgress = new Map();
function redoJob(id) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job) throw new Error('Topilmadi');
  if (['downloading', 'analyzing', 'rendering'].includes(job.status)) throw new Error('Hozir ishlanmoqda');
  for (const c of db.prepare("SELECT * FROM clips WHERE job_id = ? AND status NOT IN ('published','uploading')").all(id))
    for (const f of [c.file, c.thumb]) if (f) fs.rmSync(f, { force: true });
  db.prepare("DELETE FROM clips WHERE job_id = ? AND status NOT IN ('published','uploading')").run(id);
  if (job.url.startsWith('upload:') && !keptSource(id)) throw new Error('Yuklangan faylning nusxasi saqlanmagan (3 kundan eski) — videoni qaytadan yuklang');
  updateRow('jobs', id, { status: 'queued', error: null, progress: 0, step: 'Qayta tayyorlash', updated_at: Date.now() });
  log(`#${id} qayta tayyorlanmoqda`);
  kick();
}
const setJob = (id, patch) => {
  // progress-only updates arrive many times a second from ffmpeg/yt-dlp: write at most ~1/s or per 1%
  if (Object.keys(patch).length === 1 && 'progress' in patch) {
    const prev = lastProgress.get(id) || { t: 0, p: -1 };
    if (Date.now() - prev.t < 1000 && Math.abs(patch.progress - prev.p) < 0.01) return;
    lastProgress.set(id, { t: Date.now(), p: patch.progress });
  }
  updateRow('jobs', id, { ...patch, updated_at: Date.now() });
};

const BLOCKED = /confirm your age|Sign in to confirm|not a bot|cookies/i;
// YouTube sometimes blocks the default web client from data-centre IPs but lets other official clients through
const ALT_CLIENTS = ['--extractor-args', 'youtube:player_client=tv,web_safari,mweb'];
// Cookies only when YouTube insists: every use of the session from this server's IP makes Google more likely to
// kill it (it already sees the IP change on each deploy). Order: no cookies -> cookies -> cookies + other clients.
// state remembers what worked so the following calls for the same video go straight there.
async function ytdlp(args, opts, state) {
  const tries = [];
  if (!state.cookies) tries.push({ c: false, alt: false });
  if (fs.existsSync(COOKIES)) tries.push({ c: true, alt: false });
  tries.push({ c: fs.existsSync(COOKIES), alt: true });
  // still blocked and no proxy of your own: the same once more through Cloudflare WARP (free, often let through)
  if (!proxyUrl() && require('./warp').available()) {
    tries.push({ c: false, alt: false, w: true });
    if (fs.existsSync(COOKIES)) tries.push({ c: true, alt: false, w: true });
    tries.push({ c: fs.existsSync(COOKIES), alt: true, w: true });
  }
  let last;
  for (const t of tries) {
    if (state.alt && !t.alt) continue;
    if (state.warp && !t.w) continue;
    try {
      const r = await runYt([...ytArgs(t.c, t.w), ...(t.alt ? ALT_CLIENTS : []), ...args], opts);
      if (t.w && !state.warp) log('YouTube: Cloudflare WARP orqali o\'tildi');
      state.cookies = t.c; state.alt = t.alt; state.warp = !!t.w;
      return r;
    } catch (e) { last = e; if (!BLOCKED.test(e.message)) throw explainYtdlp(e); }
  }
  throw explainYtdlp(last);
}

async function download(job, dir, quality, allowLow = false) {
  const kept = keptSource(job.id);
  if (kept) {
    const dest = path.join(dir, 'source.mp4'); fs.renameSync(kept.file, dest);
    log(`#${job.id}: saqlangan manba ishlatildi (qayta yuklab olinmadi)`);
    try { fs.writeFileSync(path.join(dir, 'resume.json'), JSON.stringify({ file: 'source.mp4', meta: kept.info.meta, transcript: kept.info.transcript || '' })); } catch (e) {}
    return { file: dest, meta: kept.info.meta, transcript: kept.info.transcript || '' };
  }
  // interrupted run (restart / new deploy): the source is still in the work folder -> no second download
  const rs = path.join(dir, 'resume.json');
  if (fs.existsSync(rs)) {
    try { const r = JSON.parse(fs.readFileSync(rs, 'utf8'));
      if (r.file && fs.existsSync(path.join(dir, r.file)) && fs.statSync(path.join(dir, r.file)).size > 1000) {
        log(`#${job.id}: manba qayta yuklab olinmadi (ish papkasida bor)`);
        return { file: path.join(dir, r.file), meta: r.meta, transcript: r.transcript || '' }; } } catch (e) { /* download again */ }
  }
  const remember = (res) => { try { fs.writeFileSync(rs, JSON.stringify({ file: path.basename(res.file), meta: res.meta, transcript: res.transcript })); } catch (e) {} return res; };
  if (job.url.startsWith('upload:')) {
    const f = path.join(UPLOAD_DIR, path.basename(job.url.slice(7)));
    if (!fs.existsSync(f)) throw new Error('Yuklangan fayl topilmadi, qaytadan yuklang');
    const dest = path.join(dir, 'source' + (path.extname(f) || '.mp4'));
    fs.renameSync(f, dest);
    const title = (job.title || path.basename(f)).replace(/^\d+-/, '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
    const meta = { title, description: '', tags: [], categories: [], channel: '', duration: null, chapters: [] };
    setJob(job.id, { title, meta });
    return remember({ file: dest, meta, transcript: '' });
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
  // YouTube often answers 403 for the media of one client while another works: try several ways, best quality first
  const fmt = `bv*[height<=${quality}][ext=mp4]+ba[ext=m4a]/bv*[height<=${quality}]+ba/b[height<=${quality}]/b`;
  const common = ['--merge-output-format', 'mp4', '--no-playlist', '--no-part', '--newline', '--retries', '5', '--fragment-retries', '10',
    '--extractor-retries', '3', '-o', tmpl, job.url];
  const strategies = [
    { name: 'standart', args: ['-f', fmt] },
    { name: 'TV/Safari/mobil klient', args: ['--extractor-args', 'youtube:player_client=tv,web_safari,mweb', '-f', fmt] },
    { name: 'web_embedded klient', args: ['--extractor-args', 'youtube:player_client=web_embedded,tv', '-f', fmt] },
    ...(allowLow ? [{ name: '360p bir faylli format (past sifat)', args: ['-f', '18/b[height<=480]/b'] }] : []),
  ];
  const progress = (l) => { const m = l.match(/\[download\]\s+([\d.]+)%/); if (m) setJob(job.id, { progress: Number(m[1]) / 100 }); };
  let lastErr = null;
  for (const st of strategies) {
    for (const f of fs.readdirSync(dir)) if (f.startsWith('source.')) fs.rmSync(path.join(dir, f), { force: true });
    try {
      try { await runYt([...ytArgs(state.cookies !== false, state.warp), ...st.args, ...common], { onLine: progress }); }
      catch (e) {
        // the info call passed without cookies but the media is refused: once more with them
        if (state.cookies === false && fs.existsSync(COOKIES) && BLOCKED.test(e.message)) { state.cookies = true; await runYt([...ytArgs(true, state.warp), ...st.args, ...common], { onLine: progress }); }
        else throw e;
      }
      if (st !== strategies[0]) log(`#${job.id}: video "${st.name}" usuli bilan yuklab olindi`);
      lastErr = null; break;
    } catch (e) {
      lastErr = e;
      if (!/HTTP Error 403|Forbidden|confirm your age|Sign in to confirm|not a bot|Requested format is not available|nsig|signature/i.test(e.message)) break;
      log(`#${job.id}: "${st.name}" usuli ishlamadi (${(e.message.match(/ERROR:[^|]*/) || [''])[0].slice(0, 90)}), keyingisi sinalmoqda`, 'warn');
    }
  }
  if (lastErr) throw explainYtdlp(lastErr);
  const file = fs.readdirSync(dir).find((f) => f.startsWith('source.') && /\.(mp4|mkv|webm)$/.test(f));
  if (!file) throw new Error('Video yuklab olinmadi');
  const transcript = await fetchTranscript(job.url, dir, state);
  return remember({ file: path.join(dir, file), meta: keep, transcript });
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
    return { ...c, final: Number(final.toFixed(3)), caption: a?.caption || '', shortTitle: a?.short_title || '', emoji: a?.emoji || '', meme: a?.meme || '', aiScore: a?.score ?? null };
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

// everything that is expensive to find out about a source (loudness/motion scan, the AI listening to the audio, webcam,
// reactions, the AI ranking). Its result is saved in the job's work folder, so a restart in the middle of a job
// (a new deploy) continues from the montage instead of spending the time and the AI quota again.
async function analyzeSource(job, src, dir, settings, meta, transcript) {
  setJob(job.id, { status: 'analyzing', step: 'Qiziq lahzalar qidirilmoqda', progress: 0 });
  const hl = await findHighlights(src, { count: settings.highlightCount, before: settings.clipBefore, after: settings.clipAfter },
    (p) => setJob(job.id, { progress: p }));
  const { info, score } = hl; let candidates = hl.candidates;
  setJob(job.id, { duration: info.duration });

  // 1) the AI listens to the whole audio and marks laughs, hype, jokes, surprises (also quiet ones) -> they lift the score
  if (info.duration > 75 && info.hasAudio && settings.aiListen && settings.useAI && ai.providers().includes('gemini')) {
    try {
      setJob(job.id, { step: 'AI butun ovozni tinglamoqda', progress: 0 });
      const chunks = []; const CH = 2400;
      for (let off = 0; off < info.duration - 20; off += CH) {
        const f = path.join(dir, `listen_${off}.ogg`); const d = Math.min(CH, info.duration - off);
        await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(off), '-t', String(d), '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '16k', f]);
        chunks.push({ file: f, offset: off, dur: d });
      }
      const heard = await ai.listenMoments(chunks, { title: job.title || meta.title, settings });
      for (const c of chunks) fs.rmSync(c.file, { force: true });
      if (heard.length) {
        for (const h of heard) {
          const w = (h.intensity / 10) * 2.5, pk = Math.round(h.peak);
          for (let k = -4; k <= 4; k++) { const i = pk + k; if (i >= 0 && i < score.length) score[i] += w * (1 - Math.abs(k) / 5); }
        }
        candidates = pickSegments(score, { count: Math.max(settings.highlightCount * 2, 12), before: settings.clipBefore, after: settings.clipAfter,
          duration: info.duration, skipStart: Math.min(60, info.duration * 0.05), skipEnd: Math.min(30, info.duration * 0.03) });
        for (const c of candidates) {
          const h = heard.filter((x) => Math.abs(x.peak - c.peak) <= 8).sort((a, b) => b.intensity - a.intensity)[0];
          if (h) { c.heard = h; c.peak = Math.round(h.peak); c.start = Math.max(0, c.peak - settings.clipBefore); c.end = Math.min(info.duration, c.peak + settings.clipAfter); }
        }
        log(`#${job.id}: AI ovozda ${heard.length} ta qiziq joy eshitdi (${heard.filter((h) => h.intensity >= 7).length} tasi kuchli)`);
      }
    } catch (e) { log('AI tinglash ishlamadi: ' + e.message.slice(0, 200), 'warn'); }
  }
  if (!candidates.length) throw new Error('Qiziq lahza topilmadi (video juda jim yoki qisqa)');

  // 2) streamer webcam: found once, then how strongly the streamer reacts around each candidate
  let facecam = null;
  if (settings.makeShorts && settings.facecamLayout) {
    setJob(job.id, { step: 'Webkamera qidirilmoqda' });
    facecam = await subs.detectFacecam(src);
    if (facecam) log(`#${job.id}: webkamera topildi (${facecam.w}×${facecam.h} @${facecam.x},${facecam.y}, chegara ${JSON.stringify(facecam.border)}, ${facecam.hits}/${facecam.samples} kadrda) — Shorts tepada kamera, pastda o'yin`);
  }
  if (facecam && settings.camReactions && info.duration > 75) {
    setJob(job.id, { step: 'Streamer reaksiyalari o\'lchanmoqda' });
    for (const c of candidates.slice(0, 24)) {
      try { const r = await camReaction(src, facecam, c.peak, info.duration); c.reaction = r.reaction; c.score = +(c.score + r.reaction * 0.5).toFixed(3); } catch (e) {}
    }
    candidates.sort((a, b) => b.score - a.score);
  }

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
    // a niche style guide learned earlier for this kind of video (same game/topic in the title) guides the moment choice
    const g0 = settings.learnStyle ? style.guess([meta.title, job.title, settings.game, ...(meta.tags || [])].filter(Boolean).join(' ')) : null;
    aiRes = await ai.rankAndDescribe({ candidates: cands, source: job, settings, context: { meta, transcript, overview, youtube, styleRules: style.rulesText(g0) } });
    if (aiRes) setJob(job.id, { step: `AI: ${aiRes.provider === 'gemini' ? 'Gemini' : 'Claude'}` });
    candidates.length = cands.length;
  }
  return { info, score, candidates, aiRes, facecam };
}

async function processJob(job) {
  const settings = getSettings();
  const dir = path.join(WORK_DIR, String(job.id)); fs.mkdirSync(dir, { recursive: true });
  const outDir = path.join(OUT_DIR, String(job.id)); fs.mkdirSync(outDir, { recursive: true });

  setJob(job.id, { status: 'downloading', step: 'Yuklab olinmoqda', progress: 0, error: null });
  const { file: src, meta, transcript } = await download(job, dir, settings.quality, settings.lowQualityFallback);
  job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
  const source = job.source_id ? db.prepare('SELECT * FROM sources WHERE id = ?').get(job.source_id) : null;
  if (source?.credit) job.author = source.credit;

  const ckFile = path.join(dir, 'analysis.json');
  let an = null, resumed = false;
  try { if (fs.existsSync(ckFile)) { an = JSON.parse(fs.readFileSync(ckFile, 'utf8')); resumed = true; } } catch (e) { an = null; }
  if (resumed) {
    log(`#${job.id}: uzilgan joydan davom etmoqda (tahlil saqlangan)`);
    // drafts of the interrupted run are made again; clips already approved / uploaded are kept and not re-rendered
    for (const c of db.prepare("SELECT * FROM clips WHERE job_id = ? AND status = 'draft'").all(job.id)) for (const f of [c.thumb]) if (f) fs.rmSync(f, { force: true });
    db.prepare("DELETE FROM clips WHERE job_id = ? AND status = 'draft'").run(job.id);
  } else {
    an = await analyzeSource(job, src, dir, settings, meta, transcript);
    try { fs.writeFileSync(ckFile, JSON.stringify(an)); } catch (e) { /* only a shortcut */ }
  }
  const { info, score, aiRes, facecam } = an; const candidates = an.candidates;
  const kept = (file) => resumed && !!db.prepare("SELECT id FROM clips WHERE job_id = ? AND file = ? AND status IN ('published','uploading','approved')").get(job.id, file);
  const tpl = ai.templateMeta({ source: job, settings, count: settings.highlightCount, meta });
  const video = aiRes?.video || tpl.video;
  setJob(job.id, { meta: { ...meta, subject: video.subject, summary: video.summary } });
  // editor skill: how the viral Shorts of this niche are edited (learned once a week per niche) -> this job's editing
  if (settings.learnStyle && settings.makeShorts && video.subject) {
    setJob(job.id, { step: 'Mashhur Shorts montaji o\'rganilmoqda' });
    try {
      const g = await style.learn(video.subject);
      const o = style.overrides(g);
      if (Object.keys(o).length) { Object.assign(settings, o); log(`#${job.id}: "${g.niche}" uslubi qo'llandi — ${JSON.stringify(o)}`); }
    } catch (e) { log('Uslub qo\'llanmadi: ' + e.message.slice(0, 160), 'warn'); }
  }
  const hashtags = (video.hashtags || []).map((h) => '#' + String(h).replace(/[^\p{L}\p{N}_]/gu, '')).filter((h) => h.length > 1);
  const { picked } = chooseMoments(candidates, aiRes, settings);
  const long = aiRes?.long || tpl.long;
  const tags = [...(long.tags || []), video.subject, ...settings.defaultTags].filter(Boolean);
  const created = [];
  // a watched channel without the "author allowed clipping" mark never publishes by itself: its clips wait for you
  const needsOk = !!(source && !source.permission);
  const status = settings.autoPublish && !needsOk ? 'approved' : 'draft';
  const ins = db.prepare(`INSERT INTO clips (job_id, kind, file, thumb, segments, duration, score, title, description, tags, thumb_text, status, privacy, created_at, category)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '${String(video.categoryId || '24').replace(/\D/g, '')}')`);

  // end card: the connected channel's name (or the brand / settings name) and its logo if a brand kit exists
  let channelName = settings.channelName;
  try { const ch = yt.connected() ? await yt.channelInfo() : null; if (ch?.title) channelName = ch.title; } catch (e) {}
  const brandLogo = path.join(require('./config').DATA_DIR, 'brand', 'logo.png');
  const logo = fs.existsSync(brandLogo) ? brandLogo : null;
  const card = { channel: channelName, language: settings.language, logo, custom: settings.subscribeCustom, key: settings.gsKey };
  const outro = settings.outro ? { ...card, topic: video.subject, accent: settings.accent } : null;
  setJob(job.id, { status: 'rendering', step: 'Montaj qilinmoqda', progress: 0 });
  const totalSteps = (settings.makeLong ? 1 : 0) + (settings.makeShorts ? Math.min(settings.shortsPerVideo, picked.length) : 0) || 1;
  let done = 0;
  if (settings.makeLong && picked.length >= 3 && !kept(path.join(outDir, 'compilation.mp4'))) {
    const out = path.join(outDir, 'compilation.mp4');
    await render.renderCompilation(src, picked, out, dir, (p) => setJob(job.id, { progress: (done + p) / totalSteps }), { effects: settings.effects, emojis: settings.emojis, zoom: settings.zoom, outro });
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
      const m = picked[i]; const title = m.shortTitle || tpl.shortTitle(i);
      const out = path.join(outDir, `short_${i + 1}.mp4`); const thumb = path.join(outDir, `short_${i + 1}.jpg`);
      if (kept(out)) { done++; continue; }
      const peak = m.peak ?? (m.start + m.end) / 2;
      const asr = { model: settings.asrModel, lang: settings.subtitleLang, to: settings.language,
        context: { title: meta.title || job.title, subject: video.subject, terms: [...new Set([video.subject, ...(meta.tags || []), ...(video.hashtags || [])].filter(Boolean))] } };
      let s, words;
      if (settings.storyShorts && info.duration > 150 && score) {
        // story Short: the build-up before the climax with the dead time cut out (jump cuts), ending on the reaction
        // with the subscribe card at the end, keep ~3.5 s more after the climax so the reaction isn't covered
        // the story: from where it starts (setup the AI heard, else up to 2.5 min back) through the key moment and on
        // to what happens after it (reaction, aftermath) — not just the loud second
        const target = Math.max(30, settings.shortTarget || 55);
        const h = m.heard;
        let after = h && h.end > peak ? Math.min(25, Math.max(6, h.end - peak)) : storyAfter(score, peak, info.duration);
        after = Math.min(after + (settings.outro ? 3.5 : 0), info.duration - peak);
        const lookback = h && h.start < peak ? Math.min(150, Math.max(40, peak - h.start + 20)) : 150;
        const parts = storyParts(score, peak, info.duration, { target, after, lookback });
        const base = parts[0].start;
        const rel = parts.map((p) => ({ start: +(p.start - base).toFixed(2), end: +(p.end - base).toFixed(2) }));
        let acc = 0, peakOut = 0;
        for (const p of parts) { if (peak >= p.start && peak <= p.end) { peakOut = acc + (peak - p.start); break; } acc += p.end - p.start; }
        s = { ...m, start: base, end: parts[parts.length - 1].end, peak, peakOut, parts: rel };
        words = settings.subtitles ? await subs.transcribe(src, base, s.end - base, dir, { ...asr, select: rel.map((p) => `between(t,${p.start.toFixed(2)},${p.end.toFixed(2)})`).join('+') }) : [];
        log(`#${job.id}: hikoyali Shorts — ${parts.length} bo'lak, ${Math.round(rel.reduce((t, p) => t + p.end - p.start, 0))} s`);
      } else {
        // single moment: listen to a wider stretch, then pick a hook start + clean end from the speech
        // one continuous piece that still tells the story: setup (where the AI heard it start, else ~15 s before),
        // the key moment, and what happens after it; at least 30 s
        const h = m.heard; const target = Math.max(30, settings.shortTarget || 55);
        const after = (h && h.end > peak ? Math.min(25, Math.max(6, h.end - peak)) : (score ? storyAfter(score, peak, info.duration) : 10)) + (settings.outro ? 3.5 : 0);
        const before = Math.max(h && h.start < peak ? Math.min(40, peak - h.start) : 15, 30 - after);
        const w0 = Math.max(0, peak - before - 3), wDur = Math.min(info.duration - w0, before + after + 9);
        const wide = settings.subtitles ? await subs.transcribe(src, w0, wDur, dir, asr) : [];
        const abs = wide.map((w) => ({ ...w, start: w.start + w0, end: w.end + w0 }));
        const win = info.duration <= 75 ? { start: m.start, end: m.end, peak }
          : shortWindow({ ...m, peak }, abs, info.duration, { before, after, min: Math.min(30, target), max: Math.max(target, 58) });
        log(`#${job.id}: Shorts — yaxlit ${Math.round(win.end - win.start)} s (${Math.round(peak - win.start)} s oldin, ${Math.round(win.end - peak)} s keyin)`);
        s = { ...m, ...win };
        words = abs.filter((w) => w.end > s.start && w.start < s.end).map((w) => ({ ...w, start: +(w.start - s.start).toFixed(2), end: +(w.end - s.start).toFixed(2) }));
      }
      await render.renderShort(src, s, out, dir, { words, accent: settings.accent, style: settings.subtitleStyle, emoji: s.emoji, effects: settings.effects, emojis: settings.emojis, facecam,
        zoom: settings.zoom, endCard: settings.outro ? card : null, meme: settings.memes ? s.meme : '', climaxFull: settings.climaxFull });
      // hook: open on the climax for ~1.3 s, then the story from its start
      let hooked = false;
      if (settings.hook) {
        const backup = out + '.nohook.mp4'; fs.copyFileSync(out, backup);
        try { hooked = await render.addHook(out, s.peakOut ?? ((s.peak ?? s.start) - s.start), dir); } catch (e) { log('Hook qo\'shilmadi: ' + e.message.slice(0, 160), 'warn'); }
        if (hooked && !(await playable(out))) { fs.copyFileSync(backup, out); hooked = false; log(`#${job.id}: hook'li video buzuq chiqdi, hook'siz varianti olindi`, 'warn'); }
        fs.rmSync(backup, { force: true });
      }
      if (!(await playable(out))) throw new Error(`Shorts #${i + 1} fayli buzuq chiqdi (disk to'lgan bo'lishi mumkin) — "Qayta tayyorlash" ni bosing`);
      // last check: every phone must play it (fixes the format if anything is off; logs what was wrong)
      try { const d = await render.diagnose(out); if (d.problems.length) log(`#${job.id}: Shorts #${i + 1} tekshiruvi: ${d.problems.join(', ')}`, 'warn');
        if (await render.makeCompatible(out)) log(`#${job.id}: Shorts #${i + 1} telefonlar uchun qayta kodlandi`); } catch (e) { log('Moslik tekshiruvi: ' + e.message.slice(0, 160), 'warn'); }
      render.makePreview(out).catch(() => {}); // light copy for watching in the app
      await render.grabFrame(out, hooked ? 0.7 : 1.5, thumb, 540);
      const description = [title, '', creditLine(job), '', ['#shorts', ...hashtags].join(' ')].join('\n');
      const shortDur = s.parts ? s.parts.reduce((t, p) => t + p.end - p.start, 0) : s.end - s.start;
      const r = ins.run(job.id, 'short', out, thumb, JSON.stringify([s]), Math.min(60, shortDur + (hooked ? 1.3 : 0)), s.final,
        (title + ' #shorts').slice(0, 100), description, JSON.stringify([...tags.slice(0, 10), 'shorts']), '', status, settings.privacy, Date.now());
      created.push(Number(r.lastInsertRowid)); done++;
      setJob(job.id, { progress: done / totalSteps });
    }
  }
  // keep the source for a few days for re-renders, drop the rest of the work dir
  try {
    fs.mkdirSync(SOURCES_DIR, { recursive: true });
    fs.renameSync(src, path.join(SOURCES_DIR, `${job.id}.mp4`));
    fs.writeFileSync(path.join(SOURCES_DIR, `${job.id}.json`), JSON.stringify({ meta, transcript }));
  } catch (e) { log('Manba saqlanmadi: ' + e.message, 'warn'); }
  fs.rmSync(dir, { recursive: true, force: true });
  setJob(job.id, { status: 'done', step: `${created.length} ta klip tayyor`, progress: 1 });
  log(`#${job.id} tayyor: ${created.length} ta klip (${job.title || job.url})`);
  if (needsOk) for (const id of created) updateRow('clips', id, { error: `"${source.name}" kanali uchun muallif ruxsati belgilanmagan. Ruxsat bo'lsa Manbalar'da "Ruxsat bor" ni bosing; bo'lmasa bu klipni yuklamang — mualliflik shikoyati (strike) kanalga zarar qiladi.` });
  if (settings.autoPublish && !needsOk) for (const id of created) scheduleClip(id);
  for (const id of created) await announceClip(id);
}

// a rendered file is usable: it opens, has a video stream and a real duration (not a cut-off write, e.g. a full disk)
async function playable(file) {
  try { const i = await require('./analyze').probe(file); return i.duration > 2 && i.width > 0; } catch (e) { return false; }
}
// Shorts window: start ~4 s before the peak (hook), cut points moved to pauses between sentences so nobody is cut
// mid-word, end after the sentence that follows the peak. words = absolute times (seconds in the source).
function shortWindow(seg, words, duration, { before = 4, after = 10, min = 12, max = 45 } = {}) {
  const peak = seg.peak ?? (seg.start + seg.end) / 2;
  let start = Math.max(0, peak - before), end = Math.min(duration, peak + after);
  if (words.length) {
    // start: the beginning of a phrase (a word after a >=0.35 s pause) closest to the planned start, within -2.5..+1 s
    let best = null;
    words.forEach((w, i) => {
      const gapBefore = i === 0 ? 9 : w.start - words[i - 1].end;
      if (gapBefore >= 0.35 && w.start >= start - 2.5 && w.start <= Math.min(start + 1, peak - 0.5)) {
        if (!best || Math.abs(w.start - start) < Math.abs(best - start)) best = w.start;
      }
    });
    if (best !== null) start = Math.max(0, best - 0.2);
    else { const inside = words.find((w) => w.start < start && w.end > start); if (inside) start = Math.max(0, inside.start - 0.2); }
    // end: the first sentence end / pause after the planned end (within +6 s), never mid-word
    const after_ = words.filter((w) => w.end >= end - 1);
    let cut = null;
    for (let i = 0; i < after_.length; i++) {
      const w = after_[i], next = after_[i + 1];
      if (/[.!?…]$/.test(w.word) || !next || next.start - w.end >= 0.5) { cut = w.end + 0.35; break; }
      if (w.end > end + 6) break;
    }
    if (cut !== null) end = cut;
    else { const inside = words.find((w) => w.start < end && w.end > end); if (inside) end = inside.end + 0.25; }
  }
  if (end - start < min) end = Math.min(duration, start + min);
  if (end - start > max) end = start + max;
  return { start: +start.toFixed(2), end: +Math.min(duration, end).toFixed(2), peak };
}

async function announceClip(id) {
  const c = parseClip(db.prepare('SELECT * FROM clips WHERE id = ?').get(id)); if (!c) return;
  const kind = c.kind === 'short' ? '📱 Shorts' : '🎬 Kompilyatsiya';
  const when = c.scheduled_at ? `\n🗓 Yuklanadi: ${new Date(c.scheduled_at + TZ_OFFSET).toISOString().slice(5, 16).replace('T', ' ')}` : '';
  const caption = `${kind} • ${fmtTime(c.duration)}\n<b>${tg.escHtml(c.title)}</b>${when}${c.status === 'draft' && c.error ? '\n\n⚠️ ' + tg.escHtml(c.error) : ''}`;
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
// whole-channel refresh: every video's views/likes/comments + channel totals. Throttled so the stats page can ask often.
let channelRefresh = { at: 0, running: null, error: null };
function refreshChannel(maxAgeMs = 60000) {
  if (!yt.connected()) return Promise.resolve(false);
  if (channelRefresh.running) return channelRefresh.running;
  if (Date.now() - channelRefresh.at < maxAgeMs) return Promise.resolve(false);
  channelRefresh.running = (async () => {
    try {
      const { channel, videos } = await yt.channelVideos();
      const up = db.prepare(`INSERT INTO channel_videos (id, title, thumb, published, views, likes, comments, duration, privacy, updated) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, thumb=excluded.thumb, views=excluded.views, likes=excluded.likes, comments=excluded.comments,
        duration=excluded.duration, privacy=excluded.privacy, updated=excluded.updated`);
      const now = Date.now();
      db.exec('BEGIN');
      for (const v of videos) up.run(v.id, v.title, v.thumb, v.published, v.views, v.likes, v.comments, v.duration, v.privacy, now);
      // videos deleted on YouTube disappear from the list
      if (videos.length) db.prepare(`DELETE FROM channel_videos WHERE updated < ?`).run(now);
      db.exec('COMMIT');
      if (channel) db.prepare('INSERT INTO channel_daily (day, subscribers, views, videos) VALUES (?, ?, ?, ?) ON CONFLICT(day) DO UPDATE SET subscribers=excluded.subscribers, views=excluded.views, videos=excluded.videos')
        .run(dayKey(), channel.subscribers, channel.views, channel.videos);
      // keep the clips table (Lahza uploads) in sync too
      const byId = new Map(videos.map((v) => [v.id, v]));
      for (const c of db.prepare("SELECT id, youtube_id FROM clips WHERE youtube_id IS NOT NULL").all()) {
        const v = byId.get(c.youtube_id); if (v) updateRow('clips', c.id, { views: v.views, likes: v.likes, comments: v.comments, stats_at: now });
      }
      channelRefresh.error = null; channelRefresh.at = Date.now();
      return true;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (er) {}
      channelRefresh.error = e.message; channelRefresh.at = Date.now();
      log('Kanal statistikasi yangilanmadi: ' + e.message, 'warn');
      return false;
    } finally { channelRefresh.running = null; }
  })();
  return channelRefresh.running;
}
const channelRefreshState = () => ({ at: channelRefresh.at, error: channelRefresh.error, running: !!channelRefresh.running });

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
// a YouTube channel is watched on two tabs: /videos (long uploads) and /streams (finished lives). The /shorts tab
// is never read, and anything under 3 minutes is skipped, so Shorts are never used as a source.
const ytChannelRe = /^(https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:@[\w.-]+|channel\/[\w-]+|c\/[\w-]+))(?:\/(?:streams|videos|featured|shorts))?$/;
function normalizeSourceUrl(url) {
  url = String(url).trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  const yt = url.match(ytChannelRe); if (yt) return yt[1];
  if (/twitch\.tv\/[\w]+$/.test(url)) return url + '/videos?filter=archives';
  if (/kick\.com\/[\w-]+$/.test(url)) return url + '/videos';
  return url;
}
async function listTab(url) {
  const { out } = await ytdlp(['--flat-playlist', '-I', '1:10', '-J', '--no-warnings', url], { timeoutMs: 120000 }, {});
  const j = JSON.parse(out);
  return { name: j.channel || j.uploader || j.title, entries: (j.entries || []).map((e) => ({ id: e.id, title: e.title || '', duration: e.duration || null,
    url: e.url && /^https?:/.test(e.url) ? e.url : (e.webpage_url || (url.includes('youtube') ? 'https://www.youtube.com/watch?v=' + e.id : e.url)),
    live: e.live_status === 'is_live' || e.live_status === 'is_upcoming',
    short: /\/shorts\//.test(e.url || '') || (e.duration && e.duration < 180) })) };
}
async function listSourceVideos(url) {
  const yt = url.match(ytChannelRe);
  if (!yt) return listTab(url);
  const base = yt[1]; let name = ''; const entries = []; const errs = [];
  for (const tab of ['/videos', '/streams']) {
    try { const r = await listTab(base + tab); name = name || r.name; for (const e of r.entries) if (!entries.some((x) => x.id === e.id)) entries.push(e); }
    catch (e) { errs.push(e); } // a channel without lives has no /streams tab
  }
  if (!entries.length && errs.length === 2) throw errs[0];
  return { name: (name || '').replace(/ - (Videos|Live)$/i, ''), entries };
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
      // sources added when only lives were watched: their older /videos uploads are not "new" — mark them seen once
      const norm = normalizeSourceUrl(s.url);
      if (norm !== s.url) {
        for (const e of entries) seen.add(e.id);
        db.prepare('UPDATE sources SET url = ?, seen = ?, last_checked = ? WHERE id = ?').run(norm, JSON.stringify([...seen].slice(-300)), Date.now(), s.id);
        continue;
      }
      for (const e of entries) {
        if (seen.has(e.id) || e.live) continue; // live ones are picked up once they become a VOD
        seen.add(e.id);
        if (e.short) continue; // Shorts are never used as a source
        if (s.keyword && !e.title.toLowerCase().includes(s.keyword.toLowerCase())) continue;
        if (e.duration && e.duration < s.min_minutes * 60) continue;
        const r = addJob(e.url, s.id, { title: e.title, author: s.credit || s.name });
        if (!r.duplicate) await tg.notifyAdmins(`🆕 ${tg.escHtml(s.name)}: yangi video topildi\n<b>${tg.escHtml(e.title)}</b>\nNavbatga qo'shildi (#${r.id})`);
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
        // an upload needs 1,650 quota units: if today's are spent, wait for the reset instead of failing the clip
        const c = today < s.dailyLimit && require('./quota').canUpload() && db.prepare("SELECT * FROM clips WHERE status = 'approved' AND (scheduled_at IS NULL OR scheduled_at <= ?) ORDER BY scheduled_at LIMIT 1").get(Date.now());
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
  every(10 * 60000, () => refreshChannel(5 * 60000));
  every(3600000, async () => { cleanOldSources(); cleanOldFiles(); backupDb(); });
  require('./growth').start(every);
}

module.exports = { cleanOldFiles, proxyUrl, normalizeProxy, testProxy, setProxy, redoJob, removeKeptSource, refreshChannel, channelRefreshState, COOKIES, UPLOAD_DIR, saveCookies, start, addJob, addSource, checkSources, scheduleClip, refreshStats, announceClip, chooseMoments, normalizeSourceUrl, kick };

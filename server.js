// Lahza — HTTP API + Telegram Web App + bot, all in one process.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./src/config');
const { db, getSettings, setSettings, log, parseClip, updateRow } = require('./src/db');
const pipeline = require('./src/pipeline');
const yt = require('./src/youtube');
const tg = require('./src/telegram');
const ai = require('./src/ai');
const brand = require('./src/brand');
const { run, dayKey, fmtTime } = require('./src/util');

const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.json': 'application/json' };

// ---------- sessions: uid.exp.signature ----------
const sign = (s) => crypto.createHmac('sha256', cfg.SECRET).update(s).digest('base64url');
const makeToken = (uid) => { const body = `${uid}.${Date.now() + 30 * 86400000}`; return body + '.' + sign(body); };
function checkToken(t) {
  const [uid, exp, sig] = String(t || '').split('.');
  if (!uid || !sig || Number(exp) < Date.now()) return null;
  const good = sign(`${uid}.${exp}`);
  return good.length === sig.length && crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig)) ? uid : null;
}

const send = (res, code, data, headers = {}) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
};
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({}); } }); });

function serveFile(req, res, file, type) {
  fs.stat(file, (err, st) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const range = req.headers.range; const ct = type || TYPES[path.extname(file)] || 'application/octet-stream';
    if (range) { // video seeking in the preview player
      const [a, b] = range.replace(/bytes=/, '').split('-'); const start = Number(a) || 0; const end = b ? Number(b) : st.size - 1;
      res.writeHead(206, { 'content-type': ct, 'content-range': `bytes ${start}-${end}/${st.size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'content-type': ct, 'content-length': st.size, 'accept-ranges': 'bytes', 'cache-control': ct.startsWith('text/') ? 'no-cache' : 'max-age=300' });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- view models ----------
const clipView = (c) => { c = parseClip(c); if (!c) return null;
  return { ...c, file: undefined, thumb: undefined, hasThumb: !!c.thumb && fs.existsSync(c.thumb), hasFile: !!c.file && fs.existsSync(c.file),
    url: c.youtube_id ? (c.kind === 'short' ? 'https://youtube.com/shorts/' : 'https://youtu.be/') + c.youtube_id : null }; };
const jobView = (j) => ({ ...j, clips: db.prepare('SELECT COUNT(*) n FROM clips WHERE job_id = ?').get(j.id).n });
const count = (sql, ...a) => db.prepare(sql).get(...a).n;

async function overview() {
  let channel = null; try { channel = await yt.channelInfo(); } catch (e) { channel = { error: e.message }; }
  const todayStart = Date.parse(dayKey() + 'T00:00:00Z') - 5 * 3600000;
  const s = getSettings();
  return {
    channel, youtube: { configured: yt.configured(), connected: yt.connected(), canBrand: yt.canBrand() }, ai: ai.enabled(), bot: tg.enabled(),
    counts: {
      queue: count("SELECT COUNT(*) n FROM jobs WHERE status IN ('queued','downloading','analyzing','rendering','waiting')"),
      drafts: count("SELECT COUNT(*) n FROM clips WHERE status = 'draft'"),
      scheduled: count("SELECT COUNT(*) n FROM clips WHERE status IN ('approved','uploading')"),
      published: count("SELECT COUNT(*) n FROM clips WHERE status = 'published'"),
      todayUploads: count('SELECT COUNT(*) n FROM clips WHERE published_at >= ?', todayStart), dailyLimit: s.dailyLimit,
      views: db.prepare("SELECT COALESCE(SUM(views),0) n FROM clips WHERE status = 'published'").get().n,
      sources: count('SELECT COUNT(*) n FROM sources WHERE active = 1'),
    },
    active: db.prepare("SELECT * FROM jobs WHERE status IN ('downloading','analyzing','rendering') ORDER BY id LIMIT 3").all(),
    next: db.prepare("SELECT * FROM clips WHERE status = 'approved' ORDER BY scheduled_at LIMIT 3").all().map(clipView),
    logs: db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 15').all(),
  };
}

function stats(days) {
  const since = dayKey(Date.now() - (days - 1) * 86400000);
  // views gained per day = today's total - yesterday's total, per clip
  const rows = db.prepare('SELECT day, clip_id, views, likes FROM stats_daily WHERE day >= ? ORDER BY clip_id, day').all(dayKey(Date.now() - days * 86400000));
  const gained = {}; const last = {};
  for (const r of rows) {
    const prev = last[r.clip_id]; last[r.clip_id] = r;
    if (r.day < since) continue;
    gained[r.day] = (gained[r.day] || 0) + (prev ? Math.max(0, r.views - prev.views) : r.views);
  }
  const series = [];
  for (let i = days - 1; i >= 0; i--) { const d = dayKey(Date.now() - i * 86400000); series.push({ day: d, views: gained[d] || 0,
    uploads: count('SELECT COUNT(*) n FROM clips WHERE published_at >= ? AND published_at < ?', Date.parse(d + 'T00:00:00Z') - 18000000, Date.parse(d + 'T00:00:00Z') + 86400000 - 18000000) }); }
  const subs = db.prepare('SELECT day, subscribers FROM channel_daily WHERE day >= ? ORDER BY day').all(since);
  const byKind = db.prepare("SELECT kind, COUNT(*) videos, COALESCE(SUM(views),0) views, COALESCE(SUM(likes),0) likes FROM clips WHERE status = 'published' GROUP BY kind").all();
  const top = db.prepare("SELECT * FROM clips WHERE status = 'published' ORDER BY views DESC LIMIT 10").all().map(clipView);
  return { series, subs, byKind, top };
}

// ---------- API router ----------
async function api(req, res, url) {
  const p = url.pathname; const m = req.method;
  if (p === '/api/login' && m === 'POST') {
    const b = await readBody(req);
    const user = tg.verifyInitData(b.initData);
    if (user && tg.isAdmin(user.id)) return send(res, 200, { token: makeToken(user.id), name: user.first_name });
    if (cfg.WEBAPP_PASSWORD && b.password && b.password === cfg.WEBAPP_PASSWORD) return send(res, 200, { token: makeToken('web'), name: 'Admin' });
    if (user) return send(res, 403, { error: `Ruxsat yo'q. Telegram ID: ${user.id}. Uni ADMIN_IDS ga qo'shing.` });
    return send(res, 401, { error: 'Kirish uchun Telegram bot orqali oching yoki parol kiriting' });
  }
  const uid = checkToken((req.headers.authorization || '').replace(/^Bearer /, ''));
  if (!uid) return send(res, 401, { error: 'Sessiya tugadi' });
  const b = ['POST', 'PATCH', 'PUT'].includes(m) ? await readBody(req) : {};
  let mm;

  if (p === '/api/overview') return send(res, 200, await overview());
  if (p === '/api/jobs' && m === 'GET') return send(res, 200, db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 100').all().map(jobView));
  if (p === '/api/jobs' && m === 'POST') { try { return send(res, 200, pipeline.addJob(b.url)); } catch (e) { return send(res, 400, { error: e.message }); } }
  if ((mm = p.match(/^\/api\/jobs\/(\d+)\/retry$/)) && m === 'POST') { updateRow('jobs', +mm[1], { status: 'queued', error: null, progress: 0 }); pipeline.kick(); return send(res, 200, { ok: true }); }
  if ((mm = p.match(/^\/api\/jobs\/(\d+)$/)) && m === 'DELETE') {
    const j = db.prepare('SELECT status FROM jobs WHERE id = ?').get(+mm[1]);
    if (j && ['downloading', 'analyzing', 'rendering'].includes(j.status)) return send(res, 409, { error: 'Ishlanayotgan vazifani o\'chirib bo\'lmaydi' });
    for (const c of db.prepare("SELECT * FROM clips WHERE job_id = ? AND status != 'published'").all(+mm[1])) for (const f of [c.file, c.thumb]) if (f) fs.rmSync(f, { force: true });
    db.prepare("DELETE FROM clips WHERE job_id = ? AND status != 'published'").run(+mm[1]);
    db.prepare('DELETE FROM jobs WHERE id = ?').run(+mm[1]);
    return send(res, 200, { ok: true });
  }

  if (p === '/api/clips' && m === 'GET') {
    const st = url.searchParams.get('status');
    const rows = st ? db.prepare(`SELECT * FROM clips WHERE status IN (${st.split(',').map(() => '?').join(',')}) ORDER BY id DESC LIMIT 200`).all(...st.split(','))
      : db.prepare('SELECT * FROM clips ORDER BY id DESC LIMIT 200').all();
    return send(res, 200, rows.map(clipView));
  }
  if ((mm = p.match(/^\/api\/clips\/(\d+)$/))) {
    const id = +mm[1]; const c = db.prepare('SELECT * FROM clips WHERE id = ?').get(id);
    if (!c) return send(res, 404, { error: 'Topilmadi' });
    if (m === 'GET') return send(res, 200, { ...clipView(c), job: db.prepare('SELECT * FROM jobs WHERE id = ?').get(c.job_id) });
    if (m === 'PATCH') {
      const patch = {};
      if (typeof b.title === 'string') patch.title = b.title.slice(0, 100);
      if (typeof b.description === 'string') patch.description = b.description.slice(0, 4900);
      if (Array.isArray(b.tags)) patch.tags = yt.fitTags(b.tags);
      if (['public', 'unlisted', 'private'].includes(b.privacy)) patch.privacy = b.privacy;
      if (typeof b.thumb_text === 'string') patch.thumb_text = b.thumb_text.slice(0, 40);
      updateRow('clips', id, patch);
      return send(res, 200, clipView(db.prepare('SELECT * FROM clips WHERE id = ?').get(id)));
    }
  }
  if ((mm = p.match(/^\/api\/clips\/(\d+)\/(approve|reject|now|rethumb)$/)) && m === 'POST') {
    const id = +mm[1]; const c = parseClip(db.prepare('SELECT * FROM clips WHERE id = ?').get(id));
    if (!c) return send(res, 404, { error: 'Topilmadi' });
    if (mm[2] !== 'rethumb' && ['published', 'uploading'].includes(c.status)) return send(res, 409, { error: 'Klip allaqachon yuklangan' });
    if (mm[2] === 'approve') return send(res, 200, { scheduled_at: pipeline.scheduleClip(id) });
    if (mm[2] === 'now') return send(res, 200, { scheduled_at: pipeline.scheduleClip(id, true) });
    if (mm[2] === 'reject') { updateRow('clips', id, { status: 'rejected' }); return send(res, 200, { ok: true }); }
    // thumbnail text changed: redraw it from the compiled video
    if (c.kind !== 'long' || !c.file || !fs.existsSync(c.file)) return send(res, 400, { error: 'Prevyu faqat kompilyatsiya uchun' });
    const render = require('./src/render'); const s = getSettings();
    // the frame: peak of the best-scored moment, located inside the compiled video
    const best = c.segments.reduce((a, x) => ((x.final ?? 0) > (a.final ?? 0) ? x : a), c.segments[0] || {});
    let at = 1, acc = 0;
    for (const sg of c.segments) { if (sg === best) { at = acc + Math.max(0, sg.peak - sg.start - 1); break; } acc += sg.end - sg.start; }
    await render.renderThumbnail(c.file, at, b.text || c.thumb_text, c.thumb, path.dirname(c.thumb), { accent: s.accent, badge: s.game });
    if (b.text) updateRow('clips', id, { thumb_text: b.text });
    return send(res, 200, { ok: true });
  }

  if (p === '/api/stats') return send(res, 200, stats(Math.min(90, Math.max(7, Number(url.searchParams.get('days')) || 30))));
  if (p === '/api/stats/refresh' && m === 'POST') { await pipeline.refreshStats(); return send(res, 200, { ok: true }); }

  if (p === '/api/sources' && m === 'GET') return send(res, 200, db.prepare('SELECT id, url, name, keyword, min_minutes, permission, credit, active, last_checked FROM sources ORDER BY id DESC').all());
  if (p === '/api/sources' && m === 'POST') { try { return send(res, 200, await pipeline.addSource(b)); } catch (e) { return send(res, 400, { error: e.message.includes('UNIQUE') ? 'Bu manba allaqachon bor' : e.message }); } }
  if (p === '/api/sources/check' && m === 'POST') { pipeline.checkSources(); return send(res, 200, { ok: true }); }
  if ((mm = p.match(/^\/api\/sources\/(\d+)$/))) {
    if (m === 'DELETE') { db.prepare('DELETE FROM sources WHERE id = ?').run(+mm[1]); return send(res, 200, { ok: true }); }
    if (m === 'PATCH') {
      const patch = {};
      for (const k of ['keyword', 'credit']) if (typeof b[k] === 'string') patch[k] = b[k];
      for (const k of ['active', 'permission']) if (k in b) patch[k] = b[k] ? 1 : 0;
      if (b.min_minutes) patch.min_minutes = Number(b.min_minutes);
      updateRow('sources', +mm[1], patch); return send(res, 200, { ok: true });
    }
  }

  if (p === '/api/settings' && m === 'GET') return send(res, 200, getSettings());
  if (p === '/api/settings' && m === 'PATCH') { const clean = {}; for (const k of Object.keys(b)) if (!k.startsWith('_')) clean[k] = b[k]; return send(res, 200, setSettings(clean)); }
  if (p === '/api/brand' && m === 'GET') return send(res, 200, brand.get());
  if (p === '/api/brand' && m === 'PATCH') { try { return send(res, 200, await brand.update(b)); } catch (e) { return send(res, 400, { error: e.message }); } }
  if (p === '/api/brand/generate' && m === 'POST') return send(res, 200, await brand.generate({ hint: String(b.hint || '').slice(0, 300) }));
  if (p === '/api/brand/apply' && m === 'POST') {
    const k = brand.get(); if (!k) return send(res, 400, { error: 'Avval brend yarating' });
    try {
      const id = await yt.applyBranding({ description: k.description, keywords: k.keywords, bannerFile: b.banner !== false && k.hasBanner ? brand.files().banner : null });
      log('Kanalga banner, tavsif va kalit so\'zlar o\'rnatildi');
      return send(res, 200, { ok: true, studio: `https://studio.youtube.com/channel/${id}/editing/profile` });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === '/api/youtube/auth') {
    if (!yt.configured()) return send(res, 400, { error: 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET va PUBLIC_URL sozlanmagan' });
    return send(res, 200, { url: yt.authUrl() });
  }
  if (p === '/api/youtube/disconnect' && m === 'POST') { yt.disconnect(); log('YouTube kanal uzildi'); return send(res, 200, { ok: true }); }
  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/oauth/google/callback') {
      let msg;
      try {
        if (!yt.checkState(url.searchParams.get('state'))) throw new Error('Havola eskirgan, qaytadan urinib ko\'ring');
        if (url.searchParams.get('error')) throw new Error(url.searchParams.get('error'));
        const ch = await yt.finishAuth(url.searchParams.get('code'));
        msg = `✅ Kanal ulandi: ${ch?.title || ''}`;
        tg.notifyAdmins(`✅ YouTube kanal ulandi: <b>${tg.escHtml(ch?.title || '')}</b>`);
        // first connection: prepare the channel brand kit right away and send it to the bot
        if (!brand.get()) brand.generate().then(async (k) => {
          await tg.sendPhotoToAdmins(brand.files().banner, `🎨 Kanal brendi tayyor\n\n<b>Nom variantlari:</b> ${k.names.map(tg.escHtml).join(' · ')}\n<b>Username:</b> ${k.handles.map((h) => '@' + h).join(' · ')}\n\nPanel → ⚙️ → Kanal brendi: tahrirlash va kanalga o'rnatish`);
          await tg.sendPhotoToAdmins(brand.files().logo, 'Logo (800×800)');
        }).catch((e) => log('Brend yaratilmadi: ' + e.message, 'warn'));
      } catch (e) { msg = '❌ ' + e.message; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta name=viewport content="width=device-width"><body style="font:18px system-ui;background:#0d0f14;color:#fff;display:grid;place-items:center;height:90vh;text-align:center"><div>${msg.replace(/</g, '&lt;')}<p style="opacity:.6">Bu oynani yopib, Telegramga qayting.</p></div>`);
    }
    let mm;
    if ((mm = url.pathname.match(/^\/media\/clip\/(\d+)\/(video|thumb)$/))) {
      if (!checkToken(url.searchParams.get('t'))) { res.writeHead(401); return res.end(); }
      const c = db.prepare('SELECT file, thumb FROM clips WHERE id = ?').get(+mm[1]);
      if (!c) { res.writeHead(404); return res.end(); }
      return serveFile(req, res, mm[2] === 'video' ? c.file : c.thumb);
    }
    if ((mm = url.pathname.match(/^\/media\/brand\/(banner|logo)$/))) {
      if (!checkToken(url.searchParams.get('t'))) { res.writeHead(401); return res.end(); }
      return serveFile(req, res, brand.files()[mm[1]]);
    }
    const f = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!f.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    return serveFile(req, res, f);
  } catch (e) {
    log('HTTP xato: ' + e.message, 'error');
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
});

// ---------- bot commands ----------
const STATUS_UZ = { queued: '⏳ navbatda', downloading: '⬇️ yuklanmoqda', analyzing: '🔍 tahlil', rendering: '🎬 montaj', waiting: '🔴 efir tugashini kutmoqda', done: '✅ tayyor', failed: '⚠️ xato' };
const botHandlers = {
  async onLink(url) {
    try { const r = pipeline.addJob(url); return r.duplicate ? `Bu video allaqachon bor (#${r.id})` : `✅ Navbatga qo'shildi (#${r.id}). Tayyor bo'lganda kliplarni yuboraman.`; }
    catch (e) { return '⚠️ ' + e.message; }
  },
  async onCommand(cmd) {
    if (cmd === '/start') return { text: `<b>Lahza</b> — stream'lardan eng zo'r lahzalarni kesib, YouTube kanalingizga yuklaydi.\n\n` +
      `• Stream/video havolasini yuboring — men ishlayman\n• Kuzatiladigan kanallarni paneldagi <b>Manbalar</b> bo'limiga qo'shing\n• Tayyor kliplarni shu yerda tasdiqlaysiz`,
      extra: tg.webAppButton() ? { reply_markup: tg.webAppButton() } : {} };
    if (cmd === '/navbat') {
      const rows = db.prepare("SELECT * FROM jobs WHERE status NOT IN ('done') ORDER BY id DESC LIMIT 10").all();
      return rows.length ? rows.map((j) => `#${j.id} ${STATUS_UZ[j.status] || j.status} ${j.progress ? Math.round(j.progress * 100) + '%' : ''}\n${tg.escHtml((j.title || j.url).slice(0, 70))}`).join('\n\n') : 'Navbat bo\'sh';
    }
    if (cmd === '/kliplar') {
      const rows = db.prepare("SELECT id FROM clips WHERE status = 'draft' ORDER BY id LIMIT 5").all();
      if (!rows.length) return 'Tasdiq kutayotgan klip yo\'q';
      for (const r of rows) await pipeline.announceClip(r.id);
      return null;
    }
    if (cmd === '/stat') {
      const o = await overview(); const ch = o.channel;
      return `📊 <b>${tg.escHtml(ch?.title || 'Kanal ulanmagan')}</b>\n` + (ch && !ch.error ? `Obunachilar: ${ch.subscribers}\nKo'rishlar: ${ch.views}\nVideolar: ${ch.videos}\n` : '') +
        `\nYuklangan kliplar: ${o.counts.published}\nNavbatda: ${o.counts.queue}\nTasdiq kutmoqda: ${o.counts.drafts}\nRejada: ${o.counts.scheduled}\nBugun: ${o.counts.todayUploads}/${o.counts.dailyLimit}`;
    }
    if (cmd === '/yordam') return `1) Sozlamalarda YouTube kanalni ulang\n2) Stream havolasini yuboring yoki Manbalar'ga kanal qo'shing\n` +
      `3) Bot uzun videodan eng baland/harakatli lahzalarni topadi, AI ularni baholaydi\n4) Kompilyatsiya (10 daq) va Shorts'lar tayyorlanadi, prevyu, nom, tavsif, teglar avtomatik\n` +
      `5) ✅ bosing — belgilangan vaqtda kanalga chiqadi (yoki Sozlamalarda "Avto-nashr"ni yoqing)`;
    return 'Havola yuboring yoki /yordam';
  },
  async onCallback(data) {
    const [act, id] = data.split(':'); const c = db.prepare('SELECT status FROM clips WHERE id = ?').get(+id);
    if (!c) return 'Klip topilmadi';
    if (['published', 'uploading'].includes(c.status)) return 'Allaqachon yuklangan';
    if (act === 'ok') { const t = pipeline.scheduleClip(+id); return '✅ Rejalashtirildi: ' + new Date(t + 5 * 3600000).toISOString().slice(5, 16).replace('T', ' '); }
    if (act === 'now') { pipeline.scheduleClip(+id, true); return '🚀 Bir daqiqada yuklanadi'; }
    if (act === 'no') { updateRow('clips', +id, { status: 'rejected' }); return '❌ Rad etildi'; }
    return 'OK';
  },
};

async function checkTools() {
  for (const [name, bin, arg] of [['ffmpeg', cfg.FFMPEG, '-version'], ['yt-dlp', cfg.YTDLP, '--version']]) {
    try { await run(bin, [arg], { timeoutMs: 10000 }); } catch (e) { log(`${name} topilmadi — o'rnating (README ga qarang)`, 'error'); }
  }
  if (!cfg.FONT) log('Qalin shrift topilmadi: prevyu yozuvlari standart shriftda chiqadi (FONT_PATH ni sozlang)', 'warn');
  if (!ai.enabled()) log('ANTHROPIC_API_KEY yo\'q — nom/tavsif shablondan olinadi, lahzalar faqat ovoz/harakat bo\'yicha tanlanadi', 'warn');
  if (!cfg.PUBLIC_URL.startsWith('https://')) log('PUBLIC_URL https emas — Telegram Web App va YouTube ulash ishlamaydi', 'warn');
}

if (require.main === module) {
  server.listen(cfg.PORT, () => {
    log(`Lahza ishga tushdi: http://localhost:${cfg.PORT}`);
    checkTools();
    pipeline.start();
    tg.startPolling(botHandlers);
  });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { db.close(); } catch (e) {} process.exit(0); });
}
module.exports = { server, makeToken };

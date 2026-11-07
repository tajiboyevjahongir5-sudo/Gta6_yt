// Lahza Web App — vanilla JS, no build step.
const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready(); tg.expand();
  try { tg.setHeaderColor('#0f1012'); tg.setBackgroundColor('#0f1012'); tg.setBottomBarColor?.('#1a1a19'); } catch (e) {}
  // full screen on phones (Bot API 8.0+), and scrolling down must not close the app
  try { if (tg.isVersionAtLeast?.('8.0') && /android|ios/i.test(tg.platform) && !tg.isFullscreen) tg.requestFullscreen(); } catch (e) {}
  try { tg.disableVerticalSwipes?.(); } catch (e) {}
}
// no pinch / double-tap zoom
for (const ev of ['gesturestart', 'gesturechange']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
let lastTap = 0; document.addEventListener('touchend', (e) => { const n = Date.now(); if (n - lastTap < 300 && !e.target.closest('input,textarea,select,video')) e.preventDefault(); lastTap = n; }, { passive: false });
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('uz-UZ');
const num = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'K' : nf.format(n || 0));
const dur = (s) => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s % 60).padStart(2, '0'); };
const when = (t) => { if (!t) return ''; const d = new Date(t); const same = d.toDateString() === new Date().toDateString();
  return (same ? 'bugun ' : d.toLocaleDateString('uz-UZ', { day: 'numeric', month: 'short' }) + ' ') + d.toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' }); };
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'hozir' : m < 60 ? m + ' daq oldin' : m < 1440 ? Math.round(m / 60) + ' soat oldin' : Math.round(m / 1440) + ' kun oldin'; };
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 2600); }
const haptic = (k = 'light') => { try { tg?.HapticFeedback?.impactOccurred(k); } catch (e) {} };

// ---------- auth ----------
let token = localStorage.getItem('lahza_token') || '';
async function login(password) {
  const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData: tg?.initData || '', password }) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error);
  token = j.token; localStorage.setItem('lahza_token', token);
}
async function api(path, opts = {}) {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), opts.timeout || 25000);
  let r;
  try { r = await fetch(path, { ...opts, signal: ctl.signal, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body }); }
  catch (e) { throw new Error(e.name === 'AbortError' ? 'Server javob bermadi, qayta urinib ko\'ring' : 'Internet aloqasi yo\'q'); }
  finally { clearTimeout(to); }
  if (r.status === 401 && !opts.retried) { try { await login(); return api(path, { ...opts, retried: true }); } catch (e) { showLogin(e.message); throw e; } }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Xato ' + r.status);
  return j;
}
function showLogin(msg) {
  $('#view').innerHTML = `<div class="card"><h2>Kirish</h2><p class="muted small">${esc(msg || '')}</p>
    <label class="f">Parol (WEBAPP_PASSWORD)</label><input type="password" id="pw"><br><br><button class="btn primary" id="go">Kirish</button></div>`;
  $('#go').onclick = async () => { try { await login($('#pw').value); go(page); } catch (e) { toast(e.message); } };
}
const media = (id, kind) => `/media/clip/${id}/${kind}?t=${encodeURIComponent(token)}`;

// ---------- router ----------
let page = 'home', timer = null, busy = false;
const pages = { home, jobs, clips, stats, sources, settings };
// every render checks it is still the current page, so a slow answer can't overwrite the page you switched to
const here = (p) => page === p;
function go(p) {
  page = p; clearInterval(timer); closeSheet();
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.page === p));
  window.scrollTo(0, 0);
  $('#view').innerHTML = '<div class="empty"><span class="spin"></span></div>';
  pages[p]().catch((e) => { if (here(p) && !/Sessiya|Kirish|Ruxsat/.test(e.message)) $('#view').innerHTML = `<div class="empty">⚠️ ${esc(e.message)}<br><br><button class="btn sm" onclick="go('${p}')">Qayta urinish</button></div>`; });
}
$('#tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) { haptic(); go(b.dataset.page); } };
$('#btnSettings').onclick = () => go('settings');
const STATUS = { queued: ['Navbatda', ''], downloading: ['Yuklanmoqda', 'blue'], analyzing: ['Tahlil', 'blue'], rendering: ['Montaj', 'blue'],
  waiting: ['Efir tugashini kutmoqda', 'warn'], done: ['Tayyor', 'good'], failed: ['Xato', 'bad'],
  draft: ['Tasdiq kutmoqda', 'warn'], approved: ['Rejada', 'blue'], uploading: ['Yuklanmoqda', 'blue'], published: ['Kanalda', 'good'], rejected: ['Rad etilgan', ''] };
const pill = (s) => { const [t, c] = STATUS[s] || [s, '']; return `<span class="pill ${c}">${t}</span>`; };

// ---------- pages ----------
async function home() {
  const o = await api('/api/overview');
  if (!here('home')) return;
  $('#chName').textContent = o.channel?.title || 'kanal ulanmagan';
  $('#badgeDrafts').textContent = o.counts.drafts || '';
  const ch = o.channel && !o.channel.error ? o.channel : null;
  const warn = [];
  if (o.storage && !o.storage.persistent) warn.push('⚠️ <b>Railway Volume ulanmagan</b> — har deployda kanal ulanishi, kalitlar va kliplar o\'chib ketadi. Railway → servis → <b>Volume</b> qo\'shing, mount path: <b>/data</b>');
  const connectCta = !o.youtube.connected ? `<div class="card" style="text-align:center"><div style="font-size:30px">📺</div><b>YouTube kanalingizni ulang</b>
    <p class="muted small">Videolar shu kanalga yuklanadi. Ulanganda kanal uchun nom, username, tavsif, banner va logo tayyorlab beriladi.</p>
    <button class="btn primary" id="cta" style="width:100%">Kanalni ulash</button></div>` : '';
  if (!o.ai) warn.push('AI ulanmagan: videolar to\'liq tahlil qilinmaydi. <a href="#" data-go="settings" style="color:inherit">Bepul Gemini kalitini qo\'shing</a>');
  $('#view').innerHTML = `
    ${connectCta}${warn.map((w) => `<div class="warnbox">${w}</div>`).join('')}
    <div class="card"><div class="row"><input type="url" id="url" class="grow" placeholder="Stream yoki video havolasi (YouTube, Twitch, Kick)"><button class="btn primary" id="add">Qo'shish</button></div>
      <label class="btn" style="display:block;text-align:center;margin-top:8px;cursor:pointer">📁 Video faylini yuklash<input type="file" id="vfile" accept="video/*" hidden></label>
      <div id="upl" class="hidden"><div class="small muted" id="uplTxt" style="margin-top:8px"></div><div class="bar"><i id="uplBar" style="width:0"></i></div></div></div>
    <div class="grid">
      <div class="tile"><div class="v">${ch ? num(ch.subscribers) : '—'}</div><div class="l">Obunachilar</div></div>
      <div class="tile"><div class="v">${ch ? num(ch.views) : num(o.counts.views)}</div><div class="l">Jami ko'rishlar</div></div>
      <div class="tile"><div class="v">${o.counts.published}</div><div class="l">Yuklangan kliplar</div></div>
      <div class="tile"><div class="v">${o.counts.todayUploads}<span class="muted" style="font-size:15px">/${o.counts.dailyLimit}</span></div><div class="l">Bugun yuklandi</div></div>
      <div class="tile" data-go="jobs"><div class="v">${o.counts.queue}</div><div class="l">Navbatda ›</div></div>
      <div class="tile" data-go="clips"><div class="v">${o.counts.drafts}</div><div class="l">Tasdiq kutmoqda ›</div></div>
    </div>
    ${o.active.length ? `<h2>Hozir ishlanmoqda</h2>${o.active.map(jobCard).join('')}` : ''}
    <h2>Keyingi yuklashlar</h2>
    <div class="card list">${o.next.length ? o.next.map((c) => `<div class="it" data-clip="${c.id}"><img src="${media(c.id, 'thumb')}" alt=""><div class="grow"><div class="ellipsis">${esc(c.title)}</div><div class="muted small">${c.kind === 'short' ? 'Shorts' : 'Video'} • ${when(c.scheduled_at)}</div></div></div>`).join('') : '<div class="muted small">Rejada hech narsa yo\'q. Kliplarni tasdiqlang.</div>'}</div>
    <h2>So'nggi hodisalar</h2>
    <div class="card">${o.logs.map((l) => `<div class="log ${l.level}"><b>${ago(l.ts)}</b> · ${esc(l.msg)}</div>`).join('') || '<div class="muted small">Hali hech narsa yo\'q</div>'}</div>`;
  $('#add').onclick = addUrl;
  $('#vfile').onchange = (e) => uploadVideo(e.target.files[0]);
  if ($('#cta')) $('#cta').onclick = connectYouTube;
  bindCommon();
  timer = setInterval(() => page === 'home' && !uploading && !busy && !$('#url:focus') && (busy = true, home().finally(() => (busy = false))), 8000);
}
// streamed upload with progress (XHR gives upload progress, fetch doesn't)
let uploading = false;
function uploadVideo(file) {
  if (!file) return;
  uploading = true; $('#upl').classList.remove('hidden');
  const mb = (n) => (n / 1048576).toFixed(0);
  const x = new XMLHttpRequest();
  x.open('PUT', '/api/upload?name=' + encodeURIComponent(file.name));
  x.setRequestHeader('authorization', 'Bearer ' + token);
  x.upload.onprogress = (e) => { if (!e.lengthComputable) return; $('#uplBar').style.width = (e.loaded / e.total * 100) + '%';
    $('#uplTxt').textContent = `Yuklanmoqda: ${mb(e.loaded)} / ${mb(e.total)} MB — oynani yopmang`; };
  x.onload = () => { uploading = false; let j = {}; try { j = JSON.parse(x.responseText); } catch (er) {}
    if (x.status === 200) { haptic('medium'); toast('✅ Yuklandi, navbatga qo\'shildi #' + j.id); go('jobs'); }
    else { toast(j.error || 'Yuklashda xato'); $('#upl').classList.add('hidden'); } };
  x.onerror = () => { uploading = false; toast('Internet uzildi, qaytadan urinib ko\'ring'); $('#upl').classList.add('hidden'); };
  x.send(file);
}

async function addUrl() {
  const url = $('#url').value.trim(); if (!url) return;
  try { const r = await api('/api/jobs', { method: 'POST', body: { url } }); haptic('medium'); toast(r.duplicate ? 'Bu video allaqachon bor' : 'Navbatga qo\'shildi #' + r.id); $('#url').value = ''; }
  catch (e) { toast(e.message); }
}
function bindCommon() {
  document.querySelectorAll('[data-go]').forEach((el) => (el.onclick = (e) => { e.preventDefault(); go(el.dataset.go); }));
  document.querySelectorAll('[data-clip]').forEach((el) => (el.onclick = () => openClip(+el.dataset.clip)));
}
const jobCard = (j) => `<div class="card"><div class="row"><div class="grow ellipsis"><b>#${j.id}</b> ${esc(j.title || j.url)}</div>${pill(j.status)}</div>
  <div class="muted small">${esc(j.author || '')}${j.duration ? ' • ' + dur(j.duration) : ''}${j.step ? ' • ' + esc(j.step) : ''}</div>
  ${['downloading', 'analyzing', 'rendering'].includes(j.status) ? `<div class="bar"><i style="width:${Math.round((j.progress || 0) * 100)}%"></i></div>` : ''}
  ${j.error ? `<div class="small" style="color:#ff8b8e;margin-top:6px">${esc(j.error)}</div>` : ''}
  ${j.status === 'failed' || j.status === 'done' ? `<div class="row" style="margin-top:8px">${j.status === 'failed' ? `<button class="btn sm" data-retry="${j.id}">Qayta urinish</button>` : `<button class="btn sm" data-go="clips">${j.clips} ta klip ›</button>`}<button class="btn sm danger" data-del="${j.id}">O'chirish</button></div>` : ''}</div>`;

async function jobs() {
  const list = await api('/api/jobs');
  if (!here('jobs')) return;
  $('#view').innerHTML = `<h2>Navbat va vazifalar</h2>
    <div class="card"><div class="row"><input type="url" id="url" class="grow" placeholder="Havola qo'shish"><button class="btn primary" id="add">+</button></div></div>
    ${list.length ? list.map(jobCard).join('') : '<div class="empty">Hali video yo\'q. Havola qo\'shing yoki Manbalar bo\'limida kanal kuzating.</div>'}`;
  $('#add').onclick = async () => { await addUrl(); jobs(); };
  document.querySelectorAll('[data-retry]').forEach((b) => (b.onclick = async () => { await api(`/api/jobs/${b.dataset.retry}/retry`, { method: 'POST' }); jobs(); }));
  document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => { if (!confirm('O\'chirilsinmi? (yuklanmagan kliplari ham o\'chadi)')) return;
    try { await api('/api/jobs/' + b.dataset.del, { method: 'DELETE' }); jobs(); } catch (e) { toast(e.message); } }));
  bindCommon();
  timer = setInterval(() => page === 'jobs' && !busy && !$('#url:focus') && (busy = true, jobs().finally(() => (busy = false))), 5000);
}

let clipFilter = 'draft';
async function clips() {
  const filters = [['draft', 'Tasdiq kutmoqda'], ['approved,uploading', 'Rejada'], ['published', 'Kanalda'], ['failed,rejected', 'Boshqa']];
  const list = await api('/api/clips?status=' + clipFilter);
  if (!here('clips')) return;
  $('#view').innerHTML = `<div class="seg">${filters.map(([k, t]) => `<button data-f="${k}" class="${k === clipFilter ? 'on' : ''}">${t}</button>`).join('')}</div>
    ${list.length ? `<div class="clips">${list.map((c) => `<div class="clip ${c.kind}" data-clip="${c.id}"><div class="th" style="background-image:url('${media(c.id, 'thumb')}')"><span>${c.kind === 'short' ? '📱 ' : ''}${dur(c.duration)}</span></div>
      <div class="b"><div class="t">${esc(c.title)}</div><div class="row small muted" style="margin-top:4px">${pill(c.status)}${c.status === 'published' ? `<span class="grow" style="text-align:right">👁 ${num(c.views)}</span>` : c.scheduled_at && c.status === 'approved' ? `<span class="grow ellipsis" style="text-align:right">${when(c.scheduled_at)}</span>` : ''}</div></div></div>`).join('')}</div>`
      : '<div class="empty">Bu yerda hozircha klip yo\'q</div>'}`;
  document.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => { clipFilter = b.dataset.f; clips(); }));
  bindCommon();
}

async function openClip(id) {
  const c = await api('/api/clips/' + id);
  const editable = !['published', 'uploading'].includes(c.status);
  $('#sheetBody').innerHTML = `
    <div class="row" style="margin-bottom:10px"><b class="grow">${c.kind === 'short' ? '📱 Shorts' : '🎬 Kompilyatsiya'} • ${dur(c.duration)}</b>${pill(c.status)}<button class="icon" id="x">✕</button></div>
    ${c.hasFile && c.kind === 'short' ? `<div class="phone"><video src="${media(id, 'video')}" controls playsinline preload="metadata"></video>
      <div class="ui hidden" id="ui"><i class="z top"></i><i class="z right"></i><i class="z bottom"></i>
      <span class="btns">🤍<br>💬<br>🔖<br>↗️<br>🔁</span><span class="desc"><b>@${esc(c.job?.author ? 'kanalingiz' : 'kanal')}</b> <u>Obuna</u><br>${esc(c.title)}</span></div></div>
      <label class="switch" style="border:0"><span class="small">📐 YouTube interfeysini ko'rsatish (qizil = to'sib qoladigan joylar)</span><input type="checkbox" id="uiT"></label>`
    : c.hasFile ? `<video src="${media(id, 'video')}" controls playsinline preload="metadata" poster="${media(id, 'thumb')}"></video>` : `<img src="${media(id, 'thumb')}" style="width:100%;border-radius:12px">`}
    ${c.url ? `<p><a href="${c.url}" target="_blank" style="color:var(--blue)">YouTube'da ochish ↗</a> · 👁 ${num(c.views)} · 👍 ${num(c.likes)} · 💬 ${num(c.comments)}</p>` : ''}
    ${c.hasFile ? `<p class="small"><a href="${media(id, 'video')}" download="lahza_${id}.mp4" style="color:var(--ink2)">⬇️ Videoni yuklab olish</a>${c.kind === 'long' ? ` · <a href="${media(id, 'thumb')}" download="lahza_${id}.jpg" style="color:var(--ink2)">🖼 Prevyu</a>` : ''}</p>` : ''}
    ${c.error ? `<div class="warnbox">${esc(c.error)}</div>` : ''}
    ${c.kind === 'long' ? `<label class="f">Prevyu</label><img id="thumbImg" src="${media(id, 'thumb')}&v=${Date.now()}" style="width:100%;border-radius:10px">
      ${editable ? `<div class="row" style="margin-top:8px"><input type="text" id="tt" class="grow" value="${esc(c.thumb_text)}" placeholder="Prevyu yozuvi"><button class="btn sm" id="rethumb">Yangilash</button></div>` : ''}` : ''}
    <label class="f">Nom (${(c.title || '').length}/100)</label><input type="text" id="ti" maxlength="100" value="${esc(c.title)}" ${editable ? '' : 'disabled'}>
    <label class="f">Tavsif</label><textarea id="de" ${editable ? '' : 'disabled'}>${esc(c.description)}</textarea>
    <label class="f">Teglar (vergul bilan)</label><textarea id="tg" style="min-height:60px" ${editable ? '' : 'disabled'}>${esc(c.tags.join(', '))}</textarea>
    <label class="f">Ko'rinish</label><select id="pv" ${editable ? '' : 'disabled'}>${['public', 'unlisted', 'private'].map((p) => `<option value="${p}" ${c.privacy === p ? 'selected' : ''}>${{ public: 'Ochiq', unlisted: 'Havola orqali', private: 'Yopiq' }[p]}</option>`).join('')}</select>
    ${c.job ? `<p class="muted small">Manba: ${esc(c.job.author || '')} — <a href="${esc(c.job.url)}" target="_blank" style="color:var(--ink2)">${esc((c.job.title || c.job.url).slice(0, 60))}</a></p>` : ''}
    ${editable ? `<div class="row" style="margin-top:14px;flex-wrap:wrap">
      <button class="btn primary grow" id="ok">${c.status === 'approved' ? 'Saqlash' : '✅ Tasdiqlash'}</button>
      <button class="btn" id="now">🚀 Hozir</button>
      ${c.status !== 'rejected' ? '<button class="btn danger" id="no">Rad etish</button>' : ''}</div>
      ${c.status === 'approved' ? `<p class="muted small">Rejada: ${when(c.scheduled_at)}</p>` : ''}` : ''}`;
  $('#sheet').classList.remove('hidden');
  $('#x').onclick = closeSheet;
  if ($('#uiT')) $('#uiT').onchange = (e) => $('#ui').classList.toggle('hidden', !e.target.checked);
  if (!editable) return;
  const save = () => api('/api/clips/' + id, { method: 'PATCH', body: { title: $('#ti').value, description: $('#de').value,
    tags: $('#tg').value.split(',').map((s) => s.trim()).filter(Boolean), privacy: $('#pv').value } });
  $('#ok').onclick = async () => { try { await save(); if (c.status !== 'approved') { const r = await api(`/api/clips/${id}/approve`, { method: 'POST' }); toast('Rejalashtirildi: ' + when(r.scheduled_at)); } else toast('Saqlandi'); haptic('medium'); closeSheet(); go(page); } catch (e) { toast(e.message); } };
  $('#now').onclick = async () => { try { await save(); await api(`/api/clips/${id}/now`, { method: 'POST' }); toast('Bir daqiqada yuklanadi'); closeSheet(); go(page); } catch (e) { toast(e.message); } };
  if ($('#no')) $('#no').onclick = async () => { await api(`/api/clips/${id}/reject`, { method: 'POST' }); toast('Rad etildi'); closeSheet(); go(page); };
  if ($('#rethumb')) $('#rethumb').onclick = async (e) => { e.target.disabled = true; try { await api(`/api/clips/${id}/rethumb`, { method: 'POST', body: { text: $('#tt').value } }); $('#thumbImg').src = media(id, 'thumb') + '&v=' + Date.now(); toast('Prevyu yangilandi'); } catch (er) { toast(er.message); } e.target.disabled = false; };
}
function closeSheet() { $('#sheet').classList.add('hidden'); $('#sheetBody').innerHTML = ''; }
$('#sheet').onclick = (e) => { if (e.target.id === 'sheet') closeSheet(); };

// ---------- charts (single series, one hue, hover tooltip) ----------
const tip = $('#tip');
function showTip(e, html) { tip.innerHTML = html; tip.classList.remove('hidden'); const x = (e.touches?.[0] || e).clientX, y = (e.touches?.[0] || e).clientY;
  tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 8, Math.max(8, x - tip.offsetWidth / 2)) + 'px'; tip.style.top = (y - tip.offsetHeight - 14) + 'px'; }
const hideTip = () => tip.classList.add('hidden');
const niceMax = (v) => { if (v <= 4) return 4; const p = 10 ** Math.floor(Math.log10(v)); return Math.ceil(v / p / 2) * p * 2 || 4; };
const shortDay = (d) => { const [, m, dd] = d.split('-'); return `${+dd}.${m}`; };

function barChart(el, data, key, label) {
  const W = 340, H = 170, L = 34, B = 20, T = 8, n = data.length; const max = niceMax(Math.max(...data.map((d) => d[key])));
  const bw = (W - L - 4) / n; const y = (v) => T + (H - T - B) * (1 - v / max);
  let s = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${label}"><g class="grid">`;
  for (let i = 0; i <= 2; i++) { const v = (max / 2) * i; s += `<line x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 5}" y="${y(v) + 3}" text-anchor="end">${num(v)}</text>`; }
  s += '</g>';
  data.forEach((d, i) => { const h = Math.max(d[key] ? 2 : 0, H - B - y(d[key])); const x = L + i * bw + 1; const w = Math.max(2, bw - 2); const r = Math.min(4, w / 2, h);
    // 4px rounded data-end, flat on the baseline
    if (h > 0) s += `<path fill="var(--blue)" d="M${x},${H - B} V${H - B - h + r} Q${x},${H - B - h} ${x + r},${H - B - h} H${x + w - r} Q${x + w},${H - B - h} ${x + w},${H - B - h + r} V${H - B} Z"/>`;
    s += `<rect x="${L + i * bw}" y="${T}" width="${bw}" height="${H - T - B + 4}" fill="transparent" data-i="${i}"/>`; });
  [0, Math.floor(n / 2), n - 1].forEach((i) => { s += `<text x="${L + i * bw + bw / 2}" y="${H - 5}" text-anchor="middle">${shortDay(data[i].day)}</text>`; });
  el.innerHTML = s + '</svg>';
  el.querySelectorAll('rect[data-i]').forEach((r) => { const d = data[+r.dataset.i];
    const f = (e) => showTip(e, `<b>${shortDay(d.day)}</b> · ${nf.format(d[key])} ${label}${d.uploads ? ` · ${d.uploads} ta yuklash` : ''}`);
    r.addEventListener('pointermove', f); r.addEventListener('pointerdown', f); r.addEventListener('pointerleave', hideTip); });
}
function lineChart(el, data, key, label) {
  if (data.length < 2) { el.innerHTML = '<div class="muted small">Grafik uchun kamida 2 kunlik ma\'lumot kerak</div>'; return; }
  const W = 340, H = 150, L = 40, B = 20, T = 10; const vals = data.map((d) => d[key]);
  let lo = Math.min(...vals), hi = Math.max(...vals); if (hi === lo) { hi += 1; lo = Math.max(0, lo - 1); }
  const x = (i) => L + (W - L - 6) * (i / (data.length - 1)); const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  let s = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${label}"><g class="grid">`;
  [lo, hi].forEach((v) => { s += `<line x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 5}" y="${y(v) + 3}" text-anchor="end">${num(v)}</text>`; });
  s += `</g><path d="${vals.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ')}" fill="none" stroke="var(--blue)" stroke-width="2" stroke-linejoin="round"/>`;
  s += `<line id="xh" y1="${T}" y2="${H - B}" stroke="var(--muted)" stroke-dasharray="3 3" visibility="hidden"/><circle id="dot" r="4.5" fill="var(--blue)" stroke="var(--s1)" stroke-width="2" visibility="hidden"/>`;
  s += `<text x="${L}" y="${H - 5}">${shortDay(data[0].day)}</text><text x="${W - 6}" y="${H - 5}" text-anchor="end">${shortDay(data[data.length - 1].day)}</text>`;
  s += `<rect x="${L}" y="0" width="${W - L}" height="${H}" fill="transparent" id="hit"/></svg>`;
  el.innerHTML = s; const svg = el.querySelector('svg');
  const move = (e) => { const p = svg.getBoundingClientRect(); const px = ((e.clientX - p.left) / p.width) * W; const i = Math.max(0, Math.min(data.length - 1, Math.round(((px - L) / (W - L - 6)) * (data.length - 1))));
    const xh = svg.querySelector('#xh'), dot = svg.querySelector('#dot');
    xh.setAttribute('x1', x(i)); xh.setAttribute('x2', x(i)); xh.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(vals[i])); dot.setAttribute('visibility', 'visible');
    showTip(e, `<b>${shortDay(data[i].day)}</b> · ${nf.format(vals[i])} ${label}`); };
  const hit = svg.querySelector('#hit'); hit.addEventListener('pointermove', move); hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => { hideTip(); svg.querySelector('#xh').setAttribute('visibility', 'hidden'); svg.querySelector('#dot').setAttribute('visibility', 'hidden'); });
}

let statDays = 30, statSort = 'new';
const ago2 = (t) => { const sec = Math.round((Date.now() - t) / 1000); return sec < 60 ? `${sec} s oldin` : ago(t); };
const vdur = (s) => (s ? dur(s) : '');
async function stats(silent) {
  const s = await api(`/api/stats?days=${statDays}&sort=${statSort}`);
  if (!here('stats')) return;
  const total = s.series.reduce((a, d) => a + d.views, 0);
  const k = Object.fromEntries(s.byKind.map((r) => [r.kind, r]));
  const avg = (r) => (r && r.videos ? Math.round(r.views / r.videos) : 0);
  const ch = s.channel;
  const scrollY = window.scrollY;
  $('#view').innerHTML = `
    <div class="row"><h2 class="grow">Statistika</h2><span class="small muted" id="upd">${s.refresh.at ? 'yangilandi ' + ago2(s.refresh.at) : ''}</span><button class="btn sm" id="refresh">↻</button></div>
    ${!s.connected ? '<div class="warnbox">YouTube kanal ulanmagan — Sozlamalarda ulang</div>' : ''}
    ${s.refresh.error ? `<div class="warnbox">YouTube'dan olinmadi: ${esc(s.refresh.error)}</div>` : ''}
    <div class="grid">
      <div class="tile"><div class="v">${ch ? num(ch.subscribers) : '—'}</div><div class="l">Obunachilar</div></div>
      <div class="tile"><div class="v">${ch ? num(ch.views) : '—'}</div><div class="l">Jami ko'rishlar</div></div>
      <div class="tile"><div class="v">${ch ? num(ch.videos) : s.videos.length}</div><div class="l">Videolar</div></div>
      <div class="tile"><div class="v">${num(total)}</div><div class="l">Ko'rishlar (${statDays} kun)</div></div>
    </div>
    <div class="seg">${[7, 30, 90].map((d) => `<button data-d="${d}" class="${d === statDays ? 'on' : ''}">${d} kun</button>`).join('')}</div>
    <div class="card"><b>Kunlik ko'rishlar</b><div class="muted small">Kanal bo'yicha, kunlik farq</div><div id="c1" style="margin-top:8px"></div></div>
    <div class="card"><b>Obunachilar</b><div id="c2" style="margin-top:8px"></div></div>
    <div class="grid">
      <div class="tile"><div class="l">🎬 Videolar</div><div class="v">${num(k.long?.views || 0)}</div><div class="l">${k.long?.videos || 0} ta · o'rtacha ${num(avg(k.long))}</div></div>
      <div class="tile"><div class="l">📱 Shorts</div><div class="v">${num(k.short?.views || 0)}</div><div class="l">${k.short?.videos || 0} ta · o'rtacha ${num(avg(k.short))}</div></div>
    </div>
    <h2>Kanaldagi barcha videolar (${s.videos.length})</h2>
    <div class="seg">${[['new', 'Yangi'], ['views', 'Ko\'rishlar'], ['likes', 'Layklar'], ['comments', 'Izohlar']].map(([v, t]) => `<button data-sort="${v}" class="${v === statSort ? 'on' : ''}">${t}</button>`).join('')}</div>
    <div class="card list">${s.videos.length ? s.videos.map((v) => `<div class="it" data-yt="${esc(v.id)}" data-short="${v.short ? 1 : 0}" style="cursor:pointer">
      <div style="position:relative;flex:none"><img src="${esc(v.thumb)}" alt="" loading="lazy" style="width:112px;height:63px">${v.duration ? `<span style="position:absolute;right:3px;bottom:3px;background:rgba(0,0,0,.8);font-size:10px;padding:0 4px;border-radius:4px">${vdur(v.duration)}</span>` : ''}</div>
      <div class="grow" style="min-width:0"><div class="small" style="font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(v.title)}</div>
        <div class="small muted">👁 ${num(v.views)} · 👍 ${num(v.likes)} · 💬 ${num(v.comments)}</div>
        <div class="small muted">${new Date(v.published).toLocaleDateString('uz-UZ')}${v.short ? ' · <span class="pill">Shorts</span>' : ''}${v.lahza ? ' · <span class="pill good">Lahza</span>' : ''}${v.privacy && v.privacy !== 'public' ? ` · <span class="pill warn">${v.privacy === 'private' ? 'yopiq' : 'havola orqali'}</span>` : ''}</div></div></div>`).join('')
      : `<div class="muted small">${s.connected ? (s.refresh.running ? 'YouTube\'dan olinmoqda…' : 'Kanalda hali video yo\'q') : 'Kanal ulanmagan'}</div>`}</div>`;
  if (silent) window.scrollTo(0, scrollY);
  barChart($('#c1'), s.series, 'views', "ko'rish");
  lineChart($('#c2'), s.subs, 'subscribers', 'obunachi');
  document.querySelectorAll('[data-d]').forEach((b) => (b.onclick = () => { statDays = +b.dataset.d; stats(); }));
  document.querySelectorAll('[data-sort]').forEach((b) => (b.onclick = () => { statSort = b.dataset.sort; stats(); }));
  document.querySelectorAll('[data-yt]').forEach((el) => (el.onclick = () => ext((el.dataset.short === '1' ? 'https://youtube.com/shorts/' : 'https://youtu.be/') + el.dataset.yt)));
  $('#refresh').onclick = async (e) => { e.target.disabled = true; try { await api('/api/stats/refresh', { method: 'POST', timeout: 60000 }); await stats(true); toast('Yangilandi'); } catch (er) { toast(er.message); e.target.disabled = false; } };
  // live: re-read every 20 s while this page is open (the server refreshes from YouTube at most once a minute)
  clearInterval(timer);
  timer = setInterval(() => { if (here('stats') && !busy && !document.hidden) { busy = true; stats(true).catch(() => {}).finally(() => (busy = false)); } }, 20000);
}

async function sources() {
  const list = await api('/api/sources');
  if (!here('sources')) return;
  $('#view').innerHTML = `<h2>Kuzatiladigan kanallar</h2>
    <div class="card">
      <label class="f">Kanal havolasi</label><input type="url" id="su" placeholder="https://www.youtube.com/@streamer yoki twitch.tv/streamer">
      <div class="row"><div class="grow"><label class="f">Sarlavhada bo'lishi kerak</label><input type="text" id="sk" value="" placeholder="bo'sh = hammasi, masalan: GTA"></div>
      <div style="width:110px"><label class="f">Min. daqiqa</label><input type="number" id="sm" value="30"></div></div>
      <label class="f">Mualliflik uchun ism (tavsifga yoziladi)</label><input type="text" id="sc" placeholder="Streamer nomi">
      <div class="switch"><span class="small">Muallif kliplash uchun ruxsat bergan</span><input type="checkbox" id="sp"></div>
      <button class="btn primary" id="sadd" style="width:100%;margin-top:8px">Kuzatishni boshlash</button>
      <p class="muted small">Har 20 daqiqada tekshiriladi. Efir tugab, yozuvi chiqqach avtomatik navbatga tushadi. Eski videolar olinmaydi.</p>
    </div>
    ${list.map((s) => `<div class="card"><div class="row"><b class="grow ellipsis">${esc(s.name)}</b>${s.permission ? '<span class="pill good">✓ ruxsat</span>' : '<span class="pill warn">ruxsat?</span>'}</div>
      <div class="muted small ellipsis">${esc(s.url)}</div>
      <div class="muted small">${s.keyword ? 'Filtr: "' + esc(s.keyword) + '" • ' : ''}${s.min_minutes}+ daq • ${s.last_checked ? 'tekshirildi ' + ago(s.last_checked) : ''}</div>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-tog="${s.id}" data-a="${s.active}">${s.active ? '⏸ To\'xtatish' : '▶️ Yoqish'}</button>
      <button class="btn sm" data-perm="${s.id}" data-p="${s.permission}">${s.permission ? 'Ruxsatni olib tashlash' : 'Ruxsat bor'}</button>
      <button class="btn sm danger" data-sdel="${s.id}">O'chirish</button></div></div>`).join('')}
    ${list.length ? '<button class="btn" id="chk" style="width:100%">Hozir tekshirish</button>' : ''}`;
  $('#sadd').onclick = async (e) => {
    const url = $('#su').value.trim(); if (!url) return toast('Havolani kiriting');
    e.target.disabled = true; e.target.textContent = 'Tekshirilmoqda…';
    try { const r = await api('/api/sources', { method: 'POST', body: { url, keyword: $('#sk').value.trim(), min_minutes: +$('#sm').value || 20, credit: $('#sc').value.trim(), permission: $('#sp').checked } });
      toast('Qo\'shildi: ' + (r.name || '')); sources(); } catch (er) { toast(er.message); e.target.disabled = false; e.target.textContent = 'Kuzatishni boshlash'; }
  };
  document.querySelectorAll('[data-tog]').forEach((b) => (b.onclick = async () => { await api('/api/sources/' + b.dataset.tog, { method: 'PATCH', body: { active: b.dataset.a !== '1' } }); sources(); }));
  document.querySelectorAll('[data-perm]').forEach((b) => (b.onclick = async () => { await api('/api/sources/' + b.dataset.perm, { method: 'PATCH', body: { permission: b.dataset.p !== '1' } }); sources(); }));
  document.querySelectorAll('[data-sdel]').forEach((b) => (b.onclick = async () => { if (confirm('O\'chirilsinmi?')) { await api('/api/sources/' + b.dataset.sdel, { method: 'DELETE' }); sources(); } }));
  if ($('#chk')) $('#chk').onclick = async () => { await api('/api/sources/check', { method: 'POST' }); toast('Tekshirilmoqda… yangi stream bo\'lsa botga xabar keladi'); };
}

async function settings() {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('on'));
  const [s, o] = await Promise.all([api('/api/settings'), api('/api/overview')]);
  if (!here('settings')) return;
  const sw = (k, t, hint = '') => `<div class="switch"><div><div>${t}</div>${hint ? `<div class="muted small">${hint}</div>` : ''}</div><input type="checkbox" data-k="${k}" ${s[k] ? 'checked' : ''}></div>`;
  const inp = (k, t, type = 'text', extra = '') => `<label class="f">${t}</label><input type="${type}" data-k="${k}" value="${esc(Array.isArray(s[k]) ? s[k].join(', ') : s[k])}" ${extra}>`;
  $('#view').innerHTML = `<h2>YouTube kanal</h2>
    <div class="card">${o.youtube.connected && o.channel && !o.channel.error
      ? `<div class="row">${o.channel.thumb ? `<img src="${esc(o.channel.thumb)}" style="width:44px;height:44px;border-radius:50%">` : ''}<div class="grow"><b>${esc(o.channel.title)}</b><div class="muted small">${num(o.channel.subscribers)} obunachi · ${o.channel.videos} video</div></div><button class="btn sm danger" id="ytoff">Uzish</button></div>`
      : `<p class="muted small">${o.youtube.configured ? 'Kanalingizni ulang — videolar shu kanalga yuklanadi.' : 'Birinchi marta: ilovani Google\'da ro\'yxatdan o\'tkazamiz (yo\'riqnoma ichida), keyin kanal ulanadi.'}</p>${o.channel?.error ? `<div class="warnbox">${esc(o.channel.error)}</div>` : ''}<button class="btn primary" id="yton" style="width:100%">${o.youtube.configured ? 'YouTube kanalni ulash' : 'YouTube\'ni sozlash va ulash'}</button>
        ${o.youtube.configured ? '<p class="small" style="margin:8px 0 0"><a href="#" id="ytsetup" style="color:var(--muted)">Google kalitlarini o\'zgartirish</a></p>' : ''}`}</div>
    ${o.youtube.connected && !o.youtube.canBrand ? '<div class="warnbox">Brendni kanalga o\'rnatish uchun kanalni qayta ulang (yangi ruxsat kerak). <a href="#" id="reconn" style="color:inherit">Qayta ulash</a></div>' : ''}
    <div class="card"><div class="row"><div style="font-size:28px">🎨</div><div class="grow"><b>Kanal brendi</b><div class="muted small">Nom, username, tavsif, banner va logo</div></div><button class="btn sm" id="brandBtn">Ochish</button></div></div>
    <div class="card"><div class="row"><div style="font-size:28px">🍪</div><div class="grow"><b>YouTube cookies</b><div class="muted small" id="ckState">…</div></div><button class="btn sm" id="ckBtn">Sozlash</button></div></div>
    <h2>Nashr qilish</h2>
    <div class="card">
      ${sw('autoPublish', 'Avto-nashr', 'Yoqilsa, tasdiqlashsiz jadval bo\'yicha yuklanadi')}
      <label class="f">Ko'rinish</label><select data-k="privacy">${['public', 'unlisted', 'private'].map((p) => `<option value="${p}" ${s.privacy === p ? 'selected' : ''}>${{ public: 'Ochiq', unlisted: 'Havola orqali', private: 'Yopiq' }[p]}</option>`).join('')}</select>
      ${inp('publishTimes', 'Yuklash vaqtlari (Toshkent, vergul bilan)', 'text', 'placeholder="13:00, 19:00"')}
      ${inp('dailyLimit', 'Kuniga ko\'pi bilan (YouTube API limiti ~6)', 'number', 'min="1" max="50"')}
    </div>
    <h2>Montaj</h2>
    <div class="card">
      ${sw('makeLong', 'Kompilyatsiya video (16:9)')}
      ${sw('makeShorts', 'Shorts (9:16)')}
      <div class="row"><div class="grow">${inp('highlightCount', 'Lahzalar soni', 'number')}</div><div class="grow">${inp('targetMinutes', 'Video uzunligi (daq)', 'number')}</div></div>
      <div class="row"><div class="grow">${inp('shortsPerVideo', 'Har streamdan Shorts', 'number')}</div><div class="grow"><label class="f">Sifat</label><select data-k="quality">${[[720, '720p (tez)'], [1080, '1080p'], [1440, '1440p (eng yuqori)']].map(([q, t]) => `<option value="${q}" ${+s.quality === q ? 'selected' : ''}>${t}</option>`).join('')}</select></div></div>
      <div class="row"><div class="grow">${inp('clipBefore', 'Lahzadan oldin (s)', 'number')}</div><div class="grow">${inp('clipAfter', 'Lahzadan keyin (s)', 'number')}</div></div>
      ${sw('facecamLayout', 'Webkamera tepada (Shorts)', 'Videoda streamer kamerasi bo\'lsa: tepada kamera, pastda o\'yin. Kamera bo\'lmasa oddiy ko\'rinish')}
      ${sw('effects', 'Ovoz effektlari', 'Whoosh, boom — eng qiziq joylarda')}
      ${sw('zoom', 'Zoom eng qiziq joyda', 'Kadr keskin yaqinlashadi va silliq qaytadi')}
      ${sw('outro', 'Chiroyli yakun + obuna animatsiyasi', 'Oxirida: SUBSCRIBE tugmasi bosiladi, qo\'ng\'iroqcha chalinadi (videoga 6 s outro, Shorts oxirgi 3.4 s)')}
      <div class="card" style="background:var(--s2);margin-top:8px"><b class="small">Obuna animatsiyasi</b>
        <div class="small muted" id="gsState" style="margin:4px 0 8px">Standart animatsiya (kanal nomi va logosi bilan)</div>
        <label class="btn sm" style="cursor:pointer">🟩 O'z green screen videoni yuklash<input type="file" id="gsFile" accept="video/*" hidden></label>
        <button class="btn sm danger hidden" id="gsDel">O'chirish</button>
        <div class="row" style="margin-top:8px"><span class="small muted grow">Fon rangi (olib tashlanadi)</span><input type="color" data-k="gsKey" value="${esc(s.gsKey || '#00FF00')}" style="width:50px;height:30px;border:0;background:none"></div>
        <div class="switch" style="border:0;padding:4px 0"><span class="small">Mening videomni ishlatish</span><input type="checkbox" data-k="subscribeCustom" ${s.subscribeCustom ? 'checked' : ''}></div></div>
      ${sw('emojis', 'Animatsion emojilar', 'Video ustida sakraydigan emojilar')}
      ${sw('subtitles', 'Shorts subtitrlari', 'So\'zma-so\'z, pastda, layk/koment tugmalari va tavsifdan chetda')}
      <div class="row"><div class="grow"><label class="f">Subtitr uslubi</label><select data-k="subtitleStyle">${[['pop', "Pop (so'zlar ovozga mos chiqadi)"], ['clean', 'Toza (kursiv, oq)'], ['karaoke', "Karaoke (sariq so'z)"]].map(([v, t]) => `<option value="${v}" ${s.subtitleStyle === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div></div>
      <div class="row"><div class="grow"><label class="f">Streamer qaysi tilda gapiradi</label><select data-k="subtitleLang">${[['auto', 'Avtomatik'], ['uz', "O'zbekcha"], ['ru', 'Ruscha'], ['en', 'Inglizcha']].map(([v, t]) => `<option value="${v}" ${s.subtitleLang === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="grow"><label class="f">Nutqni tanish</label><select data-k="asrModel">${[['small', 'Tez'], ['medium', "O'rtacha"], ['large-v3-turbo', 'Eng aniq']].map(([v, t]) => `<option value="${v}" ${s.asrModel === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div></div>
      ${sw('lowQualityFallback', 'Past sifatga ruxsat (360p)', 'YouTube HD videoni bermasa, xato o\'rniga 360p da yuklab oladi')}
      ${sw('keepSource', 'Asl videoni saqlash', 'O\'chiq bo\'lsa diskni tejash uchun o\'chiriladi')}
    </div>
    <h2>Nom, tavsif, teglar</h2>
    <div class="card">
      ${sw('useAI', 'AI yordamchi', o.ai ? `Videoni o'rganadi, lahzalarni baholaydi, matnlarni yozadi (${o.aiProviders.map((x) => (x === 'gemini' ? 'Gemini' : 'Claude')).join(' → ')})` : 'Kalit yo\'q — pastdan bepul Gemini kalitini qo\'shing')}
      <label class="f">Gemini API kaliti (bepul) ${o.aiProviders.includes('gemini') ? '✅' : ''}</label>
      <div class="row"><input type="password" id="gkey" class="grow" placeholder="${o.aiProviders.includes('gemini') ? 'saqlangan — almashtirish uchun yangisini kiriting' : 'AIza...'}" autocomplete="off"><button class="btn sm" id="gsave">Saqlash</button></div>
      <p class="small muted" style="margin:6px 0">Olish: <a href="#" id="glink" style="color:var(--blue)">aistudio.google.com/apikey</a> → <b>Create API key</b>. Karta kerak emas. Gemini ochiq YouTube videoni o'zi ko'radi (kuniga ~8 soatgacha bepul).</p>
      ${o.aiProviders.length > 1 ? `<label class="f">Qaysi AI birinchi</label><select data-k="aiProvider">${[['auto', 'Avtomatik (avval bepul Gemini)'], ['gemini', 'Gemini'], ['claude', 'Claude']].map(([v, t]) => `<option value="${v}" ${s.aiProvider === v ? 'selected' : ''}>${t}</option>`).join('')}</select>` : ''}
      <label class="f">Video tili (nom, tavsif, teglar, subtitr)</label><select data-k="language">${[['en', 'Inglizcha'], ['ru', 'Ruscha'], ['uz', "O'zbekcha"]].map(([v, t]) => `<option value="${v}" ${s.language === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
      ${inp('game', "Mavzu (bo'sh qoldiring — har video uchun AI o'zi aniqlaydi)")}
      ${inp('channelName', 'Kanal nomi')}
      ${inp('defaultTags', 'Doimiy teglar (vergul bilan)')}
      <label class="f">Tavsif oxiri</label><textarea data-k="descriptionFooter" style="min-height:80px">${esc(s.descriptionFooter)}</textarea>
      <label class="f">Prevyu yozuvi rangi</label><input type="color" data-k="accent" value="${esc(s.accent)}" style="width:60px;height:36px;border:0;background:none">
    </div>
    <button class="btn primary" id="save" style="width:100%">Saqlash</button>`;
  $('#save').onclick = async () => {
    const patch = {};
    document.querySelectorAll('[data-k]').forEach((el) => { const k = el.dataset.k; let v = el.type === 'checkbox' ? el.checked : el.value;
      if (Array.isArray(s[k])) v = v.split(',').map((x) => x.trim()).filter(Boolean); else if (typeof s[k] === 'number') v = Number(v) || 0; patch[k] = v; });
    try { await api('/api/settings', { method: 'PATCH', body: patch }); haptic('medium'); toast('Saqlandi'); } catch (e) { toast(e.message); }
  };
  if ($('#yton')) $('#yton').onclick = connectYouTube;
  if ($('#ytsetup')) $('#ytsetup').onclick = async (e) => { e.preventDefault(); openYtSetup(await api('/api/youtube/setup')); };
  if ($('#brandBtn')) $('#brandBtn').onclick = openBrand;
  $('#glink').onclick = (e) => { e.preventDefault(); ext('https://aistudio.google.com/apikey'); };
  $('#gsave').onclick = async (e) => { const key = $('#gkey').value.trim(); if (!key) return toast('Kalitni kiriting');
    e.target.disabled = true; try { await api('/api/ai/gemini', { method: 'POST', body: { key } }); haptic('medium'); toast('✅ Gemini ulandi'); settings(); } catch (er) { toast(er.message); e.target.disabled = false; } };
  api('/api/cookies').then((c) => { if ($('#ckState')) $('#ckState').textContent = c.has ? `✅ Yuklangan (${new Date(c.updated).toLocaleDateString('uz-UZ')})` : '18+ va "bot emasman" tekshiruvli videolar uchun kerak'; });
  if ($('#ckBtn')) $('#ckBtn').onclick = openCookies;
  api('/api/subscribe-gs').then((g) => { if (!$('#gsState')) return; if (g.has) { $('#gsState').textContent = '✅ Sizning green screen videongiz yuklangan'; $('#gsDel').classList.remove('hidden'); } });
  $('#gsFile').onchange = (e) => { const f = e.target.files[0]; if (!f) return; toast('Yuklanmoqda…');
    const x = new XMLHttpRequest(); x.open('PUT', '/api/subscribe-gs'); x.setRequestHeader('authorization', 'Bearer ' + token);
    x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch (er) {} if (x.status === 200) { toast('✅ Yuklandi'); settings(); } else toast(j.error || 'Xato'); };
    x.send(f); };
  $('#gsDel').onclick = async () => { await api('/api/subscribe-gs', { method: 'DELETE' }); toast('O\'chirildi'); settings(); };
  if ($('#reconn')) $('#reconn').onclick = (e) => { e.preventDefault(); connectYouTube(); };
  if ($('#ytoff')) $('#ytoff').onclick = async () => { if (confirm('Kanal uzilsinmi?')) { await api('/api/youtube/disconnect', { method: 'POST' }); settings(); } };
}

async function connectYouTube() {
  const info = await api('/api/youtube/setup');
  if (!info.hasCreds) return openYtSetup(info);
  try { const { url } = await api('/api/youtube/auth'); tg?.openLink ? tg.openLink(url) : (location.href = url); } catch (e) { toast(e.message); }
}
const ext = (url) => (tg?.openLink ? tg.openLink(url) : window.open(url, '_blank'));

// one-time Google setup, all inside the web app: links open the right Google Cloud pages, the redirect URI is ready to copy
function openYtSetup(info) {
  const step = (n, title, body) => `<div class="card"><div class="row" style="align-items:flex-start"><span class="pill blue" style="min-width:26px;justify-content:center">${n}</span><div class="grow"><b>${title}</b><div class="small muted" style="margin-top:4px">${body}</div></div></div></div>`;
  $('#sheetBody').innerHTML = `<div class="row" style="margin-bottom:6px"><b class="grow">📺 YouTube'ni sozlash</b><button class="icon" id="x">✕</button></div>
    <p class="small muted">Bu <b>bir marta</b> qilinadi: ilovangiz Google'da ro'yxatdan o'tadi. Keyin kanal bitta tugma bilan ulanadi. ~10 daqiqa.</p>
    ${step(1, 'YouTube API\'ni yoqing', `Kanal ulangan Google akkaunt bilan oching → loyiha yarating (nomi: Lahza) → <b>Enable</b>.<br><button class="btn sm" data-ext="https://console.cloud.google.com/apis/library/youtube.googleapis.com" style="margin-top:6px">Ochish ↗</button>`)}
    ${step(2, 'Ruxsat oynasini sozlang', `App name: <b>Lahza</b>, emailingiz, Audience: <b>External</b> → Create. Keyin <b>Audience → Test users</b>ga emailingizni qo'shing.<br><button class="btn sm" data-ext="https://console.cloud.google.com/auth/overview" style="margin-top:6px">Ochish ↗</button>`)}
    ${step(3, 'OAuth client yarating', `<b>Create client</b> → turi <b>Web application</b> → <b>Authorized redirect URIs</b>ga shuni qo'shing:
      ${info.redirectUri ? `<div class="row" style="margin-top:6px"><code class="grow" style="background:var(--s2);padding:8px;border-radius:8px;font-size:12px;word-break:break-all">${esc(info.redirectUri)}</code><button class="btn sm" id="cpy">Nusxa</button></div>`
        : '<div class="warnbox" style="margin-top:6px">Server manzili aniqlanmadi. Railway → Settings → Networking → <b>Generate Domain</b> bosing va qayta deploy qiling.</div>'}
      <button class="btn sm" data-ext="https://console.cloud.google.com/auth/clients/create" style="margin-top:6px">Ochish ↗</button>`)}
    ${step(4, 'Kalitlarni shu yerga qo\'ying', `Chiqqan oynadan nusxa oling:
      <label class="f">Client ID</label><input type="text" id="cid" placeholder="....apps.googleusercontent.com" value="${esc(info.clientId)}" autocomplete="off">
      <label class="f">Client secret</label><input type="password" id="csec" placeholder="GOCSPX-..." autocomplete="off">
      <button class="btn primary" id="csave" style="width:100%;margin-top:10px">Saqlash va kanalni ulash</button>`)}
    <p class="small muted">Google "This app isn't verified" desa: <b>Advanced → Go to Lahza</b>. Bu sizning ilovangiz. Ulanib bo'lgach, Google'da <b>Audience → Publish app</b> bosing, aks holda ulanish 7 kunda eskiradi.</p>`;
  $('#sheet').classList.remove('hidden');
  $('#x').onclick = closeSheet;
  document.querySelectorAll('[data-ext]').forEach((b) => (b.onclick = () => ext(b.dataset.ext)));
  if ($('#cpy')) $('#cpy').onclick = () => copy(info.redirectUri);
  $('#csave').onclick = async (e) => {
    e.target.disabled = true;
    try {
      await api('/api/youtube/setup', { method: 'POST', body: { clientId: $('#cid').value, clientSecret: $('#csec').value } });
      haptic('medium'); toast('Saqlandi. Google oynasi ochilmoqda…'); closeSheet();
      const { url } = await api('/api/youtube/auth'); tg?.openLink ? tg.openLink(url) : (location.href = url);
    } catch (er) { toast(er.message); e.target.disabled = false; }
  };
}
const copy = (t) => { navigator.clipboard?.writeText(t).then(() => toast('Nusxa olindi: ' + t.slice(0, 40)), () => toast(t)); haptic(); };

async function openBrand() {
  let k = await api('/api/brand'); const o = await api('/api/overview');
  const draw = () => {
    const v = Date.now();
    $('#sheetBody').innerHTML = `<div class="row" style="margin-bottom:10px"><b class="grow">🎨 Kanal brendi</b><button class="icon" id="x">✕</button></div>
    ${!k ? `<p class="muted small">AI kanalingiz uchun nom, @username, tavsif, kalit so'zlar, banner (2560×1440) va logo (800×800) tayyorlaydi.</p>` : ''}
    <label class="f">Istaklaringiz (ixtiyoriy)</label><input type="text" id="hint" placeholder="masalan: qisqa, kulgili, o'yin nomi bo'lsin">
    <button class="btn ${k ? '' : 'primary'}" id="gen" style="width:100%;margin-top:8px">${k ? '🔄 Qaytadan yaratish' : '✨ Brend yaratish'}</button>
    ${k ? `
      <h2>Nom</h2><div class="chips">${k.names.map((n) => `<span data-copy="${esc(n)}" style="cursor:pointer;${n === k.chosen ? 'outline:2px solid var(--accent)' : ''}">${esc(n)}</span>`).join('')}</div>
      <h2>Username</h2><div class="chips">${k.handles.map((h) => `<span data-copy="@${esc(h)}" style="cursor:pointer">@${esc(h)}</span>`).join('')}</div>
      <p class="muted small">Bosing — nusxa olinadi. Username band bo'lsa keyingisini sinang.</p>
      <h2>Banner</h2>${k.hasBanner ? `<img src="/media/brand/banner?t=${encodeURIComponent(token)}&v=${v}" style="width:100%;border-radius:10px">` : ''}
      <div class="row"><div class="grow"><label class="f">Banner yozuvi</label><input type="text" id="bt" value="${esc(k.banner_title)}"></div></div>
      <label class="f">Banner pastki yozuvi</label><input type="text" id="bs" value="${esc(k.banner_subtitle)}">
      <h2>Logo</h2><div class="row"><img src="/media/brand/logo?t=${encodeURIComponent(token)}&v=${v}" style="width:110px;height:110px;border-radius:50%"><div class="grow"><label class="f">Logo harflari</label><input type="text" id="lt" maxlength="2" value="${esc(k.logo_text)}"></div></div>
      <h2>Tavsif</h2><textarea id="bd" style="min-height:180px">${esc(k.description)}</textarea>
      <label class="f">Kalit so'zlar</label><textarea id="bk" style="min-height:60px">${esc(k.keywords.join(', '))}</textarea>
      <button class="btn" id="bsave" style="width:100%;margin-top:10px">Saqlash va rasmlarni yangilash</button>
      <h2>Kanalga o'rnatish</h2>
      <button class="btn primary" id="apply" style="width:100%" ${o.youtube.connected ? '' : 'disabled'}>⬆️ Banner, tavsif va kalit so'zlarni o'rnatish</button>
      ${o.youtube.connected ? '' : '<p class="muted small">Avval kanalni ulang.</p>'}
      <div class="card" style="margin-top:10px"><b>Qo'lda (YouTube API ruxsat bermaydi):</b>
        <ol class="small muted" style="padding-left:18px;margin:6px 0">
          <li>Nom va @username — yuqoridan nusxa oling</li>
          <li>Logo — <a href="/media/brand/logo?t=${encodeURIComponent(token)}" download="logo.png" style="color:var(--blue)">yuklab oling</a></li>
          <li>YouTube Studio → Moslashtirish → Profil: nom, username va rasmni o'rnating</li></ol>
        ${o.channel?.id ? `<a class="btn sm" href="https://studio.youtube.com/channel/${o.channel.id}/editing/profile" target="_blank">YouTube Studio'ni ochish ↗</a>` : ''}
        <a class="btn sm" href="/media/brand/banner?t=${encodeURIComponent(token)}" download="banner.jpg">⬇️ Banner</a></div>` : ''}`;
    $('#x').onclick = closeSheet;
    $('#gen').onclick = async (e) => { e.target.disabled = true; e.target.textContent = 'Yaratilmoqda… (~20 s)';
      try { k = await api('/api/brand/generate', { method: 'POST', body: { hint: $('#hint').value } }); haptic('medium'); draw(); } catch (er) { toast(er.message); e.target.disabled = false; } };
    document.querySelectorAll('[data-copy]').forEach((el) => (el.onclick = () => copy(el.dataset.copy)));
    if (!k) return;
    $('#bsave').onclick = async (e) => { e.target.disabled = true;
      try { k = await api('/api/brand', { method: 'PATCH', body: { banner_title: $('#bt').value, banner_subtitle: $('#bs').value, logo_text: $('#lt').value,
        description: $('#bd').value, keywords: $('#bk').value.split(',').map((x) => x.trim()).filter(Boolean) } }); toast('Saqlandi'); draw(); } catch (er) { toast(er.message); e.target.disabled = false; } };
    $('#apply').onclick = async (e) => { e.target.disabled = true; e.target.textContent = 'O\'rnatilmoqda…';
      try { await api('/api/brand', { method: 'PATCH', body: { description: $('#bd').value, keywords: $('#bk').value.split(',').map((x) => x.trim()).filter(Boolean) } });
        await api('/api/brand/apply', { method: 'POST' }); haptic('medium'); toast('✅ Kanalga o\'rnatildi'); e.target.textContent = '✅ O\'rnatildi'; }
      catch (er) { toast(er.message); e.target.disabled = false; e.target.textContent = '⬆️ Qayta urinish'; } };
  };
  draw(); $('#sheet').classList.remove('hidden');
}

function openCookies() {
  $('#sheetBody').innerHTML = `<div class="row" style="margin-bottom:6px"><b class="grow">🍪 YouTube cookies</b><button class="icon" id="x">✕</button></div>
    <p class="small muted">YouTube 18+ videolarni va serverdan kelgan so'rovlarni faqat akkauntga kirgan holda beradi. Cookies — sizning YouTube'ga kirganingizni bildiruvchi fayl.</p>
    <div class="warnbox">Asosiy akkauntingizni emas, <b>alohida (ikkinchi) Google akkaunt</b> ishlating — yoshi 18+ bo'lsin. Bu fayl parol kabi: hech kimga bermang.</div>
    <div class="card small"><b>Qanday olinadi (kompyuterda, 2 daqiqa):</b>
      <ol style="padding-left:18px;margin:6px 0" class="muted">
        <li>Chrome'ga <b>"Get cookies.txt LOCALLY"</b> kengaytmasini o'rnating</li>
        <li>Inkognito oynada youtube.com ga ikkinchi akkaunt bilan kiring</li>
        <li>Kengaytmani bosing → <b>Export</b> (Netscape format) → fayl yuklanadi</li>
        <li>Inkognito oynani <b>yoping</b> (chiqib ketmang — "Sign out" cookies'ni bekor qiladi)</li>
        <li>Faylni shu yerga yuklang <b>yoki Telegram'da botga yuboring</b></li></ol></div>
    <label class="f">cookies.txt fayli</label><input type="file" id="ckFile" accept=".txt,text/plain">
    <label class="f">yoki matnini qo'ying</label><textarea id="ckText" style="min-height:90px;font-size:11px" placeholder="# Netscape HTTP Cookie File ..."></textarea>
    <div class="row" style="margin-top:10px"><button class="btn primary grow" id="ckSave">Saqlash</button><button class="btn danger" id="ckDel">O'chirish</button></div>`;
  $('#sheet').classList.remove('hidden'); $('#x').onclick = closeSheet;
  $('#ckFile').onchange = async (e) => { const f = e.target.files[0]; if (f) $('#ckText').value = await f.text(); };
  $('#ckSave').onclick = async (e) => { e.target.disabled = true;
    try { const r = await api('/api/cookies', { method: 'POST', body: { text: $('#ckText').value } }); toast(`✅ Saqlandi (${r.count} ta). Navbatda xato bergan videoni "Qayta urinish" qiling`); closeSheet(); settings(); }
    catch (er) { toast(er.message); e.target.disabled = false; } };
  $('#ckDel').onclick = async () => { await api('/api/cookies', { method: 'DELETE' }); toast('O\'chirildi'); closeSheet(); settings(); };
}

(async () => { try { if (!token) await login(); go('home'); } catch (e) { showLogin(e.message); } })();

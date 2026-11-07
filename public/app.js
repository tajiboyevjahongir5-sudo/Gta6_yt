// Lahza Web App — vanilla JS, no build step.
const tg = window.Telegram?.WebApp; if (tg) { tg.ready(); tg.expand(); try { tg.setHeaderColor('#0f1012'); tg.setBackgroundColor('#0f1012'); } catch (e) {} }
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
  const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body });
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
let page = 'home', timer = null;
const pages = { home, jobs, clips, stats, sources, settings };
function go(p) {
  page = p; clearInterval(timer);
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.page === p));
  window.scrollTo(0, 0);
  pages[p]().catch((e) => { if (!/Sessiya|Kirish|Ruxsat/.test(e.message)) $('#view').innerHTML = `<div class="empty">⚠️ ${esc(e.message)}</div>`; });
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
  $('#chName').textContent = o.channel?.title || 'kanal ulanmagan';
  $('#badgeDrafts').textContent = o.counts.drafts || '';
  const ch = o.channel && !o.channel.error ? o.channel : null;
  const warn = [];
  if (!o.youtube.connected) warn.push(`YouTube kanal ulanmagan — <a href="#" data-go="settings" style="color:inherit">Sozlamalar</a>`);
  if (!o.ai) warn.push('AI kaliti yo\'q: nom/tavsif shablondan olinadi');
  $('#view').innerHTML = `
    ${warn.map((w) => `<div class="warnbox">${w}</div>`).join('')}
    <div class="card"><div class="row"><input type="url" id="url" class="grow" placeholder="Stream yoki video havolasi (YouTube, Twitch, Kick)"><button class="btn primary" id="add">Qo'shish</button></div></div>
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
  bindCommon();
  timer = setInterval(() => page === 'home' && !$('#url:focus') && home(), 8000);
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
  $('#view').innerHTML = `<h2>Navbat va vazifalar</h2>
    <div class="card"><div class="row"><input type="url" id="url" class="grow" placeholder="Havola qo'shish"><button class="btn primary" id="add">+</button></div></div>
    ${list.length ? list.map(jobCard).join('') : '<div class="empty">Hali video yo\'q. Havola qo\'shing yoki Manbalar bo\'limida kanal kuzating.</div>'}`;
  $('#add').onclick = async () => { await addUrl(); jobs(); };
  document.querySelectorAll('[data-retry]').forEach((b) => (b.onclick = async () => { await api(`/api/jobs/${b.dataset.retry}/retry`, { method: 'POST' }); jobs(); }));
  document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => { if (!confirm('O\'chirilsinmi? (yuklanmagan kliplari ham o\'chadi)')) return;
    try { await api('/api/jobs/' + b.dataset.del, { method: 'DELETE' }); jobs(); } catch (e) { toast(e.message); } }));
  bindCommon();
  timer = setInterval(() => page === 'jobs' && !$('#url:focus') && jobs(), 5000);
}

let clipFilter = 'draft';
async function clips() {
  const filters = [['draft', 'Tasdiq kutmoqda'], ['approved,uploading', 'Rejada'], ['published', 'Kanalda'], ['failed,rejected', 'Boshqa']];
  const list = await api('/api/clips?status=' + clipFilter);
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
    ${c.hasFile ? `<video src="${media(id, 'video')}" controls playsinline preload="metadata" poster="${media(id, 'thumb')}"></video>` : `<img src="${media(id, 'thumb')}" style="width:100%;border-radius:12px">`}
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

let statDays = 30;
async function stats() {
  const s = await api('/api/stats?days=' + statDays);
  const total = s.series.reduce((a, d) => a + d.views, 0), uploads = s.series.reduce((a, d) => a + d.uploads, 0);
  const k = Object.fromEntries(s.byKind.map((r) => [r.kind, r]));
  const avg = (r) => (r && r.videos ? Math.round(r.views / r.videos) : 0);
  $('#view').innerHTML = `
    <div class="row"><h2 class="grow">Statistika</h2><button class="btn sm" id="refresh">↻ Yangilash</button></div>
    <div class="seg">${[7, 30, 90].map((d) => `<button data-d="${d}" class="${d === statDays ? 'on' : ''}">${d} kun</button>`).join('')}</div>
    <div class="grid">
      <div class="tile"><div class="v">${num(total)}</div><div class="l">Ko'rishlar (${statDays} kun)</div></div>
      <div class="tile"><div class="v">${uploads}</div><div class="l">Yuklangan videolar</div></div>
    </div>
    <div class="card"><b>Kunlik ko'rishlar</b><div class="muted small">Barcha yuklangan kliplar bo'yicha</div><div id="c1" style="margin-top:8px"></div></div>
    <div class="card"><b>Obunachilar</b><div id="c2" style="margin-top:8px"></div></div>
    <h2>Video va Shorts</h2>
    <div class="grid">
      <div class="tile"><div class="l">🎬 Kompilyatsiyalar</div><div class="v">${num(k.long?.views || 0)}</div><div class="l">${k.long?.videos || 0} ta video · o'rtacha ${num(avg(k.long))}</div></div>
      <div class="tile"><div class="l">📱 Shorts</div><div class="v">${num(k.short?.views || 0)}</div><div class="l">${k.short?.videos || 0} ta video · o'rtacha ${num(avg(k.short))}</div></div>
    </div>
    <h2>Eng ko'p ko'rilganlar</h2>
    <div class="card">${s.top.length ? `<table><tr><th>Video</th><th class="n">👁</th><th class="n">👍</th></tr>${s.top.map((c) => `<tr data-clip="${c.id}"><td><div class="ellipsis" style="max-width:56vw">${c.kind === 'short' ? '📱 ' : ''}${esc(c.title)}</div></td><td class="n">${num(c.views)}</td><td class="n">${num(c.likes)}</td></tr>`).join('')}</table>` : '<div class="muted small">Hali yuklangan video yo\'q</div>'}</div>`;
  barChart($('#c1'), s.series, 'views', "ko'rish");
  lineChart($('#c2'), s.subs, 'subscribers', 'obunachi');
  document.querySelectorAll('[data-d]').forEach((b) => (b.onclick = () => { statDays = +b.dataset.d; stats(); }));
  $('#refresh').onclick = async (e) => { e.target.disabled = true; try { await api('/api/stats/refresh', { method: 'POST' }); await stats(); toast('Yangilandi'); } catch (er) { toast(er.message); e.target.disabled = false; } };
  bindCommon();
}

async function sources() {
  const list = await api('/api/sources');
  $('#view').innerHTML = `<h2>Kuzatiladigan kanallar</h2>
    <div class="card">
      <label class="f">Kanal havolasi</label><input type="url" id="su" placeholder="https://www.youtube.com/@streamer yoki twitch.tv/streamer">
      <div class="row"><div class="grow"><label class="f">Sarlavhada bo'lishi kerak</label><input type="text" id="sk" value="GTA" placeholder="masalan: GTA"></div>
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
  const sw = (k, t, hint = '') => `<div class="switch"><div><div>${t}</div>${hint ? `<div class="muted small">${hint}</div>` : ''}</div><input type="checkbox" data-k="${k}" ${s[k] ? 'checked' : ''}></div>`;
  const inp = (k, t, type = 'text', extra = '') => `<label class="f">${t}</label><input type="${type}" data-k="${k}" value="${esc(Array.isArray(s[k]) ? s[k].join(', ') : s[k])}" ${extra}>`;
  $('#view').innerHTML = `<h2>YouTube kanal</h2>
    <div class="card">${o.youtube.connected && o.channel && !o.channel.error
      ? `<div class="row">${o.channel.thumb ? `<img src="${esc(o.channel.thumb)}" style="width:44px;height:44px;border-radius:50%">` : ''}<div class="grow"><b>${esc(o.channel.title)}</b><div class="muted small">${num(o.channel.subscribers)} obunachi · ${o.channel.videos} video</div></div><button class="btn sm danger" id="ytoff">Uzish</button></div>`
      : `<p class="muted small">${o.youtube.configured ? 'Kanalingizni ulang — videolar shu kanalga yuklanadi.' : 'Serverda GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / PUBLIC_URL sozlanmagan (README).'}</p>${o.channel?.error ? `<div class="warnbox">${esc(o.channel.error)}</div>` : ''}<button class="btn primary" id="yton" ${o.youtube.configured ? '' : 'disabled'} style="width:100%">YouTube kanalni ulash</button>`}</div>
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
      <div class="row"><div class="grow">${inp('shortsPerVideo', 'Har streamdan Shorts', 'number')}</div><div class="grow"><label class="f">Sifat</label><select data-k="quality">${[720, 1080].map((q) => `<option value="${q}" ${+s.quality === q ? 'selected' : ''}>${q}p</option>`).join('')}</select></div></div>
      <div class="row"><div class="grow">${inp('clipBefore', 'Lahzadan oldin (s)', 'number')}</div><div class="grow">${inp('clipAfter', 'Lahzadan keyin (s)', 'number')}</div></div>
      ${sw('keepSource', 'Asl videoni saqlash', 'O\'chiq bo\'lsa diskni tejash uchun o\'chiriladi')}
    </div>
    <h2>Nom, tavsif, teglar</h2>
    <div class="card">
      ${sw('useAI', 'AI yordamchi', o.ai ? 'Kadrlarni ko\'rib baholaydi va matnlarni yozadi' : 'ANTHROPIC_API_KEY sozlanmagan')}
      <label class="f">Til</label><select data-k="language">${[['uz', "O'zbekcha"], ['ru', 'Ruscha'], ['en', 'Inglizcha']].map(([v, t]) => `<option value="${v}" ${s.language === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
      ${inp('game', "O'yin nomi")}
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
  if ($('#yton')) $('#yton').onclick = async () => { try { const { url } = await api('/api/youtube/auth'); tg?.openLink ? tg.openLink(url) : (location.href = url); } catch (e) { toast(e.message); } };
  if ($('#ytoff')) $('#ytoff').onclick = async () => { if (confirm('Kanal uzilsinmi?')) { await api('/api/youtube/disconnect', { method: 'POST' }); settings(); } };
}

(async () => { try { if (!token) await login(); go('home'); } catch (e) { showLogin(e.message); } })();

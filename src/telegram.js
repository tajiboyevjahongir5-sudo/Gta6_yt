// Telegram Bot API over plain fetch (long polling, no webhook needed).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { BOT_TOKEN, ADMIN_IDS, PUBLIC_URL } = require('./config');
const { getSecret, setSecret, log } = require('./db');
const { sleep } = require('./util');

const API = `https://api.telegram.org/bot${BOT_TOKEN}/`;
const enabled = () => !!BOT_TOKEN;

async function call(method, params = {}, file) {
  let body, headers = {};
  if (file) {
    body = new FormData();
    for (const [k, v] of Object.entries(params)) body.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    body.append(file.field, new Blob([fs.readFileSync(file.path)]), path.basename(file.path));
  } else { body = JSON.stringify(params); headers['content-type'] = 'application/json'; }
  const r = await fetch(API + method, { method: 'POST', body, headers });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description || r.status}`);
  return j.result;
}

// admins = ADMIN_IDS, or (if empty) the first person who pressed /start
function admins() { return ADMIN_IDS.length ? ADMIN_IDS : (getSecret('owner') ? [String(getSecret('owner'))] : []); }
const isAdmin = (id) => admins().includes(String(id));

// Telegram signs Web App initData with the bot token
function verifyInitData(initData, maxAgeSec = 7 * 24 * 3600) {
  if (!BOT_TOKEN || !initData) return null;
  try {
    const params = new URLSearchParams(initData); const hash = params.get('hash'); params.delete('hash');
    const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const sig = crypto.createHmac('sha256', secret).update(check).digest('hex');
    if (!hash || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hash))) return null;
    if (Date.now() / 1000 - Number(params.get('auth_date')) > maxAgeSec) return null;
    return JSON.parse(params.get('user'));
  } catch (e) { return null; }
}

const webAppButton = (text = '📊 Boshqaruv paneli') => (PUBLIC_URL.startsWith('https://')
  ? { inline_keyboard: [[{ text, web_app: { url: PUBLIC_URL + '/' } }]] } : undefined);

async function notifyAdmins(text, extra = {}) {
  for (const id of admins()) {
    try { await call('sendMessage', { chat_id: id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }); }
    catch (e) { log('Botdan xabar yuborilmadi: ' + e.message, 'warn'); }
  }
}
async function sendPhotoToAdmins(photoPath, caption, reply_markup) {
  for (const id of admins()) {
    try { await call('sendPhoto', { chat_id: id, caption: caption.slice(0, 1000), parse_mode: 'HTML', ...(reply_markup ? { reply_markup } : {}) }, { field: 'photo', path: photoPath }); }
    catch (e) { log('Rasm yuborilmadi: ' + e.message, 'warn'); }
  }
}
const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// handlers: { onLink(url, from), onCommand(cmd, args, msg), onCallback(data, cq) } — each returns reply text (or nothing)
async function startPolling(handlers) {
  if (!enabled()) { log('BOT_TOKEN yo\'q — Telegram bot o\'chiq', 'warn'); return; }
  try {
    await call('setMyCommands', { commands: [
      { command: 'start', description: 'Boshqaruv paneli' }, { command: 'navbat', description: 'Ishlanayotgan videolar' },
      { command: 'kliplar', description: 'Tasdiq kutayotgan kliplar' }, { command: 'stat', description: 'Kanal statistikasi' },
      { command: 'yordam', description: 'Qanday ishlaydi' }] });
    if (PUBLIC_URL.startsWith('https://')) await call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Panel', web_app: { url: PUBLIC_URL + '/' } } });
  } catch (e) { log(e.message, 'warn'); }
  let offset = 0;
  log('Telegram bot ishga tushdi');
  for (;;) {
    let updates = [];
    try { updates = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }); }
    catch (e) { log(e.message, 'warn'); await sleep(5000); continue; }
    for (const u of updates) {
      offset = u.update_id + 1;
      handleUpdate(u, handlers).catch((e) => log('Bot xatosi: ' + e.message, 'error'));
    }
  }
}

async function handleUpdate(u, h) {
  if (u.callback_query) {
    const cq = u.callback_query;
    if (!isAdmin(cq.from.id)) return call('answerCallbackQuery', { callback_query_id: cq.id, text: 'Ruxsat yo\'q' });
    const text = await h.onCallback(cq.data, cq);
    return call('answerCallbackQuery', { callback_query_id: cq.id, text: (text || 'OK').slice(0, 190) });
  }
  const m = u.message; if (!m || !m.text) return;
  const chat = m.chat.id, text = m.text.trim();
  if (!admins().length && text.startsWith('/start')) { setSecret('owner', m.from.id); log(`Bot egasi: ${m.from.id}`); }
  if (!isAdmin(m.from.id)) return call('sendMessage', { chat_id: chat, text: `Bu shaxsiy bot. Sizning ID: ${m.from.id}` });
  const reply = (t, extra = {}) => call('sendMessage', { chat_id: chat, text: t, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  const urls = text.match(/https?:\/\/\S+/g);
  if (urls && !text.startsWith('/')) { for (const url of urls) await reply(await h.onLink(url, m.from)); return; }
  const [cmd, ...args] = text.split(/\s+/);
  const out = await h.onCommand(cmd.replace(/@.*$/, '').toLowerCase(), args, m);
  if (out) await reply(out.text || out, out.extra || {});
}

module.exports = { enabled, call, verifyInitData, isAdmin, admins, notifyAdmins, sendPhotoToAdmins, startPolling, webAppButton, escHtml };

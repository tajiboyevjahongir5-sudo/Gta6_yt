// Big videos sent to the bot (Bot API lets bots download only 20 MB). The same bot logs in over MTProto (the protocol
// Telegram apps use), where a bot can download files up to 2 GB. Needs api_id + api_hash from my.telegram.org
// (env TG_API_ID / TG_API_HASH, or the /tgapi command). The login session is kept in the database.
const fs = require('fs');
const { BOT_TOKEN } = require('./config');
const { getSecret, setSecret, log } = require('./db');

const creds = () => {
  const id = Number(process.env.TG_API_ID || getSecret('tgApiId') || 0);
  const hash = String(process.env.TG_API_HASH || getSecret('tgApiHash') || '');
  return id && /^[0-9a-f]{32}$/i.test(hash) ? { id, hash } : null;
};
const enabled = () => !!creds();

let clientP = null;
function client() {
  if (clientP) return clientP;
  clientP = (async () => {
    const { TelegramClient } = require('telegram');
    const { StringSession } = require('telegram/sessions');
    const { id, hash } = creds();
    const c = new TelegramClient(new StringSession(getSecret('tgSession') || ''), id, hash, { connectionRetries: 5 });
    c.setLogLevel('error');
    await c.start({ botAuthToken: BOT_TOKEN });
    setSecret('tgSession', c.session.save());
    log('Telegram MTProto ulandi: botga 2 GB gacha video yuborish mumkin');
    return c;
  })().catch((e) => { clientP = null; throw e; });
  return clientP;
}

// message_id from the Bot API update -> the same message over MTProto (private chats share message ids) -> file.
// Downloaded in 512 KB pieces with resume: Telegram's file servers sometimes answer a piece with a temporary error
// ("-500 No workers running", timeouts); then we wait, re-read the message (fresh file reference) and continue
// from the last byte instead of starting the 1 GB over.
async function getDoc(c, messageId) {
  const { Api } = require('telegram');
  const res = await c.invoke(new Api.messages.GetMessages({ id: [new Api.InputMessageID({ id: messageId })] }));
  const msg = (res.messages || []).find((x) => x && x.media);
  const doc = msg?.media?.document;
  if (!doc) throw new Error('Xabar topilmadi (MTProto)');
  return doc;
}
// one big download at a time: two parallel 1 GB downloads make Telegram's file servers time out more often
let queue = Promise.resolve();
function download(messageId, dest, onProgress, onIssue) {
  const run = queue.then(() => downloadOne(messageId, dest, onProgress, onIssue));
  queue = run.catch(() => {});
  return run;
}
async function reconnect() {
  try { const c = await clientP; await c?.disconnect(); } catch (e) {}
  clientP = null;
  return client();
}
// The file is fetched with our own upload.GetFile loop: every 128 KB piece is asked for by its exact offset and
// written at exactly that position. (gramjs' iterDownload switches to a different, buggy code path when a download
// is resumed past 1 MB, which produced files of the right size with damaged audio/video inside.)
// After the download every piece is checked against Telegram's own SHA-256 list and bad pieces are fetched again.
async function downloadOne(messageId, dest, onProgress, onIssue) {
  const { Api } = require('telegram');
  const { FileMigrateError } = require('telegram/errors');
  const bigInt = require('big-integer');
  const crypto = require('crypto');
  let c = await client();
  const PIECE = 128 * 1024, MAX_FAILS = 15;
  let doc = await getDoc(c, messageId);
  const total = Number(doc.size);
  let dc = doc.dcId;
  const location = () => new Api.InputDocumentFileLocation({ id: doc.id, accessHash: doc.accessHash, fileReference: doc.fileReference, thumbSize: '' });
  const call = async (req) => {
    try { return await c.invokeWithSender(req, await c.getSender(dc)); }
    catch (e) { if (e instanceof FileMigrateError) { dc = e.newDc; return c.invokeWithSender(req, await c.getSender(dc)); } throw e; }
  };
  const fetchPiece = async (offset) => {
    const want = Math.min(PIECE, total - offset);
    const r = await call(new Api.upload.GetFile({ location: location(), offset: bigInt(offset), limit: PIECE, precise: true }));
    if (!r.bytes || r.bytes.length < want) throw new Error(`qisqa bo'lak (${r.bytes ? r.bytes.length : 0}/${want})`);
    return r.bytes.subarray(0, want);
  };
  // retry wrapper shared by the download and the repair pass
  let fails = 0;
  const withRetry = async (offset, fn) => {
    for (;;) {
      try { const v = await fn(); fails = 0; return v; }
      catch (e) {
        if (++fails > MAX_FAILS) throw new Error(`${e.message} (${Math.round(offset / 1048576)}/${Math.round(total / 1048576)} MB yuklangan edi)`);
        log(`Katta video: ${Math.round(offset / 1048576)} MB da uzildi (${String(e.message).slice(0, 80)}), ${fails}-qayta urinish`, 'warn');
        if (fails === 3 && onIssue) onIssue(`⏳ Telegram fayl serveri javob bermayapti (${String(e.message).slice(0, 60)}). ${Math.round(offset / 1048576)}/${Math.round(total / 1048576)} MB yuklandi, qayta urinyapman.\n\nTezroq yo'l: videoni telefon/kompyuterga saqlab, <b>Panel → Asosiy → 📁 Video faylini yuklash</b> orqali yuklang.`);
        await new Promise((ok) => setTimeout(ok, Math.min(30000, 2000 * fails)));
        if (fails % 3 === 0) { try { c = await reconnect(); } catch (er) { log('MTProto qayta ulanmadi: ' + er.message, 'warn'); } }
        try { doc = await getDoc(c, messageId); } catch (er) { /* keep the old reference */ }
      }
    }
  };
  const fd = fs.openSync(dest, 'w+');
  try {
    let last = 0;
    for (let offset = 0; offset < total; offset += PIECE) {
      const buf = await withRetry(offset, () => fetchPiece(offset));
      fs.writeSync(fd, buf, 0, buf.length, offset);
      const p = Math.floor((Math.min(total, offset + PIECE) / total) * 100);
      if (onProgress && p >= last + 5) { last = p - (p % 5); onProgress(last); }
    }
    // integrity: Telegram's SHA-256 of each range vs what is on disk; a wrong range is downloaded again
    try {
      let bad = 0, checked = 0;
      for (let offset = 0; offset < total;) {
        const hashes = await withRetry(offset, () => call(new Api.upload.GetFileHashes({ location: location(), offset: bigInt(offset) })));
        if (!hashes || !hashes.length) break;
        for (const h of hashes) {
          const off = Number(h.offset), len = Math.min(h.limit, total - off); if (len <= 0) continue;
          const read = () => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off); return crypto.createHash('sha256').update(b).digest(); };
          checked++;
          if (!read().equals(Buffer.from(h.hash))) {
            bad++;
            for (let o = Math.floor(off / PIECE) * PIECE; o < off + len; o += PIECE) { const buf = await withRetry(o, () => fetchPiece(o)); fs.writeSync(fd, buf, 0, buf.length, o); }
            if (!read().equals(Buffer.from(h.hash))) throw new Error(`fayl bo'lagi ${Math.round(off / 1048576)} MB da ikki marta noto'g'ri keldi`);
          }
          offset = Math.max(offset, off + h.limit);
        }
      }
      log(`Katta video tekshirildi: ${checked} bo'lak${bad ? `, ${bad} tasi qayta yuklandi` : ', hammasi to\'g\'ri'}`);
    } catch (e) { log('Katta video: yaxlitlik tekshiruvi tugallanmadi (' + String(e.message).slice(0, 100) + ')', 'warn'); if (/ikki marta noto/.test(e.message)) throw e; }
  } finally { fs.closeSync(fd); }
  if (fs.statSync(dest).size !== total) throw new Error('Fayl to\'liq yuklanmadi');
  return dest;
}

function setCreds(id, hash) {
  setSecret('tgApiId', Number(id)); setSecret('tgApiHash', String(hash)); setSecret('tgSession', '');
  clientP = null;
}

module.exports = { enabled, download, setCreds, client };

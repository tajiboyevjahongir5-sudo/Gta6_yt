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
function download(messageId, dest, onProgress) {
  const run = queue.then(() => downloadOne(messageId, dest, onProgress));
  queue = run.catch(() => {});
  return run;
}
async function reconnect() {
  try { const c = await clientP; await c?.disconnect(); } catch (e) {}
  clientP = null;
  return client();
}
async function downloadOne(messageId, dest, onProgress) {
  const { Api } = require('telegram');
  const bigInt = require('big-integer');
  let c = await client();
  // small pieces: "-503 Timeout" / "-500 No workers running" come from Telegram's media servers under load and hit
  // big requests first; every piece that arrives is kept, so a failure costs at most one piece
  const PIECE = 128 * 1024, MAX_FAILS = 30;
  let doc = await getDoc(c, messageId);
  const total = Number(doc.size);
  fs.writeFileSync(dest, '');
  let got = 0, fails = 0, last = 0;
  while (got < total) {
    try {
      const loc = new Api.InputDocumentFileLocation({ id: doc.id, accessHash: doc.accessHash, fileReference: doc.fileReference, thumbSize: '' });
      const fd = fs.openSync(dest, 'a');
      try {
        for await (const chunk of c.iterDownload({ file: loc, offset: bigInt(got), requestSize: PIECE, chunkSize: PIECE, dcId: doc.dcId, fileSize: bigInt(total) })) {
          fs.writeSync(fd, chunk); got += chunk.length; fails = 0;
          const p = Math.floor((got / total) * 100);
          if (onProgress && p >= last + 10) { last = p - (p % 10); onProgress(last); }
          if (got >= total) break;
        }
      } finally { fs.closeSync(fd); }
      if (got < total) throw new Error('Yuklash kutilmaganda to\'xtadi');
    } catch (e) {
      if (++fails > MAX_FAILS) throw new Error(`${e.message} (${Math.round(got / 1048576)}/${Math.round(total / 1048576)} MB yuklangan edi)`);
      log(`Katta video: ${Math.round(got / 1048576)} MB da uzildi (${String(e.message).slice(0, 80)}), ${fails}-qayta urinish`, 'warn');
      got = Math.floor(got / PIECE) * PIECE; fs.truncateSync(dest, got);
      await new Promise((ok) => setTimeout(ok, Math.min(60000, 2000 * fails)));
      // every 3rd failure in a row: a fresh connection (the link to the file's data centre may be stuck)
      if (fails % 3 === 0) { try { c = await reconnect(); } catch (er) { log('MTProto qayta ulanmadi: ' + er.message, 'warn'); } }
      try { doc = await getDoc(c, messageId); } catch (er) { /* keep the old reference */ }
    }
  }
  if (fs.statSync(dest).size < total) throw new Error('Fayl to\'liq yuklanmadi');
  return dest;
}

function setCreds(id, hash) {
  setSecret('tgApiId', Number(id)); setSecret('tgApiHash', String(hash)); setSecret('tgSession', '');
  clientP = null;
}

module.exports = { enabled, download, setCreds, client };

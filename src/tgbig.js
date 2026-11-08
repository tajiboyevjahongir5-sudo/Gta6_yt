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

// message_id from the Bot API update -> the same message over MTProto (private chats share message ids) -> file
async function download(messageId, dest, onProgress) {
  const { Api } = require('telegram');
  const c = await client();
  const res = await c.invoke(new Api.messages.GetMessages({ id: [new Api.InputMessageID({ id: messageId })] }));
  const msg = (res.messages || []).find((x) => x && x.media);
  if (!msg) throw new Error('Xabar topilmadi (MTProto)');
  let last = 0;
  await c.downloadMedia(msg, { outputFile: dest, workers: 4, progressCallback: (got, total) => {
    const p = Math.floor((Number(got) / Math.max(1, Number(total))) * 100);
    if (onProgress && p >= last + 10) { last = p; onProgress(p); }
  } });
  if (!fs.existsSync(dest) || fs.statSync(dest).size < 1000) throw new Error('Fayl yuklanmadi');
  return dest;
}

function setCreds(id, hash) {
  setSecret('tgApiId', Number(id)); setSecret('tgApiHash', String(hash)); setSecret('tgSession', '');
  clientP = null;
}

module.exports = { enabled, download, setCreds, client };

// YouTube Data API v3: OAuth connection, resumable upload, custom thumbnail, statistics.
const fs = require('fs');
const crypto = require('crypto');
const { Readable } = require('stream');
const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, PUBLIC_URL, SECRET } = require('./config');
const { getSecret, setSecret, log } = require('./db');

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];
const redirectUri = () => `${PUBLIC_URL}/oauth/google/callback`;
const configured = () => !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && PUBLIC_URL);

// state = expiry.signature, so only links we issued can finish the OAuth flow
function authUrl() {
  const exp = Date.now() + 15 * 60 * 1000;
  const state = exp + '.' + crypto.createHmac('sha256', SECRET).update('oauth' + exp).digest('hex').slice(0, 32);
  const q = new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, redirect_uri: redirectUri(), response_type: 'code',
    scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + q;
}
function checkState(state) {
  const [exp, sig] = String(state || '').split('.');
  return Number(exp) > Date.now() && sig === crypto.createHmac('sha256', SECRET).update('oauth' + exp).digest('hex').slice(0, 32);
}

async function tokenRequest(params) {
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, ...params }) });
  const j = await r.json();
  if (!r.ok) throw new Error('Google token xatosi: ' + (j.error_description || j.error || r.status));
  return j;
}
async function finishAuth(code) {
  const t = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
  setSecret('yt', { refresh_token: t.refresh_token, access_token: t.access_token, expires_at: Date.now() + (t.expires_in - 60) * 1000 });
  const ch = await channelInfo(true);
  log(`YouTube kanal ulandi: ${ch?.title || '?'}`);
  return ch;
}
async function accessToken() {
  const s = getSecret('yt');
  if (!s?.refresh_token) throw new Error('YouTube kanal ulanmagan (Sozlamalar → YouTube ulash)');
  if (s.access_token && s.expires_at > Date.now()) return s.access_token;
  const t = await tokenRequest({ refresh_token: s.refresh_token, grant_type: 'refresh_token' });
  setSecret('yt', { ...s, access_token: t.access_token, expires_at: Date.now() + (t.expires_in - 60) * 1000 });
  return t.access_token;
}
const connected = () => !!getSecret('yt')?.refresh_token;
function disconnect() { setSecret('yt', null); setSecret('channel', null); }

async function api(pathAndQuery, opts = {}) {
  const r = await fetch('https://www.googleapis.com/youtube/v3/' + pathAndQuery, { ...opts,
    headers: { authorization: 'Bearer ' + (await accessToken()), ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`YouTube API ${r.status}: ${j.error?.message || ''}`);
  return j;
}

async function channelInfo(refresh = false) {
  if (!connected()) return null;
  const cached = getSecret('channel');
  if (!refresh && cached && cached.at > Date.now() - 30 * 60 * 1000) return cached;
  const j = await api('channels?part=snippet,statistics&mine=true');
  const c = j.items?.[0]; if (!c) return null;
  const info = { id: c.id, title: c.snippet.title, thumb: c.snippet.thumbnails?.default?.url,
    subscribers: Number(c.statistics.subscriberCount || 0), views: Number(c.statistics.viewCount || 0),
    videos: Number(c.statistics.videoCount || 0), at: Date.now() };
  setSecret('channel', info);
  return info;
}

// resumable upload: one session, file streamed in a single PUT (retried by the caller on failure)
async function upload({ file, title, description, tags, privacy = 'public', publishAt, language = 'uz' }) {
  const size = fs.statSync(file).size;
  const status = { privacyStatus: publishAt ? 'private' : privacy, selfDeclaredMadeForKids: false, embeddable: true };
  if (publishAt) status.publishAt = new Date(publishAt).toISOString();
  const meta = { snippet: { title: title.slice(0, 100), description: description.slice(0, 4900), tags: fitTags(tags),
    categoryId: '20', defaultLanguage: language, defaultAudioLanguage: language }, status };
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST', body: JSON.stringify(meta),
    headers: { authorization: 'Bearer ' + (await accessToken()), 'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-length': String(size), 'x-upload-content-type': 'video/mp4' } });
  if (!init.ok) { const j = await init.json().catch(() => ({})); throw new Error(`Yuklashni boshlab bo'lmadi ${init.status}: ${j.error?.message || ''}`); }
  const location = init.headers.get('location');
  const put = await fetch(location, { method: 'PUT', duplex: 'half', body: Readable.toWeb(fs.createReadStream(file)),
    headers: { 'content-length': String(size), 'content-type': 'video/mp4' } });
  const j = await put.json().catch(() => ({}));
  if (!put.ok) throw new Error(`Yuklash xatosi ${put.status}: ${j.error?.message || ''}`);
  return j.id;
}
// YouTube allows 500 characters of tags in total
function fitTags(tags) {
  const out = []; let len = 0;
  for (const t of [...new Set((tags || []).map((x) => String(x).replace(/[<>,]/g, '').trim()).filter(Boolean))]) {
    const add = t.length + (t.includes(' ') ? 2 : 0) + (out.length ? 1 : 0);
    if (len + add > 480) break; out.push(t); len += add;
  }
  return out;
}

async function setThumbnail(videoId, jpg) {
  const r = await fetch('https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=' + videoId, {
    method: 'POST', body: fs.readFileSync(jpg), headers: { authorization: 'Bearer ' + (await accessToken()), 'content-type': 'image/jpeg' } });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(`Prevyu o'rnatilmadi ${r.status}: ${j.error?.message || ''} (kanal telefon orqali tasdiqlanganmi?)`); }
}

async function videoStats(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const j = await api('videos?part=statistics&id=' + ids.slice(i, i + 50).join(','));
    for (const v of j.items || []) out[v.id] = { views: Number(v.statistics.viewCount || 0), likes: Number(v.statistics.likeCount || 0), comments: Number(v.statistics.commentCount || 0) };
  }
  return out;
}

module.exports = { configured, connected, authUrl, checkState, finishAuth, disconnect, channelInfo, upload, setThumbnail, videoStats, fitTags };

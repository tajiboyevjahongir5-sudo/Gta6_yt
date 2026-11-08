// YouTube Data API v3: OAuth connection, resumable upload, custom thumbnail, statistics.
const fs = require('fs');
const crypto = require('crypto');
const { Readable } = require('stream');
const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, PUBLIC_URL, SECRET } = require('./config');
const { getSecret, setSecret, log } = require('./db');

// youtube = manage the channel (banner, description, keywords); upload + readonly for videos and stats
// force-ssl = read and answer comments; yt-analytics = watch time, retention, Shorts views for monetization progress
const SCOPES = ['https://www.googleapis.com/auth/youtube', 'https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl', 'https://www.googleapis.com/auth/yt-analytics.readonly'];
const redirectUri = () => `${PUBLIC_URL}/oauth/google/callback`;
// the app's Google OAuth client: entered once in the web app (stored in the DB), or GOOGLE_CLIENT_ID/SECRET env vars
function creds() {
  const g = getSecret('google');
  if (g?.id && g?.secret) return { id: g.id, secret: g.secret, source: 'app' };
  if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) return { id: GOOGLE_CLIENT_ID, secret: GOOGLE_CLIENT_SECRET, source: 'env' };
  return null;
}
const configured = () => !!(creds() && PUBLIC_URL);
function setCreds(id, secret) {
  id = String(id || '').trim(); secret = String(secret || '').trim();
  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(id)) throw new Error('Client ID noto\'g\'ri: u "...apps.googleusercontent.com" bilan tugashi kerak');
  if (secret.length < 10 || /\s/.test(secret)) throw new Error('Client secret noto\'g\'ri');
  setSecret('google', { id, secret });
}
const setupInfo = () => ({ redirectUri: PUBLIC_URL ? redirectUri() : '', publicUrl: PUBLIC_URL, hasCreds: !!creds(), source: creds()?.source || null,
  clientId: creds()?.id || '' });

// state = expiry.signature, so only links we issued can finish the OAuth flow
function authUrl() {
  const exp = Date.now() + 15 * 60 * 1000;
  const state = exp + '.' + crypto.createHmac('sha256', SECRET).update('oauth' + exp).digest('hex').slice(0, 32);
  const q = new URLSearchParams({ client_id: creds().id, redirect_uri: redirectUri(), response_type: 'code',
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
    body: new URLSearchParams({ client_id: creds().id, client_secret: creds().secret, ...params }) });
  const j = await r.json();
  if (!r.ok) throw new Error('Google token xatosi: ' + (j.error_description || j.error || r.status));
  return j;
}
async function finishAuth(code) {
  const t = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
  setSecret('yt', { refresh_token: t.refresh_token, access_token: t.access_token, scope: t.scope || '', expires_at: Date.now() + (t.expires_in - 60) * 1000 });
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
// channels connected before branding existed only granted upload/readonly
const canBrand = () => (getSecret('yt')?.scope || '').split(' ').includes('https://www.googleapis.com/auth/youtube');
const hasScope = (name) => (getSecret('yt')?.scope || '').split(' ').includes('https://www.googleapis.com/auth/' + name);
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
async function upload({ file, title, description, tags, privacy = 'public', publishAt, language = 'en', categoryId = '24' }) {
  const size = fs.statSync(file).size;
  const status = { privacyStatus: publishAt ? 'private' : privacy, selfDeclaredMadeForKids: false, embeddable: true };
  if (publishAt) status.publishAt = new Date(publishAt).toISOString();
  const meta = { snippet: { title: title.slice(0, 100), description: description.slice(0, 4900), tags: fitTags(tags),
    categoryId: String(categoryId), defaultLanguage: language, defaultAudioLanguage: language }, status };
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

// banner + About text + keywords. channels.update replaces the whole brandingSettings part, so merge with what's there.
async function applyBranding({ description, keywords, bannerFile }) {
  if (!connected()) throw new Error('YouTube kanal ulanmagan');
  if (!canBrand()) throw new Error('Kanalni qayta ulang: brend uchun "kanalni boshqarish" ruxsati kerak');
  const cur = await api('channels?part=brandingSettings&mine=true');
  const ch = cur.items?.[0]; if (!ch) throw new Error('Kanal topilmadi');
  const bs = ch.brandingSettings || {}; bs.channel = bs.channel || {};
  if (description) bs.channel.description = description.slice(0, 1000);
  if (keywords?.length) bs.channel.keywords = keywords.map((k) => (/\s/.test(k) ? `"${k.replace(/"/g, '')}"` : k)).join(' ').slice(0, 500);
  if (bannerFile) {
    const r = await fetch('https://www.googleapis.com/upload/youtube/v3/channelBanners/insert?uploadType=media', {
      method: 'POST', body: fs.readFileSync(bannerFile), headers: { authorization: 'Bearer ' + (await accessToken()), 'content-type': 'image/jpeg' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Banner yuklanmadi ${r.status}: ${j.error?.message || ''}`);
    bs.image = { ...(bs.image || {}), bannerExternalUrl: j.url };
  }
  await api('channels?part=brandingSettings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: ch.id, brandingSettings: bs }) });
  return ch.id;
}

// every video on the connected channel with its live statistics (uploads playlist → videos.list, ~1 quota unit per 50 videos)
const isoSec = (d) => { const m = String(d || '').match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/) || [];
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0); };
async function channelVideos(max = 500) {
  const ch = await api('channels?part=contentDetails,statistics,snippet&mine=true');
  const c = ch.items?.[0]; const up = c?.contentDetails?.relatedPlaylists?.uploads;
  if (!up) return { channel: null, videos: [] };
  const ids = []; let page = '';
  do {
    const j = await api(`playlistItems?part=contentDetails&maxResults=50&playlistId=${up}${page ? '&pageToken=' + page : ''}`);
    for (const it of j.items || []) ids.push(it.contentDetails.videoId);
    page = j.nextPageToken;
  } while (page && ids.length < max);
  const videos = [];
  for (let i = 0; i < ids.length; i += 50) {
    const j = await api('videos?part=snippet,statistics,contentDetails,status&id=' + ids.slice(i, i + 50).join(','));
    for (const v of j.items || []) videos.push({ id: v.id, title: v.snippet.title,
      thumb: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url || '', published: Date.parse(v.snippet.publishedAt),
      views: +(v.statistics.viewCount || 0), likes: +(v.statistics.likeCount || 0), comments: +(v.statistics.commentCount || 0),
      duration: isoSec(v.contentDetails.duration), privacy: v.status?.privacyStatus || '' });
  }
  const channel = { id: c.id, title: c.snippet.title, thumb: c.snippet.thumbnails?.default?.url, subscribers: +(c.statistics.subscriberCount || 0),
    views: +(c.statistics.viewCount || 0), videos: +(c.statistics.videoCount || 0), at: Date.now() };
  setSecret('channel', channel);
  return { channel, videos };
}

// comments: newest threads of one video; reply to a top-level comment
async function commentThreads(videoId, max = 50) {
  const j = await api(`commentThreads?part=snippet,replies&videoId=${videoId}&maxResults=${max}&order=time&textFormat=plainText`);
  return (j.items || []).map((t) => { const c = t.snippet.topLevelComment.snippet;
    return { id: t.snippet.topLevelComment.id, videoId, text: c.textOriginal || c.textDisplay || '', author: c.authorDisplayName,
      authorChannel: c.authorChannelId?.value || '', likes: c.likeCount || 0, at: Date.parse(c.publishedAt), replies: t.snippet.totalReplyCount || 0,
      replyAuthors: (t.replies?.comments || []).map((r) => r.snippet.authorChannelId?.value || '') }; });
}
async function replyComment(parentId, text) {
  return api('comments?part=snippet', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ snippet: { parentId, textOriginal: text } }) });
}
// YouTube Analytics API v2 (needs the API enabled in the Google Cloud project + the yt-analytics scope)
async function analytics(params) {
  const q = new URLSearchParams({ ids: 'channel==MINE', ...params });
  const r = await fetch('https://youtubeanalytics.googleapis.com/v2/reports?' + q, { headers: { authorization: 'Bearer ' + (await accessToken()) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`YouTube Analytics ${r.status}: ${j.error?.message || ''}`); e.status = r.status; throw e; }
  const cols = (j.columnHeaders || []).map((c) => c.name);
  return (j.rows || []).map((row) => Object.fromEntries(row.map((v, i) => [cols[i], v])));
}

module.exports = { commentThreads, replyComment, analytics, hasScope, channelVideos, setCreds, setupInfo, canBrand, applyBranding, configured, connected, authUrl, checkState, finishAuth, disconnect, channelInfo, upload, setThumbnail, videoStats, fitTags };

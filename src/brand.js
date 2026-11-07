// Channel branding kit: name ideas, @handle ideas, SEO description + keywords, banner (2560x1440) and logo (800x800).
// Banner + description + keywords can be applied through the API; name, handle and profile picture can't
// (YouTube doesn't allow it) — the kit gives ready files + copy buttons for YouTube Studio.
const fs = require('fs');
const path = require('path');
const { run } = require('./util');
const { FFMPEG, FONT, DATA_DIR } = require('./config');
const { db, getSecret, setSecret, getSettings, log } = require('./db');
const ai = require('./ai');

const DIR = path.join(DATA_DIR, 'brand');
const esc = (s) => String(s).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
const fontOpt = () => (FONT ? `fontfile='${esc(FONT)}':` : '');
const textFile = (name, text) => { const f = path.join(DIR, name); fs.writeFileSync(f, text); return f; };

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['names', 'handles', 'description', 'keywords', 'tagline', 'logo_text', 'banner_title', 'banner_subtitle'],
  properties: {
    names: { type: 'array', items: { type: 'string' }, description: '5 channel name ideas, max 30 chars, catchy, easy to search' },
    handles: { type: 'array', items: { type: 'string' }, description: '5 @handle ideas without @, 3-30 chars, letters/digits/._-' },
    description: { type: 'string', description: 'channel "About" text, 600-1000 chars, SEO-friendly, what viewers get + upload schedule' },
    keywords: { type: 'array', items: { type: 'string' }, description: '10-15 channel keywords' },
    tagline: { type: 'string', description: 'max 40 chars' },
    logo_text: { type: 'string', description: '1-2 characters monogram for the logo' },
    banner_title: { type: 'string', description: 'channel name as written on the banner, max 22 chars' },
    banner_subtitle: { type: 'string', description: 'max 45 chars, e.g. what and when you upload' },
  },
};

// what the channel posts: the owner's topic, or the subjects the AI found in the processed videos
function topic(s) {
  if (s.game) return s.game;
  const subs = db.prepare("SELECT meta FROM jobs WHERE meta IS NOT NULL ORDER BY id DESC LIMIT 20").all()
    .map((r) => { try { return JSON.parse(r.meta).subject; } catch (e) { return null; } }).filter(Boolean);
  const top = Object.entries(subs.reduce((a, x) => ((a[x] = (a[x] || 0) + 1), a), {})).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : 'Gaming';
}
function templateKit(s) {
  const g = topic(s), base = s.channelName && s.channelName !== 'Lahza' ? s.channelName : `${g.replace(/\s+/g, '')} Moments`;
  const slug = base.replace(/[^A-Za-z0-9]/g, '');
  return {
    names: [base, `${g} Highlights`, `${g} Daily`, `${g} Clips`, `${g} Madness`],
    handles: [slug, `${slug}Daily`, `${g.replace(/\s+/g, '')}Highlights`, `${g.replace(/\s+/g, '')}Clips`, `${g.replace(/\s+/g, '')}Madness`].map((h) => h.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 30)),
    description: `The funniest, wildest and most epic ${g} moments from the biggest streams — cut, edited and uploaded every day.\n\n` +
      `🎬 Highlight compilations\n📱 Daily Shorts\n🔥 The funniest, wildest and most epic moments\n\nNew videos every day. Subscribe so you don't miss the best ${g} clips!`,
    keywords: [g, `${g} funny moments`, `${g} highlights`, `${g} best moments`, `${g} clips`, 'highlights', 'best moments', 'funny moments', 'shorts'],
    tagline: `Best ${g} moments, every day`,
    logo_text: base.split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).slice(0, 2).join('') || 'L',
    banner_title: base.toUpperCase().slice(0, 22),
    banner_subtitle: 'NEW CLIPS EVERY DAY',
  };
}

async function aiKit(s, hint) {
  if (!ai.enabled() || !s.useAI) return null;
  const r = await ai.generateJSON({ schema: SCHEMA, maxTokens: 4000, parts: [{ text:
    `Create a YouTube channel brand for a channel that posts ${topic(s)} highlights from long videos and streams: long compilations and Shorts ` +
    `(funny moments, fails, epic plays). Audience: worldwide. ` +
    `Don't use official brand or company names as the channel name so it isn't confused with an official channel.` +
    (hint ? `\nOwner's wishes: ${hint}` : '') + `\nWrite everything in ${ai.LANG[s.language] || 'English'}.` }] });
  const k = r?.data;
  return k && Array.isArray(k.names) && k.names.length ? k : null;
}

// a clean frame (no burned-in text) from the best compilation makes the banner look like the channel's content
async function bestFrame() {
  const c = db.prepare("SELECT file, duration FROM clips WHERE kind = 'long' AND file IS NOT NULL ORDER BY score DESC LIMIT 1").get();
  if (!c || !fs.existsSync(c.file)) return null;
  const out = path.join(DIR, 'bg.jpg');
  try {
    // skip the first seconds: the moment number caption is drawn there
    await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(5, (c.duration || 20) * 0.35)), '-i', c.file, '-frames:v', '1', '-q:v', '2', out]);
    return out;
  } catch (e) { return null; }
}

async function renderBanner(kit, out, accent) {
  const t1 = textFile('b_title.txt', kit.banner_title), t2 = textFile('b_sub.txt', kit.banner_subtitle.toUpperCase());
  const bg = await bestFrame();
  const inputs = bg ? ['-i', bg] : ['-f', 'lavfi', '-i', 'gradients=s=2560x1440:c0=0x0b0b12:c1=0x2b0f4a:c2=0xb3123f:nb_colors=3:x0=0:y0=1440:x1=2560:y1=0:d=1'];
  const ac = accent.replace('#', '0x');
  // everything important sits in YouTube's 1546x423 safe area (centre), which is what phones show
  const vf = (bg ? 'scale=2560:1440:force_original_aspect_ratio=increase,crop=2560:1440,boxblur=18:2,eq=brightness=-0.22:saturation=1.3,' : '') +
    `drawbox=x=0:y=508:w=iw:h=423:color=black@0.35:t=fill,` +
    `drawtext=${fontOpt()}textfile='${esc(t1)}':fontsize=170:fontcolor=white:borderw=10:bordercolor=black:x=(w-text_w)/2:y=560,` +
    `drawbox=x=(iw-360)/2:y=765:w=360:h=12:color=${ac}:t=fill,` +
    `drawtext=${fontOpt()}textfile='${esc(t2)}':fontsize=62:fontcolor=${ac}:borderw=5:bordercolor=black:x=(w-text_w)/2:y=810`;
  await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...inputs, '-frames:v', '1', '-vf', vf, '-q:v', '2', out]);
}

async function renderLogo(kit, out, accent) {
  const t = textFile('l_text.txt', kit.logo_text.toUpperCase().slice(0, 2));
  const ac = accent.replace('#', '0x');
  // YouTube shows the logo as a circle: keep the monogram inside it, accent ring at the edge of the circle
  const fc = `gradients=s=800x800:c0=0x14141c:c1=0x3a0f5a:x0=0:y0=0:x1=800:y1=800:d=1[bg];` +
    `color=c=${ac}:s=800x800:d=1,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(between(hypot(X-400,Y-400),352,378),255,0)'[ring];` +
    `[bg][ring]overlay=0:0,drawtext=${fontOpt()}textfile='${esc(t)}':fontsize=${kit.logo_text.length > 1 ? 330 : 420}:fontcolor=${ac}:borderw=14:bordercolor=black:x=(w-text_w)/2:y=(h-text_h)/2-10`;
  await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-filter_complex', fc, '-frames:v', '1', out]);
}

const files = () => ({ banner: path.join(DIR, 'banner.jpg'), logo: path.join(DIR, 'logo.png') });
function get() { const k = getSecret('brand'); if (!k) return null; const f = files(); return { ...k, hasBanner: fs.existsSync(f.banner), hasLogo: fs.existsSync(f.logo) }; }

async function generate({ hint = '' } = {}) {
  fs.mkdirSync(DIR, { recursive: true });
  const s = getSettings();
  const kit = { ...templateKit(s), ...((await aiKit(s, hint)) || {}), createdAt: Date.now(), ai: false };
  kit.ai = !!ai.enabled() && s.useAI;
  kit.handles = kit.handles.map((h) => h.replace(/^@/, '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 30)).filter((h) => h.length >= 3);
  kit.chosen = kit.names[0];
  await render(kit);
  setSecret('brand', kit);
  log(`Kanal brendi tayyorlandi: ${kit.names.slice(0, 3).join(', ')}`);
  return get();
}
async function render(kit) { const f = files(); const s = getSettings(); await renderBanner(kit, f.banner, s.accent); await renderLogo(kit, f.logo, s.accent); }
async function update(patch) {
  const kit = getSecret('brand'); if (!kit) throw new Error('Avval brend yarating');
  for (const k of ['chosen', 'description', 'banner_title', 'banner_subtitle', 'logo_text', 'tagline']) if (typeof patch[k] === 'string') kit[k] = patch[k].slice(0, k === 'description' ? 1000 : 60);
  if (Array.isArray(patch.keywords)) kit.keywords = patch.keywords.slice(0, 30);
  if (['banner_title', 'banner_subtitle', 'logo_text'].some((k) => k in patch)) await render(kit);
  setSecret('brand', kit);
  return get();
}

module.exports = { generate, get, update, files };

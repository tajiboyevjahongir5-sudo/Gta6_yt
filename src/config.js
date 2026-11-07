// Environment config + a tiny .env loader (no dependency).
const fs = require('fs');
const path = require('path');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const env = process.env;
// Railway: a volume's mount path is given in RAILWAY_VOLUME_MOUNT_PATH; without a volume files are lost on every deploy
const DATA_DIR = path.resolve(env.DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data'));

function findFont() {
  if (env.FONT_PATH && fs.existsSync(env.FONT_PATH)) return env.FONT_PATH;
  for (const f of ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf']) if (fs.existsSync(f)) return f;
  return '';
}

module.exports = {
  PORT: Number(env.PORT || 3000),
  // Railway gives the generated domain in RAILWAY_PUBLIC_DOMAIN (without https://)
  PUBLIC_URL: String(env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + env.RAILWAY_PUBLIC_DOMAIN : '')).replace(/\/+$/, ''),
  DATA_DIR,
  WORK_DIR: path.join(DATA_DIR, 'work'),
  OUT_DIR: path.join(DATA_DIR, 'out'),
  BOT_TOKEN: env.BOT_TOKEN || '',
  ADMIN_IDS: String(env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  WEBAPP_PASSWORD: env.WEBAPP_PASSWORD || '',
  GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET || '',
  ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY || '',
  AI_MODEL: env.AI_MODEL || 'claude-opus-5-5',
  GEMINI_API_KEY: env.GEMINI_API_KEY || '',
  GEMINI_MODEL: env.GEMINI_MODEL || '',
  FONT: findFont(),
  YTDLP: env.YTDLP_BIN || 'yt-dlp',
  FFMPEG: env.FFMPEG_BIN || 'ffmpeg',
  FFPROBE: env.FFPROBE_BIN || 'ffprobe',
  // secret used to sign web-app sessions and OAuth state
  SECRET: env.SESSION_SECRET || require('crypto').createHash('sha256').update('lahza:' + (env.BOT_TOKEN || 'dev') + (env.GOOGLE_CLIENT_SECRET || '')).digest('hex'),
};

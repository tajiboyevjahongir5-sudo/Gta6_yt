// SQLite storage (node:sqlite, built into Node 22).
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { DATA_DIR, WORK_DIR, OUT_DIR } = require('./config');

for (const d of [DATA_DIR, WORK_DIR, OUT_DIR]) fs.mkdirSync(d, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'lahza.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, name TEXT, keyword TEXT DEFAULT '',
  min_minutes INTEGER DEFAULT 20, permission INTEGER DEFAULT 0, credit TEXT DEFAULT '',
  active INTEGER DEFAULT 1, seen TEXT DEFAULT '[]', last_checked INTEGER, created_at INTEGER);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY, source_id INTEGER, url TEXT NOT NULL, video_id TEXT, title TEXT, author TEXT, author_url TEXT,
  duration REAL, status TEXT DEFAULT 'queued', progress REAL DEFAULT 0, step TEXT DEFAULT '', error TEXT,
  created_at INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS clips (
  id INTEGER PRIMARY KEY, job_id INTEGER, kind TEXT, file TEXT, thumb TEXT, segments TEXT, duration REAL, score REAL,
  title TEXT, description TEXT, tags TEXT, thumb_text TEXT, status TEXT DEFAULT 'draft', privacy TEXT,
  youtube_id TEXT, error TEXT, scheduled_at INTEGER, published_at INTEGER,
  views INTEGER DEFAULT 0, likes INTEGER DEFAULT 0, comments INTEGER DEFAULT 0, stats_at INTEGER, created_at INTEGER);
CREATE TABLE IF NOT EXISTS stats_daily (day TEXT, clip_id INTEGER, views INTEGER, likes INTEGER, comments INTEGER,
  PRIMARY KEY (day, clip_id));
CREATE TABLE IF NOT EXISTS channel_daily (day TEXT PRIMARY KEY, subscribers INTEGER, views INTEGER, videos INTEGER);
CREATE TABLE IF NOT EXISTS channel_videos (id TEXT PRIMARY KEY, title TEXT, thumb TEXT, published INTEGER, views INTEGER, likes INTEGER,
  comments INTEGER, duration INTEGER, privacy TEXT, updated INTEGER);
CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY, ts INTEGER, level TEXT, msg TEXT);
`);

// columns added after the first release
for (const sql of ['ALTER TABLE jobs ADD COLUMN meta TEXT', 'ALTER TABLE clips ADD COLUMN category TEXT']) { try { db.exec(sql); } catch (e) { /* already there */ } }

const DEFAULTS = {
  autoPublish: false,          // false: each clip waits for your approval in the bot / web app
  privacy: 'public',           // public | unlisted | private
  publishTimes: ['13:00', '19:00'], // Tashkent time slots for scheduled uploads
  dailyLimit: 6,               // YouTube API quota allows ~6 uploads a day by default
  makeLong: true,              // compilation video (horizontal)
  makeShorts: true,            // vertical Shorts
  shortsPerVideo: 3,
  highlightCount: 10,          // how many moments go into the compilation
  targetMinutes: 10,           // compilation length goal
  clipBefore: 12, clipAfter: 8, // seconds kept around each peak
  quality: 1080,               // download height: 720 | 1080 | 1440
  lowQualityFallback: false,   // if YouTube refuses every HD way (403), allow a 360p download instead of failing
  language: 'en',              // video language: titles, descriptions, tags, subtitles (en = speech translated to English)
  game: '',                    // topic hint for the AI ('' = detect from each video)
  channelName: 'Lahza',
  defaultTags: ['highlights', 'best moments'],
  descriptionFooter: '🔔 Subscribe for the best moments every day!',
  accent: '#FFD400',           // thumbnail text colour
  keepSource: false,           // delete downloaded stream after rendering
  useAI: true,
  aiProvider: 'auto',          // auto (Gemini first — free, then Claude) | gemini | claude
  aiWatchMaxMinutes: 180,      // Gemini watches the whole YouTube video itself if it is at most this long
  subtitles: true,             // word-by-word captions on Shorts (needs python3 + faster-whisper)
  whisperModel: 'small',       // tiny | base | small | medium (bigger = more accurate, slower)
  subtitleLang: 'auto',        // language the streamer SPEAKS: auto | uz | ru | en
  subtitleStyle: 'pop',        // pop (words appear as spoken, bouncy) | clean (italic white phrase) | karaoke (bold caps, spoken word yellow)
  effects: true,               // sound effects + animated emojis
};
function getSettings() {
  const s = { ...DEFAULTS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) { try { s[r.key] = JSON.parse(r.value); } catch (e) {} }
  return s;
}
function setSettings(patch) {
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) if (k in DEFAULTS || k.startsWith('_')) up.run(k, JSON.stringify(v));
  return getSettings();
}
const getSecret = (k) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get('_' + k); return r ? JSON.parse(r.value) : null; };
const setSecret = (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('_' + k, JSON.stringify(v));

function log(msg, level = 'info') {
  console.log(`[${level}] ${msg}`);
  db.prepare('INSERT INTO logs (ts, level, msg) VALUES (?, ?, ?)').run(Date.now(), level, String(msg).slice(0, 1000));
  db.prepare('DELETE FROM logs WHERE id < (SELECT MAX(id) - 500 FROM logs)').run();
}

// small row helpers
const parseClip = (c) => c && ({ ...c, tags: JSON.parse(c.tags || '[]'), segments: JSON.parse(c.segments || '[]') });
const updateRow = (table, id, patch) => {
  const keys = Object.keys(patch); if (!keys.length) return;
  db.prepare(`UPDATE ${table} SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => (patch[k] === undefined ? null : patch[k] !== null && typeof patch[k] === 'object' ? JSON.stringify(patch[k]) : patch[k])), id);
};

module.exports = { db, DEFAULTS, getSettings, setSettings, getSecret, setSecret, log, parseClip, updateRow };

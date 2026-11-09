// YouTube Data API quota: 10,000 units a day by default (resets at midnight Pacific time). An upload costs 1,600,
// a comment reply 50, a search 100, most reads 1. The bot counts what it spends so that uploads always come first:
// replies and searches only use what is left after today's planned uploads are paid for.
const { db, getSettings } = require('./db');

db.exec('CREATE TABLE IF NOT EXISTS quota (day TEXT PRIMARY KEY, used INTEGER DEFAULT 0)');
const COST = { upload: 1600, thumbnail: 50, reply: 50, search: 100, write: 50, read: 1 };
// the quota day is the Pacific-time date
const day = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
const limit = () => Number(getSettings().quotaLimit) || 10000;
const used = () => db.prepare('SELECT used FROM quota WHERE day = ?').get(day())?.used || 0;
function spend(kind, n = 1) {
  const units = (COST[kind] || 1) * n;
  db.prepare('INSERT INTO quota (day, used) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET used = used + excluded.used').run(day(), units);
  return units;
}
// YouTube said "quota exceeded": our count was too low (other apps on the same key, restarts) -> mark the day as spent
const exhausted = () => db.prepare('INSERT INTO quota (day, used) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET used = MAX(used, excluded.used)').run(day(), limit());
// units still to keep for uploads planned for the rest of the (quota) day
function reserve() {
  const s = getSettings();
  const start = Date.now() - 24 * 3600000;
  const doneToday = db.prepare('SELECT COUNT(*) n FROM clips WHERE published_at >= ?').get(start).n;
  const waiting = db.prepare("SELECT COUNT(*) n FROM clips WHERE status = 'approved' AND (scheduled_at IS NULL OR scheduled_at <= ?)").get(Date.now() + 24 * 3600000).n;
  const slots = Math.max(0, Math.min(waiting, (s.dailyLimit || 6) - doneToday));
  return slots * (COST.upload + COST.thumbnail);
}
const left = () => Math.max(0, limit() - used());
// may we spend on something that is not an upload (replies, searches)?
const canExtra = (kind, n = 1) => used() + (COST[kind] || 1) * n + reserve() <= limit();
const canUpload = () => used() + COST.upload + COST.thumbnail <= limit();
const info = () => ({ day: day(), used: used(), limit: limit(), left: left(), reserve: reserve() });

module.exports = { COST, spend, used, left, limit, canExtra, canUpload, exhausted, info };

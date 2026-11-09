// Fast checks of the logic that decides what a Short looks like and what the bot may spend. No network, no ffmpeg.
// Run: npm test
const os = require('os'); const fs = require('fs'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lahza-test-'));
process.env.BOT_TOKEN = '';
const test = require('node:test');
const assert = require('node:assert/strict');

const analyze = require('../src/analyze');
const subs = require('../src/subtitles');
const pipeline = require('../src/pipeline');
const style = require('../src/style');
const quota = require('../src/quota');
const render = require('../src/render');
const { db, setSettings } = require('../src/db');

// a 10-minute "stream": calm, a build-up with some talking, a big moment at 295 s and its aftermath
const score = Array.from({ length: 600 }, (_, i) => 0.3 + (i > 290 && i < 300 ? 3 : 0) + (i >= 300 && i < 312 ? 1.5 : 0) + (i % 37 < 4 ? 0.8 : 0));
const total = (parts) => parts.reduce((t, p) => t + p.end - p.start, 0);

test('story Short: keeps the key moment, runs on after it, reaches the target length', () => {
  const after = analyze.storyAfter(score, 295, 600);
  assert.ok(after >= 6 && after <= 22, 'aftermath 6..22 s, got ' + after);
  const parts = analyze.storyParts(score, 295, 600, { target: 45, after });
  assert.ok(total(parts) >= 30 && total(parts) <= 60, 'length ' + total(parts));
  const last = parts[parts.length - 1];
  assert.ok(last.start <= 295 && last.end >= 295 + after - 1, 'ends after the aftermath');
  for (let i = 1; i < parts.length; i++) assert.ok(parts[i].start >= parts[i - 1].end, 'parts in order, no overlap');
});

test('story Short: little build-up -> one continuous piece of the target length, never a 15-second stub', () => {
  const parts = analyze.storyParts(score, 295, 600, { target: 30, after: 20 });
  assert.equal(parts.length, 1);
  assert.ok(total(parts) >= 29);
});

test('subtitles: every word gets a time, in order, inside its speech range', () => {
  const words = [{ word: 'salam', start: 1.0, end: 1.4 }, { word: 'dostlar', start: 1.5, end: 2.0 }, { word: 'bugün', start: 2.6, end: 2.9 }];
  const toks = ['Salom', "do'stlar,", 'bugun', 'yangi', "o'yin"].map((w) => ({ word: w, a: 0.9, b: 4.0 }));
  const out = subs.alignTokens(toks, words);
  assert.equal(out.length, toks.length);
  out.forEach((w, i) => { assert.ok(w.end > w.start); if (i) assert.ok(w.start >= out[i - 1].start); assert.ok(w.start >= 0.9 - 0.01 && w.start <= 4.0); });
  assert.ok(Math.abs(out[0].start - 1.0) < 0.15, 'first word where it was heard');
});

test('sources: a channel link is watched as the channel (videos + streams), never its Shorts tab', () => {
  assert.equal(pipeline.normalizeSourceUrl('https://www.youtube.com/@streamer/shorts'), 'https://www.youtube.com/@streamer');
  assert.equal(pipeline.normalizeSourceUrl('https://youtube.com/@a.b/streams?x=1'), 'https://youtube.com/@a.b');
  assert.equal(pipeline.normalizeSourceUrl('https://youtu.be/xyz'), 'https://youtu.be/xyz');
});

test('proxy: both common formats are accepted, nonsense is refused', () => {
  assert.equal(pipeline.normalizeProxy('1.2.3.4:8080:user:pass'), 'http://user:pass@1.2.3.4:8080');
  assert.equal(pipeline.normalizeProxy('socks5://h:1080'), 'socks5://h:1080');
  assert.throws(() => pipeline.normalizeProxy('ftp://x'));
});

test('learned style: never makes Shorts shorter than 30 s', () => {
  assert.equal(style.overrides({ avgLength: 17, hook: 'none', zoom: 'none' }).shortTarget, 30);
  assert.equal(style.overrides({ avgLength: 90, hook: 'climax_first', zoom: 'strong' }).shortTarget, 58);
  assert.deepEqual(style.channelRef('https://www.youtube.com/@pro.clips/shorts'), { handle: '@pro.clips' });
  assert.equal(style.channelRef('CS2'), null);
});

test('quota: uploads come first, replies only from what is left', () => {
  setSettings({ quotaLimit: 10000, dailyLimit: 6 });
  db.exec('DELETE FROM quota');
  assert.ok(quota.canUpload());
  quota.spend('upload', 5); // 8,000
  assert.ok(quota.canUpload(), 'a 6th upload (1,650) still fits');
  quota.spend('upload'); quota.spend('thumbnail'); // 9,650
  assert.ok(!quota.canUpload(), 'no room for a 7th');
  assert.ok(quota.canExtra('reply', 5) && !quota.canExtra('reply', 10), '250 units fit, 500 do not');
  quota.exhausted();
  assert.equal(quota.left(), 0);
});

test('webcam layout: crops stay inside the frame and have even sizes', () => {
  const c = render.facecamCrops({ x: 84, y: 0, w: 712, h: 394, face: [334, 63, 246, 246], width: 1920, height: 1080 });
  for (const r of [c.cam, c.game]) { assert.equal(r.w % 2, 0); assert.equal(r.h % 2, 0); assert.ok(r.x >= 0 && r.x + r.w <= 1920); }
  assert.ok(c.cam.y >= 0 && c.cam.y + c.cam.h <= 1080);
  assert.equal(c.camH + c.gameH, 1920);
});

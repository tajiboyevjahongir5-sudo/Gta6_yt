// Finds the most exciting moments of a long stream without watching it:
//  1. loudness per second (screams, laughs, explosions, sirens get loud suddenly)
//  2. scene-cut density (chases, crashes, fights = lots of fast cuts / motion)
// Each second gets a score; peaks become candidate segments.
const { run } = require('./util');
const { FFMPEG, FFPROBE } = require('./config');

async function probe(file) {
  const { out } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(out);
  const v = (j.streams || []).find((s) => s.codec_type === 'video') || {};
  return { duration: Number(j.format?.duration || 0), width: v.width || 0, height: v.height || 0,
    hasAudio: (j.streams || []).some((s) => s.codec_type === 'audio') };
}

// RMS loudness (dB) for every second of audio
async function loudness(file, duration, onProgress) {
  const vals = [];
  await run(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-vn', '-sn',
    '-af', 'aresample=8000,asetnsamples=n=8000:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
    '-f', 'null', '-'], {
    onLine: (l) => {
      const m = l.match(/pts_time:([\d.]+)/);
      if (m && onProgress && duration) onProgress(Math.min(1, Number(m[1]) / duration));
      const v = l.match(/RMS_level=(-?[\d.]+|-inf)/);
      if (v) vals.push(v[1] === '-inf' ? -90 : Math.max(-90, Number(v[1])));
    },
  });
  return vals;
}

// timestamps of scene cuts, decoded from keyframes only (fast even for 6-hour streams)
async function sceneCuts(file, onProgress, duration) {
  const cuts = [];
  await run(FFMPEG, ['-hide_banner', '-nostats', '-skip_frame', 'nokey', '-i', file, '-an', '-sn',
    '-vf', "scale=160:-2,select='gt(scene,0.30)',metadata=print:file=-", '-f', 'null', '-'], {
    onLine: (l) => {
      const m = l.match(/pts_time:([\d.]+)/);
      if (m) { cuts.push(Number(m[1])); if (onProgress && duration) onProgress(Math.min(1, Number(m[1]) / duration)); }
    },
  });
  return cuts;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
function smooth(a, r) {
  const out = new Array(a.length).fill(0); let sum = 0; const q = [];
  for (let i = 0; i < a.length + r; i++) {
    if (i < a.length) { sum += a[i]; q.push(a[i]); }
    if (q.length > 2 * r + 1) sum -= q.shift();
    const c = i - r; if (c >= 0 && c < a.length) out[c] = sum / q.length;
  }
  return out;
}

// score every second: loudness above the local norm + sudden jumps + scene-cut density
function scoreSeconds(rms, cuts, duration) {
  const n = Math.max(rms.length, Math.ceil(duration));
  const loud = Array.from({ length: n }, (_, i) => rms[i] ?? -90);
  // local baseline: median of the surrounding 3 minutes (streams get louder/quieter over hours)
  const base = new Array(n); const W = 90;
  for (let i = 0; i < n; i += 15) { const m = median(loud.slice(Math.max(0, i - W), i + W)); for (let k = i; k < Math.min(n, i + 15); k++) base[k] = m; }
  const spread = Math.max(3, median(loud.map((v, i) => Math.abs(v - base[i]))) * 1.5);
  const cutDensity = new Array(n).fill(0);
  for (const t of cuts) { const i = Math.floor(t); for (let k = i - 5; k <= i + 5; k++) if (k >= 0 && k < n) cutDensity[k] += 1; }
  const meanCut = cutDensity.reduce((a, b) => a + b, 0) / n || 0.0001;
  const score = new Array(n);
  for (let i = 0; i < n; i++) {
    const above = Math.max(0, (loud[i] - base[i]) / spread);
    const jump = i > 2 ? Math.max(0, (loud[i] - Math.min(loud[i - 1], loud[i - 2], loud[i - 3])) / spread) : 0;
    const action = Math.min(3, cutDensity[i] / (meanCut * 3));
    score[i] = loud[i] < -60 ? 0 : above * 1.0 + jump * 0.6 + action * 0.5;
  }
  return smooth(score, 2);
}

// pick the strongest non-overlapping moments, spread across the whole stream
function pickSegments(score, { count = 10, before = 12, after = 8, duration, skipStart = 60, skipEnd = 30 }) {
  const n = score.length; const taken = new Uint8Array(n); const segs = [];
  const order = score.map((s, i) => [s, i]).filter(([, i]) => i > skipStart && i < duration - skipEnd).sort((a, b) => b[0] - a[0]);
  const gap = Math.max(before + after + 10, Math.floor(duration / (count * 6)));
  for (const [s, i] of order) {
    if (segs.length >= count) break;
    if (s <= 0.3 && segs.length) break;
    if (taken[i]) continue;
    const start = Math.max(0, i - before), end = Math.min(duration, i + after);
    segs.push({ start, end, peak: i, score: Number(s.toFixed(3)) });
    for (let k = Math.max(0, i - gap); k < Math.min(n, i + gap); k++) taken[k] = 1;
  }
  return segs;
}

async function findHighlights(file, opts, onProgress = () => {}) {
  const info = await probe(file);
  if (!info.duration) throw new Error('Video davomiyligini aniqlab bo\'lmadi');
  const rms = info.hasAudio ? await loudness(file, info.duration, (p) => onProgress(p * 0.6)) : [];
  let cuts = [];
  try { cuts = await sceneCuts(file, (p) => onProgress(0.6 + p * 0.4), info.duration); } catch (e) { /* audio alone is enough */ }
  const score = scoreSeconds(rms, cuts, info.duration);
  // short video (e.g. sent to the bot): the whole thing is one moment -> one Short
  if (info.duration <= 75) {
    let peak = 0; score.forEach((v, i) => { if (v > score[peak]) peak = i; });
    onProgress(1);
    return { info, candidates: [{ start: 0, end: Math.min(info.duration, 58), peak: Math.min(peak, 57), score: Number((score[peak] || 1).toFixed(3)) }], curve: downsample(score, 300), score };
  }
  // collect extra candidates so the AI can re-rank them; intros/outros skipped in proportion to the length
  const candidates = pickSegments(score, { ...opts, count: Math.max(opts.count * 2, 12), duration: info.duration,
    skipStart: Math.min(60, info.duration * 0.05), skipEnd: Math.min(30, info.duration * 0.03) });
  onProgress(1);
  return { info, candidates, curve: downsample(score, 300), score };
}
const downsample = (a, k) => { const step = Math.max(1, Math.ceil(a.length / k)); const o = [];
  for (let i = 0; i < a.length; i += step) o.push(Number(Math.max(...a.slice(i, i + step)).toFixed(2))); return o; };

// "Story" Short like a human editor makes: take the build-up before the climax (up to ~2.5 min), keep the
// seconds with action/voice, cut the dead time (jump cuts), always keep the climax and the reaction after it.
// Returns parts [{start,end}] in source seconds, in order, totalling ~target seconds (or null if too quiet).
function storyParts(score, peak, duration, { target = 55, lookback = 150, after = 5, core = 9, minPart = 3, pad = 0.4 } = {}) {
  const w0 = Math.max(0, Math.floor(peak - lookback)), w1 = Math.min(Math.floor(duration), Math.ceil(peak + after));
  const coreStart = Math.max(w0, peak - core);
  const sm = (i) => (((score[i - 1] || 0) + 2 * (score[i] || 0) + (score[i + 1] || 0)) / 4);
  const secs = []; for (let i = w0; i < coreStart; i++) secs.push({ i, v: sm(i) });
  const budget = target - (w1 - coreStart);
  // too little build-up to cut: one continuous piece of the target length that ends after the reaction
  if (budget < 8 || secs.length < 10) return [{ start: +Math.max(0, peak + after - target).toFixed(2), end: +Math.min(duration, peak + after).toFixed(2) }];
  // pick the strongest seconds of the build-up until the budget is filled (in runs, so cuts aren't too choppy)
  const keep = new Uint8Array(w1 + 2);
  for (let i = coreStart; i < w1; i++) keep[i] = 1;
  let used = 0;
  for (const { i } of [...secs].sort((a, b) => b.v - a.v)) {
    if (used >= budget) break;
    // whole sentences / actions, not 2-second crumbs: take 4-second runs so the story stays understandable
    for (let k = Math.max(w0, i - 1); k < Math.min(coreStart, i + 3); k++) if (!keep[k]) { keep[k] = 1; used++; }
  }
  // seconds -> parts; drop crumbs, bridge tiny gaps
  let parts = []; let cur = null;
  for (let i = w0; i <= w1; i++) {
    if (keep[i] && i < w1) { if (!cur) cur = { start: i, end: i + 1 }; else cur.end = i + 1; }
    else if (cur) { parts.push(cur); cur = null; }
  }
  parts = parts.reduce((acc, p) => { const last = acc[acc.length - 1]; if (last && p.start - last.end <= 1) last.end = p.end; else acc.push({ ...p }); return acc; }, []);
  parts = parts.filter((p) => p.end - p.start >= minPart || p.end >= coreStart);
  parts = parts.map((p) => ({ start: Math.max(0, p.start - pad), end: Math.min(duration, p.end + pad) }));
  // overlapping after padding -> merge
  parts = parts.reduce((acc, p) => { const last = acc[acc.length - 1]; if (last && p.start <= last.end) last.end = Math.max(last.end, p.end); else acc.push(p); return acc; }, []);
  return parts.map((p) => ({ start: +p.start.toFixed(2), end: +p.end.toFixed(2) }));
}

// Streamer reaction in the webcam: how much the face/body moves second by second (jumping, laughing, leaning in).
// Measured only around candidate moments (fast seeks), on a tiny grey copy of the webcam area, 6 frames a second.
function camMotion(file, fc, t0, dur, fps = 6) {
  const W = 48, H = 36;
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, t0)), '-t', String(dur), '-i', file, '-an', '-sn',
      '-vf', `fps=${fps},crop=${fc.w}:${fc.h}:${fc.x}:${fc.y},scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = []; p.stdout.on('data', (d) => chunks.push(d));
    const done = () => {
      const buf = Buffer.concat(chunks), n = Math.floor(buf.length / (W * H));
      const diff = [];
      for (let f = 1; f < n; f++) { let sum = 0; const a = (f - 1) * W * H, b = f * W * H; for (let k = 0; k < W * H; k++) sum += Math.abs(buf[b + k] - buf[a + k]); diff.push(sum / (W * H)); }
      const perSec = []; for (let i = 0; i < diff.length; i += fps) perSec.push(Math.max(...diff.slice(i, i + fps)));
      resolve(perSec);
    };
    p.on('close', done); p.on('error', () => resolve([]));
  });
}
// reaction strength 0..3 around a moment: motion peak against the calm level of the same window
async function camReaction(file, fc, peak, duration) {
  const t0 = Math.max(0, peak - 15), dur = Math.min(duration - t0, 27);
  const m = await camMotion(file, fc, t0, dur);
  if (m.length < 8) return { reaction: 0 };
  const calm = median(m) + 0.3, mad = Math.max(0.6, median(m.map((v) => Math.abs(v - calm))));
  let best = 0, at = 0; m.forEach((v, i) => { const z = (v - calm) / (mad * 4); if (z > best) { best = z; at = i; } });
  return { reaction: Math.min(3, +best.toFixed(2)), at: t0 + at };
}

// how long the story goes on after the key moment: while the action / talking stays well above the calm level
// (reaction, aftermath, the punchline), at least 6 s, at most 22 s, stopping at the first 3-second lull
function storyAfter(score, peak, duration, { min = 6, max = 22 } = {}) {
  const p = Math.round(peak); const top = Math.max(...score.slice(Math.max(0, p - 2), p + 3), 0.001);
  const calm = median(score.slice(Math.max(0, p - 120), p + 60));
  const lvl = calm + (top - calm) * 0.3;
  let quiet = 0, t = min;
  for (let i = p + min; i < Math.min(score.length, p + max, Math.floor(duration)); i++) {
    if ((score[i] || 0) < lvl) { if (++quiet >= 3) break; } else { quiet = 0; t = i - p + 1; }
  }
  return Math.min(max, Math.max(min, t));
}
module.exports = { storyAfter, camReaction, storyParts, probe, findHighlights, scoreSeconds, pickSegments };

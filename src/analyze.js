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
    if (s <= 0.3) break;
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
  // collect extra candidates so the AI can re-rank them
  const candidates = pickSegments(score, { ...opts, count: Math.max(opts.count * 2, 12), duration: info.duration });
  onProgress(1);
  return { info, candidates, curve: downsample(score, 300) };
}
const downsample = (a, k) => { const step = Math.max(1, Math.ceil(a.length / k)); const o = [];
  for (let i = 0; i < a.length; i += step) o.push(Number(Math.max(...a.slice(i, i + step)).toFixed(2))); return o; };

module.exports = { probe, findHighlights, scoreSeconds, pickSegments };

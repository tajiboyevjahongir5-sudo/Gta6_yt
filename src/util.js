const { spawn } = require('child_process');

// Run a command, collect stdout/stderr. onLine gets every stderr+stdout line (for progress parsing).
function run(cmd, args, { onLine, timeoutMs = 0, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', bufO = '', bufE = '';
    const feed = (chunk, which) => {
      const s = chunk.toString();
      if (which === 'o') out += s; else { err += s; if (err.length > 200000) err = err.slice(-100000); }
      if (!onLine) return;
      let buf = (which === 'o' ? bufO : bufE) + s;
      const lines = buf.split(/\r|\n/); buf = lines.pop();
      if (which === 'o') bufO = buf; else bufE = buf;
      for (const l of lines) if (l) onLine(l);
    };
    p.stdout.on('data', (c) => feed(c, 'o'));
    p.stderr.on('data', (c) => feed(c, 'e'));
    const t = timeoutMs ? setTimeout(() => p.kill('SIGKILL'), timeoutMs) : null;
    p.on('error', (e) => { clearTimeout(t); reject(new Error(`${cmd} ishga tushmadi: ${e.message}`)); });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${cmd} xato bilan tugadi (${code}): ${err.split('\n').filter(Boolean).slice(-4).join(' | ')}`));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtTime = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
const now = () => Date.now();
// Tashkent is UTC+5 all year
const TZ_OFFSET = 5 * 3600 * 1000;
const dayKey = (t = Date.now()) => new Date(t + TZ_OFFSET).toISOString().slice(0, 10);

module.exports = { run, sleep, fmtTime, now, dayKey, TZ_OFFSET };

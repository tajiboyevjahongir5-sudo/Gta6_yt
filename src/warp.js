// Cloudflare WARP as a free extra route to YouTube. YouTube blocks data-centre IPs (Railway); WARP traffic leaves from
// Cloudflare's network instead, which YouTube often (not always) lets through. No root needed: wgcf registers a free
// WARP account and writes a WireGuard profile, wireproxy runs that tunnel in user space and offers a local SOCKS5 port.
// Used only after the normal ways were refused with the bot check, and only when no proxy is set in the Web App.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DATA_DIR } = require('./config');
const { log } = require('./db');
const { run } = require('./util');

const DIR = path.join(DATA_DIR, 'warp');
const PORT = 40000;
const URL_ = `socks5h://127.0.0.1:${PORT}`;
const bin = (n) => ['/usr/local/bin/' + n, '/usr/bin/' + n].find((f) => fs.existsSync(f));
let up = false, starting = null;

async function start() {
  if (starting) return starting;
  starting = (async () => {
    const wgcf = bin('wgcf'), wp = bin('wireproxy');
    if (!wgcf || !wp) return false;
    fs.mkdirSync(DIR, { recursive: true });
    // free WARP account + WireGuard profile, made once and kept on the volume
    if (!fs.existsSync(path.join(DIR, 'wgcf-account.toml'))) await run(wgcf, ['register', '--accept-tos'], { cwd: DIR, timeoutMs: 60000 });
    if (!fs.existsSync(path.join(DIR, 'wgcf-profile.conf'))) await run(wgcf, ['generate'], { cwd: DIR, timeoutMs: 60000 });
    const conf = path.join(DIR, 'wireproxy.conf');
    fs.writeFileSync(conf, `WGConfig = ${path.join(DIR, 'wgcf-profile.conf')}\n\n[Socks5]\nBindAddress = 127.0.0.1:${PORT}\n`);
    const launch = () => {
      const proc = spawn(wp, ['-c', conf], { stdio: 'ignore' });
      up = true;
      proc.on('exit', () => { up = false; setTimeout(launch, 30000); }); // keep it alive
    };
    launch();
    log('Cloudflare WARP yo\'li tayyor (YouTube bloklasa zaxira sifatida ishlatiladi)');
    return true;
  })().catch((e) => { log('WARP ishga tushmadi: ' + e.message.slice(0, 160), 'warn'); starting = null; return false; });
  return starting;
}

const available = () => up;
module.exports = { start, available, url: () => URL_ };

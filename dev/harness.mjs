// Shared pieces of the end-to-end checks: FakePhone, headless Chrome and a minimal CDP client.
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const out = join(root, 'dev', '.out');
const jdk = process.env.JAVA_HOME || 'W:/jdk';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function killTree(pid) {
  if (pid) spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
}

/** First non-loopback IPv4: a page opened on it is NOT a secure context, which forces the MSE path. */
export function lanIp() {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  throw new Error('no LAN IPv4 address');
}

export function compileFake() {
  const dir = join(out, 'fake');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execFileSync(join(jdk, 'bin', 'javac'), ['-encoding', 'UTF-8', '-d', dir,
    join(root, 'android/src/app/phoneshare/StreamServer.java'), join(root, 'dev/FakePhone.java')], { stdio: 'inherit' });
  return dir;
}

export async function startFake({ pin = '135790', port = 8080, udp = 47800, rotateEvery = 0, name = 'FakePhone' } = {}) {
  const cp = join(out, 'fake');
  const proc = spawn(join(jdk, 'bin', 'java'), ['-cp', cp, 'app.phoneshare.FakePhone', '--pin', pin, '--port', String(port),
    '--udp', String(udp), '--rotate-every', String(rotateEvery), '--name', name, '--web', join(root, 'web')], { stdio: ['pipe', 'pipe', 'inherit'] });
  let log = '';
  const actual = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('FakePhone did not start: ' + log)), 20000);
    proc.stdout.setEncoding('utf8');   // viewer names are UTF-8; a chunk may split a character
    proc.stdout.on('data', (d) => {
      log += d;
      const m = /FAKEPHONE READY port=(\d+)/.exec(log);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
    proc.on('exit', (c) => reject(new Error('FakePhone exited ' + c + ': ' + log)));
  });
  return {
    port: actual,
    get log() { return log; },
    async stop() {
      try { proc.stdin.write('quit\n'); } catch { /* already gone */ }
      const done = await Promise.race([new Promise((r) => proc.on('exit', () => r(true))), sleep(4000).then(() => false)]);
      if (!done) killTree(proc.pid);
    },
  };
}

export function chromePath() {
  const c = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  if (!c) throw new Error('no Chrome or Edge found');
  return c;
}

export async function startChrome(debugPort) {
  const profile = join(out, 'chrome-profile-' + debugPort);
  rmSync(profile, { recursive: true, force: true });
  const proc = spawn(chromePath(), ['--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
    '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
  await waitHttp(`http://127.0.0.1:${debugPort}/json/version`, 20000);
  return { debugPort, stop: () => killTree(proc.pid) };
}

export async function waitHttp(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return r.json(); } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('no answer from ' + url);
}

export class Cdp {
  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP connect failed')); });
    return new Cdp(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        this.errors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.errors.push('console: ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
      } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        this.errors.push('log: ' + m.params.entry.text);
      }
    };
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }

  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }

  async waitFor(expr, ms, what) {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) {
      try { last = await this.eval(expr); if (last) return last; } catch (e) { last = e.message; }
      await sleep(200);
    }
    throw new Error(`timeout: ${what} (last: ${JSON.stringify(last)}; page state: ${JSON.stringify(await this.eval('JSON.stringify(window.__ps||null)').catch(() => '?'))})`);
  }

  close() { this.ws.close(); }
}

/** Opens a blank tab, installs an optional init script, then navigates. */
export async function openPage(debugPort, url, { init, width, height } = {}) {
  const r = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' });
  const t = await r.json();
  const cdp = await Cdp.open(t.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  if (width) await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  if (init) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: init });
  await cdp.send('Page.navigate', { url });
  return cdp;
}

/** Types a PIN the way a person would: value + input event (the form auto-submits at 6 digits). */
export function typePin(cdp, pin) {
  return cdp.eval(`(() => { const i = document.getElementById('pin-input'); i.value = ${JSON.stringify(pin)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
}

export const ps = (cdp, field) => cdp.eval(`window.__ps && window.__ps.${field}`);

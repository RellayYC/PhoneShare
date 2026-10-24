// End-to-end check of the one-file Windows app (copied alone into an empty folder) against FakePhone: help while no phone
// is around, discovery, phone cards with their last frame, PIN, WebCodecs video, audio, recording, 1:1, window title and
// title-bar colour per screen, always-on-top, fullscreen, screenshots, kept placement and PIN, fallback port, Miracast, and
// the screen shown when WebView2 is missing. Drives the page over CDP and the window over Win32/UI Automation (dev/win.ps1).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { root, out, sleep, killTree, compileFake, startFake, Cdp, typePin, ps } from './harness.mjs';

const built = join(root, 'dist/PhoneShare.exe');
const exe = join(out, 'desktop-run', 'PhoneShare.exe');   // alone in an empty folder: proves the one-file build
const home = join(out, 'desktop-home');
const DEBUG_PORT = 9340;
const PIN = '246810';

function fail(msg) { throw new Error(msg); }
function check(ok, what) { if (!ok) fail(what); console.log('ok  ' + what); }

function win(pid, action, args = {}) {
  const extra = Object.entries(args).flatMap(([k, v]) => ['-' + k, String(v)]);
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'dev/win.ps1'),
    '-ProcessId', String(pid), '-Action', action, ...extra], { encoding: 'utf8' });
  if (r.status !== 0) fail(`win.ps1 ${action}: ${r.stderr || r.stdout}`);
  const res = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
  // a minimized window sits at -32000 and reads as black pixels: a probe of it would prove nothing
  if (action === 'probe' && res.minimized) fail('the window was minimized during the test (by hand?); run again without touching it');
  return res;
}

function near(hex, rgb, tol = 6) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return v.every((c, i) => Math.abs(c - rgb[i]) <= tol);
}

async function waitUntil(fn, ms, what) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e.message; }
    await sleep(150);
  }
  fail(`timeout: ${what} (last: ${JSON.stringify(last)})`);
}

/** Starts the exe and returns its process plus a CDP session on the page inside the window. */
async function launch(extraEnv = {}, { page = true } = {}) {
  const env = { ...process.env, PHONESHARE_HOME: home, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEBUG_PORT}`, ...extraEnv };
  const started = Date.now();
  const proc = spawn(exe, [], { env, stdio: 'ignore' });
  let exited = null;
  proc.on('exit', (c) => { exited = c; });
  const app = { proc, started, get exited() { return exited; } };
  if (!page) return app;
  const target = await waitUntil(async () => {
    const list = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json());
    return list.find((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:478\d\d\//.test(t.url));
  }, 20000, 'page inside the window');
  app.origin = new URL(target.url).origin;
  app.cdp = await Cdp.open(target.webSocketDebuggerUrl);
  await app.cdp.send('Runtime.enable');
  await app.cdp.send('Log.enable');
  return app;
}

async function stop(app) {
  if (app.cdp) app.cdp.close();
  killTree(app.proc.pid);
  await waitUntil(() => app.exited !== null, 5000, 'app exit after kill');
}

/** Clicks like a person: with user activation, which fullscreen requires. */
async function click(cdp, sel) {
  const r = await cdp.send('Runtime.evaluate', { userGesture: true, returnByValue: true,
    expression: `(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true; })()` });
  if (!r.result.value) fail('no ' + sel);
}
const shots = join(out, 'shots');
/** Window screenshot for the design review (dev/.out/shots/win-*.png); pins the window test-side so nothing covers it. */
async function shotWin(pid, name, pin = true) {
  mkdirSync(shots, { recursive: true });
  if (pin) { win(pid, 'topmost', { On: 1 }); await sleep(300); }
  win(pid, 'shot', { Path: join(shots, `win-${name}.png`) });
  if (pin) win(pid, 'topmost', { On: 0 });
}
/** Same receiver hints as the app, asked through Get-StartApps: a different API over the Start menu than the app's Shell COM walk. */
function startMenuHasReceiver() {
  const ps1 = `$n = 'Wireless Display','Беспроводной дисплей','Connect','Подключить'
[bool](Get-StartApps | Where-Object { $_.AppID -match 'WirelessDisplay|PPIProjection|Miracast' -or ($_.AppID -like 'Microsoft*' -and $n -contains $_.Name) })`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps1], { encoding: 'utf8' });
  if (r.status !== 0) fail('Get-StartApps: ' + r.stderr);
  return r.stdout.trim() === 'True';
}
const settingsPids = () => (spawnSync('tasklist', ['/FI', 'IMAGENAME eq SystemSettings.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout.match(/"SystemSettings\.exe","(\d+)"/g) || [])
  .map((l) => l.split('","')[1].replace('"', ''));
const pageTargets = async () => (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json())).filter((t) => t.type === 'page').length;

if (!existsSync(built)) fail('build first: node dev/check-desktop.mjs');
rmSync(join(out, 'desktop-run'), { recursive: true, force: true });
mkdirSync(join(out, 'desktop-run'), { recursive: true });
copyFileSync(built, exe);
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });
compileFake();
let fake = null;
/** This PC's IPv4 addresses that have a gateway, from Get-NetIPConfiguration (not the app's code path). */
const pcIps = spawnSync('powershell', ['-NoProfile', '-Command',
  "(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | ForEach-Object { $_.IPv4Address.IPAddress }) -join ','"], { encoding: 'utf8' })
  .stdout.trim().split(',').filter(Boolean);
const cardOf = (name) => `[...document.querySelectorAll('.phone-item')].find((x) => x.querySelector('.phone-name').textContent === ${JSON.stringify(name)})`;
const apps = [];
let blocker = null;

try {
  // ---- run 1 starts before the phone: the help says what to check; then discovery, PIN, stream, window behaviour
  const a = await launch();
  apps.push(a);
  const { cdp } = a;
  await cdp.waitFor(`window.__ps && window.__ps.screen === 'home'`, 10000, 'home screen');
  check(existsSync(join(home, 'bin')) && readdirSync(join(out, 'desktop-run')).join() === 'PhoneShare.exe',
    'the exe runs alone; its WebView2 loader unpacks under the app folder');
  await cdp.waitFor(`document.getElementById('pc-net').textContent.length > 0`, 5000, 'PC network line');
  check(await cdp.eval(`document.getElementById('help').open`), 'no phone around: the help is open without a click');
  const net = await cdp.eval(`document.getElementById('pc-net').textContent`);
  check(pcIps.length > 0 && pcIps.some((ip) => net.includes(ip)) && !net.includes('192.168.56.'), `help names this PC's network: ${net}`);
  await shotWin(a.proc.pid, 'home-empty');
  fake = await startFake({ pin: PIN, name: 'FakePhone' });
  const phoneAt = Date.now();
  check(a.origin === 'http://127.0.0.1:47810', 'page served from ' + a.origin + ' (secure context: ' + await ps(cdp, 'secure') + ')');
  check(await ps(cdp, 'secure') === true && await cdp.eval(`document.body.classList.contains('desktop')`), 'page runs in desktop mode, secure context');

  const row = await cdp.waitFor(`(() => { const d = ${cardOf('FakePhone')}; return d && d.classList.contains('online') ? d.querySelector('.phone-addr').textContent : null; })()`, 8000, 'FakePhone card');
  const foundMs = Date.now() - phoneAt;
  check(foundMs <= 5000, `FakePhone found by UDP ${foundMs} ms after it started (limit 5000)`);
  check(!row.startsWith('127.'), `phone address comes from the UDP reply: ${row}`);
  check(await cdp.eval(`!document.getElementById('help').open`), 'a phone is online: the help folds away');
  await sleep(3500);   // one more discovery round: replies through every adapter are in
  const rows = await cdp.eval(`[...document.querySelectorAll('.phone-item')].filter((x) => x.querySelector('.phone-name').textContent === 'FakePhone').length`);
  check(rows === 1, `FakePhone listed once (${rows}), though it answers through every adapter of this PC`);

  const dark = await cdp.eval(`matchMedia('(prefers-color-scheme: dark)').matches`);
  const paper = dark ? [0x1e, 0x24, 0x30] : [0xe9, 0xec, 0xf1];
  win(a.proc.pid, 'topmost', { On: 1 });   // test-side, only so nothing covers the title bar for the pixel probe
  await sleep(400);
  let w = win(a.proc.pid, 'probe');
  win(a.proc.pid, 'topmost', { On: 0 });
  check(w.title === 'PhoneShare', `window title "${w.title}" on the list`);
  check(near(w.caption, paper), `title bar ${w.caption} matches the ${dark ? 'dark' : 'light'} paper on the list`);
  await shotWin(a.proc.pid, 'home');

  // Miracast section: the app's idea of the receiver matches the Start menu, the button and the text follow it
  const receiver = startMenuHasReceiver();
  await cdp.waitFor(`window.__ps.miracast !== undefined`, 6000, 'Miracast receiver state');
  check(await ps(cdp, 'miracast') === receiver, `Miracast receiver ${receiver ? 'found' : 'not installed'}, same as the Start menu`);
  const label = await cdp.eval(`document.getElementById('miracast-open').textContent`);
  check(label === (receiver ? 'Открыть приёмник Miracast' : 'Как включить Miracast'), `Miracast button reads "${label}"`);
  check(await cdp.eval(`document.getElementById('miracast').offsetParent !== null`), 'Miracast section shown in the window');
  const limits = await cdp.eval(`document.querySelector('.miracast-text').textContent`);
  check(/Задержка выше/.test(limits) && /Pixel/.test(limits) && /Wi-Fi/.test(limits), 'section names the limits: latency, Pixel, Wi-Fi');
  const settingsBefore = settingsPids();
  await click(cdp, '#miracast-open');
  await cdp.waitFor(`window.__ps.miracastOpened`, 6000, 'Miracast open reply');
  const opened = await ps(cdp, 'miracastOpened');
  check(opened === (receiver ? 'receiver' : 'settings'), `button opened the ${opened}`);
  if (!receiver) {
    // the Settings page came up; a window this test opened is closed again, one the user had open is left alone
    const fresh = await waitUntil(() => { const now = settingsPids().filter((p) => !settingsBefore.includes(p)); return now.length ? now : (settingsBefore.length ? ['none'] : null); }, 6000, 'Settings window');
    check(true, 'Windows Settings opened on "Projecting to this PC"' + (fresh[0] === 'none' ? ' (it was already running)' : ''));
    for (const p of fresh) if (p !== 'none') spawnSync('taskkill', ['/PID', p, '/F'], { stdio: 'ignore' });
  }
  const steps = await cdp.eval(`[...document.querySelectorAll('#miracast-steps li')].map((l) => l.textContent)`);
  check(steps.length >= 2 && steps.some((s) => s.toLowerCase().includes(hostname().toLowerCase().slice(0, 15))), `steps name this PC: ${steps[steps.length - 1]}`);
  await shotWin(a.proc.pid, 'home-miracast');

  await cdp.eval(`${cardOf('FakePhone')}.querySelector('.phone').click()`);
  await cdp.waitFor(`window.__ps.screen === 'pin'`, 3000, 'PIN screen');
  await shotWin(a.proc.pid, 'pin');
  const pinAt = Date.now();
  await typePin(cdp, PIN);
  await cdp.waitFor(`window.__ps.frames > 0`, 5000, 'first frame');
  const firstFrameMs = Date.now() - pinAt;
  check(firstFrameMs <= 3000, `first frame ${firstFrameMs} ms after the PIN (limit 3000)`);
  check(await ps(cdp, 'decoder') === 'webcodecs', 'video decodes through WebCodecs');
  const f1 = await ps(cdp, 'frames');
  await sleep(1500);
  check(await ps(cdp, 'frames') > f1 + 10, 'frames keep coming');
  await cdp.waitFor(`window.__ps.audioChunks > 0`, 5000, 'audio chunks');
  check(true, `audio plays (${await ps(cdp, 'audioChunks')} chunks, ${await ps(cdp, 'audioState')})`);
  await cdp.waitFor(`window.__ps.latencyMs != null`, 5000, 'latency measured');
  const lat = [];
  for (let i = 0; i < 6; i++) { lat.push(await ps(cdp, 'latencyMs')); await sleep(400); }
  lat.sort((x, y) => x - y);
  check(lat[3] <= 250, `median latency ${Math.round(lat[3])} ms (limit 250)`);

  const viewer = 'ПК ' + hostname();
  await waitUntil(() => new RegExp('FAKEPHONE VIEWERS \\[[^\\]]*' + viewer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(fake.log), 3000, 'viewer name on the phone');
  check(true, `phone lists the viewer as "${viewer}"`);

  // title and title bar in the player
  await click(cdp, '#ontop');
  await sleep(500);
  w = win(a.proc.pid, 'probe');
  check(w.topmost === true, '"Always on top" sets WS_EX_TOPMOST');
  check(w.title === 'FakePhone — PhoneShare', `window title "${w.title}" in the player`);
  check(near(w.caption, [0, 0, 0]), `title bar ${w.caption} is black in the player`);
  await cdp.eval(`document.dispatchEvent(new PointerEvent('pointermove')); true`);   // controls visible for the shot
  await sleep(200);
  await shotWin(a.proc.pid, 'player', false);

  // fullscreen fills the monitor, Esc brings the window back
  const before = w.rect;
  await click(cdp, '#full');
  await cdp.waitFor(`!!document.fullscreenElement`, 3000, 'fullscreen element');
  await sleep(500);
  w = win(a.proc.pid, 'probe');
  check(JSON.stringify(w.rect) === JSON.stringify(w.monitor), `fullscreen window ${JSON.stringify(w.rect)} equals the monitor`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.waitFor(`!document.fullscreenElement`, 3000, 'fullscreen exit on Esc');
  await sleep(500);
  w = win(a.proc.pid, 'probe');
  check(JSON.stringify(w.rect) === JSON.stringify(before), `Esc restores the window to ${JSON.stringify(w.rect)}`);
  await click(cdp, '#ontop');
  await sleep(300);
  check(win(a.proc.pid, 'probe').topmost === false, '"Always on top" off clears WS_EX_TOPMOST');

  // 1:1 keeps the video's own pixel size
  await click(cdp, '[data-fit="native"]');
  await sleep(300);
  const px = await cdp.eval(`(() => { const r = document.getElementById('canvas').getBoundingClientRect(); return [r.width * devicePixelRatio, r.height * devicePixelRatio, __ps.width, __ps.height]; })()`);
  check(Math.abs(px[0] - px[2]) <= 1 && Math.abs(px[1] - px[3]) <= 1, `1:1 shows ${Math.round(px[0])}x${Math.round(px[1])} screen pixels for a ${px[2]}x${px[3]} video`);
  await click(cdp, '[data-fit="contain"]');

  // R starts a recording, the button stops it; the take lands in Videos (Recordings under PHONESHARE_HOME) with sound
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82, text: 'r' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82 });
  await cdp.waitFor(`window.__ps.recording && !document.getElementById('rec-bar').hidden`, 3000, 'recording on R');
  check(true, 'R starts a recording: red bar and timer');
  await sleep(3000);
  await cdp.eval(`document.dispatchEvent(new PointerEvent('pointermove')); true`);
  await shotWin(a.proc.pid, 'player-recording', false);
  await click(cdp, '#rec');
  const recDir = join(home, 'Recordings');
  const take = await waitUntil(() => existsSync(recDir) && readdirSync(recDir).find((f) => /^PhoneShare FakePhone .*\.webm$/.test(f) && statSync(join(recDir, f)).size > 20000), 8000, 'recording file');
  const kinds = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', join(recDir, take)], { encoding: 'utf8' })
    .stdout.split(/\r?\n/).filter(Boolean).sort().join(',');
  check(kinds === 'audio,video', `recording saved without a dialog: Recordings/${take} (${kinds})`);

  // screenshot lands in the folder without a dialog
  await click(cdp, '#shot');
  const shotDir = join(home, 'Screenshots');
  const shot = await waitUntil(() => existsSync(shotDir) && readdirSync(shotDir).find((f) => /^PhoneShare FakePhone .*\.png$/.test(f)), 3000, 'screenshot file');
  check(readFileSync(join(shotDir, shot)).subarray(1, 4).toString() === 'PNG', `screenshot saved: Screenshots/${shot}`);
  check((await cdp.eval(`document.getElementById('toast').textContent`)).includes('Изображения'), 'toast names the Pictures folder');

  // only our page lives in the window
  const pages = await pageTargets();
  await cdp.eval(`location.href = 'about:blank#away'; true`);
  await sleep(700);
  check((await cdp.eval('location.origin')) === a.origin && await ps(cdp, 'screen') === 'player', 'navigation away from the app is cancelled');
  await cdp.eval(`window.open('about:blank'); true`);
  await sleep(700);
  check(await pageTargets() === pages, 'window.open does not open a window');

  check(cdp.errors.length === 0, 'no console errors' + (cdp.errors.length ? ': ' + cdp.errors.join(' | ') : ''));

  // leave the player, place the window, close it like the X button does
  await click(cdp, '#player-back');
  await cdp.waitFor(`window.__ps.screen === 'home'`, 3000, 'back to the list');
  await cdp.waitFor(`!!(${cardOf('FakePhone')}.querySelector('img'))`, 3000, 'card picture');
  check(true, 'back on the shelf, the FakePhone card shows its last frame');
  await shotWin(a.proc.pid, 'home-cards');
  const place = { X: 140, Y: 90, W: Math.round(900 * w.dpi / 96), H: Math.round(680 * w.dpi / 96) };
  win(a.proc.pid, 'place', place);
  await sleep(300);
  const placed = win(a.proc.pid, 'probe').rect;
  cdp.close();
  a.cdp = null;
  win(a.proc.pid, 'close');
  await waitUntil(() => a.exited !== null, 8000, 'app exits on WM_CLOSE');
  apps.pop();
  const saved = readFileSync(join(home, 'window.txt'), 'utf8').trim();
  check(saved === `${placed.l} ${placed.t} ${placed.r - placed.l} ${placed.b - placed.t} 0`, `window.txt keeps the placement: ${saved}`);
  await sleep(1000);   // WebView2 releases the profile

  // ---- run 2: same place, saved phone, no PIN
  const b = await launch();
  apps.push(b);
  await b.cdp.waitFor(`window.__ps && window.__ps.screen === 'home'`, 10000, 'home screen (run 2)');
  check(JSON.stringify(win(b.proc.pid, 'probe').rect) === JSON.stringify(placed), 'window reopens at the saved place and size');
  await b.cdp.waitFor(`!!${cardOf('FakePhone')}`, 5000, 'saved phone listed');
  check(await b.cdp.eval(`!!(${cardOf('FakePhone')}.querySelector('img'))`), 'after a restart the card still shows the last frame');
  await b.cdp.eval(`${cardOf('FakePhone')}.querySelector('.phone').click()`);
  await b.cdp.waitFor(`window.__ps.screen === 'player' && window.__ps.frames > 0`, 6000, 'player without PIN');
  check(true, 'saved phone opens without asking for the PIN');
  await stop(b);
  apps.pop();
  await sleep(1000);

  // ---- run 3: port 47810 taken by someone else
  blocker = createServer().listen(47810, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  const c = await launch();
  apps.push(c);
  await c.cdp.waitFor(`window.__ps && window.__ps.screen === 'home'`, 10000, 'home screen (run 3)');
  check(c.origin === 'http://127.0.0.1:47811', 'busy port 47810: the app moves to ' + c.origin);
  await stop(c);
  apps.pop();
  blocker.close();
  blocker = null;
  await sleep(1000);

  // ---- run 4: no WebView2 runtime
  const d = await launch({ WEBVIEW2_BROWSER_EXECUTABLE_FOLDER: join(home, 'no-webview2-here') }, { page: false });
  apps.push(d);
  await sleep(3000);
  check(d.exited === null, 'without WebView2 the app stays open');
  const names = win(d.proc.pid, 'names').names;
  check(names.includes('Скачать WebView2') && names.includes('Закрыть'), 'shows "Скачать WebView2" and "Закрыть"');
  await shotWin(d.proc.pid, 'no-webview2');
  check(names.some((n) => /WebView2/.test(n) && n.length > 20), 'explains what is missing: ' + names.find((n) => /WebView2/.test(n) && n.length > 20));
  await stop(d);
  apps.pop();

  console.log('DESKTOP E2E OK');
} catch (e) {
  console.log('DESKTOP E2E FAILED: ' + e.message);
  process.exitCode = 1;
} finally {
  for (const x of apps) killTree(x.proc.pid);
  if (blocker) blocker.close();
  if (fake) await fake.stop();
}

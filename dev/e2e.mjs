// End-to-end checks of the web receiver against FakePhone in headless Chrome.
//   node dev/e2e.mjs mse        page on a LAN address (insecure) -> MSE path, rotation, two viewers, reconnect
//   node dev/e2e.mjs webcodecs  page on 127.0.0.1 (secure) -> WebCodecs path
//   node dev/e2e.mjs ui         layout at 375 px, console errors, accessible names, screenshots in dev/.out/shots
import { mkdirSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { compileFake, startFake, startChrome, openPage, typePin, ps, lanIp, sleep, out } from './harness.mjs';

const mode = process.argv[2];
const PIN = '135790';
if (!['mse', 'webcodecs', 'ui'].includes(mode)) { console.log('usage: node dev/e2e.mjs mse|webcodecs|ui'); process.exit(2); }

function check(ok, what) {
  if (!ok) throw new Error('check failed: ' + what);
  console.log('ok  ' + what);
}

async function waitLive(page, minFrames, what) {
  await page.waitFor(`window.__ps && __ps.state === 'live' && __ps.frames >= ${minFrames}`, 20000, what);
}

let fake;
let chrome;
const cleanups = [];
try {
  compileFake();
  fake = await startFake({ pin: PIN, rotateEvery: mode === 'mse' ? 8 : 0 });
  chrome = await startChrome(9333);
  if (mode === 'mse') await runMse();
  else if (mode === 'webcodecs') await runWebCodecs();
  else await runUi();
} catch (e) {
  console.log(e.stack || String(e));
  console.log(`E2E ${mode.toUpperCase()} FAILED`);
  process.exitCode = 1;
} finally {
  for (const c of cleanups) c();
  if (fake) await fake.stop();
  if (chrome) chrome.stop();
}

async function runMse() {
  const url = `http://${lanIp()}:${fake.port}/`;
  const a = await openPage(9333, url);
  cleanups.push(() => a.close());
  await a.waitFor(`window.__ps && __ps.screen === 'pin'`, 10000, 'PIN screen');
  check(await ps(a, 'secure') === false && await ps(a, 'decoder') === 'mse', `insecure origin ${url} uses MSE`);
  await a.waitFor(`document.getElementById('pin-device').textContent === 'FakePhone'`, 5000, 'phone name from /info');
  check(true, 'PIN screen shows the phone name');

  await typePin(a, '000000');
  await a.waitFor(`__ps.screen === 'pin' && document.getElementById('pin-error').textContent.includes('Неверный')`, 10000, 'wrong PIN rejected');
  check(true, 'wrong PIN shows an error and stays on the PIN screen');

  await typePin(a, PIN);
  await waitLive(a, 30, 'MSE video frames');
  check(true, 'MSE decodes video (30+ frames shown)');
  await a.waitFor(`__ps.audioChunks > 25 && __ps.audioState === 'running'`, 10000, 'audio');
  check(true, 'audio chunks arrive and AudioContext is running');
  const lat = await a.waitFor(`__ps.latencyMs != null && __ps.latencyMs`, 10000, 'latency');
  check(lat > 0 && lat < 1500, `latency measured: ${Math.round(lat)} ms`);

  const w0 = await ps(a, 'width');
  const h0 = await ps(a, 'height');
  await a.waitFor(`__ps.width === ${h0} && __ps.height === ${w0}`, 20000, 'rotation');
  const f0 = await ps(a, 'frames');
  await a.waitFor(`__ps.frames > ${f0 + 30}`, 10000, 'frames after rotation');
  check(true, `rotation ${w0}x${h0} -> ${h0}x${w0} keeps playing`);

  // Headless Chrome stops painting video in background tabs, so each viewer is checked in front;
  // both stay connected and keep receiving the stream the whole time.
  const b = await openPage(9333, url);
  cleanups.push(() => b.close());
  await waitLive(b, 30, 'second viewer');
  check(await ps(a, 'state') === 'live' && await ps(a, 'kbps') > 500, 'first viewer keeps receiving while the second plays');
  await a.send('Page.bringToFront');
  const fa = await ps(a, 'frames');
  await a.waitFor(`__ps.frames > ${fa + 30}`, 15000, 'first viewer playing again in front');
  check(await ps(b, 'state') === 'live' && await ps(b, 'kbps') > 500, 'second viewer keeps receiving too');
  check(true, 'two viewers at the same time (second one reused the saved PIN)');

  await fake.stop();
  await a.waitFor(`__ps.state === 'ended'`, 10000, 'ended state after phone stops');
  check(true, 'phone stop shows the ended state');
  fake = await startFake({ pin: PIN, port: Number(new URL(url).port) });
  const fr = await ps(a, 'frames');
  await a.waitFor(`__ps.state === 'live' && __ps.frames > ${fr + 30} && __ps.reconnects >= 1`, 25000, 'auto reconnect');
  check(true, 'viewer reconnects by itself after the phone restarts');
  check((await ps(a, 'errors')).length === 0, 'no player errors: ' + JSON.stringify(await ps(a, 'errors')));
  console.log('E2E MSE OK');
}

async function runWebCodecs() {
  const url = `http://127.0.0.1:${fake.port}/`;
  const a = await openPage(9333, url);
  cleanups.push(() => a.close());
  await a.waitFor(`window.__ps && __ps.screen === 'pin'`, 10000, 'PIN screen');
  check(await ps(a, 'secure') === true && await ps(a, 'decoder') === 'webcodecs', 'secure origin uses WebCodecs');
  await typePin(a, PIN);
  await waitLive(a, 30, 'WebCodecs frames');
  check(true, 'WebCodecs decodes video (30+ frames drawn)');
  check(await ps(a, 'width') === 720 && await ps(a, 'height') === 1280, 'canvas has the phone resolution 720x1280');
  await a.waitFor(`__ps.audioChunks > 25 && __ps.audioState === 'running'`, 10000, 'audio');
  check(true, 'audio plays');
  const lat = await a.waitFor(`__ps.latencyMs != null && __ps.latencyMs`, 10000, 'latency');
  check(lat > 0 && lat < 1000, `latency measured: ${Math.round(lat)} ms`);
  check((await ps(a, 'errors')).length === 0, 'no player errors');
  console.log('E2E WEBCODECS OK');
}

function fakeHost() { return `
  (() => {
    const listeners = [];
    const send = (data) => setTimeout(() => listeners.forEach((f) => f({ data })), 30);
    window.chrome = window.chrome || {};
    window.chrome.webview = {
      postMessage(m) {
        if (m === 'discover') send({ t: 'devices', list: window.__fakeDevices || [] });
        if (m === 'hello') send({ t: 'host', name: 'TESTPC', nets: [{ name: 'Home', ip: '192.168.1.20' }] });
        if (m === 'miracast?') send({ t: 'miracast', installed: false });
      },
      addEventListener(t, f) { if (t === 'message') listeners.push(f); },
    };
  })();`; }

async function runUi() {
  const shots = join(out, 'shots');
  mkdirSync(shots, { recursive: true });
  const snap = async (page, name) => {
    const r = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(shots, name + '.png'), Buffer.from(r.data, 'base64'));
  };
  const noHScroll = (page, where) => page.eval('document.documentElement.scrollWidth <= window.innerWidth + 1')
    .then((ok) => check(ok, `no horizontal scroll: ${where}`));
  const named = (page, where) => page.eval(`[...document.querySelectorAll('button, input')].filter((e) => e.offsetParent !== null || e.closest('.hud'))
      .filter((e) => !(e.getAttribute('aria-label') || e.textContent.trim() || (e.labels && e.labels.length) || e.title)).map((e) => e.outerHTML.slice(0, 80))`)
    .then((bad) => check(bad.length === 0, `every control has an accessible name: ${where} ${bad.join(' ')}`));
  const hover = (page) => page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200 + Math.random() * 50, y: 300 });

  // Windows app layout, simulated host, 1280x800
  const d = await openPage(9333, `http://127.0.0.1:${fake.port}/`, { init: fakeHost(), width: 1280, height: 800 });
  cleanups.push(() => d.close());
  await d.waitFor(`window.__ps && __ps.screen === 'home'`, 10000, 'home screen');
  await d.waitFor(`document.getElementById('pc-net').textContent.length > 0`, 3000, 'PC network line');
  check(await d.eval(`document.getElementById('help').open`), 'no phones in the network: the help is open without a click');
  const net = await d.eval(`document.getElementById('pc-net').textContent`);
  check(net === 'Этот ПК: сеть «Home», адрес 192.168.1.20.', `help names this PC's network: ${net}`);
  check(await d.eval(`document.getElementById('add-host').offsetParent !== null`), 'manual address field is in the help');
  await sleep(300);
  await snap(d, 'desktop-home-empty');
  await named(d, 'home (empty)');
  await d.eval(`window.__fakeDevices = [{ name: 'FakePhone', host: '127.0.0.1', port: ${fake.port} }]; document.getElementById('rescan').click(); true`);
  await d.waitFor(`document.querySelectorAll('.phone-item.online').length === 1`, 8000, 'discovered phone card');
  check(await d.eval(`!document.getElementById('help').open`), 'a phone is online: the help folds away');
  const label = await d.eval(`document.querySelector('.phone-item .phone').getAttribute('aria-label')`);
  check(label === `FakePhone, в сети, 127.0.0.1:${fake.port}`, `phone card is one button named "${label}"`);
  check(await d.eval(`!!document.querySelector('.phone-item .phone-letter')`), 'a phone never shown before has its letter on the card');
  await snap(d, 'desktop-home-list');
  await named(d, 'home (list)');
  await d.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await sleep(200);
  await snap(d, 'desktop-home-list-light');
  await d.eval(`document.querySelector('.phone-item .phone').click(); true`);
  await d.waitFor(`__ps.screen === 'pin'`, 5000, 'PIN screen');
  await typePin(d, '13');
  await snap(d, 'desktop-pin-typing');
  await named(d, 'PIN');
  await typePin(d, '000000');
  await d.waitFor(`document.getElementById('pin-error').textContent.length > 0`, 8000, 'PIN error');
  await snap(d, 'desktop-pin-error-light');
  await d.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(200);
  await snap(d, 'desktop-pin-error');
  await typePin(d, PIN);
  await waitLive(d, 30, 'desktop player');
  await hover(d);
  await sleep(1200);
  await snap(d, 'desktop-player');
  await named(d, 'player');
  await noHScroll(d, 'desktop player');
  check(await d.eval(`getComputedStyle(document.getElementById('ontop')).display !== 'none'`), 'desktop-only buttons visible in the app');
  await d.eval(`document.querySelector('[data-fit="cover"]').click(); true`);
  await hover(d);
  await sleep(400);
  await snap(d, 'desktop-player-cover');
  await d.eval(`document.querySelector('[data-fit="native"]').click(); true`);
  await sleep(300);
  const px = await d.eval(`(() => { const r = document.getElementById('canvas').getBoundingClientRect(); return [r.width * devicePixelRatio, r.height * devicePixelRatio, __ps.width, __ps.height]; })()`);
  check(Math.abs(px[0] - px[2]) <= 1 && Math.abs(px[1] - px[3]) <= 1, `1:1 shows ${Math.round(px[0])}x${Math.round(px[1])} screen pixels for a ${px[2]}x${px[3]} video`);
  await hover(d);
  await sleep(400);
  await snap(d, 'desktop-player-native');
  await d.eval(`document.querySelector('[data-fit="contain"]').click(); true`);

  // recording: 3 s with sound into one WebM file
  const dl = join(out, 'downloads-ui');
  rmSync(dl, { recursive: true, force: true });
  mkdirSync(dl, { recursive: true });
  await d.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
  check(await d.eval(`!document.getElementById('rec').hidden`), 'record button offered');
  await d.eval(`document.getElementById('rec').click(); true`);
  await d.waitFor(`__ps.recording && !document.getElementById('rec-bar').hidden`, 2000, 'recording on');
  await sleep(3200);
  const shown = await d.eval(`document.getElementById('rec-time').textContent`);
  check(shown === '0:03', `recording shows the red bar and its timer (${shown})`);
  await hover(d);
  await sleep(400);
  await snap(d, 'desktop-player-recording');
  await d.eval(`document.getElementById('rec').click(); true`);
  let file = null;
  for (let i = 0; i < 40 && !file; i++) {
    await sleep(250);
    file = readdirSync(dl).find((f) => /^PhoneShare FakePhone .*\.webm$/.test(f) && statSync(join(dl, f)).size > 20000);
  }
  check(!!file, 'recording saved as ' + file);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', join(dl, file)], { encoding: 'utf8' });
  const kinds = probe.stdout.split(/\r?\n/).filter(Boolean).sort().join(',');
  check(kinds === 'audio,video', `recording has one audio and one video track (${kinds})`);

  // back on the shelf, the card shows the last frame of the phone
  await d.eval(`document.getElementById('player-back').click(); true`);
  await d.waitFor(`__ps.screen === 'home' && !!document.querySelector('.phone-item img')`, 5000, 'card picture');
  check(true, 'after watching, the phone card shows its last frame');
  await snap(d, 'desktop-home-snapshot');
  await d.eval(`document.querySelector('.phone-item .phone').click(); true`);
  await waitLive(d, 5, 'saved PIN opens the player');
  check(true, 'saved PIN: the card opens the player directly');

  // Browser on a phone-sized screen, 375x812
  const m = await openPage(9333, `http://${lanIp()}:${fake.port}/`, { width: 375, height: 812 });
  cleanups.push(() => m.close());
  await m.waitFor(`window.__ps && __ps.screen === 'pin'`, 10000, 'mobile PIN');
  await m.waitFor(`document.querySelector('#pin-card .phone-letter') && document.querySelector('#pin-card .phone-letter').textContent === 'F'`, 5000, 'PIN card letter from the real name');
  check(true, 'PIN card takes the letter of the phone name from /info');
  await sleep(300);
  await snap(m, 'mobile-pin');
  await noHScroll(m, 'mobile PIN');
  check(await m.eval(`getComputedStyle(document.getElementById('pin-back')).display === 'none'`), 'no back button in plain browser');
  await typePin(m, PIN);
  await waitLive(m, 30, 'mobile player');
  await hover(m);
  await sleep(1200);
  await snap(m, 'mobile-player');
  await noHScroll(m, 'mobile player');
  await named(m, 'mobile player');
  check(await m.eval(`getComputedStyle(document.getElementById('ontop')).display === 'none'`), 'desktop-only buttons hidden in the browser');
  check(await m.eval(`getComputedStyle(document.getElementById('miracast')).display === 'none'`), 'Miracast section (Windows app only) hidden in the browser');

  const errors = [...d.errors, ...m.errors];
  check(errors.length === 0, 'no console errors: ' + JSON.stringify(errors));

  // States after the phone stops (expected socket errors from here on are not counted)
  await fake.stop();
  fake = null;
  await d.waitFor(`__ps.state === 'ended'`, 10000, 'ended overlay');
  await sleep(300);
  await snap(d, 'desktop-player-ended');
  await m.waitFor(`__ps.state === 'ended'`, 10000, 'mobile ended overlay');
  await snap(m, 'mobile-player-ended');
  console.log('screenshots: ' + shots);
  console.log('UI CHECK OK');
}

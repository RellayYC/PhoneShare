// End-to-end checks of the web receiver against FakePhone in headless Chrome.
//   node dev/e2e.mjs mse        page on a LAN address (insecure) -> MSE path, rotation, two viewers, reconnect
//   node dev/e2e.mjs webcodecs  page on 127.0.0.1 (secure) -> WebCodecs path, control of the phone
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

  // the phone's volume keys and sound switch reach the player without a reconnect
  const own = await a.eval(`__ps.gain`);
  fake.send('volume 0.25');
  await a.waitFor(`__ps.phoneVolume === 0.25 && Math.abs(__ps.gain - ${own} * 0.25) < 1e-6`, 3000, 'phone volume');
  check(true, `phone volume 0.25 scales the player: gain ${own} -> ${await a.eval('__ps.gain')}`);
  fake.send('audio off');
  await a.waitFor(`document.getElementById('toast').textContent === 'Телефон выключил звук'`, 3000, 'sound off notice');
  const quiet = await ps(a, 'audioChunks');
  await sleep(600);
  check(await ps(a, 'audioChunks') - quiet <= 2, 'sound switched off mid-stream: no more audio, the picture goes on');
  check(await ps(a, 'state') === 'live' && await ps(a, 'reconnects') === 0, 'no reconnect for a sound change');
  fake.send('audio on');
  await a.waitFor(`__ps.audioChunks > ${quiet + 10}`, 3000, 'sound back');
  check(true, 'sound switched on again mid-stream');
  await checkControl(a);
  check((await ps(a, 'errors')).length === 0, 'no player errors');
  check(a.errors.length === 0, 'no console errors: ' + JSON.stringify(a.errors));
  console.log('E2E WEBCODECS OK');
}

/** Clicks, drags, the wheel, the buttons and typing on the PC arrive at FakePhone as the phone would perform them. */
async function checkControl(a) {
  const sent = () => fake.log.split('\n').filter((l) => l.startsWith('FAKEPHONE CONTROL ')).map((l) => JSON.parse(l.slice(18)));
  const waitSent = async (n, count, what) => {
    for (let i = 0; i < 40; i++) { if (sent().length >= n + count) return sent().slice(n); await sleep(100); }
    throw new Error(`timeout: ${what} (got ${JSON.stringify(sent().slice(n))})`);
  };
  const mouse = (type, x, y, button = 'left', more = {}) => a.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: type === 'mouseMoved' ? 0 : 1, ...more });
  const click = async (x, y, button = 'left') => { await mouse('mousePressed', x, y, button); await mouse('mouseReleased', x, y, button); };
  const key = async (k) => {
    const e = k.length === 1 ? { key: k, text: k } : { key: k, code: k, windowsVirtualKeyCode: k === 'Enter' ? 13 : 8 };
    await a.send('Input.dispatchKeyEvent', { type: 'keyDown', ...e });
    await a.send('Input.dispatchKeyEvent', { type: 'keyUp', ...e });
  };
  const rect = () => a.eval(`(() => { const r = document.getElementById('canvas').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const fit = async (f) => { await a.eval(`document.querySelector('[data-fit="${f}"]').click(); true`); await sleep(300); };
  const pts = (m) => m.p.split(';').map((v) => v.split(',').map(Number));
  const near = (v, want) => Math.abs(v - want) < 0.01;

  check(await a.eval(`document.getElementById('ctl').hidden && __ps.control === false`), 'control not allowed on the phone: no control buttons on the PC');
  fake.send('control on');
  await a.waitFor(`__ps.control && !document.getElementById('ctl').hidden && document.getElementById('toast').textContent === 'Телефон разрешил управление с ПК'`, 3000, 'control allowed');
  check(true, 'the phone allows control mid-stream: the control buttons appear');
  await fit('contain');
  let n = sent().length;
  let r = await rect();
  await click(r.x + r.w / 2, r.y + r.h / 2);
  await sleep(300);
  check(sent().length === n, 'watching only: a click on the picture sends nothing');
  await a.eval(`document.querySelector('[data-nav="home"]').click(); true`);
  let got = await waitSent(n, 1, 'home button');
  check(got[0].t === 'nav' && got[0].a === 'home', 'the «Домой» button sends home');

  await a.eval(`document.getElementById('control').click(); true`);
  await a.waitFor(`__ps.controlling && document.getElementById('control').getAttribute('aria-pressed') === 'true'`, 2000, 'control mode');
  await sleep(400);   // the picture moves out from under the bars
  const clear = await a.eval(`(() => { const s = document.getElementById('stage').getBoundingClientRect(); return s.top >= document.querySelector('.hud-top').getBoundingClientRect().bottom && s.bottom <= document.querySelector('.hud-bottom').getBoundingClientRect().top; })()`);
  check(clear, 'controlling: the picture sits between the control bars, none of it under them');

  // «Вписать»: the centre is the centre; the bars beside the picture are not the phone
  r = await rect();
  const k = Math.min(r.w / 720, r.h / 1280);
  const cw = 720 * k;
  const ch = 1280 * k;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  n = sent().length;
  await click(cx, cy);
  got = await waitSent(n, 1, 'tap');
  let p = pts(got[0]);
  check(got[0].t === 'gesture' && p.length === 2 && near(p[0][0], 0.5) && near(p[0][1], 0.5), `a click at the centre of the picture taps the phone at 0.5,0.5 (${got[0].p})`);
  check(r.w - cw > 40, 'the window is wider than the picture: there are bars beside it');
  await click(r.x + (r.w - cw) / 4, cy);
  await sleep(300);
  check(sent().length === n + 1, 'a click on the bars beside the picture sends nothing');

  // a drag: the path from the press to the release, with its timing
  n = sent().length;
  const ya = cy + ch * 0.3;
  const yb = cy - ch * 0.3;
  await mouse('mousePressed', cx, ya);
  for (let i = 1; i <= 10; i++) { await mouse('mouseMoved', cx, ya + (yb - ya) * i / 10, 'left', { buttons: 1 }); await sleep(20); }
  await mouse('mouseReleased', cx, yb);
  got = await waitSent(n, 1, 'drag');
  p = pts(got[0]);
  const last = p[p.length - 1];
  check(got[0].t === 'gesture' && p.length >= 5 && Math.abs(p[0][1] - 0.8) < 0.02 && Math.abs(last[1] - 0.2) < 0.02 && last[2] >= 100,
    `a drag is a swipe along its path with its timing (${p.length} points, 0.8 -> ${last[1]}, ${last[2]} ms)`);

  // the right button is «Назад», the middle one «Домой»
  n = sent().length;
  await click(cx, cy, 'right');
  await click(cx, cy, 'middle');
  got = await waitSent(n, 2, 'right and middle buttons');
  check(got[0].t === 'nav' && got[0].a === 'back' && got[1].t === 'nav' && got[1].a === 'home', 'the right mouse button is «Назад», the middle one «Домой»');

  // the wheel: a short swipe through the cursor, against the turn
  n = sent().length;
  await a.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: 120 });
  got = await waitSent(n, 1, 'wheel');
  p = pts(got[0]);
  check(got[0].t === 'gesture' && p.length === 2 && p[0][1] > p[1][1] && near(p[0][0], 0.5) && near((p[0][1] + p[1][1]) / 2, 0.5),
    `the wheel turned down swipes up through the cursor (${got[0].p})`);

  // typing: letters (the player's own keys do nothing now), Backspace, Enter, Ctrl+V
  n = sent().length;
  const mutedBefore = await a.eval(`document.getElementById('mute').classList.contains('is-off')`);
  for (const k2 of ['m', 'ф', 'Backspace', 'Enter']) await key(k2);
  got = await waitSent(n, 4, 'typing');
  check(got[0].s === 'm' && got[1].s === 'ф' && got[2].k === 'backspace' && got[3].k === 'enter', 'keys type into the phone: letters, Backspace, Enter');
  check(await a.eval(`document.getElementById('mute').classList.contains('is-off')`) === mutedBefore, 'controlling: M types an «m», it does not mute the PC');
  n = sent().length;
  await a.eval(`(() => { const d = new DataTransfer(); d.setData('text/plain', 'строка 1\\nстрока "2" \\\\'); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true })); return true; })()`);
  got = await waitSent(n, 1, 'paste');
  check(got[0].t === 'text' && got[0].s === 'строка 1\nстрока "2" \\', 'Ctrl+V pastes the PC clipboard into the phone, line breaks and quotes intact');
  const back = await a.eval(`(() => { const r = document.querySelector('[data-nav="back"]').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  n = sent().length;
  await click(back[0], back[1]);
  await key('z');
  got = await waitSent(n, 2, 'a button, then a key');
  check(got[0].a === 'back' && got[1].s === 'z', 'after a mouse click on «Назад» the keys still go to the phone');

  // the other scales: «Растянуть» stretches, 1:1 keeps the phone's pixels, «Заполнить» crops top and bottom
  await fit('fill');
  r = await rect();
  n = sent().length;
  await click(r.x + r.w * 0.25, r.y + r.h * 0.75);
  got = await waitSent(n, 1, 'fill tap');
  p = pts(got[0]);
  check(near(p[0][0], 0.25) && near(p[0][1], 0.75), `«Растянуть»: a click a quarter across, three quarters down taps 0.25,0.75 (${got[0].p})`);
  await fit('native');
  r = await rect();
  n = sent().length;
  await click(r.x + r.w * 0.1, r.y + r.h * 0.1);
  got = await waitSent(n, 1, 'native tap');
  p = pts(got[0]);
  check(near(p[0][0], 0.1) && near(p[0][1], 0.1), `1:1: a click 72 px across and 128 px down a 720x1280 picture taps 0.1,0.1 (${got[0].p})`);
  await fit('cover');
  r = await rect();
  n = sent().length;
  await click(r.x + r.w / 2, r.y + 1);
  got = await waitSent(n, 1, 'cover tap');
  p = pts(got[0]);
  const hidden = (1280 * Math.max(r.w / 720, r.h / 1280) - r.h) / 2 / (1280 * Math.max(r.w / 720, r.h / 1280));
  check(near(p[0][0], 0.5) && p[0][1] > 0.1 && Math.abs(p[0][1] - hidden) < 0.01, `«Заполнить»: the top of the window is ${Math.round(hidden * 100)} % down the cropped phone screen (${got[0].p})`);
  await fit('contain');

  await sleep(2800);
  check(!(await a.eval(`document.body.classList.contains('idle')`)), 'controlling: the buttons stay on screen, they do not fade away');

  // the phone's owner turns control off mid-stream
  fake.send('control off');
  await a.waitFor(`!__ps.control && !__ps.controlling && document.getElementById('ctl').hidden && document.getElementById('toast').textContent === 'Телефон выключил управление с ПК'`, 3000, 'control taken away');
  n = sent().length;
  await click(cx, cy);
  await key('x');
  await sleep(300);
  check(sent().length === n && !(await a.eval(`document.getElementById('player').classList.contains('controlling')`)),
    'control taken away mid-stream: the buttons go, clicks and keys send nothing, the picture is whole again');
}

function fakeHost() { return `
  (() => {
    const listeners = [];
    const send = (data) => setTimeout(() => listeners.forEach((f) => f({ data })), 30);
    window.chrome = window.chrome || {};
    window.chrome.webview = {
      postMessage(m) {
        if (m === 'discover') send({ t: 'devices', list: window.__fakeDevices || [] });
        if (m === 'hello') send({ t: 'host', name: 'TESTPC', nets: [{ name: 'Home', ip: '192.168.1.20' }], version: '1.2.0' });
        if (m === 'update?') send({ t: 'update', latest: true });
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

  // a typed address is kept: in the field after a restart and as a card on the shelf
  await d.eval(`document.getElementById('add-host').value = '198.51.100.7:8080'; document.getElementById('add-form').requestSubmit(); true`);
  await d.waitFor(`__ps.screen === 'pin' && document.getElementById('pin-device').textContent === '198.51.100.7'`, 3000, 'typed address asks for its PIN');
  await d.eval(`document.getElementById('pin-back').click(); true`);
  await d.waitFor(`__ps.screen === 'home' && [...document.querySelectorAll('.phone-addr')].some((e) => e.textContent === '198.51.100.7:8080')`, 3000, 'typed phone on the shelf');
  await d.send('Page.reload');
  await d.waitFor(`window.__ps && __ps.screen === 'home'`, 10000, 'home after a restart');
  check(await d.eval(`document.getElementById('add-host').value`) === '198.51.100.7:8080', 'typed address is still in the field after a restart');
  check(await d.eval(`[...document.querySelectorAll('.phone-addr')].some((e) => e.textContent === '198.51.100.7:8080')`), 'typed phone stays on the shelf after a restart');

  // version and the update check button
  await d.waitFor(`document.getElementById('version').textContent === 'PhoneShare 1.2.0'`, 3000, 'version in the footer');
  await d.eval(`document.getElementById('update-check').click(); true`);
  await d.waitFor(`document.getElementById('update-status').textContent === 'Установлена последняя версия'`, 3000, 'update check result');
  check(await d.eval(`!document.getElementById('update-check').disabled`), 'update check button answers and is ready again');
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

  // control allowed on the phone: its buttons and the control mode
  fake.send('control on');
  await d.waitFor(`!document.getElementById('ctl').hidden`, 3000, 'control buttons');
  await d.eval(`document.getElementById('control').click(); true`);
  await hover(d);
  await sleep(1200);   // the toast goes, the picture settles between the bars
  await snap(d, 'desktop-player-control');
  await named(d, 'player (control)');
  await noHScroll(d, 'desktop player (control)');

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
  await m.eval(`document.getElementById('control').click(); true`);
  await hover(m);
  await sleep(600);
  await snap(m, 'mobile-player-control');
  await noHScroll(m, 'mobile player (control)');
  check(await m.eval(`document.querySelector('.ctl-toggle span').offsetParent === null && !!document.getElementById('control').getAttribute('aria-label')`),
    'phone-sized: the control toggle is an icon with its name kept');

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

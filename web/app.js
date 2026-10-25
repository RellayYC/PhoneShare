import { splitNalus, nalType, codecString, initSegment, mediaSegment, TIMESCALE } from './mp4.js';

const $ = (id) => document.getElementById(id);
const host = window.chrome && window.chrome.webview;   // present only inside the Windows app (WebView2)
const DESKTOP = !!host;
const canWebCodecs = typeof VideoDecoder === 'function' && window.isSecureContext;
if (DESKTOP) document.body.classList.add('desktop');

const store = {
  get(k, d) { try { const v = localStorage.getItem('ps.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ps.' + k, JSON.stringify(v)); } catch { /* storage blocked: settings just don't persist */ } },
};

// Live counters, also read by dev/e2e.mjs.
const stats = window.__ps = {
  screen: '', state: 'idle', decoder: canWebCodecs ? 'webcodecs' : 'mse', frames: 0, audioChunks: 0, audioState: '',
  width: 0, height: 0, latencyMs: null, fps: 0, kbps: 0, reconnects: 0, errors: [], secure: window.isSecureContext,
  phoneVolume: 1, gain: null,
};

let viewerName = DESKTOP ? 'ПК' : browserName();
const devKey = (d) => `${d.host}:${d.port}`;
let saved = store.get('devices', []);       // [{host, port, name}] — desktop list
const pins = store.get('pins', {});         // "host:port" -> PIN, only when "remember" is on
const seen = new Map();                      // discovered right now: "host:port" -> {host, port, name, at}

function browserName() {
  const ua = navigator.userAgent;
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Браузер';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b}, ${os}` : b;
}

function show(screen) {
  stats.screen = screen;
  document.body.dataset.screen = screen;
  document.body.classList.remove('idle');
  if (DESKTOP) host.postMessage('screen:' + screen);   // the window paints its title bar to match
  if (screen === 'player') requestAnimationFrame(() => placePill(false));
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function svgIcon(id, cls) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('class', 'icon ' + (cls || ''));
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(ns, 'use');
  u.setAttribute('href', '#' + id);
  s.append(u);
  return s;
}

let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------------------------------------------------------------- shelf of phones (Windows app)

function saveDevice(d) {
  saved = saved.filter((x) => devKey(x) !== devKey(d));
  saved.unshift({ host: d.host, port: d.port, name: d.name || d.host });
  store.set('devices', saved.slice(0, 20));
}

/** The phone's last screen, shrunk for its card: {src, w, h} or null. */
const snapOf = (d) => store.get('snap.' + devKey(d), null);

/** Keeps the current frame as the card picture of this phone. */
function saveSnap(dev) {
  if (!player || !dev) return;
  const [src, w, h] = player.snapshot();
  if (!w || !h) return;
  const k = Math.min(1, 240 / Math.min(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  store.set('snap.' + devKey(dev), { src: c.toDataURL('image/jpeg', 0.72), w, h });   // full storage: the card keeps its letter
}

/** Screen of a phone card: its last frame, or the first letter of its name. */
function fillScreen(body, d) {
  const screen = el('span', 'phone-screen');
  const snap = snapOf(d);
  if (snap && snap.src) {
    const img = el('img');
    img.src = snap.src;
    img.alt = '';
    if (snap.w > snap.h) screen.classList.add('landscape');
    screen.append(img);
  } else {
    screen.append(el('span', 'phone-letter', (d.name || d.host || '?').trim().charAt(0).toUpperCase()));
  }
  body.replaceChildren(screen);
}

function renderDevices() {
  const now = Date.now();
  const all = new Map();
  for (const d of saved) all.set(devKey(d), { ...d, online: false, saved: true });
  for (const [k, d] of seen) {
    if (now - d.at < 7000) all.set(k, { ...d, online: true, saved: all.has(k) });
  }
  const items = [...all.values()].sort((a, b) => (b.online - a.online) || String(a.name).localeCompare(String(b.name)));
  const cards = items.map(phoneCard);
  let n = 0;
  cards.forEach((li, i) => {   // the list is redrawn every 3 s: only a phone not shown before slides in
    if (shown.has(devKey(items[i]))) return;
    shown.add(devKey(items[i]));
    li.classList.add('enter');
    li.style.setProperty('--i', String(n++));
  });
  $('shelf').replaceChildren(...cards);
  $('shelf-empty').hidden = items.length > 0;
  // nothing online: open the help without waiting for a click, unless the person already chose
  if (!helpTouched) $('help').open = !items.some((d) => d.online);
}

function phoneCard(d) {
  const name = d.name || d.host;
  const li = el('li', 'phone-item' + (d.online ? ' online' : ''));
  const card = el('button', 'phone');
  card.type = 'button';
  card.title = name;
  card.setAttribute('aria-label', `${name}, ${d.online ? 'в сети' : 'не в сети'}, ${devKey(d)}`);
  const body = el('span', 'phone-body');
  fillScreen(body, d);
  card.append(body, el('span', 'phone-name', name), el('span', 'phone-state', d.online ? 'в сети' : 'не в сети'), el('span', 'phone-addr', devKey(d)));
  card.addEventListener('click', () => openDevice({ host: d.host, port: d.port, name: d.name }));
  li.append(card);
  if (d.saved) {
    const forget = el('button', 'icon-btn phone-forget');
    forget.type = 'button';
    forget.setAttribute('aria-label', `Забыть «${name}»`);
    forget.title = 'Забыть';
    forget.append(svgIcon('i-close'));
    forget.addEventListener('click', () => {
      saved = saved.filter((x) => devKey(x) !== devKey(d));
      delete pins[devKey(d)];
      store.set('devices', saved);
      store.set('pins', pins);
      try { localStorage.removeItem('ps.snap.' + devKey(d)); } catch { /* storage blocked */ }
      shown.delete(devKey(d));
      li.classList.add('leaving');   // fades and shrinks a little, then the shelf closes the gap
      setTimeout(renderDevices, 180);
    });
    li.append(forget);
  }
  return li;
}

let helpTouched = false;
const shown = new Set();   // phones already drawn once, so a redraw does not animate them again
document.querySelector('#help summary').addEventListener('click', () => { helpTouched = true; });

/** "Этот ПК: сеть «Home», адрес 192.168.1.23." from the window's list of networks. */
function renderPcNet(nets) {
  const t = !nets || !nets.length
    ? 'Этот ПК сейчас не подключён к сети.'
    : 'Этот ПК: ' + nets.map((n) => `сеть «${n.name}», адрес ${n.ip}`).join('; ') + '.';
  $('pc-net').textContent = t;
}

function discover() {
  if (!DESKTOP) return;
  document.body.classList.add('scanning');
  host.postMessage('discover');
  setTimeout(() => document.body.classList.remove('scanning'), 1200);
}

if (DESKTOP) {
  host.addEventListener('message', (e) => {
    const m = e.data;
    if (m.t === 'devices') {
      const now = Date.now();
      for (const d of m.list) seen.set(devKey(d), { ...d, at: now });
      if (stats.screen === 'home') renderDevices();
    } else if (m.t === 'host') {
      viewerName = 'ПК ' + m.name;
      if (m.version) $('version').textContent = `PhoneShare ${m.version}`;
      pcName = m.name;
      renderPcNet(m.nets);
    } else if (m.t === 'miracast') {
      renderMiracast(m);
    } else if (m.t === 'update') {
      renderUpdate(m);
    } else if (m.t === 'updated') {
      stats.updated = m;
      toast(m.ok ? `PhoneShare обновлён до версии ${m.version}` : `Обновление не установилось, работает версия ${m.version}`);
    }
  });
  setInterval(() => { if (stats.screen === 'home') { discover(); renderDevices(); } }, 3000);
}

$('rescan').addEventListener('click', discover);

// ---------------------------------------------------------------- updates (Windows app): the window checks GitHub, the page offers

let checking = 0;   // a check the person asked for: its answer is shown, an automatic one's error is not
function renderUpdate(m) {
  stats.update = m;   // read by dev/update-e2e.mjs
  if (checking && m.progress == null) {
    clearTimeout(checking);
    checking = 0;
    $('update-check').disabled = false;
    document.body.classList.remove('checking');
    $('update-status').textContent = m.checkError ? 'Не получилось проверить: нет связи с GitHub.'
      : m.latest ? 'Установлена последняя версия' : '';
    replay($('update-status'), 'fresh');
  }
  if (!m.version) return;
  const busy = m.progress != null && !m.error;
  $('update-text').textContent = m.error ? `Обновление не скачалось: ${m.error}`
    : busy ? `Скачиваю версию ${m.version}: ${m.progress} %` : `Доступна версия ${m.version}`;
  $('update-go').textContent = m.error ? 'Повторить' : 'Обновить';
  $('update-go').disabled = busy;
  $('update-bar').hidden = !busy;
  if (busy) $('update-bar').style.setProperty('--p', `${m.progress}%`);
  $('update').hidden = false;
}

if (DESKTOP) $('update-go').addEventListener('click', () => { $('update-go').disabled = true; host.postMessage('update'); });

if (DESKTOP) $('update-check').addEventListener('click', () => {
  $('update-check').disabled = true;
  document.body.classList.add('checking');
  $('update-status').textContent = 'Проверяю…';
  host.postMessage('update?');
  // no answer (a download is already running, the window is busy): say so instead of spinning forever
  checking = setTimeout(() => renderUpdate({ checkError: 'timeout' }), 15000);
});

// ---------------------------------------------------------------- Miracast (Windows app): the phone casts to Windows' own receiver

let pcName = 'этот ПК';
function renderMiracast(m) {
  stats.miracast = m.installed;
  if (m.opened) stats.miracastOpened = m.opened;
  $('miracast-open').textContent = m.installed ? 'Открыть приёмник Miracast' : 'Как включить Miracast';
  if (!m.opened) return;
  const cast = `На телефоне открой шторку, нажми «Трансляция» или «Smart View» и выбери «${pcName}».`;
  const steps = {
    receiver: ['Приёмник Windows открыт: не закрывай его окно.', cast],
    settings: ['В открывшихся Параметрах нажми «Дополнительные компоненты» и добавь «Беспроводной дисплей». Нужны права администратора.',
      'Вернись сюда и нажми «Открыть приёмник Miracast».', cast],
    failed: ['Открой меню «Пуск» и запусти «Беспроводной дисплей» (в Windows 10 — «Подключить»).', cast],
  }[m.opened] || [];
  $('miracast-steps').replaceChildren(...steps.map((s) => el('li', null, s)));
  $('miracast-steps').hidden = !steps.length;
}

if (DESKTOP) {
  $('miracast-open').addEventListener('click', () => host.postMessage('miracast'));
  // the receiver may have been installed in Settings meanwhile
  window.addEventListener('focus', () => { if (stats.screen === 'home') host.postMessage('miracast?'); });
}

// The typed address stays in the field and on the shelf: next time it is one click, even where discovery fails.
$('add-host').value = store.get('lastHost', '');
$('add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = $('add-host').value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const m = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(raw);
  if (!m) { $('add-error').textContent = 'Нужен адрес вида 192.168.1.23:8080.'; return; }
  $('add-error').textContent = '';
  store.set('lastHost', raw);
  const typed = { host: m[1], port: Number(m[2] || 8080), name: m[1] };
  const dev = saved.find((x) => devKey(x) === devKey(typed)) || typed;   // a phone seen before keeps its name
  if (DESKTOP) saveDevice(dev);
  openDevice(dev);
});

function openDevice(dev) {
  audio.ensure();   // inside a click: allowed to start sound
  const pin = pins[devKey(dev)];
  if (pin) startSession(dev, pin, true);
  else showPin(dev);
}

// ---------------------------------------------------------------- PIN

let pinTarget = null;
let lockTimer = null;

function showPin(dev, error, lockedSec) {
  pinTarget = dev;
  $('pin-device').textContent = dev.name || dev.host;
  fillScreen($('pin-card'), dev);
  $('pin-input').value = '';
  renderCells();
  setPinError(error || '', !!error);
  clearInterval(lockTimer);
  setPinLocked(false);
  if (lockedSec > 0) {
    const until = Date.now() + lockedSec * 1000;
    const tick = () => {
      const left = Math.ceil((until - Date.now()) / 1000);
      if (left <= 0) { clearInterval(lockTimer); setPinLocked(false); setPinError(''); return; }
      setPinError(`Слишком много неверных попыток. Попробуй снова через ${left} с.`);
    };
    setPinLocked(true);
    tick();
    lockTimer = setInterval(tick, 1000);
  }
  stats.state = 'pin';
  show('pin');
  if (!$('pin-input').disabled) $('pin-input').focus();
}

function setPinLocked(on) {
  $('pin-input').disabled = on;
  $('pin-submit').disabled = on;
}

function setPinError(text, shake) {
  $('pin-error').textContent = text;
  const field = document.querySelector('.pin-field');
  field.classList.toggle('bad', !!text && !$('pin-input').disabled);
  if (shake && text) {   // a refused PIN: a short shake on top of the red edge and the message
    field.classList.remove('shake');
    void field.offsetWidth;   // restart the animation if it is still running
    field.classList.add('shake');
  }
}

let typedLength = 0;
function renderCells() {
  const v = $('pin-input').value;
  document.querySelectorAll('.cells span').forEach((c, i) => {
    c.textContent = v[i] || '';
    c.classList.toggle('cur', i === Math.min(v.length, 5) && v.length < 6);
    if (i === v.length - 1 && v.length > typedLength) replay(c, 'typed');   // the digit just typed settles in
  });
  typedLength = v.length;
}

/** Restarts a one-shot CSS animation class. */
function replay(e, cls) {
  e.classList.remove(cls);
  void e.offsetWidth;
  e.classList.add(cls);
}

$('pin-input').addEventListener('input', () => {
  const inp = $('pin-input');
  inp.value = inp.value.replace(/\D/g, '').slice(0, 6);
  renderCells();
  if ($('pin-error').textContent) setPinError('');
  if (inp.value.length === 6) $('pin-form').requestSubmit();
});

$('pin-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('pin-input').value;
  if (v.length !== 6) { setPinError('PIN состоит из 6 цифр.', true); return; }
  audio.ensure();
  startSession(pinTarget, v, $('pin-remember').checked);
});

$('pin-back').addEventListener('click', goHome);

// ---------------------------------------------------------------- session

const clock = {
  samples: [], offset: null,
  reset() { this.samples = []; this.offset = null; },
  sample(m) {
    const now = performance.now();
    const rtt = now - m.c;
    this.samples.push({ rtt, off: m.s / 1000 - (m.c + rtt / 2) });
    if (this.samples.length > 8) this.samples.shift();
    this.offset = this.samples.reduce((a, x) => (x.rtt < a.rtt ? x : a)).off;   // least-delayed sample wins
  },
  /** Phone timestamp (µs) -> performance.now() time on this machine (ms). */
  toLocal(ptsUs) { return this.offset == null ? null : ptsUs / 1000 - this.offset; },
};

let session = null;

class Session {
  constructor(dev, pin, remember) {
    Object.assign(this, { dev, pin, remember, attempt: 0, everAuthed: false, stopped: false, lastKeyReq: 0 });
    clock.reset();
    this.open();
  }

  open() {
    clearInterval(this.countdown);
    this.authed = false;
    this.rejected = null;
    this.ended = false;
    if (!this.everAuthed) stats.state = 'connecting';
    let ws;
    try {
      ws = new WebSocket(`ws://${this.dev.host}:${this.dev.port}/ws`);
    } catch {
      this.onClose();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', pin: this.pin, name: viewerName }));
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return this.onBinary(e.data);
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      this.onText(m);
    };
    ws.onclose = () => { if (this.ws === ws) this.onClose(); };
  }

  onText(m) {
    switch (m.t) {
      case 'auth':
        if (!m.ok) { this.rejected = m; break; }
        this.authed = true;
        this.everAuthed = true;
        this.attempt = 0;
        stats.state = 'live';
        if (this.remember) { pins[devKey(this.dev)] = this.pin; store.set('pins', pins); }
        hideOverlay();
        this.ping();
        this.pinger = setInterval(() => this.ping(), 2000);
        break;
      case 'hello':
        this.dev.name = m.name;
        this.audio = m.audio;
        audio.setPhone(m.vol == null ? 1 : m.vol);   // phones before 1.2 send no volume: full
        if (DESKTOP) saveDevice(this.dev);
        $('player-name').textContent = m.name;
        document.title = `${m.name} — PhoneShare`;
        if (m.audio) audio.format(m.audio.rate, m.audio.ch);
        updateUnmuteChip();
        break;
      case 'video':
        stats.width = m.w;
        stats.height = m.h;
        applyNative();
        player.size(m.w, m.h);
        break;
      case 'time':
        clock.sample(m);
        break;
      case 'volume':   // the phone's volume keys: the PC follows
        audio.setPhone(m.v);
        break;
      case 'audio':   // the phone switched its sound on or off mid-stream
        if (!!m.audio === !!this.audio) break;
        this.audio = m.audio;
        if (m.audio) audio.format(m.audio.rate, m.audio.ch);
        updateUnmuteChip();
        toast(m.audio ? 'Телефон снова передаёт звук' : 'Телефон выключил звук');
        break;
      case 'bye':
        this.ended = true;
        break;
    }
  }

  onBinary(buf) {
    const u8 = new Uint8Array(buf);
    const pts = Number(new DataView(buf).getBigInt64(2));
    bytesThisSec += buf.byteLength;
    if (u8[0] === 1) player.config(u8.subarray(10));
    else if (u8[0] === 2) player.frame(u8.subarray(10), (u8[1] & 1) === 1, pts);
    else if (u8[0] === 3) audio.push(buf);
  }

  ping() {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'ping', c: performance.now() }));
  }

  requestKey() {
    const now = performance.now();
    if (now - this.lastKeyReq < 500 || !this.ws || this.ws.readyState !== 1) return;
    this.lastKeyReq = now;
    this.ws.send('{"t":"key"}');
  }

  onClose() {
    clearInterval(this.pinger);
    if (this.stopped) return;
    $('player').classList.remove('live');
    stats.state = 'offline';
    renderStats();
    const r = this.rejected;
    if (r) {
      this.close();
      delete pins[devKey(this.dev)];
      store.set('pins', pins);
      if (r.full) showPin(this.dev, 'К телефону уже подключено 8 зрителей. Закрой лишнее окно и попробуй снова.');
      else if (r.locked > 0) showPin(this.dev, '', r.locked);
      else showPin(this.dev, 'Неверный PIN. Сверь цифры с экраном телефона.');
      return;
    }
    if (this.everAuthed) stats.reconnects++;
    let delay;
    let title;
    let text;
    if (this.ended) {
      stopRecording();   // the phone stopped: the take is over
      stats.state = 'ended';
      delay = 3;
      title = 'Телефон остановил трансляцию';
      text = () => 'Подключусь сам, как только она снова начнётся.';
    } else {
      stats.state = this.everAuthed ? 'reconnecting' : 'connecting';
      delay = [1, 2, 4, 8][Math.min(this.attempt, 3)];
      title = this.everAuthed ? 'Связь с телефоном пропала' : 'Телефон не отвечает';
      const hint = this.everAuthed ? '' : 'Проверь, что на телефоне идёт трансляция и он в той же сети Wi-Fi. ';
      text = (s) => `${hint}Повторю через ${s} с.`;
    }
    this.attempt++;
    let left = delay;
    overlay(title, text(left), ['Повторить сейчас', () => this.open()], DESKTOP ? ['К списку', goHome] : null);
    this.countdown = setInterval(() => {
      left--;
      if (left <= 0) { clearInterval(this.countdown); this.open(); return; }
      $('overlay-text').textContent = text(left);
    }, 1000);
  }

  close() {
    this.stopped = true;
    clearInterval(this.pinger);
    clearInterval(this.countdown);
    if (this.ws) { this.ws.onclose = null; this.ws.close(); }
  }
}

function startSession(dev, pin, remember) {
  if (session) session.close();
  if (player) player.stop();
  player = canWebCodecs ? new WebCodecsPlayer($('canvas')) : new MsePlayer($('video'));
  $('canvas').hidden = !canWebCodecs;
  $('video').hidden = canWebCodecs;
  $('player-name').textContent = dev.name || dev.host;
  stats.frames = 0;
  stats.latencyMs = null;
  show('player');
  overlay(`Подключаюсь к «${dev.name || dev.host}»`, 'Обычно это занимает секунду.', null, DESKTOP ? ['Отмена', goHome] : null);
  session = new Session(dev, pin, remember);
  poke();
}

function goHome() {
  stopRecording();
  if (session) saveSnap(session.dev);
  if (session) session.close();
  session = null;
  if (player) player.stop();
  player = null;
  hideOverlay();
  document.title = 'PhoneShare';
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (DESKTOP) {
    show('home');
    renderDevices();
    discover();
    host.postMessage('miracast?');
  } else {
    showPin(pinTarget || { host: location.hostname, port: Number(location.port) || 80 });
  }
}

// ---------------------------------------------------------------- video

let player = null;

function onFrameShown(w, h) {
  stats.frames++;
  framesThisSec++;
  if (stats.state === 'live') $('player').classList.add('live');
  if (w && h && (w !== stats.width || h !== stats.height)) {
    stats.width = w;
    stats.height = h;
    applyNative();
  }
}

function noteLatency(ms) {
  if (!(ms >= 0 && ms < 10000)) return;
  stats.latencyMs = stats.latencyMs == null ? ms : stats.latencyMs * 0.9 + ms * 0.1;
}

/** Secure context (Windows app, localhost): decode Annex B directly, draw each frame as soon as it is ready. */
class WebCodecsPlayer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dec = null;
    this.cfg = null;
  }

  size() {}

  config(cfg) {
    const sps = splitNalus(cfg).find((n) => nalType(n) === 7);
    if (!sps) return;
    this.cfg = cfg.slice();
    this.codec = codecString(sps);
    this.reset();
  }

  reset() {
    if (this.dec && this.dec.state !== 'closed') this.dec.close();
    this.needKey = true;
    this.dec = new VideoDecoder({
      output: (f) => this.draw(f),
      error: (e) => {
        stats.errors.push('decoder: ' + e.message);
        setTimeout(() => { if (this.cfg && this.dec) { this.reset(); if (session) session.requestKey(); } }, 0);
      },
    });
    this.dec.configure({ codec: this.codec, optimizeForLatency: true });
  }

  frame(data, key, pts) {
    if (!this.dec || this.dec.state !== 'configured') return;
    if (this.needKey && !key) return;
    if (!key && this.dec.decodeQueueSize > 6) {   // decoder can't keep up: skip to the next keyframe
      this.needKey = true;
      if (session) session.requestKey();
      return;
    }
    let buf = data;
    if (key) {   // Annex B without a description: every keyframe carries SPS/PPS
      buf = new Uint8Array(this.cfg.length + data.length);
      buf.set(this.cfg);
      buf.set(data, this.cfg.length);
    }
    this.dec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: pts, data: buf }));
    this.needKey = false;
  }

  draw(f) {
    const c = this.canvas;
    if (c.width !== f.displayWidth || c.height !== f.displayHeight) { c.width = f.displayWidth; c.height = f.displayHeight; }
    this.ctx.drawImage(f, 0, 0);
    const local = clock.toLocal(f.timestamp);
    if (local != null) noteLatency(performance.now() - local);
    f.close();
    onFrameShown(c.width, c.height);
  }

  snapshot() { return [this.canvas, this.canvas.width, this.canvas.height]; }

  stop() {
    if (this.dec && this.dec.state !== 'closed') this.dec.close();
    this.dec = null;
    this.cfg = null;
  }
}

/** Plain http page (opened from the phone): no WebCodecs, so mux to fMP4 and feed Media Source Extensions. */
class MsePlayer {
  constructor(video) {
    this.video = video;
    this.queue = [];
    this.timer = setInterval(() => this.tick(), 250);
    this.w = 0;
    this.h = 0;
    if (video.requestVideoFrameCallback) {
      const cb = () => { if (this.timer) { onFrameShown(video.videoWidth, video.videoHeight); video.requestVideoFrameCallback(cb); } };
      video.requestVideoFrameCallback(cb);
    }
  }

  size(w, h) { this.w = w; this.h = h; }

  config(cfg) {
    const nalus = splitNalus(cfg);
    const sps = nalus.find((n) => nalType(n) === 7);
    const pps = nalus.find((n) => nalType(n) === 8);
    if (!sps || !pps) return;
    const id = `${this.w}x${this.h}:${sps.join(',')}:${pps.join(',')}`;
    if (id === this.id && this.ms) return;   // same stream after a reconnect: keep playing
    this.id = id;
    this.sps = sps.slice();
    this.pps = pps.slice();
    this.rebuild();
  }

  rebuild() {
    this.sb = null;
    this.queue = [initSegment({ width: this.w, height: this.h, sps: this.sps, pps: this.pps })];
    this.time = 0;
    this.seq = 0;
    this.needKey = true;
    this.dur = 1 / 60;
    this.last = 0;
    const ms = this.ms = new MediaSource();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(ms);
    this.video.src = this.url;
    ms.addEventListener('sourceopen', () => {
      if (this.ms !== ms) return;
      try {
        const sb = ms.addSourceBuffer(`video/mp4; codecs="${codecString(this.sps)}"`);
        sb.mode = 'segments';
        sb.addEventListener('updateend', () => this.pump());
        this.sb = sb;
        this.pump();
        if (session) session.requestKey();
      } catch (e) {
        stats.errors.push('mse: ' + e.message);
      }
    }, { once: true });
    this.video.play().catch(() => {});
  }

  frame(data, key, pts) {
    if (!this.sb) { this.needKey = true; return; }
    if (this.needKey && !key) return;
    this.needKey = false;
    // Frame duration follows the arrival rate, so the timeline stays close to real time.
    const now = performance.now();
    if (this.last) this.dur = this.dur * 0.8 + Math.min(0.1, Math.max(0.008, (now - this.last) / 1000)) * 0.2;
    this.last = now;
    const d = Math.max(1, Math.round(this.dur * TIMESCALE));
    this.queue.push(mediaSegment({ seq: ++this.seq, time: this.time, duration: d, key, nalus: splitNalus(data) }));
    this.time += d;
    this.lastPts = pts;
    this.lastArrival = now;
    if (this.queue.length > 90) this.resync();
    else this.pump();
  }

  pump() {
    const sb = this.sb;
    if (!sb || sb.updating || !this.queue.length || this.ms.readyState !== 'open') return;
    try {
      sb.appendBuffer(this.queue.shift());
    } catch (e) {
      stats.errors.push('append: ' + e.name);
      this.resync();
    }
  }

  /** Start over from the next keyframe instead of seeking through a long GOP. */
  resync() {
    if (!this.sps) return;
    this.rebuild();
  }

  tick() {
    const v = this.video;
    const sb = this.sb;
    if (!sb || !v.buffered.length) return;
    const end = v.buffered.end(v.buffered.length - 1);
    const behind = end - v.currentTime;
    if (behind > 1.5) { this.resync(); return; }
    // Small lag is eaten by playing slightly faster; nothing is skipped.
    v.playbackRate = behind > 0.3 ? 1.5 : behind > 0.12 ? 1.15 : 1;
    if (v.paused) v.play().catch(() => {});
    if (!sb.updating && v.currentTime - v.buffered.start(0) > 20) sb.remove(v.buffered.start(0), v.currentTime - 10);
    const local = clock.toLocal(this.lastPts);
    if (local != null) noteLatency(this.lastArrival - local + behind * 1000);
  }

  snapshot() { return [this.video, this.video.videoWidth, this.video.videoHeight]; }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.ms = null;
    this.sb = null;
    this.video.removeAttribute('src');
    this.video.load();
    if (this.url) URL.revokeObjectURL(this.url);
  }
}

// ---------------------------------------------------------------- audio

const audio = {
  ctx: null, bus: null, gain: null, next: 0, target: 0.06, lastAdjust: 0, rate: 48000, ch: 2,
  volume: store.get('volume', 0.8), muted: store.get('muted', false), phone: 1,

  /** Call from a click when possible: browsers only start sound after a user gesture. */
  ensure() {
    try {
      if (!this.ctx) {
        try { this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 }); } catch { this.ctx = new AudioContext(); }
        this.gain = this.ctx.createGain();
        this.gain.connect(this.ctx.destination);
        this.bus = this.ctx.createGain();   // all sound passes here; recording taps it before volume and mute
        this.bus.connect(this.gain);
        this.ctx.onstatechange = updateUnmuteChip;
        this.apply();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    } catch (e) {
      stats.errors.push('audio: ' + e.message);
    }
    updateUnmuteChip();
  },

  format(rate, ch) { this.rate = rate; this.ch = ch; this.next = 0; },

  /** What you hear: this PC's volume times the phone's own (its volume keys), or nothing when muted here. */
  apply() {
    const g = this.muted ? 0 : this.volume * this.phone;
    stats.gain = g;
    if (this.gain) this.gain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.04);   // glide: no click on a jump
  },

  setPhone(v) {
    this.phone = Math.max(0, Math.min(1, Number(v) || 0));
    stats.phoneVolume = this.phone;
    this.apply();
  },

  push(buf) {
    stats.audioChunks++;
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const ch = this.ch;
    const pcm = new Int16Array(buf, 10, (buf.byteLength - 10) >> 1);
    const frames = (pcm.length / ch) | 0;
    if (!frames) return;
    const ab = ctx.createBuffer(ch, frames, this.rate);
    for (let c = 0; c < ch; c++) {
      const d = ab.getChannelData(c);
      for (let i = 0; i < frames; i++) d[i] = pcm[i * ch + c] / 32768;
    }
    // Adaptive jitter buffer: grow on underrun, shrink slowly while stable, drop when too far ahead.
    const now = ctx.currentTime;
    if (this.next < now) {
      if (this.next > 0 && now - this.next < 0.25) { this.target = Math.min(0.25, this.target + 0.02); this.lastAdjust = now; }
      this.next = now + this.target;   // a gap longer than 250 ms is silence the phone did not send, not an underrun
    } else if (this.next - now > this.target + 0.15) {
      return;
    } else if (now - this.lastAdjust > 15 && this.target > 0.04) {
      this.target -= 0.005;
      this.lastAdjust = now;
    }
    const src = ctx.createBufferSource();
    src.buffer = ab;
    src.connect(this.bus);
    src.start(this.next);
    this.next += ab.duration;
  },
};

function updateUnmuteChip() {
  stats.audioState = audio.ctx ? audio.ctx.state : 'none';
  const need = !!(session && session.audio) && (!audio.ctx || audio.ctx.state !== 'running');
  $('unmute').hidden = !need;
  // the phone sends no sound (switched off there): the volume controls say so instead of looking broken
  const silent = !!session && session.everAuthed && !session.audio;
  $('player').classList.toggle('silent', silent);
  $('mute').title = silent ? 'Телефон не передаёт звук' : 'Звук (M)';
}

$('unmute').addEventListener('click', () => audio.ensure());

// ---------------------------------------------------------------- player controls

/** For 1:1 the picture gets its video size in CSS pixels divided by the screen's pixel ratio. */
function applyNative() {
  const r = window.devicePixelRatio || 1;
  $('player').style.setProperty('--native-w', `${stats.width / r}px`);
  $('player').style.setProperty('--native-h', `${stats.height / r}px`);
}
window.addEventListener('resize', () => { applyNative(); placePill(false); });   // also fires on a move to a screen with another scale

function applyFit(fit) {
  $('player').dataset.fit = fit;
  applyNative();
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.fit === fit)));
  placePill(true);
  store.set('fit', fit);
}

/** The light pill under the chosen scale slides to the new choice. */
function placePill(slide) {
  const b = document.querySelector('.seg button[aria-checked="true"]');
  const pill = document.querySelector('.seg-pill');
  if (!b || !b.offsetWidth) return;   // the player is hidden: placed when it shows
  pill.classList.toggle('instant', !slide || !pill.classList.contains('placed'));
  pill.style.setProperty('--x', `${b.offsetLeft}px`);
  pill.style.setProperty('--w', `${b.offsetWidth}px`);
  pill.classList.add('placed');
}
document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => applyFit(b.dataset.fit)));

function renderVolume() {
  $('volume').value = Math.round(audio.volume * 100);
  $('mute').classList.toggle('is-off', audio.muted || audio.volume === 0);
  $('mute').setAttribute('aria-label', audio.muted ? 'Включить звук' : 'Выключить звук');
}

function toggleMute() {
  audio.muted = !audio.muted;
  if (!audio.muted && audio.volume === 0) audio.volume = 0.5;
  audio.ensure();
  audio.apply();
  store.set('muted', audio.muted);
  store.set('volume', audio.volume);
  renderVolume();
}

$('mute').addEventListener('click', toggleMute);
$('volume').addEventListener('input', () => {
  audio.volume = $('volume').value / 100;
  audio.muted = false;
  audio.ensure();
  audio.apply();
  store.set('volume', audio.volume);
  store.set('muted', false);
  renderVolume();
});

function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
}
$('full').addEventListener('click', toggleFull);
document.addEventListener('fullscreenchange', () => {
  const on = !!document.fullscreenElement;
  $('full').classList.toggle('is-off', on);
  $('full').setAttribute('aria-label', on ? 'Выйти из полного экрана' : 'Полный экран');
});

/** "PhoneShare Pixel 8 2026-10-24 14-05-09.png" */
function fileName(ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const name = (session && session.dev.name || 'phone').replace(/[\\/:*?"<>|]/g, '');
  return `PhoneShare ${name} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.${ext}`;
}

function saveFile(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

function screenshot() {
  if (!player) return;
  const [src, w, h] = player.snapshot();
  if (!w || !h) { toast('Кадра ещё нет'); return; }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(src, 0, 0, w, h);
  const name = fileName('png');
  c.toBlob((blob) => {
    saveFile(blob, name);
    toast(DESKTOP ? 'Скриншот сохранён в «Изображения\\PhoneShare»' : 'Скриншот сохранён в загрузки');
  }, 'image/png');
}

// ---------------------------------------------------------------- recording

const REC_LIMIT = 1.5e9;   // ponytail: the take stays in memory until saved (~50 min at 4 Mbit/s); stream to disk if longer takes matter
const rec = { mr: null, chunks: [], bytes: 0, started: 0, timer: 0, tap: null, name: '' };
const canRecord = typeof MediaRecorder === 'function'
  && typeof (canWebCodecs ? HTMLCanvasElement.prototype.captureStream : HTMLMediaElement.prototype.captureStream) === 'function';
$('rec').hidden = !canRecord;
stats.recording = false;

function startRecording() {
  if (!player || rec.mr || !canRecord) return;
  const video = (canWebCodecs ? $('canvas').captureStream(30) : $('video').captureStream()).getVideoTracks();
  if (!video.length) { toast('Кадра ещё нет'); return; }
  audio.ensure();
  const tracks = [...video];
  if (audio.ctx) {
    rec.tap = audio.ctx.createMediaStreamDestination();
    audio.bus.connect(rec.tap);
    tracks.push(...rec.tap.stream.getAudioTracks());
  }
  const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  const mr = new MediaRecorder(new MediaStream(tracks), { mimeType, videoBitsPerSecond: 4_000_000 });
  Object.assign(rec, { mr, chunks: [], bytes: 0, started: performance.now(), name: fileName('webm') });
  mr.ondataavailable = (e) => {
    if (!e.data.size) return;
    rec.chunks.push(e.data);
    rec.bytes += e.data.size;
    if (rec.bytes > REC_LIMIT) stopRecording('limit');
  };
  mr.onstop = () => {
    const blob = new Blob(rec.chunks, { type: 'video/webm' });
    rec.chunks = [];
    if (blob.size) saveFile(blob, rec.name);
    toast((rec.why === 'limit' ? 'Память под запись кончилась. ' : '')
      + (DESKTOP ? 'Запись сохранена в «Видео\\PhoneShare»' : 'Запись сохранена в загрузки'));
  };
  rec.why = '';
  mr.start(1000);
  stats.recording = true;
  renderRec();
  rec.timer = setInterval(renderRec, 500);
}

function stopRecording(why = '') {
  if (!rec.mr) return;
  rec.why = why;
  clearInterval(rec.timer);
  if (rec.mr.state !== 'inactive') rec.mr.stop();
  rec.mr = null;
  if (rec.tap) { try { audio.bus.disconnect(rec.tap); } catch { /* already gone */ } rec.tap = null; }
  stats.recording = false;
  renderRec();
}

function renderRec() {
  const on = !!rec.mr;
  const s = on ? Math.floor((performance.now() - rec.started) / 1000) : 0;
  $('rec').classList.toggle('on', on);
  $('rec').setAttribute('aria-pressed', String(on));
  $('rec').setAttribute('aria-label', on ? 'Остановить запись' : 'Начать запись');
  $('rec-time').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  $('rec-bar').hidden = !on;
}

const toggleRecording = () => (rec.mr ? stopRecording() : startRecording());
$('rec').addEventListener('click', toggleRecording);

// card pictures stay fresh even if the window is closed mid-show
setInterval(() => { if (session && stats.state === 'live') saveSnap(session.dev); }, 10000);

$('shot').addEventListener('click', screenshot);

$('ontop').addEventListener('click', () => {
  const on = $('ontop').getAttribute('aria-pressed') !== 'true';
  $('ontop').setAttribute('aria-pressed', String(on));
  if (DESKTOP) host.postMessage('ontop:' + (on ? 1 : 0));
});

$('player-back').addEventListener('click', goHome);

document.addEventListener('keydown', (e) => {
  if (stats.screen !== 'player' || e.ctrlKey || e.altKey || e.metaKey) return;
  const t = e.target;
  if (t.tagName === 'INPUT' && t.type !== 'range') return;
  const k = e.key.toLowerCase();
  if (k === 'f' || k === 'а') toggleFull();
  else if (k === 'm' || k === 'ь') toggleMute();
  else if (k === 's' || k === 'ы') screenshot();
  else if (k === 'r' || k === 'к') toggleRecording();
  else if (k === 'escape' && document.fullscreenElement) toggleFull();   // the Windows app turns off browser keys
});

// Controls fade out after 2.5 s without movement and come back on any input.
let idleTimer;
function poke() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(function hide() {
    if (stats.screen !== 'player' || !$('overlay').hidden) return;
    if (document.querySelector('.hud:hover') || document.querySelector('.hud :focus-visible')) { idleTimer = setTimeout(hide, 1000); return; }
    document.body.classList.add('idle');
  }, 2500);
}
['pointermove', 'pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, poke, { passive: true }));

// ---------------------------------------------------------------- overlay

function overlay(title, text, primary, secondary) {
  $('overlay-title').textContent = title;
  $('overlay-text').textContent = text;
  for (const [id, action] of [['overlay-primary', primary], ['overlay-secondary', secondary]]) {
    const b = $(id);
    b.hidden = !action;
    if (action) { b.textContent = action[0]; b.onclick = action[1]; }
  }
  $('overlay').hidden = false;
  document.body.classList.remove('idle');
}

function hideOverlay() {
  $('overlay').hidden = true;
  poke();
}

// ---------------------------------------------------------------- stats

let framesThisSec = 0;
let bytesThisSec = 0;
setInterval(() => {
  stats.fps = framesThisSec;
  stats.kbps = Math.round(bytesThisSec * 8 / 1000);
  framesThisSec = 0;
  bytesThisSec = 0;
  renderStats();
}, 1000);

function renderStats() {
  if (stats.screen !== 'player') return;
  const live = stats.state === 'live';
  const lat = stats.latencyMs;
  $('st-lat').textContent = live && lat != null ? `${Math.round(lat)} мс` : '—';
  $('st-lat').classList.toggle('warn', live && lat > 250);
  $('st-fps').textContent = live ? `${stats.fps}/с` : '—';
  $('st-rate').textContent = live ? `${(stats.kbps / 1000).toFixed(1)} Мбит/с` : '—';
  updateUnmuteChip();
}

// ---------------------------------------------------------------- start

applyFit(store.get('fit', 'contain'));
renderVolume();

if (DESKTOP) {
  show('home');
  renderDevices();
  discover();
  host.postMessage('hello');
  host.postMessage('miracast?');
} else {
  const dev = { host: location.hostname, port: Number(location.port) || 80, name: 'Телефон' };
  fetch('/info').then((r) => r.json()).then((i) => {
    dev.name = i.name;
    if (stats.screen === 'pin') { $('pin-device').textContent = i.name; fillScreen($('pin-card'), dev); }
  }).catch(() => {});
  const pin = pins[devKey(dev)];
  if (pin) startSession(dev, pin, true);
  else showPin(dev);
}

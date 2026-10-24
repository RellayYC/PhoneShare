// Renders web/icon.svg at the Windows icon sizes in headless Chrome and packs them into desktop/app.ico (PNG entries).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, startChrome, openPage } from './harness.mjs';

const SIZES = [16, 20, 24, 32, 40, 48, 64, 256];
const svg = readFileSync(join(root, 'web/icon.svg'), 'utf8');
const chrome = await startChrome(9335);
const pngs = [];
try {
  const cdp = await openPage(chrome.debugPort, 'about:blank');
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  for (const n of SIZES) {
    await cdp.eval(`(() => {
      document.body.style.margin = '0';
      document.body.innerHTML = ${JSON.stringify(svg)};
      const s = document.querySelector('svg');
      s.setAttribute('width', ${n}); s.setAttribute('height', ${n}); s.style.display = 'block';
      return true; })()`);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: n, height: n, scale: 1 } });
    pngs.push(Buffer.from(shot.data, 'base64'));
  }
  cdp.close();
} finally {
  chrome.stop();
}

const head = Buffer.alloc(6 + 16 * SIZES.length);
head.writeUInt16LE(0, 0);
head.writeUInt16LE(1, 2);                 // type: icon
head.writeUInt16LE(SIZES.length, 4);
let offset = head.length;
SIZES.forEach((n, i) => {
  const e = 6 + 16 * i;
  head[e] = n >= 256 ? 0 : n;             // 0 means 256
  head[e + 1] = n >= 256 ? 0 : n;
  head.writeUInt16LE(1, e + 4);           // planes
  head.writeUInt16LE(32, e + 6);          // bits per pixel
  head.writeUInt32LE(pngs[i].length, e + 8);
  head.writeUInt32LE(offset, e + 12);
  offset += pngs[i].length;
});
const ico = Buffer.concat([head, ...pngs]);
writeFileSync(join(root, 'desktop/app.ico'), ico);
console.log(`desktop/app.ico: ${SIZES.join(', ')} px, ${ico.length} bytes`);

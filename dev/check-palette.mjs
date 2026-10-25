// One palette, four copies: web/style.css, the phone app's colors.xml (day and night), the window colours in
// desktop/Program.cs and the title bar colour desktop-e2e expects. Checks they agree and that text and field edges
// pass WCAG AA contrast in both themes.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');
let failed = false;
function check(ok, what) {
  console.log((ok ? 'ok  ' : 'BAD ') + what);
  if (!ok) failed = true;
}
const hex = (s) => s.toUpperCase();

// ---- web/style.css: the first :root is the light theme, the :root inside prefers-color-scheme: dark overrides it
const css = read('web/style.css');
const vars = (block) => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], hex(m[2])]));
const lightBlock = /:root\s*\{([^}]*)\}/.exec(css);
const darkBlock = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css);
if (!lightBlock || !darkBlock) { console.log('PALETTE FAILED: no light or dark :root in web/style.css'); process.exit(1); }
const web = { light: vars(lightBlock[1]) };
web.dark = { ...web.light, ...vars(darkBlock[1]) };

// ---- android colors.xml
const colors = (f) => Object.fromEntries([...read(f).matchAll(/<color name="([a-z0-9_]+)">(#[0-9A-Fa-f]{6})<\/color>/g)].map((m) => [m[1], hex(m[2])]));
const android = { light: colors('android/res/values/colors.xml') };
android.dark = { ...android.light, ...colors('android/res/values-night/colors.xml') };

// ---- desktop/Program.cs: static readonly Color NameLight = Color.FromArgb(0x.., 0x.., 0x..)
const cs = Object.fromEntries([...read('desktop/Program.cs').matchAll(/(\w+) = Color\.FromArgb\(0x([0-9A-Fa-f]{2}), 0x([0-9A-Fa-f]{2}), 0x([0-9A-Fa-f]{2})\)/g)]
  .map((m) => [m[1], hex('#' + m[2] + m[3] + m[4])]));

// ---- dev/desktop-e2e.mjs: const paper = dark ? [0x.., ..] : [0x.., ..]
const e2e = /const paper = dark \? \[0x(\w\w), 0x(\w\w), 0x(\w\w)\] : \[0x(\w\w), 0x(\w\w), 0x(\w\w)\]/.exec(read('dev/desktop-e2e.mjs'));

const ANDROID = { paper: 'paper', surface: 'surface', raised: 'raised', ink: 'ink', 'ink-2': 'ink2', line: 'line', 'field-line': 'field_line',
  lamp: 'lamp', 'on-lamp': 'on_lamp', online: 'online', danger: 'danger' };
const CS = { paper: 'Paper', surface: 'Surface', ink: 'Ink', 'ink-2': 'Ink2', line: 'Line' };
for (const theme of ['light', 'dark']) {
  for (const [token, name] of Object.entries(ANDROID)) {
    check(web[theme][token] && web[theme][token] === android[theme][name], `${theme} --${token} ${web[theme][token]} = android ${name} ${android[theme][name]}`);
  }
  const suffix = theme === 'light' ? 'Light' : 'Dark';
  for (const [token, name] of Object.entries(CS)) {
    check(web[theme][token] === cs[name + suffix], `${theme} --${token} ${web[theme][token]} = Program.cs ${name}${suffix} ${cs[name + suffix]}`);
  }
}
// the WinForms fallback page has one primary button colour in both themes: the light lamp
check(web.light.lamp === cs.Lamp && web.light['lamp-press'] === cs.LampPress, `--lamp/--lamp-press ${web.light.lamp}/${web.light['lamp-press']} = Program.cs Lamp/LampPress ${cs.Lamp}/${cs.LampPress}`);
const e2ePaper = e2e && { dark: hex('#' + e2e[1] + e2e[2] + e2e[3]), light: hex('#' + e2e[4] + e2e[5] + e2e[6]) };
check(!!e2ePaper && e2ePaper.light === web.light.paper && e2ePaper.dark === web.dark.paper,
  `desktop-e2e expects the title bar in the paper colour (${e2ePaper && e2ePaper.light} / ${e2ePaper && e2ePaper.dark})`);

// ---- contrast, WCAG 2.1: text 4.5:1 (1.4.3), field edges and focus rings 3:1 (1.4.11)
const lum = (h) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const PAIRS = [
  ...['ink', 'ink-2'].flatMap((fg) => ['paper', 'surface', 'raised'].map((bg) => [fg, bg, 4.5])),
  ...['online', 'danger'].flatMap((fg) => ['paper', 'surface'].map((bg) => [fg, bg, 4.5])),
  ['on-lamp', 'lamp', 4.5],
  ...['paper', 'surface'].flatMap((bg) => [['field-line', bg, 3], ['focus', bg, 3]]),
];
for (const theme of ['light', 'dark']) {
  for (const [fg, bg, min] of PAIRS) {
    const a = web[theme][fg], b = web[theme][bg];
    const r = a && b ? ratio(a, b) : 0;
    check(r >= min, `${theme} --${fg} ${a} on --${bg} ${b}: ${r.toFixed(2)}:1 (needs ${min})`);
  }
}

if (failed) { console.log('PALETTE FAILED'); process.exit(1); }
console.log('PALETTE OK');

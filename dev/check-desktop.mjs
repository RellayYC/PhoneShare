// Builds the Windows app and checks what a user downloads: one x64 .NET Framework 4.8 exe with web/, the icon and the
// WebView2 libraries inside, nothing next to it, and a zip holding just that exe.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const exePath = join(dist, 'PhoneShare.exe');
const zip = join(dist, 'PhoneShare-Windows.zip');
const pkg = join(root, '.tools/nuget/microsoft.web.webview2/1.0.4314.35');   // desktop/build.ps1 keeps packages there

function fail(msg) { console.log('DESKTOP BUILD FAILED: ' + msg); process.exit(1); }
function check(ok, what) { if (!ok) fail(what); console.log('ok  ' + what); }

const build = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'desktop/build.ps1')], { encoding: 'utf8' });
process.stdout.write(build.stdout.split('\n').filter((l) => /warning|error|DESKTOP:/i.test(l)).join('\n') + '\n');
if (build.status !== 0) fail('build.ps1 exited ' + build.status + '\n' + build.stdout + build.stderr);

const exe = readFileSync(exePath);
const pe = exe.readUInt32LE(0x3c);
check(exe.toString('latin1', pe, pe + 4) === 'PE\0\0', 'PhoneShare.exe is a PE file');
check(exe.readUInt16LE(pe + 4) === 0x8664, 'machine is x64');
const opt = pe + 24;
check(exe.readUInt16LE(opt) === 0x20b, 'PE32+ image');
check(exe.readUInt16LE(opt + 68) === 2, 'Windows GUI subsystem (no console window)');
check(exe.readUInt32LE(opt + 112 + 14 * 8) !== 0, 'has a CLR header (managed exe)');
check(exe.includes(Buffer.from('.NETFramework,Version=v4.8')), 'targets .NETFramework,Version=v4.8');

check(!exe.includes(randomBytes(24)), 'negative control: random bytes are not found in the exe');
for (const f of readdirSync(join(root, 'web'))) check(exe.includes(readFileSync(join(root, 'web', f))), `web/${f} embedded byte for byte`);
const ico = readFileSync(join(root, 'desktop/app.ico'));
const count = ico.readUInt16LE(4);
let biggest = null;
for (let i = 0; i < count; i++) {
  const e = 6 + 16 * i;
  if ((ico[e] || 256) === 256) biggest = ico.subarray(ico.readUInt32LE(e + 12), ico.readUInt32LE(e + 12) + ico.readUInt32LE(e + 8));
}
check(count >= 6 && biggest && exe.includes(biggest), `app.ico (${count} sizes) embedded with its 256 px image`);
for (const [f, what] of [['lib/net462/Microsoft.Web.WebView2.Core.dll', 'WebView2 Core'], ['lib/net462/Microsoft.Web.WebView2.WinForms.dll', 'WebView2 WinForms'],
  ['runtimes/win-x64/native/WebView2Loader.dll', 'x64 WebView2Loader']]) {
  check(exe.includes(readFileSync(join(pkg, f))), `${what} embedded byte for byte`);
}

check(readdirSync(dist).every((f) => !/\.dll$|\.config$/i.test(f)) && !existsSync(join(dist, 'PhoneShare-Windows')), 'nothing ships next to the exe');
const list = spawnSync(join(process.env.SystemRoot || 'C:/Windows', 'System32/tar.exe'), ['-tf', zip], { encoding: 'utf8' });
const entries = list.stdout.split(/\r?\n/).filter(Boolean);
check(list.status === 0 && entries.length === 1 && entries[0] === 'PhoneShare.exe', `zip holds just PhoneShare.exe (${entries.join(', ')})`);
console.log(`DESKTOP BUILD OK (${Math.round(exe.length / 1024)} KB)`);

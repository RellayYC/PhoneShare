// G15: builds the exe and the MSI, then reads the MSI's own tables (WindowsInstaller COM) and unpacks it (wix msi decompile):
// per-user, the VERSION version, %LOCALAPPDATA%\Programs\PhoneShare, Start-menu and desktop shortcuts, and the exe inside
// byte for byte the built one.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
function fail(msg) { console.log('MSI FAILED: ' + msg); process.exit(1); }
function check(ok, what) { if (!ok) fail(what); console.log('ok  ' + what); }
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const ps = (script, env = {}) => spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
  { encoding: 'utf8', env: { ...process.env, ...env } });

for (const s of ['desktop/build.ps1', 'installer/build.ps1']) {
  const b = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, s)], { encoding: 'utf8' });
  if (b.status !== 0) fail(`${s} exited ${b.status}\n${b.stdout}${b.stderr}`);
}
const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
const msi = join(root, 'dist', `PhoneShare-${version}-x64.msi`);
const exe = join(root, 'dist', 'PhoneShare.exe');
check(existsSync(msi), 'built ' + msi);
check(readdirSync(join(root, 'dist')).filter((f) => f.endsWith('.msi')).length === 1, 'one MSI in dist');

const read = ps(`$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$i = New-Object -ComObject WindowsInstaller.Installer
$db = $i.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $i, @($env:MSI, 0))
function rows($sql) {
  $v = $db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $db, @($sql)); [void]$v.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $v, $null)
  $n = ($sql -replace '^SELECT (.*) FROM.*$', '$1').Split(',').Count; $out = @()
  while ($r = $v.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $v, $null)) {
    $out += ,@(1..$n | ForEach-Object { $r.GetType().InvokeMember('StringData', 'GetProperty', $null, $r, @([int]$_)) })
  }
  [void]$v.GetType().InvokeMember('Close', 'InvokeMethod', $null, $v, $null); ,$out
}
$si = $db.GetType().InvokeMember('SummaryInformation', 'GetProperty', $null, $db, @(0))
@{
  props = rows 'SELECT Property, Value FROM Property'
  dirs = rows 'SELECT Directory, Directory_Parent, DefaultDir FROM Directory'
  links = rows 'SELECT Shortcut, Directory_, Target FROM Shortcut'
  words = $si.GetType().InvokeMember('Property', 'GetProperty', $null, $si, @(15))
  template = $si.GetType().InvokeMember('Property', 'GetProperty', $null, $si, @(7))
} | ConvertTo-Json -Compress -Depth 5`, { MSI: msi });
if (read.status !== 0) fail('reading the MSI: ' + read.stderr);
const t = JSON.parse(read.stdout.trim());
const prop = Object.fromEntries(t.props);
const dir = Object.fromEntries(t.dirs.map(([id, parent, name]) => [id, { parent, name: name.split(':').pop().split('|').pop() }]));

check(prop.ProductVersion === version, `ProductVersion ${prop.ProductVersion} is VERSION ${version}`);
check(prop.ProductName === 'PhoneShare' && /^\{[0-9A-F-]{36}\}$/.test(prop.UpgradeCode), 'product PhoneShare with an UpgradeCode');
check(!prop.ALLUSERS && (t.words & 8) === 8, 'per-user: no ALLUSERS, no elevation (word count bit 8)');
check(t.template.startsWith('x64;'), 'x64 package: ' + t.template);
const path = [];
for (let d = 'INSTALLFOLDER'; d && dir[d]; d = dir[d].parent) { path.unshift(d.endsWith('Folder') && d !== 'INSTALLFOLDER' ? d : dir[d].name); if (path[0] === d) break; }   // stops at the standard folder
check(path.join('\\') === 'LocalAppDataFolder\\Programs\\PhoneShare', 'installs to ' + path.join('\\'));
const where = Object.fromEntries(t.links.map(([, d, target]) => [d, target]));
check(t.links.length === 2 && where.ProgramMenuFolder === '[INSTALLFOLDER]PhoneShare.exe' && where.DesktopFolder === '[INSTALLFOLDER]PhoneShare.exe',
  'Start-menu and desktop shortcuts open [INSTALLFOLDER]PhoneShare.exe');

// what the MSI would put on disk: its cabinet unpacked by WiX itself, without Windows Installer
const tmp = mkdtempSync(join(tmpdir(), 'ps-msi-'));
try {
  const d = spawnSync('wix', ['msi', 'decompile', msi, '-x', tmp, '-o', join(tmp, 'out.wxs')], { encoding: 'utf8' });
  check(d.status === 0, 'wix msi decompile unpacks it, exit ' + d.status);
  const files = readdirSync(join(tmp, 'File'));
  check(files.length === 1 && files[0] === 'PhoneShareExe', 'the MSI holds one file, PhoneShareExe: ' + files.join(', '));
  check(/<File Id="PhoneShareExe"[^>]*Name="PhoneShare\.exe"/.test(readFileSync(join(tmp, 'out.wxs'), 'utf8')), 'installed as PhoneShare.exe');
  check(sha(join(tmp, 'File', files[0])) === sha(exe), 'and it is byte for byte dist/PhoneShare.exe');
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log('MSI OK');

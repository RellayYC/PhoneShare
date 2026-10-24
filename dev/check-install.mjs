// Checks the per-user install on this PC: the Start menu and desktop shortcuts open
// %LOCALAPPDATA%\Programs\PhoneShare\PhoneShare.exe, and that exe is byte for byte dist/PhoneShare.exe.
// Read-only: run desktop/install.ps1 first.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
function fail(msg) { console.log('INSTALL CHECK FAILED: ' + msg); process.exit(1); }
function check(ok, what) { if (!ok) fail(what); console.log('ok  ' + what); }
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

const ps1 = `$sh = New-Object -ComObject WScript.Shell
$out = @{ local = $env:LOCALAPPDATA; links = @() }
foreach ($l in @((Join-Path ([Environment]::GetFolderPath('Programs')) 'PhoneShare.lnk'), (Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'PhoneShare.lnk'))) {
  $out.links += @{ path = $l; exists = (Test-Path $l); target = $(if (Test-Path $l) { $sh.CreateShortcut($l).TargetPath } else { '' }) }
}
$out | ConvertTo-Json -Compress -Depth 4`;
const r = spawnSync('powershell', ['-NoProfile', '-Command', ps1], { encoding: 'utf8' });
if (r.status !== 0) fail(r.stderr);
const info = JSON.parse(r.stdout.trim());
const installed = join(info.local, 'Programs', 'PhoneShare', 'PhoneShare.exe');
const built = join(root, 'dist', 'PhoneShare.exe');

check(existsSync(installed), 'installed: ' + installed);
check(existsSync(built) && sha(installed) === sha(built), 'installed exe is byte for byte dist/PhoneShare.exe');
for (const l of info.links) {
  check(l.exists && l.target.toLowerCase() === installed.toLowerCase(), `shortcut ${l.path} opens the installed exe`);
}
console.log('INSTALL OK');

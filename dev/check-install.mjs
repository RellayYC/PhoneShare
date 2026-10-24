// Checks the MSI install on this PC: Windows Installer has PhoneShare VERSION registered, its folder (HKCU
// Software\PhoneShare\Setup InstallDir) is off the system drive, the exe there is byte for byte dist/PhoneShare.exe,
// and the Start menu and desktop shortcuts open it. Read-only: install first, e.g.
//   msiexec /i dist\PhoneShare-x.y.z-x64.msi INSTALLFOLDER=W:\PhoneShare\App\
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
$k = Get-ItemProperty 'HKCU:\Software\PhoneShare\Setup' -ErrorAction SilentlyContinue
$out = @{ dir = "$($k.InstallDir)"; version = "$($k.Version)"; system = $env:SystemDrive; links = @() }
foreach ($l in @((Join-Path ([Environment]::GetFolderPath('Programs')) 'PhoneShare.lnk'), (Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'PhoneShare.lnk'))) {
  $out.links += @{ path = $l; exists = (Test-Path $l); target = $(if (Test-Path $l) { $sh.CreateShortcut($l).TargetPath } else { '' }) }
}
$out | ConvertTo-Json -Compress -Depth 4`;
const r = spawnSync('powershell', ['-NoProfile', '-Command', ps1], { encoding: 'utf8' });
if (r.status !== 0) fail(r.stderr);
const info = JSON.parse(r.stdout.trim());
const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
const installed = join(info.dir, 'PhoneShare.exe');
const built = join(root, 'dist', 'PhoneShare.exe');

check(info.dir && info.version === version, `the MSI has PhoneShare ${info.version} registered in ${info.dir} (VERSION ${version})`);
check(!info.dir.toUpperCase().startsWith(info.system.toUpperCase()), 'not on the system drive ' + info.system);
check(existsSync(installed) && existsSync(built) && sha(installed) === sha(built), 'installed exe is byte for byte dist/PhoneShare.exe');
for (const l of info.links) {
  check(l.exists && l.target.toLowerCase() === installed.toLowerCase(), `shortcut ${l.path} opens the installed exe`);
}
console.log('INSTALL OK');

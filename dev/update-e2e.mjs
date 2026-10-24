// G16/G17: the Windows app updating itself from a local stand-in for GitHub Releases, signed with the real key.
//   node dev/update-e2e.mjs portable    a copy in a test folder (not the MSI's): it swaps in the new exe
//   node dev/update-e2e.mjs installed   installs the 0.0.1 MSI for this user into dev/.out/update/installed, updates it to
//                                       0.0.2 through the MSI, uninstalls; a real PhoneShare install is removed first
//                                       and put back afterwards from dist (same folder), so it must not be running
// Builds 0.0.1 and 0.0.2 under dev/.out/update. Checks: a release with a broken signature is ignored; a signed newer one is
// offered on the home screen; the click downloads it, the app quits and starts again as 0.0.2 and says so; 0.0.2 offers nothing.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { root, out, sleep, killTree, Cdp } from './harness.mjs';
import { latest } from '../installer/release.mjs';

const mode = process.argv[2];
if (mode !== 'portable' && mode !== 'installed') { console.log('usage: node dev/update-e2e.mjs portable|installed'); process.exit(1); }
const TAG = 'UPDATE ' + mode.toUpperCase();
const DEBUG_PORT = 9350;
const dir = join(out, 'update');
const home = join(dir, 'home');
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

function fail(msg) { throw new Error(msg); }
function check(ok, what) { if (!ok) fail(what); console.log('ok  ' + what); }
function pwsh(file, args) {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, file), ...args], { encoding: 'utf8' });
  if (r.status !== 0) fail(`${file} ${args.join(' ')} exited ${r.status}\n${r.stdout}${r.stderr}`);
}
const fileVersion = (f) => spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Item $env:F).VersionInfo.FileVersion`],
  { encoding: 'utf8', env: { ...process.env, F: f } }).stdout.trim();
/** PhoneShare processes started from exactly this exe. */
const pidsOf = (exe) => spawnSync('powershell', ['-NoProfile', '-Command',
  `@(Get-Process PhoneShare -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:F } | ForEach-Object Id) -join ','`],
  { encoding: 'utf8', env: { ...process.env, F: exe } }).stdout.trim().split(',').filter(Boolean).map(Number);
const msiexec = (args) => spawnSync('msiexec.exe', args, { encoding: 'utf8' }).status;
const installDir = () => (/InstallDir\s+REG_SZ\s+(.+)/.exec(spawnSync('reg', ['query', 'HKCU\\Software\\PhoneShare\\Setup', '/v', 'InstallDir'],
  { encoding: 'utf8' }).stdout) || [])[1]?.trim();
/** Product codes of every installed PhoneShare (the MSI's UpgradeCode). */
const products = () => spawnSync('powershell', ['-NoProfile', '-Command', `$i = New-Object -ComObject WindowsInstaller.Installer
@($i.GetType().InvokeMember('RelatedProducts', 'GetProperty', $null, $i, @('{8E8B0BFD-51F1-442A-AECF-3043F0C6D9F9}'))) -join ','`],
  { encoding: 'utf8' }).stdout.trim().split(',').filter(Boolean);

async function waitUntil(fn, ms, what) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e.message; }
    await sleep(250);
  }
  fail(`timeout: ${what} (last: ${JSON.stringify(last)})`);
}

async function page() {
  const target = await waitUntil(async () => {
    const list = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json());
    return list.find((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:478\d\d\//.test(t.url));
  }, 30000, 'page inside the window');
  const cdp = await Cdp.open(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.waitFor(`window.__ps && window.__ps.screen === 'home'`, 15000, 'home screen');
  return cdp;
}

// ---- the two versions and the "GitHub" serving them
rmSync(dir, { recursive: true, force: true });
for (const v of ['0.0.1', '0.0.2']) {
  pwsh('desktop/build.ps1', ['-Version', v, '-Out', join(dir, v)]);
  pwsh('installer/build.ps1', ['-Version', v, '-Exe', join(dir, v, 'PhoneShare.exe'), '-Out', join(dir, v)]);
}
const v2 = { exe: join(dir, '0.0.2', 'PhoneShare.exe'), msi: join(dir, '0.0.2', 'PhoneShare-0.0.2-x64.msi') };
check(fileVersion(join(dir, '0.0.1', 'PhoneShare.exe')).startsWith('0.0.1.') && fileVersion(v2.exe).startsWith('0.0.2.'), 'built 0.0.1 and 0.0.2');
const good = latest({ version: '0.0.2', msi: v2.msi, exe: v2.exe });
const [json, sig] = good.toString().split('\n');
const forged = Buffer.from(json.replace(/"exeSha256":"[0-9a-f]+"/, `"exeSha256":"${'0'.repeat(64)}"`) + '\n' + sig);
check(forged.toString() !== good.toString(), 'forged latest.txt differs from the signed one');
let served = forged;
const hits = [];
const server = createServer((req, res) => {
  hits.push(req.url);
  const body = { '/latest.txt': served, '/PhoneShare.exe': readFileSync(v2.exe), '/PhoneShare-0.0.2-x64.msi': readFileSync(v2.msi) }[req.url];
  if (!body) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Length': body.length }).end(body);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const env = { ...process.env, PHONESHARE_HOME: home, PHONESHARE_UPDATE_URL: `http://127.0.0.1:${server.address().port}`,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEBUG_PORT}` };

let exe, proc, cdp, ok = false, real;
try {
  if (mode === 'portable') {
    exe = join(dir, 'run', 'PhoneShare.exe');
    mkdirSync(join(dir, 'run'), { recursive: true });
    copyFileSync(join(dir, '0.0.1', 'PhoneShare.exe'), exe);
  } else {
    const found = installDir();
    if (found) {
      // the test's 0.0.1 cannot go over a newer real install: take it off now, put it back from dist in finally
      const back = join(root, 'dist', `PhoneShare-${readFileSync(join(root, 'VERSION'), 'utf8').trim()}-x64.msi`);
      if (!existsSync(back)) fail('PhoneShare is installed here and there is no ' + back + ' to put it back from');
      if (pidsOf(join(found, 'PhoneShare.exe')).length) fail('close the installed PhoneShare first: ' + found);
      real = found;
      for (const p of products()) msiexec(['/x', p, '/qn']);
      check(!installDir(), 'the real install in ' + real + ' is removed for the test');
    }
    // into a folder of its own (not the default under %LOCALAPPDATA%), which the 0.0.2 upgrade has to find again
    const target = join(dir, 'installed');
    const code = msiexec(['/i', join(dir, '0.0.1', 'PhoneShare-0.0.1-x64.msi'), '/qn', `INSTALLFOLDER=${target}\\`]);
    check(code === 0, 'MSI 0.0.1 installs for this user into ' + target + ', exit ' + code);
    exe = join(target, 'PhoneShare.exe');
  }
  check(existsSync(exe) && fileVersion(exe).startsWith('0.0.1.'), 'running 0.0.1 from ' + exe);
  proc = spawn(exe, [], { env, stdio: 'ignore' });
  cdp = await page();

  // ---- a broken signature: refused, nothing on screen
  const bad = await cdp.waitFor(`window.__ps.update`, 15000, 'update check');
  check(/Подпись/.test(bad.checkError || ''), 'a forged latest.txt is refused: ' + JSON.stringify(bad));
  check(await cdp.eval(`document.getElementById('update').hidden`), 'and nothing is offered');
  check(!hits.some((u) => u !== '/latest.txt'), 'nothing but latest.txt was fetched');

  // ---- the signed release: offered, downloaded on click, installed, restarted
  served = good;
  await cdp.eval(`window.__ps.update = null, location.reload(), true`);
  cdp.close();
  cdp = await page();
  const offer = await cdp.waitFor(`window.__ps.update`, 15000, 'update check after reload');
  check(offer.version === '0.0.2', 'a signed 0.0.2 is offered: ' + JSON.stringify(offer));
  const text = await cdp.eval(`!document.getElementById('update').hidden && document.getElementById('update-text').textContent`);
  check(text === 'Доступна версия 0.0.2', 'the home screen says so: ' + text);
  await cdp.eval(`document.getElementById('update-go').click(), true`);
  const old = proc.pid;
  await waitUntil(() => proc.exitCode !== null, 30000, 'the old app quits after the download');
  check(hits.includes(mode === 'portable' ? '/PhoneShare.exe' : '/PhoneShare-0.0.2-x64.msi'),
    mode === 'portable' ? 'a portable copy downloads the bare exe' : 'an installed copy downloads the MSI');
  cdp.close();
  const pid = (await waitUntil(() => pidsOf(exe).filter((p) => p !== old)[0], 120000, 'the app starting again'));
  cdp = await page();
  const said = await cdp.waitFor(`window.__ps.updated`, 15000, 'the update result on the page');
  check(said.ok === true && said.version === '0.0.2', 'it starts again as 0.0.2 and says it was updated: ' + JSON.stringify(said));
  check(fileVersion(exe).startsWith('0.0.2.') && sha(exe) === sha(v2.exe), 'the exe on disk is now byte for byte 0.0.2');
  const after = await cdp.waitFor(`window.__ps.update`, 15000, 'update check in 0.0.2');
  check(after.latest === true && await cdp.eval(`document.getElementById('update').hidden`), '0.0.2 finds itself up to date and offers nothing');
  check(!existsSync(join(home, 'Update')), 'the download cache is cleaned up');
  if (mode === 'installed') {
    const reg = spawnSync('reg', ['query', 'HKCU\\Software\\PhoneShare\\Setup', '/v', 'Version'], { encoding: 'utf8' }).stdout;
    check(/0\.0\.2/.test(reg), 'Windows Installer has 0.0.2 registered');
    check(!existsSync(join(process.env.LOCALAPPDATA, 'Programs', 'PhoneShare')), 'the upgrade stayed in its folder, nothing went to the default one');
  }
  killTree(pid);
  ok = true;
} catch (e) {
  console.log(e.message);
} finally {
  if (cdp) cdp.close();
  if (proc && proc.exitCode === null) killTree(proc.pid);
  if (exe) for (const p of pidsOf(exe)) killTree(p);
  server.close();
  if (mode === 'installed') {
    await sleep(1000);
    for (const v of ['0.0.2', '0.0.1']) msiexec(['/x', join(dir, v, `PhoneShare-${v}-x64.msi`), '/qn']);
    if (real) {
      const code = msiexec(['/i', join(root, 'dist', `PhoneShare-${readFileSync(join(root, 'VERSION'), 'utf8').trim()}-x64.msi`), '/qn', `INSTALLFOLDER=${real}`]);
      if (code !== 0 || installDir() !== real) { console.log(`putting the real install back into ${real} failed, exit ${code}`); ok = false; }
      else console.log('ok  the real install is back in ' + real);
    }
  }
}
console.log(ok ? TAG + ' OK' : TAG + ' FAILED');
process.exit(ok ? 0 : 1);

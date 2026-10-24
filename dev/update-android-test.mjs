// G18: the phone's updater against latest.txt signed with the real key (installer/release.mjs latest()), served locally,
// plus the APK manifest: REQUEST_INSTALL_PACKAGES and a versionCode taken from VERSION.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { latest, versionCode } from '../installer/release.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const jdk = process.env.JAVA_HOME && process.env.JAVA_HOME.toLowerCase().includes('jdk') ? process.env.JAVA_HOME : 'W:/jdk';
const bt = join(root, '.tools/android-sdk/build-tools/36.1.0');
const apk = join(root, 'dist/PhoneShare.apk');
const out = join(root, 'dev/.out/updatertest');

function fail(msg) { console.log('ANDROID UPDATE FAILED: ' + msg); process.exit(1); }
function check(ok, what) { if (!ok) fail(what); console.log('ok  ' + what); }

const build = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'android/build.ps1')], { encoding: 'utf8' });
if (build.status !== 0) fail('android/build.ps1 exited ' + build.status + '\n' + build.stdout + build.stderr);
const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
const code = versionCode(version);

const badging = spawnSync(join(bt, 'aapt2.exe'), ['dump', 'badging', apk], { encoding: 'utf8' }).stdout;
check(badging.includes(`versionCode='${code}'`) && badging.includes(`versionName='${version}'`), `APK is ${version}, versionCode ${code}`);
check(badging.includes("uses-permission: name='android.permission.REQUEST_INSTALL_PACKAGES'"), 'APK asks for REQUEST_INSTALL_PACKAGES');

// latest.txt variants; the "MSI" is any file, only the APK part is under test here
const good = latest({ version, msi: apk, exe: apk, apk });
const [json, sig] = good.toString().split('\n');
const nophone = latest({ version, msi: apk, exe: apk });
const files = {
  '/good/latest.txt': good,
  '/good/PhoneShare.apk': readFileSync(apk),
  '/tampered/latest.txt': Buffer.from(json.replace(`"apkCode":${code}`, `"apkCode":${code + 1}`) + '\n' + sig),
  '/nosig/latest.txt': Buffer.from(json),
  '/garbage/latest.txt': Buffer.from(json + '\n' + Buffer.alloc(64, 7).toString('base64')),
  '/nophone/latest.txt': nophone,
};
check(files['/tampered/latest.txt'].toString() !== good.toString(), 'the tampered copy differs from the signed one');
const server = createServer((req, res) => {
  const body = files[req.url];
  if (!body) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Length': body.length }).end(body);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
execFileSync(join(jdk, 'bin/javac'), ['-encoding', 'UTF-8', '-d', out,
  join(root, 'android/src/app/phoneshare/Updater.java'), join(root, 'dev/UpdaterTest.java')], { stdio: 'inherit' });
const sha = createHash('sha256').update(readFileSync(apk)).digest('hex');
const java = spawn(join(jdk, 'bin/java'), ['-Dstdout.encoding=UTF-8', '-cp', out, 'app.phoneshare.UpdaterTest', base, String(code), sha, version], { stdio: ['ignore', 'pipe', 'inherit'] });
let text = '';
java.stdout.on('data', (d) => { text += d; process.stdout.write(d); });
const exit = await new Promise((ok) => java.on('exit', ok));
server.close();
check(exit === 0 && text.includes('ANDROID UPDATER TESTS OK'), 'Updater.java passes its self-check');
console.log('ANDROID UPDATE OK');

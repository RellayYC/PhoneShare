// G20: the keys live in W:\Keys and nowhere in the project. W:\Keys\RegKeeper is byte for byte the RegKeeper key folder
// (~/.regkeeper), W:\Keys\PhoneShare holds signing.pem and android.keystore, the updater's public key in both apps is
// signing.pem's, and dist/PhoneShare.apk is signed by that keystore.
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEYS } from '../installer/release.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
function fail(msg) { console.log('KEYS FAILED: ' + msg); process.exit(1); }
function check(ok, what) { if (!ok) fail(what); console.log('ok  ' + what); }
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const walk = (d, skip = () => false) => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = join(d, e.name);
  return skip(p) ? [] : e.isDirectory() ? walk(p, skip) : [p];
});

// ---- RegKeeper: the copy matches the original, file for file
const rk = join(homedir(), '.regkeeper'), rkCopy = join(dirname(KEYS), 'RegKeeper');
check(existsSync(rk) && existsSync(rkCopy), `${rk} and ${rkCopy} exist`);
const list = (d) => walk(d).map((f) => relative(d, f)).sort();
const a = list(rk), b = list(rkCopy);
check(a.length > 0 && a.join('|') === b.join('|'), `same ${a.length} files: ${a.join(', ')}`);
check(a.every((f) => sha(join(rk, f)) === sha(join(rkCopy, f))), 'byte for byte');

// ---- PhoneShare: the update key and the APK key
const pem = join(KEYS, 'signing.pem'), ks = join(KEYS, 'android.keystore');
check(existsSync(pem) && existsSync(ks), `${pem} and ${ks} exist`);
const spki = createPublicKey(createPrivateKey(readFileSync(pem))).export({ type: 'spki', format: 'der' }).toString('base64');
for (const f of ['desktop/Updater.cs', 'android/src/app/phoneshare/Updater.java'])
  check(readFileSync(join(root, f), 'utf8').includes(`"${spki}"`), f + ' carries signing.pem\'s public key');

const jdk = existsSync('W:/jdk/bin/keytool.exe') ? 'W:/jdk' : process.env.JAVA_HOME;
const env = { ...process.env, JAVA_HOME: jdk, PATH: join(jdk, 'bin') + ';' + process.env.PATH };
const fp = (s) => /SHA-?256[^:]*:\s*([0-9A-Fa-f:]{64,95})/.exec(s)?.[1].replace(/:/g, '').toLowerCase();
const kt = spawnSync(join(jdk, 'bin', 'keytool.exe'), ['-list', '-v', '-keystore', ks, '-storepass', 'android'], { encoding: 'utf8', env });
const apksigner = join(root, '.tools/android-sdk/build-tools/36.1.0/apksigner.bat');
const as = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', apksigner, 'verify', '--print-certs', join(root, 'dist/PhoneShare.apk')], { encoding: 'utf8', env });
const want = fp(kt.stdout), got = fp(as.stdout);
check(kt.status === 0 && want, 'keystore certificate SHA-256 ' + want);
check(as.status === 0 && got === want, 'dist/PhoneShare.apk is signed by it: ' + got);

// ---- nothing key-like in the project folder (tools and build output included, they are not published but sit here)
const skip = (p) => /[\/](node_modules|\.git)$/.test(p) || /[\/]\.tools[\/]android-sdk$/.test(p);
const found = walk(root, skip).filter((f) => {
  if (/\.(keystore|jks|p12|pfx|pem|snk)$/i.test(f)) return true;
  if (statSync(f).size > 50_000_000) return false;
  const t = readFileSync(f);
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----\r?\n[A-Za-z0-9+/]{16}/.test(t.toString('latin1'))   // a real PEM body, not a pattern
    || t.subarray(0, 4).equals(Buffer.from([0xfe, 0xed, 0xfe, 0xed]));
}).map((f) => relative(root, f));
check(found.length === 0, 'no key file or private key in the project folder' + (found.length ? ': ' + found.join(', ') : ''));
console.log('KEYS OK');

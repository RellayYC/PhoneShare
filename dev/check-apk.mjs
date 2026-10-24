// Builds the APK and checks what a phone will see: signature, manifest, permissions, service type, code and web assets.
import { execFileSync, spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bt = join(root, '.tools/android-sdk/build-tools/36.1.0');
const apk = join(root, 'dist/PhoneShare.apk');
const jdk = process.env.JAVA_HOME && process.env.JAVA_HOME.toLowerCase().includes('jdk') ? process.env.JAVA_HOME : 'W:/jdk';
const env = { ...process.env, JAVA_HOME: jdk, PATH: join(jdk, 'bin') + ';' + process.env.PATH };

function fail(msg) { console.log('APK FAILED: ' + msg); process.exit(1); }
function check(ok, what) { if (!ok) fail(what); console.log('ok  ' + what); }
const run = (exe, args) => exe.endsWith('.bat')
  ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', exe, ...args], { encoding: 'utf8', env })
  : spawnSync(exe, args, { encoding: 'utf8', env });

const build = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'android/build.ps1')], { encoding: 'utf8', env });
process.stdout.write(build.stdout.split('\n').filter((l) => /warning|error|APK:/i.test(l)).join('\n') + '\n');
if (build.status !== 0) fail('build.ps1 exited ' + build.status + '\n' + build.stderr);
check(statSync(apk).size > 50_000, `built ${apk} (${Math.round(statSync(apk).size / 1024)} KB)`);

const verify = run(join(bt, 'apksigner.bat'), ['verify', '--print-certs', apk]);
check(verify.status === 0 && /Signer #1 certificate DN: CN=PhoneShare Debug/.test(verify.stdout), 'apksigner verify passes');

const badging = run(join(bt, 'aapt2.exe'), ['dump', 'badging', apk]).stdout;
check(/package: name='app\.phoneshare'/.test(badging), 'package app.phoneshare');
check(/minSdkVersion:'29'/.test(badging) && /targetSdkVersion:'36'/.test(badging), 'minSdk 29, targetSdk 36');
check(/launchable-activity: name='app\.phoneshare\.MainActivity'/.test(badging), 'launcher activity MainActivity');
for (const p of ['INTERNET', 'RECORD_AUDIO', 'FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_MEDIA_PROJECTION', 'CHANGE_WIFI_MULTICAST_STATE', 'WAKE_LOCK', 'POST_NOTIFICATIONS']) {
  check(badging.includes(`uses-permission: name='android.permission.${p}'`), 'permission ' + p);
}

const xml = run(join(bt, 'aapt2.exe'), ['dump', 'xmltree', '--file', 'AndroidManifest.xml', apk]).stdout;
const service = xml.slice(xml.indexOf('E: service'));
const fgs = /android:foregroundServiceType\(0x[0-9a-f]+\)=(0x[0-9a-f]+|\d+)/.exec(service);   // aapt2 prints it in hex
check(fgs && Number(fgs[1]) === 32, `CaptureService foregroundServiceType=mediaProjection (32), got ${fgs && fgs[1]}`);
check(/android:name\(0x[0-9a-f]+\)="(app\.phoneshare)?\.?CaptureService"/.test(service.split('E: ')[1]), 'service class app.phoneshare.CaptureService');

const list = execFileSync(join(jdk, 'bin/jar'), ['tf', apk], { encoding: 'utf8', env }).split(/\r?\n/);
check(list.filter(Boolean).every((e) => !e.includes(String.fromCharCode(92))), 'no entry name with a backslash (Android could not open it)');
for (const f of ['classes.dex', 'assets/web/index.html', 'assets/web/app.js', 'assets/web/mp4.js', 'assets/web/style.css', 'assets/web/icon.svg']) check(list.includes(f), 'contains ' + f);

const dex = run(join(bt, 'dexdump.exe'), ['-l', 'plain', join(root, 'android/build/dex/classes.dex')]).stdout;
for (const c of ['MainActivity', 'CaptureService', 'ScreenEncoder', 'StreamServer']) check(dex.includes(`Class descriptor  : 'Lapp/phoneshare/${c};'`), 'dex has ' + c);
console.log('APK OK');

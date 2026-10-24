// Publishes a release to GitHub; the signing key lives in W:\Keys\PhoneShare (PHONESHARE_KEYS), never in the repo.
//   node installer/release.mjs <x.y.z> [notes]   writes VERSION, builds APK, exe and MSI, commits and tags v<x.y.z>, pushes,
//                                                and creates the release: the MSI, PhoneShare.exe (portable), PhoneShare.apk
//                                                and latest.txt (the release JSON line + its signature line); needs gh logged in
// latest.txt is what the Windows app (desktop/Updater.cs) and the phone (android/.../Updater.java) check.
import { createHash, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const REPO = 'RellayYC/PhoneShare';
export const KEYS = process.env.PHONESHARE_KEYS || 'W:\\Keys\\PhoneShare';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** x.y.z -> the APK versionCode, as android/build.ps1 computes it. */
export const versionCode = (v) => { const [a, b, c] = v.split('.').map(Number); return a * 10000 + b * 100 + c; };

/** latest.txt for the given files: one JSON line, then its ECDSA P-256 signature (IEEE P1363, base64). */
export function latest({ version, msi, exe, apk }, key = readFileSync(join(KEYS, 'signing.pem'))) {
  const m = { version };
  if (msi) Object.assign(m, { msi: basename(msi), sha256: sha256(msi) });
  if (exe) Object.assign(m, { exe: basename(exe), exeSha256: sha256(exe) });
  if (apk) Object.assign(m, { apk: basename(apk), apkCode: versionCode(version), apkSha256: sha256(apk) });
  const json = Buffer.from(JSON.stringify(m));
  const sig = sign('sha256', json, { key, dsaEncoding: 'ieee-p1363' }).toString('base64');
  return Buffer.concat([json, Buffer.from('\n' + sig)]);   // one file: the release and its signature can never be out of step
}

function run(cmd, args) { execFileSync(cmd, args, { stdio: 'inherit', cwd: root }); }
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version, notes = ''] = process.argv.slice(2);
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) { console.log('usage: node installer/release.mjs <x.y.z> [notes]'); process.exit(1); }
  if (!existsSync(join(KEYS, 'signing.pem'))) throw new Error(`no ${KEYS}\\signing.pem`);
  if (git('status', '--porcelain')) throw new Error('commit or stash the changes first: the release is built from a clean tree');

  writeFileSync(join(root, 'VERSION'), version + '\n');
  for (const s of ['android/build.ps1', 'desktop/build.ps1', 'installer/build.ps1']) run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', s]);
  const msi = join(root, 'dist', `PhoneShare-${version}-x64.msi`), exe = join(root, 'dist', 'PhoneShare.exe'), apk = join(root, 'dist', 'PhoneShare.apk');
  const tmp = mkdtempSync(join(tmpdir(), 'ps-')), file = join(tmp, 'latest.txt');
  writeFileSync(file, latest({ version, msi, exe, apk }));
  try {
    if (git('status', '--porcelain')) { run('git', ['commit', '-am', `PhoneShare ${version}`]); }
    run('git', ['tag', `v${version}`]);
    run('git', ['push', 'origin', 'HEAD', `v${version}`]);
    // gh uploads into a draft and publishes it last, so latest/download never names a file that is not there yet
    run('gh', ['release', 'create', `v${version}`, msi, exe, apk, file, '--repo', REPO, '--title', `PhoneShare ${version}`, '--notes', notes, '--verify-tag']);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

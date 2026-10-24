// G19: what GitHub shows. github.com/RellayYC/PhoneShare is public with a description, its main is the local HEAD, RellayYC is the
// only contributor, and the latest release is the VERSION release: its latest.txt, fetched anonymously the way the apps do,
// carries a valid signature for the apps' public key, and the MSI, exe and APK downloaded next to it match its hashes.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO, versionCode } from '../installer/release.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
function fail(msg) { console.log('GITHUB FAILED: ' + msg); process.exit(1); }
function check(ok, what) { if (!ok) fail(what); console.log('ok  ' + what); }
const gh = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }) || 'null');
// Node gives each address 250 ms by default; GitHub's asset CDN takes ~300 ms to answer a connect from here
setDefaultAutoSelectFamilyAttemptTimeout(5000);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

const repo = gh(`repos/${REPO}`);
check(repo.visibility === 'public' && !repo.private, `${REPO} is public`);
check((repo.description || '').length > 20, 'description: ' + repo.description);
check(repo.default_branch === 'main', 'default branch main');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
check(gh(`repos/${REPO}/commits/main`).sha === head, 'main on GitHub is the local HEAD ' + head.slice(0, 7));

// GitHub computes contributors in the background; an empty answer right after a push means "not yet"
let people = [];
for (let i = 0; i < 10 && !people.length; i++) { people = gh(`repos/${REPO}/contributors?anon=1`) || []; if (!people.length) await sleep(3000); }
check(people.length === 1 && people[0].login === 'RellayYC', 'contributors: ' + people.map((p) => p.login || p.name + ' (anonymous)').join(', '));

const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
const rel = gh(`repos/${REPO}/releases/latest`);
check(rel.tag_name === 'v' + version && !rel.draft && !rel.prerelease, `latest release ${rel.tag_name} is VERSION ${version}`);
const names = rel.assets.map((a) => a.name).sort();
check(names.join('|') === [`PhoneShare-${version}-x64.msi`, 'PhoneShare.apk', 'PhoneShare.exe', 'latest.txt'].sort().join('|'), 'assets: ' + names.join(', '));

// ---- the way the apps see it: anonymous, through releases/latest/download
const base = `https://github.com/${REPO}/releases/latest/download`;
const get = async (name) => {
  const r = await fetch(`${base}/${name}`, { headers: { 'User-Agent': 'PhoneShare-check' } });
  if (!r.ok) fail(`${name}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
};
const [line, sig] = (await get('latest.txt')).toString('utf8').split('\n');
const spki = /PublicKey = "([^"]+)"/.exec(readFileSync(join(root, 'desktop/Updater.cs'), 'utf8'))[1];
const key = createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' });
check(verify('sha256', Buffer.from(line), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig.trim(), 'base64')), 'latest.txt signature is valid for the apps\' key');
const m = JSON.parse(line);
check(m.version === version && m.apkCode === versionCode(version), `it names ${m.version}, versionCode ${m.apkCode}`);
const sha = (b) => createHash('sha256').update(b).digest('hex');
for (const [file, hash] of [[m.msi, m.sha256], [m.exe, m.exeSha256], [m.apk, m.apkSha256]]) {
  const body = await get(file);
  check(sha(body) === hash, `${file} (${Math.round(body.length / 1024)} KB) downloads with the signed hash`);
}
console.log('GITHUB OK');

// G14: nothing headed for GitHub gives this PC or its owner away. Scans every file git would publish plus the release
// assets in dist/ for private keys, keystores, API tokens, this PC's IP addresses, its host name, the Windows user name
// (RellayYC, the public GitHub account, is allowed), e-mail addresses and absolute user paths; then checks that every commit
// is roman's and no commit names Claude or a co-author. The detector first has to catch planted samples of each kind.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { hostname, networkInterfaces, userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
function fail(msg) { console.log('LEAKS FAILED: ' + msg); process.exit(1); }
function check(ok, what) { if (!ok) fail(what); console.log('ok  ' + what); }
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ips = Object.values(networkInterfaces()).flat().filter((a) => a.family === 'IPv4' && !a.internal).map((a) => a.address);
let publicIp = null;
try {
  publicIp = (await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5000) }).then((r) => r.text())).trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(publicIp)) publicIp = null;
} catch { /* offline: the local addresses are still checked */ }
const user = userInfo().username;
// the owner's addresses come from this PC at run time (the Microsoft account, git's global e-mail), never from this file
const account = /MicrosoftAccount\\(\S+@\S+)/.exec(execFileSync(join(process.env.SystemRoot, 'System32', 'whoami.exe'), ['/groups'], { encoding: 'utf8' }))?.[1];
let globalEmail = '';
try { globalEmail = git('config', '--global', 'user.email').trim(); } catch { /* not set */ }
const emails = [...new Set([account, globalEmail].filter(Boolean))];
const NOREPLY = '62303932+RellayYC@users.noreply.github.com';

const rules = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Java keystore', /\xFE\xED\xFE\xED\x00\x00\x00\x02/],
  ['GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['Anthropic/OpenAI key', /\bsk-(ant-)?[A-Za-z0-9_-]{24,}/],
  ['AWS key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Slack token', /\bxox[abpr]-[0-9A-Za-z-]{10,}/],
  ['Discord token', /\b[MN][A-Za-z\d]{23,25}\.[\w-]{6}\.[\w-]{27,}/],
  ['password assignment', /\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["'][^"'\s]{8,}["']/i],
  ...[...ips, publicIp].filter(Boolean).map((ip) => ['this PC\'s IP ' + ip, new RegExp(`(?<![\\d.])${esc(ip)}(?![\\d])`)]),
  ['host name', new RegExp(esc(hostname()), 'i')],
  ['Windows user name', new RegExp(`${esc(user)}(?!YC)`, 'i')],
  ['user profile path', /[A-Za-z]:\\+Users\\+(?!Public\b)[^\\\s"'`]+/i],
  ...emails.map((e) => ['e-mail ' + e, new RegExp(esc(e), 'i')]),
  ['an e-mail address', new RegExp(`[A-Za-z0-9._%+-]+@(?!users\\.noreply\\.github\\.com)[A-Za-z0-9-]+\\.(com|ru|net|org|io)\\b`)],
];
// the signing key's public half and the release URL are meant to be public; nothing else is excused
const allowed = [NOREPLY];
function scan(text) {
  for (const a of allowed) text = text.split(a).join('');
  return rules.filter(([, re]) => re.test(text)).map(([name]) => name);
}

// ---- the detector must catch each planted kind before its silence means anything
const planted = {
  'private key': '-----BEGIN EC ' + 'PRIVATE KEY-----\nMHcCAQEE',   // samples are built from parts, or this file would hold them
  'Java keystore': '\xFE\xED\xFE\xED\x00\x00\x00\x02\x00\x00',
  'GitHub token': 'token = ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
  'Anthropic/OpenAI key': 'KEY=sk-ant-' + 'api03-abcdefghijklmnopqrstuvwxyz012345',
  'host name': 'built on ' + hostname().toLowerCase(),
  'Windows user name': 'owner ' + user,
  'user profile path': ['C:', 'Users', 'Someone', 'AppData'].join('\\'),
  'an e-mail address': 'mail me: someone' + '@' + 'example.com',
  ...Object.fromEntries(ips.map((ip) => ['this PC\'s IP ' + ip, `http://${ip}:8080/`])),
  ...Object.fromEntries(emails.map((e) => ['e-mail ' + e, `<${e}>`])),
};
for (const [kind, sample] of Object.entries(planted)) check(scan(sample).includes(kind), 'detector catches a planted ' + kind);
check(scan('https://github.com/RellayYC/PhoneShare ' + NOREPLY + ' 192.168.56.').length === 0, 'and passes the public account, the noreply address and a bare prefix');

// ---- what goes public: tracked + not-ignored files, and the release assets
const files = git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean);
check(files.length > 30, `${files.length} files headed for GitHub`);
const keyish = files.filter((f) => /\.(keystore|jks|p12|pfx|pem|snk|key)$/i.test(f) || /(^|\/)(\.env|signing|id_rsa|id_ed25519)/i.test(f));
check(keyish.length === 0, 'no key or keystore file among them' + (keyish.length ? ': ' + keyish.join(', ') : ''));
const ignored = git('check-ignore', '-v', '--no-index', 'GATES.md', 'PLAN.md', 'dist/x', '.claude/x', 'x.keystore', 'x.pem').split('\n').filter(Boolean).length;
check(ignored === 6, 'GATES.md, PLAN.md, dist/, .claude/, *.keystore and *.pem are ignored');
const assets = existsSync(join(root, 'dist')) ? readdirSync(join(root, 'dist')).filter((f) => /\.(msi|exe|apk)$/.test(f)).map((f) => 'dist/' + f) : [];
check(assets.length >= 3, 'release assets scanned too: ' + assets.join(', '));
const hits = [];
for (const f of [...files, ...assets]) {
  const text = readFileSync(join(root, f)).toString('latin1');
  const utf16 = readFileSync(join(root, f)).toString('utf16le');   // .NET and MSI strings are UTF-16
  const found = [...new Set([...scan(text), ...scan(utf16)])];
  if (found.length) hits.push(`${f}: ${found.join(', ')}`);
}
check(hits.length === 0, 'no leak in any of them' + (hits.length ? ':\n  ' + hits.join('\n  ') : ''));

// ---- history: roman's commits only, no Claude, no co-author
let log = '';
try { log = git('log', '--all', '--format=%an <%ae>|%cn <%ce>|%B%x00'); } catch { /* no commits yet */ }
const commits = log.split('\0').map((c) => c.trim()).filter(Boolean);
for (const c of commits) {
  const [author, committer] = c.split('|');
  if (author !== `roman <${NOREPLY}>` || committer !== `roman <${NOREPLY}>`) fail('commit not by roman <noreply>: ' + c.slice(0, 200));
  if (/claude|anthropic|co-authored-by/i.test(c)) fail('commit names Claude or a co-author: ' + c.slice(0, 200));
  const leaks = scan(c);
  if (leaks.length) fail('commit message leaks ' + leaks.join(', '));
}
console.log('ok  public IP ' + (publicIp ? 'looked up and searched for' : 'not available (offline), local addresses only'));
check(emails.length > 0, `the owner's e-mail is known (${emails.length}) and was searched for`);
check(true, `${commits.length} commit(s): all by roman <${NOREPLY}>, none names Claude or a co-author`);
console.log('LEAKS OK');

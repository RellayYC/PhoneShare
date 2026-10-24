// Compiles StreamServer + ServerTest with the local JDK and runs the self-check.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const jdk = process.env.JAVA_HOME || 'W:/jdk';
const out = join(root, 'dev', '.out', 'servertest');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

execFileSync(join(jdk, 'bin', 'javac'), ['-encoding', 'UTF-8', '-d', out,
  join(root, 'android/src/app/phoneshare/StreamServer.java'), join(root, 'dev/ServerTest.java')], { stdio: 'inherit' });
try {
  execFileSync(join(jdk, 'bin', 'java'), ['-cp', out, 'app.phoneshare.ServerTest'], { stdio: 'inherit', timeout: 60000 });
} catch {
  process.exit(1);
}

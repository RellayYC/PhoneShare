// Muxes ffmpeg-generated H.264 with web/mp4.js and checks that ffmpeg decodes every frame back.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { splitNalus, nalType, codecString, initSegment, mediaSegment, TIMESCALE } = await import(pathToFileURL(join(root, 'web/mp4.js')).href);
const dir = join(root, 'dev', '.out', 'mp4');
mkdirSync(dir, { recursive: true });

const FRAMES = 90;
const W = 360, H = 640;

function fail(msg) { console.log('MP4 FAILED: ' + msg); process.exit(1); }

function mux(h264, corrupt) {
  const aus = [];
  let cur = null;
  for (const n of splitNalus(h264)) {
    if (nalType(n) === 9) { cur = []; aus.push(cur); }
    if (cur) cur.push(n);
  }
  const sps = aus.flat().find((n) => nalType(n) === 7);
  const pps = aus.flat().find((n) => nalType(n) === 8);
  if (!sps || !pps) fail('no SPS/PPS');
  const parts = [initSegment({ width: W, height: H, sps, pps })];
  const dur = TIMESCALE / 30;
  aus.forEach((au, i) => {
    const seg = mediaSegment({ seq: i + 1, time: i * dur, duration: dur, key: au.some((n) => nalType(n) === 5), nalus: au });
    if (corrupt && i === 10) seg[seg.length - 1] ^= 0xff, seg.fill(0x55, seg.length - 200);
    parts.push(seg);
  });
  return { aus, sps, file: Buffer.concat(parts.map((p) => Buffer.from(p))) };
}

function probe(path) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames,width,height,codec_name', '-of', 'json', path], { encoding: 'utf8' });
  const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-'], { encoding: 'utf8' });
  const s = JSON.parse(r.stdout || '{}').streams?.[0] || {};
  return { frames: Number(s.nb_read_frames), width: s.width, height: s.height, codec: s.codec_name, errors: (r.stderr + dec.stderr).trim() };
}

for (const profile of ['baseline', 'high']) {
  const src = join(dir, `${profile}.h264`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=30`, '-frames:v', String(FRAMES),
    '-c:v', 'libx264', '-profile:v', profile, '-pix_fmt', 'yuv420p', '-bf', '0', '-g', '30', '-x264-params', 'aud=1', '-f', 'h264', src]);
  const { aus, sps, file } = mux(readFileSync(src), false);
  if (aus.length !== FRAMES) fail(`${profile}: split ${aus.length} access units, want ${FRAMES}`);
  const cs = codecString(sps);
  if (!/^avc1\.[0-9a-f]{6}$/.test(cs) || cs.slice(5, 7) !== sps[1].toString(16).padStart(2, '0')) fail(`${profile}: codec string ${cs}`);
  const out = join(dir, `${profile}.mp4`);
  writeFileSync(out, file);
  const p = probe(out);
  if (p.codec !== 'h264' || p.width !== W || p.height !== H) fail(`${profile}: stream ${JSON.stringify(p)}`);
  if (p.frames !== aus.length) fail(`${profile}: decoded ${p.frames} frames, muxed ${aus.length}`);
  if (p.errors) fail(`${profile}: decoder errors: ${p.errors.slice(0, 300)}`);
  console.log(`ok  ${profile}: ${cs}, ${p.frames}/${aus.length} frames decoded, no errors`);
}

// Negative control: a corrupted segment must be caught by the same oracle.
const bad = mux(readFileSync(join(dir, 'high.h264')), true);
writeFileSync(join(dir, 'corrupt.mp4'), bad.file);
const pb = probe(join(dir, 'corrupt.mp4'));
if (!pb.errors && pb.frames === bad.aus.length) fail('negative control: corruption went unnoticed');
console.log('ok  negative control: corruption detected');
console.log(`MP4 OK frames=${FRAMES} profiles=baseline,high`);

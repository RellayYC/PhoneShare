// Minimal fragmented-MP4 muxer for one H.264 track.
// MSE only accepts fMP4, so on plain http (no WebCodecs) every Annex B access unit becomes one moof+mdat.

export const TIMESCALE = 90000;

/** Annex B buffer -> NAL units without start codes. */
export function splitNalus(buf) {
  const out = [];
  let start = -1;
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      if (start >= 0) out.push(buf.subarray(start, buf[i - 1] === 0 ? i - 1 : i));
      start = i + 3;
      i += 2;
    }
  }
  if (start >= 0 && start < buf.length) out.push(buf.subarray(start));
  return out;
}

export const nalType = (n) => n[0] & 0x1f;

export function codecString(sps) {
  return 'avc1.' + [sps[1], sps[2], sps[3]].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function box(type, ...parts) {
  let size = 8;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let o = 8;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function bytes(...fields) {
  // fields: [value, width] pairs, big endian
  let len = 0;
  for (const [, w] of fields) len += w;
  const out = new Uint8Array(len);
  let o = 0;
  for (const [v, w] of fields) {
    for (let i = w - 1; i >= 0; i--) out[o + i] = Number((BigInt(v) >> BigInt(8 * (w - 1 - i))) & 0xffn);
    o += w;
  }
  return out;
}

const MATRIX = bytes([0x00010000, 4], [0, 4], [0, 4], [0, 4], [0x00010000, 4], [0, 4], [0, 4], [0, 4], [0x40000000, 4]);
const zeros = (n) => new Uint8Array(n);

export function initSegment({ width, height, sps, pps }) {
  const ftyp = box('ftyp', new TextEncoder().encode('isom'), bytes([0x200, 4]), new TextEncoder().encode('isomiso6avc1mp41'));
  const mvhd = box('mvhd', bytes([0, 4], [0, 4], [0, 4], [TIMESCALE, 4], [0, 4], [0x00010000, 4], [0x0100, 2]), zeros(10), MATRIX, zeros(24), bytes([2, 4]));
  const tkhd = box('tkhd', bytes([3, 4], [0, 4], [0, 4], [1, 4], [0, 4], [0, 4]), zeros(8), bytes([0, 2], [0, 2], [0, 2], [0, 2]), MATRIX,
    bytes([width << 16, 4], [height << 16, 4]));
  const mdhd = box('mdhd', bytes([0, 4], [0, 4], [0, 4], [TIMESCALE, 4], [0, 4], [0x55c4, 2], [0, 2]));
  const hdlr = box('hdlr', bytes([0, 4], [0, 4]), new TextEncoder().encode('vide'), zeros(12), new TextEncoder().encode('VideoHandler\0'));
  const avccParts = [bytes([1, 1], [sps[1], 1], [sps[2], 1], [sps[3], 1], [0xff, 1], [0xe1, 1], [sps.length, 2]), sps, bytes([1, 1], [pps.length, 2]), pps];
  // ponytail: assumes 4:2:0 8-bit for High profiles, which is what screen encoders produce.
  if ([100, 110, 122, 144].includes(sps[1])) avccParts.push(bytes([0xfd, 1], [0xf8, 1], [0xf8, 1], [0, 1]));
  const avc1 = box('avc1', zeros(6), bytes([1, 2], [0, 2], [0, 2]), zeros(12), bytes([width, 2], [height, 2], [0x00480000, 4], [0x00480000, 4], [0, 4], [1, 2]),
    zeros(32), bytes([0x18, 2], [0xffff, 2]), box('avcC', ...avccParts));
  const stbl = box('stbl',
    box('stsd', bytes([0, 4], [1, 4]), avc1),
    box('stts', bytes([0, 4], [0, 4])),
    box('stsc', bytes([0, 4], [0, 4])),
    box('stsz', bytes([0, 4], [0, 4], [0, 4])),
    box('stco', bytes([0, 4], [0, 4])));
  const minf = box('minf', box('vmhd', bytes([1, 4], [0, 2], [0, 6])), box('dinf', box('dref', bytes([0, 4], [1, 4]), box('url ', bytes([1, 4])))), stbl);
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
  const mvex = box('mvex', box('trex', bytes([0, 4], [1, 4], [1, 4], [0, 4], [0, 4], [0, 4])));
  const moov = box('moov', mvhd, trak, mvex);
  const out = new Uint8Array(ftyp.length + moov.length);
  out.set(ftyp);
  out.set(moov, ftyp.length);
  return out;
}

/** One access unit -> moof+mdat. time and duration are in TIMESCALE units. SPS/PPS/AUD are dropped (they live in avcC). */
export function mediaSegment({ seq, time, duration, key, nalus }) {
  const keep = nalus.filter((n) => { const t = nalType(n); return t !== 7 && t !== 8 && t !== 9; });
  let size = 0;
  for (const n of keep) size += 4 + n.length;
  const payload = new Uint8Array(size);
  const dv = new DataView(payload.buffer);
  let o = 0;
  for (const n of keep) { dv.setUint32(o, n.length); payload.set(n, o + 4); o += 4 + n.length; }

  const trunFor = (dataOffset) => box('trun', bytes([0x000701, 4], [1, 4], [dataOffset, 4], [duration, 4], [size, 4], [key ? 0x02000000 : 0x01010000, 4]));
  const build = (dataOffset) => box('moof',
    box('mfhd', bytes([0, 4], [seq, 4])),
    box('traf', box('tfhd', bytes([0x020000, 4], [1, 4])), box('tfdt', bytes([0x01000000, 4], [time, 8])), trunFor(dataOffset)));
  const moofSize = build(0).length;
  const moof = build(moofSize + 8);
  const mdat = box('mdat', payload);
  const out = new Uint8Array(moof.length + mdat.length);
  out.set(moof);
  out.set(mdat, moof.length);
  return out;
}

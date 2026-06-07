/**
 * The map codec — pure codepoint data, slots resolved live.
 *
 * The renderer draws one slot per CODEPOINT, and a slot is just the live
 * session's id for a codepoint (cp → MonospaceShapeCache.lookup → slot). Slots
 * are session-specific (allocation-order dependent — see parity.js), so the map
 * NEVER stores them. It stores codepoints; `expandRender(map, resolve)` asks the
 * live session for slots at draw time. This makes the map portable across
 * sessions/font-versions with zero core changes.
 *
 *   render/source layer — per codepoint: a dictionary of distinct codepoints +
 *     a per-line stream of dict indices. Drives drawing (resolve cp→slot) AND
 *     source reconstruction (dict.cp).
 *   cluster layer       — per grapheme: codepoint-count, RLE'd. The editing /
 *     cursor oracle, separate from the render stream.
 *
 * Packed binary (little-endian):
 *   header:    u32 dictCount, u32 lineCount, u32 clusterRunCount
 *   dict[i]:   u32 codepoint
 *   line[i]:   u32 len, len×u16 dictIndex
 *   gCount[i]: u32 graphemeCount per line
 *   clu[i]:    u16 runLen, u8 codepointCount   (RLE — code is mostly runs of 1)
 */

const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
const encU8 = new TextEncoder();

/**
 * text → map. No shaper needed: the render stream is exactly the codepoints of
 * each line (one slot per codepoint), so encoding is pure codepoint extraction.
 * @param {string} text
 */
export function encode(text) {
  const dictIndex = new Map(); // codepoint → dict index
  const dict = [];
  const lines = [];
  const clusters = []; // parallel to lines: per line, codepoint-count of each grapheme

  for (const lineText of text.split('\n')) {
    const stream = [];
    for (const ch of lineText) { // string iteration yields codepoints
      const cp = ch.codePointAt(0);
      let idx = dictIndex.get(cp);
      if (idx === undefined) { idx = dict.length; dict.push({ cp }); dictIndex.set(cp, idx); }
      stream.push(idx);
    }
    lines.push(stream);

    const gl = [];
    for (const { segment } of segmenter.segment(lineText)) gl.push([...segment].length);
    clusters.push(gl);
  }
  if (dict.length > 0xffff) throw new Error(`dict too large for u16 stream: ${dict.length}`);
  return { dict, lines, clusters };
}

class BW {
  constructor() { this.b = []; }
  u8(v) { this.b.push(v & 0xff); }
  u16(v) { this.b.push(v & 0xff, (v >> 8) & 0xff); }
  u32(v) { this.b.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); }
  done() { return Uint8Array.from(this.b); }
}
class BR {
  constructor(u8) { this.u = u8; this.p = 0; }
  u8() { return this.u[this.p++]; }
  u16() { const v = this.u[this.p] | (this.u[this.p + 1] << 8); this.p += 2; return v; }
  u32() { const v = (this.u[this.p] | (this.u[this.p+1]<<8) | (this.u[this.p+2]<<16) | (this.u[this.p+3]<<24)) >>> 0; this.p += 4; return v; }
}

/** map → packed bytes (the resident representation we measure). */
export function pack(map) {
  const runs = [];
  for (const line of map.clusters) for (const n of line) {
    const last = runs[runs.length - 1];
    if (last && last.n === n && last.count < 0xffff) last.count++;
    else runs.push({ count: 1, n: Math.min(255, n) });
  }

  const w = new BW();
  w.u32(map.dict.length); w.u32(map.lines.length); w.u32(runs.length);
  for (const e of map.dict) w.u32(e.cp);
  for (const line of map.lines) { w.u32(line.length); for (const i of line) w.u16(i); }
  for (const line of map.clusters) w.u32(line.length);
  for (const run of runs) { w.u16(run.count); w.u8(run.n); }
  return w.done();
}

/** packed bytes → map. */
export function unpack(u8) {
  const r = new BR(u8);
  const dictCount = r.u32(), lineCount = r.u32(), runCount = r.u32();
  const dict = new Array(dictCount);
  for (let i = 0; i < dictCount; i++) dict[i] = { cp: r.u32() };
  const lines = new Array(lineCount);
  for (let i = 0; i < lineCount; i++) {
    const len = r.u32(); const line = new Array(len);
    for (let j = 0; j < len; j++) line[j] = r.u16();
    lines[i] = line;
  }
  const gCounts = new Array(lineCount);
  for (let i = 0; i < lineCount; i++) gCounts[i] = r.u32();
  const flat = [];
  for (let i = 0; i < runCount; i++) { const c = r.u16(), n = r.u8(); for (let k = 0; k < c; k++) flat.push(n); }
  const clusters = new Array(lineCount);
  let fi = 0;
  for (let i = 0; i < lineCount; i++) { clusters[i] = flat.slice(fi, fi + gCounts[i]); fi += gCounts[i]; }
  return { dict, lines, clusters };
}

/** map → source text (the round-trip spine). */
export function decodeSource(map) {
  return map.lines
    .map((line) => line.map((i) => String.fromCodePoint(map.dict[i].cp)).join(''))
    .join('\n');
}

/**
 * map → per-line slot arrays, resolving each codepoint to a live slot.
 * @param {(cp:number)=>number} resolve - cp → live FontChain slot (the app's path)
 */
export function expandRender(map, resolve) {
  return map.lines.map((line) => line.map((i) => resolve(map.dict[i].cp)));
}

/**
 * The distinct codepoints the map references — exactly the set the integration
 * must pass to LiveSlugAtlas.ensureCodepoints() so every referenced slot has its
 * curves encoded (a slot without curves renders blank).
 */
export function referencedCodepoints(map) {
  return map.dict.map((d) => d.cp);
}

/** Byte accounting for one input. */
export function sizes(text, map, packed) {
  const utf8 = encU8.encode(text).length;
  const glyphs = map.lines.reduce((n, l) => n + l.length, 0);
  const distinct = map.dict.length;
  const current = glyphs * 40;
  const streamU16 = glyphs * 2;
  const bits = distinct <= 1 ? 1 : Math.ceil(Math.log2(distinct));
  const streamPacked = Math.ceil((glyphs * bits) / 8);
  const overhead = packed.length - streamU16;
  return { utf8, glyphs, distinct, current, mapBytes: packed.length, mapBytesPacked: overhead + streamPacked, bits };
}

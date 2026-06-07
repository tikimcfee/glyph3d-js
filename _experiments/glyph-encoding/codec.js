/**
 * The map codec, rebuilt around the renderer's real contract.
 *
 * The renderer draws one SLOT per CODEPOINT (FontChain monospace model;
 * advance constant, offsets zero). So the map carries two linked layers:
 *
 *   render/source layer  — per codepoint: a dictionary of distinct codepoints
 *     (each → its global slot) + a per-line stream of dictionary indices.
 *     Drives BOTH drawing (dict.slot) and source reconstruction (dict.cp).
 *
 *   cluster layer        — per grapheme: codepoint-count + byte-length. The
 *     editing/cursor oracle (grapheme ↔ codepoint ↔ byte), separate from the
 *     render stream. This is the `canonical-ruler` map.
 *
 * Packed binary (little-endian):
 *   header:    u32 dictCount, u32 lineCount, u32 clusterRunCount
 *   dict[i]:   u32 codepoint, u32 slot
 *   line[i]:   u32 len, len×u16 dictIndex
 *   gCount[i]: u32 graphemeCount per line  (to re-split the RLE run below)
 *   clu[i]:    u16 runLen, u8 codepointCount   (RLE — code is mostly runs of 1)
 *
 * Grapheme byteLen is NOT stored — byte offsets derive from each codepoint's
 * UTF-8 length via the dict, so the cluster map only needs codepoint grouping.
 */

const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
const encU8 = new TextEncoder();

/**
 * text → map, shaping each source line through the real FontChain.
 * @param {string} text
 * @param {import('../../packages/glyph3d-core/src/shaping/FontChain.js').default} chain
 */
export function encode(text, chain) {
  const dictIndex = new Map(); // codepoint → dict index
  const dict = [];
  const lines = [];
  const clusters = []; // parallel to lines: per line, codepoint-count of each grapheme

  for (const lineText of text.split('\n')) {
    const stream = [];
    for (const g of chain.shape(lineText)) {
      const cp = lineText.codePointAt(g.cl);
      let idx = dictIndex.get(cp);
      if (idx === undefined) {
        idx = dict.length;
        dict.push({ cp, slot: g.g });
        dictIndex.set(cp, idx);
      }
      stream.push(idx);
    }
    lines.push(stream);

    // Graphemes are line-local: a cluster never spans '\n' (UAX#29), and the
    // renderer is per-line, so cursor/grapheme grouping lives per line too.
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
  // RLE the flattened grapheme codepoint-counts: long runs of 1 for plain text.
  const runs = [];
  for (const line of map.clusters) {
    for (const n of line) {
      const last = runs[runs.length - 1];
      if (last && last.n === n && last.count < 0xffff) last.count++;
      else runs.push({ count: 1, n: Math.min(255, n) });
    }
  }

  const w = new BW();
  w.u32(map.dict.length); w.u32(map.lines.length); w.u32(runs.length);
  for (const e of map.dict) { w.u32(e.cp); w.u32(e.slot); }
  for (const line of map.lines) { w.u32(line.length); for (const i of line) w.u16(i); }
  for (const line of map.clusters) w.u32(line.length); // graphemes per line
  for (const run of runs) { w.u16(run.count); w.u8(run.n); }
  return w.done();
}

/** packed bytes → map (full: dict + lines + clusters). */
export function unpack(u8) {
  const r = new BR(u8);
  const dictCount = r.u32(), lineCount = r.u32(), runCount = r.u32();
  const dict = new Array(dictCount);
  for (let i = 0; i < dictCount; i++) dict[i] = { cp: r.u32(), slot: r.u32() };
  const lines = new Array(lineCount);
  for (let i = 0; i < lineCount; i++) {
    const len = r.u32(); const line = new Array(len);
    for (let j = 0; j < len; j++) line[j] = r.u16();
    lines[i] = line;
  }
  const gCounts = new Array(lineCount);
  for (let i = 0; i < lineCount; i++) gCounts[i] = r.u32();
  const flat = [];
  for (let i = 0; i < runCount; i++) { const count = r.u16(), n = r.u8(); for (let k = 0; k < count; k++) flat.push(n); }
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

/** map → per-line slot arrays (what the renderer would draw). */
export function expandRender(map) {
  return map.lines.map((line) => line.map((i) => map.dict[i].slot));
}

/** text → per-line slot arrays straight from the chain (the fidelity baseline). */
export function referenceRender(text, chain) {
  return text.split('\n').map((line) => chain.shape(line).map((g) => g.g));
}

/** Byte accounting for one input. */
export function sizes(text, map, packed) {
  const utf8 = encU8.encode(text).length;
  const glyphs = map.lines.reduce((n, l) => n + l.length, 0); // = drawn instances
  const distinct = map.dict.length;
  const newlines = Math.max(0, map.lines.length - 1);
  const current = glyphs * 40;
  const streamU16 = glyphs * 2;
  const bits = distinct <= 1 ? 1 : Math.ceil(Math.log2(distinct));
  const streamPacked = Math.ceil((glyphs * bits) / 8);
  const overhead = packed.length - streamU16; // dict + clusters + line headers
  return {
    utf8, glyphs, distinct, newlines, current,
    mapBytes: packed.length,
    mapBytesPacked: overhead + streamPacked,
    bits,
  };
}

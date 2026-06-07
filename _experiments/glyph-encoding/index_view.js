/**
 * IndexView — the access-pattern layer over a glyph map.
 *
 * Picking, highlighting and editing all need to move between coordinate spaces:
 *
 *   slot (instance index, what GPU picking returns)
 *     ↕  == codepoint index within the document (the canonical-ruler invariant)
 *   (line, col)            — for navigation / display
 *   source byte range      — for highlight / edit / LSP positions
 *   grapheme               — the cursor's "one character" unit
 *   FontChain slot (.slot) — the actual drawn glyph id
 *
 * Everything is derived from the map alone (dict + per-line stream + per-line
 * grapheme counts). No original text needed — that's the point: the map is a
 * complete, self-describing render+pick representation.
 */

/** UTF-8 byte length of a codepoint. */
export function cpByte(cp) {
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

export class IndexView {
  constructor(map) {
    this.map = map;
    const nLines = map.lines.length;

    // slot ranges per line (lineSlotOffsets): lineStart[i] = first slot of line i
    const lineStart = new Uint32Array(nLines + 1);
    for (let i = 0; i < nLines; i++) lineStart[i + 1] = lineStart[i] + map.lines[i].length;
    this.lineStart = lineStart;
    this.total = lineStart[nLines]; // total drawn glyphs / codepoints (no newlines)
    this.nLines = nLines;

    // byte offset of each line's start in the source (one newline byte per gap)
    const lineByteStart = new Uint32Array(nLines + 1);
    let acc = 0;
    for (let i = 0; i < nLines; i++) {
      let lb = 0;
      for (const di of map.lines[i]) lb += cpByte(map.dict[di].cp);
      lineByteStart[i] = acc;
      acc += lb + (i < nLines - 1 ? 1 : 0);
    }
    lineByteStart[nLines] = acc;
    this.lineByteStart = lineByteStart;
    this.byteLength = acc;

    // per-line grapheme col boundaries: gStart[line][g] = first col of grapheme g
    this.gStart = map.clusters.map((counts) => {
      const s = new Array(counts.length + 1);
      s[0] = 0;
      for (let k = 0; k < counts.length; k++) s[k + 1] = s[k] + counts[k];
      return s;
    });
  }

  /** binary search: line containing a slot. */
  lineOf(slot) {
    let lo = 0, hi = this.nLines;
    while (lo < hi - 1) { const m = (lo + hi) >> 1; if (this.lineStart[m] <= slot) lo = m; else hi = m; }
    return lo;
  }

  // ── slot → everything ──────────────────────────────────────────────────
  slotToLineCol(slot) { const line = this.lineOf(slot); return { line, col: slot - this.lineStart[line] }; }
  lineColToSlot(line, col) { return this.lineStart[line] + col; }
  slotToCp(slot) { const { line, col } = this.slotToLineCol(slot); return this.map.dict[this.map.lines[line][col]].cp; }
  slotToChar(slot) { return String.fromCodePoint(this.slotToCp(slot)); }
  /** the FontChain slot (drawn glyph id) for an instance — for re-rendering. */
  slotToGlyphId(slot) { const { line, col } = this.slotToLineCol(slot); return this.map.dict[this.map.lines[line][col]].slot; }

  /** [startByte, endByte) of the source codepoint this slot draws. */
  slotToByteRange(slot) {
    const { line, col } = this.slotToLineCol(slot);
    const arr = this.map.lines[line];
    let b = this.lineByteStart[line];
    for (let j = 0; j < col; j++) b += cpByte(this.map.dict[arr[j]].cp);
    return [b, b + cpByte(this.map.dict[arr[col]].cp)];
  }

  /** the slot whose codepoint covers `byte` (newline/EOL bytes → next line start). */
  byteToSlot(byte) {
    let lo = 0, hi = this.nLines;
    while (lo < hi - 1) { const m = (lo + hi) >> 1; if (this.lineByteStart[m] <= byte) lo = m; else hi = m; }
    const line = lo, arr = this.map.lines[line];
    let b = this.lineByteStart[line];
    for (let col = 0; col < arr.length; col++) {
      const len = cpByte(this.map.dict[arr[col]].cp);
      if (byte < b + len) return this.lineStart[line] + col;
      b += len;
    }
    return Math.min(this.total, this.lineStart[line] + arr.length);
  }

  /** the grapheme (cursor unit) a slot belongs to, as a slot range. */
  slotToGrapheme(slot) {
    const { line, col } = this.slotToLineCol(slot);
    const s = this.gStart[line];
    let lo = 0, hi = s.length - 1;
    while (lo < hi - 1) { const m = (lo + hi) >> 1; if (s[m] <= col) lo = m; else hi = m; }
    return {
      line, grapheme: lo,
      slotStart: this.lineStart[line] + s[lo],
      slotEnd: this.lineStart[line] + s[lo + 1],
    };
  }

  // ── range queries (the highlight verbs) ──────────────────────────────────
  /** every slot in line range [l0, l1]. */
  slotsForLines(l0, l1) {
    const out = [];
    for (let line = Math.max(0, l0); line <= l1 && line < this.nLines; line++)
      for (let s = this.lineStart[line]; s < this.lineStart[line + 1]; s++) out.push(s);
    return out;
  }

  /** every slot whose codepoint lies in source byte range [b0, b1). */
  slotsForByteRange(b0, b1) {
    const s0 = this.byteToSlot(b0), s1 = this.byteToSlot(b1);
    const out = [];
    for (let s = s0; s < s1; s++) out.push(s);
    return out;
  }

  /** reconstruct the source covered by a set/list of slots (skips newlines). */
  sourceForSlots(slots) { return slots.map((s) => this.slotToChar(s)).join(''); }
}

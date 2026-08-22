import { SLOT_STRIDE, S_X, S_Y, S_Z, S_ADVANCE, S_FLAGS, F_LEADER, fval} from '../compute/glyphPipelineReference.js';

/**
 * ByteLayoutDescription — the queryable product of a byte-pipeline layout. The Layer 2
 * counterpart of LayoutDescription: SAME API (positionAt / slotForChar / charForSlot /
 * extent / lineCount / lineSlotCount), byte-backed internals.
 *
 * The slot IS the source byte offset — picking hits, tree-sitter ranges and the cursor all
 * address one space with no mapping table. The two queries that still speak (line, col)
 * codepoint-space convert through the line index built at encode time:
 *
 *   lineByteStart  Int32Array  line → byte offset of the line's first byte
 *   lineLengths    Int32Array  line → codepoint count (the editor's col space)
 *
 * and a per-line codepoint→byte walk (bytes are 1–4 per codepoint; the walk is O(col) in
 * the line, caret-rate). Positions read the MIRROR's slot buffer (the reference pipeline's
 * output — the CPU oracle the GPU is gate-checked against), so no readback ever happens
 * here. An end-of-line col lands on the line's NEWLINE slot, whose walk position is exactly
 * the line's right edge — no special case.
 */
export default class ByteLayoutDescription {
    /**
     * @param {Object} p
     * @param {Uint8Array} p.bytes        - the file's UTF-8 bytes (one slot per byte)
     * @param {Int32Array} p.lineByteStart - line → first byte offset
     * @param {Int32Array} p.lineLengths   - line → codepoint count
     * @param {Object} p.pipeline          - the arena HANDLE: `.bounds` is the GPU's
     *   per-item record (extent queries never touch the oracle), `.mirror` MATERIALIZES
     *   the CPU oracle on first touch — so only slot-position queries (caret/edit) pay
     *   for it, one grid at a time, never a load storm. Both read lazily: a repaginate
     *   mutates the oracle in place and refreshes the record, so queries always see the
     *   current page/scroll state.
     * @param {number} [p.scrollOffset]    - visual rows the fold is scrolled (informational;
     *   the slots are already scrolled — queries read final positions)
     */
    constructor(p) {
        this.bytes = p.bytes;
        this.lineByteStart = p.lineByteStart;
        this.lineLengths = p.lineLengths;
        this._pipeline = p.pipeline;
        this.scrollOffset = p.scrollOffset ?? 0;
        /** First FILE byte the pipeline staged: a WINDOWED grid's mirror covers only
         *  bytes [sourceBase, sourceBase + staged length). Queries stay file-byte-space;
         *  mirror reads subtract this, and a byte outside the window answers null. */
        this.sourceBase = p.sourceBase ?? 0;
    }

    /** The oracle's slot buffer — MATERIALIZES it on first touch (caret/edit rate). */
    get slots() { return this._pipeline?.mirror?.slots ?? null; }
    /** The GPU's per-item bounds record — extent queries never wake the oracle. */
    get bounds() { return this._pipeline?.bounds ?? null; }

    /** @returns {number} number of source lines */
    get lineCount() { return this.lineByteStart ? this.lineByteStart.length : 0; }

    /** Codepoint count on a line — the exclusive end col for that line. */
    lineSlotCount(line) {
        if (!this.lineLengths || line < 0 || line >= this.lineLengths.length) return 0;
        return this.lineLengths[line];
    }

    /**
     * (line, col) codepoint-space → byte offset. Walks the line's bytes counting only
     * leader bytes (10xxxxxx continuations don't advance the col). col clamps to the line
     * length; col == length lands on the newline's byte (its slot position IS the line's
     * right edge — the walk summed the whole line to place it).
     * @returns {number} byte offset, or -1 if the line is out of range
     */
    byteOffsetOf(line, col) {
        const starts = this.lineByteStart;
        if (!starts || line < 0 || line >= starts.length) return -1;
        const len = this.lineSlotCount(line);
        const c = Math.max(0, Math.min(col, len));
        const bytes = this.bytes;
        let i = starts[line];
        for (let k = 0; k < c; k++) {
            const b = bytes[i];
            i += (b & 0x80) === 0 ? 1 : (b & 0xE0) === 0xC0 ? 2 : (b & 0xF0) === 0xE0 ? 3 : 4;
        }
        return i;
    }

    /**
     * SOURCE (line,col) → BUFFER slot (== byte offset).
     * @returns {number} slot, or -1 if out of range
     */
    slotForChar(line, col) {
        // col must be in-range — an out-of-range col would otherwise return a slot that
        // points at a DIFFERENT line's bytes (highlightRange can pass endCol past EOL).
        if (col < 0 || col >= this.lineSlotCount(line)) return -1;
        return this.byteOffsetOf(line, col);
    }

    /**
     * BUFFER slot (== byte offset) → SOURCE {line,col}. The inverse of slotForChar: a
     * glyph-channel pick returns an instance index == byte offset. Binary search for the
     * owning line, then count leaders within the line. Non-leader bytes (continuation
     * slots) resolve to the codepoint they belong to.
     * @param {number} slot
     * @returns {{line:number,col:number}|null} null when out of range
     */
    charForSlot(slot) {
        const starts = this.lineByteStart;
        if (!starts || starts.length === 0 || slot < 0 || slot >= this.bytes.length) return null;
        let lo = 0, hi = starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= slot) lo = mid; else hi = mid - 1;
        }
        // Count codepoints from the line start to the slot's codepoint start.
        let col = 0;
        for (let i = starts[lo]; i < slot;) {
            const b = this.bytes[i];
            i += (b & 0x80) === 0 ? 1 : (b & 0xE0) === 0xC0 ? 2 : (b & 0xF0) === 0xE0 ? 3 : 4;
            col++;
        }
        if (col >= this.lineSlotCount(lo) && lo < starts.length - 1) return { line: lo, col: this.lineSlotCount(lo) };
        return { line: lo, col };
    }

    /**
     * SOURCE (line,col) → grid-local {x,y,z} — read from the mirror's slot buffer (the
     * paginated, displaced-nowhere final position the GPU is gate-checked against).
     * @returns {{x:number,y:number,z:number}|null}
     */
    positionAt(line, col) {
        const off = this.byteOffsetOf(line, col);
        if (off < 0 || !this.slots) return null;
        const mirrorLen = this.slots.length / SLOT_STRIDE;
        if (off >= this.bytes.length) {
            // EOL col on a final line with no trailing newline: the caret sits on the last
            // glyph's right edge (its x + its advance).
            const lastLocal = this.bytes.length - 1 - this.sourceBase;
            if (lastLocal < 0 || lastLocal >= mirrorLen) return null;   // outside the window
            const last = lastLocal * SLOT_STRIDE;
            return {
                x: fval(this.slots[last + S_X]) + fval(this.slots[last + S_ADVANCE]),
                y: fval(this.slots[last + S_Y]), z: fval(this.slots[last + S_Z]),
            };
        }
        const local = off - this.sourceBase;
        if (local < 0 || local >= mirrorLen) return null;               // outside the window
        const o = local * SLOT_STRIDE;
        return { x: fval(this.slots[o + S_X]), y: fval(this.slots[o + S_Y]), z: fval(this.slots[o + S_Z]) };
    }

    /**
     * The fold's AABB in the grid's own frame — from the mirror's bounds (computed at load;
     * re-reduced on repaginate by the pipeline adapter). Same shape LayoutDescription.extent
     * returns so every consumer (cull box, panel, camera fit) reads it unchanged.
     * @returns {{min:{x,y,z}, max:{x,y,z}, width:number, height:number, depth:number}|null}
     */
    extent() {
        const b = this.bounds;
        if (!b) return null;
        return {
            min: b.min, max: b.max,
            width: b.max.x - b.min.x,
            height: b.max.y - b.min.y,
            depth: b.max.z - b.min.z,
        };
    }
}

/**
 * Build the line index for a byte buffer: line → first byte offset, line → codepoint
 * count. One O(bytes) scan at encode time — the ONLY line structure the byte pipeline
 * keeps (the GPU walk derives row/col itself; this index backs caret/navigation queries).
 * @param {Uint8Array} bytes
 * @returns {{lineByteStart: Int32Array, lineLengths: Int32Array}}
 */
export function buildByteLineIndex(bytes) {
    let lines = 1;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0A) lines++;
    const lineByteStart = new Int32Array(lines);
    const lineLengths = new Int32Array(lines);
    let line = 0;
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b === 0x0A) { line++; lineByteStart[line] = i + 1; continue; }
        if ((b & 0xC0) !== 0x80) lineLengths[line]++;   // leader bytes only
    }
    return { lineByteStart, lineLengths };
}

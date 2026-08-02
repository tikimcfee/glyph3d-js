import { paginationShift } from '../workers/builders/index.js';

const EMPTY = Object.freeze([]);

/**
 * LayoutDescription — the authoritative, queryable product of a layout pass.
 *
 * Centralizes the forward layout queries (SOURCE (line,col) → WORLD x,y,z, and →
 * BUFFER slot) so the caret, highlight and selection share ONE source instead of
 * each re-deriving wrap/pagination math (the divergence that kept breaking the
 * caret). See LAYOUT_PLAN.md.
 *
 * Coordinate systems: SOURCE (srcLine,srcCol) is authoritative; VISUAL (visual row)
 * and WORLD are derived; BUFFER slot is a cache (invariant: slot offset within a line
 * == codepoint index). Inverse (world→source) is the GPU picking pass, not here.
 *
 * positionAt is the **fold mirror**: it evaluates the same pure layout function the
 * compute kernel runs on the GPU — wrap segment from the line tables, x from the REAL
 * per-slot advances (emoji are double-advance), the z staircase, and the SAME
 * paginationShift the builder normalizes by. No position buffer exists to read: the GPU
 * owns the laid-out array, and every input to the fold (tables, advances, params) is
 * CPU-authored — so any glyph's "I am at this location" is answerable here, exactly,
 * without readback. Parity with the kernel is a standing test, not a convention.
 */
export default class LayoutDescription {
    /**
     * @param {Object} p
     * @param {Int32Array} p.lineSlotBase   - line → first buffer slot (slot = base + col)
     * @param {Int32Array} p.lineStartRow   - line → cumulative visual row
     * @param {Array<number[]>} p.lineWrapCols - line → source-cols where it wraps
     * @param {Int32Array|number[]} p.lineLengths - line → codepoint count
     * @param {Float32Array|null} p.sizes   - per-slot [advance, height]; real advances make x EXACT
     * @param {Object} p.geom   - pagination geometry (paginationGeometry output)
     * @param {number} p.originX
     * @param {number} p.originY
     * @param {number} p.lineSpacing
     * @param {number} p.zStep  - world z per intra-line wrap segment (charHeight × zWrapSpacing)
     * @param {number} p.advance - nominal per-glyph advance (fallback when sizes is absent)
     * @param {number} [p.scrollOffset] - visual rows the fold is scrolled (Step 3c conveyor)
     * @param {Float32Array|null} [p.displacements] - arranger displacements, flat [dx,dy,dz]
     *   per field-global slot — the SAME CPU-authored table the kernel adds post-fold
     */
    constructor(p) {
        this.lineSlotBase = p.lineSlotBase ?? null;
        this.lineStartRow = p.lineStartRow ?? null;
        this.lineWrapCols = p.lineWrapCols ?? null;
        this.lineLengths = p.lineLengths ?? null;
        this.sizes = p.sizes ?? null;
        this.geom = p.geom ?? null;
        this.originX = p.originX ?? 0;
        this.originY = p.originY ?? 0;
        this.lineSpacing = p.lineSpacing ?? 0;
        this.zStep = p.zStep ?? 0;
        this.advance = p.advance ?? 0;
        this.scrollOffset = p.scrollOffset ?? 0;  // visual rows the fold is scrolled (Step 3c)
        this.displacements = p.displacements ?? null;
    }

    /** @returns {number} number of source lines */
    get lineCount() { return this.lineStartRow ? this.lineStartRow.length : 0; }

    /** Codepoint count on a line — the exclusive end col for that line. */
    lineSlotCount(line) {
        if (!this.lineLengths || line < 0 || line >= this.lineLengths.length) return 0;
        return this.lineLengths[line];
    }

    /**
     * SOURCE (line,col) → BUFFER slot. col is a raw codepoint index; the builder slots
     * one glyph per codepoint, so slot = lineSlotBase[line] + col.
     * @returns {number} slot, or -1 if out of range
     */
    slotForChar(line, col) {
        if (!this.lineSlotBase || line < 0 || line >= this.lineSlotBase.length) return -1;
        // col must be in-range too — an out-of-range col would otherwise return a slot
        // that points at a DIFFERENT line's glyphs (highlightRange can pass endCol past
        // EOL). Honors the "−1 if out of range" contract.
        if (col < 0 || col >= this.lineSlotCount(line)) return -1;
        return this.lineSlotBase[line] + col;
    }

    /**
     * BUFFER slot → SOURCE {line,col}. The inverse of slotForChar: a glyph-channel
     * pick returns an instance index, instance order == slot order, so this is how
     * "the glyph under the pointer" becomes a cursor position. Binary search for
     * the greatest line whose base ≤ slot; empty lines (base[n] == base[n+1]) hold
     * no slots, so the search naturally lands on the line that owns the glyph.
     * @param {number} slot
     * @returns {{line:number,col:number}|null} null when out of range
     */
    charForSlot(slot) {
        const base = this.lineSlotBase;
        if (!base || base.length === 0 || slot < 0) return null;
        let lo = 0, hi = base.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (base[mid] <= slot) lo = mid; else hi = mid - 1;
        }
        const col = slot - base[lo];
        if (col >= this.lineSlotCount(lo)) return null; // past the buffer's last glyph
        return { line: lo, col };
    }

    /**
     * SOURCE (line,col) → grid-local {x,y,z} — THE fold mirror, evaluated per query.
     *
     * col ≤ lineLength; col == length is end-of-line (the last glyph's right edge, which
     * the segment-sum yields with no special case: summing advances over [segStart, col)
     * walks THROUGH the last glyph). Exact when the sizes table is present — real
     * advances, so glyphs after a double-advance emoji land where the GPU puts them;
     * the nominal advance is only a pre-flush fallback. Per-query cost is one bounded
     * segment sum (≤ wrapWidth adds) — caret-rate, not render-rate work.
     * Returns null when the layout isn't ready.
     * @returns {{x:number,y:number,z:number}|null}
     */
    positionAt(line, col) {
        if (!this.lineStartRow || line < 0 || line >= this.lineStartRow.length) return null;
        const len = this.lineSlotCount(line);
        const c = Math.max(0, Math.min(col, len));

        // Wrap segment (affinity right — a col AT a wrap boundary starts the next row,
        // matching the builder's break-before-place trigger).
        const wraps = this.lineWrapCols?.[line] ?? EMPTY;
        let segRow = 0, segStart = 0;
        for (let i = 0; i < wraps.length; i++) {
            if (wraps[i] > c) break;
            segRow = i + 1;
            segStart = wraps[i];
        }

        // x: sum the REAL advances across this visual row, segment-local. Falls back to
        // the nominal advance only when sizes hasn't materialized yet.
        const base = this.lineSlotBase ? this.lineSlotBase[line] : null;
        const sz = this.sizes;
        let x = this.originX;
        const s1 = base != null ? base + c : 0;
        if (sz && base != null && s1 * 2 <= sz.length) {
            for (let s = base + segStart; s < s1; s++) x += sz[s * 2];
        } else {
            x += (c - segStart) * this.advance;
        }

        // Scroll (Step 3c): the builder shifts content up by scrollOffset rows, so
        // screenRow = visualRow − scrollOffset; the mirror must match or a caret on a
        // scrolled grid sits at the unscrolled position.
        const visualRow = this.lineStartRow[line] + segRow;
        const y = this.originY - (visualRow - this.scrollOffset) * this.lineSpacing;
        // The z staircase: each intra-line wrap segment steps back. Empty lines and
        // unwrapped cols sit at segRow 0 → z 0, as before.
        const z = -segRow * this.zStep;

        let px = x, py = y, pz = z;
        if (this.geom) {
            // Page fold — the SAME paginationShift the builder normalizes by. shiftZ is
            // additive (axis 'z' pushes pages back; 'xy' leaves z alone), so the staircase
            // survives pagination exactly as it does in the buffer.
            const { shiftX, mappedRelY, shiftZ } = paginationShift(this.originY - y, this.geom);
            px = x + shiftX; py = this.originY - mappedRelY; pz = z + shiftZ;
        }
        // Arranger displacement — the same CPU-authored table the kernel adds post-fold.
        // An EOL caret rides the LAST glyph's displacement (the glyph whose right edge it
        // sits on); an empty line has no glyph and no displacement.
        const D = this.displacements;
        if (D && base != null && len > 0) {
            const ds = (base + Math.min(c, len - 1)) * 3;
            if (ds + 2 < D.length) { px += D[ds]; py += D[ds + 1]; pz += D[ds + 2]; }
        }
        return { x: px, y: py, z: pz };
    }
}

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
 * positionAt is **buffer-backed**: for a materialized glyph it returns the glyph's
 * actual laid-out position (wrap + pagination already baked in by the builder), so no
 * layout math is re-run. Empty lines — and, once windowing lands, off-screen lines —
 * fall back to the analytic line table + the SAME paginationShift the builder used.
 */
export default class LayoutDescription {
    /**
     * @param {Object} p
     * @param {Int32Array} p.lineSlotBase   - line → first buffer slot (slot = base + col)
     * @param {Int32Array} p.lineStartRow   - line → cumulative visual row
     * @param {Array<number[]>} p.lineWrapCols - line → source-cols where it wraps
     * @param {Int32Array|number[]} p.lineLengths - line → codepoint count
     * @param {Float32Array|null} p.positions - authoritative xyz per slot (renderer attr)
     * @param {Float32Array|null} p.sizes     - per-slot [advance, height]
     * @param {Object} p.geom   - pagination geometry (paginationGeometry output)
     * @param {number} p.originX
     * @param {number} p.originY
     * @param {number} p.lineSpacing
     * @param {number} p.advance - fixed per-glyph advance (analytic fallback only)
     * @param {number} [p.scrollOffset] - visual rows the fold is scrolled (Step 3c conveyor)
     */
    constructor(p) {
        this.lineSlotBase = p.lineSlotBase ?? null;
        this.lineStartRow = p.lineStartRow ?? null;
        this.lineWrapCols = p.lineWrapCols ?? null;
        this.lineLengths = p.lineLengths ?? null;
        this.positions = p.positions ?? null;
        this.sizes = p.sizes ?? null;
        this.geom = p.geom ?? null;
        this.originX = p.originX ?? 0;
        this.originY = p.originY ?? 0;
        this.lineSpacing = p.lineSpacing ?? 0;
        this.advance = p.advance ?? 0;
        this.scrollOffset = p.scrollOffset ?? 0;  // visual rows the fold is scrolled (Step 3c)
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
     * SOURCE (line,col) → grid-local {x,y,z}. Buffer-backed for materialized glyphs
     * (exact; wrap + pagination already applied), analytic fallback for empty lines.
     * Returns null when the layout isn't ready.
     * @returns {{x:number,y:number,z:number}|null}
     */
    positionAt(line, col) {
        if (!this.lineStartRow || line < 0 || line >= this.lineStartRow.length) return null;
        const len = this.lineSlotCount(line);
        const c = Math.max(0, Math.min(col, len));
        const pos = this.positions, sz = this.sizes;
        const base = this.lineSlotBase ? this.lineSlotBase[line] : null;

        if (pos && base != null && len > 0) {
            if (c < len) {
                // Caret before glyph c → that glyph's left edge.
                const s = base + c;
                if (s * 3 + 2 < pos.length) {
                    return { x: pos[s * 3], y: pos[s * 3 + 1], z: pos[s * 3 + 2] };
                }
            } else {
                // End-of-line → right edge of the last glyph (its x + advance). Require
                // BOTH buffers — if sizes is missing we'd add advance 0 and place the
                // caret at the last glyph's LEFT edge; fall through to analytic instead.
                const s = base + (len - 1);
                if (s * 3 + 2 < pos.length && sz && s * 2 + 1 < sz.length) {
                    return { x: pos[s * 3] + sz[s * 2], y: pos[s * 3 + 1], z: pos[s * 3 + 2] };
                }
            }
        }
        // Empty line, or buffer not ready / off-screen — derive analytically.
        return this._analyticPosition(line, c);
    }

    /**
     * Analytic position from the line table + the SAME pagination map the builder
     * applied. Used for empty lines (no glyph to read) and, later, off-screen lines.
     * x uses the fixed advance (approximate) — only reached when no glyph exists.
     * @private
     */
    _analyticPosition(line, col) {
        if (!this.lineStartRow) return null;
        const wraps = this.lineWrapCols?.[line] ?? EMPTY;
        let segRow = 0, segStart = 0;
        for (let i = 0; i < wraps.length; i++) {
            if (wraps[i] > col) break;
            segRow = i + 1;
            segStart = wraps[i];
        }
        const visualRow = this.lineStartRow[line] + segRow;
        const x = this.originX + (col - segStart) * this.advance;
        // Scroll (Step 3c): the builder shifts materialized glyphs up by scrollOffset rows,
        // so screenRow = visualRow − scrollOffset; the analytic fallback must match, else an
        // empty-line caret would sit at the unscrolled position.
        const y = this.originY - (visualRow - this.scrollOffset) * this.lineSpacing;
        if (!this.geom) return { x, y, z: 0 };
        // Empty line has no glyph z (no intra-line wrap); the page fold supplies z via shiftZ
        // (0 for axis 'xy', -page*depth for 'z'), so the caret lands on the right page plane.
        const { shiftX, mappedRelY, shiftZ } = paginationShift(this.originY - y, this.geom);
        return { x: x + shiftX, y: this.originY - mappedRelY, z: shiftZ };
    }
}

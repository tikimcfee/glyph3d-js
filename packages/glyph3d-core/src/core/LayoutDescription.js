import { pageShift, foldExtent, lineSegments } from './foldGeometry.js';

/**
 * LayoutDescription — the authoritative, queryable product of a layout pass.
 *
 * Centralizes the forward layout queries (SOURCE (line,col) → WORLD x,y,z, → BUFFER slot,
 * and the fold's own EXTENT) so the caret, highlight, selection, panel and cull box share
 * ONE source instead of each re-deriving wrap/pagination math.
 *
 * Coordinate systems: SOURCE (srcLine,srcCol) is authoritative; VISUAL (visual row) and
 * WORLD are derived; BUFFER slot is a cache (invariant: slot offset within a line ==
 * codepoint index). Inverse (world→source) is the GPU picking pass, not here.
 *
 * positionAt is the **fold mirror**: it evaluates the same pure layout function the compute
 * kernel runs on the GPU — wrap segment from the line's slot count, x from the REAL per-slot
 * advances (emoji are double-advance), the z staircase, and the SAME integer-row `pageShift`.
 * No position buffer exists to read: the GPU owns the laid-out array, and every input to the
 * fold is CPU-authored, so any glyph's "I am at this location" is answerable here, exactly,
 * without readback.
 *
 * extent() is the same story one level up — the fold's AABB, closed form on the three scalars
 * the layout scan produces (`totalRows`, `maxRowExtent`, `maxSegs`). Bounds are a property of
 * the description, not a measurement of the buffer it describes; see core/foldGeometry.js.
 */
export default class LayoutDescription {
    /**
     * @param {Object} p
     * @param {Int32Array} p.lineSlotBase   - line → first buffer slot (slot = base + col)
     * @param {Int32Array} p.lineStartRow   - line → cumulative visual row
     * @param {Int32Array|number[]} p.lineLengths - line → codepoint count
     * @param {Float32Array|null} p.sizes   - per-slot [advance, height]; real advances make x EXACT
     * @param {number} [p.wrapWidth] - slots per visual row, 0 = no wrap
     * @param {?Object} [p.page]     - pageFold output; null / rows<=0 = pagination off
     * @param {number} [p.originX]
     * @param {number} [p.originY]
     * @param {number} [p.originZ]
     * @param {number} p.lineSpacing
     * @param {number} [p.zStep]  - world z per intra-line wrap segment (charHeight × zWrapSpacing)
     * @param {number} [p.cellHeight] - a row's height (position is the cell's BOTTOM edge)
     * @param {number} [p.advance] - nominal per-glyph advance (fallback when sizes is absent)
     * @param {number} [p.scrollOffset] - visual rows the fold is scrolled (the conveyor)
     * @param {Float32Array|null} [p.displacements] - arranger displacements, flat [dx,dy,dz]
     *   per field-global slot — the SAME CPU-authored table the kernel adds post-fold
     * @param {number} [p.totalRows]    - visual rows the item occupies (layout scan output)
     * @param {number} [p.maxRowExtent] - widest visual row's world width (layout scan output)
     * @param {number} [p.maxSegs]      - deepest wrap segment index (layout scan output)
     */
    constructor(p) {
        this.lineSlotBase = p.lineSlotBase ?? null;
        this.lineStartRow = p.lineStartRow ?? null;
        this.lineLengths = p.lineLengths ?? null;
        this.sizes = p.sizes ?? null;
        this.wrapWidth = Math.max(0, Math.trunc(p.wrapWidth ?? 0));
        this.page = p.page ?? null;
        this.originX = p.originX ?? 0;
        this.originY = p.originY ?? 0;
        this.originZ = p.originZ ?? 0;
        this.lineSpacing = p.lineSpacing ?? 0;
        this.zStep = p.zStep ?? 0;
        this.cellHeight = p.cellHeight ?? 0;
        this.advance = p.advance ?? 0;
        this.scrollOffset = p.scrollOffset ?? 0;
        this.displacements = p.displacements ?? null;
        this.totalRows = p.totalRows ?? 0;
        this.maxRowExtent = p.maxRowExtent ?? 0;
        this.maxSegs = p.maxSegs ?? 0;
        /** @private memoized extent — the description is immutable once built */
        this._extent = undefined;
    }

    /** @returns {number} number of source lines */
    get lineCount() { return this.lineStartRow ? this.lineStartRow.length : 0; }

    /** Codepoint count on a line — the exclusive end col for that line. */
    lineSlotCount(line) {
        if (!this.lineLengths || line < 0 || line >= this.lineLengths.length) return 0;
        return this.lineLengths[line];
    }

    /**
     * The fold's AABB in the item's own frame — closed form, memoized.
     *
     * This is the ONE bounds source for laid-out glyph content: the cull box, the background
     * panel, camera framing and the layout containers all resolve here. It costs the same
     * whether the file is ten lines or a million, and it is exact — no walk, no readback,
     * no cache to invalidate, because nothing it reads can go stale without the description
     * itself being rebuilt.
     *
     * Arranger displacements are NOT folded in: an arranger AUTHORS its displacement table
     * and therefore states its own extent (CodeGrid.setDisplacements) rather than having it
     * measured back out.
     *
     * @returns {{min:{x,y,z}, max:{x,y,z}, width:number, height:number, depth:number}|null}
     */
    extent() {
        if (this._extent !== undefined) return this._extent;
        this._extent = foldExtent({
            totalRows: this.totalRows,
            maxRowExtent: this.maxRowExtent,
            maxSegs: this.maxSegs,
            origin: { x: this.originX, y: this.originY, z: this.originZ },
            lineSpacing: this.lineSpacing,
            zStep: this.zStep,
            cellHeight: this.cellHeight,
            scrollOffset: this.scrollOffset,
            page: this.page,
        });
        return this._extent;
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

        // Wrap segment. Affinity right — a col AT a wrap boundary starts the next row,
        // matching the fold's break-before-place trigger — and clamped to the segments the
        // line actually HAS: an end-of-line caret on a line whose length is an exact
        // multiple of wrapWidth sits at the end of the last real row, not on a phantom
        // row past it (the line never wrapped a final time; there was nothing left to place).
        const w = this.wrapWidth;
        const segRow = w > 0 ? Math.min(Math.floor(c / w), lineSegments(len, w)) : 0;
        const segStart = segRow * w;

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

        // The conveyor: content shifts up by scrollOffset rows, so screenRow = visualRow −
        // scrollOffset. The page fold then reads that integer row — the SAME gate and the
        // SAME division the kernel runs, so a boundary row can't land a page apart.
        const screenRow = this.lineStartRow[line] + segRow - this.scrollOffset;
        const shift = pageShift(screenRow, this.page);
        let px = x + shift.dx;
        let py = this.originY - shift.relY;
        // The z staircase: each intra-line wrap segment steps back. Page depth (axis 'z')
        // is additive on top, so the staircase survives pagination exactly as in the buffer.
        let pz = this.originZ - segRow * this.zStep + shift.dz;

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

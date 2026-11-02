/**
 * ScrollDocument — one document of rows read through a fixed frame, at ONE size: a title row
 * over a body that scrolls. An agent book's scroll form (Book form 'scroll') is one: its run
 * as a headline row per event, then the event's body, the way a terminal shows a session.
 *
 * The body is BLOCKS of rows (a block per event; `{id, rows}` — each row `{segs, indent}`, segs
 * `{text, color}` runs), all laid out by LayoutGenerator into ONE InstancedField at the cell
 * grid (`metrics`, from the atlas): row r's cell center at y = bodyY − r·lineSpacing, a row's
 * glyphs from x = indent·charWidth. Rows never wrap here — the caller wraps (wrapCells, the
 * same cell rule the layout steps by), so a row is exactly the text it was given.
 *
 * COST. Changes are marked, not laid: an append, an update, an eviction or a prepend says where
 * the document became dirty, and flush() lays out ONLY from there to the end — a live run's
 * batch (a block or three at the tail) writes its new rows' slots and uploads just that range
 * (InstancedField.writeTail). An eviction at the head lays out nothing: the block's slots stay
 * as DEAD slots above the first live row (clipped, never shown) until they outnumber the live
 * ones (`compactRatio`), when the live slots MOVE down over them (a memmove and a row renumber,
 * no layout) and go up whole once. A prepend (older
 * history paged in) is a full pass. Scrolling is never a layout: the body's group-0 offset and
 * clip move the document under its frame (one group-table write).
 *
 * VIEW. Following (the default), the frame rides the end: the last row sits on the frame's last
 * row, and appends scroll it on. Held (scrolled up), the top row is ANCHORED to the block it
 * shows (`{id, row}` — a block's id and the row inside it), so appends, updates below it,
 * evictions and prepends never move what the reader is looking at. view() / setView() carry the
 * anchor (a reload restores it by the block's id).
 *
 * In a plane desk it pins like a terminal: `metrics` (its column) and pixelOrigin() (the title
 * row's cell top-left) are what Carrel's pin fit scales and snaps by, and getLocalBounds() is
 * its frame — cols × (title + gap + rows) cells — never its content.
 */

import * as THREE from 'three';
import BoundedObject3D from './BoundedObject3D.js';
import InstancedField from './InstancedField.js';
import { packRgba8, SLOT_FLOATS, LANE_POS_Y } from '../core/InstancedSlotBuffer.js';
import { generateLayout, resolveGlyph, shaperUpem } from '../core/LayoutGenerator.js';
import { computeCellMetrics } from '../core/cellMetrics.js';
import { BOUNDS_Z_PAD } from '../core/constants.js';
import { DEFAULT_LAYOUT } from '../workers/builders/index.js';
import { createBackgroundMesh } from './grid/index.js';
import { LAYER_BAND, getBandDistance } from '../core/layerBands.js';
/** @import GlyphAtlas from '../GlyphAtlas.js' */

/**
 * @typedef {{text:string, color:{r:number,g:number,b:number}}} ScrollSeg
 * @typedef {{segs:ScrollSeg[], indent?:number}} ScrollRow
 * @typedef {{id:string, rows:ScrollRow[]}} ScrollBlock
 */

/** Defaults — every one a constructor option. */
export const SCROLL_DOCUMENT_DEFAULTS = Object.freeze({
    cols: 100,             // the frame's width in cells (the caller wraps rows to it)
    rows: 40,              // the body's frame height in rows (the title rides above)
    titleGap: 1,           // blank rows between the title row and the body
    worldScale: 0.025,     // the glyph field's unit (pixels → world)
    pad: 0.5,              // the backdrop's margin around the frame, in cells
    background: 0x0a0a1e,  // backdrop fill
    backgroundOpacity: 0.92,
    compactRatio: 1,       // dead slots above the first live row past this × the live ones → one full re-lay
    tabWidth: DEFAULT_LAYOUT.tabWidth,
});

/**
 * Wrap one line (no newline) into rows of at most `cols` CELLS — each glyph counted by the
 * layout's own cell rule (`cellsOf`; a tab to its stop from the row's start) — breaking after
 * the last space that follows a word when it can, else at the edge. Nothing is dropped: the
 * rows concatenate back to the line exactly (a break keeps its space at the row's end). A glyph
 * wider than `cols` stands alone on its row. Pure.
 * @param {string} text @param {number} cols @param {(cp:number) => number} cellsOf
 * @param {number} [tabWidth]
 * @returns {string[]} at least one row
 */
export function wrapCells(text, cols, cellsOf, tabWidth = DEFAULT_LAYOUT.tabWidth) {
    const cps = Array.from(String(text ?? ''));
    const max = Math.max(1, Math.floor(cols));
    const rows = [];
    let start = 0;
    while (start < cps.length) {
        let cells = 0, i = start, brk = -1, word = false;
        for (; i < cps.length; i++) {
            const ch = cps[i];
            const ws = ch === ' ' || ch === '\t';
            const w = ch === '\t' ? tabWidth - (cells % tabWidth) : cellsOf(ch.codePointAt(0));
            if (cells + w > max && i > start) break;
            cells += w;
            if (ws && word) brk = i + 1;
            if (!ws) word = true;
        }
        const end = i < cps.length && brk > start ? brk : i;
        rows.push(cps.slice(start, end).join(''));
        start = end;
    }
    return rows.length ? rows : [''];
}

/** The cells a row's text spans by the layout's rule (tabs to their stops). Pure. */
export function rowCells(text, cellsOf, tabWidth = DEFAULT_LAYOUT.tabWidth) {
    let cells = 0;
    for (const ch of String(text ?? '')) cells += ch === '\t' ? tabWidth - (cells % tabWidth) : cellsOf(ch.codePointAt(0));
    return cells;
}

const packOf = (c) => packRgba8(c?.r ?? 1, c?.g ?? 1, c?.b ?? 1, 1);

export default class ScrollDocument extends BoundedObject3D {
    /**
     * @param {GlyphAtlas} atlas
     * @param {Partial<typeof SCROLL_DOCUMENT_DEFAULTS>} [opts]
     */
    constructor(atlas, opts = {}) {
        super();
        this.name = 'scroll-document';
        this.atlas = atlas;
        this.cfg = { ...SCROLL_DOCUMENT_DEFAULTS, ...opts };
        const size = atlas?.getCharSize?.();
        if (!size || !(size.width > 0) || !(size.height > 0)) {
            throw new Error(`[ScrollDocument] atlas.getCharSize() gave no cell (${JSON.stringify(size)}) — the document's grid is the atlas's`);
        }
        /** the cell metrics every row is laid out by (world units, this object's frame) */
        this.metrics = computeCellMetrics(size, this.cfg.worldScale);
        this._shaper = atlas._shapeCache || atlas._shaper || null;
        this._upem = shaperUpem(this._shaper);
        this._glyph = { g: 0, advance: 0, step: 0 };
        /** @param {number} cp @returns {number} the cells one glyph steps (the layout's rule) */
        this.cellsOf = (cp) => {
            const m = this.metrics;
            return Math.round(resolveGlyph(this._shaper, cp, this._upem, m.emWorld, m.charWidth, this._glyph).step / m.charWidth);
        };

        const field = (n) => new InstancedField(null, atlas, { worldScale: this.cfg.worldScale, defaultColor: { r: 1, g: 1, b: 1 }, maxInstances: n });
        this.titleField = field(256);
        this.bodyField = field(4096);
        this.add(this.titleField.instanceMesh);
        this.add(this.bodyField.instanceMesh);
        this._slots = this.bodyField.slotBuffer;
        this._sizes = new Float32Array(8192);

        const bg = createBackgroundMesh({ backgroundColor: this.cfg.background, backgroundOpacity: this.cfg.backgroundOpacity, showBackground: true },
            getBandDistance(LAYER_BAND.GRID_BACKGROUND));
        this._background = bg.mesh;
        this._panel = bg.panel;
        this.add(this._background);

        /** @type {Array<ScrollBlock & {row0:number, slot0:number, slotN:number}>} the live blocks, oldest first */
        this.blocks = [];
        this._index = new Map();       // id → block
        this._dirtyFrom = 0;           // first block index whose rows must be laid (blocks.length = clean)
        this._deadSlots = 0;           // slots before the first live block's (evicted, clipped)
        this._rowBase = 0;             // the first live row (rows above it are dead)
        this._full = true;             // the next flush re-lays from row 0
        /** following: the frame rides the document's end; else held at `_anchor` */
        this.following = true;
        this._anchor = null;           // {id, row} the top row while held
        this._title = null;
        /** what flush and scroll did — the cost gate reads these */
        this.stats = { flushes: 0, fullPasses: 0, laidRows: 0, laidSlots: 0, uploadedSlots: 0, scrolls: 0 };
        this._layFrame();
    }

    // -- geometry ---------------------------------------------------------------------------

    /** Row pitch (world, this frame). */
    get lineSpacing() { return this.metrics.lineSpacing; }

    /** The body's row 0 cell center (y, this frame). @private */
    get _bodyY() { return -(1 + Math.max(0, this.cfg.titleGap)) * this.metrics.lineSpacing; }

    /** The frame in rows: the title, its gap, the body. */
    get frameRows() { return 1 + Math.max(0, this.cfg.titleGap) + this.cfg.rows; }

    /** The local point the text's cell grid starts from — the title row's cell top-left. A plane
     *  snaps THIS to a device-pixel corner. */
    pixelOrigin() { return { x: 0, y: this.metrics.charHeight / 2 }; }

    /** The frame (local): cols × frameRows cells from the cell origin, padded — never the content. */
    getLocalBounds() {
        const m = this.metrics, o = this.pixelOrigin();
        const pad = this.cfg.pad * m.charWidth;
        const box = (this._box ??= new THREE.Box3());
        box.min.set(o.x - pad, o.y - this.frameRows * m.lineSpacing - pad, -BOUNDS_Z_PAD);
        box.max.set(o.x + this.cfg.cols * m.charWidth + pad, o.y + pad, BOUNDS_Z_PAD);
        return box;
    }

    /** Re-size the frame (cols, rows): the caller re-wraps its blocks for new cols. */
    setFrame({ cols, rows } = {}) {
        if (Number.isFinite(cols) && cols >= 1) this.cfg.cols = Math.floor(cols);
        if (Number.isFinite(rows) && rows >= 1) this.cfg.rows = Math.floor(rows);
        this._layFrame();
        this._applyView();
        return this;
    }

    /** Backdrop + culling extent for the frame. @private */
    _layFrame() {
        const b = this.getLocalBounds();
        const bg = this._background;
        bg.scale.set(b.max.x - b.min.x, b.max.y - b.min.y, 1);
        bg.position.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, bg.position.z);
        const m = this.metrics, top = this.pixelOrigin().y;
        // The body draws only inside its frame (the group offset moves rows under the clip), so
        // the extent three culls by is the frame's, after the offset.
        this._bodyExtent = {
            min: { x: 0, y: this._bodyY - (this.cfg.rows - 1) * m.lineSpacing - m.charHeight / 2, z: 0 },
            max: { x: this.cfg.cols * m.charWidth, y: this._bodyY + m.charHeight / 2, z: 0 },
        };
        this._titleExtent = { min: { x: 0, y: top - m.charHeight, z: 0 }, max: { x: this.cfg.cols * m.charWidth, y: top, z: 0 } };
    }

    // -- content ------------------------------------------------------------------------------

    /** The title row (one row of segs; the caller fits it to cols). Identical text is a no-op. */
    setTitle(segs) {
        const key = JSON.stringify(segs);
        if (key === this._title) return this;
        this._title = key;
        const slots = this.titleField.slotBuffer;
        slots.clear();
        this._layRow(slots, null, { segs, indent: 0 }, 0, true);
        this.titleField.writeTail(slots, 0, slots.count);
        this.titleField.setLayoutExtent(this._titleExtent);
        return this;
    }

    /** Replace every block (a form switch, a re-wrap). */
    setBlocks(blocks) {
        this.blocks = blocks.map((b) => ({ ...b, row0: 0, slot0: 0, slotN: 0 }));
        this._reindex();
        this._full = true;
        return this;
    }

    /** Append blocks at the end — the live tail. */
    pushBlocks(blocks) {
        if (!blocks.length) return this;
        this._dirtyFrom = Math.min(this._dirtyFrom, this.blocks.length);
        for (const b of blocks) {
            if (this._index.has(b.id)) throw new Error(`[ScrollDocument] block ${b.id} is already in the document`);
            const blk = { ...b, row0: 0, slot0: 0, slotN: 0 };
            this.blocks.push(blk);
            this._index.set(b.id, blk);
        }
        return this;
    }

    /** Prepend blocks at the start — older history paged in. A full pass. */
    unshiftBlocks(blocks) {
        if (!blocks.length) return this;
        this.blocks.unshift(...blocks.map((b) => ({ ...b, row0: 0, slot0: 0, slotN: 0 })));
        this._reindex();
        this._full = true;
        return this;
    }

    /** Rebuild one block's rows in place (an event's update; an expand/collapse). Re-lays from it on. */
    replaceBlock(id, block) {
        const i = this.blocks.findIndex((b) => b.id === id);
        if (i < 0) return false;
        const old = this.blocks[i];
        const blk = { ...block, row0: old.row0, slot0: old.slot0, slotN: old.slotN };
        this.blocks[i] = blk;
        this._index.delete(id);
        this._index.set(blk.id, blk);
        if (this._anchor?.id === id) { this._anchor.id = blk.id; this._anchor.row = Math.min(this._anchor.row, Math.max(0, blk.rows.length - 1)); }
        this._dirtyFrom = Math.min(this._dirtyFrom, i);
        return true;
    }

    /** Drop the `n` oldest blocks (the window sliding on). Nothing is laid: their slots go dead. */
    shiftBlocks(n = 1) {
        const k = Math.min(Math.max(0, n), this.blocks.length);
        if (!k) return this;
        const laid = this._full ? 0 : Math.min(this._dirtyFrom, this.blocks.length);   // blocks with valid slots
        for (let j = 0; j < k; j++) {
            const b = this.blocks.shift();
            this._index.delete(b.id);
            if (this._anchor?.id === b.id) this._anchor = this.blocks[0] ? { id: this.blocks[0].id, row: 0 } : null;
        }
        // The dead region ends where the new first block's slots begin — or, when every laid block
        // left, at the end of what was laid.
        if (!this._full) {
            if (laid > k) { this._deadSlots = this.blocks[0].slot0; this._rowBase = this.blocks[0].row0; }
            else { this._deadSlots = this._slots.count; this._rowBase = this._rowEnd ?? this._rowBase; }
        }
        this._dirtyFrom = Math.max(0, laid - k);
        return this;
    }

    /** Drop the `n` newest blocks (a window sliding back). Re-lays from the cut (nothing — a truncation). */
    popBlocks(n = 1) {
        const k = Math.min(Math.max(0, n), this.blocks.length);
        for (let j = 0; j < k; j++) {
            const b = this.blocks.pop();
            this._index.delete(b.id);
            if (this._anchor?.id === b.id) this._anchor = null;
        }
        this._dirtyFrom = Math.min(this._dirtyFrom, this.blocks.length);
        this._truncate = true;
        return this;
    }

    /** Insert one block at index `i` (an older one paged in at the front is unshiftBlocks). */
    insertBlock(i, block) {
        const at = Math.min(Math.max(0, Math.floor(i) || 0), this.blocks.length);
        if (at === this.blocks.length) return this.pushBlocks([block]);
        if (at === 0) return this.unshiftBlocks([block]);
        if (this._index.has(block.id)) throw new Error(`[ScrollDocument] block ${block.id} is already in the document`);
        const blk = { ...block, row0: 0, slot0: 0, slotN: 0 };
        this.blocks.splice(at, 0, blk);
        this._index.set(blk.id, blk);
        this._dirtyFrom = Math.min(this._dirtyFrom, at);
        return this;
    }

    /** Remove one block wherever it is (the oldest goes dead, the newest truncates, a middle one re-lays from its place). */
    removeBlock(id) {
        const i = this.blocks.findIndex((b) => b.id === id);
        if (i < 0) return false;
        if (i === 0) this.shiftBlocks(1);
        else if (i === this.blocks.length - 1) this.popBlocks(1);
        else {
            this.blocks.splice(i, 1);
            this._index.delete(id);
            if (this._anchor?.id === id) this._anchor = { id: this.blocks[i].id, row: 0 };
            this._dirtyFrom = Math.min(this._dirtyFrom, i);
        }
        return true;
    }

    /** @private */
    _reindex() {
        this._index = new Map(this.blocks.map((b) => [b.id, b]));
    }

    /** True while a change waits for flush(). */
    get dirty() { return this._full || this._dirtyFrom < this.blocks.length || !!this._truncate; }

    /**
     * Lay out what changed: from the first dirty block to the end (a full pass from row 0 after a
     * prepend, a replace-all, or once the dead slots outnumber the live), and upload just those
     * slots. Then re-apply the view. Idempotent.
     * @returns {{laidRows:number, laidSlots:number, uploaded:number, full:boolean}}
     */
    flush() {
        if (!this.dirty) { this._applyView(); return { laidRows: 0, laidSlots: 0, uploaded: 0, full: false }; }
        const live = this._slots.count - this._deadSlots;
        const full = this._full;
        let from = full ? 0 : Math.min(this._dirtyFrom, this.blocks.length);
        let compacted = false;
        if (full) { this._deadSlots = 0; this._rowBase = 0; }
        else if (this._deadSlots > 0 && this._deadSlots > live * this.cfg.compactRatio) { this._compact(); compacted = true; }
        const prev = from > 0 ? this.blocks[from - 1] : null;
        const slot = prev ? prev.slotN : this._deadSlots;
        let row = prev ? prev.row0 + prev.rows.length : this._rowBase;
        const slots = this._slots;
        slots.count = slot;
        let laidRows = 0;
        for (let i = from; i < this.blocks.length; i++) {
            const b = this.blocks[i];
            b.row0 = row;
            b.slot0 = slots.count;
            for (const r of b.rows) { this._layRow(slots, this._sizesFor(slots.count, r), r, row, false); row++; laidRows++; }
            b.slotN = slots.count;
        }
        this._rowEnd = row;
        const sent = compacted ? 0 : slot;   // a compaction moved every live slot: the whole tail goes up
        const uploaded = this.bodyField.writeTail(slots, sent, slots.count);
        this.bodyField.setLayoutExtent(this._bodyExtent, full || compacted ? 0 : slot);
        this._full = false;
        this._truncate = false;
        this._dirtyFrom = this.blocks.length;
        const st = this.stats;
        st.flushes++; if (full) st.fullPasses++; if (compacted) st.compactions = (st.compactions || 0) + 1;
        st.laidRows += laidRows; st.laidSlots += slots.count - slot; st.uploadedSlots += uploaded;
        this._applyView();
        return { laidRows, laidSlots: slots.count - slot, uploaded, full };
    }

    /**
     * Drop the dead slots: the live ones MOVE down to slot 0 (a memmove, not a layout) and their
     * rows renumber from 0 — each slot's y recomputed from its row, exactly as a fresh layout
     * writes it. The blocks' slot and row marks shift with them. @private
     */
    _compact() {
        const d = this._deadSlots, rb = this._rowBase, slots = this._slots, n = slots.count;
        const f32 = slots.f32, ls = this.metrics.lineSpacing, y0 = this._bodyY;
        f32.copyWithin(0, d * SLOT_FLOATS, n * SLOT_FLOATS);
        this._sizes.copyWithin(0, d * 2, n * 2);
        for (let k = 0, m = n - d; k < m; k++) {
            const o = k * SLOT_FLOATS + LANE_POS_Y;
            const r = Math.round((y0 - f32[o]) / ls);
            f32[o] = y0 - (r - rb) * ls;
        }
        slots.count = n - d;
        for (const b of this.blocks) { b.slot0 -= d; b.slotN -= d; b.row0 -= rb; }
        if (this._rowEnd != null) this._rowEnd -= rb;
        this._deadSlots = 0;
        this._rowBase = 0;
    }

    /** A sizes table that holds `n` more slots past `at` (generateLayout fills it; grown by doubling). @private */
    _sizesFor(at, row) {
        let need = 0;
        for (const s of row.segs) need += s.text.length;
        need = (at + need + 1) * 2;
        if (this._sizes.length < need) {
            const g = new Float32Array(Math.max(need, this._sizes.length * 2));
            g.set(this._sizes);
            this._sizes = g;
        }
        return this._sizes;
    }

    /** Lay one row's glyphs at the end of `slots`. @private */
    _layRow(slots, sizes, row, r, title) {
        const segs = row.segs || [];
        let text = '';
        const spans = [];
        let cp = 0;
        for (const s of segs) {
            const n = Array.from(s.text).length;
            if (!n) continue;
            spans.push({ start: cp, end: cp + n, color: packOf(s.color) });
            text += s.text;
            cp += n;
        }
        if (!text) return;
        this._ensureEncoded(text);
        const m = this.metrics;
        const y = title ? 0 : this._bodyY - r * m.lineSpacing;
        const res = generateLayout([text], {
            shaper: this._shaper, metrics: m,
            origin: { x: (row.indent || 0) * m.charWidth, y, z: 0 },
            wrapWidth: 0, zWrapSpacing: 0, tabWidth: this.cfg.tabWidth,
            spans, targetBuffer: slots, targetSizes: sizes ?? undefined, append: true,
        });
        if (sizes && res.sizes !== sizes) this._sizes = res.sizes;
    }

    /** Encode never-seen codepoints' curves into the live atlas (CodeGrid's rule). @private */
    _ensureEncoded(text) {
        const atlas = this.atlas, live = atlas?._live;
        if (!live || !this._shaper) return;
        const seen = (atlas._seenCodepoints ??= new Set());
        let fresh = null;
        for (const ch of text) {
            const c = ch.codePointAt(0);
            if (c > 32 && !seen.has(c)) { seen.add(c); (fresh ??= []).push(c); }
        }
        if (fresh) live.ensureCodepoints(fresh, this._shaper);
    }

    // -- the view -------------------------------------------------------------------------------

    /** Rows the live document holds (after the last flush). */
    get totalRows() { return (this._rowEnd ?? this._rowBase) - this._rowBase; }

    /** The top row (absolute) the view stands on. @private */
    _topRow() {
        const base = this._rowBase, end = this._rowEnd ?? base;
        const last = Math.max(base, end - this.cfg.rows);
        if (this.following || !this._anchor) return last;
        const b = this._index.get(this._anchor.id);
        if (!b) return last;
        return Math.min(Math.max(base, b.row0 + this._anchor.row), last);
    }

    /** Push the view to the body's group 0: the offset brings the top row to the frame's top, the
     *  clip shows the frame's rows. A group-table write — no slot moves. @private */
    _applyView() {
        const top = this._topRow();
        const ls = this.metrics.lineSpacing, y0 = this._bodyY;
        this.bodyField.setGroupOffset(0, { x: 0, y: (top - 0) * ls, z: 0 });
        this.bodyField.setGroupClip(0, y0 - top * ls + ls / 2, y0 - (top + this.cfg.rows - 1) * ls - ls / 2, true);
        this._top = top;
    }

    /** The block + row at the frame's top (or `atRow` rows below it). */
    rowAt(atRow = 0) {
        const r = (this._top ?? this._topRow()) + Math.max(0, Math.floor(atRow));
        for (const b of this.blocks) if (r >= b.row0 && r < b.row0 + b.rows.length) return { id: b.id, row: r - b.row0, block: b };
        return null;
    }

    /** The frame row under a point in this object's frame (−1 = the title row; null = outside the
     *  frame or past the document's end): `{id, row, block, frameRow}`. */
    rowAtLocal(x, y) {
        const m = this.metrics, top = this.pixelOrigin().y;
        if (x < 0 || x > this.cfg.cols * m.charWidth) return null;
        const k = Math.floor((top - y) / m.lineSpacing) - 1 - Math.max(0, this.cfg.titleGap);
        if (k < 0 || k >= this.cfg.rows) return k < 0 && top - y >= 0 && top - y < m.lineSpacing ? { id: null, row: -1, block: null, frameRow: -1 } : null;
        const hit = this.rowAt(k);
        return hit ? { ...hit, frameRow: k } : null;
    }

    /** The rows the frame shows, as text (top first) — what a reader sees. */
    visibleText() {
        const out = [];
        for (let k = 0; k < this.cfg.rows; k++) {
            const hit = this.rowAt(k);
            if (!hit) break;
            const row = hit.block.rows[hit.row];
            out.push(' '.repeat(row.indent || 0) + row.segs.map((s) => s.text).join(''));
        }
        return out;
    }

    /** Scroll by `delta` rows (− up, + down). Reaching the end resumes following; anything else
     *  holds, anchored to the block it shows. @returns {{top:number, following:boolean, atStart:boolean}} */
    scrollBy(delta) {
        const base = this._rowBase, last = Math.max(base, (this._rowEnd ?? base) - this.cfg.rows);
        const want = (this._top ?? this._topRow()) + Math.round(Number(delta) || 0);
        const top = Math.min(Math.max(base, want), last);
        this.following = top >= last;
        if (!this.following) {
            const hit = this._locate(top);
            this._anchor = hit ? { id: hit.id, row: hit.row } : null;
        } else this._anchor = null;
        this.stats.scrolls++;
        this._applyView();
        return { top: top - base, following: this.following, atStart: top <= base && want < base + 1 };
    }

    /** Ride the end again. */
    follow() { this.following = true; this._anchor = null; this._applyView(); return this; }

    /** @private the block holding absolute row r */
    _locate(r) {
        for (const b of this.blocks) if (r >= b.row0 && r < b.row0 + b.rows.length) return { id: b.id, row: r - b.row0 };
        return null;
    }

    /** The view to save: following, or the anchored top `{id, row}`. */
    view() {
        if (this.following) return { following: true };
        const hit = this._anchor ?? this._locate(this._top ?? this._topRow());
        return hit ? { following: false, id: hit.id, row: hit.row } : { following: true };
    }

    /** Stand on a saved view — the anchor's block must be in the document (false otherwise). */
    setView(v) {
        if (!v || v.following) { this.follow(); return true; }
        if (!this._index.has(v.id)) return false;
        this.following = false;
        this._anchor = { id: v.id, row: Math.max(0, Math.floor(v.row) || 0) };
        this._applyView();
        return true;
    }

    /** Free the fields and the backdrop (the caller unregisters what it registered). */
    dispose() {
        for (const f of [this.titleField, this.bodyField]) { this.remove(f.instanceMesh); f.dispose(); }
        this.remove(this._background);
        this._background.geometry?.dispose?.();
        this._panel?.dispose?.();
        this.blocks = [];
        this._index.clear();
    }
}

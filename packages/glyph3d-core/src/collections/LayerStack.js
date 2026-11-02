/**
 * LayerStack — DEPTH AS TIME for one member: its past (and proposals for its future) as pages
 * standing behind and in front of it, registered on its own cell grid.
 *
 * A member (a code grid, an agent book's scroll document, a terminal) states its cell grid — the
 * `frame`: its metrics, the y of its row 0's cell center, its columns and rows. The stack is a
 * child of the member's text frame (it rides every transform), and each LAYER is a page of rows
 * (`{segs, indent}` runs, the ScrollDocument row shape) laid by the same rule (layRow), so row r of
 * any page has its cell center at exactly the member's row-r y — f32-equal, by construction.
 *
 *   history  — rank 1, 2, … (newest first) at z = −rank·pitch BEHIND the member, each raised
 *              `riseRows` rows per rank so its top row shows over the page in front (the deck's
 *              rise: in a plane, one headline row each) — counted from the member's frame top
 *              INCLUDING its title band (`riseFrom: 'title'`; the band rounded up to whole rows), so
 *              page 1's top row clears the title; `riseRows` 0 stacks them registered.
 *   suggest  — a strip starting at member row `row0`, at z = +k·pitch IN FRONT, exactly over the
 *              lines it would replace (no rise) — tracing paper.
 *   now      — the member itself. Its page is a BACKING only: an opaque panel just behind the
 *              member, so what stands behind never shows through a translucent member (the member
 *              reads the same whatever the stack holds, and whatever the fan does).
 *
 * The FAN (setFan) slides each history page sideways by its rank × n device px — the page rigidly,
 * nothing at the member's own depth — the orthographic plane endpoint's depth-as-time spread.
 *
 * Every page carries an opaque backing (`backOpacity`, default 1) exactly the member's frame width
 * (`frame.cols`; the page's glyphs clip to those columns, as the member shows them — nothing is
 * dropped) and the member's rows or its own, whichever is more — overlapping pages stay legible
 * and never run under a neighbouring member. front(id) brings a layer
 * to z = 0 EXACTLY: the page stands registered on the member's text plane, the member's own glyph
 * meshes (`frame.text`) hide while it does, and the page's backing sits between the member's
 * backdrop and that plane — so a fronted page reads as pixel-exact as the member; front(null)
 * shows the member again and returns every layer to its rank. Nothing here reads the viewport.
 */

import * as THREE from 'three';
import InstancedField from './InstancedField.js';
import { layRow } from './ScrollDocument.js';
import { createBackgroundMesh } from './grid/index.js';
import { LAYER_BAND, getBandDistance } from '../core/layerBands.js';
import { DEFAULT_LAYOUT } from '../workers/builders/index.js';
/** @import GlyphAtlas from '../GlyphAtlas.js' */
/** @import { ScrollRow } from './ScrollDocument.js' */

/**
 * @typedef {Object} LayerFrame the member's cell grid, in the stack's (= the member text frame's) units
 * @property {{charWidth:number, charHeight:number, lineSpacing:number, emWorld:number, letterSpacing?:number}} metrics
 * @property {number} originY  row 0's cell-center y
 * @property {number} [originX] row glyphs start here (+ indent cells)
 * @property {number} cols     the member's width in cells (every page's backing — and glyph clip — width)
 * @property {number} rows     the member's height in rows (its backing's)
 * @property {number} [titleHeight] the member's band above its first text row's top (its title, its
 *           backdrop's margin) — a history page's rise clears it (`riseFrom: 'title'`); 0 when absent
 * @property {number} [tabWidth]
 * @property {THREE.Object3D[]} [text] the member's glyph meshes a fronted page REPLACES (hidden while
 *           one is fronted — the page stands at exactly z = 0 in their place)
 */

/**
 * @typedef {Object} Layer
 * @property {string} id
 * @property {string} [label]
 * @property {'history'|'suggest'} kind
 * @property {ScrollRow[]} rows
 * @property {number} [row0]  a suggest strip's first member row (history pages start at row 0)
 */

/**
 * A member's cell grid as a LayerFrame (duck-typed): a ScrollDocument's body (rows below its title
 * row), a TerminalGrid's screen (row 0 at y = 0), else a CodeGrid's text (row 0 at its layout
 * origin, moved by its scroll offset). The stack is parented to the returned `parent`.
 * @param {Object} member @returns {{frame: LayerFrame, parent: THREE.Object3D}}
 */
export function layerFrameOf(member) {
    if (member?.bodyField && member.cfg?.cols) {                       // a ScrollDocument (an agent book's scroll)
        return { parent: member, frame: { metrics: member.metrics, originY: member._bodyY, cols: member.cfg.cols, rows: member.cfg.rows, tabWidth: member.cfg.tabWidth,
            titleHeight: titleBandOf(member, member._bodyY), text: [member.bodyField.instanceMesh] } };
    }
    if (member?.scrollDoc && member.form === 'scroll') return layerFrameOf(member.scrollDoc);   // a Book in its scroll form
    const m = member?.metrics;
    if (!m) throw new Error(`[LayerStack] ${member?.name ?? member}: no cell grid (metrics) to register layers on`);
    if (Number.isFinite(member.cols) && Number.isFinite(member.rows) && typeof member.getLayout !== 'function') {   // a TerminalGrid
        return { parent: member, frame: { metrics: m, originY: 0, cols: member.cols, rows: member.rows, titleHeight: titleBandOf(member, 0), text: member._renderer ? [member._renderer.instanceMesh] : [] } };
    }
    const ls = m.lineSpacing;                                            // a CodeGrid
    const lp = member.getLayout?.() ?? {};
    return {
        parent: member,
        frame: {
            metrics: m, originY: (member._layoutOriginY ?? 0) + (member.getScrollOffset?.() || 0) * ls,
            cols: codeGridCols(member, m),
            rows: Math.max(1, member.getFrameRows?.() || member.getTotalVisualRows?.() || 1),
            tabWidth: lp.tabWidth ?? DEFAULT_LAYOUT.tabWidth,
            titleHeight: titleBandOf(member, member._layoutOriginY ?? 0),
            text: member._renderer ? [member._renderer.instanceMesh] : [],
        },
    };
}

/**
 * A code grid's width in CELLS, as it lays its text out: its text extent (pens + advances — a tab to
 * its stop, a wide glyph two cells; the filename row excluded) over the cell width; before it has
 * laid out, its widest line in characters.
 * @param {Object} grid @param {{charWidth:number}} m @returns {number}
 */
function codeGridCols(grid, m) {
    const ext = grid._arrangedExtent ?? grid._layout?.extent?.() ?? null;
    const w = ext ? ext.max.x - Math.min(0, ext.min.x) : NaN;
    return Math.max(1, Number.isFinite(w) && w > 0 ? Math.ceil(w / m.charWidth - 1e-6) : (grid.getMaxLineWidth?.() || 0));
}

/**
 * The band above a member's first text row: from its own frame top (its local bounds — title row,
 * backdrop margin and all) down to that row's top edge (`row0Y` its cell center, the WINDOW's first
 * row — a scrolled grid's too). 0 when the member states no bounds.
 * @param {Object} member @param {number} row0Y @returns {number}
 */
function titleBandOf(member, row0Y) {
    const top = member.getLocalBounds?.()?.max?.y;
    return Number.isFinite(top) ? Math.max(0, top - (row0Y + member.metrics.lineSpacing / 2)) : 0;
}

/**
 * A text's rows as a code grid lays them: each source line, split every `wrapWidth` codepoints
 * when it wraps (the grid's slot wrap; 0 = its own lines), in one colour. `lineStartRow[i]` is
 * line i's first row — where a strip replacing line i registers. Pure.
 * @param {string} text @param {{wrapWidth?:number, color?:{r:number,g:number,b:number}}} [o]
 * @returns {{rows: import('./ScrollDocument.js').ScrollRow[], lineStartRow: number[]}}
 */
export function textRows(text, { wrapWidth = 0, color = { r: 0.8, g: 0.82, b: 0.86 } } = {}) {
    const rows = [], lineStartRow = [];
    const w = Math.max(0, Math.floor(wrapWidth) || 0);
    for (const line of String(text ?? '').split('\n')) {
        lineStartRow.push(rows.length);
        const cps = Array.from(line);
        if (!w || cps.length <= w) { rows.push({ segs: line ? [{ text: line, color }] : [] }); continue; }
        for (let i = 0; i < cps.length; i += w) rows.push({ segs: [{ text: cps.slice(i, i + w).join(''), color }] });
    }
    return { rows, lineStartRow };
}

/** Defaults — every one a constructor option. */
export const LAYER_STACK_DEFAULTS = Object.freeze({
    pitchRows: 1,          // depth between layers, in member row heights
    riseRows: 1,           // how far each history layer stands above the one in front, in rows (0 = registered)
    riseFrom: 'title',     // 'title': the rise counts from the member's frame top INCLUDING its title band (page 1's top row clears it); 'text': from its first text row
    backColor: 0x0a0a1e,   // every page's backing
    backOpacity: 1,        // opaque: overlaps stay legible
    padCells: 0.5,         // a backing's margin around its rows, in cells
    nowBack: true,         // the opaque backing right behind the member
    clipToFrame: false,    // history pages show only the member's frame rows (a scroll document's window)
});

export default class LayerStack extends THREE.Object3D {
    /**
     * @param {GlyphAtlas} atlas @param {LayerFrame} frame @param {Partial<typeof LAYER_STACK_DEFAULTS>} [opts]
     */
    constructor(atlas, frame, opts = {}) {
        super();
        this.name = 'layer-stack';
        this.atlas = atlas;
        this.cfg = { ...LAYER_STACK_DEFAULTS, ...opts };
        if (this.cfg.riseFrom !== 'title' && this.cfg.riseFrom !== 'text') throw new Error(`[LayerStack] riseFrom is 'title' or 'text' (got ${JSON.stringify(this.cfg.riseFrom)})`);
        this._shaper = atlas?._shapeCache || atlas?._shaper || null;
        this.setFrame(frame);
        /** @type {Array<Layer & {group:THREE.Group, field:InstancedField|null, back:THREE.Mesh, panel:Object, rank:number}>} the layer pages (not Object3D.layers — three's camera masks) */
        this.pages = [];
        /** @type {string|null} the layer brought to z = 0 */
        this.frontId = null;
        /** The fan's slide per rank, in the stack's units (setFan); 0 = folded. */
        this._fanDx = 0;
        this._now = null;
        this._layNow();
    }

    /** The member's cell grid (re-stating it re-places every page). @param {LayerFrame} frame */
    setFrame(frame) {
        const m = frame?.metrics;
        if (!m || !(m.charWidth > 0) || !(m.lineSpacing > 0)) throw new Error(`[LayerStack] a frame needs cell metrics (got ${JSON.stringify(m)})`);
        this.frame = { originX: 0, tabWidth: DEFAULT_LAYOUT.tabWidth, ...frame };
        if (this.pages) { for (const l of this.pages) this._backFit(l); this._place(); this._layNow(); }
        return this;
    }

    /** Row r's cell-center y in the member's grid. */
    rowY(r) { return this.frame.originY - r * this.frame.metrics.lineSpacing; }

    /**
     * Replace the layers: history newest first (rank 1 nearest), suggest strips in the order given
     * (the first nearest the member). A fronted layer that's gone returns the stack to `now`.
     * @param {Layer[]} list
     */
    setLayers(list) {
        for (const l of this.pages) this._drop(l);
        this.pages = [];
        let h = 0, s = 0;
        for (const spec of list) {
            if (spec.kind !== 'history' && spec.kind !== 'suggest') throw new Error(`[LayerStack] layer ${spec.id}: kind is history|suggest (got ${spec.kind})`);
            const rank = spec.kind === 'history' ? ++h : -(++s);
            this.pages.push(this._build({ ...spec, row0: spec.kind === 'suggest' ? Math.max(0, Math.floor(spec.row0 || 0)) : 0 }, rank));
        }
        if (this.frontId && !this.pages.some((l) => l.id === this.frontId)) { this.frontId = null; this._showText(true); }
        this._place();
        return this;
    }

    /** Bring a layer to z = 0 (registered, in front of the member); null = the member itself. */
    front(id) {
        if (id != null && !this.pages.some((l) => l.id === id)) return false;
        this.frontId = id ?? null;
        this._showText(this.frontId === null);
        this._place();
        return true;
    }

    /** The member's glyph meshes shown (no page fronted) or hidden (one stands in their place). @private */
    _showText(show) {
        for (const m of this.frame.text ?? []) {
            if (!show) { if (!this._hidden?.has(m)) { (this._hidden ??= new Map()).set(m, m.visible); m.visible = false; } }
            else if (this._hidden?.has(m)) { m.visible = this._hidden.get(m); this._hidden.delete(m); }
        }
    }

    /** Where every layer stands: `{id, label, kind, rank, y, z, front}` — the member is `now` at rank 0. */
    order() {
        return [
            { id: 'now', label: 'now', kind: 'now', rank: 0, y: 0, z: 0, front: this.frontId === null },
            ...this.pages.map((l) => ({ id: l.id, label: l.label ?? l.id, kind: l.kind, rank: l.rank,
                y: l.group.position.y, z: l.group.position.z, front: l.id === this.frontId })),
        ].sort((a, b) => b.z - a.z);
    }

    /** One layer's page (its glyph field, backing, group) — tests and verbs read it. */
    layer(id) { return this.pages.find((l) => l.id === id) ?? null; }

    /** Build one page. @private */
    _build(spec, rank) {
        const group = new THREE.Group();
        group.name = `layer:${spec.id}`;
        let count = 0;
        for (const r of spec.rows) for (const s of r.segs || []) count += s.text.length;
        const field = count ? new InstancedField(null, this.atlas, { worldScale: this.frame.metrics.worldScale, defaultColor: { r: 1, g: 1, b: 1 }, maxInstances: Math.max(256, count) }) : null;
        if (field) {
            const slots = field.slotBuffer;
            slots.clear();
            spec.rows.forEach((row, j) => layRow(slots, row, {
                atlas: this.atlas, shaper: this._shaper, metrics: this.frame.metrics,
                y: this.rowY(spec.row0 + j), tabWidth: this.frame.tabWidth,
            }));
            if (this.frame.originX) for (let k = 0; k < slots.count; k++) slots.f32[k * 8] += this.frame.originX;
            field.writeTail(slots, 0, slots.count);
            // The member's columns, as it shows them: glyphs past them are cut by the shader, never dropped.
            field.setGroupClipX(0, this.frame.originX, this.frame.originX + this.frame.cols * this.frame.metrics.charWidth, true);
            const clip = this.cfg.clipToFrame && spec.kind === 'history';
            if (clip) {
                const ls = this.frame.metrics.lineSpacing;
                field.setGroupClip(0, this.rowY(0) + ls / 2, this.rowY(this.frame.rows - 1) - ls / 2, true);
            }
            // State the page's extent (three can't compute an instanced field's — it sees the base
            // quad): what it culls by, and the row height the far-LOD pass measures. Unstated, the
            // page is culled away and read as a field too small to draw.
            const fm = this.frame.metrics, cols = Math.min(this.frame.cols, Math.max(1, ...spec.rows.map((r) => (r.indent || 0) + (r.segs || []).reduce((n, g) => n + Array.from(g.text).length, 0))));
            const last = spec.row0 + (clip ? Math.min(spec.rows.length, this.frame.rows) : spec.rows.length) - 1;
            field.setLayoutExtent({
                min: { x: this.frame.originX, y: this.rowY(Math.max(spec.row0, last)) - fm.charHeight / 2, z: 0 },
                max: { x: this.frame.originX + cols * fm.charWidth, y: this.rowY(spec.row0) + fm.charHeight / 2, z: 0 },
            });
            group.add(field.instanceMesh);
        }
        const bg = createBackgroundMesh({ backgroundColor: this.cfg.backColor, backgroundOpacity: this.cfg.backOpacity, showBackground: true },
            getBandDistance(LAYER_BAND.GRID_BACKGROUND));
        group.add(bg.mesh);
        const l = { ...spec, rank, group, field, back: bg.mesh, panel: bg.panel };
        this._backFit(l);
        this.add(group);
        return l;
    }

    /** Size a page's backing: exactly the member's width; its rows, at least the member's (a strip: its rows only). @private */
    _backFit(l) {
        const f = this.frame, m = f.metrics, pad = this.cfg.padCells * m.charWidth;
        const strip = l.kind === 'suggest';
        // A rising page's backing starts AT its top row (no margin above): the page behind's headline
        // row, one rise up, is never nipped. The member's own (`now`) reaches up through its title band
        // to the whole-row line page 1's headline sits on — what falls in the band stays behind it.
        const top = this.rowY(l.row0) + m.charHeight / 2 + (l.kind === 'now' ? this._liftRows(0) * m.lineSpacing : 0);
        const padTop = strip || !(this.cfg.riseRows > 0) ? pad : 0;
        const rows = strip ? l.rows.length : (this.cfg.clipToFrame ? f.rows : Math.max(l.rows.length, f.rows));
        const w = Math.max(1, f.cols) * m.charWidth;
        const h = Math.max(rows, 1) * m.lineSpacing + (l.kind === 'now' ? this._liftRows(0) * m.lineSpacing : 0);
        const bg = l.back;
        bg.scale.set(w + 2 * pad, h + padTop + pad, 1);
        bg.position.set(f.originX + w / 2, top + (padTop - h - pad) / 2, bg.position.z);
    }

    /** The opaque backing right behind the member (the `now` page). @private */
    _layNow() {
        if (!this.cfg.nowBack) return;
        if (!this._now) {
            this._now = { kind: 'now', rows: [], row0: 0, back: null, panel: null };
            const bg = createBackgroundMesh({ backgroundColor: this.cfg.backColor, backgroundOpacity: this.cfg.backOpacity, showBackground: true },
                getBandDistance(LAYER_BAND.GRID_BACKGROUND));
            this._now.back = bg.mesh; this._now.panel = bg.panel;
            bg.mesh.name = 'layer:now:back';
            this.add(bg.mesh);
        }
        this._backFit(this._now);
        // Just behind the member's own backdrop (its band) — in front of every history page.
        this._now.back.position.z = -2 * getBandDistance(LAYER_BAND.GRID_BACKGROUND);
    }

    /**
     * The depth between pages, in the stack's own units: `pitchRows` rows, floored at 3·bg — a
     * page's backing stands `bg` behind its text, so a smaller pitch would put a history page's text
     * in front of the `now` backing (2·bg back); the floor keeps the order whatever the knob.
     * @returns {number}
     */
    pitch() {
        return Math.max(this.cfg.pitchRows * this.frame.metrics.lineSpacing, 3 * getBandDistance(LAYER_BAND.GRID_BACKGROUND));
    }

    /**
     * The FAN: each history page behind the member slides `px` device px per rank to the right
     * (rank i by i·px), rigidly — its text and its backing together — while the member, its
     * backing, its backdrop and the suggest strips in front stay where they are. `pxPerUnit` is the
     * plane's device px per WORLD unit (the plane view's scale), so the slide is i·px device px on
     * the orthographic endpoint, whole px when px is whole, whatever the stack's scale or pitch.
     * px 0 folds the pages back. A fronted page stays at z = 0, unslid.
     * @param {number} px @param {number|null} pxPerUnit (needed unless px is 0)
     */
    setFan(px, pxPerUnit) {
        if (!Number.isFinite(px)) throw new Error(`[LayerStack] setFan: px must be finite (got ${px})`);
        let dx = 0;
        if (px !== 0) {
            if (!(pxPerUnit > 0)) throw new Error(`[LayerStack] setFan: pxPerUnit must be > 0 (got ${pxPerUnit})`);
            this.updateWorldMatrix(true, false);
            const sx = Math.abs(this.getWorldScale(new THREE.Vector3()).x);
            if (!(sx > 0)) throw new Error(`[LayerStack] setFan: the stack has no world x scale (${sx})`);
            dx = px / pxPerUnit / sx;
        }
        if (dx === this._fanDx) return this;
        this._fanDx = dx;
        this._place();
        return this;
    }

    /**
     * How far history page `rank` stands above the member, in the stack's units: `rank · riseRows`
     * rows — plus, counted from the member's frame top (`riseFrom: 'title'`), its title band rounded
     * up to whole rows, so page 1's top row shows ABOVE the title. Whole rows keep every page on the
     * plane's cell grid. `riseRows` 0: registered (no lift). @param {number} rank @returns {number}
     */
    riseOf(rank) {
        return rank > 0 ? this._liftRows(rank) * this.frame.metrics.lineSpacing : 0;
    }

    /** Rows history page `rank` stands up (rank 0: the title band alone — where the `now` backing reaches); 0 unrisen. @private */
    _liftRows(rank) {
        const rise = this.cfg.riseRows;
        if (!(rise > 0)) return 0;
        const band = this.cfg.riseFrom === 'title' ? Math.ceil((this.frame.titleHeight || 0) / this.frame.metrics.lineSpacing - 1e-6) : 0;
        return band + rank * rise;
    }

    /** Pose every page by its rank (or as the fronted one). @private */
    _place() {
        const bg = getBandDistance(LAYER_BAND.GRID_BACKGROUND);
        const pitch = this.pitch();
        for (const l of this.pages) {
            // Fronted: its text on the member's plane (z = 0, the member's glyphs hidden), its backing
            // half the backdrop gap behind — in front of the member's backdrop, behind the text.
            l.back.position.z = l.id === this.frontId ? -bg / 2 : -bg;
            if (l.id === this.frontId) { l.group.position.set(0, 0, 0); continue; }
            if (l.rank > 0) l.group.position.set(l.rank * this._fanDx, this.riseOf(l.rank), -l.rank * pitch);
            else l.group.position.set(0, 0, -l.rank * pitch);
        }
    }

    /** @private */
    _drop(l) {
        this.remove(l.group);
        if (l.field) { l.group.remove(l.field.instanceMesh); l.field.dispose(); }
        l.back.geometry?.dispose?.();
        l.panel?.dispose?.();
    }

    /** Free every page (the member stays). */
    dispose() {
        this._showText(true);
        for (const l of this.pages) this._drop(l);
        this.pages = [];
        if (this._now) { this.remove(this._now.back); this._now.back.geometry?.dispose?.(); this._now.panel?.dispose?.(); this._now = null; }
    }
}

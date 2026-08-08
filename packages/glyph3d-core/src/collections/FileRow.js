/**
 * FileRow — a file's DATA presence in the field: the load unit of the
 * rows-not-actors architecture (docs/perf-swarm/landing-plan.md, move 1).
 *
 * A bulk load pours FileRows, not CodeGrids. A row is a real THREE.Object3D —
 * it lives in the ContentTree exactly where the CodeGrid leaf lives, its
 * matrixWorld poses its mega-field views through the existing pose sweep, and
 * the scene graph stays the scene graph — but it owns NO interaction machinery:
 * no edit state, no caret, no scroll/frame conveyor, no ScaleModel, no unique
 * GPU material. What it has:
 *
 *   - the file's bytes staged as an arena item + a mega-field VIEW (glyphs),
 *   - a second item + view for the filename label (same shape as CodeGrid's),
 *   - a measure served from the BAKED record (rows/widest exact before the GPU
 *     answers — MEASURES v3's "leaves declare intrinsic" made literal),
 *   - a panel mesh on SHARED geometry + a SHARED fill material (one per theme
 *     style app-wide, not one TSL compile per file),
 *   - the colorizer contract (content + _layout + getRenderer), so rows paint
 *     syntax eagerly like grids always did.
 *
 * The CodeGrid ACTOR materializes on first interaction (focus/edit/save/verbs)
 * — the command layer's materialize seam swaps it into this row's place. The
 * row answers everything the ITERATED surfaces read (bounds, names, counts,
 * pose, color/highlight writes); anything interactive belongs to the actor.
 *
 * Border flags (hover) ride ONE shared border-capable panel material: the app
 * hovers one row at a time, so a single instance swaps onto the hovered row's
 * mesh and back off. A second simultaneously-flagged row steals it — visually
 * a non-event under the one-hover invariant.
 */

import * as THREE from 'three';
import BoundedObject3D from './BoundedObject3D.js';
import { ensureMegaField } from '../MegaGlyphField.js';
import { loadStats } from '../core/loadStats.js';
import { RENDER_ORDER } from '../core/renderOrder.js';
import { BOUNDS_Z_PAD } from '../core/constants.js';
import { computeCellMetrics } from '../core/cellMetrics.js';
import { rowsUnderWrap, bakeFile } from '../compute/glyphBake.js';
import { windowSeedable, byteRangeForRows } from '../compute/glyphPipelineWindow.js';
import { resolveLayoutParams, DEFAULT_LAYOUT } from '../workers/builders/index.js';
import { getPipelineArena } from '../compute/GlyphLayoutCompute.js';
import ByteLayoutDescription, { buildByteLineIndex } from '../core/ByteLayoutDescription.js';
import { analyzeGrid } from '../parsing/SyntaxColorizer.js';
import { createPanelMaterial } from './panelMaterial.js';

const _textEncoder = new TextEncoder();

// ── Shared panel resources ──────────────────────────────────────────────────
// One unit-plane geometry for every row panel, and one plain fill material per
// distinct (color, opacity) style — the theme is uniform across a load, so this
// is one material app-wide instead of one TSL node-material compile per file.
let _sharedPanelGeometry = null;
const _sharedFills = new Map();   // `${color}|${opacity}` -> THREE.MeshBasicMaterial

function sharedPanelGeometry() {
    if (!_sharedPanelGeometry) _sharedPanelGeometry = new THREE.PlaneGeometry(1, 1);
    return _sharedPanelGeometry;
}

function sharedFillMaterial(color, opacity) {
    const key = `${color}|${opacity}`;
    let m = _sharedFills.get(key);
    if (!m) {
        m = new THREE.MeshBasicMaterial({
            color,
            opacity,
            transparent: opacity < 1,
            side: THREE.DoubleSide,
            depthWrite: true,
        });
        _sharedFills.set(key, m);
    }
    return m;
}

// The ONE border-capable panel (hover/flag feedback): a single createPanelMaterial
// instance whose mesh-of-residence is whichever row currently holds flags.
let _borderPanel = null;      // { handle, owner: FileRow|null }

function borderPanel() {
    if (!_borderPanel) {
        _borderPanel = { handle: null, owner: null };
    }
    return _borderPanel;
}

export default class FileRow extends BoundedObject3D {
    /**
     * @param {THREE.Scene} scene
     * @param {Object} atlas - the booted GlyphAtlas
     * @param {Object} options - the same theme bag CodeGrid takes (gridTheme());
     *   the row reads the subset it renders with.
     */
    constructor(scene, atlas, options = {}) {
        super();
        this.scene = scene;
        this.atlas = atlas;
        this.name = options.name || 'FileRow';
        this.isFileRow = true;

        this.config = {
            showBackground: options.showBackground !== false,
            backgroundColor: options.backgroundColor ?? 0x1a1a2e,
            backgroundOpacity: options.backgroundOpacity ?? 0.92,
            backgroundPadding: options.backgroundPadding || 1.0,
            showFilename: options.showFilename !== false,
            filenameColor: options.filenameColor || { r: 0.6, g: 0.8, b: 1.0 },
            textColor: options.textColor || { r: 0.0, g: 1.0, b: 0.0 },
            worldScale: options.worldScale || 0.025,
            layout: { ...DEFAULT_LAYOUT, ...(options.layout || {}) },
            // Windowed staging knobs — same semantics as CodeGrid's; a row never
            // scrolls, so a partial window is always rows [0, span + margin).
            windowMinBytes: options.windowMinBytes ?? 256 * 1024,
            windowRows: options.windowRows ?? 600,
            windowMarginRows: options.windowMarginRows ?? 200,
        };

        this.filename = '';
        this.sourcePath = null;
        this.content = '';

        // Same field mapping as CodeGrid._computeMetrics — the fold reads
        // lineHeight/spacing, cellMetrics speaks lineSpacing/letterSpacing.
        const cm = computeCellMetrics(atlas.getCharSize(), this.config.worldScale);
        this.metrics = { charWidth: cm.charWidth, charHeight: cm.charHeight, lineHeight: cm.lineSpacing, spacing: cm.letterSpacing };

        // Colorizer contract (SyntaxColorizer.analyzeGrid / runAnalyze).
        this._analyzeGen = 0;
        this._highlights = null;
        this._layout = null;

        // Staging state.
        this._bytes = null;
        this._byteLineIndex = null;
        this._bakedRecord = null;
        this._bakedProvenance = null;
        this._byteWindow = null;      // { from, to, startRow, endRow, totalRows, degenerate }
        this._layoutOriginY = 0;
        this._pipeline = null;
        this._filenamePipeline = null;
        this._renderer = null;        // content MegaFieldView
        this._filenameField = null;   // filename MegaFieldView
        this._pickingSystem = null;

        // Panel: shared geometry + shared fill material; sized from the measure.
        this._background = new THREE.Mesh(
            sharedPanelGeometry(),
            sharedFillMaterial(this.config.backgroundColor, this.config.backgroundOpacity),
        );
        this._background.renderOrder = RENDER_ORDER.GRID_BACKGROUND;
        this._background.visible = false;   // shown once measured
        this.add(this._background);

        this._borderFlags = 0;
        this._localBoundsCache = null;
        this._layoutBoundsCache = null;
    }

    // ── Load: bytes → record → window → arena item → view ───────────────────

    /**
     * Stage the file's bytes and filename into the arena and measure from the
     * record. Resolves when the row is staged + adopted (visible next flush) —
     * NOT gated on the GPU bounds readback: the measure comes from the record,
     * so the batch settle never waits per-row. `this.laid` carries the GPU
     * gate for callers that want it.
     * @param {string} path - full path (the filename label text, as CodeGrid)
     * @param {string} content
     * @param {{ baked?: Object }} [opts] - a disk-index record; absent → self-bake
     */
    async load(path, content, { baked } = {}) {
        this.filename = path;
        this.content = content;
        this._bytes = _textEncoder.encode(content);
        this._byteLineIndex = buildByteLineIndex(this._bytes);

        const arena = getPipelineArena();
        if (!arena || !arena.trie) {
            if (!FileRow._noArenaNoted) {
                FileRow._noArenaNoted = true;
                console.error('FileRow: no pipeline arena — the byte pipeline needs WebGPU; rows render EMPTY (boot log has the reason)');
            }
            return this;
        }

        const m = this.metrics;
        const lp = resolveLayoutParams(this.config.layout);

        // THE RECORD ALWAYS EXISTS — a disk record warm-starts, otherwise the row
        // folds its own (the same streaming pass CodeGrid runs).
        if (baked && baked.byteLength === this._bytes.length) {
            this._bakedRecord = baked;
            this._bakedProvenance = 'index';
        } else {
            const tBake = performance.now();
            this._bakedRecord = bakeFile(this._bytes, arena.trie, { lineHeight: m.lineHeight });
            this._bakedProvenance = 'self';
            const bakeMs = performance.now() - tBake;
            loadStats.selfBakes++;
            loadStats.selfBakeMs += bakeMs;
            if (bakeMs > 10) console.info(`[bake] ${this.filename}: self-baked in ${bakeMs.toFixed(1)}ms (${this._bakedRecord.totalRows} rows, ${this._bytes.length} bytes)`);
        }

        this._layoutOriginY = (this.config.showFilename && this.filename)
            ? -m.lineHeight * 1.5
            : 0;

        // Views (created once; load is called once per row).
        const mega = ensureMegaField(arena, {
            scene: this.scene, atlas: this.atlas,
            worldScale: this.config.worldScale,
            slugData: this.atlas?._slugData, shaper: this.atlas?._shaper,
            pickingSystem: this._pickingSystem,
        });
        if (!this._renderer) this._renderer = mega.createView({ node: this, color: this.config.textColor });

        if (this.content.length > 0) {
            this._byteWindow = this._resolveWindow(lp, arena);
            const w = this._byteWindow;
            const staged = arena.stage({
                bytes: this._bytes.subarray(w.from, w.to),
                origin: { x: 0, y: this._layoutOriginY, z: 0 },
                page: { scrollRows: 0 },
                wrapWidth: lp.wrapWidth || 0,
                lineHeight: m.lineHeight,
                zStep: m.charHeight * (lp.zWrapSpacing || 0),
                field: null,
            });
            this._pipeline = staged;

            // The filename: its own item + view at y=0 (wrap 0 — a label never folds).
            if (this.config.showFilename && this.filename) {
                if (!this._filenameField) {
                    this._filenameField = mega.createView({ node: this, color: this.config.filenameColor });
                }
                this._filenamePipeline = arena.stage({
                    bytes: _textEncoder.encode(this.filename),
                    origin: { x: 0, y: 0, z: 0 },
                    page: null,
                    wrapWidth: 0,
                    lineHeight: m.lineHeight,
                    zStep: 0,
                    field: this._filenameField,
                });
            }

            await arena.requestFlush();
            // The swap discipline (same as CodeGrid): adopt right after the flush
            // ENCODES — GPU submission order makes the slots valid for any frame
            // that can see the range; nothing waits on a readback to show glyphs.
            staged.adoptField(this._renderer, w.from);

            this._layout = new ByteLayoutDescription({
                bytes: this._bytes,
                lineByteStart: this._byteLineIndex.lineByteStart,
                lineLengths: this._byteLineIndex.lineLengths,
                pipeline: staged,
                scrollOffset: 0,
                sourceBase: w.from,
            });

            /** The GPU gate, NOT awaited by the load: rows measure from the record.
             *  Consumers that need laid bounds (the bake gate) chain here. */
            this.laid = staged.laid;
            this._armBakeGate(lp);

            // Eager colorize — parity with the grid era (CF-k's worker-pool lane
            // moves this off-thread; the row already speaks that contract).
            this._analyzeGen++;
            analyzeGrid(this);
        }

        this._updateBackground();
        return this;
    }

    /**
     * The row's staged window — CodeGrid._resolveWindow with scroll pinned 0
     * and no frame: a large seedable unpaged file stages rows [0, span+margin),
     * everything else the DEGENERATE whole file.
     * @private
     */
    _resolveWindow(lp, arena) {
        const rec = this._bakedRecord;
        const wrap = Math.max(0, Math.trunc(lp.wrapWidth || 0));
        const totalRows = rec ? rowsUnderWrap(rec, wrap) : 0;
        const whole = {
            from: 0, to: this._bytes.length,
            startRow: 0, endRow: totalRows, totalRows, degenerate: true,
        };
        const cfg = this.config;
        if (!rec || !(cfg.windowMinBytes > 0) || this._bytes.length < cfg.windowMinBytes) return whole;
        if (Math.trunc(lp.pageHeight || 0) > 0) return whole;
        if (!windowSeedable(rec, wrap)) return whole;
        if (!arena?.trie) return whole;
        const r1 = Math.min(totalRows, cfg.windowRows + cfg.windowMarginRows);
        if (r1 >= totalRows) return whole;
        const w = byteRangeForRows(this._bytes, arena.trie, rec, 0, r1, wrap);
        if (!w || (w.from === 0 && w.to >= this._bytes.length)) return whole;
        return { from: w.from, to: w.to, startRow: 0, endRow: r1, totalRows, degenerate: false };
    }

    /** The bake gate as a fire-and-forget chain on `laid` — loud, never blocking. @private */
    _armBakeGate(lp) {
        const rec = this._bakedRecord;
        const pipeline = this._pipeline;
        if (!rec || !pipeline?.laid) return;
        pipeline.laid.then(() => {
            const got = pipeline.bounds;
            if (!got || pipeline !== this._pipeline) return;
            const wrap = Math.max(0, Math.trunc(lp.wrapWidth || 0));
            const w = this._byteWindow;
            const wantRows = w.endRow - w.startRow;
            if (Math.round(got.totalRows) !== wantRows) {
                console.warn(`[bake] ${this.filename}: baked rows(wrap ${wrap}) = ${wantRows} ≠ GPU ${got.totalRows} — stale record or fold drift`);
            }
        }).catch(() => { /* device loss resolves laid; nothing to gate */ });
    }

    // ── Measure: the record IS the measure ──────────────────────────────────

    /**
     * The row's content extent from the baked record — rows exact under any
     * wrap (the line histogram), width exact when nothing folds. Same math as
     * CodeGrid._bakedPriorExtent; for a row it is not a prior, it is THE measure.
     *
     * CACHED: a row's record, metrics and layout are immutable after load()
     * (anything that would change them materializes the actor first), while
     * the per-frame iterators (occlusion culler, minimap, camera soft-bounds)
     * call getBounds → here once per row per frame — the recompute was a
     * resolveLayoutParams + histogram walk × 1500 rows × 60Hz.
     * @private
     * @returns {{min:Object, max:Object, width:number, height:number, depth:number}|null}
     */
    _recordExtent() {
        if (this._extentCache !== undefined) return this._extentCache;
        const rec = this._bakedRecord;
        if (!rec || !(rec.leaders > 0) || this.content.length === 0) {
            // Null only becomes final once content is loaded; before that, stay uncached.
            if (this.content.length === 0) return null;
            this._extentCache = null;
            return null;
        }
        const m = this.metrics;
        const lp = resolveLayoutParams(this.config.layout);
        const wrap = Math.max(0, Math.trunc(lp.wrapWidth || 0));
        const rows = rowsUnderWrap(rec, wrap);
        const originY = this._layoutOriginY;
        const zStep = m.charHeight * (lp.zWrapSpacing || 0);
        const segs = wrap > 0 ? Math.max(1, Math.ceil(rec.maxLineLen / wrap)) : 1;
        const min = { x: 0, y: originY - (rows - 1) * m.lineHeight, z: -(segs - 1) * zStep };
        const max = { x: rec.maxLineWidth, y: originY + m.charHeight, z: 0 };
        this._extentCache = {
            min, max,
            width: max.x - min.x, height: max.y - min.y, depth: max.z - min.z,
        };
        return this._extentCache;
    }

    /** Plain-object content bounds (the CodeGrid-shaped accessor). */
    getContentBounds() { return this._recordExtent(); }

    /** Unpadded local box for layout containers (nodeUtils.leafBox). */
    layoutBounds() {
        const cb = this._recordExtent();
        if (!cb) return new THREE.Box3();
        if (!this._layoutBoundsCache) this._layoutBoundsCache = new THREE.Box3();
        this._layoutBoundsCache.min.set(cb.min.x, cb.min.y, cb.min.z);
        this._layoutBoundsCache.max.set(cb.max.x, cb.max.y, cb.max.z);
        return this._layoutBoundsCache;
    }

    /** Padded local box (panel padding + Z slab) — the world consumers' box. */
    getLocalBounds() {
        const cb = this._recordExtent();
        if (!this._localBoundsCache) this._localBoundsCache = new THREE.Box3();
        const box = this._localBoundsCache;
        if (!cb) { box.makeEmpty(); return box; }
        const padding = this.config.backgroundPadding;
        box.min.set(cb.min.x - padding, cb.min.y - padding, cb.min.z - BOUNDS_Z_PAD);
        box.max.set(cb.max.x + padding, cb.max.y + padding, cb.max.z + BOUNDS_Z_PAD);
        return box;
    }

    /** Size + place the shared-geometry panel from the measure. @private */
    _updateBackground() {
        const b = this._background;
        if (!this.config.showBackground) { b.visible = false; return; }
        const cb = this._recordExtent();
        if (!cb) { b.visible = false; return; }
        const padding = this.config.backgroundPadding;
        const width = cb.width + padding * 2;
        const height = cb.height + padding * 2;
        if (!(width > 0 && height > 0)) { b.visible = false; return; }
        b.scale.set(width, height, 1);
        b.position.set(
            cb.min.x + cb.width / 2,
            cb.min.y + cb.height / 2,
            (cb.min.z ?? 0) - 0.5,
        );
        b.visible = true;
    }

    // ── The data surface (what iterated consumers read) ─────────────────────

    getSourcePath() { return this.sourcePath || this.userData?.sourcePath || null; }
    setSourcePath(path) { this.sourcePath = path; }
    getFilename() { return this.filename; }
    getRenderer() { return this._renderer; }
    getLineCount() { return this._byteLineIndex ? this._byteLineIndex.lineByteStart.length : 0; }
    getGlyphCount() { return this._bakedRecord?.leaders ?? 0; }
    getCharForSlot(slot) { return this._layout?.charForSlot(slot) ?? null; }
    getTotalVisualRows() { return this._byteWindow?.totalRows ?? 0; }
    getHighlights() { return this._highlights; }
    update(_dt) { /* rows animate nothing */ }

    /** The picking wire: panel → 'grid' channel, mega-field → the one glyph channel. */
    setPickingSystem(ps) {
        if (!ps || this._pickingSystem === ps) return;
        this._pickingSystem = ps;
        if (this._background) ps.register('grid', this._background, this);
        const arena = getPipelineArena();
        arena?.megaField?.setPickingSystem?.(ps);
    }

    // ── Border flags: the one shared border material ─────────────────────────

    /**
     * Hover/flag feedback on a shared border-capable panel material — the app
     * flags one row at a time, so a single instance travels to the flagged
     * row's mesh. Lazy: the TSL material compiles on the first hover ever.
     */
    setBorderFlag(mask, on) {
        this._borderFlags = on ? (this._borderFlags | mask) : (this._borderFlags & ~mask);
        const bp = borderPanel();
        if (this._borderFlags !== 0) {
            if (!bp.handle) {
                bp.handle = createPanelMaterial({
                    color: this.config.backgroundColor,
                    opacity: this.config.backgroundOpacity,
                    side: THREE.DoubleSide,
                    depthWrite: true,
                });
            }
            if (bp.owner !== this) {
                if (bp.owner) bp.owner._dropBorderMaterial();
                bp.owner = this;
                bp.handle.setFill(this.config.backgroundColor, this.config.backgroundOpacity);
                this._background.material = bp.handle.material;
            }
            // Mirror this row's exact flag set onto the shared uniforms.
            bp.handle.setBorderFlag(~0, false);
            bp.handle.setBorderFlag(this._borderFlags, true);
        } else if (bp.owner === this) {
            bp.owner = null;
            this._dropBorderMaterial();
        }
    }

    /** @private */
    _dropBorderMaterial() {
        this._borderFlags = 0;
        this._background.material = sharedFillMaterial(this.config.backgroundColor, this.config.backgroundOpacity);
    }

    /** State colors land on the shared border material (idempotent across rows). */
    setStateColors(colors) {
        const bp = borderPanel();
        bp.stateColors = { ...(bp.stateColors || {}), ...(colors || {}) };
        bp.handle?.setStateColors(colors);
    }

    /** Border identity (color/width/intensity) — same shared-material seam. */
    setBorder(opts) {
        const bp = borderPanel();
        bp.borderStyle = { ...(bp.borderStyle || {}), ...(opts || {}) };
        bp.handle?.setBorder(opts);
    }

    /**
     * Theme restyle (settings fanout runs this per registered grid). The row's
     * config updates; the SHARED material for the new style is fetched/created,
     * so N rows converge on one material either way.
     */
    setBackgroundStyle({ color, opacity } = {}) {
        if (color != null) this.config.backgroundColor = color;
        if (opacity != null) this.config.backgroundOpacity = opacity;
        if (this._borderFlags === 0) {
            this._background.material = sharedFillMaterial(this.config.backgroundColor, this.config.backgroundOpacity);
        }
    }

    showBackground(visible) {
        this.config.showBackground = visible;
        this._updateBackground();
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    /**
     * Release the row's arena items + views + panel. Shared resources (geometry,
     * fill materials, the border material) stay — they are app-wide by design.
     */
    dispose() {
        const bp = borderPanel();
        if (bp.owner === this) bp.owner = null;
        // Release the 'grid'-channel pick registration — a disposed row's mesh left
        // registered keeps a dead entry in every pick pass and can win hover hits.
        if (this._pickingSystem && this._background) {
            this._pickingSystem.unregister?.('grid', this._background);
        }
        this._pipeline?.dispose?.();
        this._pipeline = null;
        this._filenamePipeline?.dispose?.();
        this._filenamePipeline = null;
        this._renderer?.dispose?.();
        this._renderer = null;
        this._filenameField?.dispose?.();
        this._filenameField = null;
        if (this._background) {
            this.remove(this._background);
            this._background = null;
        }
        this._layout = null;
        this._bytes = null;
        this._byteLineIndex = null;
        this.parent?.remove(this);
    }
}

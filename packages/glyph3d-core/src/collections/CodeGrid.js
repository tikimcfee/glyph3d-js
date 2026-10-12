/**
 * CodeGrid — a single source file represented in 3D space.
 *
 * Directly manages an InstancedField (WebGL2) renderer for high-performance
 * instanced glyph rendering, plus cursor and in-place text editing,
 * syntax highlighting, and windowed viewport layout.
 *
 * Part of the layered rendering architecture:
 * - GlyphAtlas -> CodeGrid -> GridLayoutManager
 */

import * as THREE from 'three';
import { loadStats } from '../core/loadStats.js';
import { RENDER_ORDER } from '../core/renderOrder.js';
import { LAYER_BAND, getBandDistance } from '../core/layerBands.js';
import { BOUNDS_Z_PAD } from '../core/constants.js';
import { computeCellMetrics } from '../core/cellMetrics.js';
import { resolveLayoutParams, DEFAULT_LAYOUT } from '../workers/builders/index.js';
import LayoutDescription from '../core/LayoutDescription.js';
import { SLOT_FLOATS, LANE_POS_X, LANE_POS_Y, LANE_POS_Z } from '../core/InstancedSlotBuffer.js';
import { generateLayout } from '../core/LayoutGenerator.js';
import InstancedField from './InstancedField.js';
import { analyzeGrid, buildGridSemantics, buildGridSemanticsSync } from '../parsing/SyntaxColorizer.js';
import { paletteLUT } from '../parsing/syntaxPaletteJob.js';
import FramedGlyphField from './FramedGlyphField.js';
import {
    cpToU16,
    cpLen,
    clampCursor,
    insertText,
    deleteBackward,
    deleteForward,
    splitLine,
    moveCursor,
    createCaretMesh,
    positionCaretMesh,
    clampWindow,
    sliceWindowText,
    computeMaxScroll,
    clampScroll,
    computeFrameClip,
    createBackgroundMesh,
    fitBackground,
    applyRangeHighlight,
    clearLineHighlight,
    clearAllHighlights,
} from './grid/index.js';
/** @import GlyphAtlas from '../GlyphAtlas.js' */

class CodeGrid extends FramedGlyphField {
    /**
     * Create a CodeGrid
     * @param {THREE.Scene} scene - Three.js scene
     * @param {GlyphAtlas} atlas - Glyph atlas for rendering
     * @param {Object} options - Configuration options
     */
    constructor(scene, atlas, options = {}) {
        super();

        this.scene = scene;
        this.atlas = atlas;
        this.name = options.name || 'CodeGrid';

        // Configuration
        this.config = {
            maxChars: options.maxChars || 50000,
            showBackground: options.showBackground !== false,
            backgroundColor: options.backgroundColor ?? 0x1a1a2e,
            backgroundOpacity: options.backgroundOpacity ?? 0.92,
            backgroundPadding: options.backgroundPadding || 1.0,
            showFilename: options.showFilename !== false,
            filenameColor: options.filenameColor || { r: 0.6, g: 0.8, b: 1.0 },
            textColor: options.textColor || { r: 0.0, g: 1.0, b: 0.0 },
            // Overall grid scale - scales the entire code view
            gridScale: options.gridScale || 1.0,
            // World scale passed to renderer (pixels to world units)
            worldScale: options.worldScale || 0.025,
            // Opaque occluder LOD: render as a discard-free, depth-writing impostor so
            // the grid occlusion-culls in dense distant scenes (a skyline of files).
            occluder: !!options.occluder,
            // Slug vector rendering data (passed through to the renderer)
            // Check options first, then atlas (shared across all renderers)
            slugData: options.slugData || (atlas && atlas._slugData) || null,
            shaper: options.shaper || (atlas && (atlas._shapeCache || atlas._shaper)) || null,
            // Layout params — how this file folds into space. Per-grid.
            layout: { ...DEFAULT_LAYOUT, ...(options.layout || {}) },
        };

        // Content state
        this.filename = '';
        this.sourcePath = null;
        this.content = '';
        this.lines = [];

        // Render-neutral analysis products (built off-critical-path).
        this._highlights = null;        // { gen, lang, captures } — syntax colors / 2D decorations (eager)
        this._semantics = null;         // SemanticModel — structural tree (lazy, built on demand)
        this._semanticsContent = null;  // the content string the cached model was built from

        // ── Load state ────────────────────────────────────────────────────────
        this._dirty          = false;   // content changed since last layout
        this._modified       = false;   // content edited since load / last save (the UNSAVED state)
        // ─────────────────────────────────────────────────────────────────────────

        // Group — the renderer's instanceMesh will be added to the scene through
        // a THREE.Group child so CodeGrid's own Object3D transform is honoured.
        this._rendererGroup = new THREE.Group();

        // Lazy GPU renderer — the _renderer slot is declared by FramedGlyphField; CodeGrid
        // creates it on first load with a right-sized buffer, so it stays null until then.

        // Derive metrics from atlas directly (no renderer needed)
        this.metrics = this._computeMetrics();

        // Background panel — the _panel/_background slots are declared by FramedGlyphField;
        // _initBackground builds the mesh + panel material for this grid.
        this._initBackground();

        // Add renderer group as our child for proper transforms
        this.add(this._rendererGroup);

        // ScaleModel (the single authority for this.scale: placement · user) + the
        // setScale/setZoom/zoom API live in FramedGlyphField. _initScale builds the model
        // with this grid's home placement and writes the initial transform.
        this._initScale(this.config.gridScale);

        this._filenameField = null;
        this._layout = null;
        this._seedExtent = null;
        this.loadPromise = null;

        // ── Windowing (opt-in scrollable viewport over the full source) ──────
        // Off by default → the grid renders the whole file. setWindow() switches
        // it to a fixed cols×visibleRows slice (each line truncated to cols) fed
        // through the normal async load path; _sourceLines keeps the canonical
        // full file, so window state is pure view-state and scrolling/resizing
        // never loses content.
        this._windowed = false;
        this._winCols = 0;
        this._winRows = 0;
        this._winFirstLine = 0;
        this._sourceLines = null;

        // Scroll offset in VISUAL rows (Step 3c, the conveyor). The fold shifts content up
        // by this many rows (screenRow = visualRow − scrollOffset), so content flows through
        // the frame while the camera stays put; folded modes hop columns/planes. 0 = top.
        this._scrollOffset = 0;

        // Frame height in VISUAL rows (Step 3c.2). >0 clips the grid to a fixed window
        // (shader vertex cull) the content scrolls through; 0 = no frame (full content).
        this._frameRows = 0;

        // ── Relayout pipeline participants ───────────────────────────────────────
        // A fold (text → buffer) is destructive: it rebuilds the instance buffer from
        // scratch, so anything derived from it must be re-established after. The pipeline
        // runs in order: fold → ARRANGE → DECORATE. Two extension seams:
        //   • Arrangers (footprint-CHANGING) re-derive glyph positions from stable anchors
        //     and run INSIDE the fold, stating their own extent as they go, so the footprint
        //     stays honest — the
        //     structural sub-layout is one. They may also constrain the fold's layout
        //     (foldLayout) without mutating config.layout.
        //   • Decorations (footprint-NEUTRAL) re-project after bounds settle — the caret is
        //     the built-in one; LSP arrows will register here. (Highlights are NOT here: they
        //     live in a persistent, slot-keyed side texture that survives a rebuild on its
        //     own — an ABSOLUTE decoration, re-applied only on content change by the colorizer.)
        this._arrangers   = [];
        this._decorations = [];
        // This fold's pre-arrangement positions (stride 3) + sizes, captured once before the
        // arrangers write — null when no arranger ran. And the extent the arrangers stated.
        this._fold = null;
        this._arrangedExtent = null;
        // The caret is a decoration: re-painted from the (now buffer-backed) layout after
        // every fold, exactly like an external overlay. _updateCaretMesh guards on cursor.
        this._decorations.push({ name: 'caret', apply: (g) => g._updateCaretMesh() });
    }

    // ── Relayout pipeline: registries + stages ───────────────────────────────────

    /**
     * Register an arranger — a footprint-changing participant re-applied INSIDE every fold
     * (before bounds): `arrange(grid, fold)` reads the fold and states its move through
     * setDisplacements. Optional `foldLayout` constrains the fold (see _foldLayout).
     * @param {{arrange: (grid: CodeGrid, fold: {positions: Float32Array, sizes: Float32Array, count: number}) => void, foldLayout?: Object}} a
     */
    registerArranger(a) {
        if (typeof a?.arrange !== 'function') throw new Error('CodeGrid.registerArranger: an arranger needs arrange(grid, fold)');
        if (!this._arrangers.includes(a)) this._arrangers.push(a);
    }
    /** Remove a previously-registered arranger. */
    unregisterArranger(a) { const i = this._arrangers.indexOf(a); if (i >= 0) this._arrangers.splice(i, 1); }

    /** Register a decoration — a footprint-neutral overlay re-applied after bounds settle. */
    registerDecoration(d) { if (d && !this._decorations.includes(d)) this._decorations.push(d); }
    /** Remove a previously-registered decoration. */
    unregisterDecoration(d) { const i = this._decorations.indexOf(d); if (i >= 0) this._decorations.splice(i, 1); }

    /**
     * The ARRANGE stage. No-op (and zero cost) when nothing is registered. Captures the fold
     * once, BEFORE any arranger writes, so every arranger — and every re-apply between folds
     * (a live dial) — measures against the same flow positions.
     * @private
     */
    _applyArrangers() {
        this._fold = null;
        this._arrangedExtent = null;
        if (!this._arrangers.length || !this._renderer || !this._layout) return;
        this._fold = this._readFold();
        for (const a of this._arrangers) a.arrange(this, this._fold);
    }

    /**
     * The fold an arranger measures against: this fold's pre-arrangement capture when an
     * arranger ran, else the slot buffer as laid (flow).
     * @returns {{positions: Float32Array, sizes: Float32Array, count: number}|null}
     */
    foldSnapshot() {
        return this._fold ?? this._readFold();
    }

    /** @private */
    _readFold() {
        const r = this._renderer, L = this._layout;
        if (!r || !L?.sizes) return null;
        const count = r.getGlyphCount();
        const f32 = r.slotBuffer.f32;
        const positions = new Float32Array(count * 3);
        for (let s = 0; s < count; s++) {
            const b = s * SLOT_FLOATS;
            positions[s * 3]     = f32[b + LANE_POS_X];
            positions[s * 3 + 1] = f32[b + LANE_POS_Y];
            positions[s * 3 + 2] = f32[b + LANE_POS_Z];
        }
        return { positions, sizes: L.sizes, count };
    }

    /**
     * An arranger's move for this fold: per-slot [dx,dy,dz] deltas onto the fold, plus the
     * extent the arrangement occupies (the arranger authored the move, so it states the box
     * rather than having it measured back out). Writes fold + delta into the slot buffer
     * (absolute, so re-applying is idempotent), hands the table to the layout description
     * so the caret rides the moved glyphs, and makes the extent the content bounds — cull
     * box and panel. The next fold starts from flow again.
     * @param {Float32Array} D - flat [dx,dy,dz] per slot
     * @param {{min:{x:number,y:number,z:number}, max:{x:number,y:number,z:number}}} extent
     */
    setDisplacements(D, extent) {
        const r = this._renderer, L = this._layout;
        const fold = this.foldSnapshot();
        if (!r || !L || !fold) return;
        if (!(D instanceof Float32Array) || D.length < fold.count * 3) {
            throw new Error(`CodeGrid.setDisplacements: need ${fold.count * 3} deltas, got ${D?.length}`);
        }
        const P = fold.positions;
        for (let s = 0; s < fold.count; s++) {
            const i = s * 3;
            r.writePosition(s, P[i] + D[i], P[i + 1] + D[i + 1], P[i + 2] + D[i + 2]);
        }
        L.displacements = D;
        const { min, max } = extent;
        this._arrangedExtent = {
            min: { ...min }, max: { ...max },
            width: max.x - min.x, height: max.y - min.y, depth: max.z - min.z,
        };
        r.setLayoutExtent(this._arrangedExtent);
        this._updateBackground();
    }

    /**
     * The DECORATE stage. Re-apply footprint-neutral overlays after bounds have settled —
     * the caret, and any registered external overlay (LSP arrows). Runs every relayout.
     * @private
     */
    _applyDecorations() {
        for (const d of this._decorations) d.apply?.(this);
    }

    /**
     * The layout params the fold should use — config.layout, with any active arranger's
     * required `foldLayout` merged over it. Lets a structural arranger force a single
     * column (so a block is a contiguous run it can move as a unit) WITHOUT mutating the
     * user's config.layout, so reset just stops merging and the original layout returns.
     * @private
     */
    _foldLayout() {
        let layout = this.config.layout;
        for (const a of this._arrangers) {
            if (a.foldLayout) layout = { ...layout, ...a.foldLayout };
        }
        return layout;
    }

    // ============ Slug data ============

    /**
     * Set Slug texture data on this grid's renderer.
     * @param {Object} slugData - { curveTexture, glyphMapTexture }
     * @param {import('../shaping/HarfBuzzShaper.js').default} [shaper] - Main-thread shaper
     */
    setSlugData(slugData, shaper) {
        this.config.slugData = slugData;
        if (shaper) this.config.shaper = shaper;
        if (this._renderer) {
            this._renderer.setSlugData(slugData, shaper);
        }
    }

    // ============ Content Loading ============

    /**
     * Load text content into the grid
     * @param {string} text - Text content to display
     * @param {Object} options - Loading options
     * @returns {this} For chaining
     */
    /**
     * Shared load preamble: normalize line endings (\r\n, \r → \n), stash content + lines,
     * reconstruct an evicted renderer, and queue the clear. Normalizing here guarantees that
     * 3D buffer slots, tree-sitter captures, and 2D editor offsets align cleanly without \r drift.
     * @private @param {string} text
     */
    _beginLoad(text) {
        const normalized = (typeof text === 'string')
            ? text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
            : String(text || '');
        this.content = normalized;
        this.lines = normalized.split('\n');
        this._ensureRenderer();
        this._clearRenderedText();
        this._updateBackground();
    }

    /**
     * Load text content into the grid (worker pipeline — the ONE load path).
     * The grid is fully laid out when the promise resolves: buffers committed,
     * line→slot tables built, background sized — highlights/caret may be applied
     * immediately after the await.
     * @param {string} text - Text content to display
     * @returns {Promise<this>} For chaining
     */
    async loadText(text) {
        this._beginLoad(text);
        // Through the ONE mutex: a load racing an edit's relayout (or a windowed
        // grid's scroll crossing) must serialize on the same _relayoutBusy gate —
        // a raw _layoutContent here was the second door around it.
        this.loadPromise = this._relayout();
        await this.loadPromise;
        this._seedExtent = null;
        return this;
    }

    // ============ Windowing (scrollable viewport) ============

    /**
     * Switch this grid into a windowed view: render only a cols×visibleRows
     * slice of the file (each line truncated to `cols` chars), scrollable via
     * scrollLines(). The full source is preserved in _sourceLines, so window
     * state is pure view-state — resizing/scrolling never loses content. Opt-in:
     * until called, the grid renders the whole file exactly as before.
     * @param {number} cols - visible columns (chars per line)
     * @param {number} rows - visible rows (lines)
     * @returns {Promise<this>}
     */
    async setWindow(cols, rows) {
        cols = Math.max(1, Math.floor(cols));
        rows = Math.max(1, Math.floor(rows));
        // Capture the canonical full source the first time we window — at this
        // point this.content is still the whole file (afterwards it holds the
        // rendered slice, while _sourceLines stays the full file).
        if (!this._windowed) {
            this._sourceLines = (this.content || '').split('\n');
        }
        this._windowed = true;
        this._winCols = cols;
        this._winRows = rows;
        this._clampWindow();
        await this._renderWindow();
        return this;
    }

    /**
     * Scroll the window by deltaLines (positive scrolls down the file). No-op
     * unless windowed.
     * @param {number} deltaLines
     * @returns {Promise<this>}
     */
    async scrollLines(deltaLines) {
        if (!this._windowed) return this;
        this._winFirstLine += Math.round(deltaLines);
        this._clampWindow();
        await this._renderWindow();
        return this;
    }

    /** @returns {boolean} whether this grid is in windowed mode */
    isWindowed() {
        return this._windowed;
    }

    /**
     * @returns {{cols:number,rows:number,firstLine:number}|null} the current window
     * view-state (size + scroll offset in lines), or null when not windowed. Pure
     * snapshot for persistence — restore via setWindow(cols, rows) + scrollLines.
     */
    getWindow() {
        if (!this._windowed) return null;
        return { cols: this._winCols, rows: this._winRows, firstLine: this._winFirstLine };
    }

    /** @private Clamp _winFirstLine to [0, lineCount - visibleRows]. */
    _clampWindow() {
        const total = this._sourceLines ? this._sourceLines.length : 0;
        this._winFirstLine = clampWindow(this._winFirstLine, total, this._winRows);
    }

    /**
     * @private Render the current window slice through the normal async load
     * path (the full source lives in _sourceLines; this only re-feeds the slice).
     */
    async _renderWindow() {
        const slice = sliceWindowText(this._sourceLines, this._winFirstLine, this._winRows, this._winCols);
        await this.loadText(slice);
        return this;
    }

    /**
     * Load file content with filename
     * @param {string} filename - Name of the file
     * @param {string} content - File content
     * @returns {Promise<this>} For chaining
     */
    async loadFile(filename, content) {
        this.filename = filename;
        return this.loadText(content);
    }

    /**
     * Clear all content
     */
    clear() {
        this.content = '';
        this.lines = [];
        this.filename = '';
        this._layout = null;

        if (this._renderer) this._renderer.clear();
        if (this._filenameField) this._filenameField.clear();
        if (this._memoryEdges) this._memoryEdges.clear();
        this._resetBatchState();

        this._updateBackground();
    }

    // ============ Visual Elements ============

    /**
     * Set background color
     * @param {number|THREE.Color} color - Background color
     */
    setBackgroundColor(color) {
        this._panel?.setFill(color);
        this.config.backgroundColor = color;
    }

    // setBorder / setStateColors / setBorderFlag — the in-shader border delegators (this._panel?.x)
    // — are inherited from FramedGlyphField. setBackgroundColor / setBackgroundStyle stay below
    // (they touch CodeGrid-specific config + glyph-alpha).

    /**
     * Show or hide background
     * @param {boolean} visible - Whether background is visible
     */
    showBackground(visible) {
        this.config.showBackground = visible;
        if (this._background) {
            this._background.visible = visible;
        }
    }

    /**
     * Hide background
     */
    hideBackground() {
        this.showBackground(false);
    }

    /**
     * Set filename label
     * @param {string} name - Filename to display
     */
    setFilenameLabel(name) {
        this.filename = name;
        // Re-layout to update filename
        if (this.content) {
            this._relayout();
        }
    }

    /**
     * Show or hide filename label
     * @param {boolean} visible - Whether filename is visible
     */
    showFilename(visible) {
        this.config.showFilename = visible;
        if (this.content) {
            this._relayout();
        }
    }

    /**
     * Hide filename label
     */
    hideFilename() {
        this.showFilename(false);
    }

    // ============ Spatial Queries ============

    /**
     * The padded panel bounds in the grid's OWN local frame (no world transform).
     * This is the orientation-stable box: an outline parented to / composed with the
     * grid's matrixWorld rides every rotation, where a world-space AABB (getBounds)
     * morphs as the grid rotates relative to world (e.g. docked under the camera).
     * Callers must not hold the returned box across calls (it is reused).
     * @returns {THREE.Box3} Bounding box in local coordinates
     */
    getLocalBounds() {
        const contentBounds = this._getContentBounds(); // local AABB, cached on content change
        if (!this._localBoundsCache) this._localBoundsCache = new THREE.Box3();
        const box = this._localBoundsCache;
        if (!contentBounds) { box.makeEmpty(); return box; }
        const padding = this.config.backgroundPadding;
        // x/y: panel padding around content. z: a tiny slab (content is flat at z=0,
        // the background panel sits just behind it) so a focus overlay straddles the
        // panel plane instead of lying coplanar with it — see BOUNDS_Z_PAD.
        box.min.set(contentBounds.min.x - padding, contentBounds.min.y - padding, contentBounds.min.z - BOUNDS_Z_PAD);
        box.max.set(contentBounds.max.x + padding, contentBounds.max.y + padding, contentBounds.max.z + BOUNDS_Z_PAD);
        return box;
    }

    // getBounds(target) — world-space AABB, recomputed on demand — is inherited from
    // BoundedObject3D (getLocalBounds() applied by the current matrixWorld).

    /**
     * Set the PLACEMENT scale (natural home size). The dock overrides this while
     * docked; composed through ScaleModel so any active zoom is preserved.
     * @param {number} factor
     */
    setScale(factor) {
        this.config.gridScale = factor;        // mirror the home scale, then base drives this.scale
        super.setScale(factor);
    }

    // setZoom(factor) + get zoom — the readability-zoom API — are inherited from FramedGlyphField.

    /**
     * Get local content bounds (plain-object form, not a THREE.Box3).
     * @returns {Object|null} { min, max, width, height, depth } or null
     */
    getContentBounds() {
        return this._getContentBounds();
    }

    /**
     * Local-space AABB suitable for composable layout containers.
     *
     * Why a dedicated method instead of relying on THREE.Box3.setFromObject?
     * The renderer is an InstancedMesh whose base geometry is a unit quad;
     * setFromObject reads the base geometry's bounding box and ignores the
     * spread of per-instance positions, so it reports the cluster as a
     * ~1×1 box and stack/grid layouts collapse all clusters onto each other.
     * The layout kit's measure.js calls this method when present.
     *
     * @returns {THREE.Box3}  Local-space bounds (no world transform applied)
     */
    layoutBounds() {
        const cb = this._getContentBounds();
        if (!cb) return new THREE.Box3();
        return new THREE.Box3(
            new THREE.Vector3(cb.min.x, cb.min.y, cb.min.z),
            new THREE.Vector3(cb.max.x, cb.max.y, cb.max.z),
        );
    }

    // getRenderer() is inherited from FramedGlyphField (returns the InstancedField renderer).

    /**
     * Wire the PickingSystem. Registers the background panel for 'grid' picking
     * and the InstancedField's instanceMesh for 'glyph' picking.
     * @param {import('../picking/PickingSystem.js').PickingSystem} pickingSystem
     */
    setPickingSystem(pickingSystem) {
        this._pickingSystem = pickingSystem;
        if (!pickingSystem) return;
        if (this._background) {
            try { pickingSystem.register?.('grid', this._background, this); } catch (_) {}
        }
        if (this._renderer?.instanceMesh) {
            try {
                pickingSystem.register?.('glyph', this._renderer.instanceMesh, this._renderer, {
                    count: this._renderer.getGlyphCount?.() || this._renderer.instanceMesh.geometry.instanceCount || 0
                });
            } catch (_) {}
        }
    }

    /**
     * Get glyph count
     * @returns {number} Number of glyphs (0 if content is unloaded)
     */
    getGlyphCount() {
        return this._renderer ? this._renderer.getGlyphCount() : 0;
    }

    /**
     * Get line count
     * @returns {number} Number of lines
     */
    getLineCount() {
        // Lazy-populate lines if needed (async path doesn't split upfront)
        if (this.lines.length === 0 && this.content.length > 0) {
            this.lines = this.content.split('\n');
        }
        return this.lines.length;
    }

    /**
     * Get maximum line width (in characters)
     * @returns {number} Maximum line width
     */
    getMaxLineWidth() {
        // Lazy-populate lines if needed (async path doesn't split upfront)
        if (this.lines.length === 0 && this.content.length > 0) {
            this.lines = this.content.split('\n');
        }
        return Math.max(...this.lines.map(l => l.length), 0);
    }

    /**
     * Get filename
     * @returns {string|null} Current filename
     */
    getFilename() {
        return this.filename || null;
    }

    /** The file's full source text (the buffer a 2D companion view renders). */
    getContent() {
        return this.content;
    }

    /**
     * The file's current syntax highlights, or null if not computed yet / unsupported.
     * Render-target-neutral: the SyntaxColorizer parses ONCE and stashes the captures
     * here; the 3D coloring reads {startRow,startCol,endRow,endCol} → slots, and a 2D
     * companion view reads {startIndex,endIndex} (absolute UTF-16 offsets) → editor
     * decorations. One parse, many views. Shape: { gen, lang, captures }.
     */
    getHighlights() {
        return this._highlights || null;
    }

    /**
     * Subscribe to highlight (re)computation for this grid. Returns an unsubscribe fn.
     * Fired by the SyntaxColorizer after each (re)parse so a 2D companion view refreshes
     * reactively instead of polling. @param {(h:object)=>void} cb
     */
    onHighlightsChanged(cb) {
        if (!this._highlightListeners) this._highlightListeners = new Set();
        this._highlightListeners.add(cb);
        return () => { this._highlightListeners?.delete(cb); };
    }

    /** @private Set highlights + notify listeners. Called by the colorizer. */
    _setHighlights(h) {
        this._highlights = h;
        if (!this._highlightListeners) return;
        for (const cb of this._highlightListeners) {
            try { cb(h); } catch (e) { console.warn('[highlights] listener error:', e?.message ?? e); }
        }
    }

    /**
     * Apply syntax palette colors to the grid's rendered text slots.
     * Accurately maps UTF-8 palette bytes to 3D RenderSlots per line.
     * @param {Uint8Array} palette
     * @param {Float32Array} lut
     */
    applySyntaxPalette(palette, lut) {
        if (!this._renderer || !this._layout || !palette || !lut) return;
        const lineStarts = this._layout.lineSlotBase;
        if (!lineStarts) return;
        this._renderer.setGlyphPaletteRange(palette, lut, this.lines, lineStarts);
    }

    /**
     * The cached semantic structure model (the arborist's output) for the CURRENT
     * content, or null if it hasn't been built yet / is stale / unsupported. Sync
     * and side-effect-free — use ensureSemantics() to build on demand. Canonical
     * coords are {line, col} in the glyph-slot space.
     * @returns {import('../parsing/SemanticModel.js').default|null}
     */
    getSemantics() {
        return (this._semantics && this._semanticsContent === this.content) ? this._semantics : null;
    }

    /**
     * Build-or-return the SemanticModel, lazily. The structural AST walk is OFF the
     * bulk colorize path (a 305-file load doesn't pay for it) — it runs the first
     * time something asks for structure on THIS content, then caches against the
     * content identity. An edit swaps `this.content`, invalidating the cache; the
     * next caller rebuilds. A layout/scroll does NOT (content unchanged), so the
     * cache survives navigation. Concurrent callers share one in-flight parse.
     * @returns {Promise<import('../parsing/SemanticModel.js').default|null>}
     */
    ensureSemantics() {
        const content = this.content;
        if (this._semantics && this._semanticsContent === content) return Promise.resolve(this._semantics);
        if (this._semanticsPending && this._semanticsPendingContent === content) return this._semanticsPending;

        this._semanticsPendingContent = content;
        this._semanticsPending = buildGridSemantics(this).then((model) => {
            if (this.content === content) {        // still the same content — cache it
                this._semantics = model;
                this._semanticsContent = content;
            }
            return this.content === content ? model : this.getSemantics();
        }).finally(() => {
            if (this._semanticsPendingContent === content) this._semanticsPending = null;
        });
        return this._semanticsPending;
    }

    /**
     * Synchronously refresh + cache the SemanticModel — but only if the tree-sitter engine
     * is already warm (parseStructureSync; cold returns null). Returns the fresh model, or
     * null to defer to ensureSemantics. An arranged grid is always warm, so its arranger
     * re-derives within the same edit fold instead of awaiting — no stale-semantics flicker.
     * @returns {import('../parsing/SemanticModel.js').default|null}
     */
    refreshSemanticsSync() {
        const content = this.content;
        if (this._semantics && this._semanticsContent === content) return this._semantics; // cache hit
        const model = buildGridSemanticsSync(this);
        if (model) {
            this._semantics = model;
            this._semanticsContent = content;
        }
        return model;
    }

    /**
     * Innermost semantic node at a (line, col), optionally constrained to a kind
     * ('function' | 'class' | 'method' | …). Drives "select the function I'm in"
     * from a caret/pick. Reads the cache only (call ensureSemantics() first if the
     * model may not be built). @returns {object|null}
     */
    nodeAtChar(line, col, kind = null) {
        return this.getSemantics()?.nodeAt(line, col, kind) ?? null;
    }

    /**
     * Get source path
     * @returns {string|null} Source file path
     */
    getSourcePath() {
        return this.sourcePath || this.userData?.sourcePath || null;
    }

    /**
     * Set source path metadata
     * @param {string} path - Source file path
     */
    setSourcePath(path) {
        this.sourcePath = path;
    }

    // ============ Lifecycle ============

    /**
     * Update any animated elements
     * @param {number} deltaTime - Time since last update
     */
    update(deltaTime) {
        // Future: add hover effects, selection highlights, etc.
    }


    /**
     * Re-fold the grid in place from current state (layout params + scroll offset). Source
     * text and camera stay put — only how the file folds into space changes. Runs the reload
     * pipeline so the builder AND the LayoutDescription pick up the current state together
     * (caret/highlight stay aligned). Shared by setLayout / setScrollOffset. No-op without
     * source text; reconstructs an evicted grid first.
     * @private
     * @returns {Promise<this>}
     */
    /**
     * THE single relayout pipeline — re-fold the grid from current state (this.lines/content,
     * scrollOffset, layout params) and repaint the edit caret. ONE mutex (_relayoutBusy /
     * _relayoutPending) serializes ALL relayouts — layout, frame, AND edit — so two
     * pipelines can never interleave on the shared load state. Rapid calls
     * coalesce: the in-flight pass loops once more with the LATEST state. Edit callers set
     * _linesDirty so content re-syncs from the edit-mutated line array; scroll/layout/frame
     * callers leave this.content untouched (no per-tick join cost).
     * @private
     * @returns {Promise<this>}
     */
    async _relayout() {
        if (this._relayoutBusy) { this._relayoutPending = true; return this; }
        this._relayoutBusy = true;
        try {
            await this._relayoutLoop();
        } finally {
            this._relayoutBusy = false;
        }
        return this;
    }

    /**
     * The view-state fold: scroll/frame changed, CONTENT did not.
     * @private
     */
    async _foldView(repaginate) {
        return this._relayout();
    }

    /** The fold body — assumes the _relayoutBusy gate is HELD by the caller. @private */
    async _relayoutLoop() {
        do {
            this._relayoutPending = false;
            this.getLineCount();                       // ensure this.lines is populated
            if (this._linesDirty) {                    // edits mutate this.lines → resync content
                this.content = this.lines.join('\n');
                this._linesDirty = false;
            }
            if (!this.content && !this.filename) continue;   // nothing at all
            this._ensureRenderer();                    // reconstruct if content was evicted
            this._clearRenderedText();                 // drop the prior render's glyphs
            await this._layoutContent();               // FOLD: layout + geometry + layoutDescription
            this._updateBackground();                  // FIT: re-fit the panel to the settled extent
            // Clamp the edit caret into the fresh content before the decorate stage paints it.
            if (this._cursor) {
                const ln = Math.max(0, Math.min(this._cursor.line, this.lines.length - 1));
                const cl = Math.max(0, Math.min(this._cursor.col, cpLen(this.lines[ln] ?? '')));
                this._cursor.line = ln;
                this._cursor.col = cl;
            }
            this._applyDecorations();                  // DECORATE: caret + external overlays
        } while (this._relayoutPending);
    }

    /** Scroll / layout / frame relayout (reuses this.content). @private @returns {Promise<this>} */
    _relayoutInPlace() {
        return this._relayout();
    }

    /**
     * Change this grid's layout params and refold in place (see _relayoutInPlace). Merges
     * `params` over the current config.layout. See LAYOUT_PLAN.md §3a.
     * @param {Object} [params] - subset of layout params (wrapWidth, pageHeight, pagesWide, …).
     * @returns {Promise<this>}
     */
    async setLayout(params) {
        if (params) this.config.layout = { ...this.config.layout, ...params };
        return this._relayoutInPlace();
    }

    /** @returns {Object} the current layout params (live reference to config.layout) */
    getLayout() {
        return this.config.layout;
    }

    /**
     * Set the scroll offset (in VISUAL rows) and refold in place — the conveyor (Step 3c).
     * The fold shifts content up by `rows`, so content flows through a fixed frame while the
     * camera stays put; folded modes (newspaper/z-pages) hop content between columns/planes
     * as it crosses page boundaries. Clamped to [0, total visual rows].
     * @param {number} rows
     * @returns {Promise<this>}
     */
    async setScrollOffset(rows) {
        const clamped = clampScroll(rows, this.getMaxScroll());
        if (clamped === this._scrollOffset) return this;
        this._scrollOffset = clamped;
        // Re-fold view with the updated scroll position.
        return this._foldView(true);
    }

    /** Scroll by a delta in visual rows (positive = scroll down, content flows up). */
    async scrollBy(deltaRows) {
        return this.setScrollOffset((this._scrollOffset || 0) + deltaRows);
    }

    /** @returns {number} current scroll offset in visual rows */
    getScrollOffset() {
        return this._scrollOffset || 0;
    }

    /**
     * Total VISUAL rows in the current fold (source lines + intra-line wraps). Scroll-stable
     * (independent of scrollOffset) — the pipeline's bounds lane 6, reduced on-GPU and read
     * off the CPU mirror.
     * @returns {number}
     */
    getTotalVisualRows() {
        return this._layout?.totalRows ?? 0;
    }

    /**
     * Max scroll offset (hard-stop). With a frame, stop so the last frameRows fill the
     * window; without one, allow scrolling to the last row.
     * @returns {number}
     */
    getMaxScroll() {
        return computeMaxScroll(this.getTotalVisualRows(), this._frameRows);
    }

    /**
     * Set the clip-frame height in VISUAL rows (Step 3c.2). >0 clips the grid to a fixed
     * window the content scrolls through (shader vertex cull); 0 disables (full content).
     * Pure render-side — no re-fold; re-clamps scroll to the new window (relayout only if the
     * offset actually moves).
     * @param {number} rows
     * @returns {Promise<this>}
     */
    async setFrameRows(rows) {
        this._frameRows = Math.max(0, Math.round(rows) || 0);
        this._applyClip();
        this._updateBackground();
        const clamped = Math.max(0, Math.min(this._scrollOffset, this.getMaxScroll()));
        if (clamped !== this._scrollOffset) return this.setScrollOffset(clamped);
        return this;
    }

    /** @private */
    _windowCovers(scroll) {
        return true;
    }

    /** @returns {number} current clip-frame height in visual rows (0 = no frame) */
    getFrameRows() {
        return this._frameRows || 0;
    }

    /**
     * Apply a saved viewport record to this grid directly — window (size + firstLine) → frame →
     * scroll, in that order: window re-flows the slice, frame clips it, scroll moves content through
     * the clip. This is the load-path counterpart to the grid.window / grid.frame / grid.scroll
     * verbs — those verbs AND the session projection drive this one method, so a reload is
     * applyView(record), not a replay of the verbs that produced it. Every field is guarded and
     * absolute, so applyView is idempotent. Returns whether the WINDOW changed: that's a footprint
     * change, and only the caller can relayout the tree (the grid has no handle to it).
     * @param {{window?:{cols:number,rows:number,firstLine?:number}, frameRows?:number, scrollOffset?:number}} view
     * @returns {Promise<{windowed:boolean}>}
     */
    async applyView(view) {
        const v = view || {};
        let windowed = false;
        const w = v.window;
        if (w && w.cols > 0 && w.rows > 0) {
            if (!this._windowed || this._winCols !== w.cols || this._winRows !== w.rows) {
                await this.setWindow(w.cols, w.rows);
                windowed = true; // window SIZE changed → footprint moved → tree relayout needed
            }
            // firstLine is the window's own scroll; scrollLines is by-delta, so drive it to the
            // absolute target. A scroll within a same-size window doesn't change the footprint.
            const fl = Math.max(0, Math.round(w.firstLine || 0));
            const cur = this._winFirstLine || 0;
            if (cur !== fl) await this.scrollLines(fl - cur);
        }
        if (Number.isInteger(v.frameRows) && v.frameRows >= 0 && this.getFrameRows() !== v.frameRows) {
            await this.setFrameRows(v.frameRows);
        }
        if (Number.isInteger(v.scrollOffset) && v.scrollOffset >= 0 && this.getScrollOffset() !== v.scrollOffset) {
            await this.setScrollOffset(v.scrollOffset);
        }
        return { windowed };
    }

    /**
     * Push the current frame window to the renderer's shader clip (Step 3c.2). Clip range is
     * grid-local y: top = origin + half a row (so screenRow 0 fully shows), bottom = origin −
     * (frameRows − ½) rows. Called after every (re)layout (origin/renderer may change) and on
     * setFrameRows. frameRows 0 → clip off.
     * @private
     */
    _applyClip() {
        if (!this._renderer || typeof this._renderer.setClipYRange !== 'function') return;
        if (this._frameRows > 0) {
            const ls = this.metrics.lineSpacing;
            const originY = this._layoutOriginY ?? 0;
            const { top, bottom } = computeFrameClip(originY, this._frameRows, ls);
            this._renderer.setClipYRange(top, bottom);
        } else {
            this._renderer.setClipYRange(null, null);
        }
    }

    /**
     * Dispose of all resources
     */
    dispose() {
        if (this._pickingSystem) {
            if (this._background) {
                try { this._pickingSystem.unregister?.('grid', this._background); } catch (_) {}
            }
            if (this._renderer?.instanceMesh) {
                try { this._pickingSystem.unregister?.('glyph', this._renderer.instanceMesh); } catch (_) {}
            }
        }

        if (this._renderer) {
            if (this._rendererGroup && this._renderer.instanceMesh) {
                this._rendererGroup.remove(this._renderer.instanceMesh);
            }
            this._renderer.dispose();
            this._renderer = null;
        }
        if (this._filenameField) {
            if (this._rendererGroup && this._filenameField.instanceMesh) {
                this._rendererGroup.remove(this._filenameField.instanceMesh);
            }
            this._filenameField.dispose();
            this._filenameField = null;
        }

        if (this._rendererGroup) {
            this.scene?.remove(this._rendererGroup);
            this.remove(this._rendererGroup);
            while (this._rendererGroup.children.length > 0) {
                this._rendererGroup.remove(this._rendererGroup.children[0]);
            }
        }

        this._disposePanel();

        if (this._memoryEdges) {
            this._memoryEdges.dispose();
            this._memoryEdges = null;
        }

        if (this._caretMesh) {
            this._caretMesh.geometry.dispose();
            this._caretMesh.material.dispose();
            this.remove(this._caretMesh);
            this._caretMesh = null;
        }

        this._resetBatchState();
        this.content = '';
        this.lines = [];
    }

    // ============ Private Methods ============

    /**
     * Compute atlas-derived metrics. Called at construction and after atlas swap.
     * @private
     * @returns {ReturnType<typeof computeCellMetrics>} the cell metrics, as computed
     */
    _computeMetrics() {
        const atlasCharSize = (this.atlas && typeof this.atlas.getCharSize === 'function')
            ? this.atlas.getCharSize()
            : { width: 48 * 0.6, height: 48 * 1.15 };
        const scale = this.config.worldScale;
        return computeCellMetrics(atlasCharSize, scale);
    }

    /**
     * Ensure the grid's InstancedField renderer exists.
     * Called at the top of loadText() so that method is safe to use on evicted grids.
     * @private
     */
    _ensureRenderer() {
        if (this._renderer) return; // already present
        this._createRendererView();

        // Re-derive metrics in case atlas changed
        this.metrics = this._computeMetrics();
    }

    /**
     * Create this grid's InstancedField renderer and wire it up to the scene hierarchy.
     * @private
     */
    _createRendererView() {
        this._renderer = new InstancedField(null, this.atlas, {
            worldScale: this.config.worldScale,
            slugData: this.config.slugData,
            shaper: this.config.shaper,
            defaultColor: this.config.textColor,
            frustumCulled: false,
        });
        this._rendererGroup.add(this._renderer.instanceMesh);
        this._applyGlyphAlpha();
        if (this._pickingSystem && this._renderer?.instanceMesh) {
            try {
                this._pickingSystem.register?.('glyph', this._renderer.instanceMesh, this._renderer, {
                    count: this._renderer.getGlyphCount?.() || this._renderer.instanceMesh.geometry.instanceCount || 0
                });
            } catch (_) {}
        }
    }

    /**
     * Reset all deferred-batch state without touching the renderer.
     * @private
     */
    _resetBatchState() {
        this._dirty = false;
    }

    /**
     * Initialize background plane
     * @private
     */
    _initBackground() {
        this._bgGap = getBandDistance(LAYER_BAND.GRID_BACKGROUND);
        const { mesh, panel } = createBackgroundMesh(this.config, this._bgGap);
        this._panel = panel;
        this._background = mesh;
        this.add(this._background);
    }

    /**
     * Live-restyle the background panel — color (hex int or '#rrggbb' string)
     * and/or opacity (0–1). Drives the configurable color scheme; readability of
     * stacked tiles in a dock comes down to this opacity. Either field optional.
     * @param {{ color?: number|string, opacity?: number }} style
     */
    setBackgroundStyle({ color, opacity } = {}) {
        if (color != null) this.config.backgroundColor = color;
        if (opacity != null) this.config.backgroundOpacity = opacity;
        if (!this._panel) return;
        this._panel.setFill(color, opacity);
        if (opacity != null) this._applyGlyphAlpha();
    }

    /**
     * Live nudge of the background's set-back behind the text (the `band.gridBgGap`
     * dial). The plane always sits at (base − gap) — base 0 for the fixed path, the
     * content zMin for the auto-sized path — so a gap change is a pure z shift by the
     * delta; no relayout.
     */
    refreshBackground(gap) {
        if (!this._background) return;
        this._background.position.z += (this._bgGap ?? 0) - gap;
        this._bgGap = gap;
    }

    /**
     * Fade this grid's glyphs (group 0 holds them all) to match the panel opacity,
     * so a translucent grid reads as one coherent sheet (text + bg together) rather
     * than opaque text over glass. No-op until the renderer exists.
     * @private
     */
    _applyGlyphAlpha() {
        this._renderer?.setGroupAlpha(0, this.config.backgroundOpacity);
    }

    /**
     * Reset the prior render before a re-layout. Does NOT touch this.content / this.lines —
     * the data is set separately at the load seam (_beginLoad). Byte pipeline: the next
     * setText re-attaches the field's buffers wholesale, so clearing is state-only.
     * @private
     */
    _clearRenderedText() {
        this._resetBatchState();
    }

    /**
     * Ensure all codepoints in the given text have their glyphs encoded in LiveSlugAtlas.
     * Newly sighted outline glyphs have their curves encoded; newly sighted emoji slots
     * have their canvas cells rasterized and their glyphMap entries written.
     * @private
     * @param {string} text
     */
    _ensureGlyphsEncoded(text) {
        const atlas = this.atlas;
        const live = atlas?._live;
        const shapeCache = atlas?._shapeCache || (this.config.shaper?.lookup ? this.config.shaper : null);
        if (!live || !shapeCache || !text) return;
        if (!atlas._seenCodepoints) atlas._seenCodepoints = new Set();
        const seen = atlas._seenCodepoints;
        let fresh = null;
        for (let i = 0; i < text.length;) {
            const cp = text.codePointAt(i);
            i += cp > 0xFFFF ? 2 : 1;
            if (cp > 32 && !seen.has(cp)) {
                seen.add(cp);
                (fresh ?? (fresh = [])).push(cp);
            }
        }
        if (fresh && fresh.length > 0) {
            live.ensureCodepoints(fresh, shapeCache);
        }
    }

    /**
     * Layout content — runs LayoutGenerator to emit 32-byte RenderSlots directly
     * into the InstancedField slot buffer, updates bounds, and synchronizes the picking system.
     * @private
     */
    async _layoutContent() {
        // The filename: its own VIEW + InstancedField at y=0; the content sits 1.5 rows below.
        if (this.config.showFilename && this.filename) {
            await this._layoutFilename();
        } else if (this._filenameField) {
            this._filenameField.setVisible(false);
        }
        this._layoutOriginY = (this.config.showFilename && this.filename)
            ? -this.metrics.lineSpacing * 1.5
            : 0;

        if (this.content && this.content.length > 0) {
            if (!this._renderer) this._ensureRenderer();
            this._ensureGlyphsEncoded(this.content);
            const m = this.metrics;
            const lp = resolveLayoutParams(this._foldLayout());
            const wrapWidth = lp.wrapWidth || 0;
            const zStep = m.charHeight * (lp.zWrapSpacing || 0);

            const result = generateLayout(this.content, {
                shaper: this.config.shaper || this.atlas?._shapeCache || this.atlas?._shaper,
                metrics: m,
                origin: { x: 0, y: this._layoutOriginY, z: 0 },
                wrapWidth: wrapWidth,
                zWrapSpacing: lp.zWrapSpacing || 0,
                pageHeight: lp.pageHeight,
                pagesWide: lp.pagesWide,
                pageGapX: lp.pageGapX,
                pageGapY: lp.pageGapY,
                pageDepth: lp.pageDepth,
                axis: lp.axis,
                tabWidth: lp.tabWidth,
                color: this.config.textColor,
                scrollOffset: this._scrollOffset || 0,
                targetBuffer: this._renderer.slotBuffer,
                targetSizes: this._layout?.sizes,
            });

            this._renderer.setSlots(result.buffer, result.glyphCount);
            this._renderer.setLayoutExtent(result.bounds);
            if (this._pickingSystem && this._renderer?.instanceMesh) {
                try {
                    this._pickingSystem.register?.('glyph', this._renderer.instanceMesh, this._renderer, {
                        count: result.glyphCount
                    });
                } catch (_) {}
            }

            this._layout = new LayoutDescription({
                lineSlotBase: result.lineStarts,
                lineStartRow: result.lineStartRows,
                lineLengths: result.lineLengths,
                sizes: result.sizes,
                wrapWidth: wrapWidth,
                page: result.page,
                originX: 0,
                originY: this._layoutOriginY,
                originZ: 0,
                lineSpacing: m.lineSpacing,
                zStep: zStep,
                cellHeight: m.charHeight,
                advance: m.charWidth,
                scrollOffset: this._scrollOffset || 0,
                totalRows: result.totalRows,
                maxRowExtent: result.maxRowExtent,
                maxSegs: result.maxSegs,
            });

            if (this._highlights?.palette) {
                this.applySyntaxPalette(this._highlights.palette, paletteLUT());
            }

            this._scheduleAnalyze();
        } else {
            this._layout = null;
            if (this._renderer) this._renderer.clear();
        }

        this._updateBackground();
        this._applyClip();
        this._applyArrangers();
    }

    /**
     * The filename's own InstancedField, placed above content.
     * @private
     */
    async _layoutFilename() {
        if (!this.filename) return;
        this._ensureGlyphsEncoded(this.filename);
        if (!this._filenameField) {
            this._filenameField = new InstancedField(null, this.atlas, {
                worldScale: this.config.worldScale,
                slugData: this.config.slugData || this.atlas?._slugData,
                shaper: this.config.shaper || this.atlas?._shapeCache || this.atlas?._shaper,
                defaultColor: this.config.filenameColor,
                frustumCulled: false,
            });
            this._rendererGroup.add(this._filenameField.instanceMesh);
        }
        this._filenameField.setVisible(true);
        if (this._filenameStagedText === this.filename) return;
        this._filenameStagedText = this.filename;
        this._filenameField.loadText(this.filename, {
            color: this.config.filenameColor,
            origin: { x: 0, y: 0, z: 0 },
            metrics: this.metrics,
            wrapWidth: 0,
        });
    }

    /**
     * Seed initial content bounds (used by materializeActor to eliminate bounds gap).
     * @param {Object} extent - { min, max, width, height, depth }
     */
    setSeedExtent(extent) {
        if (!extent) return;
        this._seedExtent = {
            min: { ...extent.min },
            max: { ...extent.max },
            width: extent.width,
            height: extent.height,
            depth: extent.depth ?? 0,
        };
        this._updateBackground();
    }

    /**
     * The content bounds in this grid's local frame.
     * @private
     * @returns {{min:{x,y,z}, max:{x,y,z}, width:number, height:number, depth:number}|null}
     */
    _getContentBounds() {
        let cb = this._arrangedExtent ?? this._layout?.extent() ?? null;
        if (!cb && this._seedExtent) {
            cb = this._seedExtent;
        }

        if (this.config.showFilename && this.filename) {
            const m = this.metrics;
            const fnW = this.filename.length * m.charWidth;
            const fnH = m.charHeight;
            const fnMinY = -fnH / 2;   // the filename's row 0 centers ON y = 0
            const fnMaxY = fnH / 2;
            if (cb) {
                const minX = Math.min(cb.min.x, 0);
                const maxX = Math.max(cb.max.x, fnW);
                const minY = Math.min(cb.min.y, fnMinY);
                const maxY = Math.max(cb.max.y, fnMaxY);
                const minZ = Math.min(cb.min.z, 0);
                const maxZ = Math.max(cb.max.z, 0);
                return {
                    min: { x: minX, y: minY, z: minZ },
                    max: { x: maxX, y: maxY, z: maxZ },
                    width: maxX - minX,
                    height: maxY - minY,
                    depth: maxZ - minZ,
                };
            } else {
                return {
                    min: { x: 0, y: fnMinY, z: 0 },
                    max: { x: fnW, y: fnMaxY, z: 0 },
                    width: fnW,
                    height: fnH,
                    depth: 0,
                };
            }
        }

        if (!cb) {
            const m = this.metrics;
            return {
                min: { x: 0, y: -m.charHeight, z: 0 },
                max: { x: m.charWidth, y: 0, z: 0 },
                width: m.charWidth,
                height: m.charHeight,
                depth: 0,
            };
        }

        return cb;
    }

    /**
     * Schedule an analysis pass for the layout just built. Fire-and-forget: one
     * tree-sitter parse paints base glyph colors via the renderer AND rebuilds the
     * grid's SemanticModel, off the critical path. The generation token lets a
     * newer layout supersede an in-flight pass (edits relayout often). A no-op for
     * unsupported file types.
     * @private
     */
    _scheduleAnalyze() {
        // The fold ANNOUNCES a new generation; WHEN parsing is due is the analyzer's
        // own policy (SyntaxColorizer coalesces rapid generations itself) — layout
        // owns no consumer's timing.
        this._analyzeGen = (this._analyzeGen || 0) + 1;
        analyzeGrid(this);
    }

    /**
     * Resolve the world-space caret position for a logical (line, col).
     *
     * Pure deterministic math from layout invariants the worker also
     * obeyed: visual row from wrap data, x from intra-segment col,
     * y from origin + row * lineSpacing, then pagination applied
     * identically to how the worker shifts glyphs. No buffer reads.
     *
     * Returns { x, y } in grid-local coords, or null when the layout
     * isn't ready (pre-flush, evicted content).
     *
     * @param {number} line
     * @param {number} col
     * @returns {{x: number, y: number} | null}
     */
    _resolveCaretWorldPosition(line, col) {
        // Delegated to the LayoutDescription: positionAt is buffer-backed (the glyph's
        // exact laid-out position, wrap + pagination already applied), with an analytic
        // fallback for empty lines. The old duplicate wrap+pagination re-derivation —
        // which kept its own (now-stale) column-width copy and drifted from the glyphs —
        // is gone. ONE source of layout math.
        return this._layout?.positionAt(line, col) ?? null;
    }

    /**
     * Get the buffer slot index for a character at (line, col).
     *
     * `col` is a raw codepoint index within the line. The builder emits one
     * buffer slot per codepoint — spaces, tabs and other invisible glyphs
     * included (they render to nothing via 0-curve fragment discard). So the
     * slot offset within a line equals the codepoint index: col == slot.
     * @param {number} line - 0-based line index
     * @param {number} col - 0-based codepoint index within the line
     * @returns {number} Buffer slot index, or -1 if out of range
     */
    getSlotForChar(line, col) {
        return this._layout?.slotForChar(line, col) ?? -1;
    }

    /**
     * Inverse of getSlotForChar: buffer slot → {line, col}. A glyph-channel pick
     * yields an instance index; instance order == slot order, so this maps the
     * picked glyph back to the cursor's coordinate space — in ANY layout mode
     * (column / framed / z-pages), since layout only moves quads, never slots.
     * @param {number} slot - grid-global buffer slot (== glyph instance index)
     * @returns {{line:number,col:number}|null} null when layout isn't ready or slot is out of range
     */
    getCharForSlot(slot) {
        return this._layout?.charForSlot(slot) ?? null;
    }

    /**
     * Number of buffer slots on a line — i.e. its codepoint count, since the
     * builder slots every codepoint (see getSlotForChar). Used as the
     * exclusive end column for "highlight to end of line".
     *
     * Iterates by codepoint (not UTF-16 unit, not grapheme cluster) to match
     * exactly how the shaper/builder walk the line.
     * @param {number} line - 0-based line index
     * @returns {number}
     */
    getLineSlotCount(line) {
        if (!this.lines || line < 0 || line >= this.lines.length) return 0;
        return cpLen(this.lines[line] ?? '');
    }

    // ============ Glyph Highlighting ============

    /**
     * Highlight a range of characters. `fillOpacity` selects the mode: 0 (default) = additive
     * tint on the glyph ink; >0 = a background-fill bar at that opacity behind the glyphs (the
     * cells tile seamlessly). See GlyphField.setGlyphHighlight.
     * @param {number} startLine - 0-based inclusive
     * @param {number} startCol - 0-based inclusive (codepoint index)
     * @param {number} endLine - 0-based inclusive
     * @param {number} endCol - 0-based exclusive (codepoint index)
     * @param {{r:number, g:number, b:number}} color
     * @param {number} [fillOpacity=0] - 0 = additive tint; >0 = background-fill opacity (0–1)
     */
    highlightRange(startLine, startCol, endLine, endCol, color, fillOpacity = 0) {
        applyRangeHighlight(this._renderer, this._layout, startLine, startCol, endLine, endCol, color, fillOpacity);
    }

    /**
     * Highlight a semantic node's full source span with additive color. The node
     * carries canonical {line, col} (codepoint) ranges, so this resolves to glyph
     * slots through the live layout — the same path as highlightRange. Returns
     * false for a null node.
     * @param {{start:{line:number,col:number}, end:{line:number,col:number}}} node
     * @param {{r:number, g:number, b:number}} color
     * @param {number} [fillOpacity=0] - 0 = additive tint; >0 = background-fill opacity (0–1)
     * @returns {boolean}
     */
    highlightNode(node, color, fillOpacity = 0) {
        if (!node || !node.start || !node.end) return false;
        this.highlightRange(node.start.line, node.start.col, node.end.line, node.end.col, color, fillOpacity);
        return true;
    }

    /**
     * Clear highlights on a specific line.
     * @param {number} line - 0-based line index
     */
    clearLineHighlight(line) {
        clearLineHighlight(this._renderer, this._layout, line);
    }

    /**
     * Clear all glyph highlights on this grid.
     * Delegates to clearLineHighlight() for each line — uses the RGBA8 DataTexture path.
     */
    clearAllHighlights() {
        clearAllHighlights(this._renderer, this._layout, this.getLineCount());
    }

    // ============ In-grid Editing ============
    //
    // The grid is the editor: edit ops mutate `this.lines` then trigger an
    // async loadText rebuild via _relayoutPreservingCursor (the worker
    // pipeline right-sizes the GPU buffers; the sync path doesn't grow on
    // overflow). Concurrent flushes are coalesced.
    //
    // Cursor lives on the grid (`this._cursor = {line, col}`) so each grid
    // remembers its own edit/focus location. `null` means "not editing".
    //
    // Caret position is derived deterministically from the worker's layout
    // summary (per-line wrap cols + cumulative visual-row prefix) plus the
    // same pagination formula the worker applied to glyphs. No slot reads,
    // no neighbor walks. The caret obeys the same layout invariants the
    // glyphs do, so it aligns even on empty lines, post-wrap segments, and
    // beyond pagination breaks. The overlay quad child renders just above
    // the glyph plane (renderOrder = 5).

    static CARET_COLOR = { r: 1.0, g: 0.85, b: 0.2 };
    static CARET_RENDER_ORDER = 5;  // above glyphs (0), below HUD (999+)

    /**
     * Begin edit mode. Initializes cursor at the end of content if not
     * already set, then shows the caret. Idempotent.
     */
    enterEdit() {
        if (!this._cursor) {
            const lastLine = Math.max(0, this.lines.length - 1);
            const lastCol  = cpLen(this.lines[lastLine] ?? '');
            this._cursor = { line: lastLine, col: lastCol };
        }
        this._initCaretMesh();
        this._updateCaretMesh();
    }

    /**
     * Exit edit mode. Hides the caret and forgets the cursor.
     */
    exitEdit() {
        if (this._caretMesh) this._caretMesh.visible = false;
        this._cursor = null;
        this._emitCursorChange();
    }

    /** @returns {{line:number, col:number}|null} */
    getCursor() {
        return this._cursor ? { line: this._cursor.line, col: this._cursor.col } : null;
    }

    /**
     * Subscribe to cursor lifecycle (enter / move / relayout-clamp / exit). The
     * callback receives getCursor()'s value — null on exit. The interaction
     * context and 2D companions consume this instead of polling.
     * @param {(cursor: {line:number,col:number}|null) => void} fn
     * @returns {() => void} unsubscribe
     */
    onCursorChange(fn) {
        (this._cursorListeners ??= new Set()).add(fn);
        return () => { this._cursorListeners?.delete(fn); };
    }

    /** @private */
    _emitCursorChange() {
        if (!this._cursorListeners?.size) return;
        const c = this.getCursor();
        for (const fn of this._cursorListeners) {
            try { fn(c); }
            catch (err) { console.error('[CodeGrid] cursor listener error:', err); }
        }
    }

    /** True if content was edited since load / last save — drives the HUD's unsaved (•) marker. */
    isModified() { return this._modified === true; }

    /** Clear the modified flag. Called by file.save after a successful write. */
    markSaved() { this._modified = false; }

    /**
     * Move the cursor to (line, col), clamping to valid bounds. Repaints
     * the caret. No-op if not in edit mode.
     */
    setCursor(line, col) {
        if (!this._cursor) return;
        this._cursor = clampCursor(this.lines, line, col);
        this._updateCaretMesh();
    }

    /** Insert a string at the cursor. Splits on `\n` to span multiple lines. */
    editInsert(str) {
        if (!this._cursor || !str) return;
        insertText(this.lines, this._cursor, str);
        this._relayoutPreservingCursor();
    }

    /** Backspace: delete char before cursor; if at col 0, join with previous line. */
    editDeleteBackward() {
        if (!this._cursor) return;
        const { line, col } = this._cursor;
        if (col === 0 && line === 0) return;
        deleteBackward(this.lines, this._cursor);
        this._relayoutPreservingCursor();
    }

    /** Delete: delete char at cursor; if at end of line, join next line in. */
    editDeleteForward() {
        if (!this._cursor) return;
        const { line, col } = this._cursor;
        if (line >= this.lines.length - 1 && col >= cpLen(this.lines[line] ?? '')) return;
        deleteForward(this.lines, this._cursor);
        this._relayoutPreservingCursor();
    }

    /** Enter: split current line at cursor; cursor moves to start of new line. */
    editSplitLine() {
        if (!this._cursor) return;
        splitLine(this.lines, this._cursor);
        this._relayoutPreservingCursor();
    }

    /**
     * Move cursor by relative offsets. Negative wraps line boundaries
     * naturally (left at col 0 → end of previous line; right at end of
     * line → start of next line).
     */
    editMoveCursor(dx, dy) {
        if (!this._cursor) return;
        this._cursor = moveCursor(this.lines, this._cursor, dx, dy);
        this._updateCaretMesh();
    }

    /** Home: jump to col 0 on the current line. */
    editHome() {
        if (!this._cursor) return;
        this.setCursor(this._cursor.line, 0);
    }

    /** End: jump to end of current line. */
    editEnd() {
        if (!this._cursor) return;
        const len = cpLen(this.lines[this._cursor.line] ?? '');
        this.setCursor(this._cursor.line, len);
    }

    /**
     * Lazy-create the caret mesh on first enterEdit. A thin vertical bar
     * sized to the line height; positioned per cursor by _updateCaretMesh.
     * @private
     */
    _initCaretMesh() {
        if (this._caretMesh) return;
        this._caretMesh = createCaretMesh({
            color: CodeGrid.CARET_COLOR,
            renderOrder: CodeGrid.CARET_RENDER_ORDER,
        });
        this.add(this._caretMesh);
    }

    /**
     * Position the caret mesh at the current cursor.
     * @private
     */
    _updateCaretMesh() {
        if (!this._caretMesh || !this._cursor) return;
        const pos = this._resolveCaretWorldPosition(this._cursor.line, this._cursor.col);
        positionCaretMesh(this._caretMesh, pos, this.metrics);
        this._emitCursorChange();
    }

    /**
     * Rebuild glyphs after a content mutation, clearing stale highlights and
     * re-painting the caret.
     *
     * Edit ops fire-and-forget the returned promise. Routes through the SHARED _relayout mutex
     * so edit and scroll/layout relayouts serialize. _linesDirty tells _relayout to re-sync
     * content from the edit-mutated line array (cursor clamp + repaint live in _relayout).
     *
     * @private
     * @returns {Promise<this>}
     */
    async _relayoutPreservingCursor() {
        this._linesDirty = true;
        this._modified = true;   // a content edit (insert/delete/split) happened → unsaved until file.save
        return this._relayout();
    }

    /**
     * Update background to match content size
     * @private
     */
    _updateBackground() {
        // Content changed — _getContentBounds derives the extent fresh (closed form, O(1)),
        // so the panel just re-fits to it. Nothing is cached and nothing can be stale.
        this._sizeBackgroundTo(this._getContentBounds());
    }

    /**
     * Size + position the background panel to a content-bounds box. Split out of
     * _updateBackground (which first marks bounds dirty) so it can re-fit the panel to an
     * already-computed extent without forcing another base-position walk.
     * @param {{min:{x,y,z},max:{x,y,z},width:number,height:number}|null} bounds
     * @private
     */
    _sizeBackgroundTo(bounds) {
        if (!this._background || !this.config.showBackground) {
            if (this._background) this._background.visible = false;
            return;
        }
        const ls = this.metrics.lineSpacing;
        const originY = this._layoutOriginY ?? 0;
        fitBackground(this._background, bounds, this.config.backgroundPadding, this._frameRows, ls, originY, this._bgGap);
    }
}

export default CodeGrid;

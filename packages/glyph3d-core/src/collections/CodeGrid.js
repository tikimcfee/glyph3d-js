/**
 * CodeGrid — a single source file represented in 3D space.
 *
 * Directly manages a GlyphField (WebGPU / TSL) renderer for deferred
 * batching, flush, and GPU updates, plus the cursor + in-place edit ops,
 * highlight ranges, and the windowing/framing layout. (The deferred-add /
 * flush / worker-flush logic lives here.)
 *
 * Part of the layered rendering architecture:
 * - GlyphAtlas -> CodeGrid -> GridLayoutManager
 */

import * as THREE from 'three';
import { ensureMegaField } from '../MegaGlyphField.js';
import { loadStats } from '../core/loadStats.js';
import { RENDER_ORDER } from '../core/renderOrder.js';
import { BOUNDS_Z_PAD } from '../core/constants.js';
import { computeCellMetrics } from '../core/cellMetrics.js';
import { rowsUnderWrap } from '../compute/glyphBake.js';
import { windowSeedable, byteRangeForRows } from '../compute/glyphPipelineWindow.js';
import { resolveLayoutParams, DEFAULT_LAYOUT } from '../workers/builders/index.js';
import { getPipelineArena } from '../compute/GlyphLayoutCompute.js';
import ByteLayoutDescription, { buildByteLineIndex } from '../core/ByteLayoutDescription.js';
import { analyzeGrid, buildGridSemantics, buildGridSemanticsSync } from '../parsing/SyntaxColorizer.js';
import FramedGlyphField from './FramedGlyphField.js';
import { createPanelMaterial } from './panelMaterial.js';

// Reused for lines without wraps — most lines, in the common case.
// Frozen so accidental mutation surfaces immediately.

// The cursor `col` is a CODEPOINT index — the same model the editor verbs use. JS strings
// are UTF-16, so a surrogate-pair emoji (😀 = 2 code units) makes codepoint indices diverge
// from String.slice/.length. These convert, so edits never land inside a surrogate pair
// (which splits/corrupts an emoji) nor at the wrong offset (inserting before the caret).
// For ASCII they're identity, so the common path is unaffected.
/** Codepoint index → UTF-16 offset within `str`. */
function cpToU16(str, cp) {
    let u = 0;
    for (let n = 0; n < cp && u < str.length; n++) u += str.codePointAt(u) > 0xFFFF ? 2 : 1;
    return u;
}
/** Count of CODEPOINTS in `str` (not UTF-16 code units). */
function cpLen(str) {
    let n = 0;
    for (let u = 0; u < str.length; n++) u += str.codePointAt(u) > 0xFFFF ? 2 : 1;
    return n;
}

/** The byte pipeline's encoder (one per module — TextEncoder is stateless). */
const _textEncoder = new TextEncoder();

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
            shaper: options.shaper || (atlas && atlas._shaper) || null,
            // Layout params — how this file folds into space (Step 3a). Per-grid; threaded
            // through the build's `shared` channel AND read by _buildLayoutDescription's geom,
            // so the glyphs and the caret/highlight queries can never fold differently.
            layout: { ...DEFAULT_LAYOUT, ...(options.layout || {}) },
            // Windowed staging (slots are a CACHE): a file at/above windowMinBytes with a
            // baked record stages only rows [scroll − margin, scroll + span + margin) as
            // its arena item — the index seeds the window, the item-reset fold computes it
            // exactly, the record supplies the full-file measure. 0 disables.
            windowMinBytes: options.windowMinBytes ?? 256 * 1024,
            // Window span in visual rows when no clip frame is set (a frame's rows win).
            windowRows: options.windowRows ?? 600,
            // Hysteresis: rows staged beyond the view on each side — scroll inside the
            // margin is a repaginate; crossing it re-stages one window.
            windowMarginRows: options.windowMarginRows ?? 200,
        };

        // Content state
        this.filename = '';
        this.sourcePath = null;
        this.content = '';
        this.lines = [];

        /** Windowed staging state: {from, to, startRow, endRow, totalRows} when only a
         *  byte window of this file is staged (see _resolveByteWindow), else null. */
        this._byteWindow = null;

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
        this.scene.add(this._rendererGroup);

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

        // Content bounds are NOT stored: they are the layout's extent, derived from the
        // pipeline's CPU mirror in O(1) (_getContentBounds). World box (getBounds) is
        // BoundedObject3D's, derived per call.
        // The byte-pipeline engine state: this grid's ITEM HANDLES into the shared
        // GlyphPipelineArena (one pipeline per app — the multi-file hoist), the file's
        // bytes, and the newline byte-offset index. A handle carries { itemIndex,
        // byteStart, byteLength, mirror, setPage, verify, dispose }.
        this._pipeline = null;
        this._filenamePipeline = null;
        this._filenameField = null;
        this._bytes = null;
        this._byteLineIndex = null;

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
        // The caret is a decoration: re-painted from the (now buffer-backed) layout after
        // every fold, exactly like an external overlay. _updateCaretMesh guards on cursor.
        this._decorations.push({ name: 'caret', apply: (g) => g._updateCaretMesh() });
    }

    // ── Relayout pipeline: registries + stages ───────────────────────────────────

    /**
     * Register an arranger — a footprint-changing participant re-applied INSIDE every
     * fold (before bounds). NOT SUPPORTED on the byte pipeline yet — displacement tables
     * are indexed by codepoint slot and the byte pipeline is byte-indexed; until arrangers
     * are re-based, registration throws loudly rather than arranging wrong.
     */

    /** Register an arranger. NOT SUPPORTED on the byte pipeline yet — displacement tables
     *  are indexed by codepoint slot and the byte pipeline is byte-indexed; until arrangers
     *  are re-based, registration throws loudly rather than arranging wrong. */
    registerArranger(a) {
        throw new Error('CodeGrid.registerArranger: arrangers are not on the byte pipeline yet (deferred — see the Layer 2 wiring plan, M5)');
    }
    /** Remove a previously-registered arranger. */
    unregisterArranger(a) { const i = this._arrangers.indexOf(a); if (i >= 0) this._arrangers.splice(i, 1); }

    /** Register a decoration — a footprint-neutral overlay re-applied after bounds settle. */
    registerDecoration(d) { if (d && !this._decorations.includes(d)) this._decorations.push(d); }
    /** Remove a previously-registered decoration. */
    unregisterDecoration(d) { const i = this._decorations.indexOf(d); if (i >= 0) this._decorations.splice(i, 1); }

    /**
     * The ARRANGE stage. No-op (and zero cost) when nothing is registered — and nothing can
     * register until arrangers are byte-native (registerArranger throws).
     * @private
     */
    _applyArrangers() {
        if (!this._arrangers.length || !this._renderer) return;
        for (const a of this._arrangers) a.arrange?.(this);
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
     * Shared load preamble: stash content + lines, reconstruct an evicted renderer, and queue
     * the clear. Everything up to the one layout call lives here once — content and lines are
     * always set together, on every load.
     *
     * TODO(load+normalize): content is stored RAW. A future "load & normalize data" pass belongs
     * here — normalize line endings (\r\n, \r → \n), strip BOM, settle encoding — ONCE at the load
     * seam so every downstream consumer can assume \n. Today \r\n drifts the two render targets
     * apart: split('\n') leaves \r in a line (a \r buffer slot in 3D), while CodeMirror strips \r in
     * the 2D editor, so tree-sitter capture offsets (indexed into this raw text) misalign across the
     * views. Normalizing here removes the whole off-by-N class. See EditorPanel + SyntaxColorizer.
     * @private @param {string} text
     */
    _beginLoad(text) {
        this.content = text;                 // the new data (content + lines set together)
        this.lines = text.split('\n');
        // The byte pipeline's input: UTF-8 bytes + the newline index (the only line
        // structure — the GPU walk derives row/col itself).
        this._bytes = _textEncoder.encode(text);
        this._byteLineIndex = buildByteLineIndex(this._bytes);
        // The baked record describes the DISK file — a load of different content
        // (grid.window slices, hex views, any non-file text) must not keep it: its
        // checkpoints would seed garbage windows and its measure would lie.
        if (this._bakedRecord && this._bakedRecord.byteLength !== this._bytes.length) {
            this._bakedRecord = null;
            this._byteWindow = null;
            if (this._renderer) this._renderer.sourceBase = 0;
            console.info(`[bake] ${this.filename || this.name}: loaded text is not the baked content — record dropped`);
        }
        // No growth path: the view is unsized — capacity is the ARENA's (it grows
        // itself); a bigger file just stages a bigger item.
        this._ensureRenderer();              // reconstruct if content was evicted
        this._clearRenderedText();           // drop the PRIOR render's glyphs; the layout below adds the new ones
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
        await this._relayout();
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
        const max = Math.max(0, total - this._winRows);
        this._winFirstLine = Math.max(0, Math.min(this._winFirstLine, max));
    }

    /**
     * @private Render the current window slice through the normal async load
     * path (the full source lives in _sourceLines; this only re-feeds the slice).
     */
    async _renderWindow() {
        const src = this._sourceLines || [];
        const first = this._winFirstLine;
        const slice = src
            .slice(first, first + this._winRows)
            .map((line) => line.slice(0, this._winCols))
            .join('\n');
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
        this._bytes = null;
        this._byteLineIndex = null;
        this._layout = null;
        this._bakedRecord = null;
        this._byteWindow = null;
        if (this._renderer) this._renderer.sourceBase = 0;
        // Detach from the arena items (their space leaks — v1; see the arena header) so a
        // later realloc never re-attaches this field at a stale byteStart.
        this._pipeline?.dispose?.();
        this._pipeline = null;
        this._filenamePipeline?.dispose?.();
        this._filenamePipeline = null;

        if (this._renderer) this._renderer.clear();
        if (this._filenameField) this._filenameField.clear();
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

    // getRenderer() is inherited from FramedGlyphField (returns the mega-field VIEW —
    // canvas picking maps a resolved glyph hit back to this grid through it).

    /**
     * Wire the PickingSystem. Overrides FramedGlyphField: the glyph channel is the
     * MEGA-FIELD's one registration (every byte view shares it — a view has no mesh
     * to register); only the 'grid' channel (the background panel) is per-grid.
     * @param {import('../picking/PickingSystem.js').PickingSystem} pickingSystem
     */
    setPickingSystem(pickingSystem) {
        this._pickingSystem = pickingSystem;
        if (!pickingSystem) return;
        if (this._background) pickingSystem.register('grid', this._background, this);
        getPipelineArena()?.megaField?.setPickingSystem(pickingSystem);
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
            do {
                this._relayoutPending = false;
                this.getLineCount();                       // ensure this.lines is populated
                if (this._linesDirty) {                    // edits mutate this.lines → resync content
                    this.content = this.lines.join('\n');
                    this._linesDirty = false;
                }
                // Empty CONTENT still lays out when there's a filename: the label is
                // its own arena item, and an empty file in a tree keeps its nameplate.
                if (!this.content && !this.filename) continue;   // nothing at all (loop exits unless pending)
                this._ensureRenderer();                    // reconstruct if content was evicted
                this._clearRenderedText();                 // drop the prior render's glyphs
                // The staged pipeline: FOLD (+ ARRANGE, inside _layoutContent) → FIT →
                // clamp → DECORATE. There is no bounds STAGE any more: the extent is a closed
                // form the fold already determined (_getContentBounds), so the panel just reads
                // it. Arrangers ran inside the fold, so what it reads is the arranged footprint.
                await this._layoutContent();               // FOLD: re-add + re-flush + line tables + _layout (+ arrange)
                this._updateBackground();                  // FIT: re-fit the panel to the settled extent
                // Clamp the edit caret into the fresh content before the decorate stage paints it.
                if (this._cursor) {
                    const ln = Math.max(0, Math.min(this._cursor.line, this.lines.length - 1));
                    const cl = Math.max(0, Math.min(this._cursor.col, cpLen(this.lines[ln] ?? '')));
                    this._cursor.line = ln;
                    this._cursor.col = cl;
                }
                this._applyDecorations();                  // DECORATE: caret + external overlays, re-projected onto the new fold
            } while (this._relayoutPending);
        } finally {
            this._relayoutBusy = false;
        }
        return this;
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
        const clamped = Math.max(0, Math.min(Math.round(rows), this.getMaxScroll()));
        if (clamped === this._scrollOffset) return this;
        this._scrollOffset = clamped;
        // WINDOWED grid leaving its staged rows: one re-stage of a fresh window around
        // the new position (the hysteresis margin makes this a crossing cost, not a
        // per-tick cost — ticks inside the margin take the repaginate path below).
        if (!this._windowCovers(clamped)) {
            // Crossing: one re-stage of a fresh window — through the relayout MUTEX
            // (a raw _layoutContent here could interleave with an edit's relayout and
            // double-stage). _relayout re-resolves the window, refits, redecorates.
            return this._relayout();
        }
        // The conveyor is kernel 3 only: re-arm the item's page params with the new scroll
        // and repaginate — no decode, no walk, no reload. Scroll ticks across grids
        // coalesce into ONE repaginate dispatch (the arena's repaginate gate). The mirror
        // re-paginates in place, so the panel, caret and extent read the scrolled state
        // synchronously.
        const lp = resolveLayoutParams(this._foldLayout());
        await this._pipeline?.setPage(this._pageParams(lp, this.metrics));
        this._updateBackground();
        this._applyDecorations();
        return this;
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
        // Windowed: the pipeline's rows are the WINDOW's — the file's total comes from
        // the baked record (exact: rowsUnderWrap, resolved when the window was).
        if (this._byteWindow) return this._byteWindow.totalRows;
        return Math.round(this._pipeline?.bounds?.totalRows || 0);
    }

    /**
     * Max scroll offset (hard-stop). With a frame, stop so the last frameRows fill the
     * window; without one, allow scrolling to the last row.
     * @returns {number}
     */
    getMaxScroll() {
        const total = this.getTotalVisualRows();
        return this._frameRows > 0 ? Math.max(0, total - this._frameRows) : total;
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
        this._updateBackground();  // panel tracks the frame even when no scroll re-clamp/relayout is needed
        const clamped = Math.max(0, Math.min(this._scrollOffset, this.getMaxScroll()));
        if (clamped !== this._scrollOffset) return this.setScrollOffset(clamped);
        // The frame is a footprint input to the staged WINDOW (span = frameRows when
        // set): growing it can expose rows the window never staged — blank glyphs no
        // scroll would heal. Re-stage when the staged rows no longer cover the view.
        if (!this._windowCovers(this._scrollOffset)) await this._relayout();
        return this;
    }

    /**
     * Do the staged window's rows cover the view at `scroll`? True for full-staged
     * grids. The bottom check is inert once the window already reaches the file's
     * last row — near EOF there is nothing more to stage, and without this escape
     * every tick in the last `span` rows would re-stage (getMaxScroll allows
     * scrolling to the last row when frameless).
     * @private
     */
    _windowCovers(scroll) {
        const w = this._byteWindow;
        if (!w) return true;
        const span = Math.max(1, this._frameRows || this.config.windowRows);
        if (scroll < w.startRow) return false;
        if (scroll + span > w.endRow && w.endRow < w.totalRows) return false;
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
            const ls = this.metrics.lineHeight;
            const originY = this._layoutOriginY ?? 0;
            this._renderer.setClipYRange(originY + 0.5 * ls, originY - (this._frameRows - 0.5) * ls);
        } else {
            this._renderer.setClipYRange(null, null);
        }
    }

    /**
     * Dispose of all resources
     */
    dispose() {
        // Leave the grid picking channel cleanly before the panel is torn down, or the
        // pass would swap materials onto a disposed mesh. (The glyph channel is the
        // mega-field's ONE registration — a view dispose just tombstones its range.)
        if (this._pickingSystem && this._background) {
            this._pickingSystem.unregister('grid', this._background);
        }

        // Dispose the views (range → dead group; the mega mesh lives on)
        if (this._renderer) {
            this._renderer.dispose();
            this._renderer = null;
        }
        if (this._filenameField) {
            this._filenameField.dispose();
            this._filenameField = null;
        }
        // Detach the arena handles BEFORE any realloc could re-attach the dead views.
        this._pipeline?.dispose?.();
        this._pipeline = null;
        this._filenamePipeline?.dispose?.();
        this._filenamePipeline = null;

        // Remove renderer group from scene
        if (this._rendererGroup) {
            this.scene.remove(this._rendererGroup);
            while (this._rendererGroup.children.length > 0) {
                this._rendererGroup.remove(this._rendererGroup.children[0]);
            }
        }

        this._disposePanel();   // free + detach the background panel (FramedGlyphField)

        // Dispose caret overlay (lazy-created in enterEdit)
        if (this._caretMesh) {
            this._caretMesh.geometry.dispose();
            this._caretMesh.material.dispose();
            this.remove(this._caretMesh);
            this._caretMesh = null;
        }

        this._resetBatchState();
        this.content = '';
        this.lines = [];
        this._contentTextIds = [];
    }

    // ============ Private Methods ============

    /**
     * Compute atlas-derived metrics. Called at construction and after atlas swap.
     * @private
     * @returns {Object} { charWidth, charHeight, lineHeight, spacing }
     */
    _computeMetrics() {
        const atlasCharSize = this.atlas.getCharSize();
        const scale = this.config.worldScale;
        const m = computeCellMetrics(atlasCharSize, scale);
        return { charWidth: m.charWidth, charHeight: m.charHeight, lineHeight: m.lineSpacing, spacing: m.letterSpacing };
    }

    /**
     * Ensure the grid's render presence exists — a VIEW into the app's ONE
     * mega-field (the arena's render face), not a per-grid GlyphField: the view is
     * unsized (the arena owns capacity), so there is nothing to reconstruct after
     * eviction beyond re-creating the facade. Called at the top of loadText() so
     * that method is safe to use on evicted grids.
     * @private
     */
    _ensureRenderer() {
        if (this._renderer) return; // already present
        this._createRendererView();

        // Re-derive metrics in case atlas changed
        this.metrics = this._computeMetrics();
    }

    /**
     * Create this grid's mega-field VIEW and wire it up. The view facade speaks the
     * GlyphField surface (colors, highlight, alpha, clip) offset into the shared
     * field; the grid itself is the view's pose node (its matrixWorld is the view's
     * group texel). No per-grid GPU objects — the whole point of the mega-field.
     * @private
     */
    _createRendererView() {
        const arena = getPipelineArena();
        if (!arena) {
            // Loud once, not per grid: no arena means no WebGPU compute — the byte
            // pipeline (and so the mega-field) cannot exist; the grid stays empty.
            if (!CodeGrid._noArenaNoted) {
                CodeGrid._noArenaNoted = true;
                console.error('CodeGrid: no pipeline arena — the byte pipeline needs WebGPU; this grid renders EMPTY (boot log has the reason)');
            }
            this._renderer = null;
            return;
        }
        if (this.config.occluder && !CodeGrid._occluderByteNoted) {
            CodeGrid._occluderByteNoted = true;
            console.warn('CodeGrid: occluder LOD is not byte-native yet — rendering via the mega-field glyph path');
        }
        this._renderer = ensureMegaField(arena, {
            scene:         this.scene,
            atlas:         this.atlas,
            worldScale:    this.config.worldScale,
            slugData:      this.config.slugData,
            shaper:        this.config.shaper,
            pickingSystem: this._pickingSystem,
        }).createView({ node: this, color: this.config.textColor });
        // Fade glyphs to match the panel from the start, so a translucent grid reads
        // as one coherent sheet.
        this._applyGlyphAlpha();
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
        const geometry = new THREE.PlaneGeometry(1, 1);
        // The panel material paints the fill AND an in-shader border band (see panelMaterial.js):
        // border strength 0 = a plain fill, drop-in for the old MeshBasicMaterial. depthWrite: the
        // panel must OCCLUDE content behind it (other grids stacked in a dock); `transparent` only
        // when opacity<1, so a full-opacity panel stays genuinely solid.
        this._panel = createPanelMaterial({
            color: this.config.backgroundColor,
            opacity: this.config.backgroundOpacity,
            side: THREE.DoubleSide,
            depthWrite: true,
        });

        this._background = new THREE.Mesh(geometry, this._panel.material);
        this._background.renderOrder = RENDER_ORDER.GRID_BACKGROUND; // Draw backgrounds before glyphs
        this._background.position.z = -0.1; // Just behind text — minimal float
        this._background.visible = this.config.showBackground;
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
     * Layout content — the byte-in GPU pipeline IS the layout: stage the bytes into the
     * SHARED pipeline arena (this grid is one item) → the coalesced flush dispatches the
     * whole storm in three dispatches. No worker, no builder, no CPU fold, no per-grid
     * kernels. The filename rides its own tiny field as another arena item above the
     * content.
     * @private
     */
    async _layoutContent() {
        // The filename: its own VIEW + arena item at y=0; the content sits 1.5 rows below.
        if (this.config.showFilename && this.filename) {
            await this._layoutFilename();
        } else if (this._filenameField) {
            this._filenameField.setVisible(false);
        }
        this._layoutOriginY = (this.config.showFilename && this.filename)
            ? -this.metrics.lineHeight * 1.5
            : 0;

        if (this.content.length > 0) {
            const m = this.metrics;
            const lp = resolveLayoutParams(this._foldLayout());
            const arena = getPipelineArena();
            // No arena → no view either (_createRendererView logged the loud-once
            // error); the grid stays empty rather than storming shader errors.
            if (!arena || !this._renderer) return;
            // WINDOWED staging: a large baked file stages only its viewed rows. The
            // window snaps to a row start, so the arena's fresh per-item fold computes
            // it exactly — the only cross-window fact is the start row, carried as the
            // scrollRows bias (_windowScroll). The view keeps speaking file bytes
            // through sourceBase; the record supplies the full-file measure.
            //
            // Stage the NEW item BEFORE disposing the old: if the arena refuses (the
            // f32-ordinal wall — window churn is append-only until compaction), the
            // grid keeps its previous window rendering instead of wedging on a dead
            // pipeline. An INITIAL load still fails loud (nothing previous to keep).
            const prevPipeline = this._pipeline;
            const prevWindow = this._byteWindow;
            this._byteWindow = this._resolveByteWindow(lp, arena);
            if (this._renderer) this._renderer.sourceBase = this._byteWindow?.from || 0;
            let staged;
            try {
                staged = arena.stage({
                    bytes: this._byteWindow
                        ? this._bytes.subarray(this._byteWindow.from, this._byteWindow.to)
                        : this._bytes,
                    origin: { x: 0, y: this._layoutOriginY, z: 0 },
                    page: this._pageParams(lp, m),
                    wrapWidth: lp.wrapWidth || 0,
                    lineHeight: m.lineHeight,
                    zStep: m.charHeight * (lp.zWrapSpacing || 0),
                    field: this._renderer,
                });
            } catch (err) {
                if (!prevPipeline) throw err;
                this._byteWindow = prevWindow;
                if (this._renderer) this._renderer.sourceBase = prevWindow?.from || 0;
                console.error(`[window] ${this.filename || this.name}: re-stage refused (${err?.message || err}) — keeping the previous window (compaction is the lift)`);
                return;
            }
            // The prior item's arena space leaks (v1 — see the arena header); dispose just
            // detaches this view from the old item so a realloc never re-attaches it stale.
            // The view already tombstoned its old slot range on the re-attach above.
            prevPipeline?.dispose?.();
            this._pipeline = staged;
            await arena.requestFlush();
            // The extent gate: the GPU's per-item bounds land off ONE coalesced readback;
            // waiting here means the load's settle sees a MEASURED grid (tree layout,
            // scroll clamps and culling all read the record). Resolves even on device
            // loss — a load never hangs on it.
            await this._pipeline.laid;

            // The bake gate: the GPU's bounds vs the index's prediction, once per load.
            // Rows are integer-exact under any wrap; the widest row compares only when
            // nothing folds (a folded line's segments aren't derivable from the record).
            // A mismatch means a stale record or fold drift — loud, never corrected
            // silently (the GPU extent is the truth either way).
            if (this._bakedRecord && !this._bakedChecked && this._pipeline.bounds) {
                this._bakedChecked = true;
                const rec = this._bakedRecord;
                const wrap = Math.max(0, Math.trunc(lp.wrapWidth || 0));
                const got = this._pipeline.bounds;
                // Windowed: the GPU folded rows [startRow, endRow) — every row in a
                // window holds a leader, so the item's row count is the span exactly.
                const wantRows = this._byteWindow
                    ? this._byteWindow.endRow - this._byteWindow.startRow
                    : rowsUnderWrap(rec, wrap);
                if (Math.round(got.totalRows) !== wantRows) {
                    console.warn(`[bake] ${this.filename || this.name}: baked rows(wrap ${wrap}) = ${wantRows} ≠ GPU ${got.totalRows} — stale record or fold drift`);
                } else if (!this._byteWindow && (wrap === 0 || rec.maxLineLen <= wrap)) {
                    // Full stage only: a window's widest row is the window's, not the file's.
                    const rel = Math.abs(got.maxRowExtent - rec.maxRowExtent) / Math.max(1, rec.maxRowExtent);
                    if (rel > 1e-4) {
                        console.warn(`[bake] ${this.filename || this.name}: baked widest row ${rec.maxRowExtent} vs GPU ${got.maxRowExtent} (rel ${rel.toExponential(2)}) — metrics drift?`);
                    }
                }
            }
        }
        this._buildLayoutDescription();
        this._applyClip();
        // (No per-grid pick registration: the mega-field holds the ONE glyph-channel
        // entry and re-registers itself as its instance count grows.)

        // If content shrank below the scroll position (e.g. an edit deleted lines while a
        // frame was active), the conveyor shifted past the end and the framed window would be
        // left blank. Clamp to the now-smaller max and rebuild ONCE (guarded against re-entry)
        // so it self-corrects this pass instead of waiting for the next scroll. Rare — only
        // fires when actually over-scrolled.
        if (!this._scrollClampGuard && this._scrollOffset > this.getMaxScroll()) {
            this._scrollClampGuard = true;
            this._scrollOffset = this.getMaxScroll();
            this._clearRenderedText();
            await this._layoutContent();
            this._scrollClampGuard = false;
            return;
        }
        this._applyArrangers(); // ARRANGE stage — empty until arrangers are byte-native
    }

    /**
     * Layout params → the pipeline's page params. One gate (screenRow >= pageRows, in the
     * kernel), so pageRows flows straight through; the strides mirror the Layer 1 fold:
     * newspaper bands step DOWN in y, z-pages recede per page, and the x stride is the
     * mirror's measured widest row + the gap (computed by the adapter, never nominal).
     * @private
     */
    _pageParams(lp, m) {
        const rows = Math.max(0, Math.trunc(lp.pageHeight || 0));
        if (rows === 0) return { scrollRows: this._windowScroll() };
        const charAdvance = m.charWidth + (m.spacing || 0);
        if ((lp.axis || 'xy') === 'z') {
            return {
                pageRows: rows, pagesWide: 1,
                depthPerBand: (lp.pageDepth || 0) * m.lineHeight,
                scrollRows: this._windowScroll(),
            };
        }
        return {
            pageRows: rows,
            pagesWide: Math.max(1, Math.trunc(lp.pagesWide || 1)),
            pageGapX: (lp.pageGapX || 0) * charAdvance,
            bandStrideY: rows * m.lineHeight + (lp.pageGapY || 0) * m.lineHeight,
            scrollRows: this._windowScroll(),
        };
    }

    /**
     * The kernel-facing scroll: window-relative. A windowed item's rows count from its
     * own start, so the absolute scroll carries the window's start row as a bias —
     * screenRow = (row − startRow) − (scroll − startRow) = absolute row − absolute
     * scroll, the identical remap. Non-negative by construction: the window never
     * starts below the scroll position (startRow = scroll − margin, clamped).
     * @private
     */
    _windowScroll() {
        return Math.max(0, (this._scrollOffset || 0) - (this._byteWindow?.startRow || 0));
    }

    /**
     * Should this load stage a WINDOW instead of the whole file? Yes when the file is
     * large, its baked record can seed exactly (no wrapping lines — windowSeedable),
     * and the view is unpaged (a paged item derives its fan stride from its OWN widest
     * row, which for a window is the window's, not the file's — paged windowing waits
     * on carrying the baked stride in). Returns the byte range + rows, or null = full.
     * @private
     * @returns {?{from:number, to:number, startRow:number, endRow:number, totalRows:number}}
     */
    _resolveByteWindow(lp, arena) {
        const rec = this._bakedRecord;
        const cfg = this.config;
        if (!rec || !(cfg.windowMinBytes > 0) || this._bytes.length < cfg.windowMinBytes) return null;
        if (Math.trunc(lp.pageHeight || 0) > 0) return null;
        const wrap = Math.max(0, Math.trunc(lp.wrapWidth || 0));
        if (!windowSeedable(rec, wrap)) {
            if (!this._windowRefusedNoted) {
                this._windowRefusedNoted = true;
                console.info(`[bake] ${this.filename || this.name}: lines wrap at ${wrap} — windowed staging off, full fold`);
            }
            return null;
        }
        const trie = arena?.trie;
        if (!trie) return null;
        const totalRows = rowsUnderWrap(rec, wrap);
        const span = Math.max(1, this._frameRows || cfg.windowRows);
        const margin = Math.max(0, cfg.windowMarginRows);
        const s = Math.min(this._scrollOffset || 0, Math.max(0, totalRows - 1));
        const r0 = Math.max(0, s - margin);
        const r1 = Math.min(totalRows, s + span + margin);
        if (r0 <= 0 && r1 >= totalRows) return null;      // the window IS the file
        const w = byteRangeForRows(this._bytes, trie, rec, r0, r1, wrap);
        if (!w || (w.from === 0 && w.to >= this._bytes.length)) return null;
        return { from: w.from, to: w.to, startRow: r0, endRow: r1, totalRows };
    }

    /**
     * The filename's own VIEW (its own group: independent color + visibility toggle),
     * staged into the SAME arena as the content — its own item at y=0 above the
     * content (wrap 0: a label never folds). Poses off the same grid node.
     * @private
     */
    async _layoutFilename() {
        const arena = getPipelineArena();
        if (!arena) return;   // the content path already logged the loud-once error
        if (!this._filenameField) {
            this._filenameField = ensureMegaField(arena, {
                scene: this.scene, atlas: this.atlas,
                worldScale: this.config.worldScale,
                pickingSystem: this._pickingSystem,
            }).createView({ node: this, color: this.config.filenameColor });
        }
        this._filenameField.setVisible(true);
        // Same name already staged → keep its item (a windowed grid re-runs
        // _layoutContent on every window crossing; the label hasn't moved).
        if (this._filenamePipeline && this._filenameStagedText === this.filename) return;
        this._filenameStagedText = this.filename;
        this._filenamePipeline?.dispose?.();
        this._filenamePipeline = arena.stage({
            bytes: _textEncoder.encode(this.filename),
            origin: { x: 0, y: 0, z: 0 },
            page: null,
            wrapWidth: 0,
            lineHeight: this.metrics.lineHeight,
            zStep: 0,
            field: this._filenameField,
        });
        await arena.requestFlush();
    }

    /**
     * The content bounds in this grid's local frame — the pipeline's extent, derived from
     * the CPU mirror (the oracle the GPU slots are gate-checked against). Synchronous by
     * construction: the mirror paginates in place on scroll/mode changes, so there is no
     * readback and nothing to invalidate.
     * @private
     * @returns {{min:{x,y,z}, max:{x,y,z}, width:number, height:number, depth:number}|null}
     */
    _getContentBounds() {
        // Windowed: the pipeline's extent is the WINDOW's box; the grid's real footprint
        // is the file's, and in the windowed regime (no wrapping lines) the record's
        // derivation is exact — rows from the histogram, width the true widest line.
        if (this._byteWindow) return this._bakedPriorExtent() ?? this._layout?.extent() ?? null;
        return this._layout?.extent() ?? this._bakedPriorExtent();
    }

    /**
     * Attach this file's BAKED record (the repo's layout index — glyphBake.js). Two
     * consumers: _bakedPriorExtent measures the grid before its bytes are laid (the
     * load storm's mid-stream pours place a real footprint instead of a unit box),
     * and the post-laid gate checks the GPU's bounds against the baked prediction.
     * @param {{leaders:number, maxLineWidth:number, maxLineLen:number, total:Object,
     *          lineHist:Map<number,number>}} record
     */
    setBakedRecord(record) {
        this._bakedRecord = record || null;
        this._bakedChecked = false;
    }

    /**
     * The measure PRIOR from the baked record, under this grid's CURRENT fold — used
     * only while the pipeline hasn't laid (then the GPU extent takes over). Rows are
     * EXACT for any wrap (the record's line histogram); width is exact when no line
     * folds and a bounded overestimate when one does (a segment is never wider than
     * its whole line). Pagination is ignored — the boot fold is unpaged (pageHeight
     * 0); a paged grid just measures by its unpaged column until laid.
     * @private
     * @returns {{min:Object, max:Object, width:number, height:number, depth:number}|null}
     */
    _bakedPriorExtent() {
        const rec = this._bakedRecord;
        if (!rec || !(rec.leaders > 0) || this.content.length === 0) return null;
        const m = this.metrics;
        const lp = resolveLayoutParams(this._foldLayout());
        const wrap = Math.max(0, Math.trunc(lp.wrapWidth || 0));
        const rows = rowsUnderWrap(rec, wrap);
        const originY = (this.config.showFilename && this.filename)
            ? -m.lineHeight * 1.5
            : 0;
        const zStep = m.charHeight * (lp.zWrapSpacing || 0);
        const segs = wrap > 0 ? Math.max(1, Math.ceil(rec.maxLineLen / wrap)) : 1;
        const min = { x: 0, y: originY - (rows - 1) * m.lineHeight, z: -(segs - 1) * zStep };
        // Top edge follows the layout origin: with a filename shown, content starts
        // 1.5 rows down — a charHeight-at-zero top would slab the panel over the label.
        const max = { x: rec.maxLineWidth, y: originY + m.charHeight, z: 0 };
        return {
            min, max,
            width: max.x - min.x, height: max.y - min.y, depth: max.z - min.z,
        };
    }

    // ============ Line → Byte-Slot Mapping ============

    /** The wrap width the CURRENT fold uses (arranger overrides included). @private */
    _foldWrapWidth() {
        return Math.max(0, Math.trunc(resolveLayoutParams(this._foldLayout()).wrapWidth || 0));
    }

    /**
     * Build the queryable description for the current layout — the ONE source the caret /
     * highlight / selection query against (positionAt, slotForChar) AND the source of the
     * content's own extent (extent()). Byte-backed: slot == source byte offset, positions
     * read the pipeline's CPU mirror (the oracle the GPU is gate-checked against).
     * Rebuilt every load. @private
     */
    _buildLayoutDescription() {
        const idx = this._byteLineIndex;
        // The HANDLE, not the mirror: touching .mirror here would materialize the CPU
        // oracle for every loaded grid — extent() reads the GPU bounds record instead,
        // and the oracle materializes on the first actual slot query (caret/edit).
        this._layout = (idx && this._pipeline) ? new ByteLayoutDescription({
            bytes: this._bytes,
            lineByteStart: idx.lineByteStart,
            lineLengths: idx.lineLengths,
            pipeline: this._pipeline,
            scrollOffset: this._scrollOffset || 0,
            sourceBase: this._byteWindow?.from || 0,
        }) : null;
        this._scheduleAnalyze();
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
        const text = this.lines[line];
        const len = text.length;
        let count = 0;
        for (let i = 0; i < len; ) {
            const cp = text.codePointAt(i);
            count++;
            i += cp > 0xFFFF ? 2 : 1;
        }
        return count;
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
        if (!this._renderer || !this._layout) return;

        for (let line = startLine; line <= endLine; line++) {
            const cStart = (line === startLine) ? startCol : 0;
            const cEnd   = (line === endLine)   ? endCol   : this.getLineSlotCount(line);
            for (let col = cStart; col < cEnd; col++) {
                const slot = this.getSlotForChar(line, col); // → LayoutDescription, one source
                if (slot >= 0) this._renderer.setGlyphHighlight(slot, color, fillOpacity);
            }
        }
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
        if (!this._renderer || !this._layout) return;
        const count = this.getLineSlotCount(line);
        for (let i = 0; i < count; i++) {
            const slot = this.getSlotForChar(line, i); // → LayoutDescription, one source
            if (slot >= 0) this._renderer.setGlyphHighlight(slot, null);
        }
    }

    /**
     * Clear all glyph highlights on this grid.
     * Delegates to clearLineHighlight() for each line — uses the RGBA8 DataTexture path.
     */
    clearAllHighlights() {
        if (!this._layout) return; // canonical state guard, matches clearLineHighlight
        const lineCount = this.getLineCount();
        for (let line = 0; line < lineCount; line++) {
            this.clearLineHighlight(line);
        }
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
        const ln = Math.max(0, Math.min(line, this.lines.length - 1));
        const cl = Math.max(0, Math.min(col, cpLen(this.lines[ln] ?? '')));
        this._cursor = { line: ln, col: cl };
        this._updateCaretMesh();
    }

    /** Insert a string at the cursor. Splits on `\n` to span multiple lines. */
    editInsert(str) {
        if (!this._cursor || !str) return;
        const parts = String(str).split('\n');
        const { line, col } = this._cursor;
        const cur = this.lines[line] ?? '';
        const u = cpToU16(cur, col);              // codepoint col → UTF-16 split offset
        const before = cur.slice(0, u);
        const after  = cur.slice(u);

        if (parts.length === 1) {
            this.lines[line] = before + parts[0] + after;
            this._cursor.col = col + cpLen(parts[0]);   // advance by CODEPOINTS inserted
        } else {
            const tail = parts[parts.length - 1];
            const newLines = [
                before + parts[0],
                ...parts.slice(1, -1),
                tail + after,
            ];
            this.lines.splice(line, 1, ...newLines);
            this._cursor.line = line + parts.length - 1;
            this._cursor.col  = cpLen(tail);
        }
        this._relayoutPreservingCursor();
    }

    /** Backspace: delete char before cursor; if at col 0, join with previous line. */
    editDeleteBackward() {
        if (!this._cursor) return;
        const { line, col } = this._cursor;
        if (col > 0) {
            const cur = this.lines[line] ?? '';
            // Delete the WHOLE codepoint before the caret (both surrogate halves of an emoji).
            this.lines[line] = cur.slice(0, cpToU16(cur, col - 1)) + cur.slice(cpToU16(cur, col));
            this._cursor.col = col - 1;
        } else if (line > 0) {
            const prev = this.lines[line - 1] ?? '';
            const cur  = this.lines[line] ?? '';
            this._cursor.line = line - 1;
            this._cursor.col  = cpLen(prev);
            this.lines[line - 1] = prev + cur;
            this.lines.splice(line, 1);
        } else {
            return;  // nothing to delete
        }
        this._relayoutPreservingCursor();
    }

    /** Delete: delete char at cursor; if at end of line, join next line in. */
    editDeleteForward() {
        if (!this._cursor) return;
        const { line, col } = this._cursor;
        const cur = this.lines[line] ?? '';
        if (col < cpLen(cur)) {
            // Delete the WHOLE codepoint at the caret (both surrogate halves of an emoji).
            this.lines[line] = cur.slice(0, cpToU16(cur, col)) + cur.slice(cpToU16(cur, col + 1));
        } else if (line < this.lines.length - 1) {
            this.lines[line] = cur + (this.lines[line + 1] ?? '');
            this.lines.splice(line + 1, 1);
        } else {
            return;
        }
        this._relayoutPreservingCursor();
    }

    /** Enter: split current line at cursor; cursor moves to start of new line. */
    editSplitLine() {
        if (!this._cursor) return;
        const { line, col } = this._cursor;
        const cur = this.lines[line] ?? '';
        const u = cpToU16(cur, col);
        this.lines.splice(line, 1, cur.slice(0, u), cur.slice(u));
        this._cursor.line = line + 1;
        this._cursor.col  = 0;
        this._relayoutPreservingCursor();
    }

    /**
     * Move cursor by relative offsets. Negative wraps line boundaries
     * naturally (left at col 0 → end of previous line; right at end of
     * line → start of next line).
     */
    editMoveCursor(dx, dy) {
        if (!this._cursor) return;
        let { line, col } = this._cursor;
        const lineCount = this.lines.length;

        // Vertical first. Steps are in CODEPOINTS (cpLen), so the caret crosses an emoji in one
        // press and never lands between its surrogate halves.
        if (dy) {
            line = Math.max(0, Math.min(line + dy, lineCount - 1));
            col  = Math.min(col, cpLen(this.lines[line] ?? ''));
        }

        // Then horizontal, wrapping line boundaries
        while (dx > 0) {
            const len = cpLen(this.lines[line] ?? '');
            if (col < len) { col++; dx--; continue; }
            if (line < lineCount - 1) { line++; col = 0; dx--; continue; }
            break;
        }
        while (dx < 0) {
            if (col > 0) { col--; dx++; continue; }
            if (line > 0) { line--; col = cpLen(this.lines[line] ?? ''); dx++; continue; }
            break;
        }

        this.setCursor(line, col);
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
        const c = CodeGrid.CARET_COLOR;
        const geo = new THREE.PlaneGeometry(1, 1);
        const mat = new THREE.MeshBasicMaterial({
            color: new THREE.Color(c.r, c.g, c.b),
            transparent: true,
            opacity: 0.85,
            side: THREE.DoubleSide,
            depthWrite: false,
        });
        this._caretMesh = new THREE.Mesh(geo, mat);
        this._caretMesh.renderOrder = CodeGrid.CARET_RENDER_ORDER;
        this._caretMesh.frustumCulled = false;  // grid-local; let parent do culling
        this.add(this._caretMesh);
    }

    /**
     * Position the caret mesh at the current cursor.
     *
     * Pure layout-derived math via _resolveCaretWorldPosition: visual row
     * from the per-line wrap ruler, x from intra-segment col, y from
     * origin + row * lineSpacing, then pagination. No slot reads, no
     * neighbor sampling. Same layout invariants the worker obeyed when
     * placing glyphs, so the caret aligns naturally — even on empty
     * lines, post-wrap segments, and post-pagination pages.
     *
     * @private
     */
    _updateCaretMesh() {
        if (!this._caretMesh || !this._cursor) return;
        const m = this.metrics;
        if (!m) return;

        const pos = this._resolveCaretWorldPosition(this._cursor.line, this._cursor.col);
        if (!pos) {
            this._caretMesh.visible = false;
            this._emitCursorChange(); // cursor is still live; only the caret hid
            return;
        }

        const barWidth  = Math.max(m.charWidth * 0.1, 0.5);
        const barHeight = m.lineHeight;

        // Plane is centered on its origin; shift right by half-width so the
        // bar's left edge sits at the resolved x.
        this._caretMesh.scale.set(barWidth, barHeight, 1);
        // pos.z tracks the glyph depth (z-wrap staircase / pagination); +0.05 keeps the
        // caret just in front so it never z-fights the glyphs (0 for unwrapped lines).
        this._caretMesh.position.set(pos.x + barWidth / 2, pos.y, pos.z + 0.05);
        this._caretMesh.visible = true;
        // Every cursor-visible change funnels through this repaint (setCursor,
        // enterEdit, arrow moves, post-edit relayout clamp) — emit here so
        // subscribers track the cursor without polling.
        this._emitCursorChange();
    }

    /**
     * Rebuild glyphs after a content mutation, clearing stale highlights and
     * re-painting the caret.
     *
     * Routes through the byte pipeline: the edit re-encodes and re-runs the three
     * dispatches, and _beginLoad right-sizes the buffers when the content grew.
     *
     * Edit ops fire-and-forget the returned promise. Routes through the SHARED _relayout mutex
     * (not a separate guard) so edit and scroll/layout relayouts serialize. _linesDirty tells
     * _relayout to re-sync content from the edit-mutated line array (cursor clamp + repaint
     * live in _relayout).
     *
     * @private
     * @returns {Promise<this>}
     */
    async _relayoutPreservingCursor() {
        this._linesDirty = true;
        this._modified = true;   // a content edit (insert/delete/split) happened → unsaved until file.save
        // An edit invalidates the BAKED record (checkpoints/rows describe the disk
        // content) — the grid leaves the windowed regime and folds full from here on.
        // One divergence path: edited files pay the full cost, read views stay windowed.
        if (this._bakedRecord) {
            this._bakedRecord = null;
            this._byteWindow = null;
            if (this._renderer) this._renderer.sourceBase = 0;
            console.info(`[bake] ${this.filename || this.name}: edited — record dropped, full fold from here`);
        }
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
            if (this._background) {
                this._background.visible = false;
            }
            return;
        }

        if (!bounds) {
            this._background.visible = false;
            return;
        }

        const padding = this.config.backgroundPadding;

        // When a frame is active (Step 3c.2), back the FRAME window — a fixed band of
        // frameRows rows at the content x-extent — not the full (scrolled) content, so the
        // panel matches what the shader clip actually shows and stays put as content scrolls
        // through it. Otherwise back the whole content. The frame clips Y only, so width is
        // always the content x-extent.
        const ls      = this.metrics.lineHeight;
        const originY = this._layoutOriginY ?? 0;
        const framed  = this._frameRows > 0;
        const frameH  = this._frameRows * ls;

        const width  = bounds.width + padding * 2;
        const height = (framed ? frameH : bounds.height) + padding * 2;

        if (width > 0 && height > 0) {
            this._background.scale.set(width, height, 1);

            // Position background at the BACK of the bounding box (Z min) so it sits behind
            // all Z-wrapped / z-paged text layers.
            const zMin = bounds.min.z !== undefined ? bounds.min.z : 0;
            const backgroundZ = zMin - 0.5;  // Slightly behind the furthest text

            // Vertical center: the fixed frame band when framed (scroll-independent — the
            // window stays put while content flows through it), else the content center.
            const centerY = framed
                ? (originY + 0.5 * ls) - frameH / 2
                : bounds.min.y + bounds.height / 2;

            this._background.position.set(
                bounds.min.x + bounds.width / 2,
                centerY,
                backgroundZ
            );

            this._background.visible = true;
        } else {
            this._background.visible = false;
        }
    }
}

export default CodeGrid;

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
import GlyphField from '../GlyphField.js';
import { getWorkerBridge } from '../workers/WorkerBridge.js';
import { RENDER_ORDER } from '../core/renderOrder.js';
import { BOUNDS_Z_PAD } from '../core/constants.js';
import { computeCellMetrics } from '../core/cellMetrics.js';
import { paginationGeometry, resolveLayoutParams, DEFAULT_LAYOUT } from '../workers/builders/index.js';
import { syncGpuLayout, isGpuLayoutEnabled } from '../compute/GlyphLayoutCompute.js';
import { evaluateFold } from '../core/foldEvaluate.js';
import LayoutDescription from '../core/LayoutDescription.js';
import { analyzeGrid, buildGridSemantics, buildGridSemanticsSync } from '../parsing/SyntaxColorizer.js';
import FramedGlyphField from './FramedGlyphField.js';
import { createPanelMaterial } from './panelMaterial.js';

// Reused for lines without wraps — most lines, in the common case.
// Frozen so accidental mutation surfaces immediately.
const EMPTY_WRAPS = Object.freeze([]);

// The cursor `col` is a CODEPOINT index — the same model the render/slot path uses (1 emoji =
// 1 col = 1 buffer slot). JS strings are UTF-16, so a surrogate-pair emoji (😀 = 2 code units)
// makes codepoint indices diverge from String.slice/.length. These convert, so edits never land
// inside a surrogate pair (which splits/corrupts an emoji) nor at the wrong offset (inserting
// before the caret). For ASCII they're identity, so the common path is unaffected.
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

        // ── Deferred-batch state (was GlyphCollection._pendingAdds etc.) ────────
        this._pendingAdds    = [];  // { id, text, position, options }
        this._pendingRemovals = []; // renderer IDs to remove
        this._pendingUpdates = [];  // { type, id, ... }
        this._idMap          = new Map(); // our ID → renderer ID
        this._reverseIdMap   = new Map(); // renderer ID → our ID
        this._committedTexts = new Map(); // our ID → { id, rendererId, textLength, position, options }
        this._nextLocalId    = 1;
        this._dirty          = false;   // GPU buffer needs flush (render dirty)
        this._modified       = false;   // content edited since load / last save (the UNSAVED state)
        this._bufferHeadroom = 1.1; // 10% extra
        this._bufferSize     = 0;
        // ─────────────────────────────────────────────────────────────────────────

        // Group — the renderer's instanceMesh will be added to the scene through
        // a THREE.Group child so CodeGrid's own Object3D transform is honoured.
        this._rendererGroup = new THREE.Group();
        this.scene.add(this._rendererGroup);

        // Lazy GPU renderer — the _renderer slot is declared by FramedGlyphField; CodeGrid
        // creates it on first flush() with a right-sized buffer, so it stays null until then.

        // Derive metrics from atlas directly (no renderer needed)
        this.metrics = this._computeMetrics();

        // Track text IDs for content management
        this._filenameTextId = null;
        this._contentTextIds = [];

        // Background panel — the _panel/_background slots are declared by FramedGlyphField;
        // _initBackground builds the mesh + panel material for this grid.
        this._initBackground();

        // Add renderer group as our child for proper transforms
        this.add(this._rendererGroup);

        // ScaleModel (the single authority for this.scale: placement · user) + the
        // setScale/setZoom/zoom API live in FramedGlyphField. _initScale builds the model
        // with this grid's home placement and writes the initial transform.
        this._initScale(this.config.gridScale);

        // World box (getBounds) is owned by BoundedObject3D: it recomputes fresh
        // every call (cheap 8-corner transform of the cached LOCAL content bounds by
        // the current matrix), so there is no world-bounds cache to hold here.
        // Bounds from the worker path (raw plain-object bounds from buffer builder)
        this._workerBoundsCache = null;

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
        // runs in order: fold → ARRANGE → bounds → DECORATE. Two extension seams:
        //   • Arrangers (footprint-CHANGING) re-derive glyph positions from stable anchors
        //     and run INSIDE the fold (before bounds), so the footprint stays honest — the
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
     * fold (before bounds). Contract: `arrange(grid)` re-derives glyph transforms from
     * stable anchors (idempotent — it runs again on the next fold); optional
     * `foldLayout` constrains the fold (merged over config.layout, not mutating it);
     * optional `clear(grid)`. Idempotent registration.
     */
    /**
     * Re-dispatch the engine layout from RETAINED state — no builder run, no new arrays.
     * Everything the kernel needs survives between flushes: line tables on the field's
     * entries, advances in the sizes attribute, origins in the committed items, params on
     * this grid. This is the seam post-flush displacement writes (migrated arrangers) and
     * param-only refolds re-enter through — ~50µs instead of a rebuild.
     * @private
     * @returns {boolean} true if a dispatch happened
     */
    _resyncEngineLayout() {
        const field = this._renderer;
        if (!field?.gpuLayout) return false;
        const sizes = field.instanceMesh?.geometry?.attributes?.instanceSize?.array;
        if (!sizes) return false;
        const items = [], itemMeta = [], rendererIds = [];
        let count = 0;
        for (const [, entry] of field.renderedTexts) {
            const committed = this._committedTexts.get(this._reverseIdMap.get(entry.id));
            itemMeta.push({
                bufferStartIndex: entry.bufferStartIndex,
                glyphCount: entry.glyphCount,
                lineSlotOffsets: entry.lineSlotOffsets,
                pageContentWidth: entry.pageContentWidth || 0,
            });
            items.push({
                position: committed?.position || { x: 0, y: 0, z: 0 },
                scale: committed?.options?.scale ?? 1,
            });
            rendererIds.push(entry.id);
            count = Math.max(count, entry.bufferStartIndex + entry.glyphCount);
        }
        if (!count) return false;
        const m = this.metrics;
        const shared = {
            // CodeGrid metric names → builder metric names, same mapping the description uses.
            metrics: { charWidth: m.charWidth, charHeight: m.charHeight, lineSpacing: m.lineHeight, letterSpacing: m.spacing || 0 },
            layout: resolveLayoutParams(this._foldLayout()),
            scrollOffset: this._scrollOffset || 0,
        };
        const res = syncGpuLayout(field, { count, sizes, itemMeta, bounds: null }, items, shared, rendererIds);
        if (res?.bounds) {
            this._workerBoundsCache = res.bounds;
            field._updateGeometryBounds(res.bounds);
        }
        return (res?.dispatched || 0) > 0;
    }

    /**
     * Materialize the UNDISPLACED fold for every committed entry into one TRANSIENT
     * field-wide array — the measurement scratch for engine-mode arrangers (evaluateFold:
     * call, measure, drop; no persistent position buffer comes back into existence).
     * @private
     * @returns {Float32Array|null} count×3 positions, or null when not engine-owned
     */
    _engineFoldScratch() {
        const field = this._renderer;
        if (!field?.gpuLayout) return null;
        const sizes = field.instanceMesh?.geometry?.attributes?.instanceSize?.array;
        if (!sizes) return null;
        let count = 0;
        for (const [, e] of field.renderedTexts) count = Math.max(count, e.bufferStartIndex + e.glyphCount);
        if (!count) return null;
        const out = new Float32Array(count * 3);
        const m = this.metrics;
        const lp = resolveLayoutParams(this._foldLayout());
        for (const [, entry] of field.renderedTexts) {
            const n = entry.glyphCount;
            if (!n || !entry.lineSlotOffsets) continue;
            const base = entry.bufferStartIndex;
            const committed = this._committedTexts.get(this._reverseIdMap.get(entry.id));
            const lineTable = new Uint32Array(entry.lineSlotOffsets.length);
            for (let L = 0; L < lineTable.length; L++) lineTable[L] = entry.lineSlotOffsets[L] - base;
            const advances = new Float32Array(n);
            for (let s = 0; s < n; s++) advances[s] = sizes[(base + s) * 2];
            const geom = entry.pageContentWidth > 0 ? paginationGeometry(
                { charWidth: m.charWidth, letterSpacing: m.spacing || 0, lineSpacing: m.lineHeight },
                entry.pageContentWidth, lp,
            ) : null;
            evaluateFold({
                slotCount: n, lineTable, advances,
                origin: committed?.position || { x: 0, y: 0, z: 0 },
                scrollOffset: this._scrollOffset || 0,
                wrapWidth: lp.wrapWidth, lineSpacing: m.lineHeight,
                zStep: m.charHeight * (lp.zWrapSpacing || 0),
                geom,
                out: out.subarray(base * 3, (base + n) * 3),
            });
        }
        return out;
    }

    /** Register an arranger. Engine-only: it must serve the displacement-table path —
     *  there is no CPU layout path to fall back to. Idempotent registration. */
    registerArranger(a) {
        if (!a) return;
        if (a.engineCapable !== true) {
            throw new Error('CodeGrid.registerArranger: arranger is not engineCapable — no CPU layout path exists to serve it');
        }
        if (!this._arrangers.includes(a)) this._arrangers.push(a);
    }
    /** Remove a previously-registered arranger. */
    unregisterArranger(a) { const i = this._arrangers.indexOf(a); if (i >= 0) this._arrangers.splice(i, 1); }

    /** Register a decoration — a footprint-neutral overlay re-applied after bounds settle. */
    registerDecoration(d) { if (d && !this._decorations.includes(d)) this._decorations.push(d); }
    /** Remove a previously-registered decoration. */
    unregisterDecoration(d) { const i = this._decorations.indexOf(d); if (i >= 0) this._decorations.splice(i, 1); }

    /**
     * The ARRANGE stage. After the fold has dispatched + the LayoutDescription is built,
     * run each arranger (it re-derives glyph transforms from stable anchors and writes the
     * displacement table, then re-dispatches via _resyncEngineLayout). Engine grids: the
     * arranger sets the arranged bounds itself (setEngineBounds — it KNOWS the extent,
     * packing box / plane depth, better than any walk); there is no CPU buffer to re-walk.
     * No-op (and zero cost) when nothing is registered.
     * @private
     */
    _applyArrangers() {
        if (!this._arrangers.length || !this._renderer) return;
        for (const a of this._arrangers) a.arrange?.(this);
    }

    /**
     * Adopt arranged bounds computed by an engine-mode arranger — the packing box, plane
     * depths — as this grid's content + cull truth. The arranger calls this after its
     * re-dispatch; there is no buffer to walk, and the arranger's own extent is exact.
     * @param {{min:{x,y,z}, max:{x,y,z}}} bounds
     */
    setEngineBounds(bounds) {
        if (!bounds?.min || !bounds?.max) return;
        this._workerBoundsCache = {
            min: { ...bounds.min }, max: { ...bounds.max },
            width: bounds.max.x - bounds.min.x,
            height: bounds.max.y - bounds.min.y,
            depth: bounds.max.z - bounds.min.z,
        };
        this._renderer?._updateGeometryBounds(this._workerBoundsCache);
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
        await this._layoutContent();
        this._updateBackground();
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

        if (this._renderer) this._renderer.clear();
        this._resetBatchState();
        this._filenameTextId = null;
        this._contentTextIds = [];

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

    // getRenderer() + setPickingSystem() (the glyph + grid channels) are inherited from
    // FramedGlyphField. The flush path re-registers the glyph channel after each rebuild
    // (instanceCount changes) via this._pickingSystem directly.

    /**
     * Add text (deferred until flush).
     * Public entry point for callers like DiffController that bypass the normal
     * loadText() flow in order to supply per-text color options.
     *
     * @param {string} text
     * @param {{x,y,z}} [position]
     * @param {Object} [options] - { color, scale, groupId }
     * @returns {number} local text ID (for future updateColor / removeText calls)
     */
    addText(text, position = { x: 0, y: 0, z: 0 }, options = {}) {
        this._ensureRenderer();
        return this._addText(text, position, options);
    }

    /**
     * Flush pending text additions to the GPU via the worker pipeline.
     * Falls back to a main-thread build if the worker job fails.
     * @returns {Promise<void>}
     */
    async flush() {
        return this._flush();
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
     * _relayoutPending) serializes ALL relayouts — scroll, layout, frame, AND edit — so two
     * pipelines can never interleave _clearRenderedText/_flush on the shared deferred-batch
     * state (_pendingAdds/_idMap/_contentTextIds), which would corrupt the buffers. Rapid calls
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
                if (!this.content) continue;               // nothing to lay out (loop exits unless pending)
                this._ensureRenderer();                    // reconstruct if content was evicted
                this._clearRenderedText();                 // drop the prior render's glyphs
                // The staged pipeline: FOLD (+ ARRANGE, inside _layoutContent) → BOUNDS →
                // clamp → DECORATE. Arrangers already re-derived inside the fold, so the bounds
                // walk below sees the arranged footprint; decorations re-project on top of it.
                await this._layoutContent();          // FOLD: re-add + re-flush + line tables + _layout (+ arrange)
                this._updateBackground();                  // BOUNDS: re-walk the (arranged) footprint, re-fit the panel
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
        this._scrollOffset = Math.max(0, Math.min(Math.round(rows), this.getMaxScroll()));
        return this._relayoutInPlace();
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
     * (independent of scrollOffset) — derived from the macro line table built each layout.
     * @returns {number}
     */
    getTotalVisualRows() {
        if (!this._lineStartRow || this._lineStartRow.length === 0) return 0;
        const last = this._lineStartRow.length - 1;
        return this._lineStartRow[last] + 1 + (this._lineWrapCols?.[last]?.length || 0);
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
        return this;
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
        // Leave both picking channels cleanly before the renderer + panel are
        // torn down, or the passes would swap materials onto a disposed mesh.
        if (this._pickingSystem) {
            if (this._renderer)   this._pickingSystem.unregister('glyph', this._renderer);
            if (this._background) this._pickingSystem.unregister('grid', this._background);
        }

        // Dispose renderer
        if (this._renderer) {
            this._renderer.dispose();
            this._renderer = null;
        }

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
     * Ensure the GlyphField renderer exists, reconstructing it from the stored atlas
     * if content was previously evicted. Called at the top of
     * loadText() so that method is safe to use on evicted grids.
     * @private
     */
    _ensureRenderer() {
        if (this._renderer) return; // already present

        // Size the initial buffers to the actual content, not the maxChars ceiling
        // (default 50,000). Every load/reload ends in applyPrebuiltBuffers, which
        // REPLACES these attributes at the exact glyph count — so a maxChars prealloc
        // was ~2.2MB of allocate-then-discard per reload (e.g. a 50-line file got
        // 50k-instance buffers). content.length is a safe upper bound on glyph count
        // (≤, since multi-byte codepoints collapse); _createRendererWithSize floors
        // it at 100. Big files still get the capacity they need.
        const sizeHint = Math.min(this.content ? this.content.length : 0, this.config.maxChars);
        this._createRendererWithSize(sizeHint, false);

        // Re-derive metrics in case atlas changed
        this.metrics = this._computeMetrics();
    }

    /**
     * Create a GlyphField with a specific buffer size and wire it up.
     * @private
     * @param {number} size - Max instance count for the renderer
     * @param {boolean} [skipPrealloc=false]
     */
    _createRendererWithSize(size, skipPrealloc = false) {
        const bufferSize = Math.max(size, 100);
        this._bufferSize = bufferSize;

        this._renderer = new GlyphField(this._rendererGroup, this.atlas, {
            maxInstances:  bufferSize,
            defaultColor:  this.config.textColor,
            worldScale:    this.config.worldScale,
            slugData:      this.config.slugData,
            shaper:        this.config.shaper,
            occluder:      this.config.occluder,
        });

        if (this._pickingSystem) {
            this._pickingSystem.register('glyph', this._renderer, this._renderer);
        }
        // Fade glyphs to match the panel from the start (group 0 = all this grid's
        // glyphs), so a translucent grid reads as one coherent sheet.
        this._applyGlyphAlpha();
    }

    /**
     * Reset all deferred-batch state without touching the renderer.
     * @private
     */
    _resetBatchState() {
        this._pendingAdds     = [];
        this._pendingRemovals = [];
        this._pendingUpdates  = [];
        this._idMap.clear();
        this._reverseIdMap.clear();
        this._committedTexts.clear();
        this._dirty = false;
        this._workerBoundsCache  = null;
    }

    /**
     * Enqueue a text add (deferred until flush).
     * @private
     * @returns {number} local ID
     */
    _addText(text, position = { x: 0, y: 0, z: 0 }, options = {}) {
        const id = this._nextLocalId++;
        this._pendingAdds.push({ id, text, position: { ...position }, options: { ...options } });
        this._dirty = true;
        return id;
    }

    /**
     * Enqueue a text removal (deferred until flush).
     * @private
     */
    _removeText(id) {
        const pendingIdx = this._pendingAdds.findIndex(p => p.id === id);
        if (pendingIdx !== -1) {
            this._pendingAdds.splice(pendingIdx, 1);
        } else if (this._idMap.has(id)) {
            this._pendingRemovals.push(this._idMap.get(id));
        }
        this._dirty = true;
    }

    /**
     * Normalize pending adds and compute the shared build inputs (metrics,
     * default color) used by both the sync and worker builder paths. Also
     * ensures any missing graphemes are in the atlas (legacy non-shaper path).
     * @private
     * @returns {{items: Array, metrics: Object, defaultColor: Object}}
     */
    _prepareAddsForBuild() {
        const defaultColor = this.config.textColor;
        const items = this._pendingAdds;

        for (const p of items) {
            if (!p.color)                p.color   = p.options?.color   || defaultColor;
            if (!p.scale)                p.scale   = p.options?.scale   || 1.0;
            if (p.groupId === undefined) p.groupId = p.options?.groupId || 0;
        }

        const atlasCharSize = this.atlas.getCharSize();
        const scale = this.config.worldScale;
        const metrics = {
            ...computeCellMetrics(atlasCharSize, scale),
            worldScale: scale,
            atlasSize:  this.atlas.getAtlasTexture().width,
        };

        // Live Slug path: ensure every codepoint's curves are
        // encoded before the builder maps text → slots. First sighting of a glyph
        // (box-drawing, stars, …) allocates its slot in the shared shape cache and
        // re-encodes the GPU textures; a per-grid "seen" set keeps this O(new).
        // The worker build path uses a transferred COPY of the cache, so on growth
        // we resync it to the workers before they shape (resync postMessage is
        // FIFO-ordered ahead of the build job → no stale-cache misses).
        const live = this.atlas && this.atlas._live;
        if (this.config.shaper && live && this.atlas._shapeCache) {
            if (!this._liveEnsured) this._liveEnsured = new Set();
            const seen = this._liveEnsured;
            let fresh = null;
            for (const it of items) {
                if (!it.text) continue;
                const t = it.text;
                for (let i = 0; i < t.length;) {
                    const cp = t.codePointAt(i);
                    i += cp > 0xFFFF ? 2 : 1;
                    if (cp > 32 && !seen.has(cp)) { seen.add(cp); (fresh ?? (fresh = [])).push(cp); }
                }
            }
            if (fresh) {
                const before = live.size;
                live.ensureCodepoints(fresh, this.atlas._shapeCache);
                if (live.size !== before) getWorkerBridge().resyncShapeCache();
            }
        }

        return { items, metrics, defaultColor, layout: this._foldLayout(), scrollOffset: this._scrollOffset };
    }

    /**
     * Commit builder output to the GPU: create/size the renderer, apply any
     * deferred removals in the same synchronous block as the buffer swap (so
     * old→new is atomic with no intermediate paint), swap in the prebuilt
     * buffers, and record the id maps + bounds. Shared by both flush paths.
     * @private
     * @param {Object} buffers - output of buildBatchBuffers
     * @param {Array} items - the items that produced `buffers`
     * @param {number[]} [deferredRemovals] - renderer IDs to remove atomically
     * @param {?{metrics: Object, layout: Object, scrollOffset: number}} [shared] - the bag the
     *   builder consumed, passed through for the GPU layout engine (dual-compute assertion)
     */
    _commitBuiltBuffers(buffers, items, deferredRemovals = [], shared = null) {
        if (!this._renderer) {
            this._createRendererWithSize(buffers.count, true);
        }

        for (const rendererId of deferredRemovals) {
            this._renderer.remove(rendererId);
            const ourId = this._reverseIdMap.get(rendererId);
            if (ourId !== undefined) {
                this._idMap.delete(ourId);
                this._reverseIdMap.delete(rendererId);
                this._committedTexts.delete(ourId);
            }
        }

        // Every commit is an engine build: the builder emits tables + attributes only (no
        // positions), and the kernel dispatch below IS the layout. The builder's scalar-walk
        // bounds are exact for unpaginated content; a paginated item gets its extent from
        // the adapter's analytic override.
        this._renderer.setGpuLayout(true);

        const rendererIds = this._renderer.applyPrebuiltBuffers(buffers, items);
        this._workerBoundsCache  = buffers.bounds;

        // A commit is a NEW fold — a standing displacement table was computed against
        // the OLD one (dz = plane − oldFoldZ) and would land glyphs on garbage planes
        // if dispatched now; on a slot-count change it also misaligns wholesale. Drop
        // it: arrangers re-derive against the fresh fold immediately after the flush
        // (_applyArrangers → arrange → _resyncEngineLayout), and until they do the
        // grid renders honestly FLAT — never scrambled.
        this._renderer._layoutDisplacements = null;
        if (!isGpuLayoutEnabled()) {
            // Loud, not silent: no compute renderer registered (boot-order breach) means
            // the kernel can't dispatch and this grid renders unlaid at the origin.
            console.error('CodeGrid: engine commit with no compute renderer registered — grid renders unlaid (boot-order breach)');
        }
        const res = syncGpuLayout(this._renderer, buffers, items, shared, rendererIds);
        if (res?.bounds) {
            this._workerBoundsCache = res.bounds;
            this._renderer._updateGeometryBounds(res.bounds);
        }

        for (let i = 0; i < items.length; i++) {
            const p          = items[i];
            const rendererId = rendererIds[i];
            this._idMap.set(p.id, rendererId);
            this._reverseIdMap.set(rendererId, p.id);
            this._committedTexts.set(p.id, {
                id: p.id,
                rendererId,
                textLength: p.text.length,
                position:   p.position,
                options:    p.options,
            });
        }
        this._pendingAdds = [];
    }

    /**
     * Flush pending changes via the worker pipeline — the ONE flush. The buffers +
     * line→slot table exist by the time the promise resolves, so callers may apply
     * highlights immediately after the await. A failed worker job falls back to a
     * main-thread build of the same items (same builder, no postMessage); an empty
     * worker pool already degrades the same way inside buildBatchBuffers.
     * @private
     * @returns {Promise<void>}
     */
    async _flush() {
        if (!this._dirty) return;

        if (this._pendingAdds.length === 0) {
            // No build needed — apply removals directly (nothing to defer them against).
            for (const rendererId of this._pendingRemovals) {
                this._renderer?.remove(rendererId);
                const ourId = this._reverseIdMap.get(rendererId);
                if (ourId !== undefined) {
                    this._idMap.delete(ourId);
                    this._reverseIdMap.delete(rendererId);
                    this._committedTexts.delete(ourId);
                }
            }
            this._pendingRemovals = [];
        } else {
            // Defer removals until the build returns. Applying them now would
            // empty the GPU buffer while we wait ~5-20ms for the new content to
            // build, flashing the grid. _commitBuiltBuffers applies them in the
            // same synchronous block as the buffer swap, so old→new is atomic.
            const deferredRemovals = this._pendingRemovals;
            this._pendingRemovals = [];

            const { items, metrics, defaultColor, layout, scrollOffset } = this._prepareAddsForBuild();
            let buffers;
            try {
                buffers = await getWorkerBridge().buildBatchBuffers(items, { metrics, defaultColor, layout, scrollOffset });
            } catch (error) {
                console.warn('CodeGrid: Worker flush failed, falling back to main-thread build:', error);
                // Same items, same builder, main thread — the commit below still
                // applies the deferred removals atomically with the buffer swap.
                buffers = getWorkerBridge().buildBatchBuffersSync(items, { metrics, defaultColor, layout, scrollOffset });
            }
            this._commitBuiltBuffers(buffers, items, deferredRemovals, { metrics, layout, scrollOffset });
        }

        if (this._renderer && this._pickingSystem) {
            this._pickingSystem.register('glyph', this._renderer, this._renderer);
        }

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
     * Drop the PREVIOUSLY-RENDERED text items (the filename + content glyph instances) from the
     * renderer, so a re-layout can add the new ones. Does NOT touch this.content / this.lines — the
     * data is set separately at the load seam (_beginLoad); this only clears the prior render.
     * @private
     */
    _clearRenderedText() {
        // Remove filename text if exists
        if (this._filenameTextId !== null) {
            this._removeText(this._filenameTextId);
            this._filenameTextId = null;
        }

        // Remove all content texts
        for (const id of this._contentTextIds) {
            this._removeText(id);
        }
        this._contentTextIds = [];

        // Removals stay pending. Callers (loadText → _layoutContent) flush
        // afterwards — doing it here would push an empty GPU frame and flash
        // the grid.
    }

    /**
     * Layout content via the worker pipeline. Adds the whole content as ONE
     * item — the builder lays out the lines and emits the authoritative
     * line→slot offsets.
     * @private
     */
    async _layoutContent() {
        let currentY = 0;

        // Add filename if enabled
        if (this.config.showFilename && this.filename) {
            this._filenameTextId = this._addText(
                this.filename,
                { x: 0, y: currentY, z: 0 },
                { color: this.config.filenameColor }
            );
            currentY -= this.metrics.lineHeight * 1.5;
        }

        // Add ENTIRE content as single text item (worker handles newlines)
        if (this.content.length > 0) {
            const id = this._addText(
                this.content,
                { x: 0, y: currentY, z: 0 },
                { color: this.config.textColor }
            );
            this._contentTextIds.push(id);
        }

        // Flush using the worker pipeline
        await this._flush();

        // Build line→slot index from builder's authoritative line offsets,
        // and harvest the per-line wrap data needed for cursor positioning.
        const contentItemMeta = this._getContentItemMeta();
        this._buildLineSlotBase(contentItemMeta?.lineSlotOffsets);
        this._buildLayoutWrapIndex(contentItemMeta?.wrapColsPerLine);
        // Record the layout origin (where the worker anchored the content
        // text). Caret math derives y from origin.y - visualRow * lineSpacing.
        this._layoutOriginY = (this.config.showFilename && this.filename)
            ? -this.metrics.lineHeight * 1.5
            : 0;
        this._buildLayoutDescription();
        this._applyClip();

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
            return; // the re-entrant fold already arranged on the clamped buffer
        }
        this._applyArrangers(); // ARRANGE stage (see _applyArrangers) — runs every fold
    }

    /**
     * Get the renderer's itemMeta for the content text entry.
     * @private
     * @returns {Object|null} itemMeta with lineSlotOffsets if available
     */
    _getContentItemMeta() {
        if (this._contentTextIds.length === 0) return null;
        if (!this._renderer) return null;

        const collId   = this._contentTextIds[0];
        const rendId   = this._idMap.get(collId);
        if (rendId === undefined) return null;

        const entry = this._renderer.renderedTexts.get(rendId);
        return entry ?? null;
    }

    /**
     * The content bounds over all committed renderer entries, or null.
     * Engine-owned fields have no CPU position buffer to walk — the builder/kernel extent
     * from the last flush, or an arranger's setEngineBounds, IS the truth, and no CPU
     * writer can move glyphs between commits, so the cache never goes stale.
     * @private
     */
    _getContentBounds() {
        return this._workerBoundsCache ?? null;
    }

    // ============ Line → Buffer Slot Mapping ============

    /**
     * Build _lineSlotBase: maps each line index to the buffer slot index of
     * its first codepoint. The builder emits one slot per codepoint (spaces
     * and other invisible glyphs included), so within a line the slot offset
     * equals the codepoint index — getSlotForChar just adds col to the base.
     *
     * Must be called after every flush that rebuilds geometry.
     * @private
     */
    _buildLineSlotBase(builderLineSlotOffsets) {
        const content = this.content;
        if (!content) {
            this._lineSlotBase = null;
            return;
        }

        // Ensure this.lines is populated (async path doesn't split upfront)
        if (this.lines.length === 0 && content.length > 0) {
            this.lines = content.split('\n');
        }

        // If the builder provided line→slot offsets, use those directly.
        // These are authoritative — computed in the same pass that built the buffers.
        if (builderLineSlotOffsets) {
            this._lineSlotBase = new Int32Array(builderLineSlotOffsets);
            return;
        }

        // Fallback for sync path: derive from renderer's renderedTexts
        if (!this._renderer) {
            this._lineSlotBase = null;
            return;
        }

        // Sync path: one text entry per non-empty line
        const lineSlotBase = new Int32Array(this.lines.length);
        let textIdCursor = 0;
        for (let i = 0; i < this.lines.length; i++) {
            if (this.lines[i].length === 0 || textIdCursor >= this._contentTextIds.length) {
                // Empty line or past entries — use previous line's end
                lineSlotBase[i] = i > 0 ? lineSlotBase[i - 1] : 0;
                continue;
            }
            const collId = this._contentTextIds[textIdCursor++];
            const rendId = this._idMap.get(collId);
            const entry  = rendId !== undefined ? this._renderer.renderedTexts.get(rendId) : null;
            lineSlotBase[i] = entry ? (entry.bufferStartIndex ?? 0) : 0;
        }

        this._lineSlotBase = lineSlotBase;
    }

    /**
     * Build the per-line wrap index that backs cursor positioning.
     *
     * Stores:
     *   _lineWrapCols    — Array<number[]>, parallel to this.lines.
     *                      Each entry is the sorted source-col indices where
     *                      the worker wrapped this line into a new visual
     *                      row. Empty for lines that fit (the common case).
     *   _lineStartRow    — Int32Array, length = this.lines.length.
     *                      Cumulative visual-row index where each line
     *                      starts. lineStartRow[N] = sum of (1 + wrapCols[i].length)
     *                      for i in [0, N). O(1) lookup of "first row of line N".
     *
     * Together with metrics + paginate config, these give caret y/x
     * deterministically — no slot reads, no neighbor walks.
     *
     * For sync paths (loadText), the worker emits one item per source line,
     * so wrapColsPerLine is just [[]] per item — no wrap. The fallback
     * builds an all-empty wrap table.
     *
     * @private
     * @param {number[][]|undefined} wrapColsPerLine - per-line wrap col arrays from worker meta
     */
    _buildLayoutWrapIndex(wrapColsPerLine) {
        const lineCount = this.lines.length;
        const wraps = new Array(lineCount);
        const lineStartRow = new Int32Array(lineCount);

        let cumulativeRows = 0;
        for (let i = 0; i < lineCount; i++) {
            const w = wrapColsPerLine?.[i];
            wraps[i] = (w && w.length > 0) ? w.slice() : EMPTY_WRAPS;
            lineStartRow[i] = cumulativeRows;
            cumulativeRows += 1 + (w?.length || 0);
        }

        this._lineWrapCols = wraps;
        this._lineStartRow = lineStartRow;
    }

    /**
     * Build the queryable LayoutDescription for the current flush — the ONE source
     * caret / highlight / selection query against (positionAt, slotForChar). positionAt
     * is the FOLD MIRROR: it evaluates the same pure layout function the GPU kernel
     * runs, from the line tables + real advances + pagination geometry — every input
     * CPU-authored, so any glyph's location is answerable synchronously with no
     * position buffer and no readback. Rebuilt every flush. @private
     */
    _buildLayoutDescription() {
        if (!this._lineSlotBase || !this._lineStartRow) { this._layout = null; return; }
        const m = this.metrics;
        const lineLengths = new Int32Array(this.lines.length);
        for (let i = 0; i < this.lines.length; i++) lineLengths[i] = this.getLineSlotCount(i);
        // Same page geometry the builder used (pageContentWidth threaded through meta),
        // so the analytic fallback aligns with the glyphs. CodeGrid metrics → builder
        // metric names.
        const contentWidth = this._getContentItemMeta()?.pageContentWidth || 0;
        const lp = resolveLayoutParams(this._foldLayout());  // SAME normalization the builder applies — geom can't drift
        // pageContentWidth is the builder's "pagination FIRED" witness — geom arms the
        // mirror's page shift ONLY when the glyphs actually paginated. Content exactly one
        // page tall has pageHeight > 0 but never fired; an armed geom would shift its
        // boundary row a page away from the buffer (found by the fuzz, mirror-only class).
        const geom = contentWidth > 0 ? paginationGeometry(
            { charWidth: m.charWidth, letterSpacing: m.spacing || 0, lineSpacing: m.lineHeight },
            contentWidth,
            lp,
        ) : null;
        this._layout = new LayoutDescription({
            lineSlotBase: this._lineSlotBase,
            lineStartRow: this._lineStartRow,
            lineWrapCols: this._lineWrapCols,
            lineLengths,
            sizes: this._renderer?.getInstanceSizes?.() ?? null,
            geom,
            originX: 0,
            originY: this._layoutOriginY ?? 0,
            lineSpacing: m.lineHeight,
            zStep: m.charHeight * (lp.zWrapSpacing || 0),
            advance: m.charWidth + (m.spacing || 0),
            scrollOffset: this._scrollOffset || 0,  // so the mirror matches the scrolled glyphs
            // Engine-mode arrangers write this table; the caret must ride it (an arranged
            // glyph's location = fold + displacement, both CPU-authored).
            displacements: this._renderer?._layoutDisplacements ?? null,
        });
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
     * Routes through the worker pipeline because that path calls
     * applyPrebuiltBuffers which swaps in fresh, exactly-sized
     * InstancedBufferAttributes, so an edit can grow the content past the
     * initial buffer.
     *
     * Edit ops fire-and-forget the returned promise. Routes through the SHARED _relayout mutex
     * (not a separate guard) so edit and scroll/layout relayouts serialize and never trample the
     * shared _pendingAdds / _pendingRemovals / _idMap state. _linesDirty tells _relayout to
     * re-sync content from the edit-mutated line array (cursor clamp + repaint live in _relayout).
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
        // Content changed — getBounds re-derives the world box from the cached local
        // content bounds each call, so the panel just re-fits to them.
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

/**
 * CodeGrid - Single source file representation in 3D space
 *
 * Directly manages a GlyphRenderer (WebGL path, GlyphRendererV15) for all
 * deferred batching, flush, and GPU updates. The intermediate GlyphCollection
 * wrapper was deleted in C4; its deferred-add / flush / worker-flush logic now
 * lives here.
 *
 * Dual-backend note (C4):
 *   The IDE and all existing examples use THREE.WebGLRenderer + three.module.js.
 *   GlyphField (WebGPU + TSL NodeMaterial) requires THREE.WebGPURenderer and
 *   three/webgpu imports — it is NOT compatible with raw WebGLRenderer.
 *   Until the IDE switches to WebGPURenderer, CodeGrid continues to create a
 *   GlyphRendererV15 (WebGL). The GlyphField path will be wired in a later
 *   commit once the renderer detection hook is in place.
 *
 * Part of the layered rendering architecture:
 * - GlyphAtlas -> CodeGrid -> GridLayoutManager
 */

import * as THREE from 'three';
import GlyphField from '../GlyphField.js';
import { getWorkerBridge, isWorkersSupported } from '../workers/WorkerBridge.js';
import { iterGraphemes } from '../utils/grapheme.js';
import { RENDER_ORDER } from '../core/renderOrder.js';
import { PAGE_CONFIG, Z_WRAP_CONFIG } from '../workers/builders/index.js';

// Reused for lines without wraps — most lines, in the common case.
// Frozen so accidental mutation surfaces immediately.
const EMPTY_WRAPS = Object.freeze([]);

class CodeGrid extends THREE.Object3D {
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
            backgroundColor: options.backgroundColor || 0x1a1a2e,
            backgroundOpacity: options.backgroundOpacity || 0.85,
            backgroundPadding: options.backgroundPadding || 1.0,
            showFilename: options.showFilename !== false,
            filenameColor: options.filenameColor || { r: 0.6, g: 0.8, b: 1.0 },
            textColor: options.textColor || { r: 0.0, g: 1.0, b: 0.0 },
            // Overall grid scale - scales the entire code view
            gridScale: options.gridScale || 1.0,
            // World scale passed to renderer (pixels to world units)
            worldScale: options.worldScale || 0.025,
            // Slug vector rendering data (passed through to GlyphRenderer)
            // Check options first, then atlas (shared across all renderers)
            slugData: options.slugData || (atlas && atlas._slugData) || null,
            shaper: options.shaper || (atlas && atlas._shaper) || null,
        };

        // Content state
        this.filename = '';
        this.sourcePath = null;
        this.content = '';
        this.lines = [];

        // ── Deferred-batch state (was GlyphCollection._pendingAdds etc.) ────────
        this._pendingAdds    = [];  // { id, text, position, options }
        this._pendingRemovals = []; // renderer IDs to remove
        this._pendingUpdates = [];  // { type, id, ... }
        this._idMap          = new Map(); // our ID → renderer ID
        this._reverseIdMap   = new Map(); // renderer ID → our ID
        this._committedTexts = new Map(); // our ID → { id, rendererId, textLength, position, options }
        this._nextLocalId    = 1;
        this._dirty          = false;
        this._bufferHeadroom = 1.1; // 10% extra
        this._bufferSize     = 0;
        // ─────────────────────────────────────────────────────────────────────────

        // Optional picking system — wired via setPickingSystem()
        this._pickingSystem = null;

        // Group — the renderer's instanceMesh will be added to the scene through
        // a THREE.Group child so CodeGrid's own Object3D transform is honoured.
        this._rendererGroup = new THREE.Group();
        this.scene.add(this._rendererGroup);

        // Lazy GPU renderer — created on first flush() with right-sized buffer
        this._renderer = null;

        // Derive metrics from atlas directly (no renderer needed)
        this.metrics = this._computeMetrics();

        // Track text IDs for content management
        this._filenameTextId = null;
        this._contentTextIds = [];

        // Background element (separate from renderer)
        this._background = null;
        this._initBackground();

        // Add renderer group as our child for proper transforms
        this.add(this._rendererGroup);

        // Apply overall grid scale
        if (this.config.gridScale !== 1.0) {
            this.scale.setScalar(this.config.gridScale);
        }

        // Cached world-space bounds — avoids allocating a new Box3 and recomputing
        // applyMatrix4 on every getBounds() call. Dirtied on content change and
        // on matrixWorld updates (position/rotation/scale changes).
        this._boundsCache = null;
        this._boundsCacheDirty = true;
        // Bounds from the worker path (raw plain-object bounds from buffer builder)
        this._workerBoundsCache = null;
        // Whether the renderer-side content bounds should be recomputed
        this._contentBoundsDirty = true;
        this._contentBoundsCache = null;
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
    loadText(text, options = {}) {
        this.content = text;
        this.lines = text.split('\n');

        // If content was evicted, reconstruct the renderer before clearing/loading
        this._ensureRenderer();

        // Clear previous content
        this._clearContent();

        // Layout text using renderer
        this._layoutContent();

        // Update background
        this._updateBackground();

        return this;
    }

    /**
     * Load file content with filename
     * @param {string} filename - Name of the file
     * @param {string} content - File content
     * @returns {this} For chaining
     */
    loadFile(filename, content) {
        this.filename = filename;
        return this.loadText(content);
    }

    /**
     * Load text content using Web Workers (async)
     * @param {string} text - Text content to display
     * @returns {Promise<this>} For chaining
     */
    async loadTextAsync(text) {
        this.content = text;
        // Note: lines array populated lazily only if needed (getLineCount, getMaxLineWidth)

        // If content was evicted, reconstruct the renderer before clearing/loading
        this._ensureRenderer();

        // Clear previous content
        this._clearContent();

        // Layout text using renderer (async worker path)
        await this._layoutContentAsync();

        // Update background
        this._updateBackground();

        return this;
    }

    /**
     * Load file content with filename (async worker path)
     * @param {string} filename - Name of the file
     * @param {string} content - File content
     * @returns {Promise<this>} For chaining
     */
    async loadFileAsync(filename, content) {
        this.filename = filename;
        return this.loadTextAsync(content);
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
        if (this._background) {
            this._background.material.color.set(color);
        }
        this.config.backgroundColor = color;
    }

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
            this._clearContent();
            this._layoutContent();
            this._updateBackground();
        }
    }

    /**
     * Show or hide filename label
     * @param {boolean} visible - Whether filename is visible
     */
    showFilename(visible) {
        this.config.showFilename = visible;
        if (this.content) {
            this._clearContent();
            this._layoutContent();
            this._updateBackground();
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
     * Override updateMatrixWorld to dirty the bounds cache whenever this
     * object's world transform changes (position, rotation, or scale).
     * @override
     */
    updateMatrixWorld(force) {
        // Read the dirty flag before super clears it, and snapshot tx for change detection.
        const needsUpdate = this.matrixWorldNeedsUpdate || force;
        const prevTx = this.matrixWorld.elements[12]; // translation x as cheap change probe
        super.updateMatrixWorld(force);
        if (needsUpdate || this.matrixWorld.elements[12] !== prevTx) {
            this._boundsCacheDirty = true;
        }
    }

    /**
     * Get bounding box of this grid.
     * Returns a cached THREE.Box3 in world coordinates. The cache is invalidated
     * whenever the transform changes (via updateMatrixWorld) or content is updated
     * (via _markBoundsDirty). Callers must NOT mutate the returned object.
     * @returns {THREE.Box3} Bounding box in world coordinates
     */
    getBounds() {
        if (this._contentBoundsDirty) {
            this._boundsCacheDirty = true;
        }

        if (!this._boundsCacheDirty && this._boundsCache) {
            return this._boundsCache;
        }

        const padding = this.config.backgroundPadding;

        // Get content bounds (null when content is unloaded)
        const contentBounds = this._getContentBounds();

        if (!this._boundsCache) {
            this._boundsCache = new THREE.Box3();
        }
        const box = this._boundsCache;

        if (contentBounds) {
            box.min.set(
                contentBounds.min.x - padding,
                contentBounds.min.y - padding,
                contentBounds.min.z
            );
            box.max.set(
                contentBounds.max.x + padding,
                contentBounds.max.y + padding,
                contentBounds.max.z
            );
        } else {
            box.makeEmpty();
        }

        // Transform to world coordinates
        box.applyMatrix4(this.matrixWorld);
        this._boundsCacheDirty = false;
        return box;
    }

    /**
     * Mark the world-space bounds cache dirty. Call after content changes or
     * manual position adjustments that bypass updateMatrixWorld.
     */
    _markBoundsDirty() {
        this._boundsCacheDirty = true;
    }

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

    /**
     * Get the underlying GlyphRenderer, or null if not yet created.
     * Used by PickingSystem, highlight commands, and external callers.
     * @returns {GlyphRendererV15|null}
     */
    getRenderer() {
        return this._renderer;
    }

    /**
     * Wire a PickingSystem so flush paths automatically re-register this
     * grid's renderer after every buffer rebuild.
     * @param {import('../picking/PickingSystem.js').PickingSystem} pickingSystem
     */
    setPickingSystem(pickingSystem) {
        this._pickingSystem = pickingSystem;
        if (this._renderer && pickingSystem) {
            pickingSystem.registerRenderer(this._renderer);
        }
    }

    /**
     * Add text (deferred until flush / flushAsync).
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
     * Flush pending text additions to the GPU via Web Workers (async).
     * Falls back to synchronous flush if workers are unavailable.
     * @returns {Promise<void>}
     */
    async flushAsync() {
        return this._flushAsync();
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
     * Release GPU buffers while preserving source reference for reload.
     * Called by GridVirtualizer when a grid exits the eviction threshold.
     * Preserves: position, metadata, bounding box, source text, config.
     * Releases: GlyphRendererV15 (InstancedBufferGeometry, highlight texture,
     *   group DataTexture, all instance attribute buffers).
     *
     * After this call `isContentLoaded` returns false. The grid remains in
     * whatever scene-graph state the caller left it; the virtualizer keeps
     * its cached bounds so re-entry detection still works.
     */
    unloadContent() {
        if (!this._renderer) return; // already unloaded or fully disposed

        this._renderer.dispose();
        this._renderer = null;

        // Remove renderer group children (the instanceMesh was in the scene directly,
        // added via this._rendererGroup when the renderer was created)
        while (this._rendererGroup.children.length > 0) {
            this._rendererGroup.remove(this._rendererGroup.children[0]);
        }

        // Clear derived state that references the now-dead renderer/buffers
        this._resetBatchState();
        this._filenameTextId = null;
        this._contentTextIds = [];
        this._lineSlotBase = null;

        // Mark as unloaded — reloadContent() checks this flag
        this._contentUnloaded = true;
    }

    /**
     * Whether GPU content is currently loaded.
     * @returns {boolean}
     */
    get isContentLoaded() {
        return !this._contentUnloaded;
    }

    /**
     * Reload content from the stored source text and filename.
     * Called by GridVirtualizer when an evicted grid re-enters the frustum.
     * Uses the async worker path (flushAsync) since this is non-urgent and
     * may involve large files. The grid renders on the next frame after the
     * worker completes — one blank frame is acceptable.
     *
     * No-op if content is already loaded or there is no source text to restore.
     *
     * @param {GlyphAtlas} atlas - The atlas instance (may differ from construction
     *   time if the atlas was regenerated; pass the current live atlas).
     * @returns {Promise<void>}
     */
    async reloadContent(atlas) {
        if (!this._contentUnloaded) return;
        if (!this.content) {
            // Nothing to restore — mark loaded so we don't retry on every frame
            this._contentUnloaded = false;
            return;
        }

        // If caller provides a fresh atlas (e.g. after regeneration), swap it in
        // before _ensureRenderer() reads this.atlas.
        if (atlas && atlas !== this.atlas) {
            this.atlas = atlas;
        }

        // Reconstruct the renderer (also marks _contentUnloaded = false)
        this._ensureRenderer();

        // Re-run the full layout pipeline using the worker path
        await this._layoutContentAsync();

        // Re-fit the background to the rebuilt content bounds
        this._updateBackground();
    }

    /**
     * Dispose of all resources
     */
    dispose() {
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

        // Dispose background
        if (this._background) {
            this._background.geometry.dispose();
            this._background.material.dispose();
            this.remove(this._background);
            this._background = null;
        }

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
        this._contentUnloaded = false;
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
        return {
            charWidth:  atlasCharSize.width  * scale,
            charHeight: atlasCharSize.height * scale,
            lineHeight: atlasCharSize.height * scale * 1.2,
            spacing:    atlasCharSize.width  * scale * 0.05,
        };
    }

    /**
     * Ensure the GlyphRenderer exists, reconstructing it from the stored atlas
     * if content was previously evicted. Called at the top of loadText() and
     * loadTextAsync() so those methods are safe to use on evicted grids.
     * @private
     */
    _ensureRenderer() {
        if (this._renderer) return; // already present

        // Create a right-sized renderer. Exact size is unknown pre-flush, so use
        // maxChars as the ceiling — will be right-sized in the async path.
        this._createRendererWithSize(this.config.maxChars, false);

        // Re-derive metrics in case atlas changed
        this.metrics = this._computeMetrics();

        this._contentUnloaded = false;
    }

    /**
     * Create a GlyphRendererV15 with a specific buffer size and wire it up.
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
        });

        if (this._pickingSystem) {
            this._pickingSystem.registerRenderer(this._renderer);
        }
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
        this._contentBoundsDirty = true;
        this._contentBoundsCache = null;
        this._workerBoundsCache  = null;
    }

    /**
     * Enqueue a text add (deferred until flush / flushAsync).
     * @private
     * @returns {number} local ID
     */
    _addText(text, position = { x: 0, y: 0, z: 0 }, options = {}) {
        const id = this._nextLocalId++;
        this._pendingAdds.push({ id, text, position: { ...position }, options: { ...options } });
        this._dirty = true;
        this._contentBoundsDirty = true;
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
        this._contentBoundsDirty = true;
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
            charWidth:     atlasCharSize.width  * scale,
            charHeight:    atlasCharSize.height * scale,
            letterSpacing: atlasCharSize.width  * scale * 0.05,
            lineSpacing:   atlasCharSize.height * scale * 1.2,
            worldScale:    scale,
            atlasSize:     this.atlas.getAtlasTexture().width,
            pixelWidth:    atlasCharSize.width,
            pixelHeight:   atlasCharSize.height,
        };

        // Ensure codepoints exist in atlas before building (legacy non-shaper path)
        if (!this.config.shaper) {
            const missing = new Set();
            for (const it of items) {
                if (!it.text) continue;
                for (const grapheme of iterGraphemes(it.text)) {
                    const cp = grapheme.codePointAt(0);
                    if (cp > 32 && !this.atlas.uvMap.has(grapheme)) missing.add(grapheme);
                }
            }
            if (missing.size > 0) this.atlas.ensureGraphemes(Array.from(missing));
        }

        return { items, metrics, defaultColor };
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
     */
    _commitBuiltBuffers(buffers, items, deferredRemovals = []) {
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

        const rendererIds = this._renderer.applyPrebuiltBuffers(buffers, items);
        this._workerBoundsCache  = buffers.bounds;
        this._contentBoundsDirty = false;

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
     * Flush pending changes synchronously — same builder as the worker path,
     * run on the main thread (no postMessage). loadText needs this: highlights
     * are applied immediately after, so the buffers + line→slot table must
     * exist by the time _flush() returns.
     * @private
     */
    _flush() {
        if (!this._dirty) return;

        // Process removals
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

        // Process adds via the builder (synchronous main-thread build)
        if (this._pendingAdds.length > 0) {
            const { items, metrics, defaultColor } = this._prepareAddsForBuild();
            const buffers = getWorkerBridge().buildBatchBuffersSync(items, { metrics, defaultColor });
            this._commitBuiltBuffers(buffers, items);
        }

        if (this._renderer && this._pickingSystem) {
            this._pickingSystem.registerRenderer(this._renderer);
        }

        this._dirty = false;
        this._contentBoundsDirty = true;
    }

    /**
     * Flush pending changes via Web Workers (async).
     * Falls back to sync _flush() if workers unavailable.
     * @private
     * @returns {Promise<void>}
     */
    async _flushAsync() {
        if (!this._dirty) return;

        if (!isWorkersSupported() || this._pendingAdds.length === 0) {
            return this._flush();
        }

        // Defer removals until the worker returns. Applying them now would
        // empty the GPU buffer while we wait ~5-20ms for the new content to
        // build, flashing the grid. _commitBuiltBuffers applies them in the
        // same synchronous block as the buffer swap, so old→new is atomic.
        const deferredRemovals = this._pendingRemovals;
        this._pendingRemovals = [];

        if (this._pendingAdds.length > 0) {
            const { items, metrics, defaultColor } = this._prepareAddsForBuild();
            try {
                const buffers = await getWorkerBridge().buildBatchBuffers(items, { metrics, defaultColor });
                this._commitBuiltBuffers(buffers, items, deferredRemovals);
            } catch (error) {
                console.warn('CodeGrid: Worker flush failed, falling back to sync:', error);
                // Put the deferred removals back so _flush() applies them.
                this._pendingRemovals = deferredRemovals.concat(this._pendingRemovals);
                this._flush();
                return;
            }
        }

        if (this._renderer && this._pickingSystem) {
            this._pickingSystem.registerRenderer(this._renderer);
        }

        this._dirty = false;
    }

    /**
     * Initialize background plane
     * @private
     */
    _initBackground() {
        const geometry = new THREE.PlaneGeometry(1, 1);
        const material = new THREE.MeshBasicMaterial({
            color: this.config.backgroundColor,
            transparent: true,
            opacity: this.config.backgroundOpacity,
            side: THREE.DoubleSide,
            depthWrite: false
        });

        this._background = new THREE.Mesh(geometry, material);
        this._background.renderOrder = RENDER_ORDER.GRID_BACKGROUND; // Draw backgrounds before glyphs
        this._background.position.z = -0.1; // Just behind text — minimal float
        this._background.visible = this.config.showBackground;
        this.add(this._background);
    }

    /**
     * Clear content from renderer
     * @private
     */
    _clearContent() {
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

        // Removals stay pending. Callers (loadText → _layoutContent,
        // loadTextAsync → _layoutContentAsync) flush afterwards — doing it
        // here would push an empty GPU frame and flash the grid.
    }

    /**
     * Layout content synchronously. Identical to _layoutContentAsync except
     * it builds on the main thread (loadText must finish before the caller
     * applies highlights). Adds the whole content as ONE item — the builder
     * lays out the lines and emits the authoritative line→slot offsets.
     * @private
     */
    _layoutContent() {
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

        // Add ENTIRE content as a single text item (builder handles newlines)
        if (this.content.length > 0) {
            const id = this._addText(
                this.content,
                { x: 0, y: currentY, z: 0 },
                { color: this.config.textColor }
            );
            this._contentTextIds.push(id);
        }

        this._flush();

        // Build line→slot index from the builder's authoritative line offsets,
        // plus the per-line wrap data + layout origin used by cursor math.
        const contentItemMeta = this._getContentItemMeta();
        this._buildLineSlotBase(contentItemMeta?.lineSlotOffsets);
        this._buildLayoutWrapIndex(contentItemMeta?.wrapColsPerLine);
        this._layoutOriginY = (this.config.showFilename && this.filename)
            ? -this.metrics.lineHeight * 1.5
            : 0;
    }

    /**
     * Layout content using Web Workers (async path).
     * Sends entire content as ONE text item (worker handles newlines).
     * @private
     */
    async _layoutContentAsync() {
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

        // Flush using worker pipeline
        await this._flushAsync();

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
     * Compute the plain-object content bounds over all committed renderer entries.
     * Returns { min, max, width, height, depth } or null.
     * @private
     */
    _getContentBounds() {
        // Fast path: worker precomputed bounds are still valid
        if (!this._contentBoundsDirty && this._workerBoundsCache) {
            return this._workerBoundsCache;
        }
        if (!this._contentBoundsDirty && this._contentBoundsCache) {
            return this._contentBoundsCache;
        }

        if (!this._renderer) {
            this._contentBoundsCache = null;
            return null;
        }

        // Walk all committed renderedTexts entries and union their bounds
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        let found = false;

        for (const [, entry] of this._renderer.renderedTexts) {
            const b = this._renderer._getTextBounds(entry);
            if (!b) continue;
            found = true;
            if (b.min.x < minX) minX = b.min.x;
            if (b.min.y < minY) minY = b.min.y;
            if (b.min.z < minZ) minZ = b.min.z;
            if (b.max.x > maxX) maxX = b.max.x;
            if (b.max.y > maxY) maxY = b.max.y;
            if (b.max.z > maxZ) maxZ = b.max.z;
        }

        if (!found) {
            this._contentBoundsCache = null;
            this._contentBoundsDirty = false;
            return null;
        }

        this._contentBoundsCache = {
            min: { x: minX, y: minY, z: minZ },
            max: { x: maxX, y: maxY, z: maxZ },
            width:  maxX - minX,
            height: maxY - minY,
            depth:  maxZ - minZ,
        };
        this._contentBoundsDirty = false;
        return this._contentBoundsCache;
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
        if (!this._lineWrapCols || !this._lineStartRow) return null;
        if (line < 0 || line >= this._lineStartRow.length) return null;
        const m = this.metrics;
        if (!m) return null;

        // Clamp col to source-line length so cursors past EOL still resolve.
        const lineLen = this.lines[line]?.length ?? 0;
        const c = Math.max(0, Math.min(col, lineLen));

        // Find which wrap segment this col is on (affinity=right at boundaries).
        const wraps = this._lineWrapCols[line];
        let segmentRow = 0;
        let segmentStartCol = 0;
        for (let i = 0; i < wraps.length; i++) {
            if (wraps[i] > c) break;
            segmentRow = i + 1;
            segmentStartCol = wraps[i];
        }

        const visualRow  = this._lineStartRow[line] + segmentRow;
        const advance    = m.charWidth + (m.spacing || 0);
        const originY    = this._layoutOriginY ?? 0;
        const originX    = 0;

        // Pre-pagination position.
        let x = originX + (c - segmentStartCol) * advance;
        // CodeGrid's metrics call this lineHeight; the worker's metrics call
        // the same value lineSpacing — both = atlasCharSize.height * scale * 1.2.
        const lineSpacing = m.lineHeight;
        let y = originY - visualRow * lineSpacing;

        // Apply pagination — same formula buildBatchBuffers / applyPagination
        // use, so the caret aligns with glyphs that were similarly shifted.
        const pageHeightWorld = PAGE_CONFIG.pageHeight * lineSpacing;
        const relY = originY - y;
        if (relY >= pageHeightWorld) {
            const charAdvance   = m.charWidth + (m.spacing || 0);
            const pageWidthWorld = Z_WRAP_CONFIG.maxLineWidth * charAdvance;
            const gapXWorld     = PAGE_CONFIG.pageGapX * charAdvance;
            const gapYWorld     = PAGE_CONFIG.pageGapY * lineSpacing;

            const vPage           = Math.floor(relY / pageHeightWorld);
            const rowOffsetInPage = relY - vPage * pageHeightWorld;
            const hSlot           = vPage % PAGE_CONFIG.pagesWide;
            const yRow            = Math.floor(vPage / PAGE_CONFIG.pagesWide);

            y = originY - rowOffsetInPage - yRow * (pageHeightWorld + gapYWorld);
            x = x + hSlot * (pageWidthWorld + gapXWorld);
        }

        return { x, y };
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
        if (!this._lineSlotBase || line < 0 || line >= this._lineSlotBase.length) return -1;
        return this._lineSlotBase[line] + col;
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
     * Highlight a range of characters with additive color.
     * @param {number} startLine - 0-based inclusive
     * @param {number} startCol - 0-based inclusive (codepoint index)
     * @param {number} endLine - 0-based inclusive
     * @param {number} endCol - 0-based exclusive (codepoint index)
     * @param {{r:number, g:number, b:number}} color
     */
    highlightRange(startLine, startCol, endLine, endCol, color) {
        if (!this._renderer || !this._lineSlotBase) return;

        for (let line = startLine; line <= endLine; line++) {
            const cStart = (line === startLine) ? startCol : 0;
            const cEnd   = (line === endLine)   ? endCol   : this.getLineSlotCount(line);
            const lineBase = this._lineSlotBase[line];
            if (lineBase === undefined) continue;

            for (let col = cStart; col < cEnd; col++) {
                this._renderer.setGlyphHighlight(lineBase + col, color);
            }
        }
    }

    /**
     * Clear highlights on a specific line.
     * @param {number} line - 0-based line index
     */
    clearLineHighlight(line) {
        if (!this._renderer || !this._lineSlotBase) return;
        const count = this.getLineSlotCount(line);
        const base  = this._lineSlotBase[line];
        for (let i = 0; i < count; i++) {
            this._renderer.setGlyphHighlight(base + i, null);
        }
    }

    /**
     * Clear all glyph highlights on this grid.
     * Delegates to clearLineHighlight() for each line — uses the RGBA8 DataTexture path.
     */
    clearAllHighlights() {
        if (!this._lineSlotBase) return;
        const lineCount = this.getLineCount();
        for (let line = 0; line < lineCount; line++) {
            this.clearLineHighlight(line);
        }
    }

    // ============ In-grid Editing ============
    //
    // The grid is the editor: edit ops mutate `this.lines` then trigger an
    // async loadTextAsync rebuild via _relayoutPreservingCursor (the worker
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
            const lastCol  = this.lines[lastLine]?.length ?? 0;
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
    }

    /** @returns {{line:number, col:number}|null} */
    getCursor() {
        return this._cursor ? { line: this._cursor.line, col: this._cursor.col } : null;
    }

    /**
     * Move the cursor to (line, col), clamping to valid bounds. Repaints
     * the caret. No-op if not in edit mode.
     */
    setCursor(line, col) {
        if (!this._cursor) return;
        const ln = Math.max(0, Math.min(line, this.lines.length - 1));
        const cl = Math.max(0, Math.min(col, this.lines[ln]?.length ?? 0));
        this._cursor = { line: ln, col: cl };
        this._updateCaretMesh();
    }

    /** Insert a string at the cursor. Splits on `\n` to span multiple lines. */
    editInsert(str) {
        if (!this._cursor || !str) return;
        const parts = String(str).split('\n');
        const { line, col } = this._cursor;
        const cur = this.lines[line] ?? '';
        const before = cur.slice(0, col);
        const after  = cur.slice(col);

        if (parts.length === 1) {
            this.lines[line] = before + parts[0] + after;
            this._cursor.col = col + parts[0].length;
        } else {
            const tail = parts[parts.length - 1];
            const newLines = [
                before + parts[0],
                ...parts.slice(1, -1),
                tail + after,
            ];
            this.lines.splice(line, 1, ...newLines);
            this._cursor.line = line + parts.length - 1;
            this._cursor.col  = tail.length;
        }
        this._relayoutPreservingCursor();
    }

    /** Backspace: delete char before cursor; if at col 0, join with previous line. */
    editDeleteBackward() {
        if (!this._cursor) return;
        const { line, col } = this._cursor;
        if (col > 0) {
            const cur = this.lines[line] ?? '';
            this.lines[line] = cur.slice(0, col - 1) + cur.slice(col);
            this._cursor.col = col - 1;
        } else if (line > 0) {
            const prev = this.lines[line - 1] ?? '';
            const cur  = this.lines[line] ?? '';
            this._cursor.line = line - 1;
            this._cursor.col  = prev.length;
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
        if (col < cur.length) {
            this.lines[line] = cur.slice(0, col) + cur.slice(col + 1);
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
        this.lines.splice(line, 1, cur.slice(0, col), cur.slice(col));
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

        // Vertical first
        if (dy) {
            line = Math.max(0, Math.min(line + dy, lineCount - 1));
            col  = Math.min(col, this.lines[line]?.length ?? 0);
        }

        // Then horizontal, wrapping line boundaries
        while (dx > 0) {
            const len = this.lines[line]?.length ?? 0;
            if (col < len) { col++; dx--; continue; }
            if (line < lineCount - 1) { line++; col = 0; dx--; continue; }
            break;
        }
        while (dx < 0) {
            if (col > 0) { col--; dx++; continue; }
            if (line > 0) { line--; col = this.lines[line]?.length ?? 0; dx++; continue; }
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
        const len = this.lines[this._cursor.line]?.length ?? 0;
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
            return;
        }

        const barWidth  = Math.max(m.charWidth * 0.1, 0.5);
        const barHeight = m.lineHeight;

        // Plane is centered on its origin; shift right by half-width so the
        // bar's left edge sits at the resolved x.
        this._caretMesh.scale.set(barWidth, barHeight, 1);
        this._caretMesh.position.set(pos.x + barWidth / 2, pos.y, 0.05);
        this._caretMesh.visible = true;
    }

    /**
     * Rebuild glyphs after a content mutation, clearing stale highlights and
     * re-painting the caret.
     *
     * Routes through loadTextAsync (the worker pipeline) because that path
     * calls applyPrebuiltBuffers which swaps in fresh, exactly-sized
     * InstancedBufferAttributes. The sync loadText path reuses the existing
     * renderer with its original maxInstances cap and overflows the moment
     * an edit grows the content past the initial buffer (WebGL warns about
     * "instance fetch requires N, attribs only supply M" and rendering
     * silently breaks).
     *
     * Edit ops fire-and-forget the returned promise. Rapid keystrokes are
     * coalesced via _relayoutInFlight + _relayoutQueued so concurrent
     * flushes don't trample _pendingAdds / _pendingRemovals.
     *
     * @private
     */
    async _relayoutPreservingCursor() {
        if (this._relayoutInFlight) {
            this._relayoutQueued = true;
            return;
        }
        this._relayoutInFlight = true;
        try {
            do {
                this._relayoutQueued = false;
                await this.loadTextAsync(this.lines.join('\n'));
                if (this._cursor) {
                    const ln = Math.min(this._cursor.line, this.lines.length - 1);
                    const cl = Math.min(this._cursor.col,  this.lines[ln]?.length ?? 0);
                    this._cursor.line = Math.max(0, ln);
                    this._cursor.col  = Math.max(0, cl);
                    this._updateCaretMesh();
                }
            } while (this._relayoutQueued);
        } finally {
            this._relayoutInFlight = false;
        }
    }

    /**
     * Update background to match content size
     * @private
     */
    _updateBackground() {
        // Content changed — dirty the world-space bounds cache
        this._boundsCacheDirty = true;

        if (!this._background || !this.config.showBackground) {
            if (this._background) {
                this._background.visible = false;
            }
            return;
        }

        const bounds = this._getContentBounds();
        if (!bounds) {
            this._background.visible = false;
            return;
        }

        const padding = this.config.backgroundPadding;

        // Size background to content
        const width  = bounds.width  + padding * 2;
        const height = bounds.height + padding * 2;

        if (width > 0 && height > 0) {
            this._background.scale.set(width, height, 1);

            // Position background at the BACK of the bounding box (Z min)
            // This ensures background is behind all Z-wrapped text layers
            const zMin = bounds.min.z !== undefined ? bounds.min.z : 0;
            const backgroundZ = zMin - 0.5;  // Slightly behind the furthest text

            this._background.position.set(
                bounds.min.x + bounds.width  / 2,
                bounds.min.y + bounds.height / 2,
                backgroundZ
            );

            this._background.visible = true;
        } else {
            this._background.visible = false;
        }
    }
}

export default CodeGrid;

/**
 * TerminalGrid — renders a fixed-size terminal cell grid using direct typed array
 * writes to GlyphRendererV15.
 *
 * Each cell in the (cols × rows) grid maps to exactly one glyph instance via
 * row-major indexing. The grid uses a dedicated GlyphRenderer instance and a
 * single group in the DataTexture for O(1) world-position moves.
 *
 * Design principles (from cross-ref/tmux-terminal-integration convergence):
 *   - Fixed instance count: cols * rows (spaces are rendered, not skipped)
 *   - Parallel typed arrays (_codepoints, _cellR, _cellG, _cellB) are canonical
 *   - GPU attribute arrays are a projection of those canonical arrays
 *   - Full buffer rewrite per frame (correct for 1920-cell terminals at 2Hz)
 *   - Direct Float32Array writes via _writeToInstanceBuffer(), not addText()
 *   - Group DataTexture for O(1) position changes (one DataTexture write vs. N buffer writes)
 *   - setWorldPosition() mirrors to both group offset AND Object3D.position
 *
 * Differs from TUIWindow / CodeGrid:
 *   - No line-buffer history, no ANSI stripping
 *   - No GlyphCollection deferred queue, no _rebuildAllInstances() on update
 *   - No background plane, no filename label
 *   - update cost: O(cols*rows) float writes + two needsUpdate flags
 */

import * as THREE from 'three';
import GlyphField from '../GlyphField.js';
import TerminalEmulator from './TerminalEmulator.js';
import { RENDER_ORDER } from '../core/renderOrder.js';
import MonospaceShapeCache from '../shaping/MonospaceShapeCache.js';

export default class TerminalGrid extends THREE.Object3D {
    /**
     * @param {THREE.Scene} scene
     * @param {import('../GlyphAtlas.js').default} atlas
     * @param {Object} [options]
     * @param {number} [options.cols=80]        Terminal width in columns
     * @param {number} [options.rows=24]        Terminal height in rows
     * @param {number} [options.worldScale=0.025] World units per atlas pixel
     * @param {{x:number,y:number,z:number}} [options.position]  Initial world position
     * @param {string} [options.title='TerminalGrid']  Debug name
     */
    constructor(scene, atlas, options = {}) {
        super();

        this.scene = scene;
        this.atlas = atlas;

        // The GPU attribute is `instanceGlyphId` (a font glyph index used to index
        // the Slug glyphMapTexture), NOT a Unicode codepoint. The normal render
        // path shapes text through HarfBuzz to get glyph IDs; we bypass shaping, so
        // we map each codepoint → glyphId through the atlas's primed shape cache
        // (its IDs are exactly the ones the glyphMapTexture is keyed by). Reuse the
        // shared cache when present; otherwise build one from the shaper.
        this._shapeCache = atlas?._shapeCache
            || (atlas?._shaper ? new MonospaceShapeCache(atlas._shaper) : null);

        this.cols = options.cols ?? 80;
        this.rows = options.rows ?? 24;
        this.name = options.title ?? 'TerminalGrid';

        /**
         * Input callback -- set by the owning agent or process.
         * When set, `terminal.input` routes decoded plaintext through this callback.
         * Signature: (text: string, terminalId: string) => void
         * @type {Function|null}
         */
        this.onInput = null;

        const worldScale = options.worldScale ?? 0.025;
        this._gridScale = options.gridScale ?? 1.0;

        // One dedicated renderer per terminal (phase 1).
        // Phase 2: shared renderer via segment allocation.
        this._renderer = new GlyphField(scene, atlas, {
            maxInstances: this.cols * this.rows,
            worldScale,
            defaultColor: { r: 0.0, g: 1.0, b: 0.0 },
        });

        // Derive world-unit metrics from the renderer so glyph sizes match the atlas.
        this._metrics = this._renderer.metrics;

        // World-space bounds cache (for picking + camera framing). The local box
        // depends only on cols/rows/metrics (dirtied on resize); the world box is
        // re-derived per call by applying the current world matrix.
        this._localBounds = null;
        this._worldBounds = null;
        this._localBoundsDirty = true;

        // Optional picking system — wired via setPickingSystem(). Terminals keep a
        // fixed cols*rows instance count, so the renderer is re-registered only on
        // resize (not per content frame, unlike CodeGrid which re-flushes geometry).
        this._pickingSystem = null;

        // Acquire a group in the DataTexture for O(1) positioning.
        this._groupId = this._renderer.createGroup();

        // ---- Canonical parallel typed arrays ----
        // These are the source of truth. GPU attribute arrays are their projection.
        // Invariant: _codepoints[i], _cellR[i], _cellG[i], _cellB[i] always reflect
        // the most recently written cell state. GPU attributes are synced by
        // _writeToInstanceBuffer() / _applyToRenderer().
        this._cellCount = this.cols * this.rows;
        this._codepoints = new Float32Array(this._cellCount).fill(32);     // space
        this._cellR      = new Float32Array(this._cellCount).fill(0.8);
        this._cellG      = new Float32Array(this._cellCount).fill(0.8);
        this._cellB      = new Float32Array(this._cellCount).fill(0.8);

        // Pre-computed positions (only change on resize).
        this._positions = new Float32Array(this._cellCount * 3);
        this._computePositions();

        // Constant sizes: every cell gets the same charWidth × charHeight.
        // Written once at construction / resize; never touched during updates.
        this._sizes = new Float32Array(this._cellCount * 2);
        this._computeSizes();

        // All cells share this terminal's groupId.
        this._groupIds = new Float32Array(this._cellCount).fill(this._groupId);

        // Push the initial empty buffer to the renderer (swaps in our typed arrays).
        // After this call, geometry.attributes.* point directly at our arrays, so
        // _writeToInstanceBuffer() can write in place without allocation.
        this._applyToRenderer();

        // Background plane — dark panel behind the terminal for readability.
        this._background = null;
        this._bgColor = options.backgroundColor ?? 0x0a0a1e;
        this._bgOpacity = options.backgroundOpacity ?? 0.92;
        this._bgPadding = options.backgroundPadding ?? 0.3;
        this._initBackground();

        // Add the renderer's mesh as a child so transforms propagate.
        this.add(this._renderer.instanceMesh);

        // Apply gridScale (larger = bigger terminal in world space).
        if (this._gridScale !== 1.0) {
            this.scale.setScalar(this._gridScale);
        }

        // Add this Object3D to the scene.
        scene.add(this);

        // Apply initial world position if provided.
        if (options.position) {
            this.setWorldPosition(options.position);
        }

        // Byte→screen source: a headless VT emulator parses the terminal byte stream
        // and drives applyScreen. TerminalGrid stays a pure cell renderer; the
        // emulator is one source feeding it (file-slice / graphics are others, later).
        this._emulator = new TerminalEmulator(this.cols, this.rows, (screen) => this.applyScreen(screen));
    }

    // ================================================================
    // Public API
    // ================================================================

    /**
     * Accept a ScreenBuffer and update the GPU instance arrays.
     *
     * ScreenBuffer contract (produced by TerminalEmulator's cell adapter):
     *   { cols: number, rows: number,
     *     cells: Array<Array<{ codepoint: number, fg: {r,g,b}, bold: boolean }>> }
     *
     * Update cost: O(cols*rows) scalar writes + two GPU attribute uploads (~20KB each).
     *
     * @param {{ cols: number, rows: number, cells: Array<Array<{codepoint:number,fg:{r,g,b},bold:boolean}>> }} screen
     */
    applyScreen(screen) {
        // Ensure all incoming codepoints are present in the atlas before writing.
        this._ensureAtlasCodepoints(screen);

        const cols = this.cols;
        const rows = this.rows;
        const cp = this._codepoints;
        const cr = this._cellR;
        const cg = this._cellG;
        const cb = this._cellB;

        for (let row = 0; row < rows; row++) {
            const screenRow = screen.cells[row];
            if (!screenRow) {
                // Row not present in buffer: fill with spaces at default color
                for (let col = 0; col < cols; col++) {
                    const idx = row * cols + col;
                    cp[idx] = 32;
                    cr[idx] = 0.8; cg[idx] = 0.8; cb[idx] = 0.8;
                }
                continue;
            }

            for (let col = 0; col < cols; col++) {
                const idx = row * cols + col;
                const cell = screenRow[col];

                if (!cell) {
                    cp[idx] = 32;
                    cr[idx] = 0.8; cg[idx] = 0.8; cb[idx] = 0.8;
                    continue;
                }

                // Emulator/source cells carry .codepoint (number) directly.
                cp[idx] = cell.codepoint ?? 32;

                const fg = cell.fg ?? { r: 0.8, g: 0.8, b: 0.8 };
                if (cell.bold) {
                    // Bold: boost brightness by 40%, clamp to 1.
                    cr[idx] = Math.min(fg.r * 1.4, 1.0);
                    cg[idx] = Math.min(fg.g * 1.4, 1.0);
                    cb[idx] = Math.min(fg.b * 1.4, 1.0);
                } else {
                    cr[idx] = fg.r;
                    cg[idx] = fg.g;
                    cb[idx] = fg.b;
                }
            }
        }

        // Project canonical arrays → GPU attribute arrays.
        this._writeToInstanceBuffer();
    }

    /**
     * Feed raw VT bytes from the terminal byte stream. The internal headless VT
     * emulator parses them (cursor motion, scroll regions, erase, SGR, …) and drives
     * applyScreen on the next frame. Replaces the retired snapshot write(text).
     *
     * @param {Uint8Array|string} payload - raw terminal output bytes
     */
    writeBytes(payload) {
        this._emulator.write(payload);
    }

    /**
     * Move the terminal in 3D space. O(1): one DataTexture write.
     * Also mirrors to Object3D.position so scene graph / layout managers work.
     *
     * @param {{ x: number, y: number, z: number }} pos
     */
    setWorldPosition(pos) {
        this.position.set(pos.x, pos.y, pos.z);
    }

    /**
     * Show or hide the terminal. O(1): sets group color alpha in DataTexture.
     * Invisible groups trigger the fragment shader's alpha discard.
     *
     * @param {boolean} visible
     */
    setVisible(visible) {
        this._renderer.setGroupVisibility(this._groupId, visible);
    }

    /**
     * Apply a uniform scale to this terminal's group.
     * O(1): one DataTexture write.
     *
     * @param {number} factor
     */
    setScale(factor) {
        this._gridScale = factor;
        this.scale.setScalar(factor);
    }

    /**
     * World-space axis-aligned bounds of the terminal (the padded cell panel),
     * for canvas picking and camera framing. Mirrors CodeGrid.getBounds()'s
     * contract: a THREE.Box3 in world space. The local extent is cached and only
     * rebuilt on resize; the world box is re-derived each call from the current
     * world matrix (8-corner transform — cheap).
     * @returns {THREE.Box3}
     */
    getBounds() {
        this.updateWorldMatrix(true, false);

        if (!this._localBounds || this._localBoundsDirty) {
            const m = this._metrics;
            const strideX = m.charWidth + m.letterSpacing;
            const strideY = m.lineSpacing;
            const pad = this._bgPadding;
            const width  = this.cols * strideX + pad * 2;
            const height = this.rows * strideY + pad * 2;
            const cx = (this.cols * strideX) / 2 - m.charWidth / 2;
            const cy = -(this.rows * strideY) / 2 + strideY / 2;
            // Small Z thickness so an edge-on ray still intersects the flat panel.
            this._localBounds = new THREE.Box3(
                new THREE.Vector3(cx - width / 2, cy - height / 2, -1),
                new THREE.Vector3(cx + width / 2, cy + height / 2, 1),
            );
            this._localBoundsDirty = false;
        }

        if (!this._worldBounds) this._worldBounds = new THREE.Box3();
        this._worldBounds.copy(this._localBounds).applyMatrix4(this.matrixWorld);
        return this._worldBounds;
    }

    /**
     * Get the underlying GlyphField renderer. Mirrors CodeGrid.getRenderer() so
     * canvas picking can map a resolved pick (renderer) back to this entity.
     * @returns {import('../GlyphField.js').default|null}
     */
    getRenderer() {
        return this._renderer;
    }

    /**
     * Wire a PickingSystem. Registers two channels (mirrors CodeGrid):
     *   - 'glyph' (token = renderer) — per-cell picks; resize() re-registers it
     *     (cols*rows changes the instance count).
     *   - 'grid'  (token = this terminal) — the background panel, the whole-panel
     *     grid-level pickable; stable, registered once here.
     * @param {import('../picking/PickingSystem.js').PickingSystem} pickingSystem
     */
    setPickingSystem(pickingSystem) {
        this._pickingSystem = pickingSystem;
        if (!pickingSystem) return;
        if (this._renderer)   pickingSystem.register('glyph', this._renderer, this._renderer);
        if (this._background) pickingSystem.register('grid', this._background, this);
    }

    /**
     * Resize the terminal. Rebuilds parallel arrays and positions.
     * After resize, the next write() / applyScreen() provides the new content.
     *
     * @param {number} cols
     * @param {number} rows
     */
    resize(cols, rows) {
        const newCount = cols * rows;
        this.cols = cols;
        this.rows = rows;
        this._cellCount = newCount;
        this._localBoundsDirty = true;

        // Grow typed arrays if the new size exceeds current capacity.
        if (newCount > this._codepoints.length) {
            this._codepoints = new Float32Array(newCount).fill(32);
            this._cellR      = new Float32Array(newCount).fill(0.8);
            this._cellG      = new Float32Array(newCount).fill(0.8);
            this._cellB      = new Float32Array(newCount).fill(0.8);
            this._positions  = new Float32Array(newCount * 3);
            this._sizes      = new Float32Array(newCount * 2);
            this._groupIds   = new Float32Array(newCount).fill(this._groupId);
        } else {
            // Reuse existing buffers; zero them out to avoid stale cell data.
            this._codepoints.fill(32, 0, newCount);
            this._cellR.fill(0.8, 0, newCount);
            this._cellG.fill(0.8, 0, newCount);
            this._cellB.fill(0.8, 0, newCount);
        }

        this._computePositions();
        this._computeSizes();

        // Full re-apply: swaps in freshly-sized attribute arrays.
        this._applyToRenderer();
        this._updateBackground();

        // Instance count changed (cols*rows) → re-register the glyph channel so
        // the pick pass sees the new ID block and geometry. (The grid-channel
        // panel is stable; _updateBackground only rescaled it.)
        if (this._pickingSystem) {
            this._pickingSystem.register('glyph', this._renderer, this._renderer);
        }

        // Keep the byte→screen emulator in lockstep — its next screen reflects the
        // new dimensions. (Pairs with the adapter's pty.Setsize for full agreement.)
        this._emulator?.resize(cols, rows);
    }

    /**
     * Dispose the renderer and remove the mesh from the scene.
     * Call this when the terminal is permanently closed.
     */
    dispose() {
        // Tear down the emulator first (cancels its pending rAF read so it can't
        // call applyScreen on a half-disposed renderer).
        if (this._emulator) {
            this._emulator.dispose();
            this._emulator = null;
        }
        // Leave both picking channels cleanly before tearing down the renderer +
        // panel, or the passes would swap materials onto a disposed mesh.
        if (this._pickingSystem) {
            if (this._renderer)   this._pickingSystem.unregister('glyph', this._renderer);
            if (this._background) this._pickingSystem.unregister('grid', this._background);
        }
        if (this._renderer) {
            this._renderer.instanceMesh.geometry.dispose();
            this._renderer.instanceMesh.material.dispose();
            this._renderer = null;
        }
        if (this._background) {
            this._background.geometry.dispose();
            this._background.material.dispose();
            this._background = null;
        }
        this.scene.remove(this);
    }

    // ================================================================
    // Private: Layout
    // ================================================================

    /**
     * Pre-compute world-space XYZ positions for every cell.
     * Stored row-major: index = row * cols + col.
     * Origin is top-left; Y decreases downward (screen convention).
     * X increases rightward. Z is always 0 (group offset provides Z depth).
     * @private
     */
    _computePositions() {
        const m = this._metrics;
        const strideX = m.charWidth + m.letterSpacing;
        const strideY = m.lineSpacing;

        for (let row = 0; row < this.rows; row++) {
            const y = -row * strideY;
            for (let col = 0; col < this.cols; col++) {
                const idx = (row * this.cols + col) * 3;
                this._positions[idx]     = col * strideX;
                this._positions[idx + 1] = y;
                this._positions[idx + 2] = 0;
            }
        }
    }

    /**
     * Fill the sizes array with constant charWidth × charHeight for every cell.
     * Written once at construction / resize; never touched during content updates.
     * @private
     */
    _computeSizes() {
        const w = this._metrics.charWidth;
        const h = this._metrics.charHeight;
        for (let i = 0; i < this._cellCount; i++) {
            this._sizes[i * 2]     = w;
            this._sizes[i * 2 + 1] = h;
        }
    }

    // ================================================================
    // Private: GPU writes
    // ================================================================

    /**
     * Initial push: swap all five attribute arrays into the renderer via
     * applyPrebuiltBuffers(). After this call, geometry.attributes.* point
     * directly at our typed arrays, enabling zero-copy in-place updates.
     *
     * Must be called on construction and after resize (when arrays are reallocated).
     * @private
     */
    _applyToRenderer() {
        const count = this._cellCount;
        const colors = this._buildColorArray();

        this._renderer.applyPrebuiltBuffers({
            positions:  this._positions.slice(0, count * 3),
            sizes:      this._sizes.slice(0, count * 2),
            // `codepoints` is the renderer's name for the glyphId attribute (the
            // builder emits it as a codepoints-aliased glyphIds array); feed real
            // glyph IDs, not raw codepoints.
            codepoints: this._buildGlyphIdArray(),
            colors,
            groupIds:   this._groupIds.slice(0, count),
            count,
        });

        // After applyPrebuiltBuffers the geometry owns new InstancedBufferAttribute objects
        // wrapping the arrays we passed. On subsequent frames, _writeToInstanceBuffer()
        // writes into geometry.attributes.*.array in place.
    }

    /**
     * Per-frame GPU sync: write codepoints and colors from the canonical parallel
     * arrays directly into the geometry's InstancedBufferAttribute backing arrays,
     * then flag needsUpdate once each.
     *
     * Positions and sizes are unchanged between frames — no needsUpdate on them.
     *
     * Falls back to _applyToRenderer() if the attribute arrays have not been
     * initialized yet (should not happen in normal use).
     *
     * @private
     */
    _writeToInstanceBuffer() {
        const geom = this._renderer.instanceMesh.geometry;
        const cpAttr    = geom.attributes.instanceGlyphId;
        const colorAttr = geom.attributes.instanceColor;

        if (!cpAttr || !colorAttr) {
            // Attributes not set up yet (e.g., skipPrealloc path): do a full apply.
            this._applyToRenderer();
            return;
        }

        const cpArr    = cpAttr.array;
        const colorArr = colorAttr.array;
        const count    = this._cellCount;

        for (let i = 0; i < count; i++) {
            cpArr[i] = this._glyphId(this._codepoints[i]);

            const c = i * 3;
            colorArr[c]     = this._cellR[i];
            colorArr[c + 1] = this._cellG[i];
            colorArr[c + 2] = this._cellB[i];
        }

        cpAttr.needsUpdate    = true;
        colorAttr.needsUpdate = true;
        // instanceCount is unchanged if cell count did not change.
        // After resize, _applyToRenderer() sets the correct instanceCount.
    }

    /**
     * Build an interleaved [r,g,b, r,g,b, ...] Float32Array from the parallel
     * _cellR/_cellG/_cellB arrays.
     *
     * Used only on the _applyToRenderer() path. Subsequent frame updates write
     * directly into the geometry's existing attribute array.
     *
     * @private
     * @returns {Float32Array}
     */
    _buildColorArray() {
        const count = this._cellCount;
        const arr = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
            arr[i * 3]     = this._cellR[i];
            arr[i * 3 + 1] = this._cellG[i];
            arr[i * 3 + 2] = this._cellB[i];
        }
        return arr;
    }

    /**
     * Map a Unicode codepoint to a font glyph ID for the instanceGlyphId attribute.
     * Uses the primed shape cache (O(1), HarfBuzz fallback on miss). Without a
     * shaper (e.g. degraded boot), falls back to the codepoint so output is at
     * least stable rather than crashing.
     * @private
     * @param {number} codepoint
     * @returns {number}
     */
    _glyphId(codepoint) {
        if (this._shapeCache) {
            const entry = this._shapeCache.lookup(codepoint);
            if (entry) return entry.g;
        }
        return codepoint;
    }

    /**
     * Build a Float32Array of glyph IDs (the GPU projection of _codepoints) for the
     * full-apply path. Per-frame updates write glyph IDs in place via _glyphId().
     * @private
     * @returns {Float32Array}
     */
    _buildGlyphIdArray() {
        const count = this._cellCount;
        const arr = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            arr[i] = this._glyphId(this._codepoints[i]);
        }
        return arr;
    }

    /**
     * Ensure all codepoints in the incoming ScreenBuffer are present in the atlas.
     * Missing codepoints are added by GlyphAtlas.ensureCodepoints(), which handles
     * canvas re-pack, DataTexture invalidation, and CanvasTexture deferred re-upload.
     *
     * @private
     * @param {{ cells: Array<Array<{codepoint:number}>> }} screen
     */
    _ensureAtlasCodepoints(screen) {
        const missing = [];
        for (let row = 0; row < screen.rows; row++) {
            const screenRow = screen.cells[row];
            if (!screenRow) continue;
            for (let col = 0; col < screen.cols; col++) {
                const cell = screenRow[col];
                if (!cell) continue;
                const code = cell.codepoint ?? 32;
                if (code > 32 && !this.atlas.uvMap.has(code)) {
                    missing.push(code);
                }
            }
        }
        if (missing.length > 0) {
            this.atlas.ensureCodepoints(missing);
            // Flush the deferred CanvasTexture re-upload flag immediately so the
            // atlas texture is fresh before the next draw call.
            if (this.atlas.checkAndClearTextureUpdate && this._renderer.texture) {
                this.atlas.checkAndClearTextureUpdate();
                this._renderer.texture.needsUpdate = true;
            }
        }
    }

    // ================================================================
    // Private: Background
    // ================================================================

    /**
     * Create a dark background plane behind the terminal for readability.
     * Sized to fit cols×rows with padding. Updated on resize.
     *
     * L0 invariant (editable-3d-ide cross-ref): this mesh is also the
     * raycast hit-target for the terminal entity. EntityInputRouter's
     * _raycast (src/services/interaction/EntityInputRouter.js) walks
     * `registry.findByType('terminal')`, pulls `entry.grid?._background`,
     * and intersects. So:
     *   - The mesh must exist and have `visible = true` (THREE.Mesh default).
     *   - It must be `DoubleSide` so a camera approaching from either side
     *     can hit it (the grid is typically drawn at z=0 with the camera
     *     anywhere in world space).
     *   - The padded size (cols*strideX + 2*pad × rows*strideY + 2*pad, see
     *     _updateBackground) is effectively full-bleed over the cell grid,
     *     giving clicks a generous target even at the edge of the last row.
     * Do not remove, shrink below the cell extent, or set `visible = false`
     * without replacing the raycast target with another mesh.
     * @private
     */
    _initBackground() {
        const geometry = new THREE.PlaneGeometry(1, 1);
        const material = new THREE.MeshBasicMaterial({
            color: this._bgColor,
            transparent: true,
            opacity: this._bgOpacity,
            side: THREE.DoubleSide,
            depthWrite: false,
        });

        this._background = new THREE.Mesh(geometry, material);
        this._background.renderOrder = RENDER_ORDER.GRID_BACKGROUND;
        // Tagged so gesture dispatch can resolve background → terminal id
        // without a reverse-lookup through the registry. Matches the pattern
        // the app/ide.html parallel raycaster used (it stamped
        // `_background._terminalId` onto each mesh at hit time).
        this._background.userData.entityType = 'terminal';
        this.add(this._background);
        this._updateBackground();
    }

    /**
     * Resize and reposition the background plane to fit the current grid.
     * @private
     */
    _updateBackground() {
        if (!this._background) return;

        const m = this._metrics;
        const strideX = m.charWidth + m.letterSpacing;
        const strideY = m.lineSpacing;
        const pad = this._bgPadding;

        const width  = this.cols * strideX + pad * 2;
        const height = this.rows * strideY + pad * 2;

        this._background.scale.set(width, height, 1);
        this._background.position.set(
            (this.cols * strideX) / 2 - m.charWidth / 2,
            -(this.rows * strideY) / 2 + strideY / 2,
            -0.1  // just behind text — minimal float
        );
    }
}

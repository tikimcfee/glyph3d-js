/**
 * TerminalGrid — renders a fixed-size terminal cell grid using direct typed array
 * writes to GlyphField.
 *
 * Each cell in the (cols × rows) grid maps to exactly one glyph instance via
 * row-major indexing. The grid uses a dedicated GlyphField instance and a
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
 * Differs from CodeGrid:
 *   - No line-buffer history, no ANSI stripping
 *   - No GlyphCollection deferred queue, no _rebuildAllInstances() on update
 *   - No background plane, no filename label
 *   - update cost: O(cols*rows) float writes + two needsUpdate flags
 */

import * as THREE from 'three';
import GlyphField from '../GlyphField.js';
import TerminalEmulator from './TerminalEmulator.js';
import { detectVerticalScroll, captureScrolledRows, depthFade } from './terminalDepthHistory.js';
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

        // Codepoints we've already handed to the live Slug atlas for curve encoding.
        // Steady-state, every cell's codepoint is already in here, so per-frame work
        // is just a Set membership check — no calls into the encoder until a genuinely
        // new glyph (box-drawing, spinner star, …) shows up.
        this._liveEnsured = new Set();

        this.cols = options.cols ?? 80;
        this.rows = options.rows ?? 24;
        this.name = options.title ?? 'TerminalGrid';

        // ---- Scrollback-into-depth ----
        // Lines that scroll off the top of the live screen are kept as a client-side
        // ring and rendered as an "up-and-back ramp": each older line both RISES above
        // the live top row (+Y) AND steps back in −Z, faded with depth — so history
        // climbs into the distance like scrollback receding, readable at a glance
        // (newest just above/behind the screen, oldest highest + furthest). With
        // _depthYFactor=0 it degenerates to a flat straight-back stack on the top line.
        // (tmux owns true scrollback + repaints the visible pane only, so there is no
        // free "line scrolled off" event — we recover it by diffing frames; see
        // terminalDepthHistory.detectVerticalScroll.) Full-screen TUIs (alt-screen)
        // are excluded.
        this._depthEnabled = options.depthHistory ?? true;
        this._depthMax     = Math.max(0, options.depthMax ?? 80);   // history lines rendered
        this._depthFadeMin = options.depthFadeMin ?? 0.4;           // oldest line's brightness
        this._depthYFactor = options.depthYStep ?? 1.0;             // ×lineSpacing rise per line
        this._depthZFactor = options.depthZStep ?? 0.6;             // ×lineSpacing recede per line
        this._history  = [];      // captured rows, index 0 = newest scrolled-off
        this._prevRows = null;    // last live-screen snapshot, for scroll detection
        this._altActive = false;  // current frame is an alt-screen (TUI) repaint
        this._depthYStep = 0;     // world rise per history line (set once metrics exist)
        this._depthZStep = 0;     // world recede per history line (set once metrics exist)

        /**
         * Input callback -- set by the owning agent or process.
         * When set, `terminal.input` routes decoded plaintext through this callback.
         * Signature: (text: string, terminalId: string) => void
         * @type {Function|null}
         */
        this.onInput = null;

        const worldScale = options.worldScale ?? 0.025;
        this._gridScale = options.gridScale ?? 1.0;

        // Instance budget = live cells + a depth-history block (cols × _depthMax).
        // The live screen owns [0, _cellCount); history owns [_cellCount, _totalCount).
        // Allocated up front so the picking glyph-channel id-block stays stable
        // (history never grows the instance count — rows shift through fixed slots).
        this._cellCount  = this.cols * this.rows;
        this._depthCount = this.cols * this._depthMax;
        this._totalCount = this._cellCount + this._depthCount;

        // One dedicated renderer per terminal (phase 1).
        // Phase 2: shared renderer via segment allocation.
        this._renderer = new GlyphField(scene, atlas, {
            maxInstances: this._totalCount,
            worldScale,
            defaultColor: { r: 0.0, g: 1.0, b: 0.0 },
        });

        // Derive world-unit metrics from the renderer so glyph sizes match the atlas.
        this._metrics = this._renderer.metrics;
        // Per-history-line rise (+Y) and recession (−Z). Depth scales with the terminal
        // via this.scale, like X/Y, since positions are local.
        this._depthYStep = this._metrics.lineSpacing * this._depthYFactor;
        this._depthZStep = this._metrics.lineSpacing * this._depthZFactor;

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
        this._codepoints = new Float32Array(this._totalCount).fill(32);     // space
        this._cellR      = new Float32Array(this._totalCount).fill(0.8);
        this._cellG      = new Float32Array(this._totalCount).fill(0.8);
        this._cellB      = new Float32Array(this._totalCount).fill(0.8);

        // Pre-computed positions (only change on resize). Live cells + the static
        // depth-history slots (history CONTENT shifts through slots; slot positions
        // are fixed, so positions never change between frames).
        this._positions = new Float32Array(this._totalCount * 3);
        this._computePositions();

        // Constant sizes: every cell gets the same charWidth × charHeight.
        // Written once at construction / resize; never touched during updates.
        this._sizes = new Float32Array(this._totalCount * 2);
        this._computeSizes();

        // All cells (live + history) share this terminal's groupId.
        this._groupIds = new Float32Array(this._totalCount).fill(this._groupId);

        // Push the initial empty buffer to the renderer (swaps in our typed arrays).
        // After this call, geometry.attributes.* point directly at our arrays, so
        // _writeToInstanceBuffer() can write in place without allocation.
        this._applyToRenderer();

        // Background plane — dark panel behind the terminal for readability.
        this._background = null;
        this._bgColor = options.backgroundColor ?? 0x0a0a1e;
        this._bgOpacity = options.backgroundOpacity ?? 0.96;
        this._bgPadding = options.backgroundPadding ?? 0.3;
        this._visible = true; // setVisible state — folded with the fade (shared alpha slot)
        this._initBackground();
        // Fade glyphs to match the panel from the start, so a translucent tile reads
        // as one coherent sheet (text + bg together), not opaque text over glass.
        this._applyGlyphAlpha();

        // SE-corner resize grip — a visible affordance AND the 'handle' pick target.
        this._handle = null;
        this._initHandle();

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

        this._altActive = !!screen.alt;

        // Capture lines that scrolled off the top SINCE the last frame, BEFORE the
        // live loop overwrites the canonical arrays. _prevRows holds last frame's
        // snapshot; a detected upward shift of k means its top k rows are now history.
        if (this._depthEnabled && !this._altActive && this._prevRows) {
            const k = detectVerticalScroll(this._prevRows, screen, this.rows, this.cols);
            if (k > 0) {
                // Newest-first, so the line that was just above the new top lands at
                // index 0 (the forefront slot). Snapshot rows are immutable, so
                // aliasing them into the ring is safe.
                this._history.unshift(...captureScrolledRows(this._prevRows, k));
                if (this._history.length > this._depthMax) this._history.length = this._depthMax;
            }
        }

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

        // Snapshot the freshly-written live screen for next frame's scroll diff, then
        // paint the depth-history block from the ring. (Snapshot rows are fresh arrays
        // each frame, so aliasing one into _history is safe — it is never mutated.)
        this._snapshotLive();
        this._paintHistory();

        // Project canonical arrays (live + history) → GPU attribute arrays.
        this._writeToInstanceBuffer();
    }

    /**
     * Snapshot the live screen region of the canonical arrays into _prevRows — one
     * fresh {cp,r,g,b} per row. Used both for next frame's scroll diff (cp) and as
     * the immutable rows handed to the depth-history ring (cp + color).
     * @private
     */
    _snapshotLive() {
        const cols = this.cols;
        const rows = this.rows;
        const cp = this._codepoints, cr = this._cellR, cg = this._cellG, cb = this._cellB;
        const snap = new Array(rows);
        for (let y = 0; y < rows; y++) {
            const base = y * cols;
            const rcp = new Float32Array(cols);
            const rr = new Float32Array(cols);
            const rg = new Float32Array(cols);
            const rb = new Float32Array(cols);
            for (let x = 0; x < cols; x++) {
                rcp[x] = cp[base + x];
                rr[x] = cr[base + x];
                rg[x] = cg[base + x];
                rb[x] = cb[base + x];
            }
            snap[y] = { cp: rcp, r: rr, g: rg, b: rb };
        }
        this._prevRows = snap;
    }

    /**
     * Write the depth-history ring into the history region of the canonical arrays
     * ([_cellCount, _totalCount)). History slot h holds ring entry h (newest at 0),
     * dimmed by depth toward _depthFadeMin. Empty slots — and the whole block while
     * disabled or showing an alt-screen TUI — are blanked (spaces draw nothing).
     * Slot POSITIONS are static (see _computePositions); only content moves here.
     * @private
     */
    _paintHistory() {
        if (this._depthMax === 0) return;
        const cols = this.cols;
        const base0 = this._cellCount;
        const cp = this._codepoints, cr = this._cellR, cg = this._cellG, cb = this._cellB;
        const hist = this._history;
        const n = hist.length;
        const dmax = this._depthMax;
        const fmin = this._depthFadeMin;
        const hide = !this._depthEnabled || this._altActive;

        for (let h = 0; h < dmax; h++) {
            const base = base0 + h * cols;
            if (hide || h >= n) {
                for (let x = 0; x < cols; x++) {
                    const i = base + x;
                    cp[i] = 32; cr[i] = 0; cg[i] = 0; cb[i] = 0;
                }
                continue;
            }
            const row = hist[h];
            const fade = depthFade(h, dmax, fmin);
            for (let x = 0; x < cols; x++) {
                const i = base + x;
                cp[i] = row.cp[x];
                cr[i] = row.r[x] * fade;
                cg[i] = row.g[x] * fade;
                cb[i] = row.b[x] * fade;
            }
        }
    }

    /**
     * Whether scrollback-into-depth is active for this terminal.
     * @returns {boolean}
     */
    get depthHistory() {
        return this._depthEnabled;
    }

    /**
     * Toggle scrollback-into-depth. Disabling clears the captured ring (off means
     * gone) and blanks the depth block on the next paint; it refills as the live
     * screen scrolls once re-enabled.
     * @param {boolean} enabled
     */
    setDepthHistory(enabled) {
        this._depthEnabled = !!enabled;
        if (!this._depthEnabled) this._history = [];
        this._paintHistory();
        this._writeToInstanceBuffer();
    }

    /**
     * Change how many depth-history lines this terminal keeps and renders, reallocating
     * the instance budget (cols × (rows + max)). The captured ring is PRESERVED (trimmed
     * if shrinking); the live region is restored from the last snapshot so it doesn't
     * flash blank. Lets you crank a deeper "wall of history" than the construction
     * default (1000 lines is still a single instanced draw call).
     * @param {number} max
     */
    setDepthMax(max) {
        max = Math.max(0, Math.floor(max) || 0);
        if (max === this._depthMax) return;
        this._depthMax = max;
        this._depthCount = this.cols * max;
        this._totalCount = this._cellCount + this._depthCount;

        const total = this._totalCount;
        this._codepoints = new Float32Array(total).fill(32);
        this._cellR = new Float32Array(total).fill(0.8);
        this._cellG = new Float32Array(total).fill(0.8);
        this._cellB = new Float32Array(total).fill(0.8);
        this._positions = new Float32Array(total * 3);
        this._sizes = new Float32Array(total * 2);
        this._groupIds = new Float32Array(total).fill(this._groupId);

        if (this._history.length > max) this._history.length = max;

        this._computePositions();
        this._computeSizes();

        // Restore the live region from the last snapshot (the terminal may be idle for
        // a frame after this) so we don't flash a blank screen.
        if (this._prevRows) {
            const cols = this.cols;
            const cp = this._codepoints, cr = this._cellR, cg = this._cellG, cb = this._cellB;
            for (let y = 0; y < this.rows && y < this._prevRows.length; y++) {
                const row = this._prevRows[y];
                const base = y * cols;
                for (let x = 0; x < cols; x++) {
                    cp[base + x] = row.cp[x]; cr[base + x] = row.r[x];
                    cg[base + x] = row.g[x]; cb[base + x] = row.b[x];
                }
            }
        }

        this._applyToRenderer();   // grows the renderer's maxInstances + swaps in sized attrs
        this._paintHistory();
        this._writeToInstanceBuffer();

        if (this._pickingSystem) {
            this._pickingSystem.register('glyph', this._renderer, this._renderer);
        }
    }

    /**
     * Tune the depth-history ramp live: per-line rise (+Y) and recession (−Z), each a
     * multiple of lineSpacing. yFactor=0 → flat straight-back stack; yFactor=1 → each
     * older line one row higher (reads like climbing scrollback). Recomputes slot
     * positions and re-pushes them (no reload). Pass null for either to leave it.
     * @param {number|null} yFactor  rise per line ×lineSpacing
     * @param {number|null} zFactor  recession per line ×lineSpacing
     */
    setDepthShape(yFactor, zFactor) {
        if (Number.isFinite(yFactor)) {
            this._depthYFactor = yFactor;
            this._depthYStep = this._metrics.lineSpacing * yFactor;
        }
        if (Number.isFinite(zFactor)) {
            this._depthZFactor = zFactor;
            this._depthZStep = this._metrics.lineSpacing * zFactor;
        }
        this._computePositions();
        this._applyToRenderer();   // re-push positions (the GPU attr is a copy of _positions)
        this._paintHistory();
        this._writeToInstanceBuffer();
        if (this._pickingSystem) {
            this._pickingSystem.register('glyph', this._renderer, this._renderer);
        }
    }

    /**
     * Seed the depth-history ring from EXTERNAL scrollback (e.g. tmux capture-pane),
     * NEWEST-FIRST. Forward-capture (the frame diff) only sees lines that scroll off
     * from now on; this back-fills the history that already exists — so the session's
     * accumulated scrollback shows receding in depth immediately, and a re-seed after
     * a reload restores it (tmux is the durable source; the ring is in-memory).
     *
     * Each string becomes one history row (one codepoint per column, padded/truncated
     * to cols) at the default foreground color; normal depth fade + placement apply.
     * Glyphs not yet in the live atlas are encoded first. Lines past _depthMax are
     * dropped (only that many slots render). Replaces the current ring; later
     * forward-captures unshift in front of the seed seamlessly.
     * @param {string[]} lines  scrollback rows, newest first
     */
    seedHistory(lines) {
        if (this._depthMax === 0) return;
        const cols = this.cols;
        const n = Math.min(lines.length, this._depthMax);
        const ring = new Array(n);
        const live = this.atlas && this.atlas._live;
        const seen = this._liveEnsured;
        let fresh = null;

        for (let i = 0; i < n; i++) {
            const s = lines[i] || '';
            const cp = new Float32Array(cols).fill(32);
            const r = new Float32Array(cols).fill(0.8);
            const g = new Float32Array(cols).fill(0.8);
            const b = new Float32Array(cols).fill(0.8);
            let x = 0;
            for (const ch of s) {            // iterate by code point (surrogate-safe)
                if (x >= cols) break;
                const code = ch.codePointAt(0);
                cp[x] = code;
                if (live && this._shapeCache && code > 32 && !seen.has(code)) {
                    seen.add(code);
                    (fresh ?? (fresh = [])).push(code);
                }
                x++;
            }
            ring[i] = { cp, r, g, b };
        }
        if (fresh && live) live.ensureCodepoints(fresh, this._shapeCache);

        this._history = ring;
        this._paintHistory();
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
        // Byte-output tap: a 2D companion view (DOM xterm) consumes the SAME PTY stream the
        // 3D emulator renders — one source, two projections. Fires with the raw payload.
        if (this._byteListeners) {
            for (const cb of this._byteListeners) { try { cb(payload); } catch (e) { /* ignore tap errors */ } }
        }
    }

    /**
     * Subscribe to the raw PTY byte stream this terminal renders — lets a 2D xterm mirror the
     * live output. Returns an unsubscribe fn. @param {(payload:Uint8Array)=>void} cb
     */
    onBytes(cb) {
        if (!this._byteListeners) this._byteListeners = new Set();
        this._byteListeners.add(cb);
        return () => { this._byteListeners?.delete(cb); };
    }

    /**
     * Subscribe to size changes (cols/rows). A 2D companion xterm follows these so its VT
     * interpretation stays matched to the PTY — the 3D grid OWNS the size, the 2D view tracks
     * it. Fires after resize() with the new (cols, rows). Returns an unsubscribe fn.
     * @param {(cols:number, rows:number)=>void} cb
     */
    onResize(cb) {
        if (!this._resizeListeners) this._resizeListeners = new Set();
        this._resizeListeners.add(cb);
        return () => { this._resizeListeners?.delete(cb); };
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
        this._visible = visible;
        this._applyGlyphAlpha();
    }

    /**
     * Push the effective glyph alpha to the group: the panel opacity when visible,
     * 0 when hidden. Visibility and the panel-matched fade share one DataTexture
     * slot (gColor.a → vGroupAlpha), so they're folded here rather than fighting.
     * @private
     */
    _applyGlyphAlpha() {
        this._renderer?.setGroupAlpha(this._groupId, this._visible ? this._bgOpacity : 0);
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
    /**
     * The padded cell panel in the terminal's OWN local frame (no world transform).
     * The orientation-stable box: composed with matrixWorld it rides every rotation,
     * where the world-space AABB (getBounds) morphs as the panel rotates relative to
     * world (e.g. docked under the camera). Rebuilt only on resize. Mirrors CodeGrid.
     * @returns {THREE.Box3}
     */
    getLocalBounds() {
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
        return this._localBounds;
    }

    getBounds() {
        this.updateWorldMatrix(true, false);
        if (!this._worldBounds) this._worldBounds = new THREE.Box3();
        this._worldBounds.copy(this.getLocalBounds()).applyMatrix4(this.matrixWorld);
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
     * Wire a PickingSystem. Registers three channels (mirrors CodeGrid + the grip):
     *   - 'glyph'  (token = renderer) — per-cell picks; resize() re-registers it.
     *   - 'grid'   (token = this terminal) — the whole-panel background pickable.
     *   - 'handle' (token = { grid, edge }) — the SE resize grip; resize()
     *     re-registers it (it moves with the panel).
     * @param {import('../picking/PickingSystem.js').PickingSystem} pickingSystem
     */
    setPickingSystem(pickingSystem) {
        this._pickingSystem = pickingSystem;
        if (!pickingSystem) return;
        if (this._renderer)   pickingSystem.register('glyph', this._renderer, this._renderer);
        if (this._background) pickingSystem.register('grid', this._background, this);
        if (this._handle)     pickingSystem.register('handle', this._handle, { grid: this, edge: 'se' });
    }

    /**
     * Resize the terminal. Rebuilds parallel arrays and positions.
     * After resize, the next write() / applyScreen() provides the new content.
     *
     * @param {number} cols
     * @param {number} rows
     */
    resize(cols, rows) {
        this.cols = cols;
        this.rows = rows;
        this._cellCount  = cols * rows;
        this._depthCount = cols * this._depthMax;
        this._totalCount = this._cellCount + this._depthCount;
        this._localBoundsDirty = true;

        // Captured history is keyed to the old column width — drop it on resize
        // rather than render torn rows; it refills as the new screen scrolls.
        this._history = [];
        this._prevRows = null;

        const total = this._totalCount;
        // Grow typed arrays if the new budget exceeds current capacity.
        if (total > this._codepoints.length) {
            this._codepoints = new Float32Array(total).fill(32);
            this._cellR      = new Float32Array(total).fill(0.8);
            this._cellG      = new Float32Array(total).fill(0.8);
            this._cellB      = new Float32Array(total).fill(0.8);
            this._positions  = new Float32Array(total * 3);
            this._sizes      = new Float32Array(total * 2);
            this._groupIds   = new Float32Array(total).fill(this._groupId);
        } else {
            // Reuse existing buffers; zero them out to avoid stale cell data.
            this._codepoints.fill(32, 0, total);
            this._cellR.fill(0.8, 0, total);
            this._cellG.fill(0.8, 0, total);
            this._cellB.fill(0.8, 0, total);
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

        // Move the grip to the new SE corner + re-register (its world extent moved
        // with the panel; the 'handle' channel id-block is keyed per mesh).
        this._positionHandle();
        if (this._pickingSystem && this._handle) {
            this._pickingSystem.register('handle', this._handle, { grid: this, edge: 'se' });
        }

        // Keep the byte→screen emulator in lockstep — its next screen reflects the
        // new dimensions. (Pairs with the adapter's pty.Setsize for full agreement.)
        this._emulator?.resize(cols, rows);

        // Size-change tap: a 2D companion xterm follows so it re-interprets the shared byte
        // stream at the new dimensions (one source, two projections — see onBytes).
        if (this._resizeListeners) {
            for (const cb of this._resizeListeners) { try { cb(cols, rows); } catch (e) { /* ignore tap errors */ } }
        }
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
            if (this._handle)     this._pickingSystem.unregister('handle', this._handle);
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
        if (this._handle) {
            this._handle.geometry.dispose();
            this._handle.material.dispose();
            this._handle = null;
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

        // Depth-history slots: each older line RISES above the live top row (+Y) and
        // recedes (−Z) — an up-and-back ramp. Slot h is fixed; history CONTENT shifts
        // through slots, so these positions never change between frames (only on resize
        // or a depth-shape change). _depthYStep=0 → a flat straight-back stack.
        const base0 = this._cellCount;
        const yStep = this._depthYStep;
        const zStep = this._depthZStep;
        for (let h = 0; h < this._depthMax; h++) {
            const y = (h + 1) * yStep;
            const z = -(h + 1) * zStep;
            for (let col = 0; col < this.cols; col++) {
                const idx = (base0 + h * this.cols + col) * 3;
                this._positions[idx]     = col * strideX;
                this._positions[idx + 1] = y;
                this._positions[idx + 2] = z;
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
        for (let i = 0; i < this._totalCount; i++) {
            this._sizes[i * 2]     = w;
            this._sizes[i * 2 + 1] = h;
        }
    }

    /**
     * World-unit cell stride (one column right, one row down), gridScale included.
     * The resize dragger maps Δworld → Δcols/Δrows through this.
     * @returns {{ x: number, y: number }}
     */
    get cellStride() {
        const m = this._metrics;
        return {
            x: (m.charWidth + m.letterSpacing) * this._gridScale,
            y: m.lineSpacing * this._gridScale,
        };
    }

    /**
     * Create the SE-corner resize grip: a small visible quad that is both the user's
     * grab affordance AND the 'handle' pick target. A child of this Object3D, so it
     * inherits gridScale + world position; placed by _positionHandle().
     * @private
     */
    _initHandle() {
        const m = this._metrics;
        const w = (m.charWidth + m.letterSpacing) * 2; // ~2 cells — comfortably grabbable
        const h = m.lineSpacing * 2;
        const geo = new THREE.PlaneGeometry(w, h);
        const mat = new THREE.MeshBasicMaterial({
            color: 0x6ee7a0, transparent: true, opacity: 0.5, depthTest: false,
        });
        this._handle = new THREE.Mesh(geo, mat);
        this._handle.renderOrder = 10001; // above the selection / hover outlines
        this.add(this._handle);
        this._positionHandle();
    }

    /**
     * Place the grip at the panel's bottom-right (SE) corner in local coords — same
     * extent math as getBounds(). Called on construction and after resize.
     * @private
     */
    _positionHandle() {
        if (!this._handle) return;
        const m = this._metrics;
        const strideX = m.charWidth + m.letterSpacing;
        const strideY = m.lineSpacing;
        const pad = this._bgPadding;
        const width  = this.cols * strideX + pad * 2;
        const height = this.rows * strideY + pad * 2;
        const cx = (this.cols * strideX) / 2 - m.charWidth / 2;
        const cy = -(this.rows * strideY) / 2 + strideY / 2;
        this._handle.position.set(cx + width / 2, cy - height / 2, 0.5);
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
        const count = this._totalCount;
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
        const count    = this._totalCount;   // live cells + depth-history block

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
        const count = this._totalCount;
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
        const count = this._totalCount;
        const arr = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            arr[i] = this._glyphId(this._codepoints[i]);
        }
        return arr;
    }

    /**
     * Ensure every glyph the incoming ScreenBuffer needs has its Slug curves
     * encoded in the live atlas before we write slots into the GPU buffer.
     *
     * Each new codepoint is routed through the font chain and encoded on first
     * sighting; the live atlas re-encodes + hot-swaps the curve/glyph-map
     * textures into every field (including this terminal's) synchronously, so by
     * the time _writeToInstanceBuffer() writes the slot the glyph is renderable.
     *
     * A per-terminal "seen" set keeps this O(new glyphs), not O(cols×rows), per
     * screen update — after warm-up almost every cell is already seen.
     *
     * @private
     * @param {{ rows:number, cols:number, cells: Array<Array<{codepoint:number}>> }} screen
     */
    _ensureAtlasCodepoints(screen) {
        const live = this.atlas && this.atlas._live;
        if (!live || !this._shapeCache) return; // degraded boot: nothing to encode

        const seen = this._liveEnsured;
        let fresh = null;

        for (let row = 0; row < screen.rows; row++) {
            const screenRow = screen.cells[row];
            if (!screenRow) continue;
            for (let col = 0; col < screen.cols; col++) {
                const cell = screenRow[col];
                if (!cell) continue;
                const code = cell.codepoint ?? 32;
                if (code > 32 && !seen.has(code)) {
                    seen.add(code);
                    (fresh ?? (fresh = [])).push(code);
                }
            }
        }
        // ensureCodepoints dedups globally (its encoded set), so codepoints another
        // grid already encoded are a cheap no-op here.
        if (fresh) live.ensureCodepoints(fresh, this._shapeCache);
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
            // depthWrite: the panel must OCCLUDE content behind it (the floor, and
            // tiles stacked behind it in a dock) — without it, later-drawn geometry
            // composites straight through regardless of alpha and the terminal reads
            // as see-through. `transparent` only when opacity<1, so the slider works
            // but a full-opacity panel is genuinely solid.
            transparent: this._bgOpacity < 1,
            opacity: this._bgOpacity,
            side: THREE.DoubleSide,
            depthWrite: true,
        });

        this._background = new THREE.Mesh(geometry, material);
        this._background.renderOrder = RENDER_ORDER.GRID_BACKGROUND;
        // Tagged so gesture dispatch can resolve background → terminal id
        // without a reverse-lookup through the registry.
        this._background.userData.entityType = 'terminal';
        this.add(this._background);
        this._updateBackground();
    }

    /**
     * Live-restyle the background panel — color (hex int or '#rrggbb' string)
     * and/or opacity (0–1). Drives the configurable color scheme; readability of
     * stacked tiles in a dock comes down to this opacity. Either field optional.
     * @param {{ color?: number|string, opacity?: number }} style
     */
    setBackgroundStyle({ color, opacity } = {}) {
        if (color != null) this._bgColor = color;
        if (opacity != null) this._bgOpacity = opacity;
        const m = this._background?.material;
        if (!m) return;
        if (color != null) m.color.set(color);
        if (opacity != null) { m.opacity = opacity; m.transparent = opacity < 1; this._applyGlyphAlpha(); }
        m.needsUpdate = true;
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

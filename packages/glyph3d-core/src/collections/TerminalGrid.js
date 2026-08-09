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
import { detectVerticalScroll, captureScrolledRows, depthFade, reflowHistoryRows } from './terminalDepthHistory.js';
import { RENDER_ORDER } from '../core/renderOrder.js';
import { LAYER_BAND, getBandDistance } from '../core/layerBands.js';
import MonospaceShapeCache from '../shaping/MonospaceShapeCache.js';
import FramedGlyphField from './FramedGlyphField.js';
import Button3D from '../components/Button3D.js';
import { createPanelMaterial } from './panelMaterial.js';
import { createCursorMaterial } from './cursorMaterial.js';

const _cellStrideScale = new THREE.Vector3(); // scratch for cellStride's world-scale read

/**
 * Terminal cursor defaults — the block that marks where typing lands. Born configurable
 * (Settings ▸ Theme + the constructor's `cursor*` options + setCursorStyle) rather than baked,
 * so the look is tunable live. `color` defaults to the focus-green of the interaction-state
 * vocabulary; `fillOpacity` is the translucent solid-block alpha when the terminal holds the
 * keyboard; `borderWidth` is the hollow-outline thickness (screen px) when it doesn't. Shared as
 * the SINGLE source of truth so the settings schema and the constructor never drift.
 */
export const TERMINAL_CURSOR_DEFAULTS = Object.freeze({
    color: '#6ee7a0',
    fillOpacity: 0.5,
    borderWidth: 1.5,
});

// Cursor block render order: above glyphs (0), below the window chrome (GRID_CHROME = 6) — the
// same band CodeGrid's caret uses. A compositing constant, not a taste knob, so it stays baked.
const CURSOR_RENDER_ORDER = 5;

export default class TerminalGrid extends FramedGlyphField {
    /**
     * @param {THREE.Scene} scene
     * @param {import('../GlyphAtlas.js').default} atlas
     * @param {Object} [options]
     * @param {number} [options.cols=80]        Terminal width in columns
     * @param {number} [options.rows=24]        Terminal height in rows
     * @param {number} [options.worldScale=0.025] World units per atlas pixel
     * @param {{x:number,y:number,z:number}} [options.position]  Initial world position
     * @param {string} [options.title='TerminalGrid']  Debug name
     * @param {number|string} [options.cursorColor]  Cursor block color (default TERMINAL_CURSOR_DEFAULTS.color)
     * @param {number} [options.cursorFillOpacity]   Solid-block alpha when focused (default ….fillOpacity)
     * @param {number} [options.cursorBorderWidth]   Hollow-outline thickness, screen px (default ….borderWidth)
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

        // ---- Scrollback-into-depth (page-quantized) ----
        // Lines that scroll off the top of the live screen are kept as a client-side
        // ring and rendered as a receipt of PAGES: history is grouped into screenfuls
        // (`rows` lines each), and each page is a flat, coplanar block at the live
        // screen's Y, stepped straight back in −Z. The newest page sits just behind the
        // live screen; older pages are pushed further back (reverse-from-last). A burst
        // like `git log` that fills a screenful lands as ONE readable page that recedes
        // as a block — lines within a page never smear across depth. Pages may also
        // optionally rise (_depthYFactor>0); 0 keeps them a clean straight-back deck.
        // (tmux owns true scrollback + repaints the visible pane only, so there is no
        // free "line scrolled off" event — we recover it by diffing frames; see
        // terminalDepthHistory.detectVerticalScroll.) Full-screen TUIs (alt-screen)
        // are excluded.
        this._depthEnabled = options.depthHistory ?? true;
        this._depthMax     = Math.max(0, options.depthMax ?? 80);   // history lines rendered
        this._depthFadeMin = options.depthFadeMin ?? 0.4;           // oldest page's brightness
        this._depthYFactor = options.depthYStep ?? 0;               // ×lineSpacing rise per PAGE
        this._depthZFactor = options.depthZStep ?? 6;               // ×lineSpacing recede per PAGE
        this._history  = [];      // captured rows, index 0 = newest scrolled-off
        this._prevRows = null;    // last live-screen snapshot, for scroll detection
        this._altActive = false;  // current frame is an alt-screen (TUI) repaint
        this._depthYStep = 0;     // world rise per page (set once metrics exist)
        this._depthZStep = 0;     // world recede per page (set once metrics exist)

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
        // Per-PAGE rise (+Y) and recession (−Z). Depth scales with the terminal via
        // this.scale, like X/Y, since positions are local.
        this._depthYStep = this._metrics.lineSpacing * this._depthYFactor;
        this._depthZStep = this._metrics.lineSpacing * this._depthZFactor;

        // Local-bounds cache (for picking + camera framing). The local box depends
        // only on cols/rows/metrics (dirtied on resize); the WORLD box is owned by
        // BoundedObject3D.getBounds(), which re-derives it per call by applying
        // the current world matrix to this cached local box (no world cache here).
        this._localBounds = null;
        this._localBoundsDirty = true;


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
        // Per-cell ANSI BACKGROUND (live region only — [0, _cellCount)). RGB + a per-cell opacity
        // (0 = no fill → the terminal's bg plane shows). Projected into the fill carrier (the
        // highlight texture) each frame by _writeToInstanceBuffer. History keeps no bg for now.
        this._cellBgR    = new Float32Array(this._cellCount);
        this._cellBgG    = new Float32Array(this._cellCount);
        this._cellBgB    = new Float32Array(this._cellCount);
        this._cellBgA    = new Float32Array(this._cellCount);   // 0 = no fill; else _bgFillOpacity

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

        // Push the initial empty buffer to the renderer. After this call the non-position
        // geometry attributes wrap our typed arrays (zero-copy in-place updates); positions
        // are the exception — applyPrebuiltBuffers pads them into its own stride-4 array.
        this._applyToRenderer();

        // Background plane — dark panel behind the terminal for readability. The _panel/
        // _background slots are declared by FramedGlyphField; _initBackground builds them.
        this._bgColor = options.backgroundColor ?? 0x0a0a1e;
        this._bgOpacity = options.backgroundOpacity ?? 0.96;
        this._bgPadding = options.backgroundPadding ?? 0.3;
        // Per-cell ANSI background fill opacity (git-diff bars, ls --color, selections). Solid by
        // default — a colored cell reads as an opaque block like a real terminal; tunable live.
        this._bgFillOpacity = options.cellBgFillOpacity ?? 1.0;
        this._visible = true; // setVisible state — folded with the fade (shared alpha slot)
        this._initBackground();
        // Fade glyphs to match the panel from the start, so a translucent tile reads
        // as one coherent sheet (text + bg together), not opaque text over glass.
        this._applyGlyphAlpha();

        // Window chrome: a bottom-edge row of controls — the drag grips (green RESIZES
        // cols/rows → PTY, red SCALES the Object3D zoom) PLUS click buttons (pin, and the
        // size/scale ± dials). All are visible affordances AND 'handle' pick targets on
        // one channel, distinguished by token.role. Generalized into a single control
        // list (CONTROL_SPEC) and DEPTH-TESTED so they occlude like the panel.
        this._controls = [];       // [{ spec, mesh }] — see CONTROL_SPEC
        this._initControls();

        // Cursor block — marks the live cell where typing lands (xterm's cursorX/cursorY, surfaced
        // by the emulator into the screen buffer). Drawn SOLID (translucent block, glyph reads
        // through) when this terminal holds the keyboard, HOLLOW (outline) otherwise — so every
        // terminal shows its prompt spot and the focused one reads as "type here". Style is born
        // configurable (see TERMINAL_CURSOR_DEFAULTS); focus state rides setCursorFocused.
        this._cursorColor       = options.cursorColor       ?? TERMINAL_CURSOR_DEFAULTS.color;
        this._cursorFillOpacity = options.cursorFillOpacity ?? TERMINAL_CURSOR_DEFAULTS.fillOpacity;
        this._cursorBorderWidth = options.cursorBorderWidth ?? TERMINAL_CURSOR_DEFAULTS.borderWidth;
        this._cursor         = { x: 0, y: 0 };  // live cursor cell (viewport-relative)
        this._cursorVisible  = true;            // emulator-driven draw gate (always on for now)
        this._cursorFocused  = false;           // keyboard-target → solid; else hollow
        this._cursorCaptured = false;           // greedy capture settled → solid + ring (wins over focused)
        this._cursorMesh     = null;
        this._cursorCtl      = null;
        this._initCursorMesh();

        // Add the renderer's mesh as a child so transforms propagate.
        this.add(this._renderer.instanceMesh);

        // ScaleModel is the single authority for this.scale: placement (gridScale at
        // home, the dock's tile-fit when docked) · user (persisted zoom). resolve()
        // is the only writer; setScale/setZoom/the dock feed it, never this.scale.
        this._initScale(this._gridScale);

        // Add this Object3D to the scene.
        scene.add(this);

        // Apply initial world position if provided.
        if (options.position) {
            const p = options.position;
            this.position.set(p.x, p.y, p.z);
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
        const bgR = this._cellBgR, bgG = this._cellBgG, bgB = this._cellBgB, bgA = this._cellBgA;
        const bgFill = this._bgFillOpacity;

        for (let row = 0; row < rows; row++) {
            const screenRow = screen.cells[row];
            if (!screenRow) {
                // Row not present in buffer: fill with spaces at default color, no bg fill
                for (let col = 0; col < cols; col++) {
                    const idx = row * cols + col;
                    cp[idx] = 32;
                    cr[idx] = 0.8; cg[idx] = 0.8; cb[idx] = 0.8;
                    bgA[idx] = 0;
                }
                continue;
            }

            for (let col = 0; col < cols; col++) {
                const idx = row * cols + col;
                const cell = screenRow[col];

                if (!cell) {
                    cp[idx] = 32;
                    cr[idx] = 0.8; cg[idx] = 0.8; cb[idx] = 0.8;
                    bgA[idx] = 0;
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

                // Per-cell ANSI background: explicit bg → a fill at _bgFillOpacity; default bg
                // (null) → no fill (alpha 0), so the terminal's bg plane shows through.
                const bg = cell.bg;
                if (bg) { bgR[idx] = bg.r; bgG[idx] = bg.g; bgB[idx] = bg.b; bgA[idx] = bgFill; }
                else { bgA[idx] = 0; }
            }
        }

        // Snapshot the freshly-written live screen for next frame's scroll diff, then
        // paint the depth-history block from the ring. (Snapshot rows are fresh arrays
        // each frame, so aliasing one into _history is safe — it is never mutated.)
        this._snapshotLive();
        this._paintHistory();

        // Project canonical arrays (live + history) → GPU attribute arrays.
        this._writeToInstanceBuffer();

        // Move the cursor block to the cell the emulator reports. (Sources without a cursor —
        // future file-slice / graphics surfaces — simply leave it where it was.)
        if (screen.cursor) {
            this._cursor.x = screen.cursor.x;
            this._cursor.y = screen.cursor.y;
            this._updateCursorMesh();
        }
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
        // Fade by PAGE (not per line) so each page is uniformly lit + readable, with
        // older pages dimmer — matches the page-quantized layout.
        const pageCount = Math.max(1, Math.ceil(dmax / this.rows));

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
            const fade = depthFade(Math.floor(h / this.rows), pageCount, fmin);
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
     * Tune the depth-history layout live: per-PAGE rise (+Y) and recession (−Z), each a
     * multiple of lineSpacing. yFactor=0 → a flat straight-back deck of pages; yFactor>0
     * → pages also climb. zFactor sets how far each page steps back. Recomputes slot
     * positions and re-pushes them (no reload). Pass null for either to leave it.
     * @param {number|null} yFactor  rise per page ×lineSpacing
     * @param {number|null} zFactor  recession per page ×lineSpacing
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
     * The terminal's visible screen as plain text lines — read from the
     * headless emulator's buffer, the same source the glyphs render from.
     * @returns {string[]}
     */
    readText() {
        return this._emulator ? this._emulator.readText() : [];
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

    // onResize(cb) — subscribe to size-change taps (fires after resize with the new cols/rows; a
    // 2D companion xterm follows the PTY-owned size) — is inherited from FramedGlyphField.

    /**
     * Apply a saved view record to this terminal's LOCAL geometry — position + cols/rows — directly.
     * This is the load-path counterpart to the terminal.move / terminal.resize verbs: those verbs
     * AND the session projection both drive this one method, so a reload is `applyView(record)`, not
     * a replay of the verbs that produced it. Each field is guarded (a no-op view is a no-op), and
     * `skipPosition` lets a docked tile keep its dock-owned transform.
     *
     * It deliberately touches only what this grid OWNS (grid buffers + emulator, via resize/
     * this.position). The relay-backed PTY is an external child this grid has no handle to —
     * applyView reports `resized` so the caller that DOES hold the bridge can match it (SIGWINCH →
     * tmux), exactly as terminal.resize does.
     *
     * @param {{position?:{x:number,y:number,z:number}, cols?:number, rows?:number}} view
     * @param {{skipPosition?:boolean}} [opts]
     * @returns {{moved:boolean, resized:{cols:number,rows:number}|null}}
     */
    applyView(view, { skipPosition = false } = {}) {
        const v = view || {};
        let moved = false;
        let resized = null;
        const p = v.position;
        if (!skipPosition && p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
            && (this.position.x !== p.x || this.position.y !== p.y || this.position.z !== p.z)) {
            this.position.set(p.x, p.y, p.z);
            moved = true;
        }
        if (Number.isInteger(v.cols) && Number.isInteger(v.rows) && v.cols > 0 && v.rows > 0
            && (this.cols !== v.cols || this.rows !== v.rows)) {
            this.resize(v.cols, v.rows);
            resized = { cols: v.cols, rows: v.rows };
        }
        return { moved, resized };
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
        this._updateCursorMesh();   // the cursor mesh isn't in the glyph group; hide/show it explicitly
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

    // ================================================================
    // Cursor block — "where typing lands"
    // ================================================================

    /**
     * Mark this terminal as the keyboard target (solid block) or not (hollow outline). Driven by
     * the shell's attention loop: the input-active terminal goes solid, the rest stay hollow. Cheap
     * (one uniform flip), so calling it every frame is fine.
     * @param {boolean} focused
     */
    setCursorFocused(focused) {
        this._cursorFocused = !!focused;
        this._applyCursorState();
    }

    /**
     * Mark this terminal as CAPTURED (greedy keyboard) — the cursor goes to its block-plus-ring look,
     * winning over plain focus. Driven by the same attention loop, off the capture flag.
     * @param {boolean} captured
     */
    setCursorCaptured(captured) {
        this._cursorCaptured = !!captured;
        this._applyCursorState();
    }

    /** Pick the cursor look from the focus/capture flags: captured ▸ solid ▸ hollow. @private */
    _applyCursorState() {
        const state = this._cursorCaptured ? 'captured' : this._cursorFocused ? 'solid' : 'hollow';
        this._cursorCtl?.setState(state);
    }

    /** Show/hide the cursor block without forgetting its cell (e.g. a future DECTCEM hide). */
    setCursorVisible(visible) {
        this._cursorVisible = !!visible;
        this._updateCursorMesh();
    }

    /**
     * Live restyle the cursor block — color, solid-fill alpha, hollow-outline width. Mirrors
     * setBackgroundStyle; the Settings ▸ Theme cursor knobs push through here for every terminal.
     * @param {{ color?: number|string, fillOpacity?: number, borderWidth?: number }} style
     */
    setCursorStyle({ color, fillOpacity, borderWidth } = {}) {
        if (color != null) this._cursorColor = color;
        if (fillOpacity != null) this._cursorFillOpacity = fillOpacity;
        if (borderWidth != null) this._cursorBorderWidth = borderWidth;
        this._cursorCtl?.setStyle({ color, fillOpacity, borderWidth });
    }

    /**
     * Lazy-build the cursor block: a unit plane scaled per cell, its material flipping between a
     * translucent solid (focused) and a hollow outline (unfocused). A child of this Object3D, so it
     * rides the terminal's world position/scale exactly like the glyph cells. @private
     */
    _initCursorMesh() {
        if (this._cursorMesh) return;
        this._cursorCtl = createCursorMaterial({
            color: this._cursorColor,
            fillOpacity: this._cursorFillOpacity,
            borderWidth: this._cursorBorderWidth,
        });
        this._applyCursorState();
        this._cursorMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this._cursorCtl.material);
        this._cursorMesh.renderOrder = CURSOR_RENDER_ORDER;
        this._cursorMesh.frustumCulled = false;   // grid-local; the parent culls
        this.add(this._cursorMesh);
        this._updateCursorMesh();
    }

    /**
     * Park the cursor block on its live cell. Same cell math as _computePositions (glyph anchor =
     * col*strideX, −row*strideY) shifted to the cell CENTER and sized to the full advance cell, so
     * the block tiles the cell like a real terminal cursor. Hidden when the terminal is hidden or the
     * cursor falls outside the live screen. @private
     */
    _updateCursorMesh() {
        if (!this._cursorMesh) return;
        const { x, y } = this._cursor;
        if (!this._visible || !this._cursorVisible || x < 0 || x >= this.cols || y < 0 || y >= this.rows) {
            this._cursorMesh.visible = false;
            return;
        }
        const m = this._metrics;
        const strideX = m.charWidth + m.letterSpacing;
        const strideY = m.lineSpacing;
        this._cursorMesh.scale.set(strideX, strideY, 1);
        // Cell left edge sits at col*strideX (the glyph anchor); +½ stride centers the block. y is
        // the glyph's vertical center (rows step by strideY). +0.05 z keeps it just in front of the
        // glyph so it never z-fights — same offset as CodeGrid's caret.
        this._cursorMesh.position.set(x * strideX + strideX / 2, -y * strideY, 0.05);
        this._cursorMesh.visible = true;
    }

    /**
     * Set the PLACEMENT scale (the window's natural home size). This is the context
     * scale the dock overrides while docked; setting it here updates the home size.
     * Composes through ScaleModel so any active zoom is preserved.
     * @param {number} factor
     */
    setScale(factor) {
        this._gridScale = factor;              // mirror the home scale, then base drives this.scale
        super.setScale(factor);
    }

    // setZoom(factor) + get zoom — the readability-zoom API — are inherited from FramedGlyphField.

    /**
     * The padded cell panel in the terminal's OWN local frame (no world transform) —
     * the {@link BoundedObject3D} contract hook. The orientation-stable box: composed
     * with matrixWorld (by the inherited getBounds) it rides every rotation, where the
     * world-space AABB morphs as the panel rotates relative to world (e.g. docked under
     * the camera). Cached; rebuilt only on resize (dirtied via _localBoundsDirty).
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

    // getBounds(target) — world-space AABB, recomputed on demand — is inherited from
    // BoundedObject3D (getLocalBounds() applied by the current matrixWorld).

    /**
     * Wire a PickingSystem. The base (FramedGlyphField) registers the 'glyph' (renderer) and
     * 'grid' (background) channels; TerminalGrid adds a third — 'handle', the SE resize grip,
     * which resize() also re-registers since it moves with the panel.
     * @param {import('../picking/PickingSystem.js').PickingSystem} pickingSystem
     */
    setPickingSystem(pickingSystem) {
        super.setPickingSystem(pickingSystem);
        if (pickingSystem) this._registerControls();
    }

    /**
     * Resize the terminal. Rebuilds parallel arrays and positions.
     * After resize, the next write() / applyScreen() provides the new content.
     *
     * @param {number} cols
     * @param {number} rows
     */
    resize(cols, rows) {
        const oldCols = this.cols;
        // Snapshot the live screen BEFORE we mutate dims/buffers, to restore it below so
        // the panel doesn't flash blank between this resize and the emulator's next
        // repaint — matters most under a live grip-drag firing resize every cell step.
        const prevLive = this._prevRows;

        this.cols = cols;
        this.rows = rows;
        this._cellCount  = cols * rows;
        this._depthCount = cols * this._depthMax;
        this._totalCount = this._cellCount + this._depthCount;
        this._localBoundsDirty = true;

        // Captured depth-history SURVIVES a resize (a live grip-drag must not wipe the
        // scrollback wall every step). Rows are kept as-is when only the height changes;
        // when cols change each row is reflowed — clipped if narrower, blank-padded if
        // wider — so every row stays exactly `cols` wide (the _paintHistory invariant).
        // tmux holds the durable scrollback; terminal.depth.seed re-fills clipped columns.
        if (cols !== oldCols && this._history.length) {
            this._history = reflowHistoryRows(this._history, cols);
        }
        // _prevRows is scroll-detection state tied to the OLD dimensions — drop it so the
        // next frame re-snapshots rather than diffing a phantom scroll across the resize.
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

        // Per-cell bg tracks the LIVE region (_cellCount), which changed; resize dropped _prevRows
        // and bg isn't in the snapshot, so just size + clear (the next emulator frame repaints it).
        if (this._cellBgA.length !== this._cellCount) {
            this._cellBgR = new Float32Array(this._cellCount);
            this._cellBgG = new Float32Array(this._cellCount);
            this._cellBgB = new Float32Array(this._cellCount);
            this._cellBgA = new Float32Array(this._cellCount);
        } else {
            this._cellBgA.fill(0);
        }

        this._computePositions();
        this._computeSizes();

        // Restore the live screen region from the pre-resize snapshot (clipped to the
        // new width/height) so the panel doesn't flash blank before the emulator's next
        // repaint. The buffers above were zeroed/grown, so this writes over blanks.
        if (prevLive) {
            const cp = this._codepoints, cr = this._cellR, cg = this._cellG, cb = this._cellB;
            const yN = Math.min(rows, prevLive.length);
            for (let y = 0; y < yN; y++) {
                const row = prevLive[y];
                const xN = Math.min(cols, row.cp.length);
                const base = y * cols;
                for (let x = 0; x < xN; x++) {
                    cp[base + x] = row.cp[x]; cr[base + x] = row.r[x];
                    cg[base + x] = row.g[x]; cb[base + x] = row.b[x];
                }
            }
        }
        // Paint the preserved depth ring into the (resized) history block so the
        // scrollback wall renders immediately rather than blanking until the next frame.
        this._paintHistory();

        // Full re-apply: swaps in freshly-sized attribute arrays (uploads the restored
        // live region + repainted history in one shot, since it reads the canonical arrays).
        this._applyToRenderer();
        this._updateBackground();

        // Instance count changed (cols*rows) → re-register the glyph channel so
        // the pick pass sees the new ID block and geometry. (The grid-channel
        // panel is stable; _updateBackground only rescaled it.)
        if (this._pickingSystem) {
            this._pickingSystem.register('glyph', this._renderer, this._renderer);
        }

        // Re-place the control row at the new SE corner + re-register (their world extent
        // moved with the panel; the 'handle' channel id-block is keyed per mesh).
        this._layoutControls();
        this._registerControls();

        // Keep the byte→screen emulator in lockstep — its next screen reflects the
        // new dimensions. (Pairs with the adapter's pty.Setsize for full agreement.)
        this._emulator?.resize(cols, rows);

        // Size-change tap: a 2D companion xterm follows so it re-interprets the shared byte
        // stream at the new dimensions (one source, two projections — see onBytes).
        this._emitResize(cols, rows);

        // Re-park the cursor: cols/rows changed, so its cell may now be off-screen (→ hidden) and
        // the cell math depends on the new dims. The next emulator frame will reposition it anyway,
        // but this keeps it correct in the gap before that repaint.
        this._updateCursorMesh();
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
            for (const c of this._controls) this._pickingSystem.unregister('handle', c.button);
        }
        if (this._renderer) {
            this._renderer.instanceMesh.geometry.dispose();
            this._renderer.instanceMesh.material.dispose();
            this._renderer = null;
        }
        if (this._cursorMesh) {
            this._cursorMesh.geometry.dispose();
            this._cursorMesh.material.dispose();
            this.remove(this._cursorMesh);
            this._cursorMesh = null;
            this._cursorCtl = null;
        }
        this._disposePanel();   // free + detach the background panel (FramedGlyphField) — now also
                                // removes it from this Object3D, which TG's inline teardown skipped
        for (const c of this._controls) c.button.dispose();
        this._controls = [];
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

        // Depth-history slots, PAGE-QUANTIZED: history is grouped into pages of `rows`
        // lines. Each page is a flat screenful at the live screen's Y, stepped straight
        // back by one page-depth in −Z (page 0 = newest screenful, just behind the live
        // screen; higher p = older, further back). Within a page the newest line sits
        // at the bottom row (mirroring how it looked live). Slot positions are fixed;
        // history CONTENT shifts through slots, so they only change on resize / reshape.
        const base0 = this._cellCount;
        const R = this.rows;
        const pageRise  = this._depthYStep;   // +Y per page (0 → flat straight-back deck)
        const pageDepth = this._depthZStep;   // −Z per page
        for (let h = 0; h < this._depthMax; h++) {
            const p = Math.floor(h / R);          // page index (0 = newest screenful)
            const i = h % R;                      // line within page (0 = newest line)
            const rowFromTop = (R - 1) - i;       // newest line → bottom row of the page
            const y = (p + 1) * pageRise - rowFromTop * strideY;
            const z = -(p + 1) * pageDepth;
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
     * World-unit cell stride (one column right, one row down) at the panel's LIVE world
     * scale. The resize dragger maps Δworld → Δcols/Δrows through this, so it must be the
     * on-screen cell size right now — NOT the construction-time _gridScale. When a tile is
     * docked the dock shrinks it via this.scale (the Object3D), leaving _gridScale stale;
     * reading the world scale (incl. any parent scaling) is what keeps the drag 1:1.
     * @returns {{ x: number, y: number }}
     */
    get cellStride() {
        const m = this._metrics;
        this.updateWorldMatrix(true, false);
        const s = this.getWorldScale(_cellStrideScale);
        return {
            x: (m.charWidth + m.letterSpacing) * s.x,
            y: m.lineSpacing * s.y,
        };
    }

    /**
     * Window chrome spec: a row of bottom-edge controls, laid out right→left from the SE
     * corner. Each becomes a labeled Button3D that is BOTH a visible affordance and a
     * 'handle'-channel pick target whose token carries `role` + the button. `grab:true` marks
     * the two DRAG grips (the ResizeDragger turns them into a live resize/scale drag); the rest
     * are CLICK buttons. A `popupOf` entry is a confirm popup for another control: it starts
     * HIDDEN (so it's inert — an invisible mesh isn't pick-rendered) and is placed ABOVE its
     * anchor; the shell toggles it visible on demand (setControlVisible). 'close' mirrors the
     * terminal-tab × (terminal.kill) and arms the red 'close-confirm' "Sure?" popup.
     * @private
     */
    static CONTROL_SPEC = [
        { role: 'resize',        label: 'Resize', color: 0x6ee7a0, grab: true  },                    // green grip: drag → cols/rows
        { role: 'scale',         label: 'Scale',  color: 0xf2787a, grab: true  },                    // red grip:   drag → zoom
        { role: 'capture',       label: 'Lock',   color: 0xff7a18, grab: false },                    // orange:     click → settle/unsettle keyboard capture
        { role: 'pin',           label: 'Pin',    color: 0xf2c14e, grab: false },                    // amber:      click → maximize toggle
        { role: 'drop',          label: 'Drop',   color: 0x8ab4f8, grab: false },                    // blue:       click → set down camera-front (window.drop)
        { role: 'close',         label: 'Close',  color: 0x8a93a0, grab: false },                    // slate:      click → arm the confirm
        { role: 'close-confirm', label: 'Sure?',  color: 0xe5534b, grab: false, popupOf: 'close' },  // alarm red:  click → terminal.kill
    ];

    /**
     * Build the chrome control row from CONTROL_SPEC: one labeled Button3D per control, sized
     * to ~1.5 cells tall (width derives from the label). The buttons own their hover/active
     * visuals and are DEPTH-TESTED (RENDER_ORDER.GRID_CHROME) so a closer window occludes them
     * rather than floating on top. `popupOf` controls start hidden. Children of this Object3D,
     * so they ride gridScale + world position; placed by _layoutControls(). @private
     */
    _initControls() {
        const m = this._metrics;
        const h = m.lineSpacing * 1.5;
        this._controls = TerminalGrid.CONTROL_SPEC.map((spec) => {
            const button = new Button3D({
                label: spec.label, height: h, color: spec.color, grab: spec.grab,
                opacity: spec.grab ? 0.66 : 0.6, role: spec.role,
            });
            if (spec.popupOf) button.visible = false; // a confirm popup — hidden (and inert) until armed
            this.add(button);
            return { spec, button };
        });
        this._layoutControls();
    }

    /**
     * Place the control row along the bottom edge, packing the pills right→left from the SE
     * corner (each by its own width + a gap). A `popupOf` control is placed ABOVE its anchor
     * instead of in the row. Same extent math as getBounds(); called on construction and after
     * every resize. @private
     */
    _layoutControls() {
        if (!this._controls?.length) return;
        const m = this._metrics;
        const strideX = m.charWidth + m.letterSpacing;
        const strideY = m.lineSpacing;
        const pad = this._bgPadding;
        const width  = this.cols * strideX + pad * 2;
        const height = this.rows * strideY + pad * 2;
        const cx = (this.cols * strideX) / 2 - m.charWidth / 2;
        const cy = -(this.rows * strideY) / 2 + strideY / 2;
        const edgeY = cy - height / 2;
        const gap = strideX * 0.5;
        const placed = new Map(); // role → { x, h } so popups can sit above their anchor
        let xRight = cx + width / 2;     // right edge of the next pill (rightmost sits on the SE corner)
        for (const c of this._controls) {
            if (c.spec.popupOf) continue; // placed below, relative to its anchor
            const w = c.button.width;
            const x = xRight - w / 2;
            c.button.position.set(x, edgeY, 0.5);
            placed.set(c.spec.role, { x, h: c.button.height });
            xRight -= (w + gap);
        }
        for (const c of this._controls) {
            if (!c.spec.popupOf) continue;
            const anchor = placed.get(c.spec.popupOf);
            if (anchor) c.button.position.set(anchor.x, edgeY + anchor.h + gap, 0.5);
        }
    }

    /**
     * Register every chrome control on the 'handle' pick channel. The token carries the
     * `button` so the central press router can call its onClick + drive setHovered. Idempotent
     * re-register after a resize re-keys the moved meshes' id-blocks. @private
     */
    _registerControls() {
        if (!this._pickingSystem) return;
        for (const c of this._controls) {
            this._pickingSystem.register('handle', c.button, { grid: this, edge: 'se', role: c.spec.role, button: c.button });
        }
    }

    /** Reflect a control's sticky "engaged" visual (e.g. the Pin button while the window is
     *  pinned). Looked up by role; a no-op if the control isn't present. */
    setControlActive(role, on) {
        const c = this._controls?.find((x) => x.spec.role === role);
        c?.button.setActive(!!on);
    }

    /** Show/hide a control (e.g. the 'close-confirm' popup). A hidden button isn't pick-rendered,
     *  so it's inert until shown. Looked up by role; a no-op if the control isn't present. */
    setControlVisible(role, on) {
        const c = this._controls?.find((x) => x.spec.role === role);
        if (c) c.button.visible = !!on;
    }

    // ================================================================
    // Private: GPU writes
    // ================================================================

    /**
     * Initial push: swap all five attribute arrays into the renderer via
     * applyPrebuiltBuffers(). After this call the non-position geometry attributes wrap
     * our typed arrays, enabling zero-copy in-place updates. Positions are copied out:
     * the CPU branch of applyPrebuiltBuffers pads them into its own stride-4 array
     * (they only change on resize, which re-applies everything anyway).
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

        // State the cull box. A terminal is a uniform cell grid plus a page-quantized
        // history deck, so its glyph extent is arithmetic on cols/rows/metrics — see
        // _glyphExtent. Cell positions only change on resize, which re-enters here.
        this._renderer.setLayoutExtent(this._glyphExtent());

        // After applyPrebuiltBuffers the geometry owns new InstancedBufferAttribute objects
        // wrapping the arrays we passed. On subsequent frames, _writeToInstanceBuffer()
        // writes into geometry.attributes.*.array in place.
    }

    /**
     * The glyph extent in local space — closed form over cols/rows/metrics, mirroring
     * _computePositions exactly: the live screen runs right and down from the origin, and
     * the depth-history deck adds `pages` steps of rise (+Y) and recession (−Z) behind it.
     * This is the CULL box (glyphs only); getLocalBounds adds the panel padding on top.
     * @private
     * @returns {{min:{x,y,z}, max:{x,y,z}}}
     */
    _glyphExtent() {
        const m = this._metrics;
        const strideX = m.charWidth + m.letterSpacing;
        const strideY = m.lineSpacing;
        const pages = this._depthMax > 0 ? Math.ceil(this._depthMax / this.rows) : 0;
        return {
            min: {
                x: 0,
                y: -(this.rows - 1) * strideY,
                z: -pages * this._depthZStep,
            },
            max: {
                x: (this.cols - 1) * strideX + m.charWidth,
                y: pages * this._depthYStep + m.charHeight,
                z: 0,
            },
        };
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
        const live     = this._cellCount;    // bg applies to the live region only

        // BULK fill-carrier write: piggyback the per-cell ANSI bg onto this existing projection
        // loop — 4 bytes/slot straight into the highlight texture's data, then ONE markHighlightDirty()
        // (vs N setGlyphHighlight calls, each re-flagging the upload). Live cells with a bg paint a
        // FILL texel; everything else (default-bg live cells + the whole history block) writes 0 = no
        // fill, so a cleared cell doesn't leave a stale bar. See GlyphField.highlightBuffer.
        const hl = this._renderer.highlightBuffer(count);
        const bgR = this._cellBgR, bgG = this._cellBgG, bgB = this._cellBgB, bgA = this._cellBgA;

        for (let i = 0; i < count; i++) {
            cpArr[i] = this._glyphId(this._codepoints[i]);

            // STRIDE-4: instanceColor is the storage-class RGBA8 lane (the far
            // kernel's compute u32 view; the 4th byte is padding) — same contract
            // as applyPrebuiltBuffers' converted array. Cell colors are 0-1 → ×255.
            const c = i * 4;
            colorArr[c]     = (this._cellR[i] * 255 + 0.5) | 0;
            colorArr[c + 1] = (this._cellG[i] * 255 + 0.5) | 0;
            colorArr[c + 2] = (this._cellB[i] * 255 + 0.5) | 0;

            if (hl) {
                const h = i * 4;
                if (i < live && bgA[i] > 0) {
                    hl[h]     = (bgR[i] * 255 + 0.5) | 0;
                    hl[h + 1] = (bgG[i] * 255 + 0.5) | 0;
                    hl[h + 2] = (bgB[i] * 255 + 0.5) | 0;
                    hl[h + 3] = GlyphField.encodeHighlightAlpha(bgA[i]);   // >0 → FILL
                } else {
                    hl[h] = 0; hl[h + 1] = 0; hl[h + 2] = 0; hl[h + 3] = 0;   // no fill
                }
            }
        }

        cpAttr.needsUpdate    = true;
        colorAttr.needsUpdate = true;
        if (hl) this._renderer.markHighlightDirty();
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
        // The panel material paints the fill AND an in-shader border band (see panelMaterial.js):
        // border strength 0 = a plain fill, drop-in for the old MeshBasicMaterial. depthWrite: the
        // panel must OCCLUDE content behind it (the floor, tiles stacked in a dock); `transparent`
        // only when opacity<1, so a full-opacity panel stays genuinely solid.
        this._panel = createPanelMaterial({
            color: this._bgColor,
            opacity: this._bgOpacity,
            side: THREE.DoubleSide,
            depthWrite: true,
            layerBand: LAYER_BAND.GRID_BACKGROUND,   // one depth step in front of the page face
        });

        this._background = new THREE.Mesh(geometry, this._panel.material);
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
     * stacked tiles in a dock comes down to this opacity. Also tunes cellBgFillOpacity:
     * the opacity of per-cell ANSI background fills (git-diff bars etc.) — applied on the
     * next emulator repaint. All fields optional.
     * @param {{ color?: number|string, opacity?: number, cellBgFillOpacity?: number }} style
     */
    setBackgroundStyle({ color, opacity, cellBgFillOpacity } = {}) {
        if (color != null) this._bgColor = color;
        if (opacity != null) this._bgOpacity = opacity;
        if (cellBgFillOpacity != null) this._bgFillOpacity = cellBgFillOpacity;
        if (!this._panel) return;
        this._panel.setFill(color, opacity);
        if (opacity != null) this._applyGlyphAlpha();
    }

    /**
     * Live nudge of the background's set-back behind the text (the `band.gridBgGap`
     * dial) — a pure z shift by the delta; no relayout. See CodeGrid.refreshBackground.
     */
    refreshBackground(gap) {
        if (!this._background) return;
        this._background.position.z += (this._bgGap ?? 0) - gap;
        this._bgGap = gap;
    }

    // setBorder / setStateColors / setBorderFlag — the in-shader border delegators (this._panel?.x)
    // — are inherited from FramedGlyphField. setBackgroundStyle stays below (terminal-specific _bg*).

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
        this._bgGap ??= getBandDistance(LAYER_BAND.GRID_BACKGROUND);
        this._background.position.set(
            (this.cols * strideX) / 2 - m.charWidth / 2,
            -(this.rows * strideY) / 2 + strideY / 2,
            -this._bgGap  // just behind text — the live band distance (was hard-coded -0.1)
        );
    }
}

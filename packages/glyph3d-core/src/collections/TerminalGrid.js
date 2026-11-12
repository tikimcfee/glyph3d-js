/**
 * TerminalGrid — a terminal's cells (its live screen plus its scrollback-into-depth) drawn as one
 * InstancedField, one glyph slot per cell, spaces included.
 *
 * The cells are a RING of physical rows (`rows + depthMax` of them; see terminalDepthHistory):
 * each physical row draws through its own group-table row, whose offset places it — a live row
 * on the screen, a history line on its page behind it — and whose tint and alpha fade or hide it.
 * Slot positions never change after a resize; what a scroll changes is the ring's head and the
 * group rows, not the cells: the rows that scrolled off become history without a slot rewritten.
 *
 * Per screen update (pulled once a frame, before the render — see TerminalScreenQueue):
 *   - the emulator fills one reused TerminalScreen (typed arrays, packed colors);
 *   - a detected scroll moves the ring's head and re-poses the group rows;
 *   - the live rows are compared cell by cell with what their slots hold (canonical _cp/_fg/_bg
 *     per physical cell): only the cells that differ are written, and only their per-row spans
 *     are uploaded (InstancedField.markSlotsDirty / markHighlightDirty);
 *   - nothing is allocated in steady state.
 *
 * Differs from CodeGrid:
 *   - No line-buffer history, no ANSI stripping
 *   - No GlyphCollection deferred queue, no _rebuildAllInstances() on update
 */

import * as THREE from 'three';
import InstancedField from './InstancedField.js';
import TerminalEmulator, { DEFAULT_FG } from './TerminalEmulator.js';
import TerminalScreenQueue from './TerminalScreenQueue.js';
import {
    detectVerticalScroll,
    layoutTerminalRows,
    ROW_LAYOUT_STRIDE,
    computeTerminalGlyphExtent,
} from './terminalDepthHistory.js';
import { SLOT_FLOATS, LANE_GLYPH_ID, LANE_COLOR } from '../core/InstancedSlotBuffer.js';
import {
    computeCellGridLayout,
    GridChrome,
    TERMINAL_CONTROL_SPEC,
    GridBlockCursor,
} from './grid/index.js';
import { RENDER_ORDER } from '../core/renderOrder.js';
import { LAYER_BAND, getBandDistance } from '../core/layerBands.js';
import MonospaceShapeCache from '../shaping/MonospaceShapeCache.js';
import FramedGlyphField from './FramedGlyphField.js';
import { createPanelMaterial } from './panelMaterial.js';
import { enrollPanel } from './PanelBatch.js';

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

// Bracketed-paste framing (DECSET 2004). A pasted burst arrives wrapped in these so the
// receiving application can tell "the human pasted this" from "the human typed this" — which
// is how a shell declines to execute a multi-line paste and an editor declines to auto-indent
// it. See TerminalGrid.paste().
const PASTE_START = '\x1b[200~';
const PASTE_END   = '\x1b[201~';

export default class TerminalGrid extends FramedGlyphField {
    static CONTROL_SPEC = TERMINAL_CONTROL_SPEC;

    /**
     * @param {THREE.Scene} scene
     * @param {import('../GlyphAtlas.js').default} atlas
     * @param {Object} [options]
     * @param {string} [options.id]             Terminal id — the identity every input the grid
     *   emits is stamped with. Set it at construction so callers never re-supply it per call.
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

        // This terminal's id — the one the registry, the WorkspaceModel surface record and the
        // owning adapter all know it by. Held here so INPUT the grid emits carries its own
        // identity: callers say WHAT to send, never WHO is sending (see onInput / paste).
        // NOT `this.id`: Object3D defines that as a non-writable numeric instance id
        // (Object.defineProperty, writable:false), so assigning it throws in strict mode.
        this.terminalId = options.id ?? null;

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
        this._altActive = false;  // current frame is an alt-screen (TUI) repaint
        this._depthYStep = 0;     // world rise per page (set once metrics exist)
        this._depthZStep = 0;     // world recede per page (set once metrics exist)

        // ---- The cell ring ----
        // History (oldest line first) then the live screen (top row first) is one sequence in
        // time order; it lives in a ring of `rows + depthMax` physical rows whose head
        // (_ringStart: the physical row of sequence index 0) a scroll moves. Canonical state per
        // PHYSICAL cell — slot index = physical row × cols + column — in TerminalScreen's
        // encoding: codepoint, packed fg, bg word (0 = no fill). The slot buffer and the
        // highlight texture are its projection; every write goes through _writeSpans /
        // _writeSeqRows / _pushAll, which upload what they wrote.
        this._ringStart = 0;
        this._scrollBase = false;  // the live rows hold the last screen applied (a scroll may be diffed against them)
        /** @type {Uint32Array} */ this._cp = null;
        /** @type {Uint32Array} */ this._fg = null;
        /** @type {Uint32Array} */ this._bg = null;
        /** @type {Uint8Array} per physical row: some cell has a background */ this._rowHasBg = null;
        /** @type {Int32Array} per physical row: its group-table row */ this._rowGroups = new Int32Array(0);
        /** @type {Float32Array} per sequence index: y, z, fade (layoutTerminalRows) */ this._rowLayout = null;
        /** @type {Int32Array} per live row: its first cell's physical index */ this._liveRowBase = null;
        // Per live row, this update's changed spans (first/last column; last < first = none):
        // glyph or color, and background. Scratch, reused every update.
        this._spanLo = this._spanHi = this._bgLo = this._bgHi = null;
        /** @type {number[]} codepoints first seen this update (empty in steady state) */
        this._fresh = [];
        this._screenQueued = false;   // waiting in the scene's TerminalScreenQueue

        /**
         * Input callback -- set by the owning agent or process. When set, every input this
         * terminal emits (keystroke bytes from the responder chain, `terminal.input`, paste)
         * leaves through here, bound for the owning adapter's PTY.
         * Signature: (bytes: string, terminalId: string) => void — the id is THIS grid's
         * `this.terminalId`, supplied by the grid, not by the caller.
         * @type {Function|null}
         */
        this.onInput = null;

        const worldScale = options.worldScale ?? 0.025;
        this._gridScale = options.gridScale ?? 1.0;

        // Instance budget = live cells + a depth-history block (cols × _depthMax), allocated up
        // front so the picking glyph-channel id-block stays stable (history never grows the
        // instance count — the ring re-poses rows instead).
        this._cellCount  = this.cols * this.rows;
        this._depthCount = this.cols * this._depthMax;
        this._totalCount = this._cellCount + this._depthCount;

        // One dedicated renderer per terminal, with a group-table row per physical row.
        this._renderer = new InstancedField(scene, atlas, {
            maxInstances: this._totalCount,
            groupCap: Math.max(4096, this.rows + this._depthMax + 1),
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

        // Background plane — dark panel behind the terminal for readability. The _panel/
        // _background slots are declared by FramedGlyphField; _initBackground builds them.
        this._bgColor = options.backgroundColor ?? 0x0a0a1e;
        this._bgOpacity = options.backgroundOpacity ?? 0.96;
        this._bgPadding = options.backgroundPadding ?? 0.3;
        // Per-cell ANSI background fill opacity (git-diff bars, ls --color, selections). Solid by
        // default — a colored cell reads as an opaque block like a real terminal; tunable live.
        this._bgFillOpacity = options.cellBgFillOpacity ?? 1.0;
        this._visible = true; // setVisible state — folded with the fade (shared alpha slot)

        // The cells, blank, and every slot pushed. The glyphs draw at the panel's opacity (the row
        // poses carry it), so a translucent tile reads as one sheet, not opaque text over glass.
        this._allocateCells(null);
        this._pushAll();
        this._initBackground();

        // Window chrome: a bottom-edge row of controls
        this._chrome = null;
        this._initControls();

        // Cursor block — marks the live cell where typing lands
        this._cursorColor       = options.cursorColor       ?? TERMINAL_CURSOR_DEFAULTS.color;
        this._cursorFillOpacity = options.cursorFillOpacity ?? TERMINAL_CURSOR_DEFAULTS.fillOpacity;
        this._cursorBorderWidth = options.cursorBorderWidth ?? TERMINAL_CURSOR_DEFAULTS.borderWidth;
        this._cursor         = { x: 0, y: 0 };  // live cursor cell (viewport-relative)
        this._cursorVisible  = true;            // emulator-driven draw gate (always on for now)
        this._cursorFocused  = false;           // keyboard-target → solid; else hollow
        this._cursorCaptured = false;           // greedy capture settled → solid + ring (wins over focused)
        this._cursorBlock    = null;
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

        // Byte→screen source: a headless VT emulator parses the terminal byte stream; a parse
        // queues this grid on its scene's TerminalScreenQueue, and the frame applies the screen
        // before it renders (applyPendingScreen). TerminalGrid stays a pure cell renderer; the
        // emulator is one source feeding it (file-slice / graphics are others, later).
        this._emulator = new TerminalEmulator(this.cols, this.rows, () => this._screenChanged());

        /**
         * The window title the terminal's program last set (OSC 0/2 — behind tmux, the pane title:
         * the shell's prompt path or the running command). Empty until one arrives.
         * @type {string}
         */
        this.windowTitle = '';
        this._emulator.onTitleChange((title) => {
            this.windowTitle = title;
            if (this._titleListeners) {
                for (const cb of this._titleListeners) { try { cb(title); } catch (e) { console.error(`[TerminalGrid ${this.terminalId}] a window-title listener threw (the others still ran):`, e); } }
            }
        });
    }

    // ================================================================
    // Public API
    // ================================================================

    /**
     * Apply a TerminalScreen (TerminalEmulator.readScreen, read at this grid's cols × rows): move
     * the ring if the screen scrolled, then write only the cells that differ from what the slots
     * hold, and upload only those spans. Allocates nothing in steady state (a first-seen glyph
     * is the exception: it is handed to the atlas).
     *
     * @param {ReturnType<import('./TerminalEmulator.js').createTerminalScreen>} screen
     */
    applyScreen(screen) {
        const cols = this.cols, rows = this.rows;
        if (screen.cols !== cols || screen.rows !== rows) {
            throw new Error(`[TerminalGrid ${this.terminalId}] applyScreen got a ${screen.cols}×${screen.rows} screen for a ${cols}×${rows} grid — read it at the grid's size (TerminalEmulator.readScreen(cols, rows))`);
        }
        const alt = !!screen.alt;
        let repose = alt !== this._altActive;   // history shows or hides with the alt screen
        this._altActive = alt;

        // Lines that scrolled off the top since the last screen become history: compare the
        // incoming screen with the live rows as they stand, and move the ring's head by the
        // shift instead of moving any cells.
        if (this._depthEnabled && !alt && this._scrollBase) {
            const k = detectVerticalScroll(this._cp, this._liveRowBase, screen.cp, rows, cols);
            if (k > 0) {
                this._scrollRing(k);
                repose = true;
            }
        }

        this._diffLive(screen);
        if (this._fresh.length) this._ensureAtlasCodepoints(this._fresh);
        this._writeSpans();
        if (repose) this._poseRows();
        this._scrollBase = true;

        // Move the cursor block to the cell the emulator reports.
        this._cursor.x = screen.cursorX;
        this._cursor.y = screen.cursorY;
        this._updateCursorMesh();
    }

    /**
     * The frame's pull (TerminalScreenQueue.flush, from SceneSystems.update, before the render):
     * read the emulator's screen once — however many writes were parsed since the last frame —
     * and apply it.
     */
    applyPendingScreen() {
        this._screenQueued = false;
        const emu = this._emulator;
        if (!emu || !emu.dirty) return;
        this.applyScreen(emu.readScreen(this.cols, this.rows));
    }

    /**
     * The emulator parsed bytes: queue this grid for the scene's next frame (once, however many
     * writes land before it). A scene with no TerminalScreenQueue (no SceneSystems) never applies
     * a screen — said once, loudly.
     * @private
     */
    _screenChanged() {
        if (this._screenQueued) return;
        const queue = TerminalScreenQueue.of(this.scene);
        if (!queue) {
            if (!this._noQueueNoted) {
                this._noQueueNoted = true;
                console.error(`[TerminalGrid ${this.terminalId}] output was parsed, but this terminal's scene has no TerminalScreenQueue (no SceneSystems runs it), so its screen never draws — install SceneSystems on the scene and call update() once a frame`);
            }
            return;
        }
        this._screenQueued = true;
        queue.add(this);
    }

    /**
     * Scroll by k: the top k live rows become the newest history lines, the oldest k history
     * lines (or, with less history than k, the top live rows themselves) come round as the new
     * bottom live rows, whose cells the diff then rewrites. Only the head moves; a row moving
     * into history drops its background (history keeps none).
     * @private
     * @param {number} k  lines scrolled, 1 … rows − 1
     */
    _scrollRing(k) {
        const rows = this.rows, cols = this.cols, D = this._depthMax, P = rows + D;
        for (let y = 0; y < k; y++) {
            if (D + y - k < 0) continue;                       // it comes round as a live row
            const p = (this._ringStart + D + y) % P;
            if (!this._rowHasBg[p]) continue;
            const base = p * cols;
            this._bg.fill(0, base, base + cols);
            this._highlightWords().fill(0, base, base + cols);
            this._renderer.markHighlightDirty(base, cols);
            this._rowHasBg[p] = 0;
        }
        this._ringStart = (this._ringStart + k) % P;
        this._indexLiveRows();
    }

    /** @private Each live row's first physical cell, for the ring's current head. */
    _indexLiveRows() {
        const rows = this.rows, cols = this.cols, D = this._depthMax, P = rows + D;
        for (let y = 0; y < rows; y++) this._liveRowBase[y] = ((this._ringStart + D + y) % P) * cols;
    }

    /**
     * Compare the screen with the live rows' canonical cells, copy what differs, and record each
     * row's changed span (glyph/color, background). New codepoints go to _fresh for the atlas.
     * @private
     */
    _diffLive(screen) {
        const cols = this.cols, rows = this.rows;
        const CP = this._cp, FG = this._fg, BG = this._bg;
        const sCP = screen.cp, sFG = screen.fg, sBG = screen.bg;
        const lo = this._spanLo, hi = this._spanHi, blo = this._bgLo, bhi = this._bgHi;
        const seen = this._liveEnsured;
        const fresh = this._fresh;
        fresh.length = 0;
        const ensure = !!(this.atlas && this.atlas._live && this._shapeCache);
        for (let y = 0; y < rows; y++) {
            const base = this._liveRowBase[y];
            let l = cols, h = -1, bl = cols, bh = -1, anyBg = 0;
            for (let x = 0, si = y * cols, i = base; x < cols; x++, si++, i++) {
                const c = sCP[si], f = sFG[si], b = sBG[si];
                if (c !== CP[i]) {
                    CP[i] = c; FG[i] = f;
                    if (l === cols) l = x;
                    h = x;
                    if (ensure && c > 32 && !seen.has(c)) { seen.add(c); fresh.push(c); }
                } else if (f !== FG[i]) {
                    FG[i] = f;
                    if (l === cols) l = x;
                    h = x;
                }
                if (b !== BG[i]) {
                    BG[i] = b;
                    if (bl === cols) bl = x;
                    bh = x;
                }
                if (b !== 0) anyBg = 1;
            }
            lo[y] = l; hi[y] = h; blo[y] = bl; bhi[y] = bh;
            this._rowHasBg[base / cols] = anyBg;
        }
    }

    /**
     * Write the live rows' changed spans into the slot buffer (glyph id + color) and the highlight
     * texture (the cell background as a fill), and mark exactly those spans for upload.
     * @private
     */
    _writeSpans() {
        const rows = this.rows;
        const field = this._renderer;
        const f32 = field.slotBuffer.f32;
        const CP = this._cp, FG = this._fg, BG = this._bg;
        const lo = this._spanLo, hi = this._spanHi, blo = this._bgLo, bhi = this._bgHi;
        let words = null, fill = 0;
        for (let y = 0; y < rows; y++) {
            const base = this._liveRowBase[y];
            const l = lo[y], h = hi[y];
            if (h >= l) {
                for (let i = base + l, end = base + h; i <= end; i++) {
                    const o = i * SLOT_FLOATS;
                    f32[o + LANE_GLYPH_ID] = this._glyphId(CP[i]);
                    f32[o + LANE_COLOR] = FG[i];
                }
                field.markSlotsDirty(base + l, h - l + 1);
            }
            const bl = blo[y], bh = bhi[y];
            if (bh >= bl) {
                if (!words) { words = this._highlightWords(); fill = this._fillAlphaBits(); }
                for (let i = base + bl, end = base + bh; i <= end; i++) {
                    const b = BG[i];
                    words[i] = b && fill ? (b & 0xffffff) | fill : 0;
                }
                field.markHighlightDirty(base + bl, bh - bl + 1);
            }
        }
    }

    /** @private The highlight texels, one RGBA8 word per slot. */
    _highlightWords() {
        return this._renderer.highlightWords(this._totalCount);
    }

    /**
     * @private A cell background's fill alpha, in a highlight word's top byte (0 = the fill is off:
     * the cell draws no fill at all).
     */
    _fillAlphaBits() {
        return InstancedField.encodeHighlightAlpha(this._bgFillOpacity) << 24;
    }

    /**
     * Pose every physical row through its group-table row: where its sequence index sits
     * (_rowLayout), its fade, and its alpha — the panel's opacity, 0 while hidden, and for
     * history also 0 while depth history is off or an alt-screen app has the terminal.
     * @private
     */
    _poseRows() {
        const field = this._renderer, L = this._rowLayout, G = this._rowGroups;
        const D = this._depthMax, P = this.rows + D, start = this._ringStart;
        const shown = this._visible ? this._bgOpacity : 0;
        const historyAlpha = this._depthEnabled && !this._altActive ? shown : 0;
        for (let s = 0; s < P; s++) {
            const o = s * ROW_LAYOUT_STRIDE;
            const fade = L[o + 2];
            field.setGroupOffsetColor(G[(start + s) % P], 0, L[o], L[o + 1], fade, fade, fade, s < D ? historyAlpha : shown);
        }
    }

    /**
     * Write whole rows of the sequence [s0, s0 + n) — glyph and color lanes, from the canonical
     * cells — and mark them for upload (one range per contiguous physical run).
     * @private
     */
    _writeSeqRows(s0, n) {
        const cols = this.cols, P = this.rows + this._depthMax;
        const field = this._renderer, f32 = field.slotBuffer.f32;
        const CP = this._cp, FG = this._fg;
        let runStart = -1, runEnd = -1;
        for (let s = s0; s < s0 + n; s++) {
            const p = (this._ringStart + s) % P;
            const base = p * cols;
            for (let i = base; i < base + cols; i++) {
                const o = i * SLOT_FLOATS;
                f32[o + LANE_GLYPH_ID] = this._glyphId(CP[i]);
                f32[o + LANE_COLOR] = FG[i];
            }
            if (base === runEnd) { runEnd += cols; continue; }
            if (runStart >= 0) field.markSlotsDirty(runStart, runEnd - runStart);
            runStart = base; runEnd = base + cols;
        }
        if (runStart >= 0) field.markSlotsDirty(runStart, runEnd - runStart);
    }

    /**
     * Whether scrollback-into-depth is active for this terminal.
     * @returns {boolean}
     */
    get depthHistory() {
        return this._depthEnabled;
    }

    /**
     * Toggle scrollback-into-depth. Disabling clears the captured history (off means gone) and
     * hides the depth block; it refills as the live screen scrolls once re-enabled.
     * @param {boolean} enabled
     */
    setDepthHistory(enabled) {
        this._depthEnabled = !!enabled;
        if (!this._depthEnabled) this._blankHistory();
        this._poseRows();
    }

    /** @private Blank every history line (spaces, default fg) and upload them. */
    _blankHistory() {
        const D = this._depthMax, cols = this.cols, P = this.rows + D;
        for (let s = 0; s < D; s++) {
            const base = ((this._ringStart + s) % P) * cols;
            this._cp.fill(32, base, base + cols);
            this._fg.fill(DEFAULT_FG, base, base + cols);
        }
        this._writeSeqRows(0, D);
    }

    /**
     * Change how many depth-history lines this terminal keeps and renders, reallocating
     * the instance budget (cols × (rows + max)). The captured history is PRESERVED (trimmed
     * if shrinking) and so is the live screen. Lets you crank a deeper "wall of history" than
     * the construction default (1000 lines is still a single instanced draw call).
     * @param {number} max
     */
    setDepthMax(max) {
        max = Math.max(0, Math.floor(max) || 0);
        if (max === this._depthMax) return;
        const keep = this._sequenceSnapshot();
        this._depthMax = max;
        this._depthCount = this.cols * max;
        this._totalCount = this._cellCount + this._depthCount;
        this._allocateCells(keep);
        this._pushAll();
        if (this._pickingSystem) {
            this._pickingSystem.register('glyph', this._renderer, this._renderer);
        }
    }

    /**
     * Tune the depth-history layout live: per-PAGE rise (+Y) and recession (−Z), each a
     * multiple of lineSpacing. yFactor=0 → a flat straight-back deck of pages; yFactor>0
     * → pages also climb. zFactor sets how far each page steps back. Re-poses the rows (their
     * group rows carry the placement — no cell is rewritten). Pass null for either to leave it.
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
        this._layoutRows();
        this._poseRows();
        this._renderer.setLayoutExtent(this._glyphExtent());
    }

    /**
     * Seed the depth history from EXTERNAL scrollback (e.g. tmux capture-pane),
     * NEWEST-FIRST. Forward-capture (the frame diff) only sees lines that scroll off
     * from now on; this back-fills the history that already exists — so the session's
     * accumulated scrollback shows receding in depth immediately, and a re-seed after
     * a reload restores it (tmux is the durable source; the ring is in-memory).
     *
     * Each string becomes one history line (one codepoint per column, padded/truncated
     * to cols) at the default foreground color; normal depth fade + placement apply.
     * Glyphs not yet in the live atlas are encoded first. Lines past _depthMax are
     * dropped (only that many slots render). Replaces the current history; later
     * forward-captures push in front of the seed seamlessly.
     * @param {string[]} lines  scrollback rows, newest first
     */
    seedHistory(lines) {
        const D = this._depthMax;
        if (D === 0) return;
        const cols = this.cols, P = this.rows + D;
        const n = Math.min(lines.length, D);
        const live = this.atlas && this.atlas._live;
        const seen = this._liveEnsured;
        let fresh = null;

        for (let h = 0; h < D; h++) {
            const base = ((this._ringStart + D - 1 - h) % P) * cols;
            this._cp.fill(32, base, base + cols);
            this._fg.fill(DEFAULT_FG, base, base + cols);
            if (h >= n) continue;
            let x = 0;
            for (const ch of lines[h] || '') {   // iterate by code point (surrogate-safe)
                if (x >= cols) break;
                const code = ch.codePointAt(0);
                this._cp[base + x] = code;
                if (live && this._shapeCache && code > 32 && !seen.has(code)) {
                    seen.add(code);
                    (fresh ?? (fresh = [])).push(code);
                }
                x++;
            }
        }
        if (fresh) this._ensureAtlasCodepoints(fresh);
        this._writeSeqRows(0, D);
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
     * emulator parses them (cursor motion, scroll regions, erase, SGR, …); the next frame
     * applies the screen before it renders (applyPendingScreen).
     *
     * @param {Uint8Array|string} payload - raw terminal output bytes
     */
    writeBytes(payload) {
        this._emulator.write(payload);
        // Byte-output tap: a 2D companion view (DOM xterm) consumes the SAME PTY stream the
        // 3D emulator renders — one source, two projections. Fires with the raw payload.
        if (this._byteListeners) {
            for (const cb of this._byteListeners) { try { cb(payload); } catch (e) { console.error(`[TerminalGrid ${this.terminalId}] a byte listener threw (the others still ran):`, e); } }
        }
    }

    /**
     * INPUT entry — the twin of writeBytes. Hand the terminal bytes and it emits them through
     * its owner's callback, stamped with its own id. Every input surface (the keyboard
     * responder chain, a 2D companion xterm, the `terminal.input` verb) funnels through here,
     * so identity is the grid's business and callers only decide WHAT to send.
     *
     * @param {string} bytes - raw terminal input bytes
     * @returns {boolean} true if an owner was listening and took them
     */
    sendInput(bytes) {
        if (typeof this.onInput !== 'function' || !bytes) return false;
        this.onInput(bytes, this.terminalId);
        return true;
    }

    /**
     * Paste text as a single bracketed-paste burst. Terminal semantics live HERE, not in the
     * app shell: callers pass plain clipboard text and the grid frames it.
     *
     * Framing is UNCONDITIONAL because tmux — which owns the far side of every terminal here
     * (cli/attach_unix.go writes into a `tmux attach-client` PTY) — normalizes it: it strips
     * the brackets when the inner application has NOT enabled DECSET 2004, and re-emits them
     * when it has. Verified both ways against a live tmux. tmux also converts LF inside the
     * burst, so newlines need no rewriting. If a NON-tmux adapter ever writes straight to a
     * bare PTY, gate the framing on this._emulator's bracketedPasteMode here — inside this
     * method, where the mode already is; no caller would change.
     *
     * The one payload transform is stripping the end-marker: clipboard text containing
     * `ESC [ 201 ~` would otherwise close the bracket early and let its remainder run as
     * keystrokes (paste injection).
     *
     * @param {string} text - plain clipboard text
     * @returns {boolean} true if it was sent
     */
    paste(text) {
        if (typeof text !== 'string' || text === '') return false;
        return this.sendInput(PASTE_START + text.replaceAll(PASTE_END, '') + PASTE_END);
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
     * Subscribe to window-title changes (see windowTitle). Returns an unsubscribe fn.
     * @param {(title: string) => void} cb
     */
    onWindowTitle(cb) {
        if (!this._titleListeners) this._titleListeners = new Set();
        this._titleListeners.add(cb);
        return () => { this._titleListeners?.delete(cb); };
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
     * Show or hide the terminal: the row poses' alpha (0 culls a row's glyphs in the vertex
     * stage). Visibility and the panel-matched fade share that one alpha, folded in _poseRows.
     *
     * @param {boolean} visible
     */
    setVisible(visible) {
        this._visible = visible;
        this._poseRows();
        this._updateCursorMesh();   // the cursor mesh isn't in the glyph group; hide/show it explicitly
    }

    // ================================================================
    // Cursor block — "where typing lands"
    // ================================================================

    get _cursorMesh() {
        return this._cursorBlock?.mesh;
    }

    get _cursorCtl() {
        return this._cursorBlock?.ctl;
    }

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
        if (this._cursorCaptured) {
            this._cursorBlock?.setCaptured(true);
        } else if (this._cursorFocused) {
            this._cursorBlock?.setCaptured(false);
            this._cursorBlock?.setFocused(true);
        } else {
            this._cursorBlock?.setCaptured(false);
            this._cursorBlock?.setFocused(false);
        }
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
        this._cursorBlock?.setStyle({ color, fillOpacity, borderWidth });
    }

    /**
     * Lazy-build the cursor block via GridBlockCursor.
     * @private
     */
    _initCursorMesh() {
        if (this._cursorBlock) return;
        this._cursorBlock = new GridBlockCursor({
            parent: this,
            metrics: this._metrics,
            color: this._cursorColor,
            fillOpacity: this._cursorFillOpacity,
            borderWidth: this._cursorBorderWidth,
            renderOrder: CURSOR_RENDER_ORDER,
        });
        this._applyCursorState();
        this._updateCursorMesh();
    }

    /**
     * Park the cursor block on its live cell.
     * @private
     */
    _updateCursorMesh() {
        if (!this._cursorBlock) return;
        this._cursorBlock.setGridVisible(this._visible);
        this._cursorBlock.setCursorVisible(this._cursorVisible);
        this._cursorBlock.update(this._cursor.x, this._cursor.y, this.cols, this.rows, this._metrics);
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
            const layout = computeCellGridLayout(this.cols, this.rows, this._metrics, this._bgPadding);
            // Small Z thickness so an edge-on ray still intersects the flat panel.
            this._localBounds = new THREE.Box3(
                new THREE.Vector3(layout.cx - layout.width / 2, layout.cy - layout.height / 2, -1),
                new THREE.Vector3(layout.cx + layout.width / 2, layout.cy + layout.height / 2, 1),
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
     * Resize the terminal. Reallocates the cell ring at the new size and pushes every slot; the
     * live screen and the captured history are kept (clipped if narrower, blank-padded if wider —
     * terminals clip scrollback on resize, and tmux holds the durable copy that
     * terminal.depth.seed re-fills), so the panel doesn't flash blank before the emulator's
     * repaint — that matters under a live grip-drag firing resize every cell step.
     *
     * @param {number} cols
     * @param {number} rows
     */
    resize(cols, rows) {
        const keep = this._sequenceSnapshot();
        this.cols = cols;
        this.rows = rows;
        this._cellCount  = cols * rows;
        this._depthCount = cols * this._depthMax;
        this._totalCount = this._cellCount + this._depthCount;
        this._localBoundsDirty = true;

        this._allocateCells(keep);
        // The held live rows are the old size's: the next screen must not be diffed for a scroll
        // against them (a phantom scroll across the resize).
        this._scrollBase = false;
        this._pushAll();
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
        // Tear down the emulator first, and leave the frame's queue, so no screen is applied to a
        // half-disposed renderer.
        if (this._emulator) {
            this._emulator.dispose();
            this._emulator = null;
        }
        TerminalScreenQueue.of(this.scene)?.delete(this);
        this._screenQueued = false;
        // Leave both picking channels cleanly before tearing down the renderer +
        // panel, or the passes would swap materials onto a disposed mesh.
        if (this._pickingSystem) {
            if (this._renderer)   this._pickingSystem.unregister('glyph', this._renderer);
            if (this._background) this._pickingSystem.unregister('grid', this._background);
            this._chrome?.unregisterPicking(this._pickingSystem);
        }
        if (this._renderer) {
            this._renderer.instanceMesh.geometry.dispose();
            this._renderer.instanceMesh.material.dispose();
            this._renderer = null;
        }
        if (this._cursorBlock) {
            this._cursorBlock.dispose();
            this._cursorBlock = null;
        }
        this._disposePanel();   // free + detach the background panel (FramedGlyphField)
        if (this._chrome) {
            this._chrome.dispose();
            this._chrome = null;
        }
        this.scene.remove(this);
    }

    // ================================================================
    // Private: Layout
    // ================================================================

    /**
     * Where each sequence index's row sits and how it fades (terminalDepthHistory.layoutTerminalRows),
     * for the current rows / depth / page steps. _poseRows writes it through the ring's head.
     * @private
     */
    _layoutRows() {
        const P = this.rows + this._depthMax;
        if (!this._rowLayout || this._rowLayout.length !== P * ROW_LAYOUT_STRIDE) {
            this._rowLayout = new Float32Array(P * ROW_LAYOUT_STRIDE);
        }
        layoutTerminalRows(this._rowLayout, this.rows, this._depthMax, this._metrics,
            this._depthYStep, this._depthZStep, this._depthFadeMin);
    }

    /**
     * The cells in SEQUENCE order (history oldest first, then the live rows), unrotated, with the
     * shape they were held at — what a reallocation restores from.
     * @private
     * @returns {{cols:number, rows:number, depthMax:number, cp:Uint32Array, fg:Uint32Array, bg:Uint32Array}|null}
     */
    _sequenceSnapshot() {
        if (!this._cp) return null;
        const cols = this.cols, rows = this.rows, D = this._depthMax, P = rows + D;
        const cp = new Uint32Array(P * cols), fg = new Uint32Array(P * cols), bg = new Uint32Array(P * cols);
        for (let s = 0; s < P; s++) {
            const from = ((this._ringStart + s) % P) * cols;
            cp.set(this._cp.subarray(from, from + cols), s * cols);
            fg.set(this._fg.subarray(from, from + cols), s * cols);
            bg.set(this._bg.subarray(from, from + cols), s * cols);
        }
        return { cols, rows, depthMax: D, cp, fg, bg };
    }

    /**
     * (Re)allocate the cell ring for the current cols / rows / depthMax, head at 0, one group-table
     * row per physical row, every cell blank — then restore `keep` (a _sequenceSnapshot of the old
     * shape): history line h stays history line h, live row y stays live row y, each clipped or
     * blank-padded to the new width; history keeps no background. Writes no slot (_pushAll does).
     * @private
     * @param {ReturnType<TerminalGrid['_sequenceSnapshot']>} keep
     */
    _allocateCells(keep) {
        const cols = this.cols, rows = this.rows, D = this._depthMax, P = rows + D, n = P * cols;
        this._cp = new Uint32Array(n).fill(32);
        this._fg = new Uint32Array(n).fill(DEFAULT_FG);
        this._bg = new Uint32Array(n);
        this._rowHasBg = new Uint8Array(P);
        this._ringStart = 0;
        this._liveRowBase = new Int32Array(rows);
        this._spanLo = new Int32Array(rows);
        this._spanHi = new Int32Array(rows);
        this._bgLo = new Int32Array(rows);
        this._bgHi = new Int32Array(rows);
        this._indexLiveRows();

        // One group-table row per physical row: grow or release to match.
        const field = this._renderer;
        const groups = Array.from(this._rowGroups);
        if (field.groupCap < P + 1) field.groupCap = P + 1;
        while (groups.length < P) groups.push(field.createGroup());
        while (groups.length > P) field.releaseGroup(groups.pop());
        this._rowGroups = Int32Array.from(groups);
        this._layoutRows();

        if (!keep) return;
        const w = Math.min(cols, keep.cols);
        const copyRow = (fromSeq, toSeq, withBg) => {
            const from = fromSeq * keep.cols, to = toSeq * cols;   // head is 0: seq index = physical row
            this._cp.set(keep.cp.subarray(from, from + w), to);
            this._fg.set(keep.fg.subarray(from, from + w), to);
            if (!withBg) return;
            this._bg.set(keep.bg.subarray(from, from + w), to);
            for (let x = 0; x < w; x++) if (this._bg[to + x]) { this._rowHasBg[toSeq] = 1; break; }
        };
        for (let h = 0; h < Math.min(D, keep.depthMax); h++) copyRow(keep.depthMax - 1 - h, D - 1 - h, false);
        for (let y = 0; y < Math.min(rows, keep.rows); y++) copyRow(keep.depthMax + y, D + y, true);
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
    get _controls() {
        return this._chrome ? this._chrome.controls : [];
    }

    /**
     * Build the chrome control row from CONTROL_SPEC.
     * @private
     */
    _initControls() {
        if (this._chrome) return;
        this._chrome = new GridChrome(this, this._metrics, TerminalGrid.CONTROL_SPEC);
        this._layoutControls();
    }

    /**
     * Place the control row along the bottom edge, packing pills right→left from the SE corner.
     * @private
     */
    _layoutControls() {
        this._chrome?.layout(this.cols, this.rows, this._bgPadding);
    }

    /**
     * Register chrome controls on the 'handle' pick channel.
     * @private
     */
    _registerControls() {
        this._chrome?.registerPicking(this._pickingSystem, this);
    }

    /**
     * Reflect a control's sticky "engaged" visual.
     * @param {string} role
     * @param {boolean} on
     */
    setControlActive(role, on) {
        this._chrome?.setActive(role, on);
    }

    /**
     * Show/hide a control.
     * @param {string} role
     * @param {boolean} on
     */
    setControlVisible(role, on) {
        this._chrome?.setVisible(role, on);
    }

    // ================================================================
    // Private: GPU writes
    // ================================================================

    /**
     * Push every slot from the canonical cells — positions (row-local: the row's group row places
     * it), glyph ids, colors, group rows, extents — plus every highlight texel, the row poses and
     * the cull box: the whole-terminal write construction, resize and setDepthMax need. Per-update
     * writes go through _writeSpans instead.
     * @private
     */
    _pushAll() {
        const field = this._renderer;
        const cols = this.cols, P = this.rows + this._depthMax, count = this._totalCount;
        const m = this._metrics;
        const strideX = m.charWidth + m.letterSpacing;
        const sb = field.slotBuffer;
        sb.ensureCapacity(count);
        for (let p = 0; p < P; p++) {
            const g = this._rowGroups[p];
            for (let x = 0, i = p * cols; x < cols; x++, i++) {
                sb.setSlot(i, x * strideX, 0, 0, this._glyphId(this._cp[i]), this._fg[i], g, m.charWidth, m.charHeight);
            }
        }
        field.setSlots(sb, count);
        field.maxInstances = Math.max(field.maxInstances, count);

        const words = this._highlightWords();
        const fill = this._fillAlphaBits();
        for (let i = 0; i < count; i++) {
            const b = this._bg[i];
            words[i] = b && fill ? (b & 0xffffff) | fill : 0;
        }
        words.fill(0, count);
        field.markHighlightDirty();

        this._poseRows();
        // State the cull box. A terminal is a uniform cell grid plus a page-quantized history
        // deck, so its glyph extent is arithmetic on cols/rows/metrics — see _glyphExtent.
        field.setLayoutExtent(this._glyphExtent());
    }

    /**
     * The glyph extent in local space — closed form over cols/rows/metrics, mirroring
     * layoutTerminalRows exactly: the live screen runs right and down from the origin, and
     * the depth-history deck adds `pages` steps of rise (+Y) and recession (−Z) behind it.
     * This is the CULL box (glyphs only); getLocalBounds adds the panel padding on top.
     * @private
     * @returns {{min:{x,y,z}, max:{x,y,z}}}
     */
    _glyphExtent() {
        return computeTerminalGlyphExtent(
            this.cols,
            this.rows,
            this._depthMax,
            this._metrics,
            this._depthYStep,
            this._depthZStep
        );
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
     * Have the live Slug atlas encode glyphs this terminal is about to draw for the first time,
     * before their slots are written.
     *
     * Each new codepoint is routed through the font chain and encoded on first sighting; the live
     * atlas re-encodes + hot-swaps the curve/glyph-map textures into every field (including this
     * terminal's) synchronously, so by the time the slot is written the glyph is renderable.
     * Callers pass only codepoints this terminal has never drawn (its `_liveEnsured` set, which
     * they add them to): a cell whose codepoint didn't change was ensured when it first did, so a
     * screen update hands over nothing at all in steady state.
     *
     * @private
     * @param {number[]} codepoints  first-seen codepoints (> 32)
     */
    _ensureAtlasCodepoints(codepoints) {
        const live = this.atlas && this.atlas._live;
        if (!live || !this._shapeCache) return; // degraded boot: nothing to encode
        // ensureCodepoints dedups globally (its encoded set), so codepoints another
        // grid already encoded are a cheap no-op here.
        live.ensureCodepoints(codepoints.slice(), this._shapeCache);
    }

    // ================================================================
    // Private: Background
    // ================================================================

    /**
     * Create a dark background plane behind the terminal for readability.
     * Sized to fit cols×rows with padding. Updated on resize.
     *
     * L0 invariant: this mesh is also the terminal entity's hit target. So:
     *   - The mesh must exist and have `visible = true` (THREE.Mesh default).
     *   - It must be `DoubleSide` so a camera approaching from either side
     *     can hit it (the grid is typically drawn at z=0 with the camera
     *     anywhere in world space).
     *   - The padded size (cols*strideX + 2*pad × rows*strideY + 2*pad, see
     *     _updateBackground) is effectively full-bleed over the cell grid,
     *     giving clicks a generous target even at the edge of the last row.
     * Do not remove, shrink below the cell extent, or set `visible = false`
     * without replacing the hit target with another mesh.
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
        });

        this._background = enrollPanel(new THREE.Mesh(geometry, this._panel.material));
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
     * the opacity of per-cell ANSI background fills (git-diff bars etc.) — rewritten into the
     * live rows' fills at once. All fields optional.
     * @param {{ color?: number|string, opacity?: number, cellBgFillOpacity?: number }} style
     */
    setBackgroundStyle({ color, opacity, cellBgFillOpacity } = {}) {
        if (color != null) this._bgColor = color;
        if (opacity != null) this._bgOpacity = opacity;
        if (cellBgFillOpacity != null && cellBgFillOpacity !== this._bgFillOpacity) {
            this._bgFillOpacity = cellBgFillOpacity;
            this._rewriteFills();
        }
        if (!this._panel) return;
        this._panel.setFill(color, opacity);
        if (opacity != null) this._poseRows();
    }

    /** @private Rewrite every live cell's background fill (the fill opacity changed). */
    _rewriteFills() {
        const words = this._highlightWords(), fill = this._fillAlphaBits(), cols = this.cols;
        for (let y = 0; y < this.rows; y++) {
            const base = this._liveRowBase[y];
            for (let i = base; i < base + cols; i++) {
                const b = this._bg[i];
                words[i] = b && fill ? (b & 0xffffff) | fill : 0;
            }
            this._renderer.markHighlightDirty(base, cols);
        }
    }

    /**
     * Live nudge of the background's set-back behind the text (the
     * `appearance.backgroundSetBack` dial) — a pure z shift by the delta; no relayout. See
     * CodeGrid.refreshBackground.
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
        this._bgGap ??= getBandDistance(LAYER_BAND.GRID_BACKGROUND);
        const layout = computeCellGridLayout(this.cols, this.rows, this._metrics, this._bgPadding, this._bgGap);
        this._background.scale.set(layout.width, layout.height, 1);
        this._background.position.set(layout.cx, layout.cy, layout.z);
    }
}

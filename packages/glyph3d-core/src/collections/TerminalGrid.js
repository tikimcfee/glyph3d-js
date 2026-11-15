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
 *   - the live rows are compared cell by cell with what their slots hold (canonical
 *     _cp/_fg/_bg/_at/_ul per physical cell): only the cells that differ are written, and only
 *     their per-row spans are uploaded (InstancedField.markSlotsDirty / markHighlightDirty /
 *     markDecorDirty);
 *   - nothing is allocated in steady state.
 *
 * What a cell draws (docs/architecture/terminals.md "Cells"): its glyph — in the bold, italic or
 * bold-italic face under SGR 1 / 3, a cell sprite for what a terminal draws itself, a base and
 * its combining marks as one glyph — in the terminal's font family and in the colour lane; its attributes'
 * style byte (dim, strike, overline, the underline style) in the spare bits of its group lane; an
 * underline's own colour in the field's decoration texel; its background as the highlight texel's
 * fill, which the field's fill pass draws under every cell's ink.
 *
 * Differs from CodeGrid:
 *   - No line-buffer history, no ANSI stripping
 *   - No GlyphCollection deferred queue, no _rebuildAllInstances() on update
 */

import * as THREE from 'three';
import InstancedField from './InstancedField.js';
import TerminalEmulator, { DEFAULT_FG, BOLD_IS_BRIGHT_DEFAULT } from './TerminalEmulator.js';
import TerminalScreenQueue from './TerminalScreenQueue.js';
import {
    detectVerticalScroll,
    layoutTerminalRows,
    ROW_LAYOUT_STRIDE,
    computeTerminalGlyphExtent,
} from './terminalDepthHistory.js';
import { SLOT_FLOATS, LANE_GLYPH_ID, LANE_COLOR, LANE_GROUP_ID, packGroupStyle } from '../core/InstancedSlotBuffer.js';
import { CELL_UNDERLINE_COLOR, FACE_COUNT, cellFace, cellStyle } from '../core/cellAttrs.js';
import {
    computeCellGridLayout,
    cellAtPoint,
    GridChrome,
    TERMINAL_CONTROL_SPEC,
    GridBlockCursor,
} from './grid/index.js';
import { RENDER_ORDER } from '../core/renderOrder.js';
import { LAYER_BAND, getBandDistance } from '../core/layerBands.js';
import FramedGlyphField from './FramedGlyphField.js';
import { createPanelMaterial } from './panelMaterial.js';
import { enrollPanel } from './PanelBatch.js';
import TerminalSelection, { TERMINAL_SELECTION_DEFAULTS } from './terminalSelection.js';

const _cellStrideScale = new THREE.Vector3(); // scratch for cellStride's world-scale read
const _packColor = new THREE.Color();          // scratch for _packedBackground

/** An sRGB colour (`#rrggbb`, a hex number) packed as the slot colour lane holds one (RGB888, red in the low byte). */
function packSrgb(color) {
    _packColor.set(color);
    const h = _packColor.getHex(THREE.SRGBColorSpace);
    return ((h >> 16) & 0xff) | (h & 0xff00) | ((h & 0xff) << 16);
}

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


/**
 * A pointer event for the program (termd's `mouse` op, docs/termd/PROTOCOL.md): `col`, `row` are
 * where the pointer is in cells from the top-left corner, from 0 (fractional: the cell is the whole
 * part, SGR-pixels reports read the fraction); `button` a name or X11's number for buttons 8–11;
 * `mods` W3C modifier names, as for a key event.
 * @typedef {{ action: 'press'|'release'|'move',
 *   button: 'left'|'middle'|'right'|'none'|'wheel-up'|'wheel-down'|'wheel-left'|'wheel-right'|8|9|10|11,
 *   col: number, row: number, mods?: string[] }} TerminalMouseEvent
 */

// Cursor block render order: above glyphs (0), below the window chrome (GRID_CHROME = 6) — the
// same band CodeGrid's caret uses. A compositing constant, not a taste knob, so it stays baked.
const CURSOR_RENDER_ORDER = 5;

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
     * @param {string|null} [options.fontFamily]  The font family the terminal draws in (an id of
     *   the atlas's font chain; default: the chain's default family). Live: setFontFamily.
     * @param {boolean} [options.boldIsBright]  Bold text in a standard colour draws in its bright
     *   twin (default BOLD_IS_BRIGHT_DEFAULT: off — bold is the bold face). Live: setBoldIsBright.
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
        // identity: callers say WHAT to send, never WHO is sending (see onInput).
        // NOT `this.id`: Object3D defines that as a non-writable numeric instance id
        // (Object.defineProperty, writable:false), so assigning it throws in strict mode.
        this.terminalId = options.id ?? null;

        // The font family the terminal draws in: its shape cache, its cell, its line metrics
        // (GlyphAtlas.fontFamily). The GPU attribute is `instanceGlyphId` (a slot of the font
        // chain, which indexes the Slug glyphMapTexture), NOT a Unicode codepoint: each cell's
        // content — a codepoint, or a cluster id — maps to its slot through the family's shape
        // cache, in the cell's face.
        /** @type {import('../GlyphAtlas.js').AtlasFontFamily} */
        this._fontFamily = atlas.fontFamily(options.fontFamily);
        this._shapeCache = this._fontFamily.shapeCache;

        // Per face (core/cellAttrs.js FACE_*), the cell contents already handed to the live Slug
        // atlas for curve encoding. Steady-state, every cell's content is already in its face's
        // set, so per-frame work is just a Set membership check — no calls into the encoder until
        // a genuinely new glyph (box-drawing, spinner star, a first bold letter, …) shows up.
        /** @type {Set<number>[]} */
        this._ensured = Array.from({ length: FACE_COUNT }, () => new Set());

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
        // (termd owns true scrollback and the emulator mirrors the visible screen only, so
        // there is no free "line scrolled off" event — we recover it by diffing frames; see
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
        // encoding: codepoint, packed fg, bg word (0 = no fill), attrs word, underline colour.
        // The slot buffer, the highlight texture and the decoration texture are its projection;
        // every write goes through _writeSpans / _writeSeqRows / _pushAll, which upload what
        // they wrote.
        this._ringStart = 0;
        /** Monotonic count of primary-screen rows observed scrolling off the top of this grid. */
        this.scrolledRows = 0;
        this._scrollBase = false;  // the live rows hold the last screen applied (a scroll may be diffed against them)
        /** @type {Uint32Array} */ this._cp = null;
        /** @type {Uint32Array} */ this._fg = null;
        /** @type {Uint32Array} */ this._bg = null;
        /** @type {Uint16Array} core/cellAttrs.js flags */ this._at = null;
        /** @type {Uint32Array} an underline's own colour */ this._ul = null;
        /** @type {Uint8Array} per physical row: some cell has a background */ this._rowHasBg = null;
        /** physical rows with a background: the field's fill pass draws while there is one */ this._bgRows = 0;
        /** some cell has named its underline's colour: the decoration texels exist */ this._hasDecor = false;
        /** @type {Int32Array} per physical row: its group-table row */ this._rowGroups = new Int32Array(0);
        /** @type {Float32Array} per sequence index: y, z, fade (layoutTerminalRows) */ this._rowLayout = null;
        /** @type {Int32Array} per live row: its first cell's physical index */ this._liveRowBase = null;
        // Per live row, this update's changed spans (first/last column; last < first = none):
        // glyph, color or style; background; underline colour. Scratch, reused every update.
        this._spanLo = this._spanHi = this._bgLo = this._bgHi = this._ulLo = this._ulHi = null;
        /** @type {number[][]} per face: cell contents first seen in it this update (empty in steady state) */
        this._fresh = Array.from({ length: FACE_COUNT }, () => []);
        this._screenQueued = false;   // waiting in the scene's TerminalScreenQueue

        /**
         * Input callback -- set by the owning agent or process. When set, every input this
         * terminal emits leaves through here, bound for the owning adapter and termd. Four
         * shapes, one per kind of input (sendInput / sendKey / paste / sendMouse):
         *   { bytes: string }   raw bytes, written as given (an emulator that encodes its own
         *                       keys: a 2D xterm companion)
         *   { key: TerminalKeyEvent }  a key event, which termd encodes in the program's modes
         *   { paste: string }   pasted text, which termd frames per the program's paste mode
         *   { mouse: TerminalMouseEvent }  a pointer event, which termd encodes in the program's
         *                       mouse modes
         * Signature: (input, terminalId: string) => void — the id is THIS grid's
         * `this.terminalId`, supplied by the grid, not by the caller.
         * @type {((input: {bytes?: string, key?: import('../services/interaction/keyEncoding.js').TerminalKeyEvent, paste?: string, mouse?: TerminalMouseEvent}, terminalId: string) => void)|null}
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
        this._applyFamilyToField();

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
        this._visible = true; // setVisible state — the row poses' alpha

        // ---- The text selection (terminalSelection.js) ----
        // Drawn through the cells it covers: their highlight texel takes the selection's colour (the
        // fill pass draws it like a cell background) and, unless the foreground is kept, their colour
        // lane its text colour. Per physical row, the selected columns [lo, hi) as last drawn: a
        // scroll that moves the ring carries them with their text, and a change rewrites only the
        // cells whose state moved.
        this._selection = new TerminalSelection(options.selectionWordChars ?? TERMINAL_SELECTION_DEFAULTS.wordChars);
        this._selWord = 0;     // a selected cell's highlight word
        this._selFg = -1;      // a selected cell's packed text colour; −1 keeps its own
        this._setSelectionColors(options.selectionColor ?? TERMINAL_SELECTION_DEFAULTS.background,
            options.selectionForeground === undefined ? TERMINAL_SELECTION_DEFAULTS.foreground : options.selectionForeground);
        /** @type {Int32Array} */ this._selLo = null;
        /** @type {Int32Array} */ this._selHi = null;
        this._selRows = 0;     // physical rows with a selected cell: the fill pass draws while there is one

        // The cells, blank, and every slot pushed. The glyphs and cell fills are opaque ink in the
        // colours the program gave, whatever the panel's opacity (a terminal's background opacity
        // is its background's).
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
        this._emulator.setDefaultBackground(this._packedBackground());
        this._emulator.setBoldIsBright(options.boldIsBright ?? BOLD_IS_BRIGHT_DEFAULT);

        /**
         * The window title the terminal's program last set (OSC 0/2: the shell's prompt path or the
         * running command; termd repeats it in every repaint). Empty until one arrives.
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
        let selMoved = false;
        if (this._depthEnabled && !alt && this._scrollBase) {
            const k = detectVerticalScroll(this._cp, this._liveRowBase, screen.cp, rows, cols);
            if (k > 0) {
                this._scrollRing(k);
                repose = true;
                // The selection rides its text up (its rows' spans moved with the ring); any of it
                // scrolled off the top drops it.
                if (this._selection.active && !this._selection.shift(k)) selMoved = true;
            }
        }

        this._diffLive(screen);
        // A selected cell rewritten (its text, attributes or colour) drops the selection.
        if (this._selRows && this._selectionTouched()) { this._selection.clear(); selMoved = true; }
        if (selMoved) this._paintSelection();
        this._ensureFresh();
        this._writeSpans();
        this._showFills();
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
            this._bgRows--;
        }
        this._ringStart = (this._ringStart + k) % P;
        this.scrolledRows += k;
        this._indexLiveRows();
    }

    /** The live cursor's viewport row (0 = top row). */
    get cursorRow() { return this._cursor.y; }

    /** Whether the current frame is on the alternate screen (no primary scrollback). */
    get altScreen() { return this._altActive; }

    /** @private Each live row's first physical cell, for the ring's current head. */
    _indexLiveRows() {
        const rows = this.rows, cols = this.cols, D = this._depthMax, P = rows + D;
        for (let y = 0; y < rows; y++) this._liveRowBase[y] = ((this._ringStart + D + y) % P) * cols;
    }

    /**
     * Compare the screen with the live rows' canonical cells, copy what differs, and record each
     * row's changed span (glyph/color/style, background, underline colour). Contents first seen
     * in a face go to that face's _fresh list, for the atlas.
     * @private
     */
    _diffLive(screen) {
        const cols = this.cols, rows = this.rows;
        const CP = this._cp, FG = this._fg, BG = this._bg, AT = this._at, UL = this._ul;
        const sCP = screen.cp, sFG = screen.fg, sBG = screen.bg, sAT = screen.at, sUL = screen.ul;
        const lo = this._spanLo, hi = this._spanHi, blo = this._bgLo, bhi = this._bgHi, ulo = this._ulLo, uhi = this._ulHi;
        const ensured = this._ensured, fresh = this._fresh;
        const ensure = !!this.atlas._live;
        for (let y = 0; y < rows; y++) {
            const base = this._liveRowBase[y];
            let l = cols, h = -1, bl = cols, bh = -1, ul = cols, uh = -1, anyBg = 0;
            for (let x = 0, si = y * cols, i = base; x < cols; x++, si++, i++) {
                const c = sCP[si], f = sFG[si], b = sBG[si], a = sAT[si];
                if (c !== CP[i] || a !== AT[i]) {
                    CP[i] = c; FG[i] = f; AT[i] = a;
                    if (l === cols) l = x;
                    h = x;
                    if (ensure && c > 32) {
                        const face = cellFace(a), seen = ensured[face];
                        if (!seen.has(c)) { seen.add(c); fresh[face].push(c); }
                    }
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
                if ((a & CELL_UNDERLINE_COLOR) && sUL[si] !== UL[i]) {
                    UL[i] = sUL[si];
                    if (ul === cols) ul = x;
                    uh = x;
                }
            }
            lo[y] = l; hi[y] = h; blo[y] = bl; bhi[y] = bh; ulo[y] = ul; uhi[y] = uh;
            const p = base / cols;
            this._bgRows += anyBg - this._rowHasBg[p];
            this._rowHasBg[p] = anyBg;
        }
    }

    /**
     * Write the live rows' changed spans into the slot buffer (glyph id, color, style), the
     * highlight texture (the cell background as a fill) and the decoration texture (an underline's
     * own colour), and mark exactly those spans for upload.
     * @private
     */
    _writeSpans() {
        const rows = this.rows, cols = this.cols;
        const field = this._renderer;
        const f32 = field.slotBuffer.f32;
        const CP = this._cp, FG = this._fg, BG = this._bg, AT = this._at;
        const lo = this._spanLo, hi = this._spanHi, blo = this._bgLo, bhi = this._bgHi, ulo = this._ulLo, uhi = this._ulHi;
        const selFg = this._selFg, selWord = this._selWord;
        let words = null, fill = 0, decor = null;
        for (let y = 0; y < rows; y++) {
            const base = this._liveRowBase[y];
            const l = lo[y], h = hi[y];
            const p = base / cols, sl = base + this._selLo[p], sh = base + this._selHi[p];
            if (h >= l) {
                const group = this._rowGroups[p];
                for (let i = base + l, end = base + h; i <= end; i++) {
                    const o = i * SLOT_FLOATS, a = AT[i];
                    f32[o + LANE_GLYPH_ID] = this._glyphId(CP[i], a);
                    f32[o + LANE_COLOR] = selFg >= 0 && i >= sl && i < sh ? selFg : FG[i];
                    f32[o + LANE_GROUP_ID] = a === 0 ? group : packGroupStyle(group, cellStyle(a));
                    // The first cell to name an underline colour (even one equal to a blank texel's).
                    if ((a & CELL_UNDERLINE_COLOR) && !this._hasDecor) decor = this._decorWords();
                }
                field.markSlotsDirty(base + l, h - l + 1);
            }
            const bl = blo[y], bh = bhi[y];
            if (bh >= bl) {
                if (!words) { words = this._highlightWords(); fill = this._fillAlphaBits(); }
                for (let i = base + bl, end = base + bh; i <= end; i++) {
                    const b = BG[i];
                    words[i] = i >= sl && i < sh ? selWord : b && fill ? (b & 0xffffff) | fill : 0;
                }
                field.markHighlightDirty(base + bl, bh - bl + 1);
            }
            const ul = ulo[y], uh = uhi[y];
            if (uh >= ul) {
                if (!decor) { decor = this._decorWords(); }
                for (let i = base + ul, end = base + uh; i <= end; i++) decor[i] = this._ul[i];
                field.markDecorDirty(base + ul, uh - ul + 1);
            }
        }
    }

    /**
     * @private The decoration texels (an underline's own colour), one RGBA8 word per slot. Made
     * the first time a cell names an underline colour: every texel is then written from the
     * canonical cells, so they stay each other's mirror.
     */
    _decorWords() {
        const words = this._renderer.decorWords(this._totalCount);
        if (!this._hasDecor) {
            this._hasDecor = true;
            words.set(this._ul.subarray(0, this._totalCount));
            words.fill(0, this._totalCount);
            this._renderer.markDecorDirty();
        }
        return words;
    }

    /** @private The field's fill pass draws while some row has a background (and fills are on). */
    _showFills() {
        this._renderer.fillsActive = (this._bgRows > 0 && this._bgFillOpacity > 0) || this._selRows > 0;
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
     * (_rowLayout), its fade, and its alpha — 1, 0 while hidden, and for history also 0 while
     * depth history is off or an alt-screen app has the terminal.
     * @private
     */
    _poseRows() {
        const field = this._renderer, L = this._rowLayout, G = this._rowGroups;
        const D = this._depthMax, P = this.rows + D, start = this._ringStart;
        const shown = this._visible ? 1 : 0;
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
        const CP = this._cp, FG = this._fg, AT = this._at, selFg = this._selFg;
        let runStart = -1, runEnd = -1;
        for (let s = s0; s < s0 + n; s++) {
            const p = (this._ringStart + s) % P;
            const base = p * cols;
            const group = this._rowGroups[p];
            const sl = base + this._selLo[p], sh = base + this._selHi[p];
            for (let i = base; i < base + cols; i++) {
                const o = i * SLOT_FLOATS, a = AT[i];
                f32[o + LANE_GLYPH_ID] = this._glyphId(CP[i], a);
                f32[o + LANE_COLOR] = selFg >= 0 && i >= sl && i < sh ? selFg : FG[i];
                f32[o + LANE_GROUP_ID] = a === 0 ? group : packGroupStyle(group, cellStyle(a));
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
            this._at.fill(0, base, base + cols);
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
     * Seed the depth history from EXTERNAL scrollback (termd's capture),
     * NEWEST-FIRST. Forward-capture (the frame diff) only sees lines that scroll off
     * from now on; this back-fills the history that already exists — so the session's
     * accumulated scrollback shows receding in depth immediately, and a re-seed after
     * a reload restores it (termd is the durable source; the ring is in-memory).
     *
     * Each string becomes one history line (one codepoint per column, padded/truncated
     * to cols) at the default foreground color; normal depth fade + placement apply.
     * Glyphs not yet in the live atlas are requested first. Lines past _depthMax are
     * dropped (only that many slots render). Replaces the current history; later
     * forward-captures push in front of the seed seamlessly.
     * @param {string[]} lines  scrollback rows, newest first
     */
    seedHistory(lines) {
        const D = this._depthMax;
        if (D === 0) return;
        const cols = this.cols, P = this.rows + D;
        const n = Math.min(lines.length, D);
        const live = this.atlas._live;
        const seen = this._ensured[0], fresh = this._fresh[0];

        for (let h = 0; h < D; h++) {
            const base = ((this._ringStart + D - 1 - h) % P) * cols;
            this._cp.fill(32, base, base + cols);
            this._fg.fill(DEFAULT_FG, base, base + cols);
            this._at.fill(0, base, base + cols);
            if (h >= n) continue;
            let x = 0;
            for (const ch of lines[h] || '') {   // iterate by code point (surrogate-safe)
                if (x >= cols) break;
                const code = ch.codePointAt(0);
                this._cp[base + x] = code;
                if (live && code > 32 && !seen.has(code)) {
                    seen.add(code);
                    fresh.push(code);
                }
                x++;
            }
        }
        this._ensureFresh();
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

    // ================================================================
    // Text selection (terminalSelection.js) — drawn through the cells' fills
    // ================================================================
    //
    // A selection lives on the screen it was made on (screen cells, row 0 on top; the text read from
    // the emulator, the same buffer the glyphs render from). It lasts until it is cleared, the
    // terminal resizes, a selected cell is rewritten (its text, attributes or colour), or output
    // scrolls any of it off the top — a scroll short of that carries it up with its text. Every
    // change rewrites only the cells whose selected state moved, and uploads only them; nothing is
    // allocated per change.

    /** Whether some cell is selected. */
    get hasSelection() {
        return !this._selection.empty;
    }

    /**
     * The selection as a verb reports it, or null with none: its mode, whether a block, and the
     * cell boundaries it runs between — a stream from `start` to `end` (end exclusive), a block's
     * rows start.row … end.row and columns [start.col, end.col).
     * @returns {{ mode: import('./terminalSelection.js').SelectionMode, block: boolean,
     *   start: { col: number, row: number }, end: { col: number, row: number } }|null}
     */
    get selection() {
        const s = this._selection;
        if (s.empty) return null;
        return { mode: s.mode, block: s.block, start: { col: s.c0, row: s.r0 }, end: { col: s.c1, row: s.r1 } };
    }

    /**
     * Start a selection at a point in cells (cellAt's `x`, `y`); in word or line mode the word or
     * line there is selected at once. Returns whether the selection drawn changed.
     * @param {number} x @param {number} y
     * @param {{ mode?: import('./terminalSelection.js').SelectionMode, block?: boolean }} [o]
     */
    selectStart(x, y, o) {
        if (!this._emulator) return false;
        this._selection.start(this._emulator, x, y, o);
        return this._paintSelection();
    }

    /**
     * Move the selection's head to a point in cells (its anchor stays). Returns whether it changed;
     * a pointer move to the same boundary writes nothing.
     * @param {number} x @param {number} y
     */
    selectExtend(x, y) {
        if (!this._emulator || !this._selection.extend(this._emulator, x, y)) return false;
        return this._paintSelection();
    }

    /**
     * Select exactly the cells between two boundaries (a stream, end exclusive, or a block), clamped
     * to the screen.
     * @param {number} col0 @param {number} row0 @param {number} col1 @param {number} row1
     * @param {{ block?: boolean }} [o]
     */
    selectCells(col0, row0, col1, row1, o) {
        if (!this._emulator) return false;
        this._selection.set(this._emulator, col0, row0, col1, row1, o);
        return this._paintSelection();
    }

    /** Drop the selection (nothing to do with none). */
    clearSelection() {
        if (!this._selection.active) return false;
        this._selection.clear();
        return this._paintSelection();
    }

    /**
     * The selected text: each line's trailing blanks trimmed, soft wraps joined, hard line ends kept
     * as \n, wide characters and clusters as their text ('' with nothing selected).
     * @returns {string}
     */
    selectionText() {
        return this._emulator ? this._selection.text(this._emulator) : '';
    }

    /**
     * How the selection draws and what a double-click's word is, live: `background` its cells' fill
     * colour, `foreground` their text's (null: each keeps its own), `wordChars` what ends a word
     * besides whitespace. Colours are sRGB (`#rrggbb` or a hex number). All optional.
     * @param {{ background?: string|number, foreground?: string|number|null, wordChars?: string }} style
     */
    setSelectionStyle({ background, foreground, wordChars } = {}) {
        if (wordChars !== undefined) this._selection.setWordChars(wordChars);
        if (background === undefined && foreground === undefined) return;
        const fgWas = this._selFg;
        this._setSelectionColors(background ?? this._selBackground, foreground === undefined ? this._selForeground : foreground);
        // Rewrite the selected cells in the new colours (and, where the foreground stopped or started
        // being kept, their text colour).
        const cols = this.cols, P = this.rows + this._depthMax, field = this._renderer, f32 = field.slotBuffer.f32;
        const words = this._selRows ? this._highlightWords() : null;
        for (let p = 0; p < P && words; p++) {
            const lo = this._selLo[p], hi = this._selHi[p];
            if (hi <= lo) continue;
            const base = p * cols;
            words.fill(this._selWord, base + lo, base + hi);
            field.markHighlightDirty(base + lo, hi - lo);
            if (fgWas < 0 && this._selFg < 0) continue;
            for (let i = base + lo; i < base + hi; i++) f32[i * SLOT_FLOATS + LANE_COLOR] = this._selFg >= 0 ? this._selFg : this._fg[i];
            field.markSlotsDirty(base + lo, hi - lo);
        }
    }

    /** @private The packed selection colours (the highlight word: opaque). */
    _setSelectionColors(background, foreground) {
        this._selBackground = background;
        this._selForeground = foreground;
        this._selWord = (packSrgb(background) | (InstancedField.encodeHighlightAlpha(1) << 24)) >>> 0;
        this._selFg = foreground == null ? -1 : packSrgb(foreground);
    }

    /**
     * @private Whether this update rewrote a selected cell: some live row's changed span (glyph,
     * attributes, colour — _diffLive's) meets its selected columns.
     */
    _selectionTouched() {
        const cols = this.cols, lo = this._spanLo, hi = this._spanHi;
        for (let y = 0; y < this.rows; y++) {
            if (hi[y] < lo[y]) continue;
            const p = this._liveRowBase[y] / cols, sl = this._selLo[p], sh = this._selHi[p];
            if (sh > sl && lo[y] < sh && hi[y] >= sl) return true;
        }
        return false;
    }

    /**
     * @private Draw the selection as it now stands: per physical row, the columns it selects; a row
     * whose columns moved has the cells between the old and the new rewritten — highlight texel, and
     * colour lane unless the foreground is kept — and only those uploaded. Returns whether any did.
     */
    _paintSelection() {
        const sel = this._selection, cols = this.cols, D = this._depthMax, P = this.rows + D;
        let rowsOn = 0, changed = false;
        for (let s = 0; s < P; s++) {
            const p = (this._ringStart + s) % P, y = s - D;
            let lo = 0, hi = 0;
            if (y >= 0) { lo = sel.lo(y); hi = sel.hi(y, cols); if (hi <= lo) lo = hi = 0; }
            if (hi > lo) rowsOn++;
            const olo = this._selLo[p], ohi = this._selHi[p];
            if (lo === olo && hi === ohi) continue;
            this._selLo[p] = lo; this._selHi[p] = hi;
            changed = true;
            // The cells whose state moved: the two spans' difference — one or two runs.
            const base = p * cols;
            if (ohi <= olo) this._paintRun(base, lo, hi, lo, hi);
            else if (hi <= lo || hi <= olo || ohi <= lo) { this._paintRun(base, olo, ohi, lo, hi); this._paintRun(base, lo, hi, lo, hi); }
            else { this._paintRun(base, Math.min(lo, olo), Math.max(lo, olo), lo, hi); this._paintRun(base, Math.min(hi, ohi), Math.max(hi, ohi), lo, hi); }
        }
        this._selRows = rowsOn;
        this._showFills();
        return changed;
    }

    /**
     * @private Rewrite cells [a, b) of the physical row at `base` for a selection of [lo, hi) there:
     * highlight texel, and colour lane unless the foreground is kept; mark them for upload.
     */
    _paintRun(base, a, b, lo, hi) {
        if (b <= a) return;
        const field = this._renderer, f32 = field.slotBuffer.f32, words = this._highlightWords(), fill = this._fillAlphaBits();
        const BG = this._bg, FG = this._fg, selWord = this._selWord, selFg = this._selFg;
        for (let x = a, i = base + a; x < b; x++, i++) {
            const on = x >= lo && x < hi, bg = BG[i];
            words[i] = on ? selWord : bg && fill ? (bg & 0xffffff) | fill : 0;
            if (selFg >= 0) f32[i * SLOT_FLOATS + LANE_COLOR] = on ? selFg : FG[i];
        }
        field.markHighlightDirty(base + a, b - a);
        if (selFg >= 0) field.markSlotsDirty(base + a, b - a);
    }

    /**
     * Whether the program in this terminal turned mouse reporting on: its clicks are then the
     * program's (the wall's right-click menu, for one, steps aside on a focused terminal).
     * @returns {boolean}
     */
    get mouseReporting() {
        return this._emulator ? this._emulator.mouseReporting : false;
    }

    /**
     * Which pointer events the program asked to hear, in the bytes parsed so far: `'none'`,
     * `'x10'` (9: presses), `'normal'` (1000: presses and releases), `'button'` (1002: and moves
     * with a button held), `'any'` (1003: and every move). termd encodes what it is sent against
     * its own copy of the modes, so this only saves sending what the program would never hear.
     * @returns {'none'|'x10'|'normal'|'button'|'any'}
     */
    get mouseTracking() {
        return this._emulator ? this._emulator.mouseTracking : 'none';
    }

    /**
     * The cell under a point in this grid's own frame (its local coordinates: position and scale
     * taken off) — the cells' own geometry, computeCellGridLayout's: `x`, `y` in cells from the
     * top-left corner, clamped to the grid; `col`, `row` the cell, from 0.
     * @param {number} x @param {number} y
     * @param {{x:number, y:number, col:number, row:number}} [out] - filled and returned (no allocation)
     * @returns {{x:number, y:number, col:number, row:number}}
     */
    cellAt(x, y, out) {
        return cellAtPoint(this.cols, this.rows, this._metrics, x, y, out);
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
     * INPUT entry for raw bytes — the twin of writeBytes. Hand the terminal bytes and it emits
     * them through its owner's callback, stamped with its own id, to be written to the program as
     * given. For a surface that encodes its own keys (a 2D companion xterm) and for scripted
     * input; the keyboard sends key events (sendKey) and the clipboard pastes (paste).
     *
     * @param {string} bytes - raw terminal input bytes
     * @returns {boolean} true if an owner was listening and took them
     */
    sendInput(bytes) {
        if (typeof this.onInput !== 'function' || !bytes) return false;
        this.onInput({ bytes }, this.terminalId);
        return true;
    }

    /**
     * A key event (keyEncoding.keyEventFor) for the program. termd encodes it in the program's
     * live keyboard modes (Kitty keyboard, modifyOtherKeys, application cursor keys) — the grid
     * never turns keys into bytes itself, because only termd knows those modes when it matters.
     *
     * @param {import('../services/interaction/keyEncoding.js').TerminalKeyEvent} key
     * @returns {boolean} true if an owner was listening and took it
     */
    sendKey(key) {
        if (typeof this.onInput !== 'function' || !key) return false;
        this.onInput({ key }, this.terminalId);
        return true;
    }

    /**
     * Paste text. termd frames it as Ghostty does: in `ESC [ 200 ~` … `ESC [ 201 ~` when the
     * program asked for bracketed paste (mode 2004), else with each newline sent as CR, the Enter
     * key; either way with ESC and the other control bytes xterm strips made spaces, so pasted
     * text can't close the bracket early and run its remainder as keystrokes.
     *
     * @param {string} text - plain clipboard text
     * @returns {boolean} true if it was sent
     */
    paste(text) {
        if (typeof this.onInput !== 'function' || typeof text !== 'string' || text === '') return false;
        this.onInput({ paste: text }, this.terminalId);
        return true;
    }

    /**
     * A pointer event for the program (a press, a release, a move). termd encodes it in the
     * program's live mouse modes (tracking, format) and drops what they don't report, as a
     * terminal does — the grid never turns the pointer into bytes itself.
     *
     * @param {TerminalMouseEvent} mouse
     * @returns {boolean} true if an owner was listening and took it
     */
    sendMouse(mouse) {
        if (typeof this.onInput !== 'function' || !mouse) return false;
        this.onInput({ mouse }, this.terminalId);
        return true;
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
     * applyView reports `resized` so the caller that DOES hold the bridge can match it (termd
     * resize → SIGWINCH), exactly as terminal.resize does.
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
     * stage), folded in _poseRows.
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
     * terminals clip scrollback on resize, and termd holds the durable copy that
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
            this._renderer.dispose();   // its mesh, both passes' materials, its tables and textures; off the live-field lists
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
     * @returns {{cols:number, rows:number, depthMax:number, cp:Uint32Array, fg:Uint32Array, bg:Uint32Array, at:Uint16Array, ul:Uint32Array}|null}
     */
    _sequenceSnapshot() {
        if (!this._cp) return null;
        const cols = this.cols, rows = this.rows, D = this._depthMax, P = rows + D;
        const cp = new Uint32Array(P * cols), fg = new Uint32Array(P * cols), bg = new Uint32Array(P * cols);
        const at = new Uint16Array(P * cols), ul = new Uint32Array(P * cols);
        for (let s = 0; s < P; s++) {
            const from = ((this._ringStart + s) % P) * cols;
            cp.set(this._cp.subarray(from, from + cols), s * cols);
            fg.set(this._fg.subarray(from, from + cols), s * cols);
            bg.set(this._bg.subarray(from, from + cols), s * cols);
            at.set(this._at.subarray(from, from + cols), s * cols);
            ul.set(this._ul.subarray(from, from + cols), s * cols);
        }
        return { cols, rows, depthMax: D, cp, fg, bg, at, ul };
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
        this._at = new Uint16Array(n);
        this._ul = new Uint32Array(n);
        this._rowHasBg = new Uint8Array(P);
        this._bgRows = 0;
        // A reallocation (a resize, a new depth) moves every cell: the selection goes.
        this._selection.clear();
        this._selLo = new Int32Array(P);
        this._selHi = new Int32Array(P);
        this._selRows = 0;
        this._hasDecor = false;   // _pushAll rewrites the decoration texels if any cell needs them
        this._ringStart = 0;
        this._liveRowBase = new Int32Array(rows);
        this._spanLo = new Int32Array(rows);
        this._spanHi = new Int32Array(rows);
        this._bgLo = new Int32Array(rows);
        this._bgHi = new Int32Array(rows);
        this._ulLo = new Int32Array(rows);
        this._ulHi = new Int32Array(rows);
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
            this._at.set(keep.at.subarray(from, from + w), to);
            this._ul.set(keep.ul.subarray(from, from + w), to);
            if (!withBg) return;
            this._bg.set(keep.bg.subarray(from, from + w), to);
            for (let x = 0; x < w; x++) if (this._bg[to + x]) { this._rowHasBg[toSeq] = 1; this._bgRows++; break; }
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
        const selFg = this._selFg;
        for (let p = 0; p < P; p++) {
            const g = this._rowGroups[p], sl = this._selLo[p], sh = this._selHi[p];
            for (let x = 0, i = p * cols; x < cols; x++, i++) {
                const a = this._at[i];
                sb.setSlot(i, x * strideX, 0, 0, this._glyphId(this._cp[i], a), selFg >= 0 && x >= sl && x < sh ? selFg : this._fg[i],
                    a === 0 ? g : packGroupStyle(g, cellStyle(a)), m.charWidth, m.charHeight);
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
        for (let p = 0; p < P; p++) words.fill(this._selWord, p * cols + this._selLo[p], p * cols + Math.max(this._selLo[p], this._selHi[p]));
        field.markHighlightDirty();
        this._showFills();
        // The decoration texels, where some cell names its underline's colour.
        for (let i = 0; i < count; i++) {
            if (this._at[i] & CELL_UNDERLINE_COLOR) { this._decorWords(); break; }
        }

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
     * A cell's glyph for the instanceGlyphId attribute: its content (a codepoint, or a cluster
     * id) through the family's shape cache (O(1); the font chain on a miss), in the face its
     * attributes ask for — bold (SGR 1), italic (SGR 3) or both; a font with no such face draws
     * its upright.
     * @private
     * @param {number} codepoint  the cell's content
     * @param {number} [attrs=0]  the cell's attrs word (core/cellAttrs.js)
     * @returns {number}
     */
    _glyphId(codepoint, attrs = 0) {
        return this._shapeCache.lookupFace(codepoint, cellFace(attrs)).g;
    }

    /**
     * Ask the live Slug atlas for the glyphs this terminal is about to draw for the first time
     * (the _fresh lists, per face), before their slots are written, and empty the lists.
     *
     * Each new content is routed through the font chain and gets its slot synchronously (the slot
     * never moves); its outline is encoded in a worker and lands in the shared textures a frame
     * or two later. Until then the glyph-map texel is zero and the cell draws its background with
     * no ink; when it lands only the textures change, so the cell needs no rewrite. The lists hold
     * only contents this terminal has never drawn in that face (its `_ensured` sets): a cell
     * whose content didn't change was ensured when it first did, so a screen update hands over
     * nothing at all in steady state.
     * @private
     */
    _ensureFresh() {
        const live = this.atlas._live;
        for (let face = 0; face < FACE_COUNT; face++) {
            const fresh = this._fresh[face];
            if (!fresh.length) continue;
            if (live) {
                // ensureGlyphsEncoded dedups globally (its encoded set), so glyphs another grid
                // already asked for are a cheap no-op here.
                const gids = [], provenance = new Map();
                for (const cp of fresh) {
                    const g = this._shapeCache.lookupFace(cp, face).g;
                    if (g > 0) { gids.push(g); if (!provenance.has(g)) provenance.set(g, cp); }
                }
                live.ensureGlyphsEncoded(gids, provenance);
            }
            fresh.length = 0;
        }
    }

    /**
     * The font family this terminal draws in (GlyphAtlas.fontFamily).
     * @returns {string|null} its id (null: a chain that names no families)
     */
    get fontFamily() {
        return this._fontFamily.id;
    }

    /**
     * Draw the terminal in another font family of the atlas's chain, live: its cells take the
     * family's cell (so the terminal's size on the canvas changes; cols × rows stay), every
     * glyph is rewritten in the family — faces, sprites and clusters included — and its lines
     * sit where the family's font puts them. The size-change tap fires (the size moved, though
     * cols × rows did not), so whoever lays things out around the terminal follows.
     * @param {string|null} id  a family id of the chain (null: its default family); unknown throws
     */
    setFontFamily(id) {
        const family = this.atlas.fontFamily(id);
        if (family === this._fontFamily) return;
        this._fontFamily = family;
        this._shapeCache = family.shapeCache;
        this._applyFamilyToField();
        this._metrics = this._renderer.metrics;
        this._depthYStep = this._metrics.lineSpacing * this._depthYFactor;
        this._depthZStep = this._metrics.lineSpacing * this._depthZFactor;
        this._localBoundsDirty = true;

        // Every glyph the cells hold, asked of the atlas in the new family.
        for (const seen of this._ensured) seen.clear();
        if (this.atlas._live) {
            const CP = this._cp, AT = this._at;
            for (let i = 0, n = CP.length; i < n; i++) {
                const c = CP[i];
                if (c <= 32) continue;
                const face = cellFace(AT[i]), seen = this._ensured[face];
                if (!seen.has(c)) { seen.add(c); this._fresh[face].push(c); }
            }
            this._ensureFresh();
        }

        this._layoutRows();
        this._pushAll();
        this._updateBackground();
        // The chrome and the cursor follow the cell (the control pills keep the height they were built at).
        if (this._chrome) this._chrome.metrics = this._metrics;
        this._layoutControls();
        this._registerControls();
        if (this._cursorBlock) this._cursorBlock.metrics = this._metrics;
        this._updateCursorMesh();
        this._emitResize(this.cols, this.rows);
    }

    /** @private Give the field the family's cell and line metrics (the default family's are the field's own defaults). */
    _applyFamilyToField() {
        const own = this._fontFamily.index !== 0;
        this._renderer.setCharSize(own ? this._fontFamily.charSize : null);
        this._renderer.setLineMetrics(own ? this._fontFamily.lineMetrics : null);
    }

    /**
     * Whether bold text in one of the eight standard colours draws in its bright twin
     * (TerminalEmulator.setBoldIsBright; off by default — bold is the bold face). Live: the next
     * frame redraws the screen with it.
     * @param {boolean} on
     */
    setBoldIsBright(on) {
        this._emulator?.setBoldIsBright(on);
    }

    // ================================================================
    // Private: Background
    // ================================================================

    /** @private The panel's colour, packed as the slot colour lane holds one (RGB888, red in the low byte). */
    _packedBackground() {
        return packSrgb(this._bgColor);
    }

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
        if (color != null) {
            this._bgColor = color;
            this._emulator?.setDefaultBackground(this._packedBackground());   // what inverse text draws in
        }
        if (opacity != null) this._bgOpacity = opacity;
        if (cellBgFillOpacity != null && cellBgFillOpacity !== this._bgFillOpacity) {
            this._bgFillOpacity = cellBgFillOpacity;
            this._rewriteFills();
        }
        if (!this._panel) return;
        this._panel.setFill(color, opacity);
    }

    /** @private Rewrite every live cell's background fill (the fill opacity changed). */
    _rewriteFills() {
        const words = this._highlightWords(), fill = this._fillAlphaBits(), cols = this.cols;
        for (let y = 0; y < this.rows; y++) {
            const base = this._liveRowBase[y], p = base / cols, sl = base + this._selLo[p], sh = base + this._selHi[p];
            for (let i = base; i < base + cols; i++) {
                const b = this._bg[i];
                words[i] = i >= sl && i < sh ? this._selWord : b && fill ? (b & 0xffffff) | fill : 0;
            }
            this._renderer.markHighlightDirty(base, cols);
        }
        this._showFills();
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

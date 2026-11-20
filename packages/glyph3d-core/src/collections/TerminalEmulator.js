/**
 * TerminalEmulator — a headless VT emulator (@xterm/headless) that turns a raw byte
 * stream into a TerminalScreen our renderer can draw.
 *
 * This is the byte→screen SOURCE for a terminal viewport. TerminalGrid stays a pure
 * cell renderer (applyScreen is its input); the emulator is one source feeding it
 * (file-slice and graphics surfaces are other sources, later). We do NOT write a VT
 * parser — xterm interprets the program's own byte stream, relayed by termd (cursor addressing,
 * scroll regions, erase, SGR) into a cell grid; we read that grid.
 *
 * Pull, not push: term.write() parses asynchronously; its callback only marks the screen
 * dirty and tells the owner (`onDirty`). The owner reads the screen once, in the frame,
 * before that frame's render (TerminalGrid queues itself on its scene's TerminalScreenQueue,
 * which SceneSystems.update flushes) — any number of writes between two frames coalesce into
 * one read, and a write parsed before a frame is drawn by that frame.
 *
 * The read allocates nothing: it fills one reused TerminalScreen (typed arrays, sized to the
 * reader's cols × rows) from xterm's buffer lines through one reused cell. Colors arrive
 * PACKED the way the slot buffer's color lane holds them (RGB888, red in the low byte), as
 * DRAWN — inverse already swapped, bold's bright twin already taken where `boldIsBright` asks
 * for it — so the renderer compares and copies integers.
 *
 * TerminalScreen (what readScreen fills and applyScreen consumes):
 *   { cols, rows,
 *     cp: Uint32Array  — the cell's content, row-major: its codepoint, or — a cell holding a
 *                        base and combining marks (`e` + U+0301) — its cluster id
 *                        (core/cellClusters.js: a number above every codepoint, interned once
 *                        per distinct cluster); 0 (empty, a wide char's trailing slot) reads as
 *                        32, a space, and so does a concealed cell (SGR 8),
 *     fg: Uint32Array  — the packed colour the text draws in (RGB888, r low byte): the
 *                        foreground — with `boldIsBright`, a bold cell in one of the eight
 *                        standard colours takes its bright twin; under inverse (SGR 7) the
 *                        background (the terminal's own, setDefaultBackground, where the cell
 *                        names none),
 *     bg: Uint32Array  — 0 for the DEFAULT background (no per-cell fill), else BG_SET | the packed
 *                        RGB888 the cell fills with: an explicit ANSI background, or under
 *                        inverse the foreground,
 *     at: Uint16Array  — the cell's attributes, core/cellAttrs.js's flags word (bold, dim,
 *                        italic, blink, inverse, conceal, strike, overline, the underline style,
 *                        whether the underline has its own colour) — as the program set them,
 *     ul: Uint32Array  — the underline's own colour, packed like fg (SGR 58; meaningful where
 *                        `at` has CELL_UNDERLINE_COLOR, else 0),
 *     alt: boolean     — the alternate screen is active (full-screen TUIs),
 *     cursorX, cursorY — the VIEWPORT-relative cell the terminal would draw its caret on }
 */

// Deep import of the real ESM build: @xterm/headless@6's package.json "module" field
// points at a non-existent "lib/xterm.mjs" (only lib-headless/ ships), so the bare
// specifier fails to resolve under Vite/rollup. The concrete .mjs is the headless ESM
// entry and exports { Terminal }. Do NOT "simplify" this back to '@xterm/headless'.
import { Terminal } from '@xterm/headless/lib-headless/xterm-headless.mjs';
import { RESET_FG, ansi256toRGB } from './terminalPalette.js';
import { isWideCodepoint } from './terminalWidths.js';
import { clusterId } from '../core/cellClusters.js';
import {
    CELL_BOLD, CELL_DIM, CELL_ITALIC, CELL_BLINK, CELL_INVERSE, CELL_CONCEAL, CELL_STRIKE, CELL_OVERLINE,
    CELL_UNDERLINE_SHIFT, CELL_UNDERLINE_COLOR, UNDERLINE,
} from '../core/cellAttrs.js';

/** Marks a TerminalScreen bg word as an explicit background (the low 24 bits are its RGB888). */
export const BG_SET = 0x1000000;

/** A 0..1 channel as the slot buffer's byte: round(v × 255). */
const byteOf = (v) => (v * 255 + 0.5) | 0;
/** Pack 0..1 RGB the way the slot color lane holds it (r in the low byte). */
const pack = (r, g, b) => (byteOf(r) & 0xff) | ((byteOf(g) & 0xff) << 8) | ((byteOf(b) & 0xff) << 16);

// The palette and the default fg, packed once, so a read does no float work and allocates no
// color objects.
const PALETTE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    const c = ansi256toRGB(i);
    PALETTE[i] = pack(c.r, c.g, c.b);
}
const RESET = pack(RESET_FG.r, RESET_FG.g, RESET_FG.b);

/**
 * Whether bold text in one of the eight standard colours (SGR 30–37) draws in its bright twin
 * (90–97) — the old way to show bold with no bold face. Off by default, as Ghostty's
 * `bold-is-bright` is: bold is the bold FACE (core/cellAttrs.js `cellFace`) and the colour is
 * the one the program named. Per emulator: `setBoldIsBright`.
 */
export const BOLD_IS_BRIGHT_DEFAULT = false;

/**
 * The scrollback lines an xterm mirroring a termd screen keeps: one, never none. termd owns the
 * scrollback (a scrolled-back view comes as a repaint), so the screen is the buffer's last `rows`
 * lines and the extra line is never read. It exists because xterm reflows the normal buffer on any
 * column change and its reflow assumes room above the screen: with none, a shrink over
 * soft-wrapped lines puts the screen's base past the buffer's end, the next row grow leaves a
 * screen row with no line, and a line feed onto it throws inside xterm's parse — which stops its
 * write loop for good (every later write only queues), freezing the terminal while its program
 * runs on.
 */
export const EMULATOR_SCROLLBACK = 1;

/** The packed default foreground — what a blank cell (and a padded one) carries. */
export const DEFAULT_FG = RESET;

/**
 * An xterm true-color value (0xRRGGBB) packed red-low.
 * @param {number} c @returns {number}
 */
const rgbOf = (c) => ((c >> 16) & 0xff) | (c & 0xff00) | ((c & 0xff) << 16);

/**
 * A TerminalScreen of cols × rows, blank.
 * @param {number} cols @param {number} rows
 */
export function createTerminalScreen(cols, rows) {
    const n = cols * rows;
    return {
        cols, rows,
        cp: new Uint32Array(n).fill(32),
        fg: new Uint32Array(n).fill(RESET),
        bg: new Uint32Array(n),
        at: new Uint16Array(n),
        ul: new Uint32Array(n),
        alt: false,
        cursorX: 0,
        cursorY: 0,
    };
}

export default class TerminalEmulator {
    /**
     * @param {number} cols
     * @param {number} rows
     * @param {() => void} onDirty  called when parsed bytes may have changed the screen (once per
     *   write; the owner coalesces to one read per frame)
     */
    constructor(cols, rows, onDirty) {
        this.cols = cols;
        this.rows = rows;
        this._onDirty = onDirty;
        this._disposed = false;
        /** Parsed bytes landed since the last readScreen. */
        this.dirty = false;
        /** @type {ReturnType<typeof createTerminalScreen>|null} the one screen readScreen refills */
        this._screen = null;
        this._cell = undefined; // reusable CellData, filled by the line's loadCell
        /** @private the terminal's own background, packed: what inverse text draws in over a default background */
        this._defaultBg = 0;
        /** @private bold text in a standard colour draws in its bright twin (setBoldIsBright) */
        this._boldIsBright = BOLD_IS_BRIGHT_DEFAULT;

        // allowProposedApi: the buffer API (buffer.active, its cursor and type) is gated behind it.
        this._term = new Terminal({ cols, rows, scrollback: EMULATOR_SCROLLBACK, allowProposedApi: true });
        this._useWideWidths();

        // The write callback, made once (a closure per write is garbage per write).
        this._parsed = () => {
            if (this._disposed) return;
            this.dirty = true;
            this._onDirty?.();
        };

        // The read goes under the public line view (getLine builds a wrapper object per call) to
        // the buffer's own lines and a reused cell: loadCell fills a CellData in place. Those are
        // xterm internals, so check them here, at construction, rather than misread later.
        const view = this._term.buffer.active;
        const line = view?._buffer?.lines?.get?.(0);
        if (typeof line?.loadCell !== 'function') {
            throw new Error('[TerminalEmulator] xterm\'s buffer internals moved (buffer.active._buffer.lines.get(y).loadCell): the zero-allocation screen read needs them — check the @xterm/headless version');
        }
        this._cell = view.getLine(0).getCell(0);   // a CellData; loadCell refills it
        // The attribute reads below are xterm's AttributeData methods; one that moved would read
        // as "never set", so check them here too.
        for (const m of ['isCombined', 'getChars', 'getCode', 'isBold', 'isFgRGB', 'isFgPalette', 'getFgColor', 'isAttributeDefault', 'isInverse', 'isDim', 'isItalic', 'isBlink', 'isInvisible', 'isStrikethrough', 'isOverline',
            'isUnderline', 'getUnderlineStyle', 'isUnderlineColorDefault', 'isUnderlineColorRGB', 'isUnderlineColorPalette', 'getUnderlineColor']) {
            if (typeof this._cell[m] !== 'function') throw new Error(`[TerminalEmulator] xterm's cell has no ${m}(): the attribute read needs it — check the @xterm/headless version`);
        }
    }

    /**
     * The terminal's own background colour (its panel's), packed RGB888 with red in the low byte:
     * what inverse text over a DEFAULT background draws in. A change marks the screen dirty.
     * @param {number} packed
     */
    setDefaultBackground(packed) {
        packed &= 0xffffff;
        if (packed === this._defaultBg) return;
        this._defaultBg = packed;
        if (this._disposed) return;
        this.dirty = true;
        this._onDirty?.();
    }

    /**
     * Whether bold text in one of the eight standard colours draws in its bright twin
     * (BOLD_IS_BRIGHT_DEFAULT). A change marks the screen dirty.
     * @param {boolean} on
     */
    setBoldIsBright(on) {
        on = !!on;
        if (on === this._boldIsBright) return;
        this._boldIsBright = on;
        if (this._disposed) return;
        this.dirty = true;
        this._onDirty?.();
    }

    /** @returns {boolean} see setBoldIsBright */
    get boldIsBright() { return this._boldIsBright; }

    /**
     * Cell widths as termd and the programs count them: xterm's own table (Unicode 6) under a
     * provider that answers two cells for East Asian Wide codepoints — every default-presentation
     * emoji among them (terminalWidths.js). Without it a line with an emoji sits a column left of
     * where the program put it. The provider wraps xterm's active one (an internal: checked here).
     * @private
     */
    _useWideWidths() {
        const base = this._term._core?.unicodeService?._activeProvider;
        const unicode = this._term.unicode;
        if (typeof base?.wcwidth !== 'function' || typeof base?.charProperties !== 'function' || typeof unicode?.register !== 'function') {
            throw new Error('[TerminalEmulator] xterm\'s unicode service moved (_core.unicodeService._activeProvider, term.unicode.register): the wide-cell widths need them — check the @xterm/headless version');
        }
        // What xterm stores for "two cells, joins nothing": asked of xterm itself (一 is wide in every table).
        const wide = base.charProperties(0x4E00, 0);
        if (base.wcwidth(0x4E00) !== 2) throw new Error('[TerminalEmulator] xterm\'s width table no longer counts U+4E00 as two cells: the wide-cell provider can\'t learn its encoding');
        unicode.register({
            version: 'g3d-wide',
            wcwidth: (cp) => (isWideCodepoint(cp) ? 2 : base.wcwidth(cp)),
            charProperties: (cp, preceding) => (isWideCodepoint(cp) ? wide : base.charProperties(cp, preceding)),
        });
        unicode.activeVersion = 'g3d-wide';
    }

    /** Whether the program asked for bracketed paste (DECSET 2004) in the bytes parsed so far. */
    get bracketedPaste() {
        return this._term.modes.bracketedPasteMode;
    }

    /**
     * Whether the program turned mouse reporting on (DECSET 9 / 1000 / 1002 / 1003) in the bytes
     * parsed so far: xterm's public `modes.mouseTrackingMode`. termd's repaint sets the mode again,
     * so a re-adopted terminal reads true as well.
     */
    get mouseReporting() {
        return this._term.modes.mouseTrackingMode !== 'none';
    }

    /**
     * Which pointer events the program asked to hear (DECSET 9 / 1000 / 1002 / 1003, the last set
     * winning, as in xterm): `'none'`, `'x10'`, `'normal'`, `'button'` or `'any'` — termd's
     * names (xterm's `modes.mouseTrackingMode` says vt200 for normal and drag for button).
     * @returns {'none'|'x10'|'normal'|'button'|'any'}
     */
    get mouseTracking() {
        const m = this._term.modes.mouseTrackingMode;
        return m === 'vt200' ? 'normal' : m === 'drag' ? 'button' : m;
    }

    /**
     * Subscribe to window-title changes (OSC 0/2) in the byte stream — the titles the program
     * sets (termd also puts the current one in every repaint). Returns an unsubscribe.
     * @param {(title: string) => void} cb
     * @returns {() => void}
     */
    onTitleChange(cb) {
        const d = this._term.onTitleChange(cb);
        return () => d.dispose();
    }

    /**
     * Feed raw VT bytes (a Uint8Array from the OUTPUT data-plane frame, or a string).
     * @param {Uint8Array|string} bytes
     */
    write(bytes) {
        if (this._disposed) return;
        this._term.write(bytes, this._parsed);
    }

    /**
     * Resize the emulator's grid. Pairs with TerminalGrid.resize() and the adapter's
     * pty.Setsize so all three agree on cols×rows.
     *
     * Set the size, wait for the parser to be done, then apply — that's the whole thing. xterm's
     * write() parses ASYNCHRONOUSLY and runs writes in submission order; resize() is the one call
     * that jumps that queue synchronously, and resizing a half-parsed screen corrupts the buffer
     * (a later lineFeed throws on an undefined line → the terminal goes blank until reload). So the
     * resize joins the SAME queue: an empty write's callback fires once the buffer has drained, so
     * the resize lands between parses, never mid-parse. A grip drag enqueues one per cell-step —
     * they apply in order, the last size wins, none race. No coalescing, no timers: just serialize.
     * @param {number} cols
     * @param {number} rows
     */
    resize(cols, rows) {
        if (this._disposed) return;
        this._term.write('', () => {
            if (this._disposed) return;
            if (cols === this._term.cols && rows === this._term.rows) return; // already there
            this.cols = cols;
            this.rows = rows;
            this._term.resize(cols, rows);
            // Not marked dirty: resize leaves the buffer blank/reflowed until the source repaints
            // (the adapter asks termd for a repaint on every resize); reading it now would flash that frame — the
            // resize flicker. The repaint bytes that follow mark it dirty via write().
        });
    }

    /**
     * The visible screen as plain text — one string per row, per-line
     * trailing whitespace trimmed. Same buffer the glyphs render from.
     * @returns {string[]}
     */
    readText() {
        const term = this._term;
        const buf = term.buffer.active;
        const base = buf.baseY;
        const lines = [];
        for (let y = 0; y < term.rows; y++) {
            const line = buf.getLine(base + y);
            lines.push(line ? line.translateToString(true) : '');
        }
        return lines;
    }

    // ── the visible screen as a selection's TextSource (terminalSelection.js) ──
    // Read from xterm's own lines through the reused cell: no cell read allocates.

    /** @private The buffer line of screen row y, or undefined off the screen. */
    _line(y) {
        if (y < 0 || y >= this._term.rows) return undefined;
        const view = this._term.buffer.active;
        return view._buffer.lines.get(view.baseY + y);
    }

    /** Whether screen row y continues the row above it (the program's text wrapped at the edge). @param {number} y */
    wrapped(y) {
        return !!this._line(y)?.isWrapped;
    }

    /**
     * The codepoint in cell (x, y): 0 for an empty cell (and a wide character's second), a cluster's
     * base, −1 off the screen.
     * @param {number} y @param {number} x
     */
    code(y, x) {
        const line = this._line(y);
        if (!line || x < 0 || x >= line.length) return -1;
        const cell = this._cell;
        line.loadCell(x, cell);
        return cell.isCombined() ? cell.getChars().codePointAt(0) : cell.getCode();
    }

    /** Cell (x, y)'s width: 2 for a wide character's first cell, 0 for its second, else 1. @param {number} y @param {number} x */
    width(y, x) {
        const line = this._line(y);
        if (!line || x < 0 || x >= line.length) return 1;
        line.loadCell(x, this._cell);
        return this._cell.getWidth();
    }

    /** The text of row y's cells [x0, x1), untrimmed (a wide character once, a cluster whole). @param {number} y @param {number} x0 @param {number} x1 */
    text(y, x0, x1) {
        const line = this._line(y);
        return line ? line.translateToString(false, x0, x1) : '';
    }

    /**
     * Read the emulator's visible screen into its one reused TerminalScreen, at the READER's size
     * (cols × rows): cells outside xterm's grid — the reader resized ahead of the emulator, whose
     * resize waits behind the parser — read blank. Clears `dirty`. Allocates nothing unless the
     * size changed.
     * @param {number} cols
     * @param {number} rows
     * @returns {ReturnType<typeof createTerminalScreen>}
     */
    readScreen(cols, rows) {
        let s = this._screen;
        if (!s || s.cols !== cols || s.rows !== rows) s = this._screen = createTerminalScreen(cols, rows);
        this.dirty = false;

        const term = this._term;
        const view = term.buffer.active;
        const lines = view._buffer.lines;
        const base = view.baseY;          // the screen is the buffer's last `rows` lines
        const termRows = term.rows;
        const cell = this._cell;
        const CP = s.cp, FG = s.fg, BG = s.bg, AT = s.at, UL = s.ul;
        const defaultBg = this._defaultBg;
        const bright = this._boldIsBright;
        // Alt-screen apps (vim/htop/less) repaint the whole pane each frame, not a line-shift — so
        // depth-history capture must NOT treat their redraws as scroll. TerminalGrid reads this.
        s.alt = view.type === 'alternate';

        for (let y = 0; y < rows; y++) {
            const line = y < termRows ? lines.get(base + y) : undefined;
            const n = line ? Math.min(cols, line.length) : 0;
            let i = y * cols;
            for (let x = 0; x < n; x++, i++) {
                line.loadCell(x, cell);
                // The cell's content: its codepoint (0 = empty / a wide char's trailing slot → a
                // space; the wide glyph's own quad covers it) — or, where xterm holds a base and
                // its combining marks in the cell, that cluster's id (interned once; afterwards
                // one Map read on the string xterm already holds).
                const code = cell.isCombined() ? clusterId(cell.getChars()) : cell.getCode();
                // Most cells carry nothing: the default colours, no attribute. One test, and done.
                if (cell.isAttributeDefault()) {
                    CP[i] = code === 0 ? 32 : code;
                    FG[i] = RESET; BG[i] = 0; AT[i] = 0; UL[i] = 0;
                    continue;
                }
                // Bold is the glyph's face, not its colour — except, with boldIsBright, a bold
                // cell in a standard colour (palette 0–7), which takes its bright twin (8–15).
                const bold = cell.isBold();
                let fg, bg;
                if (cell.isFgRGB()) {
                    fg = rgbOf(cell.getFgColor());
                } else if (cell.isFgPalette()) {
                    const idx = cell.getFgColor() & 0xff;
                    fg = PALETTE[bright && bold && idx < 8 ? idx + 8 : idx];
                } else {
                    fg = RESET;
                }
                // The background: 0 for the default (no per-cell fill — the terminal's own panel
                // shows); only an explicit ANSI background (git-diff bars, ls --color, selections)
                // paints a cell fill.
                if (cell.isBgRGB()) bg = BG_SET | rgbOf(cell.getBgColor());
                else if (cell.isBgPalette()) bg = BG_SET | PALETTE[cell.getBgColor() & 0xff];
                else bg = 0;

                // The attributes, as one flags word (core/cellAttrs.js). The is*() reads are bit
                // tests on the cell's fg/bg words; the underline's style and colour sit in the
                // cell's extended attributes, which xterm keeps only where one was set.
                let at = (bold ? CELL_BOLD : 0)
                    | (cell.isDim() ? CELL_DIM : 0)
                    | (cell.isItalic() ? CELL_ITALIC : 0)
                    | (cell.isBlink() ? CELL_BLINK : 0)
                    | (cell.isInverse() ? CELL_INVERSE : 0)
                    | (cell.isInvisible() ? CELL_CONCEAL : 0)
                    | (cell.isStrikethrough() ? CELL_STRIKE : 0)
                    | (cell.isOverline() ? CELL_OVERLINE : 0);
                let ul = 0;
                if (cell.isUnderline()) {
                    const style = cell.getUnderlineStyle();
                    at |= (style >= UNDERLINE.SINGLE && style <= UNDERLINE.DASHED ? style : UNDERLINE.SINGLE) << CELL_UNDERLINE_SHIFT;
                    if (!cell.isUnderlineColorDefault()) {
                        if (cell.isUnderlineColorRGB()) { at |= CELL_UNDERLINE_COLOR; ul = rgbOf(cell.getUnderlineColor()); }
                        else if (cell.isUnderlineColorPalette()) { at |= CELL_UNDERLINE_COLOR; ul = PALETTE[cell.getUnderlineColor() & 0xff]; }
                    }
                }

                // Inverse swaps what is drawn: the text takes the background's colour (the
                // terminal's own where the cell names none), the cell fills with the foreground's.
                if (at & CELL_INVERSE) {
                    const text = bg ? bg & 0xffffff : defaultBg;
                    bg = BG_SET | fg;
                    fg = text;
                }
                // Concealed text is not drawn: its cell reads as a space (its fill and lines stay).
                CP[i] = code === 0 || (at & CELL_CONCEAL) ? 32 : code;
                FG[i] = fg;
                BG[i] = bg;
                AT[i] = at;
                UL[i] = ul;
            }
            for (let x = n; x < cols; x++, i++) { CP[i] = 32; FG[i] = RESET; BG[i] = 0; AT[i] = 0; UL[i] = 0; }
        }
        // Cursor cell. xterm's cursorY is already viewport-relative (0..rows-1), so it maps
        // straight to our row index; cursorX is the column. (DECTCEM show/hide isn't on the
        // public buffer API, so we always surface the position and let the renderer decide.)
        s.cursorX = view.cursorX;
        s.cursorY = view.cursorY;
        return s;
    }

    dispose() {
        this._disposed = true;
        this._term.dispose();
    }
}

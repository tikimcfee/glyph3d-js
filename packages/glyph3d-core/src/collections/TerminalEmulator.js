/**
 * TerminalEmulator — a headless VT emulator (@xterm/headless) that turns a raw byte
 * stream into a TerminalScreen our renderer can draw.
 *
 * This is the byte→screen SOURCE for a terminal viewport. TerminalGrid stays a pure
 * cell renderer (applyScreen is its input); the emulator is one source feeding it
 * (file-slice and graphics surfaces are other sources, later). We do NOT write a VT
 * parser — xterm interprets tmux's streaming redraw protocol (cursor addressing,
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
 * PACKED the way the slot buffer's color lane holds them (RGB888, red in the low byte), bold
 * already brightened, so the renderer compares and copies integers.
 *
 * TerminalScreen (what readScreen fills and applyScreen consumes):
 *   { cols, rows,
 *     cp: Uint32Array  — the codepoint per cell, row-major; 0 (empty, a wide char's trailing
 *                        slot) reads as 32, a space,
 *     fg: Uint32Array  — the packed foreground (RGB888, r low byte), bold ×1.4 clamped,
 *     bg: Uint32Array  — 0 for the DEFAULT background (no per-cell fill), else BG_SET | the packed
 *                        RGB888 of an explicit ANSI background,
 *     alt: boolean     — the alternate screen is active (full-screen TUIs),
 *     cursorX, cursorY — the VIEWPORT-relative cell the terminal would draw its caret on }
 */

// Deep import of the real ESM build: @xterm/headless@6's package.json "module" field
// points at a non-existent "lib/xterm.mjs" (only lib-headless/ ships), so the bare
// specifier fails to resolve under Vite/rollup. The concrete .mjs is the headless ESM
// entry and exports { Terminal }. Do NOT "simplify" this back to '@xterm/headless'.
import { Terminal } from '@xterm/headless/lib-headless/xterm-headless.mjs';
import { RESET_FG, ansi256toRGB } from './terminalPalette.js';

/** Marks a TerminalScreen bg word as an explicit background (the low 24 bits are its RGB888). */
export const BG_SET = 0x1000000;

/** A 0..1 channel as the slot buffer's byte: round(v × 255). */
const byteOf = (v) => (v * 255 + 0.5) | 0;
/** Bold brightens a channel by 40%, clamped. */
const boldOf = (v) => Math.min(v * 1.4, 1.0);
/** Pack 0..1 RGB the way the slot color lane holds it (r in the low byte). */
const pack = (r, g, b) => (byteOf(r) & 0xff) | ((byteOf(g) & 0xff) << 8) | ((byteOf(b) & 0xff) << 16);

// The palette and the default fg, packed once (normal and bold), so a read does no float work and
// allocates no color objects. A true-color channel's bold byte comes from BOLD_BYTE.
const PALETTE = new Uint32Array(256);
const PALETTE_BOLD = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    const c = ansi256toRGB(i);
    PALETTE[i] = pack(c.r, c.g, c.b);
    PALETTE_BOLD[i] = pack(boldOf(c.r), boldOf(c.g), boldOf(c.b));
}
const BOLD_BYTE = new Uint8Array(256);
for (let v = 0; v < 256; v++) BOLD_BYTE[v] = byteOf(boldOf(v / 255));
const RESET = pack(RESET_FG.r, RESET_FG.g, RESET_FG.b);
const RESET_BOLD = pack(boldOf(RESET_FG.r), boldOf(RESET_FG.g), boldOf(RESET_FG.b));

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

        // scrollback 0: behind a tmux client we mirror the visible pane only (tmux owns
        // scrollback and repaints the full screen), so the active buffer == the viewport.
        // allowProposedApi: the buffer API (buffer.active, its cursor and type) is gated behind it.
        this._term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });

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
    }

    /**
     * Subscribe to window-title changes (OSC 0/2) in the byte stream — behind tmux these are the
     * pane titles tmux forwards with `set-titles` (cli/attach_unix.go). Returns an unsubscribe.
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
            // (tmux fully redraws on SIGWINCH); reading it now would flash that empty frame — the
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
        const base = view.baseY;          // 0 with scrollback off; general either way
        const termRows = term.rows;
        const cell = this._cell;
        const CP = s.cp, FG = s.fg, BG = s.bg;
        // Alt-screen apps (vim/htop/less) repaint the whole pane each frame, not a line-shift — so
        // depth-history capture must NOT treat their redraws as scroll. TerminalGrid reads this.
        s.alt = view.type === 'alternate';

        for (let y = 0; y < rows; y++) {
            const line = y < termRows ? lines.get(base + y) : undefined;
            const n = line ? Math.min(cols, line.length) : 0;
            let i = y * cols;
            for (let x = 0; x < n; x++, i++) {
                line.loadCell(x, cell);
                // getCode() is the cell's codepoint (0 = empty / a wide char's trailing slot → a
                // space; the wide glyph's own quad covers it).
                const code = cell.getCode();
                CP[i] = code === 0 ? 32 : code;
                const bold = cell.isBold();
                if (cell.isFgDefault()) {
                    FG[i] = bold ? RESET_BOLD : RESET;
                } else if (cell.isFgRGB()) {
                    const c = cell.getFgColor();
                    FG[i] = bold
                        ? BOLD_BYTE[(c >> 16) & 0xff] | (BOLD_BYTE[(c >> 8) & 0xff] << 8) | (BOLD_BYTE[c & 0xff] << 16)
                        : rgbOf(c);
                } else if (cell.isFgPalette()) {
                    FG[i] = (bold ? PALETTE_BOLD : PALETTE)[cell.getFgColor() & 0xff];
                } else {
                    FG[i] = bold ? RESET_BOLD : RESET;
                }
                // The background: 0 for the default (no per-cell fill — the terminal's own panel
                // shows); only an explicit ANSI background (git-diff bars, ls --color, selections)
                // paints a cell fill.
                if (cell.isBgDefault()) BG[i] = 0;
                else if (cell.isBgRGB()) BG[i] = BG_SET | rgbOf(cell.getBgColor());
                else if (cell.isBgPalette()) BG[i] = BG_SET | PALETTE[cell.getBgColor() & 0xff];
                else BG[i] = 0;
            }
            for (let x = n; x < cols; x++, i++) { CP[i] = 32; FG[i] = RESET; BG[i] = 0; }
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

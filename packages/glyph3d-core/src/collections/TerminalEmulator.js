/**
 * TerminalEmulator — a headless VT emulator (@xterm/headless) that turns a raw byte
 * stream into a ScreenBuffer our renderer can draw.
 *
 * This is the byte→screen SOURCE for a terminal viewport. TerminalGrid stays a pure
 * cell renderer (applyScreen is its input); the emulator is one source feeding it
 * (file-slice and graphics surfaces are other sources, later). We do NOT write a VT
 * parser — xterm interprets tmux's streaming redraw protocol (cursor addressing,
 * scroll regions, erase, SGR) into a cell grid; we read that grid.
 *
 * Read throttling: term.write() parses asynchronously, so we read the buffer in the
 * write callback, deduped onto one requestAnimationFrame per frame — many writes
 * coalesce into one applyScreen.
 *
 * ScreenBuffer contract (what applyScreen consumes):
 *   { cols, rows, cells: Array<Array<{ codepoint:number, fg:{r,g,b}, bg:{r,g,b}|null, bold:boolean }>>,
 *     alt: boolean, cursor: { x:number, y:number } }
 *   bg is null for the DEFAULT background (no per-cell fill); only explicit ANSI bg paints a cell.
 *   cursor is the VIEWPORT-relative cell the terminal would draw its caret on (x = column, y = row);
 *   the renderer parks a cursor block there so you can see where typing lands.
 */

// Deep import of the real ESM build: @xterm/headless@6's package.json "module" field
// points at a non-existent "lib/xterm.mjs" (only lib-headless/ ships), so the bare
// specifier fails to resolve under Vite/rollup. The concrete .mjs is the headless ESM
// entry and exports { Terminal }. Do NOT "simplify" this back to '@xterm/headless'.
import { Terminal } from '@xterm/headless/lib-headless/xterm-headless.mjs';
import { RESET_FG, ansi256toRGB } from './terminalPalette.js';

export default class TerminalEmulator {
    /**
     * @param {number} cols
     * @param {number} rows
     * @param {(screen: {cols:number,rows:number,cells:Array}) => void} onScreen
     *   Called (rAF-throttled) with a fresh ScreenBuffer whenever the grid changes.
     */
    constructor(cols, rows, onScreen) {
        this.cols = cols;
        this.rows = rows;
        this._onScreen = onScreen;
        this._disposed = false;
        this._raf = 0;
        this._cell = undefined; // reusable IBufferCell, filled by getCell(x, cell)

        // Resize coalescing (see resize()): the newest requested size + a single-shot arm flag, so a
        // storm of resizes (a grip drag fires one per cell-step) collapses to ONE xterm resize.
        this._pendingCols = cols;
        this._pendingRows = rows;
        this._resizeArmed = false;

        // scrollback 0: behind a tmux client we mirror the visible pane only (tmux owns
        // scrollback and repaints the full screen), so the active buffer == the viewport.
        // allowProposedApi: the buffer cell-reading API (getCode/getFgColor/isFgRGB/…)
        // is gated behind it in xterm — our ScreenBuffer adapter lives on that API.
        this._term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
    }

    /**
     * Feed raw VT bytes (a Uint8Array from the OUTPUT data-plane frame, or a string).
     * @param {Uint8Array|string} bytes
     */
    write(bytes) {
        if (this._disposed) return;
        this._term.write(bytes, () => this._schedule());
    }

    /**
     * Resize the emulator's grid. Pairs with TerminalGrid.resize() and the adapter's
     * pty.Setsize so all three agree on cols×rows.
     *
     * Two things this has to get right, both about xterm's ASYNCHRONOUS write buffer (see write()):
     *
     *   1. SERIALIZE behind the parser. Calling this._term.resize() while bytes are still queued
     *      reflows a half-parsed screen — the cursor can sit past the new rows and xterm corrupts
     *      its buffer, so a later lineFeed throws on an undefined line and the terminal goes blank
     *      until reload. So the actual resize runs inside an empty-write callback, which fires only
     *      once the write buffer has drained — the resize lands between parses, never mid-parse.
     *
     *   2. COALESCE the storm. A grip drag fires a resize per cell-step; each would otherwise queue
     *      its own empty write and flood the pump. Instead we just record the newest size and arm a
     *      SINGLE deferred apply — later calls only update the target. One resize lands per drain, at
     *      whatever the latest size is by then; the intermediate sizes are skipped harmlessly.
     *
     * @param {number} cols
     * @param {number} rows
     */
    resize(cols, rows) {
        if (this._disposed) return;
        this._pendingCols = cols;
        this._pendingRows = rows;
        if (this._resizeArmed) return; // a deferred apply is already queued — it'll pick up the newest size
        this._resizeArmed = true;
        this._term.write('', () => this._applyResize());
    }

    /** @private — apply the latest pending size once the parser is idle (write buffer drained). */
    _applyResize() {
        this._resizeArmed = false;
        if (this._disposed) return;
        const cols = this._pendingCols, rows = this._pendingRows;
        if (cols === this._term.cols && rows === this._term.rows) return; // already there → nothing to do
        this.cols = cols;
        this.rows = rows;
        this._term.resize(cols, rows);
        // Deliberately NO _schedule() here. resize() leaves the buffer blank/reflowed until the
        // source repaints (tmux fully redraws on SIGWINCH); reading it now would flash that empty
        // frame — the resize flicker. The repaint bytes that follow drive the next read via write().
    }

    /** @private — one read per frame, regardless of write count. */
    _schedule() {
        if (this._raf || this._disposed) return;
        this._raf = requestAnimationFrame(() => {
            this._raf = 0;
            if (this._disposed || !this._onScreen) return;
            this._onScreen(this._readScreen());
        });
    }

    /** @private — project the emulator's visible buffer into a ScreenBuffer. */
    _readScreen() {
        const term = this._term;
        const cols = term.cols;
        const rows = term.rows;
        const buf = term.buffer.active;
        const base = buf.baseY; // 0 with scrollback off; general either way
        // Alt-screen apps (vim/htop/less) repaint the whole pane each frame, not a
        // line-shift — so depth-history capture must NOT treat their redraws as
        // scroll. Surface the buffer type so TerminalGrid can suppress it.
        const alt = buf.type === 'alternate';
        const cells = new Array(rows);

        for (let y = 0; y < rows; y++) {
            const line = buf.getLine(base + y);
            const row = new Array(cols);
            for (let x = 0; x < cols; x++) {
                if (!line) {
                    row[x] = { codepoint: 32, fg: RESET_FG, bg: null, bold: false };
                    continue;
                }
                this._cell = line.getCell(x, this._cell);
                if (!this._cell) {
                    row[x] = { codepoint: 32, fg: RESET_FG, bg: null, bold: false };
                    continue;
                }
                // getCode() is the unicode codepoint of the cell (0 = empty / the
                // trailing slot of a wide char → render a space; full wide-glyph
                // layout is a later refinement).
                const code = this._cell.getCode();
                row[x] = {
                    codepoint: code === 0 ? 32 : code,
                    fg: this._fgOf(this._cell),
                    bg: this._bgOf(this._cell),
                    bold: !!this._cell.isBold(),
                };
            }
            cells[y] = row;
        }
        // Cursor cell. xterm's cursorY is already viewport-relative (0..rows-1), so it
        // maps straight to our row index; cursorX is the column. The renderer parks a
        // block here. (DECTCEM show/hide isn't on the public buffer API, so we always
        // surface the position and let the renderer decide whether to draw it.)
        const cursor = { x: buf.cursorX, y: buf.cursorY };
        return { cols, rows, cells, alt, cursor };
    }

    /**
     * @private — xterm gives a color MODE + value; map it to RGB. Returning the shared
     * RESET_FG is safe: applyScreen reads .r/.g/.b and copies, never mutates.
     */
    _fgOf(cell) {
        if (cell.isFgDefault()) return RESET_FG;
        const c = cell.getFgColor();
        if (cell.isFgRGB()) {
            return { r: ((c >> 16) & 0xff) / 255, g: ((c >> 8) & 0xff) / 255, b: (c & 0xff) / 255 };
        }
        if (cell.isFgPalette()) return ansi256toRGB(c);
        return RESET_FG;
    }

    /**
     * @private — the cell's BACKGROUND as RGB, or null for the DEFAULT bg. Mirrors _fgOf (xterm's
     * symmetric isBgDefault/getBgColor/isBgRGB/isBgPalette). Null is meaningful: a default-bg cell
     * gets NO per-cell fill, so the terminal's own background plane shows through — only explicit
     * ANSI backgrounds (git-diff bars, ls --color, selections) paint a cell fill.
     */
    _bgOf(cell) {
        if (cell.isBgDefault()) return null;
        const c = cell.getBgColor();
        if (cell.isBgRGB()) {
            return { r: ((c >> 16) & 0xff) / 255, g: ((c >> 8) & 0xff) / 255, b: (c & 0xff) / 255 };
        }
        if (cell.isBgPalette()) return ansi256toRGB(c);
        return null;
    }

    dispose() {
        this._disposed = true;
        if (this._raf) {
            cancelAnimationFrame(this._raf);
            this._raf = 0;
        }
        this._term.dispose();
    }
}

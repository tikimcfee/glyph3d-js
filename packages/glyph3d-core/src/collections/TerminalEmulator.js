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
     * CRITICAL — resize must land AFTER the pending byte-parse drains. term.write() parses
     * ASYNCHRONOUSLY (see write() below), so calling this._term.resize() while bytes are still
     * in xterm's write buffer reflows against a half-parsed screen: the cursor can sit past the
     * resized rows and xterm throws deep in its reflow (isWrapped on an undefined line), leaving
     * the buffer corrupted → every subsequent read returns munged cells. Under a live grip-drag
     * (a resize every cell step) this fires constantly. So we funnel the resize through an empty
     * write — its callback runs once the write buffer is drained — serializing resize behind the
     * parse instead of racing it. The last size wins when a drag queues several.
     * @param {number} cols
     * @param {number} rows
     */
    resize(cols, rows) {
        if (this._disposed) return;
        if (cols === this.cols && rows === this.rows) return; // no-op: don't churn xterm's buffer
        this.cols = cols;
        this.rows = rows;
        this._term.write('', () => {
            if (this._disposed) return;
            this._term.resize(cols, rows);
            this._schedule();
        });
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

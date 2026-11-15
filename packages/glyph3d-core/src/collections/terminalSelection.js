/**
 * terminalSelection — a terminal's text selection, as terminals make one (Ghostty, kitty, WezTerm):
 * the model, with no DOM and no GPU. TerminalGrid owns one per grid, draws it through its cell fills
 * and reads its text; an app's pointer drives it.
 *
 *   mode     what a press-and-drag selects            the press that starts it
 *   cell     a stream of cells between two boundaries  one click (the drag)
 *   word     whole words, from the anchor's to the     two clicks
 *            head's (a word: a run of non-boundary
 *            cells, or a run of boundary cells; both
 *            follow soft wraps)
 *   line     whole logical lines (soft-wrapped rows     three clicks
 *            joined), leading and trailing blanks left
 *            out
 *
 * A STREAM selection runs from a start boundary to an end boundary in reading order, so every row
 * between them is selected to its edge (a soft-wrapped line reads on). A BLOCK selection (`block`) is
 * the rectangle of columns between the two points on every row between them.
 *
 * Points are fractional cell coordinates from the top-left of the screen (TerminalGrid.cellAt's
 * `x`, `y`: x in 0 … cols, y in 0 … rows). In cell mode a point is the cell boundary NEAREST it (a
 * press in a cell's right half starts after that cell, as terminals do); a point at or below the
 * bottom edge (y ≥ rows) is the end of the last row. A boundary inside a wide character moves to its
 * edge, so a wide character is selected whole or not at all.
 *
 * The text a selection holds (`text`): trailing blanks trimmed from each line, a soft wrap joined
 * (the row's text kept whole, its trailing blanks too, since they are the line's), a hard line end
 * kept as `\n`, wide characters and clusters as their text. A block's rows are each trimmed and end
 * in `\n`, the last excepted.
 *
 * What a selection reads is a TextSource (TerminalEmulator is one):
 *   rows, cols                  the screen's size
 *   wrapped(y)                  row y continues row y − 1 (the program's text ran past the edge)
 *   code(y, x)                  the cell's codepoint (0: empty; a cluster's base); −1 off the screen
 *   width(y, x)                 2 for a wide character's first cell, 0 for its second, else 1
 *   text(y, x0, x1)             the text of cells [x0, x1), untrimmed
 *
 * Nothing here allocates while a selection is extended (start, extend, the spans): an app may call
 * them on every pointer move.
 */

/**
 * The characters that end a word besides whitespace — Ghostty's `selection-word-chars` default
 * (` \t'"│`|:;,()[]{}<>$`; whitespace and an empty cell always end one).
 */
export const WORD_BOUNDARY_DEFAULT = '\'"│`|:;,()[]{}<>$';

/**
 * How a text selection draws, by default: Ghostty's (`selection-background` / `-foreground` unset),
 * the terminal's own colours inverted — the cells fill with the default text colour and their text
 * takes the panel's. `foreground: null` keeps each cell's own text colour. `wordChars`: what ends a
 * word besides whitespace (Ghostty's `selection-word-chars`).
 */
export const TERMINAL_SELECTION_DEFAULTS = Object.freeze({
    background: '#cccccc',
    foreground: '#0a0a1e',
    wordChars: WORD_BOUNDARY_DEFAULT,
});

/** @typedef {'cell'|'word'|'line'} SelectionMode */

/**
 * @typedef {{ rows: number, cols: number, wrapped: (y: number) => boolean, code: (y: number, x: number) => number,
 *   width: (y: number, x: number) => number, text: (y: number, x0: number, x1: number) => string }} TextSource
 */

const isSpace = (c) => c === 0 || c === 32 || c === 9;

export default class TerminalSelection {
    /** @param {string} [wordChars] - the boundary characters besides whitespace (WORD_BOUNDARY_DEFAULT) */
    constructor(wordChars = WORD_BOUNDARY_DEFAULT) {
        /** @type {Set<number>} */
        this._boundary = new Set();
        this.setWordChars(wordChars);
        this.clear();
    }

    /**
     * The characters that end a word besides whitespace (Ghostty's `selection-word-chars`).
     * @param {string} chars
     */
    setWordChars(chars) {
        this._boundary.clear();
        for (const ch of String(chars)) this._boundary.add(ch.codePointAt(0));
    }

    /** Drop the selection. */
    clear() {
        /** A selection is in hand (it may still be empty: a press that hasn't travelled). */
        this.active = false;
        /** @type {SelectionMode} */
        this.mode = 'cell';
        this.block = false;
        this._ax = 0; this._ay = 0;
        // The resolved selection: a stream from (r0, c0) to (r1, c1), end exclusive; a block's rows
        // r0…r1 and columns [c0, c1).
        this.r0 = 0; this.c0 = 0; this.r1 = 0; this.c1 = 0;
    }

    /** Whether some cell is selected. */
    get empty() {
        if (!this.active) return true;
        if (this.block) return this.c0 >= this.c1;
        return this.r0 > this.r1 || (this.r0 === this.r1 && this.c0 >= this.c1);
    }

    /**
     * Start a selection at a point (its anchor); in word and line mode it already holds the word or
     * line there.
     * @param {TextSource} src @param {number} x @param {number} y
     * @param {{ mode?: SelectionMode, block?: boolean }} [o]
     */
    start(src, x, y, { mode = 'cell', block = false } = {}) {
        this.active = true;
        this.mode = mode;
        this.block = block && mode === 'cell';
        this._ax = x; this._ay = y;
        this.extend(src, x, y);
    }

    /**
     * Move the selection's head to a point; the anchor stays. Returns whether the selection changed.
     * @param {TextSource} src @param {number} x @param {number} y @returns {boolean}
     */
    extend(src, x, y) {
        if (!this.active) return false;
        const p0 = this.r0, q0 = this.c0, p1 = this.r1, q1 = this.c1;
        if (this.mode === 'cell') this._resolveCells(src, x, y);
        else this._resolveUnits(src, x, y);
        return p0 !== this.r0 || q0 !== this.c0 || p1 !== this.r1 || q1 !== this.c1;
    }

    /**
     * Select exactly the cells between two boundaries — a stream from (row0, col0) to (row1, col1),
     * end exclusive, or a block — as a verb names them. Out-of-range values are clamped to the screen.
     * @param {TextSource} src @param {number} col0 @param {number} row0 @param {number} col1 @param {number} row1
     * @param {{ block?: boolean }} [o]
     */
    set(src, col0, row0, col1, row1, { block = false } = {}) {
        const R = src.rows, C = src.cols, cl = (v, hi) => Math.min(Math.max(Math.trunc(v), 0), hi);
        this.active = true; this.mode = 'cell'; this.block = block;
        let a = cl(row0, R - 1), b = cl(col0, C), c = cl(row1, R - 1), d = cl(col1, C);
        if (block) { this.r0 = Math.min(a, c); this.r1 = Math.max(a, c); this.c0 = Math.min(b, d); this.c1 = Math.max(b, d); return; }
        if (a > c || (a === c && b > d)) { const t = a; a = c; c = t; const u = b; b = d; d = u; }
        this.r0 = a; this.c0 = b; this.r1 = c; this.c1 = d;
        this._widen(src);
    }

    /**
     * The screen scrolled up by `k` lines (its text moved up): the selection follows its text. It is
     * dropped when any of it leaves the top. Returns whether it is still held.
     * @param {number} k
     */
    shift(k) {
        if (!this.active) return false;
        this.r0 -= k; this.r1 -= k; this._ay -= k;
        if (this.r0 < 0) { this.clear(); return false; }
        return true;
    }

    /**
     * The first selected column of row `y` (with `hi`: the row's selected cells are [lo, hi); none
     * when hi ≤ lo).
     * @param {number} y
     */
    lo(y) {
        if (this.empty || y < this.r0 || y > this.r1) return 0;
        return this.block || y === this.r0 ? this.c0 : 0;
    }

    /** @param {number} y @param {number} cols - the row's width */
    hi(y, cols) {
        if (this.empty || y < this.r0 || y > this.r1) return 0;
        return this.block || y === this.r1 ? this.c1 : cols;
    }

    /**
     * The selected text (empty when nothing is selected).
     * @param {TextSource} src @returns {string}
     */
    text(src) {
        if (this.empty) return '';
        const C = src.cols;
        let out = '';
        for (let y = this.r0; y <= this.r1; y++) {
            const a = this.lo(y), b = this.hi(y, C);
            let s = b > a ? src.text(y, a, b) : '';
            if (this.block) {
                out += s.replace(/\s+$/, '');
                if (y < this.r1) out += '\n';
                continue;
            }
            const joined = y < this.r1 && b >= C && src.wrapped(y + 1);
            if (!joined) s = s.replace(/[ \t]+$/, '');
            out += s;
            if (y < this.r1 && !joined) out += '\n';
        }
        return out;
    }

    // ── resolving ─────────────────────────────────────────────────────────────

    /** @private Cell mode: the boundaries nearest the anchor and the head. */
    _resolveCells(src, x, y) {
        const R = src.rows, C = src.cols;
        let ar, ac, hr, hc;
        if (this._ay >= R) { ar = R - 1; ac = C; } else { ar = Math.max(0, Math.floor(this._ay)); ac = Math.min(C, Math.max(0, Math.round(this._ax))); }
        if (y >= R) { hr = R - 1; hc = C; } else { hr = Math.max(0, Math.floor(y)); hc = Math.min(C, Math.max(0, Math.round(x))); }
        if (this.block) {
            this.r0 = Math.min(ar, hr); this.r1 = Math.max(ar, hr);
            this.c0 = Math.min(ac, hc); this.c1 = Math.max(ac, hc);
            return;
        }
        if (ar < hr || (ar === hr && ac <= hc)) { this.r0 = ar; this.c0 = ac; this.r1 = hr; this.c1 = hc; }
        else { this.r0 = hr; this.c0 = hc; this.r1 = ar; this.c1 = ac; }
        this._widen(src);
    }

    /** @private A stream's ends never split a wide character: its start moves to the character's first cell, its end past its second. */
    _widen(src) {
        if (this.c0 > 0 && this.c0 < src.cols && src.width(this.r0, this.c0) === 0) this.c0--;
        if (this.c1 > 0 && this.c1 < src.cols && src.width(this.r1, this.c1 - 1) === 2) this.c1++;
    }

    /** @private Word and line mode: the unit under the anchor joined with the unit under the head. */
    _resolveUnits(src, x, y) {
        const R = src.rows, C = src.cols;
        const ay = Math.min(R - 1, Math.max(0, Math.floor(this._ay))), ax = Math.min(C - 1, Math.max(0, Math.floor(this._ax)));
        const hy = Math.min(R - 1, Math.max(0, Math.floor(y))), hx = Math.min(C - 1, Math.max(0, Math.floor(x)));
        const line = this.mode === 'line';
        if (line) this._line(src, ay); else this._word(src, ax, ay);
        if (hy === ay && (line || hx === ax)) return;
        const r0 = this.r0, c0 = this.c0, r1 = this.r1, c1 = this.c1;
        if (line) this._line(src, hy); else this._word(src, hx, hy);
        this._union(r0, c0, r1, c1);   // a blank line is the point at its start
    }

    /** @private The held stream grown to cover (r0, c0)…(r1, c1) too. */
    _union(r0, c0, r1, c1) {
        if (r0 < this.r0 || (r0 === this.r0 && c0 < this.c0)) { this.r0 = r0; this.c0 = c0; }
        if (r1 > this.r1 || (r1 === this.r1 && c1 > this.c1)) { this.r1 = r1; this.c1 = c1; }
    }

    /** @private Whether a cell's character ends words (whitespace, an empty cell, a boundary character). */
    _isBoundary(c) {
        return isSpace(c) || this._boundary.has(c);
    }

    /**
     * @private The word under cell (x, y) — the run of cells of its kind (non-boundary, or boundary)
     * around it, across soft wraps — as the held stream.
     */
    _word(src, x, y) {
        const C = src.cols, R = src.rows;
        // A wide character's second cell is its first's.
        if (x > 0 && src.width(y, x) === 0) x--;
        const kind = this._isBoundary(src.code(y, x));
        let sy = y, sx = x;
        for (;;) {   // walk back while the cell before is of the same kind
            let py = sy, px = sx - 1;
            if (px < 0) { if (py === 0 || !src.wrapped(py)) break; py--; px = C - 1; }
            if (px > 0 && src.width(py, px) === 0) px--;
            if (this._isBoundary(src.code(py, px)) !== kind) break;
            sy = py; sx = px;
        }
        let ey = y, ex = x + Math.max(1, src.width(y, x));   // the end, exclusive
        for (;;) {   // walk on while the next cell is of the same kind
            let ny = ey, nx = ex;
            if (nx >= C) { if (ny + 1 >= R || !src.wrapped(ny + 1)) break; ny++; nx = 0; }
            if (this._isBoundary(src.code(ny, nx)) !== kind) break;
            ey = ny; ex = nx + Math.max(1, src.width(ny, nx));
        }
        this.r0 = sy; this.c0 = sx; this.r1 = ey; this.c1 = Math.min(ex, C);
    }

    /**
     * @private The logical line holding row y — its rows joined across soft wraps — less its leading
     * and trailing blanks, as the held stream (empty for a blank line).
     */
    _line(src, y) {
        const C = src.cols, R = src.rows;
        let first = y, last = y;
        while (first > 0 && src.wrapped(first)) first--;
        while (last + 1 < R && src.wrapped(last + 1)) last++;
        let sy = -1, sx = 0;
        for (let r = first; r <= last && sy < 0; r++) for (let c = 0; c < C; c++) if (!isSpace(src.code(r, c)) && src.width(r, c) !== 0) { sy = r; sx = c; break; }
        if (sy < 0) { this.r0 = first; this.c0 = 0; this.r1 = first; this.c1 = 0; return; }
        let ey = sy, ex = sx + 1;
        for (let r = last; r >= sy; r--) {
            let found = false;
            for (let c = C - 1; c >= 0; c--) {
                const w = src.width(r, c);
                if (w === 0 || isSpace(src.code(r, c))) continue;
                ey = r; ex = Math.min(C, c + Math.max(1, w)); found = true; break;
            }
            if (found) break;
        }
        this.r0 = sy; this.c0 = sx; this.r1 = ey; this.c1 = ex;
    }
}

/**
 * A TextSource over plain strings, one per row (a row longer than `cols` is cut; a character is one
 * cell, or two when `wide` says so) — for tests and tools. `wrapped` lists the rows that continue the
 * row above.
 * @param {string[]} lines @param {number} cols
 * @param {{ wrapped?: number[], wide?: (cp: number) => boolean }} [o]
 * @returns {TextSource}
 */
export function textSourceOf(lines, cols, { wrapped = [], wide = () => false } = {}) {
    const W = new Set(wrapped);
    const cells = lines.map((line) => {
        const row = [];   // per cell: [code, width, text]
        for (const ch of line) {
            if (row.length >= cols) break;
            const cp = ch.codePointAt(0);
            if (wide(cp)) { if (row.length + 2 > cols) break; row.push([cp, 2, ch], [0, 0, '']); } else row.push([cp, 1, ch]);
        }
        while (row.length < cols) row.push([0, 1, ' ']);
        return row;
    });
    const at = (y, x) => cells[y]?.[x];
    return {
        rows: lines.length, cols,
        wrapped: (y) => W.has(y),
        code: (y, x) => at(y, x)?.[0] ?? -1,
        width: (y, x) => at(y, x)?.[1] ?? 1,
        text: (y, x0, x1) => { let s = ''; for (let x = x0; x < x1; x++) s += at(y, x)?.[2] ?? ''; return s; },
    };
}

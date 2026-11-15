// terminal-selection.test.mjs — a terminal's text selection, headless.
//
// The model (core collections/terminalSelection.js) over plain rows and over a real emulator's
// screen: a stream between the boundaries nearest two points, across rows and soft wraps; a block;
// a wide character selected whole; a double-click's word (Ghostty's boundary set; runs of boundary
// characters; across a soft wrap) and a triple-click's logical line (its blanks left out); the text
// (trailing blanks trimmed per line, soft wraps joined, hard line ends kept, wide characters and
// clusters as text). The grid (TerminalGrid): the selected cells' highlight texels and colour lanes,
// only the changed cells uploaded on each extend, no new buffers, upload ranges or xterm line views
// per extend (the repo's structural no-allocation rule, terminal-text-path's), the selection
// riding a scroll up with its text and dropped when a selected cell is rewritten, scrolled off the
// top, or the terminal resizes; the restyle.
//
//   bun test tools/terminal-selection.test.mjs

import { test, expect } from 'bun:test';

await import('./headless-canvas.mjs');
const THREE = await import('three');
const { HEADLESS_ATLAS } = await import('./headless-atlas.mjs');
const { default: TerminalSelection, textSourceOf, WORD_BOUNDARY_DEFAULT, TERMINAL_SELECTION_DEFAULTS } = await import('../packages/glyph3d-core/src/collections/terminalSelection.js');
const { default: TerminalGrid } = await import('../packages/glyph3d-core/src/collections/TerminalGrid.js');
const { default: TerminalEmulator } = await import('../packages/glyph3d-core/src/collections/TerminalEmulator.js');
const { default: TerminalScreenQueue } = await import('../packages/glyph3d-core/src/collections/TerminalScreenQueue.js');
const { SLOT_FLOATS, LANE_COLOR } = await import('../packages/glyph3d-core/src/core/InstancedSlotBuffer.js');

/** Select from point a to point b (fractional cells: [x, y]) and read it back. */
function sel(src, a, b, o) {
    const s = new TerminalSelection();
    s.start(src, a[0], a[1], o);
    s.extend(src, b[0], b[1]);
    return s;
}

// ── the model ─────────────────────────────────────────────────────────────────

test('Ghostty\'s word boundaries are the default', () => {
    expect(WORD_BOUNDARY_DEFAULT).toBe('\'"│`|:;,()[]{}<>$');
});

test('a stream runs between the boundaries nearest its points, every row between to its edge', () => {
    const src = textSourceOf(['hello world', 'second line', 'third'], 12);
    // In the first cell's middle to the fifth's: the boundary nearest each — cells 0…4 → "hello"? No:
    // 0.4 rounds to boundary 0, 4.6 to 5: "hello".
    expect(sel(src, [0.4, 0.5], [4.6, 0.5]).text(src)).toBe('hello');
    // A press in a cell's right half starts after it.
    expect(sel(src, [0.6, 0.5], [4.6, 0.5]).text(src)).toBe('ello');
    // Backwards is the same selection.
    expect(sel(src, [4.6, 0.5], [0.4, 0.5]).text(src)).toBe('hello');
    // Across rows: the first row from its point, the middle whole, the last to its point; the
    // trailing blanks of each line trimmed, the hard line ends kept.
    const s = sel(src, [6, 0.5], [3, 2.5]);
    expect(s.text(src)).toBe('world\nsecond line\nthi');
    expect([s.lo(0), s.hi(0, 12), s.lo(1), s.hi(1, 12), s.lo(2), s.hi(2, 12)]).toEqual([6, 12, 0, 12, 0, 3]);
    // No travel past a boundary: nothing selected.
    const none = sel(src, [2.2, 0.5], [2.4, 0.5]);
    expect(none.empty).toBe(true);
    expect(none.text(src)).toBe('');
    // At or below the bottom edge: to the end of the last row.
    expect(sel(src, [0, 2.5], [1, 3]).text(src)).toBe('third');
});

test('a soft wrap joins its rows; a hard line end stays', () => {
    // "the quick brown fox" wrapped at 10, the second row continuing the first.
    const src = textSourceOf(['the quick ', 'brown fox', 'next'], 10, { wrapped: [1] });
    expect(sel(src, [0, 0.5], [9, 1.5]).text(src)).toBe('the quick brown fox');
    expect(sel(src, [4, 0.5], [4, 2.5]).text(src)).toBe('quick brown fox\nnext');
});

test('a block is the same columns on every row, each row trimmed', () => {
    const src = textSourceOf(['abcdef', 'ghijkl', 'mn'], 8);
    const s = sel(src, [1, 0.5], [4, 2.5], { block: true });
    expect(s.text(src)).toBe('bcd\nhij\nn');
    expect([s.lo(1), s.hi(1, 8)]).toEqual([1, 4]);
});

test('a wide character is selected whole', () => {
    const wide = (cp) => cp === 0x4E00;
    const src = textSourceOf(['a一b'], 6, { wide });   // a | 一 一 | b
    expect(sel(src, [0, 0.5], [2, 0.5]).text(src)).toBe('a一');   // the end inside 一 moves past it
    const s = sel(src, [2, 0.5], [4, 0.5]);                          // the start inside 一 moves to it
    expect(s.text(src)).toBe('一b');
    expect([s.lo(0), s.hi(0, 6)]).toEqual([1, 4]);
});

test('a double-click\'s word: a run of non-boundary cells, or of boundary ones; across a soft wrap', () => {
    const src = textSourceOf(['ls -la /usr/lib "my file" a,b', 'foo(bar)  x'], 40);
    const word = (x, y) => { const s = new TerminalSelection(); s.start(src, x, y, { mode: 'word' }); return s.text(src); };
    expect(word(1, 0.5)).toBe('ls');
    expect(word(4.5, 0.5)).toBe('-la');
    expect(word(8, 0.5)).toBe('/usr/lib');            // '/' and '.' are word characters in Ghostty's set
    expect(word(17, 0.5)).toBe('my');                 // the quote ends it
    expect(word(16, 0.5)).toBe(' "');                 // a boundary character: its run (the blank before it is one too)
    expect(word(26, 0.5)).toBe('a');
    expect(word(27, 0.5)).toBe(',');
    expect(word(2, 1.5)).toBe('foo');
    expect(word(8.5, 1.5)).toBe(')');                 // ')' and the blanks after it: one boundary run, its blanks trimmed
    // A word the edge split, joined across the wrap.
    const wrap = textSourceOf(['echo hello', 'world done'], 10, { wrapped: [1] });
    const s = new TerminalSelection();
    s.start(wrap, 7, 0.5, { mode: 'word' });
    expect(s.text(wrap)).toBe('helloworld');
    expect([s.r0, s.c0, s.r1, s.c1]).toEqual([0, 5, 1, 5]);
    // Dragging a word selection grows it word by word.
    s.extend(wrap, 7, 1.5);
    expect(s.text(wrap)).toBe('helloworld done');
    // The boundary characters are a knob.
    const t = new TerminalSelection('/');
    t.start(src, 8, 0.5, { mode: 'word' });
    expect(t.text(src)).toBe('usr');
});

test('a triple-click\'s line: the logical line, soft wraps joined, its blanks left out', () => {
    const src = textSourceOf(['  first line  ', 'a long one tha', 't wraps', '', 'last'], 14, { wrapped: [2] });
    const line = (y) => { const s = new TerminalSelection(); s.start(src, 3, y, { mode: 'line' }); return s; };
    expect(line(0.5).text(src)).toBe('first line');
    expect([line(0.5).c0, line(0.5).c1]).toEqual([2, 12]);
    expect(line(2.5).text(src)).toBe('a long one that wraps');   // from its second row too
    expect(line(1.5).text(src)).toBe('a long one that wraps');
    expect(line(3.5).empty).toBe(true);                          // a blank line: nothing
    const s = line(0.5);
    s.extend(src, 0, 4.5);                                       // dragged on: whole lines
    expect(s.text(src)).toBe('first line\na long one that wraps\n\nlast');
});

test('a scroll carries the selection up with its text; off the top it is dropped', () => {
    const src = textSourceOf(['a', 'b', 'c', 'd'], 4);
    const s = sel(src, [0, 2.5], [1, 3.5]);
    expect(s.shift(1)).toBe(true);
    expect([s.r0, s.r1]).toEqual([1, 2]);
    expect(s.shift(2)).toBe(false);
    expect(s.active).toBe(false);
});

test('the emulator is a TextSource: its wraps, wide cells, clusters and text', async () => {
    const emu = new TerminalEmulator(10, 4, () => {});
    const parsed = () => new Promise((r) => emu._term.write('', r));
    emu.write('the quick brown fox\r\n一x é!');
    await parsed();
    expect(emu.wrapped(0)).toBe(false);
    expect(emu.wrapped(1)).toBe(true);
    expect(emu.wrapped(2)).toBe(false);
    expect([emu.width(2, 0), emu.width(2, 1), emu.width(2, 2)]).toEqual([2, 0, 1]);
    expect(emu.code(2, 0)).toBe(0x4E00);
    expect(emu.code(2, 4)).toBe(0x65);                 // e + U+0301: the cluster's base
    expect(emu.code(9, 0)).toBe(-1);
    const s = sel(emu, [0, 0.5], [10, 2.5]);
    expect(s.text(emu)).toBe('the quick brown fox\n一x e\u0301!');
    const w = new TerminalSelection();
    w.start(emu, 7, 0.5, { mode: 'word' });
    expect(w.text(emu)).toBe('quick');
    w.start(emu, 2, 1.5, { mode: 'word' });            // on the wrapped row
    expect(w.text(emu)).toBe('brown');
    w.start(emu, 0.5, 1.5, { mode: 'line' });
    expect(w.text(emu)).toBe('the quick brown fox');
    emu.dispose();
});

// ── the grid ──────────────────────────────────────────────────────────────────

/** A real grid on a scene with a screen queue; `show(text)` writes and applies it. */
async function gridOf(cols = 20, rows = 6, options = {}) {
    const scene = new THREE.Scene();
    const queue = new TerminalScreenQueue(scene);
    const grid = new TerminalGrid(scene, HEADLESS_ATLAS, { id: 't', cols, rows, depthMax: 4, ...options });
    const show = async (bytes) => {
        grid.writeBytes(bytes);
        await new Promise((r) => grid._emulator._term.write('', r));
        grid.applyPendingScreen();
    };
    return { grid, queue, show };
}
const words = (grid) => grid._renderer.highlightWords(grid._totalCount);
const colorAt = (grid, i) => grid._renderer.slotBuffer.f32[i * SLOT_FLOATS + LANE_COLOR];
const pack = (hex) => { const n = parseInt(hex.slice(1), 16); return ((n >> 16) & 0xff) | (n & 0xff00) | ((n & 0xff) << 16); };
/**
 * The highlight and slot ranges waiting for upload, in slots, emptied — what three takes when it
 * uploads (a whole upload, before the first, reads as 'whole').
 */
function pending(grid) {
    const f = grid._renderer, tex = f._highlightTexture, ib = f._interleavedBuffer;
    const of = (t, unit) => (t.updateRanges.length ? t.updateRanges.map((r) => [r.start / unit, r.count / unit]) : t._seen === t.version ? [] : 'whole');
    const out = { hl: of(tex, 4), slots: of(ib, SLOT_FLOATS) };
    tex._seen = tex.version; ib._seen = ib.version;
    tex.clearUpdateRanges(); ib.clearUpdateRanges();
    ib.onUploadCallback(); tex.onUpdate?.(tex);
    return out;
}

test('the selected cells fill in the selection colour and draw their text in its foreground; the rest keep theirs', async () => {
    const { grid, show } = await gridOf();
    await show('hello world\r\nsecond');
    const base0 = grid._liveRowBase[0], base1 = grid._liveRowBase[1];
    grid.selectStart(6, 0.5);
    grid.selectExtend(3, 1.5);
    expect(grid.selectionText()).toBe('world\nsec');
    expect(grid.selection).toEqual({ mode: 'cell', block: false, start: { col: 6, row: 0 }, end: { col: 3, row: 1 } });
    const W = words(grid), selWord = grid._selWord;
    expect(selWord & 0xffffff).toBe(pack(TERMINAL_SELECTION_DEFAULTS.background));
    expect(selWord >>> 24).toBe(255);
    for (let x = 0; x < 20; x++) {
        expect(W[base0 + x] === selWord).toBe(x >= 6);
        expect(W[base1 + x] === selWord).toBe(x < 3);
        expect(colorAt(grid, base0 + x)).toBe(x >= 6 ? pack(TERMINAL_SELECTION_DEFAULTS.foreground) : grid._fg[base0 + x]);
    }
    expect(grid._renderer.fillsActive).toBe(true);
    grid.clearSelection();
    expect(grid.hasSelection).toBe(false);
    expect(W[base0 + 6]).toBe(0);
    expect(colorAt(grid, base0 + 6)).toBe(grid._fg[base0 + 6]);
    expect(grid._renderer.fillsActive).toBe(false);   // no background, no selection: no fill pass
});

test('an extend uploads only the cells whose state moved; the same boundary writes nothing', async () => {
    const { grid, show } = await gridOf(40, 6);
    await show('one two three four five six');
    const b0 = grid._liveRowBase[0], b2 = grid._liveRowBase[2];
    grid.selectStart(0, 0.5);
    pending(grid);
    grid.selectExtend(5, 0.5);
    expect(pending(grid)).toEqual({ hl: [[b0, 5]], slots: [[b0, 5]] });
    grid.selectExtend(5.3, 0.6);                                  // the same boundary
    expect(pending(grid)).toEqual({ hl: [], slots: [] });
    grid.selectExtend(8, 0.5);                                    // three more cells
    expect(pending(grid)).toEqual({ hl: [[b0 + 5, 3]], slots: [[b0 + 5, 3]] });
    grid.selectExtend(2, 2.5);                                    // down two rows: row 0's tail, row 1, row 2's head
    const p = pending(grid);
    expect(p.hl).toEqual([[b0 + 8, 32], [grid._liveRowBase[1], 40], [b2, 2]]);
    grid.selectExtend(1, 2.5);                                    // back one cell
    expect(pending(grid).hl).toEqual([[b2 + 1, 1]]);
    // A kept foreground leaves the colour lane alone.
    grid.setSelectionStyle({ foreground: null });
    pending(grid);
    grid.selectExtend(3, 2.5);
    expect(pending(grid)).toEqual({ hl: [[b2 + 1, 2]], slots: [] });
    expect(colorAt(grid, b2 + 2)).toBe(grid._fg[b2 + 2]);
});

test('extending a selection makes nothing: the same buffers, no new upload ranges, no xterm line views', async () => {
    // The repo's structural rule for "no allocation" (terminal-text-path's): every buffer the path
    // touches is the same object after the work, the upload-range pools did not grow, and the
    // emulator's lines are read under xterm's public getLine (which builds a wrapper per call). Moves
    // run with an upload between them, as frames take them.
    const { grid, show } = await gridOf(80, 24);
    await show(Array.from({ length: 24 }, (_, i) => `line ${i} of (some) text to select`).join('\r\n'));
    const f = grid._renderer, emu = grid._emulator;
    let getLines = 0;
    const view = emu._term.buffer.active, origGetLine = view.getLine;
    view.getLine = function (...a) { getLines++; return origGetLine.apply(this, a); };
    const work = () => {
        for (const mode of ['cell', 'word', 'line']) {
            grid.selectStart(3.4, 2.5, { mode });
            for (let i = 0; i < 400; i++) { grid.selectExtend((i * 7) % 81, 2 + ((i * 3) % 22) + 0.5); pending(grid); }
        }
    };
    work();
    const ids = () => [grid._selection, grid._selLo, grid._selHi, grid._cp, grid._fg, grid._bg, f.slotBuffer.f32, f._interleavedBuffer,
        f._highlightTexture, f.highlightWords(grid._totalCount), emu._cell];
    const pool = () => f._slotUploads._pool.length + f._highlight.uploads._pool.length;
    const id0 = ids(), pool0 = pool();
    work();
    expect(ids().every((o, i) => o === id0[i])).toBe(true);
    expect(pool()).toBe(pool0);
    expect(getLines).toBe(0);
    expect(grid.hasSelection).toBe(true);   // the work selected something (teeth)
});

test('the selection rides a scroll up with its text, and goes when a selected cell changes or scrolls off', async () => {
    const { grid, show } = await gridOf(20, 4);
    await show('aaa\r\nbbb\r\nccc\r\nddd');
    grid.selectStart(0, 2.5);
    grid.selectExtend(3, 2.5);
    expect(grid.selectionText()).toBe('ccc');
    // New output below: the screen scrolls by one, the selection moves with "ccc".
    await show('\r\neee');
    expect(grid.readText()[1]).toBe('ccc');
    expect(grid.selection.start.row).toBe(1);
    expect(grid.selectionText()).toBe('ccc');
    expect(words(grid)[grid._liveRowBase[1]]).toBe(grid._selWord);
    expect(words(grid)[grid._liveRowBase[2]]).toBe(0);
    // Output elsewhere leaves it.
    await show('\x1b[4;1Hzz');
    expect(grid.hasSelection).toBe(true);
    // A selected cell rewritten drops it.
    await show('\x1b[2;2HX');
    expect(grid.hasSelection).toBe(false);
    expect(words(grid)[grid._liveRowBase[1]]).toBe(0);
    // Scrolled off the top: dropped.
    grid.selectStart(0, 0.5);
    grid.selectExtend(2, 0.5);
    await show('\x1b[4;1H\r\nfff');
    expect(grid.hasSelection).toBe(false);
    for (let p = 0; p < grid.rows + grid._depthMax; p++) expect(grid._selHi[p]).toBe(0);
    // A resize drops it.
    grid.selectStart(0, 0.5);
    grid.selectExtend(2, 0.5);
    grid.resize(30, 4);
    expect(grid.hasSelection).toBe(false);
    expect(grid._renderer.fillsActive).toBe(false);
});

test('a restyle redraws the selected cells; a cell background outside the selection survives it', async () => {
    const { grid, show } = await gridOf(20, 3);
    await show('\x1b[41mred\x1b[0m plain');
    const b = grid._liveRowBase[0], W = words(grid);
    const red = W[b];
    expect(red).not.toBe(0);
    grid.selectCells(1, 0, 6, 0);
    expect(grid.selectionText()).toBe('ed pl');
    expect(W[b]).toBe(red);
    expect(W[b + 1]).toBe(grid._selWord);
    grid.setSelectionStyle({ background: '#112233', foreground: '#ffffff' });
    expect(W[b + 1] & 0xffffff).toBe(pack('#112233'));
    expect(colorAt(grid, b + 2)).toBe(pack('#ffffff'));
    grid.clearSelection();
    expect(W[b + 1]).toBe(red);                         // its own background back
    expect(W[b + 4]).toBe(0);
});

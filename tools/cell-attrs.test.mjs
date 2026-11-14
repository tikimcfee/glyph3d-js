// cell-attrs.test.mjs — a terminal cell's attributes, from the program's SGR to the slot:
// the flags word's layout (core/cellAttrs.js — the layout a packed wire cell maps onto), the
// style byte the shader draws and its home in the slot's group lane, and TerminalEmulator reading
// every attribute xterm holds into the screen's typed arrays (inverse and conceal resolved, the
// underline's style and colour, nothing allocated).
//
//   bun tools/cell-attrs.test.mjs

const A = await import('../packages/glyph3d-core/src/core/cellAttrs.js');
const { packGroupStyle, groupOf, styleOf, GROUP_ID_BITS, InstancedSlotBuffer, LANE_GROUP_ID, SLOT_FLOATS } = await import('../packages/glyph3d-core/src/core/InstancedSlotBuffer.js');
const { default: TerminalEmulator, BG_SET, DEFAULT_FG } = await import('../packages/glyph3d-core/src/collections/TerminalEmulator.js');
const { ansi256toRGB, RESET_FG } = await import('../packages/glyph3d-core/src/collections/terminalPalette.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };
const eq = (a, b, msg) => ok(a === b, `${msg} — got ${a}, want ${b}`);

// ── 1. the flags word: one bit each, the documented places ───────────────────────────────────
console.log('the attrs word');
{
    const bits = { bold: 0, dim: 1, italic: 2, blink: 3, inverse: 4, conceal: 5, strike: 6, overline: 7 };
    for (const [name, bit] of Object.entries(bits)) eq(A.packCellAttrs({ [name]: true }), 1 << bit, `${name} is bit ${bit}`);
    eq(A.CELL_BOLD | A.CELL_DIM | A.CELL_ITALIC | A.CELL_BLINK | A.CELL_INVERSE | A.CELL_CONCEAL | A.CELL_STRIKE | A.CELL_OVERLINE, 0xff, 'the eight flags fill the low byte');
    for (let u = 0; u <= 5; u++) eq(A.packCellAttrs({ underline: u }), u << 8, `underline style ${u} sits in bits 8..10`);
    eq(A.CELL_UNDERLINE_MASK, 0x700, 'the underline mask');
    eq(A.packCellAttrs({ underline: A.UNDERLINE.CURLY, underlineColor: true }), (3 << 8) | (1 << 11), 'an underline colour is bit 11');
    eq(A.packCellAttrs({ underlineColor: true }), 0, 'an underline colour with no underline is nothing');
    ok(A.packCellAttrs({ bold: true, dim: true, italic: true, blink: true, inverse: true, conceal: true, strike: true, overline: true, underline: 5, underlineColor: true }) < 1 << 12, 'every attribute at once fits 12 bits (a u16 holds it)');
    let threw = false;
    try { A.packCellAttrs({ underline: 6 }); } catch { threw = true; }
    ok(threw, 'an underline style past dashed is refused');
}

// ── 2. the style byte: what the shader draws, and only that ──────────────────────────────────
console.log('the style byte');
{
    eq(A.cellStyle(0), 0, 'no attributes: no style');
    eq(A.cellStyle(A.CELL_DIM), A.STYLE_DIM, 'dim');
    eq(A.cellStyle(A.CELL_STRIKE), A.STYLE_STRIKE, 'strike');
    eq(A.cellStyle(A.CELL_OVERLINE), A.STYLE_OVERLINE, 'overline');
    for (let u = 1; u <= 5; u++) eq(A.cellStyle(u << A.CELL_UNDERLINE_SHIFT), u << A.STYLE_UNDERLINE_SHIFT, `underline style ${u}`);
    eq(A.cellStyle((3 << A.CELL_UNDERLINE_SHIFT) | A.CELL_UNDERLINE_COLOR), (3 << A.STYLE_UNDERLINE_SHIFT) | A.STYLE_UNDERLINE_COLOR, 'a coloured curly underline');
    eq(A.cellStyle(A.CELL_UNDERLINE_COLOR), 0, 'an underline colour without an underline draws nothing');
    eq(A.cellStyle(A.CELL_BOLD | A.CELL_ITALIC | A.CELL_BLINK | A.CELL_INVERSE | A.CELL_CONCEAL), 0,
        'bold, inverse and conceal are in the colours, italic in the glyph, blink undrawn: none reaches the style byte');
    let max = 0;
    for (let at = 0; at < 1 << 12; at++) max = Math.max(max, A.cellStyle(at));
    ok(max < 128, `every attrs word's style fits 7 bits (max ${max})`);
    eq(A.STYLE_LINES, A.STYLE_STRIKE | A.STYLE_OVERLINE | A.STYLE_UNDERLINE_MASK, 'STYLE_LINES is every bit that draws a line');
}

// ── 3. its home: the group lane's spare bits, exact in a float32 ─────────────────────────────
console.log('the group lane');
{
    eq(GROUP_ID_BITS, 16, 'a group row has 16 bits');
    const f = new Float32Array(1);
    let exact = true;
    for (const g of [0, 1, 4095, 4096, 16383, 65535]) {
        for (const st of [0, 1, 0x38, 0x7f, 0xff]) {
            f[0] = packGroupStyle(g, st);
            if (groupOf(f[0]) !== g || styleOf(f[0]) !== st) exact = false;
        }
    }
    ok(exact, 'group row and style byte round-trip through a float32 lane at their extremes');
    ok(packGroupStyle(65535, 255) < 2 ** 24, 'the largest value is below 2^24 (every integer there is exact in f32)');
    eq(packGroupStyle(7, 0), 7, 'a slot with no style holds its bare group row');
    const sb = new InstancedSlotBuffer(4);
    sb.setSlot(0, 0, 0, 0, 5, 0xffffff, packGroupStyle(9, 0x4b), 1, 1);
    const slot = sb.getSlot(0);
    ok(slot.groupId === 9 && slot.style === 0x4b, `getSlot answers the row and the style apart (${slot.groupId}, ${slot.style})`);
    eq(sb.f32[LANE_GROUP_ID], 9 + 0x4b * 65536, 'in the one lane');
    ok(SLOT_FLOATS === 8, 'the slot did not grow');
}

// ── 4. the emulator reads every attribute into the screen ────────────────────────────────────
console.log('TerminalEmulator.readScreen');
{
    const emu = new TerminalEmulator(60, 6, () => {});
    const write = (s) => new Promise((r) => emu._term.write(s, r));
    const PANEL = 0x1e0a0a;   // packed, red low: rgb(10, 10, 30)
    emu.setDefaultBackground(PANEL);
    const pack = (r, g, b) => r | (g << 8) | (b << 16);
    const pal = (i) => { const c = ansi256toRGB(i); return pack(Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)); };
    const cases = [
        ['\x1b[2m', 'D', A.CELL_DIM],
        ['\x1b[3m', 'I', A.CELL_ITALIC],
        ['\x1b[5m', 'B', A.CELL_BLINK],
        ['\x1b[9m', 'S', A.CELL_STRIKE],
        ['\x1b[53m', 'O', A.CELL_OVERLINE],
        ['\x1b[4m', 'U', 1 << 8],
        ['\x1b[4:2m', 'W', 2 << 8],
        ['\x1b[21m', 'X', 2 << 8],
        ['\x1b[4:3m', 'C', 3 << 8],
        ['\x1b[4:4m', 'T', 4 << 8],
        ['\x1b[4:5m', 'A', 5 << 8],
        ['\x1b[1m', 'b', A.CELL_BOLD],
        ['\x1b[2;3;9;53;4:3m', 'M', A.CELL_DIM | A.CELL_ITALIC | A.CELL_STRIKE | A.CELL_OVERLINE | (3 << 8)],
    ];
    await write(cases.map(([sgr, ch]) => `${sgr}${ch}\x1b[0m`).join('') + 'p');
    let s = emu.readScreen(60, 6);
    cases.forEach(([sgr, ch, want], x) => {
        ok(s.cp[x] === ch.codePointAt(0) && s.at[x] === want, `${JSON.stringify(sgr)} reads as attrs ${want.toString(2)} (got ${s.at[x].toString(2)} on '${String.fromCodePoint(s.cp[x])}')`);
    });
    ok(s.at[cases.length] === 0 && s.ul[cases.length] === 0 && s.fg[cases.length] === DEFAULT_FG && s.bg[cases.length] === 0, 'a plain cell has no attributes, the default colours, no fill');
    ok(s.at instanceof Uint16Array && s.ul instanceof Uint32Array, 'attrs are a Uint16Array, underline colours a Uint32Array');

    // Underline colours: true colour (both spellings), palette, none.
    await write('\r\n\x1b[4:3;58:2::255:80:0mR\x1b[0m\x1b[4;58;2;1;2;3mS\x1b[0m\x1b[4:5;58;5;196mP\x1b[0m\x1b[4;31mF\x1b[0m\x1b[58;2;9;9;9mN\x1b[0m');
    s = emu.readScreen(60, 6);
    const row = 60;
    ok(s.at[row] === ((3 << 8) | A.CELL_UNDERLINE_COLOR) && s.ul[row] === pack(255, 80, 0), `58:2::255:80:0 under a curly underline: its colour, red low (got ${s.ul[row].toString(16)})`);
    ok(s.at[row + 1] === ((1 << 8) | A.CELL_UNDERLINE_COLOR) && s.ul[row + 1] === pack(1, 2, 3), '58;2;1;2;3: the same');
    ok(s.at[row + 2] === ((5 << 8) | A.CELL_UNDERLINE_COLOR) && s.ul[row + 2] === pal(196), '58;5;196: the palette colour');
    ok(s.at[row + 3] === (1 << 8) && s.ul[row + 3] === 0, 'an underline with no colour of its own: no flag, and it takes the text\'s (the shader\'s default)');
    ok(s.at[row + 4] === 0 && s.ul[row + 4] === 0, 'an underline colour with no underline: nothing');

    // Inverse swaps what is drawn; conceal blanks the glyph.
    await write('\r\n\x1b[7mi\x1b[0m\x1b[7;38;2;200;100;50;48;2;10;20;30mj\x1b[0m\x1b[7;31mk\x1b[0m\x1b[7;44ml\x1b[0m\x1b[1;7mm\x1b[0m\x1b[8mh\x1b[0m\x1b[8;4;41mg\x1b[0m');
    s = emu.readScreen(60, 6);
    const r2 = 120;
    const fgDefault = pack(Math.round(RESET_FG.r * 255), Math.round(RESET_FG.g * 255), Math.round(RESET_FG.b * 255));
    ok(s.at[r2] === A.CELL_INVERSE && s.fg[r2] === PANEL && s.bg[r2] === (BG_SET | fgDefault), 'inverse, default colours: the text draws in the terminal\'s background, the cell fills with the default text colour');
    ok(s.fg[r2 + 1] === pack(10, 20, 30) && s.bg[r2 + 1] === (BG_SET | pack(200, 100, 50)), 'inverse, both colours named: they swap');
    ok(s.fg[r2 + 2] === PANEL && s.bg[r2 + 2] === (BG_SET | pal(1)), 'inverse, a palette foreground: the cell fills with it');
    ok(s.fg[r2 + 3] === pal(4) && s.bg[r2 + 3] === (BG_SET | fgDefault), 'inverse, a palette background: the text draws in it');
    ok(s.at[r2 + 4] === (A.CELL_BOLD | A.CELL_INVERSE) && (s.bg[r2 + 4] & 0xffffff) !== fgDefault && s.bg[r2 + 4] !== 0, 'inverse bold: the fill is the brightened text colour');
    ok(s.at[r2 + 5] === A.CELL_CONCEAL && s.cp[r2 + 5] === 32, 'conceal: the cell reads as a space');
    ok(s.cp[r2 + 6] === 32 && s.at[r2 + 6] === (A.CELL_CONCEAL | (1 << 8)) && s.bg[r2 + 6] === (BG_SET | pal(1)), 'concealed text keeps its fill and its underline');
    eq(emu.readText()[2].trim(), 'ijklmhg', 'the text itself (readText) is untouched by conceal');

    // The terminal's own background is what inverse text over a default background draws in.
    emu.dirty = false;
    let dirtied = 0;
    emu._onDirty = () => { dirtied++; };
    emu.setDefaultBackground(0x112233);
    ok(emu.dirty && dirtied === 1, 'a new terminal background marks the screen dirty');
    s = emu.readScreen(60, 6);
    eq(s.fg[r2], 0x112233, 'and the next read draws inverse text in it');
    emu.setDefaultBackground(0x112233);
    eq(dirtied, 1, 'the same one again does not');

    // Nothing is allocated: the same screen and arrays, read after read.
    const before = [s, s.cp, s.fg, s.bg, s.at, s.ul];
    await write('\r\n\x1b[4:3;58:2::1:2:3mmore\x1b[0m');
    const again = emu.readScreen(60, 6);
    ok([again, again.cp, again.fg, again.bg, again.at, again.ul].every((o, i) => o === before[i]), 'a second read refills the same screen and the same five arrays');

    // Cells past xterm's grid (the reader resized ahead of it) read blank, attributes included.
    const wide = emu.readScreen(70, 8);
    ok(wide.at[69] === 0 && wide.ul[69] === 0 && wide.cp[69] === 32 && wide.at[7 * 70] === 0, 'cells outside xterm\'s grid read blank with no attributes');
    emu.dispose();
}

console.log(`\ncell-attrs: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

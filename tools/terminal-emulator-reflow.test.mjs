// terminal-emulator-reflow.test.mjs — the emulator's xterm stays whole through a column shrink.
//
// The real @xterm/headless under TerminalEmulator. A column shrink reflows the soft-wrapped lines
// above the cursor, and xterm's reflow assumes room above the screen: with no scrollback it put the
// screen's base past the buffer's end, the next row grow left a screen row with no line, and a line
// feed onto that row threw ("can't access property isWrapped") inside xterm's write loop, which
// then stopped for good. EMULATOR_SCROLLBACK keeps the room.
//
//   bun test tools/terminal-emulator-reflow.test.mjs

import { test, expect } from 'bun:test';

const { default: TerminalEmulator, EMULATOR_SCROLLBACK } = await import('../packages/glyph3d-core/src/collections/TerminalEmulator.js');

/** Resolves true once everything written so far has been parsed, false if xterm never gets there. */
const parsed = (emu, ms = 500) => Promise.race([
    new Promise((r) => emu._term.write('', () => r(true))),
    new Promise((r) => setTimeout(() => r(false), ms)),
]);

test('the emulator keeps scrollback: never none', () => {
    expect(EMULATOR_SCROLLBACK).toBeGreaterThan(0);
    const emu = new TerminalEmulator(20, 4, () => {});
    expect(emu._term.options.scrollback).toBe(EMULATOR_SCROLLBACK);
    emu.dispose();
});

test('a column shrink over soft-wrapped lines, then a row grow, leaves every row a line feed can reach', async () => {
    const emu = new TerminalEmulator(80, 10, () => {});
    // Eight soft-wrapped rows of one line, the cursor parked on the row below them.
    emu.write('z'.repeat(640) + '\x1b[9;1H');
    emu.resize(20, 10);      // the reflow: 8 rows of 80 become 32 of 20
    emu.resize(20, 30);
    emu.write('\n'.repeat(40) + 'end');
    expect(await parsed(emu)).toBe(true);
    expect([emu._term.cols, emu._term.rows]).toEqual([20, 30]);
    const lines = emu._term.buffer.active._buffer.lines;
    for (let y = 0; y < 30; y++) expect(lines.get(emu._term.buffer.active.baseY + y)).toBeDefined();
    expect(emu.readText()[29]).toBe('end');
    emu.dispose();
});

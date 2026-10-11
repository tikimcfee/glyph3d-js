// syntax-coloring-align.test.mjs — verify that syntax coloring palette accurately
// aligns with 3D RenderSlots across multiple lines, newlines, and multibyte codepoints.

import * as THREE from 'three';
import CodeGrid from '../packages/glyph3d-core/src/collections/CodeGrid.js';
import InstancedField from '../packages/glyph3d-core/src/collections/InstancedField.js';
import { runSyntaxPaletteJob, paletteLUT, decodePackedCaptures } from '../packages/glyph3d-core/src/parsing/syntaxPaletteJob.js';
import { detectLanguage } from '../packages/glyph3d-core/src/parsing/languageRegistry.js';
import { DEFAULT_SYNTAX_THEME, FOREGROUND } from '../packages/glyph3d-core/src/parsing/syntaxTheme.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        passed++;
    } else {
        failed++;
        console.error(`FAIL: ${message}`);
    }
}

console.log('Testing Syntax Coloring Alignment...');

const SOURCE = `const a = 1;
const b = 2;
const c = 3;
function hello() {
    return "world 🌍";
}
`;

const descriptor = detectLanguage('test.js');
assert(!!descriptor, 'language detected for test.js');

// 1. Run syntax palette job on multiline source
const { palette, packed } = await runSyntaxPaletteJob(SOURCE, descriptor);
assert(palette.length > 0, `palette generated (${palette.length} bytes)`);
const lut = paletteLUT();

// 2. Load text into CodeGrid
const dummyAtlas = {
    getCharSize: () => ({ width: 10, height: 20 }),
    _slugData: null,
    _shaper: null,
    _live: null,
};
const grid = new CodeGrid(null, dummyAtlas, { showBackground: false, filename: 'test.js' });
await grid.loadText(SOURCE);

assert(grid.lines.length >= 6, `grid loaded ${grid.lines.length} lines`);
assert(grid._renderer !== null, 'grid renderer instantiated');

// 3. Apply syntax palette
grid.applySyntaxPalette(palette, lut);

// 4. Verify slot colors on line 0 ("const a = 1;")
{
    // "const" is cols 0..4 (5 chars)
    const line0Start = grid._layout.lineSlotBase[0];
    const slot0 = grid._renderer.slotBuffer.getSlot(line0Start + 0); // 'c'
    const slot4 = grid._renderer.slotBuffer.getSlot(line0Start + 4); // 't'
    const slot5 = grid._renderer.slotBuffer.getSlot(line0Start + 5); // ' '
    const slot10 = grid._renderer.slotBuffer.getSlot(line0Start + 10); // '1'

    // Theme colors: keyword (0.78, 0.58, 0.86), number (0.86, 0.74, 0.52), foreground (0.82, 0.85, 0.88)
    const kwCol = DEFAULT_SYNTAX_THEME.keyword;
    const numCol = DEFAULT_SYNTAX_THEME.number;

    const r0 = (slot0.color & 0xFF) / 255;
    const g0 = ((slot0.color >> 8) & 0xFF) / 255;
    const b0 = ((slot0.color >> 16) & 0xFF) / 255;

    assert(Math.abs(r0 - kwCol.r) < 0.05 && Math.abs(g0 - kwCol.g) < 0.05 && Math.abs(b0 - kwCol.b) < 0.05,
        `Line 0: 'const' has keyword color (got ${r0.toFixed(2)},${g0.toFixed(2)},${b0.toFixed(2)}, expected ${kwCol.r},${kwCol.g},${kwCol.b})`);

    const r10 = (slot10.color & 0xFF) / 255;
    const g10 = ((slot10.color >> 8) & 0xFF) / 255;
    const b10 = ((slot10.color >> 16) & 0xFF) / 255;
    assert(Math.abs(r10 - numCol.r) < 0.05 && Math.abs(g10 - numCol.g) < 0.05 && Math.abs(b10 - numCol.b) < 0.05,
        `Line 0: '1' has number color (got ${r10.toFixed(2)},${g10.toFixed(2)},${b10.toFixed(2)})`);
}

// 5. Verify slot colors on line 1 ("const b = 2;")
// In the old broken code, line 1 was shifted by 1 byte, so 'c' would be colored as newline (foreground)
{
    const line1Start = grid._layout.lineSlotBase[1];
    const slot0 = grid._renderer.slotBuffer.getSlot(line1Start + 0); // 'c'
    const slot10 = grid._renderer.slotBuffer.getSlot(line1Start + 10); // '2'

    const kwCol = DEFAULT_SYNTAX_THEME.keyword;
    const numCol = DEFAULT_SYNTAX_THEME.number;

    const r0 = (slot0.color & 0xFF) / 255;
    const g0 = ((slot0.color >> 8) & 0xFF) / 255;
    const b0 = ((slot0.color >> 16) & 0xFF) / 255;

    assert(Math.abs(r0 - kwCol.r) < 0.05 && Math.abs(g0 - kwCol.g) < 0.05 && Math.abs(b0 - kwCol.b) < 0.05,
        `Line 1: 'const' accurately colored as keyword on line 1 (no newline offset drift!)`);

    const r10 = (slot10.color & 0xFF) / 255;
    const g10 = ((slot10.color >> 8) & 0xFF) / 255;
    const b10 = ((slot10.color >> 16) & 0xFF) / 255;
    assert(Math.abs(r10 - numCol.r) < 0.05 && Math.abs(g10 - numCol.g) < 0.05 && Math.abs(b10 - numCol.b) < 0.05,
        `Line 1: '2' accurately colored as number on line 1`);
}

// 6. Verify slot colors on line 2 ("const c = 3;")
// In the old broken code, line 2 was shifted by 2 bytes!
{
    const line2Start = grid._layout.lineSlotBase[2];
    const slot0 = grid._renderer.slotBuffer.getSlot(line2Start + 0); // 'c'
    const slot10 = grid._renderer.slotBuffer.getSlot(line2Start + 10); // '3'

    const kwCol = DEFAULT_SYNTAX_THEME.keyword;
    const numCol = DEFAULT_SYNTAX_THEME.number;

    const r0 = (slot0.color & 0xFF) / 255;
    const g0 = ((slot0.color >> 8) & 0xFF) / 255;
    const b0 = ((slot0.color >> 16) & 0xFF) / 255;

    assert(Math.abs(r0 - kwCol.r) < 0.05 && Math.abs(g0 - kwCol.g) < 0.05 && Math.abs(b0 - kwCol.b) < 0.05,
        `Line 2: 'const' accurately colored as keyword on line 2`);

    const r10 = (slot10.color & 0xFF) / 255;
    const g10 = ((slot10.color >> 8) & 0xFF) / 255;
    const b10 = ((slot10.color >> 16) & 0xFF) / 255;
    assert(Math.abs(r10 - numCol.r) < 0.05 && Math.abs(g10 - numCol.g) < 0.05 && Math.abs(b10 - numCol.b) < 0.05,
        `Line 2: '3' accurately colored as number on line 2`);
}

// 7. Verify slot colors on line 3 ("function hello() {")
{
    const line3Start = grid._layout.lineSlotBase[3];
    const slot0 = grid._renderer.slotBuffer.getSlot(line3Start + 0); // 'f' of function
    const slotFnName = grid._renderer.slotBuffer.getSlot(line3Start + 9); // 'h' of hello

    const kwCol = DEFAULT_SYNTAX_THEME.keyword;
    const fnCol = DEFAULT_SYNTAX_THEME.function;

    const r0 = (slot0.color & 0xFF) / 255;
    const g0 = ((slot0.color >> 8) & 0xFF) / 255;
    const b0 = ((slot0.color >> 16) & 0xFF) / 255;

    assert(Math.abs(r0 - kwCol.r) < 0.05 && Math.abs(g0 - kwCol.g) < 0.05 && Math.abs(b0 - kwCol.b) < 0.05,
        `Line 3: 'function' has keyword color`);

    const rFn = (slotFnName.color & 0xFF) / 255;
    const gFn = ((slotFnName.color >> 8) & 0xFF) / 255;
    const bFn = ((slotFnName.color >> 16) & 0xFF) / 255;
    assert(Math.abs(rFn - fnCol.r) < 0.05 && Math.abs(gFn - fnCol.g) < 0.05 && Math.abs(bFn - fnCol.b) < 0.05,
        `Line 3: 'hello' has function color (got ${rFn.toFixed(2)},${gFn.toFixed(2)},${bFn.toFixed(2)}, expected ${fnCol.r},${fnCol.g},${fnCol.b})`);
}

// 8. Verify line 4 with emoji ("    return \"world 🌍\";")
{
    const line4Start = grid._layout.lineSlotBase[4];
    // Line 4 has 4 leading spaces: cols 0..3 are spaces, cols 4..9 are "return", col 11..21 is string
    const slotRet = grid._renderer.slotBuffer.getSlot(line4Start + 4); // 'r' of return
    const slotStr = grid._renderer.slotBuffer.getSlot(line4Start + 12); // 'w' of "world"

    const kwCol = DEFAULT_SYNTAX_THEME.keyword;
    const strCol = DEFAULT_SYNTAX_THEME.string;

    const rRet = (slotRet.color & 0xFF) / 255;
    const gRet = ((slotRet.color >> 8) & 0xFF) / 255;
    const bRet = ((slotRet.color >> 16) & 0xFF) / 255;
    assert(Math.abs(rRet - kwCol.r) < 0.05 && Math.abs(gRet - kwCol.g) < 0.05 && Math.abs(bRet - kwCol.b) < 0.05,
        `Line 4: 'return' after indentation has keyword color`);

    const rStr = (slotStr.color & 0xFF) / 255;
    const gStr = ((slotStr.color >> 8) & 0xFF) / 255;
    const bStr = ((slotStr.color >> 16) & 0xFF) / 255;
    assert(Math.abs(rStr - strCol.r) < 0.05 && Math.abs(gStr - strCol.g) < 0.05 && Math.abs(bStr - strCol.b) < 0.05,
        `Line 4: string literal with emoji has string color`);
}

grid.dispose();

console.log(`\nsyntax-coloring-align.test: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

import assert from 'node:assert';
import {
    bytesToHexView,
    hexCellSpan,
    byteColor,
    findPointers,
    HEX_ADDR_WIDTH,
    HEX_GUTTER,
    HEX_BYTE_STRIDE,
    decorateMemoryGrid,
    MemoryEdges,
    buildMemoryLegend,
} from '@glyph3d/core';

import {
    bytesToHexView as bytesToHexViewSubpath,
} from '@glyph3d/core/memory';

console.log('Testing Memory Viewer Exports...');

// 1. Basic exports check
assert.strictEqual(typeof bytesToHexView, 'function');
assert.strictEqual(typeof bytesToHexViewSubpath, 'function');
assert.strictEqual(typeof hexCellSpan, 'function');
assert.strictEqual(typeof byteColor, 'function');
assert.strictEqual(typeof findPointers, 'function');
assert.strictEqual(typeof decorateMemoryGrid, 'function');
assert.strictEqual(typeof MemoryEdges, 'function');
assert.strictEqual(typeof buildMemoryLegend, 'function');

// 2. Constants check
assert.strictEqual(HEX_ADDR_WIDTH, 8);
assert.strictEqual(HEX_GUTTER, 10);
assert.strictEqual(HEX_BYTE_STRIDE, 3);

// 3. Hex dump check
const sampleBytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]);
const dump = bytesToHexView(sampleBytes, { cols: 4, baseOffset: 0x1000 });
assert.ok(dump.includes('00001000'));
assert.ok(dump.includes('7f 45 4c 46'));

// 4. Color check
const zeroColor = byteColor(0x00);
assert.strictEqual(zeroColor.r, 0.10);
const asciiColor = byteColor(0x45); // 'E'
assert.strictEqual(asciiColor.g, 0.82);

// 5. Hex cell span check
const span = hexCellSpan(2, 16);
assert.strictEqual(span.line, 0);
assert.strictEqual(span.startCol, 10 + 2 * 3);
assert.strictEqual(span.endCol, span.startCol + 2);

console.log('memory-exports.test: all checks passed');

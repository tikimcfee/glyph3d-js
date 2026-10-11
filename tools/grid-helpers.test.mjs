import assert from 'node:assert';
import {
    cpToU16,
    cpLen,
    clampCursor,
    insertText,
    deleteBackward,
    deleteForward,
    splitLine,
    moveCursor,
    clampWindow,
    sliceWindowText,
    computeMaxScroll,
    clampScroll,
    computeFrameClip,
    computeBackgroundLayout,
    computeCellGridLayout,
} from '../packages/glyph3d-core/src/collections/grid/index.js';


console.log('Testing Grid Helpers...');

// 1. cpToU16 and cpLen
{
    const ascii = 'hello';
    assert.strictEqual(cpLen(ascii), 5);
    assert.strictEqual(cpToU16(ascii, 2), 2);

    const emoji = 'a😀b';
    assert.strictEqual(cpLen(emoji), 3); // 3 codepoints
    assert.strictEqual(cpToU16(emoji, 0), 0);
    assert.strictEqual(cpToU16(emoji, 1), 1);
    assert.strictEqual(cpToU16(emoji, 2), 3); // skips surrogate pair (2 code units)
}

// 2. clampCursor
{
    const lines = ['abc', 'defgh', ''];
    assert.deepStrictEqual(clampCursor(lines, 0, 10), { line: 0, col: 3 });
    assert.deepStrictEqual(clampCursor(lines, 5, 2), { line: 2, col: 0 });
    assert.deepStrictEqual(clampCursor(lines, 1, 2), { line: 1, col: 2 });
}

// 3. insertText
{
    const lines = ['hello world'];
    const cur = { line: 0, col: 5 };
    insertText(lines, cur, ' brave');
    assert.strictEqual(lines[0], 'hello brave world');
    assert.strictEqual(cur.col, 11);

    // Multiline insert
    insertText(lines, cur, '\nnew line\nanother');
    assert.strictEqual(lines.length, 3);
    assert.strictEqual(lines[0], 'hello brave');
    assert.strictEqual(lines[1], 'new line');
    assert.strictEqual(lines[2], 'another world');
    assert.strictEqual(cur.line, 2);
    assert.strictEqual(cur.col, 7);
}

// 4. deleteBackward
{
    const lines = ['first', 'second'];
    const cur = { line: 1, col: 0 };
    deleteBackward(lines, cur);
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0], 'firstsecond');
    assert.strictEqual(cur.line, 0);
    assert.strictEqual(cur.col, 5);

    deleteBackward(lines, cur);
    assert.strictEqual(lines[0], 'firssecond');
    assert.strictEqual(cur.col, 4);
}

// 5. deleteForward
{
    const lines = ['abc', 'def'];
    const cur = { line: 0, col: 3 };
    deleteForward(lines, cur);
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0], 'abcdef');

    cur.col = 1;
    deleteForward(lines, cur);
    assert.strictEqual(lines[0], 'acdef');
}

// 6. splitLine
{
    const lines = ['hello world'];
    const cur = { line: 0, col: 5 };
    splitLine(lines, cur);
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[0], 'hello');
    assert.strictEqual(lines[1], ' world');
    assert.strictEqual(cur.line, 1);
    assert.strictEqual(cur.col, 0);
}

// 7. moveCursor
{
    const lines = ['abc', 'def'];
    let cur = { line: 0, col: 2 };
    cur = moveCursor(lines, cur, 2, 0); // moves past end of line 0 to start of line 1
    assert.deepStrictEqual(cur, { line: 1, col: 0 });

    cur = moveCursor(lines, cur, -3, 0); // moves backward across line boundary
    assert.deepStrictEqual(cur, { line: 0, col: 1 });

    cur = moveCursor(lines, cur, 0, 1); // down 1 row
    assert.deepStrictEqual(cur, { line: 1, col: 1 });
}

// 8. Windowing
{
    assert.strictEqual(clampWindow(10, 100, 20), 10);
    assert.strictEqual(clampWindow(95, 100, 20), 80); // max is 100 - 20 = 80
    assert.strictEqual(clampWindow(-5, 100, 20), 0);

    const source = ['line 1', 'line 2 is long', 'line 3', 'line 4'];
    const sliced = sliceWindowText(source, 1, 2, 6);
    assert.strictEqual(sliced, 'line 2\nline 3');
}

// 9. Frame & Scroll
{
    assert.strictEqual(computeMaxScroll(100, 20), 80);
    assert.strictEqual(computeMaxScroll(100, 0), 100);
    assert.strictEqual(clampScroll(50, 80), 50);
    assert.strictEqual(clampScroll(90, 80), 80);

    const clip = computeFrameClip(0, 10, 1.2);
    assert.strictEqual(clip.top, 0.6);
    assert.strictEqual(clip.bottom, -(9.5 * 1.2));
}

// 10. Background layout
{
    const bounds = { min: { x: -10, y: -20, z: -1 }, max: { x: 10, y: 0, z: 0 }, width: 20, height: 20 };
    const bg = computeBackgroundLayout(bounds, 2, 0, 1.2, 0, 0.1);
    assert.ok(bg);
    assert.strictEqual(bg.width, 24);
    assert.strictEqual(bg.height, 24);
    assert.strictEqual(bg.position.x, 0);
    assert.strictEqual(bg.position.y, -10);
    assert.strictEqual(bg.position.z, -1.1);

    const cellLayout = computeCellGridLayout(80, 24, { charWidth: 10, charHeight: 20, letterSpacing: 2, lineSpacing: 25 }, 0.5, 0.2);
    assert.ok(cellLayout);
    assert.strictEqual(cellLayout.strideX, 12);
    assert.strictEqual(cellLayout.strideY, 25);
    assert.strictEqual(cellLayout.width, 80 * 12 + 1.0);
    assert.strictEqual(cellLayout.height, 24 * 25 + 1.0);
    assert.strictEqual(cellLayout.cx, (80 * 12) / 2 - 5);
    assert.strictEqual(cellLayout.cy, -(24 * 25) / 2 + 12.5);
    assert.strictEqual(cellLayout.z, -0.2);
}

console.log('grid-helpers.test: all checks passed');


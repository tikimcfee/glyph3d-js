// byte-description.test.mjs — the byte-backed layout description: (line,col) ↔ byte-offset
// conversions and mirror-backed position queries, against the reference pipeline as mirror.
//   bun tools/byte-description.test.mjs

import ByteLayoutDescription, { buildByteLineIndex } from '../packages/glyph3d-core/src/core/ByteLayoutDescription.js';
import { runPipeline, SLOT_STRIDE, S_X, S_Y } from '../packages/glyph3d-core/src/compute/glyphPipelineReference.js';
import { buildGlyphTrie } from '../packages/glyph3d-core/src/compute/GlyphTrie.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };

// Monospace fixture atlas (same shape as glyph-pipeline.test).
const CELL_W = 1.2, CELL_H = 1.4;
const SOURCE = new Map();
for (let cp = 0x09; cp <= 0x0D; cp++) SOURCE.set(cp, { glyphId: cp, advance: CELL_W, height: CELL_H });
for (let cp = 0x20; cp <= 0x7E; cp++) SOURCE.set(cp, { glyphId: cp, advance: CELL_W, height: CELL_H });
for (let cp = 0xA0; cp <= 0xFF; cp++) SOURCE.set(cp, { glyphId: cp, advance: CELL_W, height: CELL_H });
for (let cp = 0x4E00; cp <= 0x9FFF; cp++) SOURCE.set(cp, { glyphId: cp, advance: CELL_W * 2, height: CELL_H * 1.15 });
for (let cp = 0x1F600; cp <= 0x1F64F; cp++) SOURCE.set(cp, { glyphId: cp, advance: CELL_W * 2, height: CELL_H });
const trie = buildGlyphTrie(SOURCE.keys(), (cp) => SOURCE.get(cp) || null,
    { missingAdvance: CELL_W, missingHeight: CELL_H });

// ASCII + multibyte (2-byte é, 3-byte CJK, 4-byte emoji) + empty lines + NO trailing newline.
const TEXT = 'ab\n\nhéllo 你 xy😀z\ntail';
const bytes = new TextEncoder().encode(TEXT);
const { lineByteStart, lineLengths } = buildByteLineIndex(bytes);
const mirror = runPipeline(bytes, trie, { wrapWidth: 0, lineHeight: CELL_H });
const desc = new ByteLayoutDescription({ bytes, lineByteStart, lineLengths, mirror });

// ── line index ──
ok(desc.lineCount === 4, `lineCount ${desc.lineCount} != 4`);
ok(lineLengths[0] === 2 && lineLengths[1] === 0 && lineLengths[2] === 12 && lineLengths[3] === 4,
   `lineLengths [${Array.from(lineLengths)}]`);
ok(lineByteStart[2] === 4, `line 2 starts at byte 4 (got ${lineByteStart[2]})`);

// ── (line,col) → byte offset ──  line 2: h é l l o ␣ 你 ␣ x y 😀 z  (cp cols 0..11)
// bytes: h@4 é@5-6 l@7 l@8 o@9 ␣@10 你@11-13 ␣@14 x@15 y@16 😀@17-20 z@21 \n@22
ok(desc.byteOffsetOf(2, 0) === 4, 'line2 col0 = byte 4');
ok(desc.byteOffsetOf(2, 1) === 5, 'line2 col1 = byte 5 (h)');
ok(desc.byteOffsetOf(2, 2) === 7, 'line2 col2 = byte 7 (é is 2 bytes)');
ok(desc.byteOffsetOf(2, 6) === 11, 'line2 col6 = byte 11 (你 is 3 bytes)');
ok(desc.byteOffsetOf(2, 10) === 17, 'line2 col10 = byte 17 (😀 is 4 bytes)');
ok(desc.byteOffsetOf(2, 12) === 22, 'line2 col12 (EOL) = byte 22 (the newline)');
ok(desc.slotForChar(2, 10) === 17, 'slotForChar == byte offset');
ok(desc.slotForChar(2, 12) === -1, 'col == len out of range → -1');

// ── byte offset → (line,col) ──
const rt = desc.charForSlot(17);
ok(rt && rt.line === 2 && rt.col === 10, `charForSlot(17) → ${JSON.stringify(rt)} (want 2:10)`);
ok(desc.charForSlot(5).col === 1 && desc.charForSlot(5).line === 2, 'charForSlot(5) → 2:1');
ok(desc.charForSlot(4).col === 0 && desc.charForSlot(4).line === 2, 'charForSlot(4) → 2:0');
ok(desc.charForSlot(3).line === 1, 'byte 3 (the empty line\'s newline) → line 1');
const nlSlot = desc.charForSlot(22);
ok(nlSlot && nlSlot.line === 2 && nlSlot.col === 12, `the newline slot → (2,12) EOL — got ${JSON.stringify(nlSlot)}`);

// ── positions read the mirror ──
const p00 = desc.positionAt(0, 0);
ok(p00 && p00.x === mirror.slots[0 * SLOT_STRIDE + S_X] && p00.y === mirror.slots[S_Y], 'positionAt(0,0) = slot 0');
// EOL on line 2 = the newline slot, whose x is the line's full advance sum.
const pEol = desc.positionAt(2, 12);
const nlX = mirror.slots[22 * SLOT_STRIDE + S_X];
ok(Math.abs(pEol.x - nlX) < 1e-6, `EOL caret x = newline slot x (${pEol.x} vs ${nlX})`);
// 你 is double-advance: the space after it (col 7) sits 2×CELL_W past 你's x (col 6).
const p7 = desc.positionAt(2, 7);
const p6 = desc.positionAt(2, 6);
ok(Math.abs((p7.x - p6.x) - CELL_W * 2) < 1e-6, `你 occupies a double advance (${(p7.x - p6.x).toFixed(3)})`);
// EOL on the final line (no trailing newline) — the guard path.
const pTail = desc.positionAt(3, 4);
ok(pTail && Number.isFinite(pTail.x), 'final-line EOL caret resolves');
// line 1 (empty) positionAt(1,0) = the line-1 newline slot.
const pEmpty = desc.positionAt(1, 0);
ok(pEmpty && pEmpty.y === mirror.slots[3 * SLOT_STRIDE + S_Y], 'empty line caret = its newline slot');

// ── extent ──
const ext = desc.extent();
ok(ext && ext.width > 0 && ext.height > 0, `extent ${ext?.width}×${ext?.height}`);

console.log(`\n${fail === 0 ? '✓' : '✗'} byte-description: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

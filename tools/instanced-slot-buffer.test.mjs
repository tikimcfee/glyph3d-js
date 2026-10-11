// tools/instanced-slot-buffer.test.mjs — Unit test for InstancedSlotBuffer and LayoutGenerator
// Run with: node tools/instanced-slot-buffer.test.mjs

import * as THREE from 'three';
import {
    InstancedSlotBuffer,
    SLOT_BYTES,
    SLOT_FLOATS,
    packRgba8,
    unpackRgba8,
    OFFSET_POS,
    OFFSET_GLYPH_ID,
    OFFSET_COLOR,
    OFFSET_GROUP_ID,
    OFFSET_ADVANCE,
    OFFSET_HEIGHT,
} from '../packages/glyph3d-core/src/core/InstancedSlotBuffer.js';
import { generateLayout } from '../packages/glyph3d-core/src/core/LayoutGenerator.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${a}, want ${b})`);
const close = (a, b, m, eps = 1e-4) => ok(Math.abs(a - b) <= eps, `${m} (got ${a}, want ${b})`);

console.log('Testing InstancedSlotBuffer binary layout...');

// 1. Stride and offsets match Rust slot.rs (32 bytes, 8 lanes)
eq(SLOT_BYTES, 32, 'SLOT_BYTES is 32');
eq(SLOT_FLOATS, 8, 'SLOT_FLOATS is 8');
eq(OFFSET_POS, 0, 'OFFSET_POS is 0');
eq(OFFSET_GLYPH_ID, 12, 'OFFSET_GLYPH_ID is 12');
eq(OFFSET_COLOR, 16, 'OFFSET_COLOR is 16');
eq(OFFSET_GROUP_ID, 20, 'OFFSET_GROUP_ID is 20');
eq(OFFSET_ADVANCE, 24, 'OFFSET_ADVANCE is 24');
eq(OFFSET_HEIGHT, 28, 'OFFSET_HEIGHT is 28');

// 2. Color packing
{
    const red = packRgba8(1.0, 0.0, 0.0, 1.0);
    eq(red, 0xFF0000FF >>> 0, 'Packed pure red little-endian (r=FF, g=00, b=00, a=FF)');

    const green = packRgba8(0.0, 1.0, 0.0, 1.0);
    eq(green, 0xFF00FF00 >>> 0, 'Packed pure green little-endian');

    const blue = packRgba8(0.0, 0.0, 1.0, 0.5);
    const un = unpackRgba8(blue);
    close(un.r, 0.0, 'Unpacked blue r');
    close(un.g, 0.0, 'Unpacked blue g');
    close(un.b, 1.0, 'Unpacked blue b');
    close(un.a, 0.5, 'Unpacked blue a', 0.01);
}

// 3. Slot write and read
{
    const buf = new InstancedSlotBuffer(4);
    eq(buf.capacity, 4, 'Buffer capacity');
    eq(buf.count, 0, 'Initial count');

    const packedColor = packRgba8(0.2, 0.4, 0.6, 1.0);
    buf.pushSlot(1.5, -2.25, 3.75, 42, packedColor, 7, 0.55, 1.2);
    eq(buf.count, 1, 'Count after 1 push');
    eq(buf.byteLength, 32, 'Byte length after 1 push');

    const s0 = buf.getSlot(0);
    close(s0.pos[0], 1.5, 'pos.x');
    close(s0.pos[1], -2.25, 'pos.y');
    close(s0.pos[2], 3.75, 'pos.z');
    eq(s0.glyphId, 42, 'glyphId');
    eq(s0.color, packedColor, 'packed color');
    eq(s0.groupId, 7, 'groupId');
    close(s0.advance, 0.55, 'advance');
    close(s0.height, 1.2, 'height');

    // Auto-grow capacity
    for (let i = 1; i < 10; i++) {
        buf.pushSlot(i, i, i, i, packedColor, 0, 1.0, 1.0);
    }
    eq(buf.count, 10, 'Count after 10 pushes');
    ok(buf.capacity >= 10, 'Capacity grew to fit');
    eq(buf.byteLength, 320, '10 slots = 320 bytes');
}

// 4. Three.js InterleavedBuffer integration
{
    const buf = new InstancedSlotBuffer(4);
    buf.pushSlot(10, 20, 30, 1, 0xFFFFFFFF, 0, 0.6, 1.2);
    buf.pushSlot(40, 50, 60, 2, 0xFFFFFFFF, 0, 0.6, 1.2);

    const ib = buf.createInterleavedBuffer();
    eq(ib.stride, 8, 'InterleavedBuffer stride is 8');
    eq(ib.count, 2, 'InterleavedBuffer count is 2');

    const geom = new THREE.InstancedBufferGeometry();
    InstancedSlotBuffer.bindGeometryAttributes(geom, ib);

    ok(geom.getAttribute('aPos') instanceof THREE.InterleavedBufferAttribute, 'aPos attribute bound');
    eq(geom.getAttribute('aPos').itemSize, 3, 'aPos itemSize is 3');
    eq(geom.getAttribute('aPos').offset, 0, 'aPos offset is 0');

    ok(geom.getAttribute('aGlyphId') instanceof THREE.InterleavedBufferAttribute, 'aGlyphId attribute bound');
    eq(geom.getAttribute('aGlyphId').itemSize, 1, 'aGlyphId itemSize is 1');
    eq(geom.getAttribute('aGlyphId').offset, 3, 'aGlyphId offset is 3');

    ok(geom.getAttribute('aColor') instanceof THREE.InterleavedBufferAttribute, 'aColor attribute bound');
    eq(geom.getAttribute('aColor').itemSize, 1, 'aColor itemSize is 1');
    eq(geom.getAttribute('aColor').offset, 4, 'aColor offset is 4');

    ok(geom.getAttribute('aGroupId') instanceof THREE.InterleavedBufferAttribute, 'aGroupId attribute bound');
    eq(geom.getAttribute('aGroupId').itemSize, 1, 'aGroupId itemSize is 1');
    eq(geom.getAttribute('aGroupId').offset, 5, 'aGroupId offset is 5');

    ok(geom.getAttribute('aExtent') instanceof THREE.InterleavedBufferAttribute, 'aExtent attribute bound');
    eq(geom.getAttribute('aExtent').itemSize, 2, 'aExtent itemSize is 2');
    eq(geom.getAttribute('aExtent').offset, 6, 'aExtent offset is 6');
}

console.log('Testing LayoutGenerator...');

// 5. LayoutGenerator basic string
{
    const text = 'Hello\nWorld';
    const result = generateLayout(text, {
        metrics: { charWidth: 10, charHeight: 20, lineSpacing: 24, worldScale: 1.0 },
        wrapWidth: 0,
    });

    eq(result.glyphCount, 10, '10 glyphs emitted (5 for Hello + 5 for World)');
    eq(result.totalRows, 2, '2 visual rows');
    eq(result.lineStarts.length, 2, '2 lines');
    eq(result.lineStarts[0], 0, 'Line 0 starts at 0');
    eq(result.lineStarts[1], 5, 'Line 1 starts at 5');

    // Slot 0 ('H'): x=0, y=-10 (pen vertical center = -charHeight/2)
    const s0 = result.buffer.getSlot(0);
    close(s0.pos[0], 0.0, 'Slot 0 x=0');
    close(s0.pos[1], -10.0, 'Slot 0 y=-10');

    // Slot 4 ('o'): x=40, y=-10
    const s4 = result.buffer.getSlot(4);
    close(s4.pos[0], 40.0, 'Slot 4 x=40');
    close(s4.pos[1], -10.0, 'Slot 4 y=-10');

    // Slot 5 ('W'): x=0, y=-34 (-lineSpacing - charHeight/2 = -24 - 10 = -34)
    const s5 = result.buffer.getSlot(5);
    close(s5.pos[0], 0.0, 'Slot 5 x=0');
    close(s5.pos[1], -34.0, 'Slot 5 y=-34');

    // Bounds
    ok(result.bounds.width >= 50, `Bounds width is ${result.bounds.width} >= 50`);
    ok(result.bounds.height >= 44, `Bounds height is ${result.bounds.height} >= 44`);
}

// 6. Intra-line wrapping & Z-stepping
{
    const longLine = '123456789012'; // 12 chars
    const result = generateLayout(longLine, {
        metrics: { charWidth: 10, charHeight: 20, lineSpacing: 24, worldScale: 1.0 },
        wrapWidth: 5, // wraps every 5 chars -> 3 segments (5, 5, 2)
        zWrapSpacing: 0.15, // zStep = 0.15 * 20 = 3
    });

    eq(result.glyphCount, 12, '12 glyphs');
    eq(result.totalRows, 3, '3 visual rows total');

    // Seg 0: slots 0..4 (1..5) at z=0, visualRow 0
    const s0 = result.buffer.getSlot(0);
    close(s0.pos[0], 0.0, 's0 x=0');
    close(s0.pos[1], -10.0, 's0 y=-10');
    close(s0.pos[2], 0.0, 's0 z=0');

    // Seg 1: slot 5 ('6') at x=0, visualRow 1 (y=-34), z=-3
    const s5 = result.buffer.getSlot(5);
    close(s5.pos[0], 0.0, 's5 wraps to x=0');
    close(s5.pos[1], -34.0, 's5 y=-34');
    close(s5.pos[2], -3.0, 's5 z=-3.0');

    // Seg 2: slot 10 ('1') at x=0, visualRow 2 (y=-58), z=-6
    const s10 = result.buffer.getSlot(10);
    close(s10.pos[0], 0.0, 's10 wraps to x=0');
    close(s10.pos[1], -58.0, 's10 y=-58');
    close(s10.pos[2], -6.0, 's10 z=-6.0');
}

// 7. Deterministic drawing order verification
{
    const text = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
    const result1 = generateLayout(text);
    const result2 = generateLayout(text);

    eq(result1.glyphCount, result2.glyphCount, 'Repeated layout produces identical glyph count');
    let orderEqual = true;
    for (let i = 0; i < result1.glyphCount; i++) {
        const s1 = result1.buffer.getSlot(i);
        const s2 = result2.buffer.getSlot(i);
        if (s1.pos[0] !== s2.pos[0] || s1.pos[1] !== s2.pos[1] || s1.pos[2] !== s2.pos[2] || s1.glyphId !== s2.glyphId) {
            orderEqual = false;
            break;
        }
    }
    ok(orderEqual, 'Deterministic draw order: repeated runs produce bit-identical slot positions and order');
}

// 8. InstancedField end-to-end integration test
{
    const { default: InstancedField } = await import('../packages/glyph3d-core/src/collections/InstancedField.js');
    const field = new InstancedField(null, null, { maxInstances: 100 });

    eq(field.getGlyphCount(), 0, 'Initial glyph count is 0');
    field.loadText('Alpha\nBeta\nGamma');
    eq(field.getGlyphCount(), 14, '14 glyphs loaded into InstancedField');
    eq(field.geometry.instanceCount, 14, 'Geometry instanceCount matches');

    // Group transform
    field.setGroupOffset(0, { x: 5, y: 10, z: 15 });
    field.setGroupScale(0, 2.0);
    field.setClipYRange(100, -100);

    // Slot modification
    const bluePacked = packRgba8(0, 0, 1, 1);
    field.writeColor(0, bluePacked);
    eq(field.slotBuffer.getSlot(0).color, bluePacked, 'Slot 0 color updated to blue');

    // Highlight
    field.setGlyphHighlight(0, { r: 1, g: 1, b: 0 }, 0.8);
    ok(field._highlightTexture !== null, 'Highlight texture created');
    eq(field._highlightTexture.image.data[0], 255, 'Highlight R=255');
    eq(field._highlightTexture.image.data[1], 255, 'Highlight G=255');
    eq(field._highlightTexture.image.data[2], 0, 'Highlight B=0');
    eq(field._highlightTexture.image.data[3], Math.round(0.8 * 255), 'Highlight Fill=0.8');

    field.dispose();
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);


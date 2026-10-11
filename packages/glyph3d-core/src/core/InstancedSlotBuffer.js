/**
 * InstancedSlotBuffer — 32-byte RenderSlot binary buffer for WebGL2 instanced rendering.
 *
 * Mirrors the field order of glyph3d-rs/crates/glyph-field-instanced/src/slot.rs.
 * Total Stride: 32 Bytes (8 x 4-byte lanes)
 *
 * Offset (Bytes)  Type      Field       Description
 * 0..11           vec3<f32> pos         World-space pen origin (left edge, cell-vertical center)
 * 12..15          f32       glyph_id    FontChain global glyph slot (keys glyphmap texture)
 * 16..19          f32       color       Packed RGB888 value (sRGB display color, r in the low byte)
 * 20..23          f32       group_id    Index into group table (pose/clipping/alpha)
 * 24..27          f32       advance     Cell advance / width in world units
 * 28..31          f32       height      Cell height in world units
 *
 * Every lane is a float attribute to WebGL2 (`in float aGlyphId`), so glyph_id, color
 * and group_id hold integer VALUES in f32 lanes, exact up to 2^24 — not u32 bit patterns
 * as in slot.rs. Alpha lives in the group table, not the slot. Write lanes through the
 * setters below; there is no integer view.
 */

import * as THREE from 'three';

export const SLOT_BYTES = 32;
export const SLOT_FLOATS = 8;

export const LANE_POS_X = 0;
export const LANE_POS_Y = 1;
export const LANE_POS_Z = 2;
export const LANE_GLYPH_ID = 3;
export const LANE_COLOR = 4;
export const LANE_GROUP_ID = 5;
export const LANE_ADVANCE = 6;
export const LANE_HEIGHT = 7;

export const OFFSET_POS = 0;      // 0 bytes
export const OFFSET_GLYPH_ID = 12; // 12 bytes
export const OFFSET_COLOR = 16;   // 16 bytes
export const OFFSET_GROUP_ID = 20; // 20 bytes
export const OFFSET_ADVANCE = 24;  // 24 bytes
export const OFFSET_HEIGHT = 28;   // 28 bytes

/**
 * Pack r, g, b, a (0..1 floats or 0..255 ints) into a little-endian uint32 RGBA8.
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {number} [a=1.0]
 * @returns {number} 32-bit unsigned integer
 */
export function packRgba8(r, g, b, a = 1.0) {
    const rb = Math.max(0, Math.min(255, Math.round(r <= 1.0 && r >= 0.0 && (g <= 1.0 || b <= 1.0) ? r * 255 : r)));
    const gb = Math.max(0, Math.min(255, Math.round(g <= 1.0 && g >= 0.0 ? g * 255 : g)));
    const bb = Math.max(0, Math.min(255, Math.round(b <= 1.0 && b >= 0.0 ? b * 255 : b)));
    const ab = Math.max(0, Math.min(255, Math.round(a <= 1.0 && a >= 0.0 ? a * 255 : a)));
    return ((rb | (gb << 8) | (bb << 16) | (ab << 24)) >>> 0);
}

/**
 * Unpack a little-endian uint32 RGBA8 into 0..1 floats.
 * @param {number} packed
 * @returns {{ r: number, g: number, b: number, a: number }}
 */
export function unpackRgba8(packed) {
    const r = (packed & 0xFF) / 255.0;
    const g = ((packed >>> 8) & 0xFF) / 255.0;
    const b = ((packed >>> 16) & 0xFF) / 255.0;
    const a = ((packed >>> 24) & 0xFF) / 255.0;
    return { r, g, b, a };
}

/**
 * InstancedSlotBuffer manages an ArrayBuffer of 32-byte RenderSlot records through
 * one zero-copy Float32Array view.
 */
export class InstancedSlotBuffer {
    /**
     * @param {number} [initialCapacity=256] Initial number of slots
     */
    constructor(initialCapacity = 256) {
        this._capacity = Math.max(1, initialCapacity);
        this._count = 0;
        this.buffer = new ArrayBuffer(this._capacity * SLOT_BYTES);
        this.f32 = new Float32Array(this.buffer);
    }

    /** Number of active slots */
    get count() {
        return this._count;
    }

    set count(val) {
        this._count = val;
    }

    /** Float32Array view alias */
    get float32() {
        return this.f32;
    }

    /** Slot capacity */
    get capacity() {
        return this._capacity;
    }

    /** Total byte length of active slots */
    get byteLength() {
        return this._count * SLOT_BYTES;
    }

    /** Clear active slots (does not deallocate buffer) */
    clear() {
        this._count = 0;
    }

    /**
     * Ensure capacity for at least minSlots. Doubles capacity as needed.
     * @param {number} minSlots
     */
    ensureCapacity(minSlots) {
        if (minSlots <= this._capacity) return;
        let newCap = Math.max(minSlots, this._capacity * 2);
        const newBuffer = new ArrayBuffer(newCap * SLOT_BYTES);
        new Uint8Array(newBuffer).set(new Uint8Array(this.buffer, 0, this._count * SLOT_BYTES));
        this.buffer = newBuffer;
        this.f32 = new Float32Array(this.buffer);
        this._capacity = newCap;
    }

    /**
     * Write a slot at the given index.
     * @param {number} index
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {number} glyphId
     * @param {number} packedColor
     * @param {number} groupId
     * @param {number} advance
     * @param {number} height
     */
    setSlot(index, x, y, z, glyphId, packedColor, groupId, advance, height) {
        const base = index * SLOT_FLOATS;
        this.f32[base + LANE_POS_X] = x;
        this.f32[base + LANE_POS_Y] = y;
        this.f32[base + LANE_POS_Z] = z;
        this.f32[base + LANE_GLYPH_ID] = glyphId;
        this.f32[base + LANE_COLOR] = (packedColor & 0xFFFFFF);
        this.f32[base + LANE_GROUP_ID] = groupId;
        this.f32[base + LANE_ADVANCE] = advance;
        this.f32[base + LANE_HEIGHT] = height;
    }

    /**
     * Write slot accepting either positional args or an object.
     * @param {number} index
     * @param {number|Object} x - x coordinate or slot descriptor object
     */
    writeSlot(index, x, y, z, glyphId, packedColor, groupId, advance, height) {
        if (x != null && typeof x === 'object') {
            const o = x;
            this.setSlot(
                index,
                o.x ?? o.pos?.[0] ?? 0,
                o.y ?? o.pos?.[1] ?? 0,
                o.z ?? o.pos?.[2] ?? 0,
                o.glyphId ?? 0,
                o.color ?? 0,
                o.groupId ?? 0,
                o.advance ?? 1,
                o.height ?? 1
            );
        } else {
            this.setSlot(index, x, y, z, glyphId, packedColor, groupId, advance, height);
        }
    }

    /**
     * Append a slot to the buffer, growing if necessary.
     * @returns {number} index of added slot
     */
    pushSlot(x, y, z, glyphId, packedColor, groupId, advance, height) {
        const idx = this._count;
        this.ensureCapacity(idx + 1);
        this.setSlot(idx, x, y, z, glyphId, packedColor, groupId, advance, height);
        this._count++;
        return idx;
    }

    /**
     * Read a slot as a plain object (for tests/debugging).
     * @param {number} index
     * @returns {{ pos: [number, number, number], glyphId: number, color: number, groupId: number, advance: number, height: number }}
     */
    getSlot(index) {
        const base = index * SLOT_FLOATS;
        const rgb = Math.round(this.f32[base + LANE_COLOR]);
        const color = (rgb | 0xFF000000) >>> 0;
        return {
            pos: [this.f32[base + LANE_POS_X], this.f32[base + LANE_POS_Y], this.f32[base + LANE_POS_Z]],
            glyphId: Math.round(this.f32[base + LANE_GLYPH_ID]),
            color: color,
            groupId: Math.round(this.f32[base + LANE_GROUP_ID]),
            advance: this.f32[base + LANE_ADVANCE],
            height: this.f32[base + LANE_HEIGHT],
        };
    }

    /**
     * Update color of a slot.
     * @param {number} index
     * @param {number} packedColor
     */
    setColor(index, packedColor) {
        this.f32[index * SLOT_FLOATS + LANE_COLOR] = (packedColor & 0xFFFFFF);
    }

    /**
     * Update the glyph id of a slot.
     * @param {number} index
     * @param {number} glyphId
     */
    setGlyphId(index, glyphId) {
        this.f32[index * SLOT_FLOATS + LANE_GLYPH_ID] = glyphId;
    }

    /**
     * Update position of a slot.
     * @param {number} index
     * @param {number} x
     * @param {number} y
     * @param {number} z
     */
    setPosition(index, x, y, z) {
        const base = index * SLOT_FLOATS;
        this.f32[base + LANE_POS_X] = x;
        this.f32[base + LANE_POS_Y] = y;
        this.f32[base + LANE_POS_Z] = z;
    }

    /**
     * Create a Three.js InstancedInterleavedBuffer over this buffer.
     * Stride is 8 floats (32 bytes).
     * @param {number} [usage=THREE.DynamicDrawUsage]
     * @returns {THREE.InstancedInterleavedBuffer}
     */
    createInterleavedBuffer(usage = THREE.DynamicDrawUsage) {
        const slots = Math.max(this._count, 1);
        const view = new Float32Array(this.buffer, 0, slots * SLOT_FLOATS);
        const ib = new THREE.InstancedInterleavedBuffer(view, SLOT_FLOATS, 1);
        ib.setUsage(usage);
        return ib;
    }

    /**
     * Bind standard Three.js attributes to an InstancedBufferGeometry using an InterleavedBuffer.
     * @param {THREE.InstancedBufferGeometry} geometry
     * @param {THREE.InterleavedBuffer} interleavedBuffer
     */
    static bindGeometryAttributes(geometry, interleavedBuffer) {
        // aPos: vec3 (float, offset 0)
        geometry.setAttribute('aPos', new THREE.InterleavedBufferAttribute(interleavedBuffer, 3, LANE_POS_X, false));
        // aGlyphId: float (offset 3)
        geometry.setAttribute('aGlyphId', new THREE.InterleavedBufferAttribute(interleavedBuffer, 1, LANE_GLYPH_ID, false));
        // aColor: float (packed 24-bit RGB, offset 4)
        geometry.setAttribute('aColor', new THREE.InterleavedBufferAttribute(interleavedBuffer, 1, LANE_COLOR, false));
        // aGroupId: float (offset 5)
        geometry.setAttribute('aGroupId', new THREE.InterleavedBufferAttribute(interleavedBuffer, 1, LANE_GROUP_ID, false));
        // aExtent: vec2 (advance, height, offset 6)
        geometry.setAttribute('aExtent', new THREE.InterleavedBufferAttribute(interleavedBuffer, 2, LANE_ADVANCE, false));
    }
}

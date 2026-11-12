/**
 * Slug rendering constants — shared between the Slug encode + atlas (CPU) and the shaders (GPU).
 *
 * Both Slug textures are RGBA32Uint (THREE.RGBAIntegerFormat + UnsignedIntType),
 * read via textureLoad in TSL. Coordinates are normalized to [0,1] per-glyph
 * cell and packed as uint16 values (0-65535) stored in the 32-bit channels —
 * three's WebGPU backend has no 16-bit integer texture path, only 32-bit.
 *
 * curveTexture:    2 texels/curve  [P0.x, P0.y, P1.x, P1.y] [P2.x, P2.y, _, _]
 * glyphMapTexture: 1 texel/glyph   [curveStart, curveCount, _, _]
 */

/** Number of texels consumed per quadratic bezier curve in curveTexture */
export const CURVE_TEXELS_PER_CURVE = 2;

/** Width of all Slug DataTextures (matches existing highlight texture convention) */
export const TEXTURE_WIDTH = 1024;

/** Uint32 values one curve occupies in the curve texture (its two RGBA texels). */
export const CURVE_U32_PER_CURVE = CURVE_TEXELS_PER_CURVE * 4;

/**
 * Rows each Slug texture is born with. Both textures are allocated at a CAPACITY, not at
 * their used size: new glyphs append into the spare rows and only the touched texels are
 * uploaded. A texture is reallocated (doubling its rows) only when an append would overrun
 * it — a new texture object every field rebinds to, amortized over the doublings.
 * 64 curve rows = 32,768 curves; 4 map rows = 4,096 slots.
 */
export const CURVE_INITIAL_ROWS = 64;
export const MAP_INITIAL_ROWS = 4;

/**
 * Pack a [0,1] normalized float to uint16.
 * @param {number} value - Normalized value in [0,1]
 * @returns {number} Integer in [0, 65535]
 */
export function packUint16(value) {
    return Math.round(Math.max(0, Math.min(1, value)) * 65535);
}

/**
 * Unpack a uint16 back to [0,1] normalized float.
 * @param {number} bits - Integer in [0, 65535]
 * @returns {number} Normalized value in [0,1]
 */
export function unpackUint16(bits) {
    return bits / 65535;
}

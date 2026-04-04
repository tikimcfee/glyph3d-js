/**
 * Slug rendering constants — shared between SlugEncoder (CPU) and shaders (GPU).
 *
 * All three Slug textures use RGBA16UI with usampler2D + texelFetch.
 * Coordinates are normalized to [0,1] per-glyph cell and packed as uint16 (0-65535).
 */

/** Maximum horizontal/vertical bands per glyph axis */
export const MAX_BANDS = 16;

/** Maximum curves that can be referenced by a single band */
export const MAX_CURVES_PER_BAND = 64;

/** Number of texels consumed per quadratic bezier curve in curveTexture */
export const CURVE_TEXELS_PER_CURVE = 2;

/** Width of all Slug DataTextures (matches existing highlight texture convention) */
export const TEXTURE_WIDTH = 1024;

/**
 * Texture format specifications for all three Slug textures.
 *
 * All use RGBA16UI:
 *   - internalFormat: 'RGBA16UI'
 *   - THREE.RGBAIntegerFormat
 *   - THREE.UnsignedShortType
 *   - usampler2D in GLSL
 *   - texelFetch() for reads (not texture())
 *   - NearestFilter, no mipmaps
 *
 * curveTexture:    2 texels/curve  [P0.x, P0.y, P1.x, P1.y] [P2.x, P2.y, _, _]
 * bandTexture:     flat layout — band headers + curve entries interleaved per glyph
 * glyphMapTexture: 1 texel/glyph  [curveStart, curveCount, bandHeaderStart, bandCount]
 */
export const SLUG_TEXTURE_FORMAT = {
    internalFormat: 'RGBA16UI',
    // These are string keys for THREE.js constants, resolved at texture creation time
    format: 'RGBAIntegerFormat',
    type: 'UnsignedShortType',
};

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

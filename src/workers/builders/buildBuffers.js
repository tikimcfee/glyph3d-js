/**
 * buildBuffers - Pure function to convert glyphs to GPU-ready Float32Arrays
 *
 * Takes glyph objects and produces typed arrays ready for GPU upload.
 * No side effects, no DOM, no WebGL - pure computation.
 *
 * Extracted from GlyphRendererV15._updateInstanceMesh() for Web Worker usage.
 */

/**
 * Build GPU-ready Float32Arrays from glyph objects
 *
 * PURE FUNCTION: Same input always produces same output.
 * No side effects, no state mutation.
 *
 * Buffer formats match GlyphRendererV15 shader requirements:
 * - positions: Float32Array [x, y, z] per glyph (3 floats each)
 * - sizes: Float32Array [width, height] per glyph (2 floats each)
 * - uvs: Float32Array [u0, v1, u1, v0] per glyph (4 floats each, V-flipped!)
 * - colors: Float32Array [r, g, b] per glyph (3 floats each)
 *
 * CRITICAL: UV V-flip is applied here for canvas→WebGL coordinate conversion.
 * Canvas uses top-left origin, WebGL uses bottom-left.
 *
 * @param {Array<{position: {x,y,z}, size: {width,height}, uv: {u0,v0,u1,v1}, color: {r,g,b}}>} glyphs
 * @returns {{positions: Float32Array, sizes: Float32Array, uvs: Float32Array, colors: Float32Array, count: number}}
 */
export function buildBuffers(glyphs) {
    const count = glyphs.length;

    // Pre-allocate typed arrays
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count * 2);
    const uvs = new Float32Array(count * 4);
    const colors = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
        const g = glyphs[i];

        // Position [x, y, z]
        positions[i * 3] = g.position.x;
        positions[i * 3 + 1] = g.position.y;
        positions[i * 3 + 2] = g.position.z;

        // Size [width, height]
        sizes[i * 2] = g.size.width;
        sizes[i * 2 + 1] = g.size.height;

        // UV coordinates with V-flip for canvas texture
        // Canvas: top-left origin, WebGL: bottom-left origin
        // This matches GlyphRendererV15._updateInstanceMesh lines 515-525
        const u0 = g.uv.u0;
        const v0 = 1.0 - g.uv.v0;  // Flip V
        const u1 = g.uv.u1;
        const v1 = 1.0 - g.uv.v1;  // Flip V

        uvs[i * 4] = u0;
        uvs[i * 4 + 1] = v1;    // Bottom-left (note: v1 after flip)
        uvs[i * 4 + 2] = u1;
        uvs[i * 4 + 3] = v0;    // Top-right (note: v0 after flip)

        // Color [r, g, b]
        colors[i * 3] = g.color.r;
        colors[i * 3 + 1] = g.color.g;
        colors[i * 3 + 2] = g.color.b;
    }

    return {
        positions,
        sizes,
        uvs,
        colors,
        count
    };
}

export default buildBuffers;

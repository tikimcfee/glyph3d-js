/**
 * Glyph Builder Pipeline - Optimized for performance
 *
 * Single-pass text → Float32Array conversion.
 * No intermediate objects, no spread operators.
 */

/**
 * Count renderable glyphs in text (excludes spaces and newlines)
 */
function countGlyphs(text) {
    let count = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        // Skip space (32), newline (10), carriage return (13), tab (9)
        if (c !== 32 && c !== 10 && c !== 13 && c !== 9) {
            count++;
        }
    }
    return count;
}

/**
 * Build glyph buffers from text - single pass, no intermediate objects
 *
 * @param {Object} input
 * @param {string} input.text
 * @param {{x,y,z}} input.position
 * @param {Object} input.metrics
 * @param {Object} input.uvMap
 * @param {{r,g,b}} input.color
 * @param {number} [input.scale=1.0]
 * @returns {{positions: Float32Array, sizes: Float32Array, uvs: Float32Array, colors: Float32Array, count: number, bounds: Object|null}}
 */
export function buildGlyphBuffers(input) {
    const { text, position, metrics, uvMap, color, scale = 1.0 } = input;

    if (!text || text.length === 0) {
        return {
            positions: new Float32Array(0),
            sizes: new Float32Array(0),
            uvs: new Float32Array(0),
            colors: new Float32Array(0),
            count: 0,
            bounds: null
        };
    }

    // Pre-count glyphs to allocate exact buffer sizes
    const glyphCount = countGlyphs(text);

    // Allocate buffers
    const positions = new Float32Array(glyphCount * 3);
    const sizes = new Float32Array(glyphCount * 2);
    const uvs = new Float32Array(glyphCount * 4);
    const colors = new Float32Array(glyphCount * 3);

    // Pre-compute scaled sizes
    const scaledWidth = metrics.charWidth * scale;
    const scaledHeight = metrics.charHeight * scale;

    // Track bounds
    let minX = Infinity, maxX = -Infinity;
    let minY = position.y, maxY = position.y + metrics.charHeight;

    // Cursor position
    let x = position.x;
    let y = position.y;
    const z = position.z;

    // Fill buffers in single pass
    let idx = 0;
    for (let i = 0; i < text.length; i++) {
        const charCode = text.charCodeAt(i);

        // Newline - reset x, advance y
        if (charCode === 10) {
            if (x > position.x) maxX = Math.max(maxX, x - metrics.letterSpacing);
            x = position.x;
            y -= metrics.lineSpacing;
            minY = y;
            continue;
        }

        // Skip other whitespace but advance cursor for spaces
        if (charCode === 32) {
            if (minX === Infinity) minX = x;
            x += metrics.charWidth + metrics.letterSpacing;
            continue;
        }
        if (charCode === 13 || charCode === 9) continue;

        // Track minX
        if (minX === Infinity) minX = x;

        // Get UV (fallback to '?' = 63)
        const uv = uvMap[charCode] || uvMap[63];
        if (!uv) {
            x += metrics.charWidth + metrics.letterSpacing;
            continue;
        }

        // Position [x, y, z]
        positions[idx * 3] = x;
        positions[idx * 3 + 1] = y;
        positions[idx * 3 + 2] = z;

        // Size [width, height]
        sizes[idx * 2] = scaledWidth;
        sizes[idx * 2 + 1] = scaledHeight;

        // UV with V-flip [u0, v1, u1, v0]
        uvs[idx * 4] = uv.u0;
        uvs[idx * 4 + 1] = 1.0 - uv.v1;
        uvs[idx * 4 + 2] = uv.u1;
        uvs[idx * 4 + 3] = 1.0 - uv.v0;

        // Color [r, g, b]
        colors[idx * 3] = color.r;
        colors[idx * 3 + 1] = color.g;
        colors[idx * 3 + 2] = color.b;

        idx++;
        x += metrics.charWidth + metrics.letterSpacing;
    }

    // Final line maxX
    if (x > position.x) maxX = Math.max(maxX, x - metrics.letterSpacing);

    const bounds = idx > 0 ? {
        min: { x: minX, y: minY, z },
        max: { x: maxX, y: maxY, z },
        width: maxX - minX,
        height: maxY - minY
    } : null;

    return { positions, sizes, uvs, colors, count: idx, bounds };
}

/**
 * Z-depth wrapping configuration
 * When a line exceeds maxLineWidth characters without a newline,
 * wrap in Z-depth (behind) instead of Y (down).
 * This keeps files with extremely long lines more compact.
 */
const Z_WRAP_CONFIG = {
    maxLineWidth: 200,    // Characters before Z-wrap (0 = disabled)
    zWrapSpacing: 3.0     // Z spacing multiplier (relative to charHeight)
};

/**
 * Build buffers for multiple texts - single pass per text, direct to combined buffers
 *
 * @param {Array<{text, position, color?, scale?}>} items
 * @param {Object} shared - {metrics, uvMap, defaultColor}
 * @returns {{positions: Float32Array, sizes: Float32Array, uvs: Float32Array, colors: Float32Array, count: number, bounds: Object|null}}
 */
export function buildBatchBuffers(items, shared) {
    const { metrics, uvMap, defaultColor } = shared;

    // Z-depth wrapping settings
    const maxLineWidth = Z_WRAP_CONFIG.maxLineWidth;
    const zWrapSpacing = metrics.charHeight * Z_WRAP_CONFIG.zWrapSpacing;

    // First pass: count total glyphs
    let totalGlyphs = 0;
    for (let i = 0; i < items.length; i++) {
        totalGlyphs += countGlyphs(items[i].text);
    }

    if (totalGlyphs === 0) {
        return {
            positions: new Float32Array(0),
            sizes: new Float32Array(0),
            uvs: new Float32Array(0),
            colors: new Float32Array(0),
            count: 0,
            bounds: null
        };
    }

    // Allocate combined buffers
    const positions = new Float32Array(totalGlyphs * 3);
    const sizes = new Float32Array(totalGlyphs * 2);
    const uvs = new Float32Array(totalGlyphs * 4);
    const colors = new Float32Array(totalGlyphs * 3);

    // Track combined bounds
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    let bufferOffset = 0;

    // Second pass: fill buffers
    for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
        const item = items[itemIdx];
        const text = item.text;
        const pos = item.position;
        const color = item.color || defaultColor;
        const scale = item.scale || 1.0;

        if (!text || text.length === 0) continue;

        const scaledWidth = metrics.charWidth * scale;
        const scaledHeight = metrics.charHeight * scale;

        let x = pos.x;
        let y = pos.y;
        let z = pos.z;
        const startZ = pos.z;
        let charsOnSegment = 0;  // Track chars since last wrap/newline

        // Track per-item bounds for combined bounds
        let itemMinX = Infinity, itemMaxX = -Infinity;
        let itemMinY = y, itemMaxY = y + metrics.charHeight;
        let itemMinZ = z, itemMaxZ = z;

        for (let i = 0; i < text.length; i++) {
            const charCode = text.charCodeAt(i);

            if (charCode === 10) {
                // Newline: reset x, advance y, reset z
                if (x > pos.x) itemMaxX = Math.max(itemMaxX, x - metrics.letterSpacing);
                x = pos.x;
                y -= metrics.lineSpacing;
                z = startZ;  // Reset Z for new logical line
                itemMinY = y;
                charsOnSegment = 0;
                continue;
            }

            // Z-depth wrap check (before rendering char)
            if (maxLineWidth > 0 && charsOnSegment >= maxLineWidth) {
                if (x > pos.x) itemMaxX = Math.max(itemMaxX, x - metrics.letterSpacing);
                x = pos.x;
                z -= zWrapSpacing;  // Go "behind" (negative Z)
                itemMinZ = Math.min(itemMinZ, z);
                charsOnSegment = 0;
            }

            if (charCode === 32) {
                if (itemMinX === Infinity) itemMinX = x;
                x += metrics.charWidth + metrics.letterSpacing;
                charsOnSegment++;
                continue;
            }
            if (charCode === 13 || charCode === 9) continue;

            if (itemMinX === Infinity) itemMinX = x;

            const uv = uvMap[charCode] || uvMap[63];
            if (!uv) {
                x += metrics.charWidth + metrics.letterSpacing;
                charsOnSegment++;
                continue;
            }

            const idx = bufferOffset;

            positions[idx * 3] = x;
            positions[idx * 3 + 1] = y;
            positions[idx * 3 + 2] = z;

            sizes[idx * 2] = scaledWidth;
            sizes[idx * 2 + 1] = scaledHeight;

            uvs[idx * 4] = uv.u0;
            uvs[idx * 4 + 1] = 1.0 - uv.v1;
            uvs[idx * 4 + 2] = uv.u1;
            uvs[idx * 4 + 3] = 1.0 - uv.v0;

            colors[idx * 3] = color.r;
            colors[idx * 3 + 1] = color.g;
            colors[idx * 3 + 2] = color.b;

            bufferOffset++;
            x += metrics.charWidth + metrics.letterSpacing;
            charsOnSegment++;
        }

        // Final line
        if (x > pos.x) itemMaxX = Math.max(itemMaxX, x - metrics.letterSpacing);
        itemMaxZ = Math.max(itemMaxZ, startZ);

        // Accumulate to combined bounds
        if (itemMinX !== Infinity) {
            minX = Math.min(minX, itemMinX);
            maxX = Math.max(maxX, itemMaxX);
            minY = Math.min(minY, itemMinY);
            maxY = Math.max(maxY, itemMaxY);
            minZ = Math.min(minZ, itemMinZ);
            maxZ = Math.max(maxZ, itemMaxZ);
        }
    }

    const bounds = bufferOffset > 0 ? {
        min: { x: minX, y: minY, z: minZ },
        max: { x: maxX, y: maxY, z: maxZ },
        width: maxX - minX,
        height: maxY - minY,
        depth: maxZ - minZ
    } : null;

    return { positions, sizes, uvs, colors, count: bufferOffset, bounds };
}

export default buildGlyphBuffers;

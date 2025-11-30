/**
 * InstanceBuffer
 *
 * Builds instance attribute arrays for GPU text rendering.
 * Handles character positioning, UV mapping, and color assignment.
 */

class InstanceBuffer {
    /**
     * Create instance buffer data from text string
     * @param {string} text - Text to render
     * @param {GlyphAtlas} atlas - Glyph atlas for UV lookup
     * @param {Object} options - Rendering options
     * @param {Object} options.position - Base position {x, y, z}
     * @param {Object} options.color - Text color {r, g, b}
     * @param {Object} options.charSize - Character dimensions {width, height}
     * @param {string} options.alignment - Text alignment ('left', 'center', 'right')
     * @returns {Object} Instance attribute arrays
     */
    static fromText(text, atlas, options = {}) {
        const {
            position = { x: 0, y: 0, z: 0 },
            color = { r: 0.0, g: 1.0, b: 0.0 },
            charSize,
            alignment = 'center'
        } = options;

        const count = text.length;
        if (count === 0) {
            return this._emptyBuffer();
        }

        // Calculate character dimensions if not provided
        let charWidth, charHeight;
        if (charSize) {
            charWidth = charSize.width;
            charHeight = charSize.height;
        } else {
            const size = atlas.getCharSize();
            charWidth = size.width / 50;  // Normalize to world units
            charHeight = size.height / 50;
        }

        // Calculate text alignment offset
        const totalWidth = count * charWidth;
        let startX = 0;
        if (alignment === 'center') {
            startX = -totalWidth / 2;
        } else if (alignment === 'right') {
            startX = -totalWidth;
        }
        // 'left' alignment uses startX = 0

        // Allocate typed arrays for instance attributes
        const positions = new Float32Array(count * 3);
        const sizes = new Float32Array(count * 2);
        const uvs = new Float32Array(count * 4);
        const colors = new Float32Array(count * 3);

        // Build instance data for each character
        for (let i = 0; i < count; i++) {
            const char = text[i];
            const charCode = char.charCodeAt(0);
            const uv = atlas.getUV(charCode);

            // Position (world space)
            positions[i * 3 + 0] = position.x + startX + i * charWidth;
            positions[i * 3 + 1] = position.y;
            positions[i * 3 + 2] = position.z;

            // Size
            sizes[i * 2 + 0] = charWidth;
            sizes[i * 2 + 1] = charHeight;

            // UV coordinates (with V flip for canvas texture)
            const u0 = uv.u0;
            const v0 = 1.0 - uv.v0;
            const u1 = uv.u1;
            const v1 = 1.0 - uv.v1;

            uvs[i * 4 + 0] = u0;
            uvs[i * 4 + 1] = v1;  // Bottom-left
            uvs[i * 4 + 2] = u1;
            uvs[i * 4 + 3] = v0;  // Top-right

            // Color
            colors[i * 3 + 0] = color.r;
            colors[i * 3 + 1] = color.g;
            colors[i * 3 + 2] = color.b;
        }

        return {
            position: positions,
            size: sizes,
            uv: uvs,
            color: colors,
            count: count
        };
    }

    /**
     * Create empty buffer for zero-length text
     * @returns {Object} Empty attribute arrays
     * @private
     */
    static _emptyBuffer() {
        return {
            position: new Float32Array(0),
            size: new Float32Array(0),
            uv: new Float32Array(0),
            color: new Float32Array(0),
            count: 0
        };
    }

    /**
     * Create instance buffer for multi-line text
     * @param {string[]} lines - Array of text lines
     * @param {GlyphAtlas} atlas - Glyph atlas
     * @param {Object} options - Rendering options
     * @param {number} options.lineSpacing - Vertical spacing between lines
     * @returns {Object} Combined instance attribute arrays
     */
    static fromLines(lines, atlas, options = {}) {
        const {
            position = { x: 0, y: 0, z: 0 },
            color = { r: 0.0, g: 1.0, b: 0.0 },
            charSize,
            alignment = 'left',
            lineSpacing = 1.2
        } = options;

        // Calculate character dimensions
        let charHeight;
        if (charSize) {
            charHeight = charSize.height;
        } else {
            const size = atlas.getCharSize();
            charHeight = size.height / 50;
        }

        const lineHeight = charHeight * lineSpacing;
        const allBuffers = [];
        let totalCount = 0;

        // Build buffer for each line
        lines.forEach((line, lineIndex) => {
            const yOffset = position.y - lineIndex * lineHeight;
            const lineOptions = {
                position: { x: position.x, y: yOffset, z: position.z },
                color,
                charSize,
                alignment
            };

            const buffer = this.fromText(line, atlas, lineOptions);
            allBuffers.push(buffer);
            totalCount += buffer.count;
        });

        // Combine all line buffers into single buffer
        if (totalCount === 0) {
            return this._emptyBuffer();
        }

        const combinedPositions = new Float32Array(totalCount * 3);
        const combinedSizes = new Float32Array(totalCount * 2);
        const combinedUVs = new Float32Array(totalCount * 4);
        const combinedColors = new Float32Array(totalCount * 3);

        let offset = 0;
        allBuffers.forEach(buffer => {
            if (buffer.count > 0) {
                combinedPositions.set(buffer.position, offset * 3);
                combinedSizes.set(buffer.size, offset * 2);
                combinedUVs.set(buffer.uv, offset * 4);
                combinedColors.set(buffer.color, offset * 3);
                offset += buffer.count;
            }
        });

        return {
            position: combinedPositions,
            size: combinedSizes,
            uv: combinedUVs,
            color: combinedColors,
            count: totalCount
        };
    }
}

export default InstanceBuffer;

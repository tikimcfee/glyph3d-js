/**
 * layoutText - Pure function for text layout
 *
 * Converts text into positioned coordinates.
 * No side effects, no DOM, no WebGL - pure computation.
 *
 * Extracted from GlyphLayout.layoutText() for Web Worker usage.
 *
 * FEATURE: Z-depth wrapping for long lines
 * When maxLineWidth is set and a line exceeds it without a newline,
 * the layout wraps in Z-depth (behind) instead of Y (down).
 * This keeps "binary-esque" files with extremely long lines more compact.
 */

/**
 * Layout text into world positions
 *
 * PURE FUNCTION: Same input always produces same output.
 * No side effects, no state mutation.
 *
 * Bounds tracked during single-pass iteration - no extra allocations.
 *
 * @param {string} text - Text to layout
 * @param {{x: number, y: number, z: number}} startPosition - Starting position
 * @param {{charWidth: number, charHeight: number, letterSpacing: number, lineSpacing: number}} metrics - Font metrics
 * @param {'left'|'center'|'right'} [alignment='left'] - Text alignment
 * @param {Object} [layoutOptions] - Additional layout options
 * @param {number} [layoutOptions.maxLineWidth] - Max characters before Z-depth wrap (0 = no limit)
 * @param {number} [layoutOptions.zWrapSpacing] - Z spacing for wrapped lines (default: charHeight * 2)
 * @returns {{positions: Array<{x: number, y: number, z: number}>, bounds: Object|null}}
 */
export function layoutText(text, startPosition, metrics, alignment = 'left', layoutOptions = {}) {
    if (!text || text.length === 0) {
        return { positions: [], bounds: null };
    }

    const positions = [];
    const startZ = startPosition.z;

    // Z-depth wrapping options
    const maxLineWidth = layoutOptions.maxLineWidth || 0;  // 0 = no limit
    const zWrapSpacing = layoutOptions.zWrapSpacing || (metrics.charHeight * 2);

    // Track bounds during iteration (now including Z)
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = startPosition.y;
    let minZ = startZ;
    let maxZ = startZ;
    const maxY = startPosition.y + metrics.charHeight;

    let x = startPosition.x;
    let y = startPosition.y;
    let z = startZ;
    let charsOnCurrentSegment = 0;  // Track chars since last wrap/newline

    for (let i = 0; i < text.length; i++) {
        const char = text[i];

        if (char === '\n') {
            // Track maxX before line reset
            if (x > startPosition.x) {
                maxX = Math.max(maxX, x - metrics.letterSpacing);
            }
            // Reset x, advance y, reset z (new logical line)
            x = startPosition.x;
            y -= metrics.lineSpacing;
            z = startZ;  // Reset Z for new line
            minY = y;
            charsOnCurrentSegment = 0;
            continue;
        }

        // Z-depth + Y-drop wrap: go behind AND down so text is readable head-on
        if (maxLineWidth > 0 && charsOnCurrentSegment >= maxLineWidth) {
            if (x > startPosition.x) {
                maxX = Math.max(maxX, x - metrics.letterSpacing);
            }
            x = startPosition.x;
            y -= metrics.lineSpacing;   // Drop Y — visible when viewed head-on
            z -= zWrapSpacing;           // Go behind — depth layering
            minY = y;
            minZ = Math.min(minZ, z);
            charsOnCurrentSegment = 0;
        }

        // Track minX (first char of each line/segment)
        if (x === startPosition.x || minX === Infinity) {
            minX = Math.min(minX, x);
        }

        positions.push({ x, y, z });
        x += metrics.charWidth + metrics.letterSpacing;
        charsOnCurrentSegment++;
    }

    // Final line/segment maxX
    if (x > startPosition.x) {
        maxX = Math.max(maxX, x - metrics.letterSpacing);
    }

    // Track final Z
    maxZ = Math.max(maxZ, startZ);

    // Handle empty or all-newlines
    if (positions.length === 0) {
        return { positions, bounds: null };
    }

    const bounds = {
        min: { x: minX, y: minY, z: minZ },
        max: { x: maxX, y: maxY, z: maxZ },
        width: maxX - minX,
        height: maxY - minY,
        depth: maxZ - minZ
    };

    return { positions, bounds };
}

export default layoutText;

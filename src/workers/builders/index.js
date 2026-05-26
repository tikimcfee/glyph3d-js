/**
 * Glyph Builder Pipeline - HarfBuzz-shaped path only.
 *
 * Single-pass text → Float32Array conversion.
 * No intermediate objects, no spread operators.
 *
 * Reads pre-shaped glyph arrays from item.shaped (shaped on the main thread).
 * Outputs HarfBuzz glyph IDs that index directly into SlugEncoder's
 * glyphMapTexture for Slug vector rendering. Variable-width advances from
 * HarfBuzz.
 *
 * Emits a `glyphIds` Float32Array (with `codepoints` alias for compat).
 * The vertex shader uses glyphId to index into glyphMapTexture via texelFetch.
 *
 * Worker context: this file must not import DOM APIs or Three.js.
 *
 * Buffer contract type reference: ../../core/types.js (GlyphBufferSet, GlyphBufferItemMeta)
 */

/**
 * Z-depth wrapping configuration
 * When a line exceeds maxLineWidth characters without a newline,
 * wrap in Z-depth (behind) AND Y (down) so the continuation is
 * readable when viewed head-on — a stepped staircase going down-and-back.
 */
export const Z_WRAP_CONFIG = {
    maxLineWidth: 200,    // Characters before wrap (0 = disabled)
    zWrapSpacing: 0.15    // Z spacing multiplier (relative to charHeight) — tight, matches background gap
};

/**
 * Page-break pagination configuration
 * When a text block exceeds pageHeight visual lines, break into pages.
 * Pages extend right first (up to pagesWide), then wrap downward (Y-stack).
 * Creates a length-wrap flow: right → down, like newspaper columns.
 */
export const PAGE_CONFIG = {
    pageHeight: 150,       // Visual lines per page before page break
    pagesWide: 5,          // Horizontal pages before wrapping down
    pageGapX: 10,          // Char-width gap between horizontal pages
    pageGapY: 10,          // Line-height gap between page rows (vertical)
};

/**
 * Apply page-break pagination to glyph positions in-place.
 * Pages fan right, then wrap down — extend right first, then extend down.
 *
 * @param {Float32Array} positions - Position buffer (mutated in place)
 * @param {number} startIdx - First glyph index for this item
 * @param {number} endIdx - One past last glyph index
 * @param {{x,y,z}} origin - Item's starting position
 * @param {Object} metrics - {charWidth, charHeight, letterSpacing, lineSpacing}
 */
export function applyPagination(positions, startIdx, endIdx, origin, metrics) {
    const pageHeightWorld = PAGE_CONFIG.pageHeight * metrics.lineSpacing;
    const charAdvance = metrics.charWidth + metrics.letterSpacing;
    const pageWidthWorld = Z_WRAP_CONFIG.maxLineWidth * charAdvance;
    const gapXWorld = PAGE_CONFIG.pageGapX * charAdvance;
    const gapYWorld = PAGE_CONFIG.pageGapY * metrics.lineSpacing;

    for (let i = startIdx; i < endIdx; i++) {
        const relY = origin.y - positions[i * 3 + 1];  // distance below origin

        if (relY < pageHeightWorld) continue;  // first page — no transform

        const vPage = Math.floor(relY / pageHeightWorld);
        const rowOffsetInPage = relY - vPage * pageHeightWorld;
        const hSlot = vPage % PAGE_CONFIG.pagesWide;
        const yRow = Math.floor(vPage / PAGE_CONFIG.pagesWide);

        // Remap Y: position within page + shift down for page row
        positions[i * 3 + 1] = origin.y - rowOffsetInPage
            - yRow * (pageHeightWorld + gapYWorld);

        // Fan pages horizontally
        positions[i * 3] += hSlot * (pageWidthWorld + gapXWorld);
    }
}

/**
 * Build buffers for multiple texts using pre-shaped HarfBuzz glyph data.
 *
 * Each item must have item.shaped set by the main thread before being posted
 * to a worker. This eliminates per-worker WASM instances — shaping runs once
 * on the main thread, workers only do buffer math.
 *
 * Outputs HarfBuzz glyph IDs that index directly into SlugEncoder's glyphMapTexture.
 * One slot per codepoint — invisible glyphs (space, tab, .notdef) get a slot
 * too and render to nothing via 0-curve fragment discard, so the slot offset
 * within a line equals the codepoint index.
 *
 * @param {Array<{text, position, color?, scale?, groupId?, shaped: {lines, totalGlyphs}}>} items
 * @param {Object} shared - {metrics, defaultColor, upem}
 * @returns {import('../../core/types.js').GlyphBufferSet}
 */
export function buildBatchBuffers(items, shared) {
    const { metrics, defaultColor, upem } = shared;

    // Convert HarfBuzz font units to world units.
    //
    // worldScale is a pixel→world factor (e.g. 0.025 means 1 atlas-pixel = 0.025 world units).
    // HarfBuzz advances are in font units where upem units = 1 em = pixelHeight pixels on canvas.
    // So: font_units → pixels = font_units * (pixelHeight / upem)
    //     pixels → world     = pixels * worldScale
    // Combined: font_units → world = font_units * (worldScale * pixelHeight / upem)
    //
    // Using ws = worldScale alone (without the pixelHeight factor) shrinks the advance by
    // ~pixelHeight× (e.g. factor of 48), producing hair-thin quads.
    const worldScale = metrics.worldScale || (metrics.charWidth / metrics.pixelWidth) || 0.025;
    const pixelHeight = metrics.pixelHeight || metrics.charHeight / worldScale;
    const ws = worldScale * pixelHeight;

    // Z-depth wrapping settings
    const maxLineWidth = Z_WRAP_CONFIG.maxLineWidth;
    const zWrapSpacing = metrics.charHeight * Z_WRAP_CONFIG.zWrapSpacing;

    // First pass: read pre-shaped data from items to count total glyphs (worst-case)
    let totalGlyphs = 0;

    for (let i = 0; i < items.length; i++) {
        const shaped = items[i].shaped;
        if (shaped) totalGlyphs += shaped.totalGlyphs;
    }

    if (totalGlyphs === 0) {
        return {
            positions: new Float32Array(0),
            sizes: new Float32Array(0),
            glyphIds: new Float32Array(0),
            codepoints: new Float32Array(0),
            colors: new Float32Array(0),
            groupIds: new Float32Array(0),
            count: 0,
            bounds: null,
            itemMeta: items.map(() => ({ bufferStartIndex: 0, glyphCount: 0, bounds: null }))
        };
    }

    // Allocate combined buffers — one slot per codepoint, exact (no skipping)
    const positions = new Float32Array(totalGlyphs * 3);
    const sizes = new Float32Array(totalGlyphs * 2);
    const glyphIdsArr = new Float32Array(totalGlyphs);
    const colors = new Float32Array(totalGlyphs * 3);
    const groupIds = new Float32Array(totalGlyphs);
    const itemMeta = new Array(items.length);

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    let bufferOffset = 0;

    for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
        const item = items[itemIdx];
        const pos = item.position;
        const color = item.color || defaultColor;
        const scale = item.scale || 1.0;
        const itemGroupId = item.groupId || 0;
        const shaped = item.shaped;

        const itemStartOffset = bufferOffset;

        if (!shaped || shaped.totalGlyphs === 0) {
            itemMeta[itemIdx] = {
                bufferStartIndex: itemStartOffset,
                glyphCount: 0,
                bounds: null,
                lineSlotOffsets: [itemStartOffset],
                wrapColsPerLine: [[]],
            };
            continue;
        }

        const itemLineSlotOffsets = [bufferOffset];

        // Per-line wrap cols: for each source line, the source-col indices
        // where the worker wrapped to a new visual row. Empty for lines
        // that fit. Consumed downstream by CodeGrid's cursor positioning
        // (the "wrap ruler" pattern: enough info to derive any cursor's
        // visual row + x without storing per-char data).
        const itemWrapColsPerLine = [[]];
        let lineColIdx = 0;  // source col within current line (advances per sg)

        let x = pos.x;
        let y = pos.y;
        let z = pos.z;
        const startZ = pos.z;
        let glyphsOnSegment = 0;

        let itemMinX = Infinity, itemMaxX = -Infinity;
        let itemMinY = y, itemMaxY = y + metrics.charHeight;
        let itemMinZ = z, itemMaxZ = z;

        for (let lineIdx = 0; lineIdx < shaped.lines.length; lineIdx++) {
            if (lineIdx > 0) {
                // Newline
                if (x > pos.x) itemMaxX = Math.max(itemMaxX, x);
                x = pos.x;
                y -= metrics.lineSpacing;
                z = startZ;
                itemMinY = y;
                glyphsOnSegment = 0;
                itemLineSlotOffsets.push(bufferOffset);
                itemWrapColsPerLine.push([]);
                lineColIdx = 0;
            }

            const line = shaped.lines[lineIdx];
            const currentLineWraps = itemWrapColsPerLine[itemWrapColsPerLine.length - 1];
            for (const sg of line.shaped) {
                const glyphId = sg.g;
                const advance = sg.ax / upem * ws * scale;
                const charHeight = metrics.charHeight * scale;
                const dx = sg.dx / upem * ws * scale;
                const dy = sg.dy / upem * ws * scale;

                // Z-depth + Y-drop wrap
                if (maxLineWidth > 0 && glyphsOnSegment >= maxLineWidth) {
                    if (x > pos.x) itemMaxX = Math.max(itemMaxX, x);
                    x = pos.x;
                    y -= metrics.lineSpacing;
                    z -= zWrapSpacing;
                    itemMinY = y;
                    itemMinZ = Math.min(itemMinZ, z);
                    glyphsOnSegment = 0;
                    // Affinity=right at wrap: this char (and cursors at
                    // its source-col) belong on the new visual row.
                    currentLineWraps.push(lineColIdx);
                }

                // One slot per codepoint — invisible glyphs (space, tab,
                // .notdef) get a slot too and render to nothing via 0-curve
                // fragment discard. This makes the column→slot mapping a plain
                // identity: slot offset within a line == codepoint index.
                if (itemMinX === Infinity) itemMinX = x;
                const idx = bufferOffset;

                positions[idx * 3] = x + dx;
                positions[idx * 3 + 1] = y + dy;
                positions[idx * 3 + 2] = z;

                sizes[idx * 2] = advance;
                sizes[idx * 2 + 1] = charHeight;

                glyphIdsArr[idx] = glyphId;

                colors[idx * 3] = color.r;
                colors[idx * 3 + 1] = color.g;
                colors[idx * 3 + 2] = color.b;

                groupIds[idx] = itemGroupId;

                bufferOffset++;
                x += advance;
                glyphsOnSegment++;
                lineColIdx++;
            }
        }

        if (x > pos.x) itemMaxX = Math.max(itemMaxX, x);
        itemMaxZ = Math.max(itemMaxZ, startZ);

        const itemGlyphCount = bufferOffset - itemStartOffset;

        // Apply page-break pagination if needed
        if (itemGlyphCount > 0) {
            const totalYSpan = pos.y - itemMinY;
            const pageHeightWorld = PAGE_CONFIG.pageHeight * metrics.lineSpacing;
            if (totalYSpan > pageHeightWorld) {
                applyPagination(positions, itemStartOffset, bufferOffset, pos, metrics);
                // Recompute bounds
                itemMinX = Infinity; itemMaxX = -Infinity;
                itemMinY = Infinity; itemMaxY = -Infinity;
                itemMinZ = Infinity; itemMaxZ = -Infinity;
                for (let i = itemStartOffset; i < bufferOffset; i++) {
                    const px = positions[i * 3];
                    const py = positions[i * 3 + 1];
                    const pz = positions[i * 3 + 2];
                    if (px < itemMinX) itemMinX = px;
                    if (px > itemMaxX) itemMaxX = px;
                    if (py < itemMinY) itemMinY = py;
                    if (py > itemMaxY) itemMaxY = py;
                    if (pz < itemMinZ) itemMinZ = pz;
                    if (pz > itemMaxZ) itemMaxZ = pz;
                }
                itemMaxX += metrics.charWidth;
                itemMaxY += metrics.charHeight;
            }
        }

        itemMeta[itemIdx] = {
            bufferStartIndex: itemStartOffset,
            glyphCount: itemGlyphCount,
            lineSlotOffsets: itemLineSlotOffsets,
            wrapColsPerLine: itemWrapColsPerLine,  // [line][i] = wrap col i within that source line
            bounds: itemGlyphCount > 0 ? {
                min: { x: itemMinX, y: itemMinY, z: itemMinZ },
                max: { x: itemMaxX, y: itemMaxY, z: itemMaxZ },
                width: itemMaxX - itemMinX,
                height: itemMaxY - itemMinY,
                depth: itemMaxZ - itemMinZ
            } : null
        };

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

    // Truncate to actual count (some glyphs may have been skipped)
    const finalPositions = bufferOffset < totalGlyphs ? positions.subarray(0, bufferOffset * 3) : positions;
    const finalSizes = bufferOffset < totalGlyphs ? sizes.subarray(0, bufferOffset * 2) : sizes;
    const finalGlyphIds = bufferOffset < totalGlyphs ? glyphIdsArr.subarray(0, bufferOffset) : glyphIdsArr;
    const finalColors = bufferOffset < totalGlyphs ? colors.subarray(0, bufferOffset * 3) : colors;
    const finalGroupIds = bufferOffset < totalGlyphs ? groupIds.subarray(0, bufferOffset) : groupIds;

    return {
        positions: finalPositions,
        sizes: finalSizes,
        glyphIds: finalGlyphIds,
        codepoints: finalGlyphIds,
        colors: finalColors,
        groupIds: finalGroupIds,
        count: bufferOffset,
        bounds,
        itemMeta
    };
}

// Preserve named export alias for code that imported buildShapedBatchBuffers directly
export { buildBatchBuffers as buildShapedBatchBuffers };

/**
 * Glyph Builder Pipeline - Optimized for performance
 *
 * Single-pass text → Float32Array conversion.
 * No intermediate objects, no spread operators.
 *
 * Two builder paths:
 *
 * 1. **HarfBuzz-shaped path** (`buildShapedBatchBuffers`):
 *    Uses HarfBuzzShaper.shape() per line. Outputs HarfBuzz glyph IDs that
 *    index directly into SlugEncoder's glyphMapTexture for Slug vector rendering.
 *    Variable-width advances from HarfBuzz. This is the primary path.
 *
 * 2. **Legacy grapheme path** (`buildGlyphBuffers`, `buildBatchBuffers`):
 *    Iterates grapheme clusters, looks up numeric IDs from a UV map.
 *    Still used as fallback when HarfBuzz is not initialized on a worker.
 *    The `uvMap` argument maps grapheme string → {u0,v0,u1,v1,numericId}.
 *
 * Both paths emit a `glyphIds` Float32Array (with `codepoints` alias for compat).
 * The vertex shader uses glyphId to index into glyphMapTexture via texelFetch.
 *
 * Worker context: this file must not import DOM APIs or Three.js.
 *
 * Buffer contract type reference: ../../core/types.js (GlyphBufferSet, GlyphBufferItemMeta)
 */

import { iterGraphemes } from '../../utils/grapheme.js';
import { shapeText } from '../../shaping/shapeText.js';

/**
 * Count renderable grapheme clusters in text (excludes control characters).
 * A grapheme cluster with codepoint <= 32 is a control/whitespace character.
 * @param {string} text
 * @returns {number}
 */
function countGlyphs(text) {
    let count = 0;
    for (const g of iterGraphemes(text)) {
        const cp = g.codePointAt(0);
        if (cp > 32) count++;
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
 * @param {Object} input.uvMap - graphemeString → {u0,v0,u1,v1,numericId}. Used to validate
 *   that a glyph exists in the atlas (falls back to '?' numericId 63 if missing).
 *   UV coordinates are NOT written to the output; the vertex shader resolves them via
 *   atlasMapTexture at draw time using the numeric ID stored in `codepoints`.
 * @param {Object} input.glyphWidths - graphemeString → pixelWidth
 * @param {{r,g,b}} input.color
 * @param {number} [input.scale=1.0]
 * @param {number} [input.groupId=0]
 * @returns {import('../../core/types.js').GlyphBufferSet & {lineSlotOffsets: number[]}}
 *   A GlyphBufferSet with an additional top-level `lineSlotOffsets` (line index → first buffer slot
 *   on that line) and `count` for the number of populated glyph slots. The `itemMeta` field is absent
 *   from the single-item builder; use buildBatchBuffers() when per-item metadata is needed.
 *   `glyphIds` contains one HarfBuzz glyph ID per glyph for Slug texture lookup.
 *   `codepoints` is kept as an alias for backward compatibility.
 */
export function buildGlyphBuffers(input) {
    const { text, position, metrics, uvMap, glyphWidths, color, scale = 1.0, groupId = 0 } = input;

    if (!text || text.length === 0) {
        const empty = new Float32Array(0);
        return {
            positions: empty,
            sizes: empty,
            glyphIds: empty,
            codepoints: empty,
            colors: empty,
            groupIds: empty,
            count: 0,
            bounds: null
        };
    }

    // Pre-count glyphs to allocate exact buffer sizes
    const glyphCount = countGlyphs(text);

    // Allocate buffers
    const positions = new Float32Array(glyphCount * 3);
    const sizes = new Float32Array(glyphCount * 2);
    const glyphIdsArr = new Float32Array(glyphCount);
    const colors = new Float32Array(glyphCount * 3);
    const groupIds = new Float32Array(glyphCount);

    // Per-glyph width: glyphWidths stores pixel widths from the atlas.
    // Multiply by worldScale to convert to world units (same space as metrics.charWidth).
    const ws = metrics.worldScale || (metrics.charWidth / 30); // worldScale, fallback for compat
    const defaultWidth = metrics.charWidth; // world units, for glyphs not in the map
    const scaledHeight = metrics.charHeight * scale;

    // Track bounds
    let minX = Infinity, maxX = -Infinity;
    let minY = position.y, maxY = position.y + metrics.charHeight;

    // Cursor position
    let x = position.x;
    let y = position.y;
    const z = position.z;

    // Track line→slot mapping: lineSlotOffsets[lineIdx] = buffer slot of first glyph on that line
    const lineSlotOffsets = [0]; // line 0 starts at slot 0

    // '?' fallback entry
    const fallbackEntry = uvMap['?'];

    // Fill buffers in single pass
    let idx = 0;
    for (const grapheme of iterGraphemes(text)) {
        const cp = grapheme.codePointAt(0);

        // Newline (U+000A) - reset x, advance y, record line boundary
        if (cp === 10) {
            if (x > position.x) maxX = Math.max(maxX, x - metrics.letterSpacing);
            x = position.x;
            y -= metrics.lineSpacing;
            minY = y;
            lineSlotOffsets.push(idx); // next line starts at current slot index
            continue;
        }

        // Per-glyph width in world units (pixel width × worldScale, fallback to charWidth)
        const glyphWidth = glyphWidths && glyphWidths[grapheme]
            ? glyphWidths[grapheme] * ws
            : defaultWidth;

        // Space (U+0020): advance cursor but don't render
        if (cp === 32) {
            if (minX === Infinity) minX = x;
            x += glyphWidth * scale + metrics.letterSpacing;
            continue;
        }
        // CR (U+000D) and tab (U+0009): skip entirely
        if (cp === 13 || cp === 9) continue;

        // Track minX
        if (minX === Infinity) minX = x;

        // Validate glyph exists in atlas — fall back to '?'
        const entry = uvMap[grapheme];
        const resolvedEntry = entry || (fallbackEntry ? fallbackEntry : null);
        if (!resolvedEntry) {
            x += glyphWidth * scale + metrics.letterSpacing;
            continue;
        }

        const numericId = resolvedEntry.numericId;

        // Position [x, y, z]
        positions[idx * 3] = x;
        positions[idx * 3 + 1] = y;
        positions[idx * 3 + 2] = z;

        // Size [width, height] — must match the X advance (glyphWidth) so
        // picking quads align with layout. Using a different width for the
        // rendered quad vs the advance causes hover gaps/overlaps.
        sizes[idx * 2] = glyphWidth * scale;
        sizes[idx * 2 + 1] = scaledHeight;

        // Store numeric glyph ID for Slug glyphMapTexture lookup
        glyphIdsArr[idx] = numericId;

        // Color [r, g, b]
        colors[idx * 3] = color.r;
        colors[idx * 3 + 1] = color.g;
        colors[idx * 3 + 2] = color.b;

        // Group ID
        groupIds[idx] = groupId;

        idx++;
        x += glyphWidth * scale + metrics.letterSpacing;
    }

    // Final line maxX
    if (x > position.x) maxX = Math.max(maxX, x - metrics.letterSpacing);

    const bounds = idx > 0 ? {
        min: { x: minX, y: minY, z },
        max: { x: maxX, y: maxY, z },
        width: maxX - minX,
        height: maxY - minY
    } : null;

    return { positions, sizes, glyphIds: glyphIdsArr, codepoints: glyphIdsArr, colors, groupIds, count: idx, bounds, lineSlotOffsets };
}

/**
 * Z-depth wrapping configuration
 * When a line exceeds maxLineWidth characters without a newline,
 * wrap in Z-depth (behind) AND Y (down) so the continuation is
 * readable when viewed head-on — a stepped staircase going down-and-back.
 */
const Z_WRAP_CONFIG = {
    maxLineWidth: 200,    // Characters before wrap (0 = disabled)
    zWrapSpacing: 0.15    // Z spacing multiplier (relative to charHeight) — tight, matches background gap
};

/**
 * Page-break pagination configuration
 * When a text block exceeds pageHeight visual lines, break into pages.
 * Pages extend right first (up to pagesWide), then wrap downward (Y-stack).
 * Creates a length-wrap flow: right → down, like newspaper columns.
 */
const PAGE_CONFIG = {
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
function applyPagination(positions, startIdx, endIdx, origin, metrics) {
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
 * Build buffers for multiple texts - single pass per text, direct to combined buffers
 *
 * Returns per-item metadata (bufferStartIndex, glyphCount, bounds) alongside the
 * combined GPU buffers. This metadata enables post-render operations (updatePosition,
 * updateColor, getText) on individual text entries after the worker path.
 *
 * @param {Array<{text, position, color?, scale?}>} items
 * @param {Object} shared - {metrics, uvMap, glyphWidths, defaultColor}
 * @returns {import('../../core/types.js').GlyphBufferSet}
 *   `glyphIds` contains one numeric glyph ID per glyph for Slug glyphMapTexture lookup.
 *   `codepoints` is kept as an alias for backward compatibility.
 *   Each entry in `itemMeta` is a GlyphBufferItemMeta with bufferStartIndex, glyphCount, bounds, and
 *   lineSlotOffsets (plain number[], one entry per logical line within that item).
 */
export function buildBatchBuffers(items, shared) {
    const { metrics, uvMap, glyphWidths, defaultColor } = shared;

    // Pixel→world scale for per-glyph widths
    const ws = metrics.worldScale || (metrics.charWidth / 30);

    // Z-depth wrapping settings
    const maxLineWidth = Z_WRAP_CONFIG.maxLineWidth;
    const zWrapSpacing = metrics.charHeight * Z_WRAP_CONFIG.zWrapSpacing;

    // '?' fallback entry
    const fallbackEntry = uvMap ? uvMap['?'] : null;

    // First pass: count total glyphs
    let totalGlyphs = 0;
    for (let i = 0; i < items.length; i++) {
        totalGlyphs += countGlyphs(items[i].text);
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

    // Allocate combined buffers
    const positions = new Float32Array(totalGlyphs * 3);
    const sizes = new Float32Array(totalGlyphs * 2);
    const glyphIdsArr = new Float32Array(totalGlyphs);
    const colors = new Float32Array(totalGlyphs * 3);
    const groupIds = new Float32Array(totalGlyphs);

    // Per-item metadata for post-render operations
    const itemMeta = new Array(items.length);

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
        const itemGroupId = item.groupId || 0;

        // Record where this item's glyphs start
        const itemStartOffset = bufferOffset;

        if (!text || text.length === 0) {
            itemMeta[itemIdx] = { bufferStartIndex: itemStartOffset, glyphCount: 0, bounds: null };
            continue;
        }

        const defaultWidth = metrics.charWidth;
        const scaledHeight = metrics.charHeight * scale;

        let x = pos.x;
        let y = pos.y;
        let z = pos.z;
        const startZ = pos.z;
        let glyphsOnSegment = 0;  // Track graphemes since last wrap/newline

        // Track line→slot mapping within this item
        const itemLineSlotOffsets = [bufferOffset]; // line 0 starts at current offset

        // Track per-item bounds for combined bounds
        let itemMinX = Infinity, itemMaxX = -Infinity;
        let itemMinY = y, itemMaxY = y + metrics.charHeight;
        let itemMinZ = z, itemMaxZ = z;

        for (const grapheme of iterGraphemes(text)) {
            const cp = grapheme.codePointAt(0);

            if (cp === 10) {
                // Newline: reset x, advance y, reset z
                if (x > pos.x) itemMaxX = Math.max(itemMaxX, x - metrics.letterSpacing);
                x = pos.x;
                y -= metrics.lineSpacing;
                z = startZ;  // Reset Z for new logical line
                itemMinY = y;
                glyphsOnSegment = 0;
                itemLineSlotOffsets.push(bufferOffset); // next line starts here
                continue;
            }

            // Per-glyph width in world units
            const glyphWidth = glyphWidths && glyphWidths[grapheme]
                ? glyphWidths[grapheme] * ws
                : defaultWidth;

            // Z-depth + Y-drop wrap: go behind AND down so text is readable head-on
            if (maxLineWidth > 0 && glyphsOnSegment >= maxLineWidth) {
                if (x > pos.x) itemMaxX = Math.max(itemMaxX, x - metrics.letterSpacing);
                x = pos.x;
                y -= metrics.lineSpacing;   // Drop Y — visible when viewed head-on
                z -= zWrapSpacing;           // Go behind — depth layering
                itemMinY = y;
                itemMinZ = Math.min(itemMinZ, z);
                glyphsOnSegment = 0;
            }

            if (cp === 32) {
                // Space: advance cursor, no glyph slot
                if (itemMinX === Infinity) itemMinX = x;
                x += glyphWidth * scale + metrics.letterSpacing;
                glyphsOnSegment++;
                continue;
            }
            if (cp === 13 || cp === 9) continue;

            if (itemMinX === Infinity) itemMinX = x;

            // Validate glyph exists in atlas — fall back to '?'
            const entry = uvMap[grapheme];
            const resolvedEntry = entry || (fallbackEntry ? fallbackEntry : null);
            if (!resolvedEntry) {
                x += glyphWidth * scale + metrics.letterSpacing;
                glyphsOnSegment++;
                continue;
            }

            const numericId = resolvedEntry.numericId;
            const idx = bufferOffset;

            positions[idx * 3] = x;
            positions[idx * 3 + 1] = y;
            positions[idx * 3 + 2] = z;

            sizes[idx * 2] = glyphWidth * scale;
            sizes[idx * 2 + 1] = scaledHeight;

            // Store numeric glyph ID for Slug glyphMapTexture lookup
            glyphIdsArr[idx] = numericId;

            colors[idx * 3] = color.r;
            colors[idx * 3 + 1] = color.g;
            colors[idx * 3 + 2] = color.b;

            groupIds[idx] = itemGroupId;

            bufferOffset++;
            x += glyphWidth * scale + metrics.letterSpacing;
            glyphsOnSegment++;
        }

        // Final line
        if (x > pos.x) itemMaxX = Math.max(itemMaxX, x - metrics.letterSpacing);
        itemMaxZ = Math.max(itemMaxZ, startZ);

        // Apply page-break pagination if item spans more than one page
        const itemGlyphCount = bufferOffset - itemStartOffset;
        if (itemGlyphCount > 0) {
            const totalYSpan = pos.y - itemMinY;
            const pageHeightWorld = PAGE_CONFIG.pageHeight * metrics.lineSpacing;

            if (totalYSpan > pageHeightWorld) {
                applyPagination(positions, itemStartOffset, bufferOffset, pos, metrics);

                // Recompute bounds — pagination rearranged positions
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

        // Store per-item metadata
        itemMeta[itemIdx] = {
            bufferStartIndex: itemStartOffset,
            glyphCount: itemGlyphCount,
            lineSlotOffsets: itemLineSlotOffsets,
            bounds: itemGlyphCount > 0 ? {
                min: { x: itemMinX, y: itemMinY, z: itemMinZ },
                max: { x: itemMaxX, y: itemMaxY, z: itemMaxZ },
                width: itemMaxX - itemMinX,
                height: itemMaxY - itemMinY,
                depth: itemMaxZ - itemMinZ
            } : null
        };

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

    return { positions, sizes, glyphIds: glyphIdsArr, codepoints: glyphIdsArr, colors, groupIds, count: bufferOffset, bounds, itemMeta };
}

/**
 * Build buffers for multiple texts using HarfBuzz shaping.
 *
 * Replaces grapheme-based iteration with HarfBuzz shape() per line.
 * Outputs HarfBuzz glyph IDs that index directly into SlugEncoder's glyphMapTexture.
 * Space glyphs (0 curves in SlugEncoder) are skipped — advance cursor only.
 *
 * @param {Array<{text, position, color?, scale?, groupId?}>} items
 * @param {Object} shared - {metrics, defaultColor}
 * @param {import('../../shaping/HarfBuzzShaper.js').default} shaper - Initialized HarfBuzzShaper
 * @param {Set<number>} [emptyGlyphs] - Set of glyph IDs with 0 curves (spaces, .notdef)
 * @returns {import('../../core/types.js').GlyphBufferSet}
 */
export function buildShapedBatchBuffers(items, shared, shaper, emptyGlyphs) {
    const { metrics, defaultColor } = shared;
    const upem = shaper.upem;
    const ws = metrics.worldScale || (metrics.charWidth / 30);

    // Z-depth wrapping settings
    const maxLineWidth = Z_WRAP_CONFIG.maxLineWidth;
    const zWrapSpacing = metrics.charHeight * Z_WRAP_CONFIG.zWrapSpacing;

    // Empty glyph cache — glyph IDs that produce 0 curves (space, .notdef)
    const _emptyGlyphs = emptyGlyphs || new Set();

    // First pass: shape all text to count total glyphs (worst-case)
    const shapedItems = [];
    let totalGlyphs = 0;

    for (let i = 0; i < items.length; i++) {
        const text = items[i].text || '';
        const shaped = shapeText(shaper, text);
        shapedItems.push(shaped);
        totalGlyphs += shaped.totalGlyphs;
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

    // Allocate combined buffers (worst-case — may truncate if empty glyphs are skipped)
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
        const shaped = shapedItems[itemIdx];

        const itemStartOffset = bufferOffset;
        const itemLineSlotOffsets = [bufferOffset];

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
            }

            const line = shaped.lines[lineIdx];
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
                }

                // Skip empty glyphs (space, .notdef) — advance cursor only
                if (_emptyGlyphs.has(glyphId)) {
                    if (itemMinX === Infinity) itemMinX = x;
                    x += advance;
                    glyphsOnSegment++;
                    continue;
                }

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

export default buildGlyphBuffers;

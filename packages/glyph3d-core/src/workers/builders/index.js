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
 * Default layout params — the shape of a glyph field. A per-grid `layout` object
 * (threaded through the build's `shared` config channel) overrides any subset;
 * `resolveLayoutParams` merges over these. This is the ONE source of default layout
 * values — the old `Z_WRAP_CONFIG` / `PAGE_CONFIG` globals folded into one params
 * struct so "modes" are just param bundles, not code paths. See LAYOUT_PLAN.md §3a.
 *
 *  wrapWidth     glyphs on a source line before it wraps down-and-back (Z staircase). 0 = no wrap.
 *  zWrapSpacing  Z step per intra-line wrap segment, as a multiple of charHeight.
 *  pageHeight    visual rows per page before pagination breaks to a new column. 0 = no pagination.
 *  pagesWide     horizontal pages before pagination wraps downward (newspaper columns).
 *  pageGapX      char-width gap between horizontal pages.
 *  pageGapY      line-height gap between page rows (vertical).
 *  pageDepth     z-gap between page planes when axis:'z', as a multiple of lineSpacing.
 *  axis          'xy' = newspaper (pages fan in X, default); 'z' = z-pages (pages stack in depth, later behind earlier).
 *
 * `0` means "off/unbounded" for wrapWidth/pageHeight so the struct stays
 * structured-clone-safe across the worker boundary (no `Infinity`).
 */
export const DEFAULT_LAYOUT = {
    wrapWidth: 200,
    zWrapSpacing: 0.15,
    pageHeight: 0,
    pagesWide: 1,
    pageGapX: 10,
    pageGapY: 10,
    pageDepth: 20,
    axis: 'xy',
};

/**
 * The named fold presets — COMPLETE bundles (every one sets axis) so switching
 * modes always resets the fold: e.g. z-pages → newspaper must clear axis:'z',
 * not inherit it. The canonical table for the grid.layout verb, the default-fold
 * setting, and anything else that speaks a fold by name.
 */
export const LAYOUT_PRESETS = {
    'long-column': { wrapWidth: 200, pageHeight: 0,   pagesWide: 1,  axis: 'xy' },  // one tall column; long lines z-wrap (default)
    newspaper:     { wrapWidth: 200, pageHeight: 150, pagesWide: 5,  axis: 'xy' },  // fan into columns
    'no-wrap':     { wrapWidth: 0,   pageHeight: 0,   pagesWide: 1,  axis: 'xy' },  // lines run off right; rows = line count
    wall:          { wrapWidth: 200, pageHeight: 150, pagesWide: 32, axis: 'xy' },  // wide wall of columns marching right
    'z-pages':     { wrapWidth: 200, pageHeight: 150, pagesWide: 1,  axis: 'z'  },  // pages stack in depth (later behind earlier)
};

/**
 * Retune the fold NEW grids are born with (CodeGrid spreads DEFAULT_LAYOUT at
 * construction) — the seam behind the `grid.defaultLayout` setting. Mutates the
 * shared default in place; grids already on screen keep their fold (that's
 * grid.layout's job). Unknown keys are ignored so a preset bundle passes straight in.
 * @param {Partial<typeof DEFAULT_LAYOUT>} patch
 */
export function setDefaultLayout(patch = {}) {
    for (const k of Object.keys(DEFAULT_LAYOUT)) {
        if (patch[k] !== undefined) DEFAULT_LAYOUT[k] = patch[k];
    }
}

/**
 * Merge a partial per-grid `layout` over DEFAULT_LAYOUT. `??` keeps an explicit `0`
 * (the "off" sentinel) rather than treating it as missing. Returns DEFAULT_LAYOUT
 * directly when nothing is supplied (the common full-default path).
 * @param {Partial<typeof DEFAULT_LAYOUT>} [layout]
 * @returns {typeof DEFAULT_LAYOUT}
 */
export function resolveLayoutParams(layout) {
    if (!layout) return DEFAULT_LAYOUT;
    return {
        wrapWidth:    layout.wrapWidth    ?? DEFAULT_LAYOUT.wrapWidth,
        zWrapSpacing: layout.zWrapSpacing ?? DEFAULT_LAYOUT.zWrapSpacing,
        pageHeight:   layout.pageHeight   ?? DEFAULT_LAYOUT.pageHeight,
        pagesWide:    layout.pagesWide    ?? DEFAULT_LAYOUT.pagesWide,
        pageGapX:     layout.pageGapX     ?? DEFAULT_LAYOUT.pageGapX,
        pageGapY:     layout.pageGapY     ?? DEFAULT_LAYOUT.pageGapY,
        pageDepth:    layout.pageDepth    ?? DEFAULT_LAYOUT.pageDepth,
        axis:         layout.axis         ?? DEFAULT_LAYOUT.axis,
    };
}

/**
 * Page geometry in world units, derived from metrics + the ACTUAL content width
 * (the widest laid-out line's extent). pageWidthWorld is the column spacing; using
 * the real extent — not `wrapWidth * charAdvance` — is what keeps fanned columns
 * from overlapping: the char-count guess drifts against summed HarfBuzz advances and
 * the error accumulates over a column's width. See LAYOUT_PLAN.md.
 *
 * @param {Object} metrics - {charWidth, charHeight, letterSpacing, lineSpacing}
 * @param {number} contentWidth - widest line's world extent (itemMaxX - origin.x)
 * @param {typeof DEFAULT_LAYOUT} [layout] - resolved layout params (defaults applied if omitted)
 */
export function paginationGeometry(metrics, contentWidth, layout = DEFAULT_LAYOUT) {
    const charAdvance = metrics.charWidth + metrics.letterSpacing;
    return {
        pageHeightWorld: layout.pageHeight * metrics.lineSpacing,
        pageWidthWorld: contentWidth > 0 ? contentWidth : layout.wrapWidth * charAdvance,
        gapXWorld: layout.pageGapX * charAdvance,
        gapYWorld: layout.pageGapY * metrics.lineSpacing,
        pagesWide: Math.max(1, layout.pagesWide),  // clamp: pagesWide<1 would break the % in paginationShift
        axis: layout.axis,                          // 'xy' = fan in X | 'z' = stack in depth
        pageDepthWorld: layout.pageDepth * metrics.lineSpacing,  // z-gap between page planes (axis:'z')
    };
}

/**
 * THE single source of pagination math: given a glyph's distance below the item
 * origin (relY) and the page geometry, return how to remap it. newY = origin.y -
 * mappedRelY; newX = x + shiftX. Shared by the buffer fill (applyPagination) and —
 * in Step 2 — the caret/selection queries, so the two can never diverge.
 *
 * @param {number} relY - origin.y - glyphY (distance below origin, ≥ 0)
 * @param {{pageHeightWorld,pageWidthWorld,gapXWorld,gapYWorld,pagesWide,axis,pageDepthWorld}} geom
 * @returns {{shiftX:number, mappedRelY:number, shiftZ:number}}
 */
export function paginationShift(relY, geom) {
    // pageHeightWorld<=0 means pagination is off (pageHeight:0) — no shift, ever.
    if (geom.pageHeightWorld <= 0 || relY < geom.pageHeightWorld) return { shiftX: 0, mappedRelY: relY, shiftZ: 0 };
    const vPage = Math.floor(relY / geom.pageHeightWorld);
    const rowOffsetInPage = relY - vPage * geom.pageHeightWorld;
    if (geom.axis === 'z') {
        // z-pages: every page shares the front page's x,y footprint (top-aligned) and
        // recedes in depth by its page index — later content sits behind earlier content.
        return { shiftX: 0, mappedRelY: rowOffsetInPage, shiftZ: -vPage * geom.pageDepthWorld };
    }
    // newspaper (axis 'xy'): pages fan right (X) up to pagesWide, then wrap down (Y).
    const hSlot = vPage % geom.pagesWide;
    const yRow = Math.floor(vPage / geom.pagesWide);
    return {
        shiftX: hSlot * (geom.pageWidthWorld + geom.gapXWorld),
        mappedRelY: rowOffsetInPage + yRow * (geom.pageHeightWorld + geom.gapYWorld),
        shiftZ: 0,
    };
}

/**
 * Apply page-break pagination to glyph positions in-place. axis 'xy' fans pages right
 * then wraps down; axis 'z' stacks them in depth (shiftZ). Pure transform via
 * paginationShift — see paginationGeometry for why the width is the real content extent.
 *
 * @param {Float32Array} positions - Position buffer (mutated in place)
 * @param {number} startIdx - First glyph index for this item
 * @param {number} endIdx - One past last glyph index
 * @param {{x,y,z}} origin - Item's starting position
 * @param {ReturnType<typeof paginationGeometry>} geom - page geometry
 */
export function applyPagination(positions, startIdx, endIdx, origin, geom) {
    for (let i = startIdx; i < endIdx; i++) {
        const relY = origin.y - positions[i * 3 + 1];  // distance below origin
        if (relY < geom.pageHeightWorld) continue;      // first page — no transform
        const { shiftX, mappedRelY, shiftZ } = paginationShift(relY, geom);
        positions[i * 3 + 1] = origin.y - mappedRelY;
        positions[i * 3] += shiftX;
        positions[i * 3 + 2] += shiftZ;
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
    const layout = resolveLayoutParams(shared.layout);
    const scrollOffset = shared.scrollOffset || 0;  // visual rows scrolled (Step 3c, the conveyor)

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

    // Z-depth wrapping settings (per-grid layout params; wrapWidth 0 = no wrap)
    const maxLineWidth = layout.wrapWidth;
    const zWrapSpacing = metrics.charHeight * layout.zWrapSpacing;

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
        // Step 3c (the conveyor): shift content up by scrollOffset visual rows, so the fold
        // operates on screenRow = visualRow − scrollOffset. Pagination uses relY = pos.y −
        // glyphY (origin stays at pos), which then equals screenRow*lineSpacing — content
        // flows up and, in folded modes, hops between columns/planes at page boundaries.
        let y = pos.y + scrollOffset * metrics.lineSpacing;
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

        // Page column width actually used (0 = unpaginated). Threaded into itemMeta so
        // the LayoutDescription / caret query pagination with the SAME geometry the
        // glyphs got — never a second char-count guess.
        let pageContentWidth = 0;

        // Apply page-break pagination if needed
        if (itemGlyphCount > 0 && layout.pageHeight > 0) {
            const totalYSpan = pos.y - itemMinY;
            const pageHeightWorld = layout.pageHeight * metrics.lineSpacing;
            if (totalYSpan > pageHeightWorld) {
                // Column spacing = the ACTUAL widest-line extent (itemMaxX is still the
                // pre-pagination max here, before the recompute below overwrites it), not
                // maxLineWidth*charAdvance — fixes the fanned-column edge overlap.
                const contentWidth = itemMaxX > pos.x ? itemMaxX - pos.x : 0;
                pageContentWidth = contentWidth;
                applyPagination(positions, itemStartOffset, bufferOffset, pos, paginationGeometry(metrics, contentWidth, layout));
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
            pageContentWidth,                      // page column width used (0 = unpaginated)
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

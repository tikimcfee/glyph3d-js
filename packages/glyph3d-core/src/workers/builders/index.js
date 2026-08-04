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
 * Build the per-glyph ATTRIBUTES and the line table for a batch of texts.
 *
 * This is not a layout pass. Shaping decides which glyphs exist and how wide each one
 * is; the fold decides where they go, and the fold runs on the GPU (compute/GlyphLayoutKernel)
 * from the tables emitted here. So this walk touches every glyph exactly once to fill
 * `sizes` / `glyphIds` / `colors` / `groupIds` and to record where each source line starts —
 * and nothing else. No positions, no bounds, no pagination: those were all the same CPU
 * fold, computed in registers and thrown away, and the fold's extent is a closed form on
 * the line table (core/foldGeometry.js).
 *
 * Each item must have item.shaped set by the main thread before being posted to a worker.
 * This eliminates per-worker WASM instances — shaping runs once on the main thread, workers
 * only do buffer math.
 *
 * Outputs HarfBuzz glyph IDs that index directly into SlugEncoder's glyphMapTexture.
 * One slot per codepoint — invisible glyphs (space, tab, .notdef) get a slot too and
 * render to nothing via 0-curve fragment discard, so the slot offset within a line
 * equals the codepoint index. That identity is what lets the kernel resolve a slot to
 * its line with a binary search and lets the caret resolve a column with an addition.
 *
 * `shaped.dx`/`dy` are not read: the live shapers emit them as 0 (FontChain,
 * MonospaceShapeCache), and a shaper that didn't would need a per-slot table the kernel
 * could add post-fold, not a CPU pre-offset.
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

    // First pass: read pre-shaped data from items to count total glyphs (worst-case)
    let totalGlyphs = 0;
    for (let i = 0; i < items.length; i++) {
        const shaped = items[i].shaped;
        if (shaped) totalGlyphs += shaped.totalGlyphs;
    }

    if (totalGlyphs === 0) {
        return {
            sizes: new Float32Array(0),
            glyphIds: new Float32Array(0),
            codepoints: new Float32Array(0),
            colors: new Float32Array(0),
            groupIds: new Float32Array(0),
            count: 0,
            itemMeta: items.map(() => ({ bufferStartIndex: 0, glyphCount: 0, lineSlotOffsets: [0] })),
        };
    }

    // Allocate combined buffers — one slot per codepoint, exact (no skipping)
    const sizes = new Float32Array(totalGlyphs * 2);
    const glyphIdsArr = new Float32Array(totalGlyphs);
    const colors = new Float32Array(totalGlyphs * 3);
    const groupIds = new Float32Array(totalGlyphs);
    const itemMeta = new Array(items.length);

    let bufferOffset = 0;

    for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
        const item = items[itemIdx];
        const color = item.color || defaultColor;
        const scale = item.scale || 1.0;
        const itemGroupId = item.groupId || 0;
        const shaped = item.shaped;

        const itemStartOffset = bufferOffset;

        if (!shaped || shaped.totalGlyphs === 0) {
            itemMeta[itemIdx] = {
                bufferStartIndex: itemStartOffset,
                glyphCount: 0,
                lineSlotOffsets: [itemStartOffset],
            };
            continue;
        }

        // line → first buffer slot. The kernel binary-searches this to resolve a slot's
        // source line; the caret adds a column to it. Empty lines repeat the previous
        // offset (they own no slots), which both readers handle by construction.
        const itemLineSlotOffsets = [bufferOffset];
        const charHeight = metrics.charHeight * scale;

        for (let lineIdx = 0; lineIdx < shaped.lines.length; lineIdx++) {
            if (lineIdx > 0) itemLineSlotOffsets.push(bufferOffset);
            for (const sg of shaped.lines[lineIdx].shaped) {
                const idx = bufferOffset;
                sizes[idx * 2]     = sg.ax / upem * ws * scale;   // the REAL advance — emoji are double
                sizes[idx * 2 + 1] = charHeight;
                glyphIdsArr[idx]   = sg.g;
                colors[idx * 3]     = color.r;
                colors[idx * 3 + 1] = color.g;
                colors[idx * 3 + 2] = color.b;
                groupIds[idx] = itemGroupId;
                bufferOffset++;
            }
        }

        itemMeta[itemIdx] = {
            bufferStartIndex: itemStartOffset,
            glyphCount: bufferOffset - itemStartOffset,
            lineSlotOffsets: itemLineSlotOffsets,
        };
    }

    // Truncate to actual count (defensive — shaped.totalGlyphs is the exact count)
    const finalSizes = bufferOffset < totalGlyphs ? sizes.subarray(0, bufferOffset * 2) : sizes;
    const finalGlyphIds = bufferOffset < totalGlyphs ? glyphIdsArr.subarray(0, bufferOffset) : glyphIdsArr;
    const finalColors = bufferOffset < totalGlyphs ? colors.subarray(0, bufferOffset * 3) : colors;
    const finalGroupIds = bufferOffset < totalGlyphs ? groupIds.subarray(0, bufferOffset) : groupIds;

    return {
        sizes: finalSizes,
        glyphIds: finalGlyphIds,
        codepoints: finalGlyphIds,
        colors: finalColors,
        groupIds: finalGroupIds,
        count: bufferOffset,
        itemMeta,
    };
}

// Preserve named export alias for code that imported buildShapedBatchBuffers directly
export { buildBatchBuffers as buildShapedBatchBuffers };

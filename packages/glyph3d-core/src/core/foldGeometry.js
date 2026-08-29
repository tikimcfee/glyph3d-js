/**
 * foldGeometry — the page fold and the fold's EXTENT, in closed form.
 *
 * Two pure functions and the params struct they share. Both are O(1) per query (the
 * extent is O(1) in glyph count, full stop) and both take INTEGER visual rows, which is
 * what makes them exact:
 *
 *   pageShift(screenRow, page)  → where a row lands once pages break
 *   foldExtent({ … })           → the AABB the whole fold occupies
 *
 * WHY THERE IS NO MEASUREMENT HERE. The fold is a pure function of CPU-authored tables,
 * so its extent is a property of those tables, not of the buffer it produces. The
 * bottom row is `totalRows − 1 − scroll`; the widest row is a scan the kernel's xOffsets
 * prefix sum already performs; the page fan is arithmetic on the page index. Walking the
 * position buffer to rediscover any of that — on the CPU or as a GPU reduction with a
 * readback — measures back out what was put in. Three scalars come off the layout scan
 * (`totalRows`, `maxRowExtent`, `maxSegs`) and everything below is closed form on them.
 *
 * ROW CONVENTION. A glyph's position is the BOTTOM-LEFT of its cell, so a row at world y
 * occupies [y, y + cellHeight] and a row's extent already includes its last glyph's
 * advance. `relY` throughout is distance BELOW the origin: y = origin.y − relY.
 *
 * PAGINATION HAS NO SEPARATE GATE. `page.rows > 0` arms it and `screenRow >= page.rows`
 * fires it — one comparison, in the kernel and here alike. Content that fits inside one
 * page never trips it, so the "did pagination actually fire" witness the CPU era carried
 * around (a measured page width doubling as a boolean) has nothing left to witness.
 *
 * Worker-safe: no DOM, no three.
 */

/**
 * Page-fold params in WORLD units, from resolved layout params + cell metrics + the
 * measured widest-row extent.
 *
 * `strideX` uses the MEASURED row extent rather than `wrapWidth × charAdvance`: the
 * char-count guess drifts against summed HarfBuzz advances and the error accumulates
 * across a column's width, which is what used to let fanned columns overlap.
 *
 * @param {{pageHeight:number, pagesWide:number, pageGapX:number, pageGapY:number,
 *          pageDepth:number, axis:string}} layout - resolved layout params
 * @param {{charWidth:number, letterSpacing?:number, lineSpacing:number}} metrics
 * @param {number} maxRowExtent - widest visual row's world width (the layout scan's output)
 * @returns {{rows:number, wide:number, strideX:number, strideY:number, depth:number,
 *            axis:string, lineSpacing:number}}
 */
export function pageFold(layout, metrics, maxRowExtent) {
    const rows = Math.max(0, Math.trunc(layout.pageHeight || 0));
    const ls = metrics.lineSpacing;
    const charAdvance = metrics.charWidth + (metrics.letterSpacing || 0);
    return {
        rows,
        // pagesWide divides — a 0 would fault the fan.
        wide: Math.max(1, Math.trunc(layout.pagesWide || 1)),
        strideX: (maxRowExtent || 0) + (layout.pageGapX || 0) * charAdvance,
        strideY: rows * ls + (layout.pageGapY || 0) * ls,
        depth: (layout.pageDepth || 0) * ls,
        axis: layout.axis === 'z' ? 'z' : 'xy',
        lineSpacing: ls,
    };
}

/**
 * Where a visual row lands after the page fold.
 *
 * `screenRow` is the row AFTER the scroll conveyor (visualRow − scrollOffset) and may be
 * negative: a scroll lifts rows above the origin, and those rows are above page 0, so the
 * `screenRow >= rows` gate leaves them in flow — the same order the kernel evaluates in.
 *
 * @param {number} screenRow - integer visual row, post-scroll
 * @param {?{rows:number, wide:number, strideX:number, strideY:number, depth:number,
 *           axis:string, lineSpacing:number}} page - pageFold output; rows<=0 = off
 * @returns {{dx:number, relY:number, dz:number}} dx/dz ADD to the flow position;
 *   relY REPLACES it (y = origin.y − relY).
 */
export function pageShift(screenRow, page) {
    const ls = page ? page.lineSpacing : 0;
    if (!page || page.rows <= 0 || screenRow < page.rows) {
        return { dx: 0, relY: screenRow * ls, dz: 0 };
    }
    const p = Math.floor(screenRow / page.rows);
    const relY = (screenRow - p * page.rows) * ls;
    if (page.axis === 'z') {
        // z-pages: every page shares the front page's x,y footprint (top-aligned) and
        // recedes in depth by its page index — later content sits behind earlier content.
        return { dx: 0, relY, dz: -p * page.depth };
    }
    // newspaper: pages fan right (X) up to `wide`, then wrap down (Y).
    return {
        dx: (p % page.wide) * page.strideX,
        relY: relY + Math.floor(p / page.wide) * page.strideY,
        dz: 0,
    };
}

/**
 * The AABB of one item's fold — closed form, O(1).
 *
 * The reasoning behind each face:
 *   minX  every visual row starts at the origin's left edge, and the page fan only ever
 *         moves rows RIGHT (dx >= 0).
 *   maxX  the widest row, plus the fan of however many columns the content actually
 *         reached (`usedCols`, not the configured `pagesWide` — a two-page file in a
 *         five-wide layout is two columns wide, not five).
 *   maxY  the shallowest row's top edge, where "top edge" is that row's y plus the
 *         TALLEST glyph in the item — NOT a nominal cell height. Rows sit at a uniform
 *         pitch but a glyph is not required to fit it, and one that exceeds the pitch
 *         overhangs the row above rather than the top of the item, so taking the global
 *         tallest over-covers by at most (tallest − tallest-on-the-top-row) and can never
 *         clip. Rows above page 0 — including the negative screen rows a scroll lifts
 *         above the origin — never page-shift, so the shallowest row is the first one.
 *   minY  the deepest row. Unpaginated that is the last row; paginated it is the last
 *         BAND's deepest row, which is a full page's last row whenever that band holds
 *         more than one page, and the final page's own last row when it holds one.
 *         Band stride exceeds a page's own height, so the last band always dominates.
 *   minZ  the deepest wrap segment, plus the page recession on axis 'z'.
 *   maxZ  the origin plane — the wrap staircase and z-pages both step BACK, never forward.
 *
 * ROWS, NOT GLYPHS. The box spans every visual ROW the content occupies, including blank
 * ones. A file ending in two empty lines is two rows taller than its last glyph, and that
 * is the document's size, not slack: the caret can sit on those rows and the background
 * panel has to cover them. So this is NOT the min/max of the glyph positions, and a test
 * that measures the laid-out glyphs will find it larger by exactly the leading/trailing
 * blank rows.
 *
 * Where pagination is on, two faces are additionally CONSERVATIVE by construction, because
 * making them tight would cost a second reduction to answer questions no consumer asks:
 * maxX fans by the widest row even if that row does not sit in the last column, and (axis
 * 'z') minZ combines the deepest wrap segment with the deepest page even if no single glyph
 * is at both. Both over-cover, never under-cover.
 *
 * @param {Object} p
 * @param {number} p.totalRows - visual rows the item occupies, wrap segments included
 * @param {number} p.maxRowExtent - widest visual row's world width
 * @param {number} p.maxSegs - deepest intra-line wrap segment index (0 = nothing wrapped)
 * @param {{x:number,y:number,z:number}} p.origin
 * @param {number} p.lineSpacing
 * @param {number} [p.zStep] - world z per wrap segment
 * @param {number} [p.cellHeight] - the TALLEST glyph's height (layoutScan.maxGlyphHeight).
 *   A glyph's position is its cell's BOTTOM edge, so this is what the top edge adds.
 * @param {number} [p.scrollOffset] - visual rows the conveyor has shifted content up by
 * @param {?ReturnType<typeof pageFold>} [p.page]
 * @returns {{min:{x,y,z}, max:{x,y,z}, width:number, height:number, depth:number}|null}
 *   null when the item occupies no rows at all.
 */
export function foldExtent(p) {
    // totalRows is a COUNT and arrives exact: from the CPU scan (an integer by
    // construction) or from the GPU reduce (a native u32 lane since foldScalars stopped
    // carrying it through an f32 ordered key). The Math.trunc that used to stand here was
    // a downstream quietly repairing an upstream that had lost its type — nobody filed it
    // because defensive truncation reads as ordinary care. Assert instead: a fractional
    // row count now means a real bug upstream, and silently flooring it hides which one.
    const totalRows = p.totalRows || 0;
    if (!Number.isInteger(totalRows) || totalRows < 0) {
        throw new Error(
            `foldExtent: totalRows must be a non-negative integer, got ${p.totalRows}. `
            + 'It is a count — if it arrived fractional, the carrier that produced it lost '
            + 'exactness (see foldScalars lane 0 in glyphPipelineKernels).');
    }
    if (totalRows === 0) return null;

    const origin = p.origin || { x: 0, y: 0, z: 0 };
    const ls = p.lineSpacing || 0;
    const scroll = Math.trunc(p.scrollOffset || 0);
    const rowWidth = p.maxRowExtent || 0;
    const cellH = p.cellHeight || 0;
    const page = p.page && p.page.rows > 0 ? p.page : null;

    const firstRow = -scroll;                  // shallowest screen row (≤ 0 when scrolled)
    const lastRow = totalRows - 1 - scroll;    // deepest screen row

    const topRelY = firstRow * ls;
    let botRelY = lastRow * ls;
    let maxX = origin.x + rowWidth;
    let minZ = origin.z - Math.max(0, Math.trunc(p.maxSegs || 0)) * (p.zStep || 0);

    if (page && lastRow >= page.rows) {
        // lastRow >= rows ⇒ maxPage >= 1 ⇒ page 0 is full.
        const maxPage = Math.floor(lastRow / page.rows);
        if (page.axis === 'z') {
            botRelY = (page.rows - 1) * ls;
            minZ -= maxPage * page.depth;
        } else {
            const usedCols = Math.min(page.wide, maxPage + 1);
            maxX += (usedCols - 1) * page.strideX;
            const band = Math.floor(maxPage / page.wide);
            const firstPageInBand = band * page.wide;
            const inPage = maxPage > firstPageInBand
                ? page.rows - 1                        // a full page precedes the last one
                : lastRow - maxPage * page.rows;       // the band holds only the final page
            botRelY = inPage * ls + band * page.strideY;
        }
    }

    const min = { x: origin.x, y: origin.y - botRelY, z: minZ };
    const max = { x: maxX, y: origin.y - topRelY + cellH, z: origin.z };
    return {
        min, max,
        width: max.x - min.x,
        height: max.y - min.y,
        depth: max.z - min.z,
    };
}

/**
 * THE layout scan — the one pass over an item's slots, and the only reason the CPU touches
 * glyphs during a layout at all.
 *
 * Two things in the fold are prefix sums and therefore not per-slot pure: the x offset (the
 * running sum of REAL advances along a visual row — a color emoji occupies one slot and
 * advances two cells, so `col × cellWidth` is wrong by a whole cell for everything after it)
 * and the visual-row prefix over lines. This computes both, and drops out the three scalars
 * the fold's extent is a closed form on, for free — they are maxima over the same walk.
 *
 * Callers pass the destination arrays so the GPU path can write straight into its big
 * concatenated buffers at an offset while a test can pass fresh ones; either may be omitted.
 *
 * @param {Object} p
 * @param {number} p.slotCount - item-local slot count
 * @param {Uint32Array|Int32Array|number[]} p.lineTable - item-local line-start slot indexes
 * @param {Float32Array} p.sizes - stride-2 [advance, height] attribute array
 * @param {number} [p.sizeBase] - slot index in `sizes` that item-local slot 0 maps to
 * @param {number} [p.wrapWidth] - slots per visual row, 0 = no wrap
 * @param {Float32Array} [p.xOffsets] - destination for the per-slot x prefix sum
 * @param {number} [p.xBase] - slot offset into `xOffsets`
 * @param {Uint32Array|Int32Array} [p.lineStartRow] - destination for the per-line row prefix
 * @param {number} [p.lineRowBase] - line offset into `lineStartRow`
 * @returns {{maxRowExtent:number, totalRows:number, maxSegs:number, maxGlyphHeight:number}}
 *   maxGlyphHeight is the TALLEST glyph. Rows sit at a uniform pitch, but a glyph is not
 *   required to fit that pitch — an arranger zeroes heights to hide glyphs, and the CPU
 *   glyph-list path writes a height per glyph — so the top edge cannot assume a nominal
 *   cell height. The height lane shares a cache line with the advance, so this is free.
 */
export function layoutScan(p) {
    const { slotCount, lineTable, sizes } = p;
    const sizeBase = p.sizeBase || 0;
    const xBase = p.xBase || 0;
    const lineRowBase = p.lineRowBase || 0;
    const wrap = Math.max(0, Math.trunc(p.wrapWidth || 0));
    const xo = p.xOffsets || null;
    const lsr = p.lineStartRow || null;
    const lineN = lineTable.length;

    let row = 0, maxRowExtent = 0, maxSegs = 0, maxGlyphHeight = 0;
    for (let L = 0; L < lineN; L++) {
        if (lsr) lsr[lineRowBase + L] = row;
        const end = L + 1 < lineN ? lineTable[L + 1] : slotCount;
        let acc = 0, onSegment = 0, segs = 0;
        for (let s = lineTable[L]; s < end; s++) {
            if (wrap > 0 && onSegment >= wrap) {
                if (acc > maxRowExtent) maxRowExtent = acc;
                acc = 0; onSegment = 0; segs++;
            }
            if (xo) xo[xBase + s] = acc;
            const si = (sizeBase + s) * 2;
            acc += sizes[si];
            if (sizes[si + 1] > maxGlyphHeight) maxGlyphHeight = sizes[si + 1];
            onSegment++;
        }
        if (acc > maxRowExtent) maxRowExtent = acc;
        if (segs > maxSegs) maxSegs = segs;
        row += 1 + segs;
    }
    return { maxRowExtent, totalRows: row, maxSegs, maxGlyphHeight };
}

/**
 * Visual rows a line occupies and the deepest segment index it reaches — closed form
 * from the line's slot count, because `wrapWidth` counts SLOTS: a double-advance emoji
 * costs exactly one against the budget, so wrap points land on exact multiples and the
 * per-line wrap-column table the CPU era materialized was an arithmetic sequence stored
 * so it could be searched back into the division that produced it.
 *
 * @param {number} slotCount - codepoints on the line
 * @param {number} wrapWidth - slots per visual row, 0 = no wrap
 * @returns {number} the line's deepest wrap segment index (rows occupied = this + 1)
 */
export function lineSegments(slotCount, wrapWidth) {
    if (!(wrapWidth > 0) || slotCount <= 1) return 0;
    return Math.floor((slotCount - 1) / wrapWidth);
}

/**
 * LayoutGenerator — High-speed CPU text layout generator emitting 32-byte RenderSlots.
 *
 * Produces deterministic, ordered InstancedSlotBuffer instances directly from text
 * using MonospaceShapeCache / FontChain. Rows place in flow; the page fold is
 * foldGeometry's pageFold/pageShift — the same one LayoutDescription answers caret,
 * pick, and extent queries with — applied once the widest row is known.
 *
 * ONE SLOT PER CODEPOINT — tab and CR included — so a slot's offset in its line IS the
 * column, and caret, highlight, and syntax color address one space with no mapping.
 *
 * TAB STOPS (the glyph3d-rs rule, fold::TabWidth): a tab advances to the next multiple of
 * `tabWidth` DISPLAY CELLS counted from the start of its LOGICAL line — a double-width
 * glyph counts two, a zero-width one none, and a wrap segment or page does not restart
 * the count. A tab on a stop spans a whole stop. Its COLUMN is still one: wrap, rows and
 * pages count slots, never cells. It draws as the space glyph (no curves, so nothing
 * shows unless a fill highlight spans it).
 */

import { InstancedSlotBuffer, packRgba8, SLOT_FLOATS, LANE_POS_X, LANE_POS_Y, LANE_POS_Z, LANE_ADVANCE } from './InstancedSlotBuffer.js';
import { pageFold, pageShift } from './foldGeometry.js';
import { DEFAULT_LAYOUT } from '../workers/builders/index.js';

/**
 * Generate a 32-byte InstancedSlotBuffer from text.
 *
 * @param {string|string[]} text - Input string or array of lines
 * @param {Object} [options]
 * @param {Object} [options.shaper] - FontChain or MonospaceShapeCache (optional)
 * @param {Object} [options.metrics] - cell metrics (core/cellMetrics): { charWidth, charHeight, lineSpacing, letterSpacing, worldScale }
 * @param {{x:number, y:number, z:number}} [options.origin={x:0, y:0, z:0}] - World space origin
 * @param {number} [options.wrapWidth=200] - Columns before wrapping (0 = off)
 * @param {number} [options.zWrapSpacing=0.15] - Z step per intra-line wrap as multiple of charHeight
 * @param {number} [options.pageHeight=0] - Visual rows per page (0 = off)
 * @param {number} [options.pagesWide=1] - Number of pages wide
 * @param {number} [options.pageGapX=10] - Gap between pages in character widths
 * @param {number} [options.pageGapY=10] - Gap between page rows in line heights
 * @param {number} [options.pageDepth=20] - Gap between page planes in z
 * @param {string} [options.axis='xy'] - 'xy' (newspaper) or 'z' (z-pages)
 * @param {number|{r:number, g:number, b:number, a?:number}} [options.color] - Default text color
 * @param {number} [options.groupId=0] - Group index for group table TRS
 * @param {Array<{start:number, end:number, color:number}>} [options.spans] - Optional syntax color spans
 * @param {InstancedSlotBuffer} [options.targetBuffer] - Optional reusable buffer
 * @param {number} [options.tabWidth] - tab stop in display cells (default DEFAULT_LAYOUT.tabWidth)
 * @param {Float32Array} [options.targetSizes] - reusable [advance, height] table
 * @returns {{ buffer: InstancedSlotBuffer, sizes: Float32Array, glyphCount: number, lineStarts: Int32Array, lineLengths: Int32Array, lineStartRows: Int32Array, totalRows: number, maxRowExtent: number, maxSegs: number, page: ReturnType<typeof pageFold>, bounds: { min: {x:number, y:number, z:number}, max: {x:number, y:number, z:number}, width:number, height:number, depth:number } }}
 */
export function generateLayout(text, options = {}) {
    const lines = Array.isArray(text) ? text : (typeof text === 'string' ? text.split('\n') : []);
    const shaper = options.shaper || null;
    const metrics = options.metrics || {};

    const worldScale = metrics.worldScale || 0.025;
    const charWidth = metrics.charWidth || (48 * 0.6 * worldScale);
    const charHeight = metrics.charHeight || (48 * 1.15 * worldScale);
    const lineSpacing = metrics.lineSpacing || (charHeight * 1.2);
    const upem = (shaper && shaper.upem)
        ? shaper.upem
        : (shaper && shaper._shaper && shaper._shaper.upem)
            ? shaper._shaper.upem
            : 2048;

    const origin = options.origin || { x: 0, y: 0, z: 0 };
    const wrapWidth = options.wrapWidth !== undefined ? Math.max(0, Math.trunc(options.wrapWidth)) : 200;
    const zStep = (options.zWrapSpacing !== undefined ? options.zWrapSpacing : 0.15) * charHeight;

    const D = DEFAULT_LAYOUT;
    const fold = {
        pageHeight: Math.max(0, Math.trunc(options.pageHeight || 0)),
        pagesWide: options.pagesWide ?? D.pagesWide,
        pageGapX: options.pageGapX ?? D.pageGapX,
        pageGapY: options.pageGapY ?? D.pageGapY,
        pageDepth: options.pageDepth ?? D.pageDepth,
        axis: options.axis,
    };

    const defaultColorPacked = typeof options.color === 'number'
        ? ((((options.color & 0xFF) << 16) | (options.color & 0xFF00) | ((options.color >> 16) & 0xFF) | 0xFF000000) >>> 0)
        : packRgba8(
            options.color?.r ?? 1.0,
            options.color?.g ?? 1.0,
            options.color?.b ?? 1.0,
            options.color?.a ?? 1.0
        );
    const groupId = (options.groupId || 0) >>> 0;
    const spans = options.spans || null;

    // Fast estimate of total codepoints
    let approxTotalGlyphs = 0;
    for (let i = 0; i < lines.length; i++) {
        approxTotalGlyphs += lines[i].length;
    }

    const isAppend = !!options.append;
    const slotBuffer = options.targetBuffer || new InstancedSlotBuffer(Math.max(approxTotalGlyphs, 16));
    if (!isAppend) {
        slotBuffer.clear();
    }
    const startSlot = isAppend ? slotBuffer.count : 0;
    slotBuffer.ensureCapacity(startSlot + approxTotalGlyphs);

    const lineCount = lines.length;
    const lineStarts = new Int32Array(lineCount);
    const lineLengths = new Int32Array(lineCount);
    const lineStartRows = new Int32Array(lineCount);
    const scrollOffset = options.scrollOffset || 0;

    let totalGlyphs = startSlot;
    let baseRow = 0;
    let maxRowExtent = 0;
    let maxSegs = 0;

    // Per-slot [advance, height] — LayoutDescription's sizes, so positionAt sums the REAL
    // advances (tabs, emoji). Slot-global like the buffer; reuses `targetSizes` when it fits.
    const sizesNeeded = (startSlot + approxTotalGlyphs) * 2;
    let sizes = options.targetSizes;
    if (!sizes || sizes.length < sizesNeeded) {
        const grown = new Float32Array(sizesNeeded);
        if (sizes && isAppend) grown.set(sizes.subarray(0, Math.min(sizes.length, startSlot * 2)));
        sizes = grown;
    }

    const tabWidth = Math.max(1, Math.trunc(options.tabWidth ?? D.tabWidth));
    let spaceGid = null;
    const spaceGlyphId = () => {
        if (spaceGid === null) {
            const s = shaper?.lookup ? shaper.lookup(32) : shaper?.shape ? shaper.shape(' ')?.[0] : null;
            spaceGid = s ? s.g : 32;
        }
        return spaceGid;
    };

    // Each slot's screen row, kept for the page fold (which needs the FINAL widest row).
    const slotRows = fold.pageHeight > 0 ? new Int32Array(approxTotalGlyphs) : null;

    let charOffsetGlobal = 0;
    let activeSpanIdx = 0;

    for (let lineIdx = 0; lineIdx < lineCount; lineIdx++) {
        lineStarts[lineIdx] = totalGlyphs;
        lineStartRows[lineIdx] = baseRow;
        const line = lines[lineIdx];
        const lineLen = line.length;

        let col = 0;
        let lineAdv = 0.0;
        let segAdv = 0.0;
        let curSeg = 0;
        let lineCells = 0;   // display cells from the logical line's start (the tab-stop count)

        for (let i = 0; i < lineLen; i++) {
            const cp = line.codePointAt(i);
            // Skip second code unit of surrogate pair
            if (cp > 0xFFFF) {
                i++;
            }

            // Resolve glyph and advance
            let glyphId = 0;
            let advance = charWidth;
            if (cp === 9) {
                // A tab: the space glyph, advancing to the next stop.
                const k = tabWidth - (lineCells % tabWidth);
                glyphId = spaceGlyphId();
                advance = k * charWidth;
                lineCells += k;
            } else if (shaper) {
                let shape = null;
                if (typeof shaper.lookup === 'function') {
                    shape = shaper.lookup(cp);
                } else if (typeof shaper.shape === 'function') {
                    const shaped = shaper.shape(String.fromCodePoint(cp));
                    if (shaped && shaped.length > 0) {
                        shape = shaped[0];
                    }
                }
                if (shape) {
                    glyphId = shape.g;
                    advance = (shape.ax / upem) * (charHeight / 1.15); // preserve font em proportion
                } else {
                    glyphId = cp;
                }
            } else {
                glyphId = cp;
            }
            if (cp !== 9) lineCells += Math.max(0, Math.round(advance / charWidth));

            // Intra-line wrapping, by slot count: a new segment starts its advance at 0.
            const wrapSeg = wrapWidth > 0 ? Math.floor(col / wrapWidth) : 0;
            if (wrapSeg !== curSeg) {
                curSeg = wrapSeg;
                segAdv = 0;
            }
            if (wrapSeg > maxSegs) maxSegs = wrapSeg;

            const screenRow = baseRow + wrapSeg - scrollOffset;

            // Flow position; the page fold (if on) is applied after the loop.
            const posX = origin.x + ((wrapWidth > 0) ? segAdv : lineAdv);
            // The anchor (core/foldGeometry ROW CONVENTION): pen origin x, cell-center y;
            // row 0's center sits ON origin.y.
            const posY = origin.y - (screenRow * lineSpacing);
            const posZ = origin.z - (wrapSeg * zStep);
            if (slotRows) slotRows[totalGlyphs - startSlot] = screenRow;

            // Color resolution (spans override)
            let glyphColor = defaultColorPacked;
            if (spans && spans.length > 0) {
                while (activeSpanIdx < spans.length && charOffsetGlobal >= spans[activeSpanIdx].end) {
                    activeSpanIdx++;
                }
                if (activeSpanIdx < spans.length && charOffsetGlobal >= spans[activeSpanIdx].start) {
                    glyphColor = spans[activeSpanIdx].color;
                }
            }

            // Write slot deterministically in line/col order
            sizes[totalGlyphs * 2] = advance;
            sizes[totalGlyphs * 2 + 1] = charHeight;
            slotBuffer.pushSlot(
                posX,
                posY,
                posZ,
                glyphId,
                glyphColor,
                groupId,
                advance,
                charHeight
            );

            col++;
            lineAdv += advance;
            segAdv += advance;
            // The widest VISUAL row — a wrapped line contributes its segments, not its length.
            const rowExtent = wrapWidth > 0 ? segAdv : lineAdv;
            if (rowExtent > maxRowExtent) maxRowExtent = rowExtent;
            totalGlyphs++;
            charOffsetGlobal++;
        }

        lineLengths[lineIdx] = col;

        // Advance visual row for next line
        const lineWrapSegs = (wrapWidth > 0 && col > 0) ? Math.floor((col - 1) / wrapWidth) : 0;
        baseRow += (1 + lineWrapSegs);
        charOffsetGlobal++; // newline char
    }

    // The page fold, from the final widest row — so every column shares one stride.
    // Always built: rows 0 = pagination off, and it still carries the row pitch the
    // description's positionAt reads.
    const page = pageFold(fold, { charWidth, letterSpacing: metrics.letterSpacing || 0, lineSpacing }, maxRowExtent);
    const f32 = slotBuffer.f32;
    if (slotRows) {
        for (let s = startSlot; s < totalGlyphs; s++) {
            const shift = pageShift(slotRows[s - startSlot], page);
            const b = s * SLOT_FLOATS;
            f32[b + LANE_POS_X] += shift.dx;
            f32[b + LANE_POS_Y] = origin.y - shift.relY;
            f32[b + LANE_POS_Z] += shift.dz;
        }
    }

    // Ink bounds over the placed slots (merged with the prior item's when appending).
    const prev = isAppend ? options.previousBounds : null;
    let inkMinX = prev ? prev.min.x : Infinity, inkMaxX = prev ? prev.max.x : -Infinity;
    let inkMinY = prev ? prev.min.y : Infinity, inkMaxY = prev ? prev.max.y : -Infinity;
    let inkMinZ = prev ? prev.min.z : Infinity, inkMaxZ = prev ? prev.max.z : -Infinity;
    for (let s = startSlot; s < totalGlyphs; s++) {
        const b = s * SLOT_FLOATS;
        const x = f32[b + LANE_POS_X], y = f32[b + LANE_POS_Y], z = f32[b + LANE_POS_Z];
        if (x < inkMinX) inkMinX = x;
        if (x + f32[b + LANE_ADVANCE] > inkMaxX) inkMaxX = x + f32[b + LANE_ADVANCE];
        if (y - charHeight * 0.5 < inkMinY) inkMinY = y - charHeight * 0.5;
        if (y + charHeight * 0.5 > inkMaxY) inkMaxY = y + charHeight * 0.5;
        if (z < inkMinZ) inkMinZ = z;
        if (z > inkMaxZ) inkMaxZ = z;
    }

    const bounds = totalGlyphs > 0 ? {
        min: { x: inkMinX, y: inkMinY, z: inkMinZ },
        max: { x: inkMaxX, y: inkMaxY, z: inkMaxZ },
        width: inkMaxX - inkMinX,
        height: inkMaxY - inkMinY,
        depth: inkMaxZ - inkMinZ,
    } : {
        min: { x: origin.x, y: origin.y, z: origin.z },
        max: { x: origin.x, y: origin.y, z: origin.z },
        width: 0,
        height: 0,
        depth: 0,
    };

    slotBuffer.count = totalGlyphs;

    return {
        buffer: slotBuffer,
        glyphCount: totalGlyphs,
        lineStarts,
        lineLengths,
        lineStartRows,
        totalRows: baseRow,
        maxRowExtent,
        maxSegs,
        page,
        sizes,
        bounds,
    };
}

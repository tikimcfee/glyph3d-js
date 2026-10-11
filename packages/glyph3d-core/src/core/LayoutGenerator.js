/**
 * LayoutGenerator — High-speed CPU text layout generator emitting 32-byte RenderSlots.
 *
 * Produces deterministic, ordered InstancedSlotBuffer instances directly from text
 * using MonospaceShapeCache / FontChain and fold geometry rules.
 */

import { InstancedSlotBuffer, packRgba8 } from './InstancedSlotBuffer.js';

export const DEFAULT_LAYOUT_CONFIG = {
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
 * Generate a 32-byte InstancedSlotBuffer from text.
 *
 * @param {string|string[]} text - Input string or array of lines
 * @param {Object} [options]
 * @param {Object} [options.shaper] - FontChain or MonospaceShapeCache (optional)
 * @param {Object} [options.metrics] - { charWidth, charHeight, lineHeight, worldScale, pixelWidth, pixelHeight }
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
 * @returns {{ buffer: InstancedSlotBuffer, glyphCount: number, lineStarts: number[], totalRows: number, bounds: { min: {x:number, y:number, z:number}, max: {x:number, y:number, z:number}, width:number, height:number, depth:number } }}
 */
export function generateLayout(text, options = {}) {
    const lines = Array.isArray(text) ? text : (typeof text === 'string' ? text.split('\n') : []);
    const shaper = options.shaper || null;
    const metrics = options.metrics || {};

    const worldScale = metrics.worldScale || 0.025;
    const charWidth = metrics.charWidth || (48 * 0.6 * worldScale);
    const charHeight = metrics.charHeight || (48 * 1.15 * worldScale);
    const lineHeight = metrics.lineHeight || metrics.lineSpacing || (charHeight * 1.2);
    const upem = (shaper && shaper.upem)
        ? shaper.upem
        : (shaper && shaper._shaper && shaper._shaper.upem)
            ? shaper._shaper.upem
            : 2048;

    const origin = options.origin || { x: 0, y: 0, z: 0 };
    const wrapWidth = options.wrapWidth !== undefined ? Math.max(0, Math.trunc(options.wrapWidth)) : 200;
    const zStep = (options.zWrapSpacing !== undefined ? options.zWrapSpacing : 0.15) * charHeight;

    const pageHeight = Math.max(0, Math.trunc(options.pageHeight || 0));
    const pagesWide = Math.max(1, Math.trunc(options.pagesWide || 1));
    const pageGapX = (options.pageGapX || 10) * charWidth;
    const pageGapY = (options.pageGapY || 10) * lineHeight;
    const pageDepth = (options.pageDepth || 20) * lineHeight;
    const axis = options.axis === 'z' ? 'z' : 'xy';

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

    let inkMinX = (isAppend && options.previousBounds) ? options.previousBounds.min.x : Infinity;
    let inkMinY = (isAppend && options.previousBounds) ? options.previousBounds.min.y : Infinity;
    let inkMinZ = (isAppend && options.previousBounds) ? options.previousBounds.min.z : Infinity;
    let inkMaxX = (isAppend && options.previousBounds) ? options.previousBounds.max.x : -Infinity;
    let inkMaxY = (isAppend && options.previousBounds) ? options.previousBounds.max.y : -Infinity;
    let inkMaxZ = (isAppend && options.previousBounds) ? options.previousBounds.max.z : -Infinity;

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

        for (let i = 0; i < lineLen; i++) {
            const cp = line.codePointAt(i);
            // Skip second code unit of surrogate pair
            if (cp > 0xFFFF) {
                i++;
            }

            // Tabs expand to next 4-space tabstop
            if (cp === 9) {
                const tabWidth = 4;
                const spaces = tabWidth - (col % tabWidth);
                col += spaces;
                lineAdv += spaces * charWidth;
                segAdv += spaces * charWidth;
                charOffsetGlobal++;
                continue;
            }

            // Carriage return skip
            if (cp === 13) {
                charOffsetGlobal++;
                continue;
            }

            // Resolve glyph and advance
            let glyphId = 0;
            let advance = charWidth;
            if (shaper) {
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

            // Intra-line wrapping
            let wrapSeg = 0;
            let segCol = col;
            if (wrapWidth > 0 && col >= wrapWidth) {
                wrapSeg = Math.floor(col / wrapWidth);
                segCol = col % wrapWidth;
                if (segCol === 0) {
                    segAdv = 0.0;
                }
            }
            if (wrapSeg > maxSegs) maxSegs = wrapSeg;

            const visualRow = baseRow + wrapSeg;
            const screenRow = visualRow - scrollOffset;

            // Compute Base X, Y, Z before pagination
            const itemRelX = (wrapWidth > 0) ? segAdv : lineAdv;
            let posX = origin.x + itemRelX;
            // Vertical anchor is cell vertical center
            let posY = origin.y - (screenRow * lineHeight) - (charHeight * 0.5);
            let posZ = origin.z - (wrapSeg * zStep);

            // Pagination calculation
            if (pageHeight > 0 && screenRow >= pageHeight) {
                const pageIdx = Math.floor(screenRow / pageHeight);
                const rowInPage = screenRow % pageHeight;
                posY = origin.y - (rowInPage * lineHeight) - (charHeight * 0.5);

                if (axis === 'z') {
                    posZ -= pageIdx * pageDepth;
                } else {
                    const colPage = pageIdx % pagesWide;
                    const rowPage = Math.floor(pageIdx / pagesWide);
                    posX += colPage * (maxRowExtent + pageGapX);
                    posY -= rowPage * (pageHeight * lineHeight + pageGapY);
                }
            }

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

            // Bounds accumulation
            const right = posX + advance;
            const top = posY + charHeight * 0.5;
            const bottom = posY - charHeight * 0.5;
            if (posX < inkMinX) inkMinX = posX;
            if (right > inkMaxX) inkMaxX = right;
            if (bottom < inkMinY) inkMinY = bottom;
            if (top > inkMaxY) inkMaxY = top;
            if (posZ < inkMinZ) inkMinZ = posZ;
            if (posZ > inkMaxZ) inkMaxZ = posZ;

            col++;
            lineAdv += advance;
            segAdv += advance;
            if (segAdv > maxRowExtent) maxRowExtent = segAdv;
            if (lineAdv > maxRowExtent) maxRowExtent = lineAdv;
            totalGlyphs++;
            charOffsetGlobal++;
        }

        lineLengths[lineIdx] = col;

        // Advance visual row for next line
        const lineWrapSegs = (wrapWidth > 0 && col > 0) ? Math.floor((col - 1) / wrapWidth) : 0;
        baseRow += (1 + lineWrapSegs);
        charOffsetGlobal++; // newline char
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
        bounds,
    };
}

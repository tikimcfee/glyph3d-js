/**
 * evaluateFold — the layout fold as a bulk CPU evaluator.
 *
 * The SAME pure function the GPU kernel runs (GlyphLayoutKernel) and the mirror answers
 * point queries with (LayoutDescription.positionAt), evaluated across a whole item into a
 * TRANSIENT Float32Array. This is the measurement primitive for consumers that need many
 * positions at once on the CPU — arrangers sizing AST blocks, box overlays, debug dumps —
 * without a persistent position buffer existing anywhere. Call, measure, drop.
 *
 * Three evaluators, one fold: parity is standing test coverage (tools/layout-mirror.test.mjs
 * binds this and positionAt to the builder; tools/layout-kernel-check.mjs binds the kernel).
 * Worker-safe: no DOM, no three.
 */

import { paginationShift } from '../workers/builders/index.js';

/**
 * Min/max extent of a contiguous slot range over an explicit position source — the live
 * CPU buffer or an evaluateFold scratch alike (both stride 3). The measurement primitive
 * behind arranger block sizing and strata boxes; GlyphField.measureSlotRange remains the
 * buffer-backed convenience for CPU-engine fields.
 * @param {Float32Array} pos - stride-3 positions
 * @param {Float32Array} sizes - stride-2 [advance, height] per slot
 * @param {number} startSlot inclusive
 * @param {number} count
 * @returns {{min:{x,y,z},max:{x,y,z},width:number,height:number,depth:number}|null}
 */
export function measureSlotSpan(pos, sizes, startSlot, count) {
    if (!pos || !sizes || count <= 0) return null;
    const start = Math.max(0, startSlot | 0);
    const end = Math.min((pos.length / 3) | 0, start + count);
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let s = start; s < end; s++) {
        const px = pos[s * 3], py = pos[s * 3 + 1], pz = pos[s * 3 + 2];
        const sw = sizes[s * 2], sh = sizes[s * 2 + 1];
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (pz < minZ) minZ = pz;
        if (px + sw > maxX) maxX = px + sw;
        if (py + sh > maxY) maxY = py + sh;
        if (pz > maxZ) maxZ = pz;
    }
    if (minX === Infinity) return null;
    return {
        min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ },
        width: maxX - minX, height: maxY - minY, depth: maxZ - minZ,
    };
}

/**
 * @param {Object} p
 * @param {number} p.slotCount - item-local slot count
 * @param {Uint32Array|Int32Array|number[]} p.lineTable - item-local line-start slot indexes
 * @param {Float32Array} p.advances - world advance per item-local slot
 * @param {{x:number,y:number,z:number}} [p.origin]
 * @param {number} [p.scrollOffset] - visual rows scrolled
 * @param {number} [p.wrapWidth] - slots per visual row, 0 = no wrap
 * @param {number} p.lineSpacing
 * @param {number} [p.zStep] - world z per wrap segment
 * @param {?Object} [p.geom] - paginationGeometry output, null/pageHeightWorld<=0 = off
 * @param {?Float32Array} [p.displacements] - flat [dx,dy,dz] per slot (ITEM-LOCAL here;
 *   field-global callers pass a subarray at the item's base)
 * @param {Float32Array} [p.out] - reuse a scratch array (length ≥ slotCount*3)
 * @returns {Float32Array} slotCount×3 positions
 */
export function evaluateFold(p) {
    const {
        slotCount, lineTable, advances,
        origin = { x: 0, y: 0, z: 0 },
        scrollOffset = 0, wrapWidth = 0, lineSpacing, zStep = 0,
        geom = null, displacements = null,
    } = p;
    const out = p.out && p.out.length >= slotCount * 3 ? p.out : new Float32Array(slotCount * 3);
    const wrap = Math.max(0, Math.trunc(wrapWidth));
    const lines = lineTable.length;
    const paged = !!(geom && geom.pageHeightWorld > 0);

    let row0 = 0;   // visual row of the current line's first row
    for (let L = 0; L < lines; L++) {
        const start = lineTable[L];
        const end = L + 1 < lines ? lineTable[L + 1] : slotCount;
        let x = 0, seg = 0, onRow = 0;
        for (let s = start; s < end; s++) {
            if (wrap > 0 && onRow >= wrap) { x = 0; onRow = 0; seg++; }
            const screenRow = row0 + seg - scrollOffset;
            let px = origin.x + x;
            let py = origin.y - screenRow * lineSpacing;
            let pz = origin.z - seg * zStep;
            if (paged) {
                const { shiftX, mappedRelY, shiftZ } = paginationShift(origin.y - py, geom);
                px += shiftX; py = origin.y - mappedRelY; pz += shiftZ;
            }
            if (displacements) {
                const d = s * 3;
                px += displacements[d]; py += displacements[d + 1]; pz += displacements[d + 2];
            }
            const o = s * 3;
            out[o] = px; out[o + 1] = py; out[o + 2] = pz;
            x += advances[s]; onRow++;
        }
        row0 += 1 + seg;
    }
    return out;
}

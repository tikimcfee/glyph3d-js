/**
 * GlyphLayoutCompute — the GPU layout engine behind a GlyphField, as an adapter.
 *
 * DUAL-COMPUTE CONTRACT (v1): the CPU builder remains fully authoritative — its positions
 * land in the field's storage-backed instancePosition exactly as always, and every CPU
 * consumer (positionAt, caret, arrangers, bounds) reads that array. What this adapter adds:
 * after each commit, it re-derives every ELIGIBLE item's positions in the compute kernel and
 * writes them into the SAME attribute, GPU-side. The kernel is bit-exact against the builder
 * (tools/layout-kernel-check.mjs is the gate), so the write is invisible when correct and
 * loudly visible when not — a live assertion of the GPU engine against real content.
 *
 * That contract is what makes the layout.gpu toggle an ENGINE choice, never a feature
 * switch: an item the kernel can't serve (scaled items, arranged grids) is simply SKIPPED —
 * its CPU values stand, and any later CPU write re-uploads the authoritative array wholesale.
 * Nothing can break; the worst case is a dispatch that didn't happen. v2 starts eliding CPU
 * work per-path (param-only refolds first), leaning on this same seam.
 *
 * The renderer is registered once at engine boot (setComputeRenderer) because core objects
 * live below the renderer: the two-SceneContext topology means a CodeGrid cannot reach it
 * through any ctx it owns.
 */

import GlyphLayoutKernel from './GlyphLayoutKernel.js';

let _renderer = null;
let _enabled = false;

/** Register the app's initialized WebGPURenderer (engine boot). Null unregisters. */
export function setComputeRenderer(renderer) { _renderer = renderer || null; }

/** The layout.gpu toggle — an engine choice; content and features are identical either way. */
export function setGpuLayoutEnabled(on) { _enabled = !!on; }

/** On only when both the toggle is set AND a renderer is registered. */
export function isGpuLayoutEnabled() { return _enabled && _renderer !== null; }

/**
 * Re-derive positions on the GPU for every eligible item just committed to `field`.
 * Fire-and-forget: dispatches are ENCODED synchronously per item (uniforms are read at
 * encode, so sequential configure→dispatch on one kernel is safe without awaits — the
 * bulk-lane lesson: awaiting between items costs more than the GPU work itself).
 *
 * @param {import('../GlyphField.js').default} field
 * @param {Object} buffers - buildBatchBuffers output (positions/sizes/count/itemMeta)
 * @param {Array}  items   - the items that produced `buffers` (origin + scale per item)
 * @param {{metrics: Object, layout: Object, scrollOffset?: number}} shared - the SAME bag
 *   the builder consumed; world conversions here mirror paginationGeometry exactly.
 * @returns {number} items dispatched (skipped items keep their CPU positions)
 */
export function syncGpuLayout(field, buffers, items, shared) {
    if (!isGpuLayoutEnabled()) return 0;
    const attr = field?.instanceMesh?.geometry?.attributes?.instancePosition;
    if (!attr || attr.isStorageInstancedBufferAttribute !== true) return 0;
    const { metrics, layout } = shared || {};
    if (!metrics || !layout || !buffers?.itemMeta || !buffers.count) return 0;

    const itemMeta = buffers.itemMeta;
    let maxLines = 1;
    for (const m of itemMeta) maxLines = Math.max(maxLines, (m?.lineSlotOffsets || [0]).length);

    let kernel = null;
    let dispatched = 0;
    try {
        kernel = new GlyphLayoutKernel(_renderer, {
            maxSlots: buffers.count, maxLines, positionsAttribute: attr,
        });
        const wrap = Math.max(0, Math.trunc(layout.wrapWidth || 0));
        const charAdvance = metrics.charWidth + metrics.letterSpacing;   // paginationGeometry's nominal cell

        for (let i = 0; i < itemMeta.length; i++) {
            const meta = itemMeta[i];
            const item = items?.[i];
            if (!meta || !item || !meta.glyphCount) continue;
            // Scaled items: the builder scales advances but not the line pitch — unverified
            // against the gate, so the CPU values stand until a fixture earns it.
            if ((item.scale ?? 1) !== 1) continue;

            const base = meta.bufferStartIndex;
            const lso = meta.lineSlotOffsets || [base];
            const lineTable = new Uint32Array(lso.length);
            for (let L = 0; L < lso.length; L++) lineTable[L] = lso[L] - base;   // global → item-local

            const lineStartRow = new Uint32Array(lineTable.length);
            let row = 0;
            for (let L = 0; L < lineTable.length; L++) {
                lineStartRow[L] = row;
                const end = L + 1 < lineTable.length ? lineTable[L + 1] : meta.glyphCount;
                const n = end - lineTable[L];
                row += 1 + (wrap > 0 && n > 0 ? Math.floor((n - 1) / wrap) : 0);
            }

            const advances = new Float32Array(meta.glyphCount);
            for (let s = 0; s < meta.glyphCount; s++) advances[s] = buffers.sizes[(base + s) * 2];

            kernel.configure({
                slotCount: meta.glyphCount, lineTable, lineStartRow, advances, outBase: base,
                params: {
                    origin: item.position || { x: 0, y: 0, z: 0 },
                    scrollOffset: shared.scrollOffset || 0,
                    wrapWidth: wrap,
                    lineSpacing: metrics.lineSpacing,
                    zWrapStep: metrics.charHeight * (layout.zWrapSpacing || 0),
                    // pageContentWidth is the builder's own "pagination fired" witness — using
                    // it as the gate keeps exact-boundary parity by construction.
                    pageHeight: meta.pageContentWidth > 0 ? layout.pageHeight : 0,
                    pagesWide: layout.pagesWide,
                    pageWidthWorld: meta.pageContentWidth || 0,
                    pageGapXWorld: (layout.pageGapX || 0) * charAdvance,
                    pageGapYWorld: (layout.pageGapY || 0) * metrics.lineSpacing,
                    pageDepthWorld: (layout.pageDepth || 0) * metrics.lineSpacing,
                    axis: layout.axis || 'xy',
                },
            });
            kernel.computeSync();
            dispatched++;
        }
    } catch (err) {
        // The engine failing is a report, never a regression: CPU positions are already in
        // the attribute, so rendering is untouched.
        console.warn('GlyphLayoutCompute: GPU layout dispatch failed (CPU positions stand):', err);
    } finally {
        // Submitted work holds its own references — WebGPU defers actual destruction, so
        // releasing the table buffers right after encode is sound.
        if (kernel) kernel.dispose();
    }
    return dispatched;
}

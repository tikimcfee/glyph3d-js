/**
 * GlyphLayoutCompute — the GPU layout engine behind a GlyphField, as an adapter.
 *
 * THE ENGINE CONTRACT: when a field is engine-owned (field.gpuLayout, chosen per commit by
 * CodeGrid's eligibility gate), the kernel is the ONLY position writer — applyPrebuiltBuffers
 * adopts no CPU array, and this adapter's dispatch after each commit IS the layout. CPU
 * consumers answer "where is this glyph" through the fold mirror (LayoutDescription
 * .positionAt — the same pure function, per query), never through a buffer: every input to
 * the fold (line tables, advances, params) is CPU-authored, so nothing is stranded GPU-side
 * and nothing reads back. Parity between mirror, kernel and builder is standing test
 * coverage (tools/layout-mirror.test.mjs, tools/layout-kernel-check.mjs).
 *
 * The layout.gpu toggle is an ENGINE choice, never a feature switch: eligibility keeps
 * anything the kernel can't yet serve (arranged grids, scaled items) on the CPU path
 * wholesale, per field, re-decided every flush. Dispatches are encoded synchronously with
 * no awaits between items — the bulk-lane lesson: awaiting costs more than the GPU work.
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
    if (!isGpuLayoutEnabled() || field?.gpuLayout !== true) return 0;
    const attr = field?.instanceMesh?.geometry?.attributes?.instancePosition;
    if (!attr || attr.isStorageInstancedBufferAttribute !== true) return 0;
    const { metrics, layout } = shared || {};
    if (!metrics || !layout || !buffers?.itemMeta || !buffers.count) return 0;

    const itemMeta = buffers.itemMeta;
    let maxLines = 1;
    for (const m of itemMeta) maxLines = Math.max(maxLines, (m?.lineSlotOffsets || [0]).length);

    // Persistent per-field kernel: the compute node closes over the output attribute, so it
    // lives exactly as long as the attribute does — reused across flushes, replaced only
    // when the field grew (new attribute) or the line capacity is exceeded. The field
    // releases it on engine-off (setGpuLayout) without importing this module.
    let kernel = field._gpuKernel || null;
    if (kernel && (kernel.positions?.value !== attr || maxLines > kernel.maxLines)) {
        kernel.dispose();
        kernel = null;
    }
    let dispatched = 0;
    try {
        if (!kernel) {
            kernel = new GlyphLayoutKernel(_renderer, {
                maxSlots: attr.count, maxLines: Math.max(maxLines, 64), positionsAttribute: attr,
            });
        }
        field._gpuKernel = kernel;
        const wrap = Math.max(0, Math.trunc(layout.wrapWidth || 0));
        const charAdvance = metrics.charWidth + metrics.letterSpacing;   // paginationGeometry's nominal cell

        for (let i = 0; i < itemMeta.length; i++) {
            const meta = itemMeta[i];
            const item = items?.[i];
            if (!meta || !item || !meta.glyphCount) continue;
            // Unreachable under the all-or-nothing eligibility gate (CodeGrid drops the whole
            // field to CPU when any item is scaled). If it ever fires, a silent skip would
            // strand the item at the origin — throw into the loud-failure path instead.
            if ((item.scale ?? 1) !== 1) {
                throw new Error(`engine-owned field carries a scaled item (scale ${item.scale}) — eligibility gate breached`);
            }

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
        // Engine-owned fields have no CPU fallback in the buffer — a failed dispatch is
        // VISIBLY wrong (glyphs at the origin), which is the correct failure mode for the
        // one engine: loud, not silent. Drop the kernel so the next flush rebuilds fresh.
        console.error('GlyphLayoutCompute: GPU layout dispatch FAILED — field renders unlaid until the next flush:', err);
        kernel?.dispose();
        field._gpuKernel = null;
    }
    return dispatched;
}

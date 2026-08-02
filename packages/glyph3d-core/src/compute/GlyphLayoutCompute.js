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
 * Lay out every item just committed to `field` — THE position path for engine fields.
 * Fire-and-forget: dispatches are ENCODED synchronously per item (uniforms are read at
 * encode, so sequential configure→dispatch on one kernel is safe without awaits — the
 * bulk-lane lesson: awaiting between items costs more than the GPU work itself).
 *
 * The engine build carries no positions, so this walk also derives what the builder's
 * position walk used to: the pagination gate (rows vs pageHeight, integer-exact), the
 * measured page width (max row extent — written back to the entry so the caret's geom
 * matches the glyphs), and, for paginated items, a conservative analytic bounds override
 * (the builder's scalar bounds are exact for unpaginated content and ride through).
 *
 * @param {import('../GlyphField.js').default} field
 * @param {Object} buffers - buildBatchBuffers output (sizes/count/itemMeta; positions null)
 * @param {Array}  items   - the items that produced `buffers` (origin + scale per item)
 * @param {{metrics: Object, layout: Object, scrollOffset?: number}} shared - the SAME bag
 *   the builder consumed; world conversions here mirror paginationGeometry exactly.
 * @param {number[]} [rendererIds] - entry ids returned by applyPrebuiltBuffers, parallel
 *   to items — the write-back path for pageContentWidth.
 * @returns {{dispatched: number, bounds: ?Object}} bounds is non-null only when a
 *   paginated item required the analytic override.
 */
export function syncGpuLayout(field, buffers, items, shared, rendererIds) {
    const NONE = { dispatched: 0, bounds: null };
    if (!isGpuLayoutEnabled() || field?.gpuLayout !== true) return NONE;
    const attr = field?.instanceMesh?.geometry?.attributes?.instancePosition;
    if (!attr || attr.isStorageInstancedBufferAttribute !== true) return NONE;
    const { metrics, layout } = shared || {};
    if (!metrics || !layout || !buffers?.itemMeta || !buffers.count) return NONE;

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
    let boundsOverride = null;
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

            // Fused table walk: lineStartRow (visual-row prefix), the advances copy, and the
            // per-row extent scan the builder's position walk used to provide — max row
            // extent (the measured page width) and the deepest wrap segment (the z reach).
            const lineStartRow = new Uint32Array(lineTable.length);
            const advances = new Float32Array(meta.glyphCount);
            let row = 0, maxRowExtent = 0, maxSegs = 0;
            for (let L = 0; L < lineTable.length; L++) {
                lineStartRow[L] = row;
                const start = lineTable[L];
                const end = L + 1 < lineTable.length ? lineTable[L + 1] : meta.glyphCount;
                let acc = 0, onRow = 0, segs = 0;
                for (let s = start; s < end; s++) {
                    if (wrap > 0 && onRow >= wrap) {
                        if (acc > maxRowExtent) maxRowExtent = acc;
                        acc = 0; onRow = 0; segs++;
                    }
                    const a = buffers.sizes[(base + s) * 2];
                    advances[s] = a;
                    acc += a; onRow++;
                }
                if (acc > maxRowExtent) maxRowExtent = acc;
                if (segs > maxSegs) maxSegs = segs;
                row += 1 + segs;
            }
            const totalRows = row;

            // The pagination gate, in INTEGER rows — the builder's totalYSpan > H test with
            // the float slop removed (spec: totalYSpan = (rows−1−scroll)·ls). The measured
            // width writes back to the entry so the caret's paginationGeometry matches the
            // glyphs — the same contract meta.pageContentWidth carried on the CPU path.
            const scroll = Math.trunc(shared.scrollOffset || 0);
            const pageRows = Math.max(0, Math.trunc(layout.pageHeight || 0));
            const paginate = pageRows > 0 && (totalRows - 1 - scroll) > pageRows;
            const pageWidthWorld = paginate ? maxRowExtent : 0;
            const entry = rendererIds ? field.renderedTexts.get(rendererIds[i]) : null;
            if (entry) entry.pageContentWidth = pageWidthWorld;

            const origin = item.position || { x: 0, y: 0, z: 0 };
            const ls = metrics.lineSpacing;
            const zStep = metrics.charHeight * (layout.zWrapSpacing || 0);
            const gapX = (layout.pageGapX || 0) * charAdvance;
            const gapY = (layout.pageGapY || 0) * ls;
            const depth = (layout.pageDepth || 0) * ls;

            kernel.configure({
                slotCount: meta.glyphCount, lineTable, lineStartRow, advances, outBase: base,
                params: {
                    origin,
                    scrollOffset: scroll,
                    wrapWidth: wrap,
                    lineSpacing: ls,
                    zWrapStep: zStep,
                    pageHeight: paginate ? pageRows : 0,
                    pagesWide: layout.pagesWide,
                    pageWidthWorld,
                    pageGapXWorld: gapX,
                    pageGapYWorld: gapY,
                    pageDepthWorld: depth,
                    axis: layout.axis || 'xy',
                },
            });
            kernel.computeSync();
            dispatched++;

            // Paginated items outrun the builder's pre-pagination scalar bounds — override
            // with the closed-form extent (conservative: cell-height padded both ways, real
            // max row width). Unpaginated items keep the builder's exact scalar bounds.
            if (paginate) {
                const lastRow = totalRows - 1 - scroll;
                const maxPage = Math.floor(lastRow / pageRows);
                const H = pageRows * ls;
                const cellH = metrics.charHeight;
                let minX = origin.x, maxX = origin.x + maxRowExtent;
                let minY, maxY = origin.y + Math.max(0, scroll) * ls + cellH;
                let minZ = origin.z - maxSegs * zStep, maxZ = origin.z;
                if ((layout.axis || 'xy') === 'z') {
                    minY = origin.y - H - cellH;
                    minZ -= maxPage * depth;
                } else {
                    const usedCols = Math.min(Math.max(1, Math.trunc(layout.pagesWide || 1)), maxPage + 1);
                    const bands = Math.floor(maxPage / Math.max(1, Math.trunc(layout.pagesWide || 1))) + 1;
                    maxX += (usedCols - 1) * (maxRowExtent + gapX);
                    minY = origin.y - ((bands - 1) * (H + gapY) + H) - cellH;
                }
                if (!boundsOverride) {
                    boundsOverride = { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
                } else {
                    const b = boundsOverride;
                    b.min.x = Math.min(b.min.x, minX); b.min.y = Math.min(b.min.y, minY); b.min.z = Math.min(b.min.z, minZ);
                    b.max.x = Math.max(b.max.x, maxX); b.max.y = Math.max(b.max.y, maxY); b.max.z = Math.max(b.max.z, maxZ);
                }
            }
        }
        // A paginated override must still COVER the unpaginated items (one union box culls
        // the whole field) — fold the builder's scalar bounds in.
        if (boundsOverride && buffers.bounds) {
            const b = boundsOverride, w = buffers.bounds;
            b.min.x = Math.min(b.min.x, w.min.x); b.min.y = Math.min(b.min.y, w.min.y); b.min.z = Math.min(b.min.z, w.min.z);
            b.max.x = Math.max(b.max.x, w.max.x); b.max.y = Math.max(b.max.y, w.max.y); b.max.z = Math.max(b.max.z, w.max.z);
        }
    } catch (err) {
        // Engine-owned fields have no CPU fallback in the buffer — a failed dispatch is
        // VISIBLY wrong (glyphs at the origin), which is the correct failure mode for the
        // one engine: loud, not silent. Drop the kernel so the next flush rebuilds fresh.
        console.error('GlyphLayoutCompute: GPU layout dispatch FAILED — field renders unlaid until the next flush:', err);
        kernel?.dispose();
        field._gpuKernel = null;
    }
    return { dispatched, bounds: boundsOverride };
}

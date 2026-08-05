/**
 * GlyphLayoutCompute — the GPU layout engine behind a GlyphField, as an adapter.
 *
 * THE ENGINE CONTRACT: a grid's field is always engine-owned, the kernel is the ONLY
 * position writer — applyPrebuiltBuffers adopts no CPU position array, and this adapter's
 * dispatch after each commit IS the layout. CPU consumers answer "where is this glyph"
 * through the fold mirror (LayoutDescription.positionAt — the same pure function, per query)
 * and "how big is this" through the fold's extent (LayoutDescription.extent — closed form),
 * never through a buffer: every input to the fold is CPU-authored, so nothing is stranded
 * GPU-side and nothing reads back. Parity between mirror, kernel and evaluator is standing
 * test coverage (tools/layout-mirror.test.mjs, tools/layout-extent.test.mjs,
 * tools/layout-kernel-check.mjs).
 *
 * This adapter does not measure anything. It marshals each item's line table and origin into
 * the kernel; the kernel's own layout scan returns the three scalars a fold's extent is a
 * closed form on, and foldExtent turns them into the box. There is no second walk here and
 * no analytic special case for paginated content — one path, one formula.
 *
 * There is no opt-out and no CPU fallback: dispatches are encoded synchronously with
 * no awaits between items — the bulk-lane lesson: awaiting costs more than the GPU work.
 *
 * The renderer is registered once at engine boot (setComputeRenderer) because core objects
 * live below the renderer: the two-SceneContext topology means a CodeGrid cannot reach it
 * through any ctx it owns.
 */

import GlyphLayoutKernel from './GlyphLayoutKernel.js';
import { pageFold, foldExtent } from '../core/foldGeometry.js';
import { loadStats } from '../core/loadStats.js';

let _renderer = null;
let _deviceLostNoted = false;

/** Register the app's initialized WebGPURenderer (engine boot). Null unregisters. */
export function setComputeRenderer(renderer) { _renderer = renderer || null; _deviceLostNoted = false; }

/** The registered compute renderer (byte-pipeline adapters take it). */
export function getComputeRenderer() { return _renderer; }

/** On when a renderer is registered — the engine is the only layout path for grids. */
export function isGpuLayoutEnabled() { return _renderer !== null; }

/** Increment when kernel code changes invalidate cached kernels. */
const KERNEL_VERSION = 3;

/**
 * Lay out every item just committed to `field` — THE position path for engine fields.
 * Fire-and-forget: the dispatch is ENCODED synchronously (uniforms are read at encode, so
 * configure→computeSync is safe without awaits — the bulk-lane lesson: awaiting between
 * items costs more than the GPU work itself).
 *
 * Each item's extent is recorded on its renderedTexts entry (`entry.fold` = the scan's
 * scalars, `entry.extent` = the box) and the union is returned, so the caller can hand the
 * field its cull box without walking anything.
 *
 * @param {import('../GlyphField.js').default} field
 * @param {Object} buffers - buildBatchBuffers output (sizes/count/itemMeta)
 * @param {Array}  items   - the items that produced `buffers` (origin + scale per item)
 * @param {{metrics: Object, layout: Object, scrollOffset?: number}} shared - the SAME bag
 *   the builder consumed.
 * @param {number[]} [rendererIds] - entry ids returned by applyPrebuiltBuffers, parallel
 *   to items — the write-back path for each item's fold scalars + extent.
 * @returns {{dispatched: number, extent: ?Object}} extent is the union of every item's
 *   fold extent, in the field's local frame; null when nothing was laid out.
 */
export function syncGpuLayout(field, buffers, items, shared, rendererIds) {
    const NONE = { dispatched: 0, extent: null };
    if (!isGpuLayoutEnabled() || field?.gpuLayout !== true) return NONE;
    // A lost device (VRAM exhaustion, driver reset) can never dispatch again — every
    // flush would re-throw createBuffer failures per field forever (the 2026-08-04
    // storm). Go quiet in one log; the app's device-lost handler queues a reload,
    // which is the only real recovery (three can't re-request a device mid-page).
    if (_renderer._isDeviceLost === true) {
        if (!_deviceLostNoted) {
            _deviceLostNoted = true;
            console.warn('GlyphLayoutCompute: GPU device lost — layout dispatches suspended until reload');
        }
        return NONE;
    }
    const attr = field?.instanceMesh?.geometry?.attributes?.instancePosition;
    if (!attr || attr.isStorageInstancedBufferAttribute !== true) return NONE;
    const { metrics, layout } = shared || {};
    if (!metrics || !layout || !buffers?.itemMeta || !buffers.count || !buffers.sizes) return NONE;

    const itemMeta = buffers.itemMeta;
    let maxLines = 1;
    for (const m of itemMeta) maxLines = Math.max(maxLines, (m?.lineSlotOffsets || [0]).length);

    // Persistent per-field kernel: the compute node closes over the output attribute, so it
    // lives exactly as long as the attribute does — reused across flushes, replaced only
    // when the field grew (new attribute), line capacity exceeded, or the kernel version
    // changed (code updates require rebuild). The field releases it on engine-off (setGpuLayout)
    // without importing this module.
    let kernel = field._gpuKernel || null;
    if (kernel && (kernel.positions?.value !== attr || maxLines > kernel.maxLines || (kernel._version || 0) !== KERNEL_VERSION)) {
        kernel.dispose();
        kernel = null;
    }
    try {
        if (!kernel) {
            kernel = new GlyphLayoutKernel(_renderer, {
                maxSlots: attr.count, maxLines: Math.max(maxLines, 64), positionsAttribute: attr,
            });
            kernel._version = KERNEL_VERSION;
        }
        field._gpuKernel = kernel;
        // Arranger displacements: armed BEFORE configure (growth reallocates and drops
        // uploaded tables). The size guard is the misalignment fuse — a table that doesn't
        // cover the field (stale after a content change) must never dispatch; the arranger
        // re-derives at full size on its next arrange.
        const disp = field._layoutDisplacements;
        kernel.setDisplacements(disp && disp.length >= buffers.count * 3 ? disp : null);

        const scroll = Math.trunc(shared.scrollOffset || 0);
        const charAdvance = metrics.charWidth + (metrics.letterSpacing || 0);
        const ls = metrics.lineSpacing;
        const params = {
            scrollOffset: scroll,
            wrapWidth: Math.max(0, Math.trunc(layout.wrapWidth || 0)),
            lineSpacing: ls,
            zWrapStep: metrics.charHeight * (layout.zWrapSpacing || 0),
            pageHeight: Math.max(0, Math.trunc(layout.pageHeight || 0)),
            pagesWide: layout.pagesWide,
            pageGapXWorld: (layout.pageGapX || 0) * charAdvance,
            pageGapYWorld: (layout.pageGapY || 0) * ls,
            pageDepthWorld: (layout.pageDepth || 0) * ls,
            axis: layout.axis || 'xy',
        };

        // ── Marshal every item's line table + origin. No measuring: the kernel's scan
        //    produces the scalars, and foldExtent turns them into a box. ──
        const kernelItems = [];
        const origins = [];
        let totalSlots = 0;
        for (let i = 0; i < itemMeta.length; i++) {
            const meta = itemMeta[i];
            const item = items?.[i];
            if (!meta || !item || !meta.glyphCount) continue;
            // The kernel serves scale-1 items only — CodeGrid has no CPU path to drop to.
            // A silent skip would strand the item at the origin; throw into the
            // loud-failure path instead.
            if ((item.scale ?? 1) !== 1) {
                throw new Error(`engine-owned field carries a scaled item (scale ${item.scale}) — the kernel serves scale-1 items only`);
            }
            const base = meta.bufferStartIndex;
            const lso = meta.lineSlotOffsets || [base];
            const lineTable = new Uint32Array(lso.length);
            for (let L = 0; L < lso.length; L++) lineTable[L] = lso[L] - base;   // global → item-local
            const origin = item.position || { x: 0, y: 0, z: 0 };
            origins.push({ origin, rendererId: rendererIds ? rendererIds[i] : undefined });
            kernelItems.push({
                slotCount: meta.glyphCount,
                lineTable,
                sizes: buffers.sizes,
                sizeBase: base,
                outBase: base,
                params: { ...params, origin },
            });
            totalSlots += meta.glyphCount;
        }
        if (kernelItems.length === 0) return NONE;

        // ONE configure + ONE dispatch for the whole field — the item table carries per-item
        // params; the kernel resolves each thread's item by binary search. configure returns
        // the layout scan's scalars, parallel to kernelItems.
        const t0 = performance.now();
        const scan = kernel.configure({ items: kernelItems, totalSlots });
        kernel.computeSync();
        loadStats.kernelDispatches++;
        loadStats.kernelMs += performance.now() - t0;

        // ── Extents: closed form on the scan's scalars, per item, unioned for the field. ──
        let union = null;
        for (let i = 0; i < kernelItems.length; i++) {
            const s = scan[i];
            const { origin, rendererId } = origins[i];
            const ext = foldExtent({
                totalRows: s.totalRows,
                maxRowExtent: s.maxRowExtent,
                maxSegs: s.maxSegs,
                origin,
                lineSpacing: ls,
                zStep: params.zWrapStep,
                cellHeight: s.maxGlyphHeight || metrics.charHeight,
                scrollOffset: scroll,
                page: pageFold(layout, metrics, s.maxRowExtent),
            });
            const entry = rendererId !== undefined ? field.renderedTexts.get(rendererId) : null;
            if (entry) { entry.fold = s; entry.extent = ext; }
            if (!ext) continue;
            if (!union) {
                union = { min: { ...ext.min }, max: { ...ext.max } };
            } else {
                union.min.x = Math.min(union.min.x, ext.min.x); union.max.x = Math.max(union.max.x, ext.max.x);
                union.min.y = Math.min(union.min.y, ext.min.y); union.max.y = Math.max(union.max.y, ext.max.y);
                union.min.z = Math.min(union.min.z, ext.min.z); union.max.z = Math.max(union.max.z, ext.max.z);
            }
        }
        if (union) {
            union.width = union.max.x - union.min.x;
            union.height = union.max.y - union.min.y;
            union.depth = union.max.z - union.min.z;
        }
        return { dispatched: kernelItems.length, extent: union };
    } catch (err) {
        // Engine-owned fields have no CPU fallback in the buffer — a failed dispatch is
        // VISIBLY wrong (glyphs at the origin), which is the correct failure mode for the
        // one engine: loud, not silent. Drop the kernel so the next flush rebuilds fresh.
        console.error('GlyphLayoutCompute: GPU layout dispatch FAILED — field renders unlaid until the next flush:', err);
        kernel?.dispose();
        field._gpuKernel = null;
        return NONE;
    }
}

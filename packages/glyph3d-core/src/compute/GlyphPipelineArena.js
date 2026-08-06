/**
 * GlyphPipelineArena — ONE byte-in glyph pipeline for the WHOLE APP. The multi-file hoist,
 * wired in: where each grid used to build its own GlyphPipelineKernels (3 ComputeNode
 * codegens per grid, ~2.7ms × hundreds of grids per cold load), the arena owns ONE
 * kernels instance and every grid's file is an ITEM in its item table. A load storm is
 * stage() × N + ONE batched flush — one set of three dispatches serves every grid.
 *
 * The flow:
 *
 *   stage({ bytes, origin, page, wrapWidth, lineHeight, zStep, field })
 *       synchronously appends the file's bytes to the arena, registers the item, runs the
 *       CPU mirror for THAT file (reference runPipeline, window 0 — serial, so the
 *       coherence window is pure cost), attaches the field at the item's byteStart, and
 *       returns a thin per-grid HANDLE. NO dispatch here.
 *   requestFlush()
 *       coalesces every stage in the same macrotask window into ONE flush: setFiles(all
 *       live items) + run — three dispatches for the whole storm. Resolves once encoded
 *       (the readback isn't needed on the load path).
 *   handle.setPage(page) / arena.setItemPage + requestRepaginate()
 *       the conveyor: kernel 3 alone re-runs. Scroll ticks across grids coalesce into one
 *       repaginate the same way.
 *
 * THE HANDLE is what a grid keeps as `_pipeline`: { itemIndex, byteStart, byteLength,
 * mirror, setPage, verify, dispose } — the shape layout.verify (verifyCommands) and the
 * grid's extent/scroll paths read. The mirror is the grid's CPU oracle (extents, caret,
 * highlight queries never touch the GPU).
 *
 * GROWTH: exceeding byte capacity reallocates the kernels (×2, or ×1.25 past a single
 * oversized file), re-uploads every live item and re-dispatches — rare and loud, never a
 * silent fallback. Item capacity overflow likewise (×2).
 *
 * DISPOSE LEAKS (v1, documented): a disposed/restaged grid's item stays in the arena —
 * byteStarts are the fields' read offsets, so splicing the buffer would invalidate every
 * later item. The arena grows monotonically per page load; a page reload resets it.
 * Compaction is a later milestone.
 *
 * The miss flow is the arena's one background continuation: after a flush, readMisses →
 * encodeMisses → if the atlas grew, rebuild the shared trie, rebuild the kernels around
 * it, re-upload + re-dispatch everything, re-attach every live field. A generation guard
 * drops the continuation when a newer flush already ran.
 *
 * Device loss mirrors GlyphLayoutCompute: a lost device can never dispatch again, so the
 * arena goes quiet in one log (the app's device-lost handler queues a reload — the only
 * real recovery).
 */

import GlyphPipelineKernels from './glyphPipelineKernels.js';
import { runPipeline, paginate as refPaginate, boundsReduce as refBoundsReduce } from './glyphPipelineReference.js';
import { buildLiveTrie, encodeMisses } from './liveTrie.js';
import { loadStats } from '../core/loadStats.js';

/** Bounds box → the {min, max} shape GlyphField.setLayoutExtent states. */
function extentOf(mirror) {
    const b = mirror?.bounds;
    return b ? { min: b.min, max: b.max } : null;
}

export default class GlyphPipelineArena {
    /**
     * @param {import('three/webgpu').WebGPURenderer} renderer - the app's compute renderer
     * @param {Object} atlas - the booted GlyphAtlas (the trie's source)
     * @param {Object} [opts]
     * @param {number} [opts.maxBytes=1M] - arena byte capacity (one slot per byte). Mind the
     *   multiplier: a slot is 11 f32 = 44B, so 1M bytes of source ≈ 44MB of GPU buffer. A
     *   16M default once allocated ~700MB and OOM'd the GPU process — every browser on the
     *   box fell back to WebGL2. Growth (×1.25–2) is cheap; start modest.
     * @param {number} [opts.maxItems=4096] - item-table capacity (files + filenames)
     * @param {number} [opts.worldScale=0.025] - the app-wide world scale the trie's
     *   advances are baked at (one metrics bag — grids share it)
     */
    constructor(renderer, atlas, opts = {}) {
        if (!renderer) throw new Error('GlyphPipelineArena: a WebGPU renderer is required');
        if (renderer.backend?.isWebGPUBackend !== true) {
            throw new Error('GlyphPipelineArena: the byte pipeline needs WebGPU compute — the WebGL2 fallback cannot run it (transform-feedback has no atomics/address-of)');
        }
        if (!atlas) throw new Error('GlyphPipelineArena: an atlas is required');
        this.renderer = renderer;
        this.atlas = atlas;
        this.worldScale = opts.worldScale ?? 0.025;
        this.maxBytes = Math.max(1024, opts.maxBytes ?? 1 * 1024 * 1024);
        this.maxItems = Math.max(16, opts.maxItems ?? 4096);

        this._trie = buildLiveTrie(atlas, this.worldScale);
        this._kernels = new GlyphPipelineKernels(renderer, {
            maxBytes: this.maxBytes, maxItems: this.maxItems, trie: this._trie,
        });

        /** Every staged item, live or dead. The index IS the itemIndex — never spliced. */
        this._items = [];
        this._byteTotal = 0;
        this._stagedSinceFlush = 0;
        this._flushPromise = null;       // the coalescing flush gate
        this._repaginatePromise = null;  // the coalescing repaginate gate
        this._missGen = 0;
        this._deviceLostNoted = false;
    }

    /** The kernels (a field attaches to their slot buffer). Rebuilt on growth/trie change. */
    get kernels() { return this._kernels; }

    /**
     * Append a file to the arena and return its handle. Synchronous: mirror + item-table
     * entry + field attach. The GPU sees it at the next flush.
     *
     * @param {Object} p
     * @param {Uint8Array} p.bytes - the file's UTF-8 bytes (non-empty)
     * @param {{x,y,z}} [p.origin] - world position of the file's origin (grid-local frame)
     * @param {Object} [p.page] - page params { pageRows, pageCols, pagesWide, pageGapX,
     *   bandStrideY, depthPerBand, depthPerColumn, scrollRows }. pageStrideX is MEASURED
     *   here (the mirror's widest row + pageGapX) — never passed in.
     * @param {number} [p.wrapWidth] - the fold unit (0 = no wrap)
     * @param {number} [p.lineHeight] - world y per row
     * @param {number} [p.zStep] - depth per wrap segment
     * @param {import('../GlyphField.js').default} [p.field] - the byte-mode field to attach
     * @returns {{itemIndex:number, byteStart:number, byteLength:number, mirror:Object,
     *   setPage:Function, verify:Function, dispose:Function}} the per-grid handle
     */
    stage({ bytes, origin, page: pageIn, wrapWidth = 0, lineHeight = 1, zStep = 0, field = null }) {
        if (!(bytes?.length > 0)) {
            throw new Error('GlyphPipelineArena.stage: empty file — an item owns at least one byte');
        }
        if (this._items.length >= this.maxItems) {
            this._realloc(this.maxBytes, this.maxItems * 2);
        }
        const need = this._byteTotal + bytes.length;
        if (need > this.maxBytes) {
            this._realloc(Math.max(this.maxBytes * 2, Math.ceil(need * 1.25)), this.maxItems);
        }

        // The mirror FIRST (serial — window 0: the race it simulates on the GPU doesn't
        // exist here): the walk's widest row is the page column stride, measured, never
        // nominal. It paginates with pageStrideX unset; the FINAL page re-paginates it in
        // place below (the remap is reconstructive — exact).
        const page0 = pageIn ? { ...pageIn } : null;
        const mirror = runPipeline(bytes, this._trie, {
            window: 0, wrapWidth, lineHeight, zStep, origin, page: page0,
        });
        const page = page0 ? { ...page0 } : {};
        if (page.pageRows > 0) {
            page.pageStrideX = (mirror.bounds?.maxRowExtent ?? 0) + (page.pageGapX || 0);
        }
        delete page.pageGapX;

        const item = {
            bytes, origin, page, wrapWidth, lineHeight, zStep, mirror, field,
            byteStart: this._byteTotal, byteCount: bytes.length, dead: false,
        };
        const itemIndex = this._items.length;
        this._items.push(item);
        this._byteTotal += bytes.length;
        this._stagedSinceFlush++;

        if (field) field.attachBytePipeline(this._kernels, bytes.length, item.byteStart);
        this._repaginateMirror(item, page);
        if (field) field.setLayoutExtent(extentOf(mirror));

        const arena = this;
        return {
            itemIndex,
            byteStart: item.byteStart,
            byteLength: item.byteCount,
            get mirror() { return item.mirror; },
            /**
             * Page/scroll retune — kernel 3 alone re-runs (batched via requestRepaginate).
             * NOT for pageCols/wrap changes (those change the walk — restage).
             */
            setPage(pageIn2) {
                const p = { ...pageIn2 };
                if (p.pageRows > 0 && p.pageStrideX == null) {
                    p.pageStrideX = (item.mirror?.bounds?.maxRowExtent ?? 0) + (p.pageGapX || 0);
                }
                delete p.pageGapX;
                item.page = p;
                arena._repaginateMirror(item, p);
                arena.setItemPage(itemIndex, p);
                if (item.field) item.field.setLayoutExtent(extentOf(item.mirror));
                return arena.requestRepaginate();
            },
            verify: (eps) => arena.verifyItem(itemIndex, eps),
            /** The item's arena space leaks (v1 — see the header); this detaches the field
             *  so a realloc never re-attaches a disposed grid's field. */
            dispose() { item.field = null; item.dead = true; },
        };
    }

    /**
     * The coalescing flush gate: every stage in the same macrotask window shares ONE
     * flush — one setFiles + one run (three dispatches) for the whole storm. Resolves
     * once the dispatches are ENCODED (encode-time is the load path's guarantee).
     * @returns {Promise<void>}
     */
    requestFlush() {
        if (!this._flushPromise) {
            this._flushPromise = new Promise((resolve) => {
                setTimeout(() => {
                    this._flushPromise = null;
                    this._flushNow();
                    resolve();
                }, 0);
            });
        }
        return this._flushPromise;
    }

    /**
     * One batched dispatch of EVERYTHING live (the buffer is one concatenated arena — a
     * flush is setFiles over all items + run). Fire-and-forget variant of requestFlush's
     * gate body.
     */
    _flushNow() {
        if (this._items.length === 0) return;
        if (this.renderer._isDeviceLost === true) {
            if (!this._deviceLostNoted) {
                this._deviceLostNoted = true;
                console.warn('GlyphPipelineArena: GPU device lost — pipeline dispatches suspended until reload');
            }
            return;
        }
        const t0 = performance.now();
        this._kernels.setFiles(this._items.map((it) => ({
            bytes: it.bytes, origin: it.origin, page: it.page,
            wrapWidth: it.wrapWidth, lineHeight: it.lineHeight, zStep: it.zStep,
        })), { window: 128 });
        this._kernels.run();
        const dt = performance.now() - t0;
        // The [load] trace's build-stage decomposition (fileCommands snapshots the deltas).
        loadStats.kernelDispatches += 3;
        loadStats.kernelMs += dt;
        loadStats.commits += this._stagedSinceFlush;
        loadStats.commitMs += dt;
        this._stagedSinceFlush = 0;

        // Miss flow, OFF the load path: the readback stalls on the GPU queue and the layout
        // is already correct (missing entries occupy their advance) — encode + re-run is a
        // background continuation. The generation guard drops it if a newer flush ran.
        const gen = ++this._missGen;
        Promise.resolve()
            .then(() => this._kernels.readMisses())
            .then((misses) => {
                if (gen !== this._missGen || !misses?.length) return;
                const res = encodeMisses(this.atlas, misses);
                if (!res?.grew || gen !== this._missGen) return;
                this._trie = buildLiveTrie(this.atlas, this.worldScale);
                this._realloc(this.maxBytes, this.maxItems);   // new trie → new kernels
                this._flushNow();
            })
            .catch(() => {});
    }

    /**
     * Retune ONE item's page params (the item-table write). The dispatch is separate:
     * requestRepaginate() — scroll ticks across grids coalesce into ONE kernel-3 run.
     */
    setItemPage(itemIndex, page) {
        this._kernels.setItemPage(itemIndex, page);
        return this;
    }

    /** The coalescing repaginate gate — one kernel-3 dispatch per macrotask window. */
    requestRepaginate() {
        if (!this._repaginatePromise) {
            this._repaginatePromise = new Promise((resolve) => {
                setTimeout(() => {
                    this._repaginatePromise = null;
                    if (this.renderer._isDeviceLost !== true) {
                        const t0 = performance.now();
                        this._kernels.repaginate();
                        loadStats.kernelDispatches += 1;
                        loadStats.kernelMs += performance.now() - t0;
                    }
                    resolve();
                }, 0);
            });
        }
        return this._repaginatePromise;
    }

    /**
     * GPU slots vs the item's mirror, per leader — the live-scene assertion behind
     * layout.verify. The GPU slice is the item's byteStart..byteStart+byteCount range of
     * the arena's slot buffer; the mirror is file-relative.
     */
    async verifyItem(itemIndex, eps = 1e-3) {
        const item = this._items[itemIndex];
        const ref = item?.mirror?.slots;
        if (!ref) return { ok: false, reason: 'no mirror' };
        const gpu = await this._kernels.readSlots();
        let worst = 0, badRows = 0;
        const STRIDE = 11;
        for (let id = 0; id < item.byteCount; id++) {
            const b = id * STRIDE;                    // mirror slot (file-relative)
            const g = (item.byteStart + id) * STRIDE; // arena slot
            if ((ref[b + 9] & 1) === 0) continue;
            if (gpu[g + 7] !== ref[b + 7] || gpu[g + 8] !== ref[b + 8]) badRows++;
            for (const l of [4, 5, 6, 10]) {
                const d = Math.abs(gpu[g + l] - ref[b + l]);
                if (d > worst) worst = d;
            }
        }
        return { ok: badRows === 0 && worst <= eps, worst, badRows };
    }

    /**
     * Rebuild the kernels at a new capacity (or around a rebuilt trie) and re-attach every
     * live field — the slots attribute is NEW, so fields holding the old one would read a
     * dead buffer. Content re-uploads at the next flush (setFiles covers all items).
     * @private
     */
    _realloc(maxBytes, maxItems) {
        this._kernels.dispose();
        this.maxBytes = Math.max(1024, Math.ceil(maxBytes));
        this.maxItems = Math.max(16, Math.ceil(maxItems));
        this._kernels = new GlyphPipelineKernels(this.renderer, {
            maxBytes: this.maxBytes, maxItems: this.maxItems, trie: this._trie,
        });
        for (const item of this._items) {
            if (item.field && !item.dead) {
                item.field.attachBytePipeline(this._kernels, item.byteCount, item.byteStart);
            }
        }
    }

    /**
     * Re-paginate the item's mirror IN PLACE with new page params and re-reduce its
     * bounds — the remap is reconstructive, so this is exact and needs no walk, no decode.
     * Keeps the mirror (the CPU oracle: extents, caret, verify) in the same page state as
     * the GPU. @private
     */
    _repaginateMirror(item, page) {
        const p = { ...page, wrap: item.wrapWidth, origin: item.origin,
            zStep: item.zStep, lineHeight: item.lineHeight };
        const { slots } = item.mirror;
        const n = item.byteCount;
        for (let id = 0; id < n; id++) refPaginate(slots, id, p);
        const box = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity, 0, 0]);
        for (let id = 0; id < n; id++) refBoundsReduce(slots, id, box);
        item.mirror.bounds = box[0] === Infinity ? null : {
            min: { x: box[0], y: box[1], z: box[2] },
            max: { x: box[3], y: box[4], z: box[5] },
            totalRows: box[6], maxRowExtent: box[7],
        };
    }

    dispose() {
        this._kernels?.dispose();
        this._kernels = null;
        this._items = [];
        this._byteTotal = 0;
    }
}

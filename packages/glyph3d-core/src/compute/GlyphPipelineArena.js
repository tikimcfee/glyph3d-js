/**
 * GlyphPipelineArena — ONE byte-in glyph pipeline for the WHOLE APP. The multi-file hoist,
 * wired in: where each grid used to build its own GlyphPipelineKernels (3 ComputeNode
 * codegens per grid, ~2.7ms × hundreds of grids per cold load), the arena owns ONE
 * kernels instance and every grid's file is an ITEM in its item table. A load storm is
 * stage() × N + ONE batched flush — one set of nine dispatches (decode, the five scan
 * stages, resolveX, strides, paginate) serves every grid.
 *
 * The flow:
 *
 *   stage({ bytes, origin, page, wrapWidth, lineHeight, zStep, field })
 *       synchronously appends the file's bytes to the arena, registers the item and
 *       attaches the field at the item's byteStart, and returns a thin per-grid HANDLE.
 *       NO dispatch here — and NO CPU layout: the GPU is the one layout engine, and a
 *       load storm pays zero per-byte CPU cost at stage time.
 *   requestFlush()
 *       coalesces every stage in the same macrotask window into ONE flush: setFiles(all
 *       live items) + run — nine dispatches for the whole storm. Resolves once ENCODED;
 *       ONE per-item bounds readback then lands every staged field's extent (handle.laid
 *       resolves as each item's extent arrives — the load path's "measures laid" gate).
 *   handle.setPage(page) / arena.setItemPage + requestRepaginate()
 *       the conveyor: strides + kernel 3 re-run. Scroll ticks across grids coalesce into
 *       one repaginate, and the extents refresh off the same coalesced readback.
 *
 * THE HANDLE is what a grid keeps as `_pipeline`: { itemIndex, byteStart, byteLength,
 * mirror, bounds, laid, setPage, verify, dispose } — the shape layout.verify
 * (verifyCommands) and the grid's extent/scroll paths read. `bounds` is the GPU's
 * per-item record (extent/rows/widest-row — the readback truth); `mirror` is the CPU
 * ORACLE, MATERIALIZED LAZILY on first touch (caret/edit/verify — interaction-rate, one
 * grid at a time), never on the load path: the reference pipeline runs once for the one
 * file being queried, not 450 times for a storm.
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
import { runPipeline, paginate as refPaginate, boundsReduce as refBoundsReduce, deriveStride, SLOT_STRIDE } from './glyphPipelineReference.js';
import { buildLiveTrie, encodeMisses } from './liveTrie.js';
import { loadStats } from '../core/loadStats.js';

/** A bounds record → the {min, max} shape GlyphField.setLayoutExtent states. */
function extentOf(b) {
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
        this._boundsGen = 0;
        this._syncedItems = 0;   // items already uploaded to the CURRENT kernels (append watermark)
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

        const item = {
            bytes, origin, page: pageIn ? { ...pageIn } : {},
            wrapWidth, lineHeight, zStep, field,
            mirror: null,      // the CPU oracle — materialized on first query, never here
            gpuBounds: null,   // the per-item readback record — lands after the flush
            byteStart: this._byteTotal, byteCount: bytes.length, dead: false,
        };
        item.laid = new Promise((resolve) => { item._laidResolve = resolve; });
        const itemIndex = this._items.length;
        this._items.push(item);
        this._byteTotal += bytes.length;
        this._stagedSinceFlush++;

        if (field) field.attachBytePipeline(this._kernels, bytes.length, item.byteStart);

        const arena = this;
        return {
            itemIndex,
            byteStart: item.byteStart,
            byteLength: item.byteCount,
            /** The CPU oracle, materialized ON TOUCH (caret/edit/verify — one file, once). */
            get mirror() { return arena._ensureMirror(item); },
            /** The GPU's per-item bounds record (extent/totalRows/maxRowExtent), or null
             *  until the post-flush readback lands. */
            get bounds() { return item.gpuBounds; },
            /** Resolves when this item's extent has landed from the GPU — the load path's
             *  "measures laid" gate. */
            get laid() { return item.laid; },
            /**
             * Page/scroll retune — strides + kernel 3 re-run (batched via
             * requestRepaginate; the extent refreshes off the same coalesced readback).
             * NOT for pageCols/wrap changes (those change the walk — restage).
             */
            setPage(pageIn2) {
                item.page = { ...pageIn2 };
                if (item.mirror) arena._repaginateMirror(item, item.page);
                arena.setItemPage(itemIndex, item.page);
                return arena.requestRepaginate();
            },
            verify: (eps) => arena.verifyItem(itemIndex, eps),
            /** The item's arena space leaks (v1 — see the header); this detaches the field
             *  so a realloc never re-attaches a disposed grid's field. */
            dispose() { item.field = null; item.dead = true; item._laidResolve?.(); },
        };
    }

    /**
     * Materialize the item's CPU oracle: the reference pipeline over THIS file alone, in
     * the item's current page state. Interaction-rate (first caret/edit/verify touch on a
     * grid), never load-rate — the whole point of the lazy split.
     * @private
     */
    _ensureMirror(item) {
        if (item.mirror) return item.mirror;
        const r = runPipeline(item.bytes, this._trie, {
            wrapWidth: item.wrapWidth, lineHeight: item.lineHeight,
            zStep: item.zStep, origin: item.origin, page: { ...item.page },
        });
        item.mirror = { slots: r.slots, bounds: r.itemBounds[0] };
        return item.mirror;
    }

    /**
     * The coalescing flush gate: every stage in the same macrotask window shares ONE
     * flush — one setFiles + one run (nine dispatches) for the whole storm. Resolves
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
        // INCREMENTAL: the arena is append-only, so a steady-state flush uploads ONLY the
        // items staged since the last sync (appendFiles — no whole-arena concat/repack, no
        // capacity-sized uploads: the per-interaction lockup at scale). The full setFiles
        // runs only when the kernels are FRESH (boot, realloc, trie rebuild).
        const toItem = (it) => ({
            bytes: it.bytes, origin: it.origin, page: it.page,
            wrapWidth: it.wrapWidth, lineHeight: it.lineHeight, zStep: it.zStep,
        });
        if (this._syncedItems === 0) {
            this._kernels.setFiles(this._items.map(toItem));
        } else if (this._items.length > this._syncedItems) {
            this._kernels.appendFiles(this._items.slice(this._syncedItems).map(toItem));
        }
        this._syncedItems = this._items.length;
        this._kernels.run();
        const dt = performance.now() - t0;
        // The [load] trace's build-stage decomposition (fileCommands snapshots the deltas).
        loadStats.kernelDispatches += 9;
        loadStats.kernelMs += dt;
        loadStats.commits += this._stagedSinceFlush;
        loadStats.commitMs += dt;
        this._stagedSinceFlush = 0;

        // Extents: ONE per-item bounds readback lands every staged field's cull box and
        // resolves handle.laid. "Just read from it" — one small readback per coalesced
        // flush is imperceptible; what was expensive was re-laying every file on the CPU.
        this._requestBoundsSync();

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

    /** The coalescing repaginate gate — one strides+paginate dispatch pair per macrotask
     *  window, with the extents refreshed off the same coalesced readback. */
    requestRepaginate() {
        if (!this._repaginatePromise) {
            this._repaginatePromise = new Promise((resolve) => {
                setTimeout(() => {
                    this._repaginatePromise = null;
                    if (this.renderer._isDeviceLost !== true) {
                        const t0 = performance.now();
                        this._kernels.repaginate();
                        loadStats.kernelDispatches += 2;
                        loadStats.kernelMs += performance.now() - t0;
                        this._requestBoundsSync();
                    }
                    resolve();
                }, 0);
            });
        }
        return this._repaginatePromise;
    }

    /**
     * The extent lane: read the per-item bounds table once and distribute — every live
     * field's cull box, every item's `bounds` record, every pending `laid` gate. A newer
     * sync supersedes an in-flight one (generation guard); a failed readback (device
     * loss, dispose) still resolves the gates so no load ever hangs on it.
     * @private
     */
    _requestBoundsSync() {
        const gen = ++this._boundsGen;
        const items = this._items;
        this._kernels.readItemBounds()
            .then((list) => {
                if (gen !== this._boundsGen) return;
                for (let i = 0; i < list.length && i < items.length; i++) {
                    const item = items[i];
                    item.gpuBounds = list[i];
                    if (!item.dead && item.field) item.field.setLayoutExtent(extentOf(list[i]));
                    item._laidResolve?.();
                }
            })
            .catch(() => {
                for (const item of items) item._laidResolve?.();
            });
    }

    /**
     * GPU slots vs the item's mirror, per leader — the live-scene assertion behind
     * layout.verify. The GPU slice is the item's byteStart..byteStart+byteCount range of
     * the arena's slot buffer; the mirror is file-relative.
     */
    async verifyItem(itemIndex, eps = 1e-3) {
        // Verify asserts the LIVE scene — let any coalesced flush/repaginate land first,
        // so the readback and the item table describe the same state.
        if (this._flushPromise) await this._flushPromise;
        if (this._repaginatePromise) await this._repaginatePromise;
        const item = this._items[itemIndex];
        if (!item) return { ok: false, reason: 'no item' };
        const ref = this._ensureMirror(item)?.slots;
        if (!ref) return { ok: false, reason: 'no mirror' };
        const gpu = await this._kernels.readSlots();
        let worst = 0, badRows = 0, badPos = 0;
        const STRIDE = SLOT_STRIDE;
        for (let id = 0; id < item.byteCount; id++) {
            const b = id * STRIDE;                    // mirror slot (file-relative)
            const g = (item.byteStart + id) * STRIDE; // arena slot
            if ((ref[b + 9] & 1) === 0) continue;
            if (gpu[g + 7] !== ref[b + 7] || gpu[g + 8] !== ref[b + 8]) badRows++;
            for (const l of [4, 5, 6, 10]) {
                // Magnitude-scaled: a foldless line prefix is an f32 sum whose valid
                // groupings differ by ~|x|·5e-5 — absolute eps at world scale would
                // flag legitimate f32 grouping on any long line.
                const d = Math.abs(gpu[g + l] - ref[b + l]);
                if (d > worst) worst = d;
                if (d > eps + Math.abs(ref[b + l]) * 5e-5) badPos++;
            }
        }
        return { ok: badRows === 0 && badPos === 0, worst, badRows, badPos };
    }

    /**
     * Rebuild the kernels at a new capacity (or around a rebuilt trie) and re-attach every
     * live field — the slots attribute is NEW, so fields holding the old one would read a
     * dead buffer. Content re-uploads at the next flush (setFiles covers all items).
     * @private
     */
    _realloc(maxBytes, maxItems) {
        // The header's "rare and loud" promise, delivered: every realloc names itself, so
        // a realloc-adjacent GPU symptom (destroyed-buffer submit, VRAM step) has a
        // timestamped cause in the relay log store.
        console.info(`GlyphPipelineArena: realloc ${this.maxBytes}B/${this.maxItems} items → `
            + `${Math.max(1024, Math.ceil(maxBytes))}B/${Math.max(16, Math.ceil(maxItems))} items `
            + `(${this._items.length} staged, ${this._byteTotal}B live)`);
        this._kernels.dispose();
        this.maxBytes = Math.max(1024, Math.ceil(maxBytes));
        this.maxItems = Math.max(16, Math.ceil(maxItems));
        this._kernels = new GlyphPipelineKernels(this.renderer, {
            maxBytes: this.maxBytes, maxItems: this.maxItems, trie: this._trie,
        });
        this._syncedItems = 0;   // fresh kernels — the next flush is a full setFiles
        for (const item of this._items) {
            if (item.field && !item.dead) {
                item.field.attachBytePipeline(this._kernels, item.byteCount, item.byteStart);
            }
        }
    }

    /**
     * Re-paginate a MATERIALIZED mirror IN PLACE with new page params (derived stride —
     * the same formula the GPU's stride kernel runs) and re-reduce its box. The walk
     * scalars (totalRows/maxRowExtent) persist — a repaginate never re-walks. Keeps the
     * oracle in the same page state as the GPU for caret/verify. @private
     */
    _repaginateMirror(item, page) {
        const m = item.mirror;
        if (!m) return;
        const p = { ...page, pageStrideX: deriveStride(m.bounds, page),
            wrap: item.wrapWidth, origin: item.origin,
            zStep: item.zStep, lineHeight: item.lineHeight };
        const { slots } = m;
        const n = item.byteCount;
        for (let id = 0; id < n; id++) refPaginate(slots, id, p);
        const box = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity,
            m.bounds?.totalRows || 0, m.bounds?.maxRowExtent || 0]);
        for (let id = 0; id < n; id++) refBoundsReduce(slots, id, box);
        m.bounds = box[0] === Infinity ? null : {
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

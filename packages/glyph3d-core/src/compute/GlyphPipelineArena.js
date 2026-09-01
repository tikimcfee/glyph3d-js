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
 *       synchronously allocates the file's byte range (best-fit from the free-list of
 *       reclaimed ranges, else the high-water mark), registers the item and attaches
 *       the field at the item's byteStart, and returns a thin per-grid HANDLE.
 *       NO dispatch here — and NO CPU layout: the GPU is the one layout engine, and a
 *       load storm pays zero per-byte CPU cost at stage time.
 *   requestFlush()
 *       coalesces every stage in the same macrotask window into ONE flush: the item
 *       table re-syncs to the live set (setItems), the newly staged ranges upload
 *       (writeBytes), one run — nine dispatches for the whole storm. Resolves once
 *       ENCODED; ONE per-item bounds readback then lands every staged field's extent
 *       (handle.laid resolves as each item's extent arrives — the load path's
 *       "measures laid" gate).
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
 * COMPACTION (the free-list): a disposed/restaged item's byte range is RECLAIMED —
 * `_reclaim` returns it to a coalescing free-list, stage() satisfies new items
 * best-fit from dead space before extending the high-water mark, and a freed TAIL
 * recedes the mark outright. An item's byteStart never moves once staged (slot ==
 * byte-address identity holds; no view ever re-points outside the adopt path), so
 * reuse needs no GPU moves and no view invalidation — the kernels simply treat the
 * table as explicit [byteStart, byteStart+byteCount) ranges sorted by byteStart, with
 * dead gaps inert. The arena grows with LIVE bytes, not with churn: a restage storm
 * (window crossings, edits) holds the watermark at ~2× the churned range instead of
 * burning the arena's byte budget on tombstones.
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

import GlyphPipelineKernels, { ARENA_MAX_BYTES } from './glyphPipelineKernels.js';

/** The arena's byte ceiling — the SAME constant the kernels assert, imported rather
 *  than re-stated, because two copies of a limit is how they drift apart.
 *
 *  This is ARENA_MAX_BYTES (what can be BUILT), not KERNEL_MAX_BYTES (what a u32 slot
 *  index can ADDRESS). The two are not the same number and conflating them cost us a
 *  release's worth of fiction: the slot buffer is mirrored on the host, so the index
 *  wall's 341MB of source would need ~16GB of process memory. The buildable ceiling is
 *  the requested storage-buffer binding cap over the 48B a source byte costs.
 *
 *  The u32 lane migration is what made ANY raise legal — count lanes rode f32 slots and
 *  were exact only to 2^24, so a larger arena aliased ordinals silently. That failure
 *  mode is gone, and the vertex path now indexes in u32 (glyphVertex.js) rather than
 *  i32, so it addresses everything the arena can hold.
 *
 *  The per-ITEM bound in stage() is a DIFFERENT rule and still applies — see there. */
const ORDINAL_EXACT_BYTES = ARENA_MAX_BYTES;
import { runPipeline, paginate as refPaginate, boundsReduce as refBoundsReduce, deriveStride,
    mBase, eBase, M_X, M_Y, M_Z, M_BASE_X, E_ROW, E_COL, E_FLAGS, F_LEADER} from './glyphPipelineReference.js';
import { buildLiveTrie, encodeMisses } from './liveTrie.js';
import { loadStats } from '../core/loadStats.js';

/** A bounds record → the {min, max} shape GlyphField.setLayoutExtent states. */
function extentOf(b) {
    return b ? { min: b.min, max: b.max } : null;
}

/** An arena item → the kernels' item shape (explicit byte range + per-item params). */
function toKernelItem(it) {
    return {
        bytes: it.bytes, byteStart: it.byteStart, origin: it.origin, page: it.page,
        wrapWidth: it.wrapWidth, lineHeight: it.lineHeight, zStep: it.zStep,
    };
}

export default class GlyphPipelineArena {
    /**
     * @param {import('three/webgpu').WebGPURenderer} renderer - the app's compute renderer
     * @param {Object} atlas - the booted GlyphAtlas (the trie's source)
     * @param {Object} [opts]
     * @param {number} [opts.maxBytes=1M] - arena byte capacity (one slot per byte). Mind the
     *   multiplier: a slot is 12 u32 = 48B (SLOT_BYTES_PER_SOURCE_BYTE), so 1M bytes of source ≈ 48MB of GPU
     *   buffer AND the same again mirrored on the host. A
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
        // The shape-cache size the CURRENT trie was built from — the staleness ruler
        // for the miss continuation (a trie is stale the moment shaping adds an entry,
        // whether or not the Slug atlas grew).
        this._trieCacheSize = atlas?._shapeCache?.size ?? 0;
        this._kernels = new GlyphPipelineKernels(renderer, {
            maxBytes: this.maxBytes, maxItems: this.maxItems, trie: this._trie,
        });


        /** Every staged item, live or dead. The index IS the itemIndex — never spliced. */
        this._items = [];
        /** The HIGH-WATER mark: one past the highest byte ever allocated, minus tail
         *  recedes. Free-list reuse keeps it tracking LIVE bytes, not cumulative churn. */
        this._byteTotal = 0;
        /** Dead byte ranges available for reuse — sorted by start, coalesced,
         *  non-overlapping. [{start, length}] */
        this._free = [];
        this._liveCount = 0;
        /** The kernels' item table mirrors `_sorted` (live items by byteStart) — rebuilt
         *  whenever membership changed since the last sync (stage/dispose sets this). */
        this._sorted = [];
        this._tableDirty = false;
        this._stagedSinceFlush = 0;
        this._flushPromise = null;       // the coalescing flush gate
        this._repaginatePromise = null;  // the coalescing repaginate gate
        this._missGen = 0;
        this._boundsGen = 0;
        this._deviceLostNoted = false;
    }

    /** The kernels (a field attaches to their slot buffer). Rebuilt on growth/trie change. */
    get kernels() { return this._kernels; }

    /** The high-water mark — one past the highest allocated byte. Pre-sizing adds
     *  an announced load's total on top of this, never on top of maxBytes. */
    get byteWatermark() { return this._byteTotal; }

    /**
     * PRE-SIZE the arena for a load whose total bytes are KNOWN (the bake index
     * carries per-file byteLength — a baked openDir can announce the storm before
     * staging a byte). One realloc while cheap — ideally while the arena is small —
     * instead of a doubling ladder mid-storm: each mid-storm realloc is a whole-world
     * event (9 kernel re-codegens, full re-upload, every capacity-sized render lane
     * reallocated + re-uploaded, every live view re-attached) that lands as a
     * multi-second main-thread block at the 8→16M steps. Clamped to the arena ceiling;
     * refusing more than the ceiling is not this method's job (stage() already fails
     * loud per item).
     *
     * The clamp is a CLAMP, not a guarantee the realloc succeeds: the ceiling is the
     * largest arena that can exist, not one this host has room for right now (the slot
     * buffer is mirrored host-side at 48B/byte). A pre-size that cannot be built throws
     * from the kernels naming the request; the call site treats that as advisory and
     * lets the growth ladder proceed, which is why this is `info` and not a hard gate.
     * @param {number} bytes - expected TOTAL live bytes (content + slack headroom)
     * @returns {boolean} whether a realloc happened
     */
    ensureCapacity(bytes) {
        const want = Math.min(ORDINAL_EXACT_BYTES, Math.ceil(Math.max(0, bytes)));
        if (want <= this.maxBytes) return false;
        console.info(`GlyphPipelineArena: pre-sizing ${this.maxBytes}B → ${want}B ahead of an announced load (${this._items.length} items staged)`);
        this._realloc(want, this.maxItems);
        return true;
    }

    /** The live trie (codepoint → glyph metrics) — the same advances every dispatch
     *  resolves through. Windowed staging's CPU queries (byteRangeForRows) fold with
     *  it so a window's seed is exact against what the GPU will compute. */
    get trie() { return this._trie; }

    /**
     * Stage a file into the arena and return its handle. Synchronous: range allocation
     * (free-list reuse or high-water growth) + item-table entry + field attach. The
     * GPU sees it at the next flush.
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
     * @param {import('../GlyphField.js').default} [p.field] - the byte-mode field to
     *   attach EAGERLY (first loads: nothing is rendering yet, attach-at-stage is
     *   free). RESTAGES pass null and call handle.adoptField(field) after `laid` —
     *   the two-phase, flash-free swap: the field keeps rendering its old item until
     *   the new slots are valid. A null field is a first-class item state the arena
     *   already honors everywhere (bounds sync, realloc re-attach, dispose)
     * @returns {{itemIndex:number, byteStart:number, byteLength:number, mirror:Object,
     *   setPage:Function, verify:Function, dispose:Function}} the per-grid handle
     */
    stage({ bytes, origin, page: pageIn, wrapWidth = 0, lineHeight = 1, zStep = 0, field = null, capacity = 0, leaders = 0 }) {
        if (!(bytes?.length > 0)) {
            throw new Error('GlyphPipelineArena.stage: empty file — an item owns at least one byte');
        }
        // PER-ITEM ORDINAL BOUND — the invariant the arena's global cap only proxies.
        //
        // The count lanes (S_ORD, S_ROW, S_COL) are ITEM-RELATIVE: the fold resets
        // ord/row/col to 0 at every item start, so any bound on them is bounded by the
        // largest single ITEM, never by the arena total. They ride u32 lanes now, so the
        // old f32 aliasing (two glyphs folding onto one ordinal past 2^24 while
        // addressing stayed exact — nothing broken-looking, just quietly wrong) is gone.
        // The bound is kept as a deliberate assertion of that invariant.
        //
        // Until now this rule held only by routing: READABLE_MAX_CHARS (1M chars)
        // caps files in the LOAD path, and nothing else. Asserted here it is true
        // for every producer, including the ones that never pass that way.
        //
        // LEADERS is the real bound and callers with a bake record pass it — the
        // bake already counted them (glyphBake's `leaders`), so it costs nothing.
        // The byte-count fallback is deliberately CONSERVATIVE (leaders <= bytes,
        // always): it exists for SYNTHETIC sources — terminal grids, generated
        // content, anything calling stage() directly — which own no bake record and
        // are exactly the producers the load-path cap never covered. A multi-byte
        // corpus (CJK, emoji) can therefore trip the fallback while being genuinely
        // safe; that is the trade, and the fix is to pass `leaders`, not to widen
        // the bound.
        // (The byte-length bound that stood here is GONE. It existed because I_BYTE_COUNT
        // rode the f32 item table and aliased past 2^24, folding a large item's tail into
        // the next item. The item table is u32 now — exact lanes native, measures bitcast
        // — so the count is exact across the whole arena and the bound has no cause left.
        // A bound that outlives its cause is the same defect as a deviation that outlives
        // its debt, and this repo fails a check for that one.)

        const ordinalUnits = leaders > 0 ? leaders : bytes.length;
        if (ordinalUnits > ORDINAL_EXACT_BYTES) {
            throw new Error(
                `GlyphPipelineArena.stage: one item claims ${ordinalUnits.toLocaleString()} ` +
                `${leaders > 0 ? 'glyphs' : 'bytes (conservative: no leader count supplied)'} — ` +
                `past the arena ceiling (${ORDINAL_EXACT_BYTES.toLocaleString()}). ` +
                'Count lanes are item-relative, so an item is bounded on its own — ' +
                'and no item can exceed the arena that holds it',
            );
        }
        // EDIT SLACK: capacity > length stages the item with a 0x80 pad (bare
        // continuation bytes — structural non-leaders every pass skips). Edits that
        // fit the capacity then REWRITE in place (handle.rewrite): zero arena growth
        // per keystroke, instead of a whole-item restage into the append-only arena.
        const cap = Math.max(bytes.length, Math.trunc(capacity) || 0);
        if (cap > bytes.length) {
            const padded = new Uint8Array(cap);
            padded.set(bytes);
            padded.fill(0x80, bytes.length);
            bytes = padded;
        }
        if (this._liveCount >= this.maxItems) {
            this._realloc(this.maxBytes, this.maxItems * 2);
        }
        // COMPACTION: dead space first — best-fit from the free-list, the high-water
        // mark only when nothing fits. The two-phase adopt keeps the OLD item live
        // while its replacement stages, so a restage can never scribble on a range a
        // view is still rendering (the free-list only ever holds disposed items).
        const byteStart = this._alloc(bytes.length);
        const end = byteStart + bytes.length;
        if (end > ORDINAL_EXACT_BYTES) {
            // The buildable ceiling (ARENA_MAX_BYTES). Count lanes are u32 now, so this
            // is no longer an exactness limit — it is memory: the slot buffer costs 48B
            // per source byte on the host AND on the device, and the requested binding
            // cap divided by that is where the arena stops.
            // Undo the allocation (a refusal must not leak the range) and refuse THIS
            // stage loudly (the load path logs it per grid, the rest of the storm
            // continues) instead of attempting a growth the kernels must reject.
            // The free-list keeps the live-byte watermark under the ceiling meanwhile.
            this._insertFree(byteStart, bytes.length);
            const live = this._byteTotal - this._free.reduce((s, r) => s + r.length, 0);
            throw new Error(`GlyphPipelineArena: staging ${bytes.length}B needs address ${end}B, past the arena ceiling (${ORDINAL_EXACT_BYTES}B) with ${live}B live — this file stays unlaid`);
        }
        if (end > this.maxBytes) {
            // _alloc has ALREADY consumed this range. If growth throws (device OOM,
            // a limit refusal, the kernels' own ceiling) the exception must not carry
            // the range away with it — an unowned range poisons the watermark
            // permanently and every later stage re-enters the same failure. Give it
            // back, then rethrow: the caller's per-grid refusal path stays recoverable.
            try {
                this._realloc(Math.min(ORDINAL_EXACT_BYTES, Math.max(this.maxBytes * 2, Math.ceil(end * 1.25))), this.maxItems);
            } catch (err) {
                this._insertFree(byteStart, bytes.length);
                throw err;
            }
        }

        const item = {
            bytes, origin, page: pageIn ? { ...pageIn } : {},
            wrapWidth, lineHeight, zStep, field,
            mirror: null,      // the CPU oracle — materialized on first query, never here
            gpuBounds: null,   // the per-item readback record — lands after the flush
            byteStart, byteCount: bytes.length, dead: false,
            _synced: false,    // bytes not yet uploaded to the CURRENT kernels
            _row: undefined,   // row in the kernels' CURRENT item table — set at _syncTable
        };
        item.laid = new Promise((resolve) => { item._laidResolve = resolve; });
        const itemIndex = this._items.length;
        this._items.push(item);
        this._liveCount++;
        this._tableDirty = true;
        this._stagedSinceFlush++;

        if (field) field.attachBytePipeline(this._kernels, bytes.length, item.byteStart);

        const arena = this;
        return {
            itemIndex,
            byteStart: item.byteStart,
            byteLength: item.byteCount,
            /** The item's staged range — content + edit slack. rewrite() fits in it. */
            get capacity() { return item.byteCount; },
            /**
             * REWRITE the item's bytes in place — the edit fast path (terminal-style:
             * write, don't restage). No new item, no attach, no arena growth; the
             * coalesced flush re-folds and the same slots repaint (paint lanes were
             * never touched — colors stay put). Throws loud past capacity: that edit
             * takes the restage path with fresh slack.
             * @param {Uint8Array} bytes2 - new content, ≤ capacity
             * @param {Object} [page] - refreshed page params (scroll etc.)
             * @returns {Promise<void>} the coalesced flush
             */
            rewrite(bytes2, page) {
                if (item.dead) return Promise.resolve();
                if (bytes2.length > item.byteCount) {
                    throw new Error(`GlyphPipelineArena.rewrite: ${bytes2.length}B exceeds the item's ${item.byteCount}B capacity — restage with fresh slack`);
                }
                const padded = new Uint8Array(item.byteCount);
                padded.set(bytes2);
                padded.fill(0x80, bytes2.length);
                item.bytes = padded;             // a later realloc re-uploads the EDITED content
                item.mirror = null;              // the oracle re-materializes on next touch
                if (page) {
                    item.page = { ...page };
                    arena.setItemPage(itemIndex, item.page);
                }
                arena._kernels.rewriteItemBytes(item.byteStart, bytes2, item.byteCount);
                return arena.requestFlush();
            },
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
            /**
             * Late field attach — the FLASH-FREE swap. A restage stages with
             * `field: null` (the view keeps rendering its OLD item), awaits `laid`,
             * then adopts: ONE attach re-points the view — tombstoning the old
             * range — in the same beat the new slots are valid, so no frame renders
             * an attached-but-unlaid range. Also delivers the extent the bounds
             * sync skipped while the field was null, and registers the item for
             * future realloc re-attaches (item.field).
             */
            adoptField(field2, sourceBase = 0) {
                if (!field2) return;
                // A grid closed while its fold awaited `laid` disposed this item —
                // legitimate lifecycle, not a seam failure: silent no-op.
                if (item.dead) return;
                if (item.field === field2) return;   // idempotent: already adopted
                item.field = field2;
                // sourceBase (the range's first FILE byte) re-points atomically with
                // the range; the view carries its paint lanes across by the overlap.
                field2.attachBytePipeline(arena._kernels, item.byteCount, item.byteStart, sourceBase);
                if (item.gpuBounds && typeof field2.setLayoutExtent === 'function') {
                    field2.setLayoutExtent(extentOf(item.gpuBounds));
                }
            },
            verify: (eps) => arena.verifyItem(itemIndex, eps),
            /** Tombstones the item: detaches the field (a realloc never re-attaches a
             *  disposed grid's field) and RECLAIMS the byte range into the free-list —
             *  the next stage of a fitting size reuses it. Idempotent. */
            dispose() {
                if (item.dead) return;
                item.field = null;
                item.dead = true;
                item._laidResolve?.();
                arena._reclaim(item);
            },
        };
    }

    /**
     * Allocate `n` bytes: best-fit from the free-list (the smallest dead range that
     * holds them — exact fits split least), else extend the high-water mark. The
     * returned range never overlaps a live item by construction.
     * @private
     */
    _alloc(n) {
        let best = -1;
        for (let i = 0; i < this._free.length; i++) {
            const r = this._free[i];
            if (r.length < n) continue;
            if (best < 0 || r.length < this._free[best].length) best = i;
        }
        if (best >= 0) {
            const r = this._free[best];
            const start = r.start;
            if (r.length === n) this._free.splice(best, 1);
            else { r.start += n; r.length -= n; }
            return start;
        }
        const start = this._byteTotal;
        this._byteTotal += n;
        return start;
    }

    /**
     * Return a range to the free-list, coalescing with adjacent dead ranges; a freed
     * TAIL recedes the high-water mark outright (the mark is what the arena-ceiling
     * wall and the growth checks read). @private
     */
    _insertFree(start, length) {
        const f = this._free;
        let end = start + length;
        let i = 0;
        while (i < f.length && f[i].start + f[i].length < start) i++;
        // Merge every range TOUCHING [start, end): adjacency coalesces, a strict
        // overlap is a double-free and refuses loud (the free-list invariant broken).
        while (i < f.length && f[i].start <= end) {
            const r = f[i];
            if (r.start < end && r.start + r.length > start) {
                throw new Error(`GlyphPipelineArena: double-free/overlap at [${start},${end}) vs [${r.start},${r.start + r.length}) — the free-list invariant is broken`);
            }
            if (r.start < start) start = r.start;
            if (r.start + r.length > end) end = r.start + r.length;
            f.splice(i, 1);
        }
        f.splice(i, 0, { start, length: end - start });
        // Tail recede: the last range ending exactly at the mark drops the mark to its
        // start. One check suffices — anything contiguous with it coalesced above.
        const last = f[f.length - 1];
        if (last && last.start + last.length === this._byteTotal) {
            this._byteTotal = last.start;
            f.pop();
        }
    }

    /** Reclaim a disposed item's byte range. @private */
    _reclaim(item) {
        this._liveCount--;
        this._insertFree(item.byteStart, item.byteCount);
        this._tableDirty = true;
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
     * flush — the table re-syncs to the live set, new ranges upload, one run (nine
     * dispatches) for the whole storm. Resolves
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
     * One batched dispatch of EVERYTHING live (the buffer is one byte arena of explicit
     * item ranges — a flush syncs the table to the live set, uploads the newly staged
     * ranges, runs). Fire-and-forget variant of requestFlush's gate body.
     */
    _flushNow() {
        if (this._liveCount === 0) return;
        if (this.renderer._isDeviceLost === true) {
            if (!this._deviceLostNoted) {
                this._deviceLostNoted = true;
                console.warn('GlyphPipelineArena: GPU device lost — pipeline dispatches suspended until reload');
            }
            return;
        }
        const t0 = performance.now();
        // INCREMENTAL: only the TABLE syncs wholesale (membership permutes rows under
        // free-list reuse — maxItems floats, trivial) and only the items staged since
        // the last sync upload their BYTES (masked word writes at their explicit
        // offsets — no whole-arena concat/repack, no capacity-sized uploads: the
        // per-interaction lockup at scale). After a realloc every live item is
        // unsynced, so the fresh kernels get the full upload through the same path.
        if (this._tableDirty) this._syncTable();
        const pending = [];
        for (const item of this._sorted) {
            if (!item._synced) pending.push(item);
        }
        if (pending.length > 0) {
            this._kernels.writeBytes(pending.map(toKernelItem));
            for (const item of pending) item._synced = true;
        }
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
                encodeMisses(this.atlas, misses);
                // The trie goes stale on SHAPING, not on Slug growth: encodeMisses'
                // lookups add shape-cache entries (allocating slots + emoji cells)
                // regardless of whether the Slug atlas grew. The old `if (!res.grew)
                // return` had the stuck-forever race: a glyph already encoded (a
                // hydrated slug core, or a superseded continuation's own encode)
                // reports grew=false forever, so NOTHING ever re-armed the realloc —
                // the trie never learned the codepoint and the glyph stayed
                // F_MISSING (invisible) for the rest of the session. Rebuild +
                // realloc whenever the shape cache outgrew the trie it was built
                // from, growth or not.
                const cacheSize = this.atlas?._shapeCache?.size ?? 0;
                if (cacheSize === this._trieCacheSize) return;
                this._trieCacheSize = cacheSize;
                this._trie = buildLiveTrie(this.atlas, this.worldScale);
                this._realloc(this.maxBytes, this.maxItems);   // new trie → new kernels
                this._flushNow();
            })
            .catch(() => {});
    }

    /**
     * Repack the kernels' item table to the LIVE set, sorted by byteStart (the binary
     * search's invariant), and hand each item its CURRENT row. `_row` always describes
     * the GPU's table as it stands — membership changes only materialize here, so a
     * setItemPage between syncs writes a row that is still that item's own.
     * @private
     */
    _syncTable() {
        this._sorted = this._items.filter((it) => !it.dead)
            .sort((a, b) => a.byteStart - b.byteStart);
        this._kernels.setItems(this._sorted.map(toKernelItem));
        this._sorted.forEach((it, row) => { it._row = row; });
        this._tableDirty = false;
    }

    /**
     * Retune ONE item's page params (the item-table write). The dispatch is separate:
     * requestRepaginate() — scroll ticks across grids coalesce into ONE kernel-3 run.
     * An item with no row yet (staged since the last sync) skips the kernel write —
     * the next flush packs its CURRENT page from the item record.
     */
    setItemPage(itemIndex, page) {
        const item = this._items[itemIndex];
        if (item && item._row !== undefined) {
            this._kernels.setItemPage(item._row, page);
        }
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
        // The readback is parallel to the kernels' item table — `_sorted` mirrors it
        // exactly (both only change at _syncTable, which precedes every readback).
        const rows = this._sorted;
        this._kernels.readItemBounds()
            .then((list) => {
                if (gen !== this._boundsGen) return;
                for (let i = 0; i < list.length && i < rows.length; i++) {
                    const item = rows[i];
                    item.gpuBounds = list[i];
                    if (!item.dead && item.field) item.field.setLayoutExtent(extentOf(list[i]));
                    item._laidResolve?.();
                }
            })
            .catch(() => {
                for (const item of rows) item._laidResolve?.();
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
        // A disposed item's range is free-list space — recycled bytes would diff as a
        // layout error against the mirror, misdirecting the hunt. Say what it is.
        if (item.dead) return { ok: false, reason: 'item disposed (range reclaimed)' };
        const ref = this._ensureMirror(item)?.slots;
        if (!ref) return { ok: false, reason: 'no mirror' };
        const gpu = await this._kernels.readSlots();
        let worst = 0, badRows = 0, badPos = 0;
        for (let id = 0; id < item.byteCount; id++) {
            const bm = mBase(id), be = eBase(id);                       // mirror (file-relative)
            const gm = mBase(item.byteStart + id), ge = eBase(item.byteStart + id);  // arena
            // NAMED lanes, not literals. These were hardcoded 9 / 7,8 / [4,5,6,10] —
            // every one exactly +1 off, left behind when the codepoint lane was
            // dropped (13 -> 12 lanes), so this check spent that time reading BASE_X
            // as the leader flag. Constants cannot drift that way.
            if ((ref.x[be + E_FLAGS] & F_LEADER) === 0) continue;
            if (gpu.x[ge + E_ROW] !== ref.x[be + E_ROW] || gpu.x[ge + E_COL] !== ref.x[be + E_COL]) badRows++;
            for (const l of [M_X, M_Y, M_Z, M_BASE_X]) {
                // Both sides are f32 arrays now, so these ARE values — the decode step
                // that used to stand here (the epsilon was once being applied to bit
                // patterns) has nothing left to decode. The comparison is the same
                // comparison; what changed is that the carrier can no longer lie about it.
                const gv = gpu.m[gm + l], rv = ref.m[bm + l];
                // Magnitude-scaled: a foldless line prefix is an f32 sum whose valid
                // groupings differ by ~|x|·5e-5 — absolute eps at world scale would
                // flag legitimate f32 grouping on any long line.
                const d = Math.abs(gv - rv);
                if (d > worst) worst = d;
                if (d > eps + Math.abs(rv) * 5e-5) badPos++;
            }
        }
        return { ok: badRows === 0 && badPos === 0, worst, badRows, badPos };
    }

    /**
     * Rebuild the kernels at a new capacity (or around a rebuilt trie) and re-attach every
     * live field — the slots attribute is NEW, so fields holding the old one would read a
     * dead buffer. Byte ranges are untouched (an item's byteStart never moves), so every
     * attach is the same-range rebind; content re-uploads at the next flush (every live
     * item is marked unsynced — the full upload rides the incremental writeBytes path).
     * @private
     */
    _realloc(maxBytes, maxItems) {
        const nextBytes = Math.max(1024, Math.ceil(maxBytes));
        const nextItems = Math.max(16, Math.ceil(maxItems));
        // The header's "rare and loud" promise, delivered: every realloc names itself, so
        // a realloc-adjacent GPU symptom (destroyed-buffer submit, VRAM step) has a
        // timestamped cause in the relay log store.
        console.info(`GlyphPipelineArena: realloc ${this.maxBytes}B/${this.maxItems} items → `
            + `${nextBytes}B/${nextItems} items `
            + `(${this._liveCount} live/${this._items.length} staged, ${this._byteTotal}B watermark)`);
        // TRANSACTIONAL: build the replacement BEFORE destroying the live kernels. A
        // construction failure here (the addressable ceiling, device OOM) must leave the
        // arena exactly as it was — the first version disposed first, and a throw then
        // stranded a destroyed slots buffer in every bind group (a permanent
        // per-frame Dawn error storm) with maxBytes lying about real capacity.
        const fresh = new GlyphPipelineKernels(this.renderer, {
            maxBytes: nextBytes, maxItems: nextItems, trie: this._trie,
        });
        this._kernels.dispose();
        this._kernels = fresh;
        this.maxBytes = nextBytes;
        this.maxItems = nextItems;
        // Fresh kernels: the next flush re-syncs the table and re-uploads every live
        // item's bytes. Rows drop with the old table — a setItemPage before that flush
        // skips the kernel write (the flush packs the item's current page).
        this._tableDirty = true;
        for (const item of this._items) {
            item._synced = false;
            item._row = undefined;
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
        this._free = [];
        this._liveCount = 0;
        this._sorted = [];
        this._tableDirty = false;
    }
}

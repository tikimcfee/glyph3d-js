/**
 * glyphPipelineKernels — the byte-in glyph pipeline as WebGPU compute, in TSL.
 *
 * A transcription of `glyphPipelineReference.js`. That module is the spec and is proven
 * headlessly (tools/glyph-pipeline.test.mjs, tools/backtrack-layout.test.mjs); this is the
 * same logic addressed to the GPU. Keep them line-comparable — when they diverge, the
 * reference is right until a test says otherwise.
 *
 * THREE DISPATCHES PER LOAD, not per frame:
 *
 *   1. decodeAndResolve   bytes → codepoint → trie → glyphId/advance/height. Pure per-slot.
 *   2. layout             the backward walk. Reads slot 1's output for its predecessors.
 *   3. paginateAndBounds  pure per-slot page remap, with the bounds reduce fused on.
 *
 * Decode does NOT fuse into layout even though the walk could re-decode its predecessors:
 * re-decoding costs the decode plus two trie loads per step, against one load to read a
 * pre-decoded `advance` lane. At window 128 + wrap 200 that is ~328 re-decodes per thread —
 * strictly more memory traffic than the dispatch it would save.
 *
 * Pagination stays its own dispatch because that is what makes a mode switch cheap: changing
 * newspaper/column/z-page, or scrolling, re-runs ONLY kernel 3 over positions that already
 * exist. No decode, no walk, no reparse.
 *
 * ── MULTI-FILE (the item table) ──────────────────────────────────────────────────────────
 * One pipeline instance serves N files concatenated in ONE byte buffer: the multi-file
 * hoist — one set of dispatches for a whole load storm, not one per file. Per file (item):
 * a uint in itemStarts (its byteStart — the binary-search key) and ITEM_STRIDE floats in
 * itemTable (origin + the page params: pageRows, pageCols, pagesWide, pageStrideX,
 * bandStrideY, depthPerBand, depthPerColumn, scrollRows — the same packing pattern as
 * GlyphLayoutKernel's item table), plus the per-item fold metrics (wrap/zStep/lineHeight).
 * Only `window` — the GPU coherence dial — stays a field-level uniform.
 *
 *   1. The walk NEVER CROSSES A FILE BOUNDARY. Kernels 2/3 resolve their item by binary
 *      search over itemStarts; leaderBefore floors at the item's first byte, so row/col
 *      are FILE-RELATIVE (a file's first glyph is row 0, col 0) and no inherit can leak
 *      F_RENDERED across files.
 *   2. Kernel 3 applies the ITEM's origin + page params from the table; the reconstructive
 *      math is unchanged — base lanes + item origin/params.
 *   3. ORIGIN IS PER-ITEM, full stop — the field-level origin uniform is GONE (simpler
 *      than two origins: one adder, one source of truth). setFile() wraps its params into
 *      a single item, so the one-item case is byte-identical to before.
 *   4. WRAP/zStep/lineHeight ARE PER-ITEM LANES (I_WRAP_WIDTH/I_Z_STEP/I_LINE_HEIGHT),
 *      with the setFiles field-level params as defaults. One arena must serve grids that
 *      fold differently — a filename at wrap 0 beside content at wrap 200 — so the fold
 *      unit rides the item, not a uniform. Only `window` (the coherence dial) stays
 *      field-level. They are LOAD-TIME lanes: changing them changes the walk, so they are
 *      not setItemPage/repaginate-tunable.
 *   5. BOUNDS stay a GLOBAL fused reduce — one box for the whole batch (the whole-batch
 *      cull). Per-file scalars (totalRows, maxRowExtent, per-file boxes) come from the CPU
 *      mirror: runPipeline() already runs per file and returns `itemBounds`. Lanes 6/7 of
 *      the GPU bounds buffer are the batch-wide max, NOT a per-file answer.
 *      (Brief option (b): chosen to keep the kernel to one atomic set.)
 *
 * ── VERIFIED ON HARDWARE (tools/glyph-pipeline-check.mjs) ────────────────────────────────
 * GPU output diffs against runPipeline() from the reference on the same bytes, over torture /
 * 40k-single-line / real-file corpora at wrap 0/24/200, window 0/128, and page modes. The
 * walk expresses in TSL Loop/Break; row/col are bit-exact on every lane; x/y/z sit within
 * f32 accumulation noise; the coherence race has not surfaced at any window. Two design bugs
 * the first run caught and fixed: kernel 3 now remaps from the BASE position (S_BASE_X + the
 * integer lanes) so it is idempotent, and loop 2's bound is the fold unit (wrap, else
 * pageCols) so MAX_WALK_STEPS never operates on real inputs.
 */

import { TSL } from 'three/webgpu';
import {
    SLOT_STRIDE, S_CODEPOINT, S_GLYPH_ID, S_ADVANCE, S_HEIGHT,
    S_X, S_Y, S_Z, S_ROW, S_COL, S_FLAGS, S_BASE_X,
    F_LEADER, F_RENDERED, F_MISSING, NEWLINE,
    ITEM_STRIDE, I_ORIGIN_X, I_ORIGIN_Y, I_ORIGIN_Z,
    I_PAGE_ROWS, I_PAGE_COLS, I_PAGES_WIDE, I_PAGE_STRIDE_X,
    I_BAND_STRIDE_Y, I_DEPTH_PER_BAND, I_DEPTH_PER_COL, I_SCROLL_ROWS,
    I_WRAP_WIDTH, I_Z_STEP, I_LINE_HEIGHT,
} from './glyphPipelineReference.js';
import { BLOCK_SHIFT, BLOCK_MASK, ENTRY_STRIDE, LANE_GLYPH_ID, LANE_ADVANCE, LANE_HEIGHT, LANE_FLAGS, FLAG_MISSING } from './GlyphTrie.js';

const {
    Fn, If, Loop, Break, Return, uniform, instancedArray, instanceIndex,
    int, uint, float, atomicMin, atomicMax, atomicAdd, bitcast,
} = TSL;

/**
 * Walk-loop iteration cap. This is a SAFETY BOUND, not the algorithm's bound — an unbounded
 * loop in a compute shader that fails to converge is a device loss, not a wrong pixel. The
 * real bound is the inherit (loop 1) and wrapWidth (loop 2). A thread that somehow burns
 * this many steps produces a wrong position rather than hanging the device, which is the
 * correct failure mode: visibly wrong beats unrecoverable.
 */
export const MAX_WALK_STEPS = 4096;

/**
 * Binary-search iteration cap for the per-thread item resolution (same reasoning as
 * GlyphLayoutKernel: 32 halvings address 2^32 items; the cap exists because an unbounded
 * loop that fails to converge is a device loss). Break() exits as soon as the range
 * collapses.
 */
const BINARY_SEARCH_STEPS = 32;

/** Item capacity a pipeline is born with — files per load storm. Memory is trivial
 *  (ITEM_STRIDE floats + one uint per item), so the default is sized for the storm. */
export const DEFAULT_MAX_ITEMS = 1024;

/**
 * Bytes are packed 4-per-u32 because WGSL cannot index a u8 array. `byteAt` unpacks.
 * @param {Uint8Array} bytes
 * @returns {Uint32Array} ceil(n/4) words, little-endian within each word
 */
export function packBytes(bytes) {
    const words = new Uint32Array(Math.ceil(bytes.length / 4));
    for (let i = 0; i < bytes.length; i++) {
        words[i >> 2] |= bytes[i] << ((i & 3) * 8);
    }
    return words;
}

/**
 * f32 → an unsigned key whose INTEGER order matches float order, so atomicMin/Max on u32
 * gives a float min/max. WGSL has no atomic<f32> (Metal does, which is why the original
 * could CAS-loop on a float directly).
 *
 * Positive floats: flip the sign bit, so they sort above all negatives.
 * Negative floats: flip every bit, which both moves them below zero and reverses their
 * magnitude ordering — negatives sort descending in raw bits, ascending once inverted.
 */
const floatToOrderedKey = /*#__PURE__*/ Fn(([f]) => {
    const bits = bitcast(f, 'uint').toVar();
    return bits.bitAnd(uint(0x80000000)).equal(uint(0))
        .select(bits.bitOr(uint(0x80000000)), bits.bitNot());
});

/** Inverse of floatToOrderedKey — applied CPU-side after the readback. */
export function orderedKeyToFloat(key) {
    const u = key >>> 0;
    const bits = (u & 0x80000000) !== 0 ? (u & 0x7FFFFFFF) | 0 : (~u >>> 0);
    const buf = new ArrayBuffer(4);
    new Uint32Array(buf)[0] = (u & 0x80000000) !== 0 ? u ^ 0x80000000 : ~u >>> 0;
    return new Float32Array(buf)[0];
}

/**
 * The bounds cells, pre-armed so the first atomic always wins.
 * Layout: [minX, minY, minZ, maxX, maxY, maxZ, totalRows, maxRowExtent] as ordered keys.
 * Lanes 6/7 arm to the minimum key — any real value wins the max.
 */
export function armedBoundsKeys() {
    const a = new Uint32Array(8);
    a[0] = a[1] = a[2] = 0xFFFFFFFF;   // min lanes start at +inf's key
    a[3] = a[4] = a[5] = a[6] = a[7] = 0x00000000;   // max lanes start at -inf's key
    return a;
}

export default class GlyphPipelineKernels {
    /**
     * @param {import('three/webgpu').WebGPURenderer} renderer
     * @param {Object} opts
     * @param {number} opts.maxBytes - slot capacity (one slot per byte, summed over ALL items)
     * @param {{blockIndex:Uint32Array, blocks:Float32Array}} opts.trie
     * @param {number} [opts.maxMisses]
     * @param {number} [opts.maxItems] - item-table capacity (files per run)
     */
    constructor(renderer, { maxBytes, trie, maxMisses = 4096, maxItems = DEFAULT_MAX_ITEMS }) {
        if (!renderer) throw new Error('GlyphPipelineKernels: a WebGPU renderer is required');
        this.renderer = renderer;
        this.maxBytes = Math.max(1, maxBytes | 0);
        this.maxItems = Math.max(1, maxItems | 0);

        // ── Buffers ────────────────────────────────────────────────────────────────────
        this.byteWords = instancedArray(Math.ceil(this.maxBytes / 4), 'uint').setName('GlyphBytes');
        this.slots = instancedArray(this.maxBytes * SLOT_STRIDE, 'float').setName('GlyphSlots');
        this.trieIndex = instancedArray(trie.blockIndex.length, 'uint').setName('GlyphTrieIndex');
        this.trieBlocks = instancedArray(trie.blocks.length, 'float').setName('GlyphTrieBlocks');
        this.bounds = instancedArray(8, 'uint').setName('GlyphBounds').toAtomic();
        this.misses = instancedArray(maxMisses, 'uint').setName('GlyphMisses');
        this.missCount = instancedArray(1, 'uint').setName('GlyphMissCount').toAtomic();
        // The item table: per-item params that VARY across files (origin + page params +
        // the fold metrics wrap/zStep/lineHeight). itemStarts is the search key buffer.
        this.itemTable = instancedArray(this.maxItems * ITEM_STRIDE, 'float').setName('GlyphItemTable');
        this.itemStarts = instancedArray(this.maxItems, 'uint').setName('GlyphItemStarts');

        this.trieIndex.value.array.set(trie.blockIndex);
        this.trieBlocks.value.array.set(trie.blocks);
        this.trieIndex.value.needsUpdate = true;
        this.trieBlocks.value.needsUpdate = true;
        this.maxMisses = maxMisses;

        // ── Uniforms — FIELD-LEVEL only: the dispatch width, the item count, and the
        //    coherence window. Origin, every page param, AND wrap/zStep/lineHeight are
        //    per-item lanes (grids in one arena fold differently — the item table is the
        //    single source of truth).
        this._u = {
            byteLength:   uniform(0, 'uint'),
            itemCount:    uniform(1, 'uint'),
            window:       uniform(128, 'int'),
        };

        this._kDecode = this._buildDecode();
        this._kLayout = this._buildLayout();
        this._kPaginate = this._buildPaginateAndBounds();
    }

    /** byteAt(i) — unpack from the 4-per-word packing. */
    _byteAt(i) {
        const w = this.byteWords.element(i.shiftRight(uint(2)));
        return w.shiftRight(i.bitAnd(uint(3)).mul(uint(8))).bitAnd(uint(0xFF));
    }

    /** Sequence length of the byte at `i`: 1..4, or 0 for a continuation byte. */
    _sequenceLength(i) {
        const b = this._byteAt(i).toVar();
        const n = int(0).toVar();
        If(b.bitAnd(uint(0x80)).equal(uint(0)), () => { n.assign(int(1)); })
            .ElseIf(b.bitAnd(uint(0xE0)).equal(uint(0xC0)), () => { n.assign(int(2)); })
            .ElseIf(b.bitAnd(uint(0xF0)).equal(uint(0xE0)), () => { n.assign(int(3)); })
            .ElseIf(b.bitAnd(uint(0xF8)).equal(uint(0xF0)), () => { n.assign(int(4)); });
        return n;
    }

    /**
     * KERNEL 1 — thread per byte. Decode + trie resolve. No cross-thread dependency at all.
     * @private
     */
    _buildDecode() {
        const u = this._u;
        const slots = this.slots;
        return Fn(() => {
            const id = instanceIndex;
            If(id.greaterThanEqual(u.byteLength), () => { Return(); });

            const n = this._sequenceLength(id).toVar('n');
            If(n.equal(int(0)), () => { Return(); });   // continuation byte — stays a non-leader

            const b0 = this._byteAt(id).toVar('b0');
            const b1 = this._byteAt(id.add(uint(1))).toVar('b1');
            const b2 = this._byteAt(id.add(uint(2))).toVar('b2');
            const b3 = this._byteAt(id.add(uint(3))).toVar('b3');

            const cp = uint(0).toVar('cp');
            If(n.equal(int(1)), () => { cp.assign(b0); })
                .ElseIf(n.equal(int(2)), () => {
                    cp.assign(b0.bitAnd(uint(0x1F)).shiftLeft(uint(6)).bitOr(b1.bitAnd(uint(0x3F))));
                })
                .ElseIf(n.equal(int(3)), () => {
                    cp.assign(b0.bitAnd(uint(0x0F)).shiftLeft(uint(12))
                        .bitOr(b1.bitAnd(uint(0x3F)).shiftLeft(uint(6)))
                        .bitOr(b2.bitAnd(uint(0x3F))));
                })
                .Else(() => {
                    cp.assign(b0.bitAnd(uint(0x07)).shiftLeft(uint(18))
                        .bitOr(b1.bitAnd(uint(0x3F)).shiftLeft(uint(12)))
                        .bitOr(b2.bitAnd(uint(0x3F)).shiftLeft(uint(6)))
                        .bitOr(b3.bitAnd(uint(0x3F))));
                });

            // Trie: two dependent loads, no hashing.
            const block = this.trieIndex.element(cp.shiftRight(uint(BLOCK_SHIFT))).toVar('blk');
            const eo = block.shiftLeft(uint(BLOCK_SHIFT)).bitOr(cp.bitAnd(uint(BLOCK_MASK)))
                .mul(uint(ENTRY_STRIDE)).toVar('eo');
            const glyphId = this.trieBlocks.element(eo.add(uint(LANE_GLYPH_ID))).toVar('gid');
            const advance = this.trieBlocks.element(eo.add(uint(LANE_ADVANCE))).toVar('adv');
            const height = this.trieBlocks.element(eo.add(uint(LANE_HEIGHT))).toVar('hgt');
            const tflags = this.trieBlocks.element(eo.add(uint(LANE_FLAGS))).toVar('tf');

            const o = id.mul(uint(SLOT_STRIDE)).toVar('o');
            slots.element(o.add(uint(S_CODEPOINT))).assign(cp.toFloat());
            slots.element(o.add(uint(S_GLYPH_ID))).assign(glyphId);
            slots.element(o.add(uint(S_ADVANCE))).assign(advance);
            slots.element(o.add(uint(S_HEIGHT))).assign(height);

            const missing = tflags.greaterThan(float(0.5)).toVar('missing');
            slots.element(o.add(uint(S_FLAGS)))
                .assign(missing.select(float(F_LEADER | F_MISSING), float(F_LEADER)));

            // Report the codepoint so the CPU can encode it and grow the atlas. Bounded ring:
            // dropping an overflow miss costs a blank glyph this pass, not a wrong layout.
            If(missing, () => {
                const slot = atomicAdd(this.missCount.element(uint(0)), uint(1)).toVar('ms');
                If(slot.lessThan(uint(this.maxMisses)), () => {
                    this.misses.element(slot).assign(cp);
                });
            });
        })().compute(1).setName('glyphDecodeAndResolve');
    }

    /**
     * Item resolution: the largest item whose byteStart ≤ id — the reference's itemForByte,
     * as a TSL binary search over itemStarts. Shared by kernels 2 and 3 (kernel 1's decode
     * is item-agnostic).
     * @private
     * @returns {Function} TSL fn (id:uint) → uint item index
     */
    _buildItemSearch() {
        const u = this._u;
        const starts = this.itemStarts;
        return Fn(([id]) => {
            const lo = uint(0).toVar('ilo');
            const hi = u.itemCount.sub(uint(1)).toVar('ihi');
            Loop(BINARY_SEARCH_STEPS, () => {
                If(lo.greaterThanEqual(hi), () => { Break(); });
                const mid = lo.add(hi).add(uint(1)).div(uint(2)).toVar('imid');
                If(starts.element(mid).lessThanEqual(id), () => {
                    lo.assign(mid);
                }).Else(() => {
                    hi.assign(mid.sub(uint(1)));
                });
            });
            return lo;
        });
    }

    /**
     * Nearest leader strictly before `from`, or `from` when none AT OR ABOVE `floor`.
     * The floor is the item's first byte — the walk never crosses a file boundary, so a
     * file's first leader finds no predecessor and computes its own prefix. Bounded by
     * MAX_WALK_STEPS.
     */
    _leaderBefore(from, floor) {
        const j = from.toVar();
        const found = from.toVar();
        Loop(MAX_WALK_STEPS, () => {
            If(j.lessThanEqual(floor), () => { Break(); });
            j.assign(j.sub(uint(1)));
            const f = this.slots.element(j.mul(uint(SLOT_STRIDE)).add(uint(S_FLAGS)));
            If(int(f).bitAnd(int(F_LEADER)).notEqual(int(0)), () => {
                found.assign(j);
                Break();
            });
        });
        return found;
    }

    /**
     * KERNEL 2 — thread per byte. THE WALK. See the reference for the full argument; the
     * shape is two loops back to back inside ONE thread:
     *   loop 1  integer walk → row, col   (bounded by the inherit)
     *   loop 2  advance sum  → x          (bounded by wrapWidth)
     * @private
     */
    _buildLayout() {
        const u = this._u;
        const S = this.slots;
        const it = this.itemTable;
        const starts = this.itemStarts;
        const itemSearch = this._buildItemSearch();
        const lane = (slot, l) => S.element(slot.mul(uint(SLOT_STRIDE)).add(uint(l)));

        return Fn(() => {
            const id = instanceIndex;
            If(id.greaterThanEqual(u.byteLength), () => { Return(); });
            const myFlags = int(lane(id, S_FLAGS)).toVar('mf');
            If(myFlags.bitAnd(int(F_LEADER)).equal(int(0)), () => { Return(); });

            // ── Item resolution: this thread's file. The walk floors at the item's first
            //    byte and the origin + fold unit + metrics come from the item's table row.
            const item = itemSearch(id).toVar('item');
            const ib = item.mul(uint(ITEM_STRIDE)).toVar('ib');
            const itemStart = starts.element(item).toVar('itemStart');
            const originX = it.element(ib.add(uint(I_ORIGIN_X))).toVar('originX');
            const originY = it.element(ib.add(uint(I_ORIGIN_Y))).toVar('originY');
            const originZ = it.element(ib.add(uint(I_ORIGIN_Z))).toVar('originZ');
            const pageCols = int(it.element(ib.add(uint(I_PAGE_COLS)))).toVar('pageCols');
            const wrap = int(it.element(ib.add(uint(I_WRAP_WIDTH)))).toVar('wrap');
            const lineHeight = it.element(ib.add(uint(I_LINE_HEIGHT))).toVar('lineHeight');
            const zWrapStep = it.element(ib.add(uint(I_Z_STEP))).toVar('zWrapStep');
            const wrapping = wrap.greaterThan(int(0)).toVar('wrapping');

            // ── loop 1: exact integers ──────────────────────────────────────────────────
            const run = int(0).toVar('run');
            const col = int(-1).toVar('col');
            const row = int(0).toVar('row');
            const steps = int(0).toVar('steps');
            const prev = this._leaderBefore(id, itemStart).toVar('prev');

            Loop(MAX_WALK_STEPS, () => {
                If(prev.equal(id), () => { Break(); });
                const pFlags = int(lane(prev, S_FLAGS)).toVar('pf');
                const ready = pFlags.bitAnd(int(F_RENDERED)).notEqual(int(0))
                    .and(steps.greaterThan(u.window)).toVar('ready');
                const isNL = lane(prev, S_CODEPOINT).equal(float(NEWLINE)).toVar('isNL');

                If(isNL, () => {
                    // Close the open run: the first newline fixes MY column, later ones close
                    // whole lines above me and contribute their wrapped row counts.
                    If(col.lessThan(int(0)), () => { col.assign(run); })
                        .Else(() => {
                            row.addAssign(wrapping.select(run.div(wrap).add(int(1)), int(1)));
                        });
                    run.assign(int(0));
                    // Inheriting FROM a newline is its own case: its `col` is its LINE's length,
                    // not a position in the run just counted, and its row is the last visual row
                    // of the line it ends — so content after it starts exactly one row below.
                    If(ready, () => {
                        row.addAssign(int(lane(prev, S_ROW)).add(int(1)));
                        Break();
                    });
                }).Else(() => {
                    If(ready, () => {
                        const pCol = int(lane(prev, S_COL)).toVar('pCol');
                        const pWrapRow = wrapping.select(pCol.div(wrap), int(0)).toVar('pwr');
                        const pBase = int(lane(prev, S_ROW)).sub(pWrapRow).toVar('pBase');
                        If(col.lessThan(int(0)), () => {
                            col.assign(run.add(pCol).add(int(1)));
                        }).Else(() => {
                            const len = run.add(pCol).add(int(1)).toVar('len');
                            row.addAssign(wrapping.select(len.div(wrap).add(int(1)), int(1)));
                        });
                        row.addAssign(pBase);
                        Break();
                    });
                    run.addAssign(int(1));
                });

                steps.addAssign(int(1));
                const cur = prev.toVar('cur');
                prev.assign(this._leaderBefore(prev, itemStart));
                If(prev.equal(cur), () => {          // reached the item's first leader
                    If(col.lessThan(int(0)), () => { col.assign(run); })
                        .Else(() => {
                            row.addAssign(wrapping.select(run.div(wrap).add(int(1)), int(1)));
                        });
                    Break();
                });
            });
            If(col.lessThan(int(0)), () => { col.assign(run); });
            const wrapRow = wrapping.select(col.div(wrap), int(0)).toVar('wrapRow');
            row.addAssign(wrapRow);

            // ── loop 2: the advance sum, bounded by the fold unit ───────────────────────
            // Now col is known, so the fold unit is known to have started exactly
            // (col % fold) glyphs back. The fold unit is the wrap width when wrapping, else
            // the ITEM's pageCols when x-paginating: a within-page x only needs the
            // advances of the col % pageCols predecessors, and no newline can intervene.
            // Re-walking rather than inheriting a float is what makes x independent of
            // where the inherit landed. With neither wrap nor pageCols this walks to the
            // line start — the unbounded case MAX_WALK_STEPS fuses against (visibly wrong,
            // never a hang).
            const fold = wrapping.select(wrap, pageCols).toVar('fold');
            const backTo = fold.greaterThan(int(0)).select(col.mod(fold), col).toVar('backTo');
            const x = float(0).toVar('x');
            const k = int(0).toVar('k');
            const q = this._leaderBefore(id, itemStart).toVar('q');
            Loop(MAX_WALK_STEPS, () => {
                If(k.greaterThanEqual(backTo).or(q.equal(id)), () => { Break(); });
                If(lane(q, S_CODEPOINT).equal(float(NEWLINE)), () => { Break(); });
                x.addAssign(lane(q, S_ADVANCE));
                k.addAssign(int(1));
                const cur = q.toVar('qcur');
                q.assign(this._leaderBefore(q, itemStart));
                If(q.equal(cur), () => { Break(); });
            });

            const o = id.mul(uint(SLOT_STRIDE)).toVar('o');
            S.element(o.add(uint(S_X))).assign(x.add(originX));
            // The walk's x, frozen: paginate reads THIS lane, so its remap is a pure
            // function of the base position and re-running it accumulates nothing.
            S.element(o.add(uint(S_BASE_X))).assign(x.add(originX));
            S.element(o.add(uint(S_Y))).assign(row.toFloat().negate().mul(lineHeight).add(originY));
            // Wrapped segments step back in depth (the long-column z-fan); wrapRow is exact.
            S.element(o.add(uint(S_Z))).assign(originZ.sub(wrapRow.toFloat().mul(zWrapStep)));
            S.element(o.add(uint(S_ROW))).assign(row.toFloat());
            S.element(o.add(uint(S_COL))).assign(col.toFloat());
            // Position first, THEN publish. The inherit branch above reads F_RENDERED and then
            // reads x/y/row/col, so this write must not be reordered ahead of them. WGSL has no
            // release store; the coherence WINDOW is what makes the race practically safe, and
            // finding its value on real hardware is the whole point of the harness.
            S.element(o.add(uint(S_FLAGS))).assign(float(myFlags.bitOr(int(F_RENDERED))));
        })().compute(1).setName('glyphLayoutWalk');
    }

    /**
     * KERNEL 3 — thread per byte. Page remap on the EXACT integer lanes, with the bounds
     * reduce fused on: six atomics riding a pass that already touches every glyph, exactly
     * as blitGlyphsIntoConstants does. atomicMin/Max early-out in hardware, so contention
     * collapses after the box converges instead of every thread doing a CAS.
     * @private
     */
    _buildPaginateAndBounds() {
        const u = this._u;
        const S = this.slots;
        const it = this.itemTable;
        const itemSearch = this._buildItemSearch();
        const lane = (slot, l) => S.element(slot.mul(uint(SLOT_STRIDE)).add(uint(l)));

        return Fn(() => {
            const id = instanceIndex;
            If(id.greaterThanEqual(u.byteLength), () => { Return(); });
            If(int(lane(id, S_FLAGS)).bitAnd(int(F_LEADER)).equal(int(0)), () => { Return(); });

            // ── Item resolution: this thread's file — its origin + page params + fold
            //    metrics come from the item table (only the coherence window stays
            //    field-level).
            const item = itemSearch(id).toVar('item');
            const ib = item.mul(uint(ITEM_STRIDE)).toVar('ib');
            const originY = it.element(ib.add(uint(I_ORIGIN_Y))).toVar('originY');
            const originZ = it.element(ib.add(uint(I_ORIGIN_Z))).toVar('originZ');
            const pageRows = int(it.element(ib.add(uint(I_PAGE_ROWS)))).toVar('pageRows');
            const pageCols = int(it.element(ib.add(uint(I_PAGE_COLS)))).toVar('pageCols');
            const pagesWide = int(it.element(ib.add(uint(I_PAGES_WIDE)))).toVar('pagesWide');
            const pageStrideX = it.element(ib.add(uint(I_PAGE_STRIDE_X))).toVar('pageStrideX');
            const bandStrideY = it.element(ib.add(uint(I_BAND_STRIDE_Y))).toVar('bandStrideY');
            const depthPerBand = it.element(ib.add(uint(I_DEPTH_PER_BAND))).toVar('depthPerBand');
            const depthPerCol = it.element(ib.add(uint(I_DEPTH_PER_COL))).toVar('depthPerCol');
            const scrollRows = int(it.element(ib.add(uint(I_SCROLL_ROWS)))).toVar('scrollRows');
            const wrapWidth = int(it.element(ib.add(uint(I_WRAP_WIDTH)))).toVar('wrapWidth');
            const lineHeight = it.element(ib.add(uint(I_LINE_HEIGHT))).toVar('lineHeight');
            const zWrapStep = it.element(ib.add(uint(I_Z_STEP))).toVar('zWrapStep');

            const o = id.mul(uint(SLOT_STRIDE)).toVar('o');
            const row = int(lane(id, S_ROW)).toVar('row');
            const col = int(lane(id, S_COL)).toVar('col');
            // The conveyor: scroll shifts content up; rows scrolled above the origin
            // (negative screenRow) stay in flow — the page gate leaves them untouched.
            const screenRow = row.sub(scrollRows).toVar('screenRow');
            // RECONSTRUCTIVE, never accumulative: x reads the walk's untouched base lane
            // (already within the fold unit — loop 2 was bounded by wrap or pageCols), and
            // y/z are rebuilt from the exact integer lanes (base y = origin.y −
            // screenRow×lineHeight, base z = origin.z − seg×zWrapStep). Re-running with new
            // params re-derives from base — there is no "re-paginate", the remap cannot
            // double-apply.
            const x = lane(id, S_BASE_X).toVar('x');

            // EVERY page decision reads the integer lanes. Keying this off the float position
            // put 119 glyphs on the wrong page in the reference's own tests, because f32
            // addition is not associative and a boundary row wobbles by a ULP.
            const yPage = int(0).toVar('yPage');
            If(pageRows.greaterThan(int(0)).and(screenRow.greaterThanEqual(pageRows)), () => {
                yPage.assign(screenRow.div(pageRows));
            });
            const xPage = int(0).toVar('xPage');
            If(pageCols.greaterThan(int(0)), () => {
                xPage.assign(col.div(pageCols));
            });
            const wide = pagesWide.max(int(1)).toVar('wide');
            const wrapping = wrapWidth.greaterThan(int(0)).toVar('wrapping');
            const seg = wrapping.select(col.div(wrapWidth), int(0)).toVar('seg');

            const xf = x.add(yPage.mod(wide).toFloat().mul(pageStrideX)).toVar('xf');
            const yf = originY.sub(screenRow.sub(yPage.mul(pageRows)).toFloat().mul(lineHeight))
                .sub(yPage.div(wide).toFloat().mul(bandStrideY)).toVar('yf');
            const zf = originZ.sub(seg.toFloat().mul(zWrapStep))
                .add(yPage.div(wide).toFloat().mul(depthPerBand))
                .add(xPage.toFloat().mul(depthPerCol)).toVar('zf');
            S.element(o.add(uint(S_X))).assign(xf);
            S.element(o.add(uint(S_Y))).assign(yf);
            S.element(o.add(uint(S_Z))).assign(zf);

            // ── bounds, fused (over the FINAL positions) ────────────────────────────────
            const w = lane(id, S_ADVANCE).toVar('w');
            const h = lane(id, S_HEIGHT).toVar('h');
            atomicMin(this.bounds.element(uint(0)), floatToOrderedKey(xf));
            atomicMin(this.bounds.element(uint(1)), floatToOrderedKey(yf));
            atomicMin(this.bounds.element(uint(2)), floatToOrderedKey(zf));
            atomicMax(this.bounds.element(uint(3)), floatToOrderedKey(xf.add(w)));
            atomicMax(this.bounds.element(uint(4)), floatToOrderedKey(yf.add(h)));
            atomicMax(this.bounds.element(uint(5)), floatToOrderedKey(zf));
            // The scroll/page scalars: total visual rows (scroll-independent — row is
            // pre-conveyor) and the widest fold-unit row (what a snug pageStrideX feeds).
            atomicMax(this.bounds.element(uint(6)), floatToOrderedKey(row.toFloat().add(1)));
            atomicMax(this.bounds.element(uint(7)), floatToOrderedKey(x));
        })().compute(1).setName('glyphPaginateAndBounds');
    }

    /**
     * Upload ONE file's bytes and arm the uniforms — the one-item case of setFiles().
     * Bytes + the item table are the ONLY per-load uploads.
     * @param {Uint8Array} bytes
     * @param {Object} params - window, wrapWidth, lineHeight, zStep, origin, page
     */
    setFile(bytes, params = {}) {
        const page = { ...(params.page || {}) };
        if (params.scrollRows != null) page.scrollRows = params.scrollRows;
        return this.setFiles([{ bytes, origin: params.origin, page }], params);
    }

    /**
     * Upload N files as ONE concatenated buffer with one item-table row each — the
     * multi-file hoist: one set of dispatches serves the whole load storm.
     *
     * @param {Array<{bytes:Uint8Array, origin?:{x,y,z}, page?:Object}>} items
     *   Each item's page bag takes pageRows, pageCols (also the walk's fold unit when wrap
     *   is off — changing it changes the walk's output), pagesWide, pageStrideX,
     *   bandStrideY, depthPerBand, depthPerColumn, scrollRows.
     * @param {Object} params - field-level DEFAULTS an item can override per item:
     *   window (the only true uniform), wrapWidth, lineHeight, zStep.
     */
    setFiles(items, params = {}) {
        if (!Array.isArray(items) || items.length === 0) {
            throw new Error('GlyphPipelineKernels: setFiles needs a non-empty items array');
        }
        if (items.length > this.maxItems) {
            throw new Error(`GlyphPipelineKernels: ${items.length} items exceeds capacity ${this.maxItems}`);
        }
        let total = 0;
        for (const it of items) total += it.bytes.length;
        if (total > this.maxBytes) {
            throw new Error(`GlyphPipelineKernels: ${total} bytes exceeds capacity ${this.maxBytes}`);
        }

        // Concatenate the bytes and pack the item table. byteStart goes in itemStarts (the
        // search key); origin + page params + the fold metrics go in itemTable at the
        // ITEM_STRIDE lanes (item value, else the field-level default from `params`).
        const all = new Uint8Array(total);
        const starts = this.itemStarts.value.array;
        const tbl = this.itemTable.value.array;
        let off = 0;
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            all.set(it.bytes, off);
            starts[i] = off;
            this._packItemPage(i, it.page || {});
            const o = it.origin || {};
            const b = i * ITEM_STRIDE;
            tbl[b + I_ORIGIN_X] = o.x || 0;
            tbl[b + I_ORIGIN_Y] = o.y || 0;
            tbl[b + I_ORIGIN_Z] = o.z || 0;
            tbl[b + I_WRAP_WIDTH] = Math.max(0, Math.trunc(it.wrapWidth ?? params.wrapWidth ?? 0));
            tbl[b + I_Z_STEP] = it.zStep ?? params.zStep ?? 0;
            tbl[b + I_LINE_HEIGHT] = it.lineHeight ?? params.lineHeight ?? 1;
            off += it.bytes.length;
        }

        this.byteWords.value.array.set(packBytes(all));
        this.byteWords.value.needsUpdate = true;
        this.slots.value.array.fill(0);
        this.slots.value.needsUpdate = true;
        this.bounds.value.array.set(armedBoundsKeys());
        this.bounds.value.needsUpdate = true;
        this.missCount.value.array[0] = 0;
        this.missCount.value.needsUpdate = true;
        this.itemTable.value.needsUpdate = true;
        this.itemStarts.value.needsUpdate = true;

        this.byteLength = total;
        const u = this._u;
        u.byteLength.value = total;
        u.itemCount.value = items.length;
        u.window.value = params.window ?? 128;

        const count = Math.max(1, total);
        this._kDecode.count = count;
        this._kLayout.count = count;
        this._kPaginate.count = count;
        return this;
    }

    /** Pack one item's page params into its item-table row (lanes 3..10). @private */
    _packItemPage(i, p) {
        const tbl = this.itemTable.value.array;
        const b = i * ITEM_STRIDE;
        tbl[b + I_PAGE_ROWS] = Math.max(0, Math.trunc(p.pageRows || 0));
        tbl[b + I_PAGE_COLS] = Math.max(0, Math.trunc(p.pageCols || 0));
        tbl[b + I_PAGES_WIDE] = Math.max(1, Math.trunc(p.pagesWide || 1));
        tbl[b + I_PAGE_STRIDE_X] = p.pageStrideX || 0;
        tbl[b + I_BAND_STRIDE_Y] = p.bandStrideY || 0;
        tbl[b + I_DEPTH_PER_BAND] = p.depthPerBand || 0;
        tbl[b + I_DEPTH_PER_COL] = p.depthPerColumn || 0;
        tbl[b + I_SCROLL_ROWS] = Math.max(0, Math.trunc(p.scrollRows || 0));
    }

    /**
     * Retune ONE item's page params. Kernel 3 alone re-runs (repaginate) — the mode switch
     * that costs no decode and no walk. CAVEAT: pageCols is also the walk's fold unit
     * (loop 2 bounds its advance sum by it), so changing pageCols changes the walk's
     * output — that needs a full run(), not a repaginate(). Row-paging, fan, depth, and
     * scroll changes are repaginate-safe.
     */
    setItemPage(i, p = {}) {
        this._packItemPage(i, p);
        this.itemTable.value.needsUpdate = true;
        return this;
    }

    /** Single-item retune — the pre-items call shape; item 0's page params. */
    setPage(p = {}) {
        return this.setItemPage(0, p);
    }

    /** Full load: three dispatches, encoded back to back with no awaits between them. */
    run() {
        this.renderer.compute(this._kDecode);
        this.renderer.compute(this._kLayout);
        this.renderer.compute(this._kPaginate);
        return this;
    }

    /** Page/mode change only — kernel 3 over the base positions that already exist.
     *  The remap is reconstructive (it reads S_BASE_X and the integer lanes), so this is
     *  safe to call repeatedly with any fold-unit-preserving params. */
    repaginate() {
        this.bounds.value.array.set(armedBoundsKeys());
        this.bounds.value.needsUpdate = true;
        this.renderer.compute(this._kPaginate);
        return this;
    }

    /** @returns {Promise<{min:{x,y,z}, max:{x,y,z}, totalRows:number, maxRowExtent:number}>} the reduced box + scalars, 32 bytes off the GPU. */
    async readBounds() {
        const raw = await this.renderer.getArrayBufferAsync(this.bounds.value);
        const k = new Uint32Array(raw, 0, 8);
        return {
            min: { x: orderedKeyToFloat(k[0]), y: orderedKeyToFloat(k[1]), z: orderedKeyToFloat(k[2]) },
            max: { x: orderedKeyToFloat(k[3]), y: orderedKeyToFloat(k[4]), z: orderedKeyToFloat(k[5]) },
            totalRows: orderedKeyToFloat(k[6]),
            maxRowExtent: orderedKeyToFloat(k[7]),
        };
    }

    /** @returns {Promise<Float32Array>} the whole slot buffer — the parity path, not a render path.
     *  The readback is bounded to the LIVE byte range: under the arena the slots buffer is
     *  capacity-sized (16M bytes × stride — over the default maxBufferSize), so an
     *  unbounded readback buffer allocation fails before a byte is copied. */
    async readSlots() {
        const bytes = this.byteLength * SLOT_STRIDE * Float32Array.BYTES_PER_ELEMENT;
        const raw = await this.renderer.getArrayBufferAsync(this.slots.value, null, 0, bytes);
        return new Float32Array(raw, 0, this.byteLength * SLOT_STRIDE);
    }

    /** @returns {Promise<number[]>} codepoints with no atlas entry, for the CPU to encode. */
    async readMisses() {
        const cRaw = await this.renderer.getArrayBufferAsync(this.missCount.value);
        const n = Math.min(new Uint32Array(cRaw)[0], this.maxMisses);
        if (n === 0) return [];
        const raw = await this.renderer.getArrayBufferAsync(this.misses.value);
        return Array.from(new Uint32Array(raw, 0, n));
    }

    dispose() {
        const attrs = this.renderer?._attributes;
        for (const node of [this.byteWords, this.slots, this.trieIndex, this.trieBlocks,
            this.bounds, this.misses, this.missCount, this.itemTable, this.itemStarts]) {
            if (node && attrs) attrs.delete(node.value);
        }
        this._kDecode?.dispose();
        this._kLayout?.dispose();
        this._kPaginate?.dispose();
    }
}

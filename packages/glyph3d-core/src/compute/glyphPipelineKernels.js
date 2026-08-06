/**
 * glyphPipelineKernels — the byte-in glyph pipeline as WebGPU compute, in TSL.
 *
 * A transcription of the SCAN SPEC (`glyphPipelineScan.js`), whose semantics are the
 * oracle (`glyphPipelineReference.js`). Both are proven headlessly
 * (tools/scan-layout.test.mjs, tools/glyph-pipeline.test.mjs); this is the same
 * algorithm addressed to the GPU. Keep them dispatch-for-dispatch comparable — when
 * they diverge, the spec is right until a test says otherwise.
 *
 * THE FOLD IS A SEGMENTED MONOID SCAN, not a walk. Every byte contributes a small
 * summary (newlines, closed rows, head/tail run lengths, tail advance, ordinal; item
 * starts are ABSORBING RESETS); a leader's exclusive prefix yields its exact
 * row/col/ord in O(1). The shape is a RAKING reduce-then-scan, chosen for what it
 * does NOT need:
 *
 *   - no cross-thread read of anything a sibling wrote in the same dispatch
 *     (every dispatch's read set is a PREVIOUS dispatch's write set)
 *   - no workgroup shared memory, no barriers, no forward-progress assumption
 *   - no coherence window, no publish race, no schedule-dependent cost
 *   - every loop bounded by a compile-time constant
 *
 * Work is O(n); the result is bit-deterministic under every schedule.
 *
 * NINE DISPATCHES PER LOAD, not per frame (the five scan stages are the walk's
 * replacement; per-storm dispatch overhead is microseconds):
 *
 *   1. decodeAndResolve   bytes → codepoint → trie → glyphId/advance/height. Per byte.
 *   2. chunkReduce        serial fold of CHUNK_SIZE leaves → partials.   Per chunk.
 *   3. spineReduce        serial fold of GROUP_SIZE partials → supers.   Per group.
 *   4. spineScan          exclusive scan of supers.                      ONE thread.
 *   5. partialScan        group-seeded exclusive scan → partialPrefix.   Per group.
 *   6. apply              prefix through the chunk's leaves → the exact lanes
 *                         (row/col/lineAdv/ord) + the ordinal map.       Per chunk.
 *   7. resolveX           fold-relative x by re-summing ≤ fold advances through the
 *                         ordinal map (forward from the segment start — the exact f32
 *                         order the oracle accumulates, so fold > 0 x is bit-identical
 *                         to the CPU); foldless x is the line prefix. Writes the
 *                         unpaginated position + the per-item FOLD SCALARS reduce
 *                         (totalRows, item-relative widest row).         Per byte.
 *   8. deriveStrides      page-fan stride = widest row + pageGapX.       Per item.
 *   9. paginateAndBounds  pure per-slot remap from base + integer lanes, with the
 *                         per-item BOX reduce fused on.                  Per byte.
 *
 * Pagination (with strides) stays separately dispatchable: a mode switch or scroll
 * re-runs ONLY 8+9 over positions that already exist. And because resolveX reads the
 * fold unit from the ITEM TABLE at its own dispatch, a pageCols change re-runs 7-9 —
 * no re-scan, no re-decode (the scan never sees the fold unit's width, only wrap).
 *
 * ── MULTI-FILE (the item table) ────────────────────────────────────────────────────
 * One pipeline instance serves N files concatenated in ONE byte buffer. Per item: a
 * uint in itemStarts (the binary-search key) and ITEM_STRIDE floats in itemTable
 * (origin + page params + wrap/zStep/lineHeight — per-item lanes with setFiles
 * defaults). Item isolation is ALGEBRAIC: an item start is a reset element that
 * absorbs everything left of it under any grouping — row/col are file-relative and no
 * state can leak across files, structurally.
 *
 * BOUNDS ARE PER-ITEM, GPU-owned: resolveX reduces the fold scalars into foldScalars,
 * deriveStrides turns lane 1 (+ pageGapX) into itemStrides, and paginate reduces each
 * item's final box into itemBoxes. readItemBounds() is ONE readback handing every
 * staged field its extent — the CPU never re-lays a file to learn its size.
 *
 * ── VERIFIED ON HARDWARE (tools/glyph-pipeline-check.mjs) ──────────────────────────
 * GPU output diffs against runPipeline() (the oracle) on the same bytes, over
 * torture / 40k-single-line / real-file corpora at wrap 0/24/200 and every page mode.
 * Integer lanes must be BIT-EXACT everywhere — the scan is deterministic, so unlike
 * the old walk there is no "within f32 accumulation noise" carve-out for fold > 0 x.
 */

import { TSL } from 'three/webgpu';
import {
    SLOT_STRIDE, S_CODEPOINT, S_GLYPH_ID, S_ADVANCE, S_HEIGHT,
    S_X, S_Y, S_Z, S_ROW, S_COL, S_FLAGS, S_BASE_X, S_LINE_ADV, S_ORD,
    F_LEADER, F_RENDERED, F_MISSING, NEWLINE,
    ITEM_STRIDE, I_ORIGIN_X, I_ORIGIN_Y, I_ORIGIN_Z,
    I_PAGE_ROWS, I_PAGE_COLS, I_PAGES_WIDE, I_PAGE_GAP_X,
    I_BAND_STRIDE_Y, I_DEPTH_PER_BAND, I_DEPTH_PER_COL, I_SCROLL_ROWS,
    I_WRAP_WIDTH, I_Z_STEP, I_LINE_HEIGHT,
} from './glyphPipelineReference.js';
import { CHUNK_SIZE, GROUP_SIZE } from './glyphPipelineScan.js';
import { BLOCK_SHIFT, BLOCK_MASK, ENTRY_STRIDE, LANE_GLYPH_ID, LANE_ADVANCE, LANE_HEIGHT, LANE_FLAGS } from './GlyphTrie.js';

const {
    Fn, If, Loop, Break, Return, uniform, instancedArray, instanceIndex,
    int, uint, float, atomicMin, atomicMax, atomicAdd, atomicLoad, bitcast,
} = TSL;

/**
 * resolveX's re-sum cap. This is a SAFETY BOUND for ABSURD FOLD UNITS ONLY — the loop's
 * real bound is `col % fold < fold`, so the cap can only bite when an item declares a
 * wrap/pageCols wider than 4096 glyphs. Foldless content (the case the old walk's
 * MAX_WALK_STEPS fuse silently corrupted) never enters this loop at all: its x is the
 * line prefix, exact at any length. A bitten cap produces a wrong x, never a hang.
 */
export const MAX_FOLD_RESUM = 4096;

/**
 * Binary-search iteration cap for the per-thread item resolution (32 halvings address
 * 2^32 items; the cap exists because an unbounded loop that fails to converge is a
 * device loss). Break() exits as soon as the range collapses.
 */
const BINARY_SEARCH_STEPS = 32;

/** Item capacity a pipeline is born with — files per load storm. Memory is trivial
 *  (ITEM_STRIDE floats + one uint per item), so the default is sized for the storm. */
export const DEFAULT_MAX_ITEMS = 1024;

/**
 * The packed monoid element — one row of the partials/supers/prefix buffers. All-uint
 * (counts are exact; TAILADV is an f32 bitcast into its lane). Mirrors the spec's
 * {reset, nl, glyphs, rows, headLen, tailLen, wrap, tailAdv} object.
 */
export const P_STRIDE = 8;
const P_RESET = 0, P_NL = 1, P_GLYPHS = 2, P_ROWS = 3,
    P_HEAD = 4, P_TAIL = 5, P_WRAP = 6, P_TAILADV = 7;

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

/** Inverse of floatToOrderedKey, in-shader — the stride kernel decodes the fold
 *  scalars' reduced extent. An ARMED key (0 — no glyph ever reduced) decodes to 0, not NaN. */
const orderedKeyToFloatGPU = /*#__PURE__*/ Fn(([k]) => {
    const bits = k.bitAnd(uint(0x80000000)).notEqual(uint(0))
        .select(k.bitXor(uint(0x80000000)), k.bitNot());
    return k.equal(uint(0)).select(float(0), bitcast(bits, 'float'));
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
 * Armed PER-ITEM box cells (6 lanes each), so the first atomic always wins.
 * Row layout: [minX, minY, minZ, maxX, maxY, maxZ] as ordered keys.
 */
export function armedBoxKeys(count = 1) {
    const a = new Uint32Array(count * 6);
    for (let i = 0; i < count; i++) {
        const b = i * 6;
        a[b] = a[b + 1] = a[b + 2] = 0xFFFFFFFF;   // min lanes start at +inf's key
        a[b + 3] = a[b + 4] = a[b + 5] = 0x00000000;   // max lanes start at -inf's key
    }
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
        if (this.maxBytes > 2 ** 24) {
            // S_ORD (and every count lane) must stay exact in an f32 slot lane.
            throw new Error(`GlyphPipelineKernels: maxBytes ${this.maxBytes} exceeds 2^24 — ordinals would lose exactness in f32`);
        }
        this.maxChunks = Math.ceil(this.maxBytes / CHUNK_SIZE);
        this.maxSupers = Math.ceil(this.maxChunks / GROUP_SIZE);
        this.byteLength = 0;
        this.itemCount = 0;

        // ── Buffers ────────────────────────────────────────────────────────────────────
        this.byteWords = instancedArray(Math.ceil(this.maxBytes / 4), 'uint').setName('GlyphBytes');
        this.slots = instancedArray(this.maxBytes * SLOT_STRIDE, 'float').setName('GlyphSlots');
        this.trieIndex = instancedArray(trie.blockIndex.length, 'uint').setName('GlyphTrieIndex');
        this.trieBlocks = instancedArray(trie.blocks.length, 'float').setName('GlyphTrieBlocks');
        // The scan's ladder: chunk partials, their group reduces, the two exclusive-prefix
        // levels, and the ordinal map (leader ordinal → byte index, per item's byte range).
        this.partials = instancedArray(this.maxChunks * P_STRIDE, 'uint').setName('GlyphScanPartials');
        this.partialPrefix = instancedArray(this.maxChunks * P_STRIDE, 'uint').setName('GlyphScanPartialPrefix');
        this.supers = instancedArray(this.maxSupers * P_STRIDE, 'uint').setName('GlyphScanSupers');
        this.superPrefix = instancedArray(this.maxSupers * P_STRIDE, 'uint').setName('GlyphScanSuperPrefix');
        this.ordToByte = instancedArray(this.maxBytes, 'uint').setName('GlyphOrdToByte');
        // Per-item bounds, split by WRITER so re-arming one never clobbers the other:
        // itemBoxes (6 lanes/item — final positions, paginate, re-armed every repaginate)
        // and foldScalars (2 lanes/item — totalRows + ITEM-RELATIVE widest row, resolveX,
        // armed only at setFiles: repaginates don't re-fold, so the scalars persist and
        // the stride kernel can read them).
        this.itemBoxes = instancedArray(this.maxItems * 6, 'uint').setName('GlyphItemBoxes').toAtomic();
        this.foldScalars = instancedArray(this.maxItems * 2, 'uint').setName('GlyphFoldScalars').toAtomic();
        // The derived page-fan stride per item — GPU-written (fold extent + gap), read by
        // paginate. Its own buffer so item-table uploads never clobber it.
        this.itemStrides = instancedArray(this.maxItems, 'float').setName('GlyphItemStrides');
        this.misses = instancedArray(maxMisses, 'uint').setName('GlyphMisses');
        this.missCount = instancedArray(1, 'uint').setName('GlyphMissCount').toAtomic();
        // The item table: per-item params that VARY across files (origin + page params +
        // the fold metrics wrap/zStep/lineHeight). itemStarts is the search key buffer.
        this.itemTable = instancedArray(this.maxItems * ITEM_STRIDE, 'float').setName('GlyphItemTable');
        this.itemStarts = instancedArray(this.maxItems, 'uint').setName('GlyphItemStarts');

        // Node names don't reach the GPU; ATTRIBUTE names do (three passes attribute.name
        // as the GPUBuffer label) — so Dawn errors name the buffer instead of "(unlabeled)".
        for (const node of this._allNodes()) node.value.name = node.name;

        this.trieIndex.value.array.set(trie.blockIndex);
        this.trieBlocks.value.array.set(trie.blocks);
        this.trieIndex.value.needsUpdate = true;
        this.trieBlocks.value.needsUpdate = true;
        this.maxMisses = maxMisses;

        // ── Uniforms — the dispatch widths ONLY. Origin, every page param, AND
        //    wrap/zStep/lineHeight are per-item lanes (grids in one arena fold
        //    differently — the item table is the single source of truth). The old
        //    coherence `window` is gone WITH the race it dialed.
        this._u = {
            byteLength: uniform(0, 'uint'),
            itemCount:  uniform(1, 'uint'),
            chunkCount: uniform(1, 'uint'),
            superCount: uniform(1, 'uint'),
        };

        this._kDecode = this._buildDecode();
        this._kChunkReduce = this._buildChunkReduce();
        this._kSpineReduce = this._buildSpineReduce();
        this._kSpineScan = this._buildSpineScan();
        this._kPartialScan = this._buildPartialScan();
        this._kApply = this._buildApply();
        this._kResolveX = this._buildResolveX();
        this._kStrides = this._buildDeriveStrides();
        this._kPaginate = this._buildPaginateAndBounds();
    }

    /** @private */
    _allNodes() {
        return [this.byteWords, this.slots, this.trieIndex, this.trieBlocks,
            this.partials, this.partialPrefix, this.supers, this.superPrefix, this.ordToByte,
            this.itemBoxes, this.foldScalars, this.itemStrides,
            this.misses, this.missCount, this.itemTable, this.itemStarts];
    }

    /** @private */
    _allKernels() {
        return [this._kDecode, this._kChunkReduce, this._kSpineReduce, this._kSpineScan,
            this._kPartialScan, this._kApply, this._kResolveX, this._kStrides, this._kPaginate];
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
     * as a TSL binary search over itemStarts. Used once per thread (resolveX/paginate) or
     * once per CHUNK (the serial scan loops advance a cursor instead).
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

    // ── The monoid, in registers ───────────────────────────────────────────────────────
    // An element is 7 int vars + 1 float var, mirroring the spec's object. Lanes stay
    // int (counts are far below 2^31); only the packed buffers are uint.

    /** Fresh identity element as named toVars. @private */
    _elemIdentity(tag) {
        return {
            reset: int(0).toVar(`${tag}Reset`),
            nl: int(0).toVar(`${tag}Nl`),
            glyphs: int(0).toVar(`${tag}Glyphs`),
            rows: int(0).toVar(`${tag}Rows`),
            headLen: int(0).toVar(`${tag}Head`),
            tailLen: int(0).toVar(`${tag}Tail`),
            wrap: int(0).toVar(`${tag}Wrap`),
            tailAdv: float(0).toVar(`${tag}Adv`),
        };
    }

    /** e := identity (wrap preserved by caller if wanted). @private */
    _elemClear(e) {
        e.reset.assign(int(0)); e.nl.assign(int(0)); e.glyphs.assign(int(0));
        e.rows.assign(int(0)); e.headLen.assign(int(0)); e.tailLen.assign(int(0));
        e.tailAdv.assign(float(0));
    }

    /** Load a packed element row into fresh vars. @private */
    _elemLoad(buf, idx, tag) {
        const b = idx.mul(uint(P_STRIDE));
        return {
            reset: int(buf.element(b.add(uint(P_RESET)))).toVar(`${tag}Reset`),
            nl: int(buf.element(b.add(uint(P_NL)))).toVar(`${tag}Nl`),
            glyphs: int(buf.element(b.add(uint(P_GLYPHS)))).toVar(`${tag}Glyphs`),
            rows: int(buf.element(b.add(uint(P_ROWS)))).toVar(`${tag}Rows`),
            headLen: int(buf.element(b.add(uint(P_HEAD)))).toVar(`${tag}Head`),
            tailLen: int(buf.element(b.add(uint(P_TAIL)))).toVar(`${tag}Tail`),
            wrap: int(buf.element(b.add(uint(P_WRAP)))).toVar(`${tag}Wrap`),
            tailAdv: bitcast(buf.element(b.add(uint(P_TAILADV))), 'float').toVar(`${tag}Adv`),
        };
    }

    /** Store an element into a packed row. @private */
    _elemStore(buf, idx, e) {
        const b = idx.mul(uint(P_STRIDE));
        buf.element(b.add(uint(P_RESET))).assign(uint(e.reset));
        buf.element(b.add(uint(P_NL))).assign(uint(e.nl));
        buf.element(b.add(uint(P_GLYPHS))).assign(uint(e.glyphs));
        buf.element(b.add(uint(P_ROWS))).assign(uint(e.rows));
        buf.element(b.add(uint(P_HEAD))).assign(uint(e.headLen));
        buf.element(b.add(uint(P_TAIL))).assign(uint(e.tailLen));
        buf.element(b.add(uint(P_WRAP))).assign(uint(e.wrap));
        buf.element(b.add(uint(P_TAILADV))).assign(bitcast(e.tailAdv, 'uint'));
    }

    /**
     * a := combine(a, b) — the spec's scanCombine, in registers. b.reset absorbs a;
     * otherwise head/tail runs merge and the junction line (closed by b's first
     * newline) joins `rows` wrap-aware. rowsForLine(len, wrap) = wrap>0 ? len/wrap+1 : 1.
     * @private
     */
    _combineInto(a, b) {
        If(b.reset.notEqual(int(0)), () => {
            a.reset.assign(int(1));
            a.nl.assign(b.nl); a.glyphs.assign(b.glyphs); a.rows.assign(b.rows);
            a.headLen.assign(b.headLen); a.tailLen.assign(b.tailLen);
            a.wrap.assign(b.wrap); a.tailAdv.assign(b.tailAdv);
        }).Else(() => {
            a.wrap.assign(b.wrap);
            If(b.nl.equal(int(0)), () => {
                a.tailLen.addAssign(b.tailLen);
                a.tailAdv.addAssign(b.tailAdv);
                If(a.nl.equal(int(0)), () => { a.headLen.assign(a.tailLen); });
            }).Else(() => {
                If(a.nl.equal(int(0)), () => {
                    a.headLen.addAssign(b.headLen);
                    a.rows.assign(b.rows);
                }).Else(() => {
                    const len = a.tailLen.add(b.headLen).toVar('jLen');
                    const rl = b.wrap.greaterThan(int(0))
                        .select(len.div(b.wrap).add(int(1)), int(1)).toVar('jRows');
                    a.rows.assign(a.rows.add(rl).add(b.rows));
                });
                a.tailLen.assign(b.tailLen);
                a.tailAdv.assign(b.tailAdv);
            });
            a.nl.addAssign(b.nl);
            a.glyphs.addAssign(b.glyphs);
        });
    }

    /**
     * The serial ITEM CURSOR the chunk loops advance: byte ids ascend one at a time, and
     * an item is ≥ 1 byte, so at most one boundary crossing per step. Returns the vars
     * the loop body reads (item, itemStartByte, wrap, nextStart).
     * @private
     */
    _cursorInit(itemSearch, fromByte) {
        const u = this._u;
        const starts = this.itemStarts;
        const it = this.itemTable;
        const item = itemSearch(fromByte).toVar('curItem');
        const itemStartByte = starts.element(item).toVar('curItemStart');
        const wrap = int(it.element(item.mul(uint(ITEM_STRIDE)).add(uint(I_WRAP_WIDTH)))).toVar('curWrap');
        const nextStart = uint(0xFFFFFFFF).toVar('curNext');
        If(item.add(uint(1)).lessThan(u.itemCount), () => {
            nextStart.assign(starts.element(item.add(uint(1))));
        });
        return { item, itemStartByte, wrap, nextStart };
    }

    /** Advance the cursor at byte `id` (call once per loop step, before use). @private */
    _cursorAdvance(cur, id) {
        const u = this._u;
        const starts = this.itemStarts;
        const it = this.itemTable;
        If(id.greaterThanEqual(cur.nextStart), () => {
            cur.item.addAssign(uint(1));
            cur.itemStartByte.assign(cur.nextStart);
            cur.wrap.assign(int(it.element(cur.item.mul(uint(ITEM_STRIDE)).add(uint(I_WRAP_WIDTH)))));
            If(cur.item.add(uint(1)).lessThan(u.itemCount), () => {
                cur.nextStart.assign(starts.element(cur.item.add(uint(1))));
            }).Else(() => {
                cur.nextStart.assign(uint(0xFFFFFFFF));
            });
        });
    }

    /**
     * Fold byte `id`'s LEAF into `acc` — the spec's scanLeaf + scanCombine specialized
     * for a leaf on the right (no allocation of a leaf element: the leaf's lanes are
     * scalars). isStart = id == its item's first byte (the absorbing reset).
     * @private
     */
    _leafInto(acc, id, cur) {
        const S = this.slots;
        const o = id.mul(uint(SLOT_STRIDE)).toVar('lfO');
        const flags = int(S.element(o.add(uint(S_FLAGS)))).toVar('lfFlags');
        const isStart = id.equal(cur.itemStartByte).toVar('lfStart');

        If(isStart, () => {
            // reset leaf: acc := (reset identity) ⊗ leaf-content
            this._elemClear(acc);
            acc.reset.assign(int(1));
        });
        acc.wrap.assign(cur.wrap);
        If(flags.bitAnd(int(F_LEADER)).notEqual(int(0)), () => {
            acc.glyphs.addAssign(int(1));
            If(S.element(o.add(uint(S_CODEPOINT))).equal(float(NEWLINE)), () => {
                // A newline closes acc's open tail run: if lines were already closed, the
                // run is a whole interior line (rows += rowsForLine); if not, it fixes head.
                If(acc.nl.equal(int(0)), () => {
                    acc.headLen.assign(acc.tailLen);
                }).Else(() => {
                    const rl = acc.wrap.greaterThan(int(0))
                        .select(acc.tailLen.div(acc.wrap).add(int(1)), int(1)).toVar('lfRows');
                    acc.rows.addAssign(rl);
                });
                acc.nl.addAssign(int(1));
                acc.tailLen.assign(int(0));
                acc.tailAdv.assign(float(0));
            }).Else(() => {
                acc.tailLen.addAssign(int(1));
                acc.tailAdv.addAssign(S.element(o.add(uint(S_ADVANCE))));
                If(acc.nl.equal(int(0)), () => { acc.headLen.assign(acc.tailLen); });
            });
        });
    }

    /**
     * KERNEL 2 — thread per CHUNK. Serial fold of the chunk's CHUNK_SIZE leaves into one
     * partial. Reads decode's lanes only; writes its own partials row. No cross-thread
     * dependency.
     * @private
     */
    _buildChunkReduce() {
        const u = this._u;
        const itemSearch = this._buildItemSearch();
        return Fn(() => {
            const c = instanceIndex;
            If(c.greaterThanEqual(u.chunkCount), () => { Return(); });
            const from = c.mul(uint(CHUNK_SIZE)).toVar('from');
            const cur = this._cursorInit(itemSearch, from);
            const acc = this._elemIdentity('r');
            const id = from.toVar('rId');
            Loop(CHUNK_SIZE, () => {
                If(id.greaterThanEqual(u.byteLength), () => { Break(); });
                this._cursorAdvance(cur, id);
                this._leafInto(acc, id, cur);
                id.addAssign(uint(1));
            });
            this._elemStore(this.partials, c, acc);
        })().compute(1).setName('glyphScanChunkReduce');
    }

    /**
     * KERNEL 3 — thread per GROUP. Serial fold of GROUP_SIZE partials into one super.
     * @private
     */
    _buildSpineReduce() {
        const u = this._u;
        return Fn(() => {
            const g = instanceIndex;
            If(g.greaterThanEqual(u.superCount), () => { Return(); });
            const acc = this._elemIdentity('s');
            const c = g.mul(uint(GROUP_SIZE)).toVar('sC');
            Loop(GROUP_SIZE, () => {
                If(c.greaterThanEqual(u.chunkCount), () => { Break(); });
                const p = this._elemLoad(this.partials, c, 'sp');
                this._combineInto(acc, p);
                c.addAssign(uint(1));
            });
            this._elemStore(this.supers, g, acc);
        })().compute(1).setName('glyphScanSpineReduce');
    }

    /**
     * KERNEL 4 — ONE thread. Exclusive scan of the supers, in order. maxSupers is a
     * construction-time constant (maxBytes / CHUNK_SIZE / GROUP_SIZE — a few dozen to a
     * few hundred); the serial combine chain is microscopic next to any per-byte pass.
     * @private
     */
    _buildSpineScan() {
        const u = this._u;
        return Fn(() => {
            If(instanceIndex.notEqual(uint(0)), () => { Return(); });
            const acc = this._elemIdentity('x');
            const g = uint(0).toVar('xG');
            Loop(this.maxSupers, () => {
                If(g.greaterThanEqual(u.superCount), () => { Break(); });
                this._elemStore(this.superPrefix, g, acc);
                const s = this._elemLoad(this.supers, g, 'xs');
                this._combineInto(acc, s);
                g.addAssign(uint(1));
            });
        })().compute(1).setName('glyphScanSpine');
    }

    /**
     * KERNEL 5 — thread per GROUP. Seed from the super prefix, serially scan the group's
     * partials into partialPrefix — each chunk's exclusive prefix, ready for apply.
     * @private
     */
    _buildPartialScan() {
        const u = this._u;
        return Fn(() => {
            const g = instanceIndex;
            If(g.greaterThanEqual(u.superCount), () => { Return(); });
            const acc = this._elemLoad(this.superPrefix, g, 'q');
            const c = g.mul(uint(GROUP_SIZE)).toVar('qC');
            Loop(GROUP_SIZE, () => {
                If(c.greaterThanEqual(u.chunkCount), () => { Break(); });
                this._elemStore(this.partialPrefix, c, acc);
                const p = this._elemLoad(this.partials, c, 'qp');
                this._combineInto(acc, p);
                c.addAssign(uint(1));
            });
        })().compute(1).setName('glyphScanPartialScan');
    }

    /**
     * KERNEL 6 — thread per CHUNK. APPLY: run the chunk's exclusive prefix through its
     * leaves; at every leader, the prefix IS the answer:
     *
     *   col = tailLen · ord = glyphs · lineAdv = tailAdv
     *   row = (nl > 0 ? rowsForLine(headLen, wrap) + rows : 0) + col/wrap
     *
     * Writes the exact lanes + the ordinal map (ordToByte[itemStart + ord] = id — the
     * scatter resolveX gathers through). An item-start byte queries the IDENTITY (its
     * prefix must not see the previous item), which _leafInto's reset then makes true
     * for every later byte too.
     * @private
     */
    _buildApply() {
        const u = this._u;
        const S = this.slots;
        const itemSearch = this._buildItemSearch();
        return Fn(() => {
            const c = instanceIndex;
            If(c.greaterThanEqual(u.chunkCount), () => { Return(); });
            const from = c.mul(uint(CHUNK_SIZE)).toVar('aFrom');
            const cur = this._cursorInit(itemSearch, from);
            const acc = this._elemLoad(this.partialPrefix, c, 'a');
            const id = from.toVar('aId');
            Loop(CHUNK_SIZE, () => {
                If(id.greaterThanEqual(u.byteLength), () => { Break(); });
                this._cursorAdvance(cur, id);

                // The item's first byte folds from identity — clear BEFORE the query.
                If(id.equal(cur.itemStartByte), () => { this._elemClear(acc); });

                const o = id.mul(uint(SLOT_STRIDE)).toVar('aO');
                const flags = int(S.element(o.add(uint(S_FLAGS)))).toVar('aFlags');
                If(flags.bitAnd(int(F_LEADER)).notEqual(int(0)), () => {
                    const col = acc.tailLen.toVar('aCol');
                    const closed = int(0).toVar('aClosed');
                    If(acc.nl.greaterThan(int(0)), () => {
                        const headRows = cur.wrap.greaterThan(int(0))
                            .select(acc.headLen.div(cur.wrap).add(int(1)), int(1)).toVar('aHeadRows');
                        closed.assign(headRows.add(acc.rows));
                    });
                    const wrapRow = cur.wrap.greaterThan(int(0))
                        .select(col.div(cur.wrap), int(0)).toVar('aWrapRow');
                    const row = closed.add(wrapRow).toVar('aRow');

                    S.element(o.add(uint(S_ROW))).assign(row.toFloat());
                    S.element(o.add(uint(S_COL))).assign(col.toFloat());
                    S.element(o.add(uint(S_LINE_ADV))).assign(acc.tailAdv);
                    S.element(o.add(uint(S_ORD))).assign(acc.glyphs.toFloat());
                    S.element(o.add(uint(S_FLAGS))).assign(float(flags.bitOr(int(F_RENDERED))));
                    this.ordToByte.element(cur.itemStartByte.add(uint(acc.glyphs))).assign(id);
                });

                this._leafInto(acc, id, cur);
                id.addAssign(uint(1));
            });
        })().compute(1).setName('glyphScanApply');
    }

    /**
     * KERNEL 7 — thread per byte. RESOLVE X + the unpaginated placement + the per-item
     * fold-scalar reduce (the spec's resolveX, verbatim).
     *
     * Fold unit (item's wrap, else pageCols): x re-sums the glyph's col % fold same-row
     * predecessors through the ordinal map, FORWARD from the segment start — the exact
     * f32 order the oracle's serial fold accumulates, so the bits match the CPU.
     * Foldless: x is the line prefix (S_LINE_ADV), exact at any line length — the case
     * the old walk's fuse corrupted is simply a load now.
     *
     * Cross-thread reads (slots integer lanes, ordToByte) are apply's writes — previous
     * dispatch, safe. This dispatch writes only its own slot + the atomic scalars.
     * @private
     */
    _buildResolveX() {
        const u = this._u;
        const S = this.slots;
        const it = this.itemTable;
        const starts = this.itemStarts;
        const itemSearch = this._buildItemSearch();
        const lane = (slot, l) => S.element(slot.mul(uint(SLOT_STRIDE)).add(uint(l)));

        return Fn(() => {
            const id = instanceIndex;
            If(id.greaterThanEqual(u.byteLength), () => { Return(); });
            If(int(lane(id, S_FLAGS)).bitAnd(int(F_LEADER)).equal(int(0)), () => { Return(); });

            const item = itemSearch(id).toVar('item');
            const ib = item.mul(uint(ITEM_STRIDE)).toVar('ib');
            const itemStart = starts.element(item).toVar('itemStart');
            const originX = it.element(ib.add(uint(I_ORIGIN_X))).toVar('originX');
            const originY = it.element(ib.add(uint(I_ORIGIN_Y))).toVar('originY');
            const originZ = it.element(ib.add(uint(I_ORIGIN_Z))).toVar('originZ');
            const wrap = int(it.element(ib.add(uint(I_WRAP_WIDTH)))).toVar('wrap');
            const pageCols = int(it.element(ib.add(uint(I_PAGE_COLS)))).toVar('pageCols');
            const lineHeight = it.element(ib.add(uint(I_LINE_HEIGHT))).toVar('lineHeight');
            const zWrapStep = it.element(ib.add(uint(I_Z_STEP))).toVar('zWrapStep');

            const col = int(lane(id, S_COL)).toVar('col');
            const ord = int(lane(id, S_ORD)).toVar('ord');
            const row = lane(id, S_ROW).toVar('row');
            const fold = wrap.greaterThan(int(0)).select(wrap, pageCols).toVar('fold');

            const x = float(0).toVar('x');
            If(fold.greaterThan(int(0)), () => {
                const back = col.mod(fold).toVar('back');
                const k = back.toVar('k');
                Loop(MAX_FOLD_RESUM, () => {
                    If(k.lessThan(int(1)), () => { Break(); });
                    const q = this.ordToByte.element(itemStart.add(uint(ord.sub(k)))).toVar('q');
                    x.addAssign(lane(q, S_ADVANCE));
                    k.subAssign(int(1));
                });
            }).Else(() => {
                x.assign(lane(id, S_LINE_ADV));
            });

            const wrapping = wrap.greaterThan(int(0)).toVar('wrapping');
            const wrapRow = wrapping.select(col.div(wrap), int(0)).toVar('wrapRow');
            const o = id.mul(uint(SLOT_STRIDE)).toVar('o');
            S.element(o.add(uint(S_BASE_X))).assign(x.add(originX));
            S.element(o.add(uint(S_X))).assign(x.add(originX));
            S.element(o.add(uint(S_Y))).assign(row.negate().mul(lineHeight).add(originY));
            S.element(o.add(uint(S_Z))).assign(originZ.sub(wrapRow.toFloat().mul(zWrapStep)));

            // ── fold scalars, fused per ITEM: total visual rows + the widest row. `x` is
            //    the pre-origin sum — item-relative by construction, which is what makes
            //    it a content WIDTH the stride kernel can fan pages by.
            const ws = item.mul(uint(2)).toVar('ws');
            atomicMax(this.foldScalars.element(ws), floatToOrderedKey(row.add(1)));
            atomicMax(this.foldScalars.element(ws.add(uint(1))), floatToOrderedKey(x));
        })().compute(1).setName('glyphResolveX');
    }

    /**
     * KERNEL 8 — thread per ITEM (a few thousand threads at most). The stride derivation:
     * a row-paged item's page-fan stride is its widest fold row (foldScalars lane 1,
     * item-relative) + its pageGapX. GPU-owned so the CPU never measures content — the
     * dispatch barrier after resolveX makes the reduced scalar safe to read here, and
     * paginate keeps its pure-remap contract by reading the RESOLVED stride buffer.
     * Mirror: deriveStride() in the reference — the one shared formula.
     * @private
     */
    _buildDeriveStrides() {
        const u = this._u;
        const it = this.itemTable;
        return Fn(() => {
            const item = instanceIndex;
            If(item.greaterThanEqual(u.itemCount), () => { Return(); });
            const ib = item.mul(uint(ITEM_STRIDE)).toVar('ib');
            const pageRows = int(it.element(ib.add(uint(I_PAGE_ROWS)))).toVar('pageRows');
            const stride = float(0).toVar('stride');
            If(pageRows.greaterThan(int(0)), () => {
                const key = atomicLoad(this.foldScalars.element(item.mul(uint(2)).add(uint(1)))).toVar('wkey');
                stride.assign(orderedKeyToFloatGPU(key).add(it.element(ib.add(uint(I_PAGE_GAP_X)))));
            });
            this.itemStrides.element(item).assign(stride);
        })().compute(1).setName('glyphDeriveStrides');
    }

    /**
     * KERNEL 9 — thread per byte. Page remap on the EXACT integer lanes, with the PER-ITEM
     * box reduce fused on: six atomics riding a pass that already touches every glyph.
     * atomicMin/Max early-out in hardware, so contention collapses after each item's box
     * converges instead of every thread doing a CAS.
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
            //    metrics come from the item table.
            const item = itemSearch(id).toVar('item');
            const ib = item.mul(uint(ITEM_STRIDE)).toVar('ib');
            const originY = it.element(ib.add(uint(I_ORIGIN_Y))).toVar('originY');
            const originZ = it.element(ib.add(uint(I_ORIGIN_Z))).toVar('originZ');
            const pageRows = int(it.element(ib.add(uint(I_PAGE_ROWS)))).toVar('pageRows');
            const pageCols = int(it.element(ib.add(uint(I_PAGE_COLS)))).toVar('pageCols');
            const pagesWide = int(it.element(ib.add(uint(I_PAGES_WIDE)))).toVar('pagesWide');
            // The DERIVED stride (kernel 8) — never a CPU input, never measured here.
            const pageStrideX = this.itemStrides.element(item).toVar('pageStrideX');
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
            // RECONSTRUCTIVE, never accumulative: x reads resolveX's untouched base lane
            // (already within the fold unit), and y/z are rebuilt from the exact integer
            // lanes. Re-running with new params re-derives from base — there is no
            // "re-paginate", the remap cannot double-apply.
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

            // ── the item's box, fused (over the FINAL positions; the fold scalars live in
            //    resolveX's fused reduce — they don't change under a repaginate) ──────────
            const w = lane(id, S_ADVANCE).toVar('w');
            const h = lane(id, S_HEIGHT).toVar('h');
            const bb = item.mul(uint(6)).toVar('bb');
            atomicMin(this.itemBoxes.element(bb), floatToOrderedKey(xf));
            atomicMin(this.itemBoxes.element(bb.add(uint(1))), floatToOrderedKey(yf));
            atomicMin(this.itemBoxes.element(bb.add(uint(2))), floatToOrderedKey(zf));
            atomicMax(this.itemBoxes.element(bb.add(uint(3))), floatToOrderedKey(xf.add(w)));
            atomicMax(this.itemBoxes.element(bb.add(uint(4))), floatToOrderedKey(yf.add(h)));
            atomicMax(this.itemBoxes.element(bb.add(uint(5))), floatToOrderedKey(zf));
        })().compute(1).setName('glyphPaginateAndBounds');
    }

    /**
     * Upload ONE file's bytes and arm the uniforms — the one-item case of setFiles().
     * Bytes + the item table are the ONLY per-load uploads.
     * @param {Uint8Array} bytes
     * @param {Object} params - wrapWidth, lineHeight, zStep, origin, page
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
     *   Each item's page bag takes pageRows, pageCols (also resolveX's fold unit when
     *   wrap is off — retunable at resolveX rate, not scan rate), pagesWide, pageGapX
     *   (the stride itself is GPU-derived), bandStrideY, depthPerBand, depthPerColumn,
     *   scrollRows.
     * @param {Object} params - field-level DEFAULTS an item can override per item:
     *   wrapWidth, lineHeight, zStep.
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
        // Arm BOTH bounds buffers: a full run re-folds, so the fold scalars re-reduce too
        // (repaginate() re-arms only the boxes — the fold persists there).
        this.itemBoxes.value.array.set(armedBoxKeys(this.maxItems));
        this.itemBoxes.value.needsUpdate = true;
        this.foldScalars.value.array.fill(0);   // max lanes arm at -inf's key (0)
        this.foldScalars.value.needsUpdate = true;
        this.missCount.value.array[0] = 0;
        this.missCount.value.needsUpdate = true;
        this.itemTable.value.needsUpdate = true;
        this.itemStarts.value.needsUpdate = true;

        this.byteLength = total;
        this.itemCount = items.length;
        const chunks = Math.max(1, Math.ceil(total / CHUNK_SIZE));
        const supers = Math.max(1, Math.ceil(chunks / GROUP_SIZE));
        const u = this._u;
        u.byteLength.value = total;
        u.itemCount.value = items.length;
        u.chunkCount.value = chunks;
        u.superCount.value = supers;

        const count = Math.max(1, total);
        this._kDecode.count = count;
        this._kChunkReduce.count = chunks;
        this._kSpineReduce.count = supers;
        this._kSpineScan.count = 1;
        this._kPartialScan.count = supers;
        this._kApply.count = chunks;
        this._kResolveX.count = count;
        this._kStrides.count = items.length;
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
        tbl[b + I_PAGE_GAP_X] = p.pageGapX || 0;
        tbl[b + I_BAND_STRIDE_Y] = p.bandStrideY || 0;
        tbl[b + I_DEPTH_PER_BAND] = p.depthPerBand || 0;
        tbl[b + I_DEPTH_PER_COL] = p.depthPerColumn || 0;
        tbl[b + I_SCROLL_ROWS] = Math.max(0, Math.trunc(p.scrollRows || 0));
    }

    /**
     * Retune ONE item's page params. Row-paging, fan, depth, and scroll changes are
     * repaginate-safe (strides + paginate re-run). A pageCols change additionally
     * changes resolveX's fold unit — that needs refold() (resolveX + strides +
     * paginate), still never a re-scan. Only wrap changes re-run the scan (a full
     * run()), because wrap shapes row/col themselves.
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

    /** Full load: the nine dispatches, encoded back to back with no awaits between
     *  them (each dispatch's reads are a previous dispatch's writes — the pass
     *  boundary is the only synchronization the algorithm needs). */
    run() {
        this.renderer.compute(this._kDecode);
        this.renderer.compute(this._kChunkReduce);
        this.renderer.compute(this._kSpineReduce);
        this.renderer.compute(this._kSpineScan);
        this.renderer.compute(this._kPartialScan);
        this.renderer.compute(this._kApply);
        this.renderer.compute(this._kResolveX);
        this.renderer.compute(this._kStrides);
        this.renderer.compute(this._kPaginate);
        return this;
    }

    /** Page/mode change only — strides + paginate over the base positions that already
     *  exist (a page retune can change pageGapX, so the stride re-derives; the fold
     *  scalars it reads persist — repaginate re-arms only the boxes). The remap is
     *  reconstructive (S_BASE_X + integer lanes): safe to call repeatedly with any
     *  fold-unit-preserving params. */
    repaginate() {
        this.itemBoxes.value.array.set(armedBoxKeys(this.maxItems));
        this.itemBoxes.value.needsUpdate = true;
        this.renderer.compute(this._kStrides);
        this.renderer.compute(this._kPaginate);
        return this;
    }

    /** Fold-unit retune (pageCols) — resolveX + strides + paginate re-run over the scan's
     *  exact lanes. The fold scalars re-reduce (widest ROW depends on the fold unit), so
     *  they re-arm here; no decode, no scan. */
    refold() {
        this.foldScalars.value.array.fill(0);
        this.foldScalars.value.needsUpdate = true;
        this.itemBoxes.value.array.set(armedBoxKeys(this.maxItems));
        this.itemBoxes.value.needsUpdate = true;
        this.renderer.compute(this._kResolveX);
        this.renderer.compute(this._kStrides);
        this.renderer.compute(this._kPaginate);
        return this;
    }

    /**
     * The per-item bounds table off the GPU — ONE readback hands every staged field its
     * extent (box lanes from paginate's reduce, scalars from resolveX's). An item no
     * glyph ever reduced (armed keys intact) reports null.
     * @returns {Promise<Array<?{min:{x,y,z}, max:{x,y,z}, totalRows:number, maxRowExtent:number}>>}
     *   one entry per live item, parallel to the setFiles order.
     */
    async readItemBounds() {
        const n = this.itemCount || 0;
        if (n === 0) return [];
        const [boxRaw, wsRaw] = await Promise.all([
            this.renderer.getArrayBufferAsync(this.itemBoxes.value, null, 0, n * 6 * 4),
            this.renderer.getArrayBufferAsync(this.foldScalars.value, null, 0, n * 2 * 4),
        ]);
        const box = new Uint32Array(boxRaw, 0, n * 6);
        const ws = new Uint32Array(wsRaw, 0, n * 2);
        const out = new Array(n);
        for (let i = 0; i < n; i++) {
            const b = i * 6;
            if (box[b] === 0xFFFFFFFF) { out[i] = null; continue; }   // armed — no glyphs
            out[i] = {
                min: { x: orderedKeyToFloat(box[b]), y: orderedKeyToFloat(box[b + 1]), z: orderedKeyToFloat(box[b + 2]) },
                max: { x: orderedKeyToFloat(box[b + 3]), y: orderedKeyToFloat(box[b + 4]), z: orderedKeyToFloat(box[b + 5]) },
                totalRows: ws[i * 2] === 0 ? 0 : orderedKeyToFloat(ws[i * 2]),
                maxRowExtent: ws[i * 2 + 1] === 0 ? 0 : orderedKeyToFloat(ws[i * 2 + 1]),
            };
        }
        return out;
    }

    /** @returns {Promise<Float32Array>} the whole slot buffer — the parity path, not a render path.
     *  The readback is bounded to the LIVE byte range: under the arena the slots buffer is
     *  capacity-sized, so an unbounded readback buffer allocation could fail before a
     *  byte is copied. */
    async readSlots() {
        // Snapshot ONCE: a coalesced flush can land during the readback await and grow
        // byteLength, and a view sized by the post-await value overruns the pre-await
        // readback ("Invalid typed array length" — the byte-field itest race).
        const n = this.byteLength * SLOT_STRIDE;
        const raw = await this.renderer.getArrayBufferAsync(this.slots.value, null, 0, n * Float32Array.BYTES_PER_ELEMENT);
        return new Float32Array(raw, 0, n);
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
        for (const node of this._allNodes()) {
            if (node && attrs) attrs.delete(node.value);
        }
        for (const k of this._allKernels()) k?.dispose();
    }
}

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
 * ── UNVERIFIED ON HARDWARE ─────────────────────────────────────────────────────────────
 * This has never executed. It needs a WebGPU device, and the three things it will decide:
 *   · whether TSL's Loop/Break expresses the walk without falling back to wgslFn
 *   · the coherence WINDOW for this hardware (Apple's answer was ~128; ours is unknown)
 *   · the real per-thread walk cost, which the CPU sim can only guess at
 * Diff it against runPipeline() from the reference on the same bytes. Any mismatch is this
 * file's bug.
 */

import { TSL } from 'three/webgpu';
import {
    SLOT_STRIDE, S_CODEPOINT, S_GLYPH_ID, S_ADVANCE, S_HEIGHT,
    S_X, S_Y, S_Z, S_ROW, S_COL, S_FLAGS,
    F_LEADER, F_RENDERED, F_MISSING, NEWLINE,
} from './glyphPipelineReference.js';
import { BLOCK_SHIFT, BLOCK_MASK, ENTRY_STRIDE, LANE_GLYPH_ID, LANE_ADVANCE, LANE_HEIGHT, LANE_FLAGS, FLAG_MISSING } from './GlyphTrie.js';

const {
    Fn, If, Loop, Break, uniform, instancedArray, instanceIndex,
    int, uint, float, vec3, atomicMin, atomicMax, atomicAdd,
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
    const bits = f.bitcast('uint').toVar('bits');
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
 * The six bounds cells, pre-armed so the first atomic always wins.
 * Layout: [minX, minY, minZ, maxX, maxY, maxZ] as ordered keys.
 */
export function armedBoundsKeys() {
    const a = new Uint32Array(6);
    a[0] = a[1] = a[2] = 0xFFFFFFFF;   // min lanes start at +inf's key
    a[3] = a[4] = a[5] = 0x00000000;   // max lanes start at -inf's key
    return a;
}

export default class GlyphPipelineKernels {
    /**
     * @param {import('three/webgpu').WebGPURenderer} renderer
     * @param {Object} opts
     * @param {number} opts.maxBytes - slot capacity (one slot per byte)
     * @param {{blockIndex:Uint32Array, blocks:Float32Array}} opts.trie
     * @param {number} [opts.maxMisses]
     */
    constructor(renderer, { maxBytes, trie, maxMisses = 4096 }) {
        if (!renderer) throw new Error('GlyphPipelineKernels: a WebGPU renderer is required');
        this.renderer = renderer;
        this.maxBytes = Math.max(1, maxBytes | 0);

        // ── Buffers ────────────────────────────────────────────────────────────────────
        this.byteWords = instancedArray(Math.ceil(this.maxBytes / 4), 'uint').setName('GlyphBytes');
        this.slots = instancedArray(this.maxBytes * SLOT_STRIDE, 'float').setName('GlyphSlots');
        this.trieIndex = instancedArray(trie.blockIndex.length, 'uint').setName('GlyphTrieIndex');
        this.trieBlocks = instancedArray(trie.blocks.length, 'float').setName('GlyphTrieBlocks');
        this.bounds = instancedArray(6, 'uint').setName('GlyphBounds').toAtomic();
        this.misses = instancedArray(maxMisses, 'uint').setName('GlyphMisses');
        this.missCount = instancedArray(1, 'uint').setName('GlyphMissCount').toAtomic();

        this.trieIndex.value.array.set(trie.blockIndex);
        this.trieBlocks.value.array.set(trie.blocks);
        this.trieIndex.value.needsUpdate = true;
        this.trieBlocks.value.needsUpdate = true;
        this.maxMisses = maxMisses;

        // ── Uniforms ───────────────────────────────────────────────────────────────────
        this._u = {
            byteLength:   uniform(0, 'uint'),
            window:       uniform(128, 'int'),
            wrapWidth:    uniform(0, 'int'),
            lineHeight:   uniform(1, 'float'),
            origin:       uniform(vec3(0, 0, 0)),
            // page
            pageRows:     uniform(0, 'int'),
            pageCols:     uniform(0, 'int'),
            colWidth:     uniform(0, 'float'),
            pageStrideX:  uniform(0, 'float'),
            pagesWide:    uniform(1, 'int'),
            depthPerBand: uniform(0, 'float'),
            depthPerCol:  uniform(0, 'float'),
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
        const b = this._byteAt(i).toVar('b');
        const n = int(0).toVar('n');
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
            If(id.greaterThanEqual(u.byteLength), () => { Break(); });

            const n = this._sequenceLength(id).toVar('n');
            If(n.equal(int(0)), () => { Break(); });   // continuation byte — stays a non-leader

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

    /** Nearest leader strictly before `from`, or `from` when none. Bounded by MAX_WALK_STEPS. */
    _leaderBefore(from) {
        const j = from.toVar('lb_j');
        const found = from.toVar('lb_found');
        Loop(MAX_WALK_STEPS, () => {
            If(j.equal(uint(0)), () => { Break(); });
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
        const lane = (slot, l) => S.element(slot.mul(uint(SLOT_STRIDE)).add(uint(l)));

        return Fn(() => {
            const id = instanceIndex;
            If(id.greaterThanEqual(u.byteLength), () => { Break(); });
            const myFlags = int(lane(id, S_FLAGS)).toVar('mf');
            If(myFlags.bitAnd(int(F_LEADER)).equal(int(0)), () => { Break(); });

            const wrap = u.wrapWidth.toVar('wrap');
            const wrapping = wrap.greaterThan(int(0)).toVar('wrapping');

            // ── loop 1: exact integers ──────────────────────────────────────────────────
            const run = int(0).toVar('run');
            const col = int(-1).toVar('col');
            const row = int(0).toVar('row');
            const steps = int(0).toVar('steps');
            const prev = this._leaderBefore(id).toVar('prev');

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
                prev.assign(this._leaderBefore(prev));
                If(prev.equal(cur), () => {          // reached the first leader in the buffer
                    If(col.lessThan(int(0)), () => { col.assign(run); })
                        .Else(() => {
                            row.addAssign(wrapping.select(run.div(wrap).add(int(1)), int(1)));
                        });
                    Break();
                });
            });
            If(col.lessThan(int(0)), () => { col.assign(run); });
            row.addAssign(wrapping.select(col.div(wrap), int(0)));

            // ── loop 2: the advance sum, bounded by wrapWidth ───────────────────────────
            // Now col is known, so the visual row is known to have started exactly
            // (col % wrap) glyphs back. Re-walking rather than inheriting a float is what
            // makes x independent of where the inherit landed.
            const backTo = wrapping.select(col.mod(wrap), col).toVar('backTo');
            const x = float(0).toVar('x');
            const k = int(0).toVar('k');
            const q = this._leaderBefore(id).toVar('q');
            Loop(MAX_WALK_STEPS, () => {
                If(k.greaterThanEqual(backTo).or(q.equal(id)), () => { Break(); });
                If(lane(q, S_CODEPOINT).equal(float(NEWLINE)), () => { Break(); });
                x.addAssign(lane(q, S_ADVANCE));
                k.addAssign(int(1));
                const cur = q.toVar('qcur');
                q.assign(this._leaderBefore(q));
                If(q.equal(cur), () => { Break(); });
            });

            const o = id.mul(uint(SLOT_STRIDE)).toVar('o');
            S.element(o.add(uint(S_X))).assign(x.add(u.origin.x));
            S.element(o.add(uint(S_Y))).assign(row.toFloat().negate().mul(u.lineHeight).add(u.origin.y));
            S.element(o.add(uint(S_Z))).assign(u.origin.z);
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
        const lane = (slot, l) => S.element(slot.mul(uint(SLOT_STRIDE)).add(uint(l)));

        return Fn(() => {
            const id = instanceIndex;
            If(id.greaterThanEqual(u.byteLength), () => { Break(); });
            If(int(lane(id, S_FLAGS)).bitAnd(int(F_LEADER)).equal(int(0)), () => { Break(); });

            const o = id.mul(uint(SLOT_STRIDE)).toVar('o');
            const row = int(lane(id, S_ROW)).toVar('row');
            const col = int(lane(id, S_COL)).toVar('col');
            const x = lane(id, S_X).toVar('x');
            const y = lane(id, S_Y).toVar('y');
            const z = lane(id, S_Z).toVar('z');

            // EVERY page decision reads the integer lanes. Keying this off the float position
            // put 119 glyphs on the wrong page in the reference's own tests, because f32
            // addition is not associative and a boundary row wobbles by a ULP.
            const yPage = int(0).toVar('yPage');
            If(u.pageRows.greaterThan(int(0)), () => {
                yPage.assign(row.div(u.pageRows));
                y.addAssign(yPage.toFloat().mul(u.pageRows.toFloat()).mul(u.lineHeight));
            });
            const xPage = int(0).toVar('xPage');
            If(u.pageCols.greaterThan(int(0)), () => {
                xPage.assign(col.div(u.pageCols));
                x.subAssign(xPage.toFloat().mul(u.pageCols.toFloat()).mul(u.colWidth));
            });
            const wide = u.pagesWide.max(int(1)).toVar('wide');
            x.addAssign(yPage.mod(wide).toFloat().mul(u.pageStrideX));
            z.addAssign(yPage.div(wide).toFloat().mul(u.depthPerBand))
                .addAssign(xPage.toFloat().mul(u.depthPerCol));

            S.element(o.add(uint(S_X))).assign(x);
            S.element(o.add(uint(S_Y))).assign(y);
            S.element(o.add(uint(S_Z))).assign(z);

            // ── bounds, fused ───────────────────────────────────────────────────────────
            const w = lane(id, S_ADVANCE).toVar('w');
            const h = lane(id, S_HEIGHT).toVar('h');
            atomicMin(this.bounds.element(uint(0)), floatToOrderedKey(x));
            atomicMin(this.bounds.element(uint(1)), floatToOrderedKey(y));
            atomicMin(this.bounds.element(uint(2)), floatToOrderedKey(z));
            atomicMax(this.bounds.element(uint(3)), floatToOrderedKey(x.add(w)));
            atomicMax(this.bounds.element(uint(4)), floatToOrderedKey(y.add(h)));
            atomicMax(this.bounds.element(uint(5)), floatToOrderedKey(z));
        })().compute(1).setName('glyphPaginateAndBounds');
    }

    /**
     * Upload a file's bytes and arm the uniforms. Bytes are the ONLY per-load upload.
     * @param {Uint8Array} bytes
     * @param {Object} params - window, wrapWidth, lineHeight, origin, and the page params
     */
    setFile(bytes, params = {}) {
        if (bytes.length > this.maxBytes) {
            throw new Error(`GlyphPipelineKernels: ${bytes.length} bytes exceeds capacity ${this.maxBytes}`);
        }
        this.byteWords.value.array.set(packBytes(bytes));
        this.byteWords.value.needsUpdate = true;
        this.slots.value.array.fill(0);
        this.slots.value.needsUpdate = true;
        this.bounds.value.array.set(armedBoundsKeys());
        this.bounds.value.needsUpdate = true;
        this.missCount.value.array[0] = 0;
        this.missCount.value.needsUpdate = true;

        this.byteLength = bytes.length;
        const u = this._u;
        u.byteLength.value = bytes.length;
        u.window.value = params.window ?? 128;
        u.wrapWidth.value = Math.max(0, Math.trunc(params.wrapWidth || 0));
        u.lineHeight.value = params.lineHeight ?? 1;
        if (params.origin) u.origin.value.set(params.origin.x || 0, params.origin.y || 0, params.origin.z || 0);
        this.setPage(params.page || {});

        const count = Math.max(1, bytes.length);
        this._kDecode.count = count;
        this._kLayout.count = count;
        this._kPaginate.count = count;
        return this;
    }

    /**
     * Retune ONLY the page params. Kernel 3 alone re-runs — the mode switch that costs no
     * decode and no walk.
     */
    setPage(p = {}) {
        const u = this._u;
        u.pageRows.value = Math.max(0, Math.trunc(p.pageRows || 0));
        u.pageCols.value = Math.max(0, Math.trunc(p.pageCols || 0));
        u.colWidth.value = p.colWidth || 0;
        u.pageStrideX.value = p.pageStrideX || 0;
        u.pagesWide.value = Math.max(1, Math.trunc(p.pagesWide || 1));
        u.depthPerBand.value = p.depthPerBand || 0;
        u.depthPerCol.value = p.depthPerColumn || 0;
        return this;
    }

    /** Full load: three dispatches, encoded back to back with no awaits between them. */
    run() {
        this.renderer.compute(this._kDecode);
        this.renderer.compute(this._kLayout);
        this.renderer.compute(this._kPaginate);
        return this;
    }

    /** Page/mode change only — kernel 3 over the positions that already exist. */
    repaginate() {
        this.bounds.value.array.set(armedBoundsKeys());
        this.bounds.value.needsUpdate = true;
        this.renderer.compute(this._kPaginate);
        return this;
    }

    /** @returns {Promise<{min:{x,y,z}, max:{x,y,z}}>} the reduced box, 24 bytes off the GPU. */
    async readBounds() {
        const raw = await this.renderer.getArrayBufferAsync(this.bounds.value);
        const k = new Uint32Array(raw, 0, 6);
        return {
            min: { x: orderedKeyToFloat(k[0]), y: orderedKeyToFloat(k[1]), z: orderedKeyToFloat(k[2]) },
            max: { x: orderedKeyToFloat(k[3]), y: orderedKeyToFloat(k[4]), z: orderedKeyToFloat(k[5]) },
        };
    }

    /** @returns {Promise<Float32Array>} the whole slot buffer — the parity path, not a render path. */
    async readSlots() {
        const raw = await this.renderer.getArrayBufferAsync(this.slots.value);
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
            this.bounds, this.misses, this.missCount]) {
            if (node && attrs) attrs.delete(node.value);
        }
        this._kDecode?.dispose();
        this._kLayout?.dispose();
        this._kPaginate?.dispose();
    }
}

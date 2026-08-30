/**
 * GlyphTrie — codepoint → glyph metrics, as a GPU-indexable two-level trie.
 *
 * The GPU resolves a decoded codepoint to its glyph with two dependent loads and no
 * hashing:
 *
 *     block = blockIndex[cp >> 8]                    // u32[4352], covers all of Unicode
 *     entry = blocks[(block << 8 | (cp & 0xFF)) * 4] // {glyphId, advance, height, flags}
 *
 * BOTH buffers are Uint32Array. The entry mixes two KINDS and the container carries them
 * the way the slot buffer does: glyphId and flags are exact identities/bitfields stored
 * NATIVELY, advance and height are measures stored as BITCAST f32. See ENTRY_STRIDE.
 *
 * This is the standard Unicode property trie (ICU's UTrie2 shape, one level shallower).
 * It replaces hashing the character and matching hashes to atlas slots: no collisions to
 * resolve, no probe loop, no chance two codepoints alias. A miss is a VALUE, not a
 * failure — unmapped codepoints resolve to the shared missing block, whose entries carry
 * FLAG_MISSING, and the kernel appends them to a miss list for the CPU to encode and
 * upload. The layout is correct either way; the glyph is just blank until the atlas
 * catches up.
 *
 * Blocks are deduplicated by content, which is what keeps it small: source code touches a
 * few hundred codepoints spread over a handful of Unicode blocks, so almost every one of
 * the 4352 block slots points at the shared missing block. A full Latin+punctuation+box-
 * drawing+emoji working set lands in tens of KB, uploaded once at boot rather than per
 * grid.
 *
 * Worker-safe: no DOM, no three.
 */

/** Codepoints per block. 256 keeps blockIndex at 4352 entries for the whole 0..0x10FFFF range. */
export const BLOCK_SHIFT = 8;
export const BLOCK_SIZE = 1 << BLOCK_SHIFT;      // 256
export const BLOCK_MASK = BLOCK_SIZE - 1;

/** Number of block slots needed to cover Unicode (0x110000 >> 8). */
export const BLOCK_INDEX_LENGTH = 0x110000 >> BLOCK_SHIFT;   // 4352

/**
 * u32 words per entry: [glyphId, advance, height, flags].
 *
 * glyphId and flags are EXACT (an identity and a bitfield); advance and height are
 * MEASURES. One array keeps the GPU binding to one buffer, so the two kinds share a
 * container — and the container is uint, with the measures bitcast.
 *
 * It used to be a Float32Array with glyphId riding an f32 lane, justified as "glyph ids
 * are well under 2^24, so the integer is exact." That is the argument the ordinal wall
 * died of: exact-in-practice on a float carrier is a bound nobody is checking, and it
 * made S_GLYPH_ID a float lane all the way up the pipeline because the value was copied
 * verbatim from here. flags was worse — a bitfield read with `&` through an f32.
 */
export const ENTRY_STRIDE = 4;

/** Entry lane offsets. EXACT lanes are stored natively; MEASURE lanes are bitcast f32. */
export const LANE_GLYPH_ID = 0;   // exact — identity
export const LANE_ADVANCE = 1;    // measure — bitcast
export const LANE_HEIGHT = 2;     // measure — bitcast
export const LANE_FLAGS = 3;      // exact — bitfield

/** Lanes of an entry that carry a bitcast f32 rather than a native integer. */
export const TRIE_MEASURE_LANES = Object.freeze(new Set([LANE_ADVANCE, LANE_HEIGHT]));

// IEEE reinterpretation, module-local ON PURPOSE. glyphPipelineReference exports the same
// pair, but it IMPORTS this file (trieLookup), so importing back would be circular — and
// this module is deliberately dependency-free and worker-safe. The duplication is two
// three-line primitives that reinterpret bits; unlike a lane-KIND table they cannot drift
// semantically. tools/glyph-pipeline.test.mjs asserts the two agree anyway.
const _f = new Float32Array(1);
const _u = new Uint32Array(_f.buffer);
/** f32 value -> its u32 bit pattern. @param {number} f @returns {number} */
export function trieFbits(f) { _f[0] = f; return _u[0]; }
/** u32 bit pattern -> the f32 it encodes. @param {number} u @returns {number} */
export function trieFval(u) { _u[0] = u >>> 0; return _f[0]; }

/**
 * The VALUE at a flat index into `blocks`, decoded by lane kind — the trie's mirror of
 * laneValue() for the slot buffer.
 *
 * Anything that serializes the trie by VALUE (the fixture corpus carries f64 values so a
 * container change cannot move the bytes) must go through this. Writing the raw words
 * instead re-serializes the measures as their BIT PATTERNS, which is a corpus change
 * wearing the costume of a no-op — it is what the fixture regeneration caught when the
 * container moved.
 *
 * @param {Uint32Array} blocks @param {number} index @returns {number}
 */
export function trieLaneValue(blocks, index) {
    return TRIE_MEASURE_LANES.has(index % ENTRY_STRIDE) ? trieFval(blocks[index]) : blocks[index];
}

/** This codepoint has no atlas entry yet — render blank, report it, keep the layout right. */
export const FLAG_MISSING = 1;

/**
 * Build the trie.
 *
 * @param {Iterable<number>} codepoints - the codepoints to map (e.g. the shape cache's keys)
 * @param {(cp:number) => ({glyphId:number, advance:number, height:number}|null)} resolve
 *   metrics for a codepoint in WORLD units, or null to leave it missing.
 * @param {Object} [opts]
 * @param {number} [opts.missingAdvance] - advance an unmapped codepoint still occupies, so a
 *   file full of un-encoded characters lays out at the right width instead of collapsing.
 * @param {number} [opts.missingHeight]
 * @returns {{blockIndex: Uint32Array, blocks: Uint32Array, blockCount: number,
 *            mapped: number, bytes: number}}
 */
export function buildGlyphTrie(codepoints, resolve, opts = {}) {
    const missingAdvance = opts.missingAdvance ?? 0;
    const missingHeight = opts.missingHeight ?? 0;

    // Block 0 is the shared MISSING block — every unmapped block slot points at it, so the
    // common case (almost all of Unicode) costs one u32 in blockIndex and nothing else.
    const missingBlock = new Uint32Array(BLOCK_SIZE * ENTRY_STRIDE);
    for (let i = 0; i < BLOCK_SIZE; i++) {
        const o = i * ENTRY_STRIDE;
        missingBlock[o + LANE_GLYPH_ID] = 0;                        // exact
        missingBlock[o + LANE_ADVANCE] = trieFbits(missingAdvance); // measure
        missingBlock[o + LANE_HEIGHT] = trieFbits(missingHeight);   // measure
        missingBlock[o + LANE_FLAGS] = FLAG_MISSING;                // exact
    }

    // Group the mapped codepoints by block so each block is built once.
    /** @type {Map<number, number[]>} block number → codepoints in it */
    const byBlock = new Map();
    for (const cp of codepoints) {
        if (!Number.isInteger(cp) || cp < 0 || cp > 0x10FFFF) continue;
        const b = cp >> BLOCK_SHIFT;
        let list = byBlock.get(b);
        if (!list) byBlock.set(b, (list = []));
        list.push(cp);
    }

    const blockIndex = new Uint32Array(BLOCK_INDEX_LENGTH);   // all zero = the missing block
    const built = [missingBlock];
    /** Content-dedup: identical blocks share storage (runs of identical metrics are common). */
    const seen = new Map();
    let mapped = 0;

    for (const [b, cps] of byBlock) {
        const block = new Uint32Array(BLOCK_SIZE * ENTRY_STRIDE);
        block.set(missingBlock);                    // start fully missing, fill what resolves
        let any = false;
        for (const cp of cps) {
            const m = resolve(cp);
            if (!m) continue;
            const o = (cp & BLOCK_MASK) * ENTRY_STRIDE;
            block[o + LANE_GLYPH_ID] = m.glyphId;              // exact — native
            block[o + LANE_ADVANCE] = trieFbits(m.advance);    // measure — bitcast
            block[o + LANE_HEIGHT] = trieFbits(m.height);      // measure — bitcast
            block[o + LANE_FLAGS] = 0;                         // exact — native
            any = true;
            mapped++;
        }
        if (!any) continue;                          // nothing resolved — leave it pointing at missing

        const key = block.join(',');
        let slot = seen.get(key);
        if (slot === undefined) { slot = built.length; built.push(block); seen.set(key, slot); }
        blockIndex[b] = slot;
    }

    const blocks = new Uint32Array(built.length * BLOCK_SIZE * ENTRY_STRIDE);
    for (let i = 0; i < built.length; i++) blocks.set(built[i], i * BLOCK_SIZE * ENTRY_STRIDE);

    return {
        blockIndex,
        blocks,
        blockCount: built.length,
        mapped,
        bytes: blockIndex.byteLength + blocks.byteLength,
    };
}

/**
 * Resolve one codepoint — the exact two-load sequence the shader runs, for CPU-side
 * reference and tests. Never diverge these: this IS the shader body in JS.
 *
 * @param {{blockIndex: Uint32Array, blocks: Uint32Array}} trie
 * @param {number} cp
 * @returns {{glyphId:number, advance:number, height:number, missing:boolean}}
 */
export function trieLookup(trie, cp) {
    const block = trie.blockIndex[cp >> BLOCK_SHIFT];
    const o = ((block << BLOCK_SHIFT) | (cp & BLOCK_MASK)) * ENTRY_STRIDE;
    return {
        glyphId: trie.blocks[o + LANE_GLYPH_ID],                 // exact — native u32
        advance: trieFval(trie.blocks[o + LANE_ADVANCE]),        // measure — bitcast
        height: trieFval(trie.blocks[o + LANE_HEIGHT]),          // measure — bitcast
        // A BITFIELD, and now genuinely one: `&` on the raw word rather than on an f32
        // that JS coerced to int32 first.
        missing: (trie.blocks[o + LANE_FLAGS] & FLAG_MISSING) !== 0,
    };
}

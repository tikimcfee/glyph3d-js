/**
 * GlyphTrie — codepoint → glyph metrics, as a GPU-indexable two-level trie.
 *
 * The GPU resolves a decoded codepoint to its glyph with two dependent loads and no
 * hashing:
 *
 *     block = blockIndex[cp >> 8]                          // u32[4352], all of Unicode
 *     entry = { blocksExact[e * 2 + ...], blocksMeasure[e * 2 + ...] }
 *
 * The entry is SPLIT BY CARRIER: glyphId and flags are exact (identity, bitfield) and
 * live in a Uint32Array; advance and height are measures and live in a Float32Array.
 * There are no bitcasts and no lane-kind table, because the array a lane lives in IS
 * its kind.
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
 * Entry lanes, SPLIT BY CARRIER — two arrays, one kind each.
 *
 * It was one Uint32Array of four lanes with advance/height bitcast, and before that a
 * Float32Array with glyphId riding an f32 lane, justified as "glyph ids are well under
 * 2^24, so the integer is exact." That is the argument the ordinal wall died of, and it
 * propagated: the slot buffer's GLYPH_ID was a float lane only because decode copied it
 * verbatim from here. A container's mistake travels to everything it feeds.
 */
export const TRIE_EXACT_STRIDE = 2;
export const TE_GLYPH_ID = 0;     // identity
export const TE_FLAGS = 1;        // bitfield

export const TRIE_MEASURE_STRIDE = 2;
export const TM_ADVANCE = 0;
export const TM_HEIGHT = 1;

/** Logical lanes per entry, in FIXTURE/WIRE order: [glyphId, advance, height, flags].
 *  The corpus carries VALUES in this order so a container change cannot move its bytes;
 *  `trieWireValue` is the one place that mapping lives. */
export const ENTRY_LANES = 4;

/**
 * The entry's `i`th lane in WIRE order, as a VALUE.
 *
 * Anything that serializes the trie must go through this. Writing raw words instead
 * re-serialized the measures as BIT PATTERNS — a corpus change wearing the costume of a
 * no-op, which is exactly what the fixture regeneration caught when the container last
 * moved. Now that the measures live in an f32 array there are no bit patterns to leak,
 * but the wire ORDER still has to come from one place.
 *
 * @param {{blocksExact:Uint32Array, blocksMeasure:Float32Array}} trie
 * @param {number} i flat wire index (entry * ENTRY_LANES + lane)
 * @returns {number}
 */
export function trieWireValue(trie, i) {
    const e = (i / ENTRY_LANES) | 0, lane = i % ENTRY_LANES;
    switch (lane) {
        case 0: return trie.blocksExact[e * TRIE_EXACT_STRIDE + TE_GLYPH_ID];
        case 1: return trie.blocksMeasure[e * TRIE_MEASURE_STRIDE + TM_ADVANCE];
        case 2: return trie.blocksMeasure[e * TRIE_MEASURE_STRIDE + TM_HEIGHT];
        default: return trie.blocksExact[e * TRIE_EXACT_STRIDE + TE_FLAGS];
    }
}

/** Wire-order lane count for a built trie (what the fixture header records). */
export function trieWireLength(trie) {
    return (trie.blocksExact.length / TRIE_EXACT_STRIDE) * ENTRY_LANES;
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
 * @returns {{blockIndex: Uint32Array, blocksExact: Uint32Array,
 *            blocksMeasure: Float32Array, blockCount: number, mapped: number, bytes: number}}
 */
export function buildGlyphTrie(codepoints, resolve, opts = {}) {
    const missingAdvance = opts.missingAdvance ?? 0;
    const missingHeight = opts.missingHeight ?? 0;

    // Block 0 is the shared MISSING block — every unmapped block slot points at it, so the
    // common case (almost all of Unicode) costs one u32 in blockIndex and nothing else.
    const missingExact = new Uint32Array(BLOCK_SIZE * TRIE_EXACT_STRIDE);
    const missingMeasure = new Float32Array(BLOCK_SIZE * TRIE_MEASURE_STRIDE);
    for (let i = 0; i < BLOCK_SIZE; i++) {
        missingExact[i * TRIE_EXACT_STRIDE + TE_GLYPH_ID] = 0;
        missingExact[i * TRIE_EXACT_STRIDE + TE_FLAGS] = FLAG_MISSING;
        missingMeasure[i * TRIE_MEASURE_STRIDE + TM_ADVANCE] = missingAdvance;
        missingMeasure[i * TRIE_MEASURE_STRIDE + TM_HEIGHT] = missingHeight;
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
    const built = [{ e: missingExact, m: missingMeasure }];
    /** Content-dedup: identical blocks share storage (runs of identical metrics are common).
     *  The key spans BOTH arrays — two blocks agreeing on ids and flags but differing in
     *  advance are different blocks, and a key built from one array alone would merge them. */
    const seen = new Map();
    let mapped = 0;

    for (const [b, cps] of byBlock) {
        const e = new Uint32Array(missingExact);       // start fully missing, fill what resolves
        const m = new Float32Array(missingMeasure);
        let any = false;
        for (const cp of cps) {
            const g = resolve(cp);
            if (!g) continue;
            const eo = (cp & BLOCK_MASK) * TRIE_EXACT_STRIDE;
            const mo = (cp & BLOCK_MASK) * TRIE_MEASURE_STRIDE;
            e[eo + TE_GLYPH_ID] = g.glyphId;
            e[eo + TE_FLAGS] = 0;
            m[mo + TM_ADVANCE] = g.advance;
            m[mo + TM_HEIGHT] = g.height;
            any = true;
            mapped++;
        }
        if (!any) continue;                          // nothing resolved — leave it pointing at missing

        const key = `${e.join(',')}|${m.join(',')}`;
        let slot = seen.get(key);
        if (slot === undefined) { slot = built.length; built.push({ e, m }); seen.set(key, slot); }
        blockIndex[b] = slot;
    }

    const blocksExact = new Uint32Array(built.length * BLOCK_SIZE * TRIE_EXACT_STRIDE);
    const blocksMeasure = new Float32Array(built.length * BLOCK_SIZE * TRIE_MEASURE_STRIDE);
    for (let i = 0; i < built.length; i++) {
        blocksExact.set(built[i].e, i * BLOCK_SIZE * TRIE_EXACT_STRIDE);
        blocksMeasure.set(built[i].m, i * BLOCK_SIZE * TRIE_MEASURE_STRIDE);
    }

    return {
        blockIndex,
        blocksExact,
        blocksMeasure,
        blockCount: built.length,
        mapped,
        bytes: blockIndex.byteLength + blocksExact.byteLength + blocksMeasure.byteLength,
    };
}

/**
 * Resolve one codepoint — the exact two-load sequence the shader runs, for CPU-side
 * reference and tests. Never diverge these: this IS the shader body in JS.
 *
 * @param {{blockIndex:Uint32Array, blocksExact:Uint32Array, blocksMeasure:Float32Array}} trie
 * @param {number} cp
 * @returns {{glyphId:number, advance:number, height:number, missing:boolean}}
 */
export function trieLookup(trie, cp) {
    const block = trie.blockIndex[cp >> BLOCK_SHIFT];
    const entry = (block << BLOCK_SHIFT) | (cp & BLOCK_MASK);
    const eo = entry * TRIE_EXACT_STRIDE, mo = entry * TRIE_MEASURE_STRIDE;
    return {
        glyphId: trie.blocksExact[eo + TE_GLYPH_ID],
        advance: trie.blocksMeasure[mo + TM_ADVANCE],
        height: trie.blocksMeasure[mo + TM_HEIGHT],
        // A real bitfield test on a real integer lane.
        missing: (trie.blocksExact[eo + TE_FLAGS] & FLAG_MISSING) !== 0,
    };
}


/**
 * GlyphTrie — codepoint → glyph metrics, as a GPU-indexable two-level trie.
 *
 * The GPU resolves a decoded codepoint to its glyph with two dependent loads and no
 * hashing:
 *
 *     block = blockIndex[cp >> 8]                    // u32[4352], covers all of Unicode
 *     entry = blocks[(block << 8 | (cp & 0xFF)) * 4] // {glyphId, advance, height, flags}
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
 * Floats per entry: [glyphId, advance, height, flags].
 * glyphId rides an f32 lane — glyph ids are well under 2^24, so the integer is exact, and
 * a single array keeps the GPU binding to one buffer instead of two.
 */
export const ENTRY_STRIDE = 4;

/** Entry lane offsets. */
export const LANE_GLYPH_ID = 0;
export const LANE_ADVANCE = 1;
export const LANE_HEIGHT = 2;
export const LANE_FLAGS = 3;

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
 * @returns {{blockIndex: Uint32Array, blocks: Float32Array, blockCount: number,
 *            mapped: number, bytes: number}}
 */
export function buildGlyphTrie(codepoints, resolve, opts = {}) {
    const missingAdvance = opts.missingAdvance ?? 0;
    const missingHeight = opts.missingHeight ?? 0;

    // Block 0 is the shared MISSING block — every unmapped block slot points at it, so the
    // common case (almost all of Unicode) costs one u32 in blockIndex and nothing else.
    const missingBlock = new Float32Array(BLOCK_SIZE * ENTRY_STRIDE);
    for (let i = 0; i < BLOCK_SIZE; i++) {
        const o = i * ENTRY_STRIDE;
        missingBlock[o + LANE_GLYPH_ID] = 0;
        missingBlock[o + LANE_ADVANCE] = missingAdvance;
        missingBlock[o + LANE_HEIGHT] = missingHeight;
        missingBlock[o + LANE_FLAGS] = FLAG_MISSING;
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
        const block = new Float32Array(BLOCK_SIZE * ENTRY_STRIDE);
        block.set(missingBlock);                    // start fully missing, fill what resolves
        let any = false;
        for (const cp of cps) {
            const m = resolve(cp);
            if (!m) continue;
            const o = (cp & BLOCK_MASK) * ENTRY_STRIDE;
            block[o + LANE_GLYPH_ID] = m.glyphId;
            block[o + LANE_ADVANCE] = m.advance;
            block[o + LANE_HEIGHT] = m.height;
            block[o + LANE_FLAGS] = 0;
            any = true;
            mapped++;
        }
        if (!any) continue;                          // nothing resolved — leave it pointing at missing

        const key = block.join(',');
        let slot = seen.get(key);
        if (slot === undefined) { slot = built.length; built.push(block); seen.set(key, slot); }
        blockIndex[b] = slot;
    }

    const blocks = new Float32Array(built.length * BLOCK_SIZE * ENTRY_STRIDE);
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
 * @param {{blockIndex: Uint32Array, blocks: Float32Array}} trie
 * @param {number} cp
 * @returns {{glyphId:number, advance:number, height:number, missing:boolean}}
 */
export function trieLookup(trie, cp) {
    const block = trie.blockIndex[cp >> BLOCK_SHIFT];
    const o = ((block << BLOCK_SHIFT) | (cp & BLOCK_MASK)) * ENTRY_STRIDE;
    return {
        glyphId: trie.blocks[o + LANE_GLYPH_ID],
        advance: trie.blocks[o + LANE_ADVANCE],
        height: trie.blocks[o + LANE_HEIGHT],
        missing: (trie.blocks[o + LANE_FLAGS] & FLAG_MISSING) !== 0,
    };
}

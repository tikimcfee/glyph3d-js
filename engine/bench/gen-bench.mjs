/**
 * gen-bench.mjs — build the benchmark input: every .js file under packages/
 * concatenated into one corpus (~2.4MB of real source), plus the trie over its
 * codepoints, as one binary both benches load.
 *
 * Format 'G3DX' (little-endian): u32 magic, u32 byteLen, u32 blockIndexLen,
 * u32 blocksFloatLen, bytes, blockIndex, blocks.
 *
 * Run: bun engine/bench/gen-bench.mjs   (writes engine/bench/bench.bin, gitignored)
 */
import { writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGlyphTrie } from '../../packages/glyph3d-core/src/compute/GlyphTrie.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');

function collect(dir, out) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) collect(p, out);
        else if (name.endsWith('.js')) out.push(readFileSync(p));
    }
    return out;
}
const chunks = collect(join(ROOT, 'packages'), []);
const total = chunks.reduce((n, c) => n + c.length, 0);
const bytes = new Uint8Array(total);
let at = 0;
for (const c of chunks) { bytes.set(c, at); at += c.length; }

const cps = new Set();
for (const ch of new TextDecoder('utf-8', { fatal: false }).decode(bytes)) {
    cps.add(ch.codePointAt(0));
}
cps.delete(0xFFFD);
const trie = buildGlyphTrie(cps, (cp) => ({
    glyphId: (cp % 4093) + 1,
    advance: Math.fround(0.6 + (cp % 13) * 0.0173),
    height: Math.fround(1.2 + (cp % 7) * 0.031),
}), { missingAdvance: Math.fround(0.61), missingHeight: Math.fround(1.25) });

const head = new DataView(new ArrayBuffer(16));
head.setUint32(0, 0x58443347, true);
head.setUint32(4, bytes.length, true);
head.setUint32(8, trie.blockIndex.length, true);
head.setUint32(12, trie.blocks.length, true);
const out = new Uint8Array(16 + bytes.length + trie.blockIndex.byteLength + trie.blocks.byteLength);
out.set(new Uint8Array(head.buffer), 0);
out.set(bytes, 16);
out.set(new Uint8Array(trie.blockIndex.buffer), 16 + bytes.length);
out.set(new Uint8Array(trie.blocks.buffer), 16 + bytes.length + trie.blockIndex.byteLength);
writeFileSync(join(HERE, 'bench.bin'), out);
console.log(`bench.bin: ${bytes.length} corpus bytes, ${trie.blockCount} trie blocks`);

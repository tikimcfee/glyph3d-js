/**
 * bench.mjs — the JS oracle's side of the ledger. Same corpus, same trie, same
 * work as bench.mojo: bakeFile + runPipeline + runScanPipeline over the corpus.
 * Checksums printed so the work can't be dead-code-eliminated, and to cross-check
 * that both benches computed the same thing.
 *
 * Run: bun engine/bench/bench.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bakeFile } from '../../packages/glyph3d-core/src/compute/glyphBake.js';
import { runPipeline, eBase, E_ROW } from '../../packages/glyph3d-core/src/compute/glyphPipelineReference.js';
import { runScanPipeline } from '../../packages/glyph3d-core/src/compute/glyphPipelineScan.js';

// Probe a NAMED lane of a named byte. The old checksum sampled slots[12345] — a
// raw flat index, silently coupled to a 12-lane stride, which stopped meaning the
// same thing the moment the buffers split. ROW is a count: exact in both languages
// regardless of how either one lays its buffers out.
const PROBE_BYTE = 1028;

const HERE = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(HERE, 'bench.bin'));
const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
// 'G3DY' — v2, split-carrier trie. The magic changed WITH the format on purpose: this
// reader was already stale before the split (it viewed the trie blocks as a Float32Array
// while the generator wrote a Uint32Array with the measures bitcast, so every exact lane
// came back as a denormal), and nothing failed because a raw byte view will accept any
// bytes offered. A magic that moves with the layout is what turns that into an error.
if (dv.getUint32(0, true) !== 0x59443347) {
    throw new Error('bad or stale bench.bin — expected G3DY (split-carrier trie); '
        + 'regenerate with: bun engine/bench/gen-bench.mjs');
}
const byteLen = dv.getUint32(4, true);
const blockIndexLen = dv.getUint32(8, true);
const exactLen = dv.getUint32(12, true);
const measureLen = dv.getUint32(16, true);
const H = 20;
const bytes = new Uint8Array(raw.buffer, raw.byteOffset + H, byteLen);
let off = raw.byteOffset + H + byteLen;
const blockIndex = new Uint32Array(raw.buffer.slice(off, off + blockIndexLen * 4));
off += blockIndexLen * 4;
const blocksExact = new Uint32Array(raw.buffer.slice(off, off + exactLen * 4));
off += exactLen * 4;
const blocksMeasure = new Float32Array(raw.buffer.slice(off, off + measureLen * 4));
const trie = { blockIndex, blocksExact, blocksMeasure };

const MB = byteLen / (1024 * 1024);
const REPS = 5;

function bench(name, fn) {
    fn(); // warm
    let best = Infinity, sum = 0;
    for (let r = 0; r < REPS; r++) {
        const t0 = performance.now();
        sum += fn();
        const dt = performance.now() - t0;
        if (dt < best) best = dt;
    }
    console.log(`${name}: best ${best.toFixed(1)} ms  (${(MB / (best / 1000)).toFixed(1)} MB/s)  checksum ${sum}`);
}

bench('bake      (js/bun)', () => {
    const r = bakeFile(bytes, trie, { lineHeight: 1.0 });
    return r.leaders + r.newlines + r.checkpoints.length;
});
bench('pipeline  (js/bun)', () => {
    const r = runPipeline(bytes, trie, { origin: { x: 0, y: 0, z: 0 }, lineHeight: 1.0, wrapWidth: 100 });
    return r.leaders + (r.slots.x[eBase(PROBE_BYTE) + E_ROW] | 0);
});
bench('scan      (js/bun)', () => {
    const r = runScanPipeline(bytes, trie, { origin: { x: 0, y: 0, z: 0 }, lineHeight: 1.0, wrapWidth: 100 });
    return r.leaders + (r.slots.x[eBase(PROBE_BYTE) + E_ROW] | 0);
});

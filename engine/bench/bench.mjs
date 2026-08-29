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
import { runPipeline, SLOT_STRIDE, S_ROW } from '../../packages/glyph3d-core/src/compute/glyphPipelineReference.js';
import { runScanPipeline } from '../../packages/glyph3d-core/src/compute/glyphPipelineScan.js';

// Probe a NAMED lane of a named byte. The old checksum sampled slots[12345] — a
// raw flat index, silently coupled to a 12-lane stride, which stopped meaning the
// same thing the moment the buffers split. ROW is a count: exact in both languages
// regardless of how either one lays its buffers out.
const PROBE_BYTE = 1028;

const HERE = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(HERE, 'bench.bin'));
const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
if (dv.getUint32(0, true) !== 0x58443347) throw new Error('bad bench.bin');
const byteLen = dv.getUint32(4, true);
const blockIndexLen = dv.getUint32(8, true);
const blocksLen = dv.getUint32(12, true);
const bytes = new Uint8Array(raw.buffer, raw.byteOffset + 16, byteLen);
const blockIndex = new Uint32Array(raw.buffer.slice(raw.byteOffset + 16 + byteLen, raw.byteOffset + 16 + byteLen + blockIndexLen * 4));
const blocks = new Float32Array(raw.buffer.slice(raw.byteOffset + 16 + byteLen + blockIndexLen * 4, raw.byteOffset + 16 + byteLen + blockIndexLen * 4 + blocksLen * 4));
const trie = { blockIndex, blocks };

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
    return r.leaders + (r.slots[PROBE_BYTE * SLOT_STRIDE + S_ROW] | 0);
});
bench('scan      (js/bun)', () => {
    const r = runScanPipeline(bytes, trie, { origin: { x: 0, y: 0, z: 0 }, lineHeight: 1.0, wrapWidth: 100 });
    return r.leaders + (r.slots[PROBE_BYTE * SLOT_STRIDE + S_ROW] | 0);
});

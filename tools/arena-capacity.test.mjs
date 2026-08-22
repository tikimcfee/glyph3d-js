// arena-capacity.test.mjs — the arena's CEILING, and the seams around it.
//
//   bun tools/arena-capacity.test.mjs
//
// Every other test in this tree runs a SMALL arena. They prove values survive the
// pipeline; none of them exercise capacity at all. That gap is why a half-landed
// ceiling raise once passed the entire suite, all four GPU gates, and a byte-identical
// fixture corpus, while leaving the arena wedged past 16MB: the arena advertised a
// ceiling the kernels still refused, and stage() leaked its allocation into the gap.
//
// So this file asserts the things capacity is made of, without needing a GPU:
//   - ONE constant. The arena's ceiling and the kernels' guard are the same value,
//     imported, not two copies that can drift.
//   - The guard actually fires, at the boundary, in both directions.
//   - A growth failure RETURNS its range. A refusal that keeps the bytes poisons the
//     watermark permanently and every later stage re-enters the same throw.
//   - The device-limit seam refuses loudly and names the request, and stays advisory
//     when limits are unreachable.

import GlyphPipelineArena from '../packages/glyph3d-core/src/compute/GlyphPipelineArena.js';
import GlyphPipelineKernels, {
    KERNEL_MAX_BYTES, SLOT_BYTES_PER_SOURCE_BYTE, assertSlotBufferFits,
} from '../packages/glyph3d-core/src/compute/glyphPipelineKernels.js';
import { SLOT_STRIDE } from '../packages/glyph3d-core/src/compute/glyphPipelineReference.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error(`  ✗ ${m}`); } };
const threw = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

console.log('one constant, not two');
{
    ok(SLOT_BYTES_PER_SOURCE_BYTE === SLOT_STRIDE * 4,
       `a source byte costs SLOT_STRIDE x 4 = ${SLOT_STRIDE * 4}B of slot (got ${SLOT_BYTES_PER_SOURCE_BYTE})`);
    // The arena imports the kernels' ceiling. If someone re-states it, this is the
    // test that notices — the drift that shipped a wedged arena was exactly this.
    const src = await Bun.file('packages/glyph3d-core/src/compute/GlyphPipelineArena.js').text();
    ok(/ORDINAL_EXACT_BYTES\s*=\s*KERNEL_MAX_BYTES/.test(src),
       'the arena DERIVES its ceiling from KERNEL_MAX_BYTES rather than restating a number');
    ok(!/ORDINAL_EXACT_BYTES\s*=\s*2\s*\*\*/.test(src),
       'the arena does not hardcode a power of two for its ceiling');
}

console.log('the kernels guard fires at the boundary');
{
    // A bare shell: the guard runs before anything touches the GPU.
    const construct = (maxBytes) => threw(() => new GlyphPipelineKernels(
        { backend: {} },
        { maxBytes, maxItems: 16, trie: { blockIndex: new Uint32Array(1), blocks: new Float32Array(1) } },
    ));
    const atCeiling = construct(KERNEL_MAX_BYTES);
    ok(!/exceeds KERNEL_MAX_BYTES/.test(atCeiling || ''), 'exactly at the ceiling is not refused by the ceiling guard');
    const over = construct(KERNEL_MAX_BYTES + 1);
    ok(/exceeds KERNEL_MAX_BYTES/.test(over || ''), 'one past the ceiling IS refused');
    ok((over || '').includes(String(KERNEL_MAX_BYTES)), 'the refusal names the limit it enforced');
}

console.log('a growth failure gives the range back');
{
    // stage() calls _alloc (which mutates the watermark) BEFORE growth. If growth
    // throws and the range is not returned, the arena is permanently poisoned.
    const a = Object.create(GlyphPipelineArena.prototype);
    a.maxItems = 1024; a.maxBytes = 64; a._liveCount = 0; a._items = [];
    a._free = []; a._byteTotal = 0; a._tableDirty = false; a._stagedSinceFlush = 0;
    a._realloc = () => { throw new Error('simulated device OOM during growth'); };

    const before = a._byteTotal;
    const msg = threw(() => a.stage({ bytes: new Uint8Array(4096), origin: { x: 0, y: 0, z: 0 } }));
    ok(/simulated device OOM/.test(msg || ''), `the growth failure propagates (got: ${String(msg).slice(0, 60)})`);
    const freed = a._free.reduce((s, r) => s + r.length, 0);
    const live = a._byteTotal - freed;
    ok(live === before,
       `the failed stage owns no bytes afterwards (live ${live}, was ${before}, watermark ${a._byteTotal}, freed ${freed})`);
    ok(a._liveCount === 0, 'no item was registered for the failed stage');
}

console.log('the device-limit seam');
{
    const dev = (limit) => ({ backend: { device: { limits: { maxStorageBufferBindingSize: limit } } } });
    const want = 1000 * SLOT_BYTES_PER_SOURCE_BYTE;

    ok(threw(() => assertSlotBufferFits(dev(want), 1000)) === null,
       'a buffer that exactly fits the limit is allowed');
    const over = threw(() => assertSlotBufferFits(dev(want - 1), 1000));
    ok(over !== null, 'a buffer past the limit is refused');
    ok(/maxStorageBufferBindingSize/.test(over || ''), 'the refusal names the limit that was exceeded');
    ok(/1000/.test(over || ''), 'the refusal names the request that was refused');

    // Advisory when unreachable: a missing limit must not block a run that would work.
    ok(threw(() => assertSlotBufferFits({}, 1e9)) === null, 'no device -> advisory, not fatal');
    ok(threw(() => assertSlotBufferFits({ backend: { device: { limits: {} } } }, 1e9)) === null,
       'no limit reported -> advisory, not fatal');
}

console.log(`\n${fail === 0 ? '✓' : '✗'} arena-capacity: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

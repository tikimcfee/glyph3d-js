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
    KERNEL_MAX_BYTES, ARENA_MAX_BYTES, REQUESTED_BINDING_CAP,
    SLOT_BYTES_PER_SOURCE_BYTE, assertSlotBufferFits,
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
    ok(/ORDINAL_EXACT_BYTES\s*=\s*ARENA_MAX_BYTES/.test(src),
       'the arena DERIVES its ceiling from ARENA_MAX_BYTES rather than restating a number');
    ok(!/ORDINAL_EXACT_BYTES\s*=\s*2\s*\*\*/.test(src),
       'the arena does not hardcode a power of two for its ceiling');

    // ASSERT THE VALUE, not just its provenance. Every tooth below is stated RELATIVE
    // to the constant (construct(CEILING + 1) and so on), which means a straight revert
    // of the constant — the headline change of the whole migration — stayed green across
    // all 48 test files. Reviewed and caught by executing that exact mutation. A test
    // that only checks a number is used, never what it is, does not protect the number.
    ok(ARENA_MAX_BYTES === Math.floor(REQUESTED_BINDING_CAP / SLOT_BYTES_PER_SOURCE_BYTE),
       `ARENA_MAX_BYTES is the binding cap over the per-byte cost (got ${ARENA_MAX_BYTES})`);
    ok(ARENA_MAX_BYTES === 44739242, `ARENA_MAX_BYTES is 44,739,242 (got ${ARENA_MAX_BYTES})`);
    ok(ARENA_MAX_BYTES > 2 ** 24,
       `the f32 wall is actually GONE: ${ARENA_MAX_BYTES} > ${2 ** 24} (a revert lands here)`);
    ok(KERNEL_MAX_BYTES === Math.floor(2 ** 32 / SLOT_STRIDE),
       `KERNEL_MAX_BYTES is the u32 index wall (got ${KERNEL_MAX_BYTES})`);

    // The two are DIFFERENT things, and conflating them is what put a 341MB ceiling in
    // front of an arena that OOMs on the host mirror past ~64MB of source.
    ok(ARENA_MAX_BYTES < KERNEL_MAX_BYTES,
       'what can be BUILT is strictly under what can be ADDRESSED');
}

console.log('the kernels guard fires at the boundary');
{
    // A bare shell: the guard runs before anything touches the GPU.
    const construct = (maxBytes) => threw(() => new GlyphPipelineKernels(
        { backend: {} },
        { maxBytes, maxItems: 16, trie: { blockIndex: new Uint32Array(1), blocks: new Float32Array(1) } },
    ));
    // Assert construction SUCCEEDS, not merely that it failed for some other reason.
    // The previous form checked !/exceeds KERNEL_MAX_BYTES/ against the message, so a
    // construction that died of host OOM read as a pass — vacuously green, and it was:
    // KERNEL_MAX_BYTES needs a ~16GB host mirror and throws every time.
    ok(construct(ARENA_MAX_BYTES) === null, 'the arena ceiling can actually be CONSTRUCTED');
    const over = construct(KERNEL_MAX_BYTES + 1);
    ok(/exceeds KERNEL_MAX_BYTES/.test(over || ''), 'one past the index wall IS refused');
    ok((over || '').includes(String(KERNEL_MAX_BYTES)), 'the refusal names the limit it enforced');

    // The host mirror is the real wall between the two constants. It must name itself.
    const huge = construct(KERNEL_MAX_BYTES);
    ok(huge !== null, 'the index wall is not actually allocatable');
    ok(/slot buffer/.test(huge || ''), `an unbuildable arena says so in glyph terms (got: ${String(huge).slice(0, 70)})`);
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

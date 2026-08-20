# engine — the native pipeline (Mojo)

The fourth layer of the pipeline contract, per `docs/plans/glyph3d-native-engine.md`:

```
oracle (JS)  →  scan spec (JS)  →  TSL kernels (WebGPU)  →  glyph_pipeline.mojo (native)
  semantics       algorithm            browser GPU             any silicon
```

`glyph_pipeline.mojo` is a native transcription of `glyphPipelineReference.js` — the
byte-in glyph pipeline (decode → trie resolve → fold → paginate → bounds) with the
oracle's exact float discipline: f32 slot lanes rounded once per store, f64 `lineAdv`,
f32-per-add `segAdv`, integer row/col for every discrete decision. It is proven
**bit-for-bit** against the oracle, not to a tolerance — a tolerance would hide
exactly the grouping-dependent float drift the layered contract exists to prevent.

The per-slot kernels are already thread-shaped (`id` is the thread id) and the fold is
the serial form of the monoid scan (`glyphPipelineScan.js`), so a GPU backend replaces
the driver loops, not the kernels. This is M0 of the milestone ladder; M1 (the
headless frame: bytes → native curve cache → compute raster → PNG) builds on it.

## Conformance

Fixtures are the oracle's own answers, serialized:

```sh
bun engine/fixtures/gen.mjs        # regenerate *.pipe.bin (pipeline cases)
bun engine/fixtures/gen-bake.mjs   # regenerate *.bake.bin (bake + seed queries)
mojo run -I engine engine/conformance.mojo      engine/fixtures/*.pipe.bin
mojo run -I engine engine/conformance_scan.mojo engine/fixtures/*.pipe.bin
mojo run -I engine engine/conformance_bake.mojo engine/fixtures/*.bake.bin
```

Every f32 lane is compared as a u32 bit pattern, every f64 bounds lane as u64.
The corpus hits the documented cliffs: emoji double-advance, exact-multiple wrap
rows, page/band/depth fans, the scroll conveyor, malformed UTF-8, a leaderless item,
a 5K-glyph foldless line (the f64-prefix case), a real repo file, and a multi-item
arena. Mutation-tested: a 1-ULP perturbation of `segAdv` fails 2 fixtures loudly.

Regenerate fixtures whenever the oracle changes; the fixture formats are documented
in `fixtures/gen.mjs` and `fixtures/gen-bake.mjs`.

## The scan (the GPU's skeleton)

`glyph_scan.mojo` ports `runScanPipeline` — the same answers computed in the GPU's
dispatch structure (chunkReduce → spineReduce → spineScan → partialScan → apply →
resolveX → paginate → bounds), serially, loop-for-dispatch. Each loop body is one
thread's work; the GPU backend lifts the loops, not the bodies. Proven over the SAME
`.pipe.bin` fixtures under the repo's own tiered contract
(`tools/scan-layout.test.mjs`): exact lanes and fold>0 float lanes bit-equal, foldless
float lanes ≤ 1e-4 relative (serial f64 prefix vs the scan's f32 grouping — differs by
construction), at the default tuning and at K=7/G=3, which puts chunk seams inside
multi-byte sequences and fold units. `resolve_x` (the gather-free x kernel) lives in
`glyph_pipeline.mojo` with the other reference kernels.

## The bake (the seed format)

`glyph_bake.mojo` ports `glyphBake.js` plus the scan monoid it rides
(`scanIdentity` / `scanLeafValue` / `scanCombine` / `lanesFromPrefix` from
`glyphPipelineScan.js`) — the streaming fold that emits everything layout can know
about a file before the GPU sees it: the total monoid summary, checkpoint records
(random access into a layout never materialized), the intrinsic scalars and exact
wrap-0 box, the line histogram (`rows_under_wrap` answers ANY wrap from it), and the
codepoint census. This is the seed format of the state split: bytes + trie + this
record is what a client consumes to materialize layout locally. The bake suite also
proves the query side — checkpoint-seeded `prefix_at` at boundaries ±1 and
`lanes_from_prefix` across wraps — so seed-and-fold agrees with the streaming pass
bit-for-bit. Mutation-tested the same way (a 5e-8 nudge in `scan_combine`'s tailAdv
fails checkpoints, scalars, and box loudly).

## Toolchain

Mojo ≥ 1.0 (`pip install modular` provides `mojo`). CPU-only — no GPU required for
conformance; that is the point of the serial layer.

## Not ported yet

- The far-texture LOD oracles (`farScatterOracle` / `farNormalizeOracle`).
- The GPU backend itself: lift glyph_scan's loops onto device threads (needs GPU
  hardware; every kernel body is already in place).

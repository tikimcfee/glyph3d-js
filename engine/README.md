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
bun engine/fixtures/gen.mjs                                    # regenerate *.bin
mojo run -I engine engine/conformance.mojo engine/fixtures/*.bin
```

Every f32 lane is compared as a u32 bit pattern, every f64 bounds lane as u64.
The corpus hits the documented cliffs: emoji double-advance, exact-multiple wrap
rows, page/band/depth fans, the scroll conveyor, malformed UTF-8, a leaderless item,
a 5K-glyph foldless line (the f64-prefix case), a real repo file, and a multi-item
arena. Mutation-tested: a 1-ULP perturbation of `segAdv` fails 2 fixtures loudly.

Regenerate fixtures whenever the oracle changes; the fixture format is documented in
`fixtures/gen.mjs`.

## Toolchain

Mojo ≥ 1.0 (`pip install modular` provides `mojo`). CPU-only — no GPU required for
conformance; that is the point of the serial layer.

## Not ported yet

- `resolveX` (the gather-free x kernel) — arrives with the scan/GPU backend, which is
  its reason to exist; the serial fold computes the same lanes here.
- The far-texture LOD oracles (`farScatterOracle` / `farNormalizeOracle`).
- `glyphBake` (checkpoints / census / line histogram) — next after M0: same fold,
  streaming form, and the seed format the state split ships to clients.

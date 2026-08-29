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

## Two buffers, and where a value lives IS what kind it is

`schema/glyph-identity.json` is the single source of truth; `bun tools/gen-schema.mjs`
generates `engine/glyph_schema.mojo` and the JS twin. Hand-editing either is pointless —
the next run overwrites it.

**KIND is the declared fact; CONTAINER is a per-layer realization.** A `count` /
`identity` / `bitfield` is exact and must never ride a float carrier — and a float
*ordered key* is a float carrier wearing a u32 costume, which is how `totalRows` hid.
A `measure` is a real quantity whose rounding is load-bearing. Layers may realize the
same kinds differently and stay conformant: the engine uses two buffers (where a value
lives IS its kind, so it cannot be got wrong), while the TSL side uses one homogeneous
atomic buffer where kind is per-lane. Neither is privileged; what each owes is that its
generator ASSERT its own mapping respects the kinds. The engine's strides are derived
from kind and asserted against it, so its container cannot disagree by construction.

```
measures  f32  MEASURE_STRIDE 8   X Y Z ADVANCE HEIGHT GLYPH_ID | BASE_X LINE_ADV
counts    u32  COUNT_STRIDE   4   ROW COL FLAGS | ORD
```

There are no bitcasts, no `fbits`/`fval`, and no "which lanes are floats" table. A
count cannot land in the measures buffer by accident because it is a different array —
the classification is structural, not advisory. Render-read lanes come first in both
buffers and fold scratch is at the tail, so the record format is a truncation.

### The record format — a truncation, not a repack

```
slots    48 B per SOURCE BYTE, corpus lifetime   (measures 8 + counts 4)
record   32 B per RENDERED GLYPH                 (measures 6 + counts 2)
```

`RECORD_MEASURE_STRIDE` / `RECORD_COUNT_STRIDE` are **derived** from which lanes the
vertex path reads — never hand-written. Because render-read lanes sort first in both
buffers, emitting a record copies a contiguous prefix; the generator refuses a schema
where a render-read lane sorts after an unread one, so the truncation cannot quietly
become a gather.

The tail is fold scratch: `BASE_X`, `LINE_ADV`, `ORD` are intermediates the layout
pass needs while computing and nothing needs afterward. Holding them at corpus
lifetime is paying corpus-scale memory for job-scale temporaries — on every byte,
including every space and newline.

`conformance_record.mojo` proves both halves, and both are mutation-tested:
its truncation check is bit-exact against the source prefix, and laying the corpus
**item-by-item through a scratch pool** produces byte-identical records to laying it
whole. That second one is the claim the decoupling rests on: corpus size stops
determining arena size, and a streaming edit becomes a range re-run rather than a
reload. (Resuming *mid-item* needs the bake's `prefix_at` checkpoints, which already
work and are conformance-proven — that is the next step, not this one.)

### Mid-item resume — an edit re-lays a line range, not a file

`layout_item` takes a `LayoutSeed`. Laying a whole item is the zero seed at
`byte_start`; laying a **range** is the same loop with a seed recovered from the
bake's checkpoints. One code path, not two.

`conformance_resume.mojo` proves that laying `[at, end)` from a checkpoint is
**bit-identical** to laying the whole item, at every line start in every fixture.
Mutation-tested: a seed off by one in `ord` or `base_row` fails loudly.

Two limits, both real and both stated rather than papered over:

- **Resume points are line starts.** The fold carries five accumulators; the monoid
  carries the two that are pure counts. It cannot carry `line_adv` (an f64 chain —
  f64 addition is not associative, so a regrouped monoid would drift), `seg_adv`
  (resets at every FOLD boundary, and fold is a query parameter), or `col`. At a
  line start all three are zero by definition. That is also the natural edit unit,
  and what the arena's own design study proposed.
- **A wrapped or paged item needs `base_row_hint`.** `scan_combine` accumulates rows
  using the wrap in the element, and `bake_file` bakes at wrap 0 on purpose — which
  is why `rows_under_wrap` is a separate histogram query. So the bake alone can seed
  an unwrapped item exactly, and for a wrapped one the caller must supply the row.
  Passing `-1` with `wrap > 0` **raises** rather than returning a plausible wrong
  number. In practice anything re-laying a range has already laid the document once,
  so the row is in hand.

`GLYPH_ID` is the one identity sitting in the measures buffer. It is there only because
it is copied verbatim from the trie's f32 blocks, so it cannot move until the trie
format does. That exception is deliberately visible rather than hidden in a comment.

The generator validates and throws: an identity declared with an f32 carrier, a lane
index past its stride, or a hole in a stride is a build failure, not a review miss.
Both are mutation-tested.

## On the GPU

Two dispatches run on real device threads (Apple M2, Metal), both bit-exact
against the CPU port with no tolerance:

```sh
mojo run -I engine engine/gpu_decode.mojo engine/fixtures/*.pipe.bin   # dispatch 1
mojo run -I engine engine/gpu_scan.mojo   engine/fixtures/*.pipe.bin   # chunkReduce
```

`decode` was first because it cannot be ambiguous — thread per byte, no cross-thread
dependency, no float accumulation. `chunkReduce` is the harder half: it folds K bytes
per thread through the segmented monoid, so it is where the float discipline meets
the hardware.

`paginate` runs on device too, and it is where the bit-exact tier ENDS — by
construction, not by shortfall. See below.

### The whole scan on device, and why composition needed its own test

```sh
mojo run -I engine engine/gpu_pipeline.mojo engine/fixtures/*.pipe.bin
```

Eight dispatches chained with every intermediate staying in device memory:

```
decode -> chunkReduce -> spineReduce -> spineScan -> partialScan -> apply
       -> resolveX -> paginate
```

Counts (`ROW`/`COL`/`ORD`/`ordToByte`) and the `totalRows` fold scalar compare
**exact**; `LINE_ADV` and the resolved positions at eps. The fan stride is derived
from a fold scalar between dispatches, as the CPU driver does. The
monoid lives in one function that every dispatch calls, so six kernels cannot drift
the way six transcriptions would.

**This found two bugs the four piecewise GPU suites could not**, which is the whole
argument for it:

- `combine` was written to be "obviously right" for a LEAF `b` — one byte, so
  `rows == 0` and `head_len <= 1`. It dropped the junction-line term
  (`rows_for_line(a.tail_len + b.head_len, b.wrap) + b.rows`) that only matters when
  `b` is a whole chunk. chunkReduce combines *only* leaves, so it passed alone; the
  spine combines chunks, so only composing them exposed it.
- `rows_for` was re-derived as a ceiling instead of transcribed. The real rule is
  `length // wrap + 1` — the newline rides at column `len`, so an exact-multiple line
  ends with a row holding only the newline. Off by one on exactly those lines.

Both say the same thing: **transcribe the monoid, do not re-derive it**, even for a
two-line function.

### What the GPU actually bought (Apple M2, 8 cores)

```sh
mojo run -I engine engine/gpu_pipeline.mojo --bench \
    engine/fixtures/ascii-basic.pipe.bin \
    examples/word-wall/data/WebstersEnglishDictionary.txt
```

The GPU timing spans the **whole device phase** — dispatches, readbacks, and the
host-side stride derivation between `resolveX` and `paginate`. Timing only the
kernels would flatter the GPU by hiding what a real caller pays.

| source bytes | CPU sharded | GPU chain | ratio |
|---:|---:|---:|---:|
| 64 KB | 100 MB/s | 18 MB/s | 0.18× |
| 256 KB | 104 MB/s | 45 MB/s | 0.43× |
| 1 MB | **108 MB/s** | 56 MB/s | 0.52× |
| 4 MB | 81 MB/s | 93 MB/s | 1.15× |
| 8 MB | 90 MB/s | 92 MB/s | 1.03× |
| 16 MB | 65 MB/s | 100 MB/s | **1.54×** |
| 24 MB | 63 MB/s | **101 MB/s** | **1.62×** |

The ratio is the least interesting column. The shape is the finding:

- **GPU throughput is size-independent.** It climbs out of launch overhead and then
  sits flat at ~100 MB/s from 4 MB to 24 MB. Launch cost amortises and nothing else
  changes.
- **CPU throughput degrades with size** — 108 MB/s at 1 MB down to 63 MB/s at 24 MB,
  a 1.7× fall. Eight cores stop fitting the working set; the GPU never had that
  problem because it never had that locality to lose.

So the crossover near 2–4 MB is not the GPU getting faster, it is the CPU getting
slower. The gap widens with corpus size rather than converging, which is the part
that extrapolates: on hardware with more parallelism and more bandwidth the flat
line should sit higher, while the falling line falls for the same reasons it does
here. This machine also has unified memory, so there is no PCIe transfer being
amortised — a discrete GPU pays a cost this measurement does not show.

### Streaming a whole tree — measured on `torvalds/linux`

```sh
find <dir> -type f > manifest
mojo run -I engine engine/bench/stream_bench.mojo engine/fixtures/ascii-basic.pipe.bin manifest [--count]
```

| corpus | files | source | glyphs | peak scratch | records | wall |
|---|---:|---:|---:|---:|---:|---:|
| dictionaries | 693 | 79.5 MB | 83.4 M | 143 MB | 2.5 GB | 2.2 s |
| linux `fs/` | 2,172 | 44.9 MB | 47.1 M | 40 MB | 1.4 GB | 1.6 s |
| **linux, all `.c`/`.h`** | **64,457** | **1.385 GB** | **1.45 G** | **1.10 GB** | **44.3 GB** | **22.6 s** |

The whole kernel lays out in 22.6 s at 61 MB/s, one file at a time, and **it
completes** — under the old arena it could not start, because 1.385 GB of source
needed 66 GB of slots held at once against a 44.7 MB ceiling.

**But the record format alone does not make an unbounded corpus free, and the
measurement says so plainly.** Records are 44.3 GB for this tree. Compaction bounds
the SCRATCH; it does not bound residency, because you must store what you render.
Past a certain size residency needs *eviction*, not a smaller record. `--count`
exists to measure that honestly rather than OOM.

**Peak scratch is set by the largest single item, and linux has a 22.9 MB one** —
`drivers/gpu/drm/amd/include/asic_reg/dcn/dcn_3_2_0_sh_mask.h`, with 112 files over
1 MB against a 22 KB mean. So "scratch is bounded by the largest item" is a real
bound but a bad one: one generated header forces a 1.1 GB pool for a corpus whose
average file is 22 KB.

That is exactly the case mid-item resume answers. `seed_at` recovers the fold state
at any line start from the bake's checkpoints, so a 22.9 MB file can be laid in
line-aligned chunks with scratch bounded by the CHUNK rather than the file — which
is `vram-memory-architecture.md`'s "large files chunked at newline boundaries",
now with the machinery under it and conformance-proven. Not wired into the streaming
driver yet; the measurement is what says it should be.

### The fixtures are all single-super, so the suite grows its own corpus

Every checked-in fixture is under 6 KB — 82 chunks, **one** super at `GROUP = 256`.
With a single super the spine scan's exclusive/inclusive distinction is invisible
(the absorbing reset at byte 0 discards the only prefix it affects), and a 33-byte
fixture is one chunk, so no chunk-level combine happens at all. The two bugs above
live on exactly those paths.

So `gpu_pipeline.mojo` generates 20 K / 40 K / 70 K byte cases (2, 3 and 5 supers),
wrapped and unwrapped. Mutation-tested against them: making the spine scan inclusive
fails 161,008 lanes; dropping the junction term fails 69,872 wrapped lanes and zero
unwrapped ones, which is precisely the signature of a wrap-only defect. The
`rows_for` ceiling mutation is caught by `wrap-exact` and `wrap-emoji` instead —
the fixtures cover that one, the synthetics cover the spine, and neither alone is
enough.

### Metal has no f64, and that turns a convention into a constraint

Trying to prove the f32-per-add discipline was load-bearing, the natural mutation is
to accumulate `tail_adv` in f64 and narrow once. On Metal that **does not compile**:

```
Function 'air.convert.f.f32.f.f64' has Metal-unsupported instructions
function's return type 'double' is not supported
LLVM ERROR: Failed to verify LLVM IR for Metal
```

Apple GPUs have no double precision. So `segAdv`'s f32-per-add is not merely the
choice that makes the reduce exact under regrouping — on this hardware it is the
only thing that can run at all. The oracle's discipline and the device's capability
turn out to be the same requirement arrived at from two directions.

### Where the bit-exact tier ends: `paginate`

`gpu_paginate.mojo` runs pagination on device and compares at **eps (1e-4)**, not
bit-for-bit. The CPU kernel computes positions in f64 because the JS oracle uses JS
numbers, which are f64, and the port's job is to reproduce the oracle. That
arithmetic cannot run on Metal in any form, so the device computes positions in f32
and the two differ in the last bits. This is the same tier the foldless float lanes
already occupy in `conformance_scan`.

What stays exact is the part that matters: **every page decision is an integer gate
on the count lanes.** `screen_row`, `y_page`, `x_page`, `band` and `seg` are integer
arithmetic on `ROW`/`COL`, so the device never picks a different page — it places
the same glyph on the same page a few ULP away. Verified by mutation: breaking the
`y_page` gate moves a position by a whole page stride and fails loudly, while a
0.001 nudge past the tolerance fails on the tolerance alone. Determinism-land is
exact on device; only float-land is approximate, which is the split working.

This also gives the tiered scan contract a hardware reason, not just a numerical
one: the serial fold's f64 `lineAdv` **cannot** be computed on an Apple GPU, which
is exactly why foldless float lanes compare at eps rather than bit-exact. And it is
a live constraint for what comes next — the port's `item_bounds` are f64 today, so
the bounds reduce needs an f32 or split-precision form before it can move to device.

### Bounds, and the fold scalar that was a float

`gpu_bounds.mojo` folds the per-item boxes on device. The 6 box lanes are genuine
measures, compared at eps — the CPU kernel folds in f64 and Metal cannot, though f64
buys nothing for the reduce itself (widening f32→f64 is lossless and min/max
preserves order; it buys only `x+w` at f64 instead of one f32 rounding).

Lane 6, `TOTAL_ROWS`, is a **count** — and the TSL side stores it through
`floatToOrderedKey`, which is *an f32 carrier wearing a u32 costume*. It aliases past
2^24, and it is **reachable**: `S_ROW` is the VISUAL row, so at `wrap = 1` rows track
glyph count and cross 2^24 at ~16.8 MB inside a 44.7 MB arena (measured). The
consumer has been compensating without anyone filing it — `foldGeometry.js:146` does
`Math.trunc(p.totalRows || 0)`, a downstream truncating a count back to an integer.

On device the lanes go **by kind**, which is also the only form Metal can run:

```
measures  6 box lanes + MAX_ROW_EXTENT   f32 via a monotonic ordered key, so integer
                                         atomicMin/Max implements float min/max
counts    TOTAL_ROWS                     a NATIVE u32 atomicMax — no mapping, no wall,
                                         and 0 is genuinely max's identity over
                                         non-negative integers rather than "-inf's key"
```

Mutation-tested both tiers: routing `TOTAL_ROWS` back through the ordered key yields
3,229,614,080 instead of 4, and a 0.01 nudge fails the box tolerance.

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

### The invariant check (what a differ cannot catch)

```sh
mojo run -I engine engine/ordinal_invariant.mojo engine/fixtures/*.pipe.bin
```

The three suites above are *differential* — they compare this port against the JS
oracle. That catches any divergence between them and is blind to a fault they
**share**. The f32 ordinal wall is exactly that kind of fault: `ord` is exact on
both sides (a JS number, a Mojo `Int`) and is quantized only on the store into an
f32 lane, so past 2^24 both sides round identically and the differ reports PASS
while both are wrong together.

`ordinal_invariant.mojo` asserts a property of a single run instead, with no
oracle involved. The same fact is recorded twice — `counts[C_ORD]` and
`ord_to_byte` — so the round-trip must be the identity for every leader:

```
ord_to_byte[byte_start + Int(counts[co + C_ORD])] == id
```

It is mutation-tested against its own boundary, because a check that cannot fail
proves nothing: one item of 2^24-2 bytes passes, one of 2^24+2 aliases exactly once
(byte 16777217 collides onto 16777216). The runner raises in **both** directions —
a false positive below the wall, or a silent pass above it.

The bound is **per item, not per arena**: `ord` resets for each item and
`ord_to_byte` is indexed from `byte_start`, so a large arena of ordinary files is
safe while one item past 2^24 bytes is not. The JS arena's global
`ORDINAL_EXACT_BYTES` cap is a conservative proxy for that rule.

Generalize the technique before reaching for another fixture: when a lane is
suspected of lying, look for a witness to it in a wider type. Where no witness
exists, that absence is itself worth knowing.

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

## Setup from a fresh clone (read this first, next agent)

Two toolchains: **Bun** (the JS oracle + fixture generators — the repo is already a
Bun workspace) and **Mojo ≥ 1.0**.

```sh
# 1. Mojo (Linux x86_64 / macOS arm64; needs Python 3.9+)
pip install modular          # provides `mojo` on PATH
mojo --version               # expect: Mojo 1.0.0 or later

# 2. Verify the whole engine in one pass (all three suites must be green)
bun engine/fixtures/gen.mjs
bun engine/fixtures/gen-bake.mjs
mojo run -I engine engine/conformance.mojo      engine/fixtures/*.pipe.bin
mojo run -I engine engine/conformance_scan.mojo engine/fixtures/*.pipe.bin
mojo run -I engine engine/conformance_bake.mojo engine/fixtures/*.bake.bin

# 3. Benchmark (optional; prints MB/s vs the checksum-matched JS side)
bun engine/bench/gen-bench.mjs
mojo build -I engine engine/bench/bench.mojo -o engine/bench/bench && ./engine/bench/bench
bun engine/bench/bench.mjs   # the JS side of the ledger
```

Expected state after step 2: `conformance: all cases bit-exact`,
`scan conformance: all cases within the tiered contract`,
`bake conformance: all cases bit-exact`. Anything else is a real regression —
the suites have no tolerances to hide behind.

Working notes for agents:

- **Your training data predates Mojo 1.0.** The language moved: `fn`→`def`,
  `alias`→`comptime`, `UnsafePointer`→`Pointer` (`ptr[i]`→`ptr[unsafe_offset=i]`),
  unified capture-list closures. Don't write from memory — the repo's `.mcp.json`
  registers Modular's docs MCP server (`docs_search` / `docs_get_api` /
  `docs_check_imports` — validate imports BEFORE writing code), and
  `.claude/skills/` carries `mojo-syntax`, `closure_migration`, and
  `mojo-gpu-fundamentals`, which load automatically from the clone.
- **ASAP destruction** (the afternoon-eater): see the gotcha below before touching
  anything with `TaskGroup`.
- CPU-only is fine for everything here — no GPU is required for conformance; that
  is the point of the serial layer. The GPU lift (glyph_scan's dispatches onto
  device threads) needs real hardware — start from the `mojo-gpu-fundamentals`
  skill, and keep the conformance suites as the referee exactly as before.
- `pip install modular` also drags in MAX; on a lean machine
  `pip install mojo-compiler` may suffice — verify `mojo --version` either way.

## First numbers (honest ones)

`engine/bench/` runs the same work over the same corpus (every .js under
`packages/`, 2.4MB, one trie) in both worlds — checksums cross-check that both
computed identical answers. First measurement, single-threaded, naive transcription
vs Bun's JIT on typed arrays:

| work | js/bun | mojo, naive port | mojo, sharded (4 cores) |
|---|---|---|---|
| bake | 15.6 MB/s | 28.0 MB/s (1.8×) | 28.0 MB/s (1.8×, still serial by design) |
| pipeline (serial oracle) | 15.4 MB/s | 13.4 MB/s (0.9×) | **41 MB/s (2.7×)** |
| pipeline (scan form) | 4.2 MB/s | 5.0 MB/s (1.2×) | **39 MB/s (9×)** |

Two lessons, in order. First: a line-for-line port does not beat a good JIT on
serial scalar code — the middle column is real. Second: the headroom is structural,
and Mojo can actually spend it — kernels take raw pointers (the GPU's calling
convention), drivers shard them over `TaskGroup` across cores, and every parallel
reduction is exact under regrouping (disjoint writes and min/max merges only; the
fold and the miss order stay serial). Same fixtures, same bit-exact/tiered
contracts, same checksums as the JS — only faster. The scan form's 9× is the
architecture's claim made concrete: it parallelizes because it was *designed* to,
and the same sharding is the GPU dispatch structure.

### Second machine: Apple M2, 8 cores (2026-08-20)

The whole suite was brought up from a fresh clone on an M2 MacBook — a different
CPU architecture from the x86 container the numbers above came from. All three
conformance suites passed **on the first run, unchanged**: bit-exact serial,
tiered scan at both tunings, bit-exact bake. The float discipline is genuinely
portable, not accidentally x86-shaped.

| work | js/bun (M2) | mojo, sharded (M2, 8 cores) |
|---|---|---|
| bake | 34.8 MB/s | **63.8 MB/s (1.8×)** — after the fix below |
| pipeline (serial oracle) | 46.0 MB/s | **122.2 MB/s (2.7×)** |
| pipeline (scan form) | 8.7 MB/s | **70.2 MB/s (8.1×)** |

Both sides got much faster on real hardware, and the *ratios held* — 2.7× and
~8×, the same as on 4 cores. That is the useful signal: the win is structural,
not a one-machine artifact.

**Bake first measured SLOWER than JS here (27.5 vs 35.1 MB/s), and the reason
was not what it looked like.** The obvious read was "it's the only serial stage,
spend the cores" — that was wrong twice. Both benchmarks bake the whole corpus
as ONE file, so per-file fan-out would not have moved this number at all; and
a single file's bake is genuinely serial (a running accumulator, in order).

The real cause was an algorithmic mismatch inherited from the transcription.
`glyphBake.js` collects the census, the missing set, and the line histogram into
hash `Set`/`Map`s and sorts once at the end. The port kept them as sorted `List`s
and did a binary search plus a possible `insert` memmove **per leader** — a few
million times over this corpus. Swapping to `Set`/`Dict` and materializing the
sorted output once took bake from 27.5 to **63.8 MB/s (2.3× faster, now 1.8×
JS)** with the conformance suite still bit-exact and the checksum unchanged —
while remaining single-threaded.

The lesson generalizes past this stage: a faithful port inherits the source's
data structures along with its semantics, and the ones that were free in a
JIT with hash sets are not free anywhere else. Reach for the profile before
reaching for the cores.

Checksums matched JS on every run, and eight consecutive runs produced identical
checksums — the ASAP-destruction keep-alive anchors hold under 8-way parallelism,
not just 4.

`bun engine/bench/gen-bench.mjs` regenerates the corpus;
`mojo build -I engine engine/bench/bench.mojo -o engine/bench/bench` builds the
native side (bench.bin and the binary are gitignored).

## Mojo development setup

- **Docs**: the repo's `.mcp.json` registers Modular's docs MCP server
  (`https://mojo-mcp.modular.com/mcp/`) — search/fetch mojolang.org from any
  session (`docs_search`, `docs_get`, `docs_get_api`, `docs_check_imports`).
  Prefer it over guessing at 1.0 APIs; the language moved under its pre-1.0
  training data (fn→def, alias→comptime, UnsafePointer→Pointer, capture lists).
- **Skills**: `.claude/skills/` vendors `mojo-syntax`, `closure_migration`, and
  `mojo-gpu-fundamentals` from github.com/modular/skills (Apache 2.0 — see
  MODULAR-SKILLS-LICENSE).
- **The one gotcha that will eat an afternoon**: Mojo destroys a value at its
  LAST USE, not scope end (ASAP destruction). A List whose final mention is
  `tg.create_task(worker(...))` is freed *before the tasks run*; the workers then
  read recycled memory — flaky, timing-dependent, looks like an ABI bug. Anchor
  every buffer past the last `tg.wait()` (`_ = len(buf)`). The drivers here do,
  with comments.

## Not ported yet

- The far-texture LOD oracles (`farScatterOracle` / `farNormalizeOracle`).
- The GPU backend itself: lift glyph_scan's loops onto device threads (needs GPU
  hardware; every kernel body is already in place).

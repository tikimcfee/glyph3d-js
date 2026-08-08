# Perf contract & measurement harness — proving "10k files in seconds"

Swarm topic: **benchmark and measurement design**. Scope: the target metrics, the
canonical corpus, cold vs warm methodology, what CI can guard vs what humans run,
and how the existing `loadTrace` / `load.stats` / long-task infrastructure grows
into a full attribution system. This report designs the *measuring stick*; it
proposes no renderer changes of its own, but it defines what every other proposal
in this swarm will be judged by.

---

## 1. Problem framing

Today the repo can answer "was that load structured correctly?" but not "how fast
was it, and where did every millisecond go?"

What exists (all verified in-tree):

- `app/commands/loadTrace.js` — staged per-load traces (`reach → list → fetch →
  seat → build → relayout`), one `[load]` console line, an in-memory ring
  (`ctx.loadTraces`, cap 60), plus `performance.measure` marks. Long tasks
  (>50ms) are attributed to the active load + last stage via `installFrameWatch`
  (`[frames]` lines, `ctx.frameTasks` ring).
- `packages/glyph3d-core/src/core/loadStats.js` — dumb counters for the hidden
  build costs: kernel dispatches, atlas grows/swaps/blanks, parse ms, commit ms,
  yields.
- `app/commands/handlers/loadCommands.js` — the `load.stats` verb: ring dump +
  aggregates (`{ traces, relayouts, totalMs, frames, blockedMs }`).
- `tools/loadstorm-check.mjs` — headless storm harness. Asserts **structure**
  (one relayout per openDir, stage coverage, coalesced notifications) and
  **prints** milliseconds. Explicitly: "Numbers are PRINTED, not asserted."
- `tools/trace-capture.mjs` — full Chrome trace around any bus command, with a
  synthetic-provider injection (`--synthetic N`) that is the in-repo precedent
  for deterministic corpora.
- `app/glyph-bench.html` / `.jsx` — interactive map-path vs text-path wall,
  whole-repo memory test. Human-run, not scripted, no pass/fail.
- `tools/glyph-pipeline-check.mjs` — GPU-vs-reference correctness gates with
  `dispatchMs` (submit-side timing) already recorded per lane.

What's missing:

1. **No numeric contract.** Nothing says what "fast" is. No budget exists for any
   stage, so regressions are only visible as human memory ("build was 2.7s last
   week" — literally how the current load-regression plan reconstructs history).
2. **No canonical corpus.** loadstorm storms three directories of this moving
   repo; trace-capture's synthetic files are one fixed 220-line shape; the bench
   uses `import.meta.glob` of the repo itself. None of these is "10k files", none
   is stable across runs or machines.
3. **No cold/warm discipline.** The confirmed user pain (per
   `docs/plans/layer2-wiring-and-load-regression.md`) is *cold-reload restore* —
   cold atlas, atlas-grow storm, restore stacking. No harness measures a true
   cold page; loadstorm reuses a booted app.
4. **Attribution stops at the stage boundary.** `build` is one blob containing
   seat/pour/settle/dispatch/atlas. `dispatchMs` measures **submit** time, not
   GPU execution. Dark time is only checked sloppily (25% or 5ms tolerance).
5. **No steady-state benchmark.** Nothing measures frame time once everything is
   loaded — which is half the product promise (millions of static glyphs, camera
   flying, 60fps).

The design below closes these five gaps without replacing any of the existing
infrastructure — it extends it.

---

## 2. Design

### 2.1 The performance contract (target metrics)

A versioned, in-repo contract file — `tools/perf/contract.json` — naming every
metric, its scenario, its budget, and its gate level (`ci` | `nightly` |
`reference`). Draft numbers (justification in §2.5):

**Load throughput (canonical corpus C10k, §2.2)**

| metric | definition | budget |
|---|---|---|
| files/sec | files fully committed / (first byte fetched → last commit) | ≥ 1,500 |
| glyphs/sec | reference-pipeline glyph count / same window | ≥ 3.0M |
| MB/s | source UTF-8 bytes / same window | ≥ 30 |
| cold-start-to-first-frame | navigation start → first rAF after first visible glyph, fresh everything | ≤ 2.5s |
| cold-start-to-fully-settled | navigation start → last trace end + zero pending dispatches + idle frame <16.6ms | ≤ 8s |
| warm reload settled | same corpus, warm atlas + warm page cache, after `scene.clear_grids` | ≤ 3s |

**Steady state (after C10k settled)**

| metric | definition | budget |
|---|---|---|
| frame time, p50/p95 | rAF dt over scripted 5s camera sweep, 1,000 grids in frustum | ≤ 8 / 16.6ms |
| draw calls | `renderer.info.render.calls` for the wall | ≤ 10 |
| long tasks | main-thread blocks >50ms during sweep | 0 |
| resident memory | `performance.memory.usedJSHeapSize` + counted GPU buffers, per million glyphs *resident* (not rendered) | ≤ 40 MB/M glyph-resident; GPU budget reported, not gated (machine-dependent) |

**Structural invariants (unchanged from loadstorm, kept):** one relayout per
bulk load, one trace per source, stage coverage ≥ 95% (tightened from 75%),
notification coalescing, zero round-trip failures vs the reference pipeline.

**Dark time law (new):** for every trace, `Σ stage ms / total ≥ 0.95`. Anything
below is a failing trace regardless of speed — unmeasured time is where
regressions hide. This is the single most important new invariant.

### 2.2 Canonical corpus strategy

Determinism has four enemies: a moving checkout, OS page-cache state, atlas/worker
scheduling nondeterminism, and machine variance. The strategy:

**C-REAL — pinned torvalds/linux slice (the marketing number).**
- A fetch-once artifact: `_corpus/linux-v6.10.tar.zst` (pinned tag), plus a
  `manifest.json` with `{ path, size, sha256 }` for every file, generated at
  import time by `tools/perf/corpus-import.mjs` and **verified before every run**
  (hash mismatch → hard fail, never silently bench a different corpus).
- The *canonical* slice C10k is a deterministic subset: sort by path, take the
  first 10,000 code files ≈ 200MB ≈ 30–35M glyphs (typical code ≈ 1 glyph/byte
  minus newlines/whitespace). Exact glyph count is precomputed once through
  `compute/glyphPipelineReference.js` (`runPipeline`) and stored in the manifest —
  giving the denominator for glyphs/sec and the correctness oracle for "every
  file landed".
- Served by the Go relay from a read-only fixture root (the loadstorm `:8099`
  scratch-relay pattern, new port), so the load path exercised is the real
  `file.openDir` → fs-RPC → fetch pipeline, not a test double.
- Too heavy for CI; runs nightly and on the reference machine.

**C-SYN — seeded synthetic scaler (the CI number).**
- `tools/perf/corpus-gen.mjs`: mulberry32-seeded generator whose parameters are
  *fitted to C-REAL's histogram*: file-size distribution (log-normal, median
  ~4KB), line-length distribution, extension mix, and a small CJK/emoji fraction
  (so atlas grows happen at a realistic rate — a pure-ASCII corpus would hide
  the atlas-grow regression entirely).
- Injected through the trace-capture precedent: replace `ctx.fileProvider` with
  a deterministic in-memory provider (`listTree`/`getMultipleFiles` over a
  pre-seeded Map). No relay, no disk, no network → the only remaining variance is
  machine speed. Sizes: C-SYN-1k (CI), C-SYN-10k (nightly), C-SYN-50k (scaling
  probe for headroom).
- Same generator + same seed = byte-identical corpus on every machine; the
  manifest hash check applies to it too.

**Rule: real corpus for truth, synthetic corpus for gates.** Any optimization PR
must not regress C-SYN-1k CI budgets; the claim "10k files in seconds" is proven
on C-REAL-10k on the reference machine.

### 2.3 Cold vs warm methodology

Four distinct scenarios (each a `tools/perf/perf-run.mjs` invocation, §2.4):

1. **COLD** — fresh Chromium process, fresh profile, production build
   (`vite build && vite preview`, not dev-Vite: module-transform noise dominates
   a dev server and varies with tree churn), empty IndexedDB/blob store, relay
   fixture freshly started. OS page cache: we accept *warm* page cache and
   document it (dropping caches needs root; a 200MB corpus reads in <1s from
   cache and the relay→browser hop is in the budget anyway). This is the
   session-restore pain scenario from the load-regression plan.
2. **WARM** — same page, atlas and trie resident: `scene.clear_grids` +
   `load.stats clear` + re-run the identical command sequence. Measures pure
   incremental load cost (what a second `openDir` of the same tree costs).
3. **RESTORE** — cold page *with* a pre-seeded `.glyph3d-session.json` pointing
   at the corpus root: the actual user path, including session restore stacking
   detection.
4. **STEADY** — after any of the above: scripted camera sweep + frame sampler.

Each scenario runs **5 times, median reported, min kept alongside** (min is the
best estimate of true work; median catches scheduling flakiness). Variance >15%
between min and p95 fails the run as "noisy" — a measurement-quality gate, so we
never argue about single numbers.

### 2.4 The harness: `tools/perf/perf-run.mjs`

Built on the existing seams, not beside them:

- Launch/driver: reuse `tools/itest/driver.mjs` (`launchBrowser` with the
  load-bearing `--use-angle=vulkan` flags — headless *is* on the real GPU, this
  is already solved) and `openApp`. Relay mode: `openApp(browser, { relayPort })`.
  Synthetic mode: the `trace-capture.mjs` provider-injection snippet, parameterized
  by seed + count.
- Scenarios are data, not code: `{ corpus, provider: 'relay'|'synthetic',
  commands: [['file.openDir', root]…], settle: 'idle-frame', budget: 'C10k-cold' }`.
- Driving is always through the command bus (`router.execute`) — the same verbs
  the UI and CLI use, so the harness measures what users get, and the existing
  `loadTrace` marks fire for free.
- Settle detection (new, replaces fixed `waitForTimeout`): poll until
  (a) no active load traces, (b) `loadStats.kernelDispatches` unchanged for two
  consecutive 100ms polls, (c) one rAF under 16.6ms. That's "fully settled" —
  defined, not vibes.
- Frame sampler (new, in-page, installed by the harness): rAF dt histogram +
  `renderer.info.render.calls` per frame + optional GPU frame time via
  three/webgpu timestamp queries (see §2.6). 5s scripted camera sweep across the
  loaded wall.
- Output: one JSON artifact per run —
  `{ scenario, corpus: {hash, files, bytes, glyphs}, runs: […], median: {…},
  traces, loadStatsDeltas, frames, gpu: {adapter, timestampsSupported}, budgets:
  {metric, value, budget, pass}[] }` — printed digest to stdout, artifact to
  `docs/perf-swarm/results/<date>-<git-sha>-<scenario>.json` (gitignored or
  committed-as-history, team's call). Machine-readable diff:
  `tools/perf/perf-diff.mjs A.json B.json` prints per-metric % change — the PR
  review tool.
- `bun tools/perf/perf-ci.mjs` — thin wrapper: C-SYN-1k, cold+warm, asserts the
  `ci`-gated budgets with a 3× slack multiplier for shared-runner jitter
  (structure asserted exactly, time asserted loosely; absolute numbers gate only
  on nightly/reference runs).

### 2.5 Where the budgets come from (bandwidth math)

C10k ≈ 200MB UTF-8 ≈ 30M glyphs. Per-stage draft budget for cold-settled ≤ 8s:

| stage | budget | basis |
|---|---|---|
| reach+list | 300ms | one fs-RPC tree walk, 10k entries ≈ 1MB JSON |
| fetch (disk→relay→WS→page) | 700ms | localhost WS sustains ≥300MB/s; 200MB |
| TextEncoder byte-in | 400ms | V8 TextEncoder ~0.5–1GB/s, splittable across workers |
| GPU layout (setFiles + 3 dispatches + bounds) | 1,500ms | stride-11 slot scan of 200MB ≈ 8.8GB written; a mid GPU does >200GB/s → ~50ms of pure kernel; the budget is dominated by buffer alloc + upload of the 200MB byte buffer (~1–2GB/s realistic write path) |
| atlas ensure (misses → encode → trie patch) | 1,000ms | C10k distinct codepoints is small (~200–500 + Nerd Font icons); budget is really "no grow storm": ≤ 2 grows, one hot-swap at settle |
| commit + upload instance attrs | 2,000ms | the binding constraint — see below |
| first frame | 1,000ms | shader compile (pipeline cache warm after run 1) + first present |
| relayout + close | 100ms | one relayout, invariant-enforced |

The instance-attribute footprint is the number the whole design must keep honest:
stride-11 f32 slots = **44B/glyph → 30M glyphs ≈ 1.3GB**. Even at 16B/glyph
(packed pos+size+glyph+color) it's ~480MB to create and upload in the "commit"
budget — that is why commit gets 2s and why the memory contract separates
*resident* (maps/bytes, ~8–40MB per the bench's whole-repo numbers) from
*rendered* (instance buffers). If the byte-in pipeline keeps slots on GPU and
never mirrors them to JS, commit collapses to a buffer write; the contract's
commit budget is where that design decision shows up as a number.

These are starting budgets, meant to be argued down by the other swarm reports;
the harness doesn't care what the numbers are, it cares that they live in
`contract.json` and gate.

### 2.6 Extending loadTrace / load.stats to full attribution

The rule: **every millisecond of a load belongs to exactly one bucket, and every
bucket names its owner.** Concretely:

1. **Sub-stage marks inside `build`** (already planned in the load-regression
   doc; this design requires them): `seat`, `pour`, `settle`, `dispatch`
   (count+ms from `loadStats`), `atlas` (grows+ms+fieldsSwapped+blanks). The
   dark-time law (Σ stages ≥ 0.95 total) is enforced per sub-stage too.
2. **GPU execution time, not just submit time.** `dispatchMs` in
   `glyph-pipeline-check.mjs` times enqueue. three/webgpu supports timestamp
   queries (`renderer.resolveTimestampsAsync(THREE.TimestampQuery.COMPUTE)`,
   behind the `timestamp-query` device feature). The pipeline kernels
   (`compute/glyphPipelineKernels.js` `setFiles/run`) get an opt-in
   `{ profile: true }` that brackets each kernel dispatch with timestamp writes
   and reports `gpuMs` alongside `submitMs`; unsupported feature → record
   `gpuMs: null`, never fail. Same for frame GPU time in STEADY
   (`TimestampQuery.RENDER`). This is what separates "CPU is slow" from "GPU is
   slow" — currently invisible.
3. **Async-wait buckets.** Time awaiting GPU readbacks (`readSlots`,
   `readItemBounds`, worker round-trips) is marked as explicit stages
   (`trace.mark('gpu-wait')` style) rather than silently inflating the enclosing
   stage — CPU-vs-GPU overlap becomes visible instead of averaged away.
4. **Long-task watcher upgrades** (`installFrameWatch`):
   - Keep longtask for compatibility, add the **long-animation-frame (LoAF)**
     observer where available (Chromium 123+): per-frame script attribution
     (`invoker`, source location) attached to the frame record, so an 80ms block
     "after fetch" names the *function*, not just the stage.
   - Attribution generalizes from "last active load" to **a stack**: traces can
     nest (restore → openDir → per-grid commit), and blocks attribute to the
     innermost active trace + stage. `beginLoad` gains an optional parent.
   - Every frame record gains the harness run id (`ctx.perfRunId`, set by
     perf-run) so nightlies can filter a run's frames out of a shared ring.
5. **`load.stats` verb grows `gpu` and `coverage` fields** (gpuMs per stage,
   Σ/total per trace) and a `json` flag so the harness consumes it without
   parsing the human table. `load.stats clear` already exists — the harness's
   per-run isolation is free.
6. **Per-stage byte/glyph counters**: `fetch` already notes `kb`; every stage
   notes its work units (`{ files, bytes, glyphs }` via the manifest), so every
   ms number can be read as a throughput. Stage regressions then read as
   "fetch dropped to 40MB/s" — actionable, not "fetch feels slow".

### 2.7 CI-guardable vs human-run

| level | what | where |
|---|---|---|
| **CI (every PR)** | C-SYN-1k cold+warm; structural invariants exact; time budgets at 3× slack; dark-time law; zero round-trip failures | `perf-ci.mjs`, headless, ~2min |
| **Nightly** | C-SYN-10k + C-REAL-10k cold/warm/restore/steady; full budgets; artifact committed to results history; trend alert if any metric regresses >10% vs trailing 7-run median | scheduled job on a fixed runner |
| **Reference (human)** | the proof runs: C-REAL-10k on the designated box, headed, `perf-diff` vs contract; trace-capture artifacts for any regression investigation | dev machine |

The existing human tools stay human tools: `glyph-bench.html` for eyeballing,
`trace-capture.mjs` for call-stack-level digs (its user_timing marks now carry
the new sub-stages for free), `load.stats` for live-session poking.

---

## 3. Mapping onto existing seams

| this design | existing seam |
|---|---|
| scenario runner | `tools/itest/driver.mjs` launch/openApp + `tools/loadstorm-check.mjs` storm shape |
| synthetic corpus injection | `tools/trace-capture.mjs:45-67` provider-replacement precedent, parameterized |
| stage marks | `app/commands/loadTrace.js` `mark/note/end` — sub-stages are new `mark()` calls in `app/commands/handlers/fileCommands.js` (which already marks `seat` at :317) |
| counters | `packages/glyph3d-core/src/core/loadStats.js` — add `gpuMs`, `gpuWaitMs`, `bytesFetched`, `glyphsLaidOut` |
| stats surface | `app/commands/handlers/loadCommands.js` `load.stats` — add `json` flag + new fields |
| long-task attribution | `app/commands/loadTrace.js` `installFrameWatch` — LoAF observer + nested-trace stack |
| GPU timing | `compute/glyphPipelineKernels.js` `setFiles/run` — timestamp-query bracketing, following the `dispatchMs` precedent in `tools/glyph-pipeline-check.mjs:255-267` |
| correctness oracle for corpus manifest | `compute/glyphPipelineReference.js` `runPipeline` (the executable spec — glyph counts per file, precomputed) |
| relay fixture | the loadstorm `:8099` scratch-relay pattern, new port + read-only corpus root |
| interactive bench | `app/glyph-bench.jsx` — gains a "run scripted bench" button that drives perf-run in-page and exports the same JSON (human tool speaks the artifact format) |

No file above needs restructuring; each gains an additive feature.

---

## 4. Risks / open questions

- **Machine variance is the eternal enemy.** Mitigation: synthetic corpus for
  gates, 3× CI slack, min+median+p95 reporting, absolute budgets only nightly/
  reference. Risk remains that CI runners' GPUs (or SwiftShader fallbacks) are
  wildly slower — the driver's ANGLE flags must keep working; a startup probe
  should record the adapter string into the artifact and *fail loudly* on
  swiftshader rather than benching software rendering.
- **`timestamp-query` availability** varies by adapter/Dawn. Handled as optional
  (`gpuMs: null`), but then GPU-vs-CPU attribution is blind on some machines —
  the reference machine must have it.
- **Atlas/worker scheduling nondeterminism**: grow counts and pour ordering vary
  run to run, so *counts* of grows/swaps can only gate as invariants (≤ N, one
  swap at settle), not exact values. The contract gates counts loosely and
  milliseconds on the reference box.
- **Dev-Vite vs production build**: all perf numbers must come from
  `vite build && vite preview`. Open: does anything in the harness (e.g.
  `/@fs` imports used by glyph-pipeline-check) break under preview? perf-run only
  drives the command bus, so no — but the pipeline check stays a dev-server tool.
- **Corpus realism drift**: C-SYN's histogram is fitted once to C-REAL; if the
  workload question changes (e.g. "what about minified JS?"), C-SYN must be
  refit or it will keep answering the old question. The fit parameters live in
  `corpus-gen.mjs` with the C-REAL histogram committed for comparison.
- **200MB through the relay**: untested at this scale — chunking/backpressure in
  fs-RPC may cap below the 300MB/s assumption; the fetch budget is the first
  number a C-REAL run will invalidate. That's the harness working as intended.
- **Memory metric portability**: `performance.memory` is Chromium-only and
  8MB-granular; GPU buffer accounting needs renderer-side counting
  (`renderer.info.memory` + explicit buffer byte tracking in the pipeline).

---

## 5. Effort estimate

| piece | days |
|---|---|
| `corpus-gen.mjs` + C-REAL import/manifest/hash-verify | 2 |
| `perf-run.mjs` scenarios + settle detection + JSON artifact + `perf-diff.mjs` | 2.5 |
| loadTrace sub-stages + nested traces + LoAF + dark-time law + `load.stats json` | 1.5 |
| GPU timestamp profiling (kernels + frame, with fallback) | 1.5 |
| frame sampler + scripted camera sweep (STEADY) | 1 |
| CI wiring (`perf-ci.mjs`) + nightly job + contract.json tuning after first real runs | 1.5 |
| **total** | **~10 days** (1.5–2 weeks, one engineer) |

The critical path is `perf-run` + sub-stage marks; GPU timestamps and STEADY can
land in parallel. First C-REAL-10k numbers should exist within the first week —
even before any optimization lands — because the baseline artifact is what every
other swarm proposal gets diffed against.

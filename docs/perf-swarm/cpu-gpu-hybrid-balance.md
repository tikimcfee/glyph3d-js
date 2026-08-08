# CPU/GPU Hybrid Workload Balancing — the ideal division of labor

**Scope:** how the load path (disk → seated, colorized glyph instances) should be split between
CPU cores and GPU so both are saturated simultaneously. Grounded in the current code:
`workers/builders/index.js` (CPU builders, now idle on the file path), `compute/GlyphPipelineKernels.js`
(the 9-dispatch byte-in pipeline), `compute/GlyphPipelineArena.js` (stage/flush/readback orchestration),
`parsing/SyntaxColorizer.js` (main-thread tree-sitter), `app/commands/handlers/fileCommands.js` (openDir load loop),
`cli/` Go relay + `services/data/RemoteFileSystemProvider.js` (fs-RPC).

---

## 1. Problem framing

### Where we are

The repo has already moved the file-load path to the "byte-in" design: raw UTF-8 →
`GlyphPipelineArena.stage()` → one coalesced flush of **9 globally batched dispatches**
(decode → 5-stage scan → resolveX → deriveStrides → paginateAndBounds) → one bounds readback
that resolves every item's `laid` gate. The CPU worker pool (`WorkerBridge`, `hardwareConcurrency − 1`
workers, Transferable results, worker-side shape cache) is **fully built but idle** on the file path.

The hybrid regressed (Phase 0: 480 files, build 2.7s → 9.4s) not because GPU layout is wrong,
but because the *balance* is wrong in five specific ways:

1. **O(N²) flush cost.** Uploads are append-only (`appendFiles`) but every flush sizes all 9
   dispatches by **total arena bytes** (`_setDispatchCounts`), so flush K re-scans the bytes of
   flushes 1..K−1. During a storm of ~100 macrotask-window flushes, GPU does ~50× the necessary work.
2. **Steady-state readbacks on the critical path.** `readItemBounds()` (awaited, per flush) gates
   every grid's `laid` promise, and `Promise.allSettled(pending)` in `fileCommands.js` cannot settle
   until the GPU queue drains. `readMisses()` is a second readback every flush, usually empty.
   Two GPU-queue round trips per flush × ~100 flushes = the CPU spends the storm waiting.
3. **Branchy work stranded on the main thread while workers idle.** Tree-sitter
   (`analyzeGrid`, the measured `parseSyncMs` — "the true main-thread cost a bulk load pays per file"),
   `text.split('\n')`, `TextEncoder.encode`, and two O(bytes) passes of `buildByteLineIndex`
   all run on the main thread. That is exactly the workload class (irregular, branchy,
   latency-tolerant, per-file independent) that belongs on the idle N−1 workers.
4. **Flush cadence driven by macrotask windows, not GPU quanta.** `requestFlush()` coalesces
   per `setTimeout(0)` window, so flush size is an accident of the seating loop's slice budget
   (`loadBuildBudget ?? 12`ms) instead of a deliberate GPU batch size.
5. **Failure amplification on the miss path.** Any unseen codepoint → atlas grow → hot-swap into
   every registered field → trie rebuild → kernel rebuild → **full re-upload + re-dispatch of
   everything**, competing with the load on the same GPU queue.

### The design principle

This is a producer/consumer pipeline with two compute substrates. It saturates when:

- each substrate holds a **deep queue of independent work** (no per-file cross-substrate
  synchronization — zero readbacks in steady state),
- GPU work arrives in **large, infrequent batches** whose cost is O(new bytes), never O(total bytes),
- CPU work is **fine-grained and overlapped** with GPU execution (double-buffered: CPU stages
  flush K+1 while GPU drains flush K),
- the **bottleneck is I/O** (disk/RPC), which is the only stage that cannot be parallelized away.

At steady state the load *should* be fetch-bound. Anything else on the critical path is a bug.

### Scenario and budgets (used throughout)

torvalds/linux ≈ 55k code files. Aggregate source far exceeds the arena's `maxBytes ≤ 2²⁴`
(16.7M source bytes; at `SLOT_STRIDE = 13` f32 = 52 B/slot + ordToByte 4 B + scan ladder ≈
**57–60 B of GPU per source byte**, a full arena is ~1 GB of VRAM). So the honest target is
two-tier: **everything seats** (bounds + tree position + colors known) in seconds; **glyph bytes
materialize** for the resident/visible working set (paging is the streaming/LOD proposal's job —
this pipeline is designed to feed it). Numbers below use a **100 MB resident storm**
(≈ 7k average files, 6× a full arena) because rates are linear; scale as needed.

| Stage | Rate assumption | 100 MB time |
|---|---|---|
| Go relay read + WS binary stream | 500 MB/s (localhost WS, streamed) | 200 ms |
| Worker: UTF-8 scan + line index + bounds (SWAR leader count) | ~400 MB/s/core × 7 workers | ~35 ms |
| Worker: tree-sitter (C) | ~30 MB/s/core × 7 workers | ~475 ms |
| GPU: 9-dispatch pipeline, delta-range | ~57 B traffic/byte @ 300 GB/s eff. | ~20 ms GPU total |
| Main thread: seat + stage | ≤ 100 µs/file × 7k | ~700 ms |

Critical path ≈ fetch stream (workers and GPU hide under it) + tail flush ≈ **1–2 s for 100 MB**,
vs. the current 20 s for ~1k files. The rest of this document is how each line is achieved.

---

## 2. Design

### 2.1 What belongs on CPU — and why

Rule: **branchy, irregular, sequential-dependent, or latency-tolerant → CPU.** All of it per-file
independent, so it parallelizes across the existing pool.

**(a) Fetch / RPC framing** — stays off-GPU obviously, but moves from the main thread's
await-barrier to a stream. `RemoteFileSystemProvider.getMultipleFiles` currently resolves
all-or-nothing with concurrency 8 and decodes to strings on the boundary. Ideal: the relay streams
files (batched, tree order) as raw bytes on the existing binary result plane; the client routes
each `ArrayBuffer` to a worker by least-outstanding-count. No `TextDecoder`, no strings, ever —
the arena only wants `Uint8Array`, and today `CodeGrid._beginLoad` pays `split('\n')` +
`TextEncoder.encode` to go string → bytes → string-derived-index.

**(b) One fused per-file byte pass (worker).** In a single pass over the bytes, SWAR-style
(8 bytes/iteration over `Uint32Array` views, leader bytes identified by `(b & 0xC0) != 0x80`):
- UTF-8 sanity/leader classification,
- the byte line index (`lineByteStart` + leader-count `lineLengths` — exactly what
  `buildByteLineIndex` in `core/ByteLayoutDescription.js:163` does in two passes today),
- **exact per-item layout bounds** (see 2.3),
- per-line wide-glyph (emoji 2×) counts from a boot-transferred width-class table.

Cost ≈ 300–600 MB/s/core in JS typed-array code; hidden entirely under fetch.

**(c) Tree-sitter tokenization (worker).** `analyzeGrid` moves into the pool: one tree-sitter WASM
instance per worker (WASM is per-instance, so one per worker, matching how the single instance is
used today). Per-file parse + capture query is 1–5 ms of branchy pointer-chasing — the canonical
CPU workload. Output is **not** per-glyph colors; it is a compact token-range list
`(byteStart, byteEnd, paletteIndex)` ≈ 16 B/token, tokens ≈ bytes/8 → **~2 B/byte** uploaded
instead of 12 B/byte of per-glyph RGB painted via `setGlyphColorRange` on the main thread.
Generation tokens (already in `SyntaxColorizer`) keep superseded parses from committing.

**(d) Shaping of the rare complex runs (CPU, off critical path).** Already true and correct:
HarfBuzz is branchy and low-throughput; it stays on CPU, primed at boot over `LARGE_CORE_RANGES`,
with misses landing on the GPU miss ring. The change is *when* the miss continuation runs
(timer-coalesced, range-targeted — see 2.5), not *where*.

### 2.2 What belongs on GPU — and why

Rule: **regular, data-parallel, uniform-control → GPU.** That is precisely the existing 9 kernels
plus one new one:

- `decodeAndResolve` (per byte: UTF-8 → trie → glyphId/advance) — keep. Per-byte decode on GPU is
  fine *because* it is one dispatch over a large batch with two dependent loads; it is not fine
  as 100 tiny re-dispatches (fixed in 2.4).
- The 5-stage scan, `resolveX`, `deriveStrides`, `paginateAndBounds` — keep, made delta-range (2.4).
- **NEW: `expandColors`** — thread per *token range* (not per glyph): writes the palette color
  into `instanceColor` for `[byteStart, byteEnd)` in the mega-field's color attribute. Coalesced
  run fills, no searching. Runs in the same flush batch as the other dispatches; re-runs for one
  item's ranges when a late tree-sitter result lands (see 2.6).
- Per-frame: group-pose sweep, per-group alpha cull, fragment coverage — unchanged, already right.

Deliberately **not** on GPU: tokenization (branchy WASM, bad SIMT fit), file I/O, shaping
(low occupancy, tiny data), line indexing (needed on CPU anyway for caret; doing it twice wastes
the CPU's idle cycles that would otherwise just wait on the fetch stream).

### 2.3 Kill the steady-state bounds readback: exact CPU bounds

This is the single highest-leverage change. `readItemBounds()` exists only because layout
position = f(row, col, advance) was computed GPU-side. But the layout is **closed-form**:

- monospace advance is the forced 'M' advance for every glyph except width-class-2 (emoji, 2×) —
  the worker's fused pass already counts leaders and wide glyphs per line;
- wrap is `fold when advance-sum > wrapWidth`; rows = Σ max(1, ⌈len/W⌉), extent cols = min(maxLen, W);
- pagination is a pure remap of (row, col) through `pageRows/pageCols/pagesWide/pageGapX`
  (the same integer lanes `S_ROW/S_COL/S_BASE_X` the kernels compute);
- z-extent is a function of band depth (`depthPerBand/depthPerCol`), also closed-form.

So the worker emits, per file, the exact 6-float box the `paginateAndBounds` kernel would have
atomically reduced — verified bit-exact against `glyphPipelineReference.js`, the executable oracle
that already exists for parity testing. Consequences:

- `CodeGrid` seats with **real bounds synchronously**; `pipeline.laid` and the settle-phase
  `Promise.allSettled` wait on GPU drain **disappear from the load path**;
- `readItemBounds()` and `readMisses()` leave the per-flush path (misses: one timer-coalesced
  check per ~250 ms during storms);
- tree "pours" (`contentTree.relayoutAndRest`) stop consuming estimated-then-corrected layouts.

Risk: CPU/GPU semantic drift. Mitigated by construction — both sides derive from the same
constants (`glyphPipelineReference.js` lanes, trie advance table shipped to workers at boot), and
the existing parity harness (`readSlots`/`verify`) gains a bounds-lane check run in CI, not in
the load path.

### 2.4 Delta-range flushes with scan carry-in

Today: flush sizes all 9 dispatches by total live bytes. The arena is **append-only between
reallocs**, so a delta flush over `[byteStart, byteEnd)` is sound *if* the scan ladder seeds from
the monoid state at `byteStart` instead of zero:

- The monoid (the `P_STRIDE = 8` lanes: row, col, lineAdv, ord, …) at the previous flush's end is
  already computed by that flush's `apply` stage. Have `apply` also write the final chunk's state
  to a tiny persistent `flushFrontier` (8 × u32) buffer. Next flush: `chunkReduce`/`spineReduce`/
  `partialScan` index chunks globally, and `spineScan` seeds lane 0 from `flushFrontier`
  (one extra uniform load in what is currently the one-thread serial stage — free).
- Flush boundaries are naturally file-aligned (stage() appends whole files), so no line ever
  straddles a frontier; `resolveX`'s `ordToByte` re-sum stays within one item.
- Full re-scan from zero still happens on arena realloc (rare, ×2 growth) — acceptable, and it is
  the *only* O(total) pass left.
- Effect: flush cost becomes O(new bytes). The storm's GPU total drops from
  Σ_k (bytes_k) ≈ N²/2 quanta to N quanta — at 100 flushes that's the ~50× mentioned above.

**Flush cadence.** Replace the macrotask-window coalescing with a byte-quantum policy:
flush when **≥ Q staged bytes** (Q adaptive: 1 MB at storm start for fast first paint, growing to
8 MB) **or 100 ms elapsed**. GPU gets chunky batches (dispatch overhead 9 × ~30 µs amortized over
MBs, not KBs), and the seating loop never waits on the GPU.

**Overlap.** Nothing in `_flushNow` should be awaited by the seating loop. Submit flush K,
keep staging K+1. The only synchronization left anywhere is the rare realloc and the background
miss continuation — both generation-guarded already.

### 2.5 Miss flow without convulsions

Keep the miss ring (`maxMisses = 4096`, atomic append in `decodeAndResolve`) but:

1. Poll it on a **timer** during storms (250 ms), not per flush — removes one readback per flush.
2. On atlas grow: with `MegaGlyphField` there is exactly **one** field to hot-swap (the "200→606
   fields per grow" storm was the pre-mega world); keep it that way — a hard invariant: atlas
   growth must never iterate fields.
3. The re-dispatch after a trie rebuild touches **only the items whose bytes referenced the new
   codepoints** — the miss ring already knows codepoint; record item index alongside it (or
   re-derive by range). Range-targeted re-run of kernels 1, 7, 9 over those items' byte ranges,
   not `setFiles(everything)`.
4. Coalesce all grows in a storm window into one encode pass (`ensureGlyphsEncoded` batch) —
   one trie rebuild per window, not per codepoint sighting.

### 2.6 The full pipeline — diagram

Scenario: 100 MB resident storm, 7 workers, target wall ≈ 1–2 s. Lanes are concurrent; time →.

```
Go relay          listTree ──▶ stream files (tree order, batched WS binary frames)
─────────────────────────────────────────────────────────────────────────────▶
WS/client         frame router (least-outstanding)      ~500 MB/s sustained
   │ ArrayBuffer (transfer, no copy)
   ▼
Workers ×7  per file, ONE fused pass:
            ┌─ bytes → line index + leader/wide counts + EXACT bounds   (~35 ms total)
            ├─ tree-sitter parse → token ranges (16 B/token)            (~475 ms total, hidden)
            └─ transfer {bytes, lineIndex, bounds, ranges} back
   │ Transferables
   ▼
Main thread per file (≤100 µs):
            CodeGrid seat (bounds known NOW — no laid gate)
            arena.stage(bytes)            → append-only upload
            ranges → token-range buffer   → append-only upload
            ── never awaits the GPU ──
   ▼                        ▼
GPU queue   flush K: [decode | scan×5 (carry-in) | resolveX | strides | paginate | expandColors]
            sized by delta bytes only; ~1–3 ms per 4 MB quantum
            flush K+1 staged WHILE K executes
            (async, timer-driven: miss poll → atlas grow → range re-dispatch)
   ▼
Render      1 draw (MegaGlyphField) + N panel draws — unchanged
```

Both substrates saturated simultaneously: workers parse file *i+n* while the router fetches
*i+m* and the GPU lays out *i*. The pipeline's critical path is the WS stream; everything else
has ≥10× headroom under it.

### 2.7 Worker-pool mechanics (feeding the GPU queue without readbacks)

- **Reuse `WorkerBridge`** (pool sizing, lazy init, Transferable plumbing already exist) but add
  least-outstanding routing instead of pure round-robin — file sizes are log-normal, so
  round-robin strands a big file on one worker while others idle.
- **Push, don't request/reply per buffer**: one `LOAD_FILE` message in, one `FILE_READY` message
  out with `[bytes.buffer, lineIndex.buffer, ranges.buffer]` as Transferables. No shared memory
  needed; SAB/atomics are a later optimization if message overhead shows (it won't at 7k files).
- Boot transfer once per worker: width-class table + trie advance table + tree-sitter grammar
  (mirrors the existing `GLYPH_MAP` distribution).
- **Zero GPU readbacks in steady state** is the hard rule this design is built around:
  bounds → CPU closed form; misses → timer; scan frontier → GPU-resident buffer. The remaining
  awaits are realloc and miss continuation, both backgrounded and generation-guarded.

---

## 3. Mapping onto existing seams

| Proposal element | Touches | Notes |
|---|---|---|
| Streamed binary fetch | `cli/fs.go` (add streamed batch RPC), `RemoteFileSystemProvider.getMultipleFiles` | binary result plane already exists; drop the all-or-nothing `Promise.all` and the `TextDecoder` |
| Fused worker byte pass | new `workers/filePrepWorker.js`; replaces `CodeGrid._beginLoad`'s `split/encode/buildByteLineIndex` (`CodeGrid.js:277`) | reuses `core/ByteLayoutDescription.js` constants; keeps the CPU line index for caret |
| Exact CPU bounds | worker (above) + `CodeGrid._layoutContent` (`CodeGrid.js:1131`) seats bounds synchronously | parity-checked against `glyphPipelineReference.js`; `readItemBounds`/`laid` become debug-only |
| Tree-sitter in workers | `parsing/SyntaxColorizer.js` → job in the pool; output = token ranges | removes `parseSyncMs` from main thread; keeps generation-token abort |
| `expandColors` kernel | `compute/GlyphPipelineKernels.js` (10th kernel) + token-range buffer in `GlyphPipelineArena.js` | thread-per-range writes into MegaGlyphField `instanceColor`; re-runnable per item on late parse |
| Delta-range scan + `flushFrontier` | `glyphPipelineScan.js` spec, kernels 2–6 seeding, `_setDispatchCounts` | the O(N²)→O(N) fix |
| Byte-quantum flush policy | `GlyphPipelineArena.requestFlush/_flushNow` | replaces `setTimeout(0)` coalescing; adaptive Q |
| Timer-based miss flow + range re-dispatch | `GlyphPipelineArena` miss continuation, `liveTrie.js`, `LiveSlugAtlas.ensureGlyphsEncoded` | one-field-swap invariant; batch grows per window |
| Seating-loop slimming | `fileCommands.js` openDir + `CodeGrid` constructor | with bounds synchronous, the 12 ms slice loop must sustain ≥ 10k files/s; per-grid object churn (panel mesh, materials) becomes the next main-thread cost — flag to the app-shell proposal |

Unchanged on purpose: `MegaGlyphField` single-draw architecture, group-texture pose system,
Slug curve textures, boot priming over `LARGE_CORE_RANGES`, `TerminalGrid`/`FrameGrid`'s legacy
Layer-1 path (they keep `buildBatchBuffers`).

---

## 4. Risks / open questions

- **CPU/GPU bounds drift.** The whole readback elimination rests on closed-form bounds matching
  kernel semantics (wide-glyph advances, fold-at-advance vs fold-at-column, page-gap math).
  `glyphPipelineReference.js` makes this testable, but it must be *continuously* tested or the
  tree layout will silently mis-measure grids. (Fallback: keep `laid` as a late correction, off
  the critical path.)
- **Residency ceiling.** 57–60 B/byte means a full 16.7M arena ≈ 1 GB VRAM; the 55k-file linux
  tree cannot be glyph-resident at once. This design *feeds* a paged/streaming arena but doesn't
  build one; delta-scan carry-in generalizes to paged residency by storing one frontier per page.
  Depends on the streaming/LOD and slot-compression proposals for the full-tree dream.
- **Tree-sitter WASM in workers** — per-worker grammar + WASM memory (~tens of MB × 7). Fine on
  desktop; worth measuring once. Also: syntax colors arriving *after* glyphs means a visible
  recolor flash; mitigated because parse (~475 ms total) beats fetch (~2 s), so most ranges land
  before first paint of their file. Worst case, `expandColors` re-runs per item — cheap.
- **First-paint latency vs batch efficiency** is a real tension in the flush quantum; the
  adaptive Q (1 MB → 8 MB) is a guess that needs `loadTrace`/`loadStats` measurement.
- **Relay throughput** (500 MB/s assumed) is unmeasured. If the WS binary plane tops out lower,
  fetch dominates even more and everything else hides further — the design degrades gracefully,
  but the 2 s target needs the relay measured first.
- **Spine stages are latency, not throughput** (one-thread `spineScan`); at 16.7M bytes it's
  ~1020 supers — fine, but if maxBytes grows via compression, revisit (two-level spine already
  exists structurally).

---

## 5. Effort estimate

| Item | Estimate |
|---|---|
| Delta-range scan + `flushFrontier` carry-in (kernels 2–6, arena bookkeeping, scan-spec update) | 3–5 d |
| Worker fused byte pass + exact bounds + parity tests vs the oracle | 3–4 d |
| Tree-sitter worker pool + token ranges + `expandColors` kernel | 3–5 d |
| Streamed binary fetch (relay + provider + router) | 2–3 d |
| Miss-flow timer + range-targeted re-dispatch + one-field-swap invariant | 2 d |
| Flush-quantum policy + instrumentation on `loadStats`/`loadTrace` | 1–2 d |

**Total ≈ 2.5–3.5 weeks** for one engineer, mostly in `compute/GlyphPipelineKernels.js`,
`compute/GlyphPipelineArena.js`, a new `workers/filePrepWorker.js`, and `parsing/SyntaxColorizer.js`.
No changes needed to the renderers, atlases, or boot path.

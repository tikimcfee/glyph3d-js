# Load-Path Orchestration and Budget — "open torvalds/linux, visible in seconds"

**Scope:** end-to-end orchestration of the bulk load: enumerate → read → transport → stage →
layout → colorize → atlas → upload → first visible frame, for tens of thousands of static
files. This designs the ideal, mapped onto the real seams (`cli/fs.go`,
`RemoteFileSystemProvider`, `app/commands/handlers/fileCommands.js`,
`compute/GlyphPipelineArena.js`, `compute/glyphPipelineKernels.js`, `MegaGlyphField.js`).
It assumes the byte-in GPU pipeline (Layer 2, `docs/plans/gpu-bounds-and-byte-pipeline.md`)
is the layout engine — that is now the live path via `GlyphPipelineArena`.

---

## 1. Problem framing

### 1.1 Reference corpus

| quantity | value |
|---|---|
| files (post-filter, `isTextFile` + skipDirs) | ~30,000 |
| total UTF-8 bytes | ~250 MB (median ~6 KB, p99 ~200 KB, capped at 10 MB) |
| slots (1 per byte, byte-indexed pipeline) | ~250 M |
| persistent slot memory @ current 13 f32/byte | **13 GB — infeasible** |
| groups (2 per file: filename + content) | ~60,000 |

Two hard walls shape everything below:

1. **The VRAM wall.** `slots` costs 52 B per source byte (`SLOT_STRIDE=13`,
   `glyphPipelineReference.js:77`). 250 MB of text → 13 GB. No commodity GPU holds that.
   The arena is also hard-capped at 2^24 bytes (~16 MB text) per arena for f32 ordinal
   exactness. **Full-residency of the whole tree is not an option; the orchestration must
   include a residency/LOD policy, not just a fast pipe.**
2. **The string wall.** Today every file becomes a main-thread JS string
   (`RemoteFileSystemProvider.contentOf` → `TextDecoder`), then is re-encoded
   (`CodeGrid._beginLoad` → `TextEncoder`) — two full copies of 250 MB through the JS heap
   plus `split('\n')` arrays. Strings are pure waste: the GPU pipeline decodes UTF-8 itself
   in dispatch 1. The ideal path never materializes a string.

### 1.2 What "3–5 seconds" must mean

Three distinct finish lines, priced separately:

- **T0 — scene complete (placeholder tier):** every file has a panel, a position, and an
  estimated extent. Target **≤ 0.5 s**.
- **T1 — first visible frame with real text:** nearest files laid out, monochrome.
  Target **≤ 1.0 s**.
- **T2 — all files laid out** (monochrome, correct bounds): target **≤ 4 s** warm,
  bounded below by disk+transport, not by compute.
- **T3 — colorized:** visible set ≤ 2 s; full corpus is an idle-time task, explicitly
  not on the clock.

---

## 2. Design

### 2.1 Pipeline overview

```
Go relay                     WebSocket (binary)              Browser main thread              GPU queue
─────────                    ──────────────────              ─────────────────────            ─────────
WalkDir ──► MANIFEST frame ────────────────────► place grids (matrices only)
                                                      │ estimated extents → panels     ──► draw panels (T0)
client computes priority order ◄── PRIORITY msg ──────┘
64-way pread ──► DATA frames (1–4 MB, tar-like) ──► demux: views into ring
                                                      │ stage() per file (bytes+item row)
                                                      ├─ flush window @16 MB or 8 ms ──► appendFiles → 9 dispatches
                                                      │                                  (decode/scan/x/paginate+bounds)
                                                      │ ◄── bounds readback (pipelined, N-1)
                                                      └─ swap view placeholder→laid    ──► 1 instanced draw
workers (post-T1): tree-sitter colorize, byte-range patches ──► instanceColor update ranges
```

### 2.2 Stage budget (30k files / 250 MB, commodity desktop: NVMe, 8 cores, mid dGPU)

| # | stage | budget | notes |
|---|---|---|---|
| 1 | enumerate (Go `WalkDir`) + manifest | 100 ms | overlaps stream; manifest is binary, ~2 MB |
| 2 | priority handshake | 15 ms | one RTT; client sends permutation (see 2.4) |
| 3 | read bytes (Go, 64-way pread) | 150–1200 ms | warm page cache ~2 GB/s; cold ~250–600 MB/s effective on 30k small files |
| 4 | transport (localhost WS binary, 1–4 MB frames) | 150–250 ms | pipelined with 3; combined 3+4 ≈ max(disk, WS) |
| 5 | demux + stage (no strings, view copies) | 60 ms | memcpy-bound, spread across stream |
| 6 | GPU flush windows (16 × 16 MB) | 160 ms GPU | ~10 ms/window: upload ~4 ms + 9 dispatches ~6 ms; fully overlapped with 3–5 |
| 7 | bounds readbacks | ~0 (pipelined) | double-buffered; resolves `laid` one window late |
| 8 | atlas | ~0 warm / 300 ms cold | IndexedDB-baked slug core already exists; misses batched per window, trie append-patch |
| 9 | colorize (workers) | off critical path | visible ~60 files in first 500 ms; corpus-wide on idle |
| 10 | first visible frame | **~0.4–0.5 s** | needs only: manifest + poses + first window laid out |
| — | **T2 total (all text laid out)** | **~0.8 s warm / 2.5–4 s cold** | stream-bound, see §4 |

### 2.3 The relay: one stream, not 30k RPCs

Today: `getMultipleFiles` issues 8-way concurrent individual `fs/readFile` JSON-RPCs
(`RemoteFileSystemProvider.js:238`), each answered via the `displayWrite` channel
(cap 64) with a framed binary blob (`sendRPCBinaryResult`, `fs.go:385`). At 30k files
this is 30k request/response pairs, 30k header parses, and per-RPC goroutine +
10 s timeout machinery.

Replace with a single **`fs/streamTree`** RPC:

- **Manifest frame** first: binary, per entry `[pathLen:u16][path][size:u32][flags:u8]`
  (flags: binary/oversize → placeholder, never streamed). Produced by the existing
  `handleListTree` walk (`fs.go:755`) but emitted as it walks, so the client starts
  placing grids while the walk finishes. 30k entries ≈ 2 MB.
- **Priority handshake:** client answers with `[count:u32][index:u32…]` — a permutation
  of manifest indices in desired stream order (~60–120 KB). See §2.4. If the client
  never answers (old client), Go streams in walk order after a 100 ms grace.
- **Data frames:** concatenated `[pathIdx:u32][size:u32][raw bytes]` records, packed
  into 1–4 MB WS binary messages, one record boundary alignment per message so the
  client splits without parsing. Go reads with ~64-way concurrent `pread` against a
  completion queue writing records in priority order (out-of-order completion is fine —
  each record is self-describing; the client stages whatever arrives).
- **Credit-based backpressure:** client grants N bytes of credit (default 32 MB);
  each data frame consumes, each *staged-and-flushed* window returns credit. This is
  the only mechanism that keeps 250 MB from landing in the JS heap at once, and it
  naturally throttles a fast disk behind a slow GPU.

Files larger than `READABLE_MAX_CHARS` (1 MB) ride the existing `addUnfetchedGrid`
placeholder path unchanged — they are excluded from the stream by the manifest flags.

### 2.4 Progressive: three tiers, nearest-first

**Must all files be laid out before first paint? No — and they can't be (VRAM wall).**

- **Tier 0 (placeholder, every file, ≤ 0.5 s).** The manifest alone suffices: the client
  already positions grids CPU-side (node matrices are app state), and panel extents come
  from a closed-form estimate — `rows ≈ ceil(size / estCols)`, using the arena's layout
  params — exactly the spirit of `foldExtent` being a formula. 30k panels are 30k groups
  in the existing group-texture system (60k with filenames: group texture must start at
  65,536 rows, not 4 — one alloc, not 14 doublings). The scene is *complete* before a
  single byte arrives; text upgrades in place.
- **Tier 1 (laid-out monochrome).** Files upgrade in stream order. Priority order =
  frustum ∩ distance at handshake time, then radius-swept outward ("nearest-first").
  Each flushed window swaps its views from placeholder to laid by resolving `laid`
  (the arena already has this promise per item) and updating the stated extent from the
  pipelined bounds readback. Because extents are *stated* (`setLayoutExtent`), an
  estimate → measured correction is a non-event visually: panels resize slightly, text
  appears.
- **Tier 2 (colorized).** Tree-sitter moves to a **worker pool**
  (`hardwareConcurrency − 2`), one WASM instance each, fed `Uint8Array` slices
  (transferable, zero-copy from the staging ring before it's recycled). Captures return
  as byte-range runs `(startByte, len, colorIdx)` and paint `instanceColor` update
  ranges — contiguous byte-range paints, which the byte-indexed design already makes
  natural. Order: visible-first, then idle. Main thread only applies patches (a
  per-window coalesced `addUpdateRange`), never parses.

Monochrome-first is the key progressive bet: default-color text at T1 is fully readable;
color is polish that chases the user.

### 2.5 Zero-CPU staging (killing the per-file O(fileBytes) main-thread work)

Today, staging a file costs the main thread: `TextEncoder.encode`, `split('\n')`,
`buildByteLineIndex`, `appendFiles` **per-byte JS packing** into `byteWords`, two
O(fileBytes) attribute fills (`setGlyphGroupRange`, `setGlyphColorRange` in
`MegaGlyphField._attachView`), and an O(V log V) `_reindexRanges()` re-sort **per
attach** — at 30k attaches that last one alone is quadratic-ish (30k × log·growing-V).

Ideal staging a file = **append bytes + append one `itemTable` row. Nothing else.**

- **No string, no encode, no split.** The WS frame *is* UTF-8 bytes; the record view
  is staged directly. `buildByteLineIndex` (needed by picking/caret) is built lazily
  per file on first interaction, or in a worker — never on the load path. (Picking
  resolves slot→byte offset already; the line table only serves char-level UX.)
- **byteWords packing moves to the GPU.** Upload raw u8 into a byte buffer
  (`writeBuffer` of the WS bytes directly — one copy, no JS loop) and let dispatch 1
  (or a trivial pre-pass, 1 thread per 4 bytes) pack into `byteWords`. Kills the
  250M-iteration JS loop that would otherwise dominate stage 5.
- **groupId + default color fill in dispatch 1.** The kernels already binary-search
  `itemStarts`; a slot's item → its groupId and default color. Write `instanceGroupId`
  and `instanceColor` from the decode kernel. The CPU attach loops disappear.
- **`_reindexRanges` becomes per-window, not per-file** (one rebuild per flush), and
  ideally an append-only array with a dirty flag sorted once per window.

### 2.6 Flush-window scheduler (main thread ↔ GPU queue)

Replace the single coalescing `setTimeout(0)` flush (`GlyphPipelineArena.requestFlush`)
with a **window scheduler**:

- Windows close at **16 MB of staged bytes or 8 ms elapsed**, whichever first.
  16 MB = one arena generation at the 2^24 cap → predictable realloc cadence, ~16
  windows for the corpus.
- Per window: `appendFiles` (raw u8 upload) → `kernels.run()` (9 dispatches, ~6 ms GPU
  for 16M threads) → bounds readback issued **pipelined**: read window *n−1*'s
  `itemBoxes`/`foldScalars` while window *n* computes. `laid` resolves one window late
  (~10 ms) — invisible.
- The GPU queue never goes idle waiting for the network (window closes on time too),
  and the network never outruns the GPU (credits, §2.3).
- Miss flow per window, not per grow: `readMisses` once per window, batch-encode all
  new glyphs, **trie append-patch** (pre-reserved blocks, the M1 item-4 design in
  `layer2-wiring-and-load-regression.md`) — no kernels rebuild, no `_realloc`, no
  re-attach storm. The known regression "atlas-grow hot-swaps every field per grow"
  is structurally dead if grows never rebuild the arena and textures swap per-object
  via `onObjectUpdate` (they already do).

### 2.7 VRAM residency and LOD (the orchestrator's memory budget)

Since 250 MB of text cannot be resident at 52 B/slot, the orchestrator owns a
**residency policy**:

1. **Slot compaction (prerequisite, owned by the kernel/field proposals but budgeted
   here):** split the 13 f32 working set from the render projection. Layout needs
   row/col/advance lanes transiently; the persistent per-slot render state is
   position (3×f16 or item-local u16), glyphId (u16), size (2×f16) ≈ **12 B/slot**.
   250 MB text → ~3 GB. Viable on dGPU, still too much for iGPU.
2. **Residency window:** fully lay out only a moving window of ~32–64 MB of text
   (nearest-first), ~0.4–0.8 GB VRAM compacted. Files outside the window stay Tier-0
   panels (with real measured extents after their first layout) and re-stage on
   approach. Re-staging is cheap precisely because staging is now bytes + item row.
3. **Multi-arena:** the 2^24 cap means the window spans 2–4 arenas; draws go from 1 to
   a handful — irrelevant against 30k groups.

The load-path budget above (T2 ≤ 4 s) is for *staging and first layout* of everything;
persistent residency is a separate, smaller budget. First layout of all files is still
worth doing (it produces honest extents for panels and minimap), after which far files'
slots are reclaimed.

### 2.8 Colorize scheduling

- Worker pool parses; main thread applies. Patch application is coalesced per flush
  window into one `addUpdateRange` per contiguous dirty span.
- Visible-first order from the same priority permutation used for streaming.
- Expected throughput: tree-sitter WASM ~1–3 ms per average file per worker → 30k
  files ≈ 6–13 s across 6 workers, entirely off the critical path, cancelable on
  navigation. Files > 200 KB get deferred to last.

---

## 3. Critical-path analysis

**Serial chain to first paint (T1):**

```
WS connect (≈20 ms) → manifest head (≈50 ms) → poses placed (≈30 ms for 30k matrices)
→ priority reply + first data records (≈60 ms) → stage + first flush window (≈15 ms)
→ one instanced draw (≈5 ms)                          ≈ 180–400 ms floor
```

**Parallel from there:** the byte stream (disk ∥ WS), demux/stage, GPU windows, atlas
encode, colorize — five lanes running concurrently, throttled by credits.

**Theoretical floor for T2 (all 250 MB staged):**

| lane | floor |
|---|---|
| disk, warm page cache | 250 MB @ 2 GB/s ≈ 125 ms |
| disk, cold (30k small files, 64-way) | 500–1000 ms |
| WS transport (1–4 MB frames) | 250 MB @ ~1.5 GB/s ≈ 170 ms |
| GPU upload (byteWords) | 250 MB @ ~5 GB/s ≈ 50 ms |
| GPU kernels (250M threads × ~9 dispatches, mostly 1-thread-per-byte) | 150–300 ms |
| GPU slot write traffic | 250M × 52 B ≈ 13 GB @ 500 GB/s ≈ 26 ms |

Lanes pipeline, so T2 floor ≈ max(lanes) + fixed ≈ **0.5–1.0 s warm, 2–3 s cold**.
The 3–5 s target carries ~1.5–2× headroom over the cold floor; the current
20 s-per-1000-files pace is ~100× off it, and the gap is structural (strings, per-file
RPCs, per-byte JS loops, per-file O(V log V)), not tuning.

**What is genuinely serial and irreducible:** WS connect; the first manifest chunk
before any placement; one flush window before the first glyph pixel; one readback
before any honest extent. Everything else parallelizes or pipelines.

---

## 4. Mapping onto existing seams

| design piece | existing seam | change |
|---|---|---|
| manifest+stream | `cli/fs.go` `handleListTree`/`handleReadFile`, `relay.go` display writer | new `fs/streamTree` method + binary frame codec; credit counter on the writer goroutine |
| stream demux | `WebSocketBridge._handleBinary` (`0x02` plane) | new frame type `0x03` (stream); reassembles 1–4 MB messages into records |
| priority order | new | computed from grid poses (already CPU state) + camera; sent as u32 index list |
| placeholder tier | `fileCommands.js` `addUnfetchedGrid` (oversize path) | generalized to "unlaid" state; extent = size-derived estimate, corrected by `setLayoutExtent` |
| string-free staging | `RemoteFileSystemProvider.contentOf`, `CodeGrid._beginLoad` | bytes-only path; `buildByteLineIndex` lazy; `content` string materialized on demand |
| zero-CPU attach | `MegaGlyphField._attachView` loops, `_reindexRanges` | groupId/color written by decode kernel; ranges rebuilt per window |
| raw-u8 upload | `GlyphPipelineArena.appendFiles` per-byte packing | `writeBuffer` of WS bytes + GPU pack pass |
| window scheduler | `GlyphPipelineArena.requestFlush`/`_flushNow` | byte/time-triggered windows, pipelined `readItemBounds` |
| batched miss flow | `LiveSlugAtlas.ensureGlyphsEncoded` + trie rebuild → `_realloc` | per-window batch + trie append-patch (M1 item 4) |
| worker colorize | `parsing/SyntaxColorizer.analyzeGrid`, `TreeSitterEngine` (main thread) | worker pool; byte-range patches applied per window |
| group texture capacity | `GlyphField._maxGroups=4` doubling | boot-sized from manifest count |
| instrumentation | `app/commands/loadTrace.js` marks, `core/loadStats.js` | add marks: `manifest`, `stream` (MB, credit stalls), `window` (n, ms), `tier1`, `tier2` |

---

## 5. Risks / open questions

1. **Slot compaction is a dependency, not a choice.** Without it T2 is a
   stage-and-evict pipeline, not full residency. It belongs to the kernel/field
   proposals; orchestration works either way but the LOD window size depends on the
   answer. (Coordination point.)
2. **Priority churn.** Camera moves during the stream invalidate the permutation.
   Mitigation: client may send a revised priority list mid-stream (Go re-orders the
   unsent tail); or accept walk-order tail. Unmeasured.
3. **WS throughput at 1–4 MB frames** on the Go → browser path is assumed ~1.5 GB/s;
   needs one measurement. If it collapses, an HTTP range fallback (fetch streaming
   into the same ring) is the escape hatch.
4. **Readback pipelining** assumes `mapAsync`-style non-blocking reads; three/webgpu's
   `readbackBuffer` path may serialize. If it stalls, move to GPU-side culling
   consumption of `itemBoxes` and resolve `laid` from a cheaper counter.
5. **Tree-sitter in workers** (web-tree-sitter WASM per worker) is standard but new
   here; grammar loading per worker adds ~50–100 ms pool warmup, hidden behind T1.
6. **Cold-atlas first run** (no IndexedDB bake): miss encode of the full CJK working
   set could add ~300 ms within the first windows. Blank-storm fix (uncoverable →
   blank without re-entering miss flow) is assumed landed.
7. **iGPU memory.** 64 MB residency window ≈ 0.8 GB compacted — fine; but the
   *transient* working set during a 16 MB window at 52 B/slot ≈ 0.8 GB on top.
   Window size may need to halve on integrated parts.

---

## 6. Rough effort estimate

| piece | estimate |
|---|---|
| `fs/streamTree` relay endpoint + credits | 3 d |
| client stream demux + staging ring + byte-only `CodeGrid` path | 4 d |
| priority handshake + nearest-first ordering | 2 d |
| window scheduler + pipelined readbacks | 3 d |
| zero-CPU attach (kernel groupId/color fills, per-window ranges) | 3 d |
| raw-u8 upload + GPU pack pass | 2 d |
| placeholder tier generalization + extent estimation | 2 d |
| worker colorize pool + patch application | 4 d |
| instrumentation + load-profile harness runs | 2 d |
| **total (orchestration, excl. slot compaction)** | **~3.5 weeks** |
| slot compaction + residency window/LOD | +1.5–2 weeks (shared with kernel proposals) |

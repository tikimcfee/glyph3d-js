# GPU layout kernel at scale — the ideal byte-in pipeline

Swarm assignment: design the ideal GPU compute pipeline that turns raw file bytes into
laid-out glyph instances for tens of thousands of files / tens of millions of glyphs,
and the GPU-driven render architecture it feeds.

Grounded against (real seams, all read for this report):
`compute/glyphPipelineKernels.js` (the 9-dispatch scan pipeline),
`compute/glyphPipelineScan.js` (the monoid scan spec),
`compute/glyphPipelineReference.js` (SLOT_STRIDE=13, byte-indexed),
`compute/GlyphPipelineArena.js` (one arena, stage/flush, append-only),
`compute/GlyphLayoutKernel.js` (the Layer-1 fold kernel it replaces),
`MegaGlyphField.js` (one mesh, per-view group-texel pose, group 0 = dead),
`GlyphField.attachBytePipeline` (byte-mode field), three r0.185.1
(`IndirectStorageBufferAttribute`, `geometry.indirect` → `drawIndexedIndirect`
in `WebGPUBackend.js:1850`).

---

## 1. Problem framing

Target shape: a source tree like `torvalds/linux` — 30–80k files, 300–800 MB of UTF-8,
10–50M glyphs (conservative: 20M glyphs persistent). Content is static; views
(CodeGrids) are placed once and mostly watched, occasionally scrolled/edited one at a
time. Current pain: ~1000 files in 20 s.

### The one number that decides the architecture

The proven byte pipeline carries **SLOT_STRIDE = 13 f32 = 52 B per byte-slot**
(`glyphPipelineReference.js:77`), plus `ordToByte` (4 B/byte) and the scan ladder
(P_STRIDE=8 u32 per 64-byte chunk ≈ 1 B/byte). Call the layout working set **~57 B per
source byte**.

| corpus | bytes | layout working set @57 B/B |
|---|---|---|
| 1k files | ~15 MB | ~0.9 GB — fits, today's arena shape |
| 10k files | ~200 MB | ~11 GB — does not fit |
| linux-scale | ~600 MB | ~34 GB — absurd |

The arena header already warns a 16M-slot alloc OOM'd the GPU process
(`GlyphPipelineArena.js:68`). So at target scale the fat per-byte slot truth **cannot be
the persistent representation**. Everything else in this design follows from that.

Second number: glyphs are few, bytes are many (continuation bytes, and newlines render
nothing). The render pass needs, per *leader* glyph: position (16 B), glyphId+color+
item+byteOffset (16 B) = **32 B per glyph, ~1 B per source byte amortized**. The
persistent render set for 20M glyphs is ~640 MB — comfortable; for 50M, 1.6 GB —
workable. The gap between 57 B/byte (layout truth) and ~1.6 B/byte (render truth) *is*
the design problem.

Third number: per-file dispatches are a non-starter. 10k files × 9 dispatches = 90k
encodes ≈ 5–9 s of pure CPU encode at 60–100 µs/dispatch. The arena's one-mega-dispatch
shape (already built) is correct and must be kept.

## 2. Design: Bake-and-Stream

Three memory tiers replace the single monolithic arena:

```
┌─────────────────────────────────────────────────────────────────┐
│ BYTE SLAB (persistent, whole corpus)                            │
│   u32 words, 4 bytes/word — exactly the repo's packBytes layout │
│   ~1 B/byte. 600 MB corpus = 600 MB. Never freed per-session.   │
│   This is the ONLY content truth; everything else is derived.   │
├─────────────────────────────────────────────────────────────────┤
│ LAYOUT SCRATCH (transient, slab-budgeted, e.g. 64M slots)       │
│   slots (52 B/B), ordToByte (4 B/B), partials ladder (~1 B/B)   │
│   64M-byte slab ⇒ ~3.7 GB peak, reused for every slab and for   │
│   any single-item re-layout. Sized by budget, not by corpus.    │
├─────────────────────────────────────────────────────────────────┤
│ INSTANCE POOL (persistent, compacted leaders only, SoA ×2)      │
│   rec = { vec4 pos | u32 glyphId, u32 colorRGBA8,               │
│           u32 itemId:16|flags:16, u32 byteOffset }  = 32 B      │
│   The render set. Per item: contiguous range [instBase, instN). │
│   20M glyphs = 640 MB.                                          │
└─────────────────────────────────────────────────────────────────┘
```

Pipeline per slab (a slab = as many whole items as fit the scratch budget; items never
straddle slabs):

```
stage   CPU: memcpy bytes into byte slab + item-table rows. NO per-byte JS loop.
bake    GPU, one mega-dispatch set per slab (9 → 7 dispatches, §2.2):
        decode → 5-stage monoid scan → resolveX → paginate+EMIT
        EMIT compacts leaders via ordToByte into the instance pool,
        reduces per-item boxes (existing itemBoxes atomics), writes
        each item's instance range [instBase, instN) into the item table.
```

Per-item re-layout (scroll / pagination change / edit of the one grid being touched)
re-runs the same kernels over just that item's byte range in the scratch (a 20 KB file =
microseconds; a 400 KB monster < 1 ms), re-emitting into its reserved instance range
(capacity = leader count, known from the monoid's `glyphs` total after first bake —
re-emits can only shrink the count on scroll, and wrap/edit growth spills to a small
overflow tail per item, compacted lazily).

This replaces the arena's "everything hot forever" with "bytes hot, layout on demand" —
and it deletes the documented append-only leak (`GlyphPipelineArena.js:37`): the
instance pool and byte slab use range free-lists per item; dispose frees ranges;
defrag is a GPU copy of whole-item contiguous runs plus item-table patches, run
between loads.

### 2.1 Line-breaking / wrapping on GPU over raw bytes

Keep the repo's proven answer — the segmented monoid scan
(`glyphPipelineScan.js`): newlines, head/tail run lengths, tail advance, and rows are a
monoid; item starts are absorbing resets; a leader's exclusive prefix yields exact
integer `row`/`col` in O(1). At scale this choice is *more* right, not less:

- The alternative (the retired racing walk) has a coherence-window correctness risk on
  real hardware and schedule-dependent cost; the scan is bit-deterministic under every
  schedule — a hard requirement when 30k items share one dispatch and one bug report
  could implicate any of them.
- Wrapping is closed-form on the integer lanes (`floor(col/wrap)`), so fixed-cell wrap
  costs nothing per se; proportional line-breaking is out of scope for code (monospace
  cell grid, real advances summed only within the fold unit — the existing x-precision
  discipline in `glyphPipelineReference.js:33` stays).
- Scan ladder constants: CHUNK_SIZE=64, GROUP_SIZE=256. At slab scale (64M bytes) the
  ladder is 1M partials + 4k supers — a two-level raking scan suffices; a third level
  only matters past ~4 GB slabs, which the scratch budget forbids anyway.

### 2.2 Single fused kernel vs multi-pass

Per-slot passes over a 64M-slot scratch are bandwidth, and bandwidth is the bake budget:

| pass | traffic (64M slots) | fused? |
|---|---|---|
| decode | read 64 MB bytes + trie, write ~24 B/slot = 1.5 GB | **fuse into chunkReduce**: the fold reads cp/advance per byte anyway; decode in-register, ~20 instr/byte. Saves a 1.5 GB write + 1.5 GB read. apply re-decodes per byte (2 trie loads) — recompute beats memory here. |
| scan ladder (5) | partials only, ~400 MB total | keep — dispatch overhead is µs, and these are tiny. |
| apply | write row/col/ord lanes ~1.7 GB | keep (writes the scan's output). |
| resolveX | r/w ~3.3 GB | keep separate ONLY where the repaginate fast path matters (active grid). In the bake path: **fuse resolveX + paginate + emit** into one pass — static content never repaginates without a re-bake trigger. Saves ~3 GB/slab. |
| emit | read lanes, write 32 B/leader ≈ 2 GB | see above |

Bake path: **7 dispatches/slab** (decode-fold, 4 scan stages, apply, fused
resolveX-paginate-emit). Per-slab GPU time estimate at 500 GB/s effective: ~6 GB moved
≈ 12–18 ms; a 600 MB corpus = 10 slabs ≈ **150–250 ms of GPU bake**, fully pipelined
behind byte staging. That is the "tens of thousands of files in seconds" headline: the
GPU is no longer the bottleneck; ingest and staging are (§2.3).

Interaction path stays multi-pass: scroll = strides+paginate over the scratch for the
one active item (the existing `repaginate()` shape, `glyphPipelineKernels.js:1120`).

### 2.3 10k+ files: one mega-dispatch, and CPU authoring done right

**Dispatch strategy: one mega-dispatch set per slab, items concatenated, isolation by
monoid reset.** No per-file dispatches (90k encodes, above). No indirect compute —
WebGPU has none and doesn't need it: dispatch widths (byteLength, chunkCount) are known
on the CPU *before* upload, because staging is CPU-side. Indirect *dispatch* is a
solution in search of a problem here; indirect *draw* is the real thing (§2.4).

**Item resolution per thread.** Today every per-byte pass binary-searches `itemStarts`
(~14 dependent loads at 10k items, ×4 passes × 64M threads). Replace with a
**byte→itemId map** (u16 per byte supports 65k items): filled CPU-side during staging
with one typed-array `.fill` per item (memcpy-speed), then one coalesced load per
thread. 2 B/byte scratch, kills ~50 dependent-load latencies per byte per bake. The
monoid scan still owns isolation; the map is a param-lookup accelerator only.

**CPU authoring budget per 10k-file storm:**
- byte staging: currently `appendFiles` packs **byte-by-byte in JS**
  (`glyphPipelineKernels.js:1031` — a ~600 M-iteration loop ≈ seconds). Fix: a
  `Uint8Array` *view over the same ArrayBuffer* as the u32 words (little-endian x86/ARM
  makes the 4-per-word packing identical) turns staging into one `.set()` per file —
  ~1–2 GB/s ⇒ **0.3–0.6 s per 600 MB**, and less with worker-side staging into shared
  memory.
- item table: 10k × ITEM_STRIDE floats of `.set()` — nothing. Origins come from the
  placer (CPU-trivial: 10k vec3s).
- bytes straight from disk: the Go fs-RPC relay already serves file bytes —
  `TextEncoder` is only needed for *edited* strings. Disk bytes → byte slab with zero
  string materialization anywhere.
- itemId map fills: 10k `.fill`s — nothing.
- **zero readbacks on the bake path** (bounds readback moved off the critical path, §2.5).

Total CPU: well under 1 s for linux-scale. The load budget becomes: fetch/decompress
bytes (relay, parallel) ≈ 1–2 s, stage ≈ 0.5 s, bake ≈ 0.2 s — **2–3 s for the full
tree**, vs 20 s per 1k files today.

### 2.4 Feeding the render pass: GPU-driven, cull-in-compute, one draw

The instance pool is the render set; the fat slots never bind to a material. Per frame:

```
cull kernel   one thread per LIVE ITEM (10k threads):
              read itemBoxes (already GPU-resident, written by emit),
              transform by the view's pose (group texture / pose buffer —
              MegaGlyphField's _syncPoses already authors these),
              frustum-test → per-item visible flag
              prefix-scan flags (10k elements — one tiny 3-dispatch scan,
              or one workgroup) → for each visible item, write its
              instance range into the DRAW LIST and atomicAdd its glyph
              count into the indirect args buffer.
gather        one thread per visible glyph (dispatch = pool size, threads
              early-out via the draw list; or per-item-block dispatch):
              copy the item's contiguous 32 B records into the frame's
              compacted instance buffer. Coalesced memcpy; only visible
              glyphs move. 5M visible × 32 B = 160 MB ≈ 0.3 ms.
draw          ONE drawIndexedIndirect over the compacted buffer:
              geometry.indirect = IndirectStorageBufferAttribute (three
              r185, WebGPUBackend.js:1850), instanceCount written by the
              cull kernel. MegaGlyphField's single mesh becomes this draw;
              frustumCulled:false already correct (GPU culls instead).
```

Why compaction instead of per-item indirect draws: WebGPU has **no multiDrawIndirect**,
and 10k single-draw indirect calls re-create the CPU-encode problem on the GPU. The
gather is bandwidth-cheap because instance records are contiguous per item by
construction (emit wrote them that way). Fallback if gather ever shows up in profiles:
vertex-shader kill-switch on culled items (free to build, costs vertex throughput on
the culled set — wrong default at 50M glyphs).

Group/pose, colors, highlight, picking all keep their existing seams:
- pose = group texel (`MegaGlyphField._syncPoses`); instance record's `itemId` maps to
  the same group/pose index in the vertex shader.
- color = the record's RGBA8 (the colorizer already paints contiguous byte ranges;
  emit-time color = per-item default, repaint = per-range rewrite of pool records — a
  storage-buffer write, no geometry rebuild).
- highlight texture stays, indexed by byteOffset (already the arena addressing).
- picking: record carries `byteOffset` — the byte-indexed identity
  (`glyphPipelineReference.js:23`) survives compaction; pick resolve = instanceId →
  record → (itemId, byteOffset), replacing the current binary-search resolveSlot with a
  direct load.

### 2.5 Bounds and the atlas, off the critical path

- **Bounds**: emit already reduces per-item boxes via ordered-key atomics
  (`glyphPipelineKernels.js:138`). Under GPU-driven culling the CPU doesn't need them
  to render; the once-per-flush `readItemBounds()` becomes *async and lazy* — only for
  grids whose CPU-side placement/contain-fit logic asks. No synchronous readback stall
  anywhere on the load path.
- **Atlas misses**: decode resolving glyphId against the trie means an atlas grow
  mid-storm forces re-runs (today: rebuild kernels + re-dispatch everything,
  `GlyphPipelineArena.js:42`). At scale, make misses impossible on the bake path:
  **alphabet pre-pass** — histogram distinct codepoints across staged bytes (CPU: one
  pass over bytes with a 65536-entry bitmap per worker, merged; or GPU: decode-stage
  atomic or on a block bitmap), `ensureGlyphsEncoded` ONCE, then bake with a complete
  trie. Uncoverable codepoints resolve blank without entering the miss flow. This
  removes the atlas-grow-during-load storm from the layout path entirely; glyphId
  re-resolution after a *later* atlas grow is a single cheap pass (glyphId lane rewrite
  from the byte slab), never a re-layout.

## 3. Mapping onto existing seams

| existing | becomes |
|---|---|
| `GlyphPipelineArena` (one arena, stage/coalesced flush) | the slab streamer: `stage()` unchanged in spirit (bytes + item row + handle), `requestFlush()` runs bake per filled slab instead of one monolithic run |
| `glyphPipelineKernels.js` 9 dispatches | kept wholesale for the interaction path; bake path fuses decode→chunkReduce and resolveX+paginate+emit (the reference/scan/TSL three-layer discipline extends: emit and the fusion get reference twins first — spec-is-right law) |
| `slots` 13-lane buffer | shrinks from persistent-arena to per-slab scratch; EMIT is a new kernel output writing the pool |
| `ordToByte` | doubles as the compaction map (leader ord → byte) and the emit ordering |
| `itemBoxes`/`foldScalars`/`itemStrides` atomics | unchanged; itemBoxes additionally feeds the cull kernel |
| `MegaGlyphField` (one mesh, group-0 dead, pose sweep, one pick registration) | the GPU-driven draw: `geometry.indirect` + compacted instance buffer; `_syncPoses` unchanged; group 0 tombstoning replaced by pool free-lists |
| `GlyphField.attachBytePipeline` / byteGlyph material | material switches instance attributes from the slots buffer to the pool (positions vec4 + packed attr record); field code otherwise untouched |
| `appendFiles` byte loop | Uint8Array-view staging (same buffer, no format change — `packBytes` layout is already little-endian 4-per-word) |
| `readItemBounds` once per flush | async/lazy, off the load path; `layout.verify` unchanged |
| itemStarts binary search (per-byte passes) | byte→itemId u16 map, filled at staging |
| Go relay fs-RPC | gains an optional codepoint-bitmap per file (alphabet pre-pass) — or the bitmap is computed in a JS worker; either way off the render thread |

Explicitly inherited constraints the design does not fight:
- `maxBytes ≤ 2^24` per scratch instance (f32 ordinal exactness, `glyphPipelineKernels.js:189`) — the 64M-slot slab budget sits well under it; the *corpus* is unbounded because the pool, not the scratch, is the accumulator.
- Integer lanes (`S_ROW`/`S_COL`) for every discrete decision — cull, emit, and pagination all key off them, never off float positions.
- three.js r185 reaches everything proposed: storage buffers, atomics,
  `IndirectStorageBufferAttribute` + `geometry.indirect`. The one raw-WGSL risk
  (TSL `Loop`/`Break` expressiveness) is confined to the scan kernels that already run
  on hardware.

## 4. Risks / open questions

1. **Emit re-decoding cost.** Fusing decode into the fold makes apply/emit re-decode
   (2 dependent trie loads/byte). If the trie blows L2 at 37 KB+ growth, this is
   latency, not bandwidth. Measure; fallback is a thin decoded side-band (cp+advance,
   8 B/byte) written by the fused fold — half the slots traffic, still 6× thinner than
   today.
2. **Compaction write ordering.** Emit writes pool ranges via per-item bases from a
   prefix over item glyph counts — that prefix needs glyph counts *before* emit, i.e.
   one tiny reduce between apply and emit (per-item totals already fall out of the
   spine scan; the per-item prefix is 10k adds, one dispatch, µs). Not a risk so much
   as a sequencing detail, but it adds one dispatch to the bake (8, not 7).
3. **Pool capacity vs leader-count variance.** An item's leader count is known exactly
   post-scan, so ranges are exact at bake; edits/wrap-changes later need slack →
   overflow tail + lazy defrag. Defrag correctness under live picking/highlight needs a
   generation counter per item.
4. **Indirect draw inside three's node system.** `geometry.indirect` is supported but
   lightly exercised with storage-attribute instance data; expect one three-version
   pin and possibly a `wgslFn` escape hatch for the culled-draw vertex path.
5. **Atlas pre-pass needs a cross-proposal contract**: the trie/glyphId versioning
   (liveTrie.js) must support "glyphId lane rewrite without re-layout". If the atlas
   proposal instead hot-swaps textures per grow, the bake must be atlas-quiescent
   (alphabet pre-pass makes it so).
6. **Scratch budget on low-end GPUs.** 3.7 GB transient is fine on desktop, not on
   iGPU/Apple-base. Slab budget must be device-derived (start 16M slots ≈ 0.9 GB), and
   the bake degrades to more slabs, never to a different algorithm.

## 5. Effort estimate

| piece | scope | effort |
|---|---|---|
| Slab streamer + view-based staging + itemId map | rework `GlyphPipelineArena`/`appendFiles`; no shader changes | 1 wk |
| Emit kernel + instance pool + reference twin + harness lanes | new pass, pool alloc/free-lists, `glyph-pipeline-check` lanes | 1.5–2 wk |
| Bake fusions (decode-fold, resolveX-paginate-emit) | reference first, then TSL; bit-exactness lanes | 1 wk |
| Cull + gather + indirect draw in MegaGlyphField | `geometry.indirect`, pose-buffer read, draw-list scan | 1–1.5 wk |
| Alphabet pre-pass + atlas-quiescent bake | relay/worker bitmap + one-shot encode | 0.5 wk |
| Per-item re-layout path (scroll/edit) + pool defrag | reuse interaction kernels on scratch; generation guards | 1 wk |

**Core total ≈ 5–6 engineer-weeks** to a hardware-verified bake-and-stream load path;
integration/itest fallout on top. Every stage has an existing harness shape to extend
(glyph-pipeline.test, scan-layout.test, glyph-pipeline-check on hardware), so nothing
here is unverifiable in the repo's current gate style.

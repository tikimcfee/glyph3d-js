# VRAM & Memory Architecture for glyph3d-js at linux-Tree Scale

Perf-swarm topic: the memory system for millions of glyph instances across tens of
thousands of files. Scope: VRAM budget math, allocator design, growth without
realloc, sub-allocation strategy, streaming/paging past VRAM capacity, and WebGPU
upload patterns.

## 1. Problem framing

### 1.1 The corpus

`torvalds/linux` (6.x): ~78–80k files, ~1.3–1.5 GB of text. Bytes ≈ glyphs
(ASCII-dominated; UTF-8 continuation bytes are non-leaders). Call it **1.4 G glyphs
across 80k items**, mean file ~18 KB. The stated product target is "tens of
thousands of files in seconds" — i.e. 0.3–0.5 GB, 300–500 M glyphs is the *routine*
case, linux is the stress case.

### 1.2 What one resident byte costs today (byte-pipeline path)

From `compute/glyphPipelineReference.js` (`SLOT_STRIDE = 13` f32) and
`compute/glyphPipelineKernels.js` + `MegaGlyphField._ensureCapacity`:

| Buffer | B per source byte |
|---|---|
| `GlyphSlots` (13 × f32 layout+position lanes) | 52 |
| `GlyphBytes` (packed u32 words) | 1 |
| `GlyphOrdToByte` (u32) | 4 |
| `instanceColor` (vec3 f32) | 12 |
| `instanceGroupId` (f32) | 4 |
| `instancePickingId` (f32) | 4 |
| highlight texture (RGBA8, 1 texel/slot) | 4 |
| **resident GPU total** | **~81 B/byte** |
| CPU mirror (`Float32Array`, lazy per touched file) | +52 (RAM) |

The arena header itself warns: "a slot is 11 f32 = 44B" (stale — it's 13 now) and a
16M-slot default "allocated ~700MB and OOM'd the GPU process." Extrapolate honestly:

- 1 MB source (the current default arena) ≈ **81 MB VRAM**
- 100 MB source (a big repo subset) ≈ **8.1 GB** — past any browser GPU budget
- linux (1.4 GB) ≈ **113 GB** — 30–100× past the physical wall

**Conclusion: no amount of allocator cleverness makes the current per-byte state fit.
The design must (a) shrink persistent per-glyph state ~5×, (b) separate layout
scratch from render state, and (c) treat full-resolution glyphs as a paged resource,
not a resident one.**

### 1.3 The demand side — how many glyphs can a screen even use?

- 1080p, readable text (≥ 10 px cell): ~10–30k glyphs on screen.
- Aggressive overview zoom (2–4 px glyphs, still rendered as instances): ~1–2 M.
- Headroom for fast camera flight + prefetch ring: **8 M full-res glyphs resident is
  generous**. Everything beyond that is LOD or non-resident.

So the *working set* is bounded by the screen, not the corpus. The memory system is
a **cache**: small hot tier sized by pixels, cold tiers sized by corpus.

## 2. Design

Four mechanisms, in dependency order.

### 2.1 Split layout scratch from persistent render records

The 13-lane slot buffer is *transient*: 10 of its 13 lanes (codepoint, row, col,
flags, baseX, lineAdv, ord…) exist only to compute where a glyph goes. After layout,
the renderer needs exactly: position, glyph identity, color. Advance and height are
**font constants** — the vertex shader already reads per-glyph metrics from
`glyphMapTex`; per-instance `instanceSize` is redundant data.

**Compact render record (16 B/glyph), item-local coordinates:**

```
struct RenderRecord {        // 16 B, one per leader glyph
  xQ      : u16,   // line-relative x, fixed-point 1/256 world unit (256-unit range)
  row     : u16,   // visual row (already exact in the pipeline — S_ROW)
  zQ      : u16,   // page/band depth, fixed-point
  glyphId : u16,   // atlas glyph id (64k cap — see risks)
  color   : u32,   // RGBA8 — replaces the 12-B instanceColor lane
  flags   : u16,   // leader/emoji/frame-mode bits
  pad     : u16,
}
```

- y = `row × lineHeight` (uniform per item), x = `xQ / 256` — positions are derived
  in-shader, matching the pipeline's "integers don't wobble" discipline (S_ROW/S_COL
  are already exact ints).
- Item-local frame: the group texel (`groupTex`, GROUP_COLS) already carries a full
  TRS pose per view, so records never bake world position — re-posing a file is free.
- The 13-lane slot buffer becomes a **fixed-size scratch arena** (e.g. 4 M slots =
  208 MB, or slice per-job), reused by every layout job, never scaled with corpus.
  Layout becomes a *bake*: bytes → 9 existing dispatches → new **kernel 10
  (compact)** writes 16-B records into the persistent arena.
- Non-leader continuation bytes get **no record** (they're already zero-sized in the
  vertex path); picking maps record → byte offset via a per-item leader-prefix the
  scan already computes (S_ORD / ordToByte — kept in scratch, consulted on demand).

Result: persistent state drops from ~81 B/byte to **16 B/glyph** (~5×; ASCII source
has ≈ 1 glyph/byte, so ≈ 16 B/byte). linux at full res: 22 GB — still too big, hence
2.4. But the *hot tier* (8 M glyphs) is now **128 MB** instead of 650 MB.

### 2.2 Segmented arena — growth without realloc, free lists without compaction

Replace the single capacity-sized buffer + ×2 `_realloc()` + `rebindByteSlots`
storm with a **segmented arena**:

- Segment = fixed-size GPUBuffer of **1 M records (16 MB)**. Growth = allocate one
  more segment. **No existing buffer is ever reallocated, moved, or destroyed** —
  the `tools/arena-realloc-check.mjs` failure class (bind groups stranded on a
  destroyed `GlyphSlots` buffer, three's texture-keyed bind-group cache) is
  eliminated structurally, not guarded. The check can be retired or repurposed to
  assert draw-range correctness as segments come online.
- Files allocate **contiguous record runs** (a file's glyphs stay contiguous — this
  preserves the "slot index == byte offset" addressing *within* a file, which
  picking, the colorizer (`setGlyphColorRange`), and `MegaFieldView.slotBase`
  arithmetic all assume). A run may span segments; the draw/cull layer handles the
  split (see 2.4).
- **Free lists per size class** (powers of two ≥ 4 K records, exact-fit below):
  `dispose()`/eviction pushes the run onto its class list; allocation pops
  best-fit. This retires the arena's documented v1 leak ("byteStarts are the
  fields' read offsets, so splicing would invalidate every later item… a page reload
  resets it") — the leak is currently unbounded per session.
- Fragmentation bound: runs are file-sized (KB–MB), segments are 16 MB; worst-case
  internal waste is < one run per class per segment — single-digit % at these size
  ratios. No compaction pass is ever needed; if a session defies that, a *vacuum*
  can move the youngest run (records are self-contained; only the indirection
  table's base pointer changes).

**Indirection — the one new address translation.** Today: absolute slot == byte
offset == instance index (one identity the whole app leans on). With free lists that
identity breaks, so introduce it explicitly:

```
logical address  (itemId u16, localGlyph u32)   — what picking/colorizer speak
physical address = itemBase[itemId] + localGlyph — one u32 lookup, in item table
```

`itemBase` joins the existing item table (`itemStarts`/`itemTable`,
`ITEM_STRIDE` lanes — add 2 lanes: record-base, record-count). The picking system's
`resolveSlot` binary search over live ranges becomes: hit → draw-range → itemId →
local = idx − itemBase[itemId]. Same O(log n), one extra table read.

### 2.3 The item table scales; the atlas already did

- Item/bounds metadata for 80k files: item table (~15 lanes f32) + bounds (8 f32) +
  itemBase ≈ **< 8 MB** — keep *always resident* for every known file. This is what
  makes culling, LOD selection, and placement possible without touching glyph data.
  `DEFAULT_MAX_ITEMS = 1024` and arena `maxItems = 4096` must grow to ~128 K
  (segmented like the records, or one 8 MB buffer — trivial).
- Group texture: one group per view × (content + filename) ≈ 160 K groups ×
  GROUP_COLS × 16 B ≈ **13 MB** — fine as-is.
- Atlas (2048² RGBA8 ≈ 16 MB) + slug curve textures + glyph map ≈ **64 MB fixed** —
  unchanged, already bounded. (Atlas-grow hot-swap is another agent's topic; it
  doesn't interact with this design.)

### 2.4 Residency tiers, LOD, and eviction

With 16 B records, linux is 22 GB. The cache:

| Tier | Content | State | linux-scale cost |
|---|---|---|---|
| **T0 hot** | visible + prefetch-ring files | 16-B records resident, **bytes on GPU**, re-bakeable (scroll/repaginate) | 8 M glyphs: 128 MB + 8 MB bytes |
| **T1 warm** | near-viewport files | 16-B records resident, bytes CPU-side only | budget-capped, e.g. 64 M glyphs = 1 GB |
| **T2 line-LOD** | far but on-screen files | one **12-B line record** per source line (row, x, w, color avg): a thin quad per line reads as text texture at distance | linux ~40 M lines → but only *on-screen* files need it: ~2 M lines = 24 MB |
| **T3 cold** | everything else | item-table row + bounds only (~100 B/file); renders as the file's bounds slab (group texel alpha) or nothing | 80k × 100 B = 8 MB |

Total VRAM at linux scale: **~1.3 GB** — inside a 2 GB glyph-subsystem budget
(assumes a 4 GB floor GPU; browser gets ~¾ of physical).

- **Eviction: LRU by last-visible frame**, per file-run, with hysteresis (evict at
  < 90 % of budget, in segment-run granularity; never evict a file staged < N frames
  ago — load storms shouldn't thrash). T0→T1 demotion frees GPU bytes (the packed
  `GlyphBytes` range); T1→T3 frees the record run to its size-class free list.
- **Promotion**: T3→T2 needs a line-summary bake (one lightweight pass over bytes —
  can even run on the CPU in a worker, it's 12 B/line out); T2/T1→T0 needs bytes →
  the 9-dispatch bake → compact. Prefetch predicts camera velocity one ring out.
- **Scroll/repaginate** (today: `setItemPage` + strides+paginate re-run over the
  *whole arena*) becomes: re-bake **only the scrolled file** — bytes are T0-resident,
  scratch is free, one file's dispatches are µs. The coalescing
  `requestRepaginate()` gate stays, but its dispatch set shrinks from arena-wide to
  touched-items.
- **CPU RAM**: raw bytes for linux = 1.4 GB. Keep as delivered `Uint8Array`s (the
  fs-RPC already hands them over); optional LZ4 in the relay later (source ≈ 4–5×).
  The lazy 52 B/byte CPU mirror stays lazy — interaction-rate only, unchanged.

### 2.5 Upload patterns — what WebGPU actually offers

WebGPU has **no persistently-mapped buffers** (no MAP_WRITE-resident ring like
Vulkan/D3D12). The two real levers:

1. **`queue.writeBuffer(buf, offset, data)`** — the right tool for deltas. Dawn
   fast-paths it into a per-submit staging ring; for ≤ a few hundred KB per call
   it's effectively memcpy-into-command-stream. Use it **at subrange granularity**.
2. **mapAsync staging ring** (double-buffered MAP_WRITE buffers +
   `copyBufferToBuffer`) — for bulk page-in (multi-MB file batches), overlapping CPU
   pack with GPU copy.

**What must change vs. today:**

- three's `instancedArray(...).value.needsUpdate = true` re-uploads the **whole
  backing buffer** — `appendFiles` marks `byteWords`/`itemStarts`/`itemTable`
  dirty, so every steady-state flush re-uploads capacity-sized buffers. At 100 MB
  arena scale that's the "per-interaction lockup" the comment was trying to avoid,
  merely deferred. Own these buffers directly (raw `GPUBuffer` + storage-node
  binding, the same trick `instancedArray` does under the hood) and `writeBuffer`
  only `[dirtyStart, dirtyEnd)`.
- `appendFiles`'s per-byte JS word-packing loop (`words[w] = …` per byte) is O(bytes)
  main-thread per append — fine at 1 MB, seconds at 500 MB. Either pack in the
  builder worker (transfer the packed ArrayBuffer — `packBytes` is already a pure
  function) or, better, store bytes **unpacked** in a `u8`-addressed storage buffer
  (WGSL reads u32 words regardless; pack in the decode kernel — one ALU op per byte
  on data it's already reading). That deletes the pack step from the CPU entirely.
- Load-storm shape: coalesce per flush (the existing `requestFlush` gate), one
  `writeBuffer` per contiguous dirty span per segment. 500 MB corpus ÷ ~6 GB/s
  effective writeBuffer throughput ≈ **~90 ms of GPU upload** — not the bottleneck.

### 2.6 GPU-side cost of the bake (per cold load, 500 MB / 30k files)

Scan-family dispatches touch the 52-B slot lanes ~3 times (fold write, resolveX
rw, paginate rw) + decode read of bytes: ≈ 3 × 52 B + 1 B ≈ **157 B/byte of slot
traffic** → 500 MB corpus ≈ 78 GB ≈ **~160–400 ms at 200–500 GB/s**. Compact pass:
+16 B/glyph write ≈ +15 ms. Item-count dispatches (strides, bounds) are 30k-thread
trivial. **GPU is not the load bottleneck** — the design's job is to keep CPU pack,
upload granularity, and per-file JS from being one.

### 2.7 Drawing the resident set

One instanced mesh per segment (8 M glyphs = 8 draws) is already nothing — but the
vertex-stage cull (today: degenerate to outside-NDC per glyph in
`buildGlyphVertexTransform`) still *executes* per culled glyph. With per-file
contiguous runs + the always-resident bounds table, do **file-granularity culling**:

- CPU (cheap, ships first): frustum-test 80k bounds boxes ≈ < 1 ms, emit draw only
  for visible runs (a handful of `drawIndirect` parameters rebuilt per camera move —
  WebGPU supports `drawIndirect` today; multi-draw-indirect is not portable, so N
  small indirect draws, N = visible files ≈ tens–hundreds).
- GPU (later): one cull dispatch over the bounds table writes the indirect args +
  a compacted visible-item list; zero CPU per frame. Same shape as the existing
  bounds readback, inverted.

The mega mesh's `frustumCulled: false` + "per-view culling is a later milestone"
comment in `MegaGlyphField` is exactly this seam.

## 3. Mapping onto existing seams

| Existing | Becomes |
|---|---|
| `GlyphPipelineArena` (append-only byte arena, `_realloc` ×2) | **Residency manager**: item table + segmented record arena + fixed scratch. `stage()` = allocate run + queue bake. `_realloc` deleted. |
| `GlyphPipelineKernels` 9 dispatches + `SLOT_STRIDE` 13 slots | Unchanged algorithms, retargeted: slots = scratch pool; + kernel 10 **compact** → render records. `maxBytes` cap (2²⁴ f32-ordinal limit) becomes a *per-job scratch* limit, not a corpus limit — large files chunked at newline boundaries. |
| `setFiles`/`appendFiles` whole-buffer `needsUpdate` + JS pack loop | raw `GPUBuffer` + `writeBuffer` subranges; bytes unpacked, pack moved into decode kernel or worker. |
| `MegaGlyphField._ensureCapacity` (copy-grow of color/groupId/pickingId arrays, `highlightBuffer` at capacity) | Deleted — color folds into the 16-B record; groupId/pickingId become derived (draw-range → itemId); highlight becomes a sparse per-item overlay texture or stays a small T0-only texture. |
| `rebindByteSlots` + `tools/arena-realloc-check.mjs` | Obsolete (no buffer is ever destroyed by growth) — repurpose the check to assert segment growth never errors and draw ranges stay correct. |
| `MegaFieldView` (`slotBase`, `setGlyphColorRange` offsets, `resolveSlot` binary search) | Unchanged *interface*; offsets become item-local, resolved through `itemBase[itemId]`. The "group 0 dead-group tombstone" trick is replaced by free-list release. |
| Per-item bounds readback (`readItemBounds`, `handle.laid`) | Unchanged — and becomes the T3 representation + cull input. |
| Documented dispose leak ("compaction is a later milestone") | This *is* that milestone, via free lists instead of compaction. |

## 4. Risks / open questions

- **glyphId u16 cap (65,536)**: fine per-font; emoji bitmap cells share the id space
  via `glyphMapTex`. A corpus with > 65k distinct glyphs (unlikely for code) forces
  u32 ids (+2 B/glyph). Decision needed before freezing the record layout.
- **Fixed-point xQ precision**: 1/256 unit ≈ 4 milliem — sub-pixel at any sane zoom.
  But `verifyItem`'s 1e-3 eps compares f32 slots; verification must keep running
  against full-precision scratch (it already materializes the mirror on demand) —
  records are display-only. Long lines: 256-unit range = ~365 monospace cells;
  longer lines need a per-line base in the record or u24 x. Measure real corpora
  (`wc -L` on linux: worst source lines ~500–2k cols — **u16 won't cover them**;
  likely bump xQ to u32 → 18-B records, or per-line rebasing).
- **three.js bypass surface**: raw-buffer storage nodes work (the rebind seam proves
  three re-binds node values), but `updateRanges`/partial-attribute support should
  be re-checked per three bump, same discipline as the bind-group-cache note.
- **writeBuffer throughput on real browsers** (esp. non-Chrome): the 6 GB/s figure
  is Dawn-on-Vulkan; validate with `app/glyph-bench.html` extended to a synthetic
  100 MB storm before committing the load-time budget to it.
- **Scratch-pool sizing vs. giant files**: one file > scratch capacity needs
  chunked layout with carry-over fold state (the scan's monoid resets make this
  natural at item boundaries; intra-file chunking needs a spine carry — the
  chunk/spine structure already supports it, but it's new code).
- **Interaction with other swarm proposals**: assumes the byte-in GPU pipeline is
  the load path (no worker shaping round-trip); conflicts with any proposal to keep
  per-glyph `instanceSize`/`instancePosition` attributes (we delete them); the
  GPU-driven cull step overlaps whoever owns "draw-call architecture."
- **Eviction while a field is mid-interaction** (caret in a file that scrolls off):
  pin T0 files with active carets; the lazy CPU mirror already covers edit-time
  truth.

## 5. Rough effort estimate

| Step | Size |
|---|---|
| Segmented record arena + free lists + indirection, kill `_realloc`/`rebindByteSlots` | M (1–2 wk) |
| Direct `GPUBuffer` + `writeBuffer` subranges, unpack bytes into decode kernel | S–M (days) |
| Kernel 10 (compact) + 16-B render record + vertex-shader retarget | M (1 wk incl. verify rework) |
| Residency manager: tiers, LRU, T0/T1 paging, prefetch ring | L (2–3 wk, mostly policy + itests) |
| Line-LOD (T2) bake + shader branch | M (1 wk) |
| GPU-driven bounds-cull → indirect draw | M (½–1 wk, after item table is always-resident) |

Sequenced: steps 1–3 are the spine (5× memory cut, realloc class deleted, upload
granularity fixed) and independently shippable; 4–6 turn "big repo" into "linux
tree."

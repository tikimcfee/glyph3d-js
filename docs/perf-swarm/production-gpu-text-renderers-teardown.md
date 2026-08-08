# Production GPU text renderer teardown — what to steal for "10k files in seconds"

Swarm report: survey of how the best production GPU text/code renderers actually work,
mapped onto the real seams of this repo, with a ranked steal-list.

Repo state referenced: `packages/glyph3d-core/src/` (GlyphField, MegaGlyphField,
LiveSlugAtlas, compute/glyphPipelineKernels, GlyphPipelineArena, collections/CodeGrid),
plus the landed design docs `docs/plans/gpu-bounds-and-byte-pipeline.md` and
`docs/plans/layer2-wiring-and-load-regression.md`.

---

## 1. Problem framing

Target: load a source tree like `torvalds/linux` — 10k+ files, ~150–250 MB of UTF-8,
~150M+ glyphs — in seconds, and hold it in 3D at 60fps+.

Two different problems get conflated:

- **Load time** (the 20s/1000-files pain): dominated by per-file CPU work, atlas growth
  churn, per-item GPU readbacks, and object construction. Production renderers solve
  this with *content-addressed caching*, *append-only atlases*, and *zero per-item
  synchronization*.
- **Residency + per-frame**: 150M glyphs × today's ~81 B/byte arena cost ≈ **12 GB** —
  does not fit, and today's arena is *hard-capped at 2²⁴ = 16 MiB of bytes*
  (`glyphPipelineKernels.js:189`, f32 ordinal exactness). **The current architecture
  structurally cannot hold 10k files.** Production renderers solve this with slim
  instance data, fixed-size pages, LOD, and streaming.

The per-frame side is already in good shape conceptually: `MegaGlyphField` is one mesh /
one draw for every file's glyphs, group texels carry per-file poses (80 B/group,
RGBA32F, cap 16000), picking is one registration with absolute-slot IDs. What remains
is the game-engine layer: GPU culling, indirect draws, LOD, streaming residency.

### Corpus math (used throughout)

| quantity | value |
|---|---|
| files | 10,000 |
| avg file | ~20 KB, ~500 lines |
| source bytes | ~200 MB |
| glyph slots (1 slot/byte, byte-indexed pipeline) | ~200M |
| lines | ~5M |
| distinct codepoints in source code | < ~300 (99% printable ASCII) |

---

## 2. Teardown: what the best renderers actually do

### 2.1 Zed / GPUI (Rust, Metal/Vulkan/DX) — [zed.dev/blog/videogame](https://zed.dev/blog/videogame)

- **Atlas**: CPU-rasterized by the OS (CoreText), **alpha-only** (one channel, tinted per
  instance — color never multiplies atlas entries). Bin-packed with *etagere*. Up to 16
  subpixel-position variants per glyph. Long-lived; glyphs never move once packed.
- **Caching**: shape cache keyed on (text, font); entries inserted on first use, evicted
  when absent from the next frame. Shaping cost amortized to changed text only.
- **Per-frame flow**: element tree paints into a flat `Scene` of typed primitive vecs;
  each primitive type = **one instanced draw**. Glyph instance is 40 B:
  `{target_origin, atlas_origin, size, color}`. Quote: "composing text from the atlas
  approximates the bandwidth of the GPU".
- **What they do that this repo doesn't**: nothing exotic — that's the point. The win is
  *discipline*: one draw per primitive, data-driven instances, atlas that never
  invalidates bindings. Note GPUI **rebuilds instance buffers every frame** — fine at UI
  scale (~10⁴ glyphs), wrong at 10⁸; we must keep instances resident instead.

### 2.2 Alacritty (Rust, OpenGL) — terminal

- **Atlas**: `GlyphCache` rasterizes via crossfont into GL texture atlases; **pre-warms
  the printable ASCII set at startup** (the startup log literally says "glyph cache with
  common glyphs", ~0.2–1.8 s one-time). New glyphs append to the current atlas; when
  full, a *new* atlas texture is added — existing textures are never resized or rebound.
- **Per-frame flow**: rebuilds instance vertex data for **visible cells only** (~10⁴
  cells × ~48 B ≈ 500 KB upload), only when the terminal reports damage. Fixed cell
  advance: layout is `col * advance`, no shaping on the draw path.
- **Steal**: ASCII pre-warm (a source-code corpus then causes *zero* atlas growths during
  load); append-a-new-page instead of grow-and-rebind; damage-scoped rebuilds.

### 2.3 Wezterm (Rust, OpenGL/WebGPU) — terminal

- **Caching hierarchy** (from its own stat logging): `glyph_cache` (font+glyph → atlas),
  `line_quad_cache` (**a whole shaped line → its quad list**), `line_state_cache`.
  A line that hasn't changed costs ~nothing to re-render: the cached quad list is
  re-emitted, not rebuilt. Quads split into background/glyph/foreground layers.
- **Steal**: cache at the granularity of *the thing that changes*. For us the unit is the
  file (content hash), not the line — but the principle is identical: unchanged content
  must never be re-decoded, re-laid-out, or re-uploaded.

### 2.4 Kitty / Ghostty — terminals

- Kitty: sprite-map atlas, per-cell instanced arrays, only damaged lines re-rendered.
- Ghostty: shaper cache over HarfBuzz runs; per-frame rebuild of *dirty* cell instance
  buffers; Metal on macOS. Same lesson as Alacritty: monospace layout is trivial
  arithmetic; shaping and rasterization are cache problems, not per-frame problems.

### 2.5 glyphon (Rust, wgpu — the closest WebGPU-native analog) — [github.com/grovesNL/glyphon](https://github.com/grovesNL/glyphon)

- **Atlas**: `TextAtlas` = **two grow-only textures** (R8 mask + RGBA8 color), etagere
  shelf packing, LRU **trim** when over budget. Rasterization via swash on cache miss.
- **Per-frame**: `prepare()` walks visible text areas, inserts missing glyphs into the
  atlas, and appends vertices into **grow-only vertex buffers**; draw is batched per
  atlas texture.
- **Steal**: grow-only buffers everywhere (never realloc-copy-rebind in the hot path);
  memory *budgets* with LRU trim instead of unbounded growth; COSMIC terminal ships this
  at production load.

### 2.6 Firefox WebRender — [doc.servo.org/webrender/texture_cache](https://doc.servo.org/webrender/texture_cache/index.html), [mozillagfx atlas allocation](https://mozillagfx.wordpress.com/2021/02/04/improving-texture-atlas-allocation-in-webrender/)

- **Texture cache**: *lazily allocated, fixed-size texture arrays per format*; pages are
  never resized — new pages appear, old pages are evicted whole. Oversized entries get
  standalone textures. **Separate eviction budgets** for auto-evict (glyphs) vs
  manual-evict entries so one class can't flush the other. Glyph rasterization on worker
  pools; batches grouped by texture to minimize rebinding.
- **Steal**: this is the correct shape for our atlas problem — *fixed-capacity pages,
  append within a page, budget + page-granular eviction*. Growth-as-rebind (our current
  hot-swap) is the anti-pattern WebRender engineered away.

### 2.7 osor.io "Rendering Crispy Text On The GPU" (2025) — [osor.io/text.html](https://osor.io/text.html)

- Runtime vector rasterization (quadratic beziers → winding number, exactly the Slug
  family) into an atlas with **temporal accumulation**: new glyphs get 8 spp on frame 1,
  then refine 4/2/1 spp while they stay visible, capped at 512. Full-screen 4k text
  rasterizes in **~0.1 ms**, tapering to zero. Atlas key quantizes size/subpixel offset
  to fixed point; Z-order bitset packing (transposed for Latin's vertical glyphs);
  keep-while-visible eviction.
- **Steal**: two things. (a) The atlas key insight — our repo is *monospace with a fixed
  cell and forced pixel-ish alignment*, so the atlas/trie key collapses to `glyphId`
  alone; no size/subpixel variants at all. (b) If Slug per-pixel cost ever hurts at far
  zoom (overdraw), a baked impostor with accumulation is the escape hatch, not bitmap
  atlases for everything.

### 2.8 Slug (already in this repo) — [sluglibrary.com/SlugManual.pdf](https://sluglibrary.com/SlugManual.pdf)

Banded quadratic-curve evaluation per fragment, resolution-independent, glyph data in a
texture (curve texels + per-glyph band map). The repo's `LiveSlugAtlas`/`SlugEncoder`
*is* this: the curve texture + glyph-map texture are our atlas. The lesson from every
production atlas above applies directly: **it must be fixed-capacity and append-only.**

### 2.9 Browsers (Chrome/Firefox text stacks) — mostly N/A

Skia/Graphite glyph caches and Blink's shape caches are the same two ideas (shape cache +
page-based glyph atlas with budgets). LCD subpixel AA is desktop-2D-only; irrelevant to
a 3D WebGPU scene. Skip.

### Synthesis: the pattern every production renderer shares

1. **The atlas never moves.** Fixed-capacity pages; append; never rebind what exists.
2. **Content is cached content-addressed** at the granularity it changes (line/file).
3. **The common case is pre-warmed** (ASCII at startup) so steady-state load = zero misses.
4. **Instance data is slim and SoA**, one or few draws, layout is arithmetic (monospace).
5. **Per-frame CPU work is proportional to what changed/what's visible**, not to corpus size.
6. **Budgets + page-granular eviction**, not unbounded growth, not full rebuilds.

---

## 3. Where this repo stands vs. that pattern

| pattern | repo status |
|---|---|
| one/few draws | ✅ `MegaGlyphField`: 1 draw for all glyphs; per-file background panel = 1 extra draw/file (10k draws at target — needs instancing) |
| byte-in GPU pipeline | ✅ landed: 9 dispatches/flush (`decodeAndResolve → chunkReduce → spineReduce → spineScan → partialScan → apply → resolveX → deriveStrides → paginateAndBounds`), incremental append watermark (`_syncedItems`) |
| slim instance data | ❌ ~81 B/source-byte resident (52 B slots stride-13 f32 + 20 B field attrs + highlight/ord/bytes); classic path 48 B/instance |
| capacity | ❌ hard cap **2²⁴ bytes** (f32 ordinal exactness) = ~16 MiB — two orders short of the 200 MB target |
| atlas append-only | ❌ `LiveSlugAtlas.ensureGlyphsEncoded` rebuilds texture pair and **hot-swaps every registered field per grow** (measured 606 fields/grow); emoji atlas repaints *every cell* on square growth; cold atlas re-encodes working set every reload (v1→v6) |
| pre-warm | ⚠️ boot encodes an initial set ("first frame is already warm") but cold-reload still re-encodes; blank storm (378/402 `.blank` in one grow) partially fixed by bitmap-slot partitioning |
| content-addressed cache | ❌ no disk cache; every reload re-reads, re-encodes, re-dispatches everything. Pieces exist: `tools/blob-store.mjs`, `tools/bake-slug-core.mjs`, `_experiments/glyph-encoding/codec.js` |
| batched sync | ❌ one per-item bounds readback per flush — at 10k items this alone is seconds of stall |
| GPU culling / LOD / streaming | ❌ mega mesh is `frustumCulled: false`; per-view culling listed as "a later milestone"; arena leaks disposed bytes (no compaction); no LOD residency |

---

## 4. The design: what to steal, as concrete architecture

### 4.1 Steal #1 — Slim SoA lanes + u32 ordinals (unblocks capacity) — *prerequisite for everything*

The slot stride is 13×f32 = 52 B/byte, and the 2²⁴ cap exists because ordinals ride in
f32 lanes. Both are self-inflicted. The x/y/z position is **a closed form of (row, col,
page geometry)** — Layer 1 already proved this (`foldExtent`, positions by formula from
integer lanes). So don't store positions per byte at all:

```
bytes      u8   [byte]        1 B   (immutable upload, the source itself)
glyph      u16  [byte]        2 B   (trie glyphId; 65k global glyph space)
rowcol     u32  [byte]        4 B   (row:20 | col:12 — col ≤ 4095 post-wrap, asserted)
color      u32  [byte]        4 B   (RGBA8 packed; colorizer writes ranges)
flags      u8   [byte]        1 B   (leader / blank / bounds-of-item)
─────────────────────────────────
total                        12 B/byte   (vs ~81 B today, 6.7×)
```

- `row`/`col` stay exact integers (the iron rule: discrete decisions read integer lanes).
- **Positions are derived in the vertex shader**: `page = row / pageRows;
  x = baseX + col*adv + page*pageStrideX; y = row*lineH; z = -seg*zWrapStep` — the same
  math `paginateAndBounds` does today, moved from stored lanes to uniform+lane math.
  Repagination = change 2 uniforms, **zero kernel dispatches** (today: 2).
- `ord` moves into a u32 lane written by the scan (it already maintains `ordToByte` as
  u32) → the 2²⁴ cap becomes 2³²; new practical cap is VRAM, not float exactness.
- 200 MB corpus → 2.4 GB resident. Feasible on discrete GPUs; on anything smaller,
  4.3 streams it. Picking is unaffected (slot == byte offset == instance index).

The scan chain (`chunkReduce/spineReduce/spineScan/partialScan/apply`) already computes
newlines and columns — it writes `rowcol` instead of the f32 lanes. `decodeAndResolve`
writes `glyph` + `flags`. `resolveX`, `deriveStrides`, and the position lanes of
`paginateAndBounds` **die**; a small per-item reduce (max col, row count, min/max page)
writes the item extent table.

### 4.2 Steal #2 — Fixed-capacity, append-only atlas + ASCII pre-warm + persistent bake

Kills the entire measured regression class (hot-swap multiplier, blank storm, cold
re-encode) by construction, not by mitigation:

- **Curve texture**: reserve at boot at a capacity that holds the full font working set.
  Source code touches < ~300 codepoints; the whole extended working set (Latin +
  box-drawing + CJK common + symbols) is ~2–5k glyphs. At ~30 curves/glyph × 2 texels ×
  16 B/texel (RGBA32Uint) ≈ 0.5 MB/1000 glyphs — a 4096×1024 RGBA32Uint texture
  (64 MB) holds ~2M curves, ~100× headroom. **It never resizes.** Appends are
  `queue.writeTexture` into free texels; the glyph-map entry (curveStart/curveCount) is
  written the same way. Binding never changes → *there is no hot-swap to optimize*;
  the 606-fields-per-grow multiplier ceases to exist.
- **Pre-warm**: encode printable ASCII + box/block-drawing + common punctuation at boot
  (Alacritty's "common glyphs" move). A source-code corpus then produces **zero atlas
  events during load** — misses become a tail-latency concern (emoji, CJK), handled by
  the existing miss ring, batched once per flush.
- **Persist the bake**: `tools/bake-slug-core.mjs` already exists — ship the encoded
  curve+map buffers as a versioned asset (keyed by font-hash + encoder version), so even
  the first boot skips extraction. Cold reload goes from v1→v6 re-encode to one
  `writeTexture`.
- **Emoji atlas**: same treatment — fixed grid (e.g. 64² = 4096 cells at 72 px =
  4608 px², under the 9216 cap), `Map<codepoint→cell>` (already the keying), new cells
  painted in place. No re-layout, no repaint-every-cell, no texture replacement. If it
  ever fills, evict LRU cells and repaint *in the same texture* (WebRender page model).

### 4.3 Steal #3 — Content-addressed prepared-content cache (Wezterm's line_quad_cache, one level up)

The load path today: fs-RPC → string → `TextEncoder` → stage → 9 dispatches → per-item
readback. Every cold reload pays all of it. The cache:

```
record = blake3(fileBytes) → {
    bytes,                       // raw UTF-8 (the upload payload)
    lineIndex: Int32Array,       // newline byte offsets (buildByteLineIndex output)
    colorMap?: u32[],            // syntax colors, if colorizer output is cacheable
    stats: { rows, maxCol, bytes }
}
```

- Stored in the blob store (`tools/blob-store.mjs` seam), keyed by content hash, served
  by the Go relay so **the browser never re-derives anything for unchanged content**.
  git working trees have enormous content overlap across reloads/checkouts.
- End-to-end byte-in: the relay already reads bytes off disk; content should arrive as
  `ArrayBuffer`, never as a JS string. `TextEncoder.encode` on 200 MB is ~0.2–1 s of
  pure waste; `fetch`/WS binary → `queue.writeBuffer` is a copy, nothing else.
- Second load of the same tree = hash lookups + upload + dispatch. Budget:
  200 MB at a conservative 1 GB/s effective staging+upload ≈ **200–400 ms**.

### 4.4 Steal #4 — One sync per batch, spine-derived extents (kills per-item readbacks)

`GlyphPipelineArena` does one bounds readback **per item** per flush. At 10k items even
1 ms each is 10 s. Two facts make this unnecessary:

- The scan spine already reduces per-item row counts and (with a `max(col)` fused into
  `chunkReduce`) per-item max column → the **item extent is in the item table on GPU**
  (`deriveStrides`' replacement writes it). One batched readback of
  `10k items × 32 B = 320 KB` per *batch*, async, overlapped with the next batch's
  upload. Or zero readbacks: extents stay on GPU and drive culling/pagination directly,
  with an async copy to a readback ring consumed a frame later (no stall, eventual
  consistency is fine for scrollbars).
- Load becomes: stage bytes → `writeBuffer` → dispatch appended range → **one**
  `mapAsync` per batch. Item count per flush is irrelevant.

### 4.5 Steal #5 — GPU-driven visibility + LOD (the game-rendering layer)

Per frame, today: one mega draw over everything, `frustumCulled: false`, Slug fragment
cost paid for every glyph including subpixel ones. The 10⁸-glyph answer:

```
cull.comp   over group table (16k groups × 80 B):
              frustum test (6 planes vs item extent sphere) + distance
              → per-group LOD class {NEAR, FAR, CULLED}
              → append visible groupIds to NEAR/FAR lists (atomic counters)
              → write indirect draw args (vertexCount, instanceCount, firstInstance)
draw 1      NEAR: mega glyph draw, instanced, indexed by compacted group list
draw 2      FAR:  one impostor draw — per-file quad sampling a line-strip texture
```

- **NEAR** = current Slug path, unchanged. Group texture cap 16000 ≥ 10k files + views.
- **FAR** impostor: when a file's on-screen glyph height < ~4 px, per-fragment bezier
  evaluation is pure waste. The impostor is a **line-color strip**: one RGBA8 texel per
  source line (dominant syntax color per line, written by a compute reduction over
  `color` at load into a texture array, `1 × lines × files` ≈ 5M texels ≈ 20 MB for the
  corpus). At distance, syntax-colored code *is* colored stripes. This is mipmapped
  impostor texturing, content-derived — no per-file render-to-texture bake needed.
- Transition with hysteresis; the existing `occluder` LOD material
  (`GLYPH_LOD_DEFAULTS`, "not byte-native yet") is the in-repo seam for the near/far blend.
- Per-frame CPU: camera uniforms only. Draw calls: 3–5 total at any corpus size.
- The 10k per-file background panels instanced the same way (one instanced draw keyed
  by groupId; panel params in a second texture) — removes the last per-file draw.

### 4.6 Steal #6 — Streaming residency ring (for linux-scale, when 2.4 GB won't fit)

Game-engine texture streaming applied to the arena: the byte/slot arena becomes a
**ring buffer with an LRU residency set**, sized to budget (e.g. 64–256 MB → 5–20M
bytes near the camera). The cull pass (4.5) already classifies groups per frame; a
streaming pass promotes FAR→NEAR groups (copy their byte ranges from a **system-memory
or SSD-backed full store** into free ring segments) and demotes LRU NEAR→FAR (tombstone
to group 0, the existing dead-group mechanism). Content-addressed cache (4.3) is the
backing store. Defrag via the planned arena compaction. This is megatexture/virtual
texturing logic with bytes instead of texels — well-trodden, but it's the *last* thing
to build; 4.1 alone makes 10k-average files fit on a discrete GPU.

### 4.7 Load-time budget (target vs. physics)

| stage | mechanism | budget (200 MB, 10k files) |
|---|---|---|
| read + hash | Go relay, NVMe, blake3 | ~150 ms |
| cache hit serve | prepared records (4.3) | ~0 incremental |
| transfer | fs-RPC binary → ArrayBuffer | **unknown — measure** (risk #1) |
| upload | `writeBuffer`, batched | 100–300 ms |
| GPU kernels | decode + scan over appended ranges | 20–60 ms |
| atlas | pre-warmed + baked (4.2) | ~0 |
| extents | one batched readback/flush (4.4) | ~0 (async) |
| scene nodes | 10k × ~3 Object3D + group texels | 50–150 ms |
| **total (warm cache)** | | **~0.5–1.5 s** |
| **total (cold cache)** | + hash/index build ~1–2 s | **~2–4 s** |

vs. today's ~20 s for 1k files → ~40–100×.

---

## 5. Mapping onto existing seams (what changes where)

| steal | seams touched |
|---|---|
| 4.1 slim lanes | `compute/glyphPipelineKernels.js` (slots → SoA u8/u16/u32 streams; drop `resolveX`, position lanes of `paginateAndBounds`), `compute/glyphPipelineReference.js` (spec first — the spec-is-right law), `core/glyphVertex.js` (position from rowcol + uniforms), `GlyphField.js` byte-pipeline attr block (:918-920), `GlyphPipelineArena.js` (cap → VRAM-budgeted) |
| 4.2 atlas | `shaping/LiveSlugAtlas.js` (reserve-at-capacity, delete hot-swap loop :133-141 and `registerField` contract), `shaping/SlugEncoder.js` (append = writeTexture into reserved texels), `shaping/slugData.js` (fixed buffers), `EmojiAtlas.js` (fixed grid, in-place cell paint), boot path (bake asset load; `tools/bake-slug-core.mjs`) |
| 4.3 cache | relay `cli/` (hash + serve records, binary transport), `tools/blob-store.mjs`, `CodeGrid._beginLoad` (bytes not strings), `app/` load orchestration |
| 4.4 batching | `GlyphPipelineArena` flush (`_syncedItems` watermark already exists — extents join the item table, one `mapAsync`/batch), `core/loadStats.js` (already counts the right things) |
| 4.5 GPU-driven | new `compute/cullKernels.js`, `MegaGlyphField.js` (indirect draw, group visibility lists — builds on the group-texel pose sweep `_syncPoses` and dead-group-0 tombstone), `core/constants.js` (`MAX_GROUPS_DIM`), panel instancing in `FramedGlyphField`/`CodeGrid` (:1082) |
| 4.6 streaming | `GlyphPipelineArena` (ring segments + compaction — the doc already names "arena v1 leaks disposed bytes"), cull kernel (promote/demote lists), blob store as backing |

Untouched by design: picking (`PickingSystem` absolute-slot IDs survive — instance index
== byte offset in both resident and ring schemes), `LayoutDescription` (mirror stays the
CPU oracle), `repaginate()` surface (becomes uniform writes), TSL shared material.

## 6. Risks / open questions

1. **fs-RPC transfer bandwidth is unmeasured** and is the load budget's biggest unknown.
   If the browser boundary is a JS-string WebSocket path, 4.3's transport work is
   mandatory, not optional. Measure first (extend `tools/load-profile.mjs`).
2. **TSL expressiveness** for shader-derived positions and indirect draws — the byte
   pipeline's TSL "has never executed" per the plan doc (Layer 2 kernels now proven
   21/21 on hardware, but the *new* vertex-side derivation is fresh TSL). `wgslFn` is
   the documented escape hatch. three/webgpu indirect-draw support needs verification;
   fallback = compacted instance buffer (one extra pass).
3. **row:20/col:12 packing** caps rows at ~1M/file and cols at 4095 — asserted; minified
   blobs rely on the existing mandatory wrap (wrap is the cost bound, per the design doc).
4. **f16 vs derived positions at world scale**: deriving position in-shader from
   rowcol + group texel (f32 offsets) keeps world precision; no f16 anywhere in world
   coordinates. Per-file panels with large world offsets need the group texel to carry
   the translation in f32 (already the case).
5. **Emoji/CJK tail**: pre-warm covers source-code corpora; the miss ring + batched
   encode handles the tail, but a CJK-heavy corpus invalidates the "zero atlas events"
   assumption — curve texture capacity sizing must keep the 100× headroom.
6. **Color cacheability**: caching colorizer output (4.3) assumes deterministic
   colorizer + theme key in the record key; otherwise cache bytes+lineIndex only and
   recolor per load (color writes are cheap range uploads either way).
7. Conflicts with other likely proposals: anything proposing *multiple* mega
   fields/arenas overlaps with 4.1+4.6 (prefer one arena with u32 cap + ring); any
   "optimize the hot-swap" proposal is **superseded** by 4.2 (delete, don't optimize).

## 7. Rough effort

| item | size | note |
|---|---|---|
| 4.2 atlas append-only + pre-warm + bake | S (3–5 d) | highest ratio of impact to effort; kills the known regressions |
| 4.4 batched extents | S (2–3 d) | spine already computes the inputs |
| 4.3 content cache + binary transport | M (1–2 wk) | relay + browser + blob store; biggest single load-time win |
| 4.1 slim lanes + u32 cap + shader positions | M–L (1–2 wk) | touches spec, kernels, vertex path; gate suite exists (mirror/fuzz/backtrack) |
| 4.5 GPU cull + indirect + FAR impostor + panel instancing | L (2–3 wk) | needs TSL/WGSL indirect verification |
| 4.6 streaming ring | L (2–4 wk) | only when 4.1's footprint doesn't fit; defer until measured |

Suggested order: 4.2 → 4.4 → 4.3 (load time collapses, regressions gone) → 4.1
(capacity unblocked) → 4.5 (per-frame at scale) → 4.6 (linux-scale headroom).

---

### Sources

- [Zed — Leveraging Rust and the GPU to render user interfaces at 120 FPS](https://zed.dev/blog/videogame)
- [osor.io — Rendering Crispy Text On The GPU](https://osor.io/text.html)
- [glyphon — fast 2D text renderer for wgpu](https://github.com/grovesNL/glyphon)
- [WebRender texture_cache docs](https://doc.servo.org/webrender/texture_cache/index.html) · [Improving texture atlas allocation in WebRender](https://mozillagfx.wordpress.com/2021/02/04/improving-texture-atlas-allocation-in-webrender/)
- [Wezterm cache stats (glyph/line-quad/line-state caches)](https://github.com/wezterm/wezterm/discussions/3664)
- [Warp — Adventures in Text Rendering: Kerning and Glyph Atlases](https://www.warp.dev/blog/adventures-text-rendering-kerning-glyph-atlases)
- [Slug Library manual](https://sluglibrary.com/SlugManual.pdf)
- [sluggrs — Slug-algorithm wgpu text rendering (atlas-free vector path)](https://github.com/folknor/sluggrs)

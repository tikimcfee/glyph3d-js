# Game-Engine Techniques Survey — a steal-list for glyph3d-js

*Perf swarm report: GPU font rendering research + GPU-driven rendering patterns from game engines,
translated into concrete designs for this WebGPU codebase.*

## 1. Problem framing

The load path is being redesigned elsewhere ("byte-in GPU pipeline": `TextEncoder` →
`GlyphPipelineKernels.setFiles` → 9 compute dispatches → positions+bounds on GPU). This report
covers the **render-side** question: given millions of static glyph instances in tens of thousands
of per-file groups, what do game engines do that we don't?

Current state (real seams):

- **`MegaGlyphField`** (`packages/glyph3d-core/src/MegaGlyphField.js`) already collapses all glyph
  content into **one instanced draw** over an arena slot buffer — the right skeleton. But it is
  `frustumCulled: false` with **no per-view GPU culling** (explicitly flagged as a future milestone,
  `MegaGlyphField.js:64-66`): every frame rasterizes every glyph of every file, on-screen or not.
  Vertex-stage "culls" only degenerate dead groups after fetching all instance data.
- **`GlyphSlots`** is `float × 13/byte = 52 B/glyph` (`glyphPipelineReference.js:77-94`). At the
  arena cap of 2²⁴ bytes that is **~832 MB** — and `maxStorageBufferBindingSize` defaults to
  **128 MB** in WebGPU, so the slot buffer hits the binding limit around 2.5M glyphs. Both the
  memory and the limit need addressing.
- **Atlas growth** (`shaping/LiveSlugAtlas.js:134-151`) rebuilds the two Slug DataTextures and
  hot-swaps them into every registered field, and the arena miss flow then reallocs kernels,
  re-uploads, and re-dispatches everything (`GlyphPipelineArena.js:263-274`). Classic "bind
  everything, rebind on change" anti-pattern that engines solved with persistent buffers +
  indirection years ago.
- **LOD** is fragment-level only (Slug impostor crossfade, `GlyphField.js:352-392`). There is no
  geometric LOD: at zoom-out we still emit one quad per glyph for text that is sub-pixel.

The reference engines converge on one architecture for exactly this workload (millions of static
instances, few materials): **persistent GPU-resident data + a per-frame compute cull/select pass +
indirect draws**. Sources: Ubisoft "GPU-Driven Rendering Pipelines" (Haar & Aaltonen, SIGGRAPH
2015, [PDF](https://advances.realtimerendering.com/s2015/aaltonenhaar_siggraph2015_combined_final_footer_220dpi.pdf)),
Frostbite compute culling (Wihlidal, GDC 2016), UE5 Nanite
([slides](https://advances.realtimerendering.com/s2021/Karis_Nanite_SIGGRAPH_Advances_2021_final.pdf)),
Unity BatchRendererGroup ([blog](https://unity.com/blog/engine-platform/batchrenderergroup-sample-high-frame-rate-on-budget-devices)).

## 2. Design

### 2.1 The core pattern: persistent arena + cull/select compute + indirect draw

The ACU stage list, specialized to identical-quad instancing (we skip mesh-batch hashing entirely —
all glyphs share one geometry and one material family):

```
per frame:
  1. CPU: writeBuffer group pose block (arena items' TRS)          ~1 MB worst case, µs
  2. COMPUTE A — item cull (one thread per arena item):
       frustum test item box (already produced by glyphPaginateAndBounds, GlyphItemBoxes)
       + screen-space metric: pixelsPerGlyph = projectedRowHeightPx
       → visible items: atomic-append {itemIndex, lodTier} to VisibleItems
       → per visible item write DrawIndexedIndirect args (5×u32) via atomic bump
  3. (tier-gated) COMPUTE B — glyph expansion, only if using single-draw mode:
       per visible item, threads copy hot glyph records into a compaction buffer
  4. RENDER: N × drawIndexedIndirect over VisibleItems   (two-draw mode)
     OR       1 × drawIndexedIndirect over compacted records (single-draw mode)
```

**Two-draw mode (recommended first):** one indirect draw per visible item, args written by compute.
No per-glyph compaction at all — the vertex shader reads `GlyphSlots` directly at
`firstInstance + instanceIndex`, exactly as it already does via `_fieldSlots()`
(`GlyphField.js:629-635`). Visible items are typically hundreds; even 2000 `drawIndexedIndirect`
calls is ~2000 cheap API calls with zero data round-trips. **Caveat:** WebGPU without the
`indirect-first-instance` feature requires `firstInstance = 0` (three.js issue #28389); the
workaround is `baseVertex`-style offset baked into a per-draw args record, or the expansion mode
below. Chrome supports the feature; gate it.

**Single-draw mode (the BRG pattern):** Unity BRG's model, verbatim — one persistent SoA buffer,
plus a tiny per-frame **visibility indirection array**: the vertex shader does
`slot = VisibleGlyphs[instanceIndex]` then fetches from the persistent buffer. Expansion cost is
paid only for visible glyphs: at 2M visible glyphs × 16 B hot record ≈ 32 MB of writes/frame,
sub-millisecond at desktop bandwidth. This is the mode that survives `firstInstance = 0` and gives
one draw total. Atomic-append compaction is the safe primitive (see §2.6); do not start with sorting.

**Memory math for the current 52 B slot:** 10M glyphs × 52 B = 520 MB resident + binding-limit
violation past ~2.5M. Split hot/cold:

- **Hot record (vertex shader), 16 B/glyph**: `x, y, z` (3×f32) + packed `glyphId:12 | flags:4` in a
  u32. 10M glyphs → 160 MB; two bindings or a f16 position variant halves it.
- **Cold lanes (layout kernels only)**: `row, col, baseX, lineAdv, ord, advance, height` stay in the
  existing `GlyphSlots` buffer used by compute but are **not bound at draw**. Colors/highlights
  already live in their own attributes/texture — keep.
- This is the engine trick of keeping matrices as float3x4 in BRG: shrink the per-instance fetch to
  one cache line. 16 B vs 52 B is a 3.25× vertex-fetch bandwidth cut on the hot path.

### 2.2 LOD: screen-space metric in the cull shader + whole-file block impostors

Text's "geometric error" is just glyph screen size, so Nanite's screen-space-error LOD selection
collapses to one scalar per item, computed in COMPUTE A (no BVH, no cluster DAG — skip those):

```
lod = pixelsPerGlyph(rowHeight, itemBox, viewProj)
  ≥ 16 px  → tier 0: full Slug curve evaluation
  4–16 px  → tier 1: Slug with impostor crossfade (existing GLYPH_LOD_DEFAULTS)
  < 4 px   → tier 2: ONE quad for the whole file, sampled from an impostor atlas
  off-frustum → no draw args emitted
```

**Whole-file block impostor** is the biggest zoom-out win: a 2000-glyph file becomes one textured
quad. Bake impostors lazily (render item to a small offscreen tile on layout change, or reuse the
existing readback extent to size it), pack into a fixed `texture_2d_array` impostor pool with an
LRU allocator — this is Nanite's paged streaming model (always-resident coarse representation,
demand-refined detail) at miniature scale. When zoomed out over a 10k-file code map, glyph instance
count drops from millions to ~10k quads; fill rate drops accordingly.

### 2.3 Atlas growth without hot-swap storms (bindless via indirection, not descriptors)

WebGPU has no binding arrays (`maxSampledTexturesPerShaderStage = 16`, `maxTextureArrayLayers =
256`); the engine answer — **one atlas, never rebind per instance** — is already our situation.
The problem is only *growth rebinds*. Fixes, in order of preference:

1. **Fixed-capacity arenas with copy-on-grow.** Pre-size `curveTexture`/`glyphMapTexture` (or their
   storage-buffer equivalents — sluggrs and diffusionstudio/slug-webgpu both moved Slug's textures
   into storage buffers cleanly) at a capacity that covers a full font (Latin+common: a few hundred
   glyphs × ~1–5 KB curve data ≈ 1–2 MB). Grow = allocate new buffer, GPU copy old→new, swap
   **one** indirection record in a single shared bind group owned by the arena — not
   `setSlugData()` on every registered field (`LiveSlugAtlas.js:134-141`). Fields should resolve
   the atlas from the arena handle, the same way byte fields already resolve `_byteSlots`
   per-object. One swap site, O(1) per grow.
2. Append-only region updates (`queue.writeTexture` into the tail) for the common grow-small case —
   no rebinding at all, no texture rebuild.
3. The Slug patent (US 10,373,352) was dedicated to the public domain (Mar 2026) with MIT reference
   shaders; the 2026 revision halves band-texel size (two 16-bit components) and adds dynamic
   half-pixel dilation in the vertex shader — both drop straight into our existing fragment loop.

### 2.4 Upload & streaming discipline (toji.dev best practices + arena suballocation)

- **One-shot static data** (glyph curve data, a finished file's slot block): `mappedAtCreation:
  true`, generate into the mapped range, `unmap()`. No staging copy.
- **The load storm** (thousands of `stage()` calls): a rotating 2–3 buffer **staging ring**
  (`MAP_WRITE|COPY_SRC`, re-`mapAsync` immediately after copy) feeding the arena — the portable
  equivalent of persistent mapping, which WebGPU lacks. Use `getMappedRange()` on exact subranges
  (gpuweb #4805: naive mapped-range use can be slower than `writeBuffer`).
- **Wire compression**: fetch `.gz`/zstd over the fs-RPC, decode in a worker straight into
  `Uint8Array`, then `packBytes` into the u32 `GlyphBytes` buffer as today. Source text compresses
  ~4×; at tens of thousands of files the wire/IPC, not the GPU, is the bottleneck.
- Keep the **arena suballocator** (engines suballocate from few big buffers for exactly our two
  reasons: binding-size limits and bind-group churn). Add free-list reuse — disposed items currently
  leak arena space (`GlyphPipelineArena.js:37-40`).

### 2.5 What to steal from font-rendering research — verdicts

| Technique | Verdict | Why |
|---|---|---|
| **Slug band evaluation + `0x2E74` LUT + 2026 band/dilation revisions** | **STEAL** (already 90% in) | Public-domain patent + MIT shaders; per-instance cost is a quad; fragment cost scales with curves-per-band, not glyph count. Keep quads tight (dilated bbox, not em box). |
| **Slug data in storage buffers inside the arena** (sluggrs measured ~4.8 KB/distinct glyph, 160 glyphs cold-prepped in ~2 ms) | **STEAL** | Kills the texture hot-swap class of bugs; same data layout as JCGT 2017. |
| **MSDF/MTSDF atlas tier** (4 KB/glyph @32², ~6 ALU + 1 fetch in fragment, `fwidth`-based AA) | **ADAPT** | Fallback/effects tier (glow, outline, extreme zoom via mips) and possibly the tiny-size tier (<10 px) where Slug's dilation dominates quad area. Not the primary path at editor density — analytic coverage is crisper. |
| **Vello/piet-gpu principles**: prefix-sum compaction, coarse→fine, append-only GPU buffers | **ADAPT** (already doing: the 9-dispatch scan ladder is exactly this) | Vello itself caches glyphs into an atlas and instances quads — even state of the art doesn't path-render text per frame. Skip the pipeline, keep the principles. |
| **Pathfinder** (tile masks, float winding accumulation) | **SKIP** | Machinery for dynamic vector scenes; its text path is "rasterize to atlas + quads" anyway; maintenance-dead. |
| **Immediate-mode batcher discipline** (ImGui/stb: one draw per (font, atlas), append-only uploads, per-instance UV rect) | **STEAL** | This is the piece that actually matters at millions of glyphs — and MegaGlyphField is already its 3D form. |

### 2.6 GPU primitives: what ships in WebGPU

- **Atomic-append compaction**: core WebGPU, zero risk — use it first (visibility lists, indirect
  args bump counters). The existing kernels already use atomics (`GlyphMissCount`, `GlyphItemBoxes`).
- **Subgroups** (`subgroupSize`, ballots, shuffles in TSL): shipped Chrome 134, optional feature —
  gate it for accelerating the scan ladder (kernels 2–6 in `glyphPipelineKernels.js`), keep the
  workgroup-shared-memory fallback.
- **Radix sort**: only needed if we ever want global depth-ordered glyph rendering. Fuchsia-style
  workgroup sort (wgpu_sort port exists) is the portable choice; Onesweep's decoupled look-back
  assumes cross-workgroup forward progress that WebGPU doesn't guarantee — **skip** unless
  device-gated. Almost certainly unneeded: text within a file doesn't need sorting, and files can be
  sorted on CPU at group granularity (thousands, not millions).
- **Mesh/task shaders**: not in WebGPU, no substitute needed — the expansion pass above is the
  equivalent for identical quads.
- **Hi-Z occlusion**: the existing `OcclusionCuller` (hardware occlusion queries with hysteresis)
  covers whole-grid occlusion; a full Frostbite Hi-Z pyramid is **skip** for v1 — text blocks are
  thin planar slabs that rarely occlude each other except in stacked views, which the query system
  already handles.

### 2.7 TSL sketch — the cull kernel (COMPUTE A)

```js
// one thread per arena item; inputs: GlyphItemBoxes (existing atomic-reduced bounds),
// GroupPoses (existing group texel data, as a storage buffer), camera uniforms
const cullKernel = Fn(() => {
  const item = instanceIndex;  // per-item dispatch, maxItems threads
  const box  = itemBoxes.element(item);          // min/max from glyphPaginateAndBounds
  const pose = groupPoses.element(item);         // TRS
  If(frustumTest(box, pose).not(), () => { Return(); });
  const ppg  = pixelsPerGlyph(box, pose, viewProj, viewport);
  const tier = select(ppg.greaterThan(16), 0,
               select(ppg.greaterThan(4), 1, 2));
  const slot = atomicAdd(drawCounts.element(tier), 1);
  visibleItems.element(tierBase(tier).add(slot)).store(
    packItem(item, tier));
  // tier 2: also write indirect args for the impostor quad draw
  // tiers 0/1: write DrawIndexedIndirect args (two-draw mode) or nothing (single-draw mode)
})().compute(maxItems);
```

20k items = 20k threads ≈ tens of µs. This replaces "rasterize everything every frame" with "pay
for what you see", the single largest render-side lever this codebase is missing.

## 3. Mapping onto existing seams

| Engine pattern | Lands on | Change |
|---|---|---|
| Persistent instance arena | `GlyphPipelineArena` + `GlyphSlots` | Split 52 B slot → 16 B hot draw record + cold compute lanes; keep kernels writing both (or hot derived by one extra dispatch) |
| Cull/select compute + indirect args | new kernel beside `glyphPipelineKernels.js`; consumes existing `GlyphItemBoxes` | New; `MegaGlyphField` swaps its fixed `instanceCount` draw for `drawIndexedIndirect` (three r18x supports indirect draws on instanced meshes; needs the `indirect-first-instance` gate or expansion mode) |
| BRG visibility indirection | `core/glyphVertex.js` `_fieldSlots()` | One extra indirection load: `slot = visibleGlyphs[instanceIndex]` before the slot fetch — shared verbatim with the picking material, so picking inherits culling for free |
| Screen-space LOD tiers | `GLYPH_LOD_DEFAULTS` fragment dials stay; tier 2 is new | Impostor atlas `texture_2d_array` + per-item bake; tier decision moves from fragment to compute |
| Fixed-capacity atlas arena, O(1) grow | `LiveSlugAtlas.ensureGlyphsEncoded` / `setSlugData` fan-out | Arena-owned canonical atlas handle; fields resolve from it (as they already resolve `_byteSlots`); grow = GPU copy + one swap |
| Staging ring + mappedAtCreation uploads | `GlyphPipelineKernels.appendFiles` / `packBytes` path | Replace per-flush `writeBuffer` with ring; decode compression in workers before `stage()` |
| Whole-grid occlusion | `OcclusionCuller` | Keep as-is |

Conflicts/dependencies with other swarm proposals: the byte-in pipeline (already the production
path) is a **dependency** — `GlyphItemBoxes` bounds are what make per-item GPU culling free. The
slot-stride shrink overlaps with any "fix the 52 B/byte" proposal — coordinate. The atlas indirection
fix directly resolves the "atlas-grow hot-swap" regression; whoever owns that regression should take
§2.3 as the fix design rather than patching the fan-out loop.

## 4. Risks / open questions

- **`firstInstance` in indirect draws**: not core WebGPU. Two-draw mode needs the
  `indirect-first-instance` feature (Chrome: yes; Firefox/Safari: check) or falls back to
  single-draw expansion mode. Decision gates the whole render path — resolve first with a probe.
- **three.js indirect-draw support** in `three/webgpu` for instanced meshes is young; may need a
  renderer patch or a raw-pass escape hatch. The existing `rebindByteSlots` workaround
  (`glyphVertex.js:43-92`) shows we're already at the edge of three's bind-group caching.
- **128 MB binding limit**: even the 16 B hot record caps at 8M glyphs/binding. Either multiple
  bindings with per-draw selection, or accept an 8M-glyph ceiling per arena (likely fine:
  8M chars ≈ 150k lines × 50... actually ≈ 8 MB of source — a linux tree is ~1.5 GB of text.
  So: **arena paging is mandatory at true scale**, or f16/quantized positions per item with
  item-local coordinates, which drops hot record to 8 B).
- **Impostor bake cost** on layout storms: thousands of items re-baking tiles at once needs a bake
  queue with per-frame budget, or zoom-out simply shows tier-1 during the storm.
- **Per-glyph compaction bandwidth** in single-draw mode at high zoom with millions visible: bounded
  by 16 B × visible count; fine on desktop, watch integrated GPUs.
- **Forward progress**: keep all new multi-workgroup scans in the existing reduce-then-scan style
  (kernels 2–6 already are); do not import decoupled-look-back.

## 5. Effort estimate (rough, one engineer)

| Item | Size |
|---|---|
| Hot/cold slot split + 16 B draw record | 3–5 d (touches kernels + vertex + picking) |
| COMPUTE A cull kernel + indirect args + two-draw `MegaGlyphField` | 4–7 d (includes the `firstInstance` probe/fallback) |
| Single-draw visibility indirection (BRG mode) | +2–3 d on top |
| Atlas arena indirection (kill hot-swap) | 2–3 d |
| Tier-2 whole-file impostors | 5–8 d (bake queue + array-texture pool) |
| Staging ring + worker-side decompression | 2–3 d |
| Subgroup-gated scan acceleration | 2 d, optional |
| **Total to GPU-driven renderer** | **~3–4 weeks** |

Expected effect: render cost becomes proportional to *visible* glyphs (typically <5% of loaded
content in a code-map view) instead of total; zoomed-out views collapse to impostor quads; load
storms stop paying atlas rebinds and re-dispatch. Combined with the byte-in pipeline, this is the
path from "1000 files / 20 s" to "tens of thousands of files in seconds".

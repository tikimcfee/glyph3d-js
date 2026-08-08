# Field/Mesh Architecture — the ideal draw structure for glyph3d-js

Swarm topic: **FIELD/MESH ARCHITECTURE**. Scope: how millions of static glyphs across
tens of thousands of per-file groups become draw calls. Grounded in
`packages/glyph3d-core/src/GlyphField.js`, `MegaGlyphField.js`,
`core/glyphVertex.js`, and `compute/GlyphPipelineArena.js`.

---

## 1. Problem framing

### Where the repo already is

The byte-pipeline refactor already made the single biggest structural move: **one
`MegaGlyphField` per `GlyphPipelineArena`** (`MegaGlyphField.js:42`), one
`InstancedBufferGeometry`, one shared TSL material (`GlyphField.js:637`
`_getSharedFieldMaterial` — one WGSL build per kind), and a per-file render
presence that is just a **view**: `{ groupId, slotBase, byteCount, node }`. Per-file
transforms already work the right way — a per-instance `instanceGroupId` indexes a
group table (a 5×RGBA32F-texel `DataTexture`, `GlyphField.js:60-72`) carrying a full
TRS pose + color + alpha + clip, applied in the shared vertex transform
(`core/glyphVertex.js:196-215`). This is the correct skeleton. **One global field
with per-file ranges is the right answer; thousands of per-file `GlyphField`s is
dead on arrival** (per-field geometry/attributes/pick-registration ×2 with the
filename — the exact cost `MegaGlyphField.js:1-10` was written to kill).

So this report is not "merge everything into one draw" — that is done. It is:
the current single-draw design **draws every resident glyph every frame and pays
~76 GPU bytes per source byte**, and neither survives the target scale.

### The numbers that break the current design

Target scene: 10–80k files, 100M–1G source bytes (torvalds/linux ≈ 80k files,
~1.5GB).

**GPU memory per source byte, today (byte-pipeline path):**

| Lane | Size | Source |
|---|---|---|
| Layout slot buffer | 13 f32 = **52 B** | `glyphPipelineReference.js:77` `SLOT_STRIDE = 13` |
| `instanceColor` | 3 f32 = 12 B | `GlyphField.js:921` |
| `instanceGroupId` | 1 f32 = 4 B | `GlyphField.js:923` |
| `instancePickingId` | 1 f32 = 4 B | `GlyphField.js:926` |
| highlight texture | RGBA8 = 4 B | `GlyphField.js:857` |
| **Total** | **≈ 76 B / source byte** | |

100M bytes → **7.6 GB**. 1GB of source → 76 GB. Full residency is impossible;
even the "10k files × 30KB" mid case (~300M bytes) is ~23 GB. The arena's own
header already hit this wall at 16M bytes ≈ 700MB (`GlyphPipelineArena.js:67-70`).

**Vertex load, today:** the mega mesh is `frustumCulled: false`
(`MegaGlyphField.js:64-66`) with `geometry.instanceCount` = the arena watermark —
**every resident instance is drawn every frame**, invisible-group instances merely
degenerate in the vertex shader (`glyphVertex.js:221-226`). 100M glyphs × 6 verts =
**600M vertex shader invocations per frame** ≈ 300ms on a high-end GPU
(~2 Gvert/s). Culling is not an optimization at this scale; it is the difference
between rendering and not rendering.

**CPU per-frame / per-attach costs that scale with N:**

- `_syncPoses` (`MegaGlyphField.js:219`): 16-float compare + decompose per view,
  every frame, O(views). 10k views ≈ 160k compares/frame — tolerable but pure
  waste for a static scene; and every `setGroup*` call marks the **whole** group
  texture dirty (`GlyphField.js:1473` — up to 1.28MB re-upload per change).
- `setGlyphGroupRange` + `setGlyphColorRange` per attach (`MegaGlyphField.js:154-155`)
  are **JS loops over every byte of the file** (`GlyphField.js:1398`, `:1258`).
  30KB file → 60k JS writes; 10k files → ~600M writes. This alone is seconds.
- Picking registration fills `instancePickingId = base + slot` for the **entire
  capacity** (`MegaGlyphField.js:208-216`) — an O(capacity) CPU fill for an ID
  that is computable in-shader.
- `MAX_GROUPS_DIM = 16000` (`GlyphField.js:58`) — the group table is a
  `GROUP_COLS × maxGroups` DataTexture, so groups are capped by texture height.
  80k files + filenames needs ~160k groups. (Worse: 16000 already exceeds WebGPU's
  *guaranteed* `maxTextureDimension2D` of 8192 — it only works on devices with a
  16384 limit. Latent portability bug.)

### The game-engine reference point

A scene of 10k static groups with millions of instances is a solved problem:
pre-baked instance data, **GPU-driven culling** (compute pass over per-group
bounds → indirect draw buffer), **hierarchical LOD** (impostors for the far tier),
bindless/shared materials, and **streaming residency** (only the working set is
resident). Draw calls: single digits to low hundreds, all sharing one pipeline.
The design below is exactly that, expressed in this repo's seams.

---

## 2. Design: the GlyphWorld

### 2.1 One address space, three data tiers

Keep the arena's core invariant — **slot index == arena byte offset == global
glyph identity** (picking, color, highlight all already speak this address space).
Split what lives at each address into tiers by access pattern:

```
BYTES (Uint8, append-only arena — exists today)
   │  layout kernels (exist today)
   ▼
SLOTS (layout working state, GPU-internal)      ── warm tier, shrinkable
   │  NEW: emit stage (last kernel, or paginate kernel extension)
   ▼
DRAW RECORDS (16 B/glyph, render-only, AoS)     ── hot tier, this report
   │
   ▼
GROUP TABLE (storage buffer, ~112 B/group)      ── per-file pose+style
```

**The draw record** — the only per-glyph data the vertex shader fetches:

```c
struct DrawRecord {          // 16 bytes, AoS
    float x, y;              // grid-local anchor (z lives in the group pose)
    uint16 wF16, hF16;       // quad size as half floats
    uint16 glyphId;          // slug/emoji map index
    uint16 groupId;          // → group table (64k groups)
    // (color in a separate sparse lane — see 2.3)
};                           // 12 B packed to 16 B alignment; pad carries flags
```

vs. today's effective per-byte render fetch of 76 B across five buffers. **4.75×
smaller**, and one 16 B cacheline-per-4-instances fetch instead of gathers across
color/group/picking/slot buffers. AoS (not SoA) is right here because the vertex
shader reads *every* lane; SoA is right only for the layout working lanes, where
kernel stages touch disjoint columns — which the existing scan kernels already do.

The emit stage runs inside the existing pipeline flush (extend `kPaginate` or add
a tenth dispatch in `glyphPipelineKernels.js`): read the 52 B slot, write the 16 B
record. 100M glyphs × (52 read + 16 write) ≈ 6.8 GB of traffic ≈ **10–25 ms
one-time on a 300–700 GB/s GPU**, incremental per append. Spaces/newlines: emit
only slots that rasterize or carry a fill (~70% of bytes) — the emit writes a
compacted stream per view, and the view records `{slotBase → recordBase, recordCount}`.

> Handoff note: the 52 B slot buffer remains the layout working set (needed for
> repaginate/verify). Shrinking it (f16/packed lanes, ~24 B) is the pipeline
> team's call; the draw record makes the *render* cost independent of it.

### 2.2 Group table: DataTexture → read-only storage buffer

Replace the 5-texel group DataTexture with a read-only storage buffer (the exact
pattern `_fieldSlots`/`byteSlots` already proves in `glyphVertex.js:153-157` —
read-only vertex-stage storage is core WebGPU and already shipped here):

```c
struct Group {               // 112 B
    float4x4 world;          // 64 B — full matrix, not TRS texels
    float4   color;          // rgb multiplier + alpha (visibility lane)
    float4   clip;           // clipTop, clipBottom, clipEnabled, colorBlend
};                           // 64k groups = 7 MB
```

Wins, each killing a live cost:

- **No group cap** — 16000-row texture limit (and the 8192 portability trap) gone.
- **Partial updates** — `queue.writeBuffer(groupBuf, groupId*112, …)` per changed
  group instead of `needsUpdate` on a 1.28MB texture per `setGroupAlpha` call.
- **Full mat4** — the `_syncPoses` decompose-to-TRS-texel dance
  (`MegaGlyphField.js:228-232`) becomes a 16-float copy; and **cold files never
  need an `Object3D`**: the arranger writes matrices directly into the backing
  `Float32Array`, dirty-range tracked, flushed once per frame. `Object3D` identity
  stays only for interactive views (panels, caret, dragged grids) — dozens, not
  10k. Per-frame CPU for transforms goes from O(views) compares to O(moved).

Per-file transforms, colorization and visibility in a merged world — the
assignment's core question — are then just: **groupId per draw record (u16, written
once by the GPU emit stage) → one storage read in the vertex shader**. The two
O(fileBytes) JS loops at attach (`setGlyphGroupRange`, `setGlyphColorRange`)
disappear: groupId is emitted GPU-side, and the per-file default color lives in
`Group.color` (syntax-color overrides are the sparse lane, below).

### 2.3 Color: group default + sparse override lane

Per-glyph `instanceColor` (12 B f32×3) is 95% redundant: syntax colorizer writes
are contiguous capture ranges over a per-file default. Ideal:

- `Group.color` = the file's default text color (already the semantics of
  `MegaFieldView.color`).
- A parallel **RGBA8 color lane, allocated only for colorized ranges** (or simply
  RGBA8 for all resident glyphs if simplicity wins: 4 B vs 12 B, and
  `setGlyphColorRange` becomes a `writeBuffer` of packed u32s — no JS loop, no
  f32). The vertex shader does `color = override.a ? override.rgb : group.color`.
- Highlight texture stays as-is (RGBA8/byte, already capacity-pre-sized at
  `MegaGlyphField.js:75`) — it is interaction-rate and fine. Sparse chunking is a
  later trim.

### 2.4 Draw structure: GPU-driven visibility, three LOD tiers

This is the load-bearing change. The single-draw-over-everything ideal is kept
**as an address-space ideal**, but the *drawn set* must be produced per frame.

**Cull pass (one tiny compute dispatch, every frame):** 10–160k view records
`{worldAABB (from the existing GPU bounds reduce — `GlyphPipelineArena.js:314`
already readbacks per-item extents), groupId, recordBase, recordCount}` are tested
against the frustum, and a screen-size metric assigns each visible view a LOD
tier. Output: an **indirect draw-args array** per tier. Cost: nanoseconds per view;
10k views is one workgroup wave.

**Tier EXACT (near):** the current Slug material, but drawn as **one
`drawIndexedIndirect` per visible view** — `instanceCount = view.recordCount`,
`firstInstance = view.recordBase`. All draws share one pipeline and one bind-group
set, so N draws are pure GPU vertex work: 100–2000 visible views is *nothing*
(WebGPU encodes indirect draws at ~µs each; engines ship 10k+). Worst-case vertex
load is bounded by what fits on screen — typically 2–15M verts, not 600M.

**Tier IMPOSTOR (far):** generalize the existing occluder LOD
(`GlyphField.js:427-455` `_buildOccluderOutputNode` — opaque, discard-free,
depth-writing, density-colored) from per-glyph to **one quad per file (or per
page)**: 10k far files = 60k verts in **one** instanced draw, instance list
compacted by the same cull pass. Opaque + depth-write means far towers occlude
both each other and, via early-Z, whatever exact-tier text sits behind them.
Optional upgrade: bake a text-mass stripe texture per file into a shared atlas
(real glyph silhouettes instead of density glow) — a render-to-texture job at
stage time, ~1 draw per staged file amortized.

**Tier CULLED:** never reaches a draw command — this is the point. Zero vertex
cost, strictly better than today's alpha-degenerate cull.

**Draw-call budget, steady state:** EXACT draws (≈ visible views, capped ~2000) +
1 impostor draw + 1 pick-pass reuse of the same indirect buffers + app chrome.
**3–8 distinct pipelines, low-hundreds of draws worst case.** Frame budget:
cull ~0.1ms, exact-tier vertex ~2–8ms at 10M visible glyphs, impostor ~0.1ms.

**Picking:** `instancePickingId` dies — pick ID = `pickBase + recordIndex`,
computable in the pick shader from the same indirect draw's `firstInstance`
(exactly the "ID = base + absolute slot" contract `MegaGlyphField.js:203-207`
states, minus the O(capacity) CPU fill). The pick pass re-encodes from the same
indirect buffer; `resolveSlot()`'s binary search (`MegaGlyphField.js:122`) is
unchanged.

### 2.5 Residency: a streaming ring, not an append-only leak

Above ~100M glyphs even 16 B records (1.6 GB) plus the slot buffer exceed a sane
VRAM budget, and the arena already admits the append-only leak
(`GlyphPipelineArena.js:37-40`). Ideal: the arena is an **LRU window over the
dataset**:

- Bytes are the canonical store (cheap, compressible, pageable).
- A view's slots + draw records are **evictable and rebuildable**: layout is a
  deterministic function of (bytes, trie, page params), so re-entry re-stages the
  file and the emit stage refills its records — the machinery is today's
  `stage()`/`requestFlush()` with a reuse-allocator replacing pure append.
- Eviction policy driven by the cull pass's own output (last-visible frame per
  view — free). Tombstoning to group 0 (`MegaGlyphField.js:71`) is the
  placeholder; the ring makes it a real reclaim.

This caps VRAM at a configured ceiling (e.g. 1–2 GB) regardless of repo size —
the only design point that makes "all of torvalds/linux" honest.

---

## 3. Mapping onto the existing seams

| Current seam | Becomes | Effort |
|---|---|---|
| `MegaGlyphField` views `{groupId, slotBase, byteCount, node}` | Same + `recordBase/Count`, worldAABB, lastVisibleFrame | small |
| Group `DataTexture` (`GlyphField.js:60-72`, `GROUP_COLS`) | Storage `Group[]`; `setGroup*` APIs become writeBuffer-offset writes; `_syncPoses` → dirty-range flush, Object3D only for interactive views | medium (picking shaders sample the same texels — `GlyphField.js:67-70` warns they must change together) |
| `instanceColor`/`instanceGroupId`/`instancePickingId` f32 attributes + `_ensureCapacity` realloc-copy (`MegaGlyphField.js:184`) | 16 B draw record (GPU-emitted) + RGBA8 color lane; the whole capacity-grow attribute-copy path and both O(bytes) attach loops die | medium |
| `attachBytePipeline` / `_byteSlots` storage read (`glyphVertex.js:153`) | Vertex shader reads draw-record storage instead of slot storage — same mechanism, same rebind seam (`rebindByteSlots`) | small |
| `_buildOccluderOutputNode` | Becomes the IMPOSTOR tier material (per-file/per-page quad) | small-medium |
| Per-item bounds readback (`GlyphPipelineArena._requestBoundsSync`) | Feeds the cull pass's view AABBs (already computed — just also keep them GPU-side) | small |
| `PickingSystem` (`instancePickingId`, group-texel sampling) | Pick ID computed in-shader; group table reads switch to the storage buffer | medium |
| **New: indirect draws** | three r185 has **no public drawIndirect API**; all compute goes through TSL `renderer.compute` (`glyphPipelineKernels.js:1103-1111`). Needs a thin raw-encoder lane off `renderer.backend` (device is reachable; the render pass can be a custom `RenderObject` hook or a minimal upstream patch) | the one real platform risk |

### Staging plan (each step independently shippable)

1. **Phase 1 — memory + CPU, no new GPU machinery (~70% of the win):** packed draw
   record + emit stage; group table → storage buffer; kill the three f32 attribute
   lanes, the picking-id fill, and the attach-time JS loops. To get *some* culling
   before indirect draws exist: partition the arena into **chunk meshes**
   (~4M records each) with real `boundingBox`es (stage views in arranger spatial
   order so chunks are coherent), letting three's per-object frustum cull drop
   whole chunks — the `setLayoutExtent` mechanism (`GlyphField.js:1786`) already
   exists, per chunk. ≤ ~6 visible chunk draws + impostor draw.
2. **Phase 2 — GPU-driven draws:** cull compute + per-view `drawIndexedIndirect`;
   chunk meshes retire back to one geometry; view-level culling replaces
   group-alpha culling.
3. **Phase 3 — scale-out:** LRU residency ring; impostor texture baking; sparse
   highlight/color lanes.

---

## 4. Risks / open questions

- **Indirect draws in three r185.** No public API; the injection point (custom
  backend hook vs. upstream patch vs. a second raw WebGPU pass outside three's
  render graph) needs a spike. Fallback is Phase 1's chunked meshes — decent, not
  ideal. Everything else in the design works without it.
- **Transparent sorting across views.** Today one transparent draw = one sort
  bucket; multi-draw indirect keeps identical behavior only because glyphs run
  `depthWrite: true` (`GlyphField.js:695`). Interleaved translucent panels could
  expose ordering — same exposure exists today, but watch it.
- **Read-only storage in the vertex stage** is core WebGPU and already relied on
  (byteSlots) — but each new storage buffer per stage counts against
  `maxStorageBuffersPerShaderStage` (guaranteed ≥ 8). Budget: slots/records,
  groups, color lane, indirect args — fits, but the WebGL2 fallback has none of
  this (already excluded — `GlyphPipelineArena.js:77-79`).
- **Group-table consumers beyond the vertex shader.** PickingSystem's WebGL
  shaders sample group texels by the `GROUP_COLS` layout; EmojiAtlas/highlight
  paths are unaffected. The switch must be atomic across render + pick (the
  repo's own "change in the same breath" rule, `GlyphField.js:69`).
- **Impostor fidelity.** Per-file density quads read as "text mass" from
  distance — good for navigation, bad for legibility-at-mid-range. The baked
  stripe-atlas upgrade is where design effort goes if mid-range reading matters.
- **Bind-group-per-draw cost** if views ever need distinct bindings — avoided by
  keeping one bind group set and view-varying data in the group table (indexed),
  which is why the group table is a buffer and not per-view uniforms.
- **f16 position precision** if positions ever pack below f32: grid-local coords
  at worldScale 0.025 stay well inside f32; don't pack positions to f16, only
  sizes.

## 5. Effort estimate

| Phase | Work | Estimate |
|---|---|---|
| 1 | Draw record + emit kernel, group storage buffer, lane removal, chunk meshes | **1.5–2 weeks** |
| 2 | Cull compute + indirect-draw injection + pick-pass port | **1–2 weeks** (spike-dependent) |
| 3 | LRU ring + impostor baking | **1.5–2 weeks** |
| | Total to full design | **~4–6 weeks, one engineer** |

Phase 1 alone takes per-byte GPU cost 76 B → ~20 B, kills the O(N·bytes) CPU
attach loops and whole-texture uploads, and restores frustum culling — it is the
mandatory foundation regardless of how Phase 2's indirect draws land.

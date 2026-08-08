# Culling and LOD at Scale — GPU-Driven Visibility for 10k+ Files

Swarm topic: visibility and level-of-detail. Scope: per-file frustum culling, occlusion,
LOD tiers for distant text, and the frame budget when thousands of files are on screen.
Grounded in: `packages/glyph3d-core/src/` (`MegaGlyphField.js`, `GlyphField.js`,
`compute/GlyphPipelineArena.js`, `compute/glyphPipelineReference.js`, `picking/PickingSystem.js`,
`services/visual/OcclusionCuller.js`, `core/glyphVertex.js`, `collections/BoundedObject3D.js`),
three r185.1 (`three/webgpu`).

---

## 1. Problem framing

### 1.1 What the app already is

The byte-in pipeline has collapsed the scene to (almost) one draw:

- **`GlyphPipelineArena`** — one concatenated byte buffer for the whole app, one slot per
  byte, `SLOT_STRIDE = 13` f32 = **52 B per source byte**. Nine compute dispatches per
  coalesced flush produce positions + per-item bounds entirely on GPU.
- **`MegaGlyphField`** — ONE `GlyphField` mesh for every byte grid. A file is a *view*:
  `{ groupId, slotBase, byteCount, node }`. Pose lives in the group DataTexture (5 RGBA32F
  texels/group: offset, quat, color+alpha, scale, clipY). Group 0 is the dead group
  (alpha 0 → vertex cull). The mesh is explicitly `frustumCulled: false` with the comment
  *"per-view culling is the visibility lane, a later milestone"*. **This report is that
  milestone.**
- **`GlyphPipelineArena._requestBoundsSync`** already reads back a per-item bounds table
  once per flush and lands it on every view via `setLayoutExtent` → `view.bounds`. So a
  conservative world AABB per file *already exists* on the CPU at zero extra cost.
- **`BoundedObject3D.getBounds()`** gives world AABBs for non-byte-pipeline objects
  (terminals, frames) as a closed form — same currency, different mint.

### 1.2 What is wrong today

1. **No per-file culling.** The mega mesh draws the entire resident arena every frame:
   `instanceCount = arena watermark`, and every vertex of every glyph of every file runs
   the vertex shader (slot load, group-texel loads, pose transform) whether or not the
   file is on screen, occluded, or subpixel. Vertex bandwidth scales with *total loaded
   bytes*, not with what's visible.
2. **Occlusion culling is CPU-orchestrated query readback.** `OcclusionCuller` draws one
   proxy box per candidate at the end of the opaque pass (`occlusionTest = true`), samples
   `renderer.isOccluded()` mid-pass, applies verdicts with hysteresis. Per-candidate cost:
   one extra draw + one occlusion query + JS bookkeeping per frame. At 10k tracked files
   that's 10k queries and 10k proxy draws — and it carries a fault guard because a dead
   device turns the un-awaited resolve into an unhandled-rejection storm
   (`tools/occlusion-resolve-guard.test.mjs`).
3. **No LOD.** A file 200 m away rendering as 2-pixel-tall smear pays the same per-glyph
   cost as the file under your nose. Slug bezier coverage evaluation per fragment for
   subpixel glyphs is pure waste.
4. **Picking re-rasterizes the world.** `PickingSystem.pickAsync` renders the whole glyph
   channel (every instance of the mega mesh) to a full-DPR offscreen target *per cursor
   move*, then reads back one pixel. The pick pass inherits problem 1 exactly.

### 1.3 The scale math that drives the design

`torvalds/linux`-class corpus: ~80k files, ~1.4 GB source, ~30M lines.

| Quantity | Size |
|---|---|
| Full slot buffer if resident | 1.4 G slots × 52 B ≈ **73 GB** — impossible |
| Sane resident working set (streaming) | 16–32 MB of source × 52 B ≈ **0.8–1.7 GB** VRAM |
| Per-file node records (below), 100k files | 64 B × 100k = **6.4 MB** |
| Hi-Z pyramid, 1080p RGBA32F-ish | ~2.1 M texels × 4 B ≈ **8.3 MB** |
| Visible-glyph draw list, 1M entries × u32 | 4 MB |

The key insight that makes the frame budget *view-independent*: **screen area bounds how
much text is readable**. At 1080p, a glyph cell at 10 px height fits ~19k glyphs on
screen; at 6 px, ~57k. Anything beyond that is subpixel noise and should not be drawn as
glyphs at all. LOD tiers keyed on *projected cell height in pixels* cap T0 (real glyph)
work at ~50k instances regardless of whether 10 or 10,000 files are visible.

---

## 2. Design

One new GPU-side subsystem, the **Visibility Engine**: a per-frame compute pipeline that
turns a static per-file node table into indirect draw arguments, plus a LOD ladder that
replaces distant glyph work with line-strip impostors. No CPU readbacks on the frame
path. The CPU's only role is committing node records when content/pose changes
(interaction rate, not frame rate).

### 2.1 The node table — one struct per file

```
struct Node {            // 64 B, storage buffer, one per file/view
  aabbMin : vec3f,       // world AABB (conservative; from arena bounds readback × pose)
  flags   : u32,         // bit0 dead, bit1 pinned (docked/UI), bit2-3 lodForce
  aabbMax : vec3f,
  groupId : u32,         // mega-field group texel / group-buffer row
  slotStart : u32,       // arena byte offset
  slotCount : u32,       // byte count
  lodState  : u32,       // written by cull kernel: tier | visible | occluded (prev frame)
  impostorBase : u32,    // first line-quad slot in the impostor buffer (0 = none)
  impostorLines : u32,
  contentGen : u32,      // bump on edit/restage — invalidates impostor
  pad       : u32,
}
```

100k nodes = 6.4 MB, written by the CPU only on change. The writers already exist:
`MegaGlyphField._syncPoses()` decomposes `matrixWorld` per moved view per frame — extend
that sweep to re-derive the world AABB (8 corners of `view.bounds`, O(1)) and write the
node record. Bounds arrive from the arena's existing `_requestBoundsSync` readback —
**no new readbacks anywhere**.

For a hierarchy: keep it two-level. The app already has natural clusters — the layout
managers (`GridLayoutManager`, `StackLayoutManager`, `StrataLayout`, carrels) place files
in spatial groups. Each cluster gets a `ClusterNode { aabb, firstNode, nodeCount }`
record (a few hundred entries). The cull kernel tests clusters, then only the leaves of
surviving clusters. At 10k leaves a flat cull is already ~free (below); the hierarchy is
for the 100k–1M regime and for cluster-level "everything in this stack is occluded"
short-circuits. Do flat first; add the cluster level when file counts demand it.

### 2.2 Per-frame compute pipeline

Four dispatches, all encoded back-to-back, no CPU sync between them:

```
K1  cullNodes        1 thread / node (or / cluster then / node)
K2  buildHiZ         depth pyramid downsample (only when occlusion enabled)
K3  expandGlyphWork  1 thread / visible T0–T1 node → append slot ranges
K4  expandImpostors  1 thread / visible T2 node → emit line-quad draw args
```

**K1 — frustum + LOD + occlusion in one thread per node.** Reads the node, the camera
uniform (VP matrix, 6 planes or 4 planes + near/far derived, tan(fov), screen height),
and the Hi-Z pyramid from *the previous frame*. Writes `lodState` and, for survivors,
appends the node index to a compacted `visibleList[]` via one `atomicAdd` on a counter.

- Frustum test: sphere from AABB (center, half-diagonal) vs 6 planes. ~30 ALU.
- LOD metric: projected glyph-cell height in pixels,
  `cellPx = (cellWorld * H) / (2 * dist * tan(fov/2))`, `cellWorld ≈ charHeight · worldScale
  · groupScale`. Tier thresholds (tunable):
  - **T0 — full glyphs** (Slug/bezier): `cellPx ≥ 14` — comfortably readable.
  - **T1 — fast glyphs** (atlas bitmap / cell quad path, `RENDER_MODE.BITMAP` exists):
    `6 ≤ cellPx < 14` — legible at arm's length, no bezier coverage in the fragment shader.
  - **T2 — line impostors**: `1.5 ≤ cellPx < 6` — glyphs unrecoverable; the *syntax-color
    texture* of the file is still visible. One quad per source line.
  - **T3 — panel only**: `cellPx < 1.5` — the file is a colored rectangle; the grid
    panel/flat pass already draws that. Zero glyph work.
- Occlusion test: project AABB to screen rect, pick the Hi-Z mip where one texel covers
  the rect, compare node depth vs 4 corner samples. Occluded → culled this frame, but the
  node stays in next frame's candidate set (verdicts are per-frame state in `lodState`,
  not CPU latch — no hysteresis bookkeeping on the CPU; conservatism comes free from the
  standard two-pass ordering below).
- Hysteresis on LOD tier boundaries (±10% band keyed off the *integer* row count or
  distance bucket, not the float) to stop tier flicker at the threshold. Per the byte
  pipeline's standing rule: any discrete GPU decision keys off exact integer lanes, never
  float positions.

Cost at 100k nodes: ~100k threads × <100 ALU ≈ **< 0.05 ms**. This is why "BVH over
files" is *not* the load-bearing structure at 10k files — flat culling of 100k AABBs is
noise to the GPU. The hierarchy earns its keep only for occlusion short-circuit and
>500k nodes.

**K2 — Hi-Z build.** Downsample the main-pass depth buffer into a mip chain (min-
reduction; 8×8 per thread, ~10 levels at 1080p). ~0.1–0.2 ms. Because K1 consumes *last
frame's* pyramid, there is no ordering hazard and no stall — the classic trade: occlusion
verdicts lag one frame, which for static content is invisible, and for moving content is
conservative (a node wrongly culled for one frame is a 16 ms pop at worst; mitigate by
drawing T3 panels regardless — panels are the cheap occluders and the visual floor).

Ordering within the frame (two-phase, GPU-driven standard):

1. Draw **previously-visible** set (last frame's `visibleList` + args, persistently
   resident) → this refreshes the depth buffer.
2. K2 builds Hi-Z from that depth.
3. K1/K3/K4 test everything against the new pyramid and build this frame's lists.
4. Draw **newly-visible** set (delta list: nodes visible this frame that weren't last
   frame — a second compaction counter) with depth test on.

Nothing stalls; nothing reads back; false negatives impossible (worst case is drawing
something hidden for one frame), false positives bounded to one frame.

**K3 — glyph draw expansion.** One thread per visible T0/T1 node appends a *slot-range
record* `{ slotStart, slotCount, groupId }` to `rangeList[]`. Then either:

- **(a) range-expansion kernel** — a second tiny dispatch walks `rangeList` and writes
  every covered slot index into `glyphDrawList[]` (u32 per visible glyph). Bounded by
  visible glyph count, which LOD caps at ~50–100k: 400 KB write, < 0.05 ms. The render
  vertex shader reads `slot = glyphDrawList[instanceIndex]` instead of `slot = instanceIndex`
  — one added indirection load, then the existing slot read.
- **(b) per-node clip tightening** — for a *single huge file* partially on screen, K1
  also intersects the frustum with the node's row range and writes the visible row window
  into the group buffer's clipY columns (the `setClipYRange` mechanism already exists —
  col 4 of the group texture). Vertex-cull drops the rest. This keeps a 1M-line minified
  blob from flooding the draw list.

K3 also writes the indirect args struct `{ vertexCount=4or6, instanceCount, ... }` into
an `IndirectStorageBufferAttribute`.

**K4 — impostor expansion.** Per visible T2 node: either emit one indirect draw over its
pre-generated line-quad range (`impostorBase/impostorLines`), or append to a second
indirect args. Impostor draw is one instanced mesh, `instanceCount` from the args buffer,
each instance a line quad reading `{ pos.xyz, len, colorRGB, row }` (16 B packed) from
the impostor buffer.

### 2.3 LOD content: line-strip impostors (not texture impostors)

The obvious answer for distant text is mipmapped texture impostors (render each file to
a thumbnail atlas, draw one quad). Rejected as the *primary* tier: it needs a raster pass
per file entering T2, an atlas with allocation/eviction, ~200 MB of texture for 10k files
at useful resolutions, and it goes stale on every edit.

Instead: **compute-generated line quads**. A T2 file is drawn as one colored quad per
source line — at `cellPx < 6` a line of text *is* a 1–3 px tall streak, and what the eye
actually reads is the syntax-color pattern (indentation, comment blocks, string runs).
The line table falls out of the byte pipeline for free: leader slots carry `S_ROW`, and
`S_LINE_ADV`/`S_BASE_X` give row extents. Generation kernel: one thread per leader slot
of a file entering residency, writes `{rowY, x0, x1, avgColor}` per row. `avgColor` from
a per-row color reduce over the shared `instanceColor` lane (or dominant-bucket —
sampling every 8th glyph is visually sufficient).

Memory: 16 B × lines. All of linux ≈ 30M lines = 480 MB — so impostors are generated
**lazily, only for files inside the streaming working set** (§2.5), and tiered down to
T3 (panel-only) for files outside it. Working-set impostors: ~2M lines × 16 B = 32 MB.

Edits: `contentGen` bump on the node → impostor range invalidated, regenerated on the
next flush's coalesced window (interaction rate; the arena's repaginate coalescing is the
template). A stale impostor for a frame or two after an edit is invisible at T2
distances.

### 2.4 Indirect drawing — the three.js seam, verified

three r185.1's WebGPU backend already supports indirect draws:
`WebGPUBackend.draw()` calls `renderObject.getIndirect()` and issues
`passEncoderGPU.drawIndirect / drawIndexedIndirect` when
`renderObject.geometry.indirect` is set (`IndirectStorageBufferAttribute`,
`src/renderers/common/IndirectStorageBufferAttribute.js`). So the seam is real and
present — no renderer patch needed:

- mega glyph mesh: `geometry.indirect = glyphArgsAttr`, vertex shader adds the
  `glyphDrawList[instanceIndex]` indirection;
- impostor mesh: `geometry.indirect = impostorArgsAttr`;
- pick pass: same meshes, same indirect args — picking inherits culling for free.

One caveat: WebGPU core has no `multiDrawIndirect`, and three loops `indirectOffsets`
per draw — fine at 2–4 draws. Keep the design to **three indirect draws per frame**
(glyphs T0/T1, impostors, newly-visible delta pass) rather than a draw per node.

Fallback (works today, ships Phase 1): keep `instanceCount = capacity` and let K1 write
per-group visibility into the group state; the existing vertex cull (dead-group alpha 0
path) drops invisible instances. Vertex bandwidth stays at resident-set scale instead of
visible-set scale — acceptable at ≤ 32 MB resident (1.7 GB slot buffer… 32M verts × 52 B
≈ 1.7 GB/frame reads ≈ 100 GB/s at 60 fps — *not* acceptable as an end state, fine as a
two-week stepping stone at the current 1–4 MB arena defaults).

### 2.5 Streaming working set (culling feeds residency)

Culling output is not only draw lists — it's the **residency oracle**. 73 GB of slots
can't be resident, so the arena becomes a cache:

- Nodes in frustum at T0–T2, plus a 1–2 screen-radius prefetch halo and temporal
  hysteresis (keep resident for N seconds after leaving view — scrolling back must be
  instant) → **resident set**: bytes uploaded, slots laid out, impostors generated.
- Everything else → file bytes stay CPU-side (they're tiny), node record + AABB stay
  GPU-side (64 B), T3 panel renders from the flat quad pass.
- Budget: 16–32 MB source resident ≈ 0.8–1.7 GB VRAM. The arena already grows ×1.25–2
  and logs loudly; eviction is tombstone-to-dead-group (already exists) + the deferred
  compaction milestone. The visibility engine hands the arena a per-node `desiredResident`
  bit + last-visible frame number; the arena's flush window stages promotions in priority
  order (T0 candidates first).

This is the piece that makes "tens of thousands of files" mean something: the *scene
graph* holds 80k nodes; the *GPU* holds what you can see.

### 2.6 Picking inherits everything

Today `pickAsync` re-renders the full glyph layer at full DPR per cursor move. In this
design:

- The pick pass renders the **same indirect draw lists** at ¼ resolution — visible glyphs
  only, ~50k instances worst case instead of the whole arena.
- The 24-bit ID ceiling matters again at scale: the mega field registers `base + absolute
  slot` at *capacity* today — at 1.4 G slots that overflows 24-bit by 80×. Fix: the glyph
  pick channel registers only the **compacted visible list** (`id = drawList position`,
  resolved through `glyphDrawList` → absolute slot → `resolveSlot` binary search, all
  existing machinery). ID space needed ≈ visible glyphs ≈ 50k « 16.7M.
- Char-level resolve after a file hit can skip raster entirely: `S_ROW`/`S_COL` are exact
  integer lanes, so row = `floor(localY / lineHeight)`, col via the row's advance table —
  the lazy mirror (`arena._ensureMirror`, interaction-rate, one file) already computes
  exactly this on the CPU. Keep the GPU pick for "which file/line region", use the mirror
  for char precision.

### 2.7 Frame budget, thousands of files visible

Worst case: zoomed-out view of ~5,000 files, ~2M visible lines, ~40k readable glyphs.

| Stage | Work | Budget |
|---|---|---|
| Previous-visible glyph+impostor draw | ~40k glyphs + ~2M line quads ≈ 8.4M verts | 1.5–2.5 ms |
| K2 Hi-Z build (1080p) | 10 mip levels | 0.15 ms |
| K1 cull+LOD, 80k nodes | trivial ALU | 0.05 ms |
| K3/K4 expansion | ≤ visible set | 0.05 ms |
| Newly-visible delta draw | usually small | 0.3 ms |
| Panels/frames/terminals (flat) | 10k quads | 0.3 ms |
| Pick pass (cursor moved, ¼ res, visible only) | ~50k instances | 0.3 ms |
| Post/composite | | 0.5 ms |
| **Total GPU** | | **≈ 3–5 ms** |

Main thread: node-table commits (only changed files), four dispatch encodes, three
indirect draws — **< 1 ms**. That's 60 fps with 3–5× headroom, and the budget is flat in
file count because T0 glyph count is screen-bounded and T2/T3 work is line/panel-bounded.

Compare today: vertex load = entire resident arena every frame (plus again for the pick
pass); occlusion = N proxy draws + N queries + per-frame JS loop.

---

## 3. Mapping onto existing seams

| Existing seam | What changes |
|---|---|
| `MegaGlyphField._syncPoses()` (pose sweep, change-detected) | Also writes the node record (world AABB from `view.bounds` × `matrixWorld`). Same rate, same place. |
| `MegaFieldView.setLayoutExtent` / `view.bounds` (arena bounds readback) | Becomes the AABB source for the node table. No new readback — the one existing per-flush readback feeds culling now. |
| Group DataTexture (`GlyphField._groupTexture`, 5 cols) | Migrate to a **group storage buffer** (adds col: visibility/LOD state written by K1). Storage-in-vertex-shader is fine on WebGPU; kills the 800 KB texture re-upload per visibility change. Must register with the `registerByteSlotsNode/ Material` rebind seam in `core/glyphVertex.js` — the texture-keyed bind-group cache bug (destroyed-buffer submit on realloc) applies to any new storage reader. |
| Group 0 dead-group alpha-0 vertex cull | Becomes the Phase-1 fallback visibility path (cull kernel writes group alpha instead of indirect args). |
| `OcclusionCuller` + `tools/occlusion-resolve-guard.test.mjs` | **Retired.** No query objects, no `isOccluded`, no proxy meshes, no fault guard — HZ occlusion has no readback to fault on. The guard's *reason* (device-loss storms) is handled by the existing device-loss recovery. |
| `PickingSystem` glyph/grid channels | Same meshes + `geometry.indirect`; glyph channel registers the visible list, not capacity. ¼-res target. Char precision via `S_ROW`/`S_COL` + lazy mirror. |
| `GlyphPipelineArena` flush / `_requestBoundsSync` / repaginate coalescing | Unchanged in shape; gains residency promotion queue (priority = LOD tier) fed by the visibility engine, and impostor generation kernel riding the same coalesced flush window. Tombstone/compaction (documented v1 leak) becomes eviction. |
| `geometry.indirect` / `IndirectStorageBufferAttribute` (three r185.1, `WebGPUBackend.js:1862–1876`) | The indirect seam — present upstream, no patch. Verify bind-group cache behavior for an indirect buffer that compute writes (same texture-keyed cache class as the byte-slots bug; if poisoned, same material.dispose() lever). |
| Layout managers (`GridLayoutManager`, `StackLayoutManager`, `StrataLayout`, carrels) | Provide cluster nodes for the two-level hierarchy when flat culling stops being free (>~500k nodes) and for cluster occlusion short-circuit. |

---

## 4. Risks / open questions

1. **Indirect-buffer bind-group staleness.** The known three bug class (bind-group cache
   keyed on textures only — `glyphVertex.js` header) may apply to `geometry.indirect`
   buffers rebuilt on arena realloc. Needs the same audit `tools/arena-realloc-check.mjs`
   gave the slot buffer. Medium risk, known lever (material dispose), one test to write.
2. **Hi-Z on thin text planes at grazing angles.** Text pages are planar; at oblique
   view angles AABB-projected depth is conservative and may under-cull. Acceptable (under-
   culling is safe), but occlusion gains in stacked-file views may be smaller than hoped
   until per-cluster occlusion lands. Measure before building the cluster level.
3. **One-frame pop on newly-visible nodes.** Two-phase draw bounds it to 16 ms; panels
   (drawn unconditionally) mask it. Fast camera flight through dense stacks is the stress
   case; a prefetch halo (K1 marks near-frustum nodes resident + T3-visible) is the fix.
4. **Line-impostor color fidelity.** Row-average color at 2 px is noise-tolerant, but
   minified one-line files are pathological (one quad for the whole file — fine, that's
   what it looks like anyway) and very wide rows need quad splitting (cap quad width,
   split at generation). Low risk, visual-tuning work.
5. **LOD tier flicker** at threshold distances during smooth zoom. Hysteresis band +
   tier keyed off integer distance bucket. Needs a soak test on an animated camera.
6. **Depends on the byte-in pipeline being the only path.** This design assumes
   positions live in the arena slot buffer with `S_ROW`/`S_COL`/`S_LINE_ADV` semantics.
   The legacy `GlyphLayoutKernel`/worker-builder path has no per-row GPU lanes — impostor
   generation and clip tightening don't exist there. If another swarm proposal keeps a
   CPU-layout fallback alive, this design argues against it.
7. **Interacts with the atlas-grow regression** (hot-swap rebinding textures into every
   field per grow). With one mega field the blast radius is already one field; the group
   storage buffer adds one more rebind registrant. Neutral-to-helpful.
8. **WebGPU limits:** storage buffers in vertex stage (fine on all current backends),
   atomic contention on the drawList counters (one atomicAdd per node — collapses after
   convergence; measured in the byte pipeline already).

---

## 5. Effort estimate

Single engineer, incremental, each phase shippable:

| Phase | Content | Effort |
|---|---|---|
| 1 | Node table + K1 frustum/LOD cull writing group-buffer visibility; dead-group vertex-cull path; pick pass at ¼ res over visible groups | 1.5–2 wk |
| 2 | `geometry.indirect` integration + K3 expansion + drawList indirection in `glyphVertex.js`; per-node clip tightening for giant files | 1.5–2 wk |
| 3 | Line-impostor generation kernel + impostor mesh + T2/T3 tier transitions + edit invalidation | 2 wk |
| 4 | Hi-Z build + two-phase occlusion; retire `OcclusionCuller` and its guard | 1.5–2 wk |
| 5 | Streaming residency: arena as cache, promotion/eviction, prefetch halo; cluster level if needed | 2–3 wk |

**Total ≈ 8–10 weeks**, with Phase 1+2 alone delivering the "10k files, no per-frame
full-arena vertex burn" win and Phase 3+5 delivering "80k files addressable".

Validation tooling: extend `app/glyph-bench.html` with a 10k-file flythrough scenario
(frame-time histogram + visible/resident counters); a headless mirror test asserting
cull-kernel verdicts against a CPU reference over random camera paths (the
`layout-mirror.test.mjs` pattern); `layout.verify`-style live assertion that culled nodes
are genuinely outside the frustum.

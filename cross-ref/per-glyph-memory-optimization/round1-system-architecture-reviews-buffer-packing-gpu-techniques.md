# Round 1: system-architecture reviews buffer-packing, gpu-techniques

## Errors Found

### buffer-packing

**BP-E1 — `instanceSize` per-item scale ignored in uniform proposal (Phase A risk section, line ~321)**
buffer-packing acknowledges this as a "risk" but understates the blast radius. `buildBatchBuffers`
(src/workers/builders/index.js line 282–294) uses `item.scale || 1.0` per item, and
`_updateInstanceMesh` (GlyphRenderer.js line 1178–1180) writes `g.size.width/height` from the
`glyphs[i].size` object, which was set at layout time per-item. The shadow `g.size` objects in
`renderedTexts` store the scaled values. If `instanceSize` becomes a uniform, any renderer that
has mixed-scale items will silently produce wrong sizes. The mitigation proposed ("keep
`instanceScale` float attribute") is correct but moves the savings from 8 bytes to 4 bytes and
requires the shadow `g.size` objects to remain or a parallel `g.scale` field to be added. The
Phase A step list (5 steps) does not include updating the shadow `glyphs[i].size` → `glyphs[i].scale`
migration, which is required for `_rebuildAllInstances()` to stay consistent.

**BP-E2 — Uint16 groupId stride claim is wrong (Phase C, lines ~334–341)**
buffer-packing states: "Real savings only come if a second uint16 field can share the slot."
This is correct but then describes the Uint16Array path anyway as a Phase C option. The actual
issue is deeper: a Uint16 scalar attribute has a 2-byte stride, but WebGL 2 requires attribute
element sizes to be 1, 2, or 4 bytes (not enforced per-element, but aligned in the VBO). A
standalone `Uint16` attribute has a 2-byte stride. Three.js `InstancedBufferAttribute` with
`Uint16Array` and `itemSize=1` will produce a 2-byte stride, which WebGL accepts but most GPU
drivers pad to 4 bytes internally anyway. The net saving in actual VRAM is zero unless two
uint16 fields are packed. buffer-packing says this correctly in the note but then lists Phase C
as saving "2 bytes" in the summary table — the summary is misleading because it implies a real
saving whereas the saving is only theoretical unless packing is applied.

**BP-E3 — `_updateInstanceMesh` not updated in Phase A step list**
Phase A step list at line ~316 omits updating `_updateInstanceMesh()` (GlyphRenderer.js line
1179–1180), which reads `g.size.width/height` and writes the size attribute. If the attribute
is removed, this code will attempt to write to a nonexistent `sizes` array and throw. The step
list covers `_createInstanceMesh`, `applyPrebuiltBuffers`, the builder, and `GlyphCollection`
callers, but misses `_rebuildAllInstances → _updateInstanceMesh`.

### gpu-techniques

**GT-E1 — `worldPos` formula misread leads to wrong `gridOrigin` claim (§3)**
gpu-techniques states "moving the entire grid is a uniform change (`gridOrigin`), not a buffer
rebuild. This is a 100% overlap with what the group DataTexture already does for group offset."
The actual vertex shader (GlyphRenderer.js line 292) is:
```glsl
vec3 worldPos = scaled + instancePosition * gScale.xyz + gPos.xyz;
```
The group offset `gPos.xyz` is **added to the already-scaled `instancePosition`**, not added to
a local grid coordinate. So `instancePosition` holds world-space (or mesh-relative) coordinates,
not a local-grid offset that the group offset then relocates. The claim that "gridOrigin IS the
group offset and no new storage is needed" requires that `instancePosition` be reinterpreted as
a local-grid (col, row) coordinate — which is a meaningful change to the coordinate semantics,
not a zero-cost reuse. This conflation makes §3 appear cheaper than it is.

**GT-E2 — `texelFetch` layout arithmetic for 2-texel-per-glyph scheme is incorrect (§2)**
gpu-techniques proposes Texel 1 at:
```glsl
ivec2 coord1 = ivec2((idx + maxInstances) % 1024, (idx + maxInstances) / 1024);
```
This only works if the texture is laid out as all Texel-0s in the first `maxInstances` columns
followed by all Texel-1s. But the width is fixed at 1024, so the row changes when `idx >= 1024`.
The formula breaks for any `maxInstances > 1024` because the second-texel row exceeds texture
height for large meshes. The correct layout for 2 texels per glyph is width=1024, indexing as:
```glsl
int slot = idx * 2;
ivec2 coord0 = ivec2(slot % 1024, slot / 1024);
ivec2 coord1 = ivec2((slot + 1) % 1024, (slot + 1) / 1024);
```
This requires the texture height to be `ceil((maxInstances * 2) / 1024)` rows.

**GT-E3 — Contiguous slot constraint for `gl_InstanceID` picking (§6) understates severity**
gpu-techniques correctly notes the contiguity requirement but says only: "A compacting allocator
or a free-list with `gl_InstanceID` remapping is required." The current `renderedTexts` Map
(GlyphRenderer.js line 1136–1143, `_rebuildAllInstances`) does compact slots on every rebuild —
but `updatePosition()` / `updateColor()` (direct buffer writes, lines 483–545) do not compact;
they write to `entry.bufferStartIndex` which is set at flush time. If text entries are removed
and new ones added without a full rebuild, gaps appear. The `gl_InstanceID` path requires either
always rebuilding after any removal (expensive) or proving that the current code never creates
gaps without a rebuild. That proof is not in the analysis.

---

## Gaps

### What buffer-packing covered that I missed
- Exact byte-per-attribute breakdown with builder source line references — thorough
- DataView-singleton hot-path color packing technique — important zero-alloc detail
- `getMemoryStats()` comment that it auto-reflects new layout — useful integration note
- GLSL ES version compatibility matrix for each phase — useful risk table

### What I covered that buffer-packing missed
- JS heap cost of `renderedTexts` glyph-object shadow (`~400 KB/file`, phase0-system-architecture §6)
- `GlyphCollection._committedTexts` string retention and the fix to drop `.text` field
- GridVirtualizer / LOD / MemoryBudget — out of buffer-packing scope but complementary
- `mesh.frustumCulled = false` (GlyphRenderer.js line 239) and why it blocks GPU-culling

### What gpu-techniques covered that I missed
- Atlas map DataTexture 17 MB cost and Option B compact resize — high-value, low-risk
- Palette texture approach for color indirection — 8 bytes/glyph with small color sets
- `texelFetch` vs `texture2D` precision for DataTexture reads — correctness detail
- `THREE.GLSL3` / `#version 300 es` migration procedure (in/out, `texture()` rename)

### What I covered that gpu-techniques missed
- `GlyphCollection._committedTexts` string storage cost (~75 MB at scale)
- Eviction / lazy load design; `MemoryBudget` LRU accounting
- `SpatialIndex` O(N) → O(log N) frustum query reduction
- `mesh.frustumCulled = false` interaction with proposed culling schemes

---

## Tensions

### T1 — `instanceSize` uniform vs. per-item scale
Both buffer-packing (Phase A) and gpu-techniques (§7 row 2) propose eliminating `instanceSize`
via a uniform. The tension is that `buildBatchBuffers` (builders/index.js line 282) writes
`item.scale || 1.0` per item. buffer-packing proposes keeping `instanceScale` as an attribute
(net 4 bytes saved). gpu-techniques assumes the uniform is sufficient and claims 8 bytes saved.
**buffer-packing is correct**: a single uniform breaks multi-scale renderers. 4 bytes saved is
the realistic target, not 8, unless `CodeGrid`-only rendering is explicitly scoped.

### T2 — `instanceAddedColor` removal: group color vs. highlight DataTexture
buffer-packing (Phase E) proposes replacing `instanceAddedColor` with group DataTexture
color-blend, but notes "per-character highlights require a highlight DataTexture." gpu-techniques
(§4 Option A) proposes the highlight DataTexture directly. These are not contradictory but
buffer-packing's Phase E primary path (group color-blend) is **insufficient for the existing
`CodeGrid.highlightRange()` feature**, which calls `setGlyphHighlight(bufferSlotIndex, color)`
(GlyphRenderer.js line 578) for individual buffer slots. Group color-blend is coarser than
per-character. gpu-techniques's DataTexture path is the correct replacement for character-level
highlights. **gpu-techniques is right on the mechanism; buffer-packing's Phase E primary path
would break `highlightRange`.**

### T3 — Atlas map compact size: Option A (redirect) vs. Option B (trim height)
gpu-techniques presents both options but recommends Option B. buffer-packing does not address
the atlas map. Option B is unambiguously correct as the first step: changing
`Math.ceil(0x110000 / 1024)` to `Math.ceil(0x2600 / 1024)` in GlyphAtlas.js line 365 saves
17.7 MB with a one-line change and zero shader modification. Option A adds shader complexity
for marginal additional savings. **gpu-techniques recommendation is correct; apply Option B
first.**

### T4 — GLSL ES version requirement
Both agents agree `gl_InstanceID` requires GLSL ES 3.00. buffer-packing offers a fract/mod
color decode as a GLSL 1.00 workaround. gpu-techniques says the project already requires
WebGL 2 and proposes `THREE.GLSL3` globally. The tension: `THREE.GLSL3` changes ALL shader
output variables (`gl_FragColor` → `out vec4`, `varying` → `in`/`out`, `texture2D` →
`texture`). Both shaders (GlyphRenderer.js `_getVertexShader()` line 256, `_getFragmentShader()`
line 328) use GLSL 1.00 syntax throughout. A global `THREE.GLSL3` flip is a non-trivial
mechanical rewrite of both shaders. **Prefer feature-gating**: apply GLSL3 only to the picking
material (PickingSystem.js) for `gl_InstanceID`, and keep main shaders on GLSL1 until color
packing is ready to ship. This avoids a single risky global change.

---

## Recommendations

1. **Apply atlas map Option B immediately.** Change GlyphAtlas.js line 365:
   `Math.ceil(0x110000 / 1024)` → `Math.ceil(0x2600 / 1024)`. Saves 17.7 MB GPU, zero shader
   impact, zero API change. Verify max codepoint in `_buildCharset()` stays ≤ `0x25FF`.

2. **Fix BP-E3 before landing Phase A.** Add `_updateInstanceMesh` to the Phase A step list.
   Specifically, after removing the `sizes` attribute, the loop at GlyphRenderer.js line 1179
   (`sizes[i * 2] = g.size.width`) must be deleted or guarded.

3. **Fix GT-E2 before using 2-texel DataTexture layout.** Use interleaved slot indexing
   (`slot = idx * 2`) rather than offset-by-`maxInstances` addressing. Verify texture height
   allocation matches `ceil((maxInstances * 2) / 1024)`.

4. **Scope Phase A to `instanceScale` fallback (4 bytes, not 8).** Document that the
   `instanceSize` uniform is only valid for single-scale renderers. For the worker path
   (`flushAsync`), `item.scale` variation must route to `instanceScale` attribute or be
   forbidden at the `GlyphCollection` level.

5. **Prioritize highlight DataTexture over group color-blend for `instanceAddedColor` removal.**
   Group color-blend (buffer-packing Phase E primary path) breaks `highlightRange()`. Use
   gpu-techniques §4 Option A: 1D Float DataTexture width=maxInstances, update via `texSubImage2D`
   per highlighted glyph. Update `setGlyphHighlight()` (GlyphRenderer.js line 578) accordingly.

6. **Drop `.text` from `GlyphCollection._committedTexts`.** Replace with `.textLength` only
   (phase0-system-architecture §6). This is the lowest-effort change with the highest guaranteed
   saving (~75 MB at 1500 files). Independent of all buffer-layout proposals.

7. **Implement `GridVirtualizer` before per-glyph packing.** Frustum culling reducing active
   renderers from 1500 to ~50 has more total impact than a 57% per-glyph reduction on all 1500.
   The per-glyph work compounds on top of virtualization, not instead of it.

8. **Gate `gl_InstanceID` picking only on the picking material, not globally.** Add
   `glslVersion: THREE.GLSL3` to the picking `ShaderMaterial` in PickingSystem.js only.
   This enables `instancePickingId` elimination (4 bytes) without touching the main render
   shaders. Audit that the material swap in PickingSystem preserves `basePickingId` uniform.

9. **Verify contiguous-slot guarantee before `gl_InstanceID` picking lands (GT-E3).** Audit
   whether text entry removal followed by `addText` without a rebuild can leave gaps in
   `renderedTexts` buffer indices. If yes, add a compaction step to `_removeFromMesh()` or
   make `gl_InstanceID` picking conditional on `this._isCompact` flag.

10. **Add `CodeGrid.getBounds()` call to validate GridVirtualizer integration.** The method
    exists (CodeGrid.js line 236). Verify it returns a current `THREE.Box3` after
    `flushAsync()` completes, not a stale pre-flush box. The GridVirtualizer depends on this
    for correct frustum classification.

---

## Key Insight

The two reviewed agents focus on reducing per-glyph byte count from 56 to 20–22 bytes, which
is valuable, but the dominant memory problem at 1500-file scale is not the per-glyph layout —
it is the fact that all 1500 renderers are simultaneously live. A 57% per-glyph reduction on
1500 active renderers still yields ~580 MB GPU; the same packing applied to only 50 visible
renderers (post-GridVirtualizer) yields ~19 MB. The correct sequencing is therefore:
virtualization first, then per-glyph packing as a compounding improvement on the already-reduced
active set. The atlas map compact resize (17.7 MB, one line) and the `_committedTexts` string
drop (~75 MB, one line) are the two highest-value changes that should ship before any shader
rewrite, because they require zero changes to the rendering pipeline and eliminate real memory
that accumulates today regardless of how many grids are visible.

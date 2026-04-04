# Round 1: buffer-packing reviews gpu-techniques, system-architecture

## Errors Found

### gpu-techniques

**1. gl_InstanceID contiguity assumption is unsatisfied (critical)**
gpu-techniques §6 states the picking-ID derivation requires "glyph slots must remain
contiguous (no holes from deletion)" and then defers this as a constraint. This understates
the problem. `_rebuildAllInstances()` (GlyphRenderer.js:1131–1143) re-packs on every rebuild,
so the buffer is contiguous after a rebuild. But `updatePosition()` and `updateColor()`
(lines 483–545) are direct in-place writes that do NOT compact. If a `removeText()` call
happens before a full rebuild, the vacated slots hold stale data but `geometry.instanceCount`
is still reduced — making `gl_InstanceID` map to a different logical glyph than
`instancePickingId` would have. The picking system's `registerRenderer()` loop
(PickingSystem.js:227–229) re-writes the ID array after every flush precisely because of
this. The derivation is valid only if registration always follows a full rebuild. That
precondition must be documented as a hard requirement in the proposal, not treated as
"audit `_rebuildAllInstances()`".

**2. Palette texture requires a registration API that does not exist**
gpu-techniques §4 proposes replacing `instanceColor` (12 bytes) with a uint8 palette index
(4 bytes). The proposal says "Requires palette registration API on GlyphCollection."
No such API exists anywhere. `GlyphCollection.addText()` (GlyphCollection.js:~100) accepts
`options.color` as a raw `{r, g, b}` object. The builder hot loop in
`buildBatchBuffers` (builders/index.js:281) reads `item.color || defaultColor` directly.
Building a palette means collecting all distinct colors at flush time, deduplicating, and
assigning indices. This is non-trivial: the mapping must survive across incremental
`addText()` calls, be serializable into the worker context, and be communicated back to
the main thread for the palette texture upload. This is a real gap in the proposal, not
a footnote.

**3. Data texture approach (§2) doubles the texelFetch count per vertex**
The proposal states "One `texelFetch` per vertex vs. 7 attribute fetches." This is wrong
in both directions. The current shader does 3 `texture2D` calls (group texture lookups,
GlyphRenderer.js:287–289) plus 1 `texture2D` for the atlas map (line 311) — that is 4
texture lookups already. The data-texture proposal adds 2 more `texelFetch` calls (slot0
and slot1 at §2). The net change is +2 texture lookups per vertex, not 7-to-1. The
statement about "attribute fetches" conflates attribute reads (free in the fixed-function
attribute pipeline) with shader texture samples (serialized memory requests). On
tile-based mobile GPUs the texture path is significantly slower for this access pattern.
The claim that this "has similar throughput" is architecture-dependent and misleading for
the primary mobile/laptop GPU audience.

**4. Compact atlas map codepoint range is wrong**
gpu-techniques §5 Option B states: "max codepoint is U+257F = 9599" and computes
`ceil(9600 / 1024) = 10` rows for the redirect texture. But `GlyphAtlas._buildCharset()`
(referenced in CLAUDE.md) includes box-drawing characters up to U+257F (9599) and also
Braille (U+2800–U+28FF). The CLAUDE.md performance note says "Atlas map DataTexture covers
full Unicode range (17 MB)". The Option B constant `MAX_CP = 0x2600` (9728) cited in §5
happens to cover Braille (ends at 0x28FF), but the comment claims it "covers full charset
in GlyphAtlas._buildCharset()" without verifying this. The actual maximum codepoint in the
atlas must be read from the atlas itself at runtime. A hard-coded `0x2600` will silently
drop any character above that value. The safe implementation is
`Math.max(...atlas.uvMap.keys()) + 1` rounded up to the next power of two, computed once
during atlas generation.

**5. Picking fragment shader RGB encoding is inconsistent with PickingSystem.js**
gpu-techniques §6 proposes this fragment encoding:
```glsl
float b = floor(pid / (256.0 * 256.0));
float g = floor(mod(pid, 256.0 * 256.0) / 256.0);
float r = mod(pid, 256.0);
```
But PickingSystem.js lines 63–66 encodes as `r = floor(id/65536), g = floor(mod/256), b = mod`.
The channel order is swapped: gpu-techniques puts the high byte in `b`, PickingSystem puts it
in `r`. The decode side (PickingSystem `_getPickingId`, not shown but implied by the RGB
encode) must match. If the proposal is adopted without matching the decode, picking IDs will
be read back wrong. gpu-techniques should state explicitly which encoding it adopts.

### system-architecture

**6. `getBounds()` call on CodeGrid is not verified**
system-architecture §2 `GridVirtualizer.register()` calls `grid.getBounds()` and cites
"CodeGrid.js line 236". I did not verify this independently (CodeGrid was not fully read)
but the system-architecture agent should have confirmed the return type is `THREE.Box3`
in world space, not local space, since `GridVirtualizer` constructs `THREE.Frustum` in
world space. If `getBounds()` returns local-space coordinates the frustum intersection
test silently fails. This needs a code citation with the return type confirmed.

**7. `_committedTexts` string removal breaks `updateText()`**
system-architecture §6 proposes removing `text` from `_committedTexts` entries. The comment
in the proposal says "The text is only needed for `updateText()` (which rebuilds the buffer
anyway)." But `updateText()` in GlyphCollection (if it exists) would need the original text
to compute the glyph diff or replacement. If the string is dropped, callers that depend on
reading back the committed text via `_committedTexts.get(id).text` will get `undefined`.
No audit of `_committedTexts` consumers was provided. This is a behavioral break, not just
a diagnostic change.

---

## Gaps

**What gpu-techniques covered that buffer-packing missed:**
- Atlas map texture size (17 MB) as a stand-alone high-ROI optimization. My Phase 0 did not
  address this at all. The Option B compact atlas map is the single highest-value,
  lowest-risk change across all three analyses.
- `texelFetch` vs `texture2D` for data lookups — the exactness argument is valid and worth
  adopting for the group texture lookups already in the shader.
- `InstancedBufferAttribute.updateRange` for partial sub-array re-uploads. I did not mention
  this Three.js feature. It is relevant for the `updatePosition()` / `updateColor()` hot path:
  set `offset = startIdx * 3` and `count = glyphCount * 3` to re-upload only the changed
  range instead of the full 30K-float array.

**What buffer-packing covered that gpu-techniques missed:**
- The `_rebuildAllInstances()` vs `applyPrebuiltBuffers()` dual code path problem: any
  attribute layout change must be kept in sync across both paths. gpu-techniques ignores
  the sync path entirely in every proposal.
- The DataView singleton pattern for zero-allocation color packing in the hot loop.
- Multi-scale items (`item.scale != 1.0` in `buildBatchBuffers` line 282) as a concrete
  constraint that breaks the "instanceSize → uniform" proposal unless handled explicitly.
- Phase ordering rationale: why Phase A (remove instanceSize) is lower risk than Phase D
  (pack color), based on where the write paths are in the code.

**What system-architecture covered that buffer-packing missed:**
- JS heap cost of the `renderedTexts` glyph objects (~400 KB/file). My Phase 0 mentioned
  this as a "CPU-side shadow" concern but did not quantify it.
- The source string duplication between `CodeGrid.content` and `_committedTexts.text`.
- LRU eviction and the unload/reload design. These are orthogonal to per-glyph layout but
  address the dominant memory cost at 1500-file scale.
- Frustum culling is blocked by `mesh.frustumCulled = false` at GlyphRenderer.js:239 —
  system-architecture correctly identified this and explained why it was set.

**What system-architecture missed that buffer-packing covered:**
- Any discussion of per-glyph buffer layout. system-architecture treats GPU instance buffers
  as a fixed 56-byte/glyph constant throughout. The 336 MB GPU budget estimate (§1) would
  fall to ~120 MB with the packed layout (22 bytes/glyph), which changes the eviction
  threshold math significantly.
- Worker transfer compatibility for alternative TypedArray types.

---

## Tensions

**Tension 1: instanceSize removal — uniform vs. computed**
buffer-packing proposes removing `instanceSize` and passing `charWidth/charHeight` as uniforms.
gpu-techniques proposes the same thing (§2, rollout step 2) but also proposes replacing
`instancePosition` with `instanceGridCoord` vec2 and computing world position in the shader.

buffer-packing is correct that `instanceSize` can become a uniform unconditionally for all
current usage: `GlyphRenderer` derives size from `atlasCharSize * worldScale` once at
construction and never varies it per-glyph (confirmed: builders/index.js:77–78 computes
`scaledWidth/Height` once per item and writes identically for all glyphs).

gpu-techniques' `instanceGridCoord` proposal is more aggressive and more fragile. The
`buildBatchBuffers` Z-wrap path (builders/index.js:325–334) means `z` is not always 0 —
it decrements by `zWrapSpacing` at each line-wrap. A `(line, col)` coordinate does not
encode the Z offset. gpu-techniques acknowledges "Stick with `instanceGridCoord` vec2 for
practical use" but does not reconcile this with the Z-wrap code. `instancePosition` removal
is not safe for the general `GlyphCollection` case.

**Resolution:** Remove `instanceSize` (buffer-packing Phase A). Keep `instancePosition` as
vec3. The gpu-techniques grid-coord scheme is valid only for CodeGrid instances that do not
trigger Z-wrap, and should be documented as a CodeGrid-specific future optimization.

**Tension 2: addedColor — DataTexture upload size**
Both agents propose a highlight DataTexture. gpu-techniques §4 Option A states "No memory
win, but the update is a `texSubImage2D` on one texel." buffer-packing Phase E states the
main win is "eliminates the wasted 12-byte allocation for 99% of glyphs that never highlight"
and quantifies it as 120 KB freed per mesh.

These are both correct but non-contradictory. The DataTexture stores the same bytes but
the update path is better. However, the DataTexture is 10,000 × 1 × RGBA32F = 160 KB,
which is the same as the current `instanceAddedColor` attribute (10,000 × 3 × 4 = 120 KB).
The DataTexture is actually 33% larger than the attribute it replaces if RGBA32F is used.
If RGB32F (3 floats per texel) were possible it would match, but WebGL 2 requires RGBA
alignment for float textures. The correct framing is: the DataTexture approach improves
update granularity, not total memory footprint. Using RGBA8 (1 byte × 4 channels) instead
of RGBA32F reduces the highlight DataTexture to 40 KB — a real win — but 8-bit per channel
limits additive highlights to 255 steps. For syntax highlight colors this is fine.

**Resolution:** Use RGBA8 for the highlight DataTexture, not RGBA32F. This saves 80 KB
vs. the current attribute and improves update granularity. Neither agent proposed RGBA8
for this specific texture.

**Tension 3: GLSL version upgrade scope**
buffer-packing (Phase B, Phase D) and gpu-techniques (§8) both note that `gl_InstanceID`
and `floatBitsToUint` require GLSL ES 3.00. buffer-packing notes that upgrading requires
changing `varying` → `in/out` and `texture2D` → `texture` throughout both shaders.
gpu-techniques says this is "a mechanical translation of both shaders" without flagging
that the picking shaders in PickingSystem.js are separate string literals
(PICKING_VERTEX_CORE, PICKING_VERTEX_CELL, PICKING_VERTEX_GLYPH, picking fragment strings)
that also need the same mechanical translation and receive different uniforms. gpu-techniques
mentions the material-swap must preserve custom uniforms (§8) but does not enumerate
which four shader strings need updating.

**Resolution:** The GLSL upgrade touches 6 shader strings: 1 vertex + 1 fragment in
GlyphRenderer._getVertexShader()/_getFragmentShader(), and 4 strings in PickingSystem.js
(PICKING_VERTEX_CORE, PICKING_VERTEX_CELL, PICKING_VERTEX_GLYPH, PICKING_FRAGMENT_CELL/GLYPH).
This is the correct scope; both agents undercount it.

---

## Recommendations

1. **Implement compact atlas map (Option B) immediately.** Change
   `GlyphAtlas.getAtlasMapTexture()` to compute `MAX_CP` dynamically as
   `Math.max(...this.uvMap.keys()) + 1` rounded up to the next power of two, rather than a
   hardcoded constant. Saves 17+ MB with a two-line change. No shader impact.

2. **Add `InstancedBufferAttribute.updateRange` to `updatePosition()` and `updateColor()`.**
   Both methods (GlyphRenderer.js:483, 522) set `needsUpdate = true` on the full array.
   Adding `attribute.updateRange = { offset: startIdx * itemSize, count: glyphCount * itemSize }`
   before `needsUpdate = true` limits the `gl.bufferSubData` call to the changed range.
   This is a pure performance improvement to existing code with no API or format change.

3. **Remove `instanceSize` → uniform `instanceSizeWorld` (Phase A).** Add a vec2 uniform
   to the vertex shader material and set it at renderer construction. Remove the `sizes`
   Float32Array from both builder functions and `applyPrebuiltBuffers`. This is safe for
   current usage since `buildBatchBuffers` already uses a constant `scaledWidth/Height` per
   item. For multi-scale items, add an `instanceScale` float (net 4 bytes saved vs. 8,
   but still correct).

4. **Remove `instancePickingId` → `gl_InstanceID + basePickingId` (Phase B).** Requires
   upgrading both main shaders and all 4 picking shader strings to GLSL ES 3.00
   (`glslVersion: THREE.GLSL3` on both the main ShaderMaterial and the picking materials).
   Removes the `registerRenderer()` write loop in PickingSystem.js:227–229 and the
   post-flush registration step in GlyphCollection.js:522–524.

5. **Upgrade addedColor to RGBA8 DataTexture.** Replace the 120 KB `instanceAddedColor`
   Float32Array attribute with a 40 KB `DataTexture(maxInstances, 1, RGBAFormat, UnsignedByteType)`.
   Update `setGlyphHighlight()` (GlyphRenderer.js:578) to write to the texture. Saves
   80 KB per mesh and decouples highlight updates from the instance attribute upload cycle.

6. **Fix `_committedTexts` text string retention (system-architecture §6).** Before dropping
   `.text`, audit all reads of `_committedTexts.get(id).text`. If `updateText()` exists and
   reads `.text`, either keep the string or implement updateText to accept content as a
   parameter (preferred). Do not silently drop the field without that audit.

7. **Implement `GridVirtualizer` with `mesh.frustumCulled = false` bypass.** Per-mesh
   frustum culling is disabled (GlyphRenderer.js:239) because the instanced mesh bounding
   box is not maintained. The virtualizer works at the CodeGrid (scene-graph) level and
   does not require per-mesh bounding box maintenance. This is the highest-impact
   non-memory optimization: ~1450 draw calls eliminated when out of view.

8. **Implement `unloadContent()` / `reloadContent()` on CodeGrid.** Wire into the
   GridVirtualizer deactivation path with a budget guard. This addresses the dominant
   ~939 MB memory cliff at 1500-file scale. The system-architecture design is sound.

9. **Do not implement the full instance-data DataTexture (gpu-techniques §2).** The two
   extra texelFetch calls per vertex add serialized memory latency on tile-based GPUs
   (mobile, integrated) without a meaningful CPU-upload benefit that is not already
   captured by `updateRange` (recommendation 2) and the highlight DataTexture
   (recommendation 5). The current attribute path is the right architecture for vertex
   data; textures are right for sparse, infrequently-changing data.

10. **Defer the color palette system (gpu-techniques §4).** It requires a new
    `GlyphCollection` API, worker-context palette serialization, and a palette registration
    step at flush time. The complexity is not justified until the dominant memory costs
    (atlas map, instance count × 56 bytes, string retention) are addressed first.

---

## Key Insight

The most impactful single change across all three analyses is not per-glyph packing —
it is the atlas map texture, which wastes 17 MB on zeros for the Unicode range that will
never be used. Shrinking it to cover only populated codepoints (computable dynamically
from `this.uvMap.keys()`) requires two lines in `GlyphAtlas.getAtlasMapTexture()`, zero
shader changes, and zero API surface changes, yet delivers a larger absolute memory saving
(17 MB) than all per-glyph packing phases combined (~34 bytes × 10K glyphs = 340 KB per
mesh). At 200 renderers, packing saves ~68 MB; the atlas map fix saves 17 MB once and
applies globally. This ordering — atlas map first, then per-glyph packing, then
load/unload virtualization — gives the maximum reduction per unit of implementation risk,
and is what all three agents should converge on in Round 2.

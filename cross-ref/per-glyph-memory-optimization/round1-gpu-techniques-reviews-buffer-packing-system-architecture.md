# Round 1: gpu-techniques reviews buffer-packing, system-architecture

## Errors Found

### buffer-packing

**Error 1 — Picking ID encoding is wrong (Section 2 / Phase B)**

buffer-packing proposes: "replace `vPickingId = instancePickingId` with `vPickingId = pickingBaseId + float(gl_InstanceID)`." The claim is that picking IDs are contiguous and equal to `meshBasePickingId + gl_InstanceID`. This is only true *at flush time* and only if slots are never reused or shuffled. `GlyphRenderer._rebuildAllInstances()` (around line 1131) re-emits glyphs in `renderedTexts` insertion order. If a text entry is removed via `removeText()` and a new one added, `gl_InstanceID` for the new slots will not match the registered picking ID counter unless the counter is also reset. `PickingSystem.registerRenderer()` currently writes sequential IDs derived from a **global persistent counter** (`window.__glyph3dPickingIdCounter`), not from `gl_InstanceID`. The two orderings can diverge.

buffer-packing acknowledges this risk at Phase B but does not note the global counter complication, which means the `meshBasePickingId` uniform approach also needs the global counter to be rearchitected. This is not a "low risk" change.

**Error 2 — Uint16 InstancedBufferAttribute normalization (Section 3 / Phase C)**

buffer-packing writes: "WebGL normalizes Uint16 to float in the attribute fetch — wait, it does NOT normalize unsigned integers for non-normalized attributes. Use `attribute uint instanceGroupId;`…"

The fragment is self-correcting but the conclusion is incomplete. `attribute uint` is GLSL ES 3.00 only. If the shader is still GLSL ES 1.00 (current state — no `#version 300 es`, no `glslVersion: THREE.GLSL3`), there is no `uint` attribute type at all. The only option in GLSL ES 1.00 for an integer stored in a typed array is `attribute float` with a normalized `Uint16Array` — and normalization maps `[0, 65535]` → `[0.0, 1.0]`, not `[0, 65535]`. So either (a) the GLSL3 upgrade must happen first, or (b) the groupId must remain a plain float with a `Float32Array` backing. The Phase C "2-byte savings" are only achievable after the GLSL3 upgrade, not independently.

**Error 3 — `instanceColorPack` and the additive highlight "flag" (Section 2)**

The packed layout table lists `instanceColorPack` at 4 bytes and claims it "replaces `instanceColor` (12) + `instanceAddedColor` (12)". But Section 2 also says the additive highlight "can be moved to a second DataTexture or kept as a separate float-per-glyph." The savings table therefore double-counts: `instanceAddedColor` is removed in Phase E (12 bytes), but Section 2 includes it in the `instanceColorPack` savings column (20 bytes total). The table is internally inconsistent. The real per-phase breakdown at the end of buffer-packing correctly separates Phase D (color, 8 bytes) and Phase E (addedColor, 12 bytes), so the summary table is correct but the header table in Section 2 is not.

**Error 4 — Vertex shader world position formula (Section 4, both agents)**

The current vertex shader at GlyphRenderer.js line 292:
```glsl
vec3 worldPos = scaled + instancePosition * gScale.xyz + gPos.xyz;
```
`gScale.xyz` scales the **instance position** (i.e., the glyph's world coordinate), not the quad. The quad is already scaled via `scaled`. If `gScale` is the group scale and defaults to `(1,1,1)`, this is equivalent to `worldPos = scaled + instancePosition + groupOffset`. buffer-packing's proposed size uniform (`instanceSizeWorld`) replaces `scaled`, which is correct, but neither agent notes that any group scale != 1 also stretches the glyph's *position* offset, not just its size. A group scale change would reposition the glyph in world space rather than stretching the quad. This latent bug exists today and any refactor that touches position computation must account for it.

### system-architecture

**Error 5 — `GlyphCollection._committedTexts` does not store the full text string**

system-architecture §6 says: "`this._committedTexts` at line 508–514 stores a new object with `text: this._pendingAdds[i].text`." The actual line reference is in `GlyphCollection.js`. The claim should be verified against the actual flush() path. Based on the worker buffer lifecycle analysis (§6 correctly traces the flow), this is architecturally sound, but the line numbers cited (508–514) should be treated as approximate since file positions shift across commits.

**Error 6 — `getMemoryStats()` always multiplies `groupBytes` by 2 (system-architecture §4)**

system-architecture correctly uses `renderer.getMemoryStats()` for budget tracking, but GlyphRenderer.js line 771 computes:
```js
groupTextureBytes: groupBytes * 2, // CPU + GPU
```
This `* 2` assumes the `_groupData` Float32Array always has a live GPU counterpart, which is true only after the first flush sets `texture.needsUpdate`. Before the first upload the GPU side does not exist. This is a minor over-count in the budget tracker but not a correctness issue in practice. The real concern is that `getMemoryStats().allocatedBytes` sums `attr.array.byteLength` for all instance attributes but does **not** include `groupTextureBytes`. system-architecture's `MemoryBudget` uses `stats.allocatedBytes` for tracking but the `groupTextureBytes` field is returned separately. At 64 groups × 4 × 4 × 4 × 2 = 8 KB it is negligible, but the tracking is incomplete as written.

**Error 7 — CodeGrid.getBounds() existence claim**

system-architecture §8 states `grid.getBounds()` "already exists (CodeGrid.js line 236)." I have not read that line directly, but the claim should be verified before `GridVirtualizer.register()` is implemented, since the three-argument `Box3.expandByObject()` call requires the bounds to be world-space-accurate after any position change.

---

## Gaps

### What buffer-packing covered that I missed

- The `updatePosition()` direct write path at GlyphRenderer.js ~483 reads back per-glyph `{x,y,z}` objects from `renderedTexts` to compute offsets. This CPU shadow heap (~400 KB per 10K-glyph mesh) is a separate concern from GPU buffer size. I did not address it.
- The multi-scale `item.scale != 1.0` path in `buildBatchBuffers` (line 282) breaks the uniform-size proposal. My Phase 2 (instanceSize → uniform) glossed over this. buffer-packing's Phase A correctly identifies the `instanceScale` float fallback (net 4 bytes savings instead of 8).
- The pre-allocated singleton `_colorView`/`_colorBuf` DataView pattern for zero-alloc color packing in the hot loop. I described the concept but not the worker-safe implementation.

### What system-architecture covered that I missed

- The CPU-mirror problem: Three.js retains Float32Arrays backing `InstancedBufferAttribute` permanently. At 1500 files the CPU mirror alone is 336 MB. My analysis focused on GPU memory; this equal-cost CPU mirror is independent of any GPU-side optimization.
- Frustum culling is disabled (`mesh.frustumCulled = false`, line 239) with no override path. The scene-level `GridVirtualizer` approach is the correct fix.
- `CodeGrid.content` and `_committedTexts.text` are distinct string duplicates of the same source. This is a JS heap issue I did not cover.
- LRU eviction with `unloadContent()`/`reloadContent()` is the correct architecture for the 1500-file case. The GPU-side per-glyph savings I proposed are a multiplier on top of this, not a replacement.

### What I covered that both agents missed

- The atlas map texture is 17.8 MB for a charset that requires at most ~152 KB (Option B compact). This is the single largest addressable allocation and requires only a 1-line change to `GlyphAtlas.getAtlasMapTexture()` (line 365). Neither agent mentioned the atlas map at all.
- `texelFetch` semantics vs. `texture2D` with `NearestFilter` for the DataTexture path. The current shader uses `texture2D` with half-texel offset arithmetic; switching to `texelFetch` (GLSL3) removes the offset math and eliminates the category of filtering artifacts.
- The GLSL ES 1.00 → GLSL ES 3.00 migration requires changing output variables (`gl_FragColor` → `out vec4`, `varying` → `in`/`out`, `texture2D` → `texture`) across both the main shaders and both picking shaders. Neither agent enumerated the full surface area of this change.

---

## Tensions

### Tension 1 — "instancePosition is still needed per glyph" vs. "computed position from gl_InstanceID"

**buffer-packing (Section 1):** "Z-wrap in `buildBatchBuffers` (lines 326–333) adds a third dimension, so a pure (line, col) integer encoding does not capture it. Full float32 is justified."

**gpu-techniques (Phase 0, §3):** Proposes replacing `instancePosition` vec3 with `instanceGridCoord` vec2 (12 → 8 bytes) and notes the Z-wrap complication but recommends sticking with vec2.

**Resolution:** buffer-packing is more correct for the general case. Z-wrap means column alone cannot recover Z, and the wrap boundary varies per item. A vec2 encoding of `(col, line)` cannot represent Z-wrap depth. The 4-byte saving from vec3 → vec2 is only achievable if Z-wrap is disabled, which requires a separate `zWrapSpacing=0` restriction on the renderer. For the default CodeGrid path (which uses Z-wrap), `instancePosition` must remain vec3. gpu-techniques §3 should retract the vec2 grid coord proposal for general use; it is only valid for a flat-grid restricted path.

### Tension 2 — GLSL ES version upgrade is "low risk" vs. "mechanical but broad"

**buffer-packing (Phase B/D):** Labels the `glslVersion: THREE.GLSL3` addition as a prerequisite for `gl_InstanceID` and bit-packing, but consistently calls these phases "low" or "medium" risk.

**gpu-techniques (Phase 0, §8):** Identifies that `gl_FragColor` → `out vec4 fragColor`, `varying` → `in`/`out`, and `texture2D` → `texture` changes are needed across all four shaders (vertex + fragment in GlyphRenderer, vertex + fragment × 2 in PickingSystem). This is 6+ shader strings to touch.

**Resolution:** gpu-techniques is correct that the GLSL3 upgrade is a cross-cutting change that touches `GlyphRenderer._getVertexShader()`, `_getFragmentShader()`, `PICKING_VERTEX_CELL`, `PICKING_VERTEX_GLYPH`, `PICKING_FRAGMENT_CELL`, and `PICKING_FRAGMENT_GLYPH` (PickingSystem.js lines 38–119). It should be done as a single atomic commit, not interleaved with per-phase attribute changes. Neither agent recommends this correctly.

---

## Recommendations

1. **Atlas map compact sizing — do this first.** Change `GlyphAtlas.getAtlasMapTexture()` line 364 to use `MAX_CP = 0x2600` (covers all charset entries in `_buildCharset()`), set `ATLAS_MAP_WIDTH = 256`, `ATLAS_MAP_HEIGHT = Math.ceil(MAX_CP / 256)`. Update the two shader uniforms `atlasMapWidth`/`atlasMapHeight` set in `GlyphRenderer._createInstanceMesh()`. Result: 152 KB instead of 17.8 MB, single-lookup shader unchanged, no other code touched.

2. **Batch the GLSL3 upgrade as one commit.** Before any bit-packing or `gl_InstanceID` change, upgrade all four shader strings to GLSL ES 3.00 syntax (`out`, `in`, `texture()`). Set `glslVersion: THREE.GLSL3` on both the main material and both picking materials. Verify the examples still render. This unblocks all other GPU-side optimizations without mixing syntax changes into feature commits.

3. **Remove `instanceSize` → uniform after the GLSL3 commit.** Add `uniform vec2 instanceSizeWorld` to the vertex shader, set from `this.metrics` at construction and on scale change. Remove `sizes` array from both builder functions and `applyPrebuiltBuffers()`. For multi-scale items, add `instanceScale` float (4 bytes) only if `item.scale != 1.0` is actually used in production (check the codebase before adding the attribute).

4. **Replace `instancePickingId` with `basePickingId + gl_InstanceID` only after auditing slot compaction.** The global counter `window.__glyph3dPickingIdCounter` must be rerouted to become a per-renderer `basePickingId` uniform. Confirm that `_rebuildAllInstances()` always emits glyphs in slot-index order and that no gaps exist. This is a prerequisite that buffer-packing did not surface.

5. **Remove `instanceAddedColor` from the hot buffer, add a highlight DataTexture.** Allocate a `THREE.DataTexture` of width=maxInstances, height=1, `RGBAFormat`, `FloatType`, initially zero-filled. `setGlyphHighlight()` (line 578) writes a single texel and calls `texture.needsUpdate`. The vertex shader samples via `texelFetch(highlightTex, ivec2(gl_InstanceID, 0), 0).rgb`. The 12-byte per-glyph attribute disappears; the DataTexture is the same total size (160 KB at 10K) but partial writes are O(1) instead of triggering full attribute re-upload.

6. **Implement `GridVirtualizer` before any per-glyph packing.** At 1500 files the dominant cost is 672 MB of CPU+GPU buffer mirrors, not 56 bytes vs. 22 bytes per glyph. system-architecture §2 is correct: scene-level frustum virtualization eliminates ~1450 of 1500 draw calls without touching the rendering stack. This should ship before any packing work.

7. **Fix the `_committedTexts` string retention** (system-architecture §6). Replace `text: item.text` with `textLength: item.text.length` in the committed map entry. Estimated saving: 75 MB heap at 1500 files. One-line change, zero risk.

8. **Pack `instanceColor` → uint8 only after syntax highlighting is palette-driven.** Color packing to uint8 (8 bytes saved) requires `floatBitsToUint` in GLSL ES 3.00. The real benefit only materializes once the builder emits palette indices rather than per-glyph RGB triples. Audit whether the syntax highlighter in `highlightCommands.js` assigns colors per-glyph or per-token-type. If per-token-type, a palette texture (1 KB, 256 entries) is superior to uint8 packing.

9. **Address the world-position bug in the vertex shader (line 292).** The formula `instancePosition * gScale.xyz` scales the glyph's *position* by the group scale, not the glyph's visual size. This means a group scale of `(2,2,1)` doubles the spacing between glyphs rather than their rendered dimensions. If group scale is intended for visual size, `gScale.xyz` should scale `scaled` (the quad), not `instancePosition`. Fix before the scale feature is advertised.

10. **Use `updateRange` on InstancedBufferAttribute for partial position/color updates.** Rather than flagging `needsUpdate = true` on the entire position array for a single-glyph update, set `attr.updateRange = { offset: slotIndex * 3, count: 3 }` before `needsUpdate = true`. Three.js passes this to `gl.bufferSubData`, uploading only the 12-byte changed region instead of the full 120 KB attribute. This works today without any shader changes and is compatible with both GLSL1 and GLSL3 paths.

---

## Key Insight

Both agents correctly identify the per-glyph attribute redundancy and the path to ~56 → 22 bytes, but the framing underweights where the actual memory pressure lives: the CPU-side mirror of every instance attribute (Three.js retains the typed arrays permanently), the 17.8 MB atlas map texture (99.96% zeros, fixable in one line), and the JS heap cost of 1500 files × 400 KB of per-glyph shadow objects plus duplicated source strings (~1 GB combined). At the 1500-file scale targeted by system-architecture, the per-glyph buffer packing from 56 to 22 bytes saves roughly 100 MB of GPU+CPU buffer space — meaningful, but secondary to implementing frustum virtualization and `unloadContent()`, which together reclaim ~940 MB by ensuring only 50–300 renderers are live at any time. The correct implementation order is: fix string retention (1 line), ship `GridVirtualizer` (pure scene-graph), add `unloadContent()`/`reloadContent()` to CodeGrid, then apply buffer packing as a multiplier on the already-reduced active-renderer set.

# Round 1: Pipeline reviews Memory, GPU

## Errors Found

### Memory: renderedTexts heap estimate is inflated but the problem is real

Memory claims 200-300 bytes per glyph object on the V8 heap, arriving at 1.2-1.8 GB for 6.1M glyphs. The per-object estimate is reasonable (V8 hidden class headers + 5 nested objects + 11 numeric slots), but the scenario of 6.1M glyphs with all grids simultaneously holding populated `renderedTexts` entries overstates the problem. In the worker path (`applyPrebuiltBuffers`, `GlyphRenderer.js:1426`), buffers are swapped in as flat Float32Arrays and the glyph array is reconstructed immediately after (lines 1487-1508). At 555 grids, every grid does hold its glyph objects in memory simultaneously since eviction is off. The 1.2-1.8 GB number is therefore valid under current defaults. Not an error in the finding, but the fix is harder than Memory suggests.

### Memory: "~8 call sites" understates the dependency on entry.glyphs

Memory's fix (section 5b) says to replace `entry.glyphs` with lightweight metadata and update "~8 call sites." The actual count is higher. `entry.glyphs` is read at these sites in `GlyphRenderer.js`:
- `getText()` exposes `entry.glyphs` to external callers (line 580)
- `GlyphCollection.getText()` forwards it to app code (line 942 of `GlyphCollection.js`)
- `_getTextBounds()` iterates glyph positions and sizes (line 1297-1310)
- `updatePosition()` reads `glyphs[0].position` for offset calc AND writes back per-glyph (lines 652-674)
- `updateColor()` writes back per-glyph (lines 697-699)
- `updateAddedColor()` uses `entry.glyphs.length` (line 729)
- `updatePositions()` batch -- same pattern as singular (lines 774-795)
- `updateColors()` batch (lines 822-827)
- `updateBatch()` combined position+color (lines 858-892)
- `_rebuildAllInstances()` spreads glyphs into allGlyphs (lines 1330-1336)
- `getStats()` sums `entry.glyphs.length` (line 1608)

That is 11 distinct sites. The `updatePosition` family is the critical one: it uses `entry.glyphs[0].position` to compute a delta offset, then writes the new positions both to the JS objects AND the typed array. Removing the JS objects requires reading the "current position of the first glyph" from the Float32Array instead (`positions[startIdx * 3]`, etc.). Doable, but the memory agent's proposed struct (`{ bufferStartIndex, glyphCount }`) cannot support `getText()` returning a `glyphs` array without a lazy-reconstruction strategy.

### GPU: Three.js DOES cache shader programs by source hash -- 555 compilations is wrong

GPU claims 555 independent shader compilations and estimates 28 MB of "shader program" VRAM (section 1.8, 50KB/program * 555). Three.js's `WebGLPrograms` module hashes shader source strings + defines + material properties to create a program key. When two materials have identical GLSL source, the same compiled `WebGLProgram` is reused. Since every `GlyphRendererV15` calls the same `_getVertexShader()` / `_getFragmentShader()` methods (lines 320, 403) producing identical strings, Three.js will compile exactly ONE GPU program and share it across all 555 materials. The 28 MB estimate should be ~50 KB total, not 28 MB.

The JS-side overhead of 555 `ShaderMaterial` instances (uniform objects, material tracking) is real but modest -- maybe 500 KB total. GPU's recommendation to use `Material.clone()` (section 5.2) is therefore low-impact. The real savings come from reducing material/uniform JS objects, not preventing shader compilation.

### GPU: instanceSize cannot be derived purely from glyphId for proportional fonts

GPU (section 3.2) proposes deriving `instanceSize` from `instanceGlyphId` in the vertex shader to save 8 bytes/glyph. The width component is derivable (it is the glyph advance), but the proposal says "height is uniform across all glyphs (same font size), so it is just a uniform." This is correct for height. For width, the proposal requires a glyph-width lookup texture. The existing `glyphMapTexture` packs curve data in all four RGBA16UI channels (`GlyphRenderer.js:371-378`). GPU acknowledges this ("both .z and .w are used for band data") and proposes a second texel row or a new 1D texture. This is feasible but not as trivial as presented -- it requires changes to `SlugEncoder`, the vertex shader, all builder functions, and `applyPrebuiltBuffers`. The 48.8 MB savings is real but this is a Tier 2/3 change, not Tier 1.

## Gaps

- **Memory identified `renderedTexts` duplication as the dominant cost (80% of total)**. Neither my Phase 0 nor GPU's analysis noticed this. This is the single highest-impact finding across all three analyses. I focused on dead code and dual paths; GPU focused on VRAM and attribute compression. Neither of us audited JS heap.
- **I identified 6 files with zero imports that can be deleted immediately (Phase 1, ~1,075 lines)**. Neither Memory nor GPU catalogued dead files. Memory focused on runtime memory; GPU focused on GPU resources. Dead code deletion is free risk reduction that neither addressed.
- **GPU identified background plane draw calls (555 extra draws)**. Neither Memory nor I mentioned this. It is minor (0.5 MB, no glyph data) but doubles the draw call count when eviction is off.
- **I identified the `GitHubRepoViewer.init()` fallback try/catch as a policy violation (lines 308-312)**. Neither Memory nor GPU flagged this. The silent fallback to `_shaper=null` / `_slugData=null` contradicts the no-fallback policy and leaves a broken render path that no one tests.
- **GPU's color palette compression (section 3.4, 67 MB savings) was not discussed by Memory or me**. It is the highest single-attribute VRAM saving proposed.
- **Memory's eviction analysis (section 3) is thorough -- correctly noting it exists, works, but is disabled**. GPU also mentions it but Memory provides the concrete 91% off-screen ratio and estimated savings.
- **Nobody analyzed `_rebuildAllInstances()` reachability**. It is called from `render()` (line 1153), `remove()` (line 538), `removeAll()` (line 563), `reRender()` (line 625), and `reRenderAll()` (line 637). This is the sync fallback path that reads from `renderedTexts.glyphs`. If `renderedTexts` is slimmed per Memory's recommendation, these methods break unless they also read from typed arrays.

## Tensions

### Tension 1: Memory says "enable eviction" is low risk; GPU agrees; but eviction + slim renderedTexts interact

Memory (5a) says enabling eviction is a one-line change, low risk. GPU (6A) says the same. Both are correct in isolation. But Memory also recommends slimming `renderedTexts` (5b). The eviction path calls `unloadContent()` -> `dispose()`, which destroys the typed arrays. On re-entry, `reloadContent()` must rebuild everything. If `renderedTexts` no longer stores glyph objects, the `_rebuildAllInstances()` path (which iterates `entry.glyphs` at line 1335) breaks. These two changes must be sequenced: slim `renderedTexts` first, rewrite `_rebuildAllInstances` to not depend on glyph objects, then enable eviction.

### Tension 2: GPU wants to add new textures (glyph-width lookup); I want to remove texture infrastructure

GPU (3.2) proposes adding a new 1D glyph-width texture for `instanceSize` derivation. My Phase 0 analysis recommends deleting texture-related infrastructure (atlas map texture, UV map caches, serialization). These are not contradictory -- GPU adds a small purpose-built texture while I remove legacy bitmap textures -- but they pull in opposite directions on complexity. The glyph-width texture should be an extension of the existing `glyphMapTexture` (second row or repurposed channel), not a new standalone texture, to avoid adding more texture management code while we are deleting it elsewhere.

### Tension 3: Memory estimates "~47 MB after fixes"; GPU estimates "~27 MB with eviction only"

Memory's table (section 6) claims total drops to 47 MB after all fixes. GPU says enabling eviction alone drops VRAM from ~300 MB to ~27 MB (50/555 ratio). These are not contradictory (Memory includes JS heap; GPU counts only VRAM), but they measure different things and could confuse prioritization. The correct framing: VRAM drops to ~27 MB with eviction (GPU's number); JS heap drops from ~1.5 GB to ~20 MB by slimming `renderedTexts` (Memory's number). These are independent wins on different resource types.

## Recommendations

1. **Delete the 6 zero-import files immediately** (my Phase 1). Zero risk, ~1,075 lines removed. Files: `buildBuffers.js`, `textToGlyphs.js`, `layoutText.js`, `InstanceBuffer.js`, `GlyphBatcher.js`, `GlyphInstancePool.js`. Remove their exports from `src/index.js` lines 29, 32-34, 38.

2. **Slim `renderedTexts` but provide a lazy glyph accessor**. Instead of Memory's bare `{ bufferStartIndex, glyphCount }`, store `{ bufferStartIndex, glyphCount, lineSlotOffsets }` and add a `_getGlyphAt(entry, i)` method that reads position/size/color from the typed arrays on demand. Rewrite `updatePosition`, `updateColor`, `_getTextBounds`, `_rebuildAllInstances`, and `getStats` to use `entry.glyphCount` and buffer reads. For `getText()`, return a proxy that lazily constructs glyph objects only when accessed. This preserves the external API while eliminating the 1.2-1.8 GB heap cost.

3. **Enable eviction AFTER slimming renderedTexts**. The sequence matters because `_rebuildAllInstances` (used by the sync render path in `reRender()`) currently depends on glyph objects. Rewrite it to reconstruct from typed arrays first, then enable eviction.

4. **Remove the `GitHubRepoViewer.init()` try/catch fallback** (lines 308-312). Replace with a hard error. If HarfBuzz/Slug fails to load, the app cannot render. Silent fallback to `_shaper=null` creates a broken state that no code path handles.

5. **Remove legacy builder paths** (my Phase 2). Delete `buildGlyphBuffers`, `buildBatchBuffers`, `countGlyphs`, and the `BUILD` handler in `GlyphWorker.js`. Remove the legacy branch in `WorkerBridge._buildBatchBuffersSync()`. Delete UV map cache infrastructure. ~860 lines removed.

6. **Null the atlas canvas after `generate()`** (Memory 5c). Store `_charSize` eagerly, set `this.atlasCanvas = null; this.ctx = null;`. Saves 16 MB RAM. Verify `ensureGraphemes()` is not called post-init in the Slug path first.

7. **Reduce `defaultMaxGroups` from 64 to 4** in `src/core/constants.js:37`. The grow-on-demand path at `GlyphRenderer.js:1106` already handles overflow. Saves 2 MB across 555 grids.

8. **Remove the `GlyphRenderer._textToGlyphs()` fallback branch** (lines 1201-1228). Delete `GlyphLayout` import (line 20). If `GlyphLayout.js` has no other importers, delete it.

9. **GPU's `instanceSize` derivation (3.2) is worth doing but should be Phase 3**. Embed glyph advance widths into `glyphMapTexture` as a second-row texel rather than creating a new texture object. Saves 48.8 MB VRAM. Defer until after dead code removal and `renderedTexts` slimming are done.

10. **GPU's color palette compression (3.4) should be evaluated but deferred**. The 67 MB savings is attractive but the implementation complexity (palette texture per renderer, uint8 attribute, shader changes, color update API changes) is high. Do it only after the simpler wins (1-8) are landed.

## Key Insight

The three analyses converge on one structural problem: the codebase retains dual representations of the same data. My analysis found dead code paths that duplicate functionality (legacy builders alongside shaped builders, bitmap atlas alongside Slug). Memory found that `renderedTexts` duplicates every glyph as a JS heap object when the same data already lives in typed arrays. GPU found that per-renderer resource allocation duplicates shared structures (materials, group textures). The unifying fix is not "optimize" but "deduplicate": delete dead code paths (free ~1,900 lines), make `renderedTexts` a thin index into existing typed arrays (free ~1.5 GB heap), enable eviction for off-screen grids (free ~220 MB VRAM), and share materials properly (free ~500 KB JS). The largest single win -- slimming `renderedTexts` -- is a memory deduplication problem that only Memory identified, and it dwarfs all other optimizations combined.

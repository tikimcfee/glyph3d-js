# Round 1: GPU reviews Memory, Pipeline

## Errors Found

1. **Memory: Slug shared texture size is 10x overstated.** The summary table (section 6) lists "Slug shared textures (3x)" at "~2 MB". The textures are RGBA16UI (8 bytes/texel, per `slug-constants.js:4,36`). For a typical ~400-glyph monospace font, `SlugEncoder.js:204-207` logs the actual sizes in KB. A 1024-wide texture with ~10-20 rows of curve data totals 80-160 KB. The three textures combined are ~130-300 KB, not 2 MB. Memory may have confused RGBA16UI (8 bytes/texel) with RGBA32F (16 bytes/texel) or estimated glyph counts too high. The correct value is ~0.2 MB as stated in my Phase 0.

2. **Memory: "~8 call sites" for `entry.glyphs` is understated.** Memory claims the `renderedTexts` slim-down requires updating "~8 call sites in GlyphRenderer.js". Grep shows `entry.glyphs` referenced at 30+ locations across `updatePosition` (line 652-678), `updateColor` (line 697-709), `updateAddedColor` (line 729), `updatePositions` (line 775-796), `updateColors` (line 822-833), `updateTransforms` (line 862-898), `_rebuildAllInstances` (line 1333-1336), `getStats` (line 1608), `getText` (line 580), and `_getTextBounds`. The real count is ~15 call sites across 10 methods. This matters because it moves the risk assessment from "Medium" to "Medium-High" -- more surface area to refactor than advertised.

3. **Pipeline: `getSerializableGlyphWidths` is NOT dead in the shaped path.** Pipeline section 4 claims the UV map cache infrastructure (including `getSerializedGlyphWidths`) "becomes dead" once legacy builders are removed. However, `WorkerBridge._buildBatchBuffersSync` at line 404 calls `this.getSerializedGlyphWidths()` in the legacy fallback branch (lines 403-411). That branch is only reached when `this._shaper` is null. So the claim is conditionally correct -- it is dead *if* the shaper is always present. But Pipeline frames it as an immediate cleanup (section 4, "Once the legacy builder paths are removed, these become unused") when it is actually a *consequence* of Phase 2 (shaper-always-present assertion), not Phase 1. The dependency ordering matters: you cannot delete the cache infrastructure until you have committed to hard-failing on shaper init.

4. **Pipeline: `buildGlyphBuffers` and `buildBatchBuffers` export claim is partially wrong.** Pipeline section 1F says line 29 of `src/index.js` exports `buildGlyphBuffers` and `buildBatchBuffers`, then states they "should not be public exports" but are "still called internally." In fact, `buildBatchBuffers` is called internally only from `WorkerBridge._buildBatchBuffersSync` (line 406) and `GlyphWorker.js` legacy branch -- both of which are themselves dead under the shaper-always-present assumption. So the internal callers are *also* dead. The export line and the internal callers should be deleted together in Phase 2, not separately.

## Gaps

- **Memory identified the `renderedTexts` duplication (1.2-1.8 GB heap) -- I missed it entirely.** My Phase 0 focused on VRAM and completely overlooked the JS heap mirror of per-glyph objects. This is the single largest allocation in the system, dwarfing the 244 MB VRAM cost. Memory's analysis here is the most impactful finding across all three agents.

- **Pipeline identified ~1,900 lines of dead code -- I missed it entirely.** My Phase 0 did not audit code liveness at all. The six zero-import files (`buildBuffers.js`, `textToGlyphs.js`, `layoutText.js`, `InstanceBuffer.js`, `GlyphBatcher.js`, `GlyphInstancePool.js`) are unambiguously safe deletions that reduce cognitive load and bundle size.

- **I covered shader material duplication (555 identical compilations) -- neither Memory nor Pipeline mentioned it.** The `Material.clone()` optimization to share compiled GPU programs is not addressed by either agent. At 555 grids, this is ~28 MB of estimated GPU driver overhead for redundant shader programs and 555 JS material objects with identical GLSL source.

- **I covered the color palette compression opportunity (67 MB savings) -- neither agent mentioned it.** Replacing `instanceColor` vec3 (12 bytes/glyph) with a uint8 palette index is the largest single-attribute VRAM saving.

- **Pipeline covered the `GlyphAtlas` -> `FontMetrics` refactor path -- I only noted the atlas canvas costs 0 VRAM under Slug.** Pipeline's roadmap (section 6) for migrating `ensureGraphemes` to SlugEncoder and deriving `getCharSize` from HarfBuzz is the right architectural direction. Memory proposed a quicker partial fix (null out the canvas after storing `_charSize`), which is the correct interim step.

- **Neither Memory nor Pipeline addressed `updatePosition`/`updateColor` reading stale data.** The `renderedTexts.glyphs` array is written during `applyPrebuiltBuffers` and then mutated in-place by `updatePosition` (line 665-667) and `updateColor` (line 699). If these methods are called, the JS-side glyph objects drift from the GPU buffer. This is currently harmless (the JS objects are the source of truth for offset calculations), but it is a fragile invariant that the slim-down refactor must preserve. Specifically, `updatePosition` computes an offset from `entry.glyphs[0].position` (line 652-654) -- after slimming `renderedTexts`, this must read from `positions[entry.bufferStartIndex * 3]` instead.

## Tensions

1. **Priority ordering: Memory says slim `renderedTexts` first, I say enable eviction first.**
   Memory ranks `renderedTexts` slim-down as priority #1 (1.5 GB savings) and eviction as #2. I ranked eviction as Tier 1 (one-line change, ~220 MB VRAM savings) and attribute optimizations as Tier 2+. Both are right in terms of absolute savings, but **Memory's ordering is correct** because the 1.5 GB JS heap cost will cause tab crashes and OOM on machines with 4-8 GB RAM long before the 244 MB VRAM matters. VRAM pressure causes frame drops; heap pressure causes process termination. Memory's priority is the safer production ordering.

2. **Pipeline says delete legacy fallback (hard-fail on shaper init). Memory says drop the atlas canvas.** These are complementary, not contradictory, but the dependency is subtle. Pipeline's Phase 3 (replace `GlyphAtlas` with `FontMetrics`) *subsumes* Memory's fix 5c (null out the canvas). If both are pursued, Memory's 5c should be done as an interim step during Pipeline's Phase 2, not after Phase 3. Otherwise, the canvas stays allocated through the entire refactor.

3. **Memory estimates "After fixes" total at ~47 MB. My Phase 0 shows a minimum ~27 MB for visible-only grids.** The discrepancy comes from Memory including `CodeGrid.content` strings (16 MB, kept for reload) and Slug textures (2 MB, overstated -- actually ~0.2 MB), while I excluded JS heap costs. Correcting Memory's Slug number and removing the `renderedTexts` overhead, the true minimum for 50 visible grids is: ~22 MB instance buffers + ~2.2 MB highlight + ~5 MB slim metadata + ~16 MB content strings + ~0.2 MB Slug + ~0.1 MB groups = **~46 MB**. Memory's estimate is approximately correct despite the Slug texture error.

## Recommendations

1. **Slim `renderedTexts` (Memory 5b).** Replace per-glyph JS object arrays with `{ bufferStartIndex, glyphCount, lineSlotOffsets }`. Update all 15 call sites in GlyphRenderer.js to read positions/colors from typed arrays. The offset calculation in `updatePosition` (line 652) must change from `entry.glyphs[0].position.x` to `positions[entry.bufferStartIndex * 3]`. This is the highest-impact single change (~1.5 GB heap reclaimed).

2. **Enable eviction by default** (one-line change: `GridVirtualizer.js:45`, change `enableEviction = false` to `true`; and pass `atlas` in `GitHubRepoViewer.js` constructor). Reclaims ~220 MB VRAM for off-screen grids.

3. **Delete the six zero-import files** (Pipeline Phase 1). `buildBuffers.js`, `textToGlyphs.js`, `layoutText.js`, `InstanceBuffer.js`, `GlyphBatcher.js`, `GlyphInstancePool.js`. Remove their exports from `src/index.js`. ~1,075 lines deleted, zero behavioral change.

4. **Null the atlas canvas after `generate()`** (Memory 5c). Store `_charSize` eagerly during `generate()`, then set `this.atlasCanvas = null; this.ctx = null;`. Saves 16 MB system RAM immediately, independent of the `FontMetrics` refactor.

5. **Remove legacy builder paths** (Pipeline Phase 2). Requires assertion that shaper init is a hard failure. Delete `buildGlyphBuffers`, `buildBatchBuffers`, legacy `GlyphWorker` branch, legacy `WorkerBridge` methods, UV cache infrastructure, and `GlyphRenderer._textToGlyphs` fallback branch. ~860 lines deleted.

6. **Reduce `defaultMaxGroups` from 64 to 4** (`src/core/constants.js:37`). Grow-on-demand already works. Saves 2 MB across 555 renderers.

7. **Share shader materials via `Material.clone()`**. Create one prototype `ShaderMaterial` per atlas configuration, then `.clone()` for each renderer. Three.js shares the compiled program across clones. Eliminates 554 redundant shader compilations and reduces JS-side material object overhead.

8. **Derive `instanceSize` from `glyphId` in the vertex shader** (my Phase 0 Tier 2C). Add a small glyph-width lookup texture (~1.6 KB), remove the 2-float `instanceSize` attribute. Saves 48.8 MB across 6.1M glyphs. Requires changes to SlugEncoder, vertex shader, buffer builders, and `applyPrebuiltBuffers`.

9. **Implement color palette compression** (my Phase 0 Tier 3E). Replace `instanceColor` vec3 (12 bytes) with uint8 palette index (1 byte). Saves 67 MB. Higher complexity than other items, but the largest single-attribute VRAM win.

10. **Convert `GitHubRepoViewer` Slug init to hard-fail** (Pipeline section 7). Remove the try/catch at lines 308-312 that silently falls back to bitmap rendering. If HarfBuzz/Slug fails, throw. This is the prerequisite for recommendations 5 and the eventual `FontMetrics` refactor.

## Key Insight

The system's dominant cost is not on the GPU at all. Memory's discovery of the `renderedTexts` glyph object duplication -- where `applyPrebuiltBuffers` reconstructs 6.1M JS objects from typed arrays that already contain the same data (GlyphRenderer.js:1487-1508) -- accounts for roughly 80% of total memory consumption at 1.2-1.8 GB of V8 heap. The GPU-side VRAM (244 MB instance buffers + 24 MB highlights) is significant but secondary. The correct optimization order is: (1) eliminate the JS heap duplication by making update methods read directly from typed arrays, (2) enable the already-implemented eviction system to reclaim VRAM for off-screen grids, (3) delete ~1,900 lines of dead legacy code to simplify the codebase for subsequent attribute-level optimizations. The three agents' findings are highly complementary: Memory found the biggest cost, Pipeline found the biggest cleanup, and GPU found the deepest attribute-level VRAM savings -- none overlap, all are needed.

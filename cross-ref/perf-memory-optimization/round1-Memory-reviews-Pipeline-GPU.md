# Round 1: Memory reviews Pipeline, GPU

## Errors Found

### Pipeline: `getSerializedGlyphWidths()` is NOT dead in the shaped path

Pipeline section 4 claims that after removing legacy builder paths, these WorkerBridge methods become unused: `getSerializedUVMap()`, `getSerializedGlyphWidths()`, `invalidateUVCache()`. This is correct for the shaped *worker* dispatch (line 264-288 never touches them), but Pipeline missed that the sync fallback `_buildBatchBuffersSync()` at line 388-401 calls `getSerializedGlyphWidths()` even in the shaped branch... wait, no -- re-reading line 389-401, the shaped branch at lines 389-400 does NOT call it. Only the else branch at 403-411 does. Pipeline is correct here. However, the zero-worker fallback at line 257-258 calls `_buildBatchBuffersSync` which does call `getSerializedUVMap` and `getSerializedGlyphWidths` in the non-shaped branch. If we delete those methods AND someone runs with zero workers AND no shaper, it breaks. Per project policy (no fallback paths), this is acceptable. No error -- but worth noting the chain of assumptions.

### GPU: Shader programs are likely NOT duplicated 555 times on the GPU

GPU section 5.1 claims 555 independent shader compilations and estimates ~28 MB (50 KB/program * 555) in the VRAM summary table. This is wrong in practice. Three.js internally caches compiled WebGL programs by shader source hash (`WebGLPrograms.getParameters` + `getProgramCacheKey`). Since every GlyphRendererV15 uses identical GLSL source strings (returned by `_getVertexShader()` / `_getFragmentShader()`), and the uniform *structure* is identical, Three.js reuses the compiled GL program. The 555 materials DO each hold their own JS-side uniform objects (~2-4 KB each, so ~1-2 MB total JS overhead), but the compiled GPU program is one copy. The 28 MB VRAM line item is a phantom. Actual VRAM is closer to **272 MB**, not 300 MB.

The GPU agent's fix (section 5.2: `Material.clone()`) would reduce JS-side overhead but would NOT save the 28 MB it claims, because the GPU program is already shared.

### GPU: `updateAddedColor` does NOT do a "full texture re-upload"

GPU section 4.2 states that `updateAddedColor()` at line 719 "sets `highlightTexture.needsUpdate = true` without `addUpdateRange`, causing a full texture re-upload." This is misleading. `DataTexture.needsUpdate = true` flags the whole texture, yes, but Three.js DataTextures do not support `addUpdateRange()` -- that API is for `BufferAttribute`. For DataTextures, `needsUpdate = true` is the ONLY upload mechanism. `setGlyphHighlight()` at line 746 does the exact same thing (`this._highlightTexture.needsUpdate = true`). Both paths cause a full texture upload. The GPU agent singled out `updateAddedColor` as inferior to some alternative that does not exist for DataTextures.

### Pipeline: Line number references for `src/index.js` exports may be stale

Pipeline section 1F cites specific line numbers (29, 32, 33, 34, 38) for dead exports in `src/index.js`. These should be verified -- exports may have shifted. The file paths and export names are correct, but line citations should be treated as approximate.

## Gaps

**What I covered that others missed:**
- The `renderedTexts` JS heap duplication at 1.2-1.8 GB -- by far the single largest memory cost. Neither Pipeline nor GPU analyzed this. Pipeline focused on dead code paths; GPU focused on VRAM. The JS heap cost dwarfs both.
- CodeGrid.content string retention (~16 MB) as an intentional but notable cost.
- The atlas `_serializedUVMapCache` and `_serializedWidthsCache` as minor but unnecessary retained references.

**What Pipeline covered that I missed:**
- The full dead code inventory (6 dead files, ~1,075 lines) -- I did not audit dead files. Pipeline's analysis is thorough and actionable.
- The `_textToGlyphs` legacy sync fallback branch in GlyphRenderer.js as dead code.
- The `FontMetrics` struct as the end-state replacement for GlyphAtlas.
- The GitHubRepoViewer init sequence and the policy violation in the try/catch fallback (lines 308-312).

**What GPU covered that I missed:**
- Instance attribute compression opportunities (deriving instanceSize from glyphId, packing groupId into position.w, palette-indexed color). I enumerated byte costs but did not propose attribute-level compression.
- Background plane draw call overhead (555 additional draw calls).
- SlugEncoder texture sizing details (the shared textures being ~130-300 KB total).

**What nobody covered:**
- The `options` object stored per entry in `renderedTexts` (line 1515: `options: item.options || {}`). Each entry retains the original render options. For 555 grids this is 555 objects, minor but unnecessary.
- The cost of the `_entries` Map in GridVirtualizer itself -- each entry holds a `THREE.Box3` and metadata for all 555 grids. This is small (~50 KB) but is the only structure that grows with grid count regardless of eviction.

## Tensions

### Tension 1: GPU says "derive instanceSize from glyphId" saves 48.8 MB; I say eviction saves ~220 MB for zero shader work

GPU's recommendation C (derive instanceSize in the shader, saving 8 bytes/glyph) requires modifying SlugEncoder, the vertex shader, buffer builders, and `applyPrebuiltBuffers`. My recommendation 5a (enable eviction) reclaims ~220 MB with a one-property change at `GridVirtualizer.js:46` / `GitHubRepoViewer.js:342`.

**Resolution**: Both are correct and complementary, but eviction should come first. After eviction, only ~50 visible grids hold buffers, and the instanceSize savings drops from 48.8 MB to ~4.4 MB. The shader-side derivation becomes a polish optimization, not a critical fix.

### Tension 2: Pipeline says GlyphAtlas can become FontMetrics (~20 lines); I say the atlas canvas is the waste, but metrics Map should stay

Pipeline section 6 proposes replacing GlyphAtlas entirely with a `FontMetrics` struct. I proposed dropping the canvas but keeping the `metrics` Map for `ensureGraphemes()`. Pipeline acknowledges this dependency too (section 6, item 1) but suggests migrating `ensureGraphemes` to SlugEncoder.

**Resolution**: Pipeline's end-state is correct but requires two prerequisite migrations (`ensureGraphemes` to SlugEncoder, `getCharSize` to HarfBuzz). My proposal (null the canvas, keep metrics) is the immediate fix. These are sequential: do mine first (16 MB reclaimed now), then Pipeline's (remove atlas entirely later).

### Tension 3: GPU estimates ~300 MB total VRAM; I estimate ~1,520 MB total memory

Not actually a contradiction -- different scopes. GPU counted VRAM only. I counted VRAM + JS heap. The important distinction: GPU's 300 MB includes the phantom 28 MB shader estimate, making it ~272 MB actual VRAM. My 1,520 MB is dominated by the 1,200-1,800 MB JS heap cost of `renderedTexts` glyph objects, which is invisible to VRAM accounting. Both numbers are valid for their respective scopes, but anyone reading both reports needs to understand that **the JS heap cost is 5x the VRAM cost**.

## Recommendations

1. **Slim `renderedTexts` immediately.** Replace the per-glyph object array with `{ bufferStartIndex, glyphCount, lineSlotOffsets }`. Read current positions/colors from typed arrays in `updatePosition()` (line 652), `updateColor()` (line 697), `updateAddedColor()` (line 729), `updatePositions()` (line 775), `updateColors()` (line 822), `updateBatch()` (line 862), `getText()` (line 580), and `_getTextBounds()` (line 1300). That is 8 call sites plus `_rebuildAllInstances()` (line 1325). Saves 1.2-1.8 GB JS heap. Medium risk, high reward.

2. **Enable eviction in GitHubRepoViewer** (`GridVirtualizer` constructor, `GitHubRepoViewer.js:342`). Pass `{ atlas: this.atlas, enableEviction: true }`. One-line change, saves ~220 MB VRAM. Low risk.

3. **Execute Pipeline's Phase 1 dead code deletion** (6 files, ~1,075 lines). Zero behavioral change. Removes confusion and dead weight. Immediate.

4. **Null the atlas canvas after `generate()`** (`GlyphAtlas.js`). Store `_charSize = { width, height }` eagerly, then set `this.atlasCanvas = null; this.ctx = null; this._sharedThreeTexture = null;`. Keep the `metrics` Map. Saves 16 MB system RAM.

5. **Reduce `defaultMaxGroups` from 64 to 4** (`constants.js:37`). The grow logic at `GlyphRenderer.js:1106` already handles expansion. Saves ~2 MB across 555 grids.

6. **Fix DataTexture upload for highlight changes.** Both `updateAddedColor()` and `setGlyphHighlight()` set `needsUpdate = true` on the full DataTexture. For grids with 11K glyphs this is 44 KB -- fine. But for bulk operations across many grids per frame, consider batching: defer `needsUpdate = true` until after all highlight writes in a frame, not after each individual call. This is a micro-optimization but prevents redundant uploads within a single frame.

7. **Remove the try/catch Slug fallback** in `GitHubRepoViewer.init()` (lines 308-312). Per project policy: if HarfBuzz/Slug fails, it should be a hard error, not a silent degradation to a bitmap path that downstream code no longer supports.

8. **Do NOT prioritize instanceSize shader derivation** (GPU recommendation C) until after eviction is enabled. Post-eviction, the savings drop from 48.8 MB to ~4.4 MB for visible grids only, making the shader/builder complexity not worthwhile until other wins are captured.

9. **Consider color palette compression** (GPU recommendation E) as a Phase 2 optimization. The 67 MB savings at full scale drops to ~6 MB post-eviction, but it also reduces per-glyph bandwidth during rendering (12 bytes -> 1 byte attribute read per vertex invocation), which matters for frame time.

10. **Execute Pipeline's Phase 2** (remove legacy builder paths, ~860 lines) after confirming shaper-always-present is enforced by recommendation 7. This unlocks Pipeline's Phase 3 (FontMetrics struct, atlas elimination).

## Key Insight

The single most important observation across all three analyses is that the **JS heap cost of `renderedTexts` dwarfs everything else combined**. At 6.1M glyphs, the per-glyph object reconstruction in `applyPrebuiltBuffers()` (lines 1487-1508) allocates 1.2-1.8 GB of V8 heap objects that are a 1:1 mirror of data already present in the Float32Array buffers. Neither the Pipeline nor GPU agent identified this because their scopes (dead code paths and VRAM, respectively) do not cover JS heap analysis. The irony is that the worker path was designed to avoid main-thread allocation -- but the renderer immediately undoes that benefit by reading back every float into JS objects. Fixing this single function eliminates ~80% of total memory usage. Eviction handles the VRAM side. Both fixes are independent and can ship separately.

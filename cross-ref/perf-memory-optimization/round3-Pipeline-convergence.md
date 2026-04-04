# Round 3: Pipeline convergence

## Settled

All three agents converged across both rounds. Here is the resolved list.

1. **`renderedTexts` glyph object duplication is the dominant memory cost.** Memory discovered it, GPU and I confirmed it in Round 1. At 6.1M glyphs, `applyPrebuiltBuffers` (GlyphRenderer.js:1487-1508) reconstructs 1.2-1.8 GB of JS heap objects that mirror data already in the Float32Arrays. Fix: replace per-glyph object arrays with `{ bufferStartIndex, glyphCount, lineSlotOffsets }` metadata and make all update/query methods read from typed arrays. ~15 call sites in GlyphRenderer.js, not ~8 as Memory initially estimated -- GPU and I both corrected this in Round 1. Medium-high effort, highest-impact single change.

2. **Eviction should be enabled by default, but AFTER slimming `renderedTexts`.** All three agents agree eviction works and is low risk. I identified the sequencing constraint in Round 1: `_rebuildAllInstances()` (line 1333-1336) iterates `entry.glyphs`, so slimming `renderedTexts` must come first. GPU concurred that Memory's priority ordering (heap first, VRAM second) is correct because OOM kills the tab before VRAM pressure causes frame drops. One-line change in `GitHubRepoViewer.js:342` after the `renderedTexts` refactor is done.

3. **Six files with zero imports are safe immediate deletions (~1,421 lines).** I catalogued them in Phase 0, Memory and GPU confirmed in Round 1 that neither had reason to keep them. No behavioral change, pure dead weight removal.

4. **Legacy builder paths are dead under shaper-always-present.** `buildGlyphBuffers`, `buildBatchBuffers`, `countGlyphs`, the `iterGraphemes` import, legacy `BUILD` handler in GlyphWorker, legacy branches in WorkerBridge -- all dead when shaper is guaranteed. GPU correctly noted in Round 1 that the UV cache infrastructure deletion is a *consequence* of committing to shaper-always-present, not an independent cleanup. These deletions are gated on item 5.

5. **`GitHubRepoViewer.init()` try/catch fallback (lines 308-312) is a policy violation.** I identified this, Memory and GPU both endorsed removing it. If HarfBuzz/Slug fails, the app cannot render -- silent fallback to `_shaper=null` creates a broken state. Hard-fail on init. This is the prerequisite that unlocks item 4.

6. **`GlyphRenderer._textToGlyphs()` fallback branch (lines 1201-1228) is dead.** The else-branch after the `shaper.ready` check uses `GlyphLayout`, which has no other internal importers (only `GlyphRenderer.js:20`). Delete the branch, the import, and `GlyphLayout.js` (348 lines).

7. **Null the atlas canvas after `generate()`, save 16 MB.** Memory proposed, I endorsed, GPU confirmed the canvas costs 0 VRAM but 16 MB RAM. Store `_charSize` eagerly, null `atlasCanvas`, `ctx`, `_sharedThreeTexture`. This is the immediate fix; full atlas elimination (FontMetrics) comes later.

8. **Reduce `defaultMaxGroups` from 64 to 4 in `constants.js:37`.** All three agents agree. Grow-on-demand at GlyphRenderer.js:1106 already handles overflow. Saves ~2 MB across 555 renderers.

9. **Three.js DOES cache compiled shader programs.** GPU's Phase 0 claimed 555 compilations and ~28 MB shader VRAM. Both Memory and I corrected this in Round 1: `WebGLPrograms` hashes source strings, so one compiled program is shared. The `Material.clone()` optimization saves only ~1-2 MB of JS-side uniform objects, not 28 MB VRAM. Low priority.

10. **GPU attribute compression (instanceSize derivation, groupId packing, color palette) is deferred.** After eviction, visible-grid VRAM drops to ~27 MB, making the 48.8 MB / 24.4 MB / 67 MB savings much smaller in practice (~4-6 MB each for visible grids). All three agents agreed: do the simple wins first. These become Phase 3+ polish.

11. **Atlas bitmap caching infrastructure in GitHubRepoViewer is dead.** `_tryLoadCachedAtlas()`, `_tryLoadStaticAtlas()`, `_cacheAtlasToRelay()`, and the re-cache checks in `loadRepository`/`loadLocalDirectory` are all bitmap-atlas-specific. Delete after committing to Slug-only rendering (item 5).

---

## Implementation Plan

### Step 1: Delete zero-import dead files (zero risk, ~1,421 lines)

**Delete these files:**
- `src/workers/builders/buildBuffers.js` (77 lines)
- `src/workers/builders/textToGlyphs.js` (64 lines)
- `src/workers/builders/layoutText.js` (121 lines)
- `src/core/InstanceBuffer.js` (192 lines)
- `src/layout/GlyphBatcher.js` (255 lines)
- `src/layout/GlyphInstancePool.js` (364 lines)
- `src/layout/GlyphLayout.js` (348 lines)

**Modify `src/index.js`:** Remove these export lines:
```javascript
// Line 29: remove
export { buildGlyphBuffers, buildBatchBuffers } from './workers/builders/index.js';
// Line 32: remove
export { default as GlyphLayout } from './layout/GlyphLayout.js';
// Line 33: remove
export { default as GlyphBatcher } from './layout/GlyphBatcher.js';
// Line 34: remove
export { default as GlyphInstancePool } from './layout/GlyphInstancePool.js';
// Line 38: remove
export { default as InstanceBuffer } from './core/InstanceBuffer.js';
```

**Modify `src/GlyphRenderer.js`:** Remove the import at line 20:
```javascript
import GlyphLayout from './layout/GlyphLayout.js';
```
Remove the fallback branch in `_textToGlyphs()` (lines 1201-1228 -- the entire else-path after `if (this._shaper && this._shaper.ready)`). Remove the `this._layout` field if referenced only from that branch.

**Check: is `src/layout/` now empty?** If `GlyphLayout.js`, `GlyphBatcher.js`, and `GlyphInstancePool.js` were its only contents, delete the directory. Otherwise leave any surviving files.

### Step 2: Hard-fail Slug init, remove atlas fallback (prerequisite for Step 3)

**Modify `app/GitHubRepoViewer.js`:**

a) Remove the try/catch around HarfBuzz/Slug init (lines 274-312). Make lines 274-307 run without the try wrapper. If HarfBuzz or Slug fails, the error propagates and the app shows a load failure -- which is correct since nothing can render without Slug.

b) Remove atlas bitmap caching methods and their call sites:
- Delete method `_tryLoadCachedAtlas()` (starts at line 578)
- Delete method `_tryLoadStaticAtlas()` (starts at line 631)
- Delete method `_cacheAtlasToRelay()` (starts at line 665)
- Delete the atlas loading block in `init()` (lines 240-267) that calls these methods
- Delete re-cache checks at lines 1532 and 1742 (`this._cacheAtlasToRelay()`)
- Delete atlas config from settings: `_atlasFont`, `_atlasFontSize`, `_atlasSize` (lines 236-238)

c) Enable eviction (to be done after Step 4 is complete, but the constructor change goes here):
```javascript
// Line 342, change from:
this.gridVirtualizer = new GridVirtualizer(this.scene, this.camera);
// To:
this.gridVirtualizer = new GridVirtualizer(this.scene, this.camera, {
    atlas: this.atlas,
    enableEviction: true
});
```
**Hold this change until Step 4 is complete** -- `_rebuildAllInstances` must be fixed first.

### Step 3: Remove legacy builder paths (~500 lines from builders, ~200 from WorkerBridge, ~50 from GlyphWorker)

**Modify `src/workers/builders/index.js` (currently 744 lines):**
- Delete `countGlyphs` function (lines 36-43)
- Delete `buildGlyphBuffers` function (lines 67-193)
- Delete `buildBatchBuffers` function (lines 271-496)
- Delete `export default buildGlyphBuffers` (line 744)
- Remove `import { iterGraphemes }` (line 28)
- Rename `buildShapedBatchBuffers` to `buildBatchBuffers` (it is now the only builder)
- **Resulting exports:**
```javascript
export { PAGE_CONFIG, Z_WRAP_CONFIG };   // constants
export function applyPagination(...) {}  // helper
export function buildBatchBuffers(items, shared, emptyGlyphs) {}  // renamed from buildShapedBatchBuffers
```
- Update `src/index.js` line 81: change `buildShapedBatchBuffers` to `buildBatchBuffers` in the export.

**Modify `src/workers/GlyphWorker.js` (currently 119 lines):**
- Delete the `BUILD` message handler (the block handling `case 'BUILD':` or `if (type === 'BUILD')`)
- Delete the legacy `BUILD_BATCH` else-branch (the path that uses `cachedUVMap` / `cachedGlyphWidths` / old `buildBatchBuffers`)
- Delete module-level `cachedUVMap` and `cachedGlyphWidths` variables
- Update the remaining `BUILD_BATCH` handler to call `buildBatchBuffers` (the renamed function)

**Modify `src/workers/WorkerBridge.js` (currently 469 lines):**
- Delete method `buildBuffers()` (line 202) -- the single-text async method, no callers
- Delete method `_buildBuffersSync()` (line ~371) -- fallback for `buildBuffers()`
- Delete the legacy else-branch inside `_buildBatchBuffersSync()` (the path that calls old `buildBatchBuffers` with uvMap/glyphWidths)
- Delete the legacy dispatch path inside `buildBatchBuffers()` (the `else` branch at lines ~291-314 that sends UV map to workers)
- Delete UV map cache infrastructure:
  - Method `getSerializedUVMap()` (lines ~120-169)
  - Method `getSerializedGlyphWidths()` (lines ~177-179)
  - Method `invalidateUVCache()` (lines ~184-187)
  - Fields: `_uvMapCache`, `_uvMapAtlas`, `_uvMapVersion` (lines ~43-47)
  - `worker._hasUVMap` flag usage (lines ~130-131, 293, 313)
- Update the remaining `buildBatchBuffers()` and `_buildBatchBuffersSync()` to call `buildBatchBuffers` (the renamed function) instead of `buildShapedBatchBuffers`

### Step 4: Slim `renderedTexts` -- eliminate JS heap duplication (highest-impact change)

**Modify `src/GlyphRenderer.js`:**

a) In `applyPrebuiltBuffers()` (lines 1486-1521): Replace the per-glyph object array reconstruction with lightweight metadata:
```javascript
// Instead of building `glyphs = new Array(meta.glyphCount)` with 6.1M objects:
this.renderedTexts.set(id, {
    id,
    bufferStartIndex: meta.bufferStartIndex,
    glyphCount: meta.glyphCount,
    lineSlotOffsets: meta.lineSlotOffsets || null,
    // DO NOT store: glyphs array, text string, options object
});
```

b) Add a private helper to read glyph data from typed arrays on demand:
```javascript
_readGlyphPosition(entry, localIndex) {
    const base = (entry.bufferStartIndex + localIndex) * 3;
    const arr = this.mesh.geometry.getAttribute('instancePosition').array;
    return { x: arr[base], y: arr[base + 1], z: arr[base + 2] };
}

_readGlyphColor(entry, localIndex) {
    const base = (entry.bufferStartIndex + localIndex) * 3;
    const arr = this.mesh.geometry.getAttribute('instanceColor').array;
    return { r: arr[base], g: arr[base + 1], b: arr[base + 2] };
}
```

c) Update all 15 call sites that read `entry.glyphs`:

| Method | Line(s) | Change |
|--------|---------|--------|
| `getText()` | 580, 587 | Return `{ glyphCount: entry.glyphCount, getBounds: ... }`. For external callers that need glyph objects, provide a lazy `getGlyphs()` that constructs them on demand from typed arrays. |
| `updatePosition()` | 652-678 | Read first-glyph position via `_readGlyphPosition(entry, 0)` for delta calc. Use `entry.glyphCount` for loop bound. Write directly to position attribute array without updating JS objects. |
| `updateColor()` | 697-709 | Use `entry.glyphCount` for loop bound. Write to color attribute array only. |
| `updateAddedColor()` | 729 | Replace `entry.glyphs.length` with `entry.glyphCount`. |
| `updatePositions()` | 775-796 | Same pattern as `updatePosition()` but batched. |
| `updateColors()` | 822-827 | Same pattern as `updateColor()` but batched. |
| `updateBatch()` | 862-892 | Combine the above patterns. |
| `_getTextBounds()` | 1297-1310 | Iterate typed arrays to compute bounds. |
| `_rebuildAllInstances()` | 1333-1336 | Replace `entry.glyphs.length` with `entry.glyphCount`. Replace `allGlyphs.push(...entry.glyphs)` with direct typed-array reads to build the allGlyphs array, OR restructure to copy buffer ranges directly. |
| `getStats()` | 1608 | Replace `entry.glyphs.length` with `entry.glyphCount`. |

d) Update `GlyphCollection.getText()` (GlyphCollection.js:~942) if it forwards `entry.glyphs` to app code.

### Step 5: Enable eviction (now safe after Step 4)

**Modify `app/GitHubRepoViewer.js` line 342:**
```javascript
this.gridVirtualizer = new GridVirtualizer(this.scene, this.camera, {
    atlas: this.atlas,
    enableEviction: true
});
```

### Step 6: Null the atlas canvas (16 MB reclaimed)

**Modify `src/GlyphAtlas.js`:**

At the end of `generate()`, after all glyphs are rendered and metrics computed:
```javascript
this._charSize = this.getCharSize();  // cache eagerly
this.atlasCanvas = null;
this.ctx = null;
this._sharedThreeTexture = null;
```

Update `getCharSize()` to return `this._charSize` if available, falling back to the metrics Map lookup only during `generate()`.

### Step 7: Reduce defaultMaxGroups (trivial, 2 MB saved)

**Modify `src/core/constants.js` line 37:**
```javascript
// Change from:
defaultMaxGroups: 64
// To:
defaultMaxGroups: 4
```

### Summary of all changes

| Step | Files deleted | Files modified | Lines removed (approx) | Risk |
|------|-------------|----------------|----------------------|------|
| 1 | 7 files | 2 (`index.js`, `GlyphRenderer.js`) | ~1,421 + ~35 | Zero |
| 2 | 0 | 1 (`GitHubRepoViewer.js`) | ~180 | Low |
| 3 | 0 | 3 (`builders/index.js`, `WorkerBridge.js`, `GlyphWorker.js`) | ~750 | Low (gated on Step 2) |
| 4 | 0 | 2 (`GlyphRenderer.js`, `GlyphCollection.js`) | ~60 net (rewrite, not deletion) | Medium-high |
| 5 | 0 | 1 (`GitHubRepoViewer.js`) | 0 (one-line change) | Low (gated on Step 4) |
| 6 | 0 | 1 (`GlyphAtlas.js`) | ~5 net (add cache, null refs) | Low |
| 7 | 0 | 1 (`constants.js`) | 0 (value change) | Zero |
| **Total** | **7 files** | **~8 files** | **~2,450 lines** | |

---

## Implementer Vote

**Memory** should implement this.

The dominant work is Step 4 -- rewriting 15 call sites in GlyphRenderer.js to read from typed arrays instead of JS glyph objects. Memory identified this problem, understands the buffer layout and byte costs at every call site, and correctly traced the data flow through `applyPrebuiltBuffers` into `updatePosition`/`updateColor`/`_rebuildAllInstances`. The deletion steps (1-3) are mechanical and can be done by anyone, but the `renderedTexts` refactor requires precise understanding of which fields are read where and what the typed-array offset math looks like -- exactly Memory's analytical domain. GPU's expertise (shader changes, attribute compression) is not needed until Phase 3. My expertise (dead code tracing, builder consolidation) is consumed by this plan -- the deletions are fully specified and require no further analysis.

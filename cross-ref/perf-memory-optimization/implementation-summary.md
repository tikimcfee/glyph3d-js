# Implementation Summary: Performance & Memory Optimization

Implemented by the Pipeline agent from the Round 3 convergence plans.

---

## Files Deleted (1,552+ lines removed)

| File | Lines | Reason |
|------|-------|--------|
| `src/workers/builders/buildBuffers.js` | 77 | Zero imports. Old V1.0 bitmap-UV buffer builder. |
| `src/workers/builders/textToGlyphs.js` | 64 | Zero imports. Superseded by single-pass builders. |
| `src/workers/builders/layoutText.js` | 121 | Zero imports. Superseded by inline layout in builders. |
| `src/core/InstanceBuffer.js` | 192 | Zero imports. Old per-character UV-loop builder. |
| `src/layout/GlyphBatcher.js` | 255 | Zero imports. Self-deprecated, uses old `atlas.getUV()` path. |
| `src/layout/GlyphInstancePool.js` | 364 | Zero imports. Self-deprecated, replaced by right-sized allocation. |
| `src/layout/GlyphLayout.js` | 348 | Only imported in GlyphRenderer legacy fallback (now deleted). |
| `src/core/ShaderManager.js` | 91 | Zero imports after index.js export removed. |

**`src/layout/` directory is now empty.**

---

## Files Modified

### `src/index.js`
- Removed exports for all 8 deleted files/modules.
- Added `buildBatchBuffers` to exports (alongside `buildShapedBatchBuffers` alias).

### `src/workers/builders/index.js` (rewritten, 744 → ~330 lines)
- Deleted `countGlyphs()`, `buildGlyphBuffers()`, `buildBatchBuffers()` (legacy grapheme paths).
- Deleted `import { iterGraphemes }`.
- Renamed `buildShapedBatchBuffers` to `buildBatchBuffers` (now the only builder).
- Kept `applyPagination`, `PAGE_CONFIG`, `Z_WRAP_CONFIG`.
- Re-exports `buildBatchBuffers as buildShapedBatchBuffers` for backward compatibility.

### `src/workers/GlyphWorker.js` (rewritten, 119 → 72 lines)
- Removed `BUILD` handler (called dead `buildGlyphBuffers`).
- Removed legacy `BUILD_BATCH` else-branch (UV map path).
- Removed `cachedUVMap`, `cachedGlyphWidths` module-level variables.
- Single `BUILD_BATCH` handler calls `buildBatchBuffers` (HarfBuzz-shaped only).

### `src/workers/WorkerBridge.js` (rewritten, 469 → ~240 lines)
- Removed `buildBuffers()` method (no callers).
- Removed `_buildBuffersSync()`.
- Removed legacy branch in `_buildBatchBuffersSync()` (UV map path).
- Removed legacy branch in `buildBatchBuffers()` (UV map dispatch).
- Removed UV map cache infrastructure: `getSerializedUVMap()`, `getSerializedGlyphWidths()`, `invalidateUVCache()`, `_uvMapCache`, `_uvMapAtlas`, `_uvMapVersion`, `worker._hasUVMap`.

### `src/core/constants.js`
- `defaultMaxGroups`: 64 → 4 (saves ~2 MB across 555 renderers; grows on demand at line 1106).

### `src/GlyphAtlas.js`
- At end of `generate()`: cache `this._charSize = this.getCharSize()`, then null `atlasCanvas`, `ctx`, `_sharedThreeTexture`. Saves **16 MB system RAM**.
- `getCharSize()`: returns `this._charSize` if available (fast path, avoids Map lookup).
- `ensureGraphemes()` already had `if (!this.ctx)` guard — works correctly after canvas is freed.

### `src/GlyphRenderer.js` (major refactor)

**Imports:**
- Removed `import GlyphLayout`.
- Removed `import { iterGraphemes }` (was only used by the deleted fallback branch).

**New helper methods:**
- `_readGlyphPosition(bufferIndex)` — reads position from `instancePosition` typed array.
- `_readGlyphSize(bufferIndex)` — reads size from `instanceSize` typed array.
- `_lazyGlyphs(entry)` — returns a Proxy array-like that reads glyph data from typed arrays on demand. Preserves external API: `.length`, `[i]`, `Symbol.iterator` all work.

**`applyPrebuiltBuffers()` (lines 1486-1521 → 10 lines):**
- Deleted per-glyph object reconstruction loop (6.1M objects eliminated).
- Stores only `{ id, bufferStartIndex, glyphCount, lineSlotOffsets }` per entry.
- Estimated savings: **1.2–1.8 GB JS heap**.

**`getText()`:**
- Returns `glyphs` via lazy Proxy backed by typed arrays.
- Adds `glyphCount`, `bufferStartIndex`, `getGlyphAt(i)` fields.
- External API preserved: `textObj.glyphs[0].position.x` still works.

**`updatePosition()`:** Reads first-glyph position from typed array for delta; applies delta in-place; no JS object mutations.

**`updateColor()`:** Writes directly to color typed array; no JS object mutations.

**`updateAddedColor()`:** `entry.glyphs.length` → `entry.glyphCount`.

**`updatePositions()`:** Same pattern as `updatePosition()`.

**`updateColors()`:** Same pattern as `updateColor()`.

**`updateTransforms()`:** Both position and color sections use typed array reads/writes.

**`_getTextBounds()`:** Signature changed from `(glyphs)` to `(entry)`. Reads positions and sizes from typed arrays. `getText().getBounds()` now passes `entry` directly.

**`_rebuildAllInstances()` (rewritten):**
- **Legacy path** (sync path with glyph objects): collects arrays → writes to GPU → strips `entry.glyphs = null`. After first rebuild, entries have only `bufferStartIndex` + `glyphCount`.
- **Worker path** (typed arrays): in-place compaction using `TypedArray.copyWithin`. Zero heap allocations. Shifts surviving entries forward to fill gaps from `remove()` calls.

**`_textToGlyphs()` fallback removed:** The else-branch that used `GlyphLayout` and `iterGraphemes` is deleted. The method now delegates directly to `_textToGlyphsShaped()`.

**`_registerText()`:** Stores `glyphs` array temporarily (stripped after `_rebuildAllInstances`); sets `glyphCount = glyphs.length`.

**`getStats()`:** `entry.glyphs.length` → `entry.glyphCount || 0`.

**`this._layout` field:** Removed (was only used by the deleted fallback branch).

### `src/collections/GlyphCollection.js`
- `findGlyphs()`: Uses `this._renderer.getText(entry.id)` to access the lazy glyphs Proxy, rather than reading `entry.glyphs` directly from the raw renderedTexts entry.

### `src/picking/PickingSystem.js`
- `resolveGlyph()`: `entry.glyphs.length` → `entry.glyphCount || 0`.

### `src/collections/GridVirtualizer.js`
- `enableEviction` default: `false` → `true`. Eviction is now active out of the box.

### `app/GitHubRepoViewer.js` (significant cleanup)

**Atlas loading (lines 235-267):**
- Removed atlas config persistence (`_atlasFont`, `_atlasFontSize`, `_atlasSize`).
- Removed atlas bitmap cache loading paths (`_tryLoadCachedAtlas`, `_tryLoadStaticAtlas`).
- Now: always generates atlas at runtime (one simple code path).
- Removed `_atlasVersionAtLoad` tracking and re-cache calls in `loadRepository` and `_loadLocalDirectory`.

**HarfBuzz init (lines 274-312):**
- Removed try/catch fallback. Hard-fail on init: if HarfBuzz/Slug fails, the error propagates and the app shows a load failure. No more silent `_shaper = null` fallback state.

**GridVirtualizer construction (line 342):**
- Now passes `{ atlas: this.atlas, enableEviction: true }` so eviction reload works correctly.

**Deleted methods:**
- `_tryLoadCachedAtlas()` — relay-cached atlas WebSocket loader.
- `_tryLoadStaticAtlas()` — static pre-baked asset loader.
- `_cacheAtlasToRelay()` — fire-and-forget atlas bitmap cacher.

---

## Memory Savings (estimated at 6.1M glyphs, 555 grids)

| Change | Saving |
|--------|--------|
| `renderedTexts` glyph object elimination | **~1.2–1.8 GB JS heap** |
| Atlas canvas freed after `generate()` | **16 MB system RAM** |
| `defaultMaxGroups` 64 → 4 | **~2 MB** (grows on demand) |
| Eviction enabled (off-screen GPU buffers freed) | **~220 MB VRAM** (for ~505 off-screen grids) |
| Dead code removed from JS parse/load | ~1,550 lines |

---

## What Was NOT Changed (per plan)

- Highlight texture system — untouched.
- Picking system — only the `entry.glyphs.length` fix in `resolveGlyph`.
- Group transforms — untouched.
- Shaders — untouched.
- `GlyphAtlasLoader.js` — untouched (used by `src/index.js` export).
- Phase 3 GPU attribute compression (instanceSize derivation, color palette) — deferred.
- Full GlyphAtlas → FontMetrics migration — deferred.

---

## Dependency Chain Honored

1. `renderedTexts` refactor completed first (Step 5).
2. Eviction enabled after the refactor (Step 4) because `_rebuildAllInstances` no longer needs `entry.glyphs`.
3. Hard-fail Slug init completed (Step 3c) before legacy builder deletion (Step 2).
4. All zero-import dead files deleted first (Step 1) — zero behavioral change.

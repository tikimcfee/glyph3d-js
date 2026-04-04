# Phase 0 Analysis: Pipeline Agent -- Dead Code, Dual Paths, Builder Consolidation

## 1. Dead Code Inventory

### 1A. `src/workers/builders/buildBuffers.js` -- DELETE ENTIRE FILE

Zero imports anywhere in the codebase. This is a fossil from the V1.5 extraction of
`GlyphRendererV15._updateInstanceMesh()`. It operates on pre-formed glyph *objects*
(position, size, uv, color), while both live builder paths (`buildGlyphBuffers`,
`buildShapedBatchBuffers`) work directly from text strings. The UV V-flip logic
(lines 50-58) is for the old canvas-texture pipeline and has no analog in Slug.

### 1B. `src/workers/builders/textToGlyphs.js` -- DELETE ENTIRE FILE

Zero imports. Extracted from `GlyphRendererV15._textToGlyphs()` for worker use,
but `buildGlyphBuffers` replaced it with a fused single-pass approach. Dead since
the `index.js` builder rewrite.

### 1C. `src/workers/builders/layoutText.js` -- DELETE ENTIRE FILE

Zero imports. Extracted from `GlyphLayout.layoutText()` for worker use. Same story
as `textToGlyphs.js` -- superseded by the single-pass builders that do layout inline.

### 1D. `src/core/InstanceBuffer.js` -- DELETE ENTIRE FILE

Only referenced by `src/index.js` (line 38, public export). Never imported by any
internal module. Uses the old per-character `atlas.getUV()` loop (line 64) and
writes a `uvs` Float32Array (4 floats/glyph) -- a buffer format that no current
shader consumes. The Slug vertex shader uses `glyphId` + `texelFetch`, not UV coords.

### 1E. `src/layout/GlyphBatcher.js` and `src/layout/GlyphInstancePool.js` -- DELETE BOTH

Only referenced in `src/index.js` (lines 33-34, public exports). No internal imports.
`GlyphBatcher` uses `atlas.getUV()` (line 80) for the old bitmap pipeline.
`GlyphInstancePool` is an allocation pool for instance slots -- replaced by
the right-sized buffer allocation in `GlyphCollection.flush()`.

### 1F. Dead exports in `src/index.js`

Lines to remove after the above deletions:

```
Line 29:  export { buildGlyphBuffers, buildBatchBuffers } from './workers/builders/index.js';
Line 32:  export { default as GlyphLayout } from './layout/GlyphLayout.js';
Line 33:  export { default as GlyphBatcher } from './layout/GlyphBatcher.js';
Line 34:  export { default as GlyphInstancePool } from './layout/GlyphInstancePool.js';
Line 38:  export { default as InstanceBuffer } from './core/InstanceBuffer.js';
```

`buildGlyphBuffers` and `buildBatchBuffers` are still called internally (see section 2),
but should not be public exports. After builder consolidation they can be removed entirely.

`GlyphLayout` is still imported by `GlyphRenderer.js` (line 20) for the legacy sync
fallback path in `_textToGlyphs()` (line 1201-1228). That fallback path is itself dead
code when a shaper is present (see section 3).

---

## 2. Builder Consolidation: Two Functions Become One

### Current state

`src/workers/builders/index.js` has three exported builders:

| Function | Lines | Used by | Path |
|---|---|---|---|
| `buildGlyphBuffers` | 67-193 | `WorkerBridge._buildBuffersSync`, `GlyphWorker` `BUILD` handler | Legacy single-text |
| `buildBatchBuffers` | 271-496 | `WorkerBridge._buildBatchBuffersSync`, `GlyphWorker` legacy `BUILD_BATCH` | Legacy batch (grapheme) |
| `buildShapedBatchBuffers` | 513-742 | `WorkerBridge._buildBatchBuffersSync`, `GlyphWorker` shaped `BUILD_BATCH` | New shaped batch |

### What to keep

**`buildShapedBatchBuffers`** is the only builder that runs in the production path.
When `this._shaper.ready` is true (which it always is after init), both
`WorkerBridge.buildBatchBuffers()` (line 264) and `_buildBatchBuffersSync()` (line 389)
take the shaped branch and never touch `buildBatchBuffers` or `buildGlyphBuffers`.

### What to delete

1. **`buildGlyphBuffers`** (lines 67-193): Single-text builder. Only called from
   `WorkerBridge._buildBuffersSync()` (line 371) and `GlyphWorker` `BUILD` handler
   (line 34). The `BUILD` message type is only sent by `WorkerBridge.buildBuffers()`
   (line 202-233), which is itself a dead method -- no caller in the entire codebase.

2. **`buildBatchBuffers`** (lines 271-496): Legacy grapheme batch builder. Only
   reachable when `this._shaper` is null, which means HarfBuzz init failed. Per
   project policy: no fallback paths.

3. **`countGlyphs`** helper (lines 36-43): Only used by `buildGlyphBuffers` and
   `buildBatchBuffers`.

4. **`iterGraphemes` import** (line 28): Only used by the legacy builders. The shaped
   path iterates `shaped.lines[].shaped[]` arrays, not grapheme strings.

### After consolidation

`src/workers/builders/index.js` shrinks from 744 lines to ~250 lines. It exports only:
- `buildShapedBatchBuffers` (renamed to just `buildBatchBuffers` since there's no other kind)
- The shared `applyPagination` helper
- The `Z_WRAP_CONFIG` / `PAGE_CONFIG` constants

---

## 3. GlyphRenderer Sync Fallback Path -- Dead

`GlyphRenderer._textToGlyphs()` (line 1193) has a two-branch structure:

```javascript
if (this._shaper && this._shaper.ready) {
    return this._textToGlyphsShaped(text, position, color, scale, options);
}
// Fallback: atlas-based grapheme iteration (legacy sync path)
```

The fallback (lines 1201-1228) uses `this.atlas.hasGlyph()`, `this.atlas.getGraphemeId()`,
and creates `GlyphLayout` objects. With no-fallback policy, this entire else-branch is dead.
`GlyphLayout` import (line 20) and `src/layout/GlyphLayout.js` only survive because of this.

**Action**: Delete the else-branch, remove `GlyphLayout` import. If `GlyphLayout.js` has
no other importers, delete the file too.

---

## 4. WorkerBridge Cleanup

### Dead method: `buildBuffers()` (lines 202-233)

The single-text `buildBuffers()` method sends a `BUILD` message to workers. No caller
exists in the codebase. It can be deleted along with `_buildBuffersSync()` (lines 367-382).

### Dead in `_buildBatchBuffersSync`: legacy branch (lines 403-411)

The `else` branch that calls `buildBatchBuffers(items, ...)` with uvMap/glyphWidths
is dead when shaper is always present.

### Dead in `buildBatchBuffers()`: legacy branch (lines 291-314)

The "Legacy path: send UV map for grapheme-based building" block (lines 291-314) sends
uvMap to workers. Dead when shaper is present.

### UV map cache infrastructure becomes dead

Once the legacy builder paths are removed, these become unused:
- `getSerializedUVMap()` (lines 120-169): Only consumed by legacy builder dispatch
- `getSerializedGlyphWidths()` (lines 177-179): Same
- `invalidateUVCache()` (lines 184-187): Same
- `_uvMapCache`, `_uvMapAtlas`, `_uvMapVersion` fields (lines 43-47): Same
- `worker._hasUVMap` flag (lines 130-131, 293, 313): Same

**After cleanup, WorkerBridge shrinks from 469 lines to ~200 lines.**

---

## 5. GlyphWorker Cleanup

### Dead: `BUILD` handler (lines 33-46)

Only triggered by `WorkerBridge.buildBuffers()`, which has no callers.

### Dead: Legacy `BUILD_BATCH` branch (lines 69-83)

The `else` branch that uses `cachedUVMap` / `cachedGlyphWidths` / `buildBatchBuffers`.
Dead when all items carry `.shaped` data.

### Dead: Module-level cache variables (lines 19-20)

`cachedUVMap` and `cachedGlyphWidths` are only written/read by the legacy branch.

### After cleanup

`GlyphWorker.js` becomes ~50 lines: one `BUILD_BATCH` handler that calls
`buildShapedBatchBuffers`, plus `PING`/`PONG`. Clean enough to inline if desired.

---

## 6. GlyphAtlas: What Survives?

### Still needed from GlyphAtlas

| API | Consumer | Purpose |
|---|---|---|
| `getCharSize()` | `GlyphRenderer` (line 62), `GlyphCollection._getMetrics()` (line 130) | Derive `metrics.charWidth`, `charHeight` |
| `_slugData` | `GlyphRenderer` (line 43), `GlyphCollection` (line 48), `CodeGrid` (line 45) | Pass Slug textures |
| `_shaper` | `GlyphRenderer` (line 46), `GlyphCollection` (line 49), `CodeGrid` (line 46) | Pass shaper ref |
| `uvMap.has()` | `GlyphCollection.flush()` (line 626), `TerminalGrid` (line 449) | Missing-grapheme check before `ensureGraphemes` |
| `ensureGraphemes()` | `GlyphCollection.flush()` (line 632) | Dynamic glyph addition |
| `uvMapVersion` | `GitHubRepoViewer` (lines 267, 1529, 1739) | Detect atlas expansion for re-caching |

### NOT needed in the Slug path

| Feature | Reason it's dead |
|---|---|
| Full canvas bitmap (`atlasCanvas`, `atlasTexture`, `generate()` with Canvas 2D drawing) | Slug renders from vector curves, not bitmap |
| `getSharedThreeTexture()` | Returns `CanvasTexture` from the bitmap atlas; Slug uses `curveTexture`/`bandTexture` |
| `getAtlasMapTexture()` / `getAtlasMapDimensions()` | DataTexture mapping codepoint->UV rect in bitmap; Slug uses `glyphMapTexture` |
| `getSerializableUVMap()` / `getSerializableGlyphWidths()` | Only consumed by legacy builder path |
| `_packGrapheme()` / shelf-packing state | Canvas 2D bitmap rasterization |
| `exportAtlas()` / `fromPrebuilt()` | Pre-baked atlas save/restore for bitmap |
| `saveDebug()` | Debug dump of bitmap atlas |
| Atlas caching in `GitHubRepoViewer` (`_tryLoadCachedAtlas`, `_tryLoadStaticAtlas`, `_cacheAtlasToRelay`) | Caches the bitmap PNG |

### Can GlyphAtlas shrink to a metrics object?

Not quite yet. Two things prevent it:

1. **`ensureGraphemes()` / `uvMap.has()`**: `GlyphCollection.flush()` still calls
   `this.atlas.uvMap.has(grapheme)` to detect missing glyphs and then
   `this.atlas.ensureGraphemes()` to add them. In the Slug path, "ensuring" a glyph
   means making sure SlugEncoder has encoded its curves. This logic needs to migrate
   from GlyphAtlas to SlugEncoder, then `uvMap.has()` becomes `slugEncoder.hasGlyph()`.

2. **`getCharSize()`**: Returns `{width, height}` based on Canvas 2D `measureText('M')`.
   In the Slug path, these should come from HarfBuzz font metrics instead. The shaper
   already has `fontExtents()` and per-glyph advances. `charWidth` could be derived from
   shaping 'M' (its advance / upem * worldScale * pixelHeight).

**Once those two migrate, GlyphAtlas can become a 20-line `FontMetrics` struct:**

```javascript
class FontMetrics {
    constructor(shaper, worldScale = 0.1) {
        const upem = shaper.upem;
        const ext = shaper.fontExtents();
        const pixelHeight = /* font size in pixels */ 48;
        const ws = worldScale * pixelHeight;

        // Shape 'M' to get reference width
        const mShaped = shaper.shape('M');
        const mAdvance = mShaped[0]?.ax || upem;

        this.charWidth = mAdvance / upem * ws;
        this.charHeight = (ext.ascender - ext.descender) / upem * ws;
        this.pixelWidth = mAdvance / upem * pixelHeight;
        this.pixelHeight = pixelHeight;
        this.worldScale = worldScale;
        this.letterSpacing = this.charWidth * 0.05;
        this.lineSpacing = this.charHeight * 1.2;
    }
    getCharSize() {
        return { width: this.pixelWidth, height: this.pixelHeight };
    }
}
```

---

## 7. GitHubRepoViewer Init Sequence: Fallback Removal

### Current init (lines 240-312):

```
1. Try relay-cached atlas
2. Try static pre-baked atlas
3. Generate atlas at runtime (Canvas 2D, ~200ms)
4. Try HarfBuzz + Slug init
5. On Slug failure: catch → set _shaper=null, _slugData=null (FALLBACK)
```

### Problem: lines 308-312

```javascript
} catch (err) {
    console.warn('[Slug] Failed to initialize HarfBuzz/Slug, falling back to atlas:', err);
    this._shaper = null;
    this._slugData = null;
}
```

This is the fallback path the project policy forbids. If HarfBuzz/Slug fails, the
viewer silently drops to bitmap rendering -- but everything downstream now assumes
shaped data. The result would be broken rendering, not graceful degradation.

### Proposed init (no fallback):

```
1. Load HarfBuzz + font file (hard error on failure)
2. Create FontMetrics from shaper
3. Shape probe text, encode Slug textures
4. Register shaper with WorkerBridge
5. Done -- no atlas generate(), no bitmap caching
```

**Lines to delete from `GitHubRepoViewer.init()`:**
- Atlas config from settings (lines 236-238): `_atlasFont`, `_atlasFontSize`, `_atlasSize`
- Entire atlas loading block (lines 240-267): relay cache, static asset, generate
- Try/catch around HarfBuzz init (lines 274-312): make it a hard init failure
- Atlas caching helpers: `_tryLoadCachedAtlas()`, `_tryLoadStaticAtlas()`, `_cacheAtlasToRelay()`
- Atlas re-cache checks in `loadRepository` and `loadLocalDirectory` (lines 1528-1533, 1737-1743)

**However**: `GlyphAtlas` is still constructed and passed everywhere as a carrier of
metrics + slugData + shaper. Until the `FontMetrics` refactor (section 6) is done,
the atlas must still be constructed -- but it doesn't need `generate()` called on it.
The init can create a minimal atlas that only calls `getCharSize()` from Canvas 2D
`measureText('M')`, skipping the full charset render.

---

## 8. Ideal Minimal Pipeline

```
Text input
  |
  v
HarfBuzzShaper.shape(text)                    [main thread, <1ms per file]
  |
  v
{lines: [{shaped: [{g, ax, ay, dx, dy}]}]}    [plain JSON, structured-clonable]
  |
  v
Worker: buildShapedBatchBuffers()              [pure math, no WASM, no DOM]
  |
  v
Float32Array buffers (positions, sizes, glyphIds, colors, groupIds)
  |
  v
GlyphRenderer.applyPrebuiltBuffers()           [GPU upload]
  |
  v
Slug vertex shader: texelFetch(glyphMapTexture, glyphId) -> curve data
  |
  v
Slug fragment shader: evaluate Bezier curves -> pixel coverage
```

**No atlas bitmap. No UV maps. No grapheme iteration in builders. No Canvas 2D.**

---

## 9. Deletion Summary

| Target | Lines Removed | Risk |
|---|---|---|
| `src/workers/builders/buildBuffers.js` | 77 | None (zero imports) |
| `src/workers/builders/textToGlyphs.js` | 64 | None (zero imports) |
| `src/workers/builders/layoutText.js` | 121 | None (zero imports) |
| `src/core/InstanceBuffer.js` | 192 | None (only re-exported, never imported) |
| `src/layout/GlyphBatcher.js` | 256 | None (only re-exported, never imported) |
| `src/layout/GlyphInstancePool.js` | 365 | None (only re-exported, never imported) |
| Legacy builders in `index.js` | ~500 | Needs shaper-always-present guarantee |
| Legacy paths in `WorkerBridge.js` | ~200 | Same |
| Legacy paths in `GlyphWorker.js` | ~50 | Same |
| Fallback in `GlyphRenderer._textToGlyphs` | ~30 | Same |
| Atlas fallback in `GitHubRepoViewer.init` | ~80 | Same |
| Dead exports in `src/index.js` | ~6 lines | Breaks consumers importing legacy builders |
| **Total** | **~1,900 lines** | |

### Phasing

**Phase 1 (safe, zero behavioral change):** Delete the 6 files with zero imports:
`buildBuffers.js`, `textToGlyphs.js`, `layoutText.js`, `InstanceBuffer.js`,
`GlyphBatcher.js`, `GlyphInstancePool.js`. Remove their exports from `src/index.js`.
~1,075 lines removed.

**Phase 2 (requires shaper-always-present assertion):** Remove legacy builder paths
from `builders/index.js`, `WorkerBridge.js`, `GlyphWorker.js`. Remove the
try/catch fallback in `GitHubRepoViewer.init()`. Remove `GlyphRenderer._textToGlyphs`
fallback branch and `GlyphLayout` import. ~860 lines removed.

**Phase 3 (GlyphAtlas reduction):** Migrate `ensureGraphemes` to SlugEncoder,
derive `getCharSize` from HarfBuzz, replace `GlyphAtlas` with `FontMetrics` struct.
Remove atlas bitmap generation, caching, and the full 943-line `GlyphAtlas.js`.

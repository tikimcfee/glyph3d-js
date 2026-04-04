# Phase 0 -- Memory Agent Analysis

Perspective: buffer lifecycle, allocation patterns, retained references, bytes per structure.

Scenario: 6.1M glyphs across 555 grids, Slug vector rendering active, Canvas 2D atlas still initialized.

---

## 1. The Big Allocations (per-grid)

Each CodeGrid creates one GlyphCollection, which creates one GlyphRendererV15.
Each renderer allocates these structures:

### Instance Attribute Buffers (worker path -- `applyPrebuiltBuffers`, GlyphRenderer.js:1426)

The worker path creates Float32Arrays sized to exact glyph count, then swaps them in directly:

| Attribute          | Floats/glyph | Bytes/glyph |
|--------------------|--------------|-------------|
| instancePosition   | 3            | 12          |
| instanceSize       | 2            | 8           |
| instanceGlyphId    | 1            | 4           |
| instanceColor      | 3            | 12          |
| instanceGroupId    | 1            | 4           |
| **Total**          | **10**       | **40**      |

At 6.1M glyphs: **244 MB** in instance attribute Float32Arrays alone.

### Highlight DataTexture (GlyphRenderer.js:202-232)

RGBA8, 1024 texels wide, height = ceil(instanceCount / 1024).
Per glyph: 4 bytes. At 6.1M glyphs: **24.4 MB**.

### Group DataTexture (GlyphRenderer.js:85-86, 181-194)

`Float32Array(maxGroups * 4 * 4)`. Default `maxGroups = 64` (constants.js:37).
Per renderer: 64 * 16 * 4 = **4,096 bytes**. Across 555 grids: **2.2 MB**.
Small individually but created 555 times.

### renderedTexts Map (GlyphRenderer.js:1486-1521)

**This is the single largest non-buffer memory hog.** In `applyPrebuiltBuffers`, the renderer reconstructs a per-glyph JS object array by reading back from the typed arrays:

```javascript
// GlyphRenderer.js:1487-1508
const glyphs = new Array(meta.glyphCount);
for (let g = 0; g < meta.glyphCount; g++) {
    glyphs[g] = {
        position: { x: ..., y: ..., z: ... },  // 3 props, 24 bytes + object overhead
        size: { width: ..., height: ... },       // 2 props, 16 bytes + object overhead
        color: { r: ..., g: ..., b: ... },       // 3 props, 24 bytes + object overhead
        charCode: ...,
        char: '',
        groupId: ...
    };
}
```

Each glyph object: ~5 inner objects + 11 numeric properties + 1 string.
V8 heap cost per glyph: conservatively **200-300 bytes** (object headers, hidden classes, property storage).
At 6.1M glyphs: **1.2 - 1.8 GB of JS heap** just for the `renderedTexts.glyphs` arrays.

The text string is also stored per entry (line 1513: `text: item.text || ''`).
For the async path, CodeGrid sends the entire file content as one text item, so each renderer entry holds the full source text. The GlyphCollection's `_committedTexts` does NOT store the text (line 528: `textLength: ...` only), but the renderer does.

### CodeGrid.content (CodeGrid.js:50, 111)

Every CodeGrid retains `this.content` -- the full source text string -- for reload support.
At 555 files averaging ~11K glyphs each, typical source file ~30KB: 555 * 30KB = **~16 MB** of retained source strings. This is intentional (needed for `reloadContent`) but worth noting.

---

## 2. The Atlas Tax

GlyphAtlas is still fully initialized even though Slug handles all rendering. It holds:

| Field                    | Size                                      | Still needed?              |
|--------------------------|-------------------------------------------|----------------------------|
| `atlasCanvas` (2048x2048)| 2048 * 2048 * 4 = **16 MB** RGBA bitmap   | **NO** for rendering. Only `getCharSize()` and `getSerializableGlyphWidths()` are called. |
| `ctx` (CanvasRenderingContext2D) | Retains backing store ref to canvas | **NO** -- only used for `ensureGraphemes()` fallback |
| `uvMap` (Map, ~500 entries) | ~40 KB                                 | **NO** -- Slug uses glyphMapTexture, not UV rects |
| `metrics` (Map, ~500 entries) | ~40 KB                               | **YES** -- `getCharSize()` reads 'M' metrics |
| `_graphemeIds` (Map)     | ~20 KB                                    | Partial -- only for worker serialization |
| `_atlasMapTexture`       | RGBA Float, 1024 x ~11 rows = **180 KB** | **NO** -- not referenced by GlyphRendererV15 |
| `_sharedThreeTexture`    | CanvasTexture wrapping atlasCanvas         | **NO** -- never referenced by Slug renderer |
| `_serializedUVMapCache`  | Plain object copy of uvMap, ~80 KB        | For workers only -- can be lazy |
| `_serializedWidthsCache` | Plain object of widths, ~20 KB            | For workers -- needed |

**The atlas canvas is the standout: 16 MB of RGBA pixel data retained solely because `getCharSize()` reads one entry from the `metrics` Map.** The canvas itself is not needed for that lookup.

The metrics Map holds `{width, height, advance}` keyed by grapheme string. Only `getCharSize()` (line 337-341) is called by the renderer/collection constructors:

```javascript
// GlyphAtlas.js:337-341
getCharSize() {
    const m = this.metrics.get('M');
    return m ? { width: m.width, height: m.height } : { width: this.fontSize, height: this.fontSize };
}
```

This could be a stored constant set during `generate()`, eliminating the need to retain the canvas.

---

## 3. What GridVirtualizer Does vs Doesn't Do

GridVirtualizer (GridVirtualizer.js) removes CodeGrids from the scene graph, eliminating draw calls. **It does NOT release GPU buffers.**

Line 17 states this explicitly:
> "Grid GPU resources remain allocated -- this is draw-call elimination, not memory reclamation."

The eviction system (lines 267-307) exists and is well-implemented:
- `EVICTION_DISTANCE_FACTOR = 10.0`, `EVICTION_DELAY_MS = 5000`
- Calls `grid.unloadContent()` which disposes the GlyphCollection
- Calls `grid.reloadContent(atlas)` on re-entry

**But eviction is disabled by default** (`enableEviction: false`, line 46) and the app never enables it (GitHubRepoViewer.js:342 creates the virtualizer with no options).

At 555 grids with ~50 visible, roughly **505 grids** (~91%) hold GPU buffers for off-screen content. These 505 grids account for roughly 91% of the 268 MB in instance buffers + highlight textures.

**Enabling eviction would reclaim ~244 MB** of instance buffers for off-screen grids, at the cost of async reload latency (~one worker round-trip, one blank frame).

---

## 4. The renderedTexts Duplication Problem

This is the most impactful finding. The `renderedTexts` Map in GlyphRendererV15 stores **a full JS object reconstruction of every glyph**. This data is a 1:1 mirror of what's already in the typed array buffers, but in heap-allocated JS objects.

Purpose: enables `updatePosition()`, `updateColor()`, `getText()` on individual text entries by recording `bufferStartIndex` and per-glyph positions/colors.

**The duplication is unnecessary for the worker path.** When buffers are built by workers and swapped in via `applyPrebuiltBuffers`:
1. Per-glyph position/color are already in the Float32Arrays
2. `bufferStartIndex` and `glyphCount` are in `itemMeta`
3. Reading back from buffers to construct JS objects (lines 1487-1508) only to later read those objects to write back to buffers (e.g., `updatePosition`, lines 662-679) is a round-trip through the heap

**Fix:** Store only `{ bufferStartIndex, glyphCount }` per text entry in `renderedTexts`. For `updatePosition`/`updateColor`, read the current values directly from the typed arrays. This eliminates the 1.2-1.8 GB heap overhead entirely.

---

## 5. Low-Hanging Fruit

### 5a. Enable eviction in production (GitHubRepoViewer.js:342)

```javascript
// Current:
this.gridVirtualizer = new GridVirtualizer(this.scene, this.camera);

// Fix:
this.gridVirtualizer = new GridVirtualizer(this.scene, this.camera, {
    atlas: this.atlas,
    enableEviction: true
});
```

Estimated savings: ~220 MB for 505 off-screen grids.

### 5b. Eliminate glyph object duplication in renderedTexts

Replace the per-glyph object array with lightweight metadata:

```javascript
// In applyPrebuiltBuffers, instead of:
this.renderedTexts.set(id, { ..., glyphs: new Array(meta.glyphCount), ... });

// Store:
this.renderedTexts.set(id, {
    id,
    bufferStartIndex: meta.bufferStartIndex,
    glyphCount: meta.glyphCount,
    lineSlotOffsets: meta.lineSlotOffsets || null,
});
```

Then update `updatePosition()`, `updateColor()`, etc. to read current values from the typed array buffers directly. The text string should also not be stored (line 1513 stores `item.text`).

Estimated savings: 1.2-1.8 GB JS heap.

### 5c. Drop the atlas canvas

After `generate()`, store `charSize` as a simple `{width, height}` property. Then null out `atlasCanvas`, `ctx`, and `_sharedThreeTexture`. Keep `metrics` Map only if `ensureGraphemes()` is still needed at runtime (it may be, for dynamic grapheme support). If so, keep `metrics` but drop the canvas.

```javascript
// After generate():
this._charSize = { width: mMetrics.width, height: mMetrics.height };
this.atlasCanvas = null;
this.ctx = null;
```

Estimated savings: 16 MB (canvas bitmap).

### 5d. Drop the atlas map DataTexture

`_atlasMapTexture` is never referenced by GlyphRendererV15 (confirmed: zero grep hits in GlyphRenderer.js). It was used by the old bitmap-atlas shader path. If nothing else calls `getAtlasMapTexture()`, it should not be created.

Estimated savings: ~180 KB (minor, but clean).

### 5e. Shrink the group DataTexture default

555 renderers x 64 default groups x 64 bytes = 2.2 MB. Most grids use group 0 only. Consider starting at `maxGroups: 4` and growing on demand (the grow logic already exists at line 1106).

Estimated savings: ~2 MB.

---

## 6. Summary: Memory Budget at 6.1M Glyphs

| Category                          | Current       | After fixes    |
|-----------------------------------|---------------|----------------|
| Instance attribute buffers        | 244 MB        | ~22 MB (visible only) |
| Highlight textures                | 24.4 MB       | ~2.2 MB (visible only) |
| renderedTexts glyph objects (heap)| 1,200-1,800 MB| ~5 MB (metadata only) |
| renderedTexts text strings        | ~16 MB        | 0 MB (drop from renderer) |
| Atlas canvas                      | 16 MB         | 0 MB           |
| Atlas map DataTexture             | 0.2 MB        | 0 MB           |
| Group DataTextures (555x)         | 2.2 MB        | 0.1 MB         |
| CodeGrid.content strings          | 16 MB         | 16 MB (needed for reload) |
| Slug shared textures (3x)         | ~2 MB         | ~2 MB (shared, keep) |
| **Total**                         | **~1,520 MB** | **~47 MB**     |

The dominant cost is the JS heap duplication in `renderedTexts` (~80% of total). Eviction handles the GPU buffer side. Both are independent fixes.

---

## 7. Risk Assessment

| Fix                        | Risk  | Notes |
|----------------------------|-------|-------|
| Enable eviction            | Low   | Code exists, well-tested, just not enabled. One blank frame on reload is acceptable per the code comments. |
| Slim renderedTexts         | Medium| Requires updating all methods that read `entry.glyphs[i]` to read from typed arrays instead. ~8 call sites in GlyphRenderer.js. |
| Drop atlas canvas          | Low   | Store charSize eagerly, null canvas. Must verify `ensureGraphemes()` is not called after Slug is active. |
| Drop atlas map texture     | Low   | Verify no callers remain. |
| Shrink group default       | Low   | Grow-on-demand already works. |

---

## 8. Recommended Priority

1. **Slim renderedTexts** (5b) -- by far the largest win, ~1.5 GB reclaimed
2. **Enable eviction** (5a) -- second largest, ~220 MB reclaimed, one-line change
3. **Drop atlas canvas** (5c) -- 16 MB, clean separation from legacy
4. **Shrink group default** (5e) -- 2 MB, trivial
5. **Drop atlas map texture** (5d) -- 180 KB, trivial cleanup

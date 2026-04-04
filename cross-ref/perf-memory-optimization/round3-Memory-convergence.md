# Round 3: Memory convergence

## Settled

All three agents converged on the same core findings after one round of cross-review. The following points are fully resolved:

1. **`renderedTexts` duplication is the dominant cost.** All three agents agree this is the single highest-impact fix (~1.2-1.8 GB JS heap for 6.1M glyphs). Pipeline and GPU both explicitly acknowledged they missed it in Phase 0 and confirmed the finding in Round 1. Pipeline refined the call site count to ~11 methods (I originally said ~8); GPU said ~15 references across 10 methods. Actual grep shows 33 `entry.glyphs` references in GlyphRenderer.js across 11 distinct methods. The fix eliminates per-glyph JS object reconstruction in `applyPrebuiltBuffers` (lines 1487-1508) and makes all update methods read directly from typed arrays.

2. **Eviction should be enabled by default.** All three agents agree. The code exists, works, and is well-tested. One-property change in `GitHubRepoViewer.js` plus `GridVirtualizer.js` default. Reclaims ~220 MB VRAM for off-screen grids. Pipeline correctly noted the sequencing dependency: `_rebuildAllInstances` must be rewritten before eviction is safe, because the reload path uses it and it currently depends on `entry.glyphs`.

3. **Six dead files can be deleted immediately.** Pipeline identified them, Memory and GPU confirmed no objections. `buildBuffers.js`, `textToGlyphs.js`, `layoutText.js`, `InstanceBuffer.js`, `GlyphBatcher.js`, `GlyphInstancePool.js`. Zero imports, zero behavioral change, ~1,075 lines removed.

4. **Atlas canvas should be nulled after `generate()`.** All three agree the 16 MB canvas bitmap is retained solely for `getCharSize()`, which only reads one entry from the `metrics` Map. Store `_charSize` eagerly, then null the canvas. This is the interim step; Pipeline's `FontMetrics` struct is the end-state.

5. **`defaultMaxGroups` should drop from 64 to 4.** All agree. Grow-on-demand already works (`GlyphRenderer.js:1106`). Saves ~2 MB across 555 grids. Trivial.

6. **GPU shader program duplication is a phantom cost.** I identified this in Round 1; Pipeline confirmed in their review. Three.js caches compiled GL programs by source hash. The 28 MB VRAM estimate from GPU Phase 0 is wrong -- actual GPU program cost is ~50 KB total (one copy). The 555 JS-side material objects cost ~500 KB-1 MB. `Material.clone()` is a polish optimization, not a priority.

7. **Slug init fallback (try/catch at GitHubRepoViewer.js:308-312) must become a hard error.** Pipeline identified it, GPU agreed, I confirmed. Per project policy: no fallback paths. This is the prerequisite for legacy builder deletion (Pipeline Phase 2).

8. **GPU attribute compression (instanceSize derivation, groupId packing, color palette) is deferred to Phase 3.** All three agents agree these are real savings but lower priority than the heap fix and eviction. After eviction, only ~50 visible grids hold buffers, reducing the savings from ~140 MB to ~13 MB. The shader/builder complexity is not justified until the higher-value changes land.

9. **Pipeline's legacy builder deletion (~860 lines) follows the hard-fail assertion.** All agree on the dependency chain: hard-fail Slug init -> delete legacy builders -> delete UV cache infrastructure -> eventually replace GlyphAtlas with FontMetrics.

10. **Slug texture size: ~0.2 MB, not 2 MB.** GPU corrected my Phase 0 estimate. I used ~2 MB; actual is ~130-300 KB for three RGBA16UI textures at ~400 encoded glyphs. Negligible either way, but corrected for accuracy.

## Implementation Plan

### Phase 1: Slim `renderedTexts` (highest impact, ~1.5 GB reclaimed)

**File: `src/GlyphRenderer.js`**

The new `renderedTexts` entry structure (replaces the current object with its per-glyph `glyphs` array):

```javascript
// OLD (lines 1511-1520):
this.renderedTexts.set(id, {
    id,
    text: item.text || '',          // full source text -- DROP
    glyphs,                          // Array of 11K objects -- DROP
    options: item.options || {},      // render options -- DROP
    timestamp: Date.now(),           // unused downstream -- DROP
    bufferStartIndex: meta.bufferStartIndex,   // KEEP
    glyphCount: meta.glyphCount,               // KEEP
    lineSlotOffsets: meta.lineSlotOffsets || null,  // KEEP
});

// NEW:
this.renderedTexts.set(id, {
    id,
    bufferStartIndex: meta.bufferStartIndex,
    glyphCount: meta.glyphCount,
    lineSlotOffsets: meta.lineSlotOffsets || null,
});
```

Delete the glyph-object reconstruction loop entirely (lines 1487-1508). The `for (let g = 0; g < meta.glyphCount; g++) { glyphs[g] = { ... }; }` block and the `const glyphs = new Array(meta.glyphCount)` line above it are removed.

**Helper method to add** (new, near line 570):

```javascript
/**
 * Read the first glyph's position from the typed array buffer.
 * Used by update methods to compute position offsets.
 * @private
 */
_getEntryPosition0(entry) {
    const positions = this.instanceMesh.geometry.attributes.instancePosition.array;
    const idx = entry.bufferStartIndex * 3;
    return { x: positions[idx], y: positions[idx + 1], z: positions[idx + 2] };
}
```

**Call site adaptations** (11 methods, listed with exact changes):

1. **`getText()` (line 572-589)** -- Return a lazy-access proxy instead of the raw glyphs array. External callers (GlyphCollection, render-test) access `.glyphs[i].position`, `.glyphs[0].color`, `.glyphs.length`. Provide a thin wrapper that reads from typed arrays on demand:

```javascript
getText(id) {
    const entry = this.renderedTexts.get(id);
    if (!entry) return null;
    const self = this;
    return {
        id,
        text: '',  // no longer stored; callers that need text use CodeGrid.content
        glyphs: self._lazyGlyphs(entry),
        options: {},
        updatePosition: (newPos) => self.updatePosition(id, newPos),
        updateColor: (newColor) => self.updateColor(id, newColor),
        remove: () => self.remove(id),
        getBounds: () => self._getTextBoundsFromBuffers(entry)
    };
}

/**
 * Lazy glyph accessor backed by typed arrays. Returns an array-like
 * with .length and index access that reads from GPU buffers on demand.
 * Avoids allocating per-glyph objects until explicitly accessed.
 * @private
 */
_lazyGlyphs(entry) {
    const geom = this.instanceMesh.geometry;
    const positions = geom.attributes.instancePosition.array;
    const sizes = geom.attributes.instanceSize.array;
    const colors = geom.attributes.instanceColor.array;
    const glyphIds = geom.attributes.instanceGlyphId.array;
    const groupIds = geom.attributes.instanceGroupId.array;
    const start = entry.bufferStartIndex;
    const count = entry.glyphCount;

    // Proxy with length + index access
    return new Proxy([], {
        get(target, prop) {
            if (prop === 'length') return count;
            if (prop === Symbol.iterator) {
                return function* () {
                    for (let i = 0; i < count; i++) {
                        yield readGlyph(i);
                    }
                };
            }
            const idx = Number(prop);
            if (Number.isInteger(idx) && idx >= 0 && idx < count) {
                return readGlyph(idx);
            }
            // Array methods like filter, forEach work via the iterator + length
            return Array.prototype[prop];
        }
    });

    function readGlyph(i) {
        const buf = start + i;
        return {
            position: {
                x: positions[buf * 3],
                y: positions[buf * 3 + 1],
                z: positions[buf * 3 + 2]
            },
            size: {
                width: sizes[buf * 2],
                height: sizes[buf * 2 + 1]
            },
            color: {
                r: colors[buf * 3],
                g: colors[buf * 3 + 1],
                b: colors[buf * 3 + 2]
            },
            charCode: glyphIds[buf],
            char: '',
            groupId: groupIds[buf]
        };
    }
}
```

This preserves the external API contract (`getText().glyphs[0].position.x` still works) without storing 6.1M objects. Each access allocates one temporary glyph object, not millions. The render-test expectations (`entry.glyphs.length`, `entry.glyphs[0].position.x`, etc.) all pass through the Proxy.

2. **`updatePosition()` (line 646-680)** -- Replace `entry.glyphs[0].position` with a typed-array read, remove JS-object writeback:

```javascript
updatePosition(id, newPosition) {
    const entry = this.renderedTexts.get(id);
    if (!entry || entry.bufferStartIndex === undefined) return;

    const geometry = this.instanceMesh.geometry;
    const positions = geometry.attributes.instancePosition.array;
    const startIdx = entry.bufferStartIndex;

    // Read current first-glyph position from the buffer
    const curX = positions[startIdx * 3];
    const curY = positions[startIdx * 3 + 1];
    const curZ = positions[startIdx * 3 + 2];
    const dx = newPosition.x - curX;
    const dy = newPosition.y - curY;
    const dz = newPosition.z - curZ;

    for (let i = 0; i < entry.glyphCount; i++) {
        const bufIdx = (startIdx + i) * 3;
        positions[bufIdx]     += dx;
        positions[bufIdx + 1] += dy;
        positions[bufIdx + 2] += dz;
    }

    const posAttr = geometry.attributes.instancePosition;
    posAttr.addUpdateRange(startIdx * 3, entry.glyphCount * 3);
    posAttr.needsUpdate = true;
}
```

3. **`updateColor()` (line 687-711)** -- Remove JS-object writeback, use `entry.glyphCount`:

```javascript
updateColor(id, newColor) {
    const entry = this.renderedTexts.get(id);
    if (!entry || entry.bufferStartIndex === undefined) return;

    const geometry = this.instanceMesh.geometry;
    const colors = geometry.attributes.instanceColor.array;
    const startIdx = entry.bufferStartIndex;

    for (let i = 0; i < entry.glyphCount; i++) {
        const bufIdx = (startIdx + i) * 3;
        colors[bufIdx]     = newColor.r;
        colors[bufIdx + 1] = newColor.g;
        colors[bufIdx + 2] = newColor.b;
    }

    const colorAttr = geometry.attributes.instanceColor;
    colorAttr.addUpdateRange(startIdx * 3, entry.glyphCount * 3);
    colorAttr.needsUpdate = true;
}
```

4. **`updateAddedColor()` (line 719-738)** -- Replace `entry.glyphs.length` with `entry.glyphCount`:

```javascript
// Line 729: change
for (let i = 0; i < entry.glyphs.length; i++) {
// to
for (let i = 0; i < entry.glyphCount; i++) {
```

5. **`updatePositions()` (line 762-802)** -- Same pattern as `updatePosition()`: read first-glyph position from buffer, use `entry.glyphCount` for loop bounds. Remove all `entry.glyphs[i]` references.

6. **`updateColors()` (line 809-840)** -- Same pattern as `updateColor()`: use `entry.glyphCount`, remove `entry.glyphs[i].color = newColor` writeback.

7. **`updateTransforms()` (line 847-910)** -- Combined position+color. Apply both patterns from items 2 and 3 above. Remove all `entry.glyphs` references.

8. **`_getTextBounds()` (line 1297-1319)** -- Add a new buffer-backed version:

```javascript
_getTextBoundsFromBuffers(entry) {
    if (!entry || entry.glyphCount === 0 || !this.instanceMesh) return null;

    const geom = this.instanceMesh.geometry;
    const positions = geom.attributes.instancePosition.array;
    const sizes = geom.attributes.instanceSize.array;
    const start = entry.bufferStartIndex;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (let i = 0; i < entry.glyphCount; i++) {
        const buf = start + i;
        const px = positions[buf * 3];
        const py = positions[buf * 3 + 1];
        const pz = positions[buf * 3 + 2];
        const sw = sizes[buf * 2];
        const sh = sizes[buf * 2 + 1];

        minX = Math.min(minX, px);
        minY = Math.min(minY, py);
        minZ = Math.min(minZ, pz);
        maxX = Math.max(maxX, px + sw);
        maxY = Math.max(maxY, py + sh);
        maxZ = Math.max(maxZ, pz);
    }

    return {
        min: { x: minX, y: minY, z: minZ },
        max: { x: maxX, y: maxY, z: maxZ },
        width: maxX - minX,
        height: maxY - minY,
        depth: maxZ - minZ
    };
}
```

Keep the old `_getTextBounds(glyphs)` signature temporarily for `_rebuildAllInstances`. Update `getText().getBounds` to call `_getTextBoundsFromBuffers(entry)` instead.

9. **`_rebuildAllInstances()` (line 1325-1339)** -- This method collects all glyph objects into an array and passes them to `_updateInstanceMesh`. After slimming, there are no glyph objects. Rewrite to read from the existing typed arrays and compact them (handling gaps left by `remove()`):

```javascript
_rebuildAllInstances() {
    const geom = this.instanceMesh.geometry;
    const oldPos = geom.attributes.instancePosition.array;
    const oldSiz = geom.attributes.instanceSize.array;
    const oldGid = geom.attributes.instanceGlyphId.array;
    const oldCol = geom.attributes.instanceColor.array;
    const oldGrp = geom.attributes.instanceGroupId.array;

    // Count total remaining glyphs
    let total = 0;
    for (const entry of this.renderedTexts.values()) {
        total += entry.glyphCount;
    }

    // Compact: copy surviving entries into front of the same arrays
    let writeIdx = 0;
    for (const entry of this.renderedTexts.values()) {
        const readIdx = entry.bufferStartIndex;
        const count = entry.glyphCount;
        entry.bufferStartIndex = writeIdx;

        if (readIdx !== writeIdx) {
            // Shift data forward (source and dest may overlap, but
            // writeIdx <= readIdx always holds after a deletion)
            oldPos.copyWithin(writeIdx * 3, readIdx * 3, (readIdx + count) * 3);
            oldSiz.copyWithin(writeIdx * 2, readIdx * 2, (readIdx + count) * 2);
            oldGid.copyWithin(writeIdx, readIdx, readIdx + count);
            oldCol.copyWithin(writeIdx * 3, readIdx * 3, (readIdx + count) * 3);
            oldGrp.copyWithin(writeIdx, readIdx, readIdx + count);
        }
        writeIdx += count;
    }

    // Mark all attributes dirty and set new instance count
    for (const name of Object.keys(geom.attributes)) {
        geom.attributes[name].needsUpdate = true;
    }
    this._ensureHighlightTexture(total);
    geom.instanceCount = total;
}
```

This uses `TypedArray.copyWithin` for in-place compaction without allocating any glyph objects. Since `remove()` deletes entries and calls `_rebuildAllInstances`, the remaining entries compact forward. `writeIdx <= readIdx` is guaranteed because entries are iterated in Map insertion order and deletions only create gaps.

10. **`getStats()` (line 1605-1617)** -- Replace `entry.glyphs.length` with `entry.glyphCount`:

```javascript
getStats() {
    let totalGlyphs = 0;
    for (const entry of this.renderedTexts.values()) {
        totalGlyphs += entry.glyphCount;
    }
    // ... rest unchanged
}
```

11. **`findTexts()` (line 596-604)** -- The predicate receives the entry. Callers that inspect `entry.glyphs` (like `GlyphCollection.findGlyphs`) need to work with the lazy proxy. Since `findTexts` calls `getText(id)` for matches, and `getText` now returns the lazy proxy, this works without changes to `findTexts` itself. But `GlyphCollection.findGlyphs` (line 904-912) iterates `entry.glyphs` in the predicate -- this accesses the raw renderedTexts entry, not the getText proxy. Fix: change `findTexts` to pass the getText result to the predicate, or change `findGlyphs` to use `getText` instead of the raw entry.

**File: `src/collections/GlyphCollection.js`**

- `findGlyphs()` (line 904-912): adapt to use the lazy proxy from `getText()` instead of raw `entry.glyphs`.
- `getText()` (line 936-942): `rendererText?.glyphs` now returns the lazy proxy -- no change needed.
- `getBounds()` (line 831-840): calls `textObj.getBounds()` which now calls `_getTextBoundsFromBuffers` -- no change needed.

**File: `examples/render-test/index.html`**

The render tests access `entry.glyphs.length`, `entry.glyphs[0].position.x`, `entry.glyphs[0].color.r`. All of these work through the lazy Proxy (`.length` returns `glyphCount`, `[0]` reads from typed arrays). No test changes needed if the Proxy is implemented correctly. Verify by running tests after the change.

### Phase 2: Enable eviction + trivial fixes

**File: `src/collections/GridVirtualizer.js` (line ~44)**
- Change default: `enableEviction: false` to `enableEviction: true`

**File: `app/GitHubRepoViewer.js` (line ~342)**
- Pass atlas to virtualizer: `new GridVirtualizer(this.scene, this.camera, { atlas: this.atlas, enableEviction: true })`

**File: `src/core/constants.js` (line 37)**
- Change `defaultMaxGroups: 64` to `defaultMaxGroups: 4`

**File: `src/GlyphAtlas.js`**
- At the end of `generate()`, after computing metrics, store: `this._charSize = { width: mMetrics.width, height: mMetrics.height };`
- Update `getCharSize()` to return `this._charSize` (no more Map lookup).
- After `generate()` completes and all graphemes are ensured, null out: `this.atlasCanvas = null; this.ctx = null; this._sharedThreeTexture = null; this._atlasMapTexture = null;`
- This saves 16 MB system RAM.

### Phase 3: Dead code deletion (Pipeline Phase 1)

**Delete these files** (zero imports, zero behavioral change):
- `src/workers/builders/buildBuffers.js`
- `src/workers/builders/textToGlyphs.js`
- `src/workers/builders/layoutText.js`
- `src/core/InstanceBuffer.js`
- `src/layout/GlyphBatcher.js`
- `src/layout/GlyphInstancePool.js`

**File: `src/index.js`**
- Remove the exports for the deleted files (lines ~29, ~32-34, ~38).

### Phase 4: Hard-fail Slug init + legacy path deletion (Pipeline Phase 2)

**File: `app/GitHubRepoViewer.js`**
- Remove the try/catch around HarfBuzz/Slug init (lines 308-312). Let it throw on failure.
- Remove atlas caching helpers: `_tryLoadCachedAtlas()`, `_tryLoadStaticAtlas()`, `_cacheAtlasToRelay()`.
- Remove atlas re-cache checks in `loadRepository` and `loadLocalDirectory`.

**File: `src/workers/builders/index.js`**
- Delete `buildGlyphBuffers` (lines 67-193), `buildBatchBuffers` (lines 271-496), `countGlyphs` (lines 36-43).
- Rename `buildShapedBatchBuffers` to `buildBatchBuffers`.
- Remove `iterGraphemes` import.

**File: `src/workers/WorkerBridge.js`**
- Delete `buildBuffers()` method (dead, no callers).
- Delete `_buildBuffersSync()`.
- Delete legacy branch in `_buildBatchBuffersSync()`.
- Delete UV map cache infrastructure: `getSerializedUVMap()`, `getSerializedGlyphWidths()`, `invalidateUVCache()`, `_uvMapCache`, `_uvMapAtlas`, `_uvMapVersion`.

**File: `src/workers/GlyphWorker.js`**
- Delete `BUILD` handler.
- Delete legacy `BUILD_BATCH` branch.
- Delete `cachedUVMap` and `cachedGlyphWidths`.

**File: `src/GlyphRenderer.js`**
- Delete `_textToGlyphs()` legacy fallback branch (lines ~1201-1228).
- Remove `GlyphLayout` import (line 20).

**File: `src/layout/GlyphLayout.js`**
- Delete if no other importers remain (verify first).

## Implementer Vote

**Pipeline** should implement.

The implementation work breaks down as: (a) a focused refactor of `renderedTexts` in `GlyphRenderer.js` with ripple effects into `GlyphCollection.js` and the render tests, (b) dead code deletion across 6+ files, and (c) removal of legacy builder paths and fallback branches. Pipeline's Phase 0 analysis already produced the most detailed file-by-file deletion inventory and demonstrated the deepest understanding of the builder pipeline, worker dispatch, and the dependency chains between shaper-always-present assertions and safe deletion targets. The `renderedTexts` refactor is primarily a data-flow restructuring -- replacing one data representation with direct buffer reads -- which aligns with Pipeline's demonstrated strength in tracing data through the builder -> worker -> renderer pipeline. GPU's strength is shader/VRAM architecture, which is not the focus of this implementation round.

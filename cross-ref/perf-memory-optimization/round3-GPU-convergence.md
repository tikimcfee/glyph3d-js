# Round 3: GPU convergence

## Settled

All three agents converged on the same set of changes after two rounds. The remaining ambiguities from Round 1 are now fully resolved.

1. **`renderedTexts` glyph object duplication is the dominant cost (~1.5 GB heap).** All three agents agree. Memory identified it; GPU and Pipeline confirmed it. The fix is to store only `{ bufferStartIndex, glyphCount, lineSlotOffsets }` per entry and read positions/colors/sizes directly from the typed arrays. Pipeline's suggestion of a `_getGlyphAt(entry, i)` helper is the right API shape for the rewrite.

2. **Eviction must be enabled by default.** All three agents agree. GPU and Memory independently arrived at ~220 MB VRAM savings. Pipeline correctly identified the sequencing constraint: slim `renderedTexts` first (since `_rebuildAllInstances` at line 1325 reads `entry.glyphs`), then enable eviction. The dependency is real: `_rebuildAllInstances` spreads glyph objects into an array (line 1335), so it must be rewritten to read from typed arrays before eviction teardown/reload cycles can work.

3. **Six zero-import dead files can be deleted immediately.** All three agents agree. `buildBuffers.js`, `textToGlyphs.js`, `layoutText.js`, `InstanceBuffer.js`, `GlyphBatcher.js`, `GlyphInstancePool.js`. Zero behavioral change, ~1,075 lines removed.

4. **`defaultMaxGroups` should drop from 64 to 4.** All three agents agree. Grow-on-demand logic at `GlyphRenderer.js:1106` already handles overflow. Saves ~2 MB across 555 grids.

5. **Atlas canvas should be nulled after `generate()`.** All three agents agree this is the immediate fix. Pipeline's `FontMetrics` struct is the correct end-state, but Memory's interim fix (store `_charSize` eagerly, null the canvas) ships now. Saves 16 MB system RAM.

6. **The 555-shader-compilation estimate (28 MB) in my Phase 0 was wrong.** Memory and Pipeline both correctly identified that Three.js caches compiled WebGL programs by shader source hash. The actual GPU program exists in one copy. The 555 `ShaderMaterial` instances create ~1-2 MB of JS-side uniform overhead, not 28 MB of VRAM. My recommendation for `Material.clone()` becomes a minor cleanup, not a significant optimization. I accept this correction.

7. **The `GitHubRepoViewer.init()` try/catch fallback (lines 308-312) must become a hard error.** Pipeline identified it; Memory and GPU endorsed it in Round 1. Silent fallback to `_shaper=null` violates project policy and produces a broken state.

8. **Legacy builder paths (~860 lines) should be removed after enforcing hard-fail on shaper init.** All three agents agree on the Phase 2 scope. The dependency is clear: recommendation 7 (hard-fail) is the gate for this deletion.

9. **Attribute-level VRAM optimizations (instanceSize derivation, color palette) are deferred to Phase 3.** Memory and Pipeline both correctly noted that post-eviction, the instanceSize savings drops from 48.8 MB to ~4.4 MB for visible-only grids. The color palette (67 MB -> ~6 MB post-eviction) is the same story. These remain valid optimizations for frame-time bandwidth, but they are not priority-1 memory fixes. I accept the deferral.

10. **DataTexture upload via `needsUpdate = true` is the only mechanism available.** Memory correctly identified that my Phase 0 criticism of `updateAddedColor` was misleading -- Three.js DataTextures do not support `addUpdateRange()`. Both `updateAddedColor()` and `setGlyphHighlight()` use the same (and only) upload path. No fix needed here.

## Implementation Plan

### Phase 1A: Slim `renderedTexts` (GlyphRenderer.js)

This is the highest-impact single change: ~1.5 GB JS heap reclaimed. All changes are in `src/GlyphRenderer.js`.

**Step 1: Rewrite `applyPrebuiltBuffers` (lines 1486-1521)**

Replace the per-glyph object reconstruction loop with lightweight metadata storage:

```javascript
// REPLACE lines 1487-1520 with:
this.renderedTexts.set(id, {
    id,
    bufferStartIndex: meta.bufferStartIndex,
    glyphCount: meta.glyphCount,
    lineSlotOffsets: meta.lineSlotOffsets || null,
    // No text string, no glyphs array, no options object
});
```

**Step 2: Add buffer-reading helpers (insert after line ~640, before `updatePosition`)**

```javascript
/**
 * Read the position of glyph at absolute buffer index from the typed array.
 * @private
 */
_readGlyphPosition(bufferIndex) {
    const positions = this.instanceMesh.geometry.attributes.instancePosition.array;
    const i = bufferIndex * 3;
    return { x: positions[i], y: positions[i + 1], z: positions[i + 2] };
}

/**
 * Read the size of glyph at absolute buffer index from the typed array.
 * @private
 */
_readGlyphSize(bufferIndex) {
    const sizes = this.instanceMesh.geometry.attributes.instanceSize.array;
    const i = bufferIndex * 2;
    return { width: sizes[i], height: sizes[i + 1] };
}
```

**Step 3: Rewrite `updatePosition` (lines 646-680)**

The current code reads `entry.glyphs[0].position` for the offset calculation and mutates each glyph object. Rewrite to read/write the typed array directly:

```javascript
updatePosition(id, newPosition) {
    const entry = this.renderedTexts.get(id);
    if (!entry || entry.bufferStartIndex === undefined) return;

    const geometry = this.instanceMesh.geometry;
    const positions = geometry.attributes.instancePosition.array;
    const startIdx = entry.bufferStartIndex;

    // Read first glyph's current position from typed array
    const base = startIdx * 3;
    const offset = {
        x: newPosition.x - positions[base],
        y: newPosition.y - positions[base + 1],
        z: newPosition.z - positions[base + 2]
    };

    for (let i = 0; i < entry.glyphCount; i++) {
        const bufIdx = (startIdx + i) * 3;
        positions[bufIdx]     += offset.x;
        positions[bufIdx + 1] += offset.y;
        positions[bufIdx + 2] += offset.z;
    }

    const posAttr = geometry.attributes.instancePosition;
    posAttr.addUpdateRange(startIdx * 3, entry.glyphCount * 3);
    posAttr.needsUpdate = true;
}
```

**Step 4: Rewrite `updateColor` (lines 687-711)**

Same pattern -- remove glyph object mutation, use `entry.glyphCount`:

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

**Step 5: Rewrite `updateAddedColor` (lines 719-738)**

Replace `entry.glyphs.length` with `entry.glyphCount`:

```javascript
// line 729: change
for (let i = 0; i < entry.glyphs.length; i++) {
// to
for (let i = 0; i < entry.glyphCount; i++) {
```

**Step 6: Rewrite `updatePositions` (lines 762-802)**

Same pattern as `updatePosition` but batched. Replace `entry.glyphs[0].position.x` reads (lines 774-777) with `positions[entry.bufferStartIndex * 3]` reads. Replace `entry.glyphs.length` (lines 781, 785) with `entry.glyphCount`. Remove all `glyph.position.x += offset.x` mutations (lines 786-789); write directly to the typed array.

**Step 7: Rewrite `updateColors` (lines 809-840)**

Replace `entry.glyphs.length` (lines 822, 826) with `entry.glyphCount`. Remove `entry.glyphs[i].color = newColor` (line 827). Write directly to colors array.

**Step 8: Rewrite `updateTransforms` (lines 847-910)**

Same pattern for both position and color blocks. Replace `entry.glyphs.length` with `entry.glyphCount` at lines 862, 874, 891. Read first-glyph position from typed array (lines 869-871). Remove glyph object mutations at lines 875-878, 892.

**Step 9: Rewrite `_getTextBounds` (lines 1297-1319)**

Currently iterates `glyphs` array reading `.position` and `.size`. Rewrite to accept `(entry)` instead of `(glyphs)`, read from typed arrays:

```javascript
_getTextBounds(entry) {
    if (entry.glyphCount === 0) return null;
    const positions = this.instanceMesh.geometry.attributes.instancePosition.array;
    const sizes = this.instanceMesh.geometry.attributes.instanceSize.array;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (let i = 0; i < entry.glyphCount; i++) {
        const bufIdx = entry.bufferStartIndex + i;
        const px = positions[bufIdx * 3], py = positions[bufIdx * 3 + 1], pz = positions[bufIdx * 3 + 2];
        const sw = sizes[bufIdx * 2], sh = sizes[bufIdx * 2 + 1];
        minX = Math.min(minX, px); minY = Math.min(minY, py); minZ = Math.min(minZ, pz);
        maxX = Math.max(maxX, px + sw); maxY = Math.max(maxY, py + sh); maxZ = Math.max(maxZ, pz);
    }
    return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ },
             width: maxX - minX, height: maxY - minY, depth: maxZ - minZ };
}
```

Update the caller at `getText()` (line 587): change `this._getTextBounds(entry.glyphs)` to `this._getTextBounds(entry)`.

**Step 10: Rewrite `_rebuildAllInstances` (lines 1325-1340)**

This must read glyph data from typed arrays instead of spreading `entry.glyphs`:

```javascript
_rebuildAllInstances() {
    let totalGlyphs = 0;
    for (const entry of this.renderedTexts.values()) {
        totalGlyphs += entry.glyphCount;
    }
    if (totalGlyphs === 0) return;

    // Read current glyph state from existing typed arrays, repack contiguously
    const oldPositions = this.instanceMesh.geometry.attributes.instancePosition.array;
    const oldSizes = this.instanceMesh.geometry.attributes.instanceSize.array;
    const oldGlyphIds = this.instanceMesh.geometry.attributes.instanceGlyphId.array;
    const oldColors = this.instanceMesh.geometry.attributes.instanceColor.array;
    const oldGroupIds = this.instanceMesh.geometry.attributes.instanceGroupId.array;

    const newPositions = new Float32Array(totalGlyphs * 3);
    const newSizes = new Float32Array(totalGlyphs * 2);
    const newGlyphIds = new Float32Array(totalGlyphs);
    const newColors = new Float32Array(totalGlyphs * 3);
    const newGroupIds = new Float32Array(totalGlyphs);

    let writeIdx = 0;
    for (const entry of this.renderedTexts.values()) {
        const readStart = entry.bufferStartIndex;
        for (let i = 0; i < entry.glyphCount; i++) {
            const r = readStart + i;
            newPositions.set(oldPositions.subarray(r * 3, r * 3 + 3), writeIdx * 3);
            newSizes.set(oldSizes.subarray(r * 2, r * 2 + 2), writeIdx * 2);
            newGlyphIds[writeIdx] = oldGlyphIds[r];
            newColors.set(oldColors.subarray(r * 3, r * 3 + 3), writeIdx * 3);
            newGroupIds[writeIdx] = oldGroupIds[r];
            writeIdx++;
        }
        entry.bufferStartIndex = writeIdx - entry.glyphCount;
    }

    // Swap in new arrays
    const geometry = this.instanceMesh.geometry;
    geometry.setAttribute('instancePosition', new THREE.InstancedBufferAttribute(newPositions, 3));
    geometry.setAttribute('instanceSize', new THREE.InstancedBufferAttribute(newSizes, 2));
    geometry.setAttribute('instanceGlyphId', new THREE.InstancedBufferAttribute(newGlyphIds, 1));
    geometry.setAttribute('instanceColor', new THREE.InstancedBufferAttribute(newColors, 3));
    geometry.setAttribute('instanceGroupId', new THREE.InstancedBufferAttribute(newGroupIds, 1));
    geometry.instanceCount = totalGlyphs;
}
```

**Step 11: Rewrite `getStats` (line 1605-1617)**

Replace `entry.glyphs.length` with `entry.glyphCount` at line 1608.

**Step 12: Rewrite `getText` (lines 572-589)**

The current code exposes `entry.glyphs` to external callers. Replace with a lazy accessor:

```javascript
getText(id) {
    const entry = this.renderedTexts.get(id);
    if (!entry) return null;
    return {
        id,
        glyphCount: entry.glyphCount,
        bufferStartIndex: entry.bufferStartIndex,
        getGlyphAt: (i) => ({
            position: this._readGlyphPosition(entry.bufferStartIndex + i),
            size: this._readGlyphSize(entry.bufferStartIndex + i),
        }),
        updatePosition: (newPos) => this.updatePosition(id, newPos),
        updateColor: (newColor) => this.updateColor(id, newColor),
        remove: () => this.remove(id),
        getBounds: () => this._getTextBounds(entry)
    };
}
```

Check `GlyphCollection.getText()` (~line 942) and any app-level callers that access `.glyphs` -- they must migrate to `.getGlyphAt(i)` or `.glyphCount`.

### Phase 1B: Enable eviction + shrink group default

**File: `src/core/constants.js` line 37**

```javascript
// Change:
defaultMaxGroups: 64
// To:
defaultMaxGroups: 4
```

**File: `src/collections/GridVirtualizer.js` line 46**

```javascript
// Change:
enableEviction = false
// To:
enableEviction = true
```

Note: `atlas` must also be passed in the constructor call. Check `GitHubRepoViewer.js` where the virtualizer is created (~line 342) and pass `{ atlas: this.atlas, enableEviction: true }`.

### Phase 1C: Null atlas canvas after generate

**File: `src/GlyphAtlas.js`**

At the end of `generate()` (after all metrics are computed), add:

```javascript
// Cache charSize eagerly so the canvas can be freed
this._charSize = this.getCharSize();

// Free the 16 MB canvas bitmap -- no longer needed after Slug takes over rendering.
// Keep metrics Map for getMetrics() and ensureGraphemes().
this.atlasCanvas = null;
this.ctx = null;
this._sharedThreeTexture = null;
```

Modify `getCharSize()` (line 337-341) to use the cached value:

```javascript
getCharSize() {
    if (this._charSize) return this._charSize;
    const m = this.metrics.get('M');
    return m ? { width: m.width, height: m.height } : { width: this.fontSize, height: this.fontSize };
}
```

Verify `ensureGraphemes()` -- if it needs the canvas context (`this.ctx`) for new glyph rendering, guard it with a check. In the Slug path, `ensureGraphemes` should only need to tell SlugEncoder to encode new curves, not re-render Canvas 2D bitmaps. If `ensureGraphemes` touches `this.ctx`, that code path should be gated behind `if (this.ctx)`.

### Phase 2: Dead code deletion + hard-fail shaper init

This is Pipeline's domain. Files to delete:
- `src/workers/builders/buildBuffers.js`
- `src/workers/builders/textToGlyphs.js`
- `src/workers/builders/layoutText.js`
- `src/core/InstanceBuffer.js`
- `src/layout/GlyphBatcher.js`
- `src/layout/GlyphInstancePool.js`

Remove their exports from `src/index.js`. Remove legacy branches from `src/workers/builders/index.js`, `src/workers/WorkerBridge.js`, `src/workers/GlyphWorker.js`. Remove the try/catch fallback at `GitHubRepoViewer.js:308-312`. Remove `GlyphRenderer._textToGlyphs` fallback branch. ~1,900 lines total.

### Phase 3 (deferred): Attribute-level VRAM compression

- Derive `instanceSize` from `glyphId` in vertex shader (saves 8 bytes/glyph on visible grids)
- Color palette compression: uint8 index per glyph (saves 11 bytes/glyph on visible grids)
- Pack `instanceGroupId` into `instancePosition.w` (saves 4 bytes/glyph on visible grids)

These are real wins for per-frame vertex bandwidth even after eviction reduces total VRAM. But they require shader, builder, and SlugEncoder changes that should wait until Phases 1-2 have simplified the codebase.

## Implementer Vote

**Pipeline** should implement.

The implementation plan is 60% refactoring update methods to read from typed arrays (Pipeline's strength -- they identified every dead code path and dependency chain in the codebase), 30% enabling existing infrastructure (eviction is already built, group grow-on-demand already works), and 10% atlas cleanup. Pipeline demonstrated the deepest understanding of code liveness analysis, call-site enumeration, and sequencing constraints (their Round 1 correctly identified the `_rebuildAllInstances` dependency that gates eviction). The GPU-side attribute compression in Phase 3 is deferred and can be picked up later by whichever agent is available. The immediate work is a refactoring job, not a GPU architecture job.

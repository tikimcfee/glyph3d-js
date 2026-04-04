# Phase 0: Picking Resolution Analysis

Agent: Picking Resolution
Perspective: Full pipeline from mouse coordinates through GPU readback to highlight application.

---

## Pipeline Overview

The picking pipeline has five sequential stages:

1. `setMousePosition(cssX, cssY)` — scale CSS coords to picking target pixels
2. `renderAndRead(camera, scene)` — material-swap render, read one pixel
3. `resolve(pickingId)` — map 24-bit ID to (renderer, slotIndex)
4. `setGlyphHighlight(slotIndex, color)` — write RGBA8 texel in highlight texture
5. GPU vertex shader — `texelFetch` at `(gl_InstanceID % 1024, gl_InstanceID / 1024)`

Each stage has distinct failure modes. The grapheme cluster migration could have introduced a mismatch at stage 3→4 (slotIndex meaning) or at stage 4→5 (index calculation divergence).

---

## Stage 1: Mouse → Target Pixel

### Code path (PickingSystem.js lines 195–208)

```
newX = floor(cssX * dpr * scale)
newY = floor(cssY * dpr * scale)
```

`scale` is `resolutionScale`, fixed at 1.0 in GitHubRepoViewer. So effectively:

```
newX = floor(cssX * dpr)
newY = floor(cssY * dpr)
```

### DPR=1.46 concrete example

Canvas is 1000×600 CSS pixels. Mouse at CSS (500, 300).

```
newX = floor(500 * 1.46) = floor(730.0) = 730
newY = floor(300 * 1.46) = floor(438.0) = 438
```

Picking target width:
```
w = floor(size.x * dpr * scale) = floor(1000 * 1.46 * 1.0) = 1460
h = floor(600  * 1.46 * 1.0)   = 876
```

Bounds check: `730 < 1460` and `438 < 876` — within bounds.

The Y-flip in readback: `this._target.height - 1 - y = 876 - 1 - 438 = 437`.

`readRenderTargetPixels(target, 730, 437, 1, 1, buffer)`

This is correct. The picking target is constructed at `size * dpr`, which matches the main canvas drawing buffer (Three.js `setSize` sets CSS size; `setPixelRatio(dpr)` multiplies internally, so `getSize()` returns CSS-sized values and the actual buffer is `getSize() * getPixelRatio()`). The target construction at line 177:

```js
const w = Math.floor(size.x * dpr * this._scale);
```

and `getSize()` returns CSS pixels, so `size.x * dpr` is the true drawing buffer size. This matches the main render target.

**Verdict for stage 1: correct after the DPR fix.** Before the fix (if the target was CSS-sized only), a DPR=1.46 device would have the target at 1000×600 while the main canvas rendered at 1460×876. A pick at CSS (500, 300) would have read pixel (500, 300) in a 1000×600 target — that's a different pixel than the one the camera projects the glyph onto. Off by factor 1.46 in both axes. After the fix, the target is DPR-scaled and the mouse coords are DPR-scaled, so they map to the same physical pixel.

---

## Stage 2: Material Swap and Render

The picking shader uses `uBasePickingId + float(gl_InstanceID)` to produce per-glyph IDs. `gl_InstanceID` is zero-based within the draw call, exactly matching the order of instance attributes in the buffer.

Key: `gl_InstanceID` for instance N is the same whether the main material or picking material is active. It is the draw-call-local ordinal. No separate attribute is needed and none exists.

The picking target is rendered with the exact same scene graph and transforms (group DataTexture uniforms are shared — `uniforms.groupTexture.value` references the same object). Visibility (group alpha == 0) is handled identically in both picking and main shaders: invisible instances are pushed to clip-space (2,2,2,1) and produce no fragment.

**Verdict for stage 2: geometrically correct.** The pixel at `(newX, newY)` encodes the glyph that occupies that screen position.

---

## Stage 3: resolve() — pickingId to slotIndex

```js
resolve(pickingId) {
    for (const entry of this._registry) {
        if (pickingId >= entry.startId && pickingId < entry.endId) {
            return { renderer: entry.renderer, slotIndex: pickingId - entry.startId };
        }
    }
}
```

`startId` was assigned at `registerRenderer()` time. The slotIndex is:

```
slotIndex = pickingId - startId = (startId + gl_InstanceID) - startId = gl_InstanceID
```

So `slotIndex == gl_InstanceID` — the zero-based instance ordinal in the current buffer layout.

### Stale ID risk after rebuild

`registerRenderer()` calls `unregisterRenderer()` first, then claims a fresh block of IDs from `_nextPickingId`. The counter only increments — it never resets between registrations. So after a flush rebuilds the geometry:

- Old picking material is disposed.
- New material gets `startId = N` (a new, higher range).
- If the mouse happened to be hovering during the few frames between the old render and the new registration, the previous `lastPickedId` could map to the old registry entry — but `unregisterRenderer` removes that entry, so `resolve()` returns null. No stale hit.

However there is a window: `flush()` calls `registerRenderer()` after `applyPrebuiltBuffers()`. On the frame where the flush occurs, the picking pass might run before re-registration completes (it's synchronous within the animation loop in `animate()` at lines 2006–2022). Because both flush and the animate loop run on the main thread, a flush between frames (e.g. triggered by a WebSocket command) means the picking system is re-registered before the next `animate()` frame. **No stale IDs reach the highlight path in normal operation.**

Edge case: if a renderer is disposed mid-frame and a new one created (file switch), `_lastPickHit` could reference the old renderer. The animate loop guards this:

```js
if (this._lastPickHit?.renderer?.instanceMesh && this._lastPickSlot >= 0) {
    this._lastPickHit.renderer.setGlyphHighlight(this._lastPickSlot, null);
}
```

The `?.instanceMesh` check catches disposed renderers where `instanceMesh` was set to null.

**Verdict for stage 3: structurally sound. slotIndex == gl_InstanceID == buffer ordinal.**

---

## Stage 4: setGlyphHighlight — slotIndex to texel

```js
setGlyphHighlight(bufferSlotIndex, color) {
    const data = this._highlightTexture.image.data;
    const i = bufferSlotIndex * 4;   // flat index
    data[i]   = ...r;
    data[i+1] = ...g;
    data[i+2] = ...b;
    data[i+3] = 0;
    this._highlightTexture.needsUpdate = true;
}
```

The highlight texture is `HIGHLIGHT_TEX_WIDTH=1024` wide, `ceil(count/1024)` tall. It is a flat RGBA8 `Uint8Array`, row-major. Texel for slot N is at flat offset `N * 4`.

Flat index N*4 in a 1024-wide texture maps to 2D coordinates:
- column: `N % 1024`
- row: `floor(N / 1024)`

This is the standard row-major layout and matches the GPU shader:

```glsl
int hx = gl_InstanceID % 1024;
int hy = gl_InstanceID / 1024;
vec4 highlight = texelFetch(highlightTexture, ivec2(hx, hy), 0);
```

**The math is consistent.** `bufferSlotIndex == gl_InstanceID`, both use the same 2D wrap formula. No divergence here.

### What happens on rebuild via applyPrebuiltBuffers

`applyPrebuiltBuffers` calls `_ensureHighlightTexture(count)`. If `count` changed:
- A new texture is created, old data is copied into it (lines 190–193).
- The material uniform is updated to point at the new texture.
- Previous highlight state is preserved for the same slot indices.

If `count` shrunk (fewer glyphs after rebuild), any slots beyond the new count lose their highlight data, which is correct — those instances no longer exist.

If `count` grew, the new slots start zeroed (no highlight).

**The highlight texture stays in sync with the buffer layout after rebuilds.**

---

## Stage 5: resolveGlyph — slotIndex to (textId, charIndex)

```js
resolveGlyph(renderer, slotIndex) {
    for (const [textId, entry] of renderer.renderedTexts) {
        const start = entry.bufferStartIndex;
        const end = start + entry.glyphs.length;
        if (slotIndex >= start && slotIndex < end) {
            return { textId, charIndex: slotIndex - start };
        }
    }
}
```

`charIndex` is `slotIndex - entry.bufferStartIndex`. This is the **buffer-local glyph ordinal** — which glyph within this text entry's buffer range was hit.

After the grapheme cluster migration, `entry.glyphs` contains one entry per rendered grapheme cluster (since `applyPrebuiltBuffers` rebuilds the glyph array from the buffer using `iterGraphemes` with the same `cp > 32` skip logic). So `charIndex` is the grapheme-cluster index within the rendered portion of the text.

**For the highlight path this does not matter** — `resolveGlyph` is not called in the hover highlight loop (lines 2006–2022 of animate). The animate loop only uses `resolve()` → slotIndex → `setGlyphHighlight(slotIndex)` directly. `resolveGlyph` is exposed for higher-level consumers (e.g., hover tooltips, command handlers) that need to know which token was picked.

---

## Primary Failure Modes

### F1: Picking target built at CSS size (pre-DPR fix)

Before the DPR fix, if `_createTarget()` used `size.x` without `* dpr`, the target would be `1000×600` while the main canvas rendered at `1460×876`. The mouse DPR scaling in `setMousePosition` would compute `newX=730` but the target was only 1000 wide — the pick would sample the wrong pixel (730 vs ~500 in the unscaled target). This produces wrong glyph IDs and misaligned highlights.

The current code multiplies by `dpr` in both `_createTarget` and `setMousePosition`. **This is fixed.**

### F2: slotIndex offset after grapheme cluster migration

If the buffer builder (post-migration) now emits a different number of glyphs per character sequence than before, `entry.glyphs.length` changes. This affects `entry.bufferStartIndex` for all subsequent entries. Crucially: `registerRenderer` re-registers after every flush (not just once), and `bufferStartIndex` is set during `_rebuildAllInstances` or `applyPrebuiltBuffers`, both of which run at flush time. So the slot mapping is always recomputed from the current buffer state.

The risk is if `_buildLineSlotBase` in CodeGrid is called with stale data — but it's called immediately after `flushAsync()` completes, so it sees the same buffer layout.

**No offset mismatch from grapheme migration if flush and registration are in order.**

### F3: resolveGlyph uses glyphs.length but fallback itemMeta uses iterGraphemes count

The fallback `itemMeta` computation in `applyPrebuiltBuffers` (lines 1355–1371) counts graphemes with `cp > 32` to determine `glyphCount`. Then it reconstructs the glyph array with `new Array(meta.glyphCount)`. The `resolveGlyph` loop checks `slotIndex < start + entry.glyphs.length`. If `meta.glyphCount` is correct this is consistent.

However: the primary `itemMeta` path (from the worker) stores `lineSlotOffsets` in the entry, while the fallback does not. `_buildLineSlotBase` prioritizes `lineSlotOffsets` from `contentItemMeta`, which routes through `renderer.renderedTexts.get(rendId)`. If the entry was built via fallback, `lineSlotOffsets` is null and `_buildLineSlotBase` falls through to the sync-path reconstruction — which in async context reads `_contentTextIds` instead of builder offsets. If those text IDs refer to stale renderer IDs this mapping breaks.

**This is the most likely remaining mismatch vector after the grapheme migration**: the worker path sets `lineSlotOffsets` on the entry, but if structured clone failed (which the code guards against with the fallback) or the worker returned metadata with different grapheme counting logic than the main thread, `_lineSlotBase` could be off by one or more columns, causing `highlightRange` to write to the wrong buffer slot.

### F4: highlight texture not resized when renderer is re-registered

`registerRenderer` does not call `_ensureHighlightTexture`. It only creates the picking material. The highlight texture is sized during `applyPrebuiltBuffers` / `_rebuildAllInstances` which both call `_ensureHighlightTexture(count)`. A re-registration with more glyphs than the previous texture size would leave the texture undersized. However this scenario does not arise in the normal path: `registerRenderer` is called immediately after the flush that sized the texture, so they're always in sync.

---

## Summary Table

| Stage | Correct? | Risk After Grapheme Migration |
|-------|----------|-------------------------------|
| Mouse → target pixel (DPR scale) | Yes, fixed | None — DPR math is independent of glyphs |
| Y-flip in readback | Yes | None |
| Material swap + render | Yes | None |
| resolve() slotIndex == gl_InstanceID | Yes | None — structural |
| setGlyphHighlight flat index vs shader texelFetch | Yes | None — both use same 2D wrap |
| resolveGlyph charIndex semantics | Buffer-ordinal (not grapheme index) | Cosmetic — only matters for token lookup, not hover highlight |
| lineSlotBase after flush | Depends on itemMeta path | **High risk if worker lineSlotOffsets missing or mismatched** |

---

## Files Referenced

- `/home/user/dev/glyph3d-js/src/picking/PickingSystem.js` — full pipeline
- `/home/user/dev/glyph3d-js/src/GlyphRenderer.js` — `setGlyphHighlight`, `_ensureHighlightTexture`, `applyPrebuiltBuffers`, `_rebuildAllInstances`
- `/home/user/dev/glyph3d-js/src/collections/CodeGrid.js` — `_buildLineSlotBase`, `getSlotForChar`, `highlightRange`
- `/home/user/dev/glyph3d-js/src/collections/GlyphCollection.js` — `setPickingSystem`, flush re-registration
- `/home/user/dev/glyph3d-js/app/GitHubRepoViewer.js` — animate loop picking block (lines 2005–2023), mousemove handler (lines 615–623)

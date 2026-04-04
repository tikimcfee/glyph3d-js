# Glyph-Level Rendering — Implementation Summary

Implemented from the three round3 convergence documents on 2026-03-30.

## What Was Implemented

### Modified Files

**`src/GlyphRenderer.js`**

- `_createInstanceMesh()`: Added pre-allocation of `instanceAddedColor` (vec3, Float32Array × 3) and `instancePickingId` (float, Float32Array × 1) in the `!skipPrealloc` block, alongside the five existing attributes.
- `_getVertexShader()`: Added `attribute vec3 instanceAddedColor` and `attribute float instancePickingId` declarations. Added `varying vec3 vAddedColor`. Assigns `vAddedColor = instanceAddedColor` at the end of `main()`. `instancePickingId` is declared but not used as a varying — present only to satisfy WebGL attribute validation when the geometry has the attribute set.
- `_getFragmentShader()`: Added `varying vec3 vAddedColor` declaration. Changed output to `vec4(clamp(base.rgb + vAddedColor, 0.0, 1.0), base.a)` — additive blend after group color multiply. Zero addedColor = no visual change.
- `_updateInstanceMesh()`: Added `addedColors` array extraction and fill in the hot loop. Added `instanceAddedColor.needsUpdate = true` after the loop. Both are guarded with optional chaining / existence checks for the `skipPrealloc` path.
- `applyPrebuiltBuffers()`: Destructures `addedColors` from buffers (not `pickingIds` — builders do not emit it). Sets `instanceAddedColor` attribute with `addedColors || new Float32Array(count * 3)` fallback. Sets `instancePickingId` as a fresh zeros array (PickingSystem overwrites it post-flush).
- New method `updateAddedColor(id, addedColor)`: Direct buffer write for all glyphs of a text entry. No rebuild.
- New method `setGlyphHighlight(bufferSlotIndex, color)`: Single-glyph direct buffer write by absolute slot index. Core API for token-level highlighting.
- New method `assignPickingIds(textId, baseId)`: Per-entry picking ID assignment; available for callers who want entry-level control, though `PickingSystem.registerRenderer()` is the primary path.

**`src/collections/GlyphCollection.js`**

- Constructor: Added `this._pickingSystem = null` field.
- New method `getRenderer()`: Returns `this._renderer` (created lazily on first flush). Required by app layer to call `pickingSystem.registerRenderer()` directly.
- New method `setPickingSystem(pickingSystem)`: Wires a PickingSystem so both `flush()` and `flushAsync()` automatically re-register after every buffer rebuild.
- `flush()`: Added post-flush picking registration hook: `if (this._renderer && this._pickingSystem) { this._pickingSystem.registerRenderer(this._renderer); }` — before `this._dirty = false`.
- `flushAsync()`: Same hook at equivalent completion point (after pending updates are processed, before `this._dirty = false`).

### New Files

**`src/picking/PickingSystem.js`** (~230 lines)

Full GPU picking implementation:
- Constructor accepts `THREE.WebGLRenderer` and `{ resolutionScale }`. Initializes `_nextPickingId` from `window.__glyph3dPickingIdCounter` to survive hot-reload.
- `registerRenderer(glyphRenderer)`: Calls `unregisterRenderer` first (removes stale entry), claims `[startId, endId)` ID block, writes `instancePickingId` buffer with sequential IDs, creates a picking mesh (shared `InstancedBufferGeometry` reference, dedicated `ShaderMaterial` with inline shaders), adds mesh to `_pickingScene`, pushes entry to `_registry`.
- `unregisterRenderer(glyphRenderer)`: Removes from registry by identity, removes mesh from scene, disposes material. Does not compact `_nextPickingId`.
- `renderAndRead(camera)`: Consolidated — sets render target, clears to black, renders `_pickingScene`, `gl.readPixels` at mouse pixel (Y-flipped), restores render target to null, decodes 24-bit RGB integer.
- `renderPickingPass(camera)` / `readAtMouse()`: Separate public methods for callers controlling read timing (async PBO path in Phase 2).
- `resolve(pickingId)`: O(N) registry scan returning `{ renderer, slotIndex }` or null.
- `resolveGlyph(renderer, slotIndex)`: Walks `renderer.renderedTexts` by `bufferStartIndex` ranges, returns `{ textId, charIndex }`.
- `setMousePosition(cssX, cssY)`: Converts CSS coords to target-pixel coords with `devicePixelRatio × resolutionScale`.
- `onResize()`: Recreates render target at new viewport size.
- `dispose()`: Full cleanup of meshes, materials, render target.
- `static decodePickingId(pixel)`: Utility for callers doing manual readback.
- Picking vertex shader (inline): Mirrors main shader's worldPos formula, suppresses invisible-group glyphs with `if (visible < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }` (no w=0 UB).
- Picking fragment shader (inline): Encodes `vPickingId` as 24-bit RGB.

**`src/picking/index.js`**

Barrel export for `PickingSystem`.

**`src/semantic/SemanticInfoMap.js`** (~105 lines)

Pure data structure, no DOM/Three.js imports:
- `SemanticInfo` class: `{ tokenType, text, glyphStart, glyphEnd, line, col }`.
- `SemanticInfoMap` class: sparse `_glyphIndex` array for O(1) slot lookup, category buckets (`functions`, `classes`, `variables`, `keywords`, `strings`, `comments`).
- `populate(tokens, glyphOffsets)`: Builds index, fills buckets. Must be called after every flush (not once at load — buffer slot indices shift on rebuild).
- `lookup(glyphBufferIndex)`: O(1).
- `getTokenRange(glyphBufferIndex)`: Returns `{ start, end }`.
- `invalidate()`: Clears all state before re-populate.

**`src/semantic/GlyphEvents.js`** (~60 lines)

- `GlyphEventType`: `HOVER_ENTER`, `HOVER_EXIT`, `CLICK`.
- `GlyphEventBus`: `on/off/emit` using `Map<type, Set<fn>>`. No DOM events.

**`src/semantic/index.js`**

Barrel export for `SemanticInfo`, `SemanticInfoMap`, `GlyphEventType`, `GlyphEventBus`.

**`examples/picking-test/index.html` + `examples/picking-test/main.js`**

Test page:
- Loads GlyphAtlas, creates a GlyphCollection with sample source text.
- Wires PickingSystem and runs the render loop with `renderAndRead()` every frame.
- Hover highlighting via `setGlyphHighlight()`.
- Key `1`: Phase 1 self-test — validates `instancePickingId` attribute existence and sequential values against registry.
- Key `2`: Phase 2 self-test — live hover readback, logs 5 successful picks.
- Key `3`: Phase 3 self-test — additive color sweep band across all glyphs.
- Key `P`: Toggle picking texture fullscreen debug overlay (blit via `readPixels`).
- Key `R`: Clear all highlights.

**`src/index.js`** (modified)

Added exports: `PickingSystem`, `SemanticInfo`, `SemanticInfoMap`, `GlyphEventType`, `GlyphEventBus`.

## Key Design Decisions Implemented

1. **No `pickingIds` from builders** — `buildGlyphBuffers()` and `buildBatchBuffers()` remain picking-unaware. `PickingSystem.registerRenderer()` writes the buffer post-flush.
2. **`instancePickingId` declared in main vertex shader** but not read — satisfies WebGL attribute validation without wasting a varying slot.
3. **Shared geometry picking meshes** — `PickingSystem` creates `THREE.Mesh(geom, pickingMat)` where `geom` is the same reference as the production mesh. Zero extra geometry memory.
4. **`window.__glyph3dPickingIdCounter` persistence** — survives module hot-reload in development.
5. **Zero addedColor = no visual change** — existing rendering is pixel-identical before any highlight is applied.
6. **`registerRenderer()` as post-flush lifecycle hook** — both `flush()` and `flushAsync()` call it, ensuring picking IDs are never stale after a rebuild.

## What Remains (Phase 2+)

- Async PBO readback path (`PIXEL_PACK_BUFFER` + fence sync) to eliminate GPU stall on `gl.readPixels`.
- `SemanticInfoMap.populate()` wiring to actual token data (language server output or static analysis).
- `GlyphEventBus` integration with `PickingSystem` hover resolution for full hover pipeline.
- Rotation/scale columns in the group DataTexture (currently reserved but not active).

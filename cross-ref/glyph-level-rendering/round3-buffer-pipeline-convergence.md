# Round 3: buffer-pipeline convergence

## Settled

All points now fully resolved. The three round-1 reviews reached consistent conclusions on every
substantive tension. The following numbered list is the authoritative convergence position.

1. **`gl_InstanceID` replaces `instanceBufferIndex` entirely.**
   `gl_InstanceID` is a free GLSL ES 3.0 built-in available in every WebGL 2 context. Carrying
   a redundant `0, 1, 2, ...` sequence as a `Float32Array` wastes 4 bytes/glyph (40 KB at 10K
   instances) and requires a CPU write on every rebuild. The integration-testing Phase 1 plan
   that treated `instanceBufferIndex` as a writable attribute is superseded. No such attribute
   is added to the geometry.

2. **`pickingIds` removed from builder output entirely.**
   `buildGlyphBuffers()` and `buildBatchBuffers()` in `src/workers/builders/index.js` do NOT
   emit a `pickingIds` Float32Array. The worker runs in a context without access to the
   `PickingSystem` singleton and cannot know the global `_nextPickingId` counter value at
   dispatch time. Putting `pickingIdBase` in the worker job would create a coordination round-
   trip that defeats async computation. All three round-1 reviewers converged on this.

3. **`instancePickingId` is assigned by `PickingSystem.registerRenderer()` post-flush.**
   After `_rebuildAllInstances()` or `applyPrebuiltBuffers()` completes, `PickingSystem`
   writes the `instancePickingId` buffer directly using its own global counter. This is the
   only code path where `geometry.instanceCount` is known and stable, and where the global
   sequential ID space is owned.

4. **`registerRenderer()` is a post-flush lifecycle hook, not a one-time init call.**
   Every call to `_rebuildAllInstances()` (triggered by text removal, file reload, any dynamic
   update) discards and reconstructs the buffer layout. Any `instancePickingId` values written
   against the old layout become wrong. `registerRenderer()` must be called after every flush
   that involves a rebuild. `GlyphCollection.flush()` should call
   `pickingSystem?.registerRenderer(this._renderer)` as its final step. A corresponding
   `unregisterRenderer()` must be called before re-registration to keep the registry clean.

5. **24-bit RGB picking color encoding, single global sequential ID.**
   The picking fragment shader encodes one 24-bit integer across RGB. Alpha is hardcoded to
   1.0. This gives 16.7M unique IDs across all renderers. No bit-split between renderer
   discriminator and slot index is needed. The registry maps ID ranges to renderers, providing
   O(1) renderer lookup after a binary search or range scan. Integration-testing's "pickingId
   in high bits / bufferIndex in low bits" scheme is dropped.

6. **Picking vertex shader uses explicit branch for invisible-group suppression.**
   The `w=0` trick (`vec4(worldPos, visible)`) is broken GLSL — it causes a perspective
   divide by zero and the behavior is undefined. The correct approach, confirmed by both
   buffer-pipeline and picking-system reviewers, is:
   ```glsl
   if (visible < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
   ```
   This pushes the primitive outside the clip volume without any divide.

7. **`instanceAddedColor` (vec3, additive) is the per-glyph highlight mechanism.**
   This is phase0-buffer-pipeline's design, uncontested by both other reviewers. It is an
   additive blend applied after the multiply by `vColor` and before the alpha test. The
   attribute is zero-initialized at allocation; zero = no added color = no visual change.
   A `setGlyphHighlight(bufferSlotIndex, color)` single-glyph overload is also needed
   alongside the per-entry `updateAddedColor(id, color)` API.

8. **Shared-geometry picking scene, not material-swap.**
   The picking meshes share the `InstancedBufferGeometry` with the production meshes
   (no clone). They live in a separate `THREE.Scene` with the picking material. This avoids
   renderer state mutation and uses zero extra geometry memory. Phase0-buffer-pipeline's
   material-swap sketch is abandoned.

9. **`GlyphCollection` needs a `getRenderer()` public accessor.**
   `GlyphCollection._renderer` is created lazily inside `flush()`. The app layer needs it
   to call `pickingSystem.registerRenderer()`. A one-line `getRenderer() { return this._renderer; }`
   is required in `src/collections/GlyphCollection.js`.

10. **`SemanticInfoMap.populate()` wired to flush completion, not load time.**
    Buffer slot indices shift on every `_rebuildAllInstances()`. The SemanticInfoMap must be
    reconstructed inside the flush completion callback using `itemMeta` from
    `applyPrebuiltBuffers()`. This invalidation lifecycle is the most dangerous practical risk
    in the entire design — unaddressed, it silently returns wrong glyph identities after any
    dynamic update.

11. **`instancePickingId` pre-allocated as zeros in `_createInstanceMesh()`.**
    Even though the builder does not emit picking IDs, the attribute must exist in the
    geometry before `registerRenderer()` writes it. Pre-allocating as a zeros array in the
    `!skipPrealloc` block (alongside the five existing attributes) satisfies both the sync
    and worker paths.

12. **`window.__glyph3dPickingIdCounter` persistence across hot-reload.**
    The PickingSystem's `_nextPickingId` counter should be initialized from
    `window.__glyph3dPickingIdCounter = (window.__glyph3dPickingIdCounter || 0)` in the
    constructor, and written back on each `registerRenderer()` call. Module-level counter
    state resets on hot-reload; the window-level value persists through the dev cycle.

13. **Async PBO readback path is a phase-2 optimization, not phase-1 blocker.**
    `gl.readPixels` on the same frame as `renderPickingPass()` causes a GPU sync stall.
    The `PIXEL_PACK_BUFFER` + fence sync pattern (picking-system section 8) defers this stall
    to the following frame. This optimization should be noted in the implementation but not
    required for the initial working implementation.

14. **`onResize()` must be wired to the canvas resize event.**
    `PickingSystem.onResize()` recreates the `WebGLRenderTarget` at the new viewport size and
    updates mouse pixel coordinate scaling. Without this, picking coordinates drift after any
    window resize. The render loop integration must include:
    `window.addEventListener('resize', () => pickingSystem.onResize())`.

---

## Implementation Plan

### Files to create

**`src/picking/PickingSystem.js`** — new file, ~200 lines.

```js
// Constructor
constructor(threeRenderer, options = {}) {
    this._renderer = threeRenderer;
    this._resolutionScale = options.resolutionScale ?? 1.0;
    this._nextPickingId = (window.__glyph3dPickingIdCounter = window.__glyph3dPickingIdCounter || 1);
    this._registry = [];   // [{ renderer, startId, count }]
    this._pickingScene = new THREE.Scene();
    this._target = null;
    this._createTarget();
}

// _createTarget() — creates WebGLRenderTarget at current size × resolutionScale

// registerRenderer(glyphRenderer, label?)
//   - unregister any prior entry for this renderer instance
//   - count = glyphRenderer.instanceMesh.geometry.instanceCount (or renderedTexts-derived)
//   - startId = this._nextPickingId
//   - write instancePickingId attribute: for i in [0, count): ids[startId + i]
//   - this._nextPickingId += count
//   - window.__glyph3dPickingIdCounter = this._nextPickingId
//   - add picking mesh (shared geometry, picking material) to this._pickingScene
//   - push { renderer: glyphRenderer, startId, count } to this._registry

// unregisterRenderer(glyphRenderer)
//   - remove from this._registry by identity
//   - remove corresponding picking mesh from this._pickingScene
//   - NOTE: does NOT compact _nextPickingId — IDs are monotonically consumed

// renderPickingPass(camera) + readAtMouse(mouseX, mouseY) → pickingId integer
//   - consolidated: set target, clear, render, readPixels, restore target null
//   - returns 0 if no hit

// resolve(pickingId) → { renderer, textId, glyphIndex } | null
//   - binary-search _registry by startId range
//   - slotIndex = pickingId - entry.startId
//   - walk renderer.renderedTexts to find which text owns slotIndex (by bufferStartIndex)

// onResize() → _createTarget() with current renderer size

// static decodePickingId(pixel: Uint8Array) → number
//   pixel[0] * 65536 + pixel[1] * 256 + pixel[2]
```

Picking vertex shader (inline string inside PickingSystem.js, not a separate .glsl file to
avoid a fetch dependency):

```glsl
// Picking vertex — copy the worldPos formula from GlyphRenderer._getVertexShader()
// then:
float visible = step(0.01, gColor.a);   // gColor from group DataTexture col 2
if (visible < 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
}
gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
vPickingId = instancePickingId;
```

Picking fragment shader (inline string):

```glsl
precision highp float;
varying float vPickingId;
void main() {
    float id = vPickingId;
    float r = floor(id / 65536.0) / 255.0;
    float g = floor(mod(id, 65536.0) / 256.0) / 255.0;
    float b = mod(id, 256.0) / 255.0;
    gl_FragColor = vec4(r, g, b, 1.0);
}
```

**`src/semantic/SemanticInfoMap.js`** — new file, ~60 lines.

```js
// populate(glyphRenderer)
//   - walk glyphRenderer.renderedTexts Map
//   - for each entry: store { textId, charIndex } keyed by bufferSlotIndex (entry.bufferStartIndex + i)
//   - using a plain object (not Map) for O(1) integer-keyed lookup

// lookup(bufferSlotIndex) → { textId, charIndex } | null

// invalidate() — clears the map; must be called before re-populate
```

### Files to modify

**`src/GlyphRenderer.js`**

1. `_createInstanceMesh()` — in the `!this.config.skipPrealloc` block (around line 216–229),
   add two new attributes after `instanceGroupId`:
   ```js
   geometry.setAttribute('instanceAddedColor',
       new THREE.InstancedBufferAttribute(new Float32Array(maxCount * 3), 3));
   geometry.setAttribute('instancePickingId',
       new THREE.InstancedBufferAttribute(new Float32Array(maxCount), 1));
   ```

2. `_getVertexShader()` (starts line 251) — after the `attribute float instanceGroupId;`
   declaration (line ~259), add:
   ```glsl
   attribute vec3 instanceAddedColor;
   attribute float instancePickingId;
   ```
   After the `varying float vGroupAlpha;` declaration, add:
   ```glsl
   varying vec3 vAddedColor;
   ```
   At the end of `main()`, after `vGroupAlpha = gColor.a;` (line ~311):
   ```glsl
   vAddedColor = instanceAddedColor;
   ```
   Note: `instancePickingId` is declared as an attribute but NOT passed as a varying in the
   color shader — it is only used in the picking shader. Declare the attribute to satisfy
   WebGL attribute validation when the geometry has the attribute set.

3. `_getFragmentShader()` (line ~320) — replace the body with:
   ```glsl
   precision highp float;
   uniform sampler2D atlasTexture;
   varying highp vec2 vUV;
   varying vec3 vColor;
   varying float vGroupAlpha;
   varying vec3 vAddedColor;

   void main() {
       vec4 texColor = texture2D(atlasTexture, vUV);
       vec4 base = texColor * vec4(vColor, vGroupAlpha);
       gl_FragColor = vec4(clamp(base.rgb + vAddedColor, 0.0, 1.0), base.a);
       if (gl_FragColor.a < 0.01) discard;
   }
   ```

4. `_updateInstanceMesh()` (hot loop, lines ~1056–1078) — extract new attribute arrays before
   the loop (parallel to how `posArr`, `colorArr`, etc. are extracted), then inside the loop
   after the `groupIds[i]` write:
   ```js
   const addedColorArr = geometry.attributes.instanceAddedColor.array;
   // picking ID array not written here — owned by PickingSystem.registerRenderer()
   // ...inside loop:
   const ac = g.addedColor;
   addedColorArr[i * 3]     = ac ? ac.r : 0;
   addedColorArr[i * 3 + 1] = ac ? ac.g : 0;
   addedColorArr[i * 3 + 2] = ac ? ac.b : 0;
   ```
   After the loop, add `needsUpdate` for the new attribute (lines ~1081–1085 area):
   ```js
   geometry.attributes.instanceAddedColor.needsUpdate = true;
   // instancePickingId.needsUpdate is set by PickingSystem.registerRenderer(), not here
   ```

5. `applyPrebuiltBuffers()` (line ~1122) — extend destructure:
   ```js
   const { positions, sizes, codepoints, colors, groupIds,
           addedColors, count } = buffers;
   // pickingIds intentionally NOT destructured — not emitted by builders
   ```
   After the existing five `geometry.setAttribute` calls (after `instanceGroupId`):
   ```js
   geometry.setAttribute('instanceAddedColor',
       new THREE.InstancedBufferAttribute(
           addedColors || new Float32Array(count * 3), 3));
   // instancePickingId already pre-allocated as zeros; PickingSystem overwrites it
   ```

6. Add `updateAddedColor(id, addedColor)` after `updateColor()` (line ~535):
   ```js
   /**
    * Update additive color highlight for all glyphs of a text entry.
    * Direct buffer write — no rebuild.
    * @param {number} id
    * @param {{r:number, g:number, b:number}|null} addedColor - null clears
    */
   updateAddedColor(id, addedColor) {
       const entry = this.renderedTexts.get(id);
       if (!entry || entry.bufferStartIndex === undefined) return;
       const arr = this.instanceMesh.geometry.attributes.instanceAddedColor.array;
       const startIdx = entry.bufferStartIndex;
       const r = addedColor?.r ?? 0;
       const g = addedColor?.g ?? 0;
       const b = addedColor?.b ?? 0;
       for (let i = 0; i < entry.glyphs.length; i++) {
           const bufIdx = (startIdx + i) * 3;
           arr[bufIdx]     = r;
           arr[bufIdx + 1] = g;
           arr[bufIdx + 2] = b;
       }
       this.instanceMesh.geometry.attributes.instanceAddedColor.needsUpdate = true;
   }
   ```

7. Add `setGlyphHighlight(bufferSlotIndex, color)` alongside `updateAddedColor()`:
   ```js
   /**
    * Set additive highlight on a single glyph by absolute buffer slot index.
    * Used for token-level highlighting within a text entry.
    * @param {number} bufferSlotIndex - Absolute index into instanceAddedColor array
    * @param {{r:number, g:number, b:number}|null} color - null clears
    */
   setGlyphHighlight(bufferSlotIndex, color) {
       const arr = this.instanceMesh.geometry.attributes.instanceAddedColor.array;
       const i = bufferSlotIndex * 3;
       arr[i]     = color?.r ?? 0;
       arr[i + 1] = color?.g ?? 0;
       arr[i + 2] = color?.b ?? 0;
       this.instanceMesh.geometry.attributes.instanceAddedColor.needsUpdate = true;
   }
   ```

8. Add `assignPickingIds(textId, baseId)` (used by PickingSystem internally if needed, but
   primary path is `registerRenderer()` writing the full buffer):
   ```js
   /**
    * Write contiguous picking IDs for one text entry.
    * @param {number} textId
    * @param {number} baseId - First glyph gets baseId, subsequent glyphs baseId+1, etc.
    */
   assignPickingIds(textId, baseId) {
       const entry = this.renderedTexts.get(textId);
       if (!entry || entry.bufferStartIndex === undefined) return;
       const arr = this.instanceMesh.geometry.attributes.instancePickingId.array;
       const start = entry.bufferStartIndex;
       for (let i = 0; i < entry.glyphs.length; i++) {
           arr[start + i] = baseId + i;
       }
       this.instanceMesh.geometry.attributes.instancePickingId.needsUpdate = true;
   }
   ```

**`src/collections/GlyphCollection.js`**

1. Add `getRenderer()` accessor (after the constructor or near `_renderer` usage, line ~61):
   ```js
   /** @returns {GlyphRenderer|null} */
   getRenderer() { return this._renderer; }
   ```

2. `flush()` completion (line ~481) — after `_rebuildAllInstances()` / buffer application,
   add:
   ```js
   // Notify picking system of rebuilt geometry (must re-register every flush)
   if (this._pickingSystem) {
       this._pickingSystem.unregisterRenderer(this._renderer);
       this._pickingSystem.registerRenderer(this._renderer);
   }
   ```
   Also add a `setPickingSystem(ps)` setter so the app layer can wire this:
   ```js
   setPickingSystem(pickingSystem) { this._pickingSystem = pickingSystem; }
   ```

3. `flushAsync()` normalization loop (lines ~558–563) — the `addedColor` field needs to flow
   through to batch items. Add after the `groupId` normalization line:
   ```js
   if (!p.addedColor) p.addedColor = p.options?.addedColor ?? null;
   // pickingIdBase intentionally NOT propagated — picking IDs are assigned post-flush
   ```

**`src/workers/builders/index.js`**

1. `buildGlyphBuffers()` (lines ~70–74, 121–139):
   - Add allocation: `const addedColors = new Float32Array(glyphCount * 3);`
   - Add to input destructure: `addedColor = null` (no `pickingIdBase`)
   - In hot loop after `groupIds[idx]`: fill `addedColors[idx*3..idx*3+2]` if `addedColor`
   - Return: add `addedColors` to the return object
   - **Remove** any `pickingIds` allocation or `pickingIdBase` parameter (not emitted)

2. `buildBatchBuffers()` (lines ~257–262, 355–362):
   - Add allocation: `const addedColors = new Float32Array(totalGlyphs * 3);`
   - Add per-item destructure: `itemAddedColor = item.addedColor || null`
   - In hot loop: fill `addedColors` from `itemAddedColor` if present
   - Return: add `addedColors` to the return object
   - **Remove** any `pickingIds` allocation or `itemPickingIdBase` (not emitted)

**`src/index.js`**

Export `PickingSystem` and `SemanticInfoMap`:
```js
export { PickingSystem } from './picking/PickingSystem.js';
export { SemanticInfoMap } from './semantic/SemanticInfoMap.js';
```

### Files to delete

None. No existing files become obsolete.

### Implementation order

Execute in this sequence to avoid breaking the existing render path at any intermediate step:

1. `_createInstanceMesh()` attribute additions — safe to add zeros; no shader changes yet.
2. `buildGlyphBuffers()` / `buildBatchBuffers()` — add `addedColors` output; workers are pure.
3. Vertex shader: add `attribute vec3 instanceAddedColor` and `varying vec3 vAddedColor`.
4. Fragment shader: additive blend. Verify existing examples still render (zeros = no change).
5. `applyPrebuiltBuffers()`: add `instanceAddedColor` setAttribute.
6. `_updateInstanceMesh()`: fill `addedColorArr` in hot loop.
7. `updateAddedColor()`, `setGlyphHighlight()`, `assignPickingIds()` direct-write APIs.
8. `GlyphCollection` changes: `getRenderer()`, `setPickingSystem()`, flush hook.
9. `src/picking/PickingSystem.js` — new file, full picking pipeline.
10. `src/semantic/SemanticInfoMap.js` — new file, glyph slot registry.
11. Export additions in `src/index.js`.
12. Render loop integration: `onResize()` listener, picking pass ordering, deferred readback.

---

## Implementer Vote

**picking-system** should implement this plan.

The picking-system agent's Phase 0 contains the `PickingSystem.registerRenderer()` design
that is the exact centerpiece of the converged plan — including the global sequential counter,
the registry range-lookup for `resolve()`, the shared-geometry picking scene, the
`WebGLRenderTarget` lifecycle, `onResize()`, and the `PIXEL_PACK_BUFFER` async readback path.
The critical shift from buffer-pipeline's original design (builder-emitted picking IDs) to the
post-flush registration model matches picking-system's architecture exactly.

The buffer-pipeline additions (`instanceAddedColor`, direct-write APIs, shader blend, builder
changes) are mechanical and well-specified above — any agent can execute them by following the
code sketches in this document. But the `PickingSystem.js` module requires judgment about
render target management, WebGL state cleanup, and the registry invalidation lifecycle that
picking-system explored more deeply than the other agents. That agent's perspective is closest
to what the implementation work actually requires.

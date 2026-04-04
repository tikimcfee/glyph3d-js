# Round 3: picking-system convergence

## Settled

All three round-1 reviewers converged on the same resolutions. No point remains open.

1. **`gl_InstanceID` replaces `instanceBufferIndex` as a buffer attribute.**
   All three reviews agree: GLSL ES 3.0 provides `gl_InstanceID` as a built-in at zero
   CPU/buffer cost. Adding `instanceBufferIndex` as a `Float32Array` wastes 40 KB at
   10K instances and requires a CPU write per rebuild. The attribute must not be added.
   Integration-testing's Phase 1 self-test (`attr.array[i] === i`) must be replaced.
   Rationale: buffer-pipeline identified this first; picking-system and integration-testing
   reviewers each confirmed it independently.

2. **`instancePickingId` is assigned by `PickingSystem.registerRenderer()`, not by workers.**
   The worker builders cannot know the global `_nextPickingId` counter at dispatch time
   without a synchronous round-trip that defeats async. `registerRenderer()` claims a
   contiguous block post-flush and writes the buffer directly. The builder return shapes
   must not include `pickingIds`. Rationale: all three reviews reached this conclusion;
   integration-testing's review stated it most precisely (tension 1).

3. **Remove `pickingIds` from builder output entirely.**
   `buildGlyphBuffers()` and `buildBatchBuffers()` in `src/workers/builders/` must not
   emit a `pickingIds` Float32Array. Any code path that passes `pickingIdBase` into the
   worker is removed. The builders remain pure, with no knowledge of the picking system.

4. **24-bit RGB encoding with registry range lookup for renderer resolution.**
   `pickingId → r=(id>>16)&0xFF, g=(id>>8)&0xFF, b=id&0xFF`. Black (0,0,0) is
   "no hit". A single global sequential integer encodes glyph identity across all
   renderers. The `PickingSystem._registry` maps `{ startId, count }` blocks to their
   renderer. Integration-testing's proposed "pickingId in high bits / bufferIndex in low
   bits" split is discarded — it is underdefined, fragile at scale, and redundant given
   the registry. 24-bit gives 16.7M IDs, sufficient for `10000 instances × ~1670
   renderers`.

5. **`registerRenderer()` is a post-flush lifecycle hook, not a one-time init.**
   Every call to `_rebuildAllInstances()` or `applyPrebuiltBuffers()` changes
   `bufferStartIndex` values and invalidates the previous ID-to-slot mapping. The picking
   system must re-run registration after every rebuild. `GlyphCollection.flush()` and
   `flushAsync()` must call `this._pickingSystem?.registerRenderer(this._renderer)` at
   their completion points. Registration must also call `unregisterRenderer()` first to
   remove the stale registry block before claiming a new one.

6. **`w=0` visibility trick is broken GLSL — use an explicit branch instead.**
   Setting `gl_Position.w = 0.0` for invisible instances does not discard the primitive;
   it triggers a perspective divide by zero, which is undefined behavior in GLSL ES. The
   correct technique is an explicit branch that pushes the position to clip space outside
   the frustum: `if (visible < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }`.

7. **`instanceAddedColor` vec3 for per-instance additive highlight.**
   A new `vec3` per-instance attribute (`instanceAddedColor`) enables highlight coloring
   without rebuilding. The fragment shader adds it to the base color after the group color
   multiply: `gl_FragColor = vec4(color + vAddedColor, alpha)`. A direct-write API
   `updateAddedColor(id, {r,g,b})` writes to the attribute array without a full rebuild.
   This is Phase 3 in the integration-testing plan and can proceed independently of
   picking (Phase 2).

8. **`instancePickingId` pre-allocated as zeros in `_createInstanceMesh()`.**
   The attribute must exist on the geometry before `registerRenderer()` can write it,
   and before the picking mesh (which shares the geometry reference) can access it.
   Pre-allocating zeros in the `!skipPrealloc` block in `_createInstanceMesh()` at line
   216 satisfies both the sync path and the post-`applyPrebuiltBuffers()` registration
   call on the worker path.

9. **`SemanticInfoMap.populate()` called inside flush completion, not once at load.**
   Buffer slot indices (`bufferStartIndex`) shift after any rebuild. The semantic map
   must be rebuilt after every flush that triggers a rebuild. The hook point is the same
   as picking re-registration: at the end of `flush()` and `flushAsync()`.

10. **`PickingSystem` module-level counter uses `window.__glyph3dPickingIdCounter`.**
    Hot-reload resets module-level variables, causing picking ID collisions on re-import.
    Initialize with `this._nextPickingId = (window.__glyph3dPickingIdCounter || 1)` and
    update the window property on each `allocateIds()` call.

11. **Shared geometry + dedicated picking `Scene` — no material swap.**
    Each registered renderer's picking mesh shares the same `InstancedBufferGeometry`
    reference (not cloned) and has its own `ShaderMaterial` with the picking shaders.
    All picking meshes live in a dedicated `this._pickingScene`. The main scene is never
    mutated during the picking pass. This avoids the renderer state mutation risk of
    material-swapping and adds zero geometry memory overhead.

12. **`getRenderer()` accessor added to `GlyphCollection`.**
    `GlyphCollection._renderer` is private. App layer code (and tests) need it to call
    `pickingSystem.registerRenderer()`. A single public getter resolves this:
    `getRenderer() { return this._renderer; }`.

13. **`resolve()` linear scan is acceptable at current scale; binary search is a deferred optimization.**
    At ≤500 renderers (a large repo in github-viewer) the O(N) scan over `_registry`
    costs < 0.01ms at 60fps. A sorted-array binary search is a named follow-on; it must
    not block the initial implementation.

14. **`readAtMouse()` and `renderPickingPass()` consolidated — single render target bind per frame.**
    The Phase 0 code has `renderPickingPass()` ending with `setRenderTarget(null)` and
    `readAtMouse()` re-binding the same target, adding two extra `setRenderTarget` calls
    per frame. The converged implementation reads pixels inside `renderPickingPass()` or
    exposes a combined `renderAndRead(camera)` method. For Phase 0 the double-bind is
    tolerated; it must be fixed before Phase 1 lands.

15. **`onResize()` wired to the canvas resize event at the app layer.**
    `PickingSystem.onResize()` recreates the `WebGLRenderTarget` at the new viewport
    dimensions and resets the mouse pixel coordinate scale. The app render loop must wire
    `window.addEventListener('resize', () => pickingSystem.onResize())`.

---

## Implementation Plan

### New file: `src/picking/PickingSystem.js`

Create this file from scratch. The full skeleton is in phase0-picking-system.md section 9
with the following corrections applied:

**Constructor:**
```js
constructor(threeRenderer, options = {}) {
    this._renderer = threeRenderer;
    this._scale = options.resolutionScale ?? 0.5;
    this._pickingScene = new THREE.Scene();
    this._registry = [];   // { pickingMesh, startId, count, collectionId, glyphRenderer }
    // Persist counter across hot-reload to prevent stale ID collisions
    this._nextPickingId = (window.__glyph3dPickingIdCounter || 1);
    this._readBuffer = new Uint8Array(4);
    this._mousePixel = { x: -1, y: -1 };
    this._target = null;
    this._createTarget();
}
```

**Picking vertex shader constant (inline string in the JS file):**
```glsl
precision highp float;

attribute vec3 instancePosition;
attribute vec2 instanceSize;
attribute float instanceGroupId;
attribute float instancePickingId;

uniform sampler2D groupTexture;
uniform float groupTextureHeight;

varying float vPickingId;

void main() {
    vec3 scaled = position * vec3(instanceSize, 1.0);

    float v = (instanceGroupId + 0.5) / groupTextureHeight;
    vec4 gPos   = texture2D(groupTexture, vec2(0.125, v));
    vec4 gColor = texture2D(groupTexture, vec2(0.625, v));
    vec4 gScale = texture2D(groupTexture, vec2(0.875, v));

    float visible = step(0.01, gColor.a);
    // Push behind clip plane instead of w=0 (w=0 is undefined GLSL)
    if (visible < 0.5) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
    }

    vec3 worldPos = scaled + instancePosition * gScale.xyz + gPos.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
    vPickingId = instancePickingId;
}
```

**Picking fragment shader:**
```glsl
precision highp float;
varying float vPickingId;
void main() {
    float id = vPickingId;
    float r = floor(id / 65536.0);
    float g = floor(mod(id, 65536.0) / 256.0);
    float b = mod(id, 256.0);
    gl_FragColor = vec4(r / 255.0, g / 255.0, b / 255.0, 1.0);
}
```

**`registerRenderer(glyphRenderer, collectionId)`:**
- Look up existing registry block by `glyphRenderer` identity and remove it if present
  (call `unregisterRenderer(glyphRenderer)` first).
- Claim new ID block: `startId = this._nextPickingId; this._nextPickingId += count`.
- Write `window.__glyph3dPickingIdCounter = this._nextPickingId` immediately after.
- Write `instancePickingId` buffer:
  ```js
  const count = glyphRenderer.instanceMesh.geometry.instanceCount;
  const ids = new Float32Array(count);
  for (let i = 0; i < count; i++) ids[i] = startId + i;
  const geom = glyphRenderer.instanceMesh.geometry;
  geom.setAttribute('instancePickingId',
      new THREE.InstancedBufferAttribute(ids, 1));
  ```
- Create picking mesh (shared geometry reference, dedicated ShaderMaterial):
  ```js
  const pickingMat = new THREE.ShaderMaterial({
      uniforms: {
          groupTexture:       { value: glyphRenderer._groupTexture },
          groupTextureHeight: { value: glyphRenderer._maxGroups }
      },
      vertexShader:   PICKING_VERTEX_SHADER,
      fragmentShader: PICKING_FRAGMENT_SHADER,
      side: THREE.DoubleSide
  });
  const pickingMesh = new THREE.Mesh(geom, pickingMat);
  pickingMesh.frustumCulled = false;
  this._pickingScene.add(pickingMesh);
  ```
- Push to registry: `this._registry.push({ pickingMesh, startId, count, collectionId, glyphRenderer })`.

**`unregisterRenderer(glyphRenderer)`:**
```js
unregisterRenderer(glyphRenderer) {
    const idx = this._registry.findIndex(b => b.glyphRenderer === glyphRenderer);
    if (idx === -1) return;
    const block = this._registry[idx];
    this._pickingScene.remove(block.pickingMesh);
    block.pickingMesh.material.dispose();
    this._registry.splice(idx, 1);
}
```
Note: do NOT compact `_nextPickingId` on unregister. ID space is monotonically increasing.
Reclamation is a deferred optimization.

**`renderAndRead(camera)` — consolidated pass:**
```js
renderAndRead(camera) {
    this._renderer.setRenderTarget(this._target);
    this._renderer.setClearColor(0x000000, 1);
    this._renderer.clear();
    this._renderer.render(this._pickingScene, camera);

    const { x, y } = this._mousePixel;
    let id = 0;
    if (x >= 0 && y >= 0) {
        const gl = this._renderer.getContext();
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this._readBuffer);
        const [r, g, b] = this._readBuffer;
        id = (r << 16) | (g << 8) | b;
    }

    this._renderer.setRenderTarget(null);
    return id;
}
```
Keep `renderPickingPass(camera)` and `readAtMouse()` as separate public methods for
callers who need to control the read timing (async PBO path in Phase 1).

**`resolve(pickingId)`:** unchanged from phase0 section 9.

**`resolveGlyph(renderer, slotIndex)`:** unchanged from phase0 section 9.
Walk `renderer.renderedTexts` (a Map). Find the entry where
`slotIndex >= entry.bufferStartIndex && slotIndex < entry.bufferStartIndex + entry.glyphs.length`.

**`setMousePosition(cssX, cssY, rect)`:** unchanged from phase0 section 9.

**`onResize()`:** calls `_createTarget()`. No other state changes needed.

**`_createTarget()`:** unchanged from phase0 section 9 (clamped `Math.max(1, ...)`).

**`dispose()`:** unchanged from phase0 section 9.

---

### Modify: `src/GlyphRenderer.js`

**`_createInstanceMesh()` — add `instancePickingId` pre-allocation (line ~228):**

After the `instanceGroupId` setAttribute call in the `!skipPrealloc` block (currently the
last attribute, line ~228), add:

```js
geometry.setAttribute('instancePickingId',
    new THREE.InstancedBufferAttribute(new Float32Array(maxCount), 1));
```

This pre-allocates zeros. `registerRenderer()` overwrites it post-flush. The zeros are
safe to render before registration (black output to picking target = "no hit").

**`_getVertexShader()` — add `instanceAddedColor` attribute and output (line ~251):**

In the vertex shader string, alongside the other `attribute` declarations (~line 258),
add:
```glsl
attribute vec3 instanceAddedColor;
```

In the vertex shader's varying declarations, add:
```glsl
varying vec3 vAddedColor;
```

At the end of `main()`, before the closing brace, assign:
```glsl
vAddedColor = instanceAddedColor;
```

**`_getFragmentShader()` — blend `vAddedColor` into output (line ~320):**

Add the varying declaration:
```glsl
varying vec3 vAddedColor;
```

Replace the final color output line. Currently (~line 325):
```glsl
gl_FragColor = vec4(vColor, alpha);
```
Change to:
```glsl
gl_FragColor = vec4(vColor + vAddedColor, alpha);
```

**`_createInstanceMesh()` — add `instanceAddedColor` pre-allocation:**

Same location as `instancePickingId` addition above. Add:
```js
geometry.setAttribute('instanceAddedColor',
    new THREE.InstancedBufferAttribute(new Float32Array(maxCount * 3), 3));
```

**`_rebuildAllInstances()` — zero out `instanceAddedColor` on rebuild (line ~1018):**

At the end of `_rebuildAllInstances()`, after setting `geometry.instanceCount`, zero the
`instanceAddedColor` buffer:
```js
const addedColor = geometry.attributes.instanceAddedColor?.array;
if (addedColor) addedColor.fill(0);
if (geometry.attributes.instanceAddedColor) {
    geometry.attributes.instanceAddedColor.needsUpdate = true;
}
```
(Zeroing is necessary because rebuild may have moved glyphs to different slots.)

**`applyPrebuiltBuffers()` — skip `instancePickingId` and zero `instanceAddedColor`:**

In the destructure at line ~1122, do not add `pickingIds`. After the existing buffer
applications, zero `instanceAddedColor`:
```js
const addedColor = geometry.attributes.instanceAddedColor?.array;
if (addedColor) addedColor.fill(0);
if (geometry.attributes.instanceAddedColor) {
    geometry.attributes.instanceAddedColor.needsUpdate = true;
}
```

**New public method: `updateAddedColor(id, color)`:**

```js
/**
 * Set additive highlight color for all glyphs in a text entry.
 * Direct buffer write — no rebuild triggered.
 * @param {number} id - Renderer-internal text ID
 * @param {{ r: number, g: number, b: number }} color
 */
updateAddedColor(id, { r, g, b }) {
    const entry = this.renderedTexts.get(id);
    if (!entry || entry.bufferStartIndex === undefined) return;
    const arr = this.instanceMesh.geometry.attributes.instanceAddedColor?.array;
    if (!arr) return;
    const startIdx = entry.bufferStartIndex;
    for (let i = 0; i < entry.glyphs.length; i++) {
        const base = (startIdx + i) * 3;
        arr[base]     = r;
        arr[base + 1] = g;
        arr[base + 2] = b;
    }
    this.instanceMesh.geometry.attributes.instanceAddedColor.needsUpdate = true;
}
```

**New public method: `setGlyphHighlight(bufferSlotIndex, color)`:**

```js
/**
 * Set additive highlight color for a single glyph by absolute buffer slot index.
 * Required for sub-range token highlighting (Phase 4).
 * @param {number} bufferSlotIndex - Absolute index into the instance buffer
 * @param {{ r: number, g: number, b: number }} color
 */
setGlyphHighlight(bufferSlotIndex, { r, g, b }) {
    const arr = this.instanceMesh.geometry.attributes.instanceAddedColor?.array;
    if (!arr) return;
    const base = bufferSlotIndex * 3;
    arr[base]     = r;
    arr[base + 1] = g;
    arr[base + 2] = b;
    this.instanceMesh.geometry.attributes.instanceAddedColor.needsUpdate = true;
}
```

---

### Modify: `src/collections/GlyphCollection.js`

**Add `getRenderer()` accessor (after the constructor block, line ~65):**

```js
/**
 * Returns the underlying GlyphRenderer instance (created lazily on first flush).
 * @returns {GlyphRendererV15|null}
 */
getRenderer() { return this._renderer; }
```

**Add `_pickingSystem` field and `setPickingSystem()` method:**

```js
// In constructor, after this._renderer = null:
this._pickingSystem = null;

/**
 * Wire a PickingSystem so flush() automatically re-registers this collection.
 * @param {import('../picking/PickingSystem.js').PickingSystem} pickingSystem
 */
setPickingSystem(pickingSystem) {
    this._pickingSystem = pickingSystem;
}
```

**At the end of `flush()` (line ~502, just before `this._dirty = false`):**

```js
if (this._renderer && this._pickingSystem) {
    this._pickingSystem.registerRenderer(this._renderer, this._id);
}
```

**At the end of `flushAsync()` (after `this._dirty = false`, approximately line ~650):**

```js
if (this._renderer && this._pickingSystem) {
    this._pickingSystem.registerRenderer(this._renderer, this._id);
}
```

Both `flush()` and `flushAsync()` must include this call because either path may trigger
`_rebuildAllInstances()` or `applyPrebuiltBuffers()`, both of which invalidate the
previously registered ID block.

---

### Modify: `src/workers/builders/buildBuffers.js`

**Remove any `pickingIdBase` / `pickingIds` code if present.**

Confirm `buildGlyphBuffers()` and `buildBatchBuffers()` return shapes do not include
`pickingIds`. If buffer-pipeline changes landed any `pickingIds` emission, delete those
lines. The return shape should remain:
`{ positions, sizes, uvCoords, colors, groupIds, count, bounds }`.

---

### New file: `src/picking/index.js`

```js
export { PickingSystem } from './PickingSystem.js';
```

---

### No changes to:

- `src/workers/builders/` (builders remain picking-unaware)
- `src/shaders/textVertex.glsl` (the picking shader lives inline in `PickingSystem.js`,
  not in the shared shader directory)
- `src/shaders/textFragment.glsl` (the picking fragment also lives inline)
- `src/core/constants.js` (no new constants needed for Phase 0)

---

### App-layer integration sketch (not a library file — shown for reference only)

```js
// After renderer and scene setup:
const pickingSystem = new PickingSystem(threeRenderer, { resolutionScale: 0.5 });

// Wire resize:
window.addEventListener('resize', () => pickingSystem.onResize());

// Wire mouse (outside pointer lock):
canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    pickingSystem.setMousePosition(e.clientX - rect.left, e.clientY - rect.top, rect);
});

// Wire each GlyphCollection:
glyphCollection.setPickingSystem(pickingSystem);
// flush() will now auto-register

// Render loop:
function animate() {
    requestAnimationFrame(animate);
    const hoverId = pickingSystem.renderAndRead(camera);
    if (hoverId !== lastHoverId) {
        lastHoverId = hoverId;
        const hit = pickingSystem.resolve(hoverId);
        if (hit) {
            const glyph = pickingSystem.resolveGlyph(hit.renderer, hit.slotIndex);
            // glyph: { textId, charIndex }
        }
    }
    threeRenderer.render(mainScene, camera);
}

// Debug: press 'p' to see picking texture fullscreen
const debugPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({
        map: pickingSystem.renderTarget.texture,
        depthTest: false, depthWrite: false
    })
);
debugPlane.renderOrder = 999;
debugPlane.visible = false;
mainScene.add(debugPlane);
document.addEventListener('keydown', e => {
    if (e.key === 'p') debugPlane.visible = !debugPlane.visible;
});
```

---

### Implementation order (within Phase 0)

1. `src/GlyphRenderer.js`: add `instancePickingId` and `instanceAddedColor` attributes to
   `_createInstanceMesh()`. Add `updateAddedColor()` and `setGlyphHighlight()` methods.
   Modify vertex/fragment shaders for `vAddedColor`. Zero `instanceAddedColor` in both
   `_rebuildAllInstances()` and `applyPrebuiltBuffers()`.

2. `src/collections/GlyphCollection.js`: add `getRenderer()`, `setPickingSystem()`, and
   the post-flush registration calls in both `flush()` and `flushAsync()`.

3. `src/picking/PickingSystem.js`: create the file with the corrected vertex shader
   (explicit branch, no w=0), consolidated `renderAndRead()`, `registerRenderer()`/
   `unregisterRenderer()`, `resolve()`, `resolveGlyph()`, `onResize()`.

4. `src/picking/index.js`: barrel export.

5. App layer wiring in one example (recommend `examples/render-test/`) to verify debug
   overlay (press 'p') shows glyph IDs as solid colors before any readback is tested.

---

## Implementer Vote

**Vote: buffer-pipeline agent.**

Rationale: The heaviest work in this plan is inside `GlyphRenderer.js` — pre-allocating
two new attributes in `_createInstanceMesh()`, threading `vAddedColor` through both
shaders, adding the direct-write APIs `updateAddedColor()` and `setGlyphHighlight()`, and
zeroing the added-color buffer on rebuild and on `applyPrebuiltBuffers()`. The buffer-
pipeline Phase 0 document owns all of this work (section 7A–7D), has the correct line
numbers for `GlyphRenderer.js`, and already has the direct-write pattern right. The
`PickingSystem.js` file is a net-new create with a self-contained scope; it does not
require deep familiarity with the buffer layout. The buffer-pipeline agent is closest to
the modified code and is the natural owner of the attribute and shader changes.

# Round 3: integration-testing convergence

## Settled

All points now fully resolved after Round 1. No Round 2 was needed — the cross-reviews reached
consensus on every contested issue.

**1. `gl_InstanceID` replaces `instanceBufferIndex` entirely.**
`instanceBufferIndex` as a CPU-written `InstancedBufferAttribute` should not be created. WebGL 2 /
GLSL ES 3.0 provides `gl_InstanceID` as a free built-in. Writing a redundant 0-1-2-…-N array wastes
40 KB at 10 K instances, requires an extra CPU write per rebuild, and was only proposed because
integration-testing was unaware of the built-in. The Phase 1 self-test must be redesigned around
`instancePickingId`, not `instanceBufferIndex`.

**2. `instancePickingId` is assigned by `PickingSystem.registerRenderer()`, not by workers.**
The worker builder cannot know the global picking ID counter (`PickingSystem._nextPickingId`) at
dispatch time without a round-trip that defeats the purpose of async computation. All three Round 1
reviewers reached the same conclusion independently. Remove `pickingIds` from the return shape of
`buildGlyphBuffers()` and `buildBatchBuffers()` entirely. The buffer for `instancePickingId` is
pre-allocated as zeros in `_createInstanceMesh()` and filled by `registerRenderer()` after flush.

**3. Picking IDs use 24-bit RGB global sequential encoding with registry range lookup.**
Integration-testing's "pickingId in high bits / bufferIndex in low bits" scheme is dropped. It was
underdefined, required either a wider render target or a fragile fixed bit-split, and is redundant
given the registry. A single monotonically increasing `_nextPickingId` counter in `PickingSystem`
assigns globally unique 24-bit IDs. The registry maps `[start, end)` ranges to renderer instances.
On readback, `resolve(rawId)` binary-searches (or scans) the registry — O(renderers), negligible at
typical scene sizes.

**4. `registerRenderer()` is a post-flush lifecycle hook, not a one-time init call.**
Every call to `_rebuildAllInstances()` or `applyPrebuiltBuffers()` discards and rewrites buffer
slot assignments. Any picking IDs written before the rebuild refer to the wrong slots after it.
`registerRenderer()` must run after every flush that rebuilds geometry. This means
`GlyphCollection.flush()` must call `pickingSystem?.unregisterRenderer(renderer)` then
`pickingSystem?.registerRenderer(renderer)` after buffer application completes — both in the sync
and async paths.

**5. `SemanticInfoMap.populate()` must run after every flush, wired to the flush completion callback.**
Identical instability applies to `SemanticInfoMap`: buffer slot indices become stale after any
rebuild. `populate()` is not a one-time load-time call. It must be invoked inside the
`GlyphCollection.flush()` completion path, after `itemMeta` is available.

**6. `w=0` visibility suppression in GLSL is broken; use an explicit branch.**
Setting `gl_Position = vec4(worldPos, 0.0)` triggers a perspective divide by zero — undefined in
GLSL ES. The correct technique for hiding invisible-group glyphs in the picking pass is:
```glsl
float visible = step(0.01, gColor.a);
if (visible < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
```
This pushes the vertex outside clip space without a degenerate w.

**7. `instanceAddedColor` vec3 additive highlight attribute is the highlight mechanism.**
The fragment shader adds it after the base color multiply. Zero value = no change. Updated via a
direct buffer write API (`setGlyphHighlight(bufferSlotIndex, {r,g,b})`) that skips any rebuild.
The attribute is pre-allocated alongside the other five attributes in `_createInstanceMesh()` and
swapped in via `applyPrebuiltBuffers()`.

**8. Phase 1 (instanceBufferIndex) collapses — no separate phase needed.**
The original four-phase plan loses its first phase. The revised phase structure is:
- Phase 1 (was Phase 2): Picking texture — `instancePickingId`, `PickingSystem`, render target
- Phase 2 (was Phase 3): Additive color — `instanceAddedColor`, `setGlyphHighlight()`
- Phase 3 (was Phase 4): SemanticInfoMap + event bus + full hover pipeline

Phase 2 can be developed in parallel with Phase 1 using a hard-coded buffer index stub.

**9. `PickingSystem` lives in `src/picking/PickingSystem.js`; `SemanticInfoMap` lives in `src/semantic/`.**
Picking is independent of semantic annotation and must not be co-located. Picking handles the GPU
readback loop; semantic handles token annotation. They communicate through the `GlyphEventBus`.

**10. `GlyphCollection` needs a public `getRenderer()` accessor.**
`this._renderer` is created lazily on first `flush()` (GlyphCollection.js line 61) and is private.
Without a getter, app code cannot call `pickingSystem.registerRenderer()` after flush.
Add: `getRenderer() { return this._renderer; }` to `GlyphCollection`.

**11. `PickingSystem` needs an `unregisterRenderer()` method.**
When a renderer is rebuilt, its old registry entry holds a stale ID range. Call
`unregisterRenderer(renderer)` before re-registering to compact the registry. Simplest strategy:
remove the entry by renderer identity reference — do not renumber existing registrations.

**12. Resize handling belongs in `PickingSystem.onResize()`.**
The render target must be recreated when the canvas resizes. The app layer wires this once:
`window.addEventListener('resize', () => pickingSystem.onResize())`. Mouse-to-pixel coordinate
mapping also updates on resize.

**13. `window.__glyph3dPickingIdCounter` persists `_nextPickingId` across hot-reload.**
Module-level counters reset to 0 on hot-reload in development, causing stale texels to decode to
the wrong renderer. Initialize with:
```js
this._nextPickingId = (window.__glyph3dPickingIdCounter || 0) + 1;
```
and sync back on every `registerRenderer()` call.

**14. `readAtMouse()` should be deferred to the next frame's loop start.**
Calling `gl.readPixels` immediately after `renderPickingPass()` stalls the GPU. Move readback to
the top of the next frame's render function (read before writing the new picking pass). For hover,
additionally throttle to only re-read when mouse has moved more than a threshold.

**15. The picking pass uses a shared-geometry parallel `THREE.Scene`, not material-swap.**
Each registered renderer gets a paired picking mesh that shares the same
`InstancedBufferGeometry` (no `.clone()`) but uses the picking `ShaderMaterial`. These meshes live
in a dedicated `_pickingScene`. This avoids renderer state mutation and costs zero extra geometry
memory.

---

## Implementation Plan

### Files to Create

#### `src/picking/PickingSystem.js`

New class. No DOM imports. Depends on Three.js (render target, scene, camera).

```js
// src/picking/PickingSystem.js
import * as THREE from 'three';

const PICKING_VERT = `
    precision highp float;
    attribute vec3 instancePosition;
    attribute vec2 instanceSize;
    attribute float instanceGroupId;
    attribute float instancePickingId;

    uniform sampler2D groupTexture;
    uniform float groupTextureHeight;

    varying vec4 vPickingColor;

    void main() {
        float v = (instanceGroupId + 0.5) / groupTextureHeight;
        vec4 gPos   = texture2D(groupTexture, vec2(0.125, v));
        vec4 gColor = texture2D(groupTexture, vec2(0.625, v));
        vec4 gScale = texture2D(groupTexture, vec2(0.875, v));

        float visible = step(0.01, gColor.a);
        if (visible < 0.5) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            return;
        }

        vec3 scaled = position * vec3(instanceSize, 1.0);
        vec3 worldPos = scaled + instancePosition * gScale.xyz + gPos.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);

        // Encode 24-bit pickingId as RGB (id is 1-based; 0 = nothing)
        float id = instancePickingId;
        float r = floor(id / (256.0 * 256.0)) / 255.0;
        float g = floor(mod(id, 256.0 * 256.0) / 256.0) / 255.0;
        float b = mod(id, 256.0) / 255.0;
        vPickingColor = vec4(r, g, b, 1.0);
    }
`;

const PICKING_FRAG = `
    precision highp float;
    varying vec4 vPickingColor;
    void main() { gl_FragColor = vPickingColor; }
`;

export class PickingSystem {
    /**
     * @param {THREE.WebGLRenderer} threeRenderer
     * @param {Object} [options]
     * @param {number} [options.resolutionScale=1.0]
     */
    constructor(threeRenderer, options = {}) {
        this._renderer = threeRenderer;
        this._resolutionScale = options.resolutionScale ?? 1.0;
        this._pickingScene = new THREE.Scene();
        // registry entries: { renderer, mesh, startId, endId (exclusive) }
        this._registry = [];
        // Persist counter across hot-reload
        this._nextPickingId = (window.__glyph3dPickingIdCounter || 0) + 1;
        this._target = null;
        this._readBuffer = new Uint8Array(4);
        this._mouseX = 0;
        this._mouseY = 0;
        this._pendingReadId = 0;  // id read on previous frame, returned this frame
        this._createTarget();
    }

    /** @private */
    _createTarget() {
        const w = Math.floor(window.innerWidth * this._resolutionScale);
        const h = Math.floor(window.innerHeight * this._resolutionScale);
        if (this._target) this._target.dispose();
        this._target = new THREE.WebGLRenderTarget(w, h);
    }

    onResize() { this._createTarget(); }

    setMousePosition(x, y) {
        this._mouseX = Math.floor(x * this._resolutionScale);
        this._mouseY = Math.floor(y * this._resolutionScale);
    }

    /**
     * Register a GlyphRenderer with this picking system.
     * Must be called after every flush that rebuilds geometry.
     * @param {GlyphRendererV15} glyphRenderer
     * @returns {number} startId assigned
     */
    registerRenderer(glyphRenderer) {
        this.unregisterRenderer(glyphRenderer);

        const geom = glyphRenderer.instanceMesh.geometry;
        const count = geom.instanceCount;
        if (count === 0) return 0;

        const startId = this._nextPickingId;
        const endId = startId + count;  // exclusive
        this._nextPickingId = endId;
        window.__glyph3dPickingIdCounter = this._nextPickingId;

        // Fill instancePickingId: startId, startId+1, ..., startId+count-1
        const ids = new Float32Array(count);
        for (let i = 0; i < count; i++) ids[i] = startId + i;
        geom.setAttribute('instancePickingId',
            new THREE.InstancedBufferAttribute(ids, 1));

        // Build picking mesh (shared geometry, dedicated material)
        const mat = new THREE.ShaderMaterial({
            vertexShader: PICKING_VERT,
            fragmentShader: PICKING_FRAG,
            uniforms: {
                groupTexture: { value: glyphRenderer._groupTexture },
                groupTextureHeight: { value: glyphRenderer._maxGroups }
            }
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.frustumCulled = false;
        this._pickingScene.add(mesh);

        this._registry.push({ renderer: glyphRenderer, mesh, startId, endId });
        return startId;
    }

    /**
     * Remove a renderer from the registry and its mesh from the picking scene.
     * @param {GlyphRendererV15} glyphRenderer
     */
    unregisterRenderer(glyphRenderer) {
        const idx = this._registry.findIndex(e => e.renderer === glyphRenderer);
        if (idx === -1) return;
        const entry = this._registry[idx];
        this._pickingScene.remove(entry.mesh);
        entry.mesh.material.dispose();
        this._registry.splice(idx, 1);
    }

    /**
     * Render the picking pass. Call once per frame before reading.
     * @param {THREE.Camera} camera
     */
    renderPickingPass(camera) {
        this._renderer.setRenderTarget(this._target);
        this._renderer.clear();
        this._renderer.render(this._pickingScene, camera);
        this._renderer.setRenderTarget(null);
    }

    /**
     * Read the pixel at the last-set mouse position.
     * Returns 0 if nothing is under the cursor.
     * @returns {number} picking ID (0 = empty)
     */
    readAtMouse() {
        const { _mouseX: x, _mouseY: y } = this;
        const h = this._target.height;
        this._renderer.setRenderTarget(this._target);
        const gl = this._renderer.getContext();
        gl.readPixels(x, h - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this._readBuffer);
        this._renderer.setRenderTarget(null);
        const [r, g, b] = this._readBuffer;
        return (r << 16) | (g << 8) | b;
    }

    /**
     * Resolve a raw picking ID to renderer + buffer slot.
     * @param {number} id
     * @returns {{ renderer: GlyphRendererV15, slotIndex: number } | null}
     */
    resolve(id) {
        if (id === 0) return null;
        for (const entry of this._registry) {
            if (id >= entry.startId && id < entry.endId) {
                return { renderer: entry.renderer, slotIndex: id - entry.startId };
            }
        }
        return null;
    }
}
```

#### `src/semantic/SemanticInfoMap.js`

Pure data structure. No DOM or Three.js imports. Exactly as designed in phase0-integration-testing
section 6, with one addition: `invalidate()` method for pre-rebuild teardown.

```js
// src/semantic/SemanticInfoMap.js

export class SemanticInfo {
    constructor({ tokenType, text, glyphStart, glyphEnd, line, col }) {
        this.tokenType = tokenType;
        this.text = text;
        this.glyphStart = glyphStart;
        this.glyphEnd = glyphEnd;
        this.line = line;
        this.col = col;
    }
}

export class SemanticInfoMap {
    constructor() {
        this._glyphIndex = [];
        this.functions = [];
        this.classes = [];
        this.variables = [];
        this.keywords = [];
        this.strings = [];
        this.comments = [];
    }

    /** O(N tokens). Call after every flush, not once at load. */
    populate(tokens, glyphOffsets) {
        this.invalidate();
        for (const tok of tokens) {
            const info = new SemanticInfo(tok);
            for (let i = tok.glyphStart; i < tok.glyphEnd; i++) {
                this._glyphIndex[i] = info;
            }
            const bucket = this[tok.tokenType + 's'] ?? null;
            if (bucket) bucket.push(info);
        }
    }

    /** Reset all state. Call before a flush that will rebuild buffers. */
    invalidate() {
        this._glyphIndex = [];
        this.functions = [];
        this.classes = [];
        this.variables = [];
        this.keywords = [];
        this.strings = [];
        this.comments = [];
    }

    /** O(1). @param {number} glyphBufferIndex @returns {SemanticInfo|null} */
    lookup(glyphBufferIndex) {
        return this._glyphIndex[glyphBufferIndex] ?? null;
    }

    /** @returns {{ start: number, end: number } | null} */
    getTokenRange(glyphBufferIndex) {
        const info = this.lookup(glyphBufferIndex);
        if (!info) return null;
        return { start: info.glyphStart, end: info.glyphEnd };
    }
}
```

#### `src/semantic/GlyphEvents.js`

```js
// src/semantic/GlyphEvents.js

export const GlyphEventType = {
    HOVER_ENTER: 'glyph:hover:enter',
    HOVER_EXIT:  'glyph:hover:exit',
    CLICK:       'glyph:click',
};

// Event shape for all types:
// { type, bufferSlotIndex, renderer, slotIndex, semanticInfo }
```

#### `src/semantic/GlyphEventBus.js`

```js
// src/semantic/GlyphEventBus.js

export class GlyphEventBus {
    constructor() { this._listeners = new Map(); }

    on(type, fn) {
        if (!this._listeners.has(type)) this._listeners.set(type, new Set());
        this._listeners.get(type).add(fn);
    }

    off(type, fn) { this._listeners.get(type)?.delete(fn); }

    emit(type, event) {
        this._listeners.get(type)?.forEach(fn => fn(event));
    }
}
```

#### `examples/picking-test/index.html` and `examples/picking-test/main.js`

Test page. Load `src/GlyphRenderer.js` source as the text payload. Minimal static camera. Controls
panel with keys `1`–`3` (revised phases, no longer `1`–`4`). Self-test output writes to a DOM
`<pre>`. Include a picking texture debug overlay toggled by `P`.

---

### Files to Modify

#### `src/GlyphRenderer.js`

**A. Add `instanceAddedColor` to `_createInstanceMesh()` pre-allocation block (lines 216–228):**

```js
// After the instanceGroupId setAttribute call at line 227:
geometry.setAttribute('instanceAddedColor',
    new THREE.InstancedBufferAttribute(new Float32Array(maxCount * 3), 3));
geometry.setAttribute('instancePickingId',
    new THREE.InstancedBufferAttribute(new Float32Array(maxCount), 1));
```

**B. Add `instanceAddedColor` fill and `needsUpdate` to `_updateInstanceMesh()` (lines 1055–1085):**

Inside the per-glyph loop (after groupId write at line 1077):
```js
// Added color (highlight) — default 0,0,0
const addedColors = geometry.attributes.instanceAddedColor.array;
addedColors[i * 3]     = g.addedColor ? g.addedColor.r : 0;
addedColors[i * 3 + 1] = g.addedColor ? g.addedColor.g : 0;
addedColors[i * 3 + 2] = g.addedColor ? g.addedColor.b : 0;
```

After the `needsUpdate` block (after line 1085):
```js
geometry.attributes.instanceAddedColor.needsUpdate = true;
```

**C. Add `instanceAddedColor` to `applyPrebuiltBuffers()` (lines 1128–1137):**

After the `instanceGroupId` setAttribute call:
```js
geometry.setAttribute('instanceAddedColor',
    new THREE.InstancedBufferAttribute(
        buffers.addedColors || new Float32Array(count * 3), 3));
geometry.setAttribute('instancePickingId',
    new THREE.InstancedBufferAttribute(new Float32Array(count), 1));
```
Note: `instancePickingId` is always zeros here — `PickingSystem.registerRenderer()` overwrites it.

**D. Add `setGlyphHighlight(bufferSlotIndex, color)` public method:**

Place near the `updateColor()` direct-write methods (around line 850+):
```js
/**
 * Set additive highlight color for a single glyph by buffer slot index.
 * Direct buffer write — no rebuild required.
 * @param {number} bufferSlotIndex - Absolute slot index in the instance buffer
 * @param {{ r: number, g: number, b: number }} color - Additive RGB (0-1). Zero = no change.
 */
setGlyphHighlight(bufferSlotIndex, { r, g, b }) {
    const attr = this.instanceMesh.geometry.attributes.instanceAddedColor;
    if (!attr) return;
    const off = bufferSlotIndex * 3;
    attr.array[off]     = r;
    attr.array[off + 1] = g;
    attr.array[off + 2] = b;
    attr.needsUpdate = true;
}
```

**E. Update `_getVertexShader()` to declare `instanceAddedColor`:**

Add attribute declaration after `instanceGroupId` at line 259:
```glsl
attribute vec3 instanceAddedColor;
```

Add varying after `vGroupAlpha`:
```glsl
varying vec3 vAddedColor;
```

At the end of the vertex `main()`:
```glsl
vAddedColor = instanceAddedColor;
```

**F. Update `_getFragmentShader()` to apply additive color:**

Declare `varying vec3 vAddedColor;` and change the output:
```glsl
varying vec3 vColor;
varying float vGroupAlpha;
varying vec3 vAddedColor;

void main() {
    vec4 texColor = texture2D(atlasTexture, vUV);
    vec3 finalColor = vColor + vAddedColor;
    gl_FragColor = texColor * vec4(finalColor, vGroupAlpha);
    if (gl_FragColor.a < 0.01) discard;
}
```

#### `src/collections/GlyphCollection.js`

**A. Add `getRenderer()` accessor (after line 87, the end of the constructor):**

```js
/** @returns {GlyphRendererV15|null} */
getRenderer() { return this._renderer; }
```

**B. Wire `PickingSystem` re-registration after every flush (both sync and async paths).**

`GlyphCollection` should accept an optional `pickingSystem` reference and a `semanticInfoMap`
reference (or neither — these are opt-in). The cleanest approach is a post-flush callback:

```js
/**
 * Register a callback to run after every successful flush.
 * Receives the renderer reference and itemMeta array.
 * @param {Function} fn - (renderer, itemMeta) => void
 */
onFlush(fn) { this._onFlushCallback = fn; }
```

Then at the end of `flush()` and `flushAsync()` (wherever `applyPrebuiltBuffers` or
`_rebuildAllInstances` completes), call:
```js
this._onFlushCallback?.(this._renderer, itemMeta);
```

This lets the app layer (or `PickingSystem` integration code) do:
```js
collection.onFlush((renderer, _) => {
    pickingSystem.registerRenderer(renderer);
    semanticMap.invalidate();
    // semanticMap.populate(tokens, glyphOffsets) — when token data is available
});
```

#### `src/workers/builders/buildBuffers.js` (and `src/workers/builders/index.js`)

**Remove `pickingIds` from both `buildGlyphBuffers()` and `buildBatchBuffers()` return values.**

If `pickingIds` is currently emitted (check phase0-buffer-pipeline against actual source), delete
that field from the return object and the allocation. Do not add a `pickingIdBase` parameter.
Picking IDs are assigned after the fact by `PickingSystem.registerRenderer()`.

Verify the return shape of `buildBatchBuffers()` in `src/workers/builders/index.js` — ensure it
does not include `pickingIds` in the object destructured by `applyPrebuiltBuffers()`.

---

### Files to Delete

None at this phase. The old `phase0-*` and `round1-*` cross-ref documents are analysis artifacts
and should remain for traceability.

---

### Phase 1 Self-Test (replacing the `instanceBufferIndex` check)

New content for the `examples/picking-test/main.js` Phase 1 test (key `1`):

```js
function testPhase1() {
    const results = [];
    const renderer = grid.getCollection().getRenderer();
    const geom = renderer.instanceMesh.geometry;

    // instancePickingId must exist after registerRenderer()
    const attr = geom.attributes.instancePickingId;
    if (!attr) { results.push('FAIL instancePickingId attribute missing'); return results; }

    // IDs must be non-zero and sequential within the registered range
    const reg = pickingSystem._registry.find(e => e.renderer === renderer);
    if (!reg) { results.push('FAIL renderer not registered'); return results; }

    let ok = true;
    for (let i = 0; i < geom.instanceCount; i++) {
        if (attr.array[i] !== reg.startId + i) { ok = false; break; }
    }
    results.push(ok
        ? `PASS instancePickingId sequential [${reg.startId}, ${reg.endId})`
        : 'FAIL instancePickingId not sequential');
    results.push(`PASS instanceCount=${geom.instanceCount}`);
    return results;
}
```

---

### Render Loop Integration

```js
// In the application's animate() function:

function animate() {
    requestAnimationFrame(animate);

    // Read PREVIOUS frame's picking result (avoids GPU stall in current frame)
    const pickedId = pickingSystem.readAtMouse();
    const hit = pickingSystem.resolve(pickedId);
    if (hit) {
        // hit.renderer, hit.slotIndex — dispatch hover event
    }

    // Render picking pass for THIS frame (result read next frame)
    pickingSystem.renderPickingPass(camera);

    // Render main scene
    threeRenderer.render(mainScene, camera);
}

// Resize wiring
window.addEventListener('resize', () => pickingSystem.onResize());

// Mouse wiring
canvas.addEventListener('mousemove', e => {
    pickingSystem.setMousePosition(e.clientX, e.clientY);
});
```

---

### Attribute count dev-mode guard (in `_createInstanceMesh()`)

Add after the geometry attributes are set:
```js
if (process.env.NODE_ENV !== 'production') {
    const attrNames = Object.keys(geometry.attributes).filter(k => k.startsWith('instance'));
    // Expected: instancePosition, instanceSize, instanceCodepoint, instanceColor,
    //           instanceGroupId, instanceAddedColor, instancePickingId = 7
    console.assert(attrNames.length === 7,
        `[GlyphRenderer] Expected 7 instance attributes, got ${attrNames.length}: ${attrNames}`);
}
```

---

## Implementer Vote

**buffer-pipeline** should implement this plan.

Rationale: The buffer-pipeline agent's Phase 0 document is the closest to the converged design.
It correctly identified `gl_InstanceID`, correctly specified the `instanceAddedColor` attribute
(the only design that described the `setGlyphHighlight()` direct-write API), correctly specified
the `_createInstanceMesh()` pre-allocation block changes, and correctly specified the
`applyPrebuiltBuffers()` backward-compatibility fallback pattern. The implementation work is
centered on `src/GlyphRenderer.js` — buffer attribute management, vertex/fragment shader changes,
and direct-write update APIs — which is exactly the domain buffer-pipeline analyzed most thoroughly.
The picking-system agent's design is now the authority on `PickingSystem.js` internals, but all
of those changes live in the new `src/picking/` file, which buffer-pipeline can implement
straightforwardly given the converged design above. The integration-testing agent's contribution
was primarily the test strategy, the `SemanticInfoMap` design, and the stale-index risk
identification — all of which have been incorporated into the plan, but none of which require
the implementer to be the integration-testing agent.

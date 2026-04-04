# Phase 0: WebGL2 Picking Texture System

Adapts Swift/Metal's `MetalLinkPickingTexture` (R32UI, single-pixel blit, per-instance
`bufferIndex`) for the Three.js/WebGL2 stack. Designed for incremental testing: visual
debug view comes first, readback pipeline second.

---

## 1. Architecture Decision

### Two-Pass vs MRT

**Choice: Two-pass.** A second render pass with a dedicated `WebGLRenderTarget` keeps the
picking shader trivially simple (no texture sampling, no UV math, just pack an ID as
color) and isolates it from every future change to the main shader.

MRT would be cheaper at the GPU but requires WebGL2 draw buffers (`gl_FragData[1]`),
forces both shaders to evolve together, and breaks Three.js's standard render path. The
two-pass cost is one extra draw call per frame, which is acceptable — the picking shader
is far simpler than the main shader, and the geometry is identical.

### Render Target Format

The Swift texture uses `MTLPixelFormat.r32Uint` (a single 32-bit unsigned integer per
pixel). WebGL2 exposes this as `gl.R32UI` but Three.js's `WebGLRenderTarget` does not
support integer render targets through normal means: the standard path calls
`gl.texImage2D` with floating-point or normalised types.

**Pragmatic choice: `RGBA8` / `THREE.UnsignedByteType` with a 24-bit ID packed across
RGB.** This supports 16 million distinct IDs (more than enough for 10,000 instances per
renderer × any expected collection count) and is readable via standard `gl.readPixels`
with `gl.UNSIGNED_BYTE` — no extension needed, works everywhere WebGL2 is supported.

```
pickingId → r = (id >> 16) & 0xFF
           g = (id >> 8)  & 0xFF
           b =  id        & 0xFF
```

Readback reconstructs with `(r << 16) | (g << 8) | b`. Black (0,0,0) means "no glyph".

If > 16M IDs become necessary (unlikely), swap to a `RED` + `FLOAT` target — the
readback path changes but nothing else does.

### Resolution Scaling

The picking target defaults to the same size as the viewport. For large viewports (e.g.
4K displays) a 0.5× scale is acceptable because we only read a single pixel at the
mouse cursor. Add a `pickingResolutionScale` option (default `1.0`, usable at `0.5`)
that scales the target dimensions and the mouse→pixel coordinate conversion.

---

## 2. Picking Shader

The picking vertex shader is a cut-down version of `_getVertexShader()` (GlyphRenderer.js
line 251). It reuses `instancePosition`, `instanceSize`, and `instanceGroupId` to place
quads identically to the main pass. It adds one new per-instance attribute:
`instancePickingId` (float, one value per glyph, equal to buffer slot index + 1).

**Vertex shader:**

```glsl
precision highp float;

attribute vec3 instancePosition;
attribute vec2 instanceSize;
attribute float instanceGroupId;
attribute float instancePickingId;   // buffer slot index + 1

uniform sampler2D groupTexture;
uniform float groupTextureHeight;

varying float vPickingId;

void main() {
    vec3 scaled = position * vec3(instanceSize, 1.0);

    float v = (instanceGroupId + 0.5) / groupTextureHeight;
    vec4 gPos   = texture2D(groupTexture, vec2(0.125, v));
    vec4 gColor = texture2D(groupTexture, vec2(0.625, v));
    vec4 gScale = texture2D(groupTexture, vec2(0.875, v));

    // Hide invisible groups (gColor.a == 0 means visibility off)
    // Push behind clip plane so they don't write to picking buffer.
    float visible = step(0.01, gColor.a);

    vec3 worldPos = scaled + instancePosition * gScale.xyz + gPos.xyz;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, visible);
    vPickingId = instancePickingId;
}
```

The `visible` trick replaces the `discard` in the fragment shader (cheaper — discarded
fragments still touch the fragment stage; a w=0 vertex collapses the triangle).

**Fragment shader:**

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

No atlas texture sampling. No UV varyings. No alpha test.

---

## 3. Render Target Setup

```javascript
// src/picking/PickingSystem.js

import * as THREE from 'three';

export class PickingSystem {
    constructor(renderer, options = {}) {
        this._renderer = renderer;
        this._scale = options.resolutionScale || 1.0;
        this._target = null;
        this._readBuffer = new Uint8Array(4); // RGBA for one pixel
        this._createTarget();

        // Pixel coords updated on each mousemove
        this._mousePixel = { x: 0, y: 0 };
    }

    _createTarget() {
        const size = this._renderer.getSize(new THREE.Vector2());
        const w = Math.floor(size.x * this._scale);
        const h = Math.floor(size.y * this._scale);

        if (this._target) this._target.dispose();

        this._target = new THREE.WebGLRenderTarget(w, h, {
            format: THREE.RGBAFormat,
            type: THREE.UnsignedByteType,
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            generateMipmaps: false,
            depthBuffer: true,
            stencilBuffer: false
        });
    }

    onResize() {
        this._createTarget();
    }

    get renderTarget() { return this._target; }
}
```

Three.js manages depth testing automatically when `depthBuffer: true` is set — the same
depth ordering as the main pass applies, so occluded glyphs correctly lose to front-most
glyphs.

---

## 4. Readback Pipeline

### Mouse event → pixel coordinate

InputManager.js (line 81) currently only captures pointer-lock deltas, not raw screen
coordinates. The picking system needs absolute canvas-relative coordinates. These come
from a separate `mousemove` listener on the canvas element (outside pointer lock):

```javascript
canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;

    // Convert CSS pixels → render target pixels (accounts for devicePixelRatio + scale)
    const dpr = window.devicePixelRatio || 1;
    this._mousePixel.x = Math.floor(cssX * dpr * this._scale);
    // WebGL Y is flipped vs DOM
    this._mousePixel.y = Math.floor((rect.height - cssY) * dpr * this._scale);
});
```

### Per-frame readback

Call after the picking pass renders but before the main pass:

```javascript
readAtMouse() {
    const { x, y } = this._mousePixel;
    const gl = this._renderer.getContext();

    this._renderer.setRenderTarget(this._target);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this._readBuffer);
    this._renderer.setRenderTarget(null);

    const r = this._readBuffer[0];
    const g = this._readBuffer[1];
    const b = this._readBuffer[2];
    const id = (r << 16) | (g << 8) | b;
    return id; // 0 = background, >0 = picking ID
}
```

`gl.readPixels` is synchronous and stalls the GPU pipeline if called immediately after
render. See section 8 for async mitigation.

### ID → glyph identity

The picking ID equals `bufferSlotIndex + 1` (1-based so 0 means "no hit"). The
`PickingSystem` holds a registry that maps renderer instance → ID range:

```javascript
// Each GlyphRenderer registers its ID block after applyPrebuiltBuffers / _rebuildAllInstances
pickingSystem.registerRenderer(renderer, collectionId, {
    startId: renderer._pickingIdOffset,   // first picking ID for this renderer
    count:   geometry.instanceCount,
    renderer,
    collectionId   // which GlyphCollection owns this renderer
});
```

Resolving a hit:

```javascript
resolve(pickingId) {
    for (const block of this._registry) {
        if (pickingId >= block.startId && pickingId < block.startId + block.count) {
            const slotIndex = pickingId - block.startId; // 0-based slot within renderer
            return {
                renderer: block.renderer,
                collectionId: block.collectionId,
                slotIndex   // index into instancePosition/instanceColor arrays
            };
        }
    }
    return null;
}
```

`slotIndex` → text entry and character: in `_rebuildAllInstances` (GlyphRenderer.js line
1018), `entry.bufferStartIndex` is the first slot for a given text. Walk
`renderedTexts` to find which entry contains `slotIndex` and which glyph within it
(`slotIndex - entry.bufferStartIndex`).

---

## 5. Multi-Collection Picking

Each `GlyphCollection` owns exactly one `GlyphRendererV15` instance (created lazily in
`flush()`, held at `this._renderer`, line ~61 of GlyphCollection.js). Each renderer has
its own `InstancedBufferGeometry` and its own ID space.

The picking system uses a **global ID offset counter**. Before each renderer writes its
`instancePickingId` buffer it claims a contiguous block:

```javascript
// Pseudo-code inside PickingSystem.allocateIds(count):
const start = this._nextPickingId;
this._nextPickingId += count;
return start; // renderer writes ids: start+1 .. start+count (1-based per-slot)
```

Each renderer stores `this._pickingIdOffset = start` and writes
`instancePickingId[i] = start + i + 1` during `_rebuildAllInstances` / `applyPrebuiltBuffers`.

The picking render pass iterates `this._registeredRenderers` — an array of
`{ mesh, material }` pairs — and renders each with the picking material substituted for
the normal material, using `renderer.renderBufferDirect` or by temporarily swapping
`mesh.material`.

**Simpler approach** (recommended for phase 0): build a parallel picking `Mesh` per
renderer that shares the same `InstancedBufferGeometry` (read-only geometry reference,
not cloned) but uses the picking `ShaderMaterial`. Add all picking meshes to a dedicated
picking `Scene`. Render that scene to the picking `RenderTarget`. The shared geometry
means no extra memory for geometry data — only one extra `ShaderMaterial` per renderer.

---

## 6. Debug Visualization

Before the readback pipeline exists, verify the picking texture visually by blitting it
to the screen as a fullscreen quad.

```javascript
// Add a debug overlay plane to the main scene
class PickingDebugOverlay {
    constructor(pickingSystem) {
        const geo = new THREE.PlaneGeometry(2, 2);
        const mat = new THREE.MeshBasicMaterial({
            map: pickingSystem.renderTarget.texture,
            depthTest: false,
            depthWrite: false
        });
        this.mesh = new THREE.Mesh(geo, mat);
        this.mesh.renderOrder = 999;
        this.mesh.visible = false;

        // Fullscreen in NDC: camera-independent orthographic
        this.mesh.onBeforeRender = (renderer) => {
            // Ensure it renders in front of everything
        };
    }

    show() { this.mesh.visible = true; }
    hide() { this.mesh.visible = false; }
}
```

When `debugOverlay.show()` is called, every glyph should appear as a unique solid color
(no texture, no anti-aliasing) and the background is black. Glyphs in the same
`GlyphCollection` will have similar hues (their IDs are contiguous). Invisible groups
(visibility=0) should be black — verifying the vertex shader's visibility suppression
before readback is wired up.

---

## 7. Integration Points

| Location | Change |
|---|---|
| `GlyphRenderer.js` `_createInstanceMesh()` (line 173) | Add `instancePickingId` InstancedBufferAttribute alongside the five existing attributes |
| `GlyphRenderer.js` `_rebuildAllInstances()` (line 1018) | After computing `bufferStartIndex`, write `instancePickingId[bufferStartIndex + i] = this._pickingIdOffset + bufferStartIndex + i + 1` |
| `GlyphRenderer.js` `applyPrebuiltBuffers()` | Accept `pickingIds` Float32Array from worker batch output and set as `instancePickingId` attribute |
| `GlyphCollection.js` `flush()` | After renderer is created/reused, call `pickingSystem.registerRenderer(renderer, this._id)` |
| Render loop (app layer) | Before main render: `pickingSystem.renderPickingPass(camera); const hoverId = pickingSystem.readAtMouse();` |
| `InputManager.js` | Add `mousemove` listener that stores raw canvas-relative coordinates (separate from pointer-lock movement) |

The `PickingSystem` is a singleton passed down from the app layer — it does not live
inside `GlyphRenderer` or `GlyphCollection`. Those classes register with it; they do not
own it.

---

## 8. Performance

### Readback frequency

`gl.readPixels` synchronously stalls the GPU. On a typical desktop this costs 0.1–0.5ms
per call. Options:

1. **Throttle to ~30Hz**: only read on every other frame, or only when the mouse has
   moved more than 2 pixels since the last read.
2. **Async PBO (preferred for phase 1)**: use `gl.getBufferSubData` with a
   `PIXEL_PACK_BUFFER` and a fence sync. Issue the readback at end of frame N; read the
   result at start of frame N+2. This hides the stall entirely but adds 2-frame latency,
   which is imperceptible for hover highlights.

For phase 0, throttling to mousemove events (fire rate already limited by the browser to
~60/s) is sufficient.

### Picking pass cost

The picking shader does zero texture samples. With 10,000 instances the picking pass
budget is roughly equivalent to the main pass minus texture sampling — typically < 0.5ms
on integrated graphics.

### Picking target size

At 0.5× resolution the target is 4× smaller in memory and the pass fills 4× fewer
pixels. Since only one pixel is ever read, sub-pixel accuracy is irrelevant. Recommend
starting at 0.5× and testing whether glyph IDs are stable at that resolution (they
should be — glyphs are several pixels wide at normal viewing distance).

---

## 9. Code Sketches

### `src/picking/PickingSystem.js` skeleton

```javascript
import * as THREE from 'three';

const PICKING_VERTEX_SHADER = `/* ... see section 2 ... */`;
const PICKING_FRAGMENT_SHADER = `/* ... see section 2 ... */`;

export class PickingSystem {
    constructor(threeRenderer, options = {}) {
        this._renderer = threeRenderer;
        this._scale = options.resolutionScale || 0.5;
        this._pickingScene = new THREE.Scene();
        this._registry = [];          // { mesh, startId, count, collectionId, renderer }
        this._nextPickingId = 1;
        this._readBuffer = new Uint8Array(4);
        this._mousePixel = { x: 0, y: 0 };
        this._target = null;
        this._createTarget();
    }

    /**
     * Called once per GlyphRenderer after its buffers are built.
     * @param {GlyphRendererV15} glyphRenderer
     * @param {string|number} collectionId
     */
    registerRenderer(glyphRenderer, collectionId) {
        const count = glyphRenderer.instanceMesh.geometry.instanceCount;
        const startId = this._nextPickingId;
        this._nextPickingId += count;
        glyphRenderer._pickingIdOffset = startId - 1; // slots are 1-based within offset

        // Build instancePickingId buffer
        const ids = new Float32Array(count);
        for (let i = 0; i < count; i++) ids[i] = startId + i;
        const geom = glyphRenderer.instanceMesh.geometry;
        geom.setAttribute('instancePickingId',
            new THREE.InstancedBufferAttribute(ids, 1));

        // Parallel picking mesh (shares geometry, dedicated material)
        const pickingMat = new THREE.ShaderMaterial({
            uniforms: {
                groupTexture:       { value: glyphRenderer._groupTexture },
                groupTextureHeight: { value: glyphRenderer._maxGroups }
            },
            vertexShader: PICKING_VERTEX_SHADER,
            fragmentShader: PICKING_FRAGMENT_SHADER,
            side: THREE.DoubleSide
        });
        const pickingMesh = new THREE.Mesh(geom, pickingMat);
        pickingMesh.frustumCulled = false;
        this._pickingScene.add(pickingMesh);

        this._registry.push({ pickingMesh, startId, count, collectionId, glyphRenderer });
    }

    /**
     * Render picking pass. Call before main render each frame.
     * @param {THREE.Camera} camera
     */
    renderPickingPass(camera) {
        this._renderer.setRenderTarget(this._target);
        this._renderer.setClearColor(0x000000, 1);
        this._renderer.clear();
        this._renderer.render(this._pickingScene, camera);
        this._renderer.setRenderTarget(null);
    }

    /**
     * Read picking ID at current mouse position.
     * @returns {number} 0 = background, >0 = picking ID
     */
    readAtMouse() {
        const { x, y } = this._mousePixel;
        if (x < 0 || y < 0) return 0;

        const gl = this._renderer.getContext();
        this._renderer.setRenderTarget(this._target);
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this._readBuffer);
        this._renderer.setRenderTarget(null);

        const [r, g, b] = this._readBuffer;
        return (r << 16) | (g << 8) | b;
    }

    /**
     * Resolve a picking ID to { collectionId, renderer, slotIndex }.
     * @param {number} pickingId
     * @returns {Object|null}
     */
    resolve(pickingId) {
        if (pickingId === 0) return null;
        for (const block of this._registry) {
            if (pickingId >= block.startId &&
                pickingId < block.startId + block.count) {
                return {
                    collectionId: block.collectionId,
                    renderer:     block.glyphRenderer,
                    slotIndex:    pickingId - block.startId  // 0-based
                };
            }
        }
        return null;
    }

    /**
     * Resolve slotIndex within a GlyphRendererV15 to { textId, charIndex }.
     * Walks renderedTexts by bufferStartIndex.
     * @param {GlyphRendererV15} renderer
     * @param {number} slotIndex
     * @returns {{ textId: number, charIndex: number }|null}
     */
    resolveGlyph(renderer, slotIndex) {
        for (const [textId, entry] of renderer.renderedTexts) {
            const start = entry.bufferStartIndex;
            const end   = start + entry.glyphs.length;
            if (slotIndex >= start && slotIndex < end) {
                return { textId, charIndex: slotIndex - start };
            }
        }
        return null;
    }

    setMousePosition(canvasX, canvasY, canvasRect) {
        const dpr = window.devicePixelRatio || 1;
        this._mousePixel.x = Math.floor(canvasX * dpr * this._scale);
        this._mousePixel.y = Math.floor(
            (canvasRect.height - canvasY) * dpr * this._scale
        );
    }

    onResize() { this._createTarget(); }

    _createTarget() {
        const size = this._renderer.getSize(new THREE.Vector2());
        const w = Math.max(1, Math.floor(size.x * this._scale));
        const h = Math.max(1, Math.floor(size.y * this._scale));
        if (this._target) this._target.dispose();
        this._target = new THREE.WebGLRenderTarget(w, h, {
            format:           THREE.RGBAFormat,
            type:             THREE.UnsignedByteType,
            minFilter:        THREE.NearestFilter,
            magFilter:        THREE.NearestFilter,
            generateMipmaps:  false,
            depthBuffer:      true
        });
    }

    dispose() {
        this._target?.dispose();
        this._pickingScene.clear();
        this._registry = [];
    }
}
```

### Render loop integration (app layer)

```javascript
// After scene setup, create the system:
const pickingSystem = new PickingSystem(threeRenderer, { resolutionScale: 0.5 });

// Wire mouse:
canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    pickingSystem.setMousePosition(e.clientX - rect.left, e.clientY - rect.top, rect);
});

// In the render loop:
function animate() {
    requestAnimationFrame(animate);

    pickingSystem.renderPickingPass(camera);

    const pickingId = pickingSystem.readAtMouse();
    if (pickingId !== lastPickingId) {
        lastPickingId = pickingId;
        const hit = pickingSystem.resolve(pickingId);
        if (hit) {
            const glyph = pickingSystem.resolveGlyph(hit.renderer, hit.slotIndex);
            // glyph = { textId, charIndex } → look up in hit.renderer.renderedTexts
        }
    }

    threeRenderer.render(mainScene, camera);
}
```

### Debug overlay (phase 0 testing)

```javascript
// Toggle with a keyboard shortcut:
const debugOverlay = new PickingDebugOverlay(pickingSystem);
mainScene.add(debugOverlay.mesh);

document.addEventListener('keydown', (e) => {
    if (e.key === 'p') debugOverlay.mesh.visible = !debugOverlay.mesh.visible;
});
```

Press `p` to see the picking texture fullscreen. Each glyph should be a solid color
encoding its ID. The background is black. Invisible groups are black. This validates the
full picking vertex/fragment path before a single `readPixels` call is made.

---

## Swift Mapping Summary

| Swift | JS equivalent |
|---|---|
| `MTLPixelFormat.r32Uint` | `THREE.RGBAFormat + UnsignedByteType` (24-bit ID in RGB) |
| `blitEncoder.copy(from:to:)` | `gl.readPixels()` directly into `Uint8Array` |
| `pickingHover.send(currentHover)` | `EventEmitter` or direct callback on `PickingSystem` |
| `attachPickingStream(to: grid)` | `pickingSystem.registerRenderer(renderer, collectionId)` |
| Two textures (glyph + grid) | Single texture; grid resolved by ID range in registry |
| `InstanceIDType.memStride` | 4 bytes (`Uint8Array(4)`) |
| `bufferIndex` per-instance constant | `instancePickingId` per-instance attribute |

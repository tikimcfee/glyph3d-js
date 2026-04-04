/**
 * PickingSystem - GPU-based glyph picking via material-swap on the main scene.
 *
 * Renders the SAME scene to an offscreen target with picking materials swapped
 * onto each registered glyph mesh. Since the meshes stay in the main scene graph
 * with their real transforms, no transform syncing is needed — the picking pass
 * is a pixel-perfect mirror of the visible render, just with ID-encoded colors
 * instead of textured glyphs.
 *
 * This matches the Swift/Metal approach: one scene, one render, read the pixel.
 *
 * Picking IDs are 24-bit sequential integers encoded as RGB. Black (0,0,0) = "no hit".
 * The global counter persists across hot-reloads via window.__glyph3dPickingIdCounter.
 */

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Picking shaders — two modes:
//   'cell'  (default) — solid quad, entire glyph cell is pickable
//   'glyph'           — Slug winding number coverage, only rendered strokes pick
// ---------------------------------------------------------------------------

// Shared vertex core — position + group visibility
const PICKING_VERTEX_CORE = `
precision highp float;

in vec3 instancePosition;
in vec2 instanceSize;
in float instanceGroupId;

uniform sampler2D groupTexture;
uniform float groupTextureHeight;
uniform int uBasePickingId;
`;

// Cell mode: solid quads, no atlas sampling
const PICKING_VERTEX_CELL = PICKING_VERTEX_CORE + `
flat out int vPickingId;

void main() {
    vec3 scaled = position * vec3(instanceSize, 1.0);
    vec3 alignOffset = vec3(instanceSize.x * 0.5, 0.0, 0.0);

    float v = (instanceGroupId + 0.5) / groupTextureHeight;
    vec4 gPos   = texture(groupTexture, vec2(0.125, v));
    vec4 gColor = texture(groupTexture, vec2(0.625, v));
    vec4 gScale = texture(groupTexture, vec2(0.875, v));

    float visible = step(0.01, gColor.a);
    if (visible < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

    vec3 worldPos = scaled + alignOffset + instancePosition * gScale.xyz + gPos.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
    vPickingId = uBasePickingId + gl_InstanceID;
}
`;

const PICKING_FRAGMENT_CELL = `
precision highp float;
flat in int vPickingId;
out vec4 fragColor;
void main() {
    int id = vPickingId;
    int r = (id >> 16) & 0xFF;
    int g = (id >> 8) & 0xFF;
    int b = id & 0xFF;
    fragColor = vec4(float(r) / 255.0, float(g) / 255.0, float(b) / 255.0, 1.0);
}
`;

// Glyph mode: Slug vector coverage test — only rendered strokes pick
const PICKING_VERTEX_GLYPH = PICKING_VERTEX_CORE + `
in float instanceGlyphId;

uniform highp usampler2D glyphMapTexture;
uniform float glyphMapWidth;
uniform float glyphMapHeight;

flat out int vPickingId;
flat out int vCurveStart;
flat out int vCurveCount;
flat out int vBandHeaderStart;
flat out int vBandCount;
out vec2 vGlyphUV;

void main() {
    vec3 scaled = position * vec3(instanceSize, 1.0);
    vec3 alignOffset = vec3(instanceSize.x * 0.5, 0.0, 0.0);

    float v = (instanceGroupId + 0.5) / groupTextureHeight;
    vec4 gPos   = texture(groupTexture, vec2(0.125, v));
    vec4 gColor = texture(groupTexture, vec2(0.625, v));
    vec4 gScale = texture(groupTexture, vec2(0.875, v));

    float visible = step(0.01, gColor.a);
    if (visible < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

    vec3 worldPos = scaled + alignOffset + instancePosition * gScale.xyz + gPos.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
    vPickingId = uBasePickingId + gl_InstanceID;

    int gid = int(instanceGlyphId);
    int mapCol = gid % int(glyphMapWidth);
    int mapRow = gid / int(glyphMapWidth);
    uvec4 glyphInfo = texelFetch(glyphMapTexture, ivec2(mapCol, mapRow), 0);
    vCurveStart      = int(glyphInfo.x);
    vCurveCount      = int(glyphInfo.y);
    vBandHeaderStart = int(glyphInfo.z);
    vBandCount       = int(glyphInfo.w);
    vGlyphUV = uv;
}
`;

const PICKING_FRAGMENT_GLYPH = `
precision highp float;
precision highp int;

#define MAX_BANDS 16
#define MAX_CURVES_PER_BAND 64

uniform highp usampler2D curveTexture;
uniform highp usampler2D bandTexture;

flat in int vPickingId;
flat in int vCurveStart;
flat in int vCurveCount;
flat in int vBandHeaderStart;
flat in int vBandCount;
in vec2 vGlyphUV;

out vec4 fragColor;

float unpackCoord(uint bits) { return float(bits) / 65535.0; }

int windingContrib(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
    vec2 a = p0 - p, b = p1 - p, c = p2 - p;
    float A = a.y - 2.0 * b.y + c.y;
    float B = a.y - b.y;
    float C = a.y;
    int w = 0;
    if (abs(A) < 1e-7) {
        if (abs(B) < 1e-7) return 0;
        float t = C / (2.0 * B);
        if (t < 0.0 || t > 1.0) return 0;
        float x = (1.0-t)*(1.0-t)*a.x + 2.0*t*(1.0-t)*b.x + t*t*c.x;
        if (x < 0.0) return 0;
        float dy = 2.0*((b.y-a.y)*(1.0-t) + (c.y-b.y)*t);
        return (dy > 0.0) ? 1 : -1;
    }
    float disc = B*B - A*C;
    if (disc < 0.0) return 0;
    float sqrtDisc = sqrt(disc);
    for (int k = 0; k < 2; k++) {
        float t = (k == 0) ? (B - sqrtDisc)/A : (B + sqrtDisc)/A;
        if (t < 0.0 || t > 1.0) continue;
        float x = (1.0-t)*(1.0-t)*a.x + 2.0*t*(1.0-t)*b.x + t*t*c.x;
        if (x < 0.0) continue;
        float dy = 2.0*((b.y-a.y)*(1.0-t) + (c.y-b.y)*t);
        w += (dy > 0.0) ? 1 : -1;
    }
    return w;
}

void main() {
    if (vCurveCount == 0 || vBandCount == 0) discard;

    vec2 p = vGlyphUV;
    int bandIdx = clamp(int(p.y * float(vBandCount)), 0, vBandCount - 1);
    int hdrTexel = vBandHeaderStart + bandIdx;
    uvec4 hdr = texelFetch(bandTexture, ivec2(hdrTexel % 1024, hdrTexel / 1024), 0);
    int entryStart = int(hdr.x);
    int entryCount = int(hdr.y);
    int winding = 0;

    for (int i = 0; i < MAX_CURVES_PER_BAND; i++) {
        if (i >= entryCount) break;
        int entryTexel = entryStart + i;
        uvec4 entry = texelFetch(bandTexture, ivec2(entryTexel % 1024, entryTexel / 1024), 0);
        int localCurveIdx = int(entry.x);
        int ci = (vCurveStart + localCurveIdx) * 2;
        uvec4 t0 = texelFetch(curveTexture, ivec2(ci % 1024, ci / 1024), 0);
        uvec4 t1 = texelFetch(curveTexture, ivec2((ci+1) % 1024, (ci+1) / 1024), 0);
        vec2 cp0 = vec2(unpackCoord(t0.x), unpackCoord(t0.y));
        vec2 cp1 = vec2(unpackCoord(t0.z), unpackCoord(t0.w));
        vec2 cp2 = vec2(unpackCoord(t1.x), unpackCoord(t1.y));
        float minX = min(cp0.x, min(cp1.x, cp2.x));
        if (minX > p.x) break;
        winding += windingContrib(p, cp0, cp1, cp2);
    }

    if (winding == 0) discard;

    int id = vPickingId;
    int r = (id >> 16) & 0xFF;
    int g = (id >> 8) & 0xFF;
    int b = id & 0xFF;
    fragColor = vec4(float(r) / 255.0, float(g) / 255.0, float(b) / 255.0, 1.0);
}
`;

// ---------------------------------------------------------------------------

export class PickingSystem {
    /**
     * @param {THREE.WebGLRenderer} threeRenderer
     * @param {Object} [options]
     * @param {number} [options.resolutionScale=1.0]
     */
    /**
     * @param {THREE.WebGLRenderer} threeRenderer
     * @param {Object} [options]
     * @param {number} [options.resolutionScale=1.0]
     * @param {'cell'|'glyph'} [options.mode='cell'] - 'cell' picks the full glyph quad,
     *   'glyph' alpha-tests against the atlas so only rendered strokes pick.
     */
    constructor(threeRenderer, options = {}) {
        this._renderer = threeRenderer;
        this._scale = options.resolutionScale ?? 1.0;
        this._mode = options.mode ?? 'cell';

        // Registry: [{ renderer, pickingMaterial, startId, endId }]
        this._registry = [];

        // Persist counter across hot-reload
        this._nextPickingId = (window.__glyph3dPickingIdCounter || 1);

        // Picking target and readback buffer
        this._target = null;
        this._readBuffer = new Uint8Array(4);
        this._sizeVec = new THREE.Vector2(); // reusable for getSize()

        // Mouse position in target-pixel coordinates
        this._mousePixel = { x: -1, y: -1 };

        // Dirty flag — only render+read when mouse has moved
        this._needsPick = false;
        this._lastPickedId = 0;

        this._createTarget();
    }

    // -------------------------------------------------------------------------
    // Target management
    // -------------------------------------------------------------------------

    /**
     * Recreate the offscreen render target after a WebGL context restore.
     * Call this from the renderer's contextrestored handler.
     */
    onContextRestored() {
        if (this._target) {
            this._target.dispose();
            this._target = null;
        }
        this._createTarget();
        // Invalidate last pick so the next frame forces a fresh read.
        this._needsPick = true;
        this._lastPickedId = 0;
    }

    /** @private */
    _createTarget() {
        // Match the main canvas drawing buffer dimensions (CSS size × DPR)
        // so the picking pass renders at the exact same resolution as the
        // visible scene. With fractional DPR, rendering at CSS-only size
        // causes sub-pixel misalignment that shifts picks by characters.
        const size = this._renderer.getSize(new THREE.Vector2());
        const dpr = this._renderer.getPixelRatio();
        const w = Math.max(1, Math.floor(size.x * dpr * this._scale));
        const h = Math.max(1, Math.floor(size.y * dpr * this._scale));
        if (this._target) this._target.dispose();
        this._target = new THREE.WebGLRenderTarget(w, h, {
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            type: THREE.UnsignedByteType
        });
    }

    onResize() {
        this._createTarget();
    }

    // -------------------------------------------------------------------------
    // Mouse position
    // -------------------------------------------------------------------------

    setMousePosition(cssX, cssY) {
        // Scale CSS coordinates to match the DPR-sized picking target.
        const dpr = this._renderer.getPixelRatio();
        const newX = Math.floor(cssX * dpr * this._scale);
        const newY = Math.floor(cssY * dpr * this._scale);
        if (newX !== this._mousePixel.x || newY !== this._mousePixel.y) {
            this._mousePixel = { x: newX, y: newY };
            this._needsPick = true;
        }
        if (this._debug) {
            const size = this._renderer.getSize(this._sizeVec);
            console.log(`[pick] css=(${cssX.toFixed(1)}, ${cssY.toFixed(1)}) → pixel=(${newX}, ${newY})  target=${this._target?.width}×${this._target?.height}  renderer=${size.x}×${size.y}  dpr=${dpr}  scale=${this._scale}`);
        }
    }

    // -------------------------------------------------------------------------
    // Registration
    // -------------------------------------------------------------------------

    /**
     * Register a GlyphRenderer with this picking system.
     * Claims a contiguous block of picking IDs and creates a picking
     * ShaderMaterial with uBasePickingId uniform. The picking shader
     * derives per-glyph IDs as uBasePickingId + gl_InstanceID.
     *
     * Must be called after every flush that rebuilds geometry.
     *
     * @param {import('../GlyphRenderer.js').default} glyphRenderer
     * @returns {number} The startId assigned (0 if empty)
     */
    registerRenderer(glyphRenderer) {
        this.unregisterRenderer(glyphRenderer);

        const mesh = glyphRenderer.instanceMesh;
        if (!mesh?.geometry) return 0;
        const count = mesh.geometry.instanceCount;
        if (count === 0) return 0;

        const startId = this._nextPickingId;
        const endId = startId + count;

        this._nextPickingId = endId;
        window.__glyph3dPickingIdCounter = this._nextPickingId;

        // Create picking material based on mode
        const uniforms = {
            groupTexture:       { value: glyphRenderer._groupTexture },
            groupTextureHeight: { value: glyphRenderer._maxGroups },
            uBasePickingId:     { value: startId },
        };

        let vertShader, fragShader;
        if (this._mode === 'glyph') {
            // Glyph mode: Slug winding number coverage — only strokes pick
            const mainUniforms = mesh.material.uniforms;
            uniforms.curveTexture    = mainUniforms.curveTexture;
            uniforms.bandTexture     = mainUniforms.bandTexture;
            uniforms.glyphMapTexture = mainUniforms.glyphMapTexture;
            uniforms.glyphMapWidth   = mainUniforms.glyphMapWidth;
            uniforms.glyphMapHeight  = mainUniforms.glyphMapHeight;
            vertShader = PICKING_VERTEX_GLYPH;
            fragShader = PICKING_FRAGMENT_GLYPH;
        } else {
            // Cell mode (default): solid quads — full cell is pickable
            vertShader = PICKING_VERTEX_CELL;
            fragShader = PICKING_FRAGMENT_CELL;
        }

        const pickingMaterial = new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3,
            uniforms,
            vertexShader: vertShader,
            fragmentShader: fragShader,
            side: THREE.DoubleSide
        });

        this._registry.push({ renderer: glyphRenderer, pickingMaterial, startId, endId });
        return startId;
    }

    /**
     * Remove a renderer from the registry.
     * @param {import('../GlyphRenderer.js').default} glyphRenderer
     */
    unregisterRenderer(glyphRenderer) {
        const idx = this._registry.findIndex(e => e.renderer === glyphRenderer);
        if (idx === -1) return;
        const entry = this._registry[idx];
        entry.pickingMaterial.dispose();
        this._registry.splice(idx, 1);
    }

    // -------------------------------------------------------------------------
    // Render pass — material swap on the main scene
    // -------------------------------------------------------------------------

    /**
     * Render the picking pass to the offscreen target and restore state.
     * Does not read the pixel — call readPixelAsync() after this.
     *
     * @private
     * @param {THREE.Camera} camera
     * @param {THREE.Scene} scene
     * @returns {number} t0 timestamp (performance.now() before render)
     */
    _renderPickingPass(camera, scene) {
        // Auto-resize target if renderer size changed (e.g. IDE ResizeObserver)
        const size = this._renderer.getSize(this._sizeVec);
        const dpr = this._renderer.getPixelRatio();
        const tw = Math.max(1, Math.floor(size.x * dpr * this._scale));
        const th = Math.max(1, Math.floor(size.y * dpr * this._scale));
        if (!this._target || this._target.width !== tw || this._target.height !== th) {
            this._createTarget();
        }

        const t0 = performance.now();

        // Swap materials: main → picking
        for (const entry of this._registry) {
            const mesh = entry.renderer.instanceMesh;
            if (!mesh) continue;
            entry._savedMaterial = mesh.material;
            mesh.material = entry.pickingMaterial;
        }

        // Save and restore clear color
        const prevClearColor = new THREE.Color();
        const prevClearAlpha = this._renderer.getClearAlpha();
        this._renderer.getClearColor(prevClearColor);

        this._renderer.setRenderTarget(this._target);
        this._renderer.setClearColor(0x000000, 1);
        this._renderer.clear();
        this._renderer.render(scene, camera);

        const tRender = performance.now();
        this._lastRenderMs = tRender - t0;

        // Restore render target and clear color before pixel read.
        this._renderer.setRenderTarget(null);
        this._renderer.setClearColor(prevClearColor, prevClearAlpha);

        // Swap materials back: picking → main
        for (const entry of this._registry) {
            const mesh = entry.renderer.instanceMesh;
            if (!mesh || !entry._savedMaterial) continue;
            mesh.material = entry._savedMaterial;
            entry._savedMaterial = null;
        }

        return t0;
    }

    /**
     * Read the pixel at the current mouse position from the picking target.
     *
     * Returns a Promise that resolves to a Uint8Array(4) containing the RGBA
     * bytes of the sampled pixel. On WebGL2 the read is synchronous under the
     * hood; the Promise wrapper exists so callers do not bake in sync
     * assumptions before a WebGPU async readback path is introduced.
     *
     * Must be called after _renderPickingPass() while the picking target still
     * contains the most-recent render.
     *
     * @param {number} [t0] - Start timestamp from _renderPickingPass, for timing.
     * @returns {Promise<Uint8Array>} Four-byte RGBA pixel, or all-zeros if out of bounds.
     */
    async readPixelAsync(t0) {
        const { x, y } = this._mousePixel;
        const pixel = new Uint8Array(4);
        if (this._target && x >= 0 && y >= 0 && x < this._target.width && y < this._target.height) {
            this._renderer.readRenderTargetPixels(
                this._target, x, this._target.height - 1 - y, 1, 1, this._readBuffer
            );
            pixel.set(this._readBuffer);
        }
        if (t0 !== undefined) {
            const tRead = performance.now();
            this._lastReadMs = tRead - (t0 + (this._lastRenderMs ?? 0));
            this._lastTotalMs = tRead - t0;
        }
        return pixel;
    }

    /**
     * Swap picking materials onto registered glyph meshes, render the main
     * scene to the picking target, read the pixel under the cursor, swap back.
     *
     * The meshes stay in the main scene graph with their real transforms —
     * the picking texture is a pixel-perfect spatial mirror of the visible
     * render. The swap is just JS property assignments (no GPU work).
     *
     * @param {THREE.Camera} camera
     * @param {THREE.Scene} scene - The main scene
     * @returns {number} Picking ID (0 = no hit)
     */
    renderAndRead(camera, scene) {
        if (!this._needsPick) return this._lastPickedId;
        this._needsPick = false;

        const t0 = this._renderPickingPass(camera, scene);

        // Read pixel synchronously — same GPU call as before, just factored out.
        const { x, y } = this._mousePixel;
        let id = 0;
        if (this._target && x >= 0 && y >= 0 && x < this._target.width && y < this._target.height) {
            this._renderer.readRenderTargetPixels(
                this._target, x, this._target.height - 1 - y, 1, 1, this._readBuffer
            );
            const [r, g, b] = this._readBuffer;
            id = (r << 16) | (g << 8) | b;
        }

        const tRead = performance.now();
        this._lastReadMs = tRead - (t0 + this._lastRenderMs);
        this._lastTotalMs = tRead - t0;
        this._lastPickedId = id;

        return id;
    }

    /**
     * Async variant of renderAndRead. Use this when the caller can await —
     * the pixel read is wrapped in Promise.resolve() so the call site is
     * forward-compatible with a future WebGPU async readback implementation.
     *
     * @param {THREE.Camera} camera
     * @param {THREE.Scene} scene - The main scene
     * @returns {Promise<number>} Picking ID (0 = no hit)
     */
    async renderAndReadAsync(camera, scene) {
        if (!this._needsPick) return this._lastPickedId;
        this._needsPick = false;

        const t0 = this._renderPickingPass(camera, scene);
        const pixel = await this.readPixelAsync(t0);
        const id = (pixel[0] << 16) | (pixel[1] << 8) | pixel[2];
        this._lastPickedId = id;
        return id;
    }

    // -------------------------------------------------------------------------
    // Resolution
    // -------------------------------------------------------------------------

    /**
     * Resolve a raw picking ID to renderer + buffer slot index.
     * @param {number} pickingId
     * @returns {{ renderer: *, slotIndex: number } | null}
     */
    resolve(pickingId) {
        if (pickingId === 0) return null;
        for (const entry of this._registry) {
            if (pickingId >= entry.startId && pickingId < entry.endId) {
                return {
                    renderer: entry.renderer,
                    slotIndex: pickingId - entry.startId
                };
            }
        }
        return null;
    }

    /**
     * Resolve a buffer slot index within a renderer to { textId, charIndex }.
     * @param {*} renderer
     * @param {number} slotIndex
     * @returns {{ textId: number, charIndex: number } | null}
     */
    resolveGlyph(renderer, slotIndex) {
        for (const [textId, entry] of renderer.renderedTexts) {
            const start = entry.bufferStartIndex;
            if (start === undefined) continue;
            const end = start + entry.glyphs.length;
            if (slotIndex >= start && slotIndex < end) {
                return { textId, charIndex: slotIndex - start };
            }
        }
        return null;
    }

    static decodePickingId(pixel) {
        return (pixel[0] << 16) | (pixel[1] << 8) | pixel[2];
    }

    // -------------------------------------------------------------------------
    // Stats & lifecycle
    // -------------------------------------------------------------------------

    get renderTarget() {
        return this._target;
    }

    getStats() {
        const target = this._target;
        const targetBytes = target ? target.width * target.height * 4 : 0;

        let totalInstances = 0;
        let totalPickingIdBytes = 0;
        for (const entry of this._registry) {
            const count = entry.endId - entry.startId;
            totalInstances += count;
            totalPickingIdBytes += count * 4;
        }

        return {
            rendererCount: this._registry.length,
            totalInstances,
            targetWidth: target?.width ?? 0,
            targetHeight: target?.height ?? 0,
            targetBytes,
            pickingIdBytes: totalPickingIdBytes,
            totalBytes: targetBytes + totalPickingIdBytes,
            nextPickingId: this._nextPickingId,
            resolutionScale: this._scale,
            lastRenderMs: this._lastRenderMs ?? 0,
            lastReadMs: this._lastReadMs ?? 0,
            lastTotalMs: this._lastTotalMs ?? 0,
        };
    }

    dispose() {
        for (const entry of this._registry) {
            entry.pickingMaterial.dispose();
        }
        this._registry = [];
        if (this._target) {
            this._target.dispose();
            this._target = null;
        }
    }
}

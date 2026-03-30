/**
 * PickingSystem - GPU-based glyph picking via a dedicated render target.
 *
 * Each GlyphRenderer that is registered gets a paired picking mesh that shares
 * the same InstancedBufferGeometry (no clone) but uses an inline picking
 * ShaderMaterial. All picking meshes live in a dedicated _pickingScene.
 *
 * Picking IDs are 24-bit sequential integers encoded as RGB in the picking
 * fragment shader. Black (0,0,0) = "no hit". The global counter persists
 * across hot-reloads via window.__glyph3dPickingIdCounter.
 *
 * Usage:
 *   const ps = new PickingSystem(threeRenderer, { resolutionScale: 0.5 });
 *   glyphCollection.setPickingSystem(ps);  // auto-registers on flush
 *   window.addEventListener('resize', () => ps.onResize());
 *   canvas.addEventListener('mousemove', e => {
 *       ps.setMousePosition(e.clientX, e.clientY);
 *   });
 *   // In render loop:
 *   const id = ps.renderAndRead(camera);
 *   const hit = ps.resolve(id); // { renderer, slotIndex } | null
 */

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Picking vertex shader — inline to avoid a fetch() dependency.
// Mirrors the worldPos formula from GlyphRenderer._getVertexShader() and
// suppresses invisible-group glyphs with an explicit clip-space branch
// (w=0 causes a perspective-divide by zero which is undefined GLSL ES behaviour).
// ---------------------------------------------------------------------------
const PICKING_VERTEX_SHADER = `
precision highp float;

attribute vec3 instancePosition;
attribute vec2 instanceSize;
attribute float instanceCodepoint;
attribute float instanceGroupId;
attribute float instancePickingId;

uniform sampler2D groupTexture;
uniform float groupTextureHeight;

// Atlas map: codepoint → UV rect (same lookup as main shader)
uniform sampler2D atlasMapTexture;
uniform float atlasMapWidth;
uniform float atlasMapHeight;

varying float vPickingId;
varying highp vec2 vUV;

void main() {
    // Scale the base quad by instance size
    vec3 scaled = position * vec3(instanceSize, 1.0);

    // Group property lookups (4-column DataTexture, same UV coordinates as main shader)
    float v = (instanceGroupId + 0.5) / groupTextureHeight;
    vec4 gPos   = texture2D(groupTexture, vec2(0.125, v));  // col 0: offset + visibility
    vec4 gColor = texture2D(groupTexture, vec2(0.625, v));  // col 2: color multiplier (a = visibility)
    vec4 gScale = texture2D(groupTexture, vec2(0.875, v));  // col 3: scale

    // Suppress invisible-group glyphs — push outside clip volume
    float visible = step(0.01, gColor.a);
    if (visible < 0.5) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
    }

    // World position (matches GlyphRenderer main shader formula)
    vec3 worldPos = scaled + instancePosition * gScale.xyz + gPos.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
    vPickingId = instancePickingId;

    // GPU codepoint → UV lookup (same as main shader) for alpha testing
    float cp = instanceCodepoint;
    float mapCol = mod(cp, atlasMapWidth);
    float mapRow = floor(cp / atlasMapWidth);
    float tx = (mapCol + 0.5) / atlasMapWidth;
    float ty = (mapRow + 0.5) / atlasMapHeight;
    vec4 uvRect = texture2D(atlasMapTexture, vec2(tx, ty));
    vUV = mix(uvRect.xy, uvRect.zw, uv);
}
`;

// ---------------------------------------------------------------------------
// Picking fragment shader — encodes a 24-bit integer as RGB.
// Samples atlas texture and discards transparent pixels so picking quads
// match the visible glyph shape (not the full cell with line-height padding).
// ---------------------------------------------------------------------------
const PICKING_FRAGMENT_SHADER = `
precision highp float;
uniform sampler2D atlasTexture;
varying float vPickingId;
varying highp vec2 vUV;
void main() {
    // Alpha test — only pick where the glyph is actually visible
    float alpha = texture2D(atlasTexture, vUV).a;
    if (alpha < 0.01) discard;

    float id = vPickingId;
    float r = floor(id / 65536.0);
    float g = floor(mod(id, 65536.0) / 256.0);
    float b = mod(id, 256.0);
    gl_FragColor = vec4(r / 255.0, g / 255.0, b / 255.0, 1.0);
}
`;

// ---------------------------------------------------------------------------

export class PickingSystem {
    /**
     * @param {THREE.WebGLRenderer} threeRenderer
     * @param {Object} [options]
     * @param {number} [options.resolutionScale=1.0] - Scale factor for the picking render target.
     *   0.5 halves resolution and cost; 1.0 matches the viewport exactly.
     */
    constructor(threeRenderer, options = {}) {
        this._renderer = threeRenderer;
        this._scale = options.resolutionScale ?? 1.0;

        // Dedicated picking scene — main scene is never mutated during picking pass
        this._pickingScene = new THREE.Scene();

        // Registry: [{ renderer, pickingMesh, startId, endId }]
        // endId is exclusive: IDs in range [startId, endId)
        this._registry = [];

        // Persist counter across hot-reload — module-level counters reset on re-import
        this._nextPickingId = (window.__glyph3dPickingIdCounter || 1);

        // Picking target and readback buffer
        this._target = null;
        this._readBuffer = new Uint8Array(4);

        // Last-set mouse position in target-pixel coordinates
        this._mousePixel = { x: -1, y: -1 };

        // Dirty flag — only render+read when the mouse has moved
        this._needsPick = false;
        this._lastPickedId = 0;

        this._createTarget();
    }

    // -------------------------------------------------------------------------
    // Target management
    // -------------------------------------------------------------------------

    /**
     * Create (or recreate) the WebGLRenderTarget at current viewport size × scale.
     * @private
     */
    _createTarget() {
        // Use the renderer's actual drawing buffer size (accounts for devicePixelRatio)
        const size = this._renderer.getSize(new THREE.Vector2());
        const w = Math.max(1, Math.floor(size.x * this._scale));
        const h = Math.max(1, Math.floor(size.y * this._scale));
        if (this._target) this._target.dispose();
        this._target = new THREE.WebGLRenderTarget(w, h, {
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            type: THREE.UnsignedByteType
        });
    }

    /**
     * Recreate the render target at the new viewport size.
     * Wire to window resize: `window.addEventListener('resize', () => ps.onResize())`.
     */
    onResize() {
        this._createTarget();
    }

    // -------------------------------------------------------------------------
    // Mouse position
    // -------------------------------------------------------------------------

    /**
     * Set the current mouse position (CSS coordinates relative to the canvas).
     * Converts to target-pixel coordinates using devicePixelRatio and resolutionScale.
     * @param {number} cssX - CSS X coordinate (e.g. e.clientX - rect.left)
     * @param {number} cssY - CSS Y coordinate (e.g. e.clientY - rect.top)
     * @param {DOMRect} [canvasRect] - Canvas bounding rect (if not provided, uses raw cssX/cssY)
     */
    setMousePosition(cssX, cssY) {
        // Target is sized from renderer.getSize() (CSS pixels) × scale.
        // Mouse input is CSS-relative. Just scale to match target coords.
        const newX = Math.floor(cssX * this._scale);
        const newY = Math.floor(cssY * this._scale);
        if (newX !== this._mousePixel.x || newY !== this._mousePixel.y) {
            this._mousePixel = { x: newX, y: newY };
            this._needsPick = true;
        }
    }

    // -------------------------------------------------------------------------
    // Registration
    // -------------------------------------------------------------------------

    /**
     * Register a GlyphRenderer with this picking system.
     * Claims a contiguous block of picking IDs and writes them to the
     * instancePickingId attribute. Creates a paired picking mesh (shared geometry,
     * dedicated ShaderMaterial) and adds it to the picking scene.
     *
     * Must be called after every flush that rebuilds geometry — picking IDs become
     * stale after _rebuildAllInstances() or applyPrebuiltBuffers(). GlyphCollection
     * calls this automatically when a PickingSystem is wired via setPickingSystem().
     *
     * @param {import('../GlyphRenderer.js').default} glyphRenderer
     * @returns {number} The startId assigned to this renderer's block (0 if empty)
     */
    registerRenderer(glyphRenderer) {
        // Always unregister first to remove any stale registry entry
        this.unregisterRenderer(glyphRenderer);

        const geom = glyphRenderer.instanceMesh?.geometry;
        if (!geom) return 0;
        const count = geom.instanceCount;
        if (count === 0) return 0;

        const startId = this._nextPickingId;
        const endId = startId + count;  // exclusive

        this._nextPickingId = endId;
        // Persist counter so hot-reload doesn't produce collisions
        window.__glyph3dPickingIdCounter = this._nextPickingId;

        // Write instancePickingId: [startId, startId+1, ..., startId+count-1]
        const ids = new Float32Array(count);
        for (let i = 0; i < count; i++) ids[i] = startId + i;
        geom.setAttribute('instancePickingId',
            new THREE.InstancedBufferAttribute(ids, 1));

        // Build picking mesh: shared geometry reference, dedicated ShaderMaterial
        // Pull atlas uniforms from the renderer's existing material for alpha testing
        const mainUniforms = glyphRenderer.instanceMesh.material.uniforms;
        const pickingMat = new THREE.ShaderMaterial({
            uniforms: {
                groupTexture:       { value: glyphRenderer._groupTexture },
                groupTextureHeight: { value: glyphRenderer._maxGroups },
                atlasTexture:       mainUniforms.atlasTexture,
                atlasMapTexture:    mainUniforms.atlasMapTexture,
                atlasMapWidth:      mainUniforms.atlasMapWidth,
                atlasMapHeight:     mainUniforms.atlasMapHeight,
            },
            vertexShader:   PICKING_VERTEX_SHADER,
            fragmentShader: PICKING_FRAGMENT_SHADER,
            side: THREE.DoubleSide
        });
        const pickingMesh = new THREE.Mesh(geom, pickingMat);
        pickingMesh.frustumCulled = false;
        this._pickingScene.add(pickingMesh);

        this._registry.push({ renderer: glyphRenderer, pickingMesh, startId, endId });
        return startId;
    }

    /**
     * Remove a renderer from the registry and its mesh from the picking scene.
     * Does NOT compact _nextPickingId — ID space is monotonically increasing.
     * @param {import('../GlyphRenderer.js').default} glyphRenderer
     */
    unregisterRenderer(glyphRenderer) {
        const idx = this._registry.findIndex(e => e.renderer === glyphRenderer);
        if (idx === -1) return;
        const entry = this._registry[idx];
        this._pickingScene.remove(entry.pickingMesh);
        entry.pickingMesh.material.dispose();
        this._registry.splice(idx, 1);
    }

    // -------------------------------------------------------------------------
    // Render pass
    // -------------------------------------------------------------------------

    /**
     * Render the picking scene to the offscreen target, read the pixel under
     * the current mouse position, and return the decoded picking ID.
     *
     * Consolidated path: single render target bind per frame.
     * Returns 0 if nothing is under the cursor or mouse position is invalid.
     *
     * @param {THREE.Camera} camera
     * @returns {number} Picking ID (0 = no hit)
     */
    renderAndRead(camera) {
        // Skip entirely if mouse hasn't moved since last pick
        if (!this._needsPick) return this._lastPickedId;
        this._needsPick = false;

        const t0 = performance.now();

        // Save and restore clear color so we don't affect the main scene
        const prevClearColor = new THREE.Color();
        let prevClearAlpha;
        this._renderer.getClearColor(prevClearColor);
        prevClearAlpha = this._renderer.getClearAlpha();

        this._renderer.setRenderTarget(this._target);
        this._renderer.setClearColor(0x000000, 1);
        this._renderer.clear();
        this._renderer.render(this._pickingScene, camera);

        const tRender = performance.now();

        const { x, y } = this._mousePixel;
        let id = 0;
        if (x >= 0 && y >= 0 && x < this._target.width && y < this._target.height) {
            const gl = this._renderer.getContext();
            // WebGL Y-axis is bottom-up; target height - 1 - y converts from top-down CSS
            gl.readPixels(x, this._target.height - 1 - y, 1, 1,
                gl.RGBA, gl.UNSIGNED_BYTE, this._readBuffer);
            const [r, g, b] = this._readBuffer;
            id = (r << 16) | (g << 8) | b;
        }

        const tRead = performance.now();

        this._renderer.setRenderTarget(null);
        this._renderer.setClearColor(prevClearColor, prevClearAlpha);

        // Track timing
        this._lastRenderMs = tRender - t0;
        this._lastReadMs = tRead - tRender;
        this._lastTotalMs = tRead - t0;
        this._lastPickedId = id;

        return id;
    }

    /**
     * Render the picking pass to the offscreen target.
     * Use renderAndRead() for the common case; this method is available for
     * callers who need to control read timing (e.g. deferred PBO readback).
     * @param {THREE.Camera} camera
     */
    renderPickingPass(camera) {
        const prevClearColor = new THREE.Color();
        const prevClearAlpha = this._renderer.getClearAlpha();
        this._renderer.getClearColor(prevClearColor);

        this._renderer.setRenderTarget(this._target);
        this._renderer.setClearColor(0x000000, 1);
        this._renderer.clear();
        this._renderer.render(this._pickingScene, camera);
        this._renderer.setRenderTarget(null);

        this._renderer.setClearColor(prevClearColor, prevClearAlpha);
    }

    /**
     * Read the picking ID at the last-set mouse position.
     * The target must already contain a rendered picking pass (call renderPickingPass first).
     * Returns 0 if nothing is under the cursor.
     * @returns {number} Picking ID (0 = no hit)
     */
    readAtMouse() {
        const { x, y } = this._mousePixel;
        if (x < 0 || y < 0 || x >= this._target.width || y >= this._target.height) return 0;

        this._renderer.setRenderTarget(this._target);
        const gl = this._renderer.getContext();
        gl.readPixels(x, this._target.height - 1 - y, 1, 1,
            gl.RGBA, gl.UNSIGNED_BYTE, this._readBuffer);
        this._renderer.setRenderTarget(null);

        const [r, g, b] = this._readBuffer;
        return (r << 16) | (g << 8) | b;
    }

    // -------------------------------------------------------------------------
    // Resolution
    // -------------------------------------------------------------------------

    /**
     * Resolve a raw picking ID to renderer + buffer slot index.
     * O(N renderers) linear scan — acceptable at current scale (≤500 renderers).
     * @param {number} pickingId
     * @returns {{ renderer: import('../GlyphRenderer.js').default, slotIndex: number } | null}
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
     * Walks renderer.renderedTexts to find which text entry owns the slot.
     * @param {import('../GlyphRenderer.js').default} renderer
     * @param {number} slotIndex - Absolute buffer slot index
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

    /**
     * Decode a 4-byte RGBA pixel into a 24-bit picking ID.
     * @param {Uint8Array} pixel - [r, g, b, a]
     * @returns {number}
     */
    static decodePickingId(pixel) {
        return (pixel[0] << 16) | (pixel[1] << 8) | pixel[2];
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    /**
     * Get the render target texture (useful for debug overlays).
     * @returns {THREE.WebGLRenderTarget}
     */
    get renderTarget() {
        return this._target;
    }

    /**
     * Get performance and memory statistics.
     * @returns {Object} Stats object with memory sizes, timing, and counts
     */
    getStats() {
        const target = this._target;
        const targetBytes = target ? target.width * target.height * 4 : 0;

        let totalInstances = 0;
        let totalPickingIdBytes = 0;
        for (const entry of this._registry) {
            const count = entry.endId - entry.startId;
            totalInstances += count;
            totalPickingIdBytes += count * 4; // Float32
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

    /**
     * Dispose all GPU resources owned by this PickingSystem.
     */
    dispose() {
        for (const entry of this._registry) {
            this._pickingScene.remove(entry.pickingMesh);
            entry.pickingMesh.material.dispose();
        }
        this._registry = [];
        if (this._target) {
            this._target.dispose();
            this._target = null;
        }
    }
}

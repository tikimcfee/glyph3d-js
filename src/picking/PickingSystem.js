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
// Picking vertex shader — mirrors GlyphRenderer._getVertexShader() exactly
// for positioning, plus atlas UV lookup for alpha testing.
// ---------------------------------------------------------------------------
const PICKING_VERTEX_SHADER = `
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
    if (visible < 0.5) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
    }

    vec3 worldPos = scaled + instancePosition * gScale.xyz + gPos.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
    vPickingId = instancePickingId;
}
`;

// ---------------------------------------------------------------------------
// Picking fragment shader — solid quad, 24-bit ID as RGB.
// No atlas sampling — the full glyph cell is pickable, not just the stroke.
// ---------------------------------------------------------------------------
const PICKING_FRAGMENT_SHADER = `
precision highp float;
varying float vPickingId;
void main() {
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
     * @param {number} [options.resolutionScale=1.0]
     */
    constructor(threeRenderer, options = {}) {
        this._renderer = threeRenderer;
        this._scale = options.resolutionScale ?? 1.0;

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

    /** @private */
    _createTarget() {
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

    onResize() {
        this._createTarget();
    }

    // -------------------------------------------------------------------------
    // Mouse position
    // -------------------------------------------------------------------------

    setMousePosition(cssX, cssY) {
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
     * instancePickingId attribute. Creates a picking ShaderMaterial that
     * will be swapped onto the mesh during the picking render pass.
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

        // Write instancePickingId buffer
        const ids = new Float32Array(count);
        for (let i = 0; i < count; i++) ids[i] = startId + i;
        mesh.geometry.setAttribute('instancePickingId',
            new THREE.InstancedBufferAttribute(ids, 1));

        // Create picking material — used during material-swap render pass.
        // No atlas uniforms needed: the picking shader renders solid quads.
        const pickingMaterial = new THREE.ShaderMaterial({
            uniforms: {
                groupTexture:       { value: glyphRenderer._groupTexture },
                groupTextureHeight: { value: glyphRenderer._maxGroups },
            },
            vertexShader:   PICKING_VERTEX_SHADER,
            fragmentShader: PICKING_FRAGMENT_SHADER,
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

        // Auto-resize target if renderer size changed (e.g. IDE ResizeObserver)
        const size = this._renderer.getSize(this._sizeVec);
        const tw = Math.max(1, Math.floor(size.x * this._scale));
        const th = Math.max(1, Math.floor(size.y * this._scale));
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

        // Read pixel at mouse position
        const { x, y } = this._mousePixel;
        let id = 0;
        if (x >= 0 && y >= 0 && x < this._target.width && y < this._target.height) {
            const gl = this._renderer.getContext();
            gl.readPixels(x, this._target.height - 1 - y, 1, 1,
                gl.RGBA, gl.UNSIGNED_BYTE, this._readBuffer);
            const [r, g, b] = this._readBuffer;
            id = (r << 16) | (g << 8) | b;
        }

        const tRead = performance.now();

        this._renderer.setRenderTarget(null);
        this._renderer.setClearColor(prevClearColor, prevClearAlpha);

        // Swap materials back: picking → main
        for (const entry of this._registry) {
            const mesh = entry.renderer.instanceMesh;
            if (!mesh || !entry._savedMaterial) continue;
            mesh.material = entry._savedMaterial;
            entry._savedMaterial = null;
        }

        // Track timing
        this._lastRenderMs = tRender - t0;
        this._lastReadMs = tRead - tRender;
        this._lastTotalMs = tRead - t0;
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

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
attribute float instanceCodepoint;
attribute float instanceGroupId;
attribute float instancePickingId;

uniform sampler2D groupTexture;
uniform float groupTextureHeight;

uniform sampler2D atlasMapTexture;
uniform float atlasMapWidth;
uniform float atlasMapHeight;

varying float vPickingId;
varying highp vec2 vUV;

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
// Picking fragment shader — 24-bit ID as RGB, alpha-tested against atlas.
// ---------------------------------------------------------------------------
const PICKING_FRAGMENT_SHADER = `
precision highp float;
uniform sampler2D atlasTexture;
varying float vPickingId;
varying highp vec2 vUV;
void main() {
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
     * @param {number} [options.resolutionScale=1.0]
     */
    constructor(threeRenderer, options = {}) {
        this._renderer = threeRenderer;
        this._scale = options.resolutionScale ?? 1.0;

        // Registry: [{ renderer, pickingMaterial, startId, endId }]
        this._registry = [];

        // Empty scene used to initialize Three.js render state before
        // renderBufferDirect calls (which require an active render state)
        this._emptyScene = new THREE.Scene();

        // Persist counter across hot-reload
        this._nextPickingId = (window.__glyph3dPickingIdCounter || 1);

        // Picking target and readback buffer
        this._target = null;
        this._readBuffer = new Uint8Array(4);

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

        // Create picking material — used during material-swap render pass
        const mainUniforms = mesh.material.uniforms;
        const pickingMaterial = new THREE.ShaderMaterial({
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
    // Render pass — direct draw with picking materials
    // -------------------------------------------------------------------------

    /**
     * Render each registered glyph mesh directly to the picking target using
     * its picking material and its current world matrix from the main scene.
     * No scene traversal, no material swap, no state mutation on the meshes.
     *
     * This mirrors the Metal approach: same geometry, same transforms, different
     * shader — submitted as a second render pass without touching the scene graph.
     *
     * @param {THREE.Camera} camera
     * @returns {number} Picking ID (0 = no hit)
     */
    renderAndRead(camera) {
        if (!this._needsPick) return this._lastPickedId;
        this._needsPick = false;

        const t0 = performance.now();

        // Save and restore clear color
        const prevClearColor = new THREE.Color();
        const prevClearAlpha = this._renderer.getClearAlpha();
        this._renderer.getClearColor(prevClearColor);

        this._renderer.setRenderTarget(this._target);
        this._renderer.setClearColor(0x000000, 1);
        this._renderer.clear();

        // Initialize Three.js render state (required by renderBufferDirect)
        // Rendering an empty scene is the cheapest way to set up the internal
        // currentRenderState, program caches, and uniform bindings.
        camera.updateMatrixWorld();
        this._renderer.render(this._emptyScene, camera);

        // Direct-draw each registered mesh with its picking material.
        // renderBufferDirect uses the mesh's matrixWorld as-is — no scene
        // graph traversal, no material mutation on the original mesh.
        for (const entry of this._registry) {
            const mesh = entry.renderer.instanceMesh;
            if (!mesh) continue;
            mesh.updateMatrixWorld(true);
            this._renderer.renderBufferDirect(
                camera,
                null,              // no scene (no fog/env)
                mesh.geometry,
                entry.pickingMaterial,
                mesh,              // object — provides matrixWorld
                null               // group (draw the whole geometry)
            );
        }

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

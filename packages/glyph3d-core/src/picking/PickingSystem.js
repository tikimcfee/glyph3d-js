/**
 * PickingSystem — GPU ID-pass picking across independent CHANNELS.
 *
 * Each channel is a self-contained pickable set: its own THREE render layer, its
 * own first-fit ID space (so IDs never collide across channels), and its own
 * picking material kind. The ID pass for a channel renders ONLY that channel's
 * layer to an offscreen target and reads the pixel under the cursor — a
 * pixel-perfect spatial mirror of the visible render, ID-encoded. No raycasting,
 * no bounds: the buffer is the single source of truth for "what's under here".
 *
 * Built-in channels:
 *   - 'glyph' (layer 7, kind 'glyph') — instanced glyph quads, ID = base +
 *     instanceIndex, resolves to { token: renderer, slotIndex } → char-level.
 *     The full glyph cell quad is pickable.
 *   - 'grid'  (layer 8, kind 'flat')  — one solid quad per grid (the background
 *     panel), ID = base, resolves to { token: grid } → whole-panel grid-level.
 *   - 'handle' (layer 9, kind 'flat') — small per-viewport control meshes (terminal
 *     resize grips), ID = base, resolves to { token } → e.g. { grid, edge }.
 *   - 'group' (layer 10, kind 'flat') — container volumes (agent-trail corridor boxes)
 *
 * WebGL2 (GLSL 3.00 ES) THREE.ShaderMaterial implementation.
 */

import * as THREE from 'three';

// Built-in channels. Each gets a distinct THREE render layer so the picking
// camera can isolate it (renders ONLY that layer → the ID buffer is free of
// every other channel and of non-pickable scene-graph noise).
const DEFAULT_CHANNELS = {
    glyph:  { layer: 7, kind: 'glyph' },
    grid:   { layer: 8, kind: 'flat'  },
    handle: { layer: 9, kind: 'flat'  },
    group:  { layer: 10, kind: 'flat' },
};

const FLAT_PICK_VS = `
precision highp float;
in vec3 position;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FLAT_PICK_FS = `
precision highp float;
precision highp int;
uniform int uBasePickingId;
out vec4 fragColor;
void main() {
    int id = uBasePickingId;
    int r = (id >> 16) & 0xFF;
    int g = (id >> 8) & 0xFF;
    int b = id & 0xFF;
    int a = (id >> 24) & 0xFF;
    fragColor = vec4(float(r) / 255.0, float(g) / 255.0, float(b) / 255.0, float(a) / 255.0);
}
`;

const GLYPH_PICK_VS = `
precision highp float;
precision highp int;

in vec3 position;
in vec2 uv;
in vec3 aPos;
in float aGlyphId;
in float aColor;
in float aGroupId;
in vec2 aExtent;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

uniform highp usampler2D glyphMapTexture;
uniform int glyphMapWidth;
uniform sampler2D groupTexture;
uniform int maxGroups;
uniform float uWidthCompress;
uniform int uBasePickingId;

flat out int vPickingId;

void main() {
    int gid = int(aGlyphId + 0.5);
    int mapW = glyphMapWidth > 0 ? glyphMapWidth : 1024;
    uvec4 info = texelFetch(glyphMapTexture, ivec2(gid % mapW, gid / mapW), 0);
    int vMode = int(info.z);

    if (vMode == 2) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
    }

    float quadW = (vMode == 1) ? aExtent.y : aExtent.x;
    float kW = uWidthCompress > 0.0 ? uWidthCompress : 1.0;

    vec3 aligned = vec3(uv.x * quadW * kW, (uv.y - 0.5) * aExtent.y, 0.0) + aPos;

    int grow = int(aGroupId + 0.5);
    if (grow < 0 || grow >= maxGroups) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
    }

    vec4 gPos   = texelFetch(groupTexture, ivec2(0, grow), 0);
    vec4 gQuat  = texelFetch(groupTexture, ivec2(1, grow), 0);
    vec4 gColor = texelFetch(groupTexture, ivec2(2, grow), 0);
    vec4 gScale = texelFetch(groupTexture, ivec2(3, grow), 0);
    vec4 gClip  = texelFetch(groupTexture, ivec2(4, grow), 0);

    if (gColor.a < 0.01) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
    }

    if (gClip.z > 0.5 && (aPos.y > gClip.x || aPos.y < gClip.y)) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
    }

    vec3 local = aligned * gScale.xyz;
    vec3 qc = cross(gQuat.xyz, local) + local * gQuat.w;
    vec3 posed = local + 2.0 * cross(gQuat.xyz, qc);
    vec3 worldPos = posed + gPos.xyz;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
    vPickingId = uBasePickingId + gl_InstanceID;
}
`;

const GLYPH_PICK_FS = `
precision highp float;
precision highp int;

flat in int vPickingId;
out vec4 fragColor;

void main() {
    int id = vPickingId;
    int r = (id >> 16) & 0xFF;
    int g = (id >> 8) & 0xFF;
    int b = id & 0xFF;
    int a = (id >> 24) & 0xFF;
    fragColor = vec4(float(r) / 255.0, float(g) / 255.0, float(b) / 255.0, float(a) / 255.0);
}
`;

export class PickingSystem {
    /**
     * @param {THREE.WebGLRenderer} threeRenderer
     * @param {Object} [options]
     * @param {number} [options.resolutionScale=1.0]
     */
    constructor(threeRenderer, options = {}) {
        if (!threeRenderer) {
            throw new Error('[PickingSystem] a renderer is required');
        }
        this._renderer = threeRenderer;
        this._scale = options.resolutionScale ?? 1.0;

        // Channels: name -> { layer, kind, entries: [{ mesh, material, startId, endId, token }] }
        this._channels = new Map();
        for (const [name, def] of Object.entries(DEFAULT_CHANNELS)) {
            this.defineChannel(name, def);
        }

        // Picking target
        this._target = null;
        this._sizeVec = new THREE.Vector2(); // reusable for getSize()

        // Mouse position in target-pixel coordinates
        this._mousePixel = { x: -1, y: -1 };

        this._needsPick = false;
        this._lastResult = new Map(); // channel -> last resolved hit | null

        this._createTarget();
    }

    // -------------------------------------------------------------------------
    // Channels
    // -------------------------------------------------------------------------

    defineChannel(name, { layer, kind }) {
        const existing = this._channels.get(name);
        this._channels.set(name, { layer, kind, entries: existing?.entries ?? [] });
    }

    /** @private */
    _channel(name) {
        const ch = this._channels.get(name);
        if (!ch) throw new Error(`[PickingSystem] unknown channel '${name}'`);
        return ch;
    }

    /** @private — the mesh a register/unregister target maps to in a channel. */
    _meshOf(channel, target) {
        return channel.kind === 'glyph' ? (target?.instanceMesh || target) : target;
    }

    // -------------------------------------------------------------------------
    // Target management
    // -------------------------------------------------------------------------

    /** @private */
    _createTarget() {
        const size = this._renderer.getSize(new THREE.Vector2());
        const dpr = this._renderer.getPixelRatio ? this._renderer.getPixelRatio() : 1;
        const w = Math.max(1, Math.floor(size.x * dpr * this._scale));
        const h = Math.max(1, Math.floor(size.y * dpr * this._scale));
        if (this._target) this._target.dispose();
        const RenderTargetClass = THREE.WebGLRenderTarget || THREE.RenderTarget;
        this._target = new RenderTargetClass(w, h, {
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            type: THREE.UnsignedByteType,
        });
        this._target.isWebGLRenderTarget = true;
    }

    onResize() {
        this._createTarget();
    }

    // -------------------------------------------------------------------------
    // Mouse position
    // -------------------------------------------------------------------------

    setMousePosition(cssX, cssY) {
        const dpr = this._renderer.getPixelRatio ? this._renderer.getPixelRatio() : 1;
        const newX = Math.floor(cssX * dpr * this._scale);
        const newY = Math.floor(cssY * dpr * this._scale);
        if (newX !== this._mousePixel.x || newY !== this._mousePixel.y) {
            this._mousePixel = { x: newX, y: newY };
            this._needsPick = true;
        }
    }

    markDirty() {
        this._needsPick = true;
    }

    // -------------------------------------------------------------------------
    // Picking materials
    // -------------------------------------------------------------------------

    _createGlyphPickMaterial(gf, startId) {
        const dummyTex = new THREE.DataTexture(new Float32Array(24), 6, 1, THREE.RGBAFormat, THREE.FloatType);
        dummyTex.needsUpdate = true;
        const dummyGlyphMap = new THREE.DataTexture(new Uint32Array(4), 1, 1, THREE.RGBAIntegerFormat, THREE.UnsignedIntType);
        dummyGlyphMap.needsUpdate = true;

        return new THREE.RawShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: GLYPH_PICK_VS,
            fragmentShader: GLYPH_PICK_FS,
            uniforms: {
                uBasePickingId: { value: startId || 0 },
                groupTexture: { value: gf?.groupTexture || dummyTex },
                maxGroups: { value: gf?.maxGroups || 1 },
                glyphMapTexture: { value: gf?.glyphMapTexture || dummyGlyphMap },
                glyphMapWidth: { value: gf?.glyphMapWidth || 1 },
                uWidthCompress: { value: gf?.widthCompress || 1.0 },
            },
            side: THREE.DoubleSide,
            depthWrite: true,
            depthTest: true,
            blending: THREE.NoBlending,
        });
    }

    _createFlatPickMaterial(startId) {
        return new THREE.RawShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: FLAT_PICK_VS,
            fragmentShader: FLAT_PICK_FS,
            uniforms: {
                uBasePickingId: { value: startId || 0 },
            },
            side: THREE.DoubleSide,
            depthWrite: true,
            depthTest: true,
            blending: THREE.NoBlending,
        });
    }

    // -------------------------------------------------------------------------
    // Registration
    // -------------------------------------------------------------------------

    register(channelName, target, token, opts) {
        const ch = this._channel(channelName);
        const mesh = this._meshOf(ch, target);
        if (!mesh?.geometry) return 0;

        this.unregister(channelName, target);

        const count = ch.kind === 'glyph'
            ? (opts?.count || mesh.geometry.instanceCount || 0)
            : (opts?.material ? (opts?.count || 1) : 1);
        if (count === 0) return 0;

        const ranges = ch.entries.map(e => [e.startId, e.endId]).sort((a, b) => a[0] - b[0]);
        let startId = 1;
        for (const [s, e] of ranges) {
            if (startId + count <= s) break;
            if (e > startId) startId = e;
        }
        const endId = startId + count;
        if (endId > 0x7FFFFFFF) {
            console.warn(`[PickingSystem] channel '${channelName}' ID ${endId} exceeds 31-bit limit`);
        }

        mesh.userData.pickStartId = startId;
        const material = opts?.material ?? (ch.kind === 'glyph'
            ? this._createGlyphPickMaterial(mesh.userData?.glyphField || (typeof token?.getRenderer === 'function' ? token.getRenderer() : token), startId)
            : this._createFlatPickMaterial(startId));

        mesh.layers.enable(ch.layer);

        ch.entries.push({ mesh, material, startId, endId, token, callerOwned: !!opts?.material });
        return startId;
    }

    unregister(channelName, target) {
        const ch = this._channel(channelName);
        const mesh = this._meshOf(ch, target);
        if (!mesh) return;
        const idx = ch.entries.findIndex(e => e.mesh === mesh);
        if (idx === -1) return;
        const entry = ch.entries[idx];
        entry.mesh?.layers.disable(ch.layer);
        if (!entry.callerOwned && entry.material) {
            entry.material.dispose();
        }
        ch.entries.splice(idx, 1);
    }

    // -------------------------------------------------------------------------
    // Render pass + read
    // -------------------------------------------------------------------------

    _renderChannelPass(channel, camera, scene) {
        const size = this._renderer.getSize(this._sizeVec);
        const dpr = this._renderer.getPixelRatio ? this._renderer.getPixelRatio() : 1;
        const tw = Math.max(1, Math.floor(size.x * dpr * this._scale));
        const th = Math.max(1, Math.floor(size.y * dpr * this._scale));
        if (!this._target || this._target.width !== tw || this._target.height !== th) {
            this._createTarget();
        }

        const t0 = performance.now();

        const prevClearColor = new THREE.Color();
        const prevClearAlpha = this._renderer.getClearAlpha();
        this._renderer.getClearColor(prevClearColor);
        const savedLayerMask = camera.layers.mask;

        for (const entry of channel.entries) {
            const mesh = entry.mesh;
            if (!mesh) continue;
            entry._savedMaterial = mesh.material;
            mesh.material = entry.material;

            if (channel.kind === 'glyph') {
                const gf = mesh.userData?.glyphField || (typeof entry.token?.getRenderer === 'function' ? entry.token.getRenderer() : entry.token);
                if (entry.material.uniforms) {
                    entry.material.uniforms.uBasePickingId.value = entry.startId;
                    if (gf?.groupTexture) entry.material.uniforms.groupTexture.value = gf.groupTexture;
                    if (gf?.maxGroups) entry.material.uniforms.maxGroups.value = gf.maxGroups;
                    if (gf?.glyphMapTexture) entry.material.uniforms.glyphMapTexture.value = gf.glyphMapTexture;
                    if (gf?.glyphMapWidth) entry.material.uniforms.glyphMapWidth.value = gf.glyphMapWidth;
                    if (gf?.widthCompress != null) entry.material.uniforms.uWidthCompress.value = gf.widthCompress;
                }
            } else {
                if (entry.material?.uniforms?.uBasePickingId) {
                    entry.material.uniforms.uBasePickingId.value = entry.startId;
                }
            }
        }

        // A pick tests what is ON SCREEN — the matrices the last main render drew with. three's
        // render() would re-walk every matrixWorld first (once per channel pass); skip it.
        const savedAutoMW = scene.matrixWorldAutoUpdate;
        try {
            camera.layers.set(channel.layer);
            scene.matrixWorldAutoUpdate = false;
            this._renderer.setRenderTarget(this._target);
            this._renderer.setClearColor(0x000000, 0);
            this._renderer.clear();
            this._renderer.render(scene, camera);
            this._lastRenderMs = performance.now() - t0;
        } finally {
            scene.matrixWorldAutoUpdate = savedAutoMW;
            camera.layers.mask = savedLayerMask;
            this._renderer.setRenderTarget(null);
            this._renderer.setClearColor(prevClearColor, prevClearAlpha);
            for (const entry of channel.entries) {
                const mesh = entry.mesh;
                if (!mesh || !entry._savedMaterial) continue;
                mesh.material = entry._savedMaterial;
                entry._savedMaterial = null;
            }
        }

        return t0;
    }

    async readPixelAsync(t0) {
        const { x, y } = this._mousePixel;
        const pixel = new Uint8Array(4);
        if (this._target && x >= 0 && y >= 0 && x < this._target.width && y < this._target.height) {
            // WebGL coordinate system: Y is bottom-up
            const glY = this._target.height - 1 - y;
            this._renderer.readRenderTargetPixels(this._target, x, glY, 1, 1, pixel);
        }
        if (t0 !== undefined) {
            const tRead = performance.now();
            this._lastReadMs = tRead - (t0 + (this._lastRenderMs ?? 0));
            this._lastTotalMs = tRead - t0;
        }
        return pixel;
    }

    async pickAsync(channelName, camera, scene) {
        const ch = this._channel(channelName);
        if (!ch || ch.entries.length === 0) return null;
        if (!this._needsPick) return this._lastResult.get(channelName) ?? null;
        this._needsPick = false;

        const t0 = this._renderChannelPass(ch, camera, scene);
        const pixel = await this.readPixelAsync(t0);
        const id = pixel[3] * 0x1000000 + ((pixel[0] << 16) | (pixel[1] << 8) | pixel[2]);
        const hit = this.resolve(channelName, id);
        this._lastResult.set(channelName, hit);
        return hit;
    }

    // -------------------------------------------------------------------------
    // Resolution
    // -------------------------------------------------------------------------

    resolve(channelName, pickingId) {
        if (pickingId === 0) return null;
        const ch = this._channel(channelName);
        for (const entry of ch.entries) {
            if (pickingId >= entry.startId && pickingId < entry.endId) {
                return { token: entry.token, slotIndex: pickingId - entry.startId };
            }
        }
        return null;
    }

    resolveGlyph(renderer, slotIndex) {
        if (!renderer) return null;
        if (renderer.renderedTexts) {
            for (const [textId, entry] of renderer.renderedTexts) {
                const start = entry.bufferStartIndex;
                if (start === undefined) continue;
                const end = start + (entry.glyphCount || 0);
                if (slotIndex >= start && slotIndex < end) {
                    return { textId, charIndex: slotIndex - start };
                }
            }
        }
        return null;
    }

    static decodePickingId(pixel) {
        return pixel[3] * 0x1000000 + ((pixel[0] << 16) | (pixel[1] << 8) | pixel[2]);
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

        const channels = {};
        let totalEntries = 0, totalIds = 0;
        for (const [name, ch] of this._channels) {
            let ids = 0;
            for (const e of ch.entries) ids += e.endId - e.startId;
            channels[name] = { layer: ch.layer, kind: ch.kind, entries: ch.entries.length, ids };
            totalEntries += ch.entries.length;
            totalIds += ids;
        }

        return {
            channels,
            totalEntries,
            totalIds,
            targetWidth: target?.width ?? 0,
            targetHeight: target?.height ?? 0,
            targetBytes,
            resolutionScale: this._scale,
            lastRenderMs: this._lastRenderMs ?? 0,
            lastReadMs: this._lastReadMs ?? 0,
            lastTotalMs: this._lastTotalMs ?? 0,
        };
    }

    dispose() {
        for (const ch of this._channels.values()) {
            for (const entry of ch.entries) {
                entry.mesh?.layers.disable(ch.layer);
                if (!entry.callerOwned && entry.material) {
                    entry.material.dispose();
                }
            }
            ch.entries = [];
        }
        if (this._target) {
            this._target.dispose();
            this._target = null;
        }
    }
}

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
 *   - 'grid'  (layer 8, kind 'flat')  — one solid quad per grid (the background
 *     panel), ID = base, resolves to { token: grid } → whole-panel grid-level.
 *   - 'handle' (layer 9, kind 'flat') — small per-viewport control meshes (terminal
 *     resize grips), ID = base, resolves to { token } → e.g. { grid, edge }.
 *
 * Add more (buttons, control surfaces, …) with defineChannel(name,{layer,kind}).
 * Hit-test a channel with pickAsync(name, camera, scene); they're independent, so
 * a caller reads whichever channel(s) it cares about (hover reads 'grid' — cheap,
 * just the panels; char features read 'glyph').
 *
 * Picking IDs are 24-bit integers encoded as RGB. Black (0,0,0) = "no hit".
 * Per-channel IDs are allocated first-fit over that channel's LIVE entries, so a
 * pickable's block is reclaimed when it unregisters (every flush/resize
 * re-registers) — bounded by the sum of live counts, never leaking toward the
 * 24-bit ceiling.
 */

import * as THREE from 'three';

// TSL imports for WebGPU picking materials — loaded lazily so PickingSystem
// works with both WebGLRenderer (no TSL needed) and WebGPURenderer.
// We import directly from three/webgpu because the importmap maps 'three' to
// the webgpu build at runtime; this bare specifier works in browser ES modules.
let _tslLoaded = false;
let _MeshBasicNodeMaterial, _Fn, _attribute, _uniform, _texture, _textureLoad,
    _vec2, _vec3, _vec4, _ivec2, _float, _int, _instanceIndex,
    _modelViewMatrix, _cameraProjectionMatrix, _positionLocal, _If, _Return, _select;
// The shared instance→clip transform — the SAME graph GlyphField's render material
// uses, so the pick ID pass can't drift from the visible glyph. Resolved lazily with
// the rest (dynamic-imported) to keep three/tsl out of the WebGL-only path.
let _buildGlyphVertexTransform;

async function _loadTSL() {
    if (_tslLoaded) return;
    const m = await import('three/webgpu');
    _MeshBasicNodeMaterial    = m.MeshBasicNodeMaterial;
    // TSL symbols live on m.TSL, not directly on the module
    const tsl                 = m.TSL;
    _Fn                       = tsl.Fn;
    _attribute                = tsl.attribute;
    _uniform                  = tsl.uniform;
    _texture                  = tsl.texture;
    _textureLoad              = tsl.textureLoad;
    _vec2                     = tsl.vec2;
    _vec3                     = tsl.vec3;
    _vec4                     = tsl.vec4;
    _ivec2                    = tsl.ivec2;
    _float                    = tsl.float;
    _int                      = tsl.int;
    _instanceIndex            = tsl.instanceIndex;
    _modelViewMatrix          = tsl.modelViewMatrix;
    _cameraProjectionMatrix   = tsl.cameraProjectionMatrix;
    _positionLocal            = tsl.positionLocal;
    _If                       = tsl.If;
    _Return                   = tsl.Return;
    _select                   = tsl.select;
    // Shared with the render material (core/glyphVertex). Its top-level
    // `import 'three/tsl'` only fires here — inside the WebGPU-only lazy path —
    // so the lazy/WebGL contract holds.
    ({ buildGlyphVertexTransform: _buildGlyphVertexTransform } =
        await import('../core/glyphVertex.js'));
    _tslLoaded = true;
}

// Built-in channels. Each gets a distinct THREE render layer so the picking
// camera can isolate it (renders ONLY that layer → the ID buffer is free of
// every other channel and of non-pickable scene-graph noise). The meshes stay
// on layer 0 too, so the main render pass is unaffected. New channels claim the
// next free layer (8 used by 'grid', so buttons would take 9, etc.).
const DEFAULT_CHANNELS = {
    glyph:  { layer: 7, kind: 'glyph' },
    grid:   { layer: 8, kind: 'flat'  },
    handle: { layer: 9, kind: 'flat'  }, // resize grips / control surfaces — one constant id per mesh
    group:  { layer: 10, kind: 'flat' }, // container volumes (agent-trail corridor boxes) — LOWEST pick precedence; a grid/card hover beats it
};

// ---------------------------------------------------------------------------
// WebGL (GLSL) picking shaders. Two glyph modes + a flat (solid-quad) mode.
//   glyph 'cell'  — solid quad, entire glyph cell is pickable
//   glyph 'glyph' — Slug winding number coverage, only rendered strokes pick
//   flat          — one constant ID over a plain mesh (grid panels, buttons)
// (WebGPU uses TSL NodeMaterials built below; these are the WebGLRenderer path.)
// ---------------------------------------------------------------------------

// Shared vertex core — position + group visibility
const PICKING_VERTEX_CORE = `
precision highp float;

in vec4 instancePosition;   // stride-4 (.w padding) — matches the WebGPU/TSL attribute
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

    vec3 worldPos = scaled + alignOffset + instancePosition.xyz * gScale.xyz + gPos.xyz;
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

    vec3 worldPos = scaled + alignOffset + instancePosition.xyz * gScale.xyz + gPos.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
    vPickingId = uBasePickingId + gl_InstanceID;

    int gid = int(instanceGlyphId);
    int mapCol = gid % int(glyphMapWidth);
    int mapRow = gid / int(glyphMapWidth);
    uvec4 glyphInfo = texelFetch(glyphMapTexture, ivec2(mapCol, mapRow), 0);
    vCurveStart      = int(glyphInfo.x);
    vCurveCount      = int(glyphInfo.y);
    vGlyphUV = uv;
}
`;

const PICKING_FRAGMENT_GLYPH = `
precision highp float;
precision highp int;

#define MAX_CURVES 256

uniform highp usampler2D curveTexture;

flat in int vPickingId;
flat in int vCurveStart;
flat in int vCurveCount;
in vec2 vGlyphUV;

out vec4 fragColor;

float unpackCoord(uint bits) { return float(bits) / 65535.0; }

// Binary winding contribution of one quadratic Bezier against a +X ray from p.
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
    if (vCurveCount == 0) discard;

    // Hit test: non-zero winding rule over all of the glyph's curves.
    // Binary (no anti-aliasing) is correct for a per-pixel pick — matches
    // the main shader's direct curve iteration, no band structure.
    vec2 p = vGlyphUV;
    int winding = 0;
    for (int i = 0; i < MAX_CURVES; i++) {
        if (i >= vCurveCount) break;
        int ci = (vCurveStart + i) * 2;
        uvec4 t0 = texelFetch(curveTexture, ivec2(ci % 1024, ci / 1024), 0);
        uvec4 t1 = texelFetch(curveTexture, ivec2((ci+1) % 1024, (ci+1) / 1024), 0);
        vec2 cp0 = vec2(unpackCoord(t0.x), unpackCoord(t0.y));
        vec2 cp1 = vec2(unpackCoord(t0.z), unpackCoord(t0.w));
        vec2 cp2 = vec2(unpackCoord(t1.x), unpackCoord(t1.y));
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

// Flat mode: a plain mesh (grid panel, button) projected normally, every fragment
// emitting one constant ID. Covers the whole surface — the grid-level pickable.
const PICKING_VERTEX_FLAT = `
precision highp float;
void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const PICKING_FRAGMENT_FLAT = `
precision highp float;
precision highp int;
uniform int uPickId;
out vec4 fragColor;
void main() {
    int id = uPickId;
    int r = (id >> 16) & 0xFF;
    int g = (id >> 8) & 0xFF;
    int b = id & 0xFF;
    fragColor = vec4(float(r) / 255.0, float(g) / 255.0, float(b) / 255.0, 1.0);
}
`;

// ---------------------------------------------------------------------------

export class PickingSystem {
    /**
     * @param {THREE.WebGLRenderer|THREE.WebGPURenderer} threeRenderer
     * @param {Object} [options]
     * @param {number} [options.resolutionScale=1.0]
     * @param {'cell'|'glyph'} [options.mode='cell'] - glyph-channel hit shape:
     *   'cell' picks the full glyph quad, 'glyph' alpha-tests against the atlas so
     *   only rendered strokes pick.
     */
    constructor(threeRenderer, options = {}) {
        this._renderer = threeRenderer;
        this._scale = options.resolutionScale ?? 1.0;
        this._mode = options.mode ?? 'cell';

        // Detect WebGPU renderer — ShaderMaterial doesn't work there.
        this._isWebGPU = threeRenderer.isWebGPURenderer === true;

        // The shared WebGPU pick materials (one TSL build each, per-object IDs).
        this._sharedGlyphPickMaterial = null;
        this._sharedFlatPickMaterial  = null;

        // Eagerly start loading TSL if on WebGPU (async, resolves from module
        // cache when GlyphField has already been imported by the caller).
        this._tslReady = this._isWebGPU ? _loadTSL() : Promise.resolve();

        // Channels: name -> { layer, kind, entries: [{ mesh, material, startId, endId, token }] }
        this._channels = new Map();
        for (const [name, def] of Object.entries(DEFAULT_CHANNELS)) {
            this.defineChannel(name, def);
        }

        // Picking target and readback buffer
        this._target = null;
        this._readBuffer = new Uint8Array(4);
        this._sizeVec = new THREE.Vector2(); // reusable for getSize()

        // Mouse position in target-pixel coordinates
        this._mousePixel = { x: -1, y: -1 };

        // Dirty flag — only render+read when the cursor moved (setMousePosition)
        // or the caller forced it (markDirty, e.g. camera moved under a still
        // cursor). pickAsync caches the last resolved hit per channel and returns
        // it while clean, so re-picking a stationary view is free.
        this._needsPick = false;
        this._lastResult = new Map(); // channel -> last resolved hit | null

        this._createTarget();
    }

    // -------------------------------------------------------------------------
    // Channels
    // -------------------------------------------------------------------------

    /**
     * Define a pickable channel. Idempotent per name (redefining replaces the
     * config but keeps existing entries only if the layer is unchanged).
     * @param {string} name
     * @param {{ layer: number, kind: 'glyph'|'flat' }} def
     */
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
        return channel.kind === 'glyph' ? target?.instanceMesh : target;
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
        // Invalidate so the next frame forces a fresh read.
        this._needsPick = true;
        this._lastResult.clear();
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
        // THREE.RenderTarget works for both WebGL and WebGPU (WebGLRenderTarget
        // is a subclass alias that also works with WebGPURenderer in r183).
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

    /**
     * Force the next pickAsync to actually render+read, even if the mouse pixel
     * did not change. setMousePosition only dirties on pixel change, so a camera
     * move under a stationary cursor (pan / zoom / drag, which fire no pointer
     * event) would otherwise reuse a stale pick. The hover loop calls this
     * whenever the camera transform changed.
     */
    markDirty() {
        this._needsPick = true;
    }

    // -------------------------------------------------------------------------
    // Picking materials
    // -------------------------------------------------------------------------

    /**
     * WebGPU 'glyph' material: TSL NodeMaterial mirroring GlyphField's vertex
     * (instanced group-DataTexture worldPos), emitting ID = base + instanceIndex.
     *
     * SHARED across every registered field — one TSL build total (a build per mesh
     * made the FIRST pick pass pay ~269 graph builds at once). Per-mesh state
     * resolves per object: the field rides mesh.userData.glyphField (set by
     * GlyphField) and the ID-block start rides mesh.userData.pickStartId (set by
     * register; one value per mesh — a mesh registered in two channels would
     * collide, which the channel design never does).
     * @private
     */
    _getTSLGlyphMaterial() {
        if (this._sharedGlyphPickMaterial) return this._sharedGlyphPickMaterial;

        // Per-object nodes the shared vertex transform reads — each resolves at draw
        // from the mesh's userData.glyphField (mirrors GlyphField's _fieldTexture /
        // _fieldUniform). Picking now binds the SAME inputs the render material does,
        // so a non-unit group scale, width compress, emoji square quad, and the clip
        // window all match the glyph the user sees — the drift this builder exists to kill.
        const floatPh = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
        floatPh.minFilter = floatPh.magFilter = THREE.NearestFilter;
        floatPh.generateMipmaps = false; floatPh.needsUpdate = true;
        const uintPh = new THREE.DataTexture(new Uint32Array(4), 1, 1, THREE.RGBAIntegerFormat, THREE.UnsignedIntType);
        uintPh.minFilter = uintPh.magFilter = THREE.NearestFilter;
        uintPh.generateMipmaps = false; uintPh.needsUpdate = true;

        const fTex = (prop, ph) => _texture(ph).onObjectUpdate(({ object }, self) =>
            (object && object.userData.glyphField && object.userData.glyphField[prop]) || self.value);
        const fUni = (prop, init) => _uniform(init).onObjectUpdate(({ object }, self) =>
            (object && object.userData.glyphField) ? (object.userData.glyphField[prop] ?? init) : self.value);

        const groupTex      = fTex('_groupTexture', floatPh);
        const glyphMapTex   = fTex('_glyphMapTexture', uintPh);
        const glyphMapWidth = fUni('_glyphMapWidth', 1);
        const renderMode    = fUni('_renderMode', 0 /* RENDER_MODE.GLYPH */);
        const clipEnabled   = fUni('_clipEnabledVal', 0);
        const clipTop       = fUni('_clipTopVal', 0);
        const clipBottom    = fUni('_clipBottomVal', 0);

        // Per-mesh ID-block start (read straight off userData — set by register()).
        const baseId = _uniform(0).onObjectUpdate(({ object }, self) =>
            (object && object.userData.pickStartId != null) ? object.userData.pickStartId : self.value);

        const vertexFn = _Fn(() => {
            // The ONE transform graph — shared with the render material via
            // core/glyphVertex. The instance attributes (instancePosition/Size/
            // GlyphId/GroupId) are declared inside it by name and bind to this mesh.
            const { clipPos } = _buildGlyphVertexTransform({
                glyphMapTex, glyphMapWidth, renderMode, groupTex, clipEnabled, clipTop, clipBottom,
            });
            return clipPos;
        });

        const fragmentFn = _Fn(() => {
            // int-cast the (float) per-object uniform so the bit ops stay exact.
            const id = _int(baseId).add(_int(_instanceIndex));
            const r  = id.shiftRight(16).bitAnd(0xFF);
            const g  = id.shiftRight(8).bitAnd(0xFF);
            const b  = id.bitAnd(0xFF);
            return _vec4(_float(r).div(255.0), _float(g).div(255.0), _float(b).div(255.0), _float(1));
        });

        const mat = new _MeshBasicNodeMaterial();
        mat.vertexNode = vertexFn();
        mat.outputNode = fragmentFn();
        mat.side = THREE.DoubleSide;
        // depthWrite MUST stay on: the pass is opaque against a depth buffer
        // cleared to far, so depthWrite+depthTest gives nearest-wins occlusion.
        // Off, a FARTHER overlapping glyph would overwrite a nearer one's ID
        // pixel — picking the wrong (back) grid.
        mat.depthWrite = true;

        this._sharedGlyphPickMaterial = mat;
        return mat;
    }

    /**
     * WebGPU 'flat' material: a plain mesh (grid panel / button) projected
     * normally, every fragment emitting one constant ID. The default NodeMaterial
     * vertex handles projection from the mesh's own world matrix.
     *
     * SHARED across every flat pickable — the ID rides mesh.userData.pickStartId.
     * @private
     */
    _getTSLFlatMaterial() {
        if (this._sharedFlatPickMaterial) return this._sharedFlatPickMaterial;

        const baseId = _uniform(0).onObjectUpdate(({ object }, self) =>
            (object && object.userData.pickStartId != null) ? object.userData.pickStartId : self.value);
        const fragmentFn = _Fn(() => {
            const id = _int(baseId);
            const r = id.shiftRight(16).bitAnd(0xFF);
            const g = id.shiftRight(8).bitAnd(0xFF);
            const b = id.bitAnd(0xFF);
            return _vec4(_float(r).div(255.0), _float(g).div(255.0), _float(b).div(255.0), _float(1));
        });
        const mat = new _MeshBasicNodeMaterial();
        mat.outputNode = fragmentFn();
        mat.side = THREE.DoubleSide;
        mat.depthWrite = true; // nearest panel wins in an overlap (front grid)

        this._sharedFlatPickMaterial = mat;
        return mat;
    }

    /**
     * WebGL 'glyph' material: classic ShaderMaterial (cell or Slug-winding mode).
     * @private
     */
    _createGLSLGlyphMaterial(glyphRenderer, mesh, startId) {
        const uniforms = {
            groupTexture:       { value: glyphRenderer._groupTexture },
            groupTextureHeight: { value: glyphRenderer._maxGroups },
            uBasePickingId:     { value: startId },
        };
        let vertexShader, fragmentShader;
        if (this._mode === 'glyph') {
            const mainUniforms = mesh.material.uniforms;
            uniforms.curveTexture    = mainUniforms.curveTexture;
            uniforms.glyphMapTexture = mainUniforms.glyphMapTexture;
            uniforms.glyphMapWidth   = mainUniforms.glyphMapWidth;
            uniforms.glyphMapHeight  = mainUniforms.glyphMapHeight;
            vertexShader   = PICKING_VERTEX_GLYPH;
            fragmentShader = PICKING_FRAGMENT_GLYPH;
        } else {
            vertexShader   = PICKING_VERTEX_CELL;
            fragmentShader = PICKING_FRAGMENT_CELL;
        }
        return new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3, uniforms, vertexShader, fragmentShader, side: THREE.DoubleSide,
        });
    }

    /**
     * WebGL 'flat' material: solid-quad ShaderMaterial emitting one constant ID.
     * @private
     */
    _createGLSLFlatMaterial(id) {
        return new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3,
            uniforms: { uPickId: { value: id } },
            vertexShader: PICKING_VERTEX_FLAT,
            fragmentShader: PICKING_FRAGMENT_FLAT,
            side: THREE.DoubleSide,
        });
    }

    // -------------------------------------------------------------------------
    // Registration
    // -------------------------------------------------------------------------

    /**
     * Register a pickable into a channel. For a 'glyph' channel, `target` is the
     * GlyphField renderer (its instanceMesh is the pickable, ID = base +
     * instanceIndex). For a 'flat' channel, `target` is the mesh itself (one
     * constant ID). `token` is returned verbatim from resolve()/pickAsync() — by
     * convention the renderer for 'glyph' (so resolveGlyph works), the grid for
     * 'grid'. Re-register after any rebuild that changes instanceCount.
     *
     * @param {string} channelName
     * @param {*} target - renderer ('glyph') or mesh ('flat')
     * @param {*} token  - what a hit resolves to
     * @returns {number} the startId assigned (0 if nothing to register)
     */
    register(channelName, target, token) {
        const ch = this._channel(channelName);
        const mesh = this._meshOf(ch, target);
        if (!mesh?.geometry) return 0;

        // Drop any prior entry for this mesh first, so its ID block is free for
        // first-fit reuse below (re-register-in-place on flush/resize).
        this.unregister(channelName, target);

        const count = ch.kind === 'glyph' ? (mesh.geometry.instanceCount || 0) : 1;
        if (count === 0) return 0;

        // First-fit over this channel's LIVE entries: lowest startId >= 1 whose
        // [startId, startId+count) overlaps no current entry. Reclaims interior
        // gaps so the per-channel ID space stays bounded by the sum of live counts.
        const ranges = ch.entries.map(e => [e.startId, e.endId]).sort((a, b) => a[0] - b[0]);
        let startId = 1;
        for (const [s, e] of ranges) {
            if (startId + count <= s) break;   // fits in the gap before this block
            if (e > startId) startId = e;        // else move past this block
        }
        const endId = startId + count;
        if (endId > 0xFFFFFF) {
            console.warn(`[PickingSystem] channel '${channelName}' ID ${endId} exceeds 24-bit encoding; picks may mis-resolve`);
        }

        // Glyph channel: write instancePickingId so test harnesses can validate
        // sequential IDs (the shader derives the real ID as base + instanceIndex).
        if (ch.kind === 'glyph') {
            const pickIdAttr = mesh.geometry.attributes.instancePickingId;
            if (pickIdAttr) {
                for (let i = 0; i < count; i++) pickIdAttr.array[i] = startId + i;
                pickIdAttr.needsUpdate = true;
            }
        }

        let material;
        if (this._isWebGPU) {
            if (!_tslLoaded) {
                throw new Error('[PickingSystem] TSL not loaded. Await pickingSystem._tslReady before register() on WebGPU.');
            }
            // Shared pick materials read the ID block per object from here.
            mesh.userData.pickStartId = startId;
            material = ch.kind === 'glyph'
                ? this._getTSLGlyphMaterial()
                : this._getTSLFlatMaterial();
        } else {
            material = ch.kind === 'glyph'
                ? this._createGLSLGlyphMaterial(target, mesh, startId)
                : this._createGLSLFlatMaterial(startId);
        }

        // Enable the channel's layer so its isolated pass renders this mesh (it
        // stays on layer 0 too, so the main pass is unaffected). Paired with
        // registry membership — disabled in unregister.
        mesh.layers.enable(ch.layer);

        ch.entries.push({ mesh, material, startId, endId, token });
        return startId;
    }

    /**
     * Remove a pickable from a channel.
     * @param {string} channelName
     * @param {*} target - the same renderer ('glyph') or mesh ('flat') passed to register
     */
    unregister(channelName, target) {
        const ch = this._channel(channelName);
        const mesh = this._meshOf(ch, target);
        if (!mesh) return;
        const idx = ch.entries.findIndex(e => e.mesh === mesh);
        if (idx === -1) return;
        const entry = ch.entries[idx];
        entry.mesh?.layers.disable(ch.layer);
        // WebGPU pick materials are SHARED (never disposed per entry); the WebGL
        // path still builds one per mesh.
        if (!this._isWebGPU) entry.material.dispose();
        ch.entries.splice(idx, 1);
    }

    // -------------------------------------------------------------------------
    // Render pass + read
    // -------------------------------------------------------------------------

    /**
     * Render ONE channel's pickables (material-swapped to their picking material,
     * camera isolated to the channel's layer) to the offscreen target. Restores
     * all mutated state in a finally so a throw can't corrupt the shared camera /
     * target / materials.
     * @private
     */
    _renderChannelPass(channel, camera, scene) {
        // Auto-resize target if renderer size changed (e.g. IDE ResizeObserver)
        const size = this._renderer.getSize(this._sizeVec);
        const dpr = this._renderer.getPixelRatio();
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
        }

        try {
            // Isolate to the channel's layer and clear to black. The app keeps
            // scene.background null (the backdrop is the renderer's clear color),
            // so empty pixels stay at our black clear == id 0 == no hit — no scene
            // mutation needed here.
            camera.layers.set(channel.layer);
            this._renderer.setRenderTarget(this._target);
            this._renderer.setClearColor(0x000000, 1);
            this._renderer.clear();
            this._renderer.render(scene, camera);
            this._lastRenderMs = performance.now() - t0;
        } finally {
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

    /**
     * Read the pixel at the current mouse position from the picking target.
     * @private
     * @returns {Promise<Uint8Array>} Four-byte RGBA pixel, or all-zeros if out of bounds.
     */
    async readPixelAsync(t0) {
        const { x, y } = this._mousePixel;
        const pixel = new Uint8Array(4);
        if (this._target && x >= 0 && y >= 0 && x < this._target.width && y < this._target.height) {
            if (this._isWebGPU && this._renderer.readRenderTargetPixelsAsync) {
                // WebGPU: async readback — Y=0 is top (same as CSS), no flip needed.
                const buf = await this._renderer.readRenderTargetPixelsAsync(this._target, x, y, 1, 1);
                const view = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
                pixel.set(view.subarray(0, 4));
            } else {
                // WebGL: synchronous readback (Y flipped).
                this._renderer.readRenderTargetPixels(this._target, x, this._target.height - 1 - y, 1, 1, this._readBuffer);
                pixel.set(this._readBuffer);
            }
        }
        if (t0 !== undefined) {
            const tRead = performance.now();
            this._lastReadMs = tRead - (t0 + (this._lastRenderMs ?? 0));
            this._lastTotalMs = tRead - t0;
        }
        return pixel;
    }

    /**
     * Hit-test a channel under the cursor: render its ID pass, read the pixel,
     * resolve to the hit. Gated by the dirty flag — while the view is unchanged
     * it returns the channel's cached last hit (no GPU work).
     *
     * NOTE: the dirty flag is shared, so picking MULTIPLE channels in one frame
     * needs a markDirty() between them. Current callers pick a single channel per
     * frame (hover → 'grid'), so this is free.
     *
     * @param {string} channelName
     * @param {THREE.Camera} camera
     * @param {THREE.Scene} scene
     * @returns {Promise<{ token: *, slotIndex: number } | null>}
     */
    async pickAsync(channelName, camera, scene) {
        const ch = this._channel(channelName);
        if (!this._needsPick) return this._lastResult.get(channelName) ?? null;
        this._needsPick = false;

        const t0 = this._renderChannelPass(ch, camera, scene);
        const pixel = await this.readPixelAsync(t0);
        const id = (pixel[0] << 16) | (pixel[1] << 8) | pixel[2];
        const hit = this.resolve(channelName, id);
        this._lastResult.set(channelName, hit);
        return hit;
    }

    // -------------------------------------------------------------------------
    // Resolution
    // -------------------------------------------------------------------------

    /**
     * Resolve a raw picking ID within a channel to { token, slotIndex }.
     * @param {string} channelName
     * @param {number} pickingId
     * @returns {{ token: *, slotIndex: number } | null}
     */
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

    /**
     * Resolve a buffer slot index within a glyph renderer to { textId, charIndex }.
     * @param {*} renderer
     * @param {number} slotIndex
     * @returns {{ textId: number, charIndex: number } | null}
     */
    resolveGlyph(renderer, slotIndex) {
        for (const [textId, entry] of renderer.renderedTexts) {
            const start = entry.bufferStartIndex;
            if (start === undefined) continue;
            const end = start + (entry.glyphCount || 0);
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
            for (const entry of ch.entries) entry.material.dispose();
            ch.entries = [];
        }
        if (this._target) {
            this._target.dispose();
            this._target = null;
        }
    }
}

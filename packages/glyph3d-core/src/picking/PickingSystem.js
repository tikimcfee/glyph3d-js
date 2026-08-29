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
 *
 * The pick materials are TSL NodeMaterials sharing the render material's vertex
 * transform (core/glyphVertex.js) — render and pick physically cannot drift.
 * WebGPU only: the constructor rejects any other renderer.
 */

import * as THREE from 'three';
import { MeshBasicNodeMaterial, StorageInstancedBufferAttribute, TSL } from 'three/webgpu';
import {
    buildGlyphVertexTransform,
    registerByteSlotsNode,
    registerByteSlotsMaterial,
    registerGroupMaterial,
    GROUP_STRIDE,
} from '../core/glyphVertex.js';

const { Fn, uniform, texture, storage, float, vec4, instanceIndex } = TSL;

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

export class PickingSystem {
    /**
     * @param {THREE.WebGPURenderer} threeRenderer
     * @param {Object} [options]
     * @param {number} [options.resolutionScale=1.0]
     */
    constructor(threeRenderer, options = {}) {
        if (threeRenderer?.isWebGPURenderer !== true) {
            throw new Error('[PickingSystem] requires a WebGPURenderer — the ID pass is TSL NodeMaterials only');
        }
        this._renderer = threeRenderer;
        this._scale = options.resolutionScale ?? 1.0;

        // The shared pick materials (one TSL build each, per-object IDs).
        this._sharedGlyphPickMaterial = null;
        this._sharedGlyphPickMaterialByte = null;
        this._sharedFlatPickMaterial  = null;

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
        this._target = new THREE.RenderTarget(w, h, {
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
     * The 'glyph' pick material: a TSL NodeMaterial mirroring GlyphField's vertex
     * (instanced group-texture worldPos), emitting ID = base + instanceIndex.
     *
     * SHARED across every registered field — one TSL build total (a build per mesh
     * made the FIRST pick pass pay ~269 graph builds at once). Per-mesh state
     * resolves per object: the field rides mesh.userData.glyphField (set by
     * GlyphField) and the ID-block start rides mesh.userData.pickStartId (set by
     * register; one value per mesh — a mesh registered in two channels would
     * collide, which the channel design never does).
     * @private
     */
    _getGlyphPickMaterial(byteMode = false) {
        const cacheKey = byteMode ? '_sharedGlyphPickMaterialByte' : '_sharedGlyphPickMaterial';
        if (this[cacheKey]) return this[cacheKey];

        // Per-object nodes the shared vertex transform reads — each resolves at draw
        // from the mesh's userData.glyphField (mirrors GlyphField's _fieldTexture /
        // _fieldUniform / _fieldGroups). Picking binds the SAME inputs the render
        // material does, so a non-unit group scale, width compress, emoji square
        // quad, and the clip window all match the glyph the user sees — the drift
        // this builder exists to kill.
        const uintPh = new THREE.DataTexture(new Uint32Array(4), 1, 1, THREE.RGBAIntegerFormat, THREE.UnsignedIntType);
        uintPh.minFilter = uintPh.magFilter = THREE.NearestFilter;
        uintPh.generateMipmaps = false; uintPh.needsUpdate = true;

        const fTex = (prop, ph) => texture(ph).onObjectUpdate(({ object }, self) =>
            (object && object.userData.glyphField && object.userData.glyphField[prop]) || self.value);
        const fUni = (prop, init) => uniform(init).onObjectUpdate(({ object }, self) =>
            (object && object.userData.glyphField) ? (object.userData.glyphField[prop] ?? init) : self.value);

        // The group-table storage node — the field's row buffer, resolved per object.
        const groupsPh = new StorageInstancedBufferAttribute(new Float32Array(GROUP_STRIDE * 4), 4);
        const groups   = storage(groupsPh, 'vec4', GROUP_STRIDE).toReadOnly().onObjectUpdate(({ object }, self) =>
            (object && object.userData.glyphField && object.userData.glyphField._groupAttr) || self.value);
        const maxGroups     = fUni('_maxGroups', 1);
        const glyphMapTex   = fTex('_glyphMapTexture', uintPh);
        const glyphMapWidth = fUni('_glyphMapWidth', 1);
        const renderMode    = fUni('_renderMode', 0 /* RENDER_MODE.GLYPH */);
        // Clip is per-GROUP row state (col 4) — read inside the shared transform,
        // no per-object uniforms.

        // Byte-pipeline fields read position/size/glyphId from the pipeline's slot buffer
        // (GlyphField._fieldSlots does the same for the render material — one buffer,
        // instance index == arena slot).
        let byteSlots = null;
        if (byteMode) {
            // 'uint', matching the slot buffer's own type (glyphPipelineKernels: the
            // slots array is instancedArray(..., 'uint')). This declaration is what the
            // shader reads the memory AS — WGSL will bind the same bytes as array<f32>
            // with no validation error, so a stale 'float' here silently reinterprets
            // every count lane as a denormal (row 5 -> 0x5 -> ~7e-45 -> 0) and makes
            // glyphVertex's .toFloat() a no-op. Near text is unaffected; the far-LOD UV
            // collapses to texel (0,0) for every glyph. Nothing errors.
            const placeholder = new StorageInstancedBufferAttribute(new Uint32Array(4), 1);
            byteSlots = registerByteSlotsNode(storage(placeholder, 'uint', 1).toReadOnly().onObjectUpdate(({ object }, self) =>
                (object && object.userData.glyphField && object.userData.glyphField._byteSlots) || self.value));
        }

        // Per-mesh ID-block start (read straight off userData — set by register()).
        // 'uint', NOT the default float. A pick ID is an exact identity, and uniform(0)
        // from a JS number is an f32 carrier: base 16,777,217 lands as 16,777,216 and
        // two glyphs answer to one ID. Reachable since the arena ceiling moved —
        // ARENA_MAX_BYTES itself aliases (44,739,242 -> 44,739,240).
        const baseId = uniform(0, 'uint').onObjectUpdate(({ object }, self) =>
            (object && object.userData.pickStartId != null) ? object.userData.pickStartId : self.value);

        const vertexFn = Fn(() => {
            // The ONE transform graph — shared with the render material via
            // core/glyphVertex. The instance attributes (instancePosition/Size/
            // GlyphId/GroupId) are declared inside it by name and bind to this mesh.
            const { clipPos } = buildGlyphVertexTransform({
                glyphMapTex, glyphMapWidth, renderMode, groups, maxGroups,
                byteSlots,
            });
            return clipPos;
        });

        const fragmentFn = Fn(() => {
            // Both operands are u32: baseId is a 'uint' uniform and instanceIndex is
            // natively unsigned, so no cast is needed and none is safe — int() would cap
            // the ID space at 2^31 AND make shiftRight arithmetic (sign-extending)
            // rather than logical, corrupting the alpha byte for any id >= 2^31.
            const id = baseId.add(instanceIndex);
            const r  = id.shiftRight(16).bitAnd(0xFF);
            const g  = id.shiftRight(8).bitAnd(0xFF);
            const b  = id.bitAnd(0xFF);
            const a  = id.shiftRight(24).bitAnd(0xFF);
            return vec4(float(r).div(255.0), float(g).div(255.0), float(b).div(255.0), float(a).div(255.0));
        });

        const mat = new MeshBasicNodeMaterial();
        mat.vertexNode = vertexFn();
        mat.outputNode = fragmentFn();
        mat.side = THREE.DoubleSide;
        // depthWrite MUST stay on: the pass is opaque against a depth buffer
        // cleared to far, so depthWrite+depthTest gives nearest-wins occlusion.
        // Off, a FARTHER overlapping glyph would overwrite a nearer one's ID
        // pixel — picking the wrong (back) grid.
        mat.depthWrite = true;

        if (byteMode) registerByteSlotsMaterial(mat);
        registerGroupMaterial(mat);
        this[cacheKey] = mat;
        return mat;
    }

    /**
     * The 'flat' pick material: a plain mesh (grid panel / button) projected
     * normally, every fragment emitting one constant ID. The default NodeMaterial
     * vertex handles projection from the mesh's own world matrix.
     *
     * SHARED across every flat pickable — the ID rides mesh.userData.pickStartId.
     * @private
     */
    _getFlatPickMaterial() {
        if (this._sharedFlatPickMaterial) return this._sharedFlatPickMaterial;

        const baseId = uniform(0, 'uint').onObjectUpdate(({ object }, self) =>
            (object && object.userData.pickStartId != null) ? object.userData.pickStartId : self.value);
        const fragmentFn = Fn(() => {
            const id = baseId;
            const r = id.shiftRight(16).bitAnd(0xFF);
            const g = id.shiftRight(8).bitAnd(0xFF);
            const b = id.bitAnd(0xFF);
            const a = id.shiftRight(24).bitAnd(0xFF);
            return vec4(float(r).div(255.0), float(g).div(255.0), float(b).div(255.0), float(a).div(255.0));
        });
        const mat = new MeshBasicNodeMaterial();
        mat.outputNode = fragmentFn();
        mat.side = THREE.DoubleSide;
        mat.depthWrite = true; // nearest panel wins in an overlap (front grid)

        this._sharedFlatPickMaterial = mat;
        return mat;
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
     * @param {Object} [opts]
     * @param {number} [opts.count] - explicit ID-block size for a 'glyph' channel,
     *   overriding the live instanceCount. The mega-field registers ONCE at its
     *   CAPACITY: unoccupied slots are vertex-culled (dead group) so they can never
     *   be picked, and a stable block means no per-attach re-registration (a
     *   re-register per load rewrote the capacity-sized ID mirror per file — the
     *   O(storm × arena) microtask burn). Also honored for a 'flat' channel WITH
     *   opts.material — an instanced flat pickable (the panel field) spans a block.
     * @param {THREE.Material} [opts.material] - a caller-built ID material (its
     *   vertex transform shared with the caller's render material — the no-drift
     *   law). The block start still lands on mesh.userData.pickStartId. Never
     *   disposed by unregister (caller-owned).
     * @returns {number} the startId assigned (0 if nothing to register)
     */
    register(channelName, target, token, opts) {
        const ch = this._channel(channelName);
        const mesh = this._meshOf(ch, target);
        if (!mesh?.geometry) return 0;

        // Drop any prior entry for this mesh first, so its ID block is free for
        // first-fit reuse below (re-register-in-place on flush/resize).
        this.unregister(channelName, target);

        const count = ch.kind === 'glyph'
            ? (opts?.count || mesh.geometry.instanceCount || 0)
            : (opts?.material ? (opts?.count || 1) : 1);
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
        // The REAL ID space, now that base and index are both u32: [1, 2^32). ID 0 is
        // reserved for "nothing" (the pass clears to it), so the last usable id is
        // 0xFFFFFFFF and endId is exclusive.
        //
        // This used to warn at 0x7FFFFFFF, which was wrong twice: 128x too permissive
        // against the f32 uniform's true 2^24 limit, and a WARN for a condition that
        // silently returns the wrong glyph from every subsequent click. A pick that
        // mis-resolves has no symptom at the seam — the app just acts on the wrong
        // target — so this refuses rather than narrates.
        if (endId > 0x100000000) {
            throw new Error(
                `[PickingSystem] channel '${channelName}': ID block [${startId}, ${endId}) `
                + `exceeds the u32 pick-ID space (max ${0x100000000}). ${count} ids requested `
                + `with ${ch.entries.length} blocks already live — unregister dead meshes or `
                + 'split the channel.');
        }

        // Glyph channel: write instancePickingId so test harnesses can validate
        // sequential IDs (the shader derives the real ID as base + instanceIndex).
        // Uint32Array, matching the shader's carrier — as a Float32Array this mirror
        // aliased past 2^24 while the shader (once u32) did not, so the harness would
        // have disagreed with the thing it exists to check.
        if (ch.kind === 'glyph') {
            const pickIdAttr = mesh.geometry.attributes.instancePickingId;
            if (pickIdAttr) {
                for (let i = 0; i < count; i++) pickIdAttr.array[i] = startId + i;
                pickIdAttr.needsUpdate = true;
            }
        }

        // Shared pick materials read the ID block per object from here; a
        // caller-built material (opts.material) follows the same contract.
        mesh.userData.pickStartId = startId;
        const material = opts?.material ?? (ch.kind === 'glyph'
            ? this._getGlyphPickMaterial(!!mesh.userData.glyphField?._bytePipeline)
            : this._getFlatPickMaterial());

        // Enable the channel's layer so its isolated pass renders this mesh (it
        // stays on layer 0 too, so the main pass is unaffected). Paired with
        // registry membership — disabled in unregister.
        mesh.layers.enable(ch.layer);

        ch.entries.push({ mesh, material, startId, endId, token, callerOwned: !!opts?.material });
        return startId;
    }

    /**
     * Remove a pickable from a channel. Materials are shared (or caller-owned)
     * and survive the entry.
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
            this._renderer.setClearColor(0x000000, 0);   // a=0: background decodes to id 0 (miss)
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
     * Async GPU readback — Y=0 is top (same as CSS), no flip.
     * @private
     * @returns {Promise<Uint8Array>} Four-byte RGBA pixel, or all-zeros if out of bounds.
     */
    async readPixelAsync(t0) {
        const { x, y } = this._mousePixel;
        const pixel = new Uint8Array(4);
        if (this._target && x >= 0 && y >= 0 && x < this._target.width && y < this._target.height) {
            const buf = await this._renderer.readRenderTargetPixelsAsync(this._target, x, y, 1, 1);
            const view = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
            pixel.set(view.subarray(0, 4));
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
        const id = pixel[3] * 0x1000000 + ((pixel[0] << 16) | (pixel[1] << 8) | pixel[2]);
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
            for (const entry of ch.entries) entry.mesh?.layers.disable(ch.layer);
            ch.entries = [];
        }
        // The shared pick materials are system-owned; caller-owned materials
        // (opts.material) are never touched.
        this._sharedGlyphPickMaterial?.dispose();
        this._sharedGlyphPickMaterialByte?.dispose();
        this._sharedFlatPickMaterial?.dispose();
        this._sharedGlyphPickMaterial = null;
        this._sharedGlyphPickMaterialByte = null;
        this._sharedFlatPickMaterial = null;
        if (this._target) {
            this._target.dispose();
            this._target = null;
        }
    }
}

/**
 * InstancedField — WebGL2 Instanced Glyph Field Renderer.
 *
 * Implements the 32-byte RenderSlot architecture proven in glyph3d-rs/crates/glyph-field-instanced.
 * Uses standard Three.js InstancedBufferGeometry and GLSL 3.00 ES ShaderMaterial for
 * universal compatibility across WebGL2 and WebGPU without monolithic compute pipelines.
 */

import * as THREE from 'three';
import {
    InstancedSlotBuffer, packRgba8, groupOf, SLOT_FLOATS, LANE_ADVANCE, LANE_HEIGHT, LANE_COLOR, LANE_GROUP_ID, GROUP_ID_BITS,
} from '../core/InstancedSlotBuffer.js';
import { createGlyphMaterial, createGlyphFillMaterial, GROUP_STRIDE } from '../core/glyphMaterial.js';
import { generateLayout } from '../core/LayoutGenerator.js';
import { computeCellMetrics } from '../core/cellMetrics.js';
import { PERF_THRESHOLDS } from '../core/constants.js';

/** Every live field, in creation order — what the far-LOD pass (GlyphFarLod) walks each frame. */
const _liveFields = new Set();

/** The live fields, in creation order. */
export function liveInstancedFields() {
    return _liveFields;
}

/** Whether a Uint32 over RGBA8 bytes holds r in its low byte (highlightWords' packing). */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * A group table's texture: GROUP_STRIDE texels across, one row per group, float RGBA, nearest.
 * @param {Float32Array} data @param {number} rows @returns {THREE.DataTexture}
 */
function makeGroupTexture(data, rows) {
    const tex = new THREE.DataTexture(data, GROUP_STRIDE, rows, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
}

/**
 * Partial uploads for one GPU target (the slot buffer, or the highlight texture). A write marks
 * the range it touched and three uploads just those (`updateRanges`, merged and emptied by three
 * after the upload — never cleared here: a cleared range is a write the GPU never sees).
 *
 * Two things make a target upload WHOLE until its next upload, and while it is whole a ranged
 * mark adds no range (a range would turn the whole upload partial): a target that has never
 * been uploaded (a fresh buffer or texture), and a whole-target write while ranges are pending
 * (it adds ranges covering everything first). Ranges come from a pool — three's addUpdateRange
 * makes an object per call, garbage on a target written every frame — and a target left
 * un-uploaded (culled, hidden) stops collecting them at MAX_PENDING_RANGES and goes whole.
 */
const MAX_PENDING_RANGES = 64;
class UploadRanges {
    /** @param {(target: Object) => void} coverAll  adds ranges covering the whole target */
    constructor(coverAll) {
        this._coverAll = coverAll;
        this.target = null;
        this.whole = true;
        this._pool = [];
        this._used = 0;
    }

    /**
     * Follow a new target: it uploads whole once, then ranged.
     * @param {Object} target  an InterleavedBuffer or a DataTexture
     * @param {(cb: () => void) => void} onUploaded  registers cb to run after three uploads it
     */
    track(target, onUploaded) {
        this.target = target;
        this.whole = true;
        this._used = 0;
        onUploaded(() => { if (this.target === target) this.whole = false; });
    }

    /** Mark [start, start + count) (in the target's array elements) for upload. */
    add(start, count) {
        const t = this.target;
        if (!t) return;
        t.needsUpdate = true;
        if (this.whole) return;
        const ranges = t.updateRanges;
        if (ranges.length === 0) this._used = 0;   // three uploaded and emptied them: the pool is free
        else if (ranges.length >= MAX_PENDING_RANGES) { this.all(); return; }
        let r = this._pool[this._used];
        if (r === undefined) { r = { start: 0, count: 0 }; this._pool.push(r); }
        this._used++;
        r.start = start;
        r.count = count;
        ranges.push(r);
    }

    /** Mark the whole target for upload. */
    all() {
        const t = this.target;
        if (!t) return;
        t.needsUpdate = true;
        if (this.whole) return;
        if (t.updateRanges.length > 0) this._coverAll(t);
        this.whole = true;
    }
}

/** Texels across a per-slot texture (the shaders index it by gl_InstanceID % 1024). */
const SLOT_TEXELS_WIDTH = 1024;

/**
 * One RGBA8 texel per slot, in a DataTexture SLOT_TEXELS_WIDTH wide that grows by rows — the
 * field's highlight texels (a cell's fill or tint) and its decoration texels (an underline's own
 * colour). Made on first use; a writer stores a slot's texel as one little-endian word (`words`)
 * and marks what it wrote; only those texel rows upload.
 */
class SlotTexels {
    constructor() {
        /** @type {THREE.DataTexture|null} */ this.texture = null;
        /** slots the texture holds */ this.size = 0;
        /** @private @type {Uint32Array|null} */ this._words = null;
        this.uploads = new UploadRanges((tex) => {
            const row = tex.image.width * 4;
            for (let o = 0; o < tex.image.data.length; o += row) tex.addUpdateRange(o, row);
        });
    }

    /**
     * Hold at least `count` slots: the first call makes the texture, a later one that needs more
     * rows makes a taller one with the old texels copied in (the old one disposed).
     * @param {number} count
     * @returns {boolean} whether the texture object is new (its users must rebind it)
     */
    ensure(count) {
        if (this.texture && this.size >= count) return false;
        const W = SLOT_TEXELS_WIDTH;
        const n = Math.max(count, 1);
        const height = Math.ceil(n / W);
        const data = new Uint8Array(W * height * 4);
        if (this.texture) {
            const old = this.texture.image.data;
            data.set(old.subarray(0, Math.min(old.length, data.length)));
            this.texture.dispose();
        }
        const tex = new THREE.DataTexture(data, W, height, THREE.RGBAFormat, THREE.UnsignedByteType);
        tex.minFilter = THREE.NearestFilter;
        tex.magFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;
        this.texture = tex;
        this.size = n;
        this._words = null;
        this.uploads.track(tex, (cb) => { tex.onUpdate = cb; });
        return true;
    }

    /** The texels as one little-endian RGBA8 word each (r in the low byte) — a view of the texture's data. */
    get words() {
        if (!LITTLE_ENDIAN) throw new Error('[InstancedField] per-slot texels are packed as little-endian RGBA8 words; this platform is big-endian');
        const data = this.texture.image.data;
        if (!this._words || this._words.buffer !== data.buffer) {
            this._words = new Uint32Array(data.buffer, data.byteOffset, data.length >> 2);
        }
        return this._words;
    }

    /**
     * Upload texels the caller wrote: slots [first, first + count), or with no arguments the whole
     * texture. A ranged upload goes up a texture row at a time (three uploads each range as one row
     * strip), so a span crossing a row edge is split there.
     */
    markDirty(first, count) {
        if (!this.texture) return;
        if (first === undefined) { this.uploads.all(); return; }
        const W = SLOT_TEXELS_WIDTH;
        const end = first + count;
        for (let s = first; s < end;) {
            const rowEnd = Math.min(end, (Math.floor(s / W) + 1) * W);
            this.uploads.add(s * 4, (rowEnd - s) * 4);
            s = rowEnd;
        }
    }

    dispose() {
        this.texture?.dispose();
        this.texture = null;
        this.size = 0;
        this._words = null;
    }
}

export default class InstancedField {
    /**
     * @param {THREE.Scene} scene
     * @param {Object} [atlas] - GlyphAtlas (contains _slugData, _shaper, getCharSize)
     * @param {Object} [options]
     * @param {number} [options.maxInstances]
     * @param {number} [options.maxGroups=1]  the group table's rows to start with (group 0 is
     *   every field's own); createGroup past them doubles the table, up to `groupCap`
     * @param {number} [options.groupCap=4096]  the most rows the table may grow to (a field
     *   creating more without releasing is a leak: it fails loud)
     * @param {Object} [options.slugData]
     * @param {Object} [options.shaper]
     * @param {number} [options.worldScale=0.025]
     * @param {Object} [options.defaultColor]
     * @param {boolean} [options.frustumCulled=true]
     */
    constructor(scene, atlas = null, options = {}) {
        this.scene = scene;
        this.atlas = atlas;

        this._slugData = options.slugData || (atlas && atlas._slugData) || null;
        this._shaper   = options.shaper   || (atlas && (atlas._shapeCache || atlas._shaper)) || null;

        this.worldScale = options.worldScale || 0.025;
        this.maxInstances = options.maxInstances || PERF_THRESHOLDS.maxInstancesPerMesh || 50000;
        // The group table's live rows (its texture height — the shaders clamp to it). Most fields only
        // ever use group 0, so a table starts at the rows asked for and grows on demand.
        this.maxGroups = Math.max(1, options.maxGroups || 1);
        this._groupCap = 0;
        this.groupCap = Math.max(this.maxGroups, options.groupCap || 4096);
        this._defaultColor = options.defaultColor || { r: 0.0, g: 1.0, b: 0.0 };

        this._cachedGlyphCount = 0;
        this.sourceBase = 0;
        this._groupCount = 1;
        this._freeGroups = [];
        this.renderedTexts = new Map();
        this.nextId = 1;
        this._cachedMetrics = null;

        // Slot buffer (32-byte RenderSlot records)
        this.slotBuffer = new InstancedSlotBuffer(Math.max(this.maxInstances, 256));

        // Group transform table: GROUP_STRIDE columns x maxGroups rows (Float DataTexture)
        // col 0: offset.xyz (w free)
        // col 1: rotation quaternion xyzw (identity 0,0,0,1)
        // col 2: color.rgb + alpha (default 1,1,1,1)
        // col 3: scale.xyz + colorBlend (default 1,1,1,0)
        // col 4: clipTop, clipBottom, clipEnabled (default 0,0,0)
        // col 5: bg_color.rgba (default 0,0,0,0)
        this._groupData = new Float32Array(this.maxGroups * GROUP_STRIDE * 4);
        this._initGroupDefaults();
        this._groupTexture = makeGroupTexture(this._groupData, this.maxGroups);

        // Per-slot texels (RGBA8, made on first use): the highlight — a cell's fill, or an additive
        // tint — and the decoration colour, an underline's own.
        /** @private */ this._highlight = new SlotTexels();
        /** @private */ this._decor = new SlotTexels();
        /** @private highlight texels with a fill, as setGlyphHighlight has written them */
        this._fills = 0;

        // Partial uploads: the slot buffer by float range (the per-slot textures by texel rows).
        this._slotUploads = new UploadRanges((ib) => ib.addUpdateRange(0, ib.array.length));

        // Create Three.js geometry and mesh. `material` is the INK pass; the FILL pass's material
        // is made with the first highlight texel (_ensureFillPass) — most fields never fill a cell.
        this.geometry = this._createGeometry();
        this.material = this._createMaterial();
        /** @type {THREE.ShaderMaterial|null} the fill pass's material, once a cell can have a fill */
        this.fillMaterial = null;

        this.instanceMesh = new THREE.Mesh(this.geometry, this.material);
        this.instanceMesh.userData.glyphField = this;
        // three culls by geometry.boundingSphere, which setLayoutExtent states (three can't
        // compute it — an InstancedBufferGeometry's own bounds are the base quad's).
        this.instanceMesh.frustumCulled = options.frustumCulled !== false;
        /** @private the extent as laid out (pen + advance), before the shader's overdraw */
        this._layoutBounds = null;
        /** @private widest quad any slot can draw (max of advance and height lanes) */
        this._maxQuad = 0;
        /** @private tallest cell any slot draws (the height lane's max) */
        this._rowHeight = 0;
        /** @private farTint()'s cache, keyed by the slot + group buffer versions it folded */
        this._farTint = null;

        _liveFields.add(this);

        if (this.scene) {
            this.scene.add(this.instanceMesh);
        }

        if (this.atlas?._live && typeof this.atlas._live.registerField === 'function') {
            this.atlas._live.registerField(this);
        }
        if (!this._slugData && this.atlas?._slugData) {
            this.setSlugData(this.atlas._slugData, this._shaper);
        }
    }

    /** The most rows the group table may grow to. A slot's group lane holds its row in GROUP_ID_BITS bits. */
    get groupCap() { return this._groupCap; }
    set groupCap(rows) {
        if (!(rows >= 1) || rows > (1 << GROUP_ID_BITS)) throw new Error(`InstancedField: groupCap ${rows} — a slot's group lane holds a row below ${1 << GROUP_ID_BITS}`);
        this._groupCap = rows;
    }

    /** @private the highlight texture (null until a slot is highlighted) */
    get _highlightTexture() { return this._highlight.texture; }

    /** @private */
    _initGroupDefaults() {
        for (let g = 0; g < this.maxGroups; g++) {
            this._resetGroupRow(g);
        }
    }

    /** @private */
    _resetGroupRow(g) {
        if (g < 0 || g >= this.maxGroups) return;
        const base = g * GROUP_STRIDE * 4;
        this._groupData.fill(0, base, base + GROUP_STRIDE * 4);
        // col 1: quaternion xyzw (0, 0, 0, 1)
        this._groupData[base + 4 + 3]  = 1.0;
        // col 2: color rgba (1, 1, 1, 1)
        this._groupData[base + 8]      = 1.0;
        this._groupData[base + 8 + 1]  = 1.0;
        this._groupData[base + 8 + 2]  = 1.0;
        this._groupData[base + 8 + 3]  = 1.0;
        // col 3: scale xyz + colorBlend (1, 1, 1, 0)
        this._groupData[base + 12]     = 1.0;
        this._groupData[base + 12 + 1] = 1.0;
        this._groupData[base + 12 + 2] = 1.0;
        this._groupData[base + 12 + 3] = 0.0;
        // col 4: clip (0, 0, 0, 0)
        // col 5: bg_color (0, 0, 0, 0)
        this._touchGroup(g);
    }

    /** @private */
    _createGeometry() {
        const geometry = new THREE.InstancedBufferGeometry();

        // Unit quad indexed: [0, 1, 2, 0, 2, 3]
        // Corners: (0,0), (1,0), (1,1), (0,1)
        const quadPositions = new Float32Array([
            0.0, 0.0, 0.0,
            1.0, 0.0, 0.0,
            1.0, 1.0, 0.0,
            0.0, 1.0, 0.0,
        ]);
        const quadUVs = new Float32Array([
            0.0, 0.0,
            1.0, 0.0,
            1.0, 1.0,
            0.0, 1.0,
        ]);
        const quadIndices = [0, 1, 2, 0, 2, 3];

        geometry.setIndex(quadIndices);
        geometry.setAttribute('position', new THREE.BufferAttribute(quadPositions, 3));
        geometry.setAttribute('uv', new THREE.BufferAttribute(quadUVs, 2));

        // Interleaved 32-byte slot buffer attribute bindings
        this._interleavedBuffer = this.slotBuffer.createInterleavedBuffer();
        this._trackSlotUploads();
        InstancedSlotBuffer.bindGeometryAttributes(geometry, this._interleavedBuffer);
        geometry.instanceCount = 0;

        return geometry;
    }

    get emojiAtlas() {
        return this.atlas?._emojiAtlas || this.atlas?._shaper?._emojiAtlas || this._shaper?._emojiAtlas || null;
    }

    /** @private */
    _createMaterial() {
        const ea = this.emojiAtlas;
        return createGlyphMaterial({
            curveTexture: this._slugData?.curveTexture,
            glyphMapTexture: this._slugData?.glyphMapTexture,
            groupTexture: this._groupTexture,
            maxGroups: this.maxGroups,
            emojiTexture: ea?.getTexture?.(THREE) || null,
            emojiCols: ea?.cols || 16,
            emojiRows: ea?.rows || 16,
        });
    }

    /**
     * Hot-swap or update Slug textures.
     * @param {Object} slugData - { curveTexture, glyphMapTexture }
     * @param {Object} [shaper]
     */
    setSlugData(slugData, shaper) {
        if (shaper) this._shaper = shaper;
        if (!slugData) return;
        this._slugData = slugData;

        if (this.material && this.material.uniforms) {
            if (slugData.curveTexture) {
                this.material.uniforms.curveTexture.value = slugData.curveTexture;
            }
            if (slugData.glyphMapTexture) {
                this.material.uniforms.glyphMapTexture.value = slugData.glyphMapTexture;
                this.material.uniforms.glyphMapWidth.value = slugData.glyphMapTexture.image?.width || 1024;
            }
            const ea = this.emojiAtlas;
            const tex = ea?.getTexture?.(THREE);
            if (tex && this.material.uniforms.emojiTexture) {
                this.material.uniforms.emojiTexture.value = tex;
                this.material.uniforms.emojiCols.value = ea.cols || 16;
                this.material.uniforms.emojiRows.value = ea.rows || 16;
            }
            this.material.needsUpdate = true;
        }
    }

    /**
     * Refresh the emoji atlas texture and grid dimensions after new emoji cells were drawn.
     * Called by LiveSlugAtlas._refreshEmojiTextures on registered fields.
     */
    setEmojiTexture() {
        const ea = this.emojiAtlas;
        if (!ea) return;
        const tex = ea.getTexture?.(THREE);
        if (tex) {
            tex.needsUpdate = true;
            if (this.material?.uniforms?.emojiTexture) {
                this.material.uniforms.emojiTexture.value = tex;
                this.material.uniforms.emojiCols.value = ea.cols || 16;
                this.material.uniforms.emojiRows.value = ea.rows || 16;
                this.material.needsUpdate = true;
            }
        }
    }

    /**
     * Upload an array or buffer of slots directly into the geometry.
     * @param {InstancedSlotBuffer} slotBuffer
     * @param {number} count
     */
    setSlots(slotBuffer, count) {
        this.slotBuffer = slotBuffer;
        this.slotBuffer.count = count;
        this._cachedGlyphCount = count;

        const neededCapacity = Math.max(count, 1);
        if (!this._interleavedBuffer || this._interleavedBuffer.array.buffer !== slotBuffer.buffer || this._interleavedBuffer.count < neededCapacity) {
            const hadOld = !!this._interleavedBuffer;
            this._interleavedBuffer = slotBuffer.createInterleavedBuffer();
            this._trackSlotUploads();
            InstancedSlotBuffer.bindGeometryAttributes(this.geometry, this._interleavedBuffer);
            if (hadOld && this.geometry) {
                this.geometry.dispose();
            }
        }

        this._slotUploads.all();
        this.geometry.instanceCount = count;
    }

    /** @private A new interleaved buffer uploads whole once, then by the ranges writers mark. */
    _trackSlotUploads() {
        const ib = this._interleavedBuffer;
        this._slotUploads.track(ib, (cb) => ib.onUpload(cb));
    }

    /**
     * Upload only slots [first, first + count) of what was written since the last render (the
     * writer has already written them into slotBuffer). Ranges accumulate until three uploads.
     * @param {number} first
     * @param {number} count
     */
    markSlotsDirty(first, count) {
        if (count > 0) this._slotUploads.add(first * SLOT_FLOATS, count * SLOT_FLOATS);
    }

    /**
     * Load text directly through LayoutGenerator and upload to GPU.
     * @param {string|string[]} text
     * @param {Object} [options]
     * @returns {{ bounds: Object, totalRows: number, glyphCount: number }}
     */
    loadText(text, options = {}) {
        const live = this.atlas?._live;
        const shaper = this.atlas?._shapeCache || this._shaper;
        if (live && shaper && text) {
            const str = Array.isArray(text) ? text.join('\n') : String(text);
            if (!this.atlas._seenCodepoints) this.atlas._seenCodepoints = new Set();
            const seen = this.atlas._seenCodepoints;
            let fresh = null;
            for (let i = 0; i < str.length;) {
                const cp = str.codePointAt(i);
                i += cp > 0xFFFF ? 2 : 1;
                if (cp > 32 && !seen.has(cp)) {
                    seen.add(cp);
                    (fresh ?? (fresh = [])).push(cp);
                }
            }
            if (fresh && fresh.length > 0) {
                live.ensureCodepoints(fresh, shaper);
            }
        }

        const opts = {
            shaper: this._shaper,
            worldScale: this.worldScale,
            color: options.color || this._defaultColor,
            targetBuffer: this.slotBuffer,
            metrics: options.metrics || this.metrics,
            ...options,
        };

        const result = generateLayout(text, opts);
        this.setSlots(result.buffer, result.glyphCount);
        this.setLayoutExtent(result.bounds);
        return result;
    }

    /**
     * State this field's extent to three — geometry.boundingBox + boundingSphere, which three
     * frustum-culls, depth-sorts, and raycasts by. `bounds` is the extent as LAID OUT (pens +
     * advances, cell-center y ± height/2). The vertex shader can draw past it on the right: an
     * emoji quad is `height` wide. So the stated box adds one widest quad to max.x — a quad never
     * extends further than that past the last pen. Call after the slots are written (the widest
     * quad is read off them).
     * @param {{ min: {x:number, y:number, z:number}, max: {x:number, y:number, z:number} }} bounds
     */
    setLayoutExtent(bounds) {
        if (!bounds) return;
        this._layoutBounds = { min: { ...bounds.min }, max: { ...bounds.max } };
        const f32 = this.slotBuffer.f32, n = this.slotBuffer.count;
        let widest = 0, tallest = 0;
        for (let s = 0; s < n; s++) {
            const b = s * SLOT_FLOATS;
            const h = f32[b + LANE_HEIGHT];
            const w = Math.max(f32[b + LANE_ADVANCE], h);
            if (w > widest) widest = w;
            if (h > tallest) tallest = h;
        }
        this._maxQuad = widest;
        this._rowHeight = tallest;
        this._stateExtent();
    }

    /** @private Write the layout extent + the shader's right-side overdraw into the geometry. */
    _stateExtent() {
        const L = this._layoutBounds;
        if (!L) return;
        const overdraw = this._maxQuad;
        if (!this.geometry.boundingBox) this.geometry.boundingBox = new THREE.Box3();
        this.geometry.boundingBox.min.set(L.min.x, L.min.y, L.min.z);
        this.geometry.boundingBox.max.set(L.max.x + overdraw, L.max.y, L.max.z);

        if (!this.geometry.boundingSphere) this.geometry.boundingSphere = new THREE.Sphere();
        this.geometry.boundingBox.getBoundingSphere(this.geometry.boundingSphere);
    }

    /**
     * What this field's glyphs average to from far away — the far-LOD backdrop's tint
     * (glyph3d-rs `seg_tint`): the mean ink colour of the drawn glyphs as the shader draws them
     * (each slot's colour through its group's tint — sRGB, the lanes' own encoding and the one
     * the canvas blends sub-pixel glyphs in) and the ink cover, the share of the laid-out box
     * their cells fill × the mean group alpha. Cached until the slots or the group table change
     * (their buffer versions — every writer bumps them, or the GPU wouldn't see the write either).
     * @returns {{ r: number, g: number, b: number, cover: number }|null} null before layout
     */
    farTint() {
        const L = this._layoutBounds;
        if (!L) return null;
        const slotV = this._interleavedBuffer?.version ?? 0, groupV = this._groupTexture.version;
        const c = this._farTint;
        if (c && c.slotBuffer === this._interleavedBuffer && c.slotV === slotV && c.groupTex === this._groupTexture && c.groupV === groupV) return c.tint;

        const f32 = this.slotBuffer.f32, n = this.slotBuffer.count, G = this._groupData, gs = GROUP_STRIDE * 4;
        let r = 0, g = 0, b = 0, cells = 0, area = 0, alpha = 0;
        for (let s = 0; s < n; s++) {
            const o = s * SLOT_FLOATS;
            const h = f32[o + LANE_HEIGHT];
            if (!(h > 0)) continue;                                 // height 0 draws nothing
            const row = groupOf(f32[o + LANE_GROUP_ID]);
            if (row >= this.maxGroups) continue;
            const gb = row * gs;
            const ga = G[gb + 11];
            if (ga <= 0.01) continue;                               // the vertex stage culls these
            const v = Math.round(f32[o + LANE_COLOR]);
            // vColor = mix(iColor·g, g, blend), as the vertex stage computes it
            const gr = G[gb + 8], gg = G[gb + 9], gB = G[gb + 10], blend = G[gb + 15];
            const cr = (v & 0xff) / 255 * gr, cg = ((v >> 8) & 0xff) / 255 * gg, cb = ((v >> 16) & 0xff) / 255 * gB;
            r += cr + (gr - cr) * blend;
            g += cg + (gg - cg) * blend;
            b += cb + (gB - cb) * blend;
            cells++;
            area += f32[o + LANE_ADVANCE] * h;
            alpha += ga;
        }
        const boxArea = Math.max((L.max.x - L.min.x) * (L.max.y - L.min.y), 1e-6);
        const tint = cells === 0
            ? { r: 0, g: 0, b: 0, cover: 0 }
            : { r: r / cells, g: g / cells, b: b / cells, cover: Math.min(area / boxArea, 1) * (alpha / cells) };
        this._farTint = { slotBuffer: this._interleavedBuffer, slotV, groupTex: this._groupTexture, groupV, tint };
        return tint;
    }

    /** The extent as laid out (pen + advance, no overdraw), in the field's own frame; null before layout. */
    get layoutBounds() {
        return this._layoutBounds;
    }

    /** The tallest glyph cell any slot draws — what one row of this field measures on screen. */
    get rowHeight() {
        return this._rowHeight;
    }

    /** Number of active rendered glyphs */
    getGlyphCount() {
        return this._cachedGlyphCount;
    }

    get glyphMapTexture() {
        return this._slugData?.glyphMapTexture || this.material?.uniforms?.glyphMapTexture?.value || null;
    }

    get glyphMapWidth() {
        return this.material?.uniforms?.glyphMapWidth?.value || this.glyphMapTexture?.image?.width || 1024;
    }

    get groupTexture() {
        return this._groupTexture;
    }

    /** Clear all glyphs */
    clear() {
        this._cachedGlyphCount = 0;
        this.geometry.instanceCount = 0;
        this.slotBuffer.clear();
        this._slotUploads.all();
    }

    // ── Group Transform API ──────────────────────────────────────────────────

    /** @private Mark group texture dirty */
    _touchGroup(groupId) {
        if (this._groupTexture) {
            this._groupTexture.needsUpdate = true;
        }
    }

    /**
     * Claim a group row. Released IDs are reused.
     * @returns {number} groupId
     */
    createGroup() {
        const reused = this._freeGroups.pop();
        if (reused !== undefined) {
            this._resetGroupRow(reused);
            return reused;
        }
        const id = this._groupCount++;
        if (id >= this.maxGroups && this.maxGroups < this.groupCap) this._growGroups(Math.min(this.groupCap, this.maxGroups * 2));
        if (id >= this.maxGroups) {
            if (!this._groupExhaustionNoted) {
                this._groupExhaustionNoted = true;
                console.error(`InstancedField: group table EXHAUSTED (${this.maxGroups} live groups, the cap) — new content renders INVISIBLE (dead group 0). This is a leak or a churn storm: something creates groups without releasing them.`);
            }
            this._groupCount = this.maxGroups;
            return 0;
        }
        this._resetGroupRow(id);
        return id;
    }

    /**
     * Grow the group table to `rows`: every existing row kept bit-exact, the new ones at their
     * defaults, a new texture of the new height (the old one disposed), and the material told —
     * the same table, taller; the shaders clamp to maxGroups. @private
     * @param {number} rows
     */
    _growGroups(rows) {
        const old = this._groupData;
        this._groupData = new Float32Array(rows * GROUP_STRIDE * 4);
        this._groupData.set(old);
        const from = this.maxGroups;
        this.maxGroups = rows;
        for (let g = from; g < rows; g++) this._resetGroupRow(g);
        const tex = makeGroupTexture(this._groupData, rows);
        this._groupTexture.dispose();
        this._groupTexture = tex;
        for (const m of [this.material, this.fillMaterial]) {
            if (m) { m.uniforms.groupTexture.value = tex; m.uniforms.maxGroups.value = rows; }
        }
    }

    /**
     * Release a group row back to the free list.
     * Goes dark (alpha 0) while free. Group 0 is never releasable.
     * @param {number} groupId
     */
    releaseGroup(groupId) {
        if (!(groupId > 0) || groupId >= this.maxGroups) return;
        if (this._freeGroups.includes(groupId)) return;
        const base = groupId * GROUP_STRIDE * 4;
        this._groupData.fill(0, base, base + GROUP_STRIDE * 4);
        this._groupData[base + 4 + 3] = 1.0;
        this._touchGroup(groupId);
        this._freeGroups.push(groupId);
    }

    /** Set group offset (position) */
    setGroupOffset(groupId, offset) {
        const g = groupId | 0;
        if (g < 0 || g >= this.maxGroups) return;
        const b = g * GROUP_STRIDE * 4;
        this._groupData[b + 0] = offset.x ?? offset[0] ?? 0;
        this._groupData[b + 1] = offset.y ?? offset[1] ?? 0;
        this._groupData[b + 2] = offset.z ?? offset[2] ?? 0;
        this._touchGroup(g);
    }

    /** Set group rotation quaternion (xyzw) */
    setGroupQuaternion(groupId, quat) {
        const g = groupId | 0;
        if (g < 0 || g >= this.maxGroups) return;
        const b = (g * GROUP_STRIDE + 1) * 4;
        this._groupData[b + 0] = quat.x ?? quat[0] ?? 0;
        this._groupData[b + 1] = quat.y ?? quat[1] ?? 0;
        this._groupData[b + 2] = quat.z ?? quat[2] ?? 0;
        this._groupData[b + 3] = quat.w ?? quat[3] ?? 1;
        this._touchGroup(g);
    }

    /** Set group color multiplier and alpha */
    setGroupColor(groupId, color, alpha = 1.0) {
        const g = groupId | 0;
        if (g < 0 || g >= this.maxGroups) return;
        const b = (g * GROUP_STRIDE + 2) * 4;
        this._groupData[b + 0] = color.r ?? color[0] ?? 1.0;
        this._groupData[b + 1] = color.g ?? color[1] ?? 1.0;
        this._groupData[b + 2] = color.b ?? color[2] ?? 1.0;
        this._groupData[b + 3] = alpha ?? color.a ?? 1.0;
        this._touchGroup(g);
    }

    /**
     * Pose one group row — offset, color multiplier and alpha — from plain numbers (no objects:
     * a writer posing many rows every frame makes no garbage).
     * @param {number} groupId
     * @param {number} x @param {number} y @param {number} z  the offset
     * @param {number} r @param {number} g @param {number} b  the color multiplier
     * @param {number} a  alpha (≤ 0.01 draws nothing)
     */
    setGroupOffsetColor(groupId, x, y, z, r, g, b, a) {
        const row = groupId | 0;
        if (row < 0 || row >= this.maxGroups) return;
        const o = row * GROUP_STRIDE * 4;
        const G = this._groupData;
        G[o] = x; G[o + 1] = y; G[o + 2] = z;
        G[o + 8] = r; G[o + 9] = g; G[o + 10] = b; G[o + 11] = a;
        this._touchGroup(row);
    }

    /** Set group alpha only */
    setGroupAlpha(groupId, alpha) {
        const g = groupId | 0;
        if (g < 0 || g >= this.maxGroups) return;
        const b = (g * GROUP_STRIDE + 2) * 4 + 3;
        this._groupData[b] = alpha;
        this._touchGroup(g);
    }

    /** Set group scale (xyz) and color blend mode */
    setGroupScale(groupId, scale, colorBlend = 0.0) {
        const g = groupId | 0;
        if (g < 0 || g >= this.maxGroups) return;
        const b = (g * GROUP_STRIDE + 3) * 4;
        this._groupData[b + 0] = typeof scale === 'number' ? scale : (scale.x ?? 1.0);
        this._groupData[b + 1] = typeof scale === 'number' ? scale : (scale.y ?? 1.0);
        this._groupData[b + 2] = typeof scale === 'number' ? scale : (scale.z ?? 1.0);
        this._groupData[b + 3] = colorBlend;
        this._touchGroup(g);
    }

    /** Set group vertical clip window */
    setGroupClip(groupId, clipTop, clipBottom, clipEnabled = true) {
        const g = groupId | 0;
        if (g < 0 || g >= this.maxGroups) return;
        const b = (g * GROUP_STRIDE + 4) * 4;
        this._groupData[b + 0] = clipTop ?? 0;
        this._groupData[b + 1] = clipBottom ?? 0;
        this._groupData[b + 2] = clipEnabled ? 1.0 : 0.0;
        this._touchGroup(g);
    }

    /** Set group background color */
    setGroupBgColor(groupId, color, alpha = 0.0) {
        const g = groupId | 0;
        if (g < 0 || g >= this.maxGroups) return;
        const b = (g * GROUP_STRIDE + 5) * 4;
        this._groupData[b + 0] = color.r ?? color[0] ?? 0;
        this._groupData[b + 1] = color.g ?? color[1] ?? 0;
        this._groupData[b + 2] = color.b ?? color[2] ?? 0;
        this._groupData[b + 3] = alpha;
        this._touchGroup(g);
    }

    /**
     * Facade for CodeGrid: set vertical clip range on group 0.
     * @param {number|null} top
     * @param {number|null} bottom
     */
    setClipYRange(top, bottom) {
        if (top == null || bottom == null) {
            this.setGroupClip(0, 0, 0, false);
        } else {
            this.setGroupClip(0, top, bottom, true);
        }
    }

    // ── Highlight API ────────────────────────────────────────────────────────

    /** @private Hold highlight texels for `instanceCount` slots, and the fill pass that draws their fills. */
    _ensureHighlightTexture(instanceCount) {
        if (this._highlight.ensure(instanceCount)) {
            const tex = this._highlight.texture;
            this.material.uniforms.highlightTexture.value = tex;
            if (this.fillMaterial) this.fillMaterial.uniforms.highlightTexture.value = tex;
        }
        this._ensureFillPass();
    }

    /**
     * @private The fill pass: the same mesh, geometry and buffers drawn once more, FIRST, by the
     * fill material — the mesh's material becomes [fill, ink] over two geometry groups that both
     * span the quad, which three draws in that order (same object: same sort key, in group order).
     */
    _ensureFillPass() {
        if (this.fillMaterial) return;
        this.fillMaterial = createGlyphFillMaterial({
            groupTexture: this._groupTexture,
            maxGroups: this.maxGroups,
            highlightTexture: this._highlight.texture,
        });
        this.geometry.clearGroups();
        this.geometry.addGroup(0, Infinity, 0);
        this.geometry.addGroup(0, Infinity, 1);
        this.instanceMesh.material = [this.fillMaterial, this.material];
    }

    /**
     * Whether any slot has a fill: while false the fill pass is not drawn at all (its material is
     * hidden — three skips the draw; no scene visibility changes). setGlyphHighlight keeps it
     * (it counts the fills it writes and clears); a writer of highlightWords says so itself.
     * @type {boolean}
     */
    get fillsActive() { return !!this.fillMaterial?.visible; }
    set fillsActive(on) {
        if (on) this._ensureFillPass();
        if (this.fillMaterial) this.fillMaterial.visible = !!on;
    }

    /**
     * Set highlight color and fill opacity for a specific slot.
     * @param {number} slotIndex
     * @param {{r:number, g:number, b:number}|null} color
     * @param {number} [fillOpacity=0]
     */
    setGlyphHighlight(slotIndex, color, fillOpacity = 0.0) {
        if (slotIndex < 0) return;
        this._ensureHighlightTexture(slotIndex + 1);
        const data = this._highlightTexture.image.data;
        const base = slotIndex * 4;
        const had = data[base + 3] > 0;
        if (color) {
            data[base + 0] = Math.round((color.r ?? 0) * 255);
            data[base + 1] = Math.round((color.g ?? 0) * 255);
            data[base + 2] = Math.round((color.b ?? 0) * 255);
            data[base + 3] = Math.round(fillOpacity * 255);
        } else {
            data[base + 0] = 0;
            data[base + 1] = 0;
            data[base + 2] = 0;
            data[base + 3] = 0;
        }
        const has = data[base + 3] > 0;
        if (has !== had) {
            this._fills += has ? 1 : -1;
            this.fillsActive = this._fills > 0;
        }
        this._highlight.uploads.all();
        this._showHighlight();
    }

    /** @private Both passes read the highlight texture from now on. */
    _showHighlight() {
        this.material.uniforms.hasHighlight.value = 1;
        if (this.fillMaterial) this.fillMaterial.uniforms.hasHighlight.value = 1;
    }

    // ── Per-Slot Editing / Transcoding API ───────────────────────────────────

    /** Write slot color */
    writeColor(slotIndex, packedColor) {
        this.slotBuffer.setColor(slotIndex, packedColor);
        this._slotUploads.all();
    }

    /** Write multiple slot colors */
    writeColors(firstSlot, packedColors) {
        for (let i = 0; i < packedColors.length; i++) {
            this.slotBuffer.setColor(firstSlot + i, packedColors[i]);
        }
        this._slotUploads.all();
    }

    /** Write slot position */
    writePosition(slotIndex, x, y, z) {
        this.slotBuffer.setPosition(slotIndex, x, y, z);
        this._slotUploads.all();
    }

    /** Set mesh visibility */
    setVisible(visible) {
        if (this.instanceMesh) {
            this.instanceMesh.visible = !!visible;
        }
    }

    /**
     * Color a range of glyphs using a color palette and LUT (for SyntaxColorizer).
     * When text/lines and lineStarts are provided, maps UTF-8 palette bytes to
     * 32-byte RenderSlots per line (properly skipping newlines, tabs, and handling
     * multibyte characters).
     *
     * @param {Uint8Array} palette - Per-byte palette index
     * @param {Float32Array} lut - Palette RGB lookup table (3 floats per entry)
     * @param {string|string[]} [textOrLines] - Optional text or array of lines
     * @param {Int32Array|number[]} [lineStarts] - Optional start slot index per line
     */
    setGlyphPaletteRange(palette, lut, textOrLines, lineStarts) {
        if (!palette || !lut || !this.slotBuffer) return;

        // Build pre-packed uint32 colors for all palette indices
        const lutCount = (lut.length / 3) | 0;
        const packedLUT = new Uint32Array(lutCount);
        for (let p = 0; p < lutCount; p++) {
            const r = (lut[p * 3] * 255 + 0.5) | 0;
            const g = (lut[p * 3 + 1] * 255 + 0.5) | 0;
            const b = (lut[p * 3 + 2] * 255 + 0.5) | 0;
            packedLUT[p] = (r & 0xFF) | ((g & 0xFF) << 8) | ((b & 0xFF) << 16);
        }

        const lines = Array.isArray(textOrLines)
            ? textOrLines
            : (typeof textOrLines === 'string' ? textOrLines.split('\n') : null);

        if (lines && lineStarts && lineStarts.length >= lines.length) {
            // Line-aware mapping: UTF-8 byte ruler → RenderSlots, one slot per codepoint
            let byteOffset = 0;
            const paletteLen = palette.length;
            const lineCount = lines.length;

            for (let lineIdx = 0; lineIdx < lineCount; lineIdx++) {
                const line = lines[lineIdx];
                const lineLen = line.length;
                const slotBase = lineStarts[lineIdx];
                let slotOffset = 0;

                for (let i = 0; i < lineLen;) {
                    const cp = line.codePointAt(i);
                    i += cp > 0xFFFF ? 2 : 1;

                    // Codepoint byte length in UTF-8
                    const byteLen = (cp <= 0x7F) ? 1 : (cp <= 0x7FF) ? 2 : (cp <= 0xFFFF) ? 3 : 4;

                    if (byteOffset < paletteLen) {
                        const palIdx = palette[byteOffset];
                        const packed = packedLUT[palIdx] !== undefined ? packedLUT[palIdx] : packedLUT[0];
                        this.slotBuffer.setColor(slotBase + slotOffset, packed);
                    }

                    slotOffset++;
                    byteOffset += byteLen;
                }

                // Skip newline byte between lines
                if (byteOffset < paletteLen) {
                    if (palette[byteOffset] === 0x0D && byteOffset + 1 < paletteLen && palette[byteOffset + 1] === 0x0A) {
                        byteOffset += 2;
                    } else {
                        byteOffset++;
                    }
                }
            }
        } else {
            // Fallback sequential mapping
            const base = this.sourceBase || 0;
            const count = Math.min(this._cachedGlyphCount, palette.length - base);
            if (count <= 0) return;
            const start = base | 0;
            for (let i = 0; i < count; i++) {
                const palIdx = palette[start + i];
                const packed = packedLUT[palIdx] !== undefined ? packedLUT[palIdx] : packedLUT[0];
                this.slotBuffer.setColor(i, packed);
            }
        }

        this._slotUploads.all();
    }

    /**
     * Set a range of glyphs to a uniform color.
     * @param {number} start
     * @param {number} count
     * @param {number|{r:number, g:number, b:number, a?:number}} color
     */
    setGlyphColorRange(start, count, color) {
        const c = typeof color === 'number'
            ? { r: ((color >> 16) & 0xFF) / 255, g: ((color >> 8) & 0xFF) / 255, b: (color & 0xFF) / 255, a: 1.0 }
            : (color || this._defaultColor);
        const packed = packRgba8(c.r ?? 1, c.g ?? 1, c.b ?? 1, c.a ?? 1.0);
        const end = Math.min(this._cachedGlyphCount, start + count);
        for (let i = start; i < end; i++) {
            this.slotBuffer.setColor(i, packed);
        }
        this._slotUploads.all();
    }

    /**
     * Set a single glyph color.
     * @param {number} slotIndex
     * @param {number|{r:number, g:number, b:number, a?:number}} color
     */
    setGlyphColor(slotIndex, color) {
        const c = typeof color === 'number'
            ? { r: ((color >> 16) & 0xFF) / 255, g: ((color >> 8) & 0xFF) / 255, b: (color & 0xFF) / 255, a: 1.0 }
            : (color || this._defaultColor);
        const packed = packRgba8(c.r ?? 1, c.g ?? 1, c.b ?? 1, c.a ?? 1.0);
        this.slotBuffer.setColor(slotIndex, packed);
        this._slotUploads.all();
    }

    /**
     * Copy glyph lanes (color + highlight) from srcSlot to dstSlot.
     * @param {number} srcSlot
     * @param {number} dstSlot
     * @param {number} count
     */
    copyGlyphLanes(srcSlot, dstSlot, count) {
        if (!(count > 0) || srcSlot === dstSlot) return;
        const f32 = this.slotBuffer.float32;
        for (let i = 0; i < count; i++) {
            f32[(dstSlot + i) * 8 + 4] = f32[(srcSlot + i) * 8 + 4];
        }
        this._slotUploads.all();
        if (this._highlightTexture) {
            const hl = this._highlightTexture.image.data;
            hl.copyWithin(dstSlot * 4, srcSlot * 4, (srcSlot + count) * 4);
            this._highlight.uploads.all();
            // The copy moved fills about: count them again (an edit, not a frame).
            let fills = 0;
            for (let i = 3; i < hl.length; i += 4) if (hl[i] > 0) fills++;
            this._fills = fills;
            this.fillsActive = fills > 0;
        }
    }

    /** Cell metrics computed from atlas char size and worldScale */
    get metrics() {
        if (!this._cachedMetrics) {
            const charSize = this.atlas?.getCharSize?.() || { width: 9.6, height: 18 };
            this._cachedMetrics = computeCellMetrics(charSize, this.worldScale);
        }
        return this._cachedMetrics;
    }

    get glyphMapTexture() {
        return this._slugData?.glyphMapTexture || null;
    }

    get glyphMapWidth() {
        return this._slugData?.glyphMapTexture?.image?.width || 1024;
    }

    static encodeHighlightAlpha(fillOpacity) {
        return fillOpacity > 0 ? Math.min(255, Math.max(1, (fillOpacity * 255 + 0.5) | 0)) : 0;
    }

    /**
     * The highlight texels as one little-endian RGBA8 word per slot (r in the low byte, fill alpha
     * in the high byte) — a view of the texture's own data, so a writer stores a slot's texel in one
     * write. Mark what was written with markHighlightDirty, and say whether any slot has a fill
     * (`fillsActive`): the fill pass draws only while one does.
     * @param {number} count  slots the texture must hold
     * @returns {Uint32Array}
     */
    highlightWords(count) {
        this._ensureHighlightTexture(count);
        return this._highlight.words;
    }

    /**
     * Upload highlight texels the caller wrote: slots [first, first + count), or with no arguments
     * the whole texture.
     * @param {number} [first]
     * @param {number} [count]
     */
    markHighlightDirty(first, count) {
        if (!this._highlightTexture) return;
        this._showHighlight();
        this._highlight.markDirty(first, count);
    }

    /**
     * The decoration texels as one little-endian RGBA8 word per slot: the colour a slot's
     * underline draws in when its style byte says it has its own (cellAttrs STYLE_UNDERLINE_COLOR;
     * r in the low byte, the high byte unused). Made on first call. Mark what was written with
     * markDecorDirty.
     * @param {number} count  slots the texture must hold
     * @returns {Uint32Array}
     */
    decorWords(count) {
        if (this._decor.ensure(count)) {
            this.material.uniforms.decorTexture.value = this._decor.texture;
            this.material.uniforms.hasDecor.value = 1;
        }
        return this._decor.words;
    }

    /**
     * Upload decoration texels the caller wrote: slots [first, first + count), or with no
     * arguments the whole texture.
     * @param {number} [first]
     * @param {number} [count]
     */
    markDecorDirty(first, count) {
        this._decor.markDirty(first, count);
    }

    setFrameTexture(tex, cols, rows) {
        this._frameTexture = tex || null;
        this._frameCols = Math.max(1, Math.floor(cols) || 1);
        this._frameRows = Math.max(1, Math.floor(rows) || 1);
    }

    /**
     * Adopt prebuilt buffer arrays (positions, sizes, colors, glyphIds, groupIds).
     * @param {Object} buffers
     * @param {Array} [items]
     */
    applyPrebuiltBuffers(buffers, items) {
        const { positions, sizes, colors, groupIds, count } = buffers;
        const glyphIds = buffers.glyphIds || buffers.codepoints;
        const itemMeta = buffers.itemMeta;

        this.slotBuffer.ensureCapacity(count);

        for (let i = 0; i < count; i++) {
            const cr = colors ? (colors[i * 3 + 0] * 255 + 0.5) | 0 : 255;
            const cg = colors ? (colors[i * 3 + 1] * 255 + 0.5) | 0 : 255;
            const cb = colors ? (colors[i * 3 + 2] * 255 + 0.5) | 0 : 255;
            this.slotBuffer.setSlot(
                i,
                positions ? positions[i * 3 + 0] : 0,
                positions ? positions[i * 3 + 1] : 0,
                positions ? positions[i * 3 + 2] : 0,
                glyphIds ? glyphIds[i] : 0,
                (cr & 0xff) | ((cg & 0xff) << 8) | ((cb & 0xff) << 16),
                groupIds ? groupIds[i] : 0,
                sizes ? sizes[i * 2 + 0] : 1.0,
                sizes ? sizes[i * 2 + 1] : 1.0,
            );
        }

        this.setSlots(this.slotBuffer, count);
        this.maxInstances = Math.max(this.maxInstances, count);

        let ids = null;
        if (itemMeta && items) {
            ids = [];
            this.renderedTexts.clear();
            for (let i = 0; i < itemMeta.length; i++) {
                const meta = itemMeta[i];
                const id = this.nextId++;
                this.renderedTexts.set(id, {
                    id,
                    bufferStartIndex: meta.bufferStartIndex,
                    glyphCount: meta.glyphCount,
                    lineSlotOffsets: meta.lineSlotOffsets || null,
                });
                ids.push(id);
            }
        }
        return ids;
    }

    /** @private */
    _blankGlyphId() {
        if (this._blankGid === undefined) {
            let gid = 0;
            if (this._shaper) {
                if (typeof this._shaper.lookup === 'function') {
                    const entry = this._shaper.lookup(32);
                    if (entry) gid = entry.g;
                } else if (typeof this._shaper.shape === 'function') {
                    const shaped = this._shaper.shape(' ');
                    if (shaped && shaped.length) gid = shaped[0].g;
                }
            }
            this._blankGid = gid;
        }
        return this._blankGid;
    }

    /**
     * Render single text item.
     * @param {string} text
     * @param {{x:number, y:number, z:number}} [position]
     * @param {Object} [options]
     * @returns {number} textId
     */
    render(text, position = { x: 0, y: 0, z: 0 }, options = {}) {
        return this.renderBatch([{ text, position, options }])[0];
    }

    /**
     * Batch render text items and backplate quads into group rows.
     * @param {Array<{text?:string, quad?:{w:number, h:number, fill?:{color:{r:number,g:number,b:number}, opacity:number}}, position?:{x:number,y:number,z:number}, options?:Object}>} items
     * @returns {number[]} textIds
     */
    renderBatch(items) {
        if (!items || !items.length) return [];
        let totalGlyphs = 0;
        for (const item of items) {
            if (item.quad) {
                totalGlyphs += 1;
            } else if (item.text) {
                totalGlyphs += [...item.text].length;
            }
        }

        const newCount = this._cachedGlyphCount + totalGlyphs;
        this.slotBuffer.ensureCapacity(newCount);

        const ids = [];
        let slot = this._cachedGlyphCount;
        const charMetrics = this.metrics;
        const defaultCharW = charMetrics.charWidth;
        const defaultRowH = charMetrics.charHeight;

        for (const item of items) {
            const options = item.options || {};
            const pos = item.position || { x: 0, y: 0, z: 0 };
            const groupId = options.groupId ?? 0;
            const startSlot = slot;

            if (item.quad) {
                const w = item.quad.w || defaultCharW;
                const h = item.quad.h || defaultRowH;
                const fill = item.quad.fill;
                const col = fill?.color || options.color || this._defaultColor;
                const opacity = fill?.opacity ?? (col.a ?? 1.0);
                const packedCol = packRgba8(col.r ?? 1, col.g ?? 1, col.b ?? 1, opacity);

                const blankGid = this._blankGlyphId();
                this.slotBuffer.writeSlot(slot, {
                    x: pos.x,
                    y: pos.y,
                    z: pos.z,
                    glyphId: blankGid,
                    color: packedCol,
                    groupId: groupId,
                    advance: w,
                    height: h,
                });
                if (fill) {
                    this.setGlyphHighlight(slot, col, opacity);
                }
                slot++;
            } else if (item.text) {
                const text = item.text;
                const col = options.color || this._defaultColor;
                const c = typeof col === 'number'
                    ? { r: ((col >> 16) & 0xFF) / 255, g: ((col >> 8) & 0xFF) / 255, b: (col & 0xFF) / 255, a: 1.0 }
                    : col;
                const packedCol = packRgba8(c.r ?? 1, c.g ?? 1, c.b ?? 1, c.a ?? 1.0);
                const scale = options.scale ?? 1.0;
                const charW = defaultCharW * scale;
                const rowH = defaultRowH * scale;

                let penX = pos.x;
                const penY = pos.y;
                const penZ = pos.z;

                for (let i = 0; i < text.length;) {
                    const cp = text.codePointAt(i);
                    i += cp > 0xffff ? 2 : 1;
                    if (cp === 10) {
                        continue;
                    }
                    let gid = 0;
                    if (this._shaper) {
                        if (typeof this._shaper.lookup === 'function') {
                            const entry = this._shaper.lookup(cp);
                            if (entry) gid = entry.g;
                        } else if (typeof this._shaper.shape === 'function') {
                            const shaped = this._shaper.shape(String.fromCodePoint(cp));
                            if (shaped && shaped.length) gid = shaped[0].g;
                        }
                    } else {
                        gid = cp;
                    }

                    this.slotBuffer.writeSlot(slot, {
                        x: penX,
                        y: penY,
                        z: penZ,
                        glyphId: gid,
                        color: packedCol,
                        groupId: groupId,
                        advance: charW,
                        height: rowH,
                    });
                    penX += charW;
                    slot++;
                }
            }
            const id = this.nextId++;
            this.renderedTexts.set(id, { id, bufferStartIndex: startSlot, glyphCount: slot - startSlot });
            ids.push(id);
        }

        this.setSlots(this.slotBuffer, slot);
        return ids;
    }

    /** Dispose GPU and buffer resources */
    dispose() {
        _liveFields.delete(this);
        if (this.atlas?._live && typeof this.atlas._live.unregisterField === 'function') {
            this.atlas._live.unregisterField(this);
        }
        if (this.instanceMesh?.parent) {
            this.instanceMesh.parent.remove(this.instanceMesh);
        } else if (this.instanceMesh && this.scene) {
            this.scene.remove(this.instanceMesh);
        }
        this.geometry?.dispose();
        this.material?.dispose();
        this.fillMaterial?.dispose();
        this._groupTexture?.dispose();
        this._highlight.dispose();
        this._decor.dispose();
    }
}

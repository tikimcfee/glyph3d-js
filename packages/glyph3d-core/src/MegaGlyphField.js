/**
 * MegaGlyphField — ONE render field for every byte-pipeline grid: the render face
 * of the GlyphPipelineArena. Where each CodeGrid used to build its own GlyphField
 * (geometry + capacity-sized attributes + highlight/group textures + pick
 * registration + mesh + render object + bind groups — ×2 with the filename, the
 * last per-file construction cost), the app now has ONE arena-capacity field and
 * a grid's render presence is a VIEW into it:
 *
 *   view = { groupId, slotBase, byteCount, node }
 *
 * - The slot RANGE is the item's bytes in the arena (slot index == arena byte
 *   offset — the address space picking, highlight and color already speak).
 * - The view's whole pose (position/rotation/scale) is its GROUP TEXEL: one
 *   onBeforeRender sweep decomposes each view node's matrixWorld into the group
 *   texture (the transform commit 9e5ea9e taught the shared vertex path to
 *   apply). A grid keeps its Object3D identity — panels, caret, overlays — and
 *   only the glyph mesh unifies.
 * - Group 0 is the permanent DEAD group (alpha 0): a restaged view tombstones
 *   its old slot range there, so a reclaimed/recycled arena range never ghosts
 *   on screen.
 * - Picking is ONE registration: ID = base + absolute slot; resolveSlot() maps
 *   a hit back to (view, view-local slot) by binary search over live ranges.
 *
 * The MegaFieldView facade speaks the GlyphField surface its consumers already
 * use (setGlyphColorRange / setGlyphHighlight / setGroupAlpha / setClipYRange /
 * getGlyphCount / setLayoutExtent / attachBytePipeline), offset by slotBase —
 * CodeGrid, SyntaxColorizer and the arena's re-attach loop all
 * run unchanged against it.
 *
 * One per arena: ensureMegaField(arena, opts) parks the instance on
 * arena.megaField (the same reachability contract as renderer.glyphPipelineArena
 * — /@fs itest imports get a different module instance, so a module singleton
 * alone would be invisible to them).
 */

import * as THREE from 'three';
import GlyphField from './GlyphField.js';

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();

export class MegaGlyphField {
    /**
     * @param {import('./compute/GlyphPipelineArena.js').default} arena
     * @param {Object} opts
     * @param {THREE.Scene} opts.scene - the scene every byte grid lives in
     * @param {Object} opts.atlas - the booted GlyphAtlas
     * @param {number} [opts.worldScale]
     * @param {Object} [opts.slugData]
     * @param {Object} [opts.shaper]
     * @param {import('./picking/PickingSystem.js').PickingSystem} [opts.pickingSystem]
     */
    constructor(arena, { scene, atlas, worldScale, slugData, shaper, pickingSystem } = {}) {
        if (!arena) throw new Error('MegaGlyphField: an arena is required (it is the field\'s content)');
        if (!scene || !atlas) throw new Error('MegaGlyphField: scene + atlas are required');
        this.arena = arena;
        this.scene = scene;
        this.atlas = atlas;

        this.field = new GlyphField(scene, atlas, {
            maxInstances: arena.maxBytes,
            worldScale, slugData, shaper,
            bytePipeline: true,
            // One mesh spanning every grid: no meaningful CPU bounds exist (per-view
            // culling is the visibility lane, a later milestone).
            frustumCulled: false,
        });
        // Group 0 = THE dead group. Tombstoned (restaged/disposed) slot ranges point
        // here and the vertex cull drops them — a range the arena's free-list hands
        // to a NEW item only ever lights up through that item's own view attach.
        this.field.setGroupAlpha(0, 0);
        // (Highlight rides the capacity-sized instanceHighlight ATTRIBUTE — allocated
        // with the other per-byte lanes; a capacity-sized texture blew
        // maxTextureDimension2D at real-workspace scale and re-uploaded whole per write.)

        /** Live views, unordered (dispose splices). @type {MegaFieldView[]} */
        this.views = [];
        /** Attached ranges sorted by slotBase for resolveSlot. [{base, end, view}] */
        this._ranges = [];

        this._pickingSystem = pickingSystem || null;
        this._pickRegisteredKey = null;   // `${capacity}` once registered — stable across a storm

        // The pose sweep: before each render, any view whose node moved re-poses its
        // group texel. matrixWorld is current here (three's updateMatrixWorld runs at
        // render start); an unchanged 16-float compare is the whole per-view cost.
        this.field.instanceMesh.onBeforeRender = () => this._syncPoses();
    }

    get instanceMesh() { return this.field.instanceMesh; }

    /**
     * Create a view. `node` is the Object3D whose matrixWorld poses the view's
     * glyphs (the grid itself); `color` is the range's default per-byte color.
     * @param {{node: THREE.Object3D, color?: {r,g,b}}} p
     * @returns {MegaFieldView}
     */
    createView({ node, color }) {
        if (node && node.scene && node.scene !== this.scene) {
            // Fail loud at the seam: a view in another scene would silently never render.
            console.error('MegaGlyphField: view node lives in a different scene than the mega mesh');
        }
        const view = new MegaFieldView(this, node, color);
        this.views.push(view);
        return view;
    }

    /** Late picking wire-up (idempotent). The one glyph-channel registration. */
    setPickingSystem(ps) {
        if (!ps || this._pickingSystem === ps) return;
        this._pickingSystem = ps;
        this._pickRegisteredKey = null;
        this._registerPicking();
    }

    /**
     * Resolve an absolute arena slot (a glyph-channel hit's slotIndex) to its view.
     * @param {number} absSlot
     * @returns {{view: MegaFieldView, localSlot: number}|null}
     */
    resolveSlot(absSlot) {
        if (this._rangesDirty) this._reindexRanges();
        const r = this._ranges;
        let lo = 0, hi = r.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (absSlot < r[mid].base) hi = mid - 1;
            else if (absSlot >= r[mid].end) lo = mid + 1;
            else return { view: r[mid].view, localSlot: absSlot - r[mid].base };
        }
        return null;
    }

    /**
     * Attach/re-attach a view's slot range — the arena's field seam (stage() and
     * every realloc re-attach call the view's attachBytePipeline, which lands here).
     * @private
     */
    _attachView(view, pipeline, byteLength, slotBase, sourceBase) {
        // Realloc re-attach of the SAME range: only the slots buffer changed — rebind
        // it and keep the attribute state (colors carry the colorizer's work).
        const sameRange = view.slotBase === slotBase && view.byteCount === byteLength;

        this._ensureCapacity(this.arena.maxBytes);

        const geom = this.field.instanceMesh.geometry;
        const count = Math.max(geom.instanceCount, slotBase + byteLength);
        this.field.attachBytePipeline(pipeline, count);

        if (!sameRange) {
            // The old range's paint lanes hold the colorizer's + highlights' finished
            // work — remember where before tombstoning, to CARRY it (below).
            const oldBase = view.slotBase, oldCount = view.byteCount, oldSource = view.sourceBase;
            if (view.byteCount > 0) this._tombstone(view);
            view.slotBase = slotBase;
            view.byteCount = byteLength;
            if (sourceBase !== undefined) view.sourceBase = sourceBase;
            this.field.setGlyphGroupRange(slotBase, byteLength, view.groupId);
            this.field.setGlyphColorRange(slotBase, byteLength, view.color);
            // THE LANE CARRY, file-byte aligned: the overlap of the old and new
            // ranges IN FILE SPACE keeps its colors — a restage stops flashing the
            // default until the analyzer repaints. Stale by at most one edit's byte
            // shift for ≤ a coalesce window; never blank. (This is the first brick
            // of the compaction mover's remapRanges: same copy, N views at once.)
            if (oldCount > 0 && oldBase >= 0) {
                const ovStart = Math.max(oldSource, view.sourceBase);
                const ovEnd = Math.min(oldSource + oldCount, view.sourceBase + byteLength);
                if (ovEnd > ovStart) {
                    this.field.copyGlyphLanes(
                        oldBase + (ovStart - oldSource),
                        slotBase + (ovStart - view.sourceBase),
                        ovEnd - ovStart,
                    );
                }
            }
            this._rangesDirty = true;
        }
        this._registerPicking();
    }

    /** Point a view's current range at the dead group (group 0). @private */
    _tombstone(view) {
        if (view.byteCount > 0 && view.slotBase >= 0) {
            this.field.setGlyphGroupRange(view.slotBase, view.byteCount, 0);
        }
        view.slotBase = -1;
        view.byteCount = 0;
        this._rangesDirty = true;
    }

    /** Rebuild the sorted range index. LAZY — attach/tombstone mark dirty and the
     *  one reader (resolveSlot, hover-rate) rebuilds: an eager rebuild per attach
     *  was O(views log views) × 2 items × N files across a bulk load. @private */
    _reindexRanges() {
        this._rangesDirty = false;
        this._ranges = this.views
            .filter((v) => !v.dead && v.byteCount > 0)
            .map((v) => ({ base: v.slotBase, end: v.slotBase + v.byteCount, view: v }))
            .sort((a, b) => a.base - b.base);
    }

    /**
     * Grow the per-byte attributes to the arena's (possibly reallocated) capacity,
     * preserving existing lanes — a staged item's slot range never moves (the
     * free-list recycles whole DEAD ranges; live indices are stable).
     * @private
     */
    _ensureCapacity(n) {
        const geom = this.field.instanceMesh.geometry;
        if ((geom._maxInstanceCount || 0) >= n) return;
        console.info(`MegaGlyphField: capacity ${geom._maxInstanceCount} → ${n} instances (arena growth)`);
        for (const [name, itemSize, Ctor, normalized] of [
            ['instanceColor', 3, Float32Array, false],
            ['instanceGroupId', 1, Float32Array, false],
            ['instancePickingId', 1, Float32Array, false],
            ['instanceHighlight', 4, Uint8Array, true],
        ]) {
            const old = geom.attributes[name];
            const arr = new Ctor(n * itemSize);
            if (old) arr.set(old.array.subarray(0, Math.min(old.array.length, arr.length)));
            geom.setAttribute(name, new THREE.InstancedBufferAttribute(arr, itemSize, normalized));
        }
        geom._maxInstanceCount = n;
        this.field.config.maxInstances = n;
        // The pick block re-registers at the new capacity on the next attach.
    }

    /**
     * The ONE glyph-channel registration, at CAPACITY: ID = base + absolute slot for
     * every possible slot, so the block is stable across a whole storm (no per-attach
     * re-registration) — unoccupied slots are dead-group-culled and can never be
     * picked. Re-runs only when the picking system or the capacity changes.
     * @private
     */
    _registerPicking() {
        const ps = this._pickingSystem;
        if (!ps) return;
        let cap = this.field.instanceMesh.geometry._maxInstanceCount || 0;
        // Picking IDs are 24-bit RGB: slots past the ceiling cannot encode. Clamp the
        // block — glyphs beyond the pick space render but never pick — and say so
        // loudly ONCE. The pick target carries 32-bit IDs (RGBA8, alpha = bits
        // 24..31), bounded at 2^31−1 by the shaders' i32 math — 128× the arena's
        // f32-ordinal wall, so the ORDINAL wall is the binding constraint again.
        if (cap > 0x7FFFFFFF) {
            if (!this._pickCeilingNoted) {
                this._pickCeilingNoted = true;
                console.warn(`MegaGlyphField: arena capacity ${cap} exceeds the 31-bit pick ID space — slots past ${0x7FFFFFFF} are unpickable`);
            }
            cap = 0x7FFFFFFF;
        }
        const key = `${cap}`;
        if (cap === 0 || this._pickRegisteredKey === key) return;
        ps.register('glyph', this, this, { count: cap });
        this._pickRegisteredKey = key;
    }

    /** @private */
    _syncPoses() {
        for (const view of this.views) {
            const node = view.node;
            if (!node || view.dead || view.byteCount <= 0) continue;
            const el = node.matrixWorld.elements;
            const m = view._mat;
            let same = true;
            for (let i = 0; i < 16; i++) if (m[i] !== el[i]) { same = false; break; }
            if (same) continue;
            m.set(el);
            node.matrixWorld.decompose(_pos, _quat, _scl);
            this.field.setGroupOffset(view.groupId, _pos);
            this.field.setGroupQuaternion(view.groupId, _quat);
            this.field.setGroupScale(view.groupId, _scl);
        }
    }
}

/**
 * A grid's render presence in the mega-field — speaks the GlyphField surface its
 * consumers use, offset into the shared slot space. One group per view; the
 * group texel carries pose + alpha + clip.
 */
export class MegaFieldView {
    constructor(mega, node, color) {
        this.mega = mega;
        this.node = node || null;
        this.groupId = mega.field.createGroup();
        this.color = color || { r: 0, g: 1, b: 0 };
        this.slotBase = -1;
        this.byteCount = 0;
        /** SOURCE-byte base of this view's range: a WINDOWED grid stages only bytes
         *  [sourceBase, sourceBase + byteCount) of its file, but every caller keeps
         *  speaking FILE byte offsets (the canonical ruler). This is the view's ONE
         *  translation: writes subtract it (clamped to the staged range), pick hits
         *  add it back. 0 = the whole file is staged (every classic grid). */
        this.sourceBase = 0;
        this.bounds = null;      // the GPU's per-item extent (the visibility lane reads this later)
        this.dead = false;
        this._visible = true;
        this._alpha = 1;
        this._mat = new Float32Array(16).fill(NaN); // NaN ≠ anything → first sweep always poses
    }

    /** The arena's attach seam — stage()/adoptField and realloc re-attach call this.
     *  `sourceBase` (the range's first FILE byte) re-points ATOMICALLY with the range;
     *  omitted (realloc's same-range rebind) it keeps its value. */
    attachBytePipeline(pipeline, byteLength, slotBase = 0, sourceBase = undefined) {
        this.mega._attachView(this, pipeline, byteLength, slotBase, sourceBase);
    }

    /** FILE-byte slot range → shared color attribute (the colorizer's write path).
     *  Clamped to the staged window — a range outside it is simply not visible. */
    setGlyphColorRange(startSlot, count, color) {
        if (this.byteCount <= 0) return;
        const local = (startSlot | 0) - this.sourceBase;
        const start = Math.max(0, local);
        const n = Math.min(local + count, this.byteCount) - start;
        if (n > 0) this.mega.field.setGlyphColorRange(this.slotBase + start, n, color);
    }

    /** The whole view's colors from a FILE-byte palette in ONE write: palette[i]
     *  colors file byte i; the staged window reads its slice [sourceBase, …). */
    setGlyphPaletteRange(palette, lut) {
        if (this.byteCount <= 0) return;
        const n = Math.min(this.byteCount, palette.length - this.sourceBase);
        if (n > 0) this.mega.field.setGlyphPaletteRange(this.slotBase, palette, this.sourceBase, n, lut);
    }

    /** FILE-byte slot → shared highlight texture (hover tint, highlight.* verbs). */
    setGlyphHighlight(slot, color, fillOpacity = 0) {
        const local = slot - this.sourceBase;
        if (this.byteCount <= 0 || local < 0 || local >= this.byteCount) return;
        this.mega.field.setGlyphHighlight(this.slotBase + local, color, fillOpacity);
    }

    /**
     * Whole-view alpha (glyphs fade with the panel). The groupId argument is the
     * caller's field-local group 0 — a view IS one group, so it maps here.
     */
    setGroupAlpha(_groupId, alpha) {
        this._alpha = alpha;
        this._applyAlpha();
    }

    /**
     * Whole-view color multiplier/replace (grid.color verbs) — same group mapping.
     * The alpha lane stays the VIEW's (visibility/fade authority) — GlyphField's
     * setGroupColor would otherwise reset it to 1 and resurrect a hidden view.
     */
    setGroupColor(_groupId, color) {
        const a = (this.dead || !this._visible) ? 0 : this._alpha;
        this.mega.field.setGroupColor(this.groupId, { r: color.r, g: color.g, b: color.b, a });
    }

    setGroupColorBlend(_groupId, blend) {
        this.mega.field.setGroupColorBlend(this.groupId, blend);
    }

    /** Show/hide the whole view (the filename toggle). */
    setVisible(v) {
        this._visible = !!v;
        this._applyAlpha();
    }

    /** @private */
    _applyAlpha() {
        this.mega.field.setGroupAlpha(this.groupId, (this.dead || !this._visible) ? 0 : this._alpha);
    }

    /** Grid-local clip window → this view's group clip lanes. */
    setClipYRange(top, bottom) {
        this.mega.field.setGroupClipY(this.groupId, top, bottom);
    }

    /** Slug hot-swap — one shared field, forwarded once. */
    setSlugData(slugData, shaper) {
        this.mega.field.setSlugData(slugData, shaper);
    }

    getGlyphCount() { return this.byteCount; }

    /**
     * The arena's bounds-sync seam: the per-item GPU extent lands here. Stored for
     * the per-view visibility lane (the mega mesh itself is never frustum-culled).
     */
    setLayoutExtent(extent) {
        this.bounds = extent || null;
    }

    /** Drop this view's content (eviction) — the range tombstones to the dead group. */
    clear() {
        this.mega._tombstone(this);
    }

    dispose() {
        this.dead = true;
        this._applyAlpha();
        this.mega._tombstone(this);
        const i = this.mega.views.indexOf(this);
        if (i >= 0) this.mega.views.splice(i, 1);
        // The group id retires with the view (never reused — a reused id would
        // resurrect tombstoned slots). The arena range IS reclaimed (free-list);
        // group-id reuse is the remaining, much smaller follow-up.
    }
}

/**
 * The one mega-field per arena, created on first need and parked on the arena
 * (reachable across module instances — the itest /@fs contract).
 * @param {import('./compute/GlyphPipelineArena.js').default} arena
 * @param {Object} opts - see MegaGlyphField constructor
 * @returns {MegaGlyphField}
 */
export function ensureMegaField(arena, opts = {}) {
    if (!arena.megaField) {
        arena.megaField = new MegaGlyphField(arena, opts);
    } else if (opts.pickingSystem) {
        arena.megaField.setPickingSystem(opts.pickingSystem);
    }
    return arena.megaField;
}

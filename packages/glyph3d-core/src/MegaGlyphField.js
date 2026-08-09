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
import { StorageInstancedBufferAttribute, IndirectStorageBufferAttribute } from 'three/webgpu';
import GlyphField from './GlyphField.js';
import PanelField from './collections/PanelField.js';
import { getPipelineArena } from './compute/GlyphLayoutCompute.js';

/** Label-pill resting style — the bakePillCanvas hairline (2px white @ 0.22) as
 *  live dials. Module state so a persisted setting lands whether the mega field
 *  exists yet or not (the setTabParam pattern). */
export const LABEL_PILL_DEFAULTS = Object.freeze({ hairline: 0.22, hairlineWidth: 1.5 });
const LABEL_PILL_STYLE = { ...LABEL_PILL_DEFAULTS };
export function setLabelPillStyle({ hairline, hairlineWidth } = {}) {
    if (hairline != null) LABEL_PILL_STYLE.hairline = hairline;
    if (hairlineWidth != null) LABEL_PILL_STYLE.hairlineWidth = hairlineWidth;
    getPipelineArena()?.megaField?.labelPanels?.setBorder({
        intensity: LABEL_PILL_STYLE.hairline, width: LABEL_PILL_STYLE.hairlineWidth,
    });
}

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();
const _cullBox = new THREE.Box3();

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
        // The far-texture (minified text mass): ONE sampled slab atlas per arena,
        // shared by every view; the field's per-group slab lanes are its own
        // (setGroupFarSlab, armed by the arena's far pass).
        this.field._farAtlasTexture = arena.farText.texture;
        // (Highlight rides the capacity-sized instanceHighlight ATTRIBUTE — allocated
        // with the other per-byte lanes; a capacity-sized texture blew
        // maxTextureDimension2D at real-workspace scale and re-uploaded whole per write.)

        /** Live views, unordered (dispose splices). @type {MegaFieldView[]} */
        this.views = [];
        /** Pose-only group rentals (panel faces etc.) — swept like view nodes.
         *  @type {Array<{node, groupId, _mat: Float32Array, dead: boolean}>} */
        this._poseGroups = [];
        /** Attached ranges sorted by slotBase for resolveSlot. [{base, end, view}] */
        this._ranges = [];

        this._pickingSystem = pickingSystem || null;
        this._pickRegisteredKey = null;   // `${capacity}` once registered — stable across a storm

        // The panel field: every view's background panel as one instanced draw,
        // posed by the same group texels (see collections/PanelField.js).
        this.panels = new PanelField({ scene, field: this.field });
        // Label pills (tabs, nameplates) — their own instanced draw: translucent
        // plates that never depth-punch neighboring text (the baked-plate look),
        // and the future 'handle' pick block for tab clicks.
        this.labelPanels = new PanelField({ scene, field: this.field, channel: 'handle', depthWrite: false });
        this.labelPanels.mesh.name = 'label-panel-field';
        // The pill hairline at rest — this field's resting border; interaction
        // states render full-strength regardless (the fragment's intensity
        // split). Dials: label.hairline / label.hairlineWidth.
        this.labelPanels.setBorder({
            color: 0xffffff, width: LABEL_PILL_STYLE.hairlineWidth, intensity: LABEL_PILL_STYLE.hairline,
        });
        if (this._pickingSystem) this.panels.registerPicking(this._pickingSystem);

        // RANGE CULLING (the visibility lane): the mega mesh submits one indirect
        // draw RECORD per live view range — {indexCount:6, instanceCount:len,
        // firstIndex:0, baseVertex:0, firstInstance:slotBase}. instance_index
        // starts at firstInstance, so the slot==index address space survives with
        // ZERO shader changes; per frame a CPU frustum test of each view's AABB
        // picks which records to submit (geometry.indirectOffset — read live at
        // draw-encode time, so an onBeforeRender write lands the same frame).
        // Without this, every staged byte ran the full vertex fold every frame
        // (15.5M instances × ~7 loads × 4 verts at workspace scale) — degenerate
        // culling happens AFTER the vertex shader, so off-screen cost ≈ on-screen.
        this._indirect = null;            // { attr, capacity } — 5-uint records
        this._indirectOffsets = [];       // reused per frame (byte offsets)
        this._indirectState = null;       // null=undetected, true=armed, false=unsupported (loud)

        // The pose sweep: before each render, any view whose node moved re-poses its
        // group texel. matrixWorld is current here (three's updateMatrixWorld runs at
        // render start); an unchanged 16-float compare is the whole per-view cost.
        // Hooked on BOTH meshes — panels draw first (background renderOrder), so the
        // sweep must land before whichever draw the pass reaches first.
        this.field.instanceMesh.onBeforeRender = (renderer, _scene, camera) => {
            this._syncPoses();
            this._cullRanges(renderer, camera);
        };
        this.panels.mesh.onBeforeRender = () => this._syncPoses();
        this.labelPanels.mesh.onBeforeRender = () => this._syncPoses();
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

    /** Late picking wire-up (idempotent). The one glyph-channel registration
     *  (+ the panel field's one grid-channel registration). */
    setPickingSystem(ps) {
        if (!ps || this._pickingSystem === ps) return;
        this._pickingSystem = ps;
        this._pickRegisteredKey = null;
        this._registerPicking();
        this.panels.registerPicking(ps);
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
        // The far scatter's color source: a compute-readable view of the (stride-4,
        // storage-class) instanceColor lane. Idempotent; identity only changes with
        // the kernels themselves (arena realloc), which is exactly when every view
        // re-attaches — so the fresh kernels always land the live attribute here.
        this.arena.kernels.setFarColorSource(geom.attributes.instanceColor);

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
            ['instanceColor', 4, Uint8Array, true],
            ['instanceGroupId', 1, Float32Array, false],
            ['instancePickingId', 1, Float32Array, false],
            ['instanceHighlight', 4, Uint8Array, true],
        ]) {
            const old = geom.attributes[name];
            const arr = new Ctor(n * itemSize);
            if (old) arr.set(old.array.subarray(0, Math.min(old.array.length, arr.length)));
            // instanceColor keeps its STORAGE class through growth — the far-scatter
            // kernel binds it as a compute-readable u32 view (see GlyphField's creation note).
            if (name === 'instanceColor') {
                const colorAttr = new StorageInstancedBufferAttribute(arr, itemSize);
                colorAttr.normalized = true;
                geom.setAttribute(name, colorAttr);
            } else {
                geom.setAttribute(name, new THREE.InstancedBufferAttribute(arr, itemSize, normalized));
            }
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

    /**
     * Rent a pose-only group: a texel that tracks `node.matrixWorld` through the
     * same sweep that poses views, with no slot range attached. This is how a
     * flat panel-field instance (a Book page face, a layout backing face) rides
     * a node that has no mega view of its own — a group texel IS a pose, and
     * anything flat can rent one. Group ids retire on release (never reused —
     * the view discipline), so rent per node LIFETIME, not per relayout.
     * @param {THREE.Object3D} node
     * @returns {{groupId: number, release: () => void}}
     */
    createPoseGroup(node) {
        // Float64 cache — matrixWorld.elements are f64; an f32 cache truncates on
        // set and the exact compare then fails FOREVER on any non-f32 value,
        // re-posing every group every sweep (the every-frame full-upload bug).
        const entry = { node, groupId: this.field.createGroup(), _mat: new Float64Array(16).fill(NaN), dead: false };
        this._poseGroups.push(entry);
        const mega = this;
        return {
            groupId: entry.groupId,
            release() {
                if (entry.dead) return;
                entry.dead = true;
                const i = mega._poseGroups.indexOf(entry);
                if (i >= 0) mega._poseGroups.splice(i, 1);
                // The texel recycles — any panel slot still pointing here must
                // already be freed/re-pointed (the face/slot release contract).
                mega.field.releaseGroup(entry.groupId);
                entry.groupId = 0;
            },
        };
    }

    /** @private write one node's decomposed matrixWorld to its group texel (16-float compare gate).
     *  @returns {boolean} whether the matrix changed this sweep */
    _poseFromNode(node, groupId, m) {
        if (!groupId) return false;   // the dead group is nobody's pose sink
        const el = node.matrixWorld.elements;
        let same = true;
        for (let i = 0; i < 16; i++) if (m[i] !== el[i]) { same = false; break; }
        if (same) return false;
        m.set(el);
        node.matrixWorld.decompose(_pos, _quat, _scl);
        this.field.setGroupOffset(groupId, _pos);
        this.field.setGroupQuaternion(groupId, _quat);
        this.field.setGroupScale(groupId, _scl);
        return true;
    }

    /** @private effective scene-graph visibility — a node hidden anywhere up its
     *  chain (or detached from the scene) must not draw, exactly as a mesh
     *  wouldn't. The sweep mirrors this into the view's alpha lane, which is
     *  what makes `label.visible = false` real for substrate-rendered content. */
    _effectiveVisible(node) {
        for (let n = node; n; n = n.parent) {
            if (!n.visible) return false;
            if (n.isScene) return true;
        }
        return false;
    }

    /** @private */
    _syncPoses() {
        for (const view of this.views) {
            if (!view.node || view.dead) continue;
            const vis = this._effectiveVisible(view.node);
            if (vis !== view._nodeVisible) {
                view._nodeVisible = vis;
                view._applyAlpha();
            }
            // A moved node also moves the view's world box (the cull input).
            // Empty views still pose: a plated label with no text rides this texel.
            if (this._poseFromNode(view.node, view.groupId, view._mat)) view._worldBoxDirty = true;
        }
        for (const pg of this._poseGroups) {
            if (!pg.node || pg.dead) continue;
            this._poseFromNode(pg.node, pg.groupId, pg._mat);
        }
    }

    // ── Range culling ────────────────────────────────────────────────────────

    /** @private one-time capability check at the substrate seam. Indirect draws
     *  with nonzero firstInstance need the `indirect-first-instance` device
     *  feature — WITHOUT it the GPU silently no-op's the draw (spec behavior),
     *  so absence must fail LOUD and fall back to the full-range instanced draw
     *  (yesterday's behavior), never a quietly empty screen. */
    _detectIndirect(renderer) {
        const device = renderer?.backend?.device ?? null;
        const ok = !!device?.features?.has?.('indirect-first-instance');
        if (!ok) {
            console.error(
                'MegaGlyphField: range culling disabled — device lacks indirect-first-instance '
                + '(indirect draws would silently no-op). Drawing the FULL field every frame. '
                + `device features: ${device ? [...device.features].join(', ') : 'no device'}`,
            );
            this._indirectState = false;
            return;
        }
        this._indirectState = true;
    }

    /**
     * Per pass: frustum-test each live range's AABB (the GPU bounds lane's
     * per-item extent, taken through the view node's matrixWorld) and submit
     * only the visible slots — as RUN records: adjacent visible ranges coalesce
     * into one indirect draw (gap-tolerant: a small dead gap between them is
     * cheaper to draw degenerate than to pay another encoder call — the
     * all-visible case collapses from ~2k draws to a handful). Records are
     * rewritten per pass; a view with no bounds yet is drawn unconditionally —
     * culling is an optimization, never a correctness gate.
     * geometry.indirect/indirectOffset are read at draw-encode time, so this
     * runs in onBeforeRender with the PASS's camera (main render and the pick
     * pass each cull with the camera that draws them).
     * @private
     */
    _cullRanges(renderer, camera) {
        if (this._indirectState === null) this._detectIndirect(renderer);
        if (!this._indirectState || !camera?.projectionMatrix) return;
        if (this._rangesDirty) this._reindexRanges();

        const r = this._ranges;
        const need = Math.max(1, r.length);
        if (!this._indirect || this._indirect.capacity < need) {
            let cap = Math.max(64, this._indirect?.capacity ?? 0);
            while (cap < need) cap *= 2;
            this._indirect = { attr: new IndirectStorageBufferAttribute(new Uint32Array(cap * 5), 5), capacity: cap };
        }

        _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        _frustum.setFromProjectionMatrix(_projScreen, renderer.coordinateSystem);

        const MERGE_GAP = 4096;                 // dead slots worth drawing to save a draw call
        const a = this._indirect.attr.array;
        const offsets = this._indirectOffsets;
        offsets.length = 0;
        let rec = -1;                           // current run's record index
        let runEnd = -1;
        let visibleRanges = 0;
        for (let i = 0; i < r.length; i++) {
            const view = r[i].view;
            // World box CACHED per view — recomputed only when the pose sweep saw
            // the node move or the GPU bounds landed (a per-frame applyMatrix4
            // across every range was ~1ms of pure overhead at ~2k ranges).
            if (view._worldBoxDirty !== false) {
                const b = view.bounds;
                if (b && view.node && Number.isFinite(b.min?.x) && Number.isFinite(b.max?.x)) {
                    const wb = view._worldBox ?? (view._worldBox = new THREE.Box3());
                    wb.min.set(b.min.x, b.min.y, b.min.z ?? 0);
                    wb.max.set(b.max.x, b.max.y, b.max.z ?? 0);
                    wb.applyMatrix4(view.node.matrixWorld);
                } else {
                    view._worldBox = null;      // no bounds yet → drawn unconditionally
                }
                view._worldBoxDirty = false;
            }
            if (view._worldBox && !_frustum.intersectsBox(view._worldBox)) continue;
            visibleRanges++;
            if (rec >= 0 && r[i].base - runEnd <= MERGE_GAP) {
                a[rec * 5 + 1] = r[i].end - a[rec * 5 + 4];   // extend: count = end − firstInstance
            } else {
                rec = offsets.length;
                const base = rec * 5;
                a[base] = 6;                      // indexCount (the quad's index buffer)
                a[base + 1] = r[i].end - r[i].base;
                a[base + 2] = 0;                  // firstIndex
                a[base + 3] = 0;                  // baseVertex
                a[base + 4] = r[i].base;          // firstInstance — slot address space intact
                offsets.push(rec * 20);           // 5 uints × 4 bytes per record
            }
            runEnd = r[i].end;
        }
        if (offsets.length > 0) {
            this._indirect.attr.addUpdateRange(0, offsets.length * 5);
            this._indirect.attr.needsUpdate = true;
        }
        // Empty offsets array ⇒ the backend's offset loop issues zero draws —
        // exactly right when nothing is on screen. (geometry.instanceCount stays
        // at high-water: an instanceCount of 0 would skip the draw path entirely.)
        this.field.instanceMesh.geometry.setIndirect(this._indirect.attr, offsets);
        this._culledRanges = r.length - visibleRanges;
        this._drawRuns = offsets.length;
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
        this.bounds = null;      // the GPU's per-item extent (the range-culling AABB)
        this._worldBox = null;   // cached world-space box (bounds × matrixWorld)
        this._worldBoxDirty = true;
        this.dead = false;
        this._visible = true;
        this._nodeVisible = true;   // scene-graph visibility, mirrored by the pose sweep
        this._alpha = 1;
        // Float64: matrixWorld.elements are f64 — an f32 cache truncates on set and
        // the exact compare fails forever (every-frame reposing). NaN ≠ anything →
        // the first sweep always poses.
        this._mat = new Float64Array(16).fill(NaN);
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
        if (n > 0) this.mega.arena.markFarDirty(this);
    }

    /** The whole view's colors from a FILE-byte palette in ONE write: palette[i]
     *  colors file byte i; the staged window reads its slice [sourceBase, …). */
    setGlyphPaletteRange(palette, lut) {
        if (this.byteCount <= 0) return;
        const n = Math.min(this.byteCount, palette.length - this.sourceBase);
        if (n > 0) this.mega.field.setGlyphPaletteRange(this.slotBase, palette, this.sourceBase, n, lut);
        if (n > 0) this.mega.arena.markFarDirty(this);
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
        if (!this.groupId) return;
        const a = (this.dead || !this._visible || !this._nodeVisible) ? 0 : this._alpha;
        this.mega.field.setGroupColor(this.groupId, { r: color.r, g: color.g, b: color.b, a });
    }

    setGroupColorBlend(_groupId, blend) {
        if (!this.groupId) return;
        this.mega.field.setGroupColorBlend(this.groupId, blend);
    }

    /** Show/hide the whole view (the filename toggle). */
    setVisible(v) {
        this._visible = !!v;
        this._applyAlpha();
    }

    /** @private (group 0 = the dead group — an exhausted or disposed view's
     *  writes MUST no-op there; resurrecting 0 lights every tombstoned range) */
    _applyAlpha() {
        if (!this.groupId) return;
        this.mega.field.setGroupAlpha(this.groupId, (this.dead || !this._visible || !this._nodeVisible) ? 0 : this._alpha);
    }

    /** Grid-local clip window → this view's group clip lanes. */
    setClipYRange(top, bottom) {
        if (!this.groupId) return;
        this.mega.field.setGroupClipY(this.groupId, top, bottom);
    }

    /** Slug hot-swap — one shared field, forwarded once. */
    setSlugData(slugData, shaper) {
        this.mega.field.setSlugData(slugData, shaper);
    }

    getGlyphCount() { return this.byteCount; }

    /**
     * The arena's bounds-sync seam: the per-item GPU extent lands here — the
     * range-culling AABB (world box recomputed lazily on the next cull pass).
     */
    setLayoutExtent(extent) {
        this.bounds = extent || null;
        this._worldBoxDirty = true;
    }

    /** The arena's far-slab arm — this view's group row in the far carrier texture
     *  (the fragment's far-UV lanes). */
    setFarSlab(u0, v0, rowsPerTexel, colsPerTexel) {
        if (!this.groupId) return;
        this.mega.field.setGroupFarSlab(this.groupId, u0, v0, rowsPerTexel, colsPerTexel);
    }

    /** The far slab is gone (dispose/atlas release) → the impostor fallback. */
    clearFarSlab() {
        if (!this.groupId) return;
        this.mega.field.clearGroupFarSlab(this.groupId);
    }

    /** Drop this view's content (eviction) — the range tombstones to the dead group. */
    clear() {
        this.mega._tombstone(this);
    }

    dispose() {
        this.dead = true;
        this._applyAlpha();
        this.mega._tombstone(this);   // ranges point at DEAD group 0 before the id recycles
        this.clearFarSlab();
        const i = this.mega.views.indexOf(this);
        if (i >= 0) this.mega.views.splice(i, 1);
        // The group id RECYCLES (GlyphField free-list): safe because the range
        // above is already tombstoned to 0, and this view's own writers no-op
        // from here (groupId 0 is the universal dead sink).
        this.mega.field.releaseGroup(this.groupId);
        this.groupId = 0;
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

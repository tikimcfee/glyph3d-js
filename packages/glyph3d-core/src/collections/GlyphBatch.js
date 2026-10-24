/**
 * GlyphBatch — small glyph fields (labels: book tabs, nameplates, dock tile titles) drawn as
 * ranges of ONE field instead of one draw call each.
 *
 * A label stays a real InstancedField: its owner lays out its text, colours it, poses it through
 * the scene graph, hides it, and disposes it. `enrollGlyphField(field)` marks it batchable. While
 * a GlyphBatch serves its scene, the field's mesh leaves the view camera's layer 0 and the batch
 * draws its glyphs in its place, from one arena field:
 *   - glyphs — each label's slots copied into a contiguous range of the arena, their group lane
 *     pointing at the label's own row of the arena's group table, ranges in the order three would
 *     draw the labels (projected depth far → near, then id): where labels overlap, the depth each
 *     glyph writes makes draw order matter. Copied again only when a label's text or colour
 *     changes (its slot buffer's version), membership changes, or that order changes.
 *   - pose — every frame, the label mesh's matrixWorld (camera-relative) decomposed into the
 *     row's offset, rotation and scale, which the glyph vertex shader applies.
 *   - visibility — a label that is hidden (it or an ancestor) or outside the view frustum (its
 *     stated bounding sphere, as three culls it) gets group alpha 0: the shader drops its quads.
 * The arena draws once, at render order 0.5 — after the glyph band it was part of.
 *
 * A label must carry its glyphs in its own group 0 with an identity pose there (FieldLabel's
 * do) and a world matrix the group row can hold (translation · rotation · scale, no shear); one
 * that doesn't draws itself (counted in stats.own). A batched label never goes far-LOD: at a
 * size where its rows are sub-pixel its glyphs are greek bars in the arena, a single draw either
 * way.
 *
 * Refreshes from `scene.onBeforeRender`, after three's matrix update (this frame's poses); pick
 * passes (cameras without layer 0) don't refresh it. Labels aren't pickable today; the arena
 * isn't registered for picking.
 */

import * as THREE from 'three';
import { rootOf, isShown, isTracked } from './SceneTransforms.js';
import InstancedField from './InstancedField.js';
import { GROUP_STRIDE } from '../core/glyphMaterial.js';
import { SLOT_FLOATS, LANE_GROUP_ID } from '../core/InstancedSlotBuffer.js';

/** The view camera renders layer 0; an enrolled field's mesh leaves it while a batch draws it. */
const VIEW_LAYER = 0;
const ROW = GROUP_STRIDE * 4;   // floats per group row

/** @type {Set<THREE.Mesh>} enrolled field meshes currently attached to a parent */
const _meshes = new Set();
/** Bumps whenever membership changes — a batch repacks when it sees a new generation. */
let _generation = 0;

function onAdded(e) { _meshes.add(e.target); _generation++; }
function onRemoved(e) { release(e.target); }
function release(mesh) {
    if (_meshes.delete(mesh)) _generation++;
    if (!mesh.layers.isEnabled(VIEW_LAYER)) mesh.layers.enable(VIEW_LAYER);
}

/**
 * Mark a glyph field batchable. Throws when it has no mesh.
 * @param {InstancedField} field
 * @returns {InstancedField} the field
 */
export function enrollGlyphField(field) {
    const mesh = field?.instanceMesh;
    if (!mesh || mesh.userData.glyphField !== field) throw new Error('enrollGlyphField: needs an InstancedField with its instanceMesh');
    mesh.userData.glyphBatched = true;
    mesh.addEventListener('added', onAdded);
    mesh.addEventListener('removed', onRemoved);
    if (mesh.parent) { _meshes.add(mesh); _generation++; }
    return field;
}

/** Whether a field is enrolled (GlyphFarLod leaves those to the batch). */
export function isBatchedGlyphField(field) {
    return !!field?.instanceMesh?.userData.glyphBatched;
}

/** The enrolled field meshes attached to a parent. */
export function enrolledGlyphFields() {
    return _meshes;
}

/**
 * Why a field can't draw from the arena, or null. Its glyphs must all sit in its group 0, and that
 * row's pose must be identity (the arena row carries the mesh's pose instead).
 * @param {InstancedField} f
 */
function refusal(f) {
    const G = f._groupData;
    if (G[0] !== 0 || G[1] !== 0 || G[2] !== 0) return 'its group 0 is offset';
    if (G[4] !== 0 || G[5] !== 0 || G[6] !== 0 || G[7] !== 1) return 'its group 0 is rotated';
    if (G[12] !== 1 || G[13] !== 1 || G[14] !== 1) return 'its group 0 is scaled';
    const f32 = f.slotBuffer.f32, n = f.getGlyphCount();
    for (let i = 0; i < n; i++) if (f32[i * SLOT_FLOATS + LANE_GROUP_ID] !== 0) return `glyph ${i} is in group ${f32[i * SLOT_FLOATS + LANE_GROUP_ID]}`;
    return null;
}

const _proj = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _sphere = new THREE.Sphere();
const _eye = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _back = new THREE.Matrix4();
const _check = new THREE.Matrix4();
const _c = new THREE.Vector3();
const _zero = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();

/** Whether `a` and `b` agree to f32 precision, element by element. */
function sameMatrix(a, b) {
    const x = a.elements, y = b.elements;
    for (let i = 0; i < 16; i++) if (Math.abs(x[i] - y[i]) > 1e-5 * Math.max(1, Math.abs(x[i]))) return false;
    return true;
}

export default class GlyphBatch {
    /**
     * @param {THREE.Scene} scene - the scene whose enrolled fields this batch draws
     * @param {Object} atlas - the GlyphAtlas the labels shape with (the arena shares its textures)
     */
    constructor(scene, atlas) {
        if (!scene?.isScene) throw new Error('GlyphBatch: needs a THREE.Scene (it hooks scene.onBeforeRender)');
        if (!atlas) throw new Error('GlyphBatch: needs the GlyphAtlas its labels shape with');
        if (!isTracked(scene)) throw new Error('GlyphBatch: the scene needs a SceneTransforms first (rootOf / isShown read its marks)');
        this.scene = scene;
        this.atlas = atlas;
        /** @type {InstancedField|null} */
        this.arena = null;
        /** @type {{ mesh: THREE.Mesh, field: InstancedField, version: number, count: number, depth: number }[]} in slot order; member i is group i + 1 */
        this._members = [];
        /** @type {WeakMap<InstancedField, { version: number, count: number }>} fields refused, keyed to the slot version and count they were refused at */
        this._refused = new WeakMap();
        this._generation = -1;
        /** Last refresh: fields drawn from the arena, hidden, outside the view frustum, drawing
         *  themselves (refused), under another root, and the arena's glyph count. */
        this.stats = { enrolled: 0, drawn: 0, hidden: 0, culled: 0, own: 0, elsewhere: 0, glyphs: 0 };
        const prev = scene.onBeforeRender;
        this._prevHook = prev;
        scene.onBeforeRender = (renderer, sc, camera, target) => {
            prev.call(sc, renderer, sc, camera, target);
            if (camera.layers.isEnabled(VIEW_LAYER)) this.update(camera);
        };
    }

    /** @private (Re)build the arena field with room for `groups` group rows. */
    _arenaFor(groups) {
        if (this.arena && this.arena.maxGroups >= groups) return this.arena;
        this.arena?.dispose();
        const maxGroups = Math.max(64, 2 ** Math.ceil(Math.log2(groups)));
        const arena = new InstancedField(null, this.atlas, {
            maxInstances: 4096,
            maxGroups,
            worldScale: 0.025,
            slugData: this.atlas._slugData,
            shaper: this.atlas._shapeCache || this.atlas._shaper,
            frustumCulled: false,      // labels are culled one by one (group alpha); the arena spans the world
        });
        const mesh = arena.instanceMesh;
        mesh.name = 'glyph-batch';
        mesh.renderOrder = 0.5;
        mesh.matrixAutoUpdate = false;
        mesh.matrixWorldAutoUpdate = false;
        this.scene.add(mesh);
        this.arena = arena;
        return arena;
    }

    /** @private Copy every member's glyphs into the arena, member i in group i + 1. */
    _repack() {
        const members = this._members;
        let total = 0;
        for (const m of members) total += m.count;
        const arena = this._arenaFor(members.length + 1);
        arena.slotBuffer.ensureCapacity(Math.max(total, 1));
        const dst = arena.slotBuffer.f32;
        let at = 0;
        members.forEach((m, i) => {
            const n = m.count;
            dst.set(m.field.slotBuffer.f32.subarray(0, n * SLOT_FLOATS), at * SLOT_FLOATS);
            for (let k = 0; k < n; k++) dst[(at + k) * SLOT_FLOATS + LANE_GROUP_ID] = i + 1;
            at += n;
        });
        arena.setSlots(arena.slotBuffer, total);
        // rows past the members stay dark
        const G = arena._groupData;
        for (let g = members.length + 1; g < arena.maxGroups; g++) G[g * ROW + 11] = 0;
        G[11] = 0;   // group 0: no glyph points at it
    }

    /**
     * Gather every enrolled field in this scene, repack the arena if any label's glyphs changed,
     * and write each label's pose and visibility.
     * Runs from scene.onBeforeRender; callable directly (tests, probes).
     * @param {THREE.Camera} camera - the view camera, matrices current
     */
    update(camera) {
        _proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        _frustum.setFromProjectionMatrix(_proj, THREE.WebGLCoordinateSystem, camera.reversedDepth);
        const eye = camera.getWorldPosition(_eye);

        // membership: who draws from the arena, in a stable order
        let changed = this._generation !== _generation;
        this._generation = _generation;
        let own = 0, elsewhere = 0;
        const next = [];
        for (const mesh of _meshes) {
            if (rootOf(mesh) !== this.scene) { elsewhere++; continue; }
            const field = mesh.userData.glyphField;
            const version = field._interleavedBuffer?.version ?? 0, count = field.getGlyphCount();
            const was = this._refused.get(field);
            if (was && was.version === version && was.count === count) { own++; continue; }
            const why = count ? refusal(field) : null;
            if (why) {
                this._refused.set(field, { version, count });
                console.warn(`GlyphBatch: a field draws itself — ${why}`);
                if (!mesh.layers.isEnabled(VIEW_LAYER)) mesh.layers.enable(VIEW_LAYER);
                own++;
                changed = true;
                continue;
            }
            const bs = field.geometry.boundingSphere;
            _c.copy(bs ? bs.center : _zero).applyMatrix4(mesh.matrixWorld).applyMatrix4(_proj);
            next.push({ mesh, field, version, count, depth: _c.z });
        }
        // three's transparent order: projected depth far → near, then id
        next.sort((x, y) => (y.depth - x.depth) || (x.mesh.id - y.mesh.id));
        const prev = this._members;
        if (!changed && next.length === prev.length) {
            for (let i = 0; i < next.length; i++) {
                const a = next[i], b = prev[i];
                if (a.mesh !== b.mesh || a.version !== b.version || a.count !== b.count) { changed = true; break; }
            }
        } else changed = true;
        this._members = next;
        if (changed) this._repack();
        if (!this.arena) return this.stats;

        // poses + visibility, camera-relative: the arena mesh sits at the eye
        const arena = this.arena, G = arena._groupData;
        let drawn = 0, hidden = 0, culled = 0, glyphs = 0;
        _back.makeTranslation(-eye.x, -eye.y, -eye.z);
        next.forEach((m, i) => {
            const { mesh, field } = m;
            if (mesh.layers.isEnabled(VIEW_LAYER)) mesh.layers.disable(VIEW_LAYER);
            const r = (i + 1) * ROW;
            if (m.count === 0 || !isShown(mesh)) { G[r + 11] = 0; hidden++; return; }
            const bs = field.geometry.boundingSphere;
            if (bs) {
                _sphere.copy(bs).applyMatrix4(mesh.matrixWorld);
                if (!_frustum.intersectsSphere(_sphere)) { G[r + 11] = 0; culled++; return; }
            }
            _m.multiplyMatrices(_back, mesh.matrixWorld).decompose(_pos, _quat, _scale);
            if (!sameMatrix(_m, _check.compose(_pos, _quat, _scale))) {
                // sheared (a non-uniform scale above a rotation): a group row can't hold it
                G[r + 11] = 0;
                mesh.layers.enable(VIEW_LAYER);
                own++;
                return;
            }
            const S = field._groupData;
            G[r] = _pos.x; G[r + 1] = _pos.y; G[r + 2] = _pos.z;
            G[r + 4] = _quat.x; G[r + 5] = _quat.y; G[r + 6] = _quat.z; G[r + 7] = _quat.w;
            for (let k = 8; k < 12; k++) G[r + k] = S[k];          // colour + alpha
            G[r + 12] = _scale.x; G[r + 13] = _scale.y; G[r + 14] = _scale.z; G[r + 15] = S[15];   // scale + colour blend
            for (let k = 16; k < ROW; k++) G[r + k] = S[k];        // clip, background
            drawn++;
            glyphs += m.count;
        });
        arena.groupTexture.needsUpdate = true;
        arena.instanceMesh.matrixWorld.makeTranslation(eye.x, eye.y, eye.z);
        this.stats = { enrolled: _meshes.size, drawn, hidden, culled, own, elsewhere, glyphs };
        return this.stats;
    }

    /** Unhook, drop the arena, and hand every enrolled field back its own draw. */
    dispose() {
        this.scene.onBeforeRender = this._prevHook;
        for (const mesh of _meshes) if (!mesh.layers.isEnabled(VIEW_LAYER)) mesh.layers.enable(VIEW_LAYER);
        this.arena?.dispose();
        this.arena = null;
        this._members = [];
    }
}

/**
 * GlyphFarLod — far-LOD for glyph fields: a field whose rows are smaller on screen than
 * `showGlyphsPx` stops drawing its glyphs, and ONE instanced quad per such field — its
 * backdrop — stands in for them (glyph3d-rs's far-LOD backdrop stream, cull.rs/tint.rs).
 *
 * Below about a pixel per row, glyphs are raster-lottery sub-pixel blobs; what they add up
 * to on screen is a wash of their mean ink colour over the box they fill. The backdrop draws
 * exactly that: the field's laid-out box, in its own frame, tinted by `InstancedField.farTint()`
 * (mean linear ink colour; alpha = ink cover × `backdropGain`). Every backdrop is one draw.
 *
 * The test is the size of the field's TALLEST row at its box's nearest DEPTH along the view
 * direction, not its centre — a long file a camera stands at the end of keeps its glyphs (no
 * pop). Depth, not distance: a flat screen draws a row at `row × focal / depth`, so an
 * off-axis field is larger on screen than its distance says (at the corner of a 70° view,
 * distance would call a row 1.7× smaller than it draws).
 *
 * Only fields whose bounds are truthful take part: three frustum-culls them by their stated
 * extent (`frustumCulled`); fields moved through their group table opt out of both.
 *
 * Hiding is three's layers, not `visible`: the cull clears the field mesh's layer 0, the one
 * the view camera renders. `visible` keeps its owners (the field, its grid, labels, books);
 * the far-LOD never fights them. A far field's glyph pick channel still answers — the pick
 * channels are their own layers.
 *
 * Run `update(camera, viewportHeightPx)` once a frame, before the render. It reads the field
 * meshes' matrixWorld as three last left it (a frame old — `BoundedObject3D.getBounds`'s
 * contract for per-frame readers).
 */

import * as THREE from 'three';
import { liveInstancedFields } from './InstancedField.js';

export const FAR_LOD_DEFAULTS = Object.freeze({
    /** px per row at or above which a field draws its glyphs; 0 = always draw them */
    showGlyphsPx: 1.0,
    /** backdrop alpha = ink cover × this (glyph3d-rs `[lod] backdrop_gain`) */
    backdropGain: 0.7,
});

/** The view camera renders layer 0; a far field leaves it. */
const VIEW_LAYER = 0;

const BACKDROP_VS = `
precision highp float;
in vec3 position;
in mat4 instanceMatrix;
in vec4 aTint;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uGain;
out vec4 vTint;
void main() {
    vTint = vec4(aTint.rgb, min(aTint.a * uGain, 1.0));
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

// Linear colour, premultiplied — the material says so (premultipliedAlpha), so three blends
// it ONE, ONE_MINUS_SRC_ALPHA: the page behind keeps (1 − a) and the tint adds rgb × a.
const BACKDROP_FS = `
precision highp float;
in vec4 vTint;
out vec4 fragColor;
void main() {
    if (vTint.a <= 0.0) discard;
    fragColor = vec4(vTint.rgb * vTint.a, vTint.a);
}
`;

const _box = new THREE.Box3();
const _eye = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _c = new THREE.Vector3();
const _h = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _fit = new THREE.Matrix4();

/** Whether `obj` and every ancestor are visible — a hidden book's far files get no backdrop. */
function shown(obj) {
    for (let o = obj; o; o = o.parent) if (!o.visible) return false;
    return true;
}

export default class GlyphFarLod {
    /**
     * @param {THREE.Object3D} scene - where the backdrop mesh lives
     */
    constructor(scene) {
        this.params = { ...FAR_LOD_DEFAULTS };
        this.scene = scene;
        this._geometry = new THREE.PlaneGeometry(1, 1).translate(0.5, 0.5, 0);
        this._material = new THREE.RawShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: BACKDROP_VS,
            fragmentShader: BACKDROP_FS,
            uniforms: { uGain: { value: this.params.backdropGain } },
            transparent: true,
            premultipliedAlpha: true,
            depthWrite: true,      // as the glyphs do: a nearer backdrop must hide what's behind it
            depthTest: true,
            side: THREE.DoubleSide,
            forceSinglePass: true,
        });
        this._capacity = 0;
        /** @type {THREE.InstancedMesh|null} */
        this.mesh = null;
        this._grow(256);
        /** Last update's tally: fields that took part, how many were far, and the backdrops staged. */
        this.stats = { fields: 0, far: 0, backdrops: 0 };
    }

    /**
     * @param {'showGlyphsPx'|'backdropGain'} key
     * @param {number} value
     */
    setParam(key, value) {
        if (!(key in FAR_LOD_DEFAULTS)) {
            throw new Error(`GlyphFarLod.setParam: unknown param "${key}" (${Object.keys(FAR_LOD_DEFAULTS).join(', ')})`);
        }
        if (!Number.isFinite(value)) return;
        this.params[key] = value;
        if (key === 'backdropGain') this._material.uniforms.uGain.value = value;
    }

    /** @private (Re)build the backdrop mesh with room for `capacity` quads. */
    _grow(capacity) {
        const old = this.mesh;
        const geometry = this._geometry.clone();
        const tint = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
        tint.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute('aTint', tint);
        const mesh = new THREE.InstancedMesh(geometry, this._material, capacity);
        mesh.name = 'glyph-far-backdrops';
        mesh.frustumCulled = false;            // one box can't bound backdrops all over the world
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.count = 0;
        mesh.visible = false;                  // an empty instanced draw is still a draw
        if (old) {
            // grown mid-update: carry the backdrops already staged this frame
            mesh.instanceMatrix.array.set(old.instanceMatrix.array);
            tint.array.set(old.geometry.getAttribute('aTint').array);
            old.parent?.remove(old);
            old.geometry.dispose();
            old.dispose();
        }
        this.scene.add(mesh);
        this.mesh = mesh;
        this._capacity = capacity;
    }

    /**
     * Decide near/far for every live field and restage the backdrops.
     * @param {THREE.Camera} camera - the view camera
     * @param {number} viewportHeightPx - the canvas height in CSS px
     * @returns {{ fields: number, far: number, backdrops: number }}
     */
    update(camera, viewportHeightPx) {
        const minPx = this.params.showGlyphsPx;
        // px on screen per world unit at distance 1 (perspective), or flat (orthographic)
        const pxPerUnit = camera.isPerspectiveCamera
            ? viewportHeightPx / (2 * Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2))
            : viewportHeightPx * camera.zoom / Math.max(camera.top - camera.bottom, 1e-9);
        const eye = camera.getWorldPosition(_eye);
        const fwd = camera.getWorldDirection(_fwd);
        const near = camera.isPerspectiveCamera ? Math.max(camera.near, 1e-3) : 0;

        let fields = 0, far = 0, backdrops = 0;
        for (const field of liveInstancedFields()) {
            const mesh = field.instanceMesh;
            const L = field.layoutBounds;
            if (!mesh || !mesh.frustumCulled || !L || !(field.rowHeight > 0)) {
                if (mesh && !mesh.layers.isEnabled(VIEW_LAYER)) mesh.layers.enable(VIEW_LAYER);
                continue;
            }
            fields++;
            let isFar = false;
            if (minPx > 0 && field.getGlyphCount() > 0) {
                _box.copy(field.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
                const rowWorld = field.rowHeight * mesh.matrixWorld.getMaxScaleOnAxis();
                // the box's nearest view depth: its centre's depth less its half-extent along fwd
                _box.getCenter(_c).sub(eye);
                _box.getSize(_h).multiplyScalar(0.5);
                const depth = _c.dot(fwd) - (Math.abs(fwd.x) * _h.x + Math.abs(fwd.y) * _h.y + Math.abs(fwd.z) * _h.z);
                const rowPx = camera.isPerspectiveCamera
                    ? rowWorld * pxPerUnit / Math.max(depth, near)
                    : rowWorld * pxPerUnit;
                isFar = rowPx < minPx;
            }
            if (isFar) {
                far++;
                if (mesh.layers.isEnabled(VIEW_LAYER)) mesh.layers.disable(VIEW_LAYER);
                if (shown(mesh) && this._stage(backdrops, field, L, mesh)) backdrops++;
            } else if (!mesh.layers.isEnabled(VIEW_LAYER)) {
                mesh.layers.enable(VIEW_LAYER);
            }
        }
        this.mesh.count = backdrops;
        this.mesh.visible = backdrops > 0;
        if (backdrops > 0) {
            this.mesh.instanceMatrix.needsUpdate = true;
            this.mesh.geometry.getAttribute('aTint').needsUpdate = true;
        }
        this.stats = { fields, far, backdrops };
        return this.stats;
    }

    /** @private Write backdrop `i` for a far field; false when it has no ink to stand in for. */
    _stage(i, field, L, mesh) {
        const tint = field.farTint();
        if (!tint || tint.cover <= 0) return false;
        if (i >= this._capacity) this._grow(this._capacity * 2);
        // The laid-out box in the field's own frame, at the front of its depth (where the
        // glyphs face the camera), through the field's world matrix.
        _fit.makeScale(Math.max(L.max.x - L.min.x, 1e-6), Math.max(L.max.y - L.min.y, 1e-6), 1)
            .setPosition(L.min.x, L.min.y, L.max.z);
        this.mesh.setMatrixAt(i, _m.multiplyMatrices(mesh.matrixWorld, _fit));
        const a = this.mesh.geometry.getAttribute('aTint').array;
        a[i * 4] = tint.r; a[i * 4 + 1] = tint.g; a[i * 4 + 2] = tint.b; a[i * 4 + 3] = tint.cover;
        return true;
    }

    dispose() {
        for (const field of liveInstancedFields()) {
            const mesh = field.instanceMesh;
            if (mesh && !mesh.layers.isEnabled(VIEW_LAYER)) mesh.layers.enable(VIEW_LAYER);
        }
        this.mesh?.parent?.remove(this.mesh);
        this.mesh?.geometry.dispose();
        this.mesh?.dispose();
        this._geometry.dispose();
        this._material.dispose();
    }
}

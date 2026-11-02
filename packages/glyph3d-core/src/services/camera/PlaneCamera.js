/**
 * PlaneCamera — a perspective camera that can blend, about a pinned plane, into an orthographic one
 * (DESIGN §4.6, the plane view's exact endpoint). It IS the app's view camera: at blend λ = 1 it is
 * three's PerspectiveCamera, matrix for matrix (updateProjectionMatrix is three's own), so the open
 * world draws as it always has. Below 1, in view space (forward −z), with the plane at depth d₀:
 *
 *     x_clip = sx·x + (1−λ)·h·(z + d₀)       sx = 1/(aspect·tan(φ/2)),  sy = 1/tan(φ/2)
 *     y_clip = sy·y
 *     z_clip = A·z + B                       A = −(λ(f+n) + 2(1−λ)d₀)/(f−n),  B = −(λn + (1−λ)d₀) + A·n
 *     w_clip = −λ·z + (1−λ)·d₀
 *
 * At depth d₀, w = d₀ for every λ: the plane there never changes size, only parallax off it
 * collapses (linearly in λ); λ = 0 is an orthographic camera at the perspective scale of d₀ (its
 * matrix is OrthographicCamera's times the homogeneous scale d₀). z_ndc is monotonic in depth for
 * every λ, so sorting and the depth test hold; near maps to −1 and far to +1 throughout.
 *
 * The shear h (clip x per unit of depth, at λ = 0) is the depth-as-time FAN: layers behind the plane
 * slide sideways by a whole number of device px each (`fanShear`). It fades with λ.
 *
 * A view offset (the pick camera's one-pixel window) is an NDC crop applied after the blend; at
 * λ = 1 it equals three's setViewOffset (tools/plane-camera.test.mjs). copy() carries λ, d₀ and the
 * shear, so `new camera.constructor().copy(camera)` (PickingSystem) picks through the same blend.
 *
 * Below λ = 1 it refuses (throws, naming the value) what it doesn't implement: a zoom, a film
 * offset, the WebGPU coordinate system, reversed depth.
 *
 * Every reading of the camera's scale goes through `services/spatial/spatialMath.js` (clipW /
 * pxPerUnitAt / viewHeightAt), which reads this matrix — true at any λ.
 */

import * as THREE from 'three';

export default class PlaneCamera extends THREE.PerspectiveCamera {
    /**
     * @param {number} [fov] @param {number} [aspect] @param {number} [near] @param {number} [far]
     */
    constructor(fov, aspect, near, far) {
        super(fov, aspect, near, far);
        this.type = 'PlaneCamera';
        /** @type {boolean} */
        this.isPlaneCamera = true;
        /** λ: 1 = perspective (three's own matrix), 0 = orthographic at the scale of planeDepth. */
        this.blend = 1;
        /** d₀: the view depth whose NDC size every λ keeps (world units, > 0). */
        this.planeDepth = 1;
        /** h: clip x per unit of view depth at λ = 0 (the fan); 0 = none. See fanShear. */
        this.shear = 0;
    }

    /** @param {PlaneCamera|THREE.PerspectiveCamera} source @param {boolean} [recursive] */
    copy(source, recursive) {
        super.copy(source, recursive);
        if (source.isPlaneCamera) {
            this.blend = source.blend;
            this.planeDepth = source.planeDepth;
            this.shear = source.shear;
        }
        return this;
    }

    updateProjectionMatrix() {
        // Inside super()'s constructor the blend isn't set yet: three's own matrix, as at λ = 1.
        if (!this.isPlaneCamera || this.blend === 1) { super.updateProjectionMatrix(); return; }
        this._blendMatrix(this.projectionMatrix);
        this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
    }

    /**
     * The blended projection at this camera's λ (any λ in [0, 1], 1 included — the gate compares it
     * with three's), written into `m`. @private
     * @param {THREE.Matrix4} m @returns {THREE.Matrix4}
     */
    _blendMatrix(m) {
        const lam = this.blend, d0 = this.planeDepth, h = this.shear, n = this.near, f = this.far;
        if (!(lam >= 0 && lam <= 1)) throw new Error(`PlaneCamera: blend must be in [0, 1] (got ${lam})`);
        if (!(Number.isFinite(d0) && d0 > 0)) throw new Error(`PlaneCamera: planeDepth must be a finite number > 0 (got ${d0})`);
        if (!Number.isFinite(h)) throw new Error(`PlaneCamera: shear must be finite (got ${h})`);
        if (!(f > n)) throw new Error(`PlaneCamera: far (${f}) must be beyond near (${n})`);
        if (this.zoom !== 1) throw new Error(`PlaneCamera: zoom ${this.zoom} is not supported below blend 1`);
        if (this.filmOffset !== 0) throw new Error(`PlaneCamera: filmOffset ${this.filmOffset} is not supported below blend 1`);
        if (this.coordinateSystem !== THREE.WebGLCoordinateSystem) throw new Error(`PlaneCamera: coordinate system ${this.coordinateSystem} is not written below blend 1 (WebGL only)`);
        if (this.reversedDepth) throw new Error('PlaneCamera: reversed depth is not written below blend 1');
        // sx, sy exactly as three derives them (makePerspective of the near-plane window).
        const top = n * Math.tan(THREE.MathUtils.DEG2RAD * 0.5 * this.fov);
        const height = 2 * top, width = this.aspect * height;
        const sx = 2 * n / width, sy = 2 * n / height;
        const g = 1 - lam;
        const A = -(lam * (f + n) + 2 * g * d0) / (f - n);
        const B = -(lam * n + g * d0) + A * n;
        // Rows: x, y, z, w (row-major for Matrix4.set).
        let r0 = [sx, 0, g * h, g * h * d0];
        let r1 = [0, sy, 0, 0];
        const r2 = [0, 0, A, B];
        const r3 = [0, 0, -lam, g * d0];
        const v = this.view;
        if (v !== null && v.enabled) {
            // The window [offset, offset + size] of the full view, in NDC, stretched to [−1, 1].
            const xl = -1 + 2 * v.offsetX / v.fullWidth, xr = xl + 2 * v.width / v.fullWidth;
            const yt = 1 - 2 * v.offsetY / v.fullHeight, yb = yt - 2 * v.height / v.fullHeight;
            const cx = 2 / (xr - xl), tx = -(xl + xr) / (xr - xl);
            const cy = 2 / (yt - yb), ty = -(yt + yb) / (yt - yb);
            r0 = r0.map((e, i) => cx * e + tx * r3[i]);
            r1 = r1.map((e, i) => cy * e + ty * r3[i]);
        }
        return m.set(...r0, ...r1, ...r2, ...r3);
    }
}

/**
 * The shear that slides a layer `pitch` world units behind the plane by exactly `px` device px
 * (positive → right) at λ = 0: h = −2·px·d₀ / (Wd·pitch). Layer i then lands i·px over — whole px
 * when px is whole and d₀ is the plane's own depth (tools/plane-oblique.test.mjs).
 * @param {{px:number, pitch:number, planeDepth:number, viewportW:number}} p  viewportW in device px
 * @returns {number}
 */
export function fanShear({ px, pitch, planeDepth, viewportW }) {
    if (!(Number.isFinite(px))) throw new Error(`fanShear: px must be finite (got ${px})`);
    if (!(pitch > 0) || !(planeDepth > 0) || !(viewportW > 0)) {
        throw new Error(`fanShear: bad input pitch=${pitch} planeDepth=${planeDepth} viewportW=${viewportW}`);
    }
    return -2 * px * planeDepth / (viewportW * pitch);
}

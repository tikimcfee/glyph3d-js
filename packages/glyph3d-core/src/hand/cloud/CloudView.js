/**
 * CloudView — the hand cloud tracker's stages as a picture-in-picture: its own scene, drawn
 * after the main one into a screen-corner viewport with the depth cleared over a dark
 * backdrop, so nothing in the world can occlude or crowd it. A fixed orthographic camera
 * looks DOWN onto the hand from above (your own view of it: phone +y up the screen, +x right),
 * following the palm.
 *
 *   points   every crop pixel with depth (every `stride`-th), coloured by its class — hand,
 *            arm (cut at the wrist), flying, another blob, background — or by the geodesic
 *            distance the tips stage walked (`colorBy: 'geo'`), or by depth; palm-plane
 *            inliers over that in the palm colour, enclosed (pinch) holes at the palm's depth
 *   tips     fingertip candidates: named (by Vision), unnamed, clipped at the image edge
 *   fit      THE hand: the live model's stabilized display hand (`displayProvider`, drawn every
 *            frame), estimated joints grey; a joint the sensor can't see (outside its image)
 *            red. With no display hand, the tracker's raw fit stands in.
 *   raw      the tracker's raw fit (per result, unstabilized), for comparison — off by default
 *   vision   Vision's own points and skeleton, for comparison — off by default
 *   normal   the palm plane's normal and a ring of its inscribed radius
 *   sensor   what the depth camera sees: its frustum's edges and the image border at the
 *            palm's depth (the hand inside it is measured; outside, it is guessed)
 *
 * The overlay's frame turns red while the hand touches the image border (`setAlert`).
 * Coordinates are the PHONE frame, metres. Every layer toggles (`show`).
 */

import * as THREE from 'three';
import { JOINT_COUNT, SKELETON_CONNECTIONS } from '../HandData.js';
import { CLS } from './cloudBody.js';

export const CLOUD_VIEW_DEFAULTS = {
    fraction: 0.36,   // the overlay's height, fraction of the canvas height
    aspect: 1.25,     // its width / height
    margin: 12,       // px from the canvas corner (top-left)
    span: 0.26,       // metres of desk across the overlay's height
    stride: 2,        // draw every Nth crop pixel in each direction
    pointPx: 2.5,     // point size, pixels
    colorBy: 'class', // class | geo | depth
    follow: 0.25,     // centre on the palm, easing this fraction per frame (0: the phone at the centre)
};

export const CLOUD_LAYERS = ['hand', 'arm', 'fly', 'other', 'bg', 'palm', 'hole', 'tips', 'fit', 'raw', 'vision', 'normal', 'sensor'];
const LAYER_DEFAULTS = { hand: true, arm: true, fly: true, other: true, bg: false, palm: true, hole: true, tips: true, fit: true, raw: false, vision: false, normal: true, sensor: true };

const COLORS = {
    [CLS.HAND]: [0.35, 0.75, 0.95], [CLS.ARM]: [0.62, 0.45, 0.85], [CLS.FLY]: [0.95, 0.3, 0.25],
    [CLS.OTHER]: [0.95, 0.6, 0.2], [CLS.BG]: [0.3, 0.33, 0.4], [CLS.NONE]: [0, 0, 0],
    palm: [1.0, 0.85, 0.3], hole: [1.0, 0.3, 0.85],
};
const CLS_LAYER = { [CLS.HAND]: 'hand', [CLS.ARM]: 'arm', [CLS.FLY]: 'fly', [CLS.OTHER]: 'other', [CLS.BG]: 'bg' };
const SOURCE_COLOR = { cloud: 0x33ff99, vision: 0x5599ff, prior: 0x888888 };
const BACKDROP = 0x0b0e14;
const FRAME_OK = 0x3a4458, FRAME_ALERT = 0xff3b30;
const SENSOR_COLOR = 0x6f7f9f;

const _size = new THREE.Vector2();
const _vp = new THREE.Vector4();
const _sc = new THREE.Vector4();
const _cc = new THREE.Color();

/** Line segments with a fixed vertex capacity. */
function lines(cap, color) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color }));
    l.frustumCulled = false;
    return l;
}

/** Whether a PHONE-frame point lands inside the full depth map. */
function inImage(crop, p) {
    const R = crop.R;
    const X = R[0] * p.x + R[3] * p.y + R[6] * p.z, Y = R[1] * p.x + R[4] * p.y + R[7] * p.z, Z = R[2] * p.x + R[5] * p.y + R[8] * p.z;
    if (!(Z > 1e-6)) return false;
    const u = crop.fx * (X / Z) + crop.cx, v = crop.fy * (Y / Z) + crop.cy;
    return u >= 0 && v >= 0 && u <= crop.w - 1 && v <= crop.h - 1;
}

export default class CloudView {
    /** @param {Partial<typeof CLOUD_VIEW_DEFAULTS>} [opts] */
    constructor(opts = {}) {
        this.place = { ...CLOUD_VIEW_DEFAULTS, ...opts };
        this.show = { ...LAYER_DEFAULTS };
        this.visible = false;
        this.scene = new THREE.Scene();
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
        this.camera.up.set(0, 1, 0);
        this.alert = false;

        this._cap = 0;
        this.pointGeom = new THREE.BufferGeometry();
        this.pointMat = new THREE.PointsMaterial({ size: this.place.pointPx, sizeAttenuation: false, vertexColors: true });
        this.points = new THREE.Points(this.pointGeom, this.pointMat);
        this._grow(4096);

        this.tipGeom = new THREE.BufferGeometry();
        this.tipGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 16), 3));
        this.tipGeom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(3 * 16), 3));
        this.tips = new THREE.Points(this.tipGeom, new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, vertexColors: true }));

        this.fitBones = lines(SKELETON_CONNECTIONS.length * 2, 0x33ff99);
        this.rawBones = lines(SKELETON_CONNECTIONS.length * 2, 0x2a7f5a);
        this.rawJoints = new THREE.InstancedMesh(new THREE.SphereGeometry(0.0025, 8, 5), new THREE.MeshBasicMaterial({ color: 0x2a7f5a }), JOINT_COUNT);
        this.rawJoints.count = 0;
        /** () => {points, estimated} | null — the stabilized hand to draw as THE hand, per frame. */
        this.displayProvider = null;
        this.visionBones = lines(SKELETON_CONNECTIONS.length * 2, 0x5599ff);
        this.fitJoints = new THREE.InstancedMesh(new THREE.SphereGeometry(0.0035, 10, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }), JOINT_COUNT);
        this.fitJoints.count = 0;
        this.visionJoints = new THREE.InstancedMesh(new THREE.SphereGeometry(0.0025, 8, 5), new THREE.MeshBasicMaterial({ color: 0x5599ff }), JOINT_COUNT);
        this.visionJoints.count = 0;
        this.normal = lines(2 + 64 * 2, 0xffd84d);
        // The sensor: 4 frustum edges + the image border at the palm's depth (4 edges).
        this.sensor = lines(16, SENSOR_COLOR);
        // The overlay's frame, in the camera's own plane (rewritten as the camera moves).
        this.frame = lines(8, FRAME_OK);
        this.frame.renderOrder = 10;
        this.frame.material.depthTest = false;

        for (const o of [this.points, this.tips, this.fitJoints, this.visionJoints, this.rawJoints]) o.frustumCulled = false;
        this.scene.add(this.sensor, this.points, this.tips, this.rawBones, this.rawJoints, this.fitBones, this.visionBones, this.fitJoints, this.visionJoints, this.normal, this.frame);
        this._m = new THREE.Matrix4();
        this._c = new THREE.Color();
        this._center = null;
        this.data = null;
        this._dirty = false;
        this._hooked = null;
    }

    /** @private */
    _grow(n) {
        if (n <= this._cap) return;
        this._cap = Math.max(n, this._cap * 2);
        this.pointGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * this._cap), 3));
        this.pointGeom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(3 * this._cap), 3));
    }

    /**
     * Draw after `scene` renders through `camera` to the screen (never into a render target —
     * a pick pass — nor through another camera). Chains any onAfterRender already there.
     * @param {THREE.Scene} scene @param {THREE.Camera} camera
     */
    hook(scene, camera) {
        const prev = scene.onAfterRender;
        scene.onAfterRender = (renderer, s, cam) => {
            prev.call(scene, renderer, s, cam);
            if (cam === camera && renderer.getRenderTarget() === null) this.render(renderer);
        };
        this._hooked = { scene, prev };
    }

    setVisible(v) { this.visible = !!v; }

    /** The hand touches the image border: the frame turns red. */
    setAlert(on) { this.alert = !!on; }

    /** Toggle a layer. @param {string} layer @param {boolean} on */
    setLayer(layer, on) {
        if (!CLOUD_LAYERS.includes(layer)) throw new Error(`CloudView: unknown layer '${layer}' (${CLOUD_LAYERS.join('|')})`);
        this.show[layer] = !!on;
        this._dirty = true;
    }

    /**
     * The latest tracker frame: its view planes (cloudWorker `viewPlanes`) and Vision's hand.
     * Rebuilt into buffers at the next draw.
     */
    setFrame(planes, vision) { this.data = planes ? { planes, vision } : null; this._dirty = true; }

    /** Redraw the current frame at the next draw (after a stride / colour / layer change). */
    refresh() { this._dirty = true; }

    /** Draw into the top-left corner of the current framebuffer. @param {THREE.WebGLRenderer} renderer */
    render(renderer) {
        if (!this.visible) return;
        const p = this.place;
        const size = renderer.getSize(_size);
        const h = Math.round(size.height * p.fraction), w = Math.round(h * p.aspect);
        if (!(w > 8) || !(h > 8) || w + p.margin > size.width) return;
        const x = p.margin, y = size.height - h - p.margin; // viewport y is from the bottom
        this._pose(w / h);
        if (this._dirty) { this._dirty = false; this._rebuild(); }
        this._drawHand();

        renderer.getViewport(_vp);
        renderer.getScissor(_sc);
        const scissorTest = renderer.getScissorTest(), autoClear = renderer.autoClear;
        renderer.getClearColor(_cc);
        const clearAlpha = renderer.getClearAlpha();
        try {
            renderer.setViewport(x, y, w, h);
            renderer.setScissor(x, y, w, h);
            renderer.setScissorTest(true);
            renderer.setClearColor(BACKDROP, 1);
            renderer.clear(true, true, false);
            renderer.autoClear = false;
            renderer.render(this.scene, this.camera);
        } finally {
            renderer.autoClear = autoClear;
            renderer.setClearColor(_cc, clearAlpha);
            renderer.setScissorTest(scissorTest);
            renderer.setScissor(_sc);
            renderer.setViewport(_vp);
        }
    }

    /** The camera: above the hand looking down, the span across the overlay's height. @private */
    _pose(aspect) {
        const p = this.place;
        const c = this.data?.planes?.palm?.center;
        if (c && p.follow > 0) {
            if (!this._center) this._center = { x: c.x, y: c.y };
            else { this._center.x += (c.x - this._center.x) * Math.min(1, p.follow); this._center.y += (c.y - this._center.y) * Math.min(1, p.follow); }
        } else if (!(p.follow > 0)) this._center = { x: 0, y: 0 };
        const cx = this._center?.x ?? 0, cy = this._center?.y ?? 0;
        const hh = p.span / 2, hw = hh * aspect;
        const cam = this.camera;
        cam.left = -hw; cam.right = hw; cam.top = hh; cam.bottom = -hh;
        cam.position.set(cx, cy, 3);
        cam.lookAt(cx, cy, 0);
        cam.updateProjectionMatrix();
        this.pointMat.size = p.pointPx;
        // The frame: the overlay's own edge, just below the camera.
        const f = this.frame.geometry.attributes.position, z = 2.5, e = 0.995;
        const C = [[cx - hw * e, cy - hh * e], [cx + hw * e, cy - hh * e], [cx + hw * e, cy + hh * e], [cx - hw * e, cy + hh * e]];
        for (let i = 0; i < 4; i++) { const a = C[i], b = C[(i + 1) % 4]; f.setXYZ(2 * i, a[0], a[1], z); f.setXYZ(2 * i + 1, b[0], b[1], z); }
        f.needsUpdate = true;
        this.frame.material.color.setHex(this.alert ? FRAME_ALERT : FRAME_OK);
    }

    /** @private */
    _rebuild() {
        const f = this.data;
        const P = f?.planes || null;
        this._drawPoints(P);
        this._drawTips(P);
        this._drawSkeleton(this.rawBones, this.rawJoints, this.show.raw ? P?.fit?.joints : null, null, null);
        this._drawSkeleton(this.visionBones, this.visionJoints, this.show.vision ? f?.vision?.points || null : null, null, null);
        this._drawNormal(this.show.normal ? P?.palm : null);
        this._drawSensor(this.show.sensor ? P : null);
    }

    /**
     * THE hand, every frame: the display provider's stabilized joints (estimated → grey), else
     * the raw fit's; joints outside the depth image red.
     * @private
     */
    _drawHand() {
        const P = this.data?.planes;
        const d = this.show.fit ? this.displayProvider?.() ?? null : null;
        let pts = null, source = null;
        if (d?.points) {
            pts = d.points;
            source = d.points.map((_, j) => (d.estimated?.[j] ? 'prior' : 'cloud'));
        } else if (this.show.fit && P?.fit) { pts = P.fit.joints; source = P.fit.source; }
        const out = pts && P?.crop ? pts.map((p) => !p || !inImage(P.crop, p)) : null;
        this._drawSkeleton(this.fitBones, this.fitJoints, pts, source, out);
        this.drawn = d?.points ? 'display' : pts ? 'raw' : null;
    }

    /** @private */
    _drawPoints(P) {
        if (!P) { this.pointGeom.setDrawRange(0, 0); return; }
        const { crop, xyz, cls, geo, inliers, holeIdx } = P;
        const n = crop.rw * crop.rh, s = Math.max(1, Math.round(this.place.stride));
        const mark = new Uint8Array(n);
        if (this.show.palm) for (const i of inliers) mark[i] = 1;
        let maxGeo = 0;
        if (this.place.colorBy === 'geo' && geo) for (let i = 0; i < n; i++) if (cls[i] === CLS.HAND && geo[i] !== Infinity && geo[i] > maxGeo) maxGeo = geo[i];
        this._grow(Math.ceil(n / (s * s)) + (holeIdx?.length || 0) + 16);
        const pos = this.pointGeom.attributes.position.array, col = this.pointGeom.attributes.color.array;
        let k = 0;
        const put = (x, y, z, r, g, b) => {
            pos[3 * k] = x; pos[3 * k + 1] = y; pos[3 * k + 2] = z;
            col[3 * k] = r; col[3 * k + 1] = g; col[3 * k + 2] = b;
            k++;
        };
        for (let j = 0; j < crop.rh; j += s) {
            for (let x = 0; x < crop.rw; x += s) {
                const i = j * crop.rw + x;
                const c = cls[i];
                if (c === CLS.NONE || !this.show[CLS_LAYER[c]]) continue;
                let rgb = COLORS[c];
                if (mark[i] === 1) rgb = COLORS.palm;
                else if (c === CLS.HAND && this.place.colorBy === 'geo' && geo && maxGeo > 0 && geo[i] !== Infinity) {
                    this._c.setHSL(0.66 * (1 - geo[i] / maxGeo), 0.9, 0.55); rgb = [this._c.r, this._c.g, this._c.b];
                } else if (this.place.colorBy === 'depth' && c !== CLS.BG) {
                    this._c.setHSL(Math.max(0, Math.min(0.8, (xyz[3 * i + 2] - 0.1) * 2)), 0.9, 0.55); rgb = [this._c.r, this._c.g, this._c.b];
                }
                put(xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2], rgb[0], rgb[1], rgb[2]);
            }
        }
        if (this.show.hole && holeIdx?.length && P.palm) {
            const R = crop.R, zc = P.palm.center.z;
            for (let q = 0; q < holeIdx.length; q++) {
                const i = holeIdx[q], kk = i % crop.rw, jj = (i - kk) / crop.rw;
                const X = (crop.x0 + kk - crop.cx) / crop.fx, Y = (crop.y0 + jj - crop.cy) / crop.fy;
                const dx = R[0] * X + R[1] * Y + R[2], dy = R[3] * X + R[4] * Y + R[5], dz = R[6] * X + R[7] * Y + R[8];
                const t = zc / dz;
                put(dx * t, dy * t, dz * t, ...COLORS.hole);
            }
        }
        this.pointGeom.setDrawRange(0, k);
        this.pointGeom.attributes.position.needsUpdate = true;
        this.pointGeom.attributes.color.needsUpdate = true;
    }

    /** @private */
    _drawTips(P) {
        const tips = this.show.tips && P ? P.tips.slice(0, 16) : [];
        const pos = this.tipGeom.attributes.position.array, col = this.tipGeom.attributes.color.array;
        tips.forEach((t, k) => {
            pos[3 * k] = t.p.x; pos[3 * k + 1] = t.p.y; pos[3 * k + 2] = t.p.z;
            const rgb = t.clipped ? [0.5, 0.5, 0.5] : t.joint != null ? [0.2, 1, 0.6] : [1, 1, 1];
            col[3 * k] = rgb[0]; col[3 * k + 1] = rgb[1]; col[3 * k + 2] = rgb[2];
        });
        this.tipGeom.setDrawRange(0, tips.length);
        this.tipGeom.attributes.position.needsUpdate = true;
        this.tipGeom.attributes.color.needsUpdate = true;
    }

    /** @private */
    _drawSkeleton(lineObj, joints, pts, source, outOfView) {
        const pos = lineObj.geometry.attributes.position;
        let k = 0;
        if (pts) {
            for (const [a, b] of SKELETON_CONNECTIONS) {
                const pa = pts[a], pb = pts[b];
                if (!pa || !pb) continue;
                pos.setXYZ(k++, pa.x, pa.y, pa.z);
                pos.setXYZ(k++, pb.x, pb.y, pb.z);
            }
        }
        lineObj.geometry.setDrawRange(0, k);
        pos.needsUpdate = true;
        let n = 0;
        if (pts) {
            for (let j = 0; j < JOINT_COUNT; j++) {
                const p = pts[j];
                if (!p) continue;
                this._m.makeTranslation(p.x, p.y, p.z);
                joints.setMatrixAt(n, this._m);
                if (source) joints.setColorAt(n, this._c.setHex(outOfView?.[j] ? 0xff3b30 : SOURCE_COLOR[source[j]] ?? 0xffffff));
                n++;
            }
        }
        joints.count = n;
        joints.instanceMatrix.needsUpdate = true;
        if (joints.instanceColor) joints.instanceColor.needsUpdate = true;
    }

    /** @private */
    _drawNormal(palm) {
        const g = this.normal.geometry, pos = g.attributes.position;
        if (!palm) { g.setDrawRange(0, 0); return; }
        const c = palm.center, nn = palm.normal;
        pos.setXYZ(0, c.x, c.y, c.z);
        pos.setXYZ(1, c.x - nn.x * 0.05, c.y - nn.y * 0.05, c.z - nn.z * 0.05);
        const u = palm.axis, w = { x: nn.y * u.z - nn.z * u.y, y: nn.z * u.x - nn.x * u.z, z: nn.x * u.y - nn.y * u.x };
        let k = 2;
        const r = palm.radius;
        for (let s = 0; s < 64; s++) {
            for (const a of [(s / 64) * 2 * Math.PI, ((s + 1) / 64) * 2 * Math.PI]) {
                const ca = Math.cos(a) * r, sa = Math.sin(a) * r;
                pos.setXYZ(k++, c.x + u.x * ca + w.x * sa, c.y + u.y * ca + w.y * sa, c.z + u.z * ca + w.z * sa);
            }
        }
        g.setDrawRange(0, k);
        pos.needsUpdate = true;
    }

    /** The depth camera's frustum edges to the palm's depth and its image border there. @private */
    _drawSensor(P) {
        const g = this.sensor.geometry, pos = g.attributes.position;
        if (!P?.crop) { g.setDrawRange(0, 0); return; }
        const { crop } = P, R = crop.R;
        const z = P.palm?.center?.z ?? 0.25;
        // The full map's outer edge, on the plane at the palm's depth.
        const corner = (u, v) => {
            const X = (u - crop.cx) / crop.fx, Y = (v - crop.cy) / crop.fy;
            const dx = R[0] * X + R[1] * Y + R[2], dy = R[3] * X + R[4] * Y + R[5], dz = R[6] * X + R[7] * Y + R[8];
            const t = z / dz;
            return [dx * t, dy * t, dz * t];
        };
        const C = [corner(-0.5, -0.5), corner(crop.w - 0.5, -0.5), corner(crop.w - 0.5, crop.h - 0.5), corner(-0.5, crop.h - 0.5)];
        let k = 0;
        for (let i = 0; i < 4; i++) {
            pos.setXYZ(k++, 0, 0, 0); pos.setXYZ(k++, ...C[i]);
            pos.setXYZ(k++, ...C[i]); pos.setXYZ(k++, ...C[(i + 1) % 4]);
        }
        g.setDrawRange(0, k);
        pos.needsUpdate = true;
    }

    dispose() {
        if (this._hooked) { this._hooked.scene.onAfterRender = this._hooked.prev; this._hooked = null; }
        this.scene.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
        this.fitJoints.dispose();
        this.visionJoints.dispose();
        this.rawJoints.dispose();
    }
}

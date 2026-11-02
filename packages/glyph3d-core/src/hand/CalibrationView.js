/**
 * CalibrationView — the calibration flow's in-scene picture: the phone on the desk, the hand
 * it sees (its METRIC joints, not the image-space skeleton HandRenderer draws), the volume
 * measured so far and the palm's facing — a small model of the real desk, so what the numbers
 * say can be seen.
 *
 * It hangs off a camera-locked parent (HandPresence's rig: rig-local space is camera space in
 * near-plane units), placed by `place` — an offset across the view (fractions of the visible
 * half extents at its depth), a depth, a size (rig units per meter) and a downward tilt, so
 * the desk reads from a little above. Phone axes map to view axes the way the user sits:
 * phone +x (right) → +x, +z (up) → +y, +y (away) → −z.
 *
 * Plain unlit meshes and lines; frustum culling off (they are small, re-written every frame,
 * and sit in front of the camera by construction).
 */

import * as THREE from 'three';
import { JOINT_COUNT, SKELETON_CONNECTIONS } from './HandData.js';
import { RENDER_ORDER } from '../core/renderOrder.js';

export const CALIBRATION_VIEW_DEFAULTS = {
    x: 0.55,          // across the view, fraction of the visible half width (+ = right)
    y: -0.3,          // fraction of the visible half height (+ = up)
    depth: -6,        // camera-local z, near-plane units
    size: 4,          // rig units per meter of desk
    tiltDeg: 25,      // look down onto the desk
};

/** Phone (m) → view-local. */
const toView = (p, out) => out.set(p.x, p.z, -p.y);

const PHONE = { w: 0.072, h: 0.150, d: 0.008 };

export default class CalibrationView {
    /** @param {Partial<typeof CALIBRATION_VIEW_DEFAULTS>} [opts] */
    constructor(opts = {}) {
        this.place = { ...CALIBRATION_VIEW_DEFAULTS, ...opts };
        this.group = new THREE.Group();
        this.group.name = 'calibration-view';
        this.group.visible = false;
        this.desk = new THREE.Group();      // the tilted model, in meters
        this.group.add(this.desk);

        const basic = (color, extra = {}) => new THREE.MeshBasicMaterial({ color, ...extra });
        const line = (color, opacity = 1) => new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
        this._materials = [];
        const keep = (m) => { this._materials.push(m); return m; };

        // The phone: a slab, face-down, with a bar at its top edge (the edge away from you).
        const phone = new THREE.Mesh(new THREE.BoxGeometry(PHONE.w, PHONE.d, PHONE.h), keep(basic(0x2a3140)));
        phone.position.set(0, -PHONE.d / 2, -0.03);
        const top = new THREE.Mesh(new THREE.BoxGeometry(PHONE.w * 0.6, PHONE.d * 1.2, 0.006), keep(basic(0x6fa8dc)));
        top.position.set(0, -PHONE.d / 2, -0.03 - PHONE.h / 2 + 0.006);
        this.desk.add(phone, top);
        // The desk plane, as a grid of lines 0.5 m across.
        const grid = new THREE.GridHelper(0.5, 10, 0x30384a, 0x1f2533);
        grid.position.y = -PHONE.d;
        keep(grid.material);
        this.desk.add(grid);

        // The hand: joints as instanced spheres, bones as one line set.
        this.joints = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.004, 1), keep(basic(0x00ffcc)), JOINT_COUNT);
        this.joints.count = 0;
        this.joints.renderOrder = RENDER_ORDER.HAND_JOINT;
        const bonePos = new Float32Array(SKELETON_CONNECTIONS.length * 2 * 3);
        const boneGeom = new THREE.BufferGeometry();
        boneGeom.setAttribute('position', new THREE.BufferAttribute(bonePos, 3));
        this.bones = new THREE.LineSegments(boneGeom, keep(line(0x00ff88)));
        this.bones.renderOrder = RENDER_ORDER.HAND_BONE;

        // The palm's facing: a line from the palm centre.
        const nGeom = new THREE.BufferGeometry();
        nGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
        this.normal = new THREE.LineSegments(nGeom, keep(line(0xffcc66)));

        // The measured volume (a box of lines) and its centre.
        this.volume = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), keep(line(0xc2a25d, 0.9)));
        this.volume.visible = false;
        this.center = new THREE.Mesh(new THREE.IcosahedronGeometry(0.005, 1), keep(basic(0xc2a25d)));
        this.center.visible = false;

        this.desk.add(this.joints, this.bones, this.normal, this.volume, this.center);
        this.group.traverse((o) => { o.frustumCulled = false; });
        this._m = new THREE.Matrix4();
        this._v = new THREE.Vector3();
        this._w = new THREE.Vector3();
    }

    /** @param {THREE.Object3D} parent - a camera-locked rig */
    attachTo(parent) { parent.add(this.group); }

    setVisible(v) { this.group.visible = !!v; }

    /**
     * Pose the view on its rig and draw the latest state.
     * @param {{halfW: number, halfH: number}|null} extent - visible half extents at depth 1 (rig units)
     * @param {{points?: ({x:number,y:number,z:number}|null)[]|null, palm?: {x:number,y:number,z:number}|null,
     *   normal?: {x:number,y:number,z:number}|null, volume?: {min: Object, max: Object, center: Object}|null}} state
     */
    update(extent, state) {
        if (!this.group.visible) return;
        const p = this.place, d = Math.abs(p.depth);
        this.group.position.set(p.x * (extent?.halfW ?? 1) * d, p.y * (extent?.halfH ?? 1) * d, p.depth);
        this.group.scale.setScalar(p.size);
        this.desk.rotation.x = (p.tiltDeg * Math.PI) / 180;

        // Joints + bones.
        const pts = state.points || null;
        let n = 0;
        if (pts) {
            for (let j = 0; j < JOINT_COUNT; j++) {
                if (!pts[j]) continue;
                toView(pts[j], this._v);
                this._m.makeTranslation(this._v.x, this._v.y, this._v.z);
                this.joints.setMatrixAt(n++, this._m);
            }
        }
        this.joints.count = n;
        this.joints.instanceMatrix.needsUpdate = true;
        const pos = this.bones.geometry.attributes.position;
        let k = 0;
        for (const [a, b] of SKELETON_CONNECTIONS) {
            const pa = pts?.[a], pb = pts?.[b];
            if (pa && pb) {
                toView(pa, this._v); toView(pb, this._w);
                pos.setXYZ(k++, this._v.x, this._v.y, this._v.z);
                pos.setXYZ(k++, this._w.x, this._w.y, this._w.z);
            }
        }
        this.bones.geometry.setDrawRange(0, k);
        pos.needsUpdate = true;

        // Palm facing, 5 cm long.
        const np = this.normal.geometry.attributes.position;
        if (state.palm && state.normal) {
            toView(state.palm, this._v);
            toView({ x: state.palm.x + state.normal.x * 0.05, y: state.palm.y + state.normal.y * 0.05, z: state.palm.z + state.normal.z * 0.05 }, this._w);
            np.setXYZ(0, this._v.x, this._v.y, this._v.z);
            np.setXYZ(1, this._w.x, this._w.y, this._w.z);
            this.normal.geometry.setDrawRange(0, 2);
        } else this.normal.geometry.setDrawRange(0, 0);
        np.needsUpdate = true;

        // The volume.
        const vol = state.volume;
        const okVol = vol?.min && vol?.max && [vol.min.x, vol.max.x, vol.min.y, vol.max.y, vol.min.z, vol.max.z].every(Number.isFinite);
        this.volume.visible = !!okVol;
        this.center.visible = !!okVol;
        if (okVol) {
            const c = { x: (vol.min.x + vol.max.x) / 2, y: (vol.min.y + vol.max.y) / 2, z: (vol.min.z + vol.max.z) / 2 };
            toView(c, this._v);
            this.volume.position.copy(this._v);
            this.volume.scale.set(
                Math.max(1e-4, vol.max.x - vol.min.x),
                Math.max(1e-4, vol.max.z - vol.min.z),
                Math.max(1e-4, vol.max.y - vol.min.y),
            );
            this.center.position.copy(this._v);
        }
    }

    dispose() {
        this.group.parent?.remove(this.group);
        this.group.traverse((o) => { o.geometry?.dispose?.(); });
        for (const m of this._materials) m.dispose();
        this.joints.dispose();
    }
}

/**
 * MinimapPass — the 3D overview in a corner of the frame: a schematic of the whole space (one box
 * per surface, coloured by kind) and the view camera drawn as a frustum cone, so position and
 * heading read at a glance. A render PASS, not a loop owner: the app's render-pass owner
 * (app/client/RenderPasses.jsx) calls `render` after the frame's earlier passes.
 *
 * Two draws for any surface count: one InstancedMesh of unit boxes (per-instance matrix + colour)
 * and one LineSegments whose positions are the boxes' 12 edges, written into a preallocated buffer.
 * Change-stamped: a slot rewrites only when its surface's bounds or kind moved (an f64 compare of
 * centre + size — an f32 stamp would truncate and never match), and the upload covers just the
 * changed span; a still workspace uploads nothing.
 */

import * as THREE from 'three';
import { worldBounds } from '../spatial/sceneBounds.js';

const _rsize = new THREE.Vector2();
const FILL_COLORS = { grid: 0x4f7fff, terminal: 0x3fbf8f, frame: 0xbf8f3f };
const EDGE_COLORS = { grid: 0x9fc0ff, terminal: 0x8ff0c8, frame: 0xf0c884 };
const KINDS = ['grid', 'terminal', 'frame'];

function makeFills(geo, material, capacity) {
    const fills = new THREE.InstancedMesh(geo, material, capacity);
    fills.frustumCulled = false;
    return fills;
}

export default class MinimapPass {
    /**
     * @param {{toArray: (type: string) => Object[]}} registry  the surfaces (grid / terminal / frame)
     * @param {{fraction?: number, margin?: number, fov?: number, viewDir?: number[]}} [opts]
     *   the corner's share of the frame, its margin (px), the overview camera's fov and direction
     */
    constructor(registry, { fraction = 0.26, margin = 12, fov = 35, viewDir = [0.4, 0.75, 1.0] } = {}) {
        if (!registry?.toArray) throw new Error('MinimapPass: needs a registry (toArray)');
        this.registry = registry;
        this.fraction = fraction;
        this.margin = margin;
        this.fov = fov;
        this.viewDir = viewDir;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0a0c12);
        this.camera = new THREE.PerspectiveCamera(fov, 1, 1, 100000);

        this._boxGeo = new THREE.BoxGeometry(1, 1, 1);
        // A unit box's 12 edges as segment endpoints (24 verts), from EdgesGeometry so it can't drift.
        this._edgeTemplate = new THREE.EdgesGeometry(this._boxGeo).getAttribute('position').array.slice();
        this._edgeVerts = this._edgeTemplate.length;   // 72 floats per box
        this._capacity = 512;
        this._fills = makeFills(this._boxGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.42, depthWrite: false }), this._capacity);
        this._fills.count = 0;
        this._edgeGeo = new THREE.BufferGeometry();
        this._edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this._capacity * this._edgeVerts), 3));
        this._edgeGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this._capacity * this._edgeVerts), 3));
        this._edges = new THREE.LineSegments(this._edgeGeo,
            new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false }));
        this._edges.frustumCulled = false;
        this._proxies = new THREE.Group();
        this._proxies.add(this._fills, this._edges);
        this.scene.add(this._proxies);

        // The view camera: a translucent cone (apex at the eye, flaring along the view) + an apex dot.
        this._coneGeo = new THREE.ConeGeometry(0.45, 1, 22);
        this._coneGeo.translate(0, -0.5, 0);     // apex → origin
        this._coneGeo.rotateX(Math.PI / 2);      // axis +Y → −Z (a camera looks down its −Z)
        this._cone = new THREE.Mesh(this._coneGeo, new THREE.MeshBasicMaterial({
            color: 0xff6ea0, transparent: true, opacity: 0.34, depthWrite: false, side: THREE.DoubleSide,
            forceSinglePass: true,   // uniform colour + depthWrite off → face order can't change a pixel
        }));
        this._apex = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff6ea0 }));
        this.scene.add(this._cone, this._apex);

        this._stamps = new Float64Array(this._capacity * 6).fill(NaN);   // NaN ≠ anything → the first frame writes
        this._typeStamps = new Array(this._capacity).fill(null);
        this._box = new THREE.Box3(); this._v = new THREE.Vector3(); this._c = new THREE.Vector3();
        this._col = new THREE.Color(); this._m4 = new THREE.Matrix4(); this._list = [];
        this._warned = false;
    }

    /** Grow the proxy buffers (×2); the NaN stamps make every slot rewrite next frame. @private */
    _ensureCapacity(n) {
        if (n <= this._capacity) return;
        while (this._capacity < n) this._capacity *= 2;
        const fills = makeFills(this._fills.geometry, this._fills.material, this._capacity);
        this._proxies.remove(this._fills);
        this._fills.dispose();
        this._fills = fills;
        this._proxies.add(fills);
        this._edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this._capacity * this._edgeVerts), 3));
        this._edgeGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this._capacity * this._edgeVerts), 3));
        this._stamps = new Float64Array(this._capacity * 6).fill(NaN);
        this._typeStamps = new Array(this._capacity).fill(null);
    }

    /** Write the skyline from the registry and frame the overview on it and the view camera. @private */
    _sync(viewCamera) {
        const tagged = [];
        for (const t of KINDS) for (const s of this.registry.toArray(t)) tagged.push([s, t]);
        this._ensureCapacity(tagged.length);
        const posAttr = this._edgeGeo.getAttribute('position');
        const colAttr = this._edgeGeo.getAttribute('color');
        const et = this._edgeTemplate, ev = this._edgeVerts;
        const st = this._stamps, ts = this._typeStamps, c = this._c, v = this._v;
        this._list.length = 0;
        let n = 0, lo = Infinity, hi = -1;
        for (let i = 0; i < tagged.length; i++) {
            const [s, type] = tagged[i];
            this._list.push(s);
            const b = s.getBounds?.();
            if (!b || b.isEmpty?.()) continue;
            b.getCenter(c);
            b.getSize(v);
            const sb = n * 6;
            if (st[sb] === c.x && st[sb + 1] === c.y && st[sb + 2] === c.z
                && st[sb + 3] === v.x && st[sb + 4] === v.y && st[sb + 5] === v.z && ts[n] === type) { n++; continue; }
            st[sb] = c.x; st[sb + 1] = c.y; st[sb + 2] = c.z;
            st[sb + 3] = v.x; st[sb + 4] = v.y; st[sb + 5] = v.z;
            ts[n] = type;
            if (n < lo) lo = n;
            if (n > hi) hi = n;
            const sx = Math.max(v.x, 0.01), sy = Math.max(v.y, 0.01), sz = Math.max(v.z, 0.01);
            this._m4.makeScale(sx, sy, sz).setPosition(c);
            this._fills.setMatrixAt(n, this._m4);
            this._fills.setColorAt(n, this._col.set(FILL_COLORS[type]));
            this._col.set(EDGE_COLORS[type]);
            const base = n * ev;
            for (let k = 0; k < ev; k += 3) {
                posAttr.array[base + k] = et[k] * sx + c.x;
                posAttr.array[base + k + 1] = et[k + 1] * sy + c.y;
                posAttr.array[base + k + 2] = et[k + 2] * sz + c.z;
                colAttr.array[base + k] = this._col.r;
                colAttr.array[base + k + 1] = this._col.g;
                colAttr.array[base + k + 2] = this._col.b;
            }
            n++;
        }
        this._fills.count = n;
        this._edgeGeo.setDrawRange(0, n * (ev / 3));
        if (hi >= 0) {
            const span = hi - lo + 1;
            this._fills.instanceMatrix.addUpdateRange(lo * 16, span * 16);
            this._fills.instanceMatrix.needsUpdate = true;
            if (this._fills.instanceColor) {
                this._fills.instanceColor.addUpdateRange(lo * 3, span * 3);
                this._fills.instanceColor.needsUpdate = true;
            }
            posAttr.addUpdateRange(lo * ev, span * ev);
            posAttr.needsUpdate = true;
            colAttr.addUpdateRange(lo * ev, span * ev);
            colAttr.needsUpdate = true;
        }

        // The shared world extent (+ the eye, so the cone never leaves the map).
        const union = worldBounds(this._list, this._box, { expandToInclude: viewCamera.position });
        const center = union.getCenter(c);
        const radius = union.isEmpty() ? 200 : Math.max(union.getSize(v).length() * 0.5, 1);
        const dir = v.set(this.viewDir[0], this.viewDir[1], this.viewDir[2]).normalize();
        const dist = radius / Math.sin((this.fov * Math.PI / 180) / 2) * 1.15;
        const mc = this.camera;
        mc.position.copy(center).addScaledVector(dir, dist);
        mc.up.set(0, 1, 0);
        mc.lookAt(center);
        mc.far = dist + radius * 4 + 1000;
        mc.updateProjectionMatrix();

        // The cone: at the eye, oriented like it, scaled to the scene.
        const cs = Math.max(radius * 0.16, 4);
        this._cone.position.copy(viewCamera.position);
        this._cone.quaternion.copy(viewCamera.quaternion);
        this._cone.scale.setScalar(cs);
        this._apex.position.copy(viewCamera.position);
        this._apex.scale.setScalar(cs * 0.06);
    }

    /**
     * Draw the overview into its corner of the current framebuffer (a scissored viewport, logical px,
     * y from the bottom), measured off the RENDERER's live size — r3f's store can lead the actual
     * targets by a frame (resizes apply at the frame boundary), and a scissor from it lands out of
     * bounds. A degenerate size (a dock transient) draws nothing. A failure restores the viewport
     * and is logged once — the frame's other passes already drew.
     * @param {THREE.WebGLRenderer} renderer @param {THREE.Camera} viewCamera
     */
    render(renderer, viewCamera) {
        try {
            this._sync(viewCamera);
            const rsize = renderer.getSize(_rsize);
            const w = Math.round(rsize.width * this.fraction);
            const h = Math.round(rsize.height * this.fraction);
            const x = rsize.width - w - this.margin;
            const y = this.margin;
            if (!(w > 4) || !(h > 4)) return;
            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();
            renderer.setScissorTest(true);
            renderer.setViewport(x, y, w, h);
            renderer.setScissor(x, y, w, h);
            renderer.render(this.scene, this.camera);   // autoClear clears just this region to the background
            renderer.setScissorTest(false);
            renderer.setViewport(0, 0, renderer.getSize(_rsize).width, _rsize.height);
        } catch (err) {
            renderer.setScissorTest(false);
            renderer.setViewport(0, 0, renderer.getSize(_rsize).width, _rsize.height);
            if (!this._warned) { this._warned = true; console.warn('[Minimap] render skipped:', err); }
        }
    }

    dispose() {
        this._boxGeo.dispose(); this._edgeGeo.dispose(); this._coneGeo.dispose();
        this._fills.material.dispose(); this._fills.dispose();
        this._edges.material.dispose();
        this._cone.material.dispose(); this._apex.geometry.dispose(); this._apex.material.dispose();
    }
}

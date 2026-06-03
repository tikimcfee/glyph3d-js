/**
 * MemoryEdges — a primitive, grid-PARENTED edge renderer for the memory viewer.
 *
 * Added as a CHILD of the CodeGrid, with endpoints in grid-LOCAL space, so:
 *   - edges inherit the grid's transform → they follow it when it moves, for free
 *   - no matrixWorld round-trip → removes the transform as a source of offset
 *
 * Each edge = a subtle line shaft (one LineSegments, one draw call) + a smooth
 * cone tip at the target (one InstancedMesh, one draw call). Cones read cleaner
 * than line-V arrowheads and make the pointer direction obvious.
 */

import * as THREE from 'three';
import { RENDER_ORDER } from '../core/renderOrder.js';

const TIP_LEN_RATIO = 0.10;   // cone height = 10% of edge length...
const TIP_MAX = 1.1;          // ...clamped (world units) so long edges don't get huge tips
const TIP_RADIUS_RATIO = 0.34; // cone radius relative to its height ("subtle", not fat)

const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const _m = new THREE.Matrix4();

export class MemoryEdges {
    /**
     * @param {import('../collections/CodeGrid.js').default} grid - parent; edges live in its local frame
     * @param {Object} [opts]
     * @param {number} [opts.max=1024] - max simultaneous edges
     * @param {{r,g,b}} [opts.color] - line + cone color
     */
    constructor(grid, opts = {}) {
        this.grid = grid;
        this._max = opts.max ?? 1024;
        const c = opts.color ?? { r: 0.3, g: 0.85, b: 1.0 };
        const color = new THREE.Color(c.r, c.g, c.b);

        // --- shafts: one LineSegments, 2 verts/edge ---
        this._shaftPos = new Float32Array(this._max * 2 * 3);
        this._shaftGeo = new THREE.BufferGeometry();
        this._shaftBuf = new THREE.BufferAttribute(this._shaftPos, 3);
        this._shaftBuf.setUsage(THREE.DynamicDrawUsage);
        this._shaftGeo.setAttribute('position', this._shaftBuf);
        this._shaftGeo.setDrawRange(0, 0);
        this._shaftMat = new THREE.LineBasicMaterial({
            color, transparent: true, opacity: 0.5, depthTest: true, depthWrite: false,
        });
        this._shaft = new THREE.LineSegments(this._shaftGeo, this._shaftMat);
        this._shaft.frustumCulled = false;
        this._shaft.renderOrder = RENDER_ORDER.CONNECTION;
        grid.add(this._shaft);

        // --- cone tips: one InstancedMesh ---
        // ConeGeometry tip is at +height/2; translate so the TIP sits at the
        // local origin → we place the origin exactly on the target cell.
        const cone = new THREE.ConeGeometry(TIP_RADIUS_RATIO, 1, 16);
        cone.translate(0, -0.5, 0);
        this._coneMat = new THREE.MeshBasicMaterial({
            color, transparent: true, opacity: 0.93, depthTest: true, depthWrite: false,
        });
        this._cones = new THREE.InstancedMesh(cone, this._coneMat, this._max);
        this._cones.frustumCulled = false;
        this._cones.renderOrder = RENDER_ORDER.CONNECTION;
        this._cones.count = 0;
        grid.add(this._cones);
    }

    /**
     * Replace all edges. Coordinates are GRID-LOCAL (e.g. straight from
     * grid._layout.positionAt). Cone tips point along the edge into the target.
     * @param {Array<{from:{x,y,z}, to:{x,y,z}}>} edges
     */
    setEdges(edges) {
        const n = Math.min(edges.length, this._max);
        const a = this._shaftPos;
        let v = 0;
        for (let i = 0; i < n; i++) {
            const { from, to } = edges[i];
            a[v++] = from.x; a[v++] = from.y; a[v++] = from.z;
            a[v++] = to.x;   a[v++] = to.y;   a[v++] = to.z;

            _dir.set(to.x - from.x, to.y - from.y, to.z - from.z);
            const len = _dir.length() || 1;
            _dir.multiplyScalar(1 / len);
            const h = Math.min(len * TIP_LEN_RATIO, TIP_MAX);
            _quat.setFromUnitVectors(_up, _dir);   // cone axis (base→tip) = edge direction
            _pos.set(to.x, to.y, to.z);            // tip lands on the target cell
            _scl.set(h, h, h);
            _m.compose(_pos, _quat, _scl);
            this._cones.setMatrixAt(i, _m);
        }
        this._shaftGeo.setDrawRange(0, n * 2);
        this._shaftBuf.needsUpdate = true;
        this._shaftGeo.computeBoundingSphere();
        this._cones.count = n;
        this._cones.instanceMatrix.needsUpdate = true;
    }

    clear() {
        this._shaftGeo.setDrawRange(0, 0);
        this._cones.count = 0;
    }

    dispose() {
        this.grid.remove(this._shaft);
        this.grid.remove(this._cones);
        this._shaftGeo.dispose();
        this._shaftMat.dispose();
        this._cones.geometry.dispose();
        this._coneMat.dispose();
    }
}

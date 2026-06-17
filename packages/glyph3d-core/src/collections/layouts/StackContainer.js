/**
 * StackContainer + VStack / HStack / ZStack — the declarative 3D layout primitive.
 *
 * A single-axis stack over THREE.Object3D children that carry bounds. Each container
 * is itself an Object3D; `.layout()` measures its children (post-order, via the shared
 * `leafBox`), lays them along ONE main axis with `spacing`, aligns them on the TWO cross
 * axes, and sizes itself — so a StackContainer is a valid child of another StackContainer
 * (or a ContentTree leaf) with zero extra machinery. Compose VStack/HStack/ZStack to get
 * rows, columns, and decks; nest freely.
 *
 *   const sheet = VStack({ spacing: 2, children: [
 *     header,
 *     HStack({ spacing: 1, children: [tag, ZStack({ spacing: 0.4, children: files })] }),
 *   ]});
 *   scene.add(sheet); sheet.layout();
 *
 * CONVENTIONS (match every layouts/ scheme — do not diverge):
 *  - anchor = footprint TOP-CENTER: X centered on origin, Y descends (content hangs −Y),
 *    Z thin on the plane or −Z for a deck.
 *  - placement is AABB-RELATIVE (bias by −box.min / −box.max) so a top-left-anchored
 *    CodeGrid and a center-origin tile both land correctly (the district.js idiom).
 *  - measure reads the orientation-stable LOCAL box (leafBox → layoutBounds()), scaled by
 *    the child's own scale; never the world box, never Box3.setFromObject.
 *  - layout writes ONLY position (+ optional rotation reset). It is NOT a scale writer
 *    (ScaleModel owns scale) and NOT an orientation writer (billboards own rotation).
 *
 * DEFERRED (single-axis primitive only — see the stack-dsl design notes):
 *  - wrapping / grid-flow (a future WrapStack over flowBoxes),
 *  - interactive focus-driven de-occlusion (a state layer on top),
 *  - ZStack picking renderOrder vs the GPU pick channel,
 *  - slot-fit via ScaleModel, and async self-healing (caller re-invokes .layout()).
 */

import * as THREE from 'three';
import { leafBox } from './nodeUtils.js';

// main axis → the two cross axes (in-plane `cross`, out-of-plane `depth`).
const AXES = {
    x: { main: 'x', cross: 'y', depth: 'z' },  // HStack: tiles +X, aligns Y & Z
    y: { main: 'y', cross: 'x', depth: 'z' },  // VStack: tiles −Y, aligns X & Z
    z: { main: 'z', cross: 'x', depth: 'y' },  // ZStack: decks −Z, aligns X & Y
};

// Default cross-align per axis under the top-center convention: Y pins to TOP (1),
// X and Z center (0.5). So an HStack shares a top edge; a VStack centers its column.
const defaultAlign = (axis) => (axis === 'y' ? 1 : 0.5);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** A child's measured box in the PARENT frame: local content box × the child's own scale. */
function measuredBox(child) {
    const b = leafBox(child).clone();
    const s = child.scale;
    b.min.multiply(s);
    b.max.multiply(s);
    return b;
}

/**
 * Coordinate for one CROSS axis given an alignment fraction in [0,1].
 *  - Y (top-anchored): frac 1 = top edge at origin, hanging −Y; frac 0 = bottom.
 *  - X / Z (centered): the child's extent centers within [−extMax/2, +extMax/2] at frac 0.5.
 * Always AABB-relative (−box.min / −box.max) so differing internal anchors line up.
 */
function alignCoord(ax, frac, extMax, b) {
    const childExt = b.max[ax] - b.min[ax];
    const slack = extMax - childExt;
    if (ax === 'y') return -(1 - frac) * slack - b.max.y;   // top = −box.max.y at frac 1
    return -extMax / 2 + frac * slack - b.min[ax];          // centered, leading-biased
}

export default class StackContainer extends THREE.Object3D {
    /**
     * @param {Object} [opts]
     * @param {'x'|'y'|'z'} [opts.axis='y'] main layout axis (use the VStack/HStack/ZStack factories)
     * @param {number} [opts.spacing=0] gap between adjacent children on the main axis
     * @param {number} [opts.align] in-plane cross-axis fraction [0,1] (default per axis)
     * @param {number} [opts.depthAlign] out-of-plane cross-axis fraction [0,1] (default per axis)
     * @param {number} [opts.zStep=0] ZStack-only: extra per-index depth pitch beyond spacing
     * @param {boolean} [opts.reverse=false] fill from the far end — last child takes the first slot
     *   (front of a ZStack deck / bottom of a VStack), so appending puts newest in front
     * @param {boolean} [opts.resetRotation=true] reset each child's rotation to identity on place
     * @param {Object} [opts.animator] optional SpatialAnimator — eases children to targets instead of snapping
     * @param {THREE.Object3D[]} [opts.children] children to add immediately
     */
    constructor(opts = {}) {
        super();
        const axis = opts.axis || 'y';
        if (!AXES[axis]) throw new Error(`StackContainer: bad axis '${axis}'`);
        const A = AXES[axis];
        this.isStackContainer = true;
        this.axis = axis;
        this.spacing = opts.spacing ?? 0;
        this.zStep = opts.zStep ?? 0;
        this.align = clamp01(opts.align ?? defaultAlign(A.cross));
        this.depthAlign = clamp01(opts.depthAlign ?? defaultAlign(A.depth));
        this.resetRotation = opts.resetRotation !== false;
        this.reverse = !!opts.reverse;
        this.animator = opts.animator || null;

        this._box = new THREE.Box3().makeEmpty();
        this.userData.size = { x: 0, y: 0, z: 0 };   // nodeUtils fallback for non-layoutBounds readers

        if (opts.children) for (const c of opts.children) this.add(c);
    }

    /** Local content box (the union of the laid-out children). The measure seam for an outer stack. */
    layoutBounds() { return this._box.clone(); }

    /** World-space AABB — same interface CodeGrid/FrameGrid/TerminalGrid expose. */
    getBounds() {
        this.updateWorldMatrix(true, false);
        return this._box.clone().applyMatrix4(this.matrixWorld);
    }

    /**
     * Measure (post-order) then place (pre-order). Idempotent and change-driven — call it
     * after adding/removing children or when a child's bounds settle (e.g. an async file load
     * the CALLER awaited). Never call per-frame. Returns the container's own footprint.
     * @returns {{x:number, y:number, z:number}}
     */
    layout() {
        const A = AXES[this.axis];
        const kids = this.children.filter((c) => !c.userData?.isMarker);

        // post-order: a nested stack lays itself out first, so leafBox() reads a current box.
        for (const c of kids) if (c.isStackContainer && typeof c.layout === 'function') c.layout();

        if (kids.length === 0) {
            this._box.makeEmpty();
            this.userData.size = { x: 0, y: 0, z: 0 };
            return { x: 0, y: 0, z: 0 };
        }

        const boxes = kids.map(measuredBox);
        const ext = (b, ax) => b.max[ax] - b.min[ax];
        const { main, cross, depth } = A;

        const crossMax = Math.max(...boxes.map((b) => ext(b, cross)));
        const depthMax = Math.max(...boxes.map((b) => ext(b, depth)));
        const pitch = this.spacing + this.zStep;   // ZStack deck pitch

        // sequence order along the main axis (reverse → last child takes the first slot).
        const N = kids.length;
        const seq = this.reverse
            ? Array.from({ length: N }, (_, k) => N - 1 - k)
            : Array.from({ length: N }, (_, k) => k);

        // main-axis cursor start: X rows center on origin; Y columns start at the top (0).
        let cursor = this.axis === 'x'
            ? -(boxes.reduce((s, b) => s + ext(b, main), 0) + this.spacing * (N - 1)) / 2
            : 0;

        const targets = new Array(N);
        for (let k = 0; k < N; k++) {
            const idx = seq[k];
            const b = boxes[idx];
            const p = { x: 0, y: 0, z: 0 };
            if (this.axis === 'x') { p.x = cursor - b.min.x; cursor += ext(b, 'x') + this.spacing; }
            else if (this.axis === 'y') { p.y = cursor - b.max.y; cursor -= ext(b, 'y') + this.spacing; }
            else { p.z = -k * pitch - b.max.z; }   // deck: slot k recedes −Z (k follows the sequence)
            p[cross] = alignCoord(cross, this.align, crossMax, b);
            p[depth] = alignCoord(depth, this.depthAlign, depthMax, b);
            targets[idx] = p;
        }

        // place
        kids.forEach((c, i) => {
            const p = targets[i];
            if (this.resetRotation) c.rotation.set(0, 0, 0);
            if (this.animator) this.animator.animateTo(c, 'position', new THREE.Vector3(p.x, p.y, p.z));
            else c.position.set(p.x, p.y, p.z);
        });

        // footprint = union of child boxes at their TARGET positions (animation-independent).
        this._box.makeEmpty();
        const tmp = new THREE.Box3();
        const v = new THREE.Vector3();
        kids.forEach((c, i) => {
            tmp.copy(boxes[i]).translate(v.set(targets[i].x, targets[i].y, targets[i].z));
            this._box.union(tmp);
        });
        const size = this._box.getSize(new THREE.Vector3());
        this.userData.size = { x: size.x, y: size.y, z: size.z };
        return { x: size.x, y: size.y, z: size.z };
    }
}

export function VStack(opts = {}) { return new StackContainer({ ...opts, axis: 'y' }); }
export function HStack(opts = {}) { return new StackContainer({ ...opts, axis: 'x' }); }
export function ZStack(opts = {}) { return new StackContainer({ ...opts, axis: 'z' }); }

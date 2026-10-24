/**
 * SceneTransforms — the scene's world matrices recomputed where something moved, not across the
 * whole tree every frame.
 *
 * three's `scene.updateMatrixWorld()` composes every node's matrix and multiplies it into its
 * world matrix every frame, moved or not, and the cost is the visit itself: thousands of
 * heap-scattered objects touched per frame for a tree that, at rest, has nothing to recompute.
 * Here a WRITE marks instead:
 *
 *   - position / scale — a tracked node's vectors are TrackedVector3s, whose x, y, z setters mark;
 *     a write of an unchanged value is not a change
 *   - quaternion / rotation — three's own change hooks (the ones that keep the two in sync); a
 *     write that leaves the quaternion as it was is not a change either
 *   - joining a parent
 *
 * A mark flags the node and every ancestor up to the first one already flagged. The walk — this
 * scene's `updateMatrixWorld`, which three's renderer calls once per render — enters only flagged
 * subtrees, recomputes what was marked (and everything under it, as three would), and clears the
 * flags. At rest it visits the root and stops. Every node in the scene is tracked: the scene's
 * tree is instrumented once, and each node instruments what joins it.
 *
 * A node is tracked as it joins the scene: its position and scale vectors are swapped for tracked
 * ones holding the same values. The vectors it had are frozen, so a write through a reference
 * taken before it joined throws instead of moving nothing. (Converting the vectors in place would
 * keep such references live, but drops them — and the nodes — into V8's slow dictionary mode.)
 *
 * Three shapes are handed to three's own `updateMatrixWorld(true)` every walk, as three's walk
 * treated every node: a node whose class overrides it (a camera keeps its inverse there), a node
 * with `matrixAutoUpdate` off (its `.matrix` is written by hand), and a node with a `pivot`. Each
 * is judged as it joins; switching `matrixAutoUpdate` off or setting a pivot on a node already in
 * the scene isn't seen. `verifyTransforms(scene)` recomputes every world matrix from scratch and
 * names the nodes that disagree — a write the walk never saw (`scene.transforms`).
 *
 * Pick passes and anything else that turns `scene.matrixWorldAutoUpdate` off skip the walk, as
 * they skip three's.
 */

import * as THREE from 'three';

const DIRTY = Symbol('transformDirty');     // this node's pose changed: recompose, rebuild its subtree's world
const SUB = Symbol('transformSub');         // something below changed: the walk enters
const TRACKED = Symbol('transformTracked');
const ALWAYS = Symbol('transformAlways');   // the walk hands this node to three every time
const OWNER = Symbol('transformOwner');     // on a tracked vector / quaternion / euler: its node
const PREV = Symbol('transformPrev');       // on a tracked quaternion / euler: three's sync hook
const X = Symbol('x'), Y = Symbol('y'), Z = Symbol('z');
const QX = Symbol('qx'), QY = Symbol('qy'), QZ = Symbol('qz'), QW = Symbol('qw');   // on a node: the quaternion it last reported

const BASE_UPDATE_MATRIX_WORLD = THREE.Object3D.prototype.updateMatrixWorld;

function mark(o) {
    if (o[DIRTY]) return;            // its ancestors are flagged already
    o[DIRTY] = true;
    flagUp(o.parent);
}

function flagUp(p) {
    for (; p !== null && !p[SUB]; p = p.parent) p[SUB] = true;
}

/** A node's position or scale: a Vector3 whose component writes mark the node (its OWNER,
 *  set once it's swapped in). */
export class TrackedVector3 extends THREE.Vector3 {
    /** Vector3's own signature (three makes vectors as `new v.constructor(x, y, z)`). */
    constructor(x = 0, y = 0, z = 0) {
        super(x, y, z);              // through the setters, before there's an owner to mark
        this[OWNER] = undefined;
    }

    /** A copy is a plain vector: it belongs to no node. */
    clone() { return new THREE.Vector3(this[X], this[Y], this[Z]); }

    get x() { return this[X]; }
    set x(v) { if (this[X] !== v) { this[X] = v; if (this[OWNER] !== undefined) mark(this[OWNER]); } }
    get y() { return this[Y]; }
    set y(v) { if (this[Y] !== v) { this[Y] = v; if (this[OWNER] !== undefined) mark(this[OWNER]); } }
    get z() { return this[Z]; }
    set z(v) { if (this[Z] !== v) { this[Z] = v; if (this[OWNER] !== undefined) mark(this[OWNER]); } }

    /** The components live under symbols; serialize as a plain vector does. */
    toJSON() { return { x: this[X], y: this[Y], z: this[Z] }; }
}

// three calls a quaternion's / euler's change hook as a method, on every write. Its own sync
// runs first, so either way the quaternion — what the matrix composes — holds the result.
function onRotate() {
    this[PREV]();
    const o = this[OWNER], q = o.quaternion;
    if (q._x !== o[QX] || q._y !== o[QY] || q._z !== o[QZ] || q._w !== o[QW]) {
        o[QX] = q._x; o[QY] = q._y; o[QZ] = q._z; o[QW] = q._w;
        mark(o);
    }
}

function trackRotation(r, o) {
    r[OWNER] = o;
    r[PREV] = r._onChangeCallback;
    r._onChange(onRotate);
}

function swapVector(o, key) {
    const old = o[key], v = new TrackedVector3(old.x, old.y, old.z);
    v[OWNER] = o;
    Object.defineProperty(o, key, { value: v, enumerable: true, configurable: true });
    Object.freeze(old);
}

function onChildAdded(e) {
    const child = e.child;
    track(child);
    child[DIRTY] = true;             // a new parent: its world, and its subtree's, are new
    flagUp(child.parent);
}

/** Instrument a node and its subtree (once per node). */
function track(o) {
    if (!o[TRACKED]) {
        o[TRACKED] = true;
        o[DIRTY] = true;
        o[SUB] = true;
        o[ALWAYS] = !o.matrixAutoUpdate || o.pivot !== null || o.updateMatrixWorld !== BASE_UPDATE_MATRIX_WORLD;
        const q = o.quaternion;
        o[QX] = q._x; o[QY] = q._y; o[QZ] = q._z; o[QW] = q._w;
        swapVector(o, 'position');
        swapVector(o, 'scale');
        trackRotation(q, o);
        trackRotation(o.rotation, o);
        o.addEventListener('childadded', onChildAdded);
    }
    const ch = o.children;
    for (let i = 0; i < ch.length; i++) track(ch[i]);
}

export default class SceneTransforms {
    /**
     * @param {THREE.Scene} scene - the scene whose world matrices this keeps; it takes over the
     *   scene's `updateMatrixWorld`
     */
    constructor(scene) {
        if (!scene?.isScene) throw new Error('SceneTransforms: needs a THREE.Scene (it takes over scene.updateMatrixWorld)');
        if (Object.prototype.hasOwnProperty.call(scene, 'updateMatrixWorld')) {
            throw new Error('SceneTransforms: this scene\'s updateMatrixWorld is already taken over — dispose the other one first');
        }
        this.scene = scene;
        /** Last walk: nodes visited, nodes whose world matrix it recomputed, nodes handed to three. */
        this.stats = { visited: 0, recomputed: 0, three: 0 };
        track(scene);
        scene[ALWAYS] = false;       // the root is the walk's own
        scene.updateMatrixWorld = (force) => this.update(force);
    }

    /**
     * Recompute the world matrices that changed since the last walk.
     * @param {boolean} [force] - recompute every node, as three's walk does
     */
    update(force = false) {
        const s = { visited: 0, recomputed: 0, three: 0 };
        walk(this.scene, force, s);
        this.stats = s;
        return s;
    }

    /** Hand the scene's matrix update back to three. Tracked nodes stay tracked (a mark is harmless). */
    dispose() {
        delete this.scene.updateMatrixWorld;
    }
}

/** three's updateMatrixWorld, entering only flagged subtrees. */
function walk(o, force, s) {
    s.visited++;
    if (o[ALWAYS]) {
        s.three++;
        o.updateMatrixWorld(true);   // as three's walk always reached it: forced from above
        o[DIRTY] = false;
        o[SUB] = false;
        flagUp(o.parent);            // and again next walk
        return;
    }
    if (force || o[DIRTY]) {
        if (o.matrixAutoUpdate) o.updateMatrix();
        if (o.matrixWorldAutoUpdate === true) {
            if (o.parent === null) o.matrixWorld.copy(o.matrix);
            else o.matrixWorld.multiplyMatrices(o.parent.matrixWorld, o.matrix);
        }
        o.matrixWorldNeedsUpdate = false;
        o[DIRTY] = false;
        force = true;
        s.recomputed++;
    }
    if (force || o[SUB]) {
        o[SUB] = false;
        const ch = o.children;
        for (let i = 0; i < ch.length; i++) walk(ch[i], force, s);
    }
}

const _local = new THREE.Matrix4();

/**
 * Recompute every world matrix under `root` from its local pose, without writing any, and name
 * the nodes whose matrixWorld disagrees. Run it after a walk: a mismatch is a write the walk
 * never saw. Nodes that keep their own world matrix (`matrixWorldAutoUpdate = false`) are taken
 * as they are.
 * @param {THREE.Object3D} root
 * @returns {{ checked: number, stale: { name: string, type: string, path: string, maxErr: number }[] }}
 */
export function verifyTransforms(root) {
    const stale = [];
    let checked = 0;
    const visit = (o, parentWorld) => {
        let world;
        if (o.matrixWorldAutoUpdate !== true) {
            world = o.matrixWorld;
        } else {
            if (o.matrixAutoUpdate) {
                _local.compose(o.position, o.quaternion, o.scale);
                const pivot = o.pivot, te = _local.elements;
                if (pivot) {
                    const px = pivot.x, py = pivot.y, pz = pivot.z;
                    te[12] += px - te[0] * px - te[4] * py - te[8] * pz;
                    te[13] += py - te[1] * px - te[5] * py - te[9] * pz;
                    te[14] += pz - te[2] * px - te[6] * py - te[10] * pz;
                }
            } else {
                _local.copy(o.matrix);
            }
            world = parentWorld ? new THREE.Matrix4().multiplyMatrices(parentWorld, _local) : _local.clone();
            checked++;
            let maxErr = 0;
            const a = world.elements, b = o.matrixWorld.elements;
            for (let i = 0; i < 16; i++) maxErr = Math.max(maxErr, Math.abs(a[i] - b[i]));
            if (maxErr > 0) {
                const path = [];
                for (let p = o; p; p = p.parent) path.push(p.name || p.type);
                stale.push({ name: o.name, type: o.type, path: path.reverse().join(' > '), maxErr });
            }
        }
        for (const c of o.children) visit(c, world);
    };
    visit(root, root.parent ? root.parent.matrixWorld : null);
    return { checked, stale };
}

/**
 * ContentTreeArrows — ordered arrows threading the child directories of each dir.
 *
 * Where ContentTreeMarkers gives a directory PRESENCE (a translucent volume) and the
 * scheme gives files their LOCALITY (siblings packed together), this layer gives the
 * directories themselves an ORDER. Within every parent, its child dirs are placed in
 * one canonical sequence (dirs-first, then case-insensitive name — partitionChildren);
 * this layer draws an arrow from each child dir to the next, so that implicit reading
 * order becomes a visible thread through space: childA ──▶ childB ──▶ childC.
 *
 * Both endpoints of every segment are child dirs of the SAME parent, so the whole arrow
 * chain lives in that parent's local frame — we parent one LineSegments per parent INTO
 * the parent node, exactly like ContentTreeMarkers parents its prism. It then rides every
 * transform for free: relayouts, scheme switches, restAbove, and live drags (which fire
 * no relayout — the parented geometry simply moves with the node). The arrowhead vertex
 * math mirrors ConnectionRenderer; the difference is locality — these stay in-frame rather
 * than spanning world space, so there's no per-frame world-position recompute.
 *
 * Direction reads two ways at once: an arrowhead at each segment's end, and a color
 * gradient along the chain (colorA at the first sibling, colorB at the last) so the
 * sequence is legible even edge-on. Meshes carry userData.isMarker — schemes ignore them
 * (partitionChildren) and the GPU picking pass (opt-in layers) never sees them. Rebuilds
 * are driven by ContentTree.onRelayout, so the arrows can never observe a stale layout.
 */

import * as THREE from 'three';
import { RENDER_ORDER } from '../core/renderOrder.js';
import { partitionChildren } from './layouts/nodeUtils.js';

export const ARROW_DEFAULTS = {
    zLift: 24,                  // +z float above the dir's content plane so the thread isn't buried
    opacity: 0.6,
    arrowRatio: 0.14,           // arrowhead length as a fraction of the segment length
    arrowAngle: Math.PI / 7,    // arrowhead half-angle (~25°), matches ConnectionRenderer
    colorA: 0x4a8acc,           // sequence start — the FIRST child dir
    colorB: 0xcc7a4a,           // sequence end — the LAST child dir
    minSiblings: 2,             // a chain needs at least two child dirs
};

const VERTS_PER_SEGMENT = 6;    // shaft(2) + arrowL(2) + arrowR(2)

export default class ContentTreeArrows {
    /**
     * @param {import('./ContentTree.js').default} tree
     * @param {object} [opts] overrides for ARROW_DEFAULTS
     */
    constructor(tree, opts = {}) {
        this.tree = tree;
        this.opts = { ...ARROW_DEFAULTS, ...opts };
        this.enabled = true;
        this._chains = new Map();   // parent dir path → { mesh, geo }
        // Color is per-vertex (the order gradient), so one material serves every chain —
        // a per-parent material would push hundreds of needless materials through the build.
        this._mat = new THREE.LineBasicMaterial({
            vertexColors: true,
            transparent: true,
            opacity: this.opts.opacity,
            depthWrite: false,
        });
        this._offRelayout = tree.onRelayout(() => this.update());
        this.update();
    }

    /** Patch options and rebuild. */
    configure(patch = {}) {
        Object.assign(this.opts, patch);
        this._mat.opacity = this.opts.opacity;
        this.update();
        return this;
    }

    setEnabled(on) {
        this.enabled = !!on;
        if (this.enabled) this.update();
        else for (const c of this._chains.values()) c.mesh.visible = false;
        return this;
    }

    /** Rebuild every chain from the tree's current layout. */
    update() {
        if (!this.enabled) return;
        const o = this.opts;
        // Every dir is a potential parent of a sibling sequence — _dirs includes the
        // root ('' key), whose child dirs are the project's top-level directories.
        const parents = [...this.tree._dirs.entries()];

        const seen = new Set();
        const colA = new THREE.Color(o.colorA);
        const colB = new THREE.Color(o.colorB);
        const tmp = new THREE.Color();

        for (const [path, node] of parents) {
            const { dirs } = partitionChildren(node);   // canonical child-dir order, markers excluded
            const segCount = dirs.length - 1;
            if (segCount < o.minSiblings - 1) {          // fewer than minSiblings child dirs → no thread
                this._dropChain(path);
                continue;
            }
            seen.add(path);

            const verts = segCount * VERTS_PER_SEGMENT;
            let chain = this._chains.get(path);
            if (!chain || chain.geo.getAttribute('position').count !== verts) {
                this._dropChain(path);
                const geo = new THREE.BufferGeometry();
                geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
                geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
                const mesh = new THREE.LineSegments(geo, this._mat);
                mesh.name = `arrows:${path}`;
                mesh.userData = { isMarker: true, path };
                chain = { mesh, geo };
                this._chains.set(path, chain);
            }
            if (chain.mesh.parent !== node) node.add(chain.mesh);

            const pos = chain.geo.getAttribute('position');
            const col = chain.geo.getAttribute('color');
            for (let i = 0; i < segCount; i++) {
                const from = this._anchor(dirs[i]);
                const to = this._anchor(dirs[i + 1]);
                // Gradient by the segment's start position along the chain.
                const t = segCount > 1 ? i / (segCount - 1) : 0;
                tmp.copy(colA).lerp(colB, t);
                this._writeSegment(pos.array, col.array, i * VERTS_PER_SEGMENT * 3, from, to, tmp);
            }
            pos.needsUpdate = true;
            col.needsUpdate = true;
            chain.geo.computeBoundingSphere();
            chain.mesh.visible = true;
            chain.mesh.renderOrder = RENDER_ORDER.CONNECTION;
        }

        for (const path of [...this._chains.keys()]) {
            if (!seen.has(path)) this._dropChain(path);
        }
    }

    /** A child dir's footprint center in its PARENT's local frame, lifted in +z. The
     *  scheme places a node at its footprint top-center (y ∈ [-h, 0]), so the visual
     *  center sits half the footprint height below the placed origin. */
    _anchor(node) {
        const h = node.userData?.size?.y || 0;
        return { x: node.position.x, y: node.position.y - h / 2, z: node.position.z + this.opts.zLift };
    }

    /** Write one segment's shaft + arrowhead vertices into the position/color arrays.
     *  Arrowhead geometry mirrors ConnectionRenderer._writeSlot. @private */
    _writeSegment(p, c, base, from, to, color) {
        const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-6) { p.fill(0, base, base + VERTS_PER_SEGMENT * 3); return; }

        // Shaft: from → to
        p[base] = from.x; p[base + 1] = from.y; p[base + 2] = from.z;
        p[base + 3] = to.x; p[base + 4] = to.y; p[base + 5] = to.z;

        const arrowLen = len * this.opts.arrowRatio;
        const ux = dx / len, uy = dy / len, uz = dz / len;
        // A perpendicular vector — pick the axis least aligned with the shaft.
        let px, py, pz;
        if (Math.abs(ux) < 0.9) { px = 0; py = -uz; pz = uy; }
        else { px = uy; py = -ux; pz = 0; }
        const plen = Math.sqrt(px * px + py * py + pz * pz) || 1;
        px /= plen; py /= plen; pz /= plen;

        const sinA = Math.sin(this.opts.arrowAngle);
        const cosA = Math.cos(this.opts.arrowAngle);

        const al = base + 6;
        p[al] = to.x; p[al + 1] = to.y; p[al + 2] = to.z;
        p[al + 3] = to.x + arrowLen * (-ux * cosA + px * sinA);
        p[al + 4] = to.y + arrowLen * (-uy * cosA + py * sinA);
        p[al + 5] = to.z + arrowLen * (-uz * cosA + pz * sinA);

        const ar = base + 12;
        p[ar] = to.x; p[ar + 1] = to.y; p[ar + 2] = to.z;
        p[ar + 3] = to.x + arrowLen * (-ux * cosA - px * sinA);
        p[ar + 4] = to.y + arrowLen * (-uy * cosA - py * sinA);
        p[ar + 5] = to.z + arrowLen * (-uz * cosA - pz * sinA);

        for (let v = 0; v < VERTS_PER_SEGMENT; v++) {
            c[base + v * 3] = color.r;
            c[base + v * 3 + 1] = color.g;
            c[base + v * 3 + 2] = color.b;
        }
    }

    /** @private — remove a chain's mesh + free its geometry. */
    _dropChain(path) {
        const chain = this._chains.get(path);
        if (!chain) return;
        chain.mesh.parent?.remove(chain.mesh);
        chain.geo.dispose();
        this._chains.delete(path);
    }

    dispose() {
        this._offRelayout?.();
        for (const path of [...this._chains.keys()]) this._dropChain(path);
        this._mat.dispose();
    }
}

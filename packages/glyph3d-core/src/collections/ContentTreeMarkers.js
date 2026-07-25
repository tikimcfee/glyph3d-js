/**
 * ContentTreeMarkers — bounding prisms for the directory tree.
 *
 * Every directory gets a translucent colored box (a prism) parented INTO its dir node,
 * sized to enclose the node's whole subtree — files on the dir's own plane AND the
 * child-dir blocks receding in z. Because the prism is a child of the node it marks,
 * it rides every transform for free: relayouts, scheme switches, restAbove, drags.
 * Nested prisms overlap in screen space, so their opacities interweave — depth of
 * nesting reads as density of tint, and parenting is visible without a single label.
 *
 * Color is a GRADIENT over normalized depth, not a per-level palette: the tree's
 * deepest directory maps to colorB, the shallowest to colorA, however deep the tree
 * goes — a 200-level chain of one-file dirs sweeps the same configurable ramp as a
 * 3-level repo. Everything (gradient endpoints, opacity + per-level decay, padding,
 * edges) is an option, dialable live via layout.markers.
 *
 * Rebuilds are driven by ContentTree.onRelayout, so markers can never observe a stale
 * layout. Prism meshes carry userData.isMarker — layout schemes ignore them
 * (partitionChildren) and tree pruning treats them as not-content. They live on the
 * default render layer only, so the GPU picking pass (which renders opt-in layers)
 * never sees them.
 */

import * as THREE from 'three';
import { RENDER_ORDER } from '../core/renderOrder.js';
import { subtreeContentBounds } from './layouts/nodeUtils.js';

export const MARKER_DEFAULTS = {
    pad: 10,            // XY inflation beyond the subtree's content bounds
    zPad: 12,           // Z inflation (in front of the front plane, behind the deepest)
    minThickness: 28,   // a flat dir (no child dirs) still gets a readable slab
    opacity: 0.07,      // per-prism face opacity — interweaving does the depth-shading
    opacityDecay: 1.0,  // multiplier per depth level (1 = constant; <1 fades deep dirs)
    minOpacity: 0.02,
    edgeOpacity: 0.16,  // 0 = no edge lines
    colorA: 0x2e5f8a,   // gradient start — the shallowest directories
    colorB: 0x7a3a8a,   // gradient end — the DEEPEST directory in the current tree
};

export default class ContentTreeMarkers {
    /**
     * @param {import('./ContentTree.js').default} tree
     * @param {object} [opts] overrides for MARKER_DEFAULTS
     */
    constructor(tree, opts = {}) {
        this.tree = tree;
        this.opts = { ...MARKER_DEFAULTS, ...opts };
        this.enabled = true;
        this._prisms = new Map();                       // dir path → { mesh, edges }
        this._unitBox = new THREE.BoxGeometry(1, 1, 1); // shared; meshes scale it
        this._unitEdges = new THREE.EdgesGeometry(this._unitBox);
        // Color/opacity are pure functions of DEPTH (+ opts), so every prism at one
        // depth shares one material pair — a per-prism material would put hundreds
        // of needless materials through the renderer's per-material build.
        this._materialsByDepth = new Map();             // depth → { fill, edge }
        this._materialsMaxDepth = 0;
        this._offRelayout = tree.onRelayout(() => this.update());
        this.update();
    }

    /** Patch options and rebuild (materials re-derive from the new opts). */
    configure(patch = {}) {
        Object.assign(this.opts, patch);
        this._invalidateMaterials();
        this.update();
        return this;
    }

    /** @private — drop the depth-keyed materials (opts or tree depth changed). */
    _invalidateMaterials() {
        for (const m of this._materialsByDepth.values()) { m.fill.dispose(); m.edge.dispose(); }
        this._materialsByDepth.clear();
    }

    /** @private — the shared material pair for a depth under the current gradient. */
    _materialsFor(depth, maxDepth) {
        let m = this._materialsByDepth.get(depth);
        if (m) return m;
        const o = this.opts;
        const t = maxDepth > 1 ? (depth - 1) / (maxDepth - 1) : 0;
        const color = new THREE.Color().lerpColors(new THREE.Color(o.colorA), new THREE.Color(o.colorB), t);
        const opacity = Math.max(o.opacity * Math.pow(o.opacityDecay, depth - 1), o.minOpacity);
        m = {
            fill: new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }),
            edge: new THREE.LineBasicMaterial({ color, transparent: true, opacity: o.edgeOpacity, depthWrite: false }),
        };
        this._materialsByDepth.set(depth, m);
        return m;
    }

    setEnabled(on) {
        this.enabled = !!on;
        if (this.enabled) this.update();
        else for (const p of this._prisms.values()) p.mesh.visible = false;
        return this;
    }

    /** Rebuild every prism from the tree's current layout. */
    update() {
        if (!this.enabled) return;
        const o = this.opts;
        // Pass-through chain dirs (layout compression, see nodeUtils.collapseChain)
        // are skipped: their prism would box the exact content their tail already
        // boxes, stacking N identical prisms over one directory.
        const dirs = [...this.tree._dirs.entries()]
            .filter(([path, node]) => path !== '' && !node.userData?.isPassThrough);
        // Segment count, not split length — canonical-absolute keys carry a leading
        // slash whose empty first split segment is not a depth level.
        const depthOf = (p) => p.split('/').filter(Boolean).length;
        const maxDepth = dirs.reduce((m, [path]) => Math.max(m, depthOf(path)), 1);
        // A new max depth re-spreads the gradient → re-derive the depth materials.
        if (maxDepth !== this._materialsMaxDepth) {
            this._invalidateMaterials();
            this._materialsMaxDepth = maxDepth;
        }

        const seen = new Set();
        for (const [path, node] of dirs) {
            // Box includes the dir's own origin → every directory (container or empty stub)
            // gets a bounded box reaching its front plane, so it has spatial presence.
            const bounds = subtreeContentBounds(node);
            seen.add(path);

            const depth = depthOf(path);
            const mats = this._materialsFor(depth, maxDepth);

            let prism = this._prisms.get(path);
            if (!prism) {
                const mesh = new THREE.Mesh(this._unitBox, mats.fill);
                mesh.name = `prism:${path}`;
                mesh.userData = { isMarker: true, path };
                const edges = new THREE.LineSegments(this._unitEdges, mats.edge);
                edges.userData = { isMarker: true };
                mesh.add(edges);                        // edges inherit the mesh's transform
                prism = { mesh, edges };
                this._prisms.set(path, prism);
            }
            if (prism.mesh.parent !== node) node.add(prism.mesh);

            const size = new THREE.Vector3(), center = new THREE.Vector3();
            bounds.getSize(size); bounds.getCenter(center);
            prism.mesh.position.copy(center);
            prism.mesh.scale.set(
                size.x + 2 * o.pad,
                size.y + 2 * o.pad,
                Math.max(size.z + 2 * o.zPad, o.minThickness),
            );
            prism.mesh.visible = true;
            prism.mesh.material = mats.fill;
            prism.mesh.renderOrder = RENDER_ORDER.BACKDROP_BASE + depth;
            prism.edges.visible = o.edgeOpacity > 0;
            prism.edges.material = mats.edge;
            prism.edges.renderOrder = RENDER_ORDER.BACKDROP_BASE + depth;
        }

        // Drop prisms whose dirs left the tree (or emptied out). Materials are
        // depth-shared — they live in _materialsByDepth, not on the prism.
        for (const [path, prism] of this._prisms) {
            if (seen.has(path)) continue;
            prism.mesh.parent?.remove(prism.mesh);
            this._prisms.delete(path);
        }
    }

    dispose() {
        this._offRelayout?.();
        for (const [, prism] of this._prisms) {
            prism.mesh.parent?.remove(prism.mesh);
        }
        this._prisms.clear();
        this._invalidateMaterials();
        this._unitBox.dispose();
        this._unitEdges.dispose();
    }
}

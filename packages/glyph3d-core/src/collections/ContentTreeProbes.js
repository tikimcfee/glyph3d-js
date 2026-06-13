/**
 * ContentTreeProbes — a DIAGNOSTIC overlay that makes a directory's coordinate landmarks
 * visible. Per dir node it drops two dots, parented into the node so they ride every
 * transform like the markers and arrows do:
 *
 *   • origin dot  — at the node's local (0,0,0): the footprint ORIGIN (top-center, z=0).
 *                   This is where the older arrow code mistakenly anchored.
 *   • content dot — at the node's actual content-bounds TOP-FRONT edge (the same point
 *                   ContentTreeArrows now anchors to). For a container dir with no files
 *                   of its own, this sits a full depthZ BEHIND the origin.
 *
 * A thin link connects the two, so the gap between origin and content reads directly: a
 * long link means the origin is a bad landmark for that dir (which is exactly why arrows
 * used to float). Same `anchor`/`zLift` as ContentTreeArrows, so the content dot lands
 * precisely where the parent's arrowhead points. Meshes carry userData.isMarker (schemes
 * + picking ignore them). Rebuilt on ContentTree.onRelayout. Toggle with layout.probes.
 */

import * as THREE from 'three';
import { RENDER_ORDER } from '../core/renderOrder.js';
import { subtreeContentBounds } from './layouts/nodeUtils.js';

export const PROBE_DEFAULTS = {
    size: 12,                  // dot radius in world units
    zLift: 24,                 // matches ContentTreeArrows — content dot floats this far in front
    anchor: 'top',             // matches ContentTreeArrows — top | top-left | top-right
    originColor: 0xff3b6b,     // footprint origin (the old, wrong landmark)
    contentColor: 0x3bd1ff,    // content anchor (where arrows point now)
    linkColor: 0x8893a5,
};

export default class ContentTreeProbes {
    /**
     * @param {import('./ContentTree.js').default} tree
     * @param {object} [opts] overrides for PROBE_DEFAULTS
     */
    constructor(tree, opts = {}) {
        this.tree = tree;
        this.opts = { ...PROBE_DEFAULTS, ...opts };
        this.enabled = false;   // diagnostic overlay — off by default, on via layout.probes
        this._probes = new Map();   // dir path → { origin, content, link }
        this._dot = new THREE.SphereGeometry(1, 12, 8);   // shared; meshes scale it
        this._matOrigin = new THREE.MeshBasicMaterial({ color: this.opts.originColor, depthTest: false });
        this._matContent = new THREE.MeshBasicMaterial({ color: this.opts.contentColor, depthTest: false });
        this._matLink = new THREE.LineBasicMaterial({ color: this.opts.linkColor, transparent: true, opacity: 0.6, depthTest: false });
        this._offRelayout = tree.onRelayout(() => this.update());
        this.update();
    }

    configure(patch = {}) {
        Object.assign(this.opts, patch);
        this._matOrigin.color.set(this.opts.originColor);
        this._matContent.color.set(this.opts.contentColor);
        this._matLink.color.set(this.opts.linkColor);
        this.update();
        return this;
    }

    setEnabled(on) {
        this.enabled = !!on;
        if (this.enabled) this.update();
        else for (const p of this._probes.values()) { p.origin.visible = p.content.visible = p.link.visible = false; }
        return this;
    }

    update() {
        if (!this.enabled) return;
        const s = this.opts.size;
        const seen = new Set();

        for (const [path, node] of this.tree._dirs.entries()) {
            if (path === '') continue;                  // root has no own block to probe
            const b = subtreeContentBounds(node);
            if (b.isEmpty()) { this._drop(path); continue; }
            seen.add(path);

            const ax = this.opts.anchor === 'top-left' ? b.min.x
                : this.opts.anchor === 'top-right' ? b.max.x
                    : (b.min.x + b.max.x) / 2;
            const cx = ax, cy = b.max.y, cz = b.max.z + this.opts.zLift;   // content anchor (node-local)

            let probe = this._probes.get(path);
            if (!probe) {
                const origin = new THREE.Mesh(this._dot, this._matOrigin);
                const content = new THREE.Mesh(this._dot, this._matContent);
                const linkGeo = new THREE.BufferGeometry();
                linkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
                const link = new THREE.LineSegments(linkGeo, this._matLink);
                for (const m of [origin, content, link]) { m.userData = { isMarker: true, path }; m.renderOrder = RENDER_ORDER.CONNECTION; }
                node.add(origin, content, link);
                probe = { origin, content, link };
                this._probes.set(path, probe);
            }

            probe.origin.position.set(0, 0, 0);
            probe.origin.scale.setScalar(s);
            probe.content.position.set(cx, cy, cz);
            probe.content.scale.setScalar(s);
            const lp = probe.link.geometry.getAttribute('position');
            lp.array.set([0, 0, 0, cx, cy, cz]);
            lp.needsUpdate = true;
            probe.link.geometry.computeBoundingSphere();
            probe.origin.visible = probe.content.visible = probe.link.visible = true;
        }

        for (const path of [...this._probes.keys()]) if (!seen.has(path)) this._drop(path);
    }

    _drop(path) {
        const p = this._probes.get(path);
        if (!p) return;
        for (const m of [p.origin, p.content, p.link]) m.parent?.remove(m);
        p.link.geometry.dispose();
        this._probes.delete(path);
    }

    dispose() {
        this._offRelayout?.();
        for (const path of [...this._probes.keys()]) this._drop(path);
        this._dot.dispose();
        this._matOrigin.dispose();
        this._matContent.dispose();
        this._matLink.dispose();
    }
}

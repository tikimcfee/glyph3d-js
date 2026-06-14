/**
 * ContentTreeArrows — OWNERSHIP lines: each directory's hub wired to everything it owns.
 *
 * Where ContentTreeMarkers gives a directory PRESENCE (a translucent volume) and the
 * scheme gives content its PLACE, this layer makes CONTAINMENT visible: from each
 * directory's hub (its origin) a simple straight line runs to every file it holds and to
 * every child directory's hub. Parent ──── file, parent ──── childDir. No sibling order,
 * no arrowheads, no gradient — just the wires that show what belongs to what, which is the
 * one relationship a code tree must read. (It replaced an earlier sibling-order arrow
 * chain; ownership is the relationship that actually means something.)
 *
 * Every line of a given parent lives in that parent's LOCAL frame (the hub at the origin,
 * each endpoint a child's local position), so we parent one LineSegments per directory INTO
 * the directory node, exactly like ContentTreeMarkers parents its prism. It rides every
 * transform for free: relayouts, scheme switches, restAbove, and live drags. File lines and
 * directory lines get distinct colors (colorA / colorB) so the two kinds of ownership read
 * apart. Meshes carry userData.isMarker — schemes ignore them (partitionChildren) and GPU
 * picking never sees them. Rebuilds are driven by ContentTree.onRelayout, so the lines can
 * never observe a stale layout.
 */

import * as THREE from 'three';
import { RENDER_ORDER } from '../core/renderOrder.js';
import { partitionChildren, leafBox } from './layouts/nodeUtils.js';

export const ARROW_DEFAULTS = {
    zLift: 0,                   // +z float for flat schemes; 0 for the volumetric jellyfish
    opacity: 0.5,
    colorA: 0x4a8acc,           // FILE ownership lines (hub → file)
    colorB: 0xcc7a4a,           // DIRECTORY ownership lines (hub → child dir hub)
};

const _v = new THREE.Vector3();

export default class ContentTreeArrows {
    /**
     * @param {import('./ContentTree.js').default} tree
     * @param {object} [opts] overrides for ARROW_DEFAULTS
     */
    constructor(tree, opts = {}) {
        this.tree = tree;
        this.opts = { ...ARROW_DEFAULTS, ...opts };
        this.showFiles = true;      // hub → file lines (settings: tree.fileLines)
        this.showDirs = true;       // hub → child-dir lines (settings: tree.dirLines)
        this._links = new Map();    // dir path → { mesh, geo }
        // Per-vertex color (file vs dir), so one material serves every directory's lines.
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

    /** Whether any ownership lines show (either kind). */
    get enabled() { return this.showFiles || this.showDirs; }

    /** Master toggle — both line kinds at once (layout.arrows on|off). */
    setEnabled(on) { this.showFiles = this.showDirs = !!on; this.update(); return this; }

    /** Toggle hub→file lines independently (settings: tree.fileLines). */
    setShowFiles(on) { this.showFiles = !!on; this.update(); return this; }

    /** Toggle hub→child-dir lines independently (settings: tree.dirLines). */
    setShowDirs(on) { this.showDirs = !!on; this.update(); return this; }

    /** Rebuild every directory's ownership lines from the tree's current layout. */
    update() {
        const o = this.opts;
        const colFile = new THREE.Color(o.colorA);
        const colDir = new THREE.Color(o.colorB);
        const seen = new Set();
        const showF = this.showFiles, showD = this.showDirs;

        for (const [path, node] of this.tree._dirs.entries()) {
            const { files, dirs } = partitionChildren(node);   // markers excluded
            const nF = showF ? files.length : 0, nD = showD ? dirs.length : 0;
            const count = nF + nD;                             // one line per shown child
            if (count === 0) { this._dropLinks(path); continue; }
            seen.add(path);

            const verts = count * 2;                           // hub → child, two ends
            let link = this._links.get(path);
            if (!link || link.geo.getAttribute('position').count !== verts) {
                this._dropLinks(path);
                const geo = new THREE.BufferGeometry();
                geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
                geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
                const mesh = new THREE.LineSegments(geo, this._mat);
                mesh.name = `owns:${path}`;
                mesh.userData = { isMarker: true, path };
                link = { mesh, geo };
                this._links.set(path, link);
            }
            if (link.mesh.parent !== node) node.add(link.mesh);

            const pos = link.geo.getAttribute('position').array;
            const col = link.geo.getAttribute('color').array;
            let k = 0;
            // hub = the directory's own origin (top-center); wires to each shown child.
            if (showF) for (const leaf of files) k = this._writeLine(pos, col, k, this._fileAnchor(leaf), colFile);
            if (showD) for (const dir of dirs) k = this._writeLine(pos, col, k, dir.position, colDir);

            link.geo.getAttribute('position').needsUpdate = true;
            link.geo.getAttribute('color').needsUpdate = true;
            link.geo.computeBoundingSphere();
            link.mesh.visible = true;
            link.mesh.renderOrder = RENDER_ORDER.CONNECTION;
        }

        for (const path of [...this._links.keys()]) if (!seen.has(path)) this._dropLinks(path);
    }

    /** A file's content-box center in its PARENT's local frame — where its ownership line lands. */
    _fileAnchor(leaf) {
        const b = leafBox(leaf);
        leaf.updateMatrix();
        return _v.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2)
            .applyMatrix4(leaf.matrix);
    }

    /** Write one hub→endpoint line (2 verts) at vertex index k; returns the next index. @private */
    _writeLine(pos, col, k, end, color) {
        const a = k * 3;
        pos[a] = 0; pos[a + 1] = 0; pos[a + 2] = this.opts.zLift;       // hub at the dir origin
        pos[a + 3] = end.x; pos[a + 4] = end.y; pos[a + 5] = end.z + this.opts.zLift;
        for (let v = 0; v < 2; v++) { col[a + v * 3] = color.r; col[a + v * 3 + 1] = color.g; col[a + v * 3 + 2] = color.b; }
        return k + 2;
    }

    /** @private — remove a directory's lines + free its geometry. */
    _dropLinks(path) {
        const link = this._links.get(path);
        if (!link) return;
        link.mesh.parent?.remove(link.mesh);
        link.geo.dispose();
        this._links.delete(path);
    }

    dispose() {
        this._offRelayout?.();
        for (const path of [...this._links.keys()]) this._dropLinks(path);
        this._mat.dispose();
    }
}

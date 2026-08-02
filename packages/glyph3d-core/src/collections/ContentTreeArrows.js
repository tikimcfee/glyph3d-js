/**
 * ContentTreeArrows — OWNERSHIP lines: each directory's hub wired to everything it owns.
 *
 * Where ContentTreeMarkers gives a directory PRESENCE (a translucent volume) and the
 * scheme gives content its PLACE, this layer makes CONTAINMENT visible: from each
 * directory's hub (its origin) a line runs to every file it holds and to every child
 * directory's hub. Parent ──── file, parent ──── childDir. No sibling order, no
 * arrowheads — just the wires that show what belongs to what, which is the one
 * relationship a code tree must read. (It replaced an earlier sibling-order arrow
 * chain; ownership is the relationship that actually means something.)
 *
 * The wires have WEIGHT: real world-unit thickness (LineSegments2 + Line2NodeMaterial,
 * native since r183 — segments as instances, one draw per directory) that decays with
 * visible depth, so a shallow trunk wire reads heavier than a deep leaf's — the same
 * depth language as the marker/label gradient, told in stroke instead of color.
 * Materials pool by QUANTIZED width (depth levels, not dirs), so a thousand
 * directories share a handful of pipelines. `weight 0` is the hairline form: native
 * 1px lines on an explicit LineBasicNodeMaterial with alpha driven through
 * `opacityNode` — the auto-swapped LineBasicMaterial silently IGNORES `.opacity`
 * under WebGPU (observed on pixels; see reference_webgpu_line_rendering), so the
 * node-material path is the only one that actually blends.
 *
 * Every line of a given parent lives in that parent's LOCAL frame (the hub at the
 * origin, each endpoint a child's local position), so we parent one line object per
 * directory INTO the directory node, exactly like ContentTreeMarkers parents its
 * prism. It rides every transform for free: relayouts, scheme switches, restAbove,
 * live drags — and the relayout GLIDE (ContentTreeMotion): while nodes ease to their
 * slots, update() rewrites endpoints per frame IN PLACE (no buffer realloc — the
 * interleaved instance array is rewritten and flagged, a fresh geometry only on
 * count change). File lines and directory lines keep distinct colors (colorA /
 * colorB) via per-vertex colors, one material either way. Meshes carry
 * userData.isMarker — schemes ignore them (partitionChildren) and GPU picking never
 * sees them. Rebuilds are driven by ContentTree.onRelayout, so the lines can never
 * observe a stale layout.
 */

import * as THREE from 'three';
import { Line2NodeMaterial, LineBasicNodeMaterial } from 'three/webgpu';
import { uniform } from 'three/tsl';
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { RENDER_ORDER } from '../core/renderOrder.js';
import { partitionChildren, leafBox, subtreeContentBounds, visibleDepth } from './layouts/nodeUtils.js';

export const ARROW_DEFAULTS = {
    zLift: 0,                   // +z float for flat schemes; 0 for the volumetric jellyfish
    opacity: 0.5,
    colorA: 0x4a8acc,           // FILE ownership lines (hub → file)
    colorB: 0xcc7a4a,           // DIRECTORY ownership lines (hub → child dir hub)
    weight: 2,                  // world-unit stroke of a depth-1 dir's wires; 0 = hairline (1px)
    weightDecay: 0.75,          // × per visible depth level — deep wires thin toward hairlines
    weightMin: 0.3,             // stroke floor, so a deep tree never decays to invisible
};

// Opts that shape the BUILT line objects (geometry kind, per-depth materials): a
// configure() touching one rebuilds every link. opacity/colors just restyle live.
const BUILD_OPTS = new Set(['weight', 'weightDecay', 'weightMin']);

const _v = new THREE.Vector3();
const _abox = new THREE.Box3();

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
        this._links = new Map();    // dir path → { mesh, geo, count, thick }
        // The hairline material: alpha through opacityNode (the ONLY path the WebGPU
        // backend actually blends), shared by every hairline link. Live-tunable.
        this._alpha = uniform(this.opts.opacity);
        this._thinMat = new LineBasicNodeMaterial({ vertexColors: true, transparent: true, depthWrite: false });
        this._thinMat.opacityNode = this._alpha;
        // The weighted materials, pooled by QUANTIZED stroke width (≈ one per visible
        // depth level) — never one per directory (pipeline count is the scarce resource).
        this._thickMats = new Map();
        this._offRelayout = tree.onRelayout(() => this.update());
        this.update();
    }

    /** Patch options. Weight-shaping opts rebuild the links; opacity/colors restyle live. */
    configure(patch = {}) {
        let rebuild = false;
        for (const [k, v] of Object.entries(patch)) {
            if (this.opts[k] === v) continue;
            this.opts[k] = v;
            if (BUILD_OPTS.has(k)) rebuild = true;
        }
        this._alpha.value = this.opts.opacity;
        for (const mat of this._thickMats.values()) mat.opacity = this.opts.opacity;
        if (rebuild) for (const path of [...this._links.keys()]) this._dropLinks(path);
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

    /** The pooled weighted material for a stroke width (quantized to 2 decimals). @private */
    _thickMat(width) {
        const key = Math.round(width * 100) / 100;
        let mat = this._thickMats.get(key);
        if (!mat) {
            mat = new Line2NodeMaterial({ vertexColors: true });
            mat.worldUnits = true;
            mat.linewidth = key;
            mat.transparent = true;       // r184 composites against the opaque pass
            mat.opacity = this.opts.opacity;
            mat.depthWrite = false;
            this._thickMats.set(key, mat);
        }
        return mat;
    }

    /** The stroke width for a directory at `depth` (1 = shallowest visible). @private */
    _weightAt(depth) {
        const o = this.opts;
        return Math.max(o.weight * Math.pow(o.weightDecay, Math.max(depth - 1, 0)), o.weightMin);
    }

    /** Rebuild every directory's ownership lines from the tree's current layout. Safe to
     *  call per frame while a relayout glide is in flight: unchanged line counts rewrite
     *  their buffers in place (no realloc, no new GPU objects). */
    update() {
        const o = this.opts;
        const thick = o.weight > 0;
        const colFile = new THREE.Color(o.colorA);
        const colDir = new THREE.Color(o.colorB);
        const seen = new Set();
        const showF = this.showFiles, showD = this.showDirs;

        for (const [path, node] of this.tree._dirs.entries()) {
            const { files, dirs } = partitionChildren(node);   // markers excluded
            // A library VOLUME is the dir's own body sitting at its origin — a hub→volume
            // wire is a line from the dir to itself, pure noise in the title area. The
            // pages inside are ONE object; ownership is already told by containment.
            const fileLeaves = files.filter((f) => !f.userData?.isVolume);
            const nF = showF ? fileLeaves.length : 0, nD = showD ? dirs.length : 0;
            const count = nF + nD;                             // one line per shown child
            if (count === 0) { this._dropLinks(path); continue; }
            seen.add(path);

            let link = this._links.get(path);
            if (!link || link.count !== count || link.thick !== thick) {
                this._dropLinks(path);
                link = thick
                    ? this._makeThick(count, this._weightAt(visibleDepth(node, this.tree.root)))
                    : this._makeThin(count);
                link.mesh.name = `owns:${path}`;
                link.mesh.userData = { isMarker: true, path };
                this._links.set(path, link);
            }
            if (link.mesh.parent !== node) node.add(link.mesh);

            // One flat [sx,sy,sz,ex,ey,ez]× layout serves both forms: the thin geometry's
            // position attribute IS vertex pairs, the thick geometry's interleaved
            // instance buffer IS segment pairs — same bytes, written in place.
            const pos = link.posArray, col = link.colArray;
            let k = 0;
            if (showF) for (const leaf of fileLeaves) k = this._writeLine(pos, col, k, this._fileAnchor(leaf), colFile);
            if (showD) for (const dir of dirs) k = this._writeLine(pos, col, k, dir.position, colDir);
            link.commit();
            link.mesh.visible = true;
            link.mesh.renderOrder = RENDER_ORDER.CONNECTION;
        }

        for (const path of [...this._links.keys()]) if (!seen.has(path)) this._dropLinks(path);
    }

    /** A hairline link: native 1px LineSegments over vertex pairs. @private */
    _makeThin(count) {
        const geo = new THREE.BufferGeometry();
        const posAttr = new THREE.BufferAttribute(new Float32Array(count * 6), 3);
        const colAttr = new THREE.BufferAttribute(new Float32Array(count * 6), 3);
        geo.setAttribute('position', posAttr);
        geo.setAttribute('color', colAttr);
        const mesh = new THREE.LineSegments(geo, this._thinMat);
        return {
            mesh, geo, count, thick: false,
            posArray: posAttr.array, colArray: colAttr.array,
            commit() { posAttr.needsUpdate = true; colAttr.needsUpdate = true; geo.computeBoundingSphere(); },
        };
    }

    /** A weighted link: instanced thick segments (LineSegments2), stroke in world units.
     *  The interleaved instance buffers are kept and rewritten in place on every
     *  update — setPositions/setColors only ever run here, at creation. @private */
    _makeThick(count, width) {
        const geo = new LineSegmentsGeometry();
        geo.setPositions(new Float32Array(count * 6));
        geo.setColors(new Float32Array(count * 6));
        const mesh = new LineSegments2(geo, this._thickMat(width));
        const posBuf = geo.attributes.instanceStart.data;   // the shared interleaved buffer
        const colBuf = geo.attributes.instanceColorStart.data;
        return {
            mesh, geo, count, thick: true,
            posArray: posBuf.array, colArray: colBuf.array,
            commit() { posBuf.needsUpdate = true; colBuf.needsUpdate = true; geo.computeBoundingSphere(); },
        };
    }

    /** A file's content-box center in its PARENT's local frame — where its ownership line lands. A
     *  layout-group panel may sit at the core with its grids warped out onto the arc, so its own
     *  box/origin no longer marks its content; anchor to where its grids ACTUALLY are instead. */
    _fileAnchor(leaf) {
        leaf.updateMatrix();
        const b = leaf.userData?.isLayoutGroup ? subtreeContentBounds(leaf, _abox, false) : leafBox(leaf);
        return _v.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2)
            .applyMatrix4(leaf.matrix);
    }

    /** Write one hub→endpoint line (start+end) at segment index k; returns the next index. @private */
    _writeLine(pos, col, k, end, color) {
        const a = k * 6;
        pos[a] = 0; pos[a + 1] = 0; pos[a + 2] = this.opts.zLift;       // hub at the dir origin
        pos[a + 3] = end.x; pos[a + 4] = end.y; pos[a + 5] = end.z + this.opts.zLift;
        for (let v = 0; v < 2; v++) { col[a + v * 3] = color.r; col[a + v * 3 + 1] = color.g; col[a + v * 3 + 2] = color.b; }
        return k + 1;
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
        this._thinMat.dispose();
        for (const mat of this._thickMats.values()) mat.dispose();
        this._thickMats.clear();
    }
}

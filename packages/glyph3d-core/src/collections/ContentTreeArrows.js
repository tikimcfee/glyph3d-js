/**
 * ContentTreeArrows — OWNERSHIP traces: each directory wired to everything it owns,
 * routed like a circuit, never drawn across a face.
 *
 * Where ContentTreeMarkers gives a directory PRESENCE (a translucent volume) and the
 * scheme gives content its PLACE, this layer makes CONTAINMENT visible — as BOARD
 * TRACES, not string art. Every child (file book, child dir) exposes a PIN: the
 * top-center of its frame. From the directory's hub a TRUNK BUS exits along the top
 * frame edge and runs down the outside gutter (busMargin past the footprint AND past
 * every pin); per child, a RAIL crosses in the inter-row gutter just above the
 * child's top edge (railGap) and a short DROP lands on the pin. Every segment is
 * axis-aligned and every run lives in a gutter or along a frame — the structural
 * invariant that keeps traces off the content, which is what makes them READABLE.
 * (Straight hub→center diagonals were tried first: they crossed every face they
 * connected and stretched with the layout — noise, not information.)
 *
 * The traces have WEIGHT: real world-unit thickness (LineSegments2 + Line2NodeMaterial,
 * native since r183 — segments as instances, one draw per directory) that decays with
 * visible depth, so a shallow trunk reads heavier than a deep leaf's — the same
 * depth language as the marker/label gradient, told in stroke instead of color.
 * Materials pool by QUANTIZED width (depth levels, not dirs), so a thousand
 * directories share a handful of pipelines. `weight 0` is the hairline form: native
 * 1px lines on an explicit LineBasicNodeMaterial with alpha driven through
 * `opacityNode` — the auto-swapped LineBasicMaterial silently IGNORES `.opacity`
 * under WebGPU (observed on pixels; see reference_webgpu_line_rendering), so the
 * node-material path is the only one that actually blends.
 *
 * Every trace of a given parent lives in that parent's LOCAL frame (the hub at the
 * origin, pins in child-local positions), so we parent one line object per
 * directory INTO the directory node, exactly like ContentTreeMarkers parents its
 * prism. It rides every transform for free: relayouts, scheme switches, restAbove,
 * live drags — and the relayout GLIDE (ContentTreeMotion): while nodes ease to their
 * slots, update() re-routes per frame IN PLACE (no buffer realloc — the interleaved
 * instance array is rewritten and flagged, a fresh geometry only on count change).
 * File traces and directory traces keep distinct colors (colorA / colorB, the trunk
 * in the structural colorB) via per-vertex colors, one material either way. Meshes
 * carry userData.isMarker — schemes ignore them (partitionChildren) and GPU picking
 * never sees them. Rebuilds are driven by ContentTree.onRelayout, so the traces can
 * never observe a stale layout.
 */

import * as THREE from 'three';
import { Line2NodeMaterial, LineBasicNodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu';
import { uniform } from 'three/tsl';
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { RENDER_ORDER } from '../core/renderOrder.js';
import { partitionChildren, leafBox, subtreeContentBounds, visibleDepth } from './layouts/nodeUtils.js';

// Ivan's field-tested dials (2026-08-01): a WIDE bus margin and a HIGH rail gap give
// the traces real clearance — rails ride the frame line, drops read as long clean
// leads — and a uniform stroke (decay 1) keeps the whole circuit one weight.
export const ARROW_DEFAULTS = {
    zLift: 0,                   // +z float for flat schemes; 0 for the volumetric jellyfish
    opacity: 0.5,
    colorA: 0x4a8acc,           // FILE ownership traces (bus → file pin)
    colorB: 0xcc7a4a,           // DIRECTORY traces (bus → child dir pin) + the trunk bus itself
    weight: 15.1,               // world-unit stroke of a depth-1 dir's traces; 0 = hairline (1px)
    weightDecay: 1,             // × per visible depth level — 1 = uniform; <1 thins deep traces
    weightMin: 0.3,             // stroke floor, so a deep tree never decays to invisible
    busMargin: 74,              // how far OUTSIDE the dir's left frame the trunk bus runs
    railGap: 100,               // how far above a child's top edge its rail crosses (the gutter run)
    chamfer: 20.5,              // 45° corner cut length (world units) — 0 = sharp 90° corners
    pads: 1,                    // 1 → a disc on every pin + the hub (the visible pin-set)
    padScale: 1.3,              // pad radius, × the trace stroke width
};

// Opts that shape the BUILT line objects (geometry kind, per-depth materials): a
// configure() touching one rebuilds every link. opacity/colors/routing restyle live.
const BUILD_OPTS = new Set(['weight', 'weightDecay', 'weightMin']);

/** Clamp helper: a rail may never rise above the hub line (the title edge). */
const railAbove = (pinY, gap) => Math.min(pinY + gap, 0);

const _v = new THREE.Vector3();
const _abox = new THREE.Box3();
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

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
        // Pad hardware: ONE shared unit-disc geometry + material for every pin pad,
        // instance-colored, fading on the same opacity uniform as the traces.
        this._padGeo = new THREE.CircleGeometry(1, 16);
        this._padMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
        this._padMat.opacityNode = this._alpha;
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

    /** Rebuild every directory's ownership traces from the tree's current layout. Safe to
     *  call per frame while a relayout glide is in flight: unchanged segment counts rewrite
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
            // A library VOLUME is the dir's own body sitting at its origin — a wire from
            // the dir to itself is pure noise in the title area. The pages inside are ONE
            // object; ownership is already told by containment.
            const fileLeaves = files.filter((f) => !f.userData?.isVolume);
            // Every shown child contributes its PIN (top-center of its frame) and color.
            const pins = [];
            if (showF) for (const leaf of fileLeaves) pins.push({ p: this._filePin(leaf), c: colFile });
            if (showD) for (const dir of dirs) pins.push({ p: dir.position.clone(), c: colDir });
            const count = pins.length ? 3 + pins.length * 4 : 0;   // trunk(3) + z-jog/rail/chamfer/drop per pin
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

            // The CIRCUIT route — rectilinear in ALL THREE axes (z never rides along a
            // rail; it gets its own jog), with 45° chamfered corners:
            //   trunk : hub → left along the top frame edge, a chamfer, down the
            //           outside gutter (busMargin past the footprint and every pin)
            //   z-jog : straight back/forward in z AT THE BUS — through empty gutter
            //           air, never through the rows standing between (a sloped rail
            //           was tried: it skewered every volume between two z-rows)
            //   rail  : across the row gutter IN THE CHILD'S OWN Z-PLANE
            //   drop  : chamfer, then the vertical pin lead onto the pin
            // The z-jog blends trunk color → child color, so a trace is followable
            // from bus to pin. Chamfers are ALWAYS emitted (degenerate → zero-length),
            // keeping segment counts stable — a glide re-routes without reallocs.
            const s = node.userData?.size;
            let busX = s ? -s.x / 2 : 0;
            let lowestRail = 0;
            for (const { p } of pins) {
                if (p.x < busX) busX = p.x;
                const railY = railAbove(p.y, o.railGap);
                if (railY < lowestRail) lowestRail = railY;
            }
            busX -= o.busMargin;

            // One flat [sx,sy,sz,ex,ey,ez]× layout serves both forms: the thin geometry's
            // position attribute IS vertex pairs, the thick geometry's interleaved
            // instance buffer IS segment pairs — same bytes, written in place.
            const pos = link.posArray, col = link.colArray;
            const z = o.zLift;
            const ch = Math.max(0, Math.min(o.chamfer, -busX / 2, -lowestRail / 2));
            let k = 0;
            k = this._writeSeg(pos, col, k, 0, 0, z, busX + ch, 0, z, colDir);             // trunk: top edge
            k = this._writeSeg(pos, col, k, busX + ch, 0, z, busX, -ch, z, colDir);        // trunk: 45° corner
            k = this._writeSeg(pos, col, k, busX, -ch, z, busX, lowestRail, z, colDir);    // trunk: outside gutter
            for (const { p, c } of pins) {
                const railY = railAbove(p.y, o.railGap);
                const pz = p.z + z;
                // The corner cut never eats the whole gap — a real vertical pin lead
                // (≥40% of the drop) always remains to land on the pad.
                const cr = Math.max(0, Math.min(o.chamfer, (railY - p.y) * 0.6, (p.x - busX) / 2));
                k = this._writeSeg(pos, col, k, busX, railY, z, busX, railY, pz, colDir, c);   // z-jog at the bus (color blend)
                k = this._writeSeg(pos, col, k, busX, railY, pz, p.x - cr, railY, pz, c);      // rail: row gutter, child z-plane
                k = this._writeSeg(pos, col, k, p.x - cr, railY, pz, p.x, railY - cr, pz, c);  // 45° corner
                k = this._writeSeg(pos, col, k, p.x, railY - cr, pz, p.x, p.y, pz, c);         // drop: pin lead
            }
            link.commit();
            link.mesh.visible = true;
            link.mesh.renderOrder = RENDER_ORDER.CONNECTION;

            // Pad hardware: an instanced disc on every pin + the hub — the pin-set made
            // visible. Sized by the trace stroke, colored per trace, fading on the same
            // opacity uniform as the lines. Matrices rewrite every pass (glide-cheap).
            this._writePads(link, node, pins, colDir, z);
        }

        for (const path of [...this._links.keys()]) if (!seen.has(path)) this._dropLinks(path);
    }

    /** @private Ensure + rewrite a link's pad InstancedMesh (hub + one per pin). */
    _writePads(link, node, pins, colDir, z) {
        const o = this.opts;
        const count = o.pads ? pins.length + 1 : 0;
        if (count === 0) { this._dropPads(link); return; }
        if (!link.pads || link.pads.count !== count) {
            this._dropPads(link);
            const m = new THREE.InstancedMesh(this._padGeo, this._padMat, count);
            m.name = link.mesh.name.replace('owns:', 'pads:');
            m.userData = { isMarker: true };
            m.renderOrder = RENDER_ORDER.CONNECTION + 1;
            link.pads = m;
        }
        if (link.pads.parent !== node) node.add(link.pads);
        const r = o.padScale * (link.thick ? link.mesh.material.linewidth : 1);
        _s.set(r, r, 1);
        _p.set(0, 0, z + 0.5);                                   // hub pad, nudged off the trace plane
        link.pads.setMatrixAt(0, _m4.compose(_p, _q, _s));
        link.pads.setColorAt(0, colDir);
        for (let i = 0; i < pins.length; i++) {
            const { p, c } = pins[i];
            _p.set(p.x, p.y, p.z + z + 0.5);
            link.pads.setMatrixAt(i + 1, _m4.compose(_p, _q, _s));
            link.pads.setColorAt(i + 1, c);
        }
        link.pads.instanceMatrix.needsUpdate = true;
        if (link.pads.instanceColor) link.pads.instanceColor.needsUpdate = true;
    }

    /** @private */
    _dropPads(link) {
        if (!link?.pads) return;
        link.pads.parent?.remove(link.pads);
        link.pads.dispose();                                     // instance buffers only — geometry is shared
        link.pads = null;
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

    /** A file's PIN — the top-center of its frame in its PARENT's local frame, where its
     *  trace lead lands (a component's pin, not its face). A layout-group panel may sit
     *  at the core with its grids warped out onto the arc, so its own box/origin no
     *  longer marks its content; pin where its grids ACTUALLY are instead. */
    _filePin(leaf) {
        leaf.updateMatrix();
        const b = leaf.userData?.isLayoutGroup ? subtreeContentBounds(leaf, _abox, false) : leafBox(leaf);
        return _v.set((b.min.x + b.max.x) / 2, b.max.y, (b.min.z + b.max.z) / 2)
            .applyMatrix4(leaf.matrix).clone();
    }

    /** Write one trace segment (start+end) at segment index k; returns the next index.
     *  A different end color makes the segment a gradient (the z-jog's takeoff blend). @private */
    _writeSeg(pos, col, k, ax, ay, az, bx, by, bz, colorA, colorB = colorA) {
        const a = k * 6;
        pos[a] = ax; pos[a + 1] = ay; pos[a + 2] = az;
        pos[a + 3] = bx; pos[a + 4] = by; pos[a + 5] = bz;
        col[a] = colorA.r; col[a + 1] = colorA.g; col[a + 2] = colorA.b;
        col[a + 3] = colorB.r; col[a + 4] = colorB.g; col[a + 5] = colorB.b;
        return k + 1;
    }

    /** @private — remove a directory's traces + pads, free its geometry. */
    _dropLinks(path) {
        const link = this._links.get(path);
        if (!link) return;
        this._dropPads(link);
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
        this._padGeo.dispose();
        this._padMat.dispose();
    }
}

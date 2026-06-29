/**
 * ContentTree — the project's content as a directory-mirroring scene graph.
 *
 * The single structure behind all content: every directory is a THREE.Group node, every
 * file is a leaf (a CodeGrid Object3D) parented under its directory's node, directories
 * nest under their parents, and the whole thing hangs off one `root` Group. Move the root
 * and the project moves; move a directory node and its subtree moves with it.
 *
 * There is no "flat load" vs "tree load" — every content operation is a tree mutation:
 *   insert(leaf, 'a/b/c/file.js')  → mkdir -p the a→b→c chain (reusing existing nodes),
 *                                     parent the leaf under c. A lone 'file.js' is the
 *                                     degenerate case (parented straight under root).
 *   remove('a/b/c/file.js')        → detach the leaf; empty dir nodes are KEPT (they
 *                                     measure to zero, so siblings just close the gap).
 *   apply([...ops]) + relayout()   → a batch (the Swift "RenderPlan"): apply many
 *                                     inserts/removes, then ONE relayout pass.
 *
 * Layout is two-pass and tree-resident, not a global function thrown at a flat list:
 *   measure (post-order): a leaf's size comes from `measure(leaf)`; a directory's size is
 *                         derived from its children's sizes (recursive container).
 *   place   (pre-order):  each node positions its children in its OWN local space, then
 *                         recurses — so a node's transform is the anchor its subtree rides.
 * Adding one file re-measures/-places only the affected path and lets the size delta
 * propagate up; untouched subtrees keep their positions.
 *
 * Pure `three` (Group/Object3D/Box3/Vector3) — no WebGPU — so the directory recursion is
 * unit-testable headlessly with mock leaves (see tools/contenttree.test.mjs).
 */

import * as THREE from 'three';
import packedLayout from './layouts/packedLayout.js';
import { LAYOUT_SCHEMES, schemeNameOf } from './layouts/index.js';
import { BOUNDS_Z_PAD } from '../core/constants.js';

/** Scratch vector for footprintBounds — one focused node measured per frame, no per-call alloc. */
const _fpPos = new THREE.Vector3();

/** Normalize a path: trim, drop leading/trailing/duplicate slashes → clean segments. */
function splitPath(path) {
    return String(path == null ? '' : path).split('/').filter((s) => s.length > 0);
}

/** dirname/basename on a normalized segment list. */
function dirOf(parts) { return parts.slice(0, -1); }
function baseOf(parts) { return parts.length ? parts[parts.length - 1] : ''; }

export default class ContentTree {
    /**
     * @param {object} [opts]
     * @param {(root:THREE.Object3D, opts:object)=>{w:number,h:number}} [opts.layout] layout scheme
     *        (default: packed). Measures + places a subtree's children in their local frame.
     * @param {object} [opts.layoutOpts] options forwarded to the layout scheme.
     */
    constructor(opts = {}) {
        this.layout = opts.layout || packedLayout;
        this.layoutOpts = opts.layoutOpts || {};

        this.root = new THREE.Group();
        this.root.name = 'content-root';
        this.root.userData = { path: '', name: '', isDir: true };
        this.root.getBounds = () => this.footprintBounds(this.root);

        // Keyed by FULL normalized path (NOT by name) so `b` and `bc` never collide and
        // every dir is created exactly once. '' → root.
        this._dirs = new Map([['', this.root]]);
        // Leaf grids by full file path.
        this._leaves = new Map();
        this._dirty = true;
        // Fired after every full (root) relayout — markers and other tree-decorating
        // systems rebuild from here, so they can never observe a stale layout.
        this._onRelayout = new Set();
    }

    /** Subscribe to full-tree relayouts. Returns an unsubscribe function. */
    onRelayout(cb) {
        this._onRelayout.add(cb);
        return () => this._onRelayout.delete(cb);
    }

    /** The dir node for a directory path ('' → root), or null if it doesn't exist. */
    getNode(dirPath) {
        return this._dirs.get(splitPath(dirPath).join('/')) || null;
    }

    /** Is a file leaf present at this path? */
    has(path) {
        return this._leaves.has(splitPath(path).join('/'));
    }

    /** Every file path currently in the tree. */
    paths() { return [...this._leaves.keys()]; }

    /** Number of directory nodes (excluding the root). */
    dirCount() { return this._dirs.size - 1; }

    /**
     * The tree-parent directory node of a node, derived from its PATH — NOT from
     * node.parent (the THREE parent), which reparenting can hijack: a leaf docked to
     * the camera bar has .parent === the dock, so node.parent's children would be
     * other dock tiles from unrelated directories. Path-derived parenthood keeps
     * sibling/hierarchy navigation tied to the real tree no matter where a node's
     * Object3D currently hangs. Root (path '') has no parent → null.
     * @param {THREE.Object3D} node
     * @returns {THREE.Object3D|null} the parent dir node ('' → root), or null
     */
    parentOf(node) {
        const path = node?.userData?.path;
        if (path == null || path === '') return null;
        const parentPath = splitPath(path).slice(0, -1).join('/');
        return this._dirs.get(parentPath) || null;
    }

    /**
     * Direct CONTENT children of a node — file leaves + subdirectory nodes, with
     * decorations (bounding-prism markers etc.) excluded. Ordered dirs-first then by
     * name, so sibling traversal (focus.sibling) and descent (focus.child) are
     * deterministic regardless of insertion order. Both files and dirs are THREE
     * objects parented in the tree, so node.parent + this give the full walk.
     * @param {THREE.Object3D} node
     * @returns {THREE.Object3D[]}
     */
    contentChildren(node) {
        if (!node) return [];
        // Descend through layout-group containers (jellyfish page/row VStacks carry
        // userData.isLayoutGroup but no path) so the file leaves nested inside a page are
        // still reached — focus.child/sibling navigate FILES, not the presentation columns.
        const out = [];
        const visit = (n) => {
            for (const c of n.children) {
                if (!c.userData || c.userData.isMarker) continue;
                if (c.userData.isLayoutGroup) { visit(c); continue; }
                if (c.userData.path !== undefined) out.push(c);
            }
        };
        visit(node);
        return out.sort((a, b) => {
            const ad = !!a.userData.isDir, bd = !!b.userData.isDir;
            if (ad !== bd) return ad ? -1 : 1; // directories first
            return String(a.userData.name || '').localeCompare(String(b.userData.name || ''));
        });
    }

    /**
     * World-space AABB of a single node from its laid-out footprint (userData.size at
     * the node's world position) — the O(1) layout-extent model getWorldBounds uses for
     * geometry-less leaves, so framing a directory is cheap even per-frame.
     *
     * ANCHOR: every layout scheme places a node with its origin at the footprint
     * TOP-CENTER (see layouts/index.js) — content extends DOWNWARD (and child dirs back
     * in z). So x is centered on the origin (±w/2) but y spans [origin − h, origin], NOT
     * origin ± h/2. Footprints are z-thin; the box sits at the node's own z-plane.
     * @param {THREE.Object3D} node
     * @param {THREE.Box3} [target]
     * @returns {THREE.Box3}
     */
    footprintBounds(node, target = new THREE.Box3()) {
        node.updateWorldMatrix(true, false);
        node.getWorldPosition(_fpPos);
        const s = (node.userData && node.userData.size) || { x: 1, y: 1, z: 0 };
        // z gets BOUNDS_Z_PAD on each side: the footprint is laid out flat (size.z = 0)
        // on the same plane as the contained grids' background panels, so the focus
        // region fill would sit coplanar with them and z-fight. The pad makes it a thin
        // slab that straddles the plane and clears the panels.
        target.min.set(_fpPos.x - s.x / 2, _fpPos.y - s.y,     _fpPos.z - s.z / 2 - BOUNDS_Z_PAD);
        target.max.set(_fpPos.x + s.x / 2, _fpPos.y,           _fpPos.z + s.z / 2 + BOUNDS_Z_PAD);
        return target;
    }

    /**
     * Ensure the directory-node chain for `dirParts` exists, creating only the missing
     * tail and parenting each new node under its parent. Idempotent. Returns the deepest
     * node. (mkdir -p, keyed by full path so it's create-once and substring-safe.)
     */
    _ensureDir(dirParts) {
        let node = this.root;
        let acc = '';
        for (const seg of dirParts) {
            acc = acc ? `${acc}/${seg}` : seg;
            let child = this._dirs.get(acc);
            if (!child) {
                child = new THREE.Group();
                child.name = `dir:${acc}`;
                child.userData = { path: acc, name: seg, isDir: true };
                // Directories are first-class focus targets: a getBounds() (the laid-out
                // footprint) lets the camera frame a dir and the selection box draw around
                // it, exactly like a file. focus.parent/child/sibling navigate these nodes.
                child.getBounds = () => this.footprintBounds(child);
                node.add(child);
                this._dirs.set(acc, child);
            }
            node = child;
        }
        return node;
    }

    /**
     * Insert a file leaf at `path`. Builds the ancestor dir chain on demand and parents
     * the leaf under its directory node. Re-inserting the same path replaces the leaf.
     * Does NOT relayout (batch then call relayout()). Returns the parent dir node.
     */
    insert(leaf, path) {
        const parts = splitPath(path);
        if (parts.length === 0) throw new Error('ContentTree.insert: empty path');
        const full = parts.join('/');
        if (this._leaves.has(full)) this.remove(full); // replace
        const dir = this._ensureDir(dirOf(parts));
        leaf.userData = { ...(leaf.userData || {}), path: full, name: baseOf(parts), isDir: false };
        dir.add(leaf);
        this._leaves.set(full, leaf);
        this._dirty = true;
        return dir;
    }

    /**
     * Remove the file leaf at `path` (no-op if absent). Empty directory nodes are KEPT by
     * default (they measure to zero); pass {prune:true} to also drop now-empty ancestor
     * dir nodes up to (not including) the root. Returns the removed leaf or null.
     */
    remove(path, { prune = false } = {}) {
        const full = splitPath(path).join('/');
        const leaf = this._leaves.get(full);
        if (!leaf) return null;
        const dir = leaf.parent;
        dir?.remove(leaf);
        this._leaves.delete(full);
        if (prune) this._pruneEmptyUp(dir);
        this._dirty = true;
        return leaf;
    }

    /** Drop empty dir nodes from `node` upward, stopping at the first non-empty (or root).
     *  Markers (bounding prisms etc.) are decorations, not content — a dir holding only
     *  markers is empty and prunes; its markers go with it. */
    _pruneEmptyUp(node) {
        const isEmpty = (n) => n.children.every((c) => c.userData?.isMarker);
        let cur = node;
        while (cur && cur !== this.root && isEmpty(cur)) {
            const parent = cur.parent;
            parent?.remove(cur);
            this._dirs.delete(cur.userData.path);
            cur = parent;
        }
    }

    /**
     * Apply a batch of ops then relayout once (the RenderPlan). Each op is
     * {op:'insert', leaf, path} or {op:'remove', path, prune?}.
     */
    apply(ops = []) {
        for (const op of ops) {
            if (op.op === 'insert') this.insert(op.leaf, op.path);
            else if (op.op === 'remove') this.remove(op.path, { prune: op.prune });
        }
        this.relayout();
        return this;
    }

    // ============ layout ============

    /**
     * Swap the layout scheme (and optionally its opts). Marks the tree dirty but does
     * NOT relayout — callers follow with relayoutAndRest() so the switch and the
     * re-lay stay one explicit flow (the layout.scheme verb is the canonical caller).
     */
    setLayout(layout, layoutOpts) {
        this.layout = layout;
        if (layoutOpts !== undefined) this.layoutOpts = layoutOpts;
        this._dirty = true;
        return this;
    }

    /**
     * The layout as SERIALIZABLE STATE — the scheme NAME + its opt overrides (schemeNameOf maps the
     * active layout function back to its name). This is what persistence READS: plain data, a direct
     * synchronous property read, no verb and no async. null for an unnamed/custom layout function.
     * @returns {{scheme:string, opts:object}|null}
     */
    getLayoutState() {
        const scheme = schemeNameOf(this.layout);
        return scheme ? { scheme, opts: { ...this.layoutOpts } } : null;
    }

    /**
     * SET the layout from serialized state and re-lay — the load path's direct WRITE (no verb replay).
     * Maps the scheme NAME back to its function via LAYOUT_SCHEMES; an unknown name is ignored
     * (self-heal). Rests the field on the world floor (y=0), same as the layout.scheme verb does.
     * @param {{scheme:string, opts?:object}} state @returns {boolean} whether it applied
     */
    applyLayoutState(state) {
        const layout = state?.scheme && LAYOUT_SCHEMES[state.scheme];
        if (!layout) return false;
        this.setLayout(layout, state.opts || {});
        this.relayoutAndRest();
        return true;
    }

    /**
     * Lay out `node` and its subtree via the layout scheme (default: the walk-tree). The
     * scheme measures bottom-up and places each node's children in its own local frame, so a
     * node's transform carries its subtree. Default `node` = root (full pass).
     * @returns {{w:number,h:number}} the node's measured footprint
     */
    relayout(node = this.root) {
        this._flattenGroups(node);
        const size = this.layout(node, this.layoutOpts);
        if (node === this.root) {
            this._dirty = false;
            for (const cb of this._onRelayout) cb(this);
        }
        return size;
    }

    /**
     * Normalize away any layout-inserted grouping nodes (the jellyfish scheme's page/row
     * VStacks, tagged userData.isLayoutGroup) under `node`, re-homing their file leaves back
     * onto their directory node and dropping the empty containers. Runs before every relayout
     * so the active scheme always starts from the canonical flat structure (file leaves direct
     * under their dir): the wrap is idempotent (jellyfish re-packs fresh each pass) and
     * reversible (a flat scheme sees flat files). A tree with no groups is untouched, and
     * leaves parented OUTSIDE the tree (e.g. docked to the camera bar) are never reached —
     * only a group's own descendants are re-homed, onto that group's directory parent.
     * @private
     */
    _flattenGroups(node = this.root) {
        const visit = (dir) => {
            for (const child of [...dir.children]) {
                if (child.userData?.isLayoutGroup) {
                    // gather the group's path-bearing leaf descendants, re-home them onto `dir`.
                    const leaves = [];
                    const gather = (g) => {
                        for (const c of g.children) {
                            if (c.userData?.isLayoutGroup) gather(c);
                            else if (c.userData?.path !== undefined) leaves.push(c);
                        }
                    };
                    gather(child);
                    for (const leaf of leaves) dir.add(leaf);   // THREE.add re-parents (row → dir)
                    dir.remove(child);
                } else if (child.userData?.isDir) {
                    visit(child);
                }
            }
        };
        visit(node);
    }

    /**
     * The one relayout entry point callers should use after any content/footprint change
     * (insert, remove, a grid's render-style/window change): re-lay the tree and re-settle
     * it on the world floor. Replaces the old flat `flowLayout(getGrids())` reflows.
     * @param {number} [floorY=0] the world floor to rest content above
     */
    relayoutAndRest(floorY = 0) {
        this.relayout();
        this.restAbove(floorY);
        return this;
    }

    /**
     * Position the root so the content rests ABOVE a fixed world floor — the world is a
     * paused physics scene: the ground is a constant, content sits on top of it. Content is
     * laid out centered on the root's origin, so lifting the root by half its height puts the
     * content's bottom at `floorY` (and it grows upward from there). Call after relayout().
     * @param {number} [floorY=0] the constant world floor the content rests on
     */
    restAbove(floorY = 0) {
        const wb = this.getWorldBounds();           // current content extent (scheme-agnostic)
        if (!wb.isEmpty()) this.root.position.y += (floorY - wb.min.y); // drop/lift bottom onto the floor
        this.root.updateMatrixWorld(true);
        return this;
    }

    /**
     * World-space AABB of all content — for ground anchoring etc. Unions each leaf's own
     * world box: a real grid's getBounds() when available, else a box derived from its
     * world position ± its measured size (so it's correct even for geometry-less leaves,
     * and reflects the LAYOUT extent rather than raw mesh geometry).
     */
    getWorldBounds(target = new THREE.Box3()) {
        target.makeEmpty();
        this.root.updateWorldMatrix(true, true);
        const wp = new THREE.Vector3();
        const tmp = new THREE.Box3();
        for (const leaf of this._leaves.values()) {
            if (typeof leaf.getBounds === 'function') {
                const b = leaf.getBounds();
                if (b && !b.isEmpty?.()) { target.union(b); continue; }
            }
            leaf.getWorldPosition(wp);
            const s = leaf.userData.size || { x: 0, y: 0, z: 0 };
            tmp.min.set(wp.x - s.x / 2, wp.y - s.y / 2, wp.z - s.z / 2);
            tmp.max.set(wp.x + s.x / 2, wp.y + s.y / 2, wp.z + s.z / 2);
            target.union(tmp);
        }
        return target;
    }
}

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

/** Normalize a path: trim, drop leading/trailing/duplicate slashes → clean segments. */
function splitPath(path) {
    return String(path == null ? '' : path).split('/').filter((s) => s.length > 0);
}

/** dirname/basename on a normalized segment list. */
function dirOf(parts) { return parts.slice(0, -1); }
function baseOf(parts) { return parts.length ? parts[parts.length - 1] : ''; }

/** Sort key: directories first, then case-insensitive name (matches buildTree / the Files panel). */
function childSort(a, b) {
    const ad = !!a.userData.isDir, bd = !!b.userData.isDir;
    if (ad !== bd) return ad ? -1 : 1;
    return String(a.userData.name).localeCompare(String(b.userData.name), undefined, { sensitivity: 'base' });
}

/**
 * Default measure: a leaf's intrinsic size in world units. Prefers an explicit
 * userData.size (tests / synthetic leaves), then a getBounds()-derived size (CodeGrid /
 * TerminalGrid), else a unit box. Returns a fresh {x,y,z} (never shared).
 */
function defaultMeasure(leaf) {
    const s = leaf.userData && leaf.userData.size;
    if (s && Number.isFinite(s.x)) return { x: s.x, y: s.y, z: s.z };
    if (typeof leaf.getBounds === 'function') {
        const b = leaf.getBounds();
        if (b && !b.isEmpty?.()) {
            const v = new THREE.Vector3();
            b.getSize(v);
            return { x: v.x, y: v.y, z: v.z };
        }
    }
    return { x: 1, y: 1, z: 1 };
}

const DEFAULTS = {
    gap: 6,        // world units between stacked siblings
    pad: 4,        // padding a directory node adds around its children
};

export default class ContentTree {
    /**
     * @param {object} [opts]
     * @param {(leaf:THREE.Object3D)=>{x:number,y:number,z:number}} [opts.measure] intrinsic leaf size
     * @param {number} [opts.gap] gap between siblings
     * @param {number} [opts.pad] padding a directory adds around its children
     */
    constructor(opts = {}) {
        this.measure = opts.measure || defaultMeasure;
        this.gap = opts.gap ?? DEFAULTS.gap;
        this.pad = opts.pad ?? DEFAULTS.pad;

        this.root = new THREE.Group();
        this.root.name = 'content-root';
        this.root.userData = { path: '', name: '', isDir: true };

        // Keyed by FULL normalized path (NOT by name) so `b` and `bc` never collide and
        // every dir is created exactly once. '' → root.
        this._dirs = new Map([['', this.root]]);
        // Leaf grids by full file path.
        this._leaves = new Map();
        this._dirty = true;
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

    /** Drop empty dir nodes from `node` upward, stopping at the first non-empty (or root). */
    _pruneEmptyUp(node) {
        let cur = node;
        while (cur && cur !== this.root && cur.children.length === 0) {
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

    // ============ layout (two-pass, recursive container) ============

    /**
     * Re-measure and re-place `node` and its subtree. Default `node` = root (full pass).
     * Sizes propagate bottom-up; positions are assigned top-down in each node's local space.
     * @returns {{x:number,y:number,z:number}} the node's measured size
     */
    relayout(node = this.root) {
        const size = this._measure(node);
        this._place(node);
        if (node === this.root) this._dirty = false;
        return size;
    }

    /**
     * Post-order measure: cache an intrinsic {x,y,z} size on every node. A leaf measures
     * directly; a directory stacks its (sorted) children vertically — width = widest child,
     * height = sum of child heights + gaps, plus padding all around. An empty directory
     * measures to zero so it occupies no space.
     * @private
     */
    _measure(node) {
        if (!node.userData.isDir) {
            const s = this.measure(node);
            node.userData.size = s;
            return s;
        }
        // Deterministic order — sort the actual child list so structure == layout order.
        node.children.sort(childSort);
        let w = 0, h = 0, d = 0, n = 0;
        for (const child of node.children) {
            const cs = this._measure(child);
            w = Math.max(w, cs.x);
            h += cs.y;
            d = Math.max(d, cs.z);
            n++;
        }
        if (n === 0) { node.userData.size = { x: 0, y: 0, z: 0 }; return node.userData.size; }
        h += this.gap * (n - 1);
        const size = { x: w + this.pad * 2, y: h + this.pad * 2, z: d };
        node.userData.size = size;
        return size;
    }

    /**
     * Pre-order place: stack a node's sorted children top→down in the node's LOCAL space,
     * each centered on x. Positions are the child's offset from this node's origin, so the
     * node's own transform (set by its parent) carries the whole subtree. Recurses.
     * @private
     */
    _place(node) {
        if (!node.userData.isDir || node.children.length === 0) return;
        // Top of the content region (inside the padding), descending in -Y.
        let cursorY = (node.userData.size.y / 2) - this.pad;
        for (const child of node.children) { // already sorted by _measure
            const cs = child.userData.size;
            child.position.set(0, cursorY - cs.y / 2, 0);
            cursorY -= cs.y + this.gap;
            this._place(child);
        }
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

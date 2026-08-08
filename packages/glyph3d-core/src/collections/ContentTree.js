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
import Book from './Book.js';
import packedLayout from './layouts/packedLayout.js';
import { LAYOUT_SCHEMES, schemeNameOf, disposePanelSurfaces } from './layouts/index.js';
import { subtreeContentBounds } from './layouts/nodeUtils.js';
import { BOUNDS_Z_PAD } from '../core/constants.js';

/** Scratch vector for footprintBounds — one focused node measured per frame, no per-call alloc. */
const _fpPos = new THREE.Vector3();

/** Normalize a path: trim, drop leading/trailing/duplicate slashes → clean segments. */
function splitPath(path) {
    return String(path == null ? '' : path).split('/').filter((s) => s.length > 0);
}

/** '/' when the path is absolute (the relay's canonical key form), else ''. Node
 *  keys carry this prefix so userData.path byte-matches registry ids — one key
 *  space, no stripped-vs-canonical translation at any seam. Repo-relative paths
 *  (GitHub mode) have no prefix and behave exactly as before. */
function prefixOf(path) {
    return String(path == null ? '' : path).startsWith('/') ? '/' : '';
}

/** The full normalized key for a path: prefix + clean segments. '' → the root. */
function keyOf(path) {
    const parts = splitPath(path);
    return parts.length ? prefixOf(path) + parts.join('/') : '';
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
        // Every leaf's durable Book (its spatial carrier), by the same path key. Books
        // live as long as their leaf — schemes arrange them, never create/destroy them.
        this._books = new Map();
        this._dirty = true;
        // The batchRelayouts window: while _holdDepth > 0, relayoutAndRest records
        // instead of running; the outermost close settles once (_heldRest = floorY).
        this._holdDepth = 0;
        this._heldRest = undefined;
        // Fired after every full (root) relayout — markers and other tree-decorating
        // systems rebuild from here, so they can never observe a stale layout.
        this._onRelayout = new Set();
        // Fired at the TOP of every full relayout, before normalize/measure/place —
        // the seam for anything that needs the OUTGOING state (ContentTreeMotion
        // snapshots last-seen transforms here so the new layout can be a glide).
        this._onBeforeRelayout = new Set();
    }

    /** Subscribe to full-tree relayouts. Returns an unsubscribe function. */
    onRelayout(cb) {
        this._onRelayout.add(cb);
        return () => this._onRelayout.delete(cb);
    }

    /** Subscribe to the moment BEFORE a full relayout mutates anything. Returns an
     *  unsubscribe function. */
    onBeforeRelayout(cb) {
        this._onBeforeRelayout.add(cb);
        return () => this._onBeforeRelayout.delete(cb);
    }

    /** The dir node for a directory path ('' → root), or null if it doesn't exist. */
    getNode(dirPath) {
        return this._dirs.get(keyOf(dirPath)) || null;
    }

    /** Is a file leaf present at this path? */
    has(path) {
        return this._leaves.has(keyOf(path));
    }

    /** Every file path currently in the tree. */
    paths() { return [...this._leaves.keys()]; }

    /** The durable Book carrying the leaf at `path`, or null. The address of a file's form. */
    bookAt(path) { return this._books.get(keyOf(path)) || null; }

    /** Every Book in the tree (the repository AS a collection of books). */
    books() { return [...this._books.values()]; }

    /** The library VOLUME presenting a directory's files as pages, or null. Volumes are
     *  per-pass presentation Books the library deck builds (node.userData._volume) —
     *  addressable so book.page/book.scroll can turn a directory by its path. */
    volumeAt(dirPath) { return this._dirs.get(keyOf(dirPath))?.userData._volume ?? null; }

    /** Every live volume — the decks a frame loop eases (Book.update). */
    volumes() {
        const out = [];
        for (const node of this._dirs.values()) {
            if (node.userData._volume) out.push(node.userData._volume);
        }
        return out;
    }

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
        const parts = splitPath(path).slice(0, -1);
        const parentPath = parts.length ? prefixOf(path) + parts.join('/') : '';
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
        // Descend through layout-group containers (jellyfish page/row VStacks), books
        // (the durable carriers), and book internals (sheet nodes + mounts) so the file
        // leaves inside are still reached — focus.child/sibling navigate the GRIDS, not
        // their presentation shells.
        const out = [];
        const visit = (n) => {
            for (const c of n.children) {
                if (!c.userData || c.userData.isMarker) continue;
                if (c.userData.isLayoutGroup || c.userData.isBook || c.userData.isBookInternal) { visit(c); continue; }
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
    _ensureDir(dirParts, prefix = '') {
        let node = this.root;
        let acc = '';
        for (const seg of dirParts) {
            acc = acc ? `${acc}/${seg}` : prefix + seg;
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
     * Insert a file leaf at `path`. Builds the ancestor dir chain on demand, wraps the
     * leaf in its durable Book (the spatial carrier every scheme arranges), and parents
     * the book under the directory node. Re-inserting the same path replaces the leaf
     * (and its book). Does NOT relayout (batch then call relayout()). Returns the
     * parent dir node.
     */
    insert(leaf, path) {
        const parts = splitPath(path);
        if (parts.length === 0) throw new Error('ContentTree.insert: empty path');
        const prefix = prefixOf(path);
        const full = prefix + parts.join('/');
        if (this._leaves.has(full)) this.remove(full); // replace
        const dir = this._ensureDir(dirOf(parts), prefix);
        leaf.userData = { ...(leaf.userData || {}), path: full, name: baseOf(parts), isDir: false };
        // The book mirrors the leaf's identity: it is the path-bearing child the layout
        // partition sees, the unit structural schemes re-home, the shelf's future atom.
        const book = new Book(leaf);
        book.userData = { ...book.userData, path: full, name: baseOf(parts), isDir: false };
        dir.add(book);
        this._leaves.set(full, leaf);
        this._books.set(full, book);
        this._dirty = true;
        return dir;
    }

    /**
     * Swap the leaf at `path` IN PLACE — same Book, same mount, same parent chain
     * (dir node or a structural scheme's layout group), same pose. The seam the
     * actor-materialize swap uses: re-inserting created a NEW book under the DIR,
     * and any pose copied from the old book was local to a DIFFERENT parent frame
     * (a jellyfish panel, a stack group) — the actor landed kilometers off-field.
     * The OLD leaf is detached but NOT disposed (the caller overlaps it until the
     * new leaf's glyphs are laid). Returns the old leaf, or null if path unknown.
     */
    replaceLeaf(path, leaf) {
        const full = keyOf(path);
        const old = this._leaves.get(full);
        const book = this._books.get(full);
        if (!old || !book) return null;
        leaf.userData = { ...(leaf.userData || {}), path: full, name: old.userData?.name, isDir: false };
        // Same parent frame as the old leaf, so its LOCAL pose transfers verbatim
        // (schemes may pose the leaf, not the book). Scale stays the new leaf's own
        // (a CodeGrid's ScaleModel is its scale authority).
        leaf.position.copy(old.position);
        leaf.quaternion.copy(old.quaternion);
        leaf.updateMatrix();
        const mount = book.sheets?.[0]?.rectoMount ?? null;
        if (mount) {
            if (old.parent === mount) mount.remove(old);
            mount.add(leaf);
        } else {
            // No mount (never the plain-carrier shape, but stay honest): seat the
            // leaf where the old one was parented.
            old.parent?.add(leaf);
            old.parent?.remove(old);
        }
        if (book.sheets?.[0]) book.sheets[0].recto = leaf;
        this._leaves.set(full, leaf);
        this._dirty = true;
        return old;
    }

    /**
     * Remove the file leaf at `path` (no-op if absent). Empty directory nodes are KEPT by
     * default (they measure to zero); pass {prune:true} to also drop now-empty ancestor
     * dir nodes up to (not including) the root. Returns the removed leaf or null.
     */
    remove(path, { prune = false } = {}) {
        const full = keyOf(path);
        const leaf = this._leaves.get(full);
        if (!leaf) return null;
        const book = this._books.get(full);
        // Prune from the PATH-derived dir, not the THREE parent — the book may currently
        // hang inside a structural scheme's group (a jellyfish panel), and the leaf may
        // be parented outside the tree entirely (docked to the camera bar).
        const dir = this.parentOf(book);
        book.parent?.remove(book);
        book.dispose();               // detaches the leaf, frees the page face
        this._leaves.delete(full);
        this._books.delete(full);
        if (prune && dir) this._pruneEmptyUp(dir);
        this._dirty = true;
        return leaf;
    }

    /** Drop empty dir nodes from `node` upward, stopping at the first non-empty (or root).
     *  Markers (bounding prisms, ownership traces) are decorations, not content — and so
     *  are per-pass presentation HUSKS: a library volume whose pages were all just
     *  removed, a jellyfish panel emptied out, the sheet mounts inside them. Those only
     *  dissolve at the NEXT relayout — after the prune moment — so without seeing
     *  through them, clearing a source under a structural scheme left stub dir chains
     *  that the markers faithfully boxed forever (the ghost-prism bug). Durable BOOKS
     *  are never husks: an away-docked leaf's empty book is the stable home the dock
     *  re-attaches to, so its dir must survive. Husks inside a pruned subtree are
     *  disposed here (page faces, covers, panel surfaces are GPU-backed). */
    _pruneEmptyUp(node) {
        const isHusk = (c) => c.userData?.isVolume
            || (c.userData?.isLayoutGroup && !c.userData?.isBook)
            || c.userData?.isBookInternal;
        const isEmpty = (n) => n.children.every((c) =>
            (c.userData && c.userData.isMarker) || (isHusk(c) && isEmpty(c)));
        let cur = node;
        while (cur && cur !== this.root && isEmpty(cur)) {
            const parent = cur.parent;
            for (const child of [...cur.children]) {
                if (child.userData?.isVolume) {
                    if (cur.userData._volume === child) cur.userData._volume = null;
                    child.dispose();
                } else if (child.userData?.isLayoutGroup) {
                    disposePanelSurfaces(child);
                }
            }
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
        if (node === this.root) for (const cb of this._onBeforeRelayout) cb(this);
        this._normalize(node);
        const size = this.layout(node, this.layoutOpts);
        if (node === this.root) {
            this._dirty = false;
            for (const cb of this._onRelayout) cb(this);
        }
        return size;
    }

    /**
     * Normalize a subtree back to its canonical form before a layout pass, so the active
     * scheme always starts from the same structure and switching lenses stays lossless:
     *
     *   1. Dissolve layout-inserted grouping nodes (the jellyfish scheme's page/row
     *      VStacks, tagged userData.isLayoutGroup), re-homing their path-bearing units
     *      (the BOOKS) back onto their directory node and dropping the empty containers.
     *      The wrap is idempotent (jellyfish re-packs fresh each pass) and reversible.
     *   2. Release every Book to its natural form (identity scale, leaf re-seated, page
     *      face dropped) — books are DURABLE (never dissolved); only their form resets,
     *      so the next scheme reads the canonical content and re-applies its own form.
     *
     * Leaves parented OUTSIDE the tree (e.g. docked to the camera bar) are never reached —
     * their books stay in the tree, empty, as the stable home the dock re-attaches to.
     * @private
     */
    _normalize(node = this.root) {
        const visit = (dir) => {
            for (const child of [...dir.children]) {
                if (child.userData?.isLayoutGroup) {
                    // gather the group's path-bearing unit descendants, re-home them onto
                    // `dir` — descending book INTERNALS too, so a library VOLUME (a Book
                    // whose sheets carry the dir's file books) gives its pages back.
                    const units = [];
                    const gather = (g) => {
                        for (const c of g.children) {
                            if (c.userData?.isLayoutGroup || c.userData?.isBookInternal) gather(c);
                            else if (c.userData?.path !== undefined) units.push(c);
                        }
                    };
                    gather(child);
                    for (const unit of units) dir.add(unit);   // THREE.add re-parents (row → dir)
                    if (child.userData.isVolume) {
                        // The open page survives the pass on the dir node; the volume itself
                        // is a per-pass presentation object — dispose, don't keep.
                        dir.userData.volumeHead = child.head;
                        dir.userData.volumeFollowing = child.following;
                        if (dir.userData._volume === child) dir.userData._volume = null;
                        child.dispose();
                    } else {
                        disposePanelSurfaces(child);   // free the panels' backing-face geometries first
                    }
                    dir.remove(child);
                } else if (child.userData?.isDir) {
                    visit(child);
                }
            }
        };
        visit(node);
        node.traverse((o) => { if (o.userData?.isBook) o.release(); });
    }

    /**
     * The one relayout entry point callers should use after any content/footprint change
     * (insert, remove, a grid's render-style/window change): re-lay the tree and re-settle
     * it on the world floor. Replaces the old flat `flowLayout(getGrids())` reflows.
     * Inside a batchRelayouts window the call is RECORDED, not run — the window settles
     * once at close, so a launch-shaped burst (N sources, K tabs, each politely calling
     * this) pays one relayout + one overlay rebuild instead of N+K.
     * @param {number} [floorY=0] the world floor to rest content above
     */
    relayoutAndRest(floorY = 0) {
        if (this._holdDepth > 0) { this._heldRest = floorY; return this; }
        this.relayout();
        this.restAbove(floorY);
        return this;
    }

    /**
     * Run `fn` with relayouts HELD: every relayoutAndRest inside the window coalesces
     * into ONE settle when the outermost window closes (the last floorY wins — callers
     * agree on the world floor anyway). Re-entrant; a window that never requested a
     * rest settles nothing. This is removeGrids' batch discipline given to the LOAD
     * side: session restore wraps its source and tab loops in one window each.
     * @template T @param {() => Promise<T>|T} fn @returns {Promise<T>}
     */
    async batchRelayouts(fn) {
        this._holdDepth = (this._holdDepth || 0) + 1;
        try {
            return await fn();
        } finally {
            if (--this._holdDepth === 0 && this._heldRest !== undefined) {
                const floorY = this._heldRest;
                this._heldRest = undefined;
                this.relayoutAndRest(floorY);
            }
        }
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

    /** The tree's LOCAL content box (root frame) — every leaf's box carried through the intermediate dir
     *  transforms. So a WorldLayout can measure the file tree as a bounds-leaf (via root.layoutBounds). */
    getLocalBounds(target = new THREE.Box3()) {
        return subtreeContentBounds(this.root, target, false);   // tight content box (no origin union)
    }

    /**
     * World-space AABB of all content — for ground anchoring etc. Unions each BOOK's
     * world box (BoundedObject3D.getBounds): the bound form when fitted (the page),
     * the leaf's content box when released — and leafBox's userData.size fallback
     * covers geometry-less leaves, so one path serves real grids and mocks alike.
     * Books riding a library VOLUME are measured by the volume instead (its live deck
     * box IS their bound form — the field rests on the floor by its pages).
     */
    getWorldBounds(target = new THREE.Box3()) {
        target.makeEmpty();
        this.root.updateWorldMatrix(true, true);
        const tmp = new THREE.Box3();
        const inVolume = (bk) => {
            for (let n = bk.parent; n && n !== this.root; n = n.parent) {
                if (n.userData?.isVolume) return true;
            }
            return false;
        };
        for (const book of this._books.values()) {
            if (inVolume(book)) continue;
            const b = book.getBounds(tmp);
            if (b && !b.isEmpty()) target.union(b);
        }
        for (const vol of this.volumes()) {
            const b = vol.getBounds(tmp);
            if (b && !b.isEmpty()) target.union(b);
        }
        return target;
    }
}

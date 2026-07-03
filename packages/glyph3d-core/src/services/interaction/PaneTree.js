/**
 * PaneTree — a pure binary space-partitioning (BSP) tree for tiling a bounded rect
 * into panes. The compositor substrate: the CameraDock's view-frame is the root rect,
 * each LEAF binds one window (a registry id), each SPLIT cuts a rect in two.
 *
 * This is the bspwm model (verified prior art): a split is fully described by an AXIS
 * ('x' = side-by-side, first=left; 'y' = stacked, first=TOP since +y is up) and a
 * RATIO in (0,1) — the first child's fraction of that axis. Every node has exactly 0
 * children (a leaf) or 2 (a split); windows live ONLY in leaves. That minimal per-node
 * state maps losslessly onto a normalized [0,1] rect tree (see {@link PaneTree#rects}),
 * which the controller multiplies into world-space frame sub-rects.
 *
 * PURE: no THREE, no DOM, plain-data nodes. It owns topology + geometry + focus queries;
 * the controller owns which id is focused and the world placement. i3's tabbed/stacked
 * (overflow render-modes) and Niri's infinite strip are deliberately NOT modeled — a
 * bounded frame resize-propagates (adjusting one split redistributes its two children),
 * which is exactly what proportional ratios give for free.
 *
 * Nodes are plain objects so the whole tree serializes as-is:
 *   leaf:  { leaf: <windowId> }
 *   split: { split: 'x'|'y', ratio: <0..1>, first: <Node>, second: <Node> }
 *
 * @typedef {{leaf:string}} LeafNode
 * @typedef {{split:'x'|'y', ratio:number, first:Node, second:Node}} SplitNode
 * @typedef {LeafNode|SplitNode} Node
 * @typedef {{x:number,y:number,w:number,h:number}} Rect
 */

const MIN_RATIO = 0.05; // a split never collapses a child below this fraction (genuine-breakage clamp)

const isLeaf = (n) => n && typeof n.leaf === 'string';
const clampRatio = (r) => Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, r));

export class PaneTree {
    /** @param {Node} root */
    constructor(root) {
        /** @type {Node} */
        this.root = root;
    }

    /** A fresh single-leaf tree bound to `windowId`. @param {string} windowId */
    static leaf(windowId) { return new PaneTree({ leaf: windowId }); }

    /** Rebuild from a serialized tree (deep-cloned so the caller's data isn't aliased). */
    static deserialize(obj) { return new PaneTree(JSON.parse(JSON.stringify(obj))); }

    // ===================== queries =====================

    /** @returns {boolean} true when the tree holds no windows at all. */
    isEmpty() { return !this.root; }

    /** @param {string} windowId @returns {boolean} */
    has(windowId) { return this._find(windowId) !== null; }

    /** @returns {number} leaf count. */
    count() { return this.leaves().length; }

    /** @returns {string[]} every bound windowId, left-to-right / top-to-bottom (in-order). */
    leaves() {
        const out = [];
        const walk = (n) => { if (!n) return; if (isLeaf(n)) out.push(n.leaf); else { walk(n.first); walk(n.second); } };
        walk(this.root);
        return out;
    }

    /**
     * Locate a leaf: its node, its parent split (or null at root), and which side it is.
     * @param {string} windowId @returns {{node:Node, parent:SplitNode|null, side:'first'|'second'|null}|null}
     * @private
     */
    _find(windowId) {
        let found = null;
        const walk = (n, parent, side) => {
            if (found || !n) return;
            if (isLeaf(n)) { if (n.leaf === windowId) found = { node: n, parent, side }; return; }
            walk(n.first, n, 'first');
            walk(n.second, n, 'second');
        };
        walk(this.root, null, null);
        return found;
    }

    // ===================== mutations =====================

    /**
     * Split the pane holding `windowId` in two, inserting `newWindowId` beside it.
     * The existing pane keeps its slot; the new pane takes the other half (default 50/50,
     * `after` = new pane is right/below). Mirrors tmux split-window / i3 split.
     * @param {string} windowId  the leaf to split (must exist)
     * @param {'x'|'y'} axis     'x' = side-by-side, 'y' = stacked
     * @param {string} newWindowId
     * @param {{ratio?:number, before?:boolean}} [opts] ratio = FIRST child's fraction; before = new pane first
     * @returns {boolean} true if it split (false if windowId not found or newWindowId already present)
     */
    split(windowId, axis, newWindowId, { ratio = 0.5, before = false } = {}) {
        if (axis !== 'x' && axis !== 'y') return false;
        if (this.has(newWindowId)) return false;
        const hit = this._find(windowId);
        if (!hit) return false;

        const existing = { leaf: windowId };
        const inserted = { leaf: newWindowId };
        const node = /** @type {SplitNode} */ (hit.node);
        node.split = axis;
        node.ratio = clampRatio(ratio);
        node.first = before ? inserted : existing;
        node.second = before ? existing : inserted;
        delete node.leaf; // the leaf became a split — drop the leaf binding
        return true;
    }

    /**
     * Remove the pane holding `windowId`; its sibling collapses up into the parent's slot
     * (ratios preserved for the rest of the tree). Removing the root leaf empties the tree.
     * @param {string} windowId
     * @returns {string|null} a sensible next-focus windowId (the collapsed sibling's first
     *   leaf), or null if the tree is now empty / windowId wasn't found.
     */
    close(windowId) {
        const hit = this._find(windowId);
        if (!hit) return null;
        if (!hit.parent) { this.root = null; return null; } // was the root leaf

        const sibling = hit.side === 'first' ? hit.parent.second : hit.parent.first;
        // Overwrite the parent split IN PLACE with the sibling's contents (keeps references stable).
        for (const k of ['leaf', 'split', 'ratio', 'first', 'second']) delete hit.parent[k];
        Object.assign(hit.parent, sibling);
        return this._firstLeaf(hit.parent);
    }

    /**
     * Grow (or shrink) the pane holding `windowId` along `axis` by `delta` (a fraction).
     * Walks to the nearest ancestor split on that axis and nudges its ratio toward the
     * leaf's side — the proportional resize a bounded frame wants (siblings give up space).
     * @param {string} windowId @param {'x'|'y'} axis @param {number} delta (+ grows the pane)
     * @returns {boolean} true if a split on that axis was found and adjusted
     */
    resize(windowId, axis, delta) {
        // Nearest ancestor split on `axis` (the chain is leaf→root, so the first match is nearest).
        // side 'first' owns `ratio`, so it grows by +delta; 'second' owns 1-ratio, so it grows by -delta.
        for (const { parent, side } of this._ancestors(windowId)) {
            if (parent.split === axis) {
                parent.ratio = clampRatio(parent.ratio + (side === 'first' ? delta : -delta));
                return true;
            }
        }
        return false;
    }

    /**
     * Exchange the windows bound to two leaves — positions unchanged, contents swap
     * (tmux swap-pane). @param {string} a @param {string} b @returns {boolean}
     */
    swap(a, b) {
        const ha = this._find(a), hb = this._find(b);
        if (!ha || !hb || a === b) return false;
        ha.node.leaf = b;
        hb.node.leaf = a;
        return true;
    }

    // ===================== layout & focus =====================

    /**
     * The layout pass: partition `rect` down the tree into one rect per leaf. Rects use a
     * y-UP convention ((x,y) = min corner, +y up), so 'y' splits put the FIRST child on top.
     * The controller multiplies these normalized rects into the world-space view-frame.
     * @param {Rect} [rect] defaults to the unit rect
     * @returns {Map<string, Rect>} windowId → its rect
     */
    rects(rect = { x: 0, y: 0, w: 1, h: 1 }) {
        const out = new Map();
        const walk = (n, r) => {
            if (!n) return;
            if (isLeaf(n)) { out.set(n.leaf, r); return; }
            const [ra, rb] = this._cut(r, n.split, n.ratio);
            walk(n.first, ra);
            walk(n.second, rb);
        };
        walk(this.root, rect);
        return out;
    }

    /**
     * Directional focus: the leaf nearest to `windowId`'s rect in `dir`, chosen geometrically
     * (i3's "nearest container in the given direction"). Evaluated on the normalized rect tree,
     * so it's camera-independent; the controller runs it in the frame's own plane.
     * @param {string} windowId @param {'left'|'right'|'up'|'down'} dir
     * @returns {string|null} the neighbor's windowId, or null if none lies that way
     */
    neighbor(windowId, dir) {
        const rects = this.rects();
        const from = rects.get(windowId);
        if (!from) return null;
        const fc = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
        // primary axis + the sign that counts as "in the direction" (y is up).
        const horiz = dir === 'left' || dir === 'right';
        const sign = (dir === 'right' || dir === 'up') ? 1 : -1;

        let best = null, bestScore = Infinity;
        for (const [id, r] of rects) {
            if (id === windowId) continue;
            const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
            const primary = horiz ? (c.x - fc.x) : (c.y - fc.y);
            if (primary * sign <= 1e-9) continue;                 // must lie in `dir`
            const cross = horiz ? Math.abs(c.y - fc.y) : Math.abs(c.x - fc.x);
            const score = Math.abs(primary) + cross * 2;          // nearest along, penalize lateral drift
            if (score < bestScore) { bestScore = score; best = id; }
        }
        return best;
    }

    // ===================== serialization =====================

    /** @returns {Node} a deep clone of the tree (plain data, safe to persist). */
    serialize() { return this.root ? JSON.parse(JSON.stringify(this.root)) : null; }

    // ===================== internals =====================

    /** Split a rect into [first, second] along `axis` at `ratio`. y-up → 'y' first = top. @private */
    _cut(r, axis, ratio) {
        if (axis === 'x') {
            const w1 = r.w * ratio;
            return [{ x: r.x, y: r.y, w: w1, h: r.h }, { x: r.x + w1, y: r.y, w: r.w - w1, h: r.h }];
        }
        const h1 = r.h * ratio;                                    // first = top (higher y)
        return [{ x: r.x, y: r.y + r.h - h1, w: r.w, h: h1 }, { x: r.x, y: r.y, w: r.w, h: r.h - h1 }];
    }

    /** The leftmost/topmost leaf id under a node (for next-focus after a close). @private */
    _firstLeaf(n) {
        let cur = n;
        while (cur && !isLeaf(cur)) cur = cur.first;
        return cur ? cur.leaf : null;
    }

    /** The ancestor chain [{parent, side}] ordered LEAF→ROOT (nearest split first). @private */
    _ancestors(windowId) {
        const path = [];
        const descend = (n) => {
            if (!n || isLeaf(n)) return isLeaf(n) && n.leaf === windowId;
            if (descend(n.first)) { path.push({ parent: n, side: 'first' }); return true; }
            if (descend(n.second)) { path.push({ parent: n, side: 'second' }); return true; }
            return false;
        };
        descend(this.root);
        return path; // push-on-unwind ⇒ deepest (nearest) parent first
    }
}

export default PaneTree;

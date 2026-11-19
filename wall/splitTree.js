/**
 * splitTree — a split group's panes as a binary tree, as a terminal app's splits are: each node cuts
 * its rect in two, side by side (`row`: a left of b) or stacked (`col`: a above b), `ratio` being a's
 * share of the room left after the gap; each leaf is one terminal. No THREE, no DOM: WallGroups lays
 * the panes out, the pointer drags the dividers and the panes (a pane dropped on another swaps with it,
 * or docks beside it near an edge), the store collapses the tree when a pane goes.
 * Trees are values: every change returns a new tree.
 *
 * Rects are the wall's world rects (wallLayout): y up, so a node's `a` of a `col` is its upper half.
 * A path names a node from the root: `['a', 'b']` is the root's a's b.
 */

/** @typedef {{ id: string }} SplitLeaf */
/** @typedef {{ dir: 'row'|'col', ratio: number, a: SplitNode, b: SplitNode }} SplitBranch */
/** @typedef {SplitLeaf|SplitBranch} SplitNode */
/** @typedef {{ minX: number, maxX: number, minY: number, maxY: number }} Rect */
/** @typedef {('a'|'b')[]} SplitPath */

/** @param {SplitNode} n @returns {n is SplitLeaf} */
const isLeaf = (n) => typeof /** @type {any} */ (n).id === 'string';

/** The terminals in a tree, in reading order (a before b). @param {SplitNode} t @returns {string[]} */
export function leaves(t) {
    return isLeaf(t) ? [t.id] : [...leaves(t.a), ...leaves(t.b)];
}

/**
 * The tree with the leaf `at` cut in two: `at` keeps one half and `id` takes the other — after it
 * (right of it, or below it) unless `side` is 'before'.
 * @param {SplitNode} t @param {string} at @param {string} id @param {'row'|'col'} dir @param {'after'|'before'} [side]
 * @returns {SplitNode}
 */
export function insert(t, at, id, dir, side = 'after') {
    if (isLeaf(t)) {
        if (t.id !== at) return t;
        const keep = { id: at }, born = { id };
        return side === 'before' ? { dir, ratio: 0.5, a: born, b: keep } : { dir, ratio: 0.5, a: keep, b: born };
    }
    return { ...t, a: insert(t.a, at, id, dir, side), b: insert(t.b, at, id, dir, side) };
}

/**
 * The tree without the leaf `id`: its sibling takes its parent's place (and room). Null when the tree
 * was that one leaf.
 * @param {SplitNode} t @param {string} id @returns {SplitNode|null}
 */
export function remove(t, id) {
    if (isLeaf(t)) return t.id === id ? null : t;
    const a = remove(t.a, id), b = remove(t.b, id);
    if (!a) return b;
    if (!b) return a;
    return a === t.a && b === t.b ? t : { ...t, a, b };
}

/**
 * The tree with the leaves `a` and `b` trading places (each takes the other's pane; the cuts stay).
 * @param {SplitNode} t @param {string} a @param {string} b @returns {SplitNode}
 */
export function swap(t, a, b) {
    if (isLeaf(t)) return t.id === a ? { id: b } : t.id === b ? { id: a } : t;
    return { ...t, a: swap(t.a, a, b), b: swap(t.b, a, b) };
}

/** Which side of a pane a dock puts the docked one, as a cut and the side of it. */
const DOCK = /** @type {const} */ ({
    left: { dir: 'row', side: 'before' }, right: { dir: 'row', side: 'after' },
    up: { dir: 'col', side: 'before' }, down: { dir: 'col', side: 'after' },
});

/**
 * The tree with the leaf `id` taken from its pane (its sibling takes the room) and docked beside the
 * leaf `at`: `at`'s pane cut in two, `id` in the half on `side`.
 * @param {SplitNode} t @param {string} id @param {string} at @param {'left'|'right'|'up'|'down'} side
 * @returns {SplitNode}
 */
export function dock(t, id, at, side) {
    const d = DOCK[side];
    if (!d) throw new Error(`a pane docks left, right, up or down, not '${side}'`);
    if (id === at) throw new Error('a pane cannot dock beside itself');
    const rest = remove(t, id);
    if (!rest || !leaves(rest).includes(at)) throw new Error(`no panes '${id}' and '${at}' to dock`);
    return insert(rest, at, id, d.dir, d.side);
}

/** How near a pane's edge (a share of its width or height) a drop docks beside it rather than swapping. */
export const DOCK_EDGE = 0.25;

/**
 * Where a drop at `p` over the pane `r` lands: beside it on the nearest side when within DOCK_EDGE of
 * that edge, else `center` (the two trade places).
 * @param {Rect} r @param {{ x: number, y: number }} p @returns {'left'|'right'|'up'|'down'|'center'}
 */
export function dropZone(r, p) {
    const fx = (p.x - r.minX) / Math.max(1e-9, r.maxX - r.minX), fy = (r.maxY - p.y) / Math.max(1e-9, r.maxY - r.minY);
    /** @type {['left'|'right'|'up'|'down', number][]} */
    const near = [['left', fx], ['right', 1 - fx], ['up', fy], ['down', 1 - fy]];
    let best = near[0];
    for (const n of near) if (n[1] < best[1]) best = n;
    return best[1] < DOCK_EDGE ? best[0] : 'center';
}

/**
 * A tree of these terminals in rows of `columns`, every pane an equal share — what a tiled group
 * becomes as a split.
 * @param {string[]} ids @param {number} columns @returns {SplitNode}
 */
export function fromMembers(ids, columns) {
    if (!ids.length) throw new Error('a split needs at least one terminal');
    /** An even chain: the first takes 1/n, the rest share the remainder the same way. */
    const chain = (nodes, dir) => (nodes.length === 1 ? nodes[0]
        : { dir, ratio: 1 / nodes.length, a: nodes[0], b: chain(nodes.slice(1), dir) });
    const rows = [];
    for (let i = 0; i < ids.length; i += columns) rows.push(chain(ids.slice(i, i + columns).map((id) => ({ id })), 'row'));
    return chain(rows, 'col');
}

/** A node's two halves of `r`, `gap` apart. @param {SplitBranch} n @param {Rect} r @param {number} gap */
function halves(n, r, gap) {
    if (n.dir === 'row') {
        const aw = Math.max(0, r.maxX - r.minX - gap) * n.ratio;
        return [{ ...r, maxX: r.minX + aw }, { ...r, minX: r.minX + aw + gap }];
    }
    const ah = Math.max(0, r.maxY - r.minY - gap) * n.ratio;
    return [{ ...r, minY: r.maxY - ah }, { ...r, maxY: r.maxY - ah - gap }];
}

/**
 * Every pane's rect: the tree laid over `rect`, `gap` between neighbours.
 * @param {SplitNode} t @param {Rect} rect @param {number} gap @returns {Map<string, Rect>}
 */
export function panes(t, rect, gap, out = new Map()) {
    if (isLeaf(t)) { out.set(t.id, rect); return out; }
    const [ra, rb] = halves(t, rect, gap);
    panes(t.a, ra, gap, out);
    panes(t.b, rb, gap, out);
    return out;
}

/**
 * The least room a tree needs, each pane at least `minPane(id)`.
 * @param {SplitNode} t @param {(id: string) => { w: number, h: number }} minPane @param {number} gap
 * @returns {{ w: number, h: number }}
 */
export function minSize(t, minPane, gap) {
    if (isLeaf(t)) return minPane(t.id);
    const a = minSize(t.a, minPane, gap), b = minSize(t.b, minPane, gap);
    return t.dir === 'row' ? { w: a.w + gap + b.w, h: Math.max(a.h, b.h) } : { w: Math.max(a.w, b.w), h: a.h + gap + b.h };
}

/** The node at `path`. @param {SplitNode} t @param {SplitPath} path @returns {SplitNode} */
function nodeAt(t, path) {
    let n = t;
    for (const k of path) {
        if (isLeaf(n)) throw new Error(`no split node at ${path.join('.')}`);
        n = n[k];
    }
    return n;
}

/** The rect the node at `path` lays out in. @param {SplitNode} t @param {Rect} rect @param {number} gap @param {SplitPath} path */
function rectAt(t, rect, gap, path) {
    let n = t, r = rect;
    for (const k of path) {
        if (isLeaf(n)) throw new Error(`no split node at ${path.join('.')}`);
        const [ra, rb] = halves(n, r, gap);
        r = k === 'a' ? ra : rb;
        n = n[k];
    }
    return r;
}

/**
 * Every divider: the gap each branch leaves between its halves — its path, the axis it moves along
 * (`x` for a row's upright divider, `y` for a col's level one), and its band.
 * @param {SplitNode} t @param {Rect} rect @param {number} gap
 * @returns {{ path: SplitPath, axis: 'x'|'y', band: Rect }[]}
 */
function dividers(t, rect, gap, path = [], out = []) {
    if (isLeaf(t)) return out;
    const [ra, rb] = halves(t, rect, gap);
    out.push(t.dir === 'row'
        ? { path, axis: 'x', band: { minX: ra.maxX, maxX: rb.minX, minY: rect.minY, maxY: rect.maxY } }
        : { path, axis: 'y', band: { minX: rect.minX, maxX: rect.maxX, minY: rb.maxY, maxY: ra.minY } });
    dividers(t.a, ra, gap, [...path, 'a'], out);
    dividers(t.b, rb, gap, [...path, 'b'], out);
    return out;
}

/**
 * The divider under a point, widened by `tol` across it (a gap is thin) — the deepest one first, so
 * a nested divider wins where it meets its parent's.
 * @param {SplitNode} t @param {Rect} rect @param {number} gap @param {{ x: number, y: number }} p @param {number} tol
 */
export function dividerAt(t, rect, gap, p, tol) {
    const all = dividers(t, rect, gap).sort((a, b) => b.path.length - a.path.length);
    for (const d of all) {
        const b = d.band;
        const across = d.axis === 'x' ? p.x >= b.minX - tol && p.x <= b.maxX + tol : p.y >= b.minY - tol && p.y <= b.maxY + tol;
        const along = d.axis === 'x' ? p.y >= b.minY && p.y <= b.maxY : p.x >= b.minX && p.x <= b.maxX;
        if (across && along) return d;
    }
    return null;
}

/** The tree with the node at `path` given `ratio`. @param {SplitNode} t @param {SplitPath} path @param {number} ratio @returns {SplitNode} */
export function setRatio(t, path, ratio) {
    if (!path.length) {
        if (isLeaf(t)) throw new Error('a pane has no divider');
        return { ...t, ratio };
    }
    if (isLeaf(t)) throw new Error(`no split node at ${path.join('.')}`);
    const [k, ...rest] = path;
    return { ...t, [k]: setRatio(t[k], rest, ratio) };
}

/**
 * The ratio a divider takes when dragged to `coord` (x for a row, y for a col): the divider's centre
 * there, held so each side keeps its minSize.
 * @param {SplitNode} t @param {Rect} rect @param {number} gap @param {SplitPath} path @param {number} coord
 * @param {(id: string) => { w: number, h: number }} minPane
 */
export function ratioFor(t, rect, gap, path, coord, minPane) {
    const n = nodeAt(t, path);
    if (isLeaf(n)) throw new Error('a pane has no divider');
    const r = rectAt(t, rect, gap, path);
    const a = minSize(n.a, minPane, gap), b = minSize(n.b, minPane, gap);
    const row = n.dir === 'row';
    const room = Math.max(1e-9, row ? r.maxX - r.minX - gap : r.maxY - r.minY - gap);
    const share = row ? coord - gap / 2 - r.minX : r.maxY - coord - gap / 2;
    const lo = (row ? a.w : a.h) / room, hi = 1 - (row ? b.w : b.h) / room;
    return lo > hi ? n.ratio : Math.min(hi, Math.max(lo, share / room));
}

/**
 * The pane next to `id` in a direction: the nearest one beyond that edge that overlaps it across,
 * the most overlap breaking a tie. Null at the split's edge.
 * @param {Map<string, Rect>} ps @param {string} id @param {'left'|'right'|'up'|'down'} dir
 * @returns {string|null}
 */
export function neighbor(ps, id, dir) {
    const r = ps.get(id);
    if (!r) return null;
    const eps = 1e-6;
    let best = null, bestGap = Infinity, bestOverlap = -1;
    for (const [other, o] of ps) {
        if (other === id) continue;
        let gap, overlap;
        if (dir === 'right' || dir === 'left') {
            gap = dir === 'right' ? o.minX - r.maxX : r.minX - o.maxX;
            overlap = Math.min(r.maxY, o.maxY) - Math.max(r.minY, o.minY);
        } else {
            gap = dir === 'down' ? r.minY - o.maxY : o.minY - r.maxY;
            overlap = Math.min(r.maxX, o.maxX) - Math.max(r.minX, o.minX);
        }
        if (gap < -eps || overlap <= eps) continue;
        if (gap < bestGap - eps || (Math.abs(gap - bestGap) <= eps && overlap > bestOverlap)) { best = other; bestGap = gap; bestOverlap = overlap; }
    }
    return best;
}

/**
 * Check a tree against a group's members: every node well formed, every member a leaf exactly once.
 * @param {any} t @param {string[]} members @returns {SplitNode} t
 */
export function checkTree(t, members) {
    const walk = (n) => {
        if (n && typeof n.id === 'string') return;
        if (!n || (n.dir !== 'row' && n.dir !== 'col')) throw new Error(`a split node is a pane {id} or {dir: row|col, ratio, a, b}, not ${JSON.stringify(n)}`);
        if (!(n.ratio > 0 && n.ratio < 1)) throw new Error(`a split's ratio is between 0 and 1, not ${n.ratio}`);
        walk(n.a); walk(n.b);
    };
    walk(t);
    const ids = leaves(t);
    if (new Set(ids).size !== ids.length) throw new Error(`a split holds a terminal twice: ${ids.join(' ')}`);
    if (ids.length !== members.length || ids.some((id) => !members.includes(id))) {
        throw new Error(`a split's panes (${ids.join(' ')}) are not its members (${members.join(' ')})`);
    }
    return t;
}

/**
 * wallLayout — the pure geometry of the wall: where a new terminal lands, how the camera frames a
 * rect, which edge of a terminal a pointer is grabbing, focus cycling, how a group tiles its members,
 * which terminals a lasso touches, and where a dropped tile goes. No THREE, no DOM: rects
 * are plain `{ minX, minY, maxX, maxY }` in world units (y up), so this is testable headless.
 */

/** World units between neighbouring terminals in the flow layout — room for a title bar (TitleBar caps at 80% of it). */
export const FLOW_GAP = 12;
/** Terminals per row before the flow wraps. */
export const FLOW_COLUMNS = 3;
/** The most world height a title bar takes above its terminal (TitleBar caps there) — the room a tiled
 *  row leaves above each body. */
export const BAR_ROOM = FLOW_GAP * 0.8;
/** World Z of a fullscreen terminal — well above the canvas stack and inside the ortho camera's z = 500. */
export const FULLSCREEN_Z = 460;
const Z_BASE = 2;
const Z_MAX_STACK = 420;
const Z_AIR = 1.5;
const Z_MIN_AIR = 0.25;

/**
 * @typedef {{ minX: number, minY: number, maxX: number, maxY: number }} Rect
 */

/** @param {Rect} a @param {Rect} b @returns {boolean} */
export function overlaps(a, b) {
    return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

/**
 * The first free flow slot for a new terminal of size (w, h): slots are a FLOW_COLUMNS-wide grid
 * of (w + gap) × (h + gap) cells, top-left at the origin, scanned row-major. A slot is free when it
 * overlaps no existing terminal — so terminals the person moved stay put and new ones flow around
 * them. Returns the slot's top-left corner.
 * @param {number} w @param {number} h @param {Rect[]} taken
 * @returns {{ x: number, y: number }}
 */
export function freeFlowSlot(w, h, taken) {
    for (let i = 0; i < 10_000; i++) {
        const col = i % FLOW_COLUMNS;
        const row = Math.floor(i / FLOW_COLUMNS);
        const x = col * (w + FLOW_GAP);
        const y = 0 - row * (h + FLOW_GAP);   // 0 − …, not −…: row 0 must be +0, not −0
        const slot = { minX: x, maxX: x + w, minY: y - h, maxY: y };
        if (!taken.some((t) => overlaps(slot, t))) return { x, y };
    }
    throw new Error('[wall] no free flow slot in 10k candidates — the taken list is malformed');
}

/**
 * Camera placement that fits `rect` inside a viewport of (viewW × viewH) CSS px.
 * @param {Rect} rect @param {number} viewW @param {number} viewH
 * @param {number} [margin=0.94] - fraction of the viewport the rect may fill
 * @param {number} [maxZoom=Infinity] - zoom ceiling: fit, but never magnify past this (a small
 *   rect frames at a readable size, centred, instead of ballooning to fill the screen)
 * @returns {{ x: number, y: number, zoom: number }} zoom = CSS px per world unit
 */
export function fitRect(rect, viewW, viewH, margin = 0.94, maxZoom = Infinity) {
    const w = Math.max(rect.maxX - rect.minX, 1e-6);
    const h = Math.max(rect.maxY - rect.minY, 1e-6);
    return {
        x: (rect.minX + rect.maxX) / 2,
        y: (rect.minY + rect.maxY) / 2,
        zoom: Math.min(Math.min(viewW / w, viewH / h) * margin, maxZoom),
    };
}

/** @param {Rect[]} rects @returns {Rect|null} */
export function unionRect(rects) {
    if (!rects.length) return null;
    return rects.reduce((u, r) => ({
        minX: Math.min(u.minX, r.minX), minY: Math.min(u.minY, r.minY),
        maxX: Math.max(u.maxX, r.maxX), maxY: Math.max(u.maxY, r.maxY),
    }));
}

/**
 * Which edges of `rect` the world point (x, y) is grabbing, within `tol` world units on either
 * side of the border. Corners grab two edges. Null when the point is not on the border band.
 * @param {Rect} rect @param {number} x @param {number} y @param {number} tol
 * @returns {{ left: boolean, right: boolean, top: boolean, bottom: boolean }|null}
 */
export function edgesAt(rect, x, y, tol) {
    const inX = x > rect.minX - tol && x < rect.maxX + tol;
    const inY = y > rect.minY - tol && y < rect.maxY + tol;
    if (!inX || !inY) return null;
    const left = Math.abs(x - rect.minX) < tol;
    const right = Math.abs(x - rect.maxX) < tol;
    const top = Math.abs(y - rect.maxY) < tol;
    const bottom = Math.abs(y - rect.minY) < tol;
    if (!left && !right && !top && !bottom) return null;
    return { left, right: right && !left, top, bottom: bottom && !top };
}

/**
 * What's under the world point (x, y), given the terminals in STACKING order (topmost first): the
 * first terminal that claims the point wins, and a terminal claims it by its border band (edges,
 * up to `tol` outside), its title bar (the window above the body), or its body. Each terminal is
 * tested whole before the one beneath it — so a terminal on top keeps its body even where another
 * terminal's border band reaches under it.
 * @param {{ id: string, window: Rect, body: Rect }[]} stack - topmost first; `window` = body + title bar
 * @param {number} x @param {number} y @param {number} tol - border band half-width, world units
 * @returns {{ id: string, part: 'edge'|'title'|'body', edges?: { left: boolean, right: boolean, top: boolean, bottom: boolean } }|null}
 */
export function hitTest(stack, x, y, tol) {
    for (const { id, window: w, body } of stack) {
        const edges = edgesAt(w, x, y, tol);
        if (edges) return { id, part: 'edge', edges };
        if (x < w.minX || x > w.maxX || y < w.minY || y > w.maxY) continue;
        return { id, part: y > body.maxY ? 'title' : 'body' };
    }
    return null;
}

/** The CSS cursor for a set of grabbed edges. @param {{left,right,top,bottom}} e @returns {string} */
export function edgeCursor(e) {
    if ((e.left && e.top) || (e.right && e.bottom)) return 'nwse-resize';
    if ((e.right && e.top) || (e.left && e.bottom)) return 'nesw-resize';
    if (e.left || e.right) return 'ew-resize';
    return 'ns-resize';
}

/**
 * Cycle through `order` from `current` by `dir` (+1 / −1), wrapping. No current (or a current that
 * left the order) starts at the first item going forward, the last going back.
 * @param {string[]} order @param {string|null} current @param {number} dir
 * @returns {string|null}
 */
export function cycle(order, current, dir) {
    if (!order.length) return null;
    const i = current == null ? -1 : order.indexOf(current);
    if (i < 0) return dir > 0 ? order[0] : order[order.length - 1];
    return order[(i + dir + order.length) % order.length];
}

/**
 * Keep each group's members contiguous in back-to-front `zOrder`, anchored at that group's frontmost
 * member (preserving relative member order within the group), so a group and its GroupFrame occupy one
 * coherent slice of the Z-stack.
 * @param {string[]} zOrder - back to front
 * @param {((id: string) => string|null)|null} [groupOf]
 * @returns {string[]}
 */
export function normalizeZOrder(zOrder, groupOf = null) {
    if (!groupOf || zOrder.length <= 1) return [...zOrder];
    /** @type {Map<string, string[]>} */
    const byGroup = new Map();
    for (const id of zOrder) {
        const g = groupOf(id);
        if (!g) continue;
        let list = byGroup.get(g);
        if (!list) { list = []; byGroup.set(g, list); }
        list.push(id);
    }
    if (!byGroup.size) return [...zOrder];
    const seen = new Set();
    const rev = [];
    for (let i = zOrder.length - 1; i >= 0; i--) {
        const id = zOrder[i];
        const g = groupOf(id);
        if (!g) {
            rev.push(id);
        } else if (!seen.has(g)) {
            seen.add(g);
            const members = byGroup.get(g);
            for (let k = members.length - 1; k >= 0; k--) rev.push(members[k]);
        }
    }
    return rev.reverse();
}

/**
 * Unified Z-stack layout for terminals AND group frames (`backdrop` at `groupZ`, `header` at
 * `groupZ + 0.2..0.22`): each group's frame sits immediately behind its own backmost member and
 * strictly in front of any older terminal or group beneath it, while each terminal clears its own
 * `-0.5 * scaleZ` background and `+0.05 * scaleZ` cursor/label sandwich.
 * @param {string[]} zOrder - back to front
 * @param {{ fullscreenId?: string|null, scaleOf?: ((id: string) => number)|null, groupOf?: ((id: string) => string|null)|null }} [o]
 * @returns {{ order: string[], terminals: Map<string, number>, groups: Map<string, number> }}
 */
export function zStackLayout(zOrder, { fullscreenId = null, scaleOf = null, groupOf = null } = {}) {
    const order = normalizeZOrder(zOrder, groupOf);
    const terminals = new Map();
    const groups = new Map();
    /** @type {{ kind: 'group'|'terminal', id: string, back: number, front: number }[]} */
    const slices = [];
    const seenGroups = new Set();
    for (const id of order) {
        const gid = groupOf ? groupOf(id) : null;
        if (gid && !seenGroups.has(gid)) {
            seenGroups.add(gid);
            slices.push({ kind: 'group', id: gid, back: 0, front: 0.25 });
        }
        if (id === fullscreenId) {
            terminals.set(id, FULLSCREEN_Z);
        } else {
            const sz = Math.max(1, Math.abs(scaleOf ? scaleOf(id) : 2) || 2);
            slices.push({ kind: 'terminal', id, back: 0.5 * sz, front: 0.05 * sz });
        }
    }
    if (!slices.length) return { order, terminals, groups };
    const bodySum = slices.reduce((acc, s) => acc + s.back + s.front, 0);
    const gaps = Math.max(1, slices.length - 1);
    const air = bodySum + gaps * Z_AIR <= Z_MAX_STACK
        ? Z_AIR
        : Math.max(Z_MIN_AIR, (Z_MAX_STACK - bodySum) / gaps);
    let cursor = Z_BASE;
    for (const s of slices) {
        const z = cursor + s.back;
        if (s.kind === 'group') groups.set(s.id, z);
        else terminals.set(s.id, z);
        cursor = z + s.front + air;
    }
    return { order, terminals, groups };
}

/**
 * World Z for each terminal in back-to-front `zOrder`, accounting for each terminal's `scale.z`
 * (default 2: `terminal.create`'s `gridScale = 2.0`) and optional `groupOf` frame slices.
 * @param {string[]} zOrder - back to front
 * @param {string|null} [fullscreenId]
 * @param {((id: string) => number)|null} [scaleOf]
 * @param {((id: string) => string|null)|null} [groupOf]
 * @returns {Map<string, number>}
 */
export function zPositions(zOrder, fullscreenId = null, scaleOf = null, groupOf = null) {
    return zStackLayout(zOrder, { fullscreenId, scaleOf, groupOf }).terminals;
}

/**
 * Sort `{ id, rect }` items in reading order: horizontal row bands from top to bottom (an item joins
 * the current band while it vertically overlaps at least half of the shorter of the item and the band),
 * and left to right (`minX` ascending) within each band.
 * @param {{ id: string, rect: Rect }[]} items
 * @returns {string[]}
 */
export function readingOrder(items) {
    if (items.length <= 1) return items.map((x) => x.id);
    const byTop = [...items].sort((a, b) => (b.rect.maxY - a.rect.maxY) || (a.rect.minX - b.rect.minX));
    /** @type {{ minY: number, maxY: number, list: { id: string, rect: Rect }[] }[]} */
    const bands = [];
    for (const it of byTop) {
        const r = it.rect, h = Math.max(0, r.maxY - r.minY);
        const cur = bands[bands.length - 1];
        const bh = cur ? Math.max(0, cur.maxY - cur.minY) : 0;
        const overlap = cur ? Math.min(cur.maxY, r.maxY) - Math.max(cur.minY, r.minY) : -1;
        if (cur && overlap >= 0.5 * Math.min(h, bh)) {
            cur.minY = Math.min(cur.minY, r.minY);
            cur.maxY = Math.max(cur.maxY, r.maxY);
            cur.list.push(it);
        } else {
            bands.push({ minY: r.minY, maxY: r.maxY, list: [it] });
        }
    }
    const out = [];
    for (const b of bands) {
        b.list.sort((x, y) => (x.rect.minX - y.rect.minX) || (y.rect.maxY - x.rect.maxY));
        for (const it of b.list) out.push(it.id);
    }
    return out;
}

/**
 * New (cols, rows) and position shift for a border drag. Dragging the right/bottom edge grows the
 * terminal away from its top-left origin; dragging the left/top edge grows it toward the pointer,
 * so the position moves by the cells added to keep the opposite edge still.
 * @param {{ left, right, top, bottom }} edges
 * @param {{ cols: number, rows: number }} start
 * @param {{ x: number, y: number }} stride - world units per cell
 * @param {number} dx @param {number} dy - pointer travel in world units (y up)
 * @param {{ minCols: number, minRows: number }} min
 * @returns {{ cols: number, rows: number, shiftX: number, shiftY: number }}
 */
export function resizeFromDrag(edges, start, stride, dx, dy, min) {
    let cols = start.cols;
    let rows = start.rows;
    if (edges.right) cols = start.cols + dx / stride.x;
    if (edges.left) cols = start.cols - dx / stride.x;
    if (edges.bottom) rows = start.rows - dy / stride.y;
    if (edges.top) rows = start.rows + dy / stride.y;
    cols = Math.max(min.minCols, Math.round(cols));
    rows = Math.max(min.minRows, Math.round(rows));
    return {
        cols,
        rows,
        shiftX: edges.left ? -(cols - start.cols) * stride.x : 0,
        shiftY: edges.top ? (rows - start.rows) * stride.y : 0,
    };
}

/**
 * A tiled group's places: `columns` columns, row-major, packed edge to edge `gap` apart. A column is
 * as wide as its widest member, a row as tall as its tallest window (body + `barRoom` for its title
 * bar), so members of any size line up in a table. `origin` is the top-left of the first window
 * (its bar's top). Returns each member's BODY top-left, in member order, and the tiling's extent
 * (windows, bars included).
 * @param {{ w: number, h: number }[]} sizes - each member's body size, world units
 * @param {{ origin: { x: number, y: number }, columns: number, gap: number, barRoom?: number }} o
 * @returns {{ places: { x: number, y: number }[], extent: Rect|null }}
 */
export function tileLayout(sizes, { origin, columns, gap, barRoom = BAR_ROOM }) {
    if (!Number.isInteger(columns) || columns < 1) throw new Error(`[wall] tileLayout: columns must be a positive integer, got ${columns}`);
    if (!(gap >= 0)) throw new Error(`[wall] tileLayout: gap must be ≥ 0, got ${gap}`);
    if (!sizes.length) return { places: [], extent: null };
    const cols = Math.min(columns, sizes.length);
    const rows = Math.ceil(sizes.length / cols);
    const colW = new Array(cols).fill(0);
    const rowH = new Array(rows).fill(0);
    sizes.forEach(({ w, h }, i) => {
        const c = i % cols, r = Math.floor(i / cols);
        colW[c] = Math.max(colW[c], w);
        rowH[r] = Math.max(rowH[r], h + barRoom);
    });
    const xs = [origin.x], ys = [origin.y];
    for (let c = 1; c < cols; c++) xs.push(xs[c - 1] + colW[c - 1] + gap);
    for (let r = 1; r < rows; r++) ys.push(ys[r - 1] - rowH[r - 1] - gap);
    const places = sizes.map((_, i) => ({ x: xs[i % cols], y: ys[Math.floor(i / cols)] - barRoom }));
    return {
        places,
        extent: { minX: origin.x, maxX: xs[cols - 1] + colW[cols - 1], maxY: origin.y, minY: ys[rows - 1] - rowH[rows - 1] },
    };
}

/**
 * Which tile a dropped member belongs in: the index of the place whose centre is nearest the drop
 * point (the member's window centre where it was let go).
 * @param {{ x: number, y: number }[]} centres - each tile's centre, member order
 * @param {{ x: number, y: number }} p
 * @returns {number} -1 when there are no tiles
 */
export function nearestPlace(centres, p) {
    let best = -1, bd = Infinity;
    centres.forEach((c, i) => {
        const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
        if (d < bd) { bd = d; best = i; }
    });
    return best;
}

/** Point in polygon (even-odd). @param {{x:number,y:number}[]} poly @param {number} x @param {number} y */
export function pointInPolygon(poly, x, y) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
}

/** Do segments ab and cd cross (touching counts)? */
function segmentsCross(a, b, c, d) {
    const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
    const on = (p, q, r) => Math.min(p.x, q.x) <= r.x && r.x <= Math.max(p.x, q.x) && Math.min(p.y, q.y) <= r.y && r.y <= Math.max(p.y, q.y);
    const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
    if (o1 !== o2 && o3 !== o4) return true;
    return (o1 === 0 && on(a, b, c)) || (o2 === 0 && on(a, b, d)) || (o3 === 0 && on(c, d, a)) || (o4 === 0 && on(c, d, b));
}

/**
 * Does a freeform lasso touch a rect? The lasso is the closed polygon through its points: it
 * touches a rect when its outline crosses the rect, a lasso point lies inside the rect, or the rect
 * lies inside the lasso. A lasso of one point touches what it's in; of none, nothing.
 * @param {{x:number,y:number}[]} poly - world points, in drawing order
 * @param {Rect} r
 * @returns {boolean}
 */
export function lassoTouches(poly, r) {
    if (!poly.length) return false;
    const inRect = (p) => p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY;
    if (poly.some(inRect)) return true;
    if (poly.length < 2) return false;
    const corners = [{ x: r.minX, y: r.minY }, { x: r.maxX, y: r.minY }, { x: r.maxX, y: r.maxY }, { x: r.minX, y: r.maxY }];
    if (poly.length >= 3 && corners.some((c) => pointInPolygon(poly, c.x, c.y))) return true;
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        for (let k = 0; k < 4; k++) if (segmentsCross(a, b, corners[k], corners[(k + 1) % 4])) return true;
    }
    return false;
}

/** Grow a rect by `pad` on every side. @param {Rect} r @param {number} pad @returns {Rect} */
export function padRect(r, pad) {
    return { minX: r.minX - pad, minY: r.minY - pad, maxX: r.maxX + pad, maxY: r.maxY + pad };
}

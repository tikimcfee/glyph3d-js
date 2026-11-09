/**
 * wallLayout — the pure geometry of the wall: where a new terminal lands, how the camera frames a
 * rect, which edge of a terminal a pointer is grabbing, and focus cycling. No THREE, no DOM: rects
 * are plain `{ minX, minY, maxX, maxY }` in world units (y up), so this is testable headless.
 */

/** World units between neighbouring terminals in the flow layout — room for a title bar (TitleBar caps at 80% of it). */
export const FLOW_GAP = 12;
/** Terminals per row before the flow wraps. */
export const FLOW_COLUMNS = 3;

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

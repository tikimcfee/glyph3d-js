/**
 * wallSnap — the drafting grid's pure math: which of its two levels draw at a zoom, the step a drag
 * snaps to, and where a moved or resized terminal lands. No THREE, no DOM; rects are wallLayout's
 * `{ minX, minY, maxX, maxY }` in world units (y up), so this is testable headless.
 *
 * The grid is graph paper: minor lines every `gridMinor` world units, every `gridMajorEvery`th one a
 * major line, all through the world origin. A level whose lines would sit closer than `gridMinPx` CSS
 * px on screen is not drawn — a hard switch, never a fade.
 *
 * THE SNAP RULE. A terminal's size is whole cells (rows × cols of the atlas's cell, which isn't
 * square and isn't the grid's), so a terminal can't have all four edges on lines. What snaps:
 *   move    the body's top-left corner lands on the nearest grid crossing; the size is untouched,
 *           so a terminal whose corner was on the grid keeps its edges' offsets from the lines
 *   resize  the DRAGGED edge goes to the grid line nearest the pointer, and the size is the most
 *           whole cells that keep it AT or INSIDE that line (never past it: it stops short by less
 *           than a cell); the opposite edge stays where it was
 * So left and top edges line up exactly across terminals (they're where moves put them), and a right
 * or bottom edge sits on its line or just inside it — the way a ruled box is drawn on drafting paper
 * with a pen that only steps in characters. The step is the minor spacing while minor lines draw at
 * this zoom, else the major spacing (zoomed out, you snap to the lines you can see).
 */

/**
 * @typedef {{ gridMinor: number, gridMajorEvery: number, gridMinPx: number }} GridSpec
 * @typedef {import('./wallLayout.js').Rect} Rect
 */

/** Floating-point slack when flooring a size to whole cells (a size exactly on a line counts as on it). */
const CELL_EPS = 1e-6;

/**
 * Which levels draw at `zoom` (CSS px per world unit). With `gridMajorEvery` 1 every line is major.
 * @param {GridSpec} g @param {number} zoom
 * @returns {{ minor: boolean, major: boolean, minorPx: number, majorPx: number }} the spacings on screen too
 */
export function gridLevels(g, zoom) {
    const minorPx = g.gridMinor * zoom, majorPx = minorPx * g.gridMajorEvery;
    return { minor: g.gridMajorEvery > 1 && minorPx >= g.gridMinPx, major: majorPx >= g.gridMinPx, minorPx, majorPx };
}

/**
 * The step a drag snaps to at `zoom`: the minor spacing while minor lines draw (or would, with the
 * grid hidden), else the major spacing.
 * @param {GridSpec} g @param {number} zoom @returns {number} world units
 */
export function snapStep(g, zoom) {
    return g.gridMinor * zoom >= g.gridMinPx ? g.gridMinor : g.gridMinor * g.gridMajorEvery;
}

/** The grid line nearest `v`. @param {number} v @param {number} step */
export function snapTo(v, step) {
    return Math.round(v / step) * step + 0;   // + 0: never −0
}

/**
 * Snap a move: the shift that puts `rect`'s top-left corner (minX, maxY) on the nearest crossing.
 * @param {Rect} rect - the body where the drag would put it @param {number} step
 * @returns {{ x: number, y: number }}
 */
export function snapMove(rect, step) {
    return { x: snapTo(rect.minX, step) - rect.minX, y: snapTo(rect.maxY, step) - rect.maxY };
}

/**
 * Snap a border drag (the rule above). Same answer shape as wallLayout.resizeFromDrag, which is the
 * unsnapped drag: new (cols, rows) and the position shift that keeps the opposite edge still.
 * @param {{ left: boolean, right: boolean, top: boolean, bottom: boolean }} edges
 * @param {Rect} rect - the body when the drag started
 * @param {{ cols: number, rows: number }} start - its size then
 * @param {{ x: number, y: number }} stride - world units per cell
 * @param {number} dx @param {number} dy - pointer travel in world units (y up)
 * @param {{ minCols: number, minRows: number }} min
 * @param {number} step - the grid step (snapStep)
 * @returns {{ cols: number, rows: number, shiftX: number, shiftY: number }}
 */
export function snapResize(edges, rect, start, stride, dx, dy, min, step) {
    // What the body is beyond its cells (its panel padding), so a size in cells maps to a rect.
    const padX = (rect.maxX - rect.minX) - start.cols * stride.x;
    const padY = (rect.maxY - rect.minY) - start.rows * stride.y;
    const fit = (room, pad, cell) => Math.floor((room - pad) / cell + CELL_EPS);
    let cols = start.cols, rows = start.rows;
    if (edges.right) cols = fit(snapTo(rect.maxX + dx, step) - rect.minX, padX, stride.x);
    if (edges.left) cols = fit(rect.maxX - snapTo(rect.minX + dx, step), padX, stride.x);
    if (edges.top) rows = fit(snapTo(rect.maxY + dy, step) - rect.minY, padY, stride.y);
    if (edges.bottom) rows = fit(rect.maxY - snapTo(rect.minY + dy, step), padY, stride.y);
    cols = Math.max(min.minCols, cols);
    rows = Math.max(min.minRows, rows);
    return {
        cols,
        rows,
        shiftX: edges.left ? -(cols - start.cols) * stride.x : 0,
        shiftY: edges.top ? (rows - start.rows) * stride.y : 0,
    };
}

/**
 * flowBoxes / squareWrap — the pure box-packing primitives shared by every layout
 * scheme (flat flow, the walk-tree, ContentTree). No three, no DOM, no side effects:
 * sized boxes in → slots + extent out. Lives in core so both the command handlers
 * (app) and the ContentTree layout (core) build on one implementation.
 */

/**
 * Pack sized boxes into a wrapping shelf. Top-aligned per row; wraps when a row
 * would exceed wrapWidth. Returns each box's TOP-LEFT slot (y descends: rows go
 * downward, slot.y <= 0) plus the cluster's total extent.
 *
 * @param {Array<{w:number,h:number}>} sizes
 * @param {{margin?:number, wrapWidth?:number}} [opts]
 * @returns {{slots: Array<{x:number,y:number}>, width:number, height:number, rows:number}}
 */
export function flowBoxes(sizes, { margin = 16, wrapWidth = Infinity } = {}) {
    const slots = [];
    let cx = 0, topY = 0, rowH = 0, rows = 1, maxW = 0;
    for (const s of sizes) {
        if (cx > 0 && cx + s.w > wrapWidth) {
            maxW = Math.max(maxW, cx - margin);
            cx = 0; topY -= rowH + margin; rowH = 0; rows++;
        }
        slots.push({ x: cx, y: topY });
        cx += s.w + margin;
        rowH = Math.max(rowH, s.h);
    }
    maxW = Math.max(maxW, cx - margin);
    return { slots, width: maxW, height: -topY + rowH, rows };
}

/**
 * Wrap width that makes the packed footprint roughly square IN WORLD UNITS — not
 * in box count. Code files are much wider than tall, so a sqrt(n)-column grid
 * comes out very wide; aspect-correcting (cols ∝ sqrt(n·avgH/avgW)) uses fewer
 * columns for wide items → more rows → the Y we want instead of endless X.
 *
 * @param {Array<{w:number,h:number}>} sizes
 * @param {number} gap
 * @returns {number} wrap width (Infinity for 0–1 boxes: no wrap)
 */
export function squareWrap(sizes, gap) {
    const n = sizes.length;
    if (n <= 1) return Infinity; // single box (or none): no wrap
    const maxW = Math.max(...sizes.map((s) => s.w));
    const avgW = sizes.reduce((a, s) => a + s.w, 0) / n;
    const avgH = sizes.reduce((a, s) => a + s.h, 0) / n;
    const cols = Math.max(1, Math.round(Math.sqrt(n * (avgH / Math.max(avgW, 1)))));
    return cols * (maxW + gap);
}

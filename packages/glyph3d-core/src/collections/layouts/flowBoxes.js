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
 * With `serpentine`, alternate rows run RIGHT-TO-LEFT: the box sequence boustrophedons
 * (row 0 → , row 1 ← , row 2 → …) so consecutive boxes always land adjacent across a
 * row break instead of jumping back to the left margin. Item ORDER is unchanged — only
 * the x of odd rows is mirrored across the cluster width — so callers still read slots
 * in their original order. This is what makes an ordered dir tier's arrow chain snake
 * cleanly rather than backtrack on every wrap.
 *
 * Each slot carries its `row` (0-based, top→down) so callers can rake the rows on a
 * third axis — e.g. packed's gravity cascade steps each descending row back in Z.
 *
 * @param {Array<{w:number,h:number}>} sizes
 * @param {{margin?:number, wrapWidth?:number, serpentine?:boolean}} [opts]
 * @returns {{slots: Array<{x:number,y:number,row:number}>, width:number, height:number, rows:number}}
 */
export function flowBoxes(sizes, { margin = 16, wrapWidth = Infinity, serpentine = false } = {}) {
    const slots = [];
    let cx = 0, topY = 0, rowH = 0, rows = 1, maxW = 0, row = 0;
    for (const s of sizes) {
        if (cx > 0 && cx + s.w > wrapWidth) {
            maxW = Math.max(maxW, cx - margin);
            cx = 0; topY -= rowH + margin; rowH = 0; rows++; row++;
        }
        slots.push({ x: cx, y: topY, row });
        cx += s.w + margin;
        rowH = Math.max(rowH, s.h);
    }
    maxW = Math.max(maxW, cx - margin);
    // Mirror odd rows across the cluster width so the box sequence snakes (the last box
    // of a row sits directly above the first box of the next), keeping every step local.
    if (serpentine) {
        for (let i = 0; i < slots.length; i++) {
            if (slots[i].row & 1) slots[i].x = maxW - slots[i].x - sizes[i].w;
        }
    }
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

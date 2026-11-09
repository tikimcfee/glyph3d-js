/**
 * labelPlacement — map-style label placement, pure (no DOM, no THREE): screen-space boxes in CSS
 * px, y down. Each item is a target rect (a terminal on screen) and a label size; the result is a
 * box per label that overlaps no other label, plus a leader segment from the label to its target
 * when they don't touch. Greedy in the caller's priority order, the way map renderers place
 * labels (a collision index, candidates tried in order); a label with nowhere to go is hidden.
 *
 * Stability: a label first retries the candidate it held last frame — hysteresis on the CHOICE,
 * never on the position, so a label moves exactly with its target and only switches sides when its
 * old side is truly blocked.
 */

/** Candidate positions around a target, in preference order (a second ring sits farther out). */
export const CANDIDATES = ['above', 'below', 'right', 'left', 'above2', 'below2'];

/**
 * @typedef {{ left: number, top: number, right: number, bottom: number }} Box
 * @typedef {{ id: string, target: Box, w: number, h: number }} LabelItem
 * @typedef {{ box: Box, cand: string, leader: { x1: number, y1: number, x2: number, y2: number }|null }} Placement
 */

/** @param {Box} a @param {Box} b @returns {boolean} */
export function boxesOverlap(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * The label box for one candidate around `t`.
 * @param {string} cand @param {Box} t @param {number} w @param {number} h @param {number} gap
 * @returns {Box}
 */
export function candidateBox(cand, t, w, h, gap) {
    let x, y;
    switch (cand) {
        case 'above': x = t.left; y = t.top - gap - h; break;
        case 'below': x = t.left; y = t.bottom + gap; break;
        case 'right': x = t.right + gap; y = t.top; break;
        case 'left': x = t.left - gap - w; y = t.top; break;
        case 'above2': x = t.left; y = t.top - 2 * gap - 2 * h; break;
        case 'below2': x = t.left; y = t.bottom + 2 * gap + h; break;
        default: throw new Error(`[labelPlacement] unknown candidate ${cand}`);
    }
    return { left: x, top: y, right: x + w, bottom: y + h };
}

/**
 * The leader segment from a label box to its target, or null when they touch (within `slack` px).
 * Both ends are nearest points: on the target's border, and on the label's edge.
 * @param {Box} box @param {Box} t @param {number} [slack=1.5]
 */
export function leaderFor(box, t, slack = 1.5) {
    const cx = (box.left + box.right) / 2, cy = (box.top + box.bottom) / 2;
    // Nearest point of the target to the label's centre, pushed onto its border.
    let tx = Math.min(Math.max(cx, t.left), t.right);
    let ty = Math.min(Math.max(cy, t.top), t.bottom);
    if (tx > t.left && tx < t.right && ty > t.top && ty < t.bottom) {
        const d = [ty - t.top, t.bottom - ty, tx - t.left, t.right - tx];
        const m = Math.min(...d);
        if (m === d[0]) ty = t.top; else if (m === d[1]) ty = t.bottom; else if (m === d[2]) tx = t.left; else tx = t.right;
    }
    // Nearest point of the label box to that border point.
    const lx = Math.min(Math.max(tx, box.left), box.right);
    const ly = Math.min(Math.max(ty, box.top), box.bottom);
    if (Math.hypot(tx - lx, ty - ly) <= slack) return null;
    return { x1: lx, y1: ly, x2: tx, y2: ty };
}

/**
 * Place labels greedily, in the given (priority) order.
 * @param {LabelItem[]} items - highest priority first
 * @param {{ w: number, h: number, margin?: number, gap?: number }} view - viewport in CSS px
 * @param {Map<string, string>} [prev] - id → candidate held last frame (tried first)
 * @param {Box[]} [obstacles] - target rects labels should avoid covering (every target's own rect
 *   is avoided by the others' labels in the strict pass; the relaxed pass ignores obstacles)
 * @returns {Map<string, Placement|null>} null = hidden (nowhere to go)
 */
export function placeLabels(items, view, prev = new Map(), obstacles = items.map((i) => i.target)) {
    const margin = view.margin ?? 4, gap = view.gap ?? 4;
    const placed = [];
    const out = new Map();
    const inView = (b) => b.left >= margin && b.top >= margin && b.right <= view.w - margin && b.bottom <= view.h - margin;
    const freeOfLabels = (b) => !placed.some((p) => boxesOverlap(b, p));
    const freeOfTargets = (b, own) => !obstacles.some((o) => o !== own && boxesOverlap(b, o));
    for (const it of items) {
        const order = prev.has(it.id) ? [prev.get(it.id), ...CANDIDATES.filter((c) => c !== prev.get(it.id))] : CANDIDATES;
        let hit = null;
        for (const strict of [true, false]) {
            for (const cand of order) {
                const box = candidateBox(cand, it.target, it.w, it.h, gap);
                if (!inView(box) || !freeOfLabels(box)) continue;
                if (strict && !freeOfTargets(box, it.target)) continue;
                hit = { box, cand, leader: leaderFor(box, it.target, gap + 1.5) };   // adjacent (one gap away) needs no line
                break;
            }
            if (hit) break;
        }
        if (hit) placed.push(hit.box);
        out.set(it.id, hit);
    }
    return out;
}

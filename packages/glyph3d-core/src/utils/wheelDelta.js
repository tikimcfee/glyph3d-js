/**
 * normalizeWheelDelta — a WheelEvent's travel in PIXELS, whatever unit the device
 * reported. WheelEvent.deltaMode says how to read deltaX/Y: 0 pixels (trackpads,
 * Chromium), 1 LINES (Firefox on some setups, some mice), 2 PAGES (rare). Consumers
 * that accumulate travel — the paging detent, the dolly, surface scroll — want one
 * unit, so the conversion lives once, at the listener.
 *
 * deltaX/deltaY are read BEFORE deltaMode: Firefox reports line deltas only to a
 * listener that inspects deltaMode first (its pixel-scrolling compatibility path), so
 * the order keeps pixel mode wherever the browser offers it.
 */

/** Pixels one wheel LINE stands for — Chromium's own line step, so 3 lines ≈ one click (120 px). */
export const WHEEL_LINE_PX = 40;

/**
 * @param {WheelEvent} e
 * @param {() => number} pagePx - pixels one PAGE stands for (the canvas viewport height);
 *        a thunk, read only for a page-mode event
 * @returns {{ dx: number, dy: number }} travel in px
 */
export function normalizeWheelDelta(e, pagePx) {
    const dx = e.deltaX || 0, dy = e.deltaY || 0;
    const mode = e.deltaMode;
    const k = mode === 1 ? WHEEL_LINE_PX : mode === 2 ? pagePx() : 1;
    return { dx: dx * k, dy: dy * k };
}

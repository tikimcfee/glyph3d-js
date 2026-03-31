/**
 * Canvas viewport sizing — single source of truth.
 *
 * The canvas may be inside an IDE shell with sidebar/header/panels,
 * so window.innerWidth/Height is wrong. This helper resolves the
 * actual renderable area from the canvas's container.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {{ width: number, height: number }}
 */
export function getCanvasViewportSize(canvas) {
    // Prefer the parent container's CSS dimensions — this is what
    // actually constrains the canvas in the IDE shell layout.
    const parent = canvas.parentElement;
    if (parent) {
        const w = parent.clientWidth;
        const h = parent.clientHeight;
        if (w > 0 && h > 0) return { width: w, height: h };
    }

    // Fallback: canvas's own CSS-rendered size
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (cw > 0 && ch > 0) return { width: cw, height: ch };

    // Last resort: window (standalone viewer without container)
    return { width: window.innerWidth, height: window.innerHeight };
}

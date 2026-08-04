import * as THREE from 'three';

/**
 * plateBake — the shared rounded-pill canvas bake. The pill plate (rounded-rect fill +
 * hairline stroke, NO text) behind Label3D/Button3D (which draw their text into the same
 * canvas) and FieldLabel (whose text is a GlyphField layered over the plate mesh — only the
 * plate is baked). One bake, one look, two text substrates.
 */

/** Path a rounded rectangle onto `ctx` (no fill/stroke — caller paints). */
export function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

/** Bake the pill plate (rounded-rect fill in `color` + the hairline stroke) onto a fresh
 *  w×h canvas. Returns { canvas, ctx } so the caller can draw more on top (Label3D's text)
 *  before wrapping the canvas in a texture — or use bakePillTexture for the finished plate. */
export function bakePillCanvas(w, h, color) {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    const r = Math.min(h * 0.34, 22);
    const col = new THREE.Color(color);
    ctx.fillStyle = `rgb(${(col.r * 255) | 0},${(col.g * 255) | 0},${(col.b * 255) | 0})`;
    roundRectPath(ctx, 1.5, 1.5, w - 3, h - 3, r); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    roundRectPath(ctx, 1.5, 1.5, w - 3, h - 3, r); ctx.stroke();
    return { canvas, ctx };
}

/** The finished pill plate texture (no text) — FieldLabel's backing plate. */
export function bakePillTexture(w, h, color) {
    const { canvas } = bakePillCanvas(w, h, color);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    texture.needsUpdate = true;
    return texture;
}

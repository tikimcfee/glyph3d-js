/**
 * cursorMaterial — a text/terminal cursor block, as ONE fragment shader.
 *
 * A cursor marks a cell. Two looks come from one mesh + one uniform flip:
 *
 *   'solid'    — a translucent SOLID block over the cell. The glyph reads through it (we
 *                approximate a terminal's reverse-video cursor with an alpha overlay rather
 *                than recoloring the glyph). The "type here" cue for the window holding the keyboard.
 *   'hollow'   — a HOLLOW outline (border only), so a terminal that doesn't hold the keyboard
 *                still shows where its prompt sits without claiming "type here".
 *   'captured' — SOLID block AND a bright ring: greedy capture is settled (Esc + all keys flow
 *                here), the strongest "you are fully in this terminal" cue.
 *
 * The outline is measured in SCREEN PIXELS (edge / fwidth(edge) — the quad-size term cancels),
 * the same crisp-hairline trick panelMaterial uses for the window border, so it stays a clean
 * ~1.5px box at any zoom or distance and never ramps inward.
 *
 * depthWrite is OFF: the block sits just in front of its glyph (tests depth so a nearer window
 * occludes it) but never writes depth, so it can't occlude the glyphs it overlays.
 */

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { uv, vec2, float, uniform, min, max, smoothstep, fwidth } from 'three/tsl';

/** Default hollow-outline thickness, in SCREEN PIXELS. */
export const CURSOR_BORDER_WIDTH = 1.5;

/**
 * @param {Object} [opts]
 * @param {number|string} [opts.color=0x6ee7a0] - cursor color (focus green by default)
 * @param {number} [opts.fillOpacity=0.5] - solid-block alpha when focused (glyph reads through)
 * @param {number} [opts.borderWidth=CURSOR_BORDER_WIDTH] - hollow-outline thickness in screen px
 * @returns {{ material: MeshBasicNodeMaterial, setState, setStyle }}
 */
export function createCursorMaterial({ color = 0x6ee7a0, fillOpacity = 0.5,
                                       borderWidth = CURSOR_BORDER_WIDTH } = {}) {
    const uColor = uniform(new THREE.Color(color));
    const uFill = uniform(0);                 // fill alpha (0 = hollow; fillOpacity = solid)
    const uBorder = uniform(1);               // outline alpha (1 = drawn; 0 = none)
    const uBorderW = uniform(borderWidth);    // screen pixels
    let fill = fillOpacity;                    // remembered solid-fill alpha (CPU side)

    // Crisp screen-pixel outline at the quad edge (panel-size term cancels in fwidth).
    const edge = vec2(0.5, 0.5).sub(uv().sub(0.5).abs());   // per-axis dist to edge, [0, 0.5]
    const px = edge.div(max(fwidth(edge), float(1e-6)));     // → screen pixels, per axis
    const d = min(px.x, px.y);                               // pixels to the nearest edge
    const band = smoothstep(uBorderW.sub(float(0.5)), uBorderW.add(float(0.5)), d).oneMinus();

    const material = new MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.colorNode = uColor;
    // SOLID fills the quad at `fill`; HOLLOW lights only the border band. max() means a focused
    // cursor is a clean fill (no double-drawn rim) and an unfocused one is a pure outline.
    material.opacityNode = max(uFill, band.mul(uBorder));

    return {
        material,

        /** Set the look: 'hollow' (outline), 'solid' (filled block), or 'captured' (filled + ring). */
        setState(state) {
            const solid = state === 'solid' || state === 'captured';
            uFill.value = solid ? fill : 0;
            // The ring shows for hollow (the whole cue) and captured (block + ring); plain solid has none.
            uBorder.value = state === 'solid' ? 0 : 1;
        },

        /** Live restyle — color, solid-fill alpha, outline width. Re-applies the current look. */
        setStyle({ color, fillOpacity, borderWidth } = {}) {
            if (color != null) uColor.value.set(color);
            if (fillOpacity != null) { fill = fillOpacity; if (uFill.value > 0) uFill.value = fill; }
            if (borderWidth != null) uBorderW.value = borderWidth;
        },
    };
}

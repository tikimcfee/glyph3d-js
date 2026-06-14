/**
 * panelMaterial — the window background panel + its border, as ONE fragment shader.
 *
 * A code grid / terminal lays its glyphs out as quads in front of a flat background plane (the
 * "wall" the text contrasts against). That plane already IS the window's bounding rectangle, so the
 * border isn't a separate object — it's an effect painted onto the same plane: a thin crisp line
 * right at the plane's edge, in the window's identity color. The GPU does it per-pixel.
 *
 * The line is measured in SCREEN PIXELS, not world units, so it stays a clean 1–2px hairline at any
 * zoom or distance and never ramps inward into the text. The trick is screen-space derivatives:
 *
 *   edge(uv)  = per-axis distance to the nearest edge, unitless [0, 0.5]
 *   pixels    = edge / fwidth(edge)          // edge distance expressed in screen pixels —
 *                                            //   the panel-size term cancels, so no size uniform
 *   d         = min(pixels.x, pixels.y)      // pixels to the nearest edge
 *   band      = (1 − smoothstep(W−0.5, W+0.5, d)) · strength   // solid to W px, 1px AA shoulder
 *   rgb       = mix(fill, borderColor, band)
 *   alpha     = max(fillOpacity, band)       // the rim stays legible on a translucent docked tile
 *
 * strength = 0 means "no border" — the panel paints as a plain fill, so this is a drop-in for the
 * MeshBasicMaterial it replaces.
 *
 * One material per panel (each grid keeps its own, preserving the per-grid `transparent`/`depthWrite`
 * the dock-stacking occlusion depends on); the node graph is identical across them, so the renderer
 * reuses one compiled pipeline. The generalization Ivan noted — z-pages wanting a real 3D container
 * — is the SAME effect on a box carrier; only the edge field gains a third axis.
 */

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { uv, vec2, float, uniform, mix, smoothstep, min, max, fwidth } from 'three/tsl';

/** Default border thickness in SCREEN PIXELS. */
export const PANEL_BORDER_WIDTH = 1.5;

/**
 * @param {Object} [opts]
 * @param {number|string} [opts.color=0x000000] - fill color
 * @param {number} [opts.opacity=1] - fill opacity (transparent flag tracks opacity<1)
 * @param {number} [opts.side=THREE.DoubleSide]
 * @param {boolean} [opts.depthWrite=true] - the panel occludes content behind it (dock stacks)
 * @returns {{ material: MeshBasicNodeMaterial, setFill, setBorder }}
 */
export function createPanelMaterial({ color = 0x000000, opacity = 1,
                                      side = THREE.DoubleSide, depthWrite = true } = {}) {
    const uFill = uniform(new THREE.Color(color));
    const uOpacity = uniform(opacity);
    const uBorderColor = uniform(new THREE.Color(0xffffff));
    const uBorderWidth = uniform(PANEL_BORDER_WIDTH); // screen pixels
    const uBorderStrength = uniform(0);               // 0 = no border (plain fill)

    // A crisp pixel-wide line at the panel edge. edge → pixels via the screen-space derivative
    // (panel size cancels); the smoothstep is a 1px anti-alias shoulder, NOT an inward gradient.
    const edge = vec2(0.5, 0.5).sub(uv().sub(0.5).abs());      // per-axis dist to edge, [0, 0.5]
    const px = edge.div(max(fwidth(edge), float(1e-6)));       // → screen pixels, per axis
    const d = min(px.x, px.y);                                 // pixels to the nearest edge
    const band = smoothstep(uBorderWidth.sub(float(0.5)), uBorderWidth.add(float(0.5)), d)
        .oneMinus().mul(uBorderStrength);

    const material = new MeshBasicNodeMaterial();
    material.transparent = opacity < 1;
    material.side = side;
    material.depthWrite = depthWrite;
    material.colorNode = mix(uFill, uBorderColor, band);
    material.opacityNode = max(uOpacity, band);

    return {
        material,

        /** Live-restyle the fill (color and/or opacity). Mirrors the old material.color/opacity. */
        setFill(c, o) {
            if (c != null) uFill.value.set(c);
            if (o != null) { uOpacity.value = o; material.transparent = o < 1; }
        },

        /** Set the border. strength 0 = off. width is in SCREEN PIXELS (omit to keep current). */
        setBorder({ color, width, strength } = {}) {
            if (color != null) uBorderColor.value.set(color);
            if (width != null) uBorderWidth.value = width;
            if (strength != null) uBorderStrength.value = strength;
        },
    };
}

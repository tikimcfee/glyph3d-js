/**
 * panelMaterial — the window background panel + its border, as ONE fragment shader.
 *
 * A code grid / terminal lays its glyphs out as quads in front of a flat background plane (the
 * "wall" the text contrasts against). That plane already IS the window's bounding rectangle, so the
 * border isn't a separate object — it's an effect painted onto the same plane: a thin crisp line
 * right at the panel edge. The GPU does it per-pixel.
 *
 * The line is measured in SCREEN PIXELS (edge / fwidth(edge) — the panel-size term cancels), so it
 * stays a clean 1–2px hairline at any zoom or distance and never ramps inward into the text.
 *
 * WHAT the border shows is driven by a group-level BIT-SET (one uint per window), not a CPU-computed
 * color. Each subsystem owns its own bits and flips them; the shader decodes the int and decides the
 * look — so there's no single-writer contention, and the whole visual language lives in one place:
 *
 *   DOCKED  — wears its dock identity hue (set by CameraDock, with the hue in uBorderColor)
 *   HOVERED — pointer is over it (a gentle time-pulse brighten)
 *   FOCUSED — sticky/primary focus (a thicker line)
 *   INPUT   — edit mode / keyboard target (amber accent, thicker)
 *
 * flags == 0 → no border (a plain fill), so this stays a drop-in for the MeshBasicMaterial it
 * replaced. A transient state REPLACES the resting color outright (no blend): the border shows the
 * full state color while hovered/focused/input-active, and reverts to its resting color — whatever
 * was set on the material, i.e. the dock's identity hue — when the state clears. The interpretation
 * here is just a default — it's all tunable in this one shader, including time-based animation,
 * without touching any CPU code.
 *
 * One material per panel (each grid keeps its own, preserving the per-grid `transparent`/`depthWrite`
 * the dock-stacking occlusion depends on); the node graph is identical across them, so the renderer
 * reuses one compiled pipeline.
 */

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { uv, vec2, vec3, float, uint, uniform, mix, smoothstep, min, max, fwidth, bitAnd, select, time, sin } from 'three/tsl';

/** Default border thickness in SCREEN PIXELS. */
export const PANEL_BORDER_WIDTH = 1.5;

/** Group-level border state bits. Each subsystem owns its own; the shader decodes them. */
export const BORDER_FLAGS = Object.freeze({
    DOCKED:  1 << 0,
    HOVERED: 1 << 1,
    FOCUSED: 1 << 2,
    INPUT:   1 << 3,
});

const TAU = Math.PI * 2;
// State colors — the legible vocabulary carried over from the roving outline overlay.
const C_HOVER = vec3(0.624, 0.824, 1.0);  // 0x9fd2ff — light blue
const C_FOCUS = vec3(0.431, 0.906, 0.627); // 0x6ee7a0 — green
const C_INPUT = vec3(0.941, 0.706, 0.353); // 0xf0b45a — amber

/**
 * @param {Object} [opts]
 * @param {number|string} [opts.color=0x000000] - fill color
 * @param {number} [opts.opacity=1] - fill opacity (transparent flag tracks opacity<1)
 * @param {number} [opts.side=THREE.DoubleSide]
 * @param {boolean} [opts.depthWrite=true] - the panel occludes content behind it (dock stacks)
 * @returns {{ material: MeshBasicNodeMaterial, setFill, setBorder, setBorderFlag, getBorderFlags }}
 */
export function createPanelMaterial({ color = 0x000000, opacity = 1,
                                      side = THREE.DoubleSide, depthWrite = true } = {}) {
    const uFill = uniform(new THREE.Color(color));
    const uOpacity = uniform(opacity);
    const uBorderColor = uniform(new THREE.Color(0xffffff)); // identity hue (DOCKED)
    const uBorderWidth = uniform(PANEL_BORDER_WIDTH);        // screen pixels
    const uBorderIntensity = uniform(1);                    // master rim opacity
    const uFlags = uniform(0, 'uint');                      // BORDER_FLAGS bit-set

    const F = BORDER_FLAGS;
    const has = (mask) => bitAnd(uFlags, uint(mask)).greaterThan(uint(0)); // bool node
    const on = uFlags.greaterThan(uint(0));
    const anyState = has(F.HOVERED | F.FOCUSED | F.INPUT);
    const accent = has(F.FOCUSED | F.INPUT); // states that thicken the line

    // Border COLOR: a transient state REPLACES the resting color outright — the dominant state color
    // (priority input > focused > hovered) while any state is active, else the material's set color
    // (the dock identity hue). A gentle hover pulse rides on top. No blend, so focus shows full
    // strength, not a half-tint of the identity.
    const stateCol = select(has(F.INPUT), C_INPUT, select(has(F.FOCUSED), C_FOCUS, C_HOVER));
    const pulse = select(has(F.HOVERED), sin(time.mul(TAU * 1.1)).mul(0.5).add(0.5).mul(0.2).add(0.85), float(1));
    const borderCol = select(anyState, stateCol, uBorderColor).mul(pulse);

    // Border SHAPE: a crisp pixel-wide line at the edge; focus/input thicken it.
    const w = uBorderWidth.mul(select(accent, float(1.6), float(1)));
    const edge = vec2(0.5, 0.5).sub(uv().sub(0.5).abs());     // per-axis dist to edge, [0, 0.5]
    const px = edge.div(max(fwidth(edge), float(1e-6)));       // → screen pixels, per axis
    const d = min(px.x, px.y);                                // pixels to the nearest edge
    const band = smoothstep(w.sub(float(0.5)), w.add(float(0.5)), d).oneMinus();
    const rim = band.mul(select(on, uBorderIntensity, float(0)));

    const material = new MeshBasicNodeMaterial();
    material.transparent = opacity < 1;
    material.side = side;
    material.depthWrite = depthWrite;
    material.colorNode = mix(uFill, borderCol, rim);
    material.opacityNode = max(uOpacity, rim);

    let flags = 0;
    return {
        material,

        /** Live-restyle the fill (color and/or opacity). Mirrors the old material.color/opacity. */
        setFill(c, o) {
            if (c != null) uFill.value.set(c);
            if (o != null) { uOpacity.value = o; material.transparent = o < 1; }
        },

        /** Set the identity color / width(px) / master intensity. State is via setBorderFlag. */
        setBorder({ color, width, intensity } = {}) {
            if (color != null) uBorderColor.value.set(color);
            if (width != null) uBorderWidth.value = width;
            if (intensity != null) uBorderIntensity.value = intensity;
        },

        /** Flip one or more BORDER_FLAGS bits. Each subsystem owns its bits (no contention). */
        setBorderFlag(mask, present) {
            flags = present ? (flags | mask) : (flags & ~mask);
            uFlags.value = flags >>> 0;
        },

        getBorderFlags() { return flags; },
    };
}

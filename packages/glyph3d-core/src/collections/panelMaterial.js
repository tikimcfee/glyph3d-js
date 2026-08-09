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
import { uv, vec2, float, uint, uniform, mix, smoothstep, min, max, fwidth, bitAnd, select, time, sin, modelViewProjection } from 'three/tsl';
import { withBandBias } from '../core/layerBands.js';

/** Default border thickness in SCREEN PIXELS. */
export const PANEL_BORDER_WIDTH = 1.5;

/** Group-level border state bits. Each subsystem owns its own; the shader decodes them. */
export const BORDER_FLAGS = Object.freeze({
    DOCKED:   1 << 0,
    HOVERED:  1 << 1,
    FOCUSED:  1 << 2,
    INPUT:    1 << 3,
    CAPTURED: 1 << 4,   // greedy keyboard capture settled on this window (Esc + all keys flow here)
    EDGE:     1 << 5,   // a constant identity hairline (label pills) — no state semantics, no pulse
});

const TAU = Math.PI * 2;

// State colors — the legible interaction vocabulary (focus/hover/input), shared by the in-shader
// border AND the directory overlay so the two never drift. These are the DEFAULTS a panel is born
// with; the app folds the configured values (Settings ▸ Appearance) in via setPanelStateColorDefaults
// for new panels + per-panel setStateColors() for live restyle. Mutable module state so a freshly
// created panel inherits the current scheme without threading colors through every constructor.
const STATE_DEFAULTS = {
    hover:   new THREE.Color(0x9fd2ff), // light blue
    focus:   new THREE.Color(0x6ee7a0), // green
    input:   new THREE.Color(0xf0b45a), // amber
    capture: new THREE.Color(0xff7a18), // hot orange — "locked, keyboard fully grabbed"
};

/**
 * Set the default state colors panels created AFTER this call are born with. Live panels keep their
 * own uniforms — restyle those with the handle's setStateColors(). Accepts anything THREE.Color eats.
 * @param {{ hover?: number|string, focus?: number|string, input?: number|string, capture?: number|string }} colors
 */
export function setPanelStateColorDefaults({ hover, focus, input, capture } = {}) {
    if (hover != null) STATE_DEFAULTS.hover.set(hover);
    if (focus != null) STATE_DEFAULTS.focus.set(focus);
    if (input != null) STATE_DEFAULTS.input.set(input);
    if (capture != null) STATE_DEFAULTS.capture.set(capture);
}

/**
 * @param {Object} [opts]
 * @param {number|string} [opts.color=0x000000] - fill color
 * @param {number} [opts.opacity=1] - fill opacity (transparent flag tracks opacity<1)
 * @param {number} [opts.side=THREE.DoubleSide]
 * @param {boolean} [opts.depthWrite=true] - the panel occludes content behind it (dock stacks)
 * @param {string} [opts.layerBand] - a LAYER_BAND name: the vertex stage wears the band's
 *        live clip-z depth bias (the `band.*` settings dials — see core/layerBands.js), so
 *        stacked translucent layers keep a deterministic depth order at any camera distance
 * @returns {{ material: MeshBasicNodeMaterial, setFill, setBorder, setBorderFlag, getBorderFlags }}
 */
export function createPanelMaterial({ color = 0x000000, opacity = 1,
                                      side = THREE.DoubleSide, depthWrite = true, layerBand = null } = {}) {
    const uFill = uniform(new THREE.Color(color));
    const uOpacity = uniform(opacity);
    const uBorderColor = uniform(new THREE.Color(0xffffff)); // identity hue (DOCKED)
    const uBorderWidth = uniform(PANEL_BORDER_WIDTH);        // screen pixels
    const uBorderIntensity = uniform(1);                    // master rim opacity
    const uFlags = uniform(0, 'uint');                      // BORDER_FLAGS bit-set
    // Per-panel state colors, seeded from the current module defaults (clone so each panel owns its
    // own uniform); setStateColors() restyles them live.
    const uHoverColor = uniform(STATE_DEFAULTS.hover.clone());
    const uFocusColor = uniform(STATE_DEFAULTS.focus.clone());
    const uInputColor = uniform(STATE_DEFAULTS.input.clone());
    const uCaptureColor = uniform(STATE_DEFAULTS.capture.clone());

    const F = BORDER_FLAGS;
    const has = (mask) => bitAnd(uFlags, uint(mask)).greaterThan(uint(0)); // bool node
    const on = uFlags.greaterThan(uint(0));
    const anyState = has(F.HOVERED | F.FOCUSED | F.INPUT | F.CAPTURED);
    const accent = has(F.FOCUSED | F.INPUT | F.CAPTURED); // states that thicken the line

    // Border COLOR: a transient state REPLACES the resting color outright — the dominant state color
    // (priority captured > input > focused > hovered) while any state is active, else the material's
    // set color (the dock identity hue). A gentle hover pulse rides on top. No blend, so focus shows
    // full strength, not a half-tint of the identity. CAPTURED wins — it's the strongest "you are
    // fully in this window" cue.
    const stateCol = select(has(F.CAPTURED), uCaptureColor,
                       select(has(F.INPUT), uInputColor,
                         select(has(F.FOCUSED), uFocusColor, uHoverColor)));
    const pulse = select(has(F.HOVERED), sin(time.mul(TAU * 1.1)).mul(0.5).add(0.5).mul(0.2).add(0.85), float(1));
    const borderCol = select(anyState, stateCol, uBorderColor).mul(pulse);

    // Border SHAPE: a crisp pixel-wide line at the edge; focus/input thicken it, CAPTURED thickest
    // (a bold locked frame).
    const w = uBorderWidth.mul(select(has(F.CAPTURED), float(2.6), select(accent, float(1.6), float(1))));
    const edge = vec2(0.5, 0.5).sub(uv().sub(0.5).abs());     // per-axis dist to edge, [0, 0.5]
    const px = edge.div(max(fwidth(edge), float(1e-6)));       // → screen pixels, per axis
    const d = min(px.x, px.y);                                // pixels to the nearest edge
    const band = smoothstep(w.sub(float(0.5)), w.add(float(0.5)), d).oneMinus();
    const rim = band.mul(select(on, uBorderIntensity, float(0)));

    const material = new MeshBasicNodeMaterial();
    material.transparent = opacity < 1;
    material.side = side;
    material.depthWrite = depthWrite;
    material.forceSinglePass = true;   // transparent+DoubleSide double-pass: no (see GlyphField)
    material.colorNode = mix(uFill, borderCol, rim);
    material.opacityNode = max(uOpacity, rim);
    // The layer-band depth bias rides the vertex stage (a live shared uniform — see
    // core/layerBands.js): clip.z += bias·w. modelViewProjection IS the standard clip
    // output, so this replaces nothing but the depth the fragment lands at.
    if (layerBand) material.vertexNode = withBandBias(modelViewProjection, layerBand);

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

        /** Restyle the focus/hover/input/capture state colors live (the shared interaction vocabulary). */
        setStateColors({ hover, focus, input, capture } = {}) {
            if (hover != null) uHoverColor.value.set(hover);
            if (focus != null) uFocusColor.value.set(focus);
            if (input != null) uInputColor.value.set(input);
            if (capture != null) uCaptureColor.value.set(capture);
        },

        /** This panel's current state colors as hex ints (inspection — symmetric with getBorderFlags). */
        getStateColors() {
            return {
                hover: uHoverColor.value.getHex(), focus: uFocusColor.value.getHex(),
                input: uInputColor.value.getHex(), capture: uCaptureColor.value.getHex(),
            };
        },

        /** Flip one or more BORDER_FLAGS bits. Each subsystem owns its bits (no contention). */
        setBorderFlag(mask, present) {
            flags = present ? (flags | mask) : (flags & ~mask);
            uFlags.value = flags >>> 0;
        },

        getBorderFlags() { return flags; },
    };
}

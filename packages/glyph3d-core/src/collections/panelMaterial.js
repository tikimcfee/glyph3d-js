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
 * @param {string} [opts.layerBand]
 * @returns {{ material: THREE.ShaderMaterial, setFill, setBorder, setBorderFlag, getBorderFlags, setStateColors, getStateColors }}
 */
export function createPanelMaterial({ color = 0x000000, opacity = 1,
                                      side = THREE.DoubleSide, depthWrite = true, layerBand = null } = {}) {
    const uFill = { value: new THREE.Color(color) };
    const uOpacity = { value: opacity };
    const uBorderColor = { value: new THREE.Color(0xffffff) }; // identity hue (DOCKED)
    const uBorderWidth = { value: PANEL_BORDER_WIDTH };        // screen pixels
    const uBorderIntensity = { value: 1.0 };                   // master rim opacity
    const uFlags = { value: 0 };                               // BORDER_FLAGS bit-set
    const uHoverColor = { value: STATE_DEFAULTS.hover.clone() };
    const uFocusColor = { value: STATE_DEFAULTS.focus.clone() };
    const uInputColor = { value: STATE_DEFAULTS.input.clone() };
    const uCaptureColor = { value: STATE_DEFAULTS.capture.clone() };
    const uTime = { value: 0.0 };

    const material = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
            uFill,
            uOpacity,
            uBorderColor,
            uBorderWidth,
            uBorderIntensity,
            uFlags,
            uHoverColor,
            uFocusColor,
            uInputColor,
            uCaptureColor,
            uTime,
        },
        vertexShader: `
            out vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            precision highp float;
            precision highp int;

            in vec2 vUv;
            out vec4 fragColor;

            uniform vec3 uFill;
            uniform float uOpacity;
            uniform vec3 uBorderColor;
            uniform float uBorderWidth;
            uniform float uBorderIntensity;
            uniform int uFlags;
            uniform vec3 uHoverColor;
            uniform vec3 uFocusColor;
            uniform vec3 uInputColor;
            uniform vec3 uCaptureColor;
            uniform float uTime;

            void main() {
                int F_DOCKED   = 1;
                int F_HOVERED  = 2;
                int F_FOCUSED  = 4;
                int F_INPUT    = 8;
                int F_CAPTURED = 16;
                int F_EDGE     = 32;

                bool isCaptured = (uFlags & F_CAPTURED) != 0;
                bool isInput    = (uFlags & F_INPUT) != 0;
                bool isFocused  = (uFlags & F_FOCUSED) != 0;
                bool isHovered  = (uFlags & F_HOVERED) != 0;
                bool anyState   = isCaptured || isInput || isFocused || isHovered;
                bool accent     = isCaptured || isInput || isFocused;

                vec3 stateCol = isCaptured ? uCaptureColor : (isInput ? uInputColor : (isFocused ? uFocusColor : uHoverColor));
                float pulse = isHovered ? (sin(uTime * 6.9115) * 0.5 + 0.5) * 0.2 + 0.85 : 1.0;
                vec3 borderCol = (anyState ? stateCol : uBorderColor) * pulse;

                float scaleFactor = isCaptured ? 2.6 : (accent ? 1.6 : 1.0);
                float w = uBorderWidth * scaleFactor;

                vec2 edge = vec2(0.5) - abs(vUv - vec2(0.5));
                vec2 px = edge / max(fwidth(edge), vec2(1e-6));
                float d = min(px.x, px.y);
                float band = 1.0 - smoothstep(w - 0.5, w + 0.5, d);
                float rim = (uFlags > 0) ? (band * uBorderIntensity) : 0.0;

                vec3 finalColor = mix(uFill, borderCol, rim);
                float finalAlpha = max(uOpacity, rim);

                fragColor = vec4(finalColor, finalAlpha);
            }
        `,
        transparent: opacity < 1,
        side,
        forceSinglePass: true,   // a flat panel: the back/front two-pass changes no pixel, only costs two program re-derivations
        depthWrite,
    });

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

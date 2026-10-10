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
 *
 * WebGL2 (GLSL 3.00 ES) THREE.ShaderMaterial implementation.
 */

import * as THREE from 'three';

/** Default hollow-outline thickness, in SCREEN PIXELS. */
export const CURSOR_BORDER_WIDTH = 1.5;

const VERTEX_SHADER = `
precision highp float;

in vec3 position;
in vec2 uv;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

out vec2 vUv;

void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision highp float;
precision highp int;

in vec2 vUv;
out vec4 fragColor;

uniform vec3 uColor;
uniform float uFill;
uniform float uBorder;
uniform float uBorderW;

void main() {
    // Crisp screen-pixel outline at the quad edge (panel-size term cancels in fwidth).
    vec2 edge = vec2(0.5, 0.5) - abs(vUv - vec2(0.5, 0.5));
    vec2 fw = fwidth(edge);
    vec2 px = edge / max(fw, vec2(1e-6, 1e-6));
    float d = min(px.x, px.y);
    float band = 1.0 - smoothstep(uBorderW - 0.5, uBorderW + 0.5, d);

    float alpha = max(uFill, band * uBorder);
    if (alpha <= 0.0) discard;
    fragColor = vec4(uColor, alpha);
}
`;

/**
 * @param {Object} [opts]
 * @param {number|string} [opts.color=0x6ee7a0] - cursor color (focus green by default)
 * @param {number} [opts.fillOpacity=0.5] - solid-block alpha when focused (glyph reads through)
 * @param {number} [opts.borderWidth=CURSOR_BORDER_WIDTH] - hollow-outline thickness in screen px
 * @returns {{ material: THREE.ShaderMaterial, setState: Function, setStyle: Function }}
 */
export function createCursorMaterial({ color = 0x6ee7a0, fillOpacity = 0.5,
                                       borderWidth = CURSOR_BORDER_WIDTH } = {}) {
    const uColorVal = new THREE.Color(color);
    let fill = fillOpacity;

    const uniforms = {
        uColor: { value: uColorVal },
        uFill: { value: 0.0 },
        uBorder: { value: 1.0 },
        uBorderW: { value: borderWidth },
    };

    const material = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        uniforms,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
    });

    return {
        material,

        /** Set the look: 'hollow' (outline), 'solid' (filled block), or 'captured' (filled + ring). */
        setState(state) {
            const solid = state === 'solid' || state === 'captured';
            uniforms.uFill.value = solid ? fill : 0.0;
            // The ring shows for hollow (the whole cue) and captured (block + ring); plain solid has none.
            uniforms.uBorder.value = state === 'solid' ? 0.0 : 1.0;
        },

        /** Live restyle — color, solid-fill alpha, outline width. Re-applies the current look. */
        setStyle({ color: c, fillOpacity: fo, borderWidth: bw } = {}) {
            if (c != null) uniforms.uColor.value.set(c);
            if (fo != null) {
                fill = fo;
                if (uniforms.uFill.value > 0) uniforms.uFill.value = fill;
            }
            if (bw != null) uniforms.uBorderW.value = bw;
        },
    };
}

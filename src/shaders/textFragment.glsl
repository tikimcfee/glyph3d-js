// REFERENCE ONLY — this file is NOT loaded at runtime.
// The canonical fragment shader is the template literal returned by
// GlyphRenderer._getFragmentShader() in src/GlyphRenderer.js.
//
// This file exists for IDE syntax highlighting and GLSL tooling only.
// Keep it in sync with the inline version manually. The varying names
// MUST match: both files use vUV (uppercase V), not vUv.
//
// GLSL ES 3.00 (THREE.GLSL3) — varying→in, gl_FragColor→out vec4, texture2D→texture

precision highp float;

uniform sampler2D atlasTexture;

in highp vec2 vUV;
in vec3 vColor;
in float vGroupAlpha;
in vec3 vAddedColor;

out vec4 fragColor;

void main() {
    vec4 texColor = texture(atlasTexture, vUV);

    // Apply instance color and group alpha, then additive highlight
    vec4 base = texColor * vec4(vColor, vGroupAlpha);
    fragColor = vec4(clamp(base.rgb + vAddedColor, 0.0, 1.0), base.a);

    // Alpha test for clean edges and group visibility
    if (fragColor.a < 0.01) discard;
}

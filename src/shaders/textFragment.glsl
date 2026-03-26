// REFERENCE ONLY — this file is NOT loaded at runtime.
// The canonical fragment shader is the template literal returned by
// GlyphRenderer._getFragmentShader() in src/GlyphRenderer.js.
//
// This file exists for IDE syntax highlighting and GLSL tooling only.
// Keep it in sync with the inline version manually. The varying names
// MUST match: both files use vUV (uppercase V), not vUv.

precision highp float;

uniform sampler2D atlasTexture;

varying vec2 vUV;
varying vec3 vColor;
varying float vGroupAlpha;

void main() {
    vec4 texColor = texture2D(atlasTexture, vUV);

    // Apply instance color and group alpha
    gl_FragColor = texColor * vec4(vColor, vGroupAlpha);

    // Alpha test for clean edges and group visibility
    if (gl_FragColor.a < 0.01) discard;
}

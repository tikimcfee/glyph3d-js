// REFERENCE ONLY — this file is NOT loaded at runtime.
// The canonical vertex shader is the template literal returned by
// GlyphRenderer._getVertexShader() in src/GlyphRenderer.js.
//
// This file exists for IDE syntax highlighting and GLSL tooling only.
// Keep it in sync with the inline version manually. The varying names
// MUST match: both files use vUV (uppercase V), not vUv.
//
// GLSL ES 3.00 (THREE.GLSL3) — attribute→in, varying→out, texture2D→texture

precision highp float;

// Per-instance attributes
in vec3 instancePosition;
in vec2 instanceSize;
in float instanceCodepoint;
in vec3 instanceColor;
in float instanceGroupId;
in float instancePickingId;

// Group property DataTexture (4 columns x N rows, RGBA Float)
uniform sampler2D groupTexture;
uniform float groupTextureHeight;

// Atlas map texture: codepoint -> (u0, v0_webgl, u1, v1_webgl)
// Layout: atlasMapWidth texels wide x atlasMapHeight rows tall
uniform sampler2D atlasMapTexture;
uniform float atlasMapWidth;
uniform float atlasMapHeight;

// Per-glyph highlight: RGBA8 DataTexture, width=instanceCount, height=1
uniform sampler2D highlightTexture;

// Outputs to fragment shader
out highp vec2 vUV;
out vec3 vColor;
out float vGroupAlpha;
out vec3 vAddedColor;

void main() {
    // Transform quad by instance size
    vec3 scaled = position * vec3(instanceSize, 1.0);

    // Group property lookups (4-column DataTexture)
    float v = (instanceGroupId + 0.5) / groupTextureHeight;
    vec4 gPos   = texture(groupTexture, vec2(0.125, v));  // col 0: offset + visibility
    vec4 gColor = texture(groupTexture, vec2(0.625, v));  // col 2: color multiplier
    vec4 gScale = texture(groupTexture, vec2(0.875, v));  // col 3: scale

    // World position = scale instance position, then add group offset
    vec3 worldPos = scaled + instancePosition * gScale.xyz + gPos.xyz;

    // Standard projection
    gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);

    // -------------------------------------------------------------------------
    // GPU codepoint → UV lookup  [GPU-Lookup path]
    // -------------------------------------------------------------------------
    float cp = instanceCodepoint;
    float mapCol = mod(cp, atlasMapWidth);
    float mapRow = floor(cp / atlasMapWidth);
    float tx = (mapCol + 0.5) / atlasMapWidth;
    float ty = (mapRow + 0.5) / atlasMapHeight;
    vec4 uvRect = texture(atlasMapTexture, vec2(tx, ty));
    vUV = mix(uvRect.xy, uvRect.zw, uv);

    // gScale.w = color blend factor: 0.0 = multiply (default), 1.0 = replace
    float colorBlend = gScale.w;
    vColor = mix(instanceColor * gColor.rgb, gColor.rgb, colorBlend);
    vGroupAlpha = gColor.a;

    // Per-glyph highlight from RGBA8 DataTexture (uint8 → float via /255.0)
    vec4 highlight = texelFetch(highlightTexture, ivec2(gl_InstanceID, 0), 0);
    vAddedColor = highlight.rgb;
}

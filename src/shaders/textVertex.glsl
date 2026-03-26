precision highp float;

// Per-instance attributes
attribute vec3 instancePosition;
attribute vec2 instanceSize;
attribute float instanceCodepoint;
attribute vec3 instanceColor;
attribute float instanceGroupId;

// Group property DataTexture (4 columns x N rows, RGBA Float)
uniform sampler2D groupTexture;
uniform float groupTextureHeight;

// Atlas map texture: codepoint -> (u0, v0_webgl, u1, v1_webgl)
// Layout: atlasMapWidth texels wide x atlasMapHeight rows tall
uniform sampler2D atlasMapTexture;
uniform float atlasMapWidth;
uniform float atlasMapHeight;

// Varying
varying vec2 vUv;
varying vec3 vColor;
varying float vGroupAlpha;

void main() {
    // Scale quad by instance size
    vec3 scaled = position * vec3(instanceSize, 1.0);

    // Group property lookups (4-column DataTexture)
    float v = (instanceGroupId + 0.5) / groupTextureHeight;
    vec4 gPos   = texture2D(groupTexture, vec2(0.125, v));  // col 0: offset + visibility
    vec4 gColor = texture2D(groupTexture, vec2(0.625, v));  // col 2: color multiplier
    vec4 gScale = texture2D(groupTexture, vec2(0.875, v));  // col 3: scale

    // World position = scale instance position, then add group offset
    vec3 worldPos = scaled + instancePosition * gScale.xyz + gPos.xyz;

    // Apply camera transform
    gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);

    // -------------------------------------------------------------------------
    // GPU codepoint → UV lookup  [GPU-Lookup path]
    //
    // Each glyph instance stores only its Unicode codepoint in instanceCodepoint.
    // The atlas map DataTexture (atlasMapTexture) is a 1024-wide × N-row RGBA
    // Float texture where texel[codepoint] = (u0, v0_webgl, u1, v1_webgl).
    //
    // V coordinates are pre-flipped in GlyphAtlas.getAtlasMapTexture() so this
    // shader needs no canvas→WebGL conversion.
    //
    // The base quad's built-in `uv` attribute runs (0,0)→(1,1); mix() maps
    // that onto the glyph's specific sub-rect in the atlas.
    //
    // To verify this path is active: look for "[GPU-Lookup]" log lines in the
    // console from GlyphAtlas, GlyphRenderer, and GlyphWorker at startup.
    // -------------------------------------------------------------------------
    float cp = instanceCodepoint;
    float mapCol = mod(cp, atlasMapWidth);
    float mapRow = floor(cp / atlasMapWidth);
    float tx = (mapCol + 0.5) / atlasMapWidth;
    float ty = (mapRow + 0.5) / atlasMapHeight;
    vec4 uvRect = texture2D(atlasMapTexture, vec2(tx, ty));
    // uvRect = (u0, v0_webgl, u1, v1_webgl) — pre-flipped in GlyphAtlas
    vUv = mix(uvRect.xy, uvRect.zw, uv);

    // gScale.w = color blend factor: 0.0 = multiply (default), 1.0 = replace
    float colorBlend = gScale.w;
    vColor = mix(instanceColor * gColor.rgb, gColor.rgb, colorBlend);
    vGroupAlpha = gColor.a;
}

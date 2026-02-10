precision highp float;

// Per-instance attributes
attribute vec3 instancePosition;
attribute vec2 instanceSize;
attribute vec4 instanceUV;  // (u0, v0, u1, v1)
attribute vec3 instanceColor;
attribute float instanceGroupId;

// Group property DataTexture (4 columns x N rows, RGBA Float)
uniform sampler2D groupTexture;
uniform float groupTextureHeight;

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

    // Map UVs from base geometry (0-1) to instance atlas UVs
    vUv = mix(instanceUV.xy, instanceUV.zw, uv);
    vColor = instanceColor * gColor.rgb;
    vGroupAlpha = gColor.a;
}

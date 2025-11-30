precision highp float;

// Per-instance attributes
attribute vec3 instancePosition;
attribute vec2 instanceSize;
attribute vec4 instanceUV;  // (u0, v0, u1, v1)
attribute vec3 instanceColor;

// Varying
varying vec2 vUv;
varying vec3 vColor;

void main() {
    // Scale quad by instance size
    vec3 scaled = position * vec3(instanceSize, 1.0);

    // Translate to instance position
    vec3 worldPos = scaled + instancePosition;

    // Apply camera transform
    gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);

    // Map UVs from base geometry (0-1) to instance atlas UVs
    vUv = mix(instanceUV.xy, instanceUV.zw, uv);
    vColor = instanceColor;
}

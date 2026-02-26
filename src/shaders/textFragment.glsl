precision highp float;

uniform sampler2D atlasTexture;

varying vec2 vUv;
varying vec3 vColor;
varying float vGroupAlpha;

void main() {
    vec4 texColor = texture2D(atlasTexture, vUv);

    // Apply instance color and group alpha
    gl_FragColor = texColor * vec4(vColor, vGroupAlpha);

    // Discard transparent pixels (clean edges + group visibility)
    if (gl_FragColor.a < 0.01) discard;
}

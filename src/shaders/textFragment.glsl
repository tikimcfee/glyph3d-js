precision highp float;

uniform sampler2D atlasTexture;

varying vec2 vUv;
varying vec3 vColor;

void main() {
    vec4 texColor = texture2D(atlasTexture, vUv);
    gl_FragColor = texColor * vec4(vColor, 1.0);

    // Discard transparent pixels
    if (gl_FragColor.a < 0.01) discard;
}

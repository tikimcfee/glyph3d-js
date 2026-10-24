/**
 * glyphMaterial.js — WebGL2 (GLSL 3.00 ES) Slug Vector Glyph Shader & Material.
 *
 * Combines the proven WebGL2 GLSL3 foundation from commit da5fbe9 with the latest
 * advances from glyph3d-rs/crates/glyph-field-instanced/shaders/glyph_field.wgsl:
 * - 32-byte RenderSlot vertex input (pos, glyph_id, color, group_id, advance, height).
 * - Dobbie / Lengyel "Slug" quadratic Bézier analytic winding coverage with stable roots.
 * - Near-horizontal line guard to eliminate vertical line artifacts.
 * - Greeking: under GLYPH_GREEK_PX_DEFAULT px tall a glyph is a bar where its ink would be.
 * - Full rigid TRS group transforms (offset, quaternion rotation, scale, clip).
 * - Deterministic, flicker-free rendering in standard WebGL2 (THREE.ShaderMaterial).
 */

import * as THREE from 'three';
import { TEXTURE_WIDTH } from '../shaping/slug-constants.js';

export const GROUP_STRIDE = 6; // vec4s per group row: [offset, quat, color, scale, clip, bg_color]

const VERTEX_SHADER = `
precision highp float;
precision highp int;

// Base quad geometry (unit plane)
in vec3 position;
in vec2 uv;

// 32-byte RenderSlot instanced attributes
in vec3 aPos;       // lanes 0..2: world pen origin (left edge, cell vertical center)
in float aGlyphId;  // lane 3: global slot index into glyphMapTexture
in float aColor;    // lane 4: packed RGB888 value (alpha comes from the group table)
in float aGroupId;  // lane 5: group table row
in vec2 aExtent;    // lanes 6..7: advance, height (world units)

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

uniform highp usampler2D glyphMapTexture;
uniform int glyphMapWidth;

// Group transform table: 6 columns x maxGroups rows (Float DataTexture)
// col 0: offset.xyz (w free)
// col 1: rotation quaternion xyzw
// col 2: color.rgb + alpha
// col 3: scale.xyz + colorBlend (w)
// col 4: clipTop, clipBottom, clipEnabled
// col 5: bg_color.rgba
uniform sampler2D groupTexture;
uniform int maxGroups;

// Optional per-glyph highlight: RGBA8 DataTexture (1024 wide, wrapped)
uniform sampler2D highlightTexture;
uniform int hasHighlight;

flat out int vCurveStart;
flat out int vCurveCount;
flat out int vMode;
flat out int vEmojiCell;
out vec2 vGlyphUV;
out vec3 vColor;
out float vGroupAlpha;
out vec3 vAddedColor;
out float vFillAmount;
out vec4 vBgColor;
out vec3 vGroupRgb;

void main() {
    int gid = int(aGlyphId + 0.5);
    int mapW = glyphMapWidth > 0 ? glyphMapWidth : 1024;
    uvec4 info = texelFetch(glyphMapTexture, ivec2(gid % mapW, gid / mapW), 0);

    vCurveStart = int(info.x);
    vCurveCount = int(info.y);
    vMode       = int(info.z); // 0 = slug vector, 1 = bitmap emoji, 2 = blank
    vEmojiCell  = int(info.w);

    // Quad sizing: bitmap emoji get square quad (height x height); outline gets advance
    float quadW = (vMode == 1) ? aExtent.y : aExtent.x;

    // Local quad: pen origin is at left edge (x=0) and cell vertical center (y=0)
    // uv runs [0..1, 0..1]
    vec3 aligned = vec3(uv.x * quadW, (uv.y - 0.5) * aExtent.y, 0.0) + aPos;

    // Group transform lookup via texelFetch
    int grow = clamp(int(aGroupId + 0.5), 0, maxGroups - 1);
    vec4 gPos   = texelFetch(groupTexture, ivec2(0, grow), 0); // col 0
    vec4 gQuat  = texelFetch(groupTexture, ivec2(1, grow), 0); // col 1: quaternion xyzw
    vec4 gColor = texelFetch(groupTexture, ivec2(2, grow), 0); // col 2: color.rgb + alpha
    vec4 gScale = texelFetch(groupTexture, ivec2(3, grow), 0); // col 3: scale.xyz + colorBlend
    vec4 gClip  = texelFetch(groupTexture, ivec2(4, grow), 0); // col 4: clipTop, clipBottom, clipEnabled
    vec4 gBg    = texelFetch(groupTexture, ivec2(5, grow), 0); // col 5: bg_color

    // World transform: rotate(quat, aligned * groupScale) + groupOffset
    vec3 local = aligned * gScale.xyz;
    // Quaternion sandwich: v' = v + 2 * cross(q.xyz, cross(q.xyz, v) + q.w * v)
    vec3 qc = cross(gQuat.xyz, local) + local * gQuat.w;
    vec3 posed = local + 2.0 * cross(gQuat.xyz, qc);
    vec3 worldPos = posed + gPos.xyz;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);

    // Culling: degenerate invisible groups or clipped rows outside NDC (z/w = 2.0 > 1.0)
    if (int(aGroupId + 0.5) >= maxGroups || gColor.a <= 0.01) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    }
    if (gClip.z > 0.5 && (aPos.y > gClip.x || aPos.y < gClip.y)) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    }

    // Unpack 24-bit packed color (little-endian RGB888 in float)
    int uCol = int(aColor + 0.5);
    vec3 iColor = vec3(
        float(uCol & 0xFF),
        float((uCol >> 8) & 0xFF),
        float((uCol >> 16) & 0xFF)
    ) / 255.0;

    // Blend instance color with group color (gScale.w: 0 = multiply, 1 = replace)
    vec3 baseColor = iColor * gColor.rgb;
    vColor = baseColor + (gColor.rgb - baseColor) * gScale.w;
    vGroupAlpha = gColor.a;
    vGroupRgb = gColor.rgb;
    vBgColor = gBg;

    // Per-glyph highlight
    if (hasHighlight > 0) {
        int hx = gl_InstanceID % 1024;
        int hy = gl_InstanceID / 1024;
        vec4 hl = texelFetch(highlightTexture, ivec2(hx, hy), 0);
        vAddedColor = hl.rgb;
        vFillAmount = hl.a;
    } else {
        vAddedColor = vec3(0.0);
        vFillAmount = 0.0;
    }

    vGlyphUV = uv;
}
`;

const FRAGMENT_SHADER = `
precision highp float;
precision highp int;

#define MAX_CURVES 256
#define GREEK_BAR_LO 0.27
#define GREEK_BAR_HI 0.47

uniform highp usampler2D curveTexture;
uniform sampler2D emojiTexture;
uniform int emojiCols;
uniform int emojiRows;

// Greeking: a glyph whose quad is under this many px tall on screen draws as a bar (0 = never)
uniform float uGreekPx;

flat in int vCurveStart;
flat in int vCurveCount;
flat in int vMode;
flat in int vEmojiCell;
in vec2 vGlyphUV;
in vec3 vColor;
in float vGroupAlpha;
in vec3 vAddedColor;
in float vFillAmount;
in vec4 vBgColor;
in vec3 vGroupRgb;

out vec4 fragColor;

// Rotate 90° so +X ray becomes +Y ray
vec2 rot90(vec2 v) {
    return vec2(v.y, -v.x);
}

// Analytic quadratic Bézier coverage along +X ray with stable root solving
float computeCoverage(float invDiameter, vec2 p0, vec2 p1, vec2 p2) {
    if ((p0.y > 0.0 && p1.y > 0.0 && p2.y > 0.0) || (p0.y < 0.0 && p1.y < 0.0 && p2.y < 0.0)) {
        return 0.0;
    }

    vec2 a = p0 - 2.0 * p1 + p2;
    vec2 b = p0 - p1;
    vec2 c = p0;

    float t0 = -1.0;
    float t1 = -1.0;
    bool solvable = true;

    if (abs(a.y) >= 1e-5) {
        float radicand = b.y * b.y - a.y * c.y;
        if (radicand > 0.0) {
            float s = sqrt(radicand);
            float q = b.y + (b.y >= 0.0 ? s : -s);
            if (b.y >= 0.0) {
                t0 = c.y / q;
                t1 = q / a.y;
            } else {
                t0 = q / a.y;
                t1 = c.y / q;
            }
        } else {
            solvable = false;
        }
    } else {
        float denom = p0.y - p2.y;
        if (abs(denom) >= 1e-6) {
            float t = p0.y / denom;
            if (p0.y < p2.y) {
                t0 = -1.0;
                t1 = t;
            } else {
                t0 = t;
                t1 = -1.0;
            }
        } else {
            solvable = false;
        }
    }

    float result = 0.0;
    if (solvable) {
        if (t0 >= 0.0 && t0 < 1.0) {
            float x = (a.x * t0 - 2.0 * b.x) * t0 + c.x;
            result += clamp(x * invDiameter + 0.5, 0.0, 1.0);
        }
        if (t1 >= 0.0 && t1 < 1.0) {
            float x = (a.x * t1 - 2.0 * b.x) * t1 + c.x;
            result -= clamp(x * invDiameter + 0.5, 0.0, 1.0);
        }
    }
    return result;
}

void main() {
    // Mode 2: blank cell
    if (vMode == 2) discard;

    // ── Bitmap / emoji branch (vMode == 1) ──────────────────────────
    if (vMode == 1) {
        float cols = float(emojiCols > 0 ? emojiCols : 16);
        float rows = float(emojiRows > 0 ? emojiRows : 16);
        float fcell = float(vEmojiCell);
        float col = mod(fcell, cols);
        float row = floor(fcell / cols);
        vec2 atlasUV = vec2(
            (col + vGlyphUV.x) / cols,
            (row + (1.0 - vGlyphUV.y)) / rows
        );
        vec4 texel = texture(emojiTexture, atlasUV);
        if (texel.a < 0.01) {
            if (vBgColor.a <= 0.0 && vFillAmount <= 0.0) discard;
            float bgAlpha = max(vFillAmount, vBgColor.a) * vGroupAlpha;
            if (bgAlpha <= 0.0) discard;
            vec3 fillRgb = vFillAmount > 0.0 ? vAddedColor : vBgColor.rgb;
            fragColor = vec4(pow(fillRgb, vec3(2.2)) * bgAlpha, bgAlpha);
            return;
        }

        vec3 rgb = texel.rgb;
        if (vFillAmount > 0.0) {
            rgb = mix(rgb, vAddedColor, vFillAmount);
        } else if (length(vAddedColor) > 0.0) {
            rgb = clamp(rgb + vAddedColor, 0.0, 1.0);
        }
        vec3 linearRgb = pow(rgb, vec3(2.2));
        float outAlpha = texel.a * vGroupAlpha;

        if (vBgColor.a <= 0.0 && vFillAmount <= 0.0) {
            fragColor = vec4(linearRgb * outAlpha, outAlpha);
            return;
        }

        float bgAlpha = max(vBgColor.a, vFillAmount) * vGroupAlpha;
        vec3 bgRgb = pow(vFillAmount > 0.0 ? vAddedColor : vBgColor.rgb, vec3(2.2)) * bgAlpha;
        float finalAlpha = outAlpha + bgAlpha * (1.0 - outAlpha);
        vec3 finalRgb = (linearRgb * outAlpha) + bgRgb * (1.0 - outAlpha);
        fragColor = vec4(finalRgb, finalAlpha);
        return;
    }

    // ── Slug vector outline branch (vMode == 0) ─────────────────────
    if (vCurveCount == 0 && vFillAmount <= 0.0 && vBgColor.a <= 0.0) discard;

    vec2 fw = fwidth(vGlyphUV);

    // The tiers: under uGreekPx tall on screen a glyph is a bar where its ink would be (continuous
    // across a word, the full cell wide); above it, exact coverage. The bar is a band through the
    // x-height, GREEK_BAR_LO..HI of the cell — as much ink as code text carries, so the swap
    // keeps the page's brightness.
    bool greek = uGreekPx > 0.0 && 1.0 / max(fw.y, 1e-4) < uGreekPx;

    float cov = 0.0;
    if (greek) {
        float dy = max(fw.y, 1e-4);
        float yCov = clamp((vGlyphUV.y - GREEK_BAR_LO) / dy + 0.5, 0.0, 1.0)
                   - clamp((vGlyphUV.y - GREEK_BAR_HI) / dy + 0.5, 0.0, 1.0);
        float dx = max(fw.x, 1e-4);
        float xCov = clamp((vGlyphUV.x - 0.0) / dx + 0.5, 0.0, 1.0)
                   - clamp((vGlyphUV.x - 1.0) / dx + 0.5, 0.0, 1.0);
        cov = clamp(xCov * yCov, 0.0, 1.0);
    } else {
        // Fractional winding along +X and +Y rays, each scaled to one pixel's footprint.
        vec2 invD = vec2(1.0) / fw;
        float coverage = 0.0;
        int n = min(vCurveCount, MAX_CURVES);
        for (int i = 0; i < n; i++) {
            int ci = (vCurveStart + i) * 2;
            uvec4 t0 = texelFetch(curveTexture, ivec2(ci % 1024, ci / 1024), 0);
            uvec4 t1 = texelFetch(curveTexture, ivec2((ci + 1) % 1024, (ci + 1) / 1024), 0);

            vec2 p0 = vec2(float(t0.x), float(t0.y)) / 65535.0 - vGlyphUV;
            vec2 p1 = vec2(float(t0.z), float(t0.w)) / 65535.0 - vGlyphUV;
            vec2 p2 = vec2(float(t1.x), float(t1.y)) / 65535.0 - vGlyphUV;

            coverage += computeCoverage(invD.x, p0, p1, p2);
            coverage += computeCoverage(invD.y, rot90(p0), rot90(p1), rot90(p2));
        }
        cov = clamp(coverage * 0.5, 0.0, 1.0);
    }

    float outAlpha = max(cov, vFillAmount) * vGroupAlpha;
    if (outAlpha <= 0.0 && vBgColor.a <= 0.0) discard;

    // Highlight composition, in straight colour: the ink plus its additive tint, or (a fill)
    // the ink over the fill colour by coverage. Coverage enters ONCE, as alpha, below.
    bool isFill = vFillAmount > 0.0;
    vec3 compositeRgb = isFill ? mix(vAddedColor, vColor, cov) : clamp(vColor + vAddedColor, 0.0, 1.0);

    // Linear sRGB decode, premultiplied (the material blends ONE, ONE_MINUS_SRC_ALPHA)
    vec3 rgb = pow(compositeRgb, vec3(2.2)) * outAlpha;

    if (vBgColor.a <= 0.0) {
        fragColor = vec4(rgb, outAlpha);
        return;
    }

    // Background color composition
    float bgAlpha = vBgColor.a * vGroupAlpha;
    if (outAlpha <= 0.0 && bgAlpha <= 0.0) discard;

    vec3 bgRgb = pow(vBgColor.rgb, vec3(2.2)) * bgAlpha;
    float finalAlpha = outAlpha + bgAlpha * (1.0 - outAlpha);
    vec3 finalRgb = rgb + bgRgb * (1.0 - outAlpha);
    fragColor = vec4(finalRgb, finalAlpha);
}
`;

/**
 * Create a placeholder 1x1 RGBAInteger texture.
 */
function makePlaceholderUintTexture() {
    const tex = new THREE.DataTexture(
        new Uint32Array(4), 1, 1,
        THREE.RGBAIntegerFormat, THREE.UnsignedIntType
    );
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
}

/**
 * Create a placeholder 1x1 RGBA filterable texture.
 */
function makePlaceholderRGBATexture() {
    const tex = new THREE.DataTexture(
        new Uint8Array(4), 1, 1,
        THREE.RGBAFormat, THREE.UnsignedByteType
    );
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
}

/**
 * Greeking — a glyph whose quad is under this many px tall on screen draws as a bar where its
 * ink would be, and skips the curve loop. Glyphs above it draw exact; fields whose rows are under
 * a pixel are GlyphFarLod's (one box each). 0 = never greek.
 */
export const GLYPH_GREEK_PX_DEFAULT = 8;

const _activeMaterials = new Set();
let _greekPx = GLYPH_GREEK_PX_DEFAULT;

/** Set the greeking size live on every glyph material (and those created after). */
export function setGlyphGreekPx(px) {
    if (!Number.isFinite(px) || px < 0) throw new Error(`setGlyphGreekPx: want a size ≥ 0 px, got ${px}`);
    _greekPx = px;
    for (const mat of _activeMaterials) mat.uniforms.uGreekPx.value = px;
}

export function getGlyphGreekPx() {
    return _greekPx;
}

/**
 * Create a WebGL2 Slug Vector Glyph Material.
 *
 * @param {Object} [options]
 * @param {THREE.DataTexture} [options.curveTexture]
 * @param {THREE.DataTexture} [options.glyphMapTexture]
 * @param {THREE.DataTexture} [options.groupTexture]
 * @param {number} [options.maxGroups=64]
 * @returns {THREE.RawShaderMaterial}
 */
export function createGlyphMaterial(options = {}) {
    const curveTex = options.curveTexture || makePlaceholderUintTexture();
    const glyphMapTex = options.glyphMapTexture || makePlaceholderUintTexture();
    const emojiTex = options.emojiTexture || makePlaceholderRGBATexture();
    const maxGroups = options.maxGroups || 64;

    const uniforms = {
        curveTexture: { value: curveTex },
        glyphMapTexture: { value: glyphMapTex },
        glyphMapWidth: { value: glyphMapTex.image?.width || TEXTURE_WIDTH },
        groupTexture: { value: options.groupTexture || null },
        maxGroups: { value: maxGroups },
        emojiTexture: { value: emojiTex },
        emojiCols: { value: options.emojiCols || 16 },
        emojiRows: { value: options.emojiRows || 16 },
        highlightTexture: { value: null },
        hasHighlight: { value: 0 },
        uGreekPx: { value: _greekPx },
    };

    const material = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms,
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        transparent: true,
        premultipliedAlpha: true,   // the fragment writes linear rgb × alpha
        depthWrite: true,
        depthTest: true,
        side: THREE.DoubleSide,
        forceSinglePass: true,   // planar quads: three's back/front two-pass would only re-derive the program twice per draw
    });

    _activeMaterials.add(material);
    material.addEventListener('dispose', () => {
        _activeMaterials.delete(material);
    });

    return material;
}


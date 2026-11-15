/**
 * glyphMaterial.js — WebGL2 (GLSL 3.00 ES) Slug Vector Glyph Shader & Materials.
 *
 * Combines the proven WebGL2 GLSL3 foundation from commit da5fbe9 with the latest
 * advances from glyph3d-rs/crates/glyph-field-instanced/shaders/glyph_field.wgsl:
 * - 32-byte RenderSlot vertex input (pos, glyph_id, color, group_id + style, advance, height).
 * - Dobbie / Lengyel "Slug" quadratic Bézier analytic winding coverage with stable roots.
 * - Near-horizontal line guard to eliminate vertical line artifacts.
 * - Greeking: under GLYPH_GREEK_PX_DEFAULT px tall a glyph is a bar where its ink would be.
 * - Full rigid TRS group transforms (offset, quaternion rotation, scale, clip).
 * - Deterministic, flicker-free rendering in standard WebGL2 (THREE.ShaderMaterial).
 *
 * TWO materials draw one field's slots, from the same geometry, buffers and textures:
 *   - the FILL material (createGlyphFillMaterial) draws each cell's background — the highlight
 *     texel's fill, else the group's background — as the cell's whole rectangle, flat. A cell with
 *     no fill is collapsed in the vertex stage: it costs no fragment. It draws FIRST (the field's
 *     mesh lists it as its first geometry group), so no cell's fill can cover a neighbour's ink: a
 *     wide glyph keeps the half that lies over the next cell.
 *   - the INK material (createGlyphMaterial) draws the glyph and the lines the cell draws itself
 *     (underline, strikethrough, overline), over whatever is behind. A cell with neither is
 *     collapsed in the vertex stage.
 * Both end their vertex stage in the same expression (`invariant gl_Position`), so a cell's fill
 * and ink have the same depth.
 *
 * Drawn to the cell: a SPRITE glyph (glyph-map mode 3: box drawing, blocks, braille… generated to
 * the cell by shaping/cellSprites.js) and the cell's own lines count a pixel's coverage over the
 * part of the pixel that lies INSIDE the cell. A pixel belongs to one cell (the rasterizer's rule;
 * under MSAA, each sample does), so two cells whose shapes meet at their shared edge both report
 * full coverage there and the edge shows no seam — at any zoom, with no pixel snapping. (The
 * shapes cannot overlap past the cell instead: curve coordinates and the quad both end at it, and
 * an overlap would blend a translucent edge twice.)
 *
 * Colour (docs/architecture/rendering.md "Colour"): the lanes — slot colour, group colour and
 * background, highlight, decoration — hold sRGB, what a program, a theme or a setting specifies;
 * the emoji atlas is an sRGB texture. The fragment takes each to the renderer's output encoding
 * through three's colour management (`laneOut`; the sampler and `linearToOutputTexel` for an
 * emoji) and applies tint and coverage to the encoded colour — the space WebGL blends the canvas
 * in, so a glyph's edge weighs the same over its own cell fill as over the panel behind it. At
 * full coverage the canvas holds the specified colour.
 */

import * as THREE from 'three';
import { TEXTURE_WIDTH } from '../shaping/slug-constants.js';
import { GROUP_ID_BITS } from './InstancedSlotBuffer.js';
import {
    STYLE_DIM, STYLE_STRIKE, STYLE_OVERLINE, STYLE_UNDERLINE_SHIFT, STYLE_UNDERLINE_COLOR, STYLE_LINES, UNDERLINE,
} from './cellAttrs.js';

export const GROUP_STRIDE = 6; // vec4s per group row: [offset, quat, color, scale, clip, bg_color]

/** Glyph-map modes (the texel's third value). */
export const GLYPH_MODE = Object.freeze({ SLUG: 0, BITMAP: 1, BLANK: 2, SPRITE: 3 });

// What both vertex stages share: the slot attributes, the group table, and the pose of a cell
// quad. three's ShaderMaterial prefix declares the base quad's position / uv and the camera
// matrices.
const VERTEX_COMMON = `
invariant gl_Position;

// 32-byte RenderSlot instanced attributes
in vec3 aPos;       // lanes 0..2: world pen origin (left edge, cell vertical center)
in float aGlyphId;  // lane 3: global slot index into glyphMapTexture
in float aColor;    // lane 4: packed RGB888 value (alpha comes from the group table)
in float aGroupId;  // lane 5: group table row (low ${GROUP_ID_BITS} bits) + the cell's style byte above it
in vec2 aExtent;    // lanes 6..7: advance, height (world units)

// Group transform table: 6 columns x maxGroups rows (Float DataTexture)
// col 0: offset.xyz (w free)
// col 1: rotation quaternion xyzw
// col 2: color.rgb + alpha
// col 3: scale.xyz + colorBlend (w)
// col 4: clipTop, clipBottom, clipEnabled
// col 5: bg_color.rgba
uniform sampler2D groupTexture;
uniform int maxGroups;

// Per-slot highlight: RGBA8 DataTexture (1024 wide, wrapped). Alpha > 0: a cell fill of that
// colour and opacity (the fill pass). Alpha 0 with a colour: an additive tint on the ink.
uniform sampler2D highlightTexture;
uniform int hasHighlight;

const vec4 OFFSCREEN = vec4(2.0, 2.0, 2.0, 1.0);   // outside NDC: the quad draws nothing

// The lane holds exact integers. round() keeps them: int(x + 0.5) is a tie from 2^23 up (a
// float32's step is 1 there) and rounds to even — every odd value gains 1.
int laneInt(float v) { return int(round(v)); }

vec4 slotHighlight() {
    if (hasHighlight <= 0) return vec4(0.0);
    return texelFetch(highlightTexture, ivec2(gl_InstanceID % 1024, gl_InstanceID / 1024), 0);
}

// A cell quad's corner, posed by its group row: rotate(quat, corner * groupScale) + groupOffset.
// Returns false for a quad that draws nothing (a dead or hidden group, a clipped row).
bool poseCell(float quadW, out vec4 gColor, out vec4 gScale, out vec4 gBg) {
    int row = laneInt(aGroupId) & ${(1 << GROUP_ID_BITS) - 1};
    if (row >= maxGroups) { gl_Position = OFFSCREEN; return false; }
    vec4 gPos   = texelFetch(groupTexture, ivec2(0, row), 0);
    vec4 gQuat  = texelFetch(groupTexture, ivec2(1, row), 0);
    gColor      = texelFetch(groupTexture, ivec2(2, row), 0);
    gScale      = texelFetch(groupTexture, ivec2(3, row), 0);
    vec4 gClip  = texelFetch(groupTexture, ivec2(4, row), 0);
    gBg         = texelFetch(groupTexture, ivec2(5, row), 0);
    if (gColor.a <= 0.01 || (gClip.z > 0.5 && (aPos.y > gClip.x || aPos.y < gClip.y))) {
        gl_Position = OFFSCREEN;
        return false;
    }
    // Local quad: pen origin is at left edge (x=0) and cell vertical center (y=0); uv runs [0..1]
    vec3 aligned = vec3(uv.x * quadW, (uv.y - 0.5) * aExtent.y, 0.0) + aPos;
    vec3 local = aligned * gScale.xyz;
    // Quaternion sandwich: v' = v + 2 * cross(q.xyz, cross(q.xyz, v) + q.w * v)
    vec3 qc = cross(gQuat.xyz, local) + local * gQuat.w;
    vec3 posed = local + 2.0 * cross(gQuat.xyz, qc);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(posed + gPos.xyz, 1.0);
    return true;
}
`;

const VERTEX_SHADER = `${VERTEX_COMMON}
uniform highp usampler2D glyphMapTexture;
uniform int glyphMapWidth;

// Per-slot decoration colour: RGBA8 DataTexture (1024 wide, wrapped) — an underline's own colour.
uniform sampler2D decorTexture;
uniform int hasDecor;

flat out int vCurveStart;
flat out int vCurveCount;
flat out int vMode;
flat out int vGlyphArg;     // mode 1: the emoji atlas cell · mode 3: the sprite's ink alpha, 0..255
flat out int vStyle;        // the cell's style byte (core/cellAttrs.js)
flat out vec3 vDecorColor;  // the underline's own colour (style bit 6)
flat out vec2 vCell;        // x: quad width / cell advance (an emoji's quad is wider) · y: advance / height
out vec2 vGlyphUV;
out vec3 vColor;
out float vGroupAlpha;
out vec3 vAddedColor;

void main() {
    int gid = laneInt(aGlyphId);
    int mapW = glyphMapWidth > 0 ? glyphMapWidth : 1024;
    uvec4 info = texelFetch(glyphMapTexture, ivec2(gid % mapW, gid / mapW), 0);

    vCurveStart = int(info.x);
    vCurveCount = int(info.y);
    vMode       = int(info.z); // 0 = slug vector, 1 = bitmap emoji, 2 = blank, 3 = cell sprite
    vGlyphArg   = int(info.w);
    vStyle      = laneInt(aGroupId) >> ${GROUP_ID_BITS};

    // Nothing to draw — no ink (a blank, a space, a glyph still being encoded) and no line: no
    // fragments. (The cell's fill is the fill pass's.)
    bool hasInk = vMode == 1 || (vMode != 2 && vCurveCount > 0);
    if (!hasInk && (vStyle & ${STYLE_LINES}) == 0) { gl_Position = OFFSCREEN; return; }

    // Quad sizing: bitmap emoji get square quad (height x height); outline gets advance
    float quadW = (vMode == 1) ? aExtent.y : aExtent.x;
    vec4 gColor, gScale, gBg;
    if (!poseCell(quadW, gColor, gScale, gBg)) return;

    // Unpack 24-bit packed color (little-endian RGB888 in float).
    int uCol = laneInt(aColor);
    vec3 iColor = vec3(
        float(uCol & 0xFF),
        float((uCol >> 8) & 0xFF),
        float((uCol >> 16) & 0xFF)
    ) / 255.0;

    // Blend instance color with group color (gScale.w: 0 = multiply, 1 = replace)
    vec3 baseColor = iColor * gColor.rgb;
    vColor = baseColor + (gColor.rgb - baseColor) * gScale.w;
    vGroupAlpha = gColor.a;

    // An additive tint: a highlight texel with a colour and no fill.
    vec4 hl = slotHighlight();
    vAddedColor = hl.a > 0.0 ? vec3(0.0) : hl.rgb;

    vDecorColor = vColor;
    if ((vStyle & ${STYLE_UNDERLINE_COLOR}) != 0 && hasDecor > 0) {
        vDecorColor = texelFetch(decorTexture, ivec2(gl_InstanceID % 1024, gl_InstanceID / 1024), 0).rgb;
    }
    vCell = vec2(quadW / max(aExtent.x, 1e-9), aExtent.x / max(aExtent.y, 1e-9));
    vGlyphUV = uv;
}
`;

const FRAGMENT_SHADER = `
#define MAX_CURVES 256
#define GREEK_BAR_LO 0.27
#define GREEK_BAR_HI 0.47
#define TAU 6.28318530718

uniform highp usampler2D curveTexture;
uniform sampler2D emojiTexture;
uniform int emojiCols;
uniform int emojiRows;

// Greeking: a glyph whose quad is under this many px tall on screen draws as a bar (0 = never)
uniform float uGreekPx;

// The lines a cell draws itself, in cell units (y up from the cell's bottom, 1 = its height):
//   uLineA: underline centre y · line thickness · strikethrough centre y · unused
//   uLineB: double underline's lower centre y · its upper centre y · curly centre y · curly amplitude
uniform vec4 uLineA;
uniform vec4 uLineB;
// Dim (SGR 2): the cell's ink and lines keep this much of their opacity.
uniform float uDimAlpha;

flat in int vCurveStart;
flat in int vCurveCount;
flat in int vMode;
flat in int vGlyphArg;
flat in int vStyle;
flat in vec3 vDecorColor;
flat in vec2 vCell;
in vec2 vGlyphUV;
in vec3 vColor;
in float vGroupAlpha;
in vec3 vAddedColor;

out vec4 fragColor;

// Rotate 90° so +X ray becomes +Y ray
vec2 rot90(vec2 v) {
    return vec2(v.y, -v.x);
}

// Analytic quadratic Bézier coverage along the +X ray with stable root solving. The pixel's
// footprint along the ray is the window [lo, lo + 1/invW] (relative to the ray's origin): a
// crossing at x covers clamp((x - lo) * invW) of it.
float computeCoverage(float lo, float invW, vec2 p0, vec2 p1, vec2 p2) {
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
            result += clamp((x - lo) * invW, 0.0, 1.0);
        }
        if (t1 >= 0.0 && t1 < 1.0) {
            float x = (a.x * t1 - 2.0 * b.x) * t1 + c.x;
            result -= clamp((x - lo) * invW, 0.0, 1.0);
        }
    }
    return result;
}

// A colour lane's value (sRGB, as specified) in the renderer's output encoding, through three's
// colour management: sRGB → the linear working space → the output. On the sRGB canvas that is
// the value it was given.
vec3 laneOut(vec3 srgb) {
    return linearToOutputTexel(sRGBTransferEOTF(vec4(srgb, 1.0))).rgb;
}

// How much of the window [lo, lo + 1/inv] the band [a, b] covers.
float band(float a, float b, float lo, float inv) {
    return clamp((b - lo) * inv, 0.0, 1.0) - clamp((a - lo) * inv, 0.0, 1.0);
}

// A pulse train (on while fract(u) < duty), averaged over a window d wide centred on u.
float pulseTrain(float u, float duty, float d) {
    float a = u - 0.5 * d, b = u + 0.5 * d;
    float fa = floor(a) * duty + min(fract(a), duty);
    float fb = floor(b) * duty + min(fract(b), duty);
    return (fb - fa) / max(d, 1e-6);
}

void main() {
    vec2 fw = max(fwidth(vGlyphUV), vec2(1e-6));   // before any branch: a derivative is defined only in uniform control flow

    vec3 fg = laneOut(vColor);
    vec3 ink = fg;      // the glyph's own colour, output-encoded, straight
    float cov = 0.0;    // how much of this pixel the glyph covers

    // The tiers: under uGreekPx tall on screen a glyph is a bar where its ink would be (continuous
    // across a word, the full cell wide); above it, exact coverage. A sprite is exact at every size
    // (a few curves, and a block or a rule is its own bar); the cell's lines draw in the exact tier.
    bool greek = uGreekPx > 0.0 && 1.0 / fw.y < uGreekPx;

    if (vMode == 1) {
        // ── Bitmap / emoji branch ───────────────────────────────────
        float cols = float(emojiCols > 0 ? emojiCols : 16);
        float rows = float(emojiRows > 0 ? emojiRows : 16);
        float fcell = float(vGlyphArg);
        float col = mod(fcell, cols);
        float row = floor(fcell / cols);
        vec2 atlasUV = vec2(
            (col + vGlyphUV.x) / cols,
            (row + (1.0 - vGlyphUV.y)) / rows
        );
        // An sRGB texture: the sampler hands back linear colour, straight alpha.
        vec4 texel = texture(emojiTexture, atlasUV);
        ink = linearToOutputTexel(texel).rgb;
        cov = texel.a;
    } else if (vCurveCount > 0) {
        // ── Slug vector outline branch ──────────────────────────────
        bool sprite = vMode == 3;
        if (greek && !sprite) {
            // The bar is a band through the x-height, GREEK_BAR_LO..HI of the cell — as much ink
            // as code text carries, so the swap keeps the page's brightness.
            float yCov = clamp((vGlyphUV.y - GREEK_BAR_LO) / fw.y + 0.5, 0.0, 1.0)
                       - clamp((vGlyphUV.y - GREEK_BAR_HI) / fw.y + 0.5, 0.0, 1.0);
            float xCov = clamp((vGlyphUV.x - 0.0) / fw.x + 0.5, 0.0, 1.0)
                       - clamp((vGlyphUV.x - 1.0) / fw.x + 0.5, 0.0, 1.0);
            cov = clamp(xCov * yCov, 0.0, 1.0);
        } else {
            // Fractional winding along +X and +Y rays, each over one pixel's footprint: the window
            // [at - fw/2, at + fw/2]. A sprite is drawn to its cell: its window is the part of the
            // pixel inside the cell, and its rays start inside it (a multisampled edge pixel's
            // centre may lie just outside the quad).
            vec2 at = vGlyphUV;
            vec2 lo = at - 0.5 * fw, hi = at + 0.5 * fw;
            if (sprite) {
                lo = max(lo, vec2(0.0));
                hi = min(hi, vec2(1.0));
                at = clamp(at, vec2(1e-4), vec2(1.0 - 1e-4));
            }
            vec2 invW = vec2(1.0) / max(hi - lo, vec2(1e-6));
            lo -= at;
            float coverage = 0.0;
            int n = min(vCurveCount, MAX_CURVES);
            for (int i = 0; i < n; i++) {
                int ci = (vCurveStart + i) * 2;
                uvec4 t0 = texelFetch(curveTexture, ivec2(ci % 1024, ci / 1024), 0);
                uvec4 t1 = texelFetch(curveTexture, ivec2((ci + 1) % 1024, (ci + 1) / 1024), 0);

                vec2 p0 = vec2(float(t0.x), float(t0.y)) / 65535.0 - at;
                vec2 p1 = vec2(float(t0.z), float(t0.w)) / 65535.0 - at;
                vec2 p2 = vec2(float(t1.x), float(t1.y)) / 65535.0 - at;

                coverage += computeCoverage(lo.x, invW.x, p0, p1, p2);
                coverage += computeCoverage(lo.y, invW.y, rot90(p0), rot90(p1), rot90(p2));
            }
            // The non-zero winding rule, whichever way a contour runs: a font may wind some of
            // its contours the other way (Monaspace's combining accents, and so its é) and
            // overlap others (a variable font's strokes) — both are ink, as every rasterizer
            // fills them.
            cov = clamp(abs(coverage) * 0.5, 0.0, 1.0);
            if (sprite) cov *= float(vGlyphArg) / 255.0;
        }
    }

    // The highlight lane's additive tint (a texel with a colour and no fill).
    if (vAddedColor != vec3(0.0)) ink = min(ink + laneOut(vAddedColor), vec3(1.0));

    // Premultiplied (the material blends ONE, ONE_MINUS_SRC_ALPHA): the underline, then the
    // strikethrough and overline over it, then the ink over both.
    vec3 pre = vec3(0.0);
    float alpha = 0.0;

    // ── The lines the cell draws itself ──────────────────────────────
    // Bands across the whole cell, so a run of cells draws one unbroken line; their coverage is
    // counted over the part of the pixel inside the cell (as a sprite's is), and a line is never
    // thinner than a pixel.
    if (!greek && (vStyle & ${STYLE_LINES}) != 0) {
        float x = vGlyphUV.x * vCell.x;           // across the CELL (an emoji's quad is wider)
        float dx = fw.x * vCell.x;
        float inCell = step(x, 1.0 + 0.5 * dx);
        float y = vGlyphUV.y;
        float lo = max(y - 0.5 * fw.y, 0.0);
        float inv = 1.0 / max(min(y + 0.5 * fw.y, 1.0) - lo, 1e-6);
        float t = max(uLineA.y, fw.y);
        float h = 0.5 * t;

        int ul = (vStyle >> ${STYLE_UNDERLINE_SHIFT}) & 7;
        float ulCov = 0.0;
        if (ul == ${UNDERLINE.SINGLE} || ul == ${UNDERLINE.DOTTED} || ul == ${UNDERLINE.DASHED}) {
            float c = max(uLineA.x, h);
            ulCov = band(c - h, c + h, lo, inv);
            if (ul == ${UNDERLINE.DOTTED}) {
                // Dots as long as the line is thick, as many as fit the cell evenly.
                float n = max(1.0, floor(vCell.y / (2.0 * t) + 0.5));
                ulCov *= pulseTrain(x * n, 0.5, dx * n);
            } else if (ul == ${UNDERLINE.DASHED}) {
                // A third of the cell open in its middle: the dashes join across cell edges.
                ulCov *= pulseTrain(x + 1.0 / 3.0, 2.0 / 3.0, dx);
            }
        } else if (ul == ${UNDERLINE.DOUBLE}) {
            float c0 = max(uLineB.x, h);
            float c1 = max(uLineB.y, c0 + 2.0 * t);
            ulCov = band(c0 - h, c0 + h, lo, inv) + band(c1 - h, c1 + h, lo, inv);
        } else if (ul == ${UNDERLINE.CURLY}) {
            // One wave per cell (so it joins across cells), by distance to the curve in pixels.
            float amp = max(uLineB.w, 0.5 * fw.y);
            float w = TAU * x;
            float cy = max(uLineB.z, amp + h) + amp * sin(w);
            float slope = amp * TAU * cos(w) * dx / fw.y;
            float dist = abs(y - cy) / fw.y / sqrt(1.0 + slope * slope);
            ulCov = clamp(0.5 + h / fw.y - dist, 0.0, 1.0);
        }
        ulCov = clamp(ulCov, 0.0, 1.0) * inCell;
        pre = laneOut(vDecorColor) * ulCov;
        alpha = ulCov;

        float lineCov = 0.0;
        if ((vStyle & ${STYLE_STRIKE}) != 0) lineCov = band(uLineA.z - h, uLineA.z + h, lo, inv);
        if ((vStyle & ${STYLE_OVERLINE}) != 0) lineCov = max(lineCov, band(1.0 - t, 1.0, lo, inv));
        lineCov *= inCell;
        pre = fg * lineCov + pre * (1.0 - lineCov);
        alpha = lineCov + alpha * (1.0 - lineCov);
    }

    pre = ink * cov + pre * (1.0 - cov);
    alpha = cov + alpha * (1.0 - cov);

    float keep = vGroupAlpha * ((vStyle & ${STYLE_DIM}) != 0 ? uDimAlpha : 1.0);
    alpha *= keep;
    if (alpha <= 0.0) discard;
    fragColor = vec4(pre * keep, alpha);
}
`;

const FILL_VERTEX_SHADER = `${VERTEX_COMMON}
flat out vec4 vFill;   // the cell's fill: sRGB colour, opacity

void main() {
    vec4 gColor, gScale, gBg;
    if (!poseCell(aExtent.x, gColor, gScale, gBg)) return;
    vec4 hl = slotHighlight();
    vec4 fill = hl.a > 0.0 ? hl : gBg;
    if (fill.a <= 0.0) { gl_Position = OFFSCREEN; return; }   // no fill: no fragments
    vFill = vec4(fill.rgb, fill.a * gColor.a);
}
`;

const FILL_FRAGMENT_SHADER = `
flat in vec4 vFill;
out vec4 fragColor;

void main() {
    // Premultiplied; the lane's sRGB through three's colour management to the output encoding.
    fragColor = vec4(linearToOutputTexel(sRGBTransferEOTF(vec4(vFill.rgb, 1.0))).rgb * vFill.a, vFill.a);
}
`;

// The placeholders a material reads before its real textures exist (an atlas still loading, no
// emoji): ONE of each kind for every material — shared, never disposed — instead of a
// fresh 1×1 per field (thousands of texture objects, each a GPU texture once drawn, none freed).
let _placeholderUint = null;
let _placeholderRGBA = null;

/** The shared 1×1 RGBAInteger placeholder (curve / glyph-map slots before an atlas). */
export function glyphPlaceholderUint() { return (_placeholderUint ??= makePlaceholderUintTexture()); }

/** The shared 1×1 RGBA placeholder (the emoji slot with nothing to show). */
export function glyphPlaceholderRGBA() { return (_placeholderRGBA ??= makePlaceholderRGBATexture()); }

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

/**
 * The cell's own lines and dim, as a person tunes them (Settings ▸ Display, `wall.config`):
 *   lineThickness   × the font's underline thickness, for underline, strikethrough and overline
 *   underlineRaise  lifts the underline from where the font puts it, in cell heights (0.05 = a
 *                   twentieth of a line up; the font's own place can sit under the descenders)
 *   curlyAmplitude  the curly underline's wave height, × the line's thickness
 *   dimAlpha        how much of its opacity dim (SGR 2) text keeps
 */
export const GLYPH_LINE_DEFAULTS = Object.freeze({ lineThickness: 1, underlineRaise: 0, curlyAmplitude: 1.5, dimAlpha: 0.5 });

const _activeMaterials = new Set();
let _greekPx = GLYPH_GREEK_PX_DEFAULT;
const _lineStyle = { ...GLYPH_LINE_DEFAULTS };
/**
 * Where the font puts its lines, in cell units (y up from the cell's bottom, 1 = the cell's
 * height). These stand in until bootGlyphEngine reads the real ones off the primary font
 * (FontChain.lineMetrics → setGlyphLineMetrics), as GlyphAtlas.getCharSize's guess does.
 */
const _lineMetrics = { underlineY: 0.12, strikeY: 0.42, thickness: 0.05 };
const _lineA = new THREE.Vector4();
const _lineB = new THREE.Vector4();

/**
 * @private A material's OWN line metrics (a field drawing in another font family than the
 * default: InstancedField.setLineMetrics) and the two vectors its uniforms then hold.
 * @type {WeakMap<THREE.ShaderMaterial, { metrics: { underlineY: number, strikeY: number, thickness: number }, a: THREE.Vector4, b: THREE.Vector4 }>}
 */
const _ownLines = new WeakMap();

/** @private Fold a font's line metrics and the tuning into the two line uniforms' vectors. */
function foldLines(metrics, a, b) {
    const t = metrics.thickness * _lineStyle.lineThickness;
    const underlineY = Math.min(1 - t / 2, Math.max(metrics.underlineY + _lineStyle.underlineRaise, t / 2));
    const amp = t * _lineStyle.curlyAmplitude;
    const lower = Math.max(underlineY - t, t / 2);
    a.set(underlineY, t, metrics.strikeY, 0);
    b.set(lower, lower + 2 * t, Math.max(underlineY, amp + t / 2), amp);
}

/** @private Refresh the shared line uniforms (the default family's), every material's own, and dim. */
function refreshLines() {
    foldLines(_lineMetrics, _lineA, _lineB);
    for (const mat of _activeMaterials) {
        mat.uniforms.uDimAlpha.value = _lineStyle.dimAlpha;
        const own = _ownLines.get(mat);
        if (own) foldLines(own.metrics, own.a, own.b);
    }
}
refreshLines();

/** @private Throw unless `m` is a set of line metrics in cell units. */
function checkLineMetrics(m, who) {
    for (const k of ['underlineY', 'strikeY', 'thickness']) {
        if (!Number.isFinite(m?.[k]) || m[k] < 0 || m[k] > 1) throw new Error(`${who}: ${k} is a fraction of the cell's height, got ${m?.[k]}`);
        if (k === 'thickness' && !(m[k] > 0)) throw new Error(`${who}: thickness must be > 0, got ${m[k]}`);
    }
}

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
 * Where the font draws its lines — the centre of its underline and of its strikethrough, and
 * their thickness — in cell units (y up from the cell's bottom, 1 = the cell's height). Live on
 * every glyph material.
 * @param {{ underlineY: number, strikeY: number, thickness: number }} m
 */
export function setGlyphLineMetrics(m) {
    checkLineMetrics(m, 'setGlyphLineMetrics');
    _lineMetrics.underlineY = m.underlineY;
    _lineMetrics.strikeY = m.strikeY;
    _lineMetrics.thickness = m.thickness;
    refreshLines();
}

/**
 * Give ONE ink material its own line metrics — a field whose cells are another font family's
 * (its underline and strikethrough sit where that family's font puts them); the tuning
 * (setGlyphLineStyle) still applies. `null` hands it back to the shared ones.
 * @param {THREE.ShaderMaterial} material  an ink material (createGlyphMaterial)
 * @param {{ underlineY: number, strikeY: number, thickness: number }|null} m
 */
export function setMaterialLineMetrics(material, m) {
    if (!material?.uniforms?.uLineA) throw new Error('setMaterialLineMetrics: not a glyph ink material');
    if (m === null) {
        _ownLines.delete(material);
        material.uniforms.uLineA.value = _lineA;
        material.uniforms.uLineB.value = _lineB;
        return;
    }
    checkLineMetrics(m, 'setMaterialLineMetrics');
    let own = _ownLines.get(material);
    if (!own) {
        own = { metrics: { underlineY: 0, strikeY: 0, thickness: 0 }, a: new THREE.Vector4(), b: new THREE.Vector4() };
        _ownLines.set(material, own);
        material.uniforms.uLineA.value = own.a;
        material.uniforms.uLineB.value = own.b;
    }
    own.metrics.underlineY = m.underlineY;
    own.metrics.strikeY = m.strikeY;
    own.metrics.thickness = m.thickness;
    foldLines(own.metrics, own.a, own.b);
}

/** The line metrics in force (see setGlyphLineMetrics). */
export function getGlyphLineMetrics() {
    return { ..._lineMetrics };
}

/**
 * Tune the cell's own lines and dim live on every glyph material (see GLYPH_LINE_DEFAULTS); a
 * key left out keeps its value.
 * @param {{ lineThickness?: number, underlineRaise?: number, curlyAmplitude?: number, dimAlpha?: number }} style
 */
export function setGlyphLineStyle(style) {
    for (const [k, v] of Object.entries(style)) {
        if (!(k in GLYPH_LINE_DEFAULTS)) throw new Error(`setGlyphLineStyle: unknown key '${k}' (${Object.keys(GLYPH_LINE_DEFAULTS).join(', ')})`);
        if (!Number.isFinite(v) || (v < 0 && k !== 'underlineRaise')) throw new Error(`setGlyphLineStyle: ${k} takes a number${k === 'underlineRaise' ? '' : ' ≥ 0'}, got ${v}`);
        if (k === 'dimAlpha' && v > 1) throw new Error(`setGlyphLineStyle: dimAlpha is an opacity, 0..1, got ${v}`);
        _lineStyle[k] = v;
    }
    refreshLines();
}

/** The line tuning in force (see setGlyphLineStyle). */
export function getGlyphLineStyle() {
    return { ..._lineStyle };
}

/**
 * Create a WebGL2 Slug Vector Glyph Material: the INK pass (glyphs and the cell's own lines).
 *
 * @param {Object} [options]
 * @param {THREE.DataTexture} [options.curveTexture]
 * @param {THREE.DataTexture} [options.glyphMapTexture]
 * @param {THREE.DataTexture} [options.groupTexture]
 * @param {number} [options.maxGroups=1]  the group table's rows (its texture height)
 * @returns {THREE.ShaderMaterial}
 */
export function createGlyphMaterial(options = {}) {
    const curveTex = options.curveTexture || glyphPlaceholderUint();
    const glyphMapTex = options.glyphMapTexture || glyphPlaceholderUint();
    const emojiTex = options.emojiTexture || glyphPlaceholderRGBA();
    const maxGroups = options.maxGroups || 1;

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
        decorTexture: { value: null },
        hasDecor: { value: 0 },
        uGreekPx: { value: _greekPx },
        uLineA: { value: _lineA },   // shared (refreshLines writes them in place) unless the material has its own: setMaterialLineMetrics
        uLineB: { value: _lineB },
        uDimAlpha: { value: _lineStyle.dimAlpha },
    };

    const material = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms,
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        transparent: true,
        premultipliedAlpha: true,   // the fragment writes output-encoded rgb × alpha
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

/**
 * Create the FILL pass's material: each cell's background rectangle, from the same slots, group
 * table and highlight texture as the ink material it is paired with (InstancedField draws it
 * first). Born hidden (`visible = false`: three skips the draw) — its field shows it while any
 * cell has a fill.
 *
 * @param {Object} [options]
 * @param {THREE.DataTexture} [options.groupTexture]
 * @param {number} [options.maxGroups=1]
 * @param {THREE.DataTexture} [options.highlightTexture]
 * @returns {THREE.ShaderMaterial}
 */
export function createGlyphFillMaterial(options = {}) {
    const material = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
            groupTexture: { value: options.groupTexture || null },
            maxGroups: { value: options.maxGroups || 1 },
            highlightTexture: { value: options.highlightTexture || null },
            hasHighlight: { value: options.highlightTexture ? 1 : 0 },
        },
        vertexShader: FILL_VERTEX_SHADER,
        fragmentShader: FILL_FRAGMENT_SHADER,
        transparent: true,
        premultipliedAlpha: true,
        depthWrite: true,
        depthTest: true,
        side: THREE.DoubleSide,
        forceSinglePass: true,
    });
    material.visible = false;
    return material;
}

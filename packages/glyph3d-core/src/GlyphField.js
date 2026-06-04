/**
 * GlyphField — WebGPU-native instanced glyph renderer.
 *
 * Renders thousands of glyphs in a single InstancedBufferGeometry draw call
 * via THREE.WebGPURenderer + TSL (Three Shading Language) NodeMaterial, with
 * Slug winding-number coverage for crisp vector glyphs at any scale.
 *
 * - Material: MeshBasicNodeMaterial with TSL vertexNode + outputNode
 * - Per-instance: position, size, codepoint, color, group id; highlight via an
 *   RGBA texture; group visibility/transforms via a group DataTexture
 * - Picking: registers with PickingSystem (instanceMesh, _groupTexture,
 *   _maxGroups, renderedTexts, instancePickingId attribute)
 *
 * Public surface: render(), setGlyphHighlight(), getMemoryStats(),
 * beginBatchUpdate(), endBatchUpdate(), instanceMesh, renderedTexts,
 * _groupTexture, _maxGroups
 *
 * instancePickingId is populated by PickingSystem.register() after render().
 */

import * as THREE from 'three';
import { MeshBasicNodeMaterial, TSL } from 'three/webgpu';

const {
    Fn,
    attribute,
    uniform,
    texture,
    textureLoad,
    varying,
    positionLocal,
    uv,
    vec2,
    vec3,
    vec4,
    float,
    int,
    instanceIndex,
    modelViewMatrix,
    cameraProjectionMatrix,
    ivec2,
    If,
    Loop,
    Break,
    fwidth,
    Discard,
} = TSL;

/** Upper bound on quadratic beziers per glyph (TSL loop cap). */
const MAX_CURVES = 256;

import { PERF_THRESHOLDS } from './core/constants.js';

const MAX_GROUPS_DEFAULT = PERF_THRESHOLDS.defaultMaxGroups ?? 64;
const MAX_GROUPS_DIM     = 16000;

// ─── TSL vertex node ─────────────────────────────────────────────────────────

/**
 * Build TSL vertex node for instanced glyph rendering.
 * The instanced vertex shader logic, in TSL.
 *
 * @param {Object} uniforms - { groupTex, groupTexHeight, highlightTex }
 * @returns {Object} { vertexFn, vColor, vGroupAlpha, vAddedColor }
 */
function _buildVertexNode(uniforms) {
    // Per-instance buffer attributes
    const iPos     = attribute('instancePosition', 'vec3');
    const iSize    = attribute('instanceSize',     'vec2');
    const iGlyphId = attribute('instanceGlyphId',  'float');
    const iColor   = attribute('instanceColor',    'vec3');
    const iGroup   = attribute('instanceGroupId',  'float');

    // Varyings passed to fragment
    const vColor      = varying(vec3(0),  'vColor');
    const vGroupAlpha = varying(float(1), 'vGroupAlpha');
    const vAddedColor = varying(vec3(0),  'vAddedColor');
    const vGlyphUV    = varying(vec2(0),  'vGlyphUV');
    const vCurveStart = varying(int(0),   'vCurveStart');
    const vCurveCount = varying(int(0),   'vCurveCount');
    // Bitmap/emoji branch varyings
    const vMode       = varying(int(0),   'vMode');
    const vEmojiCell  = varying(int(0),   'vEmojiCell');

    const { groupTex, groupTexHeight, highlightTex, glyphMapTex, glyphMapWidth, clipEnabled, clipTop, clipBottom } = uniforms;

    const vertexFn = Fn(() => {
        // Glyph-map lookup: glyphId → curve range + mode (RGBA32Uint, 1 texel/glyph).
        // Done first so glyphInfo.z (mode) is available for quad-size selection below.
        const gid       = int(iGlyphId);
        const mapW      = int(glyphMapWidth);
        const glyphInfo = textureLoad(glyphMapTex, ivec2(gid.mod(mapW), gid.div(mapW)));
        vCurveStart.assign(int(glyphInfo.x));
        vCurveCount.assign(int(glyphInfo.y));
        // Channels .z/.w added by FontChain: mode (0=slug, 1=bitmap) and emoji cell index.
        vMode.assign(int(glyphInfo.z));
        vEmojiCell.assign(int(glyphInfo.w));

        // For bitmap (emoji) glyphs the atlas cell is square, but a monospace glyph quad
        // is narrow (iSize.x ≈ 0.5·iSize.y). Sampling a square emoji into a narrow quad
        // squishes it horizontally. Fix: use iSize.y for the quad width when mode == 1,
        // making the quad square. alignOffset stays at iSize.x.mul(0.5) so the center of
        // the wider square quad sits at the cell center (PlaneGeometry is center-anchored),
        // overflowing symmetrically left and right. Layout advance is UNCHANGED — iSize is
        // not modified — so columns stay aligned. Dense emoji runs will visually overlap;
        // the proper terminal-correct fix (double-width advance) is deferred.
        // .select(trueValue, falseValue) on a bool node — ConditionalNode API.
        const isBitmap = int(glyphInfo.z).equal(int(1));
        const quadW    = isBitmap.select(iSize.y, iSize.x); // square for emoji, narrow for slug

        // Scale base quad by per-instance size
        const scaled = positionLocal.mul(vec3(quadW, iSize.y, float(1)));

        // Left-align: PlaneGeometry center-anchored → shift right by half the LAYOUT width
        // (iSize.x, not quadW) so the cell anchor is consistent regardless of visual quad size.
        const alignOffset = vec3(iSize.x.mul(0.5), float(0), float(0));

        // Group DataTexture lookup (4 columns × maxGroups rows, RGBA32F).
        // textureLoad with exact integer texel coords — NOT normalized .sample():
        // rgba32float is not filterable under WebGPU, and a half-texel rounding on
        // the column UV silently picks the wrong column (washing color to white).
        const grow   = int(iGroup);
        const gPos   = textureLoad(groupTex, ivec2(int(0), grow)); // col 0: offset + visibility
        const gColor = textureLoad(groupTex, ivec2(int(2), grow)); // col 2: color multiplier
        const gScale = textureLoad(groupTex, ivec2(int(3), grow)); // col 3: scale + colorBlend (w)

        // World position = aligned quad + (instancePos * groupScale) + groupOffset
        const worldPos = scaled.add(alignOffset).add(iPos.mul(gScale.xyz)).add(gPos.xyz);

        // Standard MVP projection
        const clipPos = cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(worldPos, float(1))));

        // Blend instanceColor*groupColor (multiply, colorBlend=0) toward pure
        // groupColor (replace, colorBlend=1). Explicit lerp a+(b-a)*t — TSL's
        // .mix() method returned the wrong operand at t=0 here (handed back the
        // group color instead of the multiplied base), washing text to white.
        const colorBlend = gScale.w;
        const baseColor  = iColor.mul(gColor.rgb);
        vColor.assign(baseColor.add(gColor.rgb.sub(baseColor).mul(colorBlend)));
        vGroupAlpha.assign(gColor.a);

        // Per-glyph highlight from RGBA8 DataTexture (1024 wide, 2D wrapped)
        const hx = int(instanceIndex).mod(int(1024));
        const hy = int(instanceIndex).div(int(1024));
        const highlight = textureLoad(highlightTex, ivec2(hx, hy));
        vAddedColor.assign(highlight.rgb);

        // PlaneGeometry's uv attribute is [0,1] across the quad → glyph-space [0,1]².
        vGlyphUV.assign(uv());

        // Frame clip (Step 3c.2): cull this instance when its anchor y is outside the window
        // [clipBottom, clipTop]. iPos.y is per-instance (identical for all 4 quad verts) so
        // quads cull whole — no torn triangles at the edge. clipEnabled 0 = off. Degenerate
        // to outside-NDC (z/w = 2 > 1) so the GPU discards the triangles.
        const culled = clipEnabled.greaterThan(0.5).and(
            iPos.y.greaterThan(clipTop).or(iPos.y.lessThan(clipBottom))
        );
        const outClip = clipPos.toVar();
        If(culled, () => { outClip.assign(vec4(float(2), float(2), float(2), float(1))); });
        return outClip;
    });

    return { vertexFn, vColor, vGroupAlpha, vAddedColor, vGlyphUV, vCurveStart, vCurveCount, vMode, vEmojiCell };
}

/**
 * Build TSL fragment (output) node — Slug analytic coverage + bitmap emoji branch.
 *
 * Fragment shader: accumulate fractional winding
 * over every quadratic bezier in the glyph along an X ray and a Y ray
 * (2D anti-aliasing), scaled by the per-pixel footprint (fwidth). Single sample
 * (no supersampling / no band structure); under minification the ink is dilated
 * and the AA ramp softened so zoomed-out text degrades to a stable fuzzy shape
 * rather than flickering/dropping strokes — see the `m` ramp in the body.
 *
 * When vMode == 1 (bitmap emoji) the bezier path is skipped and the glyph is
 * sampled from the RGBA emoji atlas instead (see bitmap branch below).
 *
 * @param {Object} varyings - { vColor, vGroupAlpha, vAddedColor, vGlyphUV, vCurveStart, vCurveCount, vMode, vEmojiCell }
 * @param {Object} uniforms - { curveTex, emojiTex, emojiCols }
 */
function _buildOutputNode(varyings, uniforms) {
    const { vColor, vGroupAlpha, vAddedColor, vGlyphUV, vCurveStart, vCurveCount, vMode, vEmojiCell } = varyings;
    const { curveTex, emojiTex, emojiCols } = uniforms;

    // Minification tuning knobs (see below). DILATE_PX = half-width, in pixels, of the
    // stroke fattening applied at full zoom-out; SOFTEN = how much the AA ramp widens.
    // Both are the human-tunable dials — nudge in Firefox.
    const DILATE_PX = 0.75;
    const SOFTEN    = 0.45;

    return Fn(() => {
        // Invisible group — applies to both slug and bitmap paths.
        Discard(vGroupAlpha.lessThan(0.01));

        // Output color accumulator; filled by whichever branch executes.
        const outColor = vec4(0).toVar();

        If(vMode.equal(int(1)), () => {
            // ── Bitmap / emoji branch ────────────────────────────────────────────
            // Atlas is a square grid of `emojiCols × emojiCols` equal-sized cells.
            // cell index → (col = cell % cols, row = floor(cell / cols)).
            // vGlyphUV is [0,1]² across the quad → maps to the sub-cell region.
            //
            // Atlas canvas has flipY=false, so the v axis is inverted relative to our
            // quad UVs (which run bottom=0, top=1 in Three.js). Flip is ACTIVE:
            // we use (1 - vGlyphUV.y) so row 0 of the cell maps to the top of the texel,
            // which is where the canvas drew it. If emoji ever appear upside-down again,
            // swap float(1).sub(vGlyphUV.y) back to vGlyphUV.y as the flip dial.
            const col = float(vEmojiCell).mod(emojiCols);
            const row = float(vEmojiCell).div(emojiCols).floor();
            const atlasUV = vec2(
                col.add(vGlyphUV.x).div(emojiCols),
                row.add(float(1).sub(vGlyphUV.y)).div(emojiCols)   // ← flip ACTIVE (flipY=false atlas)
            );
            // Filtered (bilinear) RGBA sample — emojiTex is a normal filterable texture.
            // .sample(uvNode) uses the sampler path (not textureLoad), giving interpolation.
            const texel = emojiTex.sample(atlasUV);
            Discard(texel.a.lessThan(0.01));
            // pow(2.2): emoji atlas pixels are sRGB display values; decode to linear to
            // match the slug path and the renderer's sRGB output re-encode.
            // If emoji look too dark/washed after testing, this is the decode dial to revisit.
            outColor.assign(vec4(texel.rgb.pow(vec3(2.2)), texel.a.mul(vGroupAlpha)));

        }).Else(() => {
            // ── Slug bezier-coverage branch (existing path, unchanged) ───────────
            // Empty glyph (space / .notdef = 0 curves): discard within slug branch only.
            Discard(vCurveCount.equal(int(0)));

            // Pixel footprint in glyph-UV space, per axis. fwidth is the screen-space
            // derivative magnitude, so AA is resolution-independent.
            const fw = fwidth(vGlyphUV).toVar();

            // Minification amount, 0→1. fwMax = worst-axis footprint = the fraction of the glyph
            // cell one pixel spans. Small ⇒ magnified (crisp, single-sample). Large ⇒ many strokes
            // per pixel, where the two centre scanlines beat sub-pixel against the strokes → the
            // strokes flicker in and out (the moiré). We can't resolve sub-pixel strokes from a
            // point sample (box-filter aliasing is invariant to sample count — supersampling just
            // trades the moiré for a screen-door grid), so instead we make the failure GRACEFUL:
            // as the glyph shrinks we (a) DILATE the ink so thin strokes fatten-and-merge into a
            // stable fuzzy shape instead of dropping below a pixel and vanishing, and (b) SOFTEN
            // the AA ramp so edges blur. This is the "forgot my glasses" look — unreadable but a
            // steady, recognisable silhouette. It's what Slug ships (it dropped supersampling for
            // dilation). `m` smoothstep-ramps so the hand-off has no seam under a continuous dolly.
            // ↓↓ THE "scaling speed" DIALS — tune live in Firefox ↓↓
            // MIN_LO = fuzz ONSET (footprint where softening begins). RAISE it to keep text crisp
            //   farther out / start the fuzz later (i.e. less fuzzy at a given distance).
            // MIN_HI = fuzz FULL (footprint for max dilation+softening).
            // The MIN_LO→MIN_HI gap IS the ramp speed: widen it for a gentler, slower fade-to-fuzzy.
            const MIN_LO = float(0.06);  // ~16 px glyph: below this, bit-identical to crisp
            const MIN_HI = float(0.20);  // ~5 px glyph:  above this, max dilation + softening
            // LOD impostor dials — used by the coverage branch below.
            // LOD cross-fade band (footprint = glyph-UV per pixel, best-resolved axis):
            const LOD_LO      = float(0.30);   // begin fading exact → impostor (~3px glyph)
            const LOD_HI      = float(0.60);   // fully impostor beyond here (~1.5px); loop skipped
            const LOD_DENSITY = float(0.035);  // curveCount → coverage (cheap ink-density proxy)
            const LOD_MAXCOV  = float(0.72);   // cap so the densest glyphs don't fully saturate
            const fwMax = fw.x.max(fw.y);
            // LOD switch uses the BEST-resolved axis (min footprint), not the worst.
            // An angled page foreshortens one axis, which spikes fwMax and would flip
            // readable angled text to the impostor too early (the threshold appears to
            // move with viewing angle). fwMin only crosses the cutoff when the glyph is
            // small in BOTH axes — i.e. genuinely tiny — so the switch tracks real
            // on-screen size, not the camera angle. (fwMax still drives AA dilation below,
            // where worst-axis IS what we want for moiré.)
            const fwMin = fw.x.min(fw.y);
            const m = fwMax.sub(MIN_LO).div(MIN_HI.sub(MIN_LO)).clamp(0, 1).toVar();
            m.assign(m.mul(m).mul(float(3).sub(m.mul(2)))); // smoothstep — continuous derivative

            // Dilation half-width (passed into the winding accumulation: it pushes each stroke's
            // two edges symmetrically apart, fattening the ink). Softened footprint widens the
            // per-edge AA ramp. Both fold to identity at m=0 → the magnified path is untouched.
            const dilate = m.mul(DILATE_PX);
            const invD   = vec2(1).div(fw).mul(float(1).sub(m.mul(SOFTEN)));

            // LOD impostor: once a glyph shrinks past the point where its strokes can
            // be resolved (~2px footprint — the same regime the dilation note above
            // calls an "unreadable steady silhouette"), the per-curve bezier loop is
            // pure waste — it runs MAX_CURVES iterations with 2 texture loads each, per
            // fragment, only to produce a fuzzy blob. Below LOD_CUTOFF we skip the loop
            // entirely and approximate coverage from the glyph's curve count (a cheap
            // ink-density proxy: denser glyphs read darker). This is the LOD that lets
            // an entire repo render at once — distant files become cheap colored
            // text-mass, and the exact analytic path returns as the camera approaches.
            // Impostor coverage (cheap, no loop): curve count as an ink-density proxy.
            const impostorCov = float(vCurveCount).mul(LOD_DENSITY).clamp(0, LOD_MAXCOV);
            const cov = float(0).toVar();
            If(fwMin.greaterThan(LOD_HI), () => {
                cov.assign(impostorCov);   // far: strokes unresolvable → pure impostor, loop skipped
            }).Else(() => {
                const coverage = float(0).toVar();
                Loop(MAX_CURVES, ({ i }) => {
                    If(i.greaterThanEqual(vCurveCount), () => { Break(); });

                    // 2 texels per curve: [P0.xy, P1.xy] then [P2.xy, _, _].
                    const ci = vCurveStart.add(i).mul(2);
                    const t0 = textureLoad(curveTex, ivec2(ci.mod(1024), ci.div(1024)));
                    const t1 = textureLoad(curveTex, ivec2(ci.add(1).mod(1024), ci.add(1).div(1024)));

                    // Unpack uint16 → [0,1], translate so the sample point is the origin.
                    const p0 = vec2(float(t0.x), float(t0.y)).div(65535).sub(vGlyphUV);
                    const p1 = vec2(float(t0.z), float(t0.w)).div(65535).sub(vGlyphUV);
                    const p2 = vec2(float(t1.x), float(t1.y)).div(65535).sub(vGlyphUV);

                    coverage.addAssign(computeCoverage(invD.x, dilate, p0, p1, p2));
                    coverage.addAssign(computeCoverage(invD.y, dilate, rot90(p0), rot90(p1), rot90(p2)));
                });
                // Average the two rays; fills accumulate positive under y-up normalization.
                const exactCov = coverage.mul(0.5).clamp(0, 1);
                // Cross-fade exact → impostor across [LOD_LO, LOD_HI] so the quality
                // switch has no hard seam (the diagonal line that otherwise sweeps an
                // angled wall). smoothstep ramp; manual mix to avoid extra imports.
                const t = fwMin.sub(LOD_LO).div(LOD_HI.sub(LOD_LO)).clamp(0, 1).toVar();
                t.assign(t.mul(t).mul(float(3).sub(t.mul(2))));
                cov.assign(exactCov.add(impostorCov.sub(exactCov).mul(t)));
            });
            Discard(cov.lessThan(0.01));

            const outAlpha   = cov.mul(vGroupAlpha);
            Discard(outAlpha.lessThan(0.01));

            const finalColor = vColor.mul(cov).add(vAddedColor).clamp(0, 1);
            // Glyph colors are authored as display (sRGB) values; decode to linear so
            // the renderer's default sRGB output-encode returns them to the authored
            // value — consistent with the THREE.Color-managed rest of the scene
            // (which needs sRGB output and goes dark if output encoding is disabled).
            outColor.assign(vec4(finalColor.pow(vec3(2.2)), outAlpha));
        });

        return outColor;
    })();
}

/**
 * Opaque OCCLUDER LOD output — a discard-free, depth-writing fragment for dense
 * distant scenes (a skyline of whole source files stacked many planes deep).
 *
 * The normal path is transparent and uses Discard (for crisp AA text), which both
 * forces the back-to-front transparent pass AND disables hardware early-Z — so
 * occluded towers still run the fragment shader and overdraw scales with depth
 * complexity. This path is the inverse: every cell is opaque (alpha = 1 → writes
 * depth) and there is NO discard, so the GPU's early-Z rejects fragments behind
 * nearer towers BEFORE shading — real hardware occlusion culling. Cells are
 * colored by curve count (a cheap ink-density proxy) over black: dense glyphs
 * glow, blank/sparse cells fall to ~black and vanish into the dark background
 * while still occluding. No per-curve loop, no AA — for the minified regime only.
 */
function _buildOccluderOutputNode(varyings) {
    const { vColor, vGroupAlpha, vCurveCount } = varyings;
    return Fn(() => {
        // Ink-density proxy (matches the impostor branch in _buildOutputNode).
        const dens = float(vCurveCount).mul(0.035).clamp(0, 0.72);
        const rgb  = vColor.mul(dens).mul(vGroupAlpha).clamp(0, 1);
        // Opaque: alpha = 1 writes depth and occludes; no Discard keeps early-Z on.
        // NO pow(2.2): occluder fields run with the renderer's colorspace conversion
        // OFF (outputColorSpace = LinearSRGB), so there's no extra colorspace render
        // pass — that opaque-into-framebuffer pass is what carried a mis-sized depth
        // on some HiDPI GPUs. pow + the sRGB output-encode were an identity round
        // trip, so dropping both leaves the displayed color unchanged.
        return vec4(rgb, 1.0);
    })();
}

// Rotate 90° so the +X ray becomes a +Y ray in the rotated frame.
const rot90 = Fn(([v]) => vec2(v.y, v.x.negate()));

/**
 * Analytic coverage of one quadratic bezier for a +X ray through the origin
 * (endpoints pre-translated by the sample point). invDiameter = 1 / pixel
 * footprint along the ray axis; fractional crossings give sub-pixel coverage.
 * (Dobbie / Lengyel "Slug".) Restructured from the GLSL early-returns into
 * guarded accumulation for clean TSL codegen.
 *
 * `dilate` (pixels) fattens the ink: it biases the entering edge's contribution
 * down and the exiting edge's up, so a stroke's two boundaries move symmetrically
 * APART — keeping thin strokes from dropping below a pixel and vanishing. At 0 the
 * result is the exact Slug coverage (the magnified path, untouched).
 */
const computeCoverage = Fn(([invDiameter, dilate, p0, p1, p2]) => {
    const result = float(0).toVar();

    // Cheap reject: curve entirely on one side of the ray (y == 0).
    const allAbove = p0.y.greaterThan(0).and(p1.y.greaterThan(0)).and(p2.y.greaterThan(0));
    const allBelow = p0.y.lessThan(0).and(p1.y.lessThan(0)).and(p2.y.lessThan(0));

    If(allAbove.or(allBelow).not(), () => {
        // Q(t).y = 0 → a.y·t² − 2·b.y·t + c.y = 0 (factor of −2 baked into b).
        const a = p0.sub(p1.mul(2)).add(p2);
        const b = p0.sub(p1);
        const c = p0;

        const t0 = float(-1).toVar();
        const t1 = float(-1).toVar();
        const solvable = float(1).toVar();

        If(a.y.abs().greaterThanEqual(1e-5), () => {
            // Quadratic: two roots — t0 always exits, t1 always enters.
            const radicand = b.y.mul(b.y).sub(a.y.mul(c.y));
            If(radicand.greaterThan(0), () => {
                const s = radicand.sqrt();
                t0.assign(b.y.sub(s).div(a.y));
                t1.assign(b.y.add(s).div(a.y));
            }).Else(() => {
                solvable.assign(0); // radicand ≤ 0 → no crossing
            });
        }).Else(() => {
            // Degenerate quadratic = line segment; one root, assigned by direction.
            const t = p0.y.div(p0.y.sub(p2.y));
            If(p0.y.lessThan(p2.y), () => {
                t0.assign(-1); t1.assign(t);
            }).Else(() => {
                t0.assign(t); t1.assign(-1);
            });
        });

        If(solvable.greaterThan(0.5), () => {
            If(t0.greaterThanEqual(0).and(t0.lessThan(1)), () => {
                const x = a.x.mul(t0).sub(b.x.mul(2)).mul(t0).add(c.x);
                result.addAssign(x.mul(invDiameter).add(0.5).add(dilate).clamp(0, 1));
            });
            If(t1.greaterThanEqual(0).and(t1.lessThan(1)), () => {
                const x = a.x.mul(t1).sub(b.x.mul(2)).mul(t1).add(c.x);
                result.subAssign(x.mul(invDiameter).add(0.5).sub(dilate).clamp(0, 1));
            });
        });
    });

    return result;
});

/**
 * 1×1 RGBA32Uint placeholder so the NodeMaterial compiles before slug data lands.
 * @returns {THREE.DataTexture}
 */
function _makePlaceholderUintTexture() {
    const tex = new THREE.DataTexture(
        new Uint32Array(4), 1, 1,
        THREE.RGBAIntegerFormat, THREE.UnsignedIntType
    );
    tex.minFilter        = THREE.NearestFilter;
    tex.magFilter        = THREE.NearestFilter;
    tex.generateMipmaps  = false;
    tex.needsUpdate      = true;
    return tex;
}

/**
 * 1×1 RGBA8 filterable placeholder so the NodeMaterial compiles before the
 * emoji atlas lands. Uses a fully transparent black texel.
 * @returns {THREE.DataTexture}
 */
function _makePlaceholderRGBATexture() {
    const tex = new THREE.DataTexture(
        new Uint8Array(4), 1, 1,
        THREE.RGBAFormat, THREE.UnsignedByteType
    );
    tex.minFilter       = THREE.LinearFilter;
    tex.magFilter       = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate     = true;
    return tex;
}

// ─── GlyphField ───────────────────────────────────────────────────────────────

export default class GlyphField {
    /**
     * Create a WebGPU glyph field.
     *
     * @param {THREE.Scene} scene
     * @param {Object} atlas - GlyphAtlas (for metrics; must have getCharSize())
     * @param {Object} [options]
     * @param {Object} [options.slugData] - Slug texture data (reserved for post-C3 Slug fragment)
     * @param {Object} [options.shaper]   - HarfBuzz shaper for sync text layout
     * @param {number} [options.maxInstances]
     * @param {Object} [options.defaultColor] - { r, g, b }
     * @param {number} [options.worldScale]
     * @param {number} [options.maxGroups]
     */
    constructor(scene, atlas, options = {}) {
        this.scene  = scene;
        this.atlas  = atlas;

        this._slugData = options.slugData || (atlas && atlas._slugData) || null;
        this._shaper   = options.shaper   || (atlas && atlas._shaper)   || null;

        // Opaque occluder LOD mode (dense distant scenes) — see _createInstanceMesh.
        this._occluder = !!options.occluder;

        // Register with the live Slug atlas so on-demand glyph encoding (box-drawing,
        // spinner stars, rounded corners, …) hot-swaps fresh curve textures into us.
        if (atlas && atlas._live && typeof atlas._live.registerField === 'function') {
            atlas._live.registerField(this);
        }

        const atlasCharSize = atlas.getCharSize();
        const scale = options.worldScale || 0.025;

        this.metrics = {
            charWidth:     atlasCharSize.width  * scale,
            charHeight:    atlasCharSize.height * scale,
            letterSpacing: atlasCharSize.width  * scale * 0.05,
            lineSpacing:   atlasCharSize.height * scale * 1.2,
            pixelWidth:    atlasCharSize.width,
            pixelHeight:   atlasCharSize.height,
        };

        this.config = {
            maxInstances: options.maxInstances || PERF_THRESHOLDS.maxInstancesPerMesh,
            defaultColor: options.defaultColor || { r: 0.0, g: 1.0, b: 0.0 },
            worldScale: scale,
        };

        // Group DataTexture
        const requestedGroups = options.maxGroups || MAX_GROUPS_DEFAULT;
        this._maxGroups  = Math.min(requestedGroups, MAX_GROUPS_DIM);
        this._groupData  = new Float32Array(this._maxGroups * 4 * 4);
        this._groupCount = 1; // group 0 = identity
        this._initGroupDefaults();
        this._groupTexture = null; // created in _createInstanceMesh

        // Highlight texture
        this._highlightTexture  = null;
        this._highlightSize     = 0;
        this._highlightTexWidth = 1024;

        // Text registry (the shape PickingSystem.resolveGlyph reads)
        this.renderedTexts     = new Map();
        this.nextId            = 1;
        this._cachedGlyphCount = 0;

        // Batch mode
        this._batchMode  = false;
        this._batchDirty = false;

        // TSL uniform nodes — stored for hot-swap (setGroupOffset, _ensureHighlightTexture, etc.)
        this._groupTexUniform    = null;
        this._groupTexHUniform   = null;
        this._highlightUniform   = null;
        this._curveTexUniform    = null;
        this._glyphMapTexUniform = null;
        this._glyphMapWUniform   = null;
        this._emojiTexUniform    = null;
        this._emojiColsUniform   = null;

        // Slug curve + glyph-map textures (resolved in _ensureSlugTextures)
        this._curveTexture    = null;
        this._glyphMapTexture = null;
        this._glyphMapWidth   = 1;

        // Build instance mesh
        this.instanceMesh = this._createInstanceMesh();
        this.scene.add(this.instanceMesh);
    }

    // ── Group DataTexture ─────────────────────────────────────────────────────

    /** @private */
    _initGroupDefaults() {
        for (let g = 0; g < this._maxGroups; g++) {
            const base = g * 4 * 4;
            this._groupData[base + 3]      = 1.0; // col 0 w: visibility
            this._groupData[base + 4 + 3]  = 1.0; // col 1 w: quat.w
            this._groupData[base + 8]      = 1.0; // col 2 r: color.r
            this._groupData[base + 8 + 1]  = 1.0; // col 2 g: color.g
            this._groupData[base + 8 + 2]  = 1.0; // col 2 b: color.b
            this._groupData[base + 8 + 3]  = 1.0; // col 2 a: color.a
            this._groupData[base + 12]     = 1.0; // col 3 x: scale.x
            this._groupData[base + 12 + 1] = 1.0; // col 3 y: scale.y
            this._groupData[base + 12 + 2] = 1.0; // col 3 z: scale.z
        }
    }

    /** @private */
    _createGroupTexture() {
        const tex = new THREE.DataTexture(
            this._groupData, 4, this._maxGroups,
            THREE.RGBAFormat, THREE.FloatType
        );
        tex.minFilter = THREE.NearestFilter;
        tex.magFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;
        return tex;
    }

    // ── Highlight texture ─────────────────────────────────────────────────────

    /** @private */
    _ensureHighlightTexture(instanceCount) {
        if (this._highlightTexture && this._highlightSize >= instanceCount) return;

        const W = this._highlightTexWidth;
        const count  = Math.max(instanceCount, 1);
        const height = Math.ceil(count / W);
        const data   = new Uint8Array(W * height * 4); // zero = no highlight

        if (this._highlightTexture) {
            const old = this._highlightTexture.image.data;
            data.set(old.subarray(0, Math.min(old.length, data.length)));
            this._highlightTexture.dispose();
        }

        const tex = new THREE.DataTexture(data, W, height, THREE.RGBAFormat, THREE.UnsignedByteType);
        tex.minFilter = THREE.NearestFilter;
        tex.magFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;

        this._highlightTexture = tex;
        this._highlightSize    = count;

        // Update TSL uniform node value so the shader sees the new texture
        if (this._highlightUniform) {
            this._highlightUniform.value = tex;
        }
    }

    // ── Instance mesh ─────────────────────────────────────────────────────────

    /** @private */
    _createInstanceMesh() {
        const geometry = new THREE.InstancedBufferGeometry();
        const base = new THREE.PlaneGeometry(1, 1);
        geometry.index = base.index;
        geometry.attributes.position = base.attributes.position;
        geometry.attributes.uv       = base.attributes.uv;

        this._groupTexture = this._createGroupTexture();
        // Ensure a minimal (1-slot) highlight texture at construction
        this._ensureHighlightTexture(1);

        const maxCount = this.config.maxInstances;

        // Pre-allocate per-instance attributes
        geometry.setAttribute('instancePosition',
            new THREE.InstancedBufferAttribute(new Float32Array(maxCount * 3), 3));
        geometry.setAttribute('instanceSize',
            new THREE.InstancedBufferAttribute(new Float32Array(maxCount * 2), 2));
        geometry.setAttribute('instanceGlyphId',
            new THREE.InstancedBufferAttribute(new Float32Array(maxCount), 1));
        geometry.setAttribute('instanceColor',
            new THREE.InstancedBufferAttribute(new Float32Array(maxCount * 3), 3));
        geometry.setAttribute('instanceGroupId',
            new THREE.InstancedBufferAttribute(new Float32Array(maxCount), 1));
        // instancePickingId — written by PickingSystem.register() after flush
        geometry.setAttribute('instancePickingId',
            new THREE.InstancedBufferAttribute(new Float32Array(maxCount), 1));

        geometry._maxInstanceCount = maxCount;
        geometry.instanceCount = 0;

        // ── Build TSL NodeMaterial ────────────────────────────────────────────
        // texture() creates a TextureNode — use .value for hot-swap, NOT uniform()
        const groupTexNode     = texture(this._groupTexture);
        const groupTexHNode    = uniform(float(this._maxGroups));
        const highlightTexNode = texture(this._highlightTexture);

        // Slug curve + glyph-map textures (real data or 1×1 placeholders until
        // setSlugData arrives). texelFetch'd via textureLoad in the shader.
        this._ensureSlugTextures();
        const curveTexNode    = texture(this._curveTexture);
        const glyphMapTexNode = texture(this._glyphMapTexture);
        const glyphMapWNode   = uniform(float(this._glyphMapWidth));

        // Frame clip (Step 3c.2): cull instances whose grid-local anchor y is outside the
        // window. clipEnabled 0 = no clip (default); driven by setClipYRange().
        const clipEnabledNode = uniform(float(0));
        const clipTopNode     = uniform(float(0));
        const clipBottomNode  = uniform(float(0));

        // Emoji atlas texture + cols uniform. Falls back to a 1×1 filterable RGBA
        // placeholder so the NodeMaterial compiles before any emoji atlas exists.
        const emojiAtlas = this.atlas && this.atlas._emojiAtlas;
        const emojiTexture = emojiAtlas ? emojiAtlas.getTexture(THREE) : _makePlaceholderRGBATexture();
        const emojiCols    = emojiAtlas ? emojiAtlas.cols : 16;
        const emojiTexNode  = texture(emojiTexture);
        const emojiColsNode = uniform(float(emojiCols));

        // Store for hot-swap (.value = newTexture)
        this._groupTexUniform     = groupTexNode;
        this._groupTexHUniform    = groupTexHNode;
        this._highlightUniform    = highlightTexNode;
        this._curveTexUniform     = curveTexNode;
        this._glyphMapTexUniform  = glyphMapTexNode;
        this._glyphMapWUniform    = glyphMapWNode;
        this._clipEnabledUniform  = clipEnabledNode;
        this._clipTopUniform      = clipTopNode;
        this._clipBottomUniform   = clipBottomNode;
        this._emojiTexUniform     = emojiTexNode;
        this._emojiColsUniform    = emojiColsNode;

        const { vertexFn, vColor, vGroupAlpha, vAddedColor, vGlyphUV, vCurveStart, vCurveCount, vMode, vEmojiCell } =
            _buildVertexNode({
                groupTex:       groupTexNode,
                groupTexHeight: groupTexHNode,
                highlightTex:   highlightTexNode,
                glyphMapTex:    glyphMapTexNode,
                glyphMapWidth:  glyphMapWNode,
                clipEnabled:    clipEnabledNode,
                clipTop:        clipTopNode,
                clipBottom:     clipBottomNode,
            });

        const outputNode = this._occluder
            ? _buildOccluderOutputNode({ vColor, vGroupAlpha, vCurveCount })
            : _buildOutputNode(
                { vColor, vGroupAlpha, vAddedColor, vGlyphUV, vCurveStart, vCurveCount, vMode, vEmojiCell },
                { curveTex: curveTexNode, emojiTex: emojiTexNode, emojiCols: emojiColsNode }
            );

        const material = new MeshBasicNodeMaterial();
        material.vertexNode  = vertexFn();
        material.outputNode  = outputNode;
        material.side        = THREE.DoubleSide;
        if (this._occluder) {
            // Opaque + depth-writing → Three renders these grids front-to-back, so the
            // GPU's early-Z occludes hidden towers (the discard-free occluder node keeps
            // early-Z enabled). This collapses deep-skyline overdraw to ~one layer.
            material.transparent = false;
            material.depthWrite  = true;
            material.depthTest   = true;
        } else {
            material.transparent = true;
            material.depthWrite  = true;
        }

        this._material = material;

        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        return mesh;
    }

    // ── Slug data (reserved for post-C3 Slug fragment) ────────────────────────

    /**
     * Set or update Slug texture data. Data is stored for future use when the
     * Slug winding-number fragment shader is activated in a later commit.
     * @param {Object} slugData - { curveTexture, glyphMapTexture }
     * @param {Object} [shaper]
     */
    setSlugData(slugData, shaper) {
        if (shaper) this._shaper = shaper;
        this._slugData = slugData;
        this._ensureSlugTextures();
        // Hot-swap the live shader texture nodes to the real curve/glyph-map data.
        if (this._curveTexUniform)    this._curveTexUniform.value    = this._curveTexture;
        if (this._glyphMapTexUniform) this._glyphMapTexUniform.value = this._glyphMapTexture;
        if (this._glyphMapWUniform)   this._glyphMapWUniform.value   = this._glyphMapWidth;
    }

    /**
     * Refresh the emoji atlas texture node after the atlas has grown or changed.
     * Call this whenever EmojiAtlas re-packs (e.g. after new emoji are encoded).
     * Safe to call before the emoji atlas exists — no-op in that case.
     */
    setEmojiTexture() {
        if (!this._emojiTexUniform || !this.atlas || !this.atlas._emojiAtlas) return;
        const tex = this.atlas._emojiAtlas.getTexture(THREE);
        if (tex) {
            tex.needsUpdate = true;
            this._emojiTexUniform.value  = tex;
            this._emojiColsUniform.value = this.atlas._emojiAtlas.cols;
        }
    }

    /**
     * Set the frame clip window in GRID-LOCAL y (Step 3c.2). Instances whose anchor y is
     * outside [bottom, top] are culled in the vertex stage. Pass null/non-finite (either arg)
     * to disable the clip (show everything). Pure render-side uniform update — no re-fold.
     * @param {number|null} top
     * @param {number|null} bottom
     */
    setClipYRange(top, bottom) {
        if (!this._clipEnabledUniform) return;
        const on = Number.isFinite(top) && Number.isFinite(bottom);
        this._clipEnabledUniform.value = on ? 1 : 0;
        if (on) {
            this._clipTopUniform.value    = top;
            this._clipBottomUniform.value = bottom;
        }
    }

    /**
     * Resolve the curve + glyph-map textures from slug data, falling back to
     * 1×1 placeholders so the NodeMaterial can compile before data arrives.
     * @private
     */
    _ensureSlugTextures() {
        const sd = this._slugData;
        if (sd && sd.curveTexture && sd.glyphMapTexture) {
            this._curveTexture    = sd.curveTexture;
            this._glyphMapTexture = sd.glyphMapTexture;
            this._glyphMapWidth   = sd.glyphMapTexture.image.width;
            return;
        }
        if (!this._curveTexture) {
            this._curveTexture    = _makePlaceholderUintTexture();
            this._glyphMapTexture = _makePlaceholderUintTexture();
            this._glyphMapWidth   = 1;
        }
    }

    // ── Public rendering API ──────────────────────────────────────────────────

    /**
     * Render text at a position.
     * @param {string} text
     * @param {{x,y,z}} [position]
     * @param {Object} [options]
     * @returns {number} textId
     */
    render(text, position = { x: 0, y: 0, z: 0 }, options = {}) {
        const glyphs = this._textToGlyphs(text, position, options);
        const id = this._registerText(text, glyphs, options);
        this._maybeRebuild();
        return id;
    }

    /**
     * Render multiple texts in one GPU rebuild.
     * @param {Array<{text, position, options}>} items
     * @returns {number[]} textIds
     */
    renderBatch(items) {
        const ids = [];
        for (const item of items) {
            const glyphs = this._textToGlyphs(
                item.text,
                item.position || { x: 0, y: 0, z: 0 },
                item.options || {}
            );
            ids.push(this._registerText(item.text, glyphs, item.options || {}));
        }
        this._rebuildAllInstances();
        return ids;
    }

    /**
     * Update all glyph positions for a text entry (direct buffer write).
     * @param {number} id
     * @param {{x,y,z}} newPosition
     */
    updatePosition(id, newPosition) {
        const entry = this.renderedTexts.get(id);
        if (!entry || entry.bufferStartIndex === undefined) return;
        const geom = this.instanceMesh.geometry;
        const arr  = geom.attributes.instancePosition.array;
        const base = entry.bufferStartIndex;
        const dx = newPosition.x - arr[base * 3];
        const dy = newPosition.y - arr[base * 3 + 1];
        const dz = newPosition.z - arr[base * 3 + 2];
        for (let i = 0; i < entry.glyphCount; i++) {
            const b = (base + i) * 3;
            arr[b] += dx; arr[b + 1] += dy; arr[b + 2] += dz;
        }
        const attr = geom.attributes.instancePosition;
        attr.addUpdateRange(base * 3, entry.glyphCount * 3);
        attr.needsUpdate = true;
    }

    /**
     * Update all glyph colors for a text entry (direct buffer write).
     * @param {number} id
     * @param {{r,g,b}} newColor
     */
    updateColor(id, newColor) {
        const entry = this.renderedTexts.get(id);
        if (!entry || entry.bufferStartIndex === undefined) return;
        const geom = this.instanceMesh.geometry;
        const arr  = geom.attributes.instanceColor.array;
        const base = entry.bufferStartIndex;
        for (let i = 0; i < entry.glyphCount; i++) {
            const b = (base + i) * 3;
            arr[b] = newColor.r; arr[b + 1] = newColor.g; arr[b + 2] = newColor.b;
        }
        const attr = geom.attributes.instanceColor;
        attr.addUpdateRange(base * 3, entry.glyphCount * 3);
        attr.needsUpdate = true;
    }

    /**
     * Set per-glyph highlight (additive) by absolute buffer slot index.
     * @param {number} absoluteSlot
     * @param {{r,g,b}|null} color - null clears
     */
    setGlyphHighlight(absoluteSlot, color) {
        if (!this._highlightTexture) return;
        const data = this._highlightTexture.image.data;
        const i = absoluteSlot * 4;
        data[i]     = color ? ((color.r * 255 + 0.5) | 0) : 0;
        data[i + 1] = color ? ((color.g * 255 + 0.5) | 0) : 0;
        data[i + 2] = color ? ((color.b * 255 + 0.5) | 0) : 0;
        data[i + 3] = 0;
        this._highlightTexture.needsUpdate = true;
    }

    // ── Batch mode ────────────────────────────────────────────────────────────

    beginBatchUpdate() {
        this._batchMode  = true;
        this._batchDirty = false;
    }

    endBatchUpdate() {
        this._batchMode = false;
        if (this._batchDirty) {
            this._rebuildAllInstances();
            this._batchDirty = false;
        }
    }

    // ── Stats ─────────────────────────────────────────────────────────────────

    /**
     * Memory / instance statistics.
     */
    getMemoryStats() {
        const geom = this.instanceMesh?.geometry;
        const instanceCount = geom?.instanceCount ?? 0;
        const maxInstances  = geom?._maxInstanceCount ?? this.config.maxInstances;

        let allocatedBytes = 0, usedBytes = 0;
        if (geom) {
            for (const name of Object.keys(geom.attributes)) {
                if (!name.startsWith('instance')) continue;
                const attr = geom.attributes[name];
                allocatedBytes += attr.array.byteLength;
                usedBytes      += instanceCount * attr.itemSize * 4;
            }
        }
        const groupBytes = this._groupData?.byteLength ?? 0;
        return {
            instanceCount,
            maxInstances,
            allocatedBytes,
            usedBytes,
            wasteBytes:            allocatedBytes - usedBytes,
            groupTextureBytes:     groupBytes * 2,
            highlightTextureBytes: this._highlightSize * 4,
            totalBytes:            allocatedBytes + groupBytes * 2 + this._highlightSize * 4,
            textEntryCount:        this.renderedTexts.size,
        };
    }

    // ── Group transform API ───────────────────────────────────────────────────

    createGroup() {
        const id = this._groupCount++;
        if (id >= this._maxGroups) this._growGroupTexture();
        return id < this._maxGroups ? id : 0;
    }

    setGroupOffset(groupId, offset) {
        if (groupId < 0 || groupId >= this._maxGroups) return;
        const base = (groupId * 4 + 0) * 4;
        this._groupData[base]     = offset.x;
        this._groupData[base + 1] = offset.y;
        this._groupData[base + 2] = offset.z;
        this._syncGroupTexture();
    }

    getGroupOffset(groupId) {
        if (groupId < 0 || groupId >= this._maxGroups) return { x: 0, y: 0, z: 0 };
        const base = (groupId * 4 + 0) * 4;
        return { x: this._groupData[base], y: this._groupData[base + 1], z: this._groupData[base + 2] };
    }

    setGroupColor(groupId, color) {
        if (groupId < 0 || groupId >= this._maxGroups) return;
        const base = (groupId * 4 + 2) * 4;
        this._groupData[base]     = color.r;
        this._groupData[base + 1] = color.g;
        this._groupData[base + 2] = color.b;
        this._groupData[base + 3] = color.a !== undefined ? color.a : 1.0;
        this._syncGroupTexture();
    }

    getGroupColor(groupId) {
        if (groupId < 0 || groupId >= this._maxGroups) return { r: 1, g: 1, b: 1, a: 1 };
        const base = (groupId * 4 + 2) * 4;
        return { r: this._groupData[base], g: this._groupData[base + 1], b: this._groupData[base + 2], a: this._groupData[base + 3] };
    }

    setGroupVisibility(groupId, visible) {
        if (groupId < 0 || groupId >= this._maxGroups) return;
        const base = (groupId * 4 + 2) * 4;
        this._groupData[base + 3] = visible ? 1.0 : 0.0;
        this._syncGroupTexture();
    }

    setGroupScale(groupId, scale) {
        if (groupId < 0 || groupId >= this._maxGroups) return;
        const base = (groupId * 4 + 3) * 4;
        this._groupData[base]     = scale.x;
        this._groupData[base + 1] = scale.y;
        this._groupData[base + 2] = scale.z;
        this._syncGroupTexture();
    }

    getGroupScale(groupId) {
        if (groupId < 0 || groupId >= this._maxGroups) return { x: 1, y: 1, z: 1 };
        const base = (groupId * 4 + 3) * 4;
        return { x: this._groupData[base], y: this._groupData[base + 1], z: this._groupData[base + 2] };
    }

    setGroupColorBlend(groupId, blend) {
        if (groupId < 0 || groupId >= this._maxGroups) return;
        const base = (groupId * 4 + 3) * 4;
        this._groupData[base + 3] = blend;
        this._syncGroupTexture();
    }

    /** @private — mark group DataTexture dirty and update the TSL uniform node */
    _syncGroupTexture() {
        this._groupTexture.needsUpdate = true;
        if (this._groupTexUniform) this._groupTexUniform.value = this._groupTexture;
    }

    /** @private */
    _growGroupTexture() {
        const oldMax = this._maxGroups;
        if (oldMax >= MAX_GROUPS_DIM) return;
        this._maxGroups = Math.min(oldMax * 2, MAX_GROUPS_DIM);
        const newData = new Float32Array(this._maxGroups * 4 * 4);
        newData.set(this._groupData);
        this._groupData = newData;
        for (let g = oldMax; g < this._maxGroups; g++) {
            const base = g * 4 * 4;
            this._groupData[base + 3]      = 1.0;
            this._groupData[base + 4 + 3]  = 1.0;
            this._groupData[base + 8]      = 1.0;
            this._groupData[base + 8 + 1]  = 1.0;
            this._groupData[base + 8 + 2]  = 1.0;
            this._groupData[base + 8 + 3]  = 1.0;
            this._groupData[base + 12]     = 1.0;
            this._groupData[base + 12 + 1] = 1.0;
            this._groupData[base + 12 + 2] = 1.0;
        }
        if (this._groupTexture) this._groupTexture.dispose();
        this._groupTexture = this._createGroupTexture();
        if (this._groupTexUniform)  this._groupTexUniform.value  = this._groupTexture;
        if (this._groupTexHUniform) this._groupTexHUniform.value = float(this._maxGroups);
    }

    // ── Picking seam ──────────────────────────────────────────────────────────

    /**
     * Descriptor for PickingSystem.register().
     */
    getPickingDescriptor() {
        return {
            instanceMesh:  this.instanceMesh,
            _groupTexture: this._groupTexture,
            _maxGroups:    this._maxGroups,
            renderedTexts: this.renderedTexts,
        };
    }

    // ── Bounds query ─────────────────────────────────────────────────────────

    /**
     * Compute the axis-aligned bounding box for all glyphs belonging to a
     * given textId. Walks instancePosition + instanceSize for the contiguous
     * buffer range recorded in renderedTexts.
     *
     * Returns an empty Box3 (isEmpty() === true) when the textId is unknown,
     * has no glyphs, or the geometry is not yet built.
     *
     * @param {number} textId - ID returned by render() or applyPrebuiltBuffers()
     * @returns {THREE.Box3}
     */
    getTextBounds(textId) {
        const box = new THREE.Box3();
        const entry = this.renderedTexts.get(textId);
        if (!entry || !entry.glyphCount || entry.bufferStartIndex === undefined) return box;

        const geom  = this.instanceMesh?.geometry;
        if (!geom) return box;

        const positions = geom.attributes.instancePosition?.array;
        const sizes     = geom.attributes.instanceSize?.array;
        if (!positions || !sizes) return box;

        const start = entry.bufferStartIndex;
        const count = entry.glyphCount;

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (let i = 0; i < count; i++) {
            const buf = start + i;
            const px  = positions[buf * 3];
            const py  = positions[buf * 3 + 1];
            const pz  = positions[buf * 3 + 2];
            const sw  = sizes[buf * 2];
            const sh  = sizes[buf * 2 + 1];
            if (px      < minX) minX = px;
            if (py      < minY) minY = py;
            if (pz      < minZ) minZ = pz;
            if (px + sw > maxX) maxX = px + sw;
            if (py + sh > maxY) maxY = py + sh;
            if (pz      > maxZ) maxZ = pz;
        }

        if (minX === Infinity) return box; // zero-glyph entry
        box.set(
            new THREE.Vector3(minX, minY, minZ),
            new THREE.Vector3(maxX, maxY, maxZ)
        );
        return box;
    }

    /**
     * Total glyph count. O(1) — cached counter maintained by every
     * add/remove/clear/applyPrebuiltBuffers path.
     * @returns {number}
     */
    getGlyphCount() {
        return this._cachedGlyphCount;
    }

    /**
     * World-space bounds for a renderedTexts entry, read from the typed arrays.
     * @param {Object} entry - renderedTexts value with bufferStartIndex + glyphCount
     * @returns {{min,max,width,height,depth}|null}
     */
    _getTextBounds(entry) {
        if (!entry || entry.glyphCount === 0 || !this.instanceMesh) return null;

        const geom      = this.instanceMesh.geometry;
        const positions = geom.attributes.instancePosition.array;
        const sizes     = geom.attributes.instanceSize.array;
        const start     = entry.bufferStartIndex;

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (let i = 0; i < entry.glyphCount; i++) {
            const buf = start + i;
            const px = positions[buf * 3];
            const py = positions[buf * 3 + 1];
            const pz = positions[buf * 3 + 2];
            const sw = sizes[buf * 2];
            const sh = sizes[buf * 2 + 1];
            if (px      < minX) minX = px;
            if (py      < minY) minY = py;
            if (pz      < minZ) minZ = pz;
            if (px + sw > maxX) maxX = px + sw;
            if (py + sh > maxY) maxY = py + sh;
            if (pz      > maxZ) maxZ = pz;
        }
        if (minX === Infinity) return null;

        return {
            min: { x: minX, y: minY, z: minZ },
            max: { x: maxX, y: maxY, z: maxZ },
            width:  maxX - minX,
            height: maxY - minY,
            depth:  maxZ - minZ,
        };
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    /**
     * Remove a single text entry and compact the surviving instances.
     * @param {number} id
     */
    remove(id) {
        const entry = this.renderedTexts.get(id);
        if (!entry) return;
        this._cachedGlyphCount -= entry.glyphCount;
        this.renderedTexts.delete(id);
        this._rebuildAllInstances();
    }

    clear() {
        this.renderedTexts.clear();
        this._cachedGlyphCount = 0;
        if (this.instanceMesh) this.instanceMesh.geometry.instanceCount = 0;
    }

    dispose() {
        if (this.atlas && this.atlas._live && typeof this.atlas._live.unregisterField === 'function') {
            this.atlas._live.unregisterField(this);
        }
        if (this.instanceMesh) {
            this.scene.remove(this.instanceMesh);
            this.instanceMesh.geometry.dispose();
            this.instanceMesh.material.dispose();
        }
        if (this._groupTexture)    this._groupTexture.dispose();
        if (this._highlightTexture) this._highlightTexture.dispose();
        this.renderedTexts.clear();
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    /** @private */
    _textToGlyphs(text, position, options) {
        const color   = options.color   || this.config.defaultColor;
        const scale   = options.scale   || 1.0;
        const groupId = options.groupId || 0;
        const ws      = this.config.worldScale;

        if (this._shaper) {
            return this._textToGlyphsShaped(text, position, color, scale, groupId, ws);
        }
        return this._textToGlyphsMono(text, position, color, scale, groupId, ws);
    }

    /** @private — HarfBuzz-shaped layout */
    _textToGlyphsShaped(text, position, color, scale, groupId, worldScale) {
        const glyphs   = [];
        const upem     = this._shaper.upem;
        const ws       = worldScale * this.metrics.pixelHeight;
        const fontExt  = this._shaper.fontExtents();
        const lineH    = (fontExt.ascender - fontExt.descender + fontExt.lineGap) / upem * ws * scale;

        let x = position.x, y = position.y;
        const z = position.z;

        for (const lineText of text.split('\n')) {
            if (lineText.length > 0) {
                const shaped = this._shaper.shape(lineText);
                for (const sg of shaped) {
                    const advance    = sg.ax / upem * ws * scale;
                    const charHeight = this.metrics.charHeight * scale;
                    glyphs.push({
                        position: { x: x + (sg.dx / upem * ws * scale), y: y + (sg.dy / upem * ws * scale), z },
                        size: { width: advance, height: charHeight },
                        charCode: sg.g,
                        color,
                        groupId,
                    });
                    x += advance;
                }
            }
            x = position.x;
            y -= lineH;
        }
        return glyphs;
    }

    /** @private — monospace fallback (no shaper) */
    _textToGlyphsMono(text, position, color, scale, groupId, worldScale) {
        const glyphs = [];
        const cw = this.metrics.charWidth  * scale;
        const ch = this.metrics.charHeight * scale;
        const ls = this.metrics.letterSpacing * scale;
        const lh = this.metrics.lineSpacing   * scale;
        let x = position.x, y = position.y;
        const z = position.z;
        for (const c of text) {
            if (c === '\n') { x = position.x; y -= lh; continue; }
            if (c === ' ')  { x += cw + ls; continue; }
            glyphs.push({ position: { x, y, z }, size: { width: cw, height: ch }, charCode: 0, color, groupId });
            x += cw + ls;
        }
        return glyphs;
    }

    /** @private */
    _registerText(text, glyphs, options) {
        const id = this.nextId++;
        this.renderedTexts.set(id, { id, text, glyphs, glyphCount: glyphs.length });
        this._cachedGlyphCount += glyphs.length;
        return id;
    }

    /** @private */
    _maybeRebuild() {
        if (this._batchMode) {
            this._batchDirty = true;
        } else {
            this._rebuildAllInstances();
        }
    }

    /** @private */
    _rebuildAllInstances() {
        let hasLegacy = false;
        for (const entry of this.renderedTexts.values()) {
            if (entry.glyphs) { hasLegacy = true; break; }
        }

        if (hasLegacy) {
            const allGlyphs = [];
            let idx = 0;
            for (const entry of this.renderedTexts.values()) {
                entry.bufferStartIndex = idx;
                if (entry.glyphs) {
                    entry.glyphCount = entry.glyphs.length;
                    allGlyphs.push(...entry.glyphs);
                    idx += entry.glyphs.length;
                } else {
                    idx += entry.glyphCount;
                }
            }
            this._writeGlyphsToGeometry(allGlyphs);
            for (const entry of this.renderedTexts.values()) { entry.glyphs = null; }
            return;
        }

        // Compaction path
        const geom = this.instanceMesh.geometry;
        const oldPos = geom.attributes.instancePosition.array;
        const oldSiz = geom.attributes.instanceSize.array;
        const oldGid = geom.attributes.instanceGlyphId.array;
        const oldCol = geom.attributes.instanceColor.array;
        const oldGrp = geom.attributes.instanceGroupId.array;

        let total = 0;
        for (const e of this.renderedTexts.values()) total += e.glyphCount;

        let w = 0;
        for (const entry of this.renderedTexts.values()) {
            const r = entry.bufferStartIndex, n = entry.glyphCount;
            entry.bufferStartIndex = w;
            if (r !== w && n > 0) {
                oldPos.copyWithin(w * 3, r * 3, (r + n) * 3);
                oldSiz.copyWithin(w * 2, r * 2, (r + n) * 2);
                oldGid.copyWithin(w,     r,     r + n);
                oldCol.copyWithin(w * 3, r * 3, (r + n) * 3);
                oldGrp.copyWithin(w,     r,     r + n);
            }
            w += n;
        }

        for (const name of Object.keys(geom.attributes)) {
            geom.attributes[name].needsUpdate = true;
        }
        this._ensureHighlightTexture(total);
        geom.instanceCount = total;
    }

    /** @private */
    _writeGlyphsToGeometry(glyphs) {
        const count = Math.min(glyphs.length, this.config.maxInstances);
        const geom  = this.instanceMesh.geometry;
        const pos   = geom.attributes.instancePosition.array;
        const siz   = geom.attributes.instanceSize.array;
        const gids  = geom.attributes.instanceGlyphId.array;
        const col   = geom.attributes.instanceColor.array;
        const grp   = geom.attributes.instanceGroupId.array;

        for (let i = 0; i < count; i++) {
            const g = glyphs[i];
            pos[i * 3]     = g.position.x;
            pos[i * 3 + 1] = g.position.y;
            pos[i * 3 + 2] = g.position.z;
            siz[i * 2]     = g.size.width;
            siz[i * 2 + 1] = g.size.height;
            gids[i]        = g.charCode || 0;
            col[i * 3]     = g.color.r;
            col[i * 3 + 1] = g.color.g;
            col[i * 3 + 2] = g.color.b;
            grp[i]         = g.groupId || 0;
        }

        geom.attributes.instancePosition.needsUpdate = true;
        geom.attributes.instanceSize.needsUpdate     = true;
        geom.attributes.instanceGlyphId.needsUpdate  = true;
        geom.attributes.instanceColor.needsUpdate    = true;
        geom.attributes.instanceGroupId.needsUpdate  = true;

        this._ensureHighlightTexture(count);
        geom.instanceCount = count;
    }

    /**
     * Apply worker-prebuilt buffers.
     */
    applyPrebuiltBuffers(buffers, items) {
        const { positions, sizes, colors, groupIds, count } = buffers;
        const glyphIds = buffers.glyphIds || buffers.codepoints;
        let { itemMeta } = buffers;
        const geom = this.instanceMesh.geometry;

        geom.setAttribute('instancePosition', new THREE.InstancedBufferAttribute(positions, 3));
        geom.setAttribute('instanceSize',     new THREE.InstancedBufferAttribute(sizes, 2));
        geom.setAttribute('instanceGlyphId',  new THREE.InstancedBufferAttribute(glyphIds || new Float32Array(count), 1));
        geom.setAttribute('instanceColor',    new THREE.InstancedBufferAttribute(colors, 3));
        geom.setAttribute('instanceGroupId',  new THREE.InstancedBufferAttribute(groupIds || new Float32Array(count), 1));
        if (!geom.attributes.instancePickingId || geom.attributes.instancePickingId.array.length < count) {
            geom.setAttribute('instancePickingId', new THREE.InstancedBufferAttribute(new Float32Array(count), 1));
        }

        this._ensureHighlightTexture(count);
        geom.instanceCount = count;
        this.config.maxInstances = Math.max(this.config.maxInstances, count);

        this.renderedTexts.clear();
        this._cachedGlyphCount = 0;
        let rendererIds = null;

        if (itemMeta && items) {
            rendererIds = [];
            for (let i = 0; i < itemMeta.length; i++) {
                const meta = itemMeta[i];
                const id = this.nextId++;
                this.renderedTexts.set(id, {
                    id,
                    bufferStartIndex:  meta.bufferStartIndex,
                    glyphCount:        meta.glyphCount,
                    lineSlotOffsets:   meta.lineSlotOffsets || null,
                    // Preserve the layout tables the LayoutDescription / caret need.
                    // These were being DROPPED here — _buildLayoutWrapIndex then got
                    // undefined and built an all-empty wrap table, so the caret ignored
                    // intra-line wraps on long (>wrapWidth) lines. Carry them through.
                    wrapColsPerLine:   meta.wrapColsPerLine || null,
                    pageContentWidth:  meta.pageContentWidth || 0,
                });
                this._cachedGlyphCount += meta.glyphCount;
                rendererIds.push(id);
            }
        }
        return rendererIds;
    }

    /**
     * The authoritative per-glyph position buffer (xyz per slot) as bound to the
     * instanced geometry. The LayoutDescription reads this for buffer-backed
     * positionAt — the glyph's exact laid-out position (wrap + pagination already
     * applied), so the caret never re-derives layout math. Null before first flush.
     * @returns {Float32Array|null}
     */
    getInstancePositions() {
        return this.instanceMesh?.geometry?.attributes?.instancePosition?.array ?? null;
    }

    /**
     * Per-glyph [advance, height] buffer (xy per slot). Paired with
     * getInstancePositions for end-of-line caret placement (last glyph's right edge
     * = position + advance).
     * @returns {Float32Array|null}
     */
    getInstanceSizes() {
        return this.instanceMesh?.geometry?.attributes?.instanceSize?.array ?? null;
    }
}

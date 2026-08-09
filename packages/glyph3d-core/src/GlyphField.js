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
import { MeshBasicNodeMaterial, StorageInstancedBufferAttribute, TSL } from 'three/webgpu';

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
    storage,
} = TSL;

/** Upper bound on quadratic beziers per glyph (TSL loop cap). */
const MAX_CURVES = 256;

import { PERF_THRESHOLDS } from './core/constants.js';
import { computeCellMetrics } from './core/cellMetrics.js';
import { RENDER_MODE, buildGlyphVertexTransform, registerByteSlotsNode, registerByteSlotsMaterial, rebindByteSlots } from './core/glyphVertex.js';
import { FAR_TEX, FAR_SLAB } from './compute/glyphPipelineReference.js';

const MAX_GROUPS_DEFAULT = PERF_THRESHOLDS.defaultMaxGroups ?? 64;
const MAX_GROUPS_DIM     = 16000;

/**
 * Group DataTexture layout: GROUP_COLS RGBA32F texels per group (one texture row).
 *   col 0: offset.xyz            (w free)
 *   col 1: rotation quaternion   (xyzw; identity 0,0,0,1)
 *   col 2: color.rgb + alpha     (alpha ≤ 0.01 = invisible — the vertex cull)
 *   col 3: scale.xyz + colorBlend
 *   col 4: clipTop, clipBottom, clipEnabled (grid-local y window; w free)
 * A group texel is a full pose + style — the shared vertex transform
 * (core/glyphVertex.js) reads all five columns; the WebGL picking shaders in
 * PickingSystem.js sample columns 0–4 at (col + 0.5) / GROUP_COLS and must
 * change in the same breath as this layout.
 */
export const GROUP_COLS = 5;

/** Far-slab group carrier: a PARALLEL per-group texture (2 RGBA32F cols) so the
 *  far lanes never touch the pose texture's layout (PickingSystem samples cols
 *  0-4 of THAT one in lockstep). col 0 = [u0, v0, rowsPerTexel, colsPerTexel],
 *  col 1 = [hasSlab, …]. Nearest + textureLoad — RGBA32F is not filterable. */
export const FAR_GROUP_COLS = 2;

/**
 * GLOBAL minification / LOD dials — the exact-curve ↔ stable-block handoff that governs how minified
 * text degrades. These were baked float() literals (labelled "tune live in Firefox" but NOT actually
 * live — each change needed an edit + rebuild). Promoted to uniforms so the handoff can be dialed IN
 * MOTION (flicker is only judgeable in motion) and per device (a phone's DPI wants a different handoff
 * than a 4K panel). ONE shared set across every glyph material — a render-quality setting, not per-grid;
 * driven by setGlyphLodParam ← the `glyph.*` entries in app settings.
 *
 * Footprints are fwidth(glyphUV) = the fraction of a glyph cell one pixel spans (bigger = smaller on
 * screen). The stable IMPOSTOR block is the only flicker-free path (a per-glyph constant has no sub-pixel
 * strokes to alias); the dilation/softening of the exact path only attenuates flicker. So the lever for
 * killing flicker is the lod* band — hand off to the block where the exact path stops being resolvable.
 *   dilatePx/soften — minification fuzz shape (ink fattening + AA-ramp widening).
 *   minLo/minHi     — fuzz band: onset → full (footprint).
 *   lodLo/lodHi     — exact → block cross-fade band (footprint). Pull DOWN to kill flicker sooner.
 *   density/maxCov  — the impostor block's coverage (curveCount·density, capped).
 *   lodAxisBias     — 0 = switch on the BEST-resolved axis (today: angled text stays exact longer);
 *                     1 = switch on the WORST axis (engage the block on the foreshortened axis that
 *                     actually flickers). The research-flagged lever for angled-surface flicker.
 *   farBias         — mip-LOD bias on the FAR TEXTURE sample (the content-derived text-mass
 *                     that replaces the impostor for slabbed groups). + coarsens (more stable,
 *                     blurrier), − sharpens. The sample's explicit level comes from the far-UV
 *                     footprint in uniform flow — never implicit LOD inside a branch (the
 *                     atlas-map lesson: non-uniform flow clamps to mip 0 → the same moiré).
 */
export const GLYPH_LOD_DEFAULTS = Object.freeze({
    dilatePx: 0.75, soften: 0.45,
    minLo: 0.06, minHi: 0.20,
    lodLo: 0.30, lodHi: 0.60,
    density: 0.035, maxCov: 0.72,
    lodAxisBias: 0,
    farBias: 0,
});

const LOD_UNIFORMS = Object.fromEntries(
    Object.entries(GLYPH_LOD_DEFAULTS).map(([k, v]) => [k, uniform(v)]),
);

/** Set one global LOD dial live. Keys: see GLYPH_LOD_DEFAULTS. Ignores unknown keys / non-finite values. */
export function setGlyphLodParam(key, value) {
    const u = LOD_UNIFORMS[key];
    if (u && Number.isFinite(value)) u.value = value;
}

/** Read the current global LOD dials (settings defaults / debugging). */
export function getGlyphLodParams() {
    const out = {};
    for (const k in LOD_UNIFORMS) out[k] = LOD_UNIFORMS[k].value;
    return out;
}

// The glyph width-compression dial (GLYPH_WIDTH_COMPRESS_DEFAULT / setGlyphWidthCompress
// / getGlyphWidthCompress) lives in core/glyphVertex.js now — it is a position input, so
// it must be ONE node shared by the render AND pick paths (a shared-equation with two
// values would still drift). Import it from there.

// ─── TSL vertex node ─────────────────────────────────────────────────────────

/**
 * Build the TSL vertex node for instanced glyph RENDERING. The instance → clip
 * position transform (quad sizing, group transform, culls) is shared with the
 * GPU picking material via buildGlyphVertexTransform (core/glyphVertex.js), so
 * the two can't drift; this node layers the render-only varyings (color blend,
 * highlight, glyph UV) on top of the transform's byproducts.
 *
 * @param {Object} uniforms - per-object nodes (groupTex, highlightTex, glyphMapTex,
 *   glyphMapWidth, renderMode) — forwarded to the shared transform; highlightTex is
 *   consumed here for the per-glyph highlight. (Clip rides the group texture now.)
 * @returns {Object} { vertexFn, vColor, vGroupAlpha, vAddedColor, vFillAmount,
 *   vGlyphUV, vCurveStart, vCurveCount, vMode, vEmojiCell }
 */
function _buildVertexNode(uniforms) {
    // instanceColor is the one instance attribute the position transform does NOT own
    // (it drives the fragment color blend); declare it here. The position attributes
    // (instancePosition/Size/GlyphId/GroupId) are declared inside the shared transform.
    // STRIDE-4 (itemSize 4 — a StorageInstancedBufferAttribute, so the far-scatter
    // kernel can ALSO bind it as a compute-readable storage view; a vec3 storage
    // attribute would get repacked by three and silently move every writer's lanes).
    // Read as vec4/.xyz — same precedent as instancePosition (glyphVertex.js).
    const iColor = attribute('instanceColor', 'vec4');

    // Varyings passed to fragment
    const vColor      = varying(vec3(0),  'vColor');
    const vGroupAlpha = varying(float(1), 'vGroupAlpha');
    const vAddedColor = varying(vec3(0),  'vAddedColor');
    const vFillAmount = varying(float(0), 'vFillAmount');   // highlight alpha: 0=tint (additive), >0=background-fill opacity
    const vGlyphUV    = varying(vec2(0),  'vGlyphUV');
    const vCurveStart = varying(int(0),   'vCurveStart');
    const vCurveCount = varying(int(0),   'vCurveCount');
    // Bitmap/emoji branch varyings
    const vMode       = varying(int(0),   'vMode');
    const vEmojiCell  = varying(int(0),   'vEmojiCell');
    // Far-texture varyings: the glyph's grid (row,col) + the group's slab lanes
    const vRowCol     = varying(vec2(0),  'vRowCol');
    const vFarSlab    = varying(vec4(0),  'vFarSlab');      // [u0, v0, rowsPerTexel, colsPerTexel]
    const vFarMeta    = varying(vec4(0),  'vFarMeta');      // [hasSlab, …]

    const { highlightTex, byteHighlight, farGroupTex } = uniforms;

    const vertexFn = Fn(() => {
        // The ONE transform graph — shared with PickingSystem, so the rendered glyph
        // and its pick target can never drift (group scale, width compress, emoji quad,
        // and the visibility + frame-clip culls all live there). Returns clip position
        // plus the byproducts this material needs for its varyings.
        const t = buildGlyphVertexTransform(uniforms);

        // Resolved mode + glyph-map byproducts → varyings. The frame-mode override
        // (vMode forced to FRAME, cell = instanceGlyphId) already happened inside the
        // transform; these forward its results to the fragment's branch selectors.
        vMode.assign(t.vMode);
        vEmojiCell.assign(t.vEmojiCell);
        vCurveStart.assign(int(t.glyphInfo.x));
        vCurveCount.assign(int(t.glyphInfo.y));

        // Far-texture: the glyph's grid position (the transform's S_ROW/S_COL read;
        // (0,0) on classic fields, whose far-group texel stays hasSlab=0) and the
        // group's slab lanes — the fragment builds its far UV from these. RGBA32F
        // nearest, textureLoad (NOT filterable — the group texture's own caveat).
        vRowCol.assign(t.iRowCol);
        if (farGroupTex) {
            const fGrow = int(t.iGroup);
            vFarSlab.assign(textureLoad(farGroupTex, ivec2(int(0), fGrow)));
            vFarMeta.assign(textureLoad(farGroupTex, ivec2(int(1), fGrow)));
        }

        // Blend instanceColor*groupColor (multiply, colorBlend=0) toward pure
        // groupColor (replace, colorBlend=1). Explicit lerp a+(b-a)*t — TSL's
        // .mix() method returned the wrong operand at t=0 here (handed back the
        // group color instead of the multiplied base), washing text to white.
        const colorBlend = t.gScale.w;
        const baseColor  = iColor.xyz.mul(t.gColor.rgb);
        vColor.assign(baseColor.add(t.gColor.rgb.sub(baseColor).mul(colorBlend)));
        vGroupAlpha.assign(t.gColor.a);

        // Per-glyph highlight. BYTE kind: a normalized RGBA8 INSTANCE ATTRIBUTE — a
        // texture cannot span the mega-field (arena-capacity rows blow
        // maxTextureDimension2D, and any texel write re-uploads the whole thing);
        // an attribute has no dimension limit and uploads by update-range. Classic
        // kinds keep their small per-field RGBA8 DataTexture (1024 wide, 2D wrapped).
        // Either way RGBA8 unorm reads as [0,1] — identical downstream math.
        if (byteHighlight) {
            const highlight = attribute('instanceHighlight', 'vec4');
            vAddedColor.assign(highlight.rgb);
            vFillAmount.assign(highlight.a);
        } else {
            const hx = int(instanceIndex).mod(int(1024));
            const hy = int(instanceIndex).div(int(1024));
            const highlight = textureLoad(highlightTex, ivec2(hx, hy));
            vAddedColor.assign(highlight.rgb);
            // The alpha byte is the MODE/opacity carrier: 0 → additive tint (legacy),
            // >0 → background-fill opacity.
            vFillAmount.assign(highlight.a);
        }

        // PlaneGeometry's uv attribute is [0,1] across the quad → glyph-space [0,1]².
        vGlyphUV.assign(uv());

        return t.clipPos;
    });

    return { vertexFn, vColor, vGroupAlpha, vAddedColor, vFillAmount, vGlyphUV, vCurveStart, vCurveCount, vMode, vEmojiCell, vRowCol, vFarSlab, vFarMeta };
}

/**
 * Build TSL fragment (output) node — Slug analytic coverage + bitmap emoji branch.
 *
 * Fragment shader: accumulate fractional winding over every quadratic bezier in the
 * glyph along an X ray and a Y ray, scaled by the per-pixel footprint (fwidth). This
 * is single-sample analytic coverage: crisp at any magnification, and 1D per ray —
 * each ray antialiases only along its own axis. Under minification the ink is dilated
 * and the AA ramp softened (the `m` ramp in the body) so zoomed-out text settles to a
 * stable fuzzy silhouette rather than flickering its strokes away. The foreshortened-
 * minification breakup — the axis perpendicular to both rays is under-resolved — is
 * structural to single-sample coverage; the standing fix for that regime is a mipped,
 * anisotropically-filtered glyph-atlas LOD, deferred for now.
 *
 * When vMode == 1 (bitmap emoji) the bezier path is skipped and the glyph is
 * sampled from the RGBA emoji atlas instead (see bitmap branch below).
 *
 * @param {Object} varyings - { vColor, vGroupAlpha, vAddedColor, vFillAmount, vGlyphUV, vCurveStart, vCurveCount, vMode, vEmojiCell }
 * @param {Object} uniforms - { curveTex, emojiTex, emojiCols }
 */
function _buildOutputNode(varyings, uniforms) {
    const { vColor, vGroupAlpha, vAddedColor, vFillAmount, vGlyphUV, vCurveStart, vCurveCount, vMode, vEmojiCell, vRowCol, vFarSlab, vFarMeta } = varyings;
    const { curveTex, emojiTex, emojiCols, emojiRows, frameTex, frameCols, frameRows, farTex } = uniforms;

    // Minification tuning knobs — now LIVE uniforms (GLYPH_LOD_DEFAULTS / setGlyphLodParam), dialable
    // via app settings. DILATE_PX = half-width, in pixels, of the stroke fattening applied at full
    // zoom-out; SOFTEN = how much the AA ramp widens. (Same nodes the math below already operated on.)
    const DILATE_PX = LOD_UNIFORMS.dilatePx;
    const SOFTEN    = LOD_UNIFORMS.soften;

    return Fn(() => {
        // Invisible groups (alpha ≤ 0.01) are already culled in the shared vertex
        // transform — degenerated to off-screen NDC, so they never rasterize and this
        // fragment never runs for them. Partial alpha in (0.01, 1) still blends here
        // via vGroupAlpha.

        // Output color accumulator; filled by whichever branch executes.
        const outColor = vec4(0).toVar();

        If(vMode.equal(int(RENDER_MODE.FRAME)), () => {
            // ── Frame branch: external NxM video/image grid sampled as the atlas ──
            // Field-level frame mode (vertex forced vMode = 2). The source frame is a
            // grid of `frameCols × frameRows` equal cells; the cell index is the
            // per-instance vEmojiCell (= instanceGlyphId). Independent cols/rows (unlike
            // the single-`emojiCols` emoji path) so a 16:9 capture reassembles without
            // square-cell squish. vGlyphUV is [0,1]² across the quad → the sub-cell.
            const fcol = float(vEmojiCell).mod(frameCols);
            const frow = float(vEmojiCell).div(frameCols).floor();
            const frameUV = vec2(
                fcol.add(vGlyphUV.x).div(frameCols),
                // VideoTexture uploads flipY=true (unlike the flipY=false emoji canvas),
                // so the emoji-path flip double-flips and the frame lands upside down.
                // Invert the v build — row order AND sub-cell — to mirror it upright.
                frameRows.sub(1).sub(frow).add(vGlyphUV.y).div(frameRows)
            );
            const ftexel = frameTex.sample(frameUV);
            // vColor (instanceColor) modulates: white = the frame's true color, or a
            // per-cell tint for effects. The frame texture is tagged SRGBColorSpace, so
            // three's texture node already linearizes on sample (the documented WebGPU
            // VideoTexture path) — do NOT pow() here, that would double-decode. If the
            // frame looks too bright/washed, the conversion isn't reaching this
            // outputNode: tag the texture NoColorSpace and restore .pow(vec3(2.2)),
            // matching the emoji branch's manual decode below. (colorspace dial)
            outColor.assign(vec4(ftexel.rgb.mul(vColor), ftexel.a.mul(vGroupAlpha)));

        }).Else(() => {
        If(vMode.equal(int(RENDER_MODE.BITMAP)), () => {
            // ── Bitmap / emoji branch ────────────────────────────────────────────
            // Atlas is an `emojiCols × emojiRows` grid of equal square cells — it grows
            // SQUARELY (both double), but U÷cols and V÷rows are kept independent so any
            // grid shape samples correctly.
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
                row.add(float(1).sub(vGlyphUV.y)).div(emojiRows)   // ← /ROWS; flip ACTIVE (flipY=false atlas)
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
            // ── Slug bezier-coverage branch ─────────────────────────────────────
            // FAR-TEXTURE SAMPLE — HOISTED to uniform flow, before every branch.
            // The explicit mip level is derived from the far-UV footprint (fwidth)
            // and fwidth is only valid in uniform control flow: sampled inside the
            // fwLod If below, the implicit LOD would clamp to mip 0 and point-sample
            // the atlas — reproducing the exact moiré this texture exists to kill
            // (the atlas-map lesson). The texel carries avg LINEAR syntax color in
            // rgb and avg ink coverage in a (see compute/glyphPipelineReference's
            // FAR block); slab-less groups (classic fields, atlas exhaustion) read
            // hasFar=0 and take the impostor fallback below, unchanged.
            const hasFar = vFarMeta.x.greaterThan(float(0.5));
            const farRpt = vFarSlab.z.max(float(1e-6));
            const farCpt = vFarSlab.w.max(float(1e-6));
            // Slab-local UV of this fragment: the glyph's grid (row, col) + its
            // sub-cell fraction (the quad's top maps toward the row's start, so the
            // v fraction runs inverted), texels normalized to [0,1] within the slab.
            const farLocal = vec2(
                vRowCol.y.add(vGlyphUV.x).div(farCpt),
                vRowCol.x.add(float(1).sub(vGlyphUV.y)).div(farRpt),
            ).div(float(FAR_SLAB)).clamp(vec2(0), vec2(1));
            const farUV = vFarSlab.xy.add(farLocal.mul(float(FAR_SLAB / FAR_TEX)));
            const fwFar = fwidth(farUV).mul(float(FAR_TEX));   // atlas texels per pixel
            const farLod = fwFar.x.max(fwFar.y).max(float(1)).log2().add(LOD_UNIFORMS.farBias);
            const farTexel = farTex.sample(farUV).level(farLod).toVar('farTexel');

            // Empty glyph (space / .notdef = 0 curves) → no ink, so the fast path discards it…
            // EXCEPT when it carries a background FILL (vFillAmount>0): a space inside a highlight
            // bar must paint its cell, or the bar gaps at every whitespace. And except under a far
            // slab: the text MASS is continuous there — a discarded space is a hole in the mass,
            // so zero-curve glyphs survive to sample the far texture (its near-zero coverage still
            // culls truly empty texels at the outAlpha discard below).
            Discard(vCurveCount.equal(int(0)).and(vFillAmount.equal(float(0))).and(hasFar.not()));

            // Pixel footprint in glyph-UV space, per axis. fwidth is the screen-space
            // derivative magnitude, so AA is resolution-independent.
            const fw = fwidth(vGlyphUV).toVar();

            // Minification amount, 0→1. fwMax = worst-axis footprint = the fraction of the glyph
            // cell one pixel spans. Small ⇒ magnified (crisp, single-sample). Large ⇒ many strokes
            // per pixel, where the centre sample beats sub-pixel against the strokes and they alias
            // in and out (the moiré). A point sample cannot resolve sub-pixel strokes: box-filter
            // aliasing is invariant to sample count, so supersampling only trades the moiré for a
            // screen-door grid. The minified regime is therefore handled by graceful degradation —
            // Slug's shipping approach: as the glyph shrinks, (a) DILATE the ink so thin strokes
            // fatten-and-merge into a stable shape rather than dropping below a pixel and vanishing,
            // and (b) SOFTEN the AA ramp so edges blur. The result is the "forgot my glasses" look
            // — unreadable but a steady, recognisable silhouette. `m` smoothstep-ramps so the
            // hand-off has no seam under a continuous dolly.
            // ↓↓ THE "scaling speed" DIALS — tune live in Firefox ↓↓
            // MIN_LO = fuzz ONSET (footprint where softening begins). RAISE it to keep text crisp
            //   farther out / start the fuzz later (i.e. less fuzzy at a given distance).
            // MIN_HI = fuzz FULL (footprint for max dilation+softening).
            // The MIN_LO→MIN_HI gap IS the ramp speed: widen it for a gentler, slower fade-to-fuzzy.
            // Minification + LOD dials — LIVE uniforms (GLYPH_LOD_DEFAULTS / setGlyphLodParam), same
            // nodes the math already used (were float() literals). Tune in motion via app settings.
            const MIN_LO = LOD_UNIFORMS.minLo;       // fuzz onset (~16px glyph at the default 0.06)
            const MIN_HI = LOD_UNIFORMS.minHi;       // fuzz full  (~5px glyph at the default 0.20)
            const LOD_LO      = LOD_UNIFORMS.lodLo;  // begin fading exact → impostor (~3px at 0.30)
            const LOD_HI      = LOD_UNIFORMS.lodHi;  // fully impostor beyond here (~1.5px at 0.60)
            const LOD_DENSITY = LOD_UNIFORMS.density; // curveCount → coverage (cheap ink-density proxy)
            const LOD_MAXCOV  = LOD_UNIFORMS.maxCov;  // cap so the densest glyphs don't fully saturate
            const fwMax = fw.x.max(fw.y);
            // LOD switch uses the BEST-resolved axis (min footprint), not the worst.
            // An angled page foreshortens one axis, which spikes fwMax and would flip
            // readable angled text to the impostor too early (the threshold appears to
            // move with viewing angle). fwMin only crosses the cutoff when the glyph is
            // small in BOTH axes — i.e. genuinely tiny — so the switch tracks real
            // on-screen size, not the camera angle. (fwMax still drives AA dilation below,
            // where worst-axis IS what we want for moiré.)
            const fwMin = fw.x.min(fw.y);
            // The footprint that drives the exact→block LOD switch. lodAxisBias lerps it from the
            // BEST-resolved axis (fwMin, 0 = today: angled text keeps the exact path longer) toward
            // the WORST axis (fwMax, 1: engage the block on the foreshortened axis that flickers).
            const fwLod = fwMin.add(fwMax.sub(fwMin).mul(LOD_UNIFORMS.lodAxisBias));
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
            // fragment, only to produce a fuzzy blob. Past LOD_HI we skip the loop
            // entirely and approximate coverage from the glyph's curve count (a cheap
            // ink-density proxy: denser glyphs read darker). This is the LOD that lets
            // an entire repo render at once — distant files become cheap colored
            // text-mass, and the exact analytic path returns as the camera approaches.
            // Impostor coverage (cheap, no loop): curve count as an ink-density proxy.
            // Now the FALLBACK for slab-less groups — a slabbed group's far coverage
            // comes from the prefiltered texture instead of this content-blind constant.
            const impostorCov = float(vCurveCount).mul(LOD_DENSITY).clamp(0, LOD_MAXCOV);
            const farCov = hasFar.select(farTexel.a, impostorCov);
            // The far texel's rgb is LINEAR (the scatter linearizes before averaging) —
            // re-encode to the authored-sRGB space the downstream composite speaks
            // (its final pow(2.2) round-trips it back). Fallback: the glyph's own color.
            const vColorFar = hasFar.select(farTexel.rgb.pow(vec3(0.4545)), vColor);
            const cov = float(0).toVar();
            const colSel = vColor.toVar('colSel');
            If(fwLod.greaterThan(LOD_HI), () => {
                cov.assign(farCov);        // far: strokes unresolvable → prefiltered mass
                colSel.assign(vColorFar);  // …in the mass's average color
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
                // Cross-fade exact → far across [LOD_LO, LOD_HI] so the quality
                // switch has no hard seam (the diagonal line that otherwise sweeps an
                // angled wall). smoothstep ramp; manual mix to avoid extra imports.
                // Color rides the same ramp: per-glyph hue → the mass's average hue.
                const t = fwLod.sub(LOD_LO).div(LOD_HI.sub(LOD_LO)).clamp(0, 1).toVar();
                t.assign(t.mul(t).mul(float(3).sub(t.mul(2))));
                cov.assign(exactCov.add(farCov.sub(exactCov).mul(t)));
                colSel.assign(vColor.add(vColorFar.sub(vColor).mul(t)));
            });
            // Highlight has two modes, carried by the highlight texel's alpha (vFillAmount):
            //   TINT (alpha 0, legacy): an additive glyph tint — vColor·cov + vAddedColor.
            //   FILL (alpha >0): a background BAR — the cell rect fills with vAddedColor at
            //     opacity=vFillAmount and the glyph ink (vColor) composites ON TOP via coverage.
            // The quad spans the full advance cell (quadW=iSize.x), so adjacent FILL cells tile
            // into a seamless bar. One draw, analytic composite, no extra pass.
            const isFill = vFillAmount.greaterThan(float(0));

            // A TINT cell with no ink is empty → discard (the legacy cov<0.01 cull). A FILL cell
            // is never coverage-empty (the bar IS the point) → only cull when even the fill is clear.
            Discard(isFill.select(vFillAmount, cov).lessThan(0.01));

            // alpha: a FILL cell is opaque to at least its fill opacity even ink-free; a TINT cell
            // (vFillAmount=0) reduces to cov, since max(cov,0)=cov. Then × group visibility.
            const outAlpha = cov.max(vFillAmount).mul(vGroupAlpha);
            Discard(outAlpha.lessThan(0.01));

            // vAddedColor coefficient: TINT adds it fully (k=1); FILL lerps fill→ink by coverage,
            // i.e. k=(1−cov) so cov=0 is pure fill and cov=1 is pure ink. Explicit lerp — NOT TSL
            // .mix() (it returns the wrong operand at t=0; see the vertex colorBlend note).
            const addK = isFill.select(float(1).sub(cov), float(1));
            const finalColor = colSel.mul(cov).add(vAddedColor.mul(addK)).clamp(0, 1);
            // Glyph colors are authored as display (sRGB) values; decode to linear so
            // the renderer's default sRGB output-encode returns them to the authored
            // value — consistent with the THREE.Color-managed rest of the scene
            // (which needs sRGB output and goes dark if output encoding is disabled).
            outColor.assign(vec4(finalColor.pow(vec3(2.2)), outAlpha));
        });
        });   // close frame-mode .Else (wraps the emoji/slug If·Else)

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
 * (Dobbie / Lengyel "Slug".) Structured as guarded accumulation for clean TSL codegen.
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
                // STABLE roots: q = b.y + sign(b.y)·s (the larger-magnitude numerator, so no
                // cancellation), then the two roots are q/a.y and c.y/q. The naive (b.y ∓ s)/a.y
                // cancels catastrophically when a.y is small (the curve runs ~parallel to the ray,
                // so b.y ≈ s); at magnification invDiameter amplifies that lost precision into a
                // SPURIOUS crossing — the faint stray lines along near-axis curves. t0 = exit
                // (dy<0), t1 = enter (dy>0); which of q/a.y vs c.y/q is which flips with sign(b.y).
                const q = b.y.add(b.y.greaterThanEqual(0).select(s, s.negate()));
                If(b.y.greaterThanEqual(0), () => {
                    t0.assign(c.y.div(q));
                    t1.assign(q.div(a.y));
                }).Else(() => {
                    t0.assign(q.div(a.y));
                    t1.assign(c.y.div(q));
                });
            }).Else(() => {
                solvable.assign(0); // radicand ≤ 0 → no crossing
            });
        }).Else(() => {
            // Degenerate quadratic = line segment; one root, assigned by direction.
            // Guard the division: if the endpoints sit at (nearly) the same y, the segment
            // runs ∥ to the ray — there's no well-defined crossing, and p0.y/(p0.y−p2.y)
            // would divide by ~0 → a garbage t that can land in [0,1) and paint a stray
            // near-horizontal line. Skip it; the orthogonal ray (which sees this curve as
            // ~perpendicular) resolves it stably. This is the long-standing "curve goes off
            // the rails" artifact (e.g. the thin line on 'g').
            const denom = p0.y.sub(p2.y);
            If(denom.abs().greaterThanEqual(1e-6), () => {
                const t = p0.y.div(denom);
                If(p0.y.lessThan(p2.y), () => {
                    t0.assign(-1); t1.assign(t);
                }).Else(() => {
                    t0.assign(t); t1.assign(-1);
                });
            }).Else(() => {
                solvable.assign(0);
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

// ─── Shared field material ────────────────────────────────────────────────────
// Three's WebGPU renderer keys its shader cache by NODE INSTANCE identity
// (Node.customCacheKey() → node.id), so a material per field means every grid pays
// a full TSL graph analysis + WGSL build — ~8ms each, seconds on a repo load.
// Instead ONE material per kind (glyph / occluder) is shared by every field. All
// per-field state — group/highlight/slug textures, clip window, emoji atlas —
// resolves PER OBJECT at draw: the mesh carries its field on userData.glyphField
// and these nodes read it in onObjectUpdate callbacks. Bindings are cloned per
// render object (NodeBuilderState.createBindings), so two grids bind different
// textures under the same material; the placeholder initial values fix the WGSL
// sample types (float/uint/filterable), which every real texture matches.

const _sharedFieldMaterials = new Map(); // 'glyph' | 'occluder' → MeshBasicNodeMaterial

/** 1×1 RGBA float placeholder matching the group DataTexture's sample type. */
function _makePlaceholderFloatTexture() {
    const tex = new THREE.DataTexture(
        new Float32Array(4), 1, 1,
        THREE.RGBAFormat, THREE.FloatType
    );
    tex.minFilter       = THREE.NearestFilter;
    tex.magFilter       = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate     = true;
    return tex;
}

/** Texture node whose value resolves per rendered object from its field. */
function _fieldTexture(placeholder, prop) {
    return texture(placeholder).onObjectUpdate(({ object }, self) => {
        const f = object && object.userData && object.userData.glyphField;
        return (f && f[prop]) || self.value;
    });
}

/** Uniform node whose value resolves per rendered object from its field. */
function _fieldUniform(initial, read) {
    return uniform(initial).onObjectUpdate(({ object }, self) => {
        const f = object && object.userData && object.userData.glyphField;
        return f ? read(f) : self.value;
    });
}

/**
 * Storage-buffer node whose value resolves per rendered object from its field — the
 * byte-pipeline seam. A byte-mode field carries NO position/size/glyphId instance
 * attributes; the vertex transform reads the pipeline's stride-11 slot buffer instead
 * (see core/glyphVertex.js). The placeholder keeps the node valid before any pipeline
 * attaches. Read-only: vertex-stage storage is core WebGPU only as read-only.
 */
function _fieldSlots() {
    const placeholder = new StorageInstancedBufferAttribute(new Float32Array(4), 1);
    return registerByteSlotsNode(storage(placeholder, 'float', 1).toReadOnly().onObjectUpdate(({ object }, self) => {
        const f = object && object.userData && object.userData.glyphField;
        return (f && f._byteSlots) || self.value;
    }));
}

/** The one material all fields of a kind share — built (and TSL-compiled) once. */
function _getSharedFieldMaterial(kind) {
    let material = _sharedFieldMaterials.get(kind);
    if (material) return material;

    // Byte-pipeline kind: position/size/glyphId come from the pipeline's slot buffer,
    // resolved per field (see _fieldSlots); slot index == instance index. Highlight is
    // an instance attribute on the byte kind (see _buildVertexNode) — no texture node.
    const isByte = kind === 'byteGlyph';

    const groupTexNode     = _fieldTexture(_makePlaceholderFloatTexture(), '_groupTexture');
    const groupTexHNode    = _fieldUniform(1, (f) => f._maxGroups);
    const highlightTexNode = isByte ? null : _fieldTexture(_makePlaceholderRGBATexture(), '_highlightTexture');
    const curveTexNode     = _fieldTexture(_makePlaceholderUintTexture(), '_curveTexture');
    const glyphMapTexNode  = _fieldTexture(_makePlaceholderUintTexture(), '_glyphMapTexture');
    const glyphMapWNode    = _fieldUniform(1, (f) => f._glyphMapWidth);
    const emojiTexNode     = _fieldTexture(_makePlaceholderRGBATexture(), '_emojiTexture');
    const emojiColsNode    = _fieldUniform(16, (f) => f._emojiCols);
    const emojiRowsNode    = _fieldUniform(16, (f) => f._emojiRows);
    // Frame-mode (external NxM image/video) nodes — resolve per object like the rest.
    const renderModeNode   = _fieldUniform(RENDER_MODE.GLYPH, (f) => f._renderMode || RENDER_MODE.GLYPH);
    const frameTexNode     = _fieldTexture(_makePlaceholderRGBATexture(), '_frameTexture');
    const frameColsNode    = _fieldUniform(1, (f) => f._frameCols || 1);
    const frameRowsNode    = _fieldUniform(1, (f) => f._frameRows || 1);
    const byteSlotsNode    = isByte ? _fieldSlots() : null;
    // Far-texture nodes: the sampled slab atlas (filterable, mipped — set by the
    // mega-field from the arena's FarTextAtlas) and the per-group slab lanes.
    const farTexNode       = _fieldTexture(_makePlaceholderRGBATexture(), '_farAtlasTexture');
    const farGroupTexNode  = _fieldTexture(_makePlaceholderFloatTexture(), '_farGroupTexture');

    const { vertexFn, vColor, vGroupAlpha, vAddedColor, vFillAmount, vGlyphUV, vCurveStart, vCurveCount, vMode, vEmojiCell, vRowCol, vFarSlab, vFarMeta } =
        _buildVertexNode({
            groupTex:       groupTexNode,
            groupTexHeight: groupTexHNode,
            highlightTex:   highlightTexNode,
            byteHighlight:  isByte,
            glyphMapTex:    glyphMapTexNode,
            glyphMapWidth:  glyphMapWNode,
            renderMode:     renderModeNode,
            byteSlots:      byteSlotsNode,
            farGroupTex:    farGroupTexNode,
        });

    const outputNode = kind === 'occluder'
        ? _buildOccluderOutputNode({ vColor, vGroupAlpha, vCurveCount })
        : _buildOutputNode(
            { vColor, vGroupAlpha, vAddedColor, vFillAmount, vGlyphUV, vCurveStart, vCurveCount, vMode, vEmojiCell, vRowCol, vFarSlab, vFarMeta },
            {
                curveTex: curveTexNode, emojiTex: emojiTexNode, emojiCols: emojiColsNode, emojiRows: emojiRowsNode,
                frameTex: frameTexNode, frameCols: frameColsNode, frameRows: frameRowsNode,
                farTex: farTexNode,
            }
        );

    material = new MeshBasicNodeMaterial();
    material.vertexNode  = vertexFn();
    material.outputNode  = outputNode;
    material.side        = THREE.DoubleSide;
    if (kind === 'occluder') {
        // Opaque + depth-writing → Three renders these grids front-to-back, so the
        // GPU's early-Z occludes hidden towers (the discard-free occluder node keeps
        // early-Z enabled). This collapses deep-skyline overdraw to ~one layer.
        material.transparent = false;
        material.depthWrite  = true;
        material.depthTest   = true;
    } else {
        material.transparent = true;
        material.depthWrite  = true;
        // Transparent + DoubleSide makes three render the mesh TWICE (back faces,
        // then front — r155+ behavior, WebGPU included). For the mega field that
        // is the WHOLE ARENA's instances twice per frame — measured as 62M
        // triangles/frame at a 15.5M-byte staging, half of it this. Glyph quads
        // never relied on back/front intra-mesh ordering (the WebGL era was
        // always single-pass), so opt out.
        material.forceSinglePass = true;
    }

    if (isByte) registerByteSlotsMaterial(material);
    _sharedFieldMaterials.set(kind, material);
    return material;
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
     * @param {boolean} [options.frustumCulled=true] - Per-object frustum culling of the instance
     *     mesh. A field whose glyph positions ride group offsets must pass false: offsets are GPU
     *     state the CPU-side bounds cannot see, so the bounding sphere is false and three would
     *     cull the whole mesh mid-scene — e.g. the container-label field spanning the whole tree.
     */
    constructor(scene, atlas, options = {}) {
        this.scene  = scene;
        this.atlas  = atlas;

        this._slugData = options.slugData || (atlas && atlas._slugData) || null;
        this._shaper   = options.shaper   || (atlas && atlas._shaper)   || null;

        // Opaque occluder LOD mode (dense distant scenes) — see _createInstanceMesh.
        this._occluder = !!options.occluder;

        // Byte-pipeline mode: the byte-in GPU pipeline owns this field's positions/sizes/
        // glyphIds — the vertex transform reads the pipeline's stride-11 slot buffer (see
        // _fieldSlots / core/glyphVertex.js), so this field never carries those instance
        // attributes. _byteSlots attaches at first load; slot index == instance index ==
        // arena byte offset (the mega-field is the one byte field, spanning the arena).
        this._bytePipeline = !!options.bytePipeline;
        this._byteSlots = null;

        // Frustum-cull opt-out (see _createInstanceMesh): the CPU-side geometry bounds cover
        // instance positions only, so a field anchored via group offsets has a false bounding
        // sphere and must not be culled as one unit.
        this._frustumCulled = options.frustumCulled !== false;

        // Register with the live Slug atlas so on-demand glyph encoding (box-drawing,
        // spinner stars, rounded corners, …) hot-swaps fresh curve textures into us.
        if (atlas && atlas._live && typeof atlas._live.registerField === 'function') {
            atlas._live.registerField(this);
        }

        const atlasCharSize = atlas.getCharSize();
        const scale = options.worldScale || 0.025;

        // Shared cell metrics (real em, contiguous cells) — same source CodeGrid uses, so the
        // terminal and code grids share one layout. This is what carries the spacing fix here.
        this.metrics = computeCellMetrics(atlasCharSize, scale);

        this.config = {
            maxInstances: options.maxInstances || PERF_THRESHOLDS.maxInstancesPerMesh,
            defaultColor: options.defaultColor || { r: 0.0, g: 1.0, b: 0.0 },
            worldScale: scale,
        };

        // Group DataTexture
        const requestedGroups = options.maxGroups || MAX_GROUPS_DEFAULT;
        this._maxGroups  = Math.min(requestedGroups, MAX_GROUPS_DIM);
        this._groupData  = new Float32Array(this._maxGroups * GROUP_COLS * 4);
        this._groupCount = 1; // group 0 = identity
        this._initGroupDefaults();
        this._groupTexture = null; // created in _createInstanceMesh

        // Highlight texture
        this._highlightTexture  = null;
        this._highlightSize     = 0;
        this._highlightTexWidth = 1024;

        // Far-texture state: the SAMPLED slab atlas is external (the arena's
        // FarTextAtlas, handed to the mega-field — shared across every view);
        // the per-group slab lanes are this field's own parallel texture.
        this._farAtlasTexture = null;
        this._farGroupData    = new Float32Array(this._maxGroups * FAR_GROUP_COLS * 4);
        this._farGroupTexture = null;   // created in _createInstanceMesh

        // Text registry (the shape PickingSystem.resolveGlyph reads)
        this.renderedTexts     = new Map();
        this.nextId            = 1;
        this._cachedGlyphCount = 0;

        // Batch mode
        this._batchMode  = false;
        this._batchDirty = false;

        // TSL uniform nodes — stored for hot-swap (setGroupOffset, _ensureHighlightTexture, etc.)
        // Per-field shader state, resolved PER OBJECT by the shared material (the
        // mesh's userData.glyphField points back here; the material's nodes read
        // these fields in onObjectUpdate callbacks — no per-field uniform nodes).
        // (Clip is per-GROUP texel state now — setGroupClipY — not per-field.)
        // (The emoji texture + dims are GETTERS on this class — they delegate to the
        // live atlas per draw, so a growth re-creation can never strand the field on
        // a disposed texture and dims never go stale. See setEmojiTexture.)

        // Frame mode: render the whole field as an NxM grid sampled from an external
        // texture (screen capture / video / image) instead of glyphs. Defaults to the
        // GLYPH path; setFrameTexture() flips it to FRAME (see RENDER_MODE).
        this._renderMode   = RENDER_MODE.GLYPH;
        this._frameTexture = null;
        this._frameCols    = 1;
        this._frameRows    = 1;

        // Slug curve + glyph-map textures (resolved in _ensureSlugTextures)
        this._curveTexture    = null;
        this._glyphMapTexture = null;
        this._glyphMapWidth   = 1;

        // Build instance mesh
        // GPU layout engine: when set, the compute kernel is the ONLY position writer —
        // applyPrebuiltBuffers stops adopting CPU arrays, and the persistent storage
        // attribute below is what the kernel fills (it closes over the attribute, so
        // identity is stable across flushes; growth replaces both). CPU consumers answer
        // position queries through the fold mirror (LayoutDescription.positionAt), never
        // through this buffer.
        this.gpuLayout = false;
        this._gpuPosAttr = null;

        this.instanceMesh = this._createInstanceMesh();
        this.scene.add(this.instanceMesh);
    }

    // ── Group DataTexture ─────────────────────────────────────────────────────

    /** @private */
    _initGroupDefaults() {
        for (let g = 0; g < this._maxGroups; g++) {
            const base = g * GROUP_COLS * 4;
            this._groupData[base + 4 + 3]  = 1.0; // col 1 w: quat.w (identity rotation)
            this._groupData[base + 8]      = 1.0; // col 2 r: color.r
            this._groupData[base + 8 + 1]  = 1.0; // col 2 g: color.g
            this._groupData[base + 8 + 2]  = 1.0; // col 2 b: color.b
            this._groupData[base + 8 + 3]  = 1.0; // col 2 a: color.a
            this._groupData[base + 12]     = 1.0; // col 3 x: scale.x
            this._groupData[base + 12 + 1] = 1.0; // col 3 y: scale.y
            this._groupData[base + 12 + 2] = 1.0; // col 3 z: scale.z
            // col 4 (clip) stays zero: clipEnabled 0 = no clip.
        }
    }

    /** @private */
    _createGroupTexture() {
        const tex = new THREE.DataTexture(
            this._groupData, GROUP_COLS, this._maxGroups,
            THREE.RGBAFormat, THREE.FloatType
        );
        tex.minFilter = THREE.NearestFilter;
        tex.magFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;
        return tex;
    }

    /** @private */
    _createFarGroupTexture() {
        const tex = new THREE.DataTexture(
            this._farGroupData, FAR_GROUP_COLS, this._maxGroups,
            THREE.RGBAFormat, THREE.FloatType
        );
        tex.minFilter = THREE.NearestFilter;
        tex.magFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;
        return tex;
    }

    /**
     * Arm a group's far slab — the fragment's far-UV lanes. u0/v0 are the slab's
     * NORMALIZED atlas origin; rowsPerTexel/colsPerTexel map the file's grid into
     * the 64×64 slab. These are the SAME values the far kernels scattered by (the
     * arena's arming pass writes both) — the mapping only has to be consistent.
     */
    setGroupFarSlab(groupId, u0, v0, rowsPerTexel, colsPerTexel) {
        const b = (groupId | 0) * FAR_GROUP_COLS * 4;
        const d = this._farGroupData;
        if (b < 0 || b + 7 >= d.length) return;
        d[b] = u0; d[b + 1] = v0; d[b + 2] = rowsPerTexel; d[b + 3] = colsPerTexel;
        d[b + 4] = 1;   // hasSlab
        if (this._farGroupTexture) this._farGroupTexture.needsUpdate = true;
    }

    /** Disarm a group's far slab (dispose / atlas release) → the impostor fallback. */
    clearGroupFarSlab(groupId) {
        const b = (groupId | 0) * FAR_GROUP_COLS * 4;
        if (b < 0 || b + 7 >= this._farGroupData.length) return;
        this._farGroupData.fill(0, b, b + FAR_GROUP_COLS * 4);
        if (this._farGroupTexture) this._farGroupTexture.needsUpdate = true;
    }

    /** Single-group fields: the whole field's far slab rides group 0 (the arena arms
     *  through this facade — MegaFieldView forwards to its own groupId instead). */
    setFarSlab(u0, v0, rowsPerTexel, colsPerTexel) {
        this.setGroupFarSlab(0, u0, v0, rowsPerTexel, colsPerTexel);
    }

    /** The single-group disarm (see setFarSlab). */
    clearFarSlab() {
        this.clearGroupFarSlab(0);
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
        // The shared material reads _highlightTexture per object — no node to poke.
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
        this._farGroupTexture = this._createFarGroupTexture();
        // Highlight storage: byte fields carry it as a per-instance RGBA8 attribute
        // (allocated below with the others — a capacity-sized texture blows
        // maxTextureDimension2D and re-uploads whole per write); classic fields keep
        // the small per-field DataTexture.
        if (!this._bytePipeline) this._ensureHighlightTexture(1);

        const maxCount = this.config.maxInstances;

        // Pre-allocate per-instance attributes. Byte-pipeline fields read position/size/
        // glyphId from the pipeline's slot buffer — only color/group/picking/highlight
        // are per-instance.
        if (this._bytePipeline) {
        geometry.setAttribute('instanceHighlight',
            new THREE.InstancedBufferAttribute(new Uint8Array(maxCount * 4), 4, true));
        } else {
        // instancePosition is stride-4 from BIRTH. The shader reads it as vec4, and every
        // commit path (the engine's StorageInstancedBufferAttribute AND the CPU path's padded
        // InstancedBufferAttribute) installs a stride-4 attribute — so the INITIAL attribute
        // must be stride-4 too. A stride-3 initial gets its vertex-input layout baked into the
        // render pipeline at the first frame an async-loaded grid spends in the scene BEFORE its
        // worker build resolves (agent book cards are addSheet'd before loadFile settles,
        // unlike regular grids which loadFile synchronously before seatFileRow). When the
        // engine then swaps in the stride-4 storage attribute, the stride-3 pipeline reads every
        // other instance's X from the wrong lane → glyphs splay horizontally. This is the
        // "buffer verifies correct, shader renders wrong" paradox: layout.verify reads the GPU
        // storage buffer (correct), but the vertex fetch runs through the stale stride-3 layout.
        // The storage-repack trap (a vec3 STORAGE attribute repacked by three) does not apply
        // here: this is a PLAIN InstancedBufferAttribute, which three never repacks.
        geometry.setAttribute('instancePosition',
            new THREE.InstancedBufferAttribute(new Float32Array(maxCount * 4), 4));
        geometry.setAttribute('instanceSize',
            new THREE.InstancedBufferAttribute(new Float32Array(maxCount * 2), 2));
        geometry.setAttribute('instanceGlyphId',
            new THREE.InstancedBufferAttribute(new Float32Array(maxCount), 1));
        }
        // instanceColor is stride-4 AND a StorageInstancedBufferAttribute from BIRTH,
        // for every kind: the shared material declares it vec4 (the vertex-fetch stride
        // is baked into the pipeline — a stride-3 attribute would splay colors exactly
        // like the stride-3 instancePosition paradox above), and the STORAGE class is
        // what lets the far-scatter kernel read the same buffer as a storage view
        // (createStorageAttribute binds STORAGE|VERTEX — see FarTextAtlas/far kernels).
        geometry.setAttribute('instanceColor',
            new StorageInstancedBufferAttribute(new Float32Array(maxCount * 4), 4));
        geometry.setAttribute('instanceGroupId',
            new THREE.InstancedBufferAttribute(new Float32Array(maxCount), 1));
        // instancePickingId — written by PickingSystem.register() after flush
        geometry.setAttribute('instancePickingId',
            new THREE.InstancedBufferAttribute(new Float32Array(maxCount), 1));

        geometry._maxInstanceCount = maxCount;
        geometry.instanceCount = 0;

        // ── Material: the SHARED field material (one TSL build for all fields). All
        // per-field shader state lives on `this` and resolves per object at draw via
        // mesh.userData.glyphField (see _getSharedFieldMaterial above).
        this._ensureSlugTextures();
        // (Emoji texture + dims resolve through the class GETTERS — nothing to wire here.)

        const material = _getSharedFieldMaterial(this._occluder ? 'occluder' : this._bytePipeline ? 'byteGlyph' : 'glyph');
        this._material = material;

        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.glyphField = this;   // the shared material's per-object state hook
        // Glyphs are placed by in-shader instance attributes (instancePosition) that three can't
        // see, so the unit-quad geometry's auto-bounds are meaningless and three would mis-cull.
        // We instead write the REAL instance extent into geometry.boundingBox/Sphere on every
        // position change (setLayoutExtent), so three's built-in per-object frustum cull
        // works: off-screen grids skip their draw for free, every render — no virtualizer needed.
        // That extent still covers instance positions ONLY — a field whose glyphs ride group
        // offsets (GPU texture state) has a false sphere and constructs with frustumCulled: false.
        mesh.frustumCulled = this._frustumCulled;
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
        // The shared material reads _curveTexture/_glyphMapTexture/_glyphMapWidth
        // per object — resolving them here is the whole hot-swap.
        this._ensureSlugTextures();
    }

    /**
     * Flag the emoji texture for re-upload after new cells were drawn (the miss
     * flow's _refreshEmojiTextures calls this per registered field). The texture
     * OBJECT and the grid dims are no longer state this class holds — they're
     * getters that delegate to the live atlas per draw — so a square-growth
     * re-creation (dispose+null in EmojiAtlas._grow) can never strand this field
     * on a disposed texture, and cols/rows never go stale between refreshes.
     */
    get _emojiTexture() { return this.atlas?._emojiAtlas?.getTexture?.(THREE) ?? null; }
    get _emojiCols()    { return this.atlas?._emojiAtlas?.cols ?? 16; }
    get _emojiRows()    { return this.atlas?._emojiAtlas?.rows ?? 16; }

    setEmojiTexture() {
        const tex = this.atlas?._emojiAtlas?.getTexture?.(THREE);
        if (tex) tex.needsUpdate = true;
    }

    /**
     * Put the field into frame mode: render every instance as a cell of an external
     * NxM grid texture (screen capture / video / image) instead of a glyph. The
     * per-instance cell index is the existing instanceGlyphId (0 = top-left, row
     * major). Pass a null texture to return the field to normal glyph rendering.
     *
     * @param {THREE.Texture|null} tex - filterable RGBA texture (VideoTexture/CanvasTexture/DataTexture)
     * @param {number} cols - number of cells across the source frame
     * @param {number} rows - number of cells down the source frame
     */
    setFrameTexture(tex, cols, rows) {
        this._frameTexture = tex || null;
        this._frameCols    = Math.max(1, Math.floor(cols) || 1);
        this._frameRows    = Math.max(1, Math.floor(rows) || 1);
        this._renderMode   = tex ? RENDER_MODE.FRAME : RENDER_MODE.GLYPH;
    }

    /**
     * Set the whole-field clip window in GRID-LOCAL y (Step 3c.2) — writes group 0's
     * clip lanes (the group every glyph of a single-group field belongs to). Fields
     * that scatter glyphs across groups clip per group via setGroupClipY directly.
     * Pass null/non-finite (either arg) to disable. Pure texel update — no re-fold.
     * @param {number|null} top
     * @param {number|null} bottom
     */
    setClipYRange(top, bottom) {
        this.setGroupClipY(0, top, bottom);
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
     * Render multiple items in one GPU rebuild. Two item forms:
     *   { text, position, options }                — shaped text (the usual form)
     *   { quad: {w, h, fill?}, position, options } — ONE explicit-size cell carrying a
     *     blank glyph (no ink). With `fill` ({color:{r,g,b}, opacity}) the cell renders
     *     as a solid rectangle via the highlight FILL path — and being an ordinary
     *     instance in its group, it rides the group offset/scale/alpha like any glyph:
     *     the primitive for label backplates, badges, swatches. The cell anchors like
     *     every glyph cell: left edge at position.x, vertically centered on position.y.
     * @param {Array<{text?:string, quad?:{w:number, h:number, fill?:{color:{r:number,g:number,b:number}, opacity:number}}, position?:{x:number,y:number,z:number}, options?:Object}>} items
     * @returns {number[]} textIds
     */
    renderBatch(items) {
        const ids = [];
        const fills = [];
        for (const item of items) {
            const options = item.options || {};
            const position = item.position || { x: 0, y: 0, z: 0 };
            let glyphs;
            if (item.quad) {
                glyphs = [{
                    position,
                    size: { width: item.quad.w, height: item.quad.h },
                    charCode: this._blankGlyphId(),
                    color: options.color || this.config.defaultColor,
                    groupId: options.groupId || 0,
                }];
            } else {
                glyphs = this._textToGlyphs(item.text, position, options);
            }
            const id = this._registerText(item.text ?? '', glyphs, options);
            ids.push(id);
            if (item.quad?.fill) fills.push({ id, fill: item.quad.fill });
        }
        this._rebuildAllInstances();
        // Fill texels address ABSOLUTE buffer slots — which the rebuild just assigned.
        for (const { id, fill } of fills) {
            const entry = this.renderedTexts.get(id);
            if (entry?.bufferStartIndex !== undefined) {
                this.setGlyphHighlight(entry.bufferStartIndex, fill.color, fill.opacity);
            }
        }
        return ids;
    }

    /** @private The glyph id that draws NO ink — the shaped space (empty outline) — for
     *  quad cells whose whole point is the fill. Id 0 (.notdef) often draws a box
     *  outline, so it is only the shaper-less fallback (mock/test fields). */
    _blankGlyphId() {
        if (this._blankGid === undefined) {
            let gid = 0;
            if (this._shaper) {
                const shaped = this._shaper.shape(' ');
                if (shaped && shaped.length) gid = shaped[0].g;
            }
            this._blankGid = gid;
        }
        return this._blankGid;
    }

    /**
     * Update all glyph positions for a text entry (direct buffer write).
     * @param {number} id
     * @param {{x,y,z}} newPosition
     */
    updatePosition(id, newPosition) {
        const entry = this.renderedTexts.get(id);
        if (!entry || entry.bufferStartIndex === undefined) return;
        if (this.gpuLayout) {
            // No CPU position array exists to translate. Under the engine, an entry moves by
            // re-dispatching with a new origin (a fold param) — a caller that needs this owns
            // the tables and should re-sync. No live caller hits this (ConnectionRenderer
            // fields never run the engine); the warn is a tripwire, not a path.
            console.warn('GlyphField.updatePosition: field is GPU-layout-owned; re-dispatch with a new origin instead');
            return;
        }
        const geom = this.instanceMesh.geometry;
        const attr = geom.attributes.instancePosition;
        const arr  = attr.array;
        const pStride = attr.itemSize;   // stride-4 on every live path; read it, never assume
        const base = entry.bufferStartIndex;
        const dx = newPosition.x - arr[base * pStride];
        const dy = newPosition.y - arr[base * pStride + 1];
        const dz = newPosition.z - arr[base * pStride + 2];
        for (let i = 0; i < entry.glyphCount; i++) {
            const b = (base + i) * pStride;
            arr[b] += dx; arr[b + 1] += dy; arr[b + 2] += dz;  // .w padding lane (stride-4) left alone
        }
        attr.addUpdateRange(base * pStride, entry.glyphCount * pStride);
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
            const b = (base + i) * 4;
            arr[b] = newColor.r; arr[b + 1] = newColor.g; arr[b + 2] = newColor.b;
        }
        const attr = geom.attributes.instanceColor;
        attr.addUpdateRange(base * 4, entry.glyphCount * 4);
        attr.needsUpdate = true;
    }

    /**
     * Copy the PAINT lanes (instanceColor + instanceHighlight) from one slot range to
     * another — the LANE CARRY. When a view's range moves (a restage swap today; the
     * compaction mover tomorrow), the colorizer's and highlight state's finished work
     * lives only in these arrays at the old offsets — carrying them keeps color
     * continuous by construction instead of flashing default until a re-parse
     * repaints. Group/picking lanes are NOT copied: group is the view's identity
     * (set by the attach), picking is identity-at-capacity.
     * @param {number} srcSlot @param {number} dstSlot @param {number} count
     */
    copyGlyphLanes(srcSlot, dstSlot, count) {
        if (!(count > 0) || srcSlot === dstSlot) return;
        const geom = this.instanceMesh?.geometry;
        const color = geom?.attributes?.instanceColor;
        const highlight = geom?.attributes?.instanceHighlight;
        if (color) {
            color.array.copyWithin(dstSlot * 4, srcSlot * 4, (srcSlot + count) * 4);
            color.addUpdateRange(dstSlot * 4, count * 4);
            color.needsUpdate = true;
        }
        if (highlight) {
            highlight.array.copyWithin(dstSlot * 4, srcSlot * 4, (srcSlot + count) * 4);
            highlight.addUpdateRange(dstSlot * 4, count * 4);
            highlight.needsUpdate = true;
        }
    }

    /**
     * Set a per-glyph highlight by absolute buffer slot. The highlight texel's RGB is the
     * highlight color; its ALPHA byte selects the MODE the shader applies:
     *   fillOpacity 0  → TINT  (additive: the glyph ink brightened by `color`) — default/legacy.
     *   fillOpacity >0 → FILL  (a background bar: the cell rect fills with `color` at this
     *                    opacity, the glyph ink composites on top). Adjacent FILL cells tile
     *                    into a seamless bar (the quad spans the full advance cell).
     * Rides the existing RGBA8 highlight texture (the alpha byte was previously unused) — no new
     * per-glyph data.
     * @param {number} absoluteSlot
     * @param {{r,g,b}|null} color - null clears
     * @param {number} [fillOpacity=0] - 0 = additive tint; >0 = background-fill opacity (0–1)
     */
    setGlyphHighlight(absoluteSlot, color, fillOpacity = 0) {
        if (this._bytePipeline) {
            // Byte kind: the highlight rides the instanceHighlight attribute —
            // a 4-byte update range, not a whole-texture re-upload.
            const attr = this.instanceMesh?.geometry?.attributes?.instanceHighlight;
            if (!attr) return;
            const i = absoluteSlot * 4;
            if (i < 0 || i + 3 >= attr.array.length) return;
            attr.array[i]     = color ? ((color.r * 255 + 0.5) | 0) : 0;
            attr.array[i + 1] = color ? ((color.g * 255 + 0.5) | 0) : 0;
            attr.array[i + 2] = color ? ((color.b * 255 + 0.5) | 0) : 0;
            attr.array[i + 3] = color ? GlyphField.encodeHighlightAlpha(fillOpacity) : 0;
            attr.addUpdateRange(i, 4);
            attr.needsUpdate = true;
            return;
        }
        if (!this._highlightTexture) {
            // Silent no-op was a debugging black hole (highlights "applied" but invisible). Announce
            // it once per renderer: a highlight was requested before the highlight texture existed.
            if (!this._warnedNoHighlightTex) {
                this._warnedNoHighlightTex = true;
                console.warn('[GlyphField] setGlyphHighlight no-op — highlight texture not allocated (build buffers / _ensureHighlightTexture before highlighting)');
            }
            return;
        }
        const data = this._highlightTexture.image.data;
        const i = absoluteSlot * 4;
        data[i]     = color ? ((color.r * 255 + 0.5) | 0) : 0;
        data[i + 1] = color ? ((color.g * 255 + 0.5) | 0) : 0;
        data[i + 2] = color ? ((color.b * 255 + 0.5) | 0) : 0;
        data[i + 3] = color ? GlyphField.encodeHighlightAlpha(fillOpacity) : 0;
        this._highlightTexture.needsUpdate = true;
    }

    /**
     * Encode a fill opacity into the highlight texel's ALPHA byte — the ONE place the mode/opacity
     * encoding lives (shared by setGlyphHighlight and the bulk highlightBuffer writers, so they
     * can't drift). 0 keeps the legacy additive tint; a fill clamps to [1,255] so a tiny opacity
     * still reads as FILL (never silently degrades to tint at the 0 boundary).
     * @param {number} fillOpacity 0 = tint; >0 = fill opacity (0–1)
     * @returns {number} 0–255
     */
    static encodeHighlightAlpha(fillOpacity) {
        return fillOpacity > 0 ? Math.min(255, Math.max(1, (fillOpacity * 255 + 0.5) | 0)) : 0;
    }

    /**
     * Bulk per-glyph highlight access for high-frequency writers (TerminalGrid's per-cell ANSI bg
     * projection). Ensures the highlight texture covers `count` slots and returns its raw RGBA8
     * data array for DIRECT writes (4 bytes/slot: R, G, B, then the encodeHighlightAlpha byte) — the
     * caller piggybacks the writes onto its existing projection loop and calls markHighlightDirty()
     * ONCE, instead of N setGlyphHighlight calls (N redundant needsUpdate flips + guard checks).
     * @param {number} count number of glyph slots that must be addressable
     * @returns {Uint8Array|Uint8ClampedArray|null} the texel data, or null if not allocatable
     */
    highlightBuffer(count) {
        if (this._bytePipeline) {
            // Byte kind: the raw instanceHighlight attribute bytes — same 4-byte/slot
            // RGBA layout the texture path uses. Capacity-sized at construction.
            const attr = this.instanceMesh?.geometry?.attributes?.instanceHighlight;
            return attr && attr.array.length >= count * 4 ? attr.array : null;
        }
        this._ensureHighlightTexture(count);
        return this._highlightTexture ? this._highlightTexture.image.data : null;
    }

    /** Flag the highlight storage for GPU re-upload after a batch of highlightBuffer() writes.
     *  NOTE (byte kind): a range-less flag re-uploads the WHOLE capacity-sized attribute —
     *  bulk byte-kind writers should addUpdateRange on the attribute instead. */
    markHighlightDirty() {
        if (this._bytePipeline) {
            const attr = this.instanceMesh?.geometry?.attributes?.instanceHighlight;
            if (attr) attr.needsUpdate = true;
            return;
        }
        if (this._highlightTexture) this._highlightTexture.needsUpdate = true;
    }

    /**
     * Set a glyph's BASE color by absolute buffer slot — overwrites the
     * instanceColor the builder wrote. Unlike setGlyphHighlight (additive, its own
     * texture), this reuses the existing per-glyph instanceColor attribute, so it
     * costs no extra GPU memory. Group color + highlight still layer on top in the
     * shader. Syntax coloring drives this. A relayout rebuilds instanceColor to the
     * defaults, so the caller re-applies after each layout (as highlights do).
     * @param {number} absoluteSlot
     * @param {{r:number,g:number,b:number}} color
     */
    setGlyphColor(absoluteSlot, color) {
        const attr = this.instanceMesh?.geometry?.attributes?.instanceColor;
        if (!attr) return;
        const b = absoluteSlot * 4;
        if (b < 0 || b + 2 >= attr.array.length) return;
        attr.array[b] = color.r; attr.array[b + 1] = color.g; attr.array[b + 2] = color.b;
        attr.addUpdateRange(b, 4);
        attr.needsUpdate = true;
    }

    /**
     * Bulk base-color write: `count` consecutive glyphs from `startSlot`, in one
     * update range. A tree-sitter capture maps to exactly one such contiguous span
     * (the builder slots glyphs in source order, newlines excluded), so syntax
     * coloring is one call per capture rather than one per glyph.
     * @param {number} startSlot
     * @param {number} count
     * @param {{r:number,g:number,b:number}} color
     */
    setGlyphColorRange(startSlot, count, color) {
        const attr = this.instanceMesh?.geometry?.attributes?.instanceColor;
        if (!attr || count <= 0) return;
        const arr = attr.array;
        const start = Math.max(0, startSlot | 0);
        const end = Math.min((arr.length / 4) | 0, start + count);
        for (let s = start; s < end; s++) {
            const b = s * 4;
            arr[b] = color.r; arr[b + 1] = color.g; arr[b + 2] = color.b;
        }
        if (end > start) {
            attr.addUpdateRange(start * 4, (end - start) * 4);
            attr.needsUpdate = true;
        }
    }

    /**
     * Palette write — the colorizer's ONE color pass per file: paint `count`
     * glyphs from `startSlot` by looking per-byte palette indices up in a flat
     * [(N+1)×3] LUT (syntaxPaletteJob.paletteLUT). Replaces the base coat + a
     * setGlyphColorRange per capture-row with a single loop + one update range.
     * @param {number} startSlot     absolute slot the palette byte at `paletteOffset` colors
     * @param {Uint8Array} palette   per-byte palette indices (0 = foreground)
     * @param {number} paletteOffset first palette byte to read
     * @param {number} count
     * @param {Float32Array} lut
     */
    setGlyphPaletteRange(startSlot, palette, paletteOffset, count, lut) {
        const attr = this.instanceMesh?.geometry?.attributes?.instanceColor;
        if (!attr || count <= 0) return;
        const arr = attr.array;
        let start = startSlot | 0;
        let off = paletteOffset | 0;
        if (start < 0) { off -= start; count += start; start = 0; }
        const n = Math.min(count, palette.length - off);
        const end = Math.min((arr.length / 4) | 0, start + n);
        for (let s = start, o = off; s < end; s++, o++) {
            const p = palette[o] * 3;
            const b = s * 4;
            arr[b] = lut[p]; arr[b + 1] = lut[p + 1]; arr[b + 2] = lut[p + 2];
        }
        if (end > start) {
            attr.addUpdateRange(start * 4, (end - start) * 4);
            attr.needsUpdate = true;
        }
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
        const base = (groupId * GROUP_COLS + 0) * 4;
        this._groupData[base]     = offset.x;
        this._groupData[base + 1] = offset.y;
        this._groupData[base + 2] = offset.z;
        this._syncGroupTexture();
    }

    getGroupOffset(groupId) {
        if (groupId < 0 || groupId >= this._maxGroups) return { x: 0, y: 0, z: 0 };
        const base = (groupId * GROUP_COLS + 0) * 4;
        return { x: this._groupData[base], y: this._groupData[base + 1], z: this._groupData[base + 2] };
    }

    /**
     * Set a group's rotation quaternion (col 1). The shared vertex transform applies it
     * between the group scale and the group offset — a group texel is a full TRS pose,
     * so a set of glyphs can face any way without carrying its own mesh (the mega-field's
     * per-view rotation; a billboarding label's turn). Identity (0,0,0,1) = no rotation.
     * @param {number} groupId
     * @param {{x:number,y:number,z:number,w:number}} q - unit quaternion
     */
    setGroupQuaternion(groupId, q) {
        if (groupId < 0 || groupId >= this._maxGroups) return;
        const base = (groupId * GROUP_COLS + 1) * 4;
        this._groupData[base]     = q.x;
        this._groupData[base + 1] = q.y;
        this._groupData[base + 2] = q.z;
        this._groupData[base + 3] = q.w;
        this._syncGroupTexture();
    }

    getGroupQuaternion(groupId) {
        if (groupId < 0 || groupId >= this._maxGroups) return { x: 0, y: 0, z: 0, w: 1 };
        const base = (groupId * GROUP_COLS + 1) * 4;
        return { x: this._groupData[base], y: this._groupData[base + 1], z: this._groupData[base + 2], w: this._groupData[base + 3] };
    }

    /**
     * Set a group's clip window (col 4) in GRID-LOCAL y — the pre-transform frame the
     * layout laid the glyphs in. Instances whose anchor y is outside [bottom, top] are
     * culled in the vertex stage. Pass null/non-finite (either bound) to disable.
     * Per-group so independent views/windows clip independently in one shared field.
     * @param {number} groupId
     * @param {number|null} top
     * @param {number|null} bottom
     */
    setGroupClipY(groupId, top, bottom) {
        if (groupId < 0 || groupId >= this._maxGroups) return;
        const base = (groupId * GROUP_COLS + 4) * 4;
        const on = Number.isFinite(top) && Number.isFinite(bottom);
        this._groupData[base]     = on ? top : 0;
        this._groupData[base + 1] = on ? bottom : 0;
        this._groupData[base + 2] = on ? 1 : 0;
        this._syncGroupTexture();
    }

    /**
     * Assign a contiguous range of glyph slots to a transform group (instanceGroupId).
     * The group's offset / visibility (setGroupOffset / setGroupVisibility) then apply to
     * exactly those glyphs — the primitive behind structural sub-layouts: move or hide a
     * whole swathe of text by AST range. The shader ADDS the group offset on top of the
     * base flow position, so this composes with the layout and survives relayout.
     * @param {number} startSlot inclusive buffer slot
     * @param {number} count number of consecutive slots
     * @param {number} groupId target group (createGroup() / 0 = identity)
     */
    setGlyphGroupRange(startSlot, count, groupId) {
        const attr = this.instanceMesh?.geometry?.attributes?.instanceGroupId;
        if (!attr || count <= 0) return;
        const arr = attr.array;
        const start = Math.max(0, startSlot | 0);
        const end = Math.min(arr.length, start + count);
        for (let s = start; s < end; s++) arr[s] = groupId;
        if (end > start) {
            attr.addUpdateRange(start, end - start);
            attr.needsUpdate = true;
        }
    }

    setGroupColor(groupId, color) {
        if (groupId < 0 || groupId >= this._maxGroups) return;
        const base = (groupId * GROUP_COLS + 2) * 4;
        this._groupData[base]     = color.r;
        this._groupData[base + 1] = color.g;
        this._groupData[base + 2] = color.b;
        this._groupData[base + 3] = color.a !== undefined ? color.a : 1.0;
        this._syncGroupTexture();
    }

    getGroupColor(groupId) {
        if (groupId < 0 || groupId >= this._maxGroups) return { r: 1, g: 1, b: 1, a: 1 };
        const base = (groupId * GROUP_COLS + 2) * 4;
        return { r: this._groupData[base], g: this._groupData[base + 1], b: this._groupData[base + 2], a: this._groupData[base + 3] };
    }

    setGroupVisibility(groupId, visible) {
        if (groupId < 0 || groupId >= this._maxGroups) return;
        const base = (groupId * GROUP_COLS + 2) * 4;
        this._groupData[base + 3] = visible ? 1.0 : 0.0;
        this._syncGroupTexture();
    }

    /**
     * Fractional group fade — same DataTexture slot as setGroupVisibility, but any
     * 0..1 value. The shader multiplies glyph coverage by this (vGroupAlpha), so a
     * grid can fade its text in lockstep with its background panel (a translucent
     * tile reads as one coherent sheet rather than opaque text over glass). 0 still
     * trips the fragment discard.
     * @param {number} groupId
     * @param {number} alpha 0..1
     */
    setGroupAlpha(groupId, alpha) {
        if (groupId < 0 || groupId >= this._maxGroups) return;
        const base = (groupId * GROUP_COLS + 2) * 4;
        this._groupData[base + 3] = alpha;
        this._syncGroupTexture();
    }

    setGroupScale(groupId, scale) {
        if (groupId < 0 || groupId >= this._maxGroups) return;
        const base = (groupId * GROUP_COLS + 3) * 4;
        this._groupData[base]     = scale.x;
        this._groupData[base + 1] = scale.y;
        this._groupData[base + 2] = scale.z;
        this._syncGroupTexture();
    }

    getGroupScale(groupId) {
        if (groupId < 0 || groupId >= this._maxGroups) return { x: 1, y: 1, z: 1 };
        const base = (groupId * GROUP_COLS + 3) * 4;
        return { x: this._groupData[base], y: this._groupData[base + 1], z: this._groupData[base + 2] };
    }

    setGroupColorBlend(groupId, blend) {
        if (groupId < 0 || groupId >= this._maxGroups) return;
        const base = (groupId * GROUP_COLS + 3) * 4;
        this._groupData[base + 3] = blend;
        this._syncGroupTexture();
    }

    /** @private — mark group DataTexture dirty (the shared material reads it per object) */
    _syncGroupTexture() {
        this._groupTexture.needsUpdate = true;
    }

    /** @private */
    _growGroupTexture() {
        const oldMax = this._maxGroups;
        if (oldMax >= MAX_GROUPS_DIM) return;
        this._maxGroups = Math.min(oldMax * 2, MAX_GROUPS_DIM);
        const newData = new Float32Array(this._maxGroups * GROUP_COLS * 4);
        newData.set(this._groupData);
        this._groupData = newData;
        for (let g = oldMax; g < this._maxGroups; g++) {
            const base = g * GROUP_COLS * 4;
            this._groupData[base + 4 + 3]  = 1.0; // quat.w (identity)
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
        // The far group carrier grows in lockstep (same row space).
        const newFar = new Float32Array(this._maxGroups * FAR_GROUP_COLS * 4);
        newFar.set(this._farGroupData);
        this._farGroupData = newFar;
        if (this._farGroupTexture) this._farGroupTexture.dispose();
        this._farGroupTexture = this._createFarGroupTexture();
        // The shared material reads _groupTexture/_maxGroups per object — nothing to poke.
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

    /**
     * Total glyph count. O(1) — cached counter maintained by every
     * add/remove/clear/applyPrebuiltBuffers path.
     * @returns {number}
     */
    getGlyphCount() {
        return this._cachedGlyphCount;
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
        if (this.instanceMesh) { this.instanceMesh.geometry.instanceCount = 0; this.setLayoutExtent(null); }
    }

    dispose() {
        if (this.atlas && this.atlas._live && typeof this.atlas._live.unregisterField === 'function') {
            this.atlas._live.unregisterField(this);
        }
        if (this.instanceMesh) {
            this.scene.remove(this.instanceMesh);
            this.instanceMesh.geometry.dispose();
            // material is the SHARED field material — never disposed per field.
        }
        if (this._groupTexture)    this._groupTexture.dispose();
        if (this._farGroupTexture) this._farGroupTexture.dispose();
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
        const posAttr = geom.attributes.instancePosition;
        const oldPos = posAttr.array;
        const pStride = posAttr.itemSize;   // 4 for stride-4; never assume 3
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
                oldPos.copyWithin(w * pStride, r * pStride, (r + n) * pStride);
                oldSiz.copyWithin(w * 2, r * 2, (r + n) * 2);
                oldGid.copyWithin(w,     r,     r + n);
                oldCol.copyWithin(w * 4, r * 4, (r + n) * 4);
                oldGrp.copyWithin(w,     r,     r + n);
            }
            w += n;
        }

        for (const name of Object.keys(geom.attributes)) {
            // Engine-owned positions are GPU-written; flagging the storage attribute
            // would schedule an upload of its zeroed CPU array over the kernel's work.
            if (name === 'instancePosition' && this.gpuLayout) continue;
            geom.attributes[name].needsUpdate = true;
        }
        this._ensureHighlightTexture(total);
        geom.instanceCount = total;
    }

    /** @private */
    _writeGlyphsToGeometry(glyphs) {
        const count = Math.min(glyphs.length, this.config.maxInstances);
        const geom  = this.instanceMesh.geometry;
        const posAttr = geom.attributes.instancePosition;
        const pos   = posAttr.array;
        const pStride = posAttr.itemSize;   // 4 for stride-4 (engine + CPU-padded); never assume 3
        const siz   = geom.attributes.instanceSize.array;
        const gids  = geom.attributes.instanceGlyphId.array;
        const col   = geom.attributes.instanceColor.array;
        const grp   = geom.attributes.instanceGroupId.array;

        for (let i = 0; i < count; i++) {
            const g = glyphs[i];
            pos[i * pStride]     = g.position.x;
            pos[i * pStride + 1] = g.position.y;
            pos[i * pStride + 2] = g.position.z;
            siz[i * 2]     = g.size.width;
            siz[i * 2 + 1] = g.size.height;
            gids[i]        = g.charCode || 0;
            col[i * 4]     = g.color.r;
            col[i * 4 + 1] = g.color.g;
            col[i * 4 + 2] = g.color.b;
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
     * Attach a byte-in pipeline (compute/GlyphPipelineKernels.js) as this field's layout
     * engine: positions/sizes/glyphIds are read by the vertex transform straight from the
     * pipeline's slot buffer (see _fieldSlots), one slot per instance, slot index ==
     * arena byte offset. Sets the instance count and sizes the highlight texture; the
     * per-byte color/group lanes are the CALLER's (the mega-field fills each view's
     * range with that view's color — see MegaGlyphField._attachView). Only for
     * bytePipeline-constructed fields.
     * @param {import('./compute/GlyphPipelineKernels.js').default} pipeline
     * @param {number} byteLength - the live byte count (instance count)
     */
    attachBytePipeline(pipeline, byteLength, slotBase = 0) {
        if (!this._bytePipeline) throw new Error('attachBytePipeline on a non-bytePipeline field');
        if (slotBase !== 0) {
            // Fail loud at the seam: this field reads slots at instanceIndex — an
            // arena item at a nonzero byteStart needs a MegaGlyphField VIEW, or its
            // glyphs would silently render some other file's bytes.
            throw new Error(`GlyphField.attachBytePipeline: nonzero slotBase (${slotBase}) — stage through a MegaGlyphField view`);
        }
        this._byteSlots = pipeline.slots.value;
        // Re-point the shared slots nodes (render + pick) and wake their bind groups —
        // after an arena realloc the old buffer is destroyed, and without this every
        // frame's submit would reference it (see rebindByteSlots in core/glyphVertex).
        rebindByteSlots(this._byteSlots);
        const geom = this.instanceMesh.geometry;
        // Highlight is the capacity-sized instanceHighlight attribute — nothing to grow here.
        geom.instanceCount = Math.min(byteLength, this.config.maxInstances);
    }

    /**
     * State this field's content extent — the box three's per-object frustum cull tests
     * (`mesh.frustumCulled = true`). Our glyphs are placed by in-shader instance attributes
     * three cannot see, so the unit-quad geometry's auto-bounds are meaningless and the
     * extent has to come from whoever owns the layout.
     *
     * STATED, NEVER MEASURED. Every field that is culled knows its own extent in closed form:
     * a CodeGrid's is the fold's extent (core/foldGeometry.foldExtent, from the layout scan's
     * scalars), a TerminalGrid's and a FrameGrid's are their cell dimensions. So there is no
     * walk here and nothing to keep in sync — a caller that changes the layout states the new
     * box in the same breath. Fields whose glyphs ride group offsets (dynamic GPU texture
     * state no CPU box can describe) construct with `frustumCulled: false` instead and never
     * call this.
     *
     * @param {?{min:{x:number,y:number,z:number}, max:{x:number,y:number,z:number}}} extent
     *   local-space content box, or null for "no content" (nothing to cull against).
     */
    setLayoutExtent(extent) {
        const geom = this.instanceMesh?.geometry;
        if (!geom) return;
        const sphere = (this._boundsSphere ||= new THREE.Sphere());
        if (!extent?.min || !extent?.max || !(geom.instanceCount > 0)) {
            geom.boundingBox = null;
            sphere.center.set(0, 0, 0);
            sphere.radius = 0;
            geom.boundingSphere = sphere;
            return;
        }
        const box = (this._boundsBox ||= new THREE.Box3());
        box.min.set(extent.min.x, extent.min.y, extent.min.z);
        box.max.set(extent.max.x, extent.max.y, extent.max.z);
        geom.boundingBox = box;
        box.getBoundingSphere(sphere);
        geom.boundingSphere = sphere;
    }

    /**
     * Apply worker-prebuilt buffers.
     */
    applyPrebuiltBuffers(buffers, items) {
        const { positions, sizes, colors, groupIds, count } = buffers;
        const glyphIds = buffers.glyphIds || buffers.codepoints;
        let { itemMeta } = buffers;
        const geom = this.instanceMesh.geometry;

        if (this.gpuLayout) {
            // ENGINE-OWNED positions: buffers.positions is ignored, never uploaded — the
            // layout kernel writes this attribute GPU-side (syncGpuLayout, right after this
            // commit). Use StorageInstancedBufferAttribute with itemSize=4 (stride-4).
            let attr = this._gpuPosAttr;
            if (!attr || attr.count < count) {
                attr = new StorageInstancedBufferAttribute(new Float32Array(count * 4), 4);
                this._gpuPosAttr = attr;
            }
            geom.setAttribute('instancePosition', attr);
        } else {
            // CPU path (terminals, annotations): adopt the builder's array under a PLAIN
            // attribute with itemSize=4 to match the shader's vec4 read. Pad with zeros.
            this._gpuPosAttr = null;
            const cpuPos = new Float32Array(count * 4);
            for (let i = 0; i < count; i++) {
                cpuPos[i * 4 + 0] = positions[i * 3 + 0];
                cpuPos[i * 4 + 1] = positions[i * 3 + 1];
                cpuPos[i * 4 + 2] = positions[i * 3 + 2];
                cpuPos[i * 4 + 3] = 0; // padding
            }
            geom.setAttribute('instancePosition', new THREE.InstancedBufferAttribute(cpuPos, 4));
        }
        geom.setAttribute('instanceSize',     new THREE.InstancedBufferAttribute(sizes, 2));
        geom.setAttribute('instanceGlyphId',  new THREE.InstancedBufferAttribute(glyphIds || new Float32Array(count), 1));
        // Colors ship stride-3 from the worker; the shared material declares vec4
        // (the far kernel's storage view needs the stride-4 storage class on the byte
        // field) — pad to stride-4 here, same discipline as cpuPos above.
        const col4 = new Float32Array(count * 4);
        for (let i = 0; i < count; i++) {
            col4[i * 4 + 0] = colors[i * 3 + 0];
            col4[i * 4 + 1] = colors[i * 3 + 1];
            col4[i * 4 + 2] = colors[i * 3 + 2];
        }
        geom.setAttribute('instanceColor',    new THREE.InstancedBufferAttribute(col4, 4));
        geom.setAttribute('instanceGroupId',  new THREE.InstancedBufferAttribute(groupIds || new Float32Array(count), 1));
        if (!geom.attributes.instancePickingId || geom.attributes.instancePickingId.array.length < count) {
            geom.setAttribute('instancePickingId', new THREE.InstancedBufferAttribute(new Float32Array(count), 1));
        }

        this._ensureHighlightTexture(count);
        geom.instanceCount = count;
        this.config.maxInstances = Math.max(this.config.maxInstances, count);
        // The extent is STATED by the layout owner right after this commit (CodeGrid from the
        // fold's extent, TerminalGrid/FrameGrid from their cell dimensions) — see setLayoutExtent.

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
                    // The line table the LayoutDescription and the kernel both read. The
                    // dispatch adds `fold` (the layout scan's scalars) and `extent` (the
                    // fold's box) to this entry right after — see GlyphLayoutCompute.
                    lineSlotOffsets:   meta.lineSlotOffsets || null,
                });
                this._cachedGlyphCount += meta.glyphCount;
                rendererIds.push(id);
            }
        }
        return rendererIds;
    }

    /**
     * The raw per-glyph position array as bound to the instanced geometry — stride is
     * attr.itemSize (stride-4 on every live path), NOT packed xyz. For CPU-buffered
     * fields only (terminals, frames, labels): engine-owned fields have no CPU position
     * array, so this returns null — position queries there go through the fold mirror
     * (LayoutDescription).
     * @returns {Float32Array|null}
     */
    getInstancePositions() {
        if (this.gpuLayout) return null;
        return this.instanceMesh?.geometry?.attributes?.instancePosition?.array ?? null;
    }

    /**
     * Choose the position engine for subsequent commits. true = the compute kernel is the
     * only writer (applyPrebuiltBuffers stops adopting CPU arrays) — every CodeGrid field;
     * false = CPU-buffered placement (terminals, frames, labels), which never flips on.
     * @param {boolean} on
     */
    setGpuLayout(on) {
        const next = !!on;
        if (next === this.gpuLayout) return;
        this.gpuLayout = next;
        if (!next) {
            this._gpuPosAttr = null;
            // The adapter parks its kernel on the field; releasing here keeps the pair's
            // lifecycles joined without a core→adapter import.
            this._gpuKernel?.dispose?.();
            this._gpuKernel = null;
        }
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

    /**
     * Flag the position + size instance attributes for GPU re-upload after an external
     * in-place write to the live arrays (getInstancePositions/getInstanceSizes) — e.g. an
     * arranger zeroing size heights to hide glyphs. Positions are skipped on engine
     * fields (GPU-owned); sizes remain CPU-owned either way.
     */
    markInstanceTransformsDirty() {
        const geom = this.instanceMesh?.geometry;
        if (!geom) return;
        // Engine fields: the position attribute is GPU-written; uploading its CPU-side
        // array (zeros) would erase the kernel's work. Sizes remain CPU-owned either way.
        if (!this.gpuLayout && geom.attributes.instancePosition) geom.attributes.instancePosition.needsUpdate = true;
        if (geom.attributes.instanceSize) geom.attributes.instanceSize.needsUpdate = true;
    }
}

/**
 * glyphVertex — the SHARED instance-glyph → clip-position transform.
 *
 * Both the main render material (GlyphField) and the GPU picking material
 * (PickingSystem) consume buildGlyphVertexTransform, so the glyph's world
 * position is computed by ONE TSL graph. Render and pick physically cannot
 * drift apart — which is the prerequisite for pickable, scaling tab/label
 * surfaces: a non-unit group scale previously left the pick quad at a different
 * size/position than the rendered glyph, and the emoji/width-compress quad
 * sizing diverged too. One builder retires the whole drift class.
 *
 * Shape: a plain JS function emitting TSL nodes (imported from 'three/tsl'),
 * called inside each caller's own Fn(() => …). It returns the clip position
 * PLUS the chain's byproducts (vMode, glyphInfo, vEmojiCell, gColor, gScale) so
 * the render material writes its varyings without re-deriving anything; picking
 * needs none of them and just returns clipPos. The instance attributes are
 * declared BY NAME and bind to whichever mesh is rendering — proven by
 * PickingSystem's material-swap onto the same instanceMesh.
 *
 * Render modes cross the JS→GPU boundary as a numeric uniform (WGSL has no
 * enums); keep these small ints, cast with int() and compare with .equal().
 */

import {
    attribute, uniform, textureLoad,
    positionLocal, instanceIndex, storage,
    vec2, vec3, vec4, float, int, ivec2,
    modelViewMatrix, cameraProjectionMatrix,
    If,
} from 'three/tsl';

import { SLOT_STRIDE, S_GLYPH_ID, S_ADVANCE, S_HEIGHT, S_X } from '../compute/glyphPipelineReference.js';

/**
 * Render modes. Used in two places with the SAME numbers: the per-instance
 * resolved mode (drives quad sizing here + the fragment branch selector in the
 * render material's varying) and the field-level `_renderMode` uniform, where
 * GLYPH lets the per-glyph map pick SLUG vs BITMAP and FRAME forces every
 * instance to the frame branch.
 */
export const RENDER_MODE = Object.freeze({ GLYPH: 0, BITMAP: 1, FRAME: 2 });

/**
 * The byte-slots rebind seam. Every material that reads the pipeline's slot buffer
 * (render byteGlyph, picking) registers its storage node + material here;
 * rebindByteSlots points them all at a new attribute when the arena reallocates.
 *
 * WHY THIS EXISTS: three's WebGPU backend caches GPUBindGroups keyed ONLY by the
 * bound TEXTURES (WebGPUBindingUtils.createBindings: cacheIndex/version accumulate
 * texture.id/version — storage-buffer identity is not in the key). So when the arena
 * grows (or rebuilds around a new trie) and its old slot buffer is DESTROYED, every
 * already-built bind group keeps handing the render pass the destroyed buffer:
 * "[Buffer "GlyphSlots"] used in submit while destroyed", once per frame, forever
 * (reproduced by tools/arena-realloc-check.mjs; unfixed upstream as of r185.1 — on
 * each three bump, re-check WebGPUBindingUtils.createBindings' cache key; if storage
 * identity joins it, this seam goes redundant-but-harmless). The one
 * app-side lever that reaches that cache is material.dispose(): render objects for
 * the material drop, Bindings.deleteForRender clears each bind group's backend data
 * (including the poisoned texture-keyed GPUBindGroup cache), and the next frame
 * re-creates them from the node's CURRENT value. (material.needsUpdate is NOT
 * enough — an unchanged node graph means an unchanged cache key, and three then
 * just syncs the version without rebuilding anything.) Realloc is rare and loud;
 * the one-off re-init is the accepted cost.
 */
const _byteSlotsNodes = new Set();
const _byteSlotsMaterials = new Set();

/** Register a byte-slots storage node (returns it, for inline use at build sites). */
export function registerByteSlotsNode(node) {
    _byteSlotsNodes.add(node);
    return node;
}

/** Register a material whose program reads a byte-slots node (returns it). */
export function registerByteSlotsMaterial(material) {
    _byteSlotsMaterials.add(material);
    return material;
}

/** Point every registered byte-slots node at `attribute` and rebuild their bind groups. */
export function rebindByteSlots(attribute) {
    let changed = false;
    for (const node of _byteSlotsNodes) {
        if (node.value !== attribute) {
            node.value = attribute;
            changed = true;
        }
    }
    if (changed) {
        for (const material of _byteSlotsMaterials) material.dispose();
    }
}

/**
 * GLOBAL glyph width-compression dial — condense glyph ink along x, in place,
 * aligned to leading. k scales every glyph quad's width AND its center-anchor
 * shift by the same factor, so the glyph's left edge stays at its cell anchor
 * and the shrink happens about the leading edge. Layout advance (iSize.x, cell
 * anchors, column math, carets) is untouched — only the rendered ink narrows.
 * 1 = off; k > 1 expands. ONE shared uniform across every glyph material — and
 * critically across BOTH the render and pick paths (a position input shared in
 * math but held at two different values would still drift); driven by
 * `glyph.widthCompress` in app settings. Frame-mode fields (external captures
 * tiled as cells) are exempt — their quads must stay gapless.
 */
export const GLYPH_WIDTH_COMPRESS_DEFAULT = 1;
export const glyphWidthCompress = uniform(GLYPH_WIDTH_COMPRESS_DEFAULT);

/** Set the global width-compression dial live. Ignores non-finite / ≤0 (degenerate quads). */
export function setGlyphWidthCompress(value) {
    if (Number.isFinite(value) && value > 0) glyphWidthCompress.value = value;
}

/** Read the current width-compression dial. */
export function getGlyphWidthCompress() { return glyphWidthCompress.value; }

/**
 * Build the instance-glyph → clip-position transform. Emits TSL nodes into the
 * caller's graph — call this inside a Fn(() => …) body. Declares its own
 * instance attributes by name (instancePosition vec4/.xyz, instanceSize vec2,
 * instanceGlyphId float, instanceGroupId float) so callers don't have to.
 *
 * Owns the full drift-prone chain: glyph-map lookup → resolved mode (+ frame
 * override) → quad sizing (emoji square, width compress) → group transform
 * (rigid scale about the group origin) → MVP, then BOTH culls in the vertex:
 * invisible group (alpha ≤ 0.01) and the frame-clip window. Culls degenerate to
 * outside-NDC (z/w = 2 > 1) so the GPU clips the triangles (a vertex can't
 * Discard). iPos.y and gColor.a are per-instance/per-group — identical for all
 * 4 quad verts — so quads cull whole with no torn edges.
 *
 * @param {Object} nodes - already-built per-object nodes (uniform/texture),
 *   resolving at draw from the mesh's `userData.glyphField` (exactly as
 *   GlyphField's _fieldTexture/_fieldUniform build them):
 *   glyphMapTex, glyphMapWidth, renderMode, groupTex,
 *   clipEnabled, clipTop, clipBottom.
 * @returns {{ clipPos, vMode, glyphInfo, vEmojiCell, gColor, gScale }}
 *   clipPos is the vertex return (culled); the rest are byproducts the render
 *   material uses for its varyings (picking ignores them).
 */
export function buildGlyphVertexTransform({ glyphMapTex, glyphMapWidth, renderMode, groupTex, clipEnabled, clipTop, clipBottom, byteSlots = null, byteSlotBase = null }) {
    // instancePosition is stride-4 (itemSize=4) on every field — read it as vec4
    // and use .xyz (.w is padding). A stride-3 declaration bakes a wrong
    // vertex-fetch stride into the pipeline.
    //
    // BYTE-PIPELINE FIELDS (byteSlots set): positions/sizes/glyphIds are read from the
    // pipeline's stride-11 slot buffer instead of per-instance attributes — one storage
    // read at (byteSlotBase + instanceIndex) × SLOT_STRIDE. The buffer is per-grid today;
    // slotBase is the seam the multi-file hoist (one buffer per load) plugs into.
    // Read-only storage in the vertex stage is core WebGPU. Non-leader byte slots carry
    // zeroed lanes: size (0,0) collapses the quad to a point — invisible, unpickable.
    let iPos, iSize, iGlyphId;
    if (byteSlots) {
        const base = int(byteSlotBase).add(int(instanceIndex)).mul(int(SLOT_STRIDE));
        iPos     = vec4(byteSlots.element(base.add(int(S_X))), byteSlots.element(base.add(int(S_X + 1))), byteSlots.element(base.add(int(S_X + 2))), float(0));
        iSize    = vec2(byteSlots.element(base.add(int(S_ADVANCE))), byteSlots.element(base.add(int(S_HEIGHT))));
        iGlyphId = byteSlots.element(base.add(int(S_GLYPH_ID)));
    } else {
        iPos     = attribute('instancePosition', 'vec4');
        iSize    = attribute('instanceSize',     'vec2');
        iGlyphId = attribute('instanceGlyphId',  'float');
    }
    const iGroup   = attribute('instanceGroupId',  'float');

    // Glyph-map lookup: glyphId → curve range + mode (RGBA32Uint, 1 texel/glyph).
    // Done first so the resolved mode drives quad sizing below.
    const gid       = int(iGlyphId);
    const mapW      = int(glyphMapWidth);
    const glyphInfo = textureLoad(glyphMapTex, ivec2(gid.mod(mapW), gid.div(mapW)));

    // Frame mode (field-level): force every instance to the frame branch; the
    // cell index becomes the raw instanceGlyphId. renderMode is a numeric
    // uniform; cast and compare exactly (0/2 are exact in float).
    const isFrame = int(renderMode).equal(int(RENDER_MODE.FRAME));
    const vMode       = isFrame.select(int(RENDER_MODE.FRAME), int(glyphInfo.z)); // .z: mode (0=slug,1=bitmap)
    const vEmojiCell  = isFrame.select(int(iGlyphId), int(glyphInfo.w));           // .w: emoji cell index

    // Bitmap (emoji) glyphs get a SQUARE quad (iSize.y); slug glyphs keep the
    // narrow advance (iSize.x). Reads the RESOLVED vMode so frame mode (FRAME,
    // not BITMAP) keeps its real cell width instead of going square.
    const isBitmap = vMode.equal(int(RENDER_MODE.BITMAP));
    const quadW    = isBitmap.select(iSize.y, iSize.x);

    // Width compression — scales the visual quad width and its center-anchor
    // shift by the same k (shrink-in-place about the leading edge). Frame mode
    // is exempt (gapless tiling).
    const kW = isFrame.select(float(1), glyphWidthCompress);

    const scaled      = positionLocal.mul(vec3(quadW.mul(kW), iSize.y, float(1)));
    const alignOffset = vec3(iSize.x.mul(0.5).mul(kW), float(0), float(0));

    // Group DataTexture lookup — textureLoad with exact integer texel coords
    // (4 columns × maxGroups rows, RGBA32F). rgba32float is NOT filterable under
    // WebGPU; a normalized .sample() returns garbage and collapses every glyph
    // to a degenerate position.
    const grow   = int(iGroup);
    const gPos   = textureLoad(groupTex, ivec2(int(0), grow)); // col 0: offset + visibility
    const gColor = textureLoad(groupTex, ivec2(int(2), grow)); // col 2: color multiplier
    const gScale = textureLoad(groupTex, ivec2(int(3), grow)); // col 3: scale + colorBlend (w)

    // World position = (aligned quad + instancePos) * groupScale + groupOffset.
    // The group scale multiplies the WHOLE glyph (quad size and position alike),
    // so a group scales as one rigid label/badge about its own origin — bake
    // glyph positions group-LOCAL and put the anchor in the group offset.
    const clipPos = cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(
        scaled.add(alignOffset).add(iPos.xyz).mul(gScale.xyz).add(gPos.xyz),
        float(1),
    )));

    // Apply both culls by degenerating clipPos to outside-NDC. Sequential Ifs
    // mutating one toVar — same pattern the render material used for the
    // frame-clip cull alone, now shared and extended to group visibility.
    const outClip = clipPos.toVar();
    const OFF = () => vec4(float(2), float(2), float(2), float(1));
    If(gColor.a.lessThan(0.01), () => { outClip.assign(OFF()); });            // invisible group
    If(clipEnabled.greaterThan(0.5).and(                                     // frame-clip window
        iPos.y.greaterThan(clipTop).or(iPos.y.lessThan(clipBottom))),
        () => { outClip.assign(OFF()); });

    return { clipPos: outClip, vMode, glyphInfo, vEmojiCell, gColor, gScale };
}

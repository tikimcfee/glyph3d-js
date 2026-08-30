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
    If, cross, bitcast, uint,
} from 'three/tsl';

import { SLOT_STRIDE, S_GLYPH_ID, S_ADVANCE, S_HEIGHT, S_X, S_ROW, S_COL } from '../compute/glyphPipelineReference.js';

/**
 * The group-table row schema — ONE storage buffer, GROUP_STRIDE vec4s per group.
 * Lives here because this file is the primary reader; every consumer (GlyphField
 * render/occluder materials, PickingSystem, PanelField) indexes rows by these
 * constants, so a layout change lands in every shader in the same breath.
 *   col 0: offset.xyz            (w free)
 *   col 1: rotation quaternion   (xyzw; identity 0,0,0,1)
 *   col 2: color.rgb + alpha     (alpha ≤ 0.01 = invisible — the vertex cull)
 *   col 3: scale.xyz + colorBlend
 *   col 4: clipTop, clipBottom, clipEnabled (grid-local y window; w free)
 * A row is a full pose + style: 80B, written whole-row via addUpdateRange (partial
 * uploads — the reason this is a buffer, not a texture).
 *
 * Cols 5-6 carried the far-texture slab uv + hasSlab flag. The far tier is deleted, so
 * they are gone rather than left zeroed: dead lanes in a hot per-group row are the
 * compatibility shim this repo forbids, and the row is 80B instead of 112B.
 */
export const GROUP_COLS    = 5;   // pose/style cols (0-4)
export const GROUP_STRIDE  = 5;   // vec4s per group row

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
 * The group-buffer growth seam — same disease, same cure as byte slots. A field's
 * group-table growth replaces its storage attribute; the nodes re-resolve per
 * object (they read field._groupAttr by property), but every already-built bind
 * group keeps the OLD GPUBuffer (the texture-keyed cache — see the byte-slots
 * comment above). Every material whose program reads the group buffer registers
 * here; growth calls disposeGroupMaterials() and the next frame rebuilds from
 * the current attribute. Growth is rare (capacity doubling) and loud.
 * Per-instance materials (PanelField) UNREGISTER on their own dispose so the
 * set tracks live materials, not history.
 */
const _groupMaterials = new Set();

/** Register a material whose program reads the group buffer (returns it). */
export function registerGroupMaterial(material) {
    _groupMaterials.add(material);
    return material;
}

/** Drop a dead material from the growth seam (call from its owner's dispose). */
export function unregisterGroupMaterial(material) {
    _groupMaterials.delete(material);
}

/** Rebuild every group-buffer reader's bind groups (call after an attribute swap). */
export function disposeGroupMaterials() {
    for (const material of _groupMaterials) material.dispose();
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
 * (full rigid TRS: scale → quat rotation → offset, all from the group texel —
 * a group is a complete pose, so a view/label can face any way without its own
 * mesh) → MVP, then BOTH culls in the vertex: invisible group (alpha ≤ 0.01)
 * and the per-group clip window. Culls degenerate to outside-NDC (z/w = 2 > 1)
 * so the GPU clips the triangles (a vertex can't Discard). iPos.y and gColor.a
 * are per-instance/per-group — identical for all 4 quad verts — so quads cull
 * whole with no torn edges.
 *
 * @param {Object} nodes - already-built per-object nodes (uniform/texture/storage),
 *   resolving at draw from the mesh's `userData.glyphField` (exactly as
 *   GlyphField's _fieldTexture/_fieldUniform/_fieldGroups build them):
 *   glyphMapTex, glyphMapWidth, renderMode, groups, maxGroups.
 * @returns {{ clipPos, vMode, glyphInfo, vEmojiCell, gColor, gScale }}
 *   clipPos is the vertex return (culled); the rest are byproducts the render
 *   material uses for its varyings (picking ignores them).
 */
export function buildGlyphVertexTransform({ glyphMapTex, glyphMapWidth, renderMode, groups, maxGroups, byteSlots = null }) {
    // instancePosition is stride-4 (itemSize=4) on every field — read it as vec4
    // and use .xyz (.w is padding). A stride-3 declaration bakes a wrong
    // vertex-fetch stride into the pipeline.
    //
    // BYTE-PIPELINE FIELDS (byteSlots set): positions/sizes/glyphIds are read from the
    // pipeline's stride-11 slot buffer instead of per-instance attributes — one storage
    // read at instanceIndex × SLOT_STRIDE (the mega-field spans the whole arena, so
    // instance index == arena byte offset == slot index; a grid's presence is a group).
    // Read-only storage in the vertex stage is core WebGPU. Non-leader byte slots carry
    // zeroed size lanes — decode re-zeroes S_ADVANCE/S_HEIGHT every run (a rewritten
    // range's edit slack was a real glyph last run) — so size (0,0) collapses the quad
    // to a point: invisible, unpickable.
    let iPos, iSize, iGlyphId, iRowCol;
    if (byteSlots) {
        // UINT, matching the kernels (id.mul(uint(SLOT_STRIDE)) throughout). This used
        // to convert a natively-unsigned instanceIndex DOWN to i32, which wrapped at
        // 2^31/SLOT_STRIDE — half the addressable range, and silently: past that point
        // every glyph reads a negative index and renders garbage geometry with no
        // error. The arena's ceiling is only meaningful if the vertex path can address
        // what the arena can hold.
        const base = instanceIndex.mul(uint(SLOT_STRIDE));
        // The slot buffer is u32: count lanes are stored natively, float lanes are
        // bitcast. S_X + 1 / S_X + 2 are the Y and Z lanes addressed POSITIONALLY —
        // they are float lanes despite the constant reading S_X, and a search for
        // S_Y / S_Z will not find them.
        const fl = (l) => bitcast(byteSlots.element(base.add(int(l))), 'float');
        iPos     = vec4(fl(S_X), fl(S_X + 1), fl(S_X + 2), float(0));
        iSize    = vec2(fl(S_ADVANCE), fl(S_HEIGHT));
        // EXACT lane now — the trie moved to u32, so the id is a native integer and
        // CONVERTS to float for the shader's use rather than being reinterpreted.
        // bitcast here would read the integer's bit pattern as a denormal.
        iGlyphId = byteSlots.element(base.add(int(S_GLYPH_ID))).toFloat();
        // The glyph's exact grid position (apply's integer lanes) — the fragment's
        // far-texture UV rides this. Non-byte fields have no grid truth → (0,0),
        // which their hasSlab=0 far-group texel turns back into the impostor path.
        // Count lanes: native u32 now, so they convert rather than reinterpret.
        iRowCol  = vec2(byteSlots.element(base.add(int(S_ROW))).toFloat(), byteSlots.element(base.add(int(S_COL))).toFloat());
    } else {
        iPos     = attribute('instancePosition', 'vec4');
        iSize    = attribute('instanceSize',     'vec2');
        iGlyphId = attribute('instanceGlyphId',  'float');
        iRowCol  = vec2(0);
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

    // Group-buffer lookup — vec4 element reads at row × GROUP_STRIDE. OOB is a
    // REAL hazard here where it wasn't for textureLoad: robust storage access
    // CLAMPS the index (textureLoad returned zeros → alpha 0 → cull), so a stale
    // group id past capacity would ghost-render wearing the last row's pose.
    // The explicit bound check below joins the culls.
    const grow   = int(iGroup);
    const gBase  = grow.mul(int(GROUP_STRIDE));
    const gPos   = groups.element(gBase.add(int(0))); // col 0: offset (w free)
    const gQuat  = groups.element(gBase.add(int(1))); // col 1: rotation quaternion
    const gColor = groups.element(gBase.add(int(2))); // col 2: color multiplier
    const gScale = groups.element(gBase.add(int(3))); // col 3: scale + colorBlend (w)
    const gClip  = groups.element(gBase.add(int(4))); // col 4: clipTop, clipBottom, clipEnabled

    // World position = rotate(quat, (aligned quad + instancePos) * groupScale) + groupOffset
    // — the T·R·S a decomposed matrixWorld yields, so a group texel can carry a whole
    // entity's pose (the mega-field's per-view transform). Scale multiplies the WHOLE
    // glyph (quad size and position alike) about the group origin; identity quat
    // (0,0,0,1 — the texel default) reduces to the old scale+offset path exactly.
    const local   = scaled.add(alignOffset).add(iPos.xyz).mul(gScale.xyz);
    // v' = v + 2·q.xyz × (q.xyz × v + q.w·v) — the standard quat sandwich, cross-form.
    const qc      = cross(gQuat.xyz, local).add(local.mul(gQuat.w));
    const posed   = local.add(cross(gQuat.xyz, qc).mul(2));
    const clipPos = cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(
        posed.add(gPos.xyz),
        float(1),
    )));

    // Apply the culls by degenerating clipPos to outside-NDC. Sequential Ifs
    // mutating one toVar. The clip window is PER GROUP (gClip lanes) and tests the
    // raw grid-local anchor y — pre-scale, pre-rotation — so clip values are stated
    // in the same frame the layout laid the glyphs in.
    const outClip = clipPos.toVar();
    const OFF = () => vec4(float(2), float(2), float(2), float(1));
    If(grow.greaterThanEqual(int(maxGroups)), () => { outClip.assign(OFF()); }); // OOB group id (clamped read above)
    If(gColor.a.lessThan(0.01), () => { outClip.assign(OFF()); });            // invisible group
    If(gClip.z.greaterThan(0.5).and(                                         // per-group clip window
        iPos.y.greaterThan(gClip.x).or(iPos.y.lessThan(gClip.y))),
        () => { outClip.assign(OFF()); });

    return { clipPos: outClip, vMode, glyphInfo, vEmojiCell, gColor, gScale, iRowCol, iGroup };
}

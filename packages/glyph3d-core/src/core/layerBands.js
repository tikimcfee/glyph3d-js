/**
 * layerBands — deterministic depth ordering for the stacked translucent layers.
 *
 * A book/grid scene stacks several depth-writing surfaces with tiny geometric gaps:
 * the page/panel face (PANEL_SURFACE, ~8 units behind the fields), each grid's
 * background wall (GRID_BACKGROUND, a fraction of a unit behind its text), and the
 * glyph quads themselves (renderOrder 0). Viewed from a library vantage hundreds of
 * units out, the depth buffer's nonlinear precision (it clusters at the near plane)
 * resolves those gaps to LESS than one depth step — per-pixel ties that flip with
 * camera float jitter along the planes' intersection line: the straight-edged
 * "triangle-strip" takeover bands and the flashing (see
 * docs/plans/z-order-transparency-reorg.md).
 *
 * THE MECHANISM: a clip-space z bias, applied in the vertex stage as
 * `clip.z += bias · clip.w` — a CONSTANT fraction of the NDC depth range.
 * Negative pulls a band toward the camera.
 *
 * DEFAULTS ARE ZERO and that is deliberate (user-verified): a fixed NDC bias
 * is distance-independent, but the geometric gaps between layers are not —
 * at library vantages the cross-stack gaps (front face → rear sheet's text)
 * shrink BELOW any useful bias, so a nonzero glyph bias lets rear text
 * outrank a front sheet's opaque face. With camera.nearPlane ≥ ~4 the depth
 * buffer resolves the real gaps on its own. The biases are a debugging PROBE
 * (force an order, watch a layer win/lose), not a standing fix.
 * NOTE (WebGL2 / InstancedField architecture):
 * In WebGL2, depth separation is handled directly via world-space geometric offsets
 * (getBandDistance / setBandDistance) and explicit renderOrder. The clip-space bias
 * stubs (withBandBias, bandBiasNode) are retained for backward compatibility with TSL
 * nodes if running under WebGPURenderer.
 *
 * Distances (getBandDistance/setBandDistance) are the world-space set-backs that
 * pair with the bands: the gap keeps near-view parallax honest.
 * gridBackground: how far a grid's wall sits behind its text
 * (replaces the hard-coded -0.1 / zMin-0.5 in CodeGrid / TerminalGrid).
 */



/** Band names — pass these to bandBiasNode / setLayerBandBias. */
export const LAYER_BAND = Object.freeze({
    PANEL_FACE:      'panelFace',
    GRID_BACKGROUND: 'gridBackground',
    GLYPH:           'glyph',
});

// NDC-fraction biases (negative = toward camera). One shared uniform node per
// band — every material in the band references the SAME node, so a dial write
// is visible to all of them on the next frame.
//
// DEFAULTS ARE ALL ZERO (user-verified 2026-08-09): a fixed NDC bias is
// distance-independent, but the geometric gaps it must respect are not — at a
// ~20k library vantage the CROSS-stack gap (front face → rear sheet's text,
// ~138 units of deck pitch) collapses to ~1e-6 NDC, SMALLER than the -2e-4
// glyph bias we shipped first: rear text outranked the front sheet's opaque
// face. With a healthy near plane (camera.nearPlane ≥ ~4) geometry resolves
// both within- and cross-stack order on its own, and zero biases can't
// interfere. The machinery stays for debugging — nudge a band to force an
// order and watch a layer win/lose — but nonzero is a PROBE, not a fix.
const BAND_DEFAULTS = {
    panelFace:       0,   // the rearmost wall
    gridBackground:  0,
    glyph:           0,
};

const _bias = Object.fromEntries(
    Object.entries(BAND_DEFAULTS).map(([band, v]) => [band, { value: v }])
);

// World-space set-backs that pair with the bands.
const DISTANCE_DEFAULTS = {
    gridBackground: 0.5,
};
const _distances = { ...DISTANCE_DEFAULTS };

/**
 * The band's shared bias.
 * @param {string} band - a LAYER_BAND value
 */
export function bandBiasNode(band) {
    return _bias[band] ?? null;
}

/**
 * Wrap a clip-space position node with the band's live depth bias if in TSL.
 * @param {Node} clipNode - a clip-space position
 * @param {string} band - a LAYER_BAND value
 */
export function withBandBias(clipNode, band) {
    return clipNode;
}

/** Restyle a band live: the shared uniform takes the value; every material in
 *  the band renders with it next frame. */
export function setLayerBandBias(band, v) {
    const u = _bias[band];
    if (u) u.value = v;
}

/** A band's current bias (settings defaults + inspection). */
export function getLayerBandBias(band) {
    return _bias[band]?.value;
}

/** A band distance's current value (e.g. LAYER_BAND.GRID_BACKGROUND → the bg gap). */
export function getBandDistance(band) {
    return _distances[band];
}

/** Set a band distance live. Distance consumers re-read at layout; existing
 *  on-screen grids are nudged by their refreshBackground(gap) from the settings
 *  apply (no relayout needed — the z shifts by the delta). */
export function setBandDistance(band, v) {
    if (band in _distances) _distances[band] = v;
}

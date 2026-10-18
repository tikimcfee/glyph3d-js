/**
 * layerBands — the world-space set-backs that keep stacked layers apart in depth.
 *
 * A grid stacks a depth-writing background wall a small distance behind its text.
 * That distance is a geometric offset (plus explicit renderOrder), so near-view
 * parallax stays honest and the depth buffer resolves the order on its own — with a
 * healthy near plane (camera.nearPlane ≥ ~4) no clip-space bias is needed (see
 * docs/plans/z-order-transparency-reorg.md).
 *
 * gridBackground: how far a grid's / terminal's wall sits behind its text — read by
 * CodeGrid / TerminalGrid / GridBackground at build, set live by the
 * `appearance.backgroundSetBack` setting (which also nudges every on-screen background).
 */

/** Band names — pass these to getBandDistance / setBandDistance. */
export const LAYER_BAND = Object.freeze({
    GRID_BACKGROUND: 'gridBackground',
});

const DISTANCE_DEFAULTS = {
    gridBackground: 0.5,
};
const _distances = { ...DISTANCE_DEFAULTS };

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

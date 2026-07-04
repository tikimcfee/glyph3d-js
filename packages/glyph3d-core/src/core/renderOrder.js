/**
 * Centralized renderOrder bands.
 *
 * L0 of the editable-3d-ide cross-ref consolidates the magic numbers
 * scattered across ~9 call sites (backdrops at -10, grid backgrounds at -1,
 * compass at 999/1000+i, spiral lines at -20, etc.) into one module
 * WITHOUT changing any numeric value. Later phases (L1 AttentionManager,
 * L2 CameraDock + HUD chrome, L3 drag ghosts / modal overlays) will renumber
 * the bands into the target layout documented in the cross-ref convergence
 * docs. Keeping values identical in L0 means zero visual change on land.
 *
 * Two exports:
 *
 *   RENDER_ORDER         — current values (L0 preserves these exactly).
 *                          Call sites import from here today.
 *
 *   RENDER_ORDER_TARGET  — future bands L1/L2/L3 will migrate callers to.
 *                          Documented here so nobody re-invents it. DO NOT
 *                          use in application code yet — wait for the
 *                          migration pass that renumbers every site.
 *
 * When L1+ lands, flip individual call sites from
 *   renderOrder = RENDER_ORDER.COMPASS_MARKER
 * to
 *   renderOrder = RENDER_ORDER_TARGET.HUD_CHROME
 * and verify the compositing still works, then delete the legacy constant.
 */

/**
 * Current values, unchanged from the pre-L0 codebase. One named constant
 * per call site. Comments cite the file:line that originated each value.
 */
export const RENDER_ORDER = Object.freeze({
    // src/collections/SpiralLayoutManager.js:164 — layout connector lines,
    // drawn deepest-first so grid backgrounds sit on top.
    SPIRAL_LINE:          -20,

    // src/services/visual/BackdropManager.js:181 — backdrops at
    // `-10 + depth` (depth ≥ 0). Use BACKDROP_BASE + depth at the call site.
    BACKDROP_BASE:        -10,

    // src/collections/layouts/panelSurface.js — the jellyfish panel's backing face,
    // one band BEHIND a grid's own wall so the fields' walls sort in front of the
    // shared panel surface they mount onto (and in front of dir backdrops).
    PANEL_SURFACE:        -2,

    // src/collections/CodeGrid.js:982, src/collections/TerminalGrid.js:485 —
    // background plane just behind its glyphs.
    GRID_BACKGROUND:      -1,

    // src/hand/HandRenderer.js:141 — skeleton bones inside the hand group.
    HAND_BONE:             1,

    // src/annotations/ConnectionRenderer.js:70 — connection mesh drawn on
    // top of grid quads but below HUD.
    CONNECTION:            1,

    // src/hand/HandRenderer.js:151 — skeleton joints, one notch above bones.
    HAND_JOINT:            2,

    // src/collections/TerminalGrid.js — window control chrome (resize/scale grips,
    // pin + size/scale dial buttons). DEPTH-TESTED, so a window in front occludes it:
    // chrome occludes like its parent panel rather than floating on top of the scene
    // (the prior 10001 + depthTest:false was an always-on-top overlay). renderOrder
    // only sorts it above the tile's OWN glyphs (0) and caret (5).
    GRID_CHROME:           6,

    // src/services/interaction/ReaderCompass.js:65 — compass root group.
    COMPASS_ROOT:          999,

    // src/services/interaction/ReaderCompass.js:207 — per-marker meshes,
    // computed as COMPASS_MARKER_BASE + i to keep within-pool ordering.
    COMPASS_MARKER_BASE:   1000,
});

/**
 * Target bands for L1-L3. Not yet consumed anywhere in application code.
 * When the migration pass lands, these will replace the per-site names above.
 * Matches the table in round3-commands-convergence.md §"File 3" and
 * round3-hud-convergence.md §Settled#9.
 */
export const RENDER_ORDER_TARGET = Object.freeze({
    SCENE_BACK:      -100,
    SCENE_DEFAULT:      0,
    HUD_OVERLAY:     1000,
    HUD_BODY:        2000,
    HUD_CHROME:      3000,
    HUD_GHOST:       4000,
    HUD_MODAL:       5000,
});

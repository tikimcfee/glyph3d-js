import { stateController } from '@glyph3d/core/services/state';
import { setPanelStateColorDefaults } from '@glyph3d/core/collections';
import { setGlyphLodParam, GLYPH_LOD_DEFAULTS } from '@glyph3d/core/GlyphField.js';
import { setGlyphWidthCompress, GLYPH_WIDTH_COMPRESS_DEFAULT } from '@glyph3d/core/core/glyphVertex.js';
import { setTabParam, TAB_DEFAULTS } from '@glyph3d/core/components/Tab3D.js';
import { setStrataParam, STRATA_DEFAULTS } from '@glyph3d/core/collections/StrataLayout.js';
import { TERMINAL_CURSOR_DEFAULTS } from '@glyph3d/core/collections/TerminalGrid.js';
import { JELLYFISH_DEFAULTS, LIBRARY_DEFAULTS, schemeNameOf } from '@glyph3d/core/collections/layouts/index.js';
import { LABEL_DEFAULTS } from '@glyph3d/core/collections/ContentTreeLabels.js';
import { MOTION_DEFAULTS } from '@glyph3d/core/collections/ContentTreeMotion.js';
import { ARROW_DEFAULTS } from '@glyph3d/core/collections/ContentTreeArrows.js';
import { LAYOUT_PRESETS, setDefaultLayout } from '@glyph3d/core/workers/builders/index.js';
import { setAnalyzeDebounce } from '@glyph3d/core/parsing/SyntaxColorizer.js';

// Settings schema — the SINGLE source for both the Settings panel (renders a row
// per entry) and the settings.* verbs (validate + apply). Only WIRED knobs live
// here; nothing that wouldn't take effect. Persistence is StateController
// (localStorage, `g3d.*`) — client-only, no relay required, the same store the
// camera already uses and the vanilla IDE persisted through.
//
// `apply(ctx, value)` pushes a live change to its subsystem. `reload: true` marks a
// boot-time knob — the glyph atlas is built once at startup, so font/atlas changes
// persist now and take hold on the next page load.

/** apply() for a dock layout knob: push the value to CameraDock.setParam, which
 *  re-packs the live bar. The bare param name (not the `dock.` setting key) goes through. */
const dockParam = (param) => (ctx, v) => ctx.cameraDock?.setParam?.(param, v);

/** apply() for a carrel knob: push it onto EVERY live desk. New desks pick the stored
 *  values up at birth (carrel.create runs applyGroupSettings(ctx, 'Carrel')), so these
 *  are both the live dial and the defaults; carrel.set <name> stays the per-desk verb. */
const carrelParam = (param) => (ctx, v) => {
  for (const c of ctx.carrels?.values?.() || []) c.setParam?.(param, v);
};

/** apply() for a glyph minification/LOD dial: push the bare dial name (not the `glyph.` key) to the
 *  global GlyphField LOD uniform — live across every glyph material, no ctx subsystem needed. */
const lodParam = (param) => (_ctx, v) => setGlyphLodParam(param, v);

/** apply() for a strata dial: push the bare param name (not the `strata.` key) to the global
 *  StrataLayout params — re-applies live to every on-screen strata view, no ctx needed. */
const strataParam = (param) => (_ctx, v) => setStrataParam(param, v);

/** apply() for an agent-books knob: push the value to AgentBooks.cfg (the bare param name, not
 *  the `book.` key) and re-apply — live cards re-scale, every sheet re-fits, the shelf re-flows. */
const bookParam = (param) => (ctx, v) => { const b = ctx.agentBooks; if (!b) return; b.cfg[param] = v; b.applyScales?.(); };

/** apply() for a BOOK PAGE dial — the ONE page-face config every Book shares. Agent books
 *  and the library's volumes are the same carrier with the same rendering; only their
 *  state differs — so a page knob fans out to BOTH owners: the agent shelf's cfg (re-fit
 *  every lane) and the library scheme's layout opts (re-lay live while library shows;
 *  otherwise the stored value seeds the next activation — these defs carry
 *  scheme:'library' and their key TAILS are the layout opt names, so
 *  schemeSettingsOpts folds them in). */
const bookPageParam = (agentKey, layoutParam) => (ctx, v) => {
  const b = ctx.agentBooks;
  if (b) { b.cfg[agentKey] = v; b.applyScales?.(); }
  const tree = ctx?.contentTree;
  if (tree && schemeNameOf(tree.layout) === 'library') {
    tree.setLayout(tree.layout, { ...(tree.layoutOpts || {}), [layoutParam]: v });
    tree.relayoutAndRest(0);
  }
};

/** apply() for a container-label dial: patch the bare param into ContentTreeLabels' opts —
 *  configure() rebuilds the field only for build-shaping opts; spectrum/hover dials just steer
 *  the next frame. Color knobs store '#rrggbb'; the overlay wants a hex int. */
const labelParam = (param, toHex = false) => (ctx, v) =>
  ctx.contentTreeLabels?.configure({ [param]: toHex ? parseInt(String(v).slice(1), 16) : v });

/** apply() for a layout-scheme dial: merge the bare param into the content tree's live layout
 *  opts and re-lay the field — but only while that scheme is showing, since only it reads these.
 *  Under any other scheme the value just persists (via setSetting) and is folded in when the
 *  scheme is next named — see schemeSettingsOpts + the layout.scheme verb. */
const schemeParam = (scheme, param) => (ctx, v) => {
  const tree = ctx?.contentTree;
  if (!tree || schemeNameOf(tree.layout) !== scheme) return;
  tree.setLayout(tree.layout, { ...(tree.layoutOpts || {}), [param]: v });
  tree.relayoutAndRest(0);
};
const jellyfishParam = (param) => schemeParam('jellyfish', param);
const libraryParam = (param) => schemeParam('library', param);

// GROUPS — the ordered registry of sections: the order the Settings panel lists
// them in, plus a one-line subtitle (a brief sample of what's inside) shown under
// the uppercased name. The subtitle is the legibility hack for the big merged
// sections (Tree & labels, Dock & frame) until real sub-headers arrive — it tells
// you what's in a section before you open it. Every name must match a `group` on
// some SETTINGS entry, or the panel skips it.
export const GROUPS = [
  { name: 'Camera',             subtitle: 'flight speed · proximity auto-slow · soft bounds · draw distance' },
  { name: 'Environment',        subtitle: 'sky, grid floor, axes · minimap overview' },
  { name: 'Theme & appearance', subtitle: 'code & terminal backgrounds · cursor · focus / hover / input colors' },
  { name: 'Display & glyph LOD', subtitle: 'font, atlas, width compress · minify / flicker control' },
  { name: 'Code grids',         subtitle: 'the layout preset new grids are born with' },
  { name: 'Layout',             subtitle: 'jellyfish column · library page-scheme' },
  { name: 'Tree & labels',      subtitle: 'ownership wires · container-name plates & approach fade' },
  { name: 'Dock & frame',       subtitle: 'pinned-window tile bar · ghost slots · nameplates · view-pane' },
  { name: 'Carrel',             subtitle: 'world-anchored reading desks' },
  { name: 'Agent Books',        subtitle: 'the agent shelf · shared page face' },
  { name: 'Book tabs',          subtitle: 'edge tabs · stagger mode · lift off edge' },
  { name: 'Strata',             subtitle: 'nested Z-depth structure view' },
  { name: 'Motion',             subtitle: 'relayout glide' },
  { name: 'Culling & loading',  subtitle: 'occlusion culling · build budget · draw-call readout' },
  { name: 'Connection',         subtitle: 'auto-connect to relay on load' },
];

export const SETTINGS = [
  // Book tabs — live edge-tab geometry (Book.syncTabs re-reads these every frame).
  { key: 'tab.steps', label: 'Stagger (0 = left-to-right, ≥2 = slots)', group: 'Book tabs', type: 'number', default: TAB_DEFAULTS.steps, min: 0, max: 12, step: 1, apply: (_ctx, v) => setTabParam({ steps: v }) },
  { key: 'tab.placement', label: 'Edge', group: 'Book tabs', type: 'enum', options: ['top', 'fore'], default: TAB_DEFAULTS.placement, apply: (_ctx, v) => setTabParam({ placement: v }) },
  { key: 'tab.protrusion', label: 'Lift off edge', group: 'Book tabs', type: 'number', default: TAB_DEFAULTS.protrusion, min: 0, max: 60, step: 1, apply: (_ctx, v) => setTabParam({ protrusion: v }) },
  {
    key: 'camera.speed', label: 'Move speed', group: 'Camera',
    type: 'number', default: 500, min: 1, max: 1000, step: 1,
    apply: (ctx, v) => ctx.cameraController?.setSpeed?.(v),
  },
  // Proximity auto-slow: a WASD flight slows as it nears content and speeds back up as it
  // clears it. A relevance VALLEY over distance — the × knobs set how slow/fast the ends
  // are, the distance knobs set where the ramp sits. Off → flat speed everywhere.
  //   floor/ceiling (×) — slowest (closest) and cruise (far) speed, × base move speed.
  //   slow start / floor (dist) — ramp begins (cruise→slow) at 'slow start', bottoms out at 'floor at'.
  //   snap-back (dist) — get closer than this and you punch back to cruise (you've passed
  //                      through it); 0 disables it.
  {
    key: 'camera.dynamicSpeed', label: 'Proximity auto-slow', group: 'Camera',
    type: 'bool', default: true,
    apply: (ctx, v) => { if (ctx.cameraController) ctx.cameraController.settings.dynamicSpeed = v; },
  },
  {
    key: 'camera.dynamicSpeedMin', label: 'Auto-slow floor (×)', group: 'Camera',
    type: 'number', default: 0.15, min: 0.02, max: 1, step: 0.01,
    apply: (ctx, v) => { if (ctx.cameraController) ctx.cameraController.settings.dynamicSpeedMin = v; },
  },
  {
    key: 'camera.dynamicSpeedMax', label: 'Auto-slow ceiling (×)', group: 'Camera',
    type: 'number', default: 2, min: 1, max: 20, step: 0.5,
    apply: (ctx, v) => { if (ctx.cameraController) ctx.cameraController.settings.dynamicSpeedMax = v; },
  },
  {
    key: 'camera.dynamicNearDist', label: 'Auto-slow floor at (dist)', group: 'Camera',
    type: 'number', default: 30, min: 1, max: 500, step: 1,
    apply: (ctx, v) => { if (ctx.cameraController) ctx.cameraController.settings.dynamicNearDist = v; },
  },
  {
    key: 'camera.dynamicFarDist', label: 'Auto-slow starts at (dist)', group: 'Camera',
    type: 'number', default: 800, min: 50, max: 4000, step: 50,
    apply: (ctx, v) => { if (ctx.cameraController) ctx.cameraController.settings.dynamicFarDist = v; },
  },
  {
    key: 'camera.dynamicReleaseDist', label: 'Auto-slow snap-back (dist, 0=off)', group: 'Camera',
    type: 'number', default: 40, min: 0, max: 200, step: 1,
    apply: (ctx, v) => { if (ctx.cameraController) ctx.cameraController.settings.dynamicReleaseDist = v; },
  },
  {
    key: 'camera.dynamicSpeedSmoothing', label: 'Auto-slow smoothing (s, 0=off)', group: 'Camera',
    type: 'number', default: 0.12, min: 0, max: 0.6, step: 0.01,
    apply: (ctx, v) => { if (ctx.cameraController) ctx.cameraController.settings.dynamicSpeedSmoothing = v; },
  },
  // Soft bounds — a gentle anti-lost leash. The content's world box, padded by 'room' × the world
  // size, is the free zone; stray past it and — once you let go of the controls — a spring eases
  // you back over 'return' seconds (it never fights an active drive). A hard wall at 'hard wall' ×
  // the world size is always on, so a dropped frame can't fling the camera into the void. Off → free flight.
  {
    key: 'camera.softBounds', label: 'Soft bounds (anti-lost)', group: 'Camera',
    type: 'bool', default: true,
    apply: (ctx, v) => { if (ctx.cameraController) ctx.cameraController.settings.softBounds = v; },
  },
  {
    key: 'camera.softBoundsPadding', label: 'Soft bounds room (× world)', group: 'Camera',
    type: 'number', default: 1, min: 0.25, max: 5, step: 0.25,
    apply: (ctx, v) => { if (ctx.cameraController) ctx.cameraController.settings.softBoundsPadding = v; },
  },
  {
    key: 'camera.softBoundsHardCap', label: 'Soft bounds hard wall (× world)', group: 'Camera',
    type: 'number', default: 4, min: 1.5, max: 20, step: 0.5,
    apply: (ctx, v) => { if (ctx.cameraController) ctx.cameraController.settings.softBoundsHardCap = v; },
  },
  {
    key: 'camera.softBoundsReturn', label: 'Soft bounds return (s)', group: 'Camera',
    type: 'number', default: 0.35, min: 0, max: 2, step: 0.05,
    apply: (ctx, v) => { if (ctx.cameraController) ctx.cameraController.settings.softBoundsReturn = v; },
  },
  {
    key: 'camera.dragSensitivity', label: 'Drag sensitivity', group: 'Camera',
    type: 'number', default: 1, min: 0.1, max: 5, step: 0.1,
    apply: (ctx, v) => { if (ctx.cameraController) ctx.cameraController.settings.dragSensitivity = v; },
  },
  {
    key: 'camera.scrollSensitivity', label: 'Scroll sensitivity', group: 'Camera',
    type: 'number', default: 1, min: 0.1, max: 5, step: 0.1,
    apply: (ctx, v) => { if (ctx.cameraController) ctx.cameraController.settings.scrollSensitivity = v; },
  },
  // Draw distance — the camera's far plane: the resting horizon beyond which nothing
  // renders. fit-all GROWS past it transiently when the fit it computed needs more
  // (a fit that frames invisible content reads as an empty world); this is the value
  // the horizon returns to. Applies straight to the canvas camera, no controller needed.
  {
    key: 'camera.drawDistance', label: 'Draw distance (far plane)', group: 'Camera',
    type: 'number', default: 20000, min: 1000, max: 10000000, step: 1000,
    apply: (ctx, v) => { const cam = ctx.camera; if (cam) { cam.far = v; cam.updateProjectionMatrix?.(); } },
  },
  // View — high-level view primitives (HUD overlays). No live apply(): main.jsx mounts/
  // unmounts the widget off the persisted value via StateController's state-changed event.
  {
    key: 'view.minimap', label: 'Minimap overview', group: 'Environment',
    type: 'bool', default: true,
  },
  // Environment — the world: the gradient sky + the infinite grid floor. No live apply():
  // main.jsx reads these and passes them to <SceneEnvironment>, which rebuilds on the
  // state-changed event. Keep the grid LIGHTER than the sky (the value-range rule — that's
  // what makes the floor read instead of whispering into the void). Defaults mirror the
  // component's own defaults.
  { key: 'env.skyHorizon', label: 'Sky horizon', group: 'Environment', type: 'color', default: '#343a45' },
  { key: 'env.skyZenith', label: 'Sky top', group: 'Environment', type: 'color', default: '#191c24' },
  { key: 'env.gridColor', label: 'Grid lines', group: 'Environment', type: 'color', default: '#5b6478' },
  { key: 'env.xAxisColor', label: 'X axis (red)', group: 'Environment', type: 'color', default: '#e0556a' },
  { key: 'env.zAxisColor', label: 'Z axis (blue)', group: 'Environment', type: 'color', default: '#4a86d8' },
  { key: 'env.minorCell', label: 'Grid cell size', group: 'Environment', type: 'number', default: 200, min: 10, max: 2000, step: 10 },
  { key: 'env.majorCell', label: 'Major cell size', group: 'Environment', type: 'number', default: 2000, min: 100, max: 20000, step: 100 },
  { key: 'env.fadeFar', label: 'Grid extent (fade)', group: 'Environment', type: 'number', default: 7000, min: 500, max: 30000, step: 500 },
  {
    key: 'atlas.fontSize', label: 'Font size (px)', group: 'Display & glyph LOD',
    type: 'number', default: 48, min: 16, max: 96, step: 1, reload: true,
  },
  {
    key: 'atlas.size', label: 'Atlas texture (px)', group: 'Display & glyph LOD',
    type: 'number', default: 2048, min: 512, max: 8192, step: 512, reload: true,
  },
  // Width compression — condense glyph ink along x, in place, aligned to leading. A
  // live global shader dial (one uniform across every glyph material): the quad narrows
  // and re-anchors so its left edge stays at the cell anchor; layout advance, picking,
  // and carets are untouched. 1 = off. A feel-test knob for condensed reading.
  {
    key: 'glyph.widthCompress', label: 'Width compress', group: 'Display & glyph LOD',
    type: 'number', default: GLYPH_WIDTH_COMPRESS_DEFAULT, min: 0.1, max: 3, step: 0.05,
    apply: (_ctx, v) => setGlyphWidthCompress(v),
  },
  {
    key: 'relay.autoConnect', label: 'Auto-connect to relay on load', group: 'Connection',
    type: 'bool', default: true,
  },
  // Grid — per-grid defaults. The default fold is the shape a NEW grid is born with
  // (CodeGrid spreads DEFAULT_LAYOUT at construction, so file.open, annotations, and
  // session restore all inherit it); grids already on screen keep their fold —
  // grid.layout refolds them one at a time. Presets are the same bundles the
  // grid.layout verb speaks (LAYOUT_PRESETS, the canonical core table).
  {
    key: 'grid.defaultLayout', label: 'Default fold (new grids)', group: 'Code grids',
    type: 'enum', options: Object.keys(LAYOUT_PRESETS), default: 'long-column',
    apply: (_ctx, v) => setDefaultLayout(LAYOUT_PRESETS[v]),
  },
  // Windowed staging — a file at/above the threshold with a baked record stages only
  // its viewed rows (CodeGrid._resolveByteWindow). Like the default fold, these are
  // birth options: grids already on screen keep theirs; re-open to apply. 0 bytes
  // disables windowing entirely.
  {
    key: 'grid.windowMinBytes', label: 'Windowed staging threshold (bytes, 0 = off)', group: 'Code grids',
    type: 'number', default: 256 * 1024, min: 0, max: 16 * 1024 * 1024, step: 1024,
  },
  {
    key: 'grid.windowRows', label: 'Window span (rows, sans frame)', group: 'Code grids',
    type: 'number', default: 600, min: 10, max: 100000, step: 10,
  },
  {
    key: 'grid.windowMarginRows', label: 'Window margin (rows each side)', group: 'Code grids',
    type: 'number', default: 200, min: 0, max: 10000, step: 10,
  },
  {
    key: 'grid.analyzeDebounceMs', label: 'Syntax re-color pause (ms, 0 = every fold)', group: 'Code grids',
    type: 'number', default: 180, min: 0, max: 2000, step: 20,
    apply: (_ctx, v) => setAnalyzeDebounce(v),
  },
  // Theme — surface backgrounds. Color is a '#rrggbb' string (THREE.Color eats it
  // directly); opacity drives stacked-tile readability in a dock. apply() restyles
  // every live grid/terminal; new ones inherit via gridTheme()/terminalTheme().
  {
    key: 'grid.backgroundColor', label: 'Code background', group: 'Theme & appearance',
    type: 'color', default: '#1a1a2e',
    apply: (ctx, v) => themeAll(ctx, 'grid', { color: v }),
  },
  {
    key: 'grid.backgroundOpacity', label: 'Code background opacity', group: 'Theme & appearance',
    type: 'number', default: 0.92, min: 0, max: 1, step: 0.01,
    apply: (ctx, v) => themeAll(ctx, 'grid', { opacity: v }),
  },
  {
    key: 'terminal.backgroundColor', label: 'Terminal background', group: 'Theme & appearance',
    type: 'color', default: '#0a0a1e',
    apply: (ctx, v) => themeAll(ctx, 'terminal', { color: v }),
  },
  {
    key: 'terminal.backgroundOpacity', label: 'Terminal background opacity', group: 'Theme & appearance',
    type: 'number', default: 0.96, min: 0, max: 1, step: 0.01,
    apply: (ctx, v) => themeAll(ctx, 'terminal', { opacity: v }),
  },
  // Terminal cursor — the block that marks where typing lands. Color + the focused (solid) fill +
  // the unfocused (hollow) outline width, each pushed live to every terminal. Defaults shared with
  // the TerminalGrid constructor (TERMINAL_CURSOR_DEFAULTS) so the panel and a fresh terminal agree.
  {
    key: 'terminal.cursorColor', label: 'Terminal cursor', group: 'Theme & appearance',
    type: 'color', default: TERMINAL_CURSOR_DEFAULTS.color,
    apply: (ctx, v) => cursorStyleAll(ctx, { color: v }),
  },
  {
    key: 'terminal.cursorFill', label: 'Terminal cursor fill (focused)', group: 'Theme & appearance',
    type: 'number', default: TERMINAL_CURSOR_DEFAULTS.fillOpacity, min: 0, max: 1, step: 0.01,
    apply: (ctx, v) => cursorStyleAll(ctx, { fillOpacity: v }),
  },
  {
    key: 'terminal.cursorOutline', label: 'Terminal cursor outline (px)', group: 'Theme & appearance',
    type: 'number', default: TERMINAL_CURSOR_DEFAULTS.borderWidth, min: 0.5, max: 6, step: 0.1,
    apply: (ctx, v) => cursorStyleAll(ctx, { borderWidth: v }),
  },
  // Appearance — the interaction color vocabulary (focus / hover / edit-input). ONE source of truth,
  // shared by the in-shader panel border (every grid/terminal) AND the directory overlay, so the two
  // never drift. apply() restyles every live panel + sets the default new panels are born with; the
  // overlay reads the same values via interactionTheme().
  {
    key: 'appearance.focusColor', label: 'Focus', group: 'Theme & appearance',
    type: 'color', default: '#6ee7a0', apply: (ctx) => applyStateColors(ctx),
  },
  {
    key: 'appearance.hoverColor', label: 'Hover', group: 'Theme & appearance',
    type: 'color', default: '#9fd2ff', apply: (ctx) => applyStateColors(ctx),
  },
  {
    key: 'appearance.inputColor', label: 'Edit / input', group: 'Theme & appearance',
    type: 'color', default: '#f0b45a', apply: (ctx) => applyStateColors(ctx),
  },
  {
    key: 'appearance.captureColor', label: 'Capture (locked)', group: 'Theme & appearance',
    type: 'color', default: '#ff7a18', apply: (ctx) => applyStateColors(ctx),
  },
  // Dock — the camera-locked tile bar (CameraDock). Every knob here was a baked
  // constant; setParam re-packs the live dock and the value persists client-side.
  // maxColumns + the dome arc/rise only bite in the RADIAL layout; fillFrac only in
  // LINEAR. Layout itself stays the `dock.layout` verb + session state, not a setting.
  { key: 'dock.distance', label: 'Distance', group: 'Dock & frame', type: 'number', default: 10, min: 5, max: 120, step: 1, apply: dockParam('distance') },
  { key: 'dock.boxFrac', label: 'Tile size', group: 'Dock & frame', type: 'number', default: 0.1, min: 0.05, max: 0.5, step: 0.01, apply: dockParam('boxFrac') },
  { key: 'dock.boxAspect', label: 'Tile aspect (w:h)', group: 'Dock & frame', type: 'number', default: 1.15, min: 0.5, max: 3, step: 0.05, apply: dockParam('boxAspect') },
  { key: 'dock.gapFrac', label: 'Tile gap', group: 'Dock & frame', type: 'number', default: 0.4, min: 0, max: 1.5, step: 0.05, apply: dockParam('gapFrac') },
  { key: 'dock.maxColumns', label: 'Max tiles/row (0=auto)', group: 'Dock & frame', type: 'number', default: 0, min: 0, max: 24, step: 1, apply: dockParam('maxColumns') },
  { key: 'dock.maxArcDeg', label: 'Dome arc span°', group: 'Dock & frame', type: 'number', default: 80, min: 30, max: 180, step: 5, apply: dockParam('maxArcDeg') },
  { key: 'dock.maxRiseDeg', label: 'Dome height span°', group: 'Dock & frame', type: 'number', default: 80, min: 20, max: 110, step: 5, apply: dockParam('maxRiseDeg') },
  { key: 'dock.bottomFrac', label: 'Bar depth', group: 'Dock & frame', type: 'number', default: 0.86, min: 0, max: 1, step: 0.02, apply: dockParam('bottomFrac') },
  { key: 'dock.fillFrac', label: 'Bar fill (linear)', group: 'Dock & frame', type: 'number', default: 0.9, min: 0.5, max: 1, step: 0.02, apply: dockParam('fillFrac') },
  { key: 'dock.animDur', label: 'Animation (s)', group: 'Dock & frame', type: 'number', default: 0.167, min: 0, max: 0.6, step: 0.01, apply: dockParam('animDur') },
  // The slot placeholder — a framed window's held-open bar slot breathes an outline in the
  // window's identity hue (the hue itself is auto-generated, not a setting). 0 opacity hides it.
  { key: 'dock.ghostOpacity', label: 'Ghost opacity', group: 'Dock & frame', type: 'number', default: 0.55, min: 0, max: 1, step: 0.05, apply: dockParam('ghostOpacity') },
  { key: 'dock.ghostPulseHz', label: 'Ghost breathe (Hz)', group: 'Dock & frame', type: 'number', default: 0.5, min: 0, max: 4, step: 0.1, apply: dockParam('ghostPulseHz') },
  // The tile nameplate — an identity-hued Label3D parked past the tile's content edge, answering
  // "which tiny tile is which" by name. Sized in CELL ROWS of the tile's own text (the window's
  // chrome buttons are 1.5), so it scales with the content, not the slot box. labelFormat 'off'
  // hides nameplates outright; 'dims' shows only cols×rows (grids without dimensions fall back
  // to the name). Opacity/format push to every live plate; a format change rebakes them.
  { key: 'dock.labelLines', label: 'Label size (cell rows)', group: 'Dock & frame', type: 'number', default: 3, min: 1, max: 8, step: 0.5, apply: dockParam('labelLines') },
  { key: 'dock.labelGap', label: 'Label gap (plate heights)', group: 'Dock & frame', type: 'number', default: 0.3, min: 0, max: 2, step: 0.05, apply: dockParam('labelGap') },
  { key: 'dock.labelOpacity', label: 'Label opacity', group: 'Dock & frame', type: 'number', default: 0.85, min: 0, max: 1, step: 0.05, apply: dockParam('labelOpacity') },
  { key: 'dock.labelPosition', label: 'Label position', group: 'Dock & frame', type: 'enum', options: ['below', 'above'], default: 'below', apply: dockParam('labelPosition') },
  { key: 'dock.labelFormat', label: 'Label text', group: 'Dock & frame', type: 'enum', options: ['name+dims', 'name', 'dims', 'off'], default: 'name+dims', apply: dockParam('labelFormat') },
  // Frame — the root VIEW-FRAME a pinned/spotlit window contain-fits into (camera-front, the
  // "window-pane" the canvas frames). All frustum-normalized, so the pinned window tracks the
  // drawing-frame size live. Width/height size the pane (1 = full canvas); X/Y offset it
  // (left/right/2-3 panes); the four per-side margins inset it — asymmetric margins shrink AND
  // re-center the pane (hand-placement); pull-in draws it toward the eye so it renders over the
  // bar. (Subframes will partition this same rect later.)
  { key: 'frame.width', label: 'Frame width', group: 'Dock & frame', type: 'number', default: 1, min: 0.2, max: 1, step: 0.02, apply: dockParam('frameW') },
  { key: 'frame.height', label: 'Frame height', group: 'Dock & frame', type: 'number', default: 1, min: 0.2, max: 1, step: 0.02, apply: dockParam('frameH') },
  { key: 'frame.x', label: 'Frame X offset', group: 'Dock & frame', type: 'number', default: 0, min: -1, max: 1, step: 0.02, apply: dockParam('frameX') },
  { key: 'frame.y', label: 'Frame Y offset', group: 'Dock & frame', type: 'number', default: 0, min: -1, max: 1, step: 0.02, apply: dockParam('frameY') },
  { key: 'frame.marginLeft', label: 'Margin left', group: 'Dock & frame', type: 'number', default: 0.06, min: 0, max: 0.49, step: 0.01, apply: dockParam('frameMarginLeft') },
  { key: 'frame.marginRight', label: 'Margin right', group: 'Dock & frame', type: 'number', default: 0.06, min: 0, max: 0.49, step: 0.01, apply: dockParam('frameMarginRight') },
  { key: 'frame.marginTop', label: 'Margin top', group: 'Dock & frame', type: 'number', default: 0.06, min: 0, max: 0.49, step: 0.01, apply: dockParam('frameMarginTop') },
  { key: 'frame.marginBottom', label: 'Margin bottom', group: 'Dock & frame', type: 'number', default: 0.06, min: 0, max: 0.49, step: 0.01, apply: dockParam('frameMarginBottom') },
  { key: 'frame.depth', label: 'Frame pull-in', group: 'Dock & frame', type: 'number', default: 0.7, min: 0.3, max: 1, step: 0.02, apply: dockParam('frameDistFrac') },
  // Carrel — the world-anchored reading desks. Applied to every live desk AND picked up
  // as the defaults for new ones (carrel.create); carrel.set <name> tunes one desk.
  { key: 'carrel.radius', label: 'Ring radius', group: 'Carrel', type: 'number', default: 240, min: 20, max: 2000, step: 10, apply: carrelParam('radius') },
  { key: 'carrel.boxH', label: 'Seat size', group: 'Carrel', type: 'number', default: 110, min: 20, max: 600, step: 5, apply: carrelParam('boxH') },
  { key: 'carrel.boxAspect', label: 'Seat aspect (w:h)', group: 'Carrel', type: 'number', default: 1.15, min: 0.5, max: 3, step: 0.05, apply: carrelParam('boxAspect') },
  { key: 'carrel.gapFrac', label: 'Item spacing', group: 'Carrel', type: 'number', default: 0.9, min: 0, max: 2, step: 0.05, apply: carrelParam('gapFrac') },
  { key: 'carrel.growCap', label: 'Fit growth cap', group: 'Carrel', type: 'number', default: 1.25, min: 1, max: 4, step: 0.05, apply: carrelParam('growCap') },
  { key: 'carrel.maxArcDeg', label: 'Ring arc span°', group: 'Carrel', type: 'number', default: 300, min: 60, max: 360, step: 5, apply: carrelParam('maxArcDeg') },
  { key: 'carrel.tableFrac', label: 'Shadow overhang', group: 'Carrel', type: 'number', default: 1.25, min: 1, max: 2, step: 0.05, apply: carrelParam('tableFrac') },
  { key: 'carrel.shadowSoft', label: 'Shadow edge softness', group: 'Carrel', type: 'number', default: 0.35, min: 0, max: 1, step: 0.05, apply: carrelParam('shadowSoft') },
  { key: 'carrel.glowStrength', label: 'Glow strength', group: 'Carrel', type: 'number', default: 0.35, min: 0, max: 2, step: 0.05, apply: carrelParam('glowStrength') },
  // Culling — hardware occlusion-query culling (three's native occlusionTest). A candidate
  // fully behind the OPAQUE occluder set (1.0 page faces, panels) stops drawing after
  // `hold` consecutive occluded frames; the first visible sample brings it back at once.
  // Experimental — off by default while the win is being measured (cull.stats).
  { key: 'cull.enabled', label: 'Occlusion culling', group: 'Culling & loading', type: 'bool', default: false, apply: (ctx, v) => ctx.occlusionCuller?.setEnabled?.(v) },
  { key: 'cull.holdFrames', label: 'Cull after (frames dark)', group: 'Culling & loading', type: 'number', default: 8, min: 1, max: 120, step: 1, apply: (ctx, v) => { if (ctx.occlusionCuller) ctx.occlusionCuller.holdFrames = v; } },
  // Live readout (type 'info' — not a knob): who is dark right now. The pulse that
  // keeps the feature from being forgotten; cull.stats is the verb-side twin.
  {
    key: 'cull.dark', label: 'Dark right now', group: 'Culling & loading', type: 'info',
    read: (ctx) => {
      const s = ctx?.occlusionCuller?.stats?.();
      return s ? `${s.culled.length} / ${s.tracked}${s.enabled ? '' : '  (off)'}` : '—';
    },
  },
  // The A/B instrument: submission cost, live. Toggle culling and watch this number —
  // if it drops hard and the framerate doesn't, the frame is fragment-bound (translucent
  // chrome / visible glyph shading), not submission-bound, and the next lever is overdraw.
  {
    key: 'cull.calls', label: 'Draw calls / frame', group: 'Culling & loading', type: 'info',
    read: (ctx) => {
      const r = ctx?.renderer?.info?.render;
      const n = r ? (r.drawCalls ?? r.calls) : null;
      return n != null ? String(n) : '—';
    },
  },
  // Tree — the ContentTree ownership-line overlay (hub → what it contains). File lines
  // and directory lines toggle independently; layout.arrows is the master on/off verb.
  {
    key: 'tree.fileLines', label: 'File ownership lines', group: 'Tree & labels', type: 'bool', default: true,
    apply: (ctx, v) => ctx.contentTreeArrows?.setShowFiles?.(v),
  },
  {
    key: 'tree.dirLines', label: 'Directory ownership lines', group: 'Tree & labels', type: 'bool', default: true,
    apply: (ctx, v) => ctx.contentTreeArrows?.setShowDirs?.(v),
  },
  // Wire stroke: world-unit thickness at the shallowest level, decaying per visible
  // depth (shallow trunks heavy, deep leaves fine). 0 = the 1px hairline form.
  {
    key: 'tree.wireWeight', label: 'Wire stroke (world units, 0=hairline)', group: 'Tree & labels',
    type: 'number', default: ARROW_DEFAULTS.weight, min: 0, max: 200, step: 0.1,
    apply: (ctx, v) => ctx.contentTreeArrows?.configure({ weight: v }),
  },
  {
    key: 'tree.wireWeightDecay', label: 'Wire stroke decay (× per depth)', group: 'Tree & labels',
    type: 'number', default: ARROW_DEFAULTS.weightDecay, min: 0.1, max: 2, step: 0.05,
    apply: (ctx, v) => ctx.contentTreeArrows?.configure({ weightDecay: v }),
  },
  {
    key: 'tree.wireOpacity', label: 'Wire opacity', group: 'Tree & labels',
    type: 'number', default: ARROW_DEFAULTS.opacity, min: 0, max: 1, step: 0.02,
    apply: (ctx, v) => ctx.contentTreeArrows?.configure({ opacity: v }),
  },
  {
    key: 'tree.wireBusMargin', label: 'Trace bus margin (outside the frame)', group: 'Tree & labels',
    type: 'number', default: ARROW_DEFAULTS.busMargin, min: 0, max: 1000, step: 1,
    apply: (ctx, v) => ctx.contentTreeArrows?.configure({ busMargin: v }),
  },
  {
    key: 'tree.wireRailGap', label: 'Trace rail gap (above each pin)', group: 'Tree & labels',
    type: 'number', default: ARROW_DEFAULTS.railGap, min: 0, max: 1000, step: 0.5,
    apply: (ctx, v) => ctx.contentTreeArrows?.configure({ railGap: v }),
  },
  {
    key: 'tree.wireChamfer', label: 'Trace corner chamfer (45°, 0=sharp)', group: 'Tree & labels',
    type: 'number', default: ARROW_DEFAULTS.chamfer, min: 0, max: 500, step: 0.5,
    apply: (ctx, v) => ctx.contentTreeArrows?.configure({ chamfer: v }),
  },
  {
    key: 'tree.wirePads', label: 'Pin pads', group: 'Tree & labels', type: 'bool', default: !!ARROW_DEFAULTS.pads,
    apply: (ctx, v) => ctx.contentTreeArrows?.configure({ pads: v ? 1 : 0 }),
  },
  {
    key: 'tree.wirePadScale', label: 'Pad size (× stroke)', group: 'Tree & labels',
    type: 'number', default: ARROW_DEFAULTS.padScale, min: 0.2, max: 20, step: 0.1,
    apply: (ctx, v) => ctx.contentTreeArrows?.configure({ padScale: v }),
  },
  // Labels — the container labels (ContentTreeLabels): every visible directory named in space.
  // The same dials as the layout.labels verb; every change lands live and persists. Sizing is
  // the container FIT (the name spans `fit` of its container's width, clamped by the scale
  // floor/cap); the approach SPECTRUM eases opacity AND text size from the resting values to
  // the arrived ones across the fade band, so a name melts to a readable name tag as you fly
  // in instead of popping out — arrived values of 0 restore the vanish. The hover pair drives
  // the ancestor-chain grow. Ranges are deliberately wide — the operator decides what's
  // "too big". Defaults mirror LABEL_DEFAULTS.
  {
    key: 'labels.enabled', label: 'Container labels', group: 'Tree & labels', type: 'bool', default: true,
    apply: (ctx, v) => ctx.contentTreeLabels?.setEnabled?.(v),
  },
  { key: 'labels.fit', label: 'Name fit (× container width)', group: 'Tree & labels', type: 'number', default: LABEL_DEFAULTS.fit, min: 0.05, max: 2, step: 0.05, apply: labelParam('fit') },
  { key: 'labels.scaleMin', label: 'Glyph scale floor', group: 'Tree & labels', type: 'number', default: LABEL_DEFAULTS.scaleMin, min: 0.05, max: 100, step: 0.05, apply: labelParam('scaleMin') },
  { key: 'labels.scaleMax', label: 'Glyph scale cap', group: 'Tree & labels', type: 'number', default: LABEL_DEFAULTS.scaleMax, min: 0.5, max: 500, step: 0.5, apply: labelParam('scaleMax') },
  {
    key: 'labels.showCount', label: 'Stat line (N files)', group: 'Tree & labels', type: 'bool', default: !!LABEL_DEFAULTS.showCount,
    apply: (ctx, v) => ctx.contentTreeLabels?.configure({ showCount: v ? 1 : 0 }),
  },
  { key: 'labels.countScale', label: 'Stat line size (× name)', group: 'Tree & labels', type: 'number', default: LABEL_DEFAULTS.countScale, min: 0.05, max: 2, step: 0.05, apply: labelParam('countScale') },
  {
    key: 'labels.showFiles', label: 'Book labels (file names)', group: 'Tree & labels', type: 'bool', default: !!LABEL_DEFAULTS.showFiles,
    apply: (ctx, v) => ctx.contentTreeLabels?.configure({ showFiles: v ? 1 : 0 }),
  },
  {
    key: 'labels.plate', label: 'Backplate', group: 'Tree & labels', type: 'bool', default: !!LABEL_DEFAULTS.plate,
    apply: (ctx, v) => ctx.contentTreeLabels?.configure({ plate: v ? 1 : 0 }),
  },
  { key: 'labels.plateColor', label: 'Backplate color', group: 'Tree & labels', type: 'color', default: '#' + LABEL_DEFAULTS.plateColor.toString(16).padStart(6, '0'), apply: labelParam('plateColor', true) },
  { key: 'labels.plateOpacity', label: 'Backplate opacity', group: 'Tree & labels', type: 'number', default: LABEL_DEFAULTS.plateOpacity, min: 0, max: 1, step: 0.02, apply: labelParam('plateOpacity') },
  { key: 'labels.platePad', label: 'Backplate margin (× row)', group: 'Tree & labels', type: 'number', default: LABEL_DEFAULTS.platePad, min: 0, max: 3, step: 0.05, apply: labelParam('platePad') },
  { key: 'labels.turnEase', label: 'Turn settle rate (1/s)', group: 'Tree & labels', type: 'number', default: LABEL_DEFAULTS.turnEase, min: 0.5, max: 60, step: 0.5, apply: labelParam('turnEase') },
  { key: 'labels.turnDip', label: 'Turn dip (× alpha, 1=off)', group: 'Tree & labels', type: 'number', default: LABEL_DEFAULTS.turnDip, min: 0, max: 1, step: 0.05, apply: labelParam('turnDip') },
  { key: 'labels.turnPop', label: 'Turn pop (× scale, 1=off)', group: 'Tree & labels', type: 'number', default: LABEL_DEFAULTS.turnPop, min: 0.2, max: 1, step: 0.02, apply: labelParam('turnPop') },
  { key: 'labels.hoverBoost', label: 'Hover grow (×)', group: 'Tree & labels', type: 'number', default: LABEL_DEFAULTS.hoverBoost, min: 0.1, max: 10, step: 0.1, apply: labelParam('hoverBoost') },
  { key: 'labels.hoverEase', label: 'Hover grow rate (1/s)', group: 'Tree & labels', type: 'number', default: LABEL_DEFAULTS.hoverEase, min: 0.5, max: 60, step: 0.5, apply: labelParam('hoverEase') },
  { key: 'labels.opacity', label: 'Opacity (resting)', group: 'Tree & labels', type: 'number', default: LABEL_DEFAULTS.opacity, min: 0, max: 1, step: 0.02, apply: labelParam('opacity') },
  { key: 'labels.minAlpha', label: 'Opacity (arrived)', group: 'Tree & labels', type: 'number', default: LABEL_DEFAULTS.minAlpha, min: 0, max: 1, step: 0.02, apply: labelParam('minAlpha') },
  { key: 'labels.nearScale', label: 'Text size (arrived)', group: 'Tree & labels', type: 'number', default: LABEL_DEFAULTS.nearScale, min: 0, max: 48, step: 0.1, apply: labelParam('nearScale') },
  { key: 'labels.fadeStart', label: 'Approach fade starts (dist)', group: 'Tree & labels', type: 'number', default: LABEL_DEFAULTS.fadeStart, min: 0, max: 4000, step: 10, apply: labelParam('fadeStart') },
  { key: 'labels.fadeEnd', label: 'Approach fade full (dist)', group: 'Tree & labels', type: 'number', default: LABEL_DEFAULTS.fadeEnd, min: 0, max: 2000, step: 10, apply: labelParam('fadeEnd') },
  { key: 'labels.gapY', label: 'Lift above container (× row)', group: 'Tree & labels', type: 'number', default: LABEL_DEFAULTS.gapY, min: 0, max: 10, step: 0.05, apply: labelParam('gapY') },
  { key: 'labels.zLift', label: 'Lift toward viewer (z)', group: 'Tree & labels', type: 'number', default: LABEL_DEFAULTS.zLift, min: 0, max: 500, step: 1, apply: labelParam('zLift') },
  { key: 'labels.colorA', label: 'Name color (shallow)', group: 'Tree & labels', type: 'color', default: '#' + LABEL_DEFAULTS.colorA.toString(16).padStart(6, '0'), apply: labelParam('colorA', true) },
  { key: 'labels.colorB', label: 'Name color (deep)', group: 'Tree & labels', type: 'color', default: '#' + LABEL_DEFAULTS.colorB.toString(16).padStart(6, '0'), apply: labelParam('colorB', true) },
  // Loading — the streamed bulk build: a directory pop builds its grids in slices
  // under this per-frame budget (the camera stays live, the field arrives instead
  // of freezing); 0 = build everything in one tick (the old lockup, if you want it).
  {
    key: 'load.buildBudget', label: 'Load build budget (ms/frame, 0=one tick)', group: 'Culling & loading',
    type: 'number', default: 12, min: 0, max: 200, step: 1,
    apply: (ctx, v) => { ctx.loadBuildBudget = v; },
  },
  // Motion — the relayout glide (ContentTreeMotion): every re-lay eases the durable
  // nodes from where they were to where the scheme stamped them, on the house
  // exponential. Rate is the whole feel — higher snaps, lower floats; rotation slerps
  // along unless dialed off. Off restores the instant teleport.
  {
    key: 'motion.enabled', label: 'Relayout glide', group: 'Motion', type: 'bool', default: true,
    apply: (ctx, v) => ctx.contentTreeMotion?.setEnabled?.(v),
  },
  {
    key: 'motion.rate', label: 'Glide rate (1/s)', group: 'Motion',
    type: 'number', default: MOTION_DEFAULTS.rate, min: 0.2, max: 60, step: 0.2,
    apply: (ctx, v) => ctx.contentTreeMotion?.configure({ rate: v }),
  },
  {
    key: 'motion.rotate', label: 'Glide rotation too', group: 'Motion', type: 'bool', default: !!MOTION_DEFAULTS.rotate,
    apply: (ctx, v) => ctx.contentTreeMotion?.configure({ rotate: v ? 1 : 0 }),
  },
  // Layout — the jellyfish CStack scheme: a directory becomes one TALL cylindrical COLUMN whose
  // surface is tiled by panels (files shelf-packed into bounded tiles). Every dial re-lays the
  // field live while jellyfish is the active scheme (else it persists and seeds on next activation
  // — schemeSettingsOpts). `scheme: 'jellyfish'` marks a knob as that scheme's persisted opt.
  //   targetRadius — the column's WIDTH preference (how many panels sit abreast around the rim).
  //   panelW/panelH — a panel TILE's bound; keep SMALL vs targetRadius (big files → few fat faces =
  //                   blocky; tiny files → many small faces = mosaic). Oversized grids get a solo tile.
  // Ranges are deliberately wide (the operator decides what's "too big"); defaults mirror JELLYFISH_DEFAULTS.
  { key: 'layout.warpPanels', label: 'Warp panels around core', group: 'Layout', scheme: 'jellyfish', type: 'bool', default: JELLYFISH_DEFAULTS.warpPanels, apply: jellyfishParam('warpPanels') },
  { key: 'layout.targetRadius', label: 'Column radius (width)', group: 'Layout', scheme: 'jellyfish', type: 'number', default: JELLYFISH_DEFAULTS.targetRadius, min: 40, max: 4000, step: 10, apply: jellyfishParam('targetRadius') },
  { key: 'layout.panelW', label: 'Panel max width', group: 'Layout', scheme: 'jellyfish', type: 'number', default: JELLYFISH_DEFAULTS.panelW, min: 40, max: 3000, step: 10, apply: jellyfishParam('panelW') },
  { key: 'layout.panelH', label: 'Panel max height', group: 'Layout', scheme: 'jellyfish', type: 'number', default: JELLYFISH_DEFAULTS.panelH, min: 40, max: 4000, step: 10, apply: jellyfishParam('panelH') },
  { key: 'layout.panelGap', label: 'Panel stack gap (down a face)', group: 'Layout', scheme: 'jellyfish', type: 'number', default: JELLYFISH_DEFAULTS.panelGap, min: 0, max: 400, step: 2, apply: jellyfishParam('panelGap') },
  { key: 'layout.faceGap', label: 'Face gap (around the rim)', group: 'Layout', scheme: 'jellyfish', type: 'number', default: JELLYFISH_DEFAULTS.faceGap, min: 0, max: 2, step: 0.02, apply: jellyfishParam('faceGap') },
  { key: 'layout.colGap', label: 'Grid gap within a row', group: 'Layout', scheme: 'jellyfish', type: 'number', default: JELLYFISH_DEFAULTS.colGap, min: 0, max: 400, step: 2, apply: jellyfishParam('colGap') },
  { key: 'layout.rowGap', label: 'Row gap within a panel', group: 'Layout', scheme: 'jellyfish', type: 'number', default: JELLYFISH_DEFAULTS.rowGap, min: 0, max: 400, step: 2, apply: jellyfishParam('rowGap') },
  { key: 'layout.drop', label: 'Child column drop (−Y)', group: 'Layout', scheme: 'jellyfish', type: 'number', default: JELLYFISH_DEFAULTS.drop, min: 0, max: 4000, step: 10, apply: jellyfishParam('drop') },
  { key: 'layout.childGap', label: 'Child ring spacing', group: 'Layout', scheme: 'jellyfish', type: 'number', default: JELLYFISH_DEFAULTS.childGap, min: 0, max: 4, step: 0.05, apply: jellyfishParam('childGap') },
  { key: 'layout.hubRadius', label: 'Hub radius (min)', group: 'Layout', scheme: 'jellyfish', type: 'number', default: JELLYFISH_DEFAULTS.hubRadius, min: 0, max: 1000, step: 5, apply: jellyfishParam('hubRadius') },
  { key: 'layout.minRadius', label: 'Min radius floor', group: 'Layout', scheme: 'jellyfish', type: 'number', default: JELLYFISH_DEFAULTS.minRadius, min: 0, max: 1000, step: 5, apply: jellyfishParam('minRadius') },
  //   Panel surface — the backing FACE a panel's fields mount onto (a plane for flat panels, a
  //   matching cylinder segment when warped), so a column reads as a solid faceted cylinder.
  { key: 'layout.surface', label: 'Panel surface (face)', group: 'Layout', scheme: 'jellyfish', type: 'bool', default: JELLYFISH_DEFAULTS.surface, apply: jellyfishParam('surface') },
  { key: 'layout.surfaceColor', label: 'Surface color', group: 'Layout', scheme: 'jellyfish', type: 'color', default: '#' + JELLYFISH_DEFAULTS.surfaceColor.toString(16).padStart(6, '0'), apply: jellyfishParam('surfaceColor') },
  { key: 'layout.surfaceOpacity', label: 'Surface opacity', group: 'Layout', scheme: 'jellyfish', type: 'number', default: JELLYFISH_DEFAULTS.surfaceOpacity, min: 0, max: 1, step: 0.02, apply: jellyfishParam('surfaceOpacity') },
  { key: 'layout.surfaceDepth', label: 'Surface set-back (behind fields)', group: 'Layout', scheme: 'jellyfish', type: 'number', default: JELLYFISH_DEFAULTS.surfaceDepth, min: 0, max: 200, step: 1, apply: jellyfishParam('surfaceDepth') },
  { key: 'layout.surfacePad', label: 'Surface margin (past fields)', group: 'Layout', scheme: 'jellyfish', type: 'number', default: JELLYFISH_DEFAULTS.surfacePad, min: 0, max: 200, step: 1, apply: jellyfishParam('surfacePad') },
  { key: 'layout.surfaceSegments', label: 'Surface arc segments (warped)', group: 'Layout', scheme: 'jellyfish', type: 'number', default: JELLYFISH_DEFAULTS.surfaceSegments, min: 2, max: 64, step: 1, apply: jellyfishParam('surfaceSegments') },
  { key: 'layout.surfaceBorder', label: 'Surface rim', group: 'Layout', scheme: 'jellyfish', type: 'bool', default: JELLYFISH_DEFAULTS.surfaceBorder, apply: jellyfishParam('surfaceBorder') },
  { key: 'layout.surfaceBorderColor', label: 'Surface rim color', group: 'Layout', scheme: 'jellyfish', type: 'color', default: '#' + JELLYFISH_DEFAULTS.surfaceBorderColor.toString(16).padStart(6, '0'), apply: jellyfishParam('surfaceBorderColor') },
  // Layout — the library scheme: every file contain-fit onto one uniform page (a BOOK), a
  // directory's books stacked in sorted order at a tight distance. The stack axis and sort
  // are enum knobs and live on the verb (layout.scheme library --stack x --sort size); the
  // surface* dials above are keyed to jellyfish, so the page face is dialed the same way.
  { key: 'layout.pageW', label: 'Page width (book)', group: 'Layout', scheme: 'library', type: 'number', default: LIBRARY_DEFAULTS.pageW, min: 100, max: 4000, step: 20, apply: libraryParam('pageW') },
  { key: 'layout.pageH', label: 'Page height (book)', group: 'Layout', scheme: 'library', type: 'number', default: LIBRARY_DEFAULTS.pageH, min: 100, max: 4000, step: 20, apply: libraryParam('pageH') },
  { key: 'layout.gap', label: 'Book spacing (stack step)', group: 'Layout', scheme: 'library', type: 'number', default: LIBRARY_DEFAULTS.gap, min: 2, max: 600, step: 2, apply: libraryParam('gap') },
  { key: 'layout.maxUpscale', label: 'Max fit upscale (small files)', group: 'Layout', scheme: 'library', type: 'number', default: LIBRARY_DEFAULTS.maxUpscale, min: 1, max: 20, step: 0.5, apply: libraryParam('maxUpscale') },
  { key: 'layout.reverse', label: 'Reverse stack order', group: 'Layout', scheme: 'library', type: 'bool', default: LIBRARY_DEFAULTS.reverse, apply: libraryParam('reverse') },
  // Glyph LOD — the exact-curve ↔ stable-block handoff for minified text (kills the moiré/flicker of
  // sub-pixel strokes). Footprints are fwidth(glyphUV): bigger = smaller on screen. Pull the lod*
  // band DOWN to hand off to the flicker-free block sooner (trades mid-distance crispness for
  // stability); raise it to keep exact curves longer. Tune live in motion; defaults mirror the shader.
  { key: 'glyph.dilatePx', label: 'Minify dilate (px)', group: 'Display & glyph LOD', type: 'number', default: GLYPH_LOD_DEFAULTS.dilatePx, min: 0, max: 3, step: 0.05, apply: lodParam('dilatePx') },
  { key: 'glyph.soften', label: 'Minify soften', group: 'Display & glyph LOD', type: 'number', default: GLYPH_LOD_DEFAULTS.soften, min: 0, max: 1, step: 0.05, apply: lodParam('soften') },
  { key: 'glyph.minLo', label: 'Fuzz onset (footprint)', group: 'Display & glyph LOD', type: 'number', default: GLYPH_LOD_DEFAULTS.minLo, min: 0.01, max: 0.5, step: 0.01, apply: lodParam('minLo') },
  { key: 'glyph.minHi', label: 'Fuzz full (footprint)', group: 'Display & glyph LOD', type: 'number', default: GLYPH_LOD_DEFAULTS.minHi, min: 0.02, max: 0.6, step: 0.01, apply: lodParam('minHi') },
  { key: 'glyph.lodLo', label: 'Block fade-in (footprint)', group: 'Display & glyph LOD', type: 'number', default: GLYPH_LOD_DEFAULTS.lodLo, min: 0.05, max: 0.9, step: 0.01, apply: lodParam('lodLo') },
  { key: 'glyph.lodHi', label: 'Block full (footprint)', group: 'Display & glyph LOD', type: 'number', default: GLYPH_LOD_DEFAULTS.lodHi, min: 0.1, max: 1.2, step: 0.01, apply: lodParam('lodHi') },
  { key: 'glyph.density', label: 'Block ink density', group: 'Display & glyph LOD', type: 'number', default: GLYPH_LOD_DEFAULTS.density, min: 0.005, max: 0.15, step: 0.005, apply: lodParam('density') },
  { key: 'glyph.maxCov', label: 'Block max coverage', group: 'Display & glyph LOD', type: 'number', default: GLYPH_LOD_DEFAULTS.maxCov, min: 0.1, max: 1, step: 0.02, apply: lodParam('maxCov') },
  { key: 'glyph.lodAxisBias', label: 'Block axis bias (0 best→1 worst)', group: 'Display & glyph LOD', type: 'number', default: GLYPH_LOD_DEFAULTS.lodAxisBias, min: 0, max: 1, step: 0.05, apply: lodParam('lodAxisBias') },
  // Agent Books — the agent shelf: page geometry, deck pitch, card scales, and retention (each
  // agent's run as a book of spreads). Every dial re-fits the live shelf via applyScales (cards
  // re-scale, sheets re-fit, over-cap sheets shed, the cluster re-flows). Ranges are deliberately
  // WIDE — a small positive min just keeps a value off 0/negative; the user, not us, decides
  // what's "too big". Defaults mirror AGENT_BOOKS_DEFAULTS.
  // No apply: the carrel sweep's auto-shelf pass reads this at each lane birth
  // (scheduleCarrelSweep) — toggled ON it also gathers existing unseated books on
  // the next agent event.
  { key: 'book.autoShelf', label: "Seat new books at the 'agents' desk", group: 'Agent Books', type: 'bool', default: true },
  { key: 'book.maxSheets', label: 'Turns kept per book (0 = all)', group: 'Agent Books', type: 'number', default: 20, min: 0, max: 5000, step: 1, apply: bookParam('maxSheets') },
  { key: 'book.pageW', label: 'Page width', group: 'Agent Books', type: 'number', default: 320, min: 10, max: 5000, step: 10, apply: bookParam('pageW') },
  { key: 'book.pageH', label: 'Page height', group: 'Agent Books', type: 'number', default: 420, min: 10, max: 5000, step: 10, apply: bookParam('pageH') },
  { key: 'book.gutter', label: 'Spread gutter (spine gap)', group: 'Agent Books', type: 'number', default: 24, min: 0, max: 500, step: 2, apply: bookParam('gutter') },
  { key: 'book.maxUpscale', label: 'Max content upscale', group: 'Agent Books', type: 'number', default: 3, min: 0.1, max: 100, step: 0.1, apply: bookParam('maxUpscale') },
  // Books — the SHARED page face, one config for every Book: agent books AND the
  // library's directory volumes (same carrier, same rendering; owners differ only in
  // state). At 1.0 a page is FULLY OPAQUE — the face material depth-writes, so full
  // alpha is a true occluder (the readability A/B AND the occlusion-culling occluder
  // set — large repos in library mode are where the render time lives). These fan out
  // to both shelves; the library also seeds them at activation (scheme:'library').
  { key: 'books.surface', label: 'Page faces', group: 'Agent Books', scheme: 'library', type: 'bool', default: true, apply: bookPageParam('face', 'surface') },
  { key: 'books.surfaceColor', label: 'Page color', group: 'Agent Books', scheme: 'library', type: 'color', default: '#0a0a1e', apply: bookPageParam('faceColor', 'surfaceColor') },
  { key: 'books.surfaceOpacity', label: 'Page opacity', group: 'Agent Books', scheme: 'library', type: 'number', default: 0.85, min: 0, max: 1, step: 0.05, apply: bookPageParam('faceOpacity', 'surfaceOpacity') },
  { key: 'book.zPitch', label: 'Sheet depth spacing (Z)', group: 'Agent Books', type: 'number', default: 90, min: 1, max: 4000, step: 5, apply: bookParam('zPitch') },
  { key: 'book.pagerLerp', label: 'Page-turn speed', group: 'Agent Books', type: 'number', default: 9, min: 0, max: 60, step: 0.5, apply: bookParam('pagerLerp') },
  { key: 'book.callScale', label: 'Headline card size', group: 'Agent Books', type: 'number', default: 3.0, min: 0.05, max: 50, step: 0.1, apply: bookParam('callScale') },
  { key: 'book.infoScale', label: 'Info card size', group: 'Agent Books', type: 'number', default: 1.5, min: 0.05, max: 50, step: 0.05, apply: bookParam('infoScale') },
  { key: 'book.artifactWorldScale', label: 'Snapshot / output size', group: 'Agent Books', type: 'number', default: 0.025, min: 0.001, max: 5, step: 0.005, apply: bookParam('artifactWorldScale') },
  { key: 'book.messageScale', label: 'Message (say / think) size', group: 'Agent Books', type: 'number', default: 0.05, min: 0.001, max: 5, step: 0.005, apply: bookParam('messageScale') },
  { key: 'book.snapshotImageWidth', label: 'Image page width', group: 'Agent Books', type: 'number', default: 40, min: 1, max: 2000, step: 5, apply: bookParam('snapshotImageWidth') },
  // Strata — the nested Z-depth structure view (structure.strata). Every dial is LIVE: a
  // change re-applies to the on-screen strata immediately (boxOpacity rides a shader uniform;
  // the rest re-derive positions/boxes). Borders should recede behind the glyphs — drop
  // opacity/brightness for subtler, raise zStep to fan the depth planes further apart.
  { key: 'strata.boxOpacity', label: 'Border opacity', group: 'Strata', type: 'number', default: STRATA_DEFAULTS.boxOpacity, min: 0, max: 1, step: 0.02, apply: strataParam('boxOpacity') },
  { key: 'strata.boxBrightness', label: 'Border brightness', group: 'Strata', type: 'number', default: STRATA_DEFAULTS.boxBrightness, min: 0, max: 2, step: 0.05, apply: strataParam('boxBrightness') },
  { key: 'strata.zStepFactor', label: 'Depth step (× line)', group: 'Strata', type: 'number', default: STRATA_DEFAULTS.zStepFactor, min: 0, max: 8, step: 0.1, apply: strataParam('zStepFactor') },
  { key: 'strata.padFactor', label: 'Box padding (× line)', group: 'Strata', type: 'number', default: STRATA_DEFAULTS.padFactor, min: 0, max: 2, step: 0.05, apply: strataParam('padFactor') },
  { key: 'strata.clipLeadingWhitespace', label: 'Clip leading whitespace', group: 'Strata', type: 'bool', default: STRATA_DEFAULTS.clipLeadingWhitespace, apply: strataParam('clipLeadingWhitespace') },
  { key: 'strata.minSlots', label: 'Min glyphs per box', group: 'Strata', type: 'number', default: STRATA_DEFAULTS.minSlots, min: 1, max: 40, step: 1, apply: strataParam('minSlots') },
  { key: 'strata.maxDepth', label: 'Max nesting depth', group: 'Strata', type: 'number', default: STRATA_DEFAULTS.maxDepth, min: 1, max: 64, step: 1, apply: strataParam('maxDepth') },
];

/** Push a background restyle to every live grid/terminal of `type`. */
function themeAll(ctx, type, style) {
  for (const e of ctx?.registry?.findByType?.(type) ?? []) e.grid?.setBackgroundStyle?.(style);
}

/** Push a cursor-block restyle to every live terminal (color / focused fill / hollow outline). */
function cursorStyleAll(ctx, style) {
  for (const e of ctx?.registry?.findByType?.('terminal') ?? []) e.grid?.setCursorStyle?.(style);
}

/** The interaction color vocabulary (focus/hover/input) as '#rrggbb' strings. Cached so the per-frame
 *  directory overlay can read it without hitting storage; applyStateColors() mutates it in place. */
let _interaction = null;
export function interactionTheme() {
  if (!_interaction) _interaction = {
    focus: getSetting('appearance.focusColor'),
    hover: getSetting('appearance.hoverColor'),
    input: getSetting('appearance.inputColor'),
  };
  return _interaction;
}

/** Push the configured state colors to every surface that wears them: the cache the overlay reads,
 *  the default new panels are born with, and every live panel's in-shader border. One vocabulary. */
function applyStateColors(ctx) {
  const c = {
    focus: getSetting('appearance.focusColor'),
    hover: getSetting('appearance.hoverColor'),
    input: getSetting('appearance.inputColor'),
    capture: getSetting('appearance.captureColor'),
  };
  if (_interaction) Object.assign(_interaction, c); else _interaction = { ...c };
  setPanelStateColorDefaults(c);
  for (const type of ['grid', 'terminal'])
    for (const e of ctx?.registry?.findByType?.(type) ?? []) e.grid?.setStateColors?.(c);
}

/** Background options for a NEW CodeGrid — so it spawns in the current scheme. */
export function gridTheme() {
  return {
    backgroundColor: getSetting('grid.backgroundColor'),
    backgroundOpacity: getSetting('grid.backgroundOpacity'),
    windowMinBytes: getSetting('grid.windowMinBytes'),
    windowRows: getSetting('grid.windowRows'),
    windowMarginRows: getSetting('grid.windowMarginRows'),
  };
}

/** Background + cursor options for a NEW TerminalGrid — so it spawns in the current scheme. */
export function terminalTheme() {
  return {
    backgroundColor: getSetting('terminal.backgroundColor'),
    backgroundOpacity: getSetting('terminal.backgroundOpacity'),
    cursorColor: getSetting('terminal.cursorColor'),
    cursorFillOpacity: getSetting('terminal.cursorFill'),
    cursorBorderWidth: getSetting('terminal.cursorOutline'),
  };
}

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

export function settingDef(key) { return BY_KEY.get(key) || null; }

/** Coerce a raw (stored or user-typed) value to the def's type + clamp numbers. */
export function coerce(def, raw) {
  if (def.type === 'bool') return raw === true || raw === 'true';
  if (def.type === 'color') return typeof raw === 'string' && raw ? raw : def.default;
  if (def.type === 'enum') return def.options?.includes(raw) ? raw : def.default;
  if (def.type === 'number') {
    let n = typeof raw === 'number' ? raw : parseFloat(raw);
    if (Number.isNaN(n)) n = def.default;
    if (def.min != null) n = Math.max(def.min, n);
    if (def.max != null) n = Math.min(def.max, n);
    return n;
  }
  return raw;
}

/** Current value: stored (StateController) if set, else the default — coerced. */
export function getSetting(key) {
  const def = BY_KEY.get(key);
  if (!def) return undefined;
  return coerce(def, stateController.get(key, def.default));
}

/** Persist a setting and apply it live (a no-op live for reload-required knobs). */
export function setSetting(ctx, key, value) {
  const def = BY_KEY.get(key);
  if (!def) return { ok: false, error: `unknown setting "${key}"` };
  const v = coerce(def, value);
  stateController.set(key, v);
  def.apply?.(ctx, v);
  return { ok: true, value: v, reload: !!def.reload };
}

/**
 * The persisted opt overrides for a layout SCHEME — every setting tagged `scheme: <name>` whose
 * value differs from its default, keyed by the bare opt name (the key's suffix). This is how the
 * Settings panel feeds the layout scheme: the layout.scheme verb seeds a freshly-named scheme's
 * opts from here, so naming `jellyfish` picks up the dials the panel shows (inline --flags still
 * override). Only non-default values are returned, so the opt set stays minimal.
 * @param {string} scheme @returns {Object} { optName: value }
 */
export function schemeSettingsOpts(scheme) {
  const out = {};
  for (const def of SETTINGS) {
    if (def.scheme !== scheme) continue;
    const v = getSetting(def.key);
    if (v !== def.default) out[def.key.split('.').pop()] = v;
  }
  return out;
}

/**
 * Apply every stored (or default) setting in a group to its subsystem. The per-knob
 * apply()s otherwise fire only on a user change, so a persisted value would sit unused
 * until touched; call this once the subsystem exists (e.g. the dock, post-construction)
 * to fold the stored values in at boot. Skips reload-required (boot-baked) knobs.
 * @param {Object} ctx @param {string} group
 */
export function applyGroupSettings(ctx, group) {
  for (const def of SETTINGS) {
    if (def.group === group && !def.reload) def.apply?.(ctx, getSetting(def.key));
  }
}

/** Drop all stored settings (back to defaults) and re-apply the live ones. */
export function resetSettings(ctx) {
  let reloadNeeded = false;
  for (const def of SETTINGS) {
    if (def.reload && getSetting(def.key) !== def.default) reloadNeeded = true;
    stateController.delete(def.key);
    def.apply?.(ctx, def.default);
  }
  return { reloadNeeded };
}

/** Reset ONE setting to its default — drop the stored value, re-apply the default live. */
export function resetSetting(ctx, key) {
  const def = BY_KEY.get(key);
  if (!def) return { ok: false, error: `unknown setting "${key}"` };
  const reloadNeeded = !!def.reload && getSetting(key) !== def.default;
  stateController.delete(key);
  def.apply?.(ctx, def.default);
  return { ok: true, value: def.default, reload: !!def.reload, reloadNeeded };
}

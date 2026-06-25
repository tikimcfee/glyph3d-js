import { stateController } from '@glyph3d/core/services/state';
import { setPanelStateColorDefaults } from '@glyph3d/core/collections';

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

/** apply() for a window-control knob: store it on ctx.windowConfig (the bare param name,
 *  not the `window.` key). Read by the window.pin verb and the size/scale dial handler. */
const windowParam = (param) => (ctx, v) => { (ctx.windowConfig ||= {})[param] = v; };

export const SETTINGS = [
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
  // View — high-level view primitives (HUD overlays). No live apply(): main.jsx mounts/
  // unmounts the widget off the persisted value via StateController's state-changed event.
  {
    key: 'view.minimap', label: 'Minimap overview', group: 'View',
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
    key: 'atlas.fontSize', label: 'Font size (px)', group: 'Display',
    type: 'number', default: 48, min: 16, max: 96, step: 1, reload: true,
  },
  {
    key: 'atlas.size', label: 'Atlas texture (px)', group: 'Display',
    type: 'number', default: 2048, min: 512, max: 8192, step: 512, reload: true,
  },
  {
    key: 'relay.autoConnect', label: 'Auto-connect to relay on load', group: 'Connection',
    type: 'bool', default: true,
  },
  // Theme — surface backgrounds. Color is a '#rrggbb' string (THREE.Color eats it
  // directly); opacity drives stacked-tile readability in a dock. apply() restyles
  // every live grid/terminal; new ones inherit via gridTheme()/terminalTheme().
  {
    key: 'grid.backgroundColor', label: 'Code background', group: 'Theme',
    type: 'color', default: '#1a1a2e',
    apply: (ctx, v) => themeAll(ctx, 'grid', { color: v }),
  },
  {
    key: 'grid.backgroundOpacity', label: 'Code background opacity', group: 'Theme',
    type: 'number', default: 0.92, min: 0, max: 1, step: 0.01,
    apply: (ctx, v) => themeAll(ctx, 'grid', { opacity: v }),
  },
  {
    key: 'terminal.backgroundColor', label: 'Terminal background', group: 'Theme',
    type: 'color', default: '#0a0a1e',
    apply: (ctx, v) => themeAll(ctx, 'terminal', { color: v }),
  },
  {
    key: 'terminal.backgroundOpacity', label: 'Terminal background opacity', group: 'Theme',
    type: 'number', default: 0.96, min: 0, max: 1, step: 0.01,
    apply: (ctx, v) => themeAll(ctx, 'terminal', { opacity: v }),
  },
  // Appearance — the interaction color vocabulary (focus / hover / edit-input). ONE source of truth,
  // shared by the in-shader panel border (every grid/terminal) AND the directory overlay, so the two
  // never drift. apply() restyles every live panel + sets the default new panels are born with; the
  // overlay reads the same values via interactionTheme().
  {
    key: 'appearance.focusColor', label: 'Focus', group: 'Appearance',
    type: 'color', default: '#6ee7a0', apply: (ctx) => applyStateColors(ctx),
  },
  {
    key: 'appearance.hoverColor', label: 'Hover', group: 'Appearance',
    type: 'color', default: '#9fd2ff', apply: (ctx) => applyStateColors(ctx),
  },
  {
    key: 'appearance.inputColor', label: 'Edit / input', group: 'Appearance',
    type: 'color', default: '#f0b45a', apply: (ctx) => applyStateColors(ctx),
  },
  // Dock — the camera-locked tile bar (CameraDock). Every knob here was a baked
  // constant; setParam re-packs the live dock and the value persists client-side.
  // maxColumns + the dome arc/rise only bite in the RADIAL layout; fillFrac only in
  // LINEAR. Layout itself stays the `dock.layout` verb + session state, not a setting.
  { key: 'dock.distance', label: 'Distance', group: 'Dock', type: 'number', default: 10, min: 5, max: 120, step: 1, apply: dockParam('distance') },
  { key: 'dock.boxFrac', label: 'Tile size', group: 'Dock', type: 'number', default: 0.1, min: 0.05, max: 0.5, step: 0.01, apply: dockParam('boxFrac') },
  { key: 'dock.boxAspect', label: 'Tile aspect (w:h)', group: 'Dock', type: 'number', default: 1.15, min: 0.5, max: 3, step: 0.05, apply: dockParam('boxAspect') },
  { key: 'dock.gapFrac', label: 'Tile gap', group: 'Dock', type: 'number', default: 0.4, min: 0, max: 1.5, step: 0.05, apply: dockParam('gapFrac') },
  { key: 'dock.maxColumns', label: 'Max tiles/row (0=auto)', group: 'Dock', type: 'number', default: 0, min: 0, max: 24, step: 1, apply: dockParam('maxColumns') },
  { key: 'dock.maxArcDeg', label: 'Dome arc span°', group: 'Dock', type: 'number', default: 80, min: 30, max: 180, step: 5, apply: dockParam('maxArcDeg') },
  { key: 'dock.maxRiseDeg', label: 'Dome height span°', group: 'Dock', type: 'number', default: 80, min: 20, max: 110, step: 5, apply: dockParam('maxRiseDeg') },
  { key: 'dock.bottomFrac', label: 'Bar depth', group: 'Dock', type: 'number', default: 0.86, min: 0, max: 1, step: 0.02, apply: dockParam('bottomFrac') },
  { key: 'dock.fillFrac', label: 'Bar fill (linear)', group: 'Dock', type: 'number', default: 0.9, min: 0.5, max: 1, step: 0.02, apply: dockParam('fillFrac') },
  { key: 'dock.focusFrac', label: 'Focus size', group: 'Dock', type: 'number', default: 0.62, min: 0.2, max: 1, step: 0.02, apply: dockParam('focusFrac') },
  { key: 'dock.focusY', label: 'Focus height', group: 'Dock', type: 'number', default: 0.06, min: -0.4, max: 0.4, step: 0.02, apply: dockParam('focusY') },
  { key: 'dock.focusDistFrac', label: 'Focus pull-in', group: 'Dock', type: 'number', default: 0.7, min: 0.3, max: 1, step: 0.02, apply: dockParam('focusDistFrac') },
  { key: 'dock.animDur', label: 'Animation (s)', group: 'Dock', type: 'number', default: 0.167, min: 0, max: 0.6, step: 0.01, apply: dockParam('animDur') },
  // Window — per-window controls surfaced as the terminal chrome buttons. maxPinZoom is the
  // pin target on the zoom axis, read off ctx.windowConfig by the window.pin verb.
  { key: 'window.maxPinZoom', label: 'Pin max zoom (×)', group: 'Window', type: 'number', default: 3, min: 1.5, max: 10, step: 0.5, apply: windowParam('maxPinZoom') },
  // Tree — the ContentTree ownership-line overlay (hub → what it contains). File lines
  // and directory lines toggle independently; layout.arrows is the master on/off verb.
  {
    key: 'tree.fileLines', label: 'File ownership lines', group: 'Tree', type: 'bool', default: true,
    apply: (ctx, v) => ctx.contentTreeArrows?.setShowFiles?.(v),
  },
  {
    key: 'tree.dirLines', label: 'Directory ownership lines', group: 'Tree', type: 'bool', default: true,
    apply: (ctx, v) => ctx.contentTreeArrows?.setShowDirs?.(v),
  },
];

/** Push a background restyle to every live grid/terminal of `type`. */
function themeAll(ctx, type, style) {
  for (const e of ctx?.registry?.findByType?.(type) ?? []) e.grid?.setBackgroundStyle?.(style);
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
  };
}

/** Background options for a NEW TerminalGrid — so it spawns in the current scheme. */
export function terminalTheme() {
  return {
    backgroundColor: getSetting('terminal.backgroundColor'),
    backgroundOpacity: getSetting('terminal.backgroundOpacity'),
  };
}

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

export function settingDef(key) { return BY_KEY.get(key) || null; }

/** Coerce a raw (stored or user-typed) value to the def's type + clamp numbers. */
export function coerce(def, raw) {
  if (def.type === 'bool') return raw === true || raw === 'true';
  if (def.type === 'color') return typeof raw === 'string' && raw ? raw : def.default;
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

import { stateController } from '@glyph3d/core/services/state';

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

export const SETTINGS = [
  {
    key: 'camera.speed', label: 'Move speed', group: 'Camera',
    type: 'number', default: 100, min: 1, max: 1000, step: 1,
    apply: (ctx, v) => ctx.cameraController?.setSpeed?.(v),
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
];

/** Push a background restyle to every live grid/terminal of `type`. */
function themeAll(ctx, type, style) {
  for (const e of ctx?.registry?.findByType?.(type) ?? []) e.grid?.setBackgroundStyle?.(style);
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

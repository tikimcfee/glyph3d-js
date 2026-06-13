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

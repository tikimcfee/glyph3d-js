/**
 * carrelPanes — a plane desk's pane layout as DURABLE state (the model's Panes component, on the
 * desk's surface `carrel:<name>`), the way tuning.js keeps its own knob values: the desk tells us
 * when its panes change (Carrel.onPanesChanged), we write the record; a desk standing up (built or
 * restored — the gomuxai hub's derived desks included, keyed by name) reads its record back first.
 * SessionStore saves the records as the snapshot's `panes` and restores them beside `tunings`,
 * before any desk stands up.
 */

/** @typedef {import('./CommandProvider.jsx').AppContext} AppContext */

/** Write a desk's current pane layout into the model (null drops it). */
function writePanes(ctx, carrel) {
  const ws = ctx.workspace;
  if (!ws?.setSurfaceView) return;
  const rec = carrel.serializePanes();
  if (!rec && !ws.getSurface(carrel.name)) return;
  ws.setSurfaceView(carrel.name, undefined, { panes: rec });
}

/**
 * Wire a desk standing up: lay its saved panes over it, then keep the model in step with it.
 * A saved record the desk refuses (malformed) is reported with the record and dropped — the desk
 * lays out fresh rather than not standing up.
 * @param {AppContext} ctx @param {import('@glyph3d/core/services/interaction/Carrel.js').default} carrel
 */
export function wirePanes(ctx, carrel) {
  const saved = ctx.workspace?.getSurface?.(carrel.name)?.view?.panes;
  if (saved) {
    try { carrel.applyPanes(saved); }
    catch (e) { console.warn(`[panes] ${carrel.name}: the saved pane layout was refused — laying out fresh. ${e.message}`); }
  }
  carrel.onPanesChanged = () => writePanes(ctx, carrel);
}

/** Every desk's saved pane layout, for the snapshot. @param {AppContext} ctx */
export function listPanes(ctx) {
  return (ctx.workspace?.listSurfaces?.() || [])
    .filter((s) => s.view?.panes)
    .map((s) => ({ id: s.id, panes: s.view.panes }));
}

/**
 * Put the snapshot's pane layouts back into the model — before the desks stand up (they read
 * their own at birth, wirePanes) — and onto any desk already standing (one the hub built before the
 * restore ran).
 * @param {AppContext} ctx @param {Array<{id:string, panes:Object}>} list
 */
export function restorePanes(ctx, list) {
  const ws = ctx.workspace;
  for (const r of Array.isArray(list) ? list : []) {
    if (typeof r?.id !== 'string' || !r.panes || typeof r.panes !== 'object') {
      console.warn('[session] dropped a malformed pane-layout record:', r);
      continue;
    }
    ws?.setSurfaceView?.(r.id, undefined, { panes: r.panes });
    const desk = ctx.registry?.get?.(r.id)?.grid;
    if (desk?.applyPanes) {
      try { desk.applyPanes(r.panes); }
      catch (e) { console.warn(`[panes] ${r.id}: the saved pane layout was refused. ${e.message}`); }
    }
  }
}

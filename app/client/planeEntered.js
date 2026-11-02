/**
 * planeEntered — which plane desk you were reading, as durable state (the model's Entered
 * component on the `view:plane` surface), so a reload puts you back in it.
 *
 * carrel.enter on a plane desk records it; the plane's end — a leave, a fly, a restore, however it
 * ends — clears it (one plane-life listener on the camera). The snapshot saves it as `entered`; the
 * restore puts it back in stage 1 as a PENDING fact (ctx.pendingEnter) and enters the desk the
 * moment it and its members exist — a convergent fact, like the dock's pendingFrame, because a hub
 * desk is rebuilt only when the relay's tree arrives. While it's pending the hub's once-per-load
 * centering stands down. The saved camera pose stays the open-world one (getState answers with the
 * entered-from pose), so leaving after a reload lands where you were before you entered.
 */

/** @typedef {import('./CommandProvider.jsx').AppContext} AppContext */

const SURFACE = 'view:plane';

/**
 * Record (or clear, null) the entered plane desk — and say so in the relay's log store as a
 * `[usage]` line (time entered on the way out), so "is it used daily" is a number log.search
 * answers, quiet and local.
 * @param {AppContext} ctx @param {string|null} name
 */
export function recordEntered(ctx, name) {
  const ws = ctx.workspace;
  if (!ws?.setSurfaceView) return;
  const cur = ws.getSurface?.(SURFACE)?.view?.entered ?? null;
  if ((cur?.carrel ?? null) === (name ?? null)) return;
  const was = cur?.carrel ?? null;
  if (was && ctx._enteredAt) console.info(`[usage] plane.leave ${was} after ${Math.round((performance.now() - ctx._enteredAt) / 1000)}s`);
  if (name) { ctx._enteredAt = performance.now(); console.info(`[usage] plane.enter ${name}`); }
  else ctx._enteredAt = null;
  if (!name && !ws.getSurface?.(SURFACE)) return;
  ws.setSurfaceView(SURFACE, undefined, { entered: name ? { carrel: name } : null });
  ctx.session?.scheduleSave?.();
}

/** Listen to the camera's plane life once: its end clears the record. @param {AppContext} ctx */
export function armEnteredLife(ctx) {
  const cc = ctx.cameraController;
  if (!cc?.addPlaneListener || cc._enteredArmed) return;
  cc._enteredArmed = true;
  cc.addPlaneListener((on) => { if (!on) recordEntered(ctx, null); });
}

/**
 * The plane being READ right now: the camera in a plane view that isn't easing out of it, and the
 * plane desk entered, if any (`plane.enter` on one surface has none). Null in the open world. The
 * pointer and keyboard chains ask it: inside a plane a click or a bare nav key never flies the camera.
 * @param {AppContext} ctx @returns {{desk: import('@glyph3d/core/services/interaction/Carrel.js').default|null}|null}
 */
export function planeReading(ctx) {
  const st = ctx?.cameraController?.planeState?.();
  if (!st || st.leaving) return null;
  const desk = ctx.enteredCarrel ? ctx.carrels?.get?.(ctx.enteredCarrel) : null;
  return { desk: desk && desk.mode === 'plane' ? desk : null };
}

/** The record for the snapshot. @param {AppContext} ctx */
export function captureEntered(ctx) {
  return ctx.workspace?.getSurface?.(SURFACE)?.view?.entered ?? null;
}

/**
 * Restore: the record back into the model and a pending enter that converges — the desk entered once
 * it stands with its members seated (or `plane.restoreWaitMs` passes, said in the log).
 * @param {AppContext} ctx @param {{carrel:string}|null} rec @param {(cmd:string[]) => any} exec
 * @param {number} waitMs
 */
export function restoreEntered(ctx, rec, exec, waitMs) {
  if (!rec || typeof rec.carrel !== 'string') return;
  ctx.workspace?.setSurfaceView?.(SURFACE, undefined, { entered: { carrel: rec.carrel } });
  ctx.pendingEnter = rec.carrel;
  const t0 = performance.now();
  const tick = () => {
    if (ctx.pendingEnter !== rec.carrel) return;   // superseded (a manual enter, a leave)
    const desk = ctx.carrels?.get?.(rec.carrel);
    const ready = desk && desk.mode === 'plane' && desk.planeUnit && !desk._expected && ctx.cameraController;
    if (ready) {
      ctx.pendingEnter = null;
      Promise.resolve(exec(['carrel.enter', rec.carrel]))
        .catch((e) => console.warn(`[plane] re-entering '${rec.carrel}' after the reload failed —`, e?.message || e));
      return;
    }
    if (performance.now() - t0 > waitMs) {
      ctx.pendingEnter = null;
      console.warn(`[plane] '${rec.carrel}' didn't stand up with its members within ${waitMs} ms of the reload — not re-entering it`);
      return;
    }
    setTimeout(tick, 100);
  };
  setTimeout(tick, 0);
}

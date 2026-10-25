/**
 * wheelDetent — the paging wheel's NOTCH: continuous wheel travel (px) in, whole page
 * steps out. Paging is a discrete act; a wheel is a continuous device (a trackpad's
 * momentum streams hundreds of small deltas), so the travel ACCUMULATES and turns one
 * page per `notch` px, carrying the remainder — never one page per frame that happened
 * to carry any delta at all.
 *
 *   - A gesture's FIRST nudge turns at once once it passes `lead` × notch (a mouse
 *     click always turns immediately; trackpad jitter doesn't). From then on each full
 *     notch of travel turns one more page.
 *   - A gesture ends after `idleMs` of quiet, on a direction reversal, or when the
 *     target changes (another book under the cursor) — the carry resets, so a stale
 *     remainder never turns a page you didn't ask for.
 *
 * The units are px: the camera controller normalizes WheelEvent line/page deltas to px
 * before they reach here (normalizeWheelDelta); a two-finger touch drag feeds its
 * midpoint travel straight in. Pure — `now` is passed in, so it tests headless.
 */

/** Detent defaults — the books.wheel* settings' defaults. */
export const WHEEL_DETENT_DEFAULTS = Object.freeze({
  notch: 120,    // px of travel per page step (≈ one mouse-wheel click on every platform)
  idleMs: 180,   // quiet that ends a gesture (momentum keeps one alive)
  lead: 0.25,    // the first step of a gesture turns at lead × notch
});

/**
 * @param {Partial<typeof WHEEL_DETENT_DEFAULTS>} [opts]
 * @returns {{ cfg: {notch:number, idleMs:number, lead:number},
 *            feed: (px: number, now: number, key?: string) => number,
 *            reset: () => void,
 *            configure: (o: Partial<typeof WHEEL_DETENT_DEFAULTS>) => void }}
 *   feed → signed page steps this travel completes (+ = wheel-down travel), usually 0
 */
export function createWheelDetent(opts = {}) {
  const cfg = { ...WHEEL_DETENT_DEFAULTS, ...opts };
  let acc = 0, dir = 0, lastAt = -Infinity, lastKey = null, led = false;

  const reset = () => { acc = 0; dir = 0; led = false; lastAt = -Infinity; lastKey = null; };

  const feed = (px, now, key = null) => {
    if (!Number.isFinite(px) || px === 0) return 0;
    const sign = Math.sign(px);
    if (key !== lastKey || now - lastAt > cfg.idleMs || sign !== dir) { acc = 0; led = false; }
    lastAt = now; lastKey = key; dir = sign;
    const notch = Math.max(cfg.notch, 1e-6);
    acc += px;
    if (!led) {
      if (Math.abs(acc) < cfg.lead * notch) return 0;
      led = true;
      acc = 0;
      return sign;
    }
    const steps = Math.trunc(acc / notch);
    acc -= steps * notch;
    return steps;
  };

  const configure = (o) => {
    for (const k of Object.keys(WHEEL_DETENT_DEFAULTS)) {
      if (o[k] === undefined) continue;
      const v = Number(o[k]);
      if (!Number.isFinite(v) || v < 0) throw new Error(`wheelDetent.configure: ${k} must be a number ≥ 0 (got ${o[k]})`);
      cfg[k] = v;
    }
  };

  return { cfg, feed, reset, configure };
}

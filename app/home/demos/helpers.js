/**
 * helpers — small animation + scheduling primitives shared by demos.
 *
 * A demo is just an async function. It can `await tween(...)` to run a
 * per-frame animation across N milliseconds, `await sleep(...)` to pause,
 * and check `signal.aborted` between steps so the visitor can cancel
 * mid-demo (re-typing `demo.<name>` will re-cancel and restart).
 *
 * Nothing here knows about glyphs or scenes — demos compose these
 * primitives with the existing CodeGrid / CommandRouter APIs.
 */

/** Standard easing: smooth in-out cubic. Most natural for camera/UI feel. */
export function easeInOutCubic(t) {
    return t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Linear easing — for color sweeps and constant-velocity motion. */
export function linear(t) { return t; }

/**
 * Run a per-frame callback for `durationMs`, passing it `t in [0,1]`.
 * Resolves when complete. Rejects with `{ cancelled: true }` if the
 * AbortSignal fires mid-tween. Cleans up its rAF on cancel.
 *
 * @param {number} durationMs
 * @param {(t:number)=>void} fn   called each frame with eased progress
 * @param {Object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {(t:number)=>number} [opts.ease]   default easeInOutCubic
 * @returns {Promise<void>}
 */
export function tween(durationMs, fn, { signal, ease = easeInOutCubic } = {}) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject({ cancelled: true }); return; }
        const t0 = performance.now();
        let rafId = null;
        const onAbort = () => {
            if (rafId != null) cancelAnimationFrame(rafId);
            reject({ cancelled: true });
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        const tick = () => {
            const elapsed = performance.now() - t0;
            const raw = Math.min(elapsed / durationMs, 1);
            const eased = ease(raw);
            try { fn(eased); } catch (e) {
                signal?.removeEventListener('abort', onAbort);
                reject(e);
                return;
            }
            if (raw < 1) {
                rafId = requestAnimationFrame(tick);
            } else {
                signal?.removeEventListener('abort', onAbort);
                resolve();
            }
        };
        rafId = requestAnimationFrame(tick);
    });
}

/**
 * Cancellable sleep.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject({ cancelled: true }); return; }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => { clearTimeout(timer); reject({ cancelled: true }); };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Map [0,1] → a hue rainbow as { r, g, b } in [0,1]. Useful for sweeps.
 * Saturation kept slightly under 1 so additive blending on a dim base
 * doesn't immediately clip to white.
 */
export function rainbow(t, sat = 0.85, light = 0.6) {
    // Use HSL → RGB. h in [0, 1) maps around the wheel.
    const h = (t % 1 + 1) % 1;
    const c = (1 - Math.abs(2 * light - 1)) * sat;
    const x = c * (1 - Math.abs((h * 6) % 2 - 1));
    const m = light - c / 2;
    let r, g, b;
    if      (h < 1/6) { r = c; g = x; b = 0; }
    else if (h < 2/6) { r = x; g = c; b = 0; }
    else if (h < 3/6) { r = 0; g = c; b = x; }
    else if (h < 4/6) { r = 0; g = x; b = c; }
    else if (h < 5/6) { r = x; g = 0; b = c; }
    else              { r = c; g = 0; b = x; }
    return { r: r + m, g: g + m, b: b + m };
}

/**
 * AbortableDemoRunner — owns one active demo at a time. Calling start()
 * cancels any in-flight demo before launching the new one. HomeShell
 * keeps a single instance and re-uses it.
 */
export class AbortableDemoRunner {
    constructor() {
        this._ac = null;
        this._activeName = null;
    }

    /**
     * @param {string} name
     * @param {(ctx: { signal: AbortSignal }) => Promise<any>} fn
     * @returns {Promise<{ name: string, cancelled?: boolean, error?: any }>}
     */
    async start(name, fn) {
        this.cancel();
        const ac = new AbortController();
        this._ac = ac;
        this._activeName = name;
        try {
            await fn({ signal: ac.signal });
            return { name, completed: true };
        } catch (e) {
            if (e?.cancelled) return { name, cancelled: true };
            return { name, error: e };
        } finally {
            if (this._ac === ac) {
                this._ac = null;
                this._activeName = null;
            }
        }
    }

    /** Cancel the active demo (no-op if nothing running). */
    cancel() {
        if (this._ac) this._ac.abort();
    }

    get activeName() { return this._activeName; }
    get isActive()   { return this._ac !== null; }
}

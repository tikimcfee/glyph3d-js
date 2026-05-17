/**
 * DemoRunner — execute a list of commands as an animated playthrough.
 *
 * A demo script is an array of steps. Each step is either:
 *   - a string  → run as a single command (no inter-step delay)
 *   - an object → { cmd: string, delay?: ms, label?: string }
 *     where `delay` is how long to wait AFTER the command before the next step.
 *
 * The runner is cancellable: it returns a handle with `.cancel()`. A cancelled
 * run rejects with `{ cancelled: true }` and stops dispatching further steps.
 *
 * It is deliberately tiny — no parallelism, no branching, no DSL. If a script
 * needs structure, build the structure in JavaScript and emit a flat array.
 *
 * Errors from individual commands do not abort the run by default — the demo
 * keeps moving, since one missing handler shouldn't strand the camera halfway
 * through a tour. Pass `{ stopOnError: true }` to override.
 */

/**
 * @typedef {string | { cmd: string, delay?: number, label?: string }} DemoStep
 *
 * @typedef {Object} DemoHandle
 * @property {Promise<{ completed: boolean, step: number }>} done
 * @property {() => void} cancel
 */

/**
 * Run a demo script.
 *
 * @param {Object} router - CommandRouter instance (has .execute)
 * @param {DemoStep[]} script
 * @param {Object} [opts]
 * @param {boolean} [opts.stopOnError=false]
 * @param {(stepIdx: number, step: DemoStep, result: any) => void} [opts.onStep]
 * @returns {DemoHandle}
 */
export function runDemo(router, script, opts = {}) {
    const { stopOnError = false, onStep } = opts;
    let cancelled = false;
    let timer = null;
    let resolveDone, rejectDone;
    const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });

    (async () => {
        for (let i = 0; i < script.length; i++) {
            if (cancelled) {
                rejectDone({ cancelled: true, step: i });
                return;
            }
            const raw = script[i];
            const step = typeof raw === 'string' ? { cmd: raw } : raw;
            let result;
            try {
                result = await router.execute(step.cmd);
            } catch (err) {
                result = { error: err?.message || String(err) };
                if (stopOnError) {
                    rejectDone({ error: result.error, step: i });
                    return;
                }
            }
            try { onStep?.(i, step, result); } catch {}
            if (step.delay && step.delay > 0) {
                await new Promise(r => {
                    timer = setTimeout(() => { timer = null; r(); }, step.delay);
                });
            }
        }
        resolveDone({ completed: true, step: script.length });
    })();

    return {
        done,
        cancel() {
            cancelled = true;
            if (timer) { clearTimeout(timer); timer = null; }
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────
// Initial demo scripts.
//
// These play to current strengths: camera movement, status reporting. They
// deliberately avoid known-shaky paths (live editing, complex layouts) until
// those mature. New scripts go here as named exports.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Take-the-tour: gentle camera sweep around the welcome cluster. About 9
 * seconds end-to-end. Useful as a first "look, things move" demonstration.
 * The cluster sits near origin; we orbit out and back in.
 */
export const DEMO_TOUR = [
    { cmd: 'camera.animate 0 0 800 1500',   delay: 1600, label: 'pull back' },
    { cmd: 'camera.animate 400 200 600 1800', delay: 1900, label: 'orbit up-right' },
    { cmd: 'camera.animate -400 -100 600 1800', delay: 1900, label: 'orbit down-left' },
    { cmd: 'camera.animate 0 0 500 1500',   delay: 0,    label: 'return' },
];

/**
 * Show-the-engine: a one-shot that just calls status, so the visitor sees
 * the system respond. Kept tiny on purpose — first step is "the bar works."
 * Will grow into a real rendering showcase once grid.* primitives are wired
 * for the home scene.
 */
export const DEMO_PING = [
    { cmd: 'status', label: 'system status' },
];

/**
 * Registry of named scripts so TryThisCluster can reference by name without
 * pulling DemoRunner into its imports.
 */
export const DEMO_SCRIPTS = {
    tour: DEMO_TOUR,
    ping: DEMO_PING,
};

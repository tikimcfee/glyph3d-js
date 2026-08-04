/**
 * frameYield — the main-thread courtesy primitive for long build loops.
 *
 * A bulk build (session hydration, a dir pop) is a synchronous loop that would
 * otherwise show up as one long task: every await queued behind it (RPC replies,
 * input, rAF) starves until it finishes. The loop instead runs in BUDGETED
 * SLICES — work until the slice budget expires, then `await yieldToFrame()` so
 * the pending work runs, and resume. The build's wall time barely moves; every
 * other lane on the thread stays alive.
 *
 * rAF is the real frame boundary; the timer keeps a hidden tab (no frames) and
 * headless runtimes (no rAF at all — tests, tools) from stalling.
 */

/**
 * Cede the main thread until the next frame (or ~immediately when there are
 * no frames — hidden tab, headless). Pairs with a per-slice budget check:
 *
 *   let slice0 = performance.now();
 *   for (const item of items) {
 *       build(item);
 *       if (performance.now() - slice0 > budgetMs) {
 *           await yieldToFrame();
 *           slice0 = performance.now();
 *       }
 *   }
 *
 * @param {number} [fallbackMs=50] hidden-tab cadence cap (the timer only fires
 *        when rAF doesn't — headless runtimes get 0 so tests don't crawl)
 * @returns {Promise<void>}
 */
export function yieldToFrame(fallbackMs = 50) {
    return new Promise((resolve) => {
        if (typeof requestAnimationFrame === 'function') {
            let done = false;
            const settle = () => { if (!done) { done = true; resolve(); } };
            requestAnimationFrame(settle);
            setTimeout(settle, fallbackMs);
        } else {
            setTimeout(resolve, 0);
        }
    });
}

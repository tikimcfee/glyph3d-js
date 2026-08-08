/**
 * loadStats — cross-module counters for the LOAD PATH's hidden costs.
 *
 * The load trace (app/commands/loadTrace.js) decomposes a load into reach/list/fetch/build/
 * relayout, but "build" hides the three costs that actually move: kernel dispatches (one per
 * grid commit), Slug atlas growths (each one hot-swaps textures into every registered
 * field), and the settle wait on the worker pool. Core modules bump these counters;
 * fileCommands snapshots them around the build stage and notes the deltas into the trace.
 * Deliberately a dumb mutable singleton — the load path is single-threaded JS and the
 * numbers are diagnostic, not authoritative.
 */

export const loadStats = {
    kernelDispatches: 0,
    kernelMs: 0,
    atlasGrows: 0,
    atlasMs: 0,
    atlasFieldsSwapped: 0,
    atlasBlanks: 0,
    atlasGlyphsAdded: 0,
    analyzeParses: 0,
    parseSyncMs: 0,
    commits: 0,
    commitMs: 0,
    yields: 0,
    yieldMs: 0,
    selfBakes: 0,      // grids that folded their OWN layout record (no disk index)
    selfBakeMs: 0,
};

/** Snapshot the counters (for delta-ing around a stage). */
export function snapshotLoadStats() {
    return { ...loadStats };
}

/** Delta between a snapshot and now: { kernelDispatches, kernelMs, atlasGrows, ... }. */
export function diffLoadStats(snap) {
    const d = {};
    for (const k of Object.keys(loadStats)) d[k] = loadStats[k] - (snap[k] ?? 0);
    return d;
}

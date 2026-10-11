/**
 * loadStats — cross-module counters for the LOAD PATH's hidden costs.
 *
 * The load trace (app/commands/loadTrace.js) decomposes a load into reach/list/fetch/build/
 * relayout, but "build" hides the costs that actually move: Slug atlas growths (each one
 * hot-swaps textures into every registered field), syntax parses, and the settle wait on
 * the worker pool. Core modules bump these counters;
 * fileCommands snapshots them around the build stage and notes the deltas into the trace.
 * Deliberately a dumb mutable singleton — the load path is single-threaded JS and the
 * numbers are diagnostic, not authoritative.
 */

export const loadStats = {
    atlasGrows: 0,
    atlasMs: 0,
    atlasFieldsSwapped: 0,
    atlasBlanks: 0,
    atlasGlyphsAdded: 0,
    analyzeParses: 0,
    parseSyncMs: 0,
    parseWorkerMs: 0,  // colorize parse time OFF-thread (worker wall, summed across the pool)
    yields: 0,
    yieldMs: 0,
};

/** Snapshot the counters (for delta-ing around a stage). */
export function snapshotLoadStats() {
    return { ...loadStats };
}

/** Delta between a snapshot and now: { atlasGrows, atlasMs, ... }. */
export function diffLoadStats(snap) {
    const d = {};
    for (const k of Object.keys(loadStats)) d[k] = loadStats[k] - (snap[k] ?? 0);
    return d;
}

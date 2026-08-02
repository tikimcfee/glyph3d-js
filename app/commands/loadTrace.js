/**
 * loadTrace — staged timing for the LOAD FLOW, bus-native and quiet.
 *
 * Launches storm sequential loads (session restore replays every field source;
 * a directory pop fetches and builds hundreds of grids), and "it felt slow" needs
 * to decompose into WHICH STAGE: reach, listing, fetch, build, relayout. One
 * trace per load operation, marked stage by stage as the handler runs:
 *
 *   const trace = beginLoad(ctx, 'openDir', dir);
 *   ...await listTree...      trace.mark('list', { entries: n });
 *   ...await fetch...         trace.mark('fetch', { files: n, kb: 812 });
 *   ...build loop...          trace.mark('build', { grids: n });
 *   ...relayoutAndRest...     trace.mark('relayout', { dirs: n });
 *   trace.end({ opened });
 *
 * Where it lands (three sinks, one call):
 *   - ONE structured `[load]` console.info line per operation — the relay's log
 *     store keeps every browser record, so `log.search load` answers page-less
 *     from the CLI, live or post-mortem.
 *   - ctx.loadTraces — an in-memory ring (newest last, capped) the `load.stats`
 *     verb reads for tables/aggregates; the harness asserts invariants on it.
 *   - performance.measure — the devtools timeline shows every load as a bar.
 *
 * A trace that never reaches end() (an ERR return path) records nothing — error
 * paths already speak through the command result; this instrument times the work
 * that actually happened.
 */

const RING_CAP = 60;

/**
 * @param {object} ctx the command context (the ring lives at ctx.loadTraces)
 * @param {string} kind operation kind: 'openDir' | 'open' | 'repo' | 'restore' …
 * @param {string} [target] what was loaded (a dir, a path, an owner/repo)
 */
export function beginLoad(ctx, kind, target = '') {
    const t0 = performance.now();
    let last = t0;
    const stages = [];
    const trace = {
        kind, target, at: Date.now(), stages, total: 0, meta: {},
        /** Close the current stage: everything since the previous mark (or start). */
        mark(name, extra) {
            const now = performance.now();
            stages.push({ name, ms: +(now - last).toFixed(1), ...(extra || {}) });
            last = now;
            return trace;
        },
        /** Attach summary facts without closing a stage. */
        note(extra) { Object.assign(trace.meta, extra); return trace; },
        end(extra) {
            trace.total = +(performance.now() - t0).toFixed(1);
            Object.assign(trace.meta, extra || {});
            const ring = (ctx.loadTraces ??= []);
            ring.push(trace);
            if (ring.length > RING_CAP) ring.shift();
            console.info(`[load] ${formatTrace(trace)}`);
            try { performance.measure(`load:${kind}${target ? ':' + target : ''}`, { start: t0, end: performance.now() }); } catch { /* older UAs */ }
            return trace;
        },
    };
    return trace;
}

/** One compact human line: kind target · stage 12ms (facts) · … · total 640ms.
 *  A long stage list (a many-tab restore) compacts to its slowest few — the full
 *  detail stays in the ring for load.stats. */
export function formatTrace(trace) {
    const stage = (s) => {
        const facts = Object.entries(s).filter(([k]) => k !== 'name' && k !== 'ms')
            .map(([k, v]) => `${k}:${v}`).join(' ');
        return `${s.name} ${s.ms}ms${facts ? ` (${facts})` : ''}`;
    };
    let body;
    if (trace.stages.length > 8) {
        const slowest = [...trace.stages].sort((a, b) => b.ms - a.ms).slice(0, 3);
        body = `${trace.stages.length} stages, slowest: ${slowest.map(stage).join(' · ')}`;
    } else {
        body = trace.stages.map(stage).join(' · ');
    }
    const meta = Object.entries(trace.meta).map(([k, v]) => `${k}:${v}`).join(' ');
    return `${trace.kind}${trace.target ? ' ' + trace.target : ''} · ${body}`
        + ` · total ${trace.total}ms${meta ? ` (${meta})` : ''}`;
}

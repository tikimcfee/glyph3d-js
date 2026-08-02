/**
 * Load commands — the load flow's own metrics, bus-native.
 *
 * Every load operation (file.open, file.openDir, repo.load, the restore phases)
 * runs a staged loadTrace (app/commands/loadTrace.js): reach → list → fetch →
 * build → relayout, one `[load]` console line each (the relay log store keeps
 * them; `log.search load` answers from the CLI). The traces also land in an
 * in-memory ring — this verb reads it:
 *
 *   load.stats           → recent loads (stage breakdown) + per-stage aggregates
 *   load.stats clear     → reset the ring (start a fresh measurement window)
 *
 * The aggregates answer the storm question directly: across a launch, how much
 * total time went to fetching vs building vs relayouting — and how many
 * relayouts ran (each one re-packs the whole tree and rebuilds every overlay,
 * so the count is the batching health metric, not just the milliseconds).
 */

import { box, kvLines, table } from '../formatResponse.js';
import { formatTrace } from '../loadTrace.js';

/**
 * @param {import('../../../packages/glyph3d-core/src/services/orchestration/CommandRouter.js').default} router
 */
export default function registerLoadCommands(router) {
    router.register('load.stats', (args, ctx) => {
        const ring = Array.isArray(ctx.loadTraces) ? ctx.loadTraces : [];

        if (args[0] === 'clear') {
            const n = ring.length;
            ctx.loadTraces = [];
            return { text: `OK: load trace ring cleared (${n} dropped)`, data: { cleared: n } };
        }

        if (!ring.length) {
            return { text: 'OK: no loads traced yet (open a file, pop a dir, or reload)', data: { traces: [] } };
        }

        // Per-stage aggregates across the ring. Restore envelopes (restore.*) mark one
        // stage PER ITEM (a source, a tab) — those aggregate under 'item', keeping the
        // stage table about the pipeline (reach/list/fetch/build/relayout/frame).
        const PIPELINE = new Set(['reach', 'list', 'filter', 'fetch', 'build', 'relayout', 'render', 'tree', 'clear', 'field', 'frame']);
        const agg = new Map();   // stage → { ms, n, max }
        let relayouts = 0;
        for (const t of ring) {
            for (const s of t.stages) {
                const key = t.kind.startsWith('restore.') && !PIPELINE.has(s.name) ? 'item' : s.name;
                const a = agg.get(key) || { ms: 0, n: 0, max: 0 };
                a.ms += s.ms; a.n++; a.max = Math.max(a.max, s.ms);
                agg.set(key, a);
                if (key === 'relayout') relayouts++;
            }
        }
        const stageRows = [...agg.entries()]
            .sort((a, b) => b[1].ms - a[1].ms)
            .map(([name, a]) => [name, `${a.ms.toFixed(0)}ms`, String(a.n), `${a.max.toFixed(0)}ms`]);

        const traceRows = ring.slice(-14).map((t) => [
            t.kind,
            t.target.length > 34 ? '…' + t.target.slice(-33) : t.target,
            `${t.total}ms`,
            t.stages.length > 5
                ? `${t.stages.length} stages`
                : t.stages.map((s) => `${s.name} ${s.ms}`).join(' · '),
        ]);

        const totalMs = ring.reduce((n, t) => n + t.total, 0);
        return {
            text: [
                box('LOAD STATS', kvLines({
                    traces: String(ring.length),
                    'total load time': `${totalMs.toFixed(0)}ms`,
                    relayouts: String(relayouts),
                }), 72),
                'per stage (sum across all traces):',
                table(['stage', 'total', 'runs', 'max'], stageRows),
                'recent:',
                table(['kind', 'target', 'total', 'stages'], traceRows),
                'OK: load.stats',
            ].join('\n'),
            data: { traces: ring, relayouts, totalMs },
        };
    }, {
        description: 'Load-flow metrics: recent staged load traces + per-stage aggregates (fetch vs build vs relayout) and the relayout count',
        usage: '[clear]',
        returns: '{ traces, relayouts, totalMs }',
    });

    // Every [load] line also lands in the relay log store — point the operator there.
    router.register('load.log', async (_args, _ctx) => ({
        text: 'OK: [load] lines live in the relay log store — `log.search load` (CLI, page-less) or `bun tools/buslog.mjs` to follow live',
        data: null,
    }), {
        description: 'Where the [load] trace lines land (the relay log store) and how to query them',
        usage: '',
        returns: 'pointer text',
    });
}

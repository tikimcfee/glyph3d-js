/**
 * Delta commands — the addressable surface over DeltaBooks (before/after change sets,
 * each a book: one sheet per changed file, base verso / head recto, aligned + barred).
 *
 *   delta.watch   <agentId>            LIVE: the agent's edits/writes update its delta set
 *                                      in place — base captured once per file, so spreads
 *                                      show cumulative drift since watching began
 *   delta.unwatch <agentId>            stop feeding (the book stays, static)
 *   delta.git     [base] [head]        a git changeset (working tree vs HEAD by default;
 *                                      one ref = vs that ref; two = ref..ref) — relay feature
 *   delta.pair    <fileA> <fileB>      any two files as one spread (set id 'pair')
 *   delta.list                         the sets: files, +/− totals, kind, head
 *   delta.close   <id|all>             remove a set (or every set)
 *   delta.config  [key value]          get/set a delta-shelf constant (view, fillOpacity,
 *                                      page dims, context…) — new sheets render with it
 *
 * Paging IS book.*: every delta set answers to `delta:<id>` in the one book address
 * space (book.page delta:dev next, shift+wheel over any page). The camera never moves.
 */

import { splitUnifiedDiff, alignTexts } from '@glyph3d/core/services/state/deltaSource.js';

const noDeltas = { text: 'ERR: delta books not wired', data: null };

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerDeltaCommands(router) {
    router.register('delta.watch', (args, ctx) => {
        const deltas = ctx.deltaBooks;
        if (!deltas) return noDeltas;
        const [agentId] = args;
        if (!agentId) return { text: 'ERR: usage: delta.watch <agentId>', data: null };
        const set = deltas.ensure(agentId, { kind: 'watch', label: `watch ${agentId}` });
        set.kind = 'watch';   // re-watch a set that was unwatched
        return { text: `OK: watching ${agentId} — edits land in book delta:${agentId}`, data: { id: agentId } };
    }, { description: "Watch an agent's disk changes live — one delta sheet per touched file, cumulative since watch start", usage: '<agentId>' });

    router.register('delta.unwatch', (args, ctx) => {
        const deltas = ctx.deltaBooks;
        if (!deltas) return noDeltas;
        const hit = deltas.resolveSet(args[0]);
        if (!hit) return { text: `ERR: no delta set '${args[0] ?? ''}'`, data: null };
        hit[1].kind = 'static';
        return { text: `OK: ${hit[0]} unwatched (book stays)`, data: { id: hit[0] } };
    }, { description: 'Stop feeding a watched delta set — its book stays, static', usage: '<agentId>' });

    router.register('delta.git', async (args, ctx) => {
        const deltas = ctx.deltaBooks;
        if (!deltas) return noDeltas;
        const fp = ctx.fileProvider;
        if (typeof fp?.gitDiff !== 'function') {
            return { text: 'ERR: no git provider (delta.git is a relay feature — serve a project with glyph3d-cli)', data: null };
        }
        const [base = '', head = ''] = args;
        try {
            const r = await fp.gitDiff({ base, head });
            const files = splitUnifiedDiff(r?.diff || '');
            const label = base && head ? `${base}..${head}` : base ? `${base}..worktree` : 'worktree';
            const setId = base && head ? `${base}..${head}` : base ? `${base}..` : 'git';
            if (!files.length) {
                // An EMPTY refresh of an existing set clears its sheets; a fresh empty diff makes nothing.
                if (deltas.sets.has(setId)) deltas.applyChangeset(setId, [], { label });
                return { text: `OK: ${label} — no changes`, data: { id: setId, files: 0, truncated: !!r?.truncated } };
            }
            const n = deltas.applyChangeset(setId, files, { label });
            const skipped = files.length - n;
            return {
                text: `OK: ${label} — ${n} file${n === 1 ? '' : 's'} in book delta:${setId}`
                    + (skipped ? ` (${skipped} binary/empty skipped)` : '')
                    + (r?.truncated ? ' (diff truncated at the relay cap)' : ''),
                data: { id: setId, files: n, skipped, truncated: !!r?.truncated },
            };
        } catch (e) {
            return { text: `ERR: git diff failed — ${e?.message || e}`, data: null };
        }
    }, { description: 'A git changeset as a delta book — worktree vs HEAD by default, or vs a ref, or ref..ref', usage: '[base] [head]' });

    router.register('delta.pair', async (args, ctx) => {
        const deltas = ctx.deltaBooks;
        if (!deltas) return noDeltas;
        const [a, b, idArg] = args;
        if (!a || !b) return { text: 'ERR: usage: delta.pair <fileA> <fileB> [setId]', data: null };
        try {
            const [baseText, headText] = await Promise.all([
                ctx.fileProvider?.getFile?.(a), ctx.fileProvider?.getFile?.(b),
            ]);
            const setId = idArg || 'pair';
            const aligned = alignTexts(String(baseText ?? ''), String(headText ?? ''),
                { view: deltas.cfg.view, context: deltas.cfg.context });
            deltas.ensure(setId, { label: `${a} → ${b}` });
            deltas.setFile(setId, b, { ...aligned, name: String(b).split('/').pop() });
            return {
                text: `OK: ${a} → ${b} — +${aligned.added} −${aligned.removed} in book delta:${setId}`,
                data: { id: setId, added: aligned.added, removed: aligned.removed },
            };
        } catch (e) {
            return { text: `ERR: pair failed — ${e?.message || e}`, data: null };
        }
    }, { description: 'Two files as one before/after spread', usage: '<fileA> <fileB> [setId]' });

    router.register('delta.list', (_args, ctx) => {
        const deltas = ctx.deltaBooks;
        if (!deltas) return noDeltas;
        const rows = deltas.list();
        const lines = rows.map((s) =>
            `${String(s.files).padStart(3)} file${s.files === 1 ? ' ' : 's'}  +${s.added} −${s.removed}  [${s.kind}]  delta:${s.id}`);
        return {
            text: `DELTAS (${rows.length})\n` + (lines.length ? lines.join('\n') : '(none)'),
            data: { count: rows.length, sets: rows },
        };
    }, { description: 'List the delta sets — files, +/− totals, kind', returns: '{ count, sets:[{id,kind,files,added,removed,…}] }' });

    router.register('delta.files', (args, ctx) => {
        const deltas = ctx.deltaBooks;
        if (!deltas) return noDeltas;
        const hit = deltas.resolveSet(args[0]);
        if (!hit) return { text: args[0] ? `ERR: no delta set '${args[0]}'` : 'ERR: no delta sets', data: null };
        const rows = deltas.files(hit[0]);
        const lines = rows.map((f) =>
            `${f.focused ? '▸' : ' '} ${String(f.index + 1).padStart(2)}  +${f.added} −${f.removed}  ${f.name}  (${f.status})`);
        return {
            text: `delta:${hit[0]}\n` + (lines.length ? lines.join('\n') : '(no files)'),
            data: { id: hit[0], files: rows },
        };
    }, { description: "One delta set's file roster in sheet order (▸ = the open sheet)", usage: '[id]' });

    router.register('delta.close', (args, ctx) => {
        const deltas = ctx.deltaBooks;
        if (!deltas) return noDeltas;
        const [target] = args;
        if (!target) return { text: 'ERR: usage: delta.close <id|all>', data: null };
        if (target === 'all') {
            const n = deltas.clear();
            return { text: `OK: closed ${n} delta set${n === 1 ? '' : 's'}`, data: { closed: n } };
        }
        const ok = deltas.remove(target);
        return ok
            ? { text: `OK: closed ${target}`, data: { id: target } }
            : { text: `ERR: no delta set '${target}'`, data: null };
    }, { description: 'Remove a delta set (or all)', usage: '<id|all>' });

    router.register('delta.config', (args, ctx) => {
        const deltas = ctx.deltaBooks;
        if (!deltas) return noDeltas;
        if (args.length < 2) return { text: `delta cfg: ${JSON.stringify(deltas.cfg)}`, data: deltas.cfg };
        const [key, val] = args;
        const n = Number(val);
        deltas.cfg[key] = (val === 'true' || val === 'false') ? (val === 'true')
                        : Number.isFinite(n) ? n : val;
        // Page-form keys re-fit live; delta-render keys (view/context/colors) apply to
        // the NEXT update of each sheet — a re-run of delta.git / the next watch event.
        for (const set of deltas.sets.values()) set.book.fit(deltas._pageOpts(set));
        deltas._relayout();
        return { text: `OK: delta.${key} = ${deltas.cfg[key]}`, data: { [key]: deltas.cfg[key] } };
    }, { description: 'Get or set a delta-shelf constant (view, fillOpacity, page dims, context…)', usage: '[key value]' });
}

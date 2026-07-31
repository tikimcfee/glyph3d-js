/**
 * Session commands — drive the saved-state store (SessionStore) from the bus.
 *
 * The store auto-saves a versioned snapshot of "what's loaded" (open files +
 * their frame/scroll state, terminals + their cols/rows, camera, dock layout) to
 * a server-side `.glyph3d-session.json`. These verbs are the manual levers:
 *
 *   session.save    force an immediate write (autosave is debounced)
 *   session.clear   wipe the saved snapshot (clear-with-log; live scene stays)
 *   session.status  the last restore's per-phase report + autosave state
 *
 * The store is stashed on ctx.session by CommandProvider.
 */

export default function registerSessionCommands(router) {

    // session.status — the phased loader's report: which named phase ran, how long it
    // took, and what failed (a failed section's saved blob is quarantined from capture).
    router.register('session.status', async (args, ctx) => {
        const session = ctx.session;
        if (!session) return { text: 'ERR: session store unavailable', data: null };
        const r = session.lastRestore;
        const lines = [];
        if (!r) {
            lines.push('restore: not run (client-only mode, no relay connect yet, or no saved session)');
        } else {
            lines.push(`restore: ${r.ok ? 'complete' : 'DEGRADED'} at ${new Date(r.at).toISOString()}`);
            for (const p of r.phases) {
                lines.push(`  ${p.ok ? 'ok  ' : 'FAIL'} ${p.name} ${p.ms}ms${p.error ? ' — ' + p.error : ''}`);
            }
        }
        lines.push(`autosave: ${session._autosaveOn ? 'armed' : 'off'}`);
        return {
            text: lines.join('\n'),
            data: { restore: r, autosaveOn: session._autosaveOn },
        };
    }, { description: 'Report the last session restore (per-phase outcome + timing) and autosave state', usage: '' });

    // session.save — force a write now instead of waiting on the debounce/periodic timer.
    router.register('session.save', async (args, ctx) => {
        const session = ctx.session;
        if (!session) return { text: 'ERR: session store unavailable', data: null };
        await session.saveNow();
        return { text: 'OK: session saved', data: { saved: true } };
    }, { description: 'Force an immediate save of the session snapshot', usage: '' });

    // session.clear — wipe the saved snapshot file. Live grids/terminals stay in the
    // scene; autosave re-captures them on the next change (the file mirrors reality).
    // To start genuinely fresh, clear then reload the page before anything re-saves.
    router.register('session.clear', async (args, ctx) => {
        const session = ctx.session;
        if (!session) return { text: 'ERR: session store unavailable', data: null };
        await session.clear();
        return {
            text: 'OK: saved session cleared (live scene unchanged; reload for a fresh start)',
            data: { cleared: true },
        };
    }, { description: 'Clear the saved session snapshot (.glyph3d-session.json)', usage: '' });
}

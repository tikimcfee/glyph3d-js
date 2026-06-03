/**
 * Session commands — drive the saved-state store (SessionStore) from the bus.
 *
 * The store auto-saves a versioned snapshot of "what's loaded" (open files +
 * their frame/scroll state, terminals + their cols/rows, camera, dock layout) to
 * a server-side `.glyph3d-session.json`. These verbs are the manual levers:
 *
 *   session.save   force an immediate write (autosave is debounced)
 *   session.clear  wipe the saved snapshot (clear-with-log; live scene stays)
 *
 * The store is stashed on ctx.session by CommandProvider.
 */

export default function registerSessionCommands(router) {

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

/**
 * panel.* commands — open / close / toggle the IDE's dock panels (Files, Repo,
 * Terminals, Crew, …) through the bus. dockview lets a tab be closed but offers
 * no way back; these verbs (and the ButtonBar's panels menu that drives them) are
 * that way back — and the same handle the CLI/Claude use.
 *
 * The dock controller is injected by the DOM layer: IdeDock sets ctx.dock once
 * dockview is ready. These verbs are the provider-agnostic front for it; if the
 * engine is still booting (no dock yet) they return a clean ERR.
 */

function getDock(ctx) {
    return ctx.dock && typeof ctx.dock.open === 'function' ? ctx.dock : null;
}

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerPanelCommands(router) {
    router.register('panel.list', (_args, ctx) => {
        const dock = getDock(ctx);
        if (!dock) return { text: 'ERR: dock not ready', data: null };
        const panels = dock.list();
        return { text: `OK: ${panels.map((p) => `${p.open ? '●' : '○'} ${p.id}`).join('  ')}`, data: { panels } };
    }, { description: 'List the dock panels and whether each is open', returns: '{ panels:[{id,title,open}] }' });

    // open / close / toggle share a shape: <panel-id>, ERR on unknown id.
    const verb = (name, fn, description) => router.register(name, (args, ctx) => {
        const dock = getDock(ctx);
        if (!dock) return { text: 'ERR: dock not ready', data: null };
        const id = args[0];
        if (!id) return { text: `ERR: usage: ${name} <panel-id>`, data: null };
        const r = fn(dock, id);
        if (r == null) return { text: `ERR: unknown panel "${id}"`, data: null };
        return { text: `OK: ${name} ${id}`, data: { id, open: r.open } };
    }, { description, usage: '<panel-id>' });

    verb('panel.open', (dock, id) => dock.open(id), 'Open (or focus) a dock panel');
    verb('panel.close', (dock, id) => dock.close(id), 'Close a dock panel');
    verb('panel.toggle', (dock, id) => dock.toggle(id), 'Toggle a dock panel open/closed');
}

/**
 * pane.* commands — the tiling PANE COMPOSITOR that drives the CameraDock's view-frame.
 *
 * The frame's occupancy is a binary-BSP PaneTree (packages/.../PaneTree.js); a single leaf is the
 * old single-occupant pin (window.pin / dock.spotlight). These verbs GROW and navigate that tree —
 * the i3/tmux/vim intersection an old-school user expects: split, directional focus, proportional
 * resize, swap, un-frame. UI keybindings and the CLI/RPC hit the same verbs (one source of truth).
 *
 * A pane's window must be DOCKED (a live CameraDock entry) to tile into the frame — pane.split docks
 * it first if needed. Placement/resize live on the CameraDock; these verbs are the thin bus seam.
 */

import { resolveSurface } from './dockCommands.js';

/** Split-axis vocabulary: h/x → 'x' (side-by-side), v/y → 'y' (stacked). tmux/i3 spelling welcome. */
const AXES = { h: 'x', x: 'x', horizontal: 'x', v: 'y', y: 'y', vertical: 'y' };
const DIRS = ['left', 'right', 'up', 'down'];

const getDock = (ctx) => (ctx.cameraDock && typeof ctx.cameraDock.splitPane === 'function' ? ctx.cameraDock : null);

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerPaneCommands(router) {
    router.register('pane.split', (args, ctx) => {
        const dock = getDock(ctx);
        if (!dock) return { text: 'ERR: camera dock not ready', data: null };
        if (!dock.paneTree || !dock.focusedPane) return { text: 'ERR: no framed pane to split — pin a window first', data: null };
        const axis = AXES[String(args[0] ?? '').toLowerCase()];
        if (!axis) return { text: 'ERR: usage: pane.split <h|v> <id|index>', data: null };
        const r = resolveSurface(ctx, args[1]);
        if (!r) return { text: `ERR: no surface for "${args[1]}" (registry id or surface index)`, data: null };
        if (dock.isFramed(r.id)) return { text: `ERR: '${r.id}' is already a pane`, data: null };
        // The new pane's window must be a live dock entry before it tiles into the frame.
        if (!dock.has(r.id)) router.execute(['dock.lock', r.id]);
        if (!dock.splitPane(axis, r.id)) return { text: `ERR: could not split '${r.id}' into the frame`, data: null };
        const type = ctx.registry?.get?.(r.id)?.type;
        ctx.attentionManager?.set?.('primary', r.id, { registry: ctx.registry });
        ctx.attentionManager?.set?.('key', type === 'terminal' ? r.id : null, { registry: ctx.registry });
        ctx.session?.scheduleSave?.();
        return { text: `OK: split ${axis === 'x' ? 'H' : 'V'} → '${r.id}'`, data: { id: r.id, axis } };
    }, { description: 'Split the active pane, tiling a window into the new leaf (h=side-by-side, v=stacked)', usage: '<h|v> <id|index>', returns: '{ id, axis }' });

    router.register('pane.focus', (args, ctx) => {
        const dock = getDock(ctx);
        if (!dock) return { text: 'ERR: camera dock not ready', data: null };
        const dir = String(args[0] ?? '').toLowerCase();
        if (!DIRS.includes(dir)) return { text: 'ERR: usage: pane.focus <left|right|up|down>', data: null };
        const next = dock.focusPane(dir);
        if (!next) return { text: `ERR: no pane to the ${dir}`, data: null };
        const type = ctx.registry?.get?.(next)?.type;
        ctx.attentionManager?.set?.('primary', next, { registry: ctx.registry });
        ctx.attentionManager?.set?.('key', type === 'terminal' ? next : null, { registry: ctx.registry });
        return { text: `OK: focus ${dir} → '${next}'`, data: { id: next } };
    }, { description: 'Move pane focus to the geometric neighbor in a direction (hjkl-style)', usage: '<left|right|up|down>', returns: '{ id }' });

    router.register('pane.resize', (args, ctx) => {
        const dock = getDock(ctx);
        if (!dock) return { text: 'ERR: camera dock not ready', data: null };
        const axis = AXES[String(args[0] ?? '').toLowerCase()];
        const delta = parseFloat(args[1]);
        if (!axis || !Number.isFinite(delta)) return { text: 'ERR: usage: pane.resize <h|v> <delta> (e.g. 0.05)', data: null };
        if (!dock.resizePane(axis, delta)) return { text: 'ERR: the active pane has no split on that axis to resize', data: null };
        ctx.session?.scheduleSave?.();
        return { text: `OK: resize ${axis} ${delta > 0 ? '+' : ''}${delta}`, data: { axis, delta } };
    }, { description: 'Grow the active pane along an axis (proportional; siblings give up space)', usage: '<h|v> <delta>', returns: '{ axis, delta }' });

    router.register('pane.close', (args, ctx) => {
        const dock = getDock(ctx);
        if (!dock) return { text: 'ERR: camera dock not ready', data: null };
        const id = args[0] != null && args[0] !== '' ? resolveSurface(ctx, args[0])?.id : dock.focusedPane;
        if (!id || !dock.isFramed(id)) return { text: `ERR: '${id ?? args[0]}' is not a framed pane`, data: null };
        dock.unframePane(id); // sibling collapses up, ratios preserved; the window returns to the bar
        ctx.session?.scheduleSave?.();
        return { text: `OK: unframed '${id}' → bar`, data: { id } };
    }, { description: 'Un-frame a pane back to the bar (its sibling collapses up); defaults to the active pane', usage: '[id|index]', returns: '{ id }' });

    router.register('pane.swap', (args, ctx) => {
        const dock = getDock(ctx);
        if (!dock) return { text: 'ERR: camera dock not ready', data: null };
        const a = resolveSurface(ctx, args[0])?.id, b = resolveSurface(ctx, args[1])?.id;
        if (!a || !b) return { text: 'ERR: usage: pane.swap <idA> <idB>', data: null };
        if (!dock.swapPanes(a, b)) return { text: `ERR: could not swap — both must be framed panes`, data: null };
        ctx.session?.scheduleSave?.();
        return { text: `OK: swapped '${a}' ⇄ '${b}'`, data: { a, b } };
    }, { description: 'Exchange two panes in place (positions unchanged, windows swap)', usage: '<idA> <idB>', returns: '{ a, b }' });

    router.register('pane.list', (_args, ctx) => {
        const dock = getDock(ctx);
        if (!dock?.paneTree) return { text: 'OK: nothing framed', data: { panes: [] } };
        const panes = [...dock.paneTree.rects()].map(([id, rect]) => ({ id, rect, active: id === dock.focusedPane }));
        const summary = panes.map((p) => `${p.active ? '*' : ''}${p.id}`).join('  ');
        return { text: `OK: ${panes.length} pane(s) — ${summary}`, data: { panes } };
    }, { description: 'List the frame panes and their normalized rects (the layout tree, flattened)', returns: '{ panes:[{id,rect,active}] }' });
}

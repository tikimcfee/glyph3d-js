/**
 * pane.* commands — the tiling PANE COMPOSITOR. They act on the ACTIVE ARRANGEMENT: the entered
 * plane desk's panes while one is entered (carrel.enter on a plane-form carrel — Carrel's pane
 * operations: stacks of tabs, an inbox, zoom), else the CameraDock's view-frame below.
 *
 * The frame's occupancy is a binary-BSP PaneTree (packages/.../PaneTree.js); a single leaf is the
 * old single-occupant pin (window.pin / dock.spotlight). These verbs GROW and navigate that tree —
 * the i3/tmux/vim intersection an old-school user expects: split, directional focus, proportional
 * resize, swap, un-frame. UI keybindings and the CLI/RPC hit the same verbs (one source of truth).
 *
 * A pane's window must be DOCKED (a live CameraDock entry) to tile into the frame — pane.split docks
 * it first if needed. Placement/resize live on the CameraDock; these verbs are the thin bus seam.
 */

/** @import { AppContext } from '../../client/CommandProvider.jsx' */
import { getSetting } from '../../client/settings.js';

/** Split-axis vocabulary: h/x → 'x' (side-by-side), v/y → 'y' (stacked). tmux/i3 spelling welcome. */
const AXES = { h: 'x', x: 'x', horizontal: 'x', v: 'y', y: 'y', vertical: 'y' };
const DIRS = ['left', 'right', 'up', 'down'];

/** A pane address → its holdable registry id, or null. @param {AppContext} ctx */
const paneId = (ctx, arg) => {
    const r = ctx.holding.resolve(arg);
    return 'error' in r ? null : r.id;
};

/** The entered TILED plane desk, or null (the verbs then drive the CameraDock frame). @param {AppContext} ctx */
const enteredDesk = (ctx) => {
    const desk = enteredPlane(ctx);
    return desk && desk.planeArrange === 'tiles' ? desk : null;
};

/** The entered plane desk (pins or tiles), or null. @param {AppContext} ctx */
const enteredPlane = (ctx) => {
    const n = ctx.enteredCarrel;
    const desk = n ? ctx.carrels?.get?.(n) : null;
    return desk && desk.mode === 'plane' ? desk : null;
};

/** On a pin board: focus a pin and slide the plane's aim to show it. @returns {string|null} */
function focusPin(ctx, desk, idOrDir) {
    const id = DIRS.includes(idOrDir) ? desk.pinFocus(idOrDir) : desk.pinFocusOn(idOrDir);
    if (!id) return null;
    const cc = ctx.cameraController;
    if (cc?.setPlaneAim) {
        const vp = cc.planeViewport();
        const a = desk.pinAim(id, vp, Number(getSetting('plane.topMarginPx')) * (vp.dpr || 1));
        if (a) cc.setPlaneAim(a.x, a.y);
    }
    const type = ctx.registry?.get?.(id)?.type;
    ctx.attentionManager?.set?.('primary', id, { registry: ctx.registry });
    ctx.attentionManager?.set?.('key', type === 'terminal' ? id : null, { registry: ctx.registry });
    return id;
}

/** The answer a tiles-only verb gives on a pin board. */
const tilesOnly = (desk, verb) => ({ text: `ERR: ${verb} arranges tiles — '${desk.carrelName}' is a pin board (carrel.set ${desk.carrelName} planeArrange tiles)`, data: null });

/**
 * Hand attention to the focused pane's front member: primary always, the keyboard when it's a
 * terminal (typing goes where you're looking). @param {AppContext} ctx @returns {string|null}
 */
export function focusPaneFront(ctx, desk) {
    const pane = desk.focusedPane();
    const id = pane ? desk.paneFront(pane) : null;
    if (!id) return null;
    const type = ctx.registry?.get?.(id)?.type;
    ctx.attentionManager?.set?.('primary', id, { registry: ctx.registry });
    ctx.attentionManager?.set?.('key', type === 'terminal' ? id : null, { registry: ctx.registry });
    return id;
}

/** A desk pane address: a pane id, or a member (→ its pane). */
const deskPane = (desk, ctx, arg) => {
    if (arg == null || arg === '') return desk.focusedPane();
    if (desk.panes.stacks.has(String(arg))) return String(arg);
    const id = paneId(ctx, arg);
    return id ? desk.paneOf(id) : null;
};

/** The pane list as text + data (desk or frame). */
const deskPaneList = (desk) => {
    const focus = desk.focusedPane();
    const panes = desk.paneRects().map((p) => ({ ...p, front: desk.paneFront(p.id), focused: p.id === focus }));
    const text = panes.map((p) => `${p.focused ? '*' : ' '}${p.id} ${p.rect.w}×${p.rect.h}+${p.rect.x}+${p.rect.y} ${p.stack.map((id) => (id === p.front ? `[${id}]` : id)).join(' ')}`).join('\n');
    return { panes, text };
};

/**
 * @param {import('../../client/CommandProvider.jsx').AppRouter} router
 */
export default function registerPaneCommands(router) {
    router.register('pane.split', (args, ctx) => {
        const desk = enteredDesk(ctx);
        if (desk) {
            const axis = AXES[String(args[0] ?? '').toLowerCase()];
            if (!axis) return { text: 'ERR: usage: pane.split <h|v> <id|index>', data: null };
            const r = ctx.holding.resolve(args[1]);
            if ('error' in r) return { text: `ERR: ${r.error}`, data: null };
            if (!desk.has(r.id)) ctx.execute(['carrel.add', r.id, desk.carrelName]);   // seat it here first
            if (!desk.has(r.id)) return { text: `ERR: '${r.id}' could not be seated at '${desk.carrelName}'`, data: null };
            const pane = desk.paneSplit(axis, r.id);
            if (!pane) return { text: `ERR: could not split for '${r.id}'`, data: null };
            focusPaneFront(ctx, desk);
            return { text: `OK: split ${axis === 'x' ? 'H' : 'V'} → ${pane} '${r.id}'`, data: { id: r.id, axis, pane } };
        }
        const dock = ctx.holding.dock.live;
        if (!dock) return { text: 'ERR: camera dock not ready', data: null };
        if (!dock.paneTree || !dock.focusedPane) return { text: 'ERR: no framed pane to split — pin a window first', data: null };
        const axis = AXES[String(args[0] ?? '').toLowerCase()];
        if (!axis) return { text: 'ERR: usage: pane.split <h|v> <id|index>', data: null };
        const r = ctx.holding.resolve(args[1]);
        if ('error' in r) return { text: `ERR: ${r.error}`, data: null };
        if (dock.isFramed(r.id)) return { text: `ERR: '${r.id}' is already a pane`, data: null };
        // The new pane's window must be a live dock entry before it tiles into the frame.
        if (!dock.has(r.id)) ctx.execute(['dock.lock', r.id]);
        if (!dock.splitPane(axis, r.id)) return { text: `ERR: could not split '${r.id}' into the frame`, data: null };
        const type = ctx.registry?.get?.(r.id)?.type;
        ctx.attentionManager?.set?.('primary', r.id, { registry: ctx.registry });
        ctx.attentionManager?.set?.('key', type === 'terminal' ? r.id : null, { registry: ctx.registry });
        ctx.session?.scheduleSave?.();
        return { text: `OK: split ${axis === 'x' ? 'H' : 'V'} → '${r.id}'`, data: { id: r.id, axis } };
    }, { description: 'Split the active pane, tiling a window into the new leaf (h=side-by-side, v=stacked)', usage: '<h|v> <id|index>', returns: '{ id, axis }' });

    router.register('pane.focus', (args, ctx) => {
        const board = enteredPlane(ctx);
        if (board && board.planeArrange === 'pins') {
            const a = String(args[0] ?? '').toLowerCase();
            const target = DIRS.includes(a) ? a : (paneId(ctx, args[0]) ?? String(args[0] ?? ''));
            const id = focusPin(ctx, board, target);
            if (!id) return { text: DIRS.includes(a) ? `ERR: no pin to the ${a}` : `ERR: no pin '${args[0] ?? ''}' on '${board.carrelName}'`, data: null };
            return { text: `OK: focus → '${id}'`, data: { id } };
        }
        const desk = enteredDesk(ctx);
        if (desk) {
            const a = String(args[0] ?? '').toLowerCase();
            const pane = DIRS.includes(a) ? desk.paneFocus(a) : desk.paneFocusOn(deskPane(desk, ctx, args[0]) ?? '');
            if (!pane) return { text: DIRS.includes(a) ? `ERR: no pane to the ${a}` : `ERR: no pane '${args[0] ?? ''}' (a direction, a pane id or a member)`, data: null };
            const id = focusPaneFront(ctx, desk);
            return { text: `OK: focus → ${pane}${id ? ` '${id}'` : ''}`, data: { pane, id } };
        }
        const dock = ctx.holding.dock.live;
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
        const axis = AXES[String(args[0] ?? '').toLowerCase()];
        const delta = parseFloat(args[1]);
        if (!axis || !Number.isFinite(delta)) return { text: 'ERR: usage: pane.resize <h|v> <delta> (e.g. 0.05)', data: null };
        const desk = enteredDesk(ctx);
        if (desk) {
            if (!desk.paneResize(axis, delta)) return { text: 'ERR: the focused pane has no split on that axis to resize', data: null };
            return { text: `OK: resize ${axis} ${delta > 0 ? '+' : ''}${delta}`, data: { axis, delta } };
        }
        const dock = ctx.holding.dock.live;
        if (!dock) return { text: 'ERR: camera dock not ready', data: null };
        if (!dock.resizePane(axis, delta)) return { text: 'ERR: the active pane has no split on that axis to resize', data: null };
        ctx.session?.scheduleSave?.();
        return { text: `OK: resize ${axis} ${delta > 0 ? '+' : ''}${delta}`, data: { axis, delta } };
    }, { description: 'Grow the active pane along an axis (proportional; siblings give up space)', usage: '<h|v> <delta>', returns: '{ axis, delta }' });

    router.register('pane.close', (args, ctx) => {
        const desk = enteredDesk(ctx);
        if (desk) {
            const pane = deskPane(desk, ctx, args[0]);
            if (!pane) return { text: `ERR: no pane '${args[0] ?? ''}'`, data: null };
            const into = desk.paneClose(pane);
            if (!into) return { text: `ERR: '${pane}' is the last pane`, data: null };
            focusPaneFront(ctx, desk);
            return { text: `OK: closed ${pane} — its tabs joined ${into}`, data: { pane, into } };
        }
        const dock = ctx.holding.dock.live;
        if (!dock) return { text: 'ERR: camera dock not ready', data: null };
        const id = args[0] != null && args[0] !== '' ? paneId(ctx, args[0]) : dock.focusedPane;
        if (!id || !dock.isFramed(id)) return { text: `ERR: '${id ?? args[0]}' is not a framed pane`, data: null };
        dock.unframePane(id); // sibling collapses up, ratios preserved; the window returns to the bar
        ctx.session?.scheduleSave?.();
        return { text: `OK: unframed '${id}' → bar`, data: { id } };
    }, { description: 'Un-frame a pane back to the bar (its sibling collapses up); defaults to the active pane', usage: '[id|index]', returns: '{ id }' });

    router.register('pane.swap', (args, ctx) => {
        const desk = enteredDesk(ctx);
        if (desk) {
            const a = deskPane(desk, ctx, args[0]), b = deskPane(desk, ctx, args[1]);
            if (!a || !b || !desk.paneSwap(a, b)) return { text: 'ERR: usage: pane.swap <paneA|member> <paneB|member>', data: null };
            focusPaneFront(ctx, desk);
            return { text: `OK: swapped ${a} ⇄ ${b}`, data: { a, b } };
        }
        const dock = ctx.holding.dock.live;
        if (!dock) return { text: 'ERR: camera dock not ready', data: null };
        const a = paneId(ctx, args[0]), b = paneId(ctx, args[1]);
        if (!a || !b) return { text: 'ERR: usage: pane.swap <idA> <idB>', data: null };
        if (!dock.swapPanes(a, b)) return { text: `ERR: could not swap — both must be framed panes`, data: null };
        ctx.session?.scheduleSave?.();
        return { text: `OK: swapped '${a}' ⇄ '${b}'`, data: { a, b } };
    }, { description: 'Exchange two panes in place (positions unchanged, windows swap)', usage: '<idA> <idB>', returns: '{ a, b }' });

    router.register('pane.zoom', (args, ctx) => {
        const desk = enteredDesk(ctx);
        if (!desk) return enteredPlane(ctx) ? tilesOnly(enteredPlane(ctx), 'pane.zoom') : { text: 'ERR: pane.zoom works inside a plane desk (carrel.enter <name>)', data: null };
        const a = String(args[0] ?? '').toLowerCase();
        const z = desk.paneZoom(a === 'on' ? true : a === 'off' ? false : undefined);
        focusPaneFront(ctx, desk);
        return { text: z ? `OK: zoomed ${z} to the whole plane` : 'OK: unzoomed', data: { zoomed: z } };
    }, { description: 'Zoom the focused pane to the whole plane, or back (tmux -Z)', usage: '[on|off]', returns: '{ zoomed }' });

    router.register('pane.tab', (args, ctx) => {
        const desk = enteredDesk(ctx);
        if (!desk) return enteredPlane(ctx) ? tilesOnly(enteredPlane(ctx), 'pane.tab') : { text: 'ERR: pane.tab works inside a plane desk (carrel.enter <name>)', data: null };
        const a = String(args[0] ?? 'next');
        const which = a === 'next' || a === 'prev' ? a : paneId(ctx, a);
        const id = which ? desk.paneTab(which) : null;
        if (!id) return { text: `ERR: no tab '${a}' in the focused pane`, data: null };
        focusPaneFront(ctx, desk);
        return { text: `OK: tab → '${id}'`, data: { id } };
    }, { description: "Change the focused pane's active tab (next|prev|a member)", usage: '[next|prev|id]', returns: '{ id }' });

    router.register('pane.place', (args, ctx) => {
        const desk = enteredDesk(ctx);
        if (!desk) return enteredPlane(ctx) ? tilesOnly(enteredPlane(ctx), 'pane.place') : { text: 'ERR: pane.place works inside a plane desk (carrel.enter <name>)', data: null };
        const r = ctx.holding.resolve(args[0]);
        if ('error' in r) return { text: `ERR: ${r.error}`, data: null };
        const target = deskPane(desk, ctx, args[1]);
        const where = String(args[2] ?? 'tab').toLowerCase();
        if (!target || !['tab', ...DIRS].includes(where)) return { text: 'ERR: usage: pane.place <id> <pane|member> <tab|left|right|up|down>', data: null };
        if (!desk.has(r.id)) ctx.execute(['carrel.add', r.id, desk.carrelName]);
        const pane = desk.has(r.id) ? desk.panePlace(r.id, target, where) : null;
        if (!pane) return { text: `ERR: could not place '${r.id}'`, data: null };
        focusPaneFront(ctx, desk);
        return { text: `OK: '${r.id}' → ${pane} (${where})`, data: { id: r.id, pane, where } };
    }, { description: 'Put a window in a pane: as its active tab, or a new pane split off one side (seats it at the desk if needed)', usage: '<id> <pane|member> <tab|left|right|up|down>', returns: '{ id, pane, where }' });

    router.register('pane.layout', (args, ctx) => {
        const desk = enteredDesk(ctx);
        if (!desk) return enteredPlane(ctx) ? tilesOnly(enteredPlane(ctx), 'pane.layout') : { text: 'ERR: pane.layout works inside a plane desk (carrel.enter <name>)', data: null };
        if (!desk.layoutPanes(String(args[0] ?? ''))) return { text: 'ERR: usage: pane.layout <even|main|stack>', data: null };
        focusPaneFront(ctx, desk);
        return { text: `OK: laid out ${args[0]} — ${desk.paneRects().length} pane(s)`, data: deskPaneList(desk) };
    }, { description: "Re-lay the entered plane desk's panes as a named layout", usage: '<even|main|stack>', returns: '{ panes, text }' });

    router.register('pane.list', (_args, ctx) => {
        const board = enteredPlane(ctx);
        if (board && board.planeArrange === 'pins') {
            const focus = board.focusedPin();
            const pins = board.pinRects();
            const text = pins.map((p) => `${p.id === focus ? '*' : ' '}${p.id} ${p.rect.w}×${p.rect.h}+${p.rect.x}+${p.rect.y}${p.ghost ? ' (ghost — carrel.settle repacks)' : ''}`).join('\n');
            return { text: `OK: '${board.carrelName}' — ${pins.length} pin(s)\n${text}`, data: { desk: board.carrelName, arrange: 'pins', focus, pins } };
        }
        const desk = enteredDesk(ctx);
        if (desk) {
            const l = deskPaneList(desk);
            return { text: `OK: '${desk.carrelName}' — ${l.panes.length} pane(s)\n${l.text}`, data: { desk: desk.carrelName, panes: l.panes } };
        }
        const dock = ctx.holding.dock.live;
        if (!dock?.paneTree) return { text: 'OK: nothing framed', data: { panes: [] } };
        const panes = [...dock.paneTree.rects()].map(([id, rect]) => ({ id, rect, active: id === dock.focusedPane }));
        const summary = panes.map((p) => `${p.active ? '*' : ''}${p.id}`).join('  ');
        return { text: `OK: ${panes.length} pane(s) — ${summary}`, data: { panes } };
    }, { description: 'List the frame panes and their normalized rects (the layout tree, flattened)', returns: '{ panes:[{id,rect,active}] }' });
}

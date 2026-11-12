/**
 * The IDE's TerminalHost (core services/terminal/TerminalHost.js): what the terminal verbs defer to
 * this app for.
 *
 *   theme      the Settings theme (terminalTheme) — a new terminal spawns in the current scheme
 *   place      in the viewer's CURRENT view, not at the world origin: the inverse of camera.focus,
 *              it moves the terminal in front of a still camera (no camera yet → the origin)
 *   landed     lock into the dock, then PIN it — spotlight raises the tile into the dock's focus
 *              pane (the modal "new terminal tab": centered, enlarged, keyboard-live) — then
 *              terminal.focus (the no-dock fallback, an idempotent re-set otherwise). Composed from
 *              verbs, so a spawn behaves exactly like typing them at the CLI.
 *   focus      attention primary (sticky/UI focus) AND key (keystroke target), with the registry
 *              entry as the entity so the keyboard router (keyed on entity.type) can route to it
 *   release    a held terminal (docked tile, carrel seat) lifts out where it hangs
 *   resizing   an agent's screen shows the agent's OWN pane: a resize writes back — the relay
 *              resizes the agent's tmux window (no client), its CLI reflows, the redraw streams in at
 *              the new size. The note is where the terminal sits in the dock.
 *   surfaces   the WorkspaceModel's surface records — the one decider of a terminal's size and
 *              position across reloads (SessionStore re-pushes them as grids re-adopt)
 */

import { terminalTheme } from './settings.js';
/** @import { TerminalHost } from '@glyph3d/core/services/terminal/TerminalHost.js' */
/** @import { AppContext, AppRouter } from './CommandProvider.jsx' */

/**
 * @param {AppContext} ctx
 * @param {AppRouter} router
 * @returns {TerminalHost}
 */
export default function createIdeTerminalHost(ctx, router) {
    return {
        theme: terminalTheme,

        place(grid) {
            ctx.cameraController?.placeInView?.(grid);
        },

        async landed(id) {
            await router.execute(`dock.lock ${id}`);
            await router.execute(`dock.spotlight ${id}`);
            await router.execute(`terminal.focus ${id}`);
            return 'pinned in the dock + focused';
        },

        focus(id) {
            const entity = ctx.registry.get(id) || null;
            ctx.attentionManager.set('primary', id, { entity });
            ctx.attentionManager.set('key', id, { entity });
            return { ok: true, text: 'primary + key' };
        },

        release(id) {
            if (ctx.holding.holderOf(id)) ctx.holding.lift(id, { inPlace: true });
        },

        resizing(id, cols, rows) {
            const screenOf = ctx.gomuxHub?.screenAgent(id);
            if (screenOf && ctx.wsbridge?.connected) {
                ctx.wsbridge.send(JSON.stringify({ relay: 'gomux.resize', name: screenOf, cols, rows }));
            }
            const dock = ctx.cameraDock;
            if (!dock?.has(id)) return '';
            return dock.focusedPane === id ? '[focus]' : (dock.isFramed(id) ? '[pane]' : '[docked]');
        },

        surfaces: {
            get: (id) => ctx.workspace.getSurface(id),
            set: (id, view) => ctx.workspace.setSurfaceView(id, 'terminal', view),
            remove: (id) => ctx.workspace.removeSurface(id),
        },
    };
}

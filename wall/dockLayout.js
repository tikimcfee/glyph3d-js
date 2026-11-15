/**
 * dockLayout — where the wall's docked panels sit. Each panel (the sidebar, the termd status window,
 * the settings, the help) floats or sticks to the left or right edge; panels stuck to the same edge
 * sit side by side — the sidebar at the edge, then the status window, then the settings, then the
 * help. The topbar keeps clear of them, and a fullscreen terminal fills what they leave
 * (WallFullscreen). No DOM, no React: the panels (Panel.jsx and its users), the chrome (main.jsx)
 * and the wall itself read it.
 */

/** A docked panel's width, CSS px. */
export const DOCK_WIDTHS = Object.freeze({ sidebar: 248, status: 440, settings: 380, help: 400 });

/** The gap the topbar keeps from the canvas edge (or from a docked panel), CSS px. */
const EDGE = 12;

/**
 * Where the docked panels sit: each one's offset from its edge, the width docked on each edge, and
 * how far the topbar stays in from each edge. (A state without a settings or help panel has it closed.)
 * @param {{ sidebar: { open: boolean, side: string }, statusWindow: { open: boolean, side: string },
 *           settingsPanel?: { open: boolean, side: string }, helpPanel?: { open: boolean, side: string } }} state
 * @returns {{ sidebar: number, status: number, settings: number, help: number,
 *             edges: { left: number, right: number }, inset: { left: number, right: number } }}
 */
export function dockLayout(state) {
    const docked = (p) => p.open && (p.side === 'left' || p.side === 'right');
    const used = { left: 0, right: 0 };
    let sidebar = 0, status = 0, settings = 0, help = 0;
    if (docked(state.sidebar)) { sidebar = used[state.sidebar.side]; used[state.sidebar.side] += DOCK_WIDTHS.sidebar; }
    if (docked(state.statusWindow)) { status = used[state.statusWindow.side]; used[state.statusWindow.side] += DOCK_WIDTHS.status; }
    if (state.settingsPanel && docked(state.settingsPanel)) { settings = used[state.settingsPanel.side]; used[state.settingsPanel.side] += DOCK_WIDTHS.settings; }
    if (state.helpPanel && docked(state.helpPanel)) { help = used[state.helpPanel.side]; used[state.helpPanel.side] += DOCK_WIDTHS.help; }
    return { sidebar, status, settings, help, edges: { ...used }, inset: { left: used.left + EDGE, right: used.right + EDGE } };
}

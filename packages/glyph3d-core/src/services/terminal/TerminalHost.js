/**
 * TerminalHost — what an application gives the terminal verbs (services/terminal/terminalCommands.js)
 * so they can run in it. The verbs own the terminal itself: the grid, the registry entry, the relay
 * pushes to its adapter. The host owns everything around it that differs per application: where a
 * new terminal lands, what a finished spawn shows, what focus means, what holds a terminal, what
 * persists its view.
 *
 * Every member is required. An application with nothing to do for one says so with an explicit
 * no-op; a missing member is a wiring bug, and `assertTerminalHost` names it at boot.
 *
 * @typedef {Object} TerminalHost
 * @property {() => Object} theme
 *   Options a new TerminalGrid is born with (background, cursor). `{}` takes TerminalGrid's defaults.
 * @property {(grid: import('../../collections/TerminalGrid.js').default) => void} place
 *   Position a newly created grid (before it registers).
 * @property {(id: string) => Promise<string>|string} landed
 *   A terminal this display spawned has arrived: show it and give it the keys. Returns a short note
 *   for terminal.spawn's reply ("focused + framed").
 * @property {(id: string) => { ok: boolean, text?: string }} focus
 *   Make the terminal the keyboard target. `text` explains a refusal.
 * @property {(id: string) => void} release
 *   Before terminal.move places a terminal by coordinates: take it out of anything holding it, so
 *   the coordinates are in its own frame.
 * @property {(id: string, cols: number, rows: number) => string} resizing
 *   A resize was asked for (before the PTY is told): the host's own side effects. Returns a note
 *   for the resize log line, '' for none.
 * @property {{ get(id: string): (Object|null), set(id: string, view: Object): void, remove(id: string): void }} surfaces
 *   The terminal's persisted view (`{ cols?, rows?, position? }`): read on create (an existing one
 *   isn't overwritten), written on create / resize / move, dropped on close.
 */

/**
 * The context the terminal verbs run in. An application's own context carries these alongside
 * whatever else it has.
 * @typedef {Object} TerminalContext
 * @property {import('three').Scene} scene
 * @property {Object} atlas - the GlyphAtlas new grids render from
 * @property {import('../SceneRegistry.js').default} registry
 * @property {Map<string, import('../../collections/TerminalGrid.js').default>} terminals
 * @property {import('../orchestration/WebSocketBridge.js').default|null} wsbridge
 * @property {string|null} [sender] - set per call by CommandRouter (the calling controller's id)
 * @property {TerminalHost} terminalHost
 */

const MEMBERS = ['theme', 'place', 'landed', 'focus', 'release', 'resizing'];
const SURFACE_MEMBERS = ['get', 'set', 'remove'];

/**
 * Throw, naming every missing member, unless `host` is a complete TerminalHost.
 * @param {any} host
 * @param {string} who - the application installing it, for the message
 * @returns {TerminalHost}
 */
export function assertTerminalHost(host, who) {
    if (!host || typeof host !== 'object') {
        throw new Error(`[terminal] ${who}: the terminal host is ${host === null ? 'null' : typeof host}, not an object`);
    }
    const missing = MEMBERS.filter((k) => typeof host[k] !== 'function');
    if (!host.surfaces || typeof host.surfaces !== 'object') missing.push('surfaces');
    else missing.push(...SURFACE_MEMBERS.filter((k) => typeof host.surfaces[k] !== 'function').map((k) => `surfaces.${k}`));
    if (missing.length) {
        throw new Error(`[terminal] ${who}: the terminal host is missing ${missing.join(', ')} — every member is required (an explicit no-op where there's nothing to do)`);
    }
    return host;
}

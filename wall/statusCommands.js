/**
 * The wall's termd status verbs — the status window and its notice. The topbar's termd chip, the
 * window's own buttons and the chord (S) run these (through `wall.run`), and the CLI reaches them
 * over the relay like any verb (`./glyph3d-cli --port N wall.status`). termd's state itself comes
 * from the relay (`./glyph3d-cli termd.status` answers page-less); these only show it.
 *
 *   wall.status [toggle|open|close|left|right|float [x y]]   the window: toggle, or place it
 *   wall.status.dismiss                                      put away the termd-lost notice
 *   wall.status.config [<knob> [value]]                      the window's knobs (STATUS_CONFIG)
 *
 * A refusal answers ERR with why; nothing is half-done.
 *
 * @param {import('@glyph3d/core/services/orchestration/CommandRouter.js').default} router
 * @param {import('./TerminalWall.js').default} wall
 */
export default function registerStatusCommands(router, wall) {
    const OK = (text, data = null) => ({ text: `OK: ${text}`, data });
    const ERR = (text) => ({ text: `ERR: ${text}`, data: null });
    const verb = (name, usage, description, fn) => router.register(name, (args) => {
        try { return fn(args); } catch (e) { return ERR(e.message); }
    }, { usage, description });
    const numArg = (s, what) => {
        const n = Number(s);
        if (s == null || !Number.isFinite(n)) throw new Error(`${what} takes a number, not '${s}'`);
        return n;
    };

    verb('wall.status', '[toggle|open|close|left|right|float [x y]]', "Open, close or place the termd status window", (args) => {
        const [what = 'toggle', x, y] = args;
        const s = wall.store.statusWindow();
        if (what === 'toggle') wall.setStatusWindow({ open: !s.open });
        else if (what === 'open' || what === 'close') wall.setStatusWindow({ open: what === 'open' });
        else if (what === 'left' || what === 'right') wall.setStatusWindow({ open: true, side: what });
        else if (what === 'float') {
            const patch = { open: true, side: 'float' };
            if (x != null) patch.float = { x: numArg(x, 'x'), y: numArg(y, 'y') };
            wall.setStatusWindow(patch);
        } else throw new Error(`the status window takes toggle|open|close|left|right|float, not '${what}'`);
        const now = wall.store.statusWindow();
        return OK(`status window ${now.open ? `open, ${now.side}` : 'closed'} · termd ${wall.termd.state}`, { window: now, termd: wall.termd.state });
    });

    verb('wall.status.dismiss', '', 'Put away the termd-lost notice', () => {
        return wall.termd.dismissLost() ? OK('dismissed the termd-lost notice') : OK('no termd-lost notice to dismiss');
    });

    verb('wall.status.config', '[<knob> [value]]', "Read or set the status window's knobs", (args) => {
        const [key, value] = args;
        const cfg = wall.statusConfig;
        if (!key) return { text: Object.entries(cfg).map(([k, v]) => `${k} ${v}`).join('\n'), data: { ...cfg } };
        const v = value == null ? (checkStatusConfig(key, cfg[key]), cfg[key]) : (cfg[key] = checkStatusConfig(key, value));
        wall.setStatusWindow({});
        return OK(`${key} ${v}`, { [key]: v });
    });
}

/**
 * The status window's knobs, born configurable: `new TerminalWall({ …, statusConfig })` overrides
 * any of them, and `wall.status.config <knob> <value>` dials one live.
 */
export const STATUS_CONFIG = Object.freeze({
    /**
     * A brain restart shows its notice only once it has lasted this long, ms: a crash restart that
     * comes back in a blink shows only the amber chip (DESIGN.md "Status: in the app"); one that
     * lingers says so in words. Unreachable, failed and lost show at once.
     */
    restartNoticeMs: 400,
    /** Recent errors the window lists, newest first (the document keeps more; `--json` has them all). */
    errorsShown: 3,
});

/** @typedef {{ -readonly [K in keyof typeof STATUS_CONFIG]: (typeof STATUS_CONFIG)[K] }} StatusConfig */

/**
 * Check one knob's value, coerced from a string when it came from a verb. Throws naming the knob.
 * @param {string} key @param {any} value @returns {number}
 */
function checkStatusConfig(key, value) {
    if (!(key in STATUS_CONFIG)) throw new Error(`unknown status knob '${key}' (knobs: ${Object.keys(STATUS_CONFIG).join(', ')})`);
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${key} takes a number ≥ 0, not '${value}'`);
    if (key === 'errorsShown' && !Number.isInteger(n)) throw new Error(`errorsShown takes a whole number, not '${value}'`);
    return n;
}

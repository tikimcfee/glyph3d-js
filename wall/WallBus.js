import GomuxProvider from '@glyph3d/core/services/data/GomuxProvider.js';

/**
 * WallBus — the gomuxai agents the wall can attach to, as the relay sees them: the tree the relay
 * keeps from `agent export` (cli/gomux.go; `gomux/list`, pushed whole as `gomux/changed`).
 *
 *   - On THIS host (`localBusName`), `wall.attach` asks the relay (`gomux.attach`) to subscribe a
 *     Wall terminal (`gx-<name>`) directly to the agent's `g3d-termd` session (`--ns agents`,
 *     `--detach-on-kill`, `--flow lossy`) — zero wrapper shell, native 10k-line scrollback, and
 *     closing the Wall pane only detaches the viewer.
 *   - On ANOTHER host (`name@host`), `wall.attach` opens a terminal in `wall`'s own `termd`
 *     namespace running `agent attach <name>@<host>` (`attachArgv`, which hops over `ssh -t` to the
 *     remote host's `g3d attach --take`; `Ctrl-\` twice detaches).
 *
 * An agent's `host` is the bus's name for the machine it runs on (the relay names this one's too, so
 * a target here reads `name@<this host>`; the snapshot's `host` is this machine's name); absent
 * means this machine. The relay's export lists only its own host's agents until it follows the bus
 * (`serve --gomuxai-hosts`, export's `--hosts`); then one node per (host, name), and a far host that
 * couldn't say whether a session exists leaves `attached` out.
 *
 * The pure helpers (busTarget, localBusName, gomuxScreenId, busHosts, attachArgv, …) take no wall and
 * touch no DOM, so the unit test imports them as they are.
 */

/** gomuxai's name pattern, for agents and hosts alike (ARCHITECTURE.md, "Subjects"). */
const NAME = '[A-Za-z0-9][A-Za-z0-9_-]*';
const TARGET = new RegExp(`^${NAME}(@${NAME})?$`);

/** What each status means at a glance (gomuxai's `agent statuses`), and the order a host lists them in. */
export const BUS_STATUSES = Object.freeze({
    waiting: { rank: 0, colour: '#f2b45a', word: 'waiting' },     // blocked on a person: first
    error: { rank: 1, colour: '#ef6f6c', word: 'error' },
    processing: { rank: 2, colour: '#7fb0ff', word: 'processing' },
    idle: { rank: 3, colour: '#8ef0b8', word: 'idle' },
    unknown: { rank: 4, colour: '#8b95a7', word: 'unknown' },
    ended: { rank: 5, colour: '#5d6574', word: 'ended' },
});

/** @param {string|undefined} status */
export const busStatus = (status) => BUS_STATUSES[status] ?? BUS_STATUSES.unknown;

/**
 * Whether `s` names an agent the way `agent attach` takes one: `name` or `name@host`.
 * @param {string} s
 */
export const isBusTarget = (s) => typeof s === 'string' && TARGET.test(s);

/**
 * What `agent attach` takes for an agent: its name, or `name@host` for one on another host.
 * @param {{ name: string, host?: string }} a
 */
export const busTarget = (a) => (a.host ? `${a.name}@${a.host}` : a.name);

/**
 * If `target` (`name` or `name@host`) names an agent on THIS machine (no `@host`, or `@<snap.host>`
 * when `snap.host` is known), returns its bare local `name`; otherwise `null` (a remote host, or an
 * `@host` before `snap` has named this machine).
 * @param {string} target
 * @param {{ host?: string }|null|undefined} [snap]
 * @returns {string|null}
 */
export function localBusName(target, snap = null) {
    if (!isBusTarget(target)) return null;
    const at = target.indexOf('@');
    if (at < 0) return target;
    return snap?.host && target.slice(at + 1) === snap.host ? target.slice(0, at) : null;
}

/**
 * Display terminal id for a local gomuxai agent's direct `termd` subscription (`cli/gomux.go` `gomuxTerminalID`).
 * @param {string} name
 */
export function gomuxScreenId(name) {
    return 'gx-' + String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 61);
}

/**
 * Whether the agent has a live `termd` session to attach to. A host that couldn't say leaves
 * `attached` out: unknown is not "no", so only a stated `false` refuses.
 * @param {{ attached?: boolean }} a
 */
export const busAttachable = (a) => a.attached !== false;

/**
 * The live agents (not cleaned up) by host: this machine's first (the snapshot's `host`, or an
 * agent naming none), then the others by name; each host's agents those waiting on a person first, then by status, then by name.
 * @param {import('@glyph3d/core/services/data/GomuxProvider.js').GomuxSnapshot|null} snap
 * @returns {{ host: string, agents: (import('@glyph3d/core/services/data/GomuxProvider.js').GomuxAgent & { host?: string, target: string })[] }[]}
 */
export function busHosts(snap) {
    const by = new Map();
    for (const a of snap?.agents ?? []) {
        if (!a?.live || !a.name) continue;
        const host = a.host || '';
        if (!by.has(host)) by.set(host, []);
        by.get(host).push({ ...a, target: busTarget(a) });
    }
    for (const list of by.values()) {
        list.sort((x, y) => busStatus(x.status).rank - busStatus(y.status).rank || x.name.localeCompare(y.name));
    }
    const here = (/** @type {string} */ h) => (h === '' || h === snap?.host ? 0 : 1);
    return [...by.keys()]
        .sort((x, y) => here(x) - here(y) || x.localeCompare(y))
        .map((host) => ({ host, agents: by.get(host) }));
}

/**
 * What a dead attach client leaves switched on, switched off (printf's octal escapes): mouse
 * reporting (1000, 1002, 1003) and its encodings (1006, 1015), focus events (1004), bracketed paste
 * (2004), the alternate screen (1049), a hidden cursor (25), the last SGR.
 */
const ATTACH_RESET = ['?1000l', '?1002l', '?1003l', '?1006l', '?1015l', '?1004l', '?2004l', '?1049l', '?25h', '0m'].map((m) => `\\033[${m}`).join('');

/**
 * The program a remote `wall.attach <name>@<host>` terminal runs: `agent attach <target>` (with the
 * login shell's PATH when termd's lacks `agent`), and — when the attach fails or dies (no session,
 * ssh refused or dropped, no `agent` on PATH) — its reason held on screen, rather than a terminal
 * that closes before anyone reads why: Enter attaches again, `q` then Enter (or end of input)
 * closes. A client that died (a dropped ssh) never gave the terminal back, so the script takes it
 * back first — mouse reporting, focus events and bracketed paste off, the main screen, a shown
 * cursor, a sane tty — else the wall's wheel and clicks arrive as text over the reason, and a raw
 * tty never hears the Enter. A clean detach (`Ctrl-\` twice in `g3d attach`) or the agent's session
 * ending exits 0 and closes the terminal, as any program's end does. The target rides as `$1`,
 * never inside the script.
 * @param {string} target - `name` or `name@host` (isBusTarget)
 * @returns {string[]}
 */
export function attachArgv(target) {
    if (!isBusTarget(target)) throw new Error(`'${target}' isn't an agent name (name or name@host)`);
    const script = [
        // termd starts this program, not the person's login shell, so the PATH that shell builds
        // (~/.local/bin from ~/.zprofile, say: where gomuxai installs `agent`) is borrowed from it.
        'command -v agent >/dev/null 2>&1 || PATH="$("${SHELL:-/bin/sh}" -lc \'printf %s "$PATH"\' 2>/dev/null):$PATH"',
        'while :; do',
        '  agent attach "$1"; s=$?',
        '  [ "$s" -eq 0 ] && exit 0',
        `  printf '${ATTACH_RESET}'`,
        '  stty sane 2>/dev/null',
        `  printf '\\r\\n[agent attach %s ended with status %d. Enter attaches again; q then Enter closes.]\\r\\n' "$1" "$s"`,
        '  read -r a || exit 0',
        '  [ "$a" = q ] && exit 0',
        'done',
    ].join('\n');
    return ['sh', '-c', script, 'wall-attach', target];
}

export default class WallBus {
    /** @param {() => void} onChange - the tree moved, or the relay stopped (or started) having one */
    constructor(onChange) {
        this._onChange = onChange;
        /** @type {import('@glyph3d/core/services/data/GomuxProvider.js').GomuxSnapshot|null} */
        this.snapshot = null;
        /** Why there is no tree (no relay yet, or one started with --no-gomuxai); '' when there is one. */
        this.reason = 'not connected to the relay';
        /** @type {GomuxProvider|null} */
        this._provider = null;
        this._off = null;
    }

    /** @param {import('@glyph3d/core/services/orchestration/WebSocketBridge.js').default} bridge */
    start(bridge) {
        this._provider = new GomuxProvider(bridge);
        this._off = this._provider.onChange((snap) => this._take(snap, ''));
    }

    stop() {
        this._off?.();
        this._off = null;
        this._provider = null;
        this._take(null, 'not connected to the relay');
    }

    /** Pull the tree (on each registration — pushes only announce changes). */
    async refresh() {
        if (!this._provider) return;
        try {
            this._take(await this._provider.list(), '');
        } catch (e) {
            const why = String(e?.message || e);
            if (why !== this.reason) console.info(`[wall] no gomuxai agents from the relay: ${why}`);
            this._take(null, why);
        }
    }

    /** @param {any} snap @param {string} reason */
    _take(snap, reason) {
        this.snapshot = snap;
        this.reason = reason;
        this._onChange();
    }

    /** The live agents by host (busHosts). */
    hosts() { return busHosts(this.snapshot); }

    /**
     * The live agent `target` names (`name` or `name@host`), or null when the tree doesn't list it.
     * A bare `name` also matches this machine's `name@<snapshot.host>` when the relay names its host.
     * @param {string} target
     */
    find(target) {
        const hs = this.hosts();
        for (const h of hs) for (const a of h.agents) if (a.target === target) return a;
        if (target && !target.includes('@') && this.snapshot?.host) {
            for (const h of hs) {
                if (h.host !== this.snapshot.host) continue;
                for (const a of h.agents) if (a.name === target) return a;
            }
        }
        return null;
    }
}

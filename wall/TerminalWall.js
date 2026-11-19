import CommandRouter from '@glyph3d/core/services/orchestration/CommandRouter.js';
import WebSocketBridge, {
    normalizeRelayHost,
    redactCommandArgs,
    redactRelaySecrets,
} from '@glyph3d/core/services/orchestration/WebSocketBridge.js';
import { installConsoleForwarder } from '@glyph3d/core/services/orchestration/consoleForwarder.js';
import { installInputTrace } from './inputTrace.js';
import TerminalGrid from '@glyph3d/core/collections/TerminalGrid.js';
import SceneSystems from '@glyph3d/core/collections/SceneSystems.js';
import { BORDER_FLAGS } from '@glyph3d/core/collections/panelMaterial.js';
import registerTerminalCommands, { routeTerminalOutput } from '@glyph3d/core/services/terminal/terminalCommands.js';
import { assertTerminalHost } from '@glyph3d/core/services/terminal/TerminalHost.js';
import TermdStatus from '@glyph3d/core/services/terminal/TermdStatus.js';
import WallCamera from './WallCamera.js';
import WallStore from './WallStore.js';
import WallNames from './WallNames.js';
import WallPointer from './WallPointer.js';
import WallKeys from './WallKeys.js';
import WallGroups from './WallGroups.js';
import BarButtons from './BarButtons.js';
import WallMenu from './WallMenu.js';
import SelectionOverlay from './SelectionOverlay.js';
import WallPaper from './WallPaper.js';
import WallFullscreen from './WallFullscreen.js';
import WallAgentViews from './WallAgentViews.js';
import WallBus, { attachArgv, busAttachable, busStatus, isBusTarget } from './WallBus.js';
import registerWallCommands from './wallCommands.js';
import { setGlyphLineStyle } from '@glyph3d/core/core/glyphMaterial.js';
import { WALL_CONFIG, LINE_STYLE_KNOBS, checkConfig } from './wallConfig.js';
import { freeFlowSlot, unionRect, hitTest, cycle, zStackLayout, readingOrder } from './wallLayout.js';
import { neighbor } from './splitTree.js';
import { snapStep, snapTo } from './wallSnap.js';

/** Border band width a pointer can grab, in CSS px (converted to world units per zoom). */
const EDGE_GRAB_PX = 7;
/** Framing a terminal never magnifies its rows past this line height (CSS px): fit, but capped. */
const FRAME_MAX_LINE_PX = 28;
const BORDER_STYLE = { color: 0x3b4352, width: 1.5, intensity: 1 };
/** How long the wall waits for the relay's terminal.recovered reply before giving up on pruning. */
const RECOVER_REPLY_MS = 15000;
/**
 * What a terminal on the wall is born with (the TerminalHost's theme, over TerminalGrid's defaults):
 * an opaque panel, so the canvas's grid never shows through a terminal — plus the knobs' font family
 * and bold colour (_terminalHost).
 */
const TERMINAL_THEME = Object.freeze({ backgroundOpacity: 1 });

/** The knobs that are every terminal's selection style (TerminalGrid.setSelectionStyle), and how each reaches it. */
const SELECTION_STYLE_KNOBS = Object.freeze({
    selectionColor: (v) => ({ background: v }),
    selectionForeground: (v) => ({ foreground: v === 'keep' ? null : v }),
    selectionWordChars: (v) => ({ wordChars: v }),
});

/**
 * A terminal's world rect, from its own pose — position + local bounds × scale. Wall terminals sit
 * directly under the scene, unrotated, so this is exact at any moment. It deliberately does NOT
 * read matrixWorld (getBounds): SceneTransforms refreshes world matrices lazily at render, so a
 * burst of terminals placed between two renders would all read stale origins — that stacked
 * re-adopted terminals 4-deep on one slot (4× glyph overdraw when framed: 116 ms GPU frames).
 * @param {TerminalGrid} grid
 * @returns {import('./wallLayout.js').Rect}
 */
function rectOf(grid) {
    if (grid.parent && !grid.parent.isScene) {
        throw new Error(`[wall] terminal ${grid.terminalId} is parented under ${grid.parent.type}, not the scene — its rect needs the full world transform`);
    }
    const lb = grid.getLocalBounds();
    const p = grid.position, s = grid.scale;
    return {
        minX: p.x + lb.min.x * s.x, maxX: p.x + lb.max.x * s.x,
        minY: p.y + lb.min.y * s.y, maxY: p.y + lb.max.y * s.y,
    };
}

/**
 * The wall's context: what the terminal verbs run in (TerminalContext), plus the camera, renderer and
 * scene systems the repo's harness tools read through window.__glyphClient.ctx. `sceneSystems` is
 * null while the wall is stopped.
 * @typedef {import('@glyph3d/core/services/terminal/TerminalHost.js').TerminalContext & {
 *   camera: import('three').OrthographicCamera, renderer: any, sceneSystems: SceneSystems|null }} WallContext
 */

/**
 * Where the wall stands with its relay: `offline` (no socket, or it dropped), `up` (registered as
 * the relay's display), `refused` (the relay answered DISPLAY with an error — it takes one display,
 * and another holds it; the bridge keeps retrying, so this clears when that display leaves).
 * @typedef {{ state: 'offline'|'up'|'refused', reason: string }} RelayState
 */

/** A shell title, shortened for naming: drop the `user@host:` prefix prompts put in front. */
function shortTitle(title) {
    return (title || '').replace(/^[^@\s]+@[^:\s]+:/, '').trim();
}

/** Format a command for warning/error logs with capability tokens redacted. */
function formatRedactedCmd(cmd) {
    const tokens = Array.isArray(cmd)
        ? cmd.map((x) => String(x ?? ''))
        : String(cmd ?? '').trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return '';
    const t0 = tokens[0].toLowerCase();
    const t1 = (tokens[1] || '').toLowerCase();
    const splitVerb = (t0 === 'wall' || t0 === 'relay') && (t1 === 'token' || t1 === 'connect');
    const verb = splitVerb ? `${t0}.${t1}` : t0;
    const head = splitVerb
        ? `${redactRelaySecrets(tokens[0])} ${redactRelaySecrets(tokens[1])}`
        : redactRelaySecrets(tokens[0]);
    const rawArgs = splitVerb ? tokens.slice(2) : tokens.slice(1);
    const safeArgs = redactCommandArgs(verb, rawArgs);
    return safeArgs.length ? `${head} ${safeArgs.join(' ')}` : head;
}

/**
 * TerminalWall — an infinite 2D canvas of terminals: the composition root.
 *
 *   relay        one CommandRouter carrying the core terminal verbs (services/terminal —
 *                terminal.create/resize/kill/… arrive from the relay's adapters and run here, and
 *                the wall's own spawn and kill are those verbs too), the wall's TerminalHost
 *                (_terminalHost: where terminals land, what focus means, what persists), and one
 *                WebSocketBridge (this page is the relay's DISPLAY)
 *   scene        the renderer's scene systems (core SceneSystems — the set the IDE installs)
 *   terminals    arrival order, focus, hover, selection, placement, names, hiding (WallStore
 *                persists spots, names, hidden terminals, groups and the sidebar, per relay, pruned
 *                against the relay's live terminals on every connect)
 *   verbs        the wall's own (wallCommands: wall.hide/show/close/select/group…/sidebar/config) on
 *                the same router — the buttons, sidebar, palette and chords all run them (run())
 *   canvas       WallPaper (the canvas colour + the drafting grid; wallSnap: where drags snap)
 *   parts        WallCamera (the ortho camera + every mapping through it), WallNames (title bars +
 *                map labels), WallGroups (groups: tiling, header drags, frames), BarButtons (a hovered
 *                bar's hide + hold-to-close), SelectionOverlay (lasso, outlines, the group button),
 *                WallPointer (gestures), WallKeys (keyboard), WallMenu (the right-click menu's
 *                events: contextMenu.js decides who a right-click belongs to; `menu` is the open
 *                one, opened and closed by wall.menu, drawn by ContextMenu.jsx)
 *   termd        TermdStatus (core): the relay's termd/status pushes — the daemon, its terminals,
 *                restarts and losses — for the status window and the topbar's chip; the wall.status
 *                verbs (wallCommands) open and place the window
 *
 * The constructor builds what lives as long as the wall (store, camera mapping, router, bridge);
 * start() installs everything that touches the scene, the registry, the DOM or the socket, and stop()
 * removes exactly that — so stop() then start() is a clean restart. DOM chrome subscribes with
 * onChange() and calls the public methods.
 */
export default class TerminalWall {
    /**
     * @param {{ scene: import('three').Scene, camera: import('three').OrthographicCamera, gl: any,
     *           atlas: any, registry: any, relayPort: number, config?: Partial<import('./wallConfig.js').WallConfig> }} deps
     *   config: knobs over WALL_CONFIG (also dialable live: wall.config); what the person dialled
     *   (WallStore, per relay) wins over both
     */
    constructor({ scene, camera, gl, atlas, registry, relayPort, config = {} }) {
        /** Terminal ids in arrival order. @type {string[]} */
        this.order = [];
        /** Terminal ids in back-to-front Z-stacking order (the focused or dragged window rises to the end). @type {string[]} */
        this.zOrder = [];
        /** @type {string|null} */
        this.focusedId = null;
        /** Focus navigation history (back / forward), and the current cursor in it. @type {string[]} */
        this._focusHistory = [];
        this._focusIndex = -1;
        this._steppingHistory = false;
        /** @type {string|null} */
        this.hoveredId = null;
        /** Selected terminals (shown ones only) — what wall.group gathers. @type {Set<string>} */
        this.selection = new Set();
        /** @type {RelayState} */
        this.relay = { state: 'offline', reason: '' };
        /**
         * The open right-click menu: what it's on, where (canvas-relative CSS px) and the world point
         * under it; null when closed. Opened and closed by `wall.menu`; it closes by itself when its
         * terminal is hidden or goes, or its group goes.
         * @type {{ target: import('./contextMenu.js').MenuTarget, at: { x: number, y: number }, world: { x: number, y: number } }|null}
         */
        this.menu = null;
        /**
         * The wall's selection clipboard (Ghostty's): the text last selected in a terminal, while
         * `copyOnSelect` is on — what a middle-click on a terminal pastes. A page can't reach the
         * system's primary selection, so the wall keeps its own; it lives as long as the page.
         */
        this.selectionClipboard = '';
        /** A notice at the top of the wall (a copy or paste refused, and why); null when none. @type {string|null} */
        this.notice = null;
        this._noticeTimer = null;
        this._listeners = new Set();
        this.store = new WallStore(relayPort);
        /** The knobs as the wall was born with them — what `wall.config <knob> default` hands back. */
        this._born = Object.freeze({ ...WALL_CONFIG, ...config });
        /** @type {import('./wallConfig.js').WallConfig} */
        this.config = { ...this._born, ...this._dialled() };
        // The cell's own lines and dim are the glyph shader's: every terminal draws with them.
        setGlyphLineStyle(Object.fromEntries(LINE_STYLE_KNOBS.map((k) => [k, this.config[k]])));
        this.viewport = new WallCamera(camera, gl.domElement);
        /** A split waiting for its new terminal to land (wall.split): which pane it cuts, and which way. */
        this._splitLanding = null;
        /** One terminal fullscreen (WallFullscreen) — its state lives as long as the wall, as the store does. */
        this.fullscreen = new WallFullscreen(this);

        /** @type {WallContext} */
        this.ctx = {
            scene, atlas, registry, camera, renderer: gl,
            sceneSystems: null,
            terminals: new Map(),
            wsbridge: null,
            terminalHost: assertTerminalHost(this._terminalHost(), 'wall'),
        };
        this.router = new CommandRouter(this.ctx);
        registerTerminalCommands(this.router);
        /** termd's state as the relay pushes it (termd/status). */
        this.termd = new TermdStatus();
        /** Per-terminal Agent Views: categorized gomuxai event streams attached alongside terminals. */
        this.agents = new WallAgentViews(this);
        /** The gomuxai agents the relay sees, to attach to (wall.attach, wall.bus). */
        this.bus = new WallBus(() => this._emit());
        registerWallCommands(this.router, this);
        this._relayPort = relayPort;
        /** The relay link — this page is its DISPLAY. Built by start(), disposed by stop(). @type {WebSocketBridge|null} */
        this.bridge = null;
        /** Removes the console forwarder start() installed. @type {(() => void)|null} */
        this._offConsole = null;
        /** Removes the input trace's listeners (inputTrace.js). @type {(() => void)|null} */
        this._offTrace = null;
        this._onRegistry = () => this._syncTerminals();
        this._running = false;
        /** Who waits for the next frame (nextFrame). @type {Array<() => void>} */
        this._frameWaiters = [];
    }

    // ── lifecycle ───────────────────────────────────────────────────────────

    start() {
        const { scene, atlas, renderer, registry } = this.ctx;
        this.ctx.sceneSystems = new SceneSystems(scene, atlas, renderer);
        this.pointer = new WallPointer(this, this.viewport);
        this.keys = new WallKeys(this);
        this.paper = new WallPaper(scene, renderer);
        this.menuInput = new WallMenu(this);
        const host = this.viewport.canvas.parentElement;
        this.names = new WallNames({
            atlas, host, camera: this.viewport,
            onLabelPress: (id, e) => this.pointer.pressLabel(id, e),
        });
        this.groups = new WallGroups(this, { atlas, scene });
        this.barButtons = new BarButtons(host, {
            onAgent: (id) => this.run(['wall.agent', id, 'toggle']),
            isAgentOpen: (id) => this.agents.isOpen(id),
            onHide: (id) => this.run(['wall.hide', id]),
            onClose: (id) => this.run(['wall.close', id]),
            holdMs: () => this.config.closeHoldMs,
            minPx: () => this.config.barButtonsMinPx,
        });
        this.selectionOverlay = new SelectionOverlay(host, {
            onGroup: () => this.run(['wall.group']),
            onClear: () => this.run(['wall.select', 'none']),
        });
        this.fullscreen.attachBackdrop(host);
        for (const id of this.order) this.names.attach(id, this.ctx.terminals.get(id));
        registry.addChangeListener(this._onRegistry);
        this._syncTerminals();
        this._applyZOrder();
        this.pointer.install();
        this.keys.install();
        this.menuInput.install();

        const port = this._relayPort;
        const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const normHost = normalizeRelayHost(location.hostname);
        const urlHost = normHost.includes(':') ? `[${normHost}]` : normHost;
        this.bridge = new WebSocketBridge(this.router, {
            url: `${wsProto}//${urlHost}:${port}`, port, autoConnect: false, showStatus: false,
        });
        this.ctx.wsbridge = this.bridge;
        // The page's console and uncaught errors go to the relay's log store (log.query / log.search).
        this._offConsole = installConsoleForwarder(this.bridge);
        this._offTrace = installInputTrace(this);
        routeTerminalOutput(this.bridge, this.ctx);
        this._offTermd = this.termd.attach(this.bridge);
        this.agents.start(this.bridge);
        this.bus.start(this.bridge);
        this.bridge.onConnectionChange((up) => this._onConnection(up));
        this._running = true;
        this.bridge.connect();
    }

    stop() {
        this._running = false;
        this.agents.stop();
        this.bus.stop();
        this._offTermd();
        this.termd.clear();
        this._offTrace();
        this._offTrace = null;
        this._offConsole?.();
        this._offConsole = null;
        this.bridge.dispose();
        this.bridge = null;
        this.ctx.wsbridge = null;
        this.relay = { state: 'offline', reason: '' };
        this.menu = null;
        clearTimeout(this._noticeTimer);
        this.notice = null;
        this.menuInput.uninstall();
        this.keys.uninstall();
        this.pointer.uninstall();
        this.ctx.registry.removeChangeListener(this._onRegistry);
        this.names.dispose();
        this.names = null;
        this.groups.dispose();
        this.groups = null;
        this.barButtons.dispose();
        this.barButtons = null;
        this.selectionOverlay.dispose();
        this.selectionOverlay = null;
        this.fullscreen.detachBackdrop();
        this.paper.dispose();
        this.paper = null;
        this.ctx.sceneSystems.dispose();  // hands the scene's hooks back to three
        this.ctx.sceneSystems = null;
    }

    /** Per frame: track the viewport, ease the camera, lay out names, group frames, the screen-space
     *  chrome (bar buttons, selection), far-LOD. */
    tick(dt, size) {
        if (!this._running) return;
        this.viewport.setView(size.width, size.height);
        this.viewport.step(dt);
        this.pointer.step(dt);
        this.fullscreen.tick(performance.now());
        this.names.update({
            order: this.shownOrder(), terminals: this.ctx.terminals, focusedId: this.focusedId, hoveredId: this.hoveredId,
            fullscreenId: this.fullscreen.id,
            nameOf: (id) => this.titleOf(id), windowRect: (id) => this.windowRect(id),
        });
        this.groups.update(this.viewport.zoom, this.focusedId, false);
        this.paper.update(this.viewport, this.config);
        this._tickChrome();
        this.ctx.sceneSystems.update(this.viewport.camera, size.height);
        if (this._frameWaiters.length) for (const done of this._frameWaiters.splice(0)) done();
    }

    /**
     * Resolves once the next frame is drawn: this tick runs in r3f's frame before its render, and a
     * resolve's continuations run when that frame's task ends — the render included — so whoever
     * awaits it sees the frame's layout (names, map labels, chrome) and its pixels. What a test (or
     * anything else) waits on after changing what the wall shows, in place of a guessed delay.
     * @returns {Promise<void>}
     */
    nextFrame() { return new Promise((done) => this._frameWaiters.push(done)); }

    /** Place the DOM chrome that tracks the canvas: the hovered bar's buttons, the selection marks. */
    _tickChrome() {
        const v = this.viewport;
        const bid = this.barButtons.holdTarget ?? (this.pointer.busy ? null : this.hoveredId);
        if (bid && this.onCanvas(bid)) {
            const win = v.toScreenBox(this.windowRect(bid)), body = v.toScreenBox(this.terminalRect(bid));
            this.barButtons.update(bid, win, body.top - win.top);
        } else this.barButtons.update(null, null, 0);
        const items = [];
        for (const id of this.selection) if (this.onCanvas(id)) items.push({ id, box: v.toScreenBox(this.windowRect(id)) });
        this.selectionOverlay.update(items, v.view, this.pointer.lassoing);
        this.fullscreen.updateBackdrop(v, this.config.background);
        this.agents.updateScreenTransforms(v);
    }

    /** Subscribe to state changes (connection, terminal set, focus, names). Returns an unsubscribe. */
    onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

    _emit() {
        this._pruneMenu();
        for (const fn of this._listeners) { try { fn(); } catch (e) { console.error('[wall] listener threw:', e); } }
    }

    /**
     * Run a verb on the wall's router — what the buttons, sidebar, status window, palette and chords
     * call. A refusal is logged with the request, loud, and returned.
     * @param {string|string[]} cmd @returns {Promise<{text: string, data: any}>}
     */
    async run(cmd) {
        let r;
        try {
            r = await this.router.execute(cmd);
        } catch (e) {
            const msg = redactRelaySecrets(e?.message || String(e));
            console.warn(`[wall] ${formatRedactedCmd(cmd)} → ERR: ${msg}`);
            throw e;
        }
        if (r.text.startsWith('ERR')) {
            console.warn(`[wall] ${formatRedactedCmd(cmd)} → ${redactRelaySecrets(r.text)}`);
        }
        return r;
    }

    // ── the relay ───────────────────────────────────────────────────────────

    /**
     * The socket opened or closed. Open isn't registered: the relay answers DISPLAY with `{ok: true}`
     * or — when another display holds it — `{error}` and a close. The bridge consumes that answer
     * without surfacing it, so the wall reads it off the socket the bridge just opened.
     */
    _onConnection(up) {
        if (up) this._awaitRegistration(this.bridge.ws);
        else {
            this.termd.clear();   // no relay, no word from termd: unknown, not gone
            if (this.relay.state === 'up') this._setRelay('offline', '');
        }
        // A refusal stands through the bridge's retries, until a retry registers.
    }

    /** @param {WebSocket} socket - the socket the bridge just opened */
    _awaitRegistration(socket) {
        const onMessage = (ev) => {
            if (typeof ev.data !== 'string') return;
            let m;
            try { m = JSON.parse(ev.data); } catch { return; }
            // The registration answer is the one frame with `ok` or `error` and no event / JSON-RPC.
            if (!m || typeof m !== 'object' || m.jsonrpc || m.event || !('ok' in m || 'error' in m)) return;
            socket.removeEventListener('message', onMessage);
            if (m.ok) {
                this._setRelay('up', '');
                this.termd.request(this.bridge);
                this.agents.onRelayUp();
                this.bus.refresh();
                this._recover();
            } else {
                const why = String(m.error || 'refused');
                console.warn(`[wall] the relay on :${this._relayPort} refused this display: ${why}`);
                this._setRelay('refused', /already connected/.test(why) ? 'another display holds this relay' : why);
            }
        };
        socket.addEventListener('message', onMessage);
    }

    /** @param {RelayState['state']} state @param {string} reason */
    _setRelay(state, reason) {
        if (this.relay.state === state && this.relay.reason === reason) return;
        this.relay = { state, reason };
        this._emit();
    }

    /**
     * Set or replace the relay capability token (accepts a raw token or a `#token=…` URL) and
     * reconnect immediately, reconciling a restarted relay's fresh random token with no reload.
     * @param {string} token
     */
    setRelayToken(token) {
        if (!this.bridge) throw new Error('the wall is not running');
        this.bridge.setToken(token);
        this._emit();
    }

    /**
     * Registered: re-adopt the relay's orphaned sessions (their adapters died with a relay restart),
     * then forget the names and spots of terminals whose sessions are gone — the reply lists every
     * live terminal (`live`), and an id whose session is gone will be minted again for a stranger.
     */
    async _recover() {
        const bridge = this.bridge;
        const reply = bridge.waitForEvent('terminal.recovered', RECOVER_REPLY_MS);
        bridge.send(JSON.stringify({ relay: 'terminal.recover' }));
        const r = await reply;
        if (!r) { console.warn(`[wall] no terminal.recovered reply in ${RECOVER_REPLY_MS} ms — names and spots kept as they were`); return; }
        if (!Array.isArray(r.live)) { console.warn(`[wall] the relay couldn't list its terminals (${r.error ?? 'no live list'}) — names and spots kept as they were`); return; }
        const gone = this.store.prune(new Set([...r.live, ...this.ctx.terminals.keys()]));
        if (gone.length) {
            this.agents.prune((id) => !gone.includes(id));
            console.info(`[wall] forgot ${gone.length} terminal(s) whose sessions are gone: ${gone.join(', ')}`);
            this.groups?.relayoutAll();
            this._emit();
        }
    }

    // ── terminals ───────────────────────────────────────────────────────────

    /** @param {string} id @returns {TerminalGrid|undefined} */
    terminal(id) { return this.ctx.terminals.get(id); }

    /** A terminal's world rect (the grid alone). */
    terminalRect(id) { return rectOf(this.ctx.terminals.get(id)); }

    /** A terminal's body rect on the canvas — its pre-fullscreen rect while fullscreen, else `terminalRect`. */
    canvasTerminalRect(id) {
        if (this.fullscreen.id === id) return this.fullscreen.canvasBodyRect() ?? this.terminalRect(id);
        return this.terminalRect(id);
    }

    /** A terminal's rect plus its title bar at `zoom` — what the person sees as the window. */
    windowRect(id, zoom = this.viewport.zoom) {
        const r = this.terminalRect(id);
        const bar = this.names ? this.names.barHeight(id, zoom) : 0;
        return { ...r, maxY: r.maxY + bar };
    }

    /** A terminal's canvas window rect at `zoom` (uses its saved canvas spot & size while fullscreen). */
    canvasWindowRect(id, zoom = this.viewport.zoom) {
        const r = this.canvasTerminalRect(id);
        const bar = this.names ? this.names.barHeight(id, zoom) : 0;
        return { ...r, maxY: r.maxY + bar };
    }

    /** A terminal's attached Agent View rect at `zoom`, or null when closed. */
    agentRect(id, zoom = this.viewport.zoom) {
        return this.agents.rect(id, zoom);
    }

    /** Full canvas footprint of `id` at `zoom`: its window plus its open Agent View (if any). */
    footprintRect(id, zoom = this.viewport.zoom) {
        const win = this.windowRect(id, zoom);
        const ag = this.agents.rect(id, zoom);
        return ag ? unionRect([win, ag]) : win;
    }

    /** Pre-fullscreen canvas footprint of `id` at `zoom`. */
    canvasFootprintRect(id, zoom = this.viewport.zoom) {
        const win = this.canvasWindowRect(id, zoom);
        const ag = this.agents.rect(id, zoom);
        return ag ? unionRect([win, ag]) : win;
    }

    /**
     * What's under a world point: while a terminal is fullscreen, that terminal's body alone (no border
     * resize, no title bar drag, no canvas hits behind it); on the canvas, walk the Z-stack front to back,
     * testing a split group's dividers just ahead of its panes and each group's header right behind its
     * backmost shown member — so front windows and front group headers occlude anything buried beneath them.
     * @returns {{ id: string, part: 'edge'|'title'|'body', edges?: object }|{ group: string, part: 'header' }
     *   |{ group: string, part: 'divider', divider: { path: string[], axis: 'x'|'y' } }|null}
     */
    hit(p) {
        if (this.fullscreen.id) {
            const id = this.fullscreen.id, r = this.terminalRect(id);
            return p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY ? { id, part: 'body' } : null;
        }
        const zoom = this.viewport.zoom, tol = EDGE_GRAB_PX / zoom;
        const shownIds = [];
        for (let i = this.zOrder.length - 1; i >= 0; i--) {
            const id = this.zOrder[i];
            if (this.isShown(id)) shownIds.push(id);
        }
        const lastIdxOfGroup = new Map();
        for (let i = 0; i < shownIds.length; i++) {
            const g = this.groups.groupOf(shownIds[i]);
            if (g) lastIdxOfGroup.set(g, i);
        }
        const seenSplits = new Set();
        const checkedHeaders = new Set();
        for (let i = 0; i < shownIds.length; i++) {
            const id = shownIds[i];
            const g = this.groups.groupOf(id);
            // Within a split group, test its dividers before its own panes' crowded border bands.
            if (g && !seenSplits.has(g)) {
                seenSplits.add(g);
                const d = this.groups.groupDividerAt(g, p, tol);
                if (d) return { group: g, part: 'divider', divider: d };
            }
            const t = hitTest([{ id, window: this.windowRect(id), body: this.terminalRect(id) }], p.x, p.y, tol);
            if (t) return t;
            if (g && lastIdxOfGroup.get(g) === i) {
                checkedHeaders.add(g);
                const h = this.groups.headerRect(g, zoom);
                if (h && p.x >= h.minX && p.x <= h.maxX && p.y >= h.minY && p.y <= h.maxY) return { group: g, part: 'header' };
            }
        }
        const group = this.groups.headerAt(p, zoom);
        return group && !checkedHeaders.has(group) ? { group, part: 'header' } : null;
    }

    /** Whether a terminal is on the wall and not hidden. */
    isShown(id) { return this.ctx.terminals.has(id) && !this.store.hidden(id); }

    /** The shown terminals, in arrival order. */
    shownOrder() { return this.order.filter((id) => !this.store.hidden(id)); }

    /** On the open canvas (not hidden, and not veiled behind fullscreen): what canvas DOM chrome tracks. @param {string} id */
    onCanvas(id) { return this.isShown(id) && !this.fullscreen.id; }

    /** The terminals on the open canvas now, in arrival order. */
    canvasOrder() { return this.fullscreen.id ? [] : this.shownOrder(); }

    /** Sync shown terminals' visibility and Z-stacking (a fullscreen began or ended: other terminals stay
     *  drawn on the canvas plane below while the fullscreen one rises to FULLSCREEN_Z). */
    applyCanvas() {
        for (const [id, grid] of this.ctx.terminals) grid.visible = this.isShown(id);
        this._applyZOrder();
    }

    /** Raise `id` to the front of the canvas Z-stack. */
    bringToFront(id) {
        if (!this.ctx.terminals.has(id)) return;
        const i = this.zOrder.indexOf(id);
        if (i >= 0 && i === this.zOrder.length - 1) { this._applyZOrder(); return; }
        if (i >= 0) this.zOrder.splice(i, 1);
        this.zOrder.push(id);
        this._applyZOrder();
    }

    /** Raise every member of group `gid` to the front of the canvas Z-stack, preserving their relative order. */
    bringGroupToFront(gid) {
        const g = this.store.group(gid);
        if (!g) return;
        const set = new Set(g.members);
        this.zOrder = [...this.zOrder.filter((id) => !set.has(id)), ...this.zOrder.filter((id) => set.has(id))];
        this._applyZOrder();
    }

    /** Set each live terminal's and group frame's world Z from `zOrder` (and FULLSCREEN_Z for fullscreen). */
    _applyZOrder() {
        const scaleOf = (id) => this.ctx.terminals.get(id)?.scale?.z ?? 2;
        const groupOf = (id) => this.store.groupOf(id);
        const { order, terminals, groups } = zStackLayout(this.zOrder, {
            fullscreenId: this.fullscreen.id, scaleOf, groupOf,
        });
        this.zOrder = order;
        for (const [id, z] of terminals) {
            const grid = this.ctx.terminals.get(id);
            if (grid) grid.position.z = z;
        }
        this.groups?.setDepths(groups);
    }

    /** Move a terminal so its body's top-left sits at (x, y) — a tiling's place. */
    placeBody(id, { x, y }) {
        const grid = this.ctx.terminals.get(id), r = rectOf(grid);
        grid.position.x += x - r.minX;
        grid.position.y += y - r.maxY;
    }

    /** Light the hovered terminal's border. */
    setHovered(id) {
        if (id === this.hoveredId) return;
        this.ctx.terminals.get(this.hoveredId)?.setBorderFlag(BORDER_FLAGS.HOVERED, false);
        this.ctx.terminals.get(id)?.setBorderFlag(BORDER_FLAGS.HOVERED, true);
        this.hoveredId = id;
    }

    /** Persist a terminal's current position (after a move or an anchored resize). */
    rememberPosition(id) {
        const grid = this.ctx.terminals.get(id);
        if (grid) this.store.setPosition(id, grid.position);
    }

    /** A terminal's name: the one the person gave it, else the agent it attaches to, else its shell's title, else its id. */
    nameOf(id) {
        return this.store.name(id) || this.store.attached(id) || shortTitle(this.ctx.terminals.get(id)?.windowTitle) || id;
    }

    /** What a terminal's title bar says: its name, and for one attached to an agent the bus lists, that agent's status. */
    titleOf(id) {
        const name = this.nameOf(id);
        const target = this.store.attached(id);
        const a = target ? this.bus.find(target) : null;
        return a ? `${name} · ${busStatus(a.status).word}` : name;
    }

    /** Name a terminal; an empty name clears it back to the shell's title. */
    rename(id, name) {
        if (!this.ctx.terminals.has(id)) return false;
        this.store.setName(id, name);
        this._emit();
        return true;
    }

    // ── hide + show ─────────────────────────────────────────────────────────

    /** Take a terminal off the canvas; it keeps running (and its spot), and comes back with show(). */
    hide(id) {
        const grid = this.ctx.terminals.get(id);
        if (!grid || this.store.hidden(id)) return;
        const wasFocused = this.focusedId === id;
        const prevGroup = this.groups.groupOf(id);
        if (this.fullscreen.id === id) this.fullscreen.exit();   // it hides at its canvas size
        if (this.groups.splits(id)) this.groups.remove([id]);   // a hidden pane leaves its split: its sibling takes the room
        this.store.setHidden(id, true);
        grid.visible = false;
        this._pruneFocusHistory();
        if (wasFocused) this._restoreFocusAfter(id, prevGroup);
        if (this.hoveredId === id) this.setHovered(null);
        this.selection.delete(id);
        this.groups.relayoutOf(id);
        this._applyZOrder();
        this._emit();
    }

    /** Bring a hidden terminal back, at its own spot (a tiled member: its place in the tiling). */
    show(id) {
        const grid = this.ctx.terminals.get(id);
        if (!grid || !this.store.hidden(id)) return;
        this.store.setHidden(id, false);
        grid.visible = true;
        this.groups.relayoutOf(id);
        this._applyZOrder();
        this._emit();
    }

    // ── selection ───────────────────────────────────────────────────────────

    /** Select exactly these terminals (hidden or absent ones are left out). */
    select(ids) {
        const next = new Set(ids.filter((id) => this.isShown(id)));
        if (next.size === this.selection.size && [...next].every((id) => this.selection.has(id))) return;
        this.selection = next;
        this._emit();
    }

    // ── knobs, the sidebar and the status window ────────────────────────────

    /**
     * Set one knob (already checked: wallConfig.checkConfig), remember it (per relay) and let the
     * chrome redraw with it.
     * @template {keyof import('./wallConfig.js').WallConfig} K
     * @param {K} key @param {import('./wallConfig.js').WallConfig[K]} value @returns {import('./wallConfig.js').WallConfig[K]}
     */
    setConfig(key, value) {
        this.config[key] = value;
        this.store.setConfig(key, value);
        this._applyKnob(key);
        this._emit();
        return value;
    }

    /**
     * Hand a knob back to what the wall was born with, and forget the person's value.
     * @param {keyof import('./wallConfig.js').WallConfig} key
     */
    resetConfig(key) {
        this.config[key] = this._born[key];
        this.store.clearConfig(key);
        this._applyKnob(key);
        this._emit();
        return this.config[key];
    }

    /**
     * Push a knob whose value lives outside the wall onto what holds it: the glyph shader's line
     * style, and every terminal's font family and bold colour (a new terminal is born with them:
     * the TerminalHost's theme).
     * @param {keyof import('./wallConfig.js').WallConfig} key
     */
    _applyKnob(key) {
        const value = this.config[key];
        if (LINE_STYLE_KNOBS.includes(key)) setGlyphLineStyle({ [key]: value });
        else if (key === 'fontFamily') for (const grid of this.ctx.terminals.values()) grid.setFontFamily(value);
        else if (key === 'boldIsBright') for (const grid of this.ctx.terminals.values()) grid.setBoldIsBright(value);
        else if (key in SELECTION_STYLE_KNOBS) for (const grid of this.ctx.terminals.values()) grid.setSelectionStyle(SELECTION_STYLE_KNOBS[key](value));
        else if (key === 'agentViewWidth' || key === 'agentViewHeight' || key === 'agentViewGap') this.groups?.relayoutAll();
    }

    /**
     * The knobs the person dialled (WallStore), each checked as wall.config checks it. One that no
     * longer passes (an old value, a knob since renamed) is dropped from the store, loudly.
     * @returns {Partial<import('./wallConfig.js').WallConfig>}
     */
    _dialled() {
        const out = {};
        for (const [key, value] of Object.entries(this.store.config())) {
            try { out[key] = checkConfig(key, value); }
            catch (e) {
                console.warn(`[wall] the remembered knob ${key} = ${JSON.stringify(value)} is refused (${e.message}) — forgotten; it is born again`);
                this.store.clearConfig(key);
            }
        }
        return out;
    }

    /** @param {Partial<import('./WallStore.js').HelpPanelState>} patch */
    setHelpPanel(patch) {
        this.store.setHelpPanel(patch);
        this._emit();
    }

    /** @param {Partial<import('./WallStore.js').SettingsPanelState>} patch */
    setSettingsPanel(patch) {
        this.store.setSettingsPanel(patch);
        this._emit();
    }

    /** @param {Partial<import('./WallStore.js').SidebarState>} patch */
    setSidebar(patch) {
        this.store.setSidebar(patch);
        this._emit();
    }

    /** @param {Partial<import('./WallStore.js').StatusWindowState>} patch */
    setStatusWindow(patch) {
        this.store.setStatusWindow(patch);
        this._emit();
    }

    // ── the right-click menu ────────────────────────────────────────────────

    /**
     * Open the menu on `target` at a canvas-relative point (CSS px). Refused (throws, saying why)
     * for a terminal that isn't shown or a group that isn't there.
     * @param {import('./contextMenu.js').MenuTarget} target @param {{ x: number, y: number }} at
     */
    openMenu(target, at) {
        if (target.kind === 'terminal' && !this.isShown(target.id)) throw new Error(this.ctx.terminals.has(target.id) ? `terminal '${target.id}' is hidden` : `no terminal '${target.id}'`);
        if (target.kind === 'group') this.groups.get(target.id);   // throws for an unknown group
        const r = this.viewport.canvas.getBoundingClientRect();
        this.menu = { target, at: { x: at.x, y: at.y }, world: this.viewport.toWorld(r.left + at.x, r.top + at.y) };
        this._emit();
    }

    /** Close the menu (nothing to do when it's closed). */
    closeMenu() {
        if (!this.menu) return;
        this.menu = null;
        this._emit();
    }

    /** The menu's target went: its terminal hidden or gone, its group gone. */
    _pruneMenu() {
        const t = this.menu?.target;
        if (!t) return;
        if ((t.kind === 'terminal' && !this.isShown(t.id)) || (t.kind === 'group' && !this.store.group(t.id))) this.menu = null;
    }

    /**
     * Whether the program in a terminal turned mouse reporting on (`TerminalGrid.mouseReporting`):
     * then a right-click on its body, once it's focused, is the program's (contextMenu.js).
     * @param {string} id @returns {boolean}
     */
    mouseReporting(id) {
        return !!this.ctx.terminals.get(id)?.mouseReporting;
    }

    /**
     * @returns {{ connected: boolean, relay: RelayState, focusedId: string|null, selection: string[],
     *   sidebar: import('./WallStore.js').SidebarState,
     *   statusWindow: import('./WallStore.js').StatusWindowState,
     *   settingsPanel: import('./WallStore.js').SettingsPanelState,
     *   helpPanel: import('./WallStore.js').HelpPanelState,
     *   fullscreen: string|null,
     *   config: import('./wallConfig.js').WallConfig, dialled: string[],
     *   menu: TerminalWall['menu'],
     *   notice: string|null,
     *   terminals: {id:string, name:string, named:boolean, cols:number, rows:number, preview:string, hidden:boolean, group:string|null, selected:boolean}[],
     *   groups: {id:string, name:string, named:boolean, layout:'tile'|'freeform'|'split', columns:number, gap:number, bars:boolean|null, members:string[]}[] }}
     *   a group lists only its members on the wall
     */
    snapshot() {
        return {
            connected: this.relay.state === 'up',
            relay: { ...this.relay, hasToken: !!this.bridge?.token },
            focusedId: this.focusedId,
            selection: [...this.selection],
            sidebar: this.store.sidebar(),
            statusWindow: this.store.statusWindow(),
            settingsPanel: this.store.settingsPanel(),
            helpPanel: this.store.helpPanel(),
            fullscreen: this.fullscreen.id,
            config: { ...this.config },
            dialled: Object.keys(this.store.config()),
            menu: this.menu,
            notice: this.notice,
            terminals: this.order.map((id) => {
                const g = this.ctx.terminals.get(id);
                const lines = g.readText();
                let preview = '';
                for (let i = lines.length - 1; i >= 0; i--) { if (lines[i].trim()) { preview = lines[i].trim(); break; } }
                return {
                    id, name: this.nameOf(id), named: !!this.store.name(id), attached: this.store.attached(id), cols: g.cols, rows: g.rows, preview,
                    hidden: this.store.hidden(id), group: this.store.groupOf(id), selected: g.hasSelection,
                    agentView: this.agents.isOpen(id) ? { open: true, side: this.agents.sideOf(id) } : null,
                };
            }),
            bus: { reason: this.bus.reason, hosts: this.bus.hosts() },
            agentViews: this.order.filter((id) => this.agents.isOpen(id)).map((id) => this.agents.describe(id)).filter(Boolean),
            groups: this.groups ? this.groups.ids().map((gid) => {
                const g = this.groups.get(gid);
                return {
                    id: gid, name: this.groups.nameOf(gid), named: !!g.name, layout: g.layout, columns: g.columns, gap: g.gap, bars: g.split?.bars ?? null,
                    members: g.members.filter((id) => this.ctx.terminals.has(id)),
                };
            }) : [],
        };
    }

    // ── text: selections, the clipboards ────────────────────────────────────

    /**
     * A selection was made in terminal `id` (a drag let go, a double or triple click): `copyOnSelect`
     * copies it — 'true' to the wall's selection clipboard, 'clipboard' to the system clipboard too.
     * @param {string} id
     */
    selectionMade(id) {
        const text = this.ctx.terminals.get(id)?.selectionText() ?? '';
        const how = this.config.copyOnSelect;
        if (!text || how === 'false') return;
        this.selectionClipboard = text;
        if (how === 'clipboard') this.writeClipboard(text).catch((e) => this.notify(`copy on select: ${e.message}`));
    }

    /**
     * Put text on the system clipboard (the async Clipboard API). Refused — with the page's reason —
     * when the page isn't a secure context (https, or localhost) or the browser denies it; the caller
     * says so (notify).
     * @param {string} text @returns {Promise<void>}
     */
    async writeClipboard(text) {
        const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
        if (!clip?.writeText) throw new Error(`the browser offers no clipboard to this page — it needs a secure context (https, or localhost), and ${location.origin} is not one`);
        try { await clip.writeText(text); } catch (e) { throw new Error(`the browser refused the clipboard (${e?.name ?? 'Error'}: ${e?.message ?? e})`); }
    }

    /** Read the system clipboard's text (the async Clipboard API); refused as writeClipboard is. @returns {Promise<string>} */
    async readClipboard() {
        const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
        if (!clip?.readText) throw new Error(`the browser offers no clipboard to this page — it needs a secure context (https, or localhost), and ${location.origin} is not one`);
        try { return await clip.readText(); } catch (e) { throw new Error(`the browser refused to read the clipboard (${e?.name ?? 'Error'}: ${e?.message ?? e}) — the paste chord (the browser's own paste) needs no permission`); }
    }

    /**
     * Show a notice at the top of the wall for `noticeMs`, and log it (warn): what went wrong and why.
     * @param {string} text
     */
    notify(text) {
        const safe = redactRelaySecrets(String(text ?? ''));
        console.warn(`[wall] ${safe}`);
        this.notice = safe;
        clearTimeout(this._noticeTimer);
        this._noticeTimer = setTimeout(() => { this.notice = null; this._emit(); }, this.config.noticeMs);
        this._emit();
    }

    // ── focus + framing ─────────────────────────────────────────────────────

    /** Focus a terminal (keys go to it) — a hidden one is shown first. `frame` also eases the camera to fit it. */
    focus(id, { frame = false } = {}) {
        if (id != null && !this.ctx.terminals.has(id)) return false;
        if (id != null) this.show(id);
        const prev = this.focusedId ? this.ctx.terminals.get(this.focusedId) : null;
        if (prev && this.focusedId !== id) {
            prev.setBorderFlag(BORDER_FLAGS.FOCUSED, false);
            prev.setCursorFocused(false);
            this.pointer?.cancelScroll?.();
        }
        this.focusedId = id;
        const grid = id ? this.ctx.terminals.get(id) : null;
        if (grid) {
            grid.setBorderFlag(BORDER_FLAGS.FOCUSED, true);
            grid.setCursorFocused(true);
            if (!this._steppingHistory) this._recordFocus(id);
            this.bringToFront(id);
            // While a terminal is fullscreen, focusing another moves fullscreen to it (never typing blindly behind it).
            if (this.fullscreen.id && this.fullscreen.id !== id) this.fullscreen.enter(id);
            else if (frame) { if (this.fullscreen.id) this.fullscreen.enter(id); else this.frame(id); }
        }
        this._emit();
        return true;
    }

    /** Record `id` as the newest stop in focus history (truncating any forward branch). */
    _recordFocus(id) {
        this._pruneFocusHistory();
        if (this._focusHistory[this._focusIndex] === id) return;
        this._focusHistory.splice(this._focusIndex + 1);
        this._focusHistory.push(id);
        if (this._focusHistory.length > 64) this._focusHistory.shift();
        this._focusIndex = this._focusHistory.length - 1;
    }

    /** Drop hidden or gone terminals from focus history, collapsing adjacent duplicates. */
    _pruneFocusHistory() {
        const out = [];
        let nextIdx = -1;
        for (let i = 0; i < this._focusHistory.length; i++) {
            const id = this._focusHistory[i];
            if (!this.isShown(id)) {
                if (i <= this._focusIndex) nextIdx = out.length - 1;
                continue;
            }
            if (out[out.length - 1] !== id) out.push(id);
            if (i <= this._focusIndex) nextIdx = out.length - 1;
        }
        this._focusHistory = out;
        this._focusIndex = out.length ? Math.max(0, Math.min(nextIdx, out.length - 1)) : -1;
    }

    /** Hand focus to the best remaining shown terminal after `goneId` hid or closed. */
    _restoreFocusAfter(goneId, preferredGroup = null) {
        const prev = this.ctx.terminals.get(goneId);
        if (prev) {
            prev.setBorderFlag(BORDER_FLAGS.FOCUSED, false);
            prev.setCursorFocused(false);
        }
        this.focusedId = null;
        const groupShown = preferredGroup && this.store.group(preferredGroup)
            ? this.groups.shownMembers(preferredGroup).filter((x) => x !== goneId) : [];
        let fallback = null;
        if (groupShown.length) {
            for (let i = this._focusHistory.length - 1; i >= 0; i--) {
                if (groupShown.includes(this._focusHistory[i])) { fallback = this._focusHistory[i]; break; }
            }
            fallback ??= groupShown[0];
        }
        if (!fallback) {
            for (let i = this._focusIndex; i >= 0; i--) {
                const id = this._focusHistory[i];
                if (id && id !== goneId && this.isShown(id)) { fallback = id; break; }
            }
        }
        if (!fallback) {
            for (let i = this.zOrder.length - 1; i >= 0; i--) {
                const id = this.zOrder[i];
                if (id !== goneId && this.isShown(id)) { fallback = id; break; }
            }
        }
        if (fallback) this.focus(fallback);
    }

    /** Focus `id`, framing it only when its window isn't already in view (or transferring fullscreen). */
    _focusInView(id) {
        if (this.fullscreen.id) { this.focus(id, { frame: true }); return; }
        const b = this.viewport.toScreenBox(this.windowRect(id)), v = this.viewport.view;
        this.focus(id, { frame: b.left < 0 || b.top < 0 || b.right > v.w || b.bottom > v.h });
    }

    /**
     * Step back (−1) or forward (+1) through focus history (`Ctrl+,` / `Ctrl+.`).
     * @param {-1|1} dir @returns {string|null}
     */
    stepFocusHistory(dir) {
        this._pruneFocusHistory();
        if (!this._focusHistory.length) return null;
        if (!this.focusedId) {
            if (dir > 0) return null;
            const id = this._focusHistory[this._focusIndex];
            if (!id) return null;
            this._steppingHistory = true;
            try { this._focusInView(id); } finally { this._steppingHistory = false; }
            return id;
        }
        const idx = this._focusIndex + (dir < 0 ? -1 : 1);
        if (idx < 0 || idx >= this._focusHistory.length) return null;
        this._focusIndex = idx;
        const id = this._focusHistory[idx];
        this._steppingHistory = true;
        try { this._focusInView(id); } finally { this._steppingHistory = false; }
        return id;
    }

    /**
     * Split a terminal (else the focused one): a new terminal takes the half to its right or below
     * (WallGroups.insertPane). Refused before anything is spawned when a half wouldn't fit.
     * @param {'right'|'down'} dir @param {string|null} [id] @returns {Promise<string>} the new terminal's id
     */
    async split(dir, id = this.focusedId) {
        if (!id) throw new Error('no terminal to split: focus one, or name it');
        if (!this.isShown(id)) throw new Error(this.ctx.terminals.has(id) ? `terminal '${id}' is hidden` : `no terminal '${id}'`);
        this.groups.canSplit(id, dir);
        if (this.fullscreen.id) this.fullscreen.exit();   // the split lands on the canvas
        this._splitLanding = { at: id, dir };
        try {
            const r = await this.spawn();
            if (!r.ok) throw new Error(r.reason || 'the new terminal did not land');
            return /** @type {string} */ (r.id);
        } finally { this._splitLanding = null; }
    }

    /**
     * Move focus to the terminal next to the focused one in a direction — a split's neighbouring pane,
     * or the nearest window that way on the canvas (even while fullscreen, gliding fullscreen across).
     * @param {'left'|'right'|'up'|'down'} dir @returns {string|null} where focus went
     */
    focusPane(dir) {
        if (!this.focusedId) return null;
        const rects = new Map(this.shownOrder().map((id) => [id, this.canvasWindowRect(id)]));
        const next = neighbor(rects, this.focusedId, dir);
        if (!next) return null;
        this._focusInView(next);
        return next;
    }

    /** Shown panes of group `gid` in reading order (split tree leaves, tile slots, or spatial reading order for freeform). */
    _groupPaneOrder(gid) {
        const g = this.groups.get(gid);
        const shown = this.groups.shownMembers(gid);
        if (g.layout === 'freeform') return readingOrder(shown.map((id) => ({ id, rect: this.canvasWindowRect(id) })));
        return shown;
    }

    /** Top-level canvas units — each shown group and each loose shown terminal — sorted in spatial reading order. */
    _topUnits() {
        const raw = [];
        if (this.groups) {
            for (const gid of this.groups.ids()) {
                const members = this._groupPaneOrder(gid);
                if (!members.length) continue;
                raw.push({ kind: 'group', id: gid, members, rect: unionRect(members.map((id) => this.canvasWindowRect(id))) });
            }
        }
        const grouped = new Set(raw.flatMap((u) => u.members));
        for (const id of this.shownOrder()) {
            if (!grouped.has(id)) raw.push({ kind: 'terminal', id, members: [id], rect: this.canvasWindowRect(id) });
        }
        const sortedIdx = readingOrder(raw.map((u, i) => ({ id: String(i), rect: u.rect })));
        return sortedIdx.map((s) => raw[Number(s)]);
    }

    /**
     * Cycle focus through panes in reading order (`⌘[` / `⌘]`): within the focused terminal's group/split
     * when it has multiple shown panes, else across loose canvas windows in reading order (falling back to
     * all shown panes when at most one loose window exists).
     * @param {number} dir @returns {string|null}
     */
    cycleFocus(dir) {
        const gid = this.focusedId && this.groups ? this.groups.groupOf(this.focusedId) : null;
        let scope;
        if (gid) {
            const members = this._groupPaneOrder(gid);
            if (members.length >= 2) scope = members;
        }
        if (!scope) {
            const loose = this.shownOrder().filter((id) => !this.groups?.groupOf(id));
            if (loose.length >= 2 && (!this.focusedId || loose.includes(this.focusedId))) {
                scope = readingOrder(loose.map((id) => ({ id, rect: this.canvasWindowRect(id) })));
            } else {
                scope = this._topUnits().flatMap((u) => u.members);
            }
        }
        const next = cycle(scope, this.focusedId, dir);
        if (next) this._focusInView(next);
        return next;
    }

    /**
     * Cycle focus between top-level groups and loose windows (`⌃⇧[` / `⌃⇧]`), resuming the last-focused
     * (else leading) pane of a group.
     * @param {number} dir @returns {string|null}
     */
    cycleGroupFocus(dir) {
        const units = this._topUnits();
        if (!units.length) return null;
        const curIdx = this.focusedId ? units.findIndex((u) => u.members.includes(this.focusedId)) : -1;
        const unit = curIdx < 0
            ? (dir > 0 ? units[0] : units[units.length - 1])
            : units[(curIdx + (dir < 0 ? -1 : 1) + units.length) % units.length];
        let target = unit.members[0];
        if (unit.kind === 'group' && unit.members.length > 1) {
            for (let i = this._focusHistory.length - 1; i >= 0; i--) {
                if (unit.members.includes(this._focusHistory[i])) { target = this._focusHistory[i]; break; }
            }
        }
        if (this.fullscreen.id) {
            this.focus(target, { frame: true });
        } else if (unit.kind === 'group') {
            const b = this.viewport.toScreenBox(unit.rect), v = this.viewport.view;
            this.focus(target);
            if (b.left < 0 || b.top < 0 || b.right > v.w || b.bottom > v.h) this.frameGroup(unit.id);
        } else {
            this._focusInView(target);
        }
        return target;
    }

    /** Ease the camera to fit one terminal. */
    frame(id) {
        if (!this.ctx.terminals.has(id)) return;
        this.pointer?.quenchWheel?.();
        this.viewport.easeTo(this.frameTarget(id));
    }

    /** The pose that frames one terminal + its bar (and open Agent View): fit to the view, capped at FRAME_MAX_LINE_PX rows.
     *  Fit once for the zoom, then again with the bar's height at that zoom (the bar is screen-sized). */
    frameTarget(id) {
        const cap = FRAME_MAX_LINE_PX / this.ctx.terminals.get(id).cellStride.y;
        const body = this.terminalRect(id);
        const ag = this.agents.rect(id, this.viewport.zoom);
        const first = this.viewport.fitTarget(ag ? unionRect([body, ag]) : body, 0.94, cap);
        return this.viewport.fitTarget(this.footprintRect(id, first.zoom), 0.94, cap);
    }

    /** Ease the camera to fit every shown terminal (bars and open Agent Views included). */
    fitAll() {
        if (this.fullscreen.id) this.fullscreen.exit();
        const shown = this.shownOrder();
        const all = unionRect(shown.map((id) => this.footprintRect(id, this.viewport.zoom)));
        if (!all) return;
        this.pointer?.quenchWheel?.();
        const first = this.viewport.fitTarget(all, 0.9);
        this.viewport.easeTo(this.viewport.fitTarget(unionRect(shown.map((id) => this.footprintRect(id, first.zoom))), 0.9));
    }

    /** Ease the camera to fit a group's shown members, its header included. @returns {boolean} */
    frameGroup(gid) {
        if (this.fullscreen.id) this.fullscreen.exit();
        const groupRect = (zoom) => {
            const f = this.groups.frameRect(gid, zoom), h = this.groups.headerRect(gid, zoom);
            return f && h ? unionRect([f, h]) : f;
        };
        const at = groupRect(this.viewport.zoom);
        if (!at) return false;
        this.pointer?.quenchWheel?.();
        const first = this.viewport.fitTarget(at, 0.9);
        this.viewport.easeTo(this.viewport.fitTarget(groupRect(first.zoom), 0.9));
        return true;
    }

    // ── relay-side lifecycle ────────────────────────────────────────────────

    /**
     * Ask the relay to fork a new terminal (terminal.spawn): it lands through the wall's host,
     * focused + framed. `at` (a world point) puts its window's top-left corner there — the title
     * bar's corner (its height at the zoom when asked), the body just under it; with snap on the body's
     * top-left takes the nearest grid crossing — and frames it there.
     * @param {{ at?: { x: number, y: number }|null }} [o]
     * @returns {Promise<{ ok: boolean, id?: string, reason?: string }>}
     */
    async spawn({ at = null } = {}) {
        const zoom = this.viewport.zoom;   // the bar's room as the person saw it when asking (landing may already be easing)
        const r = await this.router.execute('terminal.spawn');
        if (!r.data?.landed) return { ok: false, id: r.data?.id, reason: r.text };
        const id = r.data.id;
        this.termd.dismissLost();
        if (at && this.ctx.terminals.has(id)) {
            // Landing framed it at its free slot (nothing has drawn since): move it, then frame it here.
            // With snap on, its body's top-left takes the nearest crossing, as a move's does (wallSnap).
            const body = { x: at.x, y: at.y - (this.names?.barHeight(id, zoom) ?? 0) };
            const step = this.config.snap ? snapStep(this.config, zoom) : 0;
            this.placeBody(id, step ? { x: snapTo(body.x, step), y: snapTo(body.y, step) } : body);
            this.rememberPosition(id);
            this.groups?.relayoutOf(id);
            this.frame(id);
        }
        return { ok: true, id };
    }

    /**
     * Attach to a gomuxai agent: the terminal already attached to it, revealed (shown, focused,
     * framed); else a new terminal running `agent attach <target>` (attachArgv), remembered as that
     * agent's. An agent the bus lists without a tmux session is refused, with its status; one it
     * doesn't list (another host's, before the relay follows the bus) is tried as named.
     * @param {string} target - `name` or `name@host`
     * @returns {Promise<{ id: string, existing: boolean }>}
     */
    async attach(target) {
        if (!isBusTarget(target)) throw new Error(`'${target ?? ''}' isn't an agent name (name or name@host)`);
        const open = this.store.attachedTo(target).find((id) => this.ctx.terminals.has(id));
        if (open) {
            this.show(open);
            this.focus(open, { frame: true });
            return { id: open, existing: true };
        }
        const a = this.bus.find(target);
        if (a && !busAttachable(a)) {
            const why = a.status === 'ended' ? `ended${a.endReason ? ` (${a.endReason})` : ''}` : a.status || 'unknown';
            throw new Error(`${target} has no tmux session to attach to (${why})`);
        }
        const r = await this.router.execute(['terminal.spawn', '--', ...attachArgv(target)]);
        if (!r.data?.id) throw new Error(r.text.replace(/^(OK|ERR): /, '') || 'the spawn did not land');
        this.store.setAttached(r.data.id, target);
        this.termd.dismissLost();
        this._emit();
        return { id: r.data.id, existing: false };
    }

    /** Fully close a terminal — its program in termd too — and forget it now: its name, spot,
     *  hiding and place in a group (the group re-tiles; a group left empty goes). */
    kill(id) {
        const gid = this.store.groupOf(id);
        this._closingGroup = this.focusedId === id ? gid : null;
        this.store.forget(id);
        this.agents.prune((tid) => tid !== id);
        this.selection.delete(id);
        const r = this.router.execute(['terminal.kill', id]);
        this._closingGroup = null;
        if (gid && this.store.group(gid)) this.groups?.relayout(gid);
        this._emit();
        return r;
    }

    _syncTerminals() {
        const live = this.ctx.terminals;
        let changed = false;
        for (const [id, grid] of live) {
            if (this.order.includes(id)) continue;
            this.order.push(id);
            if (!this.zOrder.includes(id)) this.zOrder.push(id);
            grid.setBorder(BORDER_STYLE);
            grid.setBorderFlag(BORDER_FLAGS.EDGE, true);   // the always-visible frame
            for (const { role } of TerminalGrid.CONTROL_SPEC) grid.setControlVisible(role, false);
            grid.onResize(() => { this.groups?.relayoutOf(id); this._emit(); });
            grid.onWindowTitle(() => this._emit());
            grid.visible = this.isShown(id);
            this.names.attach(id, grid);
            if (this.agents.isOpen(id)) this.agents._rebindOne(id);
            this.groups?.relayoutOf(id);
            this.fullscreen.adopt(id);   // a reload's saved fullscreen, once its terminal is back
            changed = true;
        }
        this.names.prune((id) => live.has(id));
        this.agents.prune((id) => live.has(id) || !!this.store.agentView(id));
        const left = this.order.filter((id) => !live.has(id));
        if (left.length) {
            this.order = this.order.filter((id) => live.has(id));
            this.zOrder = this.zOrder.filter((id) => live.has(id));
            this._pruneFocusHistory();
            if (this.fullscreen.id && left.includes(this.fullscreen.id)) this.fullscreen.gone(this.fullscreen.id);
            for (const id of left) this.groups?.relayoutOf(id);   // a tiling closes over a grid that went
            changed = true;
        }
        if (this.focusedId && !live.has(this.focusedId)) {
            this._restoreFocusAfter(this.focusedId, this._closingGroup ?? this.store.groupOf(this.focusedId));
            changed = true;
        }
        if (this.hoveredId && !live.has(this.hoveredId)) this.hoveredId = null;
        for (const id of this.selection) if (!live.has(id)) { this.selection.delete(id); changed = true; }
        if (changed) { this._applyZOrder(); this._emit(); }
    }

    /**
     * The wall's TerminalHost: what the core terminal verbs defer to this app for. Nothing holds a
     * terminal here and the display owns its size, so release and resizing have nothing to do. A closed
     * grid keeps its name and spot (surfaces.remove does nothing): an adapter that detaches closes
     * its grid while its terminal runs on in termd, to be re-adopted under the same id. What's forgotten is
     * what the relay no longer has (pruned on connect, _recover) and what the wall kills (kill).
     * @returns {import('@glyph3d/core/services/terminal/TerminalHost.js').TerminalHost}
     */
    _terminalHost() {
        return {
            theme: () => ({
                ...TERMINAL_THEME, fontFamily: this.config.fontFamily, boldIsBright: this.config.boldIsBright,
                selectionColor: this.config.selectionColor,
                selectionForeground: SELECTION_STYLE_KNOBS.selectionForeground(this.config.selectionForeground).foreground,
                selectionWordChars: this.config.selectionWordChars,
            }),
            place: (grid) => this._place(grid),
            landed: (id) => {
                const s = this._splitLanding;
                if (s) {
                    this._splitLanding = null;
                    try { this.groups.insertPane(s.at, id, s.dir); this.focus(id); return `split ${s.dir} of ${s.at}`; }
                    catch (e) { console.warn(`[wall] split ${s.dir} of ${s.at}: ${e.message} — ${id} stays a terminal of its own`); }
                }
                this.focus(id, { frame: true });
                return 'focused + framed';
            },
            focus: (id) => ({ ok: this.focus(id) }),
            release: () => {},
            resizing: () => '',
            surfaces: {
                get: (id) => { const p = this.store.position(id); return p ? { position: p } : null; },
                set: (id, view) => { if (view.position) this.store.setPosition(id, view.position); },
                remove: () => {},
            },
        };
    }

    /** Land a new grid at its remembered spot, else the first free flow slot (a hidden terminal's
     *  spot stays taken: it comes back there). */
    _place(grid) {
        const saved = this.store.position(grid.terminalId);
        if (saved) { grid.position.set(saved.x, saved.y, 0); return; }
        grid.position.set(0, 0, 0);
        const r = rectOf(grid);
        // Offset from the grid's origin to its bounds' top-left, so the slot math works on rects.
        const offX = -r.minX, offY = -r.maxY;
        const taken = [];
        for (const [tid, g] of this.ctx.terminals) {
            if (g === grid) continue;
            const tr = rectOf(g);
            const ar = this.agents.rect(tid);
            taken.push(ar ? unionRect([tr, ar]) : tr);
        }
        const slot = freeFlowSlot(r.maxX - r.minX, r.maxY - r.minY, taken);
        grid.position.set(slot.x + offX, slot.y + offY, 0);
        if (grid.terminalId) this.store.setPosition(grid.terminalId, grid.position);
    }
}

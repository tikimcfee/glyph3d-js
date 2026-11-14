import CommandRouter from '@glyph3d/core/services/orchestration/CommandRouter.js';
import WebSocketBridge from '@glyph3d/core/services/orchestration/WebSocketBridge.js';
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
import SelectionOverlay from './SelectionOverlay.js';
import WallPaper from './WallPaper.js';
import registerWallCommands from './wallCommands.js';
import { WALL_CONFIG, checkConfig } from './wallConfig.js';
import { freeFlowSlot, unionRect, hitTest, cycle } from './wallLayout.js';

/** Border band width a pointer can grab, in CSS px (converted to world units per zoom). */
const EDGE_GRAB_PX = 7;
/** Framing a terminal never magnifies its rows past this line height (CSS px): fit, but capped. */
const FRAME_MAX_LINE_PX = 28;
const BORDER_STYLE = { color: 0x3b4352, width: 1.5, intensity: 1 };
/** How long the wall waits for the relay's terminal.recovered reply before giving up on pruning. */
const RECOVER_REPLY_MS = 15000;
/**
 * What a terminal on the wall is born with (the TerminalHost's theme, over TerminalGrid's defaults):
 * an opaque panel, so the canvas's grid never shows through a terminal.
 */
const TERMINAL_THEME = Object.freeze({ backgroundOpacity: 1 });

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
 *                WallPointer (gestures), WallKeys (keyboard)
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
        /** Terminal ids in arrival order — the order cycling walks. @type {string[]} */
        this.order = [];
        /** @type {string|null} */
        this.focusedId = null;
        /** @type {string|null} */
        this.hoveredId = null;
        /** Selected terminals (shown ones only) — what wall.group gathers. @type {Set<string>} */
        this.selection = new Set();
        /** @type {RelayState} */
        this.relay = { state: 'offline', reason: '' };
        this._listeners = new Set();
        this.store = new WallStore(relayPort);
        /** The knobs as the wall was born with them — what `wall.config <knob> default` hands back. */
        this._born = Object.freeze({ ...WALL_CONFIG, ...config });
        /** @type {import('./wallConfig.js').WallConfig} */
        this.config = { ...this._born, ...this._dialled() };
        this.viewport = new WallCamera(camera, gl.domElement);

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
        registerWallCommands(this.router, this);
        this._relayPort = relayPort;
        /** The relay link — this page is its DISPLAY. Built by start(), disposed by stop(). @type {WebSocketBridge|null} */
        this.bridge = null;
        this._onRegistry = () => this._syncTerminals();
        this._running = false;
    }

    // ── lifecycle ───────────────────────────────────────────────────────────

    start() {
        const { scene, atlas, renderer, registry } = this.ctx;
        this.ctx.sceneSystems = new SceneSystems(scene, atlas, renderer);
        this.pointer = new WallPointer(this, this.viewport);
        this.keys = new WallKeys(this);
        this.paper = new WallPaper(scene, renderer);
        const host = this.viewport.canvas.parentElement;
        this.names = new WallNames({
            atlas, host, camera: this.viewport,
            onLabelPress: (id, e) => this.pointer.pressLabel(id, e),
        });
        this.groups = new WallGroups(this, { atlas, scene });
        this.barButtons = new BarButtons(host, {
            onHide: (id) => this.run(['wall.hide', id]),
            onClose: (id) => this.run(['wall.close', id]),
            holdMs: () => this.config.closeHoldMs,
            minPx: () => this.config.barButtonsMinPx,
        });
        this.selectionOverlay = new SelectionOverlay(host, {
            onGroup: () => this.run(['wall.group']),
            onClear: () => this.run(['wall.select', 'none']),
        });
        for (const id of this.order) this.names.attach(id, this.ctx.terminals.get(id));
        registry.addChangeListener(this._onRegistry);
        this._syncTerminals();
        this.pointer.install();
        this.keys.install();

        const port = this._relayPort;
        this.bridge = new WebSocketBridge(this.router, {
            url: `ws://${location.hostname}:${port}`, port, autoConnect: false, showStatus: false,
        });
        this.ctx.wsbridge = this.bridge;
        routeTerminalOutput(this.bridge, this.ctx);
        this._offTermd = this.termd.attach(this.bridge);
        this.bridge.onConnectionChange((up) => this._onConnection(up));
        this._running = true;
        this.bridge.connect();
    }

    stop() {
        this._running = false;
        this._offTermd();
        this.termd.clear();
        this.bridge.dispose();
        this.bridge = null;
        this.ctx.wsbridge = null;
        this.relay = { state: 'offline', reason: '' };
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
        const shown = this.shownOrder();
        this.names.update({
            order: shown, terminals: this.ctx.terminals, focusedId: this.focusedId, hoveredId: this.hoveredId,
            nameOf: (id) => this.nameOf(id), windowRect: (id) => this.windowRect(id),
        });
        this.groups.update(this.viewport.zoom, this.focusedId);
        this.paper.update(this.viewport, this.config);
        this._tickChrome();
        this.ctx.sceneSystems.update(this.viewport.camera, size.height);
    }

    /** Place the DOM chrome that tracks the canvas: the hovered bar's buttons, the selection marks. */
    _tickChrome() {
        const v = this.viewport;
        const bid = this.barButtons.holdTarget ?? (this.pointer.busy ? null : this.hoveredId);
        if (bid && this.isShown(bid)) {
            const win = v.toScreenBox(this.windowRect(bid)), body = v.toScreenBox(this.terminalRect(bid));
            this.barButtons.update(bid, win, body.top - win.top);
        } else this.barButtons.update(null, null, 0);
        const items = [];
        for (const id of this.selection) if (this.isShown(id)) items.push({ id, box: v.toScreenBox(this.windowRect(id)) });
        this.selectionOverlay.update(items, v.view, this.pointer.lassoing);
    }

    /** Subscribe to state changes (connection, terminal set, focus, names). Returns an unsubscribe. */
    onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

    _emit() { for (const fn of this._listeners) { try { fn(); } catch (e) { console.error('[wall] listener threw:', e); } } }

    /**
     * Run a verb on the wall's router — what the buttons, sidebar, status window, palette and chords
     * call. A refusal is logged with the request, loud, and returned.
     * @param {string|string[]} cmd @returns {Promise<{text: string, data: any}>}
     */
    async run(cmd) {
        const r = await this.router.execute(cmd);
        if (r.text.startsWith('ERR')) console.warn(`[wall] ${Array.isArray(cmd) ? cmd.join(' ') : cmd} → ${r.text}`);
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

    /** A terminal's rect plus its title bar at `zoom` — what the person sees as the window. */
    windowRect(id, zoom = this.viewport.zoom) {
        const r = this.terminalRect(id);
        const bar = this.names ? this.names.barHeight(id, zoom) : 0;
        return { ...r, maxY: r.maxY + bar };
    }

    /**
     * What's under a world point: each SHOWN terminal in stacking order (the focused one on top, then
     * the latest arrivals), tested whole — its border band (of the whole window, so the top edge is
     * the bar's top), then its title bar, then its body — before the one beneath it; then a group's
     * header. A group's backdrop is canvas.
     * @returns {{ id: string, part: 'edge'|'title'|'body', edges?: object }|{ group: string, part: 'header' }|null}
     */
    hit(p) {
        const ids = this.shownOrder().reverse();
        if (this.focusedId) ids.sort((a, b) => (b === this.focusedId) - (a === this.focusedId));
        const stack = ids.map((id) => ({ id, window: this.windowRect(id), body: this.terminalRect(id) }));
        const t = hitTest(stack, p.x, p.y, EDGE_GRAB_PX / this.viewport.zoom);
        if (t) return t;
        const group = this.groups.headerAt(p, this.viewport.zoom);
        return group ? { group, part: 'header' } : null;
    }

    /** Whether a terminal is on the wall and not hidden. */
    isShown(id) { return this.ctx.terminals.has(id) && !this.store.hidden(id); }

    /** The shown terminals, in arrival order — what cycling, fitting, hitting and naming walk. */
    shownOrder() { return this.order.filter((id) => !this.store.hidden(id)); }

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

    /** A terminal's name: the one the person gave it, else its shell's title, else its id. */
    nameOf(id) {
        return this.store.name(id) || shortTitle(this.ctx.terminals.get(id)?.windowTitle) || id;
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
        this.store.setHidden(id, true);
        grid.visible = false;
        if (this.focusedId === id) this.focus(null);
        if (this.hoveredId === id) this.setHovered(null);
        this.selection.delete(id);
        this.groups.relayoutOf(id);
        this._emit();
    }

    /** Bring a hidden terminal back, at its own spot (a tiled member: its place in the tiling). */
    show(id) {
        const grid = this.ctx.terminals.get(id);
        if (!grid || !this.store.hidden(id)) return;
        this.store.setHidden(id, false);
        grid.visible = true;
        this.groups.relayoutOf(id);
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
        this._emit();
        return this.config[key];
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

    /**
     * @returns {{ connected: boolean, relay: RelayState, focusedId: string|null, selection: string[],
     *   sidebar: import('./WallStore.js').SidebarState,
     *   statusWindow: import('./WallStore.js').StatusWindowState,
     *   settingsPanel: import('./WallStore.js').SettingsPanelState,
     *   config: import('./wallConfig.js').WallConfig, dialled: string[],
     *   terminals: {id:string, name:string, named:boolean, cols:number, rows:number, preview:string, hidden:boolean, group:string|null}[],
     *   groups: {id:string, name:string, named:boolean, layout:'tile'|'freeform', columns:number, gap:number, members:string[]}[] }}
     *   a group lists only its members on the wall
     */
    snapshot() {
        return {
            connected: this.relay.state === 'up',
            relay: this.relay,
            focusedId: this.focusedId,
            selection: [...this.selection],
            sidebar: this.store.sidebar(),
            statusWindow: this.store.statusWindow(),
            settingsPanel: this.store.settingsPanel(),
            config: { ...this.config },
            dialled: Object.keys(this.store.config()),
            terminals: this.order.map((id) => {
                const g = this.ctx.terminals.get(id);
                const lines = g.readText();
                let preview = '';
                for (let i = lines.length - 1; i >= 0; i--) { if (lines[i].trim()) { preview = lines[i].trim(); break; } }
                return {
                    id, name: this.nameOf(id), named: !!this.store.name(id), cols: g.cols, rows: g.rows, preview,
                    hidden: this.store.hidden(id), group: this.store.groupOf(id),
                };
            }),
            groups: this.groups ? this.groups.ids().map((gid) => {
                const g = this.groups.get(gid);
                return {
                    id: gid, name: this.groups.nameOf(gid), named: !!g.name, layout: g.layout, columns: g.columns, gap: g.gap,
                    members: g.members.filter((id) => this.ctx.terminals.has(id)),
                };
            }) : [],
        };
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
            prev.position.z = 0;
        }
        this.focusedId = id;
        const grid = id ? this.ctx.terminals.get(id) : null;
        if (grid) {
            grid.setBorderFlag(BORDER_FLAGS.FOCUSED, true);
            grid.setCursorFocused(true);
            grid.position.z = 1;   // the focused terminal draws over any it overlaps
            if (frame) this.frame(id);
        }
        this._emit();
        return true;
    }

    /** Cycle focus through the shown terminals in arrival order, framing the one it lands on. */
    cycleFocus(dir) {
        const next = cycle(this.shownOrder(), this.focusedId, dir);
        if (next) this.focus(next, { frame: true });
    }

    /** Ease the camera to fit one terminal. */
    frame(id) {
        if (this.ctx.terminals.has(id)) this.viewport.easeTo(this.frameTarget(id));
    }

    /** The pose that frames one terminal + its bar: fit to the view, capped at FRAME_MAX_LINE_PX rows.
     *  Fit once for the zoom, then again with the bar's height at that zoom (the bar is screen-sized). */
    frameTarget(id) {
        const cap = FRAME_MAX_LINE_PX / this.ctx.terminals.get(id).cellStride.y;
        const first = this.viewport.fitTarget(this.terminalRect(id), 0.94, cap);
        return this.viewport.fitTarget(this.windowRect(id, first.zoom), 0.94, cap);
    }

    /** Ease the camera to fit every shown terminal (bars included). */
    fitAll() {
        const shown = this.shownOrder();
        const all = unionRect(shown.map((id) => this.terminalRect(id)));
        if (!all) return;
        const first = this.viewport.fitTarget(all, 0.9);
        this.viewport.easeTo(this.viewport.fitTarget(unionRect(shown.map((id) => this.windowRect(id, first.zoom))), 0.9));
    }

    /** Ease the camera to fit a group's shown members, its header included. @returns {boolean} */
    frameGroup(gid) {
        const groupRect = (zoom) => {
            const f = this.groups.frameRect(gid, zoom), h = this.groups.headerRect(gid, zoom);
            return f && h ? unionRect([f, h]) : f;
        };
        const at = groupRect(this.viewport.zoom);
        if (!at) return false;
        const first = this.viewport.fitTarget(at, 0.9);
        this.viewport.easeTo(this.viewport.fitTarget(groupRect(first.zoom), 0.9));
        return true;
    }

    /** Toggle between framing the focused terminal and fitting everything. */
    toggleFrame() {
        if (!this.focusedId) { this.fitAll(); return; }
        const target = this.frameTarget(this.focusedId);
        if (this.viewport.isAt(target)) this.fitAll(); else this.viewport.easeTo(target);
    }

    // ── relay-side lifecycle ────────────────────────────────────────────────

    /**
     * Ask the relay to fork a new terminal (terminal.spawn): it lands through the wall's host,
     * focused + framed. @returns {Promise<{ ok: boolean, id?: string, reason?: string }>}
     */
    async spawn() {
        const r = await this.router.execute('terminal.spawn');
        if (r.data?.landed) { this.termd.dismissLost(); return { ok: true, id: r.data.id }; }
        return { ok: false, id: r.data?.id, reason: r.text };
    }

    /** Fully close a terminal — its program in termd too — and forget it now: its name, spot,
     *  hiding and place in a group (the group re-tiles; a group left empty goes). */
    kill(id) {
        const gid = this.store.groupOf(id);
        this.store.forget(id);
        this.selection.delete(id);
        const r = this.router.execute(['terminal.kill', id]);
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
            grid.setBorder(BORDER_STYLE);
            grid.setBorderFlag(BORDER_FLAGS.EDGE, true);   // the always-visible frame
            for (const { role } of TerminalGrid.CONTROL_SPEC) grid.setControlVisible(role, false);
            grid.onResize(() => { this.groups?.relayoutOf(id); this._emit(); });
            grid.onWindowTitle(() => this._emit());
            if (this.store.hidden(id)) grid.visible = false;
            this.names.attach(id, grid);
            this.groups?.relayoutOf(id);
            changed = true;
        }
        this.names.prune((id) => live.has(id));
        const left = this.order.filter((id) => !live.has(id));
        if (left.length) {
            this.order = this.order.filter((id) => live.has(id));
            for (const id of left) this.groups?.relayoutOf(id);   // a tiling closes over a grid that went
            changed = true;
        }
        if (this.focusedId && !live.has(this.focusedId)) { this.focusedId = null; changed = true; }
        if (this.hoveredId && !live.has(this.hoveredId)) this.hoveredId = null;
        for (const id of this.selection) if (!live.has(id)) { this.selection.delete(id); changed = true; }
        if (changed) this._emit();
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
            theme: () => ({ ...TERMINAL_THEME }),
            place: (grid) => this._place(grid),
            landed: (id) => { this.focus(id, { frame: true }); return 'focused + framed'; },
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
        for (const g of this.ctx.terminals.values()) if (g !== grid) taken.push(rectOf(g));
        const slot = freeFlowSlot(r.maxX - r.minX, r.maxY - r.minY, taken);
        grid.position.set(slot.x + offX, slot.y + offY, 0);
        if (grid.terminalId) this.store.setPosition(grid.terminalId, grid.position);
    }
}

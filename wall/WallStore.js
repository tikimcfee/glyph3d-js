import { remove as removePane } from './splitTree.js';
/**
 * WallStore — the wall's durable per-browser state, in localStorage: where each terminal sits, the
 * names the person gave them and which are hidden (keyed by terminal id), the groups (keyed by group
 * id), and how the sidebar and the termd status window stand. Storage can be unavailable (private
 * windows, blocked site data); then nothing persists and the wall still works.
 *
 * Ids are the relay's, and they recycle: another relay (port) mints its own `term-1`, and a relay
 * whose terminals are all gone (a reboot, a stopped termd) mints `term-1` again. So the store is
 * scoped per relay — its keys carry the relay port the page dials — and the wall prunes it against
 * the relay's live terminals on every (re)connect: an entry outlives a detach (a closed grid whose
 * session runs on is re-adopted under the same id) but not its session. A group loses the members
 * that are pruned or forgotten, and goes when it has none left.
 *
 * The knobs the person dialled (`wall.config`) and the settings panel's place persist here too, per
 * relay like the rest, and are never pruned: a knob is the wall's, not a terminal's.
 */

/**
 * A group as stored. `members` is the tiling order (a split's: its panes in reading order). `origin` is
 * the top-left of a tiled group's first window, or of a split's rect (null until it first tiles).
 * `split` is a split group's rect size (world units), whether its panes show title bars, and its
 * tree of panes (splitTree.js); null for the other layouts.
 * @typedef {{ w: number, h: number, bars: boolean, tree: import('./splitTree.js').SplitNode }} WallSplit
 * @typedef {{ name: string, layout: 'tile'|'freeform'|'split', columns: number, gap: number,
 *             origin: { x: number, y: number }|null, members: string[], split: WallSplit|null }} WallGroup
 */

/**
 * The sidebar: open or not, floating or stuck to an edge, where it floats, which groups are folded.
 * @typedef {{ open: boolean, side: 'left'|'right'|'float', float: { x: number, y: number }, collapsed: string[] }} SidebarState
 */

/** @type {SidebarState} */
const SIDEBAR_DEFAULT = Object.freeze({ open: false, side: 'right', float: Object.freeze({ x: 80, y: 80 }), collapsed: Object.freeze([]) });

/**
 * The termd status window: open or not, floating or stuck to an edge, and where it floats (null:
 * its default spot, under the topbar at the right).
 * @typedef {{ open: boolean, side: 'left'|'right'|'float', float: { x: number, y: number }|null }} StatusWindowState
 */

/** @type {StatusWindowState} */
const STATUS_WINDOW_DEFAULT = Object.freeze({ open: false, side: 'float', float: null });

/**
 * The settings panel: open or not, floating or stuck to an edge, where it floats (null: its default
 * spot), which sections are folded.
 * @typedef {{ open: boolean, side: 'left'|'right'|'float', float: { x: number, y: number }|null, collapsed: string[] }} SettingsPanelState
 */

/** @type {SettingsPanelState} */
const SETTINGS_PANEL_DEFAULT = Object.freeze({ open: false, side: 'float', float: null, collapsed: Object.freeze([]) });

/**
 * The help panel: open or not, floating or stuck to an edge, where it floats (null: its default spot).
 * @typedef {{ open: boolean, side: 'left'|'right'|'float', float: { x: number, y: number }|null }} HelpPanelState
 */

/** @type {HelpPanelState} */
const HELP_PANEL_DEFAULT = Object.freeze({ open: false, side: 'float', float: null });

/** @param {string} key @param {any} fallback */
function read(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v ?? fallback; }
    catch { return fallback; }
}
/** @param {string} key @param {any} value */
function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked: it just won't persist */ }
}

export default class WallStore {
    /** @param {number} relayPort - the relay this page dials; the store's scope */
    constructor(relayPort) {
        const k = (what) => `glyph3d.wall.relay-${relayPort}.${what}`;
        /** The localStorage keys — the e2e reads them. */
        this.keys = {
            positions: k('positions'), names: k('names'), hidden: k('hidden'), groups: k('groups'), sidebar: k('sidebar'), status: k('status'),
            config: k('config'), settings: k('settings'), help: k('help'),
            fullscreen: k('fullscreen'), fullscreenText: k('fullscreenText'),
            agentViews: k('agentViews'),
        };
        this._positions = read(this.keys.positions, {});
        this._names = read(this.keys.names, {});
        /** @type {Set<string>} */
        this._hidden = new Set(read(this.keys.hidden, []));
        /** @type {Record<string, WallGroup>} */
        this._groups = read(this.keys.groups, {});
        for (const g of Object.values(this._groups)) g.split ??= null;   // a group saved before splits
        /** @type {SidebarState} */
        this._sidebar = { ...SIDEBAR_DEFAULT, ...read(this.keys.sidebar, {}) };
        /** @type {StatusWindowState} */
        this._status = { ...STATUS_WINDOW_DEFAULT, ...read(this.keys.status, {}) };
        /** @type {Record<string, any>} */
        this._config = read(this.keys.config, {});
        /** @type {SettingsPanelState} */
        this._settings = { ...SETTINGS_PANEL_DEFAULT, ...read(this.keys.settings, {}) };
        /** @type {HelpPanelState} */
        this._help = { ...HELP_PANEL_DEFAULT, ...read(this.keys.help, {}) };
        /** The terminal fullscreen now, and how to give it back (WallFullscreen). @type {import('./WallFullscreen.js').FullscreenState|null} */
        this._fullscreen = read(this.keys.fullscreen, null);
        /** Each terminal's fullscreen text size, CSS px per row, once the text keys set one. @type {Record<string, number>} */
        this._fullscreenText = read(this.keys.fullscreenText, {});
        /** Per-terminal Agent View state (`{ open, side, session, filters }`). @type {Record<string, any>} */
        this._agentViews = read(this.keys.agentViews, {});
    }

    // ── terminals ─────────────────────────────────────────────────────────────

    /** @param {string} id @returns {{x:number, y:number}|null} */
    position(id) { return this._positions[id] ?? null; }

    /** @param {string} id @param {{x:number, y:number}} p */
    setPosition(id, p) {
        this._positions[id] = { x: p.x, y: p.y };
        write(this.keys.positions, this._positions);
    }

    /** @param {string} id @returns {string|null} the name the person gave it, if any */
    name(id) { return this._names[id] || null; }

    /** @param {string} id @param {string} name - empty clears it */
    setName(id, name) {
        const n = (name || '').trim();
        if (n) this._names[id] = n; else delete this._names[id];
        write(this.keys.names, this._names);
    }

    /** @param {string} id @returns {boolean} */
    hidden(id) { return this._hidden.has(id); }

    /** @param {string} id @param {boolean} on */
    setHidden(id, on) {
        if (on === this._hidden.has(id)) return;
        if (on) this._hidden.add(id); else this._hidden.delete(id);
        write(this.keys.hidden, [...this._hidden]);
    }

    /** Forget a terminal for good — its spot, its name, its hiding, its place in a group, its agent view. @param {string} id */
    forget(id) {
        if (id in this._positions) { delete this._positions[id]; write(this.keys.positions, this._positions); }
        if (id in this._names) { delete this._names[id]; write(this.keys.names, this._names); }
        this.setHidden(id, false);
        const gid = this.groupOf(id);
        if (gid) this._dropMembers(gid, [id]);
        this.setFullscreenText(id, null);
        if (this._fullscreen?.id === id) this.setFullscreen(null);
        this.setAgentView(id, null);
    }

    /**
     * Forget every terminal not in `live` — the relay's live sessions (plus any grid on the wall) —
     * and the groups left with no members.
     * @param {Set<string>} live @returns {string[]} the terminal ids forgotten
     */
    prune(live) {
        const known = new Set([
            ...Object.keys(this._positions),
            ...Object.keys(this._names),
            ...this._hidden,
            ...Object.keys(this._fullscreenText),
            ...Object.keys(this._agentViews),
        ]);
        if (this._fullscreen) known.add(this._fullscreen.id);
        for (const g of Object.values(this._groups)) for (const id of g.members) known.add(id);
        const gone = [...known].filter((id) => !live.has(id));
        for (const id of gone) this.forget(id);
        return gone;
    }

    // ── groups ────────────────────────────────────────────────────────────────

    /** @returns {Record<string, WallGroup>} every group by id — read it, change it through the setters */
    groups() { return this._groups; }

    /** @param {string} gid @returns {WallGroup|null} */
    group(gid) { return this._groups[gid] ?? null; }

    /** The group a terminal is in. @param {string} id @returns {string|null} */
    groupOf(id) {
        for (const [gid, g] of Object.entries(this._groups)) if (g.members.includes(id)) return gid;
        return null;
    }

    /** A group id no group has: `g-1`, `g-2`, … @returns {string} */
    newGroupId() {
        let n = 1;
        while (`g-${n}` in this._groups) n++;
        return `g-${n}`;
    }

    /**
     * Write a group whole. Its members leave any other group they were in (a terminal is in one group
     * at most); a group left empty by that goes.
     * @param {string} gid @param {WallGroup} g
     */
    setGroup(gid, g) {
        for (const [other, og] of Object.entries(this._groups)) {
            if (other === gid) continue;
            const taken = og.members.filter((id) => g.members.includes(id));
            if (taken.length) this._dropMembers(other, taken, false);
        }
        this._groups[gid] = {
            name: g.name, layout: g.layout, columns: g.columns, gap: g.gap, origin: g.origin ? { x: g.origin.x, y: g.origin.y } : null,
            members: [...g.members], split: g.split ? structuredClone(g.split) : null,
        };
        write(this.keys.groups, this._groups);
    }

    /** @param {string} gid */
    deleteGroup(gid) {
        if (!(gid in this._groups)) return;
        delete this._groups[gid];
        write(this.keys.groups, this._groups);
        this._uncollapse(gid);
    }

    /** Take `ids` out of a group; a group left empty goes. */
    _dropMembers(gid, ids, persist = true) {
        const g = this._groups[gid];
        g.members = g.members.filter((id) => !ids.includes(id));
        // A pane that goes gives its room to its sibling.
        if (g.split) for (const id of ids) g.split.tree = removePane(g.split.tree, id) ?? g.split.tree;
        if (!g.members.length) { delete this._groups[gid]; this._uncollapse(gid); }
        if (persist) write(this.keys.groups, this._groups);
    }

    // ── the sidebar ───────────────────────────────────────────────────────────

    /** @returns {SidebarState} */
    sidebar() { return this._sidebar; }

    /** @param {Partial<SidebarState>} patch */
    setSidebar(patch) {
        this._sidebar = { ...this._sidebar, ...patch };
        write(this.keys.sidebar, this._sidebar);
    }

    _uncollapse(gid) {
        if (this._sidebar.collapsed.includes(gid)) this.setSidebar({ collapsed: this._sidebar.collapsed.filter((c) => c !== gid) });
    }

    // ── the termd status window ───────────────────────────────────────────────

    /** @returns {StatusWindowState} */
    statusWindow() { return this._status; }

    /** @param {Partial<StatusWindowState>} patch */
    setStatusWindow(patch) {
        this._status = { ...this._status, ...patch };
        write(this.keys.status, this._status);
    }

    // ── the knobs and the settings panel ──────────────────────────────────────

    /** The knobs the person set, key → value (checked by the wall as it reads them). @returns {Record<string, any>} */
    config() { return this._config; }

    /** Remember a knob the person set. @param {string} key @param {any} value */
    setConfig(key, value) {
        this._config[key] = value;
        write(this.keys.config, this._config);
    }

    /** Forget a knob the person set: it is born again with the wall. @param {string} key */
    clearConfig(key) {
        if (!(key in this._config)) return;
        delete this._config[key];
        write(this.keys.config, this._config);
    }

    /** @returns {SettingsPanelState} */
    settingsPanel() { return this._settings; }

    /** @param {Partial<SettingsPanelState>} patch */
    setSettingsPanel(patch) {
        this._settings = { ...this._settings, ...patch };
        write(this.keys.settings, this._settings);
    }

    // ── the help panel ────────────────────────────────────────────────────────

    /** @returns {HelpPanelState} */
    helpPanel() { return this._help; }

    /** @param {Partial<HelpPanelState>} patch */
    setHelpPanel(patch) {
        this._help = { ...this._help, ...patch };
        write(this.keys.help, this._help);
    }

    // ── fullscreen ────────────────────────────────────────────────────────────

    /** The terminal fullscreen now (survives a reload). @returns {import('./WallFullscreen.js').FullscreenState|null} */
    fullscreen() { return this._fullscreen; }

    /** @param {import('./WallFullscreen.js').FullscreenState|null} s */
    setFullscreen(s) {
        this._fullscreen = s ? { ...s, canvas: { ...s.canvas }, camera: { ...s.camera } } : null;
        write(this.keys.fullscreen, this._fullscreen);
    }

    /** A terminal's fullscreen text size, if the text keys set one. @param {string} id @returns {number|null} */
    fullscreenText(id) { return this._fullscreenText[id] ?? null; }

    /** @param {string} id @param {number|null} px - null forgets it */
    setFullscreenText(id, px) {
        if (px == null) { if (!(id in this._fullscreenText)) return; delete this._fullscreenText[id]; }
        else this._fullscreenText[id] = px;
        write(this.keys.fullscreenText, this._fullscreenText);
    }

    // ── agent views ───────────────────────────────────────────────────────────

    /** Every persisted Agent View entry, keyed by terminal id. @returns {Record<string, any>} */
    agentViews() { return this._agentViews; }

    /** @param {string} id */
    agentView(id) { return this._agentViews[id] ?? null; }

    /** @param {string} id @param {object|null} state - null forgets it */
    setAgentView(id, state) {
        if (state == null) {
            if (!(id in this._agentViews)) return;
            delete this._agentViews[id];
        } else {
            this._agentViews[id] = {
                open: !!state.open,
                side: state.side,
                session: state.session ?? 'auto',
                filters: state.filters ? { ...state.filters } : undefined,
            };
        }
        write(this.keys.agentViews, this._agentViews);
    }
}

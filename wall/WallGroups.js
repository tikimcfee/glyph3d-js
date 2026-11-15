import GroupFrame from './GroupFrame.js';
import { tileLayout, nearestPlace, unionRect, padRect, BAR_ROOM } from './wallLayout.js';

/** A group's natural numeral, from its id (`g-3` → 3), for its default name and its sort. */
const numeral = (gid) => Number(gid.slice(2)) || 0;

/**
 * WallGroups — terminals gathered into groups. A group has a name, members (in tiling order) and a
 * layout: `tile` packs its shown members in `columns` columns `gap` apart (wallLayout.tileLayout),
 * from the group's origin; `freeform` leaves each member at its own spot. Either way the members
 * move together when the group's header is dragged. A terminal is in one group at most.
 *
 * The groups themselves live in the WallStore (durable, per relay, pruned with their members); this
 * is what acts on them — every change writes the store, re-tiles, persists the members' spots and
 * tells the wall — and what draws them: one GroupFrame (backdrop + header) per group with a shown
 * member. Changes throw on a bad request (an unknown group or terminal, a bad column count); the
 * wall.* verbs turn that into an ERR.
 */
export default class WallGroups {
    /**
     * @param {import('./TerminalWall.js').default} wall
     * @param {{ atlas: any, scene: import('three').Scene }} o
     */
    constructor(wall, { atlas, scene }) {
        this.wall = wall;
        this._atlas = atlas;
        this._scene = scene;
        /** @type {Map<string, GroupFrame>} */
        this._frames = new Map();
    }

    get _store() { return this.wall.store; }

    // ── reading ──────────────────────────────────────────────────────────────

    /** @returns {string[]} every group id, in creation order */
    ids() { return Object.keys(this._store.groups()).sort((a, b) => numeral(a) - numeral(b)); }

    /** @param {string} gid @returns {import('./WallStore.js').WallGroup} */
    get(gid) {
        const g = this._store.group(gid);
        if (!g) throw new Error(`no group '${gid}'`);
        return g;
    }

    /** @param {string} id @returns {string|null} */
    groupOf(id) { return this._store.groupOf(id); }

    /** A group's name: the one the person gave it, else `group N`. */
    nameOf(gid) { return this.get(gid).name || `group ${numeral(gid)}`; }

    /** Whether a terminal's spot belongs to its group's tiling (it's in a tiled group). */
    tiles(id) {
        const gid = this.groupOf(id);
        return !!gid && this.get(gid).layout === 'tile';
    }

    /** A group's members that are on the wall and shown, in tiling order. */
    shownMembers(gid) { return this.get(gid).members.filter((id) => this.wall.isShown(id)); }

    // ── changing ─────────────────────────────────────────────────────────────

    /**
     * Gather terminals into a new group (they leave any group they were in). Born with the wall's
     * groupLayout / groupColumns / groupGap unless given.
     * @param {string[]} ids
     * @param {{ name?: string, layout?: 'tile'|'freeform', columns?: number, gap?: number }} [o]
     * @returns {string} the new group's id
     */
    create(ids, o = {}) {
        const members = this._terminals(ids);
        if (!members.length) throw new Error('a group needs at least one terminal');
        const cfg = this.wall.config;
        const gid = this._store.newGroupId();
        const columns = o.columns ?? (cfg.groupColumns || Math.ceil(Math.sqrt(members.length)));
        const g = { name: (o.name || '').trim(), layout: o.layout ?? cfg.groupLayout, columns, gap: o.gap ?? cfg.groupGap, origin: null, members };
        this._check(g);
        g.origin = this._originOf(members);
        this._commit(gid, g, ...this._groupsOf(members));
        return gid;
    }

    /** Add terminals to a group, at its end (they leave any group they were in). */
    add(gid, ids) {
        const g = this.get(gid);
        const more = this._terminals(ids).filter((id) => !g.members.includes(id));
        this._commit(gid, { ...g, members: [...g.members, ...more] }, ...this._groupsOf(more));
    }

    /** Take terminals out of whatever group they're in; they stay where they are. */
    remove(ids) {
        const byGroup = new Map();
        for (const id of ids) {
            const gid = this.groupOf(id);
            if (!gid) throw new Error(`'${id}' is in no group`);
            byGroup.set(gid, [...(byGroup.get(gid) ?? []), id]);
        }
        for (const [gid, out] of byGroup) {
            const g = this.get(gid);
            const members = g.members.filter((id) => !out.includes(id));
            if (members.length) this._commit(gid, { ...g, members });
            else this._store.deleteGroup(gid);
        }
        this.wall._emit();
    }

    /** Dissolve a group; its terminals stay where they are. */
    ungroup(gid) {
        this.get(gid);
        this._store.deleteGroup(gid);
        this.wall._emit();
    }

    /**
     * Set a group's layout. Switching to `tile` starts the tiling at the members' current top-left;
     * to `freeform`, the members stay where the tiling put them.
     * @param {string} gid @param {'tile'|'freeform'} layout @param {{ columns?: number, gap?: number }} [o]
     */
    setLayout(gid, layout, o = {}) {
        const g = this.get(gid);
        const next = { ...g, layout, columns: o.columns ?? g.columns, gap: o.gap ?? g.gap };
        this._check(next);
        if (layout === 'tile' && g.layout !== 'tile') next.origin = this._originOf(g.members);
        this._commit(gid, next);
    }

    /** @param {string} gid @param {number} columns */
    setColumns(gid, columns) {
        const g = this.get(gid);
        this._commit(gid, this._check({ ...g, columns }));
    }

    /** @param {string} gid @param {number} gap */
    setGap(gid, gap) {
        const g = this.get(gid);
        this._commit(gid, this._check({ ...g, gap }));
    }

    /** Name a group; empty gives it back its `group N`. */
    rename(gid, name) {
        this._commit(gid, { ...this.get(gid), name: (name || '').trim() });
    }

    /** Move a whole group by (dx, dy) world units — every member, shown or hidden, and its tiling. */
    move(gid, dx, dy) {
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error(`a move takes two numbers, not ${dx} ${dy}`);
        const start = this.dragStart(gid);
        this.dragTo(start, dx, dy);
        this.dragEnd(start);
    }

    /**
     * Start dragging a group by its header: where every member and the origin stand now.
     * @returns {{ gid: string, members: Map<string, {x:number, y:number}>, origin: {x:number, y:number}|null }}
     */
    dragStart(gid) {
        const g = this.get(gid);
        const members = new Map();
        for (const id of g.members) {
            const grid = this.wall.terminal(id);
            if (grid) members.set(id, { x: grid.position.x, y: grid.position.y });
        }
        return { gid, members, origin: g.origin ? { ...g.origin } : null };
    }

    /** Pose the dragged group at (dx, dy) from where the drag started. */
    dragTo(start, dx, dy) {
        for (const [id, p] of start.members) {
            const grid = this.wall.terminal(id);
            if (grid) { grid.position.x = p.x + dx; grid.position.y = p.y + dy; }
        }
        start.dx = dx; start.dy = dy;
    }

    /** The drag is done: the group's members and origin keep where it left them. */
    dragEnd(start) {
        const g = this._store.group(start.gid);
        if (!g) return;   // the group went mid-drag (its last member died)
        for (const id of start.members.keys()) if (this.wall.terminal(id)) this.wall.rememberPosition(id);
        const origin = start.origin && start.dx != null ? { x: start.origin.x + start.dx, y: start.origin.y + start.dy } : g.origin;
        this._store.setGroup(start.gid, { ...g, origin });
        this.wall._emit();
    }

    /**
     * A tiled member was dragged by its title bar and let go: it takes the tile nearest where it was
     * dropped (the others shift along), and the group tiles again. A freeform member just stays.
     * @param {string} id
     */
    dropMember(id) {
        const gid = this.groupOf(id);
        if (!gid || this.get(gid).layout !== 'tile') { this.wall.rememberPosition(id); return; }
        const g = this.get(gid);
        const shown = this.shownMembers(gid);
        const { places } = this._tiling(g, shown);
        const centres = shown.map((m, i) => {
            const r = this.wall.terminalRect(m);
            return { x: places[i].x + (r.maxX - r.minX) / 2, y: places[i].y - (r.maxY - r.minY) / 2 };
        });
        const r = this.wall.terminalRect(id);
        const to = nearestPlace(centres, { x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2 });
        const order = shown.filter((m) => m !== id);
        order.splice(to, 0, id);
        // Hidden members keep their places in the order relative to the shown ones they followed.
        const members = [];
        let k = 0;
        for (const m of g.members) members.push(this.wall.isShown(m) ? order[k++] : m);
        this._commit(gid, { ...g, members });
    }

    /** Re-tile a tiled group over its shown members (a member came, went, hid, showed or resized). */
    relayout(gid) {
        const g = this.get(gid);
        if (g.layout !== 'tile') return;
        // A member fullscreen re-wraps to the screen, not to its tile: the tiling waits for it to come back.
        const fs = this.wall.fullscreen?.id;
        if (fs && g.members.includes(fs)) return;
        const shown = this.shownMembers(gid);
        if (!shown.length) return;
        const origin = g.origin ?? this._originOf(shown);
        const { places } = this._tiling({ ...g, origin }, shown);
        shown.forEach((id, i) => { this.wall.placeBody(id, places[i]); this.wall.rememberPosition(id); });
        if (!g.origin) this._store.setGroup(gid, { ...g, origin });
    }

    /** Re-tile the group a terminal is in, if it tiles. */
    relayoutOf(id) {
        const gid = this.groupOf(id);
        if (gid) this.relayout(gid);
    }

    /** Re-tile every tiled group (after a prune). */
    relayoutAll() { for (const gid of this.ids()) this.relayout(gid); }

    // ── drawing + hitting ────────────────────────────────────────────────────

    /**
     * A group's frame rect at `zoom`: its shown members' windows (title bars at that zoom), padded.
     * Null when no member is shown.
     */
    frameRect(gid, zoom) {
        const shown = this.shownMembers(gid);
        if (!shown.length) return null;
        return padRect(unionRect(shown.map((id) => this.wall.windowRect(id, zoom))), this.wall.config.groupPad);
    }

    /** The header's rect at `zoom` (above the frame), or null. */
    headerRect(gid, zoom) {
        const f = this.frameRect(gid, zoom);
        const frame = this._frames.get(gid);
        if (!f || !frame) return null;
        return { minX: f.minX, maxX: f.maxX, minY: f.maxY, maxY: f.maxY + frame.headerHeight(zoom) };
    }

    /** The group whose header is under a world point — the latest group on top. @returns {string|null} */
    headerAt(p, zoom) {
        for (const gid of this.ids().reverse()) {
            const h = this.headerRect(gid, zoom);
            if (h && p.x >= h.minX && p.x <= h.maxX && p.y >= h.minY && p.y <= h.maxY) return gid;
        }
        return null;
    }

    /** Per frame: one frame per group, laid over its shown members; none for a group with none shown,
     *  and none at all while a terminal is fullscreen (`hidden`). */
    update(zoom, focusedId, hidden = false) {
        const ids = this.ids();
        for (const [gid, frame] of this._frames) if (!ids.includes(gid)) { frame.dispose(); this._frames.delete(gid); }
        for (const gid of ids) {
            let frame = this._frames.get(gid);
            if (!frame) { frame = new GroupFrame({ atlas: this._atlas }); this._scene.add(frame); this._frames.set(gid, frame); }
            const rect = hidden ? null : this.frameRect(gid, zoom);
            frame.visible = !!rect;
            if (rect) frame.layout(rect, zoom, this.nameOf(gid), !!focusedId && this.groupOf(focusedId) === gid);
        }
    }

    dispose() {
        for (const frame of this._frames.values()) frame.dispose();
        this._frames.clear();
    }

    // ── internals ────────────────────────────────────────────────────────────

    /** The terminals named, each checked to be on the wall, duplicates dropped. */
    _terminals(ids) {
        const out = [];
        for (const id of ids) {
            if (!this.wall.terminal(id)) throw new Error(`no terminal '${id}'`);
            if (!out.includes(id)) out.push(id);
        }
        return out;
    }

    /** The groups these terminals are in now (they may be emptied by a move to another group). */
    _groupsOf(ids) { return [...new Set(ids.map((id) => this.groupOf(id)).filter(Boolean))]; }

    /** Validate a group's layout fields; returns it. */
    _check(g) {
        if (g.layout !== 'tile' && g.layout !== 'freeform') throw new Error(`a group's layout is 'tile' or 'freeform', not '${g.layout}'`);
        if (!Number.isInteger(g.columns) || g.columns < 1) throw new Error(`columns must be a whole number ≥ 1, not '${g.columns}'`);
        if (!Number.isFinite(g.gap) || g.gap < 0) throw new Error(`gap must be a number ≥ 0, not '${g.gap}'`);
        return g;
    }

    /** Where a tiling of these terminals starts: their bodies' top-left, a bar's room above. */
    _originOf(ids) {
        const rects = ids.filter((id) => this.wall.terminal(id)).map((id) => this.wall.terminalRect(id));
        const u = unionRect(rects);
        return u ? { x: u.minX, y: u.maxY + BAR_ROOM } : null;
    }

    /** The tiling of `shown` (member order) for group `g`. */
    _tiling(g, shown) {
        const sizes = shown.map((id) => { const r = this.wall.terminalRect(id); return { w: r.maxX - r.minX, h: r.maxY - r.minY }; });
        return tileLayout(sizes, { origin: g.origin ?? this._originOf(shown), columns: g.columns, gap: g.gap, barRoom: BAR_ROOM });
    }

    /** Write a group, re-tile it and any group it took members from, and tell the wall. */
    _commit(gid, g, ...touched) {
        this._store.setGroup(gid, g);
        this.relayout(gid);
        for (const other of touched) if (other !== gid && this._store.group(other)) this.relayout(other);
        this.wall._emit();
    }
}

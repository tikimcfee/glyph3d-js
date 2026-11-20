import GroupFrame, { DEFAULT_GROUP_Z } from './GroupFrame.js';
import { tileLayout, nearestPlace, unionRect, padRect, BAR_ROOM } from './wallLayout.js';
import { leaves, insert, remove as removePane, fromMembers, panes, minSize, dividerAt, setRatio, ratioFor, checkTree, swap, dock, dropZone, neighbor, fitRatios } from './splitTree.js';

/** The smallest a split pane makes its terminal (cells), as a border drag's floor. */
const MIN_PANE = { cols: 20, rows: 5 };
/** A split's rect within this much (world units) of a pane's edge is that edge. */
const EDGE_EPS = 1e-6;
/** A pane with no Agent View open keeps nothing beside its terminal. */
const NO_INSET = Object.freeze({ left: 0, right: 0, top: 0, bottom: 0 });

/** A group's natural numeral, from its id (`g-3` → 3), for its default name and its sort. */
const numeral = (gid) => Number(gid.slice(2)) || 0;

/**
 * WallGroups — terminals gathered into groups. A group has a name, members (in tiling order) and a
 * layout: `tile` packs its shown members in `columns` columns `gap` apart (wallLayout.tileLayout),
 * from the group's origin; `freeform` leaves each member at its own spot; `split` cuts one rect into
 * panes, as a terminal app's splits do (splitTree.js), and each member re-wraps to fill its pane.
 * Either way the members move together when the group's header is dragged. A terminal is in one
 * group at most.
 *
 * A split pane holds its title bar's room above its panel when the split shows bars (`splitBarRows`
 * of the terminal's rows; the bar is capped to it, so it never overlaps the pane above), then the
 * panel: the cells plus the grid's own padding, measured off the grid. Its cols × rows are what fit
 * (at least MIN_PANE), its panel's top-left at the pane's; panes sit `splitGap` apart. Splitting
 * cuts a pane in two (refused when a half would fall under MIN_PANE); a pane that leaves (removed,
 * hidden, closed, killed) gives its room to its sibling; a divider drag moves the cut, an outer edge
 * drag resizes the whole split; any group turns into a split (rows of `columns`, equal shares) and back.
 * A member's open Agent View is part of its footprint: its tile holds it, its pane keeps its share
 * (the terminal re-wraps to the rest; the split moves a divider or grows when it must, and gives it back).
 *
 * Members move within their group: a split pane dragged by its title bar and dropped on another pane
 * trades places with it, or — dropped near one of that pane's edges — docks beside it there (the pane
 * it left gives its room to its sibling); a tiled member dropped takes the nearest tile. `movePane`
 * does the same a step at a time from the keys: a pane swaps with its neighbour that way, a tile with
 * the next tile in its row or column.
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
        /** @type {Map<string, number>} world Z of each group's frame in the canvas Z-stack */
        this._groupZ = new Map();
        /** What `_fitted` changed in each split to hold its panes' minimums: the split's shape before (to give back once
         *  it fits again) and the shape it made (given back only while the split is still exactly that).
         *  @type {Map<string, { before: { tree: object, w: number, h: number }, after: string }>} */
        this._fitMemo = new Map();
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

    /** Whether a terminal is a pane of a split group. */
    splits(id) {
        const gid = this.groupOf(id);
        return !!gid && this.get(gid).layout === 'split';
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
        const layout = o.layout ?? cfg.groupLayout;
        let g = { name: (o.name || '').trim(), layout, columns, gap: o.gap ?? cfg.groupGap, origin: null, members, split: null };
        if (layout === 'split') g = this._asSplit({ ...g, layout: 'tile' });
        else { this._check(g); g.origin = this._originOf(members); }
        this._commit(gid, g, ...this._groupsOf(members));
        return gid;
    }

    /** Add terminals to a group, at its end (they leave any group they were in). */
    add(gid, ids) {
        const g = this.get(gid);
        const more = this._terminals(ids).filter((id) => !g.members.includes(id));
        if (g.layout === 'split') {
            let tree = g.split.tree;
            for (const id of more) {
                const last = leaves(tree).at(-1);
                const r = this._paneRects({ ...g, split: { ...g.split, tree } }).get(last);
                tree = insert(tree, last, id, r && r.maxX - r.minX >= r.maxY - r.minY ? 'row' : 'col');
            }
            const next = { ...g, members: leaves(tree), split: { ...g.split, tree } };
            this._fits(next, `no room in group '${gid}' for ${more.length} more pane(s)`);
            this._commit(gid, next, ...this._groupsOf(more));
            return;
        }
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
            if (!members.length) { this._store.deleteGroup(gid); continue; }
            const split = g.split ? { ...g.split, tree: out.reduce((tr, id) => removePane(tr, id) ?? tr, g.split.tree) } : null;
            this._commit(gid, { ...g, members, split });
        }
        this._syncBars();
        this.wall._applyZOrder?.();
        this.wall._emit();
    }

    /** Dissolve a group; its terminals stay where they are. */
    ungroup(gid) {
        this.get(gid);
        this._store.deleteGroup(gid);
        this._syncBars();
        this.wall._applyZOrder?.();
        this.wall._emit();
    }

    /**
     * Set a group's layout. Switching to `tile` starts the tiling at the members' current top-left;
     * to `freeform`, the members stay where they are; to `split`, the members' union becomes the split's
     * rect, cut into rows of `columns` equal panes (tiling order), each member re-wrapped to its pane.
     * Leaving a split keeps each member's size and spot (a tiling then re-tiles them).
     * @param {string} gid @param {'tile'|'freeform'|'split'} layout @param {{ columns?: number, gap?: number }} [o]
     */
    setLayout(gid, layout, o = {}) {
        const g = this.get(gid);
        let next = { ...g, layout, columns: o.columns ?? g.columns, gap: o.gap ?? g.gap, split: layout === 'split' ? g.split : null };
        if (layout === 'split' && g.layout !== 'split') next = this._asSplit({ ...next, layout: 'tile' });
        this._check(next);
        if (layout === 'tile' && g.layout !== 'tile') next.origin = this._originOf(g.members);
        this._commit(gid, next);
        this._syncBars();
    }

    // ── splits ───────────────────────────────────────────────────────────────

    /**
     * Throw unless `at` can be cut in two `dir`-wards with both halves at least MIN_PANE.
     * @param {string} at @param {'right'|'down'} dir
     */
    canSplit(at, dir) { this._splitPlan(at, '\u0000new', dir); }

    /**
     * Cut the pane `at` in two and give `id` (a terminal just born) the half to the right or below.
     * A terminal in no split becomes one first: a split group round its window (it leaves any other
     * group). Throws, changing nothing, when a half would fall under MIN_PANE.
     * @param {string} at @param {string} id @param {'right'|'down'} dir @returns {string} the split's group id
     */
    insertPane(at, id, dir) {
        if (!this.wall.terminal(id)) throw new Error(`no terminal '${id}'`);
        const { gid, next, touched } = this._splitPlan(at, id, dir);
        this._commit(gid, next, ...touched);
        return gid;
    }

    /** The divider under `p` inside split group `gid` on the canvas (or while `gid` is fullscreen), `tol` world units either side. */
    groupDividerAt(gid, p, tol) {
        const g = this._store.group(gid);
        const fsGroup = this.wall.fullscreen?.groupId === gid;
        if (!g || g.layout !== 'split' || !g.members.some((id) => (fsGroup ? this.wall.isShown(id) : this.wall.onCanvas(id)))) return null;
        return dividerAt(g.split.tree, this._splitRect(g), this.wall.config.splitGap, p, tol);
    }

    /** The divider under a world point in a split on the canvas (frontmost group first), `tol` world units either side. */
    dividerAt(p, tol) {
        const ordered = this.ids().sort((a, b) => this.depthOf(b) - this.depthOf(a));
        for (const gid of ordered) {
            const d = this.groupDividerAt(gid, p, tol);
            if (d) return { gid, divider: d };
        }
        return null;
    }

    /** Drag a split's divider to `coord` (world x for an upright one, y for a level one). */
    dragDivider(gid, path, coord) {
        const g = this.get(gid);
        const ratio = ratioFor(g.split.tree, this._splitRect(g), this.wall.config.splitGap, path, coord, this._minPane(g));
        if (Math.abs(ratio - this._nodeRatio(g.split.tree, path)) < 1e-9) return;
        this._commit(gid, { ...g, split: { ...g.split, tree: setRatio(g.split.tree, path, ratio) } });
    }

    /**
     * What a border press on a split pane drags: an edge on the split's boundary resizes the whole
     * split (`outer`, the edges that are), an inner one the divider on that side.
     * @param {string} id @param {{ left?: boolean, right?: boolean, top?: boolean, bottom?: boolean }} edges
     * @returns {{ gid: string, outer: { left: boolean, right: boolean, top: boolean, bottom: boolean }|null,
     *             divider: { path: import('./splitTree.js').SplitPath, axis: 'x'|'y' }|null }}
     */
    splitEdge(id, edges) {
        const gid = this.groupOf(id), g = this.get(gid);
        const pr = this._paneRects(g).get(id), sr = this._splitRect(g);
        const on = { left: pr.minX <= sr.minX + EDGE_EPS, right: pr.maxX >= sr.maxX - EDGE_EPS, top: pr.maxY >= sr.maxY - EDGE_EPS, bottom: pr.minY <= sr.minY + EDGE_EPS };
        const outer = { left: !!edges.left && on.left, right: !!edges.right && on.right, top: !!edges.top && on.top, bottom: !!edges.bottom && on.bottom };
        if (outer.left || outer.right || outer.top || outer.bottom) return { gid, outer, divider: null };
        // An inner edge: the divider just beyond it (the pane's edge sits up to a cell inside its pane).
        const gap = this.wall.config.splitGap, tol = gap + this._cellOf(g).x;
        const probe = edges.right ? { x: pr.maxX + gap / 2, y: (pr.minY + pr.maxY) / 2 } : edges.left ? { x: pr.minX - gap / 2, y: (pr.minY + pr.maxY) / 2 }
            : edges.bottom ? { x: (pr.minX + pr.maxX) / 2, y: pr.minY - gap / 2 } : { x: (pr.minX + pr.maxX) / 2, y: pr.maxY + gap / 2 };
        const d = dividerAt(g.split.tree, sr, gap, probe, tol);
        return { gid, outer: null, divider: d ? { path: d.path, axis: d.axis } : null };
    }

    /**
     * Where dropping split pane `id` at world point `p` would put it: the other pane under `p`, the
     * zone (`center` trades places, a side docks beside it), the tree that makes, the rect `id` would
     * land in, and whether every pane would still get MIN_PANE. Null off the split's other panes.
     * @param {string} id @param {{ x: number, y: number }} p
     * @returns {{ gid: string, at: string, zone: 'left'|'right'|'up'|'down'|'center', tree: import('./splitTree.js').SplitNode,
     *             rect: import('./wallLayout.js').Rect, fits: boolean }|null}
     */
    paneDrop(id, p) {
        const gid = this.groupOf(id);
        const g = gid ? this.get(gid) : null;
        if (!g || g.layout !== 'split') return null;
        for (const [at, r] of this._paneRects(g)) {
            if (at === id || p.x < r.minX || p.x > r.maxX || p.y < r.minY || p.y > r.maxY) continue;
            const zone = dropZone(r, p);
            const tree = zone === 'center' ? swap(g.split.tree, id, at) : dock(g.split.tree, id, at, zone);
            const next = { ...g, members: leaves(tree), split: { ...g.split, tree } };
            let fits = true;
            try { this._fits(next, ''); } catch { fits = false; }
            return { gid, at, zone, tree, rect: this._paneRects(next).get(id), fits };
        }
        return null;
    }

    /**
     * Drop split pane `id` at world point `p` (paneDrop says where). Off the other panes, or where the
     * panes wouldn't fit, it goes back to its own pane.
     * @returns {ReturnType<WallGroups['paneDrop']>} what it did, or null when it went back
     */
    dropPane(id, p) {
        const drop = this.paneDrop(id, p);
        if (!drop?.fits) { this.relayoutOf(id); return null; }
        const g = this.get(drop.gid);
        this._commit(drop.gid, { ...g, members: leaves(drop.tree), split: { ...g.split, tree: drop.tree } });
        return drop;
    }

    /**
     * Move a member one step within its group: a split pane trades places with the pane next to it that
     * way; a tiled member with the next tile in its row (left / right) or column (up / down).
     * @param {string} id @param {'left'|'right'|'up'|'down'} dir
     * @returns {string|null} the member it traded places with; null at the group's edge
     */
    movePane(id, dir) {
        if (!['left', 'right', 'up', 'down'].includes(dir)) throw new Error(`a pane moves left, right, up or down, not '${dir}'`);
        const gid = this.groupOf(id);
        if (!gid) throw new Error(`'${id}' is in no group`);
        const g = this.get(gid);
        if (g.layout === 'split') {
            const other = neighbor(this._paneRects(g), id, dir);
            if (!other) return null;
            const tree = swap(g.split.tree, id, other);
            this._commit(gid, { ...g, members: leaves(tree), split: { ...g.split, tree } });
            return other;
        }
        if (g.layout !== 'tile') throw new Error(`group '${gid}' is ${g.layout}: its members have no places to trade`);
        const shown = this.shownMembers(gid);
        const i = shown.indexOf(id);
        if (i < 0) throw new Error(`'${id}' is hidden`);
        const cols = Math.min(g.columns, shown.length);
        const j = dir === 'left' ? (i % cols ? i - 1 : -1) : dir === 'right' ? ((i + 1) % cols && i + 1 < shown.length ? i + 1 : -1)
            : dir === 'up' ? i - cols : i + cols;
        if (j < 0 || j >= shown.length) return null;
        const order = [...shown];
        [order[i], order[j]] = [order[j], order[i]];
        this._commit(gid, { ...g, members: this._withHidden(g, order) });
        return shown[j];
    }

    /** A split's rect, world units. @param {string} gid */
    splitRect(gid) { return this._splitRect(this.get(gid)); }

    /**
     * Give a split a new rect (an outer edge dragged), held at least big enough for every pane.
     * @param {string} gid @param {import('./wallLayout.js').Rect} rect
     */
    resizeSplit(gid, rect) {
        const g = this.get(gid);
        const min = minSize(g.split.tree, this._minPane(g), this.wall.config.splitGap);
        const w = Math.max(min.w, rect.maxX - rect.minX), h = Math.max(min.h, rect.maxY - rect.minY);
        const old = this._splitRect(g);
        // An edge held at its minimum stays where the far edge puts it, not where the pointer is.
        const x = rect.minX !== old.minX ? rect.maxX - w : rect.minX;
        const y = rect.maxY !== old.maxY ? rect.minY + h : rect.maxY;
        if (x === g.origin.x && y === g.origin.y && w === g.split.w && h === g.split.h) return;
        this._commit(gid, { ...g, origin: { x, y }, split: { ...g.split, w, h } });
    }

    /** Show or hide a split's pane title bars. @param {string} gid @param {boolean} on */
    setBars(gid, on) {
        const g = this.get(gid);
        if (g.layout !== 'split') throw new Error(`group '${gid}' is not a split`);
        this._commit(gid, { ...g, split: { ...g.split, bars: on } });
    }

    /** Each pane's rect in a split group. @param {string} gid @returns {Map<string, import('./wallLayout.js').Rect>} */
    paneRects(gid) { return this._paneRects(this.get(gid)); }

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
     * Where a tiled member dragged by its title bar would drop now: the index (in its shown members) of
     * the tile whose centre is nearest its window's, and that tile's rect. Null outside a tiled group.
     * @param {string} id @returns {{ to: number, rect: import('./wallLayout.js').Rect }|null}
     */
    tileDrop(id) {
        const gid = this.groupOf(id);
        if (!gid || this.get(gid).layout !== 'tile') return null;
        const g = this.get(gid);
        const shown = this.shownMembers(gid);
        const { places, metrics } = this._tiling(g, shown);
        const rects = shown.map((m, i) => {
            const t = this.wall.terminalRect(m), x = places[i].x + metrics[i].shiftX, y = places[i].y - metrics[i].shiftY;
            return { minX: x, maxX: x + t.maxX - t.minX, minY: y - (t.maxY - t.minY), maxY: y };
        });
        const r = this.wall.terminalRect(id);
        const to = nearestPlace(rects.map((t) => ({ x: (t.minX + t.maxX) / 2, y: (t.minY + t.maxY) / 2 })), { x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2 });
        return to < 0 ? null : { to, rect: rects[to] };
    }

    /**
     * A tiled member was dragged by its title bar and let go: it takes the tile nearest where it was
     * dropped (the others shift along), and the group tiles again. A freeform member just stays.
     * @param {string} id
     */
    dropMember(id) {
        const drop = this.tileDrop(id);
        if (!drop) { this.wall.rememberPosition(id); return; }
        const gid = this.groupOf(id), g = this.get(gid);
        const order = this.shownMembers(gid).filter((m) => m !== id);
        order.splice(drop.to, 0, id);
        this._commit(gid, { ...g, members: this._withHidden(g, order) });
    }

    /** Re-tile a tiled group over its shown members (a member came, went, hid, showed or resized). */
    relayout(gid) {
        const g = this.get(gid);
        const fs = this.wall.fullscreen;
        if (fs?.groupId === gid) { fs.refit(); return; }
        if (g.layout === 'split') { this._layoutSplit(this._fitted(gid, g)); return; }
        if (g.layout !== 'tile') return;
        // A member fullscreen re-wraps to the screen, not to its tile: the tiling waits for it to come back.
        if (fs?.id && g.members.includes(fs.id)) return;
        const shown = this.shownMembers(gid);
        if (!shown.length) return;
        const origin = g.origin ?? this._originOf(shown);
        const { places, metrics } = this._tiling({ ...g, origin }, shown);
        shown.forEach((id, i) => {
            this.wall.placeBody(id, { x: places[i].x + metrics[i].shiftX, y: places[i].y - metrics[i].shiftY });
            this.wall.rememberPosition(id);
        });
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
     * A group's frame rect at `zoom`: its shown members' footprints (windows + open agent views at that zoom), padded.
     * Null when no member is shown. `bare` names a member whose Agent View is left out (its window alone).
     * A split's is its rect on the canvas, padded: its panes hold every member's window and view, and the
     * rect is exact the moment the split changes (its members re-wrap a frame or more later).
     */
    frameRect(gid, zoom, bare = null) {
        const shown = this.shownMembers(gid);
        if (!shown.length) return null;
        const g = this.get(gid);
        if (g.layout === 'split') {
            const o = g.origin;
            return padRect({ minX: o.x, maxX: o.x + g.split.w, minY: o.y - g.split.h, maxY: o.y }, this.wall.config.groupPad);
        }
        const rectOf = (id) => (id === bare ? this.wall.canvasWindowRect(id, zoom)
            : this.wall.canvasFootprintRect ? this.wall.canvasFootprintRect(id, zoom)
                : this.wall.footprintRect ? this.wall.footprintRect(id, zoom) : this.wall.windowRect(id, zoom));
        return padRect(unionRect(shown.map(rectOf)), this.wall.config.groupPad);
    }

    /** The header's rect at `zoom` (above the frame), or null. */
    headerRect(gid, zoom, bare = null) {
        const f = this.frameRect(gid, zoom, bare);
        const frame = this._frames.get(gid);
        if (!f || !frame) return null;
        return { minX: f.minX, maxX: f.maxX, minY: f.maxY, maxY: f.maxY + frame.headerHeight(zoom) };
    }

    /** All the canvas a group takes at `zoom`: its frame and header (`bare` as frameRect's), or null. */
    boxRect(gid, zoom, bare = null) {
        const f = this.frameRect(gid, zoom, bare), h = this.headerRect(gid, zoom, bare);
        return f && h ? unionRect([f, h]) : f;
    }

    /** Apply world Z positions for each group's frame (backdrop + header). @param {Map<string, number>} depths */
    setDepths(depths) {
        this._groupZ = new Map(depths);
        for (const [gid, frame] of this._frames) {
            frame.position.z = this._groupZ.get(gid) ?? DEFAULT_GROUP_Z;
        }
    }

    /** World Z of group `gid`'s frame. @param {string} gid */
    depthOf(gid) { return this._groupZ.get(gid) ?? DEFAULT_GROUP_Z; }

    /** The group whose header is under a world point — the frontmost group in Z-order wins. @returns {string|null} */
    headerAt(p, zoom) {
        const ordered = this.ids().sort((a, b) => this.depthOf(b) - this.depthOf(a));
        for (const gid of ordered) {
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
            frame.position.z = this.depthOf(gid);
            const rect = hidden || this.wall.fullscreen?.groupId === gid ? null : this.frameRect(gid, zoom);
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

    /** A group's members with its shown ones in `order`; hidden members keep their places relative to the shown ones they followed. */
    _withHidden(g, order) {
        let k = 0;
        return g.members.map((m) => (this.wall.isShown(m) ? order[k++] : m));
    }

    /** Validate a group's layout fields; returns it. */
    _check(g) {
        if (g.layout !== 'tile' && g.layout !== 'freeform' && g.layout !== 'split') throw new Error(`a group's layout is 'tile', 'freeform' or 'split', not '${g.layout}'`);
        if (g.layout === 'split') {
            if (!g.split || !(g.split.w > 0) || !(g.split.h > 0) || !g.origin) throw new Error('a split needs its rect');
            checkTree(g.split.tree, g.members);
        }
        if (!Number.isInteger(g.columns) || g.columns < 1) throw new Error(`columns must be a whole number ≥ 1, not '${g.columns}'`);
        if (!Number.isFinite(g.gap) || g.gap < 0) throw new Error(`gap must be a number ≥ 0, not '${g.gap}'`);
        return g;
    }

    /** Tile footprint metrics for `id` (includes an open Agent View when `wall.agents` is present). */
    _metricsOf(id) {
        if (this.wall.agents?.tileMetrics) return this.wall.agents.tileMetrics(id);
        const r = this.wall.terminalRect(id);
        return {
            w: r.maxX - r.minX,
            h: r.maxY - r.minY,
            shiftX: 0,
            shiftY: 0,
            tileBox: { minX: r.minX, maxX: r.maxX, minY: r.minY, maxY: r.maxY + BAR_ROOM },
        };
    }

    /** Where a tiling of these terminals starts: their footprints' top-left, a bar's room above. */
    _originOf(ids) {
        const rects = ids.filter((id) => this.wall.terminal(id)).map((id) => this._metricsOf(id).tileBox);
        const u = unionRect(rects);
        return u ? { x: u.minX, y: u.maxY } : null;
    }

    /** The tiling of `shown` (member order) for group `g`. */
    _tiling(g, shown) {
        const metrics = shown.map((id) => this._metricsOf(id));
        const { places, extent } = tileLayout(metrics, { origin: g.origin ?? this._originOf(shown), columns: g.columns, gap: g.gap, barRoom: BAR_ROOM });
        return { places, extent, metrics };
    }

    /** Write a group, re-tile it and any group it took members from, and tell the wall. */
    _commit(gid, g, ...touched) {
        this._store.setGroup(gid, g);
        this.relayout(gid);
        for (const other of touched) if (other !== gid && this._store.group(other)) this.relayout(other);
        this._syncBars();
        this.wall._applyZOrder?.();
        this.wall._emit();
    }

    // ── split internals ──────────────────────────────────────────────────────

    /** A split's rect: its fullscreen rect while in Group Fullscreen, else its canvas origin + w × h. */
    _splitRect(g) {
        const fsRect = this.wall.fullscreen?.splitRectForGroup?.(g);
        if (fsRect) return fsRect;
        return { minX: g.origin.x, maxX: g.origin.x + g.split.w, minY: g.origin.y - g.split.h, maxY: g.origin.y };
    }

    /** Each pane's rect. */
    _paneRects(g) { return panes(g.split.tree, this._splitRect(g), this.wall.config.splitGap); }

    /** A cell's world stride, read off one of the group's terminals (all share the wall's font). */
    _cellOf(g) {
        const grid = g.members.map((id) => this.wall.terminal(id)).find(Boolean);
        return grid ? grid.cellStride : { x: 1, y: 1 };
    }

    /** The bar room above a pane: `splitBarRows` rows when the split shows bars. */
    _barRoom(g) { return g.split.bars ? this.wall.config.splitBarRows * this._cellOf(g).y : 0; }

    /** A terminal's frame: its panel less its cells (the grid's own padding), world units. */
    _frameOf(id) {
        const grid = this.wall.terminal(id), r = this.wall.terminalRect(id), s = grid.cellStride;
        return { x: r.maxX - r.minX - grid.cols * s.x, y: r.maxY - r.minY - grid.rows * s.y };
    }

    /** The least a pane takes: MIN_PANE cells, the panel's frame, the bar room and its open Agent View's room. */
    _minPane(g) {
        const s = this._cellOf(g), room = this._barRoom(g);
        const ref = g.members.find((id) => this.wall.terminal(id));
        const f = ref ? this._frameOf(ref) : { x: 0, y: 0 };
        return (id) => {
            const ins = this._insetOf(id);
            return { w: MIN_PANE.cols * s.x + f.x + ins.left + ins.right, h: MIN_PANE.rows * s.y + f.y + room + ins.top + ins.bottom };
        };
    }

    /** The room a pane keeps beside its terminal for that terminal's open Agent View, per edge. */
    _insetOf(id) {
        return this.wall.agents?.inset?.(id) ?? NO_INSET;
    }

    /**
     * A split whose panes can't all hold their minimum (an Agent View opened in a small pane): the
     * dividers move so each pane keeps it (`fitRatios`), and when the whole split is too small it grows
     * right and down first, as a resize to its minimum does. Once the old shape holds every pane again
     * (the view closed) and nothing reshaped the split since, it goes back to it. Writes the store when
     * anything changed; returns the split as it now is.
     */
    _fitted(gid, g) {
        const minPane = this._minPane(g), gap = this.wall.config.splitGap;
        const shape = (x) => JSON.stringify([x.split.tree, x.split.w, x.split.h]);
        const memo = this._fitMemo.get(gid);
        if (memo && memo.after === shape(g)) {
            // Fitted before and untouched since: give the room back if the old shape holds every pane again.
            const old = { ...g, split: { ...g.split, ...memo.before } };
            const m = minSize(old.split.tree, minPane, gap);
            if (m.w <= old.split.w + EDGE_EPS && m.h <= old.split.h + EDGE_EPS
                && fitRatios(old.split.tree, this._splitRect(old), gap, minPane) === old.split.tree) {
                this._fitMemo.delete(gid);
                this._store.setGroup(gid, old);
                return old;
            }
        } else if (memo) this._fitMemo.delete(gid);   // the split changed since (a drag, a pane): its shape is the person's now
        const min = minSize(g.split.tree, minPane, gap);
        let next = g;
        if (min.w > g.split.w + EDGE_EPS || min.h > g.split.h + EDGE_EPS) {
            next = { ...g, split: { ...g.split, w: Math.max(g.split.w, min.w), h: Math.max(g.split.h, min.h) } };
        }
        const tree = fitRatios(next.split.tree, this._splitRect(next), gap, minPane);
        if (tree !== next.split.tree) next = { ...next, split: { ...next.split, tree } };
        if (next !== g) {
            const kept = this._fitMemo.get(gid)?.before ?? { tree: g.split.tree, w: g.split.w, h: g.split.h };
            this._fitMemo.set(gid, { before: kept, after: shape(next) });
            this._store.setGroup(gid, next);
        }
        return next;
    }

    /** Throw `why` unless every pane of `g` gets at least MIN_PANE. */
    _fits(g, why) {
        const min = minSize(g.split.tree, this._minPane(g), this.wall.config.splitGap);
        if (min.w > g.split.w + EDGE_EPS || min.h > g.split.h + EDGE_EPS) throw new Error(`${why}: each pane needs at least ${MIN_PANE.cols}×${MIN_PANE.rows}`);
    }

    /** A node's ratio. */
    _nodeRatio(tree, path) { let n = tree; for (const k of path) n = n[k]; return n.ratio; }

    /**
     * What splitting `at` would make: the split group (an existing one, or one born round `at`'s window)
     * with `id` in the new half, checked to fit. Changes nothing.
     */
    _splitPlan(at, id, dir) {
        if (dir !== 'right' && dir !== 'down') throw new Error(`a split goes right or down, not '${dir}'`);
        if (!this.wall.terminal(at)) throw new Error(`no terminal '${at}'`);
        let gid = this.groupOf(at);
        let g = gid ? this.get(gid) : null;
        const touched = [];
        if (!g || g.layout !== 'split') {
            if (gid) touched.push(gid);
            gid = this._store.newGroupId();
            g = this._asSplit({ name: '', layout: 'tile', columns: 1, gap: this.wall.config.groupGap, origin: null, members: [at], split: null });
        }
        const tree = insert(g.split.tree, at, id, dir === 'right' ? 'row' : 'col');
        const next = { ...g, members: leaves(tree), split: { ...g.split, tree } };
        this._fits(next, `no room to split '${at}' ${dir}`);
        return { gid, next, touched };
    }

    /**
     * A group (any layout, its members on the wall) as a split: its members' windows' union as the rect,
     * cut in rows of `columns` equal panes in member order.
     */
    _asSplit(g) {
        const bars = this.wall.config.splitBars;
        const probe = { ...g, split: { w: 1, h: 1, bars, tree: { id: g.members[0] } } };
        const room = this._barRoom(probe);
        const rects = g.members.filter((id) => this.wall.terminal(id)).map((id) => this.wall.terminalRect(id));
        const u = unionRect(rects);
        if (!u) throw new Error('a split needs its terminals on the wall');
        const columns = Math.max(1, Math.min(g.columns, g.members.length));
        return {
            ...g, layout: 'split', origin: { x: u.minX, y: u.maxY + room },
            split: { w: u.maxX - u.minX, h: u.maxY - u.minY + room, bars, tree: fromMembers(g.members, columns) },
        };
    }

    /** Lay a split out: each member on the wall re-wrapped to fit its pane, its panel at the pane's top-left. */
    _layoutSplit(g) {
        const fs = this.wall.fullscreen?.id;
        if (fs && g.members.includes(fs)) return;   // a member fullscreen: the split waits for it
        const room = this._barRoom(g);
        for (const [id, pr] of this._paneRects(g)) {
            const grid = this.wall.terminal(id);
            if (!grid) continue;   // its grid isn't here (yet): its pane waits for it
            // An open Agent View keeps its share of the pane (its side, `agentInset`): the terminal fills the rest.
            const s = grid.cellStride, f = this._frameOf(id), ins = this._insetOf(id);
            const cols = Math.max(MIN_PANE.cols, Math.floor((pr.maxX - pr.minX - ins.left - ins.right - f.x) / s.x + EDGE_EPS));
            const rows = Math.max(MIN_PANE.rows, Math.floor((pr.maxY - pr.minY - room - ins.top - ins.bottom - f.y) / s.y + EDGE_EPS));
            if (cols !== grid.cols || rows !== grid.rows) this.wall.router.execute(['terminal.resize', id, String(cols), String(rows)]);
            this.wall.placeBody(id, { x: pr.minX + ins.left, y: pr.maxY - room - ins.top });
            this.wall.rememberPosition(id);
            this.wall.names?.setBarRoom(id, room);
        }
    }

    /** Every terminal not in a split gets the usual title bar back. */
    _syncBars() {
        const names = this.wall.names;
        if (!names) return;
        for (const id of this.wall.order ?? []) if (!this.splits(id)) names.setBarRoom(id, null);
    }
}

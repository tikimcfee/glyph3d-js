/**
 * PaneLayout — ONE tiling layout, shared by the CameraDock's view-frame and a tiled plane desk
 * (docs/planes/DESIGN.md §3.11): a {@link PaneTree} over pane ids, each pane a STACK of member ids
 * with one active (i3 tabbed), the INBOX pane a joiner lands in, the FOCUSED pane, and a ZOOMED one
 * (tmux -Z). It answers whole-device-pixel rects for a frame, gutters taken out.
 *
 * The law it keeps: a member JOINING lands in the inbox as its active tab — no pane is split, so
 * NO pane's rect changes (a join, an open, an attach). Only an explicit verb re-tiles: a named
 * layout (`even` / `main` / `stack`, applied when a desk first tiles), a split, a close, a resize.
 *
 * Pane ids: by default `pane:N` from a counter; `paneIds: 'member'` names each new pane after the
 * member it is made for (the dock: one window per pane, so its tree's leaves ARE window ids).
 *
 * PURE: no THREE, no DOM. The owner decides what a change means (re-place members, persist).
 * Gate: tools/pane-layout.test.mjs.
 */

import PaneTree from './PaneTree.js';

/** @typedef {{ids:string[], active:string|null}} Stack */
/** @typedef {{x:number, y:number, w:number, h:number}} Rect */
/**
 * @typedef {Object} PanesRecord
 * @property {Object|null} tree  PaneTree.serialize()
 * @property {Array<{id:string, ids:string[], active:string|null}>} stacks
 * @property {string|null} inbox
 * @property {number} seq
 * @property {string|null} focus
 * @property {string|null} zoomed
 */

export default class PaneLayout {
    /** @param {{paneIds?: 'seq'|'member'}} [opts] */
    constructor({ paneIds = 'seq' } = {}) {
        if (paneIds !== 'seq' && paneIds !== 'member') throw new Error(`PaneLayout: paneIds is 'seq' or 'member' (got ${paneIds})`);
        this.paneIds = paneIds;
        /** @type {PaneTree|null} */
        this.tree = null;
        /** @type {Map<string, Stack>} */
        this.stacks = new Map();
        /** @type {string|null} the pane a joiner lands in */
        this.inbox = null;
        /** @type {number} the pane-id counter */
        this.seq = 0;
        /** @type {string|null} the focused pane */
        this.focus = null;
        /** @type {string|null} the pane zoomed to the whole frame */
        this.zoomed = null;
    }

    // ===================== queries =====================

    /** @returns {boolean} */
    isEmpty() { return !this.tree || this.tree.isEmpty(); }

    /** @returns {number} panes */
    count() { return this.isEmpty() ? 0 : this.tree.count(); }

    /** @returns {string[]} pane ids, in tree order (left/top first) */
    panes() { return this.isEmpty() ? [] : this.tree.leaves(); }

    /** @param {string} paneId @returns {boolean} */
    has(paneId) { return !this.isEmpty() && this.tree.has(paneId); }

    /** The pane a member sits in. @param {string} memberId @returns {string|null} */
    paneOf(memberId) {
        for (const [id, st] of this.stacks) if (st.ids.includes(memberId)) return id;
        return null;
    }

    /** Every member, pane by pane in tree order. @returns {string[]} */
    members() { return this.panes().flatMap((p) => this.stacks.get(p)?.ids ?? []); }

    /** The focused pane (else the inbox, else the first); null when empty. @returns {string|null} */
    focused() {
        if (this.isEmpty()) return null;
        if (this.focus && this.has(this.focus)) return this.focus;
        return this.has(this.inbox) ? this.inbox : this.tree.leaves()[0];
    }

    /**
     * The member a pane shows: its active tab when live, else its newest live member.
     * @param {string} paneId @param {(id:string) => boolean} [live] @returns {string|null}
     */
    front(paneId, live = () => true) {
        const st = this.stacks.get(paneId);
        if (!st) return null;
        if (st.active && live(st.active)) return st.active;
        return [...st.ids].reverse().find(live) ?? null;
    }

    // ===================== structure =====================

    /** Forget every pane. */
    clear() {
        this.tree = null;
        this.stacks = new Map();
        this.inbox = null;
        this.focus = null;
        this.zoomed = null;
    }

    /**
     * Re-tile as a named layout over `ids` (in order), one member per pane: 'even' — rows of up to
     * `perRow` side by side; 'main' — the first a wide pane on the left (`mainRatio`), the rest
     * stacked on the right; 'stack' — one pane, every member a tab. The last pane becomes the inbox,
     * the first takes focus.
     * @param {'even'|'main'|'stack'} name @param {string[]} ids
     * @param {{perRow?:number, mainRatio?:number}} [opts] @returns {boolean} false for an unknown name
     */
    layout(name, ids, { perRow = 3, mainRatio = 0.6 } = {}) {
        if (!['even', 'main', 'stack'].includes(name)) return false;
        this.clear();
        if (!ids.length) return true;
        const add = (list) => this._newPane(list);
        // Split `from` into equal parts along `axis`, one new pane per extra member list.
        const fan = (from, axis, lists) => {
            const out = [from];
            for (let i = 1; i < lists.length; i++) {
                const id = add(lists[i]);
                this.tree.split(out[out.length - 1], axis, id, { ratio: 1 / (lists.length - i + 1) });
                out.push(id);
            }
            return out;
        };
        if (name === 'stack') {
            this.tree = PaneTree.leaf(add(ids));
        } else if (name === 'main' && ids.length > 1) {
            const main = add([ids[0]]);
            this.tree = PaneTree.leaf(main);
            const side = add([ids[1]]);
            this.tree.split(main, 'x', side, { ratio: mainRatio });
            fan(side, 'y', ids.slice(1).map((id) => [id]));
        } else {
            const per = Math.max(1, perRow);
            const rows = [];
            for (let i = 0; i < ids.length; i += per) rows.push(ids.slice(i, i + per));
            const first = add([rows[0][0]]);
            this.tree = PaneTree.leaf(first);
            // Rows first (stacked, top to bottom), each row's first pane standing for it…
            const heads = [first];
            for (let r = 1; r < rows.length; r++) {
                const id = add([rows[r][0]]);
                this.tree.split(heads[heads.length - 1], 'y', id, { ratio: 1 / (rows.length - r + 1) });
                heads.push(id);
            }
            // …then each row fans out side by side.
            rows.forEach((row, r) => fan(heads[r], 'x', row.map((id) => [id])));
        }
        const leaves = this.tree.leaves();
        this.inbox = leaves[leaves.length - 1];
        this.focus = leaves[0];
        return true;
    }

    /**
     * A member JOINS: it lands in the inbox as the active tab — no pane splits, no rect changes. An
     * empty layout gets its first pane (the inbox). A member already placed stays where it is.
     * @param {string} memberId @returns {string} its pane
     */
    join(memberId) {
        const at = this.paneOf(memberId);
        if (at) return at;
        if (this.isEmpty()) {
            const id = this._newPane([]);
            this.tree = PaneTree.leaf(id);
            this.inbox = id;
            this.focus = id;
        }
        if (!this.has(this.inbox)) this.inbox = this.tree.leaves()[this.tree.count() - 1];
        const st = this.stacks.get(this.inbox);
        st.ids.push(memberId);
        st.active = memberId;
        return this.inbox;
    }

    /**
     * A member LEAVES its stack; its pane stays (a desk keeps its tiles). @param {string} memberId
     * @returns {string|null} the pane it left
     */
    leave(memberId) {
        const p = this.paneOf(memberId);
        if (!p) return null;
        this._unstack(p, memberId);
        return p;
    }

    /**
     * A member leaves, and its pane closes if that empties it (the dock: a pane is its window).
     * @param {string} memberId @returns {boolean} whether it was placed
     */
    drop(memberId) {
        const p = this.leave(memberId);
        if (!p) return false;
        if (!this.stacks.get(p).ids.length) this.close(p, { merge: false });
        return true;
    }

    /**
     * Split a pane (default the focused one), putting `memberId` in the new pane — taken out of any
     * stack that held it. The new pane is focused; a zoom ends.
     * @param {'x'|'y'} axis @param {string} memberId
     * @param {{before?:boolean, ratio?:number, from?:string|null}} [opts]
     * @returns {string|null} the new pane
     */
    split(axis, memberId, { before = false, ratio = 0.5, from = this.focused() } = {}) {
        if ((axis !== 'x' && axis !== 'y') || !from || !this.has(from)) return null;
        if (this.paneIds === 'member' && this.has(memberId)) return null;
        const old = this.paneOf(memberId);
        const id = this._newPane([memberId]);
        if (!this.tree.split(from, axis, id, { before, ratio })) { this.stacks.delete(id); return null; }
        if (old) this._unstack(old, memberId);
        this.focus = id;
        this.zoomed = null;
        return id;
    }

    /**
     * Close a pane (default the focused one); its sibling collapses up, ratios kept. `merge`: its tabs
     * join the pane that takes its place, and the last pane can't close (a desk); without, they go
     * with it and the last pane can (the dock). Focus moves to the pane that took its place.
     * @param {string} [paneId] @param {{merge?:boolean}} [opts]
     * @returns {string|null} the pane that took its place (null when the layout emptied or refused)
     */
    close(paneId = this.focused(), { merge = true } = {}) {
        if (!paneId || !this.has(paneId)) return null;
        if (merge && this.count() < 2) return null;
        const moving = this.stacks.get(paneId)?.ids ?? [];
        const next = this.tree.close(paneId);
        this.stacks.delete(paneId);
        if (this.zoomed === paneId) this.zoomed = null;
        if (this.tree.isEmpty()) { this.clear(); return null; }
        if (merge) {
            const into = this.stacks.get(next);
            for (const id of moving) if (!into.ids.includes(id)) into.ids.push(id);
        }
        if (this.inbox === paneId) this.inbox = next;
        this.focus = next;
        return next;
    }

    /**
     * Exchange two panes' CONTENTS: every rect stays where it is, the stacks trade places (tmux
     * swap-pane). With member-named panes the pane IS its member, so the leaves trade instead.
     * @returns {boolean}
     */
    swap(a, b) {
        if (a === b || !this.has(a) || !this.has(b)) return false;
        if (this.paneIds === 'member') return this.tree.swap(a, b);
        const sa = this.stacks.get(a);
        this.stacks.set(a, this.stacks.get(b));
        this.stacks.set(b, sa);
        return true;
    }

    /**
     * The focused pane's active tab: 'next' / 'prev' cycle, a member id picks it.
     * @param {string} which @param {(id:string) => boolean} [live] @returns {string|null} the active member
     */
    tab(which = 'next', live = () => true) {
        const cur = this.focused();
        const st = cur && this.stacks.get(cur);
        const ids = st ? st.ids.filter(live) : [];
        if (!ids.length) return null;
        let next;
        if (which === 'next' || which === 'prev') {
            const i = Math.max(0, ids.indexOf(this.front(cur, live)));
            next = ids[(i + (which === 'next' ? 1 : ids.length - 1)) % ids.length];
        } else if (ids.includes(which)) next = which;
        else return null;
        st.active = next;
        return next;
    }

    /** Zoom the focused pane to the whole frame, or unzoom. @returns {string|null} the zoomed pane */
    zoom(on = !this.zoomed) {
        const cur = this.focused();
        if (!cur) return null;
        this.zoomed = on ? cur : null;
        return this.zoomed;
    }

    /**
     * Put a member in a pane: 'tab' — into its stack as the active tab; a direction — a new pane split
     * off that side of it. @param {string} memberId @param {string} paneId
     * @param {'tab'|'left'|'right'|'up'|'down'} where @returns {string|null} the member's pane
     */
    place(memberId, paneId, where = 'tab') {
        if (!this.has(paneId)) return null;
        if (where === 'tab') {
            const old = this.paneOf(memberId);
            if (old) this._unstack(old, memberId);
            const st = this.stacks.get(paneId);
            st.ids.push(memberId);
            st.active = memberId;
            this.focus = paneId;
            return paneId;
        }
        const axis = (where === 'left' || where === 'right') ? 'x' : (where === 'up' || where === 'down') ? 'y' : null;
        if (!axis) return null;
        return this.split(axis, memberId, { before: where === 'left' || where === 'up', from: paneId });
    }

    /** Focus a pane by id, or the pane holding a member; a zoom on another pane ends. @returns {string|null} */
    focusOn(idOrMember) {
        const pane = this.has(idOrMember) ? idOrMember : this.paneOf(idOrMember);
        if (!pane) return null;
        if (this.zoomed && this.zoomed !== pane) this.zoomed = null;
        this.focus = pane;
        return pane;
    }

    /** Focus the geometric neighbor (i3). @param {'left'|'right'|'up'|'down'} dir @returns {string|null} */
    focusDir(dir) {
        const cur = this.focused();
        const next = cur ? this.tree.neighbor(cur, dir) : null;
        return next ? this.focusOn(next) : null;
    }

    /** Grow the focused pane along an axis (siblings give up space). @returns {boolean} */
    resize(axis, delta) {
        const cur = this.focused();
        return !!cur && this.tree.resize(cur, axis, delta);
    }

    // ===================== geometry =====================

    /**
     * Normalized rects (the unit frame, y UP — PaneTree's convention): a zoomed pane takes the whole
     * frame and the others none. @returns {Map<string, Rect>}
     */
    unitRects() {
        if (this.isEmpty()) return new Map();
        if (this.zoomed && this.has(this.zoomed)) return new Map([[this.zoomed, { x: 0, y: 0, w: 1, h: 1 }]]);
        return this.tree.rects();
    }

    /**
     * Every shown pane in a frame of `widthPx × heightPx` device px: its rect (from the frame's
     * top-left, +y DOWN, whole pixels, gutters taken out — half a gutter each side, so neighbors
     * meet a whole gutter apart and the frame edge keeps half), its stack and active member.
     * @param {{widthPx:number, heightPx:number, gapPx?:number}} frame
     * @returns {Array<{id:string, rect:Rect, stack:string[], active:string|null}>}
     */
    rects({ widthPx, heightPx, gapPx = 0 }) {
        if (!(widthPx > 0) || !(heightPx > 0)) throw new Error(`PaneLayout.rects: bad frame ${widthPx}×${heightPx}`);
        const half = Math.max(0, Math.round(gapPx)) / 2;
        const out = [];
        for (const [id, u] of this.unitRects()) {
            const r = { x: u.x * widthPx, y: u.y * heightPx, w: u.w * widthPx, h: u.h * heightPx };
            const left = Math.round(r.x), right = Math.round(r.x + r.w);
            const top = Math.round(heightPx - (r.y + r.h)), bottom = Math.round(heightPx - r.y);
            const x = left + Math.ceil(half), y = top + Math.ceil(half);
            const w = Math.max(0, right - Math.floor(half) - x), h = Math.max(0, bottom - Math.floor(half) - y);
            const st = this.stacks.get(id) || { ids: [], active: null };
            out.push({ id, rect: { x, y, w, h }, stack: [...st.ids], active: st.active });
        }
        return out;
    }

    // ===================== persistence =====================

    /** @returns {PanesRecord|null} null when empty */
    serialize() {
        if (this.isEmpty()) return null;
        return {
            tree: this.tree.serialize(),
            stacks: [...this.stacks].map(([id, st]) => ({ id, ids: [...st.ids], active: st.active })),
            inbox: this.inbox, seq: this.seq, focus: this.focus, zoomed: this.zoomed,
        };
    }

    /**
     * Stand a saved layout back up: the tree, every stack (members not present yet keep their place),
     * inbox, focus, zoom. A malformed record throws — a silent fallback would lay out as something it
     * never was. @param {PanesRecord} rec
     */
    apply(rec) {
        if (!rec || typeof rec !== 'object' || !rec.tree || !Array.isArray(rec.stacks)) {
            throw new Error(`PaneLayout.apply: malformed record ${JSON.stringify(rec)?.slice(0, 200)}`);
        }
        const tree = PaneTree.deserialize(rec.tree);
        const leaves = new Set(tree.leaves());
        const stacks = new Map();
        for (const st of rec.stacks) {
            if (!leaves.has(st?.id) || !Array.isArray(st.ids)) throw new Error(`PaneLayout.apply: stack ${JSON.stringify(st)} names no pane of the tree`);
            stacks.set(st.id, { ids: st.ids.map(String), active: st.active ?? null });
        }
        for (const id of leaves) if (!stacks.has(id)) stacks.set(id, { ids: [], active: null });
        this.tree = tree;
        this.stacks = stacks;
        this.inbox = leaves.has(rec.inbox) ? rec.inbox : [...leaves].pop();
        this.focus = leaves.has(rec.focus) ? rec.focus : this.inbox;
        this.zoomed = leaves.has(rec.zoomed) ? rec.zoomed : null;
        const maxSeq = Math.max(0, ...[...leaves].map((id) => Number(String(id).split(':')[1]) || 0));
        this.seq = Math.max(Number(rec.seq) || 0, maxSeq);
    }

    // ===================== internals =====================

    /** A new pane's id, its stack holding `ids` (the caller puts it in the tree). @private */
    _newPane(ids) {
        const id = this.paneIds === 'member' && ids.length ? ids[0] : `pane:${++this.seq}`;
        this.stacks.set(id, { ids: [...ids], active: ids[ids.length - 1] ?? null });
        return id;
    }

    /** Take a member out of a pane's stack. @private */
    _unstack(paneId, memberId) {
        const st = this.stacks.get(paneId);
        if (!st) return;
        st.ids = st.ids.filter((id) => id !== memberId);
        if (st.active === memberId) st.active = st.ids[st.ids.length - 1] ?? null;
    }
}

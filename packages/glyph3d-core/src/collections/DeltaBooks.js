/**
 * DeltaBooks — before/after change SETS, each bound as a BOOK on the field. Where an
 * agent book is a run's timeline (one sheet per action), a delta book is a changeset's
 * roster: ONE SHEET PER CHANGED FILE, and the sheet's page-pair IS the delta —
 *
 *   verso (left)  — the BASE: the file as it was (removed lines barred red),
 *   recto (right) — the HEAD: the file as it is  (added lines barred green),
 *
 * aligned line-for-line (spacers hold the rhythm where one side has no counterpart),
 * hunk headers tinted. Only changed files exist in the deck — the dense observation
 * view of "what moved", against the whole-repo tree's exploration view.
 *
 * Three ways a set fills (all reduce through services/state/deltaSource to the ONE
 * aligned shape):
 *   delta.watch <agentId> — LIVE: every edit/write the agent lands updates that
 *     file's sheet in place. The base is captured ONCE per file (the first event's
 *     hunks reverse-applied against disk), so the spread shows CUMULATIVE drift
 *     since watching began, not just the last keystroke.
 *   delta.git [base] [head] — a git changeset (working tree by default, or
 *     commit-to-commit for the differentiable-steps view), hunk-condensed.
 *   delta.pair <a> <b> — any two files as one spread.
 *
 * A set's book follows the freshest change: while the head rides the open sheet,
 * an updated file turns the book to itself; page away and it holds (page back to
 * the newest sheet to resume following — the agent books' grammar). The cluster
 * is a world grouping beside the file tree and the agent shelf; book.* pages it,
 * shift+wheel turns it, drag pins it. Nothing here ever moves the camera.
 */

import * as THREE from 'three';
import Book from './Book.js';
import CodeGrid from './CodeGrid.js';
import FieldLabel from './FieldLabel.js';
import { LAYOUT_SCHEMES } from './layouts/index.js';
import { RENDER_ORDER } from '../core/renderOrder.js';
import { alignTexts, alignPatch, reconstructBase } from '../services/state/deltaSource.js';

export const DELTA_BOOKS_DEFAULTS = {
    // -- the page ------------------------------------------------------------------
    pageW: 480,                 // page width per side — code pages, wider than agent cards
    pageH: 640,                 // page height
    gutter: 28,                 // the spread's spine gap between base and head
    maxUpscale: 3,              // contain-fit may enlarge a small delta up to this
    face: true,                 // render the page faces behind the content
    faceColor: 0x0a0a1e,        // page-face fill
    faceOpacity: 0.85,
    faceDepth: 6,
    // -- the deck (rolodex) --------------------------------------------------------
    zPitch: 90,                 // deck pitch between file sheets
    pagerLerp: 9,
    // -- the delta rendering -------------------------------------------------------
    artifactWorldScale: 0.025,  // worldScale of the base/head grids (fine print you fly into)
    view: 'condensed',          // 'condensed' (hunks + context) | 'full' (whole files aligned) —
                                // text-pair lanes only; the git lane has hunks, not full bases
    context: 3,                 // context lines around a hunk in the condensed view
    fillOpacity: 0.28,          // add/remove line-bar opacity (the glyph fill texel)
    addColor:    { r: 0.15, g: 0.85, b: 0.35 },   // head-side bar: lines that arrived
    removeColor: { r: 0.95, g: 0.30, b: 0.30 },   // base-side bar: lines that left
    hunkColor:   { r: 0.40, g: 0.60, b: 1.00 },   // @@ headers, additive tint both sides
    // -- the cluster ---------------------------------------------------------------
    layout: 'packed',
    layoutOpts: { margin: 80 },
    floorY: 0,
    // -- identity ------------------------------------------------------------------
    cover: true,
    coverPad: 16,
    coverZPad: 24,
    coverOpacity: 0.06,
    coverEdgeOpacity: 0.22,
    palette: [                  // per-set identity hues — its own family, beside the agents'
        0x3aa58a, 0xa53a7a, 0x7aa53a, 0x3a7aa5, 0xa5863a, 0x6a3aa5,
    ],
};

const basename = (p) => String(p).split('/').filter(Boolean).pop() || String(p);

export default class DeltaBooks {
    constructor(ctx, opts = {}) {
        this.ctx = ctx;
        this.scene = ctx.scene;
        this.atlas = ctx.atlas;
        this.cfg = { ...DELTA_BOOKS_DEFAULTS, ...opts };

        this.root = new THREE.Group();
        this.root.name = 'delta-books';
        this.scene.add(this.root);
        this._rootPlaced = false;

        /** setId → set: the book, its per-file entries, identity, lifecycle. */
        this.sets = new Map();
        // Delta pages pick as role 'delta-page' (grid channel), covers as role 'delta'
        // (group channel) — mark BEFORE any register (SceneRegistry only admits known types).
        this.ctx.registry?.setPickable?.('delta-page');
        this.ctx.registry?.setPickable?.('delta');
        this._listeners = new Set();
        this._onRelayout = [];
        this._tmp = new THREE.Vector3();
    }

    // -- subscriptions ---------------------------------------------------------------

    onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
    _emitChange() { for (const fn of this._listeners) { try { fn(); } catch (_e) { /* listener owns its errors */ } } }

    onRelayout(cb) {
        this._onRelayout.push(cb);
        return () => { const i = this._onRelayout.indexOf(cb); if (i >= 0) this._onRelayout.splice(i, 1); };
    }

    // -- sets ------------------------------------------------------------------------

    /**
     * The set (and its book) for an id — created on first sight.
     * @param {string} setId  plain id ('dev', 'HEAD~1..HEAD', 'pair') — the delta address
     *        space; `delta:<id>` resolves back to it (resolveSet).
     * @param {{kind?: 'watch'|'static', label?: string}} [opts]
     */
    ensure(setId, { kind = 'static', label = null } = {}) {
        let set = this.sets.get(setId);
        if (!set) {
            if (!this._rootPlaced) this._placeRootInView();
            const book = new Book();
            book.name = `delta:${setId}`;
            book.userData = { ...book.userData, name: setId, isDir: false };   // a layout LEAF
            book.deck.zPitch = this.cfg.zPitch;
            book.deck.lerp = this.cfg.pagerLerp;
            this.root.add(book);
            const hueIdx = this.sets.size;
            const hue = this.cfg.palette[hueIdx % this.cfg.palette.length];
            book.bindCover(this._coverOpts(hue));
            set = {
                book, hueIdx, setId,
                kind,                          // 'watch' (fed by the agent stream) | 'static'
                label: label || setId,
                seq: 0,
                entries: new Map(),            // path → { sheetId, verso, recto, baseText, stats, status, ids }
                order: [],                     // paths in sheet order — index-parallel with book.sheets
                jobs: new Map(),               // path → tail of its async update chain (watch lane ordering)
                groupId: `delta:book:${setId}`,
                pinned: false, pinnedPos: null,
                lastActivityTs: this._now(),
            };
            book.fit(this._pageOpts(set));     // page form from birth — sheets inherit it
            set.labelField = new FieldLabel({
                atlas: this.atlas,
                text: `Δ ${set.label}`,
                lineHeight: (this.cfg.pageH * 0.05) / 3,
                plate: { color: hue, opacity: 0.85 },
            });
            set.labelField.name = `delta-label:${setId}`;
            book.setNameplate(set.labelField);
            this.sets.set(setId, set);
            this._registerGroup(set);
            this._emitChange();
        } else if (label && set.label !== label) {
            set.label = label;
            set.labelField?.setText(`Δ ${set.label}`);
        }
        return set;
    }

    /**
     * THE set resolver — lookup + field check, never prefix surgery:
     *   omitted/falsy → the first set; a Book object → field identity; the set id →
     *   map exact; the registry group id → groupId compare; `delta:<id>` → only when
     *   the remainder looks up.
     * @returns {[string, Object]|null}
     */
    resolveSet(ref) {
        if (ref == null || ref === '') return this.sets.entries().next().value || null;
        if (typeof ref === 'object') {
            for (const e of this.sets.entries()) if (e[1].book === ref) return e;
            return null;
        }
        const id = String(ref);
        if (this.sets.has(id)) return [id, this.sets.get(id)];
        for (const e of this.sets.entries()) if (e[1].groupId === id) return e;
        if (id.startsWith('delta:')) {
            const rest = id.slice(6);
            if (this.sets.has(rest)) return [rest, this.sets.get(rest)];
        }
        return null;
    }

    /** Remove ONE set (book, sheets, grids, registrations). */
    remove(setId) {
        const hit = this.resolveSet(setId);
        if (!hit) return false;
        this._kill(hit[1]);
        this.sets.delete(hit[0]);
        this._relayout();
        this._emitChange();
        return true;
    }

    /** Remove every set. Returns the count removed. */
    clear() {
        let n = 0;
        for (const [id, set] of this.sets) { this._kill(set); this.sets.delete(id); n++; }
        this._rootPlaced = false;
        if (n) { this._relayout(); this._emitChange(); }
        return n;
    }

    // -- the delta sink ----------------------------------------------------------------

    /**
     * Land one file's aligned delta into a set — creates its sheet on first sight,
     * refreshes it in place after. The ONE ingress every lane funnels through.
     * @param {string} setId
     * @param {string} path     canonical file key (absolute for watch, repo-relative for git)
     * @param {{left: Array, right: Array, added: number, removed: number, status?: string,
     *          baseText?: string|null, name?: string}} delta
     *        left/right are DiffParser DiffLine arrays; baseText (watch lane) persists on
     *        the entry so the NEXT event diffs against the same base; name overrides the
     *        displayed filename (defaults to basename(path)).
     */
    setFile(setId, path, delta) {
        const set = this.ensure(setId);
        set.lastActivityTs = this._now();
        let entry = set.entries.get(path);
        const name = delta.name || basename(path);
        const leftText = delta.left.map((l) => l.text).join('\n');
        const rightText = delta.right.map((l) => l.text).join('\n');
        if (!entry) {
            const seq = set.seq++;
            const sheetId = `delta:${setId}:${seq}`;
            const verso = this._makeGrid(name);
            const recto = this._makeGrid(name);
            entry = {
                sheetId, path, verso, recto,
                baseId: `${sheetId}:base`, headId: `${sheetId}:head`,
                baseText: delta.baseText ?? null,
                stats: { added: delta.added, removed: delta.removed },
                status: delta.status || 'modified',
            };
            set.entries.set(path, entry);
            set.order.push(path);
            set.book.addSheet({ verso, recto });
            this._loadPair(set, entry, name, leftText, rightText, delta);
        } else {
            entry.stats = { added: delta.added, removed: delta.removed };
            entry.status = delta.status || entry.status;
            if (delta.baseText !== undefined) entry.baseText = delta.baseText;
            this._loadPair(set, entry, name, leftText, rightText, delta);
        }
        this._followTo(set, path);
        if (!this._batch) { this._relayout(); this._emitChange(); }
        return entry;
    }

    /** Drop one file's sheet from a set (the file left the changeset). */
    removeFile(setId, path) {
        const set = this.sets.get(setId);
        const entry = set?.entries.get(path);
        if (!entry) return false;
        const i = set.order.indexOf(path);
        if (i >= 0) { set.book.removeSheet(i); set.order.splice(i, 1); }
        set.entries.delete(path);
        this._disposeEntry(entry);
        this._requestRelayout();
        this._emitChange();
        return true;
    }

    /**
     * The LIVE lane: a normalized agent tool record (agent.tool ingress calls this for
     * every event; unwatched agents fall straight through). Edits and writes to real
     * files update the agent's watch set — base captured once per file, head re-read
     * from disk, the cumulative pair re-aligned. Async work serializes per file so a
     * burst of edits lands in order.
     * @param {string} agentId
     * @param {{action: string, target?: string, meta?: Object}} rec  normalizeToolCall's record
     * @param {string} [cwd]  the event's working dir — absolutizes the relativized target
     */
    ingestTool(agentId, rec, cwd = '') {
        const set = this.sets.get(agentId);
        if (!set || set.kind !== 'watch') return;
        if ((rec.action !== 'edit' && rec.action !== 'write') || !rec.target) return;
        const abs = rec.target.startsWith('/') ? rec.target
                  : cwd ? `${cwd.replace(/\/+$/, '')}/${rec.target}` : rec.target;
        // Serialize per file: a burst of edits to one path lands in event order, and the
        // second event's base read waits for the first to have captured the baseline.
        const chain = set.jobs.get(abs) || Promise.resolve();
        const job = chain.then(async () => {
            const head = String((await this.ctx.fileProvider?.getFile?.(abs)) ?? '');
            let baseText = set.entries.get(abs)?.baseText;
            if (baseText == null) {
                // First sight of this file: walk back to its pre-edit text. An edit's
                // hunks reverse-apply; a write has no way back — its base is empty
                // (a fresh file) which is also the honest all-added read of "rewrote it".
                if (rec.action === 'edit' && rec.meta?.patch) {
                    baseText = reconstructBase(head, rec.meta.patch);
                    if (baseText == null) {
                        console.warn(`[DeltaBooks] ${abs}: edit patch no longer applies (file drifted) — baseline is the current head; the delta starts empty from here`);
                        baseText = head;
                    }
                } else {
                    baseText = '';
                }
            }
            const aligned = alignTexts(baseText, head, { view: this.cfg.view, context: this.cfg.context });
            this.setFile(agentId, abs, { ...aligned, baseText, name: basename(rec.target), status: rec.action === 'write' ? 'written' : 'modified' });
        }).catch((e) => console.warn(`[DeltaBooks] watch update failed for ${abs}:`, e));
        set.jobs.set(abs, job);
    }

    /** A git changeset (splitUnifiedDiff's records) → the set, in one batch: sheets for
     *  every changed file, stale sheets (files no longer in the diff) dropped. */
    applyChangeset(setId, files, { label = null } = {}) {
        const set = this.ensure(setId, { label });
        this._batch = true;
        const seen = new Set();
        try {
            for (const f of files) {
                if (f.status === 'binary' || !f.patch) continue;
                seen.add(f.path);
                this.setFile(setId, f.path, { ...alignPatch(f.patch), status: f.status });
            }
            for (const path of [...set.order]) if (!seen.has(path)) this.removeFile(setId, path);
        } finally {
            this._batch = false;
        }
        this._relayout();
        this._emitChange();
        return seen.size;
    }

    // -- paging (the book.* verbs' engine) ---------------------------------------------

    scroll(setId, delta)  { const hit = this.resolveSet(setId); return hit ? hit[1].book.scroll(delta) : false; }
    pageTo(setId, index)  { const hit = this.resolveSet(setId); return hit ? hit[1].book.pageTo(index) : false; }
    headState(setId)      { const hit = this.resolveSet(setId); return hit ? { setId: hit[0], ...hit[1].book.headState() } : null; }

    /** Pin a set's book where the user put it (drag-release / book.move). */
    moveGroup(id, x, y, z) {
        const set = id != null ? this.resolveSet(id)?.[1] : null;
        if (!set) return false;
        set.pinned = true;
        set.pinnedPos = new THREE.Vector3(x, y, z);
        set.book.position.copy(set.pinnedPos);
        return true;
    }

    // -- panel / verb feeds ------------------------------------------------------------

    /** The sets present — a roster row each: id, kind, label, files, totals, head. */
    list() {
        const pal = this.cfg.palette;
        return [...this.sets.entries()].map(([id, s]) => {
            let added = 0, removed = 0;
            for (const e of s.entries.values()) { added += e.stats.added; removed += e.stats.removed; }
            return {
                id, kind: s.kind, label: s.label,
                files: s.order.length, added, removed,
                color: '#' + ((pal[s.hueIdx % pal.length] >>> 0) & 0xffffff).toString(16).padStart(6, '0'),
                head: s.book.head, following: s.book.following,
                lastTs: s.lastActivityTs,
            };
        });
    }

    /** One set's file roster in sheet order: { index, path, name, status, added, removed, focused }. */
    files(setId) {
        const hit = this.resolveSet(setId);
        if (!hit) return [];
        const set = hit[1];
        const head = set.book.head;
        return set.order.map((path, i) => {
            const e = set.entries.get(path);
            return { index: i, path, name: basename(path), status: e.status,
                     added: e.stats.added, removed: e.stats.removed, focused: i === head };
        });
    }

    // -- per-frame ---------------------------------------------------------------------

    update(dt) { for (const set of this.sets.values()) set.book.update(dt); }

    /**
     * Re-apply the current cfg to every live set — the entry the Settings rows and the
     * config verb route through (mirrors AgentBooks.applyScales). Deck knobs re-seat,
     * every book re-fits its pages (new page geometry / face), and the cluster re-flows.
     */
    applyScales() {
        for (const set of this.sets.values()) {
            set.book.deck.zPitch = this.cfg.zPitch;
            set.book.deck.lerp = this.cfg.pagerLerp;
            set.book.fit(this._pageOpts(set));
        }
        this._relayout();
    }

    dispose() {
        this.clear();
        this.scene.remove(this.root);
    }

    // -- private: pages ----------------------------------------------------------------

    _now() { return typeof performance !== 'undefined' ? performance.now() : 0; }

    _pageOpts(set = null) {
        const c = this.cfg;
        const hex = set ? c.palette[set.hueIdx % c.palette.length] : c.faceColor;
        return {
            pageW: c.pageW, pageH: c.pageH, gutter: c.gutter, maxUpscale: c.maxUpscale,
            surface: c.face, surfacePad: 0, surfaceDepth: c.faceDepth,
            surfaceColor: c.faceColor, surfaceOpacity: c.faceOpacity,
            surfaceBorder: true, surfaceBorderColor: hex,
            ownFace: true,
        };
    }

    _makeGrid(name) {
        return new CodeGrid(this.scene, this.atlas, {
            name: `delta:${name}`, showFilename: true, showBackground: true,
            worldScale: this.cfg.artifactWorldScale,
        });
    }

    /** Load both sides of a sheet (the real filename keeps syntax color honest), then
     *  bar the delta and re-fit — resolved by sheetId, not index (files can be dropped
     *  under a pending load). */
    _loadPair(set, entry, name, leftText, rightText, delta) {
        const settle = () => this._settle(set, entry.sheetId);
        Promise.all([
            entry.verso.loadFile(name, leftText).then(() => {
                entry.verso.clearAllHighlights?.();
                this._barSide(entry.verso, delta.left, 'remove');
                this._wirePagePick(set, entry, 'verso');
            }),
            entry.recto.loadFile(name, rightText).then(() => {
                entry.recto.clearAllHighlights?.();
                this._barSide(entry.recto, delta.right, 'add');
                this._wirePagePick(set, entry, 'recto');
            }),
        ]).then(settle).catch(settle);
    }

    /** Paint one side's aligned lines: its changed lines as fill BARS (the glyph fill
     *  texel — the mechanism ANSI backgrounds ride), hunk headers as an additive tint. */
    _barSide(grid, lines, changeType) {
        const color = changeType === 'add' ? this.cfg.addColor : this.cfg.removeColor;
        for (let ln = 0; ln < lines.length; ln++) {
            const t = lines[ln].type;
            const cols = grid.getLineSlotCount?.(ln) ?? 0;
            if (!cols) continue;
            if (t === changeType) grid.highlightRange(ln, 0, ln, cols, color, this.cfg.fillOpacity);
            else if (t === 'hunk') grid.highlightRange(ln, 0, ln, cols, this.cfg.hunkColor, 0);
        }
    }

    /** A loaded page's bounds settled: re-fit its sheet, coalesce the re-flow. @private */
    _settle(set, sheetId) {
        const i = set.order.findIndex((p) => set.entries.get(p)?.sheetId === sheetId);
        if (i < 0) return;   // dropped while loading
        set.book.fitSheet(i);
        this._requestRelayout();
    }

    /** Turn the book to a freshly-changed file's sheet — only while it's FOLLOWING
     *  (head on the newest sheet). pageTo clears `following` for a non-last index,
     *  so restore it: following means "ride the fresh change", and it survives until
     *  the user pages away. @private */
    _followTo(set, path) {
        if (!set.book.following) return;
        const i = set.order.indexOf(path);
        if (i < 0) return;
        set.book.pageTo(i);
        set.book.following = true;
    }

    _requestRelayout() {
        if (this._relayoutScheduled) return;
        this._relayoutScheduled = true;
        setTimeout(() => { this._relayoutScheduled = false; this._relayout(); }, 0);
    }

    // -- private: identity + picking -----------------------------------------------------

    /** Register a loaded page grid: species 'grid', role 'delta-page', the set id in
     *  meta.deltaId (the wheel's paging address rides `delta:<id>`). @private */
    _wirePagePick(set, entry, side) {
        const grid = side === 'verso' ? entry.verso : entry.recto;
        const id = side === 'verso' ? entry.baseId : entry.headId;
        if (!grid || typeof grid.setPickingSystem !== 'function') return;
        try {
            this.ctx.registry?.register?.(id, grid, {
                type: 'grid', role: 'delta-page',
                deltaId: set.setId, path: entry.path, side: side === 'verso' ? 'base' : 'head',
            });
        } catch (e) { console.warn('[DeltaBooks] page pick register failed', e); }
    }

    /** The cover is the drag/paging handle: registry species 'book', role 'delta';
     *  the cover mesh rides the 'group' pick channel with the book as its token. @private */
    _registerGroup(set) {
        this.ctx.registry?.register?.(set.groupId, set.book, { type: 'book', role: 'delta', deltaId: set.setId });
        const ps = this.ctx.pickingSystem;
        if (!ps) return;
        try { if (set.book.cover) ps.register('group', set.book.cover.mesh, set.book); }
        catch (e) { console.warn('[DeltaBooks] group pick register failed', e); }
    }

    _coverOpts(colorHex) {
        const c = this.cfg;
        return {
            color: colorHex, opacity: c.coverOpacity, edgeOpacity: c.coverEdgeOpacity,
            pad: c.coverPad, zPad: c.coverZPad, renderOrder: RENDER_ORDER.BACKDROP_BASE,
        };
    }

    _updateCovers() {
        for (const set of this.sets.values()) {
            set.book.bindCover({
                ...this._coverOpts(this.cfg.palette[set.hueIdx % this.cfg.palette.length]),
                visible: !!this.cfg.cover,
            });
        }
    }

    /** Unregister + dispose ONE file sheet's page grids. @private */
    _disposeEntry(e) {
        for (const id of [e.baseId, e.headId]) { try { this.ctx.registry?.unregister?.(id); } catch (_e) { /* best effort */ } }
        for (const g of [e.verso, e.recto]) {
            if (!g) continue;
            try { this.ctx.pickingSystem?.unregister?.('grid', g._background); } catch (_e) { /* best effort */ }
            try { g.parent?.remove(g); g.dispose?.(); } catch (_e) { /* best effort */ }
        }
    }

    /** Unregister + dispose everything a set owns. @private */
    _kill(set) {
        for (const e of set.entries.values()) this._disposeEntry(e);
        try { this.ctx.registry?.unregister?.(set.groupId); } catch (_e) { /* best effort */ }
        try { if (set.book.cover) this.ctx.pickingSystem?.unregister?.('group', set.book.cover.mesh); } catch (_e) { /* best effort */ }
        try { set.book.dispose(); } catch (_e) { /* best effort */ }
        set.labelField = null;
        this.root.remove(set.book);
    }

    // -- private: cluster layout ---------------------------------------------------------

    _relayout() {
        const scheme = LAYOUT_SCHEMES[this.cfg.layout] || LAYOUT_SCHEMES.packed;
        scheme(this.root, this.cfg.layoutOpts);
        for (const set of this.sets.values()) {
            if (set.pinned && set.pinnedPos && set.book.parent === this.root) {
                set.book.position.copy(set.pinnedPos);
            }
        }
        this._restOnFloor();
        this._updateCovers();
        for (const cb of this._onRelayout) cb(this);
    }

    _restOnFloor() {
        const wb = this._worldBounds();
        if (!wb.isEmpty()) this.root.position.y += (this.cfg.floorY - wb.min.y);
        this.root.updateMatrixWorld(true);
    }

    _worldBounds(target = new THREE.Box3()) {
        target.makeEmpty();
        this.root.updateWorldMatrix(true, true);
        for (const set of this.sets.values()) {
            if (set.book.parent !== this.root) continue;   // borrowed (seated elsewhere)
            const b = set.book.getBounds();
            if (b && !b.isEmpty()) target.union(b);
        }
        return target;
    }

    /** The cluster's LOCAL content box — the WorldLayout measures the delta shelf as a
     *  bounds-leaf beside the tree and the agent shelf. Borrowed books skipped. */
    localBounds(target = new THREE.Box3()) {
        target.makeEmpty();
        const tmp = new THREE.Box3();
        for (const set of this.sets.values()) {
            if (set.book.parent !== this.root) continue;
            set.book.updateMatrix();
            tmp.copy(set.book.layoutBounds()).applyMatrix4(set.book.matrix);
            target.union(tmp);
        }
        return target;
    }

    /** Drop the cluster root in front of the camera once, so the first set builds in view. */
    _placeRootInView() {
        this._rootPlaced = true;
        const cam = this.ctx.camera;
        if (!cam) return;
        const fwd = cam.getWorldDirection(this._tmp).clone();
        const dist = Math.max(cam.position.length() * 0.5, 60);
        this.root.position.copy(cam.position).addScaledVector(fwd, dist);
    }
}

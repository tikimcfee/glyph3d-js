/**
 * SearchBook — a directory search, bound as a BOOK on the field.
 *
 * One matched FILE is one SHEET, a page-pair spread:
 *
 *   verso (left)  — the HIT LIST: the file's path over its matching lines,
 *                   each as `L<n>  <the line>`,
 *   recto (right) — the FILE ITSELF, with every hit lit in place.
 *
 * THE WINDOW IS THE PAGE. A search over a real tree matches hundreds of files, and a
 * sheet is a pair of GPU objects — materializing all of them is the thing that must not
 * happen. So the cache (SearchSession) holds every result, and this book materializes
 * exactly one BLOCK of `pageSize` sheets at a time. Flipping WITHIN a block is free
 * (Book's rolodex deck, no rebuild); flipping PAST it advances the block and rebuilds —
 * an explicit cost paid once per `pageSize` sheets, at the moment the operator asked to
 * see more. This is why the results are cached rather than rendered: paging is a view
 * operation over data that is already here.
 *
 * LIVE. While the walk streams, the trailing block GROWS: new files land as appended
 * sheets, and a file whose sheet is already built gets its new hits highlighted in
 * place. Watching a search fill in IS the feature — the block only rebuilds when its
 * identity changes, never merely because results arrived.
 *
 * DISPOSE-SAFE by construction: every scene object this book creates is tracked on the
 * entry that owns it, and teardown walks exactly that list — registry ids unregistered,
 * pick panels released, grids disposed. `clear()` returns the scene to the state before
 * the search; `dispose()` additionally drops the book, the root, and the session. State
 * this object set is state this object unsets — it never reaches for anything else's.
 */

import * as THREE from 'three';
import Book from './Book.js';
import CodeGrid from './CodeGrid.js';
import { VStack } from './layouts/StackContainer.js';
import { RENDER_ORDER } from '../core/renderOrder.js';
import SearchSession from '../services/data/SearchSession.js';

export const SEARCH_BOOK_DEFAULTS = {
    // -- paging ----------------------------------------------------------------------
    pageSize: 24,               // sheets materialized at once — the block. The whole point.
    // -- the page --------------------------------------------------------------------
    pageW: 320,
    pageH: 420,
    gutter: 24,
    maxUpscale: 3,
    face: true,
    faceColor: 0x0a0a1e,
    faceOpacity: 0.85,
    faceDepth: 6,
    // -- the deck --------------------------------------------------------------------
    zPitch: 90,
    pagerLerp: 9,
    // -- card build ------------------------------------------------------------------
    rowGap: 10,
    pathScale: 2.4,             // the file path headline on the verso
    hitScale: 1.4,              // the hit list under it
    contentWorldScale: 0.025,   // the file recto — fine print you fly into
    maxHitLines: 40,            // hit-list lines shown per verso (the sheet is a summary)
    // -- identity --------------------------------------------------------------------
    coverColor: 0x1d4ed8,
    coverOpacity: 0.5,
    coverEdgeOpacity: 0.9,
    coverPad: 18,
    coverZPad: 24,
    // -- the highlight ---------------------------------------------------------------
    hitColor: { r: 1.0, g: 0.85, b: 0.2 },
    hitFillOpacity: 0.35,       // a FILL bar: hits read as bands at fly-over distance
    floorY: 0,
};

/** `L12  const foo = bar()` — one hit as a roster line. Line numbers display 1-BASED
 *  (what an editor and `rg` both say); the cache holds them 0-based for the grid. */
const fmtHit = (m) => `L${m.line + 1}  ${m.text}`;

export default class SearchBook {
    /**
     * @param {Object} ctx - the scene context (scene, atlas, registry, pickingSystem, fileProvider, bridge)
     * @param {Object} [opts] - overrides for SEARCH_BOOK_DEFAULTS
     */
    constructor(ctx, opts = {}) {
        this.ctx = ctx;
        this.scene = ctx.scene;
        this.atlas = ctx.atlas;
        this.cfg = { ...SEARCH_BOOK_DEFAULTS, ...opts };

        this.root = new THREE.Group();
        this.root.name = 'search-book';
        this.scene.add(this.root);
        this._rootPlaced = false;
        this._tmp = new THREE.Vector3();

        /** The results cache + run lifecycle. The book is a VIEW of this. */
        this.session = new SearchSession({
            getProvider: () => this.ctx.fileProvider,
            getBridge: () => this.ctx.wsbridge,
            id: 'search',
        });
        this._unsubscribe = this.session.onChange(() => this._sync());

        this.book = null;
        /** @type {{path:string, group:Object, verso:Object, hits:Object|null, content:CodeGrid|null,
         *          pathId:string, hitsId:string|null, contentId:string|null,
         *          applied:number, loaded:boolean}[]} one per materialized sheet */
        this.entries = [];
        /** Which block of the cache is materialized: files[block*pageSize … +pageSize). */
        this.block = 0;
        /** Whether the book is in the scene at all. hide()/show() flip this. */
        this.visible = false;
        this._disposed = false;

        this.ctx.registry?.setPickable?.('card');
    }

    // -- the verb surface ------------------------------------------------------------

    /**
     * Run a search and show its book. Refining (calling again) drops the old results and
     * the old sheets — a new question, not an addition to the old answer.
     * @param {string} query
     * @param {Object} [opts] - passed to SearchSession.start (uri, regex, caseSensitive, …)
     * @returns {Promise<{started: boolean, runId: string}>}
     */
    async search(query, opts = {}) {
        if (this._disposed) throw new Error('SearchBook disposed');
        this._teardownSheets();
        this.block = 0;
        this.show();
        return this.session.start(query, opts);
    }

    /** Stop the walk, KEEP what it found. */
    async cancel() { return this.session.cancel(); }

    /**
     * Drop the search entirely: cancel the walk, free every sheet, empty the cache, hide
     * the book. The scene is left as it was before the search ran.
     */
    async clear() {
        await this.session.clear();
        this._teardownSheets();
        this.block = 0;
        this.hide();
    }

    /** Put the book in the scene (idempotent). Builds the block if results are waiting. */
    show() {
        if (this._disposed || this.visible) return;
        this.visible = true;
        if (!this.book) this._buildBook();
        this.root.add(this.book);
        if (!this._rootPlaced) this._placeRootInView();
        this._sync();
    }

    /**
     * Take the book out of the scene WITHOUT losing the search — the results and the
     * run keep going. Sheets are torn down (they are the expensive part); re-showing
     * rebuilds the block from the cache, which is exactly what the cache is for.
     */
    hide() {
        if (!this.visible) return;
        this.visible = false;
        this._teardownSheets();
        if (this.book) this.root.remove(this.book);
    }

    /** show() when hidden, hide() when shown. @returns {boolean} the new visibility */
    toggle() { if (this.visible) this.hide(); else this.show(); return this.visible; }

    // -- paging ------------------------------------------------------------------------

    /**
     * Turn to an ABSOLUTE result index (0-based over the whole cache, not the block).
     * Crossing a block boundary re-materializes — the paging cost, paid on demand.
     * @param {number} index
     * @returns {{index:number, block:number, head:number, count:number}}
     */
    pageTo(index) {
        const count = this.session.fileCount;
        if (count === 0) return this.headState();
        const abs = Math.max(0, Math.min(Math.floor(index) || 0, count - 1));
        const block = Math.floor(abs / this.cfg.pageSize);
        if (block !== this.block) {
            this.block = block;
            this._teardownSheets();
            this._sync();
        }
        this.book?.pageTo(abs - this.block * this.cfg.pageSize);
        return this.headState();
    }

    /** Turn by ±n results. The natural verb: `+1` past a block's end pulls the next block. */
    scroll(delta) { return this.pageTo(this.absHead() + (Number(delta) || 0)); }

    /** Jump whole blocks — `search.page next` at the block level. */
    blockScroll(delta) { return this.pageTo((this.block + (Number(delta) || 0)) * this.cfg.pageSize); }

    /** The head's ABSOLUTE index in the cache. */
    absHead() { return this.block * this.cfg.pageSize + (this.book?.head ?? 0); }

    /** Where we are, in both address spaces. */
    headState() {
        const count = this.session.fileCount;
        return {
            index: count ? Math.min(this.absHead(), count - 1) : 0,
            block: this.block,
            blocks: Math.max(1, Math.ceil(count / this.cfg.pageSize)),
            head: this.book?.head ?? 0,
            materialized: this.entries.length,
            count,
        };
    }

    /** Status for the HUD / CLI — the run AND the view. */
    status() {
        return {
            ...this.headState(),
            visible: this.visible,
            state: this.session.state,
            query: this.session.params?.query ?? null,
            uri: this.session.params?.uri ?? null,
            total: this.session.total,
            scanned: this.session.scanned,
            truncated: this.session.truncated,
            note: this.session.note,
            pageSize: this.cfg.pageSize,
        };
    }

    /** Per-frame: the deck's easing. Mirrors AgentBooks.update. */
    update(dt) { if (this.visible) this.book?.update(dt); }

    // -- materialization ----------------------------------------------------------------

    /**
     * Bring the materialized block in line with the cache. Called on every (coalesced)
     * cache change and after a block switch. APPEND-ONLY within a block: a sheet already
     * built is never rebuilt, only re-highlighted as its file gains hits — so a streaming
     * walk fills the open block in place instead of thrashing it. @private
     */
    _sync() {
        if (this._disposed || !this.visible || !this.book) return;
        const start = this.block * this.cfg.pageSize;
        const want = this.session.window(start, this.cfg.pageSize);

        // Files already on a sheet: light any hits that landed since we last looked.
        for (const entry of this.entries) this._applyNewHits(entry);

        // Files that arrived into this block: new sheets.
        for (let i = this.entries.length; i < want.length; i++) this._addSheet(want[i]);

        if (want.length !== this.entries.length || want.length) this._requestRelayout();
    }

    /** @private One file group → one sheet. */
    _addSheet(group) {
        const idx = this.entries.length;
        const sheetId = `search:${this.block}:${idx}`;
        const meta = { path: group.path, sheetId, kind: 'search' };

        // VERSO — path headline over the hit list.
        const shown = group.matches.slice(0, this.cfg.maxHitLines).map(fmtHit);
        if (group.matches.length > shown.length) shown.push(`… ${group.matches.length - shown.length} more`);
        const pathCard = this._card(group.path, `${group.matches.length} hits`,
            { gridScale: this.cfg.pathScale }, `${sheetId}:path`, meta);
        const hitsCard = this._card('hits', shown.join('\n'),
            { gridScale: this.cfg.hitScale, showFilename: false }, `${sheetId}:hits`, meta);
        const verso = new VStack({ spacing: this.cfg.rowGap, align: 0, children: [pathCard, hitsCard] });

        // RECTO — the file, lit. Loads async; the sheet re-fits when it settles.
        const content = new CodeGrid(this.scene, this.atlas, {
            name: `search:${group.path}`, showFilename: true, showBackground: true,
            worldScale: this.cfg.contentWorldScale,
        });

        const entry = {
            path: group.path, group, verso, hits: hitsCard, pathCard, content,
            pathId: `${sheetId}:path`, hitsId: `${sheetId}:hits`, contentId: `${sheetId}:content`,
            applied: 0, loaded: false, sheetId,
        };
        this.entries.push(entry);
        this.book.addSheet({ verso, recto: content });
        this._loadContent(entry, meta);
    }

    /**
     * Read the matched file and light its hits. The path is relative to the walk's base,
     * so it joins onto that base — a match path alone is ambiguous once the search ran
     * outside the served root. @private
     */
    _loadContent(entry, meta) {
        const base = this.session.base;
        const full = base ? `${base}/${entry.path}` : entry.path;
        Promise.resolve(this.ctx.fileProvider?.getFile?.(full))
            .then((content) => entry.content.loadFile(entry.path, String(content ?? '')))
            .catch(() => entry.content.loadFile(entry.path, '(could not load)'))
            .then(() => {
                // The block may have turned over while this read was in flight; a late
                // load must not touch a freed grid or resurrect a retired sheet.
                if (this._disposed || !this.entries.includes(entry)) return;
                entry.loaded = true;
                this._wireCardPick(entry.content, entry.contentId, meta);
                this._applyNewHits(entry);
                this._settle(entry);
            })
            .catch((e) => console.warn('[search] sheet content failed:', e?.message ?? e));
    }

    /**
     * Light the hits this entry hasn't lit yet. `applied` is the watermark — a streaming
     * file gains matches after its sheet exists, and re-lighting from zero every batch
     * would be quadratic over a heavily-matched file. @private
     */
    _applyNewHits(entry) {
        if (!entry.loaded || !entry.content) return;
        const matches = entry.group.matches;
        for (let i = entry.applied; i < matches.length; i++) {
            const m = matches[i];
            entry.content.highlightRange(m.line, m.col, m.line, m.col + m.length,
                this.cfg.hitColor, this.cfg.hitFillOpacity);
        }
        if (matches.length !== entry.applied) {
            entry.applied = matches.length;
            this._refreshHitList(entry);
        }
    }

    /** @private The verso's hit list, re-rendered as the file gains hits. */
    _refreshHitList(entry) {
        const matches = entry.group.matches;
        const shown = matches.slice(0, this.cfg.maxHitLines).map(fmtHit);
        if (matches.length > shown.length) shown.push(`… ${matches.length - shown.length} more`);
        entry.hits?.loadFile('hits', shown.join('\n'))
            .then(() => { if (this.entries.includes(entry)) this._settle(entry); })
            .catch(() => { /* the highlight already landed; the roster is the summary */ });
        entry.pathCard?.loadFile(entry.path, `${matches.length} hits`).catch(() => {});
    }

    /** @private A free CodeGrid card with content, registered pickable once loaded. */
    _card(filename, body, opts, id, meta) {
        const grid = new CodeGrid(this.scene, this.atlas, {
            name: `search:${filename}`, showFilename: true, showBackground: true, ...opts,
        });
        grid.loadFile(filename, body)
            .then(() => { this._wireCardPick(grid, id, meta); })
            .catch(() => { /* render best-effort */ });
        return grid;
    }

    /** @private A loaded card's bounds settled — re-lay its stack, re-fit its sheet, re-flow. */
    _settle(entry) {
        const i = this.entries.indexOf(entry);
        if (i < 0) return;
        if (entry.verso?.isStackContainer) entry.verso.layout();
        this.book.fitSheet(i);
        this._requestRelayout();
    }

    /** @private Coalesce relayouts — a block of 24 sheets resolves its loads in bursts. */
    _requestRelayout() {
        if (this._relayoutScheduled || this._disposed) return;
        this._relayoutScheduled = true;
        setTimeout(() => {
            this._relayoutScheduled = false;
            if (this._disposed || !this.visible) return;
            this._restOnFloor();
        }, 0);
    }

    /** @private See AgentBooks._wireCardPick — same contract, same must-run-after-load rule. */
    _wireCardPick(grid, id, meta) {
        if (!grid || typeof grid.setPickingSystem !== 'function') return;
        try { this.ctx.registry?.register?.(id, grid, { type: 'grid', role: 'card', ...meta }); }
        catch (e) { console.warn('[search] card pick register failed', e); }
    }

    // -- the book + teardown -------------------------------------------------------------

    /** @private */
    _buildBook() {
        const book = new Book();
        book.name = 'search:book';
        book.userData = { ...book.userData, name: 'search', isDir: false };
        book.deck.zPitch = this.cfg.zPitch;
        book.deck.lerp = this.cfg.pagerLerp;
        book.bindCover({
            color: this.cfg.coverColor, opacity: this.cfg.coverOpacity,
            edgeOpacity: this.cfg.coverEdgeOpacity, pad: this.cfg.coverPad,
            zPad: this.cfg.coverZPad, renderOrder: RENDER_ORDER.BACKDROP_BASE,
        });
        book.fit({
            pageW: this.cfg.pageW, pageH: this.cfg.pageH, gutter: this.cfg.gutter,
            maxUpscale: this.cfg.maxUpscale,
            surface: this.cfg.face, surfacePad: 0, surfaceDepth: this.cfg.faceDepth,
            surfaceColor: this.cfg.faceColor, surfaceOpacity: this.cfg.faceOpacity,
            surfaceBorder: true, surfaceBorderColor: this.cfg.coverColor,
            ownFace: true,
        });
        this.book = book;
        this.ctx.registry?.register?.('search:book', book, { type: 'book', role: 'search' });
        try { if (book.cover) this.ctx.pickingSystem?.register?.('group', book.cover.mesh, book); }
        catch (e) { console.warn('[search] group pick register failed', e); }
    }

    /**
     * Free every sheet this book built — registry ids, pick panels, GPU objects — and
     * empty the deck. The cache is untouched: this is the reversible half, and re-syncing
     * rebuilds the same block from it. @private
     */
    _teardownSheets() {
        for (const e of this.entries) this._disposeEntry(e);
        this.entries = [];
        if (this.book) { while (this.book.sheets.length) this.book.removeSheet(0); }
    }

    /** @private Unregister + dispose ONE sheet's grids. Best-effort per object: a failure
     *  freeing one must not strand the rest. */
    _disposeEntry(e) {
        for (const id of [e.pathId, e.hitsId, e.contentId]) {
            if (id) { try { this.ctx.registry?.unregister?.(id); } catch (_e) { /* best effort */ } }
        }
        for (const g of [e.pathCard, e.hits, e.content]) {
            if (!g) continue;
            try { this.ctx.pickingSystem?.unregister?.('grid', g._background); } catch (_e) { /* best effort */ }
            try { g.parent?.remove(g); g.dispose?.(); } catch (_e) { /* best effort */ }
        }
    }

    /**
     * Tear down for good. Everything this object created goes: sheets, the book, its
     * cover registration, the root group, the session (and with it the walk and the
     * bridge subscription). Idempotent.
     */
    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        try { this._unsubscribe?.(); } catch (_e) { /* best effort */ }
        this._unsubscribe = null;
        this._teardownSheets();
        if (this.book) {
            try { this.ctx.registry?.unregister?.('search:book'); } catch (_e) { /* best effort */ }
            try { if (this.book.cover) this.ctx.pickingSystem?.unregister?.('group', this.book.cover.mesh); } catch (_e) { /* best effort */ }
            try { this.book.dispose(); } catch (_e) { /* best effort */ }
            this.root.remove(this.book);
            this.book = null;
        }
        this.session.dispose();
        this.scene.remove(this.root);
        this.visible = false;
    }

    // -- placement -----------------------------------------------------------------------

    /** @private Rest the book's content bottom on the world floor. Idempotent. */
    _restOnFloor() {
        if (!this.book) return;
        this.root.updateWorldMatrix(true, true);
        const b = this.book.getBounds();
        if (b && !b.isEmpty()) this.root.position.y += (this.cfg.floorY - b.min.y);
        this.root.updateMatrixWorld(true);
    }

    /** @private Drop the root in front of the camera once, so the book builds in view. */
    _placeRootInView() {
        this._rootPlaced = true;
        const cam = this.ctx.camera;
        if (!cam) return;
        const fwd = cam.getWorldDirection(this._tmp).clone();
        const dist = Math.max(cam.position.length() * 0.5, 60);
        this.root.position.copy(cam.position).addScaledVector(fwd, dist);
    }
}

/**
 * AgentBooks — every agent's run, bound as a BOOK on the field. The one agent-viewing
 * system: the agent.* verb family sinks here, and each record an agent produces becomes
 * a SHEET in that agent's book — a page-pair spread:
 *
 *   verso (left)  — the DESCRIPTION: the action headline (`[verb]` + target/command)
 *                   over its terse numeric meta (lines read, +/−, tokens…),
 *   recto (right) — the CONTENT: the file's snapshot as-of the moment (touched lines
 *                   lit through the shared tool registry), a command's output, an
 *                   image, or the say/think prose.
 *
 * The book live-follows its newest sheet — work appends pages and the open spread rides
 * forward; page back to inspect history and the head holds (Book's rolodex deck: the
 * open sheet fronts at z = 0, the rest recede). Paging never moves the camera.
 *
 * PER-TURN SNAPSHOTS (not dedup): each action renders its OWN copy of the file's
 * content AS IT WAS at that moment — a re-read after an edit shows the new content, so
 * the book is a faithful changelog of state over time. Content is fetched at the moment
 * of the action (correct for live watching; faithful replay would capture content in
 * the record).
 *
 * The books are bounds-leaves laid out by the SAME schemes the file tree uses (a book
 * is opaque; its internal deck is untouched), the cluster rests on the world floor, and
 * the root registers as a world grouping beside the ContentTree — the agent stream is
 * a peer layout target to the file tree. A dragged book pins where you put it.
 *
 * The hook stream carries both TOOL CALLS and CONVERSATION — `text` blocks page in as
 * `say` sheets, `thinking` blocks as `think` sheets — so a book reads as a faithful
 * forward of the run: reasoning, speech, and action interleaved in time.
 *
 * Lifecycle rides the lane, not the scene: active → stalled after a quiet spell
 * (cfg.stallMs), done on agent.stop — and PERSISTS until agent.clear (small fast
 * helpers you never looked at stay on the shelf, viewable). agent.request raises a
 * beacon the panel surfaces. Nothing here ever moves the camera.
 */

import * as THREE from 'three';
import Book from './Book.js';
import CodeGrid from './CodeGrid.js';
import FrameGrid from './FrameGrid.js';
import { VStack } from './layouts/StackContainer.js';
import { LAYOUT_SCHEMES } from './layouts/index.js';
import { RENDER_ORDER } from '../core/renderOrder.js';
import { classifyByExtension } from '../core/fileKind.js';
import { decorateForAction, kindForAction, ACTION_HUES, cssHue, normalizeToolCall, normalizeMessage } from './toolRegistry.js';

export const AGENT_BOOKS_DEFAULTS = {
    // -- the page ------------------------------------------------------------------
    pageW: 320,                 // page width each side of a spread presents (world units)
    pageH: 420,                 // page height — portrait: these are books
    gutter: 24,                 // the spread's spine gap between verso and recto
    maxUpscale: 3,              // contain-fit may enlarge small cards up to this — caps the one-liner giant
    face: true,                 // render the page faces behind the content
    faceColor: 0x0a0a1e,        // page-face fill (the dark window wall)
    faceOpacity: 0.85,          // page-face opacity
    faceDepth: 6,               // how far behind the content each face sits
    // -- the deck (rolodex) --------------------------------------------------------
    zPitch: 90,                 // deck pitch between sheets (time depth) — fly-through room
    pagerLerp: 9,               // per-sheet z-slot easing rate (higher = snappier)
    // -- card build (pre-fit proportions inside a page) ------------------------------
    rowGap: 10,                 // verso VStack gap: action headline → its info rows
    callScale: 3.0,             // gridScale of the action headline (the readable HEADLINE)
    infoScale: 1.5,             // gridScale of the info card — readable, subordinate
    artifactWorldScale: 0.025,  // worldScale of file-snapshot / output cards (fine print you fly into)
    messageScale: 0.05,         // worldScale of say/think prose — its OWN knob (prose reads bigger)
    snapshotImageWidth: 40,     // world width of an image recto (height follows aspect)
    highlightFillOpacity: 0.22, // decorate FILL bar opacity (0 falls back to additive tint)
    // -- the cluster ---------------------------------------------------------------
    layout: 'packed',           // scheme placing the books (LAYOUT_SCHEMES: packed | walk | district | …)
    layoutOpts: { margin: 80 }, // per-scheme overrides — margin is the gap between book cells
    floorY: 0,                  // world floor the cluster's bottom rests on (the file tree's convention)
    // -- lifecycle -----------------------------------------------------------------
    stallMs: 12000,             // active → stalled after this quiet spell
    hydrateLimit: 200,          // newest events a session hydration materializes (sheets are GPU
                                // objects — a monster transcript opens as its tail, not en masse)
    // -- identity ------------------------------------------------------------------
    cover: true,                // translucent identity box around each book's deck (also the drag handle)
    coverPad: 16,               // XY inflation beyond the deck bounds
    coverZPad: 24,              // Z inflation (front of newest / behind oldest)
    coverOpacity: 0.06,         // translucent fill — identity tint, never occlusion
    coverEdgeOpacity: 0.22,     // wireframe frame line (0 = no edges)
    palette: [                  // per-agent identity hues, indexed by lane creation order
        0x3a6ea5, 0xa56a3a, 0x4a9a6a, 0x8a5aa5, 0xa54a5a, 0x5a8aa5,
    ],
    debug: false,               // ON → log the decoration decision per snapshot
    hues: { ...ACTION_HUES },   // live per-kind text hues, seeded from the tool registry's one table
};

const fmtNum = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K' : String(n));
const fmtBytes = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : b + ' B');

/** A terse summary of an action's structured meta (lines read/written, +/−, tokens…), one item
 *  per `sep` — ' · ' for a one-line subtitle, '\n' to stack as rows in the info card. */
function fmtMeta(meta, sep = ' · ') {
    if (!meta || typeof meta !== 'object') return '';
    const p = [];
    if (meta.lines != null) p.push(`${meta.lines} lines`);
    if (meta.added != null || meta.removed != null) p.push(`+${meta.added || 0} −${meta.removed || 0}`);
    if (meta.range) p.push(`L${meta.range[0]}–${meta.range[1]}`);                                          // a partial read's slice
    if (meta.ranges && meta.ranges.length) p.push('L' + meta.ranges.map(([s, e]) => (s === e ? `${s}` : `${s}–${e}`)).join(', '));   // an edit's touched runs
    if (meta.kind) p.push(String(meta.kind));
    if (meta.bytes != null) p.push(fmtBytes(meta.bytes));
    if (meta.tools != null) p.push(`${meta.tools} tools`);
    if (meta.tokens != null) p.push(`${fmtNum(meta.tokens)} tok`);
    if (meta.ms != null) p.push(`${(meta.ms / 1000).toFixed(1)}s`);
    if (meta.interrupted) p.push('interrupted');
    return p.join(sep);
}

/** The action headline's BODY: what the agent did and to what — target path and/or command. */
function fmtAction(rec) {
    return [rec.target, rec.detail].filter(Boolean).join('\n');
}

/** One record as a single glanceable roster line: `read  src/foo.js`, `bash  rg -n TODO → 3`. */
function fmtEntry(e) {
    const head = e.target ? `${e.action}  ${e.target}` : e.action;
    const mid = e.detail ? `  ${e.detail}` : '';
    const tail = e.result ? `   → ${String(e.result).split('\n')[0]}` : '';
    return `${head}${mid}${tail}`;
}

const STATES = new Set(['active', 'idle', 'stalled', 'done']);

export default class AgentBooks {
    constructor(ctx, opts = {}) {
        this.ctx = ctx;
        this.scene = ctx.scene;
        this.atlas = ctx.atlas;
        this.cfg = { ...AGENT_BOOKS_DEFAULTS, ...opts, hues: { ...AGENT_BOOKS_DEFAULTS.hues, ...(opts.hues || {}) } };

        // The layout target: a plain container whose children (books) a layout scheme places,
        // exactly as the file tree's root hosts its nodes. The scheme writes child.position.
        this.root = new THREE.Group();
        this.root.name = 'agent-books';
        this.scene.add(this.root);
        this._rootPlaced = false;

        /** agentId → lane: the book, its identity, its lifecycle, and its per-sheet card refs. */
        this.lanes = new Map();
        // Sheet cards register as pickable 'book.card' entries (hover-highlight via the 'grid'
        // pick channel; the cover rides the 'group' channel). Mark the type pickable BEFORE any
        // register() — SceneRegistry only adds an entry to the pickable set if its type is known.
        this.ctx.registry?.setPickable?.('book.card');
        this._listeners = new Set();   // change subscribers (the Agents panel)
        this._onRelayout = [];         // fired after each _relayout — the world layout re-spaces the cluster
        this._tmp = new THREE.Vector3();

    }

    // -- subscriptions ---------------------------------------------------------------

    /** Subscribe to roster/stream changes (spawn / record / state / beacon / clear). */
    onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
    _emitChange() { for (const fn of this._listeners) { try { fn(); } catch (_e) { /* listener owns its errors */ } } }

    /** Subscribe to relayouts (footprint changes). Returns an unsubscribe fn. */
    onRelayout(cb) {
        this._onRelayout.push(cb);
        return () => { const i = this._onRelayout.indexOf(cb); if (i >= 0) this._onRelayout.splice(i, 1); };
    }

    // -- the verb sink ---------------------------------------------------------------

    /** Spawn-on-first-sight: the lane (and its book) for an agent. */
    ensure(agentId, agentType) {
        let lane = this.lanes.get(agentId);
        if (!lane) {
            const book = new Book();
            book.name = `agent:${agentId}`;
            // A layout LEAF for the cluster scheme: name = ordering key, isDir = false.
            book.userData = { ...book.userData, name: agentId, isDir: false };
            book.deck.zPitch = this.cfg.zPitch;
            book.deck.lerp = this.cfg.pagerLerp;
            this.root.add(book);
            const hueIdx = this.lanes.size;
            book.bindCover(this._coverOpts(this.cfg.palette[hueIdx % this.cfg.palette.length]));
            lane = {
                book, hueIdx,
                agentType: agentType || 'agent',
                state: 'active', beacon: null, lastActivityTs: this._now(),
                seq: 0, entries: [],   // one entry per sheet: cards + ids + the record
                groupId: `agent:book:${agentId}`,
                sessionId: null,       // the harness session record this book renders (set by hydrate)
                pinned: false, pinnedPos: null,
            };
            book.fit(this._pageOpts(lane));   // page form from birth — appended sheets inherit it
            this.lanes.set(agentId, lane);
            this._registerGroup(agentId, lane);
            this._emitChange();
        } else if (agentType && lane.agentType !== agentType) {
            lane.agentType = agentType;
        }
        return lane;
    }

    /**
     * One activity record → a SHEET (description verso, content recto) paged into the
     * agent's book. The shared sink for agent.activity / agent.tool / agent.message.
     * @param {string} agentId
     * @param {string} agentType
     * @param {{action:string, target?:string, detail?:string, result?:string, meta?:Object}} record
     */
    activity(agentId, agentType, record) {
        if (!this._rootPlaced) this._placeRootInView();
        const lane = this.ensure(agentId, agentType);
        this._setState(lane, 'active');
        lane.beacon = null;   // it's acting → hand lowered
        lane.lastActivityTs = this._now();

        const hue = this.cfg.hues[kindForAction(record.action)] || this.cfg.hues.other;
        const seq = lane.seq++;
        const sheetId = `agent:${agentId}:${seq}`;
        const actionId = `${sheetId}:action`;
        const infoId = `${sheetId}:info`;
        const snapId = `${sheetId}:snap`;
        const meta = { agentId, seq, sheetId, record };
        const bookIndex = lane.book.sheets.length;   // where this sheet will land

        // VERSO — the description page: the action headline, with its numeric meta below.
        const action = this._card(`[${record.action || 'act'}]`, fmtAction(record),
            { gridScale: this.cfg.callScale, textColor: hue },
            { id: actionId, meta: { ...meta, kind: 'action' } }, lane, bookIndex);
        const infoText = fmtMeta(record.meta, '\n');
        let info = null;
        if (infoText) {
            info = this._card('info', infoText, { gridScale: this.cfg.infoScale, textColor: hue, showFilename: false },
                { id: infoId, meta: { ...meta, kind: 'info' } }, lane, bookIndex);
        }
        const verso = info ? new VStack({ spacing: this.cfg.rowGap, align: 0, children: [action, info] }) : action;

        // RECTO — the content page: the file as-of now / the output / the prose / the image.
        // One home each: the verso holds the action's INPUT; the result lives here. A file's
        // content IS its snapshot; a no-target action's output (bash/grep/say/think) rides the
        // record raw — EPHEMERAL, no path to re-read. Ships RAW; the fit frames it.
        let recto = null, hasSnapPick = false, snapScaleKey = null;
        if (record.target) {
            const kind = classifyByExtension(record.target);
            if (kind?.kind === 'image') {
                recto = this._imageSnapshot(record.target, kind.format, lane, bookIndex);
            } else {
                recto = this._makeGrid(record.target, { worldScale: this.cfg.artifactWorldScale });
                snapScaleKey = 'artifactWorldScale';
                this._loadSnapshot(recto, record, { id: snapId, meta: { ...meta, kind: 'snap' } }, lane, bookIndex);
                hasSnapPick = true;
            }
        } else if (record.result) {
            recto = this._outputSnapshot(record, { id: snapId, meta: { ...meta, kind: 'snap' } }, lane, bookIndex);
            snapScaleKey = (record.action === 'say' || record.action === 'think') ? 'messageScale' : 'artifactWorldScale';
            hasSnapPick = true;
        }

        lane.book.addSheet({ verso, recto });
        lane.entries.push({
            verso, action, info, snapshot: recto, snapScaleKey,
            actionId, infoId: info ? infoId : null, snapId: hasSnapPick ? snapId : null,
            record, ts: this._now(),
        });
        if (!this._batch) { this._relayout(); this._emitChange(); }
        return lane;
    }

    /**
     * Bulk-hydrate a lane from a session record's events (the sessionAdapter's output) —
     * restoration reads the harness's OWN record back through the same normalize path the
     * live hook takes, so a restored book and that session's still-live stream converge on
     * one lane. One layout pass for the whole read (the batch discipline): per-event
     * relayouts are suppressed while building and a single flow lands at the end.
     *
     * Only the newest `limit` events materialize (default cfg.hydrateLimit) — sheets are
     * GPU objects, and a monster transcript opens as its readable tail.
     * @param {string} agentId
     * @param {Array<{kind:string, name?:string, input?:Object, response?:Object, mtype?:string, text?:string}>} events
     * @param {{agentType?:string, sessionId?:string|null, cwd?:string, limit?:number}} [opts]
     * @returns {number} sheets added
     */
    hydrate(agentId, events, { agentType = 'claude', sessionId = null, cwd = '', limit } = {}) {
        const cap = Math.max(1, limit ?? this.cfg.hydrateLimit);
        const slice = events.length > cap ? events.slice(-cap) : events;
        const lane = this.ensure(agentId, agentType);
        if (sessionId) lane.sessionId = sessionId;
        this._batch = true;
        let added = 0;
        try {
            for (const ev of slice) {
                const rec = ev.kind === 'message'
                    ? normalizeMessage(ev.mtype, ev.text)
                    : normalizeToolCall(ev.name, ev.input, ev.response, ev.cwd ?? cwd);
                if (!rec) continue;   // noise tools / empty blocks drop, same as live
                this.activity(agentId, agentType, rec);
                added++;
            }
        } finally {
            this._batch = false;
        }
        // A hydrated book renders a RECORD, not a live process — it rests at 'idle'
        // (never stall-demoted) until a live hook event lands and marks it active.
        this._setState(lane, 'idle');
        this._relayout();
        this._emitChange();
        return added;
    }

    /** agent.state — set a lane's lifecycle by hand. */
    state(agentId, state) {
        const lane = this.lanes.get(agentId);
        if (!lane || !STATES.has(state)) return false;
        this._setState(lane, state);
        this._emitChange();
        return true;
    }

    /** agent.stop — the agent finished. 'done' PERSISTS until cleared: small fast helpers
     *  you never looked at stay on the shelf, viewable, instead of vanishing on a timer. */
    stop(agentId) {
        const lane = this.lanes.get(agentId);
        if (!lane) return false;
        this._setState(lane, 'done');
        this._emitChange();
        return true;
    }

    /** agent.request — the agent raises a hand for input/advice. The panel surfaces it. */
    request(agentId, msg) {
        const lane = this.lanes.get(agentId);
        if (!lane) return false;
        lane.beacon = msg || 'needs you';
        this._emitChange();
        return true;
    }

    /** Remove ONE agent's book (any state) — `agent.clear <id>` / the panel ✕. */
    remove(agentId) {
        const lane = this.lanes.get(agentId);
        if (!lane) return false;
        this._kill(lane);
        this.lanes.delete(agentId);
        this._relayout();
        this._emitChange();
        return true;
    }

    /** Bulk clear: 'all' books, or just the 'done' ones. Returns the count removed. */
    clear(which = 'all') {
        let n = 0;
        for (const [id, lane] of this.lanes) {
            if (which === 'done' && lane.state !== 'done') continue;
            this._kill(lane);
            this.lanes.delete(id);
            n++;
        }
        if (which === 'all' || !this.lanes.size) this._rootPlaced = false;   // next ingest re-places the cluster
        if (n) { this._relayout(); this._emitChange(); }
        return n;
    }

    // -- paging (the book.* verbs' engine) --------------------------------------------

    /** Resolve a lane by agent id OR registry group id (the pick/wheel path hands us the
     *  latter), or the first lane when omitted/unknown — [agentId, lane] or null. */
    _resolveLane(id) {
        if (id) {
            if (this.lanes.has(id)) return [id, this.lanes.get(id)];
            const byGroup = [...this.lanes.entries()].find(([, l]) => l.groupId === id);
            if (byGroup) return byGroup;
        }
        return this.lanes.entries().next().value || null;
    }

    /** Turn a book's head by `delta` sheets (− older / back in time, + newer). */
    scroll(agentId, delta) {
        const hit = this._resolveLane(agentId);
        return hit ? hit[1].book.scroll(delta) : false;
    }

    /** Open a book at sheet `index` (0 = oldest, clamped). Landing on the newest resumes live-follow. */
    pageTo(agentId, index) {
        const hit = this._resolveLane(agentId);
        return hit ? hit[1].book.pageTo(index) : false;
    }

    /** A book's head state (for panels/verbs), or null if it has no lane. */
    headState(agentId) {
        const hit = this._resolveLane(agentId);
        return hit ? { agentId: hit[0], ...hit[1].book.headState() } : null;
    }

    /**
     * Pin a book to a user position (drag-release / CLI). Once grabbed it's USER-PLACED —
     * `_relayout` flows the other books around it instead of re-snapping it to its slot.
     */
    moveGroup(id, x, y, z) {
        const lane = this.lanes.get(id) || [...this.lanes.values()].find((l) => l.groupId === id);
        if (!lane) return false;
        lane.pinned = true;
        lane.pinnedPos = new THREE.Vector3(x, y, z);
        lane.book.position.copy(lane.pinnedPos);
        return true;
    }

    // -- panel feeds -----------------------------------------------------------------

    /**
     * The lanes present, for the panel's roster — everything a row needs in one call:
     * id, type, lifecycle, beacon, identity color, sheet count, head + live-follow, and
     * the newest sheet's time. Ordered oldest lane first (creation order).
     */
    agents() {
        const pal = this.cfg.palette;
        return [...this.lanes.entries()].map(([id, l]) => ({
            id,
            type: l.agentType,
            state: l.state,
            beacon: l.beacon,
            sessionId: l.sessionId,
            count: l.book.sheets.length,
            hueIdx: l.hueIdx,
            color: '#' + ((pal[l.hueIdx % pal.length] >>> 0) & 0xffffff).toString(16).padStart(6, '0'),
            head: l.book.head,
            following: l.book.following,
            lastTs: l.entries.length ? l.entries[l.entries.length - 1].ts : l.lastActivityTs,
            recent: l.entries.slice(-3).map((e) => fmtEntry(e.record)),
        }));
    }

    /**
     * A book's sheet stream as terse rows (oldest first), for the panel's detail pane:
     * { index, action, kind, color, label, ts, focused } — enough to render a clickable
     * log without reaching into the scene graph. `focused` flags the open sheet.
     */
    getStream(agentId) {
        const lane = this.lanes.get(agentId);
        if (!lane) return [];
        const head = lane.book.head;
        return lane.entries.map((e, j) => {
            const kind = kindForAction(e.record?.action);
            return {
                index: j,
                action: e.record?.action || 'act',
                kind,
                color: cssHue(this.cfg.hues[kind] || this.cfg.hues.other),
                label: [e.record?.target, e.record?.detail].filter(Boolean).join(' · '),
                ts: e.ts,
                focused: j === head,
            };
        });
    }

    // -- per-frame -------------------------------------------------------------------

    /** Ease every book's deck toward its slots; detect stalls. */
    update(dt) {
        const now = this._now();
        let changed = false;
        for (const lane of this.lanes.values()) {
            if (lane.state === 'active' && now - lane.lastActivityTs > this.cfg.stallMs) {
                this._setState(lane, 'stalled');
                changed = true;
            }
            lane.book.update(dt);
        }
        if (changed) this._emitChange();
    }

    // -- scale / config --------------------------------------------------------------

    /**
     * Re-apply the current cfg SCALES to every live card — the one entry the config verb
     * and the Settings rows both route through. gridScale cards (headline + info) re-scale
     * via setScale; worldScale body cards bake their layout at build, so a uniform
     * transform re-sizes them (desired ÷ built). Then re-fit + re-flow so pages re-read.
     */
    applyScales() {
        for (const lane of this.lanes.values()) {
            lane.book.deck.zPitch = this.cfg.zPitch;
            lane.book.deck.lerp = this.cfg.pagerLerp;
            for (const e of lane.entries) {
                e.action?.setScale?.(this.cfg.callScale);
                e.info?.setScale?.(this.cfg.infoScale);
                if (e.snapScaleKey && typeof e.snapshot?.setScale === 'function') {
                    const built = e.snapshot.config?.worldScale;
                    const target = this.cfg[e.snapScaleKey];
                    if (built > 0 && target > 0) e.snapshot.setScale(target / built);
                }
            }
            lane.book.fit(this._pageOpts(lane));
        }
        this._relayout();
    }

    dispose() {
        this.clear('all');
        this.scene.remove(this.root);
    }

    // -- private: cards --------------------------------------------------------------

    _now() { return typeof performance !== 'undefined' ? performance.now() : 0; }

    /** The live Book.fit opts — page dims + the per-agent face identity. */
    _pageOpts(lane = null) {
        const c = this.cfg;
        const hex = lane ? c.palette[lane.hueIdx % c.palette.length] : c.faceColor;
        return {
            pageW: c.pageW, pageH: c.pageH, gutter: c.gutter, maxUpscale: c.maxUpscale,
            surface: c.face, surfacePad: 0, surfaceDepth: c.faceDepth,
            surfaceColor: c.faceColor, surfaceOpacity: c.faceOpacity,
            surfaceBorder: true, surfaceBorderColor: hex,
            ownFace: true,   // per-book material — each agent's rim wears its own hue
        };
    }

    /** A bare CodeGrid (no content yet) — the caller drives the single load. */
    _makeGrid(filename, opts) {
        return new CodeGrid(this.scene, this.atlas, { name: `agent:${filename}`, showFilename: true, showBackground: true, ...opts });
    }

    /** A free CodeGrid card with content; when its async bounds settle, re-fit the sheet it
     *  rides and re-flow (and, if `pick` given, register it as a pickable 'book.card'). */
    _card(filename, body, opts, pick, lane, bookIndex) {
        const grid = this._makeGrid(filename, opts);
        grid.loadFileAsync(filename, body)
            .then(() => { if (pick) this._wireCardPick(grid, pick.id, pick.meta); this._settle(lane, bookIndex); })
            .catch(() => { /* render best-effort */ });
        return grid;
    }

    /** A loaded card's bounds settled: re-lay its verso stack (a bare-card verso has no
     *  stack — and CodeGrid's own `layout` is grid windowing, never called here), re-fit
     *  its sheet, and request a re-flow. The flow is COALESCED per tick — a hydration
     *  resolves hundreds of card loads in bursts, and each one re-packing the world
     *  would be the minutes-not-milliseconds trap. @private */
    _settle(lane, bookIndex) {
        const entry = lane.entries[bookIndex];
        if (entry?.verso?.isStackContainer) entry.verso.layout();
        lane.book.fitSheet(bookIndex);
        this._requestRelayout();
    }

    /** Schedule one _relayout for this tick, however many settles ask. @private */
    _requestRelayout() {
        if (this._relayoutScheduled) return;
        this._relayoutScheduled = true;
        setTimeout(() => { this._relayoutScheduled = false; this._relayout(); }, 0);
    }

    /**
     * Register a LOADED card as a pickable 'book.card' registry entry. Its background panel
     * rides the 'grid' pick channel (FramedGlyphField.setPickingSystem, wired by
     * CanvasInteraction's registry-change sweep) → hover-highlight + click-to-focus.
     * MUST run after load: _background (the pick panel) is created lazily, so an earlier
     * register would let the sweep mark the grid wired before the panel exists. @private
     */
    _wireCardPick(grid, id, meta) {
        if (!grid || typeof grid.setPickingSystem !== 'function') return;
        try { this.ctx.registry?.register?.(id, grid, { type: 'book.card', ...meta }); }
        catch (e) { console.warn('[AgentBooks] card pick register failed', e); }
    }

    /** A no-target action's OUTPUT as the recto: command result / say-think prose. Ships RAW —
     *  the fit frames it; nothing is truncated here. */
    _outputSnapshot(record, pick, lane, bookIndex) {
        const isMessage = record.action === 'say' || record.action === 'think';
        const name = record.action === 'say' ? 'said' : record.action === 'think' ? 'thinking' : 'output';
        const worldScale = isMessage ? this.cfg.messageScale : this.cfg.artifactWorldScale;
        return this._card(name, String(record.result ?? ''), { worldScale }, pick, lane, bookIndex);
    }

    /** The recto for a file target: its content AS-OF this moment (loaded ONCE), touched
     *  lines lit up; registers as a pickable card after load. @private */
    _loadSnapshot(grid, record, pick, lane, bookIndex) {
        const path = record.target;
        const wire = () => { if (pick) this._wireCardPick(grid, pick.id, pick.meta); };
        Promise.resolve(this.ctx.fileProvider?.getFile?.(path))
            .then((content) => this._resolveSnapshotText(path, String(content ?? '')))
            .then((text) => grid.loadFileAsync(path, text))
            .then(() => { this._decorateSnapshot(grid, record); wire(); this._settle(lane, bookIndex); })
            .catch(() => grid.loadFileAsync(path, '(could not load)').then(() => { wire(); this._settle(lane, bookIndex); }).catch(() => {}));
    }

    /**
     * Guard against an EMPTY live read. getFile reads from DISK at the moment the sheet
     * builds, which races a concurrent agent writing the same file: a truncate→write
     * leaves a 0-byte window, so the read comes back '' — a SUCCESS, not an error. On an
     * empty read, prefer the file's OPEN grid content (what's on screen, immune to the
     * write window), then re-read once after a beat. A genuinely-empty file stays empty.
     * The faithful end-state is to carry the content the agent actually read IN THE
     * RECORD (see the header) — this keeps live watching honest until then.
     * @private @returns {Promise<string>}
     */
    _resolveSnapshotText(path, disk) {
        if (disk) return Promise.resolve(disk);
        const live = this._openGridContent(path);
        if (live) return Promise.resolve(live);
        return new Promise((r) => setTimeout(r, 120))
            .then(() => this.ctx.fileProvider?.getFile?.(path))
            .then((c) => String(c ?? ''))
            .catch(() => '');
    }

    /** The in-memory content of `path` if it's currently open as a grid, else null.
     *  Matches file.open's path→uri convention. @private */
    _openGridContent(path) {
        const uri = `file:///${String(path).replace(/^\/+/, '')}`;
        const open = this.ctx.registry?.findByMeta?.('sourcePath', uri) || [];
        const g = open[0]?.grid;
        return (g && typeof g.content === 'string' && g.content.length) ? g.content : null;
    }

    /**
     * Light up the lines an action touched on its loaded snapshot. Edits fill their added
     * lines green; a partial read fills its slice blue. A directive's `fill` flag becomes
     * a background-fill BAR at cfg.highlightFillOpacity; a non-fill directive falls back
     * to an additive glyph tint. Directives come from the shared tool registry
     * (decorateForAction); applied via highlightRange after the single load resolves.
     */
    _decorateSnapshot(grid, record) {
        const dbg = this.cfg.debug ? (msg) => console.log(`[agentbooks.decorate] ${record.action} ${record.target || ''} — ${msg}`) : null;
        const directives = decorateForAction(record.action, record.meta);
        if (!directives) {
            dbg?.(record.meta ? 'no directives (meta present, nothing to light up)' : 'no meta on record');
            return;
        }
        if (typeof grid.highlightRange !== 'function') { dbg?.('grid has no highlightRange — not a CodeGrid'); return; }
        const lastLine = (typeof grid.getLineCount === 'function' ? grid.getLineCount() : 0) - 1;
        let litLines = 0, litSlots = 0;
        for (const d of directives) {
            const start = Math.max(0, d.startLine);
            const end = Math.min(lastLine, d.endLine);
            for (let ln = start; ln <= end; ln++) {
                const cols = typeof grid.getLineSlotCount === 'function' ? grid.getLineSlotCount(ln) : 0;
                const fillOpacity = d.fill ? this.cfg.highlightFillOpacity : 0;   // FILL bar vs additive tint
                if (cols > 0) { grid.highlightRange(ln, 0, ln, cols, d.color, fillOpacity); litLines++; litSlots += cols; }
            }
        }
        dbg?.(`${directives.length} directive(s) → lit ${litLines} line(s) / ${litSlots} slot(s) (lastLine=${lastLine})`);
    }

    /**
     * An IMAGE recto: a single-cell FrameGrid sampling the file's pixels AS-OF now — an
     * empty quad placed immediately (so the sheet fits), filled async once the bytes
     * decode. Shares FrameGrid.textureFromImageBytes + provider.getBytes with file.open's
     * image path. Image cards are unpickable for now: they're placed without a pick arg,
     * so no registry entry is made (FrameGrid does inherit setPickingSystem — a follow-on).
     */
    _imageSnapshot(path, format, lane, bookIndex) {
        const grid = new FrameGrid(this.scene, this.atlas, { name: `agent:${path}`, cols: 1, rows: 1, width: this.cfg.snapshotImageWidth });
        Promise.resolve(this.ctx.fileProvider?.getBytes?.(path))
            .then((bytes) => bytes && FrameGrid.textureFromImageBytes(bytes, format))
            .then((res) => {
                if (res) {
                    grid.setFrameTexture(res.texture);
                    if (res.width > 0 && res.height > 0) grid.setAspect(res.width / res.height);
                }
                this._settle(lane, bookIndex);
            })
            .catch(() => this._settle(lane, bookIndex));
        return grid;
    }

    // -- private: identity + interaction ----------------------------------------------

    /**
     * Make a book a draggable GROUP. The cover box is the pick HANDLE: registered on the
     * 'group' channel with the BOOK as its token, and the book is a registry entry of
     * type 'book.group'. A hover-pick of the cover resolves (getIdByGrid) to this entry →
     * ObjectDragger Ctrl-drags entry.grid (the book) — the whole deck follows. Release
     * routes through book.move (ephemeral — no workspace persistence). Cards out-pick
     * the cover (cross-channel priority), so it only catches the empty interior.
     */
    _registerGroup(agentId, lane) {
        this.ctx.registry?.register?.(lane.groupId, lane.book, { type: 'book.group' });
        const ps = this.ctx.pickingSystem;
        if (!ps) return;
        Promise.resolve(ps._tslReady).then(() => {
            try { if (lane.book.cover) ps.register('group', lane.book.cover.mesh, lane.book); }
            catch (e) { console.warn('[AgentBooks] group pick register failed', e); }
        });
    }

    /** The cfg-derived cover styling for a lane's book — Book owns the cover itself
     *  (build/sync/teardown ride Book.bindCover/update); this wrapper owns identity
     *  (the palette hue) and the shelf-wide dials. @private */
    _coverOpts(colorHex) {
        const c = this.cfg;
        return {
            color: colorHex, opacity: c.coverOpacity, edgeOpacity: c.coverEdgeOpacity,
            pad: c.coverPad, zPad: c.coverZPad, renderOrder: RENDER_ORDER.BACKDROP_BASE,
        };
    }

    /** Re-style every book's cover from the live cfg (the config verb tunes live);
     *  cfg.cover false hides them (Book.update re-wraps whatever stays bound). */
    _updateCovers() {
        for (const lane of this.lanes.values()) {
            if (!this.cfg.cover) {
                if (lane.book.cover) lane.book.cover.mesh.visible = false;
            } else {
                lane.book.bindCover(this._coverOpts(this.cfg.palette[lane.hueIdx % this.cfg.palette.length]));
            }
        }
    }

    /** Unregister + dispose everything a lane owns (cards, cover, book). @private */
    _kill(lane) {
        for (const e of lane.entries) {
            for (const id of [e.actionId, e.infoId, e.snapId]) { if (id) { try { this.ctx.registry?.unregister?.(id); } catch (_e) { /* best effort */ } } }
            for (const g of [e.action, e.info, e.snapshot]) {
                if (!g) continue;
                try { this.ctx.pickingSystem?.unregister?.('grid', g._background); } catch (_e) { /* best effort */ }
                try { g.parent?.remove(g); g.dispose?.(); } catch (_e) { /* best effort */ }
            }
        }
        try { this.ctx.registry?.unregister?.(lane.groupId); } catch (_e) { /* best effort */ }
        try { if (lane.book.cover) this.ctx.pickingSystem?.unregister?.('group', lane.book.cover.mesh); } catch (_e) { /* best effort */ }
        try { lane.book.dispose(); } catch (_e) { /* best effort */ }   // drops the cover with the sheets
        this.root.remove(lane.book);
    }

    _setState(lane, state) { if (lane.state !== state) lane.state = state; }

    // -- private: cluster layout -------------------------------------------------------

    /**
     * Re-lay the cluster (idempotent): pack the books as bounds-leaves via the chosen
     * scheme — the same machinery the file tree uses — re-assert pinned books, rest the
     * cluster on the world floor, size the covers, and notify the world layout.
     */
    _relayout() {
        const scheme = LAYOUT_SCHEMES[this.cfg.layout] || LAYOUT_SCHEMES.packed;
        scheme(this.root, this.cfg.layoutOpts);
        for (const lane of this.lanes.values()) {
            if (lane.pinned && lane.pinnedPos) lane.book.position.copy(lane.pinnedPos);
        }
        this._restOnFloor();
        this._updateCovers();
        for (const cb of this._onRelayout) cb(this);
    }

    /** Shift the cluster so its content bottom sits on the world floor (cfg.floorY). Idempotent. */
    _restOnFloor() {
        const wb = this._worldBounds();
        if (!wb.isEmpty()) this.root.position.y += (this.cfg.floorY - wb.min.y);
        this.root.updateMatrixWorld(true);
    }

    /** World-space AABB of the whole cluster — the union of every book's world box. @private */
    _worldBounds(target = new THREE.Box3()) {
        target.makeEmpty();
        this.root.updateWorldMatrix(true, true);
        for (const lane of this.lanes.values()) {
            const b = lane.book.getBounds();
            if (b && !b.isEmpty()) target.union(b);
        }
        return target;
    }

    /** The cluster's LOCAL content box (root frame) — so the WorldLayout can measure the
     *  agent shelf as a bounds-leaf beside the file tree. */
    localBounds(target = new THREE.Box3()) {
        target.makeEmpty();
        const tmp = new THREE.Box3();
        for (const lane of this.lanes.values()) {
            lane.book.updateMatrix();
            tmp.copy(lane.book.layoutBounds()).applyMatrix4(lane.book.matrix);
            target.union(tmp);
        }
        return target;
    }

    /** Drop the cluster root in front of the camera once, so the books build in view. */
    _placeRootInView() {
        this._rootPlaced = true;
        const cam = this.ctx.camera;
        if (!cam) return;
        const fwd = cam.getWorldDirection(this._tmp).clone();
        const dist = Math.max(cam.position.length() * 0.5, 60);
        this.root.position.copy(cam.position).addScaledVector(fwd, dist);
    }
}

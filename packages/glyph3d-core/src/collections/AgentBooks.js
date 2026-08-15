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
 * helpers you never looked at stay on the shelf, viewable). Nothing here ever moves
 * the camera.
 *
 * THE RAISED HAND (lane.waiting) is the one "this agent needs you" state, and it is
 * DERIVED, not announced: agentWaiting.js reads it off the same records the sheets
 * render — a blocking question in flight (`ask`), or a turn that ended on the agent's
 * prose (`say`) — with `agent.request` as the by-hand third source. Any new activity
 * lowers it (the agent is working again), and `waiting()` is the feed the 2D panels
 * project. A hydration deliberately raises NOTHING: opening an archived session is
 * reading a record, not being asked a question.
 */

import * as THREE from 'three';
import Book from './Book.js';
import CodeGrid from './CodeGrid.js';
import FrameGrid from './FrameGrid.js';
import FieldLabel from './FieldLabel.js';
import { VStack } from './layouts/StackContainer.js';
import { LAYOUT_SCHEMES } from './layouts/index.js';
import { RENDER_ORDER } from '../core/renderOrder.js';
import { classifyByExtension } from '../core/fileKind.js';
import { decorateForAction, kindForAction, ACTION_HUES, cssHue, normalizeToolCall, normalizeMessage } from './toolRegistry.js';
import { WAIT_REQUEST, waitFromRecord, waitFromTurnEnd } from './agentWaiting.js';
import { eventsToRecords } from '../workers/sessionParseJob.js';
import { yieldToFrame } from '../utils/frameYield.js';

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
    maxSheets: 20,              // newest turns a book keeps IN SPACE (sheets are GPU objects) —
                                // live growth sheds its oldest past this, a session hydration
                                // materializes only this tail; 0 = unbounded. Per-book override:
                                // book.limit / agent.open's limit arg (lane.maxSheets).
    tailReadBytes: 512 * 1024,  // first transcript tail window a hydration requests (bytes);
                                // doubles until the window holds maxSheets events (tail-grow —
                                // a transcript costs its readable tail, not its full history)
    headMetaBytes: 64 * 1024,   // head window re-harvesting the provenance a tail can't see
                                // (ai-title/agent-name/turn.prompt sit near the file's start);
                                // read only when the tail's meta lacks a title. 0 disables.
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
        // Sheet cards register as pickable role-'card' entries (hover-highlight via the 'grid'
        // pick channel; the cover rides the 'group' channel). Mark the type pickable BEFORE any
        // register() — SceneRegistry only adds an entry to the pickable set if its type is known.
        this.ctx.registry?.setPickable?.('card');
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
                agentId,
                agentType: agentType || 'agent',
                state: 'active',
                waiting: null,         // the raised hand: { reason, message, ts } — see agentWaiting.js
                lastActivityTs: this._now(),
                seq: 0, entries: [],   // one entry per sheet: cards + ids + the record
                groupId: `agent:book:${agentId}`,
                sessionId: null,       // the harness session record this book renders (set by hydrate)
                meta: null,            // session provenance (title/slug/cwd/model/gitBranch…) — hydrate/setLaneMeta
                cwd: null,             // the session's working dir (meta.cwd), kept beside sessionId
                label: null,           // the nameplate (FieldLabel) above the cover, in the lane's hue
                maxSheets: null,       // per-book retention override: n>0 caps, 0 unbounded, null → cfg.maxSheets
                pinned: false, pinnedPos: null,
            };
            book.fit(this._pageOpts(lane));   // page form from birth — appended sheets inherit it
            // The nameplate: a FieldLabel (glyph-field text over an identity-hue plate) in the
            // lane's palette hue, parked above the cover (Book.syncCover owns the per-frame
            // placement). Born as '~<id> · <type>'; rebuilt to full provenance as metadata
            // lands (hydrate / setLaneMeta). A field, not a baked texture — so a long session
            // title instances glyphs instead of breaching the GPU max-texture limit.
            lane.label = new FieldLabel({
                atlas: this.atlas,
                text: `~${agentId} · ${lane.agentType}`,
                lineHeight: (this.cfg.pageH * 0.05) / 3,   // per-row; full 3-line provenance ≈ the old plate height
                plate: {
                    color: this.cfg.palette[hueIdx % this.cfg.palette.length],
                    opacity: 0.85,
                },
            });
            lane.label.name = `agent-label:${agentId}`;
            book.setNameplate(lane.label);
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
        lane.waiting = null;   // it's acting → hand lowered
        lane.lastActivityTs = this._now();

        const hue = this.cfg.hues[kindForAction(record.action)] || this.cfg.hues.other;
        const seq = lane.seq++;
        const sheetId = `agent:${agentId}:${seq}`;
        const actionId = `${sheetId}:action`;
        const infoId = `${sheetId}:info`;
        const snapId = `${sheetId}:snap`;
        const meta = { agentId, seq, sheetId, record };

        // VERSO — the description page: the action headline, with its numeric meta below.
        const action = this._card(`[${record.action || 'act'}]`, fmtAction(record),
            { gridScale: this.cfg.callScale, textColor: hue },
            { id: actionId, meta: { ...meta, kind: 'action' } }, lane, sheetId);
        const infoText = fmtMeta(record.meta, '\n');
        let info = null;
        if (infoText) {
            info = this._card('info', infoText, { gridScale: this.cfg.infoScale, textColor: hue, showFilename: false },
                { id: infoId, meta: { ...meta, kind: 'info' } }, lane, sheetId);
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
                recto = this._imageSnapshot(record.target, kind.format, lane, sheetId);
            } else {
                recto = this._makeGrid(record.target, { worldScale: this.cfg.artifactWorldScale });
                snapScaleKey = 'artifactWorldScale';
                this._loadSnapshot(recto, record, { id: snapId, meta: { ...meta, kind: 'snap' } }, lane, sheetId);
                hasSnapPick = true;
            }
        } else if (record.result) {
            recto = this._outputSnapshot(record, { id: snapId, meta: { ...meta, kind: 'snap' } }, lane, sheetId);
            snapScaleKey = (record.action === 'say' || record.action === 'think') ? 'messageScale' : 'artifactWorldScale';
            hasSnapPick = true;
        }

        lane.book.addSheet({ verso, recto });
        lane.entries.push({
            sheetId, verso, action, info, snapshot: recto, snapScaleKey,
            actionId, infoId: info ? infoId : null, snapId: hasSnapPick ? snapId : null,
            record, ts: this._now(),
        });
        this._trimLane(lane);   // past the cap, the oldest turn leaves as the newest lands
        // A record can BE the wait: an `ask` that carries no answer yet (a question
        // parsed from a live tail, a replay). The live hook doesn't reach here for that
        // case — its pre-tool event raises the hand before the call blocks — so this is
        // the record-side reading of the same state.
        const w = waitFromRecord(record);
        if (w) this._raiseWait(lane, w.reason, w.message);
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
     * Only the newest turns materialize — the lane's retention cap (its override, else
     * cfg.maxSheets) bounds hydration exactly as it bounds live growth: sheets are GPU
     * objects, and a monster transcript opens as its readable tail. An explicit `limit`
     * BECOMES the book's override (n>0 caps it, 0 unbounded — the whole record), so a
     * deliberate deep open stays deep as the live stream continues.
     *
     * ASYNC, frame-sliced: the event loop runs in budgeted slices (budgetMs per slice),
     * yielding a frame between them — a deep history no longer lands as one long task that
     * starves every await queued behind it (the restore lanes run CONCURRENTLY, so one
     * lane's block inflates the others' wall times). The batch flag stays HELD across the
     * yields: no mid-build relayout, no half-built book visible — and a live hook event
     * landing mid-hydrate just batches into the same closing relayout.
     * @param {string} agentId
     * @param {Array} events - raw adapter events ({kind:'tool'|'message', …}) OR
     *        pre-normalized records ({action, target, …}) — the codec normalizes in the
     *        worker, so what arrives here is usually records already; either way
     *        eventsToRecords interprets each entry in exactly one place
     * @param {{agentType?:string, sessionId?:string|null, cwd?:string, meta?:Object|null, limit?:number, budgetMs?:number}} [opts]
     * @returns {Promise<number>} sheets added
     */
    async hydrate(agentId, events, { agentType = 'claude', sessionId = null, cwd = '', meta = null, limit, budgetMs = 8 } = {}) {
        const lane = this.ensure(agentId, agentType);
        if (sessionId) lane.sessionId = sessionId;
        if (meta) {
            lane.meta = { ...(lane.meta || {}), ...meta };
            if (meta.cwd) lane.cwd = meta.cwd;
            lane.label?.setText(this.provenanceText(lane));
        }
        const v = Number(limit);
        if (limit != null && Number.isFinite(v)) lane.maxSheets = Math.max(0, Math.floor(v));
        const cap = this._capFor(lane);
        const slice = events.length > cap ? events.slice(-cap) : events;
        const records = eventsToRecords(slice, cwd);   // records pass through; noise drops
        this._batch = true;
        let added = 0;
        let slice0 = performance.now();
        try {
            for (const rec of records) {
                this.activity(agentId, agentType, rec);
                added++;
                if (performance.now() - slice0 > budgetMs) {
                    await yieldToFrame();
                    slice0 = performance.now();
                }
            }
        } finally {
            this._batch = false;
        }
        // A hydrated book renders a RECORD, not a live process — it rests at 'idle'
        // (never stall-demoted) until a live hook event lands and marks it active, and
        // it raises NO hand: a transcript's last question was asked (and usually
        // answered) long ago, and restoring a session must not open a wall of panels.
        // A still-running session's next live event raises the hand honestly.
        this._setState(lane, 'idle');
        lane.waiting = null;
        this._relayout();
        this._emitChange();
        return added;
    }

    /**
     * agent.meta / agent.kimi-wire: merge session metadata onto a lane and rebake its
     * nameplate to the new provenance. Live lanes learn their title/cwd/model this way
     * (archived ones get it through hydrate's opts.meta). Unknown lane → false.
     * @param {string} id lane id
     * @param {Object} meta partial metadata — merged over what the lane already holds
     * @returns {boolean}
     */
    setLaneMeta(id, meta) {
        const lane = this.lanes.get(id);
        if (!lane || !meta || typeof meta !== 'object') return false;
        lane.meta = { ...(lane.meta || {}), ...meta };
        if (lane.meta.cwd) lane.cwd = lane.meta.cwd;
        lane.label?.setText(this.provenanceText(lane));
        this._emitChange();
        return true;
    }

    /**
     * The nameplate's provenance text for a lane — up to three lines, each omitted
     * when its data is absent:
     *   1. the session name — meta.title ?? meta.slug ?? '~<id>'
     *   2. basename(meta.cwd) · agentType
     *   3. meta.model (· meta.gitBranch)
     */
    provenanceText(lane) {
        const meta = lane.meta || {};
        const lines = [meta.title ?? meta.slug ?? `~${lane.agentId}`];
        const base = meta.cwd ? String(meta.cwd).split('/').filter(Boolean).pop() : null;
        const line2 = [base, lane.agentType].filter(Boolean).join(' · ');
        if (line2) lines.push(line2);
        const line3 = [meta.model, meta.gitBranch].filter(Boolean).join(' · ');
        if (line3) lines.push(line3);
        return lines.join('\n');
    }

    /** agent.state — set a lane's lifecycle by hand. */
    state(agentId, state) {
        const lane = this.lanes.get(agentId);
        if (!lane || !STATES.has(state)) return false;
        this._setState(lane, state);
        this._emitChange();
        return true;
    }

    /**
     * agent.stop — the TURN ended (the harness Stop hook fires at every one; 'done'
     * PERSISTS until cleared, so small fast helpers you never looked at stay on the
     * shelf, viewable, instead of vanishing on a timer). A turn that ended on the
     * agent's PROSE ended on YOU: the records it just paged in say so, and the hand
     * goes up carrying those exact words.
     */
    stop(agentId) {
        const lane = this.lanes.get(agentId);
        if (!lane) return false;
        this._setState(lane, 'done');
        const w = waitFromTurnEnd(lane.entries.map((e) => e.record));
        if (w) this._raiseWait(lane, w.reason, w.message);
        this._emitChange();
        return true;
    }

    /** agent.request — a hand raised BY HAND (the verb), reason 'request'. */
    request(agentId, msg) {
        return this.raiseWait(agentId, WAIT_REQUEST, msg || 'needs you');
    }

    /**
     * Raise the hand on a lane: it is waiting on YOU. The derived sources (a blocking
     * question in flight, a turn that ended on prose) and the by-hand verb all land here.
     * @param {string} agentId
     * @param {string} reason 'ask' | 'say' | 'request' (agentWaiting.js's WAIT_*)
     * @param {string} message the agent's own words — whole, never truncated here
     * @returns {boolean} false = no such lane
     */
    raiseWait(agentId, reason, message) {
        const lane = this.lanes.get(agentId);
        if (!lane) return false;
        this._raiseWait(lane, reason, message);
        this._emitChange();
        return true;
    }

    /** agent.answered — lower the hand (you replied, or dismissed the panel). New
     *  activity lowers it on its own; this is the "seen it" path. */
    lowerWait(agentId) {
        const lane = this.lanes.get(agentId);
        if (!lane || !lane.waiting) return false;
        lane.waiting = null;
        this._emitChange();
        return true;
    }

    /**
     * Every lane waiting on you, longest-waiting first — the feed the 2D wait panel
     * projects and `agent.waiting` prints: identity, why, the words, when the hand went
     * up, and how deep the book is.
     * @returns {Array<{id:string, type:string, color:string, reason:string, message:string, ts:number, sheets:number}>}
     */
    waiting() {
        const pal = this.cfg.palette;
        const out = [];
        for (const [id, l] of this.lanes) {
            if (!l.waiting) continue;
            out.push({
                id,
                type: l.agentType,
                color: '#' + ((pal[l.hueIdx % pal.length] >>> 0) & 0xffffff).toString(16).padStart(6, '0'),
                reason: l.waiting.reason,
                message: l.waiting.message,
                ts: l.waiting.ts,
                sheets: l.book.sheets.length,
            });
        }
        return out.sort((a, b) => a.ts - b.ts);
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

    /**
     * THE lane resolver — every address a lane answers to, resolved by LOOKUP and
     * FIELD CHECK, never by prefix surgery (the `agent:`/`agent:book:` collision
     * silently ate the wheel's group ids — a sliced string was trusted as an id):
     *   - omitted / falsy       → the first lane (the "default book" the verbs page)
     *   - the live Book OBJECT  → field identity (a pick / a registry entry's .grid)
     *   - the lane id           → lanes map, exact
     *   - the registry group id → groupId FIELD compare
     *   - the display label     → book.list prints `agent:<id>`; accepted back only
     *                             when the remainder LOOKS UP to a real lane — an
     *                             alias is a hint to try, never a transform to trust
     * An UNKNOWN ref is null — a verb naming a book that doesn't exist must say so,
     * not quietly turn the first one (bus honesty).
     * @param {string|Object|null|undefined} ref
     * @returns {[string, Object]|null} [agentId, lane] or null
     */
    resolveLane(ref) {
        if (ref == null || ref === '') return this.lanes.entries().next().value || null;
        if (typeof ref === 'object') {
            for (const e of this.lanes.entries()) if (e[1].book === ref) return e;
            return null;
        }
        const id = String(ref);
        if (this.lanes.has(id)) return [id, this.lanes.get(id)];
        for (const e of this.lanes.entries()) if (e[1].groupId === id) return e;
        if (id.startsWith('agent:')) {
            const rest = id.slice(6);
            if (this.lanes.has(rest)) return [rest, this.lanes.get(rest)];
        }
        return null;
    }

    /** Turn a book's head by `delta` sheets (− older / back in time, + newer). */
    scroll(agentId, delta) {
        const hit = this.resolveLane(agentId);
        return hit ? hit[1].book.scroll(delta) : false;
    }

    /** Open a book at sheet `index` (0 = oldest, clamped). Landing on the newest resumes live-follow. */
    pageTo(agentId, index) {
        const hit = this.resolveLane(agentId);
        return hit ? hit[1].book.pageTo(index) : false;
    }

    /** A book's head state (for panels/verbs), or null if it has no lane. */
    headState(agentId) {
        const hit = this.resolveLane(agentId);
        return hit ? { agentId: hit[0], ...hit[1].book.headState() } : null;
    }

    /**
     * Pin a book to a user position (drag-release / CLI). Once grabbed it's USER-PLACED —
     * `_relayout` flows the other books around it instead of re-snapping it to its slot.
     */
    moveGroup(id, x, y, z) {
        // No default-to-first here: a move must NAME its book (unlike paging, where
        // the head verb sensibly falls to the default lane).
        const lane = id != null ? this.resolveLane(id)?.[1] : null;
        if (!lane) return false;
        lane.pinned = true;
        lane.pinnedPos = new THREE.Vector3(x, y, z);
        lane.book.position.copy(lane.pinnedPos);
        return true;
    }

    // -- panel feeds -----------------------------------------------------------------

    /**
     * The lanes present, for the panel's roster — everything a row needs in one call:
     * id, type, lifecycle, the raised hand, identity color, sheet count, retention (effective
     * cap + whether it's an override), head + live-follow, and the newest sheet's time.
     * Ordered oldest lane first (creation order).
     */
    agents() {
        const pal = this.cfg.palette;
        return [...this.lanes.entries()].map(([id, l]) => {
            const cap = this._capFor(l);
            return {
                id,
                type: l.agentType,
                state: l.state,
                waiting: l.waiting,                        // { reason, message, ts } | null
                sessionId: l.sessionId,
                meta: l.meta || null,
                count: l.book.sheets.length,
                limit: l.maxSheets,                        // retention override (null → shelf default)
                cap: Number.isFinite(cap) ? cap : 0,       // effective kept-turns cap (0 = unbounded)
                hueIdx: l.hueIdx,
                color: '#' + ((pal[l.hueIdx % pal.length] >>> 0) & 0xffffff).toString(16).padStart(6, '0'),
                head: l.book.head,
                following: l.book.following,
                lastTs: l.entries.length ? l.entries[l.entries.length - 1].ts : l.lastActivityTs,
                recent: l.entries.slice(-3).map((e) => fmtEntry(e.record)),
            };
        });
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
     * Cap ONE book's kept turns — the book.limit verb's engine (a hydration's explicit
     * limit sets the same field). n > 0 caps this lane, 0 makes it unbounded, null/NaN
     * clears the override back to the shelf default (cfg.maxSheets). Over-cap sheets
     * shed immediately, oldest first.
     * @param {string} [agentId] agent id / registry group id / first lane when omitted
     * @param {number|null} n
     * @returns {{agentId:string, override:number|null, cap:number, count:number, evicted:number}|null}
     */
    setLimit(agentId, n) {
        const hit = this.resolveLane(agentId);
        if (!hit) return null;
        const [id, lane] = hit;
        const v = Number(n);
        lane.maxSheets = (n == null || !Number.isFinite(v)) ? null : Math.max(0, Math.floor(v));
        const evicted = this._trimLane(lane);
        if (evicted) this._relayout();
        this._emitChange();
        return { ...this.limitOf(id), evicted };
    }

    /** A book's retention state: its override (null = shelf default), the effective cap
     *  (0 = unbounded), and the sheets on hand. */
    limitOf(agentId) {
        const hit = this.resolveLane(agentId);
        if (!hit) return null;
        const [id, lane] = hit;
        const cap = this._capFor(lane);
        return { agentId: id, override: lane.maxSheets, cap: Number.isFinite(cap) ? cap : 0, count: lane.book.sheets.length };
    }

    /**
     * Re-apply the current cfg SCALES to every live card — the one entry the config verb
     * and the Settings rows both route through. gridScale cards (headline + info) re-scale
     * via setScale; worldScale body cards bake their layout at build, so a uniform
     * transform re-sizes them (desired ÷ built). Then re-fit + re-flow so pages re-read.
     * A tightened cfg.maxSheets lands here too — each lane sheds to its cap first.
     */
    applyScales() {
        for (const lane of this.lanes.values()) {
            this._trimLane(lane);
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
     *  rides and re-flow (and, if `pick` given, register it as a pickable role-'card'). */
    _card(filename, body, opts, pick, lane, sheetId) {
        const grid = this._makeGrid(filename, opts);
        grid.loadFile(filename, body)
            .then(() => { if (pick) this._wireCardPick(grid, pick.id, pick.meta); this._settle(lane, sheetId); })
            .catch(() => { /* render best-effort */ });
        return grid;
    }

    /** A loaded card's bounds settled: re-lay its verso stack (a bare-card verso has no
     *  stack — and CodeGrid's own `layout` is grid windowing, never called here), re-fit
     *  its sheet, and request a re-flow. The sheet resolves by ID, not position — the
     *  retention cap evicts oldest sheets, so positions shift under a pending load (an
     *  evicted sheet's late settle is a no-op). The flow is COALESCED per tick — a
     *  hydration resolves hundreds of card loads in bursts, and each one re-packing the
     *  world would be the minutes-not-milliseconds trap. @private */
    _settle(lane, sheetId) {
        const i = lane.entries.findIndex((e) => e.sheetId === sheetId);
        if (i < 0) return;   // shed while its content loaded
        const entry = lane.entries[i];
        if (entry.verso?.isStackContainer) entry.verso.layout();
        lane.book.fitSheet(i);
        this._requestRelayout();
    }

    // -- private: retention ------------------------------------------------------------

    /** The lane's effective sheet cap — its override, else the shelf default; 0 (either
     *  level) means unbounded. @private */
    _capFor(lane) {
        const n = lane.maxSheets ?? this.cfg.maxSheets;
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : Infinity;
    }

    /**
     * The cap a hydration of this lane WOULD apply — hydrate's rule (an explicit
     * limit wins, else the lane's override, else the shelf default) without
     * mutating anything. The parse pool pre-slices the event tail in the worker
     * to this count, so only what the book will materialize clones back to the
     * main thread. hydrate re-derives + re-slices identically — the slice here
     * is transport hygiene, not semantics.
     * @param {string} agentId @param {number} [limit] @returns {number} cap (Infinity = unbounded)
     */
    capForHydration(agentId, limit) {
        const lane = this.lanes.get(agentId);
        const n = limit ?? lane?.maxSheets ?? this.cfg.maxSheets;
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : Infinity;
    }

    /** Shed a lane's oldest sheets past its cap. Entries and deck stay parallel arrays;
     *  each evicted sheet's cards fully release (registry, picking, GPU) and the deck
     *  closes up behind them. @private @returns {number} sheets shed */
    _trimLane(lane) {
        const cap = this._capFor(lane);
        let n = 0;
        while (lane.entries.length > cap) {
            const e = lane.entries.shift();
            lane.book.removeSheet(0);
            this._disposeEntry(e);
            n++;
        }
        return n;
    }

    /** Schedule one _relayout for this tick, however many settles ask. @private */
    _requestRelayout() {
        if (this._relayoutScheduled) return;
        this._relayoutScheduled = true;
        setTimeout(() => { this._relayoutScheduled = false; this._relayout(); }, 0);
    }

    /**
     * Register a LOADED card as a pickable role-'card' registry entry. Its background panel
     * rides the 'grid' pick channel (FramedGlyphField.setPickingSystem, wired by
     * CanvasInteraction's registry-change sweep) → hover-highlight + click-to-focus.
     * MUST run after load: _background (the pick panel) is created lazily, so an earlier
     * register would let the sweep mark the grid wired before the panel exists. @private
     */
    _wireCardPick(grid, id, meta) {
        if (!grid || typeof grid.setPickingSystem !== 'function') return;
        // Species 'grid' (it IS a text grid — findable/readable as one),
        // role 'card' (carried by a book — pick/cull/index key on the role).
        try { this.ctx.registry?.register?.(id, grid, { type: 'grid', role: 'card', ...meta }); }
        catch (e) { console.warn('[AgentBooks] card pick register failed', e); }
    }

    /** A no-target action's OUTPUT as the recto: command result / say-think prose. Ships RAW —
     *  the fit frames it; nothing is truncated here. */
    _outputSnapshot(record, pick, lane, sheetId) {
        const isMessage = record.action === 'say' || record.action === 'think';
        const name = record.action === 'say' ? 'said' : record.action === 'think' ? 'thinking' : 'output';
        const worldScale = isMessage ? this.cfg.messageScale : this.cfg.artifactWorldScale;
        return this._card(name, String(record.result ?? ''), { worldScale }, pick, lane, sheetId);
    }

    /** The recto for a file target: its content AS-OF this moment (loaded ONCE), touched
     *  lines lit up; registers as a pickable card after load. @private */
    _loadSnapshot(grid, record, pick, lane, sheetId) {
        const path = record.target;
        const wire = () => { if (pick) this._wireCardPick(grid, pick.id, pick.meta); };
        Promise.resolve(this.ctx.fileProvider?.getFile?.(path))
            .then((content) => this._resolveSnapshotText(path, String(content ?? '')))
            .then((text) => grid.loadFile(path, text))
            .then(() => { this._decorateSnapshot(grid, record); wire(); this._settle(lane, sheetId); })
            .catch(() => grid.loadFile(path, '(could not load)').then(() => { wire(); this._settle(lane, sheetId); }).catch(() => {}));
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
    _imageSnapshot(path, format, lane, sheetId) {
        const grid = new FrameGrid(this.scene, this.atlas, { name: `agent:${path}`, cols: 1, rows: 1, width: this.cfg.snapshotImageWidth });
        Promise.resolve(this.ctx.fileProvider?.getBytes?.(path))
            .then((bytes) => bytes && FrameGrid.textureFromImageBytes(bytes, format))
            .then((res) => {
                if (res) {
                    grid.setFrameTexture(res.texture);
                    if (res.width > 0 && res.height > 0) grid.setAspect(res.width / res.height);
                }
                this._settle(lane, sheetId);
            })
            .catch(() => this._settle(lane, sheetId));
        return grid;
    }

    // -- private: identity + interaction ----------------------------------------------

    /**
     * Make a book a draggable GROUP. The cover box is the pick HANDLE: registered on the
     * 'group' channel with the BOOK as its token, and the book is a registry entry of
     * species 'book', role 'agent'. A hover-pick of the cover resolves (getIdByGrid) to this entry →
     * ObjectDragger Ctrl-drags entry.grid (the book) — the whole deck follows. Release
     * routes through book.move (ephemeral — no workspace persistence). Cards out-pick
     * the cover (cross-channel priority), so it only catches the empty interior.
     */
    _registerGroup(agentId, lane) {
        this.ctx.registry?.register?.(lane.groupId, lane.book, { type: 'book', role: 'agent' });
        const ps = this.ctx.pickingSystem;
        if (!ps) return;
        try { if (lane.book.cover) ps.register('group', lane.book.cover.mesh, lane.book); }
        catch (e) { console.warn('[AgentBooks] group pick register failed', e); }
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
     *  cfg.cover false hides them (the visible opt — syncCover honors it every frame). */
    _updateCovers() {
        for (const lane of this.lanes.values()) {
            lane.book.bindCover({
                ...this._coverOpts(this.cfg.palette[lane.hueIdx % this.cfg.palette.length]),
                visible: !!this.cfg.cover,
            });
        }
    }

    /** Unregister + dispose ONE sheet's cards (registry ids, pick panels, GPU) —
     *  the shared teardown for an evicted sheet and a killed lane. @private */
    _disposeEntry(e) {
        for (const id of [e.actionId, e.infoId, e.snapId]) { if (id) { try { this.ctx.registry?.unregister?.(id); } catch (_e) { /* best effort */ } } }
        for (const g of [e.action, e.info, e.snapshot]) {
            if (!g) continue;
            try { this.ctx.pickingSystem?.unregister?.('grid', g._background); } catch (_e) { /* best effort */ }
            try { g.parent?.remove(g); g.dispose?.(); } catch (_e) { /* best effort */ }
        }
    }

    /** Unregister + dispose everything a lane owns (cards, cover, nameplate, book). @private */
    _kill(lane) {
        for (const e of lane.entries) this._disposeEntry(e);
        try { this.ctx.registry?.unregister?.(lane.groupId); } catch (_e) { /* best effort */ }
        try { if (lane.book.cover) this.ctx.pickingSystem?.unregister?.('group', lane.book.cover.mesh); } catch (_e) { /* best effort */ }
        try { lane.book.dispose(); } catch (_e) { /* best effort */ }   // drops the cover + nameplate with the sheets
        lane.label = null;
        this.root.remove(lane.book);
    }

    _setState(lane, state) { if (lane.state !== state) lane.state = state; }

    /** Stamp the raised hand on a lane. The TIMESTAMP is the hand's, not the turn's —
     *  the wait panel orders by who has been waiting longest, and a re-raise with the
     *  same words keeps its place in that queue rather than jumping the line. @private */
    _raiseWait(lane, reason, message) {
        const text = String(message ?? '').trim();
        if (!text) return;
        if (lane.waiting && lane.waiting.reason === reason && lane.waiting.message === text) return;
        lane.waiting = { reason, message: text, ts: this._now() };
    }

    // -- private: cluster layout -------------------------------------------------------

    /**
     * Re-lay the cluster (idempotent): pack the books as bounds-leaves via the chosen
     * scheme — the same machinery the file tree uses — re-assert pinned books, rest the
     * cluster on the world floor, size the covers, and notify the world layout.
     *
     * A book RIDDEN ELSEWHERE (seated at a carrel — its parent is not the root) is
     * BORROWED, the Carrel's own word for it: the cluster keeps its lane but takes its
     * hands off the transform — no pin re-assert (pinnedPos is cluster-local; writing
     * it into another frame teleports the book), and no say in the floor rest.
     */
    _relayout() {
        const scheme = LAYOUT_SCHEMES[this.cfg.layout] || LAYOUT_SCHEMES.packed;
        scheme(this.root, this.cfg.layoutOpts);
        for (const lane of this.lanes.values()) {
            if (lane.pinned && lane.pinnedPos && lane.book.parent === this.root) {
                lane.book.position.copy(lane.pinnedPos);
            }
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

    /** World-space AABB of the RESIDENT cluster — the union of every root-held book's
     *  world box. Borrowed books (seated at a carrel) are the desk's extent, not the
     *  cluster's — counting them dragged the floor rest toward wherever the desk
     *  stands. @private */
    _worldBounds(target = new THREE.Box3()) {
        target.makeEmpty();
        this.root.updateWorldMatrix(true, true);
        for (const lane of this.lanes.values()) {
            if (lane.book.parent !== this.root) continue;
            const b = lane.book.getBounds();
            if (b && !b.isEmpty()) target.union(b);
        }
        return target;
    }

    /** The cluster's LOCAL content box (root frame) — so the WorldLayout can measure the
     *  agent shelf as a bounds-leaf beside the file tree. Borrowed books are skipped:
     *  their matrices are another frame's, and the world must not space groupings
     *  around a phantom extent (the default shelf seats EVERY book — the cluster is
     *  usually empty now). */
    localBounds(target = new THREE.Box3()) {
        target.makeEmpty();
        const tmp = new THREE.Box3();
        for (const lane of this.lanes.values()) {
            if (lane.book.parent !== this.root) continue;
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

/**
 * AgentBooks — every agent's run, bound as a BOOK on the field. The one agent-viewing
 * system: the agent.* verb family sinks here, and each record an agent produces becomes
 * a SHEET in that agent's book — a page-pair spread:
 *
 *   verso (left)  — the DESCRIPTION, an ActionPage composed at WORLD size: the action
 *                   headline (`[verb]` over the call's first line — the path, the
 *                   command, the pattern, a say/think's opening line) at a fixed line
 *                   height, WRAPPED to the page rather than shrunk by long content; the
 *                   call's remaining lines (a multi-line command) below it at a smaller
 *                   size; then its terse numeric meta (lines read, +/−, tokens…),
 *   recto (right) — the CONTENT: the file's snapshot as-of the moment (touched lines
 *                   lit through the shared tool registry) FRAMED to the touched range
 *                   with some context (snapshotWindow), a command's output, an image, or
 *                   the say/think prose. Content fits its page and so reads smaller than
 *                   the headline — at a distance the action call is what reads first.
 *
 * Each book wears an AgentNameplate above its cover: the session's NAME container-fit
 * to the book's width, over a live STATUS block (state · step · age, the current
 * action, where it runs). readout() is the one source for that status — the nameplate,
 * the Agents panel rows, and the canvas hover readout all read it. An external
 * orchestrator's fields ride lane.meta.gomux ({name, parent, backend, status, detail,
 * tool, session}); when present its name/status/detail win.
 *
 * The book live-follows its newest sheet — work appends pages and the open spread rides
 * forward; page back to inspect history and the head holds (Book's deck: the open sheet
 * fronts at z = 0, older ones recede, the newer ones paged past lie pressed at the back).
 * Paging never moves the camera. A tab per sheet across the top edge is the TIMELINE:
 * the sheet's number in the whole run, hued by action kind, the open one raised.
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
 * gomuxai's EVENT STREAM (agentEvents.js; applyEvents) is one sheet per EVENT, 1:1 and
 * never grouped: every message INTO the agent is a `prompt` sheet as first-class as a
 * file read — tagged by whose words it is (`[you]`, `[you · queued]`, `[delivered]`,
 * `[notification]`, `[peer]`, `[command]`, `[harness]`), its words set in the prompt hue
 * — beside `think` (a redacted block says so), `say` (a final reply marked), tool and
 * `system` sheets; a call the tool table calls noise is a sheet too, set in a dim hue. Each sheet carries its event's TURN (the prompt it belongs to: id +
 * index; the HUD reads the open sheet's) so a later layer may group by it. An event
 * that changes (a tool's result landing, a provisional reply confirmed) arrives again
 * under its id and its sheet is rebuilt IN PLACE: same index, same number, the deck and
 * the head unmoved.
 *
 * Lifecycle rides the lane, not the scene: active → stalled after a quiet spell
 * (cfg.stallMs), done on agent.stop — and PERSISTS until agent.clear (small fast
 * helpers you never looked at stay on the shelf, viewable). agent.request raises a
 * beacon the panel surfaces. Nothing here ever moves the camera.
 */

import * as THREE from 'three';
import Book, { PAGE_FACE_DEFAULTS, DECK_DEFAULTS } from './Book.js';
/** @import { BookHost } from './Book.js' */
import CodeGrid from './CodeGrid.js';
import FrameGrid from './FrameGrid.js';
import ActionPage, { fitTextBlock } from './ActionPage.js';
import AgentNameplate from './AgentNameplate.js';
import { LAYOUT_SCHEMES } from './layouts/index.js';
import { RENDER_ORDER } from '../core/renderOrder.js';
import { computeCellMetrics } from '../core/cellMetrics.js';
import { classifyByExtension } from '../core/fileKind.js';
import { toFileUri } from '../core/fileUri.js';
import { decorateForAction, kindForAction, ACTION_HUES, cssHue } from './toolRegistry.js';
import { eventsToRecords } from '../workers/sessionParseJob.js';
import { eventRecord, eventFacts, eventLane, sessionLane, sessionMeta } from './agentEvents.js';
/** @import { EventChange } from './agentEvents.js' */
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
    faceDepth: PAGE_FACE_DEFAULTS.surfaceDepth, // how far behind the content each face sits
    // -- the deck --------------------------------------------------------------------
    zPitch: 90,                 // deck pitch between sheets (time depth) — fly-through room
    pagerLerp: 9,               // per-sheet z-slot easing rate (higher = snappier)
    turnedPitch: DECK_DEFAULTS.turned, // the turned block's pitch, × zPitch (pressed pages)
    turnSlide: DECK_DEFAULTS.slide,    // how far a turn visibly slides the deck (pitches; the rest cuts)
    // -- the description page (verso): WORLD sizes, never shrunk by long content ---------
    pageMargin: 16,             // inset of the verso's cards from the page edge
    rowGap: 10,                 // verso gap between headline → call body → info rows
    callLineHeight: 18,         // world row pitch of the action headline (`[verb]` + the call's first line)
    callMinLineHeight: 8,       // floor the headline steps down to when its wrapped call overflows callMaxFrac
    callMaxFrac: 0.45,          // share of the page height the headline may take before stepping down
    callTextLift: 0.55,         // headline call text: action hue lifted toward white (0 = hue, 1 = white); the [verb] tag stays hue
    bodyLineHeight: 9,          // world row pitch of the call's remaining lines (a multi-line command)
    bodyMinLineHeight: 2,       // floor for the call body when it overflows the page (past it, the page shrinks)
    infoLineHeight: 9,          // world row pitch of the info rows (lines, +/−, range, tokens…)
    // -- the content page (recto) -------------------------------------------------------
    snapContextRows: 8,         // file snapshot: rows of context above/below the touched range
    snapMaxRows: 60,            // file snapshot: window height in rows (a longer file is framed, 0 = whole file)
    // -- the timeline tabs (one per sheet: its number in the run, hued by action kind) ----------
    tabs: true,                 // bind the per-sheet tabs across each book's top edge
    tabLine: 0.018,             // tab text row height, × pageH
    artifactWorldScale: 0.025,  // worldScale of file-snapshot / output cards (fine print you fly into)
    messageScale: 0.05,         // worldScale of prose (prompt/say/think/system) — its OWN knob (prose reads bigger)
    proseWrapCols: 72,          // prose (prompt/say/think/system) word-wraps to this many columns (a page-shaped column, not a 200-wide strip; 0 = the fold's default)
    promptTextLift: 0.6,        // a prompt's words: the prompt hue lifted toward white (0 = hue, 1 = white) — whose words they are reads at a glance
    showNoise: true,            // tool calls the tool table calls noise (ToolSearch, TodoWrite…): true gives each its sheet, set quietly (1:1 events); false hides them (new events)
    noiseTextLift: 0.15,        // a noise sheet's headline + output: the dim noise hue lifted this far toward white (0 = hue) — kept low so it reads as background
    snapshotImageWidth: 40,     // world width of an image recto (height follows aspect)
    highlightFillOpacity: 0.22, // decorate FILL bar opacity (0 falls back to additive tint)
    // -- the cluster ---------------------------------------------------------------
    layout: 'packed',           // scheme placing the books (LAYOUT_SCHEMES: packed | walk | district | …)
    layoutOpts: { margin: 80 }, // per-scheme overrides — margin is the gap between book cells
    floorY: 0,                  // world floor the cluster's bottom rests on (the file tree's convention)
    // -- lifecycle -----------------------------------------------------------------
    stallMs: 12000,             // active → stalled after this quiet spell
    maxSheets: 20,              // newest sheets a book keeps IN SPACE (sheets are GPU objects) —
                                // live growth sheds its oldest past this, a session hydration
                                // materializes only this tail; 0 = unbounded. Per-book override:
                                // book.limit / agent.open's limit arg (lane.maxSheets).
    tailReadBytes: 512 * 1024,  // first transcript tail window a hydration requests (bytes);
                                // doubles until the window holds maxSheets events (tail-grow —
                                // a transcript costs its readable tail, not its full history)
    // -- history (paging back past the resident sheets) --------------------------------
    historyLead: 3,             // paging to within this many sheets of the window's oldest one prefetches older records
    historyTurns: 20,           // records one older read brings into the buffer
    historySliceBytes: 256 * 1024, // first byte span read for an older slice (doubles until it holds historyTurns)
    historyOverlapBytes: 256 * 1024, // bytes read PAST the cursor so a slice's last tool calls pair with their results
    historyBuffer: 400,         // parsed records a book keeps BESIDE its window (older + newer) — no GPU cost; past it the far ones drop (re-readable)
    headMetaBytes: 64 * 1024,   // head window re-harvesting the provenance a tail can't see
                                // (ai-title/agent-name/turn.prompt sit near the file's start);
                                // read only when the tail's meta lacks a title. 0 disables.
    // -- identity ------------------------------------------------------------------
    cover: true,                // translucent identity box around each book's deck (also the drag handle)
    coverPad: 16,               // XY inflation beyond the deck bounds
    coverZPad: 24,              // Z inflation (front of newest / behind oldest)
    coverOpacity: 0.06,         // translucent fill — identity tint, never occlusion
    coverEdgeOpacity: 0.22,     // wireframe frame line (0 = no edges)
    labelFit: 0.9,              // nameplate: share of the book's spread width the name may span
    labelMinLineHeight: 14,     // nameplate name: smallest world row pitch (a longer name wraps)
    labelMaxLineHeight: 40,     // nameplate name: largest world row pitch (a short name stops growing)
    labelStatusRatio: 0.5,      // nameplate status block row pitch, × the name's
    labelTickMs: 1000,          // how often the nameplates' ages re-read (text that didn't change is a no-op)
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

/**
 * The action CALL a record makes, split for the headline: `head` is the line the headline
 * shows (the target path; else the command/pattern/question's first non-empty line; for a
 * target-less say/think, the prose's first non-empty line), `rest` is everything else of
 * the call (a target action's detail, a multi-line command's remaining lines) — nothing
 * dropped: rest rides the verso's body, and a say/think's full prose is its recto.
 * @param {{action?:string, target?:string, detail?:string, result?:string}} rec
 * @returns {{verb:string, head:string, rest:string}}
 */
export function actionCall(rec) {
    const verb = rec?.tag || rec?.action || 'act';
    const splitFirst = (s) => {
        const lines = String(s).split('\n');
        const i = lines.findIndex((l) => l.trim());
        if (i < 0) return { head: '', rest: '' };
        return { head: lines[i], rest: lines.slice(i + 1).join('\n').replace(/^\n+|\s+$/g, '') };
    };
    if (rec?.target) return { verb, head: rec.target, rest: String(rec.detail || '') };
    if (rec?.detail) return { verb, ...splitFirst(rec.detail) };
    if (PROSE_ACTIONS.has(rec?.action)) return { verb, head: splitFirst(rec?.result || '').head, rest: '' };
    return { verb, head: '', rest: '' };
}

/** The actions whose content IS prose — a message in (prompt), the agent's speech and
 *  reasoning (say/think), the harness speaking (system): set at message scale, wrapped to a
 *  page column, and named by their verb alone on the nameplate. */
const PROSE_ACTIONS = new Set(['prompt', 'say', 'think', 'system']);

/** A sheet's info rows: the tool table's numeric meta, then the event's own facts (its
 *  turn, a call's status, a final reply…). */
const infoOf = (record) => [fmtMeta(record.meta, '\n'), ...eventFacts(record)].filter(Boolean).join('\n');

/**
 * Where a file snapshot's window sits: the touched runs (meta.range — a partial read's
 * slice; meta.ranges — an edit's added runs; 1-based inclusive) with `context` rows either
 * side, at most `maxRows` tall (anchored on the first run when the touched span is taller),
 * slid inside the file. null = show the whole file (it fits, or windowing is off). A
 * whole-file action (no range) frames the file's top. Pure.
 * @param {Object|null} meta @param {number} total the file's line count
 * @param {{context:number, maxRows:number}} o
 * @returns {{first:number, last:number}|null} 0-based inclusive line window
 */
export function snapshotWindow(meta, total, { context, maxRows }) {
    const max = Math.floor(maxRows);
    if (!(max > 0) || total <= max) return null;
    const runs = meta?.range ? [meta.range] : (Array.isArray(meta?.ranges) ? meta.ranges : []);
    const ctx = Math.max(0, Math.floor(context) || 0);
    let first, last;
    if (!runs.length) { first = 0; last = max - 1; }
    else {
        const lo = Math.min(...runs.map((r) => r[0])) - 1;
        const hi = Math.max(...runs.map((r) => r[1])) - 1;
        first = lo - ctx;
        last = hi + ctx;
        if (last - first + 1 > max) last = first + max - 1;
    }
    if (first < 0) { last -= first; first = 0; }
    if (last > total - 1) { first -= last - (total - 1); last = total - 1; }
    return { first: Math.max(0, first), last };
}

/** Word-wrap `text` to `cols` codepoints per row, breaking inside a word only when the
 *  word alone is wider; the whitespace a row breaks at becomes the break. Wraps, never
 *  cuts — every word's every codepoint stays. Pure. */
export function wrapText(text, cols) {
    const c = Math.max(1, Math.floor(cols));
    const out = [];
    const flush = (row) => out.push(row.join('').trimEnd());
    for (const line of String(text ?? '').split('\n')) {
        let row = [];
        for (const tok of line.split(/(\s+)/)) {
            if (!tok) continue;
            let t = [...tok];
            if (row.length + t.length <= c) { row.push(...t); continue; }
            if (!/\S/.test(tok)) { flush(row); row = []; continue; }
            if (row.length) { flush(row); row = []; }
            while (t.length > c) { out.push(t.slice(0, c).join('')); t = t.slice(c); }
            row = t;
        }
        flush(row);
    }
    return out.join('\n');
}

/** A wall-clock age, terse: now / 12s / 4m / 3h / 2d. */
export function fmtAge(ms) {
    if (!(ms >= 0)) return '';
    const s = Math.round(ms / 1000);
    if (s < 1) return 'now';
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** An {r,g,b} hue lifted toward white by t (0 = hue, 1 = white). */
const liftHue = (c, t) => ({ r: c.r + (1 - c.r) * t, g: c.g + (1 - c.g) * t, b: c.b + (1 - c.b) * t });

/** The cards' glyph-field unit (pixels → world). Card SIZES are set in world line
 *  heights (the cfg *LineHeight dials) and converted through the atlas metrics, so this
 *  only fixes the field's internal unit. */
const CARD_WORLD_SCALE = 0.025;

/** One record as a single glanceable roster line: `read  src/foo.js`, `bash  rg -n TODO → 3`. */
function fmtEntry(e) {
    const head = e.target ? `${e.action}  ${e.target}` : e.action;
    const mid = e.detail ? `  ${e.detail}` : '';
    const tail = e.result ? `   → ${String(e.result).split('\n')[0]}` : '';
    return `${head}${mid}${tail}`;
}

const STATES = new Set(['active', 'idle', 'stalled', 'done']);

export default class AgentBooks {
    /** @param {BookHost} ctx */
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
            book.setDeckDefaults(this._deckDefaults());
            this.root.add(book);
            const hueIdx = this.lanes.size;
            book.bindCover(this._coverOpts(this.cfg.palette[hueIdx % this.cfg.palette.length]));
            lane = {
                book, hueIdx,
                agentId,
                agentType: agentType || 'agent',
                state: 'active', beacon: null, lastActivityTs: this._now(),
                wallTs: null,          // wall-clock ms of the last LIVE activity (hydrated history ages by meta.lastTs)
                seq: 0, entries: [],   // one entry per sheet: cards + ids + the record
                seqExact: false,       // seq counts the WHOLE run — only a hydrate that read the record
                                       // from its start can say so; a live-born lane counts since
                                       // this display started watching (a floor)
                groupId: `agent:book:${agentId}`,
                sessionId: null,       // the harness session record this book renders (set by hydrate)
                meta: null,            // session provenance (title/slug/cwd/model/gitBranch…, gomux) — hydrate/setLaneMeta
                cwd: null,             // the session's working dir (meta.cwd), kept beside sessionId
                label: null,           // the nameplate (AgentNameplate) above the cover, in the lane's hue
                maxSheets: null,       // per-book retention override: n>0 caps, 0 unbounded, null → cfg.maxSheets
                pinned: false, pinnedPos: null,
            };
            book.fit(this._pageOpts(lane));   // page form from birth — appended sheets inherit it
            // The timeline: bound ONCE at birth — Book keeps the tabs parallel to the
            // sheets from here (a tab per appended sheet, freed with each shed one).
            if (this.cfg.tabs) book.bindTabs(this._tabOpts(lane));
            // The nameplate: the session's name (container-fit to the book) over its live
            // status, parked above the cover (Book.syncCover owns the per-frame placement).
            // Glyph fields, not baked textures — a long title instances glyphs.
            lane.label = new AgentNameplate({
                atlas: this.atlas,
                color: this.cfg.palette[hueIdx % this.cfg.palette.length],
            });
            lane.label.name = `agent-label:${agentId}`;
            book.setNameplate(lane.label);
            this._refreshNameplate(lane);
            this.lanes.set(agentId, lane);
            this._registerGroup(agentId, lane);
            this._emitChange();
        } else if (agentType && lane.agentType !== agentType) {
            lane.agentType = agentType;
            this._refreshNameplate(lane);
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
        if (!this._batch) lane.wallTs = Date.now();   // a hydration replays history — its age is meta.lastTs

        if (lane.newer?.length || (lane.history && !lane.book.following && lane.entries.length)) {
            // The window is held away from the live end (you're reading back): a live sheet
            // waits as a record beyond the window — the book doesn't shift under you. Paging
            // past the newest sheet (or `live`) slides it in.
            (lane.newer ??= []).push({ record, seq: lane.seq++ });
            if (!this._batch) { this._refreshNameplate(lane); this._emitChange(); }
            return lane;
        }
        const seq = lane.seq++;
        const { sides, entry } = this._buildSheet(lane, record, seq);
        lane.book.addSheet(sides);
        lane.entries.push(entry);
        this._trimLane(lane);   // past the cap, the oldest sheet leaves as the newest lands
        if (!this._batch) { this._refreshNameplate(lane); this._relayout(); this._emitChange(); }
        return lane;
    }

    /**
     * Build one record's sheet — the verso (the action call, composed at world size) and
     * the recto (its content) — without placing it. activity appends it; an older slice
     * paged in from history inserts it at the front; an event's update rebuilds it in
     * place as revision `rev` (its own card ids — a card of the replaced build that loads
     * late finds no sheet and stays out of the registry). @private
     * @returns {{sides: {verso:Object, recto:Object|null, meta:{seq:number, kind:string}}, entry: Object}}
     */
    _buildSheet(lane, record, seq, rev = 0) {
        const agentId = lane.agentId;
        const hue = this.cfg.hues[kindForAction(record.action)] || this.cfg.hues.other;
        const sheetId = rev ? `agent:${agentId}:${seq}~${rev}` : `agent:${agentId}:${seq}`;
        const actionId = `${sheetId}:action`;
        const bodyId = `${sheetId}:body`;
        const infoId = `${sheetId}:info`;
        const snapId = `${sheetId}:snap`;
        const meta = { agentId, seq, sheetId, record };

        // VERSO — the description page, composed at world size: the headline (`[verb]` +
        // the call's first line), the call's remaining lines, then its numeric meta.
        const call = actionCall(record);
        const infoText = infoOf(record);
        const sz = this._versoSizes(call, infoText);
        const action = this._card(`[${call.verb}]`, wrapText(call.head, sz.head.cols), {
            worldScale: CARD_WORLD_SCALE, gridScale: sz.head.gridScale,
            layout: { wrapWidth: sz.head.cols, zWrapSpacing: 0 },
            filenameColor: hue, textColor: liftHue(hue, record.action === 'noise' ? this.cfg.noiseTextLift : this.cfg.callTextLift),
        }, { id: actionId, meta: { ...meta, kind: 'action' } }, lane, sheetId);
        let body = null;
        if (call.rest) {
            body = this._card('call', wrapText(call.rest, sz.body.cols), {
                worldScale: CARD_WORLD_SCALE, gridScale: sz.body.gridScale, showFilename: false,
                layout: { wrapWidth: sz.body.cols, zWrapSpacing: 0 }, textColor: hue,
            }, { id: bodyId, meta: { ...meta, kind: 'action' } }, lane, sheetId);
        }
        let info = null;
        if (infoText) {
            info = this._card('info', infoText, {
                worldScale: CARD_WORLD_SCALE, gridScale: sz.info.gridScale, showFilename: false,
                layout: { wrapWidth: sz.info.cols, zWrapSpacing: 0 }, textColor: hue,
            }, { id: infoId, meta: { ...meta, kind: 'info' } }, lane, sheetId);
        }
        const verso = new ActionPage().setParts([action, body, info]).arrange(this._arrangeOpts());

        // RECTO — the content page: the file as-of now / the output / the prose / the image.
        // One home each: the verso holds the action's INPUT; the result lives here. A file's
        // content IS its snapshot; a no-target action's output (bash/grep/say/think) rides the
        // record raw — EPHEMERAL, no path to re-read. A file action that carries a result
        // (it failed: the error is the content) shows that instead. Ships RAW; the fit frames it.
        let recto = null, hasSnapPick = false, snapScaleKey = null;
        if (record.target && !record.result) {
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
            snapScaleKey = PROSE_ACTIONS.has(record.action) ? 'messageScale' : 'artifactWorldScale';
            hasSnapPick = true;
        }

        return {
            sides: { verso, recto, meta: { seq, kind: kindForAction(record.action) } },
            entry: {
                sheetId, verso, action, body, info, snapshot: recto, snapScaleKey,
                call, infoText, window: null,   // window: the snapshot's framed line range, once loaded
                pickMeta: meta,                 // the cards' shared registry meta (agentId, seq, sheetId, record)
                actionId, bodyId: body ? bodyId : null, infoId: info ? infoId : null, snapId: hasSnapPick ? snapId : null,
                record, rev, ts: this._now(),
            },
        };
    }

    /**
     * Bulk-hydrate a lane from a session record's events (the sessionAdapter's output) —
     * restoration reads the harness's OWN record back through the same normalize path the
     * live hook takes, so a restored book and that session's still-live stream converge on
     * one lane. One layout pass for the whole read (the batch discipline): per-event
     * relayouts are suppressed while building and a single flow lands at the end.
     *
     * Only the newest sheets materialize — the lane's retention cap (its override, else
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
     * @param {{agentType?:string, sessionId?:string|null, cwd?:string, meta?:Object|null, limit?:number, budgetMs?:number,
     *          seqBase?:number, seqExact?:boolean}} [opts] seqBase = records of the session that
     *        precede `events` (the tail the read skipped) — a fresh lane numbers its sheets from
     *        there, so a sheet's number is its place in the whole run; seqExact false = the read
     *        never reached the record's start, so that count is a floor
     * @returns {Promise<number>} sheets added
     */
    async hydrate(agentId, events, { agentType = 'claude', sessionId = null, cwd = '', meta = null, limit, budgetMs = 8,
                                    seqBase = 0, seqExact = true } = {}) {
        const lane = this.ensure(agentId, agentType);
        if (lane.seq === 0) { lane.seq = Math.max(0, Math.floor(seqBase) || 0); lane.seqExact = seqExact; }
        if (sessionId) lane.sessionId = sessionId;
        if (meta) {
            lane.meta = { ...(lane.meta || {}), ...meta };
            if (meta.cwd) lane.cwd = meta.cwd;
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
        // (never stall-demoted) until a live hook event lands and marks it active.
        this._setState(lane, 'idle');
        this._refreshNameplate(lane);   // once, after the batch — not per record
        this._relayout();
        this._emitChange();
        return added;
    }

    /**
     * The agent event stream's changes (AgentEventReader.push) onto the books — one sheet
     * per event, in stream order, nothing grouped:
     *   add     → a sheet appended (held away from the live end, it waits in the newer
     *             buffer like any live record);
     *   update  → the event's sheet REBUILT IN PLACE — same index, same place in the run,
     *             the head and the deck unmoved — or its record replaced where it waits in
     *             a buffer (a tool's result landing, a provisional reply confirmed). An add
     *             of an id a book already holds (a resumed stream re-sending its last line)
     *             is an update too. An update of an event no book holds any more is dropped;
     *   session → the lane's meta (title, model, cwd, branch, the parent link).
     * A subagent's events (they carry `agent`) land in its own book, whatever stream fed
     * them (eventLane / sessionLane). A lane's age is its newest event's own timestamp.
     * One nameplate restage and one relayout for the whole batch.
     * @param {string} streamLane the book this stream feeds
     * @param {EventChange[]} changes
     * @param {{agentType?:string}} [opts] agentType for a lane born here (else the session's harness)
     * @returns {{added:number, updated:number}}
     */
    applyEvents(streamLane, changes, { agentType = 'claude' } = {}) {
        let added = 0, updated = 0;
        const touched = new Set();
        const outer = this._batch;
        this._batch = true;
        try {
            for (const c of changes) {
                if (c.op === 'session') {
                    const lane = this.ensure(sessionLane(c.session, streamLane), c.session.harness || agentType);
                    lane.meta = { ...(lane.meta || {}), ...sessionMeta(c.session) };
                    if (lane.meta.cwd) lane.cwd = lane.meta.cwd;
                    if (c.session.session_id) lane.sessionId = c.session.session_id;
                    touched.add(lane);
                    continue;
                }
                const rec = eventRecord(c.event, c.pos, { showNoise: this.cfg.showNoise });
                if (!rec) continue;
                const id = eventLane(c.event, streamLane);
                const held = this.lanes.get(id);
                if (held && this._replaceRecord(held, rec)) { updated++; touched.add(held); continue; }
                if (c.op !== 'add') continue;
                const lane = this.activity(id, held?.agentType || agentType, rec);
                const t = Date.parse(rec.ts);
                if (Number.isFinite(t) && !(lane.wallTs >= t)) lane.wallTs = t;
                added++;
                touched.add(lane);
            }
        } finally {
            this._batch = outer;
        }
        if (!touched.size || outer) return { added, updated };
        for (const lane of touched) this._refreshNameplate(lane);
        this._relayout();
        this._emitChange();
        return { added, updated };
    }

    /**
     * Replace the record with `rec.id` wherever this lane holds it: a resident sheet is
     * rebuilt in place (Book.replaceSheet — its index, place in the run and deck pose kept),
     * a buffered record is swapped. The record keeps the POSITION it was added at (`at`) —
     * an update carries the offset of the line that changed it, and the book pages back by
     * where the event began. @private
     * @returns {boolean} whether the lane held it
     */
    _replaceRecord(lane, rec) {
        const i = lane.entries.findIndex((e) => e.record.id === rec.id);
        if (i >= 0) {
            const old = lane.entries[i];
            const next = { ...rec, at: old.record.at };
            if (JSON.stringify(next) === JSON.stringify(old.record)) return true;
            const seq = lane.book.sheets[i].meta.seq;
            this._disposeEntry(old);
            const { sides, entry } = this._buildSheet(lane, next, seq, (old.rev || 0) + 1);
            lane.book.replaceSheet(i, sides);
            lane.entries[i] = entry;
            return true;
        }
        for (const buf of [lane.newer, lane.older]) {
            const item = buf?.find((x) => x.record.id === rec.id);
            if (item) { item.record = { ...rec, at: item.record.at }; return true; }
        }
        return false;
    }

    /**
     * agent.meta / agent.kimi-wire: merge session metadata onto a lane and restage its
     * nameplate. Live lanes learn their title/cwd/model this way (archived ones get it
     * through hydrate's opts.meta); an orchestrator's fields ride `meta.gomux`. Unknown
     * lane → false.
     * @param {string} id lane id
     * @param {Object} meta partial metadata — merged over what the lane already holds
     * @returns {boolean}
     */
    setLaneMeta(id, meta) {
        const lane = this.lanes.get(id);
        if (!lane || !meta || typeof meta !== 'object') return false;
        lane.meta = { ...(lane.meta || {}), ...meta };
        if (lane.meta.cwd) lane.cwd = lane.meta.cwd;
        this._refreshNameplate(lane);
        this._emitChange();
        return true;
    }

    /**
     * What a session IS and what it's DOING, in one record — the single source the
     * nameplate, the Agents panel rows, and the canvas hover readout all read.
     *
     *   name    — meta.gomux.name ?? meta.title ?? meta.agentName ?? meta.slug ?? '~<id>'
     *   status  — meta.gomux.status ?? the lane's lifecycle (active/idle/stalled/done)
     *   verb/head/action — the current call: gomux.tool + gomux.detail when an orchestrator
     *             reports them, else the newest record's call (actionCall); action is the
     *             one-line `verb  head` form
     *   step    — records this book has seen (lane.seq)
     *   wallTs/age — wall-clock time of the last live activity, else the record's lastTs
     *   where   — basename(cwd) · type · model · branch · gomux backend · parent
     *   page    — the book's head/count/following
     * `ref` is a lane or anything resolveLane takes (id, group id, Book). With `sheetId`,
     * `sheet` describes that sheet too (a hovered page that isn't the newest).
     * @param {string|Object} ref
     * @param {string} [sheetId]
     * @returns {Object|null}
     */
    readout(ref, sheetId) {
        const lane = (ref && typeof ref === 'object' && Array.isArray(ref.entries)) ? ref : this.resolveLane(ref)?.[1];
        if (!lane) return null;
        const meta = lane.meta || {};
        const gx = meta.gomux && typeof meta.gomux === 'object' ? meta.gomux : null;
        const newest = lane.entries.length ? lane.entries[lane.entries.length - 1] : null;
        let verb = newest?.call.verb || '', head = newest?.call.head || '';
        if (gx && (gx.tool || gx.detail)) { verb = gx.tool || ''; head = gx.detail || ''; }
        const wallTs = lane.wallTs ?? (Number.isFinite(meta.lastTs) ? meta.lastTs : null);
        const base = meta.cwd ? String(meta.cwd).split('/').filter(Boolean).pop() : null;
        const where = [base, lane.agentType, meta.model, meta.gitBranch,
            gx?.backend && gx.backend !== lane.agentType ? gx.backend : null,
            gx?.parent ? `parent ${gx.parent}` : null].filter(Boolean).join(' · ');
        const out = {
            agentId: lane.agentId,
            name: gx?.name || meta.title || meta.agentName || meta.slug || `~${lane.agentId}`,
            state: lane.state,
            status: gx?.status || lane.state,
            beacon: lane.beacon,
            verb, head,
            action: [verb, head].filter(Boolean).join('  '),
            step: lane.seq,
            wallTs,
            age: wallTs != null ? fmtAge(Date.now() - wallTs) : '',
            where,
            page: lane.book.headState(),
            sheet: null,
        };
        if (sheetId) {
            const i = lane.entries.findIndex((e) => e.sheetId === sheetId);
            if (i >= 0) {
                const e = lane.entries[i];
                out.sheet = { index: i, verb: e.call.verb, head: e.call.head, info: e.infoText,
                    window: e.window ? { ...e.window } : null };
            }
        }
        return out;
    }

    /**
     * The nameplate's two blocks for a lane, unwrapped: the name, and the status rows —
     *   `status · step N · age ago` (· `needs you: <beacon>`)
     *   the current action (`verb  head`; a say/think is its verb alone — the prose is
     *     the open page itself, and a paragraph would stand the plate a page tall)
     *   where it runs (cwd · type · model · branch · backend · parent)
     * @returns {{name:string, status:string}}
     */
    nameplateText(lane) {
        const r = this.readout(lane);
        const newest = lane.entries.length ? lane.entries[lane.entries.length - 1].record : null;
        const gx = lane.meta?.gomux;
        const prose = !(gx && (gx.tool || gx.detail)) && PROSE_ACTIONS.has(newest?.action);
        const action = prose ? r.verb : r.action;
        const age = r.age ? (r.age === 'now' ? 'now' : `${r.age} ago`) : null;
        const row1 = [r.status, r.step ? `step ${r.step}` : null, age,
            r.beacon ? `needs you: ${r.beacon}` : null].filter(Boolean).join(' · ');
        return { name: r.name, status: [row1, action, r.where].filter(Boolean).join('\n') };
    }

    /** agent.state — set a lane's lifecycle by hand. */
    state(agentId, state) {
        const lane = this.lanes.get(agentId);
        if (!lane || !STATES.has(state)) return false;
        this._setState(lane, state);
        this._refreshNameplate(lane);
        this._emitChange();
        return true;
    }

    /** agent.stop — the agent finished. 'done' PERSISTS until cleared: small fast helpers
     *  you never looked at stay on the shelf, viewable, instead of vanishing on a timer. */
    stop(agentId) {
        const lane = this.lanes.get(agentId);
        if (!lane) return false;
        this._setState(lane, 'done');
        this._refreshNameplate(lane);
        this._emitChange();
        return true;
    }

    /** agent.request — the agent raises a hand for input/advice. The panel surfaces it. */
    request(agentId, msg) {
        const lane = this.lanes.get(agentId);
        if (!lane) return false;
        lane.beacon = msg || 'needs you';
        this._refreshNameplate(lane);
        this._emitChange();
        return true;
    }

    /** Lower a raised hand (the agent is no longer waiting on you). */
    clearRequest(agentId) {
        const lane = this.lanes.get(agentId);
        if (!lane || !lane.beacon) return false;
        lane.beacon = null;
        this._refreshNameplate(lane);
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

    /** A book's head state (for panels/verbs), or null if it has no lane — with the open
     *  sheet's place in the whole RUN (`sheet`, 1-based — not the index among kept sheets),
     *  the run's sheets so far and whether those counts are exact, and the TURN the open
     *  sheet belongs to (its event's prompt: `turn` = the turn's index, `turnId`,
     *  `turnDerived`; null for a record no event carried). */
    headState(agentId) {
        const hit = this.resolveLane(agentId);
        if (!hit) return null;
        const lane = hit[1];
        const s = lane.book.headState();
        const seq = lane.book.sheets[s.head]?.meta?.seq;
        const turn = lane.entries[s.head]?.record?.turn ?? null;
        const base = lane.sheetBase || 0, h = lane.history;
        return { agentId: hit[0], ...s, sheet: seq != null ? seq + base + 1 : 0, sheets: lane.seq + base, exact: lane.seqExact === true,
                 turn: turn ? turn.index : null, turnId: turn?.id ?? null, turnDerived: !!turn?.derived,
                 older: !!h && (!h.done || (lane.older?.length ?? 0) > 0), loading: !!h?.loading, newer: lane.newer?.length ?? 0 };
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
     * id, type, lifecycle, beacon, identity color, sheet count, retention (effective
     * cap + whether it's an override), head + live-follow, the newest sheet's time, and
     * the readout's name / status / current action / wall-clock time.
     * Ordered oldest lane first (creation order).
     */
    agents() {
        const pal = this.cfg.palette;
        return [...this.lanes.entries()].map(([id, l]) => {
            const cap = this._capFor(l);
            const r = this.readout(l);
            return {
                id,
                name: r.name,
                status: r.status,
                action: r.action,
                step: r.step,
                wallTs: r.wallTs,
                type: l.agentType,
                state: l.state,
                beacon: l.beacon,
                sessionId: l.sessionId,
                meta: l.meta || null,
                count: l.book.sheets.length,
                limit: l.maxSheets,                        // retention override (null → shelf default)
                cap: Number.isFinite(cap) ? cap : 0,       // effective kept-sheets cap (0 = unbounded)
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
                label: [e.record?.tag, e.record?.target, e.record?.detail].filter(Boolean).join(' · '),
                ts: e.ts,
                focused: j === head,
            };
        });
    }

    // -- per-frame -------------------------------------------------------------------

    /** Ease every book's deck toward its slots; detect stalls; re-read the nameplates'
     *  ages every cfg.labelTickMs (an unchanged plate is a no-op in FieldLabel). */
    update(dt) {
        const now = this._now();
        const tick = !this._batch && !(now - (this._labelTickAt ?? -Infinity) < this.cfg.labelTickMs);   // a hydration restages once, at its end
        if (tick) this._labelTickAt = now;
        let changed = false;
        for (const lane of this.lanes.values()) {
            if (lane.state === 'active' && now - lane.lastActivityTs > this.cfg.stallMs) {
                this._setState(lane, 'stalled');
                changed = true;
                this._refreshNameplate(lane);
            } else if (tick) this._refreshNameplate(lane);
            lane.book.update(dt);
        }
        if (changed) this._emitChange();
    }

    // -- scale / config --------------------------------------------------------------

    /**
     * Cap ONE book's kept sheets — the book.limit verb's engine (a hydration's explicit
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

    /** The shelf's deck defaults, in the deck's own terms — every book here is born with
     *  them, and a re-apply restamps them on every knob a book wasn't given itself. */
    _deckDefaults() {
        const c = this.cfg;
        return { zPitch: c.zPitch, lerp: c.pagerLerp, turned: c.turnedPitch, slide: c.turnSlide };
    }

    /**
     * Re-apply the current cfg SIZES to every live card — the one entry the config verb
     * and the Settings rows both route through. Verso cards re-size to their world line
     * heights and re-wrap to the page (a re-fold, so their sheet re-arranges as each
     * settles); worldScale content cards bake their layout at build, so a uniform
     * transform re-sizes them (desired ÷ built). Then re-fit + re-flow so pages re-read,
     * and restage the nameplates. A tightened cfg.maxSheets lands here too — each lane
     * sheds to its cap first. (Snapshot windows re-frame on the next snapshot load.)
     */
    applyScales() {
        for (const lane of this.lanes.values()) {
            this._trimLane(lane);
            lane.book.setDeckDefaults(this._deckDefaults());
            if (this.cfg.tabs) lane.book.bindTabs(this._tabOpts(lane));   // a diff — tabs re-true in place
            else lane.book.dropTabs();
            for (const e of lane.entries) {
                this._resizeVerso(lane, e);
                if (e.snapScaleKey && typeof e.snapshot?.setScale === 'function') {
                    const built = e.snapshot.config?.worldScale;
                    const target = this.cfg[e.snapScaleKey];
                    if (built > 0 && target > 0) e.snapshot.setScale(target / built);
                }
            }
            lane.book.fit(this._pageOpts(lane));
            this._refreshNameplate(lane);
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

    /** One glyph cell's advance per unit of line height — from the atlas, at runtime (the
     *  cell is the shaper's 'M' advance × its real em; computeCellMetrics is the one
     *  formula every grid lays out by). Fails loud without an atlas: sizes would be guesses.
     *  @private @returns {number} */
    _advPerLh() {
        const size = this.atlas?.getCharSize?.();
        if (!size || !(size.width > 0) || !(size.height > 0)) {
            throw new Error(`[AgentBooks] atlas.getCharSize() gave no cell (${JSON.stringify(size)}) — card sizes derive from the atlas`);
        }
        const m = computeCellMetrics(size, 1);
        return (m.charWidth + m.letterSpacing) / m.lineSpacing;
    }

    /** The verso's arrange opts (page dims + margin + gap). @private */
    _arrangeOpts() {
        const c = this.cfg;
        return { pageW: c.pageW, pageH: c.pageH, margin: c.pageMargin, gap: c.rowGap };
    }

    /**
     * Size an action call's verso cards in world units: the headline at callLineHeight
     * (stepping down toward callMinLineHeight only when its wrapped call would take more
     * than callMaxFrac of the page), the info rows at infoLineHeight, and the call's
     * remaining lines in whatever height is left (bodyLineHeight, stepping down toward
     * bodyMinLineHeight). Each comes back as the card's gridScale + wrap columns.
     * @private
     * @param {{head:string, rest:string}} call @param {string} infoText
     */
    _versoSizes(call, infoText) {
        const c = this.cfg;
        const adv = this._advPerLh();
        const ls = computeCellMetrics(this.atlas.getCharSize(), CARD_WORLD_SCALE).lineSpacing;
        const innerW = Math.max(c.pageW - 2 * c.pageMargin, 1);
        const innerH = Math.max(c.pageH - 2 * c.pageMargin, 1);
        const card = ({ lh, cols }) => ({ gridScale: lh / ls, cols, lh });
        const head = fitTextBlock(call.head, {
            innerW, availH: innerH * c.callMaxFrac, maxLh: c.callLineHeight, minLh: c.callMinLineHeight,
            advPerLh: adv, extraRows: 1,   // + the `[verb]` tag row
        });
        const info = fitTextBlock(infoText, {
            innerW, availH: Infinity, maxLh: c.infoLineHeight, minLh: c.infoLineHeight, advPerLh: adv,
        });
        const used = head.rows * head.lh + (infoText ? c.rowGap + info.rows * info.lh : 0);
        const body = fitTextBlock(call.rest, {
            innerW, availH: innerH - used - c.rowGap, maxLh: c.bodyLineHeight, minLh: c.bodyMinLineHeight, advPerLh: adv,
        });
        return { head: card(head), info: card(info), body: card(body) };
    }

    /** Re-size + re-wrap one sheet's verso cards to the live cfg — the call text re-wraps
     *  at word boundaries for its new column count (a re-load), the info rows re-fold at
     *  theirs; each settles (re-arranges the page, re-fits the sheet) as it lands. @private */
    _resizeVerso(lane, e) {
        if (!e.call) return;
        const sz = this._versoSizes(e.call, e.infoText);
        const settle = () => this._settle(lane, e.sheetId);
        for (const [card, s, text] of [[e.action, sz.head, e.call.head], [e.body, sz.body, e.call.rest]]) {
            if (!card) continue;
            card.setScale(s.gridScale);
            card.config.layout.wrapWidth = s.cols;
            card.loadFile(card.filename, wrapText(text, s.cols)).then(settle).catch(() => {});
        }
        if (e.info) {
            e.info.setScale(sz.info.gridScale);
            e.info.setLayout({ wrapWidth: sz.info.cols }).then(settle).catch(() => {});
        }
        e.verso?.arrange?.(this._arrangeOpts());
    }

    /**
     * Restage a lane's nameplate from its readout. The NAME container-fits the book: it
     * spans up to labelFit of the spread's width, its line height clamped to
     * [labelMinLineHeight, labelMaxLineHeight] — a name too long even at the minimum
     * wraps. The status block rides at labelStatusRatio × the name's line height, wrapped
     * to the same width. Identical text is a no-op downstream (FieldLabel). @private
     */
    _refreshNameplate(lane) {
        if (!lane.label) return;
        const c = this.cfg;
        const { name, status } = this.nameplateText(lane);
        const adv = this._advPerLh();
        const W = (2 * c.pageW + c.gutter) * c.labelFit;
        const widest = Math.max(1, ...name.split('\n').map((l) => [...l].length));
        const lo = Math.min(c.labelMinLineHeight, c.labelMaxLineHeight);
        const nameLh = Math.min(Math.max(W / (widest * adv), lo), c.labelMaxLineHeight);
        const statusLh = nameLh * c.labelStatusRatio;
        const cols = (lh) => Math.floor(W / (adv * lh) + 1e-6);   // a name fit exactly to W is W/lh cells, not one fewer
        lane.label.set(
            wrapText(name, cols(nameLh)),
            status ? wrapText(status, cols(statusLh)) : '',
            { nameLh, statusLh });
    }

    /** The timeline tabs' Book.bindTabs opts: a tab per sheet labelled with its NUMBER in
     *  the run (an event's place — the turn it belongs to is the HUD's), set in a ruler
     *  across the open page's top edge (oldest left → newest right), banded + plated in
     *  its action kind's hue (dark numerals); the open
     *  sheet's tab keeps its hue and stands raised + brighter — "you are here" in the
     *  run (Book.syncTabs lifts the head's tab). @private */
    _tabOpts(lane) {
        const hex = (c) => ((Math.round(c.r * 255) << 16) | (Math.round(c.g * 255) << 8) | Math.round(c.b * 255)) >>> 0;
        return {
            atlas: this.atlas,
            keyOf: (sheet) => sheet.meta?.kind ?? 'other',
            labelOf: (sheet) => (sheet.meta?.seq != null ? String(sheet.meta.seq + (lane.sheetBase || 0) + 1) : ''),
            hueOf: (kind) => hex(this.cfg.hues[kind] || this.cfg.hues.other),
            lineHeight: this.cfg.pageH * this.cfg.tabLine,
            plateOpacity: 0.85,
            activeColor: null,
            textColor: { r: 0.04, g: 0.05, b: 0.08 },
            ride: 'front',   // a ruler across the open page's top edge — readable head-on
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
            .then(() => {
                // A sheet shed (or rebuilt by an event's update) while its card loaded: the
                // card is disposed, and registering it would leave a dead entry behind.
                if (pick && lane.entries.some((e) => e.sheetId === sheetId)) this._wireCardPick(grid, pick.id, pick.meta);
                this._settle(lane, sheetId);
            })
            .catch(() => { /* render best-effort */ });
        return grid;
    }

    /** A loaded card's bounds settled: re-arrange its ActionPage (the cards' measured
     *  extents stack top-down), re-fit its sheet, and request a re-flow. The sheet resolves
     *  by ID, not position — the
     *  retention cap evicts oldest sheets, so positions shift under a pending load (an
     *  evicted sheet's late settle is a no-op). The flow is COALESCED per tick — a
     *  hydration resolves hundreds of card loads in bursts, and each one re-packing the
     *  world would be the minutes-not-milliseconds trap. @private */
    _settle(lane, sheetId) {
        const i = lane.entries.findIndex((e) => e.sheetId === sheetId);
        if (i < 0) return;   // shed while its content loaded
        const entry = lane.entries[i];
        entry.verso?.arrange?.(this._arrangeOpts());
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
     *  closes up behind them. A book with a history keeps each shed sheet's RECORD in its
     *  older buffer, so paging back slides it in without a read. @private @returns {number} sheets shed */
    _trimLane(lane) {
        const cap = this._capFor(lane);
        let n = 0;
        while (lane.entries.length > cap) {
            const item = this._evict(lane, 0);
            if (lane.history) this._keepOlder(lane, [item]);
            n++;
        }
        return n;
    }

    /** Remove sheet i and release its cards; returns its {record, seq}. @private */
    _evict(lane, i) {
        const [e] = lane.entries.splice(i, 1);
        const seq = lane.book.sheets[i]?.meta?.seq ?? e.pickMeta.seq;
        lane.book.removeSheet(i);
        this._disposeEntry(e);
        return { record: e.record, seq };
    }

    /** Build {record, seq} into a sheet at index i. @private */
    _materialize(lane, i, item) {
        const { sides, entry } = this._buildSheet(lane, item.record, item.seq);
        lane.book.insertSheet(i, sides);
        lane.entries.splice(i, 0, entry);
    }

    /** Append records to the older buffer's NEWEST end, dropping its oldest past the
     *  buffer bound (they stay readable from the transcript). @private */
    _keepOlder(lane, items) {
        const older = (lane.older ??= []);
        older.push(...items);
        const max = Math.max(0, this.cfg.historyBuffer);
        if (older.length > max) {
            older.splice(0, older.length - max);
            if (lane.history) lane.history.done = false;   // the dropped ones are behind the cursor again
        }
    }

    // -- history: a sliding window over the whole run ------------------------------------

    /**
     * Give a lane its HISTORY — where its older sheets come from. The book is a fixed-size
     * WINDOW (its cap of sheets) sliding over the run: pushing past its oldest sheet slides
     * it one sheet back (the older sheet materializes at the front, the newest leaves for
     * the newer buffer), pushing past its newest slides it forward; sheets outside the
     * window wait as parsed records, not GPU objects. Paging near the oldest sheet
     * prefetches older records from the transcript (by each record's byte offset, `at`)
     * so a slide never waits on a read. While the window is held away from the live end,
     * live sheets join the newer buffer — the book never shifts under the reader.
     * @param {string} agentId
     * @param {{read: (window:{fromOffset?:number, maxBytes?:number, tailBytes?:number}) => Promise<{bytes:Uint8Array, offset:number}>,
     *          parse: (bytes:Uint8Array, opts:Object) => Promise<{records:Array, count?:number}>,
     *          harness: string, cwd?: string|null}} source
     */
    setHistory(agentId, source) {
        const lane = this.lanes.get(agentId);
        if (!lane) return false;
        lane.history = { ...source, loading: null, done: false };
        lane.older ??= [];
        lane.newer ??= [];
        lane.book.onPage = (head, asked) => this._onPage(lane, head, asked);
        return true;
    }

    /** Book.onPage: slide past either end, prefetch near the oldest. @private */
    _onPage(lane, head, asked) {
        const n = lane.book.sheets.length;
        if (asked === Infinity) { this.slide(lane.agentId, lane.newer.length); return; }   // `live`
        if (asked < 0) this.slide(lane.agentId, asked);
        else if (asked > n - 1 && lane.newer.length) this.slide(lane.agentId, asked - (n - 1));
        if (lane.book.head <= this.cfg.historyLead && lane.older.length < this.cfg.historyTurns) this.loadOlder(lane.agentId);
    }

    /**
     * Slide a book's window by `delta` sheets (− older, + newer), keeping its size: each
     * step materializes one sheet at the leading edge and returns the trailing edge's sheet
     * to its buffer. The head lands on the leading edge (the sheet you paged to). Sliding
     * back past what's buffered waits for the read in flight and goes on.
     * @param {string} agentId @param {number} delta
     * @returns {number} sheets slid
     */
    slide(agentId, delta) {
        const lane = this.lanes.get(agentId);
        if (!lane?.history || !delta) return 0;
        const book = lane.book;
        let moved = 0;
        if (delta < 0) {
            const want = -delta;
            const k = Math.min(want, lane.older.length);
            if (k) {
                const cap = this._capFor(lane);
                this._batch = true;
                try {
                    for (let i = 0; i < k; i++) {
                        this._materialize(lane, 0, lane.older.pop());
                        if (lane.entries.length > cap) lane.newer.unshift(this._evict(lane, lane.entries.length - 1));
                    }
                } finally { this._batch = false; }
                book.head = 0;
                book.following = false;
                moved = k;
            }
            if (want > k && !lane.history.done) {
                lane.history.pendingBack = (lane.history.pendingBack || 0) + (want - k);
                this.loadOlder(agentId);
            }
        } else {
            const k = Math.min(delta, lane.newer.length);
            if (!k) return 0;
            this._batch = true;
            try {
                if (k >= lane.entries.length) {
                    // a jump wider than the window: rebuild it from the newer buffer's end
                    const all = [...lane.entries.map((_, i) => ({ record: lane.entries[i].record, seq: book.sheets[i].meta.seq }))];
                    while (lane.entries.length) this._evict(lane, lane.entries.length - 1);
                    const cap = this._capFor(lane);
                    const pulled = lane.newer.splice(0, k);
                    const seq = all.concat(pulled);
                    const keep = Number.isFinite(cap) ? seq.slice(-cap) : seq;
                    this._keepOlder(lane, seq.slice(0, seq.length - keep.length));
                    keep.forEach((item, i) => this._materialize(lane, i, item));
                } else {
                    for (let i = 0; i < k; i++) {
                        this._materialize(lane, lane.entries.length, lane.newer.shift());
                        this._keepOlder(lane, [this._evict(lane, 0)]);
                    }
                }
            } finally { this._batch = false; }
            book.head = book.sheets.length - 1;
            book.following = lane.newer.length === 0;
            moved = k;
        }
        if (moved) {
            book.seatAll();   // a slide is a cut — the window re-seats at once, nothing flies
            this._refreshNameplate(lane);
            this._relayout();
            this._emitChange();
        }
        return moved * Math.sign(delta);
    }

    /**
     * Read the records before the oldest known one (the older buffer's, else the window's)
     * into the older buffer. Single-flight per lane; resolves with the records added.
     * A slide waiting on it goes on when it lands.
     * @param {string} agentId @returns {Promise<number>}
     */
    loadOlder(agentId) {
        const lane = this.lanes.get(agentId);
        const h = lane?.history;
        if (!h || h.done) return Promise.resolve(0);
        if (h.loading) return h.loading;
        const oldest = lane.older[0] ?? (lane.entries[0] && { record: lane.entries[0].record, seq: lane.book.sheets[0].meta.seq });
        const from = oldest?.record?.at;
        if (!Number.isFinite(from)) return Promise.resolve(0);   // a live-born record knows no byte offset
        if (from <= 0) { this._reachedStart(lane, oldest.seq); return Promise.resolve(0); }
        if (!lane.seqExact && !h.counting) h.counting = this._countBefore(lane, from, oldest.seq);
        h.loading = this._readOlder(lane, from, oldest.seq).finally(() => {
            h.loading = null;
            const pend = h.pendingBack || 0;
            h.pendingBack = 0;
            if (pend && this.lanes.get(lane.agentId) === lane) this.slide(lane.agentId, -pend);
            this._emitChange();
        });
        this._emitChange();
        return h.loading;
    }

    /** @private */
    async _readOlder(lane, from, fromSeq) {
        const h = lane.history, c = this.cfg;
        let span = c.historySliceBytes, recs = [], start = 0;
        for (;;) {
            const want = Math.max(0, from - span);
            const r = await h.read({ fromOffset: want, maxBytes: from - want + c.historyOverlapBytes });
            const out = await h.parse(r.bytes, { harness: h.harness, cwd: h.cwd ?? null, cap: Infinity, base: r.offset, showNoise: c.showNoise });
            recs = out.records.filter((x) => Number.isFinite(x.at) && x.at < from);
            start = r.offset;
            if (recs.length >= c.historyTurns || start === 0 || span >= 64 * 1024 * 1024) break;
            span *= 2;
        }
        // The book moved on while we read (closed, or the oldest known record changed): drop it.
        const oldest = lane.older[0]?.record ?? lane.entries[0]?.record;
        if (this.lanes.get(lane.agentId) !== lane || oldest?.at !== from) return 0;
        const take = recs.slice(-c.historyTurns);
        lane.older.unshift(...take.map((record, j) => ({ record, seq: fromSeq - take.length + j })));
        if (start === 0 && take.length === recs.length) this._reachedStart(lane, fromSeq - take.length);
        return take.length;
    }

    /** Count the records before byte `from` (off-thread, records not cloned back) and make
     *  the lane's sheet numbers exact: the record at `from` (seq fromSeq) is sheet count+1.
     *  Once per lane — until it lands, numbers are the open's estimate (shown `~`). @private */
    async _countBefore(lane, from, fromSeq) {
        const h = lane.history;
        try {
            const r = await h.read({ fromOffset: 0, maxBytes: from });
            if (r.offset !== 0) return;   // the relay's read bound kept the END — can't count from the start
            const out = await h.parse(r.bytes, { harness: h.harness, cwd: h.cwd ?? null, cap: Infinity, countOnly: true, showNoise: this.cfg.showNoise });
            if (this.lanes.get(lane.agentId) !== lane) return;
            this._setSheetBase(lane, out.count - fromSeq);
        } catch (e) {
            console.warn(`[AgentBooks] ${lane.agentId}: counting the sheets before the window failed — numbers stay estimates:`, e?.message || e);
        }
    }

    /** The oldest record is the run's first (seq minSeq): sheet numbers become exact. @private */
    _reachedStart(lane, minSeq) {
        lane.history.done = true;
        this._setSheetBase(lane, -minSeq);
    }

    /** Exact sheet numbers from here: sheet = seq + base + 1; tabs re-label in place. @private */
    _setSheetBase(lane, base) {
        lane.sheetBase = base;
        lane.seqExact = true;
        if (this.cfg.tabs) lane.book.bindTabs(this._tabOpts(lane));
        this._refreshNameplate(lane);
        this._emitChange();
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

    /** A no-target action's OUTPUT as the recto: command result / prose (a prompt, a
     *  say/think, the harness's words). Ships RAW — the fit frames it; nothing is truncated
     *  here. Prose word-wraps to cfg.proseWrapCols (a page-shaped column reads at a far
     *  larger fit than a 200-column strip). A prompt's words are set in the prompt hue
     *  (lifted by cfg.promptTextLift) under a header naming whose they are; a noise call's
     *  output in the dim noise hue (cfg.noiseTextLift), so it reads as background. */
    _outputSnapshot(record, pick, lane, sheetId) {
        const isMessage = PROSE_ACTIONS.has(record.action);
        const name = record.action === 'prompt' ? (record.tag || 'prompt')
            : record.action === 'say' ? 'said' : record.action === 'think' ? 'thinking'
            : record.action === 'system' ? 'harness' : 'output';
        const worldScale = isMessage ? this.cfg.messageScale : this.cfg.artifactWorldScale;
        const cols = isMessage ? Math.floor(this.cfg.proseWrapCols) : 0;
        const text = String(record.result ?? '');
        const opts = { worldScale };
        if (record.action === 'prompt' || record.action === 'noise') {
            const hue = this.cfg.hues[record.action] || this.cfg.hues.other;
            opts.textColor = liftHue(hue, record.action === 'prompt' ? this.cfg.promptTextLift : this.cfg.noiseTextLift);
            opts.filenameColor = hue;
        }
        return this._card(name, cols > 0 ? wrapText(text, cols) : text, opts, pick, lane, sheetId);
    }

    /**
     * The recto for a file target: its content AS-OF this moment (loaded ONCE), FRAMED to
     * the touched range — snapshotWindow picks the lines (the touched runs ± snapContextRows,
     * at most snapMaxRows), the grid loads just that slice, and the touched lines light up
     * at their window rows. The page then shows a legible window instead of a whole file
     * shrunk to fit; the verso's info rows name the window (`shown L…–… of N`). Registers
     * as a pickable card after load. @private
     */
    _loadSnapshot(grid, record, pick, lane, sheetId) {
        const path = record.target;
        const wire = () => { if (pick && lane.entries.some((e) => e.sheetId === sheetId)) this._wireCardPick(grid, pick.id, pick.meta); };
        let win = null;
        Promise.resolve(this.ctx.fileProvider?.getFile?.(path))
            .then((content) => this._resolveSnapshotText(path, String(content ?? '')))
            .then((text) => {
                const lines = text.split('\n');
                const w = snapshotWindow(record.meta, lines.length,
                    { context: this.cfg.snapContextRows, maxRows: this.cfg.snapMaxRows });
                if (!w) return grid.loadFile(path, text);
                win = { ...w, total: lines.length };
                return grid.loadFile(path, lines.slice(w.first, w.last + 1).join('\n'));
            })
            .then(() => {
                this._decorateSnapshot(grid, record, win ? win.first : 0);
                wire();
                if (win) this._noteWindow(lane, sheetId, win);
                this._settle(lane, sheetId);
            })
            .catch(() => grid.loadFile(path, '(could not load)').then(() => { wire(); this._settle(lane, sheetId); }).catch(() => {}));
    }

    /**
     * A snapshot loaded FRAMED: record the window on its entry and name it in the verso's
     * info rows (`shown L<a>–<b> of <N>`, 1-based) — re-loading the info card, or making
     * one when the record carried no meta. The page re-arranges as the info card settles.
     * @private
     */
    _noteWindow(lane, sheetId, win) {
        const e = lane.entries.find((x) => x.sheetId === sheetId);
        if (!e) return;   // shed while its content loaded
        e.window = win;
        const note = `shown L${win.first + 1}–${win.last + 1} of ${win.total}`;
        e.infoText = [infoOf(e.record), note].filter(Boolean).join('\n');
        const sz = this._versoSizes(e.call, e.infoText).info;
        const hue = this.cfg.hues[kindForAction(e.record.action)] || this.cfg.hues.other;
        if (e.info) {
            e.info.setScale(sz.gridScale);
            e.info.config.layout.wrapWidth = sz.cols;
            e.info.loadFile('info', e.infoText).then(() => this._settle(lane, sheetId)).catch(() => {});
            return;
        }
        e.infoId = `${sheetId}:info`;
        e.info = this._card('info', e.infoText, {
            worldScale: CARD_WORLD_SCALE, gridScale: sz.gridScale, showFilename: false,
            layout: { wrapWidth: sz.cols, zWrapSpacing: 0 }, textColor: hue,
        }, { id: e.infoId, meta: { ...e.pickMeta, kind: 'info' } }, lane, sheetId);
        e.verso.setParts([e.action, e.body, e.info]);
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
        const uri = toFileUri(path);
        const open = this.ctx.registry?.findByMeta?.('sourcePath', uri) || [];
        const g = open[0]?.grid;
        return (g && typeof g.content === 'string' && g.content.length) ? g.content : null;
    }

    /**
     * Light up the lines an action touched on its loaded snapshot. Edits fill their added
     * lines green; a partial read fills its slice blue. A directive's `fill` flag becomes
     * a background-fill BAR at cfg.highlightFillOpacity; a non-fill directive falls back
     * to an additive glyph tint. Directives come from the shared tool registry
     * (decorateForAction) in FILE lines; a framed snapshot shifts them by its window's
     * first line (`lineOffset`). Applied via highlightRange after the single load resolves.
     */
    _decorateSnapshot(grid, record, lineOffset = 0) {
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
            const start = Math.max(0, d.startLine - lineOffset);
            const end = Math.min(lastLine, d.endLine - lineOffset);
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
        for (const id of [e.actionId, e.bodyId, e.infoId, e.snapId]) { if (id) { try { this.ctx.registry?.unregister?.(id); } catch (_e) { /* best effort */ } } }
        for (const g of [e.action, e.body, e.info, e.snapshot]) {
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

    // -- private: cluster layout -------------------------------------------------------

    /**
     * Re-lay the cluster (idempotent): pack the books as bounds-leaves via the chosen
     * scheme — the same machinery the file tree uses — re-assert pinned books, rest the
     * cluster on the world floor, size the covers, and notify the world layout.
     *
     * A book RIDDEN ELSEWHERE (seated at a carrel — its parent is not the root) is
     * BORROWED, the Carrel's own word for it: the cluster keeps its lane but takes its
     * hands off the transform, and it has no say in the floor rest.
     *
     * A PINNED book is user-placed: the scheme packs every child, so a pinned book's LIVE
     * position is carried across it (a drag in flight included — re-asserting the last
     * pinnedPos would yank it back under the cursor), and it has no say in the floor rest
     * or the cluster's footprint either (resting on it dropped a lone dragged book to the
     * floor). pinnedPos is the persisted record moveGroup writes.
     */
    _relayout() {
        const scheme = LAYOUT_SCHEMES[this.cfg.layout] || LAYOUT_SCHEMES.packed;
        const placed = [];
        for (const lane of this.lanes.values()) {
            if (lane.pinned && lane.book.parent === this.root) placed.push([lane.book, lane.book.position.clone()]);
        }
        scheme(this.root, this.cfg.layoutOpts);
        for (const [book, pos] of placed) book.position.copy(pos);
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

    /** World-space AABB of the LAID-OUT cluster — the union of every root-held, unpinned
     *  book's world box. Borrowed books (seated at a carrel) are the desk's extent, not the
     *  cluster's — counting them dragged the floor rest toward wherever the desk stands;
     *  pinned books are where the user put them. @private */
    _worldBounds(target = new THREE.Box3()) {
        target.makeEmpty();
        this.root.updateWorldMatrix(true, true);
        for (const lane of this.lanes.values()) {
            if (lane.book.parent !== this.root || lane.pinned) continue;
            const b = lane.book.getBounds();
            if (b && !b.isEmpty()) target.union(b);
        }
        return target;
    }

    /** The cluster's LOCAL content box (root frame) — so the WorldLayout can measure the
     *  agent shelf as a bounds-leaf beside the file tree. Borrowed books are skipped:
     *  their matrices are another frame's, and the world must not space groupings
     *  around a phantom extent (the default shelf seats EVERY book — the cluster is
     *  usually empty now). Pinned books are skipped too: placing one must not shove
     *  the cluster (and it) across the floor. */
    localBounds(target = new THREE.Box3()) {
        target.makeEmpty();
        const tmp = new THREE.Box3();
        for (const lane of this.lanes.values()) {
            if (lane.book.parent !== this.root || lane.pinned) continue;
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

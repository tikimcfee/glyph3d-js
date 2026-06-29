/**
 * AgentTrail — an agent's run laid out as a spatial corridor, composed with the stack DSL.
 *
 * Every action leaves a MOMENT — a `VStack([actionRow, HStack([infoCol, parseCol…])])`: the
 * action headline on top, its info + parse-mapping columns directly below, bounds-aligned.
 * Moments deck into depth via a reverse `ZStack` (time = Z,
 * newest in front, history recedes — fly and look past). Concurrent agents are an outer
 * `HStack` of corridors. The whole layout (gaps, alignment, sizing) is the DSL's job; this
 * file just builds the tree and re-runs `.layout()` when content settles.
 *
 * PER-TURN SNAPSHOTS (not dedup): each action renders its OWN copy of the file's content
 * AS IT WAS at that moment — a re-read after an edit shows the new content, so the trail is
 * a faithful changelog of state over time. They share the file only as an ORIGIN (the
 * provider); the rendered grids are independent. Content is fetched at the moment of the
 * action (correct for live watching; faithful replay would capture content in the record).
 *
 * Fed by FieldVisitorManager.onActivity (one payload per record). The hook stream carries both the
 * agent's TOOL CALLS and its CONVERSATION — `text` blocks deck as `say` moments, `thinking` blocks
 * as `think` moments (read off the transcript and forwarded just ahead of the tool they led to). So
 * the corridor reads as a faithful forward of the run: reasoning, speech, and action interleaved in
 * time. Grouping a turn's moments into per-turn SHEETS (the blueprint-volume model) is the next step.
 */

import * as THREE from 'three';
import CodeGrid from './CodeGrid.js';
import FrameGrid from './FrameGrid.js';
import ConnectionRenderer from '../annotations/ConnectionRenderer.js';
import { HStack, VStack, ZStack } from './layouts/StackContainer.js';
import { RENDER_ORDER } from '../core/renderOrder.js';
import { classifyByExtension } from '../core/fileKind.js';
import { decorateForAction } from './toolRegistry.js';

export const TRAIL_DEFAULTS = {
    zPitch: 90,                 // ZStack deck pitch between moments (time depth) — fly-through room
    pagerLerp: 9,               // rolodex carousel: per-card z-slot easing rate (higher = snappier); driven by update(dt)
    rowGap: 10,                 // VStack gap inside a moment: action headline → its info/parse columns
    colGap: 20,                 // HStack gap between a moment's columns (info, then parse-mapping(s))
    corridorGap: 120,           // HStack gap between concurrent agents' corridors
    align: 0,                   // corridor cross-align: 0 = leading edge (tiny calls + big stacks share a left edge)
    columnAlign: false,         // ON → size the body columns down the deck (widest info, widest parse) so the aisle reads as a table
    callScale: 3.0,             // gridScale for the action headline — the readable HEADLINE (big glyphs, few lines)
    infoScale: 1.5,             // gridScale for the info column — readable, subordinate to the action headline
    artifactWorldScale: 0.025,  // worldScale for parse-mapping (snapshot) cards (fine-print document you fly into)
    messageScale: 0.05,         // worldScale for say/think conversation cards — its OWN knob (prose is meant to read bigger than a fine-print artifact)
    snapshotImageWidth: 40,     // world width of an image snapshot quad (height follows aspect)
    maxConnections: 512,        // tether budget
    showTethers: true,          // draw a call→snapshot beam per moment
    highlightFillOpacity: 0.22, // opacity of a decorate FILL bar (the touched block's background) — 0 falls back to additive tint
    debug: false,               // ON → log the decoration decision per snapshot (trail.config debug true)

    // Corridor identity — a translucent colored box around each agent's deck (the
    // ContentTreeMarkers dir-prism recipe, per-AGENT hue instead of depth-gradient).
    // Parented INTO the corridor so it rides every transform; sized to the deck's
    // bounds on each relayout, so it GROWS as moments append — a 3D window of what's
    // happening, and the frame the rolodex carousel rotates its cards through.
    corridorBox: true,          // draw the per-agent identity box
    corridorPad: 16,            // XY inflation beyond the deck's content bounds
    corridorZPad: 24,           // Z inflation (front of newest / behind oldest)
    corridorBoxOpacity: 0.06,   // translucent fill — identity tint, never occlusion
    corridorEdgeOpacity: 0.22,  // wireframe frame line (0 = no edges)
    corridorPalette: [          // per-agent identity hues, indexed by corridor order
        0x3a6ea5, 0xa56a3a, 0x4a9a6a, 0x8a5aa5, 0xa54a5a, 0x5a8aa5,
    ],

    hues: {
        read:   { r: 0.35, g: 0.66, b: 0.92 },
        search: { r: 0.70, g: 0.50, b: 0.85 },
        edit:   { r: 0.90, g: 0.66, b: 0.36 },
        write:  { r: 0.90, g: 0.66, b: 0.36 },
        run:    { r: 0.44, g: 0.76, b: 0.46 },
        say:    { r: 0.92, g: 0.94, b: 0.98 },   // near-white — the agent SPEAKING (its reply to you)
        think:  { r: 0.58, g: 0.52, b: 0.78 },   // dim violet — interior REASONING (the thinking turns)
        other:  { r: 0.62, g: 0.64, b: 0.68 },
    },
};

const READ_RE   = /^(read|cat|view|open)$/;
const SEARCH_RE = /^(grep|search|glob|rg|find|ls)$/;
const EDIT_RE   = /^(edit|write|multiedit|notebookedit|create)$/;
const RUN_RE    = /^(bash|run|shell|exec|task)$/;
const SAY_RE    = /^(say|text|message)$/;
const THINK_RE  = /^(think|thinking|reason)$/;

function classify(action) {
    const a = String(action || '').toLowerCase();
    if (SAY_RE.test(a)) return 'say';
    if (THINK_RE.test(a)) return 'think';
    if (READ_RE.test(a)) return 'read';
    if (SEARCH_RE.test(a)) return 'search';
    if (EDIT_RE.test(a)) return 'edit';
    if (RUN_RE.test(a)) return 'run';
    return 'other';
}

const fmtNum = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K' : String(n));
const fmtBytes = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : b + ' B');

/** A terse summary of an action's structured meta (lines read/written, +/−, tokens…), one item
 *  per `sep` — ' · ' for a one-line subtitle, '\n' to stack as rows in the info column. */
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

function fmtAction(rec) {
    // The action headline's BODY: what the agent did and to what — target path and/or command/args.
    // The numeric meta lives in the info column; the result lives in the parse column. One home each.
    return [rec.target, rec.detail].filter(Boolean).join('\n');
}


export default class AgentTrail {
    constructor(ctx, opts = {}) {
        this.ctx = ctx;
        this.scene = ctx.scene;
        this.atlas = ctx.atlas;
        this.cfg = { ...TRAIL_DEFAULTS, ...opts, hues: { ...TRAIL_DEFAULTS.hues, ...(opts.hues || {}) } };

        this.root = new HStack({ spacing: this.cfg.corridorGap });   // corridors side by side
        this.root.name = 'agent-trail';
        this.scene.add(this.root);
        this._rootPlaced = false;

        this.conn = new ConnectionRenderer(this.scene, { maxConnections: this.cfg.maxConnections });
        this.lanes = new Map();   // agentId -> { corridor:ZStack, seq, moments:[...], box, hueIdx }
        // Moment cards register as a pickable 'trail.card' so they hover-highlight (the CodeGrid
        // panel rides the 'grid' pick channel) and a click can focus the moment. Mark the type
        // pickable BEFORE any register() — SceneRegistry only adds an entry to the pickable set if
        // its type is already known (SceneRegistry register():68).
        this.ctx.registry?.setPickable?.('trail.card');
        this._off = null;
        this._tmp = new THREE.Vector3();

        // Rolodex pager. When docked, one corridor's deck slides so the FOCUSED moment sits at a
        // fixed front plane (where the newest normally rests) and the rest window out — older recede
        // behind it, newer (scrolled-past) hide. null = undocked (the natural full deck). The focus is
        // a moments[] INDEX (0 = oldest). Applied at the tail of every _relayout, so it survives append.
        this._pager = null;

        // Shared unit geometry for the corridor identity boxes (scaled per corridor).
        this._unitBox = new THREE.BoxGeometry(1, 1, 1);
        this._unitEdges = new THREE.EdgesGeometry(this._unitBox);
    }

    attach(mgr) {
        this._off = mgr?.onActivity?.((p) => {
            try { this.ingest(p); } catch (e) { console.warn('[AgentTrail] ingest failed', e); }
        });
        return this;
    }

    /** One activity record → a moment (action headline over its info/parse columns) decked into the corridor. */
    ingest({ agentId, record } = {}) {
        if (!record) return;
        if (!this._rootPlaced) this._placeRootInView();

        const lane = this._lane(agentId);
        const hue = this.cfg.hues[classify(record.action)] || this.cfg.hues.other;

        // One home each: the call card holds the action's INPUT (target / command); the RESULT
        // lives in a sibling. A file's content is its snapshot; a no-target action's output
        // (bash/grep/…) becomes its own output grid. The output is EPHEMERAL (no path to re-read),
        // so it rides the record raw — the grid's layout system splits/lays it out, not us.
        const pullOutput = !record.target && !!record.result;

        // Identity for THIS moment: the action headline and its column cards all register under the
        // same momentId so a click on any of them focuses the one moment (action + info + parse).
        const seq = lane.seq;
        const momentId = `trail:moment:${agentId}:${seq}`;
        const actionId = `${momentId}:action`;
        const infoId = `${momentId}:info`;
        const snapId = `${momentId}:snap`;
        const meta = { agentId, seq, momentId, record };

        // ROW 0 — the agent's ACTION: a readable headline, `[verb]` over its target/command.
        const action = this._card(`[${record.action || 'act'}]`, fmtAction(record),
            { gridScale: this.cfg.callScale, textColor: hue }, { id: actionId, meta: { ...meta, kind: 'action' } });

        // ROW 1 — the COLUMNS below, left→right: INFO (terse numeric meta) then the PARSE
        // MAPPING(s) (the file/output snapshot the action touched). Built into `columns`.
        const columns = [];

        const infoText = fmtMeta(record.meta, '\n');
        let info = null;
        if (infoText) {
            info = this._card('info', infoText, { gridScale: this.cfg.infoScale, textColor: hue, showFilename: false },
                { id: infoId, meta: { ...meta, kind: 'info' } });
            columns.push(info);
        }

        // snapScaleKey names the cfg knob that drives this body card's worldScale, so applyScales can
        // re-size it live (an image sizes by width, not a worldScale — left null; new image moments
        // pick up the width).
        let snapshot = null, hasSnapPick = false, snapScaleKey = null;
        if (record.target) {
            // A snapshot is whatever the target file IS, as-of now: an image renders as a frame,
            // everything else as a text/hex card (same classifier as file.open — [[fileLoader]]).
            const kind = classifyByExtension(record.target);
            if (kind?.kind === 'image') {
                snapshot = this._imageSnapshot(record.target, kind.format);   // image picking = a follow-on (FrameGrid)
            } else {
                snapshot = this._makeGrid(record.target, { worldScale: this.cfg.artifactWorldScale });
                snapScaleKey = 'artifactWorldScale';
                this._loadSnapshot(snapshot, record, { id: snapId, meta: { ...meta, kind: 'snap' } });   // ONE fetch + load, decorate, then register
                hasSnapPick = true;
            }
            columns.push(snapshot);
        } else if (pullOutput) {
            snapshot = this._outputSnapshot(record, { id: snapId, meta: { ...meta, kind: 'snap' } });   // the command's output as a sibling grid
            snapScaleKey = (record.action === 'say' || record.action === 'think') ? 'messageScale' : 'artifactWorldScale';
            columns.push(snapshot);
            hasSnapPick = true;
        }

        // VStack{ action, HStack{ info, parse… } } — the action headline on top, its columns below
        // (the body HStack is omitted when the action produced no columns). align 0 → shared left edge.
        const body = columns.length ? new HStack({ spacing: this.cfg.colGap, children: columns }) : null;
        const moment = new VStack({ spacing: this.cfg.rowGap, align: 0, children: body ? [action, body] : [action] });
        lane.corridor.add(moment);
        const tetherId = snapshot ? `tether:${agentId}:${seq}` : null;
        // record + ts ride the entry so the 2D moment-stream panel (getStream) can list rows without
        // re-deriving them, and the pager can timestamp the deck.
        lane.moments.push({ moment, body, action, info, snapshot, snapScaleKey, hue, tetherId, actionId, infoId: info ? infoId : null, snapId: hasSnapPick ? snapId : null, record, ts: this._now() });
        // BIND the tether to the action card and its parse mapping — it resolves their world
        // positions each frame, so it follows layout, scroll, and corridor drags with no re-tether.
        if (tetherId) this.conn.set(tetherId, action, snapshot, hue);
        lane.seq++;
        // LIVE-FOLLOW: if the pager is parked on this corridor's newest moment, ride the new arrival to
        // the front (watch the run stream in). If the user scrolled back to inspect history, hold there.
        if (this._pager?.agentId === agentId && this._pager.focus >= lane.moments.length - 2) {
            this._pager.focus = lane.moments.length - 1;
        }
        // Seat the new card directly at its carousel slot so it appears in place (no one-frame flash at the
        // ZStack's order position); the existing cards keep their _z and ease to their shifted slots.
        this._seatMoment(lane, agentId, lane.moments.length - 1);
        this._relayout();
    }

    /** Point the THREE camera at a corridor (best-effort; the controller may reclaim it). */
    focus(agentId) {
        const lane = agentId ? this.lanes.get(agentId) : this.lanes.values().next().value;
        const cam = this.ctx.camera;
        if (!lane || !cam) return false;
        const box = lane.corridor.getBounds();
        if (box.isEmpty()) return false;
        const c = box.getCenter(new THREE.Vector3());
        const s = box.getSize(this._tmp);
        const dist = Math.max(s.x, s.y, s.z, 10) * 1.1 + 25;
        cam.position.set(c.x, c.y, box.max.z + dist);
        cam.lookAt(c.x, c.y, c.z);
        return true;
    }

    update(dt) { this._animateDeck(dt); this.conn.refresh(); }

    _now() { return typeof performance !== 'undefined' ? performance.now() : 0; }

    // -- rolodex carousel: the head index is the only state; every card's depth is a derived slot --------
    //
    // The deck is a circular sequence whose FRONT slot is whatever moment the head (`focus`) points at;
    // the rest fall out behind it by `slot(i) = (focus - i) mod n` — older recede, and the scrolled-past
    // newer ones wrap to the very back (a drawer of sheets: move the front one back to reach the next).
    // Paging only moves the head; slots recompute and each card EASES from its old z to its new one in
    // `update(dt)` (the motion is the navigation). The array order never changes — it's the timeline.

    /**
     * Dock a corridor into the carousel: park the head on its newest moment and frame the camera on the
     * front slot ONCE. No arg (or an unknown id) docks the first corridor. From here paging moves cards,
     * not the camera. Returns false if there's nothing to show.
     */
    dock(agentId) {
        let id = agentId, lane = id ? this.lanes.get(id) : null;
        if (!lane) { const first = this.lanes.entries().next().value; if (first) [id, lane] = first; }
        if (!lane || !lane.moments.length) return false;
        this._pager = { agentId: id, focus: lane.moments.length - 1 };
        this._relayout();
        this._frameFocus();    // the one camera move: frame the front slot; scrubbing holds it
        return true;
    }

    /** Leave the carousel — the deck eases back to its natural newest-at-front recede (head = newest). */
    undock() {
        if (!this._pager) return false;
        this._pager = null;
        return true;   // _animateDeck retargets to the natural order and eases there; no snap
    }

    /** Scrub the docked corridor by `delta` moments (− older / back in time, + newer). */
    scroll(delta) { return this.pageTo((this._pager?.focus ?? 0) + (Number(delta) || 0)); }

    /** Move the head to a specific moment index (0 = oldest, clamped). The cards ease; the camera holds. */
    pageTo(index) {
        const p = this._pager;
        if (!p) return false;
        const lane = this.lanes.get(p.agentId);
        if (!lane || !lane.moments.length) return false;
        p.focus = Math.min(Math.max(0, Math.round(index)), lane.moments.length - 1);
        return true;   // no relayout, no camera move — _animateDeck eases the slots toward the new head
    }

    /** The pager's current state (for the panel), or null when undocked. */
    pagerState() {
        const p = this._pager;
        if (!p) return null;
        const lane = this.lanes.get(p.agentId);
        return { agentId: p.agentId, focus: p.focus, count: lane ? lane.moments.length : 0 };
    }

    /** The corridors present, for a panel's agent selector — id + moment count + identity hue index. */
    agents() {
        return [...this.lanes.entries()].map(([id, l]) => ({ id, count: l.moments.length, hueIdx: l.hueIdx }));
    }

    /**
     * A corridor's moment stream as terse rows (oldest first), for the 2D moment-stream panel: each row
     * is { index, action, kind, label, ts, focused } — enough to render a clickable log without the
     * panel reaching into the scene graph. `focused` flags the row the pager is parked on.
     */
    getStream(agentId) {
        const lane = this.lanes.get(agentId);
        if (!lane) return [];
        const focus = this._pager?.agentId === agentId ? this._pager.focus : null;
        return lane.moments.map((e, j) => ({
            index: j,
            action: e.record?.action || 'act',
            kind: classify(e.record?.action),
            label: [e.record?.target, e.record?.detail].filter(Boolean).join(' · '),
            ts: e.ts,
            focused: j === focus,
        }));
    }

    /**
     * Re-apply the current cfg SCALES to the whole live trail — the one entry the `trail.config` verb
     * and the Settings rows both route through, so dialing any 'card size' updates every existing
     * moment, not just new ones. The gridScale cards (action HEADLINE + info column) re-scale directly
     * via setScale. The worldScale body cards (snapshot / output / say-think) bake their glyph layout
     * at build, so a uniform transform re-sizes them: the desired worldScale ÷ the one baked into the
     * card. config.worldScale never moves (setScale drives gridScale), so this stays correct across
     * repeated tweaks; an image card (no config.worldScale) is left alone. Then re-flow so the new
     * footprints re-pack and the tethers follow.
     */
    applyScales() {
        for (const lane of this.lanes.values()) {
            for (const e of lane.moments) {
                e.action?.setScale?.(this.cfg.callScale);
                e.info?.setScale?.(this.cfg.infoScale);
                if (e.snapScaleKey && typeof e.snapshot?.setScale === 'function') {
                    const built = e.snapshot.config?.worldScale;
                    const target = this.cfg[e.snapScaleKey];
                    if (built > 0 && target > 0) e.snapshot.setScale(target / built);
                }
            }
        }
        this._relayout();
    }

    clear(which = 'all') {
        const kill = (lane) => {
            for (const e of lane.moments) {
                if (e.tetherId) this.conn.remove(e.tetherId);
                for (const id of [e.actionId, e.infoId, e.snapId]) { if (id) { try { this.ctx.registry?.unregister?.(id); } catch (_e) { /* best effort */ } } }
                for (const g of [e.action, e.info, e.snapshot]) {
                    if (!g) continue;
                    try { this.ctx.pickingSystem?.unregister?.('grid', g._background); } catch (_e) { /* best effort */ }
                    try { g.parent?.remove(g); g.dispose?.(); } catch (_e) { /* best effort */ }
                }
                try { lane.corridor.remove(e.moment); } catch (_e) { /* best effort */ }
            }
            if (lane.groupId) { try { this.ctx.registry?.unregister?.(lane.groupId); } catch (_e) { /* best effort */ } }
            if (lane.box) {
                try { this.ctx.pickingSystem?.unregister?.('group', lane.box.mesh); } catch (_e) { /* best effort */ }
                try { lane.box.mesh.parent?.remove(lane.box.mesh); lane.box.fill.dispose(); lane.box.edge.dispose(); } catch (_e) { /* best effort */ }
            }
            this.root.remove(lane.corridor);
        };
        if (!which || which === 'all') {
            for (const lane of this.lanes.values()) kill(lane);
            this.lanes.clear();
            this._rootPlaced = false;
            this.root.layout();
            return;
        }
        const lane = this.lanes.get(which);
        if (lane) { kill(lane); this.lanes.delete(which); this._relayout(); }
    }

    dispose() {
        this._off?.();
        this.clear('all');
        this.conn.dispose();
        this.scene.remove(this.root);
        this._unitBox.dispose();
        this._unitEdges.dispose();
    }

    // -- private --------------------------------------------------------

    _lane(agentId) {
        let lane = this.lanes.get(agentId);
        if (!lane) {
            const corridor = new ZStack({ spacing: this.cfg.zPitch, reverse: true, align: this.cfg.align });   // newest in front, leading-aligned
            corridor.name = `trail:${agentId}`;
            this.root.add(corridor);
            const hueIdx = this.lanes.size;
            const box = this._makeCorridorBox(this.cfg.corridorPalette[hueIdx % this.cfg.corridorPalette.length]);
            corridor.add(box.mesh);   // parented IN → rides transforms; isMarker → StackContainer.layout skips it
            lane = { corridor, seq: 0, moments: [], box, hueIdx, groupId: `trail:group:${agentId}`, pinned: false, pinnedPos: null };
            this.lanes.set(agentId, lane);
            this._registerGroup(lane);
        }
        return lane;
    }

    /**
     * Make a corridor a draggable GROUP. The identity box is the pick HANDLE: registered on
     * the 'grid' channel with the corridor NODE as its token, and the corridor itself is a
     * registry entry of type 'trail.group'. So a hover-pick of the box resolves (getIdByGrid)
     * to this entry → ObjectDragger Ctrl-drags entry.grid (the node) → the whole deck follows
     * by parenting. Release routes through trail.move (ephemeral — no workspace persistence).
     */
    _registerGroup(lane) {
        this.ctx.registry?.register?.(lane.groupId, lane.corridor, { type: 'trail.group' });
        const ps = this.ctx.pickingSystem;
        if (!ps) return;
        Promise.resolve(ps._tslReady).then(() => {
            try { ps.register('group', lane.box.mesh, lane.corridor); }   // own channel: cards (grid) out-pick the box
            catch (e) { console.warn('[AgentTrail] group pick register failed', e); }
        });
    }

    /**
     * Pin a corridor to a user position (drag-release / CLI). Once grabbed it's USER-PLACED —
     * `_relayout` flows the other corridors around it instead of re-snapping it to its slot.
     */
    moveGroup(id, x, y, z) {
        const lane = [...this.lanes.values()].find((l) => l.groupId === id);
        if (!lane) return false;
        lane.pinned = true;
        lane.pinnedPos = new THREE.Vector3(x, y, z);
        lane.corridor.position.copy(lane.pinnedPos);
        return true;   // the bound tethers follow the corridor on the next refresh()
    }

    /** A translucent identity box + wireframe frame, in the ContentTreeMarkers prism style. */
    _makeCorridorBox(colorHex) {
        const color = new THREE.Color(colorHex);
        const fill = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: this.cfg.corridorBoxOpacity, depthWrite: false, side: THREE.DoubleSide });
        const edge = new THREE.LineBasicMaterial({ color, transparent: true, opacity: this.cfg.corridorEdgeOpacity, depthWrite: false });
        const mesh = new THREE.Mesh(this._unitBox, fill);
        mesh.userData = { isMarker: true };
        mesh.renderOrder = RENDER_ORDER.BACKDROP_BASE;
        const edges = new THREE.LineSegments(this._unitEdges, edge);
        edges.userData = { isMarker: true };
        edges.renderOrder = RENDER_ORDER.BACKDROP_BASE;
        mesh.add(edges);   // edges inherit the mesh's scale/position
        return { mesh, edges, fill, edge };
    }

    /** Size each corridor's identity box to its deck bounds — it grows as moments append. */
    _updateCorridorBoxes() {
        const c = this.cfg;
        const size = new THREE.Vector3(), center = new THREE.Vector3();
        for (const lane of this.lanes.values()) {
            const box = lane.box;
            if (!box) continue;
            const b = lane.corridor.layoutBounds();
            if (!c.corridorBox || lane.moments.length === 0 || b.isEmpty()) { box.mesh.visible = false; continue; }
            b.getSize(size); b.getCenter(center);
            // X/Y come from the laid-out content, but the cards live at the carousel slots (front anchored
            // at z=0, back at -(n-1)·zPitch) — not the ZStack's order Z — so override the box's Z span to
            // wrap where the cards actually are.
            const span = (lane.moments.length - 1) * c.zPitch;
            center.z = -span / 2; size.z = span;
            box.mesh.position.copy(center);
            box.mesh.scale.set(size.x + 2 * c.corridorPad, size.y + 2 * c.corridorPad, size.z + 2 * c.corridorZPad);
            box.mesh.visible = true;
            box.fill.opacity = c.corridorBoxOpacity;   // re-read so trail.config tunes live
            box.edge.opacity = c.corridorEdgeOpacity;
            box.edges.visible = c.corridorEdgeOpacity > 0;
        }
    }

    /** A bare CodeGrid (no content yet) — the caller drives the single load. */
    _makeGrid(filename, opts) {
        return new CodeGrid(this.scene, this.atlas, { name: `trail:${filename}`, showFilename: true, showBackground: true, ...opts });
    }

    /** A free CodeGrid card with content; re-layouts once its bounds settle, and (if `pick` given)
     *  registers it as a pickable moment card AFTER load (so its panel exists — see _wireCardPick). */
    _card(filename, body, opts, pick) {
        const grid = this._makeGrid(filename, opts);
        grid.loadFileAsync(filename, body)
            .then(() => { if (pick) this._wireCardPick(grid, pick.id, pick.meta); this._relayout(); })
            .catch(() => { /* render best-effort */ });
        return grid;
    }

    /**
     * Register a LOADED moment card as a pickable 'trail.card' registry entry. Its background panel
     * rides the 'grid' pick channel (FramedGlyphField.setPickingSystem, wired by CanvasInteraction's
     * registry-change sweep), so getIdByGrid resolves it → hover-highlight + click-to-focus-the-moment.
     * MUST run after load: _background (the pick panel) is created lazily in _updateBackground, so an
     * earlier register would let the sweep mark the grid wired before the panel exists.
     * @private
     */
    _wireCardPick(grid, id, meta) {
        if (!grid || typeof grid.setPickingSystem !== 'function') return;   // e.g. image FrameGrid — skip for now
        try { this.ctx.registry?.register?.(id, grid, { type: 'trail.card', ...meta }); }
        catch (e) { console.warn('[AgentTrail] card pick register failed', e); }
    }

    /**
     * Per-action OUTPUT snapshot: a command's result (bash/grep/…) as a sibling text grid — the
     * command headlines the call card, this is what it produced. Unlike a file the output is
     * EPHEMERAL (no path to re-read), so it comes straight from the record. Ships RAW — the grid's
     * layout system does the line-splitting and any framing; nothing is truncated here.
     */
    _outputSnapshot(record, pick) {
        // The output ONLY — the command lives on the call card, never echoed here (one home each).
        // A say/think moment carries prose, not command output: name its card for what it is so the
        // fly-in body reads 'said'/'thinking', not 'output', and size it by the message scale (its own
        // knob — conversation reads bigger than a fine-print artifact). Other outputs keep the artifact scale.
        const isMessage = record.action === 'say' || record.action === 'think';
        const name = record.action === 'say' ? 'said' : record.action === 'think' ? 'thinking' : 'output';
        const worldScale = isMessage ? this.cfg.messageScale : this.cfg.artifactWorldScale;
        return this._card(name, String(record.result ?? ''), { worldScale }, pick);
    }

    /** Per-action snapshot: the file's content AS-OF this moment (loaded ONCE), with touched lines lit
     *  up; registers as a pickable moment card after load (if `pick` given). */
    _loadSnapshot(grid, record, pick) {
        const path = record.target;
        const wire = () => { if (pick) this._wireCardPick(grid, pick.id, pick.meta); };
        Promise.resolve(this.ctx.fileProvider?.getFile?.(path))
            .then((content) => this._resolveSnapshotText(path, String(content ?? '')))
            .then((text) => grid.loadFileAsync(path, text))
            .then(() => { this._decorateSnapshot(grid, record); wire(); this._relayout(); })
            .catch(() => grid.loadFileAsync(path, '(could not load)').then(() => { wire(); this._relayout(); }).catch(() => {}));
    }

    /**
     * Guard against an EMPTY live read. getFile reads from DISK at the moment the moment builds,
     * which races a concurrent agent writing the same file: a truncate→write leaves a 0-byte
     * window, so the read comes back '' — a SUCCESS, not an error, so the '(could not load)'
     * fallback never fires and the snapshot collapses to a bare filename card. (This used to be
     * masked by the old '…' placeholder double-load; the single-load path unmasked it.)
     *
     * On an empty read, prefer the file's OPEN grid content — what's on screen, immune to the
     * write window — then re-read once after a beat (the window is milliseconds, so the retry
     * almost always lands the finished write). A genuinely-empty file just stays empty (harmless).
     * The faithful end-state is to carry the content the agent actually read IN THE RECORD (see the
     * file header TODO) — this keeps live watching honest until then.
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

    /** The in-memory content of `path` if it's currently open as a grid (immune to a concurrent
     *  writer's truncate window), else null. Matches file.open's path→uri convention. */
    _openGridContent(path) {
        const uri = `file:///${String(path).replace(/^\/+/, '')}`;
        const open = this.ctx.registry?.findByMeta?.('sourcePath', uri) || [];
        const g = open[0]?.grid;
        return (g && typeof g.content === 'string' && g.content.length) ? g.content : null;
    }

    /**
     * Light up the lines an action touched on its loaded snapshot — the mapping from the action to
     * the content. Edits fill their added lines green; a partial read fills its slice blue. A
     * directive's `fill` flag becomes a background-fill BAR at cfg.highlightFillOpacity (the touched
     * block reads as a filled region); a non-fill directive falls back to an additive glyph tint.
     * Directives come from the shared tool registry (decorateForAction), applied via highlightRange.
     * Runs AFTER the single load resolves (the layout/slots exist), clamped to the rendered range.
     */
    _decorateSnapshot(grid, record) {
        const dbg = this.cfg.debug ? (msg) => console.log(`[trail.decorate] ${record.action} ${record.target || ''} — ${msg}`) : null;
        const directives = decorateForAction(record.action, record.meta);
        if (!directives) {
            // The two distinct silent-return reasons, so the log says WHICH: no meta reached the
            // record (data flow) vs meta present but this action/shape decorates nothing (by design).
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
     * Per-action IMAGE snapshot: a single-cell FrameGrid sampling the file's pixels AS-OF now —
     * an empty quad placed immediately (so the moment lays out), filled async once the bytes
     * decode. Shares FrameGrid.textureFromImageBytes + provider.getBytes with file.open's image
     * path; cols:1/rows:1 keeps it one quad over a full-res texture (never pixel-dim cells).
     */
    _imageSnapshot(path, format) {
        const grid = new FrameGrid(this.scene, this.atlas, { name: `trail:${path}`, cols: 1, rows: 1, width: this.cfg.snapshotImageWidth });
        Promise.resolve(this.ctx.fileProvider?.getBytes?.(path))
            .then((bytes) => bytes && FrameGrid.textureFromImageBytes(bytes, format))
            .then((res) => {
                if (res) {
                    grid.setFrameTexture(res.texture);
                    if (res.width > 0 && res.height > 0) grid.setAspect(res.width / res.height);
                }
                this._relayout();
            })
            .catch(() => this._relayout());
        return grid;
    }

    /** Widest cell-i across a lane's body HStacks → a shared column track (info col, parse col, …),
     *  so columns line up down the deck. null when there are no bodies. @private */
    _bodyColumnTrack(bodies) {
        const track = [];
        for (const body of bodies) {
            const exts = body.childExtents('x');
            for (let i = 0; i < exts.length; i++) if (!(exts[i] <= track[i])) track[i] = exts[i];   // NaN/undefined-safe max
        }
        return track.length ? track : null;
    }

    /** Re-run the whole stack tree (idempotent) and refresh the tethers off the new positions. */
    _relayout() {
        // cfg is the LIVE source of truth — push current spacing/align into the containers so
        // `trail.config` re-flows the existing trail, not just newly-added moments.
        this.root.spacing = this.cfg.corridorGap;
        for (const lane of this.lanes.values()) {
            lane.corridor.spacing = this.cfg.zPitch;
            lane.corridor.align = this.cfg.align;
            lane.corridor.columnAlign = false;   // moments are VStacks now — columns live one level down, in the body HStacks
            // Harmonize the body columns DOWN the deck so info/parse line up as a table: a per-corridor
            // track (widest info cell, widest parse cell across this lane) stamped as each body's fixed
            // columnWidths. childExtents reads each cell's own content box (layout-independent), so the
            // normal single layout pass picks it up via body.layout()'s columnWidths default. OFF → clear
            // the track (ragged). NOTE: assumes a consistent column ORDER across moments (info, then
            // parse) — a moment missing the info column shifts its parse into slot 0; placeholder slots
            // are a follow-on if that bites.
            const bodies = lane.moments.map((e) => e.body).filter(Boolean);
            const track = this.cfg.columnAlign ? this._bodyColumnTrack(bodies) : null;
            for (const body of bodies) body.columnWidths = track;
            for (const e of lane.moments) {
                e.moment.spacing = this.cfg.rowGap;
                if (e.body) e.body.spacing = this.cfg.colGap;
            }
        }
        this.root.layout();
        for (const lane of this.lanes.values()) {
            // A pinned (user-dragged) corridor keeps its placed position; otherwise anchor the deck's
            // FRONT slot at the corridor origin (z=0) so it never drifts as moments append — the carousel
            // reads the front as a fixed world plane the camera frames once. The HStack still owns X
            // (corridors side by side); we only pin Z.
            if (lane.pinned && lane.pinnedPos) lane.corridor.position.copy(lane.pinnedPos);
            else lane.corridor.position.z = 0;
            // The animator owns each card's depth — re-assert it so the ZStack's order-layout (which just
            // ran) can't jolt an in-progress rotation. A brand-new card (no _z yet) keeps its laid z for
            // the one frame until _animateDeck seats it.
            for (const e of lane.moments) if (e._z != null) e.moment.position.z = e._z;
        }
        this._updateCorridorBoxes();
        this.conn.setVisible(this.cfg.showTethers);   // positions are bound; this just toggles the beam
    }

    /** The local Z a moment should rest at for the current head: `slot(i) = (focus - i) mod n`, front=0. */
    _slotZ(lane, id, i) {
        const n = lane.moments.length;
        const focus = this._pager?.agentId === id ? this._pager.focus : n - 1;   // undocked head = newest
        const slot = ((focus - i) % n + n) % n;
        return -slot * this.cfg.zPitch;
    }

    /** Seat moment `i` directly at its slot (no easing) — used when a card first appears so it doesn't
     *  flash at the ZStack's order position before the animator claims it. */
    _seatMoment(lane, id, i) { lane.moments[i]._z = this._slotZ(lane, id, i); }

    /**
     * The carousel animator, run every frame off update(dt). For each corridor it eases every card's local
     * Z toward its derived slot (front = head, the rest cascading behind, the scrolled-past ones wrapped to
     * the back). Frame-rate-independent: `1 - e^(-rate·dt)`. Runs docked AND undocked — undocked the head is
     * the newest, so the targets are just the natural recede and a settled deck is a no-op (skips the write
     * once within ε, so a static trail doesn't dirty matrices every frame).
     * @private
     */
    _animateDeck(dt) {
        const rate = this.cfg.pagerLerp;
        const k = rate > 0 ? 1 - Math.exp(-rate * Math.min(Math.max(dt || 0, 0), 0.1)) : 1;
        for (const [id, lane] of this.lanes) {
            const n = lane.moments.length;
            if (!n) continue;
            for (let i = 0; i < n; i++) {
                const e = lane.moments[i];
                const target = this._slotZ(lane, id, i);
                if (e._z == null) e._z = target;                                  // first sight: snap into place
                else if (Math.abs(target - e._z) < 0.05) { if (e._z !== target) { e._z = target; e.moment.position.z = target; } continue; }
                else e._z += (target - e._z) * k;
                e.moment.position.z = e._z;
            }
        }
    }

    /**
     * Frame the focused moment through the shared camera focus — flown by the controller's flyTo, so it
     * neither fights the soft-bounds nor needs us to compute "where to look". Frame the WHOLE moment's box
     * (headline + body, squared down +Z — the deck is axis-aligned) for a roomy view, but ONLY when that box
     * is finite and non-degenerate: the moment is a StackContainer with no local bounds, and its AABB can
     * momentarily come back empty/zero-sized, which would fly the camera to a NaN pose (a blank viewport).
     * In that case fall back to the ACTION card — a real grid with getLocalBounds, always safe. Called ONCE
     * on dock: the front slot is a fixed world plane (the deck is anchored, cards rotate through it), so
     * paging never re-frames.
     */
    _frameFocus() {
        const e = this._pager && this.lanes.get(this._pager.agentId)?.moments?.[this._pager.focus];
        if (!e) return;
        const cc = this.ctx.cameraController;
        const box = e.moment?.getBounds?.();
        if (this._finiteBox(box)) cc?.focusOnBox?.(box);
        else if (e.action) cc?.focusOnObject?.(e.action);
    }

    /** A world AABB safe to frame: present, non-empty, all-finite, and a real (non-degenerate) footprint. */
    _finiteBox(b) {
        if (!b || b.isEmpty?.()) return false;
        const ok = [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].every(Number.isFinite);
        return ok && (b.max.x - b.min.x) > 1e-3 && (b.max.y - b.min.y) > 1e-3;
    }

    /** Drop the corridor root in front of the camera once, so the trail builds in view. */
    _placeRootInView() {
        this._rootPlaced = true;
        const cam = this.ctx.camera;
        if (!cam) return;
        const fwd = cam.getWorldDirection(this._tmp).clone();
        const dist = Math.max(cam.position.length() * 0.5, 60);
        this.root.position.copy(cam.position).addScaledVector(fwd, dist);
    }
}

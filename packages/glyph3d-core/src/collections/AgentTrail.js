/**
 * AgentTrail — an agent's run laid out as a spatial corridor, composed with the stack DSL.
 *
 * Every action leaves a MOMENT — an `HStack([callCard, snapshotCard])`, the call beside the
 * file it touched, bounds-aligned. Moments deck into depth via a reverse `ZStack` (time = Z,
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
 * Fed by FieldVisitorManager.onActivity (one payload per record). Today's hook stream is
 * tool-calls only — grouping moments into per-turn SHEETS (the blueprint-volume model) is a
 * follow-on once turn boundaries are forwarded.
 */

import * as THREE from 'three';
import CodeGrid from './CodeGrid.js';
import FrameGrid from './FrameGrid.js';
import ConnectionRenderer from '../annotations/ConnectionRenderer.js';
import { HStack, ZStack } from './layouts/StackContainer.js';
import { RENDER_ORDER } from '../core/renderOrder.js';
import { classifyByExtension } from '../core/fileKind.js';
import { decorateForMeta } from './toolMeta.js';

export const TRAIL_DEFAULTS = {
    zPitch: 90,                 // ZStack deck pitch between moments (time depth) — fly-through room
    railGap: 20,                // HStack gap between a call and its snapshot
    corridorGap: 120,           // HStack gap between concurrent agents' corridors
    align: 0,                   // corridor cross-align: 0 = leading edge (tiny calls + big stacks share a left edge)
    callScale: 3.0,             // gridScale for call cards — the readable HEADLINE (big glyphs, few lines)
    artifactWorldScale: 0.025,  // worldScale for snapshot cards (fine-print document you fly into)
    snapshotWindow: false,      // OFF by default → load the WHOLE file (an edit touches all of it; show everything)
    snapshotRows: 28,           // visible-line cap — used ONLY when snapshotWindow is on
    snapshotImageWidth: 40,     // world width of an image snapshot quad (height follows aspect)
    maxConnections: 512,        // tether budget
    showTethers: true,          // draw a call→snapshot beam per moment
    debug: false,               // ON → log the decoration decision per snapshot (trail.config debug true)

    // Corridor identity — a translucent colored box around each agent's deck (the
    // ContentTreeMarkers dir-prism recipe, per-AGENT hue instead of depth-gradient).
    // Parented INTO the corridor so it rides every transform; sized to the deck's
    // bounds on each relayout, so it GROWS as moments append — a 3D window of what's
    // happening, and the frame the rolodex-pager will eventually scroll through.
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
        other:  { r: 0.62, g: 0.64, b: 0.68 },
    },
};

const READ_RE   = /^(read|cat|view|open)$/;
const SEARCH_RE = /^(grep|search|glob|rg|find|ls)$/;
const EDIT_RE   = /^(edit|write|multiedit|notebookedit|create)$/;
const RUN_RE    = /^(bash|run|shell|exec|task)$/;

function classify(action) {
    const a = String(action || '').toLowerCase();
    if (READ_RE.test(a)) return 'read';
    if (SEARCH_RE.test(a)) return 'search';
    if (EDIT_RE.test(a)) return 'edit';
    if (RUN_RE.test(a)) return 'run';
    return 'other';
}

const fmtNum = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K' : String(n));
const fmtBytes = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : b + ' B');

/** A terse one-line summary of an action's structured meta (lines read/written, +/−, tokens…). */
function fmtMeta(meta) {
    if (!meta || typeof meta !== 'object') return '';
    const p = [];
    if (meta.lines != null) p.push(`${meta.lines} lines`);
    if (meta.added != null || meta.removed != null) p.push(`+${meta.added || 0} −${meta.removed || 0}`);
    if (meta.kind) p.push(String(meta.kind));
    if (meta.bytes != null) p.push(fmtBytes(meta.bytes));
    if (meta.tools != null) p.push(`${meta.tools} tools`);
    if (meta.tokens != null) p.push(`${fmtNum(meta.tokens)} tok`);
    if (meta.ms != null) p.push(`${(meta.ms / 1000).toFixed(1)}s`);
    if (meta.interrupted) p.push('interrupted');
    return p.join(' · ');
}

function fmtCall(rec) {
    // The call card carries the action's INPUT (target path / command) + a terse META subtitle
    // (lines read/written, +/−, tokens). The full RESULT/OUTPUT lives in the sibling, never here.
    const head = rec.target || rec.detail || rec.action || '';
    const mid = (rec.target && rec.detail) ? `\n${rec.detail}` : '';
    const meta = fmtMeta(rec.meta);
    return `${head}${mid}${meta ? `\n${meta}` : ''}`;
}

function clip(text, maxLines) {
    const lines = String(text || '').split('\n');
    if (lines.length <= maxLines) return String(text || '');
    return lines.slice(0, maxLines).join('\n') + `\n… (${lines.length - maxLines} more lines)`;
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
        this._off = null;
        this._tmp = new THREE.Vector3();

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

    /** One activity record → a moment (call beside its snapshot) decked into the corridor. */
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

        const call = this._card(`[${record.action || 'act'}]`, fmtCall(record), { gridScale: this.cfg.callScale, textColor: hue });
        const children = [call];

        let snapshot = null;
        if (record.target) {
            // A snapshot is whatever the target file IS, as-of now: an image renders as a frame,
            // everything else as a text/hex card (same classifier as file.open — [[fileLoader]]).
            const kind = classifyByExtension(record.target);
            if (kind?.kind === 'image') {
                snapshot = this._imageSnapshot(record.target, kind.format);
            } else {
                snapshot = this._card(record.target, '…', { worldScale: this.cfg.artifactWorldScale });
                this._loadSnapshot(snapshot, record);   // fetch the file AS-OF now + decorate what it touched
            }
            children.push(snapshot);
        } else if (pullOutput) {
            snapshot = this._outputSnapshot(record);   // the command's output as a sibling grid
            children.push(snapshot);
        }

        const moment = new HStack({ spacing: this.cfg.railGap, children });
        lane.corridor.add(moment);
        const tetherId = snapshot ? `tether:${agentId}:${lane.seq}` : null;
        lane.moments.push({ moment, call, snapshot, hue, tetherId });
        // BIND the tether to the two cards — it resolves their world positions each
        // frame, so it follows layout, scroll, and corridor drags with no re-tether.
        if (tetherId) this.conn.set(tetherId, call, snapshot, hue);
        lane.seq++;
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

    update() { this.conn.refresh(); }

    clear(which = 'all') {
        const kill = (lane) => {
            for (const e of lane.moments) {
                if (e.tetherId) this.conn.remove(e.tetherId);
                for (const g of [e.call, e.snapshot]) { if (g) { try { g.parent?.remove(g); g.dispose?.(); } catch (_e) { /* best effort */ } } }
                try { lane.corridor.remove(e.moment); } catch (_e) { /* best effort */ }
            }
            if (lane.groupId) { try { this.ctx.registry?.unregister?.(lane.groupId); } catch (_e) { /* best effort */ } }
            if (lane.box) {
                try { this.ctx.pickingSystem?.unregister?.('grid', lane.box.mesh); } catch (_e) { /* best effort */ }
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
            try { ps.register('grid', lane.box.mesh, lane.corridor); }
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
            box.mesh.position.copy(center);
            box.mesh.scale.set(size.x + 2 * c.corridorPad, size.y + 2 * c.corridorPad, size.z + 2 * c.corridorZPad);
            box.mesh.visible = true;
            box.fill.opacity = c.corridorBoxOpacity;   // re-read so trail.config tunes live
            box.edge.opacity = c.corridorEdgeOpacity;
            box.edges.visible = c.corridorEdgeOpacity > 0;
        }
    }

    /** A free CodeGrid card; re-layouts the trail once its content (and bounds) settle. */
    _card(filename, body, opts) {
        const grid = new CodeGrid(this.scene, this.atlas, { name: `trail:${filename}`, showFilename: true, showBackground: true, ...opts });
        grid.loadFileAsync(filename, body).then(() => this._relayout()).catch(() => { /* render best-effort */ });
        return grid;
    }

    /**
     * Per-action OUTPUT snapshot: a command's result (bash/grep/…) as a sibling text grid — the
     * command headlines the call card, this is what it produced. Unlike a file the output is
     * EPHEMERAL (no path to re-read), so it comes straight from the record. Windowed when
     * snapshotWindow is on, same as file snapshots.
     */
    _outputSnapshot(record) {
        // The output ONLY — the command lives on the call card, never echoed here (one home each).
        // Raw text to the grid; its layout system does the line-splitting (windowing is a primitive).
        const body = this.cfg.snapshotWindow ? clip(record.result, this.cfg.snapshotRows) : String(record.result ?? '');
        return this._card('output', body, { worldScale: this.cfg.artifactWorldScale });
    }

    /** Per-action snapshot: the file's content AS-OF this moment, with the lines the action touched lit up. */
    _loadSnapshot(grid, record) {
        const path = record.target;
        Promise.resolve(this.ctx.fileProvider?.getFile?.(path))
            .then((content) => grid.loadFileAsync(path, this.cfg.snapshotWindow ? clip(content, this.cfg.snapshotRows) : String(content ?? '')))
            .then(() => { this._decorateSnapshot(grid, record); this._relayout(); })
            .catch(() => grid.loadFileAsync(path, '(could not load)').then(() => this._relayout()).catch(() => {}));
    }

    /**
     * Light up the lines an action touched on its loaded snapshot — the mapping from the action to
     * the content. Edits glow green on their added lines; a partial read tints its slice blue. The
     * directives come from the shared toolMeta registry (decorateForMeta), applied as additive glyph
     * highlights via highlightRange. Runs AFTER load (the layout/slots must exist), clamped to the
     * rendered line range (so a windowed snapshot doesn't index past its content).
     */
    _decorateSnapshot(grid, record) {
        const dbg = this.cfg.debug ? (msg) => console.log(`[trail.decorate] ${record.action} ${record.target || ''} — ${msg}`) : null;
        const directives = decorateForMeta(record.action, record.meta);
        if (!directives) {
            // The two distinct silent-return reasons, so the log says WHICH: no meta reached the
            // record (data flow) vs meta present but this action/shape decorates nothing (by design).
            dbg?.(record.meta ? 'no directives (meta present, nothing to light up)' : 'no meta on record');
            return;
        }
        if (typeof grid.highlightRange !== 'function') { dbg?.('grid has no highlightRange — not a CodeGrid'); return; }
        const apply = (pass) => {
            const lastLine = (typeof grid.getLineCount === 'function' ? grid.getLineCount() : 0) - 1;
            let litLines = 0, litSlots = 0;
            for (const d of directives) {
                const start = Math.max(0, d.startLine);
                const end = Math.min(lastLine, d.endLine);
                for (let ln = start; ln <= end; ln++) {
                    const cols = typeof grid.getLineSlotCount === 'function' ? grid.getLineSlotCount(ln) : 0;
                    if (cols > 0) { grid.highlightRange(ln, 0, ln, cols, d.color); litLines++; litSlots += cols; }
                }
            }
            // Counts make absent-vs-subtle answerable: "lit 9 lines / 240 slots" + nothing on screen
            // means a visibility problem, not a no-op. lastLine<0 means the content isn't loaded yet.
            dbg?.(`pass ${pass}: ${directives.length} directive(s) → lit ${litLines} line(s) / ${litSlots} slot(s) (lastLine=${lastLine})`);
        };
        apply('sync');
        // The snapshot double-loads (placeholder then content); re-apply next frame so a late
        // rebuild can't wipe the highlights.
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => apply('raf'));
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

    /** Re-run the whole stack tree (idempotent) and refresh the tethers off the new positions. */
    _relayout() {
        // cfg is the LIVE source of truth — push current spacing/align into the containers so
        // `trail.config` re-flows the existing trail, not just newly-added moments.
        this.root.spacing = this.cfg.corridorGap;
        for (const lane of this.lanes.values()) {
            lane.corridor.spacing = this.cfg.zPitch;
            lane.corridor.align = this.cfg.align;
            for (const e of lane.moments) e.moment.spacing = this.cfg.railGap;
        }
        this.root.layout();
        // A pinned (user-dragged) corridor overrides its auto-layout slot — the HStack
        // still reserves the slot, so the others flow around the gap it left.
        for (const lane of this.lanes.values()) {
            if (lane.pinned && lane.pinnedPos) lane.corridor.position.copy(lane.pinnedPos);
        }
        this._updateCorridorBoxes();
        this.conn.setVisible(this.cfg.showTethers);   // positions are bound; this just toggles the beam
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

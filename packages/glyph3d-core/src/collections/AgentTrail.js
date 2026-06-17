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
import ConnectionRenderer from '../annotations/ConnectionRenderer.js';
import { HStack, ZStack } from './layouts/StackContainer.js';

export const TRAIL_DEFAULTS = {
    zPitch: 90,                 // ZStack deck pitch between moments (time depth) — fly-through room
    railGap: 20,                // HStack gap between a call and its snapshot
    corridorGap: 120,           // HStack gap between concurrent agents' corridors
    align: 0,                   // corridor cross-align: 0 = leading edge (tiny calls + big stacks share a left edge)
    callScale: 1.4,             // gridScale for call cards
    artifactWorldScale: 0.025,  // worldScale for snapshot cards (file scale)
    artifactMaxLines: 400,      // crude readability gate for giant payloads
    maxConnections: 512,        // tether budget
    showTethers: true,          // draw a call→snapshot beam per moment
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

function fmtCall(rec) {
    const head = rec.target || rec.detail || rec.action || '';
    const mid = (rec.target && rec.detail) ? `\n${rec.detail}` : '';
    const tail = rec.result ? `\n→ ${rec.result}` : '';
    return `${head}${mid}${tail}`;
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
        this.lanes = new Map();   // agentId -> { corridor:ZStack, seq, moments:[{moment,call,snapshot,hue,tetherId}] }
        this._off = null;
        this._tmp = new THREE.Vector3();
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

        const call = this._card(`[${record.action || 'act'}]`, fmtCall(record), { gridScale: this.cfg.callScale, textColor: hue });
        const children = [call];

        let snapshot = null;
        if (record.target) {
            snapshot = this._card(record.target, '…', { worldScale: this.cfg.artifactWorldScale });
            this._loadSnapshot(snapshot, record.target);   // fetch the file AS-OF now
            children.push(snapshot);
        }

        const moment = new HStack({ spacing: this.cfg.railGap, children });
        lane.corridor.add(moment);
        lane.moments.push({ moment, call, snapshot, hue, tetherId: snapshot ? `tether:${agentId}:${lane.seq}` : null });
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

    update() { this.conn.refreshVisibility(); }

    clear(which = 'all') {
        const kill = (lane) => {
            for (const e of lane.moments) {
                if (e.tetherId) this.conn.remove(e.tetherId);
                for (const g of [e.call, e.snapshot]) { if (g) { try { g.parent?.remove(g); g.dispose?.(); } catch (_e) { /* best effort */ } } }
                try { lane.corridor.remove(e.moment); } catch (_e) { /* best effort */ }
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
    }

    // -- private --------------------------------------------------------

    _lane(agentId) {
        let lane = this.lanes.get(agentId);
        if (!lane) {
            const corridor = new ZStack({ spacing: this.cfg.zPitch, reverse: true, align: this.cfg.align });   // newest in front, leading-aligned
            corridor.name = `trail:${agentId}`;
            this.root.add(corridor);
            lane = { corridor, seq: 0, moments: [] };
            this.lanes.set(agentId, lane);
        }
        return lane;
    }

    /** A free CodeGrid card; re-layouts the trail once its content (and bounds) settle. */
    _card(filename, body, opts) {
        const grid = new CodeGrid(this.scene, this.atlas, { name: `trail:${filename}`, showFilename: true, showBackground: true, ...opts });
        grid.loadFileAsync(filename, body).then(() => this._relayout()).catch(() => { /* render best-effort */ });
        return grid;
    }

    /** Per-action snapshot: the file's content AS-OF this moment (the repo falls out of the action). */
    _loadSnapshot(grid, path) {
        Promise.resolve(this.ctx.fileProvider?.getFile?.(path))
            .then((content) => grid.loadFileAsync(path, clip(content, this.cfg.artifactMaxLines)))
            .then(() => this._relayout())
            .catch(() => grid.loadFileAsync(path, '(could not load)').then(() => this._relayout()).catch(() => {}));
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
        if (this.cfg.showTethers) this._retether();
    }

    _retether() {
        const a = new THREE.Vector3(), b = new THREE.Vector3();
        for (const lane of this.lanes.values()) {
            for (const e of lane.moments) {
                if (!e.snapshot || !e.tetherId) continue;
                e.call.getWorldPosition(a);
                e.snapshot.getWorldPosition(b);
                this.conn.set(e.tetherId, { x: a.x, y: a.y, z: a.z }, { x: b.x, y: b.y, z: b.z }, e.hue, { fromGrid: e.call, toGrid: e.snapshot });
            }
        }
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

/**
 * AgentTrail — an agent's run laid out as a spatial corridor.
 *
 * The sequel to FieldVisitor: instead of ONE card the camera reads over the shoulder,
 * every action leaves a card behind, receding into depth. Time is the Z axis — "now"
 * is nearest the camera, history recedes; you don't scroll-and-collapse, you fly and
 * look past. Two rails per corridor:
 *
 *   ② calls     — one card per tool-call, at depth z = -seq * zStep
 *   ③ artifacts — the file the call touched, on a parallel rail, tethered to its call.
 *                 Files load on demand (ctx.fileProvider), so the repo falls out of the
 *                 agent's actions instead of being bulk-loaded up front.
 *
 * Fed by FieldVisitorManager.onActivity (one payload per record). Self-renders: cards
 * are free CodeGrids parented into the scene (the path AgentGrid proves), so nothing
 * touches the registry. Every spatial value is a constant in TRAIL_DEFAULTS — tune by
 * flying, not by re-coding.
 *
 * (① conversation rail + range-highlights are additive Claude-Code-hook forwards; not
 * in this brick — today's hook stream is tool-calls only.)
 */

import * as THREE from 'three';
import CodeGrid from './CodeGrid.js';
import ConnectionRenderer from '../annotations/ConnectionRenderer.js';

export const TRAIL_DEFAULTS = {
    zStep: 7,                   // depth between consecutive moments (world units)
    callX: 0,                   // X of the ② call rail
    artifactX: 22,              // X of the ③ artifact rail
    baseY: 0,                   // top edge of each card row
    corridorGap: 90,            // X between concurrent agents' corridors
    callScale: 1.4,             // gridScale for call cards (cf. AgentGrid)
    artifactWorldScale: 0.025,  // worldScale for artifact cards (cf. repo file grids)
    artifactMaxLines: 400,      // crude readability gate for giant payloads
    maxConnections: 512,        // tether budget (one draw call)
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

/** Map a tool-call verb to a colour family. */
function classify(action) {
    const a = String(action || '').toLowerCase();
    if (READ_RE.test(a)) return 'read';
    if (SEARCH_RE.test(a)) return 'search';
    if (EDIT_RE.test(a)) return 'edit';
    if (RUN_RE.test(a)) return 'run';
    return 'other';
}

/** Compose the call-card body: the meaningful arg, then the terse outcome. */
function fmtCall(rec) {
    const head = rec.target || rec.detail || rec.action || '';
    const mid = (rec.target && rec.detail) ? `\n${rec.detail}` : '';
    const tail = rec.result ? `\n→ ${rec.result}` : '';
    return `${head}${mid}${tail}`;
}

/** Clip a giant payload so one card never tanks the frame (readability gate, crude). */
function clip(text, maxLines) {
    const lines = String(text || '').split('\n');
    if (lines.length <= maxLines) return String(text || '');
    return lines.slice(0, maxLines).join('\n') + `\n… (${lines.length - maxLines} more lines)`;
}

export default class AgentTrail {
    /** @param {Object} ctx duck-typed scene context (scene, atlas, camera, fileProvider) */
    constructor(ctx, opts = {}) {
        this.ctx = ctx;
        this.scene = ctx.scene;
        this.atlas = ctx.atlas;
        this.cfg = { ...TRAIL_DEFAULTS, ...opts, hues: { ...TRAIL_DEFAULTS.hues, ...(opts.hues || {}) } };

        this.root = new THREE.Group();
        this.root.name = 'agent-trail';
        this.scene.add(this.root);
        this._rootPlaced = false;

        this.conn = new ConnectionRenderer(this.scene, { maxConnections: this.cfg.maxConnections });
        this.lanes = new Map();   // agentId -> { group, seq, artifacts:Map<path,grid>, cards:[], tethers:[] }
        this._off = null;
        this._tmp = new THREE.Vector3();
    }

    /** Subscribe to the per-record feed. Returns this for chaining. */
    attach(mgr) {
        this._off = mgr?.onActivity?.((p) => {
            try { this.ingest(p); } catch (e) { console.warn('[AgentTrail] ingest failed', e); }
        });
        return this;
    }

    /** One activity record → a call card at the next depth, its artifact, and a tether. */
    ingest({ agentId, record } = {}) {
        if (!record) return;
        if (!this._rootPlaced) this._placeRootInView();

        const lane = this._lane(agentId);
        const seq = lane.seq++;
        const z = -seq * this.cfg.zStep;
        const hue = this.cfg.hues[classify(record.action)] || this.cfg.hues.other;

        const call = this._card(lane.group, `[${record.action || 'act'}]`, fmtCall(record),
            { x: this.cfg.callX, y: this.cfg.baseY, z },
            { gridScale: this.cfg.callScale, textColor: hue });
        lane.cards.push(call);

        if (record.target) this._artifact(lane, record.target, hue, z, call, seq);
    }

    /** Point the THREE camera at a corridor (best-effort; the controller may reclaim it). */
    focus(agentId) {
        const lane = agentId ? this.lanes.get(agentId) : this.lanes.values().next().value;
        const cam = this.ctx.camera;
        if (!lane || !cam) return false;
        const box = new THREE.Box3().setFromObject(lane.group);
        if (box.isEmpty()) return false;
        const c = box.getCenter(new THREE.Vector3());
        const s = box.getSize(this._tmp);
        const dist = Math.max(s.x, s.y, s.z, 10) * 1.1 + 25;
        cam.position.set(c.x, c.y, box.max.z + dist);
        cam.lookAt(c.x, c.y, c.z);
        return true;
    }

    /** Per-frame: hide tethers whose cards left the frustum (cheap). */
    update() { this.conn.refreshVisibility(); }

    /** Clear one corridor, or 'all'. */
    clear(which = 'all') {
        const kill = (lane) => {
            for (const id of lane.tethers) this.conn.remove(id);
            for (const g of lane.cards) { try { lane.group.remove(g); g.dispose?.(); } catch (_e) { /* best effort */ } }
            this.root.remove(lane.group);
        };
        if (!which || which === 'all') {
            for (const lane of this.lanes.values()) kill(lane);
            this.lanes.clear();
            this._rootPlaced = false;
            return;
        }
        const lane = this.lanes.get(which);
        if (lane) { kill(lane); this.lanes.delete(which); }
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
            const group = new THREE.Group();
            group.name = `trail:${agentId}`;
            group.position.x = this.lanes.size * this.cfg.corridorGap;
            this.root.add(group);
            lane = { group, seq: 0, artifacts: new Map(), cards: [], tethers: [] };
            this.lanes.set(agentId, lane);
        }
        return lane;
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

    _card(parent, filename, body, pos, opts) {
        const grid = new CodeGrid(this.scene, this.atlas, {
            name: `trail:${filename}:${pos.z}`,
            showFilename: true,
            showBackground: true,
            ...opts,
        });
        grid.position.set(pos.x, pos.y, pos.z);
        parent.add(grid);
        grid.loadFileAsync(filename, body).catch(() => { /* render best-effort */ });
        return grid;
    }

    _artifact(lane, path, hue, z, call, seq) {
        let art = lane.artifacts.get(path);
        if (!art) {
            art = new CodeGrid(this.scene, this.atlas, {
                name: `trail-artifact:${path}`,
                showFilename: true,
                showBackground: true,
                worldScale: this.cfg.artifactWorldScale,
            });
            art.position.set(this.cfg.artifactX, this.cfg.baseY, z);
            lane.group.add(art);
            lane.artifacts.set(path, art);
            lane.cards.push(art);
            // The file falls out of the action: fetch on demand, clip, render.
            Promise.resolve(this.ctx.fileProvider?.getFile?.(path))
                .then((content) => art.loadFileAsync(path, clip(content, this.cfg.artifactMaxLines)))
                .catch(() => art.loadFileAsync(path, '(could not load)').catch(() => {}));
        }
        // Tether the call to its artifact (world-space origins; stable across async load).
        const id = `tether:${lane.group.name}:${seq}`;
        const from = call.getWorldPosition(new THREE.Vector3());
        const to = art.getWorldPosition(new THREE.Vector3());
        this.conn.set(id, { x: from.x, y: from.y, z: from.z }, { x: to.x, y: to.y, z: to.z }, hue, { fromGrid: call, toGrid: art });
        lane.tethers.push(id);
    }
}

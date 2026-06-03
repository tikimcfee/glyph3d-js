/**
 * FieldVisitorManager — the multiplexer.
 *
 * Lifts agent-follow off the single camera path: one self-driving FieldVisitor per
 * agent, keyed by agentId, each addressable and self-operating. It is driven by the
 * agent.* command family (see agentVisitorCommands) and ticked once per frame to
 * ease visitors toward the files they're acting on, detect stalls, reap finished
 * agents, and (opt-in) ride one with the camera. By default the camera is FREE — the
 * manager never touches it unless you `camera.follow <agentId>`.
 *
 * Loosely coupled to the client context (duck-typed): reads ctx.scene, ctx.atlas,
 * ctx.camera. The command handler resolves a file path → grid and hands the grid in,
 * so the manager stays free of registry-resolution policy.
 */

import * as THREE from 'three';
import FieldVisitor from '../../collections/FieldVisitor.js';

const STALL_MS = 12000;        // no activity for this long → 'stalled'
const DONE_LINGER_MS = 8000;   // keep a finished visitor on-screen this long, then reap
const FOLLOW_EASE = 3;         // camera-follow lerp rate (per second)

// Distinct hues so concurrent agents read apart at a glance.
const PALETTE = [
    { r: 0.45, g: 1.00, b: 0.55 }, { r: 0.50, g: 0.72, b: 1.00 },
    { r: 1.00, g: 0.62, b: 0.90 }, { r: 1.00, g: 0.82, b: 0.42 },
    { r: 0.62, g: 1.00, b: 0.92 }, { r: 0.92, g: 0.62, b: 0.55 },
];

export default class FieldVisitorManager {
    constructor(ctx) {
        this.ctx = ctx;
        this.visitors = new Map();   // agentId -> FieldVisitor
        this._order = 0;             // palette cursor
        this.followId = null;        // agentId the camera is riding, or null
        this.onRequest = null;       // (agentId, msg) => void — DOM "follow me!" popup hook
        this._listeners = new Set(); // roster-change subscribers (the crew panel)
        this._tmp = new THREE.Vector3();
    }

    /** Subscribe to roster changes (spawn / activity / state / stop / reap / follow). */
    onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
    _emitChange() { for (const fn of this._listeners) { try { fn(); } catch (_e) { /* listener owns its errors */ } } }

    /** A snapshot of the crew for a list UI (the roster panel). Discrete fields only — */
    /** position eases continuously and isn't part of the roster. */
    getRoster() {
        const out = [];
        for (const v of this.visitors.values()) {
            out.push({
                id: v.agentId,
                type: v.agentType,
                state: v.state,
                beacon: v._beacon || null,
                lastAction: v._actions.length ? v._actions[v._actions.length - 1] : null,
                lastActivityTs: v.lastActivityTs,
                following: this.followId === v.agentId,
            });
        }
        return out;
    }

    /** Spawn-on-first-sight. Returns the (existing or new) visitor for an agent. */
    ensure(agentId, agentType) {
        let v = this.visitors.get(agentId);
        if (!v) {
            const color = PALETTE[this._order++ % PALETTE.length];
            v = new FieldVisitor(agentId, this.ctx.scene, this.ctx.atlas, { agentType, color });
            this.visitors.set(agentId, v);
            this._placeInFront(v);   // visible immediately (esp. target-less summons)
            this._emitChange();
        } else if (agentType && v.agentType !== agentType) {
            v.agentType = agentType;
            v._compose();
        }
        return v;
    }

    /** agent.activity — agent acted on a file. `targetGrid` is resolved by the handler. */
    activity(agentId, agentType, action, targetGrid, detail) {
        const v = this.ensure(agentId, agentType);
        v.setState('active');
        v.clearAttention();              // it's acting → hand lowered
        if (targetGrid) v.setTarget(targetGrid);
        v.note(action, detail);
        v.touch();
        this._emitChange();
        return v;
    }

    state(agentId, state) {
        const v = this.visitors.get(agentId);
        if (!v) return;
        v.setState(state);
        this._emitChange();
    }

    /** Park a freshly-spawned visitor in front of the camera so it's in view at once —
     *  otherwise a target-less summon sits at the world origin and is easy to miss. */
    _placeInFront(v) {
        const cam = this.ctx.camera;
        if (!cam) return;
        const fwd = cam.getWorldDirection(this._tmp).clone();
        const dist = Math.max(cam.position.length() * 0.4, 40);
        const n = this.visitors.size - 1;   // stagger so multiple summons don't stack
        const pos = new THREE.Vector3().copy(cam.position).addScaledVector(fwd, dist);
        pos.x += (n % 4) * 6;
        pos.y += (n % 4) * 4;
        v.placeAt(pos);
    }

    /** agent.stop — finished. Lingers (so you can read its last state), then reaps. */
    stop(agentId) {
        const v = this.visitors.get(agentId);
        if (!v) return;
        v.setState('done');
        v._doneAt = _now();
        this._emitChange();
    }

    /** agent.request — the agent raises a hand for input/advice. */
    request(agentId, msg) {
        const v = this.visitors.get(agentId);
        if (!v) return;
        v.requestAttention(msg);
        this._emitChange();
        this.onRequest?.(agentId, msg);   // DOM popup, when wired
    }

    follow(agentId) {
        this.followId = this.visitors.has(agentId) ? agentId : null;
        this._emitChange();
        return this.followId;
    }
    free() { this.followId = null; this._emitChange(); }

    /** Per-frame: ease visitors, detect stalls, reap finished, drive camera follow. */
    update(dt) {
        const now = _now();
        let changed = false;   // emit once per frame only on DISCRETE transitions (not eases)
        for (const [id, v] of this.visitors) {
            if (v.state === 'active' && now - v.lastActivityTs > STALL_MS) { v.setState('stalled'); changed = true; }
            if (v.state === 'done' && v._doneAt && now - v._doneAt > DONE_LINGER_MS) {
                if (this.followId === id) this.followId = null;
                v.dispose();
                this.visitors.delete(id);
                changed = true;
                continue;
            }
            v.update(dt);
        }
        this._applyFollow(dt);
        if (changed) this._emitChange();
    }

    /**
     * Opt-in camera ride. NOTE: first cut — writes camera.position directly, which
     * tugs against the camera controller's own per-frame update. Fine for a stationary
     * watch; buttery continuous follow wants a follow-target hook inside the controller
     * (next pass, coordinated with the VCC work). Off unless `camera.follow` is issued.
     */
    _applyFollow(dt) {
        if (!this.followId) return;
        const v = this.visitors.get(this.followId);
        const cam = this.ctx.camera;
        if (!v || !cam) return;
        const b = v.getBounds?.();
        if (!b || !Number.isFinite(b.max.x) || b.isEmpty?.()) return;
        const cx = (b.min.x + b.max.x) / 2;
        const cy = (b.min.y + b.max.y) / 2;
        const dist = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, 6) * 1.6;
        this._tmp.set(cx, cy, b.max.z + dist);
        cam.position.lerp(this._tmp, Math.min(1, (dt || 0.016) * FOLLOW_EASE));
        cam.lookAt(cx, cy, b.max.z);
    }

    dispose() {
        for (const v of this.visitors.values()) v.dispose();
        this.visitors.clear();
        this.followId = null;
    }
}

function _now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

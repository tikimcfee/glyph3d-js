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
        this._activityListeners = new Set(); // per-record subscribers (the trail) — fires once per record
        this._tmp = new THREE.Vector3();
    }

    /** Subscribe to roster changes (spawn / activity / state / stop / reap / follow). */
    onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
    _emitChange() { for (const fn of this._listeners) { try { fn(); } catch (_e) { /* listener owns its errors */ } } }

    /**
     * Subscribe to EACH activity record as it lands (the spatial trail's feed). Distinct from
     * onChange: that coalesces to "something changed, re-read the roster" (and the roster is a
     * capped ring); this delivers every individual record exactly once, with the resolved grid —
     * so an append-only trail never misses one. Payload: { agentId, agentType, record, targetGrid }.
     */
    onActivity(fn) { this._activityListeners.add(fn); return () => this._activityListeners.delete(fn); }
    _emitActivity(p) { for (const fn of this._activityListeners) { try { fn(p); } catch (_e) { /* listener owns its errors */ } } }

    /** A snapshot of the crew for a list UI (the roster panel). Discrete fields only — */
    /** position eases continuously and isn't part of the roster. */
    getRoster() {
        const out = [];
        for (const v of this.visitors.values()) {
            const recent = v.recent(5);   // last few records, each with a composed `text`
            out.push({
                id: v.agentId,
                type: v.agentType,
                state: v.state,
                beacon: v._beacon || null,
                recent,
                lastAction: recent.length ? recent[recent.length - 1].text : null,
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

    /**
     * agent.activity — the agent acted. The handler resolves the file path to a grid and
     * passes a record: `{ action, target, detail, result, targetGrid }`. `targetGrid` (if
     * present) is what the visitor eases toward; `target` is the human label kept in the log.
     * @param {string} agentId
     * @param {string} agentType
     * @param {{action:string, target?:string, detail?:string, result?:string, targetGrid?:Object}} record
     */
    activity(agentId, agentType, record) {
        const v = this.ensure(agentId, agentType);
        v.setState('active');
        v.clearAttention();              // it's acting → hand lowered
        if (record.targetGrid) v.setTarget(record.targetGrid);
        const rec = v.note({ action: record.action, target: record.target, detail: record.detail, result: record.result });
        v.touch();
        this._emitChange();
        this._emitActivity({ agentId, agentType: v.agentType, record: rec, targetGrid: record.targetGrid || null });
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

    /** agent.stop — the agent finished. The visitor switches to 'done' and PERSISTS:
     *  small/fast helpers you never looked at stay on the field, viewable, instead of
     *  vanishing on a timer. Nothing auto-reaps — removal is explicit (remove/clear). */
    stop(agentId) {
        const v = this.visitors.get(agentId);
        if (!v) return;
        v.setState('done');
        this._emitChange();
    }

    /** Manually remove ONE visitor (any state) — the crew panel ✕ / `agent.clear <id>`.
     *  The only path that drops a visitor now that 'done' lingers indefinitely. */
    remove(agentId) {
        const v = this.visitors.get(agentId);
        if (!v) return false;
        if (this.followId === agentId) this.followId = null;
        v.dispose();
        this.visitors.delete(agentId);
        this._emitChange();
        return true;
    }

    /** Bulk clear: 'all' visitors, or just the 'done' ones (the common cleanup).
     *  Returns the count removed. */
    clear(which = 'all') {
        let n = 0;
        for (const [id, v] of this.visitors) {
            if (which === 'done' && v.state !== 'done') continue;
            if (this.followId === id) this.followId = null;
            v.dispose();
            this.visitors.delete(id);
            n++;
        }
        if (n) this._emitChange();
        return n;
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
        for (const v of this.visitors.values()) {
            // Active → stalled after a quiet spell. 'done' is terminal but NOT reaped —
            // a finished visitor stays until you clear it (see remove/clear).
            if (v.state === 'active' && now - v.lastActivityTs > STALL_MS) { v.setState('stalled'); changed = true; }
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

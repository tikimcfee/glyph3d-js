/**
 * FieldVisitor — an agent, made into a self-driving entity in the field.
 *
 * The natural evolution of the "agent activity window" (AgentGrid): instead of a
 * static panel the camera is yanked toward, a FieldVisitor is an addressable,
 * self-operating card that carries WHO the agent is and WHAT it's doing, and
 * eases itself to hover beside the file-grid the agent is acting on. The camera
 * stays free; the visitors move. One per agent, multiplexed by FieldVisitorManager.
 *
 * It extends AgentGrid (identity + append-mode window + bounds), adding: a target
 * to follow, a per-frame ease toward the parked pose, a lifecycle state reflected
 * in the header, and a "raise a hand" beacon for when the agent wants you.
 */

import * as THREE from 'three';
import AgentGrid from './AgentGrid.js';

// Lifecycle → header tag + text colour. ASCII-safe tags so they render in any font;
// per-agent hue (set at construction from the manager palette) does the who-is-who.
const STATE_STYLE = {
    active:  { tag: 'active',  color: { r: 0.45, g: 1.00, b: 0.55 } },
    idle:    { tag: 'idle',    color: { r: 0.60, g: 0.70, b: 0.82 } },
    stalled: { tag: 'STALLED', color: { r: 1.00, g: 0.80, b: 0.30 } },
    done:    { tag: 'done',    color: { r: 0.55, g: 0.55, b: 0.60 } },
};

// Parked pose relative to the file the agent is acting on (world units): upper-right
// and slightly forward — the "reading over the shoulder" placement: snap beside the
// file, but as a continuously-eased target rather than a static snap.
const FOLLOW_GAP_X = 3;
const FOLLOW_Z_FORWARD = 4;
const MAX_LOG = 6;   // rolling action lines on the card
const EASE = 6;      // position-lerp rate (per second); higher = snappier follow

export default class FieldVisitor extends AgentGrid {
    /**
     * @param {string} agentId
     * @param {THREE.Scene} scene
     * @param {GlyphAtlas} atlas
     * @param {Object} [opts]
     * @param {string} [opts.agentType]
     * @param {{r:number,g:number,b:number}} [opts.color]
     */
    constructor(agentId, scene, atlas, { agentType = 'agent', color } = {}) {
        super(`visitor:${agentId}`, scene, atlas, {
            color: color || STATE_STYLE.active.color,
            scale: 1.6,
        });
        this.agentId = agentId;
        this.agentType = agentType;
        this.state = 'active';
        this.lastActivityTs = _now();

        this._actions = [];           // rolling action log (capped at MAX_LOG)
        this._beacon = null;          // "follow me!" message, or null
        this._targetGrid = null;      // the file-grid we hover beside
        this._desired = new THREE.Vector3().copy(this.grid.position);
        this._placed = false;         // snap to the first target, ease afterward

        this._compose();
    }

    /** Point the visitor at the file-grid the agent is currently acting on. */
    setTarget(grid) { this._targetGrid = grid || null; }

    /** Anchor immediately at a world position (a visible spawn spot). Subsequent
     *  target moves ease from here, so a summon stays put and an activity flies to its file. */
    placeAt(pos) {
        this.grid.position.copy(pos);
        this._desired.copy(pos);
        this._placed = true;
    }

    /** Record an action in the rolling log and refresh the card. */
    note(action, detail) {
        this._actions.push(detail ? `${action}  ${detail}` : String(action));
        if (this._actions.length > MAX_LOG) this._actions.shift();
        this._compose();
    }

    /** Mark fresh activity (resets the stall clock). */
    touch(ts) { this.lastActivityTs = ts ?? _now(); }

    setState(state) {
        if (!STATE_STYLE[state] || this.state === state) return;
        this.state = state;
        this._compose();
    }

    /** Raise a hand — the agent wants input / advice. Shows on the card. */
    requestAttention(msg) { this._beacon = msg || 'needs you'; this._compose(); }
    clearAttention() { if (this._beacon) { this._beacon = null; this._compose(); } }

    /** Per-frame: derive the parked pose from the target's bounds and ease toward it. */
    update(dt) {
        let haveDesired = false;
        if (this._targetGrid) {
            const b = this._targetGrid.getBounds?.();
            if (b && Number.isFinite(b.max.x) && !b.isEmpty?.()) {
                this._desired.set(
                    b.max.x + FOLLOW_GAP_X,
                    b.max.y,
                    (b.min.z + b.max.z) / 2 + FOLLOW_Z_FORWARD,
                );
                haveDesired = true;
            }
        }
        const p = this.grid.position;
        if (!this._placed) {
            // Stay put until a VALID target pose exists (the grid's async layout has
            // produced bounds), then SNAP into place — don't slide in from the world
            // origin. Every move after the first eases.
            if (haveDesired) { p.copy(this._desired); this._placed = true; }
            return;
        }
        p.lerp(this._desired, Math.min(1, (dt || 0.016) * EASE));
    }

    /** @private — header (who + state + beacon) goes in the title; actions in the body. */
    _compose() {
        const style = STATE_STYLE[this.state] || STATE_STYLE.active;
        const beacon = this._beacon ? `   (!) follow me: ${this._beacon}` : '';
        this.title = `${this.agentType}:${this.agentId} [${style.tag}]${beacon}`;
        this.write(this._actions.join('\n'));
        // Lifecycle shows as a subtle backdrop tint — cheap (no text reflow) and
        // glanceable from a zoomed-out field — plus the [tag] in the header. (CodeGrid
        // has no text-recolour API; setBackgroundColor takes a THREE.Color.)
        const c = style.color;
        this.grid?.setBackgroundColor?.(new THREE.Color(c.r * 0.2, c.g * 0.2, c.b * 0.2));
    }
}

function _now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

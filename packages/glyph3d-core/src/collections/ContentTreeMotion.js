/**
 * ContentTreeMotion — relayout becomes something you WATCH HAPPEN.
 *
 * Every relayout used to be a teleport: the scheme stamps new transforms and the
 * whole field snaps. This layer makes the stamp a DESTINATION instead — the durable
 * nodes (directory groups, books, the tree root itself) glide from where they were
 * to where the layout put them, on the house easing idiom (1 − e^(−rate·dt), the
 * same frame-rate-independent exponential the Book decks and the camera use).
 *
 * The mechanism rides the tree's own event seam:
 *   onBeforeRelayout → snapshot every durable node's local transform (the state the
 *                      user last SAW — mid-glide positions included, so back-to-back
 *                      relayouts stay continuous, never jumping to a stale endpoint).
 *   onRelayout       → the scheme has stamped targets; restAbove and the world
 *                      re-space run in the same synchronous flow, so by the time the
 *                      NEXT FRAME ticks update(), node transforms ARE the targets.
 *   first update()   → rewind each surviving node to its snapshot and ease toward
 *                      the target. Nothing ever renders the teleported state.
 *
 * Only nodes that persist across the pass glide: dir nodes and books (and the root).
 * Layout-inserted containers (jellyfish panels, library volumes) are per-pass objects
 * — they arrive at their target instantly and RIDE their gliding directory, exactly
 * like the markers and ownership lines parented into the nodes. A node whose parent
 * changed (a book re-homed into a fresh panel or volume) arrives instantly too: its
 * old local frame is gone, and inventing a world-space hand-off would fight the deck
 * easing those containers already own.
 *
 * Position always glides; rotation slerps too unless dialed off (the jellyfish turns
 * panels to face outward — without the slerp a scheme switch snaps every facing while
 * positions float, which reads as a glitch, not physics).
 *
 * Pure three (Vector3/Quaternion) — headless-testable with mock trees, like every
 * ContentTree overlay. `layout.motion` is the verb; Settings ▸ Motion the panel.
 */

export const MOTION_DEFAULTS = {
    rate: 7,        // ease rate (1/s) — higher snaps, lower floats
    epsilon: 0.05,  // world-units from target where a glide snaps home
    rotate: 1,      // 1 → slerp rotation along with position
};

export default class ContentTreeMotion {
    /**
     * @param {import('./ContentTree.js').default} tree
     * @param {object} [opts] overrides for MOTION_DEFAULTS
     */
    constructor(tree, opts = {}) {
        this.tree = tree;
        this.opts = { ...MOTION_DEFAULTS, ...opts };
        this.enabled = true;
        /** @type {Map<import('three').Object3D,{parent:*,pos:*,quat:*}>|null} the last-seen transforms, kept until a tick consumes them */
        this._from = null;
        this._pending = false;
        /** @type {Map<import('three').Object3D,{toPos:*,toQuat:*}>} live glides, keyed by node so a re-relayout replaces cleanly */
        this._tweens = new Map();
        this._offBefore = tree.onBeforeRelayout(() => this._capture());
        this._offAfter = tree.onRelayout(() => { this._pending = !!this._from; });
    }

    /** Patch options live — there is nothing baked to rebuild. */
    configure(patch = {}) {
        Object.assign(this.opts, patch);
        return this;
    }

    /** Whether any glide is in flight (or armed for the next tick). */
    get active() { return this._pending || this._tweens.size > 0; }

    /** Master toggle (layout.motion on|off). Turning off settles in-flight glides —
     *  the field must never be left hanging between two layouts. */
    setEnabled(on) {
        on = !!on;
        if (on === this.enabled) return this;
        this.enabled = on;
        if (!on) { this._from = null; this._pending = false; this.settle(); }
        return this;
    }

    /** @private onBeforeRelayout: snapshot the durable nodes' CURRENT local transforms.
     *  The first snapshot in a burst wins — between it and the consuming tick nothing
     *  renders, so it is the state the user last saw. */
    _capture() {
        if (!this.enabled || this._from) return;
        const from = new Map();
        const snap = (node) => {
            if (node) from.set(node, { parent: node.parent, pos: node.position.clone(), quat: node.quaternion.clone() });
        };
        snap(this.tree.root);
        for (const d of this.tree._dirs.values()) if (d !== this.tree.root) snap(d);
        for (const b of this.tree._books.values()) snap(b);
        this._from = from;
    }

    /** @private First tick after a relayout: node transforms are the stamped targets —
     *  record them, rewind each surviving same-parent node to its snapshot, glide. */
    _begin() {
        const from = this._from;
        this._from = null;
        this._pending = false;
        if (!from) return;
        for (const [node, s] of from) {
            // Gone, or re-homed into a fresh container: its old local frame no longer
            // exists — arrive instantly (and drop any stale glide aimed in that frame).
            if (!node.parent || node.parent !== s.parent) { this._tweens.delete(node); continue; }
            const toPos = node.position.clone();
            const toQuat = node.quaternion.clone();
            const moved = s.pos.distanceToSquared(toPos) > 1e-8 || Math.abs(s.quat.dot(toQuat)) < 1 - 1e-7;
            if (!moved) { this._tweens.delete(node); continue; }
            node.position.copy(s.pos);
            // With rotation dialed off, facings stay at the stamp (a frozen-then-popping
            // rotation reads worse than an instant one) — only positions glide.
            if (this.opts.rotate) node.quaternion.copy(s.quat);
            this._tweens.set(node, { toPos, toQuat });
        }
    }

    /**
     * Per-frame work (call from the frame loop). Eases every in-flight node toward its
     * target; a node within epsilon (and a whisker of the target rotation) snaps home
     * and leaves the set. Returns whether any glide is active THIS frame — the caller's
     * cue to refresh the overlays that track node positions by value (the ownership
     * lines' endpoints, the label anchors); everything parented INTO a node rides free.
     * @param {number} [dt] seconds since the last frame
     * @returns {boolean} true while gliding
     */
    update(dt = 1 / 60) {
        if (this._pending) this._begin();
        if (this._tweens.size === 0) return false;
        const o = this.opts;
        if (!this.enabled || o.rate <= 0) { this.settle(); return false; }
        const k = 1 - Math.exp(-o.rate * Math.min(Math.max(dt || 0, 0), 0.1));
        const eps2 = o.epsilon * o.epsilon;
        for (const [node, t] of this._tweens) {
            node.position.lerp(t.toPos, k);
            if (o.rotate) node.quaternion.slerp(t.toQuat, k);
            const done = node.position.distanceToSquared(t.toPos) <= eps2
                && (!o.rotate || node.quaternion.angleTo(t.toQuat) < 0.005);
            if (done) {
                node.position.copy(t.toPos);
                node.quaternion.copy(t.toQuat);
                this._tweens.delete(node);
            }
        }
        return true;
    }

    /** Land every in-flight glide on its target NOW. */
    settle() {
        for (const [node, t] of this._tweens) {
            node.position.copy(t.toPos);
            node.quaternion.copy(t.toQuat);
        }
        this._tweens.clear();
        return this;
    }

    dispose() {
        this._offBefore?.();
        this._offAfter?.();
        this._from = null;
        this._pending = false;
        this.settle();
    }
}

/**
 * HandCloud — the app's LiDAR hand tracker (ctx.handCloud). Every hand a device sends WITH a
 * depth crop (hands[i].cloud, core hand/cloud/depthWire.js) goes to the cloud tracker in its
 * worker (core CloudPipeline), with the live hand model's learned bones as the skeleton it
 * fits; the result is kept per hand and drawn by the in-scene CloudView (`cloud.view`), every
 * stage a layer, colour by class / geodesic / depth.
 *
 * It follows the device the hand model follows (ctx.handCalib), else whichever streams a
 * cloud. `simulate` runs the worker's HandSim + DepthSim and injects its frames into the
 * SourceStream as local source `src-sim-cloud`, so simulated crops take the phone's path.
 *
 * Behavior only: the `cloud.*` verbs read and drive it; Settings ▸ Hand cloud are its knobs.
 */

import { CloudPipeline, CloudView, HAND_CLOUD_DEFAULTS } from '@glyph3d/core/hand/cloud/index.js';
/** @import SourceStream from '@glyph3d/core/services/orchestration/SourceStream.js' */
/** @import HandPresence from '@glyph3d/core/hand/HandPresence.js' */

export const SIM_SOURCE_ID = 'src-sim-cloud';
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

/** Vision's palm centroid (wrist + MCPs it has), or null. */
function palmOf(points) {
    const ps = [0, 5, 9, 13, 17].map((j) => points?.[j]).filter(Boolean);
    if (ps.length < 2) return null;
    const c = { x: 0, y: 0, z: 0 };
    for (const p of ps) { c.x += p.x; c.y += p.y; c.z += p.z; }
    return { x: c.x / ps.length, y: c.y / ps.length, z: c.z / ps.length };
}

export default class HandCloud {
    /**
     * @param {{stream: SourceStream, presence: HandPresence, calib?: () => Object|null}} opts
     *   calib: the live hand model (ctx.handCalib), read for bones and the followed device
     */
    constructor({ stream, presence, calib = () => null }) {
        if (!stream || !presence) throw new Error('HandCloud needs a SourceStream and a HandPresence');
        this.stream = stream;
        this.calib = calib;
        /** The tracker knobs as set here (the worker holds its own copy). */
        this.opts = { ...HAND_CLOUD_DEFAULTS };
        this.enabled = true;
        this.pipeline = new CloudPipeline({
            onResult: (r) => this._onResult(r),
            onSimFrame: (payload) => { if (this.simulating) this.stream.injectFrame(SIM_SOURCE_ID, payload); },
        });
        // A picture-in-picture: drawn after the main scene renders to the screen through the view camera.
        this.view = new CloudView();
        this.view.hook(presence.scene, presence.camera);
        this.view.displayProvider = () => this._display();
        /** handedness → {t, status, hand, pinch, at} */
        this.last = new Map();
        this.primary = null;
        this.source = null;
        this.simulating = null;
        /** Every hand-device frame seen: with no hand, hands without a crop, hands with one. */
        this.frames = { seen: 0, empty: 0, withCloud: 0, without: 0 };
        this.lastSeen = null;
        /** source id → the newest fit per hand: {label, t, palm, fit}. */
        this._fits = new Map();
        /** fitFor: a fit at most this old (s) — about two depth maps at 30 Hz. */
        this.fitMaxAgeS = 0.08;
        /** fitFor: matched to a hand whose palm is within this (m). */
        this.fitMatchM = 0.06;
        /** How often the live model's skeleton is re-read (s). */
        this.bonesEveryS = 0.5;
        this._unsub = stream.onFrame((state) => this._onFrame(state));
    }

    /** Set one tracker knob (validated against the defaults' keys and types). */
    set(key, value) {
        if (!(key in HAND_CLOUD_DEFAULTS)) throw new Error(`hand cloud: unknown knob '${key}'`);
        const d = HAND_CLOUD_DEFAULTS[key];
        if (Array.isArray(d)) {
            if (!Array.isArray(value) || value.length !== d.length || !value.every(Number.isFinite)) throw new Error(`hand cloud: ${key} wants ${d.length} numbers`);
        } else if (typeof d === 'number' && !Number.isFinite(value)) throw new Error(`hand cloud: ${key} wants a number`);
        else if (typeof d === 'boolean' && typeof value !== 'boolean') throw new Error(`hand cloud: ${key} wants true|false`);
        this.opts[key] = value;
        this.pipeline.setOpts({ [key]: value });
    }

    /** Forget the tracker's temporal state and the last results. */
    reset() { this.pipeline.reset(); this.last.clear(); this._fits.clear(); }

    /** Run (or stop) the simulated depth source. @param {string|null} mode */
    simulate(mode, extra = {}) {
        if (!mode) {
            if (this.simulating) { this.pipeline.sim({ cmd: 'off' }); this.stream.detachLocal(SIM_SOURCE_ID); }
            this.simulating = null;
            return;
        }
        if (!this.simulating) {
            this.stream.attachLocal(SIM_SOURCE_ID, 'hand');
            this.pipeline.sim({ cmd: 'on', mode, seed: Date.now() & 0xffff, ...extra });
        } else this.pipeline.sim({ cmd: 'mode', mode });
        this.simulating = mode;
    }

    /** Move the simulated phone. */
    bump(yawDeg, tiltDeg) { this.pipeline.sim({ cmd: 'bump', yawDeg, tiltDeg }); }

    /** @private */
    _onFrame(state) {
        if (state.kind !== 'hand' || !this.enabled) return;
        const hands = state.hands || [];
        this.frames.seen++;
        this.lastSeen = state.id;
        if (!hands.length) { this.frames.empty++; return; }
        const withCloud = hands.filter((h) => h.cloud);
        if (!withCloud.length) { this.frames.without++; return; }
        // Follow the hand model's device when it has one that sends clouds; else this one.
        const followed = this.calib()?._current;
        if (followed && followed !== state.id && this.source === followed && !this.stream.isStalled(followed)) return;
        this.source = state.id;
        this.frames.withCloud++;
        const t = state.device?.timestamp ?? performance.now() / 1000;
        for (const h of withCloud) {
            const side = h.handedness || 'right';
            const bones = this._bones(side, t);
            const { cloud, scene: _scene, ...vision } = h;
            this.pipeline.submit({
                cloud, hand: vision, bones, ceiling: state.device?.ceiling ?? null, t, handedness: side, source: state.id,
                view: this.view.visible && (this.primary == null || this.primary === side),
            });
        }
    }

    /**
     * The skeleton to fit: the live model's bone lengths (HandModel.skeleton — joint centres,
     * scaled to this hand within ~0.5 s of it appearing, sharpening as it moves); a bone it has
     * no length for falls back to the tracker's adult default. Re-read every `bonesEveryS`.
     * @private
     */
    _bones(side, t) {
        const c = this._boneCache?.[side];
        if (c && Math.abs(t - c.t) < this.bonesEveryS) return c.bones;
        const sk = this.calib()?.model?.skeleton?.(side) ?? null;
        let bones = null;
        if (sk) {
            bones = {};
            for (const [k, b] of Object.entries(sk.bones)) if (Number.isFinite(b.length)) bones[k] = b.length;
            if (!Object.keys(bones).length) bones = null;
        }
        (this._boneCache ??= {})[side] = { t, bones, settled: sk?.settled ?? false };
        return bones;
    }

    /**
     * The fit for a hand the live model is handling (HandCalib's fit provider). The tracker runs
     * in a worker, so the fit of THIS frame isn't ready yet: this is the newest fit for this
     * device's hand nearest `hand`'s palm (by position, not label — the model's voted side and
     * Vision's label can differ), no older than `fitMaxAgeS`, with its own time and age.
     * @param {string} sourceId @param {string} handedness - the model's voted side (reported back)
     * @param {number} t - the frame's time (device clock) @param {Object} hand - its decoded HandFrame
     * @returns {{points: (number[]|null)[], confidence: number[], source: string[], t: number, age: number, handedness: string}|null}
     */
    fitFor(sourceId, handedness, t, hand) {
        const fits = this._fits.get(sourceId);
        if (!fits || !fits.length) return null;
        const at = palmOf(hand?.points);
        let best = null, bd = Infinity;
        for (const f of fits) {
            const age = t - f.t;
            if (age < -1e-3 || age > this.fitMaxAgeS) continue;
            const d = at && f.palm ? Math.hypot(at.x - f.palm.x, at.y - f.palm.y, at.z - f.palm.z) : fits.length === 1 ? 0 : Infinity;
            if (d < bd && d <= this.fitMatchM) { bd = d; best = f; }
        }
        if (!best) return null;
        return { ...best.fit, t: best.t, age: t - best.t, handedness };
    }

    /**
     * The live model's stabilized hand for the view's primary hand: of the hands the model
     * shows for this device (its voted sides), the one whose palm is nearest this crop's.
     * @private
     */
    _display() {
        const hands = this.source ? this.calib()?.displayHands?.(this.source) : null;
        if (!hands || !this.primary) return null;
        const at = this.last.get(this.primary)?.palm ?? null;
        let best = null, bd = Infinity;
        for (const d of Object.values(hands)) {
            if (!d?.points) continue;
            const p = palmOf(d.points);
            const dist = at && p ? Math.hypot(at.x - p.x, at.y - p.y, at.z - p.z) : 0;
            if (dist < bd) { bd = dist; best = d; }
        }
        return best && bd <= this.fitMatchM * 2 ? best : null;
    }

    /** @private */
    _onResult(r) {
        const side = r.job.handedness;
        if (r.hand) {
            const list = (this._fits.get(r.job.source) || []).filter((f) => f.label !== side && r.job.t - f.t <= this.fitMaxAgeS);
            list.push({ label: side, t: r.job.t, palm: palmOf(r.job.hand?.points), fit: { points: r.hand.points, confidence: r.hand.confidence, source: r.hand.source } });
            this._fits.set(r.job.source, list);
        }
        this.last.set(side, { t: r.job.t, status: r.status, hand: r.hand, pinch: r.pinch, at: performance.now(), palm: palmOf(r.job.hand?.points),
            bones: r.job.bones ? (this._boneCache?.[side]?.settled ? 'learned (settled)' : 'learned (settling)') : 'adult default' });
        if (this.primary == null) this.primary = side;
        if (side === this.primary) this.view.setAlert(!!r.status?.edge?.atEdge);
        if (r.view && side === this.primary) this.view.setFrame(r.view, r.job.hand);
    }

    status() {
        const s = this.pipeline.stats;
        const hands = {};
        for (const [h, l] of this.last) hands[h] = { ...l.status, pinch: l.pinch, bones: l.bones, ageMs: Math.round(performance.now() - l.at) };
        return {
            enabled: this.enabled,
            source: this.source,
            lastSeen: this.lastSeen,
            simulating: this.simulating,
            frames: { ...this.frames },
            pipeline: { submitted: s.submitted, tracked: s.tracked, replaced: s.replaced, failed: s.failed, lastError: s.lastError, roundTripMs: r2(s.roundTripMs), timing: this.pipeline.timing() },
            view: { visible: this.view.visible, drawing: this.view.drawn ?? null, layers: { ...this.view.show }, ...this.view.place },
            primary: this.primary,
            hands,
        };
    }

    dispose() {
        this._unsub?.();
        this._unsub = null;
        this.simulate(null);
        this.pipeline.dispose();
        this.view.dispose();
    }
}

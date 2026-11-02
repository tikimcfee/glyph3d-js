/**
 * HandCalib — the app's live hand model (ctx.handCalib). Always on: every frame from the
 * followed hand device feeds the core HandModel, which learns the hand and its space as it goes
 * (bones, scale, pinch, volume, rest noise, palm template — research-backed, see
 * core/hand/HandModel.js). Each hand's frames then run through its HandSpace stages and pinch
 * tracker, which read the model as it converges. Nothing here binds the hand to the camera or a
 * verb yet.
 *
 * The model's snapshot is saved to the client store (StateController `hand.model` — per
 * BROWSER) every few seconds and is only a WARM START: the next session's model begins from it
 * and live frames outweigh it within seconds. `forget()` drops it.
 *
 * Behavior only: the `calib.*` verbs read and reset it, the Hand panel shows `status()`, the
 * in-scene CalibrationView (`calib.view`) draws the followed hand and its measured volume.
 */

import { HandModel, HandSpace, PinchTracker, CalibrationView, HandStabilizer, HandMetrics, STABILIZER_DEFAULTS } from '@glyph3d/core/hand';
import { roundV, round, dist, centroid, palmFacing, PALM_JOINTS } from '@glyph3d/core/hand/handMath.js';

const PALM = PALM_JOINTS;
const centroidOf = (pts) => (pts.length ? centroid(pts) : null);
import { stateController } from '@glyph3d/core/services/state';
/** @import SourceStream from '@glyph3d/core/services/orchestration/SourceStream.js' */
/** @import HandPresence from '@glyph3d/core/hand/HandPresence.js' */

export const SNAPSHOT_KEY = 'hand.model';
/** Set once the Hand panel has been shown — the first hand device then doesn't pull it forward. */
export const PANEL_SEEN_KEY = 'hand.panelSeen';

const ms = (s) => (s == null ? null : round(s * 1000, 1));

export default class HandCalib {
    /**
     * @param {{stream: SourceStream, presence: HandPresence, persistEveryS?: number, openPanel?: () => void,
     *   fitProvider?: (sourceId: string, handedness: string, t: number, hand: Object) => Object|null}} opts
     *   openPanel: brings the Hand panel forward — called once, when a hand device first streams
     *   and the panel has never been shown in this browser.
     *   fitProvider: the LiDAR cloud tracker's newest fit of that hand ({points (joint centres,
     *   phone frame), confidence, source: 'cloud'|'vision'|'prior', t, age}) or null. Its points
     *   drive the LIVE outputs; the model's learners never see them (no fit → bones loop).
     */
    constructor({ stream, presence, persistEveryS = 10, openPanel = null, fitProvider = null }) {
        this.fitProvider = fitProvider;
        if (!stream || !presence) throw new Error('HandCalib needs a SourceStream and a HandPresence');
        this.stream = stream;
        this.presence = presence;
        this.persistEveryS = persistEveryS;
        /** Model knobs, held here so a model rebuilt for a new source keeps them. */
        this.modelOpts = {};
        this.model = new HandModel(this.modelOpts, stateController.get(SNAPSHOT_KEY, null));
        this.modelOpts = this.model.opts;
        /** HandSpace knob overrides ({stage: {key: value}}), applied to every hand's chain. */
        this.spaceParams = {};
        /** Stabilizer knobs, shared by every hand's stabilizer (held by reference: live). */
        this.stabParams = {};
        /** @type {Map<string, {space: HandSpace, pinch: PinchTracker}>} per handedness */
        this.chains = new Map();
        /** A pinned source id; null follows whichever hand device is streaming. */
        this.pinned = null;
        this._current = null;
        this._persistedAt = null;
        this.view = new CalibrationView();
        this.view.attachTo(presence.rig);
        /** The latest live view, per handedness, plus the frame's source and time. */
        this.live = null;
        this.openPanel = openPanel;
        this._panelOffered = false;
        this._unsub = stream.onFrame((state) => this._onFrame(state));
        // The scene hand draws this model's metric hand for the device it follows.
        this._provider = (id) => this.viewFor(id);
        presence.viewProvider = this._provider;
    }

    /** @private */
    _chain(handedness) {
        let c = this.chains.get(handedness);
        if (!c) {
            const space = new HandSpace(this.spaceParams);
            const stab = new HandStabilizer(this.stabParams); // merges its defaults into the shared object
            c = { space, pinch: new PinchTracker(space.params.pinch), stab, metrics: new HandMetrics() };
            this.chains.set(handedness, c);
        }
        return c;
    }

    /** Set one stabilizer knob for every hand (live). */
    setStab(key, value) {
        if (!(key in STABILIZER_DEFAULTS)) throw new Error(`no stabilizer knob '${key}' (${Object.keys(STABILIZER_DEFAULTS).join(', ')})`);
        this.stabParams[key] = value; // every hand's stabilizer holds this same object
    }

    /**
     * The hand every view draws: the followed device's stabilized joints (phone frame, m) and which
     * are estimated — the cloud tracker's view reads this too. Null for another device or no hand.
     * @param {string} sourceId @param {string} handedness
     */
    displayHand(sourceId, handedness) {
        if (sourceId !== this._current) return null;
        const l = this.live?.hands?.[handedness];
        return l?.display ? { points: l.display, estimated: l.estimated, t: this.live.t } : null;
    }

    /**
     * Every displayed hand of the followed device, keyed by the VOTED side ({right: {points,
     * estimated, t}, …}) — for consumers that match hands their own way (the cloud view matches
     * by palm position). Null for another device.
     * @param {string} sourceId
     */
    displayHands(sourceId) {
        if (sourceId !== this._current || !this.live) return null;
        const out = {};
        for (const h of Object.keys(this.live.hands)) {
            const d = this.displayHand(sourceId, h);
            if (d) out[h] = d;
        }
        return out;
    }

    /** Set one HandSpace knob (`stage.key`) for every hand, now and for hands seen later. */
    setSpace(path, value) {
        new HandSpace(this.spaceParams).set(path, value); // validates: throws on an unknown knob or bad axes
        const [stage, key] = path.split('.');
        (this.spaceParams[stage] ??= {})[key] = value;
        for (const c of this.chains.values()) c.space.set(path, value);
    }

    /** Pin a device, or null to follow whichever is streaming. */
    pin(sourceId) { this.pinned = sourceId || null; }

    /** Forget: everything (and the warm start), or one hand / part. */
    reset(handedness = null, part = null) {
        this.model.reset(handedness, part);
        for (const [h, c] of this.chains) if (!handedness || h === handedness) { c.space.reset(); c.pinch.reset(); }
    }

    /** Drop the saved warm start and start the model cold. */
    forget() {
        stateController.delete(SNAPSHOT_KEY);
        this.model = new HandModel(this.modelOpts, null);
        this.modelOpts = this.model.opts;
        this.chains.clear();
    }

    /** Save the warm start now. */
    persist() {
        const snap = { ...this.model.snapshot(), savedAt: new Date().toISOString(), source: this._current };
        if (Object.keys(snap.hands).length) stateController.set(SNAPSHOT_KEY, snap);
        return snap;
    }

    // ── Frames ──────────────────────────────────────────────────────────────

    /** @private */
    _onFrame(state) {
        if (state.kind !== 'hand') return;
        if (this.pinned) {
            if (state.id !== this.pinned) return;
        } else if (this._current !== state.id) {
            // Follow one device at a time: switch only when the current one left or went quiet.
            const cur = this._current && this.stream.get(this._current);
            if (cur && !this.stream.isStalled(cur.id)) return;
        }
        if (this._current && this._current !== state.id) {
            // A different device keeps a different clock and sits in a different place: start a
            // model from the warm start rather than mixing the two.
            this.persist();
            this.model = new HandModel(this.modelOpts, stateController.get(SNAPSHOT_KEY, null));
            this.modelOpts = this.model.opts;
            this.chains.clear();
        }
        this._current = state.id;
        if (!this._panelOffered && this.openPanel && !stateController.get(PANEL_SEEN_KEY, false)) {
            this._panelOffered = true;
            this.openPanel();
        }

        const t = state.device?.timestamp ?? performance.now() / 1000;
        const res = this.model.feed({ t, device: state.device, hands: state.hands });
        const hands = {};
        for (const [h, modelLive] of Object.entries(res.hands)) {
            const c = this._chain(h);
            if (res.bumped) c.space.reset();
            const oh = this.model.hand(h);
            const summary = oh.summary();
            c.space.model = summary;
            const live = this._withFit(state.id, h, t, modelLive, oh);
            const a = live.points?.[4], b = live.points?.[8];
            // THE displayed hand: the merged joints stabilized in the palm's own frame, each joint
            // tuned from its own noise; every view draws it, and the metrics judge it.
            const display = c.stab.update(live.points, t, live.pose?.q ?? null);
            c.metrics.push(display, live.points, t);
            hands[h] = {
                ...live,
                display,
                stages: live.palm ? c.space.run(live.palm, t) : null,
                pinch: c.pinch.update(a && b ? dist(a, b) : null, summary.pinch, t, a && b ? { thumb: a, index: b } : null),
            };
        }
        this.live = {
            t,
            source: {
                id: state.id,
                fps: state.fps,
                latency: { captureToSendMs: ms(state.latency?.captureToSend), arrivalLagMs: ms(state.latency?.arrivalLag) },
            },
            bumped: res.bumped,
            hands,
            // The voted identity, not Vision's label (an undecided track feeds no hand yet).
            primary: Object.keys(hands)[0] ?? null,
        };

        if (this._persistedAt == null) this._persistedAt = t;
        if (t - this._persistedAt >= this.persistEveryS) { this._persistedAt = t; this.persist(); }
    }

    /**
     * The live view of a hand with the cloud tracker's fit folded in: its points where it has
     * them (moved by how far the palm has gone since the fitted frame — the fit runs a frame or
     * two behind), the model's ray-repaired joints elsewhere; palm, pose and pinch from the result.
     * A joint is `estimated` when the fit calls it 'prior' or, without a fit point, the model
     * rebuilt it. Without a fit, the model's live view unchanged.
     * @private
     */
    _withFit(sourceId, h, t, live, oh) {
        const fit = this.fitProvider?.(sourceId, h, t, live.frame) ?? null;
        if (!fit?.points) return { ...live, estimated: live.rebuilt, fit: null };
        const fp = fit.points.map((p) => (Array.isArray(p) ? { x: p[0], y: p[1], z: p[2] } : p ?? null));
        // Catch the fit up: shift it by the palm's motion since its frame (model palm now − fit palm then).
        const fitPalm = centroidOf(PALM.map((j) => fp[j]).filter(Boolean));
        const shift = fitPalm && live.palm ? { x: live.palm.x - fitPalm.x, y: live.palm.y - fitPalm.y, z: live.palm.z - fitPalm.z } : { x: 0, y: 0, z: 0 };
        const points = live.points.map((p, j) => (fp[j] ? { x: fp[j].x + shift.x, y: fp[j].y + shift.y, z: fp[j].z + shift.z } : p));
        const estimated = points.map((_, j) => (fp[j] ? fit.source?.[j] === 'prior' : live.rebuilt[j]));
        const palm = centroidOf(PALM.map((j) => points[j]).filter(Boolean)) ?? live.palm;
        const counts = { cloud: 0, vision: 0, prior: 0 };
        for (const s of fit.source || []) if (s in counts) counts[s]++;
        return {
            ...live, points, palm, estimated,
            normal: palmFacing(points, h) ?? live.normal,
            pose: oh.poseFrom(points, fit.confidence) ?? live.pose,
            fit: { ageMs: fit.age != null ? Math.round(fit.age * 1000) : null, ...counts, shiftMm: round(Math.hypot(shift.x, shift.y, shift.z) * 1000, 1) },
        };
    }

    /** Per rendered frame: pose and redraw the in-scene view (when shown). @param {import('three').Camera} camera */
    update(camera) {
        if (!this.view.group.visible) return;
        let extent = null;
        if (camera?.isPerspectiveCamera) {
            const halfH = Math.tan((camera.fov * Math.PI) / 360);
            extent = { halfW: halfH * (camera.aspect || 1), halfH };
        }
        const h = this.live?.primary;
        const live = h ? this.live.hands[h] : null;
        const vol = h ? this.model.hands.get(h)?.summary().volume : null;
        this.view.update(extent, {
            points: live?.display || live?.points || null,
            palm: live?.palm || null,
            normal: live?.normal || null,
            volume: vol || null,
        });
    }

    /**
     * The followed device's hands for the scene, in VIEW axes — the one phone → view mapping
     * (HandSpace.toView, the app stage's axes): `shape` the model's repaired, skin-corrected
     * joints in meters relative to the wrist, `anchor` the palm's place in the measured volume
     * (±0.5 at its faces; the centre until the volume is known). Null for any other device, so
     * it draws its own image-space landmarks.
     * @param {string} id
     */
    viewFor(id) {
        if (id !== this._current || !this.live) return null;
        const out = [];
        for (const [h, l] of Object.entries(this.live.hands)) {
            const pts = l.display ?? l.points;
            const wrist = pts?.[0];
            if (!wrist) continue;
            const space = this.chains.get(h)?.space;
            if (!space) continue;
            const shape = pts.map((p) => (p ? space.toView({ x: p.x - wrist.x, y: p.y - wrist.y, z: p.z - wrist.z }) : null));
            const norm = l.stages?.find((s) => s.id === 'normalize');
            const live = space.describe().find((d) => d.id === 'normalize')?.active;
            const v = live && norm ? space.toView(norm.value) : { x: 0, y: 0, z: 0 };
            const clamp = (u) => Math.max(-0.5, Math.min(0.5, u / 2));
            out.push({ handedness: h, anchor: { x: clamp(v.x), y: clamp(v.y) }, shape });
        }
        return out;
    }

    // ── Reads ───────────────────────────────────────────────────────────────

    status() {
        const live = this.live;
        const hands = {};
        for (const [h, l] of Object.entries(live?.hands || {})) {
            hands[h] = {
                palm: roundV(l.palm, 4),
                normal: roundV(l.normal, 3),
                still: l.still,
                rebuilt: l.rebuilt.filter(Boolean).length,
                estimated: l.estimated.filter(Boolean).length,
                fit: l.fit,
                stability: this._stability(h),
                pose: l.pose ? {
                    yaw: round(l.pose.yaw, 1), pitch: round(l.pose.pitch, 1), roll: round(l.pose.roll, 1),
                    fromNeutral: l.pose.fromNeutral, rms: round(l.pose.rms, 4), joints: l.pose.joints,
                } : null,
                stages: l.stages?.map((s) => ({ id: s.id, value: roundV(s.value, 4), velocity: roundV(s.velocity, 3) })) ?? null,
                pinch: l.pinch ? {
                    ...l.pinch, normalized: round(l.pinch.normalized, 4), point: roundV(l.pinch.point, 4),
                    onset: l.pinch.onset ? { t: l.pinch.onset.t, point: roundV(l.pinch.onset.point, 4) } : null,
                } : null,
                space: this.chains.get(h)?.space.describe() ?? null,
            };
        }
        const saved = stateController.get(SNAPSHOT_KEY, null);
        return {
            source: { pinned: this.pinned, current: this._current, ...(live?.source || {}) },
            primary: live?.primary ?? null,
            model: this.model.status(),
            live: hands,
            view: this.view.group.visible,
            warmStart: saved ? { savedAt: saved.savedAt, hands: Object.keys(saved.hands || {}) } : null,
        };
    }

    /** The displayed hand's acceptance numbers (mm, ms) and what the stabilizer has measured. @private */
    _stability(h) {
        const c = this.chains.get(h);
        if (!c) return null;
        const r = c.metrics.report();
        const mm = (x) => (x == null ? null : round(x * 1000, 2));
        const ms = (x) => (x == null ? null : Math.round(x * 1000));
        const d = c.stab.describe();
        return {
            worstJitterP95Mm: mm(r.worstJitterP95), worstJoint: r.worstJoint,
            lagP50Ms: ms(r.lagP50), lagP95Ms: ms(r.lagP95),
            jitterP95Mm: r.joints.map((j) => mm(j.jitter.p95)),
            jointNoiseMm: d.joints.map((j) => (j ? mm(j.noise) : null)),
            measured: d.measured, enabled: d.enabled,
        };
    }

    dispose() {
        this._unsub?.();
        this._unsub = null;
        if (this.presence.viewProvider === this._provider) this.presence.viewProvider = null;
        this.view.dispose();
    }
}

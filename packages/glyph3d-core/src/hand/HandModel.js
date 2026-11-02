/**
 * HandModel — the hand and the space it moves in, learned LIVE from every frame, the way XR
 * tracking stays calibrated: nothing to start, no poses to perform. Bounds are defined as the
 * hand finds them, bone lengths sharpen as frames flow in, the noise floor is measured whenever
 * the hand happens to rest. A saved snapshot is only a WARM START — a prior the live estimates
 * begin from and quickly outweigh — never a config.
 *
 * The setup is Leap Motion's geometry: a phone face-down on the desk, its depth camera looking
 * up. Everything is in the PHONE frame (hand-wire v2: meters, +y toward its top edge, +z up out
 * of its back, +x = y × z), timed by the DEVICE clock — so a simulated run in a test measures
 * exactly what a live one would. Points are skin-surface points: every joint reads r nearer
 * along its own ray, which shrinks the hand by (1 − r/D) at range D (~10% at 15 cm). The model
 * un-offsets every point by r before anything learns from it — the contract's r (or the warm
 * start's); it also regresses palm length on height to estimate r, but on a real hand that
 * estimate is confounded, so it is a diagnostic unless `skinLearn` is on.
 *
 * WHICH hand: hands are TRACKED by continuity (each frame's hands matched to the tracks by
 * where their palms are), and a track's left/right is a running VOTE over its whole time in
 * view, never decided frame by frame: the palm's anatomy counts most — (p5 − p0) × (p17 − p0)
 * points out of a right palm — but only while the palm clearly faces down at the phone (the
 * fingers' curl says which side the palm is); a flat hand votes a little on the palm-down prior;
 * Vision's label votes a little. A track that hasn't decided (or is gone in a blink) never feeds
 * a model, so a mislabelled burst can't grow a ghost hand.
 *
 * Per hand (left / right, as voted), every estimate a decaying histogram — online
 * quantiles that forget, so the model keeps up with a changed setup without one outlier
 * stretching anything forever:
 *
 *   bones     S × ratio × (1 + δ): the palm length S (rigid, always seen, known in half a second)
 *             on a reference skeleton's ratios (the user's own, from a warm start), each bone's
 *             own deviation δ admitted as its evidence grows — the hierarchy Meta's trackers use,
 *             so repair works from the first second. A bone's evidence: its weighted median over
 *             frames with both joints confident with depth, each sample weighted 1 − (bone · ray)²
 *             (depth error projects into a length by how much the bone points along the ray) and by
 *             its inverse noise variance at its range (noise grows with range),
 *             counted in INDEPENDENT hand poses (the palm moved or turned enough between them) —
 *             a hand-built stand-in for Tkach et al. 2017's per-parameter information (JᵀJ)
 *             accumulated online;
 *             with them, `repair` rebuilds a joint whose depth is missing (it has a ray: seen in
 *             2-D) or breaks the bone gate, along its ray at the bone length from its parent —
 *             of the two places on the ray, the one whose bend is anatomically possible
 *   scale     palm length |wrist − middle MCP| — rigid, so pose-stable
 *   pinch     thumb–index distance ÷ scale; the OPEN hand is the bulk of the time (its median
 *             above a cut), CLOSED is what falls below `pinchCutFrac` × open — a pinch is a
 *             small, brief share of frames and the open distances spread wide as the fingers
 *             curl, so a variance split (Otsu) would halve the open bulk instead. (Kittler &
 *             Illingworth's two-Gaussian minimum-error threshold is the principled form of this
 *             unequal-class split, but measured against this cut on labelled distributions it
 *             mis-sorted 0.2–0.4 % of frames where the cut mis-sorted 0–0.01 %: with pinches rare,
 *             its Bayes boundary hugs the closed mode and cuts off the edge of real pinches.) The
 *             thresholds sit up the closed → open range; until a pinch is seen, the research priors
 *   volume    palm-centre percentile bounds per axis; the centre between them; the dwell (where
 *             the hand spends its time) is the median
 *   noise     still windows found automatically (a tight, slow 0.5 s of palm centre): their
 *             per-axis jitter
 *   template  the rigid palm (wrist + four MCPs) in its own frame, from flat-ish frames; Kabsch
 *             onto it gives the palm's orientation, and the neutral (dwell) orientation is
 *             averaged while the hand rests — yaw/pitch/roll are measured from there
 *
 * The device: gravity, attitude and ceiling are tracked continuously; a BUMP (attitude or
 * gravity turning faster than its slow reference follows) means the phone moved, and the
 * phone-frame estimates (volume, neutral) are re-learned while the hand's own (bones, scale,
 * pinch, noise, template) are kept.
 *
 * Every quantity reports its value, its sample weight, its drift over the last few seconds
 * and a state — unknown, settling, settled. Pure: no DOM, no Three.js.
 */

import { Joint, JOINT_COUNT, SKELETON_CONNECTIONS } from './HandData.js';
import { REFERENCE_RATIOS, FLEX_LIMITS } from './skeleton.js';
import {
    dist, len, norm, cross, sub, scale as vscale, centroid, fitPlane, fromArray, angleDeg,
    DecayHist, Drift, VelocityProbe, kabsch, yawPitchRoll, qmul, qconj, qangleDeg, qnorm, raySphere,
    palmFacing, PALM_JOINTS, boneKey, round, roundV,
} from './handMath.js';

/** @typedef {import('./handMath.js').Vec3} Vec3 */
/** @typedef {import('./handMath.js').Quat} Quat */
/** @typedef {import('./HandData.js').HandFrame} HandFrame */
/** @typedef {import('./HandData.js').DeviceState} DeviceState */

export const HAND_MODEL_DEFAULTS = {
    minConfidence: 0.5,
    driftWindowS: 10,          // "settled" = moved less than its tolerance over this long
    // bones
    boneTauS: 600, boneMinN: 30, boneGate: 0.25, boneSettled: 0.001,
    bonePoses: 6, posePalmM: 0.02, posePalmDeg: 12, boneMinRayWeight: 0.1, repairLimits: true,
    // Range-aware evidence: noise grows with range as (D / rangeRefM)^rangeNoiseExp, so a sample's
    // weight is its inverse variance relative to the reference range (0 = range-blind).
    rangeNoiseExp: 1, rangeRefM: 0.25,
    // skin depth: r_palm learned from palm length vs 1/range; fingers' r = skinFingerFrac × r_palm
    skinPrior: 0.015, skinFingerFrac: 0.55, skinTauS: 600, skinMinSpread: 0.02, skinMin: 0.005, skinMax: 0.025,
    // Live (2026-11-01) the height regression swung 0 ↔ 40 mm on a real hand (confounded: palm pose
    // changes with height, the pinky knuckle's depth is poor) and took palm length ±10 % with it.
    // So it's measured and SHOWN, but the correction uses the prior unless this is on.
    skinLearn: false,
    // Kabsch weights: conf / (σ_j² + kabschSigma0²), σ_j each palm joint's learned residual
    kabschSigma0: 0.001,
    // volume
    volumeTauS: 120, volumeLowPct: 2, volumeHighPct: 98, volumeMinN: 120, volumeSettled: 0.01,
    // stillness → noise
    stillWindowS: 0.5, stillRms: 0.006, stillSpeed: 0.03, noiseTauS: 300, noiseMinN: 8, noiseSettled: 0.0003,
    // pinch
    pinchTauS: 300, pinchCutFrac: 0.5, pinchMinClosed: 20, pinchMinRatio: 2,
    pinchOnFrac: 0.3, pinchOffFrac: 0.55, pinchPriorOn: 0.25, pinchPriorOff: 0.40, pinchSettled: 0.02,
    // palm template + neutral
    templateTauS: 600, templateFlatRms: 0.004, templateMinN: 30, templateSettled: 0.001, neutralTauS: 60,
    // device
    bumpDeg: 2, bumpCeilingM: 0, bumpHoldS: 0.5, deviceRefTauS: 20,
    bumpAccel: 0.6, bumpAccelFrames: 2, bumpAccelWindowS: 0.3, // a SLIDE (no turn): |userAcceleration| over this on N frames within the window
    bumpRefractoryS: 1.5,      // one move is one bump: further triggers within this are the same move
    // hand tracks + the left/right vote
    trackMaxSpeed: 2.5, trackSlack: 0.02, trackLostS: 0.5, decideVotes: 8, decideFrames: 10,
    recentTauS: 0.5, contradict: 0.3, // a track whose recent vote opposes its decision by this much re-votes
    voteGeometry: 1, voteFlatPrior: 0.25, voteLabel: 0.3, curlMin: 0.005, downCos: 0.7,
    idleS: 1,                  // a hand unseen this long is idle (its estimates paused, not settling)
    // warm start
    priorWeight: 20, snapshotMinFrames: 120,
};

const NOW_EVERY_S = 0.25;

/** The parent of each joint along its finger chain (the wrist has none). */
const PARENT = (() => {
    const p = new Array(JOINT_COUNT).fill(-1);
    for (const [a, b] of SKELETON_CONNECTIONS) if (p[b] < 0 && b > a && !(a >= 5 && b - a === 4)) p[b] = a;
    return p;
})();
/** The bones along the finger chains (palm cross-links excluded): [parent, child]. */
const CHAIN_BONES = PARENT.map((a, b) => [a, b]).filter(([a]) => a >= 0);

const TIPS = [Joint.THUMB_TIP, Joint.INDEX_TIP, Joint.MIDDLE_TIP, Joint.RING_TIP, Joint.PINKY_TIP];

/** A joint's point if seen with enough confidence. */
function seen(hand, j, minConf) {
    const p = hand?.points?.[j];
    if (!p) return null;
    const c = hand.confidence?.[j];
    return c == null || c >= minConf ? p : null;
}

/**
 * The palm centre — the centroid of the wrist and four finger MCPs — kept steady through a
 * dropped joint: a single missing joint is filled from the last frame where all five were seen,
 * moved by the mean shift of the other four (averaging four would jump the centre by a quarter
 * of the missing joint's offset — 1.5 cm for the wrist). Two missing, or a gap past `maxGapS`,
 * is no palm.
 */
export class PalmTracker {
    /** @param {number} [minConf] @param {number} [maxGapS] */
    constructor(minConf = 0, maxGapS = 0.25) { this.minConf = minConf; this.maxGapS = maxGapS; this.reset(); }
    reset() { this._full = null; this._t = -Infinity; }
    /** @param {HandFrame|null} hand @param {number} t @returns {Vec3|null} */
    center(hand, t) {
        if (!hand?.points) return null;
        return this.centerOf(hand.points.map((_, j) => seen(hand, j, this.minConf)), t);
    }

    /** The same, from already-gated (or un-offset) points. @param {(Vec3|null)[]} all @param {number} t */
    centerOf(all, t) {
        const pts = PALM_JOINTS.map((j) => all[j] || null);
        const missing = pts.reduce((n, p) => n + (p ? 0 : 1), 0);
        if (missing === 0) { this._full = pts; this._t = t; return centroid(pts); }
        if (missing > 1 || !this._full || t - this._t > this.maxGapS) return null;
        const k = pts.findIndex((p) => !p);
        let dx = 0, dy = 0, dz = 0;
        for (let i = 0; i < pts.length; i++) {
            if (i === k) continue;
            dx += pts[i].x - this._full[i].x; dy += pts[i].y - this._full[i].y; dz += pts[i].z - this._full[i].z;
        }
        const n = pts.length - 1, f = this._full[k];
        pts[k] = { x: f.x + dx / n, y: f.y + dy / n, z: f.z + dz / n };
        return centroid(pts);
    }
}

/** The palm's own frame from its five joints: side (index→pinky… flipped to thumb side), forward, normal. */
function palmFrame(palm) {
    const f = norm(sub(palm[2], palm[0]));                 // wrist → middle MCP
    const n = norm(cross(f, sub(palm[1], palm[4])));       // f × (index MCP − pinky MCP)
    const s = cross(n, f);
    return { f, s, n };
}

/** One tracked quantity: a value, its weight, its drift, its state. */
function q(value, weight, drift, minN, tol) {
    const state = value == null || !(weight >= minN) ? 'unknown'
        : drift == null || drift > tol ? 'settling' : 'settled';
    return { value, n: round(weight, 1), drift: drift == null ? null : round(drift, 5), state };
}

// ── One hand ────────────────────────────────────────────────────────────────

export class OnlineHand {
    /** @param {string} handedness @param {typeof HAND_MODEL_DEFAULTS} o - held by reference */
    constructor(handedness, o) {
        this.handedness = handedness;
        this.o = o;
        this.reset();
    }

    /** Forget everything (or one part: bones|pinch|volume|noise|template|neutral). */
    reset(part = null) {
        const o = this.o;
        const all = part == null;
        if (all || part === 'bones') {
            /** Prior bone ratios to S: the reference skeleton, or the user's own from a warm start. */
            this.ratios = { ...REFERENCE_RATIOS };
            this._skin = { w: 0, x: 0, y: 0, xx: 0, xy: 0, d: 0, dd: 0, t: null };
            this._flex = new Array(JOINT_COUNT).fill(null); // last frame's flexion per joint (repair continuity)
            this.bones = new Map(CHAIN_BONES.map(([a, b]) => [boneKey(a, b), {
                hist: new DecayHist({ min: 0, max: 0.15, bin: 0.00025, tau: o.boneTauS }), drift: new Drift(o.driftWindowS),
                poses: 0, lastPose: -1,
            }]));
            this._boneMed = new Map();
            this._bonesAt = -Infinity;
        }
        if (all || part === 'pinch') {
            this.pinch = new DecayHist({ min: 0, max: 2.5, bin: 0.005, tau: o.pinchTauS });
            this.pinchDrift = { on: new Drift(o.driftWindowS), off: new Drift(o.driftWindowS) };
            this._pinch = null;
        }
        if (all || part === 'volume') this._resetVolume();
        if (all || part === 'noise') {
            this.noise = ['x', 'y', 'z'].map(() => new DecayHist({ min: 0, max: 0.02, bin: 0.00002, tau: o.noiseTauS }));
            this.noiseDrift = new Drift(o.driftWindowS);
            this.still = false;
            this._ring = [];
            this._stillAt = -Infinity;
        }
        if (all || part === 'template') {
            this.residual = PALM_JOINTS.map(() => new DecayHist({ min: 0, max: 0.03, bin: 0.00005, tau: o.noiseTauS }));
            this.template = PALM_JOINTS.map(() => ['x', 'y', 'z'].map(() => new DecayHist({ min: -0.12, max: 0.12, bin: 0.00025, tau: o.templateTauS })));
            this.templateDrift = new Drift(o.driftWindowS);
            this._template = null;
        }
        if (all || part === 'neutral' || part === 'volume') this._resetNeutral();
        if (all) {
            this.palm = new PalmTracker(o.minConfidence);
            this.probe = new VelocityProbe(0.15);
            this.frames = 0;
            this.lastT = null;
            this.dt = null;               // mean frame interval (EMA), s
            this.labelSeen = 0; this.labelAgree = 0; // Vision's label vs the vote, on fed frames
            this.pose = 0; this._poseAt = null; this._poseEma = null; // independent-pose counter (palm moved / turned)
            this.live = null;
        }
    }

    /** @private */
    _resetVolume() {
        const o = this.o;
        /** Bumped each time the volume starts over (a phone bump, a reset): a frozen mapping re-learns. */
        this.volumeEpoch = (this.volumeEpoch ?? 0) + 1;
        this.volume = {
            x: new DecayHist({ min: -0.6, max: 0.6, bin: 0.002, tau: o.volumeTauS }),
            y: new DecayHist({ min: -0.6, max: 0.6, bin: 0.002, tau: o.volumeTauS }),
            z: new DecayHist({ min: 0, max: 1.2, bin: 0.002, tau: o.volumeTauS }),
        };
        this.volumeDrift = { min: new Drift(this.o.driftWindowS), max: new Drift(this.o.driftWindowS) };
        this._volume = null;
    }

    /** @private */
    _resetNeutral() { this._neutralAcc = null; this.neutral = null; this.neutralWeight = 0; this._neutralAt = null; }

    /** The phone moved: what was measured in its frame is re-learned; the hand's own measures stay. */
    resetPhoneFrame() { this._resetVolume(); this._resetNeutral(); this.palm.reset(); this.probe.reset(); this._ring = []; }

    /**
     * Learn from one frame and return the live view of it. `hand.handedness` is the voted one.
     * @param {HandFrame} hand @param {number} t - seconds, device clock
     */
    feed(hand, t) {
        const o = this.o, m = o.minConfidence;
        if (this.lastT != null && t > this.lastT) {
            const d = t - this.lastT;
            if (d < 1) this.dt = this.dt == null ? d : this.dt + 0.05 * (d - this.dt);
        }
        this.lastT = t;
        this.frames++;
        const raw = hand.points ? hand.points.map((_, j) => seen(hand, j, m)) : new Array(JOINT_COUNT).fill(null);
        this._conf = hand.confidence;
        // Skin depth: palm length against 1/range, then every point moved back along its ray.
        this._learnSkin(raw, t);
        const rp = this.skin(), rf = rp * o.skinFingerFrac;
        const pts = raw.map((p, j) => (p ? vscale(p, 1 + (PALM_JOINTS.includes(j) ? rp : rf) / len(p)) : null));

        // A new independent pose: the palm (averaged over ~0.25 s, so joint jitter can't fake one)
        // moved posePalmM or turned posePalmDeg since the last pose counted.
        const w0 = pts[Joint.WRIST], i0 = pts[Joint.INDEX_MCP], p0 = pts[Joint.PINKY_MCP];
        if (w0 && i0 && p0) {
            const c = centroid([w0, i0, p0]);
            const n = norm(cross(sub(i0, w0), sub(p0, w0)));
            const e = this._poseEma;
            const k = e ? 1 - Math.exp(-Math.max(0, t - e.t) / 0.25) : 1;
            this._poseEma = e
                ? { t, c: { x: e.c.x + k * (c.x - e.c.x), y: e.c.y + k * (c.y - e.c.y), z: e.c.z + k * (c.z - e.c.z) },
                    n: norm({ x: e.n.x + k * (n.x - e.n.x), y: e.n.y + k * (n.y - e.n.y), z: e.n.z + k * (n.z - e.n.z) }) }
                : { t, c, n };
            const cur = this._poseEma, last = this._poseAt;
            if (!last || dist(cur.c, last.c) > o.posePalmM || angleDeg(cur.n, last.n) > o.posePalmDeg) { this.pose++; this._poseAt = { c: cur.c, n: cur.n }; }
        }
        for (const [a, b] of CHAIN_BONES) {
            if (!pts[a] || !pts[b]) continue;
            const d = sub(pts[b], pts[a]);
            const L = len(d);
            if (!(L > 0)) continue;
            const dir = vscale(d, 1 / L);
            const ray = norm({ x: (pts[a].x + pts[b].x) / 2, y: (pts[a].y + pts[b].y) / 2, z: (pts[a].z + pts[b].z) / 2 });
            const c = dir.x * ray.x + dir.y * ray.y + dir.z * ray.z;
            const w = 1 - c * c;
            if (w < o.boneMinRayWeight) continue; // pointing at the camera: its length is mostly depth error
            const bone = this.bones.get(boneKey(a, b));
            const D = (len(pts[a]) + len(pts[b])) / 2;
            bone.hist.add(L, t, w * this._rangeWeight(D));
            if (bone.lastPose !== this.pose) { bone.poses++; bone.lastPose = this.pose; }
        }
        if (t - this._bonesAt >= NOW_EVERY_S) { this._bonesAt = t; this._refreshBones(t); }

        const repaired = this.repair(hand, pts);
        const center = this.palm.centerOf(pts, t);
        const v = center ? this.probe.push(center, t) : null;
        if (!center) this.probe.reset();

        if (center) {
            this.volume.x.add(center.x, t); this.volume.y.add(center.y, t); this.volume.z.add(center.z, t);
            this._stillness(center, v, t);
        }
        this._learnTemplate(pts, t);
        const pose = this._pose(pts, t);
        this._learnPinch(pts, t);

        if (t - (this._slowAt ?? -Infinity) >= NOW_EVERY_S) { this._slowAt = t; this._refresh(t); }

        const S = this._boneMed.get(boneKey(Joint.WRIST, Joint.MIDDLE_MCP));
        const a = repaired.points[Joint.THUMB_TIP], b = repaired.points[Joint.INDEX_TIP];
        this.live = {
            t, points: repaired.points, rebuilt: repaired.rebuilt, palm: center, velocity: v,
            normal: palmFacing(repaired.points, hand.handedness), pose, still: this.still,
            pinchDistance: a && b ? dist(a, b) : null, scale: S ?? null,
        };
        return this.live;
    }

    /** A sample's inverse-variance weight at range D, relative to rangeRefM. @private */
    _rangeWeight(D) {
        const k = this.o.rangeNoiseExp;
        return k ? (this.o.rangeRefM / Math.max(0.05, D)) ** (2 * k) : 1;
    }

    /** Enough weight, from enough independent poses. @private */
    _boneKnown(b) { return b.hist.weight >= this.o.boneMinN && b.poses >= this.o.bonePoses; }

    /**
     * Bone lengths: S × ratio × (1 + δ), δ = the bone's measured deviation from S × ratio,
     * shrunk toward 0 by poses / (poses + bonePoses). S (the 0-9 bone) needs only weight — the
     * palm is rigid and always in view — so every bone has a usable length within half a second.
     * @private
     */
    _refreshBones(t) {
        const o = this.o;
        const sb = this.bones.get('0-9');
        const S = sb.hist.weight >= o.boneMinN ? sb.hist.quantile(0.5) : null;
        for (const [k, b] of this.bones) {
            if (!S) { this._boneMed.set(k, null); continue; }
            if (k === '0-9') { this._boneMed.set(k, S); b.drift.push(S, t); continue; }
            const base = S * this.ratios[k];
            const med = b.hist.weight > 0 ? b.hist.quantile(0.5) : null;
            const delta = med != null ? (med / base - 1) * (b.poses / (b.poses + o.bonePoses)) : 0;
            const L = base * (1 + delta);
            this._boneMed.set(k, L);
            b.drift.push(L, t);
        }
    }

    /** Whether the skin depth comes from the hand's own heights yet. @private */
    _skinMeasured() {
        const k = this._skin;
        if (!(k.w > 0)) return false;
        const md = k.d / k.w;
        return Math.sqrt(Math.max(0, k.dd / k.w - md * md)) >= this.o.skinMinSpread;
    }

    /** The skin depth the correction uses, m: the learned one if `skinLearn` and it's in range, else the prior. */
    skin() {
        const prior = this._skinPrior ?? this.o.skinPrior;
        if (!this.o.skinLearn) return prior;
        const est = this.learnedSkin();
        return est != null && est >= this.o.skinMin && est <= this.o.skinMax ? est : prior;
    }

    /** The regression's own estimate of the skin depth, m (unclamped), or null until heights spread. */
    learnedSkin() {
        const k = this._skin, o = this.o;
        const prior = null;
        if (!(k.w > 0)) return prior;
        const mx = k.x / k.w, my = k.y / k.w;
        const vx = k.xx / k.w - mx * mx;
        const md = k.d / k.w, sdD = Math.sqrt(Math.max(0, k.dd / k.w - md * md));
        if (!(vx > 0) || sdD < o.skinMinSpread) return prior;
        const b = (k.xy / k.w - mx * my) / vx, a = my - b * mx;
        if (!(a > 0)) return prior;
        return -b / a;
    }

    /**
     * One palm-length sample into the decaying regression S_meas = S − S·r·x. Moving each end of
     * a bone r back along its OWN ray lengthens it by r·(1 − cos²θ)/D, θ between the bone and the
     * line of sight to its middle — not r/D: a bone seen off-axis is partly along the sight line.
     * (With x = 1/D alone a roaming hand under-reads r by a quarter.)
     * @private
     */
    _learnSkin(raw, t) {
        const w = raw[Joint.WRIST], mm = raw[Joint.MIDDLE_MCP];
        if (!w || !mm) return;
        const k = this._skin;
        const keep = k.t == null ? 1 : Math.exp(-Math.max(0, t - k.t) / this.o.skinTauS);
        k.t = t;
        const D = (len(w) + len(mm)) / 2, y = dist(w, mm);
        const u = norm(sub(mm, w)), m = norm({ x: (w.x + mm.x) / 2, y: (w.y + mm.y) / 2, z: (w.z + mm.z) / 2 });
        const c = u.x * m.x + u.y * m.y + u.z * m.z;
        const x = (1 - c * c) / D;
        k.w = k.w * keep + 1; k.x = k.x * keep + x; k.y = k.y * keep + y;
        k.xx = k.xx * keep + x * x; k.xy = k.xy * keep + x * y; k.d = k.d * keep + D; k.dd = k.dd * keep + D * D;
    }

    /**
     * Rebuild joints from the calibrated bones: a joint seen in 2-D with no depth (a ray, no
     * point), or whose depth puts it more than `boneGate` off its bone length, is placed along
     * its ray at the bone length from its parent (research §2.5). Chains run base → tip, so a
     * rebuilt joint can parent the next. Null joints without a ray stay null.
     * @param {HandFrame} hand
     * @param {(Vec3|null)[]} [measured] - confidence-gated points (computed if omitted)
     * @returns {{points: (Vec3|null)[], rebuilt: boolean[]}}
     */
    repair(hand, measured = null) {
        const m = this.o.minConfidence;
        const out = measured ? [...measured] : (hand.points || []).map((_, j) => seen(hand, j, m));
        while (out.length < JOINT_COUNT) out.push(null);
        const rebuilt = new Array(JOINT_COUNT).fill(false);
        // The palm side (fingers flex toward it), for the joint-limit test.
        const palmSide = palmFacing(out, hand.handedness);
        for (let j = 1; j < JOINT_COUNT; j++) {
            const par = out[PARENT[j]];
            const L = this._boneMed.get(boneKey(PARENT[j], j));
            if (!par || !L) continue;
            const p = out[j];
            let ray, prefer;
            if (p) {
                if (Math.abs(dist(p, par) - L) <= this.o.boneGate * L) { this._flex[j] = this._flexOf(out, j, p, palmSide); continue; }
                ray = norm(p); prefer = len(p);
            } else {
                ray = hand.rays?.[j];
                if (!ray) continue;
                prefer = len(par);
            }
            out[j] = this._pickRoot(out, j, ray, par, L, prefer, palmSide);
            rebuilt[j] = true;
        }
        return { points: out, rebuilt };
    }

    /**
     * The flexion of joint j's bone from its parent bone, degrees, toward the palm side
     * (negative = hyperextended); null where there's no grandparent or no palm side.
     * @private
     */
    _flexOf(pts, j, p, palmSide) {
        const P = PARENT[j], G = PARENT[P];
        if (G < 0 || !palmSide || !pts[P] || !pts[G]) return null;
        const u = norm(sub(pts[P], pts[G]));
        const v = norm(sub(p, pts[P]));
        const np = sub(palmSide, vscale(u, palmSide.x * u.x + palmSide.y * u.y + palmSide.z * u.z));
        const nl = len(np);
        if (!(nl > 1e-6)) return null;
        const n = vscale(np, 1 / nl);
        return (Math.atan2(v.x * n.x + v.y * n.y + v.z * n.z, v.x * u.x + v.y * u.y + v.z * u.z) * 180) / Math.PI;
    }

    /**
     * Of the two points on the ray at bone length L from the parent, keep one whose bend is
     * anatomically possible (FLEX_LIMITS); with both possible, the one nearer last frame's bend
     * (a DIP also leans to ⅔ of its PIP's); with neither, the one nearer `prefer` along the ray.
     * @private
     */
    _pickRoot(pts, j, ray, par, L, prefer, palmSide) {
        const b = ray.x * par.x + ray.y * par.y + ray.z * par.z;
        const disc = b * b - (par.x * par.x + par.y * par.y + par.z * par.z) + L * L;
        if (disc < 0 || !this.o.repairLimits) { const r = raySphere(ray, par, L, prefer).p; this._flex[j] = this._flexOf(pts, j, r, palmSide); return r; }
        const cands = [b - Math.sqrt(disc), b + Math.sqrt(disc)].map((s) => {
            const q = vscale(ray, s);
            return { q, s, flex: this._flexOf(pts, j, q, palmSide) };
        });
        const lim = FLEX_LIMITS[j];
        const legal = lim ? cands.filter((c) => c.flex != null && c.flex >= lim[0] && c.flex <= lim[1]) : [];
        let pick;
        if (legal.length === 1) pick = legal[0];
        else if (legal.length === 2) {
            const isDip = [8, 12, 16, 20].includes(j);
            const want = isDip && this._flex[j - 1] != null ? (2 / 3) * this._flex[j - 1] : this._flex[j];
            pick = want != null
                ? (Math.abs(legal[0].flex - want) <= Math.abs(legal[1].flex - want) ? legal[0] : legal[1])
                : (Math.abs(legal[0].s - prefer) <= Math.abs(legal[1].s - prefer) ? legal[0] : legal[1]);
        } else pick = Math.abs(cands[0].s - prefer) <= Math.abs(cands[1].s - prefer) ? cands[0] : cands[1];
        this._flex[j] = pick.flex;
        return pick.q;
    }

    /** Find still windows; measure their jitter. @private */
    _stillness(center, v, t) {
        const o = this.o;
        const r = this._ring;
        r.push({ t, c: center });
        while (r.length && r[0].t < t - o.stillWindowS) r.shift();
        this.still = false;
        if (r.length < 6 || r[r.length - 1].t - r[0].t < o.stillWindowS * 0.9) return;
        const c = centroid(r.map((e) => e.c));
        let x = 0, y = 0, z = 0;
        for (const e of r) { x += (e.c.x - c.x) ** 2; y += (e.c.y - c.y) ** 2; z += (e.c.z - c.z) ** 2; }
        const n = r.length, rx = Math.sqrt(x / n), ry = Math.sqrt(y / n), rz = Math.sqrt(z / n);
        const speed = v ? Math.hypot(v.x, v.y, v.z) : Infinity;
        if (Math.hypot(rx, ry, rz) > o.stillRms || speed > o.stillSpeed) return;
        this.still = true;
        // One sample per window length: overlapping windows would repeat the same jitter.
        if (t - this._stillAt < o.stillWindowS) return;
        this._stillAt = t;
        this.noise[0].add(rx, t); this.noise[1].add(ry, t); this.noise[2].add(rz, t);
    }

    /** The rigid palm in its own frame, from flat-ish frames. @private */
    _learnTemplate(pts, t) {
        const palm = PALM_JOINTS.map((j) => pts[j]);
        if (!palm.every(Boolean)) return;
        const plane = fitPlane(palm);
        if (!plane || plane.rms > this.o.templateFlatRms) return;
        const { f, s, n } = palmFrame(palm);
        const c = centroid(palm);
        const rw = this._rangeWeight(len(c));
        palm.forEach((p, i) => {
            const d = sub(p, c);
            const h = this.template[i];
            h[0].add(d.x * s.x + d.y * s.y + d.z * s.z, t, rw);
            h[1].add(d.x * f.x + d.y * f.y + d.z * f.z, t, rw);
            h[2].add(d.x * n.x + d.y * n.y + d.z * n.z, t, rw);
        });
    }

    /** Palm orientation (Kabsch onto the template) and the neutral it's measured from. @private */
    _pose(pts, t) {
        const k = this._fitPalm(pts, this._conf);
        if (!k) return null;
        // Each palm joint's residual: how far off the rigid palm it sits — its learned weight.
        k.residuals.forEach((r, n) => this.residual[k.idx[n]].add(r, t));
        let qa = k.q;
        // Learn the neutral while the hand rests: a decaying average of aligned quaternions.
        if (this.still) {
            const acc = this._neutralAcc;
            if (acc && acc.w * qa.w + acc.x * qa.x + acc.y * qa.y + acc.z * qa.z < 0) qa = { w: -qa.w, x: -qa.x, y: -qa.y, z: -qa.z };
            const dt = this._neutralAt == null ? 0 : t - this._neutralAt;
            const keep = Math.exp(-dt / this.o.neutralTauS);
            this._neutralAt = t;
            this._neutralAcc = acc
                ? { w: acc.w * keep + qa.w, x: acc.x * keep + qa.x, y: acc.y * keep + qa.y, z: acc.z * keep + qa.z }
                : { ...qa };
            this.neutralWeight = this.neutralWeight * keep + 1;
            this.neutral = qnorm(this._neutralAcc);
        }
        const rel = this.neutral ? yawPitchRoll(qmul(k.q, qconj(this.neutral))) : null;
        return { q: k.q, rms: k.rms, joints: k.idx.length, ...(rel || {}), fromNeutral: !!rel };
    }

    /** Weighted Kabsch of the palm template onto these points (no learning). @private */
    _fitPalm(pts, conf) {
        const tpl = this._template;
        if (!tpl) return null;
        const from = [], to = [], w = [], idx = [];
        const s0 = this.o.kabschSigma0 ** 2;
        PALM_JOINTS.forEach((j, i) => {
            if (!pts[j]) return;
            const sig = this.residual[i].weight >= 10 ? this.residual[i].quantile(0.5) : 0;
            from.push(tpl[i]); to.push(pts[j]); idx.push(i);
            w.push((conf?.[j] ?? 1) / (sig * sig + s0));
        });
        if (from.length < 4) return null;
        const k = kabsch(from, to, w);
        return k ? { ...k, idx } : null;
    }

    /**
     * The palm's pose from OTHER points (e.g. the cloud tracker's fit) against this hand's learned
     * template and neutral — read-only: nothing is learned from them.
     * @param {(Vec3|null)[]} pts @param {number[]|null} [conf]
     */
    poseFrom(pts, conf = null) {
        const k = this._fitPalm(pts, conf);
        if (!k) return null;
        const rel = this.neutral ? yawPitchRoll(qmul(k.q, qconj(this.neutral))) : null;
        return { q: k.q, rms: k.rms, joints: k.idx.length, ...(rel || {}), fromNeutral: !!rel };
    }

    /** @private */
    _learnPinch(pts, t) {
        const S = this._boneMed.get(boneKey(Joint.WRIST, Joint.MIDDLE_MCP));
        const a = pts[Joint.THUMB_TIP], b = pts[Joint.INDEX_TIP];
        if (S && a && b) this.pinch.add(dist(a, b) / S, t);
    }

    /** Recompute the slower summaries (a few times a second). @private */
    _refresh(t) {
        const o = this.o;
        // Template.
        if (this.template[0][0].weight >= o.templateMinN) {
            this._template = this.template.map((h) => ({ x: h[0].quantile(0.5), y: h[1].quantile(0.5), z: h[2].quantile(0.5) }));
            this.templateDrift.push(this._template[2].y, t); // the middle MCP's forward offset: the palm's length scale
        }
        // Volume.
        const V = this.volume;
        if (V.x.weight > 0) {
            const lo = o.volumeLowPct / 100, hi = o.volumeHighPct / 100;
            const min = { x: V.x.quantile(lo), y: V.y.quantile(lo), z: V.z.quantile(lo) };
            const max = { x: V.x.quantile(hi), y: V.y.quantile(hi), z: V.z.quantile(hi) };
            this._volume = {
                min, max,
                center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
                dwell: { x: V.x.quantile(0.5), y: V.y.quantile(0.5), z: V.z.quantile(0.5) },
                reach: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
            };
            this.volumeDrift.min.push(min.x + min.y + min.z, t);
            this.volumeDrift.max.push(max.x + max.y + max.z, t);
        }
        // Noise.
        const nz = this.noise.map((h) => h.quantile(0.5));
        if (nz[0] != null) this.noiseDrift.push(Math.hypot(nz[0], nz[1], nz[2]), t);
        // Pinch.
        this._pinch = this._pinchEstimate();
        if (this._pinch && !this._pinch.prior) { this.pinchDrift.on.push(this._pinch.on, t); this.pinchDrift.off.push(this._pinch.off, t); }
    }

    /** @private */
    _pinchEstimate() {
        const o = this.o;
        const S = this._boneMed.get(boneKey(Joint.WRIST, Joint.MIDDLE_MCP));
        if (!S) return null;
        const prior = { on: o.pinchPriorOn, off: o.pinchPriorOff, closed: null, open: null, scale: S, prior: true };
        if (!(this.pinch.weight > 0)) return prior;
        // The open hand: the median of the upper bulk (above a first cut at half the overall
        // 75th percentile, so a lot of pinching can't drag it down); closed: below half of that.
        const first = this.pinch.split(o.pinchCutFrac * this.pinch.quantile(0.75)).hi;
        const open = first?.median;
        if (open == null) return prior;
        const { lo } = this.pinch.split(o.pinchCutFrac * open);
        if (!lo || lo.weight < o.pinchMinClosed || open < o.pinchMinRatio * lo.median) {
            return { ...prior, open, closedWeight: lo?.weight ?? 0 };
        }
        const range = open - lo.median;
        return {
            closed: lo.median, open, wide: this.pinch.quantile(0.99),
            on: lo.median + range * o.pinchOnFrac, off: lo.median + range * o.pinchOffFrac,
            scale: S, prior: false, closedWeight: lo.weight,
        };
    }

    /** Whether the volume has settled (its bounds stopped moving). @private */
    _volumeState() {
        const vd = Math.max(this.volumeDrift.min.drift ?? Infinity, this.volumeDrift.max.drift ?? Infinity);
        return q(1, this.volume.x.weight, Number.isFinite(vd) ? vd : null, this.o.volumeMinN, this.o.volumeSettled).state;
    }

    /** The model's current values, as the HandSpace stages and the pinch tracker read them. */
    summary() {
        const nz = this.noise.map((h) => h.quantile(0.5));
        const noiseKnown = this.noise[0].weight >= this.o.noiseMinN;
        return {
            handedness: this.handedness,
            rate: this.dt ? 1 / this.dt : null,
            noise: noiseKnown ? { x: nz[0], y: nz[1], z: nz[2], rms: Math.hypot(nz[0], nz[1], nz[2]) } : null,
            volume: this.volume.x.weight >= this.o.volumeMinN ? { ...this._volume, state: this._volumeState(), epoch: this.volumeEpoch } : null,
            pinch: this._pinch,
            scale: this._boneMed.get(boneKey(Joint.WRIST, Joint.MIDDLE_MCP)) ?? null,
        };
    }

    /**
     * Every quantity with its value, weight, drift and state. While the hand is out of view
     * (`now` − its last frame > idleS) nothing is learning, so a quantity that was settling reads
     * `idle` instead.
     * @param {number|null} [now] - seconds, device clock
     */
    status(now = null) {
        const o = this.o;
        const idleS = now != null && this.lastT != null && now - this.lastT > o.idleS ? now - this.lastT : null;
        const st = this._status();
        if (idleS == null) return st;
        const pause = (x) => { if (x?.state === 'settling') x.state = 'idle'; };
        for (const k of ['scale', 'handSize', 'bones', 'volume', 'noise', 'pinch', 'template', 'neutral']) pause(st[k]);
        for (const b of Object.values(st.bones.each)) pause(b);
        st.idle = round(idleS, 1);
        st.still = false;
        return st;
    }

    /** @private */
    _status() {
        const o = this.o;
        const bones = {};
        let size = 0, sizeKnown = true;
        for (const [k, b] of this.bones) {
            const med = b.hist.quantile(0.5);
            const L = this._boneMed.get(k);
            bones[k] = q(L != null ? round(L, 4) : null, k === '0-9' ? b.hist.weight : Math.max(b.hist.weight, L != null ? o.boneMinN : 0), b.drift.drift, o.boneMinN, o.boneSettled);
            bones[k].poses = b.poses;
            bones[k].measured = med != null ? round(med, 4) : null;
            // How much of the length is still the reference skeleton's (1 = all prior).
            bones[k].prior = k === '0-9' ? 0 : round(o.bonePoses / (b.poses + o.bonePoses), 2);
            if (k !== '0-9' && b.poses < o.bonePoses && bones[k].state === 'settled') bones[k].state = 'settling';
        }
        for (const k of ['0-9', '9-10', '10-11', '11-12']) {
            if (bones[k].value == null) sizeKnown = false; else size += bones[k].value;
        }
        const S = bones['0-9'];
        const V = this._volume;
        const vw = this.volume.x.weight;
        const vd = Math.max(this.volumeDrift.min.drift ?? Infinity, this.volumeDrift.max.drift ?? Infinity);
        const nz = this.noise.map((h) => h.quantile(0.5));
        const P = this._pinch;
        const pd = Math.max(this.pinchDrift.on.drift ?? Infinity, this.pinchDrift.off.drift ?? Infinity);
        const tw = this.template[0][0].weight;
        const stateOf = (list) => (list.every((x) => x.state === 'settled') ? 'settled' : list.some((x) => x.state === 'unknown') ? 'unknown' : 'settling');
        const boneList = Object.values(bones);
        return {
            handedness: this.handedness,
            frames: this.frames,
            rate: this.dt ? round(1 / this.dt, 1) : null,
            // Vision's label against the vote: mostly disagreeing = Vision sees this hand mirrored.
            labelAgreement: this.labelSeen ? round(this.labelAgree / this.labelSeen, 3) : null,
            handednessMirrored: this.labelSeen >= 10 ? this.labelAgree / this.labelSeen < 0.5 : null,
            idle: null,
            still: this.still,
            scale: S,
            handSize: { value: sizeKnown ? round(size, 4) : null, state: sizeKnown ? stateOf(['0-9', '9-10', '10-11', '11-12'].map((k) => bones[k])) : 'unknown' },
            bones: { state: stateOf(boneList), settled: boneList.filter((b) => b.state === 'settled').length, of: boneList.length, each: bones },
            volume: q(V ? { min: roundV(V.min, 4), max: roundV(V.max, 4), center: roundV(V.center, 4), dwell: roundV(V.dwell, 4), reach: roundV(V.reach, 4) } : null,
                vw, Number.isFinite(vd) ? vd : null, o.volumeMinN, o.volumeSettled),
            noise: q(nz[0] != null ? { x: round(nz[0], 5), y: round(nz[1], 5), z: round(nz[2], 5), rms: round(Math.hypot(nz[0], nz[1], nz[2]), 5) } : null,
                this.noise[0].weight, this.noiseDrift.drift, o.noiseMinN, o.noiseSettled),
            pinch: P?.prior
                ? { value: { on: P.on, off: P.off, open: round(P.open, 4) }, n: round(this.pinch.weight, 1), drift: null, state: 'unknown', prior: true, why: `no pinch seen yet (${round(P.closedWeight ?? 0, 1)} of ${o.pinchMinClosed} closed frames) — research priors` }
                : q(P ? { closed: round(P.closed, 4), open: round(P.open, 4), wide: round(P.wide, 4), on: round(P.on, 4), off: round(P.off, 4), closedFrames: round(P.closedWeight, 1) } : null,
                    this.pinch.weight, Number.isFinite(pd) ? pd : null, o.boneMinN, o.pinchSettled),
            template: {
                ...q(this._template ? this._template.map((p) => roundV(p, 4)) : null, tw, this.templateDrift.drift, o.templateMinN, o.templateSettled),
                // Each palm joint's typical Kabsch residual (wrist, index, middle, ring, pinky MCP), m.
                sigma: this.residual.map((h) => (h.weight >= 10 ? round(h.quantile(0.5), 5) : null)),
            },
            skin: {
                value: round(this.skin(), 4),
                state: o.skinLearn && this._skinMeasured() ? 'settled' : 'unknown',
                // The regression's estimate, shown either way: a diagnostic of how far the hand's
                // apparent size moves with height.
                learned: this._skinMeasured() ? round(this.learnedSkin(), 4) : null,
                why: o.skinLearn ? (this._skinMeasured() ? null : 'the prior, until the hand has moved up and down a few cm') : 'the prior (learning it is off — see skinLearn)',
            },
            neutral: { value: this.neutral ? roundV({ x: this.neutral.x, y: this.neutral.y, z: this.neutral.z }, 4) : null, n: round(this.neutralWeight, 1), state: this.neutral ? (this.neutralWeight >= 10 ? 'settled' : 'settling') : 'unknown' },
        };
    }

    /** The estimates as plain JSON — a warm start for the next session. */
    snapshot() {
        const s = this.summary();
        const bones = {};
        for (const [k, b] of this.bones) if (this._boneKnown(b)) bones[k] = b.hist.quantile(0.5);
        const S = this._boneMed.get('0-9');
        return {
            handedness: this.handedness,
            bones,
            // The user's own ratios to S (every bone with a length), the prior for the next session.
            ratios: S ? Object.fromEntries([...this._boneMed].filter(([, L]) => L != null).map(([k, L]) => [k, L / S])) : null,
            skin: this.o.skinLearn && this._skinMeasured() ? this.skin() : null,
            template: this._template,
            noise: s.noise,
            volume: this._volume && this.volume.x.weight >= this.o.volumeMinN ? { min: this._volume.min, max: this._volume.max, dwell: this._volume.dwell } : null,
            pinch: s.pinch && !s.pinch.prior ? { closed: s.pinch.closed, open: s.pinch.open } : null,
            neutral: this.neutral,
        };
    }

    /**
     * Start from a snapshot: each estimate gets the snapshot's value at the weight of
     * max(`priorWeight`, the samples it needs to count as known) — usable at once, light
     * enough that live frames outweigh it within seconds.
     * @param {ReturnType<OnlineHand['snapshot']>} snap @param {number} t
     */
    seed(snap, t) {
        const o = this.o;
        const w = (minN) => Math.max(o.priorWeight, minN);
        if (snap?.ratios) Object.assign(this.ratios, snap.ratios);
        // The saved skin depth is the prior until this session's own heights have spread.
        if (snap?.skin != null) this._skinPrior = snap.skin;
        for (const [k, v] of Object.entries(snap?.bones || {})) {
            const b = this.bones.get(k);
            if (!b) continue;
            b.hist.add(v, t, w(o.boneMinN));
            b.poses = Math.max(b.poses, o.bonePoses); // the saved value came from many poses
        }
        if (snap?.template) {
            const wt = w(o.templateMinN);
            snap.template.forEach((p, i) => { this.template[i][0].add(p.x, t, wt); this.template[i][1].add(p.y, t, wt); this.template[i][2].add(p.z, t, wt); });
        }
        if (snap?.noise) { const wn = w(o.noiseMinN); this.noise[0].add(snap.noise.x, t, wn); this.noise[1].add(snap.noise.y, t, wn); this.noise[2].add(snap.noise.z, t, wn); }
        if (snap?.volume) {
            const wv = w(o.volumeMinN);
            for (const a of ['x', 'y', 'z']) {
                this.volume[a].add(snap.volume.min[a], t, wv / 4);
                this.volume[a].add(snap.volume.max[a], t, wv / 4);
                this.volume[a].add(snap.volume.dwell[a], t, wv / 2);
            }
        }
        if (snap?.pinch) { const wp = w(o.boneMinN); this.pinch.add(snap.pinch.closed, t, Math.max(wp / 4, o.pinchMinClosed)); this.pinch.add(snap.pinch.open, t, Math.max(wp, 4 * o.pinchMinClosed)); }
        if (snap?.neutral) { this.neutral = snap.neutral; this._neutralAcc = { ...snap.neutral }; this.neutralWeight = 1; this._neutralAt = t; }
        this._bonesAt = -Infinity; this._slowAt = -Infinity;
        // Medians now, so repair and pinch work from the first frame.
        this._refreshBones(t);
        this._refresh(t);
    }
}

// ── The device ──────────────────────────────────────────────────────────────

/**
 * Gravity, attitude and ceiling, tracked continuously. Each has a slow reference that follows
 * it (so CoreMotion's slow yaw drift never reads as a move); a BUMP is the fast reading leaving
 * its reference by more than `bumpDeg` (or `bumpCeilingM`, when on) for `bumpHoldS` — or, for a
 * slide that turns nothing (invisible to gravity and attitude), `userAcceleration` above
 * `bumpAccel` on `bumpAccelFrames` frames within `bumpAccelWindowS` (one frame could be a knock).
 * This is change-point detection by hand-set threshold + hold — a stand-in for CUSUM /
 * Page–Hinkley (with their known false-alarm vs delay trade-off) or Bayesian online change-point
 * detection (Adams & MacKay 2007), either of which could replace it.
 */
export class DeviceTracker {
    /** @param {typeof HAND_MODEL_DEFAULTS} o */
    constructor(o) { this.o = o; this.reset(); }
    reset() {
        this.last = null; this.g = null; this.gRef = null; this.att = null; this.attRef = null;
        this.ceiling = null; this.ceilingRef = null; this._t = null; this._offSince = null;
        this.bumps = 0; this.lastBump = null; this.steadyDeg = null;
        this._accelHits = []; this.accelPeak = 0;
    }
    /** @param {DeviceState|null} d @param {number} t @returns {boolean} true on a bump */
    feed(d, t) {
        if (!d) return false;
        this.last = d;
        const dt = this._t == null ? 0 : Math.max(0, t - this._t);
        this._t = t;
        const fast = 1 - Math.exp(-dt / 0.2), slow = 1 - Math.exp(-dt / this.o.deviceRefTauS);
        let off = 0, ceilOff = 0;
        if (d.gravity) {
            const g = fromArray(d.gravity);
            this.g = this.g ? norm({ x: this.g.x + fast * (g.x - this.g.x), y: this.g.y + fast * (g.y - this.g.y), z: this.g.z + fast * (g.z - this.g.z) }) : g;
            this.gRef = this.gRef ? norm({ x: this.gRef.x + slow * (this.g.x - this.gRef.x), y: this.gRef.y + slow * (this.g.y - this.gRef.y), z: this.gRef.z + slow * (this.g.z - this.gRef.z) }) : this.g;
            this.steadyDeg = angleDeg(g, this.g);
            off = Math.max(off, angleDeg(this.g, this.gRef));
        }
        if (d.attitude) {
            let a = { x: d.attitude[0], y: d.attitude[1], z: d.attitude[2], w: d.attitude[3] };
            const blend = (cur, k) => {
                if (!cur) return a;
                if (cur.w * a.w + cur.x * a.x + cur.y * a.y + cur.z * a.z < 0) a = { w: -a.w, x: -a.x, y: -a.y, z: -a.z };
                return qnorm({ w: cur.w + k * (a.w - cur.w), x: cur.x + k * (a.x - cur.x), y: cur.y + k * (a.y - cur.y), z: cur.z + k * (a.z - cur.z) });
            };
            this.att = blend(this.att, fast);
            const at = this.att;
            this.attRef = this.attRef ? qnorm({ w: this.attRef.w + slow * (at.w - this.attRef.w), x: this.attRef.x + slow * (at.x - this.attRef.x), y: this.attRef.y + slow * (at.y - this.attRef.y), z: this.attRef.z + slow * (at.z - this.attRef.z) }) : at;
            off = Math.max(off, qangleDeg(this.att, this.attRef));
        }
        if (d.ceiling != null) {
            this.ceiling = this.ceiling == null ? d.ceiling : this.ceiling + fast * (d.ceiling - this.ceiling);
            this.ceilingRef = this.ceilingRef == null ? this.ceiling : this.ceilingRef + slow * (this.ceiling - this.ceilingRef);
            ceilOff = Math.abs(this.ceiling - this.ceilingRef);
        }
        if (d.userAcceleration && this.o.bumpAccel > 0) {
            const a = Math.hypot(...d.userAcceleration);
            this.accelPeak = Math.max(this.accelPeak * Math.exp(-dt / 2), a);
            const hits = this._accelHits;
            while (hits.length && hits[0] < t - this.o.bumpAccelWindowS) hits.shift();
            if (a > this.o.bumpAccel) hits.push(t);
            if (hits.length >= this.o.bumpAccelFrames) { this._accelHits = []; if (this._canBump(t)) return this._bump(t, `slid (|a| ${a.toFixed(2)} m/s²)`); }
        }
        const moved = off > this.o.bumpDeg || (this.o.bumpCeilingM > 0 && ceilOff > this.o.bumpCeilingM);
        if (!moved) { this._offSince = null; return false; }
        if (this._offSince == null) this._offSince = t;
        if (t - this._offSince < this.o.bumpHoldS) return false;
        if (!this._canBump(t)) {
            // Still the same move settling: follow it without another re-learn.
            this.gRef = this.g; this.attRef = this.att; this.ceilingRef = this.ceiling; this._offSince = null;
            return false;
        }
        return this._bump(t, ceilOff > this.o.bumpCeilingM && this.o.bumpCeilingM > 0 && off <= this.o.bumpDeg
            ? `ceiling jumped ${ceilOff.toFixed(3)} m` : `turned ${off.toFixed(1)}°`);
    }

    /** @private */
    _canBump(t) { return this.lastBump == null || t - this.lastBump >= this.o.bumpRefractoryS; }

    /** The phone moved: the references jump to its new pose. @private */
    _bump(t, cause) {
        this.lastBumpCause = cause;
        // A bump: the references jump to the new pose.
        this.gRef = this.g; this.attRef = this.att; this.ceilingRef = this.ceiling;
        this._offSince = null;
        this.bumps++; this.lastBump = t;
        return true;
    }
    status() {
        const d = this.last;
        return {
            wire: d ? `v${d.v}` : null,
            mount: d?.mount ?? null,
            gravityTiltDeg: this.g ? round(angleDeg(this.g, { x: 0, y: 0, z: -1 }), 2) : null,
            gravitySteadyDeg: this.steadyDeg != null ? round(this.steadyDeg, 3) : null,
            ceiling: this.ceiling != null ? round(this.ceiling, 3) : null,
            accelPeak: round(this.accelPeak, 3),
            bumps: this.bumps,
            lastBump: this.lastBump,
            lastBumpCause: this.lastBumpCause ?? null,
        };
    }
}

// ── Which hand ──────────────────────────────────────────────────────────────

const FINGER_JOINTS = [6, 7, 8, 10, 11, 12, 14, 15, 16, 18, 19, 20];

/**
 * One frame's left/right vote (positive = right). The anatomy: (p5 − p0) × (p17 − p0) points
 * out of a RIGHT palm. Which side the palm is comes from the fingers — they curl toward it — so
 * the anatomical vote counts in full only while that side clearly faces down (a palm turned up
 * would flip a test that assumed it faced down); a flat hand, horizontal, votes a little on the
 * palm-down prior; Vision's label votes a little.
 * @param {(Vec3|null)[]} pts - confidence-gated points
 * @param {string|undefined} label
 * @param {typeof HAND_MODEL_DEFAULTS} o
 */
export function chiralityVote(pts, label, o) {
    let v = label === 'right' ? o.voteLabel : label === 'left' ? -o.voteLabel : 0;
    const w = pts[Joint.WRIST], i = pts[Joint.INDEX_MCP], p = pts[Joint.PINKY_MCP];
    if (!w || !i || !p) return v;
    const cr = cross(sub(i, w), sub(p, w));
    const n = norm(cr);
    const palm = PALM_JOINTS.map((j) => pts[j]).filter(Boolean);
    const c = centroid(palm);
    let s = 0, k = 0;
    for (const j of FINGER_JOINTS) if (pts[j]) { const d = sub(pts[j], c); s += d.x * n.x + d.y * n.y + d.z * n.z; k++; }
    if (k >= 4 && Math.abs(s / k) >= o.curlMin) {
        // The palm is on the side the fingers curl to; right ⇔ the cross product points there.
        const side = s > 0 ? n : vscale(n, -1);
        if (side.z < -o.downCos) v += (s > 0 ? 1 : -1) * o.voteGeometry;
    } else if (Math.abs(n.z) > o.downCos) {
        v += (cr.z < 0 ? 1 : -1) * o.voteFlatPrior; // flat: assume the palm faces the phone
    }
    return v;
}

/** The point a hand is tracked by: its palm centroid (3+ palm joints), else every seen joint's. */
function anchorOf(pts) {
    const palm = PALM_JOINTS.map((j) => pts[j]).filter(Boolean);
    if (palm.length >= 3) return centroid(palm);
    const all = pts.filter(Boolean);
    return all.length ? centroid(all) : null;
}

// ── The model ───────────────────────────────────────────────────────────────

/**
 * The live model of every hand a device sees, and the device itself.
 * One frame at a time: `feed({t, device, hands})`.
 */
export default class HandModel {
    /** @param {Partial<typeof HAND_MODEL_DEFAULTS>} [opts] @param {Object|null} [warm] - a snapshot() */
    constructor(opts = {}, warm = null) {
        /** Held by reference by every part: a knob set here applies on the next frame. */
        this.opts = { ...HAND_MODEL_DEFAULTS, ...opts };
        this.device = new DeviceTracker(this.opts);
        /** @type {Map<string, OnlineHand>} */
        this.hands = new Map();
        /** Hands in view, matched frame to frame by continuity. */
        this.tracks = [];
        this._trackId = 0;
        this.warm = warm;
        this.lastT = null;
    }

    /**
     * The learned skeleton of one hand, for consumers that fit it (the LiDAR cloud tracker): bone
     * lengths along the finger chains ('a-b' keys, m) with how much each is the hand's own
     * measurement, the palm length, and the palm template in palm-local coordinates (side,
     * forward, normal about the palm centroid; PALM_JOINTS order). Null for a hand not seen.
     * @param {string} handedness
     * @returns {{bones: Record<string, {length: number|null, known: boolean, own: number, state: string}>, scale: number|null, template: Vec3[]|null, settled: boolean}|null}
     */
    skeleton(handedness) {
        const h = this.hands.get(handedness);
        if (!h) return null;
        const st = h.status(this.lastT);
        const bones = {};
        for (const [k, b] of h.bones) {
            const L = h._boneMed.get(k) ?? null;
            bones[k] = { length: L, known: h._boneKnown(b), own: k === '0-9' ? 1 : b.poses / (b.poses + this.opts.bonePoses), state: st.bones.each[k].state };
        }
        return { bones, scale: h._boneMed.get('0-9') ?? null, template: h._template ? h._template.map((p) => ({ ...p })) : null, settled: st.bones.state === 'settled' };
    }

    /** @param {string} handedness */
    hand(handedness) {
        let h = this.hands.get(handedness);
        if (!h) {
            h = new OnlineHand(handedness, this.opts);
            const snap = this.warm?.hands?.[handedness];
            if (snap) h.seed(snap, this.lastT ?? 0);
            this.hands.set(handedness, h);
        }
        return h;
    }

    /**
     * Learn from one frame.
     * @param {{t: number, device: DeviceState|null, hands: HandFrame[]}} frame
     * @returns {{bumped: boolean, hands: Record<string, Object>}} the live view of each hand seen
     */
    feed({ t, device, hands }) {
        const o = this.opts;
        this.lastT = t;
        const bumped = this.device.feed(device, t);
        if (bumped) for (const h of this.hands.values()) h.resetPhoneFrame();

        // Match this frame's hands to the tracks: nearest to where each track was HEADING (its last
        // palm + velocity × dt, so two hands passing each other keep their identities), within trackMaxJump.
        this.tracks = this.tracks.filter((tr) => t - tr.lastT <= o.trackLostS);
        // The vote reads un-offset points: skin makes palm joints read ~1.5 cm and fingers ~0.8 cm
        // nearer — enough to fake the fingers' curl. Which hand isn't known yet, so the prior r.
        const rp = o.skinPrior, rf = rp * o.skinFingerFrac;
        const found = (hands || []).map((hf) => {
            const pts = hf.points
                ? hf.points.map((_, j) => { const p = seen(hf, j, o.minConfidence); return p ? vscale(p, 1 + (PALM_JOINTS.includes(j) ? rp : rf) / len(p)) : null; })
                : [];
            return { hf, pts, anchor: anchorOf(pts) };
        }).filter((x) => x.anchor);
        const pairs = [];
        found.forEach((x, a) => this.tracks.forEach((tr, b) => {
            const dt = t - tr.lastT;
            const at = tr.vel ? { x: tr.anchor.x + tr.vel.x * dt, y: tr.anchor.y + tr.vel.y * dt, z: tr.anchor.z + tr.vel.z * dt } : tr.anchor;
            const d = dist(x.anchor, at);
            // A plausible hand speed since that track was last seen (a jump beyond it is another hand).
            if (d <= o.trackMaxSpeed * Math.max(dt, 1 / 120) + o.trackSlack) pairs.push({ a, b, d });
        }));
        pairs.sort((p, q) => p.d - q.d);
        const usedA = new Set(), usedB = new Set();
        for (const { a, b } of pairs) {
            if (usedA.has(a) || usedB.has(b)) continue;
            usedA.add(a); usedB.add(b);
            found[a].track = this.tracks[b];
        }
        for (const x of found) {
            if (!x.track) { x.track = { id: ++this._trackId, vote: 0, frames: 0, decided: null, since: t }; this.tracks.push(x.track); }
            const tr = x.track;
            if (tr.anchor && t > tr.lastT) {
                const dt = t - tr.lastT, k = 0.5;
                const v = { x: (x.anchor.x - tr.anchor.x) / dt, y: (x.anchor.y - tr.anchor.y) / dt, z: (x.anchor.z - tr.anchor.z) / dt };
                tr.vel = tr.vel ? { x: tr.vel.x + k * (v.x - tr.vel.x), y: tr.vel.y + k * (v.y - tr.vel.y), z: tr.vel.z + k * (v.z - tr.vel.z) } : v;
            }
            tr.anchor = x.anchor; tr.lastT = t; tr.frames++; tr.label = x.hf.handedness;
            const v = chiralityVote(x.pts, x.hf.handedness, o);
            tr.vote += v;
            const kr = tr.recentT == null ? 1 : 1 - Math.exp(-Math.max(0, t - tr.recentT) / o.recentTauS);
            tr.recent = tr.recent == null ? v : tr.recent + kr * (v - tr.recent);
            tr.recentT = t;
            // Recent evidence steadily against the decision: this track has picked up the other hand.
            if (tr.decided && (tr.decided === 'right' ? -tr.recent : tr.recent) > o.contradict) {
                tr.decided = null; tr.vote = tr.recent * o.decideFrames; tr.frames = 0;
            }
            if (tr.frames >= o.decideFrames && Math.abs(tr.vote) >= o.decideVotes) tr.decided = tr.vote > 0 ? 'right' : 'left';
        }

        // Feed each decided track's model; one track per hand per frame — the one whose recent
        // evidence agrees with that hand most.
        const live = {};
        const agree = (tr) => (tr.decided === 'right' ? 1 : -1) * (tr.recent ?? 0);
        for (const x of found.sort((p, q) => agree(q.track) - agree(p.track))) {
            const h = x.track.decided;
            if (!h || live[h]) continue;
            const model = this.hand(h);
            model.labelSeen++;
            if (x.hf.handedness === h) model.labelAgree++;
            live[h] = model.feed({ ...x.hf, handedness: h }, t);
            live[h].frame = x.hf; // the frame's own hand (its rays, its depth crop), for live consumers
        }
        return { bumped, hands: live };
    }

    /** Forget: everything, one hand, or one part of one/every hand (bones|pinch|volume|noise|template|neutral|device). */
    reset(handedness = null, part = null) {
        if (part === 'device') { this.device.reset(); return; }
        const targets = handedness ? [this.hands.get(handedness)].filter(Boolean) : [...this.hands.values()];
        if (!part && !handedness) { this.hands.clear(); this.tracks = []; this.device.reset(); this.warm = null; return; }
        for (const h of targets) h.reset(part);
    }

    status() {
        return {
            device: this.device.status(),
            hands: Object.fromEntries([...this.hands].map(([k, h]) => [k, h.status(this.lastT)])),
            tracks: this.tracks.map((tr) => ({ id: tr.id, frames: tr.frames, vote: round(tr.vote, 1), decided: tr.decided, label: tr.label })),
            warm: !!this.warm,
        };
    }

    snapshot() {
        return {
            v: 2,
            ceiling: this.device.ceiling,
            // A hand seen only briefly is not worth carrying into the next session.
            hands: Object.fromEntries([...this.hands].filter(([, h]) => h.frames >= this.opts.snapshotMinFrames).map(([k, h]) => [k, h.snapshot()])),
        };
    }
}

/**
 * HandStabilizer — the ONE stabilized hand every view draws. "If the finger doesn't move, the
 * hand doesn't jitter": a still hand should display under ~0.5 mm p95 at every joint, tips
 * included, while a moving one keeps up (its lag measured, not guessed — see handMetrics.js).
 *
 * It filters the hand in its OWN frame, the way it moves (the lesson of model-based trackers:
 * smooth inside the kinematic model, not 21 independent points):
 *   - the PALM POSE — position (One Euro per axis) and rotation (a One Euro on the quaternion:
 *     slerp by α from the angular speed) — taken from the palm joints;
 *   - every joint in PALM-LOCAL coordinates, each with its own One Euro per axis, so a still
 *     finger on a moving palm stays still, and a moving palm doesn't drag 21 filters' lag;
 *   - each filter's rest cutoff SOLVED from that joint's own measured noise (its jitter about a
 *     short line fit, sampled whenever the joint is locally still) for a target residual — a
 *     fingertip with 8 mm of noise gets a far lower cutoff than a knuckle with 1 mm. Until a
 *     joint's noise is measured, `fallbackCutoff`.
 * A joint unseen this frame holds its last local position for `holdS` (the hand doesn't blink).
 *
 * Pure: no DOM, no Three.js.
 */

import { cutoffForJitter } from './HandSpace.js';
import { PALM_JOINTS, centroid, sub, cross, norm, qmul, qconj, qnorm, qrot } from './handMath.js';
import { Joint, JOINT_COUNT } from './HandData.js';

/** @typedef {import('./handMath.js').Vec3} Vec3 */
/** @typedef {import('./handMath.js').Quat} Quat */

export const STABILIZER_DEFAULTS = {
    enabled: true,
    targetJitter: 0.00015,  // m rms per axis at rest, per joint (sim, realistic noise: worst joint 0.40 mm p95)
    beta: 10,               // cutoff Hz added per m/s of a joint's own (local) speed
    palmBeta: 10,           // … of the palm's speed
    rotBeta: 30,            // … per rad/s of the palm's turning, per axis (sim: tilt lag 75 ms p50 at rotTarget 2 mrad)
    rotTarget: 0.002,       // rad rms per axis at rest for the palm's rotation (× ~0.15 m to a fingertip ≈ 0.3 mm).
                            // The palm's rotation is read from a few joints' depth (~0.01 rad/frame): tighter
                            // costs pitch/roll lag (0.001 → ~0.8 s at rest). A cloud palm plane would ease it.
    leverM: 0.15,           // the lever from palm to fingertip — rotation stillness is judged at this radius
    dCutoff: 1,             // Hz, the speed estimate's own low-pass
    fallbackCutoff: 1,      // Hz, before a joint's noise is measured
    noiseWindowS: 0.5,      // a joint's noise: rms about a line fit over this long …
    stillSpeed: 0.01,       // … when that fit's speed is under this (m/s): the joint is locally still
    noiseTau: 30,           // still windows the noise estimate averages over (EMA count)
    holdS: 0.3,             // an unseen joint holds its last local position this long
    rotSpeedWindowS: 0.2,   // the palm's turning speed = a least-squares slope over this long (far less
                            // noise-driven than a filtered derivative; its noise floor is the deadband)
};

const alpha = (fc, dt) => 1 / (1 + 1 / (2 * Math.PI * fc * dt));

/**
 * A One Euro filter on one scalar with an externally set rest cutoff — and a speed DEADBAND: the
 * speed estimate of a noisy coordinate is never zero at rest (8 mm of tip noise reads as ~0.1 m/s
 * through a 1 Hz speed filter), and the stock β·|speed| term would hold the filter open on noise
 * alone. Speed up to `noiseSpeed` (what this coordinate's own noise produces) opens nothing.
 */
class Euro {
    constructor() { this.x = null; this.dx = 0; }
    filter(v, dt, minCutoff, beta, dCutoff, noiseSpeed = 0) {
        if (this.x == null || !(dt > 0)) { this.x = v; this.dx = 0; return v; }
        this.dx += alpha(dCutoff, dt) * ((v - this.x) / dt - this.dx);
        this.x += alpha(minCutoff + beta * Math.max(0, Math.abs(this.dx) - noiseSpeed), dt) * (v - this.x);
        return this.x;
    }
}

/**
 * The speed a still coordinate with white noise σ reads through the filter's speed estimate,
 * ×k (k sd's): its sample-to-sample difference (σ√2 per frame) low-passed at dCutoff.
 */
function noiseSpeed(sigma, rate, dCutoff, k = 3) {
    if (!(sigma > 0) || !(rate > 0)) return 0;
    const a = alpha(dCutoff, 1 / rate);
    return k * sigma * Math.SQRT2 * rate * Math.sqrt(a / (2 - a));
}

/**
 * One coordinate triple's measured rest noise: its residual about a least-squares line over the
 * last window, sampled each time that line is slow (the coordinate is still, drift removed).
 */
class NoiseProbe {
    constructor() { this.ring = []; this.var = [null, null, null]; this.n = 0; this.atT = -Infinity; }
    push(v, t, o) {
        const r = this.ring;
        r.push({ t, v });
        while (r.length > 2 && r[0].t < t - o.noiseWindowS) r.shift();
        if (r.length < 8 || r[r.length - 1].t - r[0].t < o.noiseWindowS * 0.8 || t - this.atT < o.noiseWindowS / 2) return;
        this.atT = t;
        const tm = r.reduce((s, e) => s + e.t, 0) / r.length;
        let den = 0;
        for (const e of r) den += (e.t - tm) ** 2;
        const res = [0, 0, 0];
        let speed2 = 0;
        for (const [k, a] of [['x', 0], ['y', 1], ['z', 2]]) {
            const m = r.reduce((s, e) => s + e.v[k], 0) / r.length;
            let num = 0;
            for (const e of r) num += (e.t - tm) * (e.v[k] - m);
            const slope = den > 0 ? num / den : 0;
            speed2 += slope * slope;
            let ss = 0;
            for (const e of r) ss += (e.v[k] - (m + slope * (e.t - tm))) ** 2;
            res[a] = ss / r.length;
        }
        if (Math.sqrt(speed2) > o.stillSpeed) return;
        const k = 1 / Math.min(++this.n, o.noiseTau);
        for (let a = 0; a < 3; a++) this.var[a] = this.var[a] == null ? res[a] : this.var[a] + k * (res[a] - this.var[a]);
    }
    /** rms per axis, or null until measured. */
    get sigma() { return this.var[0] == null ? null : this.var.map((v) => Math.sqrt(v)); }
}

/** The palm's frame from its joints: origin = palm centroid, axes side / forward / normal. */
function palmPose(pts) {
    const w = pts[Joint.WRIST], i = pts[Joint.INDEX_MCP], m = pts[Joint.MIDDLE_MCP], p = pts[Joint.PINKY_MCP];
    if (!w || !i || !m || !p) return null;
    const palm = PALM_JOINTS.map((j) => pts[j]).filter(Boolean);
    const o = centroid(palm);
    const f = norm(sub(m, w));
    const n = norm(cross(f, sub(i, p)));
    const s = cross(n, f);
    return { o, q: quatFromAxes(s, f, n) };
}

/** The rotation taking (x, y, z) to the columns (a, b, c). */
function quatFromAxes(a, b, c) {
    const m00 = a.x, m01 = b.x, m02 = c.x, m10 = a.y, m11 = b.y, m12 = c.y, m20 = a.z, m21 = b.z, m22 = c.z;
    const tr = m00 + m11 + m22;
    let q;
    if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = { w: s / 4, x: (m21 - m12) / s, y: (m02 - m20) / s, z: (m10 - m01) / s }; }
    else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = { w: (m21 - m12) / s, x: s / 4, y: (m01 + m10) / s, z: (m02 + m20) / s }; }
    else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = { w: (m02 - m20) / s, x: (m01 + m10) / s, y: s / 4, z: (m12 + m21) / s }; }
    else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: s / 4 }; }
    return qnorm(q);
}

/** A unit quaternion's rotation vector (axis × angle, shortest arc). */
function rotVec(q) {
    const sg = q.w < 0 ? -1 : 1;
    const s = Math.hypot(q.x, q.y, q.z);
    if (s < 1e-12) return [0, 0, 0];
    const ang = 2 * Math.atan2(s, Math.abs(q.w));
    return [sg * q.x / s * ang, sg * q.y / s * ang, sg * q.z / s * ang];
}

/** The unit quaternion of a rotation vector. */
function fromRotVec(v) {
    const a = Math.hypot(v[0], v[1], v[2]);
    if (a < 1e-12) return { w: 1, x: 0, y: 0, z: 0 };
    const k = Math.sin(a / 2) / a;
    return { w: Math.cos(a / 2), x: v[0] * k, y: v[1] * k, z: v[2] * k };
}

/** Slerp a → b by u (shortest arc). */
function slerp(a, b, u) {
    let d = a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z;
    if (d < 0) { b = { w: -b.w, x: -b.x, y: -b.y, z: -b.z }; d = -d; }
    if (d > 0.9995) return qnorm({ w: a.w + u * (b.w - a.w), x: a.x + u * (b.x - a.x), y: a.y + u * (b.y - a.y), z: a.z + u * (b.z - a.z) });
    const th = Math.acos(d), s = Math.sin(th);
    const ka = Math.sin((1 - u) * th) / s, kb = Math.sin(u * th) / s;
    return { w: ka * a.w + kb * b.w, x: ka * a.x + kb * b.x, y: ka * a.y + kb * b.y, z: ka * a.z + kb * b.z };
}

export default class HandStabilizer {
    /** @param {Partial<typeof STABILIZER_DEFAULTS>} [params] - held by reference (live knobs) */
    constructor(params = {}) {
        this.params = Object.assign(params, { ...STABILIZER_DEFAULTS, ...params });
        this.reset();
    }

    reset() {
        this.t = null;
        this.pose = null;               // filtered palm pose {o, q}
        this._rawPose = null;
        this._palmPos = [new Euro(), new Euro(), new Euro()];
        this._palmNoise = new NoiseProbe();
        this._rotNoise = new NoiseProbe(); // the rotation vector (rad) of raw vs filtered pose, as a 3-vector
        this._angle = [0, 0, 0];         // the raw pose's integrated body-frame rotation (rad), per axis
        this._angleRing = [];            // … over the last rotSpeedWindowS, for its speed
        this._prevRawQ = null;
        this._local = Array.from({ length: JOINT_COUNT }, () => ({ f: [new Euro(), new Euro(), new Euro()], noise: new NoiseProbe(), last: null, seenT: null }));
    }

    /** The rest cutoff (Hz) for noise σ (m or rad) to reach `target` at `rate`; the fallback until measured. @private */
    _cut(sigma, target, rate) {
        if (sigma == null || !(rate > 0)) return this.params.fallbackCutoff;
        return cutoffForJitter(sigma, target, rate) ?? rate / 2;
    }

    /**
     * Stabilize one frame of joints.
     * @param {(Vec3|null)[]} pts - the merged live joints (phone frame, m)
     * @param {number} t - seconds
     * @param {Quat|null} [palmQ] - the palm's rotation from a better fit (the hand model's weighted
     *   Kabsch on its template: axes side / forward / normal) — else from three palm joints
     * @returns {(Vec3|null)[]} the stabilized joints
     */
    update(pts, t, palmQ = null) {
        const o = this.params;
        if (!o.enabled) return pts.map((p) => (p ? { ...p } : null));
        const dt = this.t == null ? 0 : Math.max(0, t - this.t);
        this.t = t;
        const rate = dt > 0 ? 1 / dt : null;
        this._rate = rate ? (this._rate ? this._rate + 0.1 * (rate - this._rate) : rate) : this._rate;

        // The palm pose: raw from the palm joints, filtered as a rigid body.
        const raw = palmPose(pts);
        if (raw && palmQ) raw.q = palmQ;
        if (raw) {
            this._rawPose = raw;
            if (!this.pose) this.pose = { o: { ...raw.o }, q: { ...raw.q } };
            else {
                const ps = this._palmNoise.sigma;
                const pc = ps ? [0, 1, 2].map((a) => this._cut(ps[a], o.targetJitter, this._rate)) : [o.fallbackCutoff, o.fallbackCutoff, o.fallbackCutoff];
                const ax = ['x', 'y', 'z'];
                const no = {};
                ax.forEach((k, a) => { no[k] = this._palmPos[a].filter(raw.o[k], dt, pc[a], o.palmBeta, o.dCutoff, ps ? noiseSpeed(ps[a], this._rate, o.dCutoff) : 0); });
                // Rotation, per axis in the palm's own frame (side / forward / normal): the error
                // rotation from the filtered pose to the raw one, each component stepped by its own
                // One Euro α — yaw comes from the image plane and is precise, pitch/roll come from
                // depth and are noisier, so they're smoothed more and yaw barely at all.
                const rv = rotVec(qmul(qconj(this.pose.q), raw.q));
                // Turning speed per axis: integrate the raw pose's body-frame increments into an
                // angle track and take its least-squares slope over rotSpeedWindowS.
                if (this._prevRawQ) {
                    const inc = rotVec(qmul(qconj(this._prevRawQ), raw.q));
                    for (let a = 0; a < 3; a++) this._angle[a] += inc[a];
                }
                const ring = this._angleRing;
                ring.push({ t, a: [...this._angle] });
                while (ring.length > 2 && ring[0].t < t - o.rotSpeedWindowS) ring.shift();
                const tm = ring.reduce((sum, e) => sum + e.t, 0) / ring.length;
                let den = 0;
                for (const e of ring) den += (e.t - tm) ** 2;
                const rs = this._rotNoise.sigma;
                const rotTarget = o.rotTarget;
                const step = [0, 0, 0];
                for (let a = 0; a < 3; a++) {
                    let num = 0;
                    const am = ring.reduce((sum, e) => sum + e.a[a], 0) / ring.length;
                    for (const e of ring) num += (e.t - tm) * (e.a[a] - am);
                    const speed = den > 0 ? num / den : 0;
                    const rc = rs ? this._cut(rs[a], rotTarget, this._rate) : o.fallbackCutoff;
                    // The slope's own noise floor for white angle noise σ: σ / √Σ(t − t̄)², × 3.
                    const dead = rs && den > 0 ? (3 * rs[a]) / Math.sqrt(den) : 0;
                    step[a] = (dt > 0 ? alpha(rc + o.rotBeta * Math.max(0, Math.abs(speed) - dead), dt) : 1) * rv[a];
                }
                this.pose = { o: no, q: qnorm(qmul(this.pose.q, fromRotVec(step))) };
            }
            this._prevRawQ = raw.q;
            this._palmNoise.push(raw.o, t, o);
            // Rotation noise, per palm axis: the raw pose's rotation vector relative to a reference
            // re-anchored on the filtered pose every few seconds (small angles stay linear) —
            // locally still means that vector isn't drifting.
            if (!this._qRef || t - this._qRefT > 5) { this._qRef = this.pose.q; this._qRefT = t; this._rotNoise.ring = []; }
            const rel = qmul(qconj(this._qRef), raw.q);
            const sgn = rel.w < 0 ? -1 : 1;
            this._rotNoise.push({ x: 2 * sgn * rel.x, y: 2 * sgn * rel.y, z: 2 * sgn * rel.z }, t, { ...o, stillSpeed: o.stillSpeed / o.leverM });
        }
        if (!this.pose) return pts.map((p) => (p ? { ...p } : null));

        // Every joint in palm-local coordinates (relative to the RAW pose: what the joint did
        // relative to the palm), filtered there, then placed on the FILTERED pose.
        const rp = this._rawPose, inv = qconj(rp.q);
        const out = new Array(JOINT_COUNT).fill(null);
        for (let j = 0; j < JOINT_COUNT; j++) {
            const L = this._local[j];
            const p = pts[j];
            let local;
            if (p) {
                const v = qrot(inv, sub(p, rp.o));
                L.noise.push(v, t, o);
                const s = L.noise.sigma;
                const cut = s ? [0, 1, 2].map((a) => this._cut(s[a], o.targetJitter, this._rate)) : [o.fallbackCutoff, o.fallbackCutoff, o.fallbackCutoff];
                const ns = (a) => (s ? noiseSpeed(s[a], this._rate, o.dCutoff) : 0);
                local = {
                    x: L.f[0].filter(v.x, dt, cut[0], o.beta, o.dCutoff, ns(0)),
                    y: L.f[1].filter(v.y, dt, cut[1], o.beta, o.dCutoff, ns(1)),
                    z: L.f[2].filter(v.z, dt, cut[2], o.beta, o.dCutoff, ns(2)),
                };
                L.last = local; L.seenT = t;
            } else if (L.last && t - L.seenT <= o.holdS) local = L.last;
            else continue;
            const w = qrot(this.pose.q, local);
            out[j] = { x: this.pose.o.x + w.x, y: this.pose.o.y + w.y, z: this.pose.o.z + w.z };
        }
        return out;
    }

    /** Each joint's measured rest noise (3-D rms, m) and the rest cutoff in force, for the board. */
    describe() {
        const o = this.params;
        const joints = this._local.map((L) => {
            const s = L.noise.sigma;
            return s ? { noise: Math.hypot(...s), cutoff: Math.min(...s.map((x) => this._cut(x, o.targetJitter, this._rate))) } : null;
        });
        const ps = this._palmNoise.sigma, rs = this._rotNoise.sigma;
        return {
            enabled: o.enabled, rate: this._rate ?? null,
            palm: ps ? { noise: Math.hypot(...ps) } : null,
            rotation: rs ? { noiseRad: Math.max(...rs) } : null,
            joints,
            measured: joints.filter(Boolean).length,
        };
    }
}


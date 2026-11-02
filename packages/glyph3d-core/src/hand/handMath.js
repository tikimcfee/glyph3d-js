/**
 * handMath — the small pure numerics the hand pipeline shares: vectors as `{x, y, z}`,
 * robust statistics, a symmetric 3×3 eigen-solve (palm planes), a seeded RNG (the
 * simulator), and a least-squares velocity probe. No Three.js, no DOM: the simulator,
 * the calibration estimators and the HandSpace stages all run headless in tests.
 */

import { Joint } from './HandData.js';

/** @typedef {{x: number, y: number, z: number}} Vec3 */

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a, b) => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
});
export const len = (a) => Math.sqrt(dot(a, a));
export const dist = (a, b) => len(sub(a, b));
export const norm = (a) => { const l = len(a); return l > 0 ? scale(a, 1 / l) : v3(); };
export const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
/** Angle between two vectors, degrees. */
export const angleDeg = (a, b) => {
    const d = dot(norm(a), norm(b));
    return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
};
export const fromArray = (a) => ({ x: a[0], y: a[1], z: a[2] });
export const round = (n, digits = 4) => (Number.isFinite(n) ? Number(n.toFixed(digits)) : null);
export const roundV = (v, digits = 4) => (v ? { x: round(v.x, digits), y: round(v.y, digits), z: round(v.z, digits) } : null);

/** Mean of a list of vectors (null for none). @param {Vec3[]} pts */
export function centroid(pts) {
    if (!pts.length) return null;
    let x = 0, y = 0, z = 0;
    for (const p of pts) { x += p.x; y += p.y; z += p.z; }
    return { x: x / pts.length, y: y / pts.length, z: z / pts.length };
}

/** Linear-interpolated percentile of an ALREADY SORTED array; p in 0..100. */
export function percentileSorted(sorted, p) {
    if (!sorted.length) return null;
    const i = Math.max(0, Math.min(sorted.length - 1, (p / 100) * (sorted.length - 1)));
    const lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Percentile of an unsorted array (copies). */
export const percentile = (values, p) => percentileSorted([...values].sort((a, b) => a - b), p);
export const median = (values) => percentile(values, 50);

/** RMS deviation of points from their centroid, per axis and overall. @param {Vec3[]} pts */
export function rmsSpread(pts) {
    const c = centroid(pts);
    if (!c) return null;
    let x = 0, y = 0, z = 0;
    for (const p of pts) { x += (p.x - c.x) ** 2; y += (p.y - c.y) ** 2; z += (p.z - c.z) ** 2; }
    const n = pts.length;
    return { x: Math.sqrt(x / n), y: Math.sqrt(y / n), z: Math.sqrt(z / n), rms: Math.sqrt((x + y + z) / n) };
}

/**
 * Eigen-decomposition of a symmetric n×n (cyclic Jacobi). Eigenvalues ascending, each with its
 * unit eigenvector (as an array).
 * @param {number[][]} m - symmetric, not modified
 * @returns {{values: number[], vectors: number[][]}}
 */
export function eigenSym(m) {
    const n = m.length;
    const a = m.map((r) => [...r]);
    const v = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
    for (let sweep = 0; sweep < 64; sweep++) {
        let off = 0;
        for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] ** 2;
        if (off < 1e-30) break;
        for (let p = 0; p < n; p++) {
            for (let q = p + 1; q < n; q++) {
                if (Math.abs(a[p][q]) < 1e-300) continue;
                const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
                const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                const c = 1 / Math.sqrt(t * t + 1), s = t * c;
                for (let k = 0; k < n; k++) {
                    const akp = a[k][p], akq = a[k][q];
                    a[k][p] = c * akp - s * akq;
                    a[k][q] = s * akp + c * akq;
                }
                for (let k = 0; k < n; k++) {
                    const apk = a[p][k], aqk = a[q][k];
                    a[p][k] = c * apk - s * aqk;
                    a[q][k] = s * apk + c * aqk;
                }
                for (let k = 0; k < n; k++) {
                    const vkp = v[k][p], vkq = v[k][q];
                    v[k][p] = c * vkp - s * vkq;
                    v[k][q] = s * vkp + c * vkq;
                }
            }
        }
    }
    const order = [...Array(n).keys()].sort((i, j) => a[i][i] - a[j][j]);
    return {
        values: order.map((i) => a[i][i]),
        vectors: order.map((i) => {
            const col = v.map((row) => row[i]);
            const l = Math.hypot(...col);
            return col.map((x) => x / l);
        }),
    };
}

/** eigenSym for a 3×3, eigenvectors as Vec3. @param {number[][]} m */
export function eigenSym3(m) {
    const { values, vectors } = eigenSym(m);
    return { values, vectors: vectors.map((c) => ({ x: c[0], y: c[1], z: c[2] })) };
}

// ── Rotations ───────────────────────────────────────────────────────────────

/** @typedef {{w: number, x: number, y: number, z: number}} Quat */

/** Rotate v by unit quaternion q. @param {Quat} q @param {Vec3} v */
export function qrot(q, v) {
    // v' = v + 2w(u × v) + 2u × (u × v)
    const u = { x: q.x, y: q.y, z: q.z };
    const t = scale(cross(u, v), 2);
    return add(add(v, scale(t, q.w)), cross(u, t));
}

/**
 * The rotation that best carries `from` points onto `to` points (weighted least squares
 * after removing each set's centroid) — Kabsch, solved by Horn's quaternion method: the
 * largest eigenvector of a 4×4 built from the cross-covariance. No reflection can come out.
 * @param {Vec3[]} from - e.g. the calibrated palm template
 * @param {Vec3[]} to - the observed points, same order
 * @param {number[]} [weights] - per pair (confidence), default 1
 * @returns {{q: Quat, rms: number, residuals: number[], fromCenter: Vec3, toCenter: Vec3}|null} null with < 3 pairs
 */
export function kabsch(from, to, weights = null) {
    const n = from.length;
    if (n < 3 || to.length !== n) return null;
    let W = 0;
    const ca = v3(), cb = v3();
    for (let i = 0; i < n; i++) {
        const w = weights ? weights[i] : 1;
        W += w;
        ca.x += w * from[i].x; ca.y += w * from[i].y; ca.z += w * from[i].z;
        cb.x += w * to[i].x; cb.y += w * to[i].y; cb.z += w * to[i].z;
    }
    if (!(W > 0)) return null;
    const fa = scale(ca, 1 / W), fb = scale(cb, 1 / W);
    let Sxx = 0, Sxy = 0, Sxz = 0, Syx = 0, Syy = 0, Syz = 0, Szx = 0, Szy = 0, Szz = 0;
    for (let i = 0; i < n; i++) {
        const w = weights ? weights[i] : 1;
        const a = sub(from[i], fa), b = sub(to[i], fb);
        Sxx += w * a.x * b.x; Sxy += w * a.x * b.y; Sxz += w * a.x * b.z;
        Syx += w * a.y * b.x; Syy += w * a.y * b.y; Syz += w * a.y * b.z;
        Szx += w * a.z * b.x; Szy += w * a.z * b.y; Szz += w * a.z * b.z;
    }
    const N = [
        [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
        [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
        [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
        [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
    ];
    const { vectors } = eigenSym(N);
    const e = vectors[3];
    const q = { w: e[0], x: e[1], y: e[2], z: e[3] };
    let r2 = 0;
    const residuals = [];
    for (let i = 0; i < n; i++) {
        const w = weights ? weights[i] : 1;
        const d = sub(add(qrot(q, sub(from[i], fa)), fb), to[i]);
        residuals.push(len(d));
        r2 += w * dot(d, d);
    }
    return { q, rms: Math.sqrt(r2 / W), residuals, fromCenter: fa, toCenter: fb };
}

/**
 * Yaw (about +z, up), pitch (about +x, right) and roll (about +y, forward) of a rotation in
 * the PHONE frame, degrees — the decomposition R = Rz(yaw)·Rx(pitch)·Ry(roll). For a palm-down
 * hand: yaw turns it on the desk, pitch tips the fingers up, roll tips it onto its side.
 * @param {Quat} q
 */
export function yawPitchRoll(q) {
    const { w, x, y, z } = q;
    const r01 = 2 * (x * y - w * z), r11 = 1 - 2 * (x * x + z * z);
    const r20 = 2 * (x * z - w * y), r21 = 2 * (y * z + w * x), r22 = 1 - 2 * (x * x + y * y);
    const deg = 180 / Math.PI;
    return {
        yaw: Math.atan2(-r01, r11) * deg,
        pitch: Math.asin(Math.max(-1, Math.min(1, r21))) * deg,
        roll: Math.atan2(-r20, r22) * deg,
    };
}

/**
 * Best-fit plane of a point cloud (PCA): its centroid, unit normal (the least-variance
 * axis; sign arbitrary — callers orient it) and RMS distance of the points from it.
 * @param {Vec3[]} pts - at least 3
 */
export function fitPlane(pts) {
    if (pts.length < 3) return null;
    const c = centroid(pts);
    const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const p of pts) {
        const d = [p.x - c.x, p.y - c.y, p.z - c.z];
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] += d[i] * d[j];
    }
    const { values, vectors } = eigenSym3(m);
    return { center: c, normal: vectors[0], rms: Math.sqrt(Math.max(0, values[0]) / pts.length) };
}

/** Seeded PRNG (mulberry32): deterministic simulator runs, so tests have fixed truth. */
export function rng(seed = 1) {
    let s = seed >>> 0;
    const next = () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    /** Standard normal (Box–Muller). */
    next.gauss = () => {
        const u = Math.max(next(), 1e-12), w = next();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w);
    };
    return next;
}

/**
 * Velocity as the least-squares slope of position over the trailing `baselineS` — far less
 * noise-driven than a frame-to-frame difference (a 2 mm jitter at 60 Hz differences to
 * ~0.2 m/s of fake speed; the slope over 0.15 s brings that near 0.01).
 */
export class VelocityProbe {
    /** @param {number} baselineS */
    constructor(baselineS = 0.15) { this.baselineS = baselineS; this._ring = []; }
    reset() { this._ring = []; }
    /** @param {Vec3} p @param {number} t seconds @returns {Vec3|null} */
    push(p, t) {
        const r = this._ring;
        r.push({ p, t });
        while (r.length > 2 && r[0].t < t - this.baselineS) r.shift();
        if (r.length < 3) return null;
        let tm = 0;
        for (const s of r) tm += s.t;
        tm /= r.length;
        let den = 0, nx = 0, ny = 0, nz = 0;
        for (const s of r) {
            const dt = s.t - tm;
            den += dt * dt;
            nx += dt * s.p.x; ny += dt * s.p.y; nz += dt * s.p.z;
        }
        return den > 0 ? { x: nx / den, y: ny / den, z: nz / den } : null;
    }
}

// ── Hand geometry shared by the simulator and the estimators ────────────────

/** The rigid palm: wrist + the four finger MCPs. Its centroid is the hand's position. */
export const PALM_JOINTS = [Joint.WRIST, Joint.INDEX_MCP, Joint.MIDDLE_MCP, Joint.RING_MCP, Joint.PINKY_MCP];

/** The bones summed into hand size: wrist → middle MCP → PIP → DIP → TIP (anatomical hand length). */
export const HAND_LENGTH_BONES = [
    [Joint.WRIST, Joint.MIDDLE_MCP],
    [Joint.MIDDLE_MCP, Joint.MIDDLE_PIP],
    [Joint.MIDDLE_PIP, Joint.MIDDLE_DIP],
    [Joint.MIDDLE_DIP, Joint.MIDDLE_TIP],
];

/** A bone's key in bone-length maps. */
export const boneKey = (a, b) => `${a}-${b}`;

/**
 * The palm's facing direction, signed by anatomy: for a right hand, (index MCP − wrist) ×
 * (pinky MCP − wrist) points out of the palm. Null when a joint is missing.
 * @param {(Vec3|null)[]} pts @param {'left'|'right'} handedness
 */
export function palmFacing(pts, handedness) {
    const w = pts[Joint.WRIST], i = pts[Joint.INDEX_MCP], p = pts[Joint.PINKY_MCP];
    if (!w || !i || !p) return null;
    const n = norm(cross(sub(i, w), sub(p, w)));
    return handedness === 'left' ? scale(n, -1) : n;
}

/** q·r (apply r, then q). @param {Quat} q @param {Quat} r @returns {Quat} */
export function qmul(q, r) {
    return {
        w: q.w * r.w - q.x * r.x - q.y * r.y - q.z * r.z,
        x: q.w * r.x + q.x * r.w + q.y * r.z - q.z * r.y,
        y: q.w * r.y - q.x * r.z + q.y * r.w + q.z * r.x,
        z: q.w * r.z + q.x * r.y - q.y * r.x + q.z * r.w,
    };
}
export const qconj = (q) => ({ w: q.w, x: -q.x, y: -q.y, z: -q.z });
/** Rotation angle between two unit quaternions, degrees. */
export const qangleDeg = (a, b) => {
    const d = Math.abs(a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z);
    return (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI;
};
/** Unit quaternion from an axis (unit) and angle (radians). */
export const qaxis = (k, a) => ({ w: Math.cos(a / 2), x: k.x * Math.sin(a / 2), y: k.y * Math.sin(a / 2), z: k.z * Math.sin(a / 2) });
export const qnorm = (q) => { const l = Math.hypot(q.w, q.x, q.y, q.z) || 1; return { w: q.w / l, x: q.x / l, y: q.y / l, z: q.z / l }; };

/**
 * Where a ray from the origin meets a sphere: the point at distance `L` from `c` along unit
 * direction `r`, the root nearest `prefer` (a distance along the ray). With no intersection,
 * the ray's closest approach to `c`. This rebuilds a joint whose depth is missing or wrong
 * from its parent and the calibrated bone length: the phone frame's origin IS the optical
 * centre, so a joint's 2-D detection fixes its ray and only the distance is in doubt.
 * @returns {{p: Vec3, hit: boolean}}
 */
export function raySphere(r, c, L, prefer) {
    const b = dot(r, c);
    const disc = b * b - dot(c, c) + L * L;
    if (disc < 0) return { p: scale(r, b), hit: false };
    const s1 = b - Math.sqrt(disc), s2 = b + Math.sqrt(disc);
    const s = Math.abs(s1 - prefer) <= Math.abs(s2 - prefer) ? s1 : s2;
    return { p: scale(r, s), hit: true };
}

/**
 * A histogram whose weights fade with time — online quantiles WITH forgetting, which the
 * P² estimator can't do. Fixed bins over [min, max) (values outside land in the edge bins and
 * are counted); every sample's weight decays as exp(−age/τ) (τ = Infinity: never forgets).
 * Decay is lazy: new samples are added with a growing gain instead of shrinking old ones —
 * FORWARD DECAY (Cormode, Shkapenyuk, Srivastava & Xu, ICDE 2009): weight by g(tᵢ − L) from a
 * landmark L, divide by g(t − L) at query time, move the landmark before it overflows.
 */
export class DecayHist {
    /** @param {{min: number, max: number, bin: number, tau: number}} o */
    constructor({ min, max, bin, tau }) {
        this.min = min; this.bin = bin; this.tau = tau;
        this.n = Math.max(1, Math.ceil((max - min) / bin));
        this.reset();
    }
    reset() {
        this.w = new Float64Array(this.n);
        this.total = 0; this.gain = 1; this.t0 = null; this.outside = 0; this.count = 0;
    }
    _gainAt(t) {
        if (this.t0 == null) this.t0 = t;
        if (!Number.isFinite(this.tau)) return 1;
        let e = (t - this.t0) / this.tau;
        // A clock that ran backwards (a restarted source) restarts the time base; weights keep.
        if (e < 0) { this.t0 = t; e = 0; }
        if (e > 27) { // renormalize in log space (exp would overflow for a long gap): fade the stored weights
            const k = Math.exp(-e);
            for (let i = 0; i < this.n; i++) this.w[i] *= k;
            this.total *= k; this.t0 = t; e = 0;
        }
        return (this.gain = Math.exp(e));
    }
    /** @param {number} x @param {number} t seconds @param {number} [weight] */
    add(x, t, weight = 1) {
        if (!Number.isFinite(x)) return;
        const g = this._gainAt(t) * weight;
        let i = Math.floor((x - this.min) / this.bin);
        if (i < 0 || i >= this.n) { this.outside++; i = Math.max(0, Math.min(this.n - 1, i)); }
        this.w[i] += g; this.total += g; this.count++;
    }
    /** Effective sample count (decayed weight), as of the last sample. */
    get weight() { return this.total / this.gain; }
    /** Quantile p in 0..1 (linear within a bin), null when empty. */
    quantile(p) {
        if (!(this.total > 0)) return null;
        const target = p * this.total;
        let acc = 0;
        for (let i = 0; i < this.n; i++) {
            const w = this.w[i];
            if (acc + w >= target && w > 0) return this.min + (i + (target - acc) / w) * this.bin;
            acc += w;
        }
        return this.min + this.n * this.bin;
    }
    /**
     * The weight and median on each side of `cut`: the samples below and the samples at or
     * above it. Null for a side with no weight.
     * @param {number} cut
     * @returns {{lo: {median: number, weight: number}|null, hi: {median: number, weight: number}|null}}
     */
    split(cut) {
        const k = Math.max(0, Math.min(this.n, Math.floor((cut - this.min) / this.bin)));
        const side = (from, to) => {
            let w = 0;
            for (let i = from; i < to; i++) w += this.w[i];
            if (!(w > 0)) return null;
            let acc = 0;
            for (let i = from; i < to; i++) {
                const x = this.w[i];
                if (acc + x >= w / 2 && x > 0) return { median: this.min + (i + (w / 2 - acc) / x) * this.bin, weight: w / this.gain };
                acc += x;
            }
            return null;
        };
        return { lo: side(0, k), hi: side(k, this.n) };
    }
}

/**
 * How much a value moved lately: samples it once per `everyS` and keeps `windowS` of them.
 * `drift` = max − min over the window — the honest "has this settled?" for any estimate.
 */
export class Drift {
    constructor(windowS = 10, everyS = 1) { this.windowS = windowS; this.everyS = everyS; this.reset(); }
    reset() { this.s = []; this.at = -Infinity; }
    push(v, t) {
        if (v == null || !Number.isFinite(v) || t - this.at < this.everyS) return;
        this.at = t;
        this.s.push({ t, v });
        while (this.s.length && this.s[0].t < t - this.windowS) this.s.shift();
    }
    /** null until the window has filled. */
    get drift() {
        if (this.s.length < 2 || this.s[this.s.length - 1].t - this.s[0].t < this.windowS * 0.8) return null;
        let lo = Infinity, hi = -Infinity;
        for (const { v } of this.s) { if (v < lo) lo = v; if (v > hi) hi = v; }
        return hi - lo;
    }
}

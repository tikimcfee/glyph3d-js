/**
 * cloudSolve — the hand fit as ONE least-squares problem (htrack, Tagliasacchi 2015, in small):
 * a kinematic hand of 27 parameters, solved by a few Levenberg–Marquardt iterations, the
 * cloud's correspondences re-found each iteration (ICP inside LM).
 *
 *   parameters  palm pose (translation 3 + rotation 3, the rotation an increment re-based each
 *               iteration); per finger (index…pinky) abduction, MCP / PIP / DIP flexion; the
 *               thumb's base yaw + pitch, MCP and IP flexion, and the turn of its flexion plane
 *   kinematics  the palm template (each joint's distance from the wrist = the learned bone),
 *               fingers flexing toward the palm in their own plane, bones exact by construction
 *   residuals   data: each sampled hand point's distance to the nearest capsule's surface
 *               (Huber) · Vision: each joint's offset from its ray (× confidence) and, weakly,
 *               its depth · named tips · palm joints a radius inside the palm plane · free space:
 *               no joint in front of the surface seen there, none over seen-through background ·
 *               joint limits (soft) · a temporal prior toward last frame's angles
 *
 * The Jacobian is analytic from residual to joint (point-to-capsule: −(1−t)n, −t n) and
 * finite-differenced from joint to parameter through the kinematics (26 cheap evaluations).
 * The tracker's fit stage: same output shape (joints, confidence, source, rms, …) plus its parameters.
 *
 * Pure: no DOM, no Three.js.
 */

import { Joint, JOINT_COUNT } from '../HandData.js';
import { v3, add, sub, scale, dot, cross, len, norm, kabsch } from '../handMath.js';
import { projectToCloud, pixelRay } from './depthWire.js';
import { nearestPixel } from './cloudGrid.js';
import { CLS, PALM_SET, MCPS, bodyOf, jointRadii, palmTemplate, boneLength } from './cloudBody.js';

/** @typedef {import('../handMath.js').Vec3} Vec3 */

const NP = 28;
const CLS_BG = CLS.BG, CLS_ARM = CLS.ARM, CLS_HAND = CLS.HAND;
const DEG = Math.PI / 180;
/** Rest splay of each finger about the palm axis (right hand, hand-local), radians. */
const SPLAY = [-6 * DEG, 0, 6 * DEG, 14 * DEG];
/** The thumb's rest direction from its base (right hand, hand-local). */
const THUMB_REST = norm(v3(-Math.sin(50 * DEG), Math.cos(50 * DEG), -0.25));


// ── Small dense algebra ─────────────────────────────────────────────────────

/** Solve A x = b for symmetric positive definite A (n×n, row-major Float64Array) by Cholesky; null if not SPD. */
function cholSolve(A, b, n) {
    const L = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
        for (let j = 0; j <= i; j++) {
            let s = A[i * n + j];
            for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
            if (i === j) { if (!(s > 0)) return null; L[i * n + i] = Math.sqrt(s); } else L[i * n + j] = s / L[j * n + j];
        }
    }
    const y = new Float64Array(n), x = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k]; y[i] = s / L[i * n + i]; }
    for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; }
    return x;
}

/** Rotation matrix (row-major 9) from a rotation vector. */
function rotvec(w) {
    const th = Math.hypot(w[0], w[1], w[2]);
    if (th < 1e-12) return [1, -w[2], w[1], w[2], 1, -w[0], -w[1], w[0], 1];
    const k = [w[0] / th, w[1] / th, w[2] / th], c = Math.cos(th), s = Math.sin(th), C = 1 - c;
    return [
        c + k[0] * k[0] * C, k[0] * k[1] * C - k[2] * s, k[0] * k[2] * C + k[1] * s,
        k[1] * k[0] * C + k[2] * s, c + k[1] * k[1] * C, k[1] * k[2] * C - k[0] * s,
        k[2] * k[0] * C - k[1] * s, k[2] * k[1] * C + k[0] * s, c + k[2] * k[2] * C,
    ];
}
const mmul = (A, B) => {
    const C = new Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[3 * i + j] = A[3 * i] * B[j] + A[3 * i + 1] * B[3 + j] + A[3 * i + 2] * B[6 + j];
    return C;
};
const mv = (M, p) => v3(M[0] * p.x + M[1] * p.y + M[2] * p.z, M[3] * p.x + M[4] * p.y + M[5] * p.z, M[6] * p.x + M[7] * p.y + M[8] * p.z);
const mtv = (M, p) => v3(M[0] * p.x + M[3] * p.y + M[6] * p.z, M[1] * p.x + M[4] * p.y + M[7] * p.z, M[2] * p.x + M[5] * p.y + M[8] * p.z);
function quatToMat(q) {
    const { w, x, y, z } = q;
    return [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), 2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), 2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
}
function rotAbout(v, k, a) {
    const c = Math.cos(a), s = Math.sin(a);
    return add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)));
}

// ── The kinematic hand ──────────────────────────────────────────────────────

/**
 * The 21 joints of a pose.
 * @param {{p: Vec3, R: number[]}} base - palm translation (the template's origin = wrist) and rotation
 * @param {Float64Array} th - 27 params: [0..5] the pose increment, then per finger [abd, f1, f2, f3] ×4, thumb [yaw, pitch, f1, f2], [26] thumb flexion-plane turn
 * @param {Object} K - {T: palm template (hand-local), B: (a, b) => bone length, mir: ±1}
 */
function fk(base, th, K) {
    const R = mmul(rotvec([th[3], th[4], th[5]]), base.R);
    const p = add(base.p, v3(th[0], th[1], th[2]));
    const J = new Array(JOINT_COUNT);
    const W = (l) => add(mv(R, l), p);
    for (const j of PALM_SET) J[j] = W(K.T[j]);
    const X = v3(R[0] * K.mir, R[3] * K.mir, R[6] * K.mir), Y = v3(R[1], R[4], R[7]), Z = v3(R[2], R[5], R[8]);
    for (let f = 0; f < 4; f++) {
        const m = MCPS[f], o = 6 + 4 * f;
        const a = SPLAY[f] + th[o];
        const h = add(scale(Y, Math.cos(a)), scale(X, Math.sin(a)));
        let ang = 0, q = J[m];
        for (let k = 0; k < 3; k++) {
            ang += th[o + 1 + k];
            const d = add(scale(h, Math.cos(ang)), scale(Z, -Math.sin(ang)));
            q = add(q, scale(d, K.B(m + k, m + k + 1)));
            J[m + k + 1] = q;
        }
    }
    // Thumb: yaw about the palm normal, pitch about the side axis, then two flexions toward the palm.
    const o = 22;
    const rest = add(add(scale(X, THUMB_REST.x), scale(Y, THUMB_REST.y)), scale(Z, THUMB_REST.z));
    let d1 = rotAbout(rotAbout(rest, Z, th[o] * K.mir), X, th[o + 1]);
    d1 = norm(d1);
    // Its flexion plane turns about the first bone (the thumb's opposition), param 26.
    const kx = rotAbout(norm(cross(d1, Z)), d1, th[26] * K.mir);
    J[2] = add(J[1], scale(d1, K.B(1, 2)));
    const d2 = rotAbout(d1, kx, -th[o + 2]);
    J[3] = add(J[2], scale(d2, K.B(2, 3)));
    const k2 = rotAbout(kx, d2, th[27] * K.mir); // the last joint's own plane (param 27)
    const d3 = rotAbout(d2, k2, -th[o + 3]);
    J[4] = add(J[3], scale(d3, K.B(3, 4)));
    return J;
}

/** Angles that reproduce joints J (an init from points), for a palm frame R. */
function anglesFrom(J, R, K) {
    const th = new Float64Array(NP);
    const X = v3(R[0] * K.mir, R[3] * K.mir, R[6] * K.mir), Y = v3(R[1], R[4], R[7]), Z = v3(R[2], R[5], R[8]);
    for (let f = 0; f < 4; f++) {
        const m = MCPS[f], o = 6 + 4 * f;
        const b0 = sub(J[m + 1], J[m]);
        const a = Math.atan2(dot(b0, X), dot(b0, Y));
        th[o] = Math.max(-0.5, Math.min(0.5, a - SPLAY[f]));
        const h = add(scale(Y, Math.cos(a)), scale(X, Math.sin(a)));
        let prev = 0;
        for (let k = 0; k < 3; k++) {
            const b = sub(J[m + k + 1], J[m + k]);
            const ang = Math.atan2(-dot(b, Z), dot(b, h));
            th[o + 1 + k] = ang - prev;
            prev = ang;
        }
    }
    return th;
}

// ── The solve ───────────────────────────────────────────────────────────────

/**
 * Solve the hand into the cloud.
 * @param {Object} ctx - {c, xyz, cls, vis, palm, tips, bones, handedness, init: 21 joints to start from, initTheta: last solve's parameters|null, initFrom}
 * @param {Object} o - the tracker's knobs (HAND_CLOUD_DEFAULTS)
 */
export function solveStage(ctx, o) {
    const { c, xyz, cls, vis, palm, tips, handedness } = ctx;
    const so = o;
    const radii = jointRadii(o);
    const body = bodyOf(o);
    const T = palmTemplate(ctx.bones, handedness); // mirrored for a left hand; R stays a proper rotation
    const K = { T, B: boneLength(ctx.bones), mir: handedness === 'left' ? -1 : 1 };
    const T6 = PALM_SET.map((j) => T[j]);

    // ── init: a palm frame (Kabsch of the template onto joints we trust) + angles from joints.
    const J0 = ctx.init;
    if (!J0) return { ok: false, why: 'no init joints' };
    const k0 = kabsch(T6, PALM_SET.map((j) => J0[j]));
    if (!k0) return { ok: false, why: 'degenerate palm init' };
    let base = { R: quatToMat(k0.q), p: null };
    // Template origin (wrist, at 0) lands at: R·(0 − fromCenter) + toCenter.
    base.p = add(mv(base.R, scale(k0.fromCenter, -1)), k0.toCenter);
    let th = ctx.initTheta ? Float64Array.from(ctx.initTheta) : anglesFrom(J0, base.R, K);
    for (let i = 0; i < 6; i++) th[i] = 0;
    if (!ctx.initTheta) th = thumbFrom(J0, base, th, K);
    const prevTheta = ctx.initTheta || null;

    // Correspondence samples: an even subsample of the hand's pixels.
    const handIdx = [];
    for (let i = 0; i < cls.length; i++) if (cls[i] === CLS_HAND) handIdx.push(i);
    const step = Math.max(1, Math.floor(handIdx.length / so.maxSamples));
    const samples = [];
    for (let i = 0; i < handIdx.length; i += step) samples.push(handIdx[i]);

    const plane = palm?.ok ? palm.plane : null;
    const lims = [o.mcpFlex, o.pipFlex, o.dipFlex];
    const namedTips = (tips?.tips || []).filter((t) => t.joint != null && !t.clipped);
    let lambda = so.lmLambda;
    let J = fk(base, th, K);
    let lastCost = Infinity, rms = NaN, used = 0, outliers = 0;
    const wt = new Float64Array(JOINT_COUNT);
    const CAP = new Float64Array(8 * body.length);
    const NRM = { x: 0, y: 0, z: 0 };

    /** Build JᵀJ, Jᵀr and the cost at θ (correspondences found at the current joints). */
    const build = (thv, Jc, wantSystem) => {
        const Dj = wantSystem ? jointJacobian(base, thv, K) : null;
        const A = wantSystem ? new Float64Array(NP * NP) : null, g = wantSystem ? new Float64Array(NP) : null;
        let cost = 0;
        const row = new Float64Array(NP);
        const add1 = (r, w) => {
            // r: residual value; row: its gradient (filled by the caller); w: weight (√ already applied)
            cost += r * r;
            if (!wantSystem) return;
            for (let a = 0; a < NP; a++) {
                const ra = row[a];
                if (ra === 0) continue;
                g[a] += ra * r;
                for (let b = a; b < NP; b++) A[a * NP + b] += ra * row[b];
            }
        };
        const gradJ = (j, n, s) => {
            if (!Dj) return;
            const ox = (3 * j) * NP, oy = ox + NP, oz = oy + NP, nx = s * n.x, ny = s * n.y, nz = s * n.z;
            for (let a = 0; a < NP; a++) row[a] += nx * Dj[ox + a] + ny * Dj[oy + a] + nz * Dj[oz + a];
        };
        const vecRes = (j, e, w) => {
            // three residual rows: w·e_x, w·e_y, w·e_z, each d/dJ_j = w·unit axis
            for (const [ax, val] of [[v3(1, 0, 0), e.x], [v3(0, 1, 0), e.y], [v3(0, 0, 1), e.z]]) {
                row.fill(0); gradJ(j, ax, w); add1(w * val, w);
            }
        };
        let r2 = 0, nUsed = 0, nOut = 0;
        if (wantSystem) wt.fill(0);
        // Data: each sample's signed distance to the nearest capsule surface (flat math — the hot loop).
        const nb = body.length;
        for (let k = 0; k < nb; k++) {
            const A0 = Jc[body[k][0]], B0 = Jc[body[k][1]];
            const ex = B0.x - A0.x, ey = B0.y - A0.y, ez = B0.z - A0.z;
            CAP[8 * k] = A0.x; CAP[8 * k + 1] = A0.y; CAP[8 * k + 2] = A0.z;
            CAP[8 * k + 3] = ex; CAP[8 * k + 4] = ey; CAP[8 * k + 5] = ez;
            CAP[8 * k + 6] = ex * ex + ey * ey + ez * ez; CAP[8 * k + 7] = body[k][2];
        }
        const wD = Math.sqrt(so.wData / samples.length * 400);
        for (let si = 0; si < samples.length; si++) {
            const i = samples[si];
            const qx = xyz[3 * i], qy = xyz[3 * i + 1], qz = xyz[3 * i + 2];
            let bs = Infinity, bk = -1, bt = 0, bx = 0, by = 0, bz = 0, bd = 1;
            for (let k = 0, o8 = 0; k < nb; k++, o8 += 8) {
                const px = qx - CAP[o8], py = qy - CAP[o8 + 1], pz = qz - CAP[o8 + 2];
                const ex = CAP[o8 + 3], ey = CAP[o8 + 4], ez = CAP[o8 + 5], l2 = CAP[o8 + 6];
                let t = l2 > 0 ? (px * ex + py * ey + pz * ez) / l2 : 0;
                t = t < 0 ? 0 : t > 1 ? 1 : t;
                const dx = px - ex * t, dy = py - ey * t, dz = pz - ez * t;
                const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                const sd = d - CAP[o8 + 7];
                if (sd < bs) { bs = sd; bk = k; bt = t; bx = dx; by = dy; bz = dz; bd = d; }
            }
            if (bk < 0 || Math.abs(bs) > o.corrMax) { nOut++; continue; }
            nUsed++; r2 += bs * bs;
            const a0 = body[bk][0], b0 = body[bk][1];
            if (wantSystem) { wt[a0] += 1 - bt; wt[b0] += bt; }
            const hw = Math.abs(bs) <= so.huber ? 1 : Math.sqrt(so.huber / Math.abs(bs));
            const w = wD * hw;
            if (!wantSystem) { cost += (w * bs) * (w * bs); continue; }
            const inv = bd > 1e-9 ? 1 / bd : 0;
            NRM.x = bx * inv; NRM.y = by * inv; NRM.z = bz * inv;
            row.fill(0);
            gradJ(a0, NRM, -(1 - bt) * w); gradJ(b0, NRM, -bt * w);
            add1(w * bs, w);
        }
        // Vision: rays (perpendicular offset) and, weakly, depth.
        for (let j = 0; j < JOINT_COUNT; j++) {
            const v = vis[j];
            if (!v) continue;
            const cf = Math.max(0, Math.min(1, v.conf));
            if (v.ray) {
                const e = sub(Jc[j], scale(v.ray, dot(Jc[j], v.ray)));
                vecRes(j, e, Math.sqrt(o.wRay * cf * 4));
            }
            if (v.point && v.ray) {
                const target = o.visionSkin ? len(v.point) + radii[j] : len(v.point);
                const w = Math.sqrt(o.wVisionPoint * cf * 4);
                row.fill(0); gradJ(j, v.ray, w); add1(w * (dot(Jc[j], v.ray) - target), w);
            }
        }
        // Named tips.
        for (const t of namedTips) {
            const j = t.joint;
            const dir = norm(sub(Jc[j], Jc[j - 1]));
            const target = add(sub(t.p, scale(dir, radii[j])), scale(norm(t.p), 0.5 * radii[j]));
            vecRes(j, sub(Jc[j], target), Math.sqrt(o.wTip * 4));
        }
        // Palm plane.
        if (plane) {
            const w = Math.sqrt(o.kPlane * 8);
            for (const j of PALM_SET) {
                row.fill(0); gradJ(j, plane.normal, w);
                add1(w * (dot(sub(Jc[j], plane.center), plane.normal) - o.palmRadius), w);
            }
        }
        // Free space and silhouette.
        for (let j = 0; j < JOINT_COUNT; j++) {
            const pp = projectToCloud(c, Jc[j]);
            if (!pp) continue;
            const k = Math.round(pp.u - c.x0), jj = Math.round(pp.v - c.y0);
            if (k < 0 || jj < 0 || k >= c.rw || jj >= c.rh) continue;
            const i = jj * c.rw + k;
            if (cls[i] === CLS_HAND || cls[i] === CLS_ARM) {
                const want = c.depth[i] + o.freeK * radii[j];
                if (pp.z < want) {
                    const ray = norm(Jc[j]), w = Math.sqrt(o.wFree * 4);
                    row.fill(0); gradJ(j, ray, w); add1(w * (pp.z - want) * (len(Jc[j]) / pp.z), w);
                }
            } else if (cls[i] === CLS_BG) {
                const h = nearestPixel(c, cls, k, jj, o.silSearch, (x) => x === CLS_HAND);
                if (h >= 0) {
                    const hk = h % c.rw;
                    const target = scale(pixelRay(c, hk, (h - hk) / c.rw), len(Jc[j]));
                    vecRes(j, sub(Jc[j], target), Math.sqrt(o.wSil * 4));
                }
            }
        }
        // Limits and the temporal prior (on parameters directly).
        const limitRow = (a, lo, hi) => {
            const x = thv[a];
            const viol = x < lo ? x - lo : x > hi ? x - hi : 0;
            if (!viol) return;
            const w = Math.sqrt(so.wLimit) * 4;
            row.fill(0); row[a] = w; add1(w * viol, w);
        };
        for (let f = 0; f < 4; f++) {
            const ob = 6 + 4 * f;
            limitRow(ob, -o.abduction * DEG, o.abduction * DEG);
            for (let s = 0; s < 3; s++) limitRow(ob + 1 + s, lims[s][0] * DEG, lims[s][1] * DEG);
        }
        limitRow(22, so.thumbYaw[0] * DEG, so.thumbYaw[1] * DEG);
        limitRow(23, so.thumbPitch[0] * DEG, so.thumbPitch[1] * DEG);
        limitRow(24, so.thumbFlex[0] * DEG, so.thumbFlex[1] * DEG);
        limitRow(25, so.thumbFlex[0] * DEG, so.thumbFlex[1] * DEG);
        limitRow(26, so.thumbTwist[0] * DEG, so.thumbTwist[1] * DEG);
        limitRow(27, -30 * DEG, 30 * DEG);
        if (prevTheta) {
            const w = Math.sqrt(so.wTemporal);
            for (let a = 6; a < NP; a++) { row.fill(0); row[a] = w; add1(w * (thv[a] - prevTheta[a]), w); }
        }
        return { A, g, cost, rms: nUsed ? Math.sqrt(r2 / nUsed) : NaN, used: nUsed, outliers: nOut };
    };

    for (let it = 0; it < so.lmIters; it++) {
        const sys = build(th, J, true);
        lastCost = sys.cost; rms = sys.rms; used = sys.used; outliers = sys.outliers;
        let accepted = false;
        for (let tries = 0; tries < 4 && !accepted; tries++) {
            const A = Float64Array.from(sys.A);
            for (let a = 0; a < NP; a++) {
                for (let b = 0; b < a; b++) A[a * NP + b] = A[b * NP + a];
                A[a * NP + a] = A[a * NP + a] * (1 + lambda) + 1e-9;
            }
            const neg = sys.g.map((x) => -x);
            const d = cholSolve(A, neg, NP);
            if (!d) { lambda *= 10; continue; }
            const th2 = Float64Array.from(th);
            for (let a = 0; a < NP; a++) th2[a] += d[a];
            const J2 = fk(base, th2, K);
            const c2 = build(th2, J2, false).cost;
            if (c2 < sys.cost) { th = th2; J = J2; lambda = Math.max(1e-7, lambda / 3); accepted = true; } else lambda *= 8;
        }
        // Re-base the pose so the rotation increment stays small.
        base = { R: mmul(rotvec([th[3], th[4], th[5]]), base.R), p: add(base.p, v3(th[0], th[1], th[2])) };
        for (let a = 0; a < 6; a++) th[a] = 0;
        if (!accepted) break;
    }

    const confidence = [], source = [];
    for (let j = 0; j < JOINT_COUNT; j++) {
        const cData = Math.min(1, wt[j] / o.supportFull);
        const v = vis[j];
        source.push(wt[j] >= o.supportMin ? 'cloud' : v?.ray ? 'vision' : 'prior');
        confidence.push(Math.max(cData, 0.6 * (v ? Math.min(1, v.conf) : 0)));
    }
    return {
        ok: true, joints: J, confidence, source, support: Array.from(wt), rms, used, outliers, samples: samples.length,
        initFrom: ctx.initFrom, theta: Array.from(th), cost: lastCost, lambda,
        pinchDist: len(sub(J[Joint.THUMB_TIP], J[Joint.INDEX_TIP])),
    };
}

/** The thumb's 5 parameters fitted to joints J (Gauss–Newton on its 3 joints, a few steps). */
function thumbFrom(J, base, th0, K) {
    const th = Float64Array.from(th0);
    const P = [22, 23, 24, 25, 26, 27], h = 1e-4;
    for (let it = 0; it < 8; it++) {
        const F = fk(base, th, K);
        const r = [], G = [];
        for (const j of [2, 3, 4]) for (const ax of ['x', 'y', 'z']) r.push(F[j][ax] - J[j][ax]);
        for (const a of P) {
            const x0 = th[a]; th[a] = x0 + h; const Fp = fk(base, th, K); th[a] = x0;
            const col = [];
            for (const j of [2, 3, 4]) for (const ax of ['x', 'y', 'z']) col.push((Fp[j][ax] - F[j][ax]) / h);
            G.push(col);
        }
        const nP = P.length, A = new Float64Array(nP * nP), b = new Float64Array(nP);
        for (let a = 0; a < nP; a++) {
            for (let c2 = 0; c2 < nP; c2++) { let sm = 0; for (let i = 0; i < r.length; i++) sm += G[a][i] * G[c2][i]; A[a * nP + c2] = sm + (a === c2 ? 1e-6 : 0); }
            let sm = 0; for (let i = 0; i < r.length; i++) sm += G[a][i] * r[i]; b[a] = -sm;
        }
        const d = cholSolve(A, b, nP);
        if (!d) break;
        P.forEach((a, i) => { th[a] += Math.max(-0.5, Math.min(0.5, d[i])); });
    }
    return th;
}

/** d(joint)/d(θ) by central differences through the kinematics: flat [(3·joint + axis)·NP + param]. */
function jointJacobian(base, th, K) {
    const D = new Float64Array(JOINT_COUNT * 3 * NP);
    const h = 1e-4;
    const t = Float64Array.from(th);
    for (let a = 0; a < NP; a++) {
        const x0 = t[a];
        t[a] = x0 + h; const Jp = fk(base, t, K);
        t[a] = x0 - h; const Jm = fk(base, t, K);
        t[a] = x0;
        for (let j = 0; j < JOINT_COUNT; j++) {
            const o = 3 * j * NP + a;
            D[o] = (Jp[j].x - Jm[j].x) / (2 * h);
            D[o + NP] = (Jp[j].y - Jm[j].y) / (2 * h);
            D[o + 2 * NP] = (Jp[j].z - Jm[j].z) / (2 * h);
        }
    }
    return D;
}

export { fk, anglesFrom, jointJacobian };

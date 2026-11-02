/**
 * handMetrics — the acceptance numbers for the DISPLAYED hand, per joint, the same on a
 * recording (tools/hand-replay.mjs) and live (calib.status, the Hand panel):
 *
 *   still jitter — in windows where a joint is still (its displayed line-fit speed over
 *                  `windowS` under `stillSpeed`), the rms of its displayed position about a
 *                  QUADRATIC fit over the window (slow drift and slow curved motion — a pinch
 *                  closing, a tilt turning round — are not jitter; jitter is what's left), in m;
 *                  p50 / p95 over windows.
 *   motion lag   — in windows where a joint moves (its RAW line-fit speed over `windowS` above
 *                  `moveSpeed`), the delay that best aligns the displayed track to the raw one
 *                  (raw is noisy but unbiased in time), in s; p50 / p95 over windows.
 *
 * Target (Ivan): a still hand under 0.5 mm p95 at every joint, tips included, with the lag
 * while moving reported. Pure: feed it frames, read `report()`.
 */

import { JOINT_COUNT } from './HandData.js';
import { percentileSorted } from './handMath.js';

/** @typedef {import('./handMath.js').Vec3} Vec3 */

export const METRICS_DEFAULTS = {
    windowS: 0.5,
    everyS: 0.25,        // evaluate a window this often (overlapping windows)
    stillSpeed: 0.01,    // m/s: a displayed joint slower than this over the window is still
    moveSpeed: 0.05,     // m/s: a raw joint faster than this over the window is moving
    maxLagS: 0.3,        // lag searched in 0 … maxLagS
    lagStepS: 0.005,
    keep: 600,           // samples kept per joint per metric (the most recent)
};

/** Least-squares line through {t, v} samples of one axis: [mean, slope, tMean]. */
function line(ring, k) {
    const n = ring.length;
    const tm = ring.reduce((s, e) => s + e.t, 0) / n;
    const m = ring.reduce((s, e) => s + e.p[k], 0) / n;
    let num = 0, den = 0;
    for (const e of ring) { const d = e.t - tm; num += d * (e.p[k] - m); den += d * d; }
    return [m, den > 0 ? num / den : 0, tm];
}

/** Residual sum of squares of one axis about its least-squares quadratic in t. */
function quadResidual(ring, k) {
    const n = ring.length;
    const tm = ring.reduce((s, e) => s + e.t, 0) / n;
    // Normal equations for v = a + b·u + c·u², u = t − tm.
    let S0 = n, S1 = 0, S2 = 0, S3 = 0, S4 = 0, Y0 = 0, Y1 = 0, Y2 = 0;
    for (const e of ring) {
        const u = e.t - tm, u2 = u * u, y = e.p[k];
        S1 += u; S2 += u2; S3 += u2 * u; S4 += u2 * u2; Y0 += y; Y1 += u * y; Y2 += u2 * y;
    }
    const M = [[S0, S1, S2], [S1, S2, S3], [S2, S3, S4]];
    const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det(M);
    if (!(Math.abs(D) > 1e-300)) return 0;
    const Y = [Y0, Y1, Y2];
    const col = (i) => M.map((row, r) => row.map((v, c) => (c === i ? Y[r] : v)));
    const a = det(col(0)) / D, b = det(col(1)) / D, c = det(col(2)) / D;
    let ss = 0;
    for (const e of ring) { const u = e.t - tm; ss += (e.p[k] - (a + b * u + c * u * u)) ** 2; }
    return ss;
}

/** Interpolated raw position at time t from a time-ordered ring, or null outside it. */
function at(ring, t) {
    if (!ring.length || t < ring[0].t || t > ring[ring.length - 1].t) return null;
    let i = 1;
    while (i < ring.length && ring[i].t < t) i++;
    const a = ring[i - 1], b = ring[Math.min(i, ring.length - 1)];
    const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
    return { x: a.p.x + u * (b.p.x - a.p.x), y: a.p.y + u * (b.p.y - a.p.y), z: a.p.z + u * (b.p.z - a.p.z) };
}

export default class HandMetrics {
    /** @param {Partial<typeof METRICS_DEFAULTS>} [opts] */
    constructor(opts = {}) {
        this.o = { ...METRICS_DEFAULTS, ...opts };
        this.reset();
    }

    reset() {
        this.joints = Array.from({ length: JOINT_COUNT }, () => ({ disp: [], raw: [], jitter: [], lag: [], at: -Infinity }));
    }

    /**
     * @param {(Vec3|null)[]} displayed - the hand as drawn
     * @param {(Vec3|null)[]} raw - the joints before stabilization (the lag reference)
     * @param {number} t - seconds
     */
    push(displayed, raw, t) {
        const o = this.o;
        for (let j = 0; j < JOINT_COUNT; j++) {
            const J = this.joints[j];
            const d = displayed[j], r = raw[j];
            if (d) J.disp.push({ t, p: d });
            if (r) J.raw.push({ t, p: r });
            const horizon = o.windowS + o.maxLagS;
            while (J.disp.length && J.disp[0].t < t - horizon) J.disp.shift();
            while (J.raw.length && J.raw[0].t < t - horizon - o.maxLagS) J.raw.shift();
            if (t - J.at < o.everyS) continue;
            J.at = t;
            this._evaluate(J, t);
        }
    }

    /** @private */
    _evaluate(J, t) {
        const o = this.o;
        const win = J.disp.filter((e) => e.t >= t - o.windowS);
        if (win.length < 8 || win[win.length - 1].t - win[0].t < o.windowS * 0.8) return;
        // Still: the displayed line is slow — then the residual about it is the jitter.
        const lx = line(win, 'x'), ly = line(win, 'y'), lz = line(win, 'z');
        const speed = Math.hypot(lx[1], ly[1], lz[1]);
        if (speed < o.stillSpeed) {
            const ss = quadResidual(win, 'x') + quadResidual(win, 'y') + quadResidual(win, 'z');
            J.jitter.push(Math.sqrt(ss / win.length));
            if (J.jitter.length > o.keep) J.jitter.shift();
            return;
        }
        // Moving (by the raw track): the delay that best aligns displayed to raw.
        const rawWin = J.raw.filter((e) => e.t >= t - o.windowS);
        if (rawWin.length < 8) return;
        const rs = Math.hypot(line(rawWin, 'x')[1], line(rawWin, 'y')[1], line(rawWin, 'z')[1]);
        if (rs < o.moveSpeed) return;
        let best = null, bestErr = Infinity;
        for (let lag = 0; lag <= o.maxLagS + 1e-9; lag += o.lagStepS) {
            let err = 0, n = 0;
            for (const e of win) {
                const p = at(J.raw, e.t - lag);
                if (!p) continue;
                err += (e.p.x - p.x) ** 2 + (e.p.y - p.y) ** 2 + (e.p.z - p.z) ** 2; n++;
            }
            if (n >= win.length * 0.8 && err / n < bestErr) { bestErr = err / n; best = lag; }
        }
        if (best != null) { J.lag.push(best); if (J.lag.length > o.keep) J.lag.shift(); }
    }

    /**
     * Per joint and overall: jitter p50/p95 (m) over still windows, lag p50/p95 (s) over moving ones.
     * `worstJitterP95` is the acceptance number (every joint must be under it).
     */
    report() {
        const pct = (a, p) => (a.length ? percentileSorted([...a].sort((x, y) => x - y), p) : null);
        const joints = this.joints.map((J) => ({
            jitter: { p50: pct(J.jitter, 50), p95: pct(J.jitter, 95), n: J.jitter.length },
            lag: { p50: pct(J.lag, 50), p95: pct(J.lag, 95), n: J.lag.length },
        }));
        const jp = joints.map((x) => x.jitter.p95).filter((x) => x != null);
        const allLag = this.joints.flatMap((J) => J.lag);
        return {
            joints,
            worstJitterP95: jp.length ? Math.max(...jp) : null,
            worstJoint: jp.length ? joints.findIndex((x) => x.jitter.p95 === Math.max(...jp)) : null,
            lagP50: pct(allLag, 50), lagP95: pct(allLag, 95),
        };
    }
}

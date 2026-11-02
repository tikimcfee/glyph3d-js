/**
 * DepthSim — HandSim's hand as a LiDAR depth crop, with KNOWN truth.
 *
 * Renders the noise-free joints HandSim posed (`sim.lastTruth`) as a sphere-capsule hand —
 * a capsule per finger bone (tapering to the tips), a palm slab of overlapping capsules, a
 * forearm leaving the wrist toward the user and down to the elbow — over a ceiling plane,
 * ray-cast from the phone's optical centre into a W×H depth map. Then the sensor: depth noise
 * growing with range, a slow correlated bias (the densified map's low-frequency error),
 * FLYING PIXELS at depth edges (a mix of the hand and the ceiling behind it), dropouts (random,
 * at grazing angles, along edges) and the confidence a device reports for each. Only the
 * crop a device sends is rendered — Vision's keypoint box, padded — and it is emitted in the
 * exact wire form (`depthWire.js`), onto the handFrame's hand, so the tracker reads it as it
 * will read the phone. `last.labels` holds which part each crop pixel saw (PART), the truth
 * segmentation the gates score against.
 *
 * Pure and deterministic: a seeded RNG. No DOM, no Three.js.
 */

import { Joint } from '../HandData.js';
import { v3, add, sub, scale, dot, norm, qrot, rng } from '../handMath.js';
import { encodeDepthCloud } from './depthWire.js';

/** @typedef {import('../handMath.js').Vec3} Vec3 */

/** What a crop pixel saw. */
export const PART = { NONE: 0, CEILING: 1, PALM: 2, ARM: 3, THUMB: 4, INDEX: 5, MIDDLE: 6, RING: 7, PINKY: 8 };
export const PART_NAMES = Object.fromEntries(Object.entries(PART).map(([k, v]) => [v, k.toLowerCase()]));

/** The landscape depth sensor of a phone lying face-down: its long axis along the phone's. */
// camera x → phone −y, camera y → phone +x, camera z → phone +z (row-major camera → phone)
export const FACE_DOWN_TO_PHONE = [0, 1, 0, -1, 0, 0, 0, 0, 1];

export const DEPTH_SIM_DEFAULTS = {
    seed: 7,
    w: 320, h: 240,              // the depth map, pixels
    hfovDeg: 70,                 // across w
    toPhone: FACE_DOWN_TO_PHONE,
    roiPad: 0.25,                // the crop: the keypoint box grown by this × its size on each side
    // the body (× HandSim handScale)
    palmRadius: 0.015,           // the palm slab's half-thickness about the joint centres, m (HandSim skinPalm)
    fingerRadius: [0.009, 0.008, 0.007],    // proximal, middle, distal phalanx, m (≈ HandSim skinFinger)
    thumbRadius: [0.012, 0.0105, 0.009],    // metacarpal, proximal, distal, m
    forearm: true,
    forearmRadius: 0.026,        // m
    forearmLength: 0.26,         // wrist → elbow, m
    forearmDrop: 0.35,           // the elbow's drop per unit of run toward the user (it rests lower)
    // the sensor: 'dense' (independent per-pixel noise, flying edges, confidence) or 'sparse'
    // (the phone's ~24×24 true returns, RGB-guided fill, no confidence)
    sensor: 'dense',
    dots: 24,                    // sparse: true returns across the width (the same pitch down)
    dotJitter: 0.3,              // sparse: the pattern's irregularity (× pitch)
    dotSigma0: 0.003,            // sparse: a return's depth noise σ = dotSigma0 + sigma2 · z², m
    fillRadius: 1.5,             // sparse: fill from returns within this × pitch
    fillSigma: 0.0007,           // sparse: the densifier's per-pixel noise, m
    visionFromMap: true,         // Vision's joint depths sampled from this map, as the phone does
    maxRangeVision: 1.2,         // m: the palm band's depth window (the phone's near cut)
    sigma0: 0.0015,              // depth noise σ = sigma0 + sigma2 · z², m
    sigma2: 0.004,
    biasAmp: 0.0015,             // the slow correlated bias, m (peak)
    biasPeriodPx: 60,            // its spatial period, pixels
    flyProb: 0.6,                // an edge pixel flies (depth between the hand and what's behind)
    edgeDrop: 0.15,              // an edge pixel has no depth
    dropout: 0.01,               // any pixel has no depth
    grazingCos: 0.25,            // surfaces seen more edge-on than this drop out half the time
};

/** Ray (origin at 0, direction D, any length) vs capsule a–b of radius r: the ray parameter, or −1. */
function capsuleHit(D, a, b, r) {
    const ba = sub(b, a), oa = scale(a, -1);
    const baba = dot(ba, ba), bard = dot(ba, D), baoa = dot(ba, oa), rdoa = dot(D, oa), oaoa = dot(oa, oa);
    const dd = dot(D, D);
    const A = baba * dd - bard * bard;
    const B = baba * rdoa - baoa * bard;
    const C = baba * oaoa - baoa * baoa - r * r * baba;
    let h = B * B - A * C;
    if (h >= 0 && A > 1e-18) {
        const t = (-B - Math.sqrt(h)) / A;
        const y = baoa + t * bard;
        if (y > 0 && y < baba) return t;
        const oc = y <= 0 ? oa : scale(b, -1);
        const b2 = dot(D, oc), c2 = dot(oc, oc) - r * r;
        h = b2 * b2 - dd * c2;
        if (h > 0) return (-b2 - Math.sqrt(h)) / dd;
    }
    return -1;
}

/** The outward surface normal of capsule a–b at point p. */
function capsuleNormal(p, a, b) {
    const ba = sub(b, a);
    const t = Math.max(0, Math.min(1, dot(sub(p, a), ba) / Math.max(dot(ba, ba), 1e-18)));
    return norm(sub(p, add(a, scale(ba, t))));
}

const FINGERS = [
    [PART.INDEX, Joint.INDEX_MCP], [PART.MIDDLE, Joint.MIDDLE_MCP], [PART.RING, Joint.RING_MCP], [PART.PINKY, Joint.PINKY_MCP],
];

export default class DepthSim {
    /** @param {Partial<typeof DEPTH_SIM_DEFAULTS>} [opts] */
    constructor(opts = {}) {
        this.opts = { ...DEPTH_SIM_DEFAULTS, ...opts };
        this._rand = rng(this.opts.seed);
        const o = this.opts;
        const fx = (o.w / 2) / Math.tan((o.hfovDeg * Math.PI) / 360);
        this.intr = [fx, fx, (o.w - 1) / 2, (o.h - 1) / 2];
        const r = this._rand;
        this._bias = [0, 1, 2].map(() => ({ a: r() * 6.28, b: r() * 6.28, kx: 0.6 + r() * 0.8, ky: 0.6 + r() * 0.8 }));
        /** The last render: crop, clean depth, part labels, primitives. */
        this.last = null;
    }

    /**
     * The sphere-capsule hand at these joint centres.
     * @param {Vec3[]} J - 21 joint centres, PHONE frame
     * @param {{x:number,y:number,z:number,w:number}} q - the hand's rotation (hand-local +y along the fingers, +z its back)
     * @param {number} s - hand scale
     * @returns {{a: Vec3, b: Vec3, r: number, part: number}[]}
     */
    primitives(J, q, s = 1) {
        const o = this.opts;
        const prims = [];
        const cap = (a, b, r, part) => prims.push({ a, b, r: r * s, part });
        const W = J[Joint.WRIST], mcps = FINGERS.map(([, m]) => J[m]);
        const pr = o.palmRadius;
        // The palm slab: wrist fans to each MCP and the thumb's base, the MCP row, and two cross ties.
        for (const m of mcps) cap(W, m, pr, PART.PALM);
        cap(W, J[Joint.THUMB_CMC], pr, PART.PALM);
        cap(J[Joint.THUMB_CMC], J[Joint.INDEX_MCP], pr, PART.PALM);
        for (let i = 0; i < 3; i++) cap(mcps[i], mcps[i + 1], pr, PART.PALM);
        const mid = (a, b, t) => add(a, scale(sub(b, a), t));
        for (const t of [0.4, 0.7]) cap(mid(W, J[Joint.INDEX_MCP], t), mid(W, J[Joint.PINKY_MCP], t), pr, PART.PALM);
        // Fingers.
        for (const [part, base] of FINGERS) for (let k = 0; k < 3; k++) cap(J[base + k], J[base + k + 1], o.fingerRadius[k], part);
        for (let k = 0; k < 3; k++) cap(J[Joint.THUMB_CMC + k], J[Joint.THUMB_CMC + k + 1], o.thumbRadius[k], PART.THUMB);
        // The forearm: from the wrist back toward the user (hand-local −y) and down (−z) to the elbow.
        if (o.forearm) {
            const dir = norm(qrot(q, v3(0, -1, -o.forearmDrop)));
            const elbow = add(W, scale(dir, o.forearmLength * s));
            prims.push({ a: W, b: elbow, r: o.forearmRadius * s, part: PART.ARM });
        }
        return prims;
    }

    /** Camera ray (unnormalized, camera z = 1) through full-map pixel (u, v), in the PHONE frame. @private */
    _ray(u, v) {
        const [fx, fy, cx, cy] = this.intr, R = this.opts.toPhone;
        const X = (u - cx) / fx, Y = (v - cy) / fy;
        return v3(R[0] * X + R[1] * Y + R[2], R[3] * X + R[4] * Y + R[5], R[6] * X + R[7] * Y + R[8]);
    }

    /** Full-map pixel of a PHONE-frame point. @private */
    _project(p) {
        const [fx, fy, cx, cy] = this.intr, R = this.opts.toPhone;
        const X = R[0] * p.x + R[3] * p.y + R[6] * p.z, Y = R[1] * p.x + R[4] * p.y + R[7] * p.z, Z = R[2] * p.x + R[5] * p.y + R[8] * p.z;
        return Z > 1e-6 ? { u: fx * X / Z + cx, v: fy * Y / Z + cy, z: Z } : null;
    }

    /**
     * Render one crop.
     * @param {{points: Vec3[], q: Object}} truth - HandSim's lastTruth
     * @param {{ceiling: number, gravity?: number[]|null, scale?: number, t?: number}} scene
     * @returns {Object} the wire block (hands[i].cloud)
     */
    render(truth, { ceiling, gravity = null, scale: s = 1, t = 0 }) {
        const o = this.opts, r = this._rand;
        const J = truth.points;
        // The crop: the joints' pixel box, padded (what the device frames from Vision's keypoints).
        let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
        for (const p of J) {
            const px = this._project(p);
            if (!px) continue;
            u0 = Math.min(u0, px.u); u1 = Math.max(u1, px.u); v0 = Math.min(v0, px.v); v1 = Math.max(v1, px.v);
        }
        const pu = (u1 - u0) * o.roiPad, pv = (v1 - v0) * o.roiPad;
        const x0 = Math.max(0, Math.floor(u0 - pu)), y0 = Math.max(0, Math.floor(v0 - pv));
        const x1 = Math.min(o.w - 1, Math.ceil(u1 + pu)), y1 = Math.min(o.h - 1, Math.ceil(v1 + pv));
        const rw = Math.max(1, x1 - x0 + 1), rh = Math.max(1, y1 - y0 + 1), n = rw * rh;

        const prims = this.primitives(J, truth.q, s);
        // Each primitive's pixel box, so a pixel tests only what could cover it.
        for (const p of prims) {
            const A = this._project(p.a), B = this._project(p.b);
            if (!A || !B) { p.box = null; continue; }
            const pad = (p.r * this.intr[0]) / Math.min(A.z, B.z) + 2;
            p.box = [Math.min(A.u, B.u) - pad, Math.min(A.v, B.v) - pad, Math.max(A.u, B.u) + pad, Math.max(A.v, B.v) + pad];
        }
        const up = gravity ? norm(v3(-gravity[0], -gravity[1], -gravity[2])) : v3(0, 0, 1);

        const clean = new Float32Array(n), back = new Float32Array(n), cosv = new Float32Array(n);
        const labels = new Uint8Array(n);
        for (let j = 0, i = 0; j < rh; j++) {
            for (let k = 0; k < rw; k++, i++) {
                const u = x0 + k, v = y0 + j;
                const D = this._ray(u, v);
                const dup = dot(D, up);
                const tc = dup > 1e-6 ? ceiling / dup : 0; // the ceiling plane: p·up = ceiling
                back[i] = tc;
                let best = Infinity, bp = null;
                for (const p of prims) {
                    if (!p.box || u < p.box[0] || u > p.box[2] || v < p.box[1] || v > p.box[3]) continue;
                    const th = capsuleHit(D, p.a, p.b, p.r);
                    if (th > 0 && th < best) { best = th; bp = p; }
                }
                if (bp) {
                    clean[i] = best;
                    labels[i] = bp.part;
                    const hit = scale(D, best);
                    cosv[i] = Math.abs(dot(capsuleNormal(hit, bp.a, bp.b), norm(D)));
                } else if (tc > 0) {
                    clean[i] = tc; labels[i] = PART.CEILING; cosv[i] = Math.abs(dup / Math.sqrt(dot(D, D)));
                }
            }
        }

        if (o.sensor === 'sparse') return this._sparse({ x0, y0, rw, rh, clean, labels, prims, t });
        if (o.sensor !== 'dense') throw new Error(`DepthSim: unknown sensor '${o.sensor}' (dense|sparse)`);

        // The sensor.
        const depth = new Float32Array(n), conf = new Uint8Array(n);
        const P = (2 * Math.PI) / o.biasPeriodPx;
        const fg = (i) => labels[i] >= PART.PALM;
        for (let j = 0, i = 0; j < rh; j++) {
            for (let k = 0; k < rw; k++, i++) {
                const z = clean[i];
                if (!(z > 0)) continue;
                // An edge: this pixel and an 8-neighbour see hand and not-hand.
                let edgeOther = -1;
                for (let dj = -1; dj <= 1 && edgeOther < 0; dj++) for (let dk = -1; dk <= 1; dk++) {
                    const jj = j + dj, kk = k + dk;
                    if ((dj || dk) && jj >= 0 && jj < rh && kk >= 0 && kk < rw && fg(jj * rw + kk) !== fg(i)) { edgeOther = jj * rw + kk; break; }
                }
                let d = z, c = 2;
                if (edgeOther >= 0) {
                    const u = r();
                    if (u < o.edgeDrop) continue;
                    if (u < o.edgeDrop + o.flyProb) {
                        const zf = fg(i) ? z : clean[edgeOther], zb = fg(i) ? (clean[edgeOther] || back[i]) : z;
                        d = zf + (zb - zf) * r();
                        c = r() < 0.7 ? 0 : 1;
                    } else c = 1;
                }
                if (r() < o.dropout) continue;
                if (cosv[i] < o.grazingCos && r() < 0.5) continue;
                if (cosv[i] < o.grazingCos * 2) c = Math.min(c, 1);
                let bias = 0;
                for (const b of this._bias) bias += Math.sin(P * b.kx * (x0 + k) + b.a + 0.3 * t) * Math.sin(P * b.ky * (y0 + j) + b.b);
                d += (o.biasAmp * bias) / this._bias.length + r.gauss() * (o.sigma0 + o.sigma2 * d * d);
                depth[i] = Math.max(0, d);
                conf[i] = c;
            }
        }

        const roi = [x0, y0, rw, rh];
        this.last = { roi, clean, labels, prims, depth, conf };
        return encodeDepthCloud({ w: o.w, h: o.h, roi, intr: this.intr, toPhone: o.toPhone, depth, conf });
    }

    /**
     * The phone's LiDAR as it reportedly is: a grid of TRUE returns (`dots`², ~3° apart over the
     * field — about one per finger width at 25 cm) densified to the full map, guided by the RGB
     * image: edges follow the true silhouette (the guide sees the hand), and each pixel's depth
     * is interpolated only from returns on its own side of that edge (a Gaussian over the
     * returns within `fillRadius` spacings). Finger depth is thus mostly INFERRED and smooth;
     * the palm, many returns wide, is measured. No per-pixel confidence (AVFoundation sends
     * none). Then the slow bias and a little per-pixel noise.
     * @private
     */
    _sparse({ x0, y0, rw, rh, clean, labels, prims, t }) {
        const o = this.opts, r = this._rand, n = rw * rh;
        const sx = o.w / o.dots, sy = o.h / (o.dots * (o.h / o.w));
        const fg = (i) => labels[i] >= PART.PALM;
        // The returns in (and just around) the crop, with their measured depth and side.
        if (!this._dotJitter) {
            this._dotJitter = [];
            for (let k = 0; k < o.dots * o.dots * 2; k++) this._dotJitter.push([(r() - 0.5) * o.dotJitter, (r() - 0.5) * o.dotJitter]);
        }
        const dots = [];
        const cols = Math.ceil(o.w / sx), rows = Math.ceil(o.h / sy);
        for (let a = 0; a < rows; a++) for (let b = 0; b < cols; b++) {
            const jit = this._dotJitter[(a * cols + b) % this._dotJitter.length];
            const u = (b + 0.5 + jit[0]) * sx - x0, v = (a + 0.5 + jit[1]) * sy - y0;
            const k = Math.round(u), j = Math.round(v);
            if (k < 0 || j < 0 || k >= rw || j >= rh) continue;
            const i = j * rw + k;
            const z = clean[i];
            if (!(z > 0) || r() < o.dropout) continue;
            dots.push({ u, v, z: z + r.gauss() * (o.dotSigma0 + o.sigma2 * z * z), fg: fg(i) });
        }
        // Bucket them by cell for the fill.
        const cell = Math.max(sx, sy), gw = Math.ceil(rw / cell) + 1, gh = Math.ceil(rh / cell) + 1;
        const grid = Array.from({ length: gw * gh }, () => []);
        for (const d of dots) {
            const gx = Math.max(0, Math.min(gw - 1, Math.floor(d.u / cell))), gy = Math.max(0, Math.min(gh - 1, Math.floor(d.v / cell)));
            grid[gy * gw + gx].push(d);
        }
        const R = o.fillRadius * cell, R2 = R * R, s2 = 2 * (0.6 * cell) ** 2, reach = Math.ceil(o.fillRadius) + 1;
        const depth = new Float32Array(n);
        const P = (2 * Math.PI) / o.biasPeriodPx;
        for (let j = 0, i = 0; j < rh; j++) {
            for (let k = 0; k < rw; k++, i++) {
                if (!(clean[i] > 0)) continue;
                const side = fg(i);
                const gx = Math.floor(k / cell), gy = Math.floor(j / cell);
                let sw = 0, sz = 0, nearZ = 0, nearD = Infinity;
                for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
                    const cx = gx + dx, cy = gy + dy;
                    if (cx < 0 || cy < 0 || cx >= gw || cy >= gh) continue;
                    for (const d of grid[cy * gw + cx]) {
                        if (d.fg !== side) continue;
                        const e2 = (d.u - k) ** 2 + (d.v - j) ** 2;
                        if (e2 < nearD) { nearD = e2; nearZ = d.z; }
                        if (e2 > R2) continue;
                        const w = Math.exp(-e2 / s2);
                        sw += w; sz += w * d.z;
                    }
                }
                let z = sw > 1e-6 ? sz / sw : nearD < 4 * R2 ? nearZ : 0;
                if (!(z > 0)) continue;
                let bias = 0;
                for (const b of this._bias) bias += Math.sin(P * b.kx * (x0 + k) + b.a + 0.3 * t) * Math.sin(P * b.ky * (y0 + j) + b.b);
                z += (o.biasAmp * bias) / this._bias.length + r.gauss() * o.fillSigma;
                depth[i] = Math.max(0, z);
            }
        }
        const roi = [x0, y0, rw, rh];
        this.last = { roi, clean, labels, prims, depth, conf: null, dots: dots.length };
        return encodeDepthCloud({ w: o.w, h: o.h, roi, intr: this.intr, toPhone: o.toPhone, depth, conf: null });
    }

    /**
     * Put the crop onto a HandSim frame's hand (in place) from the sim's truth, and make the
     * frame's Vision what this camera could report: a joint outside the image is unseen (no
     * point, no ray). (HandSim's points are already skin, as hand-wire v2 says.) A frame with
     * no hand passes through.
     * @param {Object} payload - from sim.frame(t)
     * @param {import('../HandSim.js').default} sim
     */
    attach(payload, sim) {
        if (!payload.hands.length || !sim.lastTruth) { this.last = null; return payload; }
        const o = this.opts, s = sim.opts.handScale;
        const hand = payload.hands[0];
        for (let j = 0; j < hand.points.length; j++) {
            const px = this._project(sim.lastTruth.points[j]);
            const inView = px && px.u >= 0 && px.v >= 0 && px.u <= o.w - 1 && px.v <= o.h - 1;
            if (!inView) { hand.points[j] = null; hand.rays[j] = null; hand.confidence[j] = Math.min(hand.confidence[j], 0.2); }
        }
        hand.cloud = this.render(sim.lastTruth, {
            ceiling: payload.ceiling ?? sim.opts.ceiling,
            gravity: payload.device?.gravity ?? null,
            scale: s,
            t: payload.timestamp,
        });
        if (o.visionFromMap) this._visionDepth(hand);
        return payload;
    }

    /**
     * Vision's joint depths as the phone takes them — from THIS depth map (hand-wire v2: the
     * palm band from the wrist + MCPs, then per joint the median of the window's pixels within
     * ±12 cm of it, 7×7 for fingertips, 5×5 else; null with fewer than 3) — so Vision's points
     * are exactly as good as the map, never independently better.
     * @private
     */
    _visionDepth(hand) {
        const L = this.last, [x0, y0, rw, rh] = L.roi, D = L.depth;
        const [fx, fy, cx, cy] = this.intr, R = this.opts.toPhone;
        const at = (ray) => {
            const X = R[0] * ray[0] + R[3] * ray[1] + R[6] * ray[2], Y = R[1] * ray[0] + R[4] * ray[1] + R[7] * ray[2], Z = R[2] * ray[0] + R[5] * ray[1] + R[8] * ray[2];
            return Z > 1e-6 ? { k: fx * X / Z + cx - x0, j: fy * Y / Z + cy - y0, zc: Z } : null;
        };
        const sample = (ray, half, lo, hi) => {
            const p = at(ray);
            if (!p) return null;
            const vals = [];
            for (let dj = -half; dj <= half; dj++) for (let dk = -half; dk <= half; dk++) {
                const k = Math.round(p.k) + dk, j = Math.round(p.j) + dj;
                if (k < 0 || j < 0 || k >= rw || j >= rh) continue;
                const z = D[j * rw + k];
                if (z > lo && z < hi) vals.push(z);
            }
            if (vals.length < 3) return null;
            vals.sort((a, b) => a - b);
            return { z: vals[vals.length >> 1], zc: p.zc };
        };
        const palmZ = [];
        for (const j of [0, 5, 9, 13, 17]) {
            const ray = hand.rays[j];
            const v = ray && sample(ray, 2, 0.02, this.opts.maxRangeVision);
            if (v) palmZ.push(v.z);
        }
        palmZ.sort((a, b) => a - b);
        const band = palmZ.length ? palmZ[palmZ.length >> 1] : null;
        const TIPS = new Set([4, 8, 12, 16, 20]);
        for (let j = 0; j < hand.points.length; j++) {
            const ray = hand.rays[j];
            if (!ray || !hand.points[j] || band == null) { if (band == null) hand.points[j] = null; continue; }
            const v = sample(ray, TIPS.has(j) ? 3 : 2, band - 0.12, band + 0.12);
            // z-depth along the camera axis → distance along the ray.
            hand.points[j] = v ? ray.map((c) => c * (v.z / v.zc)) : null;
        }
    }
}

export { capsuleHit };

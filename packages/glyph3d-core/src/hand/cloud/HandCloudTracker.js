/**
 * HandCloudTracker — the hand from its whole depth cloud, Vision's 21 keypoints as the seed.
 *
 * The capture device sends, with each hand, the raw depth crop around it (`depthWire.js`).
 * Each frame runs five stages, each a pure function whose result is kept for inspection:
 *
 *   segment  every crop pixel classified: no depth · background (beyond the ceiling margin) ·
 *            flying (low confidence, or too few neighbours on its own surface — the mixed
 *            hand/ceiling pixels along edges) · another near blob · ARM · HAND. Connected
 *            components over the near pixels (linked where depth doesn't jump); the hand is the
 *            component under Vision's palm keypoints (else the largest); the forearm is cut off
 *            at the wrist, across Vision's wrist → middle-MCP axis.
 *   palm     the palm's centre is the hand blob's deepest interior point (distance transform
 *            max near Vision's palm); a RANSAC plane over the skin around it, refit by PCA on
 *            its inliers: the palm's normal from hundreds of points, not three joints. With the
 *            hand axis (Vision's wrist → middle MCP, else the blob's principal axis away from
 *            the arm) it is a full frame: yaw / pitch / roll.
 *   tips     fingertip candidates as GEODESIC extrema of the blob (AGEX: the farthest surface
 *            point from the palm, then the farthest from palm + every tip so far, …), each named
 *            by the Vision fingertip whose ray passes nearest.
 *   pinch    topology (Wilson 2006): background ENCLOSED by the hand blob — thumb and index
 *            closing a ring — and proximity: the fitted thumb and index tips, with hysteresis.
 *   fit      the personalized skeleton (the caller's learned bone lengths; a palm template
 *            stretched to them) as sphere-capsules, fitted into the cloud by articulated ICP in
 *            position-based form: data → model correspondences pull each capsule onto the skin
 *            it explains; Vision's rays (and, weakly, its depths) pull each joint; labelled tips
 *            pull the fingertips; free space pushes a joint behind the surface seen in front of
 *            it and back inside the silhouette; then constraints: the palm rigid (Kabsch to the
 *            template) on the palm plane, fingers planar with flexion limits and exact bone
 *            lengths, the thumb's bones exact. Init: last frame's fit, else Vision.
 *
 * Output: the 21 joint CENTRES (phone frame, m), per-joint confidence and source (`cloud`:
 * supported by the cloud; `vision`: held by Vision's ray; `prior`: neither), as a handFrame
 * hand — so the live HandModel can be fed it as a better measurement.
 *
 * Every knob is in `opts` (HAND_CLOUD_DEFAULTS), held by reference: a change applies next frame.
 * Pure: no DOM, no Three.js.
 */

import { Joint, JOINT_COUNT } from '../HandData.js';
import {
    v3, add, sub, scale, dot, cross, len, dist, norm, centroid, fitPlane, kabsch, qrot, yawPitchRoll, eigenSym3, rng, boneKey,
} from '../handMath.js';
import { decodeDepthCloud, unprojectCloud, projectToCloud, pixelRay } from './depthWire.js';
import { components, distanceTransform, geodesic, enclosedRegions, nearestPixel, Heap } from './cloudGrid.js';
import { CLS, CLS_NAMES, PALM_SET, MCPS, TIP_JOINTS, jointRadii, palmTemplate, boneLength } from './cloudBody.js';
import { solveStage } from './cloudSolve.js';

/** @typedef {import('../handMath.js').Vec3} Vec3 */
/** @typedef {import('./depthWire.js').DepthCloud} DepthCloud */


export const HAND_CLOUD_DEFAULTS = {
    // segment
    ceilingMargin: 0.25,     // m below the ceiling that still counts as background
    maxHandZ: 0.9,           // m: nothing farther is the hand, ceiling known or not
    minHandZ: 0.04,          // m: nothing nearer is (the sensor's floor)
    minConf: 1,              // the lowest sensor confidence kept (0 keeps all)
    jumpAbs: 0.008,          // neighbours share a surface while depth jumps less than
    jumpRel: 0.04,           //   jumpAbs + jumpRel · depth (m)
    minSupport: 4,           // of 8 neighbours on a pixel's own surface, or it's flying
    minBlobPx: 150,          // the smallest hand blob, pixels
    armCut: 0.012,           // m behind the wrist (along the hand axis) where the arm begins
    armCutK: 1.8,            // no Vision: the arm begins this × the palm's inscribed radius behind its centre
    // palm
    palmSearch: 0.05,        // m around Vision's palm centre to look for the deepest interior point
    palmRegionK: 1.0,        // the palm region: this × the inscribed radius around the centre
    ransacIters: 48,
    ransacThresh: 0.004,     // m
    palmMinInliers: 40,
    // tips
    geoSmooth: 2,            // px: the surface the geodesic walks is smoothed over (2r+1)² on itself
    geoStride: 2,            // the geodesic walks every Nth pixel in each direction
    tipMinGeo: 0.07,         // m of surface from the palm centre, at least, to be a tip
    tipMinSep: 0.025,        // m: stop when the farthest point is this close to palm + tips
    tipMax: 6,
    tipMatch: 0.03,          // m: a Vision tip ray this close names a candidate
    edgePx: 2,               // a candidate this near the depth map's edge is clipped (not a tip)
    edgeAlertPx: 15,         // hand pixels on the map's border before the hand reads 'at the edge'
    // pinch
    holeMinArea: 0.5e-4,     // m² of background the hand must enclose (0.5 cm²)
    holeMinBgFrac: 0.5,      // of the enclosed region's pixels that measured the background
    pinchClose: 0.025,       // m between the fitted thumb and index tips: closed below
    pinchOpen: 0.04,         //   … open above (between: holds)
    // fit: one least-squares solve (cloudSolve.js), Levenberg–Marquardt with correspondences re-found
    lmIters: 6,
    lmLambda: 1e-3,          // initial damping (× the normal matrix's diagonal)
    maxSamples: 500,         // hand points per iteration (an even subsample)
    corrMax: 0.025,          // m: a point farther than this from every capsule is an outlier
    huber: 0.005,            // m: a data residual beyond this counts linearly
    wData: 1,
    wRay: 1.0,               // Vision rays (× confidence): each joint's offset from its ray
    wTemporal: 0.002,        // last frame's angles (low: a pinch is fast)
    wLimit: 0.05,            // outside a joint limit, per radian
    reinitRms: 0.006,        // m: a tracked solve is re-solved from Vision above this residual …
    reinitK: 1.6,            //   … or above this × the hand's running median residual, whichever is higher
    reinitWindow: 60,        //   … over its last this-many fits
    wVisionPoint: 0.1,       // Vision depth pull (× its confidence)
    visionSkin: true,        // Vision's points are skin (hand-wire v2): its centre sits a radius along the ray
    wTip: 0.6,               // labelled tip candidate pull
    wFree: 1.0,              // free space: a joint in front of the surface seen there goes behind it
    freeK: 0.5,              //   … by this × its radius
    wSil: 0.5,               // silhouette: a joint over seen-through background is pulled inside
    silSearch: 20,           //   … from the nearest hand pixel within this many pixels
    kPlane: 0.8,             // palm joints onto the palm plane, a radius inside
    palmRadius: 0.015,       // m, the palm's half-thickness (skin → joint centres; HandModel's skinPrior)
    fingerRadius: [0.009, 0.008, 0.007],
    thumbRadius: [0.012, 0.0105, 0.009],
    mcpFlex: [-30, 95],      // degrees, flexion toward the palm (negative: hyperextension)
    pipFlex: [-5, 110],
    dipFlex: [-10, 90],
    abduction: 35,           // degrees either side of the palm axis
    thumbYaw: [-70, 70],     // degrees: the thumb's base about the palm normal
    thumbPitch: [-70, 70],   //   … about the palm's side axis
    thumbFlex: [-30, 110],   //   MCP and IP flexion
    thumbTwist: [-90, 90],   //   the turn of its flexion plane
    supportMin: 6,           // correspondences for a joint to count as `cloud`
    supportFull: 30,         //   … and to be fully confident
    prevMaxAge: 0.15,        // s: start from last frame's fit if it's this fresh
    outputSkin: false,       // the output points: joint centres (false) or palmar skin like the device's
    seed: 1,
};

/** Quaternion of the rotation whose columns are x, y, z. */
export function quatFromBasis(x, y, z) {
    const m00 = x.x, m11 = y.y, m22 = z.z, tr = m00 + m11 + m22;
    let q;
    if (tr > 0) {
        const s = Math.sqrt(tr + 1) * 2;
        q = { w: s / 4, x: (y.z - z.y) / s, y: (z.x - x.z) / s, z: (x.y - y.x) / s };
    } else if (m00 > m11 && m00 > m22) {
        const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
        q = { w: (y.z - z.y) / s, x: s / 4, y: (y.x + x.y) / s, z: (z.x + x.z) / s };
    } else if (m11 > m22) {
        const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
        q = { w: (z.x - x.z) / s, x: (y.x + x.y) / s, y: s / 4, z: (z.y + y.z) / s };
    } else {
        const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
        q = { w: (x.y - y.x) / s, x: (z.x + x.z) / s, y: (z.y + y.z) / s, z: s / 4 };
    }
    const l = Math.hypot(q.w, q.x, q.y, q.z);
    return { w: q.w / l, x: q.x / l, y: q.y / l, z: q.z / l };
}

const pt = (xyz, i) => ({ x: xyz[3 * i], y: xyz[3 * i + 1], z: xyz[3 * i + 2] });

/**
 * Vision's keypoints in the crop: each joint's crop pixel (from its ray, else its point), its
 * point and ray, confidence. Null entries where Vision has nothing.
 * @param {DepthCloud} c @param {Object|null} hand - a decoded HandFrame
 */
export function visionPrior(c, hand) {
    const J = [];
    for (let j = 0; j < JOINT_COUNT; j++) {
        const point = hand?.points?.[j] || null;
        const ray = hand?.rays?.[j] || (point ? norm(point) : null);
        const conf = hand?.confidence?.[j] ?? (point || ray ? 1 : 0);
        let px = null;
        if (ray) {
            const p = projectToCloud(c, ray);
            if (p) px = { k: p.u - c.x0, j: p.v - c.y0 };
        }
        J.push(point || ray ? { point, ray, conf, px } : null);
    }
    return J;
}

// ── Stage 1: segment ────────────────────────────────────────────────────────

/**
 * @param {DepthCloud} c @param {Float32Array} xyz @param {ReturnType<typeof visionPrior>} vis
 * @param {number|null} ceiling @param {typeof HAND_CLOUD_DEFAULTS} o
 */
export function segmentStage(c, xyz, vis, ceiling, o) {
    const n = c.rw * c.rh, w = c.rw, h = c.rh;
    const cls = new Uint8Array(n);
    const farZ = Math.min(o.maxHandZ, Number.isFinite(ceiling) ? ceiling - o.ceilingMargin : Infinity);
    for (let i = 0; i < n; i++) {
        if (!(c.depth[i] > 0)) { cls[i] = CLS.NONE; continue; }
        const z = xyz[3 * i + 2];
        if (z >= farZ) cls[i] = CLS.BG;
        else if (z < o.minHandZ || (c.conf && c.conf[i] < o.minConf)) cls[i] = CLS.FLY;
        else cls[i] = CLS.NEAR;
    }
    const D = c.depth;
    const link = (i, j) => Math.abs(D[i] - D[j]) < o.jumpAbs + o.jumpRel * D[i];
    // A pixel on a surface has neighbours on it; a flying pixel hangs between two.
    const lone = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cls[i] !== CLS.NEAR) continue;
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < w && yy < h && cls[yy * w + xx] === CLS.NEAR && link(i, yy * w + xx)) s++;
        }
        if (s < o.minSupport) lone.push(i);
    }
    for (const i of lone) cls[i] = CLS.FLY;

    const { label, sizes } = components(w, h, (i) => cls[i] === CLS.NEAR, link);
    // The hand: the component under Vision's palm keypoints, else the largest.
    const hits = new Map();
    for (const j of [Joint.WRIST, ...MCPS]) {
        const px = vis[j]?.px;
        if (!px) continue;
        const i = nearestPixel(c, cls, px.k, px.j, 3, (k) => k === CLS.NEAR);
        if (i >= 0) hits.set(label[i], (hits.get(label[i]) || 0) + 1);
    }
    let chosen = -1, score = -1;
    for (const [lab, size] of sizes) {
        if (size < o.minBlobPx) continue;
        const s = (hits.get(lab) || 0) * 1e7 + size;
        if (s > score) { score = s; chosen = lab; }
    }
    let nHand = 0;
    for (let i = 0; i < n; i++) {
        if (cls[i] !== CLS.NEAR) continue;
        if (label[i] === chosen) { cls[i] = CLS.HAND; nHand++; } else cls[i] = CLS.OTHER;
    }

    // The forearm: behind the wrist along the hand axis.
    let armAxis = null, nArm = 0, armFrom = null;
    const W = vis[Joint.WRIST], M = vis[Joint.MIDDLE_MCP];
    if (nHand && W && M) {
        const at = (v) => {
            if (v.point) return v.point;
            const i = v.px ? nearestPixel(c, cls, v.px.k, v.px.j, 4, (k) => k === CLS.HAND) : -1;
            return i >= 0 ? scale(v.ray, len(pt(xyz, i))) : null;
        };
        const w3 = at(W), m3 = at(M);
        if (w3 && m3 && dist(w3, m3) > 0.02) {
            const a = norm(sub(m3, w3));
            armAxis = { wrist: w3, axis: a };
            armFrom = 'vision';
            for (let i = 0; i < n; i++) {
                if (cls[i] !== CLS.HAND) continue;
                const p = pt(xyz, i);
                if (dot(sub(p, w3), a) < -o.armCut) { cls[i] = CLS.ARM; nArm++; nHand--; }
            }
        }
    }
    const count = new Array(6).fill(0);
    for (let i = 0; i < n; i++) count[cls[i]]++;
    return {
        cls, farZ: Number.isFinite(farZ) ? farZ : null, components: sizes.size, chosen: chosen >= 0,
        seededBy: hits.size ? 'vision' : 'largest', armAxis, armFrom,
        counts: Object.fromEntries(CLS_NAMES.map((k, i) => [k, count[i]])),
    };
}

// ── Stage 2: palm ───────────────────────────────────────────────────────────

/**
 * @param {DepthCloud} c @param {Float32Array} xyz @param {Uint8Array} cls
 * @param {ReturnType<typeof visionPrior>} vis @param {typeof HAND_CLOUD_DEFAULTS} o @param {() => number} rand
 */
export function palmStage(c, xyz, cls, vis, o, rand) {
    const n = c.rw * c.rh;
    const mask = new Uint8Array(n), solid = new Uint8Array(n);
    let any = 0;
    for (let i = 0; i < n; i++) {
        if (cls[i] === CLS.HAND) { mask[i] = 1; any++; }
        // The interior's boundary is what was MEASURED not to be the hand: a dropout or a
        // flying pixel inside the palm is a gap in the data, not an edge of the hand.
        solid[i] = cls[i] === CLS.HAND || cls[i] === CLS.NONE || cls[i] === CLS.FLY ? 1 : 0;
    }
    if (!any) return { ok: false, why: 'no hand pixels' };
    const dt = distanceTransform(c.rw, c.rh, solid);

    // Search near Vision's palm centre (so a thick forearm stub can't win), else everywhere.
    const palmPx = [Joint.WRIST, ...MCPS].map((j) => vis[j]?.px).filter(Boolean);
    let pc = null, rad = Infinity;
    if (palmPx.length >= 3) {
        pc = { k: palmPx.reduce((s, p) => s + p.k, 0) / palmPx.length, j: palmPx.reduce((s, p) => s + p.j, 0) / palmPx.length };
        const i = nearestPixel(c, cls, pc.k, pc.j, 8, (k) => k === CLS.HAND);
        const z = i >= 0 ? c.depth[i] : 0.25;
        rad = (o.palmSearch * c.fx) / z;
    }
    // Ranked by METRIC inscribed radius: the forearm, nearer the camera, is wider in pixels.
    let ci = -1, best = -1;
    for (let i = 0; i < n; i++) {
        if (!mask[i]) continue;
        const m = dt[i] * c.depth[i];
        if (m <= best) continue;
        if (pc) { const k = i % c.rw, j = (i - k) / c.rw; if ((k - pc.k) ** 2 + (j - pc.j) ** 2 > rad * rad) continue; }
        best = m; ci = i;
    }
    if (ci < 0) return { ok: false, why: 'no interior point near the palm' };
    const center = pt(xyz, ci);
    const radius = (dt[ci] * c.depth[ci]) / c.fx;

    const region = [];
    const R2 = (o.palmRegionK * radius) ** 2;
    for (let i = 0; i < n; i++) {
        if (!mask[i]) continue;
        const dx = xyz[3 * i] - center.x, dy = xyz[3 * i + 1] - center.y, dz = xyz[3 * i + 2] - center.z;
        if (dx * dx + dy * dy + dz * dz <= R2) region.push(i);
    }
    if (region.length < 3) return { ok: false, why: `palm region of ${region.length} points`, center, centerIdx: ci, radius };

    // RANSAC, then PCA on the inliers.
    let bestN = null, bestC = null, bestCount = -1;
    for (let it = 0; it < o.ransacIters; it++) {
        const a = pt(xyz, region[Math.floor(rand() * region.length)]);
        const b = pt(xyz, region[Math.floor(rand() * region.length)]);
        const d = pt(xyz, region[Math.floor(rand() * region.length)]);
        const nn = cross(sub(b, a), sub(d, a));
        const l = len(nn);
        if (l < 1e-7) continue;
        const nu = scale(nn, 1 / l);
        let count = 0;
        for (const i of region) {
            const e = (xyz[3 * i] - a.x) * nu.x + (xyz[3 * i + 1] - a.y) * nu.y + (xyz[3 * i + 2] - a.z) * nu.z;
            if (Math.abs(e) < o.ransacThresh) count++;
        }
        if (count > bestCount) { bestCount = count; bestN = nu; bestC = a; }
    }
    if (!bestN) return { ok: false, why: 'degenerate palm region', center, centerIdx: ci, radius };
    const inl = [];
    for (const i of region) {
        const e = (xyz[3 * i] - bestC.x) * bestN.x + (xyz[3 * i + 1] - bestC.y) * bestN.y + (xyz[3 * i + 2] - bestC.z) * bestN.z;
        if (Math.abs(e) < o.ransacThresh) inl.push(i);
    }
    const plane = fitPlane(inl.map((i) => pt(xyz, i)));
    if (!plane || inl.length < o.palmMinInliers) {
        return { ok: false, why: `${inl.length} palm inliers (< ${o.palmMinInliers})`, center, centerIdx: ci, radius, region: region.length, inliers: Int32Array.from(inl) };
    }
    // The normal points INTO the hand from the skin seen (away from the camera).
    let normal = plane.normal;
    if (dot(normal, plane.center) < 0) normal = scale(normal, -1);

    // The hand axis, in the plane.
    let axis = null, axisFrom = null;
    const W = vis[Joint.WRIST], M = vis[Joint.MIDDLE_MCP];
    const wv = W?.point || (W?.ray && scale(W.ray, len(center))), mv = M?.point || (M?.ray && scale(M.ray, len(center)));
    if (wv && mv) { axis = sub(mv, wv); axisFrom = 'vision'; } else {
        // The blob's principal axis, pointed away from the arm (or from the crop's far side).
        const pts = [];
        for (let i = 0; i < n; i += 2) if (mask[i]) pts.push(pt(xyz, i));
        const cen = centroid(pts);
        const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (const p of pts) { const d = [p.x - cen.x, p.y - cen.y, p.z - cen.z]; for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) m[a][b] += d[a] * d[b]; }
        axis = eigenSym3(m).vectors[2];
        const arm = [];
        for (let i = 0; i < n; i += 2) if (cls[i] === CLS.ARM) arm.push(pt(xyz, i));
        // Its sign: away from the arm when one was cut; else the tips decide (orientStage).
        if (arm.length && dot(axis, sub(center, centroid(arm))) < 0) axis = scale(axis, -1);
        axisFrom = arm.length ? 'pca·arm' : 'pca';
    }
    const y = norm(sub(axis, scale(normal, dot(axis, normal))));
    const x = cross(y, normal);
    const q = quatFromBasis(x, y, normal);
    return {
        ok: true, center, centerIdx: ci, radius, region: region.length, inliers: Int32Array.from(inl),
        plane: { center: plane.center, normal, rms: plane.rms }, axis: y, axisFrom, q, ypr: yawPitchRoll(q),
    };
}

// ── Stage 3: tips ───────────────────────────────────────────────────────────

/**
 * Each mask pixel's point averaged with its linked mask neighbours within `r` pixels (a box on
 * its own surface: never across a depth edge), as a new xyz.
 */
export function smoothOnSurface(c, xyz, mask, link, r) {
    const n = c.rw * c.rh, out = new Float32Array(3 * n);
    for (let j = 0; j < c.rh; j++) for (let k = 0; k < c.rw; k++) {
        const i = j * c.rw + k;
        if (!mask[i]) continue;
        let sx = 0, sy = 0, sz = 0, m = 0;
        for (let dj = -r; dj <= r; dj++) {
            const jj = j + dj;
            if (jj < 0 || jj >= c.rh) continue;
            for (let dk = -r; dk <= r; dk++) {
                const kk = k + dk;
                if (kk < 0 || kk >= c.rw) continue;
                const q = jj * c.rw + kk;
                if (!mask[q] || !link(i, q)) continue;
                sx += xyz[3 * q]; sy += xyz[3 * q + 1]; sz += xyz[3 * q + 2]; m++;
            }
        }
        out[3 * i] = sx / m; out[3 * i + 1] = sy / m; out[3 * i + 2] = sz / m;
    }
    return out;
}

/**
 * @param {DepthCloud} c @param {Float32Array} xyz @param {Uint8Array} cls @param {Object} palm
 * @param {ReturnType<typeof visionPrior>} vis @param {typeof HAND_CLOUD_DEFAULTS} o @param {Heap} heap
 */
export function tipsStage(c, xyz, cls, palm, vis, o, heap) {
    const n = c.rw * c.rh;
    if (!palm?.ok) return { tips: [], geo: null };
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = cls[i] === CLS.HAND ? 1 : 0;
    const D = c.depth;
    const link = (i, j) => Math.abs(D[i] - D[j]) < o.jumpAbs + o.jumpRel * D[i];
    // Path length over the raw pixels is mostly depth noise (a 2 mm σ on a 1 mm pixel pitch
    // more than doubles every step): measure it over the surface smoothed on itself — and on a
    // grid decimated by geoStride (a finger stays many cells wide; the walk costs ¼ at 2).
    const sm = smoothOnSurface(c, xyz, mask, link, o.geoSmooth);
    const st = Math.max(1, Math.round(o.geoStride));
    const w2 = Math.ceil(c.rw / st), h2 = Math.ceil(c.rh / st), n2 = w2 * h2;
    const full = new Int32Array(n2), mask2 = new Uint8Array(n2), xyz2 = new Float32Array(3 * n2), D2 = new Float32Array(n2);
    for (let j = 0; j < h2; j++) for (let k = 0; k < w2; k++) {
        const q = j * w2 + k, i = j * st * c.rw + k * st;
        full[q] = i; mask2[q] = mask[i]; D2[q] = D[i];
        xyz2[3 * q] = sm[3 * i]; xyz2[3 * q + 1] = sm[3 * i + 1]; xyz2[3 * q + 2] = sm[3 * i + 2];
    }
    const link2 = (i, j) => Math.abs(D2[i] - D2[j]) < o.jumpAbs + o.jumpRel * D2[i];
    // The palm centre's nearest cell on the grid.
    const pk = palm.centerIdx % c.rw, pj = (palm.centerIdx - pk) / c.rw;
    let src = Math.round(pj / st) * w2 + Math.round(pk / st);
    if (!(src < n2 && mask2[src])) src = Math.floor(pj / st) * w2 + Math.floor(pk / st);
    const geo2 = new Float32Array(n2).fill(Infinity);
    geodesic(w2, h2, mask2, xyz2, geo2, [src], link2, heap);
    const d = geo2.slice();
    const found = [];
    for (let it = 0; it < o.tipMax + 3 && found.length < o.tipMax; it++) {
        let f = -1, fd = -1;
        for (let i = 0; i < n2; i++) if (mask2[i] && d[i] !== Infinity && d[i] > fd) { fd = d[i]; f = i; }
        if (f < 0 || fd < o.tipMinSep) break;
        if (geo2[f] >= o.tipMinGeo) found.push(full[f]);
        geodesic(w2, h2, mask2, xyz2, d, [f], link2, heap);
    }
    // Back to the crop: each pixel reads its cell's distance.
    const geo = new Float32Array(n).fill(Infinity);
    for (let j = 0; j < c.rh; j++) for (let k = 0; k < c.rw; k++) {
        const i = j * c.rw + k;
        if (mask[i]) geo[i] = geo2[Math.min(h2 - 1, Math.round(j / st)) * w2 + Math.min(w2 - 1, Math.round(k / st))];
    }
    const tips = found.map((f) => {
        // A little patch at the extremity, for a steadier point than one pixel.
        const k0 = f % c.rw, j0 = (f - k0) / c.rw;
        let sx = 0, sy = 0, sz = 0, m = 0;
        for (let dj = -2; dj <= 2; dj++) for (let dk = -2; dk <= 2; dk++) {
            const kk = k0 + dk, jj = j0 + dj;
            if (kk < 0 || jj < 0 || kk >= c.rw || jj >= c.rh) continue;
            const i = jj * c.rw + kk;
            if (!mask[i] || !(geo[i] >= geo[f] - 0.008)) continue;
            sx += xyz[3 * i]; sy += xyz[3 * i + 1]; sz += xyz[3 * i + 2]; m++;
        }
        // A finger running out of the image ends at the image's edge, not at its tip.
        const u = c.x0 + k0, v = c.y0 + j0;
        const clipped = u < o.edgePx || v < o.edgePx || u > c.w - 1 - o.edgePx || v > c.h - 1 - o.edgePx;
        return { i: f, p: v3(sx / m, sy / m, sz / m), geo: geo[f], joint: null, miss: null, clipped };
    });
    // Name them by the Vision fingertip rays passing nearest (greedy, nearest pairs first).
    const pairs = [];
    tips.forEach((t, a) => TIP_JOINTS.forEach((j) => {
        if (t.clipped) return; // a finger cut by the image's edge ends there, not at its tip: never named
        const r = vis[j]?.ray;
        if (!r) return;
        const off = len(sub(t.p, scale(r, dot(t.p, r))));
        if (off <= o.tipMatch) pairs.push({ a, j, off });
    }));
    pairs.sort((p, q) => p.off - q.off);
    const usedA = new Set(), usedJ = new Set();
    for (const { a, j, off } of pairs) {
        if (usedA.has(a) || usedJ.has(j)) continue;
        usedA.add(a); usedJ.add(j);
        tips[a].joint = j; tips[a].miss = off;
    }
    return { tips, geo };
}

// ── Stage 3b: orient (no Vision) ────────────────────────────────────────────

/** Re-frame the palm with a new in-plane axis. */
function reframe(palm, axis, from) {
    const n = palm.plane.normal;
    const y = norm(sub(axis, scale(n, dot(axis, n))));
    const q = quatFromBasis(cross(y, n), y, n);
    return { ...palm, axis: y, axisFrom: from, q, ypr: yawPitchRoll(q) };
}

/**
 * Without Vision's axis, the cloud orients itself: the fingers are on the side of the tips (an
 * unsigned principal axis is signed by them), and the forearm is what lies more than
 * `armCutK` inscribed radii behind the palm centre — cut, and its tip candidates dropped.
 * @returns {{palm: Object, tips: Object, cut: number}}
 */
export function orientStage(c, xyz, cls, palm, tips, o) {
    if (!palm?.ok || palm.axisFrom === 'vision') return { palm, tips, cut: 0 };
    let p = palm;
    const real = tips.tips.filter((t) => !t.clipped);
    const use = real.length ? real : tips.tips;
    if (p.axisFrom === 'pca' && use.length) {
        let side = 0;
        for (const t of use) side += Math.sign(dot(sub(t.p, p.center), p.axis));
        if (side < 0) p = reframe(p, scale(p.axis, -1), 'pca·tips');
        else p = { ...p, axisFrom: 'pca·tips' };
    }
    if (p.axisFrom === 'pca·arm' || p.axisFrom === 'pca') return { palm: p, tips, cut: 0 };
    let cut = 0;
    const back = o.armCutK * p.radius;
    for (let i = 0; i < c.rw * c.rh; i++) {
        if (cls[i] !== CLS.HAND) continue;
        const e = (xyz[3 * i] - p.center.x) * p.axis.x + (xyz[3 * i + 1] - p.center.y) * p.axis.y + (xyz[3 * i + 2] - p.center.z) * p.axis.z;
        if (e < -back) { cls[i] = CLS.ARM; cut++; }
    }
    const kept = { ...tips, tips: tips.tips.filter((t) => cls[t.i] === CLS.HAND) };
    return { palm: p, tips: kept, cut };
}

// ── Stage 4: pinch (topology) ───────────────────────────────────────────────

/**
 * Background the hand blob encloses.
 * @param {DepthCloud} c @param {Uint8Array} cls @param {Object} palm @param {typeof HAND_CLOUD_DEFAULTS} o
 */
export function holeStage(c, cls, palm, o) {
    const n = c.rw * c.rh;
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = cls[i] === CLS.HAND ? 1 : 0;
    const z = palm?.center?.z ?? 0.25;
    const pixArea = (z / c.fx) * (z / c.fy);
    const holes = enclosedRegions(c.rw, c.rh, mask).map((px) => {
        let bg = 0, sk = 0, sj = 0;
        for (const i of px) { if (cls[i] === CLS.BG) bg++; const k = i % c.rw; sk += k; sj += (i - k) / c.rw; }
        const area = bg * pixArea;
        return { n: px.length, bg, area, at: { k: sk / px.length, j: sj / px.length }, pixels: px, ok: area >= o.holeMinArea && bg / px.length >= o.holeMinBgFrac };
    }).sort((a, b) => b.area - a.area);
    const best = holes.find((hh) => hh.ok) || null;
    return { holes, hole: best, closed: !!best };
}

// ── Stage 5: fit (init here; the solve is cloudSolve.js) ────────────────────

/**
 * Where the fit starts when it isn't tracking: Vision's joints (centres, from skin along the
 * ray), the palm template placed onto what Vision has of the palm (else onto the palm frame),
 * a missing finger joint on its ray a bone from its parent (else straight on).
 * @param {Object} ctx - {vis, palm, bones, handedness}
 * @param {typeof HAND_CLOUD_DEFAULTS} o
 * @returns {{ok: true, joints: Vec3[], initFrom: string}|{ok: false, why: string}}
 */
export function initStage(ctx, o) {
    const { vis, palm, bones, handedness } = ctx;
    const radii = jointRadii(o);
    const B = boneLength(bones);
    const T = palmTemplate(bones, handedness);
    let initFrom = 'vision';
    const J = new Array(JOINT_COUNT).fill(null);
    for (let j = 0; j < JOINT_COUNT; j++) {
        const v = vis[j];
        if (v?.point) J[j] = o.visionSkin ? add(v.point, scale(v.ray || norm(v.point), radii[j])) : { ...v.point };
    }
    const have = PALM_SET.filter((j) => J[j]);
    let toWorld;
    if (have.length >= 3) {
        const k = kabsch(have.map((j) => T[j]), have.map((j) => J[j]));
        toWorld = (p) => add(qrot(k.q, sub(p, k.fromCenter)), k.toCenter);
    } else if (palm?.ok) {
        initFrom = 'palm';
        const tc = centroid(PALM_SET.map((j) => T[j]));
        const at = add(palm.center, scale(palm.plane.normal, o.palmRadius));
        toWorld = (p) => add(qrot(palm.q, sub(p, tc)), at);
    } else return { ok: false, why: 'nothing to start from (no Vision palm, no palm plane)' };
    for (const j of PALM_SET) if (!J[j]) J[j] = toWorld(T[j]);
    const fwd = norm(sub(J[Joint.MIDDLE_MCP], J[Joint.WRIST]));
    for (const base of [Joint.THUMB_CMC, ...MCPS]) {
        for (let k = 1; k <= 3; k++) {
            const j = base + k;
            if (J[j]) continue;
            const v = vis[j];
            const L = B(j - 1, j);
            if (v?.ray) {
                const p = J[j - 1], r = v.ray;
                const b = dot(r, p), disc = b * b - dot(p, p) + L * L;
                J[j] = disc >= 0 ? scale(r, b - Math.sqrt(disc) > 0.02 ? b - Math.sqrt(disc) : b + Math.sqrt(disc)) : scale(r, b);
            } else J[j] = add(J[j - 1], scale(fwd, L));
        }
    }
    return { ok: true, joints: J, initFrom };
}

// ── Edge: is the hand in the sensor's view? ─────────────────────────────────

/**
 * How much of the hand the depth camera can't see: hand pixels on the depth map's own border
 * (the hand runs off the image there), and fitted joints that project outside it (placed by
 * the skeleton and Vision, not measured).
 * @param {DepthCloud} c @param {Uint8Array} cls @param {Object} fit @param {typeof HAND_CLOUD_DEFAULTS} o
 */
export function edgeStage(c, cls, fit, o) {
    let handPx = 0;
    const e = o.edgePx;
    for (let j = 0; j < c.rh; j++) {
        const v = c.y0 + j;
        const rowEdge = v < e || v > c.h - 1 - e;
        for (let k = 0; k < c.rw; k++) {
            if (cls[j * c.rw + k] !== CLS.HAND) continue;
            const u = c.x0 + k;
            if (rowEdge || u < e || u > c.w - 1 - e) handPx++;
        }
    }
    const outOfView = new Array(JOINT_COUNT).fill(false);
    if (fit?.ok) {
        for (let j = 0; j < JOINT_COUNT; j++) {
            const p = projectToCloud(c, fit.joints[j]);
            outOfView[j] = !p || p.u < 0 || p.v < 0 || p.u > c.w - 1 || p.v > c.h - 1;
        }
    }
    const tipsOut = TIP_JOINTS.filter((j) => outOfView[j]);
    return { handPx, atEdge: handPx >= o.edgeAlertPx, outOfView, tipsOut };
}

// ── The tracker ─────────────────────────────────────────────────────────────

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export default class HandCloudTracker {
    /** @param {Partial<typeof HAND_CLOUD_DEFAULTS>} [opts] */
    constructor(opts = {}) {
        this.opts = { ...HAND_CLOUD_DEFAULTS, ...opts };
        this._rand = rng(this.opts.seed);
        this._heap = new Heap(4096);
        this._xyz = null;
        /** handedness → {joints, t} */
        this._prev = new Map();
        this._pinch = new Map();
        /** handedness → recent fit residuals (the re-init yardstick). */
        this._rms = new Map();
        this.reinits = 0;
        /** The last frame's full stage results (for views and readouts). */
        this.last = null;
    }

    /**
     * Track one hand from its crop.
     * @param {{cloud: Object, hand?: Object|null, bones?: Record<string, number>|null,
     *   ceiling?: number|null, t?: number, handedness?: string}} input -
     *   cloud: the wire block (or a decoded DepthCloud); hand: Vision's decoded HandFrame;
     *   bones: learned bone lengths ('a-b' → m; missing ones fall back to the adult default)
     */
    track({ cloud, hand = null, bones = null, ceiling = null, t = 0, handedness = null }) {
        const o = this.opts;
        const ms = {};
        let t0 = now();
        const c = cloud?.depth instanceof Float32Array ? cloud : decodeDepthCloud(cloud);
        if (!c) return null;
        const n = c.rw * c.rh;
        this._xyz = unprojectCloud(c, this._xyz && this._xyz.length >= 3 * n ? this._xyz : null);
        const xyz = this._xyz;
        const vis = visionPrior(c, hand);
        const side = handedness || hand?.handedness || 'right';
        ms.decode = now() - t0; t0 = now();

        const seg = segmentStage(c, xyz, vis, ceiling, o);
        ms.segment = now() - t0; t0 = now();
        const palm0 = palmStage(c, xyz, seg.cls, vis, o, this._rand);
        ms.palm = now() - t0; t0 = now();
        const tips0 = tipsStage(c, xyz, seg.cls, palm0, vis, o, this._heap);
        const { palm, tips, cut } = orientStage(c, xyz, seg.cls, palm0, tips0, o);
        if (cut) { seg.counts.hand -= cut; seg.counts.arm += cut; seg.armFrom = 'cloud'; }
        ms.tips = now() - t0; t0 = now();
        const holes = holeStage(c, seg.cls, palm, o);
        ms.hole = now() - t0; t0 = now();

        // Fit: from last frame's solve while tracking, else from Vision; a tracked solve whose
        // residual spikes (it lost the hand) is re-solved from Vision, and the better one kept.
        const prev = this._prev.get(side);
        const tracking = prev && t - prev.t >= 0 && t - prev.t <= o.prevMaxAge;
        const ctx = { c, xyz, cls: seg.cls, vis, palm, tips, bones: bones || {}, handedness: side };
        let fit;
        if (tracking) {
            fit = solveStage({ ...ctx, init: prev.joints, initTheta: prev.theta, initFrom: 'previous' }, o);
            // A spike against this hand's own running residual (a real hand sits a few mm off
            // the capsule body every frame), never below the floor.
            const med = this._rmsMedian(side);
            const limit = Math.max(o.reinitRms, med != null ? o.reinitK * med : 0);
            if (fit.ok && !(fit.rms <= limit)) {
                const v0 = initStage(ctx, o);
                const re = v0.ok ? solveStage({ ...ctx, init: v0.joints, initTheta: null, initFrom: `${v0.initFrom} (re-init)` }, o) : v0;
                if (re.ok && re.cost < fit.cost) fit = re;
            }
        } else {
            const v0 = initStage(ctx, o);
            fit = v0.ok ? solveStage({ ...ctx, init: v0.joints, initTheta: null, initFrom: v0.initFrom }, o) : v0;
        }
        ms.fit = now() - t0;
        if (fit.ok) {
            this._prev.set(side, { joints: fit.joints, theta: fit.theta, t });
            const h = this._rms.get(side) || [];
            if (Number.isFinite(fit.rms)) { h.push(fit.rms); if (h.length > o.reinitWindow) h.shift(); }
            this._rms.set(side, h);
            this.reinits = (this.reinits || 0) + (String(fit.initFrom).includes('re-init') ? 1 : 0);
        } else this._prev.delete(side);

        // Pinch: the enclosed hole, or the fitted tips close (with hysteresis).
        let state = this._pinch.get(side) || false;
        const pd = fit.ok ? fit.pinchDist : null;
        if (holes.closed || (pd != null && pd < o.pinchClose)) state = true;
        else if (pd == null || pd > o.pinchOpen) state = false;
        this._pinch.set(side, state);
        const pinch = { closed: state, hole: holes.closed, holeArea: holes.hole?.area ?? 0, tipDist: pd };

        const edge = edgeStage(c, seg.cls, fit, o);
        ms.total = Object.values(ms).reduce((s, v) => s + v, 0);
        const out = fit.ok ? this._handOut(fit, hand, side) : null;
        this.last = { t, handedness: side, cloud: c, xyz, vis, segment: seg, palm, tips, holes, fit, pinch, edge, ms, hand: out };
        return this.last;
    }

    /** The fit as a handFrame hand (points = joint centres, or skin with outputSkin). @private */
    _handOut(fit, hand, side) {
        const o = this.opts;
        const radii = jointRadii(o);
        const points = fit.joints.map((p, j) => {
            const q = o.outputSkin ? sub(p, scale(norm(p), radii[j])) : p;
            return [q.x, q.y, q.z];
        });
        return {
            handedness: side,
            points,
            confidence: fit.confidence,
            rays: hand?.rays ? hand.rays.map((r) => (r ? [r.x, r.y, r.z] : null)) : null,
            source: fit.source,
        };
    }

    /** The median of this hand's recent fit residuals (null until there are a few). @private */
    _rmsMedian(side) {
        const h = this._rms.get(side);
        if (!h || h.length < 5) return null;
        const s = [...h].sort((a, b) => a - b);
        return s[s.length >> 1];
    }

    /** Forget the temporal state (the next frame starts from Vision). */
    reset() { this._prev.clear(); this._pinch.clear(); this._rms.clear(); this.last = null; }

    /** A compact readout of the last frame: what each stage concluded. */
    status() {
        const L = this.last;
        if (!L) return { frame: null };
        const r = (x, d = 4) => (Number.isFinite(x) ? Number(x.toFixed(d)) : null);
        return {
            t: L.t,
            handedness: L.handedness,
            crop: [L.cloud.x0, L.cloud.y0, L.cloud.rw, L.cloud.rh],
            ms: Object.fromEntries(Object.entries(L.ms).map(([k, v]) => [k, r(v, 2)])),
            segment: { ...L.segment.counts, components: L.segment.components, seededBy: L.segment.seededBy, armFrom: L.segment.armFrom },
            palm: L.palm.ok
                ? { inliers: L.palm.inliers.length, region: L.palm.region, rmsMm: r(L.palm.plane.rms * 1000, 2), radiusMm: r(L.palm.radius * 1000, 1),
                    yaw: r(L.palm.ypr.yaw, 1), pitch: r(L.palm.ypr.pitch, 1), roll: r(L.palm.ypr.roll, 1), axisFrom: L.palm.axisFrom }
                : { ok: false, why: L.palm.why },
            tips: L.tips.tips.map((t) => ({ joint: t.joint, geoMm: r(t.geo * 1000, 0), missMm: t.miss == null ? null : r(t.miss * 1000, 1), clipped: t.clipped })),
            edge: { atEdge: L.edge.atEdge, handPx: L.edge.handPx, tipsOut: L.edge.tipsOut, jointsOut: L.edge.outOfView.filter(Boolean).length },
            pinch: { closed: L.pinch.closed, hole: L.pinch.hole, holeCm2: r(L.pinch.holeArea * 1e4, 2), tipMm: L.pinch.tipDist == null ? null : r(L.pinch.tipDist * 1000, 1) },
            fit: L.fit.ok
                ? { rmsMm: r(L.fit.rms * 1000, 2), medianRmsMm: r((this._rmsMedian(L.handedness) ?? NaN) * 1000, 2), reinits: this.reinits, used: L.fit.used, outliers: L.fit.outliers, initFrom: L.fit.initFrom,
                    sources: L.fit.source.reduce((m, s) => ((m[s] = (m[s] || 0) + 1), m), {}) }
                : { ok: false, why: L.fit.why },
        };
    }
}

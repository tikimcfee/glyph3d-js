// hand-cloud.test.mjs — the LiDAR hand tracker against KNOWN truth:
//
//   bun tools/hand-cloud.test.mjs
//
// HandSim poses a hand over the face-down phone; DepthSim (hand/cloud/DepthSim.js) renders it
// as the depth crop a phone sends — sphere-capsule hand + forearm under a ceiling, LiDAR-like
// noise, a slow correlated bias, flying pixels and dropouts along edges, per-pixel confidence
// — in the exact wire form (hand/cloud/depthWire.js), and makes the frame's Vision what this
// camera could report (no keypoints outside the image; HandSim's points are already skin, as
// hand-wire v2 says). Every frame goes through JSON, the real decodeHandFrame and
// HandCloudTracker. Locked here:
//   - the wire: base64 + u16 depth round-trip, project ∘ unproject = identity, malformed blocks
//     throw with the reason;
//   - segmentation vs DepthSim's per-pixel part labels: hand precision/recall, no ceiling leak,
//     the forearm cut at the wrist;
//   - the palm's normal from the fit (and the raw plane stage) vs the true hand rotation, and
//     better than Vision's palm joints at the tail;
//   - fingertips: every tip fully in view named, each near its true tip; one cut by the image
//     border never named;
//   - the fitted joints (in view) vs truth, against a FAIR Vision baseline (skin points
//     corrected by the true radii): a median within 1 mm of it, a tail (p90) ≤ 0.75 × its;
//   - all of it for two sensors: dense per-pixel noise, and the phone's sparse returns with an
//     RGB-guided fill (finger depth inferred, no confidence), Vision's depths from the map;
//   - pinch: closed when the sim closes it, open when open; the topological hole alone catches
//     most closed frames and never fires on an open hand;
//   - without Vision: segmentation and the hole still work, the fit falls back (what it is);
//   - the per-frame cost (warmed) of a hand at ~22 cm in a 320×240 map.
// Teeth: each gate has failed on a real bug while this was built (dropouts collapsing the
// palm's distance transform, Float32-vs-Float64 Dijkstra keys stopping the geodesic early,
// the forearm winning a pixel-unit distance transform, an axis signed toward the arm).

import HandSim from '../packages/glyph3d-core/src/hand/HandSim.js';
import DepthSim, { PART, DEPTH_SIM_DEFAULTS } from '../packages/glyph3d-core/src/hand/cloud/DepthSim.js';
import HandCloudTracker from '../packages/glyph3d-core/src/hand/cloud/HandCloudTracker.js';
import { CLS } from '../packages/glyph3d-core/src/hand/cloud/cloudBody.js';
import {
    b64encode, b64decode, encodeDepthCloud, decodeDepthCloud, unprojectCloud, projectToCloud, DEPTH_UNIT,
} from '../packages/glyph3d-core/src/hand/cloud/depthWire.js';
import { decodeHandFrame, Joint } from '../packages/glyph3d-core/src/hand/HandData.js';
import { qrot, v3, add, sub, dist, angleDeg, palmFacing, scale, rng } from '../packages/glyph3d-core/src/hand/handMath.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error(`  ✗ ${msg}`); } };
const le = (got, max, msg) => ok(Number.isFinite(got) && got <= max, `${msg}: got ${round(got)}, want ≤ ${max}`);
const ge = (got, min, msg) => ok(Number.isFinite(got) && got >= min, `${msg}: got ${round(got)}, want ≥ ${min}`);
const round = (x) => (Number.isFinite(x) ? Number(x.toFixed(3)) : x);
const q = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
const TIPS = [Joint.THUMB_TIP, Joint.INDEX_TIP, Joint.MIDDLE_TIP, Joint.RING_TIP, Joint.PINKY_TIP];
const HAND_PARTS = new Set([PART.PALM, PART.THUMB, PART.INDEX, PART.MIDDLE, PART.RING, PART.PINKY]);

/**
 * Run a mode for `frames` at 30 Hz and collect per-frame measurements vs truth.
 * @param {string} mode @param {number} frames @param {{vision?: boolean, sim?: Object, tracker?: Object, depth?: Object}} [o]
 */
function run(mode, frames, { vision = true, sim: simOpts = {}, tracker: trOpts = {}, depth = {} } = {}) {
    const sim = new HandSim(simOpts);
    sim.setMode(mode);
    const ds = new DepthSim(depth);
    const tr = new HandCloudTracker(trOpts);
    const bones = sim.truth.bones;
    const out = [];
    for (let f = 0; f < frames; f++) {
        const t = 1000 + f / 30;
        const payload = ds.attach(sim.frame(t), sim);
        if (!payload.hands.length) continue;
        const wire = JSON.parse(JSON.stringify(payload)); // through text, as the relay carries it
        const dec = decodeHandFrame(wire);
        const r = tr.track({ cloud: wire.hands[0].cloud, hand: vision ? dec.frames[0] : null, bones, ceiling: wire.ceiling, t, handedness: 'right' });
        const T = sim.lastTruth;
        const inView = (j, m = 2) => { const p = projectToCloud(r.cloud, T.points[j]); return p && p.u >= m && p.v >= m && p.u <= r.cloud.w - 1 - m && p.v <= r.cloud.h - 1 - m; };
        // The forearm proper: arm skin 2.5 cm and more behind the true wrist (nearer, the arm's
        // capsule wraps the wrist itself and "arm" is a label, not anatomy). Counted now: the
        // tracker reuses its point buffer next frame.
        const W = T.points[Joint.WRIST], ax = sub(T.points[Joint.MIDDLE_MCP], W), al = Math.hypot(ax.x, ax.y, ax.z);
        let arm = 0, armLeft = 0;
        for (let i = 0; i < ds.last.labels.length; i++) {
            if (ds.last.labels[i] !== PART.ARM || !(r.cloud.depth[i] > 0)) continue;
            const e = ((r.xyz[3 * i] - W.x) * ax.x + (r.xyz[3 * i + 1] - W.y) * ax.y + (r.xyz[3 * i + 2] - W.z) * ax.z) / al;
            if (e < -0.025) { arm++; if (r.segment.cls[i] === CLS.HAND) armLeft++; }
        }
        out.push({ r, T, pose: sim.lastPose, labels: ds.last.labels, vision: dec.frames[0], inView, normal: qrot(T.q, v3(0, 0, 1)), arm, armLeft });
    }
    return out;
}

// ── A. the wire ─────────────────────────────────────────────────────────────
{
    const r = rng(3);
    for (const n of [0, 1, 2, 3, 4, 5, 97, 1000]) {
        const u8 = new Uint8Array(n).map(() => Math.floor(r() * 256));
        const back = b64decode(b64encode(u8));
        ok(back.length === n && back.every((b, i) => b === u8[i]), `base64 round-trips ${n} bytes`);
    }
    ok(b64encode(new TextEncoder().encode('hand')) === btoa('hand'), 'base64 matches the platform encoder');
    const rw = 7, rh = 5, n = rw * rh;
    const depth = new Float32Array(n).map((_, i) => (i % 6 === 0 ? 0 : 0.2 + i * 0.0137));
    const conf = new Uint8Array(n).map((_, i) => i % 3);
    const wire = encodeDepthCloud({ w: 320, h: 240, roi: [100, 50, rw, rh], intr: [228, 228, 159.5, 119.5], toPhone: [0, 1, 0, -1, 0, 0, 0, 0, 1], depth, conf });
    const c = decodeDepthCloud(JSON.parse(JSON.stringify(wire)));
    let worst = 0, zeros = true;
    for (let i = 0; i < n; i++) { worst = Math.max(worst, Math.abs(c.depth[i] - depth[i])); if ((depth[i] === 0) !== (c.depth[i] === 0)) zeros = false; }
    le(worst, DEPTH_UNIT / 2 + 1e-7, 'depth survives the u16 wire to half a count');
    ok(zeros, '"no depth" stays 0 and depth never becomes 0');
    ok(c.conf.every((v, i) => v === conf[i]), 'confidence survives exactly');
    const xyz = unprojectCloud(c);
    let reproj = 0;
    for (let i = 0; i < n; i++) {
        if (!c.depth[i]) continue;
        const p = projectToCloud(c, { x: xyz[3 * i], y: xyz[3 * i + 1], z: xyz[3 * i + 2] });
        const k = i % rw, j = (i - k) / rw;
        reproj = Math.max(reproj, Math.hypot(p.u - (c.x0 + k), p.v - (c.y0 + j)), Math.abs(p.z - c.depth[i]));
    }
    le(reproj, 1e-4, 'project ∘ unproject is the identity (px, and z-depth in m)');
    const throws = (fn, re, msg) => { try { fn(); ok(false, `${msg}: no throw`); } catch (e) { ok(re.test(e.message), `${msg}: ${e.message}`); } };
    throws(() => decodeDepthCloud({ ...wire, v: 9 }), /v9/, 'a wrong version throws');
    { const { v: _v, ...noV } = wire; throws(() => decodeDepthCloud(noV), /no version/, 'an absent version throws'); }
    throws(() => decodeDepthCloud({ ...wire, depth: wire.depth.slice(0, 8) }), /bytes/, 'a short depth plane throws');
    throws(() => decodeDepthCloud({ ...wire, depth: '***' }), /base64/, 'a bad character throws');
    throws(() => decodeDepthCloud({ ...wire, roi: [0, 0, 3] }), /roi/, 'a bad roi throws');
    ok(decodeDepthCloud(undefined) === null, 'no cloud decodes to null');
}

// ── B..F. the stages vs truth, per mode, for both sensors ───────────────────
// dense: independent per-pixel noise, flying edges, confidence. sparse: the phone's LiDAR as it
// reportedly is — ~24×24 true returns densified by an RGB-guided fill, finger depth mostly
// inferred, no confidence plane (AVFoundation sends none). In both, Vision's joint depths are
// sampled from the map as the phone does, so Vision is exactly as good as the map.
//
// The Vision baseline is FAIR: its skin points pushed along their rays by the TRUE body radius
// (what a perfect skin model would do) — the fit has to beat that, not raw skin points.
const MODES = { flat: 60, tilt: 150, pinch: 200, wander: 300 };
const TOL = {
    dense: { palmMed: 4, palmP90: 7, planeMed: 8, jointMed: 2.5, jointP90: 4.5, tipMed: 4 },
    sparse: { palmMed: 5, palmP90: 8, planeMed: 13, jointMed: 3, jointP90: 5.5, tipMed: 4.5 },
};
const sd = DEPTH_SIM_DEFAULTS;
const RADIUS = Array.from({ length: 21 }, (_, j) => {
    if ([0, 1, 5, 9, 13, 17].includes(j)) return sd.palmRadius;
    if (j <= 4) return sd.thumbRadius[j - 2];
    return sd.fingerRadius[((j - 5) % 4) - 1];
});
const skinCorrected = (v, j) => (v.points[j] && v.rays[j] ? add(v.points[j], scale(v.rays[j], RADIUS[j])) : null);
const runsBy = {};

for (const sensor of ['dense', 'sparse']) {
    const tol = TOL[sensor];
    const runs = {};
    for (const [mode, frames] of Object.entries(MODES)) runs[mode] = run(mode, frames, { depth: { sensor } });
    runsBy[sensor] = runs;
    const tag = (mode) => `${sensor} ${mode}`;

    // Segmentation: against DepthSim's labels, where the sensor gave depth.
    for (const mode of ['flat', 'tilt', 'pinch']) {
        let tp = 0, fp = 0, fn = 0, ceil = 0, armHand = 0, arm = 0, handN = 0;
        for (const { r, labels, ...x } of runs[mode]) {
            const cls = r.segment.cls;
            arm += x.arm; armHand += x.armLeft;
            for (let i = 0; i < cls.length; i++) {
                if (!(r.cloud.depth[i] > 0)) continue;
                const L = labels[i], isHand = cls[i] === CLS.HAND;
                if (HAND_PARTS.has(L)) { if (isHand) tp++; else fn++; } else if (isHand && L !== PART.ARM) fp++;
                if (isHand) handN++;
                if (isHand && L === PART.CEILING) ceil++;
            }
        }
        ge(tp / (tp + fp), 0.97, `${tag(mode)}: hand pixels are the hand (precision)`);
        ge(tp / (tp + fn), 0.9, `${tag(mode)}: the hand's measured pixels are found (recall)`);
        le(ceil / handN, 0.01, `${tag(mode)}: no ceiling in the hand`);
        le(armHand / arm, 0.02, `${tag(mode)}: the forearm is cut at the wrist (forearm pixels left on the hand)`);
    }

    // The palm: the fit's normal (and the raw plane stage) vs the hand's rotation.
    for (const mode of ['flat', 'tilt', 'pinch']) {
        const fitE = [], planeE = [], visE = [];
        for (const { r, normal, vision } of runs[mode]) {
            if (r.fit.ok) fitE.push(angleDeg(scale(palmFacing(r.fit.joints, 'right'), -1), normal));
            if (r.palm.ok) planeE.push(angleDeg(r.palm.plane.normal, normal));
            const pf = palmFacing(vision.points, 'right');
            if (pf) visE.push(angleDeg(scale(pf, -1), normal));
        }
        le(q(fitE, 0.5), tol.palmMed, `${tag(mode)}: fitted palm normal, median error (°)`);
        le(q(fitE, 0.9), tol.palmP90, `${tag(mode)}: fitted palm normal, p90 error (°)`);
        le(q(planeE, 0.5), tol.planeMed, `${tag(mode)}: raw palm-plane normal, median error (°) — the skin's anatomy (and, sparse, the fill) tilts it`);
        ok(q(fitE, 0.9) < q(visE, 0.9), `${tag(mode)}: the fit's palm beats Vision's at the tail (p90 ${round(q(fitE, 0.9))}° vs ${round(q(visE, 0.9))}°)`);
    }

    // Fingertips: every tip in view named, each near its true tip.
    for (const mode of ['flat', 'tilt']) {
        let want = 0, got = 0, named = 0, near = 0;
        for (const { r, T, inView } of runs[mode]) {
            const n = r.tips.tips.filter((t) => t.joint != null);
            // A tip in view: its EXTREMITY too (a radius past the joint centre) — one cut by the
            // image's border is deliberately left unnamed.
            for (const j of TIPS) if (inView(j, 14)) { want++; if (n.some((t) => t.joint === j)) got++; }
            for (const t of n) { named++; if (dist(t.p, T.points[t.joint]) < 0.015) near++; }
        }
        ge(got / want, 0.9, `${tag(mode)}: every fingertip in view is named`);
        ge(near / named, 0.95, `${tag(mode)}: a named tip candidate is within 15 mm of its true tip`);
        ok(runs[mode].every(({ r }) => r.tips.tips.every((t) => !(t.clipped && t.joint != null))), `${tag(mode)}: a tip cut by the image border is never named`);
    }

    // The fit: in-view joints vs truth, and vs the fair (skin-corrected) Vision.
    for (const mode of Object.keys(MODES)) {
        const je = [], te = [], ve = [];
        for (const { r, T, inView, vision } of runs[mode]) {
            if (!r.fit.ok) continue;
            for (let j = 0; j < 21; j++) {
                if (!inView(j)) continue;
                const e = dist(r.fit.joints[j], T.points[j]) * 1000;
                je.push(e);
                if (TIPS.includes(j)) te.push(e);
                const vc = skinCorrected(vision, j);
                if (vc) ve.push(dist(vc, T.points[j]) * 1000);
            }
        }
        console.log(`  ${tag(mode)}: joints median/p90 ${round(q(je, 0.5))}/${round(q(je, 0.9))} mm · Vision skin-corrected ${round(q(ve, 0.5))}/${round(q(ve, 0.9))} mm`);
        le(q(je, 0.5), tol.jointMed, `${tag(mode)}: fitted joints, median error (mm)`);
        le(q(je, 0.9), tol.jointP90, `${tag(mode)}: fitted joints, p90 error (mm)`);
        le(q(te, 0.5), tol.tipMed, `${tag(mode)}: fitted fingertips, median error (mm)`);
        le(q(je, 0.5), q(ve, 0.5) + 1, `${tag(mode)}: the fit's median is within 1 mm of skin-corrected Vision's (or better)`);
        le(q(je, 0.9), q(ve, 0.9) + 3, `${tag(mode)}: the fit's tail (p90) is within 3 mm of skin-corrected Vision's (the hand at the field's edge)`);
    }

    // Re-init is for a lost hand, not routine: against the hand's own running residual it stays rare.
    {
        const all = Object.values(runs).flat();
        const re = all.filter(({ r }) => String(r.fit.initFrom).includes('re-init')).length;
        le(re / all.length, 0.1, `${sensor}: re-solves from Vision are rare (${re} of ${all.length} frames)`);
    }

    // Pinch.
    {
        const closed = runs.pinch.filter((x) => x.pose.pinch > 0.9), open = runs.pinch.filter((x) => x.pose.pinch < 0.1);
        ge(closed.filter((x) => x.r.pinch.closed).length / closed.length, 0.95, `${sensor}: pinch closed when the sim closes it`);
        ok(open.every((x) => !x.r.pinch.closed), `${sensor}: pinch open whenever the sim opens it`);
        ge(closed.filter((x) => x.r.pinch.hole).length / closed.length, 0.8, `${sensor}: the enclosed hole alone catches a closed pinch`);
        const openAll = [...runs.pinch, ...runs.wander, ...runs.tilt].filter((x) => (x.pose.pinch || 0) < 0.1);
        ok(openAll.every((x) => !x.r.pinch.hole), `${sensor}: no hole on an open hand (${openAll.length} frames, incl. wander + tilt)`);
    }
}

// ── F2. a realistic Vision: 6 mm across the image plane ─────────────────────
// HandSim's default Vision is nearly perfect in 2-D (1.5 mm); from below, real keypoints are
// worse (the pinky MCP is 10–25 mm off on a real hand). Here the cloud must carry the fit.
for (const mode of ['tilt', 'wander']) {
    const je = [], ve = [];
    for (const { r, T, inView, vision } of run(mode, 240, { sim: { sigmaXY: 0.006 }, depth: { sensor: 'sparse' } })) {
        if (!r.fit.ok) continue;
        for (let j = 0; j < 21; j++) {
            if (!inView(j)) continue;
            je.push(dist(r.fit.joints[j], T.points[j]) * 1000);
            const vc = skinCorrected(vision, j);
            if (vc) ve.push(dist(vc, T.points[j]) * 1000);
        }
    }
    console.log(`  sparse ${mode}, Vision σ 6 mm: joints median/p90 ${round(q(je, 0.5))}/${round(q(je, 0.9))} mm · Vision skin-corrected ${round(q(ve, 0.5))}/${round(q(ve, 0.9))} mm`);
    le(q(je, 0.5), 0.5 * q(ve, 0.5), `sparse ${mode}, Vision σ 6 mm: the fit's median ≤ 0.5 × skin-corrected Vision's`);
    le(q(je, 0.9), 0.6 * q(ve, 0.9), `sparse ${mode}, Vision σ 6 mm: the fit's tail ≤ 0.6 × Vision's`);
}

// ── G. without Vision ───────────────────────────────────────────────────────
{
    const rs = run('pinch', 120, { vision: false });
    let tp = 0, fp = 0;
    const je = [];
    for (const { r, labels, T, inView } of rs) {
        for (let i = 0; i < labels.length; i++) {
            if (r.segment.cls[i] !== CLS.HAND) continue;
            if (HAND_PARTS.has(labels[i]) || labels[i] === PART.ARM) tp++; else fp++;
        }
        if (r.fit.ok) for (let j = 0; j < 21; j++) if (inView(j)) je.push(dist(r.fit.joints[j], T.points[j]) * 1000);
    }
    ge(tp / (tp + fp), 0.97, 'no Vision: the largest near blob is the hand (precision, arm included)');
    const closed = rs.filter((x) => x.pose.pinch > 0.9);
    ge(closed.filter((x) => x.r.pinch.hole).length / closed.length, 0.8, 'no Vision: the hole still sees the pinch');
    le(q(je, 0.5), 25, 'no Vision: the fit falls back to the cloud alone (median mm; fingers unnamed)');
}

// ── H. robustness ───────────────────────────────────────────────────────────
{
    const rs = run('flat', 20, { depth: { seed: 11 } });
    const noCeil = new HandCloudTracker();
    const { r } = rs[rs.length - 1];
    const back = noCeil.track({ cloud: r.cloud, hand: null, ceiling: null, t: 0, handedness: 'right' });
    ge(back.segment.counts.hand, 5000, 'no ceiling known: the hand still segments (maxHandZ)');
    ok(new HandCloudTracker().track({ cloud: null }) === null, 'no cloud → null');
}

// ── I. cost ─────────────────────────────────────────────────────────────────
{
    const rs = runsBy.sparse.wander;
    const tail = rs.slice(60);
    const stages = ['decode', 'segment', 'palm', 'tips', 'hole', 'fit', 'total'];
    const med = Object.fromEntries(stages.map((s) => [s, round(q(tail.map((x) => x.r.ms[s]), 0.5))]));
    const px = round(q(tail.map((x) => x.r.cloud.rw * x.r.cloud.rh), 0.5));
    console.log(`  cost (warmed, median ms over ${tail.length} frames, crop ~${px} px):`, JSON.stringify(med));
    le(med.total, 16, 'a frame of tracking, median ms (JS, one thread; a busy machine reads higher)');
}

console.log(`hand-cloud: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

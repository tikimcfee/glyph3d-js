// hand-model.test.mjs — the live hand model converges to the truth from a cold start while the
// hand just wanders, and re-converges after the phone is moved:
//
//   bun tools/hand-model.test.mjs
//
// HandSim emits hand-wire v2 frames of a person using it — roaming, pausing, pinching, resting
// flat, moving fast, tilting — with KNOWN truth (bone lengths, per-joint noise, the noise-free
// joints and pose of every frame). Each frame goes through the real decodeHandFrame into
// HandModel; nothing tells the model what the hand is doing. Locked here:
//   - cold start → every quantity settles on the truth: bones, palm length, hand size, the
//     volume (vs the sim path's own percentiles), the rest noise (the 5-joint centroid's σ/√5),
//     pinch modes and thresholds between them, the palm template (relative orientation vs truth);
//   - repair: depthless fingertips (a ray, no point) are rebuilt near the true joint;
//   - a phone bump is detected and re-learns the volume in the new frame, keeping the bones;
//     a still phone never "bumps";
//   - a warm start is useful at once and is outweighed by live frames;
//   - two hands at once, each its own model; WHICH hand is a vote over a tracked hand's life
//     (anatomy while the palm faces down, Vision's label a little): a mislabelled burst or a
//     palm-up stretch grows no ghost, a mirrored label is reported, a blip never becomes a hand,
//     a brief hand stays out of the warm start, an unseen hand reads idle;
//   - the numerics under it (DecayHist forgetting + two modes, Drift, Kabsch, raySphere) and the
//     HandSpace stages reading the model (auto 1€ cutoff hits its target jitter, dead zone,
//     normalize, axes), PinchTracker hysteresis + release dwell.

import HandSim from '../packages/glyph3d-core/src/hand/HandSim.js';
import HandModel, { PalmTracker } from '../packages/glyph3d-core/src/hand/HandModel.js';
import HandSpace, { parseAxes, PinchTracker, cutoffForJitter } from '../packages/glyph3d-core/src/hand/HandSpace.js';
import HandStabilizer from '../packages/glyph3d-core/src/hand/HandStabilizer.js';
import HandMetrics from '../packages/glyph3d-core/src/hand/handMetrics.js';
import { decodeHandFrame, Joint } from '../packages/glyph3d-core/src/hand/HandData.js';
import {
    fitPlane, eigenSym3, rng, kabsch, qrot, qmul, qconj, qangleDeg, yawPitchRoll, DecayHist, Drift, raySphere, dist,
} from '../packages/glyph3d-core/src/hand/handMath.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error(`  ✗ ${msg}`); } };
const near = (got, want, tol, msg) => ok(Number.isFinite(got) && Math.abs(got - want) <= tol, `${msg}: got ${got}, want ${want} ± ${tol}`);
const rel = (got, want, frac, msg) => near(got, want, Math.abs(want) * frac, msg);
const at = (out, id) => out.find((x) => x.id === id).value;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };

/**
 * Run simulators into a model for `seconds`, the device clock starting far from zero (as a
 * phone's uptime does). `each(t)` runs after every frame.
 */
function run(model, sims, seconds, t0, each = null) {
    let t = t0;
    const rate = sims[0].opts.rate;
    for (let i = 0; i < rate * seconds; i++, t += 1 / rate) {
        const decoded = sims.map((s) => decodeHandFrame(s.frame(t)));
        const hands = decoded.flatMap((d) => d.frames);
        model.feed({ t, device: decoded[0].device, hands });
        each?.(t);
    }
    return t;
}

// ── numerics ────────────────────────────────────────────────────────────────
console.log('numerics');
{
    const { values, vectors } = eigenSym3([[4, 1, 0], [1, 3, 0], [0, 0, 1]]);
    near(values[0], 1, 1e-9, 'eigen: smallest value');
    near(Math.abs(vectors[0].z), 1, 1e-9, 'eigen: its vector');
    const r = rng(3);
    const pts = [];
    for (let i = 0; i < 400; i++) { const x = r() - 0.5, y = r() - 0.5; pts.push({ x, y, z: 0.2 + 0.1 * x + r.gauss() * 0.001 }); }
    near(fitPlane(pts).rms, 0.001, 2e-4, 'fitPlane: rms = the noise');

    const qTrue = { w: Math.cos(0.35), x: Math.sin(0.35) * 0.6, y: 0, z: Math.sin(0.35) * 0.8 };
    const from = [{ x: 0, y: 0, z: 0 }, { x: 0.05, y: 0.01, z: 0 }, { x: -0.02, y: 0.08, z: 0.01 }, { x: 0.03, y: 0.07, z: -0.01 }];
    const to = from.map((p) => { const q = qrot(qTrue, p); return { x: q.x + 0.1, y: q.y - 0.2, z: q.z + 0.3 }; });
    const k = kabsch(from, to);
    near(qangleDeg(k.q, qTrue), 0, 1e-6, 'kabsch recovers the rotation');
    near(k.rms, 0, 1e-9, 'kabsch residual 0 on an exact rotation');
    near(yawPitchRoll({ w: Math.cos(0.2), x: 0, y: 0, z: Math.sin(0.2) }).yaw, 22.918, 1e-3, 'yawPitchRoll: a pure yaw');

    // raySphere: the point on the ray at distance L from c.
    const c = { x: 0, y: 0.05, z: 0.25 };
    const hit = raySphere({ x: 0, y: 0, z: 1 }, c, 0.06, 0.25);
    near(dist(hit.p, c), 0.06, 1e-12, 'raySphere: on the sphere');
    ok(hit.hit && hit.p.x === 0 && hit.p.y === 0, 'raySphere: on the ray');

    // DecayHist: quantiles, forgetting, a far clock, two modes.
    const h = new DecayHist({ min: 0, max: 1, bin: 0.001, tau: 10 });
    for (let i = 0; i < 1000; i++) h.add(0.2 + 0.01 * r.gauss(), 5e5 + i * 0.01);
    near(h.quantile(0.5), 0.2, 0.002, 'DecayHist median at a phone-uptime clock (no overflow)');
    for (let i = 0; i < 1000; i++) h.add(0.6 + 0.01 * r.gauss(), 5e5 + 100 + i * 0.01);
    near(h.quantile(0.5), 0.6, 0.003, 'DecayHist forgets: 100 s later (10 τ) the old mode is gone');
    const two = new DecayHist({ min: 0, max: 2, bin: 0.005, tau: Infinity });
    for (let i = 0; i < 300; i++) two.add(0.15 + 0.02 * r.gauss(), i);
    for (let i = 0; i < 2000; i++) two.add(1.1 + 0.05 * r.gauss(), 300 + i);
    const sp = two.split(0.55);
    near(sp.lo.median, 0.15, 0.01, 'split: median below the cut');
    near(sp.hi.median, 1.1, 0.01, 'split: median above the cut');
    near(sp.lo.weight, 300, 1e-9, 'split: weight below the cut');

    const d = new Drift(10, 1);
    for (let i = 0; i <= 12; i++) d.push(i < 6 ? 1 : 1.002, i);
    near(d.drift, 0.002, 1e-12, 'Drift: max − min over the window');
}

// ── the palm tracker ────────────────────────────────────────────────────────
console.log('palm tracker');
{
    const sim = new HandSim({ seed: 2, sigmaXY: 0, sigmaZ: 0, dropout: 0 });
    sim.setMode('flat');
    const pt = new PalmTracker(0.5);
    const c0 = pt.center(decodeHandFrame(sim.frame(0)).frames[0], 0);
    const holed = decodeHandFrame(sim.frame(1 / 60)).frames[0];
    holed.points[Joint.WRIST] = null;
    near(dist(pt.center(holed, 1 / 60), c0), 0, 0.001, 'a dropped wrist does not jump the centre');
}

// ── cold start: converge while the hand just wanders ────────────────────────
console.log('cold start');
const sim = new HandSim({ seed: 7 });
const model = new HandModel();
const truth = sim.truth;
const S = truth.bones['0-9'];
let t = 5e5;
const centers = [];
const rebuiltErr = [];
const offsets = []; // per frame: conj(truth) · model — constant (the template's own frame) up to noise
t = run(model, [sim], 120, t, (now) => {
    const lt = sim.lastTruth;
    if (!lt) return;
    centers.push(lt.center);
    const live = model.hands.get('right')?.live;
    if (!live) return;
    if (now > 5e5 + 60) {
        // Depthless fingertips rebuilt from bone + ray land near the true joint.
        live.rebuilt.forEach((r, j) => { if (r) rebuiltErr.push(dist(live.points[j], lt.points[j])); });
        // Orientation: model = truth · C for a constant C (the template's frame in the hand's);
        // the per-frame spread of conj(truth)·model about its mean is the orientation error.
        if (live.pose) offsets.push(qmul(qconj(lt.q), live.pose.q));
    }
});
{
    const st = model.status();
    const h = st.hands.right;
    console.log(`  after 120 s: bones ${h.bones.settled}/${h.bones.of} settled, volume ${h.volume.state}, noise ${h.noise.state}, pinch ${h.pinch.state}, template ${h.template.state}`);
    ok(st.device.mount === 'faceDown' && st.device.bumps === 0, `a still phone never bumps (${st.device.bumps})`);
    near(st.device.ceiling, sim.opts.ceiling, 0.01, 'ceiling');
    ok(h.handednessMirrored === false, 'handedness not mirrored');

    rel(h.scale.value, S, 0.02, 'palm length |wrist − middle MCP|');
    ok(h.scale.state === 'settled', 'palm length settled');
    rel(h.handSize.value, truth.handSize, 0.02, 'hand size');
    ok(h.bones.state === 'settled', `every bone settled (${h.bones.settled}/${h.bones.of})`);
    let worst = 0;
    for (const [k, b] of Object.entries(h.bones.each)) worst = Math.max(worst, Math.abs(b.value - truth.bones[k]));
    ok(worst < 0.004, `every bone within 4 mm (worst ${(worst * 1000).toFixed(2)} mm)`);

    ok(h.volume.state === 'settled', `volume settled (drift ${h.volume.drift})`);
    for (const a of ['x', 'y', 'z']) {
        const lo = pct(centers.map((c) => c[a]), 0.02), hi = pct(centers.map((c) => c[a]), 0.98);
        near(h.volume.value.min[a], lo, 0.01, `volume min.${a} vs the path's p2`);
        near(h.volume.value.max[a], hi, 0.01, `volume max.${a} vs the path's p98`);
    }

    const s5 = Math.sqrt(5);
    ok(h.noise.state === 'settled', `rest noise settled (from ${h.noise.n} still windows, found unannounced)`);
    rel(h.noise.value.x, truth.noise.sigmaXY / s5, 0.35, 'rest noise x');
    rel(h.noise.value.y, truth.noise.sigmaXY / s5, 0.35, 'rest noise y');
    rel(h.noise.value.z, truth.noise.sigmaZ / s5, 0.35, 'rest noise z');

    const closed = truth.pinch.closed / S, open = truth.pinch.open / S;
    ok(!h.pinch.prior && h.pinch.state === 'settled', `pinch learned from the wander's pinches (${h.pinch.state})`);
    near(h.pinch.value.closed, closed, 0.05, 'pinch closed (÷ palm length)');
    rel(h.pinch.value.open, open, 0.1, 'pinch open (÷ palm length)');
    ok(h.pinch.value.closed < h.pinch.value.on && h.pinch.value.on < h.pinch.value.off && h.pinch.value.off < h.pinch.value.open, 'closed < on < off < open');

    ok(h.template.state === 'settled' && h.neutral.state === 'settled', 'palm template + neutral settled');
    const first = offsets[0];
    const acc = { w: 0, x: 0, y: 0, z: 0 };
    for (let o of offsets) {
        if (o.w * first.w + o.x * first.x + o.y * first.y + o.z * first.z < 0) o = { w: -o.w, x: -o.x, y: -o.y, z: -o.z };
        acc.w += o.w; acc.x += o.x; acc.y += o.y; acc.z += o.z;
    }
    const l = Math.hypot(acc.w, acc.x, acc.y, acc.z);
    const C = { w: acc.w / l, x: acc.x / l, y: acc.y / l, z: acc.z / l };
    const errs = offsets.map((o) => qangleDeg(o, C));
    const rms = Math.sqrt(errs.reduce((a, x) => a + x * x, 0) / errs.length);
    // Measured decomposition (seed 7): noise-free 2.7° — the sim's palm is not rigid (its MCP row
    // spreads with splay, as a real one does) — and per-joint depth noise over a ~5–9 cm palm
    // adds ≈ 5° (research §4.4), ≈ 5.9° together; skin offset on or off changes it < 0.1°.
    ok(errs.length > 1000 && rms < 7, `palm orientation vs truth: ${rms.toFixed(2)}° rms over ${errs.length} frames (raw, unfiltered)`);

    rebuiltErr.sort((a, b) => a - b);
    const med = rebuiltErr[Math.floor(rebuiltErr.length / 2)];
    ok(rebuiltErr.length > 500 && med < 0.008, `rebuilt joints near truth: median ${(med * 1000).toFixed(1)} mm over ${rebuiltErr.length}`);
}

// ── pinch from real-use distributions ───────────────────────────────────────
console.log('pinch modes');
{
    // Real use (live, 2026-11-01): the open distance spreads 0.7–1.5 × palm length as the fingers
    // curl, and pinches are a few % of frames. A variance split (Otsu) halves the open bulk and
    // misses the pinch; the cut at half the open median must find it.
    const r2 = rng(21);
    const mk = (share, sd) => {
        const hm = new HandModel();
        const oh = hm.hand('right');
        oh._boneMed.set('0-9', 0.087);
        for (let i = 0; i < 6000; i++) oh.pinch.add(r2() < share ? 0.25 + 0.04 * r2.gauss() : Math.max(0.7, 1.2 + sd * r2.gauss()), i / 60);
        return oh._pinchEstimate();
    };
    const p2 = mk(0.02, 0.25);
    ok(!p2.prior && Math.abs(p2.closed - 0.25) < 0.03 && Math.abs(p2.open - 1.2) < 0.06, `broad open + 2% pinches: learned (closed ${p2.closed?.toFixed(3)}, open ${p2.open?.toFixed(3)})`);
    ok(p2.closed < p2.on && p2.on < p2.off && p2.off < p2.open, 'closed < on < off < open');
    const p30 = mk(0.3, 0.2);
    ok(!p30.prior && Math.abs(p30.open - 1.2) < 0.08, `lots of pinching doesn't drag the open median down (${p30.open?.toFixed(3)})`);
    const p0 = mk(0, 0.25);
    ok(p0.prior, 'no pinch at all: still the research prior');
    const few = mk(0.002, 0.25); // ~12 closed frames
    ok(few.prior && few.closedWeight < 20, `under pinchMinClosed closed frames: still the prior (${few.closedWeight?.toFixed(1)} closed)`);
}

// ── bones need independent poses ────────────────────────────────────────────
console.log('bone poses');
{
    const held = new HandModel();
    const hs = new HandSim({ seed: 61 });
    hs.setMode('flat');
    run(held, [hs], 5, 8e3);
    const hb = held.status().hands.right;
    const own = Object.entries(hb.bones.each).filter(([k]) => k !== '0-9');
    ok(own.every(([, b]) => b.prior > 0.5), `5 s of ONE held pose: every bone is still mostly the reference prior (poses e.g. ${hb.bones.each['5-6'].poses}, prior share ${hb.bones.each['5-6'].prior})`);
    ok(hb.scale.value != null && own.every(([, b]) => b.value != null), 'yet S is known and every bone has a usable length (S × ratio) within the first seconds');
}

// ── skin depth, a non-reference hand, joint limits, joint reliability ───────
console.log('skin + ratios + limits + reliability');
{
    // Skin depth: the sim's points are skin (palm 15 mm, fingers 8 mm nearer along their rays);
    // the palm-length-vs-1/range regression finds r and the lengths come out as joint centres.
    const sk = model.status().hands.right.skin;
    ok(sk.learned != null && Math.abs(sk.learned - truth.skin.palm) < 0.006, `skin depth estimated from heights (diagnostic): ${sk.learned} m vs ${truth.skin.palm}`);
    ok(sk.value === 0.015 && sk.state === 'unknown', 'by default the correction uses the prior, not the height fit');
    // With learning on, an out-of-range fit (the 0 / 40 mm seen live) falls back to the prior.
    const lk = new HandModel({ skinLearn: true });
    run(lk, [new HandSim({ seed: 84, skinPalm: 0.012 })], 90, 5e4);
    const lks = lk.status().hands.right.skin;
    ok(lks.state === 'settled' && Math.abs(lks.value - 0.012) < 0.005, `skinLearn: an in-range fit is used (${lks.value} vs 0.012)`);
    const oh = lk.hands.get('right');
    oh._skin = { w: 100, x: 100 * 4, y: 100 * 0.09, xx: 100 * 16.2, xy: 100 * 4 * 0.09 - 100 * 0.2 * 0.02, d: 100 * 0.25, dd: 100 * (0.0625 + 0.0009), t: 5e4 + 90 };
    ok(oh.learnedSkin() > 0.025 && oh.skin() === 0.015, `skinLearn: an out-of-range fit (${(oh.learnedSkin() * 1000).toFixed(0)} mm) falls back to the prior`);

    // Fingers 12% longer than the reference skeleton: the bones learn their own deviation.
    const long = new HandSim({ seed: 81, phalangeScale: 1.12 });
    const lm = new HandModel();
    run(lm, [long], 120, 2e4);
    const lb = lm.status().hands.right.bones.each;
    let worstL = 0;
    for (const k of ['5-6', '6-7', '7-8', '9-10', '10-11', '11-12', '13-14', '17-18']) worstL = Math.max(worstL, Math.abs(lb[k].value - long.truth.bones[k]));
    ok(worstL < 0.004, `a hand off the reference (phalanges × 1.12): finger bones within 4 mm (worst ${(worstL * 1000).toFixed(2)} mm)`);

    // Joint limits pick the rebuild: curled fingers with depthless tips, limits on vs off.
    const errOf = (limits) => {
        const cs = new HandSim({ seed: 82, tipDepthLoss: 1 });
        const cm = new HandModel({ repairLimits: limits });
        run(cm, [cs], 40, 3e4);
        cs.setMode('pinch');
        const errs = [];
        run(cm, [cs], 20, 3e4 + 40, () => {
            const live = cm.hands.get('right')?.live, lt = cs.lastTruth;
            if (!live || !lt) return;
            for (const j of [8, 12, 16, 20]) if (live.rebuilt[j]) errs.push(dist(live.points[j], lt.points[j]));
        });
        errs.sort((a, b) => a - b);
        return { med: errs[Math.floor(errs.length / 2)], p90: errs[Math.floor(errs.length * 0.9)], n: errs.length };
    };
    const on = errOf(true), off = errOf(false);
    ok(on.n > 1000 && on.p90 <= off.p90 + 1e-4 && on.med < 0.012, `depthless curled tips rebuilt within limits: median ${(on.med * 1000).toFixed(1)} mm, p90 ${(on.p90 * 1000).toFixed(1)} (limits off: p90 ${(off.p90 * 1000).toFixed(1)})`);

    // Range-aware evidence: with noise growing as range^1.5 over a tall volume, inverse-variance
    // weights beat range-blind ones.
    const rangeErr = (k) => {
        const rsim = new HandSim({ seed: 85, noiseRangeExp: 1.5, center: { x: 0, y: 0.03, z: 0.26 }, half: { x: 0.12, y: 0.08, z: 0.12 } });
        const rm = new HandModel({ rangeNoiseExp: k });
        run(rm, [rsim], 120, 6e4);
        const each = rm.status().hands.right.bones.each;
        let sq = 0, n = 0;
        for (const [key, v] of Object.entries(each)) { sq += (v.value - rsim.truth.bones[key]) ** 2; n++; }
        return Math.sqrt(sq / n);
    };
    const blind = rangeErr(0), aware = rangeErr(1);
    ok(aware < 0.92 * blind, `range-aware bone evidence: rms ${(aware * 1000).toFixed(2)} mm vs range-blind ${(blind * 1000).toFixed(2)} mm`);

    // A joint the detector places badly (the wrist, +6 mm noise) loses weight on its own.
    const ws = new HandSim({ seed: 83, extraNoise: { 0: 0.006 } });
    const wm = new HandModel();
    run(wm, [ws], 60, 4e4);
    const sig = wm.status().hands.right.template.sigma;
    ok(sig[0] > 2 * Math.max(...sig.slice(1)), `the noisy wrist's learned residual stands out: ${sig.map((x) => (x * 1000).toFixed(2)).join(' / ')} mm`);
}

// ── the skeleton read (the LiDAR cloud tracker's input) ─────────────────────
console.log('skeleton()');
{
    const sk = model.skeleton('right');
    ok(sk && sk.settled && Math.abs(sk.scale - S) < 0.02 * S, 'skeleton(): settled, palm length');
    ok(Object.keys(sk.bones).length === 20 && Object.values(sk.bones).every((b) => b.length > 0 && b.known), 'every chain bone has a known length');
    ok(sk.template?.length === 5 && model.skeleton('left') === null, 'palm template; null for a hand never seen');
}

// ── the phone moves ─────────────────────────────────────────────────────────
console.log('bump');
{
    const h0 = model.status().hands.right;
    sim.bump({ yawDeg: 15, tiltDeg: 4, shift: { x: 0.05, y: 0.03, z: 0 } });
    const after = [];
    let bumpedAt = null;
    const tBump = t;
    t = run(model, [sim], 120, t, (now) => {
        if (bumpedAt == null && model.device.bumps === 1) bumpedAt = now;
        if (bumpedAt != null && sim.lastTruth) after.push(sim.lastTruth.center);
    });
    const h = model.status().hands.right;
    ok(model.device.bumps === 1, `one bump detected (${model.device.bumps})`);
    ok(bumpedAt != null && bumpedAt - tBump < 1.5, `detected within 1.5 s (${(bumpedAt - tBump).toFixed(2)} s)`);
    ok(h.bones.state === 'settled' && h.bones.each['0-9'].n >= h0.bones.each['0-9'].n * 0.5, 'bones kept through the bump');
    ok(h.volume.state === 'settled', `volume re-settled (${h.volume.state})`);
    for (const a of ['x', 'y', 'z']) {
        near(h.volume.value.min[a], pct(after.map((c) => c[a]), 0.02), 0.012, `re-learned volume min.${a}`);
        near(h.volume.value.max[a], pct(after.map((c) => c[a]), 0.98), 0.012, `re-learned volume max.${a}`);
    }
}

// A slide: no turn, so gravity and attitude say nothing — the accelerometer does.
{
    const sl = new HandSim({ seed: 91 });
    const sm = new HandModel();
    let ts = run(sm, [sl], 20, 6e4);
    ok(sm.device.bumps === 0, 'desk-rest acceleration never reads as a slide');
    sl.bump({ shift: { x: 0.06, y: 0, z: 0 } });
    run(sm, [sl], 2, ts);
    ok(sm.device.bumps === 1, `a pure slide is detected from userAcceleration (${sm.device.bumps})`);
}

// ── warm start ──────────────────────────────────────────────────────────────
console.log('warm start');
{
    const snap = JSON.parse(JSON.stringify(model.snapshot()));
    const warm = new HandModel({}, snap);
    const cold = new HandModel();
    const simW = new HandSim({ seed: 31 }), simC = new HandSim({ seed: 31 });
    simW.bump({ yawDeg: 15, tiltDeg: 4, shift: { x: 0.05, y: 0.03, z: 0 } });
    simC.bump({ yawDeg: 15, tiltDeg: 4, shift: { x: 0.05, y: 0.03, z: 0 } });
    run(warm, [simW], 0.3, 9e4);
    run(cold, [simC], 0.3, 9e4);
    const w = warm.status().hands.right, c = cold.status().hands.right;
    ok(w.scale.state !== 'unknown' && c.scale.state === 'unknown', `after 0.3 s: warm knows the palm length (${w.scale.value}), cold doesn't yet`);
    ok(w.volume.value != null && !w.pinch.prior && w.pinch.value?.on > 0, 'warm has a volume and pinch thresholds at once');
    // A wrong warm start (a bigger hand) is outweighed by live frames.
    const wrong = JSON.parse(JSON.stringify(snap));
    for (const k of Object.keys(wrong.hands.right.bones)) wrong.hands.right.bones[k] *= 1.3;
    const fixedUp = new HandModel({}, wrong);
    run(fixedUp, [new HandSim({ seed: 32 })], 20, 7e4);
    rel(fixedUp.status().hands.right.scale.value, S, 0.02, 'a wrong warm start is outweighed within 20 s');
}

// ── two hands ───────────────────────────────────────────────────────────────
console.log('two hands');
{
    // Where a left hand sits beside a right one: its own side of the desk (hands don't pass through each other).
    const left = new HandSim({ seed: 41, handedness: 'left', handScale: 0.85, center: { x: -0.3, y: 0.03, z: 0.25 }, half: { x: 0.08, y: 0.08, z: 0.07 } });
    const right = new HandSim({ seed: 42 });
    const two = new HandModel();
    run(two, [right, left], 60, 1e3);
    const st = two.status().hands;
    ok(st.left && st.right, 'a model per hand');
    rel(st.left.scale.value, left.truth.bones['0-9'], 0.02, 'left palm length (smaller hand)');
    rel(st.right.scale.value, right.truth.bones['0-9'], 0.02, 'right palm length');
    ok(st.left.handednessMirrored === false && st.right.handednessMirrored === false, 'neither mirrored');

    // The same two hands sharing one space, on the same script — and the simulator's script
    // TELEPORTS between segments (no real hand does): a hand landing where the other's track
    // expected it must not feed the other hand's model.
    const left2 = new HandSim({ seed: 41, handedness: 'left', handScale: 0.85, center: { x: -0.1, y: 0.03, z: 0.25 } });
    const right2 = new HandSim({ seed: 42 });
    const shared = new HandModel();
    run(shared, [right2, left2], 60, 1e3);
    const st2 = shared.status().hands;
    rel(st2.right.scale.value, right2.truth.bones['0-9'], 0.02, 'shared space: right palm length (no cross-feeding)');
    rel(st2.left.scale.value, left2.truth.bones['0-9'], 0.02, 'shared space: left palm length');
}

// ── which hand: tracks + the left/right vote ────────────────────────────────
console.log('which hand');
{
    // A right hand Vision calls 'left' for a 32-frame burst, then for a 6 s palm-UP stretch
    // (where the anatomy can't vote): one track, one hand, no ghost.
    const r = new HandSim({ seed: 51 });
    const mm = new HandModel();
    let tt = 3e3;
    tt = run(mm, [r], 10, tt);
    const before = mm.hands.get('right')?.frames ?? 0;
    r.opts.label = 'left';
    tt = run(mm, [r], 32 / 60, tt);
    r.setMode('palmUp');
    tt = run(mm, [r], 6, tt);
    r.opts.label = null;
    r.setMode('wander');
    tt = run(mm, [r], 5, tt);
    const st = mm.status();
    ok(!mm.hands.has('left'), `no ghost left hand (hands: ${[...mm.hands.keys()]})`);
    ok(mm.hands.get('right').frames > before + 32 + 300, 'the mislabelled frames still fed the right hand (same track)');
    ok(st.hands.right.labelAgreement < 1 && st.hands.right.handednessMirrored === false, `label disagreement seen, not "mirrored" (agreement ${st.hands.right.labelAgreement})`);

    // A left hand that Vision always calls 'right' (mirrored): the anatomy decides 'left'.
    const lm = new HandModel();
    run(lm, [new HandSim({ seed: 52, handedness: 'left', label: 'right' })], 5, 4e3);
    ok(lm.hands.has('left') && !lm.hands.has('right'), `a consistently mislabelled left hand is the left hand (${[...lm.hands.keys()]})`);
    ok(lm.status().hands.left.handednessMirrored === true, 'and reads as mirrored');

    // A blip — another "hand" for 2 frames — never gets a model.
    const bm = new HandModel();
    const main = new HandSim({ seed: 53 });
    const blip = new HandSim({ seed: 54, handedness: 'left', center: { x: -0.15, y: 0.05, z: 0.3 } });
    let tb = run(bm, [main], 3, 5e3);
    tb = run(bm, [main, blip], 2 / 60, tb);
    run(bm, [main], 3, tb);
    ok(!bm.hands.has('left'), 'a 2-frame blip never becomes a hand');

    // A hand seen for under snapshotMinFrames stays out of the warm start.
    const sm = new HandModel();
    run(sm, [new HandSim({ seed: 55 })], 1, 6e3);
    ok(sm.hands.has('right') && !sm.snapshot().hands.right, `a 1 s hand (${sm.hands.get('right').frames} frames) is not saved as a warm start`);

    // Out of view: settling reads idle.
    const im = new HandModel();
    const is = new HandSim({ seed: 56 });
    let ti = run(im, [is], 20, 7e3);
    is.setMode('none');
    run(im, [is], 3, ti);
    const ih = im.status().hands.right;
    const states = [ih.scale, ih.volume, ih.noise, ih.pinch, ih.template, ih.neutral, ...Object.values(ih.bones.each)].map((x) => x.state);
    ok(ih.idle >= 2 && !states.includes('settling'), `out of view: idle ${ih.idle} s, nothing reads settling (${[...new Set(states)]})`);
}

// ── the displayed hand: metrics + stabilizer ────────────────────────────────
console.log('displayed hand');
{
    // The metrics on tracks with KNOWN answers: white jitter of known σ on a still point, and a
    // displayed track that is the raw one delayed by 60 ms.
    const r = rng(91);
    const mt = new HandMetrics();
    const pts = (f) => Array.from({ length: 21 }, (_, j) => f(j));
    for (let i = 0; i < 60 * 20; i++) {
        const tt = i / 60;
        const still = pts(() => ({ x: 0.0003 * r.gauss(), y: 0.0003 * r.gauss(), z: 0.25 + 0.0003 * r.gauss() }));
        mt.push(still, still, tt);
    }
    near(mt.report().worstJitterP95, 0.0003 * Math.sqrt(3) * 1.15, 0.0002, 'metrics: still jitter = the 3-D rms of known white noise');
    const ml = new HandMetrics();
    const pos = (tt) => ({ x: 0.1 * Math.sin(3 * tt), y: 0, z: 0.25 });
    for (let i = 0; i < 60 * 20; i++) {
        const tt = i / 60;
        ml.push(pts(() => pos(tt - 0.06)), pts(() => pos(tt)), tt);
    }
    near(ml.report().lagP50, 0.06, 0.006, 'metrics: lag = the known 60 ms delay');

    // The stabilizer on realistic noise (live-measured: knuckles ~1 mm, fingertips 5–11 mm, mostly
    // DEPTH along the ray): a still hand displays under 0.5 mm p95 at EVERY joint, tips included,
    // while moving and tilting stays responsive. Raw, for contrast, is ~13 mm.
    const deep = {};
    for (const j of [4, 8, 12, 16, 20]) deep[j] = 0.008;
    for (const j of [3, 7, 11, 15, 19]) deep[j] = 0.004;
    for (const j of [2, 6, 10, 14, 18]) deep[j] = 0.002;
    const runStab = (params) => {
        const ss = new HandSim({ seed: 3, sigmaXY: 0.0006, sigmaZ: 0.0009, extraDepthNoise: deep });
        const sm = new HandModel();
        const st = new HandStabilizer(params);
        const still = new HandMetrics(), move = new HandMetrics(), tilt = new HandMetrics({ moveSpeed: 0.02 });
        let tt = 1e3;
        const step = (mode, secs, met) => {
            ss.setMode(mode);
            for (let i = 0; i < secs * 60; i++, tt += 1 / 60) {
                const d = decodeHandFrame(ss.frame(tt));
                const lv = sm.feed({ t: tt, device: d.device, hands: d.frames }).hands.right;
                if (!lv) continue;
                const disp = st.update(lv.points, tt, sm.hands.get('right').poseFrom(lv.points)?.q ?? null);
                met?.push(disp, lv.points, tt);
            }
        };
        step('wander', 20, null); step('flat', 20, still); step('motion', 24, move); step('tilt', 30, tilt);
        return { still: still.report(), move: move.report(), tilt: tilt.report(), st };
    };
    const raw = runStab({ enabled: false }), on = runStab({});
    const mm = (x) => (x * 1000).toFixed(2);
    console.log(`  still p95 worst: raw ${mm(raw.still.worstJitterP95)} mm → displayed ${mm(on.still.worstJitterP95)} mm (joint ${on.still.worstJoint}); lag moving ${Math.round(on.move.lagP50 * 1000)}/${Math.round(on.move.lagP95 * 1000)} ms, tilting ${Math.round(on.tilt.lagP50 * 1000)}/${Math.round(on.tilt.lagP95 * 1000)} ms (p50/p95)`);
    ok(raw.still.worstJitterP95 > 0.005, 'raw tips jitter by millimetres (the problem)');
    ok(on.still.joints.every((j) => j.jitter.n > 10 && j.jitter.p95 < 0.0005), `a still hand displays < 0.5 mm p95 at every joint (worst ${mm(on.still.worstJitterP95)} mm)`);
    ok(on.move.lagP50 < 0.05 && on.move.lagP95 < 0.08, `moving: lag ${Math.round(on.move.lagP50 * 1000)} ms p50 (< 50), ${Math.round(on.move.lagP95 * 1000)} p95 (< 80)`);
    ok(on.tilt.lagP50 < 0.12, `tilting: lag ${Math.round(on.tilt.lagP50 * 1000)} ms p50 (< 120) — pitch/roll read from depth are the hard axis`);
    ok(on.st.describe().measured === 21, 'every joint\'s own noise measured');
}

// ── HandSpace on the model ──────────────────────────────────────────────────
console.log('hand space');
{
    const r = rng(11);
    const summary = model.hands.get('right').summary();
    const off = new HandSpace({ spike: { enabled: false }, oneEuro: { enabled: false }, deadZone: { enabled: false }, normalize: { enabled: false }, app: { enabled: false } }, summary);
    const v = { x: 0.01, y: 0.02, z: 0.3 };
    ok(off.run(v, 0).every((s) => s.value.x === v.x && s.value.z === v.z), 'every stage off: pass-through');
    const bare = new HandSpace({}, null).describe();
    ok(!bare.find((s) => s.id === 'normalize').active && !bare.find((s) => s.id === 'deadZone').active, 'no model yet: the model stages pass through and say why');
    ok(/manual/.test(bare.find((s) => s.id === 'oneEuro').from), '1€ waits on manual cutoffs until the model knows the noise');

    // Auto 1€: the rest cutoff solved from the model's noise + rate leaves ≈ the target jitter.
    ok(cutoffForJitter(0.002, 0.002, 60) === null, 'cutoffForJitter: null when the jitter is already at target');
    const target = 0.0003, sigma = 0.0015;
    const auto = new HandSpace({ spike: { enabled: false }, oneEuro: { auto: true, targetJitter: target, beta: 0, zBeta: 0 }, deadZone: { enabled: false }, normalize: { enabled: false }, app: { enabled: false } },
        { noise: { x: sigma, y: sigma, z: sigma, rms: sigma * Math.sqrt(3) }, rate: 60 });
    let sq = 0, n = 0;
    for (let i = 0; i < 6000; i++) {
        const o = auto.run({ x: r.gauss() * sigma, y: 0, z: 0.2 }, i / 60);
        if (i > 120) { sq += at(o, 'oneEuro').x ** 2; n++; }
    }
    rel(Math.sqrt(sq / n), target, 0.2, 'auto 1€: residual rest jitter ≈ target');
    ok(/auto/.test(auto.describe().find((s) => s.id === 'oneEuro').from), 'auto 1€ says where its cutoff came from');

    const dz = new HandSpace({ spike: { enabled: false }, oneEuro: { enabled: false }, normalize: { enabled: false }, app: { enabled: false } }, { noise: { rms: 0.0015 } });
    const radius = 3 * 0.0015;
    dz.run({ x: 0, y: 0, z: 0.2 }, 0);
    ok(at(dz.run({ x: radius * 0.9, y: 0, z: 0.2 }, 0.1), 'deadZone').x === 0, 'dead zone holds inside k × rest noise');
    near(at(dz.run({ x: radius * 3, y: 0, z: 0.2 }, 0.2), 'deadZone').x, radius * 2, 1e-12, 'dead zone drags once passed');

    // Dead zone after the filter: sized from the jitter the filter LEAVES, not the raw noise.
    const post = new HandSpace({ spike: { enabled: false }, oneEuro: { auto: true, targetJitter: 0.0003 }, normalize: { enabled: false }, app: { enabled: false } },
        { noise: { x: 0.0015, y: 0.0015, z: 0.0015, rms: 0.0015 * Math.sqrt(3) }, rate: 60 });
    const dzd = post.describe().find((x) => x.id === 'deadZone');
    rel(dzd.radius, 3 * 0.0003 * Math.sqrt(3), 0.05, 'dead zone = 3 × post-filter rest jitter (the auto 1€ target, per axis)');
    ok(/post-filter/.test(dzd.from), 'and says so');

    // Normalize: one isotropic gain (the widest reach → ±1), frozen once the volume settles.
    const vol = { volume: { center: { x: 0, y: 0.03, z: 0.22 }, reach: { x: 0.24, y: 0.16, z: 0.14 }, state: 'settling', epoch: 1 } };
    const nz = new HandSpace({ spike: { enabled: false }, oneEuro: { enabled: false }, deadZone: { enabled: false }, app: { enabled: false } }, vol);
    const hi = at(nz.run({ x: 0.12, y: 0.11, z: 0.29 }, 0), 'normalize');
    ok(Math.abs(hi.x - 1) < 1e-9 && Math.abs(hi.y - 0.08 / 0.12) < 1e-9 && Math.abs(hi.z - 0.07 / 0.12) < 1e-9,
        `normalize: one gain on every axis — the widest reach → ±1 (got ${JSON.stringify(hi)})`);
    ok(/live/.test(nz.describe().find((x) => x.id === 'normalize').from), 'not frozen while the volume is still settling');
    nz.model = { volume: { ...vol.volume, state: 'settled' } };
    nz.run({ x: 0, y: 0.03, z: 0.22 }, 0.1);
    nz.model = { volume: { center: { x: 0.05, y: 0.03, z: 0.22 }, reach: { x: 0.3, y: 0.16, z: 0.14 }, state: 'settling', epoch: 1 } };
    nz.set('oneEuro.beta', 7); // a filter knob must not move the frozen map
    const same = at(nz.run({ x: 0.12, y: 0.03, z: 0.22 }, 0.2), 'normalize');
    ok(Math.abs(same.x - 1) < 1e-9, `frozen once settled: a drifting volume (or a knob) doesn't move the map (x ${same.x})`);
    nz.model = { volume: { center: { x: 0.05, y: 0.03, z: 0.22 }, reach: { x: 0.3, y: 0.16, z: 0.14 }, state: 'settling', epoch: 2 } };
    const moved = at(nz.run({ x: 0.12, y: 0.03, z: 0.22 }, 0.3), 'normalize');
    near(moved.x, 0.07 / 0.15, 1e-9, 'a new volume epoch (bump / reset) re-learns the map');
    const aniso = new HandSpace({ spike: { enabled: false }, oneEuro: { enabled: false }, deadZone: { enabled: false }, app: { enabled: false }, normalize: { isotropic: false, freeze: false } }, vol);
    const hi2 = at(aniso.run({ x: 0.12, y: 0.11, z: 0.29 }, 0), 'normalize');
    ok([hi2.x, hi2.y, hi2.z].every((u) => Math.abs(u - 1) < 1e-9), 'isotropic off: per-axis, the volume corner → (1, 1, 1)');
    const app = new HandSpace({ spike: { enabled: false }, oneEuro: { enabled: false }, deadZone: { enabled: false }, normalize: { enabled: false }, app: { scale: 2 } });
    const a = at(app.run({ x: 1, y: 2, z: 3 }, 0), 'app');
    ok(a.x === 2 && a.y === 6 && a.z === -4, `app axes 'x z -y' × 2 (got ${JSON.stringify(a)})`);
    let threw = false; try { parseAxes('x x y'); } catch { threw = true; }
    ok(threw, 'axes naming an axis twice throws');

    // Spike gate: 1% of samples thrown 3 cm off a moving hand are held at the prediction; a
    // real jump (a step that stays) is accepted after maxHold frames.
    const sg = new HandSpace({ oneEuro: { enabled: false }, deadZone: { enabled: false }, normalize: { enabled: false }, app: { enabled: false } }, { noise: { rms: 0.001 } });
    const rs = rng(77);
    let rawErr = 0, gatedErr = 0, nS = 0;
    for (let i = 0; i < 3000; i++) {
        const tt = i / 60, truthX = 0.1 * Math.sin(2 * tt);
        const x = truthX + 0.0006 * rs.gauss() + (rs() < 0.01 ? 0.03 : 0);
        const g = at(sg.run({ x, y: 0, z: 0.25 }, tt), 'spike').x;
        rawErr = Math.max(rawErr, Math.abs(x - truthX)); gatedErr = Math.max(gatedErr, Math.abs(g - truthX)); nS++;
    }
    ok(rawErr > 0.025 && gatedErr < 0.006, `spike gate: worst error ${(rawErr * 1000).toFixed(1)} mm raw → ${(gatedErr * 1000).toFixed(1)} mm gated`);
    sg.reset();
    let lastG = null;
    for (let i = 0; i < 10; i++) lastG = at(sg.run({ x: i < 5 ? 0 : 0.05, y: 0, z: 0.25 }, i / 60), 'spike').x;
    near(lastG, 0.05, 1e-12, 'a real step is accepted after maxHold frames');
    const lagd = new HandSpace({}, { noise: { x: 0.002, y: 0.002, z: 0.002, rms: 0.0035 }, rate: 57 }).describe().find((x) => x.id === 'oneEuro');
    ok(lagd.lagMs.xy > 0 && /lag/.test(lagd.from), `the 1€ stage states its rest lag (${lagd.lagMs.xy} ms at 2 mm noise, 1.2 mm target)`);

    // The onset point is where the pinch point was rewindS BEFORE the pinch registered: the
    // closing motion drags the index (and the midpoint) along; the rewound point doesn't move.
    const pr = new PinchTracker({ releaseDwellS: 0.06, pointT: 0.2, rewindS: 0.1 });
    const prof = { on: 0.3, off: 0.5, scale: 0.1 };
    let onsetAt = null, onsetPt = null;
    for (let i = 0; i < 60; i++) {
        const tt = i / 60;
        const close = Math.max(0, Math.min(1, (tt - 0.4) / 0.3));          // closing from 0.4 s to 0.7 s
        const drift = 0.02 * close;                                         // …dragging the hand 2 cm in x
        const thumb = { x: drift, y: 0, z: 0.25 }, index = { x: drift + 0.1 * (1 - close) + 0.01, y: 0, z: 0.25 };
        const r = pr.update(Math.abs(index.x - thumb.x), prof, tt, { thumb, index });
        if (r.pinching && !onsetAt) { onsetAt = tt; onsetPt = r.onset.point; }
    }
    const before = 0.2 * (0.1 * (1 - Math.max(0, Math.min(1, (onsetAt - 0.1 - 0.4) / 0.3))) + 0.01) + 0.02 * Math.max(0, Math.min(1, (onsetAt - 0.1 - 0.4) / 0.3));
    ok(onsetAt && Math.abs(onsetPt.x - before) < 0.002, `pinch onset point rewound 100 ms (x ${onsetPt?.x.toFixed(4)} vs ${before.toFixed(4)} then; at onset it had moved to ${(0.02 * Math.min(1, (onsetAt - 0.4) / 0.3) + 0.2 * (0.1 * (1 - Math.min(1, (onsetAt - 0.4) / 0.3)) + 0.01)).toFixed(4)})`);

    const pt = new PinchTracker({ releaseDwellS: 0.06 });
    const pinch = { on: 0.2, off: 0.35, scale: 0.2 };
    ok(pt.update(0.05, null, 0).why && !pt.update(0.05, null, 0).pinching, 'no scale: no pinch, says why');
    const seq = [0.1, 0.05, 0.035, 0.05, 0.065, 0.08, 0.08, 0.08].map((dd, i) => pt.update(dd, pinch, i / 30).pinching);
    ok(JSON.stringify(seq) === JSON.stringify([false, false, true, true, true, true, true, false]), `pinch hysteresis + release dwell ${JSON.stringify(seq)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

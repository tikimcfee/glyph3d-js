// hand-cloud-pipeline.test.mjs — the hand cloud tracker's page side, headless:
//
//   bun tools/hand-cloud-pipeline.test.mjs
//
// CloudPipeline spawns the real module worker (hand/cloud/cloudWorker.js); the worker's
// simulated phone (HandSim + DepthSim) emits handFrames WITH depth crops; each goes through
// JSON (as the relay carries it) and decodeHandFrame, then back into the worker to be
// tracked — the path a phone's frames take. Locked here:
//   - the worker answers: sim frames carry a crop, results carry a status with every stage;
//   - latest wins in the worker: crops posted while it is busy replace each other, counted,
//     none lost or answered twice;
//   - view planes come back transferred and CloudView draws them (points, tips, both
//     skeletons, palm ring, the sensor's view) — a hidden layer draws nothing — as a
//     picture-in-picture: only for its camera on screen, top-left, renderer state restored;
//   - a knob set through the pipeline reaches the worker's tracker (lmIters 0 → no solve).

import CloudPipeline from '../packages/glyph3d-core/src/hand/cloud/CloudPipeline.js';
import CloudView from '../packages/glyph3d-core/src/hand/cloud/CloudView.js';
import { decodeHandFrame } from '../packages/glyph3d-core/src/hand/HandData.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error(`  ✗ ${msg}`); } };

const results = [];
let simFrames = 0, lastHand = null, simOn = true;
const errors = [];
const pipe = new CloudPipeline({
    onResult: (r) => results.push(r),
    onError: (e) => errors.push(e),
    onSimFrame: (payload) => {
        if (!simOn) return; // frames already in flight when the sim is stopped are not part of the test
        simFrames++;
        const wire = JSON.parse(JSON.stringify(payload));
        const dec = decodeHandFrame(wire);
        const h = wire.hands[0];
        if (!h?.cloud) return;
        lastHand = dec.frames[0];
        pipe.submit({ cloud: h.cloud, hand: dec.frames[0], bones: null, ceiling: wire.ceiling, t: wire.timestamp, handedness: 'right', view: true });
    },
});
pipe.sim({ cmd: 'on', mode: 'flat', rate: 60 });
const until = async (cond, ms) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20)); return cond(); };
await until(() => results.length >= 20, 15000);
simOn = false;
pipe.sim({ cmd: 'off' });

ok(!errors.length, `the worker raised no errors (${errors.map((e) => `${e.where}: ${e.message}`).join('; ')})`);
ok(simFrames >= 20, `the worker's simulated phone streams frames (${simFrames})`);
ok(results.length >= 20, `results come back (${results.length})`);
const r = results[results.length - 1];
const st = r?.status;
ok(st && st.segment.hand > 1000 && st.palm.inliers > 100 && st.fit.rmsMm > 0, 'a result carries every stage (segment, palm, fit)');
ok(st && st.tips.length >= 4, `tips come back (${st?.tips.length})`);
ok(r?.hand?.points?.length === 21 && r.hand.source.length === 21, 'the fitted hand comes back as a 21-joint handFrame hand with sources');
ok(r?.view?.xyz instanceof Float32Array && r.view.cls instanceof Uint8Array && r.view.xyz.length === 3 * r.view.crop.rw * r.view.crop.rh, 'view planes come back as typed arrays the size of the crop');
ok(pipe.stats.tracked === results.length && pipe.stats.submitted >= pipe.stats.tracked, 'the pipeline counts what it tracked');
console.log(`  pipeline: ${JSON.stringify(pipe.stats)}  last frame ${JSON.stringify(st?.ms)}`);

// Latest wins, in the worker: a burst posted at once tracks at most the first and always the
// newest; every other crop is reported replaced, none is lost or answered twice.
{
    await until(() => pipe.idle, 5000);
    const before = { ...pipe.stats }, n0 = results.length;
    const job = { ...results[results.length - 1].job };
    for (let i = 0; i < 10; i++) pipe.submit({ ...job, t: job.t + 1 + i, view: false });
    await until(() => pipe.idle, 5000);
    const tracked = results.length - n0, replaced = pipe.stats.replaced - before.replaced;
    ok(tracked >= 1 && tracked <= 2 && tracked + replaced === 10, `a burst of 10: ${tracked} tracked + ${replaced} replaced = 10, tracked ≤ 2`);
    ok(results[results.length - 1].job.t === job.t + 10, 'and the newest is tracked');
}

// The view draws the planes, as a picture-in-picture that leaves the renderer as it found it.
{
    const view = new CloudView();
    view.setVisible(true);
    view.setFrame(r.view, lastHand);
    view.setLayer('vision', true);
    view.setLayer('raw', true);
    view._rebuild();
    view._drawHand();
    ok(view.drawn === 'raw', 'with no display hand, the raw fit stands in as the hand');
    ok(view.rawJoints.count === 21, 'the raw layer draws the raw fit');
    // The model's stabilized hand, when there is one, is THE hand (estimated joints grey).
    const disp = r.hand.points.map((p) => ({ x: p[0] + 0.001, y: p[1], z: p[2] }));
    view.displayProvider = () => ({ points: disp, estimated: disp.map((_, j) => j === 4) });
    view._drawHand();
    const m = new (await import('three')).Matrix4();
    view.fitJoints.getMatrixAt(0, m);
    ok(view.drawn === 'display' && view.fitJoints.count === 21 && Math.abs(m.elements[12] - disp[0].x) < 1e-6, 'the display provider\'s stabilized hand is drawn as THE hand');
    ok(view.pointGeom.drawRange.count > 1000, `the view draws the cloud (${view.pointGeom.drawRange.count} points)`);
    ok(view.tipGeom.drawRange.count >= 4, 'the view draws the tip candidates');
    ok(view.fitBones.geometry.drawRange.count > 30 && view.fitJoints.count === 21, 'the view draws the fitted skeleton');
    ok(view.visionJoints.count > 10, "the view draws Vision's joints");
    ok(view.normal.geometry.drawRange.count > 100, 'the view draws the palm normal + ring');
    ok(view.sensor.geometry.drawRange.count === 16, "the view draws the sensor's frustum edges + image border");
    ok(Array.isArray(r.view.fit.outOfView) && r.view.fit.outOfView.length === 21, 'out-of-view joints come with the planes');
    for (const l of ['hand', 'arm', 'fly', 'other', 'palm', 'hole', 'tips', 'fit', 'raw', 'vision', 'normal', 'sensor']) view.setLayer(l, false);
    view._rebuild();
    view._drawHand();
    ok(view.pointGeom.drawRange.count === 0 && view.tipGeom.drawRange.count === 0 && view.fitJoints.count === 0
        && view.normal.geometry.drawRange.count === 0 && view.sensor.geometry.drawRange.count === 0 && view.rawJoints.count === 0, 'every layer off draws nothing');
    let threw = false;
    try { view.setLayer('nope', true); } catch { threw = true; }
    ok(threw, 'an unknown layer throws');

    // A stub renderer: the overlay draws only for the hooked camera on screen, and restores state.
    const THREE = await import('three');
    const calls = [];
    let vp = new THREE.Vector4(0, 0, 1600, 900), sc = new THREE.Vector4(0, 0, 1600, 900), st = false, target = null;
    const cc = new THREE.Color(0x123456);
    const gl = {
        autoClear: true,
        getSize: (v) => v.set(1600, 900), getViewport: (v) => v.copy(vp), getScissor: (v) => v.copy(sc), getScissorTest: () => st,
        getClearColor: (c) => c.copy(cc), getClearAlpha: () => 1, getRenderTarget: () => target,
        setViewport: (...a) => { vp = a[0]?.isVector4 ? a[0].clone() : new THREE.Vector4(...a); }, setScissor: (...a) => { sc = a[0]?.isVector4 ? a[0].clone() : new THREE.Vector4(...a); },
        setScissorTest: (v) => { st = v; }, setClearColor: (c) => { cc.set(c); }, clear: () => calls.push('clear'),
        render: (sceneArg, cam) => calls.push(['render', sceneArg === view2.scene, cam === view2.camera, vp.x, vp.y, vp.z, vp.w]),
    };
    const main = new THREE.Scene(), mainCam = new THREE.PerspectiveCamera(), other = new THREE.PerspectiveCamera();
    const view2 = new CloudView(); // eslint-disable-line prefer-const
    view2.hook(main, mainCam);
    view2.setVisible(true);
    view2.setFrame(r.view, lastHand);
    main.onAfterRender(gl, main, other);
    target = {}; main.onAfterRender(gl, main, mainCam); target = null;
    ok(calls.length === 0, 'no overlay for another camera, nor into a render target (a pick pass)');
    main.onAfterRender(gl, main, mainCam);
    const rc = calls.find((c) => Array.isArray(c));
    ok(rc && rc[1] && rc[2], 'the overlay renders its own scene through its own camera');
    ok(rc && rc[3] === 12 && rc[6] === Math.round(900 * 0.36) && rc[4] === 900 - rc[6] - 12, `into the top-left corner (${rc?.slice(3)})`);
    ok(calls.includes('clear') && gl.autoClear === true && st === false && vp.z === 1600 && sc.z === 1600 && cc.getHex() === 0x123456,
        'and leaves viewport, scissor, clear colour and autoClear as it found them');
    view2.dispose();
    ok(typeof main.onAfterRender === 'function' && (calls.length, main.onAfterRender(gl, main, mainCam), calls.filter((c) => Array.isArray(c)).length === 1), 'dispose unhooks it');
    view.dispose();
}

// A knob reaches the worker: no solver iterations → the fit stays at its init, rms unmeasured.
{
    pipe.setOpts({ lmIters: 0 });
    pipe.reset();
    const n0 = results.length;
    pipe.submit({ ...results[results.length - 1].job, view: false });
    await until(() => results.length > n0, 5000);
    const s = results[results.length - 1].status;
    ok(s.fit.used === 0 || s.fit.rmsMm == null, `lmIters 0 reaches the worker (used ${s.fit.used})`);
}

pipe.dispose();
console.log(`hand-cloud-pipeline: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

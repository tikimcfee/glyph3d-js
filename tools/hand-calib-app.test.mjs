// hand-calib-app.test.mjs — the app's live hand model controller (app/client/HandCalib.js),
// headless, on the real seams:
//
//   bun tools/hand-calib-app.test.mjs
//
// HandSim's v2 frames go in through SourceStream.injectFrame (the path a phone's frames take
// after the relay); HandPresence parks its rig; HandCalib feeds the core HandModel with nothing
// started and nothing announced. Locked:
//   - always on: the model learns from frames alone and its quantities settle;
//   - before the model knows, the HandSpace stages that need it pass through and say why; after,
//     the dead zone is k × the measured rest noise and normalize maps into the unit cube;
//   - the live pinch reads the model's thresholds; the palm pose is measured from the neutral;
//   - the warm start saves itself to the client store, a fresh controller (a reload) starts
//     from it, `forget` drops it; a second device gets its own model (its own clock);
//   - a Settings knob reaches every hand's stages; the in-scene view rides the hand rig.
// localStorage / window are stubbed (StateController's store).

const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    get length() { return store.size; },
    key: (i) => [...store.keys()][i],
};
globalThis.window ??= { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };
globalThis.CustomEvent ??= class { constructor(type) { this.type = type; } };

const THREE = await import('three');
const { default: SourceStream } = await import('../packages/glyph3d-core/src/services/orchestration/SourceStream.js');
const { default: HandPresence } = await import('../packages/glyph3d-core/src/hand/HandPresence.js');
const { HandSim } = await import('../packages/glyph3d-core/src/hand/index.js');
const { default: HandCalib, SNAPSHOT_KEY } = await import('../app/client/HandCalib.js');
const { dist } = await import('../packages/glyph3d-core/src/hand/handMath.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error(`  ✗ ${msg}`); } };
const quiet = console.log;
console.log = (...a) => { if (!/^\[(source|hand)\]/.test(String(a[0]))) quiet(...a); };

const stream = new SourceStream({ bridge: { onSourceEvent: () => () => {} } });
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 100);
const presence = new HandPresence({ stream, camera, scene });
let panelOpened = 0;
const calib = new HandCalib({ stream, presence, openPanel: () => panelOpened++ });
const sim = new HandSim({ seed: 3 });
const ID = 'src-sim-hand';
stream.attachLocal(ID, 'hand');
let t = 2e5;
const tick = (s = sim, id = ID) => { stream.injectFrame(id, s.frame(t)); presence.update(camera); calib.update(camera); t += 1 / 60; };

console.log('before the model knows');
for (let i = 0; i < 20; i++) tick();
let st = calib.status();
ok(st.source.current === ID && st.model.hands.right, 'learning from the first frames, nothing started');
const space0 = Object.fromEntries(st.live.right.space.map((d) => [d.id, d]));
ok(!space0.deadZone.active && !space0.normalize.active, 'model stages pass through until the model knows');
ok(/manual/.test(space0.oneEuro.from), '1€ on manual cutoffs until the rest noise is measured');
ok(!store.has(`g3d.${SNAPSHOT_KEY}`), 'nothing saved yet');
ok(panelOpened === 1, `the first hand device brought the Hand panel forward, once (${panelOpened})`);

console.log('after two minutes of wandering');
for (let i = 0; i < 60 * 120; i++) tick();
st = calib.status();
const m = st.model.hands.right;
ok(['scale', 'volume', 'noise', 'pinch', 'template'].every((k) => m[k].state === 'settled'), `quantities settled ${JSON.stringify(Object.fromEntries(['scale', 'volume', 'noise', 'pinch', 'template'].map((k) => [k, m[k].state])))}`);
const space = Object.fromEntries(st.live.right.space.map((d) => [d.id, d]));
const rawRms = calib.model.hands.get('right').summary().noise.rms;
ok(space.deadZone.active && space.deadZone.radius > 0 && space.deadZone.radius < 3 * rawRms && /post-filter/.test(space.deadZone.from),
    `dead zone = 3 × the jitter left after the filter (${space.deadZone.radius.toFixed(5)} m < 3 × raw ${rawRms.toFixed(5)})`);
ok(space.normalize.active, 'normalize on the measured volume');
ok(/auto/.test(space.oneEuro.from), `1€ rest cutoffs solved from the noise (${space.oneEuro.minCutoff} / ${space.oneEuro.zMinCutoff} Hz)`);
const u = st.live.right.stages.find((s) => s.id === 'normalize').value;
ok([u.x, u.y, u.z].every((c) => Math.abs(c) < 1.6), `palm inside the unit cube (${JSON.stringify(u)})`);
ok(typeof st.live.right.pinch?.normalized === 'number' && !st.live.right.pinch.why, 'pinch reads the model thresholds');
ok(st.live.right.pose?.fromNeutral, 'palm pose measured from the learned neutral');

console.log('the scene hand');
{
    // The drawn hand is the MODEL's metric hand through the one phone → view mapping: his right
    // (phone +x) → view +x, his fingers (phone +y, away from him) → into the view (−z).
    const views = presence.viewProvider(ID);
    const v = views?.find((x) => x.handedness === 'right');
    ok(v && v.shape[0].x === 0 && v.shape[0].y === 0 && v.shape[0].z === 0, 'shape is wrist-relative');
    ok(v.shape[12].z < -0.1, `fingers point into the view (middle tip z ${v.shape[12]?.z?.toFixed(3)} m)`);
    ok(v.shape[17].x > v.shape[5].x, 'a right hand: pinky knuckle to the right of the index knuckle');
    ok(Math.abs(v.anchor.x) <= 0.5 && Math.abs(v.anchor.y) <= 0.5, 'anchored within the view by the measured volume');
    const r = presence.renderers.get(ID), hg = r.hands.get('right').group;
    ok(hg.visible && Math.abs(hg.rotation.x - (r.tilt * Math.PI) / 180) < 1e-9 && hg.rotation.y === 0, 'drawn tipped back by tilt, no yaw');
    ok(presence.viewProvider('src-nobody') === null, "another device draws its own landmarks");
    // ONE displayed hand: the stabilized joints, which the scene hand and displayHand both carry.
    const dh = calib.displayHand(ID, 'right');
    const lv = calib.live.hands.right;
    ok(dh && dh.points === lv.display && dh.points !== lv.points, 'displayHand = the stabilized hand (not the raw merged joints)');
    const all = calib.displayHands(ID);
    ok(all && all.right?.points === lv.display && calib.displayHands('src-nobody') === null, 'displayHands: every voted hand of the followed device');
    const w = dh.points[0];
    ok(Math.abs(v.shape[12].x - calib.chains.get('right').space.toView({ x: dh.points[12].x - w.x, y: dh.points[12].y - w.y, z: dh.points[12].z - w.z }).x) < 1e-12, 'the scene hand draws the displayed (stabilized) joints');
    ok(calib.status().live.right.stability && 'worstJitterP95Mm' in calib.status().live.right.stability, 'stability metrics reported live');
}

console.log('cloud fit hook');
{
    // A fake cloud tracker: the true joint CENTRES, from 2 frames ago, a few labelled 'prior'.
    let lastTruth = null, prevTruth = null, asked = null;
    const fitOf = (tr) => ({
        points: tr.points.map((p) => [p.x, p.y, p.z]), confidence: new Array(21).fill(0.9),
        source: tr.points.map((_, j) => (j === 20 ? 'prior' : j % 3 ? 'cloud' : 'vision')), t: 0, age: 2 / 60,
    });
    const bonesBefore = calib.model.skeleton('right').bones['5-6'].length;
    calib.fitProvider = (s, h, tt, hand) => { asked = { s, h, hand }; return prevTruth ? fitOf(prevTruth) : null; };
    for (let i = 0; i < 30; i++) { prevTruth = lastTruth; tick(); lastTruth = sim.lastTruth && { points: sim.lastTruth.points.map((p) => ({ ...p })) }; }
    const st2 = calib.status();
    const lr = st2.live.right;
    ok(asked?.s === ID && asked.h === 'right' && asked.hand?.points, 'asked with the source, the VOTED hand and that frame\'s hand');
    ok(lr.fit && lr.fit.cloud + lr.fit.vision + lr.fit.prior === 21 && lr.fit.ageMs === 33, `fit reported (${JSON.stringify(lr.fit)})`);
    ok(lr.estimated === 1, `estimated = the fit's 'prior' joints (${lr.estimated})`);
    // The drawn joints are the fit's (centres), caught up to the palm now: middle tip near truth.
    const v = presence.viewProvider(ID).find((x) => x.handedness === 'right');
    ok(v && v.shape[12], 'the scene hand draws the fitted joints');
    const live = calib.live.hands.right, tr = sim.lastTruth;
    ok(dist(live.points[12], tr.points[12]) < 0.02, `fitted + caught-up middle tip within 2 cm of truth (${(dist(live.points[12], tr.points[12]) * 1000).toFixed(1)} mm)`);
    ok(Math.abs(calib.model.skeleton('right').bones['5-6'].length - bonesBefore) < 0.002, 'learners never saw the fit (bones unchanged by it)');
    calib.fitProvider = null;
    tick();
    ok(calib.status().live.right.fit === null, 'no provider: Vision + ray repair as before');
}

console.log('warm start');
const saved = JSON.parse(store.get(`g3d.${SNAPSHOT_KEY}`) ?? 'null');
ok(saved?.hands?.right?.bones && saved.savedAt, 'the warm start saved itself');
store.set('g3d.hand.panelSeen', 'true'); // the panel has been shown in this browser
let reopened = 0;
const again = new HandCalib({ stream, presence, openPanel: () => reopened++ });
ok(again.model.warm?.hands?.right, 'a fresh controller (a reload) starts from it');
stream.injectFrame(ID, sim.frame(t)); t += 1 / 60;
ok(reopened === 0, 'a panel already shown is not pulled forward again');
again.dispose();
presence.viewProvider = (id) => calib.viewFor(id); // `again` took the provider; hand it back

console.log('knobs + second device');
const r3 = calib.status().live.right.space.find((d) => d.id === 'deadZone').radius;
calib.setSpace('deadZone.noiseK', 5);
const r5 = calib.status().live.right.space.find((d) => d.id === 'deadZone').radius;
ok(Math.abs(r5 / r3 - 5 / 3) < 1e-9, `a Space knob reaches the live chain (radius ×${(r5 / r3).toFixed(3)})`);
let threw = false; try { calib.setSpace('nope.x', 1); } catch { threw = true; }
ok(threw, 'an unknown Space knob throws');
const first = calib.model;
stream.injectFrame(ID, sim.frame(t)); // keep the first one fresh…
calib.pin('src-other');
const sim2 = new HandSim({ seed: 9 });
stream.attachLocal('src-other', 'hand');
for (let i = 0; i < 30; i++) tick(sim2, 'src-other');
ok(calib.model !== first && calib.status().source.current === 'src-other', 'a second device gets its own model (its clock, its place)');

console.log('forget + view');
calib.forget();
ok(!store.has(`g3d.${SNAPSHOT_KEY}`) && !calib.model.warm, 'forget drops the warm start');
calib.view.setVisible(true);
// A new track decides left/right over its first ~10 frames before it feeds a hand.
for (let i = 0; i < 30; i++) tick(sim2, 'src-other');
ok(calib.view.group.parent === presence.rig && calib.view.joints.count >= 15, `the view rides the rig and draws the hand (${calib.view.joints.count} joints)`);
calib.dispose();
ok(!presence.rig.children.includes(calib.view.group), 'dispose takes the view off the rig');

console.log = quiet;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

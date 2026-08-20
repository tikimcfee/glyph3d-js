// hand-source-check.mjs — the sensor plane end-to-end, from the relay wire to
// rendered geometry:
//
//   ./glyph3d-cli serve --local --port 8099 .        (a scratch relay, any project)
//   bun tools/hand-source-check.mjs [--relay 8099]
//
// The unit tests (source-stream.test.mjs, hand-presence.test.mjs) stub the bridge.
// This one does not: a REAL relay binary, a REAL `SOURCE hand` handshake, and real
// ARKit-shaped frames on the wire, feeding the real SourceStream → HandPresence →
// HandRenderer chain. No browser — the render path here is CPU-side Three.js, so
// the whole chain runs in bun and stays fast enough to be run on a whim.
//
// What it is FOR: the faults that only exist between the parts, each of which has
// actually happened —
//   - a device classed as a controller because its greeting was wrong
//   - frames arriving but decoding to nothing (coordinate/shape drift)
//   - geometry that updates forever and never draws (parented to a camera that is
//     not in the scene graph — render(scene, camera) walks only the scene)
//   - a hand placed inside the near plane, clipped away while every probe reads fine
//   - a hand that draws at 2px and reads as "not rendering"

import * as THREE from 'three';
import SourceStream from '../packages/glyph3d-core/src/services/orchestration/SourceStream.js';
import HandPresence from '../packages/glyph3d-core/src/hand/HandPresence.js';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(flag('--relay', process.env.HAND_RELAY || 8099));
const URL_ = `ws://localhost:${PORT}`;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.error(`  FAIL ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const open = (ws) => new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`cannot reach relay at ${URL_} — start one: ./glyph3d-cli serve --local --port ${PORT} .`)); });


/** Ask a relay-resident verb (source.list) over a throwaway controller socket. */
function relayVerb(cmd) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL_);
    const timer = setTimeout(() => { ws.close(); reject(new Error(`${cmd} timed out`)); }, 4000);
    ws.onopen = () => ws.send(cmd);
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }   // skip the plain-text connect ack
      if (m && 'data' in m) { clearTimeout(timer); ws.close(); resolve(m.data); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('relay socket error')); };
  });
}

// ── the display side, wired exactly as CommandProvider wires it ──────────────
const listeners = new Set();
const bridgeSeam = { onSourceEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
const stream = new SourceStream({ bridge: bridgeSeam });
const camera = new THREE.PerspectiveCamera(50, 16 / 9, 4, 1000);   // near=4: the app's dial, NOT three's 0.1
const scene = new THREE.Scene();
const presence = new HandPresence({ stream, camera, scene });

const display = new WebSocket(URL_);
display.onmessage = (e) => {
  let env; try { env = JSON.parse(e.data); } catch { return; }
  if (env.ok !== undefined) {
    for (const s of env.sources || []) listeners.forEach((f) => f({ event: 'source_connected', sourceId: s.id, kind: s.kind }));
    return;
  }
  if (String(env.event || '').startsWith('source')) listeners.forEach((f) => f(env));
};
await open(display);
display.send('DISPLAY');
await wait(300);

/** A 21-joint hand in the device's own space: x/y normalized 0..1, z metres. */
const handFrame = (z, spread = 0.01) => JSON.stringify({
  type: 'handFrame', timestamp: Date.now() / 1000,
  hands: [{
    handedness: 'right',
    landmarks: Array.from({ length: 21 }, (_, i) => [0.4 + i * spread, 0.6 - i * (spread / 2), z]),
  }],
  scene: {
    intrinsics: { fx: 1500, fy: 1500, cx: 960, cy: 720 }, imageResolution: [1920, 1440],
    trackingState: 'normal',
    viewport: { depthRange: [0.2, 0.9], physicalWidth: 1.28, physicalHeight: 0.96 },
  },
});

console.log('handshake');
const src = new WebSocket(URL_);
let hello = null;
src.onmessage = (e) => { if (!hello) { try { hello = JSON.parse(e.data); } catch { /* ignore */ } } };
await open(src);
src.send('SOURCE hand');            // MUST be first on the wire, or the relay classes it a controller
await wait(400);
ok(hello?.role === 'source', `relay registered the device as a source (got ${hello?.role})`);
ok(/^src-hand-\d+$/.test(hello?.sourceId || ''), `assigned an id (${hello?.sourceId})`);
ok(presence.ids().length === 1, 'a renderer exists for the attached device');

console.log('placement');
ok(presence.rig.parent === scene, 'the hand rig lives in the SCENE');
ok(camera.children.length === 0, 'nothing is parented to the camera itself (that never draws)');

console.log('frames');
src.send(handFrame(0.45));
await wait(400);
const hands = stream.latestHands();
ok(hands.length === 1, 'a decoded pose reached the stream');
ok(Math.abs((hands[0]?.landmarks?.[0]?.z ?? -1) - 0.45) < 1e-6, 'landmark z survived the wire intact');
ok(stream.latestScene()?.trackingState === 'normal', 'the ARKit scene block survived the round trip');

presence.update(camera);
scene.updateMatrixWorld(true);
const renderer = presence.renderers.get(presence.ids()[0]);
const hand = renderer?.hands?.get('right');
ok(!!hand && hand.group.visible, 'the renderer built a visible right hand');
ok(hand.joints.some((j) => j.position.lengthSq() > 0), 'joint meshes moved to the streamed pose');

let reachable = false;
scene.traverse((o) => { if (o === hand.group) reachable = true; });
ok(reachable, 'the geometry is reachable from the scene root (the only thing that means "drawn")');

// ── geometry: in front of the viewer, and big enough to see ──────────────────
const measure = (cam) => {
  presence.update(cam);
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(renderer.group);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const dist = cam.getWorldPosition(new THREE.Vector3()).distanceTo(centre);
  const visibleH = 2 * Math.tan((cam.fov * Math.PI) / 360) * Math.max(dist, 1e-6);
  return { dist, px: (size.y / visibleH) * 1000, size };
};

console.log('visibility');
const m = measure(camera);
ok(m.dist > camera.near, `clears the near plane (${m.dist.toFixed(2)} > ${camera.near})`);
ok(m.px >= 8, `large enough to see (~${Math.round(m.px)}px tall on a 1000px canvas)`);

// The near plane is a live setting. Placement is in near-plane units precisely so
// apparent size does not move when that dial does — assert it, don't assume it.
camera.near = 0.5; camera.updateProjectionMatrix();
const near05 = measure(camera);
camera.near = 12; camera.updateProjectionMatrix();
const near12 = measure(camera);
const drift = Math.abs(near12.px - near05.px) / Math.max(near05.px, 1);
ok(near05.dist > 0.5 && near12.dist > 12, 'clears the near plane at BOTH extremes of the dial');
ok(drift < 0.02, `apparent size is invariant to camera.near (${near05.px.toFixed(0)}px vs ${near12.px.toFixed(0)}px)`);
camera.near = 4; camera.updateProjectionMatrix();

console.log('sustained stream');
for (let i = 0; i < 90; i++) { src.send(handFrame(0.3 + (i % 10) * 0.02)); await wait(4); }
await wait(400);
presence.update(camera);
const st = stream.list().find((s) => s.id === hello.sourceId);
ok(st.fps > 0, `a rate is reported (${st.fps.toFixed(1)}fps)`);
ok(!stream.isStalled(st.id), 'a streaming device does not read as stalled');

// Drop accounting lives on the RELAY (the browser only sees what arrived), so the
// two halves have to be compared across the wire: everything the relay accepted
// was either delivered to this display or deliberately dropped by the perishable-
// frame policy. If those don't reconcile, frames are vanishing somewhere silent.
const relayRow = await relayVerb('source.list').then(
  (d) => (Array.isArray(d) ? d.find((r) => r.id === hello.sourceId) : null),
).catch(() => null);
if (relayRow) {
  ok(relayRow.frames + relayRow.dropped >= 90,
     `relay accounted for every frame sent (delivered ${relayRow.frames}, dropped ${relayRow.dropped})`);
  ok(st.frames <= relayRow.frames,
     `the display received no more than the relay delivered (${st.frames} <= ${relayRow.frames})`);
} else {
  ok(false, 'source.list answered with a row for this device');
}

console.log('multi-device');
const src2 = new WebSocket(URL_);
await open(src2);
src2.send('SOURCE hand');
await wait(400);
ok(presence.ids().length === 2, 'two devices get two independent renderers');
src2.send(handFrame(0.9, 0.004));
await wait(300);
const [idA, idB] = presence.ids();
ok(stream.latestHands(idA)[0]?.landmarks[0].z !== stream.latestHands(idB)[0]?.landmarks[0].z,
   'each device drives only its own pose (provenance holds)');

console.log('teardown');
src2.close();
await wait(500);
ok(presence.ids().length === 1, 'the departed device is torn down');
ok(presence.rig.children.length >= 1, 'the surviving device keeps its renderer');
src.close();
await wait(500);
ok(presence.ids().length === 0, 'the last device leaves nothing behind');
ok(presence.rig.children.length === 0, 'the rig has no orphaned children');

console.log(`\nhand-source-check: ${pass} passed, ${fail} failed`);
display.close();
process.exit(fail === 0 ? 0 : 1);

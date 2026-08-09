// hand-presence.test.mjs — behavior lock for SourceStream → HandRenderer:
//
//   bun tools/hand-presence.test.mjs
//
// HandPresence owns one HandRenderer per attached hand device and samples each
// device's latest pose once per rendered frame (pull, not push). The properties
// that matter are lifecycle (a renderer exists exactly while its device does),
// isolation (two phones don't drive each other's skeleton), and that hidden hands
// cost nothing per frame.
//
// Runs against the REAL HandRenderer — its geometry is all CPU-side Three.js, so
// it constructs headless without a WebGL context. Sampling is observed by wrapping
// updateFromFrame on the live instance rather than by injecting a fake class, so
// the test exercises the same object the app builds.

import * as THREE from 'three';
import HandPresence from '../packages/glyph3d-core/src/hand/HandPresence.js';
import SourceStream from '../packages/glyph3d-core/src/services/orchestration/SourceStream.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); } };
const J = (v) => JSON.stringify(v);
const eq = (a, b, msg) => ok(J(a) === J(b), `${msg}\n      got   ${J(a)}\n      want  ${J(b)}`);

function stubBridge() {
    const listeners = new Set();
    return {
        onSourceEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        emit(e) { for (const fn of listeners) fn(e); },
    };
}

/** A full 21-joint hand at a given depth — HandRenderer ignores short frames. */
function handFrame(z) {
    return {
        type: 'handFrame', timestamp: 1,
        hands: [{
            handedness: 'right',
            landmarks: Array.from({ length: 21 }, (_, i) => [0.5 + i * 0.001, 0.5, z]),
        }],
    };
}

/** Record every pose a live renderer is handed. */
function spyOn(renderer) {
    const seen = [];
    const original = renderer.updateFromFrame.bind(renderer);
    renderer.updateFromFrame = (frame) => { seen.push(frame); return original(frame); };
    return seen;
}

/** Fresh rig: stream + presence on a real camera. */
function rig() {
    const bridge = stubBridge();
    const stream = new SourceStream({ bridge });
    const camera = new THREE.PerspectiveCamera();
    const scene = new THREE.Scene();
    const presence = new HandPresence({ stream, camera, scene });
    return { bridge, stream, camera, scene, presence };
}

const attach = (bridge, id, kind = 'hand') =>
    bridge.emit({ event: 'source_connected', sourceId: id, kind });
const sendFrame = (bridge, id, z) =>
    bridge.emit({ event: 'source.frame', source: id, kind: 'hand', data: handFrame(z) });

console.log('lifecycle');
{
    const { bridge, camera, scene, presence } = rig();

    attach(bridge, 'src-hand-0');
    eq(presence.ids(), ['src-hand-0'], 'attaching a hand device creates a renderer');
    // THE invisible-hand bug: geometry parented to a camera that is not itself in
    // the scene graph updates every frame and is never drawn, because
    // render(scene, camera) traverses only the scene. Hands must hang off a
    // scene-resident rig instead.
    ok(presence.rig.parent === scene, 'the hand rig lives in the scene');
    eq(camera.children.length, 0, 'nothing is parented to the camera itself');
    eq(presence.renderers.get('src-hand-0').group.parent, presence.rig, 'the hand hangs off the rig');
    // Reachable from the scene root — the only property that actually means "drawn".
    let reachable = false;
    scene.traverse((o) => { if (o === presence.renderers.get('src-hand-0').group) reachable = true; });
    ok(reachable, 'the hand geometry is reachable from the scene root');

    // A camera-preview device shares the sensor plane but has no skeleton to draw.
    attach(bridge, 'src-camera-0', 'camera');
    eq(presence.ids(), ['src-hand-0'], 'a camera device gets no hand renderer');

    const renderer = presence.renderers.get('src-hand-0');
    bridge.emit({ event: 'source_disconnected', sourceId: 'src-hand-0' });
    eq(presence.ids(), [], 'detaching removes the renderer');
    ok(renderer.group.parent === null, 'the hand group is detached, not leaked');
    eq(presence.rig.children.length, 0, 'the rig has no orphaned children');
}

console.log('late construction');
{
    const bridge = stubBridge();
    const stream = new SourceStream({ bridge });
    // Device connects BEFORE presence exists — the ordinary case on a page reload,
    // since the relay replays already-attached sources into the display ack.
    attach(bridge, 'src-hand-0');

    const presence = new HandPresence({
        stream, camera: new THREE.PerspectiveCamera(), scene: new THREE.Scene(),
    });
    eq(presence.ids(), ['src-hand-0'], 'a device attached before presence is picked up');
}

console.log('sampling');
{
    const { bridge, presence } = rig();
    attach(bridge, 'src-hand-0');
    const seen = spyOn(presence.renderers.get('src-hand-0'));

    sendFrame(bridge, 'src-hand-0', 0.4);
    presence.update();
    eq(seen.length, 1, 'one rendered frame samples once');
    eq(seen[0].landmarks[0].z, 0.4, 'the decoded pose reaches the renderer');

    // Pull semantics: several network frames between renders collapse to one
    // sample, and that sample is the NEWEST pose — not a replay of the backlog.
    sendFrame(bridge, 'src-hand-0', 0.5);
    sendFrame(bridge, 'src-hand-0', 0.6);
    sendFrame(bridge, 'src-hand-0', 0.7);
    presence.update();
    eq(seen.length, 2, 'three network frames collapse into one sample');
    eq(seen[1].landmarks[0].z, 0.7, 'the sample is the newest pose');

    // A quiet device holds its last pose rather than blinking out — tracking
    // legitimately drops for a frame or two and flickering reads as broken.
    presence.update();
    eq(seen.length, 3, 'a quiet device re-renders its last pose');
}

console.log('multi-device isolation');
{
    const { bridge, presence } = rig();
    attach(bridge, 'src-hand-0');
    attach(bridge, 'src-hand-1');
    eq(presence.ids().length, 2, 'two phones get two renderers');

    const seen0 = spyOn(presence.renderers.get('src-hand-0'));
    const seen1 = spyOn(presence.renderers.get('src-hand-1'));

    sendFrame(bridge, 'src-hand-0', 0.1);
    sendFrame(bridge, 'src-hand-1', 0.9);
    presence.update();

    eq(seen0.at(-1).landmarks[0].z, 0.1, 'device 0 drives only its own renderer');
    eq(seen1.at(-1).landmarks[0].z, 0.9, 'device 1 drives only its own renderer');

    // One device leaving must not disturb the other.
    bridge.emit({ event: 'source_disconnected', sourceId: 'src-hand-0' });
    eq(presence.ids(), ['src-hand-1'], 'the surviving device keeps rendering');
    presence.update();
    eq(seen1.at(-1).landmarks[0].z, 0.9, 'the survivor still samples after its peer left');
}

console.log('visibility + placement');
{
    const { bridge, presence } = rig();
    attach(bridge, 'src-hand-0');
    const renderer = presence.renderers.get('src-hand-0');
    const seen = spyOn(renderer);
    sendFrame(bridge, 'src-hand-0', 0.4);

    presence.setVisible(false);
    ok(!renderer.group.visible, 'hide reaches the renderer group');
    const before = seen.length;
    presence.update();
    eq(seen.length, before, 'hidden hands skip per-frame work entirely');

    presence.setVisible(true);
    presence.update();
    ok(seen.length > before, 'showing resumes sampling');

    presence.setPlacement('depth', -1.5);
    eq(renderer.depth, -1.5, 'placement reaches existing renderers');

    // A device that arrives later must inherit tuning already done, or a second
    // phone shows up at the old placement.
    attach(bridge, 'src-hand-1');
    eq(presence.renderers.get('src-hand-1').depth, -1.5, 'a later device inherits current placement');
}

console.log('yaw');
{
    const { bridge, presence } = rig();
    attach(bridge, 'src-hand-0');
    const renderer = presence.renderers.get('src-hand-0');
    sendFrame(bridge, 'src-hand-0', 0.45);
    presence.update();

    // Default turns the palms away from the viewer: the device sees your palm, so
    // unrotated hands face you like someone else's.
    eq(renderer.yaw, 180, 'hands default to a half turn');

    // The property that must never break: yaw is a ROTATION, not a mirror. A
    // negative determinant would silently turn left hands into right ones.
    const det = (y) => {
        renderer.yaw = y;
        renderer.group.updateMatrixWorld(true);
        return new THREE.Matrix4().extractRotation(renderer.group.matrixWorld).determinant();
    };
    ok(Math.abs(det(0) - 1) < 1e-6, 'yaw 0 preserves chirality');
    ok(Math.abs(det(180) - 1) < 1e-6, 'yaw 180 preserves chirality — a rotation, never a mirror');

    // And it actually turns the hand over: the palm normal flips sign.
    const normal = (y) => {
        renderer.yaw = y;
        presence.update();
        renderer.group.updateMatrixWorld(true);
        const j = renderer.hands.get('right').joints;
        const w = j[0].getWorldPosition(new THREE.Vector3());
        const a = j[4].getWorldPosition(new THREE.Vector3()).sub(w);
        const b = j[20].getWorldPosition(new THREE.Vector3()).sub(w);
        return a.cross(b).normalize().z;
    };
    const n0 = normal(0), n180 = normal(180);
    ok(Math.sign(n0) === -Math.sign(n180), 'a half turn reverses which way the palm faces');

    presence.setPlacement('yaw', 90);
    eq(renderer.yaw, 90, 'yaw is tunable through setPlacement');
    attach(bridge, 'src-hand-9');
    eq(presence.renderers.get('src-hand-9').yaw, 90, 'a later device inherits the tuned yaw');
}

console.log('dispose');
{
    const { bridge, scene, presence } = rig();
    attach(bridge, 'src-hand-0');

    presence.dispose();
    eq(presence.ids(), [], 'dispose drops all renderers');
    ok(!presence.rig.parent, 'dispose removes the rig from the scene');
    eq(scene.children.length, 0, 'the scene is left clean');

    attach(bridge, 'src-hand-2');
    eq(presence.ids(), [], 'dispose unsubscribes from presence');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

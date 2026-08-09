// source-stream.test.mjs — behavior lock for the sensor plane's browser half:
//
//   bun tools/source-stream.test.mjs
//
// Devices connect to the relay with `SOURCE <kind>`; the relay stamps provenance
// and forwards {event:'source.frame', source, kind, data} on the display socket.
// SourceStream turns that into presence + decoded pose + liveness.
//
// Two seams are locked here:
//   - decodeHandFrame / decodeCameraFrame — pure payload → canonical model, the
//     protocol knowledge salvaged when the old WebSocketHandSource transport was
//     retired (frames now ride the display's existing socket, not a second one).
//   - SourceStream — presence, multi-device isolation, scene carry, liveness.
//
// Headless: SourceStream only needs an object with onSourceEvent, so a stub
// bridge stands in for a connected one.

import SourceStream from '../packages/glyph3d-core/src/services/orchestration/SourceStream.js';
import { decodeHandFrame, decodeCameraFrame } from '../packages/glyph3d-core/src/hand/HandData.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); } };
const J = (v) => JSON.stringify(v);
const eq = (a, b, msg) => ok(J(a) === J(b), `${msg}\n      got   ${J(a)}\n      want  ${J(b)}`);

/** A stub bridge that lets the test push relay envelopes by hand. */
function stubBridge() {
    const listeners = new Set();
    return {
        onSourceEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        emit(envelope) { for (const fn of listeners) fn(envelope); },
    };
}

/** A handFrame in the shape MotionSource (the iOS app) actually sends. */
function handFrame(z = 0.4, extra = {}) {
    return {
        type: 'handFrame',
        timestamp: 12.5,
        hands: [{ handedness: 'right', landmarks: [[0.5, 0.25, z], [0.6, 0.3, z]] }],
        scene: {
            intrinsics: { fx: 1500, fy: 1500, cx: 960, cy: 720 },
            trackingState: 'normal',
            viewport: { depthRange: [0.2, 0.9], physicalWidth: 1.28 },
        },
        ...extra,
    };
}

// ── decode ───────────────────────────────────────────────────────────────────
console.log('decodeHandFrame');
{
    const out = decodeHandFrame(handFrame());
    ok(out !== null, 'decodes a handFrame');
    eq(out.frames.length, 1, 'one hand');
    eq(out.frames[0].handedness, 'right', 'handedness preserved');
    // Tuple → {x,y,z}: this is the actual wire shape, and getting it wrong is a
    // silent failure that renders hands at the origin.
    eq(out.frames[0].landmarks[0], { x: 0.5, y: 0.25, z: 0.4 }, 'tuple landmarks become {x,y,z}');
    eq(out.frames[0].scene.viewport.depthRange, [0.2, 0.9], 'ARKit scene rides along on the frame');

    // Object-shaped landmarks (a non-ARKit source) decode identically.
    const objForm = decodeHandFrame({
        type: 'handFrame', timestamp: 1,
        hands: [{ handedness: 'left', landmarks: [{ x: 1, y: 2, z: 3 }] }],
    });
    eq(objForm.frames[0].landmarks[0], { x: 1, y: 2, z: 3 }, 'object landmarks decode too');

    // A missing z must become 0, not undefined — undefined poisons the transform.
    const noZ = decodeHandFrame({ type: 'handFrame', hands: [{ landmarks: [[0.1, 0.2]] }] });
    eq(noZ.frames[0].landmarks[0].z, 0, 'missing z defaults to 0, not undefined');

    // Scene carry: a device may send scene once and omit it afterwards.
    const later = decodeHandFrame(
        { type: 'handFrame', hands: [{ landmarks: [[0, 0, 0]] }] },
        { trackingState: 'limited' },
    );
    eq(later.scene.trackingState, 'limited', 'carried scene fills in when payload omits it');

    ok(decodeHandFrame({ type: 'cameraFrame' }) === null, 'rejects a non-hand payload');
    ok(decodeHandFrame(null) === null, 'rejects null');
    ok(decodeHandFrame({ type: 'handFrame' }) === null, 'rejects a handFrame with no hands array');
}

console.log('decodeCameraFrame');
{
    const cam = decodeCameraFrame({
        type: 'cameraFrame', image: 'AAAA', width: 320, height: 240,
        timestamp: 9, orientation: 'landscapeRight',
    });
    eq(cam, { image: 'AAAA', width: 320, height: 240, timestamp: 9, orientation: 'landscapeRight' },
        'camera frame decodes');
    ok(decodeCameraFrame({ type: 'handFrame' }) === null, 'rejects a non-camera payload');
}

// ── presence ─────────────────────────────────────────────────────────────────
console.log('presence');
{
    const bridge = stubBridge();
    const stream = new SourceStream({ bridge });
    const events = [];
    stream.onPresence((e, s) => events.push([e, s.id, s.kind]));

    bridge.emit({ event: 'source_connected', sourceId: 'src-hand-0', kind: 'hand' });
    eq(events, [['attached', 'src-hand-0', 'hand']], 'attach is observed');
    eq(stream.list().map(s => s.id), ['src-hand-0'], 'device is listed');

    // Duplicate connects must not double-register — the relay replays already
    // attached sources into the display ack on reconnect.
    bridge.emit({ event: 'source_connected', sourceId: 'src-hand-0', kind: 'hand' });
    eq(stream.list().length, 1, 'duplicate attach is idempotent');

    bridge.emit({ event: 'source_disconnected', sourceId: 'src-hand-0' });
    eq(events.length, 2, 'detach is observed');
    eq(stream.list().length, 0, 'device is removed');

    // A late subscriber must see devices that are already attached.
    bridge.emit({ event: 'source_connected', sourceId: 'src-hand-1', kind: 'hand' });
    const late = [];
    stream.onPresence((e, s) => late.push([e, s.id]));
    eq(late, [['attached', 'src-hand-1']], 'late subscriber is caught up on attach');
}

// ── frames + multi-device ────────────────────────────────────────────────────
console.log('frames');
{
    const bridge = stubBridge();
    const stream = new SourceStream({ bridge });

    bridge.emit({ event: 'source_connected', sourceId: 'src-hand-0', kind: 'hand' });
    bridge.emit({ event: 'source.frame', source: 'src-hand-0', kind: 'hand', data: handFrame(0.4) });

    eq(stream.latestHands('src-hand-0')[0].landmarks[0].z, 0.4, 'pose is readable by id');
    eq(stream.latestHands()[0].landmarks[0].z, 0.4, 'pose is readable with no id (single device)');
    eq(stream.get('src-hand-0').frames, 1, 'frame counted');
    eq(stream.latestScene('src-hand-0').intrinsics.fx, 1500, 'scene is retained');

    // A frame arriving before its source_connected must not be dropped.
    bridge.emit({ event: 'source.frame', source: 'src-hand-9', kind: 'hand', data: handFrame(0.7) });
    ok(stream.get('src-hand-9') !== null, 'a frame ahead of its attach self-registers');

    // Two devices must not bleed into each other — the whole point of provenance.
    bridge.emit({ event: 'source_connected', sourceId: 'src-hand-2', kind: 'hand' });
    bridge.emit({ event: 'source.frame', source: 'src-hand-2', kind: 'hand', data: handFrame(0.9) });
    eq(stream.latestHands('src-hand-0')[0].landmarks[0].z, 0.4, 'device 0 pose unchanged by device 2');
    eq(stream.latestHands('src-hand-2')[0].landmarks[0].z, 0.9, 'device 2 has its own pose');
    // No-id read picks the most recently active hand device.
    eq(stream.latestHands()[0].landmarks[0].z, 0.9, 'no-id read follows the most recent device');

    // Scene carry across frames: device omits scene after the first message.
    bridge.emit({
        event: 'source.frame', source: 'src-hand-0', kind: 'hand',
        data: { type: 'handFrame', timestamp: 20, hands: [{ landmarks: [[0.1, 0.1, 0.1]] }] },
    });
    eq(stream.latestScene('src-hand-0').intrinsics.fx, 1500, 'scene persists when a frame omits it');

    // A camera device on the same stream must not be mistaken for a hand.
    bridge.emit({ event: 'source_connected', sourceId: 'src-camera-0', kind: 'camera' });
    bridge.emit({
        event: 'source.frame', source: 'src-camera-0', kind: 'camera',
        data: { type: 'cameraFrame', image: 'BBBB', width: 320, height: 240 },
    });
    eq(stream.get('src-camera-0').camera.image, 'BBBB', 'camera frame stored');
    eq(stream.get('src-camera-0').hands, [], 'camera device contributes no hands');
    eq(stream.latestHands().length, 1, 'no-id hand read ignores the camera device');
}

// ── liveness ─────────────────────────────────────────────────────────────────
console.log('liveness');
{
    const bridge = stubBridge();
    const stream = new SourceStream({ bridge });
    bridge.emit({ event: 'source_connected', sourceId: 'src-hand-0', kind: 'hand' });

    // Attached but never sent: not stalled — it hasn't had a chance yet.
    ok(!stream.isStalled('src-hand-0'), 'a device that never sent is not stalled');

    bridge.emit({ event: 'source.frame', source: 'src-hand-0', kind: 'hand', data: handFrame() });
    ok(!stream.isStalled('src-hand-0'), 'a device that just sent is live');

    const at = stream.get('src-hand-0').lastFrameAt;
    ok(stream.isStalled('src-hand-0', at + 5000), 'a quiet device reads as stalled');
    ok(!stream.isStalled('src-nope'), 'an unknown device is not stalled');
}

// ── teardown ─────────────────────────────────────────────────────────────────
console.log('dispose');
{
    const bridge = stubBridge();
    const stream = new SourceStream({ bridge });
    bridge.emit({ event: 'source_connected', sourceId: 'src-hand-0', kind: 'hand' });
    stream.dispose();
    bridge.emit({ event: 'source.frame', source: 'src-hand-0', kind: 'hand', data: handFrame() });
    eq(stream.list().length, 0, 'dispose unsubscribes and clears');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

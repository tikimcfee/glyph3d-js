# Hand wire v2 — the face-down phone

The capture device (MotionSource on an iPhone) lies FACE-DOWN on the desk, its top edge
pointing away from the user — the way the fingers point when the hand is over it. Its back
camera and LiDAR look UP at the hand; the ceiling is the static background. The phone's screen
can't be seen or touched, so all guidance and UI live in glyph3d; the phone only streams.
This is Leap Motion's geometry.

The same contract is kept in the MotionSource repo (`docs/hand-wire-v2.md`); a change is agreed
between the two sides and written into both.

## Transport

WebSocket to the glyph3d relay. The first message is `SOURCE hand`; the relay acks
`{"ok":true,"role":"source","sourceId":"src-hand-0",…}` and forwards each later text frame to
the display as `{event:'source.frame', source, kind, data}`, dropping the oldest under
backpressure.

## handFrame

```
{
  "type": "handFrame",
  "v": 2,
  "timestamp": 1234.567,             // capture time, seconds, device monotonic clock
  "sentAt": 1234.579,                // send time, same clock, stamped as the frame is serialized
  "mount": "faceDown",               // "faceDown" | "faceUp" | "upright" | "unknown", from gravity
  "device": {                        // null until CoreMotion has delivered a sample
    "gravity": [x, y, z],            // unit vector, PHONE frame; face-down reads ≈ [0, 0, −1]
    "attitude": [qx, qy, qz, qw]     // CoreMotion attitude
  },
  "ceiling": 2.31,                   // meters along +z to the scene outside the hand boxes
                                     // (per-frame median, unfiltered); explicit null when unknown
  "hands": [{
    "handedness": "left" | "right",  // Vision's label (from-below behaviour being measured)
    "confidence": [c0 … c20],        // per joint, 0..1 (rounded to 1e-3)
    "points": [[x,y,z] | null × 21], // METERS, PHONE frame (rounded to 0.1 mm); null = unseen
    "rays": [[x,y,z] | null × 21],   // unit direction from the optical centre to each joint Vision
                                     // detected, from its pixel + the image intrinsics, independent
                                     // of depth; null only when Vision has no keypoint (conf ≤ 0.3); 1e-4
    "landmarks": [[u,v,d] × 21]      // v1: normalized image coordinates + depth
  }],
  "scene": { … v1 scene payload … }
}
```

- Frames with `"hands": []` are sent at 10 Hz while no hand is seen, so the consumer knows the
  phone is there, how it lies and the ceiling before a hand shows up. With hands present, every
  processed frame is sent.
- Joint order is MediaPipe's 21 (wrist 0; thumb 1–4; index 5–8; middle 9–12; ring 13–16;
  pinky 17–20) — `packages/glyph3d-core/src/hand/HandData.js` `Joint`.
- **Points are SKIN-SURFACE points.** LiDAR sees the palmar skin; the true joint centres sit
  ~0.6–0.9 cm further along +z for fingers and ~1.2–1.8 cm for the palm and wrist. The phone
  adds no offset; calibration measures what is reported and absorbs it.
- A joint with a ray and a null point was seen in 2-D but has no usable depth: the consumer's
  hand model rebuilds it along the ray at its learned bone length from its parent (and does the
  same for a point whose depth breaks the bone-length gate), marking it rebuilt.
- **No app-side smoothing**: no temporal filter on points or depth. The consumer filters once.
- Joint depth is the hand band: the palm depth from the wrist and MCPs, then per joint the
  median of the window's pixels within ±12 cm of it (7×7 for fingertips). A point is null if
  its confidence is ≤ 0.3 or fewer than 3 such pixels survive. No bone-length fill.

## The PHONE frame (right-handed, meters)

- origin: the LiDAR / wide camera's optical centre;
- +y: toward the phone's TOP edge (away from the user);
- +z: out of the phone's BACK (straight up when face-down);
- +x = y × z: the user's right when the phone lies face-down, top away.

The phone does the unprojection (pixel + depth + intrinsics → phone frame), so the consumer
never needs the camera model.

## Handedness from below

A palm-down RIGHT hand has `((p5 − p0) × (p17 − p0)) · ẑ < 0`. The phone logs Vision's label
against that test; glyph3d's flat-hand calibration step runs the same test
(`handednessMirrored` in the profile) — the two cross-check.

## Consumer side (glyph3d)

`decodeHandFrame` (`hand/HandData.js`) reads `points` / `confidence` per hand and the `device`
block (mount, gravity, attitude, ceiling, timestamp, sentAt); `SourceStream` keeps the latest
as `SourceState.device` on every frame, hand or not, and `latency.captureToSend` (sentAt −
timestamp) and `latency.arrivalLag` (how much later than the fastest frame of the trailing
10 s a frame arrived — the clocks share no epoch, so absolute transit time isn't knowable).
`HandModel` (`hand/HandModel.js`) learns the hand and its space from every frame (see
CLAUDE.md, Sensor plane); `HandSim` (`hand/HandSim.js`) emits this format with known truth for
tests and `hand.simulate`.

# Hand tracking

The sensor plane and the live hand model. The wire format: `docs/hand-wire-v2.md`.

## Sensor plane

**Sensor plane** — capture devices (an iPhone running the `motion-source-ios`
MotionSource app) connect to the relay with a `SOURCE <kind>` handshake, a third
client role beside `DISPLAY` and controllers. **Many may attach at once**, each
with its own id (`src-hand-0`). The relay is schema-blind: it stamps provenance
and forwards `{event:'source.frame', source, kind, data}` on the display's
existing socket, with **drop-oldest** backpressure (frames are perishable — queue
depth is a latency ceiling, not a buffer). Browser side, `SourceStream`
(`services/orchestration`) owns presence + decode + liveness, and `HandPresence`
(`hand/`) draws one `HandRenderer` per device, sampled **pull-style** once per
rendered frame — for the device the hand model follows, the MODEL's hand (repaired,
skin-corrected metric joints through `HandSpace.toView`, the one phone → view mapping the
stages share: his right → +x, up → +y, away → into the view), tipped back by `hand.tilt`;
any other device, its image-space landmarks. Verbs: `hand.list` / `hand.status` / `hand.show` / `hand.hide` /
`hand.place`, plus relay-resident `source.list` (answers with no display
connected). **Hand-wire v2** is the face-down phone (Leap Motion's geometry: the
phone on the desk, its depth camera looking up at the hand): `decodeHandFrame` reads
metric `points` (meters, PHONE frame: +y toward its top edge, +z up out of its back)
with per-joint `confidence` (null = unseen), and a `device` block on every frame,
`hands: []` included (mount, gravity, ceiling, `sentAt`) — `SourceState.device` /
`.latency`. **The live hand model** (core `hand/HandModel.js`, app `client/HandCalib.js` =
`ctx.handCalib`) is always on, like XR tracking: every frame of the followed device teaches it
— hands are TRACKED by continuity and left/right is a running vote over a track's life (the
palm's anatomy while it faces down, Vision's label a little; an undecided or blink-long track
feeds nothing, so no ghost hands); per hand, each estimate a decaying histogram (online
quantiles that forget): the SKIN depth (points are skin — palm length regressed on
(1 − cos²θ)/range gives r; every point is un-offset before anything learns), bone lengths as
palm length × ratio × (1 + δ) on a reference skeleton (each bone's δ admitted by its evidence:
weighted 1 − (bone·ray)², counted in independent poses — so repair works from the first
second)
(and `repair`: a joint seen in 2-D with no depth, or off its bone, is rebuilt along its `ray`
at the bone length, the root chosen within joint limits), palm length (the scale), pinch modes → thresholds, the volume's
percentile bounds, rest noise from still moments it finds itself, the palm template (Kabsch →
yaw/pitch/roll from a learned neutral); a phone BUMP (attitude/gravity jump) re-learns the
phone-frame parts (a slide, invisible to attitude, from `userAcceleration`). Each quantity reports value · weight · drift · settled/settling/idle/unknown.
Its snapshot saves itself (client store `hand.model`, per browser) as a WARM START only.
`hand/HandSpace.js` is the pass-through stage chain raw → spike gate → 1€ (rest cutoffs solved
from the measured noise, its lag shown) → dead zone (k × the jitter left after the filter) → the volume through ONE
isotropic gain, frozen once it settles (re-learned only on a bump / reset) → app axes, reading
the model (Settings ▸
Hand space / Hand model); the pinch tracker also keeps a stabilized pinch point (thumb → index at
0.2) and, at onset, where it was 100 ms before (the closing motion moves it — Wolf 2020).
**The displayed hand is ONE stabilized hand** (`hand/HandStabilizer.js`, `HandCalib.displayHand`):
the merged joints (cloud fit / ray repair) filtered in the palm's own frame — palm pose, then
each joint palm-local — every joint's One Euro tuned from its OWN measured noise, with a speed
deadband at that noise; the scene hand, desk view, panel and cloud view all draw it. Its
acceptance numbers (`hand/handMetrics.js`, live in calib.status and the panel): per-joint still
jitter p95 (target < 0.5 mm, tips included) and lag while moving. Real sessions are RECORDED by
the relay (`source.record start [name] | stop | status` → JSONL in the user cache dir, or
`serve --record-dir`) and replayed headlessly through the same code (`bun tools/hand-replay.mjs
<file> [--variant "name:hand.stab.k=v"]…`). Verbs `calib.status|inspect|reset|save|forget|pin|view`; the Hand
dock panel is the convergence board. `hand/HandSim.js` is a face-down hand with known truth
that just wanders (`hand.simulate on [mode] | bump`); gates `tools/hand-model.test.mjs`,
`tools/hand-calib-app.test.mjs`. Gesture→verb and hand→camera binding are not built yet.

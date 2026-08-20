# Scale-Free Flight — the terminal invariant for 3D navigation

**Status:** Converged design, implementing
**Date:** 2026-08-20
**Supersedes:** the "dynamic scale" (visionOS-style world rescaling) notes — see
*Rejected approach* below for why.

---

## 1. The problem is typography, not navigation

Text has a legibility band; a sphere does not. A sphere is the same object at 5
feet or 10 feet; a glyph is only a glyph inside a narrow window of apparent
size. So near a text surface, *distance is not a spatial quantity*:

- The camera's Z axis, pointed at a page, is a **font-size slider**.
- X/Y translation at a given Z is **scrolling**.

A terminal makes the target feel exact: it fixes apparent glyph size and moves
content at constant *screen* speed — lines per second, regardless of file
length. A 5-line file and a 5000-line file scroll identically; length only
changes how long you scroll. In 3D the thing that moves is *you*, and a camera
whose speed is calibrated in absolute world units breaks that invariant in
every scale regime except the one it was hand-tuned for: the same key-press
covers wildly different amounts of *text* depending on how big the text
happens to be. That is the speed-scaling discontinuity — fitted volumes,
splayed pages, giant natural-scale files all feel like different worlds.

## 2. The law

Constant screen-space text velocity has a closed form. The on-screen speed of
content at distance `d` under camera speed `v` is `v / worldPerPixel(d)`, and
`worldPerPixel` is linear in `d` (`services/spatial/spatialMath.js`). So:

```
v = k · d        d = distance to the visible content you're facing
```

One law, both axes:

- **Lateral (scroll):** text slides across the view at the same lines-per-
  second whether the page is fitted at 0.1× or towering at 1×. The 5000-line
  wall scrolls exactly like the 5-line block.
- **Depth (zoom):** `dz/dt ∝ z` is exponential approach — constant
  *multiplicative* font-size change per second. You can end up nose-close
  without ever feeling a lurch, because no moment of the approach is
  distinguishable from any other. (The wheel dolly already obeys this law in
  discrete form: each tick steps a fixed *fraction* of the live distance.)

Properties that fall out:

- **Time-to-target is `ln(d₀/d₁)/k`** — logarithmic in the distance ratio.
  Turn-and-go to anything visible takes a few seconds, near or far. Turning is
  choosing, flying is a few seconds, arriving is reading.
- **Body scale is unobservable.** The law has no unit constant in it, so being
  0.05 units from a fitted page is kinesthetically indistinguishable from
  being 50 units from a natural one. Glance at something far, fly — speed
  re-normalizes instantly. There is no fact of the matter about how big you
  are, because nothing in the control law can measure it.
- **`fitInfo.scale` never appears.** A 0.1× fitted book is simply read from
  0.1× the distance; the regime is encoded in the geometry. No per-layout,
  per-book, or per-regime tuning exists to get wrong.
- **Rotation needs nothing.** Yaw/pitch are already screen-native
  (degrees-per-second covers the same on-screen arc whatever the scene holds).
  Only translation carries the law.

Implementation form: `speedScale = d / DEFAULT_LOOK_DIST`, so at the reference
distance (200) flight runs at exactly `cameraSpeed` — the speed slider keeps
its meaning ("your speed at reference engagement, and in the void") and `k`
is `cameraSpeed / 200` implicitly. One knob, and it's the one that existed.

## 3. The distance: an angle-gated field, not an object

With hundreds of surfaces loaded, *which one participates?* is a category
error left over from object thinking. The law needs a **scalar field over
camera pose** — "how far is the stuff I'm engaging with" — not a focused
object. Flight focus is ephemeral: where the camera is and where it looks *is*
the focus state; periphery and behind aren't part of it, and a quick yaw
means suddenly they implicitly are. Any discrete selection anywhere in the
loop (first-hit rays, sticky targets, band edges) eventually surfaces as a
lurch in the hand.

Two rules, two roles:

- **Angle gates — who votes.** A surface participates only inside the forward
  cone, weighted by angular proximity to the view axis. Distance buys no
  voting power: file A two units off your left shoulder has near-zero weight
  and cannot leash you while you face file B eighty units ahead. (The
  opposite choice — proximity-dominant — is the crawl-past-every-bookshelf
  failure.)
- **Distance answers — what they vote on.** The aggregated scalar is a
  **soft-min over the voters' distances**: face a page corner with a far wall
  visible behind it through the gap and the corner wins. The aggregation runs
  in **log-distance space**, which is the scale-free choice — multiplying the
  whole scene by c multiplies the answer by c exactly.

Concretely (`_lookDistance`): a 9-ray probe — the view ray plus rings at
±CONE_TAN/2 and ±CONE_TAN in screen right/up — each ray keeping its *nearest*
hit (occlusion-correct: you can't read what you can't see), combined by a
weighted log-domain soft-min. This is a poor-man's 9-pixel depth buffer; the
principled upgrade path, if ray-count granularity ever shows through, is a
real low-res depth probe of the frame (the occlusion culler already owns the
GPU-readback machinery). Behind-the-eye content is culled — flying away from
something is never braked by it — and the nearest-AABB fallback covers the
void (nothing in view → nothing to hold a screen invariant for → reference
speed, with soft bounds as the leash).

**Participation is by bounds, not by type.** Code grids, terminals, books,
lone glyph fields, capture surfaces — the field reads `getBounds()` and
cannot ask what a thing is. The inverse list is the real contract: *content
you read participates; instruments you read it with don't* — dock tiles
(camera-locked chrome) are skipped today; any future near-camera overlay
(hand renderers, carets) joins the same exclusion.

This signal stays **out of AttentionManager**. It is a derived per-frame
scalar owned by the camera controller — not a fourth attention slot. Attention
keeps its one-writer-per-slot discreteness for clicks and keys; flight keeps
its continuity; they meet only where they always have (a click crystallizes
ephemeral focus into a slot).

## 4. Slew: damp the distance, asymmetrically

Nine rays are still finitely many: during a yaw a surface enters the cone ray
by ray, and raw per-frame distance would step. The fix is temporal damping
**on the distance scalar in log space** (scale-free: the slew rate is in
decades-per-second, identical feel at every scale) — *not* on the speed
multiplier downstream, which launders flutter instead of removing it.

Asymmetric on purpose — **brake fast, throttle lazy**:

- Something near swings into view → distance drops on the short time constant
  (`dynamicBrakeSlew`, default 0.06s). Safety and comfort.
- The view opens onto distance → it rises on the long one
  (`dynamicThrottleSlew`, default 0.3s). No speed spike mid-yaw.

The settle has a human analog — accommodation. Eyes don't select objects
either; they refocus on whatever gaze lands on, with a beat of lag people
already expect. First moving frame snaps (crisp takeoff); releasing the keys
unlatches so the next flight snaps fresh — same latch discipline the old
damper had.

## 5. What this replaces

The previous system was a hand-tuned **valley**: speed multipliers lerped
between `dynamicNearDist`/`dynamicFarDist` with floor/ceiling clamps and a
snap-back release — all calibrated in absolute world units, i.e. correct in
exactly one scale regime. The envelope was compensating for a discontinuous
input (first-hit cone) and an absolute-unit law. Both causes are gone, so the
knobs go with them (`dynamicSpeedMin/Max`, `dynamicNearDist/FarDist`,
`dynamicSpeedSmoothing`) — no compatibility shims, per house rules.

Kept:

- `dynamicSpeed` — master toggle; off → flat `cameraSpeed` everywhere.
- `dynamicReleaseDist` — the punch-through escape ("closer than this → run at
  reference speed, you've passed through it"). **Now default 0 (off)**: it is
  deliberately scale-broken (absolute units), and any nonzero value makes
  small-regime reading impossible below that distance. The scale-free exit
  gesture is a *glance* — look away and the angle gate frees you instantly.
  A persistence-based release (distance pinned at the floor while W is held →
  escalate) is the open question if pass-through intent proves common.
- Pan's held-anchor discipline (sample once per drag) — but the sample is now
  the raw field distance clamped only by the global [MIN, MAX] look band, not
  the valley band: a drag while nose-close to a page moves at page-scroll
  speed, which is the invariant, not a bug.
- The wheel dolly — it was already the law in discrete form.

## 6. Rejected approach: world-side dynamic scale

The superseded notes proposed `finalScale = fittedScale × (d / refDist)` on
the content itself (visionOS "dynamic scale"). That formula makes angular
size *distance-invariant*, which quietly forecloses the tool's core
interaction:

- Flying toward a book produces zero magnification — you can never arrive,
  and forward motion toward the target is visually undetectable.
- `zDistanceForFit` has no solution — every fit/jump/frame verb loses its
  well-defined destination.
- Books grow with distance but their spacing doesn't — the far view melts
  into interpenetration.
- The size-distance depth cue doesn't weaken, it inverts.

visionOS gets away with it because it rescales sparse windows *at reposition
time*, not continuously while the wearer moves. Moving the compensation into
the camera's relationship with a rigid world keeps every invariant intact
(layout, bounds, culling, picking, framing) and achieves the actual goal:
perceived-scale continuity while *traversing*.

## 7. Success criteria

- Flying between a natural-scale grid and a 0.1× fitted volume is
  imperceptible as a regime change; the headless lock is exact: scale the
  whole scene (and camera) by c and the per-frame step scales by exactly c.
- Turn-left-while-close: near content just off your shoulder never leashes
  you; what you face governs; the handoff is a glide, not a step.
- Rotation always feels the same; forward is always forward at the expected
  *screen* speed.
- No layout, bounds, picking, or per-frame CPU cost changes — the world stays
  rigid; only `ViewerCameraController` changed.

Behavior locks live in `tools/camera-proximity.test.mjs`.

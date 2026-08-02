# Predictions — written by `state-persistence` before reading any other agent's output

Method note: I have read none of the other two deliverables. These are inferred from the shared
codebase, the commission text, and the standing priors.

---

## Agent `entity-substrate` (lens: the Object3D subclass zoo, CameraDock/Carrel twins, component decomposition)

**Prediction 1 — the trunk is already extracted, and they will say so.** They will land on
`FramedGlyphField` as the real substrate (it already owns `ScaleModel`, `setZoom`, `setScale`, the
resize/onResize taps) and argue CodeGrid / TerminalGrid / FrameGrid differ along exactly three axes
— **source** (file buffer vs PTY stream), **mutation** (edit ops vs byte stream, with the
size-tagged-frames law meaning the stream owns terminal size), and **layout** (tree leaf vs free
placement) — which is a restatement of Ivan's 2026-06 north star, now with the code to back it.
Expect them to name `applyView` as the proof that the two "different" classes already implement the
same contract with different fields.

**Prediction 2 — CameraDock and Carrel called out as literal twins, unified as ONE holder
abstraction parameterized by anchor.** They will enumerate the matching method sets
(`lock`/`release`/`homeOf`/`pruneDismissed`/`entries`/`list`/`setParam`/`setMode`, plus
`expect`/`reflowTile` as the near-misses) and propose a single `Holder` component/system whose only
real difference is camera-anchored vs world-anchored, with the root view-frame as a dock-only
extra. I predict they will *also* find the `homeOf` handoff chain and read it as the strongest
single argument in the whole study, because it is a law that exists purely to compensate for
residence not being a first-class thing. Where they and I may differ: I expect them to lean toward
unifying the *holders* (classes), while my lens says unify the *relationship* (component) and keep
two systems — a real disagreement worth surfacing in cross-review.

**Prediction 3 — decompose conservatively; do not touch the buffer.** They will explicitly fence off
the glyph instance buffer / atlas / TSL material as "not component material", propose extracting
the already-half-extracted pieces first (`ScaleModel` → `Zoom`, `LayoutDescription` → `Fold`,
window/frame/scroll → `Viewport`), and recommend against adopting a third-party ECS library —
hand-rolled component maps over the existing registry, because `SceneRegistry`'s `type`/`role`
`role||type` tag is already an archetype key. I also expect them to flag agent Books and Carrels as
the entities that *don't fit the registry* today (books live in `AgentBooks.lanes`, carrels register
but are refused by `resolveSurface`) and to argue that's the entity-space leak ECS fixes first.

---

## Agent `systems-runtime` (lens: tick loops, command bus, picking, responder chains, animators)

**Prediction 1 — "there is no schedule" is their headline.** They will find that per-frame work is
scattered across r3f `useFrame` in the shell plus self-driven animators inside CameraDock, Carrel,
AgentBooks and ContentTreeMotion, with no declared ordering, and propose an explicit ordered system
schedule (roughly: input → command drain → intent/model → layout → transform/holder → animate →
cull → pick → render). I expect them to name the ordering hazards concretely — the camera
integrator stomping any quaternion write every frame, and layout relayout vs holder transform being
two writers of the same `position` in the same frame.

**Prediction 2 — the command bus IS the ECS command buffer, and needs no replacement.** They will
argue `CommandRouter.execute` + the verb handlers are already the deferred-mutation layer ECS calls
a command buffer, that `SceneRegistry.holdChanges`/`flushHeld` is a nascent commit barrier, and that
picking's `role||type` channel selection plus `_pickableTypes`/`_pickable` incremental set
maintenance is already an archetype query maintained on write. Expect a strong "don't rebuild what
works" note here, aligned with the cannibalize-existing-infra law — and specifically a warning that
verbs must stay **synchronous read-after-write** (the CLI/tests depend on it), which is the single
hardest constraint any deferred-system design must respect.

**Prediction 3 — responder chains as evidence FOR components, and the r3f fight as the main risk.**
They will read `keyboardRouter`'s ordered tier list and `gestureResolver`/`surfaceInteractions`'s
per-type record table as capability lookups that want to be component queries ("does this entity
have `Scrollable`/`Pageable`/`Movable`" instead of `RECORDS[role||type]`), and note that
`moveVerbFor` defaulting to `grid.move` is exactly how a capability gets silently mis-assigned.
Their headline risk will be that react-three-fiber's `useFrame` is the only real scheduler in the
process, so an ECS schedule has to live *inside* one `useFrame` callback rather than owning the
loop — plus per-frame iteration/allocation cost, which I expect them to conclude is negligible at
the current entity count (tens of surfaces, not thousands) and therefore not a reason to adopt or
reject.

---

## Where I expect the three of us to converge, and to clash

**Converge:** all three will independently name the CameraDock/Carrel twinning as the flagship
example, and all three will conclude "incremental component extraction, no ECS library, no
big-bang" — because the house laws make anything else unshippable.

**Clash (my bet):** `entity-substrate` will want to unify the holder *classes*; I argue for one
`Residence` component with two systems. And `systems-runtime` will likely propose a deferred/tick
scheduler, which collides head-on with the synchronous verb contract
(`STATE_ARCHITECTURE.md:133` — "apply() after a verb must be synchronous, or read-after-write breaks
for the CLI/tests/chained handlers"). Reconciling "systems run on a tick" with "verbs return
post-apply" is, I predict, the sharpest genuine design conflict in this study.

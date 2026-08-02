# Predictions — written before reading any other agent's output

Author: `entity-substrate`. Written after finishing `phase0-entity-substrate.md` and before opening
either sibling file. Deliberately falsifiable.

---

## Agent `state-persistence` (WorkspaceModel view facts · SessionStore projectors · capture/restore · verb→fact→projector)

**P1 — "the component store already exists, it's just not authoritative."**
I expect state-persistence concluded that `WorkspaceModel.surfaces[id].view` (`:152-163`) is
already a sparse, id-keyed, change-diffed, *persisted* component store, and that the real ECS win
is not building one but **deleting the live mirrors** it duplicates — because
`STATE_ARCHITECTURE.md:91` tabulates six live copies of terminal `cols/rows` alone, and every slice
in §8 is literally "collapse the copies of one fact into `view`". They should land on: *ECS here
means the live object stops owning the fact and starts being a projection of it.* I predict they
frame this as the same conclusion I reached from the opposite end (I say grow `registry.meta` into
components; they'll say make `view` the world), and **that is the sharpest disagreement the
cross-ref will surface** — one world rooted in the live scene vs one rooted in the serializable
model. My prior: they're right about *authority*, I'm right about *ergonomics*, and the synthesis is
"`view` is the component store, `registry.get(id).grid` stays the handle".

**P2 — "store inputs, not outputs becomes structural."**
I expect them to conclude that ECS makes `STATE_ARCHITECTURE.md` §3's discipline enforceable rather
than remembered: a derived component (`ScaleModel.placement`, tree-laid `position`, the dock `slot`
integer) simply isn't in the serialized archetype, so it *can't* be persisted by accident. They
should cite `positionIsDerived` (`SessionStore.js:85-87`) as the one hand-written discriminator that
becomes an archetype predicate for free — the same observation I made, reached via capture rather
than via holders.

**P3 — the asymmetry they'll catch that I only half-caught.**
I expect them to flag that `SURFACE_PROJECTORS` (`SessionStore.js:96-127`) has exactly **one**
member (`terminal`) even though `CodeGrid.applyView` exists and is driven from a *different* place
(`SessionStore.js:633`), and that the two `applyView` signatures have diverged (sync vs async,
different opts, different return shapes). They should conclude the per-kind projector table is the
right shape but was never filled in — i.e. the ECS move is *finishing an existing design*, not
replacing it.

**P4 — the risk they'll raise.**
I expect the honest-cost section to centre on **load-is-not-replay + async re-adopt**: a
world-authoritative restore is `world.load(blob)`, but the PTY, the tmux session, and the agent
processes are external children that cannot be deserialized (`STATE_ARCHITECTURE.md:79-81`), so the
projector must stay idempotent and re-runnable on registry change no matter how clean the ECS gets.
I predict they explicitly say ECS does **not** remove `apply()` — it only makes it smaller.

---

## Agent `systems-runtime` (tick loops · command bus · picking · responder chains · animators)

**P5 — "the responder chains are already systems; the ticks are not."**
I expect systems-runtime concluded that the *input* side is already ECS-shaped — `keyboardRouter`'s
ordered first-to-claim tier list, `gestureResolver`, and `surfaceInteractions.RECORDS` keyed on
`entry.role || entry.type` (`:104,118`) — while the *frame* side is not: 8 scattered `useFrame`
hooks with no central runner, the load-bearing one being `DockRunner`'s ad-hoc
`if (x) x.update(dt)` block (`CommandProvider.jsx:219-254`) whose ordering is implicit in React
mount order. They should propose one declared system schedule and note that
`contentTreeMotion.update(dt)` already returns a boolean that *gates* two downstream overlay
updates — a hand-rolled system dependency edge.

**P6 — "the command bus is already the system API; do not add a second."**
I expect them to conclude, in almost these words, that verbs are the system-invocation surface and
that an ECS which introduces a parallel way to poke entities would be exactly the dual code path the
house law forbids — because the repo's own `surfaceInteractions.js` header says it exists so
`type === 'terminal'` branches stop scattering, i.e. the bus already absorbed that pressure.

**P7 — picking as a materialized query.**
I expect them to identify the picking channels (`glyph` / `grid` / `handle` / `group` /
`container`) plus `SceneRegistry.setPickable(tag)` and the incrementally-maintained `_pickable` set
(`:45-51,285-295`) as an existing component index with an existing opt-in seam, and to conclude
that `PickTarget` is the *cheapest* component to formalize because the index already exists and
nothing else reads it. Same riverbed item I list; they'll have the per-channel detail I don't.

**P8 — where I expect them to disagree with me.**
I predict systems-runtime argues *for* a real scheduler and treats per-frame iteration cost as a
non-issue, while I argue the ECS payoff here is deduplication and that a scheduler's failure mode
(one-frame ordering lag) is harder to debug than today's missing-`update()` line. I also expect
them to be more bullish than me on unifying `SpatialAnimator` into a global animation system —
which I think is correct and which I under-weighted, since both holders already own a private
animator instance and nothing else does.

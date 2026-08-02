# ECS refactor — the SYSTEMS AND RUNTIME lens

Phase 0. Design study; no code changed. All claims carry `file:line`.

---

## Conclusions first

1. **The payoff is not "an ECS." It is ONE HOLDER PROTOCOL and ONE MOTION SYSTEM.** Everything
   else Ivan's four nouns point at is downstream of those two. The window-level entity count
   (dozens–thousands) makes storage layout irrelevant; the win is *dispatch and duplication*,
   not cache locality.
2. **`SceneRegistry` is already 80% of a component store** — entity table (`_entries`), reverse
   lookup (`_gridToId`), archetype cache keyed by tag (`_typeCache`), batched change notification
   (`holdChanges`/`flushHeld`, `SceneRegistry.js:56-63,380-431`). It lacks exactly three things:
   multi-tag membership, per-entity component slots, and a change event that says *what* changed.
   Cannibalize it; do **not** stand up a second table.
3. **The holder twins are the concrete debt.** `CameraDock` (961 lines) and `Carrel` (712) share
   ~15 duplicated mechanics including two *verbatim* functions. Every cross-cutting caller pays for
   it with a branch tree (`window.drop`, the session projector, the removal cascade, the carrel
   sweep — all cited below).
4. **There are SIX independent time-integrators running three different easing idioms.** One
   `Motion` system is behaviour-identical to today because `SpatialAnimator`'s key space is
   *already global* (`${object.uuid}:${property}`, `SpatialAnimator.js:48`) — merging N animators
   cannot collide. This is the cheapest real extraction in the repo.
5. **Reactivity is the loudest smell.** `SceneRegistry._fire(type)` (`:424-430`) carries a *type
   string* and nothing else, so all 13 subscribers do a full re-scan; and the HUD gave up entirely
   and **polls at 150ms** because "scroll/frame/layout/edit don't emit" (`HudPanel.jsx:78`). A
   per-component change event is the fix, and it is small.
6. **Do NOT convert the glyph layer.** Per-glyph instance attributes are already the optimal
   form. ECS here means *window-level* entities only.
7. **Staging: extract the Holder PROTOCOL first** (~40 lines, pre-ECS), then Motion, then
   component-change events, then config/overlays, then the visual-state system. The holder protocol
   alone deletes six branch trees and is reversible in an afternoon.

### Premise corrections (verify-first)

- **`GridVirtualizer` is DEAD in the live app.** The only `new GridVirtualizer` outside its own
  docblock is `tools/carrel.test.mjs:271`. It is not in `CommandProvider`, not in any `useFrame`.
  Its park/seat machinery (`GridVirtualizer.js:168-184`) is nonetheless *referenced as live* by
  `Carrel`'s borrowed-guard doc (`Carrel.js:41-44`). **Delete it; do not model it.** (It is
  otherwise a third holder and would triple the protocol's cost.)
- The brief's "cursor blink" tick does not exist as a frame system — `TerminalEmulator` coalesces
  writes onto one rAF (`TerminalEmulator.js:92`), and the only breathing loops are the dock ghosts
  (`CameraDock.js:747-753`) and the directory fill (`CanvasInteraction.jsx:63,~963`).

---

## The four nouns, concretely

### TOGGLES

**Today.** A toggle is a *hand-written push into a named subsystem*. `app/client/settings.js`
carries **157 bespoke `apply:` closures** (`:86-...`, e.g. `:342` `cull.enabled →
ctx.occlusionCuller?.setEnabled?.(v)`; `:425` labels; `:474` motion). Because those closures fire
*only on user change*, `CommandProvider` must re-push each group by hand at boot — **eight**
`applyGroupSettings` calls with comments explaining why (`CommandProvider.jsx:419-426, 481,
499-501, 525, 699`, e.g. `:498` *"its apply()s only fire on a user change, so without this a stored
value would wait until next touch"*). Six subsystems each re-implement `setEnabled` +
`this.enabled` (`ContentTreeMarkers.js:91`, `ContentTreeLabels.js:259`, `ContentTreeArrows.js:130`,
`ContentTreeProbes.js:59`, `ContentTreeMotion.js:71`, `OcclusionCuller.js:119`).

The repo already *proved* the generic shape works: `layoutCommands.js` registers markers / arrows /
labels / probes / motion through ONE `registerOverlay` factory with a shared `on|off|toggle`
+ `--flag value` grammar (`layoutCommands.js:~110-160, 249`).

**Under ECS.** A toggle is a component write: `enabled` is a field on an `Overlay` component, and
the system reads it in its own tick. Boot-fold vanishes — a system that reads state each frame
cannot have a "stored value waiting until next touch" bug, because there is no push at all.

**Simplifies (measurable):** 157 closures → ~15 declarative `{entity, component, field}` records;
8 boot-folds → 0; 6 `setEnabled` implementations → 1.
**Riskier:** `STATE_ARCHITECTURE.md:133` requires **synchronous** apply so the CLI/tests/chained
handlers keep read-after-write. A pull-based toggle defers the visible effect by one frame. Verbs
that are *asserted on* by `tools/*-check.mjs` must either keep a synchronous push or the harnesses
must tick a frame. This is a real, non-cosmetic cost.

### LIVE UPDATES

**Today.** One coarse event and a poll.
- `SceneRegistry._fire(type)` passes a *type string only* (`:424-430`) — no added/removed id, no
  component delta. **13 subscribers** each therefore re-scan the world: `syncCullCandidates`
  (`CommandProvider.jsx:517-524`, `for (const e of registry.list())`), `onRemoval` (`:527-545`),
  `reconcileWorkspace` (`:726`), `scheduleWarmUp` (`:733-739`, re-counts `registry.list().length`),
  `SessionStore._onRegistryChange` → `_projectSurfaces` (`SessionStore.js:155,756-766`, iterates
  every surface), `CanvasInteraction` pick-wiring (`:124`), `FileTree` (`:257`), `TerminalsPanel`
  (`:98,:160`), `RepoPanel` (`:97`), `EditorPanel` (`:104`), `HudPanel` (`:77`), plus
  `syncVolumeCovers` on tree relayout (`CommandProvider.jsx:439-460`).
- `holdChanges` exists precisely because that fan-out is quadratic under bulk load
  (`SceneRegistry.js:56-63`; used at `CommandProvider.jsx:126-131, 439`).
- The HUD **polls every 150ms**: `HudPanel.jsx:78` — *"scroll/frame/layout/edit don't emit — poll"*.
- `CanvasInteraction.jsx:882-975` is a full **per-frame reconcile of visual state from attention**
  (border flags, cursor focus, capture look, dir outline, breathing fill) — written per-frame
  *specifically because* there is no change event to hang it on (`:876-881`: "no cached grid
  objects, no dependence on change events… this self-heals two ways").

**Under ECS.** Component writes emit `(entity, component)`; archetype sets are maintained
incrementally on add/remove; systems subscribe to *archetypes*, not to "something changed."
`CanvasInteraction`'s per-frame reconcile becomes a `VisualState` system over
`query(Attention, Panel)` and can early-out when nothing in that archetype changed.

**Simplifies:** the 150ms poll dies; 13 full re-scans become N targeted callbacks; `holdChanges`
keeps working unchanged (it is already the batching primitive an ECS wants).
**Riskier:** fine-grained events invite *cascade storms* — a component write inside a system that
triggers a system that writes again. The current coarse event is accidentally cycle-proof because
everything is idempotent (`STATE_ARCHITECTURE.md:44-46`). Preserve that discipline explicitly, or
add a write-phase/read-phase split.

### RELATIONSHIPS

**Today.** Holder↔held is re-implemented per holder, and every cross-cutting caller branches over
the holder kinds by hand.

*Duplicated mechanics, `CameraDock.js` vs `Carrel.js`:*

| mechanic | CameraDock | Carrel |
|---|---|---|
| `reachesScene` (**verbatim duplicate**) | `:91-98` | `:69-76` |
| `extentFromBox` (near-twin; width formula differs) | `:104-112` | `:83-92` |
| `entries` / `_releasing` / `animator` / `_orderSeq` | `:210-219, 191` | `:154-159, 146` |
| `lock(id, grid, opts)` | `:427-496` | `:191-246` |
| `release(id, {to})` | `:511-550` | `:261-297` |
| `dismiss(id)` | `:559-583` | `:306-318` |
| `pruneDismissed(isLive)` | `:591-595` | `:325-329` |
| `releaseAll` / `has` / `list` / `homeOf` / `setParam` | `:382, 232, 238, 369, 393` | `:332, 167, 170, 355, 374` |
| `_extentOf` / `_containScale` / `_userOf` (**`_userOf` verbatim**) | `:626, 632, 642` | `:424, 437, 432` |
| `_animateTile` / `_animateMember` | `:765-775` | `:456-468` |
| `_relayout` (slot ranking + contain-fit + animate) | `:784-893` | `:481-542` |
| `reflowTile` / `reflow` (onResize tap) | `:904-910` | `:549-553` |
| per-frame slerp over `entries` + `_releasing` | `:939-941` | `:564-577` |

*Callers that must know the holder zoo:*
- `window.drop` — three branches (dock / carrel / loose) plus a *fourth* clean-up for
  "dock borrowed it from a carrel" (`windowCommands.js:176-213`, esp. `:190-193`).
- `carrel.add`'s occupancy handoff — two branches (`carrelCommands.js:300-311`).
- The session projector's `held` test — asks the dock, then iterates every carrel
  (`SessionStore.js:103-104`).
- The removal cascade — prunes the dock, then every carrel (`CommandProvider.jsx:533-534`),
  with a bespoke `isLive` that must consult **two id namespaces** (`:531`).
- The carrel sweep — checks `ctx.cameraDock?.has?.(id)` in both passes
  (`carrelCommands.js:215, 239`) and defines `findCarrelOwner` for everyone else (`:52-57`).
- `dock.focus` must read `homeBounds` *before* release drops the entry (`dockCommands.js:118`).

The **borrowed** concept is asymmetric: `Carrel` polls `e.grid.parent !== this` every frame and
hands off (`Carrel.js:566-575`); `CameraDock` has no equivalent. And "loose" is not a state
anywhere — it is the *absence* of two lookups.

**Under ECS.** One component: `Held = {holder, order, home:{parent,pos,scale,quat,bounds}}`, plus a
`Holder` component on dock/carrels declaring a placement strategy. One `Holder` system runs
membership + home capture + contain-fit + slerp; the *geometry* stays pluggable (sphere arc,
cylinder ring, flat wall, BSP pane), because that is the genuine difference. "Loose" becomes the
absence of `Held` — a queryable state, exactly the physicality Ivan asked for.

**Simplifies:** ~350 lines of duplicated holder mechanics → one implementation + two placement
functions; six branch trees above → `holderOf(id)` lookups; `window.drop` collapses to
`release(id, {to: dropPose})` with no `docked ? … : carrel ? … : loose` at all.
**Riskier:** the two `_relayout`s are *not* actually identical — dock reserves slots for framed
panes and draws ghosts (`CameraDock.js:784-893`), carrel bottom-anchors rows and pre-shapes for an
announced complement (`expect()`, `Carrel.js:410-413, 498-510`). Forcing them into one function is
how you get a second system pretending to be one. Unify the RELATIONSHIP; keep the placement
strategies separate and honest.

### LIVE IDS

**Today.** Ids are the spine — and there are **two namespaces**, which is the fracture.
- Registry ids are canonical strings with species/role tags (`SceneRegistry.js:6-17`); holders,
  attention, workspace surfaces, the occlusion culler, and `carrelManifest` all key by them.
- **Agent books are NOT registry entries** — they live in `AgentBooks.lanes`
  (`CommandProvider.jsx:531`: *"a liveness check that only asks the registry would dismiss a seated
  agent book"*). So `isLive` is a two-authority predicate, and `resolveHostable` must try the
  registry, then the lanes, **after stripping an `agent:` prefix** (`carrelCommands.js:87-104`,
  esp. `:90`) — the exact prefix surgery the house law forbids, forced by the split.
- One holdout keys by **index, not id**: `ctx.gridVisualState` is `Map<number, SavedState>`
  (`gridVisualState.js:8, 21-29`), so any registry reorder silently mis-restores.
- `role || type` is a **one-slot tag** (`SceneRegistry.js:6-17`; consumers
  `_pickableTypes = {grid,terminal,frame}` `:44`, `setPickable('volume')`
  `CommandProvider.jsx:435`, `CULL_TAGS = {grid,terminal,frame,agent}` `:516`). An entity cannot be
  two things at once, which is why "docked", "held", "framed", "borrowed" all had to be stored
  *outside* the registry, in the holders.

**Under ECS.** One entity id namespace; a lane becomes an entity carrying a `Book` component;
`role||type` becomes N tag components, so `pickable ∧ cullable ∧ held` is a query rather than three
hand-kept sets. `isLive(id)` becomes `store.has(id)`.

**Simplifies:** deletes the `agent:` prefix strip and the dual-authority `isLive`; makes
`gridVisualState`'s index key an obvious bug rather than a convention; retires three hand-maintained
tag sets.
**Riskier:** id *identity* across a rebuild. `CanvasInteraction.jsx:876-880` explicitly relies on
"a grid id re-pointed to a NEW object" self-healing each frame. A component store that caches
`Object3D` refs in archetype sets must invalidate on re-point, or you get stale-object writes —
the same class of bug as the cached-extent desync both holders already learned from
(`CameraDock.js:100-103`, `Carrel.js:78-82`).

---

## Tick inventory (what runs each frame, and in what order)

**7 `useFrame` sites total** (verified; `simulateCommands.js` and `BoundedObject3D.js` mention it in
comments only):

| # | site | what it drives | ordering note |
|---|---|---|---|
| 1 | `ViewerCamera.jsx:56` | `cameraController.update(delta)` — the 60Hz input integrator (own `SceneContext`) | owns pitch/yaw; stomps any quaternion write (`STATE_ARCHITECTURE.md:134`) |
| 2 | `SceneEnvironment.jsx:110` | environment refs | independent |
| 3 | `CommandProvider.jsx:202` `AgentRunner` | `agentBooks.update(dt)` (`:204`), library volume decks (`:206`) | mounted **before** DockRunner (`:791-792`) — an *accidental* invariant |
| 4 | `CommandProvider.jsx:219` `DockRunner` | dock park+animate (`:222`) → occlusion verdicts (`:224`) → every carrel + dead-carrel sweep (`:228-231`) → tree motion glide, then arrows + label reanchor **only if** it reports active (`:236-239`) → labels approach-fade/hover-grow (`:240`) → warm-up frames (`:241-253`) | the one hand-written dependency chain |
| 5 | `CanvasInteraction.jsx:231` | drag/grip cursor state | — |
| 6 | `CanvasInteraction.jsx:882` | full visual-state reconcile from attention (borders, cursor focus, capture, dir outline, breathing fill) | pure read of attention + registry |
| 7 | `Minimap.jsx:103` (**priority 1**, `:183`) | takes over the render loop while mounted | must stay last |

**Animators / integrators — six, three idioms:**
1. `SpatialAnimator` in `CameraDock` (`:210`) — fixed duration + `easeInOutCubic`.
2. `SpatialAnimator` in **each** `Carrel` (`Carrel.js:154`) — N desks = N animators.
3. `ContentTreeMotion` (`:126-145`) — exponential `1 − e^(−rate·dt)`.
4. `Book.update` per lane (`Book.js:363-368`) — same exponential, separate code.
5. `CameraDock._tickGhosts` (`:747-753`) — sine breathe, deliberately *not* the animator (`:745`).
6. `CanvasInteraction` fill breath (`:63`, ~`:963`) — sine on `state.clock`.

**Intra-frame order is implicit and already inconsistent between the twins:** `CameraDock.update`
refits and `_relayout()`s *before* `animator.update(dt)` (`:934, :937`); `Carrel.update` runs
`animator.update(dt)` first and only then may `_relayout()` on a returning borrowed member
(`:562, :575`) — a one-frame lag the dock does not have. `Carrel` also had to invent a seat-diff
epsilon guard because re-issuing an identical tween restarts its ease (`:449-455`) — an
ordering artefact that a single Motion system with dirty-target semantics removes structurally.

---

## Proposed system inventory

| system | absorbs (today) | notes |
|---|---|---|
| **Motion** | both `SpatialAnimator`s (`CameraDock.js:210`, `Carrel.js:154`), the slerp loops (`CameraDock.js:939-941`, `Carrel.js:564-577`), `ContentTreeMotion` (`:126`), `Book.update` easing (`Book.js:363`) | keys already global (`SpatialAnimator.js:48`); merge is behaviour-identical. Keep the *idioms* (duration-ease vs exponential) as per-tween modes, not as separate engines. |
| **Holder** | `CameraDock._relayout/_animateTile/lock/release/dismiss/pruneDismissed` + `Carrel`'s twins; `reachesScene` ×2; the borrowed guard (`Carrel.js:566-575`) | placement strategy stays pluggable: `dock-dome`, `dock-linear`, `carrel-ring`, `carrel-grid`, `pane-tree`. |
| **Residence/Home** | `homeOf`/`homePosition`/`homeBounds` (`CameraDock.js:345-379`, `Carrel.js:355-365`), the handoff branches (`carrelCommands.js:300-311`), `window.drop`'s triage (`windowCommands.js:176-213`) | home chains residence→residence; the law lives in one place instead of two docblocks. |
| **Projection** | `SessionStore._projectSurfaces` + `_reconcileDock` (`:756-803`), `reconcileWorkspace` (`CommandProvider.jsx:726`) | already an idempotent re-run-on-change system; it just needs component-scoped queries instead of "iterate every surface." |
| **VisualState** | `CanvasInteraction.jsx:882-975` in full | reads `Attention` + `Panel`; writes border flags. Pure. |
| **Overlay/Config** | 157 `settings.js` `apply:` closures, 8 `applyGroupSettings` boot-folds, 6 `setEnabled` twins | see the synchronous-apply caveat under TOGGLES. |
| **Cull/Pick membership** | `syncCullCandidates` (`CommandProvider.jsx:517-524`), `syncVolumeCovers` (`:439-460`), `_pickableTypes` (`SceneRegistry.js:44`) | tag components replace three hand-kept sets. |
| **Lifecycle/Prune** | `onRemoval` (`CommandProvider.jsx:527-545`), `pruneDismissed` ×2, `attention.pruneGone` | one cascade over one namespace. |

**Explicit order** (replaces today's mount-order accident): `Input → Command/mutation drain →
Motion → Holder → Projection → Overlay → VisualState → Cull → Render`. Writing this list down is
itself half the value: today's `AgentRunner`-before-`DockRunner` invariant is undocumented and one
JSX reorder from breaking.

---

## Verb grammar under components

Today four verbs mean "change residence": `dock.lock` / `dock.release` (`dockCommands.js:46,64`),
`carrel.add` / `carrel.release` (`carrelCommands.js:276,323`), `window.pin` (which *composes*
`dock.lock` + `dock.spotlight`, `windowCommands.js:141-153`), `window.drop` (`:166`). Resolution
already forks three ways: `resolveGridByIdOrIndex` (grids only), `resolveSurface`
(`dockCommands.js:22-40`, any surface but refuses carrels), `resolveHostable`
(`carrelCommands.js:87-104`, surfaces *plus* lanes).

Under components: **one pair** — `hold <id> <holder> [order]` / `release <id> [to]` — with holder
named (`dock`, `carrel:agents`, `tree`, `scene`), and **one resolver** (entity id → entity), because
lanes are entities. `window.pin` stays as its own verb (it means "occupy the view-frame", a
`Framed` component, not a holder). `layout.markers|arrows|labels|probes|motion` already share one
factory (`layoutCommands.js:~110-160`) and become `overlay.<name>` over the component table.

*Judgment call for Ivan:* keeping `dock.lock` and `carrel.add` as two registrations onto one
implementation is a naming surface, not a forwarder — but it is close enough to the no-aliases law
(`feedback_no_aliases_atomic_renames`) that it should be an explicit decision, not a default.

---

## Build vs adopt

- **bitECS** — SoA typed arrays, numeric entity ids, tuned for 10⁴–10⁶ numeric components. Our
  components hold `Object3D` refs, `Quaternion`s, `Map`s, unsubscribe closures. It cannot store
  them; we would keep a side `Map` anyway and pay the integration for nothing. **No.**
- **miniplex** — object components, JS-native, tiny, and (the actually valuable part) **reactive
  archetype queries** — `onEntityAdded`/`onEntityRemoved` per archetype, which is precisely the
  mechanism the 13 registry listeners and the 150ms HUD poll are hand-rolling. A genuine candidate.
- **Homegrown (~200–300 lines)** — `Map<id, Map<name, value>>` + incrementally-maintained archetype
  `Set`s + an ordered system list.

**Call: homegrown, grown out of `SceneRegistry`, stealing miniplex's reactive-archetype API shape.**
The house law is to lean on mature tooling for *hard, well-solved* layers (LSP, protocols, shaping).
Component storage at 10³ entities is not hard; our *domain semantics* (home chaining, borrowed
guards, derived-vs-stored positions) are the hard part and no library knows them. Decisive factor:
`cannibalize existing infra` — the registry already has the table, the reverse index, the archetype
cache and the batching window. Adding miniplex would create the second system the house forbids.

---

## Migration riverbed

Each slice is atomic (no dual paths), verified by a headless bus-driven harness in the existing
`tools/*-check.mjs` style, and lands standalone.

- **Slice −1 — delete `GridVirtualizer`** (`collections/GridVirtualizer.js`, its barrel exports,
  and `tools/carrel.test.mjs:271`'s use). It is dead, and it is the third holder every later slice
  would otherwise have to model. *Pure subtraction; lowest possible risk.*
- **Slice 0 — the Holder PROTOCOL (recommended FIRST; not yet ECS).** `ctx.holders` as a
  registry of holder objects (the dock joins; each carrel joins on create/restore), plus
  `holderOf(id)`. Deletes: `window.drop`'s triage (`windowCommands.js:176-213`),
  `findCarrelOwner` (`carrelCommands.js:52-57`), the `held` scan (`SessionStore.js:103-104`),
  the double prune (`CommandProvider.jsx:533-534`), the two dock-checks in the sweep
  (`carrelCommands.js:215,239`), the handoff branch (`:300-311`). ~40 lines added, six branch
  trees removed, **zero per-frame behaviour change** — the safest possible proof of the thesis.
- **Slice 1 — Motion.** One `SpatialAnimator` owned by the frame loop; dock, carrels,
  `ContentTreeMotion` and `Book` push tweens into it. Behaviour-identical by construction
  (`SpatialAnimator.js:48`). Retires `Carrel`'s seat-diff epsilon hack (`:449-455`) in favour of
  target-equality in the animator. Also fixes the twins' inconsistent intra-frame order.
- **Slice 2 — component-change events on `SceneRegistry`.** `_fire(type)` →
  `_fire({type, id, component, op})`, archetype sets maintained on write, `holdChanges` unchanged.
  Kills `HudPanel.jsx:78`'s poll and turns the 13 full re-scans into targeted callbacks.
- **Slice 3 — `Held` component + `Holder` system.** The real collapse. Touches persistence
  (`SessionStore` `dock3d` + `carrels` sections), so a schema bump rides along — do it *after*
  Slice 0 has already proved the call sites are branch-free.
- **Slice 4 — Overlay/Config as components.** 157 `apply:` closures → declarative records; the 8
  boot-folds vanish. Gated on resolving the synchronous-apply requirement.
- **Slice 5 — VisualState system.** `CanvasInteraction.jsx:882-975` moves out of a React component
  into a plain system function. Mostly mechanical once Slice 2 exists.

---

## Honest cost

- **Net lines:** roughly −350 to −500 (holder duplication, branch trees, settings closures) against
  +250–300 (store, archetypes, system runner, ordering). The *first* net-negative slice is 3, not 0.
- **Explicit ordering is a new obligation.** Today's order is partly accidental
  (`AgentRunner` before `DockRunner`, `CommandProvider.jsx:791-792`). Writing it down surfaces
  invariants nobody has verified; expect one or two one-frame stutters during Slice 1–3 — exactly
  the class of bug `Carrel.js:449-455` documents.
- **Per-frame allocation is the real perf trap**, not dispatch. A naive `query(...)` that allocates
  an array per system per frame at 60fps is GC churn. Archetype sets must be maintained
  incrementally on write — that is where the +100 lines go.
- **Perf at the render layer: neutral.** The window entity count is 10¹–10³; a Map-of-Maps store is
  µs-scale. The measured stress limit is field-count × GPU objects, untouched by this.
- **Debuggability regresses before it improves.** `CameraDock.update` is one readable function
  today; systems spread it. Mitigation: one file per system, and the bus already gives
  `log.query`/`log.search` observability for free.
- **HMR: net win.** Systems are plain functions with no instance state, so a hot swap re-imports
  cleanly; the store lives on `ctx`, which already survives (`ctx._sessionRestored`,
  `SessionStore.js:829-837`). Today's `[relay]`-keyed effect and the one-shot VCC bridge
  (`STATE_ARCHITECTURE.md:136`) are exactly the fragility a store-on-ctx removes.

---

## What NOT to convert

1. **Per-glyph anything.** Instance attributes in one `Float32Array`, one instanced draw. Already
   optimal; an ECS over glyphs would be a strict regression.
2. **`CodeGrid`'s internal `_relayout`** (staged fold→arrange→bounds→decorate) and the edit path.
   Internal pipeline, single owner, no cross-cutting duplication.
3. **`TerminalEmulator` / the PTY stream.** The relay owns the process; the stream is the only
   writer of terminal size. Not a component; an external child.
4. **`ViewerCameraController`.** A continuous 60Hz integrator that owns pitch/yaw and stomps
   quaternion writes (`STATE_ARCHITECTURE.md:134-135`). Model it as *one* system boundary and leave
   its insides alone.
5. **`PaneTree`.** A BSP tree with real structure (`split`/`close`/`neighbor`/`resize`); it is a
   data structure the frame system *uses*, not a component set.
6. **The picking ID pass.** Channels with layers and first-fit ID spaces
   (`PickingSystem.js:74, 585+`) are already the right abstraction; only *membership* (who is
   pickable) becomes a tag component.
7. **`GridVirtualizer`.** Not "don't convert" — **delete** (see Slice −1).

---

## The one-line version

The system Ivan is describing already exists in fragments: `SceneRegistry` is the entity table,
`view` facts are components, the session projector is an idempotent system, and `registerOverlay`
is a component verb. What is missing is a **holder protocol**, a **single motion tick**, and a
**change event that names what changed** — and those three are worth doing whether or not the word
"ECS" ever appears in the codebase.

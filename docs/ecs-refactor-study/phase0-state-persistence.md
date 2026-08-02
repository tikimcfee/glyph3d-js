# Phase 0 — ECS through the STATE / PERSISTENCE / IDENTITY lens

Agent: `state-persistence`. Repo state: working tree at 4b7c994 + the live `window.drop`/zoom edits.
Everything below is verified against the code; every claim carries a `file:line`.

---

## Conclusions first

1. **The system is already an ECS with the component table inlined into one anonymous blob.**
   `WorkspaceModel.surfaces: Map<id, {kind, view}>` (`WorkspaceModel.js:38`) is a component store with
   exactly one component (`view`), and `setSurfaceView(id, kind, patch)` (`:152-163`) is already a
   per-key, change-detecting, event-emitting component writer. `applyView` on both grid classes
   (`TerminalGrid.js:653`, `CodeGrid.js:1119`) is already a guarded, absolute, idempotent *system
   apply*. The ECS refactor here is not new machinery — it is **naming the fields inside `view`**.

2. **The pop-back bug family is not a bug class, it is the station count.** Every spatial/visual
   fact today needs up to **eight hand-written stations** (writer · capture · restore · projector ·
   held-guard · holder re-apply · derived-ness policy · external-child bridge). Miss one and you get
   a specific, named failure: miss the writer → pop-back (`window.drop`, fixed at
   `windowCommands.js:217`); miss the holder re-apply → zoom lost on reload (fixed at
   `SessionStore.js:110-112`); miss the derived-ness policy → a dropped grid re-seats into the
   layout scheme (`positionIsDerived`, `SessionStore.js:85`, still open). **Components collapse the
   eight stations to two** — a schema entry and an apply function.

3. **Three facts are provably broken *right now*, and each is a missing station** (§2 evidence):
   - `view.carrel` has **zero readers** — written at `carrelCommands.js:61` from six sites, never
     captured, never projected. Carrel membership actually persists through a *parallel* pipeline
     (`Carrel.serialize()` `Carrel.js:687` → `carrelManifest` `SessionStore.js:493` → `serveManifest`
     `carrelCommands.js:207`). The dock and the carrel are the same relationship implemented twice
     with **opposite authority**: dock capture reads the MODEL (`SessionStore.js:256`), carrel
     capture reads the LIVE OBJECT (`:287`).
   - `file.open`'s `[x y z]` args are **captured** (`SessionStore.js:181`), **replayed**
     (`:626`), and **never consumed** — `file.open` (`fileCommands.js:92-155`) reads only `args[0]`.
     A code grid's position has a capture station and a restore station and no applier.
   - `grid.move` (`gridCommands.js:271-289`) moves a grid and **never writes the model** — movers'
     law violated at the one verb whose entire job is moving. `window.drop` on a code grid *does*
     write `position` (`windowCommands.js:217`), but capture skips non-terminal surfaces
     (`SessionStore.js:221`) so the fact is written to a buffer nothing serializes.

4. **What ECS buys, concretely:** residence becomes explicit (`Residence{kind, holder, order}`),
   derived-vs-stored becomes a per-component policy (`Position{authority:'layout'|'intent'}`)
   instead of a global membership test, and the projection loop stops being
   *"re-push every fact of every surface on every registry event"* (`SessionStore.js:155,756-766`)
   — which is precisely the amplifier that turns one stale fact into a visible teleport.

5. **What ECS does not buy:** it does not remove the push-onto-three.js step
   (`STATE_ARCHITECTURE.md:25-40` is right about this), it does not make async re-adoption ordering
   go away (idempotent-apply-on-change already solved that), and at ~tens of surfaces it buys **no
   measurable throughput**. The win is *correctness by construction* and *station count*, not speed.
   Anyone selling ECS here on performance is selling the wrong thing.

---

## §1 — Ivan's four nouns, concretely

### TOGGLES

**Today.** A toggle is an ad-hoc boolean living wherever its author put it:
`view.docked` (`dockCommands.js:59`), `view.pinAutoDocked` (`windowCommands.js:147`),
`lane.pinned`/`a.following` (`SessionStore.js:274-279`), `_visible` (`TerminalGrid.js:~677`),
`_captured` (`AttentionManager.js:71`), `isWindowed()`/`frameRows>0` (`CodeGrid.js`), occlusion
visibility (`CommandProvider.jsx:511-524`). Nothing marks which ones are durable. Proof:
`pinAutoDocked` lives *in the durable buffer* and is **never serialized** — capture emits only
`{id,x,y,z,cols,rows,zoom}` (`SessionStore.js:223-229`). You cannot tell by reading the write site
whether a toggle survives reload.

**Under ECS.** A toggle is *presence of a tag component*, and durability is a property of the
component's schema, declared once: `Docked{order, by:'user'|'pin'}` present ⇒ docked; the
`pinAutoDocked` back-channel disappears into `by`, provenance carried on the component that already
had to exist. `Pinned{}`, `Windowed{cols,rows,firstLine}`, `Framed{rows}` likewise.

**Simplifies (measurable).** The pin/unpin dance (`windowCommands.js:141-154`) currently
reads-back its own bookkeeping flag through the model to decide whether to send the window home;
with `Docked{by}` that is one read of the component being removed. `capture()`'s per-field `if
(Number.isFinite(...))` ladder (`:224-229`) becomes "serialize components whose schema says
durable".

**Riskier.** Tag components tempt you to make *everything* a component, including things that are
genuinely one-per-world (attention slots). And "absence means false" changes the migration story:
today a missing key defaults via a guard; with components you must decide whether absence means
"off" or "unknown" — for forward-additive restore (`SessionStore.js:61-68`) it must mean **off**.

### LIVE UPDATES

**Today.** One coarse event drives everything: `registry.addChangeListener`. Live subscriber count
≥ 10 — `CommandProvider.jsx:523,545,727,739`, `CanvasInteraction.jsx:124`, `HudPanel.jsx:77`,
`FileTree.jsx:257`, `TerminalsPanel.jsx:96,159`, `RepoPanel.jsx:89`, `EditorPanel.jsx:104`, plus
`SessionStore._onRegistryChange` (`:155`). That last one runs `_projectSurfaces()` — an O(surfaces)
sweep re-pushing **every fact of every surface** (`:756-766`) — on *any* registration anywhere.
`SceneRegistry.holdChanges/flushHeld` (`:364-391`) exists specifically because that fan-out is
O(N) per registration and a bulk load made it O(N²).

That sweep is the pop-back amplifier: because it re-asserts facts that *did not change*, one stale
fact becomes a visible teleport at the next unrelated registration.

**Under ECS.** Change granularity moves from "the registry changed" to "these components changed".
A projector iterates the **changed set**, not all surfaces; a system declares the components it
reads and wakes only for those. The pop-back failure mode becomes structurally impossible: a fact
that was never written is never re-asserted.

**Simplifies.** `_projectSurfaces` + `_reconcileDock` (`SessionStore.js:756-803`) become one
generic "for each dirty component, run its apply system". The `held` computation
(`SessionStore.js:103-105`) — which today walks *every carrel* on *every projection of every
surface* — becomes a component read.

**Riskier.** Dirty-tracking is machinery with its own bugs (missed invalidation is silent; the
current "re-push everything" is at least self-healing). And the always-on projector's *virtue* —
"an entity arriving in ANY lane is projected the moment it registers" (`SessionStore.js:22-26`) —
must be preserved: a re-adopting PTY is a **new entity with old components**, so the arrival event
must mark its components dirty even though nothing wrote them.

### RELATIONSHIPS

**Today.** "Who holds this window" is expressed **six** ways, none of them the relationship:
scene-graph parent (`grid.parent`, `windowCommands.js:203`), holder membership
(`CameraDock.entries` / `Carrel.entries` `Carrel.js:232`), a view fact (`view.docked` /
`view.carrel`), an array index that becomes an order (`dock3d.tiles` → `dockOrder`
`SessionStore.js:676-681`), a pending-claim map (`carrelManifest` `:493`), and a *tree membership
test* standing in for residence (`positionIsDerived` `:85`). The `homeOf` handoff law
(`carrelCommands.js:298-308`, `Carrel.js:355`) exists **only because** none of the six is
authoritative — handoff has to chain records manually so home never points at a vehicle.

The two holders are literal twins with divergent authority: `dock.lock/release/homeOf/
pruneDismissed` vs `carrel.lock/release/homeOf/pruneDismissed`; dock persists through the model,
carrel persists through its own `serialize()` + a bespoke pending queue.

**Under ECS.** One component: `Residence{kind:'dock'|'carrel'|'tree'|'loose', holder, order, home}`.
Every question above becomes a read of it. The manifest disappears — an unserved claim *is*
`Residence` on an entity that isn't live yet, which is exactly what the durable buffer already
does for docked terminals (`SessionStore.js:770-775` says this in prose about the dock, and then
the carrel path re-implements it as a Map anyway).

**This is the direct answer to Ivan's third hole.** "Dropped/loose wants to be a residence STATE"
is `Residence{kind:'loose'}` + `Position{authority:'intent'}`, written by one verb. `positionIsDerived`
(a *global* test against `ContentTree.has`) becomes a *per-entity* policy that the drop transition
flips — and the layout system simply skips entities whose Position authority isn't `'layout'`.

**Riskier.** A single relationship component invites a single generic holder system, and the two
holders are *not* identical (camera-anchored vs world-anchored; the dock owns a root view-frame
`windowCommands.js:118-164`). Over-unifying them re-creates the "one abstraction, two behaviours
behind flags" smell the house laws forbid. The honest form is one *component*, two *systems*.

### LIVE IDS

**Today.** Identity is already good: the registry id is the universal join key — model surfaces are
"keyed by the REGISTRY id" (`WorkspaceModel.js:35-38`), dock/carrel entries, the manifest, attention
slots, and the session file all key on it, and ids are content-derived and stable across re-adoption
(a terminal's PTY re-adopt reuses `term-N`; a file's id is its canonical path). `SceneRegistry`'s
`type` (species) vs `role` (presentation) split (`SceneRegistry.js:1-18`) is already ECS-shaped: the
machinery keys on `role||type` (`:87`), which is an archetype tag in all but name.

**Two id-space leaks.** (a) Agent lanes are **not** registry entries, so liveness needs a two-source
union: `isLive = registry.has(id) || agentBooks.lanes.has(id)` (`CommandProvider.jsx:530`), and
`resolveHostable` has to try both (`carrelCommands.js:96-102`). (b) Carrels register as
`carrel:<name>` but `resolveSurface` refuses them (`dockCommands.js:27`) — a place, not cargo —
which is a *component* distinction ("has Residence-capacity, lacks Holdable") smuggled into a
resolver string test.

**Under ECS.** One entity space, one liveness predicate; agent lanes become entities and the union
disappears; "is this cargo or a place" is `has(Holdable)` vs `has(Holder)`.

**Riskier — the one thing that must not change.** Many ECS libraries use *generational integer*
entity handles. That would **break re-adoption**: the durable buffer works precisely because
`term-1`'s components survive the death and rebirth of its live object. Rule: the string id stays
the durable identity forever; any integer handle is a runtime index only.

---

## §2 — The station table (the evidence)

A fact survives reload only if every station it needs exists. Missing station = a named bug.

| Fact | Writers | Capture | Restore | Projector | Held-guard | Holder re-apply | Derived policy | Ext. child | Stations |
|---|---|---|---|---|---|---|---|---|---|
| **position** (terminal) | `terminalCommands.js:485,184`, `windowCommands.js:217`, `CanvasInteraction.jsx:476` | `SessionStore.js:224` | `:663` | `TerminalGrid.js:653` | `:103-105` + `skipPosition` | dock/carrel own transform | `:85` | — | **7** |
| **position** (code grid) | `windowCommands.js:217` only — ✗ `gridCommands.js:271` | `:180-181` (live scrape, dock-home special case) | `:626` (`file.open x y z`) | **✗ none** (`fileCommands.js:92` ignores args 1-3) | n/a | n/a | `:85` | — | **3 of 7, 2 dead** |
| **zoom** | `windowCommands.js:109` + `dock.reflowTile` `:104` | `:229` (loose) **and** `:258` (docked) — two shapes | `:665` and `:680` | `:110-112` (loose only) | `!held` `:110` | `_reconcileDock:792` | — | — | **6** |
| **cols/rows** | `terminalCommands.js:257,184` | `:225` | `:664` | `TerminalGrid.js:653` | — | — | — | PTY push `:116-123` | **5** |
| **docked / order** | `dockCommands.js:59,70,81,86,119,147`, `windowCommands.js:147,186`, `carrelCommands.js:303` | `:256-262` (from MODEL) | `:671-681` | `_reconcileDock:776-803` | — | additive-only, never releases | — | — | **5** |
| **carrel seat** | `carrelCommands.js:61` (×6 sites) | **✗ model unused** — `Carrel.js:687` scrape | `:490-500` → `carrelManifest` | `carrelCommands.js:207-227` (separate loop) | `:104` | sweep re-offer `CommandProvider.jsx:543` | — | — | **parallel set of 5** |
| **pinAutoDocked** | `windowCommands.js:147,151` | **✗ none** | ✗ | ✗ | — | — | — | — | in-memory only |
| **fold / layout mode** | `grid.layout` verb | **✗ none** (`STATE_ARCHITECTURE.md:93`) | ✗ | ✗ | — | — | — | — | **0 — resets on reload** |

Zoom's row is the cleanest proof of the thesis: **one fact, two persisted representations split by
holder** (`terminals[].zoom` vs `dock3d.tiles[].zoom`), each with its own restore branch and its own
applier — and the loose branch simply did not exist until commit ae7992b threaded it by hand. That
is the "third per-field plumbing job" Ivan named, visible in the diff.

---

## §3 — fact → component mapping

| Today | Component | Fields | Authority | Durable? |
|---|---|---|---|---|
| `view.position` + `positionIsDerived` | `Position` | `{x,y,z, authority:'layout'\|'intent'\|'holder'}` | layout system / verb / holder | iff `authority==='intent'` |
| `grid.quaternion` (drop billboard, `windowCommands.js:208`) | `Orientation` | `{quat, authority}` | same | iff intent |
| `ScaleModel.user` (`ScaleModel.js:40`) | `Zoom` | `{factor}` (uniform) or `{x,y,z}` | verb | **yes** |
| `ScaleModel.placement` | — | derived (`home XOR holder fit`) | system | **no** |
| `view.cols/rows` | `TerminalGeometry` | `{cols,rows}` | PTY stream (`terminal_control` law) | **yes** |
| `view.window/frameRows/scrollOffset` | `Viewport` | `{cols,rows,firstLine,frameRows,scrollOffset}` | verb | **yes** |
| `CodeGrid.config.layout` | `Fold` | `LayoutParams` | verb | **yes** (gap today) |
| `view.docked`+`dockOrder` / `view.carrel` / tree membership | `Residence` | `{kind, holder, order, home}` | verb | **yes** |
| `view.pinAutoDocked` | (folded into `Residence.by`) | — | verb | yes, free |
| `CameraDock.focusedPane` (`SessionStore.js:261`) | `Framed` (singleton relation) | `{entity}` | verb | **yes** |
| `AgentBooks` head/following/limit (`:274-279`) | `BookView` | `{head, following, limit}` | verb | **yes** |
| `Carrel` pose + knobs (`Carrel.js:687`) | `HolderConfig` + `Position` | — | verb | **yes** |
| hover / caret mesh / cull visibility / in-flight tween | *no component* — runtime | — | — | **never** |
| `attention.{primary,key}` | world singleton, not per-entity | — | one writer | **yes** (`field.focus`) |

Rule of thumb that falls out: **a component is durable iff a human gesture can set it and nothing
recomputes it.** That is exactly `STATE_ARCHITECTURE.md:48-77`'s "store inputs, not outputs" — ECS
just gives it a place to live other than a doc comment.

---

## §4 — what the projection loop becomes

Today (`SessionStore.js:155,756-803`):

```
registry.onChange → _projectSurfaces()
    for EVERY surface: if live → SURFACE_PROJECTORS[kind](store, s, grid)   // per-KIND
                        (each projector re-derives `held` by walking every carrel)
    then _reconcileDock(): for EVERY docked surface: lock if not a tile, re-apply zoom, re-raise pin
```

Under components:

```
onEntityLive(id)      → mark all of that entity's components dirty          // the re-adopt case
onComponentWrite(...)  → mark that component dirty                          // the verb case
tick/flush:
    for each dirty (entity, component):
        SYSTEMS[component].apply(entity, component, world)                   // per-COMPONENT
```

Three properties change, and each kills a live bug class:

1. **Per-component, not per-kind.** `SURFACE_PROJECTORS` (`:97`) is keyed by `kind` and therefore
   has exactly one entry, `terminal` — which is *why* a dropped code grid has no applier. Keyed by
   component, `Position.apply` serves grids, terminals, books and desks the day it is written.
2. **Only what changed is asserted.** No unsolicited re-push ⇒ no pop-back from a stale fact.
3. **Holder-awareness moves into the data.** `Position.authority === 'holder'` replaces
   the `held` walk (`:103-105`) and `skipPosition`; the holder system writes the transform, the
   position system stays out.

`SceneRegistry.holdChanges/flushHeld` (`:364-391`) is already the commit barrier this loop wants —
it should become the world's flush, not a registry-local trick.

---

## §5 — persistence policy per component

- **Durable** (`Position{authority:'intent'}`, `Zoom`, `TerminalGeometry`, `Viewport`, `Fold`,
  `Residence`, `BookView`, `HolderConfig`) → serialized by one generic loop over components whose
  schema declares `durable: true`. This replaces capture's eight bespoke sections
  (`SessionStore.js:160-315`) with one walk plus per-component `toJSON`.
- **Derived** (`ScaleModel.placement`, dock slot integer, `LayoutDescription`, bounds, `_modified`)
  → never written, recomputed by their system. Same list as `STATE_ARCHITECTURE.md:73`.
- **Ephemeral** (hover, caret mesh, tweens, cull visibility, PTY handle, relayout mutex) → not
  components at all; runtime fields on the live object.
- **Quarantine** (`SessionStore.js:308-313`) survives unchanged and gets *better*: today a failed
  phase quarantines a whole snapshot key; with components it quarantines exactly the components
  whose apply failed.
- **Forward-additive** (`:61-68`) survives unchanged, and is why the file shape must change **last**
  (see §7).

---

## §6 — migration riverbed: what is already fact-shaped

Nothing here needs inventing. The following are components/systems wearing other names:

| Already exists | Is really |
|---|---|
| `WorkspaceModel.surfaces` Map keyed by registry id (`:38`) | the component store |
| `setSurfaceView(id, kind, patch)` with per-key diffing + `change:surfaces` (`:152-163`) | the component write API with change events |
| `TerminalGrid.applyView` / `CodeGrid.applyView` — guarded, absolute, idempotent | per-component apply systems, pre-written |
| `SURFACE_PROJECTORS` table (`SessionStore.js:97`) | the system registry (mis-keyed by kind) |
| `SceneRegistry` `type`/`role`, machinery keys on `role||type` (`:1-18,87`) | archetype tags |
| `holdChanges` / `flushHeld` (`:364-391`) | the commit barrier / flush |
| load-is-not-replay (`STATE_ARCHITECTURE.md:20,43`) | ECS persistence law |
| `positionIsDerived` (`:85`) | `Position.authority`, computed globally instead of stored |
| `carrelManifest` (`:493`) | `Residence` on a not-yet-live entity |
| `ContentTree` partitionChildren / leaf positions | the layout system, already a system |

**Slice order that respects no-compat-shims** (each slice moves one fact's copies and deletes the
old ones in the same change — the `STATE_ARCHITECTURE.md:120-129` discipline, unchanged):

- **A. Name the components, keep the file shape.** Split `view` into named component objects
  in-memory; `capture()`/`restore()` still read/write today's `terminals[]`/`dock3d`/`files[]`
  blobs. Zero schema risk, and it is the change that makes B possible.
- **B. `Residence`.** Collapse `view.docked`+`dockOrder`+`view.carrel`+`carrelManifest` into one
  component; delete the dead `view.carrel` writes (`carrelCommands.js:61`) *or* make them the
  authority and delete the `Carrel.serialize().members` scrape — **not both paths**. This is the
  single biggest station deletion available and it closes the dock/carrel authority split.
- **C. `Position{authority}`.** Delete `positionIsDerived`; give the layout system an authority
  check; add the missing model write to `grid.move` (`gridCommands.js:271`); delete `file.open`'s
  never-consumed `[x y z]` (`fileCommands.js:92`) and the capture that feeds it
  (`SessionStore.js:181`, `:626`). Fixes Ivan's third hole and one dead station in the same change.
- **D. Component-keyed projector.** Rewrite `_projectSurfaces` as the dirty-component loop; fold
  `_reconcileDock` into the `Residence` system.
- **E. Only then, the file shape.** Serialize components generically, bump `SCHEMA_VERSION` to 3
  with the forward-additive reader intact.

---

## §7 — honest cost, and what NOT to convert

**Cost.** Slices A–D touch `WorkspaceModel`, `SessionStore`, five handler files, and the two
`applyView` methods; they do **not** touch the renderer, the atlas, the shaders, or the layout
kernels. The headless harnesses that already exist (`tools/dock-persist-check.mjs`,
`term-geom-persist-check.mjs`, `codegrid-view-persist-check.mjs`,
`session-schema-tolerance-check.mjs`) assert exactly the invariants each slice must preserve —
they are the safety net, and they are already written. That is unusually cheap for a refactor of
this reach. The real cost is **conceptual**: a component world is a second vocabulary next to
`Object3D`, and every contributor must hold "component = intent, Object3D = projection" as hard as
they hold movers' law today.

**Named risks.**
- *Schema migration.* Forward-additive restore (`:61-68`) protects reads, not writes. Do not
  reshape the file in the same slice as the memory model (hence §6 step E last). A v3 blob read by
  a rolled-back v2 build must still restore *something* — components must serialize into
  additively-named keys, not a reshaped `terminals[]`.
- *The mirror boundary.* three.js still owns transforms. If a component ever becomes a second live
  transform authority, we have built the drift-scanner `SessionStore.js:94` explicitly warns against.
- *Async re-adoption.* Already solved by idempotent apply + re-run-on-change; the new loop must
  keep the "entity arrives ⇒ all its components dirty" rule or re-adopted terminals go blank.
- *HMR / scene generation.* Restore is keyed on `ctx._sessionRestored` (`:836`) because a vite hot
  swap rebuilds participants mid-life. A component world needs the same generation key, or a hot
  swap re-applies a stale world over a live one.
- *Over-unification.* The dock and the carrel share a component, not a class. `window.pin`'s
  root-view-frame behaviour (`windowCommands.js:118-164`) is genuinely dock-only.

**Do NOT convert:** three.js transforms and the scene graph; the glyph instance buffers and atlas
metrics; the emulator/PTY (an external child by definition, `STATE_ARCHITECTURE.md:79-81`); the
camera integrator (60Hz, owns pitch/yaw, stomps anything that writes the quaternion — `:134`);
`AttentionManager`'s three slots (world singletons with a one-writer invariant, cheaper as slots
than as per-entity tags — and `AttentionManager.docks` `:78` should simply be **deleted**, it is a
vestigial fourth copy of dock membership that was never populated); the dockview 2D layout blob
(a foreign schema we round-trip verbatim, `:238-248`).

**One-line answer to the commission, from this lens:** the toggles, live updates, relationships and
live IDs are begging for ECS because each of them is currently a *fact without a home* — and this
codebase already built the home (`WorkspaceModel.surfaces` + `applyView` + `holdChanges` +
load-is-not-replay) and then kept writing facts around it by hand.

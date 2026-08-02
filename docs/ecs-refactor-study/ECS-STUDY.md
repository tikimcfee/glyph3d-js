# ECS in glyph3d-js — what it would actually simplify

**A three-lens cross-referenced design study.** Commissioned 2026-08-02 by Ivan Lugo:
*"How an ECS refactor would actually simplify and empower our system. Everything we have almost
seems to be begging for it — toggles, live updates, relationships, live IDs."*

Three agents worked independently (entity/substrate · systems/runtime · state/persistence), then
cross-reviewed each other twice adversarially and converged. Every number below is the **re-measured**
one; every Phase 0 headline that did not survive measurement is marked as superseded. No code was
changed.

> **Citation drift.** The tree was live during the study — `SessionStore.js` 879→891 lines,
> `CommandProvider.jsx` 796→805. All line numbers here were re-verified at authoring time, but
> **re-grep by symbol before editing.**

---

## 1. Executive summary

**ECS here does not mean adopting an ECS.** It means naming five things the codebase already built
and then stopped generalizing:

| Already exists | Is really |
|---|---|
| `SceneRegistry` — `{id, grid, type, role, meta}`, `role\|\|type` tag, incremental `_pickable` index | the **live** entity table with an archetype tag |
| `WorkspaceModel.surfaces[id].view` — sparse, id-keyed, per-key change-diffed (`:152-163`) | the **durable** component store |
| `TerminalGrid.applyView` (`:653`) / `CodeGrid.applyView` (`:1119`) — guarded, absolute, idempotent | per-component **apply systems** |
| `SURFACE_PROJECTORS` (`SessionStore.js:97`) — *"adding a surface kind = adding a projector here"* | the **system registry** |
| `SceneRegistry.holdChanges` / `flushHeld` (`:364-391`) | the **commit barrier** |

**What it buys.** Every new spatial or visual property today needs up to **eight hand-written
stations** — a writer, a capture branch, a restore branch, a projector, a held-guard, a holder
re-apply, a derived-ness policy, an external-child bridge. Miss one and you get a *named* bug, and
this study found nine of them sitting in the tree right now. Components collapse eight stations to
**two**: a schema entry and an apply function. That is the entire thesis, and it is measurable —
the study's global acceptance test is *a component is done when its stations collapse from N to 2.*

**What it costs.** No performance win — none, at 10¹–10³ window entities with hot paths already flat
typed arrays inside one entity. A second vocabulary next to `Object3D` that every contributor must
hold. And one genuinely hard design decision (§3, Law 2) that must be written down before a line is
touched.

**Verdict: do it, as a sequence of subtractions, not as a refactor.** The first three steps delete
~600 lines and close nine live bugs *before* any component exists. If those land and the tree feels
better, the component work is a small, obvious continuation. If they don't, you've still deleted 600
lines and fixed nine bugs. There is no step in this plan whose value depends on the next step
happening.

**Highest-value single action, independent of everything else:** `view.carrel` is written from six
sites and **read by nobody** (`carrelCommands.js:61`). The dock persists residence through the model
(`SessionStore.js:256`); the carrel persists the same relationship through a parallel live-object
scrape (`:287` → `Carrel.serialize()` → `carrelManifest` → `serveManifest`). Two working pipelines
for one fact, with opposite authority. Closing that fork is prerequisite to any component that claims
to own residence — and it is worth doing on its own merits this week.

---

## 2. What the study found

### 2a. Nine live bugs — all shippable today, none needing ECS

1. **`grid.move` moves without persisting** — `gridCommands.js:271-289` sets the transform, writes no
   model fact, schedules no save. Movers' law violated at the one verb whose entire job is moving.
2. **`file.open`'s `[x y z]` is a dead round-trip.** Capture writes it (`SessionStore.js:180-181`),
   restore replays it (`:638`), the usage string advertises it (`fileCommands.js:92`) — and the
   handler reads only `args[0]`. Worse: `openSheet` has three callers (`fileCommands.js:98`,
   `workspaceCommands.js:25,102`) and **none is `file.openDir`**, so a bulk-loaded tree grid has no
   sheet, is absent from `files[]`, and has *no* position authority at all. That is exactly the
   dropped-file-grid case that re-seats itself on reload.
3. **`view.carrel`: ~20 writes, zero readers** (`carrelCommands.js:61`). See §1.
4. **`positionIsDerived` has zero production callers.** Only its export (`SessionStore.js:85`) and
   `tools/dock-persist-check.mjs:11,161-164`. Its own docstring (`:82`) calls it *"the one subtle
   discriminator the projection and capture paths share"* — neither path calls it.
   `STATE_ARCHITECTURE.md:82,135` documents it as load-bearing; it is dead.
5. **`setWorldPosition` is a dead alias used as a live capability gate.** `TerminalGrid.js:633-635`
   and `FrameGrid.js:372-374` are pure `position.set` — `setGroupOffset` is never called from either
   — yet `ViewerCameraController.placeInView` (`:1068`) hard-refuses any object lacking it. **A
   `CodeGrid` can never be placed in view**, silently, by the one method whose docstring says
   *"grid / terminal"* — and it is the exact method bug 2's dead coordinates would need.
6. **`pinAutoDocked` lives in the durable buffer and is never serialized** (`windowCommands.js:147,151`;
   capture emits only `{id,x,y,z,cols,rows,zoom}`). You cannot tell from the write site whether a
   toggle survives reload.
7. **`CodeGrid.config.layout` (the fold) has zero persistence stations** — it resets to default on
   every reload.
8. **A loose code grid's zoom is written to the model and never serialized** — capture's
   `kind !== 'terminal'` skip (`SessionStore.js:221`). Zoom persists in *two shapes split by holder*:
   `terminals[].zoom` (`:229`) and `dock3d.tiles[].zoom` (`:258`).
9. **`ctx.gridVisualState` is keyed by grid index** (`gridVisualState.js:20-62`, resolved via
   `ctx.getGrids()[i]`) — any registry reorder silently mis-restores.

Two more, latent rather than live:

10. **`AttentionManager.docks` is a redundant projection of `CameraDock.entries`** — but it is
    populated (`CameraDock.js:483-487`), deleted (`:532,:572`), mutated every relayout
    (`:687,:847,:875`), read into the state dump (`AttentionManager.js:223` → `attention.info`,
    `attentionCommands.js:94`) and asserted by two harnesses (`dock-dismiss-check.mjs:47`,
    `dock-refresh-check.mjs:205`). Its own docstring (`AttentionManager.js:75-78`, *"stubbed empty
    until L2 lands"*) is stale. Delete it — atomically with those four, not as free subtraction.
11. **`SpatialAnimator.dispose()` is a global `_active.clear()`** (`:182-184`) called from a *live*
    path — `CommandProvider.jsx:230` disposes any carrel that finished dissolving. Harmless today
    (one animator per holder); the moment they merge, one desk folding cancels every in-flight tween
    in the application.

### 2b. Corrected numbers of record

Every Phase 0 headline that moved. **Use these, not the originals.**

- **Holder duplication — publish the ladder, not a number.** `Carrel.js` non-comment lines matching
  any `CameraDock.js` line: byte-identical including indentation **159 (40.9%)**; strip-identical
  **170 (43.7%)**; >3 chars **117 (30.1%)**; >20 chars **73 (18.8%)**; >30 chars **43 (11.1%)**.
  The honest band is **19–30%**, not the 44% first reported. The *shape* survived measurement: the
  identical lines concentrate in `lock`/`release`/`dismiss`/`homeOf`/`pruneDismissed`/`_userOf`/
  `reachesScene` — membership and home — and almost none in `_relayout`, where the twins legitimately
  differ. That is precisely why the answer is a shared **component**, not a shared base class.
- **`reachesScene` is byte-identical** (`CameraDock.js:91-98` ≡ `Carrel.js:69-76`).
  **`extentFromBox` is not**, and the divergence is deliberate and documented: the carrel returns an
  extra `w` because *"Width is the plain box span — anchor-agnostic, unlike the dock's 2·|cx| form,
  which assumes top-left-anchored content"* (`Carrel.js:78-82`), consumed as `ext.w`
  (`Carrel.js:439`) vs `2*Math.abs(ext.cx)` (`CameraDock.js:634`).
- **7 `useFrame` sites** — `ViewerCamera.jsx:56`, `SceneEnvironment.jsx:110`,
  `CommandProvider.jsx:202,219`, `CanvasInteraction.jsx:231,882`, `Minimap.jsx:103` (priority 1,
  must stay last).
- **12 live registry subscribers** (13 registrations; `SpatialWindowManager.js:85` is on a
  never-instantiated class). **Not one of the 12 reads the `type` argument it is handed** — every
  handler is nullary. `SceneRegistry._fire(type)` throws away the only information it carries.
- **3 full dock-then-carrel scans** (`SessionStore.js:103-105`, `carrelCommands.js:239`,
  `windowCommands.js:177-179`); ~14 holder-membership questions overall, most of them narrower.
- **157 `settings.js` `apply:` closures · 13 `applyGroupSettings` boot-folds · 6 `setEnabled` twins.**
- **4 domain-class `instanceof` sites repo-wide** — all `instanceof CodeGrid`, all in
  `gridCommands.js:364,410,473,503`. Every `instanceof` in `packages/glyph3d-core/src` is a
  JS-builtin type guard. **The substrate is already capability-dispatched**; ECS names an existing
  convention rather than inverting the architecture.
- **`GridVirtualizer` is dead** — the only `new GridVirtualizer` is `tools/carrel.test.mjs:271` — and
  it is the sole caller of `CodeGrid.unloadContent` (`:913`) and `reloadContent` (`:967`), via
  `GridVirtualizer.js:347,377`.
- **`window.drop` has four paths** (dock / dock-borrowed-from-carrel / carrel / loose,
  `windowCommands.js:176-213`), which a holder protocol reduces to **two**, not zero: the holder's
  home feeds `dropPose` *before* the release (`:179-180`), and the loose path does parent-space
  conversion with no holder to ride (`:203-212`).

### 2c. The pop-back family, explained in one sentence

Docked windows survive a reload today with **zero per-member home persistence**, because the restore
order is load-bearing: *"surfaces move/size FIRST so the subsequent 3D-dock lock captures the
RESTORED home"* (`SessionStore.js:766`). The projector writes the durable position, then
`_reconcileDock` locks, and the lock snapshots home from the transform it finds.

**So `Home` is derived at lock time from `Position` — which works only for facts that are durable.**
A terminal's position is durable (`view.position` → `applyView`), so terminals come back correctly.
A code grid's is not (bugs 2 and 8), so its home is snapshotted from wherever the *layout* put it,
and the window pops back. Ivan's three fresh cases — `window.drop` not writing the fact, zoom lost
for loose terminals, a dropped file grid re-seating — are **one defect** seen three times: *home
derived from a position that was never made durable.*

---

## 3. The converged design

### The three laws

**Law 1 — Two tables, one key.**

```
entity id (string: "src/a.js" · "term-3" · "carrel:agents" · "agent:abc")
  ├─ SceneRegistry entry ........ LIVE components    (dies with the object)
  └─ WorkspaceModel.surfaces .... DURABLE components (outlives it; serialized)
```

This codebase already has two component tables joined by one string id, and **the split is
load-bearing, not accidental**: the model holds a terminal's geometry *whether or not its grid is in
the scene* (`SessionStore.js:216-218`), which is the only reason async PTY re-adoption works.
Collapse them and re-adoption breaks. Ignore the split and you re-derive it by hand — which is
literally what `carrelManifest` is (`SessionStore.js:493`): a hand-rolled durable table for carrels,
written because the durable table for docks was never generalized.

**Every component's schema declares its table.** Without that field, "add a component" is ambiguous
at every call site.

**Law 2 — Structure is edge-triggered.**
`Residence.holder` is authoritative for parenting. But `Object3D.attach()` is world-transform-
preserving and therefore **writes `position` and `quaternion` as a side effect** (`CameraDock.js:471`,
`Carrel.js:229`). A parenting system that reconciles level-triggered — re-running each flush, as an
idempotent projector would — rewrites the transform every frame and destroys the one property the
whole restore design rests on: *"`apply()` is idempotent so re-running is free"*
(`STATE_ARCHITECTURE.md:44`). **The reparent fires on holder *change*, never as a reconcile.**
`skipPosition` (`SessionStore.js:103-105`) is already this rule, applied by hand to one fact.

**Law 3 — Verb-reachable state applies synchronously; only frame-continuous state is pulled.**
`STATE_ARCHITECTURE.md:133` requires it and every `tools/*-check.mjs` asserts it. Glide, breathing
and ghost pulse are pulled per frame; everything a verb can set is applied before the verb returns.
This is exactly today's `setSurfaceView` + `applyView` vs animator split — keep it.

### Component inventory

| Component | Table | Absorbs today |
|---|---|---|
| `Residence{kind, holder, order, by}` | **durable** (+ live index) | `view.docked`+`dockOrder`, `view.carrel`, `carrelManifest`, both holders' `entries`, `dock.tiles`, `AttentionManager.docks`, `lane.pinned`. `by:'user'\|'pin'` retires `pinAutoDocked`. |
| `Position{x,y,z}` + `Detached` tag | **durable** | `view.position`, the `files[].x/y/z` scrape, the dead `positionIsDerived`. Absent `Detached` ⇒ the layout owns it. |
| `Orientation{quat}` | durable | the drop billboard (`windowCommands.js:208`) |
| `Zoom{factor\|xyz}` | durable | `ScaleModel.user`; unifies `terminals[].zoom` + `dock3d.tiles[].zoom` |
| `TerminalGeometry{cols,rows}` | durable | `view.cols/rows` (the size-tagged stream stays the only *writer*) |
| `Viewport{window,frameRows,scrollOffset}` | durable | `CodeGrid._win*`, `_frameRows`, `_scrollOffset` |
| `Fold{LayoutParams}` | durable | `CodeGrid.config.layout` — **zero stations today** |
| `Framed{}` | durable | `CameraDock.focusedPane` + `paneTree` occupancy |
| `BookView{head,following,limit}` · `HolderConfig{pose,knobs}` | durable | agent-lane view intent; `Carrel.serialize().params` |
| **`Object3D` handle** | **live** | `registry.get(id).grid` — stays the transform and render authority |
| **`Home{parentId,pos,quat,placement,bounds}`** | **live** | `DockEntry.home*`, `CarrelEntry.home*`, `lane.pinnedPos`; captured at first lock, **carried** across handoffs (`homeOf`), discarded on return to loose |
| `Extent{w,h,cx,cy,cz}` | live | both `extentFromBox`es, `_extentOf`, `_extentFallback`, the `onResize` taps — **measured live, never cached** (both holders learned that the hard way, `CameraDock.js:100-103`, `Carrel.js:78-82`) |
| `Tags` (multi): `pickable`,`cullable`,`holdable`,`holder`,`placeable`,`borrowed` | live | the one-slot `role\|\|type`, `_pickableTypes`, `CULL_TAGS`, `resolveSurface`'s `type!=='carrel'` refusal, the 4 `instanceof CodeGrid` |
| `Chrome{borderFlags}` · `Controls{spec[]}` · `PickTarget{channels}` | live | `BORDER_FLAGS` + `t.flagged`; `TerminalGrid.CONTROL_SPEC` (terminal-only today) |

**Derived — never stored:** `ScaleModel.placement`, the dock `slot` integer, `LayoutDescription`,
bounds, `_modified`. **Ephemeral — not components at all:** hover, the caret mesh, in-flight tweens,
cull visibility, the PTY handle, the relayout mutex.

The durability rule that falls out — and it is `STATE_ARCHITECTURE.md:48-77` with a place to live:
**a component is durable iff an operator gesture set it and nothing recomputes it.**

**On `Extent`:** do not encode the anchor difference as a flag. The measure reports `{w,h,cx,cy,cz}`
for everyone; the dock keeps its own `2·|cx|` width derivation inside `_containScale`. That preserves
the documented divergence instead of smuggling it into an enum, and the acceptance test is that both
current contain-fit results reproduce exactly.

### System inventory

`Motion` (both `SpatialAnimator`s, both slerp loops, `ContentTreeMotion`, `Book` deck easing) ·
`Holder` — one membership/home/borrow mechanic with **two placement systems** (dock: dome/linear +
pane-tree, ghosts, identity hues; carrel: ring/grid, `expect()` pre-shaping, borrowed guard) ·
`Projection` (`_projectSurfaces` + `_reconcileDock` + `reconcileWorkspace`) · `VisualState`
(`CanvasInteraction.jsx:882-975`, verbatim) · `PickMembership` + `Cull` (`syncCullCandidates`,
`syncVolumeCovers`, `_pickableTypes`) · `Lifecycle/Prune` (`onRemoval`, both `pruneDismissed`,
`attention.pruneGone`).

**Config is not a system and settings are not components** — they target world singletons (the dock,
the label overlay, the culler), not entities. The right fix for the 157 closures and 13 boot-folds is
a declarative `setting → (subsystem, param)` table.

### Canonical frame order

Order as **data — one list in one file**, not a scheduler framework.

```
0  Input        ViewerCameraController.update      owns pitch/yaw; stomps quaternion writes
1  Flush        registry holdChanges close         (verbs already applied synchronously — Law 3)
2  Motion       one animator: holder tweens, tree glide, book decks, ghost/breath phases
3  Holder       park dock ahead of camera; placement systems; borrow returns
4  Projection   dirty-component apply
5  Overlay      labels approach-fade/hover-grow, arrow reanchor, markers
6  VisualState  border flags, cursor focus, capture look, dir outline
7  Cull         occlusion verdicts + proxy refit
8  Render       (Minimap keeps priority 1 → last)
```

**Invariants this preserves, which are accidents today:** agent books ease before carrels re-seat
them — currently true only because `AgentRunner` mounts before `DockRunner`
(`CommandProvider.jsx:800-801`); tree glide runs before the overlays that track positions by value.

**The one deliberate behaviour change, named.** The twins run their in-`update` relayout on opposite
sides of their animator tick: `CameraDock.update` relayouts at `:934` then animates at `:937`;
`Carrel.update` animates at `:562` and only then may relayout at `:575`. A global `Motion` stage
before `Holder` matches the **carrel's** order, so the **dock's canvas-resize reflow gains one
frame** — and only that path (`if (resized && this.entries.size) this._relayout()`); lock, release
and `reflowTile` are mutation-time and unaffected. Adopt it, and harness it. (Carrel's `_seat`
epsilon guard at `:449-455` exists because re-issuing an identical tween restarts its ease; a single
Motion system with target-equality removes that guard structurally.)

---

## 4. Ivan's four nouns, answered

### TOGGLES

**Today** a toggle is a boolean wherever its author first needed it: `view.docked`
(`dockCommands.js:59`), `view.pinAutoDocked` (`windowCommands.js:147`), `lane.pinned`/`following`,
`TerminalGrid._visible`, `AttentionManager._captured`, `isWindowed()`, `frameRows>0`, occlusion
visibility, plus 157 `settings.js` closures and 6 `setEnabled` twins. **Nothing marks which ones are
durable** — proof: `pinAutoDocked` sits in the durable buffer and is never serialized (bug 6), and
the fold is never captured at all (bug 7).

**Under the design** a toggle is the presence of a tag component, and durability is one field in its
schema, declared once. `Docked{order, by}` present ⇒ docked; the `pinAutoDocked` back-channel becomes
`by:'pin'` — provenance on the component that already had to exist.

**Measurable:** `capture()`'s per-field `if (Number.isFinite(…))` ladder (`SessionStore.js:224-229`)
becomes one walk over components whose schema says durable. `window.pin`'s read-back of its own
bookkeeping flag through the model (`windowCommands.js:150`) becomes a read of the component being
removed. Two persistence gaps (fold, loose zoom) close by construction rather than by remembering.

### LIVE UPDATES

**Today** one coarse event drives everything. `SceneRegistry._fire(type)` reaches **12 subscribers**
and **not one reads the type** — every handler is nullary, so every handler re-scans the world.
`holdChanges`/`flushHeld` exists precisely because that fan-out went quadratic under bulk load. The
HUD gave up and **polls at 150ms** — *"scroll/frame/layout/edit don't emit — poll"*
(`HudPanel.jsx:78`). And `SessionStore._onRegistryChange` runs `_projectSurfaces()`, an O(all
surfaces) sweep that re-asserts **every fact of every surface** on *any* registration anywhere.

That sweep is the pop-back amplifier. Because it re-asserts facts that did not change, one stale fact
becomes a visible teleport at the next unrelated registration.

**Under the design** the projector iterates the **changed set**, not all surfaces; a system declares
which components it reads and wakes only for those. A fact that was never written is never
re-asserted — the failure mode becomes structurally impossible. The always-on virtue is preserved by
one rule: **an entity arriving marks all of its components dirty** (a re-adopted PTY is a new object
with old components).

**Measurable:** `_projectSurfaces` + `_reconcileDock` (`SessionStore.js:768-815`) become one dirty
loop; the `held` computation that today walks *every carrel* on *every projection of every surface*
(`:103-105`) becomes a component read; `HudPanel`'s `setInterval` is deleted. The cheapest first step
is not even a component: `_fire({type, id, op})`.

### RELATIONSHIPS

**Today** "who holds this window" is expressed **six** ways, none of which is the relationship: the
scene-graph parent, the holder's `entries` map, a view fact (`view.docked` / `view.carrel`), an array
index that becomes an order (`dock3d.tiles` → `dockOrder`), a pending-claim map (`carrelManifest`),
and a tree-membership test standing in for residence (`positionIsDerived` — which is dead, bug 4).
The **`homeOf` handoff law** (`Carrel.js:355`, `CameraDock.js:369`, applied at
`carrelCommands.js:300-311`) exists *only because* none of the six is authoritative: a transfer must
copy a record between maps while remembering never to capture a vehicle as home.

**Under the design** one component: `Residence{kind, holder, order, by}`. Every question above is a
read of it. The manifest disappears — an unserved claim *is* `Residence` on an entity that isn't live
yet — which is exactly what the durable buffer already does for docked terminals: *"The model IS the
durable buffer, so there's no pending queue: a not-yet-live docked surface is simply skipped and
caught on the next pass"* (`SessionStore.js:784-785`). That is prose about the dock, while the carrel
path re-implements the same idea as a Map.

**This is the direct answer to "dropped/loose wants to be a residence state."** It becomes
`Residence{kind:'loose'}` + the `Detached` tag, written by one verb — and the layout system simply
skips entities carrying `Detached`. Critically, **tree membership stays**: `ContentTree.remove`
deletes from `_leaves` *and* `_books` (`:294-295`), and `_pruneEmptyUp`'s docstring says why that
must not happen on a drop — *"Durable BOOKS are never husks: an away-docked leaf's empty book is the
stable home the dock re-attaches to, so its dir must survive."* The tree already models away-residence
as **membership retained, parenting moved**. The design generalizes that; it does not fight it.

**Measurable:** three full holder scans and ~11 narrower reads become `holderOf(id)`; `window.drop`'s
four paths become two; `findCarrelOwner` deletes; `carrelManifest` deletes; the handoff law becomes
structurally true rather than documentation.

### LIVE IDS

**Today** identity is the strongest part of the system: the registry id is the universal join key —
model surfaces (`WorkspaceModel.js:35-38`), holder entries, the manifest, attention slots, the
session file — and ids are content-derived and stable across re-adoption (`term-N` survives its PTY's
death and rebirth; a file's id is its canonical path). `SceneRegistry`'s species/role split
(`:1-18`, machinery keys on `role||type`) is an archetype tag in all but name.

**Two leaks.** Agent lanes are **not** registry entries, so liveness is a two-authority predicate
(`isLive = registry.has(id) || agentBooks.lanes.has(id)`, `CommandProvider.jsx:~540`) and
`resolveHostable` strips an `agent:` prefix by hand (`carrelCommands.js:90`) — the exact prefix
surgery the house law forbids, forced by the split. And carrels register as `carrel:<name>` but are
refused as cargo by a string test (`dockCommands.js:27`) — a *component* distinction ("has holder
capacity, lacks holdable") smuggled into a resolver.

**Under the design** one entity space, one liveness predicate, `role||type` becomes N tag components
so `pickable ∧ cullable ∧ held` is a query instead of three hand-kept sets, and "is this cargo or a
place" is `has(Holdable)` vs `has(Holder)`.

**The one thing that must not change:** the **string id stays the durable identity forever**. ECS
libraries typically use generational integer handles; that would break re-adoption outright, since
the durable buffer works precisely because `term-1`'s components survive its object's death. That is
also the decisive argument against adopting a library at all — our components hold `Object3D` refs,
`Quaternion`s and `Map`s, and our hard part is domain semantics (home chaining, borrowed guards,
derived-vs-stored) no library knows. **Homegrown, grown out of `SceneRegistry`.**

---

## 5. The slice plan

Each slice is atomic (no dual paths, per the house law), lands standalone, and is verified by a
headless bus-driven harness in the existing `tools/*-check.mjs` style.

| # | Slice | Blast radius | Acceptance test |
|---|---|---|---|
| **−1** | **Delete `GridVirtualizer`** + the now-orphaned `CodeGrid.unloadContent` (`:913`) / `reloadContent` (`:967`) + both barrel exports (`collections/index.js:13`, `src/index.js:22`) | `GridVirtualizer.js`, 2 barrels, `CodeGrid.js` −90, `tools/carrel.test.mjs:23,271` | `rg GridVirtualizer` returns prose only; suite green. **~540 lines of pure subtraction** |
| **0** | **Holder protocol** — `ctx.holders` + `holderOf(id)`. Dock joins; each carrel joins on create/restore; **`AgentBooks` lanes join or are excluded in writing** (they have 3 inline parent tests at `:842,866,882` and a home-less pin) | `CommandProvider`, `SessionStore:103-105`, `carrelCommands:52,215,239,301-311`, `windowCommands:177-179`, `bookCommands:156`, `CarrelsPanel:267`, `gestureResolver:148`, `cameraCommands:67` | **Every existing harness passes UNCHANGED.** If one needs editing, the slice overreached. ~40 added / ~60 removed, zero per-frame change, reversible in an afternoon |
| **0.5** | **Free fixes** (§2a), each independently revertible: `grid.move` writes the model + schedules save · delete `setWorldPosition` and re-gate `placeInView` on `getBounds` + a `placeable` tag (this unblocks CodeGrid) · **delete** `positionIsDerived` and correct `STATE_ARCHITECTURE.md:82,135` · re-key `gridVisualState` index→id · make `file.open`'s usage string honest · `_fire({type,id,op})` · the settings table | ~7 files, ~60 lines | one new headless assertion per fix; the first of them — drag a code grid → save → simulate reload → assert position — **fails today** |
| **1** | **Close the carrel authority fork toward the MODEL.** Delete `Carrel.serialize().members` + `carrelManifest` + `serveManifest`; `view.carrel` becomes real | `carrelCommands`, `Carrel.serialize`, `SessionStore:287,486-500` | new `tools/carrel-persist-check.mjs` in the `dock-persist` style, **with member arrival order fuzzed** — that was the manifest's whole job |
| **A** | **Name the components in memory; file shape unchanged.** Split `view` into named components behind `setSurfaceView`'s existing per-key diff. Declare Law 1 at the top of the slice | `WorkspaceModel`, `SessionStore` | capture output **byte-identical** for an unchanged session; `session-schema-tolerance-check` unchanged |
| **B** | **`Residence` + `Home` + two placement systems.** Laws 1 and 2 written down first; `AttentionManager.docks` deleted here, atomically with `attention.info` and its two harnesses | 2 holders, 4 handler files, `SessionStore`, `CanvasInteraction`, 3 harnesses | dock and carrel round-trip **through the same path**; drop-from-dock → reload → **stays dropped**; `Residence`'s stations collapse to 2 |
| **C** | **`Position` authority + remove the `files[].x/y/z` scrape + the schema bump — one slice.** See the exception below | `SessionStore` capture/restore, `fileCommands` | drop a *bulk-loaded* tree grid → reload → it stays dropped (Ivan's open case) |
| **D** | **Component-keyed projector.** `_projectSurfaces`/`_reconcileDock` → dirty-set; arrival marks all of an entity's components dirty | `SceneRegistry`, `SessionStore`, 12 subscribers | one registration touches one id, not every surface; `HudPanel`'s `setInterval` gone; `loadstorm-check` batching invariants hold |
| **E** | **Motion consolidation.** One animator; `dispose()` becomes object-scoped rather than a global clear (bug 11); intra-frame order unified per §3 | both holders, `ContentTreeMotion`, `Book`, `DockRunner` | new one-frame-order harness on tween count + end pose. **Key by `object.uuid` for now** — id-keying is blocked until lanes and dirs are entities (`type:'dir'` registers only lazily, `navigationCommands.js:155`) |
| **F** | **Capability tags at `register()`** — can land any time after 0.5 | `SceneRegistry`, `gridCommands`, `surfaceInteractions` | the 4 `instanceof CodeGrid` refusals and the `placeInView` gate both become tag reads |

**Global acceptance test, adopted by all three lenses:** *a component is done when its stations
collapse from N to 2 — a schema entry and an apply function.* It is the only artifact in this study
that can **fail** a refactor.

### Where "schema last" bends — the one named exception

Every other fact can migrate in memory while the on-disk shape stays frozen, then move once at the
end. **Position cannot**, because its two authorities live in *different snapshot keys*: the model's
`view.position` (serialized only for terminals) and the live scrape into `files[].x/y/z`
(`SessionStore.js:180-181`). Moving the authority *is* moving the key; writing both would be exactly
the dual path the house law forbids. So slice **C is authority + key + `SCHEMA_VERSION` 2→3, together.**

**No migration shim is needed, and this is why:** restore is already forward-additive
(`SessionStore.js:61-68`) and ignores keys it doesn't know. A v2 snapshot read by v3 code simply has
no `view.position` for grids — and they re-derive from the layout, which is exactly today's
behaviour. The old shape degrades to the current experience rather than breaking.

---

## 6. What NOT to convert

- **Per-glyph anything** — instance attributes in one `Float32Array`, one instanced draw call.
  Already data-oriented; an ECS over glyphs is a strict regression.
- **`CodeGrid._relayout`'s fold→arrange→bounds→decorate pipeline** and its `_arrangers`/`_decorations`
  registries — a pipeline with a single owner and an explicit stage contract, already the right shape.
- **`TerminalEmulator` and the relay PTY** — an external child by definition
  (`STATE_ARCHITECTURE.md:79-81`); the size-tagged stream stays the only writer of terminal size.
- **`ViewerCameraController`** — a 60Hz integrator that owns pitch/yaw and stomps quaternion writes.
  One system boundary; leave its insides alone.
- **`PaneTree`** — a real BSP structure (`split`/`close`/`neighbor`/`resize`) the frame system *uses*.
- **The picking ID pass** — channels and first-fit ID spaces are already correct; only *membership*
  becomes a tag.
- **`ContentTree`'s hierarchy** — transforms compose down it, and `parentOf` is deliberately
  path-derived rather than `node.parent` (`:160-166`) precisely so holder reparenting cannot corrupt
  structure. An entity index already coexisting with a scene graph, and the best single piece of
  evidence that "held" and "member" are separable. Flatten nothing.
- **The 157 settings closures** (world singletons, not entities) · **the command bus** (verbs already
  are the system-invocation API) · **`AttentionManager`'s three slots** (one-writer singletons,
  cheaper as slots than tags).

---

## 7. Honest costs and open questions

### Costs

- **No performance win.** Triangulated independently by all three lenses. The measured stress limit
  is field-count × GPU objects and is untouched by any of this.
- **A second vocabulary.** "Component = intent, `Object3D` = projection" must be held as hard as
  movers' law is held today, by everyone, forever.
- **Slices −1 through 1 are net-negative in lines; A through E are net-positive** (roughly −600 then
  +250–300 for the store, archetype maintenance and the system list). The plan pays for itself at
  slice 1 and again at C; the first *component* slice does not pay for itself.
- **Explicit ordering is a new obligation**, and per-frame *allocation* is the real trap — not
  dispatch. Writing the frame order down surfaces invariants nobody has verified (expect one or two
  one-frame stutters during E, the class of bug `Carrel.js:449-455` documents), and archetype sets
  must be maintained incrementally on write or a naive `query()` churns GC at 60fps. That is where
  the +100 lines go.
- **Shared-tree risk is live.** This study's own citations drifted 9–15 lines while it was being
  written. Slice 0 is deliberately the only step reversible in an afternoon with no frame-behaviour
  change — risk control, not preference.

### Open questions — decisions for Ivan

1. **Is `Home` live or durable?** *The study split 2–1; I am the minority and I am the author, so
   here is both sides.* **Live (my position, and the design above):** home is re-captured at lock from
   `Position`, which is what already happens — the dock survives reload today with zero per-member
   home persistence, thanks to the load-bearing restore order (`SessionStore.js:766`). A stored home
   is a snapshot of a past position, i.e. an *output*, and it goes stale when the layout scheme
   changes under a docked tree leaf. **Durable (the other two lenses):** it makes the handoff record
   explicit and survives an entity that isn't live yet. *My recommendation: live, and revisit only if
   slice B produces a case where the re-derived home is wrong.*
2. **Do agent lanes become registry entries?** Law 1 says "two tables, one key" — which only works if
   every entity is in the live table. Lanes are in neither; carrels are in the registry but refused
   as cargo. Promoting lanes deletes the two-authority `isLive` and the `agent:` prefix surgery. The
   alternative is to write down that there are three tables. **Decide before slice B.**
3. **Which carrel pipeline dies?** The study recommends the model (making `view.carrel` real and
   deleting `Carrel.serialize().members` + `carrelManifest`), because the alternative makes the
   durable buffer a dock-only privilege permanently. This is a one-way door.
4. **Is the dock's one-frame canvas-resize reflow delay acceptable?** It is the single named
   behaviour change in the whole plan (§3). If not, `Motion` keeps two call sites and slice E shrinks.
5. **Does `AttentionManager.docks` keep reporting frame occupancy?** Its `{slot:'frame'}` write
   (`CameraDock.js:687`) is the only record of frame occupancy in the attention dump. Deleting the map
   either drops that from `attention.info` or moves it to `Framed`.

### One flag on the evidence

Bug 4 (`positionIsDerived` has zero production callers) was found late, by one lens, and confirmed by
a second on re-grep. It is the finding that most changes the shape of slice C — it makes the position
authority a *greenfield* decision rather than a behaviour-preserving migration. **Re-run the grep
before acting on it.**

---

## The one-line version

The system Ivan described already exists in fragments — `SceneRegistry` is the live entity table,
`WorkspaceModel.surfaces` is the durable component store, `applyView` is the apply system,
`SURFACE_PROJECTORS` is the system registry, `holdChanges` is the commit barrier — and the reason
none of it *feels* like an ECS is that each piece was built for one fact and then hand-extended for
the next, so every new property costs eight stations instead of two. The move is not to build a
world. It is to **name the two tables you already have, declare the string id as their join key, and
delete every third table someone wrote because those two were unnamed** — `carrelManifest`,
`AttentionManager.docks`, `dock.tiles`, the holder-local `entries` maps, and `ctx.gridVisualState`
are all that third table, five times over.

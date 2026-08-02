# Phase 0 — What an entity IS today

Lens: the Object3D subclass zoo, SceneRegistry as live-ID authority, and where the
subclass-shaped world duplicates or fights itself. Verified against the code, 2026-08-02.

---

## Conclusions first

1. **The system is already capability-oriented, not class-oriented.** There are exactly **4
   `instanceof` sites** in the whole app (`gridCommands.js:364,410,473,503`) and **37**
   `typeof x.f === 'function'` capability probes. Every holder and subsystem already asks *"can
   you?"*, never *"what are you?"* — `grid.setBorderFlag?.()`, `grid.onResize?.()`,
   `grid.scaleModel ? … : …`, `grid.getLocalBounds?.()`. **ECS would formalize what the code
   already does by hand**, not invert the architecture. This is not a rewrite; it is *naming an
   existing convention*.

2. **The duplication is real, measurable, and concentrated in ONE place: holders.** 44% of
   `Carrel.js`'s non-comment lines (**170 of 389**) are **byte-identical** to a line in
   `CameraDock.js`. The entry record shares 10 of 12 fields. `reachesScene()` and
   `extentFromBox()` are copy-pasted verbatim (`CameraDock.js:91-112` ≡ `Carrel.js:69-92`). The
   `opts.to` release-override block is identical (`CameraDock.js:515-521` ≡ `Carrel.js:273-279`).
   `pruneDismissed` and `releaseAll` are identical bodies. This is where an ECS pass pays.

3. **There are FOUR holder implementations, and the fourth is dead.** Live: `CameraDock`,
   `Carrel`, and `AgentBooks` lanes (`pinned`/`pinnedPos`, `:426-428`, with "borrowed" re-derived
   inline as `book.parent !== this.root` at **three** separate sites — `:842,866,882`).
   `GridVirtualizer`'s park/seat with `parkedParent` (`:122-125,168-184`) is a **fourth copy that
   is never instantiated in the app** — the only `new GridVirtualizer` in the repo is
   `tools/carrel.test.mjs:271`. Culling is actually done by `OcclusionCuller`
   (`CommandProvider.jsx:224`). Tellingly, that test file's own header treats dock + carrel +
   virtualizer park/seat as **one family** — the codebase already knows.

4. **"Who holds this?" is asked at ~10 sites, each hand-rolling the same scan** (dock, then every
   carrel): `SessionStore.js:103-104`, `carrelCommands.js:215,239,301,306`,
   `windowCommands.js:177-179`, `bookCommands.js:156`, `CarrelsPanel.jsx:267`,
   `gestureResolver.js:148`, `CommandProvider.jsx:512`, `cameraCommands.js:67`. A `HeldBy`
   component makes each one a single map read. **Highest-value collapse in the codebase.**

5. **Every registry listener is a full re-scan that IGNORES the change type it is handed.**
   `SceneRegistry._fire(type)` passes a type to 7 subscribers (`CanvasInteraction.jsx:124`,
   `CommandProvider.jsx:523,545,727,739`, `SessionStore.js:849`, `HudPanel.jsx:77`) and **not one
   of them uses it** — each re-scans the whole registry. Worse, `HudPanel` additionally **polls on
   a 150ms `setInterval`** (`:78`) because "scroll/frame/layout/edit don't emit". Component-typed
   change signals are the direct fix, and the coalescing discipline to hang them on already exists
   (`SceneRegistry.holdChanges`, `:355-392`; its twin `ContentTree.batchRelayouts`, `:479-490`).

6. **Toggles are already components — in four half-formalized stores.** The border bitset
   (`BORDER_FLAGS`, `panelMaterial.js:41-47`) with per-subsystem bit ownership; the registry's
   pickable tag set (`SceneRegistry.js:43,51,285-295`); `WorkspaceModel.surfaces[id].view`
   (`:152-163`), a sparse, persisted, id-keyed bag with 27 writers; and the `userData` flag
   vocabulary (`isDir/isBook/isVolume/isMarker/isPassThrough/isLayoutGroup/isBookInternal`) that
   `partitionChildren` (`nodeUtils.js:29-38`) and `_pruneEmptyUp`'s husk predicate
   (`ContentTree.js:311-317`) query as **archetypes, in the wild, today**.

7. **Subclassing has already left fossils.** `setWorldPosition` is now a **pure alias** for
   `position.set` on both `TerminalGrid:633-635` and `FrameGrid:371-373` — the DataTexture write
   its docstring still advertises no longer happens (`setGroupOffset` is never called from
   either). Four call sites still branch on it (`CanvasInteraction.jsx:459`,
   `windowCommands.js:206`, `gridCommands.js:282`, `terminalCommands.js:483`). A capability tag
   would have killed that branch the day the difference evaporated; a method name kept it alive.

8. **What ECS does NOT buy here: performance.** Entity counts are 10²–10³, and every hot path is
   already flat typed arrays *inside one entity* (`GlyphField` buffers; `TerminalGrid.js:169-193`).
   The cache-locality argument does not apply. Sell this as *deduplication + capability
   composition*, or don't sell it.

9. **The one genuine architectural fight: `THREE.Object3D.parent` IS the relationship store.**
   The dock's whole trick is "tiles are CHILDREN, so they inherit the camera-follow for free"
   (`CameraDock.js:33-36`); `attach()` gives world-preserving reparenting; `matrixWorld` and
   culling key off `parent`. A `HeldBy` component that does not *also* reparent loses all of that;
   one that mirrors `parent` is a second source of truth — exactly what no-compat-shims forbids.
   **Pick a direction before writing a line.** Cheapest honest answer: *`Held` is authoritative, a
   `ParentingSystem` is its one writer via `attach()`, `parent` becomes derived.*

---

## Premise corrections (verify-first)

- **`applyView` is NOT terminal-only.** `CodeGrid.applyView` exists (`:1119`). But the two
  signatures have **already diverged**: TerminalGrid's is sync, takes `{skipPosition}`, returns
  `{moved,resized}` (`:653-671`); CodeGrid's is `async`, takes no opts, returns `{windowed}`
  (`:1119-1141`). One name, two contracts — the un-unified interface a component contract pins down.
- **`GridVirtualizer` is unwired** (conclusion 3). Do not plan around it as a live third holder;
  plan to **delete** it or graduate it.
- **The carrel slice IS persisted** (contra "NEXT: persistence"): `Carrel.serialize()`
  (`:687-701`), `restoreCarrel` + the manifest sweep (`carrelCommands.js:158-255`).
- **`positionIsDerived` is live and tested** (`SessionStore.js:85-87`,
  `tools/dock-persist-check.mjs:156-164`): position is derived **iff** the entity is a ContentTree
  member. That is already an archetype predicate: *has TreeMembership ⇒ lacks StoredPlacement*.

---

## The entity zoo, as it actually is

| Class | Extends | Owns (state) | Notable holes |
|---|---|---|---|
| `BoundedObject3D` (72 ln) | Object3D | nothing; `getBounds` recomputes from `getLocalBounds` (`:65-71`) | pure capability mixin — cleanest thing in the set |
| `FramedGlyphField` (196 ln) | Bounded | `_renderer`, `_pickingSystem`, `_background`, `_panel`, `_resizeListeners`, `scaleModel` | slots owned here, **construction** left to subclasses (`:36-40,73-77`) |
| `CodeGrid` (2439 ln) | Framed | `config{…12}`, content/lines, `_windowed/_win{Cols,Rows,FirstLine}`, `_scrollOffset`, `_frameRows`, `_modified`, `_arrangers`, `_decorations` (`:56-196`) | **no control chrome**, no `setWorldPosition` |
| `TerminalGrid` (1459 ln) | Framed | `cols/rows`, `_gridScale`, 9 parallel `Float32Array`s, depth-history (`_history/_depthMax/_depthY|ZFactor`), `_cursor*` ×6, `_controls`, `_emulator` (`:91-257`) | **only** class with `CONTROL_SPEC` chrome |
| `FrameGrid` (461 ln) | Framed | `cols/rows`, `aspect`, `_texture/_stream/_video` | self-describes as duck-typed: *"the shared base is the deferred unification work"* (`:366-368`) |
| `Book` (532 ln) | **Bounded**, not Framed | `sheets[]`, `head`, `following`, `deck{zPitch,lerp,order}`, `fitInfo`, `cover` | **no ScaleModel, no border, no `onResize`** → every holder special-cases it |
| `Carrel` (712 ln) | Object3D | 14 knobs, `entries`, `_releasing`, `_orderSeq`, animator, shadow mesh | a holder, not a window |
| `CameraDock` (961 ln) | Object3D | 24 knobs, `entries`, `_releasing`, `tiles` Set, `_ghosts`, `paneTree`, `focusedPane`, `_colorCursor`, `_orderSeq` | a holder **and** a view-frame compositor in one class |
| `AgentBooks` lane (899 ln) | — | `{book,hueIdx,agentType,state,beacon,seq,entries[],groupId,sessionId,maxSheets,pinned,pinnedPos}` (`:180-189`) | a *third* live container; registers `role:'agent'`/`role:'card'` (`:656,772`) |

Shared behavior arrives three ways at once: **inheritance** (bounds, scale, border, resize taps),
**copy-paste** (holders), **duck-typed composition** (`?.` everywhere). Only the first is declared.

---

## Ivan's four nouns, concretely

### TOGGLES — docked / pinned / seated / loose / captured / borrowed / framed / visible / following

**Today**, a toggle's truth lives wherever it was first noticed:

| Toggle | Copies today |
|---|---|
| docked | `CameraDock.entries.has` + `AttentionManager.docks` + `dock.tiles` Set + **scene parent** + `view.docked` (`dockCommands.js:59`) — **five** |
| framed / pinned | `paneTree.has(id)` (`:235`) + `setControlActive('pin',…)` (`:267,270,292,333,530,570`) + `view.pinAutoDocked` |
| seated | `Carrel.entries.has` + `view.carrel{name,order}` (`carrelCommands.js:61`) |
| borrowed | `CarrelEntry._borrowed`, recomputed per frame from `grid.parent !== this` (`Carrel.js:566-572`); AgentBooks re-derives the same predicate inline ×3 (`:842,866,882`) |
| parked | `GridVirtualizer` `.active` + `parkedParent` (`:122-125`) — **dead code** |
| captured/focused/hovered/input | `BORDER_FLAGS` bits + last-writer maps `t.flagged{focus,input,hover,cursorFocus,capture}` (`CanvasInteraction.jsx:851`) |
| visible | `TerminalGrid._visible`, folded into the group-alpha slot (`:677-694`) |
| following | `Book.following` (`:99`); mirrored to `userData.volumeFollowing` on the dir (`ContentTree.js:437-438`) |

**Under ECS.** Presence-or-absence of a component (`Held{holder}`, `Framed{pane}`) or bits on one
bitset. `dock.has(id)` → `world.get(id, Held)?.holder === 'dock'`.

**Simpler, measurably.** Five docked-copies → one. `_borrowed`'s per-frame parent comparison,
written 4× today, becomes one system's job. `AttentionManager.docks` — already flagged as a
mislabeled "record of truth" (`STATE_ARCHITECTURE.md:98`) — deletes outright.

**Worse.** Presence-as-truth is *invisible in a debugger*: `grid.docked === true` greps;
`world.get(id, Held)` does not. And a 5-owner bitset already produced one bug class — bits stranded
on unmount, which is exactly why the explicit teardown at `CanvasInteraction.jsx:859-865` exists.
More components = more stranding surfaces unless each bit has a systemic owner.

### LIVE UPDATES — listeners, reconcilers, per-frame ticks

**Today** there are three unrelated propagation mechanisms:

1. **Per-frame ticks.** 8 `useFrame` hooks, **no central runner**; the main one is `DockRunner`'s
   ad-hoc block (`CommandProvider.jsx:219-254`) doing `cameraDock.update(dt,cam)` →
   `occlusionCuller.update()` → per-carrel `update(dt)` + dead sweep → `contentTreeMotion.update(dt)`
   gating two overlay refreshes → labels. Order is implicit in mount order. `CameraDock.update`
   (`:918-944`) and `Carrel.update` (`:561-583`) reimplement the same three steps, and share the
   `_releasing` slerp loop **byte-for-byte**.
2. **Push taps.** `FramedGlyphField.onResize/_emitResize` (`:163-180`), subscribed by both holders
   with the same `unsubscribeResize` field (`CameraDock.js:476`, `Carrel.js:230`). **Book has no
   `onResize`**, so the identical fact ("my extent changed") travels a second path:
   `AgentBooks.onChange → scheduleCarrelSweep → Carrel.refit()` (`Carrel.js:443-444`,
   `CommandProvider.jsx:488`). One fact, two mechanisms, because one class lacks a method.
3. **Registry change → full re-scan reconcilers.** See conclusion 5. Seven listeners, zero use the
   type. `pruneDismissed(isLive)` is an identical body in both holders (`CameraDock.js:591-595` ≡
   `Carrel.js:325-329`), invoked from one of them (`CommandProvider.jsx:545`).

**Under ECS.** One scheduler ticking systems in a *declared* order over component queries;
`onResize` becomes an `ExtentDirty` flag any layout system reads (the Book hole closes for free);
`pruneDismissed` becomes "GC entities whose registry entry vanished", written once; listeners
subscribe to component kinds, so the type argument stops being thrown away and HudPanel's 150ms
poll dies.

**Simpler.** Delete two `pruneDismissed`, two slerp loops, two `_releasing` maps, the
`unsubscribeResize` bookkeeping, the second Book-extent path, and one polling interval.

**Worse.** Today's ad-hoc ticks are trivially debuggable and each `update()` is self-contained. A
scheduler adds an ordering contract whose failures are one-frame lag bugs — much harder to see than
a missing `x.update(dt)` line. And the coalescing discipline (`holdChanges` / `batchRelayouts`) was
won for load perf; a naive per-frame re-query would undo it.

### RELATIONSHIPS — homeOf chains, holder↔held, book↔leaf, tree membership

**Today** there are four *different* encodings of "X carries Y":

- **Holder entry maps** — the held entity's home stored inside the *holder*
  (`CameraDock.js:445-467` ≡ `Carrel.js:203-225`).
- **Scene parent** — the real carrier (`attach()` at `CameraDock.js:471`, `Carrel.js:229`).
- **Registry role** — `role:'card'|'volume'|'agent'` with `_tag = role||type`
  (`SceneRegistry.js:93-96`) plus `meta.agentId`/`meta.path` back-pointers.
- **View facts** — `view.carrel{name,order}`, `view.docked/dockOrder` (`WorkspaceModel.js:152-186`).

The **homeOf handoff law** (`Carrel.js:30-43`, `CameraDock.js:360-379`) exists *precisely because*
home lives in the holder: a transfer means copying a record between maps while remembering that a
vehicle must never be captured as home. The law is sound; the storage location is what makes it a
law instead of a no-op.

The clearest proof that "held" and "member" are already independent: **`ContentTree.parentOf` is
path-derived, deliberately NOT `node.parent`** (`:160-166`), because a docked/seated leaf would
otherwise hijack sibling navigation. The tree keeps three parallel path-keyed maps
(`_dirs/_leaves/_books`, `:81-86`) *as its own index* precisely so scene-parent churn can't corrupt
structure. That is an entity table sitting beside a scene graph, already.

**Under ECS.** `Home{parent,pos,quat,placement,bounds}` and `Held{holder,order,borrowed}` live on
the **entity**. Then `carrel.add` of a docked window = write `Held.holder`, **touch nothing else** —
home cannot be clobbered because nobody is copying it. `homeOf` is a component read.
`findCarrelOwner` deletes.

**Simpler.** The handoff law becomes structurally true instead of documentation; three
`homeParent`/`parkedParent` captures unify; `window.drop`'s three-branch release
(`windowCommands.js:183-213`) becomes one branch — set `Home` to the drop pose, clear `Held`.

**Worse.** Conclusion 9. Also: `ContentTree` membership is genuinely hierarchical (a directory's
transform composes into its files'), and the dir's child is the **Book**, not the leaf
(`ContentTree.js:269-273`), with fit scale landing on the sheet *mount*, never on the content
(`Book.js:226-227`). Flattening that buys nothing and loses `matrixWorld` for free. **Tree
membership must stay a tree.**

### LIVE IDS — registry, id ↔ grid ↔ path

**Today** `SceneRegistry` is already a decent entity table: `_entries`, `_gridToId` reverse map
(`:33-34`), `_typeCache` per tag, an incrementally maintained `_pickable` index (`:45-51,88`), and
species-vs-role separation (`:9-17`). The weaknesses are *around* it:

- **Namespace soup in the id string** — file path for grids, `term-N`, `carrel:<name>`, `agent:<id>`
  as a *label*. `resolveHostable` does `arg = arg.slice(6)` to strip `agent:`
  (`carrelCommands.js:90`): literal prefix surgery, against the house's own lookup law.
- **~7 resolvers**, each with its own id-vs-index-vs-name policy and its own refusals
  (`type !== 'carrel'`, `role !== 'agent'`): `resolveSurface` (`dockCommands.js:22`),
  `resolveHostable` (`carrelCommands.js:87`), `resolveGridByIdOrIndex` (`spatialHelpers.js:61`),
  `resolveGrid` ×2, `resolveBook` (`bookCommands.js:37`), `resolveToRegistryId`
  (`groupCommands.js:17`).
- **Agent lanes are not registry entries** — `resolveHostable` falls through to
  `ctx.agentBooks.lanes.get(key)` (`:101-102`). One id space is really two.

**Under ECS.** The registry *is* the entity table; `type`/`role` are archetype tags; `meta` is the
component bag it already half-is. One `world.resolve(token)`, with index and name as *indices over
components* rather than per-caller parsing.

**Simpler.** Six resolvers → one; lanes become entities and stop being a second id space; the
`slice(6)` goes away. **Worse:** almost nothing — this is the least risky, most obviously-correct
piece. The only cost is that `registry.get(id).grid` (used everywhere) gains an indirection, and
every `findByType`/`toArray` consumer must migrate atomically per the no-shims law.

---

## Candidate component / system inventory (grounded in real fields)

| Component | Absorbs (today) | Subclass methods → system |
|---|---|---|
| `Placement{pos,quat}` | `Object3D.position/quaternion`, the dead `setWorldPosition` ×2, `moveVerbFor` (`surfaceInteractions.js:128`), `view.position` | `grid.move`/`terminal.move`/`book.move` → one `entity.move`; `positionIsDerived` → archetype predicate |
| `Scale{placement,user}` | **`ScaleModel` verbatim** (`:25-65` — a pure data record with a `resolve(obj)` fn and no THREE import) | `setScale`/`setZoom` → `resolveScale`; kills 4 `grid.scaleModel ? … : …` guards (`CameraDock.js:443`, `Carrel.js:201,241,432`, `windowCommands.js:45`) |
| `Home{parent,pos,quat,placement,bounds}` | `DockEntry.home*` (`:448-460`), `CarrelEntry.home*` (`:206-219`), `parkedParent` (`:125`), `lane.pinnedPos` (`:428`) | `homeOf`/`homePosition`/`homeBounds` → component reads |
| `Held{holder,order,slot,borrowed}` | two `entries` Maps + `tiles` Set + `AttentionManager.docks` + `view.docked`/`view.carrel` + `lane.pinned` | `lock`/`release`/`dismiss`/`pruneDismissed`/`releaseAll` → one `HolderSystem`, parameterized by a **layout fn** (both holders already call `flowBoxes`) and an **anchor** (camera vs world) |
| `Chrome{flags}` | `BORDER_FLAGS` bitset (already) + `t.flagged` last-writer maps | `applyBorderFlag`/`applyCapture` (`CanvasInteraction.jsx:750-786`) → one `BorderStateSystem` deriving bits from attention slots |
| `Controls{spec[]}` | `TerminalGrid.CONTROL_SPEC` (`:1088-1096`) + `_initControls/_layoutControls/_registerControls/setControlActive` (~120 ln, **terminal-only**) | one `ControlChromeSystem` on any panel entity — **capability win**: code grids/captures get Pin/Drop/Close, which `window.pin`/`window.drop` already support for them |
| `Extent` | `BoundedObject3D` + `onResize/_emitResize` + the Book-shaped hole (`Carrel.js:443`) | `_extentOf`/`extentFromBox` ×2 → one measure system |
| `PickTarget{channels}` | `_pickableTypes`/`_pickable` (already an index), per-class `setPickingSystem` | channel re-registration after rebuild → one system |
| `View` (persisted) | `WorkspaceModel.surfaces[id].view` (already sparse, id-keyed, 27 writers, change-diffed) | the two divergent `applyView`s → per-component appliers; `SURFACE_PROJECTORS` (`SessionStore.js:96`) is already the system table |
| `Cells{cols,rows}` vs `Reflow{window,frame,scroll}` | TerminalGrid `cols/rows` vs CodeGrid `_win*`/`_frameRows`/`_scrollOffset` | **the north star's split**: one framed-glyph entity, two layout components |

---

## The migration riverbed — what is ALREADY component-shaped

Eleven load-bearing pieces are ECS in all but name. **A refactor that starts anywhere else is
starting in the wrong river.**

1. `SceneRegistry` entry `{id,grid,type,role,meta}` with `_tag = role||type` (`:85-96`) — an entity
   table with an archetype tag, plus a **materialized query index** (`_pickable`) maintained
   incrementally exactly as an ECS would (`:45-51,88`).
2. `WorkspaceModel.surfaces[id].view` — a sparse, persisted, id-keyed component store with
   change-diffing built in (`:152-163`).
3. `surfaceInteractions.RECORDS` — a **system dispatch table keyed on `entry.role || entry.type`**
   (`:104,118`), the same tag the registry computes; its header exists so `type === 'terminal'`
   branches stop scattering.
4. `SURFACE_PROJECTORS` — *"Adding a surface kind = adding a projector here"* (`SessionStore.js:93`).
5. `BORDER_FLAGS` — a bitset component with documented per-subsystem bit ownership.
6. `ScaleModel` — pure data + a `resolve()` system fn, deliberately THREE-free.
7. `userData` archetype flags queried by `partitionChildren` (`nodeUtils.js:29-38`) and the husk
   predicate (`ContentTree.js:311-317`).
8. `ContentTree`'s three path-keyed maps (`:81-86`) + path-derived `parentOf` (`:160-166`) — an
   entity index deliberately independent of the scene graph.
9. `LayoutDescription` — layout is already "params, not code paths".
10. `CodeGrid._arrangers` / `_decorations` — per-entity system registries with an explicit contract
    and stage order (`:172-196`).
11. The universal `?.` capability style + only 4 `instanceof` sites.

---

## Honest cost

- **The parent/component duality (conclusion 9)** is the whole risk. Budget a design pass, not an
  afternoon.
- **Atomicity.** No-shims means each component migrates across *all* callers in one change. `Scale`
  is ~6 sites (a day). `Held`+`Home` is ~25 sites across 2 holders, 4 handler files, SessionStore,
  CanvasInteraction, and 3 harnesses (`dock-persist-check`, `term-geom-persist-check`,
  `carrel.test.mjs`) — **a week, not a day.**
- **Console/CLI ergonomics.** Ivan pokes live objects. A world store makes `./glyph3d-cli` uniform
  and *better*; it makes `$0.cols` in devtools worse. Mitigation with by far the lowest friction:
  **keep the live Object3D as the entity handle** (`registry.get(id).grid`) and grow `meta` into a
  typed component bag on the registry entry, rather than standing up a separate table.
- **No perf win.** Justify with the 170 duplicated lines, the 10 holder scans, the 7 type-ignoring
  listeners, and the terminal-only control row.

## What NOT to convert

- `GlyphField` / instance buffers / atlas / shaping — one entity internally, already data-oriented.
- `CodeGrid._relayout`'s fold→arrange→bounds→decorate — a *pipeline*, not a component system, and
  correct as-is; its arranger/decoration registries are already the right shape.
- `ContentTree`'s hierarchy — the tree IS the relationship and transforms compose down it.
  `positionIsDerived` is the right seam; flatten nothing.
- `TerminalEmulator` / the relay PTY — an external child, not an entity
  (`STATE_ARCHITECTURE.md:79-81`).
- The command bus — verbs are already the system-invocation API. A second way to poke entities
  would be the dual code path the house law forbids.

## Smallest first cut that is unambiguously worth it

1. **`HolderSystem` + `Home`/`Held`** — fold `CameraDock` and `Carrel` into one holder
   parameterized by (anchor: camera|world, layout: dome|arc|wall) and fold `AgentBooks`' pin into
   the same `Home`. Deletes ~170 duplicated lines and 10 hand-rolled owner scans.
   **Prerequisite: delete or graduate the unwired `GridVirtualizer` first** — do not carry a dead
   fourth copy into the new form.
2. **`Controls` component** — lift `CONTROL_SPEC` off `TerminalGrid`. Pure capability gain.
3. **Capability tags at `register()`** — promote the implicit `?.` duck-typing into declared tags,
   then delete the branches whose difference has evaporated (`setWorldPosition` first), and make
   the 7 registry listeners subscribe by tag instead of re-scanning.

Each is an ECS move; none is "an ECS refactor"; all three obey the standing lane — abstractions
tendril out **as** the code is touched.

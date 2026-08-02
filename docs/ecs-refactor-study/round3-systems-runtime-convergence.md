# Round 3: systems-runtime convergence

All three lenses, after two adversarial rounds. Numbers below are the **re-measured** ones.

---

## Settled

**Corrected counts of record** (every Phase 0 headline that moved):

1. **Holder duplication is 73–117 identical lines of 389, not "170 / 44% byte-identical."** Publish
   the ladder, not one number: byte-identical incl. indentation **159 (40.9%)**, strip-identical
   **170 (43.7%)**, >3 chars **117 (30.1%)**, >3 chars excluding brace/`return` lines **100
   (25.7%)**, >20 chars **73 (18.8%)**, >30 chars **43 (11.1%)**. All three agents retracted their
   own figure; the *shape* survived — the identical lines concentrate in `lock`/`release`/`dismiss`/
   `homeOf`/`pruneDismissed`/`_userOf`/`reachesScene` (membership + home), not in `_relayout`.
2. **7 `useFrame` sites**, not 8. **12 live registry subscribers** (13 registration sites, 1 on a
   never-instantiated class), not 7 and not 13 — and **none of the 12 reads the `type` argument**.
3. **13 `applyGroupSettings` call sites** (12 in `CommandProvider`, 1 in `structureCommands`), not 8
   or 11. **157 `settings.js` `apply:` closures. 6 `setEnabled` twins. ~20 `setSurfaceView` writers.**
4. **4 domain-class `instanceof` sites repo-wide**, all `instanceof CodeGrid` in `gridCommands.js`
   (`:364,410,473,503`); every `instanceof` in `packages/glyph3d-core` is a JS-builtin type guard.
   The substrate is capability-dispatched already.

**Design, settled 3/3:**

5. **No performance win.** 10¹–10³ window entities; hot paths are already flat arrays inside one
   entity. Sell deduplication, station count, and correctness — never speed.
6. **Two tables, one key.** `SceneRegistry` = *live* components (dies with the object);
   `WorkspaceModel.surfaces` = *durable* components (outlives it — the only reason async PTY
   re-adoption works, `SessionStore.js:216-218`); the string registry id joins them. Collapsing them
   breaks re-adoption; ignoring the split re-derives it by hand — which is exactly what
   `carrelManifest` is. *(entity-substrate's T1; I retracted my "one table" framing in Round 2.)*
7. **One `Held`/`Residence` component, TWO holder systems** — not one class with an `anchor` flag.
   Proof: `extentFromBox` diverged deliberately and documented (`Carrel.js:78-82`), consumed as
   `2·|cx|` vs `ext.w` (`CameraDock.js:634` vs `Carrel.js:439`); the dock alone carries `PaneTree`,
   ghosts and identity hues, the carrel alone `expect()` and the borrowed guard.
8. **Structure is edge-triggered.** `Held.holder` is authoritative for parenting, but
   `Object3D.attach()` is world-preserving and therefore *writes* `position`/`quaternion` as a side
   effect (`CameraDock.js:471`, `Carrel.js:229`) — so the reparent fires on holder *change*, never as
   a level-triggered reconcile, or idempotent re-run (`STATE_ARCHITECTURE.md:44`) breaks.
   `Home.parent` serializes as an entity **id**, never an `Object3D` ref.
9. **Verb-reachable state applies synchronously; only frame-continuous state is pulled.**
   Non-negotiable (`STATE_ARCHITECTURE.md:133` + every `tools/*-check.mjs`).
10. **The carrel authority fork closes toward the MODEL, in one change, deleting the loser.** Today
    the dock persists via the model (`SessionStore.js:250-262`) and the carrel via a live scrape
    (`:287-288` → `Carrel.serialize()` → `carrelManifest` → `serveManifest`). No-compat-shims forbids
    keeping both.
11. **Change events must name what changed** — `_fire({type, id, op})` before any component-level
    event. This alone kills `HudPanel.jsx:78`'s 150ms poll and makes `_projectSurfaces` O(one id).
12. **Slice order: −1 delete `GridVirtualizer` → 0 holder protocol → then components.** All three
    agents moved to this; entity-substrate retracted its week-long first cut.
13. **Cite symbols, not lines.** The tree moved 9–15 lines under all three documents mid-study.

**A position of mine that lost, recorded plainly:** I proposed (Round 2 T4) that `window.drop`
should *remove tree membership* rather than store a position authority. **Refuted.**
`ContentTree.remove` deletes from `_leaves` **and** `_books` (`:292-294`), and `_pruneEmptyUp`'s
docstring states the reason it must not: *"Durable BOOKS are never husks: an away-docked leaf's empty
book is the stable home the dock re-attaches to, so its dir must survive."* The tree already models
away-residence as membership-retained / parenting-moved. state-persistence is right.

**Live bugs the study found (all shippable independently of any ECS work):**

14. **`positionIsDerived` has ZERO production callers** — `SessionStore.js:85` (export) +
    `tools/dock-persist-check.mjs:11,161-164` only. Its docstring calls it *"the one subtle
    discriminator the projection and capture paths share"* (`:82`); neither path calls it.
    `STATE_ARCHITECTURE.md:82,135` is wrong too. *(state-persistence's Round 2 catch — the best late
    find in the study, and it makes three agents' T4 debate a discussion about dead code.)*
15. **`view.carrel`: ~20 writes, 0 readers.** Written from `carrelCommands.js:61`; nothing reads it.
16. **`grid.move` moves without writing the model** (`gridCommands.js:271-290`) — movers' law violated
    at the one verb whose whole job is moving.
17. **`file.open` advertises `[x y z]`** (`fileCommands.js:92`), capture plumbs it
    (`SessionStore.js:180-181`) and restore replays it (`:638`) — **the handler reads only `args[0]`.**
    Worse: a bulk-loaded tree grid has no sheet at all, so it is not in `files[]` and has *no*
    position authority. (Precision fix to state-persistence: `openSheet` has three callers —
    `fileCommands.js:98`, `workspaceCommands.js:25,102` — but none is `file.openDir`, so the
    conclusion holds.)
18. **`setWorldPosition` is a dead alias used as a live capability gate.**
    `TerminalGrid.js:633-635` / `FrameGrid.js:372-374` are pure `position.set`; `setGroupOffset` is
    never called from either; and `ViewerCameraController.placeInView:1071` hard-refuses any object
    lacking it — so **a `CodeGrid` can never be placed in view**, silently.
19. **`SpatialAnimator.dispose()` is a global `_active.clear()`** (`:182-184`) called from a *live*
    path — `CommandProvider.jsx:230` disposes any carrel that finished dissolving. Harmless today
    (per-holder animators); a landmine the moment they merge.
20. **Also open:** `pinAutoDocked` lives in the durable buffer and is never serialized;
    `CodeGrid.config.layout` (fold) has zero persistence stations and resets on reload; zoom
    persists in two shapes split by holder; `ctx.gridVisualState` is keyed by grid **index**;
    `AttentionManager.docks` is a redundant projection whose `:687` `{slot:'frame'}` write is the
    only frame-occupancy record in the attention dump.

---

## Implementation Plan

### The model: two tables, one key

```
entity id (string, e.g. "src/a.js", "term-3", "carrel:agents", "agent:abc")
  ├─ SceneRegistry entry ....... LIVE components   (dies with the object)
  └─ WorkspaceModel.surfaces ... DURABLE components (outlives it; serialized)
```
**Every component schema declares its table.** That is the field the study kept needing and no doc
had.

| Component | Table | Absorbs today |
|---|---|---|
| `Residence{kind,holder,order,home{parent:id,pos,quat,placement,bounds}}` | **durable** | `view.docked`+`dockOrder`, `view.carrel`, `carrelManifest`, both holders' `entries[].home*`, `AttentionManager.docks`, `dock.tiles` |
| `Framed{pane}` | durable | `CameraDock.paneTree` occupancy + `focusedPane` + `view.pinAutoDocked` (→ `Residence.by`) |
| `Zoom{factor\|xyz}` | durable | `ScaleModel.user`; unifies `terminals[].zoom` + `dock3d.tiles[].zoom` |
| `Position{x,y,z}` + `Detached` tag | durable | `view.position`, the `files[].x/y/z` scrape, the dead `positionIsDerived` |
| `Orientation{quat}` | durable | drop billboard (`windowCommands.js:208`) |
| `TerminalGeometry{cols,rows}` · `Viewport{window,frameRows,scrollOffset}` · `Fold{params}` | durable | `view.cols/rows`, `view.window/frameRows/scrollOffset`, `CodeGrid.config.layout` (gap) |
| `BookView{head,following,limit}` · `HolderConfig{pose,knobs}` | durable | `AgentBooks` lane view; `Carrel.serialize().params` |
| **`Object3D` handle** | **live** | `registry.get(id).grid` — stays the transform/render component |
| `Extent{w,h,cx,cy,cz}` | live | both `extentFromBox`es + `_extentOf`; **measured live, never cached** |
| `Tags` (multi) — `pickable`,`cullable`,`holdable`,`holder`,`placeable`,`borrowed` | live | the one-slot `role\|\|type`, `_pickableTypes`, `CULL_TAGS`, `resolveSurface`'s `type!=='carrel'` refusal, the 4 `instanceof CodeGrid` |
| `Chrome{borderFlags}` · `Controls{spec[]}` | live | `BORDER_FLAGS` + `t.flagged`; `TerminalGrid.CONTROL_SPEC` (terminal-only today) |

**Derived — never stored:** `ScaleModel.placement`, the dock `slot` int, `LayoutDescription`, bounds,
`_modified`. **Ephemeral — not components:** hover, caret mesh, in-flight tweens, cull visibility,
the PTY handle, the relayout mutex.

### Systems

`Motion` (absorbs both `SpatialAnimator`s, both slerp loops, `ContentTreeMotion`, `Book` deck
easing) · `Holder` (membership + home + borrow; **two placement systems**: dock-dome/linear+pane,
carrel-ring/grid) · `Projection` (`_projectSurfaces` + `_reconcileDock` + `reconcileWorkspace`) ·
`VisualState` (`CanvasInteraction.jsx:882-975` verbatim) · `Overlay/Config` · `Cull/Pick membership`
(`syncCullCandidates`, `syncVolumeCovers`, `_pickableTypes`) · `Lifecycle/Prune` (`onRemoval`, both
`pruneDismissed`, `attention.pruneGone`).

### Canonical frame order (my dissent, made normative)

```
0 Input      ViewerCameraController.update      (owns pitch/yaw; stomps quaternion writes)
1 Flush      registry holdChanges close         (verbs already applied synchronously)
2 Motion     one animator: holder tweens, tree glide, book decks, ghost/breath phases
3 Holder     park dock ahead of camera; placement systems; borrow returns
4 Projection dirty-component apply
5 Overlay    labels approach-fade/hover-grow, arrow reanchor, markers
6 VisualState border flags, cursor focus, capture look, dir outline
7 Cull       occlusion verdicts + proxy refit
8 Render     (Minimap keeps priority 1 → last)
```
**Invariants this preserves:** book decks ease before carrels re-seat them (today an accident of
`AgentRunner` mounting before `DockRunner`, `CommandProvider.jsx:800-801`); tree glide before the
overlays that track positions by value.
**The one deliberate change, named:** the twins run their in-`update` relayout on opposite sides of
their animator tick (`CameraDock.js:934,937` vs `Carrel.js:562,575`). The canonical order matches the
**carrel's**, so the **dock's canvas-resize reflow gains one frame** — and only that path
(`if (resized …) this._relayout()`, `:934`); lock/release/`reflowTile` are mutation-time and
unaffected. Adopt it; harness it.

### Slices — blast radius and acceptance test

| # | Slice | Blast radius | Acceptance test |
|---|---|---|---|
| −1 | Delete `GridVirtualizer` + orphaned `CodeGrid.unloadContent:913`/`reloadContent:967` (sole callers `GridVirtualizer.js:347,377`) | `GridVirtualizer.js`, 2 barrels, `CodeGrid.js` −90, `tools/carrel.test.mjs:271` | `rg` finds no reference; `carrel.test.mjs` passes with its virtualizer section removed. ~540 lines net |
| 0 | **Holder protocol** — `ctx.holders` + `holderOf(id)`; dock, carrels **and `AgentBooks` lanes** join (or lanes excluded in writing) | `CommandProvider`, `SessionStore:103-104`, `carrelCommands:52,215,239,301-311`, `windowCommands:177-179` | **Every existing harness passes UNCHANGED.** If one needs editing, the slice overreached. ~40 added / ~60 removed |
| 0.5 | Free fixes, each independently revertible: `grid.move` writes the model; delete `setWorldPosition` and re-gate `placeInView:1071` on `getBounds`+`placeable` (unblocks CodeGrid); wire-or-delete `positionIsDerived` (+ fix `STATE_ARCHITECTURE.md:82,135`); re-key `gridVisualState` index→id; resolve `file.open`'s `[x y z]` | 6 files, ~40 lines total | one new headless check per fix |
| 1 | **Carrel authority → the model**; delete `Carrel.serialize().members` + `carrelManifest` | `carrelCommands`, `SessionStore:287,486-500`, `Carrel.serialize` | NEW `tools/carrel-persist-check.mjs` in the `dock-persist` style, with **member arrival order fuzzed** — that was the manifest's whole job |
| A | Name components in memory; file shape unchanged. Declare the two-tables rule at the top | `WorkspaceModel`, `SessionStore` | all persistence harnesses byte-identical output |
| B | `Residence` + two placement systems + the edge-triggered reparent rule | 2 holders, 4 handler files, `SessionStore`, 3 harnesses | `Held` stations collapse to 2 (schema + apply) |
| C | `Position` authority **+ the `files[].x/y/z` scrape removal + the schema bump, together** | `SessionStore`, `fileCommands` | *(state-persistence's D2 exception — accepted: this fact's two authorities live in different snapshot keys, so "schema last" cannot cover it)* |
| D | Component-keyed projector + `_fire({type,id,op})` | `SceneRegistry`, `SessionStore`, 12 subscribers | `HudPanel`'s `setInterval` deleted; `loadstorm-check` unchanged |
| E | **Motion consolidation** — one animator; object-scoped `dispose()`; order unified per above | 2 holders, `ContentTreeMotion`, `Book`, `DockRunner` | new one-frame-order harness; **key by `object.uuid` for now** — id-keying is blocked until lanes and dirs are entities (`type:'dir'` is registered only lazily, `navigationCommands.js:155`) |
| F | Config table — declarative `setting → (subsystem, param)` replacing 157 closures **and** the 13 boot-folds | `settings.js`, `CommandProvider` | boot-fold count → 0 |

**Global acceptance test (state-persistence's, adopted by all three):** *a component is done when its
stations collapse from N to 2 — a schema entry and an apply function.* It is the only artifact in
this study that can **fail** a refactor.

### What NOT to convert

Glyph instance buffers / atlas / shaping (already data-oriented, one entity internally) ·
`CodeGrid._relayout`'s fold→arrange→bounds→decorate pipeline · `TerminalEmulator` + the relay PTY
(an external child) · `ViewerCameraController`'s 60Hz integrator (owns pitch/yaw) · `PaneTree`
(a BSP tree the frame system *uses*) · the picking channels (membership becomes a tag; the ID pass
is already right) · `ContentTree`'s hierarchy (transforms compose down it; `parentOf` is
path-derived on purpose, `:160-166`) · the command bus (verbs already are the system-invocation API).

---

## Implementer Vote

**state-persistence.**

- **Their Round 2 synthesis *is* the converged sequence.** They integrated my Slice 0 (holder
  protocol first, explicitly "newly persuaded"), adopted entity-substrate's T1 two-tables model,
  added the 0.5 free-fix tier, and produced the A–E ordering this convergence doc reproduces almost
  unchanged. Neither of the other two syntheses needed less amendment.
- **Fewest unresolved dissents against the converged position.** Their D1 (label `positionIsDerived`
  as a proposal, not a description) is now *settled fact* — they proved it has zero callers. D3
  (carrel authority → the model) is unanimous. D4 is a correction of entity-substrate's error. Only
  D2 remains open, and it is an **amendment everyone should accept**: position is the one fact whose
  two authorities live in different snapshot keys, so its slice must move a key. That is a sharpening
  of the plan, not a conflict with it.
- **They own the two artifacts the final document most needs:** the station table (the only
  acceptance test that can fail a refactor) and the live-bug inventory that gives Ivan something
  shippable *before* any ECS work — `view.carrel`, `positionIsDerived`, `grid.move`, `file.open`'s
  x/y/z, `pinAutoDocked`, the fold gap. A study that opens with "here are six real bugs we found and
  five free deletions" earns the architecture argument that follows.
- Against entity-substrate: they own the single best insight (T1) but had the highest Phase 0 error
  rate — 44%, "verbatim `extentFromBox`", 8 `useFrame`, 7 subscribers, the one-class merge, 27
  writers — plus one claim (`ctx.n`) that was simply false and that both other agents had to refute.
  Their corrections were exemplary; the final document should nonetheless be written by the lens that
  had least to take back.

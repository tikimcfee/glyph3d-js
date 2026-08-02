# Round 3: entity-substrate convergence

All three Round 2 files read. Disputed facts re-verified once more; two of my own claims die below.

---

## Settled

**Counts of record** (every inflated Phase 0 number superseded):

1. **7 `useFrame` sites**, not 8 — `ViewerCamera.jsx:56`, `SceneEnvironment.jsx:110`,
   `CommandProvider.jsx:202`, `:219`, `CanvasInteraction.jsx:231`, `:882`, `Minimap.jsx:103`
   (priority 1, must stay last). My 8 was a subagent prose count I failed to reconcile.
2. **12 live registry subscribers**, 13 registration sites, 1 dead (`SpatialWindowManager.js:85`,
   never instantiated). My 7 was the worst count of the three. **Not one handler reads the `type`
   argument it is passed** — every one is nullary. That claim survived all three passes untouched.
3. **Holder duplication: publish the method, not a number.** `Carrel.js` lines matching any
   `CameraDock.js` line: byte-identical incl. indentation **159 (40.9%)**; strip-identical **170
   (43.7%)**; >3 chars **117 (30.1%)**; >20 chars **73 (18.8%)**. My "44% byte-identical" was the
   strip figure under the wrong label. 19–30% is the honest band.
4. **3 full dock-then-carrel scans** (`SessionStore.js:103-104`, `carrelCommands.js:239`,
   `windowCommands.js:177-179`), not ~10; ~14 holder-membership questions overall, most narrower.
5. **20 `setSurfaceView` call sites** (my 27 counted `tools/`, the definition and a capability probe).
6. **4 domain-class `instanceof` sites** — all `instanceof CodeGrid`, all in `gridCommands.js:364,
   410,473,503`. My "exactly 4 in the whole app" was wrong as a raw count (9 real in `app/`; 5 are
   `instanceof Map`) but the substance got stronger on re-measurement: **`packages/glyph3d-core/src`
   has 13 `instanceof` uses and every one is a JS-builtin type guard — zero domain classes.**
7. **157 `settings.js` `apply:` closures · 13 `applyGroupSettings` call sites · 6 `setEnabled` twins.**
   systems-runtime's original 8 was low; the correction strengthens its own argument by 60%.
8. **`GridVirtualizer` is dead** (only `tools/carrel.test.mjs:271`) and it is the sole caller of
   `CodeGrid.unloadContent`/`reloadContent` → Slice −1 is ~540 lines of pure subtraction.
9. **`extentFromBox` is a deliberate, documented divergence**, not a copy-paste (`Carrel.js:78-82`;
   consumed as `ext.w` at `:439` vs `2·|cx|` at `CameraDock.js:634`). Full retraction of my claim —
   and it is the counter-example that killed my own "fold the two classes into one" recommendation.
10. **`AgentBooks` has 3 parent-identity tests**, `:842` (positive, pin-guard) + `:866`/`:882`
    (negative, borrowed-skip). My claim held; state-persistence retracted its challenge.

**My two retractions this round:**

11. **`ctx.gridVisualState` exists; there is no `ctx.n`.** My Round 1 E3 was false. Root cause worth
    recording: I ran `rg -rn "gridVisualState"`, where `-r` is `--replace`, so ripgrep substituted
    every match with `n` and I read the output as evidence. **A grep flag manufactured a confident
    correction.** systems-runtime and state-persistence both rejected it correctly.
12. **`positionIsDerived` is tested, not live.** My Phase 0 "verify-first" correction called it
    "live and tested". Verified exhaustively: the only references are the export
    (`SessionStore.js:85`) and `tools/dock-persist-check.mjs:11,161-164`. **Zero production callers**,
    while its own docstring claims it is "the one subtle discriminator the projection and capture
    paths share." state-persistence found this; it retracts a premise of mine and a station of theirs.

**Design points settled across all three lenses:**

13. **No performance win.** 10¹–10³ window entities; hot paths are already flat typed arrays inside
    one entity. Justify on deduplication, station count, correctness-by-construction — never speed.
14. **Two tables, one key.** `SceneRegistry` = live components (dies with the object);
    `WorkspaceModel.surfaces[id].view` = durable components (outlives it — the only reason async PTY
    re-adoption works, `SessionStore.js:216-218`); the string registry id is the join. Both other
    agents retracted their single-table framings in favour of this.
15. **One `Held`/`Residence` component, TWO holder systems** — not one parameterized class. Proof:
    the `extentFromBox` divergence (9), the intra-frame ordering asymmetry (23), and the asymmetric
    machinery (`PaneTree`/ghosts/hues vs `expect()`/borrowed-guard).
16. **Structure is edge-triggered.** `Held.holder` is authoritative for parenting, but
    `Object3D.attach()` is world-preserving and therefore *writes* `position`/`quaternion`
    (`CameraDock.js:471`, `Carrel.js:229`) — so reparent fires on holder *change*, never as a
    level-triggered reconcile, or idempotent re-run (`STATE_ARCHITECTURE.md:44`) breaks.
    `skipPosition` (`SessionStore.js:103-105`) is already this rule applied by hand to one fact.
17. **Verb-reachable components apply synchronously; only frame-continuous state is pulled**
    (`STATE_ARCHITECTURE.md:133` + the `tools/*-check.mjs` harnesses).
18. **`_fire({type, id, op})` before any component-level event** — kills the 150ms HUD poll and turns
    `_projectSurfaces` from O(all surfaces) into O(one id).
19. **Slice ordering: −1 (delete) → 0 (holder protocol) → 0.5 (free bug fixes) → components.** I
    moved off my week-long first cut; all three now agree.
20. **The carrel authority fork closes in ONE direction in ONE change** — toward the model.
    No-compat-shims forbids two pipelines.
21. **Home.parent serializes as an entity id, never an `Object3D` ref** (`Carrel.js:281-284`).
22. **Re-grep before implementing.** The tree moved 9–15 lines under all three documents mid-study.

**Live bugs found along the way** (all independently verified, none requiring ECS to fix):

23. `view.carrel` — written from 6 sites (`carrelCommands.js:61`), **zero readers**; carrel membership
    persists through a parallel `Carrel.serialize()` → `carrelManifest` → `serveManifest` pipeline,
    giving the twins **opposite persistence authority** (dock reads the model `SessionStore.js:256`,
    carrel scrapes the live object `:287`).
24. `grid.move` (`gridCommands.js:271-289`) never writes the model — movers' law violated at the one
    verb whose entire job is moving.
25. `file.open`'s `[x y z]` is captured, replayed (`SessionStore.js:638`) and **never consumed**
    (`fileCommands.js:92-93` reads only `args[0]`) — and it is advertised in the usage string.
26. `setWorldPosition` is a pure `position.set` alias (`TerminalGrid.js:633`, `FrameGrid.js:372`;
    `setGroupOffset` never called) yet gates `ViewerCameraController.placeInView` (`:1071`), so **a
    `CodeGrid` can never be placed by the one method whose docstring says "grid / terminal"** — the
    exact method `file.open`'s dead x/y/z would need.
27. `ctx.gridVisualState` is keyed by grid **index** (`gridVisualState.js:20-62`) — a registry
    reorder silently mis-restores.
28. `pinAutoDocked` lives in the durable buffer and is never serialized; `CodeGrid.config.layout`
    (fold) has **zero** persistence stations; zoom is persisted in two shapes split by holder.
29. `AttentionManager.docks` is a redundant projection — but populated (`CameraDock.js:483-487`),
    read (`AttentionManager.js:223` → `attention.info`) and asserted (`dock-dismiss-check.mjs:47`,
    `dock-refresh-check.mjs:205`). Delete it atomically with those, not as free subtraction.
30. `SpatialAnimator.dispose()` is a global `_active.clear()` (`:182-184`) called from a **live**
    path (`Carrel.js:704` via `CommandProvider.jsx:230`) — with a shared animator, one desk folding
    would cancel every in-flight tween in the app. Merge hazard, found by systems-runtime in R2.
31. Dock/carrel intra-frame order differs (`CameraDock.js:934,937` relayout-then-animate;
    `Carrel.js:562,575` animate-then-relayout) — a one-frame lag the dock lacks.

---

## Implementation Plan

### The model: two tables, one key

| Component | Table | Absorbs today |
|---|---|---|
| `Extent{w,h,cx,cy,cz}` | live | `extentFromBox` ×2, `_extentOf`, `_extentFallback`, `onResize` taps |
| `PickTarget{channels}` | live | `_pickableTypes`/`_pickable` (`SceneRegistry.js:43,51`), `setPickingSystem` |
| `Chrome{flags}` | live | `BORDER_FLAGS` bitset, `t.flagged` last-writer maps |
| `Controls{spec[]}` | live | `TerminalGrid.CONTROL_SPEC` + `_initControls/_layoutControls/setControlActive` |
| `Zoom{factor}` | **durable** | `ScaleModel.user`, `view.zoom`, `dock3d.tiles[].zoom` |
| `TerminalGeometry{cols,rows}` | **durable** | `view.cols/rows`, `TerminalGrid.cols/rows`, PTY bridge |
| `Viewport{window,frameRows,scrollOffset}` | **durable** | `CodeGrid._win*`, `_frameRows`, `_scrollOffset` |
| `Fold{LayoutParams}` | **durable** | `CodeGrid.config.layout` (zero stations today) |
| `Residence{kind,holder,order}` | **durable + live index** | `view.docked`/`dockOrder`/`view.carrel`, `carrelManifest`, both `entries` Maps, `dock.tiles`, `AttentionManager.docks`, `lane.pinned` |
| `Home{parentId,pos,quat,placement,bounds}` | **durable** | `DockEntry.home*`, `CarrelEntry.home*`, `parkedParent`, `lane.pinnedPos` |
| `Position{xyz, authority}` | **durable** | `view.position`, `files[].x/y/z` scrape, dead `positionIsDerived` |
| `HolderConfig` | **durable** | `Carrel.serialize().params`, dock knobs |
| animation targets, hover, caret, cull visibility | **neither** | runtime fields on the live object |

`Residence` resolves systems-runtime's open Tension A as **durable with a live index**: `carrelManifest`
already proves the durable form is the one that must survive an entity not existing yet. The live
index (`holderOf(id)`) is a derived query, rebuilt on registration.

**Systems:** `Motion` · `Holder` (×2 placement strategies) · `Projection` · `VisualState` ·
`PickMembership` · `Lifecycle/Prune`. Config stays **out** — see the frame order and the carve-out below.

### Slices, blast radius, acceptance test

| # | Slice | Blast radius | Acceptance test |
|---|---|---|---|
| −1 | Delete `GridVirtualizer` + `CodeGrid.unloadContent/reloadContent` | `collections/GridVirtualizer.js`, `collections/index.js`, `src/index.js`, `CodeGrid.js` (−90), `tools/carrel.test.mjs:271` | full `tools/*-check.mjs` suite green; `carrel.test.mjs` passes with its virtualizer section removed |
| 0 | Holder protocol: `ctx.holders` + `holderOf(id)` | `CommandProvider.jsx`, `carrelCommands.js` (delete `findCarrelOwner`), `windowCommands.js:177-179`, `SessionStore.js:103-105`, `CarrelsPanel.jsx`, `bookCommands.js`. **Fold `AgentBooks` lanes in or exclude in writing.** | zero per-frame behaviour change; `dock-persist-check` + `carrel.test` byte-identical results; reversible in an afternoon |
| 0.5 | Free fixes, no ECS: `grid.move` writes model + drops the dead branch; `setWorldPosition` deleted incl. the `placeInView:1071` gate; `gridVisualState` re-keyed index→id; `positionIsDerived` wired or deleted; `file.open` usage string honest | 5 files, ~30 lines | each closes a named bug in §Settled 24–27 with one new harness assertion |
| A | Name components in memory; file shape unchanged | `WorkspaceModel.js`, `SessionStore.js` | `session-schema-tolerance-check` unchanged; capture output byte-identical |
| B | `Residence` + `Home`; close the carrel fork **toward the model**; delete `Carrel.serialize().members` + `carrelManifest` + `AttentionManager.docks` | 2 holders, 4 handler files, `SessionStore`, `CanvasInteraction`, 3 harnesses | `dock-persist-check` + a new `carrel-persist-check` prove dock and carrel round-trip **through the same path**; re-adopt order fuzzed |
| C | `Position{authority}` + remove the `files[]` scrape + the snapshot-key move, **together** | `SessionStore` capture/restore, `fileCommands` | drop a bulk-loaded tree grid → reload → it stays dropped (Ivan's open bug) |
| D | Component-keyed projector; `_fire({type,id,op})` | `SceneRegistry`, `SessionStore`, `HudPanel` | HUD poll deleted, HUD still live; `loadstorm-check` batching invariants hold |
| E | Motion consolidation | both holders, `ContentTreeMotion`, `Book` | intra-frame order unified **deliberately**, `dispose()` object-scoped not global clear (bug 30), keyed by entity id once lanes+dirs are entities |

### Explicit frame order (replaces today's mount-order accident)

`Input → command/mutation drain → Motion → Holder → Projection → Overlay → VisualState → Cull → Render`

Record today's implicit invariants as preserve-or-deliberately-change: `AgentRunner` mounts before
`DockRunner` (`CommandProvider.jsx:800-801`), so agent books ease before carrels re-seat them; the
twins' opposite intra-frame order (bug 31); `Minimap` must stay last (priority 1).
**Order as data — a list in one file, not a framework.**

### What NOT to convert

Per-glyph instance buffers and the atlas · `CodeGrid._relayout`'s fold→arrange→bounds→decorate
pipeline · `TerminalEmulator`/the PTY (an external child) · `ViewerCameraController` (60Hz integrator
that owns pitch/yaw) · `PaneTree` (a real BSP data structure) · the picking channels (only
*membership* becomes a tag) · `ContentTree`'s hierarchy (transforms compose down it;
`_pruneEmptyUp`'s docstring shows membership-retained/parenting-moved is already the away-residence
model) · **the 157 settings closures** — they target world singletons, not entities; the right fix is
a declarative `setting → (subsystem, param)` table that also deletes the 13 boot-folds.

---

## Implementer Vote

**I vote for `state-persistence` to write the final study document.**

Closest to the converged position: its Round 2 slice list (−1 → 0 → 0.5 → A → B → C → D → E) *is*
the converged plan — it adopted systems-runtime's holder protocol ahead of its own Slice A, adopted
my two-tables-one-key rule explicitly as the opening law of Slice A, and endorsed the edge-triggered
reparent rule "without reservation." Fewest unresolved dissents against that position: all four of
its dissents are *refinements inside* it (positionIsDerived is dead, so C is greenfield; the
`files[]` scrape is a snapshot key, so "schema last" needs one qualified exception; carrel authority
must move to the model; and my `ctx.n` claim was wrong) — none is a carve-out from the design.
Systems-runtime, by contrast, still carries two genuinely open tensions it introduced (where `Held`
lives, whether the Motion merge is worth its frame change) plus a correct but structural carve-out
(settings are singletons, not components).

Decisive tiebreaker: state-persistence retracted four of its own claims across two rounds —
including its own headline `AttentionManager.docks` recommendation and one of its own station-table
rows — which is the best available predictor of a final document that will not over-claim. It also
produced the one artifact both other lenses adopted as the acceptance test: **a component is done
when its stations collapse from N to 2.**

Conditions on the vote — the final document must carry, not paraphrase: (a) **two tables, one key**
as a top-level law with the per-component table assignment above, since "add a component" is
ambiguous at every call site without it; (b) **systems-runtime's frame-order list and its
settings-are-singletons carve-out** verbatim, as those are the two things neither other lens
produced; (c) the **method** behind the duplication figure (19–30%), never a single number; and (d)
the twelve live bugs of §Settled 23–31 as a standalone section — several are worth shipping this
week with no ECS at all, and they are the study's most immediately usable output.

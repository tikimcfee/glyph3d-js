# Round 3: state-persistence convergence

## Settled

**Design positions — 3/3 after two adversarial rounds.**

1. **No performance win.** 10¹–10³ window entities; hot paths are already flat typed arrays inside one
   entity. Justify on station count, deduplication, and correctness-by-construction — never speed.
2. **Two tables, one key.** `SceneRegistry` = **live** components (dies with the object);
   `WorkspaceModel.surfaces` = **durable** components (outlives it — the only reason async PTY
   re-adopt works, `SessionStore.js:216-218`); the string registry id is the join. Merging them
   destroys the durable buffer; ignoring the split makes you hand-roll a third table, which is
   literally what `carrelManifest` is. *(entity-substrate's T1; systems-runtime retracted "one
   table" in R2 #7; I adopted it in R2. Every component's schema must name its table.)*
3. **One `Residence`/`Held` component, TWO holder systems** — not one holder class with an `anchor`
   flag. The deliberate, documented `extentFromBox` divergence (`Carrel.js:78-82`; consumed as
   `2·|cx|` at `CameraDock.js:634` vs `ext.w` at `Carrel.js:439`) is the counter-example, and
   entity-substrate retracted the class merge in R2 R6.
4. **The holder duplication is a persistence-authority fork, not a code-reuse failure.** Dock capture
   reads the model (`SessionStore.js:256`); carrel capture scrapes the live object (`:287`);
   `view.carrel` is written from six sites and read by none. Both reviewers adopted the reframing.
5. **Close the carrel fork toward the MODEL, in one change.** Delete `Carrel.serialize().members` +
   `carrelManifest`; keep the writes at `carrelCommands.js:61`. Choosing the live object would make
   the durable buffer a dock-only privilege forever. *(systems-runtime R2 synthesis 0.5 concurs;
   entity-substrate leaves the direction open — this is the one place I resolve it.)*
6. **The holder protocol (`ctx.holders` + `holderOf(id)`, ~40 lines) ships before any component.**
   Zero per-frame change, reversible in an afternoon. All three now agree; entity-substrate moved off
   its week-long first cut.
7. **Structure is edge-triggered.** `Object3D.attach()` is world-preserving and therefore *writes*
   `position`/`quaternion` (`CameraDock.js:471`, `Carrel.js:229`), so reparenting fires on holder
   *change* only — never as a level-triggered reconcile, or idempotent re-run
   (`STATE_ARCHITECTURE.md:44`) breaks.
8. **Verb-reachable state applies synchronously; only frame-continuous state is pulled**
   (`STATE_ARCHITECTURE.md:133` + the `tools/*-check.mjs` harnesses).
9. **`_fire({type, id, op})` before any component-level event** — kills `HudPanel.jsx:78`'s 150ms
   poll and lets the projector touch one id instead of sweeping every surface.
10. **Settings are NOT components** (systems-runtime's dissent, which I adopt and which corrects my
    own Phase 0 `Overlay` row): 157 `apply:` closures + 13 boot-folds target *singletons*. A
    declarative `setting → (subsystem, param)` table is the right fix.
11. **Order as data, not machinery** — one ordered list in one file, not a scheduler framework.
12. **`AttentionManager.docks` is deleted as a small breaking change**, atomic with
    `AttentionManager.js:223`, `attentionCommands.js:94`, `dock-dismiss-check.mjs:47`,
    `dock-refresh-check.mjs:205` — *not* for the reason I originally gave.
13. **Re-grep before implementing.** All three documents' citations drifted 9–15 lines mid-study.
    Cite symbols alongside lines.

**Corrected numbers of record** (replacing every Phase 0 figure):

14. Holder duplication: **159** byte-identical / **170** strip-identical / **117** >3 chars /
    **73** >20 chars / **43** >30 chars, of 389 non-comment `Carrel.js` lines. Publish the method.
    Not 44%. The 73 are concentrated in `lock`/`release`/`dismiss`/`homeOf`/`pruneDismissed`/
    `_userOf`/`reachesScene` — exactly what `Residence` absorbs (entity-substrate D3 is right that
    the *shape* survived the shrink).
15. **7** `useFrame` sites · **12** live registry subscribers (13 registrations, 1 dead), **none**
    reading the `type` arg · **157** `apply:` closures · **13** `applyGroupSettings` call sites ·
    **6** `setEnabled` twins · **20–21** `setSurfaceView` write sites · **4** domain-class
    `instanceof` (all `gridCommands.js:364,410,473,503`, all `CodeGrid`) and **zero** in the
    rendering core · **3** full dock-then-carrel scans (~14 holder questions total) ·
    `window.drop` four paths → two.
16. **`reachesScene` is verbatim; `extentFromBox` is not** — split confirmed by all three.
17. **`AgentBooks.js:842,866,882` — three sites**, two forms (`=== this.root` pin-guard, `!==`
    borrowed-skip). *I retract my Round 1 E7; entity-substrate and systems-runtime were right.*
18. **`ctx.gridVisualState` exists** (`CommandProvider.jsx:180`); there is no `ctx.n`.
    entity-substrate's E3 is withdrawn by measurement — systems-runtime's citation was correct.

**Live bugs the study found** (each shippable independently of any ECS work):

19. `grid.move` (`gridCommands.js:271-289`) moves a grid, writes no model fact, schedules no save —
    movers'-law violation at the move verb.
20. `file.open`'s `[x y z]` is captured (`SessionStore.js:180-181`), replayed (`:638`) and
    **never consumed** (`fileCommands.js:92` reads only `args[0]`) — while the usage string
    advertises it.
21. `view.carrel`: ~6 writes, **0 reads**.
22. `pinAutoDocked` lives in the durable buffer and is **never serialized**.
23. **`positionIsDerived` has zero production callers** — only its export (`SessionStore.js:85`) and
    `tools/dock-persist-check.mjs:11,161-164`, despite a docstring claiming it is *"the one subtle
    discriminator the projection and capture paths share"*. `STATE_ARCHITECTURE.md:82,135` is wrong.
    ⚠️ *Found in my Round 2; neither reviewer has cross-verified it yet — re-run the grep first.*
24. A **bulk-loaded (non-sheet) grid** has *no* position authority serialized at all: `file.openDir`
    never calls `openSheet` (only `file.open` does, `fileCommands.js:98`), and capture's `files[]`
    loop iterates sheets. Three tiers: tab-backed = wrong authority; bulk = no authority; both = no
    applier.
25. `ctx.gridVisualState` is keyed by grid **index** → a registry reorder silently mis-restores.
26. `CodeGrid.config.layout` (fold) has **zero** persistence stations — resets on every reload.
27. A **loose** code grid's zoom is written to the model and never serialized (capture's
    `kind !== 'terminal'` skip, `SessionStore.js:221`).
28. `ViewerCameraController.placeInView` (`:1071`) hard-refuses any object without
    `setWorldPosition` — so a `CodeGrid` can never be placed by it, though its docstring says
    "grid / terminal". A dead alias used as a capability gate.
29. `setWorldPosition` is a pure `position.set` alias (`TerminalGrid.js:633`, `FrameGrid.js:372`);
    `setGroupOffset` is never called from either.
30. `GridVirtualizer` is dead and is the sole caller of `CodeGrid.unloadContent`/`reloadContent`
    (~540 lines total).
31. `SpatialAnimator.dispose()` is a global `_active.clear()` called from a live path
    (`Carrel.js:704` ← `CommandProvider.jsx:230`) — harmless today (per-holder animators), a
    correctness bug the moment they merge.

## Implementation Plan

### The model: two tables, one key

| Component | Table | Serialized? | Notes |
|---|---|---|---|
| `Residence{kind, holder, order, by}` | durable | yes | absorbs `view.docked`+`dockOrder`, `view.carrel`, `carrelManifest`, holder `entries`, `dock.tiles`, `AttentionManager.docks`, `lane.pinned`. `by:'user'\|'pin'` replaces `pinAutoDocked`. |
| `Position{x,y,z,authority}` | durable | iff `authority==='intent'` | replaces `view.position`, `files[].x/y/z`, `positionIsDerived` |
| `Orientation{quat,authority}` | durable | iff intent | the drop billboard (`windowCommands.js:208`) |
| `Zoom{factor}` | durable | yes | `ScaleModel.user`; one home for docked **and** loose |
| `TerminalGeometry{cols,rows}` | durable | yes | stream remains the only *writer* |
| `Viewport{window,frameRows,scrollOffset}` · `Fold{params}` | durable | yes | `Fold` closes bug 26 |
| `BookView{head,following,limit}` · `HolderConfig{pose,knobs}` · `Framed{}` | durable | yes | |
| `Handle{obj3d}` · `Tags{species,role,pickable,cullable}` · `Extent{w,h,cx,cy,cz}` | live | no | `Tags` retires `_pickableTypes`/`CULL_TAGS`/`role\|\|type` |
| **`Home{parent,pos,quat,placement,bounds}`** | **live** | **no** | **re-captured at lock from `Position`/layout** |
| `Motion{tween}` · `Chrome{flags}` · `Controls{spec}` · `PickTarget{channels}` | live | no | |
| attention `primary`/`key`, field `layout`/`camera` | world singletons | yes | not per-entity |

**Why `Home` is live** — and why it explains the whole bug family. The dock already re-derives home
at re-lock: `_reconcileDock` calls `cd.lock(id, grid, {order})`, which snapshots the grid's *current*
transform, which the projector set moments earlier from the durable fact. So home never needed to be
durable — **provided `Position{intent}` is durable for every kind.** It is not: for a code grid the
durable fact is skipped (bug 27/24), so its home is re-derived from a layout-computed position, and
the window pops back. *The pop-back family is `Home` being derived from a `Position` that was never
made durable.* That single sentence is the study's finding.

**Rule for durability:** a component is durable iff an operator gesture set it and nothing recomputes
it — `STATE_ARCHITECTURE.md:48-77` with a place to live.

### Systems, in declared order (one list, one file)

`Input → Command drain (sync apply per verb) → Motion → Holder(dock) → Holder(carrel) → Projection →
Overlay/Config → VisualState → Cull → Render`

Record today's accidental invariants as preserve-or-deliberately-change:
`AgentRunner` mounts before `DockRunner` (`CommandProvider.jsx:800-801`); `CameraDock.update`
`_relayout`s *before* `animator.update` (`:934,937`) while `Carrel.update` animates *first*
(`:562,575`). **Adopt the dock's order** — the carrel's is the one that forced the `_seat` epsilon
guard (`Carrel.js:449-455`), i.e. it already has a documented workaround.

### Slices, blast radius, acceptance

- **−1 · Delete `GridVirtualizer`** + `CodeGrid.unloadContent/reloadContent` + barrel exports
  (`collections/index.js:13`, `src/index.js:22`) + `tools/carrel.test.mjs:23,271`.
  *Blast:* ~540 lines, one harness section. *Accept:* `rg GridVirtualizer` returns prose only.
- **0 · Holder protocol.** `ctx.holders` + `holderOf(id)`. Callers: `SessionStore.js:103-105`,
  `carrelCommands.js:215,239,301`, `windowCommands.js:177-179`, `CommandProvider` onRemoval double
  prune, `bookCommands.js:156`, `CarrelsPanel.jsx:267`, `gestureResolver.js:148`,
  `cameraCommands.js:67`. **Decide `AgentBooks` in-or-out in writing** (3 inline parent tests + a
  home-less pin). *Blast:* +40/−~60, zero frame change. *Accept:* `dock-persist-check`,
  `term-geom-persist-check`, `carrel.test` pass **unchanged** — that is the whole point.
- **0.5 · Free fixes, no prerequisites.** (a) `grid.move` writes the model + schedules save, and the
  `setWorldPosition` fossil dies at `CanvasInteraction.jsx:459`, `windowCommands.js:206`,
  `gridCommands.js:282`, `ViewerCameraController.js:1071` (bugs 19, 28, 29). (b) re-key
  `gridVisualState` by id (25). (c) **delete** `positionIsDerived` — a function whose only callers
  are assertions is free to remove and returns in slice C as `Position.authority` (23).
  (d) settings → declarative table (10). (e) `_fire({type,id,op})` (9).
  *Accept:* a new drag-a-code-grid → save → reload → assert-position harness (this is the first test
  that can fail today).
- **1 · Close the carrel authority fork toward the model** (5). *Blast:* `carrelCommands.js`,
  `Carrel.serialize`, `SessionStore._restoreCarrels`, `carrel.test`. *Accept:* a
  `carrel-persist-check` mirroring `dock-persist-check`, with **arrival order fuzzed**.
- **A · Name the components in memory; file shape unchanged.** Split `view` behind
  `setSurfaceView`'s existing per-key diff. *Blast:* `WorkspaceModel` + `SessionStore` only.
  *Accept:* byte-identical snapshot for an unchanged session + `session-schema-tolerance-check`.
- **B · `Residence`.** Rules 2, 7 and the `Home`-is-live rule written down first. *Blast:* 2 holders,
  4 handler files, `SessionStore`, `CanvasInteraction`, 3 harnesses. *Accept:* drop-from-dock →
  reload → **stays dropped**.
- **C · `Position{authority}` + remove `files[].x/y/z` + `SCHEMA_VERSION` 2→3 — one slice. This is
  where "schema last" bends, and it must be stated.** Position is the only fact whose two authorities
  live in *different snapshot keys*, so moving the authority moves the key; writing both is the dual
  path the house law forbids. No migration shim is needed: forward-additive restore already ignores
  unknown keys, and a v2 file read by v3 simply lacks `view.position` for grids — which degrades to
  exactly today's behaviour (re-derive from layout).
- **D · Component-keyed projector.** `_projectSurfaces`/`_reconcileDock` → dirty-set; **entity
  arrival marks all of that entity's components dirty** (the re-adopt case). *Accept:* instrument
  that one registration touches one id, not every surface.
- **E · Motion consolidation.** Prereqs, all from Round 2: unify intra-frame order (dock's);
  make `dispose()` object-scoped (31); keep the `uuid` key **for now** — id-keying is sequenced
  behind "lanes and dirs become entities", since `type:'dir'` registers only lazily
  (`navigationCommands.js:155`). *Accept:* a motion harness on tween count + end pose.
- **F · Capability tags at `register()`** (entity-substrate D2 — I rank it higher than they do; it
  can land any time after 0.5). Kills the 4 `instanceof` refusals in `gridCommands.js` and the
  `placeInView` gate, and it is the north star's own seam: *glyphs in a frame, differing by layout*.

Non-obvious sketch — the schema is where table + durability live, so "add a component" is never
ambiguous at a call site:

```js
const SCHEMA = {
  Residence: { table: 'durable', serialize: true },
  Position:  { table: 'durable', serialize: (c) => c.authority === 'intent' },
  Home:      { table: 'live',    serialize: false },   // re-captured at lock from Position
};
// Residence system — EDGE-triggered only: attach() is world-preserving and writes the transform.
if (prev?.holder !== next?.holder) holderFor(next.holder).attach(entity);
```

### What NOT to convert

Glyph instance buffers / atlas / shaping · `CodeGrid._relayout` and its arranger/decoration
registries · `TerminalEmulator` and the relay PTY · `ViewerCameraController`'s internals ·
`PaneTree` · the picking channels (membership only) · `ContentTree`'s hierarchy — transforms compose
down it and `_pruneEmptyUp` shows the tree already models away-residence as *membership retained,
parenting moved* ("an away-docked leaf's empty book is the stable home the dock re-attaches to") ·
settings singletons · the dockview 2D layout blob · `AttentionManager`'s three slots.

## Implementer Vote

**I vote for `systems-runtime`.**

*Closest synthesis.* Its Round 2 synthesis already states the converged design in the converged
form: the three rules verbatim (two tables/one key · edge-triggered `attach()` · synchronous apply
for verb-reachable state), the correct slice order (−1 → 0 → carrel-authority → A/B), and — uniquely
among the two candidates — it **names the direction** of the carrel authority fix rather than
leaving it open. It also owns the runtime material (frame order, the six integrators, the settings
family) that the other two lenses only cite.

*Fewest unresolved dissents.* Its three dissents are all *additive*: write the frame order down
(nobody objects), settings-are-singletons-not-components (a correction I explicitly adopt, Settled
10), and slice-0-first (fully converged). Net zero conflicts with the converged position.
entity-substrate still carries D1 (a claim that "nobody has engaged T1", now stale — both of us
adopted it in Round 2) and D3 (partial resistance to the duplication re-measurement), and it owns
the study's most-retracted headline number, so it would be writing an account of its own retraction.

*Conditions on the vote.* The final document must carry three things systems-runtime did not
originate: **entity-substrate's capability-tag dissent (D2)** as slice F; **my slice-C exception**
(schema-last bends for position, with the no-shim argument); and **bug 23** flagged as
verified-by-one-agent-only until re-grepped.

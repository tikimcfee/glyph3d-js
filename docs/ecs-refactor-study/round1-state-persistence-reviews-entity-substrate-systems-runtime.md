# Round 1: state-persistence reviews entity-substrate, systems-runtime

All counts below were re-run against the working tree. Where the two studies disagree, I state which
is right and why. I lead with an error of my own.

## Errors Found

**E0 — MY error (phase0-state-persistence, §7). `AttentionManager.docks` is NOT "never populated".**
I recommended deleting it outright as "a vestigial fourth copy". Wrong. `CameraDock` writes it
(`CameraDock.js:483` — `{anchor:'camera', offset:{slot}, ts}`), deletes it on release and dismiss
(`:532,:572`), reads it back at `:847,:875`, and **mutates it in place** at `:687`
(`d.offset = {slot:'frame'}`). The stale thing is the *docstring* (`AttentionManager.js:75-78`,
"stubbed empty until L2 lands"). It is a live mirror that duplicates `entry.slot` and stores a
frame marker found nowhere else — deletable only after those two reads move. entity-substrate's
"five docked copies" (conclusion 5 table) is the correct count; my "four, one dead" was not.

**E1 — entity-substrate: `extentFromBox` is NOT a verbatim copy.** Conclusion 2 claims
`CameraDock.js:91-112 ≡ Carrel.js:69-92`. `reachesScene` *is* byte-identical (`CameraDock.js:90-98`
≡ `Carrel.js:68-76`). `extentFromBox` is not: Carrel returns an extra `w` field and its docstring
says so explicitly — *"Width is the plain box span — anchor-agnostic, unlike the dock's 2·|cx| form,
which assumes top-left-anchored content"* (`Carrel.js:78-82`). systems-runtime is right ("near-twin;
width formula differs"). This matters: the divergence is **deliberate and documented**, which is
direct evidence for systems-runtime's caution that the two `_relayout`s must stay separate
strategies.

**E2 — entity-substrate: the "44% / 170 of 389 byte-identical" figure is arithmetically true and
materially inflated.** I reproduced it exactly (389 non-comment Carrel lines, 170 matching some
CameraDock line). But **53 of the 170 are ≤4 characters** (`}`, `});`, `return false;`-class), and
only **73 are longer than 20 characters**. Substantive duplication is therefore **~19%**, not 44%.
The metric is also multiset containment, not structural duplication — `const e = this.entries.get(id);`
alone contributes 3 matches. The real duplication is still worth the slice; the headline number
should be *73 substantive lines + 13 mechanics*, which is defensible.

**E3 — entity-substrate: "exactly 4 `instanceof` sites in the whole app" is false as stated.** There
are **10** in `app/` — the 4 `instanceof CodeGrid` checks are real (`gridCommands.js:364,410,473,503`),
but six more are `instanceof Map` (`carrelCommands.js:37,210`; `SessionStore.js:104,287,471`), and
`packages/glyph3d-core/src` adds 11 more. Ironically `SessionStore.js:104` — the held-scan the whole
study wants to delete — *is* an `instanceof` site. The capability-oriented conclusion survives; the
superlative does not.

**E4 — the registry-subscriber count: entity-substrate says 7, systems-runtime says 13, actual is
12 live.** Verified `addChangeListener` call sites: `CanvasInteraction.jsx:124`,
`CommandProvider.jsx:532,554,736,748`, `HudPanel.jsx:77`, `SessionStore.js:861`,
`EditorPanel.jsx:104`, `FileTree.jsx:257`, `RepoPanel.jsx:97`, `TerminalsPanel.jsx:98,160` = 12.
entity-substrate missed the four panel files entirely. systems-runtime's 13 counts `syncVolumeCovers`
(`CommandProvider.jsx:~448`), which is **not** a registry listener — it runs on tree relayout — and
omits `SpatialWindowManager.js:85`, which *is* one but is null in the r3f client
(`STATE_ARCHITECTURE.md:109`). Net: systems-runtime is far closer.

**E5 — entity-substrate: "8 `useFrame` hooks" → there are 7.** `CanvasInteraction.jsx:231,882`,
`CommandProvider.jsx:202,219`, `Minimap.jsx:103`, `SceneEnvironment.jsx:110`, `ViewerCamera.jsx:56`.
systems-runtime's table is exactly right, including the priority-1 Minimap note.

**E6 — entity-substrate: "27 writers" of `view`.** Actual `setSurfaceView` call sites: **21**
(carrelCommands 2, dockCommands 6, terminalCommands 4, windowCommands 7, SessionStore 2), of which
19 are verb-side and 2 are restore-side.

**E7 — entity-substrate: AgentBooks re-derives `borrowed` at "three separate sites (`:842,866,882`)".**
`book.parent !== this.root` appears at **two**: `AgentBooks.js:866,882`. `:842` has no such test.

**E8 — systems-runtime: "**eight** `applyGroupSettings` calls" undercounts.** There are **12** in
`CommandProvider.jsx` (`:428,429,430,431,432,433,434,490,508,510,534,708`) plus one in
`structureCommands.js:117` = **13**. This strengthens their argument, so the fix is upward.

**E9 — systems-runtime: `window.drop` does not collapse to "`release(id,{to:dropPose})` with no
`docked ? … : carrel ? … : loose` at all".** The drop pose is computed **from the holder's home
before the release** (`windowCommands.js:179-180` — `holderHome` feeds `dropPose`'s landing scale),
and the loose branch does parent-space conversion with no holder to ride
(`:203-212`, `g.parent.worldToLocal`). Under a holder protocol it becomes two lookups
(`holderOf(id)?.homeOf(id) ?? null`, then one release) — a real win, but not zero branches. Claiming
zero will produce a slice that silently drops the loose-in-a-tree-parent case.

**E10 — systems-runtime: "HMR: net win… the store lives on `ctx`, which already survives".** The
`ctx` does **not** survive a scene rebuild — that is precisely why restore is keyed per *scene
generation*: *"the ctx is born with the scene"* (`SessionStore.js:829-837`). A store on `ctx` dies
with the scene, so HMR is neutral at best; the durable buffer survives only because it is
re-restored from the file. Do not bank a win here.

**E11 — both, non-culpable: line cites into `CommandProvider.jsx` have drifted ~9 lines during this
study** (523→532, 545→554, 727→736, 739→748). The tree is live. The synthesis should re-anchor
citations, not trust ours.

## Gaps

- **Mine, missed by both:** `view.carrel` has **zero readers** — written from 6 sites
  (`carrelCommands.js:61`), never captured, never projected. Carrel membership persists through a
  *parallel* pipeline (`Carrel.serialize()` `:687` → `carrelManifest` → `serveManifest`
  `carrelCommands.js:207`). **The twins have opposite persistence authority**: dock capture reads the
  MODEL (`SessionStore.js:256`), carrel capture reads the LIVE OBJECT (`:287`). entity-substrate
  lists `view.carrel` as a "seated copy" without noticing it is dead.
- **Mine, missed by both:** `file.open`'s `[x y z]` is captured (`SessionStore.js:181`), replayed
  (`:626`) and **never consumed** (`fileCommands.js:92-155` reads only `args[0]`); and `grid.move`
  (`gridCommands.js:271-289`) never writes the model — movers' law violated at the move verb.
- **Mine, missed by both:** zoom is persisted in **two shapes split by holder**
  (`terminals[].zoom` `:229` vs `dock3d.tiles[].zoom` `:258`); `CodeGrid.config.layout` (fold) has
  **zero** persistence stations.
- **systems-runtime's, missed by me:** the 157 `settings.js` `apply:` closures (verified exactly 157)
  + 6 `setEnabled` twins (verified exactly 6: `ContentTreeMarkers:91`, `Probes:59`, `Arrows:130`,
  `Labels:259`, `Motion:71`, `OcclusionCuller:119`) — an entire toggle family living outside the
  model. My station analysis stopped at `view`.
- **systems-runtime's, missed by me:** `ctx.gridVisualState` is `Map<number, …>` keyed by grid
  **index** (`gridVisualState.js:8,21-29`, resolved via `ctx.getGrids()[gridIndex]`) — a latent
  identity bug that directly contradicts "ids are already the spine".
- **entity-substrate's, missed by me:** `setWorldPosition` is a pure fossil — `setGroupOffset` is
  called only from `ContentTreeLabels.js:310,426`, never from `TerminalGrid`/`FrameGrid`. (Their "4
  call sites branch on it" is 3 branches + 1 direct call + 1 internal call from
  `TerminalGrid.applyView:653`.)
- **Missed by all three:** `gridCommands.js:364,410,473,503` refuse terminals from
  `grid.window/layout/scroll/frame` by **class**, not capability — the four `instanceof` sites are
  exactly the north star's seam, and none of us costed converting them.

## Tensions

**T1 — one holder function vs one holder relationship.** entity-substrate's smallest first cut is
"fold `CameraDock` and `Carrel` into one holder parameterized by (anchor, layout)"; systems-runtime
warns "forcing them into one function is how you get a second system pretending to be one" and keeps
placement pluggable. **systems-runtime is correct**, and E1 is the proof: `extentFromBox` already
diverged deliberately (`Carrel.js:78-82`), as did the intra-frame order (`CameraDock.update` relayouts
*before* `animator.update` at `:934,937`; `Carrel.update` animates first at `:562,575`). Unify the
**relationship** (`Held`/`Home`), not the class.

**T2 — sequencing, and where the schema bump goes.** systems-runtime: Slice 0 = holder *protocol*
(no ECS), Slice 3 = `Held`, with "a schema bump rides along". entity-substrate: first cut *is*
`HolderSystem` + `Home`/`Held`. Mine: schema **last**, never bundled. **Correct order is
systems-runtime's, with my amendment**: Slice 3 must serialize `Held` back into today's `dock3d` +
`carrels` keys unchanged. Reason from code: quarantine operates per **snapshot key**
(`SessionStore.js:308-313`) — if `dock3d` and `carrels` merge into one key while their *authorities*
also merge (T3), a single failed phase quarantines both holders' state at once, and a rollback reads
a shape it cannot restore.

**T3 — which carrel authority survives.** Neither study noticed the split. Because dock persistence
reads the model and carrel persistence reads the live object, `Held` cannot be introduced without
**deleting one of the two pipelines outright** (no-compat-shims forbids keeping both). Deleting
`Carrel.serialize().members` + `carrelManifest` in favour of the model is the coherent direction —
the manifest is literally "a `Held` component on a not-yet-live entity", which the dock already gets
for free from the durable buffer (`SessionStore.js:770-775`).

**T4 — parent vs component authority.** entity-substrate conclusion 9 poses it sharply and proposes
`Held` authoritative + a `ParentingSystem` as the one `attach()` writer; systems-runtime leaves it
open. **entity-substrate is right**, with a persistence caveat neither raised: `Home.parent` must
serialize as an **entity id**, never an `Object3D` ref — `Carrel.js:281` already documents the
failure ("home parent may have been pruned — fall back").

**T5 — pull-based toggles vs synchronous verbs.** systems-runtime honestly flags the collision with
`STATE_ARCHITECTURE.md:133` ("apply must be synchronous or read-after-write breaks"); entity-substrate
does not raise it. Resolution the code already implies: **verb-reachable components apply
synchronously on write; only frame-continuous state (glide, breathing, ghost pulse) is pull-based.**
That is exactly the split between `setSurfaceView`+`applyView` and the animators today.

**T6 — consensus worth recording:** all three lenses independently concluded ECS buys **no
performance** here (10¹–10³ window entities; hot paths already flat arrays). Nobody should sell it
on speed.

## Recommendations

1. **Slice −1: delete `GridVirtualizer`.** All three verified it is unwired (only
   `tools/carrel.test.mjs:271` instantiates it). Pure subtraction, and it removes a phantom third
   holder from every later slice.
2. **Slice 0: holder protocol (`ctx.holders` + `holderOf(id)`), no components yet.** Deletes
   `findCarrelOwner`, the `held` scan (`SessionStore.js:103-105`), the double prune, and the sweep's
   dock checks — with zero per-frame change. Adopt systems-runtime's ordering over entity-substrate's.
3. **Make `extentFromBox` the acceptance test for holder unification**: one `Extent` measure taking
   an anchor parameter (`top-left` vs `centered`), reproducing both current results exactly.
4. **Before `Held` lands, pick ONE carrel persistence authority and delete the other** (T3). Today
   `view.carrel` is written 6× and read 0×; `Carrel.serialize().members` is the real pipeline.
5. **Do not bundle the on-disk schema bump into the `Held` slice.** Serialize `Held` into today's
   `dock3d` + `carrels` keys; bump `SCHEMA_VERSION` in its own slice, last.
6. **`Home.parent` serializes as an entity id, never an object ref** (`Carrel.js:281`).
7. **Key the merged Motion system by ENTITY ID, not `object.uuid`.** `SpatialAnimator.js:48` keys on
   `${object.uuid}:${property}` — collision-free (systems-runtime is right) but it orphans in-flight
   tweens when a grid id is re-pointed to a new object, the exact self-heal
   `CanvasInteraction.jsx:876-880` relies on.
8. **Ship `_fire({type, id, op})` before any component-level event.** That alone kills
   `HudPanel.jsx:78`'s 150ms poll and lets `_projectSurfaces` project **one** id instead of iterating
   every surface — which is the pop-back amplifier, not just a perf item.
9. **Kill the `setWorldPosition` fossil in the same change as the first capability tag** — 3 branches
   (`CanvasInteraction.jsx:459`, `windowCommands.js:206`, `gridCommands.js:282`) plus 2 direct calls.
10. **Re-key `ctx.gridVisualState` from grid index to registry id** (`gridVisualState.js:8,21-29`)
    before any work that reorders the registry.

## Key Insight

All three lenses converged on the same two objects — `CameraDock` and `Carrel` — but each of us
diagnosed the duplication as a *code-reuse* failure, and it is not. It is a **persistence-authority
split**: the dock's truth is the WorkspaceModel (`SessionStore.js:256` captures `ws.listDocked()`),
the carrel's truth is the live Object3D (`:287` captures `Carrel.serialize()`), and `view.carrel` —
written from six sites at `carrelCommands.js:61` — is a write-only stub sitting exactly where the
model fact should have been. That reframes the whole slice: "one Holder system" is not a dedup
exercise you can measure in duplicated lines (and the honest number is 73 substantive lines, not
170), it is a **choice of authority** in which one of two working persistence pipelines must be
deleted outright, per the no-compat-shims law. That is also why `Held` is a genuine ECS win rather
than a refactor of convenience: a component forces the question that two holder classes let you
avoid for eight months — and the carrel manifest, the dock's durable buffer, and Ivan's "dropped
wants to be a residence state" are all the same unanswered question wearing three costumes.

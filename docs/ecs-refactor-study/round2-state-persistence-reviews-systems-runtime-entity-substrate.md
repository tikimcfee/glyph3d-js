# Round 2: state-persistence reviews systems-runtime, entity-substrate (inverse)

Read order this round: systems-runtime first, entity-substrate second, then all three Round 1 files.
Every disputed fact below was re-run against the tree.

## Reaffirm or Retract

**1. `AttentionManager.docks` "never populated" — RETRACT, fully. Settled.**
Both reviewers are right and I self-corrected in Round 1; here is the closed form. It is written on
lock (`CameraDock.js:483-487`), deleted on release/dismiss (`:532,:572`), mutated every relayout
(`:687,:847,:875`), read into the state dump (`AttentionManager.js:223`) and printed by
`attention.info` (`attentionCommands.js:94`). It is asserted by harnesses I verified directly:
`tools/dock-dismiss-check.mjs:47` (`ok(!dock.attentionManager.docks.has('t1'), …)`) and seeded by
`tools/dock-refresh-check.mjs:205`. **Settled position:** keep the *delete*, strike the *reason* —
it is a redundant projection of `CameraDock.entries`, not an unpopulated stub — and scope it as a
4-site atomic change. One detail neither reviewer caught: `:687` writes `d.offset = {slot:'frame'}`,
which is the **only** record of frame occupancy in the attention dump (`cd.focusedPane` is the live
truth). The delete must therefore decide whether `attention.info` keeps reporting frame occupancy,
or that datum vanishes with it.

**2. Conclusion 3 vs my own §2 table on code-grid position — RETRACT the prose, REAFFIRM and
sharpen the substance.** entity-substrate (E2) is right that "written to a buffer nothing
serializes" reads as "the position is not serialized", which is false for a *tab-backed* grid:
`capture()` scrapes `grid.position` into `files[].x/y/z` (`SessionStore.js:167-197`). Their framing
— **two authorities for one fact, and restore consumes neither** — is better and I adopt it.
But their correction is incomplete in my favour, and the code says so: `openSheet` is called **only**
by `file.open` (`fileCommands.js:98`); `file.openDir` creates no sheets. So a **bulk-loaded tree
grid has no sheet, is not in `files[]`, and has neither authority serialized** — my original
sentence is literally true for exactly the case Ivan named (drop a file grid that came from a dir
pop). The defect has three tiers, not two: tab-backed grid = wrong authority; bulk grid = no
authority; both = no applier (`fileCommands.js:92` reads only `args[0]`).

**3. NEW retraction, mine and everyone's: `positionIsDerived` has ZERO production callers.**
Exhaustive grep: `SessionStore.js:85` (the export) and `tools/dock-persist-check.mjs:11,161-164`
(import + 4 assertions). Nothing else in `app/` or `packages/` calls it. Its own docstring
(`SessionStore.js:82`) claims it is *"the one subtle discriminator the projection and capture paths
share"* — verifiably false; neither path calls it, and `capture()`'s `files[]` loop scrapes
`grid.position` unconditionally. Consequences: my §2 table lists a "Derived policy" **station that
does not execute** (retracted — the code-grid row is weaker still); entity-substrate's verify-first
premise correction *"positionIsDerived is live and tested"* is half wrong (**tested, not live**); and
systems-runtime's T4 is a debate about a harness-only function. `STATE_ARCHITECTURE.md:82,135`
should be corrected too.

**4. RETRACT my Round 1 E7** ("AgentBooks re-derives borrowed at two sites, not three"). systems-runtime's
defence is correct: `AgentBooks.js:842` is `lane.book.parent === this.root` — the *positive* form of
the same inline predicate, inside `_relayout`. entity-substrate's three sites (`:842,866,882`) stands.

**5. REAFFIRM under challenge, with new evidence: an explicit per-entity position authority is an
INPUT, not a stored output.** systems-runtime T4 argues storing `authority` violates
store-inputs-not-outputs and proposes instead that `window.drop` *remove tree membership*.
Re-verified: `ContentTree.remove(path)` (`:283-299`) disposes the book and deletes it from `_leaves`
**and** `_books` — and `_pruneEmptyUp`'s own docstring says why that is fatal here: *"Durable BOOKS
are never husks: an away-docked leaf's empty book is the stable home the dock re-attaches to, so its
dir must survive."* The tree **already models away-residence as membership-retained /
parenting-moved**. Removing membership on drop destroys the home anchor the dock and carrel both
re-attach to. And on the principle: the *gesture* "I placed this here myself" is an operator input;
only the resulting xyz is an output. `STATE_ARCHITECTURE.md:73` lists the tree-laid **position** as
an output — never the choice to opt out of layout. Position held.

**6. REAFFIRM by correcting entity-substrate's E3: `ctx.gridVisualState` exists; there is no `ctx.n`.**
`CommandProvider.jsx:180` declares `gridVisualState: new Map()`, and `gridVisualState.js:7` says
`ctx.gridVisualState`. systems-runtime's citation was right; entity-substrate's "correction" is
false. The substantive finding (index-keyed → a registry reorder mis-restores) is unaffected and
still worth fixing.

## Evolved Understanding

- **Confirmed under attack:** `view.carrel`'s zero readers, the dock/carrel opposite-authority split,
  `grid.move`'s missing model write, `file.open`'s dead x/y/z, `pinAutoDocked` unserialized,
  `SURFACE_PROJECTORS`'s single entry. Both reviewers tried and failed to break all six; the station
  framing was adopted by both as the design's acceptance test, which I did not expect.
- **Broken (mine):** the `docks` claim; the AgentBooks 2-vs-3 count; the "Derived policy" station.
- **Refined, not broken:** the holder-duplication magnitude. My >20-char threshold gives 73 of 389;
  systems-runtime's >3-char threshold gives 100 of 389. Both are correct by their own rule and
  neither is 44%. The converged doc should publish the *method*, not a single number.
- **What changed my mind most:** entity-substrate's T1. I had been arguing "the component store
  already exists — it is `WorkspaceModel.surfaces`", and systems-runtime was arguing "it is
  `SceneRegistry`". The resolution is that **both are component tables and the split is load-bearing**:
  the model is durable and outlives the entity (which is the only reason async PTY re-adopt works,
  `SessionStore.js:216-218`), the registry is live and dies with the object. Collapsing them would
  destroy the durable buffer. That reframes every slice below.
- **Newly persuaded:** systems-runtime's Slice 0 (a non-ECS holder *protocol*) belongs before my
  Slice A. It removes the three full dock-then-carrel scans with zero per-frame change, which makes
  the component work smaller instead of bigger.

## Convergence

High confidence, all three lenses, adversarially tested:

1. **No performance win.** 10¹–10³ window entities; hot paths are already flat arrays. Sell
   deduplication and correctness or don't sell it.
2. **The pieces exist unnamed:** `SceneRegistry` = entity table (`type`/`role` = archetype tag),
   `WorkspaceModel.surfaces[id].view` = component store with change-diffing, `applyView` = apply
   system, `SURFACE_PROJECTORS` = system registry, `holdChanges` = commit barrier,
   load-is-not-replay = the persistence law.
3. **`GridVirtualizer` is dead** (only `tools/carrel.test.mjs:271` instantiates it) — delete first;
   entity-substrate's bonus stands: it orphans `CodeGrid.unloadContent/reloadContent` (~90 lines).
4. **One `Held`/`Residence` component, two holder systems** — not one parameterized holder class.
   The `extentFromBox` divergence (`Carrel.js:78-92` vs `CameraDock.js:104-112`, consumed differently
   at `Carrel.js:439` vs `CameraDock.js:634`) is the proof.
5. **Holder protocol (`ctx.holders` + `holderOf(id)`) before any component**, ~40 lines, no frame change.
6. **The carrel authority fork must be closed in one direction, in one change** (no-compat-shims).
7. **Change events must name what changed**; that alone kills `HudPanel.jsx:78`'s 150ms poll and
   turns `_projectSurfaces` from O(all surfaces) into O(one id).
8. **Synchronous apply at the end of each verb is non-negotiable** (`STATE_ARCHITECTURE.md:133`).
9. **Do not convert:** glyph instance buffers, `CodeGrid._relayout`, the PTY/emulator, the camera
   integrator, `PaneTree`, the picking channels.
10. **Re-grep before implementing** — the tree moved 9–15 lines under all three documents mid-study.

## Remaining Tensions

**T-A — Where the world roots, and the hole in "two tables, one key."** entity-substrate's synthesis
(registry = live components, WorkspaceModel = durable components, string id = entity) is the best
answer produced by this study, and I endorse it. But it only works if *every* entity is in the live
table, and two families are not: **agent lanes are in neither** (`isLive` must union registry +
`agentBooks.lanes`, `CommandProvider.jsx:~540`; `resolveHostable` strips `agent:` and falls through,
`carrelCommands.js:90,101`), and **carrels are in the registry but refused as cargo** by
`resolveSurface` (`dockCommands.js:27`). Decide explicitly: promote lanes to registry entries (my
preference — it deletes the union *and* the prefix surgery), or write down that there are three
tables. Unstated, this is where Slice B breaks.

**T-B — Two authorities for code-grid position; which wins, and when the schema moves.** My call:
**the model wins and the `files[].x/y/z` scrape dies**, because the scrape cannot represent a
non-sheet grid and cannot distinguish "the operator placed this" from "the layout placed this". The
consequence the other two staging plans do not price: removing the scrape **is** a snapshot-key
change, so the "schema last" rule cannot cover it. Slice C is authority *and* key, together, or it
ships a dual path.

**T-C — What replaces `positionIsDerived`, now that it is dead.** Since it never executed, there is
no behaviour to preserve — this is a greenfield decision inside an old file, which makes it cheaper
than all three of us assumed. Two equivalent forms: `Position{authority}` (one field) or a
`Detached` tag the layout system honours (one tag). Either way, tree membership stays
(`ContentTree.js` `_pruneEmptyUp` docstring).

**T-D — Duplication magnitude.** 73 lines (>20 chars) or 100 (>3 chars) of 389, not 170/44%.
Publish the method.

**T-E — Edge- vs level-triggered reparenting.** systems-runtime's T2 is correct and I endorse it
without reservation; I would only add that the rule is not new — `skipPosition` while held
(`SessionStore.js:103-105`) is exactly this rule, applied to one fact, by hand. Generalize it, don't
invent it.

## Synthesis

**−1. Delete `GridVirtualizer`** (+ the orphaned `CodeGrid.unloadContent/reloadContent`). Pure subtraction.

**0. Holder protocol** — `ctx.holders` registry + `holderOf(id)`. Deletes the three full scans
(`SessionStore.js:103-105`, `carrelCommands.js:239`, `windowCommands.js:177-179`) and simplifies
~11 narrower reads. No components, no frame-order change. **Fold `AgentBooks` lanes in here or
exclude them in writing** (entity-substrate rec 7).

**0.5. Free fixes with no ECS prerequisite** (each ~5 lines, each closes a named bug):
`grid.move` writes the model and drops its dead `setWorldPosition` branch; `positionIsDerived` is
either wired or deleted (today it is neither); `ctx.gridVisualState` re-keys from index to id;
`file.open`'s advertised `[x y z]` is either consumed or removed from the usage string.

**A. Name the components in memory, file shape unchanged.** Zero schema risk. Adopt entity-substrate's
T1 rule explicitly at the top of this slice: *registry = live components, WorkspaceModel = durable
components, string id = the join; the durable table outlives the live one.*

**B. `Residence`** — collapse `view.docked`/`dockOrder`/`view.carrel`/`carrelManifest`/holder `entries`
into one component, two systems, pluggable placement. Close the carrel fork **toward the model**;
delete `Carrel.serialize().members` + `carrelManifest`. Write the edge-triggered reparent rule
before the first line.

**C. `Position` authority + the `files[]` scrape removal + the schema bump — one slice** (T-B).

**D. Component-keyed projector.** `_projectSurfaces`/`_reconcileDock` become a dirty-set loop scoped
per entity; arrival marks all of an entity's components dirty (the re-adopt case).

**E. Motion consolidation** — one animator keyed by **entity id, not `object.uuid`**
(`SpatialAnimator.js:48`), with the twins' intra-frame order unified deliberately and harnessed
(entity-substrate E4 is right that the merge is not behaviour-identical until that happens).

**Acceptance test throughout:** a component is done when its stations collapse from N to 2 — a schema
entry and an apply function. That is the only artifact in this study that can *fail* a refactor.

## Dissent

**D1.** I do not accept "`positionIsDerived` is the right seam; flatten nothing" (entity-substrate) or
"keep tree membership as the default derivation" (systems-runtime) as *descriptions of today*. The
seam does not execute (§3). Both are proposals; they should be labelled as such, or the converged doc
will claim to preserve behaviour that has never run.

**D2.** I dissent from freezing the file shape until the last slice. Position is the one fact whose
two authorities live in *different snapshot keys* (`files[]` vs the model), so its authority slice
necessarily moves a key. Both other staging plans put schema last as an absolute; that rule is right
for every fact except this one, and unqualified it will produce exactly the dual path it was written
to prevent.

**D3.** I hold, against no stated opposition but worth pinning: carrel authority must move **to the
model**, not to the live object. Choosing the live object would permanently make the durable buffer —
the mechanism that makes async PTY re-adoption work at all — a dock-only privilege, and would leave
the newer holder unable to hold a member that is not currently in the scene. That is the whole reason
`carrelManifest` had to be invented.

**D4 (minor).** Do not act on entity-substrate's E3: `ctx.gridVisualState` is real
(`CommandProvider.jsx:180`); there is no `ctx.n`.

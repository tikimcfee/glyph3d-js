# Round 1: entity-substrate reviews state-persistence, systems-runtime

Adversarial pass. Every claim below was re-run against the working tree at review time
(≈17:43). Read order: state-persistence first, systems-runtime second.

---

## Errors Found

**E0 — MINE, first: I said "8 `useFrame` hooks". There are exactly 7.**
`ViewerCamera.jsx:56`, `SceneEnvironment.jsx:110`, `CommandProvider.jsx:202`, `:219`,
`CanvasInteraction.jsx:231`, `:882`, `Minimap.jsx:103`. systems-runtime's "7" is correct and my
phase0 §LIVE UPDATES is wrong. Fix mine, not theirs.

**E1 — state-persistence: `AttentionManager.docks` is NOT "never populated". The stated reason for
deleting it is false, and deleting it breaks two harnesses and a verb.**
`phase0-state-persistence.md:340` calls it "a vestigial fourth copy of dock membership that was
never populated". It is populated on every lock (`CameraDock.js:483-487`), mutated on every
relayout (`:686`, `:847`, `:875`), and deleted on release/dismiss (`:532`, `:572`). It is **read**
at `AttentionManager.js:223` (`info()`), surfaced by the `attention.info` verb
(`attentionCommands.js:94`), and asserted on by `tools/dock-dismiss-check.mjs:47` and
`tools/dock-refresh-check.mjs:205`. The *conclusion* (it is a redundant copy that should go) is
right; the *evidence* is wrong, and the deletion is a small breaking change with two test updates,
not free subtraction. `STATE_ARCHITECTURE.md:98`'s framing — "mislabeled 'record of truth'" — is
the accurate one.

**E2 — state-persistence: conclusion 3 contradicts its own §2 table on the code-grid position.**
Conclusion 3 (`:36-39`) says a dropped code grid's position "is written to a buffer nothing
serializes". The §2 table row for `position (code grid)` (`:177`) says the opposite and is right:
capture *does* persist it, via a **live scrape of `grid.position`** into `files[].x/y/z`
(`SessionStore.js:181`, now `:180-181`), with a dock-home special case. So the fact IS serialized —
just from a different authority than the one `window.drop` wrote (`view.position`,
`windowCommands.js:217`). The real defect is sharper than stated: **two authorities for one fact,
and the restore path consumes neither** — `SessionStore.js:638` replays
`['file.open', path, x, y, z]` and `fileCommands.js:92-93` reads only `args[0]`. Verified: the
usage string at `:92` even advertises `[x y z]`. Prose should be corrected to match the table.

**E3 — systems-runtime: `ctx.gridVisualState` does not exist. The ctx key is `ctx.n`.**
`phase0-systems-runtime.md:173-174` cites "`ctx.gridVisualState` is `Map<number, SavedState>`
(`gridVisualState.js:8, 21-29`)". The module is `app/commands/handlers/gridVisualState.js` (not
`app/client/`), and its own docblock says *"State is stored in `ctx.n` (Map<number, SavedState>)"*;
`CommandProvider` declares `n: new Map()`. The substance — **index-keyed, so a registry reorder
silently mis-restores** — is correct and worth keeping; the identifier is not. (Being named `n` is
arguably a second finding.)

**E4 — systems-runtime: "merging N animators is behaviour-identical by construction" is refuted two
paragraphs later by systems-runtime itself.**
`:24-25` and `:305-306` claim the merge is behaviour-identical because `SpatialAnimator` keys are
global (`${object.uuid}:${property}`, `SpatialAnimator.js:48` — verified). But `:219-224` correctly
observes that `CameraDock.update` runs `_relayout()` *before* `animator.update(dt)`
(`CameraDock.js:934,937`) while `Carrel.update` runs the animator *first* (`Carrel.js:562,575`).
One shared animator has ONE call site, so the merge necessarily shifts one of the two by a frame.
Two further merge hazards go unmentioned: `cancelAll(grid)` is used for holder-scoped teardown
(`CameraDock.js:578`, `Carrel.js:238,313`) and `dispose()` is called per-holder
(`CameraDock.js:950`, `Carrel.js:704`) — a shared animator cannot be disposed by one carrel folding.
The merge is still right; "behaviour-identical by construction" is not.

**E5 — both: registry-subscriber counts are wrong in opposite directions. The live number is 12.**
Verified registrations: `TerminalsPanel.jsx:98,160`, `FileTree.jsx:257`, `RepoPanel.jsx:97`,
`EditorPanel.jsx:104`, `CommandProvider.jsx:532,554,736,748`, `SessionStore.js:861`,
`CanvasInteraction.jsx:124`, `HudPanel.jsx:77` = **12 live**. A 13th, `SpatialWindowManager.js:85`,
is **dead** — there is no `new SpatialWindowManager` anywhere (matches
`STATE_ARCHITECTURE.md:109`). systems-runtime's "13" (`:82`) reaches the right number by counting
`syncVolumeCovers`, which is a `ContentTree.onRelayout` subscriber, not a registry one, and by
missing the dead one. state-persistence's "≥ 10" (`:86-88`) is safe but undersells its own case.

**E6 — both: systematic line-number drift, because the tree is being edited underneath us.**
`app/client/CommandProvider.jsx` and `app/client/SessionStore.js` were modified at 17:39 and 17:38
during this study; `fileCommands.js`, `fileLoader.js` and `Book.js` newly appear in `git status`
and `settings.js` has left it. Consequences: state-persistence's registry-hook cites
(`CommandProvider.jsx:523,545,727,739`) are the pre-edit lines (now `:532,554,736,748`); its
`SessionStore.js:155` for the subscription is now `:861` (`:155` is where `_onRegistryChange` is
*defined*); `:626` for the `file.open` replay is now `:638`; systems-runtime's `CULL_TAGS :516` is
now `:525`. All are ±10 and all resolve, but **anyone acting on these docs must re-grep, not
trust the numbers** — this is the shared-tree hazard, live.

**E7 — systems-runtime, minor:** `_pickableTypes` is `SceneRegistry.js:43`, not `:44` (`:176`);
`registerOverlay`'s factory is `layoutCommands.js:105` with its five call sites at `:157,167,176,
187,196` — the cited `:249` is not one (`:65`, `:261`).

**Claims I tried to break and could not** (all verified correct): `view.carrel` genuinely has
**zero readers** — the only occurrence outside its write sites is the docblock at
`carrelCommands.js:11`, and carrel membership really does persist through the parallel
`Carrel.serialize()` → `carrelManifest` → `serveManifest` pipeline; `grid.move`
(`gridCommands.js:271-289`) really never writes the model; `pinAutoDocked` really is never
serialized (the terminals capture emits only `{id, x?, y?, z?, cols?, rows?, zoom?}`); dock capture
really reads the MODEL while carrel capture scrapes the LIVE object; `settings.js` really has
**157** `apply:` closures and **11** `applyGroupSettings` call sites (systems-runtime said 8 —
undercount, its case is stronger than stated) and **6** `setEnabled` twins; the HUD really polls at
150ms with that exact comment (`HudPanel.jsx:78`); `GridVirtualizer` really is dead.

---

## Gaps

- **They missed (both):** `setWorldPosition` is now a **pure alias** for `position.set`
  (`TerminalGrid.js:633-635`, `FrameGrid.js:371-373`) — `setGroupOffset` is never called from
  either — yet four sites still branch on it, including the very `grid.move` state-persistence
  indicts (`gridCommands.js:282`). A dead capability keeping a live branch is the cleanest
  one-paragraph argument for capability tags.
- **They missed (both):** only **4 `instanceof` sites** exist app-wide (`gridCommands.js:364,410,
  473,503`) against 37 `typeof x.f === 'function'` probes. The codebase is already
  capability-dispatched; ECS names a convention rather than replacing one.
- **They missed (both):** `AgentBooks` is a **third live holder** — `lane.pinned`/`pinnedPos`
  (`:426-428`) with "borrowed" re-derived inline as `book.parent !== this.root` at three separate
  sites (`:842,866,882`) and **no home record at all**, so a borrowed-then-returned book has
  nothing to animate back to. Any `Held`/`Home` design must absorb it or explicitly exclude it.
- **They missed (both):** `ContentTree.parentOf` is deliberately **path-derived, not
  `node.parent`** (`:160-166`), and the tree keeps three parallel path-keyed maps (`:81-86`)
  precisely so holder reparenting cannot corrupt structure. That is an entity index already
  coexisting with the scene graph — the strongest evidence that "held" and "member" are separable.
- **systems-runtime found, I missed:** the 157 settings closures + boot-fold problem, the
  `registerOverlay` precedent, and the intra-frame ordering asymmetry between the twins. All three
  are real and none appear in my doc.
- **state-persistence found, I missed:** the station table. Naming the eight stations a fact must
  pass, and showing that a missing station has a *named bug*, is the best single artifact produced
  by any of the three lenses.
- **I found, they missed:** systems-runtime's Slice −1 is stronger than it claims. Deleting
  `GridVirtualizer` also orphans `CodeGrid.unloadContent()` (`:888`) and `reloadContent()`
  (`:942`) — ~90 lines whose *only* callers are `GridVirtualizer.js:347,377`. Pure bonus subtraction.

---

## Tensions

**T1 — Where does the world live? (state-persistence vs systems-runtime; I side with a synthesis.)**
state-persistence: the component store already exists as `WorkspaceModel.surfaces`
(`:10-15,277`) — grow *that*. systems-runtime: `SceneRegistry` is "already 80% of a component
store" — *cannibalize the registry*, do not stand up a second table (`:13-17,280`). Both invoke the
same house law to reach opposite tables, and **both are half right**, because the two stores hold
different things: `WorkspaceModel.surfaces` holds *durable intent* and survives an entity's death
(that is exactly why the async PTY re-adopt works — `SessionStore.js:216-218`), while
`SceneRegistry` holds *live handles* and dies with the object. Merging them would destroy the
durable buffer. **Correct resolution: two tables, one key.** The registry id is already the join
key for both (`WorkspaceModel.js:35-38`), for holder entries, attention slots, `carrelManifest`,
and the session file. The ECS is: registry = live components, WorkspaceModel = durable components,
id = entity. Neither doc states this, and it is the load-bearing decision.

**T2 — Unify the holders, or only their relationship?**
systems-runtime proposes one `Holder` system with pluggable placement (`:148-161`), then correctly
warns that the two `_relayout`s genuinely differ (dock reserves slots + draws ghosts;
carrel bottom-anchors and pre-shapes via `expect()`). state-persistence lands harder: "one
*component*, two *systems*" (`:142`). **state-persistence is right and systems-runtime's own
warning proves it.** The measurement supports the narrow reading: the 170 byte-identical lines are
concentrated in `lock`/`release`/`dismiss`/`homeOf`/`pruneDismissed`/`_userOf`/`reachesScene` —
the *membership and home* mechanics — while `_relayout` is where the two legitimately diverge.
Unify membership + home; keep placement separate.

**T3 — Does the always-on projector get replaced, or preserved?**
state-persistence calls the sweep "the pop-back amplifier" and wants a dirty-set loop (`:94-100`),
then concedes the always-on virtue must be preserved and that "an entity arriving is a new entity
with old components" must mark everything dirty (`:108-111`). systems-runtime keeps
`holdChanges` as the batching primitive unchanged (`:102-103`). **The concession is the real
answer:** the arrival case is the *only* case that matters for the re-adopt bug, and it is
inherently a full re-assert for that entity. The dirty-set buys per-*entity* scoping, not
per-*component* scoping. Scope the claim: it removes the O(all surfaces) sweep, not the re-assert.

**T4 — Synchronous apply.**
systems-runtime flags that pull-based toggles defer effects by one frame and break
read-after-write, which `STATE_ARCHITECTURE.md:133` requires and the `tools/*-check.mjs` harnesses
assert (`:73-76`). state-persistence's dirty-flush loop (`:230-236`) has the same exposure and does
not mention it. **systems-runtime is right**; any flush-based design must run the flush
synchronously at the end of each verb, exactly as `apply()` does today.

**T5 — vs me: "the payoff is dispatch/duplication, not cache locality."**
All three lenses independently reached this. It is now triangulated: **nobody should sell this
refactor on performance.**

---

## Recommendations

1. **Fix E1 before anyone acts on it:** keep the "delete `AttentionManager.docks`" recommendation,
   restate the reason as "redundant projection of `CameraDock.entries`", and budget the two harness
   updates (`dock-dismiss-check.mjs:47`, `dock-refresh-check.mjs:205`) plus `attention.info`.
2. **Adopt T1 explicitly in the converged design:** two component tables (live = registry, durable =
   WorkspaceModel), one string entity id, and a written rule that the durable table outlives the
   live one. Everything else in all three docs depends on this and none of them states it.
3. **Re-grep every line citation before implementation.** The tree moved mid-study (E6). Cite
   symbols, not lines, in the converged document.
4. **Take state-persistence's station table as the design's acceptance test:** a component is done
   when its stations collapse from N to 2 (schema entry + apply). It is the only artifact here that
   can *fail* a refactor.
5. **Sequence: systems-runtime's Slice −1 → Slice 0 → state-persistence's Slice B.** Delete
   `GridVirtualizer` (plus the now-orphaned `CodeGrid.unloadContent/reloadContent`, ~90 free
   lines), then the non-ECS `ctx.holders` protocol (~40 lines, zero frame behaviour change), then
   `Residence`. Slice 0 de-risks Slice B by making the call sites branch-free first.
6. **Resolve the carrel authority split in one direction, in one change** (state-persistence §6 B):
   either `view.carrel` becomes the authority and `Carrel.serialize().members` dies, or the writes
   at `carrelCommands.js:61` die. Shipping both is the dual path the house law forbids — and the
   dead writes have been sitting there unread the whole time.
7. **Fold `AgentBooks` lanes into the holder protocol at Slice 0**, or state in writing that they
   are excluded. Three inline `parent !== root` borrowed checks and a home-less pin
   (`AgentBooks.js:426-428,842,866,882`) will otherwise be the thing that breaks Slice 3.
8. **Correct the animator merge claim (E4)** to "behaviour-equivalent *after* the frame order is
   unified", and make unifying dock-vs-carrel intra-frame order an explicit, separately-verified
   step with its own harness — it is a real one-frame behaviour change on the carrel side.
9. **Delete `grid.move`'s `setWorldPosition` branch and add the model write in the same change** —
   it closes state-persistence's movers'-law violation and my dead-capability fossil at once, in
   ~5 lines, with no ECS prerequisite.
10. **Do not merge the two stores' change events yet.** Ship systems-runtime's Slice 2
    (`_fire({type,id,component,op})`) on the registry only; `WorkspaceModel` already has per-key
    diffing and `change:surfaces` (`:152-163`) and does not need it.

---

## Key Insight

The three lenses converge on one substrate but disagree about *which* table is the entity table,
and that disagreement is the finding. state-persistence is right that `WorkspaceModel.surfaces`
is a component store; systems-runtime is right that `SceneRegistry` is a component store; the
reason both are right is that **this codebase already has two component tables joined by one string
id, and the split is not an accident — it is the durable/live boundary that makes async PTY
re-adoption work at all** (`SessionStore.js:216-218`: the model "holds a terminal's geometry
whether or not its grid is currently in the scene"). Any ECS proposal that collapses them destroys
the one property the system most depends on; any proposal that ignores the split will re-derive it
by hand, which is exactly how we got here — `carrelManifest` (`SessionStore.js:493`) is a
hand-rolled durable table for carrels because the durable table for docks was never generalized.
So the converged design should not be "build a world"; it should be **"name the two tables you
have, declare the id as their join key, and delete every third table someone wrote because those
two were unnamed"** — `carrelManifest`, `AttentionManager.docks`, `dock.tiles`, `ctx.n`, and the
holder-local `entries` maps are all that third table, five times over.

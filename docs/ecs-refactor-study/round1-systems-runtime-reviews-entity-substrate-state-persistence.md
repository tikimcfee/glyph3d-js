# Round 1: systems-runtime reviews entity-substrate, state-persistence

Adversarial verification against the working tree. Every claim below was re-run against the code.
**Line numbers here are from the tree as of this review** — see Error 8 on drift.

---

## Errors Found

**1. `AttentionManager.docks` is NOT "never populated" — and deleting it as vestigial breaks a verb
and two harnesses.** (state-persistence §7: *"`AttentionManager.docks` `:78` should simply be
**deleted**, it is a vestigial fourth copy of dock membership that was never populated"*.)
It is populated and maintained: `CameraDock.js:483-487` (`.set` on lock), `:532` (delete on
release), `:572` (delete on dismiss), and `:686-687, :847-848, :875-876` write `d.offset` every
`_relayout`. It is **read**: `AttentionManager.js:223` serializes it into the state dump, which
`attentionCommands.js:94` prints (`docks   N entries`). It is **asserted**:
`tools/dock-dismiss-check.mjs:47` requires the entry to be dropped on dismiss;
`tools/dock-refresh-check.mjs:205` seeds it. The *conclusion* (delete it) is right — it is a mirror,
not a record — but the stated reason is false, and a delete justified by "nothing populates it"
would ship broken. entity-substrate's version of the same call (conclusion "TOGGLES", citing
`STATE_ARCHITECTURE.md:98`'s "mislabeled record of truth") is the correct framing. **Any deletion
must be atomic with rewriting `attention.info`'s docks section and both harnesses.**

**2. "44% of `Carrel.js` … **byte-identical**" overstates the collapse by ~1.7×.** (entity-substrate
conclusion 2: *"170 of 389 … byte-identical"*.) Measured over non-blank, non-comment lines:
byte-identical **including indentation = 159 (40.9%)**; identical **only after `strip()` = 170
(43.7%)** — so 170 is the *strip*-identical figure, not the byte-identical one. More materially,
excluding lone `}`, `});`, `return true;`, `return false;` and other ≤3-char lines, the identical
set is **100 of 389 (25.7%)**. The honest deduplication payoff of merging the holder classes is
~100 lines, not 170. That matters because the 44% figure is the sole quantitative justification for
entity-substrate's smallest-first-cut #1 (fold both classes into one).

**3. `extentFromBox` is NOT copy-pasted verbatim, and the difference is load-bearing.**
(entity-substrate conclusion 2: *"`reachesScene()` and `extentFromBox()` are copy-pasted verbatim
(`CameraDock.js:91-112` ≡ `Carrel.js:69-92`)"*.) `reachesScene` is verbatim (`CameraDock.js:91-98`
≡ `Carrel.js:69-76`) ✓. `extentFromBox` is not: the dock's returns `{h,cx,cy,cz}`
(`CameraDock.js:104-112`); the carrel's returns `{w,h,cx,cy,cz}` (`Carrel.js:83-92`), and its own
docblock says why — *"Width is the plain box span — anchor-agnostic, unlike the dock's 2·|cx| form,
which assumes top-left-anchored content"* (`Carrel.js:78-82`). The consumers diverge accordingly:
`CameraDock._containScale` computes width as `2*Math.abs(ext.cx)` (`:634`), `Carrel._containScale`
uses `ext.w` (`:439`). **Merging these into "one measure system" silently changes dock tile sizing
for any content that is not top-left-anchored.** This is precisely the seam that must survive
unification.

**4. "8 `useFrame` hooks" — there are 7.** (entity-substrate §LIVE UPDATES.) Exhaustive:
`Minimap.jsx:103`, `ViewerCamera.jsx:56`, `SceneEnvironment.jsx:110`, `CommandProvider.jsx:202`,
`:219`, `CanvasInteraction.jsx:231`, `:882`. The other two greppable hits
(`simulateCommands.js:92`, `BoundedObject3D.js:55`) are prose in comments.

**5. "7 registry subscribers" is an undercount of ~40%; the live count is 12.** (entity-substrate
conclusion 5.) Their list omits five that subscribe through the optional-call form
`reg?.addChangeListener?.(fn)`: `FileTree.jsx:257`, `TerminalsPanel.jsx:98` and `:160`,
`RepoPanel.jsx:97`, `EditorPanel.jsx:104`. Full live set = `CommandProvider.jsx:532,554,736,748` ·
`SessionStore.js:861` · `CanvasInteraction.jsx:124` · those five · (`SpatialWindowManager.js:85` is
dead per `STATE_ARCHITECTURE.md:109`). state-persistence's "≥ 10" and its 12-item list are correct.
*My own phase-0 said 13 — I wrongly counted `syncVolumeCovers`, which subscribes to
`ContentTree.onRelayout`, not the registry. Correcting my own error too.*
The shared substantive claim — **not one listener uses the `type` argument** — is confirmed: every
handler is nullary (`CommandProvider.jsx:526,536,735,743`, `CanvasInteraction.jsx:104`,
`TerminalsPanel.jsx:97`, `RepoPanel.jsx:90`, `FileTree.jsx:242`, `HudPanel.jsx:71`).

**6. "~10 sites, each hand-rolling the same scan (dock, then every carrel)" — only 3 do that scan.**
(entity-substrate conclusion 4, "highest-value collapse".) Verified: the full dock-then-every-carrel
scan appears at exactly **three** sites — `SessionStore.js:103-104`, `carrelCommands.js:239`,
`windowCommands.js:177-179`. The rest ask a *narrower* question: dock-only
(`gestureResolver.js:148` "is this a tile → spotlight", `CommandProvider.jsx:521` "is this camera
chrome → skip occlusion", `cameraCommands.js:67` "docked → don't fly", `CarrelsPanel.jsx:267` menu
label, `SessionStore.js:180` capture-home-not-tile-pos, `carrelCommands.js:215,301`) or carrel-only
(`bookCommands.js:156`, `carrelCommands.js:72,218,306`). The count of holder-membership questions is
actually *higher* than 10 (≈14), but they are not one repeated scan. The recommendation survives —
`Held.holder === 'dock'` is still one map read — but the sizing does not.

**7. "exactly 4 `instanceof` sites in the whole app" is true only for *class* checks.**
(entity-substrate conclusion 1.) The 4 class-shaped ones are real and all in one file
(`gridCommands.js:364,410,473,503`, all `instanceof CodeGrid`) ✓ — a genuinely strong finding. But
there are ~14 `instanceof` uses overall, including three container-type tests that a component world
would also remove: `ctx.carrels instanceof Map` at `carrelCommands.js:37`, `SessionStore.js:104`,
`:287`. Understating them slightly weakens their own case.

**8. Every document in this study (mine included) cites `CommandProvider.jsx` / `SessionStore.js`
lines that are now 9–15 lines stale.** The working tree moved *during* the study: `git status` grew
from 10 to 12 modified files; `CommandProvider.jsx` 796 → 805 lines, `SessionStore.js` 879 → 891.
Concretely: `addChangeListener(syncCullCandidates)` moved `:523 → :532`; `onRemoval` `:545 → :554`;
`reconcileWorkspace` `:727 → :736`; `scheduleWarmUp` `:739 → :748`; `SessionStore` projector attach
`:849 → :861`; `occlusionCuller.shouldTest` `:512 → :521`. Not any one agent's fault, but the
converged design doc must re-verify before anyone edits from it.

**Claims I attempted to falsify and could not — all confirmed:**
`view.carrel` has **zero readers** (a `.carrel` grep excluding `carrelName|carrels|carrelCommands|
carrelManifest|carrelSweep` returns *nothing*) — state-persistence's single best find. The parallel
carrel pipeline with opposite authority: dock capture reads the model (`SessionStore.js:250-262`),
carrel capture reads the live object (`:287-288` → `Carrel.serialize()` `:687`) → `carrelManifest`
(`:493`) → `serveManifest` (`carrelCommands.js:207-226`) ✓. `grid.move` writes no model and
schedules no save (`gridCommands.js:271-290`) ✓. `file.open` reads only `args[0]`
(`fileCommands.js:92`) while capture (`SessionStore.js:181`) and restore (`:626`) both plumb x/y/z ✓.
`pinAutoDocked` exists only in `windowCommands.js:147,150,151` — never serialized ✓.
`SURFACE_PROJECTORS` has exactly one entry, `terminal` (`SessionStore.js:97-126`) ✓.
`setWorldPosition` is a pure `position.set` alias on both `TerminalGrid.js:633-635` and
`FrameGrid.js:372-374`, `setGroupOffset` is never called from either, and the fossil docstring at
`TerminalGrid.js:16` still advertises the vanished behaviour ✓. `CodeGrid.applyView` exists at
`:1119`, is `async`, takes no opts, returns `{windowed}` — a real divergence from TerminalGrid's ✓.
AgentBooks `lane.pinned/pinnedPos` at `:426-428`; the `book.parent !== this.root` predicate at
`:842, :866, :882` ✓ (`:842` is the positive form).

---

## Gaps

- **Neither reviewed doc addresses intra-frame ORDERING**, the dimension where systems pay off most.
  Verified asymmetry between the twins: `CameraDock.update` `_relayout()`s *before*
  `animator.update(dt)` (`:934, :937`); `Carrel.update` runs the animator *first* and only then may
  `_relayout()` for a returning borrowed member (`:562, :575`) — a one-frame lag the dock lacks.
  `Carrel`'s `_seat` epsilon guard (`:449-468`) exists *because* re-issuing an identical tween
  restarts its ease; that is an ordering artefact a single Motion system removes structurally.
- **Mine only:** the six independent time-integrators on three easing idioms (`SpatialAnimator` ×2,
  `ContentTreeMotion.js:126`, `Book.js:363`, `CameraDock._tickGhosts:747`, `CanvasInteraction` fill
  breath `:63`); the proof that merging animators is behaviour-identical (`SpatialAnimator.js:48`
  keys on `${uuid}:${property}` — a *global* key space); the 157 `settings.js` `apply:` closures and
  the 8 `applyGroupSettings` boot-folds they force; the accidental `AgentRunner`-before-`DockRunner`
  invariant (`CommandProvider.jsx:800-801`); the per-frame archetype-query allocation trap.
- **entity-substrate only (and they are right):** `CodeGrid.applyView` exists with a *divergent
  signature* — a direct correction to my phase-0, which treated `applyView` as the terminal path;
  `setWorldPosition` as a dead alias still branched on at 4 sites; `CONTROL_SPEC` being
  terminal-only while `window.pin`/`window.drop` already work on code grids (the cleanest pure
  capability win in the study); **`ContentTree.parentOf` being path-derived, deliberately not
  `node.parent` (`:160-166`)** — the single strongest piece of evidence that an entity index already
  lives beside the scene graph.
- **state-persistence only:** `view.carrel`'s zero readers; the dock/carrel *opposite authority*
  split; `grid.move`'s missing model write; `file.open`'s dead x/y/z stations; `pinAutoDocked`'s
  in-buffer-but-unserialized status; the station-count framing, which is the best available
  argument that the pop-back family is structural rather than a run of unrelated bugs.
- **state-persistence missed** that `GridVirtualizer` is unwired (entity-substrate and I both found
  it independently: the only `new GridVirtualizer` is `tools/carrel.test.mjs:271`). It is a fourth
  holder implementation that any `Residence` design would otherwise inherit.

---

## Tensions

**T1 — How far to unify the holders. state-persistence is correct.**
entity-substrate: *"fold `CameraDock` and `Carrel` into ONE holder parameterized by (anchor,
layout)"*. state-persistence: *"The honest form is one **component**, two **systems**"* and *"The
dock and the carrel share a component, not a class."* My phase-0 agreed with the latter. The
corrections above settle it: the real identical-code share is 25.7%, not 44% (Error 2); the extent
measure genuinely differs by anchor convention (Error 3); and the dock carries machinery the carrel
has no analogue for — `PaneTree` occupancy (`CameraDock.js:204, 883-888`), reserved slots + ghost
outlines (`:784-793, 692-753`), identity hues (`:412-415`) — while the carrel carries `expect()`
pre-shaping (`:410-413, 498-510`) and the borrowed guard (`:566-575`) the dock lacks. One class with
an `anchor` flag is the "one abstraction, two behaviours behind flags" smell.

**T2 — `parent` authority. Both are half-right; the synthesis is neither's.**
entity-substrate conclusion 9: *"`Held` is authoritative, a `ParentingSystem` is its one writer via
`attach()`, `parent` becomes derived."* state-persistence §7: *"If a component ever becomes a second
live transform authority, we have built the drift-scanner `SessionStore.js:94` explicitly warns
against."* These read as opposed but address different fields — `parent` (structure) vs
`position/quaternion` (transform). The trap neither names: **`Object3D.attach()` is
world-transform-preserving, so it *writes* `position` and `quaternion` as a side effect**
(`CameraDock.js:471`, `Carrel.js:229`). A `ParentingSystem` that reconciles `parent` from `Held`
*level-triggered* (re-running each flush, as an idempotent projector would) would rewrite the
transform every frame and destroy the one property the whole restore design rests on —
"`apply()` is idempotent so re-running is free" (`STATE_ARCHITECTURE.md:44`). **Correct position:
`Held.holder` is authoritative for structure; the reparent is an EDGE-triggered effect fired on
holder *change*, never a level-triggered reconcile.** Write that rule down before slicing.

**T3 — Which slice goes first. state-persistence's staging is correct.**
entity-substrate's smallest-first-cut is `HolderSystem` + `Home`/`Held` — while its own cost section
concedes *"~25 sites across 2 holders, 4 handler files, SessionStore, CanvasInteraction, and 3
harnesses — a week, not a day."* That is the largest slice, first, which contradicts the standing
refactor-lane (tendrils out *as* code is touched). state-persistence's Slice A ("name the
components, keep the file shape — zero schema risk") is the right shape. My phase-0's Holder
*protocol* (`ctx.holders` + `holderOf(id)`, ~40 lines, no per-frame change) slots in as the
prerequisite that shrinks both: it removes the 3 full scans and the 11 narrower reads *before*
anyone touches persistence.

**T4 — What `positionIsDerived` becomes.** state-persistence: replace the global
`ContentTree.has(id)` test with per-entity `Position{authority}`. entity-substrate: keep it as an
archetype predicate (*"has TreeMembership ⇒ lacks StoredPlacement"*) and *"flatten nothing"*.
**entity-substrate is right on storage, state-persistence right on the transition.** Authority is
derivable from tree membership *until* a drop makes it not — which is exactly Ivan's open bug. The
resolution is: keep membership as the default derivation, and let `window.drop` write an explicit
override that removes tree membership rather than storing a redundant flag beside it. Storing
`authority` as a free-floating field is a stored *output* — the very thing
`STATE_ARCHITECTURE.md:48-77` forbids.

**T5 — Perf.** All three of us independently reached "no perf win; sell it as deduplication and
correctness." No tension; that consensus should go in the converged doc verbatim.

---

## Recommendations

1. **Strike "never populated" from the `AttentionManager.docks` recommendation.** Keep the delete;
   scope it as *atomic with* `attention.info`'s docks section (`AttentionManager.js:223`,
   `attentionCommands.js:94`) and `tools/dock-dismiss-check.mjs:47` + `dock-refresh-check.mjs:205`.
2. **Restate the holder duplication as ~100 non-trivial identical lines (25.7%)**, not 170/44%.
   The case is still decisive; an inflated number invites a rebuttal that costs more than the honest
   one.
3. **Carve `extentFromBox` out of the "verbatim duplicate" list and make it a named divergence.**
   Any unified `Extent` component must carry both `w` (span) and the anchor convention, or the dock's
   `2·|cx|` contain-fit changes silently.
4. **Adopt: one `Held`/`Residence` component, two holder systems.** Reject the single
   parameterized holder class. Pluggable placement (`dock-dome`, `dock-linear`, `carrel-ring`,
   `carrel-grid`, `pane-tree`), shared membership/home/borrow mechanics.
5. **Write the parenting rule into the design before any slice:** *`Held.holder` is authoritative
   for structure; `attach()` fires edge-triggered on holder change only; transforms stay
   three.js-owned.* Without it, T2 produces a per-frame transform rewrite that breaks idempotent
   re-run.
6. **Sequence: (−1) delete `GridVirtualizer` → (0) holder protocol `ctx.holders` + `holderOf(id)`
   → (A) name the components in memory, file shape unchanged → (B) `Residence` → (C) `Position`
   authority → (D) component-keyed projector → (E) file shape last.** This merges
   state-persistence's A–E with my Slice −1/0 and demotes entity-substrate's week-long cut to step B.
7. **Resolve the `view.carrel` fork inside Slice B, explicitly choosing the model as authority** —
   delete `Carrel.serialize().members` + `carrelManifest`, keep the writes at `carrelCommands.js:61`.
   Choosing the *live object* instead would leave the dock and carrel on opposite authorities
   permanently, which is the actual defect.
8. **Add an ordering section to the converged doc.** Declare the system order
   (`Input → mutation drain → Motion → Holder → Projection → Overlay → VisualState → Cull → Render`)
   and record today's accidental invariants (`AgentRunner` before `DockRunner`; the twins' divergent
   intra-frame order) as things the migration must preserve or deliberately change.
9. **Make Slice 1 the Motion consolidation, and justify it with `SpatialAnimator.js:48`** — the
   global `${uuid}:${property}` key space makes the merge provably behaviour-identical, which is the
   cheapest possible demonstration that "systems" is not a rewrite.
10. **Re-verify every `file:line` before implementation.** The tree moved 9–15 lines under all three
    documents mid-study (Error 8); cite by symbol name alongside line number in the converged doc.

---

## Key Insight

The three lenses converge on the same object from three sides, and the convergence is the finding:
**`SceneRegistry` is the entity table, `WorkspaceModel.surfaces[id].view` is the component store,
`applyView` is the apply system, `SURFACE_PROJECTORS` is the system registry, `holdChanges` is the
commit barrier — and the reason none of them feels like an ECS is that each was built for one fact
and then hand-extended for the next.** But the adversarial pass changes *which* move comes first.
The two headline numbers driving "fold the holders into one class" do not survive measurement — the
identical-code share is 25.7%, not 44%, and only 3 sites run the repeated dock-then-carrel scan, not
10 — while the one number nobody disputed, `view.carrel`'s **zero readers**, points at a defect that
is cheaper *and* more damaging: the dock and the carrel persist the same relationship through
pipelines with *opposite authority*, so the newer holder was built without ever joining the model
the older one already uses. That is not duplication to be deduplicated; it is a fork to be closed,
and closing it is a prerequisite for any component that claims to own residence. The right first
move is therefore neither entity-substrate's week-long class merge nor a generic component store: it
is the ~40-line holder *protocol* that gives every caller one `holderOf(id)`, immediately followed by
picking one authority for carrel membership — after which `Held` is a small, obvious, provable step
instead of a bet.

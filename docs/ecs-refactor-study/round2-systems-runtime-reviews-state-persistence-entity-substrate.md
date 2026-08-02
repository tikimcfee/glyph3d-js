# Round 2: systems-runtime reviews state-persistence, entity-substrate (inverse)

Read order this round: state-persistence first, entity-substrate second, plus all three Round 1
reviews. Every disputed claim below was re-run against the tree at review time.

---

## Reaffirm or Retract

**1. `ctx.gridVisualState` — REAFFIRM. The challenge is factually wrong.**
entity-substrate E3 says *"`ctx.gridVisualState` does not exist. The ctx key is `ctx.n`"* and adds
"(Being named `n` is arguably a second finding.)" Verified: `gridVisualState.js:7` docblock reads
*"State is stored in `ctx.gridVisualState` (Map<number, SavedState>)"*; the module references
`ctx.gridVisualState` at lines 20, 21(via getGrids), 24, 38, 43, 52, 62; `CommandProvider.jsx:180`
declares `gridVisualState: new Map()`. A repo-wide grep for `ctx.n\b` across `app/` and `packages/`
returns **nothing**. There is no `ctx.n`. state-persistence independently confirms my naming in
their Gaps. The one thing entity-substrate got right is the path — it is
`app/commands/handlers/gridVisualState.js`, and my doc did not say otherwise. **Position held; the
substantive finding (index-keyed, so a registry reorder silently mis-restores) stands unchallenged
by all three.**

**2. "Merging N animators is behaviour-identical by construction" — RETRACT the claim, keep the
recommendation. The challenge is right, and the hazard is worse than stated.**
entity-substrate E4 is correct, and it is correct *because of my own finding two sections earlier* —
an internal inconsistency I should have caught. Re-verified: `CameraDock.update` runs
`_relayout()` at `:934` **before** `animator.update(dt)` at `:937`; `Carrel.update` runs
`animator.update(dt)` at `:562` **before** the borrow-return `_relayout()` at `:575`. One shared
animator has one call site, so the merge necessarily shifts one side by a frame. The key-space
argument (`SpatialAnimator.js:48`, `${uuid}:${property}`) proves **collision-freedom**, not
behavioural identity — I conflated the two.
Worse than E4 says: `SpatialAnimator.dispose()` is a **global `_active.clear()`**
(`SpatialAnimator.js:182-184`), and `Carrel.dispose()` calls it (`Carrel.js:704`) from a **live
path**, not just teardown — `CommandProvider.jsx:230` disposes any carrel that finished dissolving,
every frame it happens. With a shared animator, one desk folding would cancel every in-flight tween
in the application, including the dock's.
**Corrected claim:** *the merge is collision-free by construction; it is behaviour-equivalent only
after (a) the dock/carrel intra-frame order is unified and (b) `dispose()` becomes object-scoped
(`cancelAll` over owned objects) rather than a global clear.* Both are small, both need their own
assertion. The merge remains the right move — it is no longer a free one.

**3. "13 registry subscribers" — RETRACT. 12 live.**
I already self-corrected in Round 1; re-verified exhaustively here. Live `addChangeListener`
registrations: `TerminalsPanel.jsx:98,160` · `FileTree.jsx:257` · `CommandProvider.jsx:532,554,
736,748` · `RepoPanel.jsx:97` · `SessionStore.js:861` · `EditorPanel.jsx:104` ·
`CanvasInteraction.jsx:124` · `HudPanel.jsx:77` = **12**. A 13th registration exists at
`SpatialWindowManager.js:85` but `new SpatialWindowManager` appears nowhere in the repo (only inside
a Round 1 markdown file), so it is dead — matching `STATE_ARCHITECTURE.md:109`. My 13 arrived at the
right magnitude by two compensating errors. **Correct figure: 12 live, 13 registration sites, 1
dead.** The shared substantive claim survives untouched: every handler is nullary, so **not one uses
the `type` argument**.

**4. "8 `applyGroupSettings` boot-folds" — RETRACT UPWARD. 13 call sites.**
state-persistence E8 is right and entity-substrate's "11" is also low. Verified: **12** in
`CommandProvider.jsx` (`:428,429,430,431,432,433,434,490,508,510,534,708`) plus
`structureCommands.js:117` = **13**. This strengthens my own toggles argument by 60%.

**5. `window.drop` "collapses to one call with no branches at all" — RETRACT the overclaim.**
state-persistence E9 is correct. The holder's home feeds `dropPose` *before* the release
(`windowCommands.js:179-180`), and the loose path does parent-space conversion with no holder to
ride (`:203-212`, `g.parent.worldToLocal`). Under a holder protocol it becomes
`holderOf(id)?.homeOf(id) ?? null` then one branch (held vs loose). **Honest figure: four paths
(dock / dock-borrowed-from-carrel / carrel / loose) → two.** Still the largest single call-site win
in the study; not zero.

**6. "HMR: net win… the store lives on `ctx`, which already survives" — RETRACT the store half.**
state-persistence E10 is right. `SessionStore.js:829-837` keys restore per *scene generation*
precisely because *"the ctx is born with the scene"* — the ctx dies with the scene, and
`CommandProvider` rebuilds `stateRef.current` on remount. The durable buffer survives by being
**re-read from the file**, not by living on `ctx`. What survives is the narrower claim I should have
made alone: *systems are plain functions with no instance state, so a module hot swap re-imports
cleanly* — which is true and is a mild win over today's `[relay]`-keyed effect and the one-shot VCC
bridge (`STATE_ARCHITECTURE.md:136`). **Downgrade "net win" to "neutral, with a small win for
stateless systems."** Do not bank persistence on it.

**7. "Cannibalize `SceneRegistry`; do not stand up a second table" — RETRACT the framing; adopt
entity-substrate's T1.** This is the position change that matters most. My phase-0 conclusion 2
implied *one* table. entity-substrate T1 shows the codebase already has **two**, and the split is
load-bearing: `WorkspaceModel.surfaces` holds durable intent and **outlives the live object** (which
is exactly why async PTY re-adoption works — `SessionStore.js:216-218`), while `SceneRegistry` holds
live handles and dies with the object. Merging them destroys the durable buffer. **Corrected
position: two tables, one string entity id as the join key — registry = live components,
WorkspaceModel = durable components.** My original intent survives in narrower form: *do not add a
THIRD table, and do not adopt an external ECS library whose entity handles would replace the string
id.*

**8. Minor cite corrections — ACCEPTED.** `_pickableTypes` is `SceneRegistry.js:43` (I wrote `:44`);
`registerOverlay`'s factory is `layoutCommands.js:105` with call sites at `:157,167,176,187,196`
(my "~110-160, 249" was loose and `:249` is not a call site).

**Positions REAFFIRMED under challenge, having re-verified:** the 25.7%-non-trivial correction to
the "44% byte-identical" figure (state-persistence independently measured ~19% with a >20-char
filter; the two methods bracket the truth at **19–26%**, and both refute 44%); the deliberate,
documented `extentFromBox` divergence (`Carrel.js:78-82`) and the resulting `2·|cx|` vs `ext.w`
contain-fit split (`CameraDock.js:634` vs `Carrel.js:439`); `GridVirtualizer` being dead; **7**
`useFrame` sites; and the dock/carrel intra-frame ordering asymmetry — which now does double duty as
the refutation of my own animator claim.

---

## Evolved Understanding

- **The holder duplication is not primarily a code-reuse failure.** state-persistence's Key Insight
  reframed it and I accept the reframing: it is a **persistence-authority fork**. Dock capture reads
  the model (`SessionStore.js:250-262`); carrel capture scrapes the live object (`:287-288` →
  `Carrel.serialize()`); and `view.carrel`, written from six sites, has **zero readers**. That is
  why the honest duplicated-line count keeps shrinking under measurement while the *problem* keeps
  getting bigger: the lines are a symptom, the fork is the disease. My Slice 0 is unchanged, but its
  *justification* changes — it is not "delete branches", it is "make one authority reachable."
- **Assumption confirmed (3/3, independently):** no performance win. Nobody should sell this on
  speed.
- **Assumption confirmed:** the registry change event carrying only `type`, and 12 listeners
  ignoring it, is the single cheapest fix in the study. All three converged.
- **Assumption broken (mine):** "one store." See Reaffirm #7.
- **Assumption broken (mine):** "the Motion merge is free." See Reaffirm #2.
- **New, verified this round:** deleting `GridVirtualizer` also orphans `CodeGrid.unloadContent`
  (`:913`) and `reloadContent` (`:967`) — their **only** call sites are `GridVirtualizer.js:347` and
  `:377`. entity-substrate's bonus claim is correct: Slice −1 is ~452 + ~90 lines of pure
  subtraction.
- **Resolved between the two reviewed docs:** state-persistence's conclusion 3 and its own §2 table
  appeared to contradict each other on code-grid position; entity-substrate's E2 sharpened it and
  both are right about different authorities. Verified: `SessionStore.js:221` skips non-terminal
  surfaces, so the **model** fact `window.drop` writes is never serialized; `:180-181` separately
  captures a **live scrape** of `grid.position` into `files[]`; `fileCommands.js:92` consumes
  neither. **Three stations, three authorities, zero connection** — a sharper statement than either
  doc made alone.

---

## Convergence

High-confidence, now agreed by all three lenses:

1. **No performance win.** Justify on deduplication, station count, and correctness-by-construction.
2. **Slice −1: delete `GridVirtualizer`** (+ the orphaned `unloadContent`/`reloadContent`). Pure
   subtraction; removes a phantom fourth holder from every later slice.
3. **Slice 0: the holder protocol** (`ctx.holders` + `holderOf(id)`), no components, no per-frame
   change. All three now put it before `Held`; entity-substrate moved off its week-long first cut.
4. **One relationship component, TWO holder systems.** Placement stays pluggable. entity-substrate
   conceded this in its own T2; the `extentFromBox` divergence and the ordering asymmetry are the
   proof.
5. **Registry `_fire({type, id, op})` ships before any component-level event.** It kills
   `HudPanel.jsx:78`'s 150ms poll and lets `_projectSurfaces` project one id instead of sweeping
   every surface.
6. **Synchronous apply for verb-reachable state; pull-based only for frame-continuous state**
   (glide, breathing, ghost pulse). This is exactly today's `setSurfaceView`+`applyView` vs animator
   split, and it protects `STATE_ARCHITECTURE.md:133`.
7. **`AttentionManager.docks` goes — as a small breaking change**, atomic with `attention.info`
   (`AttentionManager.js:223`, `attentionCommands.js:94`) and two harnesses
   (`dock-dismiss-check.mjs:47`, `dock-refresh-check.mjs:205`). Not free subtraction.
8. **The carrel authority fork must be closed in ONE direction in ONE change** — no-compat-shims
   forbids keeping both pipelines.
9. **Counts of record:** 7 `useFrame` sites; 12 live registry subscribers, none using the `type`
   arg; 157 `settings.js` `apply:` closures; 13 `applyGroupSettings` call sites; 6 `setEnabled`
   twins; 4 class-`instanceof` sites (all `gridCommands.js`, all `CodeGrid`).
10. **Re-grep before implementing.** The tree moved 9–15 lines under all three documents mid-study.

---

## Remaining Tensions

**A. Does the LIVE table get components, or only the durable one?** entity-substrate's two-tables
resolution is right, but it leaves `Held` homeless: the holder system needs it every frame (live)
and the session file needs it on save (durable). Today the dock resolves this by living in both
(`entries` + `view.docked`) and the carrel resolves it by living in neither model
(`entries` + a serialize scrape). Unresolved: whether `Held` is a durable component the live systems
*read*, or a live component the capture pass *derives from*. I lean durable-with-live-index, because
`carrelManifest` proves the durable form is the one that survives an entity not existing yet.

**B. One Motion system vs per-holder animators.** Now genuinely open after Reaffirm #2. Option (a):
one Motion system + explicitly unify the intra-frame order — a real, assertable one-frame change on
the carrel side, needing its own harness. Option (b): keep per-holder animators and extract only the
shared easing. I still lean (a) — six integrators on three easing idioms is the actual mess — but it
is no longer the "cheapest extraction in the repo" I called it.

**C. Motion keyed by `uuid` or entity id.** state-persistence's rec 7 (key by id, so a re-pointed
grid does not orphan an in-flight tween) is right in principle and **not yet feasible**: verified
that `type:'dir'` is registered only lazily from `navigationCommands.js:155`, so `ContentTreeMotion`
animates dir nodes with no registry id at all, and agent-book lanes are not registry entries.
Id-keying the Motion system is therefore *sequenced behind* "lanes and dirs become entities." Until
then: keep the uuid key and add an id→object invalidation hook. Neither reviewer noticed the
dependency.

**D. Scheduler vs deduplication-only.** entity-substrate warns that a scheduler's failure mode is
one-frame lag bugs, harder to see than a missing `x.update(dt)`. I hold that a *declared order* is
required, but I concede it should be a **list in one file**, not a framework — order as data, not as
machinery.

**E. Per-frame archetype-query allocation.** Unbudgeted by both reviewed docs. A naive
`query(...)` allocating per system per frame at 60fps is GC churn; archetype sets must be maintained
incrementally on write. This is where the +100 lines of the store actually go.

---

## Synthesis

**Do this, in this order.** Slice −1: delete `GridVirtualizer` plus the now-orphaned
`CodeGrid.unloadContent`/`reloadContent` — ~540 lines of pure subtraction and one fewer holder to
model. Slice 0: the ~40-line holder protocol (`ctx.holders`, `holderOf(id)`) — it removes the three
dock-then-every-carrel scans and eleven narrower holder reads with **zero per-frame behaviour
change**, and it is the cheapest possible demonstration that the thesis holds. Slice 0.5, and this
is the piece the Round 1 pass added: **pick the carrel's persistence authority and delete the other
pipeline** — make `view.carrel` (written six times, read zero) the authority and delete
`Carrel.serialize().members` + `carrelManifest`, so the dock and the carrel finally persist the same
relationship the same way. Only then Slice A/B (name the components; `Residence`), because only then
is `Held` a small step rather than a bet.

Hold three rules in writing before any of it. **(i) Two tables, one key:** registry = live
components, `WorkspaceModel` = durable components, the string registry id joins them, and the
durable table outlives the live one — never merge them. **(ii) Structure is edge-triggered:**
`Held.holder` is authoritative for parenting, but `attach()` is world-transform-preserving and
therefore *writes* `position`/`quaternion` as a side effect (`CameraDock.js:471`, `Carrel.js:229`) —
so the reparent fires on holder *change*, never as a level-triggered reconcile, or idempotent
re-run (`STATE_ARCHITECTURE.md:44`) breaks. **(iii) Verb-reachable components apply synchronously;
only frame-continuous state is pulled.**

And unify the **relationship**, not the class. The measured identical-code share is 19–26%, not 44%;
`extentFromBox` diverged deliberately and documented (`Carrel.js:78-82`); the dock carries
`PaneTree`, ghosts and identity hues, the carrel carries `expect()` pre-shaping and the borrowed
guard. One `Held`/`Home` component, two placement systems, one `Extent` measure parameterized by
anchor — with the two current results reproduced exactly as its acceptance test.

---

## Dissent

**1. Ordering is still under-weighted by both reviewed lenses, and it is now load-bearing.** Neither
doc proposes writing the frame order down. But the accidental invariant is real — `AgentRunner` is
mounted before `DockRunner` (`CommandProvider.jsx:800-801`), so agent books ease *before* carrels
re-seat them, and nothing records that. And Round 1 turned ordering from a nice-to-have into the
thing that **refutes the animator merge being free**. The converged design needs an explicit
`Input → mutation drain → Motion → Holder → Projection → Overlay → VisualState → Cull → Render`
list, with today's implicit invariants recorded as preserve-or-deliberately-change.

**2. I dissent from making the 157 settings closures into components.** Both reviewed docs pull
everything toward the component world; state-persistence even names the risk ("tag components tempt
you to make *everything* a component") and then does not apply it here. The settings target
**singletons** — the dock, the labels overlay, the culler — not per-entity state. The right fix is a
declarative `setting → (subsystem, param)` table that replaces both the closure *and* the 13
`applyGroupSettings` boot-folds. That is smaller than a component world and does not smuggle
world-singleton config into a per-entity store.

**3. I hold that Slice 0 must ship before any component lands, more firmly than either doc.** Both
now agree on the ordering, but both still treat it as staging convenience. It is more than that:
Slice 0 is the only step in the entire plan that is **reversible in an afternoon and changes no
frame behaviour**. In a two-session shared tree with the citations already drifting 9–15 lines
mid-study, a first slice that can be backed out without a schema decision is not a preference — it
is the risk control that makes the rest of the plan safe to attempt.

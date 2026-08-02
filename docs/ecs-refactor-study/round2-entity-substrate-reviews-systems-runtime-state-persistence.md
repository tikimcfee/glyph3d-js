# Round 2: entity-substrate reviews systems-runtime, state-persistence (inverse)

Read order this round: systems-runtime first, state-persistence second, then all three Round 1
files. Every disputed number below was re-measured at review time, not recalled.

---

## Reaffirm or Retract

**R1 — "44% / 170 of 389 **byte-identical**." RETRACT the label and the headline. REAFFIRM the
mechanic list.**
Re-measured with an explicit script (non-blank, non-comment lines of `Carrel.js` matching any line
of `CameraDock.js`):

byte-identical *including indentation* = **159 (40.9%)**; identical after `strip()` = **170
(43.7%)**; strip-identical with length >3 = **117 (30.1%)**, >20 = **73 (18.8%)**, >30 = **43
(11.1%)**.

My script stripped whitespace, so "**byte**-identical = 170" was wrong: 170 is the *strip*-identical
figure; byte-identical is 159. systems-runtime is right on that (its Error 2). **But neither
reviewer's substantive figure reproduces as stated.** systems-runtime's "excluding lone `}`, `});`,
`return true;`, `return false;` and other ≤3-char lines → 100 (25.7%)" — the ≤3-char filter yields
**117**, and `return true;` is 12 characters, so its stated criterion is not the one it used.
state-persistence's "only 73 are longer than 20 characters" reproduces **exactly** and is the most
defensible single number.
**New position:** *~73 substantive identical lines (>20 chars, 18.8%), rising to 117 (30%) if you
count short statements, across 13 named mechanics.* I withdraw "44%" as a headline. It was the
right order of magnitude for the wrong reason, and — as systems-runtime correctly notes — it was
the sole quantitative prop under my "fold both classes into one" recommendation, which I also
retract below (R6).

**R2 — "`reachesScene()` and `extentFromBox()` are copy-pasted verbatim." SPLIT: reaffirm one,
retract the other.**
`reachesScene` is byte-identical (`CameraDock.js:91-98` ≡ `Carrel.js:69-76`) — reaffirmed.
`extentFromBox` is **not**: the carrel's returns an extra `w` and its own docblock states the reason
— *"Width is the plain box span — anchor-agnostic, unlike the dock's 2·|cx| form, which assumes
top-left-anchored content"* (`Carrel.js:78-82`), with the consumers diverging at
`CameraDock._containScale:634` (`2*Math.abs(ext.cx)`) vs `Carrel._containScale:439` (`ext.w`).
**Full retraction.** Both reviewers caught this independently and both are right. It is the single
most consequential correction in the study, because it is the *counter-example* to my merge
proposal: the divergence is deliberate, documented, and load-bearing.

**R3 — "8 `useFrame` hooks." RETRACT — there are 7.**
`ViewerCamera.jsx:56`, `SceneEnvironment.jsx:110`, `CommandProvider.jsx:202`, `:219`,
`CanvasInteraction.jsx:231`, `:882`, `Minimap.jsx:103`. Root cause: I propagated a subagent's prose
count without reconciling it against its own 7-row table.

**R4 — "7 registry subscribers." RETRACT — 12 live.** Mine was the worst of the three counts: I
missed the five optional-call registrations (`FileTree.jsx:257`, `TerminalsPanel.jsx:98`, `:160`,
`RepoPanel.jsx:97`, `EditorPanel.jsx:104`) entirely; `SpatialWindowManager.js:85` is a 13th
registration on a never-instantiated class. **The claim that mattered survives untouched: not one of
the 12 handlers reads the `type` argument it is passed** — every one is nullary. Undercounting made
my own case weaker, not stronger.

**R5 — "exactly 4 `instanceof` sites in the whole app." RETRACT the superlative; the substance gets
STRONGER on re-measurement.**
`app/` has 10 `instanceof` occurrences, one of which is a comment (`vite.config.js:15`) → **9 real**:
4 × `instanceof CodeGrid` (`gridCommands.js:364,410,473,503`) and 5 × `instanceof Map`
(`SessionStore.js:104,287,471`; `carrelCommands.js:37,210`). state-persistence's "six more are
`instanceof Map`" over-counts by one. More important, I checked what neither reviewer did:
**`packages/glyph3d-core/src` contains 13 `instanceof` uses and every single one is a JS-builtin
type guard** — `Uint32Array` ×5, `Uint8Array` ×2, `ArrayBuffer` ×2, `Float32Array`, `TypeError`,
`Error`, `ExitStatus`. **Zero domain-class `instanceof` in the entire rendering core.** Correct
statement: *the only class-based dispatch on a domain entity anywhere in the repo is four lines of
one handler file.* That is a stronger finding than the one I retracted.

**R6 — "Smallest first cut: fold `CameraDock` and `Carrel` into ONE holder parameterized by (anchor,
layout)." RETRACT.**
Both reviewers converged on "one *component*, two *systems*", and R1 + R2 are why. Add the
asymmetric machinery neither class shares — `PaneTree` occupancy, reserved slots, ghost outlines,
identity hues on the dock (`CameraDock.js:204, 692-753, 784-793, 412-415`); `expect()` pre-shaping
and the borrowed guard on the carrel (`Carrel.js:410-413, 498-510, 566-575`) — and one class with an
`anchor` flag is exactly the "one abstraction, two behaviours behind flags" smell. **New position:
unify the relationship (`Held`/`Home`) and the membership mechanics; keep two placement systems.**

**R7 — "~10 sites hand-rolling the same dock-then-carrel scan." PARTIAL RETRACT.**
systems-runtime is right: the *full* scan appears at exactly **3** sites (`SessionStore.js:103-104`,
`carrelCommands.js:239`, `windowCommands.js:177-179`); the other ~11 ask narrower dock-only or
carrel-only questions. The recommendation is unchanged — `holderOf(id)` still serves all ~14 — but
my sizing was wrong and I withdraw "highest-value collapse in the codebase" as a ranking.

**R8 — "27 writers of `view`." RETRACT — 20 call sites.**
`rg setSurfaceView` returns 27 hits; that includes 3 in `tools/`, the definition and docblock in
`WorkspaceModel.js`, and one capability probe (`terminalCommands.js:183`). Real write call sites in
`app/`: **20**. state-persistence's 21 is nearer than mine.

**R9 — "AgentBooks re-derives `borrowed` at three sites (`:842,866,882`)." REAFFIRM — the challenge
is wrong.**
state-persistence's E7 says `:842` "has no such test". Verified verbatim:
`AgentBooks.js:842` is `if (lane.pinned && lane.pinnedPos && lane.book.parent === this.root) {`;
`:866` and `:882` are `if (lane.book.parent !== this.root) continue;`. Three parent-identity tests,
in two forms — two borrowed-skips and one pin-guard. systems-runtime's Round 1 got this right
("`:842` is the positive form"). I hold the claim as written and note that the two forms are
*different predicates over the same missing component*, which is the point.

**R10 — "`setWorldPosition` is a fossil branched on at 4 sites." REAFFIRM, and it is worse than I
wrote.**
Three `typeof … === 'function'` branches (`CanvasInteraction.jsx:459`, `gridCommands.js:282`,
`windowCommands.js:206`) plus a fourth I under-described: **`ViewerCameraController.placeInView`
hard-refuses any object lacking it** — `if (!camera || typeof obj?.getBounds !== 'function' ||
typeof obj?.setWorldPosition !== 'function') return false;` (`:1071`). Its own docstring says
*"Drop a framed surface (**grid** / terminal) into the viewer's current view"* (`:1057-1063`), but
because `setWorldPosition` exists only on `TerminalGrid:633` and `FrameGrid:372`, **a `CodeGrid` can
never be placed by it.** Today the gap is latent (its only caller is `terminal.create`,
`terminalCommands.js:138`), but it is the exact method `file.open`'s never-consumed `[x y z]`
(state-persistence's find) would need. A dead alias is not merely dead — it is being used as a
capability gate that silently excludes an entity class from a feature.

---

## Evolved Understanding

- **Confirmed:** the substrate is capability-dispatched, not class-dispatched (R5, now stronger);
  `GridVirtualizer` is dead; ECS buys no performance; the registry change event throws away the only
  information it carries.
- **Broken — my merge framing.** I treated the holder twins as a *code-reuse* failure measurable in
  duplicated lines. state-persistence reframes it correctly as a **persistence-authority split**:
  the dock's truth is the model (`SessionStore.js:256`), the carrel's is the live object (`:287`),
  and `view.carrel` — 20-ish writes, **zero reads** — is a write-only stub sitting where the model
  fact should be. That is a fork no-compat-shims requires you to close by *deleting one working
  pipeline*. My lens could not see it because I never traced either holder into persistence.
- **Broken — my sequencing.** I proposed the largest slice first while my own cost section called it
  "a week, not a day." Both reviewers caught the contradiction; the ~40-line `ctx.holders` protocol
  is the correct first move.
- **Sharpened — parent authority.** systems-runtime supplies the mechanism I was missing:
  `Object3D.attach()` is world-preserving and therefore *writes* `position`/`quaternion` as a side
  effect (`CameraDock.js:471`, `Carrel.js:229`), so a `ParentingSystem` reconciling `parent` from
  `Held` **level-triggered** would rewrite transforms every flush and destroy idempotent re-run. My
  conclusion 9 was right in direction and dangerously underspecified in trigger discipline.
  state-persistence adds the serialization half: `Home.parent` must be an entity **id**, never an
  `Object3D` ref (`Carrel.js:281-284` documents the pruned-parent fallback).

---

## Convergence

All three lenses, independently and now mutually verified:

1. **No performance win.** 10¹–10³ window entities; hot paths are already flat typed arrays inside
   one entity. Sell deduplication and correctness, never speed.
2. **`GridVirtualizer` is dead** (only `tools/carrel.test.mjs:271`) → **Slice −1**. Bonus nobody
   costed: it is the sole caller of `CodeGrid.unloadContent()` (`:888`) and `reloadContent()`
   (`:942`) — ~90 further lines of free subtraction.
3. **One `Held`/`Residence` component, two holder systems** — not one parameterized class (R6).
4. **The holder *protocol* (`ctx.holders` + `holderOf(id)`) goes first** — ~40 lines, zero per-frame
   change, removes 3 full scans and ~11 narrower reads before anything touches persistence.
5. **`AttentionManager.docks` is populated, read (`AttentionManager.js:223` → `attention.info`), and
   asserted on (`dock-dismiss-check.mjs:47`, `dock-refresh-check.mjs:205`).** Delete it — atomically
   with those three, and not for the reason originally given.
6. **`_fire({type, id, op})` before any component-level event** — kills `HudPanel.jsx:78`'s 150ms
   poll and lets the projector touch one id instead of every surface.
7. **Verb-reachable state applies synchronously; only frame-continuous state is pull-based**
   (`STATE_ARCHITECTURE.md:133` + the `tools/*-check.mjs` harnesses).
8. **The tree moved 9–15 lines under all three documents mid-study.** Cite symbols, not lines.

---

## Remaining Tensions

**T1 — Where the world roots. Genuinely unresolved, and it is the decision.**
state-persistence: `WorkspaceModel.surfaces` is the component store. systems-runtime:
`SceneRegistry` is 80% of one — do not stand up a second table. My Round 1 position stands and
neither reviewer engaged it: **both are right because there are already two tables joined by one
string id, and the split is load-bearing.** The model holds a terminal's geometry *whether or not
its grid is in the scene* (`SessionStore.js:216-218`) — that is the only reason async PTY re-adoption
works. Collapse them and re-adoption breaks; ignore the split and you re-derive it by hand, which is
literally what `carrelManifest` is. **Proposal: name them — registry = live components,
WorkspaceModel = durable components, registry id = the join key — and make "which table" a required
field of every component's schema.** Nobody has adopted this yet; it should be settled before Slice B.

**T2 — Holder merge given the deliberate `extentFromBox` divergence.** Consensus is "one component,
two systems", but `Extent` sits *underneath* both. state-persistence's acceptance test (one measure
with an anchor parameter reproducing both current results exactly) is right in spirit, but the
dock's `2·|cx|` is not merely a different anchor — it is an *assumption about content* that is false
for `Book`, which has no `ScaleModel` and is centre-ish. Unresolved: anchor enum, or always report
`w` and let the dock keep its own width derivation? I lean to the latter — smaller, and it preserves
the documented divergence instead of encoding it as a flag.

**T3 — Animator merge ordering.** systems-runtime's "behaviour-identical by construction" is refuted
by its own finding that the twins run `_relayout` and `animator.update` in opposite order
(`CameraDock.js:934,937` vs `Carrel.js:562,575`). Two hazards nobody raised: `cancelAll(grid)` is
holder-scoped teardown (`CameraDock.js:578`, `Carrel.js:238,313`) and `dispose()` is per-holder
(`CameraDock.js:950`, `Carrel.js:704`) — a shared animator cannot be disposed when one carrel folds.
state-persistence adds a third: key by **entity id**, not `object.uuid`, or in-flight tweens orphan
when an id is re-pointed. Unresolved: does the merge adopt the dock's order or the carrel's? One of
the two changes by a frame and nobody has said which.

**T4 — HMR.** systems-runtime claims "net win… the store lives on `ctx`, which already survives";
state-persistence says `ctx` dies with the scene. Verified: `SessionStore.js:841` — *"the ctx is born
with the scene"*. **Both are partly right**: a store on `ctx` survives a hot swap of the systems or
the store itself (what `_sessionRestored` guards at `:848`) but not a scene rebuild. Honest claim:
neutral-to-mildly-positive, not a win to bank.

---

## Synthesis

**Do not do "an ECS refactor." Do five subtractions, in this order, and stop after each to look.**

- **−1. Delete `GridVirtualizer`** + the now-orphaned `CodeGrid.unloadContent`/`reloadContent`.
  ~450 lines of pure subtraction; removes a phantom holder from every later slice.
- **0. The holder protocol.** `ctx.holders` + `holderOf(id)`; dock joins, each carrel joins on
  create/restore, and — my addition — **`AgentBooks` joins too**, or is excluded in writing. ~40
  lines added, 3 full scans and ~11 narrow reads removed, zero per-frame behaviour change.
- **0.5. Kill the `setWorldPosition` fossil** in one atomic change: 3 branches + the
  `placeInView` capability gate (`ViewerCameraController.js:1071`) + `grid.move`'s missing model
  write (`gridCommands.js:271-289`). ~10 lines, no prerequisites, and it closes both my
  dead-capability finding and state-persistence's movers'-law violation at once.
- **1. Choose the carrel authority and delete the loser.** Make `view.carrel` real (and delete
  `Carrel.serialize().members` + `carrelManifest`) or delete the writes. Not both — no-compat-shims.
  This is prerequisite to `Held`, because `Held` cannot have two persistence pipelines.
- **2. `Held`/`Home` as a component, two placement systems**, with the three rules the study earned:
  *`Held.holder` is authoritative for structure; `attach()` fires **edge-triggered** on holder change
  only, never level-triggered; `Home.parent` serializes as an entity id.*

Then, and only then, state-persistence's C–E (Position authority → component-keyed projector → file
shape last) and systems-runtime's Motion / change-events / Overlay / VisualState. Declare the tick
order in writing as part of Motion, recording today's accidental invariants (`AgentRunner` before
`DockRunner`; the twins' divergent intra-frame order) as things to preserve or deliberately change.

---

## Dissent

**D1 — I still hold T1, and nobody has engaged it.** Both reviewers cite "cannibalize existing
infra" to reach *different* tables. Neither addresses that the two tables have different lifetimes
and that the difference is what makes async re-adoption work. Until the converged doc says which
components are live and which are durable, "add a component" is ambiguous at every call site. This
matters more than any slice ordering.

**D2 — Capability tags are a cheaper first win than any component, and neither lens ranks them.**
Zero domain-class `instanceof` in the core (R5) means the substrate is already capability-dispatched
by hand, with `typeof x.f === 'function'` as the check — which is why `placeInView` silently
excludes code grids (R10) and why `gridCommands.js:364,410,473,503` refuses terminals *by class*
from `grid.window/layout/scroll/frame`. Those four lines are the north star's own seam (glyphs in a
frame, differing by layout), and state-persistence is right that none of us costed converting them.
Declared tags at `register()` would make both defects impossible; they need no world, no store, and
no schema bump.

**D3 — I do not accept "the duplication is only ~19%, therefore the merge is not the story."** The
73 substantive lines are not distributed randomly: they are concentrated in `lock`/`release`/
`dismiss`/`homeOf`/`pruneDismissed`/`_userOf`/`reachesScene` — the *membership and home* mechanics,
which is exactly what `Held`/`Home` absorbs — while `_relayout`, `_containScale` and `extentFromBox`,
where the twins legitimately differ, contribute almost none of it. The number came down; the
*shape* of the finding survived measurement intact, and it is the reason a component (not a base
class) is the right tool.

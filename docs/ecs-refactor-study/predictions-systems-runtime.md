# Predictions — written by `systems-runtime`, before reading any other agent's output

Written blind. No other phase-0 file has been opened.

---

## Agent `entity-substrate` (lens: subclass zoo, dock/carrel twins, component decomposition)

**Prediction 1 — the subclass zoo will turn out to be *shallow*, and they will say so.** The
inheritance chain is only `THREE.Object3D → BoundedObject3D → FramedGlyphField →
{CodeGrid, TerminalGrid, FrameGrid}` plus `BoundedObject3D → Book`, with `CameraDock` and `Carrel`
extending `Object3D` directly. I predict they conclude the CodeGrid/TerminalGrid split is *already*
mostly unified at `FramedGlyphField` (shared bounds, `onResize` taps, panel/border material,
`ScaleModel`), so the north-star "one substrate, modifiers not subclasses" is closer to done than it
reads — and that the honest remaining differences are **source** (file buffer vs VT byte stream),
**mutation** (edit ops vs `writeBytes`), and **layout** (`LayoutDescription` fold vs cols/rows), which
they will propose as exactly three components.

**Prediction 2 — they will name the dock/carrel twins as the headline finding, and go further than
I do on collapsing them.** I expect a proposal for one `Holder`/`Occupancy` class with a pluggable
placement strategy (sphere-dome / cylinder-ring / flat-wall / BSP-pane), citing the verbatim
`reachesScene` and `_userOf` duplicates and the near-twin `lock`/`release`/`dismiss`/`_relayout`
pairs. I predict they will be *more* willing than I am to merge the two `_relayout`s into one
function, and will under-weight the parts that genuinely differ (the dock's reserved slots + ghost
outlines vs the carrel's bottom-anchored rows + `expect()` pre-shaping) — a place our reviews will
disagree.

**Prediction 3 — they will propose a component vocabulary and argue "loose" must become a state.**
Expect something close to `Framed / Held / Residence / Motion / Pickable / Cullable`, with the
observation that `role || type` in `SceneRegistry` is a **one-slot tag** that cannot express two
facts at once — and therefore that the registry, not a new library, should carry the components.
I'd put good odds on them independently reaching "cannibalize `SceneRegistry`" and on them flagging
`ctx.gridVisualState`'s index key as a live-id violation.

---

## Agent `state-persistence` (lens: view facts, projectors, capture/restore triangle)

**Prediction 1 — they will conclude the ECS is already half-built in the persistence layer.**
`WorkspaceModel`'s `surface.view` bag (`docked`, `dockOrder`, `carrel:{name,order}`, `zoom`,
`position`, `window`, `frameRows`, `pinAutoDocked`) is a component map keyed by registry id in
everything but name, and `SURFACE_PROJECTORS` is a per-kind system table. I predict their headline
is "ECS formalizes what `STATE_ARCHITECTURE.md` already prescribed" rather than "ECS is a new
architecture," and that they quote §3's *store inputs, not outputs* as the discipline that decides
which fields may become components at all.

**Prediction 2 — they will defend the projector and warn hardest about derived state.** Expect a
strong caution that components must not become a place to cache *outputs* — the tree-laid position
discriminator (`positionIsDerived` / `contentTree.has(id)`), `ScaleModel.placement`, the dense
`slot` integer recomputed from `order` — and a warning that an ECS store makes "just store it as a
component" tempting in exactly the places the audit says to derive. I also expect them to insist
the idempotent guarded-write + re-run-on-change property survives verbatim, since that is what makes
the async terminal re-adopt race a non-event.

**Prediction 3 — they will want the component store and the workspace model to be ONE table, and
will surface the synchronous-apply constraint as the main risk.** I predict they argue against a
third home for facts (registry / workspace / holders is already too many) and propose the merge; and
that they flag §9's "apply after a verb must be synchronous or read-after-write breaks for the
CLI/tests/chained handlers" as the thing a pull-based, frame-deferred ECS would quietly break —
the same caveat I raised under TOGGLES, likely reached from the opposite direction (persistence
harnesses rather than settings closures).

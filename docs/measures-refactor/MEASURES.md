# Measures — retire the mirrored bounds system

**One-line thesis:** bounds are a polymorphic seam where **leaves** declare intrinsic
content and **containers** aggregate their children (prior art: the Swift
`Measures`/`Bounds` delegation model). What remains to retire is not a data mirror —
`c374023` already deleted that — but the *vocabulary* sprawl around the closed form:
three names for two questions (`layoutBounds`, `Carrel.localBounds`,
`ContentTree.getWorldBounds`), the padding-in-bounds conflation in
`CodeGrid.getLocalBounds`, and four hand-written container derivations that each
re-answer "how big am I" because the base class can't aggregate. They collapse into one
contract — atomically, no shims.

**Revision note (v3):** the ground moved. `c374023` ("bounds is a closed form, not a
measurement") landed after v2 was verified, and it deleted the system v2 set out to
delete: `_updateGeometryBounds` and its O(n) min/max are gone (`setLayoutExtent` states
the box, `GlyphField.js:1679`), `CodeGrid._workerBoundsCache` is gone
(`_getContentBounds` derives on read, `CodeGrid.js:1544`), and the `43cc18c` world-box
cache is gone (`BoundedObject3D` derives per call, `BoundedObject3D.js:78-83` — the
header at `:9-18` explains the deletion on purpose). Every v2 premise built on those is
corrected below, and the corrections mostly make the refactor *smaller*: v2's own
dirty-cascade caching design was the same over-build `c374023` removed, so the contract
is now recompute-per-read with **no invalidation machinery at all** (§3, §4). Where v2
was wrong the fix is in the design, not a footnote.

---

## 1. Context — what's actually wrong (post-`c374023`)

**Bounds are now a closed form.** No code walks glyph positions to find an extent:

- A CodeGrid item's extent is computed at kernel dispatch from the layout scan's three
  scalars — `foldExtent` (`core/foldGeometry.js:145`) — recorded on the item's
  `renderedTexts` entry (`GlyphLayoutCompute.js:182`), and unioned on read by
  `CodeGrid._getContentBounds()` (`CodeGrid.js:1544-1559`). O(1) per item, O(items) per
  read, nothing cached because nothing needs to be (`:1537-1540`).
- TerminalGrid's glyph extent is arithmetic on cols/rows/metrics (`_glyphExtent`,
  `TerminalGrid.js:1219-1236`); FrameGrid's is its cell dimensions
  (`FrameGrid.js:314-321`).
- The owner **states** the box into the field mesh for frustum culling —
  `GlyphField.setLayoutExtent(box | null)` (`GlyphField.js:1679-1696`), called by
  CodeGrid at flush (`:1313`) and on displacement (`:237/:346`), by TerminalGrid at
  commit (`:1204`), by FrameGrid at build (`:211`). Null on empty (`:1683-1688`,
  `:1464`). There is no measurement pass, no gpuLayout early-return, no
  removal-only-stale window — those died with `_updateGeometryBounds`.

**The field box is still write-only** (verified by grep: the only
`geometry.boundingBox` touches in packages/app are `GlyphField`'s writes at
`:1684/:1693` and comments). It is a cull artifact echoing the closed form, and it
should stay that way — the canonical source is the closed form, not the echo (§3, §8).

So the mirror is dead. **What is actually wrong now:**

- **Three names for two questions.** `getLocalBounds`/`getBounds` are the base
  vocabulary (`BoundedObject3D.js:43/:78`), but `layoutBounds` survives as a third name
  for the local question at **27 sites across 12 files** (CodeGrid alias `:660-667`,
  Book `:580`, StackContainer `:117`, FrameGrid `:330-332`, the layout kit, layout
  managers), `Carrel.localBounds` (`Carrel.js:722`, 2 call sites) is a fourth spelling,
  and `ContentTree.getWorldBounds` (`:520`) is a third spelling of the world question.
- **The padding conflation.** `CodeGrid.getLocalBounds()` (`:611-623`) = content
  **plus** `backgroundPadding` (default 1.0, `:69`) + `BOUNDS_Z_PAD` (0.5,
  `core/constants.js:42`) — "the sheet's extent" fused with "the background panel's
  extent." The background doesn't need the favor: `_sizeBackgroundTo` already fetches
  the raw content extent and adds padding itself (`:2190`, `:2202-2203`). But consumers
  of `getLocalBounds` get the padded box whether they want it or not — and one *wants*
  it: `CanvasInteraction.jsx:892` draws the hover outline to hug the panel edge
  (comment `:31-33`).
- **The base class can't aggregate.** `BoundedObject3D.getLocalBounds` is abstract
  (`:43-47`); there is no child-union default, so every container hand-rolls the same
  derivation with its own staleness story: `AgentBooks._worldBounds`/`localBounds`
  (`AgentBooks.js:955/:971`), `ContentTree.getLocalBounds`/`getWorldBounds`
  (`ContentTree.js:508/:520`), `StackContainer._box` (`StackContainer.js:110`),
  `Carrel.localBounds` (`Carrel.js:722`), `Book.layoutBounds` (`Book.js:580`).
- **Half the containers aren't even in the hierarchy.** Book already extends
  `BoundedObject3D` (`Book.js:83` — it bridges with `getLocalBounds() { return
  this.layoutBounds(); }` at `:590`), but `Carrel` (`:98`) and `StackContainer` (`:71`)
  extend `THREE.Object3D`, `AgentBooks` is a plain class holding a `THREE.Group` root
  (`:130/:139`), and `ContentTree` is a plain class whose dir nodes are `THREE.Group`
  (`ContentTree.js:63/:74/:237`).

**The per-frame picture — stated accurately.** `applyCamera` → `_applySoftBounds`
(`services/camera/ViewerCameraController.js:595`, called from `:392`) runs
`worldBounds(surfaces, …, { skip: dockTiles })` (`:605`) every frame, and
`Minimap.jsx:143` runs a second union every `useFrame` (plus a per-surface `getBounds()`
at `:121`). There is **no cache anywhere in this chain by design** — `getBounds`
re-derives per call (`BoundedObject3D.js:78-83` → `refreshExtent` → `getLocalBounds`).
That is affordable precisely because the local box is a closed form; the cost that
remains per frame is N × the `updateWorldMatrix(true,false)` ancestor walk, which this
refactor does not remove (§4). The problem to fix is the *vocabulary and seam*, not a
cache.

---

## 2. Prior art — MetalLink `Measures` / `Bounds`

Pattern pressure-tested in Swift ([MetalLink/Bounds/Bounds.swift],
[MetalLink/Bounds/Measures.swift]):

- **`Bounds`** — a value type (min/max) with union/contains/intersects + named edges.
  Equivalent to `THREE.Box3`.
- **`Measures`** — a class protocol defining the spatial vocabulary: `position`,
  `worldPosition`, `sizeBounds`, `bounds`, `worldBounds`, **`hasIntrinsicSize`**,
  **`contentBounds`**, plus the parent-chain seam.
- **The seam:** `computeLocalSize` unions all children's local bounds, *then* — if
  `hasIntrinsicSize` — unions in `contentBounds + position`. So **leaves with intrinsic
  content** set `hasIntrinsicSize = true` and provide `contentBounds`; **containers** set
  it `false` and aggregate for free. One pipeline serves both.
- **`MeasuresDelegating`** — forwards the whole vocabulary to a `delegateTarget`, so
  wrappers don't reimplement.

The transferable idea: `hasIntrinsicSize` + `contentBounds` is exactly the leaf/container
split we hit. The whole vocabulary is derived by the contract; each entity declares the
**one** fact about itself. MetalLink recomputes per read — and post-`c374023`, so can
we (§4).

[MetalLink/Bounds/Bounds.swift]: https://github.com/tikimcfee/MetalLink/blob/main/Sources/MetalLink/Bounds/Bounds.swift
[MetalLink/Bounds/Measures.swift]: https://github.com/tikimcfee/MetalLink/blob/main/Sources/MetalLink/Bounds/Measures.swift

---

## 3. The contract (JS draft)

`BoundedObject3D` **is already** the two-question base: `getLocalBounds()` (local,
abstract, `:43-47`) and `getBounds(target)` (world, derived per call from the local box
× `matrixWorld`, `:78-83`). What Measures adds is the **seam** — `hasIntrinsicSize`,
`contentBounds`, and a default `getLocalBounds` that aggregates — so containers stop
hand-rolling. **No caches, no dirty flags, no cascade, no `add`/`remove` overrides.**
Rationale in §4.

**Naming decision (settled in v2, unchanged):** the public vocabulary is exactly two
questions — **`getLocalBounds()`** (my extent in my own space) and **`getBounds()`**
(my extent in the world). `contentBounds()` is the declaration seam owners override,
not a read API. **`layoutBounds` dies everywhere** (27 sites → `getLocalBounds`);
`Carrel.localBounds` renames (2 sites: `carrelCommands.js:144/186`);
`ContentTree.getWorldBounds` folds into `getBounds`. If you want the size, ask local;
if you want where it is, ask world. One name per question.

```js
export default class BoundedObject3D extends THREE.Object3D {
    // hasIntrinsicSize: leaf = true (own content); container = false (aggregate children)

    /** The entity's OWN content extent (local). THE one fact a leaf declares.
     *  Leaves override (closed form — see §5); containers inherit empty. */
    contentBounds(target = new THREE.Box3()) { return target.makeEmpty(); }

    /** Local AABB = own contentBounds (if intrinsic) ∪ children's local bounds,
     *  each carried through the child's transform. Recomputed per read — the box
     *  is a closed form, so recompute is cheaper than invalidation (§4).
     *
     *  Child transform carry (v2's draft dropped this — a positioned child would
     *  contribute its box un-offset): a DIRECT child's `matrix` maps its local
     *  frame into ours; a child with no bounds vocabulary (plain Group) is
     *  TRANSPARENT — recurse, accumulating its matrix, so un-rooted scaffolding
     *  still unions correctly during the transition. */
    getLocalBounds(target = new THREE.Box3()) {
        target.makeEmpty();
        if (this.hasIntrinsicSize) target.union(this.contentBounds(_scratchBox));
        for (const c of this.children) {
            if (c.userData?.isMarker) continue;              // markers are not content
            _unionChild(c, _identity, target);
        }
        return target;
    }
}

function _unionChild(node, parentMatrix, out) {
    node.updateMatrix();
    _rel.multiplyMatrices(parentMatrix, node.matrix);
    if (node.getLocalBounds) {                               // bounded: ask, transform, union
        out.union(node.getLocalBounds(_scratchBox).applyMatrix4(_rel));
    } else if (node.userData?.size) {                        // geometry-less test mock (§5 bucket 2)
        out.union(_boxFromSize(node.userData.size).applyMatrix4(_rel));
    } else {                                                 // transparent group: descend
        for (const g of node.children) {
            if (g.userData?.isMarker) continue;
            _unionChild(g, _rel, out);
        }
    }
}
```

`getBounds(target)` keeps today's implementation verbatim
(`updateWorldMatrix(true,false)` → local box × `matrixWorld`, `:78-83`). It is already
the world question; nothing about it changes.

```js
// MeasuresDelegating — a wrapper forwarding the vocabulary to a delegateTarget.
class BoundedProxy extends BoundedObject3D {
    get hasIntrinsicSize() { return this.delegateTarget.hasIntrinsicSize; }
    contentBounds(t)  { return this.delegateTarget.contentBounds(t); }
    getLocalBounds(t) { return this.delegateTarget.getLocalBounds(t); }
    getBounds(t)      { return this.delegateTarget.getBounds(t); }
}
```

### Why there is no invalidation (the section v2 spent on `markMeasuresDirty`)

v2 designed a dirty-cascade (`markMeasuresDirty`, versioned local/world caches,
`add`/`remove` overrides) because it believed the local box was expensive and the
`43cc18c` cache was the incumbent. Both premises died with `c374023`, which deleted
exactly that machinery with the rationale: *"recomputing it costs less than deciding
whether a cached copy is still true"* (`BoundedObject3D.js:9-18`). Under
recompute-per-read, v2's three wiring cases evaporate:

1. **Leaf content change:** nothing to mark. The next read re-derives from the fold
   extent / cell arithmetic / stored snapshot. CodeGrid's flush already re-states
   everything the closed form reads (`:1289-1313`).
2. **Reparenting:** nothing to dirty. Membership is structural — a book reparented
   from `AgentBooks.root` to a Carrel is simply no longer a child of the root, so the
   root's next union excludes it automatically. (Today's `AgentBooks._worldBounds`
   needs an explicit filter — `lane.book.parent !== this.root`, `:959` — only because
   it walks a *registry*, not the tree.)
3. **Self-measuring derivations** (§5 bucket 3): inputs are read live per call. Book's
   `deckBounds` reads each sheet's *live* animated z (`Book.js:557`) — mid-ease reads
   are correct by construction, with no dirty stamp per animator tick.

Local memoization stays legal **inside** an owner whose inputs change rarely and whose
read is hot — TerminalGrid's `_localBoundsDirty`-guarded panel box (`:797-815`) is the
precedent. That is an implementation detail of one class, not a system-wide cascade
consumers must keep honest.

### Field-mesh access path — read the closed form, not the geometry echo

v2 had CodeGrid's `contentBounds` read `_renderer.instanceMesh.geometry.boundingBox`.
Wrong target post-`c374023`: the geometry box is a cull artifact *written from* the
closed form (`CodeGrid.js:237/:1313` → `GlyphField.setLayoutExtent`). Read the source:

```js
// CodeGrid
contentBounds(target = new THREE.Box3()) {
    const cb = this._getContentBounds();   // closed-form union of fold extents (:1544)
    if (!cb) return target.makeEmpty();    // no renderer / no committed extents → empty (§7.4)
    target.min.set(cb.min.x, cb.min.y, cb.min.z);
    target.max.set(cb.max.x, cb.max.y, cb.max.z);
    return target;
}
```

(The renderer slot: `_renderer` declared `collections/FramedGlyphField.js:41`, accessor
`getRenderer()` `:109-110`; constructed lazily by `_ensureRenderer`,
`CodeGrid.js:1121`.)

---

## 4. Why it's cheap — the closed form flipped the argument

v2 argued: MetalLink leans on Swift's protocol-witness devirtualization; JS has no such
pass, so the caching must be explicit (dirty-cascade, version counters, matrix
snapshots). **`c374023` removed the premise, not just the cache.** The expensive thing
the cache amortized — an O(glyphs) walk over a position buffer — no longer exists
anywhere in the system:

- A CodeGrid's local box is a union of per-item fold extents, each computed at dispatch
  from three scan scalars (`foldExtent`, `foldGeometry.js:145`) — measured at **128 ns**
  for a 390,777-glyph item (see `docs/plans/gpu-bounds-and-byte-pipeline.md`). The
  union is O(committed items), and items are few.
- TerminalGrid's and FrameGrid's boxes are cell arithmetic.
- Book's deck, Carrel's footprint, StackContainer's snapshot are small closed forms or
  stored boxes.

So MetalLink's actual model — **recompute per read** — is affordable in JS after all,
and the dispatch cost is paid per read whether or not a cache exists. What remains, in
honest accounting:

- **Transform change → nothing to invalidate.** `getBounds` refreshes `matrixWorld`
  per call (`updateWorldMatrix(true,false)`) and applies it. The per-frame ancestor
  walk for N surfaces stays — the refactor removes duplicate bounds systems, not the
  native matrix pass.
- **Container reads are O(subtree) per read.** Fine, because of *who reads containers*:
  the per-frame readers (soft bounds `ViewerCameraController.js:605`, minimap
  `Minimap.jsx:121/:143`, culler `OcclusionCuller.js:205`) read **surfaces — leaves**,
  whose boxes are closed-form. Containers are read at relayout / fit-all / ground-anchor
  time. If profiling ever shows a hot container read, memoize that node locally
  (TerminalGrid precedent, §3) — do not resurrect the cascade.
- **The sphere stays a derivative.** Three.js's native per-mesh frustum cull runs off
  the field mesh's `geometry.boundingSphere`, written by `setLayoutExtent`
  (`GlyphField.js:1694-1695`). Measures never re-implements culling, and nothing reads
  that box for layout (§8).

---

## 5. Crossover map — three buckets, not two

### Bucket 1 — intrinsic leaves (`hasIntrinsicSize = true`, override `contentBounds`)

- **`CodeGrid`** — `contentBounds` = `_getContentBounds()` (closed form, §3). The
  padded `getLocalBounds` body (`:611-623`) is **deleted**; the base union serves.
  Padding needs no new home — `_sizeBackgroundTo` already owns it
  (`:2190`/`:2202-2203`); only padding-sensitive consumers need re-homing (§5 consumers,
  §7.3). The `layoutBounds` alias (`:660-667`) folds; the plain-object
  `getContentBounds()` (`:644`) is §7.5.
- **`TerminalGrid`** — `contentBounds` is **analytical, panel-only**: the
  `getLocalBounds` math (`:797-815`) minus `_bgPadding`. It must NOT read the field
  box — the stated glyph extent still spans the scrollback history deck (§7.3).
  Padding already lives in the terminal background (`_updateBackground:1465`, pad
  `:1471`).
- **`FrameGrid`** — **done already.** `getLocalBounds` is analytical (`:314-321`) and
  is *itself* stated as the field's cull extent (`:209-211`), so contentBounds ≡
  getLocalBounds ≡ field box by construction. Only the `layoutBounds` alias
  (`:330-332`) folds.

### Bucket 2 — aggregating containers (`hasIntrinsicSize = false`, inherit the union)

- **`AgentBooks`** — `_worldBounds` (`:955`) / `localBounds` (`:971`) are a union over
  root-held books with a tree-membership filter (`:959`). Under the contract the filter
  is **structural** — borrowed books are reparented away, so they are not children and
  the union never sees them. **Collapses** once `root` (`:139`) is a
  `BoundedObject3D`.
- **`ContentTree`** — already half-converged: it exposes `getLocalBounds`
  (`:508-509`, via `subtreeContentBounds` with `includeOrigin=false`) and
  `getWorldBounds` (`:520`). Re-root the dir nodes + root (`:237/:74`) onto
  `BoundedObject3D` and move the walk into the contract — the three walk semantics it
  must absorb are in §7.6.
- **`WorldLayout` root**, **`StackContainer` as a parent of other containers** —
  aggregate for free once re-rooted.
- **The `userData.size` mock fallback** (`layouts/nodeUtils.js:86-94`) moves into the
  contract's child loop (§3 `_unionChild`): geometry-less test mocks contribute their
  declared box, one path serves real grids and mocks alike.

**Re-rooting these four hierarchies is still required work** — but the v2
justification (the dirty cascade must traverse them) is dead. The live justification:
the recursive union must be able to ask every container the same two questions, every
container needs `getBounds` (world) for free, and duck-typing halfway leaves two
systems. (The transparent-Group recursion in §3 exists so the tree keeps working
*while* individual nodes are un-rooted — it is transition insurance, not the end
state.)

### Bucket 3 — self-measuring derivations (override `getLocalBounds` directly)

The legitimate "I compute my own measures" escape hatch. Under recompute-per-read these
need no dirty management at all — inputs are read live.

- **`Book`** — already a `BoundedObject3D` (`:83`) bridging `getLocalBounds() →
  layoutBounds()` (`:590`). Make `getLocalBounds` the real method and fold the alias:
  head-sheet content ∪ **`deckBounds` (`:546-571`), which is analytical** — page rects
  from `_fitOpts` at each sheet's *live* z (`:557`), thickened by `zPad =
  (surfaceDepth ?? 8) + 2` (`:550`), with a closed-cover fallback for a sheetless book
  (`:563-569`). A child union cannot reproduce this — the comment at `:540-542` warns
  slot arithmetic leaves easing pages poking out of their binding. **Does not
  collapse.** Mid-ease reads are correct per-read; v2's "marks itself dirty per
  animator tick" concern evaporates.
- **`Carrel`** — geometric desk footprint (`:722-726`): `_shadow.scale` × `(_stackH ??
  boxH) + boxH*0.25` headroom. `_stackH` is stamped by layout from live member extents
  (`:154`, `:581`/`:586`) — under recompute-per-read the stamp is just state; no dirty
  call needed. Becomes `getLocalBounds` on re-root.
- **`StackContainer`** — `_box` (`:110`) is deliberately a **target-space snapshot**:
  child boxes translated to layout-*target* positions (`:200-207`),
  animation-independent by design. Keep the snapshot semantics; it becomes
  StackContainer's self-measured `getLocalBounds`, recomputed on relayout as today.

### Consumer buckets (what each reads)

- **[BOX / layout]** — layout managers, layout kit (`nodeUtils.leafBox`,
  `libraryLayout`, `Book.syncCover`, `ContentTreeLabels`), framing (`placeInView`,
  focus outline, `window.drop`, dock/carrel contain-fit, compass, tour, composition).
  Read `getLocalBounds`/`getBounds` — now unpadded for CodeGrid. **Padding-sensitive
  consumers to re-check:** `CanvasInteraction.jsx:892` (hover outline *wants* the
  padded edge — give it the background quad's box or re-add padding locally),
  `CameraDock._extentOf` (`CameraDock.js:679`), `Carrel._extentOf` (`Carrel.js:434`)
  (§7.3).
- **[SPHERE / cull]** — `GlyphField`'s native `frustumCulled` path off the stated box
  (no change), `OcclusionCuller` (`services/visual/OcclusionCuller.js:205/:211` — see
  §7.9 for the padding-shrink caveat).
- **[BACKGROUND]** — `CodeGrid._sizeBackgroundTo` (`:2177`) only; already owns padding.
  TerminalGrid/FrameGrid backgrounds already independent.
- **[WORLD-EXTENT]** — camera soft-bounds (`ViewerCameraController.js:605`), minimap
  (`Minimap.jsx:143` + `:121`), `MinimapOverlay`, `getTotalBounds` on the layout
  managers + diff framing. **Source under Measures: the same
  `sceneBounds.worldBounds(surfaces, opts)` helper, unchanged — see §6.**

---

## 6. What dies, and what survives (v3)

**Already dead (credit `c374023` — v2 planned to kill these; the GPU work killed them
first):**

- The CodeGrid mirror (`_workerBoundsCache` and its pairwise-sync argument).
- `_updateGeometryBounds`, its O(n) min/max, its gpuLayout early-return, and both
  staleness windows v2 filed as pre-work (§7.2, §7.8).
- The `43cc18c` world-box cache and its 16-float matrix snapshot.

**Dies in this refactor:**

- **The `layoutBounds` name, everywhere** — 27 sites in 12 files rename to
  `getLocalBounds` (CodeGrid `:660`, Book `:580`, StackContainer `:117`, FrameGrid
  `:330`, layout kit, layout managers).
- `Carrel.localBounds` → `getLocalBounds` (method `:722`; call sites
  `carrelCommands.js:144/186`). `AgentBooks.localBounds` (`:971`) collapses with its
  union.
- `ContentTree.getWorldBounds` (`:520`) → `getBounds`.
- The padding-in-bounds conflation (`CodeGrid.getLocalBounds` `:616-621` body).
- `AgentBooks._worldBounds` hand union + membership filter (structural under the
  contract, §5).
- The leaf/container seam gap: four hand-written container derivations fold into one
  default union + three declared overrides.

**Survives, deliberately:**

- **`sceneBounds.worldBounds(objects, target, opts)` stays the world-extent entry
  point — and needs no reimplementation.** v2 said "reimplemented over cached reads";
  there are no cached reads and none are needed. It is already a thin union over
  `getBounds()` (`sceneBounds.js:33-42`), and its "no cache, on-demand by design"
  header (`:10-14`) stopped being a scar and became the system's stance. The two
  reasons a single root box cannot replace it are unchanged and re-verified:
  1. **Topology:** terminals (`TerminalGrid.js:246` `scene.add(this)`), React-created
     CodeGrids (`packages/glyph3d-r3f/src/CodeGrid.jsx:64` — created at `:56`),
     FrameGrids (`frameCommands.js:99` → `ctx.addGrid`), and unmanaged carrels
     (`carrelCommands.js:154/191` `ctx.scene.add(carrel)`) are **not** under
     `world.root`. A root union silently drops them from the leash box and the minimap.
  2. **Semantics:** the soft-bounds call passes `{ skip: dockTiles }` (rationale
     `sceneBounds.js:25-27`), and the minimap passes `{ expandToInclude:
     camera.position }` (`:28-30`). A single cached root box can express neither.
- **Book's content∪deck computation, `Carrel`'s footprint, `StackContainer._box`** —
  bucket 3, semantics intact.
- **`subtreeContentBounds` semantics** for markers/arrows/probes/panelSurface (§7.6).

---

## 7. Caveats — the real hard cases (v3-verified)

### 7.1 Framed CodeGrid background needs the frame WINDOW, not the content extent — CONFIRMED
`CodeGrid._sizeBackgroundTo` (`:2177`): when `_frameRows > 0`, panel height is
`_frameRows × lineHeight + 2×padding` (`:2197-2203`), not the scrolled content height.
**Action (unchanged):** the background keeps its own frame-window height math; it
already reads the raw `_getContentBounds()` and adds padding itself, so stripping
padding from `getLocalBounds` touches it not at all.

### 7.2 FrameGrid field box vs analytical box — RESOLVED by `c374023`, caveat retired
v2 verified a real discrepancy: the O(n) min/max treated anchors as min-corner in y
while FrameGrid anchors at cell center, so the measured box was shifted +cellH/2 with
zero z-span. **The O(n) pass no longer exists.** FrameGrid states its own analytical
`getLocalBounds()` as the field's cull extent (`FrameGrid.js:209-211`) — field box ≡
analytical box by construction, the half-cell shift is gone, and the ±0.5 z-span that
edge-on picking uses (`:318-319`) is in the stated box. No pre-work, nothing to fix.

### 7.3 TerminalGrid: the history deck is the big term — STILL LIVE
`TerminalGrid.getLocalBounds()` (`:797-815`) covers the **panel only** (z ±1, plus
`_bgPadding` and the `(cx,cy)` centering). The field mesh still holds **all cells:
live screen + depth-history** (`_totalCount = _cellCount + _depthCount`, `:134-135`),
history pages at `z = −(p+1)·_depthZStep`, `y = (p+1)·_depthYStep` (`:1018-1019`) — and
the stated glyph extent `_glyphExtent` (`:1219-1236`, set at `:1204`) **includes the
deck**. So reading the field box would still inflate bounds with the whole deck, and
since `extentFromBox` (`CameraDock.js:119`, `Carrel.js:86`) feeds height **and center**
into placement, dock/carrel tiles would shrink **and shift**. Note the GPU-layout
change did **not** absorb terminals: their positions still ride the CPU branch of
`applyPrebuiltBuffers` (`GlyphField.js:1717-1728`) — but their bounds are closed-form
either way, so the resolution is unchanged: TerminalGrid's `contentBounds` is the
analytical panel box (bucket 1), exactly today's unpadded extent. Additionally,
dock/carrel contain-fit reads the **padded** box today — verify tile sizing after
padding removal and add an explicit margin in `_extentOf` (`CameraDock.js:679`,
`Carrel.js:434`) if the tiles snug up.

### 7.4 Lazy `_renderer` AND null extent on a live renderer
CodeGrid constructs `_renderer` lazily (`_ensureRenderer:1121`) and disposes it on
`dispose()` (`:1063`). `_getContentBounds` returns **null** — never an empty box —
when the renderer is absent (`:1546-1547`) or no committed item has an extent
(`:1557`); `clear()` (`:525`) empties `renderedTexts` and `setLayoutExtent(null)`
nuls the geometry echo (`GlyphField.js:1464`, `:1683-1688`). `contentBounds` must map
**both** to today's empty-box semantics. Layout, drag capture, and the focus path all
read freshly-constructed grids.

### 7.5 The plain-object `getContentBounds()` — much smaller than v2 thought
v2 worried the mirror's derived `width/height/depth` fields would need re-deriving at
consumers. They don't: `_getContentBounds` still returns `{min, max, width, height,
depth}` derived on read (`:1558`), and the per-item union maintains the same fields
(`GlyphLayoutCompute.js:193-195`). The whole remaining caveat: the public plain-object
`getContentBounds()` (`:644`) has an external reader (`StrataLayout.js:175`) — port it
to `Box3` or keep the derived convenience. One call site, one decision.

### 7.6 ContentTree walk semantics the contract must absorb
`subtreeContentBounds` (`layouts/nodeUtils.js:108`) is not a naive union:
1. skips `userData.isMarker` children (`:113`) — absorbed into the contract's child
   loop;
2. descends dirs **and `isLayoutGroup` containers** (jellyfish panels/rows —
   `nodeUtils.js:120-121`) so bounds come from the real grids at their current
   transforms: a warped panel's grids ride an arc, so its own flat layout box would
   understate the extent. Absorbed: re-rooted layout groups inherit the recursive
   union and must NOT override `getLocalBounds` with a flat self-box. The exception is
   `isVolume` — a volume is boxed via Book's own bounds because "descending it would
   box its sheet scaffolding instead of the bound form" (`:116-119`) — absorbed
   naturally: Book is a bounded leaf (bucket 3), the union never descends past a node
   that answers `getLocalBounds`;
3. `includeOrigin` (default `true`) unions the node's own origin. The consumers that
   rely on the `true` default are **`ContentTreeMarkers:121`, `ContentTreeProbes:73`,
   `ContentTreeLabels:121`** (v2 said "2 call sites each" for four consumers — wrong;
   `ContentTreeArrows:328` and `ContentTree:509` already pass `false`). The contract's
   union does **not** include the origin. These three consumers switch to
   `node.getLocalBounds()` **with an explicit origin-union at the call site** — a
   marker-only subtree should still have a position.
`ContentTree.getWorldBounds` (`:520-540`) additionally swaps books-riding-a-volume for
the volume's live deck box (`:524-538`) — with Book bounded as a leaf and the union
skipping non-bounded scaffolding, the contract reproduces this; verify against
`book-resolve.test.mjs`. Once ContentTree is bounded, this method is just `getBounds`
and the name folds.

### 7.7 StackContainer is a target snapshot, not a live union
See bucket 3. During an animator ease, child positions ≠ targets; a live recursive
union would *disagree* with `_box` mid-animation and layout consumes the target value.
Keep snapshot semantics; do not "fix" it into liveness.

### 7.8 Removal-only staleness — RETIRED by `c374023`
v2 filed: under gpuLayout the bounds write early-returned, so a removal-only flush left
both the mirror and the field box at the pre-removal extent. Both halves are gone. The
flush path removes the renderer entries (`CodeGrid.js:1280-1287`), re-dispatches, and
re-states the union (`:1312-1313`); `_getContentBounds` derives from live
`renderedTexts`, so the next read reflects the removal with no recompute pass and no
special case. No pre-work.

### 7.9 OcclusionCuller proxy shrink
The culler sizes a unit proxy from the box
(`services/visual/OcclusionCuller.js:205/:211`). Stripping padding shrinks the proxy
below the rendered background quad — a fully-occluded proxy can coincide with a visible
background sliver → slight over-cull. Mitigation: cull off the background quad's box
(the padded one) or accept and eyeball in the pixel pass (§9).

---

## 8. The audit invariant (v3)

Once Measures lands:

```
rg "geometry\.boundingBox" packages/ app/
```

returns **only** `GlyphField`'s write sites (`:1684/:1693`) and comments — **zero
reads in the whole system**. The closed form (fold extent / cell arithmetic / stored
snapshot) is the one source of layout truth; the geometry box is a cull-only artifact
written from it. A *read* anywhere else is a Measures violation by definition — either
a special data case that belongs in a bucket-3 override, or someone re-coupling layout
to the echo.

Companion invariant: `rg "getLocalBounds|getBounds" packages/ app/` should show no
implementation that isn't the contract base, a leaf `contentBounds`, a bucket-3
override, or a background quad sizing itself. And the vocabulary check:
`rg "layoutBounds|\.localBounds\b" packages/ app/` returns **zero** — two questions,
two names, no thirds. Scope note: `getWorldBounds` survives legitimately in
`app/commands/handlers/spatialHelpers.js` (tour/spatial/composition commands) as a
plain-object `{min,max,center}` command-layer helper — that is not the Measures
vocabulary and is out of scope for the zero-check; only `ContentTree.getWorldBounds`
folds.

---

## 9. Execution — atomic, no shims

Per house law: **all or nothing, no compat layers.** One landing. The two-question
vocabulary (§3) lands in the same change: `layoutBounds`, `Carrel.localBounds`, and
`ContentTree.getWorldBounds` rename into it.

**Pre-work: none.** v2's two pre-work items (the y-anchor fix in the O(n) min/max, and
an O(n) recompute on the removal-only path) both targeted `_updateGeometryBounds`,
which `c374023` deleted. §7.2 and §7.8 are retired, not scheduled.

**The landing, in dependency order:**
1. `BoundedObject3D` gains the seam (§3): `contentBounds`, `hasIntrinsicSize`, and the
   default `getLocalBounds` union with child-transform carry, `isMarker` skip,
   `userData.size` mock fallback, and transparent-Group recursion. `getBounds` is
   already correct — do not touch it.
2. Re-root `ContentTree` (dir nodes `:237` + root `:74`), `StackContainer` (`:71`),
   `Carrel` (`:98`), `AgentBooks.root` (`:139`) onto `BoundedObject3D`. Book already is
   (`:83`) — verify only.
3. Leaves: CodeGrid (`contentBounds` = `_getContentBounds` → Box3, §3; delete the
   padded `getLocalBounds` body `:611-623`; background untouched — it owns padding
   already), TerminalGrid (panel-only analytical `contentBounds`; `getLocalBounds`
   delegates; keep its `_localBoundsDirty` memo), FrameGrid (alias fold only).
4. Derivations: Book (`getLocalBounds` `:590` becomes the real method; `layoutBounds`
   `:580` folds), Carrel (`localBounds` `:722` → `getLocalBounds`), StackContainer
   (`_box` `:110` snapshot → `getLocalBounds`; `layoutBounds` `:117` folds).
5. `sceneBounds.worldBounds` — **no code change**; the tests prove `skip` /
   `expandToInclude` intact (§6).
6. Consumers: the three `includeOrigin` call sites (§7.6), hover outline
   (`CanvasInteraction.jsx:892`), dock/carrel `_extentOf` margin check (§7.3),
   `StrataLayout.js:175` (§7.5).
7. Vocabulary fold (§3): 27 `layoutBounds` sites → `getLocalBounds`,
   `Carrel.localBounds` 2 sites, `ContentTree.getWorldBounds` → `getBounds`. The audit
   greps (§8) prove none remain.

**Verification:**
- **Harnesses:** full `tools/*-check.mjs` + `*.test.mjs` green. Priority:
  `carrel.test` (contain-fit — §7.3 shift), `place-in-view-check` (framing),
  `codegrid-view-persist-check`, `dock-persist-check`, `layout-kernel-check`,
  `book-resolve.test.mjs` (§7.6 volume swap), `soft-bounds.test.mjs`,
  `scene-bounds.test.mjs` (skip/expand semantics), `window.drop` via windowCommands.
  The GPU gates (`layout-mirror.test.mjs`, `layout-extent.test.mjs`,
  `backtrack-layout.test.mjs`) must stay green — this refactor *reads* the fold extent;
  it must not perturb how it is computed.
- **The grep invariants** (§8).
- **Pixels (ground truth):** load a field, fly a cluster off-screen, confirm zero drawn
  pixels (native frustum cull intact); confirm framing/fit-all/soft-bounds; confirm
  terminal dock/carrel tiles keep size **and position** (§7.3); confirm the minimap
  still shows docked tiles, terminals, and unmanaged carrels (§6 topology); confirm the
  hover outline hugs the panel edge (§5).
- **Hard cases:** framed-window background (§7.1), FrameGrid framing/picking,
  marker/probe/label placement (§7.6 includeOrigin), mid-ease Book/StackContainer
  bounds (bucket 3).

---

## Key file:line references (v3, verified against HEAD with `c374023`)

- `GlyphField.js:1679` — `setLayoutExtent(box | null)`; null path `:1683-1688`;
  writes `:1693-1695`; cull-only rationale `:909-910`; clear→null `:1464`; CPU position
  branch (terminals/annotations) `:1717-1728`. `_updateGeometryBounds` is **gone**.
- `core/foldGeometry.js:145` — `foldExtent` (closed form from the scan's scalars;
  spans blank rows `:122`).
- `compute/GlyphLayoutCompute.js:182` — per-item `entry.fold`/`entry.extent`;
  union `width/height/depth` `:193-195`.
- `CodeGrid.js:1544-1559` — `_getContentBounds` (closed-form union on read; null at
  `:1546-1547`/`:1557`); `_displacementExtent` `:146`, `setDisplacements`
  `:326-346` (extent-stating); flush re-state `:1289-1313` (`setLayoutExtent :1313`);
  padded `getLocalBounds` `:611-623` (padding `:616`, `BOUNDS_Z_PAD` `:620-621`);
  `getContentBounds` `:644`; `layoutBounds` alias `:660-667`; `clear()` `:525`;
  `_ensureRenderer` `:1121`; `dispose` `:1063`; `backgroundPadding` default `:69`;
  `_sizeBackgroundTo` `:2177` (padding owned at `:2190`/`:2202-2203`, frame-window
  math `:2197-2203`).
- `collections/BoundedObject3D.js` (84 lines) — `getLocalBounds` abstract `:43-47`;
  `refreshExtent` `:55-65`; `getBounds` derived per call `:78-83`; why-no-cache
  header `:9-18`. The `43cc18c` cache is **gone**.
- `collections/FramedGlyphField.js:41/:109-110` — `_renderer` slot + accessor.
- Leaves: `TerminalGrid.js:797-815` (padded panel bounds, `_localBoundsDirty` memo),
  `_glyphExtent` `:1219-1236` stated at `:1204` (deck included — §7.3), deck
  `:134-135`/`:1018-1019`, `_bgPadding` `:203`, `_updateBackground` `:1465`;
  `FrameGrid.js:314-321` (analytical), stated as cull box `:209-211`, `layoutBounds`
  alias `:330-332`.
- Containers: `ContentTree.js:63/:74/:237` (plain class, Group nodes),
  `getLocalBounds` `:508-509`, `getWorldBounds` `:520-540`;
  `layouts/nodeUtils.js:86-94` (leafBox/mock fallback), `:108` (subtreeContentBounds,
  `isMarker` `:113`); `Book.js:83` (already BoundedObject3D), `deckBounds` `:546-571`,
  `layoutBounds` `:580-587`, `getLocalBounds` bridge `:590`;
  `AgentBooks.js:130/:139` (plain class, Group root), `_worldBounds` `:955` (filter
  `:959`), `localBounds` `:971`; `StackContainer.js:71`, `_box` `:110`, `layoutBounds`
  `:117`, union `:200-207`; `Carrel.js:98`, `localBounds` `:722-726`, `_stackH`
  `:154`/`:581`/`:586`.
- `services/spatial/sceneBounds.js:33` — `worldBounds(objects, target, opts)`; skip
  rationale `:25-27`; `expandToInclude` `:28-30`; on-demand stance `:10-14`. Survives
  unchanged (§6).
- `services/camera/ViewerCameraController.js:392/:595/:605` — per-frame sweep;
  `getSurfaces` contract `packages/glyph3d-r3f/src/context.jsx:53`.
- `packages/glyph3d-r3f/src/Minimap.jsx:121/:143` — per-frame proxy reads + union with
  `expandToInclude`. `packages/glyph3d-r3f/src/CodeGrid.jsx:56/:64` — React-created
  grids (§6 topology).
- Padding-sensitive consumers: `CanvasInteraction.jsx:892` (outline; padding comment
  `:31-33`), `CameraDock.js:679` (`_extentOf`), `Carrel.js:434` (`_extentOf`),
  `extentFromBox` `CameraDock.js:119` / `Carrel.js:86`;
  `services/visual/OcclusionCuller.js:205/:211` (§7.9); `StrataLayout.js:175` (§7.5).
- Vocabulary census: `layoutBounds` = 27 matches in 12 files; `Carrel.localBounds`
  call sites `carrelCommands.js:144/186`; `includeOrigin=true` consumers
  `ContentTreeMarkers:121`, `ContentTreeProbes:73`, `ContentTreeLabels:121`.

# Measures — retire the mirrored bounds system

**One-line thesis:** the codebase maintains a parallel bounds system that duplicates what
the field mesh already writes into standard Three.js geometry bounds. Adopt a single
**Measures** contract (prior art: the Swift `Measures`/`Bounds` delegation model): bounds
are a polymorphic seam where **leaves** declare intrinsic content and **containers**
aggregate their children. The mirror, the padding-in-bounds conflation, and the divergent
hand-written derivations collapse into it — atomically, no shims.

**Revision note (v2):** this draft was re-verified line-by-line against the current tree.
The v1 narrative overstated the per-frame cost (the `getBounds` world-box cache landed in
`43cc18c`), mis-scoped which containers "collapse," and missed the TerminalGrid history
deck, the `skip`/`expandToInclude` world-extent semantics, and the scene-topology gap.
Those are corrected below. Where v1 was wrong, the fix is in the design, not a footnote.

---

## 1. Context — what's actually wrong

The glyph field mesh writes the **real** per-instance extent into standard Three.js
geometry bounds:

- `GlyphField._updateGeometryBounds()` (`GlyphField.js:1797`) writes `geom.boundingBox`
  (`:1830`) and `geom.boundingSphere` (`:1832`), sourced from the worker's measured layout
  extent (O(1) precomputed path) or an O(n) min/max over `instancePosition` (`:1815-1829`).
  A third branch matters: under `gpuLayout` with no precomputed bounds it **early-returns
  and keeps the standing bounds** (`:1808-1813`) — see §7.8. Empty content writes
  `boundingBox = null` (`:1802`), not an empty box — see §7.4.

On top of that, **CodeGrid keeps a mirror**:

- `CodeGrid._workerBoundsCache` (declared `:146`, written at `:238/:327-332/:1284/:1300`),
  read via `_getContentBounds()` (`:1529`). Every write feeds the same object to the cache
  and to `_updateGeometryBounds(precomputed)` in one synchronous block, and CodeGrid's
  gpuLayout path never takes the O(n) fallback — so the scalars are identical at all
  times. The mirror is exact **pairwise**, with two qualifications:
  - It carries derived `width/height/depth` fields that `geometry.boundingBox` (a `Box3`)
    does not. They are live API: `_sizeBackgroundTo` reads `bounds.width/height`
    (`CodeGrid.js:2168-2169`) and `bounds.min.z` (`:2176`), and
    `GlyphLayoutCompute.js:236-243` exists specifically to keep those fields non-NaN.
    Deleting the mirror must re-derive them at the consumer (trivial, but not "nothing").
  - Only CodeGrid has a mirror. `TerminalGrid`/`FrameGrid` have no `_workerBoundsCache`;
    their `getLocalBounds` are padding+centering and analytical respectively (§7.2, §7.3).
- `CodeGrid.getLocalBounds()` (`:598`) = mirror **plus** `backgroundPadding` (default 1.0,
  `:69`) + `BOUNDS_Z_PAD` (0.5, `core/constants.js:42`) — conflating "the sheet's extent"
  with "the background panel's extent." Note one consumer *wants* the padding:
  `CanvasInteraction.jsx:892` draws the hover outline to "hug the panel edge."

**The field box is currently write-only.** Nothing outside `GlyphField` reads
`geometry.boundingBox` today (verified by grep). That is the strongest evidence the mirror
is pure redundancy: the canonical data exists and nobody trusts it.

**The per-frame picture — stated accurately.** `applyCamera` → `_applySoftBounds`
(`ViewerCameraController.js:595`, called from `:392`) runs `worldBounds(surfaces, …,
{ skip: dockTiles })` (`:605`) every frame, and `Minimap.jsx:143` runs a second union
every `useFrame` (plus a per-surface `getBounds()` at `:121` for proxies — 2N reads).
**But** since `43cc18c`, `BoundedObject3D.getBounds()` (`BoundedObject3D.js:137-150`) is
already cached on content-version + a 16-float `matrixWorld` snapshot, so on a still frame
each read is `updateWorldMatrix(true,false)` + an int compare + a matrix compare. What
actually remains per-frame: N × the ancestor matrix walk, and the *shape* of the sweep.
The problem is no longer "recompute every frame" — it is that **the same concept is
implemented five different ways** (mirror, padded bounds, four hand-written container
derivations, the sceneBounds helper), each with its own staleness story, and the
`sceneBounds` header ("an observed/cached extent is exactly the over-build that bit us
before — the BoundsObject3D lesson") documents a stale-cache scar from the parallel-system
era. The fix is one contract with internal, complete cache keys — not a new cache layered
on the old ones.

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
**one** fact about itself.

[MetalLink/Bounds/Bounds.swift]: https://github.com/tikimcfee/MetalLink/blob/main/Sources/MetalLink/Bounds/Bounds.swift
[MetalLink/Bounds/Measures.swift]: https://github.com/tikimcfee/MetalLink/blob/main/Sources/MetalLink/Bounds/Measures.swift

---

## 3. The contract (JS draft)

`BoundedObject3D` **becomes** the Measures base. Bounds are LOCAL (content) + WORLD
(content × transform). Two caches, two internal invalidation signals — no external dirty
flags maintained by consumers.

**Naming decision (changed from v1):** the contract keeps the **live API names** —
`getLocalBounds()` / `getBounds()` / `layoutBounds()` — and adds `contentBounds()` as the
new seam. v1's rename to `localBounds`/`worldBounds` would have turned "~50 no-op call
sites" into "~130 renamed sites" for zero semantic gain. (`Carrel.localBounds` is the one
outlier; it renames to `getLocalBounds` — 2 sites.)

```js
export default class BoundedObject3D extends THREE.Object3D {
    constructor() {
        super();
        this.hasIntrinsicSize = false;        // leaf = true (own content); container = false (aggregate children)
        // local AABB cache + dirty-cascade
        this._localBox = new THREE.Box3();
        this._localDirty = true;
        this._localVersion = 0;               // bumped when the box ACTUALLY moves → world-cache key
        // world AABB cache + matrix-snapshot key (covers self AND ancestor moves)
        this._worldBox = new THREE.Box3();
        this._worldMatrix = new THREE.Matrix4();
        this._worldLocalVersion = -1;
    }

    /** The entity's OWN content extent (local). THE geometry read, where one exists.
     *  Leaves override (field-box or analytical — see §5); containers inherit empty. */
    contentBounds(target = new THREE.Box3()) { return target.makeEmpty(); }

    /** Content/size changed → this union is stale, and so is every ancestor's.
     *  Cascade up once (O(depth)); recompute is lazy, on the next read. */
    markMeasuresDirty() {
        if (!this._localDirty) {
            this._localDirty = true;
            this.parent?.markMeasuresDirty?.();
        }
    }

    /** Reparenting dirties BOTH chains: the old parent loses a child, the new one gains
     *  one. This is what makes tree-membership filters (AgentBooks borrowed books,
     *  dock reparenting) safe under a recursive union. */
    add(...objs)    { super.add(...objs);    this.markMeasuresDirty(); return this; }
    remove(...objs) { super.remove(...objs); this.markMeasuresDirty(); return this; }

    /** Local AABB = own contentBounds (if intrinsic) ∪ children's local bounds
     *  (markers skipped). Cached: recompute only when dirty; bump the version ONLY if
     *  the box actually moved (so a child change that didn't reshape this union leaves
     *  the world cache valid). */
    getLocalBounds(target = new THREE.Box3()) {
        if (this._localDirty) {
            const next = _scratchBox.makeEmpty();
            if (this.hasIntrinsicSize) next.union(this.contentBounds(_scratch2));
            for (const c of this.children) {
                if (c.userData?.isMarker) continue;
                if (c.getLocalBounds) next.union(c.getLocalBounds(_scratch2));
            }
            if (!_boxEqual(next, this._localBox)) { this._localBox.copy(next); this._localVersion++; }
            this._localDirty = false;
        }
        return target.copy(this._localBox);
    }

    /** World AABB = localBounds × matrixWorld. Cached on (localVersion + matrix
     *  snapshot). This is today's `43cc18c` cache, promoted from bandage to contract. */
    getBounds(target = new THREE.Box3()) {
        this.updateWorldMatrix(true, false);
        this.getLocalBounds(_scratch2);                    // ensures _localVersion is current
        if (this._worldLocalVersion === this._localVersion
            && _matrixEquals(this._worldMatrix, this.matrixWorld)) {
            return target.copy(this._worldBox);            // both inputs unchanged → O(1)
        }
        this._worldBox.copy(this._localBox);
        if (!this._worldBox.isEmpty()) this._worldBox.applyMatrix4(this.matrixWorld);
        this._worldMatrix.copy(this.matrixWorld);
        this._worldLocalVersion = this._localVersion;
        return target.copy(this._worldBox);
    }
}
```

```js
// MeasuresDelegating — a wrapper forwarding the vocabulary to a delegateTarget.
class BoundedProxy extends BoundedObject3D {
    get hasIntrinsicSize() { return this.delegateTarget.hasIntrinsicSize; }
    contentBounds(t)  { return this.delegateTarget.contentBounds(t); }
    getLocalBounds(t) { return this.delegateTarget.getLocalBounds(t); }
    getBounds(t)      { return this.delegateTarget.getBounds(t); }
}
```

### Who calls `markMeasuresDirty` (the wiring v1 never specified)

"No external dirty wiring" means consumers never touch the flags — but **owners must
declare their own changes**. The complete call-site list:

1. **Leaf content change:** CodeGrid calls `markMeasuresDirty()` wherever it pushes new
   bounds today (`:238/:333/:1300`) and in `clear()` (`:512`). TerminalGrid/FrameGrid call
   it when their analytical inputs change (`_bgPadding`-free panel params, `width/aspect`).
2. **Reparenting:** the `add`/`remove` overrides above — covers AgentBooks borrowed
   books, dock reparenting, carrel membership, world registration.
3. **Self-measuring derivations** (§5 bucket 3): each marks itself dirty when its
   derivation inputs change (layout stamps `_stackH` on a Carrel; Book deck params
   change; StackContainer relayout retargets).

Note the cascade requires every ancestor on the chain to be a `BoundedObject3D` (optional
chaining stops at plain `Group`s). That forces the container re-rooting in §5 — it is not
optional.

### Field-mesh access path (CodeGrid's `contentBounds`)

A grid reaches its field mesh through `_renderer` (declared `FramedGlyphField.js:41`,
accessor `getRenderer()` `:109`; the renderer is a `GlyphField`, constructed lazily by
CodeGrid at `CodeGrid.js:1136` via `_ensureRenderer()` `:1109`):

```js
contentBounds(target = new THREE.Box3()) {
    const box = this._renderer?.instanceMesh?.geometry?.boundingBox;
    return box ? target.copy(box) : target.makeEmpty();   // see §7.4 — null box on a LIVE renderer
}
```

---

## 4. Why it's cheap — the Swift-witness analog, in JS

MetalLink recomputes the subtree on every read and leans on Swift's protocol-witness
devirtualization to hide the cost. **JS has no such compiler pass, so the caching must be
explicit.** The design makes the abstraction pay its dispatch cost **once per change, not
per read**:

- **Content change → dirty-cascade up (O(depth)), recompute lazy on read walking only the
  dirty path.** Most children are cache hits, so a leaf edit costs ~O(depth +
  dirty-subtree), paid *once* — not per frame.
- **Transform change → matrix-snapshot per entity.** An ancestor move changes each
  descendant's `matrixWorld` → each cache invalidates individually, no cascade. Native
  `updateMatrixWorld` stays the one per-frame matrix pass; Measures never re-derives
  transforms. (Honest accounting: the per-surface `updateWorldMatrix(true,false)` walk in
  `getBounds` remains — the refactor does not remove it; it removes the *duplicate bounds
  systems*, not the native matrix pass.)
- **Version-stable local cache.** A child dirty that doesn't reshape the parent's union
  leaves the parent's `_localVersion` unchanged → the parent's *world* cache stays valid.
- **Dispatch paid on miss, not per frame.** The polymorphism runs once per cache-miss; a
  read is a cache hit + a 16-float matrix compare.

The box is the canonical thing (layout reads it — you can't get axis-aligned extents from
a sphere). The sphere is a derivative (culling). Three.js's native per-mesh frustum cull
already runs off the field mesh's `geometry.boundingSphere`; Measures never re-implements
culling.

---

## 5. Crossover map — three buckets, not two

v1 said "four hand-written aggregations collapse into the contract default." Verification
says only one of the four is a pure aggregation. The honest map:

### Bucket 1 — intrinsic leaves (`hasIntrinsicSize = true`, override `contentBounds`)

- **`CodeGrid`** — `contentBounds` reads `_renderer.instanceMesh.geometry.boundingBox`
  (null-guarded, §7.4). The mirror (`_workerBoundsCache`, `_getContentBounds`, the padded
  `getLocalBounds`) is **deleted**. Padding moves to the background quad (§7.1);
  `width/height/depth` re-derived at the background site (§7.5).
- **`TerminalGrid`** — `contentBounds` is **analytical, panel-only** (cols×rows extent
  with the `(cx,cy)` centering, minus `_bgPadding`). It must NOT read the field box — the
  field mesh contains the scrollback history deck (§7.3). Padding moves to the terminal
  background, which already sizes independently (`_updateBackground:1433`).
- **`FrameGrid`** — `contentBounds` stays **analytical** (`width × (width/aspect)`,
  `FrameGrid.js:311-318`). The field box provably disagrees with it (§7.2), so the
  analytical form is canonical; the field-box discrepancy becomes a culling-only bug,
  filed as pre-work (§9).

### Bucket 2 — aggregating containers (`hasIntrinsicSize = false`, inherit the union)

- **`AgentBooks`** — `_worldBounds`/`localBounds` (`AgentBooks.js:934-960`) are a pure
  union over root-held books with a tree-membership filter (`lane.book.parent !==
  this.root` skips borrowed books). The recursive union expresses this **iff** the
  `add`/`remove` dirty wiring lands (§3) — reparenting a book to a Carrel must dirty both
  subtrees. **Collapses.**
- **ContentTree dir nodes + root**, **`WorldLayout` root**, **`StackContainer` as a
  parent of other containers** — aggregate for free **once re-rooted**: today
  `ContentTree` is a plain class whose dir nodes are `THREE.Group` (`ContentTree.js:237`),
  and `StackContainer`/`Carrel` extend `THREE.Object3D`. None are `BoundedObject3D`, so
  neither the union nor the dirty cascade can traverse them. **Re-rooting these four
  hierarchies onto `BoundedObject3D` is required work v1 didn't budget.**
  - ContentTree's walk has three semantics the contract must absorb (§7.6): skip
    `isMarker`, don't descend volumes, the `includeOrigin` term.
  - The `leafBox` mock fallback (`userData.size` for geometry-less test mocks,
    `layouts/nodeUtils.js:86-94`) moves into the contract: a child with no
    `getLocalBounds` but a `userData.size` contributes that box. Keeps "one path serves
    real grids and mocks alike."

### Bucket 3 — self-measuring derivations (override `getLocalBounds` directly)

The legitimate "I compute my own measures" escape hatch. These manage their own caching
and mark themselves dirty when inputs change; ancestors still treat them as opaque boxes.

- **`Book`** — `layoutBounds` (`Book.js:465`) = head-sheet content ∪ **`deckBounds`
  (`:431-456`), which is analytical**: page rects from `_fitOpts` (pageW/pageH/gutter) at
  each sheet's *live* z, thickened by `zPad = (surfaceDepth ?? 8) + 2`, with a
  closed-cover fallback for a sheetless book (`:448-454`). A child union cannot reproduce
  this — the comment at `:423-428` explicitly warns slot arithmetic leaves easing pages
  poking out of their binding. **Does not collapse.** Note: `deckBounds` reads live
  animated z, so Book marks itself dirty per animator tick during an ease (its cache
  simply misses mid-ease — same cost as today).
- **`Carrel`** — geometric desk footprint (`Carrel.js:722-728`): `_shadow.scale` ×
  `(_stackH ?? boxH) + boxH*0.25` headroom. Semi-derived: `_stackH` is stamped by layout
  from live member extents (`:154`, `:581`), so the stamp site is a `markMeasuresDirty`
  call.
- **`StackContainer`** — `_box` (`StackContainer.js:110`) is deliberately a **target-space
  snapshot**: child boxes translated to layout-*target* positions (`:199-206`),
  animation-independent by design (mid-ease, a live union would disagree with it; layout
  depends on the target value). Keep the snapshot semantics; it becomes StackContainer's
  self-measured `getLocalBounds`, recomputed on relayout (which is also its dirty signal).

### Consumer buckets (what each reads)

- **[BOX / layout]** — layout managers, layout kit (`nodeUtils.leafBox`,
  `libraryLayout`, `Book.syncCover`, `ContentTreeLabels`), framing (`placeInView`,
  `_planeOf`, focus outline, `window.drop`, dock/carrel contain-fit, compass, tour,
  composition). Read `getLocalBounds`/`getBounds` — unchanged call sites, now unpadded
  for CodeGrid. **Padding-sensitive consumers to re-check:** `CanvasInteraction.jsx:892`
  (hover outline *wants* the padded edge — give it the background quad's box or re-add
  padding locally), `CameraDock._extentOf` (`CameraDock.js:676`), `Carrel._extentOf`
  (`Carrel.js:434`) (§7.3).
- **[SPHERE / cull]** — `GlyphField`'s native `frustumCulled` path (no change),
  `OcclusionCuller` (reads the box per candidate per frame, `OcclusionCuller.js:205`,
  sizes a unit proxy — see §7.9 for the padding-shrink caveat).
- **[BACKGROUND]** — `CodeGrid._sizeBackgroundTo` (`:2143`) only. Padding becomes the
  background's own concern (§7.1). TerminalGrid/FrameGrid backgrounds already independent.
- **[WORLD-EXTENT]** — camera soft-bounds (`ViewerCameraController.js:605`), minimap
  (`Minimap.jsx:143` + `:121`), `MinimapOverlay.js:92/126`, `getTotalBounds` on the five
  layout managers + `DiffController.js:328` (fit-all/diff framing at
  `ViewerCameraController.js:1118/1175`). **Source under Measures: the same
  `sceneBounds.worldBounds(surfaces, opts)` helper — see §6 for why it survives.**

---

## 6. What dies, and what survives (corrected from v1)

**Dies:**

- The CodeGrid mirror: `_workerBoundsCache`, `_getContentBounds`, the padded
  `getLocalBounds`. (`layoutBounds()` `:647-654`, the unpadded Box3 form the layout kit
  already uses, is kept as a thin alias over the contract or folded into
  `getLocalBounds` — pick one name at execution.)
- The padding-in-bounds conflation (padding → background quads).
- `AgentBooks._worldBounds`/`localBounds` hand union (collapses into the contract).
- The object-level `Extent` `boundingSphere`/`boundingBox` bandage (`e800b13`) — verified
  write-only in packages; folds into the contract.
- The `sceneBounds` "no cache, it bit us once" *stance* — safe keys now exist.

**Survives, deliberately (v1 said otherwise):**

- **`sceneBounds.worldBounds(objects, target, opts)` stays the world-extent entry point**,
  reimplemented as a thin union over cached `getBounds()` reads. v1's "one cached read —
  `root.worldBounds`" is **not viable**, for two verified reasons:
  1. **Topology:** terminals (`TerminalGrid.js:246` `scene.add(this)`), React-created
     CodeGrids (`CodeGrid.jsx:64`), FrameGrids (`frameCommands.js:99` → `ctx.addGrid`
     fallback), unmanaged carrels (`carrelCommands.js:154/191`), and docked grids
     (reparented under `CameraDock`, itself a scene child) are **not** under
     `world.root`. A root union silently drops them from the leash box and the minimap.
     Reparenting everything under the world root is a behavioral change this refactor
     must not smuggle in.
  2. **Semantics:** the soft-bounds call passes `{ skip: dockTiles }` (docked tiles ride
     the camera; counting them makes the leash drag — the reason `skip` exists,
     `sceneBounds.js:25-30`), and the minimap passes `{ expandToInclude:
     camera.position }`. A single cached root box can express neither.
  What the camera *gains* is that every per-surface read is now contract-cached, and the
  union helper gets a registry-level memo later if profiling says the N×ancestor-walk
  matters. Not in this change.
- **`Book.layoutBounds`, `Carrel`'s footprint, `StackContainer._box`** — re-homed into
  bucket 3, semantics intact.
- **`subtreeContentBounds` semantics** for markers/arrows/probes/panelSurface (§7.6).

---

## 7. Caveats — the real hard cases (verified)

### 7.1 Framed CodeGrid background needs the frame WINDOW, not the content extent — CONFIRMED
`CodeGrid._sizeBackgroundTo` (`:2143`): when `_frameRows > 0`, panel height is
`_frameRows × lineHeight + 2×padding` (`:2166-2169`), centered at
`originY + 0.5·ls − frameH/2` (`:2181-2183`); the shader clips glyphs to the band while
`geometry.boundingBox` spans the full scrolled content. **Action (unchanged from v1, now
verified):** the background keeps its own frame-window height math; width, x-center, and z
come from the field box. Ports cleanly.

### 7.2 FrameGrid field box provably disagrees with the analytical box
v1 said "verify"; verified — they **do not agree**. The O(n) min/max in
`_updateGeometryBounds` treats anchors as min-corner in y (`py + sh`,
`GlyphField.js:1825`), but `FrameGrid._build` anchors y at cell **center**
(`FrameGrid.js:193-194`; the shader adds no y offset — `iPos.y` is the quad center,
`glyphVertex.js:120-121,136-138`). The computed box is shifted +cellH/2 in y and has zero
z-span vs the analytical ±0.5 that edge-on picking uses. Width agrees. **Resolution:**
FrameGrid's `contentBounds` is the analytical form (bucket 1) — consumers keep today's
behavior bit-for-bit. The underlying anchor-inconsistency in the O(n) pass (it affects
every CPU-path field's culling box) is filed as pre-work in §9 — it stops mattering for
*layout* the moment nothing reads the field box for FrameGrid, but it still mis-sizes the
frustum-cull sphere.

### 7.3 TerminalGrid: the history deck is the big term (v1 missed it entirely)
`TerminalGrid.getLocalBounds()` (`:797-815`) covers the **panel only** (z ±1, plus
`_bgPadding` and the `(cx,cy)` centering — where `cx = cols·strideX/2 − charWidth/2`
extends the box half a char *left* of instance min.x = 0, `:805`). But the field mesh
holds **all cells: live screen + depth-history** (`_totalCount = _cellCount +
_depthCount`, `:129-135`), history pages at `z = −(p+1)·_depthZStep`, `y =
(p+1)·_depthYStep` (`:1010-1032`, default 80 lines, `:108`). Reading
`geometry.boundingBox` would inflate bounds with the whole deck — much taller and deeper —
and since `extentFromBox` (`CameraDock.js:119-127`, `Carrel.js:86`) feeds height **and
center** into placement (`CameraDock.js:870-873`, `Carrel.js:468-470`), dock/carrel tiles
would shrink **and shift**. **Resolution:** TerminalGrid's `contentBounds` is the
analytical panel box (bucket 1), exactly today's unpadded extent. Additionally,
dock/carrel contain-fit reads the **padded** box today — verify tile sizing after padding
removal and add an explicit margin in `_extentOf` if the tiles snug up.

### 7.4 Lazy `_renderer` AND null `boundingBox` on a live renderer
CodeGrid constructs `_renderer` lazily (`_ensureRenderer:1109`, called from
`_beginLoad:399`) and re-nulls it on `dispose()` (`:1062`). But even with a live renderer,
`boundingBox` is **null** until the first commit and after `clear()` (n===0 writes null,
`GlyphField.js:1802`) — never an empty Box3. `contentBounds` must treat *both* as today's
empty-box semantics. Layout, drag capture, and the focus path all read
freshly-constructed grids.

### 7.5 The mirror's derived fields (`width/height/depth`)
`_sizeBackgroundTo` reads them (`CodeGrid.js:2168-2169,2176`);
`GlyphLayoutCompute.js:236-243` maintains them against NaN panel death. Under Measures,
the background derives `width = box.max.x − box.min.x` etc. from the `Box3` it already
fetches. The public `getContentBounds()` (`CodeGrid.js:631`) plain-object form has
external readers — check each and either port to `Box3` or keep a derived convenience.

### 7.6 ContentTree walk semantics the contract must absorb
`subtreeContentBounds` (`layouts/nodeUtils.js:108-130`) is not a naive union:
1. skips `userData.isMarker` children (`:113`) — absorbed into the contract's child loop;
2. refuses to descend `isVolume` nodes — a volume is boxed via `Book.layoutBounds`
   because "descending it would box its sheet scaffolding instead of the bound form"
   (`:116-122`) — absorbed naturally: Book is a bounded leaf (bucket 3), the union never
   descends past a node that answers `getLocalBounds`;
3. `includeOrigin` (default `true`, `:128`) unions the node's own origin — relied on by
   `ContentTreeMarkers`, `ContentTreeArrows`, `ContentTreeProbes`, `panelSurface` (2 call
   sites each; v1 mentioned none of them). The contract's union does **not** include the
   origin. These four consumers switch to `node.getLocalBounds()` **with an explicit
   origin-union at the call site** — that's the semantic they actually want (a marker-only
   subtree should still have a position).
`ContentTree.getWorldBounds` (`:520-540`) additionally swaps books-riding-a-volume for the
volume's live deck box (`:524-538`) — with Book bounded as a leaf and the union skipping
non-bounded scaffolding, the contract reproduces this; verify against
`book-resolve.test.mjs`.

### 7.7 StackContainer is a target snapshot, not a live union
See bucket 3. During an animator ease, child positions ≠ targets; a live recursive union
would *disagree* with `_box` mid-animation and layout consumes the target value. Keep
snapshot semantics; do not "fix" it into liveness.

### 7.8 Removal-only flushes leave the field box stale
Under gpuLayout with no precomputed bounds, `_updateGeometryBounds` early-returns
(`GlyphField.js:1808-1813`). A removal-only flush (`CodeGrid.js:1332-1343` →
`GlyphField.remove:1564` → `_rebuildAllInstances`) leaves **both** today's mirror and the
field box at the pre-removal extent. Conservative and pre-existing, but once the field
box is canonical the staleness is more visible. Cheap fix in scope: on the removal-only
path, run the O(n) recompute — removals are rare, and this deletes the staleness window
rather than inheriting it.

### 7.9 OcclusionCuller proxy shrink
The culler sizes a unit proxy from the box (`OcclusionCuller.js:205-211`). Stripping
padding shrinks the proxy below the rendered background quad — a fully-occluded proxy can
coincide with a visible background sliver → slight over-cull. Mitigation: cull off the
background quad's box (the padded one) or accept and eyeball in the pixel pass (§9).

---

## 8. The audit invariant (revised)

Once Measures lands:

```
rg "geometry\.boundingBox|geometry\.boundingSphere" packages/ app/
```

returns **only** `GlyphField`'s write sites (`:1802/:1830/:1832`) and
`CodeGrid.contentBounds`. TerminalGrid/FrameGrid don't appear — their content is
analytical (§7.2, §7.3) — which is exactly why the invariant is auditable: one geometry
read in the whole system. A hit anywhere else is either a **special data case**
(Book/Carrel/StackContainer overriding `getLocalBounds` — none of which read geometry) or
a **Measures update someone forgot to wire** (`markMeasuresDirty`). That invariant is how
the system stays honest as it grows.

Companion invariant: `rg "getLocalBounds|getBounds" packages/ app/` should show no
implementation that isn't the contract base, a bucket-3 override, or a background quad
sizing itself.

---

## 9. Execution — atomic, no shims

Per house law: **all or nothing, no compat layers.** One landing. No transitional
`getBounds` that secretly still mirrors, no flag, no rename of the live API.

**Pre-work (lands first, independently reviewable):**
1. Fix the y-anchor inconsistency in `_updateGeometryBounds`'s O(n) min/max
   (`GlyphField.js:1815-1829`) — match the shader's center-anchor semantics. After the
   refactor this box feeds culling only, but a half-cell-shifted cull box is a live bug
   today for every CPU-path field.
2. O(n) recompute on the removal-only flush path (§7.8).

**The landing, in dependency order:**
1. `BoundedObject3D` gains the contract (§3): `contentBounds`, `getLocalBounds`, dirty
   cascade, `add`/`remove` overrides, `isMarker` skip, `userData.size` mock fallback.
   The existing `43cc18c` world-cache becomes `getBounds` verbatim.
2. Re-root `ContentTree` (dir nodes + root), `StackContainer`, `Carrel`, `AgentBooks.root`
   onto `BoundedObject3D` (§5 bucket 2).
3. Leaves: CodeGrid (field-box `contentBounds` + delete mirror + `markMeasuresDirty` at
   the three push sites + `clear()`), TerminalGrid/FrameGrid (analytical
   `contentBounds`). Padding moves to background quads (§7.1, §7.3).
4. Derivations: Book/Carrel/StackContainer re-home their computations as `getLocalBounds`
   overrides with dirty-on-input-change (§5 bucket 3).
5. `sceneBounds.worldBounds` reimplemented over the contract, `skip`/`expandToInclude`
   intact (§6).
6. Consumers: the four `includeOrigin` call sites (§7.6), hover outline
   (`CanvasInteraction.jsx:892`), dock/carrel `_extentOf` margin check (§7.3),
   `getContentBounds()` plain-object readers (§7.5), `Carrel.localBounds` rename.

**Verification:**
- **Harnesses:** full `tools/*-check.mjs` + `*.test.mjs` green. Priority:
  `carrel.test` (contain-fit — §7.3 shift), `place-in-view-check` (framing),
  `codegrid-view-persist-check`, `dock-persist-check`, `layout-kernel-check`,
  `book-resolve.test.mjs` (§7.6 volume swap), `soft-bounds.test.mjs`,
  `scene-bounds.test.mjs` (skip/expand semantics), `window.drop` via windowCommands.
- **The grep invariants** (§8).
- **Pixels (ground truth):** load a field, fly a cluster off-screen, confirm zero drawn
  pixels (native frustum cull intact); confirm framing/fit-all/soft-bounds; confirm
  terminal dock/carrel tiles keep size **and position** (§7.3); confirm the minimap still
  shows docked tiles, terminals, and unmanaged carrels (§6 topology); confirm hover
  outline hugs the panel edge (§5).
- **Hard cases:** framed-window background (§7.1), FrameGrid framing/picking (§7.2),
  marker/arrow/probe placement (§7.6 includeOrigin), mid-ease Book/StackContainer bounds
  (bucket 3).

---

## Key file:line references (re-verified)

- `GlyphField.js:1797` — `_updateGeometryBounds`; writes `:1802` (null on empty),
  `:1830` (box), `:1832` (sphere); gpuLayout early-return `:1808-1813`; O(n) pass
  `:1815-1829` (y-anchor bug §9). Callers: `:1109/:1575/:1735/:1772/:1878` + CodeGrid
  `:238/:333/:1300`.
- `CodeGrid.js:146` — `_workerBoundsCache` declaration; writes `:238/:327-332/:1284/:1300`;
  `_getContentBounds` `:1529`; public `getContentBounds` `:631`; unpadded `layoutBounds`
  `:647-654`; padded `getLocalBounds` `:598` (padding `:607-608`).
- `CodeGrid.js:2143` — `_sizeBackgroundTo` (frame-window math `:2156-2189`).
- `CodeGrid.js:1109` — `_ensureRenderer` (lazy); `dispose` re-nulls `:1062`.
- `FramedGlyphField.js:41/109` — `_renderer` slot + accessor.
- `BoundedObject3D.js:137-150` — the `43cc18c` world-box cache (becomes the contract's
  `getBounds`); `refreshExtent` `:101-110`; object-level Extent bandage `:97-98`.
- `services/spatial/sceneBounds.js:33` — `worldBounds(objects, target, opts)`; skip
  rationale `:25-30`; survives (§6).
- `ViewerCameraController.js:392/595/605` — per-frame sweep caller; `getSurfaces`
  contract `context.jsx:43-55`.
- `packages/glyph3d-r3f/src/Minimap.jsx:121/143` — per-frame proxy reads + union with
  `expandToInclude`.
- Leaves: `TerminalGrid.js:797-815` (panel bounds), `:129-135`/`:1010-1032` (history
  deck §7.3), `:1433` (independent background); `FrameGrid.js:311-318` (analytical),
  `:193-194` (center anchor §7.2).
- Containers: `ContentTree.js:508/520-540`, `layouts/nodeUtils.js:86-94` (leafBox/mock
  fallback), `:108-130` (subtreeContentBounds semantics §7.6); `Book.js:431-456`
  (deckBounds), `:465` (layoutBounds); `AgentBooks.js:934-960`;
  `StackContainer.js:110/:199-206` (target snapshot §7.7); `Carrel.js:722-728`
  (footprint), `:154/:581` (`_stackH` stamps).
- Padding-sensitive consumers: `CanvasInteraction.jsx:892`, `CameraDock.js:676`
  (`_extentOf`), `Carrel.js:434` (`_extentOf`), `extentFromBox` `CameraDock.js:119-127` /
  `Carrel.js:86`.

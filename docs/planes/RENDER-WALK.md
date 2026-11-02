# The render walk: what three visits each frame, and how to visit less

three's `WebGLRenderer.render(scene, camera)` walks the scene graph every call (`projectObject`) to
build its render list. On the agents' display shape that walk is the largest single main-thread cost.
This note measures where the visits go, weighs the ways to cut them, and measures the recommended
one — option 4, the flat render root, which is built: `collections/FlatRenderRoot.js` (see "Built"
below).

## Method

- A private relay (`serve --port 8099 --tmux-socket <scratch>` on a scratch root) with gomuxai on —
  the hub is the subject — and the page started with `gomux.autoScreens=false` seeded before load
  (`frame-profile.mjs --setting`), so no agent screens opened (relay log: 0 screens, 0 pipe-pane,
  0 resize-window). The shape: ~3,100 glyph fields, the hub, its desks and books.
- Steady state, no pointer: `tools/frame-profile.mjs` (sampling CPU profile, census).
- The visit census is page-side (`tools/probes/render-walk-census.js`): it walks the scene exactly as
  `projectObject` does — a node with `visible === false` prunes its subtree; layers prune nothing —
  and classifies each visited node.
- The prototype was installed page-side (`tools/probes/render-walk-flat-root.js`).

## Where the visits go (measured)

| | nodes |
|---|---|
| in the scene | 17,190 |
| pruned under 3,028 invisible roots (never visited) | 10,681 |
| **visited by `projectObject` per render** | **6,509** |

The 6,509 visits:

| what the visited node is | visits | share |
|---|---|---|
| a container (no geometry: Group, Object3D, owners' own nodes) | 3,307 | 51% |
| a drawable OFF layer 0 — a batched panel (1,598), a batched label (307), pick-only (23) | 1,928 | 30% |
| a drawable on layer 0, outside the frustum (culled) | 1,050 | 16% |
| a drawable on layer 0, drawn (216) or never culled (8) | 224 | 3.4% |

By owner (the nearest node of a non-generic class): CodeGrid 3,514 (758 grids, ≈4.6 nodes each),
Book 1,367, plain Object3D 921, ActionPage 273, Tab3D 273, ScrollDocument 84, FieldLabel 34,
AgentNameplate 15. By node class: Mesh 3,185, Group 1,582, CodeGrid 758, Object3D 307.

The main scene is rendered once per frame. A pick renders it once per channel (the picking system's
`_renderChannelPass`) — not measured here: the headless runs had no pointer.

Cost: `projectObject` self time was 1.22, 1.66 and 1.28 ms/frame in three baseline runs (25.6% of
main-thread self time in the census run). A replica of the bare walk — the `visible` check, the layer
test, the recursion — over the same 6,509 nodes takes 0.33 ms. The `visible` accessor
(SceneTransforms makes `Object3D.prototype.visible` one) shows separately at ≈0.2 ms/frame: three
reads it at every visit.

Only 224 of 6,509 visits (3.4%) put anything in the render list; 1,050 more are frustum tests that fail.

## The options

**1. Layers.** They don't prune. In `projectObject` the layer test only gates the render-list push;
the children are walked regardless (three r185 source). The batches already take their objects off
layer 0, and three still visits every one.

**2. `visible = false` on batched-only subtrees around the main render.** three would prune them. But
`visible` is SceneTransforms' accessor: every flip bumps the show generation, so every `isShown` /
`rootOf` cache re-walks, and the batches and GlyphFarLod (which read `isShown`) would see those
objects hidden. Pick passes need the same objects (they draw on pick layers), so the flip would have
to be undone around every pick. It changes the meaning of the one visibility flag the scene's systems
share. Not measured.

**3. A custom `projectObject`.** It is a closure-private function inside `WebGLRenderer`; replacing it
means patching or forking three, re-done at every upgrade, and the WebGPU renderer has its own walk.
A last resort.

**4. A flat render root (measured, recommended).** Render a stand-in `Scene` whose `children` is the
list of SHOWN, layer-0 drawables — the logical tree stays as it is; nothing is reparented. three's
walk never consults `parent`, so the real objects draw from the list with their own `matrixWorld`,
materials, `renderOrder`, `frustumCulled`. The root:
- shares the scene's `background` / `fog` / `environment` (by reference);
- has `matrixWorldAutoUpdate = false`; the scene's `updateMatrixWorld()` (SceneTransforms) runs first,
  as three's render would have run it;
- forwards `onBeforeRender` / `onAfterRender` to the real scene, and fills its list AFTER the scene's
  hooks run (the batches flip layers there).

**5. Fewer nodes per owner.** A CodeGrid is ≈4.6 nodes; 758 of them are 3,514 visits. Flattening the
owners' internal groups would also shorten SceneTransforms' and the pick passes' walks — but it is a
refactor per class. Not measured.

## The prototype (option 4), measured

Preconditions on this scene (checked by the probe): no Group with a non-zero `renderOrder` (three
passes a Group's `renderOrder` down as the group order — flattening would lose it); no lights, no
sprites; no drawable with its own `onBeforeRender` (it would receive the root as its `scene`
argument).

Correctness: one frame rendered the normal way and one through the flat root, same camera — pixel
hashes equal, **0 bytes differ**, in both runs.

The prototype rebuilds the list every render with a JS walk (the honest worst case):

| run pair | `projectObject` self, ms/frame | the list's JS walk, ms/render |
|---|---|---|
| 1 | 1.66 → **0.34** | 0.85 |
| 2 | 1.28 → **0.18** | 0.79 |

So rebuilt every frame it nets ≈0.3–0.5 ms/frame. But at steady state **the list changed 0 times in
241 renders** (4 s) — a list rebuilt only when something it depends on changes would cost nothing at
rest, leaving the 1.1–1.3 ms/frame saving whole. (Main-thread p50 swings between runs on this shape
more than the change does — 2.2 to 4.7 ms across baselines — so the claim rests on the
`projectObject` self time and the churn count.)

## What it touches

- **The list's change signals.** It depends on (a) membership and (b) visibility — SceneTransforms'
  show generation already moves on both — and (c) layer-0 membership, which nothing tracks today:
  PanelBatch / GlyphBatch take objects off layer 0, GlyphFarLod moves fields on and off it, a refused
  batch member goes back on. A layer-0 generation needs `THREE.Layers` writes hooked (`enable`,
  `disable`, `set`, `toggle`, `enableAll`, `disableAll`, and `mask` as an accessor — the picking
  system's panel-cut path assigns `layers.mask` directly). Bumping only when bit 0 changes keeps the
  batches' idempotent per-frame `disable` free.
- **Picking.** Unchanged by default: pick cameras don't see layer 0, so their renders take the full
  walk as today. The same idea extends to them: the picking system already holds each channel's
  registered meshes and could render a flat root of the shown ones — the pick walk becomes the
  channel's entries. Not measured.
- **SceneTransforms.** Unchanged — it still owns the logical tree's matrices and the show generation.
- **GlyphFarLod.** Unchanged; its layer flips are exactly what the layer-0 signal must report.
- **PanelBatch / GlyphBatch.** Unchanged: their `scene.onBeforeRender` hook is forwarded before the
  list is collected, and their reach (`rootOf` / `isShown`) reads the logical tree.
- **Other renders of the scene** (overlay or card passes on other layers) take the full walk unless
  routed the same way.

## Not measured

- List churn under camera motion (GlyphFarLod flips fields across its threshold as distances change;
  each flip would trigger a rebuild, ≈0.8–1.0 ms by the prototype's walk).
- Pick-pass walk cost (no pointer in the headless runs).
- The WebGPU renderer (this is WebGL2's `WebGLRenderer`).

## Built: the flat render root

`collections/FlatRenderRoot.js`, installed in `CommandProvider` at the renderer: every
`renderer.render(scene, camera)` — r3f's frame, the minimap's main pass, a screenshot — renders the
root instead when the camera sees layer 0 (`render.flatRoot`, Settings ▸ Performance, on by default).
Cameras off layer 0 (pick channels, the plane overlay, carrel cards) render the scene as before.

- **The key.** The list is rebuilt when SceneTransforms' show generation (visibility, membership), the
  module's layer generation, or the camera's mask moves. The layer generation hooks `THREE.Layers`'
  write methods and moves only when a bit the view camera sees changes — the batches' idempotent
  per-frame `disable` and the pick passes' own layers move nothing. A direct `layers.mask =` write is
  invisible to it; the picking system's cut path wrote one, and now goes through `enable`/`disable`
  (`tools/flat-root.test.mjs` scans the source for any).
- **Walked whole.** What three's walk does beyond pushing a drawable is kept by handing three that
  node whole: a Group with a non-zero `renderOrder`, a light, an LOD, a light-probe grid. Draw order
  doesn't depend on list order (three sorts by group order, renderOrder, program, depth, id).
- **Refused, loudly.** A drawable whose own `onBeforeRender` could read the scene argument (three's
  no-op and the fat lines' resolution hook can't — they pass) and a shadow-casting light: a
  `console.error` naming the object, and the scene itself renders until the scene changes and the
  check passes again. The agents' display first met one this way — the ownership traces are fat
  lines (`LineSegments2`), whose prototype hook reads only the renderer.
- **`scene.render`** reports serving/refused, list size, rebuilds, and checks the list against a
  fresh walk; `scene.render time [n]` times the render call both ways on the live frame.

Gates: `tools/flat-root.test.mjs` (three's walk replicated over the root and the scene: same render
items × group order and lights after every kind of change; rebuild counts; refusals; mutation-tested:
dropping the ordered-group carry, the layer bump or the show-generation key each fails it) and
`tools/flat-root-check.mjs` (GPU: 0 bytes differ flat vs full at fit-all × 4 distances, five
mid-flight samples of a fly, a plane view, the library layout and a plane view there — each with
teeth, a half list that must differ; 0 rebuilds in a second at rest).

Measured after building (hub shape, private relay, screens off, three A/B pairs of 240 frames):

| | flat | full |
|---|---|---|
| `projectObject` self, ms/frame | 0.35 · 0.18 · 0.24 | 1.47 · 1.08 · 0.72 |
| main render CPU p50, ms | 2.9 · 2.4 · 1.7 | 3.2 · 3.5 · 3.9 |
| main-thread p50, ms/frame | 4.0 · 3.3 · 2.4 | 4.0 · 4.4 · 4.8 |

The list holds 1,274 drawables there, rebuilt 63 times during the load and 0 times in 24 s at rest. On
the agents' display (live agents, `scene.render time 40`): 0.7–1.0 ms flat vs 1.1–1.7 ms full per
render; ~5 rebuilds per 10 s while books grow.

Not done: the pick channels (a flat root per channel from the picking system's own entries).

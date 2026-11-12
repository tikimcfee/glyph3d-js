# The render walk: what three visits each frame

three's `WebGLRenderer.render(scene, camera)` walks the scene graph every call (`projectObject`) to
build its render list. On a display of a few thousand glyph fields that walk is the largest single
main-thread cost, and almost none of what it visits draws. This note says where the visits go and
what the renderer does to visit less.

## Where the visits go

Measured on the agents' hub shape (a private relay with gomuxai on, agent screens off; ~3,100 glyph
fields, the hub, its desks and books; steady state, no pointer). A page-side census walked the scene
exactly as `projectObject` does — a node with `visible === false` prunes its subtree; layers prune
nothing — and classified each visited node:

| | nodes |
|---|---|
| in the scene | 17,190 |
| pruned under 3,028 invisible roots (never visited) | 10,681 |
| **visited by `projectObject` per render** | **6,509** |

| what the visited node is | visits | share |
|---|---|---|
| a container (no geometry: Group, Object3D, owners' own nodes) | 3,307 | 51% |
| a drawable OFF layer 0 — a batched panel, a batched label, pick-only | 1,928 | 30% |
| a drawable on layer 0, outside the frustum (culled) | 1,050 | 16% |
| a drawable on layer 0, drawn or never culled | 224 | 3.4% |

`projectObject`'s self time there was 1.2–1.7 ms/frame through the full tree.

Why the obvious levers don't work:

- **Layers don't prune.** In `projectObject` the layer test only gates the render-list push; the
  children are walked regardless. The batches take their objects off layer 0, and three still visits
  every one.
- **`visible = false` around the render** would prune, but `visible` is SceneTransforms' accessor:
  every flip moves the show generation the batches and far-LOD read, and the pick passes need the
  same objects. It would change the meaning of the one visibility flag the scene's systems share.
- **A custom `projectObject`** is closure-private inside `WebGLRenderer`: a fork of three.

## The flat render root

`collections/FlatRenderRoot.js`, installed in `CommandProvider` at the renderer: every
`renderer.render(scene, camera)` — r3f's frame, the minimap's main pass, a screenshot — renders the
root instead when the camera sees layer 0 (`render.flatRoot`, Settings ▸ Performance, on by default).
Cameras off layer 0 (the pick passes) render the scene itself.

The root is a stand-in `Scene` whose `children` is the list of SHOWN drawables the view camera sees.
The logical tree stays as it is — nothing is reparented: three's walk never consults `parent`, so
each object draws with its own `matrixWorld`, material, `renderOrder` and frustum culling. The root
shares the scene's `background` / `fog` / `environment`, never updates matrices itself (the scene's
`updateMatrixWorld` — SceneTransforms — runs first, as three's render would run it), and forwards
the scene's `onBeforeRender` / `onAfterRender`; the list is collected after them (the batches flip
layers there).

- **The key.** The list is rebuilt when SceneTransforms' show generation (visibility, membership), the
  module's layer generation, or the camera's mask moves. The layer generation hooks `THREE.Layers`'
  write methods and moves only when a bit the view camera sees changes — the batches' idempotent
  per-frame `disable` and the pick passes' own layers move nothing. A direct `layers.mask =` write is
  invisible to it: write layers through their methods (`tools/flat-root.test.mjs` scans the source
  for any).
- **Walked whole.** What three's walk does beyond pushing a drawable is kept by handing three that
  node whole: a Group with a non-zero `renderOrder` (three hands it down as the group order), a
  light, an LOD, a light-probe grid. Draw order doesn't depend on list order (three sorts by group
  order, renderOrder, program, depth, id).
- **Refused, loudly.** A drawable whose own `onBeforeRender` could read the scene argument (three's
  no-op and the fat lines' resolution hook can't — they pass) and a shadow-casting light: a
  `console.error` naming the object, and the scene itself renders until the scene changes and the
  check passes again.
- **`scene.render`** reports serving/refused, list size, rebuilds, and checks the list against a
  fresh walk; `scene.render time [n]` times the render call both ways on the live frame.

Gates: `tools/flat-root.test.mjs` (three's walk replicated over the root and the scene: same render
items × group order and lights after every kind of change; rebuild counts; refusals; teeth:
dropping the ordered-group carry, the layer bump or the show-generation key each fails it) and
`tools/flat-root-check.mjs` (GPU: 0 bytes differ flat vs full at fit-all × 4 distances, five
mid-flight samples of a fly and the library layout — each with teeth, a half list that must differ;
0 rebuilds in a second at rest).

Measured on the hub shape (three A/B pairs of 240 frames):

| | flat | full |
|---|---|---|
| `projectObject` self, ms/frame | 0.35 · 0.18 · 0.24 | 1.47 · 1.08 · 0.72 |
| main render CPU p50, ms | 2.9 · 2.4 · 1.7 | 3.2 · 3.5 · 3.9 |

The list holds ~1,300 drawables there and is not rebuilt at rest.

## Not covered

- The WebGPU renderer (this is WebGL2's `WebGLRenderer`).
- The wall app (`wall/`) installs its own scene systems; the flat root reaches it when its renderer
  is routed the same way.

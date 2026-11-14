# Rendering

The glyph renderer in `@glyph3d/core`: draw, layout, picking, culling, LOD, batching, transforms, uploads.

## Single instanced draw call

**Single instanced draw call.** Text becomes a `Float32Array` of per-glyph instance
attributes (built single-pass, optionally in a Web Worker via `WorkerBridge`) and
renders as one `InstancedBufferGeometry`. A field's group table (per-group pose, colour, clip)
starts at one row — group 0, all most fields use — and `createGroup` doubles it on demand up to
`groupCap` (past it: loud, the dead group); the 1×1 placeholder textures are shared by every glyph
material. Gate: `tools/group-table.test.mjs`.

## CodeGrid

**CodeGrid** is a source file as an `Object3D` — cursor + in-place edit ops, highlight
ranges, a windowing/framing layout, and a caret overlay. The edit path funnels
through `_relayoutPreservingCursor()`.

## Layout

**Layout** flows through the `LayoutDescription` seam (`core/LayoutDescription.js`):
modes are params, set via `grid.layout` / `grid.frame` / `grid.scroll`. Glyph positions
are written on the CPU by `core/LayoutGenerator.js` into `InstancedSlotBuffer` slots;
the page fold is `core/foldGeometry.js` (`pageFold` / `pageShift`), the same one
`LayoutDescription` answers caret / pick / extent queries with
(`tools/layout-generator-fold.test.mjs` binds them).

## GPU picking

**GPU picking** (`picking/`) is a multi-channel ID render pass (separate glyph and
grid channels) — the single source of truth for hover/click resolution. `pick(channels,
camera, scene, x, y)` draws each channel into one pixel through a camera narrowed to the
cursor's pixel (`setViewOffset`, so culling drops all but what's under it) and reads them
back together with three's fenced `readRenderTargetPixelsAsync` — the main thread never
waits on the GPU. Each channel's pass draws its own flat list of the shown meshes on its layer
(a FlatRenderRoot per channel, rebuilt only when visibility, membership or that layer move;
`pick.flatRoot`, on, is the A/B) — not three's walk of the whole scene per channel. Hover picks run
as fast as they land unless `pick.hoverHz` caps them. Gates: `tools/pick-flat-root.test.mjs`,
`tools/pick-flat-root-check.mjs`.

## Frustum culling

**Frustum culling** is three's built-in per-object cull, on by default for glyph fields
and panels. three can't compute an instanced field's bounds (it sees only the base quad),
so each field STATES them: `InstancedField.setLayoutExtent` takes the laid-out extent and
adds the shader's right-side overdraw (an emoji quad is as wide as it is tall) before
writing `geometry.boundingBox/Sphere` — the box three culls, depth-sorts, and raycasts by.
`tools/glyph-cull-truth.mjs` checks every live quad against it. (Fields moved through the
group table — the content-tree labels — opt out. Culling covers draws, not GPU memory.)

## Flat render root

**Flat render root** (`collections/FlatRenderRoot.js`): the view camera renders a flat list of the
drawables it can see — rebuilt only when visibility, scene membership or layers move (layer writes are
watched per layer bit; go through the `Layers` methods) — not the scene tree: three's walk visits what draws, not
every container (~6.5k visits a frame → ~1k on the hub). The seam is the renderer's `render` (r3f's
frame, the minimap's main pass, a screenshot), wrapped by `SceneSystems`; a camera off layer 0
(the pick passes) gets the scene itself. What three must walk itself (a Group with renderOrder, lights, LODs) goes in whole; a
drawable whose own onBeforeRender may read the scene, or a shadow-casting light, switches it off
loudly (named) until the scene changes. `render.flatRoot` (on) is the A/B; `scene.render [time n]`
reports it and checks it against a fresh walk. Gates: `tools/flat-root.test.mjs`, `tools/flat-root-check.mjs`.

## Colour

**Colour** is three's standard colour management end to end — its defaults, nothing bypassed.
A colour is SPECIFIED in sRGB (a hex, a `{ r, g, b }`, a glyph lane's packed RGB, a program's
SGR, an emoji's or a frame's pixels), and where it is drawn at full coverage the canvas holds
that value (`wall-e2e` reads it back, ±2). Between the two, three's working space is linear: a
`THREE.Color` and an sRGB-tagged texture (`colorSpace = SRGBColorSpace` — the emoji atlas,
frames, label plates; the sampler decodes) hold linear colour, and every shader ends in three's
output conversion (`linearToOutputTexel` / `<colorspace_fragment>`: panels, the cursor, the grid
floor, the built-ins). The glyph and far-LOD shaders' lanes (slot, group, highlight, tint) stay
sRGB and reach the output through the same two transfer functions (`laneOut`,
`core/glyphMaterial.js`). No tone mapping: `GlyphCanvas` is r3f-`flat` (r3f otherwise switches
ACES on after the renderer is made). Coverage and opacity apply to the ENCODED colour — WebGL
blends the canvas that way, so the glyph shader composites a cell's own fill that way too, and
an edge weighs the same over a fill as over the panel behind it (gamma-space blending, a
terminal's native look); a far backdrop's tint is the mean of its ink's sRGB for the same
reason. Where plain sRGB meets three, the crossing is three's own: into a `THREE.Color` or a
vertex-colour attribute by `setRGB(r, g, b, SRGBColorSpace)`, out to a glyph lane or a 2D
canvas by `getRGB(…, SRGBColorSpace)` / `getHexString()`, HSL as CSS means it
(`setHSL(…, SRGBColorSpace)`). A grid's or terminal's background opacity is its panel's alone:
ink and cell fills stay opaque.

## Glyph tiers

**Glyph tiers** by on-screen size, nothing in between: exact Slug coverage (counted once,
premultiplied); under `glyph.greekPx` (default 8 px tall) a glyph is a bar through the
x-height where its ink would be (`core/glyphMaterial.js`, about as much light as the text);
under far-LOD's size, one box per file.

## Far-LOD

**Far-LOD** (`collections/GlyphFarLod.js`): a culled field whose tallest row measures
under `glyph.showGlyphsPx` (default 1 px, at its box's nearest view DEPTH — what the row
projects to, not its distance) stops drawing its glyphs — it leaves the view camera's
layer 0, so `visible` keeps its owners — and one instanced quad of its mean ink colour
(`InstancedField.farTint`; alpha = ink cover × `glyph.backdropGain`) stands in. All
backdrops are one draw. Gates: `tools/glyph-far-lod.test.mjs` (the decision + tint) and
`tools/far-lod-check.mjs` (pixels).

## Panel batching

**Panel batching** (`collections/PanelBatch.js`): the backdrop surfaces — flat panels (window
backgrounds, page faces, label plates), box fills and box outlines (book covers, directory
prisms) — stay real objects their owners pose, paint and register for picking, but draw as
instances: `enrollPanel(obj)` marks one, and a `PanelBatch` refreshes from `scene.onBeforeRender`
(this frame's matrices; never on pick passes) into one draw per kind × render state, taking each
object off the view camera's layer 0. Buckets cull per instance, sort translucent instances as
three sorts objects, and draw just before their render-order band (panels, then fills, then
outlines). It walks only the enrolled panels under its scene and shown (a list rebuilt when the
show generation or the enrolled set moves), and a still one costs it nothing: its cull outcome
stands while its world matrix and the camera hold, its instance matrix while it and the eye hold, and a flat panel's colours and flags
are re-read only when its material's `panelVersion` moves — every restyle goes through the
`createPanelMaterial` handle, which bumps it (a hand-written uniform goes unseen); box fills and
edges are read and compared every frame. Each bucket uploads only the span that changed.
Gates: `tools/panel-batch.test.mjs`, `tools/panel-batch-skip.test.mjs`,
`tools/panel-batch-shown.test.mjs`, `tools/panel-batch-check.mjs`.

## Glyph batching

**Glyph batching** (`collections/GlyphBatch.js`): labels (every FieldLabel — book tabs,
nameplates, dock titles) stay real InstancedFields their owners write and pose, but draw from
ONE arena field: `enrollGlyphField(field)` marks one; a `GlyphBatch` refreshes from
`scene.onBeforeRender`, copies each label's glyphs into a range (in three's far → near order;
recopied only when text, colour, membership or that order changes) with its own group-table
row, writes each row's pose from the label mesh's matrixWorld (camera-relative), and zeroes the
alpha of hidden or off-frustum labels. A still label costs it nothing: its verdict is cached until
its slots, count or group table move, and its pose and row math are skipped while its world
matrix, the camera, its group row and its shown state hold; only changed rows upload (per-row
ranges up to `rangeRows`, else the whole table; none at rest). A sheared pose or a glyph outside
group 0 draws itself; batched labels skip far-LOD. Gates: `tools/glyph-batch.test.mjs`,
`tools/glyph-batch-upload.test.mjs`, `tools/glyph-batch-check.mjs`.

## Scene transforms

**Scene transforms** (`collections/SceneTransforms.js`): world matrices are recomputed where
something moved, not across the whole tree every frame. A node joining the scene gets
`TrackedVector3` position/scale (its old vectors are frozen — a write through a reference held
from before throws) and hooked quaternion/rotation; a write that changes a value marks the node
and flags its ancestors, and the scene's `updateMatrixWorld` (taken over) enters only flagged
subtrees. At rest it visits the root and stops. Cameras, `matrixAutoUpdate = false` nodes (a
hand-written `.matrix`) and pivots are handed to three's forced update every walk, judged as they
join (the module header lists the changes the walk can't see on a node already in the scene).
The same marks answer "in this scene, and shown?": `Object3D.prototype.visible` is an accessor
(loaded with the module), and `rootOf(obj)` / `isShown(obj)` re-walk an object's ancestors only
when the show generation moves (a `visible` flip, a tracked node gaining or losing a child) —
PanelBatch, GlyphBatch and GlyphFarLod read them, and need a SceneTransforms on their scene.
An app installs these with the flat render root as one `SceneSystems` (`ctx.sceneSystems`: its
order, the renderer seam, its per-frame `update`, its reverse-order `dispose`) — the IDE and the
wall alike.
`scene.transforms` reports the last walk and checks every world matrix against a fresh
recompute; `scene.transforms who [ms]` names the moving nodes that started the recomputes over a
window (the "who never rests" probe — an ease must LAND on its target, never approach it forever:
`Carrel.update`'s member turns do). Gate: `tools/scene-transforms.test.mjs`.

## Atlas texture uploads

**Atlas texture uploads** (`core/TextureUploads.js`, `atlas._textureUploads`): the Slug curve /
glyph-map textures and the emoji grid never re-send what the GPU holds. A landing queues its
written texels as rectangles (a span is at most three: a row's tail, whole rows, a row's head —
three's own `updateRanges` path sends one row per call); a texture whose array grew is born
allocated but unfilled (`source.dataReady = false`) and its old rows are copied GPU-side
(`renderer.copyTextureToTexture`), then the old texture is disposed. `SceneSystems` flushes the
queue before every top-level render (never a nested one), so a landing is drawn in the next
frame. Gates: `tools/texture-uploads.test.mjs` (bytes per event, against a model of three's
WebGL path), `tools/atlas-growth.test.mjs`; `atlas-cold-perf` measures it in a browser.

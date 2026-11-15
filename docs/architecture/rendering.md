# Rendering

The glyph renderer in `@glyph3d/core`: draw, fonts (families, faces, clusters), cells (fills, styles, sprites), layout, picking, culling, LOD, batching, transforms, uploads.

## Single instanced draw call

**Single instanced draw call.** Text becomes a `Float32Array` of per-glyph instance
attributes (built single-pass, optionally in a Web Worker via `WorkerBridge`) and
renders as one `InstancedBufferGeometry`. A field's group table (per-group pose, colour, clip)
starts at one row — group 0, all most fields use — and `createGroup` doubles it on demand up to
`groupCap` (past it: loud, the dead group); the 1×1 placeholder textures are shared by every glyph
material. Gate: `tools/group-table.test.mjs`.

A slot is 32 bytes, eight float lanes (`core/InstancedSlotBuffer.js`): pen x y z, glyph slot,
colour (RGB888), group row, advance, height. The group lane holds the row in its low 16 bits and
the cell's STYLE BYTE above them (below); a slot with no style holds its bare row.

## Fonts: families, faces, clusters

**One chain.** Every font the renderer draws is a font of one `FontChain` (`shaping/FontChain.js`)
on one Slug atlas; a glyph is a SLOT, a dense integer for a (font, glyph id) pair. The package's
fonts are `fonts/families.js` (`fontChain()`, which the IDE, the wall, the headless bakes and the
tests all boot): the FAMILIES — Cousine (Apache 2.0, v1.21: regular, bold, italic and bold-italic,
a file each) and GitHub Next's Monaspace Neon and Monaspace Argon (SIL OFL 1.1, v1.400) — then
the fallbacks every family routes after its own font, MesloLGS NF Mono and DejaVu Sans. Licenses
sit beside the files.

**Format.** The Slug encoder takes quadratic outlines (TrueType `glyf`); a cubic (CFF) outline
throws in `slugData._parseSegments`. Monaspace's static release is CFF; its variable release is
`glyf`, one file per family (axes `wght` 200–800, `wdth` 100–125, `slnt` −11–0), shipped as
released. A font spec's `variations` picks the instance HarfBuzz shapes and draws
(`HarfBuzzShaper.init` / `.instance` → `hb_font_set_variations`, checked against the file's own
axes: a wrong tag or value throws) — `fonts/families.js` sets regular `wght 400`, bold
`wght 700`, italic `slnt −11`, bold-italic both. An instance shares its file's bytes and HarfBuzz
face on the main thread and in the encode worker (`fontSources()` names the font it is an
instance of). A variable font's overlapping strokes need the non-zero winding rule (Glyph tiers).

**Faces.** A font spec's `faces: { bold, italic, boldItalic }` are each one more font of the chain
(after every listed font, so a listed font's index is its place in the list), taking no part in
routing. A cell's face is two bits of its attributes (`core/cellAttrs.js` `cellFace`: bold 1,
italic 2, both 3); `FontChain.lookupFace(cp, face)` answers that face's glyph for a codepoint its
font routes, and the upright glyph for a fallback font's glyph, a sprite and an emoji (no face
is synthesized; a font with no bold-italic draws it in its italic, else its bold).
`MonospaceShapeCache.lookupFace` caches it per face.

**Families.** A listed font that names a `family` is routed only for that family, ahead of the
fallbacks; the family's cell (its advance × its ascender-to-descender em; with a spec's `lineGap`,
the font's line gap too, half above and half below), its line metrics and its sprites are that
font's. Family 0 — `DEFAULT_FONT_FAMILY`, the first listed font's — is the cell labels, code grids
and books are laid out on (`atlas.getCharSize()`, `atlas._shapeCache`). A field draws in another
family through `atlas.fontFamily(id)`: that family's shape cache (`FontChain.view(id)`), cell and
line metrics; `InstancedField` takes the cell (`charSize` / `setCharSize`) and the lines
(`setLineMetrics`). Families share the atlas, the slots and the fallbacks' glyphs, so text in two
families draws side by side and switching a field's family is a rewrite of its slots — what
`TerminalGrid.setFontFamily` does, live (docs/architecture/terminals.md "Cells"). The cache keys
(`slugCoreKey`, `slugGrowthKey`) are the chain's identity: every font it loads, by name,
variation instance, line-gap choice and family (`fontChainIdentity`).

**Clusters.** A cell holding a base and combining marks (`e` + U+0301, a Vietnamese stack) is one
number: a cluster id above every codepoint, interned once per distinct text
(`core/cellClusters.js`). `FontChain.lookupCluster(text, face)` draws it as the precomposed glyph
where the cluster composes to one codepoint a font covers (NFC); else HarfBuzz shapes it in the
base's font (in the cell's face) and the base plus its marks become one COMPOSITE slot, whose
outline the encode worker builds from its parts (`slugData.encodeComposite`; composites are not
persisted as growth). A mark the font's own anchors place stays where HarfBuzz put it; one it
left where the font drew it is placed by its ink — centred over the base's ink, a sixteenth of
an em clear of what is under it, marks stacking — which is HarfBuzz's fallback mark positioning
(the vendored build leaves it out) and is what makes Cousine's marks (drawn over the previous
letter) and Monaspace's (drawn inside their own cell) land alike. A mark the base's font lacks
comes from the font that has it; one no font has is left out and the base still draws. Variation
selectors and joiners are dropped (an emoji sequence draws its first emoji).

Gates: `tools/font-faces.test.mjs` (the chain, face routing, instances, families, clusters and
their ink, the reader), `tools/terminal-text-path.test.mjs` (a grid's faces and a live family
switch), `tools/wall-cells-check.mjs` (pixels: the bold face inks more, a cluster shows its base
and its mark, a live family switch). For the eye: `tools/font-faces-shots.mjs` photographs the
test pattern and `tools/font-sample.sh` in every family, with two side-by-side sheets.

## Cells: fills, styles, sprites

What a cell draws beyond its glyph — a terminal's cells, and a `CodeGrid`'s (selections, trails,
ANSI backgrounds): one path, in the one glyph shader (`core/glyphMaterial.js`).

**The background pass.** A cell's fill (its highlight texel's colour and opacity, else its
group's background) is drawn by a second material, the FILL material, from the field's own mesh:
the same geometry, slot buffer, group table and highlight texture, drawn once more BEFORE the ink
(`InstancedField._ensureFillPass`: the mesh's material is `[fill, ink]` over two geometry groups
that both span the quad; three draws them in that order, as one object). The fill pass draws each
filled cell's whole rectangle, flat, and collapses every other cell's quad in the vertex stage; the
ink pass collapses a cell with no ink and no line. So fills never cover a neighbour's ink — a wide
glyph (an emoji) keeps the half that lies over the next cell — and nothing is drawn twice. Its
cost: one more draw per field WHILE some cell has a fill (`field.fillsActive`; the material is
hidden otherwise, with no scene visibility change — a field that never fills a cell has no fill
material at all), no byte uploaded that wasn't already, and a flat fragment per filled pixel.
Both vertex stages end in the same expression under `invariant gl_Position`, so a cell's fill and
ink share a depth. Gates: `tools/glyph-fill-pass.test.mjs`, `tools/wall-cells-check.mjs` (pixels).

**Styles.** A cell's attributes are one flags word (`core/cellAttrs.js` — the layout a packed
wire cell maps onto: bold, dim, italic, blink, inverse, conceal, strike, overline, a 3-bit
underline style, underline-colour). What the shader draws of it is the 7-bit style byte
(`cellStyle`: dim, strike, overline, underline style, underline-has-its-own-colour) in the slot's
group lane; an underline's own colour is the field's decoration texel (`InstancedField.decorWords`,
one RGBA8 per slot, made when a cell first names one). The lines — underline (single, double,
curly, dotted, dashed), strikethrough, overline — are bands the fragment stage draws across the
WHOLE cell, so a run of cells draws one unbroken line, in the text's colour or the underline's
own; dim keeps `dimAlpha` of the ink's opacity. Where the lines sit and how thick they are comes
from the primary font (`FontChain.lineMetrics`: the post and OS/2 tables, `shaping/fontTables.js`
→ `setGlyphLineMetrics`); `lineThickness`, `underlineRaise`, `curlyAmplitude` and `dimAlpha` are
tuned live (`setGlyphLineStyle`: Settings ▸ Display & glyph LOD, `wall.config`); a field drawing
in another font family than the default has that family's line metrics
(`InstancedField.setLineMetrics`). A line is never thinner than a pixel; lines draw in the exact
tier only. Bold and italic are a glyph, not a style bit: the slot of the cell's FACE (`cellFace` →
`FontChain.lookupFace`; "Fonts" below). Bold changes no colour unless the reader's `boldIsBright`
is on.

**Sprites.** The glyphs a terminal draws itself come from no font: box drawing U+2500–257F,
block elements U+2580–259F, braille U+2800–28FF, the legacy-computing sextants, wedges and eighth
blocks (U+1FB00–1FB90, 1FB9A–1FB9B) and powerline U+E0B0–E0BF are OUTLINES GENERATED TO THE CELL
(`shaping/cellSprites.js`, after Ghostty's sprite font: lines centred, light the weight of the
family's font's ─, heavy its ━ or twice light, a double line two light lines a light gap apart,
rounded corners arcs, a shade a full cell at 25/50/75 % ink). They are one more glyph source of
the Slug atlas, as an emoji's bitmap is: `FontChain` routes those codepoints to a sprite slot
before any font — one per font family, since a sprite is drawn to its family's cell —
`LiveSlugAtlas` generates and lands their curves synchronously (a few
rectangles — never in flight, never persisted as growth; the core cache holds the core's, keyed
by `SPRITE_VERSION`), and the glyph shader draws them in glyph-map mode 3.

**Drawn to the cell: no seams.** A sprite's coverage, and a cell line's, is counted over the part
of each pixel that lies INSIDE the cell: the Slug window of a mode-3 glyph is clamped to the cell
(and its rays start inside it), a line's band likewise. A pixel belongs to exactly one cell (the
rasterizer's rule; under MSAA each sample does), so two cells whose shapes meet at their shared
edge both report full coverage there: █ joins █, ─ joins ─ and an underline runs on, at any
zoom, with no pixel snapping. (Overlapping shapes past the cell instead is not possible — curve
coordinates and the quad end at the cell — and would blend a translucent edge twice.) An edge
between ink and nothing that lies ON a cell boundary is therefore pixel-hard; edges inside the
cell are anti-aliased as any glyph's. Cell edges themselves are exact: `computeCellMetrics` snaps
the cell's width and height to 10 significant bits (`snapCellDimension`, under 0.1 %), so column
k's right edge and column k+1's left edge are the same float32, and so are rows' — neighbours
share their edge to the bit, and every glyph's advance is a whole number of cell widths
(`LayoutGenerator`). Gates: `tools/cell-sprites.test.mjs` (shapes, atlas, lattice),
`tools/cell-attrs.test.mjs`, `tools/wall-cells-check.mjs` (seams, runs, styles in pixels);
`tools/term-test-pattern.sh` prints one screenful of all of it for the eye
(`tools/term-test-shots.mjs` photographs it on the wall).

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
blends the canvas that way, a cell's fill is drawn there first (the background pass), and
an edge weighs the same over a fill as over the panel behind it (gamma-space blending, a
terminal's native look); a far backdrop's tint is the mean of its ink's sRGB for the same
reason. Where plain sRGB meets three, the crossing is three's own: into a `THREE.Color` or a
vertex-colour attribute by `setRGB(r, g, b, SRGBColorSpace)`, out to a glyph lane or a 2D
canvas by `getRGB(…, SRGBColorSpace)` / `getHexString()`, HSL as CSS means it
(`setHSL(…, SRGBColorSpace)`). A grid's or terminal's background opacity is its panel's alone:
ink and cell fills stay opaque.

## Glyph tiers

**Glyph tiers** by on-screen size, nothing in between: exact Slug coverage (counted once,
premultiplied, by the non-zero winding rule: a contour wound either way is ink, and overlapping
contours are ink once — a variable font overlaps its strokes, and Monaspace winds its accents
against its letters); under `glyph.greekPx` (default 8 px tall) a glyph is a bar through the
x-height where its ink would be (`core/glyphMaterial.js`, about as much light as the text) —
a cell sprite stays exact at every size (a block or a rule is its own bar, and a few curves), and
the cell's lines are not drawn; under far-LOD's size, one box per file.

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


## Open items

**Run shaping (ligatures, texture healing).** A terminal's cells are shaped one by one: a cell's
content → one slot (`MonospaceShapeCache`), so Monaspace's `calt` (texture healing: a narrow
letter beside a wide one trade room) and its `liga` / `ss01`–`ss10` coding ligatures never fire —
both are contextual substitutions over a RUN of cells. What it would take:
- **Runs.** In `TerminalGrid`, shape each row's maximal runs of same-face, same-family cells
  through HarfBuzz with the features on (`FontFamilyView.shape(text, features)`), keyed by the
  run's text in a per-family run cache (a prompt's rows repeat), and re-shape a row only where
  the diff's changed span touches a run (a substitution reaches a few cells either side, so the
  dirty span widens to the run's ends).
- **Glyphs per cell.** Texture healing keeps one glyph per cell (an alternate of the same
  advance, `m.alt`), so the per-cell slot write stays; a ligature is N cells drawn by one wide
  glyph — either the first cell's quad N cells wide and the rest blank (the emoji path's
  two-cell quad, generalized; the cursor and selection still address cells) or the font's own
  per-cell pieces where it has them.
- **Cost.** Shaping is a WASM call per changed run on the main thread, in the frame's pull: it
  has to stay inside the text path's budget (`tools/wall-text-perf.mjs`), which means the run
  cache must hit for steady output and a flood must fall back to per-cell lookups for the frame
  and heal on the next quiet one.
- **Choice.** Ligatures change what a cell shows (`!=` → `≠`-like), so they are a per-terminal
  setting, off by default, like Ghostty's `font-feature`; texture healing changes only spacing.
The fonts are shipped whole (their `calt` / `liga` tables and alternates included), so none of
this needs new font files.

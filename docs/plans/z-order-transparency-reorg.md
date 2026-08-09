# Z-order & transparency reorganization — investigation notes

Status: mechanism identified (user-confirmed live), reorganization NOT yet started.
This doc is the handoff for the dive. Last updated alongside commit `fa2dc31`
(Books settings section) — all dials referenced below already exist in the
settings panel.

## The symptom

Book/page content "cuts through" content in front of it: bleed-through, tearing,
cutouts, glyphs flashing in and out at glancing angles. Screenshots:
2026-08-09 09:48 (grids blanking / cutout), 10:53 (rear page content punching
through the front page).

## What is RULED OUT (do not reopen)

- **World-coordinate magnitude / float precision.** Identical scenes rendered at
  the origin and at y≈15000 are pixel-identical (probe: `/tmp/precision-ab.mjs`,
  likely gone — recreate if needed). The 15000-distance vantage is not the cause;
  globally scaling the scene down would change nothing. Recentering / near-far
  tightening remains decent hygiene but is not this fix.
- **Basic occlusion.** Opaque quads occlude; glyph walls depth-test; a grid
  background panel with depthWrite occludes text behind it. The depth buffer
  itself is healthy.
- **Far-texture mip bleed as the bleed-through cause.** That was real but fixed:
  `99360cc` clamps the far lod to `log2(FAR_SLAB)` (now the `glyph.farLodMax`
  dial). Not the bleed mechanism.

## CORRECTION (12:24 screenshot): depth fighting is back IN scope

The user's dial session + `Screenshot_20260809_122418.png` showed the code grid
background being overwritten in straight-edged diagonal/triangular bands by the
book page face behind it. That straight-edge signature is two near-coplanar
depth-writing quads trading the depth test along their planes' intersection
line — z-fighting in the true sense, layered on top of the blending problem.

The geometry (`panelSurface.js`, `CodeGrid.js`):

- grid background sits **0.1–0.5 units** behind its text
  (`CodeGrid.js:1182` `position.z = -0.1`, `:2130` `zMin - 0.5`),
- panel/page face sits **8 units** behind the fields' bbox
  (`PANEL_SURFACE_DEFAULTS.surfaceDepth = 8`, `panelSurface.js:155/179`).

Sub-10-unit layer gaps, viewed from a library vantage hundreds/thousands of
units out. Depth-buffer precision is nonlinear (clusters at the near plane), so
at that distance the gap falls under one depth step → per-pixel ties that flip
with camera float jitter → the straight-edged takeover bands AND the flashing.
Both depth-write, both translucent, so a lost pixel also blends wrong.

Why the earlier precision A/B missed it: it moved scene AND camera together,
holding camera-to-subject distance constant. The variable that matters is
**camera distance vs inter-layer gap vs near/far spread** — not world
coordinate magnitude. World origin is still ruled out; depth resolution at
viewing distance is NOT.

Fix candidates specific to this:
- **polygonOffset per layer band** (face 0 / grid background −1 / glyphs −2) —
  operates in depth-buffer units, so the front layer wins deterministically at
  ANY distance and gap. The classic decal-stacking fix; cheapest and most
  targeted. Materials live in `collections/panelMaterial.js`
  (`createPanelMaterial`), the CodeGrid/TerminalGrid background materials, and
  the GlyphField material.
- **tighten near/far** (raise near plane) — depth precision scales ~1/near;
  big hygiene win if the far vantage uses a tiny near.
- **enforce larger minimum layer gaps** — fragile alone (must scale with
  viewing distance), but pairs well with the above.

## IMPLEMENTED (this pass): layer bands, all live

- New `packages/glyph3d-core/src/core/layerBands.js`: three bands —
  `panelFace` (0), `gridBackground` (−1e-4), `glyph` (−2e-4) — each a
  **clip-space z bias** (`clip.z += bias·w` in the vertex stage — a constant
  NDC fraction, so the order holds at any camera distance). Each band owns ONE
  shared TSL uniform; `setLayerBandBias` writes it and every material in the
  band picks it up next frame. No registry, no pipeline involvement. Also
  holds the band DISTANCE `gridBackground` (default 0.5 — the grid wall's
  set-back behind its text, replacing the hard-coded −0.1 / zMin−0.5).
- **polygonOffset was tried first and is INERT in three r185's WebGPURenderer**:
  baked into the pipeline at creation, `WebGPUBackend.getRenderCacheKey` omits
  the offset values, `needsRenderUpdate` never sees the change → live edits
  no-op, and banded materials can inherit a key-twin's pipeline. Proven by the
  bite probe (coplanar wall + ±10 units: pixel-identical renders). Do NOT
  reintroduce polygonOffset for live control.
- Wired: `createPanelMaterial({ layerBand })` sets
  `material.vertexNode = withBandBias(modelViewProjection, layerBand)` → both
  panelSurface face materials + both grid background panels; GlyphField wraps
  its custom vertex: `withBandBias(vertexFn(), LAYER_BAND.GLYPH)` (all kinds,
  occluder included so the occluder set stays depth-consistent). The bias
  moves only clip z — x/y untouched, so picking (shares the transform) is
  unaffected.
- Live distance: `CodeGrid.refreshBackground(gap)` /
  `TerminalGrid.refreshBackground(gap)` shift the wall's z by the delta, no
  relayout.
- Settings: **Layer bands** section — `band.faceBias`, `band.gridBgBias`,
  `band.glyphBias` (±0.005 NDC, step 5e-5), `band.gridBgGap` — plus
  `books.surfaceDepth` (page face set-back, Books section; fans out to agent
  cfg `faceDepth` + library layout opt). Zero a band's bias to watch the
  fighting return (the anti-bias A/B).
- Verified: panel-material-check, glyph-pipeline 99, far-texels,
  layout-kernel PASS; bite probe (gridBgGap 0 → coplanar): glyphBias +0.005
  erases the text (wall wins), restore is pixel-identical (0.0000 diff) —
  live, deterministic, reversible.
- STILL OPEN: whether the defaults fully kill the bleed at the user's vantage
  (play with the dials); the semi-transparent blending stack below (opacity
  compounding) is a separate, still-live question.

## RESOLVED (lots_of_overlap.png audit): the overlap is TEXT ON TEXT, not layers

Reproduced the user's exact live settings (read via the relay `settings.get`)
and camera vantage headless, and audited every library sheet fit:

- **Fits are exact.** All 474 sheets: live content bounds == the box recorded
  at fit time (ratio 1.0 everywhere). `Book._fitSheet` is a contain-fit
  (`s = min(pageW/w, pageH/h, maxUpscale)`) — text cannot spill its page.
  The async-empty-box path (`fitSheet` re-read) is fine. Overlap ≠ layout bug.
- **Occlusion is mechanically sound at the user's settings** (faces opacity 1,
  walls opacity 1, near 4): opaque faces depth-write before the transparent
  text pass; at 19.7k out one depth step is ~6 units vs the 138-unit deck
  pitch — rear text cannot pass a front face.
- **What remains is the text mass itself.** All text is ONE transparent
  instanced mesh; text never occludes text by draw order, and the stipple LOD
  fade (`glyph.ditherSpan`) makes mid-distance text porous BY DESIGN — so
  overlapping text layers always interleave (this is the moiré heritage).
  At an oblique angle every sheet's text projects over its neighbors' page
  rects while being correctly in front of them in 3D → "lots of overlap" is
  the CORRECT render of that configuration.
- **The system's own answer (the far-texture consolidation tier) DOES NOT
  ENGAGE at this vantage**: a legacy-vs-crossfade A/B from the user's camera
  is near-identical — the book sheet grids render their full glyph mass in
  both modes. Why the far slabs don't arm/take over for book sheets at ~20k
  is the next thread to pull (slab arming criteria? crossfade footprint
  thresholds vs book page scale?).
- Meta-lesson (user's): fixes native to THIS system are consolidation
  (far tier) and porosity (ditherSpan), not textbook depth hacks — the
  polygonOffset detour proved that the hard way (inert, two layers deep).

## CORRECTION (user-verified): band biases default to ZERO

The clip-z bias shipped with defaults face 0 / wall −1e-4 / glyph −2e-4, on
the reasoning "microscopic tie-breakers, too small to cross a real gap." That
reasoning was WRONG at distance: the bias is a fixed NDC fraction, but the
geometric gaps shrink in NDC with distance — at ~20k out, the cross-stack gap
(front face → rear sheet's text, 138 units of pitch) is ~1e-6 NDC, SMALLER
than the glyph bias. Rear text outranked the front sheet's opaque face — the
bias defeated the occlusion the near-plane fix had just restored. The user
found that all-zeros + near 4 + gridBgGap 0.5 is the functioning config, and
it is now the default. The bias machinery stays as a live debugging PROBE
(force an ordering, watch a layer win/lose — verified biting by the coplanar
bite probe). What actually carries the ordering: geometry + a healthy near
plane. What carries the distant text mass question: the far tier (see above —
it doesn't engage for book sheets at ~20k; next thread).

## CONFIRMED (zoom_in_0/_2 experiment): near plane owns cross-stack fighting

The user's distance-gated A/B (same panel: occludes close-up, bleeds pulled
back) isolates the SECOND fighting domain: BETWEEN stacks (a front panel vs
the next sheet's glyphs, separated by the ~90-unit zPitch), where the band
offsets can't reach — bands order layers WITHIN one stack; cross-stack order
comes from geometry, and geometry loses when one depth-buffer step exceeds
the gap. Eye-space depth resolution ≈ z²/(near·2²⁴): with the old
`near: 0.1` (app/main.jsx), a 15k-unit library vantage resolves to ~134 units
per step — the 90-unit sheet pitch ties per-pixel, ties wobble with camera
float jitter, rear text passes the depth test → bleed + flashing. Close up
(~0.06 units/step) everything resolves, hence "opaque, great".

FIXED: `near: 1.0` in main.jsx + the live `camera.nearPlane` dial (Camera
section, default 1.0, min 0.01) — 10× precision (~13 units/step at 15k);
near 5 → ~2.7 units/step, the full sheet stack resolves. Verified live: born
at 1, dial drives it, no page errors. Watch for: close-up clipping if a
camera grind puts content < 1 unit out (dial it back down if that bites);
nothing else in the codebase reads `camera.near`.

## The (still-live) theory: compounding semi-transparent layers

The scene stacks several entity types that are ALL in the transparent pass, each
partly see-through, sorted per-object by renderOrder then depth:

| layer | renderOrder | default opacity | depthWrite | notes |
|---|---|---|---|---|
| dir covers ("boxes") | BACKDROP_BASE+depth (≤ −10) | 0.06 fill / 0.22 edge | **false** | `Book.js` COVER_DEFAULTS; toggled by `books.cover` |
| carrel chrome | −3 | additive glow | — | below panel surfaces |
| panel surface faces | −2 | 0.9 (`books.surfaceOpacity`) | true | a hair of translucency by design |
| grid backgrounds | −1 | ~0.92 | true | one band behind its glyphs |
| glyphs | 0 | 1 | true | one merged mesh per field → sorts as ONE object |
| grid chrome | 6 | — | depth-tested | window controls |

Why this produces cutouts:

- The transparent pass does painter's-algorithm blending. Any layer with
  opacity < 1 never fully occludes what is behind it — the rear layer's
  contribution blends through. Stack page faces (0.9) over grid backgrounds
  (0.92) over glyphs and the composite is order-sensitive; when the depth sort
  flips between two nearly-coplanar semi-transparent layers (camera float
  jitter), the blend result visibly flips → flashing / tearing.
- Glyphs merge into one mega-mesh per field, so they sort as a single object
  against per-panel objects. A rear panel's face can sort in FRONT of the
  glyph mesh while geometrically behind most of its glyphs → punch-through.
- Covers deliberately don't depth-write, so they never occlude; their
  contribution is pure blend.

The user confirmed the mechanism live by driving the Books dials to the
extremes: forcing layer opacities to 0 or 1 makes the artifacts collapse.

## Candidate directions (user picks before the dive)

- **(a) Opaque-by-default page faces.** Page faces already depth-write; at
  opacity 1 they become true occluders and the whole stack behind them
  disappears from the blend. Cheapest test — runnable TODAY with
  `books.surfaceOpacity = 1`. If the artifacts vanish and the look is
  acceptable, this is most of the fix. Trade-off: loses the deliberate "hair of
  translucency" that lets overlapping faces read (`panelSurface.js:35`).
- **(b) Explicit z-band layout.** Give pages / glyphs / covers / backgrounds
  deterministic sub-layer offsets with documented minimum separation, so
  near-coplanar depth-sort flips can't happen. More invasive: touches layout,
  but makes ordering geometric instead of sort-dependent.
- **(c) renderOrder consolidation.** Fewer, well-defined bands with a single
  owner document; mostly hygiene, doesn't fix blending by itself.
- **(d) Depth prepass for text mass.** Render glyph/panel geometry to depth
  first, then blend colors against it. Costs one extra pass; the user already
  flagged spare GPU budget ("we do so little GPU work"). The strongest general
  fix if (a) isn't enough.

## Testing dials already in the panel

- Books: `books.cover` (directory boxes on/off), `books.coverOpacity`,
  `books.coverEdgeOpacity`, `books.coverPad`, `books.coverZPad`,
  `books.surface`, `books.surfaceColor`, `books.surfaceOpacity`,
  `book.pageW/pageH/gutter/maxUpscale/zPitch/pagerLerp`.
- Glyph/far: `glyph.farMode` (crossfade / far-only / legacy — doubles as a
  layer-visualization tri-state), `glyph.farLodMax`, `glyph.ditherSpan`,
  `glyph.lodAxisBias`, `far.inkPerCurve/inkMax/inkBitmap`.

## Known render-path traps (cost real time, don't rediscover)

- `ViewerCameraController` stomps manual `lookAt` within a frame — drive
  `ctl.pitch/yaw` + `cam.position` in probes, or screenshot immediately.
- `/@fs` imports in page probes load a SECOND module instance; never mutate app
  state through them. Use the command bus (`app.cmd('settings.set …')`).
- `page.evaluate(str, arg)` ignores `arg` — self-invoke with JSON-interpolated
  values.
- A Vite 500 on any module quietly breaks boot — check `failedResources` before
  trusting a probe result.
- Headless relay WS bridge dial fails (undiagnosed); load repos via
  `repo.load tikimcfee/glyph3d-js`, not `file.open`.

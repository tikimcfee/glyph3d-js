# Round 2: rendering reviews encoding, plumbing (inverse)

## Reaffirm or Retract

**Reaffirm — transparent: true is wrong, keep transparent: false.**
Both plumbing and encoding remain silent on this in Round 1 except encoding's gap note that rendering
"correctly identifies" it and then advocates transparent: true as a correctness requirement. Both
plumbing and I agree in Round 1 that transparent: false + explicit discard is the right path. Encoding
still holds that Slug "needs" transparent: true for real alpha. I retract the characterization of
transparent: true as a requirement. The AA case is better handled by alpha-to-coverage (MSAA) or
screen-door dithering, both compatible with transparent: false. Coverage-based blending requires
back-to-front sort which is wrong for overlapping CodeGrids with depth write enabled.

**Reaffirm — 1 texel per glyph in glyphMapTexture (RGBA16UI).**
Encoding holds its 4-texel RGBA32F in phase0 but both plumbing and I concluded 1 texel (or at most 2)
is correct. Encoding's Round 1 position now endorses 1-texel RGBA16UI as workable for monospace.
I still hold 1 texel. The bbox data is not required in the shader if curves are normalized to [0,1]
within the glyph's own bbox — and encoding's own normalization step (phase0-encoding.md section 2)
does exactly that. The PlaneGeometry UV [0,1] maps to the glyph's normalized curve space directly.
Monospace assumption acknowledged and accepted for Cousine.

**Reaffirm — curveTexture as RGBA16UI over RGBA16F.**
Encoding advocates RGBA16F and calls it cleaner (10-bit mantissa, no unpack ALU). Plumbing defers
to encoding on format. I hold RGBA16UI. The deciding factor: RGBA16F sampled via texelFetch returns
float, which requires sampler2D. The glyphMapTexture and bandTexture both use usampler2D. Three
different sampler types in one shader is error-prone. Uniformity (all usampler2D, all texelFetch) is
architecturally safer. The unpack cost is two GLSL instructions per texelFetch — negligible versus
the winding loop.

**Reaffirm — degenerate quadratic division-by-zero is a guaranteed crash.**
All three agents agree. The linear fallback is required. This is not a tension anymore: it is a
required fix before any shader code ships. Every L segment and every closing Z produces A=0.

**Retract — early-exit axis misread.**
My Round 1 called out that phase0-rendering.md's early-exit tests maxY (wrong axis). Reading
phase0-encoding.md section 3 more carefully: hBands use sortKey: xMax (sort within horizontal
bands by xMax for +X ray); vBands use sortKey: yMax. The rendering shader tests maxY — this is
wrong for hBands but would be correct for vBands. The shader only implements hBand traversal in
the sketch. The early-exit must test the band's ray axis: for +X horizontal ray casting through
hBands, the correct early-exit key is xMax (can stop when curve.xMin > p.x). Plumbing also caught
this. My original call was correct; I was confused in re-reading. Maintained.

## Evolved Understanding

**Band texture two-region indexing is now unambiguous.**
After reading both phase0 documents and all Round 1 outputs, the layout is clear. The band texture
has a header region (one texel per band, stores entryStart and entryCount as uint16 pairs) and an
entry region (one uint16 per curve-in-band, storing the curve index into curveTexture). The fragment
shader needs the hBandTableStart (from glyphMapTexture) to locate the first band header for this
glyph. Then for band b: `texelFetch(bandTexture, hBandTableStart + b)` gives (entryStart,
entryCount). Then loop j: `texelFetch(bandTexture, entryStart + j)` gives curveIndex. Then
`texelFetch(curveTexture, curveStart + curveIndex * 2)` and `curveStart + curveIndex * 2 + 1`
gives the two control-point texels. This is a 3-hop chain, not 2. The chain is only 2 levels if
curveIndex in the entry region is already an absolute texel address — but encoding stores it as an
index into the glyph's local curve pool, making the final hop require adding vCurveStart. The
indexing contract from Round 1 Recommendation 7 stands and is now well-specified.

**The glyphOutline double-call in buildShapedBuffers is structurally worse than I noted.**
Phase0-plumbing.md lines 327-330: the pre-count pass calls `shaper.glyphOutline(g.g)` for every
shaped glyph, then the main loop calls it again. But the pre-count pass's `visible` array is never
used in the main loop — the main loop re-calls `shaper.glyphOutline` and re-filters (line 353).
The pre-count pass exists only to compute `totalGlyphs` for allocation. My Round 1 Recommendation
10 said to allocate worst-case and slice. That is still correct. A simpler fix: replace the
pre-count pass entirely with `totalGlyphs = allShapedGlyphs.length` (over-estimate), write into
pre-allocated arrays, then truncate to `idx`. This eliminates all double-calls and the pre-count
loop with zero additional cost for Cousine (space glyphs are ~10% of characters).

**The `shaper.font.glyphExtents()` leak in phase0-plumbing.md line 389 is still unresolved.**
Encoding notes this in its Round 1 errors (item 5): `shaper.font` is a private field. Plumbing's
data flow sketch calls `shaper.font.glyphExtents(glyphId)` directly. The `HarfBuzzShaper` class
as written has no `glyphExtents()` method. This is a missing API that must be added. Encoding and
plumbing both agree; it was not yet added in phase0-plumbing.md.

**Encoding's curveTexture width of 256 is too narrow.**
Phase0-encoding.md section 4 uses width 256. Phase0-rendering.md uses width 1024. Encoding's
memory calculation: 4000 curves x 2 texels = 8000 texels / 256 = 32 rows. At width 1024: 8 rows.
Encoding agent's Round 1 concedes on width 1024 (encoding Round 1 recommendation 10: standardize
on 1024). No action was taken in the source document. This is a resolved tension that still needs
to propagate into phase0-encoding.md as a correction.

## Convergence

All three agents now agree on:
- RGBA16UI for bandTexture (was never disputed)
- 1-texel RGBA16UI for glyphMapTexture (encoding conceded in Round 1)
- MAX_BANDS = 16 (all three agree)
- degenerate quadratic linear fallback is required (all three agree)
- `glyphExtents()` must be added to HarfBuzzShaper (all three agree)
- ESM wrapper must patch hb.js and hbjs.js before import (all three agree)
- `shaper.font` must not be exposed directly (all three agree)
- curveTexture width 1024 (encoding conceded in Round 1)

## Remaining Tensions

**RT1 — curveTexture format: RGBA16F (encoding) vs RGBA16UI (rendering/plumbing).**
Encoding holds RGBA16F. Plumbing and rendering hold RGBA16UI. The practical difference:
RGBA16F requires sampler2D for the curve texture while all other Slug textures use usampler2D.
This is the only remaining format dispute. Decision needed before any shader or packing code
is written. I hold RGBA16UI on grounds of sampler-type uniformity and removal of the
DataView.setFloat16 Baseline 2025 dependency.

**RT2 — transparent: true vs alphaTest + discard (coverage AA path).**
Encoding still implies transparent: true is needed for real sub-pixel AA. I maintain that
transparent: true changes depth-sort semantics in ways incompatible with the current
multi-grid rendering model. The resolution is to prototype with alphaTest (hard binary),
ship that in Phase 3, and revisit AA mode in Phase 4 with alpha-to-coverage or OIT.
This is a phasing disagreement, not a correctness disagreement.

**RT3 — glyphMapTexture bbox storage.**
Encoding's 4-texel layout exists partly because bbox is needed to map PlaneGeometry UV
back to font-unit space after normalization. Rendering's 1-texel layout omits bbox, relying
on [0,1] normalization being sufficient. If we ever need to render proportional fonts where
advance != visual width, the 1-texel layout breaks. This is correctly scoped as a Cousine-only
assumption for Phase 3. The tension is a future-compatibility question, not a Phase 3 blocker.

## Synthesis

The three agents have converged on the core texture architecture. The remaining work is:

1. Lock curveTexture format as RGBA16UI (or RGBA16F) in a single `SLUG_LIMITS` constants object
   shared between SlugEncoder and the GLSL shader source. This is the one document that prevents
   the Round 1 format divergence from recurring.

2. Fix the winding shader: add linear branch for A=0, change early-exit key from maxY to xMax
   for hBand traversal, fix texture() to texelFetch() for usampler2D.

3. Add glyphExtents() to HarfBuzzShaper. This is a one-line delegation to
   `this._font.glyphExtents(glyphId)` exposed through the public API.

4. Replace buildShapedBuffers pre-count pass with worst-case allocation + idx-based truncation.
   Eliminates double glyphOutline calls and simplifies the function by ~15 lines.

5. Keep transparent: false. Ship Phase 3 with `if (coverage < 0.01) discard;` in the fragment
   shader. No depth-sort regression. Revisit AA in Phase 4.

The band texture two-region indexing contract (hBandTableStart + b for header, entryStart + j for
curve index, curveStart + curveIndex*2 for control points) is now fully specified and consistent
across all three documents. It should move into SLUG_LIMITS or a dedicated design note before
implementation.

## Dissent

**Encoding's RGBA16F preference is not clearly wrong, but the cost of sampler-type heterogeneity
is underweighted.** A shader with sampler2D for curveTexture and usampler2D for bandTexture and
glyphMapTexture will produce hard-to-diagnose bugs when a developer passes the wrong texture to
the wrong uniform. GLSL gives no type error at link time for sampler mismatches in some drivers.
RGBA16UI for all three textures is worth the two-instruction unpack per texelFetch.

**The 2-level vs 3-level indirection debate in encoding phase0 section 6 omits the actual hop
count.** Encoding describes it as "2-level" (glyphMap -> bandTable -> curve) but the full chain
is: (1) glyphMapTexture texelFetch, (2) bandTexture header texelFetch, (3) bandTexture entry
texelFetch, (4) curveTexture texelFetch x2. That is 5 texelFetch calls per curve, not 2 "levels."
For a pixel with 3 curves in its band: 2 + 3*3 = 11 texelFetch calls. On tiled GPU architectures
this is cache-friendly only if the texture fits in L1 (it does at 113KB). The indirection count
is acceptable but should be named accurately in documentation to set correct performance
expectations.

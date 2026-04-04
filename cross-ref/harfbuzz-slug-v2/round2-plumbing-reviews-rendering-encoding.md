# Round 2: plumbing reviews rendering, encoding (inverse)

## Reaffirm or Retract

### 1. curveTexture format: RGBA16UI (my Round 1 position) — RETRACT, adopt RGBA16F

In Round 1, I sided with rendering's RGBA16UI and called RGBA16F over-engineered. After reading encoding's Round 1 rebuttal, I retract. Encoding is right: RGBA16F is the cleaner design. The shader reads floats directly from `texelFetch` on a `sampler2D` — no `unpackCoord()` ALU. WebGL 2 guarantees `RGBA16F` sampling on all conformant implementations (it is a required texture format for sampling; the extension is only needed for rendering *to* float16 targets, which we never do). The `DataView.setFloat16()` concern is real but marginal — Baseline 2025 covers all targets we care about, and a 6-line polyfill is trivial insurance. RGBA16UI's `float(bits) / 65535.0` is more ALU per texel fetch inside the hottest loop for no precision benefit. I was wrong to dismiss the encoding agent's format.

### 2. glyphMapTexture: 2 texels per glyph (my Round 1 position) — RETRACT, accept 1 texel

In Round 1, I proposed a compromise of 2 texels per glyph (RGBA16UI) to carry bbox data for UV remapping. Both encoding (Round 1) and rendering (Round 1) converged on the same argument against this: if SlugEncoder normalizes curves to [0,1] within the bbox before packing, then `vGlyphUV = uv` maps directly to glyph-normalized space and the shader never needs bbox at runtime. The advance-width quad and the visual bbox may differ for italic overhangs, but Cousine is monospace upright — advance matches bbox width. Encoding's Round 1 review explicitly identifies this as a monospace assumption and recommends a build-time assertion (`if (bbox.xMax > advance) warn`). That is sufficient. One texel per glyph (RGBA16UI) wins. I should not have inserted a compromise format that neither other agent asked for.

### 3. MAX_BANDS: 16 — REAFFIRM

All three agents now agree: 16. Encoding derived it from `ceil(sqrt(curveCount))` clamped to [2,16]. Rendering's Round 1 review accepted it. My Round 1 recommendation stands. The shader `#define MAX_BANDS` and the encoder cap must both be 16.

### 4. ESM patching of vendored files — REAFFIRM (strengthened)

Encoding's Round 1 elevated this from "verify at integration time" (my Phase 0 understatement) to "blocking requirement." Rendering's Round 1 did not address it. I reaffirm: `hb.js` and `hbjs.js` must have `export default` appended at vendoring time, not deferred. My Phase 0 was too soft on this — encoding's Round 1 correction is right.

### 5. `glyphExtents()` on HarfBuzzShaper — REAFFIRM

Encoding's Round 1 found the same bug (my Phase 0 references `shaper.font.glyphExtents()` which leaks the private `_font`). All three agents agree: add `glyphExtents(glyphId)` to the public API.

### 6. `buildShapedBuffers` output field `codepoints` — RETRACT, rename now

In Round 1, I recommended keeping the field name `codepoints` during transition to avoid breaking `applyPrebuiltBuffers`. Rendering's Round 1 correctly pointed out that the attribute rename from `instanceCodepoint` to `instanceGlyphId` is a deliberate semantic change. Maintaining the old field name while the data semantics have changed (glyph IDs, not codepoints) creates a documented lie in the code. Better: rename the builder output to `glyphIds` and update `applyPrebuiltBuffers` in the same commit. The rename is mechanical (one field name in the builder, one destructuring site in `applyPrebuiltBuffers`). No transition period needed.

### 7. `transparent: false` + discard — REAFFIRM (strengthened)

Rendering's Round 1 review proposed `transparent: true` for Slug coverage alpha. Encoding's Round 1 counter-proposed keeping `transparent: false` and using an explicit `if (coverage < 0.01) discard;` in the fragment shader. I agree with encoding here and reaffirm my Round 1 position. Verified at `GlyphRenderer.js` line 260-263: the current material uses `transparent: false`, `alphaTest: 0.01`, `depthWrite: true`. Three.js with `transparent: true` sorts objects back-to-front per frame, breaking the overlapping-grid model where CodeGrids use depth-write + early-Z. The rendering agent's own Phase 0 (section 5) states "highlight system is zero changes" and "group system is zero changes" — but `transparent: true` would change the draw order for all of them. Keep opaque, use explicit discard, defer AA to a future pass (alpha-to-coverage with MSAA, or screen-door).

## Evolved Understanding

### The format table is the contract

After all three Round 1 reviews, the dominant insight is not about any single format choice but about the absence of a single authoritative format specification. My Round 1 key insight flagged this. Encoding's Round 1 key insight independently arrived at the same conclusion ("the texture format contract between SlugEncoder and the shader must be specified in exactly one place"). Rendering's Round 1 key insight framed it as "the glyphMapTexture contract is the exact boundary where SlugEncoder output becomes GlyphRenderer input."

All three agents, from different angles, identified the same structural problem: no shared source of truth for texture layouts. The implementation plan must begin with a `SLUG_FORMATS` constant object (in `src/core/constants.js` alongside `SLUG_LIMITS`) that both SlugEncoder and the shader reference. This is more important than any individual format decision.

### The degenerate quadratic bug is everyone's problem

In Round 1, I flagged the `windingContrib` division-by-zero (rendering's Phase 0, line 222: `float t = (B - sqrtDisc) / A` where A=0 for line segments). Encoding's Round 1 independently flagged it with identical analysis. Rendering's Round 1 acknowledged it ("guaranteed runtime bug, not an edge case"). Every `L` segment and every closing `Z` from `glyphToJson` produces a degenerate quadratic where `A = a.y - 2*b.y + c.y` is exactly zero (because `b = midpoint(a,c)` makes `2*b.y = a.y + c.y`). The fix is small but mandatory:

```glsl
if (abs(A) < 1e-7) {
    // Degenerate quadratic = line segment. Solve linear: -2Bt + C = 0 → t = C / (2B)
    if (abs(B) < 1e-7) return 0;  // horizontal line — no crossing
    float t = C / (2.0 * B);
    if (t < 0.0 || t > 1.0) return 0;
    float x = (1.0-t)*(1.0-t)*a.x + 2.0*t*(1.0-t)*b.x + t*t*c.x;
    if (x < 0.0) return 0;
    float dy = 2.0*((b.y - a.y)*(1.0-t) + (c.y - b.y)*t);
    return (dy > 0.0) ? 1 : -1;
}
```

### Sub-pixel AA is Phase 4, not Phase 3

Rendering's Round 1 flagged that `coverage = clamp(abs(float(winding)), 0.0, 1.0)` gives binary 0/1 (winding is an integer). This is correct — there is no sub-pixel antialiasing in the Phase 0 sketch. The Slug paper's AA uses distance-to-nearest-curve with `fwidth()` for screen-space derivatives. This is nontrivial to implement correctly and can be deferred. Phase 3 ships with hard-edge rendering (visually equivalent to the current `alphaTest: 0.01` atlas path). Phase 4 adds distance-based AA. Encoding and rendering both identified this but did not assign it to a phase.

## Convergence

All three agents now agree on:

1. **One texel per glyph** in glyphMapTexture (RGBA16UI). Encoding retracted 4-texel RGBA32F. My compromise of 2 texels is also retracted.
2. **Two texels per curve** in curveTexture. Rendering's Phase 0 section 9 claimed one texel per curve was possible (RGBA16UI packing `x0,y0,x1,y1`), but all three reviews noted a quadratic bezier has 6 coordinates — cannot fit in 4 channels. Two texels confirmed.
3. **MAX_BANDS = 16**. Encoding's cap, adopted by all.
4. **`windingContrib` linear branch is mandatory**, not optional. Every L and Z segment hits this path.
5. **`glyphExtents()` belongs on `HarfBuzzShaper`**, not accessed via `shaper._font`.
6. **ESM patching is a vendoring-time requirement**, not a "verify later" task.
7. **Space glyphs work correctly by construction** — 0 curves, 0 winding, discard. But should be explicitly tested.
8. **SlugEncoder runs on main thread only** — produces shared textures, no worker involvement.
9. **Curve texture uses `texelFetch`** (integer coordinate access), not `texture()` (filtered access). This is required for integer-format textures and correct for float-format textures alike.

## Remaining Tensions

### 1. curveTexture format: RGBA16F vs RGBA16UI (narrowed but not fully closed)

I retracted my RGBA16UI position above. Encoding advocates RGBA16F (direct float reads, no unpack ALU). Rendering advocates RGBA16UI (no float16 API dependency, simpler packing). The technical difference is marginal — both provide sufficient precision for [0,1] normalized coordinates. The deciding factor is the packing code: RGBA16F requires `DataView.setFloat16()` (Baseline 2025 but needs a polyfill check), while RGBA16UI uses plain `Uint16Array` writes with `Math.round(value * 65535)`. For a project with no build step and no polyfill infrastructure, RGBA16UI's zero-dependency packing is pragmatically safer. But RGBA16F's zero-ALU-cost unpacking in the shader hot loop is technically superior.

**My position**: RGBA16F, but add a 6-line `setFloat16` polyfill in `SlugEncoder` guarded by `typeof DataView.prototype.setFloat16 !== 'function'`. This eliminates the browser-compat concern while keeping the shader clean.

### 2. Early-exit sort axis in fragment shader

My Round 1 identified the mismatch: encoding sorts hBand curves by `xMax` (correct for +X ray), rendering's shader tests `maxY` (wrong axis). Encoding's Round 1 did not address this directly. Rendering's Round 1 did not address it. This is still unresolved.

The correct early-exit test for horizontal bands with a +X ray: curves within an hBand should be sorted ascending by `minX`. The shader breaks when `curve.minX > p.x` because all remaining curves are further right and cannot intersect the ray. The encoding doc sorts by `xMax` (descending would be wrong; ascending is debatable — `minX` ascending is the right key for early exit from the left). This needs explicit alignment between encoder sort key and shader break condition.

### 3. Band texture two-region indexing semantics

Rendering's Round 1 (E2) flagged that the band texture contains two regions (band table + entry region) and the fragment shader's indexing (`vCurveStart + bandCurveStart + i`) conflates absolute and relative offsets. Encoding's Phase 0 specifies `(entryStart, entryCount)` in band headers, where `entryStart` is an absolute offset into the entry region. If `bandCurveStart` is already an absolute entry offset, then `vCurveStart` (glyph-local curve pool offset) is redundant — adding it double-counts. The shader should use `bandCurveStart + i` as the entry index, then read the curve index from that entry, then use that curve index to fetch from curveTexture. The `vCurveStart` from glyphMapTexture may not be needed in the fragment shader at all if band entries store absolute curve indices. This indirection chain needs one canonical diagram.

## Synthesis

The unified format contract, to be codified in `src/core/constants.js` as `SLUG_FORMATS`:

| Texture | Internal Format | Texels/Item | Sampler | Packing |
|---------|----------------|-------------|---------|---------|
| curveTexture | RGBA16F | 2 per curve | `sampler2D` | `[P0.x, P0.y, P1.x, P1.y]`, `[P2.x, P2.y, _, _]` — all [0,1] normalized |
| bandTexture | RGBA16UI | 1 per band header, 1 per entry | `usampler2D` | Header: `(entryStart, entryCount, _, _)`. Entry: `(curveIndex, _, _, _)` |
| glyphMapTexture | RGBA16UI | 1 per glyph | `usampler2D` | `(curveStart, curveCount, bandTableStart, bandCount)` |

Implementation sequence:

1. Write `SLUG_FORMATS` and `SLUG_LIMITS` in `src/core/constants.js` — the single source of truth.
2. Patch vendored `hb.js` and `hbjs.js` with `export default` at vendoring time.
3. Add `glyphExtents(glyphId)` to `HarfBuzzShaper`.
4. Implement `SlugEncoder` against `SLUG_FORMATS`, with assertions for MAX_BANDS and monospace bbox.
5. Implement fragment shader with the linear branch in `windingContrib`, correct early-exit axis, and explicit `discard` (no `transparent: true`).
6. Rename `instanceCodepoint` to `instanceGlyphId` and builder output `codepoints` to `glyphIds` in one commit.
7. Rewrite `PICKING_VERTEX_GLYPH` and `PICKING_FRAGMENT_GLYPH` to use Slug textures instead of atlas uniforms (verified at `PickingSystem.js` lines 73-116, 267-272 — all four atlas references must be replaced).
8. Defer sub-pixel AA to Phase 4. Phase 3 ships with binary coverage + explicit discard.

## Dissent

### 1. I still believe fontBuffer should use Transferable, not structured clone

Rendering's Round 1 (P1) recommended structured clone for fontBuffer at ~100KB, calling Transferable "complexity for no gain." I disagree. The `fontBuffer.slice(0)` pattern is one line per worker. Structured clone of a 100KB ArrayBuffer is also one conceptual step. But the Transferable pattern establishes the correct precedent: when we eventually support larger fonts (CJK fonts are 5-20MB), structured clone will copy megabytes per worker. Starting with Transferable means the code path does not need to change when font sizes grow. The comment about "first transfer takes the original" is misleading (I accept that criticism), but the fix is to correct the comment, not to change the transfer mechanism.

### 2. The pre-count pass in `buildShapedBuffers` should stay

Rendering's Round 1 (recommendation 10) proposed eliminating the pre-count pass by allocating worst-case and slicing. For most text, "all glyphs visible" is close to true, so the waste is small. But the pre-count pass serves a second purpose: it populates the `visibleGlyphSet` cache that prevents double `glyphOutline()` calls. Allocate-and-slice does not give you that cache. The right fix is: keep the pre-count pass, but replace per-glyph `glyphOutline()` calls with a `Map<glyphId, boolean>` lookup (populated lazily). The two-pass structure is the correct architecture; the bug was the uncached FFI call, not the two passes.

### 3. `bandTexture` should use RGBA16UI, not RG16UI

Rendering's Phase 0 section 9 specifies `bandTexture` as `RG16UI`. Encoding specifies `RGBA16UI`. I side with encoding: use RGBA16UI for all integer textures. The unused BA channels cost 4 bytes per texel but avoid a third texture format in the codebase. Three formats (RGBA16F, RGBA16UI, RG16UI) are more complexity than two (RGBA16F, RGBA16UI). The wasted bytes are negligible at the band texture's small size (~24KB). Uniformity reduces bugs.

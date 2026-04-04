# Round 1: rendering reviews plumbing, encoding

## Errors Found

### Plumbing

**P1 — fontBuffer transfer pattern is wrong (phase0-plumbing.md, WorkerBridge changes section)**
The proposed `initFont` sends `fontBuffer.slice(0)` as a Transferable for each worker. The comment says "The first transfer takes the original; subsequent workers need copies." This is self-contradicting: the code sends `fontBuffer.slice(0)` — a copy — for every worker, then transfers that copy (zero-copy). The original buffer on the main thread is never transferred (never consumed). This is actually correct behavior, but the comment misrepresents it. The real issue: sending as a structured clone (no Transferable) is simpler and equally fast at ~100KB. Transferring copies adds complexity for no gain and the comment will mislead implementers.

**P2 — `hExtents()` returns signed font units; descender is negative (phase0-plumbing.md, buildShapedBuffers sketch, line 316)**
The `lineHeight` formula is `(ascender - descender + lineGap) / upem * fontSize * scale`. Verified at `node_modules/harfbuzzjs/hbjs.js` line 521: `descender` comes from `hb_font_get_h_extents` which returns a signed value — descender is negative for standard fonts. So `ascender - descender` double-counts the sign (subtracting a negative = adding). The formula works arithmetically, but the intent should be stated as `ascender + abs(descender) + lineGap` to avoid confusion. In practice Cousine has descender ≈ -512, upem=2048, ascender≈1638, giving lineHeight = (1638 - (-512)) / 2048 ≈ 1.05em, which is correct. The formula is accidentally right but the mental model expressed is wrong.

**P3 — buildShapedBuffers calls `glyphOutline()` twice per visible glyph (phase0-plumbing.md, lines 329-334 and 351-355)**
The pre-count pass calls `shaper.glyphOutline(g.g)` for every shaped glyph to classify visible vs. space. The main loop calls it again for each visible glyph. For 80 chars/line × 100 lines = 8000 calls, doubled to 16000 per text item. Since WASM FFI is not free, this needs a cache. The doc acknowledges the problem at the bottom (`Set<glyphId>`) but the sketch code above doesn't implement it. A two-pass design without the cache is not usable as written.

**P4 — `sizes[idx * 2]` stores advance, not glyph width (phase0-plumbing.md, line 361)**
The current `instanceSize` semantic (verified at `GlyphRenderer.js` line 333: `vec3 scaled = position * vec3(instanceSize, 1.0)`) means `instanceSize.x` scales the PlaneGeometry quad width. Setting it to the HarfBuzz advance for the glyph cell is correct for cursor advancement, but the actual rendered glyph shape inside that cell may be narrower (bearings). The sketch conflates advance width with cell render width. For monospace (Cousine) this is fine. The comment should warn this is a monospace assumption; proportional rendering would need glyph width from `glyphExtents`, not just advance.

**P5 — `import.meta.url` in WorkerBridge is unreliable for WASM URL construction in workers**
The proposed `new URL('../shaping/vendor/hb.wasm', import.meta.url).href` in WorkerBridge works on the main thread. Workers in glyph3d-js are instantiated from a URL string at `GlyphWorker.js`. `import.meta.url` inside `WorkerBridge.js` resolves relative to `src/workers/WorkerBridge.js`, so the computed path would be `src/shaping/vendor/hb.wasm`. For the embedded binary this resolves correctly from the server root. For `--local` dev serving it also works. This is fine but should be noted as a path contract, not taken for granted.

### Encoding

**E1 — glyphMapTexture layout: 4 texels per glyph (RGBA32F) vs rendering agent's 1 texel per glyph (RGBA16UI)**
phase0-encoding.md section 6 specifies 4 texels per glyph in an RGBA32F texture with the glyph index addressing as `glyphId*4` through `glyphId*4+3`. My phase0-rendering.md section 9 specifies 1 texel per glyph in an RGBA16UI texture with `glyphId` as the direct texel index. These are incompatible. See Tensions section below.

**E2 — Band texture uses `RGBA16UI` but bandData indexing is 1D mod/divide (phase0-encoding.md section 5; phase0-rendering.md fragment shader line 244)**
The encoding doc specifies the band texture as `RGBA16UI` with two regions packed into one texture. The rendering fragment shader indexes it as `texelFetch(bandTexture, ivec2(globalBandIdx % 1024, globalBandIdx / 1024), 0)`. This assumes the band texture is laid out as a flat 1D array of band headers, width=1024. But the encoding doc says the texture contains both a band table region AND an entry region. The fragment shader cannot distinguish them with a single global index without knowing where the entry region starts — that offset is per-glyph and must come from glyphMapTexture texel 2: `hBandTableStart`. The rendering agent's shader reads `bandData.x` as `bandCurveStart` and `bandData.y` as `bandCurveCount`, which matches the encoding agent's `(entryStart, entryCount)` at the header level. But the two-region packing means the indexing into curveTexture inside the loop (`vCurveStart + bandCurveStart + i`) is wrong if `bandCurveStart` is an entry into the entry region (already offset) and `vCurveStart` is also a glyph-local offset. One of these is redundant or the semantics differ. This needs explicit resolution.

**E3 — `DataView.setFloat16()` is Baseline 2025 but not universally available on target platforms**
phase0-encoding.md section 4 states "Baseline 2025, no polyfill needed." The project targets WebGL 2 browsers. Android Chrome < 121 (released Jan 2024) lacks `DataView.setFloat16()`. If the project serves to broader audiences, a 6-line polyfill using `Float32Array` + exponent/mantissa bit-packing is necessary. At minimum, add a runtime feature check with a clear error message rather than a silent failure.

**E4 — Winding number coverage antialiasing in rendering agent is inadequate**
phase0-rendering.md line 271: `float coverage = clamp(abs(float(winding)), 0.0, 1.0)` gives binary 0/1 coverage (winding is an integer, abs(integer) is either 0 or ≥1). There is no sub-pixel antialiasing. The Slug algorithm's AA comes from computing the distance to the nearest curve and mapping that to a partial alpha in the range where the winding number changes. Without this, Slug will produce aliased edges — no better than alphaTest. This is a known deficiency in the rendering sketch and must be addressed before Phase 3 ships.

## Gaps

**What rendering covered that others missed:**
- `transparent: false` + `alphaTest: 0.01` is the current material setting (verified line 260-261 of GlyphRenderer.js). Switching to `transparent: true` for Slug coverage-based alpha changes the draw order behavior (Three.js sorts transparent objects). This is a non-trivial compatibility change that neither plumbing nor encoding addressed.
- The picking system's `registerRenderer()` reads uniforms by name from `mesh.material.uniforms` (PickingSystem.js line 266-270). After atlas removal, those keys are gone and glyph-mode picking will silently pass `undefined` as uniform values — no error thrown, just invisible picking. This needs an explicit guard and update, not just a note.
- `alphaTest` vs `transparent: true` depth-sorting: with `transparent: true`, Three.js renders objects back-to-front, which is wrong for overlapping grids. The current `alphaTest` + `depthWrite: true` + `transparent: false` combo is intentional.

**What plumbing covered that rendering missed:**
- The `INIT_FONT` / `FONT_READY` handshake protocol in WorkerBridge — rendering didn't analyze worker message flow changes at all.
- Font MIME type for `.ttf` serving — a real deployment gap.
- The transition period where both atlas and Slug run in parallel (Phase 1→2) — rendering assumed atlas is gone from day one.

**What encoding covered that rendering missed:**
- The cubic bezier throw-on-C decision — rendering's fragment shader has no branch for C segments, which is consistent only if SlugEncoder enforces the throw before any C reaches the GPU.
- Memory budget comparison (140x reduction vs current atlas) — a strong argument for stakeholder buy-in.
- The `encodeGlyph()` degenerate quadratic derivation for L segments uses midpoint as control point: `p1 = (p0 + p2) / 2`. This is geometrically correct for a line segment rendered as a quadratic.

## Tensions

**T1 — glyphMapTexture: 4 texels per glyph (encoding) vs 1 texel per glyph (rendering)**

Encoding agent (section 6): RGBA32F, 4 texels per glyph, glyph G at columns `G*4` through `G*4+3`, stores curveStart, curveCount, hBandCount, vBandCount, bbox xywh, hBandTableStart, vBandTableStart.

Rendering agent (section 9 + vertex shader): RGBA16UI, 1 texel per glyph, stores `(curveStart, curveCount, bandStart, bandCount)`.

**The rendering agent's layout is correct for the shader.** The 4-texel RGBA32F layout in the encoding doc over-engineers the per-glyph metadata. The rendering vertex shader fetches one texel and passes 4 integers as flat varyings — that is exactly what one RGBA16UI texel provides. The encoding agent's Texel 1 (bbox) does not need to live in the glyphMapTexture at all: the bbox is used only by the fragment shader to map `vGlyphUV` back to normalized glyph space. But if curves are already normalized to [0,1] during encoding (as SlugEncoder does), the fragment shader does not need the bbox at runtime. The 4-texel layout's Texel 3 (reserved advance) is unused. The resolution: use 1 texel per glyph (RGBA16UI), remove bbox from the glyphMapTexture, and store bbox only in SlugEncoder's CPU-side data for validation. The rendering agent's design wins.

**T2 — curveTexture: RGBA16F (encoding) vs RGBA16UI (rendering)**

Encoding agent (section 4): RGBA16F (Half-float), coordinates normalized to [0,1], `DataView.setFloat16()`.

Rendering agent (section 9): RGBA16UI, `unpackCoord(uint bits) = float(bits) / 65535.0` (same normalization as UNORM16).

These are mechanically equivalent: RGBA16F with values in [0,1] and RGBA16UI with values linearly mapped to [0,1] both store the same precision (~3-4 decimal places). However, RGBA16UI is safer in WebGL 2: `RGBA16F` textures require `EXT_color_buffer_half_float` on some drivers when used as render targets (not relevant here — we're only reading them). For texture sampling, `RGBA16F` sampling support in WebGL 2 with a `sampler2D` (not `usampler2D`) is fine, but requires `OES_texture_half_float_linear` for linear filtering. Since we use `texelFetch` (no filtering), RGBA16F is safe. **RGBA16UI is the better choice** because it avoids the float16 browser support gap noted in E3, removes the half-float extension dependency, and the `unpackCoord` formula is two instructions in GLSL. Use RGBA16UI with `usampler2D`.

**T3 — transparent: true (rendering agent) vs material blending semantics**

The rendering agent (section 8) proposes `transparent: true` for Slug. The current material uses `transparent: false, alphaTest: 0.01`. Three.js with `transparent: true` sorts meshes back-to-front per frame, which breaks the current rendering model where CodeGrids overlap in Z without sorting artifacts because they use depth write + alpha test. `transparent: true` must not be used. Instead: keep `transparent: false`, remove `alphaTest`, and in the fragment shader use an explicit `if (coverage < 0.01) discard;`. This reproduces identical behavior without depth-sort overhead.

## Recommendations

1. **Fix glyphMapTexture to 1 texel per glyph (RGBA16UI).** 4 texels is unnecessary. The vertex shader reads exactly 4 uint16 values; one RGBA16UI texel is the match. SlugEncoder must produce this layout.

2. **Use RGBA16UI for curveTexture.** Eliminates `DataView.setFloat16()` dependency, avoids half-float extension risk, achieves same precision with simpler unpack in shader.

3. **Cache `glyphOutline()` results in a Map<glyphId, hasOutline> inside HarfBuzzShaper or in the builder.** Eliminates the double-call per glyph in buildShapedBuffers. One call per unique glyph ID across all text (tiny for Cousine).

4. **Keep `transparent: false` after Slug migration.** Remove `alphaTest`, add explicit `discard` in fragment shader. This preserves depth write semantics and avoids Three.js sort overhead.

5. **Implement sub-pixel AA in the fragment shader.** The winding integer gives binary coverage. Use `fwidth(p)` to estimate screen-space derivative, compute distance to nearest curve edge in that band, and smoothstep within ±0.5px. Without this, Slug output will be visually worse than the current atlas at typical text sizes.

6. **Update `registerRenderer()` in PickingSystem to handle the missing atlas uniforms.** Add a guard: `if (this._mode === 'glyph' && !mainUniforms.atlasTexture) throw new Error(...)`. After Phase 3, register glyph-mode picking with `curveTexture`, `bandTexture`, `glyphMapTexture`.

7. **Resolve the two-region band texture indexing.** Define explicitly whether `bandCurveStart` (from the band header texel) is an absolute texel index into the entry region or a count-offset. The fragment shader's final curve index (`vCurveStart + bandCurveStart + i`) is only correct if `bandCurveStart` is the global entry offset and `vCurveStart` is the glyph-local curve pool offset — make this contract explicit in a comment and in `SLUG_LIMITS`.

8. **Send fontBuffer to workers as structured clone, not Transferable.** At ~100KB, the copy cost is negligible. Structured clone avoids the per-worker-slice ceremony and the misleading comment about "first transfer takes the original." The main thread keeps its reference for SlugEncoder.

9. **Add a feature check for `DataView.setFloat16()` at SlugEncoder construction time** — even if RGBA16UI wins for curveTexture, if any code path uses Float16 textures, fail loudly with a clear message rather than a silent TypeError.

10. **The buildShapedBuffers pre-count pass is unnecessary.** Instead, allocate for worst case (all glyphs visible), write, then slice to actual count. For a typical line of code, every character is visible; the pre-count overhead exceeds the slice cost. This also eliminates the double `glyphOutline()` issue structurally.

## Key Insight

The encoding and rendering agents designed the glyphMapTexture independently and arrived at incompatible layouts, which is the single most load-bearing interface between Phase 2 and Phase 3. Everything else — winding number computation, band organization, HarfBuzz shaping — is internal to one layer. The glyphMapTexture contract is the exact boundary where SlugEncoder output becomes GlyphRenderer input, and it must be locked down before any code is written: one RGBA16UI texel per glyph, four uint16 fields — `(curveStart, curveCount, bandTableStart, bandCount)` — with the band texture containing a flat array of `(entryStart, entryCount)` headers followed by a flat entry array whose absolute offsets are stored in the headers. Once that layout is agreed, both the SlugEncoder packing code and the GLSL lookup chain become straightforward to implement independently and integrate without rework.

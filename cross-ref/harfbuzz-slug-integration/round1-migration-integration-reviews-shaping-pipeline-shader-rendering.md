# Round 1: migration-integration reviews shaping-pipeline, shader-rendering

## Errors Found

1. **shaping-pipeline: `import hb from 'harfbuzzjs'` will not work in a Web Worker.**
   `harfbuzzjs` exports a factory function that loads WASM. In a worker served via the Go binary's embedded FS, bare-specifier imports (`'harfbuzzjs'`) fail — there is no bundler, no import map, and `node_modules/` is not served. The `GlyphWorker.js` code sample at line 53 (`import hb from 'harfbuzzjs'`) is broken in this project's module resolution setup. The correct approach is to vendor the ~200-line JS wrapper into `src/shaping/` and have it accept a WASM URL or ArrayBuffer, as I described in my Phase 0. The same error appears in `shapeText.js` at line 115.

2. **shaping-pipeline: Space detection via "glyphId 3" or "missing UV entry with advance > 0" is fragile.**
   At lines 188-198 of the `buildBatchBuffers` replacement code, the whitespace detection strategy checks `!entry && sg.advance > 0`. This is unreliable: HarfBuzz assigns a valid glyph ID to space (glyph ID 3 in most fonts, but NOT guaranteed). The atlas _will_ have an entry for space if the font has a space glyph — which Cousine does. The current code (`index.js` line 381) detects space via `cp === 32` on the Unicode codepoint. After HarfBuzz shaping, we lose direct access to the original codepoint but retain the `cluster` index, which maps back to the source string. **Correct approach**: use `sg.cluster` to index into the original text and check `text.codePointAt(sg.cluster) === 32`. This is reliable and font-independent.

3. **shaping-pipeline: The `fallbackShape()` dual path contradicts project policy.**
   At line 170 of the builder changes: `shared.hbReady ? shapeText(...) : fallbackShape(...)`. This is a compat shim / dual path. Per project policy (no compat shims), HarfBuzz must be initialized before any builder runs. If it isn't ready, that's a startup sequencing bug, not a runtime fallback case. Remove `fallbackShape`.

4. **shader-rendering: `texture()` vs `texelFetch()` concern is valid but the stated risk is overstated.**
   At line 35, the claim that `texture()` with bilinear filtering causes "noise on texel-boundary lookups" for `atlasMapTexture`. The current shader (`GlyphRenderer.js` line 365) uses `(mapCol + 0.5) / atlasMapWidth` — the +0.5 centers the sample within the texel, avoiding boundary interpolation. This is correct and intentional. The observation is technically accurate (NearestFilter on the DataTexture would be cleaner), but it is not a bug that needs fixing in Phase A or B. The Phase B replacement correctly proposes `texelFetch` for `glyphMapTexture`, which is the right move.

5. **shader-rendering: Loop bound concern for `vBandCount` in GLSL ES 3.0 (line 301).**
   The claim that `flat in int` varyings as loop bounds are "technically non-conformant" is incorrect for GLSL ES 3.0 / WebGL 2. The spec (GLSL ES 3.00 section 4.1) requires loop index expressions to be "constant-index-expressions" only in GLSL ES 1.0. GLSL ES 3.0 relaxed this — dynamic loops with non-constant bounds are valid. The `MAX_BANDS` compile-time cap is still wise for GPU divergence control, but the conformance concern is unfounded.

6. **shaping-pipeline: `getGlyphIdMap()` shapes every grapheme individually (lines 258-274).**
   For a charset of ~400 graphemes, this creates and destroys 400 HarfBuzz buffers. More importantly, shaping a single grapheme like `"f"` through HarfBuzz will NOT trigger ligature substitution, so the glyph ID for `"f"` is correct — but an `"fi"` ligature glyph will never appear in this map because no single grapheme shapes to the ligature glyph ID. This means if HarfBuzz produces ligature glyph IDs during actual text shaping, they will miss the `glyphIdUvMap` entirely. For Cousine (no ligatures), this is fine. For ligature-capable fonts (Fira Code), this silently breaks. The doc should note this limitation explicitly.

## Gaps

- **shaping-pipeline covers `countGlyphs()` pre-allocation problem in detail** (shape-first-cache approach, lines 229-236). I mentioned this only implicitly. Their "shape first, allocate second" decision is correct and more explicit than my treatment.
- **shader-rendering covers the `HALF_FLOAT` precision analysis** (line 159: 3.3 decimal digits in [0..1] range). I did not address texture precision at all. Their conclusion is correct — float16 is sufficient for normalized glyph-local coordinates.
- **shader-rendering covers antialiasing depth** (section 10, lines 366-375) including stem darkening and analytic coverage. I flagged "Slug fragment shader performance" as a risk but did not address how AA actually works. Their treatment is the authoritative reference for Phase B.
- **I covered `Makefile` changes in detail** (prep-wasm target, ASSETS list). Neither other agent addressed the build system at this level.
- **I covered `.gitignore` for `assets/wasm/`**. Neither other agent mentioned this — the WASM binary would be committed to git without it.
- **shaping-pipeline missed** the `applyPrebuiltBuffers` fallback recount at `GlyphRenderer.js` line 1370, which uses `iterGraphemes()`. They flagged the line number reference (1364) but did not show the fix. The fallback iterates graphemes and counts `cp > 32` to reconstruct `itemMeta`. With HarfBuzz, this must use the shaped glyph count from `itemMeta` (which is always present when using the new pipeline — the fallback path is dead code).
- **Neither other agent addressed** how `GlyphCollection.js` calls into the builder pipeline. The `flushAsync()` / `_renderBatchAsync()` path dispatches to `WorkerBridge.buildBatch()`. This is the actual integration seam where shaped text enters the pipeline, and it needs explicit treatment.

## Tensions

1. **File deletion timing: clean cut vs. "mark deprecated".**
   I say `textToGlyphs.js` and `layoutText.js` are deleted in Phase A (my doc, line 14). shaping-pipeline says "Mark deprecated / keep as non-HarfBuzz fallback" (line 392) and "Mark deprecated / remove import" (line 391). These are contradictory. **My position is correct** per project policy: no fallback paths, no deprecated-but-kept files. If the HarfBuzz pipeline is the only path, delete the dead code. The `fallbackShape()` function in shaping-pipeline's builder changes reinforces this discrepancy — it references `layoutText` logic that I say should not exist.

2. **`instanceCodepoint` rename timing.**
   shaping-pipeline says: "Rename to `instanceGlyphId` deferred to Phase B" (line 13). shader-rendering says: "renamed `instanceGlyphId` — same `float` type, same buffer slot" as part of Phase B vertex shader changes (line 127). I say no rename in Phase A, consistent with shaping-pipeline. **All three agree on the final state** but the timing matters for picking: `PickingSystem.js` line 74 declares `in float instanceCodepoint` in the glyph-mode vertex shader. If Phase B renames the attribute, the picking shader must rename it simultaneously or the shader won't link. shader-rendering correctly notes glyph-mode picking is dropped in Phase B (line 324), so the rename is safe — but only if glyph-mode removal and attribute rename happen in the same commit.

3. **Font URL path.**
   shaping-pipeline uses `/fonts/Cousine-Regular.ttf` (line 24). I use `/assets/fonts/Cousine-Regular.ttf` (line 154). The file lives at `assets/fonts/` in the repo, and the Go binary serves from the root of the embedded FS, so the correct URL is `/assets/fonts/Cousine-Regular.ttf`. **My path is correct.** shaping-pipeline's path would 404.

4. **`uvMap` keying transition approach.**
   shaping-pipeline proposes a "two-layer approach" (lines 250-278) where `GlyphAtlas` continues generating grapheme-keyed UVs, then a new `getGlyphIdMap()` builds a second map keyed by glyph ID. I propose the same thing but describe it differently ("add `getGlyphIdMapping()`"). These are functionally identical — no real tension, just different names for the same map.

## Recommendations

1. **Vendor the harfbuzzjs JS wrapper.** Copy the ~200-line `hb.js` into `src/shaping/harfbuzz-wasm.js`, rewrite it to accept a WASM ArrayBuffer parameter. This eliminates bare-specifier import issues in both main thread and worker contexts. Add `harfbuzzjs` to devDependencies for WASM binary access only.

2. **Use cluster-based whitespace detection.** In the shaped builder loop, detect spaces via `text.codePointAt(shaped[i].cluster) === 32` rather than missing-UV-entry heuristics. This is correct for all fonts and matches the current builder's `cp === 32` logic at `index.js` line 381.

3. **Delete `textToGlyphs.js`, `layoutText.js`, and `buildBuffers.js` in Phase A.** No fallback path. `buildBuffers.js` already has zero imports (confirmed by grep). `textToGlyphs.js` and `layoutText.js` are only imported transitively via the old path. Clean cut.

4. **Add `WorkerBridge.dispose()` for HarfBuzz cleanup.** shaping-pipeline correctly identifies this gap (line 377). The method should send a `CLEANUP` message to each worker, which calls `hbFont.destroy()`, `hbFace.destroy()`, `hbBlob.destroy()`. Workers currently have no teardown path.

5. **Use `try/finally` in `shapeText()` for buffer cleanup.** shaping-pipeline's code at lines 366-374 is the correct pattern. HarfBuzz buffer leaks are the most likely memory issue. Enforce `buffer.destroy()` in a `finally` block.

6. **Add a `MAX_BANDS` compile-time cap in the Slug fragment shader.** Not for GLSL ES 3.0 conformance (which is fine), but for GPU divergence control. A glyph with 200 bands would cause severe warp divergence. Cap at 64, break early. This is shader-rendering's recommendation (line 301) for the right reason but wrong justification.

7. **Document the ligature limitation in `getGlyphIdMap()`.** For Phase A with Cousine, this is a non-issue. If ligature fonts are ever supported, the map-building approach must shape multi-character sequences, not just individual graphemes.

8. **Pre-warm workers with font buffer during loading screen.** Send `INIT_FONT` to all workers before the first file load. The current loading overlay already exists in `GitHubRepoViewer.js` — add font transfer to the init sequence there, after WASM compile and before `atlas.generate()`.

9. **In Phase B, drop glyph-mode picking and rename `instanceCodepoint` to `instanceGlyphId` in the same commit.** These changes are coupled: glyph-mode picking references `instanceCodepoint` in `PickingSystem.js` line 74. Removing glyph-mode and renaming the attribute must be atomic.

10. **Add `.ttf` MIME type to `relay.go`.** The current MIME switch at `relay.go` line 382 does not handle `.ttf`. While `application/octet-stream` works, explicit `font/ttf` is correct and prevents potential download-vs-render confusion in some browsers.

## Key Insight

The three analyses converge on the same architecture but diverge on a critical operational question: whether to maintain a non-HarfBuzz fallback path during Phase A. shaping-pipeline builds one (`fallbackShape`), I explicitly reject it, and shader-rendering does not address it. This is not a minor style disagreement — a fallback path means every code change must be validated against two rendering pipelines, the worker message protocol has two modes, and `countGlyphs()` must work both ways. The project's "no compat shims" policy exists precisely because dual paths double the testing surface while halving confidence in either path. The correct approach is: HarfBuzz initializes during startup (before any text rendering), and if initialization fails, the application does not start. Phase A ships as a clean replacement, not a graceful degradation. This is what makes Phase A a stable checkpoint that Phase B can safely build on.

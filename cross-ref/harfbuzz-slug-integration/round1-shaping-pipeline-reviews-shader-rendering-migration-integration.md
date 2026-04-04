# Round 1: shaping-pipeline reviews shader-rendering, migration-integration

## Errors Found

1. **shader-rendering line 35: "Note: `texture()` not `texelFetch()` is used here, which means bilinear filtering noise is possible on texel-boundary lookups."** This is misleading. The `atlasMapTexture` is created in `GlyphAtlas.js` (line 506-507) with `THREE.NearestFilter` for both min and mag. The `texture()` call with NearestFilter is functionally equivalent to `texelFetch()` at the texel centers chosen by the `(mapCol + 0.5) / atlasMapWidth` calculation. There is no bilinear filtering noise. The observation is technically imprecise -- the issue would only arise if someone changed the filter mode, which the code does not do. Switching to `texelFetch()` is still a good cleanup but is not a correctness fix.

2. **shader-rendering section 6, GLSL loop bounds: "`vBandCount` is a `flat in int` which is technically runtime-varying per draw call invocation."** This framing is wrong. `flat in int` means the value is uniform across a primitive (triangle), not across the draw call. Different instances get different values. GLSL ES 3.0 (section 6.2) allows loops bounded by uniform expressions or expressions that are "not varying" -- `flat` varyings satisfy this in practice, but technically the spec says loop iteration limits must be "constant-index expressions" or use a break. The concern is real but the explanation is garbled. The correct mitigation (compile-time MAX_BANDS cap with early break) is right.

3. **migration-integration: "`GlyphAtlas` must map glyphId -> grapheme -> numericId, or we add a direct glyphId -> numericId path`"** This double-indirection is unnecessary and I covered the correct approach: HarfBuzz glyph IDs become the new numericIds directly. The atlas generates a `glyphIdUvMap` keyed by integer glyph ID, and that glyph ID IS the DataTexture index. No grapheme-string intermediate lookup. Migration-integration's phrasing suggests a triple-hop (glyphId -> grapheme -> numericId) which adds complexity for zero benefit.

4. **migration-integration: "line 107" for `_hasUVMap` pattern.** Verified: `WorkerBridge.js` line 107 does set `worker._hasUVMap = false`. But the doc says "parallels `_hasUVMap` at line 107" for the new `_hasFont` flag -- this is correct as a reference pattern but the line number shifts once code is added above it. Minor, but citing line numbers in a file you plan to modify is fragile.

5. **migration-integration: "Workers also run SlugEncoder (curve extraction is CPU work). Curve data transferred back to main thread for texture upload."** This is architecturally wrong. SlugEncoder (bezier extraction from font outlines) should run on the main thread at font-load time, not per-job in workers. The curve/band textures are font-level data (one set of curves per glyph ID, shared across all instances). Workers only need to shape text and build instance buffers -- they never need curve data. Sending curve data back from workers to main thread for texture upload is a needless round-trip.

6. **shader-rendering section 4, bandTexture format: "`THREE.RGIntegerFormat` + `THREE.UnsignedShortType` (RG16UI)".** Three.js does not have `THREE.RGIntegerFormat`. The correct Three.js constant is `THREE.RGIntegerFormat` -- actually, checking Three.js source, the constant for RG integer is `RGIntegerFormat` which was added in r149. This exists but is easy to misremember. Needs verification at implementation time. An alternative is `THREE.RGBAIntegerFormat` with 2 channels wasted, which is safer compatibility-wise.

## Gaps

**Covered by me, missed by others:**
- `countGlyphs()` pre-allocation problem: HarfBuzz may produce fewer glyphs (ligatures) or more (decomposition) than `iterGraphemes()` counts. I proposed shape-first-then-allocate. Neither other agent addressed this buffer sizing issue concretely.
- The `applyPrebuiltBuffers` fallback at `GlyphRenderer.js` line 1364-1380 recounts glyphs via `iterGraphemes()`. This silently breaks if the buffer was built from HarfBuzz-shaped output with different glyph counts. I flagged this; neither other agent did.
- Memory management checklist for HarfBuzz WASM objects (`hbBlob`/`hbFace`/`hbFont` lifetime, `buffer.destroy()` in `finally` blocks).

**Covered by shader-rendering, missed by me:**
- Detailed Slug fragment shader GLSL with `bezierWinding()` function and band iteration loop. I deferred Slug entirely to Phase B and focused on Phase A plumbing.
- `texture()` vs `texelFetch()` audit on `atlasMapTexture` -- a valid cleanup opportunity I did not mention.
- Antialiasing and stem darkening analysis for small glyph sizes.

**Covered by migration-integration, missed by me:**
- `.gitignore` addition for `assets/wasm/` (WASM is a build artifact, not committed).
- Makefile `prep-wasm` target to copy WASM from `node_modules/`.
- License file for Cousine font (`LICENSE-Cousine.txt`).
- `GlyphAtlasLoader.js` deletion in Phase B (I forgot this file exists; confirmed at `src/GlyphAtlasLoader.js`).

## Tensions

1. **HarfBuzz JS wrapper: vendor vs import.** My Phase 0 uses `import hb from 'harfbuzzjs'` in worker code. Migration-integration says "vendor the harfbuzzjs JS wrapper into `src/shaping/harfbuzz-wasm.js`." These are incompatible. **Migration-integration is correct.** Workers loaded via `new Worker()` with `type: 'module'` cannot resolve bare specifiers like `'harfbuzzjs'` without an import map or bundler -- and this project has neither. The JS wrapper must be vendored and imported by relative path.

2. **New file structure: `src/workers/builders/shapeText.js` vs `src/shaping/HarfBuzzShaper.js`.** I put the shaping helper in `src/workers/builders/` (worker-safe). Migration-integration creates a `src/shaping/` directory with `HarfBuzzShaper.js` and `ShapedText.js`. **Both are partially right.** The shaping logic should live in `src/shaping/` (it is a domain concept, not a builder detail), but it must remain worker-importable (no DOM, no Three.js). `src/shaping/HarfBuzzShaper.js` is the right location; my `shapeText.js` should be a function inside it or a thin re-export.

3. **Phase A: rename `instanceCodepoint` or not.** I said defer rename to Phase B. Shader-rendering says "renamed `instanceGlyphId` -- same float type, same buffer slot" for Phase B. Migration-integration says the attribute name stays in Phase A. **Agreement on Phase A (no rename), but shader-rendering's Phase B claim that it is "same buffer slot" needs care.** The attribute name is referenced in `GlyphRenderer.js` lines 310, 1283, and in `PickingSystem.js` lines 74, 99. All four must be updated atomically.

4. **Where SlugEncoder runs.** Migration-integration puts it in workers (Phase B). Shader-rendering implies it is CPU-built once during font loading on the main thread ("CPU-built once during font loading and uploaded as a DataTexture"). **Shader-rendering is correct.** Curve extraction is a font-level operation, not a per-text operation. It runs once, produces textures, done.

## Recommendations

1. **Vendor `harfbuzzjs` JS wrapper into `src/shaping/harfbuzz-wasm.js`.** Workers cannot resolve bare specifiers. Copy the ~200-line wrapper, import by relative path from both main thread and workers.

2. **Fix `applyPrebuiltBuffers` fallback immediately.** `GlyphRenderer.js` line 1364: the `iterGraphemes` recount must be gated on whether buffers came from shaped output. Add a `shaped: true` flag to `itemMeta` so the fallback path knows to skip recount (it should never trigger for shaped buffers since `itemMeta` is always provided).

3. **Use `texelFetch()` for `atlasMapTexture` in the vertex shader.** Replace `GlyphRenderer.js` line 365's `texture(atlasMapTexture, vec2(tx, ty))` with `texelFetch(atlasMapTexture, ivec2(int(mapCol), int(mapRow)), 0)`. Same for `PickingSystem.js` line 104. Clean, removes any filtering ambiguity, and aligns with how `highlightTexture` is already accessed.

4. **Run SlugEncoder on main thread, not in workers.** Curve/band textures are font-level, built once. Workers should only receive shaped glyph output (glyphId + advances) and build instance buffers. No curve data flows through the worker bridge.

5. **Shape-first allocation in `buildBatchBuffers`.** Shape all items, cache results, sum glyph counts, then allocate typed arrays once. The shaping cost is negligible (~0.1ms/1000 chars) and eliminates the over-allocate-then-trim alternative.

6. **Add `CLEANUP` message to worker protocol.** `WorkerBridge.dispose()` (line 357) calls `worker.terminate()` directly. Add a `CLEANUP` message so workers can call `hbFont.destroy()` / `hbFace.destroy()` / `hbBlob.destroy()` before termination. Prevents WASM memory leaks during hot reload.

7. **Compile-time `MAX_BANDS` cap in Slug fragment shader.** Use `const int MAX_BANDS = 64;` with `min(vBandCount, MAX_BANDS)` as the loop bound. This satisfies strict GLSL ES 3.0 loop rules and prevents runaway iteration on malformed data.

8. **Verify `THREE.RGIntegerFormat` availability.** Before committing to RG16UI for `bandTexture`, confirm the Three.js version in use (>=0.150.0 per `package.json`) exports `RGIntegerFormat`. If not, use `RGBAIntegerFormat` with 2 wasted channels -- 4 bytes/texel instead of 2, still negligible at the data sizes involved.

9. **Delete `src/workers/builders/buildBuffers.js` in Phase A**, not just "confirm no imports." It is dead code now (superseded by `index.js`). Clean cut per project policy.

10. **`countGlyphs` space-handling inconsistency.** `countGlyphs()` (line 37-44) counts glyphs where `cp > 32`, excluding spaces. But the builder loop (line 381-387) also skips spaces from the buffer. So the count is correct for pre-allocation. With HarfBuzz, the equivalent logic is: count shaped glyphs that have atlas entries (non-whitespace). Document this invariant explicitly in the new shaped builder.

## Key Insight

The three analyses converge on the same core architecture but diverge on a critical data-flow question: where does font-level work (outline extraction, curve packing) happen vs. where does per-text work (shaping, buffer building) happen? Migration-integration conflates the two by putting SlugEncoder in workers, which would mean curve data flows worker-to-main on every build job. The correct boundary is: font-level operations (atlas generation in Phase A, curve/band texture construction in Phase B) run once on the main thread at startup; per-text operations (HarfBuzz shaping + buffer building) run in workers per job. This boundary already exists in the codebase -- `GlyphAtlas.generate()` runs on main, `buildBatchBuffers()` runs in workers -- and the integration should preserve it, not collapse it.

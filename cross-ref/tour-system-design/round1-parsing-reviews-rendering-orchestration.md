# Round 1: parsing reviews rendering, orchestration

## Errors Found

1. **Orchestration: `highlightRange` called with 0-based lines from `ParsedReference`, but my parsing layer outputs 1-based lines.** Orchestration's `ParsedReference` typedef says `line` is "0-based line number" (phase0-orchestration.md line 38), but my `FileRef` and `ParsedRef` types output 1-based line numbers (phase0-parsing.md lines 20-21, 312-313). The parsing doc explicitly states "Parsers output 1-based (source-faithful); resolver converts in one place." Orchestration's `TourAnnotator.apply()` (line 687) calls `grid.highlightRange(ref.line, ...)` without subtracting 1. Since `CodeGrid.highlightRange` is 0-based (`highlightCommands.js` line 5: "All coordinates are 0-based"), this will highlight the wrong line. **Fix: either define the `ParsedReference` interface as 1-based (matching my output) and convert in the resolver, or convert in the annotator. But it must happen somewhere.**

2. **Orchestration: `TourResolver._findBySuffix` accesses `entry.meta.sourcePath` but some grids are registered with `sourcePath` as the `id` itself.** In `GitHubRepoViewer.js` line 980-983, grids are registered as `registry.register(sp, grid, { type: 'grid', sourcePath: grid.userData.sourcePath })`. The entry id IS the sourcePath. So `entry.meta.sourcePath` works in this case -- but the resolver's exact match on line 103 (`this._registry.get(ref.file)`) would only succeed if `ref.file` exactly equals the full sourcePath used as the registry id. A suffix like `"GlyphAtlas.js"` won't match `this._registry.get("src/GlyphAtlas.js")`. Not an error per se, but the "exact" match described at line 103 is misleadingly named -- it's really "exact registry ID match," which requires prior knowledge of the full registry key.

3. **Orchestration: TourConnector creates separate `THREE.Line` objects per connection -- one draw call each.** The rendering agent specifically designed `ConnectionRenderer` as a single-geometry, single-draw-call solution (phase0-rendering.md lines 14-17). But orchestration ignores `ConnectionRenderer` entirely and creates individual `THREE.Line` objects in `TourConnector._createLine()` (phase0-orchestration.md lines 848-859). At 20+ connections, this adds 20+ draw calls. The rendering agent's approach is correct; orchestration should use it.

4. **Rendering: `addUpdateRange` parameters use float offsets, not byte offsets.** The rendering agent's ConnectionRenderer calls `this._posBuf.addUpdateRange(vertBase * 3, VERTS_PER_CONNECTION * 3)` (line 253). Checking the existing codebase usage in `GlyphRenderer.js` line 566: `posAttr.addUpdateRange(startIdx * 3, entry.glyphs.length * 3)` -- this is consistent. Three.js `addUpdateRange(start, count)` operates on array element indices (floats for Float32Array). The rendering agent's usage is correct.

5. **Orchestration: `TourAnnotator` calls `resolved.grid.getVisibleCharCount?.(endLine)` (line 686) as a fallback for `endCol`.** This is actually correct API usage (`CodeGrid.js` line 579). No error here. However, `grid.lines` (used in `_highlightToken` at line 751) is a valid property set during `loadText()` (`CodeGrid.js` line 48). This is fine.

## Gaps

- **Rendering covers frustum-culled connection visibility; orchestration does not.** Rendering's `refreshVisibility()` (lines 364-379) handles the case where GridVirtualizer removes a grid from the scene. Orchestration's TourConnector has no such logic -- connections to off-screen grids would render to stale world positions or, worse, stay visible pointing at nothing.
- **Rendering specifies arrowheads; orchestration does not.** TourConnector uses bare `THREE.Line` with no directional indicators. The rendering agent's 3-segment (shaft + 2 arrow sides) design per connection is more informative for showing flow direction in a tour.
- **Parsing provides `ParseResult.unmatched` lines; neither rendering nor orchestration uses them.** Unmatched lines could drive a "context" display showing non-reference text in the tour, but both consumers silently drop them.
- **Orchestration defines `TourAnnotator._highlightToken` for text search within grids.** My parsing layer provides no `token` field -- it extracts structured file references. The `token` field in orchestration's `ParsedReference` typedef (line 43) has no producer in the parsing pipeline. It's an orchestration-only manual input, which is fine but should be documented.
- **Rendering's `updatePosition()` for grid movement.** When a grid moves (layout shift, user drag), connection endpoints become stale. Orchestration has no mechanism to re-derive endpoints after grid position changes.

## Tensions

1. **Connection rendering architecture: single geometry (rendering) vs. per-connection objects (orchestration).** Rendering proposes `ConnectionRenderer` in `src/annotations/` with pre-allocated buffers and partial GPU uploads (phase0-rendering.md lines 62-281). Orchestration proposes `TourConnector` in `src/services/tour/` with individual `THREE.Line` objects (phase0-orchestration.md lines 771-861). **Rendering is correct.** The single-geometry approach matches the project's existing pattern (GlyphRenderer uses InstancedBufferGeometry for the same reason). Orchestration's TourConnector should be rewritten to delegate to ConnectionRenderer rather than managing its own geometry.

2. **File placement: `src/annotations/` (rendering) vs. `src/services/tour/` (orchestration).** Rendering places ConnectionRenderer as a general-purpose library component. Orchestration places tour-specific logic in a services subdirectory. Both are reasonable, but the split is correct: ConnectionRenderer is reusable beyond tours and belongs in `src/annotations/`. The tour-specific orchestration (TourSequencer, TourAnnotator) belongs in `src/services/tour/` and should import from `src/annotations/`.

3. **Coordinate convention: 1-based (parsing) vs. 0-based (orchestration).** My parsers output 1-based coordinates (matching source file conventions). Orchestration's `ParsedReference` typedef declares 0-based. The conversion must happen at the boundary. **Parsing's convention is correct for a parser** (faithful to source), and the resolver or annotator must subtract 1. Orchestration's typedef should either document "1-based, converted at application time" or the resolver should handle it.

## Recommendations

1. **Orchestration: adopt rendering's `ConnectionRenderer` instead of `TourConnector._createLine()`.** Rewrite `TourConnector` to hold a reference to a shared `ConnectionRenderer` instance, calling `set()`/`remove()` instead of creating individual `THREE.Line` objects.

2. **Orchestration: add 1-based to 0-based conversion in `TourAnnotator.apply()`.** Before calling `grid.highlightRange()`, subtract 1 from `ref.line`, `ref.endLine`, `ref.col`, `ref.endCol`. Alternatively, define the `ParsedReference` interface as 1-based and document the convention.

3. **Orchestration: wire `ConnectionRenderer.refreshVisibility()` into the animate loop.** After `virtualizer.update()`, call `connectionRenderer.refreshVisibility()` to hide connections whose endpoint grids are culled.

4. **Orchestration: pass `fromGrid`/`toGrid` references when calling `ConnectionRenderer.set()`.** The rendering agent's `refreshVisibility` design expects grid references stored per connection entry. Without them, frustum-aware visibility cannot work.

5. **Rendering: add a `setColor(id, color)` method to `ConnectionRenderer`.** The current API requires re-specifying `from`/`to` to change color (no `updateColor` counterpart to `updatePosition`). Tour steps may want to dim/brighten connections without recomputing geometry.

6. **Orchestration: `TourResolver.resolve()` should try `entry.id` in suffix matching, not just `entry.meta.sourcePath`.** In `GitHubRepoViewer.js`, the registry id IS the sourcePath. The resolver's `_findBySuffix` reads `entry.meta.sourcePath || entry.meta.filename || entry.id` (line 163) which does fall back to `entry.id`, so this works -- but the primary check should be `entry.id` since that's the canonical key.

7. **Parsing: export a `convertToZeroBased(parsedRef)` utility.** This makes the 1-to-0 conversion explicit and testable rather than buried in consumer code.

8. **Rendering: document that `_writeSlot` silently degenerates (zeros out) connections shorter than 1e-6 world units.** This is correct behavior but could surprise callers who expect a visible result for two overlapping anchor points (e.g., self-referencing grid).

9. **Orchestration: `clear()` iterates `unregisterByType('tour-annotation')` and calls `entry.grid.dispose()`, but does not clear highlights on the source grids.** When a tour is cleared, highlighted ranges on the code grids remain. Add `grid.clearAllHighlights()` for each grid that was highlighted during the tour.

10. **Orchestration: `TourSequencer` dynamically imports `three` on line 415 (`const THREE = await import('three')`).** This is unnecessary -- `three` is already a top-level dependency and should be a static import. Dynamic import adds latency on first camera animation.

## Key Insight

The most consequential gap across all three designs is the 1-based vs. 0-based coordinate mismatch. My parsers faithfully emit 1-based line/col numbers from source text. Orchestration declares them as 0-based in its `ParsedReference` typedef but never performs the conversion. The highlight system (`CodeGrid.highlightRange`) operates on 0-based indices. If this is not caught, every tour step will highlight one line below the intended target -- a silent, hard-to-diagnose off-by-one that will only become visible when someone actually runs a tour on real code. The conversion point should be explicit, singular, and placed at the resolver boundary where parsed references cross into the grid coordinate space.

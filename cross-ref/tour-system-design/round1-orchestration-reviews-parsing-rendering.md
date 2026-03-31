# Round 1: orchestration reviews parsing, rendering

## Errors Found

1. **Parsing: 1-based vs 0-based mismatch will break highlighting.** Parsing layer outputs 1-based line/col (`FileRef.line` is "1-based line number" per phase0-parsing.md line 20). The parsing doc states the resolver will convert (line 303: "convert 1-based to 0-based (`line - 1`, `col - 1`)"). But my orchestration TourAnnotator (phase0-orchestration.md lines 683-688) calls `grid.highlightRange(ref.line, ...)` directly with no conversion. The actual `highlightRange` at `src/collections/CodeGrid.js:600` is 0-based (it indexes into `_lineSlotBase` directly). The existing `highlightCommands.js` also treats all coords as 0-based (line 78 header comment: "All coordinates are 0-based"). **Resolution needed:** either parsers output 0-based and the conversion note in parsing is wrong, or orchestration's TourAnnotator must subtract 1. The correct fix is: parsers output 1-based (source-faithful, as parsing states), and the resolver/annotator converts to 0-based before calling `highlightRange`.

2. **Parsing: `parseLogLine` produces refs with `filePath: null`.** When a log line has a timestamp/level but no file reference (phase0-parsing.md lines 246-249), the parser emits a ParsedRef with `ref.filePath: null`. My TourResolver._findBySuffix at phase0-orchestration.md line 164 calls `sp.endsWith(file)` where `file` would be `null`, throwing a TypeError. Either the resolver must guard for null filePath, or the parser should not emit refs without file paths. The resolver guard is correct: skip refs where `ref.file == null`.

3. **Rendering: `entry.fromGrid`/`entry.toGrid` not stored by ConnectionRenderer.set().** The `refreshVisibility()` method at phase0-rendering.md line 367 reads `entry.fromGrid` and `entry.toGrid`, but the `set()` method at line 124 only stores `{ slot }` in the entry. The `set()` signature takes `(id, from, to, color)` as plain `{x,y,z}` points, not grid references. Either `set()` must accept grid references and store them, or `refreshVisibility()` needs a different data source.

4. **Rendering: `addUpdateRange` offset units.** At phase0-rendering.md line 253, the code does `this._posBuf.addUpdateRange(vertBase * 3, VERTS_PER_CONNECTION * 3)`. But `addUpdateRange(offset, count)` in Three.js uses **byte offsets** for `offset` and element count for `count` when using `BufferAttribute.addUpdateRange`. Actually -- Three.js r165+ uses `addUpdateRange(start, count)` where both are in **array elements** (not bytes, not vertices). `vertBase * 3` converts vertex index to float index, and `VERTS_PER_CONNECTION * 3` is the float count. This is correct. Withdrawn.

5. **Orchestration: `_findBySuffix` reads `entry.meta.sourcePath` but registry stores `sourcePath` at `entry.meta.sourcePath` via spread.** At `app/commands/index.js:57`, the `addGrid` method spreads `opts.meta` into the register call's opts, and `GitHubRepoViewer.js:981-984` registers with `{ type: 'grid', sourcePath: grid.userData.sourcePath }`. Because `register()` at `SceneRegistry.js:44` destructures as `{ type, ...meta }`, `sourcePath` lands in `entry.meta.sourcePath`. So `entry.meta.sourcePath` in the resolver (phase0-orchestration.md line 163) is correct. However, the highlight commands at `highlightCommands.js:59-66` use `grids[i].userData?.sourcePath` -- a completely different property on the grid object itself. Both paths work because `grid.userData.sourcePath` is set by the viewer at load time (GitHubRepoViewer.js:1108) and `entry.meta.sourcePath` is set at registration time. But they could diverge if one is updated without the other. The resolver should prefer `entry.meta.sourcePath` (registry is the source of truth per the architecture decision documented in commands/index.js lines 17-18).

## Gaps

- **Parsing covers format diversity; orchestration does not.** Parsing handles JS/Python/Go/Java stack traces, log lines, and file references. My orchestration design only sketched `logParser.js`, `stackTraceParser.js`, and `jsonParser.js` (phase0-orchestration.md lines 632-635) without implementation, while parsing delivered all four parsers with working code. Good -- the parsing implementations are ready to integrate.

- **Rendering covers frustum visibility; orchestration ignores it.** My TourConnector (phase0-orchestration.md line 771) creates individual `THREE.Line` objects per connection with no frustum awareness. Rendering's ConnectionRenderer (phase0-rendering.md) pre-allocates a single geometry and handles visibility toggling when grids leave the scene graph. The rendering approach is strictly better.

- **Neither parsing nor rendering addresses highlight cleanup on step transition.** When the tour moves from step N to step N+1, glyph highlights from step N must be cleared. My orchestration TourAnnotator._teardownStep calls `remove(step.annotations)` but that only removes label grids, not glyph highlights. The annotator has no tracking of which grids were highlighted or which slots were written. The rendering layer does not address this either -- it only covers connection lines.

- **Rendering's anchor system (leading/trailing) is unspecified by orchestration.** Rendering references `resolveAnchor(bounds, 'trailing')` at line 320 but neither defines the function nor specifies which edge of a grid connections should attach to. Orchestration's TourConnector just uses `bounds.center` (phase0-orchestration.md line 799).

## Tensions

1. **File placement: `src/parsing/` vs `src/services/tour/parsers/`.** Parsing places files at `src/parsing/` (phase0-parsing.md line 3). Orchestration places them at `src/services/tour/parsers/` (phase0-orchestration.md line 632). **Parsing is correct:** parsers are pure functions with no DOM/Three.js deps, reusable beyond tours. They should not be nested under a tour-specific directory. `src/parsing/` is the right location.

2. **Connection implementation: per-step `THREE.Line` objects vs single shared `LineSegments` geometry.** Orchestration's TourConnector (phase0-orchestration.md lines 771-861) creates individual `THREE.Line` objects per connection pair. Rendering's ConnectionRenderer (phase0-rendering.md) uses a pre-allocated `THREE.LineSegments` buffer with slot allocation. **Rendering is correct:** single draw call, partial GPU upload via `addUpdateRange`, O(1) visibility toggle. The orchestration connector should be replaced by rendering's ConnectionRenderer. Individual Line objects would produce N draw calls and N geometry allocations.

3. **Color format:** Rendering uses `{r, g, b}` (0-1 range) consistently. Orchestration's annotator uses `{r, g, b}` preset objects. Parsing has no color concept (correct -- parsers should not know about rendering). No real conflict here, just confirming alignment.

4. **Data type naming: `ParsedReference` vs `ParsedRef`, `FileRef` separate.** Orchestration defines `ParsedReference` as the boundary type (phase0-orchestration.md line 36) with `file`, `line`, `col`, etc. Parsing defines `FileRef` + `ParsedRef` as two separate types (phase0-parsing.md lines 16-28), where `ParsedRef.ref` is a `FileRef`. **Parsing's two-level structure is better:** it separates the location (`FileRef`) from the parse metadata (`kind`, `rawText`, `meta`). Orchestration should adopt parsing's types and adapt the resolver to accept `FileRef` rather than a flat `ParsedReference`.

## Recommendations

1. **Add 1-to-0-based conversion in TourAnnotator.apply().** Before calling `highlightRange`, convert: `const line0 = ref.line != null ? ref.line - 1 : null`. Or better: do it once in the resolver so all downstream code works in 0-based.

2. **Replace TourConnector with rendering's ConnectionRenderer.** Instantiate `ConnectionRenderer` once on the command context (`ctx.connectionRenderer`), drive it from TourSequencer via `set()`/`remove()`/`clear()`. Delete the TourConnector class entirely.

3. **Place parsers at `src/parsing/`, not `src/services/tour/parsers/`.** They are pure, reusable, worker-safe. The tour system imports them; it does not own them.

4. **Adopt parsing's two-level type system (`FileRef` + `ParsedRef`).** Update TourResolver to accept `FileRef` as input. The resolver maps `FileRef` to `ResolvedReference`. TourSequencer maps `ParsedRef[]` -> `FileRef[]` -> `ResolvedReference[]`.

5. **Add per-step highlight tracking to TourAnnotator.** When applying highlights, record `{ grid, startLine, startCol, endLine, endCol }` tuples. On teardown, call `grid.highlightRange(...)` with a null/zero color or call `grid.clearLineHighlight(line)` for each affected line.

6. **Guard resolver against null filePath.** In `_findBySuffix` and `_findByBasename`, return null early if `file == null`.

7. **Store grid references in ConnectionRenderer entries.** Extend `set()` to accept optional `fromGrid`/`toGrid` references so `refreshVisibility()` can check `grid.parent !== null`.

8. **Add `refreshVisibility()` to the animate loop.** After `virtualizer.update()`, call `connectionRenderer.refreshVisibility()`. Document this integration point.

9. **Add anchor resolution for connection endpoints.** Define `resolveAnchor(bounds, position)` where position is `'leading'|'trailing'|'top'|'bottom'|'center'`. Connections from a source grid's trailing edge to a target grid's leading edge read better than center-to-center.

10. **Expose `parseAuto` as the default entry point for tour.load.** When the command receives raw text (not JSON), run `parseAuto()` to extract refs, then wrap them in a single-step tour. This bridges the parsing layer directly into the command system.

## Key Insight

The 1-based/0-based coordinate mismatch between the parsing layer and the rendering API is the single highest-risk integration bug. Parsing correctly preserves source-faithful 1-based coordinates; `CodeGrid.highlightRange()` operates on 0-based slot indices. The conversion must happen exactly once, in exactly one place -- the resolver or annotator -- and every consumer of resolved references must use the converted values. If this is not locked down before implementation, every tour step will highlight the wrong line, and the bug will appear to be in whichever layer the developer looks at last.

# Round 3: orchestration convergence

## Settled

All three agents reached unanimous agreement on every substantive point. Round 2 was correctly skipped. Here is the definitive list of settled decisions.

1. **Parsers live at `src/parsing/`, not `src/services/tour/parsers/`.** Parsers are pure functions with zero DOM/Three.js dependencies. They are reusable beyond tours (diff views, error panels, search). Nesting them under a tour-specific directory would create a false ownership boundary. All three agents agreed.

2. **Parsers output 1-based coordinates; the resolver converts to 0-based exactly once.** Parsers preserve source-faithful line/col numbers (1-based). `CodeGrid.highlightRange()` expects 0-based. The conversion happens in `TourResolver.resolve()` by subtracting 1 from `line`, `col`, `endLine`, `endCol` on the returned `ResolvedReference`. The orchestration `ParsedReference` typedef was wrong to say "0-based" -- the actual data flowing through the pipeline is 1-based until the resolver boundary.

3. **ConnectionRenderer replaces TourConnector entirely.** The rendering agent's `ConnectionRenderer` (single `THREE.LineSegments` geometry, pre-allocated typed arrays, slot pooling, `addUpdateRange` partial uploads, arrowheads, 1 draw call) is architecturally correct. The orchestration `TourConnector` (per-connection `THREE.Line` objects, N draw calls, no arrowheads, no frustum awareness) is wrong for this codebase. `TourConnector` is deleted and replaced by a thin wrapper that delegates to `ConnectionRenderer`.

4. **ConnectionRenderer lives at `src/annotations/ConnectionRenderer.js`.** New `src/annotations/` directory, peer of `src/collections/`. Exported from `src/index.js` and `package.json` exports map. It is a reusable GPU primitive with no tour-specific knowledge.

5. **`clearAllHighlights()` is broken and must be fixed.** The current implementation at `CodeGrid.js:633-640` reads `instanceAddedColor`, which was removed in favor of the RGBA8 DataTexture highlight system. The method silently does nothing. Fix: iterate the grid's buffer slot range and call `renderer.setGlyphHighlight(slot, null)` per slot, matching the pattern in `clearLineHighlight()`.

6. **`await import('three')` in TourSequencer is replaced with a static import.** Dynamic import in an animation-path method adds unnecessary microtask latency. `three` is already available as a static dependency.

7. **Adopt parsing's two-level type system: `FileRef` + `ParsedRef`.** `FileRef` holds the location (filePath, line, col, endLine, endCol). `ParsedRef` wraps it with metadata (kind, rawText, sourceLineIndex, meta). The resolver accepts `FileRef` and maps it to `ResolvedReference`. This is cleaner than orchestration's flat `ParsedReference`.

8. **`ConnectionRenderer.set()` must store `fromGrid`/`toGrid` references and `from`/`to` coordinates.** The `refreshVisibility()` method needs grid references to check `grid.parent !== null` for frustum-aware hide/show. The `set()` signature expands to accept optional grid references.

9. **`refreshVisibility()` is wired into the animate loop after `virtualizer.update()`.** Without this, connections to off-screen grids leave orphan line segments pointing at stale world-space positions.

10. **Per-step highlight tracking for teardown.** The `TourAnnotator` must record which grid slots were highlighted during `apply()` so that `remove()` can call `clearLineHighlight()` on exactly those lines. The current `remove()` only handles label grids, not glyph highlights.

11. **Null filePath guard in resolver.** `parseLogLine` can emit refs with `filePath: null` (timestamp/level-only lines). The resolver must return `matchType: 'none'` early for null file paths, not pass null to `String.endsWith()`.

12. **Anchor resolution for connection endpoints.** Connections should attach to grid edges (trailing edge of source, leading edge of target), not center-to-center. A small `resolveAnchor(bounds, 'leading'|'trailing')` utility produces the attachment point.

---

## Implementation Plan

### File creation (5 new files)

#### 1. `src/annotations/ConnectionRenderer.js`
Use rendering agent's Phase 0 code nearly verbatim. Modifications:
- Expand `set()` signature: `set(id, from, to, color, { fromGrid, toGrid } = {})`
- Store `{ slot, from, to, color, fromGrid, toGrid, visible: true }` in the entry map
- Add `refreshVisibility()` method from rendering Phase 0 lines 364-379
- Add `setColor(id, color)` convenience method that reads `from`/`to` from the stored entry and re-calls `_writeSlot`

```js
set(id, from, to, color, { fromGrid, toGrid } = {}) {
    let entry = this._connections.get(id);
    if (!entry) {
        const slot = this._slotFree.pop();
        if (slot === undefined) { /* warn, return */ }
        entry = { slot, from, to, color, fromGrid, toGrid, visible: true };
        this._connections.set(id, entry);
    } else {
        Object.assign(entry, { from, to, color, fromGrid, toGrid });
    }
    this._writeSlot(entry.slot, from, to, color);
    this._refreshDrawRange();
    return id;
}
```

#### 2. `src/annotations/index.js`
Barrel export:
```js
export { default as ConnectionRenderer } from './ConnectionRenderer.js';
```

#### 3. `src/parsing/` directory (4 files from parsing Phase 0)
- `src/parsing/parseFileRef.js` -- verbatim from parsing Phase 0 Section 2
- `src/parsing/parseStackTrace.js` -- verbatim from parsing Phase 0 Section 3
- `src/parsing/parseLogLine.js` -- verbatim from parsing Phase 0 Section 4
- `src/parsing/parseAuto.js` -- verbatim from parsing Phase 0 Section 5
- `src/parsing/index.js` -- barrel export of all four

#### 4. `src/services/tour/TourResolver.js`
Based on orchestration Phase 0 with these changes:
- Accept `FileRef` (from parsing's type system), not flat `ParsedReference`
- `resolve()` subtracts 1 from line/col/endLine/endCol before returning `ResolvedReference`
- Guard against `file == null` at the top of `resolve()`
- Prefer `entry.id` as the primary key in `_findBySuffix` fallback chain

```js
resolve(fileRef) {
    if (!fileRef.filePath) {
        return { ref: fileRef, grid: null, registryId: null, confidence: 0, matchType: 'none' };
    }

    // ... exact, suffix, basename matching (same logic as Phase 0) ...

    // On the returned ResolvedReference, convert 1-based to 0-based:
    const resolved = { ref: fileRef, grid, registryId, confidence, matchType };
    // Store converted coordinates alongside:
    resolved.line0 = fileRef.line != null ? fileRef.line - 1 : null;
    resolved.col0 = fileRef.col != null ? fileRef.col - 1 : null;
    resolved.endLine0 = fileRef.endLine != null ? fileRef.endLine - 1 : null;
    resolved.endCol0 = fileRef.endCol != null ? fileRef.endCol - 1 : null;
    return resolved;
}
```

#### 5. `src/services/tour/TourAnnotator.js`
Based on orchestration Phase 0 with these changes:
- Use `resolved.line0`, `resolved.col0`, etc. (already 0-based from resolver)
- Track highlighted ranges per step for teardown: `this._highlightedSlots = new Map()` mapping `stepId -> [{ grid, line }]`
- `remove()` iterates tracked highlights and calls `grid.clearLineHighlight(line)` per affected line
- `_highlightToken` checks `grid.getLineCount()` before accessing `grid.lines`

#### 6. `src/services/tour/TourSequencer.js`
Based on orchestration Phase 0 with these changes:
- Static `import * as THREE from 'three'` at the top (no dynamic import)
- Replace `this._connector = new TourConnector(ctx)` with `this._connectionRenderer = ctx.connectionRenderer` (expect it on ctx)
- `_teardownStep` calls `this._annotator.remove(step)` which now clears highlights
- Connection apply/remove delegates to `this._connectionRenderer.set()`/`.remove()`

#### 7. `app/commands/handlers/tourCommands.js`
Based on orchestration Phase 0 with these changes:
- `getSequencer(ctx)` also ensures `ctx.connectionRenderer` exists (lazy init `new ConnectionRenderer(ctx.scene)`)
- Add `tour.load.text` command that runs `parseAuto(text)` and wraps the result in a single-step TourData
- Bridge `ParsedRef` to resolver input: extract `ref.ref` (the `FileRef`) for each `ParsedRef`

### File modifications (3 existing files)

#### 8. `src/collections/CodeGrid.js` -- fix `clearAllHighlights()`
Replace lines 633-640:

```js
clearAllHighlights() {
    const renderer = this._collection?.getRenderer();
    if (!renderer || !this._lineSlotBase) return;
    const lineCount = this.getLineCount();
    for (let line = 0; line < lineCount; line++) {
        this.clearLineHighlight(line);
    }
}
```

This delegates to the existing, working `clearLineHighlight()` which correctly uses `setGlyphHighlight(slot, null)` on the DataTexture.

#### 9. `src/index.js` -- add annotations export
Add after the semantic exports block:

```js
// Annotations (connection lines, tour overlays)
export { ConnectionRenderer } from './annotations/index.js';
```

#### 10. `app/commands/handlers/index.js` -- register tour commands
Add import and registration call:

```js
import registerTourCommands from './tourCommands.js';
// ... in registerAllCommands():
registerTourCommands(router);
```

### Files NOT created (explicitly excluded)

- `src/services/tour/TourConnector.js` -- deleted from plan. All connection logic delegates to `ConnectionRenderer`.
- `src/services/tour/parsers/` -- parsers live at `src/parsing/`, not under tour.

### Utility addition

#### `resolveAnchor(bounds, position)` -- small utility, place in `app/commands/handlers/spatialHelpers.js`

```js
export function resolveAnchor(bounds, position = 'center') {
    if (!bounds) return null;
    switch (position) {
        case 'leading':  return { x: bounds.min.x, y: (bounds.min.y + bounds.max.y) / 2, z: (bounds.min.z + bounds.max.z) / 2 };
        case 'trailing': return { x: bounds.max.x, y: (bounds.min.y + bounds.max.y) / 2, z: (bounds.min.z + bounds.max.z) / 2 };
        case 'top':      return { x: (bounds.min.x + bounds.max.x) / 2, y: bounds.max.y, z: (bounds.min.z + bounds.max.z) / 2 };
        case 'bottom':   return { x: (bounds.min.x + bounds.max.x) / 2, y: bounds.min.y, z: (bounds.min.z + bounds.max.z) / 2 };
        default:         return bounds.center || { x: (bounds.min.x + bounds.max.x) / 2, y: (bounds.min.y + bounds.max.y) / 2, z: (bounds.min.z + bounds.max.z) / 2 };
    }
}
```

### `package.json` exports map addition

```json
"./annotations": "./src/annotations/index.js",
"./parsing": "./src/parsing/index.js"
```

### Integration wiring (in application animate loop)

In `app/GitHubRepoViewer.js` or wherever the animate loop runs, after `virtualizer.update()`:

```js
if (this._connectionRenderer) {
    this._connectionRenderer.refreshVisibility();
}
```

---

## Summary of all files

| Action | Path | Source |
|--------|------|--------|
| Create | `src/annotations/ConnectionRenderer.js` | Rendering Phase 0 + grid ref storage |
| Create | `src/annotations/index.js` | Barrel |
| Create | `src/parsing/parseFileRef.js` | Parsing Phase 0 verbatim |
| Create | `src/parsing/parseStackTrace.js` | Parsing Phase 0 verbatim |
| Create | `src/parsing/parseLogLine.js` | Parsing Phase 0 verbatim |
| Create | `src/parsing/parseAuto.js` | Parsing Phase 0 verbatim |
| Create | `src/parsing/index.js` | Barrel |
| Create | `src/services/tour/TourResolver.js` | Orchestration Phase 0 + 1-to-0 conversion + null guard |
| Create | `src/services/tour/TourAnnotator.js` | Orchestration Phase 0 + highlight tracking + 0-based coords |
| Create | `src/services/tour/TourSequencer.js` | Orchestration Phase 0 + static THREE import + ConnectionRenderer delegation |
| Create | `app/commands/handlers/tourCommands.js` | Orchestration Phase 0 + lazy ConnectionRenderer init + parseAuto bridge |
| Modify | `src/collections/CodeGrid.js` | Fix `clearAllHighlights()` |
| Modify | `src/index.js` | Add annotations + parsing exports |
| Modify | `app/commands/handlers/index.js` | Register tour commands |
| Modify | `app/commands/handlers/spatialHelpers.js` | Add `resolveAnchor()` |
| Modify | `package.json` | Add exports map entries |

---

## Implementer Vote

**Rendering agent.**

The rendering agent's Phase 0 code (`ConnectionRenderer`) is the most implementation-ready artifact across all three designs -- it is nearly copy-paste-ready with only the `set()` signature expansion and `refreshVisibility()` method needing integration. The rendering agent also demonstrated the strongest understanding of the existing GPU pipeline (`addUpdateRange`, DataTexture highlights, `clearAllHighlights` bug, `instanceAddedColor` removal). The most delicate implementation work is: (a) writing `ConnectionRenderer` correctly with partial buffer uploads, (b) fixing `clearAllHighlights()` against the DataTexture system, and (c) wiring `refreshVisibility()` into the animate loop. All three of these are rendering-layer concerns where the rendering agent has proven expertise.

The parsing files are verbatim from the parsing agent's Phase 0 -- no design decisions remain, just file creation. The orchestration files (resolver, annotator, sequencer, commands) are straightforward adaptations of my own Phase 0 sketches with the corrections identified in Round 1. The rendering agent can execute those adaptations because the corrections are fully specified above. The critical risk is in the GPU-facing code, and that is the rendering agent's strength.

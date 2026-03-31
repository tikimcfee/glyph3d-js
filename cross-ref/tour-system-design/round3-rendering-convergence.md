# Round 3: rendering convergence

## Settled

All three agents reached agreement on every material point in Round 1. No Round 2
was needed. The settled positions follow.

1. **`ConnectionRenderer` at `src/annotations/ConnectionRenderer.js` is the canonical
   line-drawing implementation.** All three agents agreed: single `THREE.LineSegments`
   geometry, pre-allocated `Float32Array` buffers, slot-based allocation, `addUpdateRange`
   partial GPU upload, shaft + 2-segment arrowhead per connection, 1 draw call total.
   Rationale: matches the library's existing single-draw-call, pre-allocated-buffer
   philosophy throughout `GlyphRenderer`. Per-connection `THREE.Line` objects
   (orchestration's original `TourConnector._createLine`) are explicitly rejected.

2. **`TourConnector` is replaced by a thin wrapper around `ConnectionRenderer`.** The
   `TourConnector` class is not worth keeping as a separate class. The orchestration
   layer holds `ctx.connectionRenderer` (one `ConnectionRenderer` instance) and calls
   `set()`/`remove()`/`clear()` on it directly from the step apply/teardown path.
   The orchestration doc's `TourConnector._createLine()` is deleted.

3. **File layout: `src/annotations/` is a new first-class directory, peer of
   `src/collections/`.** `ConnectionRenderer.js` lives there with a barrel
   `src/annotations/index.js`. The tour command handlers live in
   `app/commands/handlers/tourCommands.js` at the app layer and import from
   `src/annotations/`. Parsers live at `src/parsing/`, not inside any tour subdirectory.

4. **Coordinate conversion: parsers output 1-based, resolver converts to 0-based.**
   All three agents flagged this as the highest-risk bug. Parsers faithfully emit
   source-line numbers starting at 1. The resolver subtracts 1 from `line`, `col`,
   `endLine`, `endCol` before populating `ResolvedReference`. `TourAnnotator.apply()`
   receives 0-based values and passes them directly to `CodeGrid.highlightRange()`.
   No other layer touches the conversion. The orchestration typedef for `ParsedReference`
   must document "1-based, as emitted by parsers"; the resolver's output type
   `ResolvedReference` documents "0-based, ready for grid API".

5. **`clearAllHighlights()` in `CodeGrid` is broken and must be fixed.** The method
   targets `instanceAddedColor`, a buffer attribute removed when highlights moved to the
   RGBA8 DataTexture (`_highlightTexture`). The fix: iterate the grid's buffer slot range
   and call `renderer.setGlyphHighlight(slot, null)` for each slot, exactly as
   `clearLineHighlight()` already does. This is the only method that tour teardown can
   call to fully reset a grid's highlight state.

6. **`set()` must store `fromGrid`/`toGrid` references in the connection entry.**
   The orchestration doc identified this gap in the rendering design: `refreshVisibility()`
   reads `entry.fromGrid` and `entry.toGrid`, but the `set()` signature only accepted
   `{x,y,z}` points and stored `{ slot }`. The fix: extend `set()` to accept optional
   grid references and store them. `refreshVisibility()` checks `grid.parent !== null`
   as the off-screen test.

7. **`refreshVisibility()` is called from the animate loop after `virtualizer.update()`.**
   All agents agreed. The application's render loop calls
   `ctx.connectionRenderer.refreshVisibility()` immediately after the virtualizer pass.
   When either endpoint grid is off-screen (`parent === null`), the connection slot is
   zeroed (degenerate — GPU submits no visible primitive). When the grid returns to
   screen, `_writeSlot` restores the last-known `from`/`to`/`color` values. The entry
   must therefore also cache `from`, `to`, `color` for this restore path.

8. **`TourAnnotator` must track which grids were highlighted per step.** On teardown,
   the annotator must clear highlights it applied — not just remove label grids. The
   tracking structure per applied step: `{ grid, startLine, startCol, endLine, endCol }`.
   Teardown calls `grid.clearLineHighlight(line)` for each affected line, or calls the
   fixed `clearAllHighlights()` if the whole grid was tinted.

9. **Static import of Three.js in `TourSequencer`.** `await import('three')` inside
   `_animateToStep()` is replaced with a static `import * as THREE from 'three'` at the
   top of the file. Dynamic import adds unnecessary async overhead in a timing-sensitive
   camera animation path; Three.js is already in the module graph.

10. **`ConnectionRenderer` is exported from `src/index.js` and optionally as
    `glyph3d-js/annotations` in `package.json`.** It is a general-purpose GPU primitive
    reusable beyond tours (call graphs, diff annotations). It is not tour-specific.

11. **`addUpdateRange` units are array element indices (floats), not bytes.**
    `vertBase * 3` converts vertex index to float index; `VERTS_PER_CONNECTION * 3` is
    float count. This matches the existing usage pattern in `GlyphRenderer.js` line 566.
    The rendering design's usage is confirmed correct.

12. **`setDrawRange` comment corrected.** The introductory comment in the rendering doc
    that said `activeSegments * 2` is misleading. The correct description is
    `activeConnections * VERTS_PER_CONNECTION`. The implementation already uses the
    correct value; only the comment needs updating in the source file.

13. **Resolver guards against null `filePath`.** `_findBySuffix` and `_findByBasename`
    return null early if `file == null`. This covers the case where `parseLogLine`
    produces a ref with no file reference (timestamp/level only).

14. **`parseAuto` is the default entry point for `tour.load`.** When the command receives
    raw text (not JSON), it calls `parseAuto()` from `src/parsing/` to extract refs, then
    wraps them in a single-step tour. This is the bridge between the parsing layer and the
    command system.

15. **Anchor resolution for connection endpoints.** `resolveAnchor(bounds, position)` is
    a standalone utility (not a method on `ConnectionRenderer`) that maps a named position
    (`'leading'|'trailing'|'top'|'bottom'|'center'`) to a world-space `{x,y,z}` point
    given a bounding box. Connections from source trailing edge to target leading edge read
    better than center-to-center for showing flow direction.

---

## Implementation Plan

### Files to create

**`src/annotations/ConnectionRenderer.js`**

Implement the class as specified in phase0-rendering.md Section 2, with these additions
beyond that spec:

- `set(id, from, to, color, fromGrid = null, toGrid = null)` — store `fromGrid`, `toGrid`,
  `from`, `to`, `color` in the entry alongside `slot` and `visible`. The entry shape:
  ```js
  { slot, from, to, color, fromGrid, toGrid, visible: true }
  ```
- `setColor(id, color)` — update only color without recomputing geometry. Read existing
  `from`/`to` from the entry, call `_writeSlot(entry.slot, entry.from, entry.to, color)`.
  This was called out in parsing's Round 1 review (rec 5) as missing from the API.
- `refreshVisibility()` — as specified in phase0-rendering.md Section 4. Uses cached
  `entry.from`/`entry.to`/`entry.color` to restore on re-appear. Removes the `changed`
  flag dead code — just always upload when visibility toggles (the cost is negligible at
  ≤256 connections).
- `updatePosition(id, from, to)` — as in the phase0 spec. Read color from `entry.color`
  rather than from the buffer (entry cache is the source of truth after this change).
- Comment fix: `setDrawRange` introductory comment says
  `activeConnections * VERTS_PER_CONNECTION`.

**`src/annotations/index.js`**

```js
export { default as ConnectionRenderer } from './ConnectionRenderer.js';
export { resolveAnchor, getWorldBounds } from './anchorUtils.js';
```

**`src/annotations/anchorUtils.js`**

Pure utility, no Three.js dependency on the class import path (uses only math):

```js
/**
 * @param {{ min: {x,y,z}, max: {x,y,z}, center: {x,y,z} }} bounds
 * @param {'leading'|'trailing'|'top'|'bottom'|'center'} position
 * @returns {{ x, y, z }}
 */
export function resolveAnchor(bounds, position) { ... }

/**
 * Compute axis-aligned world bounds for a CodeGrid (uses grid.matrixWorld
 * and grid.collection geometry bounding box).
 * @param {import('../collections/CodeGrid.js').default} grid
 * @returns {{ min, max, center }}
 */
export function getWorldBounds(grid) { ... }
```

`resolveAnchor('leading')` → min-X face center; `'trailing'` → max-X face center;
`'top'` → max-Y face center; `'bottom'` → min-Y; `'center'` → center. The X-axis
convention (leading/trailing) matches the reading direction of rendered code grids
(left-to-right, so trailing = right edge).

**`src/parsing/index.js`** (barrel for parsing layer)

```js
export { parseFileRef }    from './fileRefParser.js';
export { parseStackTrace } from './stackTraceParser.js';
export { parseLogLine }    from './logLineParser.js';
export { parseAuto }       from './autoParser.js';
export { convertToZeroBased } from './coordUtils.js';
```

**`src/parsing/coordUtils.js`**

```js
/**
 * Convert a ParsedRef's 1-based line/col to 0-based for grid APIs.
 * Returns a new object; does not mutate.
 * @param {{ line?: number, col?: number, endLine?: number, endCol?: number }} ref
 * @returns {object}
 */
export function convertToZeroBased(ref) {
    return {
        ...ref,
        line:    ref.line    != null ? ref.line    - 1 : null,
        col:     ref.col     != null ? ref.col     - 1 : null,
        endLine: ref.endLine != null ? ref.endLine - 1 : null,
        endCol:  ref.endCol  != null ? ref.endCol  - 1 : null,
    };
}
```

**`app/commands/handlers/tourCommands.js`**

New app-layer file. Owns:
- `ctx.connectionRenderer` lifecycle (instantiated once per command context init,
  disposed on context teardown)
- `tour.load` command: receives raw text or JSON, calls `parseAuto()`, wraps into
  `TourData`, calls `TourSequencer.load()`
- `tour.goto`, `tour.next`, `tour.prev`, `tour.clear` forwarding to sequencer
- Imports `ConnectionRenderer` from `src/annotations/`, imports parsers from
  `src/parsing/`, imports `TourSequencer` from `src/services/tour/TourSequencer.js`

Static import at top:
```js
import * as THREE from 'three';
import ConnectionRenderer from '../../../src/annotations/ConnectionRenderer.js';
import { parseAuto } from '../../../src/parsing/index.js';
import TourSequencer from '../../../src/services/tour/TourSequencer.js';
```

### Files to modify

**`src/collections/CodeGrid.js` — fix `clearAllHighlights()`**

Current broken implementation (line 633-640):
```js
clearAllHighlights() {
    const attr = renderer.instanceMesh.geometry.attributes.instanceAddedColor;
    if (!attr) return;   // exits here, always
    ...
}
```

Replacement — iterate grid's slot range, call `setGlyphHighlight(slot, null)` for each:
```js
clearAllHighlights() {
    const renderer = this.collection?._renderer;
    if (!renderer) return;
    const meta = renderer._renderedTexts?.get(this._textId);
    if (!meta) return;
    const { startIdx, glyphs } = meta;
    for (let i = 0; i < glyphs.length; i++) {
        renderer.setGlyphHighlight(startIdx + i, null);
    }
}
```

The exact field names (`_renderedTexts`, `startIdx`, `glyphs`) must be verified against
the current `GlyphRenderer.js` internal structure before writing. The pattern mirrors
`clearLineHighlight()` which already does per-slot `setGlyphHighlight` calls — use that
as the reference.

**`src/services/tour/TourResolver.js`**

- `_findBySuffix` and `_findByBasename`: add guard at entry — `if (!file) return null;`
- After resolving a match, apply coordinate conversion:
  ```js
  const resolved = {
      grid,
      file:    matchedEntry.id,
      line:    ref.line    != null ? ref.line    - 1 : null,
      col:     ref.col     != null ? ref.col     - 1 : null,
      endLine: ref.endLine != null ? ref.endLine - 1 : null,
      endCol:  ref.endCol  != null ? ref.endCol  - 1 : null,
  };
  ```
  This is the single coordinate-conversion point. All downstream code (annotator,
  sequencer) operates in 0-based.

**`src/services/tour/TourAnnotator.js`**

- Remove any remaining coordinate adjustment — conversion now happens in resolver.
- Add per-step highlight tracking:
  ```js
  // In apply():
  this._appliedHighlights.push({ grid, startLine, startCol, endLine, endCol });
  // In teardown():
  for (const h of this._appliedHighlights) {
      h.grid.clearLineHighlight(h.startLine);  // or loop lines, or clearAllHighlights()
  }
  this._appliedHighlights = [];
  ```
- Remove `TourConnector` import and usage. Replace with `ctx.connectionRenderer.set(...)`.
- `_highlightToken`: access grid line content via `grid.lines[i]` with a guard:
  `if (!grid.lines?.length) return;` (lines is populated by `loadText()`/`loadTextAsync()`).

**`src/services/tour/TourSequencer.js`**

- Replace `await import('three')` with `import * as THREE from 'three'` at file top.
- Accept `ctx.connectionRenderer` instead of creating or importing `TourConnector`.

**`src/index.js`**

- Add: `export { ConnectionRenderer } from './annotations/index.js';`

**`package.json`** (exports map)

- Add: `"glyph3d-js/annotations": "./src/annotations/index.js"`

**Application animate loop** (wherever `virtualizer.update()` is called — likely
`app/GitHubRepoViewer.js` or the IDE shell render loop)

- After `virtualizer.update()`, add: `ctx.connectionRenderer?.refreshVisibility();`

### Files to delete

- `src/services/tour/TourConnector.js` — entirely replaced by `ConnectionRenderer` + thin
  glue in `tourCommands.js`. Do not keep it as a facade; it would cause confusion about
  which class owns draw calls.

### No changes needed

- `src/shaders/` — no shader modifications required for connections (they use their own
  `LineBasicMaterial`, not the glyph shaders)
- `GlyphRenderer.js` — highlight DataTexture already correct; `setGlyphHighlight(slot, null)`
  already zeroes the texel. No changes needed beyond the CodeGrid fix above.
- `WorkerBridge.js` — tour system is main-thread only (no worker path needed for connections)
- Buffer builders — no changes; they have no connection-related logic

### Verification sequence

1. `npm run serve` then open `http://localhost:8000/examples/picking-test/` — confirm
   highlights still work on existing picking test (CodeGrid highlight path untouched).
2. Open the GitHub viewer, trigger a tour.load command with a raw file path string.
   Confirm: connection line appears between two visible grids, arrowhead points toward
   target, highlight appears on correct line (not off-by-one).
3. Pan camera to move one endpoint grid off-screen. Confirm: connection line disappears.
   Pan back. Confirm: line reappears at same position.
4. Clear the tour. Confirm: connection lines removed, glyph highlights cleared (no stale
   color remains on previously-highlighted grid).
5. Check browser devtools Performance tab: confirm single draw call for connection lines
   (look for one `drawArrays` with `mode=LINES`), not N separate draw calls.

---

## Implementer Vote

**Vote: orchestration agent.**

Rationale: the implementation work is predominantly orchestration — wiring
`TourSequencer`, `TourAnnotator`, `TourResolver`, and `tourCommands.js` together with
the correct data flow. The rendering contribution (`ConnectionRenderer.js`) is already
fully specified and nearly complete as written code in phase0-rendering.md; it needs
only the three additions (grid refs in entry, `setColor()`, entry caching) plus the
coordinate comment fix. An orchestration-perspective implementer is better positioned
to:

- Write the `tourCommands.js` app-layer file that wires context lifecycle
- Correctly thread the resolver's 0-based output through annotator and sequencer
- Implement the per-step highlight tracking structure in `TourAnnotator`
- Verify that the `TourSequencer` camera animation path works with static THREE import

The rendering phase0 code can be dropped in as-is (with the three small additions noted
above) by anyone; it does not require deep rendering domain knowledge to complete. The
orchestration layer integration is where the risk is concentrated.

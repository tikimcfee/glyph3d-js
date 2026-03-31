# Round 3: parsing convergence

## Settled

All three agents converged on every substantive point in Round 1, with zero disagreements requiring Round 2. The following items are fully resolved:

1. **Parsers output 1-based coordinates; conversion happens once in the resolver.** All three agents independently flagged the 1-based (parsing) vs 0-based (orchestration typedef + CodeGrid API) mismatch as the highest-risk integration bug. All three agree: parsers are correct to emit source-faithful 1-based values; the resolver subtracts 1 before populating `ResolvedReference`. The orchestration `ParsedReference` typedef comment must be updated to say 1-based, matching parsing's output. (parsing R1 tension #3; rendering R1 tension T1; orchestration R1 error #1)

2. **`ConnectionRenderer` replaces `TourConnector._createLine()`.** All three agents agree the rendering agent's single-geometry `ConnectionRenderer` is architecturally correct, and orchestration's per-connection `THREE.Line` objects must be deleted. `TourConnector` becomes a thin wrapper that holds a `ConnectionRenderer` reference and delegates to `set()`/`remove()`/`clear()`. (parsing R1 tension #1; rendering R1 tension T2; orchestration R1 tension #2)

3. **`ConnectionRenderer` lives at `src/annotations/ConnectionRenderer.js`.** All three agree this is a reusable GPU primitive, not tour-specific. The tour orchestration layer imports it; it does not own it. (parsing R1 tension #2; rendering R1 tension T3; orchestration R1 tension #1)

4. **Parsers live at `src/parsing/`, not `src/services/tour/parsers/`.** All three agree parsers are pure functions with no DOM/Three.js dependencies, reusable beyond tours, and worker-safe. (orchestration R1 recommendation #3; parsing phase0 line 3)

5. **Adopt parsing's two-level type system (`FileRef` + `ParsedRef`).** Orchestration's flat `ParsedReference` is superseded by parsing's separation of location (`FileRef`) from parse metadata (`ParsedRef`). The resolver accepts `FileRef` as input. (orchestration R1 recommendation #4)

6. **`clearAllHighlights()` is broken and must be fixed.** Rendering agent identified that the current implementation checks for the removed `instanceAddedColor` attribute and silently exits. It must be rewritten to zero out the DataTexture via `renderer.setGlyphHighlight(slot, null)` per slot, matching `clearLineHighlight()`'s pattern. (rendering R1 error #1)

7. **`TourSequencer._animateToStep` must use static `import * as THREE from 'three'`.** The dynamic `await import('three')` adds unnecessary microtask overhead in a timing-sensitive animation path. (parsing R1 recommendation #10; rendering R1 error #4; orchestration R1 — not flagged but compatible)

8. **`ConnectionRenderer.set()` must store grid references for frustum visibility.** The `set()` signature needs optional `fromGrid`/`toGrid` parameters so `refreshVisibility()` can check `grid.parent !== null`. (parsing R1 error #3 in rendering; orchestration R1 recommendation #7; rendering R1 gap)

9. **`refreshVisibility()` must be called in the animate loop after `virtualizer.update()`.** Without this, connections to frustum-culled grids leave orphan line segments. (parsing R1 recommendation #3; rendering phase0 section 4; orchestration R1 recommendation #8)

10. **Resolver must guard against `null` filePath.** `parseLogLine` can emit refs with `filePath: null`. The resolver's `_findBySuffix` would throw on `sp.endsWith(null)`. Early return when `file == null`. (orchestration R1 error #2)

11. **Per-step highlight tracking is needed for teardown.** When applying highlights, the annotator must record `{ grid, startLine, startCol, endLine, endCol }` tuples so teardown can clear them. Currently `_teardownStep` only removes label grids, not glyph highlights. (orchestration R1 gap #3; rendering R1 error #1)

12. **Anchor resolution for connection endpoints.** Center-to-center connections are less readable than trailing-edge-to-leading-edge. A `resolveAnchor(bounds, 'leading'|'trailing')` utility should determine attachment points. (orchestration R1 recommendation #9; rendering phase0 section 3 references `resolveAnchor`)

13. **`parseAuto` as default entry for raw text input.** When `tour.load` receives non-JSON text, run `parseAuto()` to extract refs, then wrap them in a single-step tour. This bridges parsing directly into the command system. (orchestration R1 recommendation #10)

## Implementation Plan

### New files to create

#### 1. `src/parsing/parseFileRef.js`
Verbatim from phase0-parsing.md section 2. The four regex patterns, `looksLikeFilePath` with noise list, global regex iteration per line. No changes needed from Phase 0 design.

#### 2. `src/parsing/parseStackTrace.js`
Verbatim from phase0-parsing.md section 3. Table-driven `FRAME_MATCHERS` for JS/Python/Java/Go, depth tracking with reset on language change, Go two-line peek. No changes needed.

#### 3. `src/parsing/parseLogLine.js`
From phase0-parsing.md section 4, with one fix: when no file references are found in a log line, do NOT emit a `ParsedRef` with `filePath: null`. Instead, push the line to `unmatched`. This avoids the null-guard issue downstream entirely and is cleaner semantically (a "reference" with no file is not a reference).

```js
// Replace lines 245-249 of phase0:
// Instead of emitting { ref: { filePath: null, ... }, kind: 'log-line', ... }
// push to unmatched:
} else {
    unmatched.push(line);
}
```

Wait -- this changes the semantics. Log lines with timestamps/levels but no file refs DO carry useful metadata (level, message). The resolver should handle null filePath gracefully regardless. Keep the original design but also add the null guard in the resolver. The `parseLogLine` output is correct as designed; it surfaces structured log data even without file references.

#### 4. `src/parsing/parseAuto.js`
Verbatim from phase0-parsing.md section 5. Runs all three parsers, deduplicates by `(sourceLineIndex, filePath, line, col)`, priority order (stack > log > file-ref).

#### 5. `src/parsing/index.js`
Barrel export:
```js
export { parseFileRef } from './parseFileRef.js';
export { parseStackTrace } from './parseStackTrace.js';
export { parseLogLine } from './parseLogLine.js';
export { parseAuto } from './parseAuto.js';
```

#### 6. `src/annotations/ConnectionRenderer.js`
From phase0-rendering.md section 2, with the following modifications:

- `set()` signature becomes `set(id, from, to, color, { fromGrid, toGrid } = {})`. Store `fromGrid`, `toGrid`, `from`, `to`, `color` on the entry alongside `slot`.
- `refreshVisibility()` added exactly as in phase0-rendering.md section 4, reading `entry.fromGrid`/`entry.toGrid`/`entry.visible` and toggling via `_writeSlot`/`_zeroSlot`.
- Add `setColor(id, color)` convenience method that reads stored `from`/`to` from entry and calls `_writeSlot`.

```js
set(id, from, to, color, { fromGrid, toGrid } = {}) {
    let entry = this._connections.get(id);
    if (!entry) {
        const slot = this._slotFree.pop();
        if (slot === undefined) {
            console.warn('[ConnectionRenderer] MAX_CONNECTIONS reached, dropping:', id);
            return id;
        }
        entry = { slot, from: null, to: null, color: null, fromGrid: null, toGrid: null, visible: true };
        this._connections.set(id, entry);
    }
    entry.from = from;
    entry.to = to;
    entry.color = color;
    if (fromGrid !== undefined) entry.fromGrid = fromGrid;
    if (toGrid !== undefined) entry.toGrid = toGrid;
    this._writeSlot(entry.slot, from, to, color);
    this._refreshDrawRange();
    return id;
}

setColor(id, color) {
    const entry = this._connections.get(id);
    if (!entry) return;
    entry.color = color;
    this._writeSlot(entry.slot, entry.from, entry.to, color);
}
```

#### 7. `src/annotations/index.js`
```js
export { default as ConnectionRenderer } from './ConnectionRenderer.js';
```

#### 8. `src/services/tour/TourResolver.js`
From phase0-orchestration.md resolver section, with these changes:

- `resolve()` accepts `FileRef` (parsing's type), not `ParsedReference`.
- Add null guard at top of `resolve()` and `_findBySuffix()`: `if (!ref.filePath) return { ref, grid: null, registryId: null, confidence: 0, matchType: 'none' };`
- `resolveAll()` accepts `ParsedRef[]`, extracts `.ref` (the `FileRef`), resolves it, and returns `ResolvedReference[]` where each entry includes the original `ParsedRef`.
- The resolver does NOT convert 1-based to 0-based. That happens in the annotator at the exact point of calling `highlightRange`. Rationale: the `ResolvedReference` should preserve source-faithful coordinates for display purposes (e.g., showing "line 42" in a label). The annotator is the only consumer that needs 0-based.

Actually, reconsidering: all three agents said the resolver should convert. But the rendering agent (R1 recommendation #6) specifically said "a small adapter... should convert ParsedRef to ParsedReference... this adapter is the single coordinate-conversion point." Let me re-read.

Parsing R1: "Orchestration's typedef should either document '1-based, converted at application time' or the resolver should handle it."
Rendering R1: "resolver is cleaner because it keeps the annotator free of coordinate concerns."
Orchestration R1: "The correct fix is: parsers output 1-based, and the resolver/annotator converts to 0-based before calling highlightRange."

Consensus: convert in the resolver. The `ResolvedReference` carries 0-based coordinates. Done.

```js
resolveAll(parsedRefs) {
    return parsedRefs.map(pr => {
        const resolved = this.resolve(pr.ref);
        // Convert 1-based to 0-based at the boundary
        if (resolved.ref.line != null) resolved.ref = {
            ...resolved.ref,
            line: resolved.ref.line - 1,
            col: resolved.ref.col != null ? resolved.ref.col - 1 : null,
            endLine: resolved.ref.endLine != null ? resolved.ref.endLine - 1 : null,
            endCol: resolved.ref.endCol != null ? resolved.ref.endCol - 1 : null,
        };
        return { ...resolved, parsedRef: pr };
    });
}
```

#### 9. `src/services/tour/TourAnnotator.js`
From phase0-orchestration.md annotator sketch, with these changes:

- No coordinate conversion needed (resolver already converted to 0-based).
- Add highlight tracking: maintain a `_stepHighlights` Map (stepId -> Array of `{ grid, startLine, startCol, endLine, endCol }`) for teardown.
- `remove(stepId)` clears tracked highlights by calling `grid.clearLineHighlight(line)` for each affected line, then removes label grids.

```js
apply(step) {
    const ids = [];
    const highlights = [];

    for (const resolved of step.refs) {
        if (!resolved.grid) continue;
        const ref = resolved.ref;
        const color = COLOR_PRESETS[ref.color] || COLOR_PRESETS.blue;

        if (ref.line != null) {
            const endLine = ref.endLine ?? ref.line;
            const startCol = ref.col ?? 0;
            const endCol = ref.endCol ??
                (resolved.grid.getVisibleCharCount?.(endLine) || 80);
            resolved.grid.highlightRange(ref.line, startCol, endLine, endCol, color);
            highlights.push({ grid: resolved.grid, startLine: ref.line, endLine });
        }
        // ... token, label as before
    }

    this._stepHighlights.set(step.id, highlights);
    return ids;
}

removeHighlights(stepId) {
    const highlights = this._stepHighlights.get(stepId);
    if (!highlights) return;
    for (const { grid, startLine, endLine } of highlights) {
        for (let line = startLine; line <= endLine; line++) {
            grid.clearLineHighlight(line);
        }
    }
    this._stepHighlights.delete(stepId);
}
```

#### 10. `src/services/tour/TourSequencer.js`
From phase0-orchestration.md sequencer, with these changes:

- Static `import * as THREE from 'three'` at the top, delete the dynamic import.
- Constructor accepts `connectionRenderer` (from `ctx.connectionRenderer`) instead of creating a `TourConnector`.
- `_teardownStep` calls `this._annotator.removeHighlights(step.id)` in addition to `this._annotator.remove(step.annotations)`.
- Connection management uses `this._connectionRenderer.set()`/`remove()`/`clear()` directly instead of delegating to a `TourConnector`.
- Add `resolveAnchor(bounds, position)` utility (inline or imported) for trailing/leading edge attachment.

#### 11. `app/commands/handlers/tourCommands.js`
From phase0-orchestration.md command integration, with these changes:

- Instantiate `ConnectionRenderer` on `ctx` if not present: `if (!ctx.connectionRenderer) ctx.connectionRenderer = new ConnectionRenderer(ctx.scene);`
- Pass `ctx.connectionRenderer` to `TourSequencer` constructor.
- Add a `tour.load` path for raw text: if the input is not valid JSON after base64 decode, run `parseAuto()` and wrap the result in a single-step `TourData`.
- Wire `ctx.connectionRenderer.refreshVisibility()` into the animate loop registration (or document that the app must call it).

#### 12. `src/annotations/resolveAnchor.js`
Small utility:
```js
/**
 * Compute an attachment point on a bounding box.
 * @param {{ min: {x,y,z}, max: {x,y,z}, center: {x,y,z} }} bounds
 * @param {'leading'|'trailing'|'top'|'bottom'|'center'} position
 * @returns {{ x, y, z }}
 */
export function resolveAnchor(bounds, position = 'center') {
    const { min, max, center } = bounds;
    switch (position) {
        case 'leading':  return { x: min.x, y: center.y, z: center.z };
        case 'trailing': return { x: max.x, y: center.y, z: center.z };
        case 'top':      return { x: center.x, y: max.y, z: center.z };
        case 'bottom':   return { x: center.x, y: min.y, z: center.z };
        default:         return { ...center };
    }
}
```

### Existing files to modify

#### 13. `src/collections/CodeGrid.js` -- fix `clearAllHighlights()`
Replace the broken `instanceAddedColor` check with a DataTexture zeroing loop:

```js
clearAllHighlights() {
    const renderer = this._renderer;
    if (!renderer || !this._lineSlotBase) return;
    const totalSlots = this._totalSlots; // or derive from buffer size
    const baseSlot = this._bufferStartSlot; // first slot for this grid
    for (let i = 0; i < totalSlots; i++) {
        renderer.setGlyphHighlight(baseSlot + i, null);
    }
}
```

The exact slot range depends on how `CodeGrid` tracks its buffer allocation. This needs to iterate all slots belonging to this grid. `clearLineHighlight` already does per-line iteration via `_lineSlotBase`; `clearAllHighlights` should iterate all lines:

```js
clearAllHighlights() {
    if (!this._lineSlotBase || !this._renderer) return;
    for (let line = 0; line < this._lineSlotBase.length; line++) {
        this.clearLineHighlight(line);
    }
}
```

#### 14. `src/index.js` -- add exports
Add `ConnectionRenderer` and parsing exports:
```js
export { ConnectionRenderer } from './annotations/index.js';
export { parseFileRef, parseStackTrace, parseLogLine, parseAuto } from './parsing/index.js';
```

#### 15. `package.json` -- add export paths
Add:
```json
"./annotations": "./src/annotations/index.js",
"./parsing": "./src/parsing/index.js"
```

#### 16. `app/commands/handlers/index.js` -- register tour commands
Add `import registerTourCommands from './tourCommands.js';` and call it in the registration function.

### Files to delete

None. `TourConnector.js` was never created (it exists only in Phase 0 sketches). The implementation simply never creates it.

### Dependency graph (creation order)

Phase A (no dependencies, parallel):
- `src/parsing/parseFileRef.js`
- `src/parsing/parseStackTrace.js`
- `src/annotations/ConnectionRenderer.js`
- `src/annotations/resolveAnchor.js`
- `src/annotations/index.js`

Phase B (depends on parseFileRef):
- `src/parsing/parseLogLine.js`

Phase C (depends on all parsers):
- `src/parsing/parseAuto.js`
- `src/parsing/index.js`

Phase D (depends on ConnectionRenderer, parsers):
- `src/services/tour/TourResolver.js`
- `src/services/tour/TourAnnotator.js`

Phase E (depends on resolver, annotator, ConnectionRenderer):
- `src/services/tour/TourSequencer.js`

Phase F (depends on sequencer):
- `app/commands/handlers/tourCommands.js`

Phase G (modifications):
- `src/collections/CodeGrid.js` (fix clearAllHighlights)
- `src/index.js` (add exports)
- `package.json` (add export paths)
- `app/commands/handlers/index.js` (register tour commands)

## Implementer Vote

**orchestration** should implement.

Rationale: The parsing layer's code is ready to transcribe verbatim from Phase 0 -- no design changes are needed to the parser implementations themselves. The rendering layer's `ConnectionRenderer` is also a clean transcription with the settled modifications (grid refs in `set()`, `refreshVisibility`, `setColor`). The bulk of the implementation work is in the orchestration layer: wiring the resolver with coordinate conversion, building the annotator with highlight tracking, rewriting the sequencer to use `ConnectionRenderer` instead of `TourConnector`, fixing `clearAllHighlights`, and integrating the command handlers. The orchestration agent wrote the original sketches for these files and understands the command context (`ctx`), the registry API, the camera animation path, and the step state machine intimately. Their Phase 0 is closest to the converged plan with targeted corrections, and they are best positioned to make those corrections accurately.

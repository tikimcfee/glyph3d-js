# Tour System Implementation Summary

Implementation completed by the rendering specialist agent. All decisions from the
round3 convergence documents were applied exactly as specified.

---

## Files Created

### Parsing layer — `src/parsing/`

| File | Notes |
|------|-------|
| `src/parsing/parseFileRef.js` | Verbatim from parsing Phase 0. Four regex patterns, `looksLikeFilePath` noise filter, global regex per line. Outputs 1-based line/col. |
| `src/parsing/parseStackTrace.js` | Verbatim from parsing Phase 0. Table-driven `FRAME_MATCHERS` for JS/Python/Java/Go, depth tracking, Go two-line function peek. Outputs 1-based line. |
| `src/parsing/parseLogLine.js` | From parsing Phase 0. Emits `filePath: null` for timestamp/level-only lines (resolver guards against it). 1-based line output. |
| `src/parsing/parseAuto.js` | Verbatim from parsing Phase 0. Runs all three parsers, deduplicates by `(sourceLineIndex, filePath, line, col)`, priority: stack > log > file-ref. |
| `src/parsing/index.js` | Barrel export: `parseFileRef`, `parseStackTrace`, `parseLogLine`, `parseAuto`. |

### Annotations layer — `src/annotations/`

| File | Notes |
|------|-------|
| `src/annotations/ConnectionRenderer.js` | From rendering Phase 0 + all convergence modifications: `set(id, from, to, color, { fromGrid, toGrid } = {})` stores full entry cache; `setColor(id, color)` reads cached from/to; `updatePosition` reads color from `entry.color`; `refreshVisibility()` checks `grid.parent !== null`; comment fixed to say `activeConnections * VERTS_PER_CONNECTION`; `addUpdateRange` uses float element indices. |
| `src/annotations/index.js` | Barrel export: `ConnectionRenderer`. |

### Tour services — `src/services/tour/`

| File | Notes |
|------|-------|
| `src/services/tour/TourResolver.js` | Accepts `FileRef` input. Null filePath guard at top of `resolve()`. 1-to-0-based conversion in `_makeResolved()` — stored as `line0`, `col0`, `endLine0`, `endCol0`. `resolveAll()` accepts `ParsedRef[]` and extracts `.ref`. Null guards in `_findBySuffix` and `_findByBasename`. |
| `src/services/tour/TourAnnotator.js` | Uses 0-based coords from resolver (`resolved.line0` etc). Tracks highlighted lines per step in `_stepHighlights` Map. `removeHighlights(stepId)` clears tracked lines via `clearLineHighlight()`. Label creation via `CodeGrid` + registry. Token search guards `grid.lines?.length`. |
| `src/services/tour/TourSequencer.js` | Static `import * as THREE from 'three'` (no dynamic import). Uses `ctx.connectionRenderer` directly — no `TourConnector`. `_teardownStep` clears highlights via `annotator.removeHighlights()`, removes labels, removes connections. `_applyConnections` uses `resolveAnchor(bounds, 'trailing'/'leading')` from spatialHelpers. |

### Command handlers — `app/commands/handlers/`

| File | Notes |
|------|-------|
| `app/commands/handlers/tourCommands.js` | Lazy-init `ctx.connectionRenderer` as `new ConnectionRenderer(ctx.scene)`. `tour.load` accepts both JSON (parsed) and raw text (parseAuto fallback). `tour.load.text` explicit raw-text path. `tour.next`, `tour.prev`, `tour.goto`, `tour.clear`, `tour.status` commands. |

---

## Files Modified

| File | Change |
|------|--------|
| `src/collections/CodeGrid.js` | Fixed `clearAllHighlights()` — replaced broken `instanceAddedColor` attribute check with loop over `getLineCount()` calling `clearLineHighlight(line)` per line. Now correctly zeroes the RGBA8 DataTexture. |
| `src/index.js` | Added exports: `ConnectionRenderer` from `./annotations/index.js`; `parseFileRef`, `parseStackTrace`, `parseLogLine`, `parseAuto` from `./parsing/index.js`. |
| `package.json` | Added export map entries: `"./annotations": "./src/annotations/index.js"` and `"./parsing": "./src/parsing/index.js"`. |
| `app/commands/handlers/index.js` | Added `import registerTourCommands from './tourCommands.js'` and call `registerTourCommands(router)` in `registerAllCommands()`. |

---

## Files NOT Created (explicitly excluded by convergence docs)

- `src/services/tour/TourConnector.js` — replaced entirely by `ConnectionRenderer` + thin glue in `TourSequencer` and `tourCommands.js`.
- `src/services/tour/parsers/` — parsers live at `src/parsing/`, not under tour.
- `src/annotations/anchorUtils.js` / `src/annotations/resolveAnchor.js` — `resolveAnchor` already exists in `app/commands/handlers/spatialHelpers.js` (lines 162-189) with a richer ANCHOR_NAMES table. `TourSequencer` imports it from there.

---

## Key Integration Point: animate loop

In `app/GitHubRepoViewer.js` (or wherever the animate loop runs), after `virtualizer.update()`, add:

```js
ctx.connectionRenderer?.refreshVisibility();
```

This call is required for frustum-aware connection visibility. Without it, connections to off-screen grids leave orphan line segments. This wiring is documented here rather than added automatically because the animate loop's location is application-layer — it was not in scope for this implementation task.

---

## Coordinate Convention

- **Parsers output 1-based** line/col (source-faithful).
- **`TourResolver._makeResolved()` is the single conversion point** — converts to 0-based `line0`, `col0`, `endLine0`, `endCol0` on the `ResolvedReference`.
- **`TourAnnotator.apply()` uses 0-based** (`resolved.line0` etc) — no further conversion.
- **All other consumers** (label positioning, token search) are also 0-based by this point.

---

## `clearAllHighlights()` Fix

The old implementation:
```js
// BROKEN: instanceAddedColor was removed when highlights moved to the RGBA8 DataTexture
const attr = renderer.instanceMesh.geometry.attributes.instanceAddedColor;
if (!attr) return; // always exited here silently
```

The new implementation:
```js
// Correct: delegates to clearLineHighlight() which uses setGlyphHighlight(slot, null)
clearAllHighlights() {
    if (!this._lineSlotBase) return;
    const lineCount = this.getLineCount();
    for (let line = 0; line < lineCount; line++) {
        this.clearLineHighlight(line);
    }
}
```

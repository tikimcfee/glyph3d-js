# Phase 0: Tour Engine Design

Agent perspective: how an agent or user scripts a walk-through of code,
sequencing highlights across files with annotations, stepping forward/back,
and the interaction model.

## Status Quo

The existing `tour.*` commands in `navigationCommands.js` operate at
**grid granularity**: each stop frames a whole CodeGrid and optionally
shows a floating annotation. There is no concept of highlighting specific
lines, character ranges, or tokens within a grid. The tour plays
linearly (start-to-finish, no prev/next), and manual camera movement
during playback is effectively ignored (the next `animateCamera` call
overwrites position).

Meanwhile, `GlyphRenderer.setGlyphHighlight(bufferSlotIndex, color)`
now exists for per-character additive color. The picking system can
resolve `{ renderer, slotIndex }` to `{ textId, charIndex }`. The
missing link is a **line/range-aware tour step** that maps a human
concept ("highlight lines 10-25 of auth.js") to the buffer slot
indices that `setGlyphHighlight` needs.

## 1. What Is a Tour Step?

A tour step is the atomic unit of a guided code walkthrough. It
specifies *what to show*, *where to look*, and *what to say*.

```js
/**
 * @typedef {Object} TourStep
 * @property {string}      target     - Grid ref (index, registry ID, or filename substring)
 * @property {HighlightSpec|null} highlight - What to highlight within the target grid
 * @property {string|null} annotation - Markdown-ish text shown as floating label
 * @property {string}      [anchor]   - Where to place annotation relative to highlight
 *                                      ('top'|'leading'|'trailing', default 'top')
 * @property {number}      [holdMs]   - Time to hold this step before auto-advance (default 4000)
 * @property {Object|null} [camera]   - Optional explicit camera override { x, y, z }
 *                                      If null, camera auto-frames the highlight region
 */

/**
 * @typedef {Object} HighlightSpec
 * @property {'lines'|'range'|'text'|'regex'} type
 * @property {number}   [startLine]  - 1-based inclusive (type: 'lines')
 * @property {number}   [endLine]    - 1-based inclusive (type: 'lines')
 * @property {number}   [line]       - 1-based line (type: 'range')
 * @property {number}   [startCol]   - 0-based column (type: 'range')
 * @property {number}   [endCol]     - 0-based column exclusive (type: 'range')
 * @property {string}   [text]       - Literal text to find (type: 'text')
 * @property {string}   [pattern]    - Regex pattern (type: 'regex')
 * @property {{r,g,b}}  [color]      - Highlight color (default: { r: 0.4, g: 0.3, b: 0.0 })
 */
```

Key design choice: `HighlightSpec` is a **declarative query** against
the grid's content, not a raw buffer slot list. The tour engine resolves
it to slot indices at step-enter time. This keeps tour definitions stable
across re-layouts and makes them human-authorable.

## 2. Tour Sequencing Model

```
tour.create  -->  tour.step (repeat)  -->  tour.start
                                           tour.next / tour.prev / tour.goto N
                                           tour.end
```

### State machine

```
IDLE  --tour.start-->  ACTIVE(stepIndex=0)
ACTIVE  --tour.next-->  ACTIVE(stepIndex+1)  |  IDLE (if past last)
ACTIVE  --tour.prev-->  ACTIVE(stepIndex-1)  |  noop (if at 0)
ACTIVE  --tour.goto N-->  ACTIVE(stepIndex=N)
ACTIVE  --tour.end-->  IDLE  (cleanup)
ACTIVE  --tour.play-->  AUTO_PLAY  (timed advance)
AUTO_PLAY  --tour.pause-->  ACTIVE  (hold current step)
AUTO_PLAY  --tour.end-->  IDLE
```

Only one tour is active at a time. Starting a new tour implicitly ends
the current one. The `tour.play` auto-advance mode uses each step's
`holdMs` for pacing.

### Entering a step

When the engine enters step N:

1. **Clear previous step** -- remove highlights and annotation from step N-1
2. **Resolve target** -- find grid via `resolveGridByIdOrIndex` or filename
   substring match (same fallback chain as `camera.focus`)
3. **Resolve highlight** -- map `HighlightSpec` to buffer slot indices
4. **Apply highlights** -- call `setGlyphHighlight(slot, color)` for each slot
5. **Frame camera** -- compute bounding box of highlighted glyphs, use
   `animateCamera` to fly there (or use explicit `camera` override)
6. **Show annotation** -- create floating CodeGrid label anchored relative
   to the highlight region

### Leaving a step

1. Clear all glyph highlights applied by this step (restore to null)
2. Remove the annotation grid from the scene
3. No grid-level visual state changes (no Z-pop, no scale bump -- those
   are for `highlight.grid`, not tour highlights)

## 3. Highlight Resolution: Lines to Buffer Slots

This is the critical bridge. CodeGrid stores `_contentTextIds` -- one
collection-level text ID per source line (sync path) or one ID for all
content (async path). The collection maps each text ID to a renderer
text ID, which has `bufferStartIndex` and `glyphs.length`.

Resolution strategy:

```
HighlightSpec { type: 'lines', startLine: 10, endLine: 15 }
    |
    v
CodeGrid._contentTextIds[9..14]    (0-indexed from 1-based line numbers)
    |
    v  (via GlyphCollection._idMap)
GlyphRenderer.renderedTexts entries  -->  bufferStartIndex, glyphs.length
    |
    v
slot range: [bufferStartIndex .. bufferStartIndex + glyphs.length - 1]
```

For the async path (single text entry for all content), line resolution
requires scanning the glyph array for newline boundaries. We add a
helper to CodeGrid:

```js
/**
 * Resolve a line range to buffer slot indices.
 * @param {number} startLine - 1-based inclusive
 * @param {number} endLine   - 1-based inclusive
 * @returns {{ renderer, startSlot, endSlot }|null}
 */
getBufferSlotsForLines(startLine, endLine) { ... }
```

For `type: 'text'` and `type: 'regex'`, we search `grid.content`,
find the match offset, then map character offsets to buffer slots using
the same glyph-position data.

## 4. Tour JSON Schema

Tours are loadable as JSON, authorable by hand or generated by agents.

```json
{
  "name": "Auth Flow Walkthrough",
  "steps": [
    {
      "target": "auth.js",
      "highlight": { "type": "lines", "startLine": 12, "endLine": 28 },
      "annotation": "The middleware validates JWT tokens\nbefore passing to route handlers.",
      "holdMs": 5000
    },
    {
      "target": "auth.js",
      "highlight": { "type": "text", "text": "sessionToken" },
      "annotation": "Session tokens are extracted here.",
      "anchor": "trailing"
    },
    {
      "target": "db.js",
      "highlight": { "type": "lines", "startLine": 45, "endLine": 60 },
      "annotation": "The query function that auth calls\ninto for session persistence.",
      "holdMs": 6000
    }
  ]
}
```

### WebSocket command for loading

```
tour.load <base64-json>
```

Agents can also build tours incrementally:

```
tour.create <base64-name>
tour.step <base64-name> <base64-step-json>
tour.step <base64-name> <base64-step-json>
tour.start <base64-name>
tour.next
tour.prev
tour.goto 2
tour.end
```

The `tour.step` command accepts a single JSON step object (base64-encoded)
instead of the current positional-arg format. This replaces the existing
`tour.stop` command's grid-index-only targeting with the richer
`HighlightSpec` model.

## 5. Interaction with Manual Navigation

**Policy: manual movement pauses but does not cancel.**

When `tour.play` (auto-advance) is active and the user moves the camera
via keyboard/mouse:

1. Auto-advance timer is paused
2. Highlights and annotation remain visible
3. The tour enters ACTIVE (manual stepping) state
4. User can resume with `tour.play` or step manually with `tour.next`

When in ACTIVE (manual stepping) state, camera movement is unrestricted.
The user is free to orbit, zoom, and pan. The highlights stay applied.
Only `tour.next`/`tour.prev`/`tour.goto` change the step.

Detection: the `CameraController` already tracks input state. We add a
listener that fires when manual input occurs during AUTO_PLAY.

## 6. Cleanup on tour.end

```
tour.end  -->  1. Clear all glyph highlights (setGlyphHighlight(slot, null))
               2. Remove all tour annotation grids from scene
               3. Cancel any in-flight camera animation
               4. Reset tour state to IDLE
               5. Do NOT restore camera position (user may want to stay)
```

`scene.reset` also calls `tour.end` implicitly -- a superset cleanup.

## 7. Incremental Tour Building via WebSocket

An agent analyzing code in real-time builds a tour as it discovers
things. The protocol supports this naturally:

```
Agent sends:  tour.create "code-review"
Agent sends:  tour.step "code-review" { target: "app.js", highlight: {...}, annotation: "..." }
Agent sends:  tour.step "code-review" { target: "db.js", highlight: {...}, annotation: "..." }
Agent sends:  tour.start "code-review"
              // User is now on step 0, seeing app.js highlighted

Agent sends:  tour.step "code-review" { target: "utils.js", ... }
              // Step appended while tour is active -- does not disrupt current step
              // User can tour.next to reach it when ready
```

Steps can be appended to a tour that is already playing. The engine
simply grows the stop list. This lets an agent narrate in real-time
without front-loading the entire analysis.

## 8. Command Surface

| Command | Args | Description |
|---------|------|-------------|
| `tour.create` | `<b64-name>` | Create empty named tour |
| `tour.step` | `<b64-name> <b64-step-json>` | Append step to tour |
| `tour.load` | `<b64-json>` | Load complete tour from JSON |
| `tour.start` | `<b64-name>` | Enter step 0, apply highlights |
| `tour.next` | | Advance to next step |
| `tour.prev` | | Return to previous step |
| `tour.goto` | `<N>` | Jump to step N (0-based) |
| `tour.play` | `[b64-name]` | Auto-advance mode (name optional if tour active) |
| `tour.pause` | | Stop auto-advance, hold current step |
| `tour.end` | | Clean up and return to IDLE |
| `tour.list` | | Show all tours and their step counts |
| `tour.clear` | | Remove all tours |

## 9. Implementation Sequence

1. **Add `getBufferSlotsForLines()`** to CodeGrid -- the line-to-slot
   bridge. This is the only new method on the rendering side.

2. **Add `resolveHighlightSpec()`** utility in a new
   `app/commands/handlers/tourEngine.js` -- takes a CodeGrid and
   HighlightSpec, returns `{ renderer, slots: number[] }`.

3. **Refactor `navigationCommands.js`** tour commands to use the new
   step format and state machine. Keep backward compat for the
   grid-index-only `tour.stop` form (treat as `highlight: null`,
   whole-grid framing).

4. **Add `tour.next/prev/goto/pause`** -- the interactive stepping
   commands that the current linear `tour.play` lacks.

5. **Wire input detection** -- listen for manual camera input during
   AUTO_PLAY to trigger pause.

## 10. What This Does Not Cover

- **Semantic highlights** (e.g., "highlight all usages of this function")
  -- that requires a symbol table, which is a separate system. The tour
  engine accepts the result of such analysis as a HighlightSpec.
- **Multi-grid steps** (highlight across two files simultaneously) --
  possible future extension, not in v1.
- **Tour persistence** (save/load to localStorage) -- trivial to add
  since tours are already JSON-serializable.
- **Tour recording** (record user navigation as a tour) -- interesting
  future direction, not in scope.

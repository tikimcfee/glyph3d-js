# Layout-as-substrate refactor — handoff

> Written 2026-05-04 at the end of editable-3d-ide L2 M1/M2 work, after a
> sequence of caret-positioning bugs surfaced the same architectural
> problem three times in three commits. Ivan greenlit the refactor; this
> doc is for the fresh session that picks it up.

## TL;DR

`buildBatchBuffers` (`src/workers/builders/index.js`) does double duty:
it's the **layout algorithm** (wraps, advances, pagination, line stepping)
AND the **GPU buffer constructor**. Every consumer that needs to know
*where things ended up* (cursor, click hit-testing, selection rendering,
search) currently has to ask `itemMeta` for hand-curated fields, and
each new field has to be threaded through `applyPrebuiltBuffers` →
`renderedTexts` → consumer. We've now had three consecutive bugs from
this seam in this session — it's a class issue, not a one-off.

The pivot: **layout becomes a queryable substrate**. Workers produce a
`LayoutDescription` that owns all derived layout truth. GPU buffer
construction is one consumer of it; cursor/click/selection are others.
No hand-curated field lists at any boundary.

This is also the right substrate to land before the WebGPU compute
pipeline work resumes (separate cross-ref; lost during repo cleanup but
the user is bringing it back). A queryable layout is what compute
shaders for selection rendering / per-glyph effects will consume.

## Why this matters (the bug class)

Three bugs this session, all the same shape:

1. **Worker emits wrap data** but `applyPrebuiltBuffers` (`src/GlyphRenderer.js:1598`)
   only copies `lineSlotOffsets` to the renderedTexts entry; the consumer
   reads via `_getContentItemMeta` and gets `undefined` for the new field.
   Fixed in commit `87f0028` by adding one line to the renderer.
2. **Worker/grid metric naming asymmetry**: worker calls it `lineSpacing`,
   `CodeGrid.metrics` calls it `lineHeight`. Same value, two names, two
   places. Caret math used `m.lineSpacing` against grid metrics → NaN →
   caret y serialized as `null`. Fixed in `f4d1328`.
3. **My own edit accidentally clobbered `let x/y/z` declarations** when
   inserting wrap-tracking state. Worker threw `y is not defined` on
   every flush; CodeGrid silently fell back to the sync path (which
   doesn't emit wrap data) so caret hid for everything. Fixed in
   `3d90f1f`.

After all three fixes, caret position is much closer but Ivan reports
edit ops "feel off" (backspace, Enter). The edit ops themselves
(`editInsert`, `editDeleteBackward`, `editSplitLine`, etc. in
`src/collections/CodeGrid.js`) mutate `this.lines` and `this._cursor`
correctly — but the **visual** caret depends on a wrap-data snapshot
that's refreshed asynchronously after relayout, and the user perceives
the visual lag as edit-op weirdness.

The LayoutDescription pivot dissolves all of this. Cursor stops asking
"where is line N col C?" via metrics + wraps + pagination math; it asks
the layout itself. Same for click, selection, search.

## Current state (as of 2026-05-04 end-of-session)

Branch: `experiment/webgpu-v4`. Ahead of origin by recent commits, all
pushed.

**What works (verified end-to-end):**
- `edit.start [id]` / `edit.stop` / `edit.info` verbs (commit `658279d`).
- Keystroke routing: printable, Backspace, Delete, Enter, arrows, Home/End,
  Tab. Routes through `_installEntityKeystrokeDelivery` in
  `app/commands/index.js`.
- ShortcutManager defers when `attention.key` points at a grid editor
  (commit `0fa80f8`) — Tab/Enter no longer fire app shortcuts during edit.
- `_relayoutPreservingCursor` routes through the worker async path
  (commit `254054e`) — buffers right-size on every keystroke.
- StatePersistence validates camera position against poisoned localStorage
  (commit `2c7bbd3`) — independent fix surfaced during dogfood.
- Cursor data model is plain `{ line, col }` source coords. Edit ops
  mutate `this.lines` + cursor synchronously; relayout is async.

**What's known-shaky after the wrap-cols approach:**
- Caret position appears to be 1 line off in some files (Ivan flagged on
  `rendering-specialist.md`). Diagnostic dump from session showed wrap
  data populated correctly; the off-by-one was traced to renderedTexts
  dropping the field. After the renderer fix (`87f0028`) caret is
  closer but edit ops felt subtly wrong — most likely the visual
  caret/relayout timing perceived as edit-op behavior.
- Should NOT spend time fine-tuning the wrap-cols caret math — the
  refactor will rip it out and re-derive position via the new substrate.

**Recent commit chain (newest first):**
- `87f0028` GlyphRenderer.applyPrebuiltBuffers persists wrapColsPerLine
- `f4d1328` caret uses metrics.lineHeight not lineSpacing
- `3d90f1f` worker x/y/z declarations restored
- `08871d1` console-forwarder serializes Error instances properly
- `4e2e3ae` caret derive position from layout invariants (the wrap-ruler attempt)
- `0fa80f8` shortcuts defer to in-grid editing
- `658279d` keystroke routing + edit.* verbs
- `2c7bbd3` StatePersistence validates camera.position
- `ddb8a42` original M1 in-grid edit engine on CodeGrid

## The substrate shape

```js
// Pure data, transferable via structured clone
class LayoutDescription {
    // Per-line state in flat typed arrays for transferability
    lineCount: number
    lineStartRow: Int32Array          // [lineCount] — cumulative visual row index
    lineRowCount: Uint16Array          // [lineCount] — visual rows this line spans
    wrapColOffsets: Uint32Array        // [lineCount + 1] — flat offset table
    wrapCols: Uint32Array              // [totalWrapCount] — flat wrap col entries

    // Layout config that drove the algorithm (consumers may need it)
    origin: { x, y, z }
    advance: number                    // monospace per-char advance (for v0)
    lineSpacing: number
    pageHeight: number                 // pagination threshold
    pagesWide: number
    pageGapX: number
    pageGapY: number
    maxLineWidth: number               // z-wrap threshold (chars)

    // Per-glyph data (existing, but now part of the same handle)
    positions: Float32Array            // [count * 3]
    sizes: Float32Array                // [count * 2]
    glyphIds: Float32Array             // [count]
    colors: Float32Array               // [count * 3]
    groupIds: Float32Array             // [count]
    count: number
    bounds: { min, max, width, height, depth }

    // Source-char ↔ slot mapping (omit for v1 if unused, add when click
    // hit-testing or per-char queries land)
    // sourceCharToSlot: Int32Array    // [totalSourceChars] — slot or -1
    // slotToSourceChar: Uint32Array   // [count] — source char index
}
```

Methods (live in CodeGrid or a helper, not on the postMessage'd object —
methods don't survive structured clone; but the API surface is what
consumers call):

```js
positionAt(line, col): { x, y, row } | null
    Returns the world-space caret stop for (line, col). Handles wraps,
    pagination, empty/whitespace lines. Single source of truth, never
    re-implemented by callers.

rangeRects(startLine, startCol, endLine, endCol): Rect[]
    Returns the rectangles covering a selection range. Splits on wrap
    boundaries, page boundaries. Used by selection rendering (post-M2).

hitTest(worldX, worldY): { line, col } | null
    Click → cursor. Reverse search the wrap ruler / page layout for the
    nearest cursor stop. Used by click-to-position-cursor (M5).

glyphSpansForRows(firstRow, lastRow): { startSlot, endSlot }[]
    What buffer slots are visible on a given visual row range. For
    virtualized rendering / GPU-side range work later.

visualRowToWorldY(visualRow): number
    Shared helper. Pagination-aware.

worldYToVisualRow(y): number
    Reverse of above. Used by hitTest.
```

The renderer's `applyPrebuiltBuffers` becomes
`applyLayout(layoutDescription)` — it takes the whole layout, sets the
renderedText entry to a reference to the layout, and never has to know
about specific layout fields.

`CodeGrid` stores the current `LayoutDescription` and routes all queries
through it. `_resolveCaretWorldPosition` becomes a one-liner:
`return this._layout.positionAt(line, col)`.

## File-by-file refactor plan

### Phase 1 — Define and emit

1. **New file: `src/core/LayoutDescription.js`**
   - Plain class (or factory function) that wraps the typed arrays + config.
   - Methods listed above (positionAt, rangeRects, hitTest, etc.).
   - Methods are derived; the class is constructible from its raw fields
     so it can be reconstructed on the main thread after postMessage.
   - Consider: `LayoutDescription.fromTransferable(plainObject)` →
     instance with methods bound. Keeps the postMessage payload pure data.

2. **Refactor `src/workers/builders/index.js`**
   - Split `buildBatchBuffers` into two:
     - `layout(items, shared, emptyGlyphs) → LayoutDescription` — runs the
       full layout algorithm (current code), produces a complete
       LayoutDescription (typed arrays + config).
     - `buildGlyphBuffers(layout) → GPU buffers` — derives the
       Float32Arrays from the layout (currently happens inline; move to
       a separate function so layout is the authoritative output).
   - The worker entry point in `src/workers/GlyphWorker.js` calls both,
     posts back the LayoutDescription. Buffer typed arrays stay inside
     the layout description (or are siblings — design choice).

3. **Refactor `src/workers/GlyphWorker.js`**
   - Ship the LayoutDescription back as a single object.
   - Transferables list still includes the typed array buffers.

### Phase 2 — Consume

4. **Refactor `src/GlyphRenderer.js` `applyPrebuiltBuffers`**
   - Rename to `applyLayout(layoutDescription, items)` (or keep the
     name, but the signature changes).
   - Stash the entire layout on the renderedTexts entry, not field-by-field.
   - GPU upload paths read positions/sizes/etc from layout.

5. **Refactor `src/collections/CodeGrid.js`**
   - Drop `_lineWrapCols`, `_lineStartRow`, `_layoutOriginY`,
     `_buildLayoutWrapIndex`. Drop the `_resolveCaretWorldPosition`
     bespoke math.
   - Add `this._layout = null` field.
   - In `_layoutContentAsync`, harvest the LayoutDescription from
     `_getContentItemMeta()` (or refactor that to return the layout
     directly, not the renderedText entry).
   - `_updateCaretMesh` becomes:
     ```js
     const pos = this._layout?.positionAt(this._cursor.line, this._cursor.col);
     ```
   - Edit ops unchanged (they mutate `this.lines` + `this._cursor`).

### Phase 3 — Verify and prune

6. **Verify M1 + M2 still work end-to-end** (smoke sequence below).
7. **Delete the dead code** — wrap-cols hand-plumbing in the worker
   meta, the per-line wraps state on CodeGrid, the metrics-fallback
   caret math.
8. **No compat shims, no dual paths.** Per project convention. Atomic
   rewrite is the forcing function for the boundary actually being clean.

## Verification (smoke sequence)

After the refactor, this should all work without the buginess Ivan
reported at end of session:

```js
const g = viewer._context.getGrids()[0];

// 1. enterEdit caret lands at end of file
g.enterEdit();
//    expect: caret in dark area BELOW last visible content line
//    (rendering-specialist.md was the diagnostic case — 121 lines,
//    trailing empty, some long lines that may have z-wrapped)

// 2. mid-line typing
g.editEnd();              // jump to end of current line
g.editInsert("hello");    // chars insert visibly, caret follows
g.editDeleteBackward();   // last char deleted, caret retreats

// 3. line splits
g.editSplitLine();        // line splits, caret on new empty line
g.editInsert("world");    // types on new line

// 4. arrow nav across wraps
g.setCursor(50, 250);     // pick a line that wraps (>200 chars)
g.editMoveCursor(-10, 0); // back through the wrap boundary

// 5. exit cleanly
g.exitEdit();
```

End-to-end via keyboard (the L2 M2 path):
- Click a grid → primary attention.
- Run `edit.start` from CommandBar or CLI.
- Type. Backspace. Enter. Arrows. All visible.
- Esc → caret hides; `attention.key` cleared via LIFO.

## WebGPU compute angle

The user has flagged that WebGPU compute pipelines are coming. The
LayoutDescription is the right substrate to land first because:

- Compute shaders for selection rendering need per-glyph or per-row
  data. LayoutDescription's flat typed arrays (positions, lineStartRow,
  wrapColOffsets) are directly bindable as storage buffers.
- Per-glyph effects (highlight pulses, search emphasis) can dispatch
  compute kernels parameterized by source-coord ranges, which the
  layout translates to slot ranges via `glyphSpansForRows` /
  `sourceCharToSlot`.
- Click hit-testing on huge files becomes a parallel reverse search
  over per-row position data — the same data structure that powers
  caret positioning.

If the new session has bandwidth, the WebGPU compute work is a natural
next beat after the layout substrate lands. Look for a
`cross-ref/webgpu-compute-pipeline/CONTEXT.md` if Ivan's brought it
back; if not, ask him for direction.

## Things not to do

- **No compat shim** that emits both old `itemMeta` fields and the new
  `LayoutDescription`. Atomic refactor — the renderer + CodeGrid + worker
  all switch in the same set of commits.
- **No parallel "layoutFlag" branches** that route some paths through
  the new code and some through the old. Single path.
- **Don't try to preserve the wrap-cols-on-itemMeta interface for
  external consumers** — there are none yet beyond CodeGrid.
- **Don't try to make the LayoutDescription a class with methods that
  survive postMessage.** Methods don't structured-clone. Make it a
  plain transferable, reconstruct the wrapper class on the main thread.

## Pointers for the fresh agent

Read these files first:
- `src/workers/builders/index.js` — current layout + buffer construction
- `src/workers/GlyphWorker.js` — worker entry, postMessage shape
- `src/workers/WorkerBridge.js` — bridge resolution + transferables
- `src/GlyphRenderer.js` lines ~1535-1610 — `applyPrebuiltBuffers`
- `src/collections/CodeGrid.js` lines ~1230-1340 — caret resolver +
  wrap index harvest (the code to delete)
- `src/collections/CodeGrid.js` lines ~1300-1500 — edit ops (DON'T touch)

Run `git log --oneline experiment/webgpu-v4 -20` to see the recent
commit chain in context.

Skim `cross-ref/editable-3d-ide/round3-*-convergence.md` for the
broader L0-L3 plan that this session has been executing against.

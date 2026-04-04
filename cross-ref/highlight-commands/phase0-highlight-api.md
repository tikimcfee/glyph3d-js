# Phase 0: Highlight API Design
# Agent: highlight-api

## The Core Gap

The GPU has `setGlyphHighlight(bufferSlotIndex, color)` — it takes an absolute integer
into the `instanceAddedColor` Float32Array. Command handlers speak in `(file, line, col)`.
Nothing bridges these two coordinate spaces today. This document defines what that bridge
looks like and where each piece lives.

---

## 1. (file, line, col) → bufferSlotIndex

### Sync path (one addText per line)

`CodeGrid._layoutContent()` calls `_collection.addText(line, ...)` per line and pushes
the returned collection-ID into `_contentTextIds[lineIndex]`. After `flush()`, each
collection-ID maps through `GlyphCollection._idMap` to a renderer-ID, and each renderer
entry has `renderedTexts.get(rendererId).bufferStartIndex`.

So the chain today is:

```
lineIndex  →  _contentTextIds[lineIndex]  →  collection ID
           →  _idMap.get(collectionId)    →  renderer ID
           →  renderedTexts.get(rendId).bufferStartIndex  →  base slot
           →  base slot + col             →  bufferSlotIndex
```

The `col` offset is direct: glyphs are written left-to-right with no gaps for whitespace
in the buffer (every character occupies one slot, including spaces).

### Async path (one addText for entire file)

`_layoutContentAsync()` sends the entire file as a single text entry. `_contentTextIds`
has exactly one ID. The buffer is laid out linearly: the worker processes newlines as
position offsets but still emits one slot per character. The slot for `(line, col)` is:

```
bufferSlotIndex = base + sum(len(lines[0..line-1]) + newline_chars) + col
```

This sum is not currently pre-computed anywhere. The async path needs a line-start-offset
table (see section 4).

### What is NOT correct to assume

- `col == glyphOffset` is only true if the line has no skipped characters. Currently
  empty lines are skipped entirely in the sync path (no addText call, no buffer slots),
  so line indices in `_contentTextIds` do not correspond 1:1 to `this.lines` indices.
  Line 3 being empty means `_contentTextIds[2]` does not exist; `_contentTextIds[2]`
  is actually line 4. This is a pre-existing bug for any future highlight-by-line use.

---

## 2. (file, line, startCol, endCol) → [bufferSlotIndex...]

For a contiguous range on a single line the slots are:

```
base = bufferSlotForLine(lineIndex)
slots = [base + startCol, base + startCol + 1, ..., base + endCol - 1]
```

For a multi-line range `(startLine, startCol) → (endLine, endCol)`:

```
for each lineIndex in [startLine .. endLine]:
    colStart = (lineIndex == startLine) ? startCol : 0
    colEnd   = (lineIndex == endLine)   ? endCol   : lineLength(lineIndex)
    for col in [colStart .. colEnd):
        collect bufferSlotForLine(lineIndex) + col
```

This is a simple loop. The expensive part is calling `bufferSlotForLine` per line, which
requires the line-offset table described below.

---

## 3. Should CodeGrid expose highlightRange?

Yes. `CodeGrid` owns both the line content and the collection — it is the natural owner
of the (line, col) → buffer-slot mapping. It already has `_contentTextIds`, `lines`, and
`_collection`. The method signature:

```js
/**
 * Apply additive highlight color to a character range.
 * No-op if the grid has not been flushed yet.
 * @param {number} startLine - 0-based inclusive
 * @param {number} startCol  - 0-based inclusive
 * @param {number} endLine   - 0-based inclusive
 * @param {number} endCol    - 0-based exclusive
 * @param {{r,g,b}} color
 */
highlightRange(startLine, startCol, endLine, endCol, color)

/**
 * Clear highlight from a range (sets addedColor to 0,0,0).
 */
clearHighlightRange(startLine, startCol, endLine, endCol)

/**
 * Clear all highlights on this grid.
 */
clearAllHighlights()
```

These call down through `_collection._renderer.setGlyphHighlight(slot, color)` after
resolving each slot. The renderer's `setGlyphHighlight` sets `needsUpdate = true` on the
attribute; callers should batch into a single frame.

---

## 4. Where does the line → glyph mapping live?

A `LineGlyphIndex` structure built and stored on `CodeGrid` after each flush.

### Sync path

Built from `_contentTextIds` and `lines` together. The index must track the empty-line
skip: only lines with `line.length > 0` get a buffer entry. The mapping is a parallel
array to `this.lines`:

```js
// _lineSlotBase[lineIndex] = absolute bufferSlotIndex of col 0 on that line
// undefined for empty lines (no buffer slots)
this._lineSlotBase = new Int32Array(this.lines.length).fill(-1);
```

Populated after flush:

```js
let textIdCursor = 0;
for (let i = 0; i < this.lines.length; i++) {
    if (this.lines[i].length === 0) continue;
    const collId = this._contentTextIds[textIdCursor++];
    const rendId = this._collection._idMap.get(collId);
    const entry  = this._collection._renderer.renderedTexts.get(rendId);
    this._lineSlotBase[i] = entry ? entry.bufferStartIndex : -1;
}
```

### Async path

The worker returns a single entry with `bufferStartIndex`. Building `_lineSlotBase` from
this requires knowing the cumulative character offset at each line start, which means
walking `this.content` once:

```js
_buildLineSlotBaseAsync(baseSlot) {
    let offset = 0;
    for (let i = 0; i < this.lines.length; i++) {
        this._lineSlotBase[i] = baseSlot + offset;
        offset += this.lines[i].length + 1; // +1 for '\n'
    }
}
```

This O(lines) walk happens once after flush, not on every highlight call.

### When to rebuild

`_lineSlotBase` must be invalidated and rebuilt whenever `_rebuildAllInstances` or
`applyPrebuiltBuffers` runs (buffer slots shift). The recommended hook is the existing
`onFlush` callback pattern already used by `PickingSystem.registerRenderer`. CodeGrid
should call `_buildLineSlotBase()` / `_buildLineSlotBaseAsync()` from inside
`_layoutContent()` after `flush()` returns, and from `_layoutContentAsync()` after
`flushAsync()` resolves.

---

## 5. Highlight composition

The current `instanceAddedColor` attribute is a simple additive term: the fragment
shader adds it to the base color. Overlapping highlights are therefore additive — a
token highlighted with `{r:0.3}` and a line highlighted with `{g:0.3}` produces
`{r:0.3, g:0.3}` at the overlap. This is the correct behavior for stacked highlights
(search result + current line, cursor position + syntax error).

No special composition logic is needed in the bridge layer. Callers own composition by
controlling which colors they write.

---

## 6. Clearing highlights

### Clear a range

`clearHighlightRange(startLine, startCol, endLine, endCol)` calls
`renderer.setGlyphHighlight(slot, null)` for each slot — `null` coerces to `{0,0,0}`.
Alternatively call `renderer.setGlyphHighlight(slot, { r: 0, g: 0, b: 0 })` directly.

### Clear an entire line

`renderer.updateAddedColor(rendererId, null)` zeroes all glyphs of one text entry in a
single loop — cheaper than per-slot calls when clearing full lines. This is the correct
path for "clear current line highlight before moving cursor to new line".

### Clear everything

Iterate `renderedTexts.values()` and call `updateAddedColor(id, null)` on each.
One `needsUpdate = true` is enough because they all write to the same attribute array.
CodeGrid's `clearAllHighlights()` does this in one pass and sets `needsUpdate` once:

```js
clearAllHighlights() {
    const renderer = this._collection._renderer;
    if (!renderer) return;
    const attr = renderer.instanceMesh.geometry.attributes.instanceAddedColor;
    if (!attr) return;
    attr.array.fill(0);
    attr.needsUpdate = true;
}
```

### Tracking active highlights

The bridge layer does NOT need to track which slots are highlighted for clearing purposes
— `fill(0)` on the typed array is O(maxInstances) and dominated by the GPU upload cost
anyway. A tracking Set is only warranted if partial clears (by semantic region, not by
range) are needed, which is a SemanticInfoMap concern, not a highlight bridge concern.

---

## Summary: Data flow for "highlight line 5, columns 3-17"

```
Command handler
  │  highlightRange(4, 3, 4, 17, color)   [0-based]
  ▼
CodeGrid
  │  _lineSlotBase[4]  →  base = 312      [pre-built after flush]
  │  slots = [315, 316, ..., 328]
  ▼
CodeGrid (loop, 14 iterations)
  │  _collection._renderer.setGlyphHighlight(315, color)
  │  ...
  │  _collection._renderer.setGlyphHighlight(328, color)
  │  (all writes into same Float32Array, needsUpdate set once by last call)
  ▼
GPU: instanceAddedColor uploaded, fragment shader adds color next frame
```

The only new persistent state introduced is `_lineSlotBase: Int32Array` on CodeGrid,
rebuilt once per flush. Everything else is a direct buffer write.

---

## Open Issue: the empty-line skip in sync path

`_layoutContent()` skips `addText` for empty lines, making `_contentTextIds` shorter
than `this.lines`. The `_buildLineSlotBase()` implementation above handles this with the
`textIdCursor` pattern. However, the correct long-term fix is to change `_layoutContent`
to emit a zero-character entry (or a sentinel) for empty lines so the index stays aligned.
That change is a separate task and does not block highlight implementation.

---

## Files Modified by This Design

- `/home/user/dev/glyph3d-js/src/collections/CodeGrid.js` — add `_lineSlotBase`,
  `_buildLineSlotBase()`, `_buildLineSlotBaseAsync()`, `highlightRange()`,
  `clearHighlightRange()`, `clearAllHighlights()`
- `/home/user/dev/glyph3d-js/src/collections/GlyphCollection.js` — expose
  `updateAddedColor(collectionId, color)` as a thin passthrough to renderer
  (currently only the renderer has this method)

No new files required. No shader changes required. No worker changes required.

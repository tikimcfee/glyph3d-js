# Phase 0: Grid Editing -- Inverse Buffer Mapping

## Decision: SlotMap as Authoritative Bidirectional Index

The buffer builder (`src/workers/builders/index.js`, `buildBatchBuffers`) already produces
`lineSlotOffsets` (line 314, 332, 429) and `buildGlyphBuffers` does the same (line 92, 105).
These map line -> first buffer slot. The inverse (slot -> line,col) does not exist yet.
Both directions must be built in the same pass that writes the glyph buffers to stay in
lockstep with skip logic.

### What the builder skips (the skip set)

From `buildBatchBuffers` lines 324-356 and `_textToGlyphs` lines 1139-1145:

| charCode | Name     | Effect on cursor | Gets a buffer slot? |
|----------|----------|-------------------|---------------------|
| 10       | newline  | reset x, advance y | NO                 |
| 32       | space    | advance x          | NO                 |
| 13       | CR       | nothing            | NO                 |
| 9        | tab      | nothing            | NO                 |

Spaces advance the x cursor but get no slot. Tabs and CRs are fully ignored.
This means raw-char-index != visible-char-index != buffer-slot-index.

---

## 1. SlotMap: Bidirectional Mapping

### Data structure produced by the builder

```js
// Added to itemMeta alongside lineSlotOffsets
slotMap: {
    // Forward: (line, rawCol) -> bufferSlot
    // Already partially exists via lineSlotOffsets + visible-col counting.
    // But visible-col is ambiguous -- callers must know to skip whitespace.
    // Instead, store a per-slot reverse record:

    // Reverse: bufferSlot -> { line, rawCol, visCol }
    slotToPos: Int32Array,   // interleaved [line, rawCol, visCol, line, rawCol, visCol, ...]
                              // 3 ints per slot, length = glyphCount * 3

    // Forward (kept): line -> first buffer slot
    lineSlotOffsets: Array<number>,  // already produced

    // Per-line visible char count (avoids re-scanning text)
    lineVisCharCounts: Int32Array,   // lineVisCharCounts[line] = number of non-skip chars
}
```

### Where to build it

In `buildBatchBuffers` (`src/workers/builders/index.js`), inside the existing character
loop (line 321-390). The loop already tracks `bufferOffset`, `y`, and line boundaries.
Add three counters:

```js
// At item start (alongside itemLineSlotOffsets, line 314):
const slotToPos = new Int32Array(totalItemGlyphs * 3); // pre-counted
let currentLine = 0;
let rawCol = 0;
let visCol = 0;
const lineVisCharCounts = [];
let lineVisCount = 0;

// On newline (line 324-333):
lineVisCharCounts.push(lineVisCount);
lineVisCount = 0;
currentLine++;
rawCol = 0;
visCol = 0;

// On space (line 350-355): advance rawCol, visCol stays
rawCol++;

// On CR/tab (line 356): rawCol++ for tab (debatable), skip for CR

// On visible glyph emit (line 369-389):
slotToPos[bufferOffset * 3]     = currentLine;
slotToPos[bufferOffset * 3 + 1] = rawCol;
slotToPos[bufferOffset * 3 + 2] = visCol;
rawCol++;
visCol++;
lineVisCount++;
```

After the item loop, push the final line's count:
```js
lineVisCharCounts.push(lineVisCount);
```

Store in `itemMeta[itemIdx]`:
```js
itemMeta[itemIdx] = {
    bufferStartIndex: itemStartOffset,
    glyphCount: itemGlyphCount,
    lineSlotOffsets: itemLineSlotOffsets,
    slotToPos,             // NEW
    lineVisCharCounts,     // NEW
    bounds: ...
};
```

### Transferable from worker

`slotToPos` is an Int32Array -- add to the transferable list in `WorkerBridge`. 
`lineVisCharCounts` is small (one int per line), can be structured-cloned or
converted to Int32Array for transfer.

### Storage in CodeGrid

`CodeGrid._buildLineSlotBase` (line 518-560) already consumes `lineSlotOffsets`.
Extend it to store the full SlotMap:

```js
// In CodeGrid, after _buildLineSlotBase:
this._slotToPos = contentItemMeta?.slotToPos || null;
this._lineVisCharCounts = contentItemMeta?.lineVisCharCounts || null;
```

---

## 2. Inverse Mapping: slot -> (line, rawCol)

Given a `slotIndex` from `PickingSystem.resolve()`:

```js
// CodeGrid method
getTextPosition(slotIndex) {
    if (!this._slotToPos) return null;
    // slotIndex is relative to the content item's bufferStartIndex
    const contentBase = this._lineSlotBase?.[0] ?? 0;
    const localSlot = slotIndex - contentBase;
    if (localSlot < 0) return null;
    const i = localSlot * 3;
    return {
        line: this._slotToPos[i],
        rawCol: this._slotToPos[i + 1],
        visCol: this._slotToPos[i + 2],
    };
}
```

The picking pipeline becomes:
1. `PickingSystem.renderAndRead(camera, scene)` -> pickingId
2. `PickingSystem.resolve(pickingId)` -> `{ renderer, slotIndex }`
3. `CodeGrid.getTextPosition(slotIndex)` -> `{ line, rawCol, visCol }`

This is the critical link: the raw column is the index into `this.lines[line]` (or
equivalently `this.content`), which is what a TextEdit range needs.

---

## 3. Visible-Char vs Raw-Char Conversion

The existing `highlight.token` command (line 226-235 of `highlightCommands.js`) already
does raw->visible conversion inline. Extract and formalize:

```js
// In CodeGrid
rawColToVisCol(line, rawCol) {
    const text = this.lines[line];
    if (!text) return 0;
    let vis = 0;
    for (let i = 0; i < rawCol && i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c !== 10 && c !== 32 && c !== 13 && c !== 9) vis++;
    }
    return vis;
}

visColToRawCol(line, visCol) {
    const text = this.lines[line];
    if (!text) return 0;
    let vis = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c !== 10 && c !== 32 && c !== 13 && c !== 9) {
            if (vis === visCol) return i;
            vis++;
        }
    }
    return text.length; // past end
}
```

With `slotToPos` storing both rawCol and visCol per slot, we avoid re-scanning
in the common case (click -> position). The scan functions above are only needed
for the forward path (e.g., "place cursor at raw column 15").

---

## 4. Cursor Representation in 3D Space

The cursor is a thin instanced quad in the same GlyphRenderer, or a separate
`THREE.Mesh` child of the CodeGrid. Separate mesh is simpler:

```js
// CodeGrid._createCursor()
const geo = new THREE.PlaneGeometry(1, 1);
const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.8,
    side: THREE.DoubleSide, depthWrite: false
});
this._cursor = new THREE.Mesh(geo, mat);
this._cursor.visible = false;
this.add(this._cursor);
```

Position from slotIndex:
```js
setCursorAtSlot(slotIndex) {
    const renderer = this._collection.getRenderer();
    const positions = renderer.instanceMesh.geometry.attributes.instancePosition.array;
    const sizes = renderer.instanceMesh.geometry.attributes.instanceSize.array;
    const x = positions[slotIndex * 3];
    const y = positions[slotIndex * 3 + 1];
    const z = positions[slotIndex * 3 + 2];
    const w = sizes[slotIndex * 2];
    const h = sizes[slotIndex * 2 + 1];
    // Cursor is a thin bar at the left edge of the glyph cell
    this._cursor.scale.set(w * 0.08, h, 1);
    this._cursor.position.set(x - w * 0.04, y + h * 0.5, z + 0.01);
    this._cursor.visible = true;
}
```

Blinking: toggle `this._cursor.visible` in `CodeGrid.update(deltaTime)` with a
500ms period. No shader needed -- a simple JS timer on the existing update loop.

Cursor between glyphs (e.g., after last char on line, or in whitespace gap):
compute position from neighboring slots or from the line's x-cursor arithmetic.
For end-of-line, read the last slot's position and add its width.

---

## 5. Keyboard Input -> TextEdit

Capture happens at the IDE shell level (`app/IDEShell.js` or a new `EditorInputManager`).
When a CodeGrid has focus (determined by click via picking):

```js
// EditorInputManager
onKeyDown(event) {
    if (!this._activeGrid) return;
    const { line, rawCol } = this._cursorPos;

    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
        // Character insertion
        this._applyEdit({
            range: { start: { line, character: rawCol }, end: { line, character: rawCol } },
            newText: event.key
        });
    } else if (event.key === 'Backspace') {
        if (rawCol > 0) {
            this._applyEdit({
                range: { start: { line, character: rawCol - 1 }, end: { line, character: rawCol } },
                newText: ''
            });
        } else if (line > 0) {
            // Join with previous line
            const prevLineLen = this._activeGrid.lines[line - 1].length;
            this._applyEdit({
                range: { start: { line: line - 1, character: prevLineLen }, end: { line, character: 0 } },
                newText: ''
            });
        }
    } else if (event.key === 'Enter') {
        this._applyEdit({
            range: { start: { line, character: rawCol }, end: { line, character: rawCol } },
            newText: '\n'
        });
    }
    // Arrow keys: move cursor without edit
}
```

The TextEdit range uses **raw** character positions (matching LSP TextEdit semantics),
not visible-char indices. This is why `slotToPos` stores `rawCol`.

---

## 6. Grid Re-render After Edit

### Full re-render (baseline, correct)

```js
_applyEdit(edit) {
    // 1. Apply edit to backing text
    const content = this._activeGrid.content;
    const lines = this._activeGrid.lines;
    const startOffset = this._linesToOffset(lines, edit.range.start);
    const endOffset = this._linesToOffset(lines, edit.range.end);
    const newContent = content.slice(0, startOffset) + edit.newText + content.slice(endOffset);

    // 2. Re-render grid with updated content
    this._activeGrid.loadTextAsync(newContent);

    // 3. Recompute cursor position in new text
    const newCursorOffset = startOffset + edit.newText.length;
    // ... convert offset back to (line, rawCol) and setCursorAtSlot
}
```

`loadTextAsync` clears the collection, sends to worker, rebuilds buffers, flushes to GPU.
For a single-character insertion this takes ~5-15ms (worker round-trip + GPU upload).
Acceptable for typing at normal speed but not for held-key repeat.

### Incremental update (performance target)

For single-char edits on the same line without changing line count:

1. Modify `this.content` and `this.lines[line]` in place
2. Recompute only the affected line's buffer slots:
   - Delete old slots for that line (shift subsequent slots left)
   - Insert new slots (shift subsequent slots right)
   - Update `_lineSlotBase` for all lines after the edit
3. Partial GPU upload via `addUpdateRange()` on the affected attributes

This is significantly harder. The buffer is a flat array -- inserting/deleting slots
means shifting everything after the edit point. With 50k glyphs, shifting 40k slots
is ~160KB of memmove, still under 1ms. The real cost is:
- Rebuilding `slotToPos` for shifted slots (can offset-shift, O(1))
- Re-registering with PickingSystem (picking IDs are contiguous, must re-register)
- Updating highlight texture indices

**Recommendation**: Start with full re-render. The worker pipeline already handles
50k chars in <15ms. Only optimize to incremental if typing latency exceeds 16ms
(one frame). The builder already produces all metadata we need -- the bottleneck
is the worker message round-trip, not computation.

### Debounced re-render for fast typing

```js
_scheduleRerender() {
    if (this._rerenderTimer) return;
    this._rerenderTimer = requestAnimationFrame(() => {
        this._rerenderTimer = null;
        this._activeGrid.loadTextAsync(this._pendingContent);
    });
}
```

Buffer keystrokes into `this._pendingContent`, re-render once per frame.
Cursor position updates immediately (from text arithmetic), visual re-render
is one frame behind. Imperceptible at 60fps.

---

## 7. Z-Depth Wrapping and Position Mapping

Long lines wrap at `Z_WRAP_CONFIG.maxLineWidth` (200 chars) via the builder
(lines 340-348 of `buildBatchBuffers`). The wrap creates a new visual row
(y -= lineSpacing, z -= zWrapSpacing) but does NOT increment the line counter.

This means:
- `slotToPos` is unaffected -- it tracks source line/col, not visual row
- `lineSlotOffsets` is unaffected -- wraps don't create new logical lines
- Cursor positioning works via reading the position buffer directly
- Arrow-key navigation needs awareness: "down" from a wrapped segment should
  go to the next visual row (same logical line, col + 200), not the next
  logical line

For cursor movement, read the 3D position of the current slot and the candidate
slot, pick the one closest in Y (or Y+Z if Z differs). The position buffer is
the ground truth for visual adjacency.

---

## 8. What the Builder Must Produce (Summary)

Current `itemMeta` fields:
- `bufferStartIndex` -- exists
- `glyphCount` -- exists  
- `lineSlotOffsets` -- exists
- `bounds` -- exists

New fields needed:
- `slotToPos: Int32Array` -- [line, rawCol, visCol] x glyphCount, interleaved
- `lineVisCharCounts: Int32Array` -- visible char count per line

Cost: 12 bytes per glyph for slotToPos (3 x Int32), plus ~4 bytes per line
for lineVisCharCounts. For a 50k-glyph file with 1500 lines: 600KB + 6KB.
Transferred once on load, updated on edit. Acceptable.

Both arrays are built in the same character loop that emits glyphs (zero extra
passes). The `slotToPos` write is 3 store operations per visible character --
negligible compared to the 5 attribute writes already happening (position,
size, codepoint, color, groupId = 10 floats = 10 stores).

---

## 9. File-by-File Change Plan

| File | Change |
|------|--------|
| `src/workers/builders/index.js` | Add slotToPos + lineVisCharCounts to buildBatchBuffers and buildGlyphBuffers |
| `src/workers/WorkerBridge.js` | Add slotToPos to transferable list |
| `src/GlyphRenderer.js` | Store slotToPos/lineVisCharCounts in renderedTexts entry (applyPrebuiltBuffers) |
| `src/collections/CodeGrid.js` | Add getTextPosition(), rawColToVisCol(), visColToRawCol(), cursor mesh, setCursorAtSlot() |
| `app/IDEShell.js` or new `app/EditorInputManager.js` | Keyboard capture, TextEdit generation, edit application, cursor management |
| `app/commands/handlers/highlightCommands.js` | Refactor inline vis/raw conversion to use CodeGrid methods |

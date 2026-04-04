# Edit Pipeline: Abstraction Boundaries & Data Flow

Agent: `edit-pipeline`

How a TextEdit flows from user input through buffer mutation, inverse computation,
re-render, and provider persistence -- independent of buffer implementation.

---

## 1. The Pipeline at a Glance

```
  User Input (keystroke / paste / command)
       |
       v
  EditorInputManager.handleInput()
       |
       v
  +----------------------------------------------+
  | EditTransaction                               |
  |  edits: TextEdit[]    (pre-document positions) |
  |  label: string                                 |
  |  baseVersion: number                           |
  +----------------------------------------------+
       |
       +------> TextBuffer.applyEdits(edits)
       |             |
       |             +---> returns ApplyResult {
       |                      newContent: string,
       |                      inverses: TextEdit[],
       |                      treeSitterDescs: TSEditDescriptor[]
       |                   }
       |
       +------> EditHistory.record(edits, inverses, ...)
       |
       +------> grid.content = newContent
       |
       +------> scheduleRender()   (rAF coalesce)
       |             |
       |             +---> loadTextAsync(grid.content)
       |                        |
       |                        +---> Worker: buildBatchBuffers()
       |                        +---> GPU upload
       |
       +------> provider.applyEdits(uri, editBatch)  (async, fire-and-forget)
                     |
                     +---> on response: reconcile version
```

The key insight: the **TextBuffer** is the single chokepoint. Everything
upstream produces TextEdit[]. Everything downstream consumes either the
new content string (renderer) or the inverse TextEdit[] (history). The
buffer implementation is hidden behind one method.

---

## 2. The CodeMirror Lesson: Pre-Document Positions

CodeMirror 6's rule: all positions in a transaction reference the document
state *before* any edit in the batch is applied. "They conceptually all
happen at once."

This matters for multi-edit batches (e.g., multi-cursor, find-and-replace).
If edit A inserts 3 characters at line 5, edit B's position at line 10 does
NOT need adjustment -- both reference the original document.

The buffer is responsible for sorting and applying edits in reverse document
order (bottom-to-top, right-to-left) so that earlier edits don't shift
later ones. The caller never adjusts positions.

```js
// TextBuffer interface -- the abstraction boundary
class TextBuffer {
    /**
     * Apply edits atomically. All positions reference the current document.
     * @param {TextEdit[]} edits - positions in pre-apply document
     * @returns {ApplyResult}
     */
    applyEdits(edits) { /* ... */ }

    /** Current content as string (for renderer consumption) */
    toString() { /* ... */ }

    /** Line content by index */
    getLine(lineIndex) { /* ... */ }

    /** Total line count */
    get lineCount() { /* ... */ }
}
```

This interface works identically for:
- **Flat string**: `applyEditsToString()` from `textEditUtils.js` (Phase 1)
- **Piece table**: split/insert descriptors, toString() concatenates pieces
- **CRDT (Yjs/Loro)**: map TextEdit positions to CRDT positions, apply ops

---

## 3. Inverse Computation: Buffer's Responsibility

The buffer MUST produce inverses because only the buffer holds the "before"
content at the moment of application. This follows CodeMirror's
`ChangeSet.invert(doc)` pattern.

```js
// Inside TextBuffer.applyEdits():
applyEdits(edits) {
    // Sort reverse document order (bottom-right first)
    const sorted = [...edits].sort((a, b) => {
        const lineDiff = b.range.start.line - a.range.start.line;
        return lineDiff !== 0 ? lineDiff : b.range.start.character - a.range.start.character;
    });

    const inverses = [];
    for (const edit of sorted) {
        // Capture replaced text BEFORE mutation
        const replaced = this.extractRange(edit.range.start, edit.range.end);
        const endAfterInsert = advancePosition(edit.range.start, edit.newText);

        inverses.push({
            range: { start: { ...edit.range.start }, end: { ...endAfterInsert } },
            newText: replaced
        });

        this._mutate(edit);  // buffer-specific mutation
    }

    // Inverses are in reverse order -- applying them undoes bottom-to-top
    // which is correct since they reference the post-edit document
    return {
        newContent: this.toString(),
        inverses,  // already in correct application order for undo
        treeSitterDescs: sorted.map(e => this._toTSDesc(e))
    };
}
```

Why not external? If inverse computation is external (as `computeInverseBatch`
in `textEditUtils.js` currently is), the caller must hold a content snapshot
before calling the buffer. This works for a flat string but breaks the
abstraction -- a piece table or CRDT caller would need to serialize to string
just to compute inverses. Pushing it into the buffer lets each implementation
use its native representation.

**Phase 1 escape hatch**: The flat-string `TextBuffer` implementation can
literally delegate to `computeInverseBatch` from `textEditUtils.js` internally.
No new complexity.

---

## 4. The Re-Render Trigger: Full Now, Delta Later

### Phase 1: Full Re-render (current plan)

```
  grid.content = applyResult.newContent
       |
       v
  requestAnimationFrame(() => {
      grid.loadTextAsync(grid.content)   // full worker rebuild
  })
```

This is the `loadTextAsync` path that already exists in `CodeGrid.js` (line 123).
Worker round-trip is <15ms for 50k chars. Good enough for interactive editing.

### Phase N: Partial Buffer Update

The pipeline is designed so this transition requires NO upstream changes.
The buffer already returns `treeSitterDescs` (edit descriptors for tree-sitter)
which encode `{ startByte, oldEndByte, newEndByte, startPoint, oldEndPoint, newEndPoint }`.
These same descriptors tell the renderer exactly what shifted:

```
  Future: grid.applyBufferDelta(edits, applyResult)
       |
       v
  1. Compute affected slot range from edit positions + slotToPos
  2. Shift slots after edit via copyWithin on Float32Arrays
  3. Rebuild only affected glyph slots via buildGlyphBuffers (partial)
  4. addUpdateRange() for the changed region only
  5. Update _lineSlotBase incrementally
```

What we design NOW to not block this:

- **slotToPos** (consolidated-plan item 13): already planned. Maps buffer slots
  back to source positions. With this, we can find the slot range affected by
  a TextEdit without scanning the entire buffer.

- **ApplyResult.treeSitterDescs**: carry edit descriptors through the pipeline
  even if nothing consumes them yet. Zero cost (small array of objects).

- **Don't bake "full content string" into the render API.** The render path
  should accept `grid.content` (from `buffer.toString()`), not require edits
  to provide the full string directly. This way, swapping to a delta path
  later means changing only `CodeGrid._applyEdit()`, not every caller.

---

## 5. The ChangeSet Type

Should the pipeline use bare `TextEdit[]` or a richer `ChangeSet` object?

**Answer: bare `TextEdit[]` with an `EditTransaction` wrapper at the entry point.**

```js
/**
 * @typedef {Object} EditTransaction
 * @property {TextEdit[]} edits       - pre-document positions
 * @property {string} label           - "typing" | "paste" | "delete" | ...
 * @property {number} baseVersion     - version these edits apply against
 */
```

Rationale:
- `TextEdit[]` is the LSP lingua franca. Provider, relay, tree-sitter, and
  highlight commands all speak it natively. No translation layer.
- A CodeMirror-style `ChangeSet` (position map with retained/inserted/deleted
  spans) is more powerful but adds complexity we don't need without
  collaborative editing. It's an internal optimization of the buffer, not
  a pipeline-level type.
- If we later adopt Yjs/Loro, their native operations map FROM `TextEdit[]`
  at the buffer boundary. The rest of the pipeline stays unchanged.

The `EditTransaction` wrapper adds label + version for history/provider,
but the edits themselves remain plain `TextEdit[]`.

---

## 6. Dual-Write Flow & Buffer Abstraction

```
  EditorInputManager
       |
       |  1. buffer.applyEdits(edits)     -- synchronous, instant
       |     -> ApplyResult { newContent, inverses }
       |
       |  2. editHistory.record(...)      -- synchronous, instant
       |
       |  3. grid.content = newContent    -- synchronous
       |     cursor updated immediately
       |
       |  4. scheduleRender()             -- rAF (next frame)
       |
       |  5. provider.applyEdits(uri, {   -- async (fire-and-forget)
       |         edits, baseVersion, label
       |     })
       |
       v  6. On provider response:
       |     if (response.version === localVersion + 1) {
       |         // Expected. Update localVersion.
       |         // Optionally replace optimistic inverses with
       |         // provider-authoritative inverses.
       |     } else if (response is VersionConflict) {
       |         // External edit landed first. Re-read + rebase.
       |     }
```

The buffer abstraction is invisible to steps 4-6. The provider receives
`TextEdit[]` and a version -- it doesn't know or care what buffer produced
them. The renderer receives `grid.content` (a string) -- it doesn't know
what data structure backs it.

**Conflict recovery**: On VersionConflict, the buffer is replaced wholesale:
```js
buffer = new TextBuffer(freshContent);  // from provider re-read
editHistory.clear();                     // history is invalid
grid.loadTextAsync(freshContent);        // full re-render
```

This is the nuclear option but it's correct. Incremental conflict
resolution (OT/CRDT rebase) is a future concern.

---

## 7. Tree-Sitter Integration

The edit descriptor format tree-sitter needs is a strict subset of what
the buffer already computes:

```
  TextEdit                          TSEditDescriptor
  { range, newText }    ----->      { startByte, oldEndByte, newEndByte,
                                      startPoint, oldEndPoint, newEndPoint }

  Conversion (inside TextBuffer):
  _toTSDesc(edit) {
      const startByte = this.positionToOffset(edit.range.start);
      const oldEndByte = this.positionToOffset(edit.range.end);
      const newEndByte = startByte + byteLength(edit.newText);
      return {
          startByte, oldEndByte, newEndByte,
          startPoint: { row: edit.range.start.line, column: edit.range.start.character },
          oldEndPoint: { row: edit.range.end.line, column: edit.range.end.character },
          newEndPoint: posToPoint(advancePosition(edit.range.start, edit.newText))
      };
  }
```

Full flow with tree-sitter (future):

```
  buffer.applyEdits(edits)
       |
       +---> ApplyResult.treeSitterDescs
                  |
                  v
             tree.edit(desc)          -- for each desc, mutate old tree
                  |
                  v
             parser.parse(newContent, oldTree)
                  |
                  v
             changedRanges = tree.getChangedRanges(oldTree, newTree)
                  |
                  v
             for each range: re-highlight affected lines
                  (write new colors to instanceColor buffer slots)
                  (addUpdateRange for changed color region only)
```

The critical design point: tree-sitter descriptors come from the buffer,
not from the renderer or the input manager. The buffer is the single
source of truth for "what changed where."

---

## 8. Concrete Code References & Touch Points

| Component | File | What changes |
|-----------|------|-------------|
| TextBuffer interface | `app/editing/TextBuffer.js` (new) | `applyEdits()`, `toString()`, `getLine()` |
| Flat string impl | `app/editing/StringBuffer.js` (new) | Wraps `textEditUtils.js` functions |
| textEditUtils | `app/editing/textEditUtils.js` | Already planned; `computeInverse`, `applyEdit`, `advancePosition` |
| EditorInputManager | `app/EditorInputManager.js` | Calls `buffer.applyEdits()`, not raw string manipulation |
| EditHistory | `app/EditHistory.js` | Receives inverses FROM buffer, never computes them |
| CodeGrid | `src/collections/CodeGrid.js` | Gains `this._buffer = null`; `loadTextAsync` reads `buffer.toString()` |
| Provider path | `src/services/data/FileSystemRegistry.js` | Receives bare `TextEdit[]` + version, buffer-unaware |
| Builder pipeline | `src/workers/builders/index.js` | Unchanged -- receives string, returns buffers + slotToPos |
| Highlight commands | `app/commands/handlers/highlightCommands.js` | Unchanged -- reads `grid.lines`, `grid._lineSlotBase` |

---

## 9. The N to N+1 Transition Path

| Phase | Render strategy | Buffer role | What ships |
|-------|----------------|-------------|------------|
| Phase 1 | Full `loadTextAsync` per edit | `StringBuffer` wrapping flat string | Functional editing, <15ms re-render |
| Phase 1.5 | Color-only partial update | Buffer + tree-sitter descriptors | Syntax re-highlight without geometry rebuild |
| Phase 2 | Geometry delta (copyWithin) | Buffer tracks affected slot ranges | Slot shifting, partial `addUpdateRange` |
| Phase 3 | Piece table / CRDT buffer | Swap `StringBuffer` for `PieceTableBuffer` | Same `applyEdits()` interface, O(log n) ops |

Each transition changes only the buffer implementation and/or the render
path inside `CodeGrid`. The input manager, edit history, provider, and
command system remain untouched because they speak `TextEdit[]` at every
boundary.

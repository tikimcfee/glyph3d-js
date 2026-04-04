# Unit of Work: Grid Editing Layer Analysis

## 1. `FileContent` Gains a Version

Add `version: number` -- monotonic, starts at 1 on first load, increments on every applied edit. Local to the browser session, not sourced from the provider. The provider interface is unchanged; versioning is a UI concern. `CodeGrid` gains `this._version = 0`, set by the editing layer on load.

## 2. Revised `EditHistory`

```js
/** @typedef {Object} EditEntry
 * @property {TextEdit[]} forward      - edits as applied
 * @property {TextEdit[]} inverse      - edits that reverse .forward
 * @property {number} versionBefore
 * @property {number} versionAfter
 * @property {Position} cursorBefore   - Position = { line, character }
 * @property {Position} cursorAfter
 * @property {string|null} label       - coalesce group label */

class EditHistory {
    constructor(maxEntries = 200) {
        this._undoStack = [];   // EditEntry[]
        this._redoStack = [];   // EditEntry[]
        this._maxEntries = maxEntries;
        this._coalesceGroup = null;
    }
    recordEdit(forward, inverse, vBefore, vAfter, cursorBefore, cursorAfter, label) { /*...*/ }
    undo()  { /* flushes active coalesce group first, pops undoStack, pushes to redo */ }
    redo()  { /* pops redoStack, pushes to undo */ }
    flushCoalesceGroup() { /* seal active group into a single EditEntry */ }
    get canUndo() { return this._undoStack.length > 0 || this._coalesceGroup !== null; }
    get canRedo() { return this._redoStack.length > 0; }
}
```

Replaces the convergence doc's snapshot-based `EditHistory`. Forward/inverse pairs cost O(edit size) instead of O(file size) per entry.

## 3. Inverse TextEdit Computation

Three cases, all special cases of one general algorithm:

```
Insertion:   forward { range: [P,P],   newText: "abc" }
             inverse { range: [P,P'],  newText: ""    }   P' = advancePosition(P, "abc")

Deletion:    forward { range: [P1,P2], newText: ""    }
             inverse { range: [P1,P1], newText: extractRange(content, P1, P2) }

Replacement: forward { range: [P1,P2], newText: "xyz" }
             inverse { range: [P1,P1'], newText: extractRange(content, P1, P2) }
                                                          P1' = advancePosition(P1, "xyz")
```

### Core algorithm

```js
function computeInverse(edit, content) {
    const replacedText = extractRange(content, edit.range.start, edit.range.end);
    const endAfterInsert = advancePosition(edit.range.start, edit.newText);
    return {
        range: { start: { ...edit.range.start }, end: { ...endAfterInsert } },
        newText: replacedText
    };
}

function computeInverseBatch(edits, content) {
    const inverses = [];
    let cur = content;
    for (const edit of edits) {
        inverses.push(computeInverse(edit, cur));
        cur = applyEdit(cur, edit);
    }
    return inverses.reverse(); // undo applies bottom-to-top
}
```

### Helpers (pure, worker-safe -- `app/editing/textEditUtils.js`)

```js
function positionToOffset(content, pos) {
    let off = 0, line = 0;
    for (let i = 0; i < content.length; i++) {
        if (line === pos.line) return off + pos.character;
        if (content[i] === '\n') { line++; off = i + 1; }
    }
    return off + pos.character;
}

function advancePosition(pos, text) {
    let line = pos.line, ch = pos.character;
    for (const c of text) { if (c === '\n') { line++; ch = 0; } else ch++; }
    return { line, character: ch };
}

function extractRange(content, start, end) {
    return content.slice(positionToOffset(content, start), positionToOffset(content, end));
}
```

## 4. Edit Coalescing

Rapid keystrokes ("hello") undo as one step via coalesce groups.

```js
/** @typedef {Object} CoalesceGroup
 * @property {string} label
 * @property {TextEdit[]} forwards
 * @property {TextEdit[]} inverses  - accumulated in reverse order
 * @property {number} versionBefore
 * @property {Position} cursorBefore
 * @property {number} timeoutId */
```

**Group starts**: character typed with no active group, or label changes.
**Group ends** (flushes to single `EditEntry`): non-character edit (Enter, cross-line Backspace, paste), cursor moves without edit, 300ms timeout, undo/redo requested, label changes.

| Action | Label | Coalesces? |
|--------|-------|------------|
| Character typed | `"typing"` | Yes |
| Backspace (same line) | `"delete"` | Yes |
| Enter, paste, cross-line BS | `null` | No -- immediate entry |

`recordEdit` checks: if `label` matches active group and not timed out, append. Otherwise flush existing group, start new (or push standalone if `label` is null).

## 5. Cursor Position Storage

Stored as `{ line, character }` (raw source coords, LSP-compatible), not buffer slot index. Slots are invalidated on re-render; source positions survive.

- **Undo**: restore `entry.cursorBefore`
- **Redo**: restore `entry.cursorAfter`
- **Multi-cursor** (future): `cursorBefore`/`cursorAfter` become `Position | Position[]`; check `Array.isArray` at restore time. No structural change to `EditEntry` needed.

## 6. `slotToPos` Rebuilds on Undo

Full re-render. The builder rebuilds `slotToPos` from scratch as part of the normal pipeline. No special handling.

1. `editHistory.undo()` returns `EditEntry`
2. Apply `entry.inverse` to content
3. `grid._version = entry.versionBefore`
4. `grid.loadTextAsync(restoredContent)` -- rebuilds `slotToPos`, `lineSlotBase`, etc.
5. After async render: `rawColToSlotCol(entry.cursorBefore.line, entry.cursorBefore.character)` to get slot, then `setCursorAtSlot`

Step 5 goes in `.then()` / `await` since `loadTextAsync` is async (worker round-trip).

## 7. rAF Debouncing vs Edit Batching

Two independent timers:
- **rAF (16ms)**: rendering optimization. Batches pending content into one `loadTextAsync` call per frame.
- **Coalesce timer (300ms)**: undo granularity. Collects sequential same-label edits into one undo step.

Each keystroke immediately: computes inverse, records in coalesce group, updates in-memory content and cursor. The rAF callback flushes the visual render and batches relay `applyEdits` calls.

Example -- typing "abc" within one frame:
- 3 `recordEdit` calls, same coalesce group (label `"typing"`)
- 1 rAF fires, one `loadTextAsync`, one relay `applyEdits` with 3 TextEdits
- On undo: flushed coalesce group undoes all 3 as one step

The coalesce group stays open across rAF boundaries as long as typing continues within 300ms.

## 8. Multi-Cursor / Selection (Future-Proofing Only)

`EditEntry.forward` is already `TextEdit[]`. Multi-cursor: N edits per keystroke applied bottom-to-top (highest position first to avoid shifting). N inverse edits computed per cursor. `cursorBefore`/`cursorAfter` typed as `Position | Position[]`.

Selection-based replacement: a TextEdit with non-empty range and non-empty newText -- already the general case. No changes needed.

## 9. Code Changes Summary

### No changes to `src/workers/builders/index.js`
Inverse computation operates on source text, not buffer data. The `slotToPos`/`lineVisCharCounts` additions from the convergence doc are sufficient.

### `src/collections/CodeGrid.js`
Add `this._version = 0` and `this._editHistory = null`. `loadTextAsync` accepts optional version parameter.

### `app/EditHistory.js`
Replace snapshot-based design with versioned forward/inverse. API: `recordEdit`, `undo`, `redo`, `flushCoalesceGroup`, `canUndo`, `canRedo`.

### `app/EditorInputManager.js`
Replace `push(edit, contentBefore)` with:
```js
const inverse = computeInverse(edit, grid.content);
grid._version++;
editHistory.recordEdit([edit], [inverse], vBefore, vAfter, cursorBefore, cursorAfter, label);
```

Undo: apply `entry.inverse` to content, set `grid._version = entry.versionBefore`, `loadTextAsync(content).then(() => restoreCursor(entry.cursorBefore))`.

### New: `app/editing/textEditUtils.js`
Pure functions: `computeInverse`, `computeInverseBatch`, `applyEdit`, `positionToOffset`, `advancePosition`, `extractRange`. No DOM/Three.js dependencies.

## 10. Decision Table

| Aspect | Convergence (Phase 1) | Revised (Unit of Work) |
|--------|----------------------|----------------------|
| History entries | Content snapshots | Forward/inverse TextEdit pairs |
| Versioning | None | Monotonic per-grid, brackets each entry |
| Cursor in history | Not stored | `cursorBefore`/`cursorAfter` per entry |
| Coalescing | Not addressed | Label-based groups, 300ms timeout |
| Inverse computation | Deferred | Day-one, computed at edit time |
| Multi-cursor | Not mentioned | Forward-compatible via `Position[]` |
| Builder changes | slotToPos addition | Same -- no additional changes |
| slotToPos on undo | Not addressed | Full re-render, rebuilt naturally |

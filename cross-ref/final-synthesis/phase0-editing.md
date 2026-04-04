# Editing Pipeline: Design Contract

Final synthesis of consolidated plan, boundaries analysis, adversarial review, unit-of-work refinements, and research survey. This document defines types, algorithms, and integration points. Implementation follows this contract.

---

## 1. Persistence Model: Optimistic with Rollback

The adversarial review correctly identified that "fire-and-forget" and "version conflict detection" are contradictory. Resolution:

**Persistence is optimistic-confirmed.** The browser applies edits immediately to in-memory state and renders optimistically. The provider call is async but its outcome is observed and acted upon. This is not fire-and-forget (we handle failures) and not blocking (we don't wait before rendering).

### Error recovery sequence

```
1. User types character
2. Apply edit to TextBuffer immediately (optimistic)
3. Compute client-side inverse, push to EditHistory
4. Schedule render via rAF
5. Send provider.applyEdits(uri, editBatch) -- async
6. On success: update localVersion from response; optionally replace
   client inverse with provider's authoritative inverse
7. On failure:
   a. Apply client-side inverse to TextBuffer (rollback)
   b. Pop the entry from EditHistory
   c. Schedule render via rAF
   d. Surface error to user via DebugConsole/status bar
   e. Mark grid as "sync failed" (visual indicator, not blocking)
```

Failure means: network error, relay crash, disk full, permission denied. NOT version conflict -- that is a separate path (see section 4).

Why rollback instead of "leave dirty": a dirty-but-diverged buffer is a trap. The user continues editing, building more state on top of a phantom base. On reconnect, reconciliation becomes arbitrarily hard. Rolling back immediately keeps the buffer authoritative-equal-to-disk at all times, at the cost of losing a keystroke during a network failure.

**Rate limiting:** If three consecutive `applyEdits` calls fail, stop sending edits and enter "offline mode" -- edits accumulate locally, a reconnect timer periodically retries. On successful reconnect, send the full content via `writeFile` (not incremental edits, since the version has drifted). This is the only case where `writeFile` is used for interactive editing.

---

## 2. applyEdits Position Semantics

The adversarial review found a real bug: the boundaries-synthesis `StringBuffer.applyEdits` sorts edits bottom-to-top, then applies them sequentially against a mutating `text` variable, while the contract says positions reference pre-edit state.

### The correct algorithm

All positions in an `TextEdit[]` batch reference the document state BEFORE any edit in the batch. Overlapping edits within a batch are **rejected** (throw). The algorithm:

```
applyEdits(edits):
  sorted = copy(edits).sort(bottom-to-top by start position)
  
  // Validate: no overlaps
  for i in 1..sorted.length:
    if rangeOverlaps(sorted[i-1].range, sorted[i].range):
      throw "Overlapping edits are not supported"
  
  // Compute ALL offsets from the ORIGINAL text before any mutation
  resolved = []
  for edit in sorted:
    startOffset = positionToOffset(this._text, edit.range.start)
    endOffset   = positionToOffset(this._text, edit.range.end)
    resolved.push({ startOffset, endOffset, newText: edit.newText })
  
  // Compute inverses from the ORIGINAL text before any mutation
  inverse = []
  for i in 0..resolved.length:
    deletedText = this._text.substring(resolved[i].startOffset, resolved[i].endOffset)
    endAfterInsert = advancePosition(sorted[i].range.start, sorted[i].newText)
    inverse.unshift({
      range: { start: sorted[i].range.start, end: endAfterInsert },
      newText: deletedText
    })
  
  // Apply mutations bottom-to-top (high offsets first, so lower offsets stay valid)
  text = this._text
  for { startOffset, endOffset, newText } in resolved:  // already bottom-to-top
    text = text.substring(0, startOffset) + newText + text.substring(endOffset)
  
  this._text = text
  this._lineOffsets = null
  return { content: text, inverse }
```

Why this works: because edits are non-overlapping and sorted bottom-to-top, each splice only affects text at or after the splice point. Lower offsets (computed from the original text) remain valid because we splice from the bottom up.

Why reject overlapping edits: overlapping edits within a single batch have ambiguous semantics (which edit "wins" in the overlapped region?). CodeMirror rejects them. LSP rejects them. Every production editor rejects them. Multi-cursor produces non-overlapping edits by construction (cursors are disjoint selections).

---

## 3. treeSitterDescs: Deferred

The adversarial review correctly identified that computing byte offsets via `new TextEncoder().encode()` on every edit is wasteful -- two allocations per edit on the hot typing path, for a consumer that does not exist.

**Decision: drop `treeSitterDescs` from `ApplyResult`.** The return type is:

```js
/** @typedef {Object} ApplyResult
 *  @property {string} content    - full text after edits
 *  @property {TextEdit[]} inverse - edits that reverse this batch
 */
```

When tree-sitter integration arrives, the edit descriptors can be computed from the `TextEdit[]` that was applied. The information is the same -- `{startByte, oldEndByte, newEndByte}` is derivable from `{range, newText}` plus the document state before the edit. The buffer already captures the inverse (which encodes the deleted text length). A future `treeSitterDescFromEdit(edit, inversEdit)` utility can produce the descriptor without touching TextEncoder:

```
startByte: positionToByteOffset(doc, edit.range.start)   // walk + accumulate
oldEndByte: startByte + byteLength(inverseEdit.newText)   // inverse.newText IS the deleted text
newEndByte: startByte + byteLength(edit.newText)
```

This defers the byte-offset question to when it matters, and `byteLength` can use a lookup table for ASCII (the common case) with TextEncoder fallback only for non-ASCII. No allocation on the hot path for English/code text.

---

## 4. Version Numbers

### When they arrive

Version numbers are a **Tier 1 addition** to `FileContent` and `FileStat`. They travel on the wire from day one. The read-only phase uses them for:

- Stale-version detection on `fs/didChange` (skip reload if version matches last read)
- Cache validation (version in `StatePersistence`)

The editing phase additionally uses them for:

- `baseVersion` in `EditBatch` for conflict detection
- `versionBefore`/`versionAfter` in `EditHistory` entries

### Minimum viable versioning

```js
// Provider-authoritative. Client never increments -- only stores what the provider returns.
// Tier 1: set on readFile, compared on didChange.
// Tier 2: sent as baseVersion in EditBatch, updated from EditResult.

grid._version = 0;  // unloaded
// After readFile:  grid._version = response.version   (1, 2, ...)
// After applyEdits: grid._version = response.version  (previous + 1)
```

For the GitHub provider: version is always 0 (immutable, commit-pinned). For the memory provider: simple counter. For the remote provider: the Go relay is authoritative.

### Version conflict path

A `-32007 VersionConflict` means an external edit landed between our last read and our write attempt. Recovery:

```
1. Receive -32007 with { expectedVersion, currentVersion }
2. Re-read the file: provider.readFile(uri) -> fresh content + version
3. Clear EditHistory (the inverse edits reference a document state that no longer exists)
4. Set grid content to fresh content, grid._version to fresh version
5. Full re-render
6. Surface "File changed externally, edits reloaded" to user
```

No automatic rebase. The user's pending edit is lost. This is acceptable because: (a) the window between optimistic apply and provider confirmation is <50ms on localhost, (b) external edits during active typing are rare, (c) automatic rebase is a collaboration feature (Tier 5 CRDT territory).

---

## 5. EditHistory Design

### Minimal form (what ships in Tier 2)

```js
/** @typedef {Object} EditEntry
 *  @property {TextEdit[]} forward   - edits as applied
 *  @property {TextEdit[]} inverse   - edits that reverse forward
 *  @property {string|null} label    - coalesce group identifier
 *  @property {number} versionBefore
 *  @property {number} versionAfter
 *  @property {number} timestamp     - Date.now() at creation, for coalesce window
 */

class EditHistory {
    constructor(maxEntries = 200) {
        this._undoStack = [];         // EditEntry[]
        this._redoStack = [];         // EditEntry[]
        this._maxEntries = maxEntries;
        this._pendingGroup = null;    // active coalesce group
    }

    push(forward, inverse, label, vBefore, vAfter) { ... }
    undo() -> EditEntry | null  { ... }
    redo() -> EditEntry | null  { ... }
    flushGroup() { ... }
    rollbackLast() { ... }  // for error recovery (section 1 step 7b)
    clear() { ... }
    get canUndo() { ... }
    get canRedo() { ... }
}
```

No cursor tracking. The adversarial review was right: there is no cursor, no selection model, no input system yet. Designing cursor persistence into the undo structure before those systems exist couples EditHistory to a cursor representation that may be wrong.

### When cursor arrives (Tier 2, after EditorInputManager exists)

```js
/** @typedef {Object} EditEntry
 *  @property {TextEdit[]} forward
 *  @property {TextEdit[]} inverse
 *  @property {string|null} label
 *  @property {number} versionBefore
 *  @property {number} versionAfter
 *  @property {number} timestamp
 *  @property {Position|Position[]|null} cursorBefore  // ADDED
 *  @property {Position|Position[]|null} cursorAfter   // ADDED
 */
```

The fields are nullable from day one (EditHistory ignores null cursor fields). EditorInputManager populates them when it exists. `Position|Position[]` handles multi-cursor without structural changes. EditHistory does not interpret cursor values -- it stores and returns them. The input manager restores cursor position on undo/redo.

---

## 6. Coalescing Algorithm

### Design

The 300ms timeout from the consolidated plan is close but needs tighter specification. After reviewing CodeMirror's approach (which uses `newGroupDelay` of 500ms and boundary detection on selection changes), the algorithm:

```
COALESCE_TIMEOUT = 300   // ms, tighter than CodeMirror's 500 -- 3D viewer has simpler edit patterns
```

### Algorithm

```
push(forward, inverse, label, vBefore, vAfter):

  // 1. If label is null, this is a non-coalesceable edit (paste, enter, multi-line delete)
  if label is null:
    flushGroup()
    pushEntry(new EditEntry(forward, inverse, null, vBefore, vAfter, Date.now()))
    return

  // 2. If there's an active group with same label and within timeout
  if _pendingGroup
     AND _pendingGroup.label === label
     AND (Date.now() - _pendingGroup.timestamp) < COALESCE_TIMEOUT:
    
    _pendingGroup.forward.push(...forward)
    _pendingGroup.inverse.unshift(...inverse)  // inverse applies in reverse order
    _pendingGroup.versionAfter = vAfter
    _pendingGroup.timestamp = Date.now()       // extend the window
    resetCoalesceTimer()
    return

  // 3. Otherwise: flush existing group, start new one
  flushGroup()
  _pendingGroup = new EditEntry(forward, inverse, label, vBefore, vAfter, Date.now())
  startCoalesceTimer()

flushGroup():
  if _pendingGroup is null: return
  clearCoalesceTimer()
  pushEntry(_pendingGroup)
  _pendingGroup = null

pushEntry(entry):
  _undoStack.push(entry)
  _redoStack = []    // new edit kills redo branch
  if _undoStack.length > _maxEntries:
    _undoStack.shift()
```

### Coalesce boundaries (what forces a flush)

| Event | Flushes? | Rationale |
|-------|----------|-----------|
| Label changes (typing -> delete) | Yes | Different user intent |
| 300ms pause in typing | Yes | Natural undo boundary |
| Undo/redo requested | Yes | Must seal before popping |
| Enter key | Yes | Line boundary = undo boundary |
| Paste | Yes | Paste is atomic regardless of size |
| Multi-line backspace | Yes | Structural change |
| Version conflict / error recovery | Yes (clear all) | History is invalid |

### Timer mechanics

The coalesce timer is a `setTimeout(flushGroup, COALESCE_TIMEOUT)`. Each new edit within the group resets it. The timer flushes the group if no new edit arrives within the window. This means: typing "hello" with <300ms between keystrokes is one undo step. Pausing for 300ms+ and typing "world" is a second undo step.

---

## 7. Error Recovery Summary

| Failure | Detection | Recovery |
|---------|-----------|----------|
| `applyEdits` network error | Promise rejection | Rollback optimistic apply via inverse, pop EditHistory, surface error |
| `applyEdits` returns -32002 PermissionDenied | Error code | Rollback, disable editing for this grid, surface error |
| `applyEdits` returns -32007 VersionConflict | Error code | Re-read file, clear EditHistory, full re-render, surface message |
| Go relay crash (WebSocket close) | `onclose` event | Enter offline mode, queue edits, reconnect timer |
| Reconnect after offline mode | WebSocket open | Send full content via `writeFile`, resume normal flow |
| `readFile` fails during conflict recovery | Promise rejection | Surface error, leave grid in last-known state, retry button |

---

## 8. The N -> N+1 Boundary

### Designed now (types and interfaces, in this document)

- `TextEdit`, `EditBatch`, `EditResult`, `ApplyResult` -- type definitions
- `TextBuffer` interface: `getText()`, `getLine(n)`, `getLineCount()`, `getLines()`, `applyEdits(edits) -> ApplyResult`
- `EditHistory` API: `push()`, `undo()`, `redo()`, `flushGroup()`, `rollbackLast()`, `clear()`
- `CodeGrid.applyEdits(TextEdit[])` -- coordinator method signature
- Error recovery sequences
- Coalescing algorithm
- Backward-compatible getters (`grid.content`, `grid.lines`)

### Built in Tier 1 (read-only provider layer)

- `version` field on `FileContent` and `FileStat`
- `FileSystemProvider` interface with `applyEdits` signature (returns `Promise<EditResult>`)
- `CodeGrid.uri` field
- `-32007 VersionConflict` error code
- `fs/didChange` with version field

### Built in Tier 2 (editing pipeline)

- `StringBuffer` class (implements TextBuffer interface)
- `EditHistory` class (minimal form, no cursor)
- `textEditUtils.js`: `computeInverse()`, `applyEditsToString()`, `positionToOffset()`, `advancePosition()`
- `CodeGrid.applyEdits()` coordinator method
- `EditorInputManager` (keyboard capture, TextEdit generation)
- Error recovery implementation
- `slotToPos` in builder output

### Deferred (Tier 3+)

- Cursor tracking in EditHistory (after EditorInputManager proves cursor model)
- Tree-sitter integration and `treeSitterDescs` (after syntax highlighting exists)
- PieceTableBuffer / RopeBuffer (after profiling shows StringBuffer is the bottleneck)
- Incremental buffer updates (after full re-render proves too slow for large files)
- Multi-cursor editing (after single-cursor is stable)
- Offline edit accumulation and reconciliation (after basic editing is stable)
- Edit history persistence across page refresh
- CRDTBuffer for collaboration

### What is explicitly NOT in scope for Tier 2

- Grapheme cluster / supplementary plane fixes in the builder (real bug, separate workstream)
- `fs/capabilities` notification (the adversarial review was right -- three known providers don't need capability discovery)
- Batch `fs/readFiles` (optimization, not editing)
- `fs/didChange` backpressure (robustness, not editing)
- Symlink security hardening in Go relay (security, not editing)

---

## Appendix: Type Definitions

```js
/** @typedef {{ line: number, character: number }} Position
 *  0-based. character = UTF-16 code unit offset into the source line (LSP convention). */

/** @typedef {{ start: Position, end: Position }} Range */

/** @typedef {{ range: Range, newText: string }} TextEdit */

/** @typedef {{ edits: TextEdit[], baseVersion: number, label?: string }} EditBatch */

/** @typedef {{ content: string, inverse: TextEdit[] }} ApplyResult */

/** @typedef {{ uri: string, content: string, stat: FileStat, version: number,
 *              baseVersion: number, applied: TextEdit[], inverse: TextEdit[] }} EditResult */
```

```js
// TextBuffer interface (implemented by StringBuffer, future PieceTableBuffer, etc.)
// Never exposed outside CodeGrid.

getText()          -> string
getLine(n)         -> string
getLineCount()     -> number
getLines()         -> string[]           // materialized, backward compat
applyEdits(edits)  -> ApplyResult        // positions are pre-edit, non-overlapping
```

```js
// CodeGrid coordinator method
grid.applyEdits(edits: TextEdit[], label?: string):
  result = this._buffer.applyEdits(edits)
  vBefore = this._version
  this._version++                        // optimistic local increment
  this._editHistory.push(edits, result.inverse, label, vBefore, this._version)
  this._scheduleRender()
  this._persistToProvider(edits, vBefore) // async, handles errors per section 1
```

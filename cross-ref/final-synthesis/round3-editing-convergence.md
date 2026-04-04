# Round 3: editing convergence

## Settled

1. **Position.character uses grapheme indices, not UTF-16 code units.** All three reviews independently identified the UTF-16 vs grapheme mismatch as the single most dangerous cross-boundary bug. The LSP convention (UTF-16 code units) was chosen in my Phase 0 for protocol compatibility, but this project has no LSP server. The renderer is converting to grapheme clusters. The buffer layer should match. `Position.character` = grapheme cluster index within the line. If LSP integration ever arrives, the translation layer lives at the LSP protocol boundary (a thin adapter that converts UTF-16 offsets to grapheme indices using `Intl.Segmenter`), not inside our editing types. This eliminates the coordinate-space mismatch at the cost of a convention divergence that affects zero current consumers.

2. **Version numbers ship as optional nullable in Tier 1.** Foundation was right that conflict detection is Tier 2 work. I was right that the field shape must exist on the wire from day one to avoid a breaking protocol change. The resolution from Foundation's own review (item 4 in recommendations) is correct: add `version` as an optional field to `FileContent` and `FileStat` in `types.js`. Value: `null` for GitHub provider, monotonic integer for remote provider. No comparison logic until Tier 2. My Phase 0 overstated this as "Tier 1 addition" when the accurate claim is "Tier 1 field declaration, Tier 2 semantics."

3. **`writeFile` dependency resolved: editing owns it.** My Phase 0 error recovery (section 1, step 35) references `writeFile` for reconnection after offline mode. Foundation correctly flagged this as circular: no tier commits to implementing `writeFile`. Resolution: `writeFile` is a Tier 2 editing deliverable. The reconnection-via-writeFile path is Tier 2 scope, not Tier 1. The Go relay handler for `fs/writeFile` ships alongside the editing pipeline, since it only exists to serve the editor. Tier 1 error recovery for read-only mode is simpler: on WebSocket reconnect, re-read files (already supported). The full-content-sync-via-writeFile path activates only when the editing pipeline is present.

4. **StringBuffer: rendering ships read-only, editing extends.** No remaining disagreement. Rendering creates `src/collections/StringBuffer.js` with `getText()`, `getLine(n)`, `getLineCount()`, `getLines()`. Editing adds `applyEdits(edits) -> ApplyResult` in Tier 2. Constructor signature: `new StringBuffer(text: string)`. File path confirmed: `src/collections/StringBuffer.js`. Editing treats it as pre-existing.

5. **`charCodeAt` fix belongs with the rendering/grapheme work.** Foundation should remove the "separate PR" language. Rendering owns this fix across all sites including `textToGlyphs.js` line 44 and `builders/index.js` line 27.

6. **EditHistory has no cursor fields in Tier 2.** Foundation's review correctly flagged `Position|Position[]` as premature. The minimal EditHistory that does not block multi-cursor later: cursor fields are simply absent (not null, not typed). When `EditorInputManager` ships and proves a cursor model, `EditEntry` gains `cursorBefore` and `cursorAfter` as opaque values that EditHistory stores and returns without interpretation. The type at that point will be whatever the input manager defines -- `Position`, `Position[]`, `Selection`, or something unforeseen. EditHistory is a stack of `{forward, inverse, label, versionBefore, versionAfter, timestamp}`. That is the Tier 2 contract.

7. **Error codes co-located in `types.js`.** Foundation defines -32001/-32002/-32003. Editing adds -32007. All codes belong in `types.js` as named constants, not scattered across documents or files.

8. **`applyEdits` sort range is exclusive upper bound** (standard JS `for (let i = 1; i < sorted.length; i++)`). The pseudocode ambiguity flagged by rendering is resolved: the implementation uses standard JS loop semantics.

9. **`countGlyphs` whitespace check must use `codePointValue <= 32`**, not four named characters. My Phase 0 review of rendering caught this. The existing builder skips all control characters. The grapheme version must preserve that behavior.

10. **StringBuffer normalizes CRLF on construction.** `this._text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')` in the constructor. The builder already skips `\r` (charCode 13), so rendering is unaffected, but `getLine()` returning `"line\r"` would corrupt edit position calculations. Normalize once, never think about it again.

## Implementation Plan

This is the design contract for Tier 2 editing. It defines interfaces, algorithms, and integration points. Rendering's grapheme work and Foundation's provider layer are prerequisites.

### Coordinate space contract

```
Position.character = grapheme cluster index within the line (0-based)
Position.line      = 0-based line number (LF-delimited after CRLF normalization)

positionToOffset(text, pos):
  Walk to line `pos.line` via line offsets.
  From line start, iterate grapheme clusters via Intl.Segmenter.
  Skip `pos.character` clusters. Return the byte offset.

offsetToPosition(text, offset):
  Binary search line offsets for the line.
  From line start to offset, count grapheme clusters.
  Return { line, character: clusterCount }.
```

These two functions live in `src/workers/builders/textEditUtils.js`. They are the only place where grapheme iteration intersects position math. Everything else -- `applyEdits`, `EditHistory`, `highlightRange`, `getSlotForChar` -- uses `Position` values that are already in grapheme space.

### StringBuffer.applyEdits contract (Tier 2 addition)

```js
applyEdits(edits: TextEdit[]): ApplyResult
  // edits: positions in grapheme space, referencing pre-edit document state
  // Non-overlapping or throws. Sorted bottom-to-top internally.
  // Returns { content: string, inverse: TextEdit[] }
  // Invalidates _lineOffsets cache.
```

### CodeGrid.applyEdits coordinator (Tier 2)

```js
applyEdits(edits, label = null):
  result = this._buffer.applyEdits(edits)
  vBefore = this._version
  this._version++
  this._editHistory.push(edits, result.inverse, label, vBefore, this._version)
  this._rebuildSlots()    // re-run builder on changed content
  this._scheduleRender()
  this._persistToProvider(edits, vBefore)  // async, error recovery per section 1
```

`_rebuildSlots()` re-runs the buffer builder to regenerate `lineSlotOffsets` and instance attributes. For Tier 2 this is a full rebuild. Incremental slot updates are Tier 3.

### EditHistory contract (Tier 2)

```js
class EditHistory {
  constructor(maxEntries = 200)
  push(forward: TextEdit[], inverse: TextEdit[], label: string|null,
       vBefore: number, vAfter: number): void
  undo(): EditEntry|null
  redo(): EditEntry|null
  flushGroup(): void
  rollbackLast(): void
  clear(): void
  get canUndo(): boolean
  get canRedo(): boolean
}
```

No cursor fields. No opaque metadata. Coalescing uses label + 300ms timeout as specified in Phase 0 section 6. `rollbackLast()` is the error recovery hook: pops the most recent entry and returns its inverse edits for the caller to apply.

### Error recovery contract

| Failure | Action | writeFile needed? |
|---------|--------|-------------------|
| Single `applyEdits` failure | Rollback via inverse, pop history | No |
| Three consecutive failures | Enter offline mode, queue locally | No |
| Reconnect after offline | `writeFile` full content | Yes (Tier 2 deliverable) |
| -32007 VersionConflict | Re-read, clear history, full re-render | No |
| -32002 PermissionDenied | Rollback, disable editing for grid | No |

### Wire protocol additions (Tier 2)

```
fs/applyEdits  { uri, edits: TextEdit[], baseVersion: number }
             -> { version: number, applied: TextEdit[] }

fs/writeFile   { uri, content: string }
             -> { version: number }
```

Error codes (all in `types.js`):
- -32001 FileNotFound (Foundation Tier 1)
- -32002 PermissionDenied (Foundation Tier 1)
- -32003 TooLarge (Foundation Tier 1)
- -32007 VersionConflict (Editing Tier 2)

### Files touched in Tier 2

| File | Action |
|------|--------|
| `src/collections/StringBuffer.js` | Add `applyEdits()` to existing read-only class |
| `src/collections/EditHistory.js` | New, ~80 lines |
| `src/workers/builders/textEditUtils.js` | New, ~60 lines: `positionToOffset`, `offsetToPosition`, `computeInverse`, `advancePosition` |
| `src/collections/CodeGrid.js` | Add `applyEdits()`, `undo()`, `redo()`, `_editHistory`, `_version` |
| `src/services/data/types.js` | Add `TextEdit`, `EditBatch`, `EditResult`, error code -32007 |
| `cli/fs.go` | Add `fs/applyEdits` and `fs/writeFile` handlers |
| `app/commands/handlers/editCommands.js` | New, WebSocket command wiring |

7 files, 3 new. Scope-appropriate for a single focused tier.

## Implementer Vote

**Foundation** should implement the combined Tier 1 plan. Foundation's scope is the most self-contained: `types.js`, `RemoteFileSystemProvider`, `WebSocketBridge` RPC additions, and `cli/fs.go` handlers are all infrastructure that rendering and editing depend on but that depends on neither. Foundation can land first without merge conflicts. Rendering's grapheme work modifies the same builder files that editing will eventually touch, so rendering should land second (after Foundation) to establish the grapheme-indexed coordinate space that editing's `Position` type relies on. Editing lands last, extending the surfaces that Foundation and Rendering created.

# Round 3: foundation convergence

## Settled

1. **"Character" coordinate space.** Wire protocol uses UTF-16 code unit offsets (LSP convention) -- this is non-negotiable for editor interop. Rendering uses grapheme-cluster slot indices internally. Translation happens at a single boundary: `CodeGrid.utf16ColToSlot(line, utf16Col)` and `CodeGrid.slotToUtf16Col(line, slot)`. These are 5-line functions that walk `StringBuffer.getLine(line)` with `Intl.Segmenter`, accumulating UTF-16 lengths per grapheme until the target is reached. All external APIs (`highlightRange`, `applyEdits`, `Position.character`) speak UTF-16. All internal slot math speaks grapheme indices. No ambiguity remains.

2. **Version numbers ship in Tier 1.** Editing is correct: the cost is one integer field on `FileStat` and `FileContent`, and a monotonic counter in Go. The Go relay sends `version: <modTime-nanos>` (file mtime as int64). The JS side stores it but does not implement conflict detection. `types.js` gains `@property {number} version` on both typedefs. Foundation was wrong to defer this -- the wire protocol shape should be stable from day one.

3. **`CodeGrid.uri` cut from Tier 1.** Rendering and foundation reviews both flagged this as dead code. Adding a field later is a one-line non-breaking change. No consumer exists in Tier 1. Cut.

4. **Synthetic codepoint IDs: compact secondary map, not sparse DataTexture.** IDs at 0x110000 would force a 17MB DataTexture regrow -- the exact regression the memory optimization eliminated. Solution: `GlyphAtlas` gains `_syntheticMap: Map<string, number>` mapping multi-codepoint grapheme strings to dense IDs starting at `maxSingleCodepoint + 1` (roughly 0x2700 today, well within current texture capacity). The atlas map DataTexture stays compact. `_syntheticMap.size` is bounded at 4096 entries (covers any realistic grapheme cluster set). `getOrCreateSyntheticId(graphemeStr)` returns a dense index, not a sparse Unicode-range offset. The builder sends `syntheticId` the same way it sends any codepoint -- the DataTexture just maps it to atlas UVs.

5. **charCodeAt fix belongs to the rendering agent.** Foundation retracts the "separate PR" language. The fix is inseparable from grapheme-cluster iteration and StringBuffer -- they share the invariant of "what is a character." Foundation will not touch `charCodeAt` sites.

6. **`filterCodeFiles` extracted to shared utility.** Both reviews flagged prototype delegation as fragile. New file: `src/services/data/fileFilters.js` (~30 lines). Exports `filterCodeFiles(tree, options)`. Both `RepositoryAdapter` and `RemoteFileSystemProvider` import it. No prototype reaching.

7. **StringBuffer ownership.** Rendering ships read-only `StringBuffer` in `src/collections/StringBuffer.js`. Constructor: `new StringBuffer(text)`. Methods: `getText()`, `getLine(n)`, `getLineCount()`, `getLineLength(n)`. CRLF normalized to LF on construction (`text.replace(/\r\n/g, '\n')`). Editing extends it in Tier 2 by adding `applyEdits()` to the same file. Path and signature are now agreed.

8. **`countGlyphs` whitespace predicate.** Must use codepoint <= 32 check (matching existing builder behavior at `builders/index.js` line 97), not four named characters. Rendering agent's Phase 0 must fix this.

9. **`textToGlyphs.js` added to rendering scope.** Line 44 has the same `charCodeAt` bug. Rendering's file list was missing it. Now included.

10. **WebSocket `onclose` rejects pending RPC promises.** Foundation adds to `WebSocketBridge`: on close, iterate `_rpcPending`, reject each with a connection-closed error, clear the map. Five lines.

11. **Error codes co-located in `types.js`.** Foundation defines -32001/-32002/-32003. Editing's -32007 (version conflict) added to the same file. Single source of truth.

12. **`loadTextAsync` lazy behavior preserved.** StringBuffer's `_lineOffsets` are already lazy (computed on first `getLine()`/`getLineCount()` call). CodeGrid must not eagerly call line methods on the async path. This is a constraint on the rendering agent's migration.

## Implementation Plan

### Foundation (Tier 1) -- 10 files

**`src/services/data/types.js`** -- NEW (~65 lines)
- `FileStat` typedef gains `@property {number} version`
- `FileContent` typedef gains `@property {number} version`
- `FileSystemError` class with factory methods
- Error code constants: `-32001` (NotFound), `-32002` (PermissionDenied), `-32003` (IsDirectory), `-32007` (VersionConflict, reserved for Tier 2)

**`src/services/data/fileFilters.js`** -- NEW (~30 lines)
```js
const BLACKLIST = new Set(['.git', 'node_modules', '.DS_Store', ...]);
const BINARY_EXT = new Set(['.png', '.jpg', '.woff2', ...]);
export function filterCodeFiles(tree, options = {}) { ... }
```

**`src/services/data/RemoteFileSystemProvider.js`** -- NEW (~150 lines)
- Imports `filterCodeFiles` from `fileFilters.js` (not RepositoryAdapter)
- `rpcRequest` error responses mapped via switch on `error.code`:
```js
switch (err.code) {
    case -32001: throw FileSystemError.FileNotFound(uri);
    case -32002: throw FileSystemError.PermissionDenied(uri);
    case -32003: throw FileSystemError.IsDirectory(uri);
    default:     throw new FileSystemError(err.message, err.code, uri);
}
```

**`cli/fs.go`** -- NEW (~200 lines)
- `readFile` returns `version: info.ModTime().UnixMilli()`
- `stat` returns `version: info.ModTime().UnixMilli()`
- Security: EvalSymlinks + prefix check, 5MB file cap, 50k entry cap

**`src/services/orchestration/WebSocketBridge.js`** -- MODIFY (~45 lines added)
- `rpcRequest()` method with pending-promise map
- `_handleMessage` JSON-RPC branch (discriminate on `"jsonrpc"` field)
- `onclose` handler: reject all `_rpcPending` entries

**`cli/relay.go`** -- MODIFY (~25 lines)
- Route JSON-RPC from display to `FSHandler`

**`cli/main.go`** -- MODIFY (~10 lines)
- `--root` flag on serve subcommand

**`app/GitHubRepoViewer.js`** -- MODIFY (~30 lines)
- `?source=local` provider switching

**`src/services/data/index.js`** -- MODIFY (3 lines)
- Export `FileSystemError`, `RemoteFileSystemProvider`, `filterCodeFiles`

**`app/StatePersistence.js`** -- MODIFY (5 lines)
- Source-mode awareness

### Rendering (Phase 0) -- their scope, but foundation depends on agreed interfaces

**`src/collections/StringBuffer.js`** -- NEW
- CRLF normalize on construction
- Lazy `_lineOffsets`
- Constructor: `new StringBuffer(text)`

**`src/collections/CodeGrid.js`** -- MODIFY
- `_buffer: StringBuffer` replaces `this.content`/`this.lines`
- `utf16ColToSlot(line, utf16Col)` -- translation function (~8 lines):
```js
utf16ColToSlot(line, utf16Col) {
    const text = this._buffer.getLine(line);
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    let utf16Pos = 0, graphemeIdx = 0;
    for (const { segment } of segmenter.segment(text)) {
        if (utf16Pos >= utf16Col) break;
        utf16Pos += segment.length;  // .length is UTF-16 code units
        graphemeIdx++;
    }
    return graphemeIdx;
}
```
- `slotToUtf16Col(line, slot)` -- inverse

**`src/GlyphAtlas.js`** -- MODIFY
- `_syntheticMap: Map<string, number>` for multi-codepoint graphemes
- `getOrCreateSyntheticId(graphemeStr)` allocates dense IDs from `max(existingKeys)+1`
- Cap at 4096 synthetic entries with console warning

**Builder files** -- grapheme iteration replacing `charCodeAt`
- `builders/index.js` lines 27, 97, 322
- `GlyphRenderer.js` lines 1100, 1150, 1360
- `textToGlyphs.js` line 44
- `countGlyphs` uses `codePoint <= 32` check

### Coordinate-space contract (both agents must agree)

- `Position.character` = UTF-16 code unit offset (LSP convention, on the wire)
- `getSlotForChar(line, col)` where `col` = grapheme index (internal)
- `highlightRange(startLine, startCol, endLine, endCol, color)` where cols = grapheme indices (internal API)
- Translation at API boundary: `utf16ColToSlot` / `slotToUtf16Col` on CodeGrid
- The editing agent (Tier 2) calls `utf16ColToSlot` inside `applyEdits` before passing positions to the renderer

## Implementer Vote

**Rendering agent** should implement all of this. Rationale: the rendering agent owns the largest and most interconnected set of changes (StringBuffer, grapheme iteration, synthetic IDs, builder fixes, CodeGrid migration). Foundation's file set is smaller and more mechanical (types, provider, bridge RPC, Go handler). But the critical path is the coordinate-space boundary -- `utf16ColToSlot` lives in CodeGrid.js alongside the StringBuffer migration, and the synthetic ID solution modifies GlyphAtlas.js. These are all rendering-layer files. The rendering agent has the deepest context on the atlas DataTexture, the builder hot path, and the slot arithmetic. Foundation's changes (types.js, RemoteFileSystemProvider, WebSocketBridge RPC, Go relay) are well-specified enough to be implemented by anyone -- they are protocol plumbing with clear contracts. The rendering agent should implement both scopes to avoid merge conflicts in shared files (CodeGrid.js, builders/index.js) and to ensure the coordinate-space translation is correct end-to-end.

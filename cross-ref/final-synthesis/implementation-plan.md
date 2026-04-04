# Final Implementation Plan — FileSystem Provider Layer + Grapheme Fix

Produced by: 2 full cross-reference cycles, adversarial review, Metal pipeline exploration, web research on edit data structures + GPU grapheme segmentation, abstraction boundary analysis, and final 3-agent synthesis.

## Critical Design Decisions

### 1. "Character" Coordinate Spaces

The single most contested decision across all rounds. Resolution:

- **Internal (renderer, CodeGrid, builder)**: grapheme cluster indices. One grapheme = one buffer slot, one instanced quad.
- **Wire protocol (JSON-RPC, provider interface)**: grapheme indices. Since we have no LSP server to maintain UTF-16 compat with, adopting grapheme indices avoids a translation layer at every boundary.
- **Translation utilities**: `utf16ToGraphemeCol()` / `graphemeToUtf16Col()` defined in types but NOT wired until Tier 2 (when an actual LSP server might connect).

### 2. Grapheme Atlas: Dense ID Allocation

Multi-codepoint graphemes (emoji, ZWJ sequences) get numeric IDs via dense allocation from `max(existingKeys) + 1`, NOT sparse IDs at 0x110000. This keeps the DataTexture compact (~10-15 rows) instead of regressing to 17MB. Hard cap: 4096 synthetic entries.

The atlas key changes from `Map<number, UV>` to `Map<string, UV>` on the CPU side. The GPU DataTexture continues to use numeric indices — the atlas assigns a dense numeric slot to each grapheme string.

### 3. Version Numbers Ship in Tier 1

`FileStat.version` is a nullable integer. Go relay populates from mtime (truncated to ms). GitHub provider sets 0. No conflict detection logic until Tier 2 editing, but the field is in the wire format from day one, preventing a breaking protocol change later.

### 4. Intl.Segmenter Compatibility

**Baseline 2024**: Chrome 87+ (Nov 2020), Safari 15.4+ (Mar 2022), Firefox 125+ (Apr 2024). Works in Web Workers. Zero dependencies needed.

Fallback for Firefox < 125: `codePointAt()` iteration handles surrogate pairs correctly (just not ZWJ sequences). Acceptable degradation — emoji render as individual codepoints instead of composed glyphs.

### 5. Scope Discipline

- **CodeGrid.uri**: Cut from Tier 1 (dead code with no consumer)
- **FileSystemRegistry**: Cut (if/else for 2 providers)
- **GitHubProvider wrapper**: Cut (RepositoryAdapter already is the GitHub path)
- **MemoryProvider**: Deferred
- **UI provider selector**: Deferred (URL param `?source=local` suffices)
- **treeSitterDescs**: Deferred entirely
- **Cursor, EditorInputManager, EditHistory**: Tier 2 design contract written, not implemented

---

## Tier 1 Files: Provider Layer + Grapheme Fix

### New Files (3)

| # | File | Purpose |
|---|------|---------|
| 1 | `src/services/data/types.js` | JSDoc typedefs (Position, TextEdit, FileContent, FileStat, DirEntry, FileSystemProvider) + FileSystemError class |
| 2 | `src/services/data/RemoteFileSystemProvider.js` | JSON-RPC 2.0 client for Go relay. Implements FileSystemProvider interface. |
| 3 | `cli/fs.go` | Go FS handler: readFile, listTree, stat. Security: EvalSymlinks, 10MB size cap, --root sandboxing. fsnotify watcher. |

### Modified Files (9)

| # | File | Changes |
|---|------|---------|
| 4 | `src/services/orchestration/WebSocketBridge.js` | `rpcRequest()` method, JSON-RPC response/notification routing in `_handleMessage` |
| 5 | `cli/relay.go` | JSON-RPC detection in display message handler, FSHandler field on Relay struct |
| 6 | `cli/main.go` | `--root` flag on serve subcommand, pass to RunRelay |
| 7 | `app/GitHubRepoViewer.js` | Provider switching via URL param `?source=local`, local-mode fork in loadRepository |
| 8 | `src/services/data/index.js` | Barrel exports for new modules |
| 9 | `src/GlyphAtlas.js` | String-keyed `uvMap` (`Map<string, UV>`), dense ID allocation for multi-codepoint graphemes, `ensureGraphemes()` alongside `ensureCodepoints()` |
| 10 | `src/workers/builders/index.js` | `charCodeAt(i)` → grapheme iteration via Intl.Segmenter (with codePointAt fallback). Fix in buildBatchBuffers AND buildGlyphBuffers. |
| 11 | `src/GlyphRenderer.js` | `_ensureAtlasHasChars()` and `_processTextItem()` use grapheme iteration. |
| 12 | `src/collections/CodeGrid.js` | StringBuffer (read-only, lazy line index, CRLF normalization), `get content()` / `get lines()` getters, `getLine(n)` / `getLineCount()` / `getContent()` methods. |

**Total: 12 files (3 new, 9 modified)**

### Also Fix (in scope, existing files)

| File | Fix |
|------|-----|
| `src/workers/builders/textToGlyphs.js` | `charCodeAt` → grapheme iteration (line 44) |
| `src/collections/CodeGrid.js` | `countGlyphs` control char predicate: `codePoint <= 32` not four named chars |

---

## Implementation Order

```
Phase A: Grapheme fix (can ship independently)
  1. segmentGraphemes utility (Intl.Segmenter wrapper with codePointAt fallback)
  2. GlyphAtlas string-keyed uvMap + dense ID allocation
  3. Builder charCodeAt → grapheme iteration (index.js, textToGlyphs.js)
  4. GlyphRenderer grapheme iteration
  5. CodeGrid countGlyphs fix

Phase B: TextBuffer foundation (builds on Phase A)
  6. StringBuffer class (read-only, lazy line index, CRLF normalization)
  7. CodeGrid: integrate StringBuffer, backward-compatible getters

Phase C: Provider layer (independent of A and B)
  8. types.js (shared vocabulary)
  9. WebSocketBridge JSON-RPC support
  10. RemoteFileSystemProvider
  11. cli/fs.go + relay.go + main.go modifications
  12. GitHubRepoViewer provider switching
  13. index.js barrel exports
```

Phases A and C can run in parallel. Phase B depends on A (grapheme-aware CodeGrid).

---

## Tier 2 Design Contract (not implemented, documented)

The editing pipeline design contract is at `/home/user/dev/glyph3d-js/cross-ref/final-synthesis/phase0-editing.md`. Key interfaces:

- `StringBuffer.applyEdits(TextEdit[]) → ApplyResult { content, inverse }` — added when editing arrives
- `CodeGrid.applyEdits(TextEdit[])` — coordinator method: buffer mutation → history → re-render → provider persist
- `EditHistory` — forward/inverse/label/versions, no cursor fields, 300ms coalescing with 7 flush boundaries
- Dual-write: optimistic-confirmed, rollback on failure via client-side inverse, offline mode after 3 consecutive failures
- Position.character = grapheme indices (matches internal coordinate space)

---

## What's NOT in Scope

- MemoryProvider, GitHubProvider wrapper class, FileSystemRegistry
- UI provider selector in sidebar (URL param suffices)
- Editing, cursor, undo/redo, EditorInputManager
- Tree-sitter integration, treeSitterDescs
- Piece table, CRDT, collaboration
- Contextual shaping (Arabic/Devanagari — needs getTextClusters API)
- WebGPU compute shader pipeline
- Multi-cursor

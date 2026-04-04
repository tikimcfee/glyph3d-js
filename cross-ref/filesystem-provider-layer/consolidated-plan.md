# FileSystem Provider Layer — Consolidated Implementation Plan

Produced by 3-agent cross-reference analysis (protocol, integration, grid-editing) across 5 phases + focused unit-of-work refinement pass. 20 settled points, unanimous convergence.

## Architecture Overview

A provider abstraction layer between the 3D viewer (browser) and file sources. The viewer doesn't know or care where files come from — it calls the provider interface. Providers are pluggable backends:

- **GitHubProvider** — refactor of current GitHub API fetch logic (read-only)
- **RemoteFileSystemProvider** — JSON-RPC 2.0 over WebSocket to Go relay for local disk I/O
- **MemoryProvider** — in-memory store for demos, mobile, shared sessions
- **Authenticated GitHub** — future wrapper with token support

URI-driven dispatch for per-file I/O. Adapter-level swap for bulk tree loading.

## Core Design Decisions

### 1. Wire Format: JSON-RPC 2.0

Sole FS wire format. Discriminated from existing command traffic by `"jsonrpc"` field presence on the shared WebSocket connection. No second WebSocket needed.

Methods: `fs/readFile`, `fs/writeFile`, `fs/applyEdits`, `fs/listTree`, `fs/stat`
Notifications: `fs/didChange` (no `id`)
Error codes: -32001 FileNotFound, -32002 PermissionDenied, -32003 IsDirectory, -32005 RateLimited, -32006 NetworkError, -32007 VersionConflict

### 2. Provider Interface

```
FileSystemProvider {
  scheme: string                                          // 'github', 'file', 'memory'
  readFile(uri) → Promise<FileContent>
  writeFile(uri, content) → Promise<FileContent>
  applyEdits(uri, EditBatch) → Promise<EditResult>
  listTree(uri, options?) → Promise<DirEntry[]>
  stat(uri) → Promise<FileStat>
  onDidChange(callback) → unsubscribe function
  dispose() → Promise<void>
}
```

### 3. URI Scheme

- GitHub: `github://owner/repo?ref=branch&path=src/index.js` (query params for branch disambiguation)
- Local: `file:///home/user/dev/project/src/index.js`
- Memory: `memory://session/scratch.js`

`CodeGrid` stores a `uri` field as canonical identity for edit routing, tab display, change event matching, and provider dispatch.

### 4. LSP-Standard TextEdit

```
TextEdit { range: { start: Position, end: Position }, newText: string }
Position { line: number, character: number }  // 0-based, character = index into source line
```

Handles insertion (zero-width range), deletion (empty newText), replacement, single-character typing.

### 5. Versioned File Content

```
FileStat { type, size, mtime, sha?, readonly, version: number }
FileContent { uri, content, stat }
```

`version` is monotonic, provider-authoritative. Incremented on every write. Enables conflict detection and stale-version checks.

### 6. Edit Batches and Inverse Computation

```
EditBatch { edits: TextEdit[], baseVersion: number, label?: string }
EditResult extends FileContent { inverse: TextEdit[], baseVersion: number, version: number }
```

- `baseVersion` in the request enables conflict detection — relay rejects if file version != baseVersion (error -32007)
- `inverse` edits computed server-side (provider holds "before" content at apply time)
- Client also computes optimistic inverse locally for instant undo (before async round-trip)
- `label` is semantically inert at the provider — all coalescing logic lives in client-side EditHistory

### 7. Tree Data

```
DirEntry { path: string, type: 'file'|'directory'|'symlink', size: number, sha?: string }
```

Full relative paths (not basenames). Two-pass filtering: server-side coarse exclusions (.git, node_modules, binaries), browser-side fine view filtering via existing `filterCodeFiles()`.

### 8. Dual-Write Edit Flow

Sequence:
1. Apply edit to in-memory `grid.content` / `grid.lines` immediately (optimistic)
2. Compute client-side inverse for instant undo capability
3. Schedule re-render via `requestAnimationFrame`
4. Send `provider.applyEdits(grid.uri, editBatch)` via JSON-RPC
5. On response: compare `response.version` against expected — if version skip > 1, external conflict → full reload + history clear
6. Store provider's authoritative inverse in EditHistory (replacing optimistic)

### 9. Undo/Redo

Per-CodeGrid `EditHistory`, browser-side.

```
EditEntry {
  forward: TextEdit[]
  inverse: TextEdit[]
  label: string
  versionBefore: number
  versionAfter: number
  cursorBefore: Position
  cursorAfter: Position
}
```

- Coalesce groups: consecutive same-label edits within 300ms merge into one undo step
- Boundaries: label change, non-character edit, cursor jump, 300ms timeout, undo/redo request
- Undo sends inverse edits through the normal dual-write path (provider sees them as regular edits)
- Cursor restored from `cursorBefore` on undo, `cursorAfter` on redo
- Stack lost on page refresh (acceptable for Phase 1; persistence deferred)

### 10. Change Notifications

`fs/didChange` pushed from Go relay via `fsnotify` for local FS changes. Carries `version`.

- GitHub: no push (polling or manual refresh)
- Memory: fires synchronously on writes
- Stale-version check prevents echo reloads from own writes
- Dirty grids defer to reconciliation path instead of reloading mid-edit

### 11. Security

Go relay `--root` flag sandboxes all paths. `..` traversal rejected with PermissionDenied. `--writable` opt-in for write operations. Without it, `fs/applyEdits` and `fs/writeFile` return PermissionDenied.

`fs/capabilities` notification sent on display connect: `{ root, writable, scheme: "file" }`.

### 12. Readonly Gating

`FileStat.readonly` = true for GitHub (no push access), false for local FS with `--writable`. Editing input system checks `readonly` before accepting keystrokes.

### 13. Slot-to-Position Mapping (slotToPos)

Interleaved `Int32Array`: `[line, rawCol, slotCol]` per buffer slot.

- `line`: 0-based source line
- `rawCol`: 0-based character offset within line (LSP `Position.character` — tabs/CRs counted)
- `slotCol`: 0-based index among emitted buffer slots on that line

Built in same pass as glyph buffers in `buildBatchBuffers`. Zero extra passes. Cost: 12 bytes/glyph (vs 40 bytes already written). Transferable from worker via structured transfer.

### 14. Re-rendering After Edits

Full re-render per edit via worker pipeline (<15ms for 50k chars). `requestAnimationFrame` debouncing coalesces rapid keystrokes — at most one re-render per frame. Cursor updates immediately from text arithmetic; visual re-render is at most one frame behind.

Incremental buffer updates deferred — `slotToPos` design supports future `copyWithin`-based slot shifting.

---

## File Plan

### New Files (8)

| File | Phase | Description |
|------|-------|-------------|
| `src/services/data/types.js` | 1a | JSDoc typedefs + FileSystemError class |
| `src/services/data/FileSystemRegistry.js` | 1b | URI-scheme dispatch, change event aggregation |
| `src/services/data/GitHubProvider.js` | 1b | Wraps GitHubRepositorySource + cache |
| `src/services/data/MemoryProvider.js` | 1b | In-memory store for demos |
| `src/services/data/RemoteFileSystemProvider.js` | 1b | JSON-RPC client for Go relay |
| `cli/fs.go` | 1g | Go relay FS handler + fsnotify |
| `app/EditorInputManager.js` | 2c | Keyboard capture + TextEdit generation |
| `app/EditHistory.js` | 2d | Per-grid undo/redo stack with coalescing |

### Modified Files (13)

| File | Phase | Changes |
|------|-------|---------|
| `src/services/data/index.js` | 1b | Add new exports |
| `src/services/orchestration/WebSocketBridge.js` | 1c | JSON-RPC message routing + rpcRequest() |
| `src/services/data/RepositoryAdapter.js` | 1d | Accept provider, delegate through it |
| `src/collections/CodeGrid.js` | 1e, 2b | `uri` + `_version` fields, slotToPos, cursor, position methods |
| `app/GitHubRepoViewer.js` | 1f | Provider switching, URI wiring, onDidChange |
| `app/components/Drawer.js` | 1f | Provider selector dropdown |
| `app/ide.html` | 1f | Status bar provider indicator |
| `app/IDEShell.js` | 1f | Status bar updates, registry bootstrap |
| `app/StatePersistence.js` | 1f | Persist provider type + file versions |
| `cli/relay.go` | 1g | JSON-RPC detection, FSHandler field |
| `cli/main.go` | 1g | --root and --writable flags |
| `src/workers/builders/index.js` | 2a | slotToPos + lineVisCharCounts in builder |
| `app/commands/handlers/highlightCommands.js` | 2e | Use CodeGrid position methods |

### Optional Utility (Tier 2)

| File | Phase | Description |
|------|-------|-------------|
| `app/editing/textEditUtils.js` | 2c | Pure functions: computeInverse(), applyEditsToString() |

---

## Implementation Order

### Tier 1: Read-Only Provider Layer

1. `types.js` — everything depends on it
2. `FileSystemRegistry.js` + `GitHubProvider.js` + `MemoryProvider.js` (parallel)
3. `RepositoryAdapter.js` refactor (depends on providers)
4. `WebSocketBridge.js` JSON-RPC additions
5. `RemoteFileSystemProvider.js` (depends on bridge)
6. `cli/fs.go` + `cli/relay.go` + `cli/main.go` (Go side, parallel with JS)
7. `CodeGrid.js` uri field + `GitHubRepoViewer.js` wiring
8. `Drawer.js` + `IDEShell.js` + `StatePersistence.js` UI changes

### Tier 2: Editing Pipeline

9. Builder `slotToPos` additions
10. `CodeGrid.js` position methods + cursor
11. `textEditUtils.js` — computeInverse, applyEditsToString
12. `EditorInputManager.js` + `EditHistory.js`
13. `highlightCommands.js` refactor

---

## Deferred (Future Tiers)

- Incremental buffer updates (copyWithin-based slot shifting)
- Edit history persistence across page refresh
- Version-stamped reconciliation (beyond "last write wins")
- Authenticated GitHub provider (private repos)
- Multi-cursor editing
- Tree-sitter integration for structural edits
- `fs/watch` / `fs/unwatch` for selective file watching

# Round 2: protocol reviews grid-editing, integration (inverse)

## Reaffirm or Retract

### 1. URI-driven dispatch vs adapter-swap — REAFFIRMED with narrowed scope

Both integration (round1, lines 38-40) and grid-editing (round1, lines 48-50) pushed back, arguing the adapter-swap model maps more naturally to `RepositoryAdapter`'s single-source `loadRepository()` flow. Integration correctly notes the viewer operates in bulk (`getRepositoryTree` + `getMultipleFiles`), not per-file URI dispatch.

I reaffirm URI-driven dispatch for **file I/O** (`readFile`, `writeFile`, `applyEdits`, `stat`) but retract it for **tree loading**. Grid-editing's synthesis (round1, line 50) — "URI-driven dispatch for file I/O, adapter-swap for tree-loading context" — is the correct middle ground. The `FileSystemRegistry` resolves per-file operations by URI; `RepositoryAdapter` holds the active provider for bulk tree + batch-load. These coexist: `loadRepository()` uses the adapter, but `CodeGrid.uri` threads through to the registry for edits and change events.

### 2. JSON-RPC 2.0 as sole FS wire format — REAFFIRMED

All three agents now agree (integration round1 line 60, grid-editing round1 lines 9-11). No retraction needed. Integration explicitly adopted JSON-RPC and discarded its custom `{ cmd, id }` envelope. This is settled.

### 3. `DirEntry.name` (basename) — RETRACTED

Integration (round1, line 44-46) correctly identified that `filterCodeFiles()` at `RepositoryAdapter.js:213` operates on full relative paths, and `hierarchicalManager.layoutHierarchy()` parses `path` to build the directory tree. Returning only basenames would force path reconstruction at every consumer. Grid-editing's reconciliation proposal (round1, line 72) — `listTree(uri)` for recursive + `listDirectory(uri)` for incremental — is overengineered for Phase 1. I retract `DirEntry` with basename-only `name` and adopt `{ path, type, size, sha? }` with full relative path, matching the existing tree shape.

### 4. Flat `TextEdit` format — RETRACTED

Grid-editing (round1, lines 5-7) correctly argued that deviating from LSP's `{ range: { start, end }, newText }` creates a gratuitous translation layer for any future language server integration. I retract the flat `{ start, end, newText }` format. The canonical shape is `{ range: { start: Position, end: Position }, newText: string }`.

### 5. `applyEdits` returns full `FileContent` — REAFFIRMED

Integration (round1, line 56-58) now agrees. Grid-editing (round1, line 56-58) also agrees `FileContent` is correct over `Promise<string>`. Unanimous.

### 6. `filterCodeFiles` stays consumer-side — PARTIALLY RETRACTED

Integration (round1, line 64) correctly identifies two-pass filtering: relay applies coarse server-side exclusions (`.git`, `node_modules`, binaries) to avoid megabytes of irrelevant tree data, then browser-side `filterCodeFiles()` applies fine-grained view-level filtering. I retract the pure consumer-side position. Protocol should define a `fs/listTree` params field `{ uri, exclude?: string[] }` so the relay can apply patterns server-side.

## Evolved Understanding

### The dual-write flow is the real design challenge

Round 1 surfaced the most critical unresolved interaction: grid-editing applies edits to in-memory text for immediate re-render, protocol routes edits through `provider.applyEdits()` for persistence, and both must happen. Grid-editing round1 line 54 identifies this as "dual-write" — the browser modifies local text optimistically, sends the edit to the relay, and reconciles when the relay responds. Neither my Phase 0 nor grid-editing's Phase 0 described the reconciliation path. This is the single hardest problem in the editing layer and must be designed before code.

### `rawCol` semantics were genuinely ambiguous

My Phase 0 (round1, lines 19-21) flagged `visCol` naming. Integration round1 (lines 17-19) went deeper — tabs occupy source string positions but get no buffer slot, creating a semantic mismatch. Integration's proposal (round1, line 70) to rename to `charIndex` (0-based index into the source string) is correct and I should have proposed this originally. The builder skips tabs/CRs for rendering, but `charIndex` must count them for TextEdit range construction.

### Undo/redo is a critical gap

Grid-editing (round1, line 41) correctly identified that none of us addressed edit history. For a system where `applyEdits` writes to disk, undo is not optional — a mistyped character is permanent without it. This must be designed alongside the dual-write flow.

### Branch disambiguation in URIs is a real problem

Integration (round1, lines 5-8) identified that `github://owner/repo/feature/auth/src/index.js` is ambiguous — `auth` could be part of the branch or the path. My Phase 0 handwaved this. The correct fix is query-parameter encoding: `github://owner/repo?ref=feature/auth&path=src/index.js`. I should have caught this; URL path segments are fundamentally unsuitable for values containing `/`.

## Convergence

All three agents now agree on:

1. **JSON-RPC 2.0** as the FS wire format on WebSocket, discriminated by `"jsonrpc"` field from existing command traffic.
2. **`applyEdits` returns `FileContent`**, not bare string — updated stat metadata is needed for cache invalidation and dirty-checking.
3. **LSP-standard `TextEdit` shape**: `{ range: { start: Position, end: Position }, newText: string }`.
4. **Tree data uses `{ path, type, size }` with full relative paths**, not basename-only `DirEntry`.
5. **Server-side coarse filtering + browser-side fine filtering** for `listTree`.
6. **`onDidChange` notification model** using `fsnotify` on the Go relay, essential for local FS editing from Phase 1.
7. **`FileSystemError` with typed constructors** and JSON-RPC error code alignment.
8. **`readonly` gating** — `FileStat.readonly` disables editing controls; grid-editing's input system checks this before accepting keystrokes.
9. **URI as identifier on CodeGrid** — `grid.uri` enables `onDidChange` event matching and edit routing regardless of dispatch model.
10. **A shared types file** (`src/services/data/types.js`) defining `TextEdit`, `FileContent`, `FileStat`, `FileSystemProvider` as JSDoc typedefs.

## Remaining Tensions

### 1. Batch file loading: `getMultipleFiles` vs N parallel `readFile` calls

Integration (round1, line 67) insists on keeping `getMultipleFiles` as a batch method on the adapter because `RepositoryAdapter.js:256-280` has concurrency-limited parallel fetch optimized for GitHub's API. Protocol's interface has no batch method. Resolution options: (a) add `readFiles(uris[])` to the provider interface, (b) keep batching on `RepositoryAdapter` above the provider, (c) let the provider handle concurrency internally. Option (b) is simplest — the adapter calls `provider.readFile` N times with its own concurrency limiter. The provider doesn't need to know about batching.

### 2. Optimistic edit reconciliation

Grid-editing applies edits locally for <16ms re-render. Protocol routes edits to the relay for persistence. What happens when the relay response content differs from the optimistic state? Options: (a) always trust relay response and re-render, (b) diff relay response against optimistic state and only re-render if different, (c) version-stamp edits and reject stale relay responses. No agent has proposed a concrete reconciliation algorithm. This needs resolution before editing ships.

### 3. `requestAnimationFrame` debouncing vs per-keystroke `applyEdits` to relay

Grid-editing (phase0, lines 334-346) coalesces keystrokes into one re-render per frame. But should relay `applyEdits` calls also be debounced? Sending one JSON-RPC message per keystroke is wasteful; batching edits per frame is efficient but risks data loss if the browser crashes between keystrokes and the last batch. Trade-off: latency-to-disk vs crash safety.

### 4. Undo/redo design

Grid-editing identified the gap; no agent proposed a solution. Key question: does the undo stack live in the browser (simple, but lost on refresh), on the relay (persistent, but adds complexity), or both? Does undo call `applyEdits` with inverse operations, or does it replace full file content from a snapshot? This is blocking for the editing feature.

## Synthesis

The filesystem provider layer should be built in two tiers:

**Tier 1 (types + registry + read-only providers):**
- `src/services/data/types.js` — shared JSDoc typedefs for `TextEdit`, `FileContent`, `FileStat`, `FileSystemProvider`, `FileSystemError`
- `src/services/data/FileSystemRegistry.js` — URI-scheme dispatch for per-file operations
- `src/services/data/GitHubProvider.js` — wraps `GitHubRepositorySource` + `RepositoryContentCache`, implements `FileSystemProvider`
- `src/services/data/MemoryProvider.js` — in-process provider for demos
- `RepositoryAdapter` gains a `defaultScheme` property for tree-loading, delegates per-file calls through the registry
- `CodeGrid` gains a `uri` field set at load time
- Go relay gains JSON-RPC 2.0 handler for `fs/readFile`, `fs/stat`, `fs/listTree`
- Browser gains `RemoteFileSystemProvider` wrapping JSON-RPC over existing WebSocket
- URI scheme uses query params for branch: `github://owner/repo?ref=main&path=src/index.js`

**Tier 2 (editing + write providers):**
- `slotToPos` (renamed field: `charIndex` not `rawCol`) built in the buffer builder's existing character loop
- `EditorInputManager` generates LSP `TextEdit` from keystrokes
- Dual-write flow: optimistic local edit + `provider.applyEdits(uri, edits)` + reconciliation
- `EditHistory` class for undo/redo (browser-side, snapshot-based for Phase 1)
- Go relay gains `fs/applyEdits`, `fs/writeFile` behind `--writable` flag
- `fs/didChange` notifications from `fsnotify` for external modifications
- Cursor revalidation on `onDidChange` events

This ordering lets Tier 1 ship without editing — the viewer works with GitHub, local, and memory providers in read-only mode. Tier 2 adds editing on top once the provider abstraction is stable.

## Dissent

### `getMultipleFiles` should NOT be on the provider interface

Integration wants to preserve `getMultipleFiles` for batch GitHub API efficiency (round1, line 67). I hold that batching is an adapter concern, not a provider concern. The `RepositoryAdapter` should call `provider.readFile` N times with its own concurrency limiter (currently `Promise.all` with chunking at `RepositoryAdapter.js:256-280`). Adding a batch method to `FileSystemProvider` means every provider must implement it, and local/memory providers gain nothing from it. The adapter already has the batching logic; let it keep it. The provider interface stays minimal: `readFile`, `writeFile`, `applyEdits`, `stat`, `listTree`, `onDidChange`, `dispose`.

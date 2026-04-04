# Round 1: grid-editing reviews protocol, integration

## Errors Found

### 1. TextEdit format conflict between protocol and grid-editing

Protocol (phase0-protocol.md:37-39) defines `TextEdit` as flat `{ start, end, newText }`. My analysis (phase0-grid-editing.md:251) uses the LSP-standard nested `{ range: { start, end }, newText }`. These are incompatible. The protocol doc itself notes "Our version uses flat start/end for simplicity" (line 216) but this deviates from LSP without justification. Since the whole point of using LSP-style edits is compatibility with external tooling (language servers, formatters), the flat format creates a gratuitous translation layer. **Correct position**: use the standard LSP shape `{ range: { start, end }, newText }`. If we flatten it, every LSP integration will need a shim.

### 2. Integration uses custom `fs.*` commands; protocol uses JSON-RPC 2.0

Integration (phase0-integration.md:99-133) proposes a custom `{ cmd: "fs.list", id: "...", path: "..." }` envelope. Protocol (phase0-protocol.md:117-123) proposes standard JSON-RPC 2.0 `{ jsonrpc: "2.0", id: 1, method: "fs/readFile", params: { uri: "..." } }`. These are fundamentally different wire formats. The relay Go code would need to implement one or the other -- not both. **Correct position**: JSON-RPC 2.0 (protocol's approach). It has standard error handling, notification support, and established tooling. The custom `cmd`-based format would require inventing all of that from scratch. The integration agent's `WebSocketBridge.request()` method (lines 182-195) would need to emit JSON-RPC, not the ad-hoc format shown.

### 3. Integration's `listDirectory` return shape is wrong for LocalFS

Integration (phase0-integration.md:136) says `fs.list` returns `{tree: [{path, type, size}]}` matching GitHub's tree API shape, with `type:'blob'|'tree'`. But protocol (phase0-protocol.md:28-32) defines `DirEntry` as `{ name, type: 'file'|'directory'|'symlink', size }`. The `name` vs `path` difference matters -- `name` is a basename, `path` is a full relative path. GitHub's tree API returns full paths from repo root; a local directory listing naturally returns basenames. Protocol's `DirEntry` with `name` is correct for per-directory listing, but integration's approach of returning a flat recursive tree matches how the viewer actually consumes the data (`filterCodeFiles` operates on full paths at `RepositoryAdapter.js:213`). This is a design tension, not just a format discrepancy -- see Tensions section.

### 4. Integration references `this.source.*` replacement but misses `getRepositoryInfo`

Integration (phase0-integration.md:39) proposes replacing `this.source.*` with `this.provider.*`. But `RepositoryAdapter.js:72` calls `this.source.getRepositoryInfo()` for URL-based loading (`loadFromUrl`). This is not in integration's provider method table (lines 41-48) and is not in protocol's "out of scope" list either. It would silently break the URL-based load path. Either add `getRepositoryInfo` to the provider interface or keep it as a `GitHubRepositorySource`-specific call gated by a capability check.

### 5. Integration's `switchProvider` creates raw sources, not providers

Integration (phase0-integration.md:278-280) does `this.repoAdapter.provider = new GitHubRepositorySource()`. But `GitHubRepositorySource` is a data source, not a provider implementing the `FileSystemProvider` interface from protocol's analysis. It has `fetchTree`/`fetchFile`, not `listDirectory`/`readFile`. The switch should create a `GitHubProvider` (which wraps `GitHubRepositorySource` + cache), not a raw source. This would crash immediately on the first `provider.listDirectory()` call.

## Gaps

**Covered by grid-editing, missed by both**:
- Z-depth wrapping and its effect on cursor navigation (my section 7). Neither protocol nor integration addresses how wrapped lines affect the editing coordinate system. `slotToPos` tracking source positions is critical for correct cursor behavior across wraps.
- The skip set (charCode 10/32/13/9) and its consequences for raw vs visible column mapping. Protocol mentions nothing about character skipping; integration doesn't address it.
- Debounced re-render strategy for fast typing (my section 6, `requestAnimationFrame` coalescing).

**Covered by protocol, missed by grid-editing**:
- `onDidChange` notification model for external file modifications (protocol section 9). My analysis assumes edits originate locally but doesn't handle the case where the file changes on disk while the cursor is active.
- `FileSystemError` hierarchy with typed constructors (protocol section 6). My `_applyEdit` path has no error handling for write failures.

**Covered by integration, missed by grid-editing**:
- Provider switching UI and state cleanup (integration sections 3, 5). My analysis assumes a single active grid but doesn't address what happens to cursor/edit state when the provider changes.
- `StatePersistence` extension to save provider type (integration section 6).

**Missed by all three**:
- Undo/redo. None of the analyses address edit history. `applyEdits` is one-way; there is no mention of an undo stack. For an editing system, this is a critical omission.
- Multi-cursor / selection ranges. My analysis covers single-cursor but no selection model.

## Tensions

### 1. URI-based routing (protocol) vs provider property on adapter (integration)

Protocol (section 7, lines 316-348) defines a `FileSystemRegistry` that resolves URIs to providers automatically -- the URI scheme determines the provider. Integration (section 1, lines 29-37) puts a mutable `provider` property on `RepositoryAdapter` and switches it with `switchProvider()`. These are architecturally opposed. Protocol's approach is stateless and composable (can mix sources in one session); integration's is modal (one active provider at a time).

**Correct position**: Protocol's URI-driven routing is cleaner, but integration's approach maps more naturally to the existing `RepositoryAdapter` which has a single `this.source`. The pragmatic path is: use URI-driven dispatch for file I/O (protocol), but keep integration's `switchProvider` for the tree-loading context (which provider populates the file tree). The two can coexist -- `switchProvider` sets which provider `loadRepository` queries, while individual `readFile`/`writeFile` calls go through the registry.

### 2. Who applies edits: relay or browser

Protocol (section 5, lines 232-255) has the Go relay applying edits server-side for local files, returning the full `FileContent`. My analysis (phase0-grid-editing.md section 6, lines 288-302) applies edits in the browser against `this._activeGrid.content`. For local FS editing, both must happen: the browser applies the edit to the in-memory text (for immediate re-render), AND sends the edit to the relay (for persistence). The relay's `applyEdits` response can serve as confirmation and conflict detection (if another process modified the file). Neither analysis explicitly describes this dual-write flow.

### 3. `applyEdits` return type: `string` vs `FileContent`

Integration (phase0-integration.md:47) says `applyEdits` returns `Promise<string>`. Protocol (phase0-protocol.md:72-74) says it returns `Promise<FileContent>` (full object with URI, content, stat). **Correct position**: `FileContent` (protocol). Returning just a string loses the updated `mtime` and `size` metadata, which matters for dirty-checking and cache invalidation.

## Recommendations

1. **Standardize on LSP `TextEdit` shape**: `{ range: { start: Position, end: Position }, newText: string }`. Both protocol and grid-editing must use the same format. Update protocol's typedef at line 36-40 to use `range` wrapper.

2. **Use JSON-RPC 2.0 for all relay FS traffic**: Discard integration's `{ cmd, id, path }` format. Update integration's `WebSocketBridge.request()` (line 182) to emit `{ jsonrpc: "2.0", id, method, params }` and match protocol's wire format.

3. **Fix integration's `switchProvider` to create wrapped providers, not raw sources**: `new GitHubRepositorySource()` at line 279 must become `new GitHubProvider(...)` that implements the `FileSystemProvider` interface.

4. **Define the dual-write flow for local editing**: Browser applies edit to in-memory text immediately (grid-editing's path), sends edit to relay via JSON-RPC (protocol's path), relay persists and returns `FileContent` for confirmation. If relay response differs, reconcile.

5. **Add `getRepositoryInfo` to integration's provider gap analysis**: Either add it to the interface or explicitly document it as GitHub-only behind a capability check.

6. **Reconcile tree listing shape**: Define two methods -- `listDirectory(uri)` returns `DirEntry[]` with basenames (protocol's shape, for incremental tree building), and `listTree(uri)` returns recursive `{ path, type, size }[]` (integration's shape, for initial bulk load). Or: always return full paths and let the consumer extract basenames.

7. **Add `onDidChange` handling to grid-editing's cursor system**: When an external change notification arrives for the active grid's file, the cursor position must be revalidated against the new content. If the cursor line was deleted, snap to nearest valid position.

8. **Design undo stack before implementing editing**: Add `EditHistory` class that wraps `applyEdits` calls with inverse operations. This must be in place before keyboard input lands, or every edit is permanent.

9. **Ensure `slotToPos` is included in protocol's `FileContent` → CodeGrid flow**: When `applyEdits` returns new `FileContent`, the grid must re-render and rebuild `slotToPos`. Protocol's `onDidChange` handler (line 456-464) calls `loadFileAsync` which triggers the builder, which will produce new `slotToPos` -- this path works, but should be explicitly documented.

10. **Gate `writeFile` / `applyEdits` on `readonly` stat field**: Protocol defines `readonly` in `FileStat` (line 19). Integration's UI should disable editing controls when `readonly === true` (GitHub without push access). My cursor/input system should check this before accepting keystrokes.

## Key Insight

The three analyses design three different serialization formats for the same operation (TextEdit), three different wire protocols for the same transport (WebSocket), and two different provider resolution strategies (URI registry vs mutable property). These are not independent design choices -- they compound into integration nightmares if not resolved before code is written. The single most important pre-implementation action is to write a shared types file (`src/services/data/types.js`) that canonically defines `TextEdit`, `FileContent`, `FileStat`, `DirEntry`, and `FileSystemProvider` as JSDoc typedefs, then have all three workstreams import from it. Without that, each agent will implement to its own spec and the seams will not meet.

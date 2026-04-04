# Round 2: integration reviews grid-editing, protocol (inverse)

## Reaffirm or Retract

### 1. Adapter-swap vs URI-driven registry — PARTIALLY RETRACT

In Phase 0 I proposed swapping `this.repoAdapter.provider` at runtime (phase0-integration.md lines 276-298). Protocol challenged this as "ambient state that URI routing eliminates" (round1-protocol line 13), and grid-editing agreed protocol's routing is "cleaner" but called adapter-swap more natural for this codebase (round1-grid-editing lines 48-50).

I now agree that individual file operations (`readFile`, `writeFile`, `applyEdits`) should resolve through URI-based dispatch. The URI on each CodeGrid is the identity of that file -- mixing providers per-grid is a real scenario (local overlay on GitHub repo). However, I **reaffirm** that bulk tree loading (`getRepositoryTree`, `getMultipleFiles`) needs a "primary provider" concept. `GitHubRepoViewer.loadRepository()` at line 900 does bulk operations -- calling `getRepositoryTree(owner, repo, branch)` followed by `getMultipleFiles(owner, repo, paths, branch)` with concurrency-limited parallel fetch (`RepositoryAdapter.js` lines 256-280). URI-per-file dispatch would lose this batching. The resolution: `FileSystemRegistry` handles per-file dispatch, but the viewer tracks a "primary scheme" for tree/bulk operations. The adapter wraps the registry for batch convenience.

### 2. Custom `fs.*` wire format — RETRACT

I proposed `{ cmd: "fs.list", id, path }` (phase0-integration.md lines 100-116). Both protocol and grid-editing correctly identified this as an ad-hoc reinvention of JSON-RPC 2.0. Protocol's format has standard error codes, notification support, and clean discrimination from existing command traffic via the `"jsonrpc"` field. I fully adopt JSON-RPC 2.0 for all FS wire traffic. My `WebSocketBridge.request()` method (phase0-integration.md lines 182-195) stands structurally but must emit `{ jsonrpc: "2.0", id, method, params }` instead of `{ cmd, id, ...params }`.

### 3. `applyEdits` returning `Promise<string>` — RETRACT

I specified `applyEdits(path, edits[]) -> Promise<string>` (phase0-integration.md line 47). Protocol correctly returns `Promise<FileContent>` with stat metadata. Both other agents flagged this. Returning `FileContent` gives the caller updated `mtime`/`size` for dirty-checking without a separate `stat` round-trip. Adopted.

### 4. `switchProvider` creating raw `GitHubRepositorySource` — RETRACT

Grid-editing caught this (round1-grid-editing line 23): my `switchProvider` assigns `new GitHubRepositorySource()` directly, but that class has `fetchTree`/`fetchFile`, not `listDirectory`/`readFile`. It must create a `GitHubProvider` wrapper implementing the `FileSystemProvider` interface. This was a genuine error in my analysis.

### 5. Provider selector UI in Drawer — REAFFIRM

No agent challenged the UI design for provider selection (`#sp-repo` dropdown, conditional field visibility, relay status indicator). The `repoPanelHTML()` changes (phase0-integration.md lines 206-253) stand. Protocol deliberately excluded UI concerns; grid-editing noted it didn't address provider switching UX (round1-grid-editing line 37).

### 6. Go relay `--root` / `--writable` flags — REAFFIRM

I specified path-traversal prevention and opt-in write access (phase0-integration.md lines 146-151). Neither other agent addressed this. Protocol's `fs/capabilities` handshake (round1-protocol line 94) is a good complement -- the browser needs to know root path and write-enabled state on connect. I adopt that addition.

## Evolved Understanding

After Round 1, three assumptions were confirmed and two were broken.

**Confirmed:**
1. The existing `RepositoryAdapter` caching/batching layer must survive the refactor. All three agents agree that `getMultipleFiles` concurrency-limited fetch is a performance feature worth preserving.
2. `filterCodeFiles` is a two-pass operation: coarse server-side (relay excludes `.git`, `node_modules`), fine browser-side (existing `filterCodeFiles` on extensions/size). All agents converged here.
3. `onDidChange` / filesystem watching is essential for local FS editing. I missed this entirely in Phase 0; protocol's `fsnotify` notification model (phase0-protocol.md lines 151-157) fills the gap.

**Broken:**
1. I assumed the provider interface could use raw paths (`listDirectory(path)`). Protocol's URI scheme is necessary for identity -- a CodeGrid needs a canonical URI for change notification matching, edit routing, and tab/breadcrumb display. Raw paths are ambiguous across providers.
2. I assumed `listDirectory` should return GitHub-compatible `{tree: [{path, type, size}]}`. Protocol's `DirEntry` with basenames only is wrong for bulk load, but my shape is wrong for incremental tree building (expanding folders one at a time in the sidebar). Grid-editing's recommendation (round1-grid-editing line 72) to define both `listDirectory` (basenames, per-folder) and `listTree` (recursive, full paths) is the right split.

## Convergence

All three agents now agree on:

1. **JSON-RPC 2.0** is the wire format for FS traffic on the WebSocket relay. No custom `cmd`-based envelopes.
2. **`applyEdits` returns `FileContent`** (uri, content, stat), not bare string.
3. **TextEdit uses LSP shape**: `{ range: { start: Position, end: Position }, newText }`. Protocol's flat `{ start, end, newText }` was challenged by grid-editing and should adopt the standard nesting.
4. **Dual-write for local editing**: browser applies edit to in-memory text (immediate re-render), sends to relay via JSON-RPC (persistence), relay response serves as confirmation/reconciliation.
5. **`FileSystemProvider` interface** with `readFile`, `writeFile`, `applyEdits`, `listDirectory`, `stat`, `onDidChange`, `dispose`. Method names are stable across all three analyses.
6. **Shared types file** (`src/services/data/types.js`) defining `TextEdit`, `FileContent`, `FileStat`, `DirEntry`, `FileSystemProvider` as canonical JSDoc typedefs. Grid-editing's key insight (round1-grid-editing line 84).
7. **`slotToPos` built in the same character loop** as buffer emission, zero extra passes. Grid-editing's design is sound and unchallenged on the data structure itself.
8. **Server-side tree filtering** at the relay level before sending over WebSocket.

## Remaining Tensions

### 1. `DirEntry` shape: basenames vs full paths

Protocol returns `name` (basename). Integration returns `path` (full relative). Both are needed for different use cases. Unresolved: do we define two methods (`listDirectory` + `listTree`), or always return full paths and let consumers extract basenames? The `HierarchicalLayoutManager` parses full paths to build directory tree structure -- it would need changes if basenames-only were used. But incremental folder expansion (lazy tree) naturally returns basenames per directory.

**My position**: always return `{ path, type, size }` with full relative paths. Basenames are trivially derived. Full paths are not reconstructable without tracking recursion context. `HierarchicalLayoutManager.layoutHierarchy()` and `filterCodeFiles()` both operate on full paths.

### 2. URI scheme for GitHub branch disambiguation

`github://owner/repo/feature/auth/src/index.js` is ambiguous -- is `auth` part of the branch or path? I flagged this in Round 1 (round1-integration line 7-8). Protocol hasn't resolved it. Options: query param (`?ref=feature/auth`), double-slash separator (`github://owner/repo//feature/auth//src/index.js`), or base64-encode the branch. No consensus yet.

### 3. Undo/redo

Grid-editing flagged this as missed by all three (round1-grid-editing line 41). Remains unaddressed. An `EditHistory` class wrapping `applyEdits` with inverse operations is a prerequisite for editing to be usable, but the design is not specified.

### 4. `rawCol` vs `charIndex` semantics in `slotToPos`

Protocol recommended renaming `visCol` to `slotCol` (round1-protocol line 84). I recommended renaming `rawCol` to `charIndex` as a 0-based index into the full source string (round1-integration line 68). Grid-editing hasn't confirmed which naming. The semantics matter: does the value track position in the raw source text (where tabs count) or position in the builder's character counter (where they don't)?

## Synthesis

The filesystem provider layer should be implemented in this order:

**Phase 1a -- Types and Interface (all agents' shared types file)**
- `src/services/data/types.js`: JSDoc typedefs for `TextEdit`, `FileContent`, `FileStat`, `DirEntry`, `FileSystemProvider`, `FileSystemError`.
- `DirEntry` includes full relative `path`, `type: 'file'|'directory'|'symlink'`, `size`, optional `sha`.
- `TextEdit` uses LSP shape with `range` wrapper.

**Phase 1b -- Provider Implementations (protocol + integration)**
- `GitHubProvider` wrapping `GitHubRepositorySource` + `RepositoryContentCache`, implementing `FileSystemProvider`. Non-FS operations (`fetchBranches`, `getRepositoryInfo`) stay on the source directly, gated by capability check.
- `MemoryProvider` for demos.
- `RemoteFileSystemProvider` as the JSON-RPC client for local FS, using `WebSocketBridge.request()` with JSON-RPC 2.0 framing.
- `FileSystemRegistry` for URI-based dispatch on per-file operations.

**Phase 1c -- RepositoryAdapter refactor (integration)**
- Replace `this.source` with `this.provider` (a `FileSystemProvider` instance).
- Keep `getMultipleFiles` as a batch convenience that calls `provider.readFile` with concurrency limits.
- Keep `getRepositoryTree` delegating to `provider.listDirectory` (recursive).
- Add `clearCache()`, provider-swap support.

**Phase 1d -- UI wiring (integration)**
- Drawer provider selector, conditional fields, relay status.
- `GitHubRepoViewer.switchProvider()` creating proper provider wrappers.
- `StatePersistence` saving/restoring provider type.
- Status bar provider indicator.

**Phase 1e -- Relay FS handler (integration + protocol)**
- Go relay: JSON-RPC message discrimination, `fs/readFile`, `fs/writeFile`, `fs/applyEdits`, `fs/listDirectory`, `fs/stat` handlers.
- `--root` / `--writable` flags, path traversal prevention.
- `fs/capabilities` notification on display connect.
- `fsnotify`-driven `fs/didChange` push notifications.

**Phase 2 -- Grid editing (grid-editing)**
- `slotToPos` in builder (`buildBatchBuffers` character loop).
- `CodeGrid.getTextPosition()`, cursor mesh, `setCursorAtSlot()`.
- `EditorInputManager` for keyboard capture and TextEdit generation.
- Edits route through `provider.applyEdits(uri, edits)` for persistent files; optimistic local update for immediate re-render.
- `requestAnimationFrame`-batched re-render from day one.
- `EditHistory` for undo/redo (must be designed before keyboard input lands).

**Phase 2b -- Incremental buffer updates (grid-editing, deferred)**
- Only if full re-render per keystroke exceeds 16ms. Grid-editing's own analysis estimates 5-15ms for 50k chars, so this is likely unnecessary initially.

## Dissent

### CodeGrid should store URI, not just `sourcePath`

Protocol and I agree on this (round1-protocol recommendation 7). Grid-editing hasn't addressed it. Currently `CodeGrid.userData.sourcePath` is set at `GitHubRepoViewer.js` line 949 during `createGridForFileAsync`. This must become a full URI (`github://owner/repo/branch/path` or `file:///root/path`). Every downstream consumer -- tab bar, breadcrumb, `onDidChange` matching, edit routing -- needs the canonical URI. Without this, the dual-write flow for editing has no way to route edits back to the correct provider. This is a blocking prerequisite for Phase 2 editing work.

### `getMultipleFiles` must not be replaced by N parallel `readFile` calls

Protocol's flow (phase0-protocol.md lines 187-190) suggests `Promise.all(paths.map(p => provider.readFile(...)))`. This loses `RepositoryAdapter`'s concurrency limiting (`RepositoryAdapter.js` line 256-280 with batched parallel fetch). For GitHub, unbounded parallel requests will hit rate limits. The adapter's batch method must survive, wrapping provider-level `readFile` with a concurrency pool internally. Protocol hasn't acknowledged this constraint.

# Round 3: integration convergence

## Settled

All points are now fully resolved. The three rounds of cross-review have produced consensus on every contested dimension.

1. **JSON-RPC 2.0 is the sole FS wire format.** All three agents explicitly adopted this by Round 2. The custom `{ cmd, id }` envelope is dead. Discrimination on the existing WebSocket is by `"jsonrpc"` field presence. Protocol defined it, integration retracted its custom format, grid-editing endorsed it.

2. **`applyEdits` returns `FileContent` (uri, content, stat), not bare string.** Unanimous by Round 2. The stat metadata enables cache invalidation and dirty-checking without a separate round-trip.

3. **LSP-standard `TextEdit` shape: `{ range: { start: Position, end: Position }, newText }`.** Protocol's original flat `{ start, end, newText }` was retracted in Round 2. All agents agree on the nested `range` wrapper for LSP compatibility.

4. **Tree data uses `{ path, type, size }` with full relative paths.** Protocol retracted basename-only `DirEntry.name` in Round 2. Full relative `path` is required because `filterCodeFiles()` (RepositoryAdapter.js:213+) operates on full paths, and `HierarchicalLayoutManager.layoutHierarchy()` parses paths to build directory structure. Basenames are trivially derived; full paths are not reconstructable without recursion context.

5. **Two-pass tree filtering: server-side coarse + browser-side fine.** Protocol retracted pure consumer-side filtering. The relay applies coarse exclusions (`.git`, `node_modules`, binaries) via `fs/listTree` params `{ uri, exclude?: string[] }`. Browser-side `filterCodeFiles()` applies fine-grained view filtering. All agents agree.

6. **`onDidChange` notification model.** The Go relay uses `fsnotify` to watch the workspace root and pushes `{ jsonrpc: "2.0", method: "fs/didChange", params: { uri, type: "changed"|"created"|"deleted" } }` notifications. Essential for local FS editing from day one.

7. **`FileSystemError` with typed constructors and JSON-RPC error codes.** Error codes in -32001..-32006 range (FileNotFound, PermissionDenied, IsDirectory, DirectoryNotEmpty, RateLimitExceeded, NetworkError) plus standard JSON-RPC codes (-32600..-32602). Static factory methods: `FileSystemError.FileNotFound(uri)`, etc.

8. **`readonly` gating from `FileStat.readonly`.** GitHub files without push access are readonly. The editing input system checks this before accepting keystrokes. UI disables edit affordances for readonly files.

9. **`CodeGrid` stores a `uri` field, not just `sourcePath`.** This is the canonical file identity for `onDidChange` event matching, edit routing, tab/breadcrumb display, and provider resolution. Set at load time in `createGridForFileAsync`. `sourcePath` continues to exist for backward compatibility but `uri` is the primary key.

10. **Shared types file at `src/services/data/types.js`.** JSDoc typedefs for `TextEdit`, `FileContent`, `FileStat`, `DirEntry`, `FileSystemProvider`, `FileSystemError`. All workstreams import from it. No runtime code -- pure type documentation.

11. **URI-driven dispatch for per-file I/O, adapter-level primary scheme for bulk tree-loading.** `FileSystemRegistry` resolves `readFile`/`writeFile`/`applyEdits`/`stat` by URI scheme. `RepositoryAdapter` holds the active provider for `getRepositoryTree` + `getMultipleFiles` bulk operations. These coexist without conflict.

12. **`getMultipleFiles` stays on `RepositoryAdapter`, not on the provider interface.** The adapter internally calls `provider.readFile()` N times with its own concurrency pool (existing batched parallel fetch at RepositoryAdapter.js:287+). The provider interface stays minimal. Protocol's concern about unbounded `Promise.all` is resolved: the adapter's existing concurrency limiting wraps provider-level calls.

13. **GitHub URI branch disambiguation uses query params.** `github://owner/repo?ref=feature/auth&path=src/index.js` eliminates the ambiguity of `github://owner/repo/feature/auth/src/index.js` where `/` in branch names creates unparseable paths. Protocol retracted the path-embedded branch design.

14. **`slotToPos` naming: `[line, rawCol, slotCol]` interleaved Int32Array.** Grid-editing's `slotCol` naming won for the buffer-slot column index. `rawCol` is the 0-based character index within the source line (LSP `Position.character`). Integration's `charIndex` proposal was rejected because it implies absolute file offset, not per-line column. The three fields per slot are: `line` (0-based source line), `rawCol` (0-based source column, tabs/CRs counted), `slotCol` (0-based index among emitted buffer slots on this line).

15. **`rawCol` tracks source string column, including tabs/CRs.** Tabs and CRs increment `rawCol` but produce no buffer slot. This is required for LSP TextEdit compatibility where `Position.character` is the column offset within the line. The builder's existing skip logic (charCode 9/13 at index.js:356) continues to skip these characters for rendering but the `slotToPos` builder must still increment `rawCol` for them.

16. **`requestAnimationFrame` debouncing from day one.** Keystrokes coalesce into `_pendingContent`; re-render fires once per animation frame. Cursor updates immediately from text arithmetic; visual re-render is at most one frame behind. Non-negotiable for key-repeat at 30ms intervals.

17. **Dual-write edit flow: optimistic local + provider persistence + reconciliation.** Sequence: (a) apply edit to in-memory `grid.content`/`grid.lines` immediately, (b) schedule re-render via `requestAnimationFrame`, (c) send `provider.applyEdits(grid.uri, edits)` via JSON-RPC, (d) on response, compare provider content with local state -- if different, re-render from provider's authoritative content. The relay is the source of truth for persistent files.

18. **Undo/redo: per-CodeGrid `EditHistory`, browser-side, snapshot-based for Phase 1.** Records `{ forward: TextEdit[], inverse: TextEdit[] }` pairs. Provider does not own undo -- it is a UI concern. Undo calls `applyEdits` with the inverse operations. Stack is lost on page refresh (acceptable for Phase 1; persistence is Phase 2).

19. **Go relay `--root` / `--writable` flags.** `--root` sandboxes all paths; `..` traversal is rejected. `--writable` is opt-in for `fs/applyEdits` and `fs/writeFile`. `fs/capabilities` notification sent on display connect reports root path and write-enabled state.

20. **Incremental buffer updates deferred to Phase 2.** Full re-render per edit via the worker pipeline is acceptable at <15ms for 50k chars. The `slotToPos` Int32Array design supports future incremental updates (`copyWithin` for slot shifting), but building the incremental path is not Phase 1 scope.

---

## Implementation Plan

### Phase 1a: Types and Interface (foundation -- must land first)

**New file: `src/services/data/types.js`**

```js
/**
 * @typedef {Object} Position
 * @property {number} line - 0-based line index
 * @property {number} character - 0-based character offset within the line
 */

/**
 * @typedef {Object} Range
 * @property {Position} start
 * @property {Position} end - exclusive
 */

/**
 * @typedef {Object} TextEdit
 * @property {Range} range
 * @property {string} newText
 */

/**
 * @typedef {Object} FileStat
 * @property {'file'|'directory'|'symlink'} type
 * @property {number} size - bytes (0 for directories)
 * @property {number} mtime - Unix ms timestamp
 * @property {string|null} sha - content hash if available
 * @property {boolean} readonly - true if write access is unavailable
 */

/**
 * @typedef {Object} FileContent
 * @property {string} uri - canonical URI
 * @property {string} content - UTF-8 text
 * @property {FileStat} stat
 */

/**
 * @typedef {Object} DirEntry
 * @property {string} path - full relative path from root
 * @property {'file'|'directory'|'symlink'} type
 * @property {number} size
 * @property {string} [sha] - optional content hash
 */

/**
 * @typedef {Object} FileChangeEvent
 * @property {string} uri
 * @property {'changed'|'created'|'deleted'} type
 */
```

Plus `FileSystemError` class (runtime code) and `FileSystemProvider` JSDoc interface:

```js
export class FileSystemError extends Error {
    constructor(message, code, uri) {
        super(message);
        this.name = 'FileSystemError';
        this.code = code;
        this.uri = uri;
    }
    static FileNotFound(uri) { return new FileSystemError('File not found', -32001, uri); }
    static PermissionDenied(uri) { return new FileSystemError('Permission denied', -32002, uri); }
    static IsDirectory(uri) { return new FileSystemError('Is a directory', -32003, uri); }
    static RateLimited(uri) { return new FileSystemError('Rate limit exceeded', -32005, uri); }
    static NetworkError(uri, cause) { return new FileSystemError(`Network error: ${cause}`, -32006, uri); }
}
```

The `FileSystemProvider` interface (documented as JSDoc, not a class to instantiate):

```js
/**
 * @interface FileSystemProvider
 * @property {string} scheme - 'github', 'file', 'memory'
 *
 * @method readFile
 * @param {string} uri
 * @returns {Promise<FileContent>}
 *
 * @method writeFile
 * @param {string} uri
 * @param {string} content
 * @returns {Promise<FileStat>}
 *
 * @method applyEdits
 * @param {string} uri
 * @param {TextEdit[]} edits
 * @returns {Promise<FileContent>}
 *
 * @method listTree
 * @param {string} uri
 * @param {Object} [options]
 * @param {string[]} [options.exclude] - glob patterns to exclude
 * @returns {Promise<DirEntry[]>}
 *
 * @method stat
 * @param {string} uri
 * @returns {Promise<FileStat>}
 *
 * @method onDidChange
 * @param {function(FileChangeEvent): void} callback
 * @returns {function(): void} unsubscribe
 *
 * @method dispose
 * @returns {Promise<void>}
 */
```

**Modify: `src/services/data/index.js`** -- Add exports for `FileSystemError` and re-export types module.

---

### Phase 1b: FileSystemRegistry + Provider Implementations

**New file: `src/services/data/FileSystemRegistry.js`**

```js
export class FileSystemRegistry {
    constructor() {
        this._providers = new Map(); // scheme -> provider
        this._changeListeners = [];
    }

    register(provider) {
        this._providers.set(provider.scheme, provider);
        // Wire onDidChange through to registry listeners
        if (typeof provider.onDidChange === 'function') {
            provider.onDidChange((event) => {
                for (const cb of this._changeListeners) cb(event);
            });
        }
    }

    resolve(uri) {
        const scheme = uri.split('://')[0];
        const provider = this._providers.get(scheme);
        if (!provider) throw new Error(`No provider for scheme: ${scheme}`);
        return provider;
    }

    async readFile(uri) { return this.resolve(uri).readFile(uri); }
    async writeFile(uri, content) { return this.resolve(uri).writeFile(uri, content); }
    async applyEdits(uri, edits) { return this.resolve(uri).applyEdits(uri, edits); }
    async stat(uri) { return this.resolve(uri).stat(uri); }
    async listTree(uri, options) { return this.resolve(uri).listTree(uri, options); }

    onDidChange(callback) {
        this._changeListeners.push(callback);
        return () => {
            const idx = this._changeListeners.indexOf(callback);
            if (idx >= 0) this._changeListeners.splice(idx, 1);
        };
    }

    dispose() {
        for (const p of this._providers.values()) p.dispose();
        this._providers.clear();
        this._changeListeners.length = 0;
    }
}
```

**New file: `src/services/data/GitHubProvider.js`**

Wraps `GitHubRepositorySource` + `RepositoryContentCache`. Implements `FileSystemProvider`.

- `scheme` = `'github'`
- Constructor takes `{ token, timeout, cache }` -- creates internal `GitHubRepositorySource` and `RepositoryContentCache`
- `readFile(uri)` -- parses `github://owner/repo?ref=branch&path=...`, calls `source.fetchRawFile(owner, repo, path, branch)`, returns `FileContent`
- `writeFile()` -- throws `FileSystemError.PermissionDenied(uri)` (GitHub is readonly without a write API integration)
- `applyEdits()` -- throws `FileSystemError.PermissionDenied(uri)`
- `listTree(uri)` -- calls `source.fetchTree(owner, repo, branch)`, maps result to `DirEntry[]` with full relative paths
- `stat(uri)` -- returns stat from cache or fetches file headers
- `onDidChange()` -- no-op (GitHub has no push notifications); returns a noop unsubscribe function
- `dispose()` -- clears cache

Key method for URI parsing:

```js
_parseUri(uri) {
    const url = new URL(uri);
    // github://owner/repo?ref=branch&path=src/index.js
    const owner = url.hostname;  // 'owner'
    const repo = url.pathname.replace(/^\//, ''); // 'repo'
    const ref = url.searchParams.get('ref') || 'main';
    const path = url.searchParams.get('path') || '';
    return { owner, repo, ref, path };
}
```

**New file: `src/services/data/MemoryProvider.js`**

In-process provider for demos and tests.

- `scheme` = `'memory'`
- Internal `Map<string, { content, stat }>` store
- `readFile(uri)` -- looks up in map, throws `FileNotFound` if missing
- `writeFile(uri, content)` -- upserts into map, fires `onDidChange`
- `applyEdits(uri, edits)` -- reads content, applies edits bottom-to-top, writes back, returns `FileContent`
- `listTree(uri)` -- returns all keys as `DirEntry[]`
- `onDidChange(callback)` -- synchronous event on write
- `dispose()` -- clears map

**New file: `src/services/data/RemoteFileSystemProvider.js`**

JSON-RPC 2.0 client wrapping the WebSocket relay for local filesystem access.

- `scheme` = `'file'`
- Constructor takes `WebSocketBridge` instance
- Internal `_nextId` counter, `_pending` Map for response correlation, `_changeCallbacks` array
- `_rpc(method, params)` -- sends `{ jsonrpc: "2.0", id: ++_nextId, method, params }` via bridge, returns promise resolved by response
- `readFile(uri)` -- `_rpc('fs/readFile', { uri })`, returns `FileContent`
- `writeFile(uri, content)` -- `_rpc('fs/writeFile', { uri, content })`, returns `FileStat`
- `applyEdits(uri, edits)` -- `_rpc('fs/applyEdits', { uri, edits })`, returns `FileContent`
- `listTree(uri, options)` -- `_rpc('fs/listTree', { uri, exclude: options?.exclude })`, returns `DirEntry[]`
- `stat(uri)` -- `_rpc('fs/stat', { uri })`, returns `FileStat`
- `onDidChange(callback)` -- registers callback; `_handleNotification` dispatches `fs/didChange` events
- `dispose()` -- clears pending, unregisters from bridge

---

### Phase 1c: WebSocketBridge JSON-RPC support

**Modify: `src/services/orchestration/WebSocketBridge.js`**

Add three things:

1. **`_rpcResolvers` Map** -- initialized in constructor: `this._rpcResolvers = new Map();`

2. **JSON-RPC discrimination in `_handleMessage()`** -- before the existing command routing (line 326+):

```js
// JSON-RPC response (has 'jsonrpc' and 'id')
if (envelope.jsonrpc === '2.0' && envelope.id !== undefined) {
    const resolver = this._rpcResolvers.get(envelope.id);
    if (resolver) {
        this._rpcResolvers.delete(envelope.id);
        resolver(envelope);
    }
    return;
}

// JSON-RPC notification (has 'jsonrpc', no 'id')
if (envelope.jsonrpc === '2.0' && envelope.method) {
    if (this._rpcNotificationHandler) {
        this._rpcNotificationHandler(envelope);
    }
    return;
}
```

3. **`rpcRequest(method, params)` method** and **`setRpcNotificationHandler(fn)` method**:

```js
rpcRequest(method, params) {
    const id = ++this._rpcNextId;
    return new Promise((resolve, reject) => {
        this._rpcResolvers.set(id, (response) => {
            if (response.error) {
                reject(new FileSystemError(response.error.message, response.error.code, params?.uri));
            } else {
                resolve(response.result);
            }
        });
        this.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
        setTimeout(() => {
            if (this._rpcResolvers.has(id)) {
                this._rpcResolvers.delete(id);
                reject(new Error(`RPC timeout: ${method}`));
            }
        }, 15000);
    });
}

setRpcNotificationHandler(fn) {
    this._rpcNotificationHandler = fn;
}
```

---

### Phase 1d: RepositoryAdapter refactor

**Modify: `src/services/data/RepositoryAdapter.js`**

Minimal changes to support provider abstraction without breaking existing GitHub flow:

1. Add `provider` property alongside `source`:
   ```js
   // In constructor:
   this.provider = options.provider || null;
   this.source = options.provider?._source || new GitHubRepositorySource(options);
   ```

2. Add `setProvider(provider)` method:
   ```js
   setProvider(provider) {
       this.provider = provider;
       this.clearCache();
   }
   ```

3. `getRepositoryTree` gains a provider-aware branch:
   - If `this.provider` and provider is not GitHub, calls `this.provider.listTree(uri)` and wraps result in `{ tree: dirEntries }` shape
   - Existing GitHub path via `this.source.fetchTree(owner, repo, branch)` continues unchanged

4. `getMultipleFiles` gains a provider-aware branch:
   - If `this.provider` and provider is not GitHub, calls `this.provider.readFile(uri)` per file with the existing concurrency pool
   - Existing GitHub path continues unchanged

5. Add `clearCache()` method (if not already present) that clears `this.cache`.

---

### Phase 1e: CodeGrid `uri` field

**Modify: `src/collections/CodeGrid.js`**

1. Add `this.uri = null;` in constructor (line 47, alongside `this.sourcePath = null;`)

2. No other CodeGrid changes needed for Phase 1 read-only. The `uri` is set by `GitHubRepoViewer.createGridForFileAsync()`.

**Modify: `app/GitHubRepoViewer.js`**

In `createGridForFileAsync` (around line 949), after setting `grid.userData.sourcePath`:
```js
grid.uri = `github://${owner}/${repo}?ref=${branch}&path=${path}`;
grid.userData.sourcePath = path;
```

For local FS:
```js
grid.uri = `file://${path}`;
```

---

### Phase 1f: UI wiring

**Modify: `app/components/Drawer.js`**

In `repoPanelHTML()` (line 197+), add provider selector dropdown above existing GitHub fields. Show/hide field groups based on selection. The exact HTML is in integration's Phase 0 lines 206-253 -- adopt as-is.

**Modify: `app/GitHubRepoViewer.js`**

1. Add `switchProvider(providerName)` method that:
   - Creates the appropriate provider wrapper (`GitHubProvider`, `RemoteFileSystemProvider`, `MemoryProvider`)
   - Calls `this.repoAdapter.setProvider(provider)`
   - Calls `this.clearGrids()`
   - Resets tree/branch UI
   - Updates status bar

2. Wire provider selector `change` event in `setupEventListeners()` (line 536+)

3. Gate `fetchBranches()` (line 830) behind `provider.scheme === 'github'` check

4. Gate `loadRepository()` (line 900) to construct appropriate URI based on active provider scheme

**Modify: `app/ide.html`**

Add `#status-provider` span in status bar. Extend URL param handling for `?provider=` parameter.

**Modify: `app/IDEShell.js`**

Read `#status-provider` element, update in `updateStatusBar()`.

**Modify: `app/StatePersistence.js`**

Persist and restore `provider` type alongside `repoUrl` and `branch`.

---

### Phase 1g: Go relay FS handler

**New file: `cli/fs.go`**

JSON-RPC 2.0 handler for filesystem operations. Methods:

- `fs/readFile` -- `os.ReadFile(uriToPath(uri))`, returns `FileContent` JSON
- `fs/writeFile` -- `os.WriteFile(uriToPath(uri), content)`, gated by `--writable` flag, returns `FileStat`
- `fs/applyEdits` -- reads file, sorts edits bottom-to-top, applies line-by-line, writes back, returns `FileContent`
- `fs/listTree` -- `filepath.WalkDir(root)`, applies `exclude` patterns, returns `[]DirEntry` with full relative paths
- `fs/stat` -- `os.Stat(uriToPath(uri))`, returns `FileStat`

Path security: `uriToPath(uri)` resolves `file:///path` to absolute path, checks that it is within `--root`, rejects `..` traversal.

`fsnotify` watcher: watches `--root` recursively, sends `fs/didChange` notifications to display WebSocket.

`fs/capabilities` notification: sent on display connect with `{ root, writable, scheme: "file" }`.

**Modify: `cli/relay.go`**

Add JSON-RPC discrimination in the message handler (line 127+):

```go
if len(msg) > 0 && msg[0] == '{' {
    var peek struct { JSONRPC string `json:"jsonrpc"` }
    if json.Unmarshal(msg, &peek) == nil && peek.JSONRPC == "2.0" {
        r.handleFSRequest(ws, msg)
        continue
    }
}
```

**Modify: `cli/main.go`**

Add `--root` and `--writable` flags to `serve` command. Pass to relay and FS handler.

**Modify: `cli/go.mod`**

Add `github.com/fsnotify/fsnotify` dependency.

---

### Phase 2a: `slotToPos` in builder

**Modify: `src/workers/builders/index.js`**

In `buildBatchBuffers`, inside the existing character loop (line 321-390):

1. Before the loop, allocate `slotToPos = new Int32Array(totalItemGlyphs * 3)` and initialize counters: `currentLine = 0`, `rawCol = 0`, `slotCol = 0`, `lineVisCharCounts = []`, `lineVisCount = 0`.

2. On newline (line 324): push `lineVisCount` to `lineVisCharCounts`, reset `rawCol = 0`, `slotCol = 0`, `lineVisCount = 0`, increment `currentLine`.

3. On space (line 350): increment `rawCol`. Do NOT increment `slotCol` (spaces get no buffer slot).

4. On CR/tab (line 356): increment `rawCol` for both (they occupy positions in the source string).

5. On visible glyph emit (line 369-389), before `bufferOffset++`:
   ```js
   slotToPos[bufferOffset * 3]     = currentLine;
   slotToPos[bufferOffset * 3 + 1] = rawCol;
   slotToPos[bufferOffset * 3 + 2] = slotCol;
   rawCol++;
   slotCol++;
   lineVisCount++;
   ```

6. After item loop, push final `lineVisCount`.

7. Store in `itemMeta[itemIdx]`:
   ```js
   itemMeta[itemIdx].slotToPos = slotToPos;
   itemMeta[itemIdx].lineVisCharCounts = new Int32Array(lineVisCharCounts);
   ```

Apply the same changes to `buildGlyphBuffers` for the single-text path.

**Modify: `src/workers/WorkerBridge.js`**

Add `slotToPos` Int32Array to the transferable list in the worker message handler.

---

### Phase 2b: CodeGrid editing methods

**Modify: `src/collections/CodeGrid.js`**

1. Store `slotToPos` and `lineVisCharCounts` in `_buildLineSlotBase`:
   ```js
   this._slotToPos = contentItemMeta?.slotToPos || null;
   this._lineVisCharCounts = contentItemMeta?.lineVisCharCounts || null;
   ```

2. Add `getTextPosition(slotIndex)`:
   ```js
   getTextPosition(slotIndex) {
       if (!this._slotToPos) return null;
       const contentBase = this._lineSlotBase?.[0] ?? 0;
       const localSlot = slotIndex - contentBase;
       if (localSlot < 0 || localSlot * 3 + 2 >= this._slotToPos.length) return null;
       const i = localSlot * 3;
       return {
           line: this._slotToPos[i],
           rawCol: this._slotToPos[i + 1],
           slotCol: this._slotToPos[i + 2],
       };
   }
   ```

3. Add `rawColToSlotCol(line, rawCol)` and `slotColToRawCol(line, slotCol)` methods (character-scanning conversion functions from grid-editing's Phase 0 section 3, adapted with correct naming).

4. Add cursor mesh (`_createCursor()`, `setCursorAtSlot(slotIndex)`) as a separate `THREE.Mesh` child of the CodeGrid.

---

### Phase 2c: EditorInputManager

**New file: `app/EditorInputManager.js`**

Keyboard capture and TextEdit generation:

- Constructor takes `{ registry }` (the `FileSystemRegistry`)
- `setActiveGrid(grid)` / `clearActiveGrid()` -- called on pick/click
- `onKeyDown(event)` -- generates `TextEdit` from keystroke using cursor position (from `grid.getTextPosition`)
- `_applyEdit(edit)` -- dual-write: (a) splice `grid.content` in-memory, (b) schedule re-render via `requestAnimationFrame`, (c) call `registry.applyEdits(grid.uri, [edit])`, (d) reconcile on response
- `_scheduleRerender()` -- coalesces into one `requestAnimationFrame` per frame
- Arrow key / Home / End navigation -- move cursor without edit
- `Ctrl+Z` / `Ctrl+Shift+Z` -- undo/redo via `EditHistory`

---

### Phase 2d: EditHistory

**New file: `app/EditHistory.js`**

Per-CodeGrid undo/redo stack:

```js
export class EditHistory {
    constructor() {
        this._undoStack = []; // { forward: TextEdit[], inverse: TextEdit[] }
        this._redoStack = [];
    }

    push(forward, inverse) {
        this._undoStack.push({ forward, inverse });
        this._redoStack.length = 0; // clear redo on new edit
    }

    undo() {
        const entry = this._undoStack.pop();
        if (!entry) return null;
        this._redoStack.push(entry);
        return entry.inverse;
    }

    redo() {
        const entry = this._redoStack.pop();
        if (!entry) return null;
        this._undoStack.push(entry);
        return entry.forward;
    }
}
```

---

### Phase 2e: Refactor highlightCommands

**Modify: `app/commands/handlers/highlightCommands.js`**

Replace inline vis/raw conversion (line 226-235) with calls to `CodeGrid.rawColToSlotCol()` / `CodeGrid.slotColToRawCol()`.

---

### Files summary

| File | Action | Phase |
|------|--------|-------|
| `src/services/data/types.js` | CREATE | 1a |
| `src/services/data/FileSystemRegistry.js` | CREATE | 1b |
| `src/services/data/GitHubProvider.js` | CREATE | 1b |
| `src/services/data/MemoryProvider.js` | CREATE | 1b |
| `src/services/data/RemoteFileSystemProvider.js` | CREATE | 1b |
| `src/services/data/index.js` | MODIFY -- add exports | 1b |
| `src/services/orchestration/WebSocketBridge.js` | MODIFY -- JSON-RPC support | 1c |
| `src/services/data/RepositoryAdapter.js` | MODIFY -- provider-aware | 1d |
| `src/collections/CodeGrid.js` | MODIFY -- `uri` field (1e), `slotToPos`/cursor (2b) | 1e, 2b |
| `app/GitHubRepoViewer.js` | MODIFY -- `switchProvider`, URI on grid, provider gating | 1f |
| `app/components/Drawer.js` | MODIFY -- provider selector UI | 1f |
| `app/ide.html` | MODIFY -- status bar, URL params | 1f |
| `app/IDEShell.js` | MODIFY -- status provider indicator | 1f |
| `app/StatePersistence.js` | MODIFY -- persist provider type | 1f |
| `cli/fs.go` | CREATE | 1g |
| `cli/relay.go` | MODIFY -- JSON-RPC discrimination | 1g |
| `cli/main.go` | MODIFY -- `--root`/`--writable` flags | 1g |
| `cli/go.mod` | MODIFY -- add fsnotify | 1g |
| `src/workers/builders/index.js` | MODIFY -- `slotToPos` in builder | 2a |
| `src/workers/WorkerBridge.js` | MODIFY -- transferable list | 2a |
| `app/EditorInputManager.js` | CREATE | 2c |
| `app/EditHistory.js` | CREATE | 2d |
| `app/commands/handlers/highlightCommands.js` | MODIFY -- use CodeGrid methods | 2e |

---

## Implementer Vote

**protocol** should implement.

Rationale: The converged plan's center of gravity is the type system, the provider interface, the registry, the JSON-RPC wire format, and the Go relay handler. These are all protocol's original domain. Protocol's Phase 0 produced the most complete specification of the `FileSystemProvider` interface, the JSON-RPC message shapes, the error code taxonomy, the `FileSystemRegistry`, and the relay-side handler pseudocode. The implementation work is primarily about materializing those specifications into files, then wiring them through `WebSocketBridge` and `RepositoryAdapter` -- which are now well-specified enough that protocol can build them from the converged plan without ambiguity.

Grid-editing's contribution (slotToPos, cursor, EditorInputManager) is Phase 2 and can be built on top of the provider layer once it exists. Integration's contribution (UI wiring, provider selector, RepositoryAdapter refactor) is important but is the thinnest layer -- it is mostly DOM manipulation and adapter plumbing that can follow quickly once the types and providers exist. Protocol's work is the foundation that everything else depends on, and protocol wrote the most implementation-ready specification for it.

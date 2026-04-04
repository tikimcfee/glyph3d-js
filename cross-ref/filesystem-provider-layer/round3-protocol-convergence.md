# Round 3: protocol convergence

## Settled

All points fully resolved after three rounds of cross-review. Every decision below has unanimous or near-unanimous agreement from all three agents.

1. **JSON-RPC 2.0 is the sole FS wire format.** Discriminated from existing command traffic by the `"jsonrpc"` field. Integration's custom `{ cmd: "fs.list" }` envelope is dead. Methods: `fs/readFile`, `fs/writeFile`, `fs/applyEdits`, `fs/listTree`, `fs/stat`. Notifications: `fs/didChange` (no `id`). Standard JSON-RPC error codes in the -32001..-32006 range for FS-specific errors, plus -32600/-32601/-32602 for protocol errors.

2. **`applyEdits` returns `FileContent` (not bare string).** `FileContent` is `{ uri, content, stat }` where `stat` includes `mtime`, `size`, `sha`, `readonly`. This eliminates a separate `stat` round-trip after edits and enables dirty-checking and cache invalidation.

3. **LSP-standard `TextEdit` shape.** `{ range: { start: { line, character }, end: { line, character } }, newText }`. Protocol's original flat `{ start, end, newText }` is retracted. The `range` wrapper matches LSP exactly, avoiding a gratuitous translation layer for any future language server integration.

4. **Tree data uses `{ path, type, size }` with full relative paths.** Protocol's basename-only `DirEntry.name` is retracted. The existing codebase (`filterCodeFiles()`, `HierarchicalLayoutManager.layoutHierarchy()`) operates on full relative paths. Basenames are trivially derived; full paths are not reconstructable without recursion context. Optional `sha` field for GitHub.

5. **URI-driven dispatch for file I/O, adapter-swap for tree-loading context.** `FileSystemRegistry` resolves `readFile`, `writeFile`, `applyEdits`, `stat` by URI scheme. `RepositoryAdapter` holds the active provider for bulk `getRepositoryTree` + `getMultipleFiles`. These coexist: the adapter calls `provider.readFile` N times with its own concurrency limiter for batch operations. The provider interface has no batch method.

6. **`CodeGrid` stores a `uri` field.** Set at load time (currently `userData.sourcePath` at `GitHubRepoViewer.js:949`). The URI is the canonical identity for `onDidChange` event matching, edit routing, tab bar display, and provider dispatch. Format: `github://owner/repo?ref=main&path=src/index.js` or `file:///home/user/dev/project/src/index.js` or `memory://session/scratch.js`.

7. **GitHub URI uses query params for branch disambiguation.** `github://owner/repo?ref=feature/auth&path=src/index.js` eliminates the ambiguity of embedding `/`-containing branch names in path segments. Protocol originally used path-based encoding and retracts it.

8. **Server-side coarse filtering + browser-side fine filtering for tree listing.** The Go relay applies exclusion patterns server-side (`.git`, `node_modules`, binaries) via `fs/listTree` params `{ uri, exclude?: string[] }`. Browser-side `filterCodeFiles()` applies view-level filtering (extensions, size limits). Two-pass design avoids megabytes of irrelevant tree data over WebSocket.

9. **`onDidChange` notification model.** `fs/didChange` pushed from Go relay via `fsnotify` for local FS changes. GitHub provider has no push (polling or manual refresh). Memory provider fires synchronously on writes. CodeGrid re-renders via existing `loadFileAsync` path when its URI is changed externally.

10. **`FileSystemError` with typed constructors.** Static factory methods (`FileNotFound`, `PermissionDenied`, `IsDirectory`, `RateLimited`) map to JSON-RPC error codes. `RemoteFileSystemProvider` converts JSON-RPC error responses into `FileSystemError` instances.

11. **`readonly` gating.** `FileStat.readonly` is `true` for GitHub (no push access), `false` for local FS with `--writable`. The editing input system checks `readonly` before accepting keystrokes.

12. **Shared types file.** `src/services/data/types.js` defines JSDoc typedefs for `TextEdit`, `FileContent`, `FileStat`, `DirEntry`, `FileSystemProvider`, `FileSystemError`. All modules import from it.

13. **`slotToPos` naming.** The interleaved `Int32Array` stores `[line, rawCol, slotCol]` per buffer slot. `rawCol` is the 0-based index into the source line string (LSP `Position.character`). `slotCol` is the 0-based index among emitted buffer slots on that line. Grid-editing's `rawCol` naming is retained; protocol's `charIndex` and integration's suggestion are both retracted since `rawCol` maps directly to LSP's column concept. The third field is `slotCol` (not `visCol`).

14. **`slotToPos` built in the same pass as glyph buffers.** Zero extra passes. Inserted into `buildBatchBuffers` character loop (line 321-389 of `src/workers/builders/index.js`). Cost: 12 bytes per glyph (3 x Int32), negligible vs the 40 bytes already written per glyph.

15. **`requestAnimationFrame` debouncing from day one.** Keystrokes coalesce into one re-render per frame. Cursor position updates immediately from text arithmetic; visual re-render is at most one frame behind.

16. **Full re-render per edit initially.** The worker pipeline handles 50k chars in <15ms. Incremental buffer updates are deferred but the `slotToPos` data structure is designed to support future `copyWithin`-based slot shifting.

17. **Undo/redo: per-CodeGrid `EditHistory`, browser-side, snapshot-based for Phase 1.** Records `{ forward: TextEdit[], inverse: TextEdit[] }` pairs. The provider does not own undo -- it is a UI concern. Must be designed before keyboard input lands.

18. **Dual-write reconciliation.** Sequence: (a) apply edit to in-memory text immediately, (b) schedule re-render via `requestAnimationFrame`, (c) send `provider.applyEdits(uri, edits)` via JSON-RPC, (d) compare relay response content against local state, (e) if different, re-render from authoritative content. For Phase 1, always trust the relay response ("last write wins"). Version-stamped reconciliation is deferred.

19. **`getMultipleFiles` stays on `RepositoryAdapter`, not on the provider interface.** The adapter calls `provider.readFile` N times with its existing concurrency limiter (chunked `Promise.all` at `RepositoryAdapter.js:256-280`). Provider interface stays minimal.

20. **Go relay flags: `--root` and `--writable`.** `--root` sets the filesystem sandbox root; all paths are resolved relative and traversal via `..` is rejected. `--writable` enables `fs/applyEdits` and `fs/writeFile`. Without `--writable`, write methods return `PermissionDenied`.

## Implementation Plan

### Tier 1: Types, Registry, Read-Only Providers

#### 1. `src/services/data/types.js` (NEW)

JSDoc typedefs only -- no runtime code. Every other module imports types from here.

```js
/**
 * @typedef {{ line: number, character: number }} Position
 *   0-based line and column. `character` is the index into the source string
 *   for that line (tabs count, matching LSP Position.character).
 */

/**
 * @typedef {Object} TextEdit
 * @property {{ start: Position, end: Position }} range
 * @property {string} newText
 */

/**
 * @typedef {Object} FileStat
 * @property {'file'|'directory'|'symlink'} type
 * @property {number} size        - bytes
 * @property {number} mtime       - Unix ms timestamp
 * @property {string|null} sha    - content hash (GitHub provides; local FS null)
 * @property {boolean} readonly   - true for GitHub without push, or relay without --writable
 */

/**
 * @typedef {Object} FileContent
 * @property {string} uri
 * @property {string} content     - UTF-8 text
 * @property {FileStat} stat
 */

/**
 * @typedef {Object} DirEntry
 * @property {string} path        - full relative path from root
 * @property {'file'|'directory'|'symlink'} type
 * @property {number} size
 * @property {string} [sha]
 */

/**
 * @typedef {Object} FileSystemProvider
 * @property {string} scheme
 * @property {(uri: string) => Promise<FileContent>} readFile
 * @property {(uri: string, content: string) => Promise<FileStat>} writeFile
 * @property {(uri: string, edits: TextEdit[]) => Promise<FileContent>} applyEdits
 * @property {(uri: string) => Promise<DirEntry[]>} listTree
 * @property {(uri: string) => Promise<FileStat>} stat
 * @property {(callback: function) => function} onDidChange  - returns unsubscribe fn
 * @property {() => Promise<void>} dispose
 */
```

Also define `FileSystemError`:

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
}
```

#### 2. `src/services/data/FileSystemRegistry.js` (NEW)

URI-scheme dispatch for per-file operations.

```js
export class FileSystemRegistry {
    constructor() {
        /** @type {Map<string, FileSystemProvider>} */
        this._providers = new Map();
        /** @type {Array<function>} */
        this._changeListeners = [];
    }

    register(provider) {
        this._providers.set(provider.scheme, provider);
        // Wire provider's onDidChange to our aggregated listeners
        provider.onDidChange((event) => {
            for (const cb of this._changeListeners) cb(event);
        });
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
    async listTree(uri) { return this.resolve(uri).listTree(uri); }

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

#### 3. `src/services/data/GitHubProvider.js` (NEW)

Wraps `GitHubRepositorySource` + `RepositoryContentCache`, implements `FileSystemProvider`. Parses `github://owner/repo?ref=branch&path=...` URIs.

- `readFile(uri)` -> calls `this.source.fetchRawFile(owner, repo, path, ref)` or `fetchFile(...)`, wraps in `FileContent`
- `listTree(uri)` -> calls `this.source.fetchTree(owner, repo, ref)`, maps to `DirEntry[]` with full relative paths
- `stat(uri)` -> extracts from cache or constructs from `readFile` result
- `writeFile`, `applyEdits` -> throw `FileSystemError.PermissionDenied(uri)` (GitHub is read-only)
- `onDidChange` -> no-op (returns empty unsubscribe)
- `dispose` -> clears cache reference
- Non-FS operations (`fetchBranches`, `getRepositoryInfo`) stay on `GitHubRepositorySource` directly, accessed through a `source` getter on the provider

URI parsing helper:
```js
_parseUri(uri) {
    const url = new URL(uri);
    const owner = url.hostname;                        // 'owner'
    const repo = url.pathname.split('/')[1] || '';     // 'repo'
    const ref = url.searchParams.get('ref') || 'main';
    const path = url.searchParams.get('path') || '';
    return { owner, repo, ref, path };
}
```

#### 4. `src/services/data/MemoryProvider.js` (NEW)

In-process provider for demos and tests. Stores files in a `Map<string, { content, stat }>`. All operations are synchronous wrapped in `Promise.resolve()`. `onDidChange` fires synchronously on `writeFile`/`applyEdits`.

#### 5. `src/services/data/RemoteFileSystemProvider.js` (NEW)

Browser-side JSON-RPC client for local FS access via Go relay.

- Constructor takes `WebSocketBridge` instance
- `scheme` is `'file'`
- `readFile(uri)` -> sends `{ jsonrpc: "2.0", id, method: "fs/readFile", params: { uri } }`, awaits response, returns `FileContent`
- All write methods gate on `this._capabilities.writable` (received from relay on connect via `fs/capabilities` notification)
- `onDidChange` -> listens for `fs/didChange` notifications routed through the bridge
- `_rpc(method, params)` -> sends JSON-RPC request, returns `Promise` that resolves when the matching response arrives (keyed by `id`)

#### 6. Modify `src/services/orchestration/WebSocketBridge.js`

Add JSON-RPC awareness to `_handleMessage`:

```js
async _handleMessage(raw) {
    let envelope;
    try { envelope = JSON.parse(raw); } catch { return; }

    // JSON-RPC response (has 'jsonrpc' and 'id')
    if (envelope.jsonrpc === '2.0' && envelope.id !== undefined) {
        this._rpcResolvers?.get(envelope.id)?.(envelope);
        this._rpcResolvers?.delete(envelope.id);
        return;
    }

    // JSON-RPC notification (has 'jsonrpc' but no 'id')
    if (envelope.jsonrpc === '2.0' && envelope.method) {
        this._rpcNotificationHandler?.(envelope);
        return;
    }

    // ... existing command handling ...
}
```

Add `_rpcResolvers` (Map) and `_rpcNotificationHandler` (function) to constructor. Add `rpcRequest(method, params)` method:

```js
rpcRequest(method, params) {
    const id = ++this._nextRpcId;
    return new Promise((resolve, reject) => {
        this._rpcResolvers.set(id, resolve);
        this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
        setTimeout(() => {
            if (this._rpcResolvers.has(id)) {
                this._rpcResolvers.delete(id);
                reject(new Error(`JSON-RPC timeout: ${method}`));
            }
        }, 10000);
    });
}
```

#### 7. Modify `src/services/data/RepositoryAdapter.js`

- Add `provider` property (defaults to wrapping `GitHubRepositorySource` in a `GitHubProvider` for backward compatibility)
- `getMultipleFiles` keeps its existing concurrency-limited logic, calling `this.provider.readFile(uri)` instead of `this.source.fetchRawFile(...)`
- `getRepositoryTree` delegates to `this.provider.listTree(uri)` and reshapes to existing `{ tree: [...] }` format
- Add `clearCache()` method (already partially exists via cache)
- Keep `filterCodeFiles` unchanged -- it operates on the tree result

#### 8. Modify `src/services/data/index.js`

Add exports for new modules:

```js
export { FileSystemRegistry } from './FileSystemRegistry.js';
export { GitHubProvider } from './GitHubProvider.js';
export { MemoryProvider } from './MemoryProvider.js';
export { RemoteFileSystemProvider } from './RemoteFileSystemProvider.js';
export { FileSystemError } from './types.js';
```

#### 9. Modify `src/collections/CodeGrid.js`

Add `uri` field:

```js
// In constructor:
this.uri = options.uri || null;
```

Ensure `loadFileAsync` preserves the URI. Update all call sites that set `userData.sourcePath` to also set `grid.uri`.

#### 10. Modify `app/GitHubRepoViewer.js`

- In `createGridForFileAsync` (line ~949): set `grid.uri` from the provider's URI scheme + path
- Add `switchProvider(providerName)` method that creates proper provider wrappers (`GitHubProvider`, `RemoteFileSystemProvider`, `MemoryProvider`)
- Gate `fetchBranches()` behind provider capability check
- Wire `fsRegistry.onDidChange` to reload affected CodeGrids

#### 11. Modify `app/components/Drawer.js`

- `repoPanelHTML()` gains provider selector dropdown (`<select id="provider-select">`)
- Conditional field visibility: GitHub fields visible for `github`/`github-auth`, local FS fields for `local`, memory fields for `memory`
- Relay status indicator in local FS section

#### 12. Modify `app/IDEShell.js`

- Add `#status-provider` element reference
- Update `updateStatusBar()` to display active provider name
- Bootstrap `FileSystemRegistry` in init, register providers

#### 13. Modify `app/StatePersistence.js`

- Persist `provider` type alongside `repoUrl` and `branch`
- On restore, call `switchProvider()` before `loadRepository()`

#### 14. `cli/fs.go` (NEW)

Go relay FS handler. JSON-RPC method dispatch:

```go
type FSHandler struct {
    root     string  // --root flag, absolute path
    writable bool    // --writable flag
    watcher  *fsnotify.Watcher
}

func (h *FSHandler) Handle(ws *websocket.Conn, msg []byte) {
    var req struct {
        JSONRPC string          `json:"jsonrpc"`
        ID      int             `json:"id"`
        Method  string          `json:"method"`
        Params  json.RawMessage `json:"params"`
    }
    json.Unmarshal(msg, &req)

    switch req.Method {
    case "fs/readFile":    h.readFile(ws, req.ID, req.Params)
    case "fs/writeFile":   h.writeFile(ws, req.ID, req.Params)
    case "fs/applyEdits":  h.applyEdits(ws, req.ID, req.Params)
    case "fs/listTree":    h.listTree(ws, req.ID, req.Params)
    case "fs/stat":        h.stat(ws, req.ID, req.Params)
    default:
        h.sendError(ws, req.ID, -32601, "Method not found", nil)
    }
}
```

Path resolution: `h.resolvePath(params.uri)` extracts path from `file:///...`, resolves relative to `h.root`, rejects `..` traversal with `-32002` PermissionDenied.

`listTree`: `filepath.WalkDir` with built-in exclusion of `.git`, `node_modules`, `__pycache__`, binary extensions. Params include optional `exclude: []string` for additional patterns. Returns `DirEntry[]` with full relative paths.

`readFile`: `os.ReadFile`, returns `FileContent` JSON.

`applyEdits`: Read file, split lines, sort edits bottom-to-top, apply, write back, return `FileContent`. Requires `h.writable`.

`stat`: `os.Stat`, returns `FileStat` JSON.

`fsnotify` watcher: Watch `h.root` recursively. On file events, push `fs/didChange` notifications to the display WebSocket (no `id` field -- JSON-RPC notification).

#### 15. Modify `cli/relay.go`

Add JSON-RPC detection in the display message loop:

```go
// In handleConnection, at the start of the display message processing:
if role == "display" {
    // Detect JSON-RPC from display
    if len(msg) > 0 && msg[0] == '{' {
        var peek struct { JSONRPC string `json:"jsonrpc"` }
        if json.Unmarshal(msg, &peek) == nil && peek.JSONRPC == "2.0" {
            r.fsHandler.Handle(ws, msg)
            continue
        }
    }
    // ... existing display response routing ...
}
```

Add `fsHandler *FSHandler` field to `Relay` struct. Initialize in `NewRelay` if `--root` is set.

#### 16. Modify `cli/main.go`

Add `--root` and `--writable` flags to `serveCmd`:

```go
func serveCmd() {
    fs := flag.NewFlagSet("serve", flag.ExitOnError)
    p := fs.Int("port", 8765, "Port to listen on")
    listen := fs.String("listen", "0.0.0.0", "Address to listen on")
    root := fs.String("root", "", "Filesystem root for fs/* commands")
    writable := fs.Bool("writable", false, "Allow write operations")
    fs.Parse(os.Args[2:])

    if err := RunRelay(*listen, *p, *root, *writable); err != nil {
        log.Fatalf("[relay] %v", err)
    }
}
```

Update `RunRelay` signature to accept `root string, writable bool`. Add `go.sum` dependency on `github.com/fsnotify/fsnotify`.

### Tier 2: Editing Pipeline

#### 17. Modify `src/workers/builders/index.js`

In `buildBatchBuffers` character loop (line 321-389), add `slotToPos` construction:

```js
// Before the character loop, after itemLineSlotOffsets init (line ~315):
const slotToPos = new Int32Array(totalItemGlyphs * 3);
let currentLine = 0;
let rawCol = 0;
let slotCol = 0;
const lineVisCharCounts = [];
let lineVisCount = 0;

// On newline (line 324):
lineVisCharCounts.push(lineVisCount);
lineVisCount = 0;
currentLine++;
rawCol = 0;
slotCol = 0;

// On space (line 350):
rawCol++;
// (no slotCol++ -- space gets no buffer slot)

// On CR (line 356, charCode === 13):
rawCol++;
// On tab (line 356, charCode === 9):
rawCol++;

// On visible glyph emit (line 369, after codepoints[idx] = resolvedCode):
const si = (bufferOffset - itemStartOffset);  // Wait -- bufferOffset is incremented AFTER, so:
// Actually, insert BEFORE bufferOffset++ at line 387:
slotToPos[(bufferOffset - itemStartOffset) * 3]     = currentLine;
slotToPos[(bufferOffset - itemStartOffset) * 3 + 1] = rawCol;
slotToPos[(bufferOffset - itemStartOffset) * 3 + 2] = slotCol;
rawCol++;
slotCol++;
lineVisCount++;
```

After the item loop, push final line count:
```js
lineVisCharCounts.push(lineVisCount);
```

Add to `itemMeta[itemIdx]`:
```js
itemMeta[itemIdx] = {
    bufferStartIndex: itemStartOffset,
    glyphCount: itemGlyphCount,
    lineSlotOffsets: itemLineSlotOffsets,
    slotToPos,             // NEW
    lineVisCharCounts,     // NEW
    bounds: ...
};
```

Note: `slotToPos` writes happen at the same point as existing attribute writes (positions, sizes, codepoints, colors, groupIds). The `rawCol` and `slotCol` counters track source-string position and buffer-slot position respectively. Tabs and CRs increment `rawCol` but produce no slot. Spaces increment `rawCol` but produce no slot. Only visible glyphs get a `slotToPos` entry.

#### 18. Modify `src/workers/WorkerBridge.js`

Add `slotToPos` (Int32Array) to the transferable list when posting results back from workers.

#### 19. Modify `src/collections/CodeGrid.js`

```js
// After _buildLineSlotBase:
this._slotToPos = contentItemMeta?.slotToPos || null;
this._lineVisCharCounts = contentItemMeta?.lineVisCharCounts || null;

// New methods:
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

rawColToSlotCol(line, rawCol) {
    const text = this.lines[line];
    if (!text) return 0;
    let slot = 0;
    for (let i = 0; i < rawCol && i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c !== 10 && c !== 32 && c !== 13 && c !== 9) slot++;
    }
    return slot;
}

slotColToRawCol(line, slotCol) {
    const text = this.lines[line];
    if (!text) return 0;
    let slot = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c !== 10 && c !== 32 && c !== 13 && c !== 9) {
            if (slot === slotCol) return i;
            slot++;
        }
    }
    return text.length;
}
```

Add cursor mesh (separate `THREE.Mesh` child):

```js
_createCursor() {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.8,
        side: THREE.DoubleSide, depthWrite: false
    });
    this._cursor = new THREE.Mesh(geo, mat);
    this._cursor.visible = false;
    this.add(this._cursor);
}

setCursorAtSlot(slotIndex) {
    const renderer = this._collection.getRenderer();
    const positions = renderer.instanceMesh.geometry.attributes.instancePosition.array;
    const sizes = renderer.instanceMesh.geometry.attributes.instanceSize.array;
    const x = positions[slotIndex * 3];
    const y = positions[slotIndex * 3 + 1];
    const z = positions[slotIndex * 3 + 2];
    const w = sizes[slotIndex * 2];
    const h = sizes[slotIndex * 2 + 1];
    this._cursor.scale.set(w * 0.08, h, 1);
    this._cursor.position.set(x - w * 0.04, y + h * 0.5, z + 0.01);
    this._cursor.visible = true;
}
```

#### 20. `app/EditorInputManager.js` (NEW)

Keyboard capture, TextEdit generation, edit application, cursor management.

- Activated when a CodeGrid gains focus (via picking click)
- Checks `grid.stat?.readonly` before accepting any edit keystrokes
- Character insertion, backspace, enter, arrow keys
- Generates LSP `TextEdit` from keystrokes using `rawCol` from `slotToPos`
- `_applyEdit(edit)`: (a) apply to in-memory `grid.content` and `grid.lines`, (b) schedule re-render via `requestAnimationFrame`, (c) if grid has a provider URI, send `provider.applyEdits(grid.uri, [edit])`, (d) on response, reconcile
- Cursor blink: 500ms toggle on `_cursor.visible`
- Arrow-key navigation: use position buffer for visual adjacency (handles Z-wrap correctly)

#### 21. `app/EditHistory.js` (NEW)

Per-CodeGrid undo/redo stack. Browser-side, snapshot-based for Phase 1.

```js
export class EditHistory {
    constructor(maxEntries = 100) {
        this._stack = [];     // { forward: TextEdit[], inverse: TextEdit[] }
        this._index = -1;     // points to last applied entry
        this._max = maxEntries;
    }

    push(forwardEdits, inverseEdits) {
        // Truncate any redo entries after current index
        this._stack.length = this._index + 1;
        this._stack.push({ forward: forwardEdits, inverse: inverseEdits });
        if (this._stack.length > this._max) this._stack.shift();
        this._index = this._stack.length - 1;
    }

    undo() {
        if (this._index < 0) return null;
        const entry = this._stack[this._index--];
        return entry.inverse;
    }

    redo() {
        if (this._index >= this._stack.length - 1) return null;
        const entry = this._stack[++this._index];
        return entry.forward;
    }

    get canUndo() { return this._index >= 0; }
    get canRedo() { return this._index < this._stack.length - 1; }
}
```

#### 22. Modify `app/commands/handlers/highlightCommands.js`

Refactor inline raw/vis col conversion to use `CodeGrid.rawColToSlotCol()` and `CodeGrid.slotColToRawCol()`.

### File Summary

| Action | File | Description |
|--------|------|-------------|
| CREATE | `src/services/data/types.js` | JSDoc typedefs + `FileSystemError` class |
| CREATE | `src/services/data/FileSystemRegistry.js` | URI-scheme dispatch |
| CREATE | `src/services/data/GitHubProvider.js` | GitHub FS provider wrapping existing source |
| CREATE | `src/services/data/MemoryProvider.js` | In-memory demo provider |
| CREATE | `src/services/data/RemoteFileSystemProvider.js` | JSON-RPC client for Go relay |
| CREATE | `cli/fs.go` | Go relay FS handler (readFile, writeFile, applyEdits, listTree, stat, fsnotify) |
| CREATE | `app/EditorInputManager.js` | Keyboard capture + TextEdit generation |
| CREATE | `app/EditHistory.js` | Per-grid undo/redo stack |
| MODIFY | `src/services/data/RepositoryAdapter.js` | Accept provider, delegate through it |
| MODIFY | `src/services/data/index.js` | Add new exports |
| MODIFY | `src/services/orchestration/WebSocketBridge.js` | JSON-RPC message routing + `rpcRequest()` |
| MODIFY | `src/collections/CodeGrid.js` | Add `uri`, `slotToPos`, cursor, position methods |
| MODIFY | `src/workers/builders/index.js` | Add `slotToPos` + `lineVisCharCounts` to builder |
| MODIFY | `src/workers/WorkerBridge.js` | Add `slotToPos` to transferables |
| MODIFY | `app/GitHubRepoViewer.js` | Provider switching, URI wiring, `onDidChange` |
| MODIFY | `app/components/Drawer.js` | Provider selector dropdown |
| MODIFY | `app/IDEShell.js` | Status bar provider indicator, registry bootstrap |
| MODIFY | `app/StatePersistence.js` | Persist provider type |
| MODIFY | `app/commands/handlers/highlightCommands.js` | Use CodeGrid position methods |
| MODIFY | `cli/relay.go` | JSON-RPC detection, `FSHandler` field |
| MODIFY | `cli/main.go` | `--root` and `--writable` flags |

### Implementation Order

1. `types.js` (everything depends on it)
2. `FileSystemRegistry.js` + `GitHubProvider.js` + `MemoryProvider.js` (can be built in parallel)
3. `RepositoryAdapter.js` refactor (depends on providers existing)
4. `WebSocketBridge.js` JSON-RPC additions
5. `RemoteFileSystemProvider.js` (depends on bridge)
6. `cli/fs.go` + `cli/relay.go` + `cli/main.go` (Go side, can be done in parallel with JS providers)
7. `CodeGrid.js` URI field + `GitHubRepoViewer.js` wiring
8. `Drawer.js` + `IDEShell.js` + `StatePersistence.js` UI changes
9. Builder `slotToPos` additions (Tier 2 start)
10. `CodeGrid.js` position methods + cursor
11. `EditorInputManager.js` + `EditHistory.js`
12. `highlightCommands.js` refactor

## Implementer Vote

**integration** should implement this.

Rationale: The converged plan's center of gravity is the adapter refactor, provider wiring, UI integration, and Go relay changes -- all areas where integration's Phase 0 analysis was deepest and most code-specific. Integration identified the exact line numbers in `RepositoryAdapter.js`, `GitHubRepoViewer.js`, `Drawer.js`, and `IDEShell.js` that need modification. Integration's analysis of `loadRepository()`, `switchProvider()`, the Drawer panel HTML, state persistence, and the Go relay's message routing was the most concrete of the three perspectives. The types file and registry are straightforward from the converged spec; the real implementation risk is in wiring providers through the existing adapter/viewer/shell stack, which is integration's domain. Grid-editing's `slotToPos` builder work (Tier 2) can follow once the provider layer is stable, and protocol's interface design is fully captured in the settled points above.

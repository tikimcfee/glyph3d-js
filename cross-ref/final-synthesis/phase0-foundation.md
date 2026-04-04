# Phase 0: FileSystem Provider Layer — Tier 1 Read-Only

Final implementation plan. Scope-disciplined synthesis of consolidated plan, abstraction boundaries, adversarial review, and unit-of-work protocol.

---

## Scope Decision: 10 File Touches

The adversarial review proposed 8. The original plan proposed 21. The right answer is 10: 3 new files, 7 modifications. Here is the reasoning for each contested item.

### Adversarial Challenges — Resolved

**`FileSystemRegistry`?** No. if/else for 2 providers. Registry deferred to Tier 2 when URI-per-grid dispatch matters.

**`GitHubProvider` as separate class?** No. `RepositoryAdapter` already IS the GitHub provider. `RemoteFileSystemProvider` mirrors its surface so the viewer can swap them.

**UI changes?** No. URL parameter `?source=local` suffices. No Drawer/IDEShell/ide.html changes.

**Version numbers in `FileStat`?** No. Versions exist for write conflict detection. Read-only has no conflicts. Deferred to Tier 2.

**`MemoryProvider`?** No. Demos work without it. Deferred.

**`types.js`?** Yes. Three files share these types (`RemoteFileSystemProvider.js`, `WebSocketBridge.js`, `cli/fs.go`). Without shared vocabulary, "what does `listTree` return?" gets answered three ways. Cost: ~60 lines. Value: `DirEntry`, `FileStat`, `FileContent`, `FileSystemError` agreed from day one.

---

## File Plan

### New Files (3)

#### 1. `src/services/data/types.js` — NEW

Shared type vocabulary. ~60 lines.

```js
/**
 * @typedef {Object} FileStat
 * @property {'file'|'directory'|'symlink'} type
 * @property {number} size      - bytes
 * @property {number} mtime     - ms since epoch
 * @property {boolean} [readonly]
 */

/**
 * @typedef {Object} FileContent
 * @property {string} uri       - canonical identifier (e.g. "file:///home/user/foo.js")
 * @property {string} content   - UTF-8 text
 * @property {FileStat} stat
 */

/**
 * @typedef {Object} DirEntry
 * @property {string} path      - full relative path from root (not basename)
 * @property {'file'|'directory'|'symlink'} type
 * @property {number} size
 */

/**
 * Custom error class for filesystem operations.
 * Maps to JSON-RPC error codes from the Go relay.
 */
export class FileSystemError extends Error {
    constructor(message, code, uri) { ... }
    static FileNotFound(uri) { ... }         // -32001
    static PermissionDenied(uri) { ... }     // -32002
    static IsDirectory(uri) { ... }          // -32003
}
```

**Why it can't be cut**: Without this, `RemoteFileSystemProvider` and `WebSocketBridge` will invent ad-hoc shapes. Three meanings of "entry" across two files is how bugs hide.

#### 2. `src/services/data/RemoteFileSystemProvider.js` — NEW

JSON-RPC client that speaks `fs/readFile`, `fs/listTree`, `fs/stat` over the existing WebSocket connection. ~150 lines.

```js
export class RemoteFileSystemProvider {
    /**
     * @param {WebSocketBridge} bridge - existing bridge instance
     * @param {Object} [options]
     * @param {string} [options.root] - root path on the relay (display only)
     */
    constructor(bridge, options = {})

    /** @returns {Promise<DirEntry[]>} */
    async listTree(uri, options = {})

    /** @returns {Promise<FileContent>} */
    async readFile(uri)

    /** @returns {Promise<FileStat>} */
    async stat(uri)

    /**
     * Convenience: mirrors RepositoryAdapter surface so the viewer can swap.
     * Calls listTree, then readFile for each file.
     * @returns {Promise<Object>} - { tree: DirEntry[], root }
     */
    async loadRepository(rootPath)

    /**
     * Mirrors RepositoryAdapter.streamFiles — async generator.
     * @yields {{ path: string, content: string, size: number }}
     */
    async *streamFiles(options = {})

    /**
     * Mirrors RepositoryAdapter.getFile.
     * @returns {Promise<string>}
     */
    async getFile(path)

    /**
     * Mirrors RepositoryAdapter.filterCodeFiles.
     * Reuses RepositoryAdapter's blacklist logic (import + delegate).
     */
    filterCodeFiles(tree, options = {})

    /** Clean up listeners */
    dispose()
}
```

Mirrors `RepositoryAdapter`'s public surface so the viewer swaps providers with zero pipeline changes. `filterCodeFiles` delegates to `RepositoryAdapter.prototype.filterCodeFiles` (imported, not duplicated). Uses `bridge.rpcRequest()` for JSON-RPC. Maps error codes to `FileSystemError`.

**Why it can't be cut**: Core new capability.

#### 3. `cli/fs.go` — NEW

Go-side filesystem handler. Handles `fs/readFile`, `fs/listTree`, `fs/stat`. ~200 lines.

```go
type FSHandler struct {
    root string
}

func NewFSHandler(root string) (*FSHandler, error)
    // Resolves root to absolute path. Returns error if path doesn't exist.

func (h *FSHandler) Handle(method string, id int, params json.RawMessage, ws *websocket.Conn)
    // Routes to readFile/listTree/stat based on method string.

func (h *FSHandler) readFile(ws, id, params)
    // Resolves path, rejects ".." traversal, reads file, returns FileContent JSON-RPC response.
    // File size limit: 5MB. Beyond that, returns -32001 with "file too large" message.
    // Symlinks: os.Stat (follows symlinks) + filepath.EvalSymlinks to check resolved path is under root.

func (h *FSHandler) listTree(ws, id, params)
    // filepath.WalkDir from root. Skips .git, node_modules, binary extensions.
    // Returns []DirEntry with relative paths.
    // Directory cap: 50,000 entries.

func (h *FSHandler) stat(ws, id, params)
    // os.Stat, returns FileStat.

func (h *FSHandler) resolvePath(uri string) (string, error)
    // Strips "file://" prefix, joins with root, cleans path.
    // Rejects if resolved path is not under root (after EvalSymlinks).

func sendResult(ws, id, result any)
func sendError(ws, id int, code int, message string, data any)
    // JSON-RPC 2.0 response/error helpers.
```

Security: `EvalSymlinks` + prefix check (symlink escape), 5MB file cap, 50k entry cap, goroutine dispatch with 10s timeout (no blocking the connection loop).

**Why it can't be cut**: Core new capability, Go side.

---

### Modified Files (7)

#### 4. `src/services/orchestration/WebSocketBridge.js` — MODIFY

Add JSON-RPC 2.0 request/response support. ~40 lines added.

```js
// New fields in constructor:
this._rpcId = 0;
this._rpcPending = new Map();  // id -> { resolve, reject, timer }

// New method:
/**
 * Send a JSON-RPC 2.0 request and await the response.
 * @param {string} method - e.g. "fs/readFile"
 * @param {Object} params
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<any>} - result field from JSON-RPC response
 * @throws {FileSystemError} on JSON-RPC error response
 */
async rpcRequest(method, params, timeoutMs = 10000)

// Modified: _handleMessage gains a JSON-RPC response branch:
// If message has "jsonrpc" field:
//   If message has "id" + "result" or "error": resolve/reject pending promise
//   If message has "method" (notification): emit to registered listeners
// Else: existing command handling (unchanged)
```

The `"jsonrpc"` field discriminates FS traffic from command traffic on the same WebSocket. No second connection needed.

**Why it can't be cut**: `RemoteFileSystemProvider` needs a transport. This is the transport.

#### 5. `cli/relay.go` — MODIFY

Route JSON-RPC messages to `FSHandler`. ~25 lines changed.

```go
// Relay gains a field:
type Relay struct {
    ...
    fs *FSHandler  // nil if --root not provided
}
```

Routing logic: the display (browser) sends JSON-RPC requests (`fs/readFile` etc.) to the relay. In the `role == "display"` branch of `handleConnection`, before the existing controller-response forwarding: check for `"jsonrpc"` field in the parsed message. If present and `relay.fs != nil`, route to `relay.fs.Handle()` which responds directly to the display. If `relay.fs == nil`, return a JSON-RPC error. Non-JSON-RPC messages follow the existing path unchanged. Controllers never send JSON-RPC.

**Why it can't be cut**: Without routing, JSON-RPC messages from the browser go nowhere.

#### 6. `cli/main.go` — MODIFY

Add `--root` flag to `serve` subcommand. ~10 lines changed.

```go
func serveCmd() {
    fs := flag.NewFlagSet("serve", flag.ExitOnError)
    p := fs.Int("port", 8765, "Port to listen on")
    listen := fs.String("listen", "0.0.0.0", "Address to listen on")
    root := fs.String("root", "", "Root directory for filesystem access (enables fs/* methods)")
    fs.Parse(os.Args[2:])

    var fsHandler *FSHandler
    if *root != "" {
        var err error
        fsHandler, err = NewFSHandler(*root)
        if err != nil {
            log.Fatalf("[relay] --root: %v", err)
        }
        log.Printf("[relay] filesystem root: %s", *root)
    }

    if err := RunRelay(*listen, *p, fsHandler); err != nil {
        log.Fatalf("[relay] %v", err)
    }
}
```

`RunRelay` signature changes to accept `*FSHandler` (may be nil). `--writable` deferred to Tier 2 — Tier 1 is read-only.

**Why it can't be cut**: The relay needs to know the root path.

#### 7. `app/GitHubRepoViewer.js` — MODIFY

Provider switching based on URL parameter. ~30 lines changed.

```js
// In constructor or init method:
const params = new URLSearchParams(window.location.search);
const source = params.get('source'); // 'local' or null (GitHub default)

if (source === 'local') {
    // RemoteFileSystemProvider mirrors RepositoryAdapter surface
    this.repoAdapter = new RemoteFileSystemProvider(this.wsBridge, {
        root: params.get('root') || '.'
    });
} else {
    // Existing path — no changes
    this.repoAdapter = new RepositoryAdapter({ ... });
}
```

Note: the existing pipeline calls `getRepositoryTree(owner, repo, branch)` and `getMultipleFiles(owner, repo, paths, branch)` with GitHub-specific signatures. For local mode, `loadRepository()` needs a small fork: call `this.repoAdapter.listTree()` instead, and use parallel `readFile` calls instead of `getMultipleFiles`. This is ~20 lines of `if (this._sourceMode === 'local')` branching in `loadRepository()`, not a full rewrite. The grid creation and layout phases (lines 940-1010) are provider-agnostic and untouched.

**Why it can't be cut**: Something must instantiate and wire the provider.

#### 8. `src/services/data/index.js` — MODIFY (3 lines)

Add `FileSystemError` and `RemoteFileSystemProvider` exports. Barrel convention.

#### 9. `src/collections/CodeGrid.js` — MODIFY (2 lines)

Add `this.uri = null` in constructor. Set at grid creation: `github://owner/repo?ref=branch&path=file` or `file:///root/file`. No TextBuffer, no cursor, no position methods — just the identity field so Tier 2 can route edits without a breaking migration.

#### 10. `app/StatePersistence.js` — MODIFY (5 lines)

Persist `source` from URL params. On restore, skip if saved source differs from current URL param (prevents loading a local path as a GitHub URL).

---

## What Is NOT In This Plan

Everything from the consolidated plan's Tier 2 is deferred: `StringBuffer`/`TextBuffer`, `EditHistory`, `EditorInputManager`, `textEditUtils`, `slotToPos` builder changes, `fs/writeFile`, `fs/applyEdits`, `fs/didChange`, version numbers, `--writable`. Also cut: `FileSystemRegistry` (if/else suffices), `GitHubProvider` (RepositoryAdapter suffices), `MemoryProvider` (no consumer), `fs/capabilities` (browser knows its provider), all UI changes (URL param suffices), `charCodeAt` fix (real bug, separate PR).

---

## Implementation Order

Steps 1-2 can be done in parallel. Step 3 depends on 1-2. Step 4 depends on 3.

1. **types.js** + **CodeGrid.js** `uri` field (pure additions, no behavioral change)
2. **cli/fs.go** + **cli/main.go** + **cli/relay.go** (Go side, independent of JS)
3. **WebSocketBridge.js** `rpcRequest()` + **RemoteFileSystemProvider.js** (depends on types)
4. **GitHubRepoViewer.js** + **StatePersistence.js** + **index.js** (wiring, depends on provider)

## Verification

```bash
# Terminal 1: relay with FS root
go build -o cli/glyph3d-cli ./cli && cli/glyph3d-cli serve --root /home/user/dev/glyph3d-js
# Terminal 2: http://localhost:8000/app/ide.html?source=local
```

Expected: 3D viewer loads source tree from disk via relay. GitHub path (no `?source` param) unchanged.

---

## Adversarial Rebuttals

**Batch read (3.2)**: Parallel `readFile` calls over one WebSocket, same as `getMultipleFiles`. Add `fs/readFiles` only if measured slow.
**Error recovery (3.1)**: N/A for read-only.
**Goroutine blocking (5.2)**: Goroutine dispatch + 10s timeout in `FSHandler.Handle()`.
**Security (5.1)**: `EvalSymlinks` + prefix check, 5MB file cap, 50k entry cap.

# Phase 0 — Protocol: FileSystem Provider Interface & Wire Format

Agent: `protocol`

---

## 1. Provider Interface

Every provider implements this interface. Methods are async. Errors throw `FileSystemError`.

```javascript
/**
 * @typedef {Object} FileStat
 * @property {'file'|'directory'|'symlink'} type
 * @property {number} size          - bytes (0 for directories)
 * @property {number} mtime         - Unix ms timestamp
 * @property {string|null} sha      - content hash if available (GitHub provides this)
 * @property {boolean} readonly     - true for GitHub without push access
 */

/**
 * @typedef {Object} FileContent
 * @property {string} uri           - canonical URI of this file
 * @property {string} content       - UTF-8 text
 * @property {FileStat} stat        - metadata
 */

/**
 * @typedef {Object} DirEntry
 * @property {string} name          - basename (no path separators)
 * @property {'file'|'directory'|'symlink'} type
 * @property {number} size
 */

/**
 * @typedef {Object} TextEdit
 * @property {{ line: number, character: number }} start  - 0-based, LSP Position
 * @property {{ line: number, character: number }} end    - 0-based, exclusive
 * @property {string} newText
 */

class FileSystemProvider {
    /** @type {string} scheme - 'github', 'file', 'memory' */
    get scheme() {}

    /** @returns {Promise<FileContent>} */
    async readFile(uri) {}

    /** @returns {Promise<FileStat>} */
    async writeFile(uri, content) {}

    /**
     * Apply LSP-style TextEdits. Edits are applied bottom-to-top
     * so earlier ranges stay valid.
     * @returns {Promise<FileContent>} - full file after edits
     */
    async applyEdits(uri, edits) {}

    /** @returns {Promise<DirEntry[]>} */
    async listDirectory(uri) {}

    /** @returns {Promise<FileStat>} */
    async stat(uri) {}

    /** Subscribe to external changes. Returns unsubscribe fn. */
    onDidChange(callback) {}

    async dispose() {}
}
```

### Decision: `applyEdits` returns the full `FileContent`

Returning the complete file after edits lets the caller re-render the CodeGrid without a separate `readFile` round-trip. The Go relay applies edits server-side (it already has the file open) and returns the result. For in-process providers, the cost is negligible.

---

## 2. URI Scheme Design

```
github://owner/repo/branch/path/to/file.js
file:///home/user/dev/glyph3d-js/src/index.js
memory://session-id/scratch.js
```

### Parsing

```javascript
function parseProviderUri(uri) {
    const url = new URL(uri);
    return { scheme: url.protocol.replace(':', ''), path: url.pathname, host: url.host };
}

// github://anthropics/claude-code/main/src/index.ts
//   scheme: 'github', host: 'anthropics', path: '/claude-code/main/src/index.ts'
//   → owner='anthropics', repo='claude-code', branch='main', filePath='src/index.ts'

// file:///home/user/dev/foo.js
//   scheme: 'file', host: '', path: '/home/user/dev/foo.js'

// memory://demo/example.js
//   scheme: 'memory', host: 'demo', path: '/example.js'
```

### Why branch is in the URI

GitHub URIs need branch identity because `main/src/index.js` and `feat/src/index.js` are different files. Embedding branch in the URI avoids ambient state and makes every reference self-contained. This also aligns with how `RepositoryAdapter` already threads `branch` through every call (`getFileContent(owner, repo, path, branch)`).

---

## 3. JSON-RPC 2.0 Wire Format

Used when a provider is remote (LocalFS via Go relay). In-process providers (GitHub, Memory) call methods directly — no serialization.

### Requests

```json
{ "jsonrpc": "2.0", "id": 1, "method": "fs/readFile",      "params": { "uri": "file:///home/user/foo.js" } }
{ "jsonrpc": "2.0", "id": 2, "method": "fs/writeFile",     "params": { "uri": "file:///home/user/foo.js", "content": "..." } }
{ "jsonrpc": "2.0", "id": 3, "method": "fs/applyEdits",    "params": { "uri": "file:///home/user/foo.js", "edits": [...] } }
{ "jsonrpc": "2.0", "id": 4, "method": "fs/listDirectory", "params": { "uri": "file:///home/user/dev" } }
{ "jsonrpc": "2.0", "id": 5, "method": "fs/stat",          "params": { "uri": "file:///home/user/foo.js" } }
```

### Responses

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "uri": "file:///home/user/foo.js", "content": "...", "stat": { "type": "file", "size": 1234, "mtime": 1711843200000, "sha": null, "readonly": false } } }
{ "jsonrpc": "2.0", "id": 5, "result": { "type": "file", "size": 1234, "mtime": 1711843200000, "sha": null, "readonly": false } }
```

### Errors

```json
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32001, "message": "File not found", "data": { "uri": "file:///missing.js" } } }
```

Error codes:
| Code | Meaning |
|------|---------|
| -32001 | FileNotFound |
| -32002 | PermissionDenied |
| -32003 | FileIsDirectory |
| -32004 | DirectoryNotEmpty |
| -32005 | RateLimitExceeded (GitHub) |
| -32006 | NetworkError |
| -32600 | InvalidRequest (JSON-RPC standard) |
| -32601 | MethodNotFound (JSON-RPC standard) |
| -32602 | InvalidParams (JSON-RPC standard) |

### Notifications (server → client, no `id`)

```json
{ "jsonrpc": "2.0", "method": "fs/didChange", "params": { "uri": "file:///home/user/foo.js", "type": "changed" } }
{ "jsonrpc": "2.0", "method": "fs/didChange", "params": { "uri": "file:///home/user/new.js", "type": "created" } }
{ "jsonrpc": "2.0", "method": "fs/didChange", "params": { "uri": "file:///home/user/old.js", "type": "deleted" } }
```

The Go relay uses `fsnotify` (or `inotify` directly) to watch the workspace root and pushes these notifications over the existing WebSocket.

---

## 4. Mapping Current GitHub Logic to the Interface

### Current flow (GitHubRepoViewer.js line 900+):

```
repoAdapter.getRepositoryTree(owner, repo, branch) → tree
repoAdapter.filterCodeFiles(tree)                  → sourceFiles[]
repoAdapter.getMultipleFiles(owner, repo, paths, branch) → Map<path, {content, ...}>
grid.loadFileAsync(filename, content)
```

### New flow through provider:

```javascript
const provider = registry.get('github');  // GitHubProvider

// listDirectory replaces getRepositoryTree + filterCodeFiles
const tree = await provider.listDirectory('github://owner/repo/branch/');
// returns flat DirEntry[] — recursive listing done by provider internally

// readFile replaces getFileContent / getMultipleFiles
const file = await provider.readFile('github://owner/repo/branch/src/index.js');
// returns { uri, content, stat: { type, size, mtime, sha, readonly } }

// Batch: parallel readFile calls replace getMultipleFiles
const files = await Promise.all(paths.map(p =>
    provider.readFile(`github://owner/repo/branch/${p}`)
));
```

### Mapping `GitHubRepositorySource` methods to provider methods

| GitHubRepositorySource | Provider method | Notes |
|---|---|---|
| `fetchTree(owner, repo, branch)` | `listDirectory(uri)` | Provider parses owner/repo/branch from URI |
| `fetchFile(owner, repo, path, branch)` | `readFile(uri)` | Returns `FileContent` instead of raw API shape |
| `fetchRawFile(owner, repo, path, branch)` | `readFile(uri)` | Provider internally chooses raw vs API |
| `fetchBranches(owner, repo)` | Out of scope | Stays on `GitHubRepositorySource` directly |
| `fetchPullRequest(...)` | Out of scope | PR metadata is not a filesystem operation |
| `getRepositoryInfo(...)` | Out of scope | Repo metadata is not a filesystem operation |

The GitHub provider wraps `GitHubRepositorySource` + `RepositoryContentCache` (the existing `RepositoryAdapter` pattern). Non-filesystem operations like branch listing and PR fetching remain on the source directly.

### `filterCodeFiles` stays on the consumer side

The provider returns all entries. Filtering by extension/size/pattern is a view concern — `RepositoryAdapter.filterCodeFiles()` logic stays in the viewer, applied after `listDirectory`.

---

## 5. TextEdit Format and applyEdits

```javascript
// LSP TextEdit: { range: { start: Position, end: Position }, newText: string }
// Our version uses flat start/end for simplicity:
const edits = [
    { start: { line: 5, character: 0 }, end: { line: 5, character: 12 }, newText: 'newFnName' },
    { start: { line: 10, character: 4 }, end: { line: 10, character: 4 }, newText: '// inserted\n' },
];

const result = await provider.applyEdits('file:///home/user/foo.js', edits);
// result: FileContent with updated content
```

### Application order

Edits are sorted by position descending (end-of-file first) before applying, so earlier ranges remain valid. This matches LSP `TextEdit` semantics.

### On the Go relay side

```go
// fs/applyEdits handler pseudocode:
func (h *FSHandler) ApplyEdits(uri string, edits []TextEdit) (*FileContent, error) {
    content, err := os.ReadFile(uriToPath(uri))
    if err != nil { return nil, err }

    lines := strings.Split(string(content), "\n")

    // Sort edits bottom-to-top
    sort.Slice(edits, func(i, j int) bool {
        if edits[i].End.Line != edits[j].End.Line {
            return edits[i].End.Line > edits[j].End.Line
        }
        return edits[i].End.Character > edits[j].End.Character
    })

    for _, edit := range edits {
        lines = applyEdit(lines, edit)
    }

    result := strings.Join(lines, "\n")
    os.WriteFile(uriToPath(uri), []byte(result), 0644)
    return &FileContent{ URI: uri, Content: result, ... }, nil
}
```

### Why `applyEdits` instead of just `writeFile`

`writeFile` replaces the entire file. `applyEdits` allows surgical changes — the caller specifies ranges. This matters for the Go relay: `fsnotify` will fire for any write, but with `applyEdits` the relay knows exactly which ranges changed and can send a richer `fs/didChange` notification (with changed ranges) so the browser can re-render only the affected CodeGrid lines instead of re-flushing the entire grid.

---

## 6. Error Handling

```javascript
class FileSystemError extends Error {
    constructor(message, code, uri) {
        super(message);
        this.name = 'FileSystemError';
        this.code = code;   // matches JSON-RPC error codes above
        this.uri = uri;
    }

    static FileNotFound(uri) { return new FileSystemError('File not found', -32001, uri); }
    static PermissionDenied(uri) { return new FileSystemError('Permission denied', -32002, uri); }
    static IsDirectory(uri) { return new FileSystemError('Is a directory', -32003, uri); }
    static RateLimited(uri) { return new FileSystemError('Rate limit exceeded', -32005, uri); }
}
```

### Wire transport errors

`RemoteFileSystemProvider` (the browser-side JSON-RPC client) converts JSON-RPC error responses into `FileSystemError`:

```javascript
class RemoteFileSystemProvider extends FileSystemProvider {
    async readFile(uri) {
        const result = await this._rpc('fs/readFile', { uri });
        return result;
    }

    async _rpc(method, params) {
        const id = ++this._nextId;
        this._ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));

        const response = await this._waitForResponse(id);
        if (response.error) {
            throw new FileSystemError(response.error.message, response.error.code, params.uri);
        }
        return response.result;
    }
}
```

### Mapping existing GitHub errors

`GitHubError` (404) → `FileSystemError.FileNotFound(uri)`
`RateLimitError` → `FileSystemError.RateLimited(uri)`
`GitHubError` (403) → `FileSystemError.PermissionDenied(uri)`

---

## 7. Provider Registry

```javascript
class FileSystemRegistry {
    constructor() {
        this._providers = new Map();  // scheme → provider
    }

    register(provider) {
        this._providers.set(provider.scheme, provider);
    }

    /** Resolve URI to provider. Throws if scheme unknown. */
    resolve(uri) {
        const scheme = uri.split('://')[0];
        const provider = this._providers.get(scheme);
        if (!provider) throw new Error(`No provider for scheme: ${scheme}`);
        return provider;
    }

    /** Convenience: readFile through the right provider. */
    async readFile(uri) {
        return this.resolve(uri).readFile(uri);
    }

    /** Convenience: delegates to resolved provider. */
    async listDirectory(uri) {
        return this.resolve(uri).listDirectory(uri);
    }

    dispose() {
        for (const p of this._providers.values()) p.dispose();
        this._providers.clear();
    }
}
```

### Bootstrap (in GitHubRepoViewer or IDEShell)

```javascript
const fsRegistry = new FileSystemRegistry();

// GitHub (in-process, wraps existing RepositoryAdapter)
fsRegistry.register(new GitHubProvider({ token: savedToken }));

// Memory (in-process, for demos)
fsRegistry.register(new MemoryProvider());

// Local FS (remote, via existing WebSocket relay)
if (wsBridge.connected) {
    fsRegistry.register(new RemoteFileSystemProvider(wsBridge, 'file'));
}
```

### Selection: URI-driven, not mode-driven

There is no "active provider" toggle. The URI determines the provider. `readFile('github://...')` goes to GitHub. `readFile('file://...')` goes to the relay. A viewer can mix sources — load a GitHub repo tree but overlay local changes from `file://`.

---

## 8. Integration with Existing WebSocket Relay

The Go relay (`cli/relay.go`) currently routes string commands between display and controllers. The FS provider adds a parallel JSON-RPC channel on the same WebSocket.

### Discrimination

The relay inspects incoming messages:
- If it starts with `{` and contains `"jsonrpc"` → route to FS handler
- If first message is `"DISPLAY"` → existing display registration
- Otherwise → existing command routing

```go
func (r *Relay) handleConnection(ws *websocket.Conn) {
    // ... existing role detection ...

    for {
        _, msg, err := ws.ReadMessage()
        // ...

        // New: detect JSON-RPC
        if len(msg) > 0 && msg[0] == '{' {
            var peek struct { JSONRPC string `json:"jsonrpc"` }
            if json.Unmarshal(msg, &peek) == nil && peek.JSONRPC == "2.0" {
                r.handleFSRequest(ws, msg)
                continue
            }
        }

        // ... existing command routing ...
    }
}
```

This is backward-compatible — existing CLI commands continue to work unchanged. The FS protocol is a new layer alongside, not a replacement.

### Browser side: WebSocketBridge changes

`WebSocketBridge._handleMessage` currently expects command envelopes. It needs to also recognize JSON-RPC responses and route them to pending promise resolvers in `RemoteFileSystemProvider`:

```javascript
async _handleMessage(raw) {
    let envelope;
    try { envelope = JSON.parse(raw); } catch { return; }

    // JSON-RPC response (has 'jsonrpc' field and 'id')
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

---

## 9. Event/Notification Model

### `onDidChange(callback)`

Each provider exposes `onDidChange`. The callback receives:

```javascript
{ uri: string, type: 'changed' | 'created' | 'deleted' }
```

- **LocalFS provider**: relay pushes `fs/didChange` notifications over WebSocket. The `RemoteFileSystemProvider` invokes registered callbacks.
- **GitHub provider**: no push notifications. Polling or manual refresh.
- **Memory provider**: fires synchronously on `writeFile`/`applyEdits`.

### CodeGrid re-rendering on change

When `fs/didChange` fires for a URI that maps to a loaded CodeGrid, the consumer (GitHubRepoViewer / IDEShell) calls:

```javascript
fsRegistry.onDidChange((event) => {
    const grid = registry.findByMeta('uri', event.uri);
    if (grid && event.type === 'changed') {
        const file = await fsRegistry.readFile(event.uri);
        await grid.loadFileAsync(grid.filename, file.content);
    }
});
```

This reuses the existing `CodeGrid.loadFileAsync` path — no new rendering machinery needed.

---

## 10. Summary of Decisions

1. **URI-driven dispatch** — no modal provider switching; the URI scheme determines routing.
2. **JSON-RPC 2.0 on existing WebSocket** — discriminated from command traffic by `"jsonrpc"` field; no second connection.
3. **`applyEdits` returns full `FileContent`** — avoids extra round-trip; relay has the file open anyway.
4. **GitHub non-FS operations stay on `GitHubRepositorySource`** — branches, PRs, repo info are not filesystem operations.
5. **`filterCodeFiles` stays on the consumer** — the provider lists everything; filtering is a view concern.
6. **Error codes aligned with JSON-RPC** — custom codes in -32001..-32099 range, standard codes for protocol errors.
7. **`fsnotify`-driven push for local FS** — relay watches workspace, pushes `fs/didChange` notifications.
8. **`FileSystemRegistry` as the routing layer** — registered at bootstrap, resolved by URI scheme.

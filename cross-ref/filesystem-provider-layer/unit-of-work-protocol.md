# Unit of Work: Protocol-Level Undo/Redo Design

Agent: `protocol`

This document specifies how version numbering, inverse computation, and edit labels change the converged protocol from Round 3. Concrete type/signature changes first.

---

## 1. Changes to `types.js`

### FileContent gains `version`

```js
/**
 * @typedef {Object} FileContent
 * @property {string} uri
 * @property {string} content       - UTF-8 text
 * @property {FileStat} stat
 * @property {number} version       - monotonic sequence, incremented on every write
 */
```

`version` is an integer starting at 1 on first read, incremented by the provider on every successful `writeFile` or `applyEdits`. The provider is the authority -- not the client. Memory provider increments a counter; Go relay increments per-file; GitHub provider uses commit SHA hash (or 0 if immutable/readonly).

### New: `VersionedTextEdit`

```js
/**
 * @typedef {Object} VersionedTextEdit
 * @property {{ start: Position, end: Position }} range
 * @property {string} newText
 * @property {string} [label]       - "typing" | "paste" | "delete" | "refactor" | custom
 */
```

`label` is optional. It travels with the edit for coalescing decisions but has no semantic effect on the provider. The provider ignores it; the client-side `EditHistory` uses it to decide whether consecutive edits merge into one undo step.

### New: `EditResult`

```js
/**
 * @typedef {Object} EditResult
 * @property {string} uri
 * @property {string} content           - full file after edits
 * @property {FileStat} stat
 * @property {number} version           - new version after this edit
 * @property {number} baseVersion       - version the edit was applied against
 * @property {VersionedTextEdit[]} applied  - edits as applied (may be normalized)
 * @property {VersionedTextEdit[]} inverse  - edits that would undo this batch
 */
```

The provider computes and returns `inverse` because it has access to the "before" content at apply time. The client does not need to snapshot content before sending edits.

### New: `EditBatch`

```js
/**
 * @typedef {Object} EditBatch
 * @property {VersionedTextEdit[]} edits
 * @property {number} baseVersion   - version the client believes is current
 * @property {string} [label]       - batch-level label (overrides per-edit labels)
 */
```

`baseVersion` is required. The provider compares it against its current version to detect conflicts.

### Modified: `FileSystemProvider`

```js
/**
 * @typedef {Object} FileSystemProvider
 * @property {string} scheme
 * @property {(uri: string) => Promise<FileContent>} readFile
 * @property {(uri: string, content: string) => Promise<FileContent>} writeFile
 * @property {(uri: string, batch: EditBatch) => Promise<EditResult>} applyEdits
 * @property {(uri: string) => Promise<DirEntry[]>} listTree
 * @property {(uri: string) => Promise<FileStat>} stat
 * @property {(callback: function) => function} onDidChange
 * @property {() => Promise<void>} dispose
 */
```

Changes from Round 3:
- `writeFile` returns `FileContent` (was `FileStat`). Needed so the caller gets the new `version`.
- `applyEdits` takes `EditBatch` (was `TextEdit[]`), returns `EditResult` (was `FileContent`).

---

## 2. JSON-RPC Wire Format Changes

### `fs/applyEdits` request

```json
{
  "jsonrpc": "2.0", "id": 7,
  "method": "fs/applyEdits",
  "params": {
    "uri": "file:///home/user/foo.js",
    "baseVersion": 3,
    "label": "typing",
    "edits": [
      { "range": { "start": { "line": 5, "character": 10 }, "end": { "line": 5, "character": 10 } }, "newText": "x" }
    ]
  }
}
```

New fields in `params`: `baseVersion` (required integer), `label` (optional string).

### `fs/applyEdits` response

```json
{
  "jsonrpc": "2.0", "id": 7,
  "result": {
    "uri": "file:///home/user/foo.js",
    "content": "...",
    "stat": { "type": "file", "size": 1290, "mtime": 1711843200500, "sha": null, "readonly": false },
    "version": 4,
    "baseVersion": 3,
    "applied": [
      { "range": { "start": { "line": 5, "character": 10 }, "end": { "line": 5, "character": 10 } }, "newText": "x" }
    ],
    "inverse": [
      { "range": { "start": { "line": 5, "character": 10 }, "end": { "line": 5, "character": 11 } }, "newText": "" }
    ]
  }
}
```

New fields in `result`: `version`, `baseVersion`, `applied`, `inverse`.

### `fs/writeFile` response

```json
{
  "jsonrpc": "2.0", "id": 8,
  "result": {
    "uri": "file:///home/user/foo.js",
    "content": "...",
    "stat": { ... },
    "version": 5
  }
}
```

Changed from Round 3: response is now `FileContent` (with `version`), not bare `FileStat`.

### `fs/readFile` response -- unchanged structure, gains `version`

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "uri": "file:///home/user/foo.js",
    "content": "...",
    "stat": { ... },
    "version": 5
  }
}
```

### New error code: version conflict

```json
{
  "jsonrpc": "2.0", "id": 7,
  "error": {
    "code": -32007,
    "message": "Version conflict",
    "data": { "uri": "file:///foo.js", "expectedVersion": 3, "currentVersion": 5 }
  }
}
```

Code `-32007` is `VersionConflict`. The client sent `baseVersion: 3` but the file is at version 5 (external edit occurred). The client must re-read, rebase, and retry.

---

## 3. Go Relay Changes (`cli/fs.go`)

### Per-file version tracking

```go
type fileState struct {
    version int64  // monotonic, starts at 1
    mu      sync.Mutex
}

type FSHandler struct {
    root     string
    writable bool
    watcher  *fsnotify.Watcher
    versions map[string]*fileState  // path -> state
    vmu      sync.RWMutex
}
```

`versions` is lazily populated. First `readFile` or `applyEdits` for a path initializes version to 1. External filesystem changes (detected by `fsnotify`) increment the version and push `fs/didChange` with the new version.

### `readFile` returns version

```go
func (h *FSHandler) readFile(ws *websocket.Conn, id int, params json.RawMessage) {
    // ... read file ...
    fs := h.getOrCreateState(path)
    fs.mu.Lock()
    v := fs.version
    fs.mu.Unlock()
    // return FileContent with version: v
}
```

### `applyEdits` with version check

```go
func (h *FSHandler) applyEdits(ws *websocket.Conn, id int, params json.RawMessage) {
    var p struct {
        URI         string     `json:"uri"`
        BaseVersion int64      `json:"baseVersion"`
        Label       string     `json:"label,omitempty"`
        Edits       []TextEdit `json:"edits"`
    }
    json.Unmarshal(params, &p)

    path := h.resolvePath(p.URI)
    fs := h.getOrCreateState(path)
    fs.mu.Lock()
    defer fs.mu.Unlock()

    if p.BaseVersion != fs.version {
        h.sendError(ws, id, -32007, "Version conflict", map[string]any{
            "uri": p.URI, "expectedVersion": p.BaseVersion, "currentVersion": fs.version,
        })
        return
    }

    beforeContent, _ := os.ReadFile(path)
    // ... apply edits to get afterContent ...
    // ... compute inverse edits from beforeContent + applied edits ...

    os.WriteFile(path, []byte(afterContent), 0644)
    fs.version++

    // Return EditResult with version, baseVersion, applied, inverse
}
```

### Inverse computation in Go

The relay computes inverses at apply time because it holds `beforeContent`. For each edit `{ range, newText }`:

```go
func computeInverse(beforeLines []string, edit TextEdit) TextEdit {
    // Extract the text that will be replaced
    replaced := extractRange(beforeLines, edit.Range.Start, edit.Range.End)
    // The inverse replaces newText back with the original
    newEnd := advancePosition(edit.Range.Start, edit.NewText)
    return TextEdit{
        Range:   Range{Start: edit.Range.Start, End: newEnd},
        NewText: replaced,
    }
}
```

`advancePosition` walks the `newText` string counting lines and characters to compute where the insertion ends. The inverse's range spans from the original start to that computed end.

### fsnotify bumps version

```go
// In the watcher goroutine:
case event := <-h.watcher.Events:
    if event.Op&(fsnotify.Write|fsnotify.Create) != 0 {
        path := event.Name
        fs := h.getOrCreateState(path)
        fs.mu.Lock()
        fs.version++
        v := fs.version
        fs.mu.Unlock()
        h.pushDidChange(path, "changed", v)
    }
```

---

## 4. `onDidChange` Notification Gains Version

```json
{
  "jsonrpc": "2.0",
  "method": "fs/didChange",
  "params": { "uri": "file:///home/user/foo.js", "type": "changed", "version": 6 }
}
```

New field: `version`. The client compares this against its local version. If `notification.version > localVersion`, the local content is stale. For `type: "created"`, version is 1. For `type: "deleted"`, version is omitted.

This is the mechanism that makes dual-write reconciliation concrete. Round 3 said "always trust the relay response (last write wins)." With versions: the client applies the edit optimistically at local version N, sends `applyEdits` with `baseVersion: N`, and expects the response at version N+1. If it receives a `fs/didChange` with version N+1 that it did not originate, it knows an external edit landed and must re-read.

---

## 5. Edit Labels: Protocol vs Client-Side

Labels travel on the wire (`label` field in `EditBatch`) but are **semantically inert** at the provider. The Go relay stores the label in the `EditResult` response and that's it. All coalescing logic lives in `EditHistory` on the client:

- Same label within 500ms -> merge into one undo step
- Label change -> new undo step
- "paste" -> always a new step regardless of timing
- No label -> each edit is its own step

The label is on `EditBatch`, not on individual `VersionedTextEdit` entries within the batch. A single `applyEdits` call is always one atomic unit of work. The label describes the user intent that produced that unit.

---

## 6. Ripple Effects on Providers

### `MemoryProvider`

Gains an internal `Map<string, number>` for per-file versions. `writeFile` and `applyEdits` increment and return it. `applyEdits` computes inverse edits from its in-memory content before overwriting. Fires `onDidChange` with the new version.

### `RemoteFileSystemProvider`

No version tracking of its own -- the Go relay is authoritative. Passes `baseVersion` through to the relay, returns `EditResult` as-is. Converts `-32007` error responses into a new `FileSystemError.VersionConflict(uri, expected, current)`.

### `GitHubProvider`

`version` is always 0. `applyEdits` still throws `PermissionDenied`. `readFile` returns `version: 0` (immutable content, commit-pinned). No conflict is possible since writes are rejected.

### `FileSystemRegistry`

Signature changes propagate: `applyEdits(uri, batch)` passes `EditBatch`, returns `Promise<EditResult>`. `writeFile(uri, content)` returns `Promise<FileContent>`.

### `EditHistory`

Round 3 defined `{ forward: TextEdit[], inverse: TextEdit[] }`. This changes to:

```js
/**
 * @typedef {Object} EditHistoryEntry
 * @property {VersionedTextEdit[]} forward
 * @property {VersionedTextEdit[]} inverse   - from EditResult.inverse
 * @property {number} baseVersion            - version before this edit
 * @property {number} version                - version after this edit
 * @property {string} [label]
 * @property {number} timestamp              - Date.now() for coalescing window
 */
```

`push()` checks if the previous entry has the same `label` and `timestamp` is within 500ms. If so, it appends to the existing entry's `forward` and prepends to `inverse` (inverse edits apply in reverse order). Otherwise, it creates a new entry.

Undo sends the `inverse` edits as a new `applyEdits` call with `baseVersion` set to the current version. The undo itself produces a new version. Redo sends the `forward` edits. Both are normal edits from the provider's perspective -- the version sequence is unbroken.

### `EditorInputManager`

Must track `localVersion` per grid (received from the last `readFile` or `applyEdits` response). Passes it as `baseVersion` in every `EditBatch`. On receiving `EditResult`, updates `localVersion = result.version`. On receiving `fs/didChange` with a higher version than expected, triggers a re-read and discards pending optimistic state.

---

## 7. FileSystemError Addition

```js
static VersionConflict(uri, expected, current) {
    const err = new FileSystemError(
        `Version conflict: expected ${expected}, file is at ${current}`,
        -32007, uri
    );
    err.expectedVersion = expected;
    err.currentVersion = current;
    return err;
}
```

---

## 8. Summary of Changes from Round 3

| Round 3 Decision | Change |
|---|---|
| `FileContent` has `uri, content, stat` | Add `version: number` |
| `applyEdits(uri, edits: TextEdit[])` | `applyEdits(uri, batch: EditBatch)` |
| `applyEdits` returns `FileContent` | Returns `EditResult` (superset: adds `version`, `baseVersion`, `applied`, `inverse`) |
| `writeFile` returns `FileStat` | Returns `FileContent` (with `version`) |
| `EditHistory` stores `{ forward, inverse }` | Stores `EditHistoryEntry` with version, label, timestamp |
| `fs/didChange` has `{ uri, type }` | Add `version: number` |
| Error codes -32001..-32006 | Add `-32007 VersionConflict` |
| Dual-write: "last write wins" | Version-checked: conflict returns `-32007`, client rebases |
| Undo deferred to Tier 2 | Undo data flows through protocol from day one |

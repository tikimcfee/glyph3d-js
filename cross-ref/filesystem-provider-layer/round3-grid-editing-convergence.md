# Round 3: grid-editing convergence

## Settled

All points now fully resolved. Numbered list with brief rationale.

1. **JSON-RPC 2.0 is the FS wire format.** All three agents converged across Rounds 1-2. The custom `{ cmd: "fs.list" }` envelope is dead. The `"jsonrpc"` field discriminates FS traffic from existing command traffic on the same WebSocket. No dissent remains.

2. **`applyEdits` returns `FileContent` (uri, content, stat).** Unanimous. Returning the full file with metadata eliminates a separate `stat` round-trip and gives the caller everything needed for dirty-checking and cache invalidation.

3. **LSP-standard `TextEdit` shape: `{ range: { start: Position, end: Position }, newText }`.** Protocol's original flat `{ start, end, newText }` was challenged by grid-editing in Round 1 and retracted by protocol in Round 2. The `range` wrapper aligns with LSP and avoids a gratuitous translation layer for future language server integration.

4. **Tree data uses `{ path, type, size, sha? }` with full relative paths.** Protocol retracted basename-only `DirEntry.name` in Round 2. Full relative paths are required by `filterCodeFiles()` (RepositoryAdapter.js:213) and `hierarchicalManager.layoutHierarchy()`. Basenames are trivially derivable; full paths are not reconstructable without recursion context.

5. **Two-pass tree filtering: relay coarse + browser fine.** The relay applies server-side exclusions (`.git`, `node_modules`, binaries) via an `exclude` param on `fs/listTree`. Browser-side `filterCodeFiles()` applies view-level extension/size filtering. Protocol partially retracted pure consumer-side in Round 2.

6. **`onDidChange` notification model via `fsnotify` on the Go relay.** Essential for local FS editing. The relay watches the workspace root and pushes `{ jsonrpc: "2.0", method: "fs/didChange", params: { uri, type: "changed"|"created"|"deleted" } }` notifications. GitHub provider has no push (polling or manual refresh). Memory provider fires synchronously.

7. **`FileSystemError` with typed constructors and JSON-RPC error codes.** Error codes -32001 through -32006 for domain errors (FileNotFound, PermissionDenied, IsDirectory, DirectoryNotEmpty, RateLimited, NetworkError), plus standard JSON-RPC codes for protocol errors.

8. **`readonly` gating via `FileStat.readonly`.** GitHub repos without push access are readonly. The editing input system checks this before accepting keystrokes. The Go relay reports write capability via `--writable` flag and `fs/capabilities` handshake.

9. **`CodeGrid` stores a `uri` field.** This is the canonical identity for change notification matching, edit routing, and tab/breadcrumb display. Currently `grid.userData.sourcePath` is set at `GitHubRepoViewer.js:949`; this becomes a full URI (`github://owner/repo?ref=main&path=src/index.js` or `file:///root/path`).

10. **Shared types file at `src/services/data/types.js`.** JSDoc typedefs for `TextEdit`, `FileContent`, `FileStat`, `DirEntry`, `FileSystemProvider`, `FileSystemError`. All three workstreams import from it.

11. **URI-driven dispatch for per-file I/O, adapter-level primary-scheme for bulk tree loading.** `FileSystemRegistry` resolves per-file operations (`readFile`, `writeFile`, `applyEdits`, `stat`) by URI scheme. The UI's provider selector sets which scheme is used for `loadRepository()` bulk operations. These coexist: `loadRepository()` uses the adapter's primary provider, but `CodeGrid.uri` threads through to the registry for edits and change events.

12. **`getMultipleFiles` batching stays on `RepositoryAdapter`, not on the provider interface.** The adapter calls `provider.readFile` N times with its own concurrency limiter (currently at RepositoryAdapter.js:256-280). The provider interface stays minimal: `readFile`, `writeFile`, `applyEdits`, `stat`, `listTree`, `onDidChange`, `dispose`. Every provider would have to implement a batch method otherwise, and local/memory providers gain nothing from it.

13. **GitHub URI branch disambiguation uses query params.** `github://owner/repo?ref=feature/auth&path=src/index.js` eliminates the ambiguity of `github://owner/repo/feature/auth/src/index.js` where `auth` could be branch or path. URL path segments are fundamentally unsuitable for values containing `/`.

14. **`slotToPos` naming: `[line, rawCol, slotCol]` interleaved per buffer slot.** `rawCol` is the 0-based character index within the source line (LSP `Position.character` compatible -- tabs and CRs increment it even though they produce no buffer slot). `slotCol` is the 0-based index among emitted buffer slots on that line. Protocol's `slotCol` name wins over `visCol`. Integration's `charIndex` was rejected because it implies absolute file offset, not per-line column.

15. **`slotToPos` built in the same character loop as glyph buffer emission.** Zero extra passes. Three Int32 stores per visible character, negligible compared to the 10 float stores already happening. Stored in `itemMeta` alongside existing `lineSlotOffsets`.

16. **Dual-write flow for local editing.** Sequence: (a) apply edit to in-memory text immediately for zero-latency cursor feedback, (b) send edit to provider via `applyEdits(uri, edits)`, (c) if provider response content differs from local state, re-render from provider's authoritative content. `requestAnimationFrame` debouncing coalesces keystrokes into one re-render per frame from day one.

17. **Undo/redo: per-CodeGrid `EditHistory`, browser-side, recording `{ forward: TextEdit[], inverse: TextEdit[] }` pairs.** The provider does not own undo -- it is a UI concern. Snapshot-based for Phase 1 (simpler than computing inverse edits for every operation). Lost on page refresh, acceptable for Phase 1.

18. **`requestAnimationFrame` debouncing of re-render is day-one, non-optional.** Key-repeat at 30ms vs worker round-trip at 5-15ms. Relay `applyEdits` calls are also debounced per frame -- batch all keystrokes since last frame into a single JSON-RPC message. Crash safety trade-off (batched edits lost if browser crashes between frames) is acceptable because the window is <16ms.

19. **Incremental buffer updates deferred to Phase 2.** Full re-render per keystroke is acceptable at <15ms for 50k chars. The `slotToPos` Int32Array is designed to support future offset-shifting (`copyWithin` for slots after edit point). Only optimize if typing latency exceeds 16ms in practice.

20. **Go relay flags: `--root` (required for `fs/*` commands, path traversal prevention) and `--writable` (opt-in for `fs/applyEdits`, `fs/writeFile`).** `fs/capabilities` notification on display connect reports root path and write-enabled state.

## Implementation Plan

### Tier 1: Types + Registry + Read-Only Providers

#### 1. `src/services/data/types.js` (NEW)

Shared JSDoc typedefs. No runtime code -- pure documentation that enables IDE autocompletion and cross-module type consistency.

```js
/**
 * @typedef {{ line: number, character: number }} Position
 * 0-based line and character (column) within the source text.
 * `character` is the index into the raw source string for that line,
 * counting tabs/CRs/spaces (LSP Position semantics).
 */

/**
 * @typedef {Object} TextEdit
 * @property {{ start: Position, end: Position }} range
 * @property {string} newText
 */

/**
 * @typedef {Object} FileStat
 * @property {'file'|'directory'|'symlink'} type
 * @property {number} size - bytes (0 for directories)
 * @property {number} mtime - Unix ms timestamp
 * @property {string|null} sha - content hash if available
 * @property {boolean} readonly
 */

/**
 * @typedef {Object} FileContent
 * @property {string} uri
 * @property {string} content - UTF-8 text
 * @property {FileStat} stat
 */

/**
 * @typedef {Object} DirEntry
 * @property {string} path - full relative path from root
 * @property {'file'|'directory'|'symlink'} type
 * @property {number} size
 * @property {string} [sha]
 */

/**
 * @typedef {Object} FileSystemProvider
 * @property {string} scheme - 'github', 'file', 'memory'
 * @property {(uri: string) => Promise<FileContent>} readFile
 * @property {(uri: string, content: string) => Promise<FileStat>} writeFile
 * @property {(uri: string, edits: TextEdit[]) => Promise<FileContent>} applyEdits
 * @property {(uri: string) => Promise<DirEntry[]>} listTree
 * @property {(uri: string) => Promise<FileStat>} stat
 * @property {(callback: function) => function} onDidChange - returns unsubscribe fn
 * @property {() => Promise<void>} dispose
 */
```

#### 2. `src/services/data/FileSystemError.js` (NEW)

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
    static NetworkError(uri, msg) { return new FileSystemError(msg || 'Network error', -32006, uri); }
}
```

#### 3. `src/services/data/FileSystemRegistry.js` (NEW)

URI-scheme dispatch for per-file operations.

```js
export class FileSystemRegistry {
    constructor() {
        this._providers = new Map();  // scheme -> FileSystemProvider
        this._changeListeners = [];
    }

    register(provider) {
        this._providers.set(provider.scheme, provider);
        // Wire onDidChange through to global listeners
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

    async readFile(uri)           { return this.resolve(uri).readFile(uri); }
    async writeFile(uri, content) { return this.resolve(uri).writeFile(uri, content); }
    async applyEdits(uri, edits)  { return this.resolve(uri).applyEdits(uri, edits); }
    async stat(uri)               { return this.resolve(uri).stat(uri); }
    async listTree(uri)           { return this.resolve(uri).listTree(uri); }

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

#### 4. `src/services/data/GitHubProvider.js` (NEW)

Wraps `GitHubRepositorySource` + `RepositoryContentCache`, implements `FileSystemProvider`.

- `scheme`: `'github'`
- URI format: `github://owner/repo?ref=branch&path=relative/path`
- `readFile(uri)`: parses owner/repo/ref/path from URI, delegates to `source.fetchRawFile()` or `source.fetchFile()`, wraps result in `FileContent` shape
- `writeFile(uri)`: throws `FileSystemError.PermissionDenied(uri)` (readonly for now)
- `applyEdits(uri)`: throws `FileSystemError.PermissionDenied(uri)`
- `listTree(uri)`: delegates to `source.fetchTree()`, returns `DirEntry[]` with full relative paths
- `stat(uri)`: derives from cached tree entry or fetches individually
- `onDidChange()`: no-op (returns no-op unsubscribe), no push for GitHub
- Constructor takes `{ token?, timeout?, useRawUrls? }`
- Internal helper: `_parseUri(uri)` returning `{ owner, repo, ref, path }`

#### 5. `src/services/data/MemoryProvider.js` (NEW)

In-process provider for demos and tests.

- `scheme`: `'memory'`
- Stores files in a `Map<string, { content, stat }>`
- `readFile`/`writeFile`/`applyEdits` operate on the Map
- `listTree` returns entries from the Map
- `onDidChange` fires synchronously on `writeFile`/`applyEdits`

#### 6. `src/services/data/RemoteFileSystemProvider.js` (NEW)

JSON-RPC client for local FS via the Go relay WebSocket.

- `scheme`: `'file'`
- Constructor takes `WebSocketBridge` instance
- `_rpc(method, params)`: sends `{ jsonrpc: "2.0", id: ++this._nextId, method, params }` via bridge, returns promise resolved when matching response arrives
- All methods delegate to `_rpc('fs/readFile', { uri })`, etc.
- `onDidChange`: registers for `fs/didChange` notifications routed through the bridge
- Converts JSON-RPC error responses to `FileSystemError`

#### 7. Modify `src/services/orchestration/WebSocketBridge.js`

Add JSON-RPC support:

- Add `this._rpcResolvers = new Map()` and `this._rpcNotificationHandler = null` to constructor
- In `_handleMessage(raw)`: before existing command handling, check for `envelope.jsonrpc === '2.0'`:
  - If `envelope.id !== undefined` (response): resolve from `_rpcResolvers`
  - If `envelope.method` and no `id` (notification): call `_rpcNotificationHandler`
- Add `rpcRequest(method, params)` method: assigns incremental ID, sends JSON-RPC message, returns promise with 10s timeout
- Add `setRpcNotificationHandler(handler)` method

#### 8. Modify `src/services/data/RepositoryAdapter.js`

- Add `provider` property alongside existing `source`
- Keep `getMultipleFiles` as a batch convenience calling `provider.readFile` N times with existing concurrency limiter
- Keep `getRepositoryTree` delegating to provider
- Add `clearCache()` method
- Provider-swap support: `setProvider(provider)` clears cache and updates `this.provider`
- Existing `this.source` remains for GitHub-specific non-FS operations (branches, PRs, repo info)

#### 9. Modify `src/services/data/index.js`

Add exports for new modules:

```js
export { FileSystemRegistry } from './FileSystemRegistry.js';
export { GitHubProvider } from './GitHubProvider.js';
export { MemoryProvider } from './MemoryProvider.js';
export { RemoteFileSystemProvider } from './RemoteFileSystemProvider.js';
export { FileSystemError } from './FileSystemError.js';
```

#### 10. Modify `src/collections/CodeGrid.js`

- Add `this.uri = null` property, set during `loadFileAsync()`
- When `_buildLineSlotBase` is called, also store `slotToPos` and `lineVisCharCounts` from `contentItemMeta`

#### 11. Modify `app/GitHubRepoViewer.js`

- In `createGridForFileAsync()` (line 949): set `grid.uri` to full URI based on active provider scheme
- Bootstrap `FileSystemRegistry` in `init()`, register providers
- Add `switchProvider(providerName)` method
- Gate `fetchBranches()` to GitHub providers only

#### 12. Modify `app/components/Drawer.js`

- `repoPanelHTML()` gains provider selector dropdown above existing GitHub fields
- Conditional visibility for GitHub/local/memory field groups

#### 13. Modify `app/ide.html`

- Add `#status-provider` element in status bar
- Extend URL params with `?provider=`

#### 14. Modify `app/IDEShell.js`

- Read `#status-provider`, update in `updateStatusBar()`

#### 15. Modify `app/StatePersistence.js`

- Persist and restore `provider` alongside `repoUrl` and `branch`

#### 16. Go relay: `cli/fs.go` (NEW)

JSON-RPC FS handler with these methods:
- `fs/readFile`: read file content from `--root` sandboxed path, return `FileContent`
- `fs/writeFile`: write content, gated by `--writable`, return `FileStat`
- `fs/applyEdits`: apply TextEdits to file (sort bottom-to-top, apply, write), gated by `--writable`, return `FileContent`
- `fs/listTree`: recursive directory walk with `exclude` patterns, return `DirEntry[]` with full relative paths
- `fs/stat`: return `FileStat` for a path
- `fs/capabilities`: return `{ root, writable, watching }` -- sent as notification on display connect
- Path traversal prevention: reject any resolved path outside `--root`

#### 17. Modify `cli/relay.go`

- In `handleConnection` message loop: detect JSON-RPC by checking `msg[0] == '{'` and unmarshaling for `"jsonrpc"` field
- Route JSON-RPC messages to `handleFSRequest(ws, msg)` instead of forwarding
- On display connect: send `fs/capabilities` notification

#### 18. Modify `cli/main.go`

- Add `--root` and `--writable` flags to `serve` command
- Pass to Relay constructor

#### 19. Go relay: `fsnotify` watcher in `cli/fs.go`

- Watch `--root` recursively using `github.com/fsnotify/fsnotify`
- On file change/create/delete: send `fs/didChange` notification to display WebSocket
- Debounce rapid changes (e.g., save triggers multiple events)

### Tier 2: Grid Editing

#### 20. Modify `src/workers/builders/index.js` -- `buildBatchBuffers`

In the character loop (lines 321-390), add three counters and the `slotToPos` array:

```js
// Before the character loop (alongside itemLineSlotOffsets at line 314):
const slotToPos = new Int32Array(totalItemGlyphs * 3);
let currentLine = 0;
let rawCol = 0;
let slotCol = 0;
const lineVisCharCounts = [];
let lineVisCount = 0;

// On newline (line 324-333), add:
lineVisCharCounts.push(lineVisCount);
lineVisCount = 0;
currentLine++;
rawCol = 0;
slotCol = 0;

// On space (line 350-355), add:
rawCol++;

// On CR (charCode === 13, line 356): rawCol++ (occupies source position)
// On tab (charCode === 9, line 356): rawCol++ (occupies source position)

// On visible glyph emit (line 369-389), add before bufferOffset++:
slotToPos[bufferOffset * 3]     = currentLine;
slotToPos[bufferOffset * 3 + 1] = rawCol;
slotToPos[bufferOffset * 3 + 2] = slotCol;
rawCol++;
slotCol++;
lineVisCount++;

// After character loop, push final line:
lineVisCharCounts.push(lineVisCount);
```

Also apply the same changes to `buildGlyphBuffers` (the single-text variant).

Store in `itemMeta[itemIdx]`:
```js
itemMeta[itemIdx] = {
    ...existingFields,
    slotToPos,
    lineVisCharCounts: new Int32Array(lineVisCharCounts),
};
```

Note: the existing `charCode === 13 || charCode === 9` check at line 356 is a single `continue`. This must be split to increment `rawCol` before continuing:

```js
if (charCode === 13 || charCode === 9) {
    rawCol++;
    continue;
}
```

#### 21. Modify `src/workers/WorkerBridge.js`

Add `slotToPos` to the transferable list in the worker message handler. It is an `Int32Array` backed by an `ArrayBuffer`.

#### 22. Modify `src/collections/CodeGrid.js` -- editing support

Add methods:

```js
// Store slotToPos from builder (called from _buildLineSlotBase):
this._slotToPos = contentItemMeta?.slotToPos || null;
this._lineVisCharCounts = contentItemMeta?.lineVisCharCounts || null;

/**
 * Get source text position from buffer slot index.
 * @param {number} slotIndex - absolute buffer slot index
 * @returns {{ line: number, rawCol: number, slotCol: number }|null}
 */
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

/**
 * Convert raw source column to visible (slot) column for a given line.
 */
rawColToSlotCol(line, rawCol) { /* scan line text, count non-skip chars */ }

/**
 * Convert visible (slot) column to raw source column for a given line.
 */
slotColToRawCol(line, slotCol) { /* scan line text, count non-skip chars */ }
```

Add cursor mesh:

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

Cursor blinking: toggle `this._cursor.visible` every 500ms in existing `update(deltaTime)` loop.

#### 23. `app/EditorInputManager.js` (NEW)

Keyboard capture, TextEdit generation, edit application, cursor management.

```js
export default class EditorInputManager {
    constructor(fsRegistry) {
        this._fsRegistry = fsRegistry;
        this._activeGrid = null;
        this._cursorPos = { line: 0, rawCol: 0 };
        this._editHistory = null; // EditHistory instance per grid
        this._rerenderTimer = null;
        this._pendingContent = null;
        this._pendingEdits = []; // batch for relay
    }

    setActiveGrid(grid) {
        this._activeGrid = grid;
        this._editHistory = grid?._editHistory || new EditHistory();
        if (grid) grid._editHistory = this._editHistory;
    }

    onKeyDown(event) {
        if (!this._activeGrid) return;
        // Check readonly
        if (this._activeGrid.stat?.readonly) return;

        const { line, rawCol } = this._cursorPos;
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
            // Character insertion
            this._applyEdit({
                range: { start: { line, character: rawCol }, end: { line, character: rawCol } },
                newText: event.key
            });
        } else if (event.key === 'Backspace') {
            // ... backspace logic from Phase 0
        } else if (event.key === 'Enter') {
            // ... enter logic from Phase 0
        }
        // Arrow keys: move cursor without edit
    }

    _applyEdit(edit) {
        // 1. Record in history
        this._editHistory.push(edit, this._activeGrid.content);

        // 2. Apply to in-memory text immediately
        const content = this._activeGrid.content;
        const lines = this._activeGrid.lines;
        const startOffset = this._linesToOffset(lines, edit.range.start);
        const endOffset = this._linesToOffset(lines, edit.range.end);
        this._pendingContent = content.slice(0, startOffset) + edit.newText + content.slice(endOffset);

        // 3. Update cursor position
        const newCursorOffset = startOffset + edit.newText.length;
        this._cursorPos = this._offsetToPos(this._pendingContent, newCursorOffset);

        // 4. Batch edit for relay
        this._pendingEdits.push(edit);

        // 5. Schedule debounced re-render + relay send
        this._scheduleRerender();
    }

    _scheduleRerender() {
        if (this._rerenderTimer) return;
        this._rerenderTimer = requestAnimationFrame(() => {
            this._rerenderTimer = null;
            // Re-render grid
            this._activeGrid.loadTextAsync(this._pendingContent);
            // Send batched edits to relay
            if (this._pendingEdits.length > 0 && this._activeGrid.uri) {
                this._fsRegistry.applyEdits(this._activeGrid.uri, this._pendingEdits)
                    .then(fileContent => {
                        // Reconcile: if relay content differs, re-render from authoritative
                        if (fileContent.content !== this._activeGrid.content) {
                            this._activeGrid.loadTextAsync(fileContent.content);
                        }
                    })
                    .catch(err => console.warn('Edit relay failed:', err));
                this._pendingEdits = [];
            }
        });
    }

    _linesToOffset(lines, pos) {
        let offset = 0;
        for (let i = 0; i < pos.line && i < lines.length; i++) {
            offset += lines[i].length + 1; // +1 for newline
        }
        return offset + pos.character;
    }

    _offsetToPos(content, offset) {
        let line = 0, col = 0;
        for (let i = 0; i < offset && i < content.length; i++) {
            if (content[i] === '\n') { line++; col = 0; }
            else col++;
        }
        return { line, rawCol: col };
    }
}
```

#### 24. `app/EditHistory.js` (NEW)

Per-grid undo/redo stack. Phase 1 uses content snapshots for simplicity.

```js
export class EditHistory {
    constructor(maxSize = 100) {
        this._undoStack = []; // { content: string, cursorPos: Position }
        this._redoStack = [];
        this._maxSize = maxSize;
    }

    push(edit, contentBefore) {
        this._undoStack.push({ content: contentBefore });
        if (this._undoStack.length > this._maxSize) this._undoStack.shift();
        this._redoStack.length = 0; // clear redo on new edit
    }

    undo(currentContent) {
        if (this._undoStack.length === 0) return null;
        this._redoStack.push({ content: currentContent });
        return this._undoStack.pop(); // { content } to restore
    }

    redo(currentContent) {
        if (this._redoStack.length === 0) return null;
        this._undoStack.push({ content: currentContent });
        return this._redoStack.pop();
    }

    get canUndo() { return this._undoStack.length > 0; }
    get canRedo() { return this._redoStack.length > 0; }
}
```

#### 25. Modify `app/commands/handlers/highlightCommands.js`

Refactor inline vis/raw column conversion to use `CodeGrid.rawColToSlotCol()` and `CodeGrid.slotColToRawCol()` instead of the ad-hoc scanning loop currently at lines 226-235.

#### 26. Modify `app/IDEShell.js`

- Import and instantiate `EditorInputManager`
- Wire keyboard events to it when a grid has focus (via picking click)
- Wire Ctrl+Z / Ctrl+Shift+Z to `EditHistory.undo()` / `redo()`

### File Summary

| File | Action | Tier |
|------|--------|------|
| `src/services/data/types.js` | CREATE | 1 |
| `src/services/data/FileSystemError.js` | CREATE | 1 |
| `src/services/data/FileSystemRegistry.js` | CREATE | 1 |
| `src/services/data/GitHubProvider.js` | CREATE | 1 |
| `src/services/data/MemoryProvider.js` | CREATE | 1 |
| `src/services/data/RemoteFileSystemProvider.js` | CREATE | 1 |
| `src/services/data/index.js` | MODIFY | 1 |
| `src/services/data/RepositoryAdapter.js` | MODIFY | 1 |
| `src/services/orchestration/WebSocketBridge.js` | MODIFY | 1 |
| `src/collections/CodeGrid.js` | MODIFY | 1+2 |
| `app/GitHubRepoViewer.js` | MODIFY | 1 |
| `app/components/Drawer.js` | MODIFY | 1 |
| `app/ide.html` | MODIFY | 1 |
| `app/IDEShell.js` | MODIFY | 1+2 |
| `app/StatePersistence.js` | MODIFY | 1 |
| `cli/fs.go` | CREATE | 1 |
| `cli/relay.go` | MODIFY | 1 |
| `cli/main.go` | MODIFY | 1 |
| `src/workers/builders/index.js` | MODIFY | 2 |
| `src/workers/WorkerBridge.js` | MODIFY | 2 |
| `app/EditorInputManager.js` | CREATE | 2 |
| `app/EditHistory.js` | CREATE | 2 |
| `app/commands/handlers/highlightCommands.js` | MODIFY | 2 |

### What NOT to do

- Do NOT add `getMultipleFiles` / `readFiles` to the `FileSystemProvider` interface.
- Do NOT delete `RepositoryAdapter` -- it survives as the batch/cache layer above providers.
- Do NOT delete `GitHubRepositorySource` -- it remains for non-FS operations (branches, PRs, repo info).
- Do NOT build incremental buffer updates in Phase 1.
- Do NOT persist undo/redo to the relay in Phase 1.

## Implementer Vote

**integration** should implement this.

Rationale: The converged plan's Tier 1 (types, registry, providers, adapter refactor, relay changes, UI wiring) is the bulk of the work, and it maps directly to integration's Phase 0 analysis. Integration has the deepest understanding of the existing `RepositoryAdapter` / `GitHubRepositorySource` / `WebSocketBridge` / `Drawer` / `StatePersistence` wiring. Integration correctly identified every file that needs modification in the app layer and traced every call chain through `loadRepository()`. Integration also has the Go relay context (existing `cli/relay.go` structure, `--root`/`--writable` flags). The grid-editing Tier 2 work (slotToPos, cursor, EditorInputManager) builds on top of Tier 1 and can be done after the provider layer is stable -- but the provider layer is the critical path, and integration is best positioned to build it.

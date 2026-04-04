# Phase 0: Integration Analysis -- Filesystem Provider Layer

## Decisions

1. **GitHubRepoViewer keeps its orchestration role** but delegates all I/O through a `FileSystemProvider` interface instead of `RepositoryAdapter` + `GitHubRepositorySource` directly.
2. **RepositoryAdapter becomes provider-aware** -- it wraps whatever provider is active and exposes the same `getRepositoryTree()` / `getMultipleFiles()` / `getFileContent()` API the viewer already calls.
3. **Provider selection lives in the repo sidebar panel** (`#sp-repo`) -- a dropdown above the existing URL input, replacing/augmenting the current GitHub-only flow.
4. **The Go relay server gains a `fs.*` command namespace** for LocalFSProvider traffic, routed through the existing WebSocket relay.
5. **No new HTML pages or CSS files** -- all changes fit inside the existing IDE shell structure.

---

## 1. Refactoring GitHubRepoViewer to use the provider interface

### Current call chain

```
loadRepository()                       (GitHubRepoViewer.js:900)
  -> this.repoAdapter.getRepositoryTree(owner, repo, branch)   (:922)
  -> this.repoAdapter.filterCodeFiles(treeResult)               (:925)
  -> this.repoAdapter.getMultipleFiles(owner, repo, paths, branch)  (:936)
  -> createGridForFileAsync(path, content) per file              (:949)
```

`RepositoryAdapter` (src/services/data/RepositoryAdapter.js) hard-wires `GitHubRepositorySource` at construction (line 23). The adapter itself is a good seam -- it already encapsulates caching, parallel fetch, and file filtering.

### Proposed changes

**A. Add a `provider` property to `RepositoryAdapter`.**

```js
// RepositoryAdapter.js -- constructor change
constructor(options = {}) {
    this.provider = options.provider || new GitHubRepositorySource(options);
    // ...existing cache, stats, etc.
}
```

Replace every `this.source.*` call with `this.provider.*`. The provider interface requires:

| Method | Signature | Notes |
|--------|-----------|-------|
| `listDirectory` | `(path) -> Promise<{tree: [{path, type, size, sha?}]}>` | Replaces `fetchTree`. For GitHub, path is ignored (recursive tree). For local FS, path is the root dir. |
| `readFile` | `(path) -> Promise<{content, encoding, size, path}>` | Replaces `fetchRawFile`/`fetchFile`. |
| `stat` | `(path) -> Promise<{type, size, mtime?}>` | New. Used for dirty checking and tree decoration. |
| `writeFile` | `(path, content) -> Promise<void>` | New. No-op for GitHub (read-only). |
| `applyEdits` | `(path, edits[]) -> Promise<string>` | New. LSP-style TextEdit. |
| `getInfo` | `() -> {name, displayName, capabilities}` | For UI display and capability gating. |

**B. `GitHubRepoViewer.loadRepository()` stays mostly unchanged.**

The critical change is that `loadRepository()` no longer assumes `owner/repo/branch` semantics. Instead:

```js
// GitHubRepoViewer.js:900 -- revised signature
async loadRepository(options = {}) {
    const provider = this.repoAdapter.provider;
    const providerName = provider.getInfo().name;

    if (providerName === 'github' || providerName === 'github-auth') {
        // Existing GitHub flow: parse URL, extract owner/repo/branch
        const url = this.repoInput.value.trim();
        // ... existing parseGitHubUrl logic ...
        const treeResult = await this.repoAdapter.getRepositoryTree(owner, repo, branch);
        // ...
    } else if (providerName === 'local') {
        // Local FS flow: root path comes from provider config, not URL input
        const rootPath = provider.rootPath;
        const treeResult = await this.repoAdapter.getRepositoryTree(rootPath);
        // ...
    } else if (providerName === 'memory') {
        const treeResult = await this.repoAdapter.getRepositoryTree('');
        // ...
    }
    // Everything from line 941 onward (grid creation, layout, virtualizer) is identical.
}
```

**C. `fetchBranches()` (line 830) becomes provider-gated.**

Only GitHub providers support branches. The "Fetch Branches" button and branch list are hidden when the active provider is not GitHub.

```js
fetchBranches() {
    if (!this.repoAdapter.provider.getInfo().capabilities?.includes('branches')) {
        return; // no-op for local/memory providers
    }
    // ...existing branch fetch logic...
}
```

---

## 2. Go relay server changes for LocalFSProvider

The relay (cli/relay.go) currently does pure message forwarding -- controllers send text commands, relay forwards to display, display responds. For LocalFSProvider, the relay itself must handle filesystem requests because the browser cannot access the local filesystem.

### New `fs.*` command namespace

Add a new handler in the relay that intercepts `fs.*` commands from the display (browser) instead of forwarding to controllers:

```go
// relay.go -- in the display message handler (line 127)
} else if role == "display" {
    // Check if this is a fs.* command (browser requesting local filesystem access)
    var cmd struct {
        Cmd  string `json:"cmd"`
        ID   string `json:"id"`   // request correlation ID
        Path string `json:"path"`
    }
    if json.Unmarshal(msg, &cmd) == nil && strings.HasPrefix(cmd.Cmd, "fs.") {
        go r.handleFSCommand(ws, cmd.Cmd, cmd.ID, msg)
        continue
    }
    // ...existing display->controller forwarding...
}
```

### FS command handlers (new file: `cli/fs.go`)

```go
func (r *Relay) handleFSCommand(ws *websocket.Conn, cmd, reqID string, raw []byte) {
    switch cmd {
    case "fs.list":
        r.handleFSList(ws, reqID, raw)
    case "fs.read":
        r.handleFSRead(ws, reqID, raw)
    case "fs.stat":
        r.handleFSStat(ws, reqID, raw)
    case "fs.write":
        r.handleFSWrite(ws, reqID, raw)
    }
}
```

**`fs.list`**: Walks directory, returns `{tree: [{path, type, size}]}` in the same shape as GitHub's tree API response. Applies the same binary-exclusion filters that `RepositoryAdapter.filterCodeFiles()` uses (or a Go equivalent). The `rootPath` is set at relay startup via `--root` flag.

**`fs.read`**: Reads file content as UTF-8 text. Returns `{content, size, path}`.

**`fs.stat`**: Returns `{type, size, mtime}`.

**`fs.write`**: Writes content to file. Requires explicit `--writable` flag at relay startup for safety.

### Relay startup flag changes

```
glyph3d-cli serve [--port 8765] [--root /path/to/project] [--writable]
```

- `--root`: Required for `fs.*` commands. All paths are resolved relative to this. Paths that escape the root via `..` are rejected.
- `--writable`: Opt-in flag to enable `fs.write` / `fs.applyEdits`.

### Browser-side LocalFSProvider

A new class `LocalFSProvider` in `src/services/data/LocalFSProvider.js`:

```js
export class LocalFSProvider {
    constructor(bridge) {
        this.bridge = bridge;  // WebSocketBridge instance
        this.name = 'local';
    }

    async listDirectory(path = '') {
        const resp = await this.bridge.request('fs.list', { path });
        return resp.data;
    }

    async readFile(path) {
        const resp = await this.bridge.request('fs.read', { path });
        return resp.data;
    }

    // ...stat, writeFile, applyEdits follow same pattern
}
```

This requires a small addition to `WebSocketBridge` -- a `request()` method that sends a JSON command and awaits a correlated response by `id`. The current bridge only forwards raw text commands; it needs request/response correlation.

```js
// WebSocketBridge.js -- new method
async request(cmd, params = {}) {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
        this._pending.set(id, { resolve, reject });
        this.send(JSON.stringify({ cmd, id, ...params }));
        setTimeout(() => {
            if (this._pending.has(id)) {
                this._pending.delete(id);
                reject(new Error(`Timeout: ${cmd}`));
            }
        }, 10000);
    });
}
```

---

## 3. UI design for provider selection in the IDE sidebar

### Repo panel (`#sp-repo`) changes

The `repoPanelHTML()` function (Drawer.js:197) currently returns a GitHub-specific form. Replace the top section with a provider selector:

```js
export function repoPanelHTML() {
    return `
        <div class="repo-section">
            <label class="repo-label">Source</label>
            <select id="provider-select" class="repo-input">
                <option value="github" selected>GitHub (public)</option>
                <option value="github-auth">GitHub (authenticated)</option>
                <option value="local">Local Filesystem</option>
                <option value="memory">Demo (in-memory)</option>
            </select>
        </div>

        <!-- GitHub-specific fields (shown when provider=github|github-auth) -->
        <div id="provider-github-fields">
            <div class="repo-section">
                <label class="repo-label" for="repo-input">Repository URL</label>
                <input type="text" id="repo-input" class="repo-input" ...>
            </div>
            <div class="repo-section">
                <label class="repo-label" for="branch-input">Branch</label>
                ...existing branch input + fetch button...
            </div>
        </div>

        <!-- Local FS fields (shown when provider=local) -->
        <div id="provider-local-fields" class="hidden">
            <div class="repo-section">
                <label class="repo-label">Relay Status</label>
                <span id="local-relay-status" class="branch-status">Not connected</span>
            </div>
            <div class="repo-section">
                <label class="repo-label">Root Path</label>
                <span id="local-root-path" class="branch-status">--</span>
            </div>
        </div>

        <!-- Memory fields (shown when provider=memory) -->
        <div id="provider-memory-fields" class="hidden">
            <div class="repo-section">
                <span class="branch-status">Built-in demo files</span>
            </div>
        </div>

        <div class="repo-section">
            <button id="load-btn" class="repo-btn">Load</button>
        </div>
    `;
}
```

### Provider switching logic

Wire in `setupEventListeners()` (GitHubRepoViewer.js:536):

```js
const providerSelect = document.getElementById('provider-select');
providerSelect.addEventListener('change', (e) => {
    const value = e.target.value;
    document.getElementById('provider-github-fields')?.classList.toggle('hidden', !value.startsWith('github'));
    document.getElementById('provider-local-fields')?.classList.toggle('hidden', value !== 'local');
    document.getElementById('provider-memory-fields')?.classList.toggle('hidden', value !== 'memory');

    // Swap the active provider on RepositoryAdapter
    this.switchProvider(value);
});
```

New method on `GitHubRepoViewer`:

```js
switchProvider(providerName) {
    switch (providerName) {
        case 'github':
            this.repoAdapter.provider = new GitHubRepositorySource();
            break;
        case 'github-auth':
            const token = localStorage.getItem('github_token') || prompt('GitHub token:');
            if (token) localStorage.setItem('github_token', token);
            this.repoAdapter.provider = new GitHubRepositorySource({ token });
            break;
        case 'local':
            if (!this._wsBridge?.isConnected()) {
                this.toastUI.show('Connect to relay first (Settings > WebSocket)', 'error');
                return;
            }
            this.repoAdapter.provider = new LocalFSProvider(this._wsBridge);
            break;
        case 'memory':
            this.repoAdapter.provider = new InMemoryProvider();
            break;
    }
    this.repoAdapter.clearCache();
}
```

---

## 4. Status bar changes

### Active provider indicator

Add a new status bar item in `ide.html` (line 152, within `<div class="status-left">`):

```html
<span class="status-item" id="status-provider" title="File source">
    <span class="status-icon">&#9729;</span> GitHub
</span>
```

Reference it in `IDEShell.js` constructor alongside other status elements:

```js
this._statusProvider = document.getElementById('status-provider');
```

Update in `updateStatusBar()`:

```js
if (this._viewer?.repoAdapter?.provider) {
    const info = this._viewer.repoAdapter.provider.getInfo();
    this._statusProvider.innerHTML = `<span class="status-icon">&#9729;</span> ${info.displayName}`;
}
```

### WebSocket status integration

The existing `#status-ws` indicator already shows relay connection state. When `local` provider is active, this doubles as the provider health indicator. No additional UI is needed -- the WS status already communicates relay availability.

---

## 5. Provider switching at runtime

### Clearing state on switch

When the user switches providers, `switchProvider()` must:
1. Call `this.clearGrids()` -- removes all CodeGrids, picking state, overlays, etc. (GitHubRepoViewer.js:1112)
2. Clear the adapter cache -- `this.repoAdapter.clearCache()`
3. Reset `this.tree`, `this.repoPath`, `this.branches`
4. Clear file tree UI -- `this.treeContent.innerHTML = '<div class="tree-empty">Select a source and load</div>'`
5. Update status bar provider indicator
6. Hide/show branch-related UI

### No auto-load on switch

Switching providers only prepares the adapter. The user must still click "Load" to trigger `loadRepository()`. This prevents accidental large loads.

---

## 6. Initialization flow

### Startup sequence (ide.html `DOMContentLoaded`)

1. `IDEShell` created, `injectPanelContent()` called -- repo panel now includes provider selector
2. `GitHubRepoViewer` constructed -- `this.githubSource = new GitHubRepositorySource()` (line 108)
3. `viewer.init()` -- creates `this.repoAdapter = new RepositoryAdapter()` (line 250), which defaults to GitHub provider
4. URL-driven auto-load (ide.html:296-344) -- only fires for GitHub provider (checks `owner && repo`)
5. State persistence auto-load (GitHubRepoViewer.js:393-399) -- same, GitHub-only

### Provider from URL params

Extend the URL-driven auto-load block:

```js
// ide.html -- within the auto-load block
const providerParam = params.get('provider');
if (providerParam) {
    const providerSelect = document.getElementById('provider-select');
    if (providerSelect) providerSelect.value = providerParam;
    viewer.switchProvider(providerParam);
}
```

For local provider auto-load: `?provider=local` -- the relay must be running, and the root path is set server-side.

### State persistence

`StatePersistence` (app/StatePersistence.js) currently saves `{ repoUrl, branch }`. Extend to save `{ repoUrl, branch, provider }`. On restore, call `switchProvider()` before `loadRepository()`.

---

## 7. File tree population per provider

### GitHub provider (unchanged)

`loadRepository()` -> `repoAdapter.getRepositoryTree()` -> returns `{tree: [{path, type, size}]}` -> `filterCodeFiles()` -> creates grids -> `hierarchicalManager.layoutHierarchy()` -> `updateFileTree()` reads from `hierarchicalManager.root` tree.

### Local FS provider

Same flow, but `listDirectory()` returns the tree from the Go relay. The relay walks the filesystem and returns the same `{tree: [{path, type:'blob'|'tree', size}]}` shape. `filterCodeFiles()` works identically -- it only looks at `type`, `size`, `path`.

Key difference: the relay applies exclusion patterns server-side (node_modules, .git, etc.) to avoid sending thousands of irrelevant entries. The browser-side `filterCodeFiles()` still runs as a second pass.

### In-memory provider

Returns a hardcoded tree of demo files. The `InMemoryProvider.listDirectory()` returns the same shape.

### Tree node click behavior

`_buildTreeDOM()` (GitHubRepoViewer.js:1244) wires clicks to `cameraController.focusOnGrid()` and `selectionManager.select()`. This is provider-agnostic -- it operates on CodeGrid instances that are already in the scene. No changes needed.

---

## 8. Tab bar / breadcrumb / file navigation adaptation

### Tab bar (IDEShell.js:444)

Driven by `file-selected` events from `SelectionManager`. The tab displays `sourcePath` from `grid.userData.sourcePath`. This is already provider-agnostic -- the path is whatever the provider returned in the tree.

For local FS, paths look like `src/index.js` (relative to relay root). For GitHub, paths look like `src/index.js` (relative to repo root). Same format, no changes needed.

### Breadcrumb (IDEShell.js, `_onCameraFocusChanged`)

Displays the path of the currently focused grid. Same as tab bar -- uses `sourcePath`, provider-agnostic.

### Command palette (ide.html:114, CommandBar)

Uses `grid.list` command which returns all registered grids by sourcePath. Provider-agnostic.

### Search panel (IDEShell.js, `_wireSearch`)

Filters file names from `this._viewer.tree` array. This is set at loadRepository:926 from `filterCodeFiles()` output. Provider-agnostic -- `tree` is just an array of `{path, type, size}` objects.

---

## Summary of files to modify

| File | Changes |
|------|---------|
| `src/services/data/RepositoryAdapter.js` | Accept `provider` option, delegate to `this.provider` instead of `this.source` |
| `src/services/data/LocalFSProvider.js` | **New file.** WebSocket-backed local FS provider. |
| `src/services/data/InMemoryProvider.js` | **New file.** Demo/test provider with hardcoded files. |
| `src/services/orchestration/WebSocketBridge.js` | Add `request()` method for correlated request/response |
| `app/components/Drawer.js` | `repoPanelHTML()` gains provider selector dropdown |
| `app/GitHubRepoViewer.js` | Add `switchProvider()`, gate `loadRepository()` by provider type, gate `fetchBranches()` |
| `app/ide.html` | Add `#status-provider` to status bar, extend URL params with `?provider=` |
| `app/IDEShell.js` | Read `#status-provider` element, update in `updateStatusBar()` |
| `app/StatePersistence.js` | Persist and restore `provider` alongside `repoUrl` and `branch` |
| `cli/relay.go` | Intercept `fs.*` commands from display, add `--root` / `--writable` flags |
| `cli/fs.go` | **New file.** `fs.list`, `fs.read`, `fs.stat`, `fs.write` handlers |
| `cli/main.go` | Wire `--root` and `--writable` flags into `serveCmd()` |

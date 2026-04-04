# Unit of Work: Integration Layer Changes

## 1. Version Number on FileContent

Add `version` to `FileStat` and `FileContent` in `src/services/data/types.js`:

```js
/**
 * @typedef {Object} FileStat
 * @property {'file'|'directory'|'symlink'} type
 * @property {number} size
 * @property {number} mtime
 * @property {string|null} sha
 * @property {boolean} readonly
 * @property {number} version - monotonic sequence, incremented on every write
 */
```

Each provider maintains its own version counter per file:
- **MemoryProvider**: `_files.get(uri).version++` on every `writeFile`/`applyEdits`
- **RemoteFileSystemProvider**: relay returns `version` in every `FileStat`; the Go relay tracks an in-memory `map[string]uint64` bumped on each write
- **GitHubProvider**: `version` is always 0 (immutable source, no writes)

The relay's `fs/applyEdits` response already returns `FileContent` (convergence item 2). Adding `version` to its `stat` field is a one-field extension to the JSON-RPC response.

## 2. CodeGrid Versioned State

Add to `CodeGrid` constructor (alongside existing `this.sourcePath = null`):

```js
this.uri = null;              // canonical file identity (convergence item 9)
this._version = 0;            // last known provider version
this._dirty = false;          // true when local edits haven't been confirmed by provider
this._editHistory = null;     // EditHistory instance, created on first edit
```

**Version flow**: `RepositoryAdapter` -> `GitHubRepoViewer.createGridForFileAsync` -> `CodeGrid`:

```js
// GitHubRepoViewer.createGridForFileAsync
async createGridForFileAsync(path, content, stat) {
    const grid = new CodeGrid(this.scene, this.atlas);
    if (this.pickingSystem) grid.getCollection().setPickingSystem(this.pickingSystem);
    await grid.loadFileAsync(filename, content);
    grid.uri = buildUri(this._activeProvider.scheme, path);
    grid.userData.sourcePath = path;
    grid._version = stat?.version ?? 0;
    grid._dirty = false;
    grid._editHistory = new EditHistory();
    return grid;
}
```

`getMultipleFiles` in `RepositoryAdapter` already returns content per file. Extend the return shape to include `stat` (which contains `version`). For GitHub, `stat.version = 0`. For local FS, the relay supplies the real version.

## 3. Dual-Write Reconciliation with Version-Based Conflict Detection

Convergence item 17 defines the dual-write flow. Version numbers change step (d):

```
(a) apply edit to in-memory grid.content/grid.lines
(b) grid._dirty = true; schedule re-render via requestAnimationFrame
(c) send provider.applyEdits(grid.uri, edits) via JSON-RPC
(d) on response:
    if (response.stat.version === grid._version + 1) {
        // Expected: our edit was the only writer
        grid._version = response.stat.version;
        grid._dirty = false;
    } else if (response.stat.version > grid._version + 1) {
        // Conflict: another writer modified the file between our last
        // known version and now. Reload from provider's authoritative content.
        grid._version = response.stat.version;
        grid.content = response.content;
        grid.lines = response.content.split('\n');
        grid._dirty = false;
        grid._editHistory.clear();   // history is invalid after external change
        scheduleRerender(grid);
    }
    // version < grid._version + 1 should not happen with monotonic counters
```

Without versions, step (d) requires a full string comparison (`response.content !== grid.content`) to detect divergence. With versions, it is an integer comparison. More importantly, it detects conflicts caused by concurrent external editors (e.g., vim editing the same file the relay is watching) without content diffing.

## 4. EditorInputManager: Labeled Edit Batches and Inverse Computation

### Labeled batches

`EditHistory.push` gains a `label` parameter for undo coalescing:

```js
push(forward, inverse, label = null) {
    const entry = { forward, inverse, label, timestamp: Date.now() };
    // Coalesce: if top of stack has same label and was < 500ms ago, merge
    const top = this._undoStack[this._undoStack.length - 1];
    if (top && label && top.label === label
        && (entry.timestamp - top.timestamp) < 500) {
        top.forward.push(...forward);
        top.inverse.unshift(...inverse);  // inverses apply in reverse order
        top.timestamp = entry.timestamp;
    } else {
        this._undoStack.push(entry);
    }
    this._redoStack.length = 0;
}
```

`EditorInputManager` assigns labels by keystroke context:

| Input | Label |
|-------|-------|
| Printable character (no modifier) | `"typing"` |
| Backspace / Delete | `"delete"` |
| Enter | `"newline"` |
| Ctrl+V / paste event | `"paste"` |
| Command-driven edit (refactor, format) | `"refactor"` |
| External (onDidChange reload) | clears history, no label |

### Inverse computation

The inverse is computed at edit application time from the "before" state, before mutating `grid.content`:

```js
_applyEditWithInverse(grid, edit, label) {
    const lines = grid.lines;
    const startOffset = linesToOffset(lines, edit.range.start);
    const endOffset = linesToOffset(lines, edit.range.end);
    const deletedText = grid.content.slice(startOffset, endOffset);

    // Inverse: replace the newText region with the original text
    const inverseEnd = {
        line: edit.range.start.line,
        character: edit.range.start.character
    };
    // Compute end position after newText insertion
    const newLines = edit.newText.split('\n');
    if (newLines.length === 1) {
        inverseEnd.line = edit.range.start.line;
        inverseEnd.character = edit.range.start.character + edit.newText.length;
    } else {
        inverseEnd.line = edit.range.start.line + newLines.length - 1;
        inverseEnd.character = newLines[newLines.length - 1].length;
    }

    const inverse = {
        range: { start: { ...edit.range.start }, end: inverseEnd },
        newText: deletedText
    };

    // Now mutate
    const newContent = grid.content.slice(0, startOffset)
        + edit.newText + grid.content.slice(endOffset);
    grid.content = newContent;
    grid.lines = newContent.split('\n');
    grid._dirty = true;

    grid._editHistory.push([edit], [inverse], label);
}
```

Key constraint: the inverse must be computed **before** applying the forward edit, because the "before" range is only valid against the pre-edit content. This is why `_applyEditWithInverse` captures `deletedText` first.

## 5. EditHistory and Versioned Provider Response

When undo fires:

```js
// EditorInputManager
_undo(grid) {
    const inverseEdits = grid._editHistory.undo();
    if (!inverseEdits) return;
    // Apply inverse edits locally (same dual-write path)
    for (const edit of inverseEdits) {
        this._applyEditLocally(grid, edit);
    }
    grid._dirty = true;
    this._scheduleRerender(grid);
    // Send to provider -- provider sees this as a normal applyEdits
    this._registry.applyEdits(grid.uri, inverseEdits).then(response => {
        this._reconcile(grid, response);
    });
}
```

The provider does not know about undo. It receives the inverse `TextEdit[]` as a normal edit batch. Its version counter increments. The reconciliation step in section 3 handles the response identically to any other edit.

If the provider returns a version that skips (conflict), the edit history is cleared because the local undo stack no longer corresponds to the provider's file state. This is the correct behavior: you cannot undo past an external modification.

## 6. onDidChange with Versions

Convergence item 6 defines `onDidChange` notifications. Add `version` to the event:

```js
/**
 * @typedef {Object} FileChangeEvent
 * @property {string} uri
 * @property {'changed'|'created'|'deleted'} type
 * @property {number} [version] - new version if available
 */
```

Grid re-rendering logic in the `onDidChange` handler:

```js
// GitHubRepoViewer -- wired via FileSystemRegistry.onDidChange
_onFileChanged(event) {
    const grid = this.registry.findByUri(event.uri);
    if (!grid) return;

    if (event.type === 'deleted') {
        grid._dirty = false;
        grid._version = -1;  // sentinel: file no longer exists
        this._markGridDeleted(grid);
        return;
    }

    // Stale version check: if event.version <= grid._version, ignore
    // (we already have this version or newer from our own edit response)
    if (event.version != null && event.version <= grid._version) return;

    // Grid is dirty (has pending local edits) -- don't reload, wait for
    // reconciliation in the applyEdits response path
    if (grid._dirty) {
        grid._externalChangeVersion = event.version;
        return;  // reconciliation will handle it
    }

    // Grid is clean -- reload from provider
    this._registry.readFile(event.uri).then(fileContent => {
        if (fileContent.stat.version <= grid._version) return; // race
        grid._version = fileContent.stat.version;
        grid.content = fileContent.content;
        grid.lines = fileContent.content.split('\n');
        grid._editHistory?.clear();
        grid.loadTextAsync(fileContent.content);
    });
}
```

The version check prevents redundant reloads: if our own `applyEdits` response already bumped the grid to version N, and `onDidChange` fires for version N (the echo of our own write), we skip the reload.

## 7. UI Implications

### Dirty indicator

`IDEShell` tab bar entries gain a dirty dot. In `_onFileSelected` and `_onGridDirtyChanged`:

```js
_updateTabDirty(grid) {
    const tab = this._tabBar.querySelector(`[data-uri="${grid.uri}"]`);
    if (!tab) return;
    tab.classList.toggle('dirty', grid._dirty);
}
```

CSS: `.tab-item.dirty::before { content: '●'; color: #e8a838; margin-right: 4px; }`

### Undo/redo status in status bar

Add `#status-undo` span in `ide.html` status bar, updated on edit/undo/redo:

```html
<span class="status-item" id="status-undo" title="Undo/Redo">U:0 R:0</span>
```

`IDEShell.updateUndoStatus(grid)`:
```js
const history = grid?._editHistory;
const u = history?._undoStack.length ?? 0;
const r = history?._redoStack.length ?? 0;
this._statusUndo.textContent = `U:${u} R:${r}`;
```

### Version display (optional, debug)

The file version can be shown in the status bar alongside the provider indicator for debugging dual-write issues. Not user-facing in production.

## 8. StatePersistence

`StatePersistence` does **not** persist per-file versions or edit history (convergence item 18: "stack is lost on page refresh"). It persists:

```js
/**
 * @typedef {Object} ViewerState
 * @property {string} repoUrl
 * @property {string} branch
 * @property {string} provider          // NEW from convergence 1f
 * @property {boolean} wasLoaded
 * @property {string} activeLayout
 * @property {number} gridsScale
 * @property {number} layoutSpacing
 * @property {{ x: number, y: number, z: number }} cameraPosition
 * @property {Object<string, number>} fileVersions  // NEW: uri -> last known version
 */
```

`fileVersions` maps `uri -> version` for all loaded grids. On restore, if a file's current version (from `stat`) differs from the persisted version, the grid reloads its content. This detects files modified while the IDE was closed.

```js
// StatePersistence
onGridVersionChanged(uri, version) {
    if (!this.state.fileVersions) this.state.fileVersions = {};
    this.state.fileVersions[uri] = version;
    this._debouncedSave();
}
```

On restore:
```js
async checkStaleFiles(registry, grids) {
    const saved = this.state.fileVersions || {};
    for (const grid of grids) {
        const savedVersion = saved[grid.uri];
        if (savedVersion == null) continue;
        const stat = await registry.stat(grid.uri);
        if (stat.version > savedVersion) {
            // File changed while IDE was closed -- reload
            const fc = await registry.readFile(grid.uri);
            grid._version = fc.stat.version;
            await grid.loadTextAsync(fc.content);
        }
    }
}
```

## Summary of Changes vs Convergence Plan

| Convergence Item | Change |
|-----------------|--------|
| Phase 1a `types.js` | Add `version: number` to `FileStat`; add optional `version` to `FileChangeEvent` |
| Phase 1b providers | Each provider maintains per-file version counter; returned in every `FileStat` |
| Phase 1e `CodeGrid` | Add `_version`, `_dirty`, `_editHistory` fields |
| Phase 1f `GitHubRepoViewer` | Pass `stat` through `createGridForFileAsync`; wire `_onFileChanged` with version check |
| Phase 1f `StatePersistence` | Add `fileVersions` map for stale-file detection on restore |
| Phase 1f `ide.html` / `IDEShell` | Add `#status-undo` span; dirty indicator CSS on tabs |
| Phase 1g `cli/fs.go` | Relay maintains `versionMap map[string]uint64`; increments on write; returns in stat |
| Phase 2c `EditorInputManager` | `_applyEditWithInverse` captures before-state; assigns label per keystroke type |
| Phase 2d `EditHistory` | `push(forward, inverse, label)` with time-based coalescing; `clear()` method |

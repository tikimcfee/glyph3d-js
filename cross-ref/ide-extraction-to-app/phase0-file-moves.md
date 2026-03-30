# Phase 0: File Moves -- IDE Extraction from examples/ide/ to app/ide/

## Decision: `app/ide/` (not `ide/` at root)

The root directory already has: `src/`, `docs/`, `examples/`, `cross-ref/`, `index.html`, `package.json`, `relay.js`. Placing a production app directly at `ide/` would put app-specific files (ide.css, ide.html) at the same level as library infrastructure. `app/ide/` creates a clear namespace for production applications, leaves room for future apps (`app/spectrometer/`, etc.), and keeps the root clean. The extra directory level adds one `../` segment to import paths -- acceptable.

## Inventory: Files That Move

5 files total, all under `examples/ide/`:

| # | Source | Destination |
|---|--------|-------------|
| 1 | `examples/ide/IDEShell.js` | `app/ide/IDEShell.js` |
| 2 | `examples/ide/ide.html` | `app/ide/ide.html` |
| 3 | `examples/ide/ide.css` | `app/ide/ide.css` |
| 4 | `examples/ide/components/CommandBar.js` | `app/ide/components/CommandBar.js` |
| 5 | `examples/ide/index.html` | `app/ide/index.html` |

## Exact Git Commands

```bash
# 1. Create destination directories
mkdir -p app/ide/components

# 2. Move files (git mv preserves blame history)
git mv examples/ide/IDEShell.js       app/ide/IDEShell.js
git mv examples/ide/ide.html          app/ide/ide.html
git mv examples/ide/ide.css           app/ide/ide.css
git mv examples/ide/components/CommandBar.js  app/ide/components/CommandBar.js
git mv examples/ide/index.html        app/ide/index.html

# 3. Remove now-empty source directories
#    git mv leaves empty dirs behind; git doesn't track directories.
#    After the moves, examples/ide/ and examples/ide/components/ will be empty.
#    They'll vanish from the working tree on their own after git mv empties them,
#    but verify with:
rmdir examples/ide/components 2>/dev/null
rmdir examples/ide 2>/dev/null
```

## Import Paths That Change After the Move

The old location `examples/ide/` was 2 levels below root. The new location `app/ide/` is also 2 levels below root. However, the *relative path* from the IDE files to `examples/github-viewer/` and `src/` changes because the lateral relationship shifts.

### IDEShell.js (app/ide/IDEShell.js)

| Old Import | New Import |
|------------|------------|
| `'../github-viewer/components/Drawer.js'` | `'../../examples/github-viewer/components/Drawer.js'` |
| `'../github-viewer/components/LogCapturePanel.js'` | `'../../examples/github-viewer/components/LogCapturePanel.js'` |
| `'../github-viewer/components/DiffPanel.js'` | `'../../examples/github-viewer/components/DiffPanel.js'` |
| `'../../src/services/utils/platform.js'` | `'../../src/services/utils/platform.js'` |

Note: the `src/` import stays identical -- both old and new locations are depth-2 from root, and `src/` is at root. The github-viewer imports gain one `../` because we moved laterally from `examples/` to `app/`.

### components/CommandBar.js (app/ide/components/CommandBar.js)

| Old Import | New Import |
|------------|------------|
| `'../../../src/services/utils/platform.js'` | `'../../../src/services/utils/platform.js'` |
| `'../../github-viewer/websocket/commands/encoding.js'` | `'../../../examples/github-viewer/websocket/commands/encoding.js'` |

The `src/` import stays identical (depth-3 from root in both cases). The github-viewer import gains one `../`.

### ide.html inline script (app/ide/ide.html)

| Old Import | New Import |
|------------|------------|
| `'../github-viewer/GitHubRepoViewer.js'` | `'../../examples/github-viewer/GitHubRepoViewer.js'` |
| `'../github-viewer/components/Drawer.js'` | `'../../examples/github-viewer/components/Drawer.js'` |
| `'./IDEShell.js'` | `'./IDEShell.js'` (unchanged -- same-dir) |
| `'./components/CommandBar.js'` | `'./components/CommandBar.js'` (unchanged -- same-dir) |

### ide.css (app/ide/ide.css)

No path references. The only `url()` is an inline SVG data URI on line 791. No changes needed.

### index.html redirect (app/ide/index.html)

The `meta http-equiv="refresh"` target `./ide.html` is a same-directory relative URL. No change needed.

## What Stays Behind at examples/ide/

**Nothing.** The directory is deleted entirely after `git mv`. No redirect stub is left at `examples/ide/` because:

1. The production URL is `ivanlugo.dev/ide`, routed by Caddy -- it never depended on the `examples/ide/` filesystem path.
2. Dev-server access was `localhost:8000/examples/ide/` -- this shifts to `localhost:8000/app/ide/`. Anyone navigating the old path will get a 404, which is correct for a moved resource.
3. Leaving redirect stubs creates maintenance debt for no audience. The move is internal; there are no external consumers bookmarking `examples/ide/`.

## References That Need Updating (Outside the Moved Files)

### 1. Root `index.html` (line 106-110)

```
Current:  <a class="card" href="examples/ide/">
Update:   <a class="card" href="app/ide/">
```

### 2. `examples/index.html` (line 115-122)

The examples gallery has an "IDE Shell" card linking to `ide/`. Two options:

- **Option A**: Remove the IDE card entirely. It's not an example; it's a production app. This is the correct semantic move.
- **Option B**: Change the link to `../app/ide/` and relabel it. Muddies the examples/app boundary.

**Recommendation: Option A.** Remove the card. The root `index.html` already links to it.

### 3. `package.json` -- `files` field (line 23-26)

```json
"files": [
    "src",
    "examples"
]
```

Add `"app"` to the array:

```json
"files": [
    "src",
    "examples",
    "app"
]
```

### 4. `CLAUDE.md` -- Project Structure section

Update the directory tree to reflect `app/ide/` and remove `examples/ide/` from the listing. Add an `app/` section.

### 5. Cross-ref docs

The `cross-ref/` directory has multiple references to `examples/ide/`. These are analysis artifacts, not code. They document the *prior* state. **Do not update them** -- they are historical records. Future analysis documents will reference `app/ide/`.

### 6. `.claude/projects/.../memory/MEMORY.md`

The memory entry "[IDE is a real app](project_ide_app_extraction.md)" references extraction from `examples/` to root-level app. After extraction, this entry can be updated to note completion, but that's a post-move cleanup, not part of the move itself.

## Files That DO NOT Move

| Path | Reason |
|------|--------|
| `examples/github-viewer/*` | The IDE *imports from* github-viewer; github-viewer is a standalone example. It stays put. |
| `src/*` | Core library. Completely untouched. |
| `examples/word-wall/*` | Unrelated example. |
| `examples/hand-tracking/*` | Unrelated example. |
| `examples/code-spectrometer/*` | Unrelated example. |
| `examples/cross-ref-viz/*` | Unrelated example. |
| `examples/mod-layer-visualizer/*` | Unrelated example. |
| `examples/render-test/*` | Unrelated example. |
| `examples/index.html` | Examples gallery stays (with IDE card removed). |
| `cross-ref/*` | Analysis artifacts, historical. |
| `docs/*` | Documentation, no IDE references. |
| `relay.js` | Root-level WebSocket relay, unrelated. |

## Directory Structure at Destination

```
app/
  ide/
    index.html              # meta-refresh redirect to ide.html
    ide.html                # entry point (importmap, bootstrap script)
    ide.css                 # all IDE styles
    IDEShell.js             # orchestrator class
    components/
      CommandBar.js          # command input surface
```

Mirrors the source structure exactly. The `components/` subdirectory is preserved because it's the natural grouping for UI components, and more components will land here as the categorized command palette and other features are built.

## Git History Verification

After the move, verify blame preservation:

```bash
git log --follow -- app/ide/IDEShell.js
git log --follow -- app/ide/components/CommandBar.js
```

Both should show the full commit history from when the files lived at `examples/ide/`.

## Summary Checklist

- [ ] `mkdir -p app/ide/components`
- [ ] `git mv` all 5 files (listed above)
- [ ] Update 4 import paths in `IDEShell.js` (3 github-viewer imports gain `../`)
- [ ] Update 1 import path in `CommandBar.js` (github-viewer import gains `../`)
- [ ] Update 2 import paths in `ide.html` inline script (github-viewer imports gain `../`)
- [ ] Update root `index.html` href from `examples/ide/` to `app/ide/`
- [ ] Remove IDE card from `examples/index.html`
- [ ] Add `"app"` to `package.json` `files` array
- [ ] Update `CLAUDE.md` project structure
- [ ] Verify with `python3 -m http.server 8000` and load `http://localhost:8000/app/ide/`
- [ ] Commit: `git commit -m "Extract IDE from examples/ide/ to app/ide/"`

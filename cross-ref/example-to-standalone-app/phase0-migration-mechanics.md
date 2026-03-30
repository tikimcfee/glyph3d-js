# Phase 0: Migration Mechanics Plan

**Agent**: migration-mechanics
**Scope**: Move ~46 files from `examples/github-viewer/` and `examples/ide/` into `app/`, fix all imports, leave lightweight demos behind.

---

## 1. Current Import Graph Summary

### Depth map (from repo root)

| Current location                             | Depth | Imports from src/ pattern      |
|----------------------------------------------|-------|-------------------------------|
| `examples/github-viewer/GitHubRepoViewer.js` | 2     | `../../src/...`               |
| `examples/github-viewer/StatePersistence.js`  | 2     | (none -- local only)          |
| `examples/github-viewer/components/*.js`      | 3     | `../../../src/...`            |
| `examples/github-viewer/websocket/*.js`       | 3     | `../../../src/...`            |
| `examples/github-viewer/websocket/commands/*.js` | 4  | `../../../../src/...`         |
| `examples/github-viewer/cli/*.mjs`            | 3     | (none -- Node.js only, uses ws) |
| `examples/ide/IDEShell.js`                    | 2     | `../../src/...`               |
| `examples/ide/components/CommandBar.js`       | 3     | `../../../src/...`            |

### Cross-boundary dependencies (src/ files imported)

From all `examples/github-viewer/` + `examples/ide/` JS files, there are **24 unique import paths** into `src/`:

- `src/index.js` (GlyphAtlas, CodeGrid, layout managers)
- `src/collections/CodeGrid.js` (4 files import directly)
- `src/collections/TerminalGrid.js` (1 file)
- `src/core/constants.js` (1 file: CHAR_DIMENSIONS)
- `src/utils/LogCapture.js` (1 file)
- `src/services/SceneContext.js`
- `src/services/SceneRegistry.js`
- `src/services/camera/ViewerCameraController.js`
- `src/services/data/GitHubRepositorySource.js`
- `src/services/data/HeatmapProvider.js`
- `src/services/data/RepositoryAdapter.js`
- `src/services/interaction/CodeColorManager.js`
- `src/services/interaction/SelectionManager.js`
- `src/services/interaction/ShortcutManager.js`
- `src/services/orchestration/CommandRouter.js`
- `src/services/orchestration/DiffController.js`
- `src/services/orchestration/HandGestureAdapter.js`
- `src/services/orchestration/ViewerAPI.js`
- `src/services/orchestration/WebSocketBridge.js`
- `src/services/state/FileStateManager.js`
- `src/services/utils/platform.js`
- `src/services/visual/BackdropManager.js`
- `src/services/visual/NameplateManager.js`
- `src/services/visual/TreemapLabelManager.js`

### Intra-directory dependencies (within examples/)

- `ide/IDEShell.js` imports from `github-viewer/components/Drawer.js`, `LogCapturePanel.js`, `DiffPanel.js`
- `ide/components/CommandBar.js` imports from `github-viewer/websocket/commands/encoding.js`
- `websocket/commands/*.js` import from sibling `./` files (colorConstants, encoding, spatialHelpers, gridVisualState)
- `websocket/commands/*.js` import from parent `../TUIFormatter.js`, `../TUIWindowManager.js`
- `websocket/index.js` imports from `./commands/index.js`
- `GitHubRepoViewer.js` imports from `./components/*`, `./websocket/index.js`, `./StatePersistence.js`

**Circular dependencies**: None detected. The graph is a strict DAG.

---

## 2. Target Directory Structure

```
app/
├── ide.html                        # Main entry point (production app)
├── ide.css                         # IDE layout styles
├── viewer.html                     # Standalone viewer (alternate entry)
├── viewer.css                      # Viewer styles (renamed from styles.css)
├── IDEShell.js                     # IDE orchestrator
├── GitHubRepoViewer.js             # Main viewer orchestrator
├── StatePersistence.js             # localStorage state management
├── components/
│   ├── AppShell.js                 # Header, loading overlay, FPS badge, toast
│   ├── CommandBar.js               # IDE command palette (from ide/components/)
│   ├── DiffPanel.js                # Diff panel UI
│   ├── Drawer.js                   # Sidebar drawer panels
│   ├── LogCapturePanel.js          # Log capture panel
│   ├── MinimapOverlay.js           # Minimap overlay
│   └── TouchController.js          # Touch input handling
├── websocket/
│   ├── index.js                    # Command center init
│   ├── TUIFocusManager.js          # TUI keyboard focus routing
│   ├── TUIFormatter.js             # TUI text formatting helpers
│   ├── TUIWindow.js                # TUI window component
│   ├── TUIWindowManager.js         # TUI window lifecycle
│   └── commands/
│       ├── index.js                # Command registry
│       ├── agentLayoutCommands.js
│       ├── annotationCommands.js
│       ├── cameraCommands.js
│       ├── colorConstants.js
│       ├── compositionCommands.js
│       ├── encoding.js
│       ├── gridCommands.js
│       ├── gridVisualState.js
│       ├── layoutCommands.js
│       ├── navigationCommands.js
│       ├── orchestrationCommands.js
│       ├── registryCommands.js
│       ├── sceneCommands.js
│       ├── searchCommands.js
│       ├── selectCommands.js
│       ├── spatialCommands.js
│       ├── spatialHelpers.js
│       ├── systemCommands.js
│       ├── terminalCommands.js
│       └── windowCommands.js
└── cli/                            # Node.js CLI tools (unchanged)
    ├── agent-hook.mjs
    ├── AgentWindowManager.mjs
    ├── AgentWindow.mjs
    ├── CliConnection.mjs
    ├── cli_connection.py
    ├── CodeTour.mjs
    ├── glyph-cli.mjs
    └── glyph-cli.py
```

**Total files moved**: ~42 files (34 JS/MJS, 4 HTML/CSS, 2 Python, 2 misc)

### Key decisions

1. **Flat `app/` at depth 1** from repo root. This simplifies all `src/` imports from `../../src/` to `../src/`.
2. **Merge `ide/components/CommandBar.js` into `app/components/`** alongside the viewer components. The IDE and viewer share the same component namespace now.
3. **`cli/` moves as-is** -- these are Node.js files with no browser imports. They only need `ws` npm package.
4. **Two HTML entry points**: `ide.html` (production IDE) and `viewer.html` (standalone viewer). The `index.html` redirect stays in `examples/ide/` until removed.

---

## 3. Import Rewrite Rules

### Systematic patterns (all files)

| Current pattern | File depth | New pattern | Count |
|---|---|---|---|
| `../../src/` | `app/*.js` (depth 1) | `../src/` | ~18 |
| `../../../src/` | `app/components/*.js`, `app/websocket/*.js` (depth 2) | `../../src/` | ~7 |
| `../../../../src/` | `app/websocket/commands/*.js` (depth 3) | `../../../src/` | ~5 |

**Every `src/` import loses exactly one `../` prefix** because `app/` is one directory shallower than `examples/github-viewer/`.

### Intra-app rewrites

These **do NOT change** because the internal structure is preserved:
- `./components/AppShell.js` -- same relative path
- `./websocket/index.js` -- same relative path
- `../TUIFormatter.js` from commands/ -- same relative path
- `./spatialHelpers.js` within commands/ -- same relative path

### Cross-IDE/viewer rewrites (4 statements)

These are the statements that currently cross from `ide/` into `github-viewer/`:

| File | Old import | New import |
|---|---|---|
| `IDEShell.js` | `from '../github-viewer/components/Drawer.js'` | `from './components/Drawer.js'` |
| `IDEShell.js` | `from '../github-viewer/components/LogCapturePanel.js'` | `from './components/LogCapturePanel.js'` |
| `IDEShell.js` | `from '../github-viewer/components/DiffPanel.js'` | `from './components/DiffPanel.js'` |
| `IDEShell.js` | `from '../../src/services/utils/platform.js'` | `from '../src/services/utils/platform.js'` |
| `CommandBar.js` | `from '../../../src/services/utils/platform.js'` | `from '../../src/services/utils/platform.js'` |
| `CommandBar.js` | `from '../../github-viewer/websocket/commands/encoding.js'` | `from '../websocket/commands/encoding.js'` |

### HTML rewrites

| File | Change |
|---|---|
| `ide.html` | `<link rel="stylesheet" href="ide.css">` -- no change |
| `ide.html` | Script import: adjust module path from `../github-viewer/GitHubRepoViewer.js` to `./GitHubRepoViewer.js` (verify actual path) |
| `viewer.html` | Script import: `./GitHubRepoViewer.js` -- already correct after move |

### Total import rewrites

| Category | Count |
|---|---|
| `src/` path shortening (remove one `../`) | ~30 |
| IDE-to-viewer cross-ref collapse | ~6 |
| HTML script/link adjustments | ~2 |
| **Total** | **~38** |

Intra-directory imports (sibling `./` references): **~45 statements, zero changes needed**.

---

## 4. Move Order

The migration can be done as a **single atomic move** because:

1. No file in `src/` imports from `examples/` (one-way dependency).
2. No circular dependencies exist between example files.
3. Internal relative paths are preserved since the subdirectory structure is kept.

### Recommended sequence (within one commit)

```bash
# Step 1: Create target directory
mkdir -p app/components app/websocket/commands app/cli

# Step 2: Move github-viewer files (bulk)
git mv examples/github-viewer/GitHubRepoViewer.js    app/
git mv examples/github-viewer/StatePersistence.js     app/
git mv examples/github-viewer/index.html              app/viewer.html
git mv examples/github-viewer/styles.css              app/viewer.css
git mv examples/github-viewer/components/             app/components/
git mv examples/github-viewer/websocket/              app/websocket/
git mv examples/github-viewer/cli/                    app/cli/
git mv examples/github-viewer/ws-relay.mjs            app/
git mv examples/github-viewer/ws-relay.py             app/

# Step 3: Move IDE files
git mv examples/ide/ide.html                          app/ide.html
git mv examples/ide/ide.css                           app/ide.css
git mv examples/ide/IDEShell.js                       app/IDEShell.js
git mv examples/ide/components/CommandBar.js           app/components/CommandBar.js

# Step 4: Fix imports (sed or manual -- ~38 statements)
# Pattern: reduce all ../../src/ -> ../src/ in app/*.js
# Pattern: reduce all ../../../src/ -> ../../src/ in app/components/*.js, app/websocket/*.js
# Pattern: reduce all ../../../../src/ -> ../../../src/ in app/websocket/commands/*.js
# Pattern: fix IDE cross-refs in IDEShell.js and CommandBar.js

# Step 5: Update HTML entry points
# - ide.html: fix script src paths
# - viewer.html: already correct (imports ./GitHubRepoViewer.js)

# Step 6: Update root index.html if it links to examples/
```

### What about `examples/ide/index.html`?

This is just a redirect (`<meta http-equiv="refresh" content="0; url=./ide.html">`). It can be deleted or replaced with a redirect to `../app/ide.html`. Since the IDE is now in `app/`, this redirect is obsolete.

---

## 5. What Stays in `examples/`

After migration, `examples/` contains only lightweight demos:

```
examples/
├── github-viewer/              # Minimal standalone demo
│   ├── index.html              # NEW: lightweight demo page
│   ├── styles.css              # NEW: minimal styles
│   └── demo.js                 # NEW: ~30 lines, imports from ../../src/index.js
├── word-wall/                  # Existing demo (unchanged)
│   └── ...
└── ide/                        # DELETE (or leave empty redirect)
    └── index.html              # Optional: redirect to /app/ide.html
```

The current `examples/github-viewer/index.html` is a full-fat entry point (it imports `GitHubRepoViewer.js` and wires everything). After migration, we have two options:

**Option A**: Delete `examples/github-viewer/` entirely. The `app/viewer.html` serves as the standalone viewer.

**Option B**: Replace with a true lightweight demo that only uses `src/` library APIs (GlyphAtlas + CodeGrid, no services/commands/websocket). This would be a genuine usage example of the library, not the production app.

**Recommended**: Option A initially (delete). Write a real minimal demo later when the library API stabilizes.

---

## 6. Validation Strategy

### Automated checks (no test runner needed)

```bash
# 1. Verify no broken imports: attempt to resolve every import path
# Script: for each .js file in app/, extract all import paths,
# resolve them relative to the file's location, check file exists
find app/ -name "*.js" -exec grep -oP "from '([^']+)'" {} + | \
  while read f path; do
    # resolve and check existence
  done

# 2. Verify no residual examples/ cross-refs
grep -rn "examples/" app/ --include="*.js" --include="*.html"
# Expected: zero results

# 3. Verify no dangling ../../ that go above repo root
grep -rn "'\.\./\.\./\.\./\.\./\.\./\.\." app/ --include="*.js"
# Expected: zero results

# 4. Verify src/ files have zero imports from app/ (no reverse dependency)
grep -rn "app/" src/ --include="*.js"
# Expected: zero results
```

### Manual browser verification

1. Start server: `python3 -m http.server 8000`
2. Load `http://localhost:8000/app/ide.html` -- IDE shell must render, Three.js canvas must initialize
3. Load `http://localhost:8000/app/viewer.html` -- standalone viewer must work
4. Open DevTools console -- **zero 404 errors on module loads**
5. Open DevTools Network tab -- verify all `.js` files resolve
6. Test WebSocket connection: `python3 app/ws-relay.py` + connect from CLI

### Import resolution script

Because there is no build step, a simple Node.js script can validate all imports:

```javascript
// validate-imports.mjs -- run with: node validate-imports.mjs
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { glob } from 'glob';

const files = glob.sync('app/**/*.js');
let errors = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const re = /from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue; // skip bare specifiers (three, ws)
    const target = resolve(dirname(file), spec);
    if (!existsSync(target)) {
      console.error(`BROKEN: ${file} -> ${spec}`);
      errors++;
    }
  }
}
console.log(errors === 0 ? 'All imports OK' : `${errors} broken imports`);
```

---

## 7. Git Strategy

### One atomic commit (recommended)

```
Move production app from examples/ to app/

Relocate github-viewer + ide shell into top-level app/ directory.
Fix all import paths (reduce by one ../ level for src/ refs,
collapse ide->viewer cross-refs to same directory).

This separates the production app (ivanlugo.dev/ide) from
lightweight library usage examples.
```

**Why one commit, not staged**:
- `git mv` preserves file history in a single commit.
- Splitting into "move files" then "fix imports" creates a broken intermediate state where the app cannot load. Anyone bisecting would hit it.
- With `git mv`, git tracks the rename. If we split move + import fix, the "fix" commit looks like a mass edit with no context.

**If the diff is too large to review**: split into two commits that are both independently valid:
1. Commit 1: `git mv` all files + fix all imports (app works)
2. Commit 2: Clean up `examples/` remnants, update root `index.html`, update `CLAUDE.md`

---

## 8. Risk Assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| Missed import rewrite | Medium | Validation script + browser 404 check |
| `ide.html` internal script paths wrong | Medium | Read full `ide.html` before move, trace all `<script>` and `<link>` tags |
| `ws-relay.py` has hardcoded paths | Low | It's a standalone relay, no file paths |
| Root `index.html` links to old paths | High | Update links in same commit |
| BLUETOOTH_NOTES.md and other non-code files in websocket/ | Low | Move with the directory, no import impact |
| `cli/__pycache__/` | Low | Add to `.gitignore` or delete before commit |
| Other examples/ files import from github-viewer | Medium | Only `ide/` does this, and it's being moved too. Grep to confirm. |

---

## 9. File-by-File Import Rewrite Manifest

### `app/GitHubRepoViewer.js` (18 import statements to rewrite)

All `../../src/` becomes `../src/`:
```
../../src/index.js                              -> ../src/index.js
../../src/services/interaction/SelectionManager  -> ../src/services/interaction/SelectionManager
../../src/services/interaction/ShortcutManager   -> ../src/services/interaction/ShortcutManager
../../src/services/visual/TreemapLabelManager    -> ../src/services/visual/TreemapLabelManager
../../src/services/data/RepositoryAdapter        -> ../src/services/data/RepositoryAdapter
../../src/services/data/GitHubRepositorySource   -> ../src/services/data/GitHubRepositorySource
../../src/services/orchestration/DiffController  -> ../src/services/orchestration/DiffController
../../src/services/visual/BackdropManager        -> ../src/services/visual/BackdropManager
../../src/services/visual/NameplateManager       -> ../src/services/visual/NameplateManager
../../src/services/SceneContext                  -> ../src/services/SceneContext
../../src/services/camera/ViewerCameraController -> ../src/services/camera/ViewerCameraController
../../src/services/state/FileStateManager        -> ../src/services/state/FileStateManager
../../src/services/interaction/CodeColorManager  -> ../src/services/interaction/CodeColorManager
../../src/services/data/HeatmapProvider          -> ../src/services/data/HeatmapProvider
../../src/services/orchestration/HandGestureAdapter -> ../src/services/orchestration/HandGestureAdapter
../../src/services/SceneRegistry                 -> ../src/services/SceneRegistry
```

Local imports (unchanged): `./components/*`, `./websocket/index.js`, `./StatePersistence.js`

### `app/IDEShell.js` (4 rewrites)

```
../github-viewer/components/Drawer.js       -> ./components/Drawer.js
../github-viewer/components/LogCapturePanel  -> ./components/LogCapturePanel.js
../github-viewer/components/DiffPanel        -> ./components/DiffPanel.js
../../src/services/utils/platform.js         -> ../src/services/utils/platform.js
```

### `app/components/CommandBar.js` (2 rewrites)

```
../../../src/services/utils/platform.js                    -> ../../src/services/utils/platform.js
../../github-viewer/websocket/commands/encoding.js         -> ../websocket/commands/encoding.js
```

### `app/components/LogCapturePanel.js` (1 rewrite)

```
../../../src/utils/LogCapture.js -> ../../src/utils/LogCapture.js
```

### `app/websocket/index.js` (3 rewrites)

```
../../../src/services/orchestration/CommandRouter.js   -> ../../src/services/orchestration/CommandRouter.js
../../../src/services/orchestration/WebSocketBridge.js  -> ../../src/services/orchestration/WebSocketBridge.js
../../../src/services/orchestration/ViewerAPI.js        -> ../../src/services/orchestration/ViewerAPI.js
```

### `app/websocket/TUIFocusManager.js` (2 rewrites)

```
../../../src/services/utils/platform.js -> ../../src/services/utils/platform.js
../../../src/core/constants.js          -> ../../src/core/constants.js
```

### `app/websocket/TUIWindow.js` (1 rewrite)

```
../../../src/collections/CodeGrid.js -> ../../src/collections/CodeGrid.js
```

### `app/websocket/commands/annotationCommands.js` (1 rewrite)

```
../../../../src/collections/CodeGrid.js -> ../../../src/collections/CodeGrid.js
```

### `app/websocket/commands/gridCommands.js` (1 rewrite)

```
../../../../src/collections/CodeGrid.js -> ../../../src/collections/CodeGrid.js
```

### `app/websocket/commands/navigationCommands.js` (1 rewrite)

```
../../../../src/collections/CodeGrid.js -> ../../../src/collections/CodeGrid.js
```

### `app/websocket/commands/terminalCommands.js` (1 rewrite)

```
../../../../src/collections/TerminalGrid.js -> ../../../src/collections/TerminalGrid.js
```

### Files with ZERO import changes (internal-only refs)

All command files that only import from siblings (`./`) and parent (`../`):
- `commands/index.js`, `cameraCommands.js`, `colorConstants.js`, `compositionCommands.js`,
  `encoding.js`, `gridVisualState.js`, `layoutCommands.js`, `orchestrationCommands.js`,
  `registryCommands.js`, `sceneCommands.js`, `searchCommands.js`, `selectCommands.js`,
  `spatialCommands.js`, `spatialHelpers.js`, `systemCommands.js`, `windowCommands.js`
- `components/AppShell.js`, `components/Drawer.js`, `components/DiffPanel.js`,
  `components/MinimapOverlay.js`, `components/TouchController.js`
- `StatePersistence.js`
- `websocket/TUIFormatter.js`, `websocket/TUIWindowManager.js`
- All `cli/*.mjs` files

**Summary**: 35 import statements need rewriting across 11 files. The remaining ~50+ import statements are untouched.

---

## 10. Execution Checklist

- [ ] Read full `ide.html` to find all `<script>` and `<link>` references before move
- [ ] `git mv` all files per Step 2-3 above
- [ ] Rewrite 35 import paths across 11 JS files
- [ ] Update `ide.html` script/link paths
- [ ] Update `viewer.html` link to `viewer.css` (was `styles.css`)
- [ ] Delete `examples/ide/` directory (or leave redirect)
- [ ] Delete `examples/github-viewer/` directory (or leave minimal demo)
- [ ] Delete `examples/github-viewer/cli/__pycache__/` (untracked)
- [ ] Update root `index.html` links
- [ ] Update `CLAUDE.md` project structure section
- [ ] Update `package.json` if it references examples/ paths
- [ ] Run import validation script
- [ ] Browser-test `app/ide.html` and `app/viewer.html`
- [ ] Verify `git log --follow app/GitHubRepoViewer.js` preserves history

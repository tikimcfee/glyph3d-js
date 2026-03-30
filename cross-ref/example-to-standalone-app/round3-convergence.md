# Converged Plan: Extract Example to Standalone Application

Convergence agent output. Inputs: three Phase 0 analyses (app-boundary, library-promotion, migration-mechanics) and three Round 1 cross-reviews. All decisions verified against actual source file imports.

---

## Settled Points

1. **Two-commit strategy within one PR.** Commit 1 is a pure structural move from `examples/` to `app/` with import path adjustments. Commit 2 promotes library-worthy code from `app/` to `src/` and updates imports. Both commits leave the app in a working state. All three agents converged on this approach during Round 1.

2. **TUI system promotes to `src/tui/`.** TUIWindow, TUIWindowManager, TUIFocusManager, TUIFormatter -- all four files. Unanimous agreement across all agents in Round 1. Dependency chain verified clean: TUIWindow imports only `CodeGrid` (src/collections/), TUIWindowManager imports only `TUIWindow`, TUIFocusManager imports only `platform.js` (src/services/utils/) and `constants.js` (src/core/), TUIFormatter has zero imports.

3. **`encoding.js` promotes to `src/utils/encoding.js`.** Zero dependencies, pure UTF-8 base64 encode/decode. Unanimous.

4. **`spatialHelpers.js` does NOT promote -- stays in `app/commands/`.** The file mixes pure spatial math (`box3ToAABB`, `getWorldBounds`, `zDistanceForFit`) with app-coupled functions that take a `ctx` bag (`resolveGridByIdOrIndex`, `frameBounds`, `animateCamera`). library-promotion and migration-mechanics both identified this in Round 1. A future split-and-partial-promote is deferred.

5. **MinimapOverlay promotes to `src/components/MinimapOverlay.js`.** app-boundary classified it as PROMOTE. library-promotion retracted its DEFER in Round 1 review. migration-mechanics deferred but acknowledged it was "plausible." Two-of-three favor promotion. Verified: the file has zero imports -- it is a self-contained 2D canvas component with DI via constructor args `{THREE, camera, getGrids, getLayoutBounds, onNavigate}`.

6. **TouchController does NOT promote -- stays in `app/components/`.** It calls `cameraController._applyDragTranslation()` (private method). library-promotion and migration-mechanics both agree: defer until CameraController exposes a public `pan(dx, dy)` API.

7. **Command handlers are APP code, not library.** The 16 command handler files plus `colorConstants.js`, `gridVisualState.js`, and the command bootstrapper define the application's command vocabulary. Unanimous.

8. **Directory rename: `websocket/` becomes `commands/` with `handlers/` subdirectory.** The `websocket/` name describes transport (handled by `src/services/orchestration/WebSocketBridge`), not intent. After TUI files promote out, only the command bootstrapper and handler registry remain. app-boundary proposed this; migration-mechanics accepted it in Round 1.

9. **Delete `BLUETOOTH_NOTES.md` and `cli/__pycache__/`.** Unanimous.

10. **`examples/word-wall/` is unaffected.** Verified: it imports only from `../../src/index.js` and `../../src/GlyphRenderer.js`. Zero imports from `examples/github-viewer/`. Safe.

11. **Relay servers have no path assumptions.** Verified: `ws-relay.mjs` and `ws-relay.py` are standalone network servers with only port/host CLI args. No file path references.

12. **`ide.html` importmap uses CDN URL for `three`.** No depth-relative path for three.js -- it uses `https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js`. Moving the HTML file does not break the importmap. The same is true for `index.html` (viewer).

---

## Final Directory Structure

### After Commit 1 (pure move)

```
app/
  ide.html
  ide.css
  viewer.html                          (was examples/github-viewer/index.html)
  viewer.css                           (was examples/github-viewer/styles.css)
  IDEShell.js
  GitHubRepoViewer.js
  StatePersistence.js
  ws-relay.mjs
  ws-relay.py
  components/
    AppShell.js
    CommandBar.js                      (from examples/ide/components/)
    DiffPanel.js
    Drawer.js
    LogCapturePanel.js
    MinimapOverlay.js
    TouchController.js
  websocket/
    index.js
    TUIFocusManager.js
    TUIFormatter.js
    TUIWindow.js
    TUIWindowManager.js
    commands/
      index.js
      agentLayoutCommands.js
      annotationCommands.js
      cameraCommands.js
      colorConstants.js
      compositionCommands.js
      encoding.js
      gridCommands.js
      gridVisualState.js
      layoutCommands.js
      navigationCommands.js
      orchestrationCommands.js
      registryCommands.js
      sceneCommands.js
      searchCommands.js
      selectCommands.js
      spatialCommands.js
      spatialHelpers.js
      systemCommands.js
      terminalCommands.js
      windowCommands.js
  cli/
    agent-hook.mjs
    AgentWindow.mjs
    AgentWindowManager.mjs
    CliConnection.mjs
    cli_connection.py
    CodeTour.mjs
    glyph-cli.mjs
    glyph-cli.py
```

### After Commit 2 (promotions + rename)

```
app/
  ide.html
  ide.css
  viewer.html
  viewer.css
  IDEShell.js
  GitHubRepoViewer.js
  StatePersistence.js
  ws-relay.mjs
  ws-relay.py
  components/
    AppShell.js
    CommandBar.js
    DiffPanel.js
    Drawer.js
    LogCapturePanel.js
    TouchController.js
  commands/                             (was websocket/)
    index.js                            (was websocket/index.js -- bootstrapper)
    handlers/                           (was websocket/commands/)
      index.js
      agentLayoutCommands.js
      annotationCommands.js
      cameraCommands.js
      colorConstants.js
      compositionCommands.js
      gridCommands.js
      gridVisualState.js
      layoutCommands.js
      navigationCommands.js
      orchestrationCommands.js
      registryCommands.js
      sceneCommands.js
      searchCommands.js
      selectCommands.js
      spatialCommands.js
      spatialHelpers.js
      systemCommands.js
      terminalCommands.js
      windowCommands.js
  cli/
    (unchanged from Commit 1)

src/
  tui/                                  (NEW)
    index.js                            (barrel export)
    TUIWindow.js
    TUIWindowManager.js
    TUIFocusManager.js
    TUIFormatter.js
  components/                           (NEW)
    MinimapOverlay.js
  utils/
    encoding.js                         (NEW -- promoted from commands/)
    (existing files unchanged)
```

---

## Commit 1: Move everything to `app/`

### Pre-move cleanup

```bash
# Delete non-code artifacts
rm examples/github-viewer/websocket/BLUETOOTH_NOTES.md
rm -rf examples/github-viewer/cli/__pycache__/
```

### Git mv commands

```bash
# Create target directories
mkdir -p app/components app/websocket/commands app/cli

# Move github-viewer top-level files
git mv examples/github-viewer/GitHubRepoViewer.js     app/GitHubRepoViewer.js
git mv examples/github-viewer/StatePersistence.js      app/StatePersistence.js
git mv examples/github-viewer/index.html               app/viewer.html
git mv examples/github-viewer/styles.css               app/viewer.css
git mv examples/github-viewer/ws-relay.mjs              app/ws-relay.mjs
git mv examples/github-viewer/ws-relay.py               app/ws-relay.py

# Move github-viewer components (directory move)
git mv examples/github-viewer/components/AppShell.js       app/components/AppShell.js
git mv examples/github-viewer/components/DiffPanel.js      app/components/DiffPanel.js
git mv examples/github-viewer/components/Drawer.js         app/components/Drawer.js
git mv examples/github-viewer/components/LogCapturePanel.js app/components/LogCapturePanel.js
git mv examples/github-viewer/components/MinimapOverlay.js  app/components/MinimapOverlay.js
git mv examples/github-viewer/components/TouchController.js app/components/TouchController.js

# Move websocket/ (TUI + commands)
git mv examples/github-viewer/websocket/index.js           app/websocket/index.js
git mv examples/github-viewer/websocket/TUIFocusManager.js  app/websocket/TUIFocusManager.js
git mv examples/github-viewer/websocket/TUIFormatter.js     app/websocket/TUIFormatter.js
git mv examples/github-viewer/websocket/TUIWindow.js        app/websocket/TUIWindow.js
git mv examples/github-viewer/websocket/TUIWindowManager.js app/websocket/TUIWindowManager.js

# Move commands/ (all 21 files)
git mv examples/github-viewer/websocket/commands/index.js              app/websocket/commands/index.js
git mv examples/github-viewer/websocket/commands/agentLayoutCommands.js app/websocket/commands/agentLayoutCommands.js
git mv examples/github-viewer/websocket/commands/annotationCommands.js  app/websocket/commands/annotationCommands.js
git mv examples/github-viewer/websocket/commands/cameraCommands.js      app/websocket/commands/cameraCommands.js
git mv examples/github-viewer/websocket/commands/colorConstants.js      app/websocket/commands/colorConstants.js
git mv examples/github-viewer/websocket/commands/compositionCommands.js app/websocket/commands/compositionCommands.js
git mv examples/github-viewer/websocket/commands/encoding.js            app/websocket/commands/encoding.js
git mv examples/github-viewer/websocket/commands/gridCommands.js        app/websocket/commands/gridCommands.js
git mv examples/github-viewer/websocket/commands/gridVisualState.js     app/websocket/commands/gridVisualState.js
git mv examples/github-viewer/websocket/commands/layoutCommands.js      app/websocket/commands/layoutCommands.js
git mv examples/github-viewer/websocket/commands/navigationCommands.js  app/websocket/commands/navigationCommands.js
git mv examples/github-viewer/websocket/commands/orchestrationCommands.js app/websocket/commands/orchestrationCommands.js
git mv examples/github-viewer/websocket/commands/registryCommands.js    app/websocket/commands/registryCommands.js
git mv examples/github-viewer/websocket/commands/sceneCommands.js       app/websocket/commands/sceneCommands.js
git mv examples/github-viewer/websocket/commands/searchCommands.js      app/websocket/commands/searchCommands.js
git mv examples/github-viewer/websocket/commands/selectCommands.js      app/websocket/commands/selectCommands.js
git mv examples/github-viewer/websocket/commands/spatialCommands.js     app/websocket/commands/spatialCommands.js
git mv examples/github-viewer/websocket/commands/spatialHelpers.js      app/websocket/commands/spatialHelpers.js
git mv examples/github-viewer/websocket/commands/systemCommands.js      app/websocket/commands/systemCommands.js
git mv examples/github-viewer/websocket/commands/terminalCommands.js    app/websocket/commands/terminalCommands.js
git mv examples/github-viewer/websocket/commands/windowCommands.js      app/websocket/commands/windowCommands.js

# Move CLI
git mv examples/github-viewer/cli/agent-hook.mjs          app/cli/agent-hook.mjs
git mv examples/github-viewer/cli/AgentWindow.mjs          app/cli/AgentWindow.mjs
git mv examples/github-viewer/cli/AgentWindowManager.mjs    app/cli/AgentWindowManager.mjs
git mv examples/github-viewer/cli/CliConnection.mjs         app/cli/CliConnection.mjs
git mv examples/github-viewer/cli/cli_connection.py         app/cli/cli_connection.py
git mv examples/github-viewer/cli/CodeTour.mjs              app/cli/CodeTour.mjs
git mv examples/github-viewer/cli/glyph-cli.mjs             app/cli/glyph-cli.mjs
git mv examples/github-viewer/cli/glyph-cli.py              app/cli/glyph-cli.py

# Move IDE files
git mv examples/ide/ide.html                               app/ide.html
git mv examples/ide/ide.css                                app/ide.css
git mv examples/ide/IDEShell.js                            app/IDEShell.js
git mv examples/ide/components/CommandBar.js                app/components/CommandBar.js
```

### Import path rewrites (Commit 1)

Every file that imports from `src/` loses exactly one `../` level because `app/` is at depth 1 from root while `examples/github-viewer/` was at depth 2. Cross-boundary imports (ide -> github-viewer) collapse to same-directory references.

#### `app/GitHubRepoViewer.js` -- 16 src/ rewrites, 0 local rewrites

All `../../src/` becomes `../src/`:

| Line | Old path | New path |
|------|----------|----------|
| 18 | `'../../src/index.js'` | `'../src/index.js'` |
| 21 | `'../../src/services/interaction/SelectionManager.js'` | `'../src/services/interaction/SelectionManager.js'` |
| 22 | `'../../src/services/interaction/ShortcutManager.js'` | `'../src/services/interaction/ShortcutManager.js'` |
| 23 | `'../../src/services/visual/TreemapLabelManager.js'` | `'../src/services/visual/TreemapLabelManager.js'` |
| 25 | `'../../src/services/data/RepositoryAdapter.js'` | `'../src/services/data/RepositoryAdapter.js'` |
| 26 | `'../../src/services/data/GitHubRepositorySource.js'` | `'../src/services/data/GitHubRepositorySource.js'` |
| 27 | `'../../src/services/orchestration/DiffController.js'` | `'../src/services/orchestration/DiffController.js'` |
| 28 | `'../../src/services/visual/BackdropManager.js'` | `'../src/services/visual/BackdropManager.js'` |
| 29 | `'../../src/services/visual/NameplateManager.js'` | `'../src/services/visual/NameplateManager.js'` |
| 30 | `'../../src/services/SceneContext.js'` | `'../src/services/SceneContext.js'` |
| 31 | `'../../src/services/camera/ViewerCameraController.js'` | `'../src/services/camera/ViewerCameraController.js'` |
| 32 | `'../../src/services/state/FileStateManager.js'` | `'../src/services/state/FileStateManager.js'` |
| 33 | `'../../src/services/interaction/CodeColorManager.js'` | `'../src/services/interaction/CodeColorManager.js'` |
| 34 | `'../../src/services/data/HeatmapProvider.js'` | `'../src/services/data/HeatmapProvider.js'` |
| 49 | `'../../src/services/orchestration/HandGestureAdapter.js'` | `'../src/services/orchestration/HandGestureAdapter.js'` |
| 51 | `'../../src/services/SceneRegistry.js'` | `'../src/services/SceneRegistry.js'` |

Local imports (`./components/*`, `./websocket/index.js`, `./StatePersistence.js`) -- unchanged.

#### `app/IDEShell.js` -- 4 rewrites

| Old path | New path |
|----------|----------|
| `'../github-viewer/components/Drawer.js'` | `'./components/Drawer.js'` |
| `'../github-viewer/components/LogCapturePanel.js'` | `'./components/LogCapturePanel.js'` |
| `'../github-viewer/components/DiffPanel.js'` | `'./components/DiffPanel.js'` |
| `'../../src/services/utils/platform.js'` | `'../src/services/utils/platform.js'` |

#### `app/components/CommandBar.js` -- 2 rewrites

| Old path | New path |
|----------|----------|
| `'../../../src/services/utils/platform.js'` | `'../../src/services/utils/platform.js'` |
| `'../../github-viewer/websocket/commands/encoding.js'` | `'../websocket/commands/encoding.js'` |

#### `app/components/LogCapturePanel.js` -- 1 rewrite

| Old path | New path |
|----------|----------|
| `'../../../src/utils/LogCapture.js'` | `'../../src/utils/LogCapture.js'` |

#### `app/websocket/index.js` -- 3 rewrites

| Old path | New path |
|----------|----------|
| `'../../../src/services/orchestration/CommandRouter.js'` | `'../../src/services/orchestration/CommandRouter.js'` |
| `'../../../src/services/orchestration/WebSocketBridge.js'` | `'../../src/services/orchestration/WebSocketBridge.js'` |
| `'../../../src/services/orchestration/ViewerAPI.js'` | `'../../src/services/orchestration/ViewerAPI.js'` |

#### `app/websocket/TUIFocusManager.js` -- 2 rewrites

| Old path | New path |
|----------|----------|
| `'../../../src/services/utils/platform.js'` | `'../../src/services/utils/platform.js'` |
| `'../../../src/core/constants.js'` | `'../../src/core/constants.js'` |

#### `app/websocket/TUIWindow.js` -- 1 rewrite

| Old path | New path |
|----------|----------|
| `'../../../src/collections/CodeGrid.js'` | `'../../src/collections/CodeGrid.js'` |

#### `app/websocket/commands/annotationCommands.js` -- 1 rewrite

| Old path | New path |
|----------|----------|
| `'../../../../src/collections/CodeGrid.js'` | `'../../../src/collections/CodeGrid.js'` |

#### `app/websocket/commands/gridCommands.js` -- 1 rewrite

| Old path | New path |
|----------|----------|
| `'../../../../src/collections/CodeGrid.js'` | `'../../../src/collections/CodeGrid.js'` |

#### `app/websocket/commands/navigationCommands.js` -- 1 rewrite

| Old path | New path |
|----------|----------|
| `'../../../../src/collections/CodeGrid.js'` | `'../../../src/collections/CodeGrid.js'` |

#### `app/websocket/commands/terminalCommands.js` -- 1 rewrite

| Old path | New path |
|----------|----------|
| `'../../../../src/collections/TerminalGrid.js'` | `'../../../src/collections/TerminalGrid.js'` |

#### `app/ide.html` -- 3 rewrites (in `<script type="module">`)

| Old path | New path |
|----------|----------|
| `'../github-viewer/GitHubRepoViewer.js'` | `'./GitHubRepoViewer.js'` |
| `'../github-viewer/components/Drawer.js'` | `'./components/Drawer.js'` |
| `'./IDEShell.js'` | (unchanged) |
| `'./components/CommandBar.js'` | (unchanged) |

Note: the `<link rel="stylesheet" href="ide.css">` is unchanged (same relative path).

#### `app/viewer.html` -- 1 rewrite

| Old path | New path |
|----------|----------|
| `<link rel="stylesheet" href="styles.css">` | `<link rel="stylesheet" href="viewer.css">` |

Script `import { GitHubRepoViewer } from './GitHubRepoViewer.js'` -- unchanged (already relative).

#### Files with ZERO import changes (verified)

All these files use only sibling (`./`) or parent (`../`) imports within the same directory subtree, which is preserved by the move:

- `app/StatePersistence.js` -- no imports
- `app/components/AppShell.js` -- no imports
- `app/components/Drawer.js` -- no imports
- `app/components/DiffPanel.js` -- no imports
- `app/components/MinimapOverlay.js` -- no imports
- `app/components/TouchController.js` -- no imports
- `app/websocket/TUIFormatter.js` -- no imports
- `app/websocket/TUIWindowManager.js` -- imports `'./TUIWindow.js'` (unchanged)
- `app/websocket/commands/encoding.js` -- no imports
- `app/websocket/commands/colorConstants.js` -- no imports
- `app/websocket/commands/gridVisualState.js` -- imports from `./` siblings (unchanged)
- `app/websocket/commands/spatialHelpers.js` -- imports `'three'` bare specifier (unchanged)
- `app/websocket/commands/index.js` -- imports from `./` siblings (unchanged)
- All `app/websocket/commands/*Commands.js` -- imports from `../TUIFormatter.js`, `./encoding.js`, `./spatialHelpers.js`, `./colorConstants.js`, `./gridVisualState.js` are all unchanged
  - Exception: the 4 files with `../../../../src/` imports listed above
- `app/websocket/commands/windowCommands.js` -- imports `'../TUIWindowManager.js'` (unchanged) and `'./encoding.js'` (unchanged)
- All `app/cli/*.mjs` -- no `src/` or cross-directory imports
- All `app/cli/*.py` -- no JS imports

**Commit 1 total: 36 import statement rewrites across 12 files (10 JS + 2 HTML).**

### Commit 1 validation

```bash
# 1. No residual examples/ cross-refs in app/
grep -rn "examples/" app/ --include="*.js" --include="*.html"
# Expected: zero results

# 2. No dangling deep paths above repo root
grep -rn "'\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/" app/ --include="*.js"
# Expected: zero results

# 3. src/ has zero imports from app/ (no reverse dependency)
grep -rn "app/" src/ --include="*.js"
# Expected: zero results

# 4. Browser test: python3 -m http.server 8000
#    Load http://localhost:8000/app/ide.html -- must render
#    Load http://localhost:8000/app/viewer.html -- must render
#    DevTools console: zero 404 errors
```

---

## Commit 2: Promote library-worthy code to `src/` + rename `websocket/` to `commands/`

This commit does three things in one pass: (A) promotes TUI + encoding + MinimapOverlay from `app/` to `src/`, (B) renames `app/websocket/` to `app/commands/` with `handlers/` subdirectory, (C) updates all imports. The app works after this commit.

### A. Promote TUI files to `src/tui/`

```bash
mkdir -p src/tui

git mv app/websocket/TUIWindow.js          src/tui/TUIWindow.js
git mv app/websocket/TUIWindowManager.js   src/tui/TUIWindowManager.js
git mv app/websocket/TUIFocusManager.js    src/tui/TUIFocusManager.js
git mv app/websocket/TUIFormatter.js       src/tui/TUIFormatter.js
```

#### Update internal imports in promoted TUI files

**`src/tui/TUIWindow.js`** -- 1 rewrite:

| Old path | New path |
|----------|----------|
| `'../../src/collections/CodeGrid.js'` | `'../collections/CodeGrid.js'` |

**`src/tui/TUIWindowManager.js`** -- 0 rewrites:

Import `'./TUIWindow.js'` remains valid (same directory).

**`src/tui/TUIFocusManager.js`** -- 2 rewrites:

| Old path | New path |
|----------|----------|
| `'../../src/services/utils/platform.js'` | `'../services/utils/platform.js'` |
| `'../../src/core/constants.js'` | `'../core/constants.js'` |

**`src/tui/TUIFormatter.js`** -- 0 rewrites (zero imports).

#### Create `src/tui/index.js` barrel

```javascript
/**
 * TUI Module -- 3D terminal window components backed by CodeGrid.
 */

export { default as TUIWindow } from './TUIWindow.js';
export { default as TUIWindowManager } from './TUIWindowManager.js';
export { default as TUIFocusManager } from './TUIFocusManager.js';
export { box, table, kvLines, pad, truncate } from './TUIFormatter.js';
```

Note: TUIFormatter uses named exports (`box`, `table`, `kvLines`, `pad`, `truncate`), not a default export. The barrel re-exports the named exports.

### B. Promote `encoding.js` to `src/utils/`

```bash
git mv app/websocket/commands/encoding.js  src/utils/encoding.js
```

No internal import changes needed (the file has zero imports).

#### Add to `src/utils/index.js`

Add at the end of the existing exports:

```javascript
// Re-export from encoding
export { encodeBase64, decodeBase64 } from './encoding.js';
```

### C. Promote `MinimapOverlay.js` to `src/components/`

```bash
mkdir -p src/components

git mv app/components/MinimapOverlay.js    src/components/MinimapOverlay.js
```

No internal import changes needed (the file has zero imports).

### D. Rename `websocket/` to `commands/` with `handlers/` subdirectory

```bash
# Rename the command files subdirectory first
git mv app/websocket/commands  app/websocket/handlers

# Rename websocket/ to commands/
git mv app/websocket           app/commands
```

After these renames, the structure is:
```
app/commands/
  index.js                     (was websocket/index.js)
  handlers/                    (was websocket/commands/)
    index.js
    ...all 20 command files...
```

### E. Update imports in `app/` files that referenced promoted or renamed modules

#### `app/GitHubRepoViewer.js` -- 1 rewrite

| Old path | New path |
|----------|----------|
| `'./websocket/index.js'` | `'./commands/index.js'` |

The MinimapOverlay import changes:

| Old path | New path |
|----------|----------|
| `'./components/MinimapOverlay.js'` | `'../src/components/MinimapOverlay.js'` |

#### `app/commands/index.js` (was `app/websocket/index.js`) -- 1 rewrite

| Old path | New path |
|----------|----------|
| `'./commands/index.js'` | `'./handlers/index.js'` |

The `../../src/` imports are already correct from Commit 1 -- they do not change.

#### `app/commands/handlers/windowCommands.js` -- 2 rewrites

| Old path | New path |
|----------|----------|
| `'../TUIWindowManager.js'` | `'../../../src/tui/TUIWindowManager.js'` |
| `'./encoding.js'` | `'../../../src/utils/encoding.js'` |

#### `app/commands/handlers/annotationCommands.js` -- 2 rewrites

| Old path | New path |
|----------|----------|
| `'../TUIFormatter.js'` | `'../../../src/tui/TUIFormatter.js'` |
| `'./encoding.js'` | `'../../../src/utils/encoding.js'` |

#### `app/commands/handlers/gridCommands.js` -- 2 rewrites

| Old path | New path |
|----------|----------|
| `'../TUIFormatter.js'` | `'../../../src/tui/TUIFormatter.js'` |
| `'./encoding.js'` | `'../../../src/utils/encoding.js'` |

#### `app/commands/handlers/navigationCommands.js` -- 2 rewrites

| Old path | New path |
|----------|----------|
| `'../TUIFormatter.js'` | `'../../../src/tui/TUIFormatter.js'` |
| `'./encoding.js'` | `'../../../src/utils/encoding.js'` |

#### `app/commands/handlers/terminalCommands.js` -- 1 rewrite

| Old path | New path |
|----------|----------|
| `'./encoding.js'` | `'../../../src/utils/encoding.js'` |

Note: this file does NOT import TUIFormatter (verified).

#### `app/commands/handlers/systemCommands.js` -- 1 rewrite

| Old path | New path |
|----------|----------|
| `'../TUIFormatter.js'` | `'../../../src/tui/TUIFormatter.js'` |

#### `app/commands/handlers/cameraCommands.js` -- 1 rewrite

| Old path | New path |
|----------|----------|
| `'../TUIFormatter.js'` | `'../../../src/tui/TUIFormatter.js'` |

#### `app/commands/handlers/selectCommands.js` -- 1 rewrite

| Old path | New path |
|----------|----------|
| `'../TUIFormatter.js'` | `'../../../src/tui/TUIFormatter.js'` |

#### `app/commands/handlers/searchCommands.js` -- 1 rewrite

| Old path | New path |
|----------|----------|
| `'../TUIFormatter.js'` | `'../../../src/tui/TUIFormatter.js'` |

#### `app/commands/handlers/sceneCommands.js` -- 1 rewrite

| Old path | New path |
|----------|----------|
| `'../TUIFormatter.js'` | `'../../../src/tui/TUIFormatter.js'` |

#### `app/commands/handlers/registryCommands.js` -- 1 rewrite

| Old path | New path |
|----------|----------|
| `'../TUIFormatter.js'` | `'../../../src/tui/TUIFormatter.js'` |

#### `app/commands/handlers/layoutCommands.js` -- 1 rewrite

| Old path | New path |
|----------|----------|
| `'../TUIFormatter.js'` | `'../../../src/tui/TUIFormatter.js'` |

#### `app/commands/handlers/agentLayoutCommands.js` -- 1 rewrite

| Old path | New path |
|----------|----------|
| `'../TUIFormatter.js'` | `'../../../src/tui/TUIFormatter.js'` |

#### `app/commands/handlers/spatialCommands.js` -- 1 rewrite

| Old path | New path |
|----------|----------|
| `'../TUIFormatter.js'` | `'../../../src/tui/TUIFormatter.js'` |

#### `app/components/CommandBar.js` -- 1 rewrite

| Old path | New path |
|----------|----------|
| `'../websocket/commands/encoding.js'` | `'../../src/utils/encoding.js'` |

#### Summary of handler files that need the TUIFormatter rewrite

All 13 files that import `from '../TUIFormatter.js'` need the same change to `from '../../../src/tui/TUIFormatter.js'`:

1. `agentLayoutCommands.js`
2. `annotationCommands.js`
3. `cameraCommands.js`
4. `gridCommands.js`
5. `layoutCommands.js`
6. `navigationCommands.js`
7. `registryCommands.js`
8. `sceneCommands.js`
9. `searchCommands.js`
10. `selectCommands.js`
11. `spatialCommands.js`
12. `systemCommands.js`
13. `windowCommands.js` (imports `'../TUIWindowManager.js'`, not TUIFormatter -- but windowCommands also needs TUIWindowManager rewrite)

All 5 files that import `from './encoding.js'` need the same change to `from '../../../src/utils/encoding.js'`:

1. `annotationCommands.js`
2. `gridCommands.js`
3. `navigationCommands.js`
4. `terminalCommands.js`
5. `windowCommands.js`

#### Files with ZERO Commit 2 changes

- `app/commands/handlers/colorConstants.js` -- no external imports
- `app/commands/handlers/gridVisualState.js` -- imports only `./` siblings
- `app/commands/handlers/spatialHelpers.js` -- imports only `'three'` (bare specifier)
- `app/commands/handlers/compositionCommands.js` -- imports only `./spatialHelpers.js` (unchanged)
- `app/commands/handlers/orchestrationCommands.js` -- imports only `./spatialHelpers.js` (unchanged)
- `app/IDEShell.js` -- no websocket/ imports
- `app/StatePersistence.js` -- no imports
- All `app/cli/*.mjs` -- no src/ imports
- `app/ide.html` -- no changes needed (paths to `./IDEShell.js` and `./components/CommandBar.js` unchanged; the `./GitHubRepoViewer.js` and `./components/Drawer.js` unchanged)

**Commit 2 total: ~28 import rewrites across ~18 files, plus 3 new files (`src/tui/index.js`, creation of `src/components/` directory, barrel update to `src/utils/index.js`).**

### F. Package.json exports update

Add to the `"exports"` map:

```json
"./tui": "./src/tui/index.js"
```

### G. Package.json scripts update

Update the `scripts` section:

| Old | New |
|-----|-----|
| `"ws": "node examples/github-viewer/ws-relay.mjs"` | `"ws": "node app/ws-relay.mjs"` |
| `"ws:py": "python3 examples/github-viewer/ws-relay.py"` | `"ws:py": "python3 app/ws-relay.py"` |
| `"relay": "node examples/github-viewer/ws-relay.mjs"` | `"relay": "node app/ws-relay.mjs"` |
| `"cli": "node examples/github-viewer/cli/glyph-cli.mjs"` | `"cli": "node app/cli/glyph-cli.mjs"` |

Also update `"files"` array:

```json
"files": [
  "src",
  "app",
  "examples"
]
```

### Commit 2 validation

```bash
# 1. No app/ files import from app/websocket/ (directory no longer exists)
grep -rn "websocket" app/ --include="*.js"
# Expected: zero results (or only in comments/strings, not import paths)

# 2. TUI files in src/tui/ resolve their imports
grep -oP "from '([^']+)'" src/tui/*.js | while read line; do echo "$line"; done
# Manually verify each path resolves

# 3. No encoding.js left in app/
find app/ -name "encoding.js"
# Expected: zero results

# 4. No MinimapOverlay left in app/
find app/ -name "MinimapOverlay.js"
# Expected: zero results

# 5. Browser test: same as Commit 1 validation
```

---

## Deferred

These items were discussed in the cross-ref but are explicitly NOT part of this extraction:

1. **TouchController promotion** -- deferred until `CameraController._applyDragTranslation` is made public or replaced with a `pan(dx, dy)` API.

2. **spatialHelpers.js split and partial promotion** -- the pure math functions (`box3ToAABB`, `getWorldBounds`, `zDistanceForFit`, `resolveAnchor`) could go to `src/utils/spatialMath.js`, but the file also contains app-coupled functions (`resolveGridByIdOrIndex`, `frameBounds`, `animateCamera`). Splitting is a separate task.

3. **colorConstants.js promotion** -- migration-mechanics noted it could be useful to TUI consumers. Not critical. Deferred.

4. **Lightweight `examples/github-viewer/` demo** -- after extraction, the old `examples/github-viewer/` directory is empty. A genuine minimal demo (30 lines showing CodeGrid usage) could be created later. Not part of this PR.

5. **`src/index.js` barrel update for TUI exports** -- the main barrel (`src/index.js`) does not need to re-export TUI. Consumers use `import { ... } from 'glyph3d-js/tui'` via the package.json exports map. A re-export from the main barrel is optional and deferred.

---

## Post-Migration Cleanup

These tasks happen in the same PR, either in Commit 2 or a cleanup Commit 3:

### CLAUDE.md update

Update the "Project Structure" section to reflect:
- New `app/` directory and its contents
- New `src/tui/` directory
- New `src/components/` directory
- New `src/utils/encoding.js`
- Removal of `examples/github-viewer/` and `examples/ide/`

Update the "Development Commands" section:
- `http://localhost:8000/app/ide.html` replaces `http://localhost:8000/examples/ide/`
- `http://localhost:8000/app/viewer.html` replaces `http://localhost:8000/examples/github-viewer/`

Update the "Common Tasks" section if it references example paths.

### Root `index.html` update

Update the two cards that link to the moved directories:

| Old href | New href |
|----------|----------|
| `"examples/ide/"` | `"app/ide.html"` |
| `"examples/github-viewer/"` | `"app/viewer.html"` |

### `examples/` cleanup

```bash
# Remove emptied directories
rm -rf examples/github-viewer/
rm -rf examples/ide/
```

Remaining `examples/` contents are untouched: `word-wall/`, `code-spectrometer/`, `mod-layer-visualizer/`, `hand-tracking/`, `cross-ref-viz/`, `render-test/`.

### `.gitignore` update

Add if not present:
```
__pycache__/
```

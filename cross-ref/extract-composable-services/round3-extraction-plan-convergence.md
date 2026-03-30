# Round 3 Convergence: Extraction Plan

**Agent:** extraction-plan
**Inputs:** All three Round 2 outputs + verified filesystem inventory

---

## Settled

These points have full consensus across all three agents after two rounds of review. No further debate is needed.

### 1. Extraction order follows dependency depth, not architectural layers

Zero-dep services first, single-dep next, multi-dep after, orchestration last. My original commands-first order was wrong and I retracted it in Round 2. All three agents converged independently.

### 2. SceneContext stays, moves to `src/services/context/`

Not under `camera/`. Not decomposed into per-constructor params. Kept as a thin reference bag (43 lines, zero behavior). Each consuming service documents which fields it reads via JSDoc `@param`. The mutable late-bound fields (`hierarchicalManager`, `layoutManager`) become composition-root concerns, not SceneContext properties.

### 3. SceneRegistry extracts to `src/services/`

Zero WebSocket coupling, zero DOM coupling. Central scene-object truth store. All three agents flagged it independently.

### 4. Event pattern: services own `on()`/`off()`, composition root bridges to DOM

No `CustomEvent` inside services. SelectionManager is the reference implementation. CameraController's `window.dispatchEvent(new CustomEvent('camera-focus-changed'))` becomes a callback the composition root subscribes to.

### 5. CameraController rename to avoid name collision

The viewer's `CameraController.js` (597 lines, translation-first, SceneContext-based) will be renamed when extracted to `src/services/`. The existing `src/camera/CameraController.js` (physics-based, rotation-first) keeps its name. Service-boundaries proposed `NavigationController`; composition-pattern proposed `ViewerCameraController`. This plan uses **`ViewerCameraController`** -- it is descriptive and avoids confusion about what "navigation" means in a 3D context.

### 6. CameraController needs `bindUI()` split

The 6+ `document.getElementById()` calls are app-specific wiring. Core camera logic (WASD, drag, scroll, focus, physics) is ~400 lines of clean reusable code. DOM bindings are ~100 lines that become an optional `bindUI(elements)` method or a separate composition-root concern.

### 7. `window.viewer = api` belongs in example code

`initCommandCenter()` at `websocket/index.js:156` sets this global. The extracted version returns the API; the caller assigns globally if desired.

### 8. TUI system stays in examples

TUIWindow, TUIWindowManager, TUIFocusManager, TUIFormatter (4 files, 1131 lines total). No agent disputes deferral.

### 9. StatePersistence stays in examples

Deep DOM coupling (`document.getElementById` x5, `window.location.reload()`). Not worth the refactoring cost for this extraction. All three agents agree to defer.

### 10. `dispose()` is the canonical cleanup method name

Not `destroy()`. Applied consistently to all extracted services.

### 11. THREE.js: bare `import * as THREE from 'three'`

Composition-pattern's argument won. Three.js is a declared peer dependency. Every consumer already has it available. Constructor-DI for THREE adds ceremony without benefit. BackdropManager, NameplateManager, and spatialHelpers already use the bare import -- they are correct, not outliers. Services that currently receive THREE via `ctx.THREE` will continue to work via SceneContext; no change needed for this extraction.

### 12. Command modules stay in examples (for now)

Two of three agents (service-boundaries, composition-pattern) classify them as EXAMPLE. The 21 command files depend on a `context` bag with ~20 properties whose shape is defined ad-hoc in `buildContext()`. Extracting them makes that shape a public API contract, which is premature. They stay at `examples/github-viewer/websocket/commands/`. Their imports of sibling files (TUIFormatter, spatialHelpers, encoding, colorConstants, gridVisualState) remain internal to that directory. The commands that import from `../../../../src/collections/CodeGrid.js` (3 files) and `TerminalGrid.js` (1 file) will update their import paths after services extraction since the relative path to `src/` does not change.

**Evidence for keeping commands in examples:**
- 12 of 21 command files import from TUIFormatter (which is deferred)
- 1 command file imports from TUIWindowManager (which is deferred)
- The context bag contract (`buildContext()`) is not yet designed as a public interface
- Total 4,123 lines of code tightly coupled to viewer-specific orchestration

---

## Implementation Plan

### File inventory: 23 files to extract

The following files move from `examples/github-viewer/` to `src/services/`. Verified against the filesystem -- every source path exists.

#### Phase 1: Zero-dep services (5 files)

| # | Source | Destination |
|---|--------|-------------|
| 1 | `examples/github-viewer/FileStateManager.js` | `src/services/FileStateManager.js` |
| 2 | `examples/github-viewer/DiffParser.js` | `src/services/DiffParser.js` |
| 3 | `examples/github-viewer/RepositoryContentCache.js` | `src/services/RepositoryContentCache.js` |
| 4 | `examples/github-viewer/platform.js` | `src/services/platform.js` |
| 5 | `examples/github-viewer/websocket/SceneRegistry.js` | `src/services/SceneRegistry.js` |

**Dependencies:** None of these files import from other github-viewer files. FileStateManager, DiffParser, RepositoryContentCache, platform.js, and SceneRegistry are all self-contained.

**Imports within these files that reference `../../src/`:** None.

**External consumers that must update imports:**
- `FileStateManager.js`: imported by `GitHubRepoViewer.js`
- `DiffParser.js`: imported by `DiffController.js`
- `RepositoryContentCache.js`: imported by `RepositoryAdapter.js`
- `platform.js`: imported by `ShortcutManager.js`, `CameraController.js`, IDE example (`CommandBar.js`, `IDEShell.js`)
- `SceneRegistry.js`: imported by `GitHubRepoViewer.js`

#### Phase 2: Infrastructure context (1 file)

| # | Source | Destination |
|---|--------|-------------|
| 6 | `examples/github-viewer/SceneContext.js` | `src/services/context/SceneContext.js` |

**Dependencies:** None (pure data class).

**External consumers:** `GitHubRepoViewer.js`

#### Phase 3: Visual services (3 files)

| # | Source | Destination |
|---|--------|-------------|
| 7 | `examples/github-viewer/BackdropManager.js` | `src/services/visual/BackdropManager.js` |
| 8 | `examples/github-viewer/NameplateManager.js` | `src/services/visual/NameplateManager.js` |
| 9 | `examples/github-viewer/TreemapLabelManager.js` | `src/services/visual/TreemapLabelManager.js` |

**Dependencies:**
- BackdropManager: `import * as THREE from 'three'` (stays as-is)
- NameplateManager: `import * as THREE from 'three'`, `import { CodeGrid } from '../../src/index.js'`
- TreemapLabelManager: `import { GlyphCollection } from '../../src/index.js'`

**Import rewrites within moved files:**
- NameplateManager: `'../../src/index.js'` becomes `'../../index.js'` (from `src/services/visual/` up to `src/`)
- TreemapLabelManager: `'../../src/index.js'` becomes `'../../index.js'`

**External consumers:** `GitHubRepoViewer.js` for all three.

#### Phase 4: Core services (4 files)

| # | Source | Destination |
|---|--------|-------------|
| 10 | `examples/github-viewer/CodeColorManager.js` | `src/services/CodeColorManager.js` |
| 11 | `examples/github-viewer/SelectionManager.js` | `src/services/SelectionManager.js` |
| 12 | `examples/github-viewer/ShortcutManager.js` | `src/services/ShortcutManager.js` |
| 13 | `examples/github-viewer/providers/HeatmapProvider.js` | `src/services/HeatmapProvider.js` |

**Dependencies:**
- CodeColorManager: zero imports
- SelectionManager: zero imports
- ShortcutManager: `import { isMac } from './platform.js'` -- will need update
- HeatmapProvider: zero imports

**Import rewrites within moved files:**
- ShortcutManager: `'./platform.js'` becomes `'./platform.js'` (same directory after move -- both land in `src/services/`)

**External consumers:** `GitHubRepoViewer.js` for all four.

#### Phase 5: Camera (2 files)

| # | Source | Destination |
|---|--------|-------------|
| 14 | `examples/github-viewer/CameraController.js` | `src/services/camera/ViewerCameraController.js` |
| 15 | `examples/github-viewer/HandGestureAdapter.js` | `src/services/camera/HandGestureAdapter.js` |

**Dependencies:**
- CameraController: `import { primaryMod, secondaryMod } from './platform.js'`
- HandGestureAdapter: `import HandRenderer from '../../src/hand/HandRenderer.js'`, `import GestureDetector from '../../src/hand/GestureDetector.js'`, `import MockHandSource from '../../src/hand/MockHandSource.js'`, `import { Joint, landmarkDistance } from '../../src/hand/HandData.js'`, dynamic `import('../../src/hand/WebSocketHandSource.js')`

**Import rewrites within moved files:**
- ViewerCameraController: `'./platform.js'` becomes `'../platform.js'` (from `src/services/camera/` up to `src/services/`)
- HandGestureAdapter: `'../../src/hand/HandRenderer.js'` becomes `'../../hand/HandRenderer.js'` (from `src/services/camera/` up to `src/`)
- HandGestureAdapter: same pattern for GestureDetector, MockHandSource, HandData, WebSocketHandSource

**Rename note:** The file is renamed from `CameraController.js` to `ViewerCameraController.js`. The class name `CameraController` inside the file must also be renamed to `ViewerCameraController`, and the `export class CameraController` / `export default CameraController` must update accordingly. All importers must update their import name.

**External consumers:** `GitHubRepoViewer.js` for both.

#### Phase 6: Data adapters (2 files)

| # | Source | Destination |
|---|--------|-------------|
| 16 | `examples/github-viewer/GitHubRepositorySource.js` | `src/services/data/GitHubRepositorySource.js` |
| 17 | `examples/github-viewer/RepositoryAdapter.js` | `src/services/data/RepositoryAdapter.js` |

**Dependencies:**
- GitHubRepositorySource: zero imports
- RepositoryAdapter: `import GitHubRepositorySource, { GitHubError, RateLimitError } from './GitHubRepositorySource.js'`, `import RepositoryContentCache from './RepositoryContentCache.js'`

**Import rewrites within moved files:**
- RepositoryAdapter: `'./GitHubRepositorySource.js'` stays `'./GitHubRepositorySource.js'` (same directory)
- RepositoryAdapter: `'./RepositoryContentCache.js'` becomes `'../RepositoryContentCache.js'` (from `src/services/data/` up to `src/services/`)

**External consumers:** `GitHubRepoViewer.js` for both. `RepositoryAdapter.js` also imported by `websocket/index.js` indirectly via the context bag.

#### Phase 7: Integration services (3 files)

| # | Source | Destination |
|---|--------|-------------|
| 18 | `examples/github-viewer/DiffController.js` | `src/services/DiffController.js` |
| 19 | `examples/github-viewer/websocket/CommandRouter.js` | `src/services/command/CommandRouter.js` |
| 20 | `examples/github-viewer/websocket/ViewerAPI.js` | `src/services/command/ViewerAPI.js` |

**Dependencies:**
- DiffController: `import { CodeGrid, GridLayoutManager } from '../../src/index.js'`, `import { buildAlignedDiff, parsePatchAligned, getDiffColor } from './DiffParser.js'`
- CommandRouter: zero imports
- ViewerAPI: zero imports

**Import rewrites within moved files:**
- DiffController: `'../../src/index.js'` becomes `'../index.js'` (from `src/services/` up to `src/`)
- DiffController: `'./DiffParser.js'` stays `'./DiffParser.js'` (same directory)

**External consumers:** `GitHubRepoViewer.js` for DiffController. `websocket/index.js` for CommandRouter and ViewerAPI.

#### Phase 8: WebSocket bridge (1 file)

| # | Source | Destination |
|---|--------|-------------|
| 21 | `examples/github-viewer/websocket/WebSocketBridge.js` | `src/services/command/WebSocketBridge.js` |

**Dependencies:** Zero imports (fully self-contained).

**Refactoring required:** `_createStatusBar()` DOM creation must become an optional `onStatusChange` callback. Default `showStatus: false`.

**External consumers:** `websocket/index.js`

#### Phase 9: Composition wiring (2 files -- NEW, not moved)

| # | File | Purpose |
|---|------|---------|
| 22 | `src/services/index.js` | Barrel export for all services |
| 23 | `examples/github-viewer/websocket/index.js` | Stays in place but updates imports |

---

### Concrete git mv commands by phase

```bash
# ── Phase 1: Zero-dep services ──────────────────────────────────
mkdir -p src/services

git mv examples/github-viewer/FileStateManager.js       src/services/FileStateManager.js
git mv examples/github-viewer/DiffParser.js              src/services/DiffParser.js
git mv examples/github-viewer/RepositoryContentCache.js  src/services/RepositoryContentCache.js
git mv examples/github-viewer/platform.js                src/services/platform.js
git mv examples/github-viewer/websocket/SceneRegistry.js src/services/SceneRegistry.js

# ── Phase 2: Infrastructure context ─────────────────────────────
mkdir -p src/services/context

git mv examples/github-viewer/SceneContext.js             src/services/context/SceneContext.js

# ── Phase 3: Visual services ────────────────────────────────────
mkdir -p src/services/visual

git mv examples/github-viewer/BackdropManager.js          src/services/visual/BackdropManager.js
git mv examples/github-viewer/NameplateManager.js         src/services/visual/NameplateManager.js
git mv examples/github-viewer/TreemapLabelManager.js      src/services/visual/TreemapLabelManager.js

# ── Phase 4: Core services ──────────────────────────────────────

git mv examples/github-viewer/CodeColorManager.js         src/services/CodeColorManager.js
git mv examples/github-viewer/SelectionManager.js         src/services/SelectionManager.js
git mv examples/github-viewer/ShortcutManager.js          src/services/ShortcutManager.js
git mv examples/github-viewer/providers/HeatmapProvider.js src/services/HeatmapProvider.js

# ── Phase 5: Camera ─────────────────────────────────────────────
mkdir -p src/services/camera

# NOTE: This is a rename, not just a move
git mv examples/github-viewer/CameraController.js         src/services/camera/ViewerCameraController.js
git mv examples/github-viewer/HandGestureAdapter.js        src/services/camera/HandGestureAdapter.js

# ── Phase 6: Data adapters ──────────────────────────────────────
mkdir -p src/services/data

git mv examples/github-viewer/GitHubRepositorySource.js    src/services/data/GitHubRepositorySource.js
git mv examples/github-viewer/RepositoryAdapter.js         src/services/data/RepositoryAdapter.js

# ── Phase 7: Integration services ───────────────────────────────
mkdir -p src/services/command

git mv examples/github-viewer/DiffController.js            src/services/DiffController.js
git mv examples/github-viewer/websocket/CommandRouter.js   src/services/command/CommandRouter.js
git mv examples/github-viewer/websocket/ViewerAPI.js       src/services/command/ViewerAPI.js

# ── Phase 8: WebSocket bridge ───────────────────────────────────

git mv examples/github-viewer/websocket/WebSocketBridge.js src/services/command/WebSocketBridge.js
```

Total: **21 git mv operations** across 8 phases, creating 5 new directories.

---

### Import rewrite table

Every import statement that must change, organized by the file containing the import.

#### Files being moved (internal import rewrites)

| File (new location) | Old import path | New import path |
|---|---|---|
| `src/services/visual/NameplateManager.js` | `'../../src/index.js'` | `'../../index.js'` |
| `src/services/visual/TreemapLabelManager.js` | `'../../src/index.js'` | `'../../index.js'` |
| `src/services/ShortcutManager.js` | `'./platform.js'` | `'./platform.js'` (no change -- same dir) |
| `src/services/camera/ViewerCameraController.js` | `'./platform.js'` | `'../platform.js'` |
| `src/services/camera/HandGestureAdapter.js` | `'../../src/hand/HandRenderer.js'` | `'../../hand/HandRenderer.js'` |
| `src/services/camera/HandGestureAdapter.js` | `'../../src/hand/GestureDetector.js'` | `'../../hand/GestureDetector.js'` |
| `src/services/camera/HandGestureAdapter.js` | `'../../src/hand/MockHandSource.js'` | `'../../hand/MockHandSource.js'` |
| `src/services/camera/HandGestureAdapter.js` | `'../../src/hand/HandData.js'` | `'../../hand/HandData.js'` |
| `src/services/camera/HandGestureAdapter.js` | `'../../src/hand/WebSocketHandSource.js'` (dynamic) | `'../../hand/WebSocketHandSource.js'` |
| `src/services/data/RepositoryAdapter.js` | `'./RepositoryContentCache.js'` | `'../RepositoryContentCache.js'` |
| `src/services/data/RepositoryAdapter.js` | `'./GitHubRepositorySource.js'` | `'./GitHubRepositorySource.js'` (no change) |
| `src/services/DiffController.js` | `'../../src/index.js'` | `'../index.js'` |
| `src/services/DiffController.js` | `'./DiffParser.js'` | `'./DiffParser.js'` (no change) |

#### Files staying in examples (consumer import rewrites)

| File | Old import | New import |
|---|---|---|
| `examples/github-viewer/GitHubRepoViewer.js` | `'./FileStateManager.js'` | `'../../src/services/FileStateManager.js'` |
| `examples/github-viewer/GitHubRepoViewer.js` | `'./SceneContext.js'` | `'../../src/services/context/SceneContext.js'` |
| `examples/github-viewer/GitHubRepoViewer.js` | `'./BackdropManager.js'` | `'../../src/services/visual/BackdropManager.js'` |
| `examples/github-viewer/GitHubRepoViewer.js` | `'./NameplateManager.js'` | `'../../src/services/visual/NameplateManager.js'` |
| `examples/github-viewer/GitHubRepoViewer.js` | `'./TreemapLabelManager.js'` | `'../../src/services/visual/TreemapLabelManager.js'` |
| `examples/github-viewer/GitHubRepoViewer.js` | `'./SelectionManager.js'` | `'../../src/services/SelectionManager.js'` |
| `examples/github-viewer/GitHubRepoViewer.js` | `'./ShortcutManager.js'` | `'../../src/services/ShortcutManager.js'` |
| `examples/github-viewer/GitHubRepoViewer.js` | `'./RepositoryAdapter.js'` | `'../../src/services/data/RepositoryAdapter.js'` |
| `examples/github-viewer/GitHubRepoViewer.js` | `'./GitHubRepositorySource.js'` | `'../../src/services/data/GitHubRepositorySource.js'` |
| `examples/github-viewer/GitHubRepoViewer.js` | `'./DiffController.js'` | `'../../src/services/DiffController.js'` |
| `examples/github-viewer/GitHubRepoViewer.js` | `'./CameraController.js'` | `'../../src/services/camera/ViewerCameraController.js'` |
| `examples/github-viewer/GitHubRepoViewer.js` | `'./CodeColorManager.js'` | `'../../src/services/CodeColorManager.js'` |
| `examples/github-viewer/GitHubRepoViewer.js` | `{ HeatmapProvider } from './providers/HeatmapProvider.js'` | `'../../src/services/HeatmapProvider.js'` |
| `examples/github-viewer/GitHubRepoViewer.js` | `'./HandGestureAdapter.js'` | `'../../src/services/camera/HandGestureAdapter.js'` |
| `examples/github-viewer/GitHubRepoViewer.js` | `SceneRegistry from './websocket/SceneRegistry.js'` | `'../../src/services/SceneRegistry.js'` |
| `examples/github-viewer/websocket/index.js` | `'./CommandRouter.js'` | `'../../../src/services/command/CommandRouter.js'` |
| `examples/github-viewer/websocket/index.js` | `'./WebSocketBridge.js'` | `'../../../src/services/command/WebSocketBridge.js'` |
| `examples/github-viewer/websocket/index.js` | `'./ViewerAPI.js'` | `'../../../src/services/command/ViewerAPI.js'` |
| `examples/ide/components/CommandBar.js` | `'../../github-viewer/platform.js'` | `'../../../src/services/platform.js'` |
| `examples/ide/IDEShell.js` | `'../github-viewer/platform.js'` | `'../../src/services/platform.js'` |
| `examples/ide/components/CommandBar.js` | `'../../github-viewer/websocket/commands/encoding.js'` | (no change -- encoding.js stays in examples) |

**CameraController class rename** (in addition to file move):
| File | Old reference | New reference |
|---|---|---|
| `src/services/camera/ViewerCameraController.js` | `export class CameraController` | `export class ViewerCameraController` |
| `src/services/camera/ViewerCameraController.js` | `export default CameraController` | `export default ViewerCameraController` |
| `examples/github-viewer/GitHubRepoViewer.js` | `{ CameraController }` | `{ ViewerCameraController }` |
| All references to `CameraController` in GitHubRepoViewer.js | `CameraController` | `ViewerCameraController` |

---

### package.json exports map (final version)

```json
{
  "exports": {
    ".": "./src/index.js",
    "./collections": "./src/collections/index.js",
    "./workers": "./src/workers/WorkerBridge.js",
    "./utils": "./src/utils/index.js",
    "./hand": "./src/hand/index.js",
    "./services": "./src/services/index.js",
    "./services/visual": "./src/services/visual/BackdropManager.js",
    "./services/camera": "./src/services/camera/ViewerCameraController.js",
    "./services/data": "./src/services/data/GitHubRepositorySource.js",
    "./services/command": "./src/services/command/CommandRouter.js",
    "./services/context": "./src/services/context/SceneContext.js"
  }
}
```

Note: The sub-path exports (`./services/visual`, `./services/camera`, etc.) point to the primary file in each subdirectory. For full flexibility, each subdirectory should have its own barrel index.js. But the top-level `./services` barrel is the primary entry point consumers will use.

---

### src/services/index.js barrel export

```javascript
/**
 * Composable Services - Reusable viewer infrastructure extracted from github-viewer
 *
 * These services follow constructor DI for application-specific dependencies
 * (SceneContext, callbacks) and bare imports for peer dependencies (three.js).
 *
 * @license MIT
 */

// Zero-dep services
export { FileStateManager } from './FileStateManager.js';
export { parsePatchAligned, buildAlignedDiff, getDiffColor } from './DiffParser.js';
export { default as RepositoryContentCache } from './RepositoryContentCache.js';
export { isMac, isLinux, primaryMod, secondaryMod } from './platform.js';
export { default as SceneRegistry } from './SceneRegistry.js';

// Infrastructure context
export { SceneContext } from './context/SceneContext.js';

// Visual services
export { BackdropManager } from './visual/BackdropManager.js';
export { NameplateManager } from './visual/NameplateManager.js';
export { TreemapLabelManager } from './visual/TreemapLabelManager.js';

// Core services
export { CodeColorManager } from './CodeColorManager.js';
export { SelectionManager } from './SelectionManager.js';
export { ShortcutManager } from './ShortcutManager.js';
export { HeatmapProvider } from './HeatmapProvider.js';

// Camera
export { ViewerCameraController } from './camera/ViewerCameraController.js';
export { HandGestureAdapter } from './camera/HandGestureAdapter.js';

// Data adapters
export { GitHubRepositorySource, GitHubError, RateLimitError } from './data/GitHubRepositorySource.js';
export { RepositoryAdapter } from './data/RepositoryAdapter.js';

// Integration
export { DiffController } from './DiffController.js';
export { default as CommandRouter } from './command/CommandRouter.js';
export { default as ViewerAPI } from './command/ViewerAPI.js';
export { default as WebSocketBridge } from './command/WebSocketBridge.js';
```

---

### Phase-by-phase execution with validation steps

#### Pre-flight

1. Ensure clean working tree: `git status` shows no uncommitted changes.
2. Verify the HTTP server can serve the github-viewer example: `npm run serve`, open `http://localhost:8000/examples/github-viewer/`, confirm it loads a repo.
3. Record this as the baseline behavior to validate against after each phase.

#### Phase 1: Zero-dep services

**Execute:**
```bash
mkdir -p src/services
git mv examples/github-viewer/FileStateManager.js       src/services/FileStateManager.js
git mv examples/github-viewer/DiffParser.js              src/services/DiffParser.js
git mv examples/github-viewer/RepositoryContentCache.js  src/services/RepositoryContentCache.js
git mv examples/github-viewer/platform.js                src/services/platform.js
git mv examples/github-viewer/websocket/SceneRegistry.js src/services/SceneRegistry.js
```

**Import rewrites (5 files that must update their imports):**
1. `examples/github-viewer/GitHubRepoViewer.js`: Update `'./FileStateManager.js'` to `'../../src/services/FileStateManager.js'`
2. `examples/github-viewer/GitHubRepoViewer.js`: Update `SceneRegistry from './websocket/SceneRegistry.js'` to `'../../src/services/SceneRegistry.js'`
3. `examples/github-viewer/ShortcutManager.js`: Update `'./platform.js'` to `'../../src/services/platform.js'` (ShortcutManager has not moved yet -- it is still in examples)
4. `examples/github-viewer/CameraController.js`: Update `'./platform.js'` to `'../../src/services/platform.js'` (CameraController has not moved yet)
5. `examples/github-viewer/RepositoryAdapter.js`: Update `'./RepositoryContentCache.js'` to `'../../src/services/RepositoryContentCache.js'` (RepositoryAdapter has not moved yet)
6. `examples/github-viewer/DiffController.js`: Update `'./DiffParser.js'` to `'../../src/services/DiffParser.js'` (DiffController has not moved yet)
7. `examples/ide/components/CommandBar.js`: Update `'../../github-viewer/platform.js'` to `'../../../src/services/platform.js'`
8. `examples/ide/IDEShell.js`: Update `'../github-viewer/platform.js'` to `'../../src/services/platform.js'`

**Validate:**
- `git diff --stat` confirms only the expected files are changed.
- Start HTTP server, load github-viewer example in browser, confirm no import errors in the console.
- Commit: `git commit -m "Phase 1: Extract zero-dep services to src/services/"`

#### Phase 2: Infrastructure context

**Execute:**
```bash
mkdir -p src/services/context
git mv examples/github-viewer/SceneContext.js src/services/context/SceneContext.js
```

**Import rewrites:**
1. `examples/github-viewer/GitHubRepoViewer.js`: Update `'./SceneContext.js'` to `'../../src/services/context/SceneContext.js'`

**Validate:** Browser test. Commit.

#### Phase 3: Visual services

**Execute:**
```bash
mkdir -p src/services/visual
git mv examples/github-viewer/BackdropManager.js     src/services/visual/BackdropManager.js
git mv examples/github-viewer/NameplateManager.js     src/services/visual/NameplateManager.js
git mv examples/github-viewer/TreemapLabelManager.js  src/services/visual/TreemapLabelManager.js
```

**Import rewrites (within moved files):**
1. `src/services/visual/NameplateManager.js`: Update `'../../src/index.js'` to `'../../index.js'`
2. `src/services/visual/TreemapLabelManager.js`: Update `'../../src/index.js'` to `'../../index.js'`

**Import rewrites (consumers staying in examples):**
3. `examples/github-viewer/GitHubRepoViewer.js`: Update `'./BackdropManager.js'` to `'../../src/services/visual/BackdropManager.js'`
4. `examples/github-viewer/GitHubRepoViewer.js`: Update `'./NameplateManager.js'` to `'../../src/services/visual/NameplateManager.js'`
5. `examples/github-viewer/GitHubRepoViewer.js`: Update `'./TreemapLabelManager.js'` to `'../../src/services/visual/TreemapLabelManager.js'`

**Validate:** Browser test. Commit.

#### Phase 4: Core services

**Execute:**
```bash
git mv examples/github-viewer/CodeColorManager.js          src/services/CodeColorManager.js
git mv examples/github-viewer/SelectionManager.js           src/services/SelectionManager.js
git mv examples/github-viewer/ShortcutManager.js             src/services/ShortcutManager.js
git mv examples/github-viewer/providers/HeatmapProvider.js   src/services/HeatmapProvider.js
```

**Import rewrites (within moved files):**
1. `src/services/ShortcutManager.js`: Update `'../../src/services/platform.js'` to `'./platform.js'` (ShortcutManager was pointing at the Phase 1 location; now it is in the same dir)

Note: ShortcutManager's import was already rewritten in Phase 1 to point at `'../../src/services/platform.js'` (relative from its then-location in `examples/github-viewer/`). After moving to `src/services/`, the correct path is `'./platform.js'`.

**Import rewrites (consumers staying in examples):**
2. `examples/github-viewer/GitHubRepoViewer.js`: Update `'./SelectionManager.js'` to `'../../src/services/SelectionManager.js'`
3. `examples/github-viewer/GitHubRepoViewer.js`: Update `'./ShortcutManager.js'` to `'../../src/services/ShortcutManager.js'`
4. `examples/github-viewer/GitHubRepoViewer.js`: Update `'./CodeColorManager.js'` to `'../../src/services/CodeColorManager.js'`
5. `examples/github-viewer/GitHubRepoViewer.js`: Update `'./providers/HeatmapProvider.js'` to `'../../src/services/HeatmapProvider.js'`

**Validate:** Browser test. Commit.

#### Phase 5: Camera

**Execute:**
```bash
mkdir -p src/services/camera
git mv examples/github-viewer/CameraController.js    src/services/camera/ViewerCameraController.js
git mv examples/github-viewer/HandGestureAdapter.js    src/services/camera/HandGestureAdapter.js
```

**Class rename (inside ViewerCameraController.js):**
- Replace `export class CameraController` with `export class ViewerCameraController`
- Replace `export default CameraController` with `export default ViewerCameraController`
- Any internal `new CameraController` self-references (unlikely but check)

**Import rewrites (within moved files):**
1. `src/services/camera/ViewerCameraController.js`: Update `'../../src/services/platform.js'` to `'../platform.js'` (was rewritten in Phase 1 from examples/ perspective; now from `src/services/camera/`)
2. `src/services/camera/HandGestureAdapter.js`: Update `'../../src/hand/HandRenderer.js'` to `'../../hand/HandRenderer.js'`
3. `src/services/camera/HandGestureAdapter.js`: Update `'../../src/hand/GestureDetector.js'` to `'../../hand/GestureDetector.js'`
4. `src/services/camera/HandGestureAdapter.js`: Update `'../../src/hand/MockHandSource.js'` to `'../../hand/MockHandSource.js'`
5. `src/services/camera/HandGestureAdapter.js`: Update `'../../src/hand/HandData.js'` to `'../../hand/HandData.js'`
6. `src/services/camera/HandGestureAdapter.js`: Update dynamic import `'../../src/hand/WebSocketHandSource.js'` to `'../../hand/WebSocketHandSource.js'`

**Import rewrites (consumers):**
7. `examples/github-viewer/GitHubRepoViewer.js`: Update `{ CameraController } from './CameraController.js'` to `{ ViewerCameraController } from '../../src/services/camera/ViewerCameraController.js'`
8. `examples/github-viewer/GitHubRepoViewer.js`: Update `'./HandGestureAdapter.js'` to `'../../src/services/camera/HandGestureAdapter.js'`
9. `examples/github-viewer/GitHubRepoViewer.js`: All references to `CameraController` (as a class name in instantiation, `new CameraController(...)`) become `ViewerCameraController`

**Validate:** Browser test -- pay special attention to camera controls (WASD, scroll, drag). Commit.

#### Phase 6: Data adapters

**Execute:**
```bash
mkdir -p src/services/data
git mv examples/github-viewer/GitHubRepositorySource.js  src/services/data/GitHubRepositorySource.js
git mv examples/github-viewer/RepositoryAdapter.js        src/services/data/RepositoryAdapter.js
```

**Import rewrites (within moved files):**
1. `src/services/data/RepositoryAdapter.js`: Update `'../../src/services/RepositoryContentCache.js'` to `'../RepositoryContentCache.js'` (was rewritten in Phase 1; now from `src/services/data/` the correct relative path to `src/services/RepositoryContentCache.js`)
2. `src/services/data/RepositoryAdapter.js`: `'./GitHubRepositorySource.js'` stays as-is (same directory)

**Import rewrites (consumers):**
3. `examples/github-viewer/GitHubRepoViewer.js`: Update `'./RepositoryAdapter.js'` to `'../../src/services/data/RepositoryAdapter.js'`
4. `examples/github-viewer/GitHubRepoViewer.js`: Update `'./GitHubRepositorySource.js'` to `'../../src/services/data/GitHubRepositorySource.js'`

**Validate:** Browser test -- load a GitHub repo to exercise the data path. Commit.

#### Phase 7: Integration services

**Execute:**
```bash
mkdir -p src/services/command
git mv examples/github-viewer/DiffController.js           src/services/DiffController.js
git mv examples/github-viewer/websocket/CommandRouter.js   src/services/command/CommandRouter.js
git mv examples/github-viewer/websocket/ViewerAPI.js       src/services/command/ViewerAPI.js
```

**Import rewrites (within moved files):**
1. `src/services/DiffController.js`: Update `'../../src/index.js'` to `'../index.js'` (was `../../src/index.js` from `examples/github-viewer/`; now from `src/services/`)
2. `src/services/DiffController.js`: `'../../src/services/DiffParser.js'` becomes `'./DiffParser.js'` (DiffParser was rewritten in Phase 1; now both are in `src/services/`)

**Import rewrites (consumers):**
3. `examples/github-viewer/GitHubRepoViewer.js`: Update `'./DiffController.js'` to `'../../src/services/DiffController.js'`
4. `examples/github-viewer/websocket/index.js`: Update `'./CommandRouter.js'` to `'../../../src/services/command/CommandRouter.js'`
5. `examples/github-viewer/websocket/index.js`: Update `'./ViewerAPI.js'` to `'../../../src/services/command/ViewerAPI.js'`

**Validate:** Browser test -- check diff functionality, WebSocket command dispatch. Commit.

#### Phase 8: WebSocket bridge

**Execute:**
```bash
git mv examples/github-viewer/websocket/WebSocketBridge.js src/services/command/WebSocketBridge.js
```

**Import rewrites:**
1. `examples/github-viewer/websocket/index.js`: Update `'./WebSocketBridge.js'` to `'../../../src/services/command/WebSocketBridge.js'`

**Validate:** Browser test -- connect WebSocket relay, send commands. Commit.

#### Phase 9: Barrel export and package.json

**Create:** `src/services/index.js` with the barrel export contents shown above.

**Update:** `package.json` exports field with the new entries shown above.

**Update:** `src/index.js` -- add a re-export line:
```javascript
// Composable services (viewer infrastructure)
export * from './services/index.js';
```

Or keep it separate and only expose via `glyph3d-js/services` sub-path. Decision: keep it as a separate sub-path export only. Do NOT re-export from the main `src/index.js` -- these are viewer-specific services, not core rendering primitives. The main entry point stays focused on the rendering library.

**Validate:** Full browser test of all examples (github-viewer, IDE, word-wall). Commit.

---

### What happens to the command modules: stay, with reasoning

The 21 files in `examples/github-viewer/websocket/commands/` **stay in examples**. Here is the complete reasoning:

1. **TUI dependency.** 12 of 21 command files import from `TUIFormatter.js`, which is deferred. 1 imports from `TUIWindowManager.js`, also deferred. Moving commands without TUI creates broken imports or forces extracting TUI prematurely.

2. **Context contract.** Every command module receives a `context` object built by `buildContext()` in `websocket/index.js` (lines 26-119). This bag has ~20 ad-hoc properties including `context.registry`, `context.cameraController`, `context.getGrids()`, `context.scene`, `context.atlas`, `context.annotations`, `context.fileStateManager`, etc. No typed interface exists. Extracting commands to `src/services/` makes this shape a public API contract that consumers must replicate exactly. This is premature.

3. **Library-specific imports.** 3 command files import `CodeGrid` from `../../../../src/collections/CodeGrid.js` and 1 imports `TerminalGrid`. After the extraction, these paths remain valid (they go up from `examples/github-viewer/websocket/commands/` to `src/`). No change needed.

4. **spatialHelpers.js uses `import * as THREE from 'three'`.** This is fine for an example file but would need to be consistent with the service convention if extracted.

5. **Volume.** 4,123 lines across 21 files is a large surface area to stabilize as public API in one extraction.

**Future path:** Define a `CommandContext` JSDoc typedef. Stabilize the interface. Extract command modules in a follow-up that also extracts TUIFormatter (which is a pure-function utility and easy to move).

---

### Files remaining in examples/github-viewer/ after extraction

| File | Reason for staying |
|---|---|
| `GitHubRepoViewer.js` | Application shell, composition root. Never a library service. |
| `StatePersistence.js` | Deep DOM coupling. Deferred. |
| `index.html` | HTML entry point. |
| `styles.css` | CSS. |
| `ws-relay.mjs` | Node.js WebSocket relay server. |
| `ws-relay.py` | Python WebSocket relay server. |
| `components/AppShell.js` | DOM component. |
| `components/DiffPanel.js` | DOM component. |
| `components/Drawer.js` | DOM component. |
| `components/LogCapturePanel.js` | DOM component. |
| `components/MinimapOverlay.js` | DOM component. |
| `components/TouchController.js` | DOM component. |
| `websocket/index.js` | Composition wiring (initCommandCenter). Stays but updates imports. |
| `websocket/commands/` (21 files) | See above -- context contract not yet stable. |
| `websocket/TUIFocusManager.js` | TUI system, deferred. |
| `websocket/TUIFormatter.js` | TUI system, deferred. |
| `websocket/TUIWindow.js` | TUI system, deferred. |
| `websocket/TUIWindowManager.js` | TUI system, deferred. |
| `websocket/BLUETOOTH_NOTES.md` | Documentation. |
| `cli/` (6 files) | CLI tooling, not browser services. |
| `providers/` (empty after HeatmapProvider moves) | Remove empty directory. |

---

### Summary of directory structure after extraction

```
src/services/
├── index.js                          # Barrel export
├── FileStateManager.js               # Zero-dep
├── DiffParser.js                     # Zero-dep
├── RepositoryContentCache.js         # Zero-dep
├── platform.js                       # Zero-dep
├── SceneRegistry.js                  # Zero-dep
├── CodeColorManager.js               # Core
├── SelectionManager.js               # Core
├── ShortcutManager.js                # Core (depends: platform.js)
├── HeatmapProvider.js                # Core
├── DiffController.js                 # Integration (depends: DiffParser, glyph3d-js core)
├── context/
│   └── SceneContext.js               # Infrastructure context bag
├── visual/
│   ├── BackdropManager.js            # Visual (depends: three)
│   ├── NameplateManager.js           # Visual (depends: three, CodeGrid)
│   └── TreemapLabelManager.js        # Visual (depends: GlyphCollection)
├── camera/
│   ├── ViewerCameraController.js     # Camera (depends: platform.js, renamed)
│   └── HandGestureAdapter.js         # Camera (depends: src/hand/*)
├── data/
│   ├── GitHubRepositorySource.js     # Data (zero-dep)
│   └── RepositoryAdapter.js          # Data (depends: GitHubRepositorySource, RepositoryContentCache)
└── command/
    ├── CommandRouter.js              # Command dispatch (zero-dep)
    ├── ViewerAPI.js                  # API facade (zero-dep)
    └── WebSocketBridge.js            # Transport (zero-dep, DOM extraction needed)
```

---

## Implementer Vote

**Ready to implement: YES**, with the following conditions:

1. **Execute phases 1-8 as separate commits.** Each phase should be a single commit with all file moves and import rewrites for that phase. Validate in the browser between each phase. If a phase breaks the example, fix import paths before proceeding.

2. **Phase 5 (camera rename) is the highest-risk phase.** The class rename from `CameraController` to `ViewerCameraController` touches the class definition, both exports, and every reference in `GitHubRepoViewer.js`. Grep the entire codebase for `CameraController` before and after to make sure no reference is missed. Do not change the existing `src/camera/CameraController.js`.

3. **Phase 9 (barrel + package.json) should be the final commit.** Only create `src/services/index.js` and update `package.json` after all file moves are complete and validated.

4. **WebSocketBridge refactoring (showStatus default, createUI callback) is out of scope for the file-move extraction.** Move the file first, refactor the DOM coupling in a follow-up PR.

5. **Do not touch `examples/github-viewer/websocket/commands/`.** Those 21 files stay where they are. Their relative imports to `../../../../src/collections/` remain valid after the extraction because the files did not move.

6. **Remove `examples/github-viewer/providers/` directory** after HeatmapProvider.js is moved out (it will be empty).

Estimated effort: 2-3 hours for an implementer who reads this plan carefully. The work is mechanical -- file moves, import path rewrites, one class rename -- with browser validation between each phase to catch mistakes early.

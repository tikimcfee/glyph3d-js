# Phase 0: Extraction Plan — Services from github-viewer

**Project:** glyph3d-js  
**Goal:** Move composable services from `examples/github-viewer/` into `src/services/`, enabling reuse without the full app.  
**Strategy:** Progressive extraction, clean imports, no compat layers.

---

## I. Current Export Structure

### src/index.js
Exports rendering core only (GlyphAtlas, CodeGrid, layout managers, collections).  
No examples, no app glue, no command system.

### package.json
```json
{
  "exports": {
    ".": "./src/index.js",
    "./collections": "./src/collections/index.js",
    "./workers": "./src/workers/WorkerBridge.js",
    "./utils": "./src/utils/index.js",
    "./hand": "./src/hand/index.js"
  }
}
```

No service exports yet.

---

## II. Service Extraction Map

### Phase 1: Core Command System (No DOM)

| File | Current | New | Scope |
|------|---------|-----|-------|
| CommandRouter | websocket/ | **src/services/commands/CommandRouter.js** | Pure router + registration |
| ViewerAPI | websocket/ | **src/services/commands/ViewerAPI.js** | Facade wrapping router + context |

**DOM Coupling:** None. Pure command dispatch.  
**Import Rewrites:** Update relative imports; register path `../../src/`.

---

### Phase 2: Camera & Navigation (Light DOM)

| File | Current | New | Scope |
|------|---------|-----|-------|
| CameraController | github-viewer/ | **src/services/camera/CameraController.js** | Input, animation, focus |
| SceneContext | github-viewer/ | **src/services/camera/SceneContext.js** | Context bag (THREE, canvas, camera) |

**DOM Coupling:** 
- CameraController reads `localStorage` for settings (acceptable; web only)
- Listens to `window` events: resize, keydown, mousemove, wheel
- Emits custom event: `camera-focus-changed`

**Decoupling:** None needed; event pattern is clean.  
**Import Rewrites:** `platform.js` → **src/services/utils/platform.js** (move platform detection)

---

### Phase 3: Selection & Visual State

| File | Current | New | Scope |
|------|---------|-----|-------|
| SelectionManager | github-viewer/ | **src/services/ui/SelectionManager.js** | File/object selection tracking |
| FileStateManager | github-viewer/ | **src/services/state/FileStateManager.js** | Per-file state (hidden, dimmed, etc.) |
| CodeColorManager | github-viewer/ | **src/services/color/CodeColorManager.js** | Syntax coloring |

**DOM Coupling:** 
- SelectionManager: emits `file-selected` custom event
- FileStateManager: pure data (no DOM reads)
- CodeColorManager: pure data (no DOM reads)

**Decoupling:** None needed; event-driven design.  
**Import Rewrites:** Update relative paths.

---

### Phase 4: Data Loading & Adapters

| File | Current | New | Scope |
|------|---------|-----|-------|
| GitHubRepositorySource | github-viewer/ | **src/services/data/GitHubRepositorySource.js** | GitHub API client |
| RepositoryAdapter | github-viewer/ | **src/services/data/RepositoryAdapter.js** | Tree building from API |
| RepositoryContentCache | github-viewer/ | **src/services/data/RepositoryContentCache.js** | File content cache |
| HeatmapProvider | providers/ | **src/services/data/HeatmapProvider.js** | Metrics/heatmap computation |

**DOM Coupling:** None. Pure data.  
**Import Rewrites:** Update relative paths.

---

### Phase 5: WebSocket Command Bridge (Light DOM)

| File | Current | New | Scope |
|------|---------|-----|-------|
| WebSocketBridge | websocket/ | **src/services/websocket/WebSocketBridge.js** | Browser WS client |
| **index.js** (command center init) | websocket/ | **src/services/websocket/index.js** | `initCommandCenter()` export |

**DOM Coupling:**
- WebSocketBridge creates status bar element (optional, `showStatus` flag)
- Reads `navigator.userAgent` for LAN address detection

**Decoupling:** Status bar creation is optional. Can run headless.  
**Note:** Server-side relay (ws-relay.mjs) stays in examples; no Node.js deps in src/.

---

### Phase 6: Command Modules (Pure Functions)

| Path | Current | New | Scope |
|------|---------|-----|-------|
| commands/* | websocket/commands/ | **src/services/commands/modules/** | All 15+ command modules |
| Subfiles: spatialHelpers.js, etc. | websocket/commands/ | **src/services/commands/modules/spatialHelpers.js** | Helper utils |

**DOM Coupling:** None. Context-driven via CommandRouter.  
**Import Rewrites:** Update paths to src/, relative links to modules.

---

### Phase 7: Scene & Registry

| File | Current | New | Scope |
|------|---------|-----|-------|
| SceneRegistry | websocket/ | **src/services/registry/SceneRegistry.js** | Object registry (gridwise) |

**DOM Coupling:** None. Data structure.  
**Import Rewrites:** Update relative paths.

---

### Phase 8: TUI System (Heavy DOM, Stays in Examples)

| File | Current | Future |
|------|---------|--------|
| TUIWindow | websocket/ | ⚠️ **DEFER** — coupled to DOM, TextMetrics, Three.js mesh building |
| TUIWindowManager | websocket/ | ⚠️ **DEFER** — orchestrates TUI + CameraController |
| TUIFocusManager | websocket/ | ⚠️ **DEFER** — DOM click, raycast, keystroke relay |
| TUIFormatter | websocket/ | ⚠️ **DEFER** — text layout & coloring |

**Reason:** TUI requires direct DOM/mesh interaction. Extract later if abstracted properly.

---

### Phase 9: App Shells (Stay in Examples)

| File | Current | Status |
|------|---------|--------|
| GitHubRepoViewer | github-viewer/ | **Becomes composition** — assembles services, initializes scene |
| IDEShell | ide/ | **Composition layer** — wraps GHV with IDE UI |
| AppShell components | components/ | **Thin UI glue** — stays in examples |
| Drawer, LogCapturePanel, etc. | components/ | **Example UI** — optional, not part of core services |

---

## III. New Package.json Exports

```json
{
  "exports": {
    ".": "./src/index.js",
    "./collections": "./src/collections/index.js",
    "./workers": "./src/workers/WorkerBridge.js",
    "./utils": "./src/utils/index.js",
    "./hand": "./src/hand/index.js",
    
    "./services": "./src/services/index.js",
    "./services/commands": "./src/services/commands/index.js",
    "./services/camera": "./src/services/camera/index.js",
    "./services/ui": "./src/services/ui/index.js",
    "./services/state": "./src/services/state/index.js",
    "./services/data": "./src/services/data/index.js",
    "./services/websocket": "./src/services/websocket/index.js",
    "./services/registry": "./src/services/registry/index.js"
  }
}
```

Usage:
```js
// Rendering core
import { CodeGrid } from 'glyph3d-js';

// Composed services
import { CommandRouter, ViewerAPI } from 'glyph3d-js/services/commands';
import { CameraController } from 'glyph3d-js/services/camera';
import { GitHubRepositorySource } from 'glyph3d-js/services/data';

// Full bootstrap
import { initCommandCenter } from 'glyph3d-js/services/websocket';
```

---

## IV. Execution Plan

### Step 1: Create src/services/ structure
```
src/services/
  index.js                          # Aggregator exports
  commands/
    index.js                        # CommandRouter, ViewerAPI
    CommandRouter.js                (git mv)
    ViewerAPI.js                    (git mv)
    modules/
      index.js                      # registerAllCommands()
      systemCommands.js             (git mv)
      cameraCommands.js             (git mv)
      gridCommands.js               (git mv)
      ... (15+ more)
      spatialHelpers.js             (git mv)
  camera/
    index.js
    CameraController.js             (git mv)
    SceneContext.js                 (git mv)
  ui/
    index.js
    SelectionManager.js             (git mv)
  state/
    index.js
    FileStateManager.js             (git mv)
  color/
    index.js
    CodeColorManager.js             (git mv)
  data/
    index.js
    GitHubRepositorySource.js       (git mv)
    RepositoryAdapter.js            (git mv)
    RepositoryContentCache.js       (git mv)
    HeatmapProvider.js              (git mv)
  websocket/
    index.js                        # initCommandCenter() export
    WebSocketBridge.js              (git mv)
  registry/
    index.js
    SceneRegistry.js                (git mv)
  utils/
    index.js
    platform.js                     (git mv from github-viewer/)
```

### Step 2: Rewrite imports (in order of dependency)

1. **Utils first** (platform.js)
   - No internal deps
   
2. **Data services** (Repository*, HeatmapProvider)
   - Depends on utils/platform
   
3. **Registry** (SceneRegistry)
   - No deps
   
4. **Camera** (CameraController, SceneContext)
   - Depends on utils/platform
   
5. **UI & State** (SelectionManager, FileStateManager, CodeColorManager)
   - Lightweight; minimal deps
   
6. **Commands (modules)** (gridCommands, cameraCommands, etc.)
   - Depends on context bag (scene, registry, etc.)
   - No file imports needed; all injected via context
   
7. **Commands (core)** (CommandRouter, ViewerAPI)
   - Depends on modules/index.js for registerAllCommands()
   
8. **WebSocket**
   - Depends on CommandRouter, WebSocketBridge, ViewerAPI
   - Exports `initCommandCenter(viewer, options)`

### Step 3: Update examples/github-viewer

- **GitHubRepoViewer.js** → import from `glyph3d-js/services/*` instead of relative
- **websocket/** → import CommandRouter, commands from `glyph3d-js/services/commands`
- **Keep local copies** of UI components (Drawer, AppShell, etc.) — they stay thin

### Step 4: Update package.json

Add services exports to "exports" map.

---

## V. Tricky Parts & Decisions

### 1. Platform Detection (platform.js)
**Current:** `examples/github-viewer/platform.js` — exports `primaryMod()`, `secondaryMod()`  
**Decision:** Move to `src/services/utils/platform.js`  
**Rationale:** Used by CameraController (core service). Lightweight, no external deps.

### 2. Command Module Registration
**Current:** Each module is imported and registered in `registerAllCommands(router)`  
**Decision:** Keep all 15+ modules in `src/services/commands/modules/`; one `index.js` that aggregates  
**Rationale:** Clean namespace, easy to extend. Each module is ~10KB.

### 3. WebSocket Bridge Status Bar
**Current:** Bridge creates DOM status element  
**Decision:** Keep optional flag `showStatus: false` to skip creation  
**Rationale:** Allows headless command dispatch for CLI/scripts.

### 4. SceneContext vs. Raw Context
**Current:** CameraController takes `SceneContext` (encapsulates canvas, camera, THREE)  
**Decision:** Keep SceneContext as thin bag; don't extract further  
**Rationale:** Reduces churn; CameraController stays simple.

### 5. TUI System Deferral
**Current:** TUIWindow, TUIFocusManager, TUIWindowManager tightly coupled to DOM/mesh  
**Decision:** Leave in examples/ for now; extract only if/when fully abstracted  
**Rationale:** Premature extraction; these need more refactoring first.

### 6. GitHubRepoViewer → Composition
**Current:** Full monolithic app  
**Decision:** Keep existing; becomes thin wrapper that composes services  
**New Usage:**
```js
import { CodeGrid, GridLayoutManager } from 'glyph3d-js';
import { CameraController, SelectionManager, FileStateManager } from 'glyph3d-js/services';
import { GitHubRepositorySource } from 'glyph3d-js/services/data';
import { initCommandCenter } from 'glyph3d-js/services/websocket';

const viewer = new GitHubRepoViewer(canvas, THREE);
await viewer.init();  // Still handles app UI setup, panel wiring
const { router, bridge } = initCommandCenter(viewer);
```

### 7. cli/ and ws-relay.mjs
**Current:** examples/github-viewer/cli/, ws-relay.mjs  
**Decision:** Stay in examples/; can import from src/services but don't move  
**Rationale:** CLI-only code; not needed for library users.

---

## VI. Import Rewrite Reference

### Before (in websocket/commands/gridCommands.js)
```js
import CommandRouter from '../CommandRouter.js';
```

### After (in src/services/commands/modules/gridCommands.js)
```js
// No imports needed; router injected via registerGridCommands(router)
```

### Before (in github-viewer/CameraController.js)
```js
import { primaryMod } from './platform.js';
```

### After (in src/services/camera/CameraController.js)
```js
import { primaryMod } from '../utils/platform.js';
```

### Before (in github-viewer/GitHubRepoViewer.js)
```js
import { initCommandCenter } from './websocket/index.js';
```

### After (in examples/github-viewer/GitHubRepoViewer.js)
```js
import { initCommandCenter } from '../../src/services/websocket/index.js';
// OR
import { initCommandCenter } from 'glyph3d-js/services/websocket';
```

---

## VII. Execution Order (Critical Path)

1. ✓ Create src/services/ structure
2. ✓ Move utils/platform.js (no deps)
3. ✓ Move registry/SceneRegistry.js (no deps)
4. ✓ Move data/* (depends on utils)
5. ✓ Move camera/* (depends on utils)
6. ✓ Move ui/state/color/* (minimal deps)
7. ✓ Move commands/CommandRouter.js (core router)
8. ✓ Move commands/modules/* (each registers itself)
9. ✓ Move commands/ViewerAPI.js (wraps router)
10. ✓ Move commands/index.js (registerAllCommands)
11. ✓ Move websocket/* (depends on commands)
12. ✓ Update package.json exports
13. ✓ Rewrite imports in examples/github-viewer
14. ✓ Verify tests & examples build

---

## VIII. No Breaking Changes

- Existing `glyph3d-js` export unchanged: `import { CodeGrid } from 'glyph3d-js'`
- Services are **additive only**: new top-level exports
- Examples run unchanged; internal imports rewritten
- IDEShell compatibility: can import from both old paths (examples/) and new (src/services/)

---

## Summary

**Scope:** Extract 7 service clusters (~25 files) from github-viewer → src/services/  
**Scale:** ~15KB command modules, ~5KB each core service  
**No DOM coupling in extracted code** (except optional WebSocket status bar)  
**Defer:** TUI system (needs more refactoring)  
**Result:** Reusable command system, camera, data adapters, registry — decoupled from app shell.


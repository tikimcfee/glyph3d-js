# Component Ownership Analysis: IDE vs Viewer Separation

**Date:** 2026-03-30  
**Scope:** glyph3d-js examples/github-viewer/  
**Objective:** Identify which components belong to IDE shell, viewer, or shared utilities.

---

## Executive Summary

The `examples/github-viewer/` directory currently bundles two distinct concerns:
1. **IDE-shell components** (sidebar, activity bar, status bar, editor tabs)
2. **Repository viewer components** (3D scene, file display, camera controls)

This analysis identifies **10 IDE-shell-specific components** and **12 viewer-specific components** that should be separated. Key coupling points are DOM element IDs (especially in `ide.html`) and the `SelectionManager` → IDEShell window event bridge.

---

## Component Ownership Table

| Component | Type | Current Home | Ownership | Coupling | Recommendation |
|-----------|------|-------------|-----------|----------|-----------------|
| **AppShell.js** | Module | components/ | Viewer | DOM: `#header`, `#loading`, `#fps-badge`, `#toast` | Stay (simple UI helpers) |
| **CommandBar.js** | Component | components/ | IDE-shell | DOM: `#command-bar`, `#panel-resize`; needs editor context | Move to examples/ide/components/ |
| **Drawer.js** | Component | components/ | Viewer | DOM-agnostic (self-contained); HTML builders | Stay (reusable UI pattern) |
| **DiffPanel.js** | Component | components/ | Viewer | DOM-agnostic (drawer panel HTML builder) | Stay |
| **LogCapturePanel.js** | Component | components/ | Viewer | Imports `src/utils/LogCapture.js`; DOM-agnostic | Stay |
| **MinimapOverlay.js** | Component | components/ | Viewer | DOM: `#minimap-container`, `#minimap-canvas`; can be pre-created by IDE | Stay (3D viewer utility) |
| **TouchController.js** | Component | components/ | Viewer | Canvas-only, no DOM IDs | Stay |
| **BackdropManager.js** | Manager | root | Viewer | THREE.js scene-only; no DOM deps | Stay |
| **CodeColorManager.js** | Manager | root | Viewer | FileStateManager sink; no DOM | Stay |
| **DiffController.js** | Manager | root | Viewer | Scene + GitHub API; no DOM | Stay |
| **DiffParser.js** | Utility | root | Viewer | String parsing; no DOM/scene deps | Stay (pure utility) |
| **FileStateManager.js** | Manager | root | Viewer | Data registry; no DOM | Stay |
| **NameplateManager.js** | Manager | root | Viewer | THREE.js scene-only; no DOM | Stay |
| **SceneContext.js** | Container | root | Shared | Lightweight ref bag | Elevate to src/core/ (or keep in viewer) |
| **SelectionManager.js** | Manager | root | Viewer | Emits window CustomEvent `file-selected`; FileStateManager sink | Stay (but event bridge to IDE) |
| **StatePersistence.js** | Manager | root | Viewer | localStorage keys; viewer-specific | Stay |
| **ShortcutManager.js** | Manager | root | Viewer | keyboard registry; can be shared | Stay (or move to shared) |
| **TreemapLabelManager.js** | Manager | root | Viewer | THREE.js scene; treemap-specific LOD | Stay |
| **CameraController.js** | Manager | root | Viewer | DOM-agnostic (canvas + camera); localStorage | Stay |
| **HandGestureAdapter.js** | Adapter | root | Viewer | Bridges hand tracking to camera/selection | Stay |
| **platform.js** | Utility | root | Shared | Modifier key detection; no DOM | Share with IDE (copy or import) |

---

## Detailed Coupling Analysis

### IDE-Shell Specific (Should Move to examples/ide/)

#### 1. **CommandBar.js** — Editor Input Surface
**Path:** `/examples/github-viewer/components/CommandBar.js`  
**Ownership:** IDE-shell  
**DOM Dependencies:**
- Creates and manages `#command-bar` element inline
- Positions output dropdown relative to input (absolute positioning)
- Calls `.mount()` to insert before `#panel-resize` (editor column specific)

**Functional Dependencies:**
- Takes `CommandRouter` for command dispatch (IDE-only concept)
- Integrates with `CameraController.enabled` for focus gating
- Emits commands into a router that doesn't exist in pure viewer

**Recommendation:** **MOVE to examples/ide/components/CommandBar.js**  
Will need a `CommandRouter` shim or IDE-shell-specific import.

### Viewer-Specific (Should Stay)

#### 2. **SelectionManager.js** — Canvas Click Handling
**Path:** `/examples/github-viewer/SelectionManager.js`  
**Ownership:** Viewer  
**DOM Dependencies:**
- Emits `file-selected` window CustomEvent (loose coupling; IDE listens optionally)
- Accesses canvas bounds for raycasting

**Functional Dependencies:**
- FileStateManager (internal state registry)
- THREE Raycaster API (core 3D logic)

**Recommendation:** **STAY in github-viewer/**  
The window CustomEvent is a clean publication point; IDEShell can optionally listen. No hard IDE dependency.

#### 3. **CameraController.js** — Input & Navigation
**Path:** `/examples/github-viewer/CameraController.js`  
**Ownership:** Viewer  
**DOM Dependencies:** None (canvas-only)  
**Functional Dependencies:**
- localStorage (user preference persistence)
- SceneContext (camera, canvas, renderer refs)

**Recommendation:** **STAY in github-viewer/**  
Pure viewer logic. localStorage key is viewer-specific (`'glyph3d-camera-settings'`).

#### 4. **BackdropManager.js** — 3D Scene Decor
**Path:** `/examples/github-viewer/BackdropManager.js`  
**Ownership:** Viewer  
**DOM Dependencies:** None  
**Functional Dependencies:** THREE.js scene; hierarchy tree nodes

**Recommendation:** **STAY in github-viewer/**  
Zero DOM coupling. Pure 3D visualization.

#### 5. **DiffController.js** — PR Diff Pipeline
**Path:** `/examples/github-viewer/DiffController.js`  
**Ownership:** Viewer  
**DOM Dependencies:** None  
**Functional Dependencies:**
- CodeGrid + GridLayoutManager (3D creation)
- GitHub API via GitHubRepositorySource
- DiffParser (internal utility)

**Recommendation:** **STAY in github-viewer/**  
GitHub-specific domain logic. Not reusable in other contexts.

### Shared Utilities (Can Be Elevated)

#### 6. **platform.js** — Platform Detection
**Path:** `/examples/github-viewer/platform.js`  
**Ownership:** Shared  
**DOM Dependencies:** None  
**Content:**
- `isMac`, `isLinux` flags
- `primaryMod()`, `secondaryMod()` modifier key helpers

**Recommendation:** **KEEP in github-viewer/ but import in IDE**  
Too small to separate. Copy to IDE, or add to glyph3d-js core utils.

#### 7. **ShortcutManager.js** — Keyboard Registry
**Path:** `/examples/github-viewer/ShortcutManager.js`  
**Ownership:** Shared (Viewer + IDE both need shortcuts)  
**DOM Dependencies:** None  
**Functional Dependencies:** `platform.js` (modifier detection); document event listeners

**Note:** Currently used only by GitHubRepoViewer but is a generic keyboard manager that IDEShell will also need.

**Recommendation:** **KEEP in github-viewer/** as a shared module.  
Both IDE and Viewer import it. Could be elevated to `src/` if generalized further.

#### 8. **SceneContext.js** — Reference Bag
**Path:** `/examples/github-viewer/SceneContext.js`  
**Ownership:** Viewer (or could be shared)  
**DOM Dependencies:** None  
**Content:** Lightweight container for {THREE, scene, camera, renderer, canvas, atlas, getGrids}

**Recommendation:** **KEEP in github-viewer/**  
Used by CameraController, CodeColorManager, etc. Not specific to IDE vs viewer distinction.

---

## Import Chain Analysis

### GitHubRepoViewer.js Dependencies (Core Viewer)

```
GitHubRepoViewer.js
├── SelectionManager.js
├── ShortcutManager.js
├── TreemapLabelManager.js
├── MinimapOverlay.js (component)
├── CameraController.js
├── FileStateManager.js
├── CodeColorManager.js
├── DiffController.js
├── BackdropManager.js
├── NameplateManager.js
├── StatePersistence.js
├── SceneContext.js
├── AppShell.js (component)
├── Drawer.js (component) — HTML builders only
├── TouchController.js (component)
├── LogCapturePanel.js (component)
├── DiffPanel.js (component)
├── HandGestureAdapter.js
└── (layout managers, GitHub sources, etc.)
```

### IDEShell.js Dependencies (IDE Orchestrator)

```
IDEShell.js
├── Drawer.js — HTML builders (repoPanelHTML, etc.)
├── DiffPanel.js — diffPanelHTML
├── LogCapturePanel.js — logCapturePanelHTML
├── platform.js — primaryMod
├── GitHubRepoViewer.js (wrapped, not owned)
└── (no hard dependency on CommandBar; listeners on SelectionManager window events)
```

**Key Finding:** IDEShell does NOT import CommandBar. The command bar is currently initialized inside GitHubRepoViewer for IDE environments, creating a layering violation.

---

## DOM Structure Coupling

### ide.html Key IDs

```html
<div id="ide-shell">                    <!-- IDE shell root (CSS Grid) -->
  <header id="titlebar">...</header>
  <nav id="activity-bar">...</nav>
  <aside id="sidebar">
    <div id="sp-explorer">...</div>     <!-- Explorer panel (file tree) -->
    <div id="sp-repo">...</div>         <!-- Injected: repoPanelHTML -->
    <div id="sp-settings">...</div>     <!-- Injected: settingsPanelHTML -->
    <div id="sp-diff">...</div>         <!-- Injected: diffPanelHTML -->
    <div id="sp-hand-tracking">...</div>
    <div id="sp-controls">...</div>     <!-- Injected: controlsPanelHTML -->
  </aside>
  <div id="editor-column">
    <div id="editor-tab-bar">...</div>
    <div id="editor-area">
      <canvas id="canvas"></canvas>
    </div>
    <div id="panel-resize"></div>
    <div id="command-bar">...</div>     <!-- Created by CommandBar.js -->
    <div id="bottom-panel">...</div>
  </div>
  <footer id="statusbar">...</footer>
</div>

<!-- External (can pre-exist) -->
<div id="minimap-container">           <!-- Created by MinimapOverlay if not pre-created -->
  <canvas id="minimap-canvas"></canvas>
</div>
```

**Tightly Coupled IDE Elements:**
- `#command-bar` — Created by CommandBar component, positioned relative to `#panel-resize`
- `#editor-tab-bar` — Managed by IDEShell, reflects SelectionManager state
- `#editor-area` — DOM container for canvas; resized by ResizeObserver in IDEShell
- `#statusbar` elements — Updated by IDEShell._updateStatusBar()

**Loosely Coupled Viewer Elements:**
- `#canvas` — Only requires HTMLCanvasElement ref; doesn't care about parent ID
- `#minimap-container` — Pre-created by IDE with correct ID, or created by MinimapOverlay inline

---

## Proposed Separation Strategy

### Phase 1: Extract IDE Components
1. Move `CommandBar.js` → `examples/ide/components/CommandBar.js`
2. Create `examples/ide/IDEShell.js` if not already there
3. Create `examples/ide/ide.html` (or rename current `ide.html`)

### Phase 2: Viewer Remains Standalone
1. Keep all managers in `examples/github-viewer/` (BackdropManager, CameraController, etc.)
2. Viewer should NOT import CommandBar; will auto-add command bar if detected
3. Viewer should NOT hard-depend on IDE-specific HTML IDs (e.g., `#editor-tab-bar`)

### Phase 3: Shared Layer (Optional)
1. Evaluate promoting `ShortcutManager`, `platform.js` to `src/` core
2. Ensure SceneContext remains viewer-scoped

### Phase 4: Event Bridges
1. SelectionManager → IDEShell via window CustomEvent (`file-selected`)
2. CommandRouter → 3D actions via message passing (not direct imports)

---

## Summary of Moves

**IDE-Shell Specific:**
- `CommandBar.js` → Move to `examples/ide/components/`

**Viewer-Specific (No Move):**
- All others: BackdropManager, CameraController, CodeColorManager, DiffController, DiffParser, FileStateManager, NameplateManager, SceneContext, SelectionManager, StatePersistence, ShortcutManager, TreemapLabelManager, HandGestureAdapter, CameraController, TouchController, MinimapOverlay

**Shared (Already Well-Used):**
- `platform.js` — Use in both IDE and viewer
- `Drawer.js` — Reusable UI component (stays)
- `AppShell.js` — Basic UI factories (stays)

---

## Notes for Implementation

1. **CommandBar Integration:** Ensure IDEShell can mount CommandBar independently. GitHubRepoViewer should detect presence of CommandBar DOM and integrate input routing.

2. **Window Events:** SelectionManager's `file-selected` CustomEvent is the clean integration point for IDEShell to listen without hard dependency.

3. **localStorage Keys:** Viewer uses `'glyph3d-viewer-state'` and `'glyph3d-camera-settings'`. IDE can use separate keys to avoid conflicts.

4. **Canvas Hosting:** Viewer should not assume a specific parent ID. IDE provides `#editor-area` as container; viewer just needs the canvas element ref.

5. **Mobile Handling:** IDEShell has `_isMobile` flag and responsive logic. Viewer components (MinimapOverlay) adapt independently via ResizeObserver.


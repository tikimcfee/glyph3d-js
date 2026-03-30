# Phase 0: Library Promotion Analysis

Agent perspective: **library-promotion** -- which code in `examples/github-viewer/` is reusable library infrastructure vs. app-specific?

---

## 1. Already Extracted (confirmed in src/services/orchestration/)

These files already live in `src/services/orchestration/` and examples/ correctly imports them. No duplication -- just thin wiring in `examples/github-viewer/websocket/index.js`.

| File | Status | Action |
|------|--------|--------|
| `CommandRouter.js` | In `src/services/orchestration/` | Done. examples/ imports from src/. |
| `WebSocketBridge.js` | In `src/services/orchestration/` | Done. examples/ imports from src/. |
| `ViewerAPI.js` | In `src/services/orchestration/` | Done. examples/ imports from src/. |
| `platform.js` | In `src/services/utils/platform.js` | Done. TUIFocusManager already imports from src/. No stale copy in examples/. |

---

## 2. Promotion Candidates

### Tier 1: Strongly reusable -- promote to `src/tui/`

| File | Current location | Verdict | Rationale |
|------|-----------------|---------|-----------|
| **TUIWindow.js** | `examples/.../websocket/` | **PROMOTE to `src/tui/TUIWindow.js`** | Generic terminal-pane-in-3D-space. Only dependency is CodeGrid (already in src/). No viewer-specific logic. Any app using glyph3d-js that wants terminal-like panels would use this. Write/append/scroll/cursor/resize are all domain-general. |
| **TUIWindowManager.js** | `examples/.../websocket/` | **PROMOTE to `src/tui/TUIWindowManager.js`** | Lifecycle manager for TUIWindow instances. Auto-positioning, create/remove/list. Pure management, zero app coupling. Imports only TUIWindow. |
| **TUIFocusManager.js** | `examples/.../websocket/` | **PROMOTE to `src/tui/TUIFocusManager.js`** | Click-to-focus, keyboard routing, cursor blinking, camera-disable-on-focus. Dependencies: THREE (raycaster), TUIWindowManager, CHAR_DIMENSIONS (src/core), primaryMod (src/services/utils). All already in src/. The WebSocketBridge dep is optional (keystroke relay). |
| **TUIFormatter.js** | `examples/.../websocket/` | **PROMOTE to `src/tui/TUIFormatter.js`** | Pure string functions: box-drawing, tables, padding, truncation. Zero dependencies. Any TUI-in-3D app needs these. Classic utility module. |

**Import chain for TUI promotion:**
```
TUIFocusManager
  -> TUIWindowManager -> TUIWindow -> CodeGrid (src/collections/)
  -> platform.js (src/services/utils/)
  -> constants.js (src/core/)
TUIFormatter (standalone, no deps)
```
All upstream dependencies are already in src/. The chain is clean -- no circular references, no app-specific imports.

**Recommended directory structure:**
```
src/tui/
  TUIWindow.js
  TUIWindowManager.js
  TUIFocusManager.js
  TUIFormatter.js
  index.js            # barrel export
```

### Tier 2: Reusable utility -- promote to `src/utils/`

| File | Current location | Verdict | Rationale |
|------|-----------------|---------|-----------|
| **encoding.js** | `examples/.../websocket/commands/` | **PROMOTE to `src/utils/encoding.js`** | UTF-8-safe base64 encode/decode. Zero dependencies, pure functions. Any app receiving base64 content over WebSocket or API needs this. Currently used by both `terminalCommands.js` and `windowCommands.js`. |

### Tier 3: Potentially reusable but needs abstraction

| File | Current location | Verdict | Rationale |
|------|-----------------|---------|-----------|
| **MinimapOverlay.js** | `examples/.../components/` | **DEFER** | The concept (2D canvas minimap of 3D scene) is reusable, but the implementation couples to specific camera/grid patterns. Could promote later with a config-driven API. |
| **TouchController.js** | `examples/.../components/` | **DEFER** | Touch input is reusable, but tightly coupled to CameraController internals (`_applyDragTranslation`, `ctx.camera`). Should be promoted alongside a CameraController refactor. |

---

## 3. App-Specific Code (do NOT promote)

| File | Location | Reason it stays |
|------|----------|-----------------|
| `websocket/index.js` | `examples/.../websocket/` | `buildContext()` constructs a viewer-specific context bag referencing `viewer.registry`, `viewer.hierarchicalManager`, etc. This is pure app wiring. |
| `websocket/commands/*.js` (21 files) | `examples/.../websocket/commands/` | Every command module is viewer-specific: `gridCommands` operates on viewer's registry, `cameraCommands` targets viewer's camera controller, `searchCommands` searches viewer's loaded repos. These are the *application layer* for the command system. |
| `components/Drawer.js` | `examples/.../components/` | HTML drawer with tab-panel system. The panel concept is generic but the implementation creates viewer-specific DOM (panels for file tree, search, settings). |
| `components/AppShell.js` | `examples/.../components/` | Creates "GitHub 3D" header, loading overlay, buy-me-a-coffee link. Entirely viewer-branded. |
| `components/DiffPanel.js` | `examples/.../components/` | GitHub diff-specific UI panel. |
| `components/LogCapturePanel.js` | `examples/.../components/` | Viewer-specific log capture. |

---

## 4. Summary

### Promote now (5 files):
1. `TUIWindow.js` -> `src/tui/TUIWindow.js`
2. `TUIWindowManager.js` -> `src/tui/TUIWindowManager.js`
3. `TUIFocusManager.js` -> `src/tui/TUIFocusManager.js`
4. `TUIFormatter.js` -> `src/tui/TUIFormatter.js`
5. `encoding.js` -> `src/utils/encoding.js`

### Defer (2 files):
- `MinimapOverlay.js` -- needs config abstraction first
- `TouchController.js` -- needs CameraController refactor first

### Leave in app (all commands/, Drawer, AppShell, DiffPanel, LogCapturePanel, websocket/index.js):
These are the application layer. The command *router* is library; the command *handlers* are app-specific.

### After promotion, update imports in:
- `examples/github-viewer/websocket/commands/windowCommands.js` (TUIWindowManager import)
- `examples/github-viewer/websocket/index.js` (if it references TUI files)
- `examples/github-viewer/websocket/TUIFocusManager.js` references -> redirect to `src/tui/`
- Any command files importing `encoding.js` -> redirect to `src/utils/encoding.js`
- Add `src/tui/index.js` barrel and register in `src/index.js` exports and `package.json` exports map

### Package exports addition:
```json
"./tui": "./src/tui/index.js"
```

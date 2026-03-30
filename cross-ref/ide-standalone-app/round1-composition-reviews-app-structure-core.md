# Round 1: Composition-Extraction Reviews App-Structure & Core-App-Infrastructure

## Errors Found

### E1. App-Structure's import map breaks under Caddy `strip_prefix`

App-Structure proposes serving `app/` at `/ide/` via Caddy with `uri strip_prefix /ide`. The `index.html` importmap uses `../src/index.js` — a relative path that resolves against the browser URL, not the filesystem. When the browser is at `ivanlugo.dev/ide/`, `../src/index.js` resolves to `ivanlugo.dev/src/index.js`. But Caddy's `file_server` root is set to `app/` only for the `/ide/*` route — requests to `/src/` have no route configured. The importmap relative paths will 404 in production.

**Fix**: Caddy must serve from the project root (not `app/`), or the importmap must use absolute paths (`/src/index.js`) with Caddy configured to serve the entire project tree. The Python dev server (serving from project root) works by accident, but the Caddy config as written will fail.

### E2. App-Structure claims `IDEShell.js` imports from `../github-viewer/platform.js` which "doesn't exist — moved to src"

This is half-right but misleading. The file `examples/github-viewer/platform.js` genuinely does not exist on disk — verified via `ls`. But it was never "moved" — it was *extracted* to `src/services/utils/platform.js`. The imports in `IDEShell.js` (line 29) and `CommandBar.js` (line 16) are **currently broken**. This is not a future migration problem; it is a present-day bug. The app-structure doc treats it as something the compat shim will fix, but it should be flagged as a pre-existing broken import that proves the current IDE example is non-functional without fixing these paths first.

### E3. Core-App-Infrastructure places files in `examples/ide/` — contradicts the extraction goal

The file organization in Section 5 shows new files going into `examples/ide/components/`:
```
examples/ide/
  components/
    WorkbenchController.js
    EditorController.js
    ...
```
But the entire premise is to extract the IDE out of `examples/` into `app/`. This contradicts both App-Structure's plan (files go into `app/components/`) and the user's directive to create a standalone app. These new classes should live in `app/components/` or `app/controllers/`.

### E4. `websocket/index.js` has broken imports that neither doc addresses

`examples/github-viewer/websocket/index.js` (lines 10-12) imports:
```javascript
import CommandRouter from './CommandRouter.js';
import WebSocketBridge from './WebSocketBridge.js';
import ViewerAPI from './ViewerAPI.js';
```
None of these files exist in `examples/github-viewer/websocket/` — they were extracted to `src/services/orchestration/`. `GitHubRepoViewer.js` calls `initCommandCenter()` from this file (line 50, 357). This means the entire viewer is currently broken at module-load time. Neither doc identifies this critical issue. The `app/` bootstrap must wire `initCommandCenter` differently or fix these imports to point at `src/services/orchestration/`.

### E5. Core-App-Infrastructure proposes compat shims — violates "NO compat layers" directive

The user explicitly said "NO compat layers." Similarly, App-Structure proposes `app/lib/drawer-shim.js` and `app/lib/platform-compat.js`. Core-App-Infrastructure Section 8 proposes a phased transition wrapping IDEShell inside WorkbenchController. Both approaches create transitional compatibility layers. The directive was a clean break — imports should point directly at the real module paths, not through re-export shims.

---

## Gaps

### G1. Neither doc addresses the 21 command modules

There are 16 command modules registered in `examples/github-viewer/websocket/commands/index.js` (plus `encoding.js`, `colorConstants.js`, `gridVisualState.js`, `spatialHelpers.js` = ~21 files, 4123 LOC total). My Phase 0 identified these as app-specific (not reusable library code). Neither doc specifies where they go in the new `app/` structure or how `registerAllCommands()` gets wired. These commands are the backbone of the entire interaction system.

### G2. Neither doc addresses the TUI subsystem

The `websocket/` directory contains 4 TUI files (1131 LOC): `TUIFocusManager.js`, `TUIFormatter.js`, `TUIWindow.js`, `TUIWindowManager.js`. These are integral to the IDE's terminal/window management. Neither doc mentions them. They need to be placed in `app/` and their import of `../platform.js` (also broken) needs fixing.

### G3. No plan for `initCommandCenter()` replacement

`initCommandCenter()` in `websocket/index.js` does critical wiring: builds the command context bag, creates the router, registers all commands, creates the WebSocket bridge, and exposes `window.viewer`. The `app/bootstrap.js` must replicate or replace this function. Core-App-Infrastructure's Section 4 sketches similar wiring but doesn't acknowledge `initCommandCenter()` exists or that it needs to be replaced.

### G4. `StatePersistence.js` not mentioned

`examples/github-viewer/StatePersistence.js` exists and is presumably used for localStorage state. Neither doc addresses where it goes.

---

## Tensions

### T1. App-Structure vs Core-App-Infrastructure on where files live

App-Structure: new files in `app/components/` with importmap aliasing.
Core-App-Infrastructure: new files in `examples/ide/components/` with gradual migration.
These are incompatible plans. One says "move now," the other says "wrap and migrate."

### T2. App-Structure's thin approach vs Core-App-Infrastructure's deep refactor

App-Structure proposes a minimal extraction: copy IDEShell, add importmap, create thin re-exports. Core-App-Infrastructure proposes a full architectural rethink (WorkbenchController, EditorController, SidebarViewController hierarchy, event buses). These are fundamentally different scopes. The former is a weekend task; the latter is weeks of refactoring.

### T3. Direct `viewer.grids` access vs SceneRegistry

IDEShell (lines 466-467, 525-526, 652-653, 784-789) accesses `viewer.grids` directly. Core-App-Infrastructure says SceneRegistry is "the single source of truth" and the context bag uses `registry.toArray('grid')`. These are two different data access patterns that currently coexist. The `app/` extraction needs to pick one path.

---

## Recommendations (max 10)

1. **Fix Caddy config**: Serve from project root with route-based path matching, not per-directory `file_server` roots. The importmap's `../src/` relative paths require the entire project tree to be accessible.

2. **Fix broken imports before extracting**: `websocket/index.js` lines 10-12 and `GitHubRepoViewer.js` line 51 reference files that don't exist. Fix these to point at `src/services/orchestration/` first, or the extraction starts from a broken base.

3. **No shims, no compat layers**: Replace `app/lib/platform-compat.js` and `app/lib/encoding-compat.js` with direct importmap entries: `"platform": "../src/services/utils/platform.js"` and `"encoding": "../examples/github-viewer/websocket/commands/encoding.js"`. The user said no compat layers.

4. **Place commands in `app/commands/`**: Move the 16 command modules + 4 helper files from `examples/github-viewer/websocket/commands/` to `app/commands/`. They are app-specific, not library code.

5. **Place TUI in `app/tui/`**: Move the 4 TUI files from `examples/github-viewer/websocket/` to `app/tui/`. Fix their `../platform.js` imports to use the importmap alias.

6. **Inline `initCommandCenter()` into `app/bootstrap.js`**: The wiring function from `websocket/index.js` (lines 131-162) should become the core of `bootstrap.js`. Import `CommandRouter`, `WebSocketBridge`, `ViewerAPI` from `glyph3d/services` (the importmap alias for `../src/services/index.js`).

7. **Defer the WorkbenchController/EditorController/ViewController refactor**: Core-App-Infrastructure's architecture is sound as a target, but it's a separate phase. Phase 0 should be: move files, fix imports, verify it runs. Phase 1: refactor IDEShell into the controller hierarchy.

8. **Resolve `viewer.grids` vs `registry.toArray('grid')`**: The bootstrap should expose the registry, and IDEShell should be updated to use it. This is a prerequisite for the EditorController pattern proposed by Core-App-Infrastructure.

9. **Add `app/commands/index.js` re-exporting `registerAllCommands`**: This preserves the single-call registration pattern while giving commands a proper home in the app.

10. **Test with Python server first, Caddy second**: `python3 -m http.server 8000` from project root, then `http://localhost:8000/app/`. Get it working before touching Caddy config.

---

## Key Insight

Both docs underestimate the current breakage. The extraction of `CommandRouter`, `ViewerAPI`, and `WebSocketBridge` to `src/services/orchestration/` was a *partial migration* — the files were copied but consumers (`websocket/index.js`, `GitHubRepoViewer.js`) still have stale imports pointing at the old locations. The IDE example is currently non-functional at module load time. The `app/` extraction is not extracting a working app — it is *completing an incomplete refactor* and simultaneously moving the result to a new location. This changes the scope: step 0 is fixing the broken import graph, step 1 is the `app/` directory creation. Treating the current `examples/ide/` as a working baseline is incorrect.

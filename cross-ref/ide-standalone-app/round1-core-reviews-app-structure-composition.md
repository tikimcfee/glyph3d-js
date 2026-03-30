# Round 1: Core App Infrastructure Reviews App Structure + Composition Extraction

Reviewer: core-app-infrastructure agent
Reviewed: phase0-app-structure.md, phase0-composition-extraction.md

---

## Errors Found

### 1. App-structure proposes compat shims that violate "NO compat layers"
`app/lib/drawer-shim.js`, `app/lib/platform-compat.js`, and `app/lib/encoding-compat.js` (phase0-app-structure.md lines 19-21) are explicitly compat layers. Ivan said "NO compat layers." The importmap approach for aliasing `platform` and `encoding` is fine, but naming them "compat" and treating them as shims is the wrong framing. These should be direct re-exports in the importmap, not files.

### 2. Composition agent claims "No changes needed" for LogCapturePanel -- wrong
`LogCapturePanel.js` imports from `../../../src/utils/LogCapture.js` (line 8). If moved to `app/components/`, that path breaks. The "No changes needed" claim in the file movement table is incorrect for this file.

### 3. Composition agent claims "No changes needed" for TUI files -- partially wrong
- `TUIWindow.js` imports `CodeGrid` from `../../../src/collections/CodeGrid.js` -- breaks if moved to `app/lib/`.
- `TUIFocusManager.js` imports `primaryMod` from `../platform.js` (already broken -- file doesn't exist) and `CHAR_DIMENSIONS` from `../../../src/core/constants.js`. Both paths break on move.
- `TUIWindowManager.js` imports `./TUIWindow.js` -- only correct if both stay in same directory.

### 4. GitHubRepoViewer imports are massively broken TODAY
`GitHubRepoViewer.js` has 14 imports pointing to `./SelectionManager.js`, `./DiffController.js`, `./CameraController.js`, etc. (lines 21-51). None of these files exist in `examples/github-viewer/` anymore -- they've all been moved to `src/services/**`. The composition agent's import change note says "Update imports: `../../src/` -> `../../src/`" suggesting only the src imports need changing, completely missing that the 14 `./` imports are already broken. This is the single largest bug in the current codebase and neither document addresses it.

### 5. `websocket/index.js` imports are broken TODAY
Lines 10-12 import `CommandRouter`, `WebSocketBridge`, `ViewerAPI` from `./CommandRouter.js` etc. -- those files no longer exist in `examples/github-viewer/websocket/`. They were moved to `src/services/orchestration/`. Similarly, line 51 of `GitHubRepoViewer.js` imports `SceneRegistry` from `./websocket/SceneRegistry.js` -- it's actually at `src/services/SceneRegistry.js`.

### 6. App-structure's Caddy config has a path resolution error
Lines 146-149: When Caddy strips `/ide` and serves from `app/`, the importmap's `../src/` would resolve relative to the browser URL, not filesystem. The browser sees `/index.html` (after strip), so `../src/` resolves to `/../src/` which is invalid. Importmap paths are resolved relative to the HTML document's URL, and stripping the prefix changes that base URL. The Python dev server works because the HTML is served at `/app/index.html` and `../src/` correctly resolves to `/src/`. But the Caddy config that strips `/ide` and roots at `/app` breaks this.

## Gaps

### 7. Neither document accounts for the full GitHubRepoViewer dependency tree
`GitHubRepoViewer.js` is 1611 lines and imports from 15+ modules now in `src/services/`. The composition agent lists it for move to `app/lib/` but doesn't enumerate that its imports must be rewritten to point at `src/services/{interaction,data,visual,orchestration,state,camera}/`. This is the most import-heavy file in the project and needs a dedicated import rewrite table.

### 8. No mention of `SceneRegistry` at all
`SceneRegistry` (at `src/services/SceneRegistry.js`) is imported by `GitHubRepoViewer.js` and is central to the command context bag in `websocket/index.js`. Neither document mentions it. It's already in `src/services/` so it doesn't need to move, but the composition doc's wiring diagram should reference it.

### 9. Missing: CommandBar.js import rewrites
`CommandBar.js` (at `examples/ide/components/`) imports `primaryMod` from `../../github-viewer/platform.js` (broken path) and `encodeBase64` from `../../github-viewer/websocket/commands/encoding.js`. Neither document gives the corrected paths for CommandBar specifically.

## Tensions

### 10. App-structure says "copy from examples/ide" while composition says "move"
App-structure (lines 2, 175) uses "Move or symlink" language. Composition (line 7 of table) says outright "move." With the user's "no compat layers" rule, moving is correct -- but then `examples/ide/` becomes dead and `examples/github-viewer/` loses its entry point. Neither doc addresses what happens to `examples/github-viewer/index.html` (the non-IDE entry point). Does it still work? Does it stay?

### 11. Dual composition roots: bootstrap.js vs compose-app.js
App-structure proposes `bootstrap.js` (line 89). Composition proposes `compose-app.js` (line 64). They do the same thing. This needs to be one file with one name.

### 12. IDEShell location: app/components/ vs app/lib/
App-structure puts `IDEShell.js` in `app/components/IDEShell.js` (line 14). Composition puts it in `app/lib/IDEShell.js` (line 27 of table). IDEShell is a 1007-line orchestrator, not a presentational component. `app/lib/` is more accurate, but "lib" is also a misleading name for app-specific orchestrators.

## Recommendations

1. **Fix the broken imports first.** Before any extraction, `GitHubRepoViewer.js` and `websocket/index.js` need their imports rewritten to point at `src/services/`. This is a prerequisite, not part of the extraction.

2. **Drop all compat shims.** Use importmap aliases for `platform` and `encoding` that point directly to `src/services/utils/platform.js` and `app/commands/encoding.js`. No intermediate files.

3. **Single entry point: `app/main.js`** (not bootstrap.js, not compose-app.js). It does what `ide.html`'s inline `<script>` does today. Keep the name simple.

4. **Put IDEShell in `app/shell/IDEShell.js`**, not `components/` or `lib/`. It's the shell. Name the directory after what it is.

5. **Create a concrete import rewrite table for GitHubRepoViewer.js** covering all 15+ imports. This is the hardest file to move correctly and it currently doesn't even run.

6. **Fix the Caddy config** to serve the full project root (not just `app/`) at a base path, or use an importmap with absolute paths (`/src/index.js`). The current config will fail for `../src/` resolution in the browser.

7. **Verify TUI file imports** before declaring them "no changes needed." TUIWindow, TUIFocusManager, and TUIWindowManager all have imports that break on move.

8. **Decide the fate of `examples/github-viewer/index.html`** explicitly. If the IDE app subsumes it, say so. If it remains as a simpler demo, document which files it needs to keep working.

9. **Use importmap to alias `src/services/` subpaths** rather than deep relative paths. This prevents every file from needing different `../../` depth calculations:
   ```json
   "glyph3d/services/interaction": "../src/services/interaction/index.js"
   ```

10. **Merge the command context bag (`buildContext`) into `app/main.js`** rather than keeping it in a separate `initCommandCenter.js`. The context bag is pure app-level wiring -- it references viewer internals, layout managers, and registry. It belongs in the composition root, not a separate module.

## Key Insight

Both documents treat this extraction as primarily a file-move operation. In reality, the codebase has **already undergone a partial extraction** (14+ modules moved from `examples/github-viewer/` to `src/services/`) that left `GitHubRepoViewer.js` and `websocket/index.js` with broken imports. The real first step is not creating `app/` -- it's finishing the extraction that already started by fixing the broken import graph. The standalone app extraction should build on a working codebase, not one with 20+ dangling imports.

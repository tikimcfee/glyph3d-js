# Round 1: app-structure Reviews core-app-infrastructure & composition-extraction

## Errors Found

### E1. core-infrastructure places files in `examples/ide/` -- not `app/`

Core-infrastructure's Section 5 proposes `examples/ide/components/WorkbenchController.js`, `examples/ide/views/ExplorerViewController.js`, etc. The entire point of this extraction is to move OUT of `examples/`. My Phase 0 and composition-extraction both agree on `app/` at project root. This is not a cosmetic disagreement -- it determines every import path in the plan.

### E2. core-infrastructure references `websocket/CommandRouter.js` in `examples/github-viewer/`

Section 5 lists `CommandRouter.js`, `ViewerAPI.js`, and commands under `examples/github-viewer/websocket/`. But commit `7da0218` already moved CommandRouter, ViewerAPI, and WebSocketBridge to `src/services/orchestration/`. The files no longer exist at `examples/github-viewer/websocket/CommandRouter.js` (confirmed: `ls` returns "No such file"). Core-infrastructure's wiring diagram in Section 4 (line 252-255) builds a `CommandRouter` from the wrong location.

### E3. composition-extraction lists CommandRouter/WebSocketBridge/ViewerAPI for move to `app/lib/`

Lines 53-55 of composition-extraction propose moving these three to `app/lib/`, then hedge with "(or leave in src/orchestration/)". They are already in `src/services/orchestration/` and exported via its barrel. They must NOT be moved again. The file movement table should delete these three rows entirely.

### E4. composition-extraction says "No changes needed" for 6 component imports

Lines 20-25 claim Drawer.js, AppShell.js, LogCapturePanel.js, DiffPanel.js, MinimapOverlay.js, and TouchController.js need "No changes needed" when moved from `examples/github-viewer/components/` to `app/components/`. But GitHubRepoViewer.js imports them from `./components/` (line 24, 36-47 of GitHubRepoViewer.js). If they move to `app/components/` AND GitHubRepoViewer stays in examples (or moves to `app/lib/`), the relative paths break. Every import in GitHubRepoViewer.js that references `./components/` must be rewritten.

### E5. IDEShell.js imports `platform.js` from a path that no longer exists

`examples/ide/IDEShell.js` line 29: `import { primaryMod } from '../github-viewer/platform.js'`. This file was extracted to `src/services/utils/platform.js` in commit `7da0218` and deleted from `examples/github-viewer/`. The IDE is currently broken on this import. Composition-extraction does not flag this. Core-infrastructure does not mention it. The fix is trivial (`import { primaryMod } from 'glyph3d/services'` via importmap), but it must be tracked.

### E6. `websocket/index.js` has three broken imports

`examples/github-viewer/websocket/index.js` lines 10-12 import `CommandRouter`, `WebSocketBridge`, `ViewerAPI` from `./CommandRouter.js`, `./WebSocketBridge.js`, `./ViewerAPI.js`. These files no longer exist here. This file is broken right now. Composition-extraction proposes moving it to `app/lib/initCommandCenter.js` but does not note the broken state or specify the corrected import paths.

## Gaps

### G1. Neither plan accounts for `CommandBar.js`

`examples/ide/components/CommandBar.js` is a significant file (16KB) that imports from two broken paths: `../../github-viewer/platform.js` (line 16) and `../../github-viewer/websocket/commands/encoding.js` (line 18). Composition-extraction's file movement table omits it entirely. Core-infrastructure does not mention it. This component is wired into `ide.html` (line 183) and is critical to the IDE.

### G2. Missing: what happens to `examples/github-viewer/` after extraction

Composition-extraction's "What Gets Deleted" section (lines 213-221) says to delete almost everything from `examples/github-viewer/`. But `examples/github-viewer/index.html` (the standalone viewer) presumably should still work. Neither plan defines what a minimal working `examples/github-viewer/` looks like post-extraction, or whether it becomes a dead directory.

### G3. Neither plan inventories the `src/` imports within command modules

Command files import from `../../../../src/collections/CodeGrid.js` (gridCommands.js:7), `../../../../src/collections/TerminalGrid.js` (terminalCommands.js:24), and `../TUIFormatter.js` (12 of 16 command modules). If commands move to `app/commands/`, the `../../../../src/` paths become `../../src/` and the `../TUIFormatter.js` paths become `../lib/TUIFormatter.js`. Neither plan provides a complete rewrite table for these.

### G4. `SceneRegistry` import in GitHubRepoViewer.js

Line 51: `import SceneRegistry from './websocket/SceneRegistry.js'`. SceneRegistry was moved to `src/services/SceneRegistry.js` in commit `7da0218`. The old path does not exist. This is another currently-broken import not flagged by either plan.

## Tensions

### T1. core-infrastructure wants a gradual transition; composition-extraction wants a clean move

Core-infrastructure proposes Phase 0.1 keeping IDEShell wrapped inside WorkbenchController, Phase 0.2 migrating panels one by one, Phase 1 retiring IDEShell. Composition-extraction proposes moving everything at once into `app/` with a `compose-app.js`. User explicitly said "NO compat layers -- clean break, git has history." Core-infrastructure's phased approach with `IDEShell` as a "thin compatibility layer" (Section 8, line 357) contradicts this directive.

### T2. `compose-app.js` vs `bootstrap.js`

Composition-extraction names the entry point `compose-app.js`. My Phase 0 names it `bootstrap.js`. Core-infrastructure names it `main.js`. Three different names for the same file. This needs a single decision. I recommend `main.js` -- it is the most universal convention and matches `<script type="module" src="./main.js">`.

### T3. Where commands live: `app/commands/` vs registering on a router from src/

Composition-extraction correctly argues commands are app-specific (Section "Key Design Decisions" #1). Core-infrastructure's CommandRouter pattern (Section 3) assumes commands register from `websocket/commands/*.js`. Both agree commands are not reusable library code, but they disagree on whether the command context bag is built by a composition root (`compose-app.js`) or extracted from a viewer instance (`editor.getRegistry()`). The real answer is both: `buildContext()` from `websocket/index.js` constructs the bag from the viewer, and the composition root calls it.

### T4. Whether GitHubRepoViewer moves to `app/`

Composition-extraction moves it to `app/lib/GitHubRepoViewer.js`. My Phase 0 keeps it in `examples/github-viewer/` and imports it via importmap alias `github-viewer/GitHubRepoViewer.js`. The question is whether we want the viewer to remain an independent example or become part of the app. Given the user wants a clean break, moving it into `app/lib/` makes sense -- but only if we also move or fix ALL its 15+ import paths.

## Recommendations

1. **Settle on `app/` at project root** as the target directory. Delete core-infrastructure's `examples/ide/` proposals.

2. **Fix the 6 broken imports first** (IDEShell.js:29, CommandBar.js:16, CommandBar.js:18, websocket/index.js:10-12, GitHubRepoViewer.js:51) before moving any files. These are broken NOW on the experiment branch.

3. **Drop all compat shim files** (my Phase 0's `platform-compat.js`, `encoding-compat.js`). User said no compat layers. Instead, rewrite imports directly: `import { primaryMod } from '../../src/services/utils/platform.js'` or via importmap bare specifier `'glyph3d/services'`.

4. **Move `encoding.js` to `app/commands/`** alongside the other command utilities. It is only imported by CommandBar.js and command modules. It belongs with them.

5. **Adopt `main.js`** as the entry point name. Move `buildContext()` and `initCommandCenter()` logic into it (or a co-located `initCommandCenter.js`). Do not create `compose-app.js` -- one orchestrator file is enough.

6. **Do NOT create WorkbenchController/EditorController/SidebarViewController** in Phase 0. Core-infrastructure's full ViewController pattern is premature. IDEShell already works. Extract to ViewController pattern in a later phase when we have a concrete need (e.g., pluggable panels).

7. **Keep `examples/github-viewer/` functional** by leaving a minimal working viewer that imports from `src/services/` with corrected paths. Move `websocket/commands/`, `websocket/index.js`, and TUI files to `app/`. Leave `GitHubRepoViewer.js`, `StatePersistence.js`, `components/`, and `websocket/` (now containing only an updated `index.js` re-exporting from src) as the standalone example.

8. **Create the complete import rewrite table** before touching files. Command modules have 18 cross-directory imports (to `../TUIFormatter.js`, `../../../../src/collections/*.js`, etc.) that must all be enumerated and verified.

9. **Remove CommandRouter/WebSocketBridge/ViewerAPI from composition-extraction's move table** (rows 53-55). They are in `src/services/orchestration/` and stay there.

10. **Track CommandBar.js explicitly** in the file movement table. It is 16KB, has 2 broken imports, and is the IDE's primary input surface.

## Key Insight

Both plans treat this extraction as a forward-looking architecture exercise, but the codebase is in a half-migrated state right now. Commit `7da0218` moved 21 services to `src/services/` but intentionally did NOT update imports in `examples/`. This means `GitHubRepoViewer.js`, `websocket/index.js`, `IDEShell.js`, and `CommandBar.js` all have broken imports today. The first action is not "design a new architecture" -- it is "fix the broken imports so we have a working baseline to extract from." Any file-move plan built on top of currently-broken paths will compound errors. Fix first, then move.

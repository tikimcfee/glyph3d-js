# Round 1: migration-path reviews ownership-boundaries, server-socket

## Errors Found

### 1. My own plan incorrectly classifies MinimapOverlay as IDE-only (SELF-CORRECTION)

My Phase 0 output (phase0-migration-path.md, line 76) lists `MinimapOverlay.js` as IDE-specific and schedules it for `git mv` to `examples/ide/`. This is **wrong**. `GitHubRepoViewer.js` line 24 imports it directly:

```javascript
import { MinimapOverlay } from './components/MinimapOverlay.js';
```

And instantiates it at line 324. The standalone viewer uses MinimapOverlay without any IDE involvement. The ownership-boundaries agent correctly classifies it as "Viewer" (phase0-component-ownership.md line 28). **MinimapOverlay must NOT be moved.** This reduces the move set from 7 files to 6.

### 2. My plan to move ws-relay.mjs/ws-relay.py to examples/ide/ is wrong

My Phase 0 (lines 114-117) proposes moving both relay servers to `examples/ide/`. The server-socket agent correctly identifies why this fails (phase0-server-socket.md, Section 1): the relay is **display-side infrastructure**, not IDE-side. The standalone viewer calls `initCommandCenter()` in `GitHubRepoViewer.js:357`, which creates a `WebSocketBridge` that connects to the relay as `"DISPLAY"`. Moving the relay to ide/ would create a confusing dependency where the standalone viewer's npm scripts point into the IDE directory.

The relay stays in `examples/github-viewer/`. The npm scripts in `package.json` lines 21-23 remain unchanged. This removes 2 more files from the move set, bringing it to **4 files**: IDEShell.js, ide.html, ide.css, CommandBar.js.

### 3. ownership-boundaries misclassifies Drawer.js imports in IDEShell

The dependency graph (phase0-dependency-graph.md, line 46) says Drawer.js imports `(none)`. But `Drawer.js` exports `DrawerController` which is a class -- it has no upstream imports, that part is true. However the graph says IDEShell.js imports from `./components/Drawer.js` at "lines 21-26." Checking the actual file, `IDEShell.js` lines 20-26 import `repoPanelHTML, filesPanelHTML, settingsPanelHTML, statsPanelHTML, controlsPanelHTML` from Drawer.js. The line reference is off by one but functionally correct. Minor inaccuracy, not a blocker.

### 4. server-socket proposes moving AgentWindow/AgentWindowManager to IDE -- unnecessary scope creep

Phase0-server-socket.md Section 4 (lines 173-184) recommends moving `cli/AgentWindow.mjs` and `cli/AgentWindowManager.mjs` to `ide/cli/`. These files are **not imported by IDEShell, ide.html, or CommandBar**. They are standalone Node.js scripts used by the cross-ref system's agent-hook. Moving them solves no separation problem and introduces a new fragile import chain. They should stay in `github-viewer/cli/`.

## Gaps

### Covered by ownership-boundaries, missed by me:
- **SelectionManager's `file-selected` CustomEvent** as the IDE integration bridge (phase0-component-ownership.md line 37, lines 69-80). My plan focuses on file moves and import rewrites but never documents how IDEShell receives viewer events post-separation. This event-based coupling is the reason the separation works cleanly.

### Covered by server-socket, missed by me:
- **CliConnection as a shared protocol client** (phase0-server-socket.md Section 3). I treated the CLI directory as a monolith. The server-socket agent correctly identifies that CliConnection is the portable building block, and that future IDE CLI tools would need it.
- **CommandRouter as a shared protocol hub** (Section 5). My plan doesn't address what happens when IDE wants to register its own commands vs. viewer-only commands.

### Covered by me, missed by others:
- **ide.css `url()` safety check** (phase0-migration-path.md, line 200). I flagged the risk of CSS relative path breakage. Neither other agent mentions it. Verified: `ide.css` line 791 uses only an inline `data:image/svg+xml` URI, so this is safe.
- **examples/ide/index.html redirect stub** that currently points to `../github-viewer/ide.html`. After migration, this redirect must update to `./ide.html`. Neither other agent mentions this file.
- **examples/index.html landing page update** (my Phase 3). The main examples page needs a new card or updated link. Missed by both other agents.

## Tensions

### 1. ws-relay ownership: migration-path vs. server-socket

My plan (phase0-migration-path.md lines 114-117, 161-163) says move ws-relay to ide/. Server-socket (phase0-server-socket.md Section 1, lines 46-58) says keep in github-viewer/. **Server-socket is correct.** The relay is consumed by `WebSocketBridge` inside `GitHubRepoViewer`, which runs in both index.html and ide.html contexts. The relay is viewer infrastructure that the IDE happens to also use.

### 2. CommandBar location in import chain

Ownership-boundaries (phase0-component-ownership.md line 189) states "IDEShell does NOT import CommandBar. The command bar is currently initialized inside GitHubRepoViewer for IDE environments, creating a layering violation." This is **partially wrong**. CommandBar is NOT initialized inside GitHubRepoViewer. Grep confirms zero references in `GitHubRepoViewer.js`. It is initialized in `ide.html` lines 230-234, which is the IDE entry point, not the viewer. There is no layering violation -- the IDE entry point correctly owns the CommandBar instantiation.

### 3. Scope of the move: 12 files (my plan) vs. 1-2 files (ownership-boundaries)

My Phase 0 (line 13) says "Move 12 IDE-specific files." Ownership-boundaries recommends moving only CommandBar.js (line 263). After corrections in this review, the correct set is **4 files**: IDEShell.js, ide.html, ide.css, CommandBar.js. My count was inflated by incorrectly including MinimapOverlay (viewer-shared), ws-relay.mjs/py (viewer infrastructure), and counting sub-operations as separate files.

## Recommendations

1. **Remove MinimapOverlay from the move set.** It is imported by `GitHubRepoViewer.js:24` and must stay in `examples/github-viewer/components/`.

2. **Remove ws-relay.mjs and ws-relay.py from the move set.** Keep them in `examples/github-viewer/`. Do NOT update npm scripts for relay paths.

3. **Final move set is 4 files:**
   ```bash
   git mv examples/github-viewer/IDEShell.js examples/ide/IDEShell.js
   git mv examples/github-viewer/ide.html examples/ide/ide.html
   git mv examples/github-viewer/ide.css examples/ide/ide.css
   mkdir -p examples/ide/components
   git mv examples/github-viewer/components/CommandBar.js examples/ide/components/CommandBar.js
   ```

4. **Import rewrites for moved files (6 total):**
   - IDEShell.js: 4 paths (`./components/Drawer.js` etc. become `../github-viewer/components/Drawer.js` etc.)
   - ide.html: 2 paths (`./GitHubRepoViewer.js` becomes `../github-viewer/GitHubRepoViewer.js`, `./components/Drawer.js` becomes `../github-viewer/components/Drawer.js`)
   - CommandBar.js: 2 paths (`../platform.js` becomes `../../github-viewer/platform.js`, `../websocket/commands/encoding.js` becomes `../../github-viewer/websocket/commands/encoding.js`)

5. **Update examples/ide/index.html** to redirect to `./ide.html` instead of `../github-viewer/ide.html`.

6. **Add IDE card to examples/index.html** landing page so users can discover the IDE entry point.

7. **Do NOT move any cli/ files.** AgentWindow, AgentWindowManager, CliConnection, glyph-cli, agent-hook all stay in `github-viewer/cli/`. They are not IDE-specific; they are protocol tools.

8. **Document the `file-selected` CustomEvent contract** somewhere in the moved IDEShell.js (or a comment in ide.html). This is the invisible bridge between viewer and IDE that makes separation possible.

9. **Keep CommandBar.js in its own components/ subdirectory** under `examples/ide/` rather than flattening it to `examples/ide/CommandBar.js` (as my Phase 0 proposed). This preserves the import structure: CommandBar uses `../platform.js` which becomes `../../github-viewer/platform.js` -- more legible if it stays in `components/`.

10. **Verify post-move:** `grep -r "from '\./" examples/ide/` should return only `ide.html` importing from `./IDEShell.js` and `./components/CommandBar.js`. All other imports should reference `../github-viewer/`.

## Key Insight

The separation is smaller than any of us initially estimated. After correcting for MinimapOverlay (viewer-shared, not IDE-only) and ws-relay (viewer infrastructure, not IDE infrastructure), the actual move is **4 files and 8 import rewrites**. The clean cut exists because IDEShell is genuinely a thin wrapper: it imports HTML builder functions from shared components, receives viewer events via window CustomEvents, and delegates all rendering/command/websocket work back to GitHubRepoViewer. The relay, CLI tools, command protocol, and MinimapOverlay all belong to the viewer layer. Trying to claim them for the IDE (as my original plan and server-socket's plan partially did) would create artificial cross-directory dependencies without actually improving modularity.

# Round 1: ownership-boundaries reviews server-socket, migration-path

## Errors Found

### 1. migration-path: MinimapOverlay is NOT IDE-only (WRONG to move it)

migration-path lists MinimapOverlay.js under "IDE-Specific (MOVE)" (line 76) and includes `git mv` for it (line 112). This is factually incorrect. MinimapOverlay is imported and instantiated by GitHubRepoViewer.js:

- `GitHubRepoViewer.js:24` — `import { MinimapOverlay } from './components/MinimapOverlay.js';`
- `GitHubRepoViewer.js:324` — `this.minimapOverlay = new MinimapOverlay({...});`
- IDEShell.js does NOT import MinimapOverlay at all (confirmed via grep).

Moving MinimapOverlay would break GitHubRepoViewer, which is the shared rendering kernel both examples depend on. MinimapOverlay must stay in `github-viewer/components/`.

### 2. migration-path: "13 relative imports in IDEShell.js" is wrong

migration-path claims "13 relative imports in IDEShell.js" (line 86). The actual count is **4 import paths** (lines 20-29): `./components/Drawer.js`, `./components/LogCapturePanel.js`, `./components/DiffPanel.js`, `./platform.js`. The Drawer import is multi-line (5 named exports) but it is a single path. After the move, 4 paths need rewriting, not 13. The Phase 2 section (lines 128-131) correctly lists 4, contradicting the earlier claim.

### 3. migration-path: Moving ws-relay to IDE is wrong

migration-path proposes `git mv examples/github-viewer/ws-relay.mjs examples/ide/ws-relay.mjs` (line 115-116). server-socket correctly identifies that the relay is a display-side concern (Section 1). But more importantly: the relay is protocol infrastructure used by BOTH examples. The github-viewer's index.html viewer also uses it (via WebSocketBridge connecting to the same relay). Moving it to `examples/ide/` implies IDE ownership, which is inaccurate -- the relay serves any client that speaks the protocol.

server-socket's recommendation to keep relay in github-viewer is closer to correct, but neither agent identifies the ideal position: the relay should stay put for now since it has no import dependencies on either example's code.

### 4. server-socket: initCommandCenter line reference is garbled

server-socket writes "Builds context from viewer (line 131-119)" (Section 5). The range is inverted. The actual flow: `buildContext()` is defined at lines ~75-119, `initCommandCenter()` starts at line 131. Minor but sloppy for a technical review.

### 5. server-socket: WebSocketBridge constructor line is wrong

server-socket says `constructor()` is at line 24. The actual constructor starts at line 24 of the class body, but the `export default class` is at line 15, and the constructor with its parameters begins at line 24. This is technically correct but the table claims it handles "LAN detection, status bar setup" -- the LAN detection is in `_detectLanAddress()` called from constructor, but status bar setup is in `_createStatusBar()` called only if `showStatus` is true. Not an error per se, but misleading.

## Gaps

### What I covered that others missed

- **MinimapOverlay is shared** -- my Phase 0 identified this (GitHubRepoViewer.js line 24). migration-path gets this wrong. server-socket does not mention MinimapOverlay at all.
- **Drawer.js as coupling point** -- neither agent discusses what makes the IDE-to-viewer boundary tricky. The Drawer exports (`repoPanelHTML`, `filesPanelHTML`, etc.) are HTML template strings that IDEShell.js injects into its own sidebar. This is the primary cross-example coupling, and both agents treat it as a trivial import-path rewrite.

### What others covered that I missed

- **server-socket's agent-hook.mjs and glyph-cli.mjs analysis** (Section 6) -- I did not analyze the CLI tooling in depth. server-socket correctly identifies these as reference implementations that should stay in github-viewer.
- **server-socket's TUI* classification** (Section 7) -- I did not call out TUIWindow/TUIWindowManager/TUIFocusManager/TUIFormatter as viewer-only. This is a useful inventory.
- **migration-path's git history preservation strategy** -- using `git mv` is the right call. I did not address version control mechanics.
- **migration-path's post-move grep validation** (line 320-323) -- practical and necessary. I did not propose a verification step.

## Tensions

### 1. ws-relay ownership: server-socket vs. migration-path

- **server-socket** (Section 1): "WebSocket relay servers must stay with github-viewer"
- **migration-path** (line 115-116): `git mv` relay to `examples/ide/`
- **migration-path rationale** (line 166): "The relay is part of IDE infrastructure"

**server-socket is correct.** The relay is protocol infrastructure, not IDE infrastructure. It routes messages between ANY display and ANY controller. The relay has zero imports from either example's application code -- it only uses `ws` and Node stdlib (`os.networkInterfaces`). Moving it to `examples/ide/` would misleadingly suggest the IDE owns it. Furthermore, github-viewer's standalone mode (without IDE) still needs the relay for CLI/agent control.

### 2. CliConnection placement: shared vs. move

- **server-socket** (Section 3): Three options listed (stay, move+symlink, create shared/). No firm recommendation.
- **migration-path**: Does not address CliConnection at all.

CliConnection should stay in `github-viewer/cli/` for now. It is a generic protocol client with no IDE-specific logic. If IDE needs it, it imports from `../github-viewer/cli/CliConnection.mjs`. Same pattern as the other shared imports.

### 3. Total file count to move

- **migration-path**: "Move 12 IDE-specific files" (executive summary, line 13), then "Total files moved: 7" (line 123). These contradict each other within the same document. The `git mv` block lists 7 files (IDEShell.js, ide.html, ide.css, CommandBar.js, MinimapOverlay.js, ws-relay.mjs, ws-relay.py).
- **My Phase 0**: Only 2 files are truly IDE-only (IDEShell.js, CommandBar.js).

After removing MinimapOverlay (shared) and ws-relay.mjs/.py (protocol infra), the correct move list is: **IDEShell.js, ide.html, ide.css, CommandBar.js** -- 4 files, of which 2 are JS modules and 2 are entry point/styling.

## Recommendations

1. **Do NOT move MinimapOverlay.js.** It is imported by GitHubRepoViewer.js:24. Moving it breaks the shared viewer. Remove it from migration-path's git mv list.

2. **Do NOT move ws-relay.mjs or ws-relay.py.** These are protocol infrastructure. Keep npm scripts pointing to `examples/github-viewer/ws-relay.mjs`. Both examples use the same relay.

3. **Move exactly 4 files:** `IDEShell.js`, `ide.html`, `ide.css`, `CommandBar.js`. These are the only files with zero reverse dependencies from github-viewer code.

4. **Rewrite exactly 8 import paths after the move:**
   - IDEShell.js: 4 paths (`./components/Drawer.js`, `./components/LogCapturePanel.js`, `./components/DiffPanel.js`, `./platform.js` all become `../github-viewer/...`)
   - CommandBar.js: 2 paths (`../platform.js` -> `../github-viewer/platform.js`, `../websocket/commands/encoding.js` -> `../github-viewer/websocket/commands/encoding.js`)
   - ide.html: 2 paths (`./GitHubRepoViewer.js` -> `../github-viewer/GitHubRepoViewer.js`, `./components/Drawer.js` -> `../github-viewer/components/Drawer.js`)

5. **Keep npm scripts unchanged.** The relay stays in github-viewer. Add one new script: `"ide": "python3 -m http.server 8000"` is already sufficient since everything is served statically.

6. **Replace the redirect in examples/ide/index.html** with the actual ide.html content (or a redirect to `./ide.html` once ide.html is local).

7. **Leave CliConnection, AgentWindow, AgentWindowManager in github-viewer/cli/.** If the IDE needs them, it imports cross-directory. No duplication, no symlinks.

8. **Add post-move validation grep** (credit: migration-path): `grep -r "from '\.\/" examples/ide/` should return zero results after all rewrites. Any match indicates a dangling local import.

9. **server-socket should firm up its CliConnection recommendation** instead of listing three options. The answer is: keep it where it is, import cross-directory.

10. **migration-path's "Should examples/shared/ Exist?" analysis (line 227) is correct: no.** github-viewer acts as the de facto shared library. Do not create a third directory.

## Key Insight

The most consequential error across both analyses is migration-path's inclusion of MinimapOverlay.js and ws-relay in the move set. These two mistakes would break the standalone github-viewer (MinimapOverlay import failure) and misattribute protocol infrastructure to the IDE. The actual separation is smaller than either agent proposed: only 4 files need to move, and only 8 import paths need rewriting. The IDE shell is genuinely thin -- it is an orchestration layer over shared components, and the separation should reflect that thinness rather than trying to give the IDE its own copy of shared infrastructure.

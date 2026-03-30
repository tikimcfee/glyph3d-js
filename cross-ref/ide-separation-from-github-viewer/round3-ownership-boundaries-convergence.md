# Round 3: ownership-boundaries convergence

## Settled

All three agents converged on the same conclusions after Round 1 cross-review. Every substantive disagreement has been resolved.

1. **MinimapOverlay stays in github-viewer.** All three agents agree (migration-path self-corrected). `GitHubRepoViewer.js` line 24 imports it; moving it would break the standalone viewer.

2. **ws-relay.mjs and ws-relay.py stay in github-viewer.** All three agents agree (migration-path self-corrected). The relay is display-side protocol infrastructure with zero IDE-specific logic. `package.json` npm scripts (lines 21-23) remain unchanged.

3. **Exactly 4 files move to examples/ide/.** IDEShell.js, ide.html, ide.css, CommandBar.js. These are the only files with zero reverse dependencies from github-viewer code (verified: only `ide.html` imports IDEShell.js and CommandBar.js; no other file in github-viewer references either).

4. **Exactly 8 import paths need rewriting.** 4 in IDEShell.js, 2 in ide.html, 2 in CommandBar.js. All three agents converged on this count.

5. **No examples/shared/ directory.** The github-viewer directory serves as the de facto shared library. Creating a third directory adds complexity without solving a real problem.

6. **cli/ files (AgentWindow, AgentWindowManager, CliConnection, glyph-cli, agent-hook) stay in github-viewer/cli/.** They are protocol tooling, not IDE-specific modules. If the IDE needs them, it imports cross-directory.

7. **CommandBar belongs in examples/ide/components/, not flattened to examples/ide/.** This preserves the `../` relative path structure and keeps the import chain legible after rewriting.

8. **The CommandBar layering violation claim is retracted.** CommandBar is correctly initialized in `ide.html` lines 227-235, not inside GitHubRepoViewer. The composition root pattern (`ide.html` wires IDE components to viewer internals) is clean architecture.

9. **TUIFormatter.js is core websocket infrastructure.** It is imported by 12 of 13 command modules. The dependency graph should include it alongside TUIWindow, TUIFocusManager, and TUIWindowManager. All TUI* files stay in github-viewer.

10. **The DrawerController shim (`viewer.drawer = ide.asDrawer()` at ide.html line 215) is a fragile integration seam.** It depends on `viewer.init()` creating a DrawerController first, then overwriting it. This contract should be documented but is not a blocker for the file move.

11. **examples/ide/index.html redirect must update** from `../github-viewer/ide.html` to `./ide.html` after the move.

12. **examples/index.html needs an IDE card** added to the landing page so users can discover the IDE entry point.

13. **Post-move validation**: `grep -r "from '\./" examples/ide/` should match only `./IDEShell.js` and `./components/CommandBar.js` in ide.html. All other imports should reference `../github-viewer/`.

## Implementation Plan

### Prerequisites

Verify clean working tree:
```bash
cd /home/user/dev/glyph3d-js
git status
```

### Step 1: Create directory structure

```bash
mkdir -p examples/ide/components
```

### Step 2: Move files with git mv (4 files)

```bash
git mv examples/github-viewer/IDEShell.js examples/ide/IDEShell.js
git mv examples/github-viewer/ide.html examples/ide/ide.html
git mv examples/github-viewer/ide.css examples/ide/ide.css
git mv examples/github-viewer/components/CommandBar.js examples/ide/components/CommandBar.js
```

### Step 3: Rewrite imports in IDEShell.js (4 paths)

File: `examples/ide/IDEShell.js`

**Line 26** -- Drawer.js import (multi-line, spans lines 20-26):
```
old: } from './components/Drawer.js';
new: } from '../github-viewer/components/Drawer.js';
```

**Line 27** -- LogCapturePanel.js import:
```
old: import { logCapturePanelHTML } from './components/LogCapturePanel.js';
new: import { logCapturePanelHTML } from '../github-viewer/components/LogCapturePanel.js';
```

**Line 28** -- DiffPanel.js import:
```
old: import { diffPanelHTML } from './components/DiffPanel.js';
new: import { diffPanelHTML } from '../github-viewer/components/DiffPanel.js';
```

**Line 29** -- platform.js import:
```
old: import { primaryMod } from './platform.js';
new: import { primaryMod } from '../github-viewer/platform.js';
```

### Step 4: Rewrite imports in ide.html (2 paths)

File: `examples/ide/ide.html`

**Line 180** -- GitHubRepoViewer.js import:
```
old: import { GitHubRepoViewer } from './GitHubRepoViewer.js';
new: import { GitHubRepoViewer } from '../github-viewer/GitHubRepoViewer.js';
```

**Line 181** -- Drawer.js import:
```
old: import { DrawerController } from './components/Drawer.js';
new: import { DrawerController } from '../github-viewer/components/Drawer.js';
```

Lines 182-183 (`./IDEShell.js`, `./components/CommandBar.js`) remain unchanged -- both files moved alongside ide.html.

### Step 5: Rewrite imports in CommandBar.js (2 paths)

File: `examples/ide/components/CommandBar.js`

**Line 16** -- platform.js import:
```
old: import { primaryMod } from '../platform.js';
new: import { primaryMod } from '../../github-viewer/platform.js';
```

**Line 18** -- encoding.js import:
```
old: import { encodeBase64 } from '../websocket/commands/encoding.js';
new: import { encodeBase64 } from '../../github-viewer/websocket/commands/encoding.js';
```

### Step 6: Update examples/ide/index.html redirect

File: `examples/ide/index.html`

**Line 4** -- meta refresh:
```
old: <meta http-equiv="refresh" content="0; url=../github-viewer/ide.html">
new: <meta http-equiv="refresh" content="0; url=./ide.html">
```

**Line 8** -- fallback link:
```
old: <p>Redirecting to <a href="../github-viewer/ide.html">glyph3d IDE</a>...</p>
new: <p>Redirecting to <a href="./ide.html">glyph3d IDE</a>...</p>
```

### Step 7: Add IDE card to examples/index.html

File: `examples/index.html`

Insert after line 113 (closing `</a>` of the GitHub Repo Viewer card):

```html
        <a href="ide/" class="example-card">
            <h2>IDE Shell</h2>
            <p>
                VS Code-like IDE layout wrapping the GitHub viewer. Activity bar,
                sidebar panels, tab bar, status bar, command bar, and resizable
                bottom panel with log capture and diff views.
            </p>
            <span class="tag">ide</span>
            <span class="tag">layout</span>
            <span class="tag">commands</span>
        </a>
```

### Step 8: Verify no dangling local imports

```bash
grep -r "from '\./" examples/ide/
```

Expected output (only these two, both in ide.html):
```
examples/ide/ide.html:        import { IDEShell } from './IDEShell.js';
examples/ide/ide.html:        import CommandBar from './components/CommandBar.js';
```

### Step 9: Verify no broken imports in github-viewer

```bash
grep -r "IDEShell\|CommandBar\|ide\.html\|ide\.css" examples/github-viewer/
```

Expected output: zero matches (all references have been moved out).

### Step 10: Functional smoke test

```bash
npm run serve
```

Then open:
- `http://localhost:8000/examples/github-viewer/` -- standalone viewer, must work without any IDE files
- `http://localhost:8000/examples/ide/` -- IDE shell, redirect should land on ide.html
- `http://localhost:8000/examples/ide/ide.html` -- IDE shell direct, must load and render

### Step 11: Commit

```bash
git add examples/ide/ examples/index.html
git commit -m "Separate IDE shell into examples/ide/

Move IDEShell.js, ide.html, ide.css, and CommandBar.js out of
examples/github-viewer/ into examples/ide/. Rewrite 8 import paths
to reference shared components via ../github-viewer/. Update the
examples/ide/index.html redirect and add an IDE card to the examples
landing page.

No functional changes -- the IDE shell imports the same shared
components (Drawer, LogCapturePanel, DiffPanel, platform, encoding)
from their original locations in github-viewer/."
```

## Implementer Vote

**migration-path** should implement this plan. Rationale: migration-path's Phase 0 was the only analysis that provided concrete `git mv` commands, import rewrite tables, and a post-move validation checklist. Despite the MinimapOverlay and ws-relay errors (both self-corrected in Round 1), the migration-path agent demonstrated the strongest orientation toward executable implementation steps. The converged plan is essentially a corrected version of migration-path's original proposal -- same structure, same mechanics, just with the move set trimmed from 7 files to 4. That agent's existing mental model of the file-move workflow is closest to what needs to happen.

# Round 3: server-socket convergence

## Settled

All three agents converge on the following points after Round 1 cross-review. No open tensions remain.

1. **MinimapOverlay stays in github-viewer.** It is imported by `GitHubRepoViewer.js` line 24 and instantiated at line 324. Moving it breaks the standalone viewer. All three agents agree after migration-path self-corrected.

2. **ws-relay.mjs and ws-relay.py stay in github-viewer.** The relay is display-side protocol infrastructure, not IDE-specific. It routes messages between any "display" and any "controller" regardless of whether the display is index.html or ide.html. All three agents agree after migration-path self-corrected.

3. **Exactly 4 files move.** IDEShell.js, ide.html, ide.css, and CommandBar.js. These are the only files with zero reverse dependencies from github-viewer code. All three agents independently arrive at this number after corrections.

4. **CommandBar.js goes into examples/ide/components/ (not examples/ide/ root).** This preserves the components/ subdirectory convention and keeps import paths clean. CommandBar currently lives in `github-viewer/components/` and its internal imports use `../` to reach platform.js and websocket/. Under `ide/components/`, those become `../../github-viewer/` which is legible and consistent.

5. **cli/ files (AgentWindow, AgentWindowManager, CliConnection, glyph-cli, agent-hook) stay in github-viewer.** They are Node.js-side protocol tools, not IDE-specific. None are imported by IDEShell, ide.html, or CommandBar. Moving them solves no problem.

6. **No examples/shared/ directory.** github-viewer acts as the de facto shared library. Creating a third directory adds complexity without benefit at this scale.

7. **CommandBar has no layering violation.** It is initialized in ide.html's script block (lines 227-235), not inside GitHubRepoViewer. The ownership-boundaries claim about a layering violation was factually wrong; ide.html correctly acts as the composition root that wires IDE components to viewer internals.

8. **IDEShell.js has 4 import paths to rewrite, not 13.** The 4 paths are: `./components/Drawer.js` (line 20-26), `./components/LogCapturePanel.js` (line 27), `./components/DiffPanel.js` (line 28), `./platform.js` (line 29).

9. **ide.html has 2 import paths to rewrite (out of 4 total).** The 4 imports are at lines 180-183. Two (`GitHubRepoViewer.js`, `components/Drawer.js`) point to shared viewer code and need `../github-viewer/` prefixing. Two (`IDEShell.js`, `components/CommandBar.js`) point to files that also move into `examples/ide/` and remain local `./` imports.

10. **CommandBar.js has 2 import paths to rewrite.** Line 16: `../platform.js` and line 18: `../websocket/commands/encoding.js`. Both need an extra `../github-viewer/` prefix since CommandBar moves from `github-viewer/components/` to `ide/components/`.

11. **ide.css is safe to move.** The only `url()` reference (line 791) is an inline `data:image/svg+xml` URI. No relative file paths break.

12. **examples/ide/index.html redirect must update.** Currently redirects to `../github-viewer/ide.html` (line 4). After the move, ide.html lives in the same directory, so the redirect changes to `./ide.html`.

13. **examples/index.html needs an IDE card.** The landing page currently lists 6 examples but no IDE entry point. A card should be added linking to `ide/`.

14. **Post-move validation:** `grep -r "from '\./" examples/ide/` should return only ide.html importing `./IDEShell.js` and `./components/CommandBar.js`, and IDEShell.js should have zero `./` imports (all rewritten to `../github-viewer/`). Any other `./` match indicates a dangling local import.

15. **npm scripts unchanged.** The relay stays in github-viewer. The existing `npm run serve` (python3 HTTP server on port 8000) serves both examples without modification.

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

### Step 2: git mv the 4 files

```bash
git mv examples/github-viewer/IDEShell.js examples/ide/IDEShell.js
git mv examples/github-viewer/ide.html examples/ide/ide.html
git mv examples/github-viewer/ide.css examples/ide/ide.css
git mv examples/github-viewer/components/CommandBar.js examples/ide/components/CommandBar.js
```

### Step 3: Rewrite imports in IDEShell.js (4 paths)

**File:** `examples/ide/IDEShell.js`

Line 20-26 -- change:
```javascript
} from './components/Drawer.js';
```
to:
```javascript
} from '../github-viewer/components/Drawer.js';
```

Line 27 -- change:
```javascript
import { logCapturePanelHTML } from './components/LogCapturePanel.js';
```
to:
```javascript
import { logCapturePanelHTML } from '../github-viewer/components/LogCapturePanel.js';
```

Line 28 -- change:
```javascript
import { diffPanelHTML } from './components/DiffPanel.js';
```
to:
```javascript
import { diffPanelHTML } from '../github-viewer/components/DiffPanel.js';
```

Line 29 -- change:
```javascript
import { primaryMod } from './platform.js';
```
to:
```javascript
import { primaryMod } from '../github-viewer/platform.js';
```

### Step 4: Rewrite imports in CommandBar.js (2 paths)

**File:** `examples/ide/components/CommandBar.js`

Line 16 -- change:
```javascript
import { primaryMod } from '../platform.js';
```
to:
```javascript
import { primaryMod } from '../../github-viewer/platform.js';
```

Line 18 -- change:
```javascript
import { encodeBase64 } from '../websocket/commands/encoding.js';
```
to:
```javascript
import { encodeBase64 } from '../../github-viewer/websocket/commands/encoding.js';
```

### Step 5: Rewrite imports in ide.html (2 of 4 imports)

**File:** `examples/ide/ide.html`

Line 180 -- change:
```javascript
import { GitHubRepoViewer } from './GitHubRepoViewer.js';
```
to:
```javascript
import { GitHubRepoViewer } from '../github-viewer/GitHubRepoViewer.js';
```

Line 181 -- change:
```javascript
import { DrawerController } from './components/Drawer.js';
```
to:
```javascript
import { DrawerController } from '../github-viewer/components/Drawer.js';
```

Lines 182-183 remain unchanged (IDEShell.js and CommandBar.js move into ide/ alongside ide.html):
```javascript
import { IDEShell } from './IDEShell.js';          // stays ./
import CommandBar from './components/CommandBar.js'; // stays ./
```

### Step 6: Update examples/ide/index.html redirect

**File:** `examples/ide/index.html`

Line 4 -- change:
```html
<meta http-equiv="refresh" content="0; url=../github-viewer/ide.html">
```
to:
```html
<meta http-equiv="refresh" content="0; url=./ide.html">
```

Line 8 -- change:
```html
<p>Redirecting to <a href="../github-viewer/ide.html">glyph3d IDE</a>...</p>
```
to:
```html
<p>Redirecting to <a href="./ide.html">glyph3d IDE</a>...</p>
```

### Step 7: Add IDE card to examples/index.html

**File:** `examples/index.html`

After the GitHub Repo Viewer card (after line 113), insert:
```html
        <a href="ide/" class="example-card">
            <h2>IDE Shell</h2>
            <p>
                VS Code-like IDE layout wrapping the GitHub Repo Viewer.
                Activity bar, sidebar panels, tab bar, bottom panel,
                status bar, command bar, and keyboard shortcuts.
            </p>
            <span class="tag">ide</span>
            <span class="tag">layout</span>
            <span class="tag">commands</span>
        </a>
```

### Step 8: Post-move validation

```bash
# All ./  imports in ide/ should be only IDEShell and CommandBar from ide.html
grep -rn "from '\./" examples/ide/
# Expected output:
#   examples/ide/ide.html:182: ... from './IDEShell.js';
#   examples/ide/ide.html:183: ... from './components/CommandBar.js';
# (IDEShell.js should have ZERO ./ imports -- all rewritten to ../github-viewer/)
# (CommandBar.js should have ZERO ./ or ../ non-github-viewer imports)

# Verify standalone viewer still works (no broken imports)
grep -rn "MinimapOverlay" examples/github-viewer/GitHubRepoViewer.js
# Should still show line 24 import -- untouched

# Verify no dangling references to the old locations
grep -rn "github-viewer/IDEShell\|github-viewer/ide\.html\|github-viewer/ide\.css\|github-viewer/components/CommandBar" examples/
# Should return zero results (except cross-ref analysis docs)
```

### Summary of changes

| Action | File | Details |
|--------|------|---------|
| git mv | IDEShell.js | github-viewer/ -> ide/ |
| git mv | ide.html | github-viewer/ -> ide/ |
| git mv | ide.css | github-viewer/ -> ide/ |
| git mv | CommandBar.js | github-viewer/components/ -> ide/components/ |
| Edit | ide/IDEShell.js | Rewrite 4 import paths (lines 26, 27, 28, 29) |
| Edit | ide/components/CommandBar.js | Rewrite 2 import paths (lines 16, 18) |
| Edit | ide/ide.html | Rewrite 2 import paths (lines 180, 181) |
| Edit | ide/index.html | Update redirect URL (lines 4, 8) |
| Edit | examples/index.html | Add IDE card after line 113 |
| **Total** | **4 moved, 5 edited** | **8 import rewrites + 2 HTML link updates + 1 card addition** |

## Implementer Vote

**migration-path** should implement this.

Rationale: migration-path's Phase 0 was explicitly a file-by-file migration plan with git mv commands, import rewrite tables, and validation steps -- the exact shape of work needed here. After self-correcting the MinimapOverlay and ws-relay errors in Round 1, migration-path's revised plan (4 files, 8 import rewrites) matches the converged plan almost exactly, including the CommandBar components/ subdirectory structure and the post-move grep validation. The implementation is mechanical file-moving and path-rewriting, which is precisely what migration-path was designed to analyze and execute. ownership-boundaries' strength is classification, not execution, and my (server-socket) strength is protocol/relay analysis, neither of which are needed for the implementation step.

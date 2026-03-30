# Round 3: migration-path convergence

## Settled

All three agents (ownership-boundaries, server-socket, migration-path) converge on every major point after Round 1 corrections. No open disputes remain.

1. **MinimapOverlay stays in github-viewer.** All three agents agree (ownership correct from Phase 0; server-socket and migration-path both flag the Phase 0 migration-path error; migration-path self-corrects in Round 1). `GitHubRepoViewer.js` line 24 imports it; moving it breaks the standalone viewer.

2. **ws-relay.mjs and ws-relay.py stay in github-viewer.** All three agents converge (server-socket correct from Phase 0; ownership and migration-path agree in Round 1). The relay is display-side protocol infrastructure with zero IDE-specific logic. npm scripts in `package.json` lines 21-23 remain unchanged.

3. **Move set is exactly 4 files:** `IDEShell.js`, `ide.html`, `ide.css`, `CommandBar.js`. All three agents agree on this final count after corrections. These are the only files with zero reverse dependencies from github-viewer code (verified: `IDEShell` is referenced only in `ide.html` line 182; `CommandBar` only in `ide.html` line 183; `ide.css` only in `ide.html` line 7).

4. **IDEShell.js has 4 import paths, not 13.** All three agents converge. The 4 paths are at lines 20-26 (`./components/Drawer.js`), 27 (`./components/LogCapturePanel.js`), 28 (`./components/DiffPanel.js`), 29 (`./platform.js`).

5. **CommandBar.js has 2 import paths.** Line 16 (`../platform.js`) and line 18 (`../websocket/commands/encoding.js`). All agents agree these rewrite to `../../github-viewer/...` paths.

6. **ide.html has 4 import paths** in its `<script type="module">` block. Line 180 (`./GitHubRepoViewer.js`), line 181 (`./components/Drawer.js`), line 182 (`./IDEShell.js`), line 183 (`./components/CommandBar.js`). After the move, lines 180-181 become `../github-viewer/...` paths; lines 182-183 become local `./...` paths since IDEShell and CommandBar move with ide.html.

7. **ide.html line 7 CSS link** (`href="ide.css"`) stays as-is since `ide.css` moves alongside `ide.html`.

8. **cli/ files (AgentWindow, AgentWindowManager, CliConnection, glyph-cli, agent-hook) stay in github-viewer.** All three agents agree. They are protocol tools with no IDE imports.

9. **No examples/shared/ directory needed.** All three agents agree. github-viewer acts as the de facto shared library.

10. **CommandBar has no layering violation.** Server-socket and migration-path both confirm: `CommandBar` is instantiated in `ide.html` lines 230-234, not inside `GitHubRepoViewer.js`. Ownership-boundaries' claim of a layering violation is incorrect; `ide.html` is a proper composition root.

11. **examples/ide/index.html redirect must update.** Currently line 4 redirects to `../github-viewer/ide.html`. After the move, `ide.html` will be local, so this either becomes `./ide.html` or the redirect file is replaced entirely by the moved `ide.html`.

12. **examples/index.html needs an IDE card.** Currently missing (verified: the landing page at `examples/index.html` has cards for github-viewer, code-spectrometer, word-wall, mod-layer-visualizer, hand-tracking, render-test, but no IDE entry).

13. **Post-move validation via grep.** `grep -r "from '\./" examples/ide/` should return only matches for `./IDEShell.js` and `./components/CommandBar.js` (both in ide.html). All other `from './` imports would indicate broken paths.

## Implementation Plan

### Step 0: Create target directory structure

```bash
mkdir -p examples/ide/components
```

### Step 1: Move 4 files with git history preservation

```bash
git mv examples/github-viewer/IDEShell.js examples/ide/IDEShell.js
git mv examples/github-viewer/ide.html examples/ide/ide.html
git mv examples/github-viewer/ide.css examples/ide/ide.css
git mv examples/github-viewer/components/CommandBar.js examples/ide/components/CommandBar.js
```

### Step 2: Rewrite imports in IDEShell.js (4 paths)

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

### Step 3: Rewrite imports in CommandBar.js (2 paths)

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

### Step 4: Rewrite imports and references in ide.html (3 edits)

**File:** `examples/ide/ide.html`

Line 7 -- NO CHANGE needed (`href="ide.css"` remains valid since ide.css is co-located).

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

Lines 182-183 -- NO CHANGE needed. `./IDEShell.js` and `./components/CommandBar.js` are now local to `examples/ide/`.

### Step 5: Replace the redirect stub

**File:** `examples/ide/index.html`

The `git mv` of `ide.html` into `examples/ide/` means there are now two HTML files in that directory: the redirect `index.html` and the actual `ide.html`. Two options:

**Option A (preferred):** Update the redirect to point locally.

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

**Option B (alternative):** Delete `index.html` and rename `ide.html` to `index.html`. This is cleaner but changes the filename, which affects any bookmarks or documentation referencing `ide.html`. The redirect approach is safer for now.

### Step 6: Add IDE card to examples landing page

**File:** `examples/index.html`

After line 113 (closing `</a>` of the github-viewer card), insert:

```html

        <a href="ide/" class="example-card">
            <h2>IDE Shell</h2>
            <p>
                VS Code-like IDE layout wrapping the GitHub Repo Viewer.
                Activity bar, sidebar panels, tab bar, command bar,
                status bar, and keyboard shortcuts.
            </p>
            <span class="tag">ide</span>
            <span class="tag">panels</span>
            <span class="tag">commands</span>
        </a>
```

### Step 7: Post-move validation

```bash
# All imports in examples/ide/ should reference ../github-viewer/ or local ./ files
grep -rn "from '\.\/" examples/ide/

# Expected results (only local imports):
#   ide.html:182: import { IDEShell } from './IDEShell.js';
#   ide.html:183: import CommandBar from './components/CommandBar.js';
# Any other match = broken import that needs rewriting.

# Verify standalone viewer is unbroken (no references to moved files)
grep -rn "IDEShell\|CommandBar\|ide\.html\|ide\.css" examples/github-viewer/
# Expected: zero results. If anything matches, the separation is incomplete.

# Verify no dangling references to the old locations
grep -rn "github-viewer/IDEShell\|github-viewer/ide\.html\|github-viewer/ide\.css\|github-viewer/components/CommandBar" examples/
# Expected: zero results (the redirect stub was already updated).
```

### Summary table

| Action | File | Lines affected |
|--------|------|---------------|
| `git mv` | `IDEShell.js` | -- |
| `git mv` | `ide.html` | -- |
| `git mv` | `ide.css` | -- |
| `git mv` | `components/CommandBar.js` | -- |
| Rewrite imports | `examples/ide/IDEShell.js` | 26, 27, 28, 29 |
| Rewrite imports | `examples/ide/components/CommandBar.js` | 16, 18 |
| Rewrite imports | `examples/ide/ide.html` | 180, 181 |
| Update redirect | `examples/ide/index.html` | 4, 8 |
| Add card | `examples/index.html` | after 113 |

**Total: 4 files moved, 8 import paths rewritten, 2 redirect paths updated, 1 card added.**

## Implementer Vote

**ownership-boundaries** should implement this.

Rationale: The ownership-boundaries agent had the most accurate Phase 0 classification from the start -- it correctly identified MinimapOverlay as viewer-owned, correctly classified the component boundaries, and its dependency graph (despite the minor TUIFormatter omission) provides the clearest structural understanding of which files belong where. The converged plan is essentially the ownership-boundaries position with migration-path's file-move mechanics applied. The implementation is predominantly about knowing what NOT to move (the bulk of the corrections were trimming migration-path's over-eager move set), and ownership-boundaries demonstrated that judgment most reliably. Server-socket's strength is protocol/relay analysis, which is settled and requires no implementation changes.

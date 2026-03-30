# Converged Implementation Plan: IDE Extraction to app/ide/

## Settled Points

1. **Destination is `app/ide/`, not `ide/` at root.** All three analyses and all three reviews converge on this. The root stays clean, the depth-2 relationship with `src/` is preserved (so `platform.js` imports in IDEShell.js and CommandBar.js remain unchanged), and the `app/` namespace accommodates future applications.

2. **5 files move.** `IDEShell.js`, `ide.html`, `ide.css`, `components/CommandBar.js`, `index.html`. The dependency-resolution Phase 0 listed 4 (omitting `index.html`); all reviews corrected this to 5.

3. **6 import paths change across 3 files.** IDEShell.js (3), ide.html (2), CommandBar.js (1). All three Phase 0 analyses stated inconsistent totals (5, 7, or both). All three Round 1 reviews converge on 6.

4. **`src/` imports do NOT change.** Both `platform.js` imports (IDEShell.js line 29 and CommandBar.js line 16) resolve identically from `app/ide/` as from `examples/ide/` because both are depth-2 from root.

5. **No redirect stub at `examples/ide/`.** File-moves argued against it; both other Round 1 reviews agreed. No external consumers, no published URL at the old path. A 404 is the correct signal.

6. **Remove the IDE card from `examples/index.html`.** The IDE is a production app, not an example. The root `index.html` already links to it. Keeping it in the examples gallery undermines the semantic separation that motivates this extraction.

7. **No importmap changes.** The `three` bare specifier resolves via absolute CDN URL. Directory depth is irrelevant.

8. **No CSS changes.** `ide.css` has no external `url()` references. The `<link href="ide.css">` in `ide.html` is a same-directory relative reference that works at any location.

9. **No change to the `/ide/` URL auto-load regex.** The regex `path.match(/\/ide\/([^\/]+)\/([^\/]+)(?:\/(.+))?/)` matches `/ide/` anywhere in the path. It works at both `localhost:8000/app/ide/` and `ivanlugo.dev/ide/`.

10. **Cross-ref docs are not updated.** They are historical analysis artifacts documenting the prior state.

11. **Caddy config update is a separate server-side task.** The Caddyfile is not in the repo. After the commit deploys, SSH into the host and update the path mapping from `examples/ide/` to `app/ide/`. The external URL `ivanlugo.dev/ide` does not change.

12. **`encoding.js` promotion to `src/utils/` is deferred.** The dependency-resolution agent identified this as a good refactor (pure utility with zero dependencies, buried in github-viewer's websocket directory). All reviews agreed it should not block this extraction.

## Exact Implementation Steps

### Step 1: Create directories

```bash
mkdir -p app/ide/components
```

### Step 2: Move files

```bash
git mv examples/ide/IDEShell.js       app/ide/IDEShell.js
git mv examples/ide/ide.html          app/ide/ide.html
git mv examples/ide/ide.css           app/ide/ide.css
git mv examples/ide/components/CommandBar.js  app/ide/components/CommandBar.js
git mv examples/ide/index.html        app/ide/index.html
```

Then clean up empty directories (git does not track directories):

```bash
rmdir examples/ide/components 2>/dev/null
rmdir examples/ide 2>/dev/null
```

### Step 3: Fix imports in IDEShell.js

File: `app/ide/IDEShell.js`

3 imports change. All are github-viewer references that need `../../examples/` instead of `../`.
The `platform.js` import on line 29 does NOT change.

**Line 26** -- Drawer.js:
```
OLD: } from '../github-viewer/components/Drawer.js';
NEW: } from '../../examples/github-viewer/components/Drawer.js';
```

**Line 27** -- LogCapturePanel.js:
```
OLD: import { logCapturePanelHTML } from '../github-viewer/components/LogCapturePanel.js';
NEW: import { logCapturePanelHTML } from '../../examples/github-viewer/components/LogCapturePanel.js';
```

**Line 28** -- DiffPanel.js:
```
OLD: import { diffPanelHTML } from '../github-viewer/components/DiffPanel.js';
NEW: import { diffPanelHTML } from '../../examples/github-viewer/components/DiffPanel.js';
```

**Line 29** -- platform.js (UNCHANGED):
```
import { primaryMod } from '../../src/services/utils/platform.js';
```

### Step 4: Fix imports in CommandBar.js

File: `app/ide/components/CommandBar.js`

1 import changes. The `platform.js` import on line 16 does NOT change.

**Line 18** -- encoding.js:
```
OLD: import { encodeBase64 } from '../../github-viewer/websocket/commands/encoding.js';
NEW: import { encodeBase64 } from '../../../examples/github-viewer/websocket/commands/encoding.js';
```

**Path verification:**
`app/ide/components/CommandBar.js` is at depth 3 from project root.
- `../` -> `app/ide/`
- `../../` -> `app/`
- `../../../` -> project root
- `../../../examples/github-viewer/websocket/commands/encoding.js` -> `examples/github-viewer/websocket/commands/encoding.js`

This is THREE `../` segments. The Phase 0 dependency-resolution table (Section 3, Option A, row #6) incorrectly showed only two `../` segments (`../../examples/...`), which would resolve to `app/examples/...` (does not exist). The Round 1 file-moves review (line 11-13) caught this error. The correct path is `../../../examples/github-viewer/websocket/commands/encoding.js`.

**Line 16** -- platform.js (UNCHANGED):
```
import { primaryMod } from '../../../src/services/utils/platform.js';
```

### Step 5: Fix imports in ide.html

File: `app/ide/ide.html`

2 imports change in the inline `<script type="module">` block. The `three` bare specifier, `./IDEShell.js`, and `./components/CommandBar.js` do NOT change.

**Line 180** -- GitHubRepoViewer.js:
```
OLD: import { GitHubRepoViewer } from '../github-viewer/GitHubRepoViewer.js';
NEW: import { GitHubRepoViewer } from '../../examples/github-viewer/GitHubRepoViewer.js';
```

**Line 181** -- Drawer.js:
```
OLD: import { DrawerController } from '../github-viewer/components/Drawer.js';
NEW: import { DrawerController } from '../../examples/github-viewer/components/Drawer.js';
```

**Lines 179, 182, 183** (UNCHANGED):
```
import * as THREE from 'three';
import { IDEShell } from './IDEShell.js';
import CommandBar from './components/CommandBar.js';
```

### Step 6: Update external references

#### 6a. Root `index.html` (line 106)

```
OLD: <a class="card" href="examples/ide/">
NEW: <a class="card" href="app/ide/">
```

#### 6b. `examples/index.html` (lines 115-125) -- Remove the IDE card

Delete the entire card block:
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

#### 6c. `CLAUDE.md` -- Project Structure section

Add under the project structure:
```
app/
└── ide/                       # Production IDE shell (ivanlugo.dev/ide)
    ├── index.html             # Redirect to ide.html
    ├── ide.html               # Entry point (importmap, bootstrap)
    ├── ide.css                # All IDE styles
    ├── IDEShell.js            # Shell orchestrator
    └── components/
        └── CommandBar.js      # Unified command input surface
```

Remove any `ide/` reference from the `examples/` listing if present.

#### 6d. `package.json` -- `files` array (lines 23-26)

```json
OLD:
  "files": [
    "src",
    "examples"
  ],

NEW:
  "files": [
    "src",
    "examples",
    "app"
  ],
```

### Step 7: Validation

```bash
# 1. Verify all moved files exist at destination
test -f app/ide/IDEShell.js && echo "OK: IDEShell.js"
test -f app/ide/ide.html && echo "OK: ide.html"
test -f app/ide/ide.css && echo "OK: ide.css"
test -f app/ide/components/CommandBar.js && echo "OK: CommandBar.js"
test -f app/ide/index.html && echo "OK: index.html"

# 2. Verify old location is gone
test -d examples/ide && echo "FAIL: examples/ide still exists" || echo "OK: examples/ide removed"

# 3. Verify no file in the repo still imports from examples/ide/
grep -rn "from.*examples/ide/" --include="*.js" --include="*.html" .

# 4. Verify the moved IDE files no longer use the old ../github-viewer pattern
#    (they should all use ../../examples/github-viewer or ../../../examples/github-viewer)
grep -n "'\.\.\/github-viewer" app/ide/*.js app/ide/components/*.js app/ide/*.html

# 5. Verify no dangling references to examples/ide from other files
grep -rn "examples/ide" --include="*.js" --include="*.html" --include="*.json" --include="*.md" . \
  | grep -v "cross-ref/" | grep -v "node_modules/" | grep -v ".claude/"

# 6. Verify all import targets actually exist on disk
test -f examples/github-viewer/components/Drawer.js && echo "OK: Drawer.js"
test -f examples/github-viewer/components/LogCapturePanel.js && echo "OK: LogCapturePanel.js"
test -f examples/github-viewer/components/DiffPanel.js && echo "OK: DiffPanel.js"
test -f examples/github-viewer/GitHubRepoViewer.js && echo "OK: GitHubRepoViewer.js"
test -f examples/github-viewer/websocket/commands/encoding.js && echo "OK: encoding.js"
test -f src/services/utils/platform.js && echo "OK: platform.js"

# 7. Verify git blame history is preserved
git log --follow --oneline -5 -- app/ide/IDEShell.js
git log --follow --oneline -5 -- app/ide/components/CommandBar.js

# 8. Smoke test: start the dev server and load the IDE
# python3 -m http.server 8000 &
# Open http://localhost:8000/app/ide/ in a browser, verify it loads without console errors.
```

## Deferred

1. **Promote `encoding.js` to `src/utils/encoding.js`.** The `encodeBase64`/`decodeBase64` functions are pure utilities with zero dependencies, currently buried at `examples/github-viewer/websocket/commands/encoding.js`. Promoting them would give both the IDE and github-viewer a stable import path and eliminate the last cross-`app/`-into-`examples/`-internals dependency. This is a separate refactor; the import path rewrite in Step 4 works regardless.

2. **Caddy config update on the host.** After the commit deploys, SSH into the server and update the Caddyfile to map `/ide` to `app/ide/` instead of `examples/ide/`. The external URL `ivanlugo.dev/ide` does not change -- only the internal filesystem mapping does.

3. **Add npm convenience script.** Consider adding `"ide": "python3 -m http.server 8000"` or a script that opens the browser to `localhost:8000/app/ide/`.

4. **UI composability pass.** The memory note about DOM/TUI composable treatment is a larger effort that depends on the service extraction landing. Not part of this file move.

5. **Dynamic agent windows.** TUI windows growing freely in 3D is a separate feature, unrelated to file structure.

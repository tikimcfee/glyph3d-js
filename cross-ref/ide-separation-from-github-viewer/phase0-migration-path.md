# IDE Separation from GitHub Viewer — Phase 0 Migration Plan

**Status**: Analysis of current structure and concrete migration steps  
**Created**: 2026-03-30  
**Scope**: Moving IDE shell (IDEShell.js, ide.html, ide.css) from `examples/github-viewer/` to `examples/ide/`

---

## Executive Summary

The IDE shell is currently **bolted onto** `examples/github-viewer/ide.html`. To separate it:

1. **Move 12 IDE-specific files** to `examples/ide/` (IDEShell.js, ide.html, ide.css, CommandBar.js, etc.)
2. **Rewrite 3 import paths** in moved files to reference `../github-viewer/` for shared components
3. **Update npm scripts** in `package.json` to point to `examples/ide/ws-relay.mjs`
4. **Update `examples/index.html`** to link to `ide/` instead of `github-viewer/ide.html`
5. **Keep shared logic in github-viewer/** (GitHubRepoViewer, viewers, components, websocket protocol)

The key insight: **IDEShell is a thin orchestration layer** that wraps GitHubRepoViewer. It doesn't duplicate logic—it wires DOM, panels, status bar, and keyboard shortcuts. All rendering, file loading, and command protocol remain in `github-viewer/`.

---

## Current State Analysis

### What Exists Now

**examples/ide/index.html**
- Redirect stub to `../github-viewer/ide.html` (line 4)

**examples/github-viewer/** contains:
- **ide.html** — IDE shell DOM + init script (330 lines)
- **ide.css** — IDE layout styles (29.7 KB)
- **IDEShell.js** — Orchestrator class (~400 lines)
- **CommandBar.js** — Command/terminal input bar (in `components/`)
- **GitHubRepoViewer.js** — Main viewer (renders, loads repos, camera control)
- **GitHubRepoViewer.js** imports `websocket/index.js`, which wires CommandRouter
- **CLI tools** (cli/glyph-cli.mjs) — WebSocket CLI controller
- **WebSocket relay** (ws-relay.mjs, ws-relay.py) — Multi-client router
- **92 other files** — Viewers, components, websocket commands, adapters

### Import Dependencies

**ide.html (line 180-183)**
```javascript
import { GitHubRepoViewer } from './GitHubRepoViewer.js';
import { DrawerController } from './components/Drawer.js';
import { IDEShell } from './IDEShell.js';
import CommandBar from './components/CommandBar.js';
```

**IDEShell.js (lines 20-29)**
```javascript
import { repoPanelHTML, ... } from './components/Drawer.js';
import { logCapturePanelHTML } from './components/LogCapturePanel.js';
import { diffPanelHTML } from './components/DiffPanel.js';
import { primaryMod } from './platform.js';
```

**CommandBar.js (lines 16, 18)**
```javascript
import { primaryMod } from '../platform.js';
import { encodeBase64 } from '../websocket/commands/encoding.js';
```

**GitHubRepoViewer.js (line 50)**
```javascript
import { initCommandCenter } from './websocket/index.js';
```

### What's Shared vs. IDE-Specific

**IDE-Specific (MOVE):**
- IDEShell.js
- ide.html, ide.css
- CommandBar.js (components/CommandBar.js)
- Minimap.js (components/MinimapOverlay.js) — used only in IDE

**Shared (STAY in github-viewer/):**
- GitHubRepoViewer.js, SelectionManager, ShortcutManager, etc.
- All WebSocket command infrastructure (websocket/**, cli/**)
- All components: Drawer, DiffPanel, LogCapturePanel, AppShell, etc.
- All adapters: RepositoryAdapter, GitHubRepositorySource, etc.
- Utility classes: CameraController, SceneContext, FileStateManager, etc.

**Import Paths Analysis:**
- **13 relative imports in IDEShell.js** → will become `../github-viewer/*`
- **2 relative imports in CommandBar.js** → will become `../github-viewer/*`
- **ide.html script block imports** → will become `../github-viewer/*`
- **No hardcoded CLI paths** in ws-relay.mjs or glyph-cli.mjs (they take URLs, not file paths)
- **package.json scripts** reference `examples/github-viewer/ws-relay.mjs` and `examples/github-viewer/cli/glyph-cli.mjs` → UPDATE to `examples/ide/ws-relay.mjs` (but keep CLI in github-viewer/)

---

## Concrete Migration Steps

### Phase 1: Copy IDE Files (Preserve git history)

Use `git mv` to preserve blame/history. Commands executed in `/home/user/dev/glyph3d-js/`:

```bash
# 1. Move IDEShell.js
git mv examples/github-viewer/IDEShell.js examples/ide/IDEShell.js

# 2. Move ide.html and ide.css (main entry points)
git mv examples/github-viewer/ide.html examples/ide/ide.html
git mv examples/github-viewer/ide.css examples/ide/ide.css

# 3. Move CommandBar (IDE command input)
git mv examples/github-viewer/components/CommandBar.js examples/ide/CommandBar.js

# 4. Move MinimapOverlay (used only in IDE)
git mv examples/github-viewer/components/MinimapOverlay.js examples/ide/MinimapOverlay.js

# 5. Move WebSocket relay to IDE (it's not github-viewer-specific)
git mv examples/github-viewer/ws-relay.mjs examples/ide/ws-relay.mjs
git mv examples/github-viewer/ws-relay.py examples/ide/ws-relay.py

# 6. Optional: Move CLI into ide/ if it's treated as IDE infrastructure
# (Currently in github-viewer/cli/ — consider moving only if IDE becomes primary entry point)
# git mv examples/github-viewer/cli examples/ide/cli
```

**Total files moved: 7** (4 JS, 2 CSS/HTML, 1 Python, 1 mjs)

### Phase 2: Rewrite Import Paths (in moved files)

**examples/ide/IDEShell.js**
- Line 26: `from './components/Drawer.js'` → `from '../github-viewer/components/Drawer.js'`
- Line 27: `from './components/LogCapturePanel.js'` → `from '../github-viewer/components/LogCapturePanel.js'`
- Line 28: `from './components/DiffPanel.js'` → `from '../github-viewer/components/DiffPanel.js'`
- Line 29: `from './platform.js'` → `from '../github-viewer/platform.js'`

**examples/ide/CommandBar.js**
- Line 16: `from '../platform.js'` → `from '../github-viewer/platform.js'`
- Line 18: `from '../websocket/commands/encoding.js'` → `from '../github-viewer/websocket/commands/encoding.js'`

**examples/ide/ide.html (script block)**
- Line 180: `from './GitHubRepoViewer.js'` → `from '../github-viewer/GitHubRepoViewer.js'`
- Line 181: `from './components/Drawer.js'` → `from '../github-viewer/components/Drawer.js'`
- Line 182: `from './IDEShell.js'` → stays local (now in same dir)
- Line 183: `from './components/CommandBar.js'` → `from './CommandBar.js'` (moved to ide/)
- Line 7: CSS link `href="ide.css"` → stays local (both in ide/)

**examples/ide/MinimapOverlay.js** (if it has imports)
- Check for any relative imports and update paths

### Phase 3: Update Entry Points

**examples/ide/index.html**
- Current: Redirects to `../github-viewer/ide.html`
- New: Keep it, but update redirect or replace with actual content (TBD)

**examples/index.html** (landing page)
- Line 103: `href="github-viewer/"` stays (points to old viewer)
- Option A: Add new "IDE" card linking to `ide/`
- Option B: Replace github-viewer card with link to `ide/`

### Phase 4: Update npm Scripts

**package.json**
- Line 21: `"ws": "node examples/github-viewer/ws-relay.mjs"` → `"ws": "node examples/ide/ws-relay.mjs"`
- Line 22: `"ws:py": "python3 examples/github-viewer/ws-relay.py"` → `"ws:py": "python3 examples/ide/ws-relay.py"`
- Line 23: `"relay": ...` → update same as above
- Line 24: `"cli": "node examples/github-viewer/cli/glyph-cli.mjs"` → **KEEP** (CLI stays in github-viewer/cli/)

**Rationale**: The relay is part of IDE infrastructure; the CLI is a separate tool that works with any viewer.

### Phase 5: Remove Redirect from examples/ide/index.html

After ide.html is in examples/ide/:
- Update examples/ide/index.html to redirect to `./ide.html` (local) instead of `../github-viewer/ide.html`
- Or replace with meta refresh that loads ide.html directly

---

## Import Path Summary Table

| File | Old Path | New Path | Import Rewrites |
|------|----------|----------|-----------------|
| IDEShell.js | examples/github-viewer/ | examples/ide/ | 4 paths → `../github-viewer/` |
| ide.html | examples/github-viewer/ | examples/ide/ | 4 paths → `../github-viewer/` or local |
| ide.css | examples/github-viewer/ | examples/ide/ | No imports |
| CommandBar.js | examples/github-viewer/components/ | examples/ide/ | 2 paths → `../github-viewer/` |
| MinimapOverlay.js | examples/github-viewer/components/ | examples/ide/ | TBD |
| ws-relay.mjs | examples/github-viewer/ | examples/ide/ | No imports (uses only stdlib + ws package) |
| ws-relay.py | examples/github-viewer/ | examples/ide/ | No imports |

---

## Risk Analysis

### Low Risk

1. **No circular dependencies** — IDE only imports FROM github-viewer, never the reverse
2. **WebSocket relay is location-agnostic** — uses stdout, no hardcoded file paths
3. **CLI is independent** — references only .mjs modules, no path assumptions

### Medium Risk

1. **CSS file references** — ide.css might reference images/fonts via relative paths
   - **Check**: Scan ide.css for `url()` entries
   - **Fix**: Update relative paths if needed

2. **Examples landing page** — examples/index.html currently links only to github-viewer
   - **Current**: examples/index.html line 103 links to `github-viewer/`
   - **Decision needed**: Should "IDE" be a separate card, or should github-viewer card redirect to ide?

3. **Parallel deployments** — both ide.html and github-viewer/index.html will exist
   - **Risk**: User confusion about which to use
   - **Mitigation**: Clear naming (IDE in landing page), maybe deprecate github-viewer entry

### High Risk

1. **Forgotten import rewrites** — if any moved file still imports from `./*` instead of `../github-viewer/*`, it will break
   - **Mitigation**: Post-migration test suite that imports all moved modules
   - **Check**: grep for `from '\./` in examples/ide/ after move

2. **git history loss** — using `cp` instead of `git mv` loses blame/history
   - **Mitigation**: Use `git mv` exclusively

3. **Symlink fragility** — if someone uses symlinks to share code, they may break during rebuild
   - **Decision**: Avoid symlinks; use explicit imports instead

---

## Should examples/shared/ Exist?

**Analysis**: No, not yet.

**Why**:
- IDEShell imports only UI components (Drawer panels, LogCapture) that are already used by the old Drawer layout
- GitHubRepoViewer is the true shared kernel, and it already lives in github-viewer/
- CommandBar is pure IDE code (not used by old viewer)
- WebSocket protocol (commands/, CommandRouter, etc.) is already shared via imports

**Future consideration**: If a third example (e.g., "3D Code Analysis") needs Drawer panels, then extract them to `examples/shared/components/`. For now, github-viewer/ acts as the shared library.

---

## Execution Checklist

- [ ] **Backup**: `git status` confirms clean working tree
- [ ] **Phase 1**: Execute 7 `git mv` commands (preserve history)
- [ ] **Phase 2**: Rewrite 10 import paths (4 in IDEShell.js, 2 in CommandBar.js, 4 in ide.html)
- [ ] **Phase 3**: Update examples/index.html landing page (add IDE card or update link)
- [ ] **Phase 4**: Update package.json npm scripts (3 paths)
- [ ] **Phase 5**: Test IDE still loads at `http://localhost:8000/examples/ide/`
- [ ] **Phase 5b**: Test GitHub Viewer still loads at `http://localhost:8000/examples/github-viewer/`
- [ ] **Phase 6**: Verify relay and CLI work (`npm run ws`, `npm run cli`)
- [ ] **Phase 7**: Run full test suite
- [ ] **Phase 8**: Commit with message "refactor: separate IDE shell to examples/ide/"

---

## Git Commit Strategy

After all changes, create **one atomic commit**:

```
Subject: refactor: separate IDE shell to examples/ide/

- Move IDEShell.js, ide.html, ide.css to examples/ide/
- Move CommandBar.js, MinimapOverlay.js to examples/ide/
- Move WebSocket relay (ws-relay.mjs, ws-relay.py) to examples/ide/
- Rewrite import paths in IDE files to reference ../github-viewer/
- Update npm scripts to run relay from examples/ide/
- Update examples/index.html landing page to link to IDE
- GitHub Viewer remains independent at examples/github-viewer/index.html

GitHub Viewer and IDE now share:
- WebSocket command protocol (commands/, CommandRouter)
- UI component library (Drawer, DiffPanel, LogCapture, etc.)
- Rendering engine (GitHubRepoViewer, adapters, scene context)

IDE adds:
- VS Code-like layout (activity bar, sidebar panels, status bar)
- Tab bar and breadcrumb
- Integrated CommandBar for direct terminal input
- Keyboard shortcuts (Cmd+B for sidebar, Cmd+J for bottom panel)
```

---

## Files NOT Moving (Stay in github-viewer/)

These remain in examples/github-viewer/ because other examples or tools depend on them:

- GitHubRepoViewer.js — main application class
- SelectionManager.js, ShortcutManager.js, CameraController.js
- All adapter classes (RepositoryAdapter, GitHubRepositorySource, etc.)
- All websocket/ (commands/, CommandRouter, WebSocketBridge, etc.)
- All components/ (Drawer, DiffPanel, LogCapture, AppShell, TouchController)
- All utilities (SceneContext, FileStateManager, BackdropManager, etc.)
- cli/glyph-cli.mjs and related tools
- index.html (old viewer entry point)
- styles.css (old viewer styles)
- platform.js (utility for platform detection)

---

## Validation After Migration

1. **Load IDE**: `http://localhost:8000/examples/ide/`
   - DOM loads, sidebar visible, activity bar responds
   - Repo input works, WebSocket connects
   
2. **Load old Viewer**: `http://localhost:8000/examples/github-viewer/`
   - Still works independently
   - Canvas renders, keyboard shortcuts work

3. **CLI relay**:
   ```bash
   npm run ws &
   npm run cli
   grid.list
   ```
   Should list grids without errors

4. **Grep validation**: No dangling imports
   ```bash
   grep -r "from '\./components" examples/ide/
   grep -r "from '\./websocket" examples/ide/
   # Should all reference ../github-viewer/
   ```

---

## Timeline

- **Phase 1-2** (File move + imports): 30 min (mostly mechanical with git mv)
- **Phase 3-4** (Landing page + npm scripts): 10 min
- **Phase 5-8** (Testing + commit): 20 min

**Total**: ~60 minutes for a clean, reproducible separation.


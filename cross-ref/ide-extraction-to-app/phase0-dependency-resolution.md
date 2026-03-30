# Phase 0: Dependency Resolution -- IDE Extraction Import Analysis

Agent: `dependency-resolution`
Scope: Every import path that changes when `examples/ide/` moves to a top-level directory.

---

## 1. Current File Inventory

The IDE consists of exactly **4 files**:

| File | Role |
|------|------|
| `examples/ide/ide.html` | Entry point, importmap, inline `<script type="module">` |
| `examples/ide/ide.css` | Stylesheet (linked from ide.html via `href="ide.css"`) |
| `examples/ide/IDEShell.js` | Shell orchestrator |
| `examples/ide/components/CommandBar.js` | Unified input surface |

---

## 2. Complete Import Map -- All External References

### 2a. IDEShell.js (line 20-29)

| # | Import | Source Location | Type |
|---|--------|----------------|------|
| 1 | `repoPanelHTML, filesPanelHTML, settingsPanelHTML, statsPanelHTML, controlsPanelHTML` | `../github-viewer/components/Drawer.js` | HTML builder fns |
| 2 | `logCapturePanelHTML` | `../github-viewer/components/LogCapturePanel.js` | HTML builder fn |
| 3 | `diffPanelHTML` | `../github-viewer/components/DiffPanel.js` | HTML builder fn |
| 4 | `primaryMod` | `../../src/services/utils/platform.js` | Platform utility |

### 2b. CommandBar.js (line 16-18)

| # | Import | Source Location | Type |
|---|--------|----------------|------|
| 5 | `primaryMod` | `../../../src/services/utils/platform.js` | Platform utility |
| 6 | `encodeBase64` | `../../github-viewer/websocket/commands/encoding.js` | Base64 helper |

### 2c. ide.html inline script (line 178-184)

| # | Import | Source Location | Type |
|---|--------|----------------|------|
| 7 | `THREE` (all) | `'three'` (importmap -> CDN) | Bare specifier |
| 8 | `GitHubRepoViewer` | `../github-viewer/GitHubRepoViewer.js` | Core viewer class |
| 9 | `DrawerController` | `../github-viewer/components/Drawer.js` | Drawer class |
| 10 | `IDEShell` | `./IDEShell.js` | Local IDE file |
| 11 | `CommandBar` | `./components/CommandBar.js` | Local IDE file |

### 2d. ide.html non-JS references (line 5)

| # | Reference | Source | Type |
|---|-----------|--------|------|
| 12 | `ide.css` | `href="ide.css"` | CSS link (relative, same dir) |

---

## 3. Path Rewrite Table -- Both Destination Options

Current depth from repo root: `examples/ide/` = **depth 2**
Proposed destinations: `app/ide/` (depth 2) or `ide/` (depth 1)

### Option A: `app/ide/` (depth 2, same as current)

| # | File | Current Path | New Path | Change? |
|---|------|-------------|----------|---------|
| 1-3 | IDEShell.js | `../github-viewer/components/*.js` | `../../examples/github-viewer/components/*.js` | **YES** |
| 4 | IDEShell.js | `../../src/services/utils/platform.js` | `../../src/services/utils/platform.js` | NO |
| 5 | CommandBar.js | `../../../src/services/utils/platform.js` | `../../../src/services/utils/platform.js` | NO |
| 6 | CommandBar.js | `../../github-viewer/websocket/commands/encoding.js` | `../../examples/github-viewer/websocket/commands/encoding.js` | **YES** |
| 7 | ide.html | `'three'` (importmap) | `'three'` (importmap) | NO |
| 8 | ide.html | `../github-viewer/GitHubRepoViewer.js` | `../../examples/github-viewer/GitHubRepoViewer.js` | **YES** |
| 9 | ide.html | `../github-viewer/components/Drawer.js` | `../../examples/github-viewer/components/Drawer.js` | **YES** |
| 10 | ide.html | `./IDEShell.js` | `./IDEShell.js` | NO |
| 11 | ide.html | `./components/CommandBar.js` | `./components/CommandBar.js` | NO |
| 12 | ide.html | `ide.css` | `ide.css` | NO |

### Option B: `ide/` (depth 1)

| # | File | Current Path | New Path | Change? |
|---|------|-------------|----------|---------|
| 1-3 | IDEShell.js | `../github-viewer/components/*.js` | `../examples/github-viewer/components/*.js` | **YES** |
| 4 | IDEShell.js | `../../src/services/utils/platform.js` | `../src/services/utils/platform.js` | **YES** |
| 5 | CommandBar.js | `../../../src/services/utils/platform.js` | `../../src/services/utils/platform.js` | **YES** |
| 6 | CommandBar.js | `../../github-viewer/websocket/commands/encoding.js` | `../examples/github-viewer/websocket/commands/encoding.js` | **YES** |
| 7 | ide.html | `'three'` (importmap) | `'three'` (importmap) | NO |
| 8 | ide.html | `../github-viewer/GitHubRepoViewer.js` | `../examples/github-viewer/GitHubRepoViewer.js` | **YES** |
| 9 | ide.html | `../github-viewer/components/Drawer.js` | `../examples/github-viewer/components/Drawer.js` | **YES** |
| 10 | ide.html | `./IDEShell.js` | `./IDEShell.js` | NO |
| 11 | ide.html | `./components/CommandBar.js` | `./components/CommandBar.js` | NO |
| 12 | ide.html | `ide.css` | `ide.css` | NO |

**Key difference**: `app/ide/` preserves the depth-2 relationship to `src/`, so imports #4 and #5 (`platform.js`) stay unchanged. `ide/` changes every external import.

---

## 4. Dependency-by-Dependency Analysis

### 4.1 `primaryMod` from `src/services/utils/platform.js`

**Size**: 35 lines total, 2 exported functions (`primaryMod`, `secondaryMod`), 2 exported constants (`isMac`, `isLinux`).

**Used by**: IDEShell.js (line 29) and CommandBar.js (line 16). Both import only `primaryMod`.

**Verdict: Keep as cross-directory import.** This file is already in `src/services/utils/` -- the library's shared utility layer. It is small but has a clear single-responsibility. Both the IDE and the github-viewer depend on it. Inlining would create drift. No promotion needed; it is already in the right place.

### 4.2 `encodeBase64` from `examples/github-viewer/websocket/commands/encoding.js`

**Size**: 41 lines, 2 pure functions (`encodeBase64`, `decodeBase64`). Zero dependencies. No DOM, no Three.js.

**Used by**: CommandBar.js imports only `encodeBase64`.

**Verdict: Promote to `src/utils/encoding.js`.** This is a general-purpose UTF-8-safe base64 utility with no viewer-specific logic. It is currently buried 4 directories deep in the github-viewer's websocket commands. Promoting it to `src/utils/` would:
- Give both the IDE and github-viewer a stable import path
- Eliminate a cross-example dependency
- Match the existing pattern (`src/utils/` already has `Logger.js`, `Metrics.js`, etc.)

If promotion is out of scope for this extraction, keep as cross-directory import -- the path rewrite works either way.

### 4.3 Drawer HTML Builders: `repoPanelHTML`, `filesPanelHTML`, `settingsPanelHTML`, `statsPanelHTML`, `controlsPanelHTML`

**Location**: `examples/github-viewer/components/Drawer.js` (exported at lines 197, 222, 231, 342, 368).

**Nature**: Pure functions returning HTML template strings. They generate the repo URL input, settings checkboxes, stats display, and keyboard shortcuts reference. They have zero imports and no runtime dependencies.

**Used by**: IDEShell.js imports all 5 to inject into its sidebar panels via `injectPanelContent()`.

**Verdict: Keep as cross-directory import.** These are the canonical UI content definitions for the github-viewer. The IDE is a shell that wraps the viewer -- it should consume, not own, the viewer's panel content. Copying them would create dangerous drift (settings checkboxes would diverge from what the viewer actually reads). The cross-directory import is the correct architectural relationship: the IDE shell delegates content definition to the viewer.

### 4.4 `logCapturePanelHTML` from `LogCapturePanel.js`

**Location**: `examples/github-viewer/components/LogCapturePanel.js` (line 10+).

**Note**: LogCapturePanel.js itself imports from `../../../src/utils/LogCapture.js`. The IDE only imports the HTML builder function, not the init function. This is safe -- the HTML builder is a pure template string.

**Verdict: Keep as cross-directory import.** Same reasoning as 4.3.

### 4.5 `diffPanelHTML` from `DiffPanel.js`

**Location**: `examples/github-viewer/components/DiffPanel.js` (line 9).

**Note**: DiffPanel.js has zero imports. The `diffPanelHTML` function is a pure template string.

**Verdict: Keep as cross-directory import.** Same reasoning as 4.3.

### 4.6 `GitHubRepoViewer` and `DrawerController`

**Location**: `examples/github-viewer/GitHubRepoViewer.js` and `examples/github-viewer/components/Drawer.js`.

**Verdict: Obviously keep as cross-directory imports.** The IDE wraps the viewer; this is the primary dependency relationship.

---

## 5. The Importmap Question

The importmap in `ide.html` (lines 171-177):

```json
{
    "imports": {
        "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js"
    }
}
```

**This uses an absolute CDN URL, not a relative path.** It does NOT break at any directory depth. The importmap resolves the bare specifier `'three'` to the CDN regardless of where ide.html lives in the file tree.

**No change needed** for either `app/ide/` or `ide/`.

However: the `<link rel="stylesheet" href="ide.css">` on line 5 is a same-directory relative reference. Since `ide.css` moves alongside `ide.html`, this also does not break.

---

## 6. Recommendation: `app/ide/` vs `ide/`

From a pure dependency-resolution perspective, **`app/ide/` is slightly better** because it preserves the depth-2 relationship with `src/`, leaving imports #4 and #5 (`platform.js`) unchanged. This means:

- `app/ide/`: 5 paths change (imports #1-3, #6, #8, #9)
- `ide/`: 7 paths change (imports #1-6, #8, #9)

Both are workable. The difference is marginal (2 extra path edits). The architectural naming question (`app/` vs top-level) should drive the decision, not the import count.

---

## 7. Validation Commands

After the move, run these to verify no broken imports:

```bash
# 1. Check that all import paths in the IDE files resolve to existing files.
#    Run from repo root. Adjust the target dir to match chosen destination.

TARGET="app/ide"  # or "ide"

# List all import paths and verify each resolves
grep -rn "from '" $TARGET/ | \
  sed "s/.*from '//;s/'.*//" | \
  while read path; do
    # Skip bare specifiers (like 'three')
    [[ "$path" != .* ]] && continue
    echo "CHECK: $path"
  done

# 2. Verify no file in the repo still imports from examples/ide/
grep -rn "from.*examples/ide/" --include="*.js" --include="*.html" .

# 3. Verify the IDE files don't still reference ../github-viewer
#    (they should now reference ../../examples/github-viewer or ../examples/github-viewer)
grep -n "'\.\./github-viewer" $TARGET/**/*.js $TARGET/*.js

# 4. Verify no dangling references to the old location from other files
grep -rn "examples/ide" --include="*.js" --include="*.html" --include="*.json" .

# 5. Concrete file-existence checks (for app/ide/ target):
test -f examples/github-viewer/components/Drawer.js && echo "OK: Drawer.js"
test -f examples/github-viewer/components/LogCapturePanel.js && echo "OK: LogCapturePanel.js"
test -f examples/github-viewer/components/DiffPanel.js && echo "OK: DiffPanel.js"
test -f examples/github-viewer/GitHubRepoViewer.js && echo "OK: GitHubRepoViewer.js"
test -f examples/github-viewer/websocket/commands/encoding.js && echo "OK: encoding.js"
test -f src/services/utils/platform.js && echo "OK: platform.js"
```

---

## 8. Summary of Actions Required

| Action | Files Affected | Priority |
|--------|---------------|----------|
| Rewrite 3 Drawer/panel import paths in IDEShell.js | IDEShell.js lines 20-28 | Required |
| Rewrite 1 encoding.js import path in CommandBar.js | CommandBar.js line 18 | Required |
| Rewrite 2 viewer import paths in ide.html inline script | ide.html lines 180-181 | Required |
| Rewrite platform.js path in IDEShell.js (if `ide/` chosen) | IDEShell.js line 29 | Conditional |
| Rewrite platform.js path in CommandBar.js (if `ide/` chosen) | CommandBar.js line 16 | Conditional |
| Consider promoting encoding.js to `src/utils/` | encoding.js (41 lines) | Optional/future |
| No importmap changes | ide.html lines 171-177 | None needed |
| No CSS path changes | ide.html line 5 | None needed |

Total edits: **5 path rewrites** (for `app/ide/`) or **7 path rewrites** (for `ide/`).

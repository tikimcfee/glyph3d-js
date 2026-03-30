# Round 3: engineering convergence

## Settled

All points are now fully resolved. The three-perspective cross-reference process surfaced factual errors, filled analytical gaps, and confirmed that the core verdict is structurally unanimous. Here is the numbered resolution list.

1. **Shell LOC is 2,960.** Engineering's count was correct. Sustainability's 2,487 omitted CommandBar.js (463 LOC). Product-UX's "~2,600" was a rough estimate that incorrectly labeled CSS as vanilla JS. All three agents now agree on 2,960 (or 2,950 if you exclude the 10-line redirect -- a distinction without a difference).

2. **Command module LOC is 4,123, not 5,418.** My phase 0 inflated this by ~31% by including non-command files from the `websocket/` directory. Sustainability and product-UX both caught this. The argument that the CommandRouter represents substantial infrastructure holds at 4,123; the corrected number is what matters for credibility.

3. **Shell has 5 external imports, not 1.** My phase 0 stated "zero imports from src/ except one utility." Actual count: `primaryMod` imported twice (IDEShell.js and CommandBar.js), `logCapturePanelHTML` and `diffPanelHTML` from github-viewer components, `encodeBase64` from github-viewer commands. The architectural claim (minimal coupling) still holds, but the extraction from `examples/` is not zero-cost -- these imports must be resolved.

4. **The "7 integration points" are not equally problematic.** Product-UX correctly noted that CustomEvent listeners (`file-selected`, `camera-focus-changed`) and ResizeObserver are standard patterns, not ad-hoc wiring. The genuinely problematic integration points are three: the `asDrawer()` monkey-patch, the `updateStats()` frame-loop patch, and direct `viewer.grids` / `viewer.cameraController` property access. Formalization effort should prioritize these three.

5. **"~20 hrs/year" maintenance estimate is unsubstantiated.** Product-UX called this out. I provided no basis for the number. The honest statement: the shell's maintenance cost is dominated by feature development (command palette enhancement, agent-window evolution), not bug fixes. There is no meaningful "maintenance-only" baseline to estimate because the shell is actively evolving.

6. **Framework bridge code estimate (2,400-4,000 LOC) is directionally correct.** Sustainability and product-UX both accepted this as plausible. The key insight is not the exact number but that the bridge layer would exceed the shell it replaces, which is architecturally absurd.

7. **Monaco's 81 MB is the npm package size, not the production bundle.** Sustainability cited 81 MB; product-UX cited ~5 MB minified. Both are correct for their respective measures. A tree-shaken ESM build is 3-5 MB. The recommendation to not use Monaco for a command palette holds regardless -- 3-5 MB for a feature buildable in ~300 lines is still disproportionate.

8. **EPL-2.0 copyleft risk is real but not "nearly inevitable."** Sustainability's parenthetical overstated the likelihood of needing to modify Theia internals. Theia's documented extension points are designed to avoid this. Since the recommendation is to avoid Theia anyway, this is a corrected fact, not a changed conclusion.

9. **The metaphor mismatch is the decisive argument.** All three perspectives arrived at the same verdict through different reasoning, but product-UX's metaphor analysis is the load-bearing insight: a VSCode-like shell promises text editing that does not exist. Engineering's integration cost and sustainability's dependency weight are supporting arguments. The metaphor mismatch alone is disqualifying.

10. **The framework question is closed.** Three independent perspectives, three independent disqualifying reasons. This is not a close call that could flip with new information. The remaining work is "how do we make the custom shell excellent," not "should we adopt a framework." Reopening condition: the project pivots to include traditional text editing alongside 3D visualization.

## Implementation Plan

The converged next steps, in priority order, are: (1) extract IDE from `examples/`, (2) formalize the viewer-shell interface, (3) build a categorized command palette, (4) add component tests. Here is the file-by-file plan.

### Step 1: Extract IDE from `examples/ide/` to `app/ide/`

This is the highest priority because it is a prerequisite for clean import resolution and because the IDE is a production app at `ivanlugo.dev/ide`, not an example.

**Create:**
- `app/ide/` -- new top-level directory

**Move (git mv):**
- `examples/ide/IDEShell.js` -> `app/ide/IDEShell.js`
- `examples/ide/ide.css` -> `app/ide/ide.css`
- `examples/ide/ide.html` -> `app/ide/ide.html`
- `examples/ide/index.html` -> `app/ide/index.html`
- `examples/ide/components/CommandBar.js` -> `app/ide/components/CommandBar.js`

**Modify -- fix import paths in moved files:**

`app/ide/IDEShell.js` -- 3 imports change:
```javascript
// Before:
import { logCapturePanelHTML } from '../github-viewer/components/LogCapturePanel.js';
import { diffPanelHTML } from '../github-viewer/components/DiffPanel.js';
import { primaryMod } from '../../src/services/utils/platform.js';

// After:
import { logCapturePanelHTML } from '../../examples/github-viewer/components/LogCapturePanel.js';
import { diffPanelHTML } from '../../examples/github-viewer/components/DiffPanel.js';
import { primaryMod } from '../../src/services/utils/platform.js';
```

`app/ide/components/CommandBar.js` -- 2 imports change:
```javascript
// Before:
import { primaryMod } from '../../../src/services/utils/platform.js';
import { encodeBase64 } from '../../github-viewer/websocket/commands/encoding.js';

// After:
import { primaryMod } from '../../../src/services/utils/platform.js';
import { encodeBase64 } from '../../../examples/github-viewer/websocket/commands/encoding.js';
```

`app/ide/ide.html` -- 2 imports change:
```javascript
// Before:
import { GitHubRepoViewer } from '../github-viewer/GitHubRepoViewer.js';
import { DrawerController } from '../github-viewer/components/Drawer.js';

// After:
import { GitHubRepoViewer } from '../../examples/github-viewer/GitHubRepoViewer.js';
import { DrawerController } from '../../examples/github-viewer/components/Drawer.js';
```

**Modify -- update `package.json`:**
- Update `npm run serve` or add a note if the serve root needs to stay at project root (it does, since `/examples/` still needs to be served for github-viewer standalone)

**Modify -- update deployment:**
- If Caddy or any other server config references `examples/ide/`, update the path to `app/ide/`

**Do NOT delete `examples/ide/` yet.** Leave a redirect `index.html` that points to `../../app/ide/` for any bookmarked URLs, or symlink. Remove after confirming production deployment works.

### Step 2: Formalize the viewer-shell interface

The three ad-hoc integration points (drawer shim, updateStats patch, direct property access) should become an explicit contract. The clean integration points (CustomEvents, ResizeObserver) can stay as-is.

**Create:**
- `app/ide/ViewerShellContract.js` -- defines the interface the shell programs against

```javascript
/**
 * ViewerShellContract -- explicit interface between IDEShell and GitHubRepoViewer.
 *
 * Replaces: asDrawer() monkey-patch, updateStats() frame-loop patch,
 * direct viewer.grids / viewer.cameraController access.
 *
 * The shell creates this contract after viewer.init() and uses it
 * exclusively for viewer interaction. The viewer does not know
 * about the shell.
 */
export default class ViewerShellContract {
    /**
     * @param {GitHubRepoViewer} viewer
     */
    constructor(viewer) {
        this._viewer = viewer;
    }

    // --- Grid access (replaces direct viewer.grids access) ---

    /** @returns {{ path: string, index: number }[]} */
    getLoadedGrids() {
        return this._viewer.grids.map((g, i) => ({
            path: g.filePath || g.name || `grid-${i}`,
            index: i,
        }));
    }

    /** @param {string} path  @returns {number} index or -1 */
    findGridIndex(path) {
        return this._viewer.grids.findIndex(
            g => (g.filePath || g.name || '') === path
        );
    }

    // --- Camera (replaces direct viewer.cameraController access) ---

    /** @param {number} gridIndex */
    focusOnGrid(gridIndex) {
        this._viewer.cameraController.focusOnGrid(gridIndex);
    }

    /** @returns {{ x: number, y: number, z: number }} */
    getCameraPosition() {
        const p = this._viewer.cameraController.camera.position;
        return { x: p.x, y: p.y, z: p.z };
    }

    // --- Selection (replaces direct viewer.selectionManager access) ---

    /** @param {string} path */
    select(path) {
        const grids = this._viewer.grids;
        this._viewer.selectionManager?.select(path, { grids });
    }

    /** @param {string} path */
    deselect(path) {
        const grids = this._viewer.grids;
        this._viewer.selectionManager?.deselect(path, { grids });
    }

    // --- Drawer compatibility (replaces asDrawer() shim) ---

    /**
     * Returns an object satisfying the DrawerController interface
     * that the viewer expects. The shell implements open/close/toggle
     * by delegating to its own sidebar panel logic.
     * @param {IDEShell} shell
     * @returns {object}
     */
    static createDrawerShim(shell) {
        return {
            toggle() { shell.toggleSidebar(); },
            open()   { shell.showSidebar(); },
            close()  { shell.hideSidebar(); },
            get isOpen() { return shell.isSidebarVisible(); },
        };
    }

    // --- Stats (replaces updateStats() monkey-patch) ---

    /**
     * Wraps the viewer's updateStats to also feed shell status bar.
     * Called once during bootstrap; returns the wrapped function.
     * @param {Function} origUpdateStats - viewer.updateStats.bind(viewer)
     * @param {Function} shellStatusUpdate - shell.updateStatusBar.bind(shell)
     * @returns {Function}
     */
    static wrapUpdateStats(origUpdateStats, shellStatusUpdate) {
        return function(deltaTime) {
            const result = origUpdateStats(deltaTime);
            shellStatusUpdate(deltaTime);
            return result;
        };
    }

    // --- Renderer resize (documents the ResizeObserver pattern) ---
    // ResizeObserver on #editor-area is a clean pattern and stays in IDEShell.
    // No wrapping needed. This comment exists to document the decision.
}
```

**Modify:**
- `app/ide/IDEShell.js` -- replace all `this._viewer.grids`, `this._viewer.cameraController`, `this._viewer.selectionManager` access with calls through `this._contract` (a `ViewerShellContract` instance)
- `app/ide/IDEShell.js` -- remove or simplify `asDrawer()` method, delegate to `ViewerShellContract.createDrawerShim(this)`
- `app/ide/ide.html` -- bootstrap uses `ViewerShellContract.wrapUpdateStats()` instead of inline monkey-patch

### Step 3: Build a categorized command palette

The current `CommandBar.js` does dual-mode input (`:CMD` / `>termId`) and file-path fuzzy search via Cmd+P. The enhancement adds prefix-driven categories.

**Modify:**
- `app/ide/components/CommandBar.js` -- extend the existing fuzzy search with category prefixes

The implementation adds approximately 200-300 lines to CommandBar.js. Key design:

```javascript
// Category registry -- added to CommandBar class
_commandCategories = new Map([
    // prefix -> { label, items() -> [{label, detail, action}], filter(query, items) -> filtered }
    [':', { label: 'Commands',  items: () => this._getRegisteredCommands() }],
    ['@', { label: 'Grids',    items: () => this._getGridList() }],
    ['>', { label: 'Terminals', items: () => this._getTerminalTargets() }],
    ['',  { label: 'Files',    items: () => this._getFileList() }],  // default, no prefix
]);

// In the palette open handler (Cmd+P), detect prefix:
_onPaletteInput(query) {
    const prefix = query.length > 0 && this._commandCategories.has(query[0])
        ? query[0]
        : '';
    const category = this._commandCategories.get(prefix);
    const searchQuery = prefix ? query.slice(1) : query;
    const items = category.items();
    const filtered = this._fuzzyFilter(searchQuery, items);
    this._renderPaletteResults(filtered, category.label);
}
```

**Create:**
- Nothing new -- this is an extension of the existing CommandBar.js

The `_getRegisteredCommands()` method queries the CommandRouter (if connected via WebSocket) for available commands, or falls back to a static list of shell-level actions (toggle sidebar, switch panel, open settings, etc.).

### Step 4: Add component tests

The project has no test runner configured. The lightest approach consistent with the zero-build philosophy:

**Create:**
- `app/ide/tests/` directory
- `app/ide/tests/test-runner.html` -- a minimal HTML page that loads test modules and reports results in the browser console and DOM. No npm test framework needed; use bare `assert`-style functions.
- `app/ide/tests/test-panel-switching.js` -- tests that IDEShell panel switching (activity bar click -> sidebar content change) works correctly
- `app/ide/tests/test-resize.js` -- tests that ResizeObserver callback fires and updates renderer dimensions
- `app/ide/tests/test-tab-management.js` -- tests that addTab/removeTab/switchTab update DOM and trigger focusOnGrid
- `app/ide/tests/test-commandbar-modes.js` -- tests that `:` prefix enters command mode, `>` prefix enters terminal targeting mode, bare text enters file search mode

Each test file creates a minimal DOM scaffold (the subset of `ide.html` it needs), instantiates the component under test with mock dependencies, exercises the public API, and asserts expected DOM state or callback invocations.

```javascript
// test-runner.html sketch -- loads and runs test modules
// No npm. No build. Just ES module imports and DOM assertions.
<script type="module">
    const results = [];
    window.assert = (condition, msg) => {
        results.push({ pass: !!condition, msg });
        if (!condition) console.error('FAIL:', msg);
    };

    const modules = [
        './test-panel-switching.js',
        './test-tab-management.js',
        './test-commandbar-modes.js',
    ];

    for (const mod of modules) {
        try {
            const m = await import(mod);
            await m.default(); // each module exports an async default function
        } catch (e) {
            results.push({ pass: false, msg: `${mod}: ${e.message}` });
        }
    }

    const passed = results.filter(r => r.pass).length;
    const failed = results.filter(r => !r.pass).length;
    document.body.textContent = `${passed} passed, ${failed} failed`;
    console.log(`Tests: ${passed} passed, ${failed} failed`);
</script>
```

This keeps the zero-build-step guarantee. Tests run by opening `test-runner.html` in a browser. If a CI runner is ever added, a headless browser (playwright) can load the page and check the console output.

### Step 5 (follow-up, not immediate): Spatial minimap

All three analyses identified this as high-value, low-effort. The `#minimap-container` and `#minimap-canvas` elements already exist in `ide.html`. The implementation renders an overhead orthographic view of grid positions with the camera frustum drawn as a rectangle. This is ~200-400 lines in a new `app/ide/components/SpatialMinimap.js`. Not detailed here because it is a feature addition, not an architectural task, and should follow the extraction/formalization work.

### Step 6 (follow-up): Write an ADR closing the framework question

**Create:**
- `docs/adr/001-custom-ide-shell.md` -- Architectural Decision Record documenting the framework rejection with the three independent disqualifying reasons (metaphor mismatch, integration cost, dependency weight). Include the reopening condition (project pivots to text editing). This prevents relitigating the decision.

### Summary of file operations

| Action | Path | Reason |
|--------|------|--------|
| Create dir | `app/ide/` | Production app extraction |
| Create dir | `app/ide/components/` | CommandBar home |
| Create dir | `app/ide/tests/` | Component tests |
| Move | `examples/ide/*` -> `app/ide/*` | Extraction |
| Create | `app/ide/ViewerShellContract.js` | Formalize 3 ad-hoc integration points |
| Modify | `app/ide/IDEShell.js` | Fix imports, use ViewerShellContract |
| Modify | `app/ide/components/CommandBar.js` | Fix imports, add category system |
| Modify | `app/ide/ide.html` | Fix imports, use ViewerShellContract for bootstrap |
| Create | `app/ide/tests/test-runner.html` | Browser-based test harness |
| Create | `app/ide/tests/test-panel-switching.js` | Panel switch tests |
| Create | `app/ide/tests/test-tab-management.js` | Tab management tests |
| Create | `app/ide/tests/test-commandbar-modes.js` | CommandBar mode tests |
| Create | `docs/adr/001-custom-ide-shell.md` | Decision record |

### What NOT to do

- Do not add npm test dependencies. The zero-build philosophy is a strategic asset.
- Do not extract `logCapturePanelHTML` or `diffPanelHTML` from github-viewer yet. They are HTML template strings with no logic. Inlining them into the IDE shell would create duplication. The cross-directory import is acceptable until github-viewer is itself restructured.
- Do not build the spatial minimap before completing steps 1-4. The architectural work comes first.
- Do not write an agent-window architecture document yet. That is a separate analysis with different inputs (CommandBar + TerminalGrid + TUIWindowManager evolution). The memory note flags it; this analysis does not scope it.

## Implementer Vote

**product-ux** should implement.

Reasoning: The converged plan is predominantly about restructuring user-facing surfaces -- extracting the shell, formalizing how it talks to the viewer, enhancing the command palette with categories, and adding tests for interactive behaviors (panel switching, tab management, input modes). Product-UX's phase 0 demonstrated the deepest understanding of what the shell's UI surfaces actually do (the seven functional surfaces taxonomy, the user journey analysis, the "what to borrow" feature list). Product-UX is also the perspective that proposed the specific command palette categories (`:` for commands, `@` for grids, `>` for terminals) and the spatial minimap -- both of which are in the converged plan. Engineering's contribution was the integration cost analysis and the ViewerShellContract concept, which are now documented here as specifications for the implementer to follow. Sustainability's contribution was the dependency/license framing, which informed the "what NOT to do" constraints. The implementation work itself is user-facing component work, and product-UX is best positioned to execute it with the right sensibility for interaction design decisions that will arise during implementation.

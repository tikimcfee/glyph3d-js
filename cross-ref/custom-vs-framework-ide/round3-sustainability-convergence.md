# Round 3: sustainability convergence

## Settled

1. **The framework question is closed.** All three perspectives -- product-UX (metaphor mismatch), engineering (integration cost exceeds shell cost), sustainability (5-15% usage for 100% dependency weight) -- independently disqualify framework adoption. Three orthogonal rejection criteria make this structurally settled, not a judgment call that could flip with new information.

2. **The shell is 2,960 LOC across 5 files.** My Phase 0 undercounted by 463 lines (omitting CommandBar.js). Engineering's number is correct. The corrected total does not change the sustainability verdict -- 2,960 lines is still smaller than a single Theia package and well within solo-maintainable range.

3. **The command module system is 4,123 LOC across 21 files.** Engineering's original 5,418 figure was inflated by ~31%. Both engineering and I agreed on the correction during Round 1. The actual number still represents substantial infrastructure that would need bridging under a framework.

4. **The IDE shell is a production app, not an example.** It ships at ivanlugo.dev/ide. All three analyses and the project memory note agree: extract it from `examples/` to a top-level directory.

5. **The custom command palette is the right approach.** All three analyses converge: build a categorized command palette (~300 LOC) as an evolution of CommandBar.js. Do not import Monaco (81 MB unpacked, 3-5 MB tree-shaken) for a single widget.

6. **The shell-viewer interface must be formalized.** Engineering identified 7 integration points; product-UX and I agree. Three of them are ad-hoc (DrawerController shim via `ide.asDrawer()`, `updateStats` monkey-patch, direct `viewer.grids` access). The other four (CustomEvents, ResizeObserver, status bar reads, canvas reference) are clean patterns that just need explicit typing.

7. **The EPL-2.0 hedge was imprecise.** Product-UX correctly flagged my "nearly inevitable" parenthetical about Theia source modification. Theia's documented extension points can avoid EPL-2.0 modification triggers. The license risk is real for deep customization but not universal. Since the recommendation is to avoid Theia entirely, this is moot for the decision but I acknowledge the imprecision.

8. **The agent-window vision is the differentiator no framework can provide.** CommandBar + TerminalGrid + TUIWindowManager is the path to dynamic 3D agent windows. This is deeply specific to glyph3d-js. No upstream framework will prioritize or even accommodate 3D spatial layout primitives. Building custom is not just cheaper; it is the only viable path.

9. **The Monaco 81 MB figure needs context.** Engineering correctly noted that the unpacked npm size (81 MB) overstates the runtime cost. A tree-shaken ESM bundle is 3-5 MB. The argument against Monaco for a command palette holds either way -- 3-5 MB is still disproportionate for a fuzzy-filter overlay -- but the 81 MB figure should not be cited as the deployed cost.

10. **WebGL context loss handling is needed regardless of framework decision.** Engineering raised this as a framework-specific risk, but browser tab backgrounding and GPU driver resets can trigger it in the current architecture too. This is an independent hardening task.

## Implementation Plan

The converged next steps are: (A) extract IDE from `examples/`, (B) formalize the shell-viewer interface, (C) write an architectural decision record, and (D) resolve cross-file import dependencies. These are ordered by dependency -- you cannot cleanly extract without first understanding the import graph, and the ADR should document the state you're moving toward.

### Step 0: Resolve import dependencies (prerequisite)

The IDE shell has 5 external imports that must be addressed before extraction:

| File | Import | Source |
|------|--------|--------|
| `IDEShell.js:27` | `logCapturePanelHTML` | `../github-viewer/components/LogCapturePanel.js` |
| `IDEShell.js:28` | `diffPanelHTML` | `../github-viewer/components/DiffPanel.js` |
| `IDEShell.js:29` | `primaryMod` | `../../src/services/utils/platform.js` |
| `CommandBar.js:16` | `primaryMod` | `../../../src/services/utils/platform.js` |
| `CommandBar.js:18` | `encodeBase64` | `../../github-viewer/websocket/commands/encoding.js` |

Additionally, `ide.html` imports:
| File | Import | Source |
|------|--------|--------|
| `ide.html:180` | `GitHubRepoViewer` | `../github-viewer/GitHubRepoViewer.js` |
| `ide.html:181` | `DrawerController` | `../github-viewer/components/Drawer.js` |

**Resolution strategy:**

- **`primaryMod` / `secondaryMod`** (35 LOC in `platform.js`): This is a general utility, not github-viewer-specific. It already lives in `src/services/utils/`. After extraction, the IDE app imports it via a relative path to `src/` -- this is fine since the IDE app is a consumer of glyph3d-js. Update import paths to reflect new directory depth.

- **`encodeBase64`** (20 LOC): Pure utility function. Same treatment -- it should be promoted to `src/utils/encoding.js` or the IDE can import it from the library. Since it's used by both the websocket commands and CommandBar, moving it to `src/utils/` makes it a shared utility importable by both consumers.

- **`logCapturePanelHTML` / `diffPanelHTML`**: These are HTML template functions for drawer panels. They are github-viewer-specific UI components. The IDE shell uses them to inject panel content. Two options: (a) copy them into the IDE app (they're small HTML-returning functions), or (b) keep the import pointing at `examples/github-viewer/` with the understanding that the IDE app depends on the github-viewer example for these panels. Option (b) is more honest -- the IDE *is* a shell around the github-viewer. The import path just changes depth.

- **`GitHubRepoViewer` / `DrawerController`**: These are the core viewer that the IDE wraps. These imports stay -- the IDE app is a consumer of the github-viewer. The import paths update to reflect new directory depth.

### Step 1: Create `app/ide/` directory structure

```
app/
  ide/
    index.html          (redirect, from examples/ide/index.html)
    ide.html            (main entry, from examples/ide/ide.html)
    ide.css             (styles, from examples/ide/ide.css)
    IDEShell.js         (shell orchestrator, from examples/ide/IDEShell.js)
    components/
      CommandBar.js     (from examples/ide/components/CommandBar.js)
```

**Files to create:** `app/ide/` directory and all contents (moved from `examples/ide/`).

**Files to modify (import path updates):**

`app/ide/IDEShell.js` -- update 3 imports:
```javascript
// Old (from examples/ide/)
import { logCapturePanelHTML } from '../github-viewer/components/LogCapturePanel.js';
import { diffPanelHTML } from '../github-viewer/components/DiffPanel.js';
import { primaryMod } from '../../src/services/utils/platform.js';

// New (from app/ide/)
import { logCapturePanelHTML } from '../../examples/github-viewer/components/LogCapturePanel.js';
import { diffPanelHTML } from '../../examples/github-viewer/components/DiffPanel.js';
import { primaryMod } from '../../src/services/utils/platform.js';
```

`app/ide/components/CommandBar.js` -- update 2 imports:
```javascript
// Old (from examples/ide/components/)
import { primaryMod } from '../../../src/services/utils/platform.js';
import { encodeBase64 } from '../../github-viewer/websocket/commands/encoding.js';

// New (from app/ide/components/)
import { primaryMod } from '../../../src/services/utils/platform.js';
import { encodeBase64 } from '../../../examples/github-viewer/websocket/commands/encoding.js';
```

`app/ide/ide.html` -- update 2 imports:
```javascript
// Old (from examples/ide/)
import { GitHubRepoViewer } from '../github-viewer/GitHubRepoViewer.js';
import { DrawerController } from '../github-viewer/components/Drawer.js';

// New (from app/ide/)
import { GitHubRepoViewer } from '../../examples/github-viewer/GitHubRepoViewer.js';
import { DrawerController } from '../../examples/github-viewer/components/Drawer.js';
```

**Files to delete:** `examples/ide/` directory (after extraction).

### Step 2: Formalize the shell-viewer interface

Create `app/ide/ViewerShellContract.js` -- a JSDoc-typed interface documenting what the IDE shell expects from the viewer and vice versa.

```javascript
/**
 * ViewerShellContract
 *
 * Documents the interface between IDEShell and GitHubRepoViewer.
 * The shell programs against this contract; the viewer satisfies it.
 *
 * Integration points (from engineering analysis):
 *
 * CLEAN (keep as-is, just document):
 *   1. 'file-selected' CustomEvent  -- viewer dispatches, shell listens
 *   2. 'camera-focus-changed' CustomEvent -- viewer dispatches, shell listens
 *   3. ResizeObserver on #editor-area -- shell observes, calls viewer.onResize()
 *   4. Status bar reads -- shell reads viewer.metrics (FPS, glyph count, camera pos)
 *
 * AD-HOC (formalize):
 *   5. DrawerController shim -- ide.asDrawer() replaces viewer.drawer
 *   6. updateStats monkey-patch -- ide.html wraps viewer.updateStats()
 *   7. Direct viewer.grids access -- shell reads viewer.grids for command palette
 */

/**
 * @typedef {Object} ViewerContract
 * @property {Function} init - Initialize the viewer
 * @property {Function} updateStats - Per-frame status update (deltaTime)
 * @property {Function} onResize - Handle container resize
 * @property {Object} drawer - DrawerController or compatible shim
 * @property {Map} grids - Map of loaded CodeGrid instances
 * @property {Object} metrics - Performance metrics (fps, glyphCount, cameraPos)
 * @property {Object} cameraController - Camera controller instance
 */

/**
 * @typedef {Object} ShellDrawerShim
 * @property {Function} openToTab - Open sidebar to named tab
 * @property {Function} close - Close sidebar
 * @property {Function} toggle - Toggle sidebar visibility
 * @property {Function} registerPanel - Register a named panel
 */

export const CONTRACT_VERSION = '1.0.0';
```

This is not runtime enforcement -- it is documentation that lives with the code. The actual refactoring of the three ad-hoc integration points (replacing monkey-patches with explicit APIs on the viewer) is a follow-up task, not part of the extraction.

### Step 3: Write the Architectural Decision Record

Create `docs/adr/001-custom-ide-shell.md`:

```markdown
# ADR-001: Custom IDE Shell over Framework Adoption

## Status: Accepted

## Date: 2026-03-30

## Context

glyph3d-js renders source code in navigable 3D space using GPU-instanced
text. The IDE shell at ivanlugo.dev/ide provides the surrounding UI:
activity bar, tab management, sidebar panels, status bar, and command palette.

The question was evaluated: should this shell adopt an existing web IDE
framework (Eclipse Theia, VS Code/Monaco, OpenVSCode Server, code-server)
or continue as custom vanilla JS?

## Decision

Keep the custom shell. Do not adopt a framework.

## Reasons

1. **Metaphor mismatch.** IDE frameworks assume the editor area contains
   editable text. glyph3d-js's editor area is a WebGL canvas. Framework
   chrome (Cmd+S, Cmd+F, IntelliSense) creates false user expectations
   the product cannot satisfy.

2. **Integration cost exceeds shell cost.** The shell is 2,960 LOC.
   Framework bridge code (iframe isolation, serialization, dual command
   systems) was estimated at 2,400-4,000 LOC -- larger and more fragile
   than the shell it would replace.

3. **Disproportionate dependency weight.** The shell would use 5-15% of
   any framework's surface. The smallest option (Monaco standalone) adds
   3-5 MB minified; full frameworks add 700 MB-1.5 GB installed.

4. **The agent-window vision requires full DOM-to-3D control.** Dynamic
   3D windows for AI agents cannot be built on top of a framework's 2D
   layout assumptions.

5. **License cleanliness.** The project is pure MIT. Theia (EPL-2.0)
   would introduce a copyleft split. VS Code binaries carry proprietary
   licensing.

## Consequences

- The shell grows organically. Projected range: 5,000-8,000 LOC over 3 years.
- No build system is required. Native ES modules served directly.
- Feature gaps (command categories, spatial minimap, keyboard shortcut
  discoverability) are implemented incrementally.
- If the project pivots to include text editing, this decision should be
  revisited.

## Revisit Condition

Revisit ONLY if the product adds text editing to the editor area. As long
as the editor area is a WebGL canvas, framework adoption is a category error.
```

### Step 4: Update CLAUDE.md

Add the `app/ide/` directory to the project structure section and note the ADR:

In the Project Structure section, add:
```
app/
  ide/                         # Production IDE shell (ivanlugo.dev/ide)
    IDEShell.js                # Shell orchestrator (activity bar, tabs, panels)
    ide.html                   # Main entry point
    ide.css                    # Shell styles (CSS Grid layout)
    components/
      CommandBar.js            # Dual-mode command input (palette + terminal relay)
```

### Summary of file operations

| Action | Path | Notes |
|--------|------|-------|
| Create dir | `app/ide/` | New top-level app directory |
| Create dir | `app/ide/components/` | CommandBar location |
| Move | `examples/ide/IDEShell.js` -> `app/ide/IDEShell.js` | Update 3 import paths |
| Move | `examples/ide/ide.html` -> `app/ide/ide.html` | Update 2 import paths |
| Move | `examples/ide/ide.css` -> `app/ide/ide.css` | No changes needed |
| Move | `examples/ide/index.html` -> `app/ide/index.html` | No changes needed |
| Move | `examples/ide/components/CommandBar.js` -> `app/ide/components/CommandBar.js` | Update 2 import paths |
| Create | `app/ide/ViewerShellContract.js` | JSDoc interface documentation |
| Create | `docs/adr/001-custom-ide-shell.md` | Architectural decision record |
| Modify | `CLAUDE.md` | Add `app/ide/` to project structure |
| Delete dir | `examples/ide/` | After successful extraction |

## Implementer Vote

**Engineering.**

The converged plan is primarily a file-move-and-rewire operation. Engineering's Phase 0 analysis contains the most detailed treatment of the integration points that need formalizing (the 7-point enumeration, the glue-code anatomy, the import graph). Engineering also self-corrected on the import count error and identified the specific monkey-patches in `ide.html` (lines 208-223) that become the core of `ViewerShellContract.js`. The implementation work is moving files, rewriting import paths, creating the contract interface, and writing the ADR -- all of which align with engineering's structural analysis more than with product-UX's interaction design perspective or my own dependency/license analysis. Product-UX's contributions (metaphor mismatch table, UX borrowing list) are documentation artifacts that feed into the ADR but don't drive the file operations.

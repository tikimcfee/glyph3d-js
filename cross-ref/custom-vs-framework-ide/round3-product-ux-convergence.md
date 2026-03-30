# Round 3: product-ux convergence

## Settled

1. **Keep the custom shell; reject framework adoption.** All three agents independently arrived at this conclusion via orthogonal arguments (metaphor mismatch, integration cost, dependency weight). The decision is structurally settled -- no single new fact could flip it because three independent disqualifications would each need to be overcome.

2. **The shell total is 2,960 LOC across 5 files.** IDEShell.js (1,007) + ide.css (1,150) + ide.html (330) + CommandBar.js (463) + index.html redirect (10). All three analyses now agree on this after Round 1 corrections. The JS-only count is 1,470 lines. The "~2,600 lines vanilla JS" in my Phase 0 was wrong -- 1,150 of those lines are CSS.

3. **The command module count is 4,123 LOC across 21 files**, not 5,418. Engineering acknowledged this self-correction in Round 1.

4. **The metaphor mismatch is the decisive argument.** All three Round 1 reviews independently identified my Phase 0 metaphor table as the strongest single artifact. The "editor" is a WebGL canvas. IDE frameworks assume text documents with cursor positions. This is a category error, not a trade-off.

5. **Extract the IDE from `examples/` to a top-level directory.** Unanimous across all three agents and consistent with the project memory note. The shell is a production app at ivanlugo.dev/ide, not an example.

6. **Build the categorized command palette in-house (~300 LOC).** All three agents agree: add prefix-driven categories (`:` for commands, `@` for grids/symbols, `>` for terminal targets) to the existing CommandBar. Do not import Monaco.

7. **Formalize the viewer-shell interface, prioritizing the 3 ad-hoc integration points.** Engineering identified 7 integration points. My Round 1 review clarified that only 3 are architecturally problematic: the `asDrawer()` monkey-patch, the `updateStats()` frame patch, and direct `viewer.grids` access. The other 4 (CustomEvents, ResizeObserver, CSS Grid) are clean patterns that need no rework. Start with the 3 problematic ones.

8. **The spatial minimap is the highest-value next feature unique to this product.** The `#minimap-container` and `#minimap-canvas` elements already exist in the HTML. An overhead view of grid positions + camera frustum is high-value, low-cost, and impossible in any framework.

9. **The only condition for revisiting the framework question is adding text editing.** If the product pivots to include Monaco-based editing alongside 3D visualization, the economics change. Record this as an explicit architectural decision so it does not get relitigated.

10. **CommandBar is the interaction primitive for the agent-windows vision.** Its dual-mode input (`:CMD` for command routing, `>termId` for terminal targeting), history, and tab completion are the foundation. Investment goes here, not into framework extension APIs.

## Implementation Plan

The converged plan has four workstreams, ordered by dependency. File paths are relative to project root (`/home/user/dev/glyph3d-js/`).

### Workstream 1: Define the ViewerShellContract (prerequisite for extraction)

Before moving files, formalize the ad-hoc integration points so the shell and viewer communicate through an explicit interface rather than monkey-patches.

**Create: `src/services/interaction/ViewerShellContract.js`**

```javascript
/**
 * ViewerShellContract -- explicit interface between the IDE shell
 * and the GitHubRepoViewer. Replaces ad-hoc monkey-patching
 * (asDrawer shim, updateStats frame patch, direct viewer.grids access).
 *
 * The viewer emits events and exposes read-only accessors.
 * The shell subscribes and renders. Neither reaches into the other's internals.
 */
export class ViewerShellContract {
    /**
     * @param {GitHubRepoViewer} viewer
     */
    constructor(viewer) {
        this._viewer = viewer;
        this._listeners = new Map();
    }

    // --- Stats (replaces updateStats monkey-patch) ---

    /** @returns {{ fps: number, glyphCount: number, gridCount: number, cameraPos: {x,y,z} }} */
    getStats() {
        const v = this._viewer;
        return {
            fps: v._fpsCounter?.fps ?? 0,
            glyphCount: v._totalGlyphs ?? 0,
            gridCount: v.grids?.length ?? 0,
            cameraPos: v.camera?.position ?? { x: 0, y: 0, z: 0 },
            layoutMode: v._currentLayoutMode ?? 'unknown',
            wsConnected: v._commandRouter?.bridge?.connected ?? false,
        };
    }

    // --- Drawer operations (replaces asDrawer shim) ---

    /** @param {string} tabId */
    openToTab(tabId) {
        this._emit('open-to-tab', { tabId });
    }

    /** @param {{ id: string, title: string, html: string }} panel */
    addPanel(panel) {
        this._emit('add-panel', panel);
    }

    // --- Grid access (replaces direct viewer.grids access) ---

    /** @returns {Array} */
    getGrids() {
        return this._viewer.grids ?? [];
    }

    /** @param {number} index */
    focusGrid(index) {
        this._viewer.cameraController?.focusOnGrid?.(index);
    }

    // --- Event system ---

    on(event, fn) {
        if (!this._listeners.has(event)) this._listeners.set(event, []);
        this._listeners.get(event).push(fn);
    }

    _emit(event, data) {
        for (const fn of this._listeners.get(event) ?? []) fn(data);
    }
}
```

**Modify: `examples/ide/ide.html`** (lines 206-223)

Replace the `viewer.init` wrapper and `updateStats` monkey-patch with:

```javascript
// After viewer.init(), create the contract and wire the shell to it.
await viewer.init();
const contract = new ViewerShellContract(viewer);
viewer.drawer = contract; // contract implements openToTab/addPanel
ide.attachContract(contract); // shell reads stats via contract.getStats()
```

**Modify: `examples/ide/IDEShell.js`**

Add `attachContract(contract)` method that replaces the current `attachViewer(viewer)` internals. The shell calls `contract.getStats()` in its status bar update loop instead of reaching into `viewer._fpsCounter`, `viewer._totalGlyphs`, etc. Keep `attachViewer()` as a deprecated wrapper that internally creates a contract.

### Workstream 2: Extract IDE to top-level directory

Once the contract interface exists, the extraction is straightforward.

**Create directory: `ide/`**

**Move files:**
- `examples/ide/IDEShell.js` -> `ide/IDEShell.js`
- `examples/ide/ide.css` -> `ide/ide.css`
- `examples/ide/ide.html` -> `ide/ide.html`
- `examples/ide/components/CommandBar.js` -> `ide/components/CommandBar.js`
- `examples/ide/index.html` -> `ide/index.html`

**Update imports in moved files:**

| File | Old import path | New import path |
|---|---|---|
| `IDEShell.js` | `../github-viewer/components/Drawer.js` | `../examples/github-viewer/components/Drawer.js` |
| `IDEShell.js` | `../github-viewer/components/LogCapturePanel.js` | `../examples/github-viewer/components/LogCapturePanel.js` |
| `IDEShell.js` | `../github-viewer/components/DiffPanel.js` | `../examples/github-viewer/components/DiffPanel.js` |
| `IDEShell.js` | `../../src/services/utils/platform.js` | `../src/services/utils/platform.js` |
| `CommandBar.js` | `../../../src/services/utils/platform.js` | `../../src/services/utils/platform.js` |
| `CommandBar.js` | `../../github-viewer/websocket/commands/encoding.js` | `../examples/github-viewer/websocket/commands/encoding.js` |
| `ide.html` | `../github-viewer/GitHubRepoViewer.js` | `../examples/github-viewer/GitHubRepoViewer.js` |
| `ide.html` | `../github-viewer/components/Drawer.js` | `../examples/github-viewer/components/Drawer.js` |

**Do not delete** `examples/ide/`. Leave a redirect `index.html` pointing to `/ide/` for any existing links. The existing one already serves as a redirect; update its target path.

**Update `package.json`** if the `npm run serve` script or any paths reference the IDE location.

### Workstream 3: Build categorized command palette

**Modify: `ide/components/CommandBar.js`**

The current CommandBar has two modes: `:CMD` (command) and `>termId` (terminal). Extend this with prefix-driven category routing.

Add a category registry and prefix parser (~250-350 lines of additions/modifications):

```javascript
// --- Category registry ---
const CATEGORIES = {
    ':': { label: 'Commands', filter: (q, items) => fuzzyMatch(q, items) },
    '@': { label: 'Grids',   filter: (q, items) => fuzzyMatch(q, items) },
    '>': { label: 'Terminals', filter: (q, items) => fuzzyMatch(q, items) },
    '': { label: 'Files', filter: (q, items) => fuzzyMatch(q, items) },  // default: no prefix
};

_parseInput(raw) {
    for (const prefix of [':', '@', '>']) {
        if (raw.startsWith(prefix)) {
            return { category: prefix, query: raw.slice(prefix.length) };
        }
    }
    return { category: '', query: raw };
}
```

Register commands from the existing CommandRouter's command map so `:` mode can list all available WebSocket commands with fuzzy filtering.

Register grids from `contract.getGrids()` so `@` mode can list all loaded code grids by filename.

Keep `>` mode behavior unchanged (terminal targeting).

Default (no prefix) retains current file-path fuzzy search behavior.

Add an overlay dropdown below the CommandBar input that shows filtered results with keyboard navigation (arrow keys + Enter). This replaces the current alert-based selection with an inline results panel.

### Workstream 4: Spatial minimap

**Create: `ide/components/SpatialMinimap.js`** (~200-300 LOC)

```javascript
/**
 * SpatialMinimap -- Renders a birds-eye 2D projection of the 3D scene
 * onto the existing #minimap-canvas element.
 *
 * Shows:
 * - Grid positions as colored rectangles
 * - Camera frustum as a viewport indicator
 * - Click-to-navigate: clicking a grid rectangle flies the camera there
 */
export default class SpatialMinimap {
    constructor({ canvas, contract }) {
        this._canvas = canvas;
        this._ctx = canvas.getContext('2d');
        this._contract = contract;
    }

    update() {
        const grids = this._contract.getGrids();
        const stats = this._contract.getStats();
        const cam = stats.cameraPos;
        this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);

        // Compute bounding box of all grids for scaling
        // Project grid positions onto XZ plane (top-down view)
        // Draw each grid as a small rectangle
        // Draw camera position as a highlighted dot/frustum indicator
    }

    /** @param {MouseEvent} e */
    _onClick(e) {
        // Reverse-map click position to grid index
        // Call contract.focusGrid(index)
    }
}
```

Wire it into `ide.html` after the contract is created:

```javascript
const minimap = new SpatialMinimap({
    canvas: document.getElementById('minimap-canvas'),
    contract,
});
// Update minimap each frame alongside status bar
```

### Order of operations

1. **ViewerShellContract** first -- this is the prerequisite for clean extraction.
2. **IDE extraction** second -- move files, fix import paths, verify the app loads at the new location.
3. **Command palette categories** third -- this is the highest UX payoff and builds on the extracted CommandBar.
4. **Spatial minimap** fourth -- independent feature, lower priority but unique differentiator.

### Files not touched

- `src/` core library code -- no changes needed.
- `examples/github-viewer/` -- no changes except possibly exporting `encoding.js` utilities more cleanly.
- `examples/word-wall/` -- unrelated.
- Shader files, worker files, camera system -- all untouched.

### What to delete

Nothing. The `examples/ide/` directory keeps its redirect `index.html`. All other files move rather than copy+delete, preserving git history via `git mv`.

## Implementer Vote

**engineering** should implement this plan.

Rationale: The converged plan is dominated by interface extraction (ViewerShellContract), file moves with import path resolution, and wiring code in `ide.html`. These are structural engineering tasks -- defining contracts, resolving module dependencies, ensuring the monkey-patches are replaced with clean abstractions. Engineering's Phase 0 analysis is the one that identified the 7 integration points, traced the import graph, estimated bridge code LOC, and understood the specific wiring in `ide.html` (lines 206-223). The product-ux perspective informed what to build and why, but the implementation work is squarely in engineering's domain: module boundaries, interface contracts, and dependency resolution. Sustainability's perspective was essential for the decision but does not map to the implementation tasks.

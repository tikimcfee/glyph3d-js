# Round 3 Convergence: composition-pattern

---

## Settled

These items have full three-agent consensus. No further debate needed.

### 1. Extraction order follows dependency depth, not architectural layers

Zero-dep services first, then single-dep, then multi-dep, then orchestration. All three agents converged on this independently. The extraction-plan agent retracted its original commands-first proposal.

### 2. SceneContext survives as an immutable infrastructure bag

All three agents converged: SceneContext stays. It is 43 lines, zero behavior, and is cleaner than destructuring 6+ params into every constructor. The fix is:
- Remove the two mutable fields (`hierarchicalManager`, `layoutManager`) -- those are set post-construction by `loadRepository()` and belong to the composition root or a separate `LayoutContext`.
- Each consuming service's JSDoc `@param` enumerates which SceneContext fields it reads.
- SceneContext lives at `src/services/context/SceneContext.js`, not under `camera/`.

### 3. Event pattern: services own `on()`/`off()`, composition root bridges to DOM

SelectionManager is the reference implementation (lines 205-213: `on(callback)` / `off(callback)`, internal `_listeners` Set). CameraController's `window.dispatchEvent(new CustomEvent('camera-focus-changed', ...))` at line 435 becomes an internal callback. The composition root subscribes and dispatches the DOM event.

### 4. SceneRegistry extracts to `src/services/`

Zero DOM coupling, zero WebSocket coupling. All three agents agree.

### 5. CameraController needs a `bindUI()` split and rename

The viewer's 597-line `CameraController` becomes `ViewerCameraController` (or `NavigationController`) to avoid collision with the library's existing `src/camera/CameraController.js`. The 6+ `document.getElementById()` calls (lines 198, 206, 259, 260, 261, 275-299) move to a `bindUI(elements)` method that the composition root calls after construction.

### 6. `window.viewer = api` belongs in example code, not library services

`initCommandCenter()` at `websocket/index.js:156` sets this global. Extracted version must return the API; the caller assigns globally if desired.

### 7. `dispose()` is the canonical cleanup name, not `destroy()`

BackdropManager has both `dispose()` (clears meshes) and `destroy()` (dispose + remove from scene). Standardize on `dispose()` that handles both. Composition root calls them in reverse construction order.

### 8. THREE.js: bare `import * as THREE from 'three'` for library services

Three.js is a peer dependency. BackdropManager, NameplateManager, and spatialHelpers already use bare imports. CameraController receives THREE via `ctx.THREE`, but that pattern exists because SceneContext bundles it -- when services accept SceneContext they get THREE for free. No need to thread a separate THREE constructor param. The module-scope `DEPTH_COLORS` in BackdropManager (line 23-29, `new THREE.Color(...)`) works fine with bare imports since Three.js resolves at module load time.

### 9. Command modules stay in examples until context interface stabilizes

The 16+ command modules depend on a ~20-property context bag (lines 29-118 of `websocket/index.js`). Extracting them makes that shape a public API contract. All three agents agree this is premature. Define a `CommandContext` JSDoc typedef first; extract command modules only after that typedef is stable.

### 10. TUI and StatePersistence are deferred

TUI (TUIWindow, TUIWindowManager, TUIFocusManager, TUIFormatter) and StatePersistence (deep DOM coupling: `document.getElementById('layout-mode')`, `window.location.reload()`) are deferred. No agent disputes this.

---

## Implementation Plan

This plan is grounded in the actual source code on the `experiment/ide-shell` branch. Code sketches reference real constructors, real line numbers, and real method signatures.

### Step 0: Composition Root Files

Two composition roots that replace the implicit composition currently split across `GitHubRepoViewer.init()` (lines 158-392) and `buildContext()` (`websocket/index.js:26-119`).

**`examples/github-viewer/compose-viewer.js`** -- the GitHub repo viewer composition root:

```js
/**
 * compose-viewer.js -- composition root for the GitHub 3D repo viewer.
 *
 * Replaces the implicit wiring in GitHubRepoViewer.init() and
 * websocket/index.js buildContext(). Constructs services in dependency
 * order, wires callbacks, returns a bag of services + a dispose() fn.
 */

import * as THREE from 'three';
import { GlyphAtlas, CodeGrid, HierarchicalLayoutManager } from '../../src/index.js';
import { SceneContext } from './SceneContext.js';
import SceneRegistry from './websocket/SceneRegistry.js';
import { FileStateManager } from './FileStateManager.js';
import { CodeColorManager } from './CodeColorManager.js';
import { SelectionManager } from './SelectionManager.js';
import { ViewerCameraController } from './ViewerCameraController.js';
import { ShortcutManager } from './ShortcutManager.js';
import { BackdropManager } from './BackdropManager.js';
import { NameplateManager } from './NameplateManager.js';
import { HeatmapProvider } from './providers/HeatmapProvider.js';
import { GitHubRepositorySource } from './GitHubRepositorySource.js';
import { RepositoryAdapter } from './RepositoryAdapter.js';
import { DiffController } from './DiffController.js';

/**
 * @typedef {Object} ViewerServices
 * @property {SceneContext} ctx
 * @property {SceneRegistry} registry
 * @property {FileStateManager} fileStateManager
 * @property {CodeColorManager} codeColorManager
 * @property {SelectionManager} selectionManager
 * @property {ViewerCameraController} cameraController
 * @property {ShortcutManager} shortcutManager
 * @property {GlyphAtlas} atlas
 * @property {GitHubRepositorySource} githubSource
 * @property {RepositoryAdapter} repoAdapter
 * @property {DiffController} diffController
 * @property {Function} dispose
 */

/**
 * Construct all viewer services in dependency order.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Object} [options]
 * @param {Function} [options.onAtlasProgress] - (current, total) => void
 * @returns {Promise<ViewerServices>}
 */
export async function composeViewer(canvas, options = {}) {
    // ── Layer 0: Infrastructure ──────────────────────────────────────────

    const atlas = new GlyphAtlas();
    await atlas.generate(options.onAtlasProgress || (() => {}));

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0a);

    const camera = new THREE.PerspectiveCamera(
        70, window.innerWidth / window.innerHeight, 0.1, 10000
    );
    camera.position.set(0, 0, 500);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const registry = new SceneRegistry();

    const ctx = new SceneContext({
        THREE, scene, camera, renderer, canvas, atlas,
        getGrids: () => registry.toArray('grid'),
    });

    // ── Layer 1: Zero-dep services ───────────────────────────────────────

    const fileStateManager = new FileStateManager();
    const githubSource = new GitHubRepositorySource();
    const repoAdapter = new RepositoryAdapter();

    // ── Layer 2: Single-dep services ─────────────────────────────────────

    const codeColorManager = new CodeColorManager(ctx, fileStateManager);
    // Register the heatmap color layer (static color fn, no instance needed yet)
    codeColorManager.registerLayer('heatmap', {
        priority: 10,
        watchProperties: ['heatMetric'],
        colorFn: HeatmapProvider.createColorFn(),
    });

    const selectionManager = new SelectionManager(THREE, fileStateManager);

    // Selection color layer
    codeColorManager.registerLayer('selection', {
        priority: 15,
        watchProperties: ['selected'],
        colorFn: (_sourcePath, fileProps) => {
            if (!fileProps?.selected) return null;
            return { r: 0.2, g: 0.9, b: 0.6 };
        },
    });

    const diffController = new DiffController({
        scene, atlas, githubSource, repoAdapter,
    });

    // ── Layer 3: Multi-dep services ──────────────────────────────────────

    const cameraController = new ViewerCameraController(ctx);
    // DOM binding is deferred -- caller invokes cameraController.setupEventListeners()
    // or cameraController.bindUI({ resetBtn, fitAllBtn, sliders }) after DOM is ready.

    const shortcutManager = new ShortcutManager();

    // ── Event wiring (composition-root concern) ──────────────────────────

    // CameraController focus → DOM event for tree panel sync
    // (Today: CameraController.focusOnGrid line 435 fires window CustomEvent.
    //  After extraction: cameraController.onFocusChanged(cb) replaces that.)
    const _onFocusChanged = ({ index }) => {
        window.dispatchEvent(new CustomEvent('camera-focus-changed', {
            detail: { index }
        }));
    };
    cameraController.onFocusChanged(_onFocusChanged);

    // Canvas click → SelectionManager
    // (Today: CameraController line 118 fires canvas-click CustomEvent,
    //  GitHubRepoViewer line 296 listens and calls selectionManager.handleClick.
    //  After extraction: cameraController.onCanvasClick(cb) replaces that.)
    const _onCanvasClick = ({ clientX, clientY, ctrlKey, metaKey }) => {
        const additive = ctrlKey || metaKey;
        selectionManager.handleClick(
            clientX, clientY,
            canvas, camera,
            registry.toArray('grid'),
            additive
        );
    };
    cameraController.onCanvasClick(_onCanvasClick);

    // SelectionManager → file-selected DOM event for tree panel
    // (Today: SelectionManager._dispatchEvent at line 308.
    //  After extraction: selectionManager.on() callback replaces that.)
    const _onSelectionChanged = (eventType, sourcePath, state) => {
        window.dispatchEvent(new CustomEvent('file-selected', {
            detail: {
                sourcePath,
                primary: state.primary,
                selected: state.selected,
            }
        }));
    };
    selectionManager.on(_onSelectionChanged);

    // ── Dispose (reverse construction order) ─────────────────────────────

    function dispose() {
        // Unwire events first
        cameraController.offFocusChanged(_onFocusChanged);
        cameraController.offCanvasClick(_onCanvasClick);
        selectionManager.off(_onSelectionChanged);

        // Layer 3 → Layer 2 → Layer 1 → Layer 0
        shortcutManager.detach();
        cameraController.dispose();
        diffController.clearGrids();
        selectionManager.dispose();
        codeColorManager.dispose();
        fileStateManager.dispose();

        // Infrastructure
        const removed = registry.unregisterByType('grid');
        for (const entry of removed) {
            entry.grid.dispose();
            scene.remove(entry.grid);
        }
        renderer.dispose();
    }

    return {
        // Infrastructure
        ctx, registry, atlas, scene, camera, renderer,
        // Services
        fileStateManager, codeColorManager, selectionManager,
        cameraController, shortcutManager,
        githubSource, repoAdapter, diffController,
        // Lifecycle
        dispose,
    };
}
```

**`examples/github-viewer/compose-ide.js`** -- a hypothetical IDE-shell composition that reuses the same services but skips GitHub-specific pieces:

```js
/**
 * compose-ide.js -- composition root for a local-filesystem IDE shell.
 *
 * Demonstrates composability: reuses SceneContext, FileStateManager,
 * CodeColorManager, ViewerCameraController, but swaps in a
 * LocalFilesystemSource instead of GitHubRepositorySource.
 */

import * as THREE from 'three';
import { GlyphAtlas } from '../../src/index.js';
import { SceneContext } from './SceneContext.js';
import SceneRegistry from './websocket/SceneRegistry.js';
import { FileStateManager } from './FileStateManager.js';
import { CodeColorManager } from './CodeColorManager.js';
import { ViewerCameraController } from './ViewerCameraController.js';

/**
 * @param {HTMLCanvasElement} canvas
 * @param {Object} fileSource - anything with getFiles(): Promise<{path, content}[]>
 * @returns {Promise<Object>}
 */
export async function composeIDE(canvas, fileSource) {
    const atlas = new GlyphAtlas();
    await atlas.generate();

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0a);
    const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 10000);
    camera.position.set(0, 0, 500);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const registry = new SceneRegistry();
    const ctx = new SceneContext({
        THREE, scene, camera, renderer, canvas, atlas,
        getGrids: () => registry.toArray('grid'),
    });

    const fileStateManager = new FileStateManager();
    const codeColorManager = new CodeColorManager(ctx, fileStateManager);
    const cameraController = new ViewerCameraController(ctx);

    // No GitHub source, no DiffController, no SelectionManager.
    // The IDE shell adds its own file-loading logic using fileSource.

    function dispose() {
        cameraController.dispose();
        codeColorManager.dispose();
        fileStateManager.dispose();
        renderer.dispose();
    }

    return { ctx, registry, atlas, scene, camera, renderer,
             fileStateManager, codeColorManager, cameraController,
             dispose };
}
```

### Step 1: Service Constructor Signatures (Actual Refactors)

These are the real constructors today and what changes. Only services that need modification are listed.

**ViewerCameraController** (renamed from CameraController):

Current constructor at `CameraController.js:46`:
```js
constructor(ctx) {
    this.ctx = ctx;
    this.THREE = ctx.THREE;
    // ...
}
```

The constructor stays the same. The changes are:
1. Rename file to `ViewerCameraController.js`, class to `ViewerCameraController`.
2. Add callback registries for `onFocusChanged` and `onCanvasClick` (replacing the inline `window.dispatchEvent` at line 435 and `canvas.dispatchEvent` at line 118).
3. Extract `_bindSlider`/`_restoreUI`/button-binding from `setupEventListeners()` into a separate `bindUI(elements)` method.

Concrete additions to the class:

```js
// Add to constructor (after existing state):
this._focusListeners = new Set();
this._clickListeners = new Set();

// New methods:
onFocusChanged(cb) { this._focusListeners.add(cb); }
offFocusChanged(cb) { this._focusListeners.delete(cb); }

onCanvasClick(cb) { this._clickListeners.add(cb); }
offCanvasClick(cb) { this._clickListeners.delete(cb); }

// In focusOnGrid (line 435), replace:
//   window.dispatchEvent(new CustomEvent('camera-focus-changed', { detail: { index } }));
// with:
_notifyFocus(index) {
    for (const cb of this._focusListeners) {
        try { cb({ index }); } catch (e) { console.error('Focus listener error:', e); }
    }
}

// In _onMouseUp (line 118), replace:
//   canvas.dispatchEvent(new CustomEvent('canvas-click', { detail: {...} }));
// with:
_notifyClick(detail) {
    for (const cb of this._clickListeners) {
        try { cb(detail); } catch (e) { console.error('Click listener error:', e); }
    }
}
```

**`bindUI(elements)` split** -- extract from `setupEventListeners()` lines 181-215:

```js
/**
 * Bind optional DOM elements (sliders, buttons).
 * Call after construction if UI elements exist.
 * @param {Object} elements
 * @param {HTMLElement} [elements.resetBtn]
 * @param {HTMLElement} [elements.fitAllBtn]
 * @param {HTMLElement} [elements.speedSlider]
 * @param {HTMLElement} [elements.speedLabel]
 * @param {HTMLElement} [elements.dragSlider]
 * @param {HTMLElement} [elements.dragLabel]
 * @param {HTMLElement} [elements.scrollSlider]
 * @param {HTMLElement} [elements.scrollLabel]
 */
bindUI(elements) {
    if (elements.speedSlider) {
        this._bindSlider(elements.speedSlider, elements.speedLabel, (val) => {
            this.setSpeed(val);
        });
    }
    if (elements.dragSlider) {
        this._bindSlider(elements.dragSlider, elements.dragLabel, (val) => {
            this.settings.dragSensitivity = val;
            this._persistSettings();
        });
    }
    if (elements.scrollSlider) {
        this._bindSlider(elements.scrollSlider, elements.scrollLabel, (val) => {
            this.settings.scrollSensitivity = val;
            this._persistSettings();
        });
    }
    if (elements.resetBtn) {
        this._onReset = () => this.reset();
        elements.resetBtn.addEventListener('click', this._onReset);
        this._resetBtn = elements.resetBtn;
    }
    if (elements.fitAllBtn) {
        this._onFitAll = () => this.focusOnGrids();
        elements.fitAllBtn.addEventListener('click', this._onFitAll);
        this._fitAllBtn = elements.fitAllBtn;
    }
    this._restoreUI(elements);
}
```

This means `setupEventListeners()` loses lines 181-215 (the `_bindSlider` calls and button bindings) and the `_restoreUI()` call. Those move to `bindUI()`. The core input listeners (keydown, mousedown, mouseup, mousemove, wheel, resize) stay in `setupEventListeners()`.

**SelectionManager** -- no constructor change needed. Current constructor at `SelectionManager.js:28`:
```js
constructor(THREE, fileStateManager) { ... }
```
This is already clean DI. The only change: remove `_dispatchEvent()` (lines 308-316) from the class body. The composition root's `selectionManager.on()` callback handles the DOM dispatch instead. The internal `_notify()` at line 289 already fires callbacks to `_listeners` -- that is the mechanism the composition root uses.

**BackdropManager** -- current constructor at `BackdropManager.js:37`:
```js
constructor(scene, options = {}) { ... }
```
Already clean. No `import * as THREE from 'three'` change needed (settled item 8). The only change: rename `destroy()` to `dispose()` (which internally calls the existing `dispose()` + `scene.remove(this.group)`). Or keep both but document `dispose()` as the canonical name.

**NameplateManager** -- current constructor at `NameplateManager.js:32`:
```js
constructor(scene, atlas, options = {}) { ... }
```
Already clean. Same `destroy()` rename applies.

**CodeColorManager** -- current constructor at `CodeColorManager.js:26`:
```js
constructor(ctx, fileStateManager) { ... }
```
Already clean DI. `ctx` provides `getGrids()` for `updateAllColors()`. No change needed.

**FileStateManager** -- current constructor at `FileStateManager.js:18`:
```js
constructor() { ... }
```
Zero dependencies. No change.

**HeatmapProvider** -- current constructor at `HeatmapProvider.js:52`:
```js
constructor(ctx, fileStateManager) { ... }
```
Already clean DI. No change.

**DiffController** -- current constructor at `DiffController.js:35`:
```js
constructor({ scene, atlas, githubSource, repoAdapter }) { ... }
```
Already clean DI with destructured options. All four params are real (confirmed in source). The composition-pattern Round 1 example showing `{ scene, atlas, registry }` was wrong, as service-boundaries flagged. No change needed.

**SceneContext** -- current constructor at `SceneContext.js:23`:
```js
constructor(refs) { ... }
```
Change: remove lines 33-34 (`this.hierarchicalManager = null; this.layoutManager = null;`). These mutable fields move to the composition root. Services that need layout managers receive them directly (e.g., `focusOnGrids()` in CameraController currently reaches `this.ctx.hierarchicalManager` -- that needs to become a method parameter or an injected provider callback).

### Step 2: The `buildContext()` Replacement

`buildContext()` at `websocket/index.js:26-119` constructs a 20-property bag by reaching into the viewer 20+ times. This function stays in the example layer (it is application-specific composition). It does NOT move to `src/services/`.

The refactored version receives the services bag from `composeViewer()` instead of a monolithic viewer:

```js
/**
 * Build command context from composed services.
 * Lives in examples/github-viewer/websocket/index.js.
 *
 * @param {ViewerServices} services - from composeViewer()
 * @param {Object} viewer - GitHubRepoViewer (for layout state, UI methods)
 * @returns {Object}
 */
function buildContext(services, viewer) {
    const { registry, scene, camera, renderer, atlas,
            cameraController, selectionManager, fileStateManager,
            codeColorManager } = services;

    return {
        scene, camera, renderer, atlas,
        registry,
        getGrids: () => registry.toArray('grid'),
        addGrid(grid, opts = {}) {
            const sourcePath = grid.getSourcePath?.() || null;
            const filename = grid.getFilename?.() || grid.name || null;
            const id = opts.id || sourcePath || filename
                || `grid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            if (!registry.getIdByGrid(grid)) {
                registry.register(id, grid, {
                    type: opts.type || 'grid',
                    sourcePath, filename, ...opts.meta,
                });
            }
            if (!grid.parent) scene.add(grid);
            return id;
        },
        removeGrid(idOrIndex) {
            // ... same logic as today, referencing registry and scene ...
        },
        cameraController,
        selectionManager: selectionManager || null,
        fileStateManager: fileStateManager || null,
        codeColorManager: codeColorManager || null,
        getActiveLayout: () => viewer._activeLayout,
        layoutManagers: {
            hierarchical: viewer.hierarchicalManager,
            spiral: viewer.spiralManager,
            treemap: viewer.treemapManager,
            grid: viewer.layoutManager,
        },
        windowManager: viewer.windowManager || null,
        wsbridge: null,
        annotations: new Map(),
        gridVisualState: new Map(),
        _cancelCameraAnimation: null,
    };
}
```

Note: `layoutManagers` and `getActiveLayout` still reference `viewer` directly because layout state management remains in the app shell. This is intentional -- layout choice is UI state, not a composable service.

### Step 3: `GitHubRepoViewer.init()` Decomposition

Today `init()` spans lines 158-392 (~235 lines). The decomposition:

1. **DOM setup** (lines 160-214) -- stays in the app shell. Creates header, loading overlay, drawer, panels, caches DOM element refs. This is inherently app-specific.

2. **Service composition** (lines 217-286) -- moves to `composeViewer()`. Atlas generation, Three.js setup, SceneContext, CameraController, FileStateManager, CodeColorManager, SelectionManager.

3. **Event wiring** (lines 288-316) -- moves to `composeViewer()` as callback registrations (see Step 0). The DOM-side listeners (`window.addEventListener('camera-focus-changed', ...)` and `window.addEventListener('file-selected', ...)`) stay in the app shell because they manipulate DOM classes on `.tree-item` elements.

4. **Shortcut registration** (lines 318-321) -- the `ShortcutManager` construction moves to `composeViewer()`. The `_registerShortcuts()` call stays in the app shell (shortcuts reference `this.selectionManager`, `this.cameraController`, `this.grids`, `this.minimapOverlay` -- app-level orchestration).

5. **Optional subsystems** (lines 324-370) -- MinimapOverlay, HandGestureAdapter, command center. These stay in the app shell. They are UI-specific or optional integrations.

The refactored `init()` becomes:

```js
async init() {
    const body = document.body;

    // 1. DOM setup (unchanged)
    this.header = createHeader(body);
    this.loading = createLoadingOverlay(body);
    this.fpsBadge = createFPSBadge(body);
    this.loading.show('Generating glyph atlas...');
    this.drawer = new DrawerController(body, [/* panels */]);
    // ... panel setup, toast, DOM caching ...

    // 2. Compose services
    const services = await composeViewer(this.canvas, {
        onAtlasProgress: (current, total) => {
            this.loading.update(current / total, `Generating glyphs: ${current}/${total}`);
        },
    });

    // Expose services on `this` for backward compat with app shell methods
    Object.assign(this, {
        scene: services.scene,
        camera: services.camera,
        renderer: services.renderer,
        atlas: services.atlas,
        registry: services.registry,
        sceneContext: services.ctx,
        cameraController: services.cameraController,
        fileStateManager: services.fileStateManager,
        codeColorManager: services.codeColorManager,
        selectionManager: services.selectionManager,
        shortcutManager: services.shortcutManager,
        githubSource: services.githubSource,
        repoAdapter: services.repoAdapter,
        diffController: services.diffController,
    });
    this._services = services;  // retain for dispose()

    // 3. Camera DOM bindings (app shell owns these DOM elements)
    this.cameraController.setupEventListeners();
    this.cameraController.bindUI({
        resetBtn: document.getElementById('reset-camera'),
        fitAllBtn: document.getElementById('fit-all'),
        speedSlider: document.getElementById('cam-speed'),
        speedLabel: document.getElementById('cam-speed-value'),
        dragSlider: document.getElementById('drag-sensitivity'),
        dragLabel: document.getElementById('drag-sensitivity-value'),
        scrollSlider: document.getElementById('scroll-sensitivity'),
        scrollLabel: document.getElementById('scroll-sensitivity-value'),
    });

    // 4. DOM-side event listeners (tree panel sync)
    window.addEventListener('camera-focus-changed', (e) => {
        const { index } = e.detail;
        document.querySelectorAll('.tree-item').forEach((item, i) => {
            item.classList.toggle('selected', i === index);
        });
    });
    window.addEventListener('file-selected', (e) => {
        const { selected } = e.detail;
        const selectedSet = new Set(selected);
        document.querySelectorAll('.tree-item.tree-file').forEach((item) => {
            const path = item.dataset?.path;
            item.classList.toggle('selected', path ? selectedSet.has(path) : false);
        });
    });

    // 5. Shortcuts, minimap, hand gesture, command center (unchanged from today)
    this.shortcutManager = services.shortcutManager;
    this._registerShortcuts();
    this.shortcutManager.attach();
    // ... minimap, hand gesture, command center init ...

    // 6. Start animation loop, state persistence, etc.
    this.animate();
    this.statePersistence = new StatePersistence(this);
    // ...
}
```

### Step 4: CameraController.focusOnGrids() Layout Manager Access

The current `focusOnGrids()` at line 443 reaches through `this.ctx.stackManager`, `this.ctx.treemapManager`, `this.ctx.spiralManager`, `this.ctx.hierarchicalManager`, `this.ctx.layoutManager` -- all mutable SceneContext fields. After removing mutable fields from SceneContext, these need a different access path.

**Option A (recommended):** Inject a `getLayoutBounds` callback via the composition root, similar to how MinimapOverlay already does it (line 328-334):

```js
// In composeViewer(), after creating cameraController:
cameraController.setLayoutBoundsProvider(() => {
    // Same logic as MinimapOverlay's getLayoutBounds
    if (viewer.stackManager && viewer._activeLayout === 'stack')
        return viewer.stackManager.getTotalBounds();
    if (viewer.treemapManager)  return viewer.treemapManager.getTotalBounds();
    if (viewer.spiralManager)   return viewer.spiralManager.getTotalBounds();
    if (viewer.hierarchicalManager) return viewer.hierarchicalManager.getTotalBounds();
    return null;
});
```

Then `focusOnGrids()` becomes:
```js
focusOnGrids() {
    const grids = this.ctx.getGrids();
    if (grids.length === 0) return;
    const bounds = this._getLayoutBounds?.() || this._computeGridsBounds(grids);
    // ... rest of method unchanged ...
}
```

This removes all `this.ctx.stackManager` / `this.ctx.treemapManager` references from CameraController. Similarly, `focusOnDirectory()` (line 473) needs `hierarchicalManager.getDirectoryBounds(dirPath)` -- provide a `getDirectoryBounds` callback:

```js
cameraController.setDirectoryBoundsProvider((dirPath) => {
    return viewer.hierarchicalManager?.getDirectoryBounds(dirPath) || null;
});
```

### Step 5: Disposal Ordering

Construction order (from `composeViewer()`):
1. GlyphAtlas
2. THREE.Scene, Camera, Renderer
3. SceneRegistry
4. SceneContext
5. FileStateManager
6. GitHubRepositorySource, RepositoryAdapter
7. CodeColorManager (subscribes to FileStateManager)
8. SelectionManager
9. DiffController
10. ViewerCameraController (DOM listeners)
11. ShortcutManager

Disposal order (reverse):
1. ShortcutManager.detach()
2. ViewerCameraController.dispose() -- removes DOM listeners
3. DiffController.clearGrids()
4. SelectionManager.dispose() -- clears internal listeners
5. CodeColorManager.dispose() -- unsubscribes from FileStateManager
6. FileStateManager.dispose() -- clears all listeners and data
7. (BackdropManager, NameplateManager, TreemapLabelManager dispose -- if created)
8. Registry: unregister all grids, dispose each, remove from scene
9. Renderer.dispose()
10. (Atlas has no dispose -- GC handles it)

Critical ordering constraint: **CodeColorManager.dispose() must happen before FileStateManager.dispose()**. CodeColorManager subscribes to FileStateManager via `onPropertyChanged()` (line 38). If FileStateManager disposes first (clearing all listeners), CodeColorManager's `dispose()` call to `offPropertyChanged()` becomes a no-op -- harmless, but the reverse order is semantically correct.

### Step 6: Phased File Moves

**Phase 1 (zero-dep, can ship independently):**
- `FileStateManager.js` -> `src/services/FileStateManager.js`
- `DiffParser.js` -> `src/services/DiffParser.js`
- `websocket/SceneRegistry.js` -> `src/services/SceneRegistry.js`
- `platform.js` -> `src/services/platform.js`

**Phase 2 (infrastructure):**
- `SceneContext.js` -> `src/services/context/SceneContext.js` (remove mutable fields)

**Phase 3 (visual, single-dep):**
- `BackdropManager.js` -> `src/services/visual/BackdropManager.js` (rename `destroy` to `dispose`)
- `NameplateManager.js` -> `src/services/visual/NameplateManager.js` (rename `destroy` to `dispose`)
- `TreemapLabelManager.js` -> `src/services/visual/TreemapLabelManager.js` (rename `destroy` to `dispose`)

**Phase 4 (core services):**
- `CodeColorManager.js` -> `src/services/CodeColorManager.js`
- `SelectionManager.js` -> `src/services/SelectionManager.js` (remove `_dispatchEvent`)
- `CameraController.js` -> `src/services/camera/ViewerCameraController.js` (rename, add callbacks, split `bindUI`)
- `providers/HeatmapProvider.js` -> `src/services/providers/HeatmapProvider.js`
- `ShortcutManager.js` -> `src/services/ShortcutManager.js`

**Phase 5 (data):**
- `GitHubRepositorySource.js` -> `src/services/data/GitHubRepositorySource.js`
- `RepositoryAdapter.js` -> `src/services/data/RepositoryAdapter.js`

**Phase 6 (orchestration):**
- `websocket/CommandRouter.js` -> `src/services/CommandRouter.js`
- `websocket/ViewerAPI.js` -> `src/services/ViewerAPI.js`
- `websocket/WebSocketBridge.js` -> stays in examples (DOM coupling via `_createStatusBar`)

**Deferred:**
- Command modules (16 files) -- context interface not stable
- StatePersistence -- deep DOM coupling
- TUI (4 files) -- specialized subsystem
- HandGestureAdapter -- depends on src/hand/ subsystem

---

## Implementer Vote

**Start with Phase 1 (zero-dep extractions) immediately.** These four files (FileStateManager, DiffParser, SceneRegistry, platform.js) have zero cross-dependencies, zero DOM coupling, and zero controversy. They can be extracted as a standalone PR that proves the pattern without touching any wiring.

**Then create `compose-viewer.js` as Phase 2** alongside the SceneContext immutability refactor. This is the architectural linchpin -- once the composition root exists, subsequent service extractions are mechanical file moves with import path updates.

**Do NOT attempt the CameraController refactor (Phase 4) before the composition root exists.** The callback additions (`onFocusChanged`, `onCanvasClick`), `bindUI()` split, and `setLayoutBoundsProvider()` only make sense when there is a composition root to wire them. Without it, the refactored CameraController would be a service that nobody calls correctly.

The highest-risk item is Step 4 (CameraController layout manager access). The current code at `focusOnGrids()` line 448 chains through `this.ctx.stackManager ? ... : this.ctx.treemapManager ? ...` etc. Replacing this with a callback means the callback must be updated every time the active layout changes. The MinimapOverlay already solves this exact problem (lines 328-334) -- copy that pattern.

**My confidence ordering:** Phase 1 extraction is trivially safe. The composition root (`compose-viewer.js`) is medium risk -- it is a new file that does not break existing code (additive). The CameraController refactor is the highest risk due to the number of `this.ctx` references (~40 across 597 lines) and the DOM binding split.

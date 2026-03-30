# Round 2 (Inverse): service-boundaries reviews extraction-plan, then composition-pattern

---

## Reaffirm or Retract

### Reaffirmed

1. **My 14 services are accurate but incomplete.** Both reviewers correctly flagged that I omitted CameraController (597 lines, heavy DOM coupling), ShortcutManager, HeatmapProvider, and platform.js. I reaffirm these are real services. My Phase 0 focused on files I classified as cleanly extractable; I should have cataloged the harder cases too. Updated count: 18 services + 1 utility (platform.js).

2. **SceneContext should NOT live under `camera/`.** I flagged this in Round 1 (item 3). The extraction-plan places it at `src/services/camera/SceneContext.js`. SceneContext is consumed by CameraController, CodeColorManager, HeatmapProvider, and the command system's `buildContext()`. It is general infrastructure. I reaffirm: `src/services/context/SceneContext.js` or `src/services/SceneContext.js`.

3. **Visual services (BackdropManager, NameplateManager, TreemapLabelManager) are the easiest extractions.** Both reviewers acknowledged these were missing from the extraction plan. I reaffirm they should be Phase 1 material after the `import * as THREE` question is settled.

4. **DiffController composition-pattern constructor is wrong.** The actual constructor at `DiffController.js:35` takes `{ scene, atlas, githubSource, repoAdapter }`. The composition-pattern example shows `{ scene, atlas, registry }`. Extraction-plan agent confirmed my correction. This must be fixed.

### Retracted

5. **I was wrong to classify websocket/ wholesale as EXAMPLE.** In my Phase 0 I wrote "websocket/ stays in examples." After reading all three reviews and re-examining the code, I retract this. SceneRegistry (zero DOM, zero WebSocket deps) and CommandRouter (pure dispatch, no DOM) clearly belong in `src/services/`. ViewerAPI is borderline but extractable. WebSocketBridge requires the status-bar DOM to be made opt-in. The 16 command modules are the hardest part -- they depend on a context shape that becomes a public contract. My blanket classification was too conservative.

6. **I understated BackdropManager/NameplateManager extraction effort.** My Phase 0 said "no DOM changes needed" for both. The extraction-plan agent correctly caught that `import * as THREE from 'three'` at module scope (BackdropManager.js:9, NameplateManager.js:11) is a hard dependency on importmap resolution. Additionally, `spatialHelpers.js:12` has the same pattern. These files DO need a change -- either to DI-injected THREE or to an explicit peer-dep contract. "No DOM changes" was technically true but missed the import resolution problem.

---

## Evolved Understanding

### The THREE.js question is settled by the existing codebase

Three files use `import * as THREE from 'three'`: BackdropManager, NameplateManager, spatialHelpers. Meanwhile, CameraController receives `ctx.THREE`, SelectionManager receives `THREE` as a constructor argument, and CodeColorManager accesses it via `ctx.THREE`. The codebase already has a dominant pattern: **DI-injected THREE**. The three files using bare imports are the outliers. Converting them to accept THREE via constructor is consistent, not aspirational. This resolves the tension: all extracted services should receive THREE via constructor DI.

### The event pattern tension has a clear resolution

Composition-pattern advocates CustomEvent on canvas/window. My Phase 0 said remove `window.dispatchEvent()` and inject emitters. The extraction-plan agent proposed the synthesis I now agree with: **services use internal callbacks (`on()`/`off()`); the composition root wires those callbacks to DOM events if needed.** SelectionManager already has this dual pattern -- internal `_listeners` + `_dispatchEvent()`. The fix is to make `_dispatchEvent()` an external concern: the composition root subscribes via `selectionManager.on()` and dispatches the CustomEvent itself. Services stay DOM-free; the app layer decides how events propagate.

### CameraController extraction is the hardest single service

After reading all reviews and re-examining the source (lines 198-268), CameraController has: `document.getElementById('reset-camera')`, `document.getElementById('fit-all')`, `document.getElementById(sliderId)` called 3 times, `document.getElementById(labelId)`, `localStorage.getItem/setItem`, `window.dispatchEvent(new CustomEvent('camera-focus-changed'))`, and `canvas.dispatchEvent(new CustomEvent('canvas-click'))`. The composition-pattern agent's recommendation to split into a core class + an optional `bindUI(elements)` method is the right approach. The core camera logic (WASD, drag, scroll, focus, physics) is ~400 lines of clean, reusable code. The DOM bindings are ~100 lines of app-specific wiring.

---

## Convergence

All three agents now agree on:

1. **CameraController, ShortcutManager, HeatmapProvider, platform.js must be in scope.** My Phase 0 missed them. The extraction-plan included CameraController and HeatmapProvider. The composition-pattern agent flagged all four. Consensus: 18+ services, not 14.

2. **SceneRegistry must extract.** Despite living in `websocket/`, it has zero WebSocket or DOM coupling. It is the central truth store for scene objects. All three agents agree it belongs in `src/services/`.

3. **Extraction order should follow dependency depth, not architectural layers.** Zero-dep services first (FileStateManager, DiffParser, RepositoryContentCache, SceneRegistry, platform.js), then single-dep (CodeColorManager, SelectionManager), then multi-dep (CameraController, DiffController), then orchestration (CommandRouter, ViewerAPI), then wiring (WebSocketBridge, initCommandCenter). The extraction-plan's original phasing (commands first, camera second) was inverted relative to the actual dependency graph.

4. **SceneContext is fine as a pattern but must not live under `camera/`.** The composition-pattern's aspiration to destructure it into 6+ params per constructor is a larger refactor than warranted right now. Keep SceneContext, move it to `src/services/context/` or top-level `src/services/`.

5. **`window.viewer = api` belongs in example code, not in extracted library services.** The `initCommandCenter()` function at `websocket/index.js:156` sets this global. If initCommandCenter moves to `src/services/`, the global assignment must be the caller's responsibility.

---

## Remaining Tensions

### 1. GitHub-specific code in core package

GitHubRepositorySource is a GitHub API client. The extraction-plan puts it in `src/services/data/`. Should a generic 3D text rendering library ship a GitHub API client? The argument for: it enables the primary use case without external wiring. The argument against: it pollutes the package with platform-specific code. My position: extract it, but behind a sub-export (`glyph3d-js/services/data`) so it is tree-shakeable and optional. Do not re-export it from the top-level `glyph3d-js` entry point.

### 2. Command modules as public API

The 16 command modules in `websocket/commands/` each call `context.scene`, `context.cameraController`, `context.registry`, `context.getGrids()`, etc. Extracting them means the context bag shape (currently defined ad-hoc in `buildContext()` at `websocket/index.js:26-119`) becomes a public contract. No agent has proposed a typed interface for this context. Without one, command modules are fragile exports -- any consumer must replicate the exact same bag shape. My position: define a `CommandContext` interface (JSDoc typedef) that documents required fields. Extract command modules only after that interface stabilizes.

### 3. CameraController name collision

`src/camera/CameraController.js` already exists (physics-based, takes `(camera, inputManager, config)`). The github-viewer's CameraController is a completely different implementation (translation-first, SceneContext-based, 597 lines). The extraction-plan proposes `src/services/camera/CameraController.js`, creating two classes with the same name in the same package. The composition-pattern agent suggested renaming to `ViewerCameraController` or deprecating the old one. I lean toward renaming the github-viewer version to `NavigationController` -- it handles navigation (pan, zoom, focus, WASD), not just the camera object. The old `src/camera/CameraController.js` is the library's original physics-based controller and should remain as-is.

### 4. StatePersistence extraction feasibility

StatePersistence's `restoreUI()` does `document.getElementById('layout-mode')`, `document.getElementById('repo-url')`, etc. It also calls `window.location.reload()`. This is the deepest DOM coupling of any candidate. All three agents acknowledged it but no consensus on timing. My position: defer to last phase, after viewer refactor exposes typed state accessors. It should not block other extractions.

---

## Synthesis

The actionable extraction plan, incorporating all three perspectives:

**Phase 0 (prep):** Define `CommandContext` JSDoc typedef. Decide on `NavigationController` name. Establish THREE-via-DI as the standard.

**Phase 1 (zero-dep):** FileStateManager, DiffParser, RepositoryContentCache, SceneRegistry, platform.js. Pure data, pure functions, zero controversy.

**Phase 2 (single-dep visual):** BackdropManager, NameplateManager, TreemapLabelManager. Refactor `import * as THREE` to constructor DI. Add `dispose()` as canonical cleanup name (not `destroy()`).

**Phase 3 (state + selection):** CodeColorManager, SelectionManager, HeatmapProvider. Remove `window.dispatchEvent` from SelectionManager; expose only `on()`/`off()`. Composition root wires to DOM events.

**Phase 4 (data):** GitHubRepositorySource, RepositoryAdapter. Behind `glyph3d-js/services/data` sub-export.

**Phase 5 (camera):** NavigationController (renamed), SceneContext (at `src/services/context/`). Split CameraController into core + `bindUI()`. Inject storage adapter for localStorage.

**Phase 6 (input):** HandGestureAdapter, ShortcutManager. Replace `canvas.dispatchEvent()` in HandGestureAdapter with callback injection.

**Phase 7 (commands):** CommandRouter, ViewerAPI, command modules (only after CommandContext interface is defined).

**Phase 8 (websocket):** WebSocketBridge (status bar opt-in), initCommandCenter (no `window.viewer` assignment).

**Deferred:** StatePersistence, DiffController (depends on both data services and Three.js scene), TUI system.

---

## Dissent

### Against the composition-pattern's "aspirational pseudocode" approach

The composition-pattern document's CameraController "Before/After" examples (lines 25-82) present code that does not exist. The "Before" dramatizes coupling (`this.ctx.getGrids()[index]`) that is not how `focusOnGrid` works -- the actual method receives grids as parameters. The "After" shows a destructured constructor that would require rewriting ~50 references to `this.ctx.camera` and `this.ctx.renderer` across 597 lines. Aspirational examples are useful for direction-setting, but when they misrepresent current code, they generate incorrect refactoring estimates. Future composition-pattern guidance should either use real code snippets or explicitly label examples as aspirational and state the delta from reality.

### Against extracting all 16 command modules in one phase

The extraction-plan proposes moving all command modules together (Phase 6). Each module has different dependency depth: `systemCommands.js` is lightweight (queries camera position), while `gridCommands.js` creates CodeGrid instances and adds them to the scene. Extracting them as a monolith means the heaviest module's dependencies constrain the lightest. Instead, categorize command modules by dependency tier and extract in sub-phases, or accept that some modules stay in examples until their dependency surface shrinks.

### For keeping SceneContext (against full destructuring)

The composition-pattern advocates eliminating SceneContext in favor of destructured constructor params. I dissent. SceneContext is 41 lines with zero behavior. It documents the shared references in one place. Destructuring `{ camera, canvas, renderer, scene, atlas, THREE, getGrids }` into every service constructor that needs 3+ of those references creates more noise than clarity. The real problem with SceneContext is not its existence but its namespace placement and the fact that it accumulates late-bound properties (`hierarchicalManager`, `layoutManager`). Fix those (move late bindings to the composition root, not SceneContext) and the pattern is clean.

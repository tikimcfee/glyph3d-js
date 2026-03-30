# Round 1 Review: composition-pattern reviews service-boundaries + extraction-plan

**Reviewer perspective:** Constructor DI, composition roots, event-based inter-service communication, layered composition, explicit dispose().

---

## Errors Found

### 1. Extraction-plan says CameraController has light DOM coupling -- it has heavy DOM coupling

Extraction-plan (Phase 2) states: "DOM Coupling: CameraController reads localStorage for settings (acceptable; web only), Listens to window events: resize, keydown, mousemove, wheel. Decoupling: None needed; event pattern is clean."

This dramatically understates the problem. `examples/github-viewer/CameraController.js` has:
- `document.getElementById('reset-camera')` at line 198
- `document.getElementById('fit-all')` at line 206
- `document.getElementById(sliderId)` at line 259 (called 3x for cam-speed, drag-sensitivity, scroll-sensitivity)
- `document.getElementById(labelId)` at line 260
- `canvas.dispatchEvent(new CustomEvent('canvas-click', ...))` at line 118
- `window.dispatchEvent(new CustomEvent('camera-focus-changed', ...))` at line 435
- `localStorage.getItem/setItem` at lines 30, 38

The extraction-plan's claim that "Decoupling: None needed" is wrong. CameraController binds to 6+ hardcoded DOM element IDs. This must be addressed for it to be a reusable service.

### 2. Service-boundaries omits CameraController entirely

Service-boundaries lists 14 services but CameraController is not among them. CameraController is one of the most complex services in the codebase (~600 lines). It needs boundary analysis -- constructor deps, public API, DOM coupling, events.

### 3. Service-boundaries omits ShortcutManager

`ShortcutManager` (`examples/github-viewer/ShortcutManager.js`) is instantiated in `GitHubRepoViewer.js` at line 319. It has a clean constructor DI pattern, registers keyboard shortcuts in capture phase, and has `attach()`/`detach()` lifecycle. Neither document mentions it.

### 4. Extraction-plan omits HeatmapProvider from service-boundaries classification

Service-boundaries does not list HeatmapProvider. Extraction-plan includes it in Phase 4 (data loading). However, HeatmapProvider is not a data loader -- it is a visual computation service that depends on `SceneContext` and `FileStateManager` (line 49-50 of `HeatmapProvider.js`). It belongs in the Visual Composition cluster, not Data Access.

### 5. Name collision: `src/camera/CameraController.js` already exists

Both documents ignore that `src/camera/CameraController.js` already exists as a different, older class (physics-based, takes `(camera, inputManager, config)` constructor). The extraction-plan proposes `src/services/camera/CameraController.js` which creates a confusing parallel. The existing `src/camera/` has CameraController, InputManager, and Camera -- these are the library's original camera system. The github-viewer's CameraController is a completely different implementation (translation-first, SceneContext-based).

---

## Gaps

### 1. No plan for the `buildContext()` function in `websocket/index.js`

The `buildContext()` function (lines 26-119 of `websocket/index.js`) is the current ad-hoc composition root. It reaches deep into `viewer` to extract ~20 references, creates `addGrid()`/`removeGrid()` closures over `viewer.scene` and `registry`, and wires layout managers by name. Neither document addresses how this becomes a proper composition root. This is the single most important function to refactor for the composition pattern.

### 2. No plan for SceneRegistry ownership transfer

`SceneRegistry` is created in `GitHubRepoViewer` (line 115) but used heavily by the command system. The extraction-plan moves it to `src/services/registry/` but doesn't address who owns it in the new composition. The `grids` getter on GitHubRepoViewer (line 149) is backed by `registry.toArray('grid')` -- if registry moves to a service, this coupling must be addressed.

### 3. Event topology is undocumented

Three CustomEvent channels exist:
- `canvas-click` on canvas (CameraController line 118 + HandGestureAdapter line 358 -> GitHubRepoViewer line 296 -> SelectionManager.handleClick)
- `camera-focus-changed` on window (CameraController line 435 -> GitHubRepoViewer line 288)
- `file-selected` on window (SelectionManager line 309 -> GitHubRepoViewer line 309)

These are the actual inter-service communication channels. Neither document maps them or proposes how they translate to the new composition pattern. My Phase 0 conclusion was "CustomEvent on canvas/window for inter-service communication" -- but the current events route through GitHubRepoViewer as the mediator, not directly between services.

### 4. MinimapOverlay missing from both analyses

`MinimapOverlay` is imported and used in GitHubRepoViewer (line 24). It is a component in `components/` but likely has service-like characteristics (it tracks camera position, renders a minimap). Neither document evaluates whether it stays in examples or extracts.

---

## Tensions

### 1. SceneContext as-is vs. explicit constructor DI

Service-boundaries correctly identifies SceneContext as a "shared reference bag." Extraction-plan keeps it as-is. But my Phase 0 conclusion was to move away from ctx bags toward explicit deps. CameraController currently takes `ctx` and pulls `ctx.camera`, `ctx.canvas`, `ctx.THREE`, `ctx.renderer` from it. If we're doing constructor DI, the bag defeats the purpose -- you can't know a service's real dependencies without reading its implementation.

**Resolution:** SceneContext can survive as infrastructure-layer glue, but services should declare their actual deps. CameraController should take `{ camera, canvas, THREE }` not `ctx`.

### 2. Extraction-plan's phasing vs. actual dependency order

Extraction-plan Phase 1 is CommandRouter (websocket/), Phase 2 is CameraController. But CameraController has zero dependency on CommandRouter, while CommandRouter's `buildContext()` depends on CameraController being instantiated. The extraction order should be: infrastructure services first (FileStateManager, SceneRegistry), then core services (CameraController, SelectionManager), then wiring (CommandRouter, ViewerAPI). The plan has it inverted.

### 3. Service-boundaries says "events: none" for services that do emit events

Service-boundaries lists CameraController nowhere, but more importantly, it says BackdropManager, NameplateManager, and CodeColorManager have "Events: None." While technically true (they don't dispatch CustomEvents), CodeColorManager subscribes to `fileStateManager.onPropertyChanged()` (line 98). This is an event subscription. The boundary analysis should distinguish between "emits events" and "subscribes to events" -- both are part of the service boundary.

---

## Recommendations (max 10)

1. **Add CameraController and ShortcutManager to the service boundary analysis.** CameraController is the most DOM-coupled service and needs explicit decoupling steps. ShortcutManager is small but is a real service with lifecycle.

2. **Split CameraController's DOM bindings into an optional `bindUI(elements)` method.** The core camera logic (WASD, drag, scroll, focus) is reusable. The `document.getElementById('reset-camera')` etc. is app-specific UI wiring. Separate them so the service works without the slider DOM.

3. **Reverse the extraction phase order.** Start with zero-dep services (FileStateManager, DiffParser, RepositoryContentCache, SceneRegistry), then single-dep services (CodeColorManager, SelectionManager, CameraController), then orchestration (CommandRouter, ViewerAPI, initCommandCenter). This matches actual dependency flow.

4. **Map the event topology explicitly** before extracting. Document the three CustomEvent channels (`canvas-click`, `camera-focus-changed`, `file-selected`), who produces, who consumes, and what the composition root does as mediator. This is the wiring diagram.

5. **Resolve the CameraController name collision.** Either rename the github-viewer's to `ViewerCameraController`, deprecate the old `src/camera/CameraController.js`, or merge them. Do not create two classes with the same name in the package.

6. **Reclassify HeatmapProvider** from "Data Access" to "Visual Composition" -- it depends on SceneContext and FileStateManager, computes visual properties, and writes to FileStateManager. It sits between data and rendering.

7. **Extract `buildContext()` from `websocket/index.js` into the composition root pattern.** This function is currently the implicit composition root. Make it explicit: a `createViewerServices(deps)` function that returns a bag of instantiated, wired services.

8. **Replace SceneContext with a typed service locator or explicit deps** for each service. At minimum, document which fields each service actually reads from SceneContext so the dependency is auditable.

9. **Add `dispose()` audit for all services.** CameraController has `dispose()` (line 592). SelectionManager has `dispose()`. But the extraction-plan doesn't verify all 14+ services have proper cleanup. BackdropManager has both `dispose()` and `destroy()` -- pick one convention.

10. **Keep `window.viewer = api` assignment out of library code.** The extraction-plan moves `initCommandCenter` to `src/services/websocket/` but it sets `window.viewer = api` (line 156 of `websocket/index.js`). Global assignment belongs in the example, not in a library service.

---

## Key Insight

The extraction-plan treats this as a file-move operation (git mv + import rewrite). The service-boundaries document treats it as an API catalog. Neither addresses the core architectural challenge: **the current composition is implicit -- `GitHubRepoViewer.init()` is a 300+ line method that creates services in a specific order, wires events through itself as mediator, and passes `this` (the viewer) to services that then reach back into it for arbitrary properties.**

The real extraction work is not moving files -- it is making `buildContext()` and `GitHubRepoViewer.init()` into an explicit, layered composition root where each service declares its dependencies via constructor, receives only what it needs, and communicates via events rather than reaching into the viewer. The file moves are a consequence of that architectural change, not the driver of it.

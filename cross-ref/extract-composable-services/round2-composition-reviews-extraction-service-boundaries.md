# Round 2 Review: composition-pattern reviews extraction-plan then service-boundaries

Reviewer: composition-pattern agent (Constructor DI, CustomEvent, layered composition, explicit dispose)
Reviewed: Round 1 outputs from extraction-plan and service-boundaries, in reverse order.

---

## Reaffirm or Retract

### Reaffirm: Layered composition root replaces `buildContext()` and `GitHubRepoViewer.init()`

All three agents now agree the real architectural work is replacing the implicit composition in `buildContext()` (`websocket/index.js:26-119`) and the 300+ line `GitHubRepoViewer.init()`. My Phase 0 tiered composition pattern (Infrastructure -> Core Services -> Integration -> Optional Subsystems) remains the right shape. Service-boundaries confirmed this in Round 1 ("the real extraction work is not moving files -- it is making buildContext() and GitHubRepoViewer.init() into an explicit, layered composition root"). I reaffirm this as the central architectural change.

### Retract: CustomEvent as the canonical inter-service event pattern

My Phase 0 proposed `CustomEvent` on `canvas`/`window` for all inter-service communication. Both reviewers correctly challenged this:

- Extraction-plan (Round 1): "services use internal callbacks (`on()`/`off()`); composition roots wire callbacks to DOM events as needed"
- Service-boundaries (Round 1): "the current events route through GitHubRepoViewer as the mediator, not directly between services"

The evidence is decisive. `SelectionManager` already has the right pattern: internal `_listeners` Set with `on()`/`off()` methods (`SelectionManager.js:205-213`) plus a separate `_dispatchEvent()` for window-level DOM sync (`SelectionManager.js:308-316`). The internal callback system is DOM-agnostic and testable. The `window.dispatchEvent()` is a composition-root concern, not a service concern.

**New position:** Services use callback registration (`on`/`off` or constructor-injected callbacks). The composition root wires DOM events externally. `CustomEvent` is a composition-root tool, not a service-level tool. `CameraController`'s `window.dispatchEvent(new CustomEvent('camera-focus-changed', ...))` at line 435 should become a callback the composition root subscribes to.

### Retract: Eliminate SceneContext

My Phase 0 said services should take destructured deps like `{ camera, canvas, THREE }` instead of a context bag. Service-boundaries argued SceneContext is fine as a thin 41-line bag. Extraction-plan argued "SceneContext can survive as infrastructure-layer glue, but services should declare their actual deps."

After reading `SceneContext.js` again: it is 43 lines, has zero behavior, and is essentially a typed struct. The issue is not SceneContext itself but services that reach through it to grab things they do not declare. The pragmatic resolution is:

**New position:** Keep SceneContext as the infrastructure-layer container. But each service's JSDoc `@param` must enumerate which fields it actually uses from SceneContext, making the dependency auditable without reading implementation. SceneContext stays; undeclared-dependency opacity is what we fix.

---

## Evolved Understanding

### 1. The callback-vs-event tension has a clean resolution

Three communication channels exist in the codebase today:
- `canvas-click`: CameraController line 118 + HandGestureAdapter line 358 -> GitHubRepoViewer -> SelectionManager
- `camera-focus-changed`: CameraController line 435 -> GitHubRepoViewer
- `file-selected`: SelectionManager line 309 -> tree panel DOM

The pattern that emerges: **services own callback registries; the composition root bridges them to DOM.** SelectionManager already does this with `on()`/`off()` + `_dispatchEvent()`. CameraController should do the same: add an `onFocusChanged(cb)` method, remove the `window.dispatchEvent` call, and let the composition root wire `onFocusChanged` to `window.dispatchEvent` if needed. This keeps services DOM-free, testable, and the composition root is the only place that touches `window`/`canvas` events.

### 2. THREE.js injection: bare import wins for services, DI for the composition root

Extraction-plan proposed all services receive THREE via constructor DI. Service-boundaries noted BackdropManager and NameplateManager use `import * as THREE from 'three'`. After reflection: Three.js is a peer dependency declared in `package.json`. Any consumer of `glyph3d-js` already has Three.js available via their bundler or importmap.

**Resolution:** Services in `src/` use `import * as THREE from 'three'` (the bare specifier that any bundler resolves). Services that are *also* consumed by the composition root can optionally accept a THREE override via constructor for testing, but the default is the bare import. This avoids the ceremony of threading THREE through every constructor while remaining testable (mock the import in test environments).

### 3. CameraController name collision: rename the viewer's

`src/camera/CameraController.js` is the library's original physics-based controller (rotation-first, takes `(camera, inputManager, config)`). `examples/github-viewer/CameraController.js` is the viewer-specific translation-first controller (takes `SceneContext`, has localStorage, DOM bindings). These are fundamentally different classes.

**Resolution:** When the viewer's CameraController moves to `src/services/`, rename it to `ViewerCameraController` or `PanCameraController`. The existing `src/camera/CameraController.js` keeps its name. No ambiguity, no collision, no breaking change to the library's existing API.

---

## Convergence

All three agents now agree on:

1. **Extraction order:** Zero-dep services first (FileStateManager, DiffParser, SceneRegistry, platform.js), then single-dep services (CodeColorManager, SelectionManager, BackdropManager, NameplateManager), then orchestration (CommandRouter, ViewerAPI) last. Service-boundaries and extraction-plan both arrived at this independently.

2. **SceneRegistry must extract.** It has zero DOM coupling, zero WebSocket coupling, and is the central scene-object truth store. All three agents flagged it.

3. **CameraController's DOM bindings need a `bindUI()` split.** The 6+ `document.getElementById()` calls are app-specific wiring. The core camera logic (WASD, drag, scroll, focus) is reusable. Extraction-plan's recommendation #2 and my Round 1 recommendation #2 converge here.

4. **Missing services.** All three agents agree CameraController, ShortcutManager, platform.js, and HeatmapProvider were gaps in the original analyses. The full service count is ~45 files, not ~25.

5. **`window.viewer` assignment belongs in examples, not library code.** Extraction-plan flagged this; I concur. `initCommandCenter` should return the API; the caller assigns it globally if desired.

6. **Disposal order must be specified.** Reverse construction order in the composition root. Extraction-plan raised this; it is a real requirement for services with cross-subscriptions (CodeColorManager subscribes to FileStateManager).

---

## Remaining Tensions

### 1. SceneContext scope: infrastructure-only or mutable?

SceneContext has two mutable fields set after construction: `this.hierarchicalManager` and `this.layoutManager` (lines 33-34). These are set during `loadRepository()`, not at construction time. If SceneContext is "infrastructure-layer glue," it should be immutable after construction. The mutable fields violate that contract.

**My position:** Split these out. SceneContext holds immutable infrastructure refs (scene, camera, renderer, canvas, atlas, THREE, getGrids). Layout managers are a separate concern passed to services that need them, or held by a `LayoutContext` that is constructed later. This keeps SceneContext honest.

### 2. Where does `buildContext()` go?

`websocket/index.js:buildContext()` is currently the implicit composition root for the command system. Extraction-plan wants to move it to `src/services/websocket/`. I argue it should not exist in `src/` at all -- it is a composition function, and composition functions belong in the example/application layer, not the library. The library provides services; the application composes them.

### 3. WebSocketBridge: extract or leave?

WebSocketBridge creates DOM elements (`_createStatusBar()`). Service-boundaries says leave it in examples. Extraction-plan says extract it with an opt-in UI callback. I lean toward extraction-plan's approach: `_createStatusBar` becomes an optional `onStatusChange` callback, and the DOM creation moves to the example layer. But this is a real refactor, not a file move.

---

## Synthesis

The three Phase 0 documents and two rounds of review converge on this plan:

**Architecture:** Layered composition root pattern. Services declare deps via constructor (SceneContext for infrastructure bundle, explicit params for everything else). Services communicate via callback registries (`on`/`off`). Composition root wires callbacks to DOM events and manages lifecycle (construct in order, dispose in reverse).

**Event pattern:** Services own `on(callback)`/`off(callback)`. No `CustomEvent` inside services. The composition root bridges to `window.dispatchEvent(new CustomEvent(...))` when DOM integration is needed. SelectionManager is already the reference implementation of this pattern.

**THREE.js:** Bare `import * as THREE from 'three'` for services in `src/`. Three.js is a peer dependency. No constructor-DI threading of THREE unless a service needs to work without the bare specifier (none currently do).

**Naming:** Viewer's CameraController becomes `ViewerCameraController` (or similar) when extracted to `src/services/`. Existing `src/camera/CameraController.js` is untouched.

**SceneContext:** Kept, but immutable after construction. Mutable layout manager refs move out. Each consuming service's JSDoc documents which SceneContext fields it reads.

**Extraction order:**
1. Zero-dep: FileStateManager, DiffParser, platform.js, SceneRegistry, ShortcutManager
2. Infrastructure: SceneContext (immutable refactor), GlyphAtlas (already in src/)
3. Visual services: BackdropManager, NameplateManager, TreemapLabelManager (bare THREE import, clean dispose)
4. Core services: SelectionManager, ViewerCameraController (DOM bindUI split), CodeColorManager, HeatmapProvider
5. Orchestration: CommandRouter, ViewerAPI (context interface must be stable first)
6. Optional: WebSocketBridge (DOM extraction), StatePersistence (deep DOM coupling), command modules (16 files, implicit context contract)

---

## Dissent

### Against extracting command modules to `src/services/`

Service-boundaries classified `websocket/commands/` (16 files) as EXAMPLE. Extraction-plan wants them in `src/services/`. I side with service-boundaries. Each command handler calls `context.registry`, `context.cameraController`, `context.getGrids()`, etc. -- they depend on the specific shape of the viewer's context bag. Extracting them to `src/` means that context shape becomes a public API contract of the library. This is premature. The command modules are application-specific orchestration code. They should stay in `examples/` (or a future `apps/` directory) until the context interface is deliberately designed and stabilized.

### Against constructor-DI for THREE.js

Extraction-plan recommends all extracted services receive THREE via constructor DI. I disagree. Three.js is declared as a peer dependency in `package.json`. Every consumer already has it. Adding a `THREE` constructor parameter to BackdropManager, NameplateManager, TreemapLabelManager, CodeColorManager, SelectionManager, and HeatmapProvider is pure ceremony -- 6+ constructor signatures change, 6+ composition root lines change, all for a dependency that is guaranteed to exist. The bare import is simpler, standard, and every Three.js library in the ecosystem uses it. Reserve constructor DI for dependencies that actually vary (FileStateManager, SceneContext, callbacks).

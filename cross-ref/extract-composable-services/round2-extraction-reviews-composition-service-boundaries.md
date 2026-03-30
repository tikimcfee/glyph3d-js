# Round 2 Review: extraction-plan reviews composition-pattern + service-boundaries

**Reviewer:** extraction-plan agent (inverse order: composition first, then service-boundaries)
**Round:** 2 (cross-reference)

---

## Reaffirm or Retract

### Reaffirmed: Commands-first extraction order -- RETRACTED

My Phase 0 proposed commands first (CommandRouter, ViewerAPI, command modules), then camera, then visual services. Both reviewers independently identified this as backwards. Composition-pattern (Round 1) showed that `buildContext()` in `websocket/index.js` reaches into `viewer.cameraController`, `viewer.selectionManager`, `viewer.fileStateManager` (lines 90-93). You cannot extract the command system without first extracting the services it depends on. Service-boundaries identified that the 7 visual services (BackdropManager, NameplateManager, etc.) have zero cross-deps and are the easiest targets.

**Retracted.** The correct order is: zero-dep services first, then single-dep services, then orchestration (commands/websocket) last. Service-boundaries and composition-pattern are both right.

### Reaffirmed: SceneContext placement under camera/ -- RETRACTED

My Phase 0 placed SceneContext under `src/services/camera/`. Service-boundaries correctly flagged this: SceneContext is consumed by CameraController, CodeColorManager, HeatmapProvider, and others. It is a general-purpose reference bag, not camera-specific.

**Retracted.** SceneContext belongs in `src/services/context/SceneContext.js` or `src/services/SceneContext.js`.

### Reaffirmed: ~25 file count -- RETRACTED

I counted ~25 files. The actual count: 21 command modules + 5 websocket top-level + 17 top-level services + 1 provider = **44 files**. I missed the visual services cluster (BackdropManager, NameplateManager, TreemapLabelManager, DiffController, DiffParser, HandGestureAdapter, ShortcutManager) entirely. Service-boundaries was right at ~45.

### Reaffirmed: WebSocketBridge in src/services/ -- PARTIALLY RETRACTED

My Phase 0 moved WebSocketBridge to `src/services/websocket/`. Service-boundaries classified all of websocket/ as EXAMPLE. Composition-pattern flagged that WebSocketBridge creates DOM elements (`_createStatusBar`). After reading the code, WebSocketBridge is extractable IF `showStatus` defaults to false and the status bar creation becomes a caller-provided callback. The bridge's core WS logic is transport-agnostic. But it should not create DOM by default in a library service.

**Partially retracted.** Extract WebSocketBridge, but with `showStatus: false` as default and an optional `createUI` callback.

### Reaffirmed: TUI deferral -- STANDS

All three agents agree. TUI (TUIWindow, TUIWindowManager, TUIFocusManager, TUIFormatter) stays in examples. No dissent.

### Reaffirmed: CameraController DOM coupling is "light" -- RETRACTED

My Phase 0 said "DOM Coupling: Listens to window events... Decoupling: None needed." Composition-pattern enumerated the real coupling: `document.getElementById('reset-camera')` (line 198), `document.getElementById('fit-all')` (line 206), `_bindSlider()` calling `document.getElementById(sliderId)` 3 times (line 259). This is heavy DOM coupling. The camera math is clean; the UI binding is not.

**Retracted.** CameraController needs a `bindUI(elements)` split as composition-pattern recommended.

---

## Evolved Understanding

### 1. The real extraction unit is not files -- it is the composition root

Composition-pattern's key insight landed: `buildContext()` in `websocket/index.js` (lines 26-119) is the current implicit composition root. It reaches into `viewer` 20+ times to extract references. Moving files without refactoring this function just relocates the coupling. The extraction must produce an explicit `createViewerServices(deps)` that constructs services in dependency order and returns a typed bag.

### 2. THREE.js injection is a blocking decision

BackdropManager line 9: `import * as THREE from 'three'`. NameplateManager line 11: same. CameraController takes THREE via `ctx.THREE`. These are two incompatible patterns coexisting in the codebase. For `src/services/` to work without importmap configuration by every consumer, all extracted services must receive THREE via constructor DI. This is real refactoring work: BackdropManager uses module-scope `new THREE.Color()` in `DEPTH_COLORS` (line 23-29), which executes at import time before any constructor runs. That array must move inside the constructor or become a lazy initializer.

### 3. Event topology is the hidden wiring diagram

Three CustomEvent channels exist: `canvas-click` (CameraController line 118 + HandGestureAdapter line 358), `camera-focus-changed` (CameraController line 435), `file-selected` (SelectionManager line 309). GitHubRepoViewer mediates all three. Extracting services without documenting this topology will produce services that silently stop communicating. The composition root must explicitly wire these.

### 4. CameraController name collision is real and unresolved

`src/camera/CameraController.js` exists (physics-based, `import * as THREE from 'three'`, takes `(camera, inputManager, config)`). The github-viewer's CameraController is a completely different class (translation-first, SceneContext-based, 600+ lines). Creating `src/services/camera/CameraController.js` produces two classes with the same name in the same package. This needs resolution before extraction.

---

## Convergence

All three agents now agree on:

1. **Extraction order:** Zero-dep services (DiffParser, platform.js, RepositoryContentCache, SceneRegistry, FileStateManager) -> single-dep visual services (BackdropManager, NameplateManager, CodeColorManager, etc.) -> orchestration (CommandRouter, ViewerAPI, command modules, WebSocketBridge).

2. **TUI deferred.** No agent disputes this.

3. **SceneRegistry extracts.** Despite being in `websocket/`, it has zero WebSocket coupling. All three agents agree it belongs in `src/services/`.

4. **ShortcutManager is missing from all Phase 0 docs** and must be added to scope. Clean DI, `attach()`/`detach()` lifecycle, single import (platform.js).

5. **`window.viewer = api` must not be in library code.** The `initCommandCenter()` function sets this global (line 156). All agents agree: move the assignment to the example layer.

6. **dispose() convention needed.** BackdropManager has both `dispose()` and `destroy()`. Pick one, apply consistently.

---

## Remaining Tensions

### 1. SceneContext: keep vs. decompose

Service-boundaries says keep SceneContext as a thin bag (41 lines, zero behavior). Composition-pattern says decompose into explicit constructor params (`{ camera, canvas, THREE }`). My evolved position: **keep SceneContext** but document which fields each service actually reads. CameraController reads `ctx.camera`, `ctx.canvas`, `ctx.THREE`, `ctx.renderer` -- 4 fields. Destructuring 4 params is fine; destructuring 8+ (for services that need more) gets noisy. Compromise: keep the bag for construction, but each service's JSDoc must enumerate which SceneContext fields it actually uses.

### 2. GitHub-specific code in the core package

GitHubRepositorySource and RepositoryAdapter are GitHub API clients. My Phase 0 puts them in `src/services/data/`. But these are GitHub-specific -- a GitLab or local-filesystem consumer would not use them. Counter-argument: the package is called glyph3d-js, not github-glyph3d-js. They are data adapters that one specific example needs. Should they live in `src/services/data/` (reusable by anyone building a GitHub viewer) or stay in `examples/` (GitHub-specific)? I lean toward extraction: they have zero DOM coupling, clean constructors, and represent a real reusable adapter pattern. The namespace `src/services/data/github/` would clarify scope.

### 3. HeatmapProvider classification

My Phase 0 put it in "Data Loading." Service-boundaries says it is missing. Composition-pattern says it belongs in "Visual Composition" because it depends on SceneContext and FileStateManager and writes visual properties. The code confirms: it computes visual state (colors, intensity) and writes to FileStateManager. **Reclassify as Visual Composition**, not Data Access.

### 4. Command modules and the context contract

The 21 command module files all receive `context` via the router. That context bag has ~20 properties (lines 29-118 of websocket/index.js). Extracting command modules to `src/services/` means the context bag shape becomes a public API. Service-boundaries raised this; composition-pattern raised this. No agent has proposed a solution. The context bag is currently ad-hoc. It needs a documented interface or TypeScript-style JSDoc typedef before extraction, or consumers will break on every change.

---

## Synthesis

The three Phase 0 analyses cover complementary blind spots:
- **Service-boundaries** gave accurate API inventories and identified the 7 visual services I missed.
- **Composition-pattern** identified the architectural core problem: implicit composition via `buildContext()` and `GitHubRepoViewer.init()`.
- **Extraction-plan** (mine) provided the file-move mechanics and package.json export structure.

The merged plan:

1. **Phase 0:** Decide THREE.js injection standard. Decide CameraController rename. Document event topology. Define context bag interface.
2. **Phase 1:** Extract zero-dep services: DiffParser, platform.js, RepositoryContentCache, SceneRegistry, FileStateManager.
3. **Phase 2:** Extract single-dep services with THREE DI refactor: BackdropManager, NameplateManager, TreemapLabelManager, CodeColorManager, SelectionManager, ShortcutManager.
4. **Phase 3:** Extract CameraController with `bindUI()` split. Extract HeatmapProvider. Extract SceneContext.
5. **Phase 4:** Extract data adapters: GitHubRepositorySource, RepositoryAdapter (under `data/github/`).
6. **Phase 5:** Extract DiffController, HandGestureAdapter.
7. **Phase 6:** Extract CommandRouter, ViewerAPI, command modules (21 files). Stabilize context interface.
8. **Phase 7:** Extract WebSocketBridge with opt-in DOM. Create explicit `createViewerServices()` composition root.
9. **Phase 8:** Update package.json exports. Rewrite example imports. Verify examples run.

File count: ~44 files across 8 phases. TUI (4 files) and app shells deferred.

---

## Dissent

### Against composition-pattern's aspirational constructor signatures

Composition-pattern showed CameraController with `{ camera, canvas, gridProvider, THREE }` as if it were a planned refactor. The actual class has 600+ lines referencing `this.ctx` throughout. Rewriting every `this.ctx.camera` to `this.camera` is mechanical but touches ~40 call sites. This is real work that should be scoped and estimated, not presented as a Before/After slide. I dissent from treating constructor DI migration as a zero-cost formatting change.

### Against extracting StatePersistence now

StatePersistence has `document.getElementById('layout-mode')` and `window.location.reload()`. The refactoring cost exceeds the reuse value. Defer it alongside TUI. Neither service-boundaries nor composition-pattern provided a viable extraction path for it. I maintain my original deferral recommendation.

### For keeping SceneContext as infrastructure

Both composition-pattern and service-boundaries lean toward decomposing SceneContext. I dissent. SceneContext is 41 lines, zero behavior, used by 4+ services. Decomposing it into per-service explicit params creates duplication without improving testability (you mock the bag just as easily). Keep it; document its fields; move on.

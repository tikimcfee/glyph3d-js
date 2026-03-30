# Round 1 Review: Service Boundaries + Composition Pattern

Reviewer: extraction-plan agent
Reviewed: phase0-service-boundaries.md (service-boundaries), phase0-composition-pattern.md (composition-pattern)

---

## Errors Found

### 1. BackdropManager and NameplateManager are NOT DOM-free as claimed

Service-boundaries states "no DOM changes needed" for both. False. Both files have `import * as THREE from 'three'` at module scope (BackdropManager.js line 9, NameplateManager.js line 11). This is a hard dependency on a bare specifier resolved by the importmap in `index.html`. Moving these to `src/services/` means either:
- Every consumer must provide the same importmap, or
- These classes must accept THREE via constructor DI (like SelectionManager and CameraController already do)

The constructor signature for BackdropManager uses `new THREE.Group()`, `new THREE.Color()`, etc. via the module-level import. The composition pattern's "Before/After" examples show DI-injected THREE, but service-boundaries never flags these two files as needing that refactor.

### 2. Service-boundaries constructor deps for DiffController are wrong

Service-boundaries lists: `{ scene, atlas, githubSource, repoAdapter }`. The actual constructor (DiffController.js line 35) is `{ scene, atlas, githubSource, repoAdapter }` -- this matches. However, composition-pattern's example on line 127-130 shows `{ scene, atlas, registry }` with no githubSource or repoAdapter. These two documents disagree on the constructor signature. The actual code is the authoritative source: service-boundaries is correct here; composition-pattern is wrong.

### 3. Composition pattern's CameraController example is fictional

The "After (pure DI)" CameraController example (composition-pattern lines 47-82) shows a destructured `{ camera, canvas, gridProvider, THREE }` constructor. The actual CameraController (CameraController.js line 46) takes `ctx` (a SceneContext). The composition-pattern doc presents this as a real migration when it is aspirational pseudocode. This is misleading -- it implies CameraController has already been refactored or should be in phase 0, but the extraction plan defers CameraController refactoring.

### 4. Service-boundaries omits 4 extractable files

The classification table has 14 entries but misses:
- **CameraController.js** -- a 400+ line service with physics-based camera, localStorage persistence, keyboard/mouse input. It takes SceneContext and has `import { primaryMod, secondaryMod } from './platform.js'`. Clearly a service candidate.
- **ShortcutManager.js** -- keyboard shortcut registry with `document.addEventListener` capture phase. DOM-coupled but potentially extractable with a listener injection pattern.
- **platform.js** -- utility module (isMac, isLinux, primaryMod, secondaryMod). Pure functions, zero DOM mutation. Trivial to extract.
- **HeatmapProvider.js** (in `providers/`) -- writes per-file heat metrics to FileStateManager. No DOM, no Three.js imports. Clean service.

### 5. SelectionManager DOM coupling claim is partially incorrect

Service-boundaries says to "REMOVE: `window.dispatchEvent()` -> inject event emitter as dependency." But the actual SelectionManager (line 309) already has an internal callback system (`_listeners` Set, `on()`/`off()` methods, `_notify()`). The `_dispatchEvent()` method on line 308-316 is a secondary channel for tree panel sync. The fix is simpler than implied: just delete `_dispatchEvent()` and let the composition root subscribe via `on()` to dispatch window events externally. No "event emitter injection" needed.

---

## Gaps

### 1. No mention of SceneRegistry in service-boundaries

SceneRegistry (websocket/SceneRegistry.js) is a DOM-free, stateful, self-contained class that tracks all scene objects with type-tagged registration. Service-boundaries classifies the entire `websocket/` directory as "EXAMPLE" and skips it. But SceneRegistry has zero WebSocket coupling -- it is a pure in-memory registry. Composition-pattern uses it heavily in examples (lines 111, 119). This is a core service that should be extracted.

### 2. `import * as THREE` vs DI-injected THREE strategy is undefined

BackdropManager, NameplateManager, and spatialHelpers.js use `import * as THREE from 'three'`. CameraController, SelectionManager, and CodeColorManager receive THREE via constructor/context. Neither document establishes which pattern extracted services should use. This is a blocking architectural decision: bare `import * as THREE` requires importmap configuration in every consumer; DI allows the library to be importmap-agnostic.

### 3. No lifecycle ordering specification

Composition-pattern shows layered construction (Phase 1-5) but never specifies disposal order. If CameraController registers document-level keydown listeners and CodeColorManager subscribes to FileStateManager, disposing in wrong order can cause null-reference errors. The composition root needs explicit reverse-order teardown.

### 4. Missing analysis of CameraController's localStorage coupling

CameraController.js lines 28-38 define `loadSettings()` and `saveSettings()` that hit localStorage directly at module scope (called in the constructor). This is the same problem as StatePersistence but service-boundaries only flags StatePersistence. If CameraController moves to `src/services/`, it carries undeclared browser-storage coupling.

---

## Tensions

### 1. "No global lookups" vs `window.viewer` in composition-pattern

Composition-pattern's core principle (line 9) is "No global lookups." But `initCommandCenter()` (websocket/index.js line 156) sets `window.viewer = api`. The composition-pattern doc even shows this in the example. This is a global side effect from the composition root. The tension is real: the ViewerAPI must be globally accessible for devtools/agent usage. Resolution: make `window.viewer` assignment the caller's choice, not the composition root's responsibility.

### 2. CustomEvent on window/canvas vs callback DI

Composition-pattern advocates CustomEvent dispatch (lines 286-305) as the event pattern. Service-boundaries advocates removing `window.dispatchEvent()` and injecting event emitters. These two documents disagree. The actual codebase uses both: CameraController dispatches on window (line 435), HandGestureAdapter dispatches on canvas (line 358), and SelectionManager has both internal callbacks AND window dispatch. The extraction needs one canonical pattern.

### 3. WebSocketBridge DOM coupling vs "stays in example"

Service-boundaries classifies websocket/* as EXAMPLE. But WebSocketBridge.js (lines 189-214) creates DOM elements (`document.createElement('div')`, `document.body.appendChild()`). If the bridge stays in examples, this is fine. But my phase 0 plan says CommandRouter, ViewerAPI, and WebSocketBridge MOVE to `src/services/`. WebSocketBridge's `_createStatusBar()` method must be extracted or made opt-in before it can move to `src/services/`.

---

## Recommendations (max 10)

1. **Add CameraController, ShortcutManager, platform.js, HeatmapProvider to the service inventory.** CameraController is arguably the most complex service in the codebase. Omitting it from the boundary analysis leaves a major gap.

2. **Establish a THREE.js injection standard.** All extracted services should receive THREE via constructor DI, not `import * as THREE`. This makes the library consumable without importmap configuration. BackdropManager and NameplateManager need constructor changes.

3. **Extract SceneRegistry to `src/services/SceneRegistry.js`.** It has zero DOM coupling, zero WebSocket coupling, and is the central scene-object truth store. Both composition-pattern and the actual websocket/index.js depend on it heavily.

4. **Resolve the event pattern tension.** Adopt: services use internal callbacks (`on()`/`off()`); composition roots wire callbacks to DOM events (CustomEvent, window.dispatchEvent) as needed. This keeps services DOM-free while preserving the existing browser integration.

5. **Add a storage adapter interface for CameraController and StatePersistence.** Both use localStorage directly. Define a simple `{ get(key), set(key, value) }` interface, default to localStorage, allow injection of in-memory stores for testing and SSR.

6. **Fix composition-pattern's DiffController constructor to match reality.** Change `{ scene, atlas, registry }` to `{ scene, atlas, githubSource, repoAdapter }` to match DiffController.js line 35.

7. **Make WebSocketBridge's status bar opt-in via a `createUI` callback.** Currently it always creates DOM. For `src/services/` extraction, the DOM creation (`_createStatusBar`) should be a callback or disabled by default, letting the example layer provide the UI.

8. **Specify disposal order in the composition root.** Reverse construction order: optional subsystems first, then core services, then infrastructure. Document this in the composition-pattern spec.

9. **Acknowledge CameraController's existing SceneContext coupling.** The composition-pattern's aspirational "pure DI" CameraController is a large refactor (the class has 400+ lines touching `this.ctx` everywhere). Plan this as a separate phase, not a prerequisite.

10. **Add platform.js to `src/services/utils/` or `src/utils/`.** It is 35 lines of pure functions with no dependencies. Both CameraController and ShortcutManager import it. Moving it first unblocks both.

---

## Key Insight

The service-boundaries analysis focused on the 14 "obvious" service files and correctly identified their public APIs, but missed the dependency graph edges that determine extraction order. BackdropManager and NameplateManager cannot move without solving the THREE.js injection question. CameraController cannot move without solving both THREE injection and localStorage abstraction. SceneRegistry must move because the composition root depends on it. **The extraction order is constrained by these hidden dependencies, not by the service classification table.** The composition-pattern document provides the right architectural vision but uses fictional constructor signatures that mask the real refactoring cost. Merging the accurate API inventory from service-boundaries with the DI pattern from composition-pattern -- while respecting actual import graphs -- yields the actionable plan.

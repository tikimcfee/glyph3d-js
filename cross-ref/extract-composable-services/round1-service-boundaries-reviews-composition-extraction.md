# Round 1 Review: service-boundaries reviews composition-pattern & extraction-plan

---

## Errors Found

### 1. composition-pattern: DiffController constructor signature is wrong

The composition root example (lines 127-131) wires DiffController as:
```js
const diffController = new DiffController({ scene, atlas, registry });
```
The actual constructor at `examples/github-viewer/DiffController.js:35` is:
```js
constructor({ scene, atlas, githubSource, repoAdapter })
```
DiffController has no `registry` dependency. It needs `githubSource` (GitHubRepositorySource) and `repoAdapter` (RepositoryAdapter) to fetch PR data. This mock-up would produce a broken service with `undefined` data access.

### 2. composition-pattern: CameraController "Before" example doesn't match code

The "Before" example (lines 26-41) shows `CameraController` reaching into `ctx.getGrids` and calling `this.ctx.getGrids()[index]` in `focusOnGrid`. The actual constructor at `CameraController.js:46-83` stores `this.ctx = ctx` and `this.THREE = ctx.THREE`. It does NOT read grids from ctx in the constructor. The `focusOnGrid`/`focusOnGrids` methods receive grids as parameters. The "Before" code dramatizes coupling that does not exist as shown.

### 3. extraction-plan: Claims SceneContext goes into `src/services/camera/`

Phase 2 places SceneContext under `src/services/camera/SceneContext.js`. SceneContext (at `examples/github-viewer/SceneContext.js:12-43`) is consumed by CameraController, CodeColorManager, HeatmapProvider, and others. It is a general-purpose reference bag, not a camera-specific service. Placing it under `camera/` creates a false namespace boundary and forces unrelated services to import from the camera package.

### 4. extraction-plan: Counts "~25 files" but actual count is higher

The summary says "~25 files". The websocket/commands/ directory alone has 21 files. Add CommandRouter, WebSocketBridge, ViewerAPI, SceneRegistry, websocket/index.js, the 14 services I identified, platform.js, and HeatmapProvider — the real count is closer to 45 files.

---

## Gaps

### 5. extraction-plan: Missing 7 services from my Phase 0 list

The extraction plan does not mention:
- **BackdropManager** — 3D directory backdrop planes (Three.js only, zero DOM)
- **NameplateManager** — 3D directory labels with billboard rotation (Three.js only)
- **TreemapLabelManager** — LOD-aware treemap labels (Three.js only)
- **DiffController** — PR diff orchestration (pure service, clean constructor DI)
- **DiffParser** — Pure diff parsing functions (zero deps, zero DOM)
- **HandGestureAdapter** — Hand tracking bridge (light DOM: canvas events)
- **StatePersistence** — localStorage persistence (needs decoupling, but extractable)

These are all in `examples/github-viewer/` at the top level. The extraction plan appears to have focused on the `websocket/` subtree and a handful of top-level files, missing the visual and diff services entirely.

### 6. Both agents miss ShortcutManager

`examples/github-viewer/ShortcutManager.js` is a keyboard shortcut registry with only one import (`platform.js`). It has clean constructor DI, a `register()`/`attach()`/`detach()` lifecycle, and no hard coupling. Neither the composition pattern nor the extraction plan mention it. It should be in the extraction scope.

### 7. extraction-plan: No mention of `import * as THREE from 'three'` problem

BackdropManager (line 9) and NameplateManager (line 11) both use `import * as THREE from 'three'` — a hard module-level import. The composition pattern proposes passing THREE via constructor DI. The extraction plan never addresses how to reconcile these two patterns for the visual managers. This is a real decision point: do we keep the bare import (simpler, Three.js is a peer dep) or convert to DI (more testable, matches the composition pattern)?

### 8. composition-pattern: No guidance on services that create Three.js objects

BackdropManager, NameplateManager, TreemapLabelManager, and DiffController all create `THREE.Mesh`, `THREE.Group`, or `CodeGrid` instances internally. The composition pattern shows services receiving Three.js objects but never addresses services that *create* them. This is the most common pattern in the visual services cluster and needs explicit guidance.

---

## Tensions

### 9. SceneContext vs. Destructured DI

The composition pattern advocates destructured constructor DI (`{ camera, canvas, gridProvider, THREE }`). The actual codebase uses SceneContext as a reference bag passed to CameraController, CodeColorManager, and HeatmapProvider. The extraction plan keeps SceneContext. The composition pattern's "After" examples eliminate it. These two documents prescribe opposite approaches for the same services.

**My position:** SceneContext is fine. It is a thin, typed bag with zero behavior (41 lines). Destructuring 6+ parameters into every constructor is more verbose without being more testable — you can mock SceneContext just as easily.

### 10. websocket/ as "example" vs. "service"

My Phase 0 classified websocket/ as EXAMPLE (should stay). The extraction plan moves CommandRouter, ViewerAPI, WebSocketBridge, SceneRegistry, and all 16 command modules into `src/services/`. This is the largest tension between our analyses.

**My position after review:** The extraction plan is correct to extract CommandRouter, ViewerAPI, and SceneRegistry — they are infrastructure, not app-specific. WebSocketBridge is borderline (creates DOM status bar). The 16 command modules are the most debatable: they reference `context.scene`, `context.cameraController`, etc. and are tightly coupled to the specific viewer context shape. Extracting them means committing to that context interface as a public API.

### 11. StatePersistence coupling depth

My Phase 0 flagged StatePersistence as needing DOM decoupling (document.getElementById on lines 102-127, window.location.reload on line 67). The extraction plan omits it entirely. The composition pattern omits it too. StatePersistence's `restoreUI()` method directly reads/writes DOM input fields by ID — this is the deepest DOM coupling of any service candidate. Extracting it requires a significant refactor: inject a state-restore callback instead of DOM queries.

---

## Recommendations (max 10)

1. **Fix DiffController in composition root example.** Replace `{ scene, atlas, registry }` with `{ scene, atlas, githubSource, repoAdapter }` to match the actual constructor.

2. **Move SceneContext to `src/services/context/SceneContext.js`**, not `camera/`. It serves 4+ consumers.

3. **Add the 7 missing services to the extraction plan.** BackdropManager, NameplateManager, TreemapLabelManager, DiffController, DiffParser, HandGestureAdapter, and StatePersistence are all extractable with varying effort.

4. **Add ShortcutManager to the extraction plan** under `src/services/input/ShortcutManager.js` alongside the platform.js utility.

5. **Decide on THREE import strategy once.** Either all services use `import * as THREE from 'three'` (peer dep, simple) or all receive THREE via DI (testable, consistent with composition pattern). Do not mix. I recommend keeping the bare import since Three.js is already a peer dependency.

6. **Add a "Scene Builder" subsection to the composition pattern** covering services that create Three.js objects (BackdropManager, NameplateManager, DiffController). These need scene injection + lifecycle (dispose cleans meshes from scene).

7. **Keep SceneContext as a pattern.** Do not destructure into 6+ params per constructor. Both documents should align on this.

8. **Extract command modules only if the context interface is stabilized.** Each of the 16 modules calls `context.registry`, `context.cameraController`, `context.getGrids()`, etc. Extracting them means the context bag shape becomes a public contract.

9. **Defer StatePersistence extraction.** Its `restoreUI()` method does `document.getElementById('layout-mode')` etc. Refactoring it for DI requires the viewer to expose typed state accessors. Extract it last, after the viewer's own refactor.

10. **Update the file count in the extraction plan summary.** "~25 files" should be "~45 files" to set correct expectations for the extraction scope.

---

## Key Insight

The extraction plan and composition pattern are complementary but have a blind spot: they focus on the **command/control layer** (CommandRouter, WebSocketBridge, ViewerAPI) and the **state layer** (FileStateManager, SelectionManager) while ignoring the **visual services** (BackdropManager, NameplateManager, TreemapLabelManager, DiffController). The visual services are actually the easiest to extract — they have clean constructor DI, no DOM coupling, and well-defined dispose() lifecycles. They should be Phase 1, not an afterthought. The command system, with its 16 modules and implicit context contract, is the hardest extraction and should come last.

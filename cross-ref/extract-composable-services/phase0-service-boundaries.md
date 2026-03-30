# Service Boundary Analysis: examples/github-viewer/

**Goal:** Extract DOM-agnostic, composable services from github-viewer into src/services/.
Each service is a simple class with constructor DI—no subclassing, no prototype chains, no global state.

---

## Classification Summary

| File | Type | Service Name | Responsibility |
|------|------|--------------|-----------------|
| RepositoryAdapter.js | SERVICE | RepositoryAdapter | Coordinate GitHub API access with caching |
| RepositoryContentCache.js | SERVICE | RepositoryContentCache | TTL-based in-memory cache for repo content |
| BackdropManager.js | SERVICE | BackdropManager | 3D backdrop planes for directory hierarchy |
| CodeColorManager.js | SERVICE | CodeColorManager | Layered color resolution for grids (heatmap, selection) |
| DiffController.js | SERVICE | DiffController | Fetch, parse, layout PR diffs as grid pairs |
| DiffParser.js | SERVICE | DiffParser | Unified diff → aligned side-by-side lines (pure functions) |
| FileStateManager.js | SERVICE | FileStateManager | Per-file metadata registry with change notifications |
| GitHubRepositorySource.js | SERVICE | GitHubRepositorySource | GitHub API client (rate limits, tree/file fetch) |
| HandGestureAdapter.js | SERVICE | HandGestureAdapter | Hand tracking → camera/canvas click events |
| NameplateManager.js | SERVICE | NameplateManager | 3D directory name labels with LOD billboard rotation |
| SceneContext.js | SERVICE | SceneContext | Shared reference bag for subsystems |
| SelectionManager.js | SERVICE | SelectionManager | Canvas-based file selection with raycasting & Z-pop |
| StatePersistence.js | SERVICE | StatePersistence | localStorage persistence (UI state, camera, settings) |
| TreemapLabelManager.js | SERVICE | TreemapLabelManager | LOD-aware labels for treemap layout |
| **components/** | EXAMPLE | — | UI helper functions (stay in example) |
| **websocket/** | EXAMPLE | — | Remote control API (stays in example) |

---

## Service Details

### 1. RepositoryAdapter
**Responsibility:** Coordinate GitHub API access + caching for convenient repo loading.
**Constructor Deps:** `{ token?, cacheTtl?, cacheMaxSize?, timeout?, useRawUrls? }`
**Public API:**
- `loadRepository(url)` → `{ tree, owner, repo, branch, defaultBranch }`
- `streamFiles(options)` → async iterator of `{ path, content, size, sha }`
- `getFile(path)` → content string
- `getRepositoryTree(owner, repo, branch)` → tree structure
- `getFileContent(owner, repo, path, branch)` → file object
- `getMultipleFiles(owner, repo, paths, branch)` → Map<path, content>
- `clearCache()`, `clearRepositoryCache(owner, repo)`
- `getStats()` → stats object
- `getRateLimitStatus()` → rate limit info

**Events:** None (internal callbacks)
**DOM Coupling:** None

---

### 2. RepositoryContentCache
**Responsibility:** TTL-based in-memory cache with LRU eviction.
**Constructor Deps:** `{ ttl?, maxSize? }`
**Public API:**
- `get(key)` → cached data or null
- `set(key, data)` → void
- `has(key)` → boolean
- `remove(key)` → boolean
- `clear()` → void
- `clearExpired()` → count removed
- `getStats()` → cache stats
- `invalidateRepository(owner, repo)` → count removed
- `export()` / `import(data)` → JSON serialization
- `static makeKey(type, owner, repo, path, branch)` → key string

**Events:** None
**DOM Coupling:** None

---

### 3. BackdropManager
**Responsibility:** Create depth-coded colored planes behind directory groups.
**Constructor Deps:** `scene: THREE.Scene, options: { baseOpacity?, opacityDecay?, minOpacity?, zOffset?, showEdges?, skipDepth? }`
**Public API:**
- `createBackdrops(root, collapsedPaths)` → void
- `updateBackdrops(root, collapsedPaths)` → void
- `setVisible(visible)` → void
- `dispose()` → void
- `destroy()` → void

**Events:** None
**DOM Coupling:** None (Three.js only)

---

### 4. CodeColorManager
**Responsibility:** Layered color resolution (heatmap, selection, search → per-grid color).
**Constructor Deps:** `ctx: SceneContext, fileStateManager: FileStateManager`
**Public API:**
- `registerLayer(name, { priority, colorFn, watchProperties })` → void
- `setLayerEnabled(name, enabled)` → void
- `isLayerEnabled(name)` → boolean
- `updateAllColors()` → void (recompute all grids)
- `resetAllColors()` → void (revert to white)
- `dispose()` → void

**Events:** Listens to `fileStateManager.onPropertyChanged()` for reactive color updates
**DOM Coupling:** None

---

### 5. DiffController
**Responsibility:** Orchestrate PR diff fetch → parse → grid pair creation → layout.
**Constructor Deps:** `{ scene: THREE.Scene, atlas: GlyphAtlas, githubSource, repoAdapter }`
**Public API:**
- `loadPR(owner, repo, prNumber, onProgress)` → `{ grids, prData, fileData }`
- `clearGrids()` → void
- `getTotalBounds()` → bounds object
- `static parsePRInput(input)` → parsed PR or null

**Events:** None (progress callback via onProgress)
**DOM Coupling:** None

---

### 6. DiffParser
**Responsibility:** Pure diff parsing functions (no state, no side effects).
**Constructor Deps:** None (module of functions)
**Public API:**
- `parsePatchAligned(patch)` → `{ left: DiffLine[], right: DiffLine[] }`
- `buildAlignedDiff(baseContent, headContent, patch)` → aligned lines
- `getDiffColor(type)` → `{ r, g, b }`
- `parseHunks(patch)` → internal helper

**Events:** None
**DOM Coupling:** None

---

### 7. FileStateManager
**Responsibility:** Per-file metadata registry; central source of truth for file properties.
**Constructor Deps:** None
**Public API:**
- `setProperty(sourcePath, propName, value)` → void
- `getProperty(sourcePath, propName)` → value
- `getProperties(sourcePath)` → Object or null
- `batchSetProperties(Map<sourcePath, props>)` → void
- `onPropertyChanged(callback)` → void (subscribe)
- `offPropertyChanged(callback)` → void (unsubscribe)
- `clear()` → void (wipe data, keep listeners)
- `dispose()` → void (wipe all)

**Events:** Fires `onPropertyChanged(sourcePath, propName, newValue, oldValue)` callbacks
**DOM Coupling:** None

---

### 8. GitHubRepositorySource
**Responsibility:** GitHub API client with rate limit tracking.
**Constructor Deps:** `{ token?, timeout?, branch? }`
**Public API:**
- `fetchTree(owner, repo, branch)` → tree structure
- `fetchFile(owner, repo, path, branch)` → file object
- `fetchRawFile(owner, repo, path, branch)` → raw file content
- `getRepositoryInfo(repoPath)` → repo metadata
- `fetchPullRequest(owner, repo, prNumber)` → PR data
- `fetchPullRequestFiles(owner, repo, prNumber)` → changed files array
- `getRateLimitStatus()` → `{ limit, remaining, reset, resetDate }`
- `getInfo()` → source info
- `isAvailable()` → boolean
- `static parseGitHubUrl(url)` → `{ owner, repo, branch }`

**Events:** None
**DOM Coupling:** None

---

### 9. HandGestureAdapter
**Responsibility:** Bridge hand tracking → camera pans & canvas clicks.
**Constructor Deps:** `{ camera: THREE.Camera, canvas: HTMLCanvasElement, cameraController, handRendererOptions? }`
**Public API:**
- `enable(sourceType, sourceOptions)` → void
- `disable()` → void
- `update(deltaTime)` → void (call each frame)
- `dispose()` → void
- `enabled` getter

**Events:** Emits `canvas-click` CustomEvent on canvas
**DOM Coupling:** 
- **REMOVE:** `canvas.dispatchEvent()` → inject canvas as dependency, emit on callback instead
- `canvas.getBoundingClientRect()` → requires canvas reference (keep as-is, compositor owns canvas)

---

### 10. NameplateManager
**Responsibility:** 3D directory labels with camera-facing billboard rotation.
**Constructor Deps:** `scene: THREE.Scene, atlas: GlyphAtlas, options: { color?, scale?, yOffset?, zOffset?, billboard?, skipDepth? }`
**Public API:**
- `createNameplates(root, collapsedPaths)` → void
- `updateNameplates(root, collapsedPaths)` → void
- `updateBillboards(camera)` → void (call each frame)
- `setVisible(visible)` → void
- `dispose()` → void
- `destroy()` → void

**Events:** None
**DOM Coupling:** None

---

### 11. SceneContext
**Responsibility:** Shared reference bag for subsystems (no ownership).
**Constructor Deps:** `{ THREE, scene, camera, renderer, canvas, atlas, getGrids: () => CodeGrid[] }`
**Public API:**
- `getGrids()` → current grids array
- Properties: `THREE`, `scene`, `camera`, `renderer`, `canvas`, `atlas`
- Properties: `hierarchicalManager`, `layoutManager` (set after init)

**Events:** None
**DOM Coupling:** None (canvas is a ref, not used directly)

---

### 12. SelectionManager
**Responsibility:** Canvas-based selection with raycasting, Z-pop, and state sync.
**Constructor Deps:** `THREE, fileStateManager: FileStateManager`
**Public API:**
- `select(sourcePath, { additive?, grids? })` → void
- `deselect(sourcePath, { grids? })` → void
- `clear(grids)` → void
- `handleClick(clientX, clientY, canvas, camera, grids, additive)` → void
- `primary` getter
- `getSelected()` → Set<sourcePath>
- `isSelected(sourcePath)` → boolean
- `on(callback)` / `off(callback)` → subscribe/unsubscribe
- `dispose()` → void

**Events:** 
- Fires `file-selected` CustomEvent on window (for tree panel sync)
- Internal listener callbacks: `(eventType, sourcePath, state) => void`

**DOM Coupling:**
- **KEEP:** `canvas.getBoundingClientRect()` (canvas passed as param)
- **REMOVE:** `window.dispatchEvent()` → inject event emitter as dependency

---

### 13. StatePersistence
**Responsibility:** localStorage persistence of app state (repo URL, camera, settings).
**Constructor Deps:** `viewer` (GitHubRepoViewer instance)
**Public API:**
- `restoreUI()` → boolean (should auto-load?)
- `restoreCamera()` → void
- `onRepoLoaded(repoUrl, branch)` → void
- `onLayoutChanged(layout)` → void
- `onGridsScaleChanged(scale)` → void
- `onLayoutSpacingChanged(spacing)` → void
- `markCameraDirty()` → void
- `startCameraSaving()` → void
- `stopCameraSaving()` → void

**Events:** None (calls methods on viewer)
**DOM Coupling:**
- **REMOVE:** `document.getElementById()` calls (rely on viewer refs instead)
- **REMOVE:** `localStorage.setItem/getItem` → inject storage adapter

---

### 14. TreemapLabelManager
**Responsibility:** LOD-aware labels for treemap mode (O(1) visibility via groups).
**Constructor Deps:** `scene: THREE.Scene, atlas: GlyphAtlas, treemapManager, camera: THREE.Camera`
**Public API:**
- `build()` → Promise (async label construction)
- `update()` → void (call each frame for LOD)
- `setVisible(visible)` → void
- `destroy()` → void

**Events:** None
**DOM Coupling:** None

---

## Service Clusters

### **Scene Management**
- BackdropManager
- NameplateManager
- TreemapLabelManager
- SceneContext

### **Data Access & Storage**
- RepositoryAdapter
- RepositoryContentCache
- GitHubRepositorySource

### **State & Persistence**
- FileStateManager
- StatePersistence
- SceneContext

### **Visual Composition & Color**
- CodeColorManager
- DiffController (creates grids)

### **Selection & Input**
- SelectionManager
- HandGestureAdapter

### **Pure Utilities**
- DiffParser

---

## DOM Decoupling Action Items

**Files to extract with minimal changes:**
1. RepositoryAdapter, RepositoryContentCache, GitHubRepositorySource → no DOM changes needed
2. BackdropManager, NameplateManager, TreemapLabelManager → no DOM changes needed
3. SceneContext → no DOM changes needed
4. FileStateManager, DiffParser → no DOM changes needed
5. CodeColorManager → no DOM changes needed
6. DiffController → no DOM changes needed

**Files requiring DOM abstraction layer:**
1. **SelectionManager**: Replace `window.dispatchEvent()` with injected event emitter callback
2. **HandGestureAdapter**: Replace `canvas.dispatchEvent()` with callback, keep canvas ref for getBoundingClientRect()
3. **StatePersistence**: Replace `document.getElementById()` with constructor deps (viewer refs), replace localStorage with storage adapter interface

**Files to keep as EXAMPLE (UI helpers):**
- components/* → Pure UI helper functions, not services
- websocket/* → Remote control API, not core to rendering pipeline


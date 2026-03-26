# IDE Features — State Tracking Document

Documents the complete state model for each subsystem, including initial values,
transitions, observers, persistence, and reset behavior.

---

## 1. SelectionManager

**File:** `/Users/lugo/localdev/viz-web/glyph3d-js/examples/github-viewer/SelectionManager.js`

### State Fields

| Field | Type | Initial Value | Description |
|-------|------|---------------|-------------|
| `_primary` | `string \| null` | `null` | sourcePath of the focused (most recently selected) file |
| `_selected` | `Set<string>` | empty Set | All selected sourcePaths |
| `_originalZ` | `Map<string, number>` | empty Map | Maps sourcePath to original `grid.position.z` before Z-pop |
| `_listeners` | `Set<Function>` | empty Set | Internal callback subscribers |
| `_raycaster` | `THREE.Raycaster` | new Raycaster | Reused for all click-to-select raycasts |

### State Transitions

| Trigger | From | To | Side Effects |
|---------|------|----|-------------|
| `select(path, {additive:false})` | any | `_primary = path`, `_selected = {path}` | Clears previous selections. Writes `selected: true` to FileStateManager. Applies Z-pop (+3). Dispatches `file-selected` CustomEvent. |
| `select(path, {additive:true})` | any | `_primary = path`, `_selected += path` | Does NOT clear previous. Adds to set. Same side effects per file. |
| `deselect(path)` | path in `_selected` | `_selected -= path`, `_primary` falls back to next in set or null | Writes `selected: false` to FileStateManager. Restores Z from `_originalZ`. |
| `clear(grids)` | any | `_primary = null`, `_selected = empty`, `_originalZ` entries removed | Writes `selected: false` for all. Restores all Z positions. |
| `handleClick(...)` (hit) | any | select or toggle depending on additive flag | Raycasts against `grid._background` meshes. |
| `handleClick(...)` (miss) | any | clear (if not additive) | Click on empty space. |
| `dispose()` | any | all cleared | Nuclear reset. Listeners removed. |

### Observers (What reads this state)

- **CodeColorManager** selection layer: reads `FileStateManager.getProperty(path, 'selected')` on property change callback. Watches `['selected']` property.
- **Tree panel sync**: listens to `file-selected` CustomEvent on `window` at line 286 of GitHubRepoViewer.js. Toggles `.selected` class on `.tree-item.tree-file` elements.
- **Any registered `on()` listeners**: receive `(eventType, sourcePath, state)`.

### Persistence

- **None.** Selection is ephemeral. Not saved to localStorage. Clears on page reload.
- FileStateManager `selected` properties are also ephemeral (in-memory Map, not persisted).

### Reset Behavior

- `clear(grids)`: clears selection state and restores Z positions. Preserves listeners.
- `dispose()`: clears everything including listeners. Called on repo change from `GitHubRepoViewer.dispose()` (line 705).
- `FileStateManager.clear()`: called on repo change. Wipes all properties but keeps listeners subscribed. Selection layer still registered but has nothing to resolve.

---

## 2. ShortcutManager (Planned)

**File:** To be created at `examples/github-viewer/ShortcutManager.js`

### State Fields (Planned)

| Field | Type | Initial Value | Description |
|-------|------|---------------|-------------|
| `_bindings` | `Map<string, Array<Binding>>` | empty Map | Maps key combo strings (e.g., "ctrl+f", "escape") to arrays of `{context, action, priority, description}` |
| `_activeContext` | `string` | `'default'` | Current keyboard context (e.g., `'default'`, `'search-active'`, `'command-palette'`) |
| `_paused` | `boolean` | `false` | When true, all shortcuts are suppressed (e.g., when a text input is focused) |
| `_contextStack` | `Array<string>` | `['default']` | Stack for nested contexts (push on overlay open, pop on close) |

### State Transitions (Planned)

| Trigger | From | To | Side Effects |
|---------|------|----|-------------|
| `register(combo, binding)` | any | binding added to `_bindings` map | No immediate effect |
| `setContext(ctx)` | `_activeContext = old` | `_activeContext = ctx` | Only bindings matching new context will fire |
| `pushContext(ctx)` | stack = [...old] | stack = [...old, ctx], `_activeContext = ctx` | Used when opening overlays |
| `popContext()` | stack = [...old, top] | stack = [...old], `_activeContext = old.last` | Used when closing overlays |
| `pause()` | `_paused = false` | `_paused = true` | Called on input focus |
| `resume()` | `_paused = true` | `_paused = false` | Called on input blur |
| Input element focus detected | `_paused = false` | `_paused = true` | Auto-pause when `activeElement.tagName` is INPUT/TEXTAREA/SELECT |

### Observers

- **CameraController keydown handler**: ShortcutManager registers on capture phase (`{capture: true}`). When a shortcut matches, it calls `e.stopPropagation()` and `e.preventDefault()`, preventing CameraController from seeing the event.
- **CommandRouter** (future): shortcuts invoke commands through the router.

### Persistence

- **None.** Shortcut bindings are registered at initialization. User customization of bindings would require localStorage persistence (future feature).

### Reset Behavior

- `dispose()`: removes document keydown listener, clears all bindings.

---

## 3. MinimapOverlay (Planned)

**File:** To be created at `examples/github-viewer/components/MinimapOverlay.js`

### State Fields (Planned)

| Field | Type | Initial Value | Description |
|-------|------|---------------|-------------|
| `_canvas` | `HTMLCanvasElement` | created in constructor | 2D canvas element, appended to DOM |
| `_ctx2d` | `CanvasRenderingContext2D` | from `_canvas.getContext('2d')` | Drawing context |
| `_layoutBounds` | `{minX, minY, maxX, maxY}` | null | World-space bounds of the full layout, from `getTotalBounds()` |
| `_fileRects` | `Array<{x, y, w, h, color, sourcePath}>` | empty array | Cached 2D rectangles for each file/directory block |
| `_viewportRect` | `{x, y, w, h}` | `{0, 0, 1, 1}` (normalized) | Camera frustum projected onto layout plane |
| `_visible` | `boolean` | `true` | Minimap visibility toggle |
| `_isDragging` | `boolean` | `false` | Whether user is dragging on the minimap |
| `_scale` | `number` | computed | World-to-minimap pixel scale factor |

### State Transitions (Planned)

| Trigger | From | To | Side Effects |
|---------|------|----|-------------|
| Layout change / `updateLayout(bounds, fileRects)` | old bounds | new bounds | Recomputes `_scale`, rebuilds `_fileRects`, redraws minimap |
| Camera move (per frame) | old viewport | new viewport | Recomputes `_viewportRect` from camera position/FOV, redraws viewport indicator |
| Click on minimap | n/a | n/a | Computes world coordinates from click position, sets camera.position.x/y |
| Drag on minimap | `_isDragging = false` | `_isDragging = true` | Continuously updates camera position |
| Toggle visibility (`M` key) | `_visible = X` | `_visible = !X` | Shows/hides canvas element. Skips per-frame updates when hidden. |

### Observers

- **Animation loop**: calls `minimap.updateViewport(camera)` each frame to sync the viewport indicator.
- **Layout manager**: on relayout, provides new bounds and file positions.

### Persistence

- **None.** Minimap state is fully ephemeral.

### Reset Behavior

- On repo clear: `_fileRects` clears, minimap shows empty or hides.
- On layout switch: `updateLayout()` called with new bounds.

---

## 4. TreemapLabelManager (Planned)

**File:** To be created at `examples/github-viewer/TreemapLabelManager.js`

### State Fields (Planned)

| Field | Type | Initial Value | Description |
|-------|------|---------------|-------------|
| `_directoryLabels` | `Map<string, LabelEntry>` | empty Map | Directory path to label Object3D/GlyphCollection entry |
| `_fileLabels` | `Map<string, LabelEntry>` | empty Map | File path to label Object3D/GlyphCollection entry |
| `_directoryGroup` | `THREE.Group` | new Group, added to scene | Container for all directory labels |
| `_fileGroup` | `THREE.Group` | new Group, added to scene | Container for all file labels |
| `_lodThresholds` | `{dirOnly: number, mixed: number, filesOnly: number}` | `{dirOnly: 800, mixed: 200, filesOnly: 200}` | Camera Z thresholds for LOD transitions |
| `_lastCameraZ` | `number` | `Infinity` | Cached camera Z to avoid redundant visibility updates |

Where `LabelEntry` is:

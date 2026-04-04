# Phase 0: Event Pipeline Analysis -- Spatial Window Manager

Agent: **Event Pipeline**

## 1. Current Event Flow

```
Browser mousedown (canvas)
  |
  +-> ViewerCameraController._onMouseDown  [canvas, bubbling]
  |     Sets isDragging=true, records _mouseDownX/Y, _dragPrevX/Y
  |     Sets cursor='grabbing'
  |
Browser mousemove (document)
  |
  +-> ViewerCameraController._onMouseMove  [document, bubbling]
  |     If isDragging: compute delta, _applyDragTranslation()
  |
  +-> GitHubRepoViewer (anonymous)          [document, bubbling]
  |     pickingSystem.setMousePosition(cssX, cssY) -- sets dirty flag
  |
Browser mouseup (document)
  |
  +-> ViewerCameraController._onMouseUp    [document, bubbling]
        Computes displacement from _mouseDownX/Y
        If < 5px: dispatches CustomEvent('canvas-click') on canvas
        If >= 5px: silent (was a drag)
        Sets isDragging=false, cursor='grab'

CustomEvent 'canvas-click' (canvas)
  |
  +-> GitHubRepoViewer (anonymous)          [canvas, bubbling]
        Forwards to selectionManager.handleClick()
        Raycasts against grid._background meshes
        Selects/deselects CodeGrids

Keyboard:
  ShortcutManager._handleKeyDown            [document, CAPTURE]
    Fires before CameraController's keydown [document, bubbling]
    stopPropagation() on match -- camera never sees shortcut keys

Per-frame (animate loop):
  pickingSystem.renderAndRead()  -- only when _needsPick is true
  Reads 1 pixel, resolves to glyph slot, applies hover highlight
```

### Key observations

- **No capture-phase mouse listeners.** All mouse handlers use default bubbling.
- **Click disambiguation is inside ViewerCameraController.** It owns the 5px threshold and `canvas-click` dispatch.
- **SelectionManager never touches raw DOM events.** It receives clientX/clientY from the `canvas-click` handler.
- **PickingSystem is passive.** It only records mouse position; actual read happens in the animate loop.
- **ShortcutManager is the only capture-phase listener** (keydown). It calls `stopPropagation()` to block camera keys.
- **Stack interaction** adds its own `mousemove` + `click` listeners directly on canvas, parallel to the camera system. These raycast against background meshes identically to SelectionManager.

### Listener registration order (canvas)

| Event      | Phase    | Owner                     | Action                    |
|------------|----------|---------------------------|---------------------------|
| mousedown  | bubble   | ViewerCameraController    | Start drag                |
| mousemove  | bubble   | document (PickingSystem)  | Track cursor for picking  |
| mousemove  | bubble   | canvas (stack interaction) | Fan-out hover             |
| mouseup    | bubble   | document (VCC)            | End drag, maybe emit click|
| click      | bubble   | canvas (stack interaction) | Pull-to-workspace         |
| canvas-click | bubble | canvas (GitHubRepoViewer) | Selection raycast         |
| wheel      | bubble   | canvas (VCC)              | Scroll pan / zoom         |
| keydown    | capture  | document (ShortcutManager)| Shortcut intercept        |
| keydown    | bubble   | document (VCC)            | WASD camera               |

## 2. HitDispatcher Design

### Interception point

HitDispatcher registers on the **canvas in the capture phase** for mousedown. This fires before ViewerCameraController's bubbling-phase mousedown. On hit, it calls `stopPropagation()` + `preventDefault()` to suppress camera drag. On miss, it does nothing and the event bubbles normally to VCC.

```
Browser mousedown
  |
  [CAPTURE phase]
  +-> HitDispatcher.onMouseDown   *** NEW -- canvas, capture ***
  |     Raycast against all draggable objects (grids + agent windows)
  |     HIT:  stopPropagation(), enter window-drag mode
  |     MISS: do nothing, event continues to bubble phase
  |
  [BUBBLE phase]
  +-> ViewerCameraController._onMouseDown  (only reached on miss)
```

### Why capture on canvas, not document

- Registering on canvas limits scope. Document capture would intercept clicks on DOM UI.
- Canvas capture fires before canvas bubble (VCC's mousedown). That's all we need.
- ShortcutManager already proves this pattern works (capture on document for keydown).

### Class sketch

```js
/**
 * HitDispatcher -- intercepts mousedown on 3D objects before camera drag.
 *
 * Responsibilities:
 * - Raycast on mousedown to test window/grid hits
 * - Suppress camera drag when hit, enter window-drag mode
 * - Track drag displacement for click vs. drag disambiguation
 * - Emit 'canvas-click' for click-on-window (< 5px)
 * - Update window position during drag (>= 5px)
 * - Detect drop-onto-window for grouping
 */
export class HitDispatcher {
    /**
     * @param {Object} opts
     * @param {HTMLCanvasElement} opts.canvas
     * @param {THREE.Camera} opts.camera
     * @param {THREE.Scene} opts.scene
     * @param {SceneRegistry} opts.registry
     * @param {THREE} opts.THREE
     */
    constructor({ canvas, camera, scene, registry, THREE }) {
        this._canvas = canvas;
        this._camera = camera;
        this._scene = scene;
        this._registry = registry;
        this._THREE = THREE;

        this._raycaster = new THREE.Raycaster();
        this._mouse = new THREE.Vector2();

        // Drag state
        this._active = false;       // true while dragging a window
        this._target = null;        // { entry, grid, grabOffset }
        this._mouseDownX = 0;
        this._mouseDownY = 0;
        this._prevX = 0;
        this._prevY = 0;
        this._hasMoved = false;     // displacement >= 5px

        // Bound handlers
        this._onMouseDown = this._handleMouseDown.bind(this);
        this._onMouseMove = this._handleMouseMove.bind(this);
        this._onMouseUp = this._handleMouseUp.bind(this);
    }

    attach() {
        // Capture phase on canvas: fires before VCC's bubble-phase mousedown
        this._canvas.addEventListener('mousedown', this._onMouseDown, { capture: true });
        // Document-level move/up so drag continues outside canvas
        document.addEventListener('mousemove', this._onMouseMove);
        document.addEventListener('mouseup', this._onMouseUp);
    }

    detach() {
        this._canvas.removeEventListener('mousedown', this._onMouseDown, { capture: true });
        document.removeEventListener('mousemove', this._onMouseMove);
        document.removeEventListener('mouseup', this._onMouseUp);
    }

    // -- Handlers --

    _handleMouseDown(e) {
        if (e.button !== 0) return;  // left-click only

        const hit = this._raycastDraggable(e.clientX, e.clientY);
        if (!hit) return;  // miss -- let VCC handle it

        // Suppress camera drag
        e.stopPropagation();

        this._active = true;
        this._hasMoved = false;
        this._mouseDownX = e.clientX;
        this._mouseDownY = e.clientY;
        this._prevX = e.clientX;
        this._prevY = e.clientY;

        // Compute grab offset in world space (so window doesn't snap to cursor)
        const worldPoint = hit.point;
        const gridPos = hit.grid.position;
        this._target = {
            entry: hit.entry,
            grid: hit.grid,
            grabOffset: {
                x: gridPos.x - worldPoint.x,
                y: gridPos.y - worldPoint.y,
            },
        };

        this._canvas.style.cursor = 'grabbing';
    }

    _handleMouseMove(e) {
        if (!this._active) return;

        const dx = e.clientX - this._mouseDownX;
        const dy = e.clientY - this._mouseDownY;
        const displacement = Math.sqrt(dx * dx + dy * dy);

        if (displacement >= 5) {
            this._hasMoved = true;
        }

        if (this._hasMoved) {
            // Convert screen delta to world delta at target's Z depth
            const worldDelta = this._screenToWorldDelta(
                e.clientX - this._prevX,
                e.clientY - this._prevY,
                this._target.grid.position.z
            );
            this._target.grid.position.x += worldDelta.x;
            this._target.grid.position.y += worldDelta.y;
        }

        this._prevX = e.clientX;
        this._prevY = e.clientY;
    }

    _handleMouseUp(e) {
        if (!this._active) return;

        if (!this._hasMoved) {
            // Displacement < 5px -- treat as click on the window
            this._canvas.dispatchEvent(new CustomEvent('canvas-click', {
                detail: {
                    clientX: e.clientX,
                    clientY: e.clientY,
                    shiftKey: e.shiftKey,
                    ctrlKey: e.ctrlKey,
                    metaKey: e.metaKey,
                },
                bubbles: true,
            }));
        } else {
            // Drag completed -- check for drop-onto-window grouping
            const dropTarget = this._findDropTarget(
                this._target.grid, e.clientX, e.clientY
            );
            if (dropTarget) {
                this._emitGroupRequest(this._target.entry, dropTarget);
            }
        }

        this._active = false;
        this._target = null;
        this._canvas.style.cursor = 'grab';
    }

    // -- Raycasting --

    /**
     * Raycast against all draggable objects (grids + agent windows).
     * Returns the frontmost hit with its registry entry.
     */
    _raycastDraggable(clientX, clientY) {
        const rect = this._canvas.getBoundingClientRect();
        this._mouse.set(
            ((clientX - rect.left) / rect.width) * 2 - 1,
            -((clientY - rect.top) / rect.height) * 2 + 1
        );
        this._raycaster.setFromCamera(this._mouse, this._camera);

        // Collect background meshes from all registered objects
        const meshToEntry = new Map();
        for (const entry of this._registry.list()) {
            const bg = entry.grid?._background;
            if (bg && bg.visible) {
                meshToEntry.set(bg, entry);
            }
        }

        const hits = this._raycaster.intersectObjects(
            [...meshToEntry.keys()], false
        );
        if (hits.length === 0) return null;

        // Frontmost hit (Three.js sorts by distance)
        const hitMesh = hits[0].object;
        const entry = meshToEntry.get(hitMesh);
        return {
            entry,
            grid: entry.grid,
            point: hits[0].point,
        };
    }

    // -- World-space helpers --

    /**
     * Convert screen-pixel delta to world-space delta at a given Z depth.
     * Same math as VCC._applyDragTranslation but returns a vector
     * instead of modifying the camera.
     */
    _screenToWorldDelta(dxPixels, dyPixels, targetZ) {
        const camera = this._camera;
        const dist = Math.abs(camera.position.z - targetZ);
        const fovFactor = 2 * Math.tan((camera.fov * Math.PI / 180) / 2);
        const pixelScale = (dist * fovFactor) / this._canvas.clientHeight;

        return {
            x: dxPixels * pixelScale,
            y: -dyPixels * pixelScale,  // screen Y is inverted
        };
    }

    // -- Drop detection --

    /**
     * After drag ends, check if the dragged grid overlaps another grid.
     * Uses bounding-box overlap with a proximity threshold.
     */
    _findDropTarget(draggedGrid, clientX, clientY) {
        const dragBounds = draggedGrid.getBounds?.();
        if (!dragBounds) return null;

        const OVERLAP_THRESHOLD = 0.3;  // 30% overlap required

        for (const entry of this._registry.list()) {
            if (entry.grid === draggedGrid) continue;
            const targetBounds = entry.grid.getBounds?.();
            if (!targetBounds) continue;

            const overlap = this._computeOverlap(dragBounds, targetBounds);
            const dragArea = dragBounds.width * dragBounds.height;
            if (dragArea > 0 && overlap / dragArea >= OVERLAP_THRESHOLD) {
                return entry;
            }
        }
        return null;
    }

    _computeOverlap(a, b) {
        const xOverlap = Math.max(0,
            Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x)
        );
        const yOverlap = Math.max(0,
            Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y)
        );
        return xOverlap * yOverlap;
    }

    _emitGroupRequest(sourceEntry, targetEntry) {
        window.dispatchEvent(new CustomEvent('window-group-request', {
            detail: {
                sourceId: sourceEntry.id,
                targetId: targetEntry.id,
            },
        }));
    }
}
```

## 3. Edge Cases

### Drag starts on window, mouse leaves canvas
Handled: `mousemove` and `mouseup` are on `document`, not canvas. Drag continues smoothly outside canvas bounds. Same pattern as VCC.

### Drag starts on empty space near window edge
The raycast hits `_background` meshes only. Background has padding around text content (set in `CodeGrid._updateBackground`). Near the edge, either the background mesh is hit (drag starts) or it's not (camera pans). No ambiguity.

### Two overlapping windows -- which one gets the drag?
`THREE.Raycaster.intersectObjects` returns hits sorted by distance (nearest first). The frontmost window wins. This is correct: the one visually on top is the one the user expects to grab. Z-pop from selection raises selected grids by 3 units, making them naturally frontmost.

### Right-click vs left-click
`_handleMouseDown` checks `e.button !== 0` and returns early for non-left clicks. Right-click propagates normally (no suppression). Context menus work.

### Touch input
TouchController currently delegates pan to `cam._applyDragTranslation()`. For window drag:
- Single-touch: HitDispatcher needs a parallel `touchstart` handler that raycasts, same as mousedown.
- Add `_onTouchStart` / `_onTouchMove` / `_onTouchEnd` with identical logic, using `e.changedTouches[0]`.
- Two-finger touch stays camera-only (pinch zoom + pan) -- TouchController owns that, no change needed.
- Implementation: add touch handlers in Phase 1, not Phase 0. The mouse path proves the design.

## 4. Event Priority Chain

### Registration order (after HitDispatcher is wired)

```
1. ShortcutManager   [document, keydown, CAPTURE]     -- blocks camera keys
2. HitDispatcher     [canvas, mousedown, CAPTURE]      -- blocks camera drag on window hit
3. VCC               [canvas, mousedown, bubble]        -- camera drag on miss
4. VCC               [document, mousemove, bubble]      -- camera drag translation
5. HitDispatcher     [document, mousemove, bubble]      -- window drag translation
6. PickingSystem     [document, mousemove, bubble]      -- cursor tracking
7. VCC               [document, mouseup, bubble]        -- end camera drag, emit canvas-click
8. HitDispatcher     [document, mouseup, bubble]        -- end window drag, emit canvas-click or group
9. SelectionManager  [canvas, canvas-click, bubble]     -- raycast selection
```

No conflicts: HitDispatcher's capture-phase mousedown suppresses VCC (items 3-4-7 never fire). HitDispatcher's document-level move/up (items 5, 8) only act when `_active` is true. When `_active` is false, they return immediately.

### Who calls stopPropagation?

Only HitDispatcher's mousedown capture handler. Everything else flows naturally.

## 5. Drop-to-Group Detection

Two strategies, use both with priority:

1. **Bounding-box overlap (primary)**: After drag ends, compute 2D bounding-box intersection between dragged grid and all other grids. If overlap exceeds 30% of the dragged grid's area, emit `window-group-request`. This is the `_findDropTarget` method above.

2. **Proximity snap (secondary, future)**: If no overlap, check if the dragged grid's edge is within a snap threshold (e.g. 5 world units) of another grid's edge. Emit `window-snap-request` for side-by-side arrangement. This is Phase 2.

The `window-group-request` CustomEvent carries `sourceId` and `targetId` (both from SceneRegistry). A WindowGroupManager (separate class, Phase 1) listens and creates/modifies groups.

## 6. Integration Point

HitDispatcher is created and attached in `GitHubRepoViewer` constructor, between camera controller setup and selection manager setup:

```js
// Camera controller
this.cameraController = new ViewerCameraController(this.sceneContext);
this.cameraController.setupEventListeners();

// *** NEW: HitDispatcher -- intercepts mousedown before camera ***
this.hitDispatcher = new HitDispatcher({
    canvas: this.canvas,
    camera: this.camera,
    scene: this.scene,
    registry: this.registry,
    THREE,
});
this.hitDispatcher.attach();

// Touch controls
this.touchController = new TouchController(this.canvas, this.cameraController, THREE);

// Selection manager
this.selectionManager = new SelectionManager(THREE, this.fileStateManager);
```

No changes to ViewerCameraController, SelectionManager, PickingSystem, or ShortcutManager. HitDispatcher is purely additive. The existing `canvas-click` flow is reused for click-on-window selection.

## 7. Files to create/modify

| File | Action | Purpose |
|------|--------|---------|
| `src/services/interaction/HitDispatcher.js` | **Create** | Core class from sketch above |
| `app/GitHubRepoViewer.js` | Modify | Import + instantiate + attach HitDispatcher |
| `app/GitHubRepoViewer.js` | Modify | Add cleanup in dispose path |

Zero changes to existing event handlers. Zero changes to VCC, SelectionManager, PickingSystem, or ShortcutManager.

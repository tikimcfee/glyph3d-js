# Predictions from Spatial Mechanics

Agent: **Spatial Mechanics**
Predicting conclusions of: **Event Pipeline**, **Integration Surface**

---

## Prediction: Event Pipeline Agent

I expect the Event Pipeline agent concluded that the existing click/drag disambiguation in `ViewerCameraController` (5px displacement threshold, `canvas-click` CustomEvent dispatch) is the correct interception point for window drag, and that a new layer must sit between `mousedown` and the camera controller to claim events before the camera does.

Specifically, I predict they designed a `HitDispatcher` or similar intermediary that intercepts `mousedown` on the canvas, performs a quick raycast against window background meshes to determine whether the pointer landed on a draggable window surface, and if so, suppresses the camera controller's drag path (likely via `stopPropagation()` or a shared `_consumed` flag on the event). They almost certainly flagged the tension between pointer lock (which `InputManager.onMouseDown` requests) and window dragging (which needs screen-space cursor movement), concluding that window drag must prevent pointer lock acquisition. For click-through -- when a mousedown on a window does not become a drag -- they likely proposed re-dispatching the `canvas-click` CustomEvent so that `SelectionManager.handleClick` still fires. The 5px threshold would apply symmetrically: sub-threshold mousedown+mouseup on a window = click (select/focus), super-threshold = drag (reposition).

Their key concern is likely event priority ordering: which consumer gets first refusal of a mousedown. The current system has `InputManager` on the canvas element and `ViewerCameraController` mouse handlers on the canvas. Adding a third consumer (window manager drag) creates a three-way contention. I expect they proposed an explicit priority chain: (1) window drag intercept, (2) camera drag, (3) click dispatch -- with the first consumer that claims the event suppressing the rest. They may have also addressed the drop-to-group detection problem by proposing a raycast on mouseup to check whether the dragged window was released over another window's background mesh or a group boundary region, using the same raycast infrastructure as SelectionManager but against a different set of targets.

---

## Prediction: Integration Surface Agent

I expect the Integration Surface agent concluded that `SceneRegistry` is the natural backbone for window group membership, likely proposing that group information be stored as metadata on registry entries (e.g., `meta.windowGroup: groupId`) rather than as a parallel data structure. They would have noted that SceneRegistry already supports `findByMeta(key, value)`, which makes querying "all grids in group X" a one-liner. They probably also proposed a new registry type like `'group'` to register group objects themselves, giving groups first-class identity in the scene graph.

For `SelectionManager` interaction, I predict they identified the Z-pop conflict I flagged in my analysis -- `SelectionManager._applyZPop` uses a fixed `Z_POP_AMOUNT = 3` and saves/restores original Z, which will fight with the window manager's own depth management. Their proposed resolution is likely a guard: check `grid.userData._windowGroup` before applying Z-pop, and defer to the window manager's depth system for grouped grids. They may have also proposed that selection of a grouped grid should bring the entire group forward, or that selection semantics differ for grouped vs. ungrouped grids.

For `CodeColorManager`, I expect they proposed a new color layer (e.g., `'window-group'` at a moderate priority) that tints all members of a group with a shared accent color, using the existing `registerLayer` + `watchProperties` machinery. The `colorFn` would read a `groupColor` property from `FileStateManager`, set when a grid joins a group. This is the zero-cost path since `setGroupColor` is already O(1) per file.

On the command surface, I predict they designed commands like `group.create`, `group.add`, `group.remove`, `group.list`, `group.mode` (to switch stack/splay/free), and `group.dissolve`, following the existing `window.*` and `select.*` command naming patterns. These would be registered in a new `groupCommands.js` handler file under `app/commands/handlers/`.

For lifecycle concerns, they likely addressed what happens when a grid is unregistered from SceneRegistry (file removed, repo cleared) while it belongs to a group -- the group must automatically evict the member. They probably proposed hooking SceneRegistry's `_onChange` callback or wrapping `unregister` to propagate removal to the window manager.

Good -- there is no raycasting or click-to-select on the 3D canvas today. Selection only happens through the file tree panel in the drawer. Now I have a complete picture of the current system. Let me produce the analysis.

I cannot write files (this is a read-only planning task), so I will provide the full analysis document content directly in my response.

---

## IDE-like UX Features: Interaction Design Analysis

### System Inventory

Before designing, here is what exists today and what the design must integrate with:

**Current interaction model:**
- Canvas: click-drag pans, scroll zooms, WASD moves. No click-to-select on 3D objects.
- File tree in drawer: click a file to `focusOnGrid(index)` which moves camera. A `camera-focus-changed` event syncs `.selected` class on tree items. This is the only selection mechanism.
- No raycasting. No hover detection. No keyboard shortcuts beyond WASD/Space/Shift.
- Three layout modes: hierarchical (backdrops + nameplates), spiral (guide line), treemap (no labels today).

**Rendering primitives available:**
- `CodeGrid` extends `THREE.Object3D`, has a background plane, and wraps a `GlyphCollection`.
- `GlyphCollection.setGroupColor(groupId, {r,g,b})` and `setGroupColorBlend(groupId, blend)` allow O(1) per-file color changes via GPU DataTexture.
- `CodeColorManager` already supports layered color resolution (heatmap is layer 0, priority 10). New layers (selection, search highlight) can register alongside it.
- `FileStateManager` provides a reactive property store keyed by sourcePath with change callbacks.
- `BackdropManager` creates depth-coded planes behind directory groups in hierarchical mode.
- `NameplateManager` creates billboard CodeGrid labels for directories in hierarchical mode. Treemap mode has neither backdrops nor nameplates.

---

### 1. Selection State

**Core interaction: click on canvas to select a file**

The current drag-to-pan model creates a conflict: mousedown starts a drag, but a click (mousedown+mouseup without significant movement) should select. The CameraController already tracks `isDragging` and `_dragPrevX/Y`. The solution is to measure displacement between mousedown and mouseup; if displacement is under a threshold (e.g., 5 pixels), treat it as a click rather than a drag.

**Raycasting pipeline:**

A new `SelectionManager` would own a `THREE.Raycaster`. On canvas click (after the drag-vs-click disambiguation), it projects the mouse position into 3D and tests against CodeGrid background planes. CodeGrid backgrounds are `THREE.Mesh` children of the grid's Object3D, so standard `raycaster.intersectObjects(scene.children, true)` works, but must filter to only background meshes (checking `intersect.object.parent instanceof CodeGrid` or matching by name pattern).

**Selection states and visual feedback:**

- **Hover (pointer moves, no drag):** This is expensive in 3D -- raycasting every mousemove event against potentially hundreds of meshes. Solution: throttle to ~10Hz, and only cast when not dragging. Hover highlights the file's background plane by temporarily increasing its opacity (from 0.85 to 0.95) and adding a subtle border color shift. This is achievable by modifying the background material's `color` property to include a slight tint (e.g., shifting toward the accent green #00ff88). No glyph-level changes needed for hover -- that keeps it cheap.

- **Single selection (click):** The selected file gets three visual treatments: (a) background color shifts to a selection tint (dark green, matching the tree-item `.selected` style #1a3a1a), (b) a Z-pop -- the grid's `position.z` increases by 2-3 units to lift it above neighbors, creating a parallax separation visible at any zoom, (c) the camera does NOT auto-navigate (unlike the tree panel click behavior). This is important: clicking in 3D to select should not yank the camera. The user is already looking at the file.

- **Tree panel sync:** When a file is selected via canvas click, dispatch a `file-selected` CustomEvent with `{ sourcePath, gridIndex }`. The tree panel listens and scrolls the corresponding `.tree-item` into view, applying the `.selected` class. Conversely, when a tree item is clicked, it should both focus the camera AND set the selection state (current behavior plus the new selection visual). This bidirectional sync requires a single source of truth for selection -- `SelectionManager` owns it.

- **Multi-select:** Hold Cmd/Ctrl and click to add to selection. Hold Shift and click to range-select (by grid index order). Multi-select is useful for batch operations (future: compare files, bulk color override). Visual treatment is the same per file. The file tree panel shows all selected items with the `.selected` class. Multi-select is a secondary feature; single-select is the priority.

- **Deselect:** Click on empty space (raycast hits nothing) or press Escape. Escape is the canonical deselect gesture.

**Edge cases:**
- Overlapping grids in treemap mode: Z-depth ordering means the raycast returns the front-most grid. This is correct behavior since treemap uses `depthZ` to layer directories.
- Extremely zoomed out: background planes are tiny and hard to click. Consider expanding the hit target to include a bounding box slightly larger than the background plane (padding of 2 units).
- During drag: must not trigger selection. The displacement threshold (5px) handles this.

**Implementation touch points:**
- New file: `SelectionManager.js` in `examples/github-viewer/`
- Modify: `CameraController.js` -- add click disambiguation (mousedown/mouseup displacement check), emit a `canvas-click` event with screen coordinates.
- Modify: `GitHubRepoViewer.js` -- instantiate SelectionManager, wire canvas-click to it, register `file-selected` listener for tree sync.
- Modify: `CodeColorManager.js` -- register a `selection` color layer (priority 20, above heatmap at 10) that returns a selection tint color for selected files.
- CSS: `.tree-item.selected` already exists and works.

---

### 2. Minimap / Scrollbar Navigation

**Design decision: 2D overlay, not 3D picture-in-picture.**

A 3D PIP would require rendering the scene twice per frame (expensive) and would look like a confusing miniature of an already-abstract visualization. A 2D overlay is cheaper, clearer, and matches IDE conventions (VS Code's minimap, Figma's overview).

**Implementation approach:**

A fixed-position HTML canvas element (not a Three.js renderer) in the bottom-left corner, approximately 180x120px. It renders a simplified top-down schematic:

- **Hierarchical mode:** Rectangles for each directory group (from `BackdropManager._backdrops` or `HierarchicalLayoutManager.root`), colored by depth using the same `DEPTH_COLORS` palette but at higher opacity. File-level detail is not shown -- directories are the navigational unit at overview scale.
- **Treemap mode:** Rectangles for each directory block from `TreemapLayoutManager.pathToNode`, filled with depth-coded colors. This naturally matches the treemap's visual structure.
- **Spiral mode:** A spiral line plus dots for file positions. This is the simplest case.

**Viewport indicator:** A semi-transparent white rectangle showing the camera's current frustum projected onto the XY plane. The frustum's XY footprint at `z=0` (or the average grid Z) can be computed from `camera.position`, `camera.fov`, and `camera.aspect`. This rectangle updates every frame in the animation loop.

**Interaction:**
- Click on the minimap: compute the corresponding world XY coordinates from the click position, set `camera.position.x` and `camera.position.y` to those coordinates (keeping current Z). This is a jump-to, not a smooth animation (smooth animation would conflict with the user dragging the minimap).
- Drag on the minimap: continuously update camera position while dragging. This gives a scrollbar-like feel.
- The minimap must consume its own mouse events (stopPropagation) so they do not trigger canvas pan/selection.

**Coordinate mapping:** The minimap needs the total layout bounds (available from any layout manager's `getTotalBounds()`). Map world bounds to minimap pixel bounds with a uniform scale factor. The viewport indicator maps inversely.

**Visibility:** The minimap should auto-hide when the drawer is open (on mobile, the drawer covers most of the screen). Show/hide toggle via a small button or keyboard shortcut (M key).

**Edge case: layout change.** When the user switches layouts, the minimap must recalculate its coordinate mapping from the new `getTotalBounds()`. Listen for a `layout-changed` event or hook into `relayoutGrids()`.

**Implementation touch points:**
- New file: `MinimapOverlay.js` in `examples/github-viewer/components/`
- New CSS: minimap container, viewport indicator styles.
- Modify: `GitHubRepoViewer.js` -- instantiate minimap, pass layout manager, update in animation loop.
- Modify: `styles.css` -- minimap positioning and responsive rules.

---

### 3. Keyboard Shortcuts

**Design principles for 3D navigation shortcuts:**
- Do not conflict with WASD/Space/Shift (camera movement). This rules out most letter keys for shortcuts unless modified with Cmd/Ctrl.
- Shortcuts must not fire when an input element is focused (repo URL, branch name). Check `document.activeElement.tagName` before handling.
- The current keydown/keyup handlers in CameraController set `this.keys[e.code] = true/false`. A new `ShortcutManager` should intercept keydown events before CameraController, checking for shortcut matches first.

**Proposed shortcuts:**

| Shortcut | Action | Notes |
|---|---|---|
| `Escape` | Deselect all, close search overlay | Universal dismiss |
| `Tab` | Select next file (by grid index) | Wraps around. Shift+Tab for previous. |
| `Enter` | Focus camera on selected file | Same as double-click or tree click |
| `Cmd+P` / `Ctrl+P` | Open file search palette | Quick-open by filename, like VS Code |
| `Cmd+F` / `Ctrl+F` | Open search-in-view overlay | Search across visible files |
| `1` / `2` / `3` | Switch layout (hierarchical / spiral / treemap) | Number keys, only when no input focused |
| `F` | Fit all grids in view | Same as "Fit All" button |
| `[` / `]` | Navigate to prev/next sibling file in same directory | Spatial adjacency navigation |
| `Backspace` | Navigate up to parent directory (zoom out to directory view) | |
| `M` | Toggle minimap | |
| `H` | Toggle heatmap layer | |
| `?` | Show keyboard shortcut help overlay | |

**Tab traversal order:** In hierarchical mode, tab order follows the file tree order (depth-first, alphabetical). In treemap mode, it follows left-to-right, top-to-bottom visual order (by grid position). In spiral mode, it follows the spiral order (by grid index). The `SelectionManager` would maintain a sorted index list per layout mode.

**File search palette (Cmd+P):** A floating input field at the top-center of the viewport (like VS Code's command palette). As the user types, it fuzzy-matches against `grid.userData.sourcePath` and shows a dropdown of up to 10 results. Selecting a result calls `focusOnGrid(index)` and selects the file. Escape closes it. This requires a new `CommandPalette.js` component.

**Implementation touch points:**
- New file: `ShortcutManager.js` in `examples/github-viewer/`
- New file: `CommandPalette.js` in `examples/github-viewer/components/`
- Modify: `CameraController.js` -- keydown handler should check if a shortcut manager wants to consume the event first, or the ShortcutManager registers on `document` with higher priority (capture phase).
- Modify: `GitHubRepoViewer.js` -- instantiate ShortcutManager, register shortcuts.
- Modify: `Drawer.js` controlsPanelHTML() -- update controls help text with new shortcuts.

---

### 4. Directory / File Labeling (Treemap Mode)

**Current state:** Treemap mode has NO labels. `NameplateManager` and `BackdropManager` are explicitly disabled for treemap and spiral modes (see `_createOverlays()` lines 871-884). The hierarchical-mode `NameplateManager` uses billboard CodeGrids that rotate to face the camera -- this does not work for treemap because treemap is viewed top-down and labels need to be statically positioned.

**Design: Level-of-detail (LOD) labeling system**

Labels should be responsive to zoom level. The camera's Z distance determines what is readable:

- **Zoomed out (Z > 800, seeing entire layout):** Show only top-level directory group labels. These are large, positioned at the top-left corner of each directory block. Use the same CodeGrid-based rendering as NameplateManager but without billboard rotation -- fixed orientation facing the camera (which is always looking down -Z in this app). Color: accent green (#00ff88) at scale 2.0-3.0.

- **Medium zoom (Z 200-800, seeing a few directory groups):** Show directory labels AND file count badges. File labels begin to appear for larger files only (files whose background plane occupies more than ~30px on screen). To determine this, compute the projected screen size of each file's bounds using `camera.projectionMatrix` and the file's world-space width.

- **Zoomed in (Z < 200, reading individual files):** Show individual file labels (filename) above each CodeGrid. These are small (scale 1.0) and positioned at `bounds.max.y + 2` above each grid. Directory labels at this zoom are either hidden or extremely faded to avoid clutter.

**Implementation approach:**

A new `TreemapLabelManager` that extends the pattern of `NameplateManager` but with LOD logic:

1. At layout time, compute label positions for all directories and files in the treemap.
2. Each frame (in the animation loop), compute a visibility threshold based on camera Z distance. Use `camera.position.z` as a proxy for zoom level (since pitch/yaw are always 0 in this app's navigation model).
3. Toggle label visibility: `label.visible = (cameraZ < threshold)`. This is an O(n) check per frame but with a simple comparison -- fast enough.
4. Use THREE.Group containers: one for directory-level labels, one for file-level labels. Toggle group visibility for the coarse LOD check, then fine-tune individual labels based on projected size.

**Label content:**
- Directory labels: `dirName (fileCount)` e.g., `components (12)`
- File labels: just the filename, e.g., `CameraController.js`

**Label positioning for treemap:**
- Directory labels: top-left corner of the directory block, offset by `(padding, yOffset, zOffset)` from the block origin. Since treemap groups files left-to-right in rows, the group's top-left is `(min_x_of_group, max_y_of_group)`.
- File labels: centered above each file's background plane.

**Edge case: overlapping labels.** When directory blocks are small (few files), directory and file labels may overlap. Priority goes to directory labels when zoomed out, file labels when zoomed in. The LOD thresholds handle this naturally.

**Implementation touch points:**
- New file: `TreemapLabelManager.js` in `examples/github-viewer/`
- Modify: `GitHubRepoViewer.js` -- instantiate for treemap mode in `_createOverlays()`, update in animation loop alongside `nameplateManager.updateBillboards()`.
- Modify: `TreemapLayoutManager.js` -- expose `_groupByDirectory` results (directory block origins and sizes) via a public method for label positioning.

---

### 5. Highlighting Actions

**Architecture: all highlighting flows through CodeColorManager's layer system.**

The existing layer system (`CodeColorManager._layers`) resolves colors by priority. The heatmap is priority 10. New layers:

| Layer | Priority | Behavior |
|---|---|---|
| heatmap | 10 | Existing. Colors by file complexity. |
| selection | 20 | Tints selected files with selection color. |
| search-highlight | 30 | Highlights files containing search matches. |
| syntax-theme | 5 | Future: per-language color themes. Lower priority than heatmap. |

Higher priority layers override lower ones. A layer's `colorFn` returns `null` to pass through to lower layers.

**5a. Search-in-view (Cmd+F)**

A search overlay appears at the top of the viewport: a text input with match count display. As the user types, the system searches across all visible files:

1. For each grid, check `grid.content.includes(searchString)` (or regex match). This is O(n * m) where n is file count and m is average file size. For typical repos (<500 files), this is near-instant.
2. Files with matches get colored via the `search-highlight` layer (priority 30, overrides heatmap and selection). Color: a warm amber `{r:1.0, g:0.7, b:0.2}` to stand out against the dark background.
3. Files WITHOUT matches get dimmed: the search-highlight layer returns a low-saturation gray `{r:0.2, g:0.2, b:0.2}` for non-matching files when search is active. This creates a spotlight effect.
4. Match count per file is shown in a results list below the search input (scrollable, click to focus).

**Glyph-level highlighting (future enhancement):** The current `setGroupColor` API colors ALL glyphs in a file uniformly. To highlight individual matching characters/lines would require per-glyph color changes via the GlyphCollection instance color API. This is significantly more complex and should be a Phase 2 feature. Phase 1 uses file-level coloring only.

**5b. Syntax highlighting toggle**

Today all text renders in a single color (green default, or heatmap override). True syntax highlighting would require a tokenizer per language and per-glyph coloring. This is a large feature.

A simpler first step: "syntax theme" as a CodeColorManager layer (priority 5) that assigns a per-file color based on file extension. For example, `.js` files get a warm yellow, `.css` files get a cool blue, `.md` files get a purple. This is not real syntax highlighting but gives visual differentiation by file type in the overview. The `colorFn` would look at the file extension in `sourcePath`.

**5c. Heatmap overlays**

Already implemented via `HeatmapProvider` + `CodeColorManager`. The heatmap layer can be toggled: `codeColorManager.setLayerEnabled('heatmap', enabled)`. When disabled, files revert to the next-lower-priority layer or white (default).

**Composability:** The layer priority system handles composition automatically. If search is active (priority 30) and heatmap is on (priority 10), search colors win. If a file is selected (priority 20) but also has search matches (priority 30), search color wins. This may not always be desired -- an alternative is to blend colors. But for Phase 1, priority-based override is simpler and avoids color-mixing artifacts (e.g., amber + green = murky).

One refinement: the selection layer could apply a Z-pop visual effect (not a color) that is independent of color layers. This way a selected file can show its search-highlight color while still being visually lifted. Z-pop is implemented in SelectionManager directly on `grid.position.z`, not through CodeColorManager.

**Implementation touch points:**
- New file: `SearchOverlay.js` in `examples/github-viewer/components/`
- Modify: `CodeColorManager.js` -- no structural changes needed, just register new layers.
- Modify: `GitHubRepoViewer.js` -- instantiate SearchOverlay, register search-highlight and selection layers, wire Cmd+F shortcut.
- Modify: `FileStateManager.js` -- optionally store `searchMatchCount` property per file for the search results list.

---

### Summary of New Files

1. `examples/github-viewer/SelectionManager.js` -- selection state, raycasting, multi-select
2. `examples/github-viewer/ShortcutManager.js` -- keyboard shortcut registry and dispatch
3. `examples/github-viewer/components/MinimapOverlay.js` -- 2D overview canvas with viewport indicator
4. `examples/github-viewer/components/CommandPalette.js` -- Cmd+P quick-open file search
5. `examples/github-viewer/components/SearchOverlay.js` -- Cmd+F search-in-view with file-level highlighting
6. `examples/github-viewer/TreemapLabelManager.js` -- LOD-aware directory/file labels for treemap mode

### Summary of Modified Files

1. `examples/github-viewer/CameraController.js` -- click disambiguation (drag vs click)
2. `examples/github-viewer/GitHubRepoViewer.js` -- wire all new subsystems, animation loop updates
3. `examples/github-viewer/CodeColorManager.js` -- register selection and search layers
4. `examples/github-viewer/components/Drawer.js` -- update controls panel with shortcut docs
5. `examples/github-viewer/styles.css` -- minimap, command palette, search overlay, selection styles
6. `examples/github-viewer/TreemapLayoutManager.js` (in `src/`) -- expose directory block geometry for labels

### Implementation Sequence

**Phase 1 (foundation):** SelectionManager + CameraController click disambiguation. This unblocks everything else.
**Phase 2 (navigation):** ShortcutManager + keyboard shortcuts + Tab traversal.
**Phase 3 (overview):** MinimapOverlay.
**Phase 4 (search):** CommandPalette (Cmd+P) + SearchOverlay (Cmd+F) + search-highlight color layer.
**Phase 5 (labels):** TreemapLabelManager with LOD.

Each phase is independently shippable and testable.

---

### Critical Files for Implementation
- /Users/lugo/localdev/viz-web/glyph3d-js/examples/github-viewer/CameraController.js
- /Users/lugo/localdev/viz-web/glyph3d-js/examples/github-viewer/GitHubRepoViewer.js
- /Users/lugo/localdev/viz-web/glyph3d-js/examples/github-viewer/CodeColorManager.js
- /Users/lugo/localdev/viz-web/glyph3d-js/src/collections/TreemapLayoutManager.js
- /Users/lugo/localdev/viz-web/glyph3d-js/examples/github-viewer/styles.css

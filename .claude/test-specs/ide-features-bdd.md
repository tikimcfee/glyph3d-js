# IDE Features — BDD Test Specifications

Manual browser-based verification specs using Given/When/Then format.
No test runner; all verification is done visually in the browser at
`http://localhost:8000/examples/github-viewer/`.

---

## Feature: File Selection via Canvas Click

### Scenario: Single-click selects a file
- **Given** a loaded repository with files rendered as CodeGrids
- **When** I click on a file's background plane in the 3D view (mouse displacement < 5px)
- **Then** the file highlights with a teal tint (r:0.2, g:0.9, b:0.6)
- **And** the grid Z-pops forward by 3 units above its original position
- **And** the corresponding `.tree-item.tree-file` in the drawer gets the `.selected` class
- **And** a `file-selected` CustomEvent fires on `window` with `{ sourcePath, primary, selected }`
- **And** `selectionManager.primary` equals the clicked file's `sourcePath`
- **And** `selectionManager.getSelected()` contains exactly one entry

### Scenario: Click on empty space deselects
- **Given** a file is currently selected (teal tint visible, Z-popped)
- **When** I click on empty 3D space (raycast hits no background mesh)
- **Then** the selection clears: teal tint removed, Z restored to original
- **And** no `.tree-item` has the `.selected` class
- **And** `selectionManager.primary` is `null`
- **And** `selectionManager.getSelected().size` is 0

### Scenario: Escape key deselects all
- **Given** one or more files are selected
- **When** I press the Escape key
- **Then** all selections clear (tint removed, Z restored for every selected file)
- **And** `selectionManager.primary` is `null`

### Scenario: Escape key while Escape listener is registered
- **Given** a file is selected
- **And** the focus is on the 3D canvas (no input element focused)
- **When** I press Escape
- **Then** selection clears
- **Verify** `document.addEventListener('keydown', ...)` handler at line 279 of GitHubRepoViewer.js fires

### Scenario: Cmd+click adds to selection (multi-select)
- **Given** file A is currently selected
- **When** I hold Cmd (Mac) or Ctrl (Windows) and click on file B
- **Then** both file A and file B are selected (both teal-tinted and Z-popped)
- **And** `selectionManager.primary` equals file B (most recently selected)
- **And** `selectionManager.getSelected()` contains both paths
- **And** both corresponding `.tree-item` elements have `.selected` class

### Scenario: Cmd+click on already-selected file deselects it
- **Given** files A and B are both selected
- **When** I hold Cmd/Ctrl and click on file A
- **Then** file A is deselected (tint removed, Z restored)
- **And** file B remains selected
- **And** `selectionManager.primary` equals file B

### Scenario: Non-additive click replaces multi-selection
- **Given** files A and B are both selected
- **When** I click on file C without holding Cmd/Ctrl
- **Then** files A and B are deselected
- **And** only file C is selected
- **And** `selectionManager.getSelected().size` is 1

### Scenario: Click-drag does NOT trigger selection
- **Given** a loaded repository
- **When** I mousedown on a file, drag 20px, then mouseup
- **Then** no `canvas-click` event fires (displacement >= 5px threshold)
- **And** the camera pans as usual
- **And** no selection state changes

### Scenario: Click near the 5px threshold boundary
- **Given** a loaded repository
- **When** I mousedown and mouseup with exactly 4px displacement
- **Then** `canvas-click` fires (4 < 5)
- **When** I mousedown and mouseup with exactly 6px displacement
- **Then** `canvas-click` does NOT fire (6 >= 5)

### Scenario: Drawer stays open on canvas click
- **Given** the drawer is open (showing file tree)
- **When** I click on a file in the 3D canvas
- **Then** the drawer remains open (`drawerController.isOpen` stays true)
- **And** the clicked file is selected

### Scenario: Tree panel click selects file AND focuses camera
- **Given** a loaded repository with the drawer open to the Files tab
- **When** I click a file item in the tree panel
- **Then** the camera focuses on that file (via `focusOnGrid`)
- **And** `selectionManager.select()` is called for that file's path
- **And** the file gets teal tint and Z-pop

### Scenario: Selection persists across layout changes
- **Given** file A is selected in hierarchical mode
- **When** I switch to treemap layout via the layout dropdown
- **Then** file A remains in `selectionManager.getSelected()`
- **And** after relayout, the Z-pop may be lost (grids reposition)
- **Verify** the selection color layer still applies teal tint (FileStateManager property `selected` persists)

### Scenario: Selection cleared on repo change
- **Given** file A is selected
- **When** I load a new repository
- **Then** `selectionManager.dispose()` is called
- **And** all selection state resets

### Scenario: Click on overlapping grids in treemap mode
- **Given** treemap layout is active with overlapping depth layers
- **When** I click on an area where two grids overlap
- **Then** the front-most grid (highest Z) is selected (raycast returns nearest intersection)

---

## Feature: Keyboard Shortcuts

### Scenario: Escape clears selection
- **Given** a file is selected
- **And** no input element is focused (`document.activeElement` is `<body>` or `<canvas>`)
- **When** I press Escape
- **Then** the selection clears

### Scenario: Escape does not clear selection when input focused
- **Given** a file is selected
- **And** the repo URL input (`#repo-input`) is focused
- **When** I press Escape
- **Then** the input loses focus (browser default)
- **Verify** current implementation: the Escape handler at line 279 does NOT check `activeElement`, so it will still clear selection even with input focused
- **Expected behavior** (after ShortcutManager): Escape should close the active overlay/input first, clear selection only if no overlay is active

### Scenario: Tab selects next file (future ShortcutManager)
- **Given** no file is selected
- **When** I press Tab
- **Then** the first file (by grid index order) is selected
- **And** Tab's default browser behavior (focus shift) is prevented

### Scenario: Tab cycles through files
- **Given** file at grid index 3 is selected
- **When** I press Tab
- **Then** file at grid index 4 is selected (previous deselects)
- **When** the last file is selected and I press Tab
- **Then** selection wraps to the first file (grid index 0)

### Scenario: Shift+Tab selects previous file
- **Given** file at grid index 3 is selected
- **When** I press Shift+Tab
- **Then** file at grid index 2 is selected
- **When** file at grid index 0 is selected and I press Shift+Tab
- **Then** selection wraps to the last file

### Scenario: Tab does not fire when input focused
- **Given** the repo URL input is focused
- **When** I press Tab
- **Then** the browser's default tab behavior fires (moves focus to next form element)
- **And** no file selection changes

### Scenario: Number keys switch layout
- **Given** no input element focused
- **When** I press `1`
- **Then** layout switches to hierarchical
- **When** I press `2`
- **Then** layout switches to spiral
- **When** I press `3`
- **Then** layout switches to treemap
- **And** the `#layout-mode` select element value updates

### Scenario: Number keys do not fire when typing in input
- **Given** the branch input (`#branch-input`) is focused
- **When** I type `1`
- **Then** the character `1` appears in the input
- **And** the layout does NOT change

### Scenario: F key fits all grids
- **Given** a loaded repo, no input focused
- **When** I press `F`
- **Then** `cameraController.focusOnGrids()` is called
- **And** the camera zooms to fit all content

### Scenario: Enter focuses camera on selected file
- **Given** a file is selected
- **When** I press Enter
- **Then** `cameraController.focusOnGrid(index)` is called for the selected file
- **And** the camera navigates to a reading distance

### Scenario: M key toggles minimap
- **Given** the minimap is visible
- **When** I press `M`
- **Then** the minimap hides
- **When** I press `M` again
- **Then** the minimap shows

### Scenario: Cmd+P opens command palette (future)
- **Given** no overlay is open
- **When** I press Cmd+P (Mac) / Ctrl+P (Windows)
- **Then** a command palette input appears at top-center
- **And** the browser's default print dialog is prevented

### Scenario: Cmd+F opens search overlay (future)
- **Given** no overlay is open
- **When** I press Cmd+F (Mac) / Ctrl+F (Windows)
- **Then** a search input overlay appears
- **And** the browser's native find-in-page is prevented

### Scenario: ? key shows shortcut help
- **Given** no input focused, no overlay open
- **When** I press `?`
- **Then** a keyboard shortcut help overlay appears
- **When** I press `?` again or Escape
- **Then** the overlay closes

---

## Feature: Minimap Navigation

### Scenario: Minimap renders on repo load
- **Given** a repository is loaded with files visible
- **When** I look at the bottom-left corner of the viewport
- **Then** I see a minimap canvas (approximately 180x120px)
- **And** it shows colored rectangles representing file/directory blocks
- **And** a semi-transparent white rectangle shows the current viewport

### Scenario: Click on minimap jumps camera
- **Given** the minimap is visible
- **When** I click on a position in the minimap
- **Then** the camera's X and Y positions jump to the corresponding world coordinates
- **And** the camera's Z (zoom level) stays the same
- **And** the viewport indicator on the minimap updates to reflect the new position

### Scenario: Drag on minimap pans camera continuously
- **Given** the minimap is visible
- **When** I click and drag across the minimap
- **Then** the camera position updates continuously while dragging
- **And** the minimap does NOT trigger canvas pan or selection

### Scenario: Minimap viewport indicator tracks camera
- **Given** the minimap is visible
- **When** I pan the camera using WASD or drag
- **Then** the viewport indicator rectangle on the minimap moves accordingly
- **When** I zoom in (scroll)
- **Then** the viewport indicator rectangle shrinks

### Scenario: Minimap updates on layout change
- **Given** the minimap is visible in hierarchical mode
- **When** I switch to treemap layout
- **Then** the minimap re-renders with treemap-style rectangles
- **And** the coordinate mapping recalculates from the new `getTotalBounds()`

### Scenario: Minimap click does not affect canvas events
- **Given** the minimap is visible
- **When** I click on the minimap
- **Then** no `canvas-click` event fires
- **And** no selection changes
- **And** no camera drag initiates
- **Verify** `stopPropagation()` prevents event leakage

### Scenario: Minimap hides when toggled off
- **Given** the minimap is visible
- **When** I press `M` (or future toggle button)
- **Then** the minimap element is hidden (`display: none` or `visible: false`)
- **And** no minimap updates occur per frame (performance optimization)

### Scenario: Minimap with empty scene
- **Given** no repository is loaded
- **When** I look at the bottom-left corner
- **Then** the minimap is either hidden or shows an empty state
- **And** clicking does nothing

---

## Feature: Treemap Labels (LOD)

### Scenario: Directory labels visible when zoomed out
- **Given** treemap layout is active
- **And** the camera is zoomed out (Z > 800, seeing entire layout)
- **When** I look at the layout
- **Then** top-level directory labels are visible (e.g., "src (42)", "components (12)")
- **And** individual file labels are NOT visible
- **And** directory labels are accent green (#00ff88) at large scale (2.0-3.0)

### Scenario: File labels appear when zoomed in
- **Given** treemap layout is active
- **And** the camera is zoomed in (Z < 200)
- **When** I look at individual files
- **Then** filename labels appear above each CodeGrid (e.g., "CameraController.js")
- **And** directory labels either fade out or are hidden

### Scenario: Medium zoom shows both directory labels and some file labels
- **Given** treemap layout is active
- **And** the camera is at medium zoom (Z between 200 and 800)
- **When** I look at the layout
- **Then** directory labels are visible
- **And** file labels appear only for larger files (projected screen size > ~30px)

### Scenario: Labels update on zoom change
- **Given** treemap layout with labels visible
- **When** I continuously zoom in (scroll or WASD)
- **Then** labels toggle visibility smoothly based on camera Z distance
- **And** there is no visible pop-in/pop-out flicker (thresholds are per-frame checks)

### Scenario: Labels reposition on layout change
- **Given** labels are visible in treemap mode
- **When** I change layout spacing via the spacing slider
- **Then** `relayoutGrids()` fires and labels reposition to match new grid positions

### Scenario: Labels do not appear in non-treemap modes
- **Given** hierarchical layout is active (which has its own NameplateManager)
- **When** I look at the layout
- **Then** TreemapLabelManager labels are NOT visible
- **And** NameplateManager billboard labels are visible instead

### Scenario: Overlapping labels at small directory blocks
- **Given** treemap layout with a small directory (2-3 files)
- **When** I zoom to medium distance
- **Then** the directory label takes priority (visible)
- **And** file labels within that block do NOT overlap the directory label

---

## Feature: Highlighting / Color Layers

### Scenario: Selection layer overrides heatmap
- **Given** heatmap is enabled (layer priority 10)
- **And** a file shows a red heatmap color (high complexity)
- **When** I click to select that file
- **Then** the file's color changes to teal (selection layer, priority 15)
- **And** the heatmap color is no longer visible on that file
- **When** I deselect the file
- **Then** the file reverts to its heatmap color

### Scenario: Search highlight overrides both heatmap and selection (future)
- **Given** search is active (search-highlight layer, priority 30)
- **And** a file matches the search query
- **When** that file also happens to be selected
- **Then** the file shows the search highlight color (amber, r:1.0, g:0.7, b:0.2)
- **And** the Z-pop from selection is still visible (Z-pop is independent of color)

### Scenario: Non-matching files dim during search (future)
- **Given** search is active with a query that matches 5 of 50 files
- **When** I look at the 3D view
- **Then** the 5 matching files show amber highlight
- **And** the remaining 45 files show dimmed gray (r:0.2, g:0.2, b:0.2)
- **And** the spotlight effect makes matching files stand out

### Scenario: Heatmap toggle removes heatmap coloring
- **Given** heatmap is enabled and files show color-coded complexity
- **When** I toggle heatmap off (`codeColorManager.setLayerEnabled('heatmap', false)`)
- **Then** all files revert to neutral white (identity color)
- **Unless** another layer (selection, search) is active and provides color

### Scenario: Color layer registration
- **Given** the viewer is initialized
- **When** I inspect `codeColorManager._layers`
- **Then** layers are sorted by priority descending
- **And** the selection layer watches `['selected']`
- **And** the heatmap layer watches `['heatMetric']`

### Scenario: FileStateManager drives color updates
- **Given** the selection layer is registered
- **When** `fileStateManager.setProperty('src/foo.js', 'selected', true)` is called
- **Then** `_handlePropertyChanged` fires
- **And** the selection layer's `colorFn` returns teal for that file
- **And** `_applyColorToGrid` sets the group color to teal with blend mode 1.0

---

## Feature: Tree Panel Bidirectional Sync

### Scenario: Canvas selection syncs to tree panel
- **Given** the drawer is open to the Files tab
- **When** I click a file in the 3D canvas
- **Then** the corresponding `.tree-item.tree-file` gets the `.selected` class
- **And** the tree item scrolls into view if it is offscreen within the drawer

### Scenario: Tree panel click syncs to canvas
- **Given** a file in the tree panel
- **When** I click the tree item
- **Then** the 3D file gets selection highlighting (teal tint + Z-pop)
- **And** the camera focuses on that file

### Scenario: Multi-select syncs to tree panel
- **Given** I Cmd+click to select files A and B on canvas
- **Then** both `.tree-item` elements for A and B have `.selected`
- **And** no other tree items have `.selected`

### Scenario: Deselect syncs to tree panel
- **Given** file A is selected and tree item A has `.selected`
- **When** I click empty space on canvas
- **Then** tree item A loses the `.selected` class

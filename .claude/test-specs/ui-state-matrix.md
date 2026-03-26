# IDE Features — UI State Interaction Matrix

Comprehensive matrix of all UI actions against all possible UI states.
Cells describe the expected behavior. Blank cells indicate no interaction.

---

## Legend

- **SEL** = Selection active (one or more files selected)
- **SEARCH** = Search overlay active (Cmd+F, future)
- **CMD-P** = Command palette open (Cmd+P, future)
- **MINI** = Minimap visible
- **DRAWER** = Drawer panel open
- **INPUT** = Text input focused (repo URL, branch, search box, command palette input)
- **HIER/SPIRAL/TREE** = Active layout mode

---

## Action vs. State Matrix

### Mouse Actions

| Action | No State Active | SEL Active | SEARCH Active | CMD-P Open | DRAWER Open | MINI Visible |
|--------|----------------|------------|---------------|------------|-------------|-------------|
| **Canvas click (hit file)** | Select file | Replace selection (non-additive) | Close search + select file | Close palette + select file | Drawer stays open + select file | No effect on minimap |
| **Canvas Cmd+click (hit file)** | Select file (additive) | Add to / remove from selection | Close search + additive select | Close palette + additive select | Drawer stays open + additive select | No effect on minimap |
| **Canvas click (empty)** | Nothing | Clear selection | Close search | Close palette | Drawer stays open | No effect on minimap |
| **Canvas drag** | Pan camera | Pan camera (no selection change) | Pan camera | Pan camera | Pan camera, drawer stays open | Pan camera, minimap viewport updates |
| **Minimap click** | Jump camera | Jump camera (selection unchanged) | Jump camera | Jump camera | Jump camera | Jump camera |
| **Minimap drag** | Pan camera via minimap | Pan camera (selection unchanged) | Pan camera | Pan camera | Pan camera | Continuous pan |
| **Drawer toggle click** | Open/close drawer | Open/close drawer (selection unchanged) | Open/close drawer | Close palette + toggle drawer | Toggle drawer | No effect on minimap |
| **Tree item click** | Select file + focus camera | Replace selection + focus camera | Close search + select + focus | Close palette + select + focus | Stays in drawer | Minimap viewport updates from focus |
| **Scroll (no Alt)** | Pan | Pan | Pan | Scroll results list | Scroll drawer content | Pan + minimap viewport updates |
| **Scroll (Alt)** | Zoom | Zoom | Zoom | Zoom | Zoom | Zoom + minimap viewport updates |

### Keyboard Actions

| Action | No State Active | SEL Active | SEARCH Active | CMD-P Open | INPUT Focused | Any Layout |
|--------|----------------|------------|---------------|------------|---------------|------------|
| **Escape** | Nothing | Clear all selection | Close search overlay | Close command palette | Blur input element | No layout change |
| **Tab** | Select first file | Select next file | Go to next search match | Select next palette result | Browser default (focus next) | Tab order depends on layout mode |
| **Shift+Tab** | Select last file | Select prev file | Go to prev search match | Select prev palette result | Browser default (focus prev) | Reverse tab order |
| **Enter** | Nothing | Focus camera on primary selection | Navigate to current match + close search | Open selected palette result + close palette | Submit form (if applicable) | No layout change |
| **Cmd+P / Ctrl+P** | Open command palette | Open command palette (selection stays) | Close search + open palette | Close palette (toggle) | Prevent default, open palette | No layout change |
| **Cmd+F / Ctrl+F** | Open search | Open search (selection stays) | Focus search input (already open) | Close palette + open search | Prevent default, open search | No layout change |
| **1** | Switch to hierarchical | Switch layout (selection persists) | Nothing (search consumes) | Nothing (palette consumes) | Type "1" in input | Switch to hierarchical |
| **2** | Switch to spiral | Switch layout (selection persists) | Nothing | Nothing | Type "2" in input | Switch to spiral |
| **3** | Switch to treemap | Switch layout (selection persists) | Nothing | Nothing | Type "3" in input | Switch to treemap |
| **F** | Fit all grids in view | Fit all grids | Nothing | Nothing | Type "f" in input | Fit all for current layout |
| **M** | Toggle minimap | Toggle minimap | Nothing | Nothing | Type "m" in input | Toggle minimap |
| **H** | Toggle heatmap | Toggle heatmap | Nothing | Nothing | Type "h" in input | Toggle heatmap |
| **?** | Show shortcut help | Show shortcut help | Nothing | Nothing | Type "?" in input | Show shortcut help |
| **[ / ]** | Nothing | Navigate to prev/next sibling file | Nothing | Nothing | Type bracket in input | Sibling nav within directory |
| **Backspace** | Nothing | Navigate up to parent directory | Delete char in search | Delete char in palette | Delete char in input | No layout change |
| **W/A/S/D** | Camera translate | Camera translate | Camera translate (search stays open) | Nothing (palette consumes) | Type in input | Camera translate |
| **Space** | Camera up | Camera up | Nothing (browser might scroll) | Nothing | Type space in input | Camera up |
| **Shift** | Camera down | Camera down | Modifies Tab (Shift+Tab) | Modifies Tab | Browser default | Camera down |

---

## Context Priority Resolution

When multiple UI states are active simultaneously, the following priority determines which system consumes a keyboard event:

1. **INPUT focused** (highest): All key events go to the input. ShortcutManager `_paused = true`. Only Escape blurs.
2. **CMD-P open**: Command palette captures Tab, Enter, Escape, arrow keys, and all typing. Other shortcuts suppressed.
3. **SEARCH active**: Search captures Tab (next match), Shift+Tab (prev match), Enter (go to match), Escape (close). WASD still works for camera. Number keys suppressed.
4. **SEL active**: Selection-aware shortcuts (Tab/Enter/[/]/Backspace) fire. All other shortcuts normal.
5. **Default** (lowest): All shortcuts fire normally.

The ShortcutManager `_activeContext` determines which set of bindings is active. Context stack enables proper nesting (e.g., search active + selection active).

---

## Escape Key Cascade

Escape dismisses UI elements in priority order (one press per level):

| Press | Current State | Action |
|-------|--------------|--------|
| 1st | Command palette open | Close command palette |
| 1st | Search overlay open | Close search overlay |
| 1st | Shortcut help open | Close help overlay |
| 1st | Selection active (no overlay) | Clear selection |
| 1st | Nothing active | No action |

If multiple overlays are open (should not happen by design, but defensively):
- Escape closes the topmost overlay (most recent `pushContext`)
- A second Escape closes the next one
- Selection is cleared only when no overlays remain

---

## Layout Mode Impact on Behavior

| Behavior | Hierarchical | Spiral | Treemap |
|----------|-------------|--------|---------|
| **Tab traversal order** | Depth-first alphabetical (tree order) | Spiral index order | Left-to-right, top-to-bottom (visual order) |
| **Directory labels** | NameplateManager billboards | None | TreemapLabelManager LOD labels |
| **File labels** | None (zoom in to read code) | None | TreemapLabelManager LOD labels (zoomed in) |
| **Backdrops** | BackdropManager depth-coded planes | None | None (treemap blocks serve as backdrops) |
| **Minimap rendering** | Rectangles per directory group | Spiral line + dots | Rectangles per directory block |
| **[/] sibling nav** | Next/prev file in same directory by tree order | Next/prev by spiral index | Next/prev by visual adjacency |
| **Backspace parent nav** | Zoom to parent directory bounds | Not applicable | Zoom to parent treemap block |
| **Selection Z-pop** | Works (lifts grid above backdrop) | Works (lifts grid above neighbors) | Works but may interact with depth layering |

---

## Compound State Scenarios

### Scenario: Search + Selection + Heatmap
- Heatmap enabled (priority 10)
- File A selected (priority 15)
- Search active with matches in files B, C, D (priority 30)
- **File A**: shows search-highlight color if A has matches (search overrides selection). Z-pop still active. If A has no matches, shows dim gray (search override). Z-pop still active.
- **File B**: shows amber search highlight (overrides heatmap)
- **File E (no match, not selected)**: shows dim gray

### Scenario: Minimap + Drawer + Selection
- Minimap visible in bottom-left
- Drawer open on right side
- File selected with Z-pop
- **Canvas click**: selection changes, drawer stays open, minimap viewport unaffected
- **Minimap click**: camera jumps, drawer stays open, selection unchanged
- **Drawer file click**: selection changes, camera focuses, minimap viewport updates
- **Escape**: clears selection. Drawer stays open. Minimap stays visible.

### Scenario: Command Palette + Selection
- File A selected
- Cmd+P opens palette
- User types "Cam" and sees "CameraController.js" in results
- Presses Enter
- **Result**: palette closes, camera focuses on CameraController.js, CameraController.js is now selected (replaces A), previous selection cleared

### Scenario: Layout Switch Mid-Selection
- Files A, B selected in hierarchical mode
- User presses `3` to switch to treemap
- **Expected**: `relayoutGrids()` runs. Grids reposition. Z-pop positions may be lost (grids moved to new coords). FileStateManager `selected` properties persist. After relayout, CodeColorManager `updateAllColors()` re-applies teal tint. Z-pop must be re-applied by SelectionManager (it should listen for layout-changed events or be called after relayout).

### Scenario: Repo Load Clears Everything
- Files selected, search active, minimap visible, drawer open
- User loads a new repository
- **Expected**: `selectionManager.dispose()`, search clears, minimap clears and waits for new layout, drawer shows loading state, all FileStateManager properties wiped. After new repo loads, minimap rebuilds, labels rebuild, everything starts fresh.

---

## Event Flow Diagram


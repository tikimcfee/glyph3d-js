# Audit map — visualizer vs. application vs. chrome

> Living document. Built by reading the corpus listed in
> `REFACTOR_PLAN.md` in full, top to bottom. Each entry follows:
>
>     ### <concern> — <short description>
>     **File(s):** `path:line-range`
>     **Bucket:** substrate | application | chrome
>     **Reaches into:** [other concerns]
>     **Intent:** what it wants to do
>     **Current shape:** how it's implemented
>     **Refactor note:** what should change, or "leave alone"
>
> Bucket legend:
> - **substrate** — belongs in `src/`, consumed by everything
> - **application** — IDE-specific glue, consumes substrate
> - **chrome** — DOM/UI widget, listens to events, owns no scene state
>
> Dependency direction we want: chrome → application → substrate.
> Anything flowing the wrong way is a refactor target.

## Status

| File | Lines | Read |
|------|-------|------|
| app/GitHubRepoViewer.js | 2380 | ✅ |
| app/IDEShell.js | 1332 | ✅ |
| app/commands/index.js | 504 | ✅ |
| app/commands/handlers/index.js | 60 | ✅ |
| app/commands/handlers/{camera,grid,highlight,spatial,attention,edit}Commands.js | ~1220 | ✅ |
| app/components/*.js (10 files) | 2407 | ✅ |
| app/ide.html | 451 | ✅ |
| src/services/orchestration/CommandRouter.js | 225 | ✅ |
| src/services/orchestration/WebSocketBridge.js | 529 | ✅ |
| src/services/SceneContext.js | 43 | ✅ |
| src/services/camera/ViewerCameraController.js | 875 | ✅ |
| src/collections/CodeGrid.js | 1771 | ✅ |
| src/services/data/*.js (8 files) | 2101 | ✅ |
| src/services/interaction/*.js (7 files) | 1684 | ✅ |

---

## Concerns

---

# Pass 1: `app/GitHubRepoViewer.js` (2380 lines)

The god class. Mixes substrate boot, application orchestration, and DOM
chrome wiring. ~30 concerns identified below, grouped by phase.

### Substrate boot — atlas + shaping + slug
**File:** `app/GitHubRepoViewer.js:240-307`
**Bucket:** application (currently); should be **substrate** primitive
**Reaches into:** GlyphAtlas, HarfBuzzShaper, MonospaceShapeCache, SlugEncoder, WorkerBridge
**Intent:** Initialize the GPU-renderable atlas/shape pipeline. ~67 lines of
sequential init that every consumer (HomeShell, GitHubRepoViewer, any future
viewer) needs verbatim.
**Current shape:** Inline in `init()`. `HomeShell.js` duplicates the
same sequence with the same probe ranges. Stashes `_shaper`/`_slugData`
on `this.atlas` so CodeGrid can auto-discover them.
**Refactor note:** Extract `Viewer3D.bootGlyphPipeline({ font, fontSize,
size })` returning `{ atlas, shaper, shapeCache, slugData }`. Both shells
consume it. Eliminates ~67 lines of duplication and the hidden coupling
through `atlas._slugData`.

### Substrate boot — Three.js scene/camera/renderer
**File:** `app/GitHubRepoViewer.js:310-321`
**Bucket:** application → **substrate**
**Reaches into:** THREE, `getCanvasViewportSize`
**Intent:** Create the canonical scene/camera/renderer triple at the right
sizing for the canvas container.
**Current shape:** Inline; identical concept lives in HomeShell.
**Refactor note:** Belongs in the same `Viewer3D` extract above. One
canonical 3D-canvas boot.

### Picking system wiring
**File:** `app/GitHubRepoViewer.js:327-334`, animate loop `2356-2376`,
mousemove `801-809`
**Bucket:** substrate (the system) + application (the highlight side-effect)
**Reaches into:** `PickingSystem`, `_lastPickHit`, document mousemove
**Intent:** Resolve the glyph under the cursor each frame and tint it.
**Current shape:** Picking system itself is substrate; the
hover-highlight side-effect (write yellow tint to glyph, clear previous)
is inline in the render loop. `_lastPickHit`/`_lastPickSlot` are stored
on the viewer.
**Refactor note:** The hover-tint policy is an application opinion
("hover paints yellow"). Move it to a `HoverHighlighter` plug-in that
listens to picking results so substrate has no IDE-specific tint.

### GridVirtualizer wiring
**File:** `app/GitHubRepoViewer.js:339-342`, `1500-1506`, `1706-1711`,
`2341-2343`
**Bucket:** substrate
**Reaches into:** scene, camera, atlas (for reload after eviction)
**Intent:** Frustum-cull non-visible grids; evict and reload buffers.
**Current shape:** Created once with eviction on. Registered after grid
load. Updated every frame. **Used by both home page (implicit, since
demo.repo grids are not registered) and IDE.** Already substrate-quality.
**Refactor note:** Leave alone. Confirm home page's demo.repo
registers grids with virtualizer so eviction works there too.

### SceneContext bag
**File:** `app/GitHubRepoViewer.js:354-364`
**Bucket:** substrate (the construct) + application (the bag's growth)
**Reaches into:** Everything
**Intent:** Single shared object that subsystems read from to avoid
constructor-injection of 12 args.
**Current shape:** `SceneContext` (43 lines, src/services/) is a thin
holder. The viewer then **mutates additional fields onto it** at runtime
(`hierarchicalManager`, `spiralManager`, `treemapManager`, `stackManager`,
`entityInputRouter`, `layoutManager`). That mutation is the coupling.
**Refactor note:** SceneContext should be a typed substrate handle
(scene, camera, renderer, canvas, atlas, registry, bridge,
getGrids). Layout strategy slots move to a separate
`LayoutController` so toggling layout doesn't poke at SceneContext.

### ViewerCameraController wiring
**File:** `app/GitHubRepoViewer.js:367-371`
**Bucket:** substrate
**Reaches into:** SceneContext
**Intent:** Camera physics + input + focus + diff/grid framing helpers.
**Current shape:** Already substrate-quality. Home page uses it too.
**Refactor note:** Leave alone for now; audit the controller itself in
its own pass. Note: `focusOnDiffFile`, `focusOnDiffGrids`,
`focusOnDirectory`, `focusOnGrid`, `focusOnGrids` all live on the
controller — IDE-specific framing helpers that might be polluting a
substrate primitive.

### FileStateManager + CodeColorManager + HeatmapProvider
**File:** `app/GitHubRepoViewer.js:374-380`, `1481-1485`
**Bucket:** application (the wiring), substrate (the managers)
**Reaches into:** SceneContext, watch-properties API
**Intent:** Color grids by per-file metadata; heatmap is one layer,
selection is another.
**Current shape:** Managers are substrate. Inline `registerLayer` calls
declare the IDE's color policy (heatmap priority 10, selection priority
15). HeatmapProvider is created during load.
**Refactor note:** The color-layer registrations are application policy.
Move them into a `ColorPolicy` module that an application boots into the
substrate `CodeColorManager`. Substrate doesn't know about heatmap or
selection — just layers.

### SelectionManager + selection color layer
**File:** `app/GitHubRepoViewer.js:383-395`
**Bucket:** substrate (manager) + application (the teal-tint policy)
**Reaches into:** FileStateManager, CodeColorManager
**Intent:** Track selected file paths and tint them teal.
**Current shape:** Manager is substrate. Tint color hardcoded inline.
**Refactor note:** Same as ColorPolicy above. The intent across
SelectionManager + fileStateManager.selected + CodeColorManager's
selection layer + AttentionManager is "what entity is the user focused
on" — a single concept with four implementations. Leapfrog target.

### Spatial animator + window manager
**File:** `app/GitHubRepoViewer.js:398-407`
**Bucket:** substrate
**Reaches into:** registry, selectionManager, fileStateManager,
codeColorManager
**Intent:** Group/animate spatial windows (the multi-grid workspace).
**Current shape:** Already substrate. Animator's `update(dt)` is called
from the render loop.
**Refactor note:** Audit SpatialAnimator/Manager separately. They look
substrate-shaped (no DOM, no IDE-specific verbs).

### ReaderCompass + capture-phase mousedown
**File:** `app/GitHubRepoViewer.js:415-434`
**Bucket:** substrate (the compass) + application (the mode wiring)
**Reaches into:** `_commandContext.mode`, `_commandRouter`, canvas
**Intent:** In reader mode, clicking the compass jumps to the neighbor it
points at. Capture-phase listener must run **before** EntityInputRouter's
drag-start.
**Current shape:** Inline `mousedown` handler with `stopImmediatePropagation`
to defeat EntityInputRouter on the same canvas. Coupling: the viewer has
to know about ordering relative to a sibling listener.
**Refactor note:** EntityInputRouter should own input priority ordering
explicitly (registered priorities, not capture-phase wins). Compass
becomes a registered handler at higher priority than grid-drag.

### EntityInputRouter
**File:** `app/GitHubRepoViewer.js:442-453`
**Bucket:** substrate
**Reaches into:** canvas, camera, scene, registry, spatialManager,
virtualizer
**Intent:** Intercept mousedown on registered entity types (grid, agent,
terminal) and dispatch to per-type handlers before camera drag claims it.
Also exposes `raycastAtClient` for focus probe + click-to-attention.
**Current shape:** Already substrate. Exposed via SceneContext for
external consumers.
**Refactor note:** Audit its own file in a later pass. Likely the home of
the input-priority fix above.

### DOM event listeners installed by init()
**File:** `app/GitHubRepoViewer.js:456-489`
**Bucket:** chrome (UI sync) reaching into substrate (selection)
**Concerns:**
- `camera-focus-changed` → toggles `.selected` on `.tree-item` DOM
  (chrome consumes scene event ✓)
- `canvas-click` → calls `selectionManager.handleClick()` AND
  re-routes to `mode.reader` when in reader mode (application+substrate)
- `file-selected` → toggles `.selected` on tree DOM (chrome ✓)
**Refactor note:** The DOM-tree-sync handlers belong on a `TreePanel`
component listening to events. The `canvas-click` handler's
selection-management belongs in EntityInputRouter (or a sibling). The
viewer's `init` should not be wiring DOM tree state.

### ShortcutManager + _registerShortcuts
**File:** `app/GitHubRepoViewer.js:495-499`, `937-1105`
**Bucket:** application (the bindings) + substrate (the manager)
**Reaches into:** attentionManager, commandRouter, selectionManager,
grids, registry, spatialManager, cameraController, toastUI, minimapOverlay,
stackManager, statePersistence
**Intent:** IDE-specific keymap. Escape unwinds (LIFO),
Tab/Shift+Tab traverse, Enter enters reader mode, [/] navigate readers,
Arrow keys jump, F fit, M minimap, 1-4 layout, R return stack, V dynamic
speed, G group, U ungroup.
**Current shape:** All bindings in one method, ~170 lines.
**Refactor note:** Bindings are application policy. Move to an
`IDEShortcuts` module that takes the substrate handles as constructor
deps and registers via ShortcutManager. The viewer doesn't need to know
"escape goes through this LIFO order."

### MinimapOverlay
**File:** `app/GitHubRepoViewer.js:505-521`, animate `2331-2333`
**Bucket:** substrate (component) + application (the configured callbacks)
**Reaches into:** camera, grids, layout managers
**Intent:** 2D overhead view; click to jump camera to that XY.
**Current shape:** Component is substrate. Wired here with an
`onNavigate` callback that pokes camera.position directly + a
`getLayoutBounds` callback that knows about all four layout managers.
**Refactor note:** Should consume a `LayoutController.getBounds()` once
that exists. Click→camera could route through a `CameraIntent.jumpTo(x,y)`
verb on the controller.

### HandGestureAdapter
**File:** `app/GitHubRepoViewer.js:526-530`, toggle `645-685`, animate
`2316-2318`
**Bucket:** substrate (adapter) + chrome (settings checkbox wiring)
**Intent:** Optional hand-tracking input source.
**Current shape:** Created up-front, disabled by default. Toggled by a
checkbox in Settings panel.
**Refactor note:** Adapter looks substrate. Checkbox wiring is chrome.
The settings panel as a whole should consume an `IntegrationsRegistry`
that the viewer doesn't have to micro-manage per-feature.

### Command center init
**File:** `app/GitHubRepoViewer.js:538-550`
**Bucket:** application — wires substrate
**Reaches into:** `initCommandCenter` (app/commands/index.js)
**Intent:** Build CommandRouter + WebSocketBridge + window.viewer +
context bag for handlers.
**Current shape:** `initCommandCenter(this, {...})` — passes the viewer
itself into the context builder. **This is where buildContext couples
handlers to the entire viewer.**
**Refactor note:** Major target. Replace `initCommandCenter(viewer)`
with `initCommandCenter(substrateBundle, applicationBundle)`. Handlers
declare which slice they need.

### Source-mode RepoAdapter selection
**File:** `app/GitHubRepoViewer.js:553-562`, `1303-1317`
**Bucket:** application
**Reaches into:** RemoteFileSystemProvider, RepositoryAdapter, bridge,
diffController
**Intent:** Pick the data source based on URL param / saved state.
**Current shape:** Inline conditional. Mode switch re-creates the
adapter and backfills it into diffController.
**Refactor note:** Move to `ProjectMount` — given a source spec, returns
the right adapter. The viewer doesn't care which kind.

### addGridHelper (debug grid)
**File:** `app/GitHubRepoViewer.js:1151-1157`
**Bucket:** chrome (visual debug)
**Intent:** Faint reference grid in 3D.
**Current shape:** One-liner, inline.
**Refactor note:** Home page has `ReferenceSpace` (richer drafting-paper
substrate). IDE should adopt it. Delete this method.

### setupEventListeners (DOM wiring blob)
**File:** `app/GitHubRepoViewer.js:749-930`
**Bucket:** chrome
**Reaches into:** drawer DOM ids, layoutManager, cameraController,
stateController, getTextExts/Names, statePersistence
**Intent:** Wire every DOM control in the drawer panels.
**Current shape:** ~180 lines of `document.getElementById(...).addEventListener(...)`
covering: repo input, branch input, fetch-branches, source select, file-type
whitelist, resize, document mousemove, grids-scale slider, layout-spacing,
layout-mode, minimap-size, atlas font/size/clear, file-type apply/reset.
**Refactor note:** Each panel should own its own wiring. The viewer
should not know `'grids-scale'` is a DOM id. After the panels-become-
passive-widgets refactor (candidate cut #4), this method shrinks to
window-resize only.

### Window resize handler
**File:** `app/GitHubRepoViewer.js:790-797`
**Bucket:** substrate behavior — but installed at app level
**Intent:** Resize renderer, update camera aspect, relayout compass.
**Current shape:** Inline.
**Refactor note:** Should be owned by `Viewer3D` — both shells need it.
IDEShell also has `_onEditorResize()` doing a different version of the
same thing.

### relayoutGrids
**File:** `app/GitHubRepoViewer.js:1159-1227`
**Bucket:** application
**Reaches into:** all four layout managers, sceneContext mutation,
treemapLabelManager, gridVirtualizer
**Intent:** Switch active layout, teardown previous, refresh
virtualizer bounds.
**Current shape:** Big conditional chain, knows every layout manager
by name, mutates SceneContext.
**Refactor note:** `LayoutController` strategy pattern. Each layout is
a strategy with `apply(grids) / clear() / getTotalBounds() / supports(features)`.
Switching is one call. SceneContext.layoutController owns the active
strategy.

### fetchBranches + renderBranchList
**File:** `app/GitHubRepoViewer.js:1229-1297`
**Bucket:** chrome+application
**Intent:** GitHub repo URL → branch list panel.
**Current shape:** Talks to substrate GitHubRepositorySource then
populates DOM.
**Refactor note:** Belongs in a `RepoLoadPanel` widget that owns the
DOM and uses GitHubRepositorySource directly.

### File type whitelist
**File:** `app/GitHubRepoViewer.js:1323-1348`
**Bucket:** application+chrome
**Intent:** Textarea → parse exts/names → set filter + push to relay.
**Current shape:** Inline. Coupled to textarea, relay, statePersistence.
**Refactor note:** Owned by a `FileTypeFilterPanel` widget.

### loadRepository + _loadLocalRepository
**File:** `app/GitHubRepoViewer.js:1350-1745`
**Bucket:** application
**Reaches into:** repoAdapter, hierarchicalManager, layout managers,
heatmapProvider, registry, gridVirtualizer, virtualizer, statePersistence
**Intent:** Load repo → fetch files → create grids → layout → overlays
→ heatmap → tree UI → first render → register virtualizer.
**Current shape:** ~200 lines × 2 (GitHub and local are near-duplicates,
diverging only on `treeResult` call shape).
**Refactor note:** This is the biggest refactor target. Becomes
`ProjectMount.load(source, opts)`. Single code path; the source
abstraction handles GitHub vs local. ~400 lines collapse to ~80.

### createGridForFileAsync
**File:** `app/GitHubRepoViewer.js:1747-1760`
**Bucket:** substrate-helper at application level
**Intent:** Build a single CodeGrid with picking wired.
**Current shape:** 13 lines, clean.
**Refactor note:** Move to `ProjectMount` as a private helper, or onto
the CodeGrid constructor as a factory that auto-wires picking when
present.

### clearGrids
**File:** `app/GitHubRepoViewer.js:1762-1806`
**Bucket:** application — lifecycle teardown
**Reaches into:** registry, virtualizer, layoutManager, hierarchicalManager,
diffController, pickingSystem, fileStateManager, codeColorManager,
selectionManager, spatialManager, heatmapProvider, backdropManager,
nameplateManager, treemapLabelManager, _tabIndex, minimapOverlay
**Intent:** Reset all per-load state so a new repo can load cleanly.
**Current shape:** Single method, 45 lines, touches 13 different
subsystems.
**Refactor note:** Each consumer should expose its own `reset()` and
listen for a `project:unmount` event. The viewer broadcasts; subsystems
react. Eliminates the inline knowledge of every subsystem.

### loadDiff
**File:** `app/GitHubRepoViewer.js:1808-1870`
**Bucket:** application
**Reaches into:** DiffController, diffPanel, registry, cameraController,
header, loading overlay
**Intent:** Load a PR as diff grids.
**Current shape:** Mirrors loadRepository pattern.
**Refactor note:** `DiffMount` cousin to `ProjectMount`. Both use a
common `MountKit` for grid registration + camera focus.

### updateFileTree + _buildTreeDOM + _countDescendants
**File:** `app/GitHubRepoViewer.js:1879-1993`
**Bucket:** chrome
**Reaches into:** hierarchicalManager.root, cameraController,
selectionManager, drawerController
**Intent:** Render the indented collapsible file tree in the Files
drawer panel.
**Current shape:** ~115 lines of recursive DOM building.
**Refactor note:** `FileTreePanel` widget that listens to
`tree:built` events from hierarchicalManager. The viewer doesn't own
the tree DOM.

### toggleDirectoryCollapse
**File:** `app/GitHubRepoViewer.js:1998-2011`
**Bucket:** application — bridges chrome event to substrate action
**Intent:** Click chevron → relayout 3D + rebuild tree UI.
**Refactor note:** Lives in HierarchicalLayout strategy after refactor;
the file tree panel emits collapse events.

### Stack interaction (raycasting hover/click)
**File:** `app/GitHubRepoViewer.js:2026-2123`
**Bucket:** application (the stack-specific behavior) + substrate
(raycasting plumbing)
**Reaches into:** THREE.Raycaster, stackManager, grids' `_background`
meshes, toastUI
**Intent:** Mouse over stack → fan-out; click pulled file → return;
click stacked file → pull.
**Current shape:** Direct raycast against grid backgrounds. Bypasses
EntityInputRouter entirely.
**Refactor note:** Bypass is a smell. After EntityInputRouter is
generalized, stack hover/click becomes a registered handler for `grid`
type when the active layout is stack. ~100 lines collapse.

### _createOverlays + _updateOverlays
**File:** `app/GitHubRepoViewer.js:2125-2258`
**Bucket:** application — wires backdrops/nameplates/treemap labels
**Reaches into:** BackdropManager, NameplateManager, TreemapLabelManager,
spiralManager (createSpiralGuide), minimapOverlay
**Intent:** Build the right overlay set for the active layout.
**Refactor note:** Overlays belong to each layout strategy:
`hierarchical` provides backdrops + nameplates, `spiral` provides
the guide line, `treemap` provides labels, `stack` provides nothing.
Move into the strategy modules.

### updateStats
**File:** `app/GitHubRepoViewer.js:2268-2300`
**Bucket:** chrome
**Intent:** Update FPS badge + drawer stats panel at 2 Hz.
**Refactor note:** `StatsPanel` widget that listens to a per-frame
event the substrate emits with `{ fps, gridCount, glyphCount, camera }`.

### animate (the render loop)
**File:** `app/GitHubRepoViewer.js:2304-2379`
**Bucket:** substrate (the loop) + application (the bolt-ons)
**Reaches into:** cameraController, spatialAnimator, statePersistence,
updateStats, handGestureAdapter, nameplateManager, _commandContext (for
window billboards), minimapOverlay, treemapLabelManager, gridVirtualizer,
connectionRenderer, pickingSystem
**Intent:** Per-frame tick: physics → state save → stats → optional
adapters → overlay updates → culling → picking → render.
**Current shape:** Inline calls to 11 subsystems in fixed order, plus the
pick-and-tint side-effect inline.
**Refactor note:** Substrate `Viewer3D.tick(dt)` runs a registered
`TickHandlers` list. Each subsystem registers itself with a priority.
Order becomes data, not code. The picking side-effect (hover tint) moves
out to `HoverHighlighter`. The 75-line method becomes ~10.

## Cross-cutting findings (pass 1)

1. **HomeShell already does the substrate boot cleanly.** Whatever
   `Viewer3D` extract we land has a known-good consumer to validate
   against. Use HomeShell as the test surface for the extract.

2. **"Selection state" is the leapfrog target the plan called out.**
   SelectionManager + `fileStateManager.selected` + `CodeColorManager`
   selection layer + `AttentionManager` + the `attention.key` /
   `attention.hover` semantics in shortcuts all reach into the same
   concept. The audit must surface AttentionManager's intent in pass
   13 to decide which becomes the primitive.

3. **Layout management is *the* concept this refactor pivots on.**
   Four layout managers + sceneContext mutation + relayoutGrids + the
   conditional inside _createOverlays + the dispatch inside
   loadRepository(× 2) all encode the same idea — strategy pattern
   waiting to happen. The home-page layout kit is unrelated (it's
   composition, not file-spatial layout); the IDE's are
   file-spatial. Both can coexist.

4. **`buildContext(viewer)` is the chokepoint.** Every handler reaches
   into the viewer through it. Until that bag is sliced, no handler is
   safely portable to HomeShell.

5. **DOM ownership is scattered.** The viewer hard-codes ~30 DOM ids.
   Each panel-as-widget refactor eliminates a handful. Total chrome
   delete from the viewer after the full cut: probably ~600 lines.

---

# Pass 2: `app/IDEShell.js` (1332 lines)

The DOM orchestrator. The whole file is **chrome** — sidebar, activity
bar, bottom panel, status bar, tab bar, command palette, search,
graph-panel iframe, resize observer, log capture. It "wraps around" the
viewer (its words) rather than owning it, but in practice reaches into
~14 viewer fields directly. After the refactor, this shell should
listen to events the substrate emits and own only DOM ownership +
layout.

### IDE chrome construction
**File:** `app/IDEShell.js:54-161`
**Bucket:** chrome
**Reaches into:** ~25 DOM ids, stateController, primaryMod
**Intent:** Set up VS Code-like layout — activity bar, sidebar
(collapsible/resizable), bottom panel (tabs), status bar; wire all the
mouse + touch + keyboard interactions for the chrome itself.
**Current shape:** Single constructor wires 8 subsystems
(_wireActivityBar, _wireSidebar, _wireSidebarBackdrop, _wireSidebarSwipeDismiss,
_wireBottomPanel, _wireKeyboardShortcuts, _wireResizeObserver,
_wireSidebarResize, _wireStatusBarClicks) and applies restored panel
state. ~75 lines of wiring.
**Refactor note:** Leave the chrome itself alone — it's the IDE's
unique value. The coupling to the viewer (next entries) is what we
extract.

### injectPanelContent
**File:** `app/IDEShell.js:171-228`
**Bucket:** chrome
**Reaches into:** Drawer.js, LogCapturePanel.js, DiffPanel.js,
InstallerPanel.js
**Intent:** Populate sidebar/bottom panels with HTML strings from
component modules so the viewer can find DOM ids when it wires
listeners.
**Current shape:** Hand-rolls hand-tracking panel inline. Otherwise
pulls HTML strings from `*PanelHTML()` factories.
**Refactor note:** Each panel should be its own component owning both
HTML and wiring (the GroupsPanel/StatePanel pattern). IDEShell registers
them: `shell.mountPanel('explorer', new ExplorerPanel(deps))`. The
hand-rolled hand-tracking HTML moves out.

### attachViewer + MutationObserver mirror
**File:** `app/IDEShell.js:234-275`
**Bucket:** chrome reaching into application (the worst kind)
**Reaches into:** viewer instance, `header-repo-label` DOM (created by
viewer), `titlebar-repo-label`, `_statusBranch`, file-selected event,
camera-focus-changed event
**Intent:** Mirror the viewer's repo label to the IDE titlebar; update
status branch from the parsed `@branch` part.
**Current shape:** Polls every 200ms for `header-repo-label` to appear,
then attaches a MutationObserver to mirror its text.
**Refactor note:** This is a compat hack — the viewer creates the
"wrong" header (built into the old Drawer UI) and the IDE has to
shadow-mirror it. After the panels refactor, repo state comes from a
`ProjectState` model emitting events; both the titlebar and the
(now-deleted) header subscribe.

### Tab bar — open/close/activate file tabs
**File:** `app/IDEShell.js:687-820`
**Bucket:** chrome — but the close/activate handlers reach into
substrate (SelectionManager, CameraController)
**Reaches into:** viewer.grids, viewer.cameraController.focusOnGrid,
viewer.selectionManager.select/deselect
**Intent:** Maintain a list of currently-open file tabs synchronized to
SelectionManager state.
**Current shape:** Listens to `file-selected` window event, adds new
selections to tab list, sets active tab to primary. Click tab →
re-select + focus camera. Close button → deselect from SelectionManager.
**Refactor note:** Pure chrome — only reaches in through three
documented verbs (select, deselect, focusOnGrid). After substrate
exposes a typed `SelectionAPI` and `CameraIntent`, this works
unchanged. Likely a clean lift.

### Command palette (Cmd+P)
**File:** `app/IDEShell.js:861-949`
**Bucket:** chrome
**Reaches into:** viewer.grids, viewer.cameraController.focusOnGrid,
viewer.selectionManager.select
**Intent:** Fuzzy-search files by path, jump camera + select on click.
**Current shape:** Direct array scan over `viewer.grids`. Element-clone
trick to clear old input listeners on each open.
**Refactor note:** Search target should be a `SearchProvider` interface
the substrate exposes (the same one Search panel uses below). The
clone-element listener-reset is a smell — owning the input element
properly would fix it.

### Sidebar search panel
**File:** `app/IDEShell.js:956-986`
**Bucket:** chrome
**Reaches into:** Same as palette
**Intent:** Same as palette but persistent in the sidebar.
**Current shape:** Identical scan logic to the palette.
**Refactor note:** Both consume the same `SearchProvider`. Reduces
duplication. After substrate has the provider, this is a 20-line widget.

### ResizeObserver → viewer.renderer
**File:** `app/IDEShell.js:993-1025`
**Bucket:** chrome computing substrate inputs
**Reaches into:** viewer.renderer.setSize/setPixelRatio,
viewer.camera.aspect
**Intent:** Keep the WebGL renderer sized to the dynamic #editor-area
container as panels resize.
**Current shape:** Standard ResizeObserver pattern, double-rAF debounced.
**Refactor note:** Should call a substrate verb
`viewer3D.setViewportSize(w, h)` that owns both renderer + camera +
pickingSystem + readerCompass.relayout. The current code touches
renderer + camera but misses pickingSystem (only the window-resize
handler in viewer.setupEventListeners covers that — bug latent if the
editor area resizes without window resize).

### updateStatusBar
**File:** `app/IDEShell.js:1035-1094`
**Bucket:** chrome
**Reaches into:** viewer.grids (each .getGlyphCount()), viewer.camera,
viewer._sourceMode, viewer._activeLayout, viewer._wsBridge
**Intent:** Update status-bar fields (fps, glyphs, grids, camera pos,
source, layout, WS) at 2 Hz.
**Current shape:** Same throttle pattern as viewer.updateStats; the two
methods duplicate each other (viewer writes to legacy `#stat-fps`, shell
writes to `#status-fps`).
**Refactor note:** Once viewer.updateStats is replaced by a `StatsPanel`
component, IDEShell drops this and the panel listens to a substrate
`tick:stats` event. The double-update goes away.

### _hideOldUI (MutationObserver to hide viewer-created widgets)
**File:** `app/IDEShell.js:1101-1142`
**Bucket:** chrome — explicit compat hack
**Reaches into:** drawer-toggle, drawer-scrim, drawer, header,
fps-badge, state-reset-btn, ws-status-bar (DOM ids created by viewer
or WebSocketBridge)
**Intent:** Hide the legacy Drawer/header/fps-badge that the viewer
creates in init() so they don't conflict with the IDE shell's own UI.
**Current shape:** MutationObserver on document.body that style-hides
each id as it appears, plus a 100ms fallback pass.
**Refactor note:** **This is the "compat shim" anti-pattern.** It exists
because GitHubRepoViewer creates its own UI even when wrapped by IDEShell.
After viewer's chrome is moved out (panels-as-widgets refactor), this
method dies entirely. Cleanest signal that the refactor is working: this
method becomes empty.

### Graph iframe panel + cross-frame relay
**File:** `app/IDEShell.js:362-431`
**Bucket:** chrome
**Reaches into:** graph-frame DOM, postMessage from external page
**Intent:** Embed an external nodegraph page in the editor area, mirror
its connection state into the IDE status bar.
**Current shape:** Lazy-mount on first activation. window.message
listener filters by `msg.source === 'nodegraph'`. Origin not asserted.
**Refactor note:** Self-contained. Probably fine as is. Note that origin
laxness is intentional (substrate may bind to LAN/alternate ports).

### initWsLog / _makeLogLine
**File:** `app/IDEShell.js:1170-1203`
**Bucket:** chrome — listens to substrate
**Reaches into:** bridge.getLog(), bridge.onLog()
**Intent:** Stream WebSocketBridge JSON-RPC log into the ws-log panel.
**Current shape:** Hand-styled with inline CSS in the line builder.
**Refactor note:** Belongs in a `WSLogPanel` widget consuming the
bridge. The bridge is already substrate-quality; this widget can sit
next to the LogCapturePanel.

### Drawer-compat shim (openToTab/switchTab/addPanel/getPanel/setOpen/asDrawer)
**File:** `app/IDEShell.js:1215-1331`
**Bucket:** **explicit compat shim** — violates
[[feedback-no-compat-shims]] and [[feedback-no-aliases-atomic-renames]]
**Reaches into:** Maps old Drawer panel IDs to sidebar/bottom-panel IDs;
exposes a fake DrawerController API on IDEShell itself.
**Intent:** Let GitHubRepoViewer call `this.drawer.openToTab('files')`
unchanged even when the drawer is actually the IDE shell.
**Current shape:** 5 compat methods + an `asDrawer()` that returns
`this`. Includes hardcoded id mapping table.
**Refactor note:** **Delete entirely once viewer's chrome moves out.**
The viewer should not be calling a drawer at all — panels own
themselves. This is the most visible evidence of incomplete separation;
removing it will be a clean signal.

## Cross-cutting findings (pass 2)

1. **IDEShell reaches into viewer fields directly ~25 times.** Specifically:
   `viewer._sourceMode`, `viewer._activeLayout`, `viewer._wsBridge`,
   `viewer.grids`, `viewer.camera`, `viewer.renderer`, `viewer.cameraController`,
   `viewer.selectionManager`. Until those become substrate-event-driven,
   IDEShell can't move.

2. **Two parallel update loops** — viewer.updateStats writes to legacy
   ids (`#stat-fps`, `#file-count`, `#grid-count`, `#glyph-count`,
   `#camera-pos`); IDEShell.updateStatusBar writes to IDE ids
   (`#status-fps`, `#status-glyph-count`, etc). Both throttle to 2 Hz,
   both walk all grids for glyph count. After consolidation: one tick
   event, one panel subscriber.

3. **Three compat hatches exposing the seam:** `_hideOldUI` (hides
   viewer-created widgets), `MutationObserver` (mirrors viewer-created
   header text), drawer API shim (impersonates DrawerController). All
   three die together when the panels move out.

4. **Search and command palette duplicate** — same filter, same focus
   target, same DOM-population pattern. Should consume one
   `SearchProvider`.

5. **ResizeObserver bug latent** — IDEShell's resize doesn't call
   `pickingSystem.onResize()` or `readerCompass.relayout()` like the
   viewer's window-resize does. Probably an existing latent issue
   when the user drags the panel resize handle.

---

# Pass 3: `app/commands/` (index.js + 24 handler modules)

The command surface is the **bag-is-the-coupling** zone called out in
the plan. Handlers are largely clean: each one takes `(args, ctx)` and
returns `{ text, data }`. The chokepoint is what's *in* `ctx` and
whose subsystems mutate it.

### buildContext — the chokepoint
**File:** `app/commands/index.js:28-142`
**Bucket:** application — assembles the context bag
**Reaches into:** Every interesting field on `GitHubRepoViewer`
**Intent:** Hand every command handler the things it could possibly
need to act on the scene, with stable cross-handler conventions
(`ctx.getGrids`, `ctx.addGrid`, `ctx.removeGrid`).
**Current shape:** Single function. Bag exposes:
- core: `scene, camera, renderer, atlas`
- registry: `registry, getGrids, addGrid, removeGrid`
- subsystems: `cameraController, selectionManager, fileStateManager,
  codeColorManager, spatialManager, windowManager` (last one populated
  later)
- layout: `getActiveLayout()`, `layoutManagers` (all four by name)
- transport: `wsbridge` (filled after creation)
- *runtime state*: `annotations: Map`, `gridVisualState: Map`,
  `_cancelCameraAnimation`, `spatialNav` (set externally),
  `mode: { state }`, `attentionManager`, `attention` getter
**Refactor note:** This is the **single most leveraged refactor cut.**
Replace the one-bag with a **substrate context** (the first 7 fields)
plus an **application extension** that adds the manager refs. Handlers
declare their slice:
```js
router.register('camera.move', (args, { camera }) => { ... });
router.register('attention.set', (args, { attentionManager, registry }) => { ... });
```
The `annotations` and `gridVisualState` Maps must move off the bag —
they're owned by the annotation subsystem and the highlight subsystem.
`mode: { state }` becomes a tiny `Mode` service with `change:` events.

### registerAllCommands — 24 modules wired in order
**File:** `app/commands/handlers/index.js`
**Bucket:** application — wiring
**Intent:** Hand the router to every command module so it can `register`
its verbs. Modules: system, camera, grid, scene, select, layout, search,
agentLayout, annotation, spatial, composition, navigation, window,
orchestration, registry, terminal, highlight, tour, group, simulate,
mode, file, attention, edit.
**Current shape:** Flat list of imports + flat list of register calls.
**Refactor note:** Stays this shape. Maybe organize into namespaces
(`substrate/`, `application/`) once handlers declare which slice they
need — then app skips registering modules whose deps aren't present
(e.g. running the substrate alone with no `spatialManager` would skip
`groupCommands`).

### camera.* handlers
**File:** `app/commands/handlers/cameraCommands.js` (197 lines)
**Bucket:** substrate consumers — clean
**Reach in to:** `ctx.camera, ctx.cameraController, ctx.spatialNav`
**Verbs:** move, lookat, focus, reset, speed, info, fitall, aim,
attend, pivot, sim (zoom/orbit/pan).
**Findings:**
- `camera.focus` triple-resolves (registry id → numeric index →
  filename substring). The fallback to substring is application
  ergonomics; substrate verb would only take id.
- `camera.attend` routes through `attentionManager.set('primary', id)`
  — confirms AttentionManager *is* the single writer for primary.
- `camera.sim` exposes internals (`_zoomBy`, `_orbitBy`, `_panBy`,
  `_applyRotation`) — used by llm-exp for sim loops. Leak of substrate
  internals but justified.
**Refactor note:** Already lean. After slicing the bag, this module
needs `{ camera, cameraController, spatialNav, attentionManager,
registry }` — five fields.

### grid.* handlers
**File:** `app/commands/handlers/gridCommands.js` (239 lines)
**Bucket:** substrate consumers
**Reach in to:** `ctx.registry, ctx.scene, ctx.atlas, ctx.getGrids,
ctx.addGrid, ctx.removeGrid, ctx.attentionManager`
**Verbs:** list, info, color, visibility, create, remove, text,
position, rotation, scale.
**Findings:**
- `grid.create` does new CodeGrid + register + add-to-scene +
  optional primary attention set. The deepest substrate touchpoint —
  needs scene + atlas + registry.
- Path-shaped names auto-populate `userData.sourcePath` so file.save
  works out of the box. Quiet convenience that depends on a CodeGrid
  convention.
**Refactor note:** This is the module that will most reveal whether
the substrate slice is right: it touches the addressable-object
boundary. Likely the test case for the slice extract.

### highlight.* handlers
**File:** `app/commands/handlers/highlightCommands.js` (304 lines)
**Bucket:** substrate consumers
**Reach in to:** `ctx.getGrids` + grid.* methods
**Verbs:** glyph, range, lines, token, clear.
**Findings:**
- `highlight.token` re-implements visible-char counting inline
  (counts non-skip-codes 9/10/13/32). This is **exactly the
  `getVisibleCharCount` vs `_emptyGlyphs` mismatch** flagged in
  [[project-nbsp-highlight-mismatch]] — two implementations of the
  same concept. NBSP latency lives here.
- The `findGrid` helper here adds a `sourcePath.endsWith(arg)`
  fallback that `resolveGridByIdOrIndex` doesn't — application-layer
  resolution policy diverging from the canonical helper.
**Refactor note:** Substrate needs a canonical `CodeGrid.charPositionToSlot()`
or `CodeGrid.tokenLocations(pattern)` so handlers don't reproduce visible-
char math. Resolution helpers should converge — one `resolveGrid` with
declared fallback chain.

### spatial.* handlers
**File:** `app/commands/handlers/spatialCommands.js` (244 lines)
**Bucket:** **pure substrate consumer** — best-shaped module
**Reach in to:** `ctx.getGrids` + shared spatialHelpers
**Verbs:** grid.bounds, grid.bounds.union, grid.anchor, grid.distance,
grid.overlap.
**Findings:** All geometry. No subsystem dependency beyond grid access.
**Refactor note:** Leave alone. This is the **shape every command
module should converge on**: take a substrate slice + helpers, return
`{ text, data }`. Use as the reference.

### attention.* handlers
**File:** `app/commands/handlers/attentionCommands.js` (126 lines)
**Bucket:** substrate consumer
**Reach in to:** `ctx.attentionManager, ctx.registry`
**Verbs:** set, info, clear.
**Findings:**
- File-header docstring explicitly notes this verb-surface is the
  **replacement for the parallel raycaster** at ide.html:303-336 that
  used to write `commandBar.setTarget(termId)` directly. The
  AttentionManager is the merged single-writer.
- Confirms the cross-cutting "selection is fragmented" finding —
  AttentionManager already won the consolidation pass for primary/hover/key.
- `hover|primary|key` slots are the right vocabulary for the
  unified selection primitive.
**Refactor note:** This *is* the leapfrog target's current state.
SelectionManager + `fileStateManager.selected` are still parallel; the
plan should be to migrate those onto AttentionManager too. Selection
becomes "primary slot held over time" + a tagged set of secondary slots
("selected").

### edit.* handlers
**File:** `app/commands/handlers/editCommands.js` (110 lines)
**Bucket:** substrate consumer
**Reach in to:** `ctx.attentionManager, ctx.registry, ctx.attention`,
grid.enterEdit/exitEdit/getCursor
**Verbs:** start, stop, info.
**Findings:** Edit lifecycle is **already** routed through
attention.key — `edit.start` sets the slot, the keystroke router
delivers, the change:key listener fires exitEdit on the prior grid.
Confirms attention is the right central nervous system.
**Refactor note:** Already lean. Leave alone.

### _installEntityKeystrokeDelivery (the hidden substrate)
**File:** `app/commands/index.js:222-361`
**Bucket:** **substrate masquerading as application**
**Reaches into:** `document.keydown` (capture), `ctx.attentionManager`,
entity.grid methods
**Intent:** One document-level keydown that reads `attention.key`,
looks up a per-type handler (terminal | grid), and delivers. Terminal
translates to ANSI; grid maps to L2 M1 edit ops.
**Current shape:** Inline in command-center init. ~140 lines of pure
key→entity dispatch logic. No DOM dependence beyond `document` +
`activeElement` guard for form inputs.
**Refactor note:** Promote to `src/services/interaction/EntityKeystrokeRouter.js`.
Per-type handlers register themselves (`router.registerHandler('terminal', fn)`).
HomeShell can then make any 3D object editable for free. Currently
~140 lines locked away in an app-level module.

### _installConsoleForwarder
**File:** `app/commands/index.js:155-189`
**Bucket:** substrate (debug plumbing)
**Intent:** Patch console.log/warn/error to forward to relay as
`{event:'browser.log', level, text}`. CLI users see live browser logs.
**Current shape:** Inline.
**Refactor note:** HomeShell hand-rolls its own version. Promote to
`src/services/orchestration/ConsoleForwarder.js`. Same substrate, two
shells consume.

### _refreshGridForPath (livereload echo handler)
**File:** `app/commands/index.js:377-408`
**Bucket:** substrate
**Reaches into:** registry, bridge.rpcRequest('fs/readFile'),
grid.loadText
**Intent:** When the relay reports a file changed (event 'write'),
re-fetch via fs/readFile, hash, and reload the matching grid in place
unless the hash matches our last save (echo skip).
**Current shape:** ~30 lines using `Object.defineProperty` to stash
`_savedTextHash` non-enumerably.
**Refactor note:** Belongs in a `FilesystemSync` substrate service that
listens to `fs/didChange` and dispatches. The contentHash dependency
points back at fileCommands.js — confirms the substrate slice needs
content-hashing too.

### fs/didChange routing
**File:** `app/commands/index.js:474-487`
**Bucket:** substrate plumbing inline
**Intent:** Discriminate `event:'change'` (livereload → page reload)
from `event:'write'` (refresh affected grid).
**Refactor note:** Same FilesystemSync owner as above.

## Cross-cutting findings (pass 3)

1. **The context bag has three distinct populations that should be
   three different slices:**
   - **Substrate slice** — `scene, camera, renderer, atlas, registry,
     wsbridge, attentionManager, cameraController, getGrids,
     addGrid, removeGrid`. ~9 things. Most handlers only touch this.
   - **Application slice** — `selectionManager, fileStateManager,
     codeColorManager, spatialManager, layoutManagers,
     getActiveLayout`. The IDE-specific extension.
   - **Runtime state** that doesn't belong on a context at all —
     `annotations: Map`, `gridVisualState: Map`,
     `_cancelCameraAnimation`. Own these in their respective subsystems
     and inject when needed.

2. **AttentionManager is already the consolidated selection
   primitive.** It owns hover/primary/key slots, emits change events,
   is the single writer used by reader-mode + camera.attend + edit +
   compass + canvas click. The leapfrog the plan called out is *already
   half-done*; the remaining merge is `SelectionManager` and
   `fileStateManager.selected` (the per-file "selected" boolean used
   to drive teal tint).

3. **Two substrate services are hiding in app/commands/index.js**
   that HomeShell duplicates inline. Promote them and HomeShell drops
   ~50 lines:
   - `EntityKeystrokeRouter` (140 lines)
   - `ConsoleForwarder` (30 lines)
   - `FilesystemSync` (40 lines + the dispatch chunk)

4. **Substring/path fallback resolution is unsystematized.** Three
   different resolvers (`resolveGridByIdOrIndex`, `findGrid` in
   highlight, the camera.focus inline triple-fall). Substrate needs
   one `resolveGrid(ctx, term, opts)` with a declared fallback chain.

5. **NBSP highlight mismatch root cause is here.** highlightCommands
   re-implements visible-char counting (skip codes 9/10/13/32) while
   CodeGrid uses different rules. The fix is a single substrate verb
   on CodeGrid that handlers consume instead of re-counting.

6. **The handler shape is already correct** — `(args, ctx) → { text,
   data }`. Most handlers reach into 2-5 ctx fields. The bag's
   permissiveness is what's harmful; the call shape is fine.

---

# Pass 4: `app/components/*.js` (10 files, 2407 lines)

A surprisingly clean layer — most components are **already passive
widgets** with constructor-injected deps and an event-driven refresh
pattern. The friction is concentrated in two files (Drawer.js and
AppShell.js) which represent the *old* UI the IDE shell hides, plus a
substrate-quality piece (SpatialNavigator) misfiled here.

### AppShell — static factories (header, loading, fpsBadge, toast)
**File:** `app/components/AppShell.js` (105 lines)
**Bucket:** chrome
**Reaches into:** DOM only
**Intent:** Build small shared UI bits the viewer creates at init.
**Findings:** Two of the four (`header`, `fpsBadge`) are *exactly* the
elements IDEShell's `_hideOldUI` MutationObserver kills on sight. They
exist only because GitHubRepoViewer creates them unconditionally.
**Refactor note:** After the panels move out, the viewer stops creating
header+fpsBadge. They die. The remaining factories (`createLoadingOverlay`,
`createToast`) are utility widgets either shell can mount — keep them,
maybe rename file to `Overlays.js`.

### CommandBar — 28px IDE input
**File:** `app/components/CommandBar.js` (508 lines)
**Bucket:** substrate-quality chrome
**Reaches into:** router, cameraController (gates), ctx.terminals,
ctx.attentionManager, ctx.registry
**Intent:** Single-line `:CMD` / `>termId` input with history, tab
completion, terminal targeting via attention.primary subscription.
**Findings:**
- **Already a consumer of attention.primary, not a writer.** Subscribes
  via `am.on('change:primary', ...)` and flips badge/highlight in
  response. Mirrors the architecture pass 3 called for.
- Tracks terminal background via direct material mutation
  (`grid._background.material.color`); stashes original color on the
  mesh itself (`_cmdBarOrigColor` property). Substrate would prefer a
  declared "focus tint" layer through CodeColorManager.
- Camera-gating via `_cameraCtrl._cmdBarPrevEnabled` stash. Same
  ergonomic as ShortcutManager's editor-focus dance. Both should
  go through a unified `InputContext.acquireFocus()` API.
**Refactor note:** Substrate-quality. The home page has a different
variant (`HomeCommandBar.js` — multiline textarea, scrollable history).
Candidate cut #5 from the plan: one bar with two skins (single-line
input + multiline textarea), both subscribing to the same attention
+ router.

### Drawer — the old (now hidden) UI + panel HTML factories
**File:** `app/components/Drawer.js` (470 lines)
**Bucket:** **dead/zombie chrome** + chrome HTML factories
**Reaches into:** DOM, '#canvas' raycast for scrim
**Findings:**
- `DrawerController` builds the slide-out drawer. IDEShell hides it at
  startup via `_hideOldUI`. The viewer still constructs it.
- Panel HTML factories (`repoPanelHTML, filesPanelHTML, settingsPanelHTML,
  statsPanelHTML, controlsPanelHTML`) **are used by both** shells —
  IDEShell.injectPanelContent imports them.
**Refactor note:** Split: panel HTML factories live, DrawerController
dies. Two separate files: `panels/{repo,files,settings,stats,controls}.js`
or keep them barrel-exported as a single `panels.js`. This is one of the
fastest concrete wins — kill ~280 lines of dead code.

### DiffPanel — clean callback widget
**File:** `app/components/DiffPanel.js` (125 lines)
**Bucket:** chrome
**Reaches into:** DOM only; callback API for `onLoadPR` / `onFileClick`
**Findings:** Pure widget pattern. HTML factory + `initDiffPanel`
returning method handles. No viewer reach-in.
**Refactor note:** This is the **target shape every panel should
converge on**. Use as the reference. No changes.

### GroupsPanel — spatialManager + animator + camera
**File:** `app/components/GroupsPanel.js` (326 lines)
**Bucket:** chrome — but reaches into substrate math
**Reaches into:** spatialManager, registry, animator, camera
**Intent:** Live cards for each window group; minimap canvas per card
with click-to-focus; layout-mode buttons; dissolve.
**Findings:**
- 500ms polling (`setInterval`) instead of event subscription.
  spatialManager doesn't emit change events yet — that's the substrate
  gap, not the panel's fault.
- **Duplicates camera-fit math.** `focusOnGroup` inlines the same
  `_zDistanceForFit` calculation that lives in ViewerCameraController.
  Two implementations of "fit this bounding box."
- Minimap rendering uses uniform-scale world→canvas transform — same
  algorithm as MinimapOverlay. Third implementation of the same math.
**Refactor note:**
- spatialManager needs `on('change', ...)` so polling dies.
- `cameraController.focusOnUnion(memberIds)` substrate verb so the
  panel doesn't redo the math.
- Minimap rendering should go through a shared
  `WorldToCanvasProjection` helper used by MinimapOverlay too.

### InstallerPanel — static OS detection + copy buttons
**File:** `app/components/InstallerPanel.js` (190 lines)
**Bucket:** chrome
**Reaches into:** navigator.userAgent/userAgentData/clipboard
**Findings:** Pure presentation. No coupling to anything else. Has its
own `detectPlatform` (parallel to `VisitorIntrospect.js` in home page).
**Refactor note:** Both shells could share OS detection — move
`detectPlatform` to `src/services/visitor/platformDetect.js`. ~25 lines
saved.

### LogCapturePanel — wraps src/utils logCapture
**File:** `app/components/LogCapturePanel.js` (133 lines)
**Bucket:** chrome
**Reaches into:** `src/utils/LogCapture.js` (substrate)
**Findings:** Clean. Setinterval polls the singleton while capturing.
**Refactor note:** logCapture could emit `change` events instead of
being polled, but the cost is marginal. Leave alone.

### SpatialNavigator — **substrate misfiled here**
**File:** `app/components/SpatialNavigator.js` (276 lines)
**Bucket:** **substrate** (currently in components/)
**Reaches into:** getGrids, cameraController, status element
**Intent:** vim-style grid-to-grid navigation (h/j/k/l + arrows), with
cone-based directional nearest-neighbor. Focus index + mode state
(`grid`/`line`). Document-level keydown listener with `_isInputFocused`
guard.
**Findings:**
- No DOM ownership beyond an optional status element. Pure scene-graph
  navigation.
- Owns its own document-keydown listener — competes with ShortcutManager
  (which also has h/j/k/l-adjacent bindings). Today they don't conflict
  because ShortcutManager doesn't bind those keys, but the layered
  listener model is fragile.
- Implements its own nearest-neighbor cone search. This is
  substrate-quality logic that the IDE keymap should consume, not own.
**Refactor note:** Move to `src/services/interaction/SpatialNavigator.js`.
The keydown listener should register handlers via ShortcutManager (or
its successor) so there's one keystroke source of truth. Likely tied to
[[project-spatial-navigation]].

### StatePanel — clean storage inspector
**File:** `app/components/StatePanel.js` (155 lines)
**Bucket:** chrome
**Reaches into:** stateController, STATE_DEFAULTS, localStorage
**Findings:** Listens to `storage` + `state-changed` events for
refresh. Two-click confirm pattern for "clear all". Export/import
to JSON. Clean.
**Refactor note:** Reference shape for event-driven widgets. Leave
alone.

### TouchController — **substrate-quality but reaches into private VCC**
**File:** `app/components/TouchController.js` (119 lines)
**Bucket:** substrate-shaped, currently sibling to chrome
**Reaches into:** `cameraController._applyDragTranslation`,
`_zoomBy`, `input.focus.{clientX,clientY}` — **all underscored**.
**Intent:** Touch input pipeline: single-finger pan, two-finger pan +
pinch zoom, centroid feed into focus probe.
**Findings:**
- Reaches into ViewerCameraController's underscore-prefixed private
  methods. Substrate boundary violation — touch input is its own
  legitimate concern and shouldn't need to spelunk into "private"
  internals.
- Already symmetric with mouse drag/wheel; the underlying
  `_applyDragTranslation` is what mouse drag also calls. Symmetry
  is correct; the access modifier is wrong.
**Refactor note:** Two options:
1. Promote `_applyDragTranslation`, `_zoomBy`, etc. to public on
   ViewerCameraController and rename without underscores.
2. Or merge TouchController and the mouse-side listeners into a
   unified `InputPipeline` owned by VCC.
Pick (2). VCC should own all input types and expose a single intent API
(`InputIntent.dragPan(dx,dy) / .dollyZoom(dy) / .orbit(dx,dy)`). Touch
becomes a registered source.

## Cross-cutting findings (pass 4)

1. **Two passive-widget reference shapes already exist** — DiffPanel
   (callback-based) and StatePanel (event-listener-based). Use those as
   the targets when refactoring GroupsPanel, the not-yet-existing
   FileTreePanel, RepoLoadPanel, etc.

2. **Math duplication is the second-largest tax in this layer.**
   Camera-fit math lives in: ViewerCameraController, GroupsPanel,
   IDEShell command palette path, the inline diff/grid focus calls.
   Minimap rendering lives in: MinimapOverlay, GroupsPanel.
   Both want substrate helpers (`fitBoundsToCamera`, `worldToMinimap`).

3. **Three files are misclassified in `app/components/`:**
   - `CommandBar.js` — substrate-quality, should sit next to
     `HomeCommandBar.js` as variants of one primitive.
   - `SpatialNavigator.js` — substrate, belongs in
     `src/services/interaction/`.
   - `TouchController.js` — substrate, belongs in
     `src/services/camera/` (or wherever the unified input pipeline
     lands).

4. **`Drawer.js` is the most fertile delete.** ~280 lines of dead
   slide-out drawer. Panel HTML factories survive elsewhere. The
   `_hideOldUI` MutationObserver in IDEShell becomes empty as part
   of the same cut.

5. **Polling vs events is the substrate gap exposed here.**
   GroupsPanel polls spatialManager every 500ms; LogCapturePanel polls
   when capturing. Both want `on('change', ...)` on their data source.
   Pattern: substrate adopts an `EventEmitter` mixin (or matches the
   AttentionManager pattern of explicit `on('change:key', ...)`)
   uniformly across managers.

6. **AttentionManager subscription pattern is the right model** —
   CommandBar already uses it correctly. Use this as the contract every
   other consumer adopts. SelectionManager should expose
   `on('change', cb)`; FileStateManager too; layout managers when grids
   shift.

---

# Pass 5: `app/ide.html` (451 lines)

Roughly half DOM scaffold, half **bootstrap script that does more than
a bootstrap should** — including two monkey-patches that papers over
the viewer/IDE separation gap.

### DOM scaffold (titlebar, activity bar, sidebar slots, editor column, bottom panel, status bar)
**File:** `app/ide.html:11-238`
**Bucket:** chrome
**Findings:**
- CSS-grid skeleton with named regions. Each sidebar panel has a `<div
  id="sp-<name>">` slot the bootstrap or IDEShell fills.
- The graph activity is special — clicking it adds `.view-graph` to
  `#editor-area` so CSS swaps canvas ↔ iframe.
- Inline graph panel HTML (~30 lines) is the only inline panel —
  everything else loads HTML from a JS factory.
**Refactor note:** Move the inline graph panel HTML out to
`app/components/panels/graph.js` matching the others. Otherwise this
is correct — minimal scaffolding for the IDE.

### Importmap
**File:** `app/ide.html:241-247`
**Bucket:** substrate boot
**Intent:** Pin three.js to a stable CDN version (0.183.0).
**Refactor note:** Both shells need this. Move to a shared
`importmap.html` partial, or accept duplication (it's 6 lines).

### Bootstrap script — 200 lines of orchestration
**File:** `app/ide.html:248-449`
**Bucket:** **mixed — should be application-layer module, not inline**
**Imports:**
- `THREE` (substrate)
- `GitHubRepoViewer` (application)
- `DrawerController` — **dead import; never used**
- `IDEShell` (chrome orchestrator)
- `CommandBar` (substrate-quality chrome)
- `stateController` (substrate state)

**Sequence:**
1. Create `IDEShell` first so DOM is shaped for the viewer.
2. `ide.injectPanelContent()` — fills sidebar/bottom-panel slots.
3. Create `GitHubRepoViewer(canvas, THREE)`; expose `window._viewer`.
4. `ide.attachViewer(viewer)` — installs the mirror MutationObserver +
   the `_hideOldUI` observer.
5. **Monkey-patch #1**: wrap `viewer.init` so that after the original
   finishes, set `viewer.drawer = ide.asDrawer()`. (Lines 279-288.)
6. **Monkey-patch #2**: wrap `viewer.updateStats` so it also calls
   `ide.updateStatusBar(deltaTime)`. (Lines 291-295.)
7. `await viewer.init()`.
8. Post-init wiring (concentrated outside both classes here):
   - GroupsPanel — dynamic import + manual mount with spatialManager
   - WS log panel — only if `viewer._wsBridge` exists
   - State inspector panel — dynamic import + mount
   - CommandBar construction + mount under `#editor-column`
   - SpatialNavigator construction + assignment to
     `router.context.spatialNav`
   - Click-to-attention listener on canvas (~25 lines)
   - `ide._onEditorResize()` initial resize
   - `ide.start()` (search wiring + log capture init + graph panel)
9. URL auto-load: `/ide/owner/repo[/branch/path]` → repo input + auto
   `loadRepository()`. Skipped if `repo.loadingInProgress` flag is true
   (crash guard).

**Findings — concerns inline:**

#### Bootstrap orchestration (substrate vs application vs chrome)
**File:** `app/ide.html:256-448`
**Bucket:** application — but inline in HTML
**Intent:** Connect substrate + application + chrome together at boot.
**Current shape:** 200 lines inside a `DOMContentLoaded` handler.
**Refactor note:** Move to `app/IDEBootstrap.js`. HTML becomes
`<script type="module" src="IDEBootstrap.js"></script>`. Same shape
HomeShell.js already follows for the home page. After substrate
refactor: bootstrap becomes 30 lines.

#### Monkey-patch: viewer.init → assigns viewer.drawer
**File:** `app/ide.html:279-288`
**Bucket:** **explicit compat hatch**
**Intent:** After viewer constructs its real `DrawerController`,
replace `viewer.drawer` with `ide.asDrawer()` so subsequent
`viewer.drawer.openToTab(...)` calls route to the IDE shell.
**Findings:** The viewer's own init creates DrawerController, appends
it to the DOM, then `_hideOldUI` hides those DOM nodes, then this patch
swaps the JS reference. **Three layers of compat for the same problem**:
viewer creates wrong widget → IDE hides DOM → bootstrap swaps reference.
**Refactor note:** Single-stroke fix: viewer stops creating
DrawerController. All three layers die together.

#### Monkey-patch: viewer.updateStats → ide.updateStatusBar
**File:** `app/ide.html:291-295`
**Bucket:** compat hatch
**Intent:** Both stat-display systems get fed.
**Findings:** Confirms the double-tick from pass 2. Viewer's
updateStats walks all grids for glyph count; ide.updateStatusBar walks
all grids for glyph count again. Two grid-iterations per render frame
just to update DOM.
**Refactor note:** Substrate emits one `tick:stats` event with
`{fps, glyphCount, gridCount, camera}`; subscribers consume. One pass,
not two.

#### Click-to-attention canvas listener
**File:** `app/ide.html:360-387`
**Bucket:** **application logic stranded in bootstrap**
**Intent:** Canvas click → raycast via EntityInputRouter → set
`attention.primary` to the hit's registryId. If hit is a terminal,
also set `attention.key` so typing routes immediately.
**Findings:**
- 25 lines of attention-routing logic outside any class.
- Comment explicitly notes this *replaces* the old parallel raycaster
  that did `commandBar.setTarget(termId)` — L1-A sweep finished.
- The "if not hit, clear both slots" branch is right but it conflicts
  with the existing `canvas-click` event the EntityInputRouter
  dispatches (which GitHubRepoViewer.init also wires to selectionManager).
  Two listeners on the same `click` event doing related but different
  things.
**Refactor note:** Move into `EntityInputRouter` as a default `click`
handler. Or into a dedicated `AttentionClickAdapter` substrate service.
Either way: out of the bootstrap.

#### URL auto-load
**File:** `app/ide.html:399-447`
**Bucket:** application
**Intent:** Read `?repo=owner/repo&branch=x` or `/ide/owner/repo/branch`
path; populate repo input; call `viewer.loadRepository()` after a 300ms
delay; gate on the OOM crash flag.
**Findings:**
- The path-parse regex excludes `/ide/app/` so the IDE's own URL
  doesn't get mistaken for a repo path (the bug the latest commit
  `faf1967` fixed).
- 300ms delay is the kind of magic number that papers over a race
  between bootstrap finishing and the viewer being ready to accept a
  load. With substrate emitting `ready` events, this disappears.
**Refactor note:** Belongs in `IDEBootstrap.js` as a `URLRouter`
helper. Or in a substrate `ProjectMount` that accepts a source spec
including URL parameters. The 300ms hack dies.

### Dead import: DrawerController
**File:** `app/ide.html:251`
**Bucket:** dead code
**Refactor note:** Delete the import line. Caught here only because the
audit is reading in full.

## Cross-cutting findings (pass 5)

1. **The compat hatch trinity is now fully mapped:**
   - `IDEShell.asDrawer()` shim impersonates DrawerController API
   - `IDEShell._hideOldUI` MutationObserver hides DOM the viewer creates
   - `ide.html` monkey-patches `viewer.init` to swap `viewer.drawer`
   All three exist for one reason: GitHubRepoViewer creates UI it
   shouldn't. Removing that creation kills all three.

2. **The bootstrap is the second-most coupling-rich file after the
   viewer itself.** It dynamically imports five panels, monkey-patches
   two methods, wires click-to-attention manually, hand-routes URL
   params. A real IDEBootstrap.js module would express these as
   ordered phases. The substrate refactor's east face.

3. **Click events are a contested resource.** EntityInputRouter
   dispatches `canvas-click` → GitHubRepoViewer.init handler →
   selectionManager.handleClick. Separately, ide.html attaches a
   `click` listener doing attention routing. ReaderCompass attaches a
   capture-phase `mousedown`. ShortcutManager listens elsewhere.
   This is the input-priority problem from pass 1. The unified
   `EntityInputRouter` (with registered handlers per type + priority)
   is the answer.

4. **CommandBar + SpatialNavigator both get constructed here**, not in
   IDEShell or GitHubRepoViewer. That's actually *correct* — they're
   IDE-application-layer composers of substrate pieces, and the
   bootstrap is the right home until we have a proper IDE-application
   module. But neither belongs in `app/components/`; both should be
   `app/<feature>/CommandBar.js`, `app/<feature>/SpatialNavigator.js`
   once the layer naming is set.

5. **The 300ms setTimeout is a smell** — covers an implicit "is
   everything ready?" question that should be answered by an explicit
   `ready` event from the substrate boot. Pattern repeats across the
   codebase (the `setInterval(checkHeader, 200)` in IDEShell's
   attachViewer is the same shape).

---

# Pass 6: `src/services/orchestration/{CommandRouter,WebSocketBridge}.js`

Both substrate-quality with one specific exception: WebSocketBridge
self-installs a chrome widget (`#ws-status-bar`) that IDEShell then has
to hide. Otherwise both files are clean.

### CommandRouter
**File:** `src/services/orchestration/CommandRouter.js` (225 lines)
**Bucket:** **substrate** — keep as is
**Surface:** `register / registerAll / use / parse / execute /
executeBatch / listCommands / listNamespace`
**Findings:**
- Shell-flavored parser handles double-quote strings, backslash
  escapes, `\n`/`\t` literals.
- Partial-match autocomplete: an ambiguous prefix returns the match
  list as data so the caller can paint a menu.
- Middleware is a flat list of pre-execute hooks. Used today for the
  `[cmd]` debug log line.
- Handlers receive `(args, ctx)`; the router writes `ctx.sender =
  options.sender` on every call (line 211-212) — **shared mutation
  across overlapping handlers**. Pragmatic. Mild smell because nothing
  prevents an async handler that reads `ctx.sender` later from seeing
  a different sender's value if another command lands in between.
- Returns are normalized: string → `{text:str, data:null}`; null → OK
  default; thrown error → `{text:'ERR: ...'}`.
**Refactor note:** Three small wins available:
1. Promote `ctx.sender` to a third positional arg `(args, ctx, meta)`
   where `meta = {sender, raw}` — kills the shared-mutation gotcha.
2. `use()` could accept after-hooks too (post-execute middleware) —
   useful for log fan-out, but only if a use-case appears.
3. Consider an `unregister(name)` method for hot-reload. Not blocking.
Otherwise, **leave alone.** This is what a 200-line clean substrate
piece looks like.

### WebSocketBridge — substrate + embedded chrome
**File:** `src/services/orchestration/WebSocketBridge.js` (529 lines)
**Bucket:** **substrate (350 lines)** + **chrome (80 lines, opt-in)**
**Reaches into:** router, document.body (for status bar)
**Surface:**
- Lifecycle: `connect/disconnect/connectLAN/dispose`
- Send: `send(raw) / push(clientId, payload)`
- JSON-RPC: `rpcRequest(method, params) / setRpcNotificationHandler(fn)`
- Introspection: `getLanAddress / getConnectionInfo / getLog / onLog`

**Findings:**
- Auto-reconnect with exponential backoff (2s → 30s × 1.5). Stale-socket
  guard (`if (this.ws !== socket) return`) so a reconnect doesn't
  resolve through a torn-down callback chain. Good shape.
- LAN detection via WebRTC ICE candidate scrape. Falls back to page
  hostname when not localhost. Self-contained.
- JSON-RPC implementation is minimal but correct: numeric id, pending
  map, timeout per request. Notifications (no id) route to a single
  handler — currently used for `fs/didChange`.
- `_handleMessage` knows four envelope shapes: JSON-RPC, relay
  registration ack, `client_connected/disconnected`, `{from, cmd}`
  command envelope.
- On `client_disconnected`: reaches into `router.context.registry` and
  clears `grid.onInput` on every entry with `meta.owner === clientId`.
  Minor coupling — bridge knows about terminal `onInput` shape. Could
  emit a `controller:disconnected` event the terminal subsystem handles
  instead.
- Command log is a ring buffer (200 entries) with subscriber API.
  Already substrate-quality eventing — reference pattern for the
  managers that still poll.

#### Embedded chrome: status bar
**File:** `src/services/orchestration/WebSocketBridge.js:46-48, 246-324`
**Bucket:** **chrome inside a substrate file**
**Intent:** A floating bottom-right status pill showing connection
state, clickable to expand for ~5 seconds with full info.
**Findings:**
- Created when `options.showStatus !== false`. IDEShell passes the
  same default, then `_hideOldUI` style-hides the element.
- Inline `Object.assign(this._statusEl.style, {...})` with ~20 properties.
- Substrate code mounting DOM is a category violation per the bucket
  rules. WebSocketBridge should never know `document` exists.
**Refactor note:** **Cleanest single cut in this pass.** Extract to
`app/components/WSStatusBadge.js` (or fold into `IDEShell`/`HomeShell`
respectively). Bridge exposes `on('connection:change', cb)` and
`getConnectionInfo()`; widgets render. ~80 lines removed from
substrate.

#### Disposable resources
**File:** `src/services/orchestration/WebSocketBridge.js:515-528`
**Bucket:** substrate
**Findings:** `dispose()` rejects all pending RPCs, disconnects,
removes the status element. Clean lifecycle. ⓘ status element removal
will become redundant once that's extracted.

## Cross-cutting findings (pass 6)

1. **The bridge's command log + subscriber API is the right shape for
   every event source in the codebase.** Compare with: SpatialManager
   (polled), AttentionManager (already has `on('change:slot', cb)`),
   SelectionManager (no events — drives via window events). Two of
   three already work right; SelectionManager is the holdout. Make this
   the substrate-wide contract: `on(name, cb) → unsub`.

2. **WebSocketBridge's terminal `onInput` knowledge** is the third hidden
   substrate piece (after EntityKeystrokeRouter and ConsoleForwarder
   from pass 3) — together they form what a "terminal entity host"
   wants to be. Possibly worth its own service:
   `TerminalSession` — owns onInput wiring + per-controller ownership +
   disconnect cleanup.

3. **Router's `ctx.sender` mutation** is the same shape as
   GitHubRepoViewer's mutation of SceneContext (adding `spiralManager`,
   `treemapManager` to a "context" that was supposed to be immutable).
   Pattern across the codebase: "context bags are growable scratch
   space." Substrate refactor's policy: contexts are frozen at
   construction; per-call metadata travels as a separate argument.

4. **The 'DISPLAY' registration string on connect** (`socket.send('DISPLAY')`,
   line 353) is the only un-JSON message the bridge sends. Curious
   wart. Could become `{role: 'display'}` for symmetry. Low priority.

---

# Pass 7: `src/services/SceneContext.js` + `ViewerCameraController.js`

### SceneContext — small but explicitly mutable
**File:** `src/services/SceneContext.js` (43 lines)
**Bucket:** substrate
**Surface:** holds `{THREE, scene, camera, renderer, canvas, atlas,
getGrids}`; explicitly named null-init fields for `hierarchicalManager`
and `layoutManager`; `getGrids()` method that calls the closure.
**Findings:**
- Designed to be mutated. The constructor null-inits two fields and
  external code (GitHubRepoViewer.relayoutGrids) adds 5 more at
  runtime (`hierarchicalManager`, `spiralManager`, `treemapManager`,
  `stackManager`, `entityInputRouter`).
- `getGrids` is closure-backed because `clearGrids()` used to replace
  the array — but the registry getter now is idempotent, so the
  closure indirection is mostly historical.
**Refactor note:** Two cuts available:
1. Make SceneContext **read-only** (frozen at construction). External
   "managers" don't belong on a substrate handle — they go on a
   separate `LayoutController` or `ApplicationContext`.
2. `getGrids` could just be `registry.toArray('grid')` — no closure
   needed.
After: ~25 lines, immutable struct. Substrate becomes more honest about
what it owns vs. what the application contributes.

### ViewerCameraController — the substrate model file
**File:** `src/services/camera/ViewerCameraController.js` (875 lines)
**Bucket:** **substrate** with two acceptable boundary crossings
**Surface (public):**
- Lifecycle: `setupEventListeners / teardownEventListeners / dispose`
- Per-frame: `update(dt) / applyCamera(dt)`
- Focus: `computeGridFocus / focusOnGrid / focusOnGrids /
  focusOnDirectory / focusOnDiffGrids / focusOnDiffFile`
- Controls: `setSpeed / toggleDynamicSpeed / reset / resetSettings`
- Touch passthrough: `_applyDragTranslation / _zoomBy` (used by
  TouchController despite the underscore)

**Single-drain architecture (the model to copy):**
- Event handlers write only into `this.input.{drag,wheel,cursor,keys,
  modifiers,buttons,focus}` — never touch the camera.
- `applyCamera(dt)` runs once per frame and is the **only** writer to
  the camera. Composes drag → wheel → keyboard → rotation in order.
- New input modes (focus-lock, fly-cam, trackball) are branches inside
  applyCamera, not new listeners.

**Findings — substrate boundary crossings:**

#### Settings UI binding inline (`_bindSlider`, `_restoreUI`)
**File:** `ViewerCameraController.js:347-371, 635-673`
**Bucket:** **chrome inside substrate**
**Intent:** Wire `#cam-speed`, `#drag-sensitivity`, `#scroll-sensitivity`,
`#reset-camera`, `#fit-all` to settings.
**Findings:** Substrate code knowing specific DOM ids. Identical
category violation to WebSocketBridge's status bar.
**Refactor note:** Extract to `app/components/panels/CameraSettings.js`.
VCC exposes `setSettings(partial)` + `getSettings()` + `on('settings:change')`
events; the panel renders and writes.

#### focusOnGrids layout-manager waterfall
**File:** `ViewerCameraController.js:754-778`
**Bucket:** substrate touching application
**Findings:** Reads four manager refs off `ctx` in priority order
(`stack > treemap > spiral > hierarchical > grid`). Same coupling
pattern as `relayoutGrids` in the viewer.
**Refactor note:** Once `LayoutController` exists,
`focusOnGrids → focusOnUnion(ctx.layoutController.getTotalBounds())`.

#### focusOnDiffGrids takes a diffController arg
**File:** `ViewerCameraController.js:798-816`
**Bucket:** **substrate accepting application-layer parameter**
**Findings:** The function takes a diffController only to call
`getTotalBounds()` on it.
**Refactor note:** Replace with
`focusOnBoundsOf(THREE.Box3)`. Caller passes the box. One generic
verb covers diffs, groups, directories — and all the
[[duplicated camera-fit math]] consolidates onto it.

#### focusOnDiffFile relies on "even index = diff file" convention
**File:** `ViewerCameraController.js:818-824`
**Bucket:** substrate carrying application knowledge
**Findings:** `gridIndex = fileIndex * 2` because diffs lay out
before/after pairs.
**Refactor note:** Belongs in `DiffController.focusOnFile(index)` →
calls `cameraController.focusOnGrid(...)`. Substrate stays pure.

**Findings — well-shaped pieces (the reference model):**

#### Single-drain input pipeline
**File:** `ViewerCameraController.js:115-156, 423-500`
**Bucket:** substrate exemplar
**Findings:** `_makeInputState()` defines every input axis up front
(modifiers, buttons, cursor, keys, drag, wheel, focus). The handlers
do nothing but update the right field. `applyCamera` reduces. Adding
a new gesture means: add a field to input state + read it in
applyCamera. Two diffs, no listener wars.
**Refactor note:** Use as **the** template for input pipelines
elsewhere. Selection clicks, picking, gestures — all the same shape.

#### AttentionManager gates throughout
**File:** `ViewerCameraController.js:190-201, 314-332, 384-385`
**Bucket:** substrate consuming substrate
**Findings:** Three gates use `ctx.attentionManager`:
1. WASD/keydown drops keys while `attention.key` is held (terminals).
2. Focus probe skipped while `attention.primary` is held (reader
   mode locks).
3. Wheel-zoom raycast suppressed under same gate.
**Refactor note:** This is the AttentionManager integration done
right. Reference for other substrate modules.

#### Trackpad detection latched per-session
**File:** `ViewerCameraController.js:30-60`
**Bucket:** substrate, self-contained
**Findings:** Module-level latch (`_trackpadLatched`) flips true on
first definitive trackpad signal (non-zero deltaX, fractional deltaY,
or |deltaY|<40). After that, every wheel event is "trackpad."
**Refactor note:** Could be per-instance instead of module-level for
multi-canvas scenarios. Not blocking — single-canvas is the only
mode today.

#### canvas-click synthesis
**File:** `ViewerCameraController.js:225-250`
**Bucket:** substrate emitting event for consumers
**Findings:** On mouseup, if the drag never exceeded
`CLICK_THRESHOLD_PX` (5), dispatches a `canvas-click` CustomEvent on
the canvas. Selection + reader + attention all listen.
**Refactor note:** EntityInputRouter probably wants to own click
synthesis too (since it already owns the priority pipeline). Move
the threshold check + dispatch there once the input router gets
generalized.

#### Public touch entry point with underscore name
**File:** `ViewerCameraController.js:623-625`
**Bucket:** substrate (public) wearing private clothing
**Findings:** `_applyDragTranslation(dx, dy)` is **the** documented
touch entry — comments say "shared with TouchController." Underscored
because it predates the public boundary clarification.
**Refactor note:** Rename to `panBy(dx, dy)` and expose alongside
`zoomBy(deltaY)`. TouchController stops looking like it's reaching
into privates.

## Cross-cutting findings (pass 7)

1. **VCC is the most clearly architected substrate file in the
   codebase.** Single-drain input → reduce-into-camera. Cleanly
   integrated AttentionManager gates. State persistence through
   stateController. The bones are good — the only contamination is
   the slider-id DOM coupling (~40 lines) and three
   substrate→application reaches in focus methods (~80 lines).

2. **Camera-fit math is now provably duplicated four ways.**
   - `_zDistanceForFit(w, h, fill)` in VCC (canonical)
   - `computeGridFocus` in VCC (specialized for grids with readable-
     line target view-height)
   - `focusOnGroup` in GroupsPanel (inline copy)
   - `frameBox / frameNodes` in `app/home/layout/viewport.js`
     (different convention, same math)
   The substrate verb is `cameraController.focusOnBox3(box, { fill,
   topMargin })`. Every caller converges on it.

3. **AttentionManager is the substrate's central nervous system —
   already.** Three modules already gate on it:
   `ViewerCameraController` (3 gates), `_installEntityKeystrokeDelivery`
   (delivery), `CommandBar` (subscription). The leapfrog selection
   primitive shouldn't replace AttentionManager — it should *be*
   AttentionManager, with SelectionManager + fileStateManager.selected
   folded in as a "selected" slot or tag set.

4. **The "(ctx as growable scratch)" pattern is the project's
   substrate-application boundary smell.** Both SceneContext (mutated
   externally by viewer) and CommandRouter (mutates `ctx.sender` on
   each call) lean on it. Substrate refactor's contract: contexts are
   immutable handles; mutable state lives on the named services.

5. **Two pieces of chrome embedded in substrate** identified now:
   WebSocketBridge's status bar, VCC's settings sliders. Both
   refactor to the same shape: substrate emits events, panel
   widget subscribes. ~120 lines of DOM leaves substrate.

---

# Pass 8: `src/collections/CodeGrid.js` (1771 lines)

The most important entity in the codebase. **Substrate-quality** with
clear internal subsystem buckets that should each be addressable on
their own. Six subsystems live here under one class — separation is
not urgent, but they should be named and possibly split.

### Constructor + config
**File:** `src/collections/CodeGrid.js:39-125`
**Bucket:** substrate
**Findings:**
- Extends THREE.Object3D.
- Config absorbs `slugData` and `shaper` from atlas (`atlas._slugData
  / atlas._shaper`) — the stash-on-atlas trick the boot pipeline uses
  to avoid passing them everywhere. Pragmatic but a global-bag smell;
  see pass 1's `Viewer3D` extract for the cleanup.
- Constructor calls `scene.add(this._rendererGroup)` (line 91), then
  later `this.add(this._rendererGroup)` (line 108) which **re-parents**
  the group from scene to self. Net effect: rendererGroup is a child
  of *this*, not the scene. Why scene-add then self-add? Probably
  historical or defensive — leaves a confusing two-step state during
  construction.
- **Caller must `scene.add(grid)` after construction.** WelcomeCluster
  and TryThisCluster discovered this the hard way (memory:
  feedback_cannibalize_existing_infra). The constructor *should* not
  touch the scene at all — scene-add is the caller's call.
**Refactor note:** Drop `this.scene.add(this._rendererGroup)` from
the constructor. Keep only `this.add(this._rendererGroup)`. Document
that callers add the grid to the scene. ~5 lines of confusion gone.

### Subsystem 1: Content loading
**File:** `src/collections/CodeGrid.js:150-229, 1027-1126`
**Bucket:** substrate
**Surface:** `loadText / loadFile / loadTextAsync / loadFileAsync /
clear`
**Findings:**
- Sync path splits content by `\n`, fires one `_addText` per
  non-empty line, then `_flush()`.
- Async path passes the entire content as one item; worker handles
  newlines + wrapping.
- The async path is the only one that builds `_lineWrapCols` /
  `_lineStartRow` (the caret-positioning ruler) — because the worker
  is the only thing that knows where it wrapped. **The sync path has
  no caret support** (no wrap data → `_resolveCaretWorldPosition`
  returns null → caret invisible).
**Refactor note:** The dual sync/async paths are diverging. Either:
(a) make async the canonical path and demote sync to "no-worker
fallback only," or (b) teach the sync path to compute wrap data too.
The async-as-canonical path is simpler — `loadText` becomes
`loadTextAsync` with a `.catch(() => syncFallback())`.

### Subsystem 2: Deferred-batch rendering
**File:** `src/collections/CodeGrid.js:660-1000`
**Bucket:** substrate
**Surface:** `_ensureRenderer / _createRendererWithSize /
_resetBatchState / _addText / _removeText / _flush / _flushAsync`
**Findings:**
- Holds `_pendingAdds / _pendingRemovals / _pendingUpdates /
  _idMap / _reverseIdMap / _committedTexts`. The double-map exists so
  remove-by-local-id and remove-by-renderer-id both work.
- Async path defers removals across the worker await so the GPU
  buffer doesn't flash empty between old and new content. Atomic swap
  inside one synchronous block after worker returns. Good shape.
- Buffer-size policy: sync path estimates `glyphCount * 1.1`; async
  path right-sizes after worker returns (`buffers.count`). Edit
  flows route through async exactly because of this — see
  `_relayoutPreservingCursor`.
**Refactor note:** This is **the** subsystem that should split out.
Candidate: `RenderBatch.js` — extract `_pendingAdds`, the maps, and
the flush variants. CodeGrid composes a RenderBatch instead of owning
all that state directly. ~250 lines lift. Not urgent — it's clean,
just dense.

### Subsystem 3: Background mesh
**File:** `src/collections/CodeGrid.js:1006-1021, 1727-1768`
**Bucket:** substrate
**Findings:** Simple — a unit `THREE.PlaneGeometry` scaled to content
bounds, positioned at the back of the Z spread, semi-transparent.
**Refactor note:** Could be a separate `GridBackground` decorator that
composes onto CodeGrid (subscribes to bounds change). Probably not
worth it — it's 60 lines.

### Subsystem 4: Bounds caching
**File:** `src/collections/CodeGrid.js:118-124, 300-395, 1133-1197`
**Bucket:** substrate
**Surface:** `getBounds / layoutBounds / getContentBounds /
_getContentBounds / _markBoundsDirty`
**Findings:**
- Three caches: `_boundsCache` (world-space), `_contentBoundsCache`
  (local plain-object), `_workerBoundsCache` (from worker output, fast
  path).
- `updateMatrixWorld` override dirties the world cache by snapshotting
  `matrixWorld.elements[12]` (tx) and comparing post-super. Cheap
  change detection.
- `layoutBounds()` exists explicitly because `Box3.setFromObject`
  doesn't account for per-instance positions in an InstancedMesh —
  documented in the comment, fixed during the home-page layout work
  this session.
**Refactor note:** Leave alone. This is exactly the careful caching a
substrate needs.

### Subsystem 5: Line→slot mapping + highlighting
**File:** `src/collections/CodeGrid.js:1199-1446`
**Bucket:** substrate
**Surface:** `_buildLineSlotBase / getSlotForChar / getVisibleCharCount
/ highlightRange / clearLineHighlight / clearAllHighlights`
**Findings:**
- `_lineSlotBase: Int32Array` — maps line index → first-glyph buffer
  slot. Two construction paths: worker provides `lineSlotOffsets`
  authoritatively, sync path derives from `renderedTexts` entries.
- **`getVisibleCharCount` line 1385-1396: counts codepoints with
  `cp > 32`.** Source code is overwhelmingly ASCII so this matches
  most builder behavior, but **NBSP (0xA0) is `> 32`** and the
  builder's `_emptyGlyphs` set treats NBSP as a skipped glyph in some
  paths. Latent mismatch documented in
  [[project-nbsp-highlight-mismatch]] — the root is *here*.
- `highlightRange` uses `getVisibleCharCount` to determine end col on
  multi-line spans (line 1413). The NBSP miscount propagates into
  highlight ranges drifting by one when a line contains NBSP.
**Refactor note:** Either:
(a) `getVisibleCharCount` should consult the builder's exact skip
    set (export the set from `src/workers/builders/`), or
(b) Both `_lineSlotBase` and `getVisibleCharCount` should derive from
    the same source-of-truth (the builder's per-glyph emission list),
    so they can't drift.
This is a concrete substrate fix that would also retire the latent
NBSP bug — small win, real bug.

### Subsystem 6: In-grid edit engine
**File:** `src/collections/CodeGrid.js:1448-1721, 1275-1359`
**Bucket:** substrate
**Surface (public verbs):** `enterEdit / exitEdit / getCursor /
setCursor / editInsert / editDeleteBackward / editDeleteForward /
editSplitLine / editMoveCursor / editHome / editEnd`
**Plus:** `_initCaretMesh / _updateCaretMesh /
_resolveCaretWorldPosition / _buildLayoutWrapIndex /
_relayoutPreservingCursor`
**Findings:**
- Cursor lives on the grid (`this._cursor = {line, col}`) — each grid
  remembers its own. `null` means "not editing." Right design — grids
  are addressable, attention.key picks which one is active.
- Edit ops mutate `this.lines` directly, then async-rebuild via
  `_relayoutPreservingCursor`. Coalesce via in-flight + queued flags.
- Caret math (`_resolveCaretWorldPosition`) is **pure**: visual row
  from `_lineWrapCols / _lineStartRow`, x from intra-segment col, y
  from origin + row × lineSpacing, then pagination formula. No buffer
  reads, no neighbor sampling. Mirrors the layout invariants the
  worker obeyed.
- **PAGE_CONFIG and Z_WRAP_CONFIG come from `src/workers/builders/index.js`** —
  shared constants between builder and caret math. Correct
  factoring. The substrate's worker output ↔ caret rendering contract.
**Refactor note:** Leave alone. This is well-shaped substrate. **If**
the dual sync/async paths converge (see subsystem 1), the caret would
"just work" on sync-loaded grids too.

### Compat shim: getCollection()
**File:** `src/collections/CodeGrid.js:407-418`
**Bucket:** **explicit compat shim** marked for removal in C5
**Findings:** Returns the same as `getRenderer()`. Docstring says
"will be removed in C5 when all callers are updated to use
getRenderer()."
**Refactor note:** **Delete now.** Callers it serves are
gridCommands.js (`grid.color` line 98) and probably others. The grep
+ patch is a one-commit cleanup. Reference for substrate's no-shim
discipline.

### caret rendering attaches as Object3D child
**File:** `src/collections/CodeGrid.js:1632-1647`
**Bucket:** substrate
**Findings:** Caret is `THREE.Mesh(PlaneGeometry, MeshBasicMaterial)`,
added as a child of the grid (so grid transform applies), with
`renderOrder=5, frustumCulled=false`. Lazy-created on first
`enterEdit`.
**Refactor note:** Caret instability mentioned in
[[project-in-grid-editing]] memory ("known shakiness pending substrate
refactor") — the substrate refactor *is* this audit, and the caret's
position math is now pure. The shakiness probably comes from grids
being added/removed from the scene by the virtualizer while in edit
mode, not from the math here. Worth verifying once the eviction +
edit-mode interaction is checked.

## Cross-cutting findings (pass 8)

1. **CodeGrid is the substrate's center of gravity.** Almost every
   feature in the codebase touches it (rendering, layout, highlight,
   picking, edit, attention). It's 1771 lines because it earned them.
   The good news: each subsystem is already cleanly delineated by
   `// ============` comment banners. Splitting into composed modules
   would be a series of mechanical lifts, not a redesign.

2. **The NBSP mismatch root cause is `getVisibleCharCount`'s
   `cp > 32` rule.** Builder's `_emptyGlyphs` is a Set (specific
   codepoints). Different shapes of the same idea, different answers
   on Unicode space-like codepoints. **Substrate fix candidate** —
   small, named, retires a known bug. Probably the cheapest concrete
   win in the audit.

3. **Sync vs async paths diverge on caret + wrap data.** Async is the
   richer path (worker emits `lineSlotOffsets` + `wrapColsPerLine`);
   sync is missing both. Migrating sync to async would close the gap
   and let everything that loads text (demos, IDE, future shell) get
   caret + wrap for free.

4. **`atlas._slugData / atlas._shaper` is a "global bag" pattern.**
   Convenient but couples CodeGrid to a single atlas instance per
   atlas type. Once substrate-context exists, slugData and shaper
   travel through that context, not stashed on atlas.

5. **`getCollection()` is a clean delete target.** The plan's
   no-compat-shims principle has a concrete example here. Removes the
   confusion between "renderer" and "collection" — the GlyphCollection
   class itself is gone (C4 deleted it), only the verb remains.

6. **Constructor side-effect (scene.add) is the wart.** Should not
   happen in the constructor. Caller responsibility. Five lines of
   change.

7. **CodeGrid's subsystem buckets map directly to candidate substrate
   modules:**
   - `RenderBatch` — the deferred buffer + worker dispatch machinery
   - `LineSlotIndex` — `_lineSlotBase` + visible-char counting (with
     builder-derived skip set)
   - `EditEngine` — cursor + edit ops + caret math
   - `Bounds` — the three-tier cache
   - `Background` — the secondary plane
   CodeGrid itself stays a thin Object3D composing them. **Not a
   first cut** — the file is fine as-is — but it's a clean
   second-pass target once the application/chrome refactor frees
   substrate attention.

---

# Pass 9: `src/services/data/*.js` (8 files, ~2100 lines)

The data layer is the cleanest layer in the codebase. Substrate
throughout. Two providers (`RepositoryAdapter` for GitHub,
`RemoteFileSystemProvider` for relay) speak nearly the same surface,
which is exactly how the viewer is able to swap them at runtime.

### types.js — JSON-RPC error vocabulary
**File:** `src/services/data/types.js` (91 lines)
**Bucket:** substrate
**Findings:** Pure type definitions + `FileSystemError` class with
named static constructors mirroring JSON-RPC error codes. Codes match
`cli/fs.go`. Reference-shaped: typed errors travel across the
JSON-RPC boundary without losing semantics.
**Refactor note:** Leave alone.

### GitHubRepositorySource — pure API client
**File:** `src/services/data/GitHubRepositorySource.js` (673 lines)
**Bucket:** substrate
**Surface:** `parseGitHubUrl, getRepositoryInfo, isAvailable,
fetchTree, fetchFile, fetchRawFile, fetchBranches, fetchPullRequest,
fetchPullRequestFiles, getRateLimitStatus, buildRawUrl, getInfo`
**Findings:**
- Static `parseGitHubUrl` — duplicated in GitHubRepoViewer.js line 72.
  Two implementations of the same parser. Substrate's is more
  complete (handles git@ form + branch path); viewer's is a simpler
  variant. **Consolidate** by deleting the viewer's copy.
- Rate-limit tracking lives on the source instance, exposed via
  `getRateLimitStatus`. Status flows through RepositoryAdapter to
  callers. Clean.
- `fetchRawFile` uses raw.githubusercontent.com — avoids API rate
  limit + native UTF-8. `fetchFile` is the contents API (base64).
  Defaulting to raw is the right call.
- Error classes (`GitHubError`, `RateLimitError`) typed properly.
- AbortController per request with timeout. No leaked listeners.
**Refactor note:** Leave alone. Reference-shaped substrate.

### RepositoryAdapter — caching + filtering on top of source
**File:** `src/services/data/RepositoryAdapter.js` (481 lines)
**Bucket:** substrate
**Surface:** `loadRepository, streamFiles, getFile, getRepositoryTree,
getFileContent, getMultipleFiles, filterCodeFiles, getStats,
clearCache, clearRepositoryCache`
**Findings:**
- Composes `GitHubRepositorySource` + `RepositoryContentCache`.
  Adapter pattern is real here — the adapter adds caching + filtering;
  the source just fetches.
- `filterCodeFiles` is a **second copy of file-type filtering** in the
  codebase. The other is `textFileFilter.js` (which `GitHubRepositorySource._parseTreeResponse`
  uses via `filterTree`). This `filterCodeFiles` uses a *blacklist*
  (binary extensions); `textFileFilter` uses a *whitelist*. The viewer
  calls `repoAdapter.filterCodeFiles(treeResult)` after the tree has
  already been whitelist-filtered. **Two filter passes for the same
  goal.** Some files pass one but not the other (e.g., a file
  whitelisted by extension but with a path matching the
  `node_modules` blacklist regex).
- Progress tracking + AbortController for streamFiles.
- `getMultipleFiles` does cache-first then parallel fetch the misses.
  Pattern symmetric to what RemoteFileSystemProvider does.
**Refactor note:** **Unify the two filter passes.** One filter
service (whitelist + skip-dir + blacklist patterns all in one) used by
both providers and the relay's `cli/fs.go`. Today both run; the
intersection is a moving target.

### RepositoryContentCache — TTL + LRU eviction
**File:** `src/services/data/RepositoryContentCache.js` (290 lines)
**Bucket:** substrate
**Findings:** Map-backed, async get/set (returns Promise of nothing),
5-min TTL, 1000-entry max, LRU eviction by `accessedAt`. Export/import
for persistence. Stats tracking.
**Refactor note:** Async get/set is anticipatory — there's no async
work happening. Could become synchronous without harm. Otherwise
substrate-shaped.

### RemoteFileSystemProvider — JSON-RPC client + RepositoryAdapter shim
**File:** `src/services/data/RemoteFileSystemProvider.js` (231 lines)
**Bucket:** substrate **with a compat surface**
**Findings:**
- Two interfaces in one class:
  1. **FileSystemProvider** (typed): `readFile, listTree, stat`.
  2. **RepositoryAdapter compat**: `loadRepository, getRepositoryTree,
     filterCodeFiles, getMultipleFiles, streamFiles, getFile,
     getProgress, getStats`.
- The compat surface exists so GitHubRepoViewer can swap providers
  without changing the load pipeline.
- `filterCodeFiles` **reaches into `RepositoryAdapter.prototype` via
  `RepositoryAdapter.prototype.filterCodeFiles` and `.call(this, ...)`** —
  prototype theft to reuse the blacklist logic. Clever but smelly.
  Means `RemoteFileSystemProvider` is shape-coupled to whatever
  `this` RepositoryAdapter's method expects.
- `getStats` returns zeros for GitHub-specific fields. Confirms the
  compat-surface is for swap-ability, not legitimate parity.
**Refactor note:** Two cleanups:
1. The unified filter service (above) eliminates the prototype theft.
2. The "RepositoryAdapter compat" surface should be its own thin
   wrapper class — `LocalRepositoryAdapter` that *composes*
   `RemoteFileSystemProvider`. Substrate stays clean; the application
   layer composes whichever provider+adapter pair it needs.

### textFileFilter — mutable shared whitelist
**File:** `src/services/data/textFileFilter.js` (177 lines)
**Bucket:** substrate
**Findings:**
- Frozen defaults + mutable runtime sets. Three exported getters
  (`getTextExts/getTextNames/getDefaults`), two setters, one reset, a
  `filterTree` that consumes the module state.
- **Module-level mutable state** — `_textExts` and `_textNames` are
  module variables. Convenient global config; harder to test in
  isolation; impossible to have two filters active at once. (Today
  that's fine — there's one viewer.)
- The relay (`cli/fs.go`) maintains its own filter; the viewer pushes
  updates via `fs/setFilter`. Two filters that have to stay in sync.
**Refactor note:** Convert module state to instance state on a
`FilterPolicy` class that both providers consume. Or leave alone if
the one-policy-per-page is permanent.

### HeatmapProvider — file-property computation + color ramp
**File:** `src/services/data/HeatmapProvider.js` (149 lines)
**Bucket:** substrate
**Surface:** `computeMetrics, getMetric, createColorFn`
**Findings:**
- Walks `ctx.getGrids()`, reads `getLineCount/getMaxLineWidth/content.length`,
  normalizes to 0..1, computes a weighted heat metric, batch-writes
  to `FileStateManager`.
- `createColorFn()` is a **static factory** that returns a function
  CodeColorManager registers as a color layer. Pattern: provider is
  decoupled from the color manager via a plain function.
- The "heat color ramp" inlines four-stop interpolation. Could be a
  reusable substrate utility (`colorRamp(stops, t)`); not urgent.
**Refactor note:** Reference shape for a "metric-and-color" provider.
**Use this pattern for future providers** (e.g., recency, churn,
ownership) — same surface, plug-in via `codeColorManager.registerLayer`.

### data/index.js — barrel
**File:** `src/services/data/index.js` (9 lines)
**Bucket:** substrate
**Findings:** Re-exports. Note: `textFileFilter` is **not** in the
barrel — the viewer imports `getTextExts/getTextNames/setTextExts/etc.`
directly from the deep path. Inconsistent.
**Refactor note:** Either add textFileFilter exports to the barrel
or stop using a barrel. Tiny.

## Cross-cutting findings (pass 9)

1. **The data layer is the substrate's cleanest layer.** Every file
   here is composable, typed, error-aware. Use it as the *quality
   target* for the rest of substrate after refactor: typed errors
   crossing boundaries, async-aware caching, AbortController per
   request, stats exposed for observability.

2. **Two file-type filters with different defaults run in series.**
   `textFileFilter.filterTree` (whitelist) applies in
   `GitHubRepositorySource._parseTreeResponse`. Then
   `RepositoryAdapter.filterCodeFiles` (blacklist + path patterns)
   applies in `loadRepository`. RemoteFileSystemProvider runs the
   blacklist only (because relay does whitelist on the Go side).
   **Unification target** — one `FilterPolicy` used by both
   providers and pushed to relay.

3. **`parseGitHubUrl` is duplicated** in `GitHubRepositorySource` and
   `GitHubRepoViewer.js`. The substrate version is richer. Delete the
   viewer's copy.

4. **RemoteFileSystemProvider's prototype-theft for `filterCodeFiles`**
   is the only weird code in this layer. The unified filter cleanup
   retires it.

5. **The provider-swap pattern works precisely because both providers
   conform to the RepositoryAdapter surface.** Confirms the substrate
   refactor's `ProjectMount` candidate cut — a `ProjectMount` consumes
   any `RepositoryAdapter`-shaped object, source is invisible above.

6. **HeatmapProvider's plug-in shape is the model for the rest of the
   color/state pipeline.** A future "selection" provider, "attention"
   provider, "diff status" provider — each gives a static
   `createColorFn()` and writes to `FileStateManager`.
   `CodeColorManager.registerLayer` consumes them. Pluggable.

---

# Pass 10: `src/services/interaction/*.js` (7 files, 1684 lines)

The interaction layer is the **substrate's load-bearing core for user
gestures**. AttentionManager is the spine; everything else either
gates on it (VCC, ShortcutManager) or runs adjacent (Selection,
ColorLayer, EntityInputRouter, ReaderCompass).

### index.js — barrel
**File:** `src/services/interaction/index.js` (6 lines)
**Bucket:** substrate
**Findings:** Exports only Selection, CodeColor, Shortcut. **Missing
AttentionManager, EntityInputRouter, ReaderCompass** — three of the
seven modules aren't in the barrel. Callers import them from deep
paths.
**Refactor note:** Add the missing four to the barrel, or drop the
barrel entirely. Two-line cleanup.

### AttentionManager — the spine
**File:** `src/services/interaction/AttentionManager.js` (190 lines)
**Bucket:** **substrate exemplar**
**Surface:** `set(slot, id, opts) / get(slot) / clear(slot?) / info() /
on(evt, fn) / off(evt, fn)`
**Findings:**
- Three slots: `hover, primary, key`. Each slot value is `{id, entity,
  ts} | null`. `ts` from performance.now() bumps on every write (even
  no-op same-id rewrites — for debugging "when did this last fire?").
- Idempotent same-id writes update `ts` but skip the change event.
  Smart — hover probes fire 60-ish times per second; spam would be
  pathological.
- Events: `change` (slot, value, prev) + per-slot `change:hover`,
  `change:primary`, `change:key`. Two-arg vs three-arg signature
  difference depending on which event.
- L1-A migration sweep is documented in the header: previously
  attention lived across `VCC.input.focus.attendedId`,
  `ctx.mode.readerGridId`, `commandBar.target`. Single sweep.
- `docks: Map` is empty in L1, reserved for L2 CameraDock + dock.*
  verbs. Pre-allocated namespace; useful for forward planning.
**Refactor note:** **This is the reference shape for every event-
emitting substrate service.** Use it verbatim: event-emitter (not
EventTarget), per-slot specific events, idempotent writes, monotonic
timestamps. The pattern other managers should converge on:
- SelectionManager: needs `change:primary` and `change:selected`
  events (today has internal listeners but no per-event split).
- FileStateManager: should have `change:property:<name>` events for
  watcher-style consumers.
- SpatialManager: needs `change:group` events to retire GroupsPanel's
  500ms poll.

### SelectionManager — fragments of the same idea as AttentionManager
**File:** `src/services/interaction/SelectionManager.js` (322 lines)
**Bucket:** substrate **— with the leapfrog merge target**
**Surface:** `select / deselect / clear / handleClick / primary /
getSelected / isSelected / on / off / dispose`
**Findings:**
- Keyed by `sourcePath` (string), not registry id. Distinct identity
  from AttentionManager (which uses registry id).
- Owns the **Z-pop** behavior — selected grids lift by 3 world units.
  `_originalZ` map tracks pre-pop positions for restoration.
- `handleClick` does its own raycast against `_background` meshes —
  **third raycaster in the codebase** (after EntityInputRouter and
  ReaderCompass). The viewer calls `selectionManager.handleClick` from
  inside its `canvas-click` listener, after EntityInputRouter has
  already raycast and dispatched.
- Writes to FileStateManager (`'selected' boolean property`) so
  CodeColorManager's selection layer can apply teal tint.
- Custom event `file-selected` for the tree panel.
- Has its own `on/off` listener mechanism, separate shape from
  AttentionManager's `on(evt, fn)` (this one takes only a callback).
**Refactor note:** **Merge candidate with AttentionManager.** Selection
is "primary + a tagged set of paths" — exactly what AttentionManager
could express with one extra slot (`selected: Set<string>`) or with
attention.primary + secondary tags on docks.
The Z-pop behavior moves to a `ZPopLayer` subscriber that listens to
attention changes — same shape as CodeColorManager.registerLayer.
The redundant raycast disappears — EntityInputRouter already did one;
SelectionManager subscribes to `canvas-click` with `gridId` in detail.

### CodeColorManager — layered color resolution
**File:** `src/services/interaction/CodeColorManager.js` (190 lines)
**Bucket:** substrate
**Surface:** `registerLayer / setLayerEnabled / isLayerEnabled /
updateAllColors / resetAllColors / dispose`
**Findings:**
- Priority-sorted layers (highest first). `registerLayer({priority,
  colorFn, watchProperties})`. Layers return null to pass through.
- Reactive: subscribes to FileStateManager's `onPropertyChanged`,
  re-applies color when a watched property changes. Watch set is
  per-layer, declared.
- Uses `grid.getCollection().setGroupColor(0, color)` —
  **`getCollection()` is the compat shim CodeGrid marked for
  removal**. CodeColorManager needs migration to `.getRenderer()`.
- Two blend modes: replace (1.0) when any layer is active, multiply
  (0.0) when none. Comment explains the rationale (instance default is
  green; multiplying green × heatmap kills R+B channels).
**Refactor note:**
1. Migrate `getCollection()` → `getRenderer()`. Then delete the shim
   from CodeGrid. Two-file change.
2. Layer pattern is the reference for "data → glyph color." Future:
   diff status layer, search-match layer, reader-mode layer.

### EntityInputRouter — the input priority owner
**File:** `src/services/interaction/EntityInputRouter.js` (382 lines)
**Bucket:** substrate
**Surface:** `registerType(type, handlers) / unregisterType /
getRegisteredTypes / attach / detach / raycastAtClient`
**Findings:**
- Capture-phase mousedown interceptor. Raycasts against registered
  types' `_background` meshes. If hit → `stopPropagation` (suppress
  camera drag) + drag state primed. If miss → bubbles to VCC for
  camera pan.
- **Per-type handlers** is the right shape — `registerType('grid',
  {hitTestable, translate, dropTargetCandidate})`. Defaults to
  `{true, true, true}`. Hardcoded registration of `grid`, `agent`,
  `terminal` in the constructor.
- Drag-and-group: ctrl/meta + drop > 30% overlap → auto-group via
  `spatialManager`.
- Click detection (< 5px movement) → re-dispatch `canvas-click` with
  `gridId` in detail. Same event VCC's mouseup synthesizes when no
  hit — but with `gridId` filled in.
- `raycastAtClient` is the public entry the camera probe + the
  click-to-attention handler use.
**Refactor note:** This is the **right home for the input-priority
generalization** the audit has been pointing to. Add:
1. Per-type `onPointerDown / onMove / onUp` overrides (already
   scaffolded as next-phase work in the doc comments).
2. Compass capture-phase handling becomes a registered type.
3. SelectionManager.handleClick subscribes to `canvas-click` instead
   of doing its own raycast.
4. Stack-layout hover/click (currently in GitHubRepoViewer) becomes a
   registered type with `onPointerMove` that fans the stack.

### ShortcutManager — the keymap gatekeeper
**File:** `src/services/interaction/ShortcutManager.js` (167 lines)
**Bucket:** substrate
**Surface:** `register(key, action, opts) / unregister / attach /
detach / getShortcuts`
**Findings:**
- Capture-phase keydown. Runs before VCC's bubbling keydown so
  shortcuts consume keys VCC would otherwise eat as WASD.
- Three guards: input/textarea focus, IME composition,
  **AttentionManager `key.entity.type === 'grid'`** (defer to grid
  editor).
- `mod` normalization — registrations using `ctrl+p` or `meta+p`
  resolve to one canonical key. Cross-platform shortcuts handled
  centrally.
- Key normalization: lowercased `e.key`, modifiers in canonical order.
**Refactor note:** Leave alone. Reference shape for keyboard plumbing.
The AM gate is exactly right — confirms attention.key is the universal
"don't eat my keystrokes" signal.

### ReaderCompass — camera-attached HUD
**File:** `src/services/interaction/ReaderCompass.js` (427 lines)
**Bucket:** substrate
**Surface:** `update(params) / hitTest / relayout` plus the
constructor pool init
**Findings:**
- Builds a fixed pool of `MAX_MARKERS=5` marker meshes as children of
  the camera (so they're always on-screen). Each marker is a
  canvas-backed plane: filename header + scaled-down preview of the
  file content.
- `update({currentId, entries})` projects each entry to NDC, picks
  off-screen entries, computes edge-positions with angular repulsion
  (5 passes), updates marker meshes.
- `hitTest(clientX, clientY)` is the consumer surface used by
  GitHubRepoViewer's capture-phase mousedown to detect compass clicks
  before EntityInputRouter sees them.
- 427 lines is dense but well-organized. Pure substrate.
**Refactor note:** The capture-phase plumbing in GitHubRepoViewer
(audit pass 1) should disappear in favor of EntityInputRouter's
registered-type pattern. Compass markers become a registered type
with a per-marker handler. Compass keeps its rendering; loses the
coupling to a sibling listener.

## Cross-cutting findings (pass 10)

1. **AttentionManager IS the substrate's central nervous system** —
   confirmed across every pass. Selection, Camera, CommandBar,
   ShortcutManager, EntityKeystrokeRouter, all consume or write to it.
   The leapfrog is **collapsing SelectionManager into AttentionManager**
   — selection is "primary + tags," not its own service.

2. **Three raycasters in the interaction layer** —
   EntityInputRouter (canonical), SelectionManager (its own),
   ReaderCompass (its own). EntityInputRouter is the right unified
   home. The other two become subscribers to the events it dispatches.

3. **The capture-phase pattern is correct but unowned.** Five places
   attach capture-phase listeners (VCC, ShortcutManager,
   EntityInputRouter, ReaderCompass, IDEShell's command-palette
   keydown). Order is implicit. EntityInputRouter wants to own
   pointer priority; ShortcutManager owns keyboard priority. Those two
   should be the only capture-phase owners — everything else
   subscribes.

4. **`grid.getCollection()` shim is alive in CodeColorManager.**
   Migration target identified from pass 8. Two-file change to retire.

5. **`watchProperties` in CodeColorManager is the reactive pattern
   for substrate.** Per-layer declared watches. Other managers (or
   substrate context fields) should adopt this — `subscribers declare
   what they care about, manager re-fires only for those`.

---

# Final synthesis — cross-cutting concerns + first cut

## The substrate's actual shape (as audited)

After full reading, the substrate is **already mostly built**. The
refactor is **less about creating new substrate and more about
relieving the application/chrome layers from holding pieces of it
hostage**.

### Substrate already exists, mostly clean:
- **Atlas / shaping / slug pipeline** (boot, ~67 lines duplicated
  across HomeShell + viewer)
- **CodeGrid + GlyphRenderer + GridVirtualizer** (rendering)
- **RepositoryAdapter + RemoteFileSystemProvider + GitHubRepositorySource
  + RepositoryContentCache + textFileFilter + HeatmapProvider** (data)
- **CommandRouter + WebSocketBridge** (orchestration)
- **ViewerCameraController + SceneContext** (camera)
- **EntityInputRouter + AttentionManager + CodeColorManager +
  SelectionManager + ShortcutManager + ReaderCompass** (interaction)
- **PickingSystem** (already substrate)
- **SceneRegistry + SpatialAnimator + SpatialWindowManager + layout
  managers** (state + spatial)
- **Home page layout kit** — Center / HStack / VStack / ZStack / Spacer
  / Anchor / measure / viewport.frameBox

### Application sits on top:
- IDE-specific keymap (`_registerShortcuts` content)
- Layout strategy selection (which manager is active)
- Project mount (`loadRepository / _loadLocalRepository / loadDiff`)
- Color policy registration (which layers, what priorities)
- URL routing (`/ide/owner/repo[/branch]`)

### Chrome is currently:
- IDEShell (vs Drawer — duplicate roles)
- Panel HTML factories (clean)
- AppShell.js header/fpsBadge (deletable after refactor)
- Settings-panel sliders embedded in VCC + WebSocketBridge

## Cross-cutting concerns identified

### 1. The context-bag chokepoint (the highest-leverage cut)
`buildContext(viewer)` is **the** coupling node. Every command handler
flows through it; the viewer is reachable from every handler. **Slice
the bag.**

### 2. Selection-as-fragmented-concept (the leapfrog)
SelectionManager + fileStateManager.selected + CodeColorManager's
selection layer + AttentionManager have **four implementations of
one idea**. Half is already done (AttentionManager.primary replaced
several writers); the rest is a one-pass merge.

### 3. Layout strategy waterfalls (mechanical extract)
`relayoutGrids`, `focusOnGrids`, `_createOverlays`, the heatmap
recompute — all of these contain `if/else if` chains over
hierarchical/spiral/treemap/stack. `LayoutController` strategy pattern.

### 4. Project mount duplication
`loadRepository` and `_loadLocalRepository` are 95% the same code
with different adapters. **Both are the same function** with a
provider argument.

### 5. Camera-fit math duplicated four ways
VCC._zDistanceForFit + computeGridFocus, GroupsPanel.focusOnGroup,
frameBox/frameNodes in home/layout/viewport.js. One canonical
`focusOnBox3(box, opts)` on cameraController.

### 6. File-type filter applied twice
textFileFilter whitelist in tree-parse + RepositoryAdapter.filterCodeFiles
blacklist in loadRepository + relay's own filter. Unify on one
`FilterPolicy`.

### 7. Three raycasters
EntityInputRouter (the right one) + SelectionManager + ReaderCompass.
Two should become subscribers.

### 8. Five capture-phase listeners
VCC, ShortcutManager, EntityInputRouter, ReaderCompass, IDEShell
palette. Two should own; three should subscribe.

### 9. NBSP highlight latent bug
`CodeGrid.getVisibleCharCount` uses `cp > 32` rule, builder uses a
specific skip set. Mismatch on NBSP.

### 10. Three compat hatches around viewer→shell separation
`IDEShell.asDrawer()` + `_hideOldUI` + `ide.html` monkey-patches.
All die together when viewer chrome moves out.

### 11. Two pieces of chrome inside substrate
WebSocketBridge's status bar + VCC's setting sliders. Extract to
panels, expose events.

### 12. `getCollection()` compat shim still consumed
CodeColorManager uses it. Two-file migration.

## Candidate first cut (the recommendation)

**Cut #1: Slice the context bag.** Specifically:

1. Define **two** context types:
   ```
   SubstrateContext = {
     // 3D primitives
     scene, camera, renderer, canvas, atlas,
     // identity
     registry,
     // accessors
     getGrids, addGrid, removeGrid,
     // services
     attentionManager, cameraController, wsbridge, entityInputRouter,
     pickingSystem,
   }
   ```
   ```
   ApplicationContext = {
     // substrate handle
     substrate: SubstrateContext,
     // IDE-only managers
     selectionManager, fileStateManager, codeColorManager,
     spatialManager, layoutController, statePersistence,
   }
   ```

2. Replace `buildContext(viewer)` with `buildContexts({ viewer3D,
   ideManagers })`. Handlers declare which they need.

3. Move runtime state (`annotations`, `gridVisualState`,
   `_cancelCameraAnimation`, `spatialNav`) off the bag onto their
   owning services.

4. `mode: { state }` becomes a `Mode` service emitting `change`
   events.

**Why this cut first:**
- **Highest leverage** — every handler reaches through the bag.
- **Forcing function** — when handlers declare their slice, the ones
  reaching too far get exposed.
- **Reveals next cut** — handlers that need application state become
  the IDE-specific group; handlers that need only substrate become
  portable to HomeShell. The split is empirical, not predicted.
- **Atomic** — no half-state. Either all handlers migrate or none do;
  AUDIT.md already enumerates which slot each module needs.
- **Quiet** — no UI change, no user-visible change. The substrate
  vocabulary clarifies. Matches the [[feedback-aesthetic-quiet-craft]]
  norm.

**Cut #2 candidate after #1 lands:** Selection → Attention merge.
Once handlers know which context they consume, the SelectionManager
collapse can target only the application-context handlers without
worrying about substrate consumers (because substrate consumers are
already on AttentionManager).

**Cut #3 candidate:** ProjectMount. Once context is sliced, this is a
clean lift — loadRepository + _loadLocalRepository fold into one
function over the provider abstraction.

## What we don't do in the first cut

- Don't touch CodeGrid's internal subsystem split. It's fine as is.
- Don't move CommandBar / SpatialNavigator / TouchController out of
  `app/components/` yet — file locations are reorderable later.
- Don't unify camera-fit math yet — needs ProjectMount first to know
  what owns the verb.
- Don't migrate `getCollection()` yet — small, but trivially gated
  on a one-line change in CodeColorManager.
- Don't fix NBSP yet — small, isolated bug; can pick off any time.

## Reading-order followups

These are **specific concrete bugs / migrations** the audit surfaced
that can be picked off independently of the big refactor:

- **NBSP highlight mismatch** — unify `getVisibleCharCount` skip rule
  with builder's `_emptyGlyphs`. One file, ~5 lines.
- **`getCollection()` migration** — CodeColorManager:185, gridCommands.js:98.
  Replace with `getRenderer()`. Delete shim from CodeGrid:407-418.
- **`parseGitHubUrl` duplicate** — delete viewer's copy
  (GitHubRepoViewer.js:72-87); import from GitHubRepositorySource.
- **Dead import `DrawerController`** — ide.html:251. Delete.
- **CodeGrid scene.add** — remove `this.scene.add(this._rendererGroup)`
  in CodeGrid:91; document constructor doesn't touch scene.
- **WS status bar in substrate** — extract WebSocketBridge:46-48,
  246-324 into `app/components/WSStatusBadge.js`.
- **VCC sliders in substrate** — extract VCC:347-371, 635-673 into
  `app/components/panels/CameraSettings.js`.

Each of these is a < 50-line change. **Independent and safe.** Doing
them in parallel with the big cut keeps momentum.

## The map is the contract — and we have it now

`AUDIT.md` lists ~70 concerns across 10 passes. Every entry has a
file:line, a bucket, a refactor note. Cross-cutting findings name the
12 patterns. Candidate first cut and the followups give a concrete
next-action set.

Ready for direction.











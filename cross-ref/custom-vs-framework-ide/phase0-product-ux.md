# Product/UX Analysis: Custom IDE Shell vs. Framework Integration

## Verdict

Keep the custom shell. The current IDEShell is the right architecture for this product. Integrating a VSCode-based framework would impose a mental model that actively misleads users about what this tool does. The shell's ~2,600 lines of custom code are not tech debt -- they are the product surface for a genuinely novel interaction paradigm.

---

## What the Current Shell Actually Does

Reading the code, IDEShell.js (~1,007 lines) provides exactly seven functional surfaces:

1. **Activity bar + sidebar panel switching** -- explorer, search, repo config, diff, settings, hand tracking, keyboard shortcuts. Panels are just HTML containers injected with content from the existing Drawer components.

2. **Tab bar** -- tracks "open" files. Clicking a tab calls `cameraController.focusOnGrid(index)` to fly the camera to that file's 3D position. There is no editor buffer, no document model. A "tab" is a spatial bookmark.

3. **Command palette** (Cmd+P) -- fuzzy-matches file paths against loaded grids, flies camera to the result. This is spatial navigation, not file-opening.

4. **Sidebar search** -- same as command palette but persistent in the sidebar.

5. **Bottom panel** -- output stats, log capture, WebSocket command log. Debugging/monitoring surfaces.

6. **Status bar** -- FPS, glyph count, grid count, camera XYZ, layout mode, WebSocket connection status. All domain-specific telemetry with no IDE-generic equivalent.

7. **CommandBar** (~460 lines) -- a dual-mode input: `:CMD` for command routing, `>termId` for typing into 3D terminal grids. Has history, tab completion, terminal highlighting. This is the actual interaction primitive for the agent-windows vision.

The shell also manages resize coordination between the CSS Grid layout and the Three.js renderer via ResizeObserver, and provides a DrawerController shim (`asDrawer()`) so the underlying GitHubRepoViewer's existing code works unchanged.

---

## The Metaphor Problem

The most important UX observation: **the "editor" area is a WebGL canvas.** There is no Monaco, no CodeMirror, no text buffer. Files are not "open" in the traditional sense -- they exist as 3D glyph grids that the camera can fly to.

A VSCode-like framework creates a set of user expectations:

| Expectation | What VSCode/Theia delivers | What glyph3d actually does |
|---|---|---|
| Click file in tree | Opens in editor tab, cursor blinks | Camera flies to 3D grid position |
| Type in editor | Text insertion, undo/redo | Nothing -- canvas captures mouse for camera control |
| Cmd+S | Save file | No file model to save |
| Cmd+F | Find-and-replace in file | Could search glyph text, but no cursor/selection |
| Intellisense | Autocomplete popup | N/A |
| Extensions | Install from marketplace | N/A |
| Git panel | Staging, diffing, committing | Diff visualization in 3D (different paradigm) |
| Terminal | xterm.js shell | 3D TerminalGrid with spatial presence |

Every single row is a mismatch. The VSCode chrome would promise capabilities that don't exist, while obscuring the ones that do (spatial navigation, camera physics, 3D terminal interaction, agent windows).

---

## The User Journey at ivanlugo.dev/ide

Based on the URL-driven auto-load code in ide.html (lines 289-326), the primary flow is:

1. User arrives at `/ide/owner/repo` or `/ide?repo=owner/repo`
2. Repo loads automatically -- file tree populates the explorer sidebar
3. 3D glyph grids render in the canvas
4. User navigates spatially: WASD/arrow keys for camera, click files in tree or Cmd+P to fly to them
5. Status bar shows real-time telemetry (FPS, glyph count, camera position)
6. Power users open CommandBar (Ctrl+`) to run commands or type into 3D terminals

This is closer to a **3D data visualization tool with IDE-like navigation chrome** than it is to an IDE. The chrome's job is discoverability and spatial orientation, not text editing.

What users actually need from the shell:
- **Where am I?** -- breadcrumbs, status bar camera position, tab bar as spatial bookmarks
- **Where can I go?** -- file tree, search, command palette
- **What's happening?** -- FPS, glyph count, WebSocket status, log output
- **How do I interact?** -- CommandBar for commands, click-to-target for terminals

All four of these are already served by the current custom shell. None of them map cleanly to VSCode's extension points.

---

## Agent Windows and the Framework Question

The vision is AI agents writing into dynamically-sized 3D windows in infinite space. Let's evaluate framework fit:

**VSCode extension API for agent windows:**
- Extensions run in an ExtensionHost process, communicate via RPC
- UI surfaces are: webview panels (iframes), tree views, status bar items, decorations
- There is no API for "render a dynamically-sized 3D object in a WebGL scene"
- An agent window would have to be a webview iframe overlaid on the canvas, breaking the spatial metaphor entirely
- Extensions cannot access the Three.js scene graph

**Current CommandBar + TerminalGrid approach:**
- CommandBar already targets specific 3D terminal grids by ID
- Terminal grids exist as Three.js Object3D children in the scene
- They can grow/shrink freely because they are glyph collections, not DOM elements
- The command router dispatches to terminals via `terminal.input termId base64data`
- WebSocket bridge allows external processes (CLI, agents) to create and write to terminals

The agent-windows vision requires deep integration with the 3D scene graph. A framework's extension API would be a barrier, not an enabler. The current architecture -- where CommandBar and WebSocket commands directly manipulate scene objects -- is the correct primitive.

---

## What a Framework Would Actually Cost

Beyond the metaphor mismatch, practical costs:

1. **Bundle size.** VSCode/Theia brings Monaco (~5MB minified), xterm.js, the extension host, language services. The current IDE shell is ~2,600 lines of vanilla JS with zero dependencies beyond Three.js. For a WebGL app targeting 60fps, this weight matters.

2. **Layout control.** The current CSS Grid layout (`ide.css` lines 64-82) gives the 3D canvas exactly the space it needs, with ResizeObserver coordinating renderer dimensions. Framework layouts assume the editor area contains a Monaco instance, not a WebGL canvas. Fighting this assumption would mean constant layout hacks.

3. **Input conflict.** The CommandBar carefully gates camera controls (`_cameraCtrl.enabled = false`) when focused, and stops keyboard event propagation to prevent camera movement during typing. A framework's keybinding system would create a multi-way fight: framework keybindings vs. camera controls vs. CommandBar vs. Three.js event handling.

4. **The DrawerController shim.** IDEShell already implements `asDrawer()` to satisfy the viewer's existing drawer API (lines 998-1006). This shimming pattern works because the surface area is small and well-defined. Shimming an entire framework's extension API would be orders of magnitude more complex.

5. **Mobile responsiveness.** The current shell has explicit mobile detection (lines 91-98, 456-459) that collapses sidebar on small screens and auto-dismisses after file selection. Framework-based web IDEs have poor mobile stories.

---

## What Would Be Worth Borrowing

Instead of adopting a framework, specific UX patterns worth stealing:

1. **Minimap.** There is already a `#minimap-container` in the HTML (line 109-111) but it appears to render a canvas, not a Monaco-style minimap. For a 3D code viewer, an overhead/birds-eye minimap of the spatial layout would be more useful than a per-file text minimap.

2. **Breadcrumb navigation with hierarchy.** The current breadcrumb (line 102-103) shows a flat path string. A clickable breadcrumb that lets you navigate directory levels and zoom the camera to that directory's spatial cluster would add real value.

3. **Command palette with categories.** Cmd+P currently only searches file paths. Adding categories (`:` for commands, `@` for symbols/grids, `>` for terminal targets) would give the command palette the same power as VSCode's without the framework.

4. **Keyboard shortcut discoverability.** The controls panel exists but is buried in the activity bar. A cheat-sheet overlay on `?` or first-visit onboarding would help.

5. **Theming.** The CSS custom properties (ide.css lines 13-46) are already structured for theming. Exposing a few presets (dark, light, high-contrast) would be a quick win.

---

## Recommendation Summary

| Factor | Custom Shell | Framework (Theia/Code OSS) |
|---|---|---|
| Metaphor accuracy | Correct (spatial navigation tool) | Misleading (text editor expectations) |
| Agent window support | Direct scene graph access | Extension API barrier |
| Bundle size | ~2,600 lines vanilla JS | ~5MB+ framework code |
| Input/keybinding control | Full control, camera gating works | Multi-way conflicts |
| Mobile | Custom responsive handling | Poor framework support |
| Maintenance burden | Low (simple DOM, CSS Grid) | High (framework versioning, API churn) |
| User expectations | Novel but honest | Familiar but deceptive |
| Time to integrate | N/A (already built) | Weeks to months of shimming |

**The current custom shell is the right choice.** It provides exactly the chrome a 3D code visualization tool needs, without promising capabilities it cannot deliver. The agent-windows vision requires scene-graph-level integration that no IDE framework's extension API supports. Investment should go into enhancing the existing shell (better command palette, spatial minimap, onboarding) rather than replacing it with a framework that would fight the product's fundamental interaction model.

# Engineering Analysis: Custom IDE Shell vs. Framework Integration

## Perspective: Integration Cost, Architecture Fit, and Maintenance Burden

---

## 1. What the Current Shell Actually Does

The IDE shell (`examples/ide/`) is 2,960 lines across 5 files:

| File | LOC | Responsibility |
|------|-----|---------------|
| `IDEShell.js` | 1007 | Layout orchestration, activity bar, sidebar, bottom panel, tab bar, status bar, resize, keyboard shortcuts, drawer-shim API |
| `ide.css` | 1150 | CSS Grid layout, theming, all visual styling |
| `ide.html` | 330 | Static DOM scaffold, importmap, bootstrap script |
| `CommandBar.js` | 463 | Dual-mode input (`:CMD` / `>termId`), history, tab-completion, terminal targeting |
| `index.html` | 10 | Redirect |

The shell is a thin DOM orchestrator. It does NOT own the renderer, scene graph, atlas, camera, services, or command system. It wraps `GitHubRepoViewer` by:
1. Injecting sidebar panel HTML before `viewer.init()`
2. Replacing `viewer.drawer` with itself via `asDrawer()` compatibility shim
3. Patching `viewer.updateStats()` to feed status bar updates per-frame
4. Using `ResizeObserver` on `#editor-area` to resize the Three.js renderer

The bootstrap in `ide.html` (lines 178-327) does all the wiring: create IDEShell, inject panels, create viewer, swap drawer, wire CommandBar, add click-to-target raycasting, and URL-driven auto-load.

Key architectural fact: the shell communicates with the viewer through **7 distinct integration points**, not a single API surface. These are: drawer shim, status bar frame patch, resize observer, `file-selected` event, `camera-focus-changed` event, direct `viewer.cameraController` access, and direct `viewer.grids` access.

## 2. Integration Surface Analysis: How Would You Even Connect?

### The core problem

Every framework on the table (VSCode web, Theia, OpenVSCode Server) uses **Monaco Editor** as their text editing surface. This project uses a **WebGL canvas** rendered by Three.js. These are fundamentally different rendering paradigms.

**Custom Editor Provider (VSCode/Theia)**

VSCode's `CustomEditor` API lets you replace the text editor with a webview. But:
- A webview is an iframe sandbox with its own origin. The Three.js scene, GlyphAtlas, services, and command system all live in the main frame.
- The 3D canvas needs to be THE primary viewport -- not a panel inside an editor tab. In the current architecture, `#editor-area` IS the canvas. Tabs trigger camera movement (`focusOnGrid()`), not document switches.
- The webview messaging API (`postMessage`/`onMessage`) would become the only way to communicate between the framework shell and the renderer. Every one of those 7 integration points becomes an async message channel.
- You'd need to serialize/deserialize `THREE.Vector3` positions, glyph counts, FPS data, and grid arrays across the iframe boundary 60 times per second for the status bar alone.

**Webview Panel (VSCode/Theia)**

The WebGL canvas could live in a webview panel. Same iframe isolation problem. Additionally:
- Webview panels can be moved/tabbed/split by the framework. This breaks the assumption that there is exactly one persistent 3D viewport.
- WebGL context loss events during panel transitions would destroy all GPU state (atlas texture, instanced buffers, shader programs). Recovery would require full re-initialization.
- The `CommandBar` does click-to-target raycasting against `TerminalGrid._background` meshes. Raycasting requires same-origin access to `viewer.camera`, `viewer.renderer.domElement`, and the Three.js scene graph. Through a webview iframe, this is impossible without a custom RPC layer.

**Direct DOM embedding (no iframe)**

Theia has slightly more flexibility here -- it's designed for extensibility. You could potentially create a Theia widget that directly hosts the canvas. But:
- Theia widgets participate in the framework's layout system (dock panels, split views). The 3D canvas needs to receive ALL available space after subtracting the sidebar/bottom panel, which is exactly what the current CSS Grid does.
- Theia's widget lifecycle (attach/detach/activate) would need to manage WebGL context creation/teardown. The current system creates it once and never destroys it.

### Verdict on integration surface

There is no clean integration point. The WebGL canvas is not a document editor, it is the entire application viewport. Framework editor APIs assume text documents with cursor positions, selections, and undo stacks. The glyph3d IDE has none of these -- it has camera position, grid focus, and 3D spatial navigation.

## 3. Build System Impact

Current state: **zero build tooling**. The project uses:
- `python3 -m http.server 8000` as the dev server
- Native ES modules with `importmap` for Three.js CDN resolution
- Direct `import` paths (`../../src/services/utils/platform.js`)

Framework requirements:

| Framework | Build System | Bundle Size (shell only) | Dev Server |
|-----------|-------------|------------------------|------------|
| Current custom | None | 0 (served as-is) | python3 HTTP |
| VSCode web (code-server) | webpack + custom | ~15-25 MB | Node.js |
| Eclipse Theia | webpack/esbuild | ~20-30 MB | Node.js + express |
| OpenVSCode Server | webpack + custom | ~15-25 MB | Node.js |

Adopting any framework means:
1. **npm dependency explosion**: VSCode web pulls in ~400+ packages. Theia pulls in ~600+. Current project has 2 devDependencies (`three`, `ws`).
2. **Mandatory transpilation**: Framework extensions use TypeScript. The project is pure JavaScript with JSDoc. You'd either write extensions in TS (diverging from codebase conventions) or add a JS->JS pass (pointless complexity).
3. **Import path rewriting**: The 5,920 lines in `src/services/` use relative imports like `../../src/services/orchestration/CommandRouter.js`. A bundler would need to resolve these, and the services are designed to be consumed as bare ES modules.
4. **Development friction**: Every change now requires a rebuild step. Current workflow is edit-save-refresh. Framework workflow is edit-save-wait-for-webpack-refresh.
5. **Deployment change**: Production serving via Caddy currently points at static files. A framework would require a Node.js backend process (code-server, Theia backend) in addition to or replacing Caddy.

## 4. Architecture Fit

### Current layering

```
src/                          (rendering core: GlyphAtlas, GlyphRenderer, CodeGrid, TerminalGrid)
  src/services/               (21 composable services: 5,920 LOC)
    examples/github-viewer/   (application: viewer, commands, websocket)
      examples/ide/           (shell: DOM layout wrapper, 2,960 LOC)
```

The IDE shell sits at the outermost layer. It has zero imports from `src/` except one utility (`primaryMod` from `src/services/utils/platform.js`). It talks to the viewer, not the rendering core. This is a good separation.

### What a framework replaces

A framework would replace the 2,960-line shell layer. But it would also:

- **Conflict with src/services/orchestration/**: `CommandRouter` (custom command dispatch), `WebSocketBridge` (custom WS protocol), and `ViewerAPI` (programmatic facade) implement exactly the kind of extension-host-like infrastructure that VSCode/Theia already have. You'd have two command systems, two RPC layers, two extension APIs -- or you'd throw away 1,500+ lines of working, tested command infrastructure to use the framework's version.
- **Conflict with window management**: `TUIWindowManager` creates 3D windows (`TUIWindow` instances using `TerminalGrid`) positioned in scene space. VSCode/Theia manage 2D DOM panels. These are fundamentally different spatial models. The framework's window management operates in pixel coordinates; the project's operates in world-space 3D coordinates.
- **Conflict with selection/navigation**: The current `SelectionManager` tracks selected file paths and emits `file-selected` events that trigger camera movement to 3D positions. A framework's file explorer triggers document-open events that load text into Monaco. These are incompatible metaphors unless you build an adapter layer that translates every framework event into a 3D navigation action.

### What a framework adds that you'd actually use

Realistically: the activity bar, sidebar panels, tab strip, status bar, and keyboard shortcut framework. That is exactly the 2,960 lines you already have. The framework would provide these "for free" but with the integration tax described above.

What you would NOT use from the framework: Monaco editor, text editing, language services, debug adapter protocol, source control API, terminal emulator, task runner, extension marketplace.

## 5. WebSocket/TUI Command Mapping

Current architecture:

```
CLI (glyph-cli.mjs) --> WS relay (ws-relay.mjs) --> WebSocketBridge --> CommandRouter --> 21 command modules
                                                                                              |
                                                                                  TerminalGrid / TUIWindow
```

The `CommandRouter` has 21 command modules (5,418 LOC) covering grid manipulation, camera control, terminal I/O, window management, layout, search, annotations, spatial queries, and scene composition.

**VSCode's extension host protocol** uses JSON-RPC over a dedicated connection. It is designed for language server protocol (LSP), debug adapter protocol (DAP), and extension API calls. It does NOT have equivalents for:
- `grid.create` / `grid.remove` (3D scene object manipulation)
- `terminal.input` with base64-encoded ANSI (sending raw bytes to a TerminalGrid)
- `camera.move` / `camera.animate` (3D camera control)
- `window.create` / `window.write` (TUI window management in 3D space)
- `spatial.query` / `spatial.nearest` (3D spatial lookups)

You would need to keep the entire CommandRouter + WebSocketBridge system AND add the framework's extension host. Two RPC systems, two command dispatchers, maintained in parallel.

**Theia's RPC** is more flexible (custom backend services via inversify DI), but you'd still need to bridge Theia's frontend-backend protocol to the existing CommandRouter. The glue code alone would likely exceed the current shell's 2,960 lines.

## 6. The 3D Agent Window Vision

The vision: AI agents spawn dynamic `TerminalGrid`/`TUIWindow` instances in 3D space that grow freely with content. Agents write to these windows via the command system (`terminal.input`, `window.write`). Windows are spatially positioned near relevant CodeGrids.

**Framework window management** operates in 2D pixel space with dock panels, split views, and tab groups. This is actively hostile to the vision:
- Framework panels cannot be positioned at `{ x: -100, y: 50, z: 0 }` in world space.
- Framework panels have fixed sizes determined by CSS, not dynamic sizes determined by content line count.
- Framework panels are part of the DOM layout. Agent windows are Three.js `Object3D` instances in the scene graph.

The current `TUIWindowManager.create()` spawns a window at auto-calculated 3D coordinates. The framework equivalent would be `vscode.window.createWebviewPanel()` -- a flat 2D panel with iframe isolation. These are not the same thing and cannot be made to be the same thing without abandoning the 3D spatial model entirely.

**If you want agents to interact with both 2D panels and 3D windows**, you'd need to maintain both systems. The framework provides 2D panels; the existing TUIWindowManager provides 3D windows. Every agent action would need to decide which system to target. This doubles the surface area without adding capability.

## 7. Concrete LOC and Maintenance Comparison

### Current custom shell

| Component | LOC | Maintenance burden |
|-----------|-----|-------------------|
| IDEShell.js | 1,007 | Low -- stable DOM wiring, rarely changes |
| ide.css | 1,150 | Low -- CSS variables, dark theme, responsive |
| ide.html | 330 | Low -- static scaffold |
| CommandBar.js | 463 | Medium -- evolves with command system |
| **Total** | **2,960** | **~20 hrs/year estimated** |

### Framework integration (estimated)

| Component | LOC | Notes |
|-----------|-----|-------|
| Extension manifest + activation | 200-300 | `package.json` contributes, extension entry |
| Custom editor provider + webview | 500-800 | Iframe bridge, message protocol |
| Webview content (canvas host) | 300-500 | Re-embed the Three.js canvas inside webview |
| Message bridge (shell <-> webview) | 400-600 | Serialize all 7 integration points as RPC |
| Custom views (sidebar panels) | 300-500 | TreeView providers for explorer, search |
| Status bar items | 100-200 | StatusBarItem API calls |
| Command palette contributions | 100-200 | Command registration mirroring CommandRouter |
| Build configuration | 200-400 | webpack/esbuild config, tasks, launch configs |
| Bridge: framework commands -> CommandRouter | 300-500 | Translate framework events to existing system |
| **Total new code** | **2,400-4,000** | **More than current shell** |
| **Framework dependency** | **~25 MB** | **500+ npm packages** |
| **Maintenance burden** | **High** | **Framework upgrades, API deprecations, extension API changes** |

The framework path produces MORE code (the bridge layer) while adding a massive dependency tree. It does not reduce maintenance -- it shifts it from "maintain your own simple shell" to "maintain your compatibility layer against a moving framework target."

## 8. Recommendation

**Build custom. The integration cost of any framework exceeds the cost of the current shell.**

The current 2,960-line shell is already working in production. It is thin, it has clear boundaries, and it imposes zero build tooling. A framework would add 2,400-4,000 lines of bridge code, 500+ npm dependencies, a mandatory build step, and an ongoing compatibility maintenance burden -- all to gain an activity bar and sidebar that you already have.

The one scenario where a framework makes sense is if the project pivots to include traditional text editing (Monaco-based code editing alongside 3D visualization). If that happens, the economics change. But for the current vision -- 3D spatial code visualization with agent-driven TUI windows growing in infinite space -- a framework's window management model is structurally incompatible.

### What to invest in instead

1. **Harden the existing shell**: Add component tests for IDEShell panel switching, resize behavior, and tab management. Current test coverage is zero.
2. **Extract the shell from examples/**: Per the memory note, the IDE is a production app, not an example. Move it to a top-level `app/` or `ide/` directory.
3. **Formalize the 7 integration points**: The viewer-shell interface is ad-hoc (event listeners, monkey-patched methods, direct property access). Define an explicit `ViewerShellInterface` that the shell programs against.
4. **Invest in the command system**: The CommandRouter + 21 command modules are the actual extensibility layer. This is where framework-like capabilities (plugin registration, lifecycle hooks, scoped contexts) should be built -- not imported from a framework designed for a different problem.

---

*Analysis based on: IDEShell.js (1007 LOC), ide.html (330 LOC), ide.css (1150 LOC), CommandBar.js (463 LOC), src/services/ (5,920 LOC across 21 services), websocket commands (5,418 LOC across 21 modules), TUIWindowManager.js, TerminalGrid.js (512 LOC), package.json (2 devDependencies, zero build tooling).*

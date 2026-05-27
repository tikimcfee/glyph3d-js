# CLAUDE.md - Project Guide for AI Assistants

## ⚠️ Active architectural overhaul (started 2026-05-26)

This repo is mid-overhaul. **Several sections below describe the PRE-overhaul
architecture; where they conflict with this block, this block wins.** Full living
context is in agent memory (`project_architecture_overhaul`,
`reference_r3f_webgpu_integration`) and the repo-root planning docs
(`AUDIT.md`, `AUDIT_DREAM.md`, `REFACTOR_PLAN.md`, and **`IDE_CLIENT_PLAN.md`** —
the active plan: rebuild the IDE as an r3f client on the core, command-bus-first).
Current truth:

- **Renderer is WebGPU.** `GlyphField` (WebGPU / TSL NodeMaterial) is the one
  renderer; the WebGL `GlyphRenderer` was deleted. Shaders are **TSL, not GLSL**.
  Pages use `THREE.WebGPURenderer` and import three from `three/webgpu`.
- **Monorepo + build step, in progress.** The core library now lives in
  `packages/glyph3d-core/` as **`@glyph3d/core`** (moved out of repo root, commit
  `b0116f0`). `packages/glyph3d-r3f` holds the react-three-fiber bindings. The
  repo root is a **private bun-workspace umbrella** (name `glyph3d`, no exports);
  consumers depend on `"@glyph3d/core": "workspace:*"`. The browser-served app
  (ide/home/viewer, served by the Go binary) resolves core via an importmap prefix
  `"@glyph3d/core/": "/packages/glyph3d-core/src/"`; `new URL(...)` font loads +
  JSDoc type-imports stay relative (importmaps don't touch those). New
  apps/packages build with **Vite**; the "no build step" ethos is being reversed
  (Vite HMR replaces edit-and-refresh). **NB:** the Project Structure section
  below still draws `src/` at root — read it as `packages/glyph3d-core/src/`.
- **Dev loop:** the `/webgpu-dev-loop` skill. TL;DR: `cd apps/home && bun run dev`
  (Vite, :5173), open via `tools/dev-firefox.sh <url>` (NVIDIA-pinned WebGPU
  Firefox), read the browser console from `apps/home/console.log`. (`apps/home` is
  the promoted keystone — the r3f client + command center; the old vanilla /home
  was deleted. The Go relay still serves :8080 for the command bus.)
- **Cleanup in flight:** core-survivor dedups (`zDistanceForFit`,
  `resolveGridByIdOrIndex` done) — running checklist in memory.

## Project Overview

glyph3d-js is a GPU-instanced 3D text rendering library for Three.js. It renders thousands of text glyphs at 60fps using a single draw call via `InstancedBufferGeometry`. The primary use case is code visualization — displaying source files, directory trees, and text content in navigable 3D space.

## Tech Stack

- **Language**: JavaScript (ES Modules, `"type": "module"`)
- **Runtime**: Browser (WebGL 2, Web Workers, Canvas 2D)
- **Framework**: Three.js (peer dependency, >=0.150.0)
- **Build**: None for JS — native ES modules served directly. Go binary: `make build`
- **Server**: `glyph3d-cli serve` — single Go binary (HTTP + WebSocket + embedded assets)
- **Package Manager**: npm (dev only — no runtime npm dependencies)

## Project Structure

```
src/
├── index.js                    # Main entry point & all exports
├── GlyphAtlas.js               # Font texture atlas (shelf-packing, Canvas 2D)
├── GlyphRenderer.js            # Core GPU-instanced renderer (v1.5)
├── core/
│   ├── constants.js            # Shared constants (PERF_THRESHOLDS, DEBUG_SETTINGS)
│   ├── canvasSize.js           # getCanvasViewportSize() — container-aware sizing
│   ├── renderOrder.js          # Centralized renderOrder bands
│   └── types.js                # Shared JSDoc typedefs
├── collections/
│   ├── GlyphCollection.js     # Batched deferred text rendering
│   ├── CodeGrid.js            # Single source file as 3D object (extends Object3D)
│   ├── GridVirtualizer.js     # Frustum-based scene graph culling
│   ├── GridLayoutManager.js   # Row/column/plane spatial positioning
│   ├── HierarchicalLayoutManager.js  # Directory-tree layout mapping
│   └── index.js
├── picking/
│   ├── PickingSystem.js       # GPU picking via material-swap second render pass
│   └── index.js
├── semantic/
│   ├── SemanticInfoMap.js     # Token-to-glyph mapping (pure data structure)
│   ├── GlyphEvents.js         # Event types + bus for hover/click
│   └── index.js
├── components/
│   └── MinimapOverlay.js      # 2D canvas minimap overlay
├── workers/
│   ├── WorkerBridge.js        # Worker pool (round-robin, auto-fallback)
│   ├── GlyphWorker.js         # Worker thread entry point
│   └── builders/
│       ├── index.js
│       ├── buildBuffers.js    # Single-pass text → Float32Array
│       ├── textToGlyphs.js   # Text → glyph conversion
│       └── layoutText.js     # Text layout computation
├── layout/                    # Older layout subsystem (partially deprecated)
│   ├── GlyphLayout.js
│   ├── GlyphBatcher.js
│   └── GlyphInstancePool.js
├── camera/
│   ├── CameraController.js   # Physics-based camera movement
│   ├── InputManager.js        # Keyboard/mouse input
│   └── Camera.js
└── utils/
    ├── index.js
    ├── encoding.js            # UTF-8-safe base64 encode/decode
    ├── Logger.js              # Structured logging (DEBUG/INFO/WARN/ERROR)
    ├── Metrics.js             # Performance metric tracking
    ├── ErrorTracker.js        # Error aggregation & reporting
    ├── DebugConsole.js        # In-browser debug UI overlay
    └── FPSCounter.js          # Frame rate monitoring

app/                           # IDE application (ivanlugo.dev/ide)
├── ide.html                   # IDE shell entry point
├── ide.css
├── viewer.html                # GitHub 3D viewer entry point
├── viewer.css
├── IDEShell.js                # IDE chrome orchestrator
├── GitHubRepoViewer.js        # Main viewer application
├── StatePersistence.js        # localStorage state save/restore
├── components/                # App-level UI components
│   ├── AppShell.js
│   ├── CommandBar.js
│   ├── DiffPanel.js
│   ├── Drawer.js
│   ├── LogCapturePanel.js
│   └── TouchController.js
├── commands/                  # Command system (WebSocket + local)
│   ├── index.js               # Command center bootstrapper
│   └── handlers/              # Individual command modules
│       ├── index.js
│       ├── highlightCommands.js  # Glyph-level highlight (char, range, line, token)
│       └── ...Commands.js     # ~17 command handler files
└── cli/
    └── CodeTour.mjs           # Standalone tour library

cli/                           # Go single-binary server + CLI
├── main.go                    # Entry point: serve, hook, screenshot, REPL, one-shot
├── relay.go                   # WebSocket relay + unified HTTP server (RunServer)
├── fs.go                      # Sandboxed filesystem JSON-RPC handler
├── hook.go                    # Claude Code hook integration
├── embed.go                   # go:embed directive — bakes web assets into binary
├── go.mod
└── .gitignore                 # Ignores web/ staging dir

Makefile                       # Build system: make, make all, make deploy, make clean

examples/
├── picking-test/              # GPU picking + highlight system test page
├── word-wall/                 # Dictionary word visualization
├── code-spectrometer/         # Periodic table of software concepts
├── mod-layer-visualizer/      # Modular arithmetic grid visualizer
├── hand-tracking/             # Hand pose visualization
├── cross-ref-viz/             # Multi-agent cross-ref animation
└── render-test/               # Automated rendering tests
```

## Key Architecture Concepts

### Single-Binary Server (cli/)
- `glyph3d-cli serve` runs a unified HTTP + WebSocket server on one port
- All static assets (src/, app/, examples/) are embedded via Go `//go:embed` at build time
- `make build` copies assets into `cli/web/`, Go bakes them in, binary is self-contained (~8MB)
- WebSocket upgrade requests route to the relay; regular HTTP serves embedded (or disk) files
- Filesystem JSON-RPC (`fs/readFile`, `fs/listTree`, etc.) is always on, sandboxed to the project path
- `--local` flag swaps embedded assets for disk serving (IDE development only)
- Cross-compilation via `make all` produces static binaries for 5 platform targets
- `WebSocketBridge` auto-detects the server port from `window.location` (no hardcoded port)

### Rendering Pipeline
1. **GlyphAtlas** generates a font texture atlas using Canvas 2D with shelf-packing
2. **GlyphCollection** (or **GlyphRenderer**) batches text operations with deferred updates
3. **WorkerBridge** optionally offloads buffer computation to Web Workers
4. **Buffer Builders** do single-pass text → Float32Array conversion (zero-allocation hot paths)
5. Shaders are GLSL ES 3.00 (`THREE.GLSL3`) inline strings in GlyphRenderer.js (vertex + fragment)
6. Everything renders as a single Three.js instanced draw call
7. **GridVirtualizer** frustum-culls CodeGrids — only visible grids are in the scene graph

### Instance Attributes (10 floats = 40 bytes/glyph)
- `instancePosition` vec3, `instanceSize` vec2 (per-glyph from atlas metrics), `instanceCodepoint` float
- `instanceColor` vec3, `instanceGroupId` float
- Highlight: RGBA8 DataTexture (1024-wide, 2D wrap), sampled via `texelFetch` + `gl_InstanceID`
- Picking ID: derived as `uBasePickingId + gl_InstanceID` uniform in picking shader (no attribute)

### GPU Picking System (src/picking/PickingSystem.js)
- Material-swap second render pass: swaps picking shaders onto glyph meshes, renders same scene to offscreen RGBA8 target, reads 1 pixel, swaps back
- 24-bit picking ID encoded as RGB per glyph quad (16M unique IDs)
- Only runs when mouse has moved (`needsPick` dirty flag)
- Auto-resizes render target to match canvas
- `resolve(pickingId)` → `{ renderer, slotIndex }`, `resolveGlyph()` → `{ textId, charIndex }`
- Two modes: `'cell'` (full quad, default) or `'glyph'` (alpha-tested against atlas strokes)

### Glyph Highlighting
- `CodeGrid._lineSlotBase`: Int32Array mapping line→buffer slot, built by the buffer builder in the same render pass (lineSlotOffsets in itemMeta)
- `CodeGrid.highlightRange(startLine, startCol, endLine, endCol, color)` — additive color
- `GlyphRenderer.setGlyphHighlight(bufferSlotIndex, color)` — writes RGBA8 texel to highlight DataTexture
- All metrics derived from GlyphAtlas at runtime — no hardcoded character dimensions
- Per-glyph widths: builders use `glyphWidths[charCode] * worldScale` from atlas metrics, not a fixed charWidth

### Frustum Culling (src/collections/GridVirtualizer.js)
- Adds/removes CodeGrids from the scene based on camera frustum intersection
- At 1500 files, only ~10-50 visible grids get draw calls instead of all 1500
- Hysteresis (50 world units) prevents popping during small camera movements
- Dirty flag forces re-evaluation after registration; camera-movement throttle skips static frames
- Canvas viewport sizing via `getCanvasViewportSize()` (src/core/canvasSize.js) — uses container dimensions, not window.innerWidth/Height

### Deferred Pattern
Operations like `addText()` are queued. Nothing hits the GPU until `flush()` is called. This allows batching and right-sizing buffers.

### Worker System
- Pool of `navigator.hardwareConcurrency - 1` workers (default 3)
- Round-robin job distribution
- Promise-based async API
- Automatic main-thread fallback if workers unavailable
- UV map caching to avoid redundant transfers

### Key Constants (src/core/constants.js)
- `PERF_THRESHOLDS.maxInstancesPerMesh`: 10,000 (auto-splits beyond)
- `PERF_THRESHOLDS.targetFPS`: 60
- `DEBUG_SETTINGS`: Controlled via `process.env.DEBUG_RENDERING`
- Character dimensions are NOT constants — derived from GlyphAtlas at runtime

## Development Commands

### Single-binary build (Go CLI)

```bash
make                 # Build glyph3d-cli for current platform (~8MB)
make all             # Cross-compile: Linux/macOS/Windows × amd64/arm64
make deploy          # Build linux-amd64 + show scp command for your-server
make clean           # Remove build artifacts
```

### Running the server

```bash
./glyph3d-cli serve                    # Browse cwd, embedded IDE app, port 8080
./glyph3d-cli serve ~/some-project     # Browse a specific project
./glyph3d-cli serve --local            # IDE dev: serve app from disk (live-edit JS)
./glyph3d-cli serve --port 3000        # Custom port
./glyph3d-cli serve --relay-only       # WebSocket relay only (legacy)
```

Then open: `http://localhost:8080/app/ide.html`

### Other CLI modes

```bash
./glyph3d-cli grid.list                # One-shot command
./glyph3d-cli                          # Interactive REPL
echo "grid.list" | ./glyph3d-cli      # Pipe mode
./glyph3d-cli hook                     # Claude Code hook (called by settings.json)
./glyph3d-cli screenshot -o snap.png   # Capture 3D canvas
```

### JS development (no Go build needed)

```bash
npm install          # Install three.js devDependency
./glyph3d-cli serve --local            # Serve from disk — edits show on refresh
```

There is no JS build step, test runner, or linter configured. Source files are served as-is.

## Code Conventions

- **ES Modules** throughout (`import`/`export`, no CommonJS)
- **Default exports** for classes, **named exports** for utilities and constants
- **JSDoc comments** on public methods with `@param` and `@returns`
- **No TypeScript** — plain JavaScript with JSDoc for type hints
- Position objects use `{ x, y, z }` format
- Color objects use `{ r, g, b }` format (0-1 range)
- Classes that represent 3D objects extend `THREE.Object3D` (e.g., CodeGrid)
- Worker-compatible code in `src/workers/builders/` avoids DOM/Three.js dependencies

## Package Exports

```javascript
import { ... } from 'glyph3d-js';             // Everything
import { ... } from 'glyph3d-js/collections';  // GlyphCollection, CodeGrid, layout managers
import { ... } from 'glyph3d-js/workers';      // WorkerBridge
import { ... } from 'glyph3d-js/utils';        // Logger, Metrics, ErrorTracker, DebugConsole, encoding
import { ... } from 'glyph3d-js/tui';          // TUIWindow, TUIWindowManager, TUIFocusManager, TUIFormatter
import { PickingSystem } from 'glyph3d-js/picking';  // GPU glyph picking
import { SemanticInfoMap, GlyphEventBus } from 'glyph3d-js/semantic';  // Token mapping, events
```

## Common Tasks

### Adding a new glyph character set
Modify `GlyphAtlas.js` — add character ranges in the `generate()` method alongside existing ASCII, box-drawing, and Latin-1 ranges.

### Adding a new layout strategy
Create a new class in `src/collections/` following the pattern of `GridLayoutManager.js`. It should accept CodeGrid instances and set their `.position` properties.

### Modifying the shader
Edit inline GLSL in `GlyphRenderer._getVertexShader()`/`_getFragmentShader()` — these are the canonical and only copies. All shaders use GLSL ES 3.00 syntax (`in`/`out`, `texture()`, `texelFetch`, `gl_InstanceID`). Picking shaders are inline in `PickingSystem.js`.

### Adding new builder logic for workers
Add functions in `src/workers/builders/`. These must be pure functions with no DOM or Three.js imports (they run in Web Worker context).

## Performance Notes

- Atlas generation is ~200ms one-time cost
- Buffer builders use single-pass algorithms to minimize allocations
- The max instances per mesh is 10,000; exceeding this auto-splits into multiple meshes
- Long lines wrap in Z-depth to keep content spatially compact
- GlyphCollection uses dirty tracking to avoid redundant GPU uploads
- Per-glyph cost: 40 bytes (10 floats across 5 instance attributes) + 4 bytes RGBA8 highlight texture
- Picking pass only runs on mousemove (zero cost when pointer is stationary)
- Picking ID derived from `uBasePickingId + gl_InstanceID` — no per-glyph attribute
- Atlas map DataTexture sized to actual charset (~160 KB), auto-regrows for new codepoints
- Highlight DataTexture: RGBA8, 1024-wide 2D wrap, per-glyph additive color (4th byte reserved for blend mode)
- GridVirtualizer: frustum culling eliminates ~97% of draw calls at 1500-file scale
- `addUpdateRange()` for partial GPU uploads — only changed buffer regions are uploaded
- `getCanvasViewportSize()` ensures camera/renderer match actual canvas container, not window
- Workers receive per-glyph widths from atlas metrics for proportional text layout

## Deployment

### Public site (ivanlugo.dev/ide)
- Caddy serves static files — each browser tab is self-contained (client-side rendering, no server state)
- Server: the host `your-server` (0.0.0.0), SSH via `ssh your-server`
- Caddy config: `/etc/caddy/Caddyfile`

### Single binary (personal / dev use)
- `make deploy` → `scp dist/glyph3d-cli-linux-amd64 your-server:/usr/local/bin/glyph3d-cli`
- `glyph3d-cli serve ~/project` — embedded IDE + relay + filesystem, single-user
- Single display connection, shared relay state, no auth — designed for one operator

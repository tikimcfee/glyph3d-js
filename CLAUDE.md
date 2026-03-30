# CLAUDE.md - Project Guide for AI Assistants

## Project Overview

glyph3d-js is a GPU-instanced 3D text rendering library for Three.js. It renders thousands of text glyphs at 60fps using a single draw call via `InstancedBufferGeometry`. The primary use case is code visualization — displaying source files, directory trees, and text content in navigable 3D space.

## Tech Stack

- **Language**: JavaScript (ES Modules, `"type": "module"`)
- **Runtime**: Browser (WebGL 2, Web Workers, Canvas 2D)
- **Framework**: Three.js (peer dependency, >=0.150.0)
- **Build**: None — native ES modules served directly
- **Server**: `python3 -m http.server 8000` via `npm run serve`
- **Package Manager**: npm

## Project Structure

```
src/
├── index.js                    # Main entry point & all exports
├── GlyphAtlas.js               # Font texture atlas (shelf-packing, Canvas 2D)
├── GlyphRenderer.js            # Core GPU-instanced renderer (v1.5)
├── core/
│   ├── constants.js            # Shared constants (CHAR_DIMENSIONS, PERF_THRESHOLDS, DEBUG_SETTINGS)
│   ├── ShaderManager.js        # GLSL shader loading & caching
│   └── InstanceBuffer.js       # Instance attribute array building
├── shaders/
│   ├── textVertex.glsl         # Vertex shader (per-instance position, size, UV, color)
│   └── textFragment.glsl      # Fragment shader (atlas sampling, color tint, alpha discard)
├── collections/
│   ├── GlyphCollection.js     # Batched deferred text rendering
│   ├── CodeGrid.js            # Single source file as 3D object (extends Object3D)
│   ├── GridLayoutManager.js   # Row/column/plane spatial positioning
│   ├── HierarchicalLayoutManager.js  # Directory-tree layout mapping
│   └── index.js
├── tui/                       # 3D terminal window components
│   ├── index.js               # Barrel export
│   ├── TUIWindow.js           # Terminal pane backed by CodeGrid
│   ├── TUIWindowManager.js    # Window lifecycle manager
│   ├── TUIFocusManager.js     # Click-to-focus & keystroke routing
│   └── TUIFormatter.js        # Box-drawing, tables, padding utilities
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
├── ws-relay.mjs               # Node.js WebSocket relay server
├── ws-relay.py                # Python WebSocket relay server
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
│       └── ...Commands.js     # ~16 command handler files
└── cli/                       # Node.js CLI client
    ├── glyph-cli.mjs
    └── ...

examples/
├── word-wall/                 # Dictionary word visualization
├── code-spectrometer/         # Periodic table of software concepts
├── mod-layer-visualizer/      # Modular arithmetic grid visualizer
├── hand-tracking/             # Hand pose visualization
├── cross-ref-viz/             # Multi-agent cross-ref animation
└── render-test/               # Automated rendering tests
```

## Key Architecture Concepts

### Rendering Pipeline
1. **GlyphAtlas** generates a font texture atlas using Canvas 2D with shelf-packing
2. **GlyphCollection** (or **GlyphRenderer**) batches text operations with deferred updates
3. **WorkerBridge** optionally offloads buffer computation to Web Workers
4. **Buffer Builders** do single-pass text → Float32Array conversion (zero-allocation hot paths)
5. **ShaderManager** loads GLSL shaders; the vertex/fragment shaders handle per-instance rendering
6. Everything renders as a single Three.js instanced draw call

### Deferred Pattern
Operations like `addText()` are queued. Nothing hits the GPU until `flush()` is called. This allows batching and right-sizing buffers.

### Worker System
- Pool of `navigator.hardwareConcurrency - 1` workers (default 3)
- Round-robin job distribution
- Promise-based async API
- Automatic main-thread fallback if workers unavailable
- UV map caching to avoid redundant transfers

### Key Constants (src/core/constants.js)
- `CHAR_DIMENSIONS`: Fallback glyph size (0.6 x 1.0 world units)
- `PERF_THRESHOLDS.maxInstancesPerMesh`: 10,000 (auto-splits beyond)
- `PERF_THRESHOLDS.targetFPS`: 60
- `DEBUG_SETTINGS`: Controlled via `process.env.DEBUG_RENDERING`

## Development Commands

```bash
npm install          # Install dependencies (pulls three.js as devDependency)
npm run serve        # Start python3 HTTP server on port 8000
```

Then open:
- `http://localhost:8000/app/ide.html`
- `http://localhost:8000/app/viewer.html`
- `http://localhost:8000/examples/word-wall/`

There is no build step, test runner, or linter configured. Source files are served as-is.

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
```

## Common Tasks

### Adding a new glyph character set
Modify `GlyphAtlas.js` — add character ranges in the `generate()` method alongside existing ASCII, box-drawing, and Latin-1 ranges.

### Adding a new layout strategy
Create a new class in `src/collections/` following the pattern of `GridLayoutManager.js`. It should accept CodeGrid instances and set their `.position` properties.

### Modifying the shader
Edit `src/shaders/textVertex.glsl` and `textFragment.glsl`. The ShaderManager loads these via fetch at runtime.

### Adding new builder logic for workers
Add functions in `src/workers/builders/`. These must be pure functions with no DOM or Three.js imports (they run in Web Worker context).

## Performance Notes

- Atlas generation is ~200ms one-time cost
- Buffer builders use single-pass algorithms to minimize allocations
- The max instances per mesh is 10,000; exceeding this auto-splits into multiple meshes
- Long lines wrap in Z-depth to keep content spatially compact
- GlyphCollection uses dirty tracking to avoid redundant GPU uploads

# glyph3d-js

High-performance 3D text rendering for [Three.js](https://threejs.org/) using GPU-instanced glyphs.

Render thousands of text elements at 60fps with a single draw call.

## Features

- **GPU Instanced Rendering** - Thousands of glyphs in a single draw call via `InstancedBufferGeometry`
- **Dynamic Glyph Atlas** - Shelf-packed font texture with automatic character addition (ASCII, box-drawing, block elements, Latin-1)
- **Web Worker Parallelization** - Buffer computation off the main thread with automatic fallback
- **Flexible Layout System** - Grid, hierarchical, and custom 3D layouts
- **CodeGrid Abstraction** - Source code visualization with backgrounds, labels, and spatial bounds
- **Camera Controls** - Built-in physics-based camera with keyboard/mouse input handling
- **Observability** - Structured logging, metrics, error tracking, and in-browser debug console
- **Zero-dependency Core** - Only Three.js as peer dependency
- **No Build Step** - Native ES modules, works directly in modern browsers

## Quick Start

```bash
npm install glyph3d-js three
```

```javascript
import * as THREE from 'three';
import { GlyphAtlas, GlyphCollection } from 'glyph3d-js';

// Setup Three.js scene
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer();
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// Create glyph atlas (generates font texture)
const atlas = new GlyphAtlas('Monaco, Menlo, monospace', 48);
await atlas.generate();

// Create a collection for batched text
const collection = new GlyphCollection(scene, atlas);

// Add text
collection.addText('Hello, 3D World!', { x: 0, y: 0, z: 0 });
collection.addText('GPU-accelerated text', { x: 0, y: -2, z: 0 });
collection.flush(); // Send to GPU

// Render loop
function animate() {
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
}
animate();
```

## Architecture

```
Text Input
    ↓
GlyphAtlas              →  Font texture generation & UV mapping (shelf-packing)
    ↓
GlyphCollection         →  Batched text operations with deferred GPU updates
    ↓
CodeGrid                →  File visualization (background, filename, content)
    ↓
GridLayoutManager       →  3D spatial positioning of multiple grids
HierarchicalLayoutManager  →  Directory-tree-based layout mapping
    ↓
WorkerBridge (optional) →  Parallel buffer computation via Web Workers
    ↓
ShaderManager           →  GLSL vertex/fragment shader loading
    ↓
Three.js InstancedMesh  →  Single draw call GPU rendering
```

### Module Map

| Module | Path | Purpose |
|--------|------|---------|
| **GlyphAtlas** | `src/GlyphAtlas.js` | Font texture atlas generation with shelf-packing |
| **GlyphRenderer** | `src/GlyphRenderer.js` | Core GPU-instanced rendering engine (v1.5) |
| **GlyphCollection** | `src/collections/GlyphCollection.js` | Batched, deferred text rendering abstraction |
| **CodeGrid** | `src/collections/CodeGrid.js` | Single source file as a 3D object (extends Object3D) |
| **GridLayoutManager** | `src/collections/GridLayoutManager.js` | Row/column/plane grid positioning |
| **HierarchicalLayoutManager** | `src/collections/HierarchicalLayoutManager.js` | Directory-tree to 3D space mapping |
| **WorkerBridge** | `src/workers/WorkerBridge.js` | Web Worker pool with round-robin distribution |
| **Buffer Builders** | `src/workers/builders/` | Single-pass text-to-Float32Array conversion |
| **ShaderManager** | `src/core/ShaderManager.js` | GLSL shader loading and caching |
| **InstanceBuffer** | `src/core/InstanceBuffer.js` | Instance attribute array construction |
| **CameraController** | `src/camera/CameraController.js` | Physics-based camera movement |
| **InputManager** | `src/camera/InputManager.js` | Keyboard/mouse input handling |
| **Observability** | `src/utils/` | Logger, Metrics, ErrorTracker, DebugConsole, FPSCounter |

## API Reference

### GlyphAtlas

Generates and manages the font texture atlas using Canvas 2D and a shelf-packing algorithm.

```javascript
const atlas = new GlyphAtlas(fontFamily, fontSize, atlasSize);
await atlas.generate(progressCallback);

// Dynamic glyph addition
atlas.addGlyphIfMissing(charCode);

// Get UV coordinates for a character
const uvs = atlas.getUVForChar(charCode); // → {u0, v0, u1, v1}

// Get character metrics
const size = atlas.getCharSize(); // → {width, height}
```

### GlyphCollection

Batched text rendering with deferred updates. Operations are queued until `flush()` commits them to the GPU.

```javascript
const collection = new GlyphCollection(scene, atlas, {
    maxInstances: 100000,
    defaultColor: { r: 0, g: 1, b: 0 },
    worldScale: 0.1
});

// Add text (deferred until flush)
const id = collection.addText('Text', position, { color: { r: 1, g: 0, b: 0 } });

// Batch operations
collection.addTexts([
    { text: 'Line 1', position: { x: 0, y: 0, z: 0 } },
    { text: 'Line 2', position: { x: 0, y: -2, z: 0 } }
]);

// Commit all pending operations to GPU
collection.flush();

// Collection-level transforms
collection.setPosition({ x: 10, y: 0, z: 0 });
collection.setScale({ x: 2, y: 2, z: 2 });
collection.setRotation({ x: 0, y: Math.PI / 4, z: 0 });
```

### CodeGrid

Source file visualization with optional background panel and filename label. Extends Three.js `Object3D`.

```javascript
const grid = new CodeGrid(scene, atlas, {
    maxChars: 50000,
    showBackground: true,
    backgroundColor: 0x1a1a2e,
    gridScale: 1.0
});

// Load content
grid.loadText(sourceCode, { filename: 'main.js' });

// Position in 3D space (inherits from Object3D)
grid.position.set(0, 0, 0);

// Get bounds for layout calculations
const bounds = grid.getBounds();
```

### GridLayoutManager

Positions multiple CodeGrids in 3D space using row/column/plane placement.

```javascript
const layout = new GridLayoutManager({
    horizontalSpacing: 10,
    verticalSpacing: 8,
    maxRowWidth: 1000
});

layout.addTrailing(grid1);     // Right of previous
layout.addTrailing(grid2);
layout.addInNextRow(grid3);    // New row below
layout.addToNextPlane(grid4);  // Next Z-depth plane
layout.addAuto(grid5);         // Smart positioning
```

### HierarchicalLayoutManager

Maps directory structures to 3D spatial layouts.

```javascript
const layout = new HierarchicalLayoutManager(scene, atlas, {
    depthSpacing: 50,
    breadthSpacing: 10
});
```

### WorkerBridge

Offload buffer computation to a pool of Web Workers.

```javascript
import { getWorkerBridge, isWorkersSupported } from 'glyph3d-js';

if (isWorkersSupported()) {
    const bridge = getWorkerBridge();

    // Build buffers in parallel
    const result = await bridge.buildBuffersAsync({
        text: 'Large text content...',
        position: { x: 0, y: 0, z: 0 },
        metrics: atlas.getCharSize(),
        uvMap: atlas.getUVMapObject()
    });
}
```

### Observability

```javascript
import { createLogger, metrics, errorTracker, initObservability } from 'glyph3d-js';

// Initialize all observability systems
initObservability();

// Structured logging
const log = createLogger('MyModule');
log.info('Rendering started');
log.warn('High instance count', { count: 50000 });

// Performance metrics
metrics.record('atlas.generate', elapsed);

// Error tracking
errorTracker.track(error, { context: 'shader compilation' });
```

## Examples

### Basic Text

```javascript
const collection = new GlyphCollection(scene, atlas);
collection.addText('Hello World', { x: 0, y: 0, z: 0 });
collection.flush();
```

### Code Viewer

```javascript
const grid = new CodeGrid(scene, atlas);
grid.loadText(`
function hello() {
    console.log("Hello, World!");
}
`, { filename: 'hello.js' });
```

### GitHub Repository Viewer

See `examples/github-viewer/` for a complete demo that loads and displays GitHub repositories in 3D space. Includes GitHub API integration, file tree navigation, and content caching.

### Word Wall

See `examples/word-wall/` for a dictionary word visualization demo with interactive 3D word exploration.

### Running Examples

```bash
npm run serve
# Open http://localhost:8000/examples/github-viewer/
# Open http://localhost:8000/examples/word-wall/
```

## Performance

| Metric | Value |
|--------|-------|
| Atlas generation | ~200ms (one-time) |
| Buffer building | Parallel via Web Workers |
| Rendering | Single instanced draw call |
| Max instances per mesh | 10,000 (auto-splits beyond) |
| Target | 60fps with 100,000+ glyphs |

## Package Exports

```javascript
import { ... } from 'glyph3d-js';              // Main entry - all exports
import { ... } from 'glyph3d-js/collections';   // GlyphCollection, CodeGrid, layout managers
import { ... } from 'glyph3d-js/workers';       // WorkerBridge
import { ... } from 'glyph3d-js/utils';         // Logger, Metrics, ErrorTracker, DebugConsole
```

## Browser Support

- Chrome 80+
- Firefox 75+
- Safari 14+
- Edge 80+

Requires WebGL 2 and Web Workers support (Web Workers have automatic main-thread fallback).

## Development

```bash
# Clone the repo
git clone https://github.com/tikimcfee/glyph3d-js.git
cd glyph3d-js

# Install dependencies
npm install

# Serve examples locally
npm run serve
# Open http://localhost:8000/examples/github-viewer/
```

No build step is required. The project uses native ES modules and can be served directly.

## License

MIT

## Credits

Inspired by [SwiftGlyph](https://github.com/nicklockwood/SwiftGlyph) and the need for high-performance text rendering in web-based code visualization tools.

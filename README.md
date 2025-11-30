# glyph3d-js

High-performance 3D text rendering for Three.js using GPU-instanced glyphs.

Render thousands of text elements at 60fps with a single draw call.

## Features

- **GPU Instanced Rendering** - Thousands of glyphs in a single draw call
- **Dynamic Glyph Atlas** - Shelf-packed font texture with automatic character addition
- **Web Worker Parallelization** - Buffer computation off the main thread
- **Flexible Layout System** - Grid, hierarchical, and custom layouts
- **CodeGrid Abstraction** - Source code visualization with backgrounds and labels
- **Zero-dependency Core** - Only Three.js as peer dependency

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
GlyphAtlas         →  Font texture generation & UV mapping
    ↓
GlyphCollection    →  Batched text operations with deferred GPU updates
    ↓
CodeGrid           →  File visualization (background, filename, content)
    ↓
GridLayoutManager  →  3D spatial positioning of multiple grids
```

## API Reference

### GlyphAtlas

Generates and manages the font texture atlas.

```javascript
const atlas = new GlyphAtlas(fontFamily, fontSize, atlasSize);
await atlas.generate(progressCallback);

// Dynamic glyph addition
atlas.addGlyphIfMissing(charCode);

// Get UV coordinates
const uvs = atlas.getUVForChar(charCode);
```

### GlyphCollection

Batched text rendering with deferred updates.

```javascript
const collection = new GlyphCollection(scene, atlas, {
    maxInstances: 100000,
    defaultColor: { r: 0, g: 1, b: 0 },
    worldScale: 0.1
});

// Add text (deferred)
const id = collection.addText('Text', position, { color: { r: 1, g: 0, b: 0 } });

// Batch operations
collection.addTexts([
    { text: 'Line 1', position: { x: 0, y: 0, z: 0 } },
    { text: 'Line 2', position: { x: 0, y: -2, z: 0 } }
]);

// Commit to GPU
collection.flush();

// Transforms
collection.setPosition({ x: 10, y: 0, z: 0 });
collection.setScale({ x: 2, y: 2, z: 2 });
```

### CodeGrid

Source file visualization with background and filename.

```javascript
const grid = new CodeGrid(scene, atlas, {
    maxChars: 50000,
    showBackground: true,
    backgroundColor: 0x1a1a2e,
    gridScale: 1.0
});

// Load content
grid.loadText(sourceCode, { filename: 'main.js' });

// Position in 3D space
grid.position.set(0, 0, 0);

// Get bounds for layout
const bounds = grid.getBounds();
```

### GridLayoutManager

Positions multiple CodeGrids in 3D space.

```javascript
const layout = new GridLayoutManager({
    horizontalSpacing: 10,
    verticalSpacing: 8,
    maxRowWidth: 1000
});

layout.addTrailing(grid1);  // Right of previous
layout.addTrailing(grid2);
layout.addInNextRow(grid3); // New row below
layout.addAuto(grid4);      // Smart positioning
```

### WorkerBridge

Offload buffer computation to Web Workers.

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

See `examples/github-viewer/` for a complete demo that loads and displays GitHub repositories in 3D space.

## Performance

- **Atlas generation:** ~200ms (one-time)
- **Buffer building:** Parallel with Web Workers
- **Rendering:** Single instanced draw call
- **Target:** 60fps with 100,000+ glyphs

## Browser Support

- Chrome 80+
- Firefox 75+
- Safari 14+
- Edge 80+

Requires WebGL 2 and Web Workers support.

## Development

```bash
# Clone the repo
git clone https://github.com/yourusername/glyph3d-js.git
cd glyph3d-js

# Install dependencies
npm install

# Run the GitHub viewer example
npm run dev

# Or use simple HTTP server
npm run serve
# Then open http://localhost:8000/examples/github-viewer/
```

## License

MIT

## Credits

Inspired by [SwiftGlyph](https://github.com/nicklockwood/SwiftGlyph) and the need for high-performance text rendering in web-based code visualization tools.

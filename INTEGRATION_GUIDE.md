# @glyph3d/core Integration & Usage Guide

A practical guide for embedding `@glyph3d/core` into external Three.js applications (such as [`procinsh`](file:///home/ivan/dev/_public/procinsh)), rendering GPU-instanced 3D text, live assembly disassembly, and memory hexdumps with pointer arcs.

---

## 1. Architectural Overview

`@glyph3d/core` renders text directly via vertex-instanced GPU draws on standard **WebGL2** (using `THREE.WebGLRenderer`) and **WebGPU** (using `three/webgpu`).

```
┌──────────────────────────────────────────────────────────────┐
│                    Your Three.js Scene                       │
│                                                              │
│  scene.add(grid)                                             │
│       │                                                      │
│       ▼                                                      │
│  CodeGrid (extends BoundedObject3D -> THREE.Group)           │
│       │                                                      │
│       ├── Background Panel (MeshBasicMaterial)               │
│       ├── InstancedField (InstancedMesh, RawShaderMaterial)  │
│       │        └── InstancedSlotBuffer (32-byte slots)       │
│       └── MemoryEdges (LineSegments + InstancedMesh Cones)   │
└──────────────────────────────────────────────────────────────┘
```

- **Scene Graph Native**: `CodeGrid` is a standard `THREE.Group`. You position, rotate, scale, and add it to any `THREE.Scene` or parent `THREE.Group`.
- **Minimal Draw Calls**:
  - Text: **1 draw call** (up to tens of thousands of glyphs in a single `InstancedBufferGeometry`).
  - Background panel: **1 draw call**.
  - Memory pointer edges: **1 draw call** for line shafts + **1 draw call** for cone arrowheads.
- **Zero Compute Shaders**: No WebGPU compute pipelines or complex buffer readbacks. Standard vertex shaders evaluate glyph geometry, pen position, and colors.

---

## 2. Bootstrapping the Engine

### A. Asset Requirements
The engine requires two static assets:
1. **Monospace Font**: A `.ttf` or `.otf` file (e.g. `Cousine-Regular.ttf` from `@glyph3d/core/fonts/Cousine-Regular.ttf`).
2. **HarfBuzz WASM**: `hb.wasm` for text shaping and outline extraction (from `@glyph3d/core` shaping vendor).

#### Vite Asset Setup (e.g., in `procinsh/web/`)
Copy the assets to your public directory (or import them via Vite):

```bash
# Example: copy into web/public/
mkdir -p web/public/fonts web/public/wasm
cp node_modules/@glyph3d/core/src/fonts/Cousine-Regular.ttf web/public/fonts/
cp node_modules/@glyph3d/core/src/shaping/vendor/hb.wasm web/public/wasm/
```

Alternatively, use Vite's URL import syntax:
```typescript
import fontUrl from '@glyph3d/core/fonts/Cousine-Regular.ttf?url';
```

### B. Bootstrapping Code (`bootGlyphEngine`)
Boot the engine **once** during application or scene startup. The returned `GlyphAtlas` instance is a lightweight handle that should be shared across all grids in your application:

```typescript
import { bootGlyphEngine, GlyphAtlas } from '@glyph3d/core';

let sharedAtlas: GlyphAtlas | null = null;

export async function initGlyph3D(): Promise<GlyphAtlas> {
  if (sharedAtlas) return sharedAtlas;

  sharedAtlas = await bootGlyphEngine({
    fontUrl: '/fonts/Cousine-Regular.ttf',
    wasmUrl: '/wasm/hb.wasm',
    fontSize: 48,
    // Optional: in-memory buffers can also be provided directly:
    // fonts: [{ name: 'primary', buffer: fontArrayBuffer }],
    // wasmBinary: wasmArrayBuffer,
  });

  console.log('[glyph3d] Engine initialized successfully');
  return sharedAtlas;
}
```

---

## 3. Creating & Positioning a 3D Grid

### A. Component Selection: `CodeGrid` vs `InstancedField`
- **Use `CodeGrid` (Recommended)**: Provides built-in background paneling, line margins, line address calculation, line highlighting (`highlightLine`, `highlightRange`), and seamless integration with `decorateMemoryGrid`.
- **Use `InstancedField` directly**: Only if you require a raw, borderless text buffer with zero container chrome.

### B. Instantiation
```typescript
import * as THREE from 'three';
import { CodeGrid, GlyphAtlas } from '@glyph3d/core';

export function createInspectionGrid(atlas: GlyphAtlas): CodeGrid {
  const grid = new CodeGrid(null, atlas, {
    showBackground: true,
    backgroundColor: 0x0a0c16,
    backgroundOpacity: 0.92,
    padding: 12,
  });

  // Scale: Glyph3D internal coordinates use font em units (line height ~48-55 units).
  // In a 3D scene where objects are ~1 to 10 units wide, scale by 0.02 to 0.04.
  grid.scale.setScalar(0.025);

  return grid;
}
```

### C. Positioning, Bounding Box & Billboarding

#### 1. Coordinate System
- Local origin `(0, 0, 0)` is the top-left baseline of the first line.
- Text advances rightward along `+X`.
- Lines advance downward along `-Y` (line 0 at `y = 0`, line 1 at `y = -linePitch`, etc.).
- `grid.getBounds()` or `grid.getLocalBounds()` returns a `THREE.Box3` covering the text and background panel.

#### 2. Leader Line & Positioning Example
```typescript
// Query size in local units
const box = grid.getLocalBounds();
const localWidth = box.max.x - box.min.x;
const localHeight = box.max.y - box.min.y;

// World-space size (accounting for grid.scale)
const worldWidth = localWidth * grid.scale.x;
const worldHeight = localHeight * grid.scale.y;

// Position adjacent to a hit point on a process pillar
const offsetFromPillar = new THREE.Vector3(2.5, 0, 0);
grid.position.copy(hitPoint).add(offsetFromPillar);

// Billboarding (face camera):
grid.quaternion.copy(camera.quaternion);
```

---

## 4. Loading Text & Visualization Modes

### Mode A: Execution / Disassembly View

Load disassembled instructions and highlight the active instruction pointer (RIP):

```typescript
interface Instruction {
  address: number;
  mnemonic: string;
  operands: string;
}

export async function displayDisassembly(
  grid: CodeGrid,
  instructions: Instruction[],
  ripAddress: number
) {
  let ripLineIndex = -1;

  const lines = instructions.map((inst, index) => {
    const isRip = inst.address === ripAddress;
    if (isRip) ripLineIndex = index;

    const prefix = isRip ? ' => ' : '    ';
    const addr = inst.address.toString(16).padStart(12, '0');
    const mnem = inst.mnemonic.padEnd(8, ' ');
    return `${prefix}${addr}  ${mnem}  ${inst.operands}`;
  });

  // loadText replaces existing text cleanly without leaks
  await grid.loadText(lines.join('\n'), 'disasm.s');

  // Highlight RIP line in warm amber/gold
  if (ripLineIndex >= 0) {
    grid.highlightLine(ripLineIndex, { r: 1.0, g: 0.82, b: 0.2 });
  }
}
```

---

### Mode B: Memory Hexdump & Pointer Arcs

Render raw faulted process memory bytes (256–512 bytes) with semantic byte colors and pointer arrows:

```typescript
import { bytesToHexView, decorateMemoryGrid, CodeGrid } from '@glyph3d/core';

export async function displayMemoryHexdump(
  grid: CodeGrid,
  bytes: Uint8Array,
  virtualAddress: number
) {
  // 1. Format raw bytes to standard hexdump string (16 bytes per line)
  const dump = bytesToHexView(bytes, {
    cols: 16,
    baseOffset: virtualAddress,
  });

  // 2. Load text into grid
  await grid.loadText(dump, 'memory.hex');

  // 3. Apply semantic byte coloring and pointer arrows
  //    - Dark slate: 0x00 (padding/null)
  //    - Vibrant green: Printable ASCII (0x20 - 0x7E)
  //    - Blue: Control characters (0x01 - 0x1F)
  //    - Warm amber/orange: High bytes & pointers
  //    - Arrows: 64-bit LE pointers that reference addresses within this window
  decorateMemoryGrid(grid, bytes, {
    cols: 16,
    windowOffset: virtualAddress,
  });
}
```

#### How `decorateMemoryGrid` Works
1. Colors each byte's hex representation using `byteColor(byte)`.
2. Scans for aligned 64-bit little-endian pointers targeting inside the `[virtualAddress, virtualAddress + bytes.length)` range via `findPointers`.
3. Attaches a `MemoryEdges` child object to `grid` containing:
   - Line shafts connecting pointer addresses to targets.
   - Directed cone arrowheads pointing at target cells.
4. Because `MemoryEdges` is parented to `grid`, all lines and arrows follow the grid's world transform and billboarding automatically.

---

## 5. Complete Recipe: The `procinsh` Hover Inspection Card

Here is a complete, production-ready TypeScript component for `procinsh` managing the hover inspection card and leader line:

```typescript
import * as THREE from 'three';
import {
  CodeGrid,
  GlyphAtlas,
  bytesToHexView,
  decorateMemoryGrid,
} from '@glyph3d/core';

export class ProcessInspectionCard extends THREE.Group {
  private grid: CodeGrid;
  private leaderLine: THREE.Line;
  private leaderGeo: THREE.BufferGeometry;
  private leaderPos: Float32Array;

  constructor(atlas: GlyphAtlas) {
    super();

    // 1. Create text grid
    this.grid = new CodeGrid(null, atlas, {
      showBackground: true,
      backgroundColor: 0x080910,
      backgroundOpacity: 0.94,
      padding: 14,
    });
    this.grid.scale.setScalar(0.024);
    this.add(this.grid);

    // 2. Create leader line (connecting pillar hit point to card)
    this.leaderPos = new Float32Array(6); // 2 vertices x (x, y, z)
    this.leaderGeo = new THREE.BufferGeometry();
    this.leaderGeo.setAttribute('position', new THREE.BufferAttribute(this.leaderPos, 3));
    const leaderMat = new THREE.LineBasicMaterial({
      color: 0x44aaff,
      transparent: true,
      opacity: 0.7,
      depthTest: true,
      depthWrite: false,
    });
    this.leaderLine = new THREE.Line(this.leaderGeo, leaderMat);
    this.leaderLine.frustumCulled = false;
    this.add(this.leaderLine);

    this.visible = false;
  }

  /**
   * Update position and billboarding relative to the hit point on the pillar.
   */
  public updateAnchor(hitPoint: THREE.Vector3, camera: THREE.Camera) {
    // Position card offset to the side of the pillar
    const cardPos = hitPoint.clone().add(new THREE.Vector3(2.8, 0.5, 0));
    this.grid.position.copy(cardPos);

    // Billboard grid towards camera
    this.grid.quaternion.copy(camera.quaternion);

    // Update leader line endpoints (in local coordinates of this group)
    // Vertex 0: Hit point on the pillar
    this.leaderPos[0] = hitPoint.x;
    this.leaderPos[1] = hitPoint.y;
    this.leaderPos[2] = hitPoint.z;

    // Vertex 1: Left edge of card
    this.leaderPos[3] = cardPos.x;
    this.leaderPos[4] = cardPos.y;
    this.leaderPos[5] = cardPos.z;

    this.leaderGeo.attributes.position.needsUpdate = true;
  }

  /**
   * Show raw memory hexdump with byte colors and pointer arcs.
   */
  public async showMemoryHexdump(bytes: Uint8Array, virtualAddress: number) {
    this.visible = true;
    const dump = bytesToHexView(bytes, { cols: 16, baseOffset: virtualAddress });
    await this.grid.loadText(dump, 'memory.hex');
    decorateMemoryGrid(this.grid, bytes, { cols: 16, windowOffset: virtualAddress });
  }

  /**
   * Show disassembly lines centered on RIP.
   */
  public async showDisassembly(lines: string[], ripLineIndex: number) {
    this.visible = true;
    // clear memory edges if any were active
    this.grid.clear();
    await this.grid.loadText(lines.join('\n'), 'disasm.s');
    if (ripLineIndex >= 0) {
      this.grid.highlightLine(ripLineIndex, { r: 1.0, g: 0.85, b: 0.2 });
    }
  }

  /**
   * Hide the card when mouse moves off the region.
   */
  public hide() {
    this.visible = false;
  }

  /**
   * Clean up all GPU resources on scene teardown.
   */
  public dispose() {
    this.grid.dispose();
    this.leaderGeo.dispose();
    (this.leaderLine.material as THREE.Material).dispose();
  }
}
```

---

## 6. Lifecycle & Best Practices

1. **Keep One Persistent Card**:
   - Do **not** instantiate and destroy a `CodeGrid` on every mouse move.
   - Instantiate one `ProcessInspectionCard` during space initialization.
   - Toggle `card.visible = true` on hover, and `card.visible = false` on hover out.
   - When switching hovered regions, simply call `await grid.loadText(...)` and `decorateMemoryGrid(...)`. Previous instanced buffers and pointer edges are cleanly overwritten.
2. **Disposal**:
   - Calling `grid.dispose()` detaches all meshes, disposes geometries, materials, and automatically tears down attached `MemoryEdges`.
3. **Renderer Compatibility**:
   - Standard `THREE.WebGLRenderer` with `antialias: true` and `powerPreference: "high-performance"` works out of the box.
   - The instanced shaders require no extra render-loop passes. Normal `renderer.render(scene, camera)` will draw the grid.

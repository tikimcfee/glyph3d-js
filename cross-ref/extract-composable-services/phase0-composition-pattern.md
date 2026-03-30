# Phase 0: Composition Pattern Design

## Overview

A **composition pattern** is how an application creates services, wires their dependencies together, and orchestrates their lifecycle without a DI framework. No magic, no decorators, no service locators—just explicit constructors and function calls.

### Core Principle

**Services are functions.** Dependencies flow in via constructor arguments. Events flow out via callbacks or EventTarget. When the app shuts down, services are disposed by calling explicit cleanup methods.

---

## Architecture

### 1. Service Definition (Constructor DI)

A service is a class with:
- **Immutable dependencies** passed to constructor
- **No global lookups** (no service locator, no window.app.X)
- **Clean public API** (methods, properties, events)
- **Testable isolation** (mock deps, test in isolation)

**Before (status quo, tightly coupled):**
```javascript
export class CameraController {
  constructor(ctx) {
    // ctx is a "context bag" — knows about grids, viewer state, etc.
    // Tight coupling: CameraController reaches into ctx for everything
    this.ctx = ctx;
    this.camera = ctx.camera;
    this.canvas = ctx.canvas;
    this.grids = ctx.getGrids;  // Method call, not data
  }

  focusOnGrid(index) {
    // Hard to test: needs real ctx, real grids, real camera
    const grid = this.ctx.getGrids()[index];
    // ...compute bounds...
    this.camera.position.copy(bounds.center);
  }
}
```

**After (pure DI):**
```javascript
export class CameraController {
  constructor({
    camera,           // THREE.Camera instance
    canvas,           // HTMLCanvasElement
    gridProvider,     // () => CodeGrid[] — lazy, so caller can swap it
    THREE,            // Three.js module
  }) {
    this.camera = camera;
    this.canvas = canvas;
    this.getGrids = gridProvider;
    this.THREE = THREE;

    // Internal state (no context references)
    this.settings = loadSettings();
    this.keys = {};
  }

  focusOnGrid(index) {
    // Test: new CameraController({ camera: mockCam, canvas: mockCanvas, gridProvider: () => [...], THREE })
    const grids = this.getGrids();
    const grid = grids[index];
    // ...compute bounds...
    this.camera.position.copy(bounds.center);

    // Emit event (not call ctx.onFocusChanged)
    this.canvas.dispatchEvent(new CustomEvent('camera-focus-changed', {
      detail: { index }
    }));
  }

  dispose() {
    document.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('keyup', this._onKeyUp);
    // etc.
  }
}
```

---

### 2. Composition Root

The **composition root** is a function that:
1. Constructs all services with their explicit dependencies
2. Wires event listeners between them
3. Returns handles to key services for the app to use

**Example: Standalone viewer composition**

```javascript
// examples/github-viewer/compose.js

export async function composeViewer(canvas, THREE) {
  // Phase 1: Infrastructure (Three.js, DOM)
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 10000);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  
  const atlas = new GlyphAtlas();
  await atlas.generate();

  // Phase 2: Core services
  const cameraController = new CameraController({
    camera,
    canvas,
    gridProvider: () => registry.toArray('grid'),
    THREE,
  });

  const fileStateManager = new FileStateManager();
  
  const selectionManager = new SelectionManager(THREE, fileStateManager);

  const registry = new SceneRegistry();

  // Phase 3: Subsystems that depend on core services
  const codeColorManager = new CodeColorManager(
    { scene, camera, renderer, canvas, atlas, THREE },
    fileStateManager
  );

  const diffController = new DiffController({
    scene,
    atlas,
    registry,
  });

  // Phase 4: Wiring events
  canvas.addEventListener('canvas-click', (e) => {
    selectionManager.handleClick(
      e.detail.clientX,
      e.detail.clientY,
      canvas,
      camera,
      registry.toArray('grid'),
      e.detail.ctrlKey || e.detail.metaKey
    );
  });

  canvas.addEventListener('file-selected', (e) => {
    // Sync tree UI when selection changes
    document.querySelectorAll('.tree-item').forEach((item) => {
      item.classList.toggle('selected', e.detail.selected.includes(item.dataset.path));
    });
  });

  // Phase 5: Optional subsystems
  const commandRouter = new CommandRouter({
    camera,
    cameraController,
    registry,
    // ... other refs
  });

  const wsBridge = new WebSocketBridge(commandRouter, {
    port: 8765,
    autoConnect: false,
  });

  // Return public API
  return {
    scene,
    camera,
    renderer,
    canvas,
    atlas,
    registry,
    cameraController,
    selectionManager,
    fileStateManager,
    codeColorManager,
    diffController,
    commandRouter,
    wsBridge,

    // Lifecycle
    async init() {
      cameraController.setupEventListeners();
      // ... any async init
    },

    dispose() {
      cameraController.dispose();
      selectionManager.dispose?.();
      codeColorManager.dispose?.();
      wsBridge.disconnect();
      renderer.dispose();
    },
  };
}
```

---

### 3. IDE Composition (Extends Viewer)

The IDE wraps the viewer and adds UI orchestration:

```javascript
// examples/ide/compose-ide.js

export async function composeIDE(canvas, THREE) {
  // Create the viewer composition
  const viewer = await composeViewer(canvas, THREE);

  // IDE shell adds layout management
  const ideShell = new IDEShell();
  ideShell.injectPanelContent();
  ideShell.attachViewer(viewer);

  // Wire IDE-specific event listeners
  window.addEventListener('file-selected', (e) => {
    ideShell._onFileSelected(e.detail);
  });

  window.addEventListener('camera-focus-changed', (e) => {
    ideShell._onCameraFocusChanged(e.detail);
  });

  // Override viewer's drawer with IDE's panel system
  const origInit = viewer.init.bind(viewer);
  viewer.init = async function() {
    await origInit();
    viewer.drawer = ideShell.asDrawer();
  };

  return {
    viewer,
    ideShell,

    async init() {
      await viewer.init();
      ideShell.start();
    },

    dispose() {
      viewer.dispose();
      ideShell.dispose?.();
    },
  };
}

// Usage in ide.html:
const { viewer, ideShell } = await composeIDE(canvas, THREE);
await viewer.init();
ideShell.start();
```

---

### 4. Service Lifecycle & Cleanup

Each service should expose `dispose()` if it holds resources:

```javascript
export class CameraController {
  dispose() {
    // Unsubscribe from all events
    if (this._onKeyDown) document.removeEventListener('keydown', this._onKeyDown);
    if (this._onKeyUp) document.removeEventListener('keyup', this._onKeyUp);
    if (this._onMouseDown) this.canvas.removeEventListener('mousedown', this._onMouseDown);
    if (this._onMouseMove) document.removeEventListener('mousemove', this._onMouseMove);
    // etc.
  }
}

// In composition root cleanup:
function teardown() {
  cameraController.dispose();
  selectionManager.dispose?.();
  wsBridge.disconnect();
  renderer.dispose();
}
```

---

## Event Flow

### Pattern: CustomEvent + Window/Canvas Dispatch

Services emit events to the global canvas or window, not by calling methods on other services:

```javascript
// In CameraController.focusOnGrid():
this.canvas.dispatchEvent(new CustomEvent('camera-focus-changed', {
  detail: { index }
}));

// In SelectionManager.select():
this.canvas.dispatchEvent(new CustomEvent('file-selected', {
  detail: { selected: Array.from(this._selected), primary: this._primary }
}));
```

**Benefits:**
- No hard coupling between emitter and listener
- Easy to replace listeners without modifying services
- IDE can re-listen without changing viewer code
- Testable: mock event listener, fire events, verify side effects

---

## Handling the "God Object" Problem

**Problem:** If composition root knows about every service, it becomes hard to maintain.

**Solution 1: Layered composition**
```javascript
// Tier 1: Infrastructure
const { scene, camera, renderer, atlas } = createInfrastructure(canvas, THREE);

// Tier 2: Core services
const { cameraController, selectionManager } = createCoreServices({
  scene, camera, renderer, atlas
});

// Tier 3: Integration layer (wiring)
wireEventListeners({ cameraController, selectionManager });

// Tier 4: Optional subsystems
const { wsBridge, diffController } = createOptionalServices({
  scene, cameraController, selectionManager
});
```

**Solution 2: Factory per domain**
```javascript
// viewerFactory.js
export function createViewerServices(canvas, THREE) {
  // All services + wiring for the viewer domain
  return { /* ... */ };
}

// ideFactory.js
export async function createIDEServices(canvas, THREE) {
  const viewer = createViewerServices(canvas, THREE);
  const ideShell = new IDEShell();
  // Wire IDE-specific events
  return { viewer, ideShell };
}
```

---

## Testing & Mocking

Pure DI makes testing trivial:

```javascript
// Test CameraController in isolation
const mockCamera = { position: new Vector3(), updateProjectionMatrix: () => {} };
const mockCanvas = new EventTarget(); // Browser API, works in jsdom
const mockGrids = [/* test data */];

const controller = new CameraController({
  camera: mockCamera,
  canvas: mockCanvas,
  gridProvider: () => mockGrids,
  THREE: MockThree,
});

// No global state, no side effects
controller.focusOnGrid(0);
expect(mockCamera.position).toEqual(...);

// Listen for events
mockCanvas.addEventListener('camera-focus-changed', (e) => {
  expect(e.detail.index).toBe(0);
});
```

---

## "Hello World" Composition

```javascript
// Minimal standalone viewer
async function helloWorld(canvas, THREE) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight);
  const renderer = new THREE.WebGLRenderer({ canvas });

  const atlas = new GlyphAtlas();
  await atlas.generate();

  const registry = new SceneRegistry();

  const controller = new CameraController({
    camera,
    canvas,
    gridProvider: () => registry.toArray('grid'),
    THREE,
  });
  controller.setupEventListeners();

  // Render loop
  function animate() {
    requestAnimationFrame(animate);
    controller.update(performance.now());  // WASD, drag pan, zoom
    renderer.render(scene, camera);
  }
  animate();

  return { scene, camera, renderer, atlas, registry, controller, dispose };
}
```

---

## Summary

| Aspect | Pattern |
|--------|---------|
| **Service Creation** | Constructor with explicit deps (no global lookups) |
| **Dependency Passing** | Function args, not property injection |
| **Event Flow** | CustomEvent on window/canvas, not method calls |
| **Composition** | Layered functions that wire services together |
| **Cleanup** | Call `dispose()` on each service |
| **Testing** | Mock deps via constructor, test in isolation |
| **No framework** | Just functions, classes, event listeners |


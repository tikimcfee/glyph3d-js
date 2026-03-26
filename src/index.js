/**
 * glyph3d-js - High-performance 3D text rendering for Three.js
 *
 * GPU-instanced glyph rendering with dynamic atlas, web worker parallelization,
 * and flexible layout systems.
 *
 * @license MIT
 */

// Core rendering
export { default as GlyphAtlas } from './GlyphAtlas.js';
export { default as GlyphRenderer } from './GlyphRenderer.js';

// Collections - batched text abstractions
export { default as GlyphCollection } from './collections/GlyphCollection.js';
export { default as CodeGrid } from './collections/CodeGrid.js';
export { default as GridLayoutManager } from './collections/GridLayoutManager.js';
export { default as HierarchicalLayoutManager } from './collections/HierarchicalLayoutManager.js';
export { default as SpiralLayoutManager } from './collections/SpiralLayoutManager.js';
export { default as TreemapLayoutManager } from './collections/TreemapLayoutManager.js';

// Worker system
export { WorkerBridge, getWorkerBridge, isWorkersSupported } from './workers/WorkerBridge.js';
export { buildGlyphBuffers, buildBatchBuffers } from './workers/builders/index.js';

// Layout subsystem
export { default as GlyphLayout } from './layout/GlyphLayout.js';
export { default as GlyphBatcher } from './layout/GlyphBatcher.js';
export { default as GlyphInstancePool } from './layout/GlyphInstancePool.js';

// Core utilities
export { CHAR_DIMENSIONS, PERF_THRESHOLDS, shouldDebugLog } from './core/constants.js';
export { default as InstanceBuffer } from './core/InstanceBuffer.js';
export { default as ShaderManager } from './core/ShaderManager.js';

// Observability
export {
    createLogger,
    LogLevel,
    Logger,
    metrics,
    Metrics,
    errorTracker,
    ErrorTracker,
    debugConsole,
    DebugConsole,
    logCapture,
    LogCapture,
    initObservability
} from './utils/index.js';

// Camera controls (optional)
export { default as CameraController } from './camera/CameraController.js';
export { default as InputManager } from './camera/InputManager.js';

// Utility
export { default as FPSCounter } from './utils/FPSCounter.js';

// Hand tracking
export {
    Joint,
    JOINT_COUNT,
    SKELETON_CONNECTIONS,
    Finger,
    createEmptyFrame,
    landmarkDistance,
    HandRenderer,
    GestureDetector,
    WebcamHandSource,
    WebSocketHandSource,
    MockHandSource,
    ViewportRenderer,
} from './hand/index.js';

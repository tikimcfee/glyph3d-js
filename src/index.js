/**
 * glyph3d-js - High-performance 3D text rendering for Three.js
 *
 * GPU-instanced glyph rendering with dynamic atlas, web worker parallelization,
 * and flexible layout systems.
 *
 * @license MIT
 */

// Core rendering — GlyphField is the WebGPU/TSL renderer (the one renderer).
export { default as GlyphAtlas } from './GlyphAtlas.js';
export { default as GlyphField } from './GlyphField.js';
export { loadPrebakedAtlas } from './GlyphAtlasLoader.js';

// Collections - batched text abstractions
export { default as CodeGrid } from './collections/CodeGrid.js';
export { default as GridLayoutManager } from './collections/GridLayoutManager.js';
export { default as HierarchicalLayoutManager } from './collections/HierarchicalLayoutManager.js';
export { default as SpiralLayoutManager } from './collections/SpiralLayoutManager.js';
export { default as TreemapLayoutManager } from './collections/TreemapLayoutManager.js';
export { default as StackLayoutManager } from './collections/StackLayoutManager.js';
export { default as GridVirtualizer } from './collections/GridVirtualizer.js';
export { default as TerminalGrid } from './collections/TerminalGrid.js';
export { parseCapturePaneAnsi, parseCapturePanePlain } from './collections/TerminalCapture.js';

// Worker system
export { WorkerBridge, getWorkerBridge, isWorkersSupported } from './workers/WorkerBridge.js';

// Core utilities
export { PERF_THRESHOLDS, shouldDebugLog } from './core/constants.js';

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

// Glyph picking (GPU-based hover/click detection)
export { PickingSystem } from './picking/PickingSystem.js';

// Semantic annotation and event bus
export { SemanticInfo, SemanticInfoMap } from './semantic/SemanticInfoMap.js';
export { GlyphEventType, GlyphEventBus } from './semantic/GlyphEvents.js';

// Camera controls (optional)
export { default as CameraController } from './camera/CameraController.js';
export { default as InputManager } from './camera/InputManager.js';

// Utility
export { default as FPSCounter } from './utils/FPSCounter.js';

// Annotations (connection lines, tour overlays)
export { ConnectionRenderer } from './annotations/index.js';

// Parsing (file refs, stack traces, log lines)
export { parseFileRef, parseStackTrace, parseLogLine, parseAuto } from './parsing/index.js';

// Text shaping (HarfBuzz WASM) + Slug vector encoding
export { HarfBuzzShaper, MonospaceShapeCache, shapeText, collectUniqueGlyphIds, SlugEncoder, buildSlugBuffers } from './shaping/index.js';

// Buffer builders (HarfBuzz-shaped path only)
export { buildBatchBuffers, buildShapedBatchBuffers } from './workers/builders/index.js';

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

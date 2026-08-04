/**
 * Composable Services - Reusable viewer infrastructure extracted from github-viewer
 *
 * These services follow constructor DI for application-specific dependencies
 * (SceneContext, callbacks) and bare imports for peer dependencies (three.js).
 *
 * @license MIT
 */

// Context & infrastructure
export { SceneContext } from './SceneContext.js';
export { default as SceneRegistry } from './SceneRegistry.js';

// Utils
export { isMac, isLinux, primaryMod, secondaryMod } from './utils/platform.js';

// State
export { FileStateManager } from './state/FileStateManager.js';
export { parsePatchAligned, buildAlignedDiff, getDiffColor } from './state/DiffParser.js';

// Visual services
export { BackdropManager } from './visual/BackdropManager.js';
export { NameplateManager } from './visual/NameplateManager.js';

// Interaction services
export { SelectionManager } from './interaction/SelectionManager.js';
export { CodeColorManager } from './interaction/CodeColorManager.js';
export { ShortcutManager } from './interaction/ShortcutManager.js';

// Spatial
export { worldBounds } from './spatial/sceneBounds.js';

// Camera
export { ViewerCameraController } from './camera/ViewerCameraController.js';

// Data services
export { GitHubRepositorySource, GitHubError, RateLimitError } from './data/GitHubRepositorySource.js';
export { RepositoryAdapter } from './data/RepositoryAdapter.js';
export { RepositoryContentCache } from './data/RepositoryContentCache.js';
export { HeatmapProvider } from './data/HeatmapProvider.js';

// Orchestration
export { DiffController } from './orchestration/DiffController.js';
export { HandGestureAdapter } from './orchestration/HandGestureAdapter.js';
export { default as CommandRouter } from './orchestration/CommandRouter.js';
export { default as ViewerAPI } from './orchestration/ViewerAPI.js';
export { default as WebSocketBridge } from './orchestration/WebSocketBridge.js';

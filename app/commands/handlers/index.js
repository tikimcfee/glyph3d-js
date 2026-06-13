/**
 * Command registry - aggregates all command modules.
 * Each module receives the CommandRouter and registers its handlers.
 */

import registerSystemCommands from './systemCommands.js';
import registerCameraCommands from './cameraCommands.js';
import registerGridCommands from './gridCommands.js';
import registerSceneCommands from './sceneCommands.js';
import registerSelectCommands from './selectCommands.js';
import registerSearchCommands from './searchCommands.js';
import registerAnnotationCommands from './annotationCommands.js';
import registerSpatialCommands from './spatialCommands.js';
import registerCompositionCommands from './compositionCommands.js';
import registerNavigationCommands from './navigationCommands.js';
import registerRegistryCommands from './registryCommands.js';
import registerTerminalCommands from './terminalCommands.js';
import registerHighlightCommands from './highlightCommands.js';
import registerTourCommands from './tourCommands.js';
import registerGroupCommands from './groupCommands.js';
import registerSimulateCommands from './simulateCommands.js';
import registerModeCommands from './modeCommands.js';
import registerFileCommands from './fileCommands.js';
import registerLayoutCommands from './layoutCommands.js';
import registerRepoCommands from './repoCommands.js';
import registerPanelCommands from './panelCommands.js';
import registerDockCommands from './dockCommands.js';
import registerWindowCommands from './windowCommands.js';
import registerRelayCommands from './relayCommands.js';
import registerSettingsCommands from './settingsCommands.js';
import registerAttentionCommands from './attentionCommands.js';
import registerEditCommands from './editCommands.js';
import registerContextCommands from './contextCommands.js';
import registerAgentVisitorCommands from './agentVisitorCommands.js';
import registerMemoryCommands from './memoryCommands.js';
import registerWorkspaceCommands from './workspaceCommands.js';
import registerAtlasCommands from './atlasCommands.js';
import registerSessionCommands from './sessionCommands.js';
import registerObservabilityCommands from './observabilityCommands.js';

/**
 * Register all built-in commands on a router.
 * @param {import('../CommandRouter.js').default} router
 */
export function registerAllCommands(router) {
    registerSystemCommands(router);
    registerCameraCommands(router);
    registerGridCommands(router);
    registerSceneCommands(router);
    registerSelectCommands(router);
    registerSearchCommands(router);
    registerAnnotationCommands(router);
    registerSpatialCommands(router);
    registerCompositionCommands(router);
    registerNavigationCommands(router);
    registerRegistryCommands(router);
    registerTerminalCommands(router);
    registerHighlightCommands(router);
    registerTourCommands(router);
    registerGroupCommands(router);
    registerSimulateCommands(router);
    registerModeCommands(router);
    registerFileCommands(router);
    registerLayoutCommands(router);
    registerRepoCommands(router);
    registerPanelCommands(router);
    registerDockCommands(router);
    registerWindowCommands(router);
    registerRelayCommands(router);
    registerSettingsCommands(router);
    registerAttentionCommands(router);
    registerEditCommands(router);
    registerContextCommands(router);
    registerAgentVisitorCommands(router);
    registerMemoryCommands(router);
    registerWorkspaceCommands(router);
    registerAtlasCommands(router);
    registerSessionCommands(router);
    registerObservabilityCommands(router);
}

// Dev ergonomics: handlers register imperatively ONCE per page load (CommandProvider's
// effect), so a hot-swapped handler module leaves the LIVE router holding the old
// handlers — the edit silently doesn't take. Force a full page reload on any
// handler-graph change instead; the reload re-runs registerAllCommands fresh. (Source
// edits want a reload, not the .vite cache-wipe — that's only for dependency changes.)
if (import.meta.hot) {
    import.meta.hot.accept(() => window.location.reload());
}

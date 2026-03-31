/**
 * Command registry - aggregates all command modules.
 * Each module receives the CommandRouter and registers its handlers.
 */

import registerSystemCommands from './systemCommands.js';
import registerCameraCommands from './cameraCommands.js';
import registerGridCommands from './gridCommands.js';
import registerSceneCommands from './sceneCommands.js';
import registerSelectCommands from './selectCommands.js';
import registerLayoutCommands from './layoutCommands.js';
import registerSearchCommands from './searchCommands.js';
import registerAgentLayoutCommands from './agentLayoutCommands.js';
import registerAnnotationCommands from './annotationCommands.js';
import registerSpatialCommands from './spatialCommands.js';
import registerCompositionCommands from './compositionCommands.js';
import registerNavigationCommands from './navigationCommands.js';
import registerWindowCommands from './windowCommands.js';
import registerOrchestrationCommands from './orchestrationCommands.js';
import registerRegistryCommands from './registryCommands.js';
import registerTerminalCommands from './terminalCommands.js';
import registerHighlightCommands from './highlightCommands.js';
import registerTourCommands from './tourCommands.js';

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
    registerLayoutCommands(router);
    registerSearchCommands(router);
    registerAgentLayoutCommands(router);
    registerAnnotationCommands(router);
    registerSpatialCommands(router);
    registerCompositionCommands(router);
    registerNavigationCommands(router);
    registerWindowCommands(router);
    registerOrchestrationCommands(router);
    registerRegistryCommands(router);
    registerTerminalCommands(router);
    registerHighlightCommands(router);
    registerTourCommands(router);
}

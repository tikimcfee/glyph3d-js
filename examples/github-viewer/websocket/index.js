/**
 * WebSocket Command Center - main entry point.
 *
 * Wires together: CommandRouter, command modules, WebSocketBridge, and ViewerAPI.
 * Call `initCommandCenter(viewer)` from GitHubRepoViewer.init() to bootstrap.
 *
 * Exposes `window.viewer` for devtools/agent access.
 */

import CommandRouter from './CommandRouter.js';
import WebSocketBridge from './WebSocketBridge.js';
import ViewerAPI from './ViewerAPI.js';
import { registerAllCommands } from './commands/index.js';

/**
 * Build the command context bag from a GitHubRepoViewer instance.
 * This is the interface that command handlers receive.
 * @param {Object} viewer - GitHubRepoViewer instance
 * @returns {Object}
 */
function buildContext(viewer) {
    return {
        // Core Three.js
        scene: viewer.scene,
        camera: viewer.camera,
        renderer: viewer.renderer,
        atlas: viewer.atlas,

        // Data accessors
        getGrids: () => viewer.grids,

        // Grid mutation
        addGrid(grid) {
            viewer.grids.push(grid);
            viewer.scene.add(grid);
        },
        removeGrid(index) {
            const grid = viewer.grids[index];
            if (!grid) return null;
            grid.dispose();
            viewer.scene.remove(grid);
            viewer.grids.splice(index, 1);
            return grid;
        },

        // Subsystems
        cameraController: viewer.cameraController,
        selectionManager: viewer.selectionManager || null,
        fileStateManager: viewer.fileStateManager || null,
        codeColorManager: viewer.codeColorManager || null,

        // Layout
        getActiveLayout: () => viewer._activeLayout,
        layoutManagers: {
            hierarchical: viewer.hierarchicalManager,
            spiral: viewer.spiralManager,
            treemap: viewer.treemapManager,
            grid: viewer.layoutManager,
        },

        // Window manager (populated after bridge creation)
        windowManager: viewer.windowManager || null,

        // WebSocket bridge (populated after creation)
        wsbridge: null,

        // Annotation system: labels and scene annotations created via CLI
        annotations: new Map(),

        // Shared visual state tracker for highlight/dim save/restore
        gridVisualState: new Map(),

        // Camera animation cancellation function (set by camera.animate)
        _cancelCameraAnimation: null,
    };
}

/**
 * Initialize the full command center.
 *
 * @param {Object} viewer - GitHubRepoViewer instance
 * @param {Object} [options]
 * @param {number} [options.port=8765] - WebSocket relay port
 * @param {boolean} [options.autoConnect=true] - auto-connect WebSocket
 * @param {boolean} [options.showStatus=true] - show status bar
 * @returns {{ router: CommandRouter, bridge: WebSocketBridge, api: ViewerAPI }}
 */
export function initCommandCenter(viewer, options = {}) {
    // 1. Build command context
    const context = buildContext(viewer);

    // 2. Create router and register all commands
    const router = new CommandRouter(context);
    registerAllCommands(router);

    // 3. Add logging middleware (logs all commands to console in debug)
    router.use((name, args) => {
        console.debug(`[cmd] ${name}`, args.length > 0 ? args : '');
    });

    // 4. Create WebSocket bridge
    const bridge = new WebSocketBridge(router, {
        port: options.port || 8765,
        autoConnect: options.autoConnect !== false,
        showStatus: options.showStatus !== false,
    });

    // Wire bridge reference into context
    context.wsbridge = bridge;

    // 5. Create the ViewerAPI facade and expose globally
    const api = new ViewerAPI(router, context);
    window.viewer = api;

    console.log('[command-center] initialized. Use window.viewer or ws://localhost:' +
        (options.port || 8765) + ' to control the viewer.');

    return { router, bridge, api };
}

export { CommandRouter, WebSocketBridge, ViewerAPI };

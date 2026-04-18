/**
 * WebSocket Command Center - main entry point.
 *
 * Wires together: CommandRouter, command modules, WebSocketBridge, and ViewerAPI.
 * Call `initCommandCenter(viewer)` from GitHubRepoViewer.init() to bootstrap.
 *
 * Exposes `window.viewer` for devtools/agent access.
 */

import CommandRouter from '../../src/services/orchestration/CommandRouter.js';
import WebSocketBridge from '../../src/services/orchestration/WebSocketBridge.js';
import ViewerAPI from '../../src/services/orchestration/ViewerAPI.js';
import { registerAllCommands } from './handlers/index.js';

/**
 * Build the command context bag from a GitHubRepoViewer instance.
 * This is the interface that command handlers receive.
 *
 * The registry is owned by the viewer (viewer.registry). The context bag
 * references it -- it does not create its own. This eliminates dual-registry
 * drift and the seed loop.
 *
 * @param {Object} viewer - GitHubRepoViewer instance
 * @returns {Object}
 */
function buildContext(viewer) {
    const registry = viewer.registry;

    return {
        // Core Three.js
        scene: viewer.scene,
        camera: viewer.camera,
        renderer: viewer.renderer,
        atlas: viewer.atlas,

        // Scene object registry (THE source of truth)
        registry,

        // Data accessor -- cached frozen view derived from registry
        getGrids: () => registry.toArray('grid'),

        // Grid mutation -- all creation/removal through registry
        addGrid(grid, opts = {}) {
            // Determine ID
            const sourcePath = grid.getSourcePath?.() || null;
            const filename = grid.getFilename?.() || grid.name || null;
            const id = opts.id || sourcePath || filename
                || `grid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

            // Register (skip if already registered by this grid ref)
            if (!registry.getIdByGrid(grid)) {
                registry.register(id, grid, {
                    type: opts.type || 'grid',
                    sourcePath,
                    filename,
                    ...opts.meta,
                });
            }

            // Add to scene
            if (!grid.parent) {
                viewer.scene.add(grid);
            }

            return id;
        },

        removeGrid(idOrIndex) {
            let entry;
            if (typeof idOrIndex === 'number' || /^\d+$/.test(idOrIndex)) {
                // Numeric index into toArray('grid')
                const idx = typeof idOrIndex === 'number' ? idOrIndex : parseInt(idOrIndex);
                const grids = registry.toArray('grid');
                if (idx < 0 || idx >= grids.length) return null;
                const grid = grids[idx];
                const regId = registry.getIdByGrid(grid);
                if (!regId) return null;
                entry = registry.unregister(regId);
            } else {
                // String ID
                entry = registry.unregister(idOrIndex);
            }
            if (!entry) return null;
            entry.grid.dispose();
            viewer.scene.remove(entry.grid);
            return entry;
        },

        // Subsystems
        cameraController: viewer.cameraController,
        selectionManager: viewer.selectionManager || null,
        fileStateManager: viewer.fileStateManager || null,
        codeColorManager: viewer.codeColorManager || null,
        spatialManager: viewer.spatialManager || null,

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

        // SpatialNavigator — wired in after construction (set by ide.html)
        spatialNav: null,
    };
}

/**
 * Patch console.log/warn/error to forward messages to the relay via WebSocket.
 * Each forwarded message is a JSON event: { event: 'browser.log', level, text }.
 * The relay prints these to stdout so CLI users see browser output in real time.
 *
 * The patch is installed once; subsequent calls are no-ops.
 * Only the first 200 characters of the serialized message are forwarded to keep
 * the channel lightweight.
 *
 * @param {WebSocketBridge} bridge
 */
let _consoleForwarderInstalled = false;
function _installConsoleForwarder(bridge) {
    if (_consoleForwarderInstalled) return;
    _consoleForwarderInstalled = true;

    const LEVELS = ['log', 'warn', 'error'];
    const MAX_LEN = 200;

    for (const level of LEVELS) {
        const original = console[level].bind(console);
        console[level] = (...args) => {
            original(...args);
            if (!bridge.connected) return;
            // Serialize args to a single string, capped at MAX_LEN
            let text;
            try {
                text = args.map(a => {
                    if (typeof a === 'string') return a;
                    try { return JSON.stringify(a); } catch { return String(a); }
                }).join(' ');
            } catch {
                text = String(args[0] ?? '');
            }
            if (text.length > MAX_LEN) text = text.slice(0, MAX_LEN) + '...';
            const msg = JSON.stringify({ event: 'browser.log', level, text });
            bridge.send(msg);
        };
    }
}

/**
 * Initialize the full command center.
 *
 * @param {Object} viewer - GitHubRepoViewer instance
 * @param {Object} [options]
 * @param {number} [options.port] - WebSocket relay port (default: page port or 8080)
 * @param {boolean} [options.autoConnect=true] - auto-connect WebSocket
 * @param {boolean} [options.showStatus=true] - show status bar
 * @returns {{ router: CommandRouter, bridge: WebSocketBridge, api: ViewerAPI }}
 */
export function initCommandCenter(viewer, options = {}) {
    const defaultPort = (typeof window !== 'undefined' && window.location.port)
        ? parseInt(window.location.port, 10) : 8080;
    const port = options.port || defaultPort;

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
        port,
        autoConnect: options.autoConnect !== false,
        showStatus: options.showStatus !== false,
    });

    // Wire bridge reference into context
    context.wsbridge = bridge;

    // Live reload: when the server detects source file changes (--local mode),
    // automatically reload the page to pick up the new code.
    bridge.setRpcNotificationHandler((method, params) => {
        if (method === 'fs/didChange') {
            console.log(`[livereload] ${params.path} changed, reloading...`);
            router.execute('reload');
        }
    });

    // Console log forwarding — patch console.log/warn/error to send the first
    // 200 chars of each message to the relay so the CLI user sees browser output.
    // Only forwards when the WebSocket is connected; no-ops otherwise.
    _installConsoleForwarder(bridge);

    // 5. Create the ViewerAPI facade and expose globally
    const api = new ViewerAPI(router, context);
    window.viewer = api;

    console.log('[command-center] initialized. Use window.viewer or ws://localhost:' +
        port + ' to control the viewer.');

    return { router, bridge, api, context };
}

export { CommandRouter, WebSocketBridge, ViewerAPI };

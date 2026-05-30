/**
 * WebSocket Command Center - main entry point.
 *
 * Wires together: CommandRouter, command modules, WebSocketBridge, and ViewerAPI.
 * Call `initCommandCenter(viewer)` from GitHubRepoViewer.init() to bootstrap.
 *
 * Exposes `window.viewer` for devtools/agent access.
 */

import CommandRouter from '@glyph3d/core/services/orchestration/CommandRouter.js';
import WebSocketBridge from '@glyph3d/core/services/orchestration/WebSocketBridge.js';
import { installConsoleForwarder } from '@glyph3d/core/services/orchestration/consoleForwarder.js';
import ViewerAPI from '@glyph3d/core/services/orchestration/ViewerAPI.js';
import AttentionManager from '@glyph3d/core/services/interaction/AttentionManager.js';
import EntityKeystrokeRouter from '@glyph3d/core/services/interaction/EntityKeystrokeRouter.js';
import { registerAllCommands } from './handlers/index.js';
import { contentHash } from './handlers/fileCommands.js';

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

        // Interaction mode — camera-framing axis only. 'reader' frames a
        // single grid; 'explorer' is free camera. The *which* grid is
        // reader-mode's target lives on ctx.attention.primary (single
        // source of truth). L1 swept ctx.mode.readerGridId out.
        mode: {
            state: 'explorer',
        },

        // Attention state — three slots (hover, primary, key) written
        // exclusively by AttentionManager. Editable-3d-ide L1. Readers
        // use ctx.attention.{hover,primary,key}?.id directly; there is
        // no shim, no legacy mirror. If you want to know whether a grid
        // is the sticky focus, read ctx.attention.primary?.id — do not
        // read focus.attendedId / ctx.mode.readerGridId (both removed).
        attentionManager: new AttentionManager(),
        get attention() { return this.attentionManager.state; },
    };
}

/**
 * Install the per-entity keystroke delivery path.
 *
 * One document-level keydown listener (capture phase) reads
 * ctx.attention.key, looks up a per-type handler by entity.type, and
 * delegates. Two types are registered today:
 *
 *   - terminal — translates the event to ANSI bytes (Enter→\r,
 *     Backspace→\x7f, arrows→CSI sequences, Ctrl+letter→0x01..0x1a)
 *     and forwards via grid.onInput (wired at terminal.create time in
 *     terminalCommands.js:90-98 to push back through wsbridge to the
 *     owning controller).
 *
 *   - grid — maps editing keys (printable, Backspace, Delete, Enter,
 *     arrows, Home/End, Tab) to the L2 M1 edit ops on CodeGrid. Entry/
 *     exit goes through edit.start / edit.stop (or the Esc-LIFO path,
 *     which clears attention.key and triggers exitEdit via the
 *     change:key listener below).
 *
 * Visual affordance for terminals: the canvas click handler sets primary
 * AND key together, so CommandBar's _highlightTerminal already tints the
 * background — that's the focus affordance, no second tint layer.
 * Grids in edit mode are signaled by the in-grid caret (L2 M1).
 *
 * Modifier policy: handlers receive the raw event and decide. Terminal
 * passes Ctrl+letter through; grid bails on Ctrl/Alt/Meta combos so
 * app-level shortcuts (Ctrl+S etc.) keep working untouched.
 *
 * @private
 * @param {Object} ctx - command context
 */
function _installEntityKeystrokeDelivery(ctx) {
    const am = ctx?.attentionManager;
    if (!am) return;
    // The keystroke router (terminal bytes + grid edit ops, the change:key exit
    // hook) lives in core now — one implementation shared with the r3f client.
    ctx._keystrokeRouter = new EntityKeystrokeRouter(am).start();
}

/**
 * Refetch a path via fs/readFile and reload any matching grid in place.
 *
 * Called from the fs/didChange handler on `event: 'write'`. The echo of the
 * caller's own file.save will arrive here too — we hash the fetched content
 * and skip the reload when it matches the grid's _savedTextHash, so the
 * common case (round-trip confirmation) is silent. External writes (another
 * tool overwriting the file on disk) hash-differ and trigger an in-place
 * loadText that preserves camera state.
 *
 * @param {Object} context - command context (provides registry)
 * @param {import('../../packages/glyph3d-core/src/services/orchestration/WebSocketBridge.js').default} bridge
 * @param {string} path - relative path (no scheme), e.g. "cross-ref/.../smoke.txt"
 */
async function _refreshGridForPath(context, bridge, path) {
    if (!path || !context?.registry) return;
    const entries = context.registry.findByMeta('sourcePath', path);
    if (!entries || entries.length === 0) return;  // file not displayed; nothing to refresh

    const uri = path.startsWith('file://') ? path : `file:///${path.replace(/^\/+/, '')}`;
    let result;
    try {
        result = await bridge.rpcRequest('fs/readFile', { uri });
    } catch (err) {
        console.warn(`[fs/didChange] failed to refetch ${path}: ${err?.message || err}`);
        return;
    }
    const content = result?.content ?? '';
    const newHash = contentHash(content);

    for (const entry of entries) {
        const grid = entry.grid;
        if (!grid || typeof grid.loadText !== 'function') continue;
        if (grid._savedTextHash === newHash) continue;  // echo of our own save

        grid.loadText(content);
        try {
            Object.defineProperty(grid, '_savedTextHash', {
                value: newHash, writable: true, configurable: true, enumerable: false,
            });
        } catch {
            grid._savedTextHash = newHash;
        }
        console.log(`[fs/didChange] refreshed grid "${entry.id}" (${content.length} chars)`);
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

    // 1a. Wire the AttentionManager onto viewer.sceneContext so VCC's hot-
    // loop probe can reach it. VCC's `this.ctx` is the sceneContext, not
    // the command ctx — this is the bridge. No back-compat mirror: every
    // writer/reader was migrated to AttentionManager in the same pass.
    if (viewer?.sceneContext) {
        viewer.sceneContext.attentionManager = context.attentionManager;
    }

    // 2. Create router and register all commands
    const router = new CommandRouter(context);
    registerAllCommands(router);

    // 2a. Wire per-entity keystroke delivery. VCC's keydown gate swallows
    // the camera path whenever any key slot is held, so editing/terminal
    // input never fights camera nav. Two entity types are handled today:
    //   - terminal — translates to ANSI bytes and forwards via grid.onInput
    //   - grid     — maps to the L2 M1 edit ops on CodeGrid
    // Entry points:
    //   - terminals: scene click sets primary AND key (ide.html click
    //     handler) so typing on a clicked terminal Just Works.
    //   - grids:     edit.start [id] sets key explicitly and calls
    //     enterEdit; the deliberate-action gate Ivan asked for.
    _installEntityKeystrokeDelivery(context);

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

    // fs/didChange notifications carry an `event` discriminator:
    //   - 'change' — livereload (fsnotify on src/app/...): JS source edits
    //                require a full page reload to pick up the new code.
    //   - 'write'  — fs/writeFile echo: a user-data file was written. Refresh
    //                only the affected grid in place; never lose camera state
    //                or re-download the whole repo.
    // Anything else gets logged so we notice if the protocol grows another arm.
    bridge.setRpcNotificationHandler((method, params) => {
        if (method !== 'fs/didChange') return;
        const event = params?.event;
        if (event === 'change') {
            console.log(`[livereload] ${params.path} changed, reloading...`);
            router.execute('reload');
            return;
        }
        if (event === 'write') {
            _refreshGridForPath(context, bridge, params?.path);
            return;
        }
        console.warn(`[fs/didChange] unknown event "${event}" for ${params?.path}`);
    });

    // Console log forwarding — patch console.* (and uncaught window errors) to
    // send each message to the relay so the CLI user sees browser output. Only
    // forwards when the WebSocket is connected; no-ops otherwise.
    installConsoleForwarder(bridge);

    // 5. Create the ViewerAPI facade and expose globally
    const api = new ViewerAPI(router, context);
    window.viewer = api;

    console.log('[command-center] initialized. Use window.viewer or ws://localhost:' +
        port + ' to control the viewer.');

    return { router, bridge, api, context };
}

export { CommandRouter, WebSocketBridge, ViewerAPI };

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
import AttentionManager from '../../src/services/interaction/AttentionManager.js';
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
 * Install the terminal-input keystroke delivery path.
 *
 * When ctx.attention.key is a terminal entity, a document-level keydown
 * listener (capture phase, bubble VCC already skips via its own gate)
 * forwards the character to the terminal's onInput callback — which was
 * wired at terminal.create time (terminalCommands.js:90-98) to push back
 * through wsbridge.push() to the owning controller.
 *
 * Key translation: printable keys pass through as e.key; control keys
 * get mapped to their ANSI equivalents (Enter -> \r, Backspace -> \x7f,
 * Tab -> \t, arrow keys -> CSI escape sequences). This matches what a
 * real TTY would receive. Meta/Ctrl combinations are NOT mapped
 * exhaustively — Ctrl+C sends 0x03, Ctrl+D sends 0x04, Ctrl+L sends
 * 0x0C, which covers the common interactive cases. Everything else
 * falls through unchanged.
 *
 * Visual affordance: in the normal user flow a canvas click sets
 * primary AND key together (ide.html click handler), so CommandBar's
 * _highlightTerminal already tints the background. L1-B does NOT add a
 * second tint layer — a second stash on the same mesh would fight
 * CommandBar's stash (both call material.color.setHex + snapshot the
 * "original" on overwrite). The CommandBar badge showing `>termId`
 * plus the highlighted background IS the focus affordance.
 *
 * If a future slice needs a distinct "key-focused but not primary"
 * affordance (e.g. a ring outline), it should go through a dedicated
 * visual-state-stack service rather than fighting CommandBar's stash.
 *
 * @private
 * @param {Object} ctx - command context
 */
function _installTerminalKeystrokeDelivery(ctx) {
    const am = ctx?.attentionManager;
    if (!am || typeof document === 'undefined') return;

    // Key-to-bytes translation for a terminal consumer. Returns the string
    // to send, or null if the key should be ignored (purely modifier events,
    // etc.).
    const keyToBytes = (e) => {
        // Pure modifier keydowns — nothing to send.
        if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return null;

        // Ctrl+letter -> control byte (A=0x01 ... Z=0x1a). Handle the
        // common interactive cases first.
        if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
            const c = e.key.toLowerCase().charCodeAt(0);
            if (c >= 97 && c <= 122) return String.fromCharCode(c - 96);
        }

        switch (e.key) {
            case 'Enter':     return '\r';
            case 'Tab':       return '\t';
            case 'Backspace': return '\x7f';
            case 'Delete':    return '\x1b[3~';
            case 'Escape':    return null;   // handled by LIFO shortcut
            case 'ArrowUp':    return '\x1b[A';
            case 'ArrowDown':  return '\x1b[B';
            case 'ArrowRight': return '\x1b[C';
            case 'ArrowLeft':  return '\x1b[D';
            case 'Home':       return '\x1b[H';
            case 'End':        return '\x1b[F';
            case 'PageUp':     return '\x1b[5~';
            case 'PageDown':   return '\x1b[6~';
        }

        // Printable single character.
        if (e.key.length === 1) return e.key;

        // Unknown; ignore.
        return null;
    };

    document.addEventListener('keydown', (e) => {
        const slot = am.get('key');
        if (!slot) return;
        const entity = slot.entity;
        if (!entity || entity.type !== 'terminal') return;
        const grid = entity.grid;
        if (!grid || typeof grid.onInput !== 'function') return;

        // Guard against DOM input elements — if the user is typing in the
        // CommandBar's <input>, we should NOT also forward keystrokes to
        // the terminal. ShortcutManager has the same guard.
        const tag = document.activeElement?.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

        const bytes = keyToBytes(e);
        if (bytes == null) return;

        // Suppress the browser default for non-printable keys (Tab would
        // otherwise move focus, Backspace might navigate, arrows might
        // scroll the page).
        e.preventDefault();
        e.stopPropagation();

        try {
            grid.onInput(bytes, slot.id);
        } catch (err) {
            console.error('[terminal-keystroke] onInput threw:', err);
        }
    }, { capture: true });
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
 * @param {import('../../src/services/orchestration/WebSocketBridge.js').default} bridge
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

    // 2a. Wire terminal keystroke delivery. Keys land here only when
    // attention.key points at a terminal entity (VCC's keydown gate
    // swallows the camera path when any key slot is held — see
    // ViewerCameraController.js keydown). The delivery closes the loop
    // the convergence docs called "local keystroke path":
    //   scene click -> attention.set primary -> CommandBar enters
    //   terminal-mode, but raw typing without going through the bar
    //   requires attention.key specifically, which a future slice wires
    //   via click-with-modifier or an explicit verb.
    // For now, if attention.key is held to a terminal, its onInput
    // callback (terminalCommands.js:90-98) receives the character.
    _installTerminalKeystrokeDelivery(context);

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

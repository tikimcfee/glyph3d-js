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
            // Serialize args to a single string, capped at MAX_LEN.
            // Error instances need special handling — their enumerable
            // own-props are empty, so JSON.stringify(err) === "{}" and
            // the relay log loses the actual failure.
            let text;
            try {
                text = args.map(a => {
                    if (typeof a === 'string') return a;
                    if (a instanceof Error) {
                        return a.stack ? `${a.message}\n${a.stack}` : a.message || String(a);
                    }
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
    if (!am || typeof document === 'undefined') return;

    // Per-entity-type handlers. Each returns `true` if the event was
    // consumed (we then preventDefault/stopPropagation), `false` if it
    // should pass through (e.g. modifier-combos we don't handle yet).
    const handlers = {
        terminal: _terminalKeyHandler,
        grid:     _gridKeyHandler,
    };

    document.addEventListener('keydown', (e) => {
        const slot = am.get('key');
        if (!slot) return;
        const entity = slot.entity;
        if (!entity) return;
        const handler = handlers[entity.type];
        if (!handler) return;

        // Guard against DOM input elements — if the user is typing in
        // the CommandBar's <input>, never also forward to the entity.
        const tag = document.activeElement?.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

        let consumed;
        try {
            consumed = handler(e, entity, slot, ctx);
        } catch (err) {
            console.error(`[entity-keystroke] ${entity.type} handler threw:`, err);
            consumed = false;
        }
        if (consumed) {
            // Suppress the browser default — Tab would move focus, Backspace
            // would navigate, arrows would scroll the page. stopImmediate
            // also blocks any same-target sibling listener from firing,
            // which is the belt-and-suspenders pair to ShortcutManager's
            // "defer when key=grid" guard.
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }, { capture: true });

    // When the key slot leaves a grid (Esc-LIFO clear, edit.stop, or
    // attention being moved elsewhere), tell the prior grid to exit edit
    // mode so the caret hides and the cursor model is forgotten.
    am.on('change:key', (newSlot, prevSlot) => {
        const prev = prevSlot?.entity;
        if (!prev || prev.type !== 'grid') return;
        if (newSlot?.entity?.grid === prev.grid) return;  // same grid; no-op
        const prevGrid = prev.grid;
        if (prevGrid && typeof prevGrid.exitEdit === 'function') {
            prevGrid.exitEdit();
        }
    });
}

/**
 * Translate a KeyboardEvent into the byte sequence a terminal expects
 * (single chars, ANSI escape sequences for arrows / function keys,
 * control bytes for Ctrl+letter). Returns null when the key should be
 * ignored entirely.
 * @private
 */
function _keyToTerminalBytes(e) {
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return null;

    if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
        const c = e.key.toLowerCase().charCodeAt(0);
        if (c >= 97 && c <= 122) return String.fromCharCode(c - 96);
    }

    switch (e.key) {
        case 'Enter':     return '\r';
        case 'Tab':       return '\t';
        case 'Backspace': return '\x7f';
        case 'Delete':    return '\x1b[3~';
        case 'Escape':    return null;
        case 'ArrowUp':    return '\x1b[A';
        case 'ArrowDown':  return '\x1b[B';
        case 'ArrowRight': return '\x1b[C';
        case 'ArrowLeft':  return '\x1b[D';
        case 'Home':       return '\x1b[H';
        case 'End':        return '\x1b[F';
        case 'PageUp':     return '\x1b[5~';
        case 'PageDown':   return '\x1b[6~';
    }

    if (e.key.length === 1) return e.key;
    return null;
}

/**
 * Terminal-entity key handler. Forwards via grid.onInput (the terminal
 * controller hook). @private
 */
function _terminalKeyHandler(e, entity, slot /*, ctx */) {
    const grid = entity.grid;
    if (!grid || typeof grid.onInput !== 'function') return false;
    const bytes = _keyToTerminalBytes(e);
    if (bytes == null) return false;
    grid.onInput(bytes, slot.id);
    return true;
}

/**
 * Grid-entity key handler. Maps printable / navigation / editing keys to
 * the CodeGrid edit ops set up in L2 M1. Bails on Ctrl/Alt/Meta combos
 * (reserved for app-level shortcuts and future copy/paste/undo). Ignores
 * Escape so the GitHubRepoViewer Esc-LIFO can clear attention.key first
 * and the change:key listener will then call exitEdit. @private
 */
function _gridKeyHandler(e, entity /*, slot, ctx */) {
    const grid = entity.grid;
    if (!grid || typeof grid.editInsert !== 'function') return false;
    if (!grid._cursor) return false;  // not in edit mode (defensive)

    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return false;
    if (e.ctrlKey || e.altKey || e.metaKey) return false;  // reserved combos
    if (e.key === 'Escape') return false;

    switch (e.key) {
        case 'ArrowLeft':  grid.editMoveCursor(-1, 0); return true;
        case 'ArrowRight': grid.editMoveCursor( 1, 0); return true;
        case 'ArrowUp':    grid.editMoveCursor( 0, -1); return true;
        case 'ArrowDown':  grid.editMoveCursor( 0,  1); return true;
        case 'Home':       grid.editHome(); return true;
        case 'End':        grid.editEnd(); return true;
        case 'Enter':      grid.editSplitLine(); return true;
        case 'Backspace':  grid.editDeleteBackward(); return true;
        case 'Delete':     grid.editDeleteForward(); return true;
        case 'Tab':        grid.editInsert('\t'); return true;
    }

    if (e.key.length === 1) {
        grid.editInsert(e.key);
        return true;
    }
    return false;
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

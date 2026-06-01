/**
 * Terminal commands — the CONTROL plane for terminal viewports. The byte DATA plane
 * is separate: OUTPUT arrives as binary frames (WebSocketBridge.onBinaryFrame →
 * grid.writeBytes → the headless VT emulator); INPUT leaves via grid.onInput → a
 * terminal.bytes push to the owning adapter. These verbs manage lifecycle + layout.
 *
 * Control verbs:
 *   terminal.spawn  [cols] [rows]            (ask relay to fork an adapter)
 *   terminal.create <id> [cols] [rows] [--scale N]
 *   terminal.resize <id> <cols> <rows>       (grid + emulator + adapter PTY in lockstep)
 *   terminal.ping   <id>                     (liveness probe → re-adopt trigger)
 *   terminal.close  <id>                     (dispose display grid only)
 *   terminal.kill   <id>                     (full teardown: shell + tmux + grid)
 *   terminal.focus  <id>                     (attention primary + key)
 *   terminal.list · terminal.move <id> <x> <y> <z> · terminal.scale <id> <factor>
 *
 * Grids render fixed-size cell grids via TerminalGrid, writing directly to GPU
 * attribute arrays (no GlyphCollection deferred queue).
 */

import TerminalGrid from '@glyph3d/core/collections/TerminalGrid.js';
import { encodeBase64 } from '@glyph3d/core/utils/encoding.js';

/**
 * Lazily initialise the terminal registry map on ctx.
 * @param {Object} ctx - command context
 * @returns {Map<string, TerminalGrid>}
 */
function getTerminals(ctx) {
    if (!ctx.terminals) {
        ctx.terminals = new Map();
    }
    return ctx.terminals;
}

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerTerminalCommands(router) {

    // ------------------------------------------------------------------
    // terminal.spawn [cols] [rows]
    //   Ask the relay (Go server) to fork a `glyph3d-cli attach` adapter — a REAL
    //   shell (tmux) wired into a fresh TerminalGrid. The browser can't spawn a
    //   host process, so this sends a {relay:"terminal.spawn"} message the relay
    //   handles server-side; the terminal appears once the forked adapter connects
    //   and runs terminal.create + frames. (This is the "+ terminal" button's verb.)
    // ------------------------------------------------------------------
    router.register('terminal.spawn', (args, ctx) => {
        const bridge = ctx.wsbridge;
        if (!bridge || !bridge.connected || typeof bridge.send !== 'function') {
            return { text: 'ERR: not connected to the relay — terminal.spawn needs the Go server to fork an adapter', data: null };
        }
        const msg = { relay: 'terminal.spawn' };
        const cols = parseInt(args[0], 10);
        const rows = parseInt(args[1], 10);
        if (!isNaN(cols) && cols > 0) msg.cols = cols;
        if (!isNaN(rows) && rows > 0) msg.rows = rows;
        bridge.send(JSON.stringify(msg));
        return {
            text: 'OK: requested terminal spawn (relay is forking an adapter)',
            data: { requested: true, cols: msg.cols ?? null, rows: msg.rows ?? null },
        };
    }, { description: 'Ask the relay to fork a terminal adapter — a real shell in the canvas', usage: '[cols] [rows]' });

    // ------------------------------------------------------------------
    // terminal.create <id> [cols] [rows] [--scale N]
    // ------------------------------------------------------------------
    router.register('terminal.create', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: terminal.create <id> [cols] [rows] [--scale N]', data: null };
        }

        // Parse --scale flag (gridScale: overall size multiplier, default 2x for readability)
        let gridScale = 2.0;
        const cleanArgs = [];
        for (let i = 0; i < args.length; i++) {
            if (args[i] === '--scale' && args[i + 1]) {
                const s = parseFloat(args[++i]);
                if (!isNaN(s) && s > 0) gridScale = s;
            } else {
                cleanArgs.push(args[i]);
            }
        }

        const id   = cleanArgs[0];
        const cols = cleanArgs[1] ? parseInt(cleanArgs[1], 10) : 80;
        const rows = cleanArgs[2] ? parseInt(cleanArgs[2], 10) : 24;

        if (isNaN(cols) || isNaN(rows) || cols < 1 || rows < 1) {
            return { text: 'ERR: cols and rows must be positive integers', data: null };
        }

        const terminals = getTerminals(ctx);
        if (terminals.has(id)) {
            // Idempotent: re-adoption re-sends terminal.create (an adapter whose
            // display reloaded and forgot it). The live grid is already here, so
            // treat this as success rather than erroring the adapter's retry.
            return { text: `OK: terminal '${id}' already present`, data: { id, existed: true } };
        }

        try {
            const grid = new TerminalGrid(ctx.scene, ctx.atlas, {
                cols,
                rows,
                gridScale,
                title: id,
            });

            terminals.set(id, grid);

            // Wire onInput callback for remote owners (agent controllers).
            // If a sender (controller ID) exists and the bridge is available,
            // route input back to the owning controller via push().
            const owner = ctx.sender || null;
            if (owner && ctx.wsbridge && ctx.wsbridge.connected) {
                // INPUT data plane: raw ANSI bytes (from EntityKeystrokeRouter) → the
                // owning adapter's PTY. base64 in a JSON push — keystrokes are sparse,
                // so the binary lane is reserved for the high-volume OUTPUT direction.
                grid.onInput = (bytes, termId) => {
                    ctx.wsbridge.push(owner, {
                        event: 'terminal.bytes',
                        data: { terminalId: termId, b64: encodeBase64(bytes) },
                    });
                };
            }

            // Register in the scene registry so spatial commands, highlight, etc. work.
            ctx.registry.register(id, grid, {
                type: 'terminal',
                terminalId: id,
                cols,
                rows,
                owner,
            });

            const pos = grid.position;
            return {
                text: `OK: terminal '${id}' created (${cols}x${rows}) scale=${gridScale}`,
                data: { id, cols, rows, gridScale, position: { x: pos.x, y: pos.y, z: pos.z } },
            };
        } catch (e) {
            return { text: `ERR: ${e.message}`, data: null };
        }
    }, { description: 'Create a terminal grid', usage: '<id> [cols] [rows] [--scale N]' });

    // ------------------------------------------------------------------
    // terminal.ping <id>
    //   Liveness probe, DECOUPLED from output. The adapter pings periodically; an
    //   "ERR: no terminal" reply (after a display reload wiped the registry) is what
    //   triggers the adapter to re-create the grid. Output can't be the re-adopt
    //   trigger — an idle shell emits no OUTPUT frames at all.
    // ------------------------------------------------------------------
    router.register('terminal.ping', (args, ctx) => {
        const id = args[0];
        if (!id) {
            return { text: 'ERR: usage: terminal.ping <id>', data: null };
        }
        if (!getTerminals(ctx).has(id)) {
            return { text: `ERR: no terminal '${id}'`, data: null };
        }
        return { text: 'OK', data: { id, alive: true } };
    }, { description: 'Liveness probe — OK if the terminal grid exists', usage: '<id>' });

    // ------------------------------------------------------------------
    // terminal.resize <id> <cols> <rows>
    // ------------------------------------------------------------------
    router.register('terminal.resize', (args, ctx) => {
        if (args.length < 3) {
            return { text: 'ERR: usage: terminal.resize <id> <cols> <rows>', data: null };
        }

        const id = args[0];
        const terminals = getTerminals(ctx);
        const grid = terminals.get(id);
        if (!grid) return { text: `ERR: no terminal '${id}'`, data: null };

        const cols = parseInt(args[1], 10);
        const rows = parseInt(args[2], 10);
        if (isNaN(cols) || isNaN(rows) || cols < 1 || rows < 1) {
            return { text: 'ERR: cols and rows must be positive integers', data: null };
        }

        grid.resize(cols, rows);

        // Update registry metadata if it exists
        const info = ctx.registry.get(id);
        if (info) {
            info.cols = cols;
            info.rows = rows;
        }

        // Tell the owning adapter so it resizes the REAL PTY (pty.Setsize → SIGWINCH →
        // tmux). Without this the shell keeps its old winsize and reflow breaks — the
        // grid/emulator would be the only things that resized.
        const owner = info?.meta?.owner;
        if (owner && ctx.wsbridge?.connected) {
            ctx.wsbridge.push(owner, { event: 'terminal.resize', data: { terminalId: id, cols, rows } });
        }

        return {
            text: `OK: terminal '${id}' resized to ${cols}x${rows}`,
            data: { id, cols, rows },
        };
    }, { description: 'Resize a terminal grid', usage: '<id> <cols> <rows>' });

    // ------------------------------------------------------------------
    // terminal.scroll <id> <lines>   (+ = back into history, − = forward to live)
    // ------------------------------------------------------------------
    router.register('terminal.scroll', (args, ctx) => {
        if (args.length < 2) {
            return { text: 'ERR: usage: terminal.scroll <id> <lines> (+back/-forward)', data: null };
        }
        const id = args[0];
        const lines = parseInt(args[1], 10);
        if (isNaN(lines)) return { text: 'ERR: lines must be an integer', data: null };

        const info = ctx.registry.get(id);
        if (!info) return { text: `ERR: no terminal '${id}'`, data: null };

        // Scrollback is tmux-owned: the adapter drives copy-mode (copy-mode + scroll-up /
        // scroll-down) and the resulting repaint streams back through the byte lane — the
        // grid/emulator just mirror it (no client-side scroll state). A pure control push,
        // like terminal.resize.
        const owner = info?.meta?.owner;
        if (owner && ctx.wsbridge?.connected) {
            ctx.wsbridge.push(owner, { event: 'terminal.scroll', data: { terminalId: id, lines } });
        }
        return { text: `OK: terminal '${id}' scroll ${lines}`, data: { id, lines } };
    }, { description: "Scroll a terminal's tmux scrollback (+ back / - forward)", usage: '<id> <lines>' });

    // ------------------------------------------------------------------
    // terminal.close <id>
    // ------------------------------------------------------------------
    router.register('terminal.close', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: terminal.close <id>', data: null };
        }

        const id = args[0];
        const terminals = getTerminals(ctx);
        const grid = terminals.get(id);
        if (!grid) return { text: `ERR: no terminal '${id}'`, data: null };

        grid.dispose();
        terminals.delete(id);
        ctx.registry.unregister(id);

        return {
            text: `OK: terminal '${id}' closed`,
            data: { id },
        };
    }, { description: 'Dispose and unregister a terminal grid', usage: '<id>' });

    // ------------------------------------------------------------------
    // terminal.list
    // ------------------------------------------------------------------
    router.register('terminal.list', (args, ctx) => {
        const terminals = getTerminals(ctx);
        if (terminals.size === 0) {
            return { text: 'OK: 0 terminals', data: { terminals: [], count: 0 } };
        }

        const list = [];
        for (const [id, grid] of terminals) {
            const p = grid.position;
            list.push({ id, cols: grid.cols, rows: grid.rows, position: { x: p.x, y: p.y, z: p.z } });
        }

        const lines = list.map(t =>
            `  ${t.id}: ${t.cols}x${t.rows} at (${t.position.x},${t.position.y},${t.position.z})`
        );
        return {
            text: lines.join('\n') + `\nOK: ${list.length} terminal(s)`,
            data: { terminals: list, count: list.length },
        };
    }, { description: 'List all terminal grids' });

    // ------------------------------------------------------------------
    // terminal.move <id> <x> <y> <z>
    // ------------------------------------------------------------------
    router.register('terminal.move', (args, ctx) => {
        if (args.length < 4) {
            return { text: 'ERR: usage: terminal.move <id> <x> <y> <z>', data: null };
        }

        const id = args[0];
        const terminals = getTerminals(ctx);
        const grid = terminals.get(id);
        if (!grid) return { text: `ERR: no terminal '${id}'`, data: null };

        const [x, y, z] = args.slice(1, 4).map(Number);
        if ([x, y, z].some(isNaN)) {
            return { text: 'ERR: x, y, z must be numbers', data: null };
        }

        // setWorldPosition mirrors to both group DataTexture and Object3D.position.
        grid.setWorldPosition({ x, y, z });

        return {
            text: `OK: terminal '${id}' moved to (${x},${y},${z})`,
            data: { id, position: { x, y, z } },
        };
    }, { description: 'Move a terminal grid in 3D space', usage: '<id> <x> <y> <z>' });

    // ------------------------------------------------------------------
    // terminal.scale <id> <factor>
    // ------------------------------------------------------------------
    router.register('terminal.scale', (args, ctx) => {
        if (args.length < 2) {
            return { text: 'ERR: usage: terminal.scale <id> <factor>', data: null };
        }

        const id = args[0];
        const terminals = getTerminals(ctx);
        const grid = terminals.get(id);
        if (!grid) return { text: `ERR: no terminal '${id}'`, data: null };

        const factor = parseFloat(args[1]);
        if (isNaN(factor) || factor <= 0) {
            return { text: 'ERR: factor must be a positive number', data: null };
        }

        grid.setScale(factor);

        return {
            text: `OK: terminal '${id}' scale = ${factor}`,
            data: { id, scale: factor },
        };
    }, { description: 'Set the scale of a terminal grid', usage: '<id> <factor>' });

    // ------------------------------------------------------------------
    // terminal.kill <id>
    //   FULL teardown — the panel × button's verb. terminal.close only disposes
    //   the display grid; on its own it orphans the adapter process AND its tmux
    //   session (they become zombies). terminal.kill instead signals the owning
    //   adapter (recorded at create time) to shut down: the adapter kills its tmux
    //   session, exits, and sends its OWN terminal.close — the single dispose path.
    //   If there's no live owner to signal (drift: the adapter already died), we
    //   dispose locally so the canvas still clears.
    // ------------------------------------------------------------------
    router.register('terminal.kill', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: terminal.kill <id>', data: null };
        }

        const id = args[0];
        const terminals = getTerminals(ctx);
        const grid = terminals.get(id);
        if (!grid) return { text: `ERR: no terminal '${id}'`, data: null };

        const owner = ctx.registry.get(id)?.meta?.owner || null;
        const bridge = ctx.wsbridge;
        const canSignal = owner && bridge && bridge.connected && typeof bridge.push === 'function';

        if (canSignal) {
            // Adapter is alive — let it tear down tmux + itself, then dispose the
            // grid via its trailing terminal.close. One dispose path, no leaks.
            bridge.push(owner, { event: 'terminal.shutdown', data: { terminalId: id } });
            return {
                text: `OK: signaled adapter '${owner}' to shut down terminal '${id}'`,
                data: { id, owner, signaled: true },
            };
        }

        // No live owner — dispose locally (same path as terminal.close).
        grid.dispose();
        terminals.delete(id);
        ctx.registry.unregister(id);
        return {
            text: `OK: terminal '${id}' closed locally (no live adapter to signal)`,
            data: { id, signaled: false },
        };
    }, { description: 'Fully tear down a terminal: signal its adapter to kill the shell + tmux session', usage: '<id>' });

    // ------------------------------------------------------------------
    // terminal.focus <id>
    //   Make a terminal the focused entity: primary (sticky/UI focus) AND key
    //   (keystroke target) in one verb — the two slots a canvas click sets
    //   together. Framing the camera is a separate concern (camera.focus <id>).
    // ------------------------------------------------------------------
    router.register('terminal.focus', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: terminal.focus <id>', data: null };
        }
        const id = args[0];
        if (!getTerminals(ctx).has(id)) {
            return { text: `ERR: no terminal '${id}'`, data: null };
        }
        if (!ctx.attentionManager) {
            return { text: 'ERR: AttentionManager not wired into ctx', data: null };
        }
        // Pass the resolved registry entry as the entity so keystroke routing
        // (EntityKeystrokeRouter, keyed on entity.type) has a usable reference.
        const entity = ctx.registry?.get(id) || null;
        ctx.attentionManager.set('primary', id, { entity });
        ctx.attentionManager.set('key', id, { entity });
        return {
            text: `OK: focused terminal '${id}' (primary + key)`,
            data: { id, entityType: entity?.type ?? null },
        };
    }, { description: 'Focus a terminal: set attention primary + key (keystroke target)', usage: '<id>' });
}

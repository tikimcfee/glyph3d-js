/**
 * Terminal commands: terminal.create, terminal.frame, terminal.resize,
 * terminal.close, terminal.list, terminal.move, terminal.scale
 *
 * These commands render fixed-size terminal cell grids via TerminalGrid,
 * which bypasses the GlyphCollection deferred queue and writes directly
 * to GPU attribute arrays.
 *
 * Wire protocol:
 *   terminal.create <id> [cols] [rows] [--scale N]
 *   terminal.frame  <id> <base64-content>
 *   terminal.resize <id> <cols> <rows>
 *   terminal.close  <id>
 *   terminal.list
 *   terminal.move   <id> <x> <y> <z>
 *   terminal.scale  <id> <factor>
 *
 * Content in terminal.frame is base64-encoded raw terminal output.
 * For Tier 1 bridges (capture-pane -p): plain text.
 * For Tier 2 bridges (capture-pane -p -e): text with ANSI SGR sequences.
 * TerminalGrid.write() handles both transparently via parseCapturePaneAnsi().
 */

import TerminalGrid from '@glyph3d/core/collections/TerminalGrid.js';
import { decodeBase64, encodeBase64 } from '@glyph3d/core/utils/encoding.js';

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
            return { text: `ERR: terminal '${id}' already exists`, data: null };
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
                grid.onInput = (text, termId) => {
                    ctx.wsbridge.push(owner, {
                        event: 'terminal.input',
                        data: { terminalId: termId, text },
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
    // terminal.frame <id> <base64-content>
    // ------------------------------------------------------------------
    router.register('terminal.frame', (args, ctx) => {
        if (args.length < 2) {
            return { text: 'ERR: usage: terminal.frame <id> <base64-content>', data: null };
        }

        const id = args[0];
        const terminals = getTerminals(ctx);
        const grid = terminals.get(id);
        if (!grid) {
            return { text: `ERR: no terminal '${id}'`, data: null };
        }

        let text;
        try {
            text = decodeBase64(args[1]);
        } catch {
            return { text: 'ERR: invalid base64', data: null };
        }

        try {
            // write() calls parseCapturePaneAnsi() then applyScreen() internally.
            // Handles both plain text (Tier 1) and ANSI-colored text (Tier 2).
            grid.write(text);
            return {
                text: `OK: terminal '${id}' frame applied (${grid.cols}x${grid.rows})`,
                data: { id, cols: grid.cols, rows: grid.rows },
            };
        } catch (e) {
            return { text: `ERR: ${e.message}`, data: null };
        }
    }, { description: 'Send a terminal frame (base64-encoded output)', usage: '<id> <base64-content>' });

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

        return {
            text: `OK: terminal '${id}' resized to ${cols}x${rows}`,
            data: { id, cols, rows },
        };
    }, { description: 'Resize a terminal grid', usage: '<id> <cols> <rows>' });

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
    // terminal.input <id> <base64-text>
    // ------------------------------------------------------------------
    router.register('terminal.input', (args, ctx) => {
        if (args.length < 2) {
            return { text: 'ERR: usage: terminal.input <id> <base64-text>', data: null };
        }

        const id = args[0];
        const grid = getTerminals(ctx).get(id);
        if (!grid) {
            return { text: `ERR: no terminal '${id}'`, data: null };
        }

        let text;
        try {
            text = decodeBase64(args[1]);
        } catch {
            return { text: 'ERR: invalid base64 payload', data: null };
        }

        if (typeof grid.onInput === 'function') {
            grid.onInput(text, id);
            return {
                text: `OK: sent ${text.length} chars to '${id}'`,
                data: { id, length: text.length },
            };
        }

        return {
            text: `WARN: terminal '${id}' has no input handler`,
            data: { id, dropped: true },
        };
    }, { description: 'Send input to a terminal (base64-encoded)', usage: '<id> <base64-text>' });
}

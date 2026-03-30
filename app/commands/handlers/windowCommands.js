/**
 * Window commands: window.create, window.write, window.append,
 * window.clear, window.close, window.list, window.resize, window.move,
 * window.scroll
 *
 * Content args use base64 encoding (decodeBase64) matching the grid.* pattern.
 */

import TUIWindowManager from '../../../src/tui/TUIWindowManager.js';
import { decodeBase64 } from '../../../src/utils/encoding.js';

/**
 * Ensure ctx.windowManager exists, lazily creating it.
 * @param {Object} ctx
 * @returns {TUIWindowManager}
 */
function getOrCreateManager(ctx) {
    if (!ctx.windowManager) {
        ctx.windowManager = new TUIWindowManager(ctx.scene, ctx.atlas);
    }
    return ctx.windowManager;
}

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerWindowCommands(router) {

    router.register('window.create', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: window.create <id> [cols] [rows] [title] [--scale N]', data: null };
        }
        const mgr = getOrCreateManager(ctx);

        // Parse flags from args
        let scale = 2.0;  // Default: 2x scale (bigger than code grids for readability)
        const cleanArgs = [];
        for (let i = 0; i < args.length; i++) {
            if (args[i] === '--scale' && args[i + 1]) {
                scale = parseFloat(args[++i]);
                if (isNaN(scale)) scale = 2.0;
            } else {
                cleanArgs.push(args[i]);
            }
        }

        const id = cleanArgs[0];
        const cols = cleanArgs[1] ? parseInt(cleanArgs[1]) : 80;
        const rows = cleanArgs[2] ? parseInt(cleanArgs[2]) : 24;
        const title = cleanArgs[3] || id;

        if (mgr.windows.has(id)) {
            return { text: `ERR: window '${id}' already exists`, data: null };
        }

        try {
            const win = mgr.create(id, { cols, rows, title, scale });
            const pos = win.getPosition();

            // Register the window's grid in the scene registry
            ctx.registry.register(id, win.grid, {
                type: 'window',
                windowId: id,
                title,
                cols,
                rows,
            });

            return {
                text: `OK: window '${id}' created (${cols}x${rows}) at (${pos.x},${pos.y},${pos.z})`,
                data: { id, cols, rows, title, position: pos },
            };
        } catch (e) {
            return { text: `ERR: ${e.message}`, data: null };
        }
    }, { description: 'Create a TUI window', usage: '<id> [cols] [rows] [title]' });

    router.register('window.write', (args, ctx) => {
        if (args.length < 2) {
            return { text: 'ERR: usage: window.write <id> <base64-text>', data: null };
        }
        const mgr = getOrCreateManager(ctx);
        const win = mgr.get(args[0]);
        if (!win) return { text: `ERR: no window '${args[0]}'`, data: null };

        let text;
        try { text = decodeBase64(args[1]); } catch { return { text: 'ERR: invalid base64', data: null }; }

        win.write(text);
        return {
            text: `OK: window '${args[0]}' written (${win.historyLength} lines)`,
            data: { id: args[0], historyLines: win.historyLength },
        };
    }, { description: 'Replace window content', usage: '<id> <base64-text>' });

    router.register('window.append', (args, ctx) => {
        if (args.length < 2) {
            return { text: 'ERR: usage: window.append <id> <base64-text>', data: null };
        }
        const mgr = getOrCreateManager(ctx);
        const win = mgr.get(args[0]);
        if (!win) return { text: `ERR: no window '${args[0]}'`, data: null };

        let text;
        try { text = decodeBase64(args[1]); } catch { return { text: 'ERR: invalid base64', data: null }; }

        win.appendLine(text);
        return {
            text: `OK: window '${args[0]}' appended (${win.historyLength} lines)`,
            data: { id: args[0], historyLines: win.historyLength },
        };
    }, { description: 'Append text to window', usage: '<id> <base64-text>' });

    router.register('window.clear', (args, ctx) => {
        if (args.length < 1) return { text: 'ERR: usage: window.clear <id>', data: null };
        const mgr = getOrCreateManager(ctx);
        const win = mgr.get(args[0]);
        if (!win) return { text: `ERR: no window '${args[0]}'`, data: null };
        win.clear();
        return { text: `OK: window '${args[0]}' cleared`, data: { id: args[0] } };
    }, { description: 'Clear window content', usage: '<id>' });

    router.register('window.close', (args, ctx) => {
        if (args.length < 1) return { text: 'ERR: usage: window.close <id>', data: null };
        const mgr = getOrCreateManager(ctx);
        const removed = mgr.remove(args[0]);
        if (!removed) return { text: `ERR: no window '${args[0]}'`, data: null };

        // Unregister from scene registry
        ctx.registry.unregister(args[0]);

        return { text: `OK: window '${args[0]}' closed`, data: { id: args[0] } };
    }, { description: 'Close and dispose a window', usage: '<id>' });

    router.register('window.list', (args, ctx) => {
        const mgr = getOrCreateManager(ctx);
        const list = mgr.list();
        if (list.length === 0) {
            return { text: 'OK: 0 windows', data: { windows: [], count: 0 } };
        }
        const lines = list.map(w =>
            `  ${w.id}: ${w.cols}x${w.rows} "${w.title}" (${w.historyLines} lines)`
        );
        return {
            text: lines.join('\n') + `\nOK: ${list.length} windows`,
            data: { windows: list, count: list.length },
        };
    }, { description: 'List all TUI windows' });

    router.register('window.resize', (args, ctx) => {
        if (args.length < 3) {
            return { text: 'ERR: usage: window.resize <id> <cols> <rows>', data: null };
        }
        const mgr = getOrCreateManager(ctx);
        const win = mgr.get(args[0]);
        if (!win) return { text: `ERR: no window '${args[0]}'`, data: null };
        const cols = parseInt(args[1]);
        const rows = parseInt(args[2]);
        if (isNaN(cols) || isNaN(rows)) return { text: 'ERR: cols/rows must be numbers', data: null };
        win.resize(cols, rows);
        return {
            text: `OK: window '${args[0]}' resized to ${cols}x${rows}`,
            data: { id: args[0], cols, rows },
        };
    }, { description: 'Resize a window', usage: '<id> <cols> <rows>' });

    router.register('window.move', (args, ctx) => {
        if (args.length < 4) {
            return { text: 'ERR: usage: window.move <id> <x> <y> <z>', data: null };
        }
        const mgr = getOrCreateManager(ctx);
        const win = mgr.get(args[0]);
        if (!win) return { text: `ERR: no window '${args[0]}'`, data: null };
        const [x, y, z] = args.slice(1, 4).map(Number);
        if ([x, y, z].some(isNaN)) return { text: 'ERR: x,y,z must be numbers', data: null };
        win.setPosition(x, y, z);
        return {
            text: `OK: window '${args[0]}' moved to (${x},${y},${z})`,
            data: { id: args[0], position: { x, y, z } },
        };
    }, { description: 'Move window in 3D space', usage: '<id> <x> <y> <z>' });

    router.register('window.scroll', (args, ctx) => {
        if (args.length < 2) {
            return { text: 'ERR: usage: window.scroll <id> <up|down|bottom> [n]', data: null };
        }
        const mgr = getOrCreateManager(ctx);
        const win = mgr.get(args[0]);
        if (!win) return { text: `ERR: no window '${args[0]}'`, data: null };

        const direction = args[1];
        const n = args[2] ? parseInt(args[2]) : 1;

        switch (direction) {
            case 'up':
                win.scrollUp(isNaN(n) ? 1 : n);
                break;
            case 'down':
                win.scrollDown(isNaN(n) ? 1 : n);
                break;
            case 'bottom':
                win.scrollToBottom();
                break;
            default:
                return { text: `ERR: unknown direction '${direction}' (use up|down|bottom)`, data: null };
        }

        return {
            text: `OK: window '${args[0]}' scrolled ${direction} (offset=${win.scrollOffset})`,
            data: { id: args[0], scrollOffset: win.scrollOffset },
        };
    }, { description: 'Scroll window content', usage: '<id> <up|down|bottom> [n]' });

    router.register('window.scale', (args, ctx) => {
        if (args.length < 2) {
            return { text: 'ERR: usage: window.scale <id> <factor>', data: null };
        }
        const mgr = getOrCreateManager(ctx);
        const win = mgr.get(args[0]);
        if (!win) return { text: `ERR: no window '${args[0]}'`, data: null };
        const scale = parseFloat(args[1]);
        if (isNaN(scale) || scale <= 0) return { text: 'ERR: scale must be a positive number', data: null };
        win.setScale(scale);
        return {
            text: `OK: window '${args[0]}' scale = ${scale}`,
            data: { id: args[0], scale },
        };
    }, { description: 'Set window scale (larger = bigger)', usage: '<id> <factor>' });
}

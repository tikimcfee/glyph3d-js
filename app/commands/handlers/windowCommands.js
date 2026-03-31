/**
 * Window commands: window.create, window.write, window.append,
 * window.clear, window.close, window.list, window.move, window.scale
 *
 * Backed by AgentGrid — a thin CodeGrid wrapper with identity and append I/O.
 * Content args use base64 encoding (decodeBase64) matching the grid.* pattern.
 */

import AgentGrid from '../../../src/collections/AgentGrid.js';
import { decodeBase64 } from '../../../src/utils/encoding.js';

// Agent grid registry: Map<string, AgentGrid>
// Lazily created on ctx so it persists across command calls.

/** Auto-position state for stacking agent grids. */
const _autoPos = { x: -100, y: 50, spacing: 30 };

function getOrCreateWindows(ctx) {
    if (!ctx._agentGrids) ctx._agentGrids = new Map();
    return ctx._agentGrids;
}

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerWindowCommands(router) {

    router.register('window.create', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: window.create <id> [cols] [rows] [title] [--scale N]', data: null };
        }

        const windows = getOrCreateWindows(ctx);

        // Parse flags
        let scale = 2.0;
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
        const title = cleanArgs[3] || id;

        if (windows.has(id)) {
            return { text: `ERR: window '${id}' already exists`, data: null };
        }

        // Auto-position
        const position = { x: _autoPos.x, y: _autoPos.y, z: 0 };
        _autoPos.y -= _autoPos.spacing;
        if (_autoPos.y < -150) {
            _autoPos.y = 50;
            _autoPos.x += 80;
        }

        const agentGrid = new AgentGrid(id, ctx.scene, ctx.atlas, {
            title, scale, position,
        });

        windows.set(id, agentGrid);

        // Register in scene registry
        ctx.registry.register(id, agentGrid.grid, {
            type: 'agent',
            agentId: id,
            title,
        });

        const pos = agentGrid.getPosition();
        return {
            text: `OK: window '${id}' created at (${pos.x},${pos.y},${pos.z})`,
            data: { id, title, position: pos },
        };
    }, { description: 'Create an agent window', usage: '<id> [cols] [rows] [title] [--scale N]' });

    router.register('window.write', (args, ctx) => {
        if (args.length < 2) {
            return { text: 'ERR: usage: window.write <id> <base64-text>', data: null };
        }
        const windows = getOrCreateWindows(ctx);
        const ag = windows.get(args[0]);
        if (!ag) return { text: `ERR: no window '${args[0]}'`, data: null };

        let text;
        try { text = decodeBase64(args[1]); } catch { return { text: 'ERR: invalid base64', data: null }; }

        ag.write(text);
        return {
            text: `OK: window '${args[0]}' written (${ag.historyLength} lines)`,
            data: { id: args[0], historyLines: ag.historyLength },
        };
    }, { description: 'Replace window content', usage: '<id> <base64-text>' });

    router.register('window.append', (args, ctx) => {
        if (args.length < 2) {
            return { text: 'ERR: usage: window.append <id> <base64-text>', data: null };
        }
        const windows = getOrCreateWindows(ctx);
        const ag = windows.get(args[0]);
        if (!ag) return { text: `ERR: no window '${args[0]}'`, data: null };

        let text;
        try { text = decodeBase64(args[1]); } catch { return { text: 'ERR: invalid base64', data: null }; }

        ag.appendLine(text);
        return {
            text: `OK: window '${args[0]}' appended (${ag.historyLength} lines)`,
            data: { id: args[0], historyLines: ag.historyLength },
        };
    }, { description: 'Append text to window', usage: '<id> <base64-text>' });

    router.register('window.clear', (args, ctx) => {
        if (args.length < 1) return { text: 'ERR: usage: window.clear <id>', data: null };
        const windows = getOrCreateWindows(ctx);
        const ag = windows.get(args[0]);
        if (!ag) return { text: `ERR: no window '${args[0]}'`, data: null };
        ag.clear();
        return { text: `OK: window '${args[0]}' cleared`, data: { id: args[0] } };
    }, { description: 'Clear window content', usage: '<id>' });

    router.register('window.close', (args, ctx) => {
        if (args.length < 1) return { text: 'ERR: usage: window.close <id>', data: null };
        const windows = getOrCreateWindows(ctx);
        const ag = windows.get(args[0]);
        if (!ag) return { text: `ERR: no window '${args[0]}'`, data: null };
        ag.dispose();
        windows.delete(args[0]);
        ctx.registry.unregister(args[0]);
        return { text: `OK: window '${args[0]}' closed`, data: { id: args[0] } };
    }, { description: 'Close and dispose a window', usage: '<id>' });

    router.register('window.list', (args, ctx) => {
        const windows = getOrCreateWindows(ctx);
        if (windows.size === 0) {
            return { text: 'OK: 0 windows', data: { windows: [], count: 0 } };
        }
        const list = [];
        for (const [id, ag] of windows) {
            list.push({
                id,
                title: ag.title,
                position: ag.getPosition(),
                historyLines: ag.historyLength,
            });
        }
        const lines = list.map(w =>
            `  ${w.id}: "${w.title}" (${w.historyLines} lines)`
        );
        return {
            text: lines.join('\n') + `\nOK: ${list.length} windows`,
            data: { windows: list, count: list.length },
        };
    }, { description: 'List all agent windows' });

    router.register('window.move', (args, ctx) => {
        if (args.length < 4) {
            return { text: 'ERR: usage: window.move <id> <x> <y> <z>', data: null };
        }
        const windows = getOrCreateWindows(ctx);
        const ag = windows.get(args[0]);
        if (!ag) return { text: `ERR: no window '${args[0]}'`, data: null };
        const [x, y, z] = args.slice(1, 4).map(Number);
        if ([x, y, z].some(isNaN)) return { text: 'ERR: x,y,z must be numbers', data: null };
        ag.setPosition(x, y, z);
        return {
            text: `OK: window '${args[0]}' moved to (${x},${y},${z})`,
            data: { id: args[0], position: { x, y, z } },
        };
    }, { description: 'Move window in 3D space', usage: '<id> <x> <y> <z>' });

    router.register('window.scale', (args, ctx) => {
        if (args.length < 2) {
            return { text: 'ERR: usage: window.scale <id> <factor>', data: null };
        }
        const windows = getOrCreateWindows(ctx);
        const ag = windows.get(args[0]);
        if (!ag) return { text: `ERR: no window '${args[0]}'`, data: null };
        const scale = parseFloat(args[1]);
        if (isNaN(scale) || scale <= 0) return { text: 'ERR: scale must be a positive number', data: null };
        ag.setScale(scale);
        return {
            text: `OK: window '${args[0]}' scale = ${scale}`,
            data: { id: args[0], scale },
        };
    }, { description: 'Set window scale', usage: '<id> <factor>' });
}

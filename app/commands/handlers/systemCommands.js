/**
 * System commands: help, status
 * Migrated from stale WebSocket branch to use context bag instead of raw viewer.
 */

import { box, kvLines } from '../../../src/tui/TUIFormatter.js';

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerSystemCommands(router) {
    router.register('help', (args, ctx) => {
        const cmds = router.listCommands();

        // Optional namespace filter
        if (args.length > 0) {
            const ns = args[0].toLowerCase();
            const filtered = cmds.filter(c => c.name.startsWith(ns));
            if (filtered.length === 0) {
                return { text: `No commands matching '${ns}'`, data: null };
            }
            const lines = filtered.map(c => {
                const usage = c.usage ? ` ${c.usage}` : '';
                const name = `${c.name}${usage}`;
                const padded = name.length < 30 ? name + ' '.repeat(30 - name.length) : name + '  ';
                return `${padded}${c.description}`;
            });
            return {
                text: box(`COMMANDS: ${ns}*`, lines, 70),
                data: { commands: filtered }
            };
        }

        const lines = cmds.map(c => {
            const usage = c.usage ? ` ${c.usage}` : '';
            const name = `${c.name}${usage}`;
            const padded = name.length < 30 ? name + ' '.repeat(30 - name.length) : name + '  ';
            return `${padded}${c.description}`;
        });
        return {
            text: box('COMMANDS', lines, 70) + '\nOK: ' + cmds.length + ' commands available',
            data: { commands: cmds, count: cmds.length }
        };
    }, { description: 'List all commands', usage: '[namespace]' });

    router.register('status', (args, ctx) => {
        const cam = ctx.camera.position;
        const gridEntries = ctx.registry.findByType('grid');
        let totalGlyphs = 0;
        for (const e of gridEntries) totalGlyphs += e.grid.getGlyphCount();

        const winCount = ctx.windowManager ? ctx.windowManager.count : 0;
        const wsConnected = ctx.wsbridge ? ctx.wsbridge.connected : false;

        const data = {
            'grids': String(gridEntries.length),
            'glyphs': totalGlyphs.toLocaleString(),
            'windows': String(winCount),
            'registry': String(ctx.registry.size),
            'camera': `${cam.x.toFixed(0)}, ${cam.y.toFixed(0)}, ${cam.z.toFixed(0)}`,
            'websocket': wsConnected ? 'connected' : 'disconnected',
        };

        const lines = kvLines(data);
        return {
            text: box('STATUS', lines, 40) + '\nOK: status',
            data: {
                gridCount: gridEntries.length,
                glyphCount: totalGlyphs,
                windowCount: winCount,
                registryTotal: ctx.registry.size,
                camera: { x: cam.x, y: cam.y, z: cam.z },
                websocket: wsConnected,
            }
        };
    }, { description: 'Show scene status' });

    router.register('batch', async (args, ctx) => {
        if (args.length < 1) return { text: 'ERR: usage: batch <json-array-of-commands>', data: null };
        let commands;
        try {
            commands = JSON.parse(args.join(' '));
        } catch {
            return { text: 'ERR: batch argument must be a JSON array of command strings', data: null };
        }
        if (!Array.isArray(commands)) {
            return { text: 'ERR: batch argument must be a JSON array', data: null };
        }

        const results = await router.executeBatch(commands);
        const failed = results.filter(r => r.text.startsWith('ERR:')).length;
        const succeeded = results.length - failed;

        return {
            text: `OK: batch completed (${succeeded}/${results.length} succeeded${failed ? `, ${failed} failed` : ''})`,
            data: { results, succeeded, failed }
        };
    }, { description: 'Execute multiple commands in one round-trip', usage: '<json-array>' });

    router.register('reload', (args, ctx) => {
        // Schedule the reload after sending the response, so the caller gets the OK.
        // Cache-busting: append a timestamp query param to force fresh fetch of all modules.
        setTimeout(() => {
            const url = new URL(window.location.href);
            url.searchParams.set('_reload', Date.now());
            window.location.href = url.toString();
        }, 200);
        return { text: 'OK: reloading page in 200ms (cache-busting)', data: null };
    }, { description: 'Reload the browser page (cache-busting, picks up code changes)' });

    router.register('console.log', (args, ctx) => {
        // Capture and return recent console output — useful for remote debugging.
        // For now, return a confirmation. Future: hook console and buffer recent entries.
        const msg = args.join(' ');
        console.log(`[remote] ${msg}`);
        return { text: `OK: logged "${msg}"`, data: null };
    }, { description: 'Log a message to the browser console', usage: '<message>' });
}

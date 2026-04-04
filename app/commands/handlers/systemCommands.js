/**
 * System commands: help, status
 * Migrated from stale WebSocket branch to use context bag instead of raw viewer.
 */

import { box, kvLines } from '../formatResponse.js';

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

        const winCount = ctx._agentGrids ? ctx._agentGrids.size : 0;
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
        // In --local mode the server sets Cache-Control: no-store, so a plain
        // reload always fetches fresh files — no query-param hack needed.
        setTimeout(() => location.reload(), 200);
        return { text: 'OK: reloading page in 200ms', data: null };
    }, { description: 'Reload the browser page (picks up code changes in --local mode)' });

    router.register('screenshot', (args, ctx) => {
        const canvas = ctx.renderer?.domElement;
        if (!canvas) {
            return { text: 'ERR: no renderer available', data: null };
        }
        // Force a render to ensure the buffer has current content
        ctx.renderer.render(ctx.scene, ctx.camera);
        const dataUrl = canvas.toDataURL('image/png');
        // Strip the data:image/png;base64, prefix — caller gets raw base64
        const base64 = dataUrl.split(',')[1];
        return {
            text: `OK: screenshot ${canvas.width}x${canvas.height}`,
            data: { width: canvas.width, height: canvas.height, image: base64 },
        };
    }, { description: 'Capture the 3D canvas as a PNG screenshot' });

    router.register('console.log', (args, ctx) => {
        // Capture and return recent console output — useful for remote debugging.
        // For now, return a confirmation. Future: hook console and buffer recent entries.
        const msg = args.join(' ');
        console.log(`[remote] ${msg}`);
        return { text: `OK: logged "${msg}"`, data: null };
    }, { description: 'Log a message to the browser console', usage: '<message>' });
}

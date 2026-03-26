/**
 * System commands: help, status
 * Migrated from stale WebSocket branch to use context bag instead of raw viewer.
 */

import { box, kvLines } from '../TUIFormatter.js';

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
        const grids = ctx.getGrids();
        let totalGlyphs = 0;
        for (const g of grids) totalGlyphs += g.getGlyphCount();

        const winCount = ctx.windowManager ? ctx.windowManager.count : 0;
        const wsConnected = ctx.wsbridge ? ctx.wsbridge.connected : false;

        const data = {
            'grids': String(grids.length),
            'glyphs': totalGlyphs.toLocaleString(),
            'windows': String(winCount),
            'camera': `${cam.x.toFixed(0)}, ${cam.y.toFixed(0)}, ${cam.z.toFixed(0)}`,
            'websocket': wsConnected ? 'connected' : 'disconnected',
        };

        const lines = kvLines(data);
        return {
            text: box('STATUS', lines, 40) + '\nOK: status',
            data: {
                gridCount: grids.length,
                glyphCount: totalGlyphs,
                windowCount: winCount,
                camera: { x: cam.x, y: cam.y, z: cam.z },
                websocket: wsConnected,
            }
        };
    }, { description: 'Show scene status' });
}

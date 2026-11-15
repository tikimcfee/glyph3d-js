/**
 * System commands: status, batch, reload, screenshot, console.log (help and call are the router's own).
 */

import { box, kvLines } from '@glyph3d/core/utils/formatResponse.js';

/**
 * @param {import('../../client/CommandProvider.jsx').AppRouter} router
 */
export default function registerSystemCommands(router) {
    router.register('status', (args, ctx) => {
        const cam = ctx.camera.position;
        const gridEntries = ctx.registry.findByType('grid');
        const looseCount = ctx.registry.findLoose('grid').length;
        const carriedCount = gridEntries.length - looseCount;
        let totalGlyphs = 0;
        for (const e of gridEntries) totalGlyphs += e.grid.getGlyphCount();

        const wsConnected = ctx.wsbridge ? ctx.wsbridge.connected : false;

        // The path frame: where file.* verbs resolve. Every driver (human,
        // CLI script, model) gets its bearings from the standard first call.
        const fp = ctx.fileProvider;
        const repo = fp?._currentRepo;
        const filesLine = fp?.rootInfo?.root
            ? `relay · ${fp.rootInfo.root}`
            : repo
                ? `github · ${repo.owner}/${repo.repo}@${repo.branch || 'main'}`
                : 'no source loaded';

        const data = {
            'grids': carriedCount
                ? `${looseCount} loose + ${carriedCount} carried`
                : String(gridEntries.length),
            'glyphs': totalGlyphs.toLocaleString(),
            'registry': String(ctx.registry.size),
            'camera': `${cam.x.toFixed(0)}, ${cam.y.toFixed(0)}, ${cam.z.toFixed(0)}`,
            'websocket': wsConnected ? 'connected' : 'disconnected',
            'files': filesLine,
        };

        const lines = kvLines(data);
        return {
            text: box('STATUS', lines, 40) + '\nOK: status',
            data: {
                gridCount: gridEntries.length,
                looseGrids: looseCount,
                carriedGrids: carriedCount,
                glyphCount: totalGlyphs,
                registryTotal: ctx.registry.size,
                camera: { x: cam.x, y: cam.y, z: cam.z },
                websocket: wsConnected,
                files: filesLine,
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

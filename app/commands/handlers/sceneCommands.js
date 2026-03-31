/**
 * Scene commands: scene.info, scene.clear_windows
 * Uses registry as source of truth for scene object counts.
 */

import { box, kvLines } from '../formatResponse.js';

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerSceneCommands(router) {
    router.register('scene.info', (args, ctx) => {
        const gridEntries = ctx.registry.findByType('grid');
        let totalGlyphs = 0;
        for (const e of gridEntries) totalGlyphs += e.grid.getGlyphCount();

        const counts = ctx.registry.typeCounts();
        const winCount = ctx._agentGrids ? ctx._agentGrids.size : 0;

        const data = {
            'grids': String(gridEntries.length),
            'glyphs': totalGlyphs.toLocaleString(),
            'windows': String(winCount),
            'registry total': String(ctx.registry.size),
            'scene children': String(ctx.scene.children.length),
        };

        if (ctx.renderer.info) {
            const info = ctx.renderer.info;
            data['draw calls'] = String(info.render?.calls || 'N/A');
            data['triangles'] = String(info.render?.triangles || 'N/A');
            data['textures'] = String(info.memory?.textures || 'N/A');
        }

        return {
            text: box('SCENE', kvLines(data), 50) + '\nOK: scene info',
            data: {
                gridCount: gridEntries.length,
                glyphCount: totalGlyphs,
                windowCount: winCount,
                registryTotal: ctx.registry.size,
                sceneChildren: ctx.scene.children.length,
            }
        };
    }, { description: 'Show scene details' });

    router.register('scene.clear_windows', (args, ctx) => {
        const windows = ctx._agentGrids;
        if (!windows || windows.size === 0) return { text: 'OK: no windows to clear', data: { cleared: 0 } };
        const count = windows.size;
        for (const [id, ag] of windows) {
            ag.dispose();
            ctx.registry.unregister(id);
        }
        windows.clear();
        return {
            text: `OK: cleared ${count} windows`,
            data: { cleared: count }
        };
    }, { description: 'Remove all agent windows' });
}

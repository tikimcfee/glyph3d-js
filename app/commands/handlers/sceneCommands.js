/**
 * Scene commands: scene.info, scene.clear_windows, scene.clear_grids
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

    // Clear all CONTENT grids (the open code files). Leaves terminals and agent
    // windows alone — those are live/owned and torn down explicitly (terminal.kill,
    // scene.clear_windows). Reuses ctx.removeGrid (the canonical dispose path used
    // by grid.remove): geometry freed, removed from scene, unregistered.
    router.register('scene.clear_grids', (args, ctx) => {
        const grids = ctx.registry.findByType('grid');
        if (grids.length === 0) return { text: 'OK: no grids to clear', data: { cleared: 0 } };
        // Snapshot ids first — removeGrid mutates the registry as we iterate.
        const ids = grids.map(e => e.id);
        let cleared = 0;
        for (const id of ids) {
            if (ctx.removeGrid(id)) cleared++;
        }
        return {
            text: `OK: cleared ${cleared} grid(s)`,
            data: { cleared }
        };
    }, { description: 'Remove all code grids (open files); leaves terminals + windows' });
}

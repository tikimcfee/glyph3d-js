/**
 * Scene commands: scene.info, scene.clear_grids
 * Uses registry as source of truth for scene object counts.
 */

import { box, kvLines } from '../formatResponse.js';

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerSceneCommands(router) {
    router.register('scene.info', (args, ctx) => {
        const gridEntries = ctx.registry.findByType('grid');
        const loose = ctx.registry.findLoose('grid').length;
        let totalGlyphs = 0;
        for (const e of gridEntries) totalGlyphs += e.grid.getGlyphCount();

        const data = {
            'grids': gridEntries.length === loose
                ? String(loose)
                : `${loose} loose + ${gridEntries.length - loose} carried`,
            'glyphs': totalGlyphs.toLocaleString(),
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
                registryTotal: ctx.registry.size,
                sceneChildren: ctx.scene.children.length,
            }
        };
    }, { description: 'Show scene details' });

    // Clear all CONTENT grids (the open code files). Leaves terminals alone — those
    // are live/owned and torn down explicitly (terminal.kill). Reuses ctx.removeGrid
    // (the canonical dispose path used by grid.remove): geometry freed, removed from
    // scene, unregistered.
    router.register('scene.clear_grids', (args, ctx) => {
        // Loose grids only — a grid carried as a book's page is the book's,
        // and clearing the field must never reach inside a book.
        const grids = ctx.registry.findLoose('grid');
        if (grids.length === 0) return { text: 'OK: no grids to clear', data: { cleared: 0 } };
        // removeGrids: the canonical bulk-dispose path — zero intermediate re-packs,
        // one world settle at the end.
        const cleared = ctx.removeGrids(grids.map((e) => e.id));
        ctx.fieldSources = []; // no content grids left — the session has no field to restore
        return {
            text: `OK: cleared ${cleared} grid(s)`,
            data: { cleared }
        };
    }, { description: 'Remove all code grids (open files); leaves terminals' });
}

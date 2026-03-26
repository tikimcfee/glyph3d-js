/**
 * Scene commands: scene.info, scene.clear_windows
 * Migrated from stale WebSocket branch to use context bag.
 */

import { box, kvLines } from '../TUIFormatter.js';

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerSceneCommands(router) {
    router.register('scene.info', (args, ctx) => {
        const grids = ctx.getGrids();
        let totalGlyphs = 0;
        for (const g of grids) totalGlyphs += g.getGlyphCount();

        const winCount = ctx.windowManager ? ctx.windowManager.count : 0;

        const data = {
            'grids': String(grids.length),
            'glyphs': totalGlyphs.toLocaleString(),
            'windows': String(winCount),
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
                gridCount: grids.length,
                glyphCount: totalGlyphs,
                windowCount: winCount,
                sceneChildren: ctx.scene.children.length,
            }
        };
    }, { description: 'Show scene details' });

    router.register('scene.clear_windows', (args, ctx) => {
        if (!ctx.windowManager) return { text: 'ERR: no window manager', data: null };
        const count = ctx.windowManager.count;
        ctx.windowManager.clearAll();
        return {
            text: `OK: cleared ${count} windows`,
            data: { cleared: count }
        };
    }, { description: 'Remove all TUI windows' });
}

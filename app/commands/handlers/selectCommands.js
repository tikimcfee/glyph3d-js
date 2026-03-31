/**
 * Selection commands: select, select.add, select.clear, select.list, select.info
 * Uses registry entries for path matching.
 */

import { box, kvLines } from '../formatResponse.js';

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerSelectCommands(router) {
    router.register('select', (args, ctx) => {
        if (!ctx.selectionManager) return { text: 'ERR: no selection manager', data: null };
        if (args.length < 1) return { text: 'ERR: usage: select <path>', data: null };

        const path = args.join(' ');
        const entries = ctx.registry.findByType('grid');
        const entry = entries.find(e => {
            const sp = e.grid.getSourcePath() || '';
            return sp === path || sp.endsWith(path);
        });

        if (!entry) return { text: `ERR: file not found: ${path}`, data: null };

        const grids = ctx.getGrids();
        const sourcePath = entry.grid.getSourcePath();
        ctx.selectionManager.select(sourcePath, { grids });

        return {
            text: `OK: selected ${sourcePath}`,
            data: {
                primary: sourcePath,
                selected: [...ctx.selectionManager.getSelected()]
            }
        };
    }, { description: 'Select file by path', usage: '<path>' });

    router.register('select.add', (args, ctx) => {
        if (!ctx.selectionManager) return { text: 'ERR: no selection manager', data: null };
        if (args.length < 1) return { text: 'ERR: usage: select.add <path>', data: null };

        const path = args.join(' ');
        const entries = ctx.registry.findByType('grid');
        const entry = entries.find(e => {
            const sp = e.grid.getSourcePath() || '';
            return sp === path || sp.endsWith(path);
        });

        if (!entry) return { text: `ERR: file not found: ${path}`, data: null };

        const grids = ctx.getGrids();
        const sourcePath = entry.grid.getSourcePath();
        ctx.selectionManager.select(sourcePath, { additive: true, grids });

        return {
            text: `OK: added ${sourcePath} to selection`,
            data: {
                primary: ctx.selectionManager.primary,
                selected: [...ctx.selectionManager.getSelected()]
            }
        };
    }, { description: 'Add file to selection (multi-select)', usage: '<path>' });

    router.register('select.clear', (args, ctx) => {
        if (!ctx.selectionManager) return { text: 'ERR: no selection manager', data: null };

        const grids = ctx.getGrids();
        ctx.selectionManager.clear(grids);

        return {
            text: 'OK: selection cleared',
            data: { primary: null, selected: [] }
        };
    }, { description: 'Clear all selections' });

    router.register('select.list', (args, ctx) => {
        if (!ctx.selectionManager) return { text: 'ERR: no selection manager', data: null };

        const selected = [...ctx.selectionManager.getSelected()];
        const primary = ctx.selectionManager.primary;

        if (selected.length === 0) {
            return {
                text: 'No files selected',
                data: { primary: null, selected: [] }
            };
        }

        const lines = selected.map(p =>
            p === primary ? `> ${p} (primary)` : `  ${p}`
        );

        return {
            text: box('SELECTED', lines, 50),
            data: { primary, selected }
        };
    }, { description: 'List selected files' });

    router.register('select.info', (args, ctx) => {
        if (!ctx.selectionManager) return { text: 'ERR: no selection manager', data: null };

        const selected = [...ctx.selectionManager.getSelected()];
        const primary = ctx.selectionManager.primary;

        const data = {
            'primary': primary || '(none)',
            'count': String(selected.length),
            'files': selected.join(', ') || '(none)',
        };

        return {
            text: box('SELECTION', kvLines(data), 50),
            data: { primary, selected, count: selected.length }
        };
    }, { description: 'Show selection state details' });
}

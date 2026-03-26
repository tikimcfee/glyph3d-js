/**
 * Search commands: search, search.results
 * Basic text search across loaded grids.
 */

import { box, table } from '../TUIFormatter.js';

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerSearchCommands(router) {
    router.register('search', (args, ctx) => {
        if (args.length < 1) return { text: 'ERR: usage: search <query>', data: null };
        const query = args.join(' ').toLowerCase();
        const grids = ctx.getGrids();

        const results = [];
        for (const g of grids) {
            const path = g.getSourcePath() || g.getFilename() || '(unnamed)';

            // Search in filename
            if (path.toLowerCase().includes(query)) {
                results.push({ path, type: 'filename', line: null });
            }
        }

        if (results.length === 0) {
            return {
                text: `No results for '${args.join(' ')}'`,
                data: { query: args.join(' '), results: [], count: 0 }
            };
        }

        const headers = ['#', 'path', 'type'];
        const rows = results.slice(0, 50).map((r, i) => [
            String(i),
            r.path.length > 50 ? '\u2026' + r.path.slice(-49) : r.path,
            r.type,
        ]);

        const moreText = results.length > 50 ? `\n(showing 50 of ${results.length})` : '';

        return {
            text: table(headers, rows) + `\nOK: ${results.length} matches` + moreText,
            data: { query: args.join(' '), results, count: results.length }
        };
    }, { description: 'Search files by name', usage: '<query>' });

    router.register('search.clear', (args, ctx) => {
        return {
            text: 'OK: search cleared',
            data: null
        };
    }, { description: 'Clear search state' });
}

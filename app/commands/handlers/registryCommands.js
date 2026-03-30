/**
 * Registry query commands: registry.list, registry.get, registry.types
 *
 * Discovery commands for the scene registry. Let CLI users and future
 * tab UI know what objects are in the scene without scanning by name.
 */

import { box, table, kvLines } from '../../../src/tui/TUIFormatter.js';

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerRegistryCommands(router) {

    // ================================================================
    //  registry.list [type]
    // ================================================================

    router.register('registry.list', (args, ctx) => {
        const typeFilter = args[0] || null;
        const entries = typeFilter
            ? ctx.registry.findByType(typeFilter)
            : ctx.registry.list();

        if (entries.length === 0) {
            const msg = typeFilter
                ? `(no entries of type '${typeFilter}')`
                : '(registry empty)';
            return {
                text: box('REGISTRY', [msg], 60) + `\nOK: 0 entries`,
                data: { entries: [], count: 0, filter: typeFilter },
            };
        }

        const grids = ctx.getGrids();
        const headers = ['id', 'type', 'index', 'meta'];
        const rows = entries.map(e => {
            const idx = grids.indexOf(e.grid);
            const metaPreview = Object.entries(e.meta)
                .filter(([, v]) => v != null)
                .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
                .join(', ')
                .slice(0, 40);
            return [
                e.id.length > 30 ? e.id.slice(0, 29) + '\u2026' : e.id,
                e.type,
                idx >= 0 ? String(idx) : '-',
                metaPreview || '-',
            ];
        });

        const data = entries.map(e => ({
            id: e.id,
            type: e.type,
            gridIndex: grids.indexOf(e.grid),
            meta: e.meta,
        }));

        return {
            text: table(headers, rows) + `\nOK: ${entries.length} entries${typeFilter ? ` (type=${typeFilter})` : ''}`,
            data: { entries: data, count: entries.length, filter: typeFilter },
        };
    }, {
        description: 'List all registered scene objects, optionally filtered by type',
        usage: '[type]',
    });

    // ================================================================
    //  registry.get <id>
    // ================================================================

    router.register('registry.get', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: registry.get <id>', data: null };
        }

        const id = args[0];
        const entry = ctx.registry.get(id);

        if (!entry) {
            return { text: `ERR: no registry entry for "${id}"`, data: null };
        }

        const grids = ctx.getGrids();
        const idx = grids.indexOf(entry.grid);
        const pos = entry.grid.position
            ? { x: entry.grid.position.x, y: entry.grid.position.y, z: entry.grid.position.z }
            : null;

        const info = {
            'id': entry.id,
            'type': entry.type,
            'gridIndex': idx >= 0 ? String(idx) : '(not in grids array)',
            'position': pos ? `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}` : '(n/a)',
            'visible': entry.grid.visible != null ? String(entry.grid.visible) : '(n/a)',
        };

        // Add meta fields
        for (const [k, v] of Object.entries(entry.meta)) {
            if (v != null) {
                info[`meta.${k}`] = typeof v === 'object' ? JSON.stringify(v) : String(v);
            }
        }

        return {
            text: box(`REGISTRY: ${id}`, kvLines(info), 60) + '\nOK: entry found',
            data: {
                id: entry.id,
                type: entry.type,
                gridIndex: idx,
                position: pos,
                visible: entry.grid.visible,
                meta: entry.meta,
            },
        };
    }, {
        description: 'Get details of a registered scene object',
        usage: '<id>',
    });

    // ================================================================
    //  registry.types
    // ================================================================

    router.register('registry.types', (args, ctx) => {
        const counts = ctx.registry.typeCounts();
        const types = Object.entries(counts);

        if (types.length === 0) {
            return {
                text: 'OK: registry empty (0 types)',
                data: { types: {}, total: 0 },
            };
        }

        const lines = types.map(([type, count]) => `  ${type}: ${count}`);
        const total = ctx.registry.size;

        return {
            text: lines.join('\n') + `\nOK: ${types.length} type(s), ${total} total entries`,
            data: { types: counts, total },
        };
    }, {
        description: 'List all registry types with counts',
    });
}

/**
 * Layout commands: layout.info, layout.list
 * New command module for layout introspection.
 */

import { box, kvLines } from '../formatResponse.js';

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerLayoutCommands(router) {
    router.register('layout.info', (args, ctx) => {
        const active = ctx.getActiveLayout ? ctx.getActiveLayout() : 'unknown';

        const data = {
            'active': active,
            'available': Object.keys(ctx.layoutManagers || {}).join(', ') || 'none',
        };

        return {
            text: box('LAYOUT', kvLines(data), 40),
            data: { active, available: Object.keys(ctx.layoutManagers || {}) }
        };
    }, { description: 'Show current layout details' });

    router.register('layout.list', (args, ctx) => {
        const managers = ctx.layoutManagers || {};
        const active = ctx.getActiveLayout ? ctx.getActiveLayout() : null;
        const names = Object.keys(managers);

        if (names.length === 0) {
            return { text: 'No layout managers available', data: { layouts: [] } };
        }

        const lines = names.map(n =>
            n === active ? `> ${n} (active)` : `  ${n}`
        );

        return {
            text: box('LAYOUTS', lines, 30),
            data: { layouts: names, active }
        };
    }, { description: 'List available layout modes' });
}

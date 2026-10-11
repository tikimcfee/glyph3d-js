/**
 * context.* — the interaction-context read surface.
 *
 * The InteractionContext projects attention + edit state into composable nodes
 * (focus/edit/key, innermost-last). context.info exposes them on the bus, so
 * the CLI sees exactly the state the breadcrumb HUD renders.
 */

/**
 * @param {import('../../client/CommandProvider.jsx').AppRouter} router
 */
export default function registerContextCommands(router) {
    router.register('context.info', (_args, ctx) => {
        const nodes = ctx.interactionContext?.nodes() ?? [];
        const chip = (n) =>
            n.kind === 'edit' ? `<EDIT ${n.cursor.line}:${n.cursor.col}>`
                : n.kind === 'ast' ? `<AST ${n.label}>`
                : `<${n.kind.toUpperCase()} ${n.id}${n.entityType ? ` (${n.entityType})` : ''}>`;
        return {
            text: nodes.length ? `OK: ${nodes.map(chip).join('-')}` : 'OK: (no locked context)',
            data: { nodes },
        };
    }, {
        description: 'Show the interaction-context nodes (focus/edit/key)',
        returns: '{ nodes: [{ kind, id, ... }] }',
    });
}

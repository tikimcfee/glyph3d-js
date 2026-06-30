/**
 * edit.* commands — toggle in-grid editing for a CodeGrid.
 *
 * Editable-3d-ide L2 M2/M3. The companion to the keystroke router in
 * app/commands/index.js (_installEntityKeystrokeDelivery): these verbs
 * set/clear attention.key on a grid, and the router delivers keypresses
 * to the grid's edit ops while key is held.
 *
 *   edit.start [grid-id|index]
 *     Sets attention.key to the grid (so keystrokes route to its edit
 *     ops) and calls grid.enterEdit() to initialize the cursor and show
 *     the caret. With no arg, falls through to the current
 *     attention.primary — matches file.save / mode.* ergonomics.
 *
 *   edit.goto [grid-id|index] <line> <col>
 *     Places the caret at a position, entering edit mode first if needed
 *     (sets attention.key like edit.start). Click-to-caret resolves a glyph
 *     pick to line/col and lands here; the CLI and agents drive the cursor
 *     through the same verb.
 *
 *   edit.stop
 *     Clears attention.key. A change:key listener in initCommandCenter
 *     fires grid.exitEdit() on the prior target to hide the caret and
 *     forget the cursor — same path Esc-LIFO uses, so behavior is
 *     identical whether you exit via this verb or the Esc key.
 *
 *   edit.info
 *     Returns the current edit-mode state (registry id + cursor) or
 *     null if not editing.
 */

import { resolveGridByIdOrIndex } from './spatialHelpers.js';

/**
 * @param {import('../../../packages/glyph3d-core/src/services/orchestration/CommandRouter.js').default} router
 */
export default function registerEditCommands(router) {

    router.register('edit.start', (args, ctx) => {
        const target = args[0] ?? ctx.attention?.primary?.id ?? null;
        if (!target) {
            return {
                text: 'ERR: no grid specified and no current primary attention target',
                data: null,
            };
        }
        const resolved = resolveGridByIdOrIndex(ctx, String(target));
        if (resolved.error) return { text: resolved.error, data: null };

        const grid = resolved.grid;
        if (typeof grid.enterEdit !== 'function') {
            return {
                text: `ERR: grid "${resolved.registryId}" is not editable (no enterEdit method)`,
                data: null,
            };
        }
        if (!ctx.attentionManager) {
            return { text: 'ERR: AttentionManager not wired into ctx', data: null };
        }

        // Set attention.key first. If the slot already points at this grid,
        // the change:key listener no-ops (same-grid guard in the keyboard
        // router), so it won't fire an unwanted exitEdit on the grid we're
        // about to enterEdit.
        ctx.attentionManager.set('key', resolved.registryId, { registry: ctx.registry });
        grid.enterEdit();

        const c = grid.getCursor();
        return {
            text: `OK: editing "${resolved.registryId}" at ${c?.line ?? '?'}:${c?.col ?? '?'}`,
            data: {
                registryId: resolved.registryId,
                index: resolved.idx,
                cursor: c,
            },
        };
    }, {
        description: 'Enter in-grid edit mode (sets attention.key, shows caret)',
        usage: '[grid-id|index]',
        returns: '{ registryId, index, cursor }',
    });

    router.register('edit.goto', (args, ctx) => {
        // edit.goto [grid-id|index] <line> <col> — place the caret at a position,
        // entering edit mode first if needed. The verb behind click-to-caret (a
        // glyph pick resolves to line/col and lands here), and the bus-native way
        // for the CLI / agents / a future vim layer to drive the cursor.
        let target, line, col;
        if (args.length >= 3) {
            [target, line, col] = args;
        } else if (args.length === 2) {
            target = ctx.attention?.key?.id ?? ctx.attention?.primary?.id ?? null;
            [line, col] = args;
        } else {
            return { text: 'ERR: usage: edit.goto [grid-id|index] <line> <col>', data: null };
        }
        if (!target) {
            return { text: 'ERR: no grid specified and no current key/primary attention target', data: null };
        }
        const resolved = resolveGridByIdOrIndex(ctx, String(target));
        if (resolved.error) return { text: resolved.error, data: null };

        const grid = resolved.grid;
        if (typeof grid.enterEdit !== 'function') {
            return { text: `ERR: grid "${resolved.registryId}" is not editable (no enterEdit method)`, data: null };
        }
        if (!ctx.attentionManager) {
            return { text: 'ERR: AttentionManager not wired into ctx', data: null };
        }

        // Same order as edit.start: key slot first (same-grid guard prevents a
        // spurious exitEdit), then ensure the cursor exists, then place it.
        // setCursor clamps to valid bounds, so an over-shoot lands at EOL/EOF.
        ctx.attentionManager.set('key', resolved.registryId, { registry: ctx.registry });
        if (!grid.getCursor()) grid.enterEdit();
        grid.setCursor(Math.trunc(Number(line)) || 0, Math.trunc(Number(col)) || 0);

        const c = grid.getCursor();
        return {
            text: `OK: caret in "${resolved.registryId}" at ${c?.line ?? '?'}:${c?.col ?? '?'}`,
            data: { registryId: resolved.registryId, index: resolved.idx, cursor: c },
        };
    }, {
        description: 'Place the caret at line:col (enters edit mode if needed)',
        usage: '[grid-id|index] <line> <col>',
        returns: '{ registryId, index, cursor }',
    });

    router.register('edit.stop', (_args, ctx) => {
        const slot = ctx.attentionManager?.get('key');
        ctx.attentionManager?.clear('key');
        return {
            text: slot ? `OK: stopped editing "${slot.id}"` : 'OK: not editing',
            data: { previousId: slot?.id ?? null },
        };
    }, {
        description: 'Exit in-grid edit mode (clears attention.key, hides caret)',
        returns: '{ previousId }',
    });

    router.register('edit.info', (_args, ctx) => {
        const slot = ctx.attentionManager?.get('key');
        if (!slot || slot.entity?.type !== 'grid') {
            return { text: 'OK: not editing', data: null };
        }
        const grid = slot.entity.grid;
        const c = grid?.getCursor?.();
        return {
            text: c
                ? `OK: editing "${slot.id}" at ${c.line}:${c.col}`
                : `OK: editing "${slot.id}" (no cursor yet)`,
            data: {
                registryId: slot.id,
                cursor: c,
                lineCount: grid?.getLineCount?.() ?? null,
            },
        };
    }, {
        description: 'Report current edit-mode state',
        returns: '{ registryId, cursor, lineCount } | null',
    });
}

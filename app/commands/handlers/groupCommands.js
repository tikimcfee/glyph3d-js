/**
 * Group commands -- spatial window group management.
 *
 * Provides group.* commands for creating, managing, and laying out
 * groups of grids in 3D space.
 */

import { resolveGridByIdOrIndex, fmtVec } from './spatialHelpers.js';

/**
 * Resolve a grid identifier to a registry ID.
 * Accepts registry ID, numeric index, or sourcePath.
 * @param {Object} ctx
 * @param {string} arg
 * @returns {{ registryId: string }|{ error: string }}
 */
function resolveToRegistryId(ctx, arg) {
    // Try direct registry ID first
    if (ctx.registry.has(arg)) {
        return { registryId: arg };
    }

    // Try by ID or index
    const result = resolveGridByIdOrIndex(ctx, arg, 'grid');
    if (result.error) return result;
    if (result.registryId) return { registryId: result.registryId };

    // Fallback: find by grid object
    const id = ctx.registry.getIdByGrid(result.grid);
    if (id) return { registryId: id };

    return { error: `ERR: cannot resolve "${arg}" to a registry ID` };
}

/**
 * Register all group.* commands.
 * @param {import('../../../src/services/orchestration/CommandRouter.js').default} router
 */
export default function registerGroupCommands(router) {

    // ── group.create <name> [id1 id2 ...] ────────────────────
    router.register('group.create', (args, ctx) => {
        const sm = ctx.spatialManager;
        if (!sm) return { text: 'ERR: spatial manager not available' };

        const name = args[0];
        if (!name) return { text: 'Usage: group.create <name> [gridId ...]' };

        const group = sm.createGroup(name);
        const added = [];

        // Optionally add members inline
        for (let i = 1; i < args.length; i++) {
            const resolved = resolveToRegistryId(ctx, args[i]);
            if (resolved.error) continue;
            sm.addToGroup(name, resolved.registryId);
            added.push(resolved.registryId);
        }

        const msg = added.length > 0
            ? `Group "${name}" created with ${added.length} member(s)`
            : `Group "${name}" created (empty)`;

        return { text: msg, data: { name, members: group.memberIds.length } };
    });

    // ── group.add <group> <gridId|path> ──────────────────────
    router.register('group.add', (args, ctx) => {
        const sm = ctx.spatialManager;
        if (!sm) return { text: 'ERR: spatial manager not available' };

        const [groupName, gridArg] = args;
        if (!groupName || !gridArg) return { text: 'Usage: group.add <group> <gridId|index>' };

        if (!sm.getGroup(groupName)) {
            return { text: `ERR: group "${groupName}" not found` };
        }

        const resolved = resolveToRegistryId(ctx, gridArg);
        if (resolved.error) return { text: resolved.error };

        sm.addToGroup(groupName, resolved.registryId);
        const group = sm.getGroup(groupName);
        return {
            text: `Added ${resolved.registryId} to "${groupName}" (${group.size} members)`,
            data: { group: groupName, added: resolved.registryId },
        };
    });

    // ── group.remove <group> <gridId|path> ───────────────────
    router.register('group.remove', (args, ctx) => {
        const sm = ctx.spatialManager;
        if (!sm) return { text: 'ERR: spatial manager not available' };

        const [groupName, gridArg] = args;
        if (!groupName || !gridArg) return { text: 'Usage: group.remove <group> <gridId|index>' };

        const resolved = resolveToRegistryId(ctx, gridArg);
        if (resolved.error) return { text: resolved.error };

        sm.removeFromGroup(groupName, resolved.registryId);
        const group = sm.getGroup(groupName);
        const msg = group
            ? `Removed ${resolved.registryId} from "${groupName}" (${group.size} remaining)`
            : `Removed ${resolved.registryId} from "${groupName}" (group dissolved)`;
        return { text: msg };
    });

    // ── group.dissolve <group> ───────────────────────────────
    router.register('group.dissolve', (args, ctx) => {
        const sm = ctx.spatialManager;
        if (!sm) return { text: 'ERR: spatial manager not available' };

        const name = args[0];
        if (!name) return { text: 'Usage: group.dissolve <group>' };

        if (!sm.getGroup(name)) {
            return { text: `ERR: group "${name}" not found` };
        }

        sm.dissolveGroup(name);
        return { text: `Group "${name}" dissolved` };
    });

    // ── group.stack <group> ──────────────────────────────────
    router.register('group.stack', (args, ctx) => {
        const sm = ctx.spatialManager;
        if (!sm) return { text: 'ERR: spatial manager not available' };

        const name = args[0];
        if (!name) return { text: 'Usage: group.stack <group>' };
        if (!sm.getGroup(name)) return { text: `ERR: group "${name}" not found` };

        sm.setLayout(name, 'stack');
        return { text: `Group "${name}" layout: stack` };
    });

    // ── group.splay <group> [spacing] ────────────────────────
    router.register('group.splay', (args, ctx) => {
        const sm = ctx.spatialManager;
        if (!sm) return { text: 'ERR: spatial manager not available' };

        const name = args[0];
        if (!name) return { text: 'Usage: group.splay <group> [spacing]' };
        if (!sm.getGroup(name)) return { text: `ERR: group "${name}" not found` };

        const spacing = args[1] ? parseFloat(args[1]) : undefined;
        const config = spacing ? { spacing } : {};
        sm.setLayout(name, 'splay', config);
        return { text: `Group "${name}" layout: splay${spacing ? ` (spacing: ${spacing})` : ''}` };
    });

    // ── group.horizontal <group> [gap] ────────────────────────
    router.register('group.horizontal', (args, ctx) => {
        const sm = ctx.spatialManager;
        if (!sm) return { text: 'ERR: spatial manager not available' };

        const name = args[0];
        if (!name) return { text: 'Usage: group.horizontal <group> [gap]' };
        if (!sm.getGroup(name)) return { text: `ERR: group "${name}" not found` };

        const gap = args[1] ? parseFloat(args[1]) : undefined;
        const config = gap ? { gap } : {};
        sm.setLayout(name, 'horizontal', config);
        return { text: `Group "${name}" layout: horizontal${gap ? ` (gap: ${gap})` : ''}` };
    }, { description: 'Arrange group members side-by-side', usage: '<group> [gap]' });

    // ── group.vertical <group> [gap] ────────────────────────
    router.register('group.vertical', (args, ctx) => {
        const sm = ctx.spatialManager;
        if (!sm) return { text: 'ERR: spatial manager not available' };

        const name = args[0];
        if (!name) return { text: 'Usage: group.vertical <group> [gap]' };
        if (!sm.getGroup(name)) return { text: `ERR: group "${name}" not found` };

        const gap = args[1] ? parseFloat(args[1]) : undefined;
        const config = gap ? { gap } : {};
        sm.setLayout(name, 'vertical', config);
        return { text: `Group "${name}" layout: vertical${gap ? ` (gap: ${gap})` : ''}` };
    }, { description: 'Arrange group members top-to-bottom', usage: '<group> [gap]' });

    // ── group.free <group> ───────────────────────────────────
    router.register('group.free', (args, ctx) => {
        const sm = ctx.spatialManager;
        if (!sm) return { text: 'ERR: spatial manager not available' };

        const name = args[0];
        if (!name) return { text: 'Usage: group.free <group>' };
        if (!sm.getGroup(name)) return { text: `ERR: group "${name}" not found` };

        sm.setLayout(name, 'free');
        return { text: `Group "${name}" layout: free` };
    });

    // ── group.hide <group> ───────────────────────────────────
    router.register('group.hide', (args, ctx) => {
        const sm = ctx.spatialManager;
        if (!sm) return { text: 'ERR: spatial manager not available' };

        const name = args[0];
        if (!name) return { text: 'Usage: group.hide <group>' };
        if (!sm.getGroup(name)) return { text: `ERR: group "${name}" not found` };

        sm.hideGroup(name);
        return { text: `Group "${name}" hidden` };
    });

    // ── group.show <group> ───────────────────────────────────
    router.register('group.show', (args, ctx) => {
        const sm = ctx.spatialManager;
        if (!sm) return { text: 'ERR: spatial manager not available' };

        const name = args[0];
        if (!name) return { text: 'Usage: group.show <group>' };
        if (!sm.getGroup(name)) return { text: `ERR: group "${name}" not found` };

        sm.showGroup(name);
        return { text: `Group "${name}" shown` };
    });

    // ── group.list ───────────────────────────────────────────
    router.register('group.list', (args, ctx) => {
        const sm = ctx.spatialManager;
        if (!sm) return { text: 'ERR: spatial manager not available' };

        const names = sm.getGroupNames();
        if (names.length === 0) {
            return { text: 'No groups defined', data: { groups: [] } };
        }

        const lines = names.map(name => {
            const group = sm.getGroup(name);
            const color = sm.getGroupColor(name);
            const colorStr = color ? `rgb(${(color.r * 255)|0},${(color.g * 255)|0},${(color.b * 255)|0})` : 'none';
            return `  ${name} (${group.size} members, layout: ${group.mode}, color: ${colorStr})`;
        });

        return {
            text: `Groups (${names.length}):\n${lines.join('\n')}`,
            data: { groups: names.map(n => ({ name: n, size: sm.getGroup(n).size })) },
        };
    });

    // ── group.info <group> ───────────────────────────────────
    router.register('group.info', (args, ctx) => {
        const sm = ctx.spatialManager;
        if (!sm) return { text: 'ERR: spatial manager not available' };

        const name = args[0];
        if (!name) return { text: 'Usage: group.info <group>' };

        const group = sm.getGroup(name);
        if (!group) return { text: `ERR: group "${name}" not found` };

        const color = sm.getGroupColor(name);
        const members = group.memberIds.map(id => {
            const entry = ctx.registry.get(id);
            const path = entry?.meta?.sourcePath || entry?.grid?.userData?.sourcePath || id;
            return `  ${id} → ${path}`;
        });

        const lines = [
            `Group: ${name}`,
            `Layout: ${group.mode}`,
            `Members (${group.size}):`,
            ...members,
            `Anchor: ${fmtVec(group.anchor)}`,
            `Color: ${color ? `(${color.r.toFixed(2)}, ${color.g.toFixed(2)}, ${color.b.toFixed(2)})` : 'none'}`,
        ];

        return { text: lines.join('\n'), data: { name, mode: group.mode, memberIds: [...group.memberIds] } };
    });

    // ── group.move <group> <x> <y> [z] ──────────────────────
    router.register('group.move', (args, ctx) => {
        const sm = ctx.spatialManager;
        if (!sm) return { text: 'ERR: spatial manager not available' };

        const [name, xStr, yStr, zStr] = args;
        if (!name || !xStr || !yStr) return { text: 'Usage: group.move <group> <x> <y> [z]' };
        if (!sm.getGroup(name)) return { text: `ERR: group "${name}" not found` };

        const dx = parseFloat(xStr);
        const dy = parseFloat(yStr);
        const dz = zStr ? parseFloat(zStr) : 0;

        if (isNaN(dx) || isNaN(dy) || isNaN(dz)) {
            return { text: 'ERR: invalid numeric arguments' };
        }

        sm.moveGroupByDelta(name, dx, dy, dz);
        return { text: `Moved group "${name}" by (${dx}, ${dy}, ${dz})` };
    });
}

/**
 * Annotation commands: label.create, label.remove, label.list,
 * highlight.grid, highlight.clear,
 * camera.animate, camera.lookat.grid,
 * scene.annotate, scene.clear_annotations, scene.reset
 *
 * Labels and annotations are lightweight CodeGrids tracked in ctx.annotations.
 * Highlights use shared gridVisualState for save/restore.
 */

import { box, table } from '../TUIFormatter.js';
import CodeGrid from '../../../../src/collections/CodeGrid.js';
import { COLORS } from './colorConstants.js';
import { saveGridState, restoreGridState, restoreAllGridStates } from './gridVisualState.js';
import { animateCamera, getWorldBounds } from './spatialHelpers.js';

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerAnnotationCommands(router) {

    // ================================================================
    //  label.create <base64-text> <x> <y> <z> [r g b]
    // ================================================================

    router.register('label.create', (args, ctx) => {
        if (args.length < 4) {
            return { text: 'ERR: usage: label.create <base64-text> <x> <y> <z> [r g b]', data: null };
        }

        let text;
        try { text = atob(args[0]); } catch {
            return { text: 'ERR: invalid base64 content', data: null };
        }

        const [x, y, z] = args.slice(1, 4).map(Number);
        if ([x, y, z].some(isNaN)) {
            return { text: 'ERR: x, y, z must be numbers', data: null };
        }

        // Optional color (defaults to bright white)
        let color = { ...COLORS.IDENTITY };
        if (args.length >= 7) {
            const [r, g, b] = args.slice(4, 7).map(Number);
            if (![r, g, b].some(isNaN)) {
                color = { r, g, b };
            }
        }

        const id = `label-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        const grid = new CodeGrid(ctx.scene, ctx.atlas, {
            name: id,
            showBackground: false,
            showFilename: false,
            textColor: color,
            gridScale: 1.0,
        });

        grid.loadText(text);
        grid.position.set(x, y, z);

        // Add to scene directly (not to ctx grids -- these are annotations, not content)
        ctx.scene.add(grid);

        // Track in annotations map (detail store)
        ctx.annotations.set(id, { type: 'label', grid, text, position: { x, y, z }, color });

        // Register in scene registry (discovery layer)
        ctx.registry.register(id, grid, {
            type: 'label',
            text,
            position: { x, y, z },
            color,
        });

        return {
            text: `OK: label "${id}" created at (${x}, ${y}, ${z})`,
            data: { id, position: { x, y, z }, color, text }
        };
    }, {
        description: 'Create a floating text label at a position',
        usage: '<base64-text> <x> <y> <z> [r g b]'
    });

    // ================================================================
    //  label.remove <id>
    // ================================================================

    router.register('label.remove', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: label.remove <id>', data: null };
        }

        const id = args[0];
        const entry = ctx.annotations.get(id);

        if (!entry) {
            return { text: `ERR: no annotation with id "${id}"`, data: null };
        }

        entry.grid.dispose();
        ctx.scene.remove(entry.grid);
        ctx.annotations.delete(id);

        // Unregister from scene registry
        ctx.registry.unregister(id);

        return {
            text: `OK: removed label "${id}"`,
            data: { id }
        };
    }, { description: 'Remove a label by id', usage: '<id>' });

    // ================================================================
    //  label.list
    // ================================================================

    router.register('label.list', (args, ctx) => {
        const entries = [...ctx.annotations.entries()];

        if (entries.length === 0) {
            return {
                text: box('ANNOTATIONS', ['(none)'], 50) + '\nOK: 0 annotations',
                data: { annotations: [], count: 0 }
            };
        }

        const headers = ['id', 'type', 'position', 'text'];
        const rows = entries.map(([id, e]) => {
            const pos = e.position || { x: 0, y: 0, z: 0 };
            const preview = (e.text || '').slice(0, 25);
            return [
                id.length > 20 ? id.slice(0, 19) + '\u2026' : id,
                e.type,
                `${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)}`,
                preview.length < (e.text || '').length ? preview + '\u2026' : preview
            ];
        });

        const data = entries.map(([id, e]) => ({
            id,
            type: e.type,
            position: e.position,
            text: e.text,
        }));

        return {
            text: table(headers, rows) + `\nOK: ${entries.length} annotations`,
            data: { annotations: data, count: entries.length }
        };
    }, { description: 'List all labels and annotations' });

    // ================================================================
    //  highlight.grid <index> [r g b]
    // ================================================================

    router.register('highlight.grid', (args, ctx) => {
        const grids = ctx.getGrids();
        if (args.length < 1) {
            return { text: 'ERR: usage: highlight.grid <index> [r g b]', data: null };
        }

        const idx = parseInt(args[0]);
        if (isNaN(idx) || idx < 0 || idx >= grids.length) {
            return { text: `ERR: invalid grid index ${args[0]} (0-${grids.length - 1})`, data: null };
        }

        // Default highlight color: bright cyan
        let color = { ...COLORS.HIGHLIGHT };
        if (args.length >= 4) {
            const [r, g, b] = args.slice(1, 4).map(Number);
            if (![r, g, b].some(isNaN)) {
                color = { r, g, b };
            }
        }

        const grid = grids[idx];

        // Save original state (first-writer-wins via gridVisualState)
        saveGridState(ctx, idx);

        // Apply highlight: color tint via group color
        const collection = grid.getCollection?.() || grid.collection || grid.glyphCollection;
        if (collection?.setGroupColor) {
            collection.setGroupColor(0, color);
        }

        // Z-pop: bring grid forward
        const saved = ctx.gridVisualState.get(idx);
        if (saved) {
            grid.position.z = saved.originalZ + 3;
            // 5% scale bump
            grid.scale.setScalar(saved.originalScale * 1.05);
        }

        return {
            text: `OK: grid #${idx} highlighted with color (${color.r}, ${color.g}, ${color.b})`,
            data: { index: idx, color }
        };
    }, {
        description: 'Visually emphasize a grid with color + Z-pop',
        usage: '<index> [r g b]'
    });

    // ================================================================
    //  highlight.clear [index]
    // ================================================================

    router.register('highlight.clear', (args, ctx) => {
        // If an index is given, clear only that one
        if (args.length >= 1) {
            const idx = parseInt(args[0]);
            if (isNaN(idx)) {
                return { text: 'ERR: index must be a number', data: null };
            }
            const removed = restoreGridState(ctx, idx);
            if (!removed) {
                return { text: `ERR: grid #${idx} is not highlighted`, data: null };
            }
            return {
                text: `OK: highlight cleared for grid #${idx}`,
                data: { cleared: [idx] }
            };
        }

        // Clear all highlights
        const keys = [...ctx.gridVisualState.keys()];
        restoreAllGridStates(ctx);

        return {
            text: `OK: cleared ${keys.length} highlight(s)`,
            data: { cleared: keys }
        };
    }, {
        description: 'Remove highlight from grids (all or by index)',
        usage: '[index]'
    });

    // ================================================================
    //  camera.animate <x> <y> <z> <duration-ms>
    // ================================================================

    router.register('camera.animate', (args, ctx) => {
        if (args.length < 4) {
            return { text: 'ERR: usage: camera.animate <x> <y> <z> <duration-ms>', data: null };
        }

        const [x, y, z] = args.slice(0, 3).map(Number);
        const duration = parseInt(args[3]);
        if ([x, y, z, duration].some(isNaN)) {
            return { text: 'ERR: x, y, z must be numbers and duration must be integer ms', data: null };
        }
        if (duration < 1 || duration > 30000) {
            return { text: 'ERR: duration must be between 1 and 30000 ms', data: null };
        }

        // Fire-and-forget: start animation, return immediately
        animateCamera(ctx, x, y, z, duration);

        return {
            text: `OK: animating camera to (${x}, ${y}, ${z}) over ${duration}ms`,
            data: { target: { x, y, z }, duration }
        };
    }, {
        description: 'Smoothly animate camera to position (ease-in-out)',
        usage: '<x> <y> <z> <duration-ms>'
    });

    // ================================================================
    //  camera.lookat.grid <index>
    // ================================================================

    router.register('camera.lookat.grid', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: camera.lookat.grid <index>', data: null };
        }

        // Cancel any in-flight animation
        ctx._cancelCameraAnimation?.();

        const grids = ctx.getGrids();
        const idx = parseInt(args[0]);
        if (isNaN(idx) || idx < 0 || idx >= grids.length) {
            return { text: `ERR: invalid grid index ${args[0]} (0-${grids.length - 1})`, data: null };
        }

        const grid = grids[idx];
        const bounds = grid.getBounds();

        // Compute center of the grid's bounding box
        const cx = (bounds.min.x + bounds.max.x) / 2;
        const cy = (bounds.min.y + bounds.max.y) / 2;
        const cz = (bounds.min.z + bounds.max.z) / 2;

        ctx.camera.lookAt(cx, cy, cz);

        // Sync CameraController pitch/yaw to match the new orientation
        if (ctx.cameraController) {
            const euler = ctx.camera.rotation.clone();
            euler.order = 'YXZ';
            ctx.cameraController.pitch = euler.x;
            ctx.cameraController.yaw = euler.y;
        }

        const name = grid.getFilename?.() || `#${idx}`;
        return {
            text: `OK: camera looking at grid ${name} center (${cx.toFixed(1)}, ${cy.toFixed(1)}, ${cz.toFixed(1)})`,
            data: { index: idx, center: { x: cx, y: cy, z: cz } }
        };
    }, {
        description: 'Point camera at a grid\'s center without moving',
        usage: '<index>'
    });

    // ================================================================
    //  scene.annotate <base64-text> <x> <y> <z> [r g b]
    // ================================================================

    router.register('scene.annotate', (args, ctx) => {
        if (args.length < 4) {
            return { text: 'ERR: usage: scene.annotate <base64-text> <x> <y> <z> [r g b]', data: null };
        }

        let text;
        try { text = atob(args[0]); } catch {
            return { text: 'ERR: invalid base64 content', data: null };
        }

        const [x, y, z] = args.slice(1, 4).map(Number);
        if ([x, y, z].some(isNaN)) {
            return { text: 'ERR: x, y, z must be numbers', data: null };
        }

        // Optional color (defaults to amber for annotation text)
        let color = { ...COLORS.ANNOTATION };
        if (args.length >= 7) {
            const [r, g, b] = args.slice(4, 7).map(Number);
            if (![r, g, b].some(isNaN)) {
                color = { r, g, b };
            }
        }

        const id = `annot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        const grid = new CodeGrid(ctx.scene, ctx.atlas, {
            name: id,
            showBackground: true,
            showFilename: false,
            textColor: color,
            backgroundColor: 0x1a1a2e,
            backgroundOpacity: 0.9,
            backgroundPadding: 1.2,
            gridScale: 1.0,
        });

        grid.loadText(text);
        grid.position.set(x, y, z);

        ctx.scene.add(grid);
        ctx.annotations.set(id, { type: 'annotation', grid, text, position: { x, y, z }, color });

        // Register in scene registry
        ctx.registry.register(id, grid, {
            type: 'annotation',
            text,
            position: { x, y, z },
            color,
        });

        return {
            text: `OK: annotation "${id}" created at (${x}, ${y}, ${z})`,
            data: { id, position: { x, y, z }, color, text }
        };
    }, {
        description: 'Create a text annotation with background box',
        usage: '<base64-text> <x> <y> <z> [r g b]'
    });

    // ================================================================
    //  scene.clear_annotations
    // ================================================================

    router.register('scene.clear_annotations', (args, ctx) => {
        let count = 0;
        for (const [id, entry] of ctx.annotations) {
            entry.grid.dispose();
            ctx.scene.remove(entry.grid);
            ctx.registry.unregister(id);
            count++;
        }
        ctx.annotations.clear();

        // Also clear all highlights
        const highlightCount = ctx.gridVisualState.size;
        restoreAllGridStates(ctx);

        return {
            text: `OK: cleared ${count} annotation(s) and ${highlightCount} highlight(s)`,
            data: { annotations: count, highlights: highlightCount }
        };
    }, { description: 'Remove all CLI-created labels, annotations, and highlights' });

    // ================================================================
    //  scene.reset
    // ================================================================

    router.register('scene.reset', (args, ctx) => {
        // 1. Clear all annotations
        let annotCount = 0;
        for (const [id, entry] of ctx.annotations) {
            entry.grid.dispose();
            ctx.scene.remove(entry.grid);
            ctx.registry.unregister(id);
            annotCount++;
        }
        ctx.annotations.clear();

        // 2. Restore all highlights/dim states
        const highlightCount = ctx.gridVisualState.size;
        restoreAllGridStates(ctx);

        // 3. Cancel camera animation
        ctx._cancelCameraAnimation?.();

        // 4. Optionally remove agent/window grids (emergency only)
        let agentCount = 0;
        if (args.includes('--windows')) {
            const grids = ctx.getGrids();
            // Use registry to find windows and agents, fall back to name scan
            const windowEntries = [
                ...ctx.registry.findByType('agent'),
                ...ctx.registry.findByType('window'),
            ];

            if (windowEntries.length > 0) {
                // Registry-based removal: collect indices, remove in reverse order
                const indices = windowEntries
                    .map(e => grids.indexOf(e.grid))
                    .filter(i => i >= 0)
                    .sort((a, b) => b - a);
                for (const i of indices) {
                    ctx.removeGrid(i);
                    agentCount++;
                }
            } else {
                // Fallback: name-based scan for unregistered grids
                for (let i = grids.length - 1; i >= 0; i--) {
                    const name = grids[i].getFilename?.() || grids[i].name || '';
                    if (name.startsWith('agent:')) {
                        ctx.removeGrid(i);
                        agentCount++;
                    }
                }
            }
        }

        return {
            text: `OK: scene reset (${annotCount} annotations, ${highlightCount} highlights${agentCount ? `, ${agentCount} agent windows` : ''})`,
            data: { annotations: annotCount, highlights: highlightCount, agentWindows: agentCount }
        };
    }, {
        description: 'Clear annotations + highlights + cancel animation (--windows to also remove agent grids)',
        usage: '[--windows]'
    });
}

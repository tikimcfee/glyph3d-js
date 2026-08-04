/**
 * Annotation commands: label.create, label.set, label.append, label.remove, label.list,
 * highlight.grid, highlight.clear,
 * camera.animate, camera.lookat.grid,
 * scene.annotate, scene.clear_annotations, scene.reset
 *
 * Labels are FieldLabels — editable glyph-field text entities tracked in ctx.annotations
 * (setText is live: label.set / label.append rewrite them in place, no rebake). Annotations
 * (scene.annotate) are lightweight CodeGrids. Highlights use shared gridVisualState.
 */

import { box, table } from '../formatResponse.js';
import CodeGrid from '@glyph3d/core/collections/CodeGrid.js';
import FieldLabel from '@glyph3d/core/collections/FieldLabel.js';
import { COLORS } from './colorConstants.js';
import { saveGridState, restoreGridState, restoreAllGridStates } from './gridVisualState.js';
import { animateCamera, getWorldBounds, resolveGridByIdOrIndex } from './spatialHelpers.js';
import { decodeBase64 } from '@glyph3d/core/utils/encoding.js';

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
        try { text = decodeBase64(args[0]); } catch {
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

        const grid = new FieldLabel({
            atlas: ctx.atlas,
            text,
            lineHeight: 1.0,
            textColor: color,
        });
        grid.name = id;
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
    //  label.set <id> <base64-text> — rewrite a label's text live
    // ================================================================

    router.register('label.set', (args, ctx) => {
        if (args.length < 2) {
            return { text: 'ERR: usage: label.set <id> <base64-text>', data: null };
        }

        const id = args[0];
        const entry = ctx.annotations.get(id);
        if (!entry || entry.type !== 'label') {
            return { text: `ERR: no label with id "${id}"`, data: null };
        }

        let text;
        try { text = decodeBase64(args[1]); } catch {
            return { text: 'ERR: invalid base64 content', data: null };
        }

        entry.grid.setText(text); // the field rebuilds synchronously — the edit is live NOW
        entry.text = text;
        // Re-register: same id/grid/type overwrites the metadata (text) without a warn.
        ctx.registry.register(id, entry.grid, { type: 'label', text, position: entry.position, color: entry.color });

        return {
            text: `OK: label "${id}" set (${text.length} chars)`,
            data: { id, text }
        };
    }, {
        description: 'Rewrite a label\'s text live — the agent/dev scratchpad write path',
        usage: '<id> <base64-text>'
    });

    // ================================================================
    //  label.append <id> <base64-text> — add line(s) to a label
    // ================================================================

    router.register('label.append', (args, ctx) => {
        if (args.length < 2) {
            return { text: 'ERR: usage: label.append <id> <base64-text>', data: null };
        }

        const id = args[0];
        const entry = ctx.annotations.get(id);
        if (!entry || entry.type !== 'label') {
            return { text: `ERR: no label with id "${id}"`, data: null };
        }

        let text;
        try { text = decodeBase64(args[1]); } catch {
            return { text: 'ERR: invalid base64 content', data: null };
        }

        const next = entry.text ? `${entry.text}\n${text}` : text;
        entry.grid.setText(next);
        entry.text = next;
        ctx.registry.register(id, entry.grid, { type: 'label', text: next, position: entry.position, color: entry.color });

        return {
            text: `OK: label "${id}" appended (${next.split('\n').length} lines)`,
            data: { id, text: next }
        };
    }, {
        description: 'Append line(s) to a label — notes accumulate in place',
        usage: '<id> <base64-text>'
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
        if (args.length < 1) {
            return { text: 'ERR: usage: highlight.grid <id|index> [r g b]', data: null };
        }

        const resolved = resolveGridByIdOrIndex(ctx, args[0]);
        if (resolved.error) return { text: resolved.error, data: null };
        const idx = resolved.idx;

        // Default highlight color: bright cyan
        let color = { ...COLORS.HIGHLIGHT };
        if (args.length >= 4) {
            const [r, g, b] = args.slice(1, 4).map(Number);
            if (![r, g, b].some(isNaN)) {
                color = { r, g, b };
            }
        }

        const grid = resolved.grid;

        // Save original state (first-writer-wins via gridVisualState)
        saveGridState(ctx, idx);

        // Apply highlight: color tint via group color
        const renderer = grid.getRenderer?.();
        if (renderer?.setGroupColor) {
            renderer.setGroupColor(0, color);
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
            return { text: 'ERR: usage: camera.lookat.grid <id|index>', data: null };
        }

        // Cancel any in-flight animation
        ctx._cancelCameraAnimation?.();

        const resolved = resolveGridByIdOrIndex(ctx, args[0]);
        if (resolved.error) return { text: resolved.error, data: null };
        const idx = resolved.idx;
        const grid = resolved.grid;
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
        try { text = decodeBase64(args[0]); } catch {
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

        void grid.loadText(text);
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
            for (const type of ['agent', 'window']) {
                for (const entry of ctx.registry.findByType(type)) {
                    entry.grid.dispose();
                    ctx.scene.remove(entry.grid);
                    ctx.registry.unregister(entry.id);
                    agentCount++;
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

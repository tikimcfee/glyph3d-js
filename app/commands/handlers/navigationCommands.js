/**
 * Navigation commands: camera.frame, camera.frame.bounds, tour.*
 *
 * camera.frame computes the union AABB of listed grids and positions the camera
 * at the Z distance needed to fit it in the viewport. tour.* provides an ordered
 * sequence of camera-frame stops with optional annotations and timed playback.
 *
 * Depends on: ctx.camera, ctx.cameraController, ctx.getGrids(), ctx.annotations,
 *             ctx.scene, ctx.atlas, ctx._cancelCameraAnimation
 */

import { box, table } from '../formatResponse.js';
import CodeGrid from '../../../src/collections/CodeGrid.js';
import { COLORS } from './colorConstants.js';
import {
    resolveGridByIdOrIndex, getWorldBounds, unionBounds,
    resolveAnchor, zDistanceForFit, fmtVec,
    frameBounds, animateCamera,
} from './spatialHelpers.js';
import { decodeBase64 } from '../../../src/utils/encoding.js';

/** @type {Map<string, TourDefinition>} */
const tours = new Map();

/**
 * @typedef {Object} TourStop
 * @property {number} gridIndex
 * @property {string|null} annotation - text to show (decoded)
 * @property {number} duration - ms to hold this stop before advancing
 * @property {string|null} annotationId - runtime: id of created annotation grid
 */

/**
 * @typedef {Object} TourDefinition
 * @property {string} name
 * @property {TourStop[]} stops
 */

/**
 * Create an annotation grid positioned above a target grid.
 * Uses anchor-based placement: resolveAnchor(bounds, 'top') + gap offset.
 * @param {Object} ctx
 * @param {number} gridIndex
 * @param {string} text
 * @returns {string|null} annotation id, or null if grid has no bounds
 */
function createTourAnnotation(ctx, gridIndex, text) {
    const grids = ctx.getGrids();
    const grid = grids[gridIndex];

    // Use shared helper -- handles updateWorldMatrix + isEmpty check
    const bounds = getWorldBounds(grid);
    if (!bounds) return null;

    // Place annotation above the grid using anchor-based positioning
    const anchor = resolveAnchor(bounds, 'top');
    const gap = 2;
    const x = anchor.x;
    const y = anchor.y + gap;
    const z = anchor.z;

    const id = `tour-annot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const annotGrid = new CodeGrid(ctx.scene, ctx.atlas, {
        name: id,
        showBackground: true,
        showFilename: false,
        textColor: { ...COLORS.ANNOTATION },
        backgroundColor: 0x1a1a2e,
        backgroundOpacity: 0.92,
        backgroundPadding: 1.2,
        gridScale: 1.0,
    });

    annotGrid.loadText(text);
    annotGrid.position.set(x, y, z);

    ctx.scene.add(annotGrid);
    ctx.annotations.set(id, {
        type: 'tour-annotation',
        grid: annotGrid,
        text,
        position: { x, y, z },
        color: { ...COLORS.ANNOTATION },
    });

    // Register in scene registry
    ctx.registry.register(id, annotGrid, {
        type: 'tour-annotation',
        text,
        position: { x, y, z },
        gridIndex,
    });

    return id;
}

/**
 * Remove a tour annotation by id.
 * @param {Object} ctx
 * @param {string} id
 */
function removeTourAnnotation(ctx, id) {
    const entry = ctx.annotations.get(id);
    if (!entry) return;
    entry.grid.dispose();
    ctx.scene.remove(entry.grid);
    ctx.annotations.delete(id);
    ctx.registry.unregister(id);
}


// ────────────────────────────────────────────────────────────────
//  Command registration
// ────────────────────────────────────────────────────────────────

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerNavigationCommands(router) {

    // ================================================================
    //  camera.frame <index1> [index2...] [--padding <n>]
    //
    //  All numeric args before --padding are grid indices.
    //  Fails on invalid indices (does not silently skip).
    // ================================================================

    router.register('camera.frame', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: camera.frame <index1> [index2...] [--padding <n>]', data: null };
        }

        const grids = ctx.getGrids();
        let padding = 2;
        const indices = [];

        // Parse args: collect indices, extract --padding
        for (let i = 0; i < args.length; i++) {
            if (args[i] === '--padding' && i + 1 < args.length) {
                padding = parseFloat(args[i + 1]);
                if (isNaN(padding)) {
                    return { text: 'ERR: --padding value must be a number', data: null };
                }
                i++;
                continue;
            }
            // Validate each index through resolveGridByIdOrIndex
            const resolved = resolveGridByIdOrIndex(ctx, args[i]);
            if (resolved.error) return { text: resolved.error, data: null };
            indices.push(resolved.idx);
        }

        if (indices.length === 0) {
            return { text: 'ERR: at least one grid index required', data: null };
        }

        // Use shared unionBounds -- handles matrix update and isEmpty checks
        const result = unionBounds(grids, indices);
        if (result.error) return { text: result.error, data: null };

        frameBounds(ctx, result.bounds, padding);

        const names = indices.map(i => {
            const name = grids[i].getFilename?.() || `#${i}`;
            return `${i}:${name}`;
        });

        return {
            text: `OK: framing ${indices.length} grid(s): ${names.join(', ')}`,
            data: {
                indices,
                bounds: result.bounds,
                padding,
                cameraPosition: {
                    x: ctx.camera.position.x,
                    y: ctx.camera.position.y,
                    z: ctx.camera.position.z,
                },
            },
        };
    }, {
        description: 'Position camera to see all listed grids',
        usage: '<index1> [index2...] [--padding <n>]',
    });

    // ================================================================
    //  camera.frame.bounds <minX> <minY> <maxX> <maxY> [minZ maxZ] [--padding <n>]
    //
    //  Frame an arbitrary AABB. Z defaults to 0 if not provided.
    // ================================================================

    router.register('camera.frame.bounds', (args, ctx) => {
        if (args.length < 4) {
            return {
                text: 'ERR: usage: camera.frame.bounds <minX> <minY> <maxX> <maxY> [minZ maxZ] [--padding <n>]',
                data: null,
            };
        }

        const [minX, minY, maxX, maxY] = args.slice(0, 4).map(Number);
        if ([minX, minY, maxX, maxY].some(isNaN)) {
            return { text: 'ERR: all coordinates must be numbers', data: null };
        }

        let minZ = 0, maxZ = 0;
        let padding = 2;
        let i = 4;

        // Check for optional Z coordinates (two numbers before any --flag)
        if (i + 1 < args.length && args[i] !== '--padding') {
            const z1 = parseFloat(args[i]);
            const z2 = parseFloat(args[i + 1]);
            if (!isNaN(z1) && !isNaN(z2) && args[i + 1] !== '--padding') {
                minZ = z1;
                maxZ = z2;
                i += 2;
            }
        }

        // Parse --padding
        for (; i < args.length; i++) {
            if (args[i] === '--padding' && i + 1 < args.length) {
                padding = parseFloat(args[i + 1]);
                if (isNaN(padding)) {
                    return { text: 'ERR: --padding value must be a number', data: null };
                }
                break;
            }
        }

        const bounds = {
            min: { x: minX, y: minY, z: minZ },
            max: { x: maxX, y: maxY, z: maxZ },
            center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 },
            size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
        };

        frameBounds(ctx, bounds, padding);

        return {
            text: `OK: framing bounds (${minX}, ${minY}) to (${maxX}, ${maxY}) padding=${padding}`,
            data: {
                bounds,
                padding,
                cameraPosition: {
                    x: ctx.camera.position.x,
                    y: ctx.camera.position.y,
                    z: ctx.camera.position.z,
                },
            },
        };
    }, {
        description: 'Position camera to see an arbitrary AABB',
        usage: '<minX> <minY> <maxX> <maxY> [minZ maxZ] [--padding <n>]',
    });

    // ================================================================
    //  tour.create <base64-name>
    // ================================================================

    router.register('tour.create', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: tour.create <base64-name>', data: null };
        }

        let name;
        try { name = decodeBase64(args[0]); } catch {
            return { text: 'ERR: invalid base64 name', data: null };
        }

        if (tours.has(name)) {
            return { text: `ERR: tour "${name}" already exists. Use tour.clear first.`, data: null };
        }

        tours.set(name, { name, stops: [] });

        return {
            text: `OK: tour "${name}" created (0 stops)`,
            data: { name, stops: 0 },
        };
    }, {
        description: 'Create a named tour (ordered list of camera stops)',
        usage: '<base64-name>',
    });

    // ================================================================
    //  tour.stop <base64-tour-name> <grid-index> [base64-annotation] [duration-ms]
    // ================================================================

    router.register('tour.stop', (args, ctx) => {
        if (args.length < 2) {
            return {
                text: 'ERR: usage: tour.stop <base64-tour-name> <grid-index> [base64-annotation] [duration-ms]',
                data: null,
            };
        }

        let tourName;
        try { tourName = decodeBase64(args[0]); } catch {
            return { text: 'ERR: invalid base64 tour name', data: null };
        }

        const tour = tours.get(tourName);
        if (!tour) {
            return { text: `ERR: tour "${tourName}" not found. Create it first with tour.create.`, data: null };
        }

        const resolved = resolveGridByIdOrIndex(ctx, args[1], 'grid');
        if (resolved.error) return { text: resolved.error, data: null };

        let annotation = null;
        if (args.length >= 3 && args[2] !== '-') {
            try { annotation = decodeBase64(args[2]); } catch {
                return { text: 'ERR: invalid base64 annotation', data: null };
            }
        }

        let duration = 3000;
        if (args.length >= 4) {
            duration = parseInt(args[3]);
            if (isNaN(duration) || duration < 100) {
                return { text: 'ERR: duration must be >= 100 ms', data: null };
            }
        }

        const stopIndex = tour.stops.length;
        tour.stops.push({
            gridIndex: resolved.idx,
            registryId: resolved.registryId,
            annotation,
            duration,
            annotationId: null,
        });

        const gridName = resolved.grid.getFilename?.() || `#${resolved.idx}`;

        return {
            text: `OK: stop #${stopIndex} added to "${tourName}": grid ${resolved.idx} (${gridName}), ${duration}ms${annotation ? ', annotated' : ''}`,
            data: {
                tour: tourName,
                stopIndex,
                gridIndex: resolved.idx,
                gridName,
                annotation,
                duration,
            },
        };
    }, {
        description: 'Add a stop to a tour',
        usage: '<base64-tour-name> <grid-index> [base64-annotation] [duration-ms]',
    });

    // ================================================================
    //  tour.play <base64-tour-name>
    //
    //  Async: animates camera through each stop sequentially.
    //  The CommandRouter supports async handlers, so this blocks the
    //  response until the full tour completes.
    // ================================================================

    router.register('tour.play', async (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: tour.play <base64-tour-name>', data: null };
        }

        let tourName;
        try { tourName = decodeBase64(args[0]); } catch {
            return { text: 'ERR: invalid base64 tour name', data: null };
        }

        const tour = tours.get(tourName);
        if (!tour) {
            return { text: `ERR: tour "${tourName}" not found`, data: null };
        }

        if (tour.stops.length === 0) {
            return { text: `ERR: tour "${tourName}" has no stops`, data: null };
        }

        const totalStops = tour.stops.length;

        // Reset pitch/yaw once at the start
        if (ctx.cameraController) {
            ctx.cameraController.pitch = 0;
            ctx.cameraController.yaw = 0;
        }

        let previousAnnotationId = null;

        for (let i = 0; i < tour.stops.length; i++) {
            const stop = tour.stops[i];

            // Resolve via registryId first, fall back to gridIndex
            const stopRef = stop.registryId || String(stop.gridIndex);
            const resolved = resolveGridByIdOrIndex(ctx, stopRef);
            if (resolved.error) continue;

            // Remove previous stop's annotation
            if (previousAnnotationId) {
                removeTourAnnotation(ctx, previousAnnotationId);
                previousAnnotationId = null;
            }

            // Compute frame target using shared unionBounds (handles matrix update + isEmpty)
            const grids = ctx.getGrids();
            const stopIdx = resolved.idx >= 0 ? resolved.idx : grids.indexOf(resolved.grid);
            const result = unionBounds(grids, [stopIdx]);
            if (result.error) continue;

            const { bounds } = result;
            const padding = 2;
            const w = bounds.size.x + padding * 2;
            const h = bounds.size.y + padding * 2;

            // Use shared zDistanceForFit instead of inlining FOV math
            const dist = zDistanceForFit(ctx.camera, w, h, 0.85);

            const targetX = bounds.center.x;
            const targetY = bounds.center.y;
            const targetZ = bounds.max.z + dist;

            // Animate camera (transition time scales with distance)
            const dx = ctx.camera.position.x - targetX;
            const dy = ctx.camera.position.y - targetY;
            const dz = ctx.camera.position.z - targetZ;
            const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const transitionMs = Math.max(400, Math.min(2000, distance * 3));

            await animateCamera(ctx, targetX, targetY, targetZ, transitionMs);

            // Show annotation after camera arrives
            if (stop.annotation) {
                const annotId = createTourAnnotation(ctx, stopIdx, stop.annotation);
                if (annotId) {
                    stop.annotationId = annotId;
                    previousAnnotationId = annotId;
                }
            }

            // Hold at this stop for the specified duration
            await new Promise(resolve => setTimeout(resolve, stop.duration));
        }

        // Clean up final annotation
        if (previousAnnotationId) {
            removeTourAnnotation(ctx, previousAnnotationId);
        }

        return {
            text: `OK: tour "${tourName}" complete (${totalStops} stops)`,
            data: { tour: tourName, stops: totalStops },
        };
    }, {
        description: 'Play a tour: animate camera through stops with annotations',
        usage: '<base64-tour-name>',
    });

    // ================================================================
    //  tour.list
    // ================================================================

    router.register('tour.list', (args, ctx) => {
        if (tours.size === 0) {
            return {
                text: box('TOURS', ['(none)'], 40) + '\nOK: 0 tours',
                data: { tours: [], count: 0 },
            };
        }

        const headers = ['name', 'stops', 'grids'];
        const rows = [];
        const data = [];

        for (const [name, tour] of tours) {
            const gridIndices = tour.stops.map(s => s.gridIndex);
            rows.push([
                name.length > 25 ? name.slice(0, 24) + '\u2026' : name,
                String(tour.stops.length),
                gridIndices.join(','),
            ]);
            data.push({
                name,
                stops: tour.stops.map((s, i) => ({
                    index: i,
                    gridIndex: s.gridIndex,
                    hasAnnotation: !!s.annotation,
                    duration: s.duration,
                })),
            });
        }

        return {
            text: table(headers, rows) + `\nOK: ${tours.size} tour(s)`,
            data: { tours: data, count: tours.size },
        };
    }, { description: 'List all tours' });

    // ================================================================
    //  tour.clear
    // ================================================================

    router.register('tour.clear', (args, ctx) => {
        // Clean up any live tour annotations
        for (const [name, tour] of tours) {
            for (const stop of tour.stops) {
                if (stop.annotationId) {
                    removeTourAnnotation(ctx, stop.annotationId);
                }
            }
        }

        const count = tours.size;
        tours.clear();

        return {
            text: `OK: cleared ${count} tour(s)`,
            data: { cleared: count },
        };
    }, { description: 'Remove all tours and their annotations' });
}

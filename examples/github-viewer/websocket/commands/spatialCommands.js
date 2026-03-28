/**
 * Spatial geometry commands: grid.bounds, grid.bounds.union, grid.anchor,
 * grid.distance, grid.overlap
 *
 * Read-only geometry primitives for querying spatial relationships between grids.
 * All coordinates are in world space. All helpers imported from spatialHelpers.js.
 */

import { box as tuiBox, kvLines } from '../TUIFormatter.js';
import {
    resolveGridByIdOrIndex, getWorldBounds, getWorldBox3, unionBounds,
    resolveAnchor, ANCHOR_NAMES, fmtVec,
} from './spatialHelpers.js';

// ============ Command Registration ============

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerSpatialCommands(router) {

    // ---- grid.bounds <index> ----
    // Merged version: includes size, center, AND all 9 anchor points in TUI output.
    router.register('grid.bounds', (args, ctx) => {
        if (args.length < 1) return { text: 'ERR: usage: grid.bounds <id|index>', data: null };

        const resolved = resolveGridByIdOrIndex(ctx, args[0]);
        if (resolved.error) return { text: resolved.error, data: null };

        const aabb = getWorldBounds(resolved.grid);
        if (!aabb) {
            return { text: `ERR: grid ${resolved.idx} has no content bounds`, data: null };
        }

        const kv = {
            'min':    fmtVec(aabb.min),
            'max':    fmtVec(aabb.max),
            'width':  aabb.size.x.toFixed(2),
            'height': aabb.size.y.toFixed(2),
            'depth':  aabb.size.z.toFixed(2),
            'center': fmtVec(aabb.center),
        };

        // Add all 9 anchor points for inspection
        for (const name of ANCHOR_NAMES) {
            const pt = resolveAnchor(aabb, name);
            kv[name] = fmtVec(pt);
        }

        return {
            text: tuiBox(`BOUNDS #${resolved.idx}`, kvLines(kv, 14), 55) + '\nOK: grid bounds',
            data: { index: resolved.idx, bounds: aabb }
        };
    }, {
        description: 'Get world-space AABB and anchor points of a grid',
        usage: '<index>',
        returns: '{ index, bounds: { min, max, size, center } }'
    });

    // ---- grid.bounds.union <index1> <index2> [index3...] ----
    router.register('grid.bounds.union', (args, ctx) => {
        if (args.length < 2) {
            return { text: 'ERR: usage: grid.bounds.union <id|index1> <id|index2> [...]', data: null };
        }

        // Parse all indices first
        const grids = ctx.getGrids();
        const indices = [];
        for (const arg of args) {
            const resolved = resolveGridByIdOrIndex(ctx, arg);
            if (resolved.error) return { text: resolved.error, data: null };
            indices.push(resolved.idx);
        }

        const result = unionBounds(grids, indices);
        if (result.error) return { text: result.error, data: null };

        const { bounds } = result;

        const kv = {
            'grids':  result.indices.join(', '),
            'min':    fmtVec(bounds.min),
            'max':    fmtVec(bounds.max),
            'width':  bounds.size.x.toFixed(2),
            'height': bounds.size.y.toFixed(2),
            'depth':  bounds.size.z.toFixed(2),
            'center': fmtVec(bounds.center),
        };

        return {
            text: tuiBox(`UNION BOUNDS`, kvLines(kv), 50) + `\nOK: union of ${result.indices.length} grids`,
            data: { indices: result.indices, bounds }
        };
    }, {
        description: 'Compute AABB enclosing multiple grids',
        usage: '<index1> <index2> [index3...]',
        returns: '{ indices, bounds: { min, max, size, center } }'
    });

    // ---- grid.anchor <index> <anchor-name> ----
    router.register('grid.anchor', (args, ctx) => {
        if (args.length < 2) {
            return { text: `ERR: usage: grid.anchor <id|index> <name>\n  anchors: ${ANCHOR_NAMES.join(', ')}`, data: null };
        }

        const resolved = resolveGridByIdOrIndex(ctx, args[0]);
        if (resolved.error) return { text: resolved.error, data: null };

        const anchorName = args[1].toLowerCase();
        const aabb = getWorldBounds(resolved.grid);
        if (!aabb) {
            return { text: `ERR: grid ${resolved.idx} has no content bounds`, data: null };
        }

        const point = resolveAnchor(aabb, anchorName);
        if (!point) {
            return { text: `ERR: unknown anchor '${anchorName}'. Valid: ${ANCHOR_NAMES.join(', ')}`, data: null };
        }

        return {
            text: `OK: grid #${resolved.idx} ${anchorName} = (${fmtVec(point)})`,
            data: { index: resolved.idx, anchor: anchorName, position: point }
        };
    }, {
        description: 'Get named anchor point on grid bounding box',
        usage: '<index> <anchor-name>',
        returns: '{ index, anchor, position: {x,y,z} }'
    });

    // ---- grid.distance <index1> <index2> ----
    router.register('grid.distance', (args, ctx) => {
        if (args.length < 2) return { text: 'ERR: usage: grid.distance <id|index1> <id|index2>', data: null };

        const r1 = resolveGridByIdOrIndex(ctx, args[0]);
        if (r1.error) return { text: r1.error, data: null };
        const r2 = resolveGridByIdOrIndex(ctx, args[1]);
        if (r2.error) return { text: r2.error, data: null };

        const aabb1 = getWorldBounds(r1.grid);
        const aabb2 = getWorldBounds(r2.grid);
        if (!aabb1) return { text: `ERR: grid ${r1.idx} has no content bounds`, data: null };
        if (!aabb2) return { text: `ERR: grid ${r2.idx} has no content bounds`, data: null };

        const dx = aabb2.center.x - aabb1.center.x;
        const dy = aabb2.center.y - aabb1.center.y;
        const dz = aabb2.center.z - aabb1.center.z;
        const euclidean = Math.sqrt(dx * dx + dy * dy + dz * dz);

        return {
            text: `OK: distance(#${r1.idx}, #${r2.idx}) = ${euclidean.toFixed(2)}  delta=(${dx.toFixed(2)}, ${dy.toFixed(2)}, ${dz.toFixed(2)})`,
            data: {
                from: r1.idx,
                to: r2.idx,
                distance: euclidean,
                delta: { x: dx, y: dy, z: dz },
                fromCenter: aabb1.center,
                toCenter: aabb2.center
            }
        };
    }, {
        description: 'Euclidean distance between two grid centers',
        usage: '<index1> <index2>',
        returns: '{ from, to, distance, delta: {x,y,z}, fromCenter, toCenter }'
    });

    // ---- grid.overlap <index1> <index2> ----
    router.register('grid.overlap', (args, ctx) => {
        if (args.length < 2) return { text: 'ERR: usage: grid.overlap <id|index1> <id|index2>', data: null };

        const r1 = resolveGridByIdOrIndex(ctx, args[0]);
        if (r1.error) return { text: r1.error, data: null };
        const r2 = resolveGridByIdOrIndex(ctx, args[1]);
        if (r2.error) return { text: r2.error, data: null };

        const box1 = getWorldBox3(r1.grid);
        const box2 = getWorldBox3(r2.grid);
        if (!box1) return { text: `ERR: grid ${r1.idx} has no content bounds`, data: null };
        if (!box2) return { text: `ERR: grid ${r2.idx} has no content bounds`, data: null };

        const overlaps = box1.intersectsBox(box2);

        if (!overlaps) {
            // Compute per-axis gap between the two boxes
            const gapX = Math.max(0, box2.min.x - box1.max.x, box1.min.x - box2.max.x);
            const gapY = Math.max(0, box2.min.y - box1.max.y, box1.min.y - box2.max.y);
            const gapZ = Math.max(0, box2.min.z - box1.max.z, box1.min.z - box2.max.z);
            const gap = Math.sqrt(gapX * gapX + gapY * gapY + gapZ * gapZ);

            return {
                text: `OK: grids #${r1.idx} and #${r2.idx} do NOT overlap (gap=${gap.toFixed(2)})`,
                data: {
                    a: r1.idx,
                    b: r2.idx,
                    overlaps: false,
                    gap,
                    gapAxis: { x: gapX, y: gapY, z: gapZ },
                    region: null
                }
            };
        }

        // Compute intersection region
        const iMin = {
            x: Math.max(box1.min.x, box2.min.x),
            y: Math.max(box1.min.y, box2.min.y),
            z: Math.max(box1.min.z, box2.min.z)
        };
        const iMax = {
            x: Math.min(box1.max.x, box2.max.x),
            y: Math.min(box1.max.y, box2.max.y),
            z: Math.min(box1.max.z, box2.max.z)
        };
        const region = {
            min: iMin,
            max: iMax,
            width: iMax.x - iMin.x,
            height: iMax.y - iMin.y,
            depth: iMax.z - iMin.z,
        };

        const kv = {
            'overlaps':    'true',
            'region min':  fmtVec(region.min),
            'region max':  fmtVec(region.max),
            'region size': `${region.width.toFixed(2)} x ${region.height.toFixed(2)} x ${region.depth.toFixed(2)}`,
        };

        return {
            text: tuiBox(`OVERLAP #${r1.idx}/#${r2.idx}`, kvLines(kv), 50) + '\nOK: grids overlap',
            data: {
                a: r1.idx,
                b: r2.idx,
                overlaps: true,
                gap: 0,
                gapAxis: { x: 0, y: 0, z: 0 },
                region
            }
        };
    }, {
        description: 'Check if two grids overlap and return intersection',
        usage: '<index1> <index2>',
        returns: '{ a, b, overlaps, gap, region: { min, max, width, height, depth } | null }'
    });
}

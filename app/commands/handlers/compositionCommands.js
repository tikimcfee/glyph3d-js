/**
 * Composition commands: grid.align, grid.attach, grid.stack
 *
 * Position mutation commands -- move grids relative to each other
 * using semantic anchors. All helpers imported from spatialHelpers.js.
 *
 * These are one-shot positioning operations. They do not create
 * live constraints. If you move the target grid later, the source
 * does not follow.
 */

import {
    resolveGridByIdOrIndex, getWorldBounds, resolveAnchor, ANCHOR_NAMES, fmtVec,
} from './spatialHelpers.js';

// ──────────────────────────────────────────────────────────────
//  Gap direction (composition-specific, not shared)
// ──────────────────────────────────────────────────────────────

/**
 * Compute the gap direction vector for an anchor pair.
 * Gap pushes the source AWAY from the target along the axis
 * implied by the anchor names.
 *
 * @param {string} sourceAnchor - anchor on the source grid
 * @param {string} targetAnchor - anchor on the target grid
 * @returns {{ x: number, y: number, z: number }}
 */
function getGapDirection(sourceAnchor, targetAnchor) {
    const sx = anchorXCategory(sourceAnchor);
    const tx = anchorXCategory(targetAnchor);
    const sy = anchorYCategory(sourceAnchor);
    const ty = anchorYCategory(targetAnchor);

    let dx = 0, dy = 0;

    if (sx !== tx) {
        dx = sx < tx ? -1 : 1;
    }
    if (sy !== ty) {
        dy = sy < ty ? -1 : 1;
    }

    // If no axis differs, default based on source anchor edge
    if (dx === 0 && dy === 0) {
        if (sx === 0) dx = -1;
        else if (sx === 2) dx = 1;
        else dy = 1;
    }

    return { x: dx, y: dy, z: 0 };
}

/** @returns {number} 0=left, 1=center, 2=right */
function anchorXCategory(anchor) {
    if (anchor.includes('left') || anchor === 'leading') return 0;
    if (anchor.includes('right') || anchor === 'trailing') return 2;
    return 1;
}

/** @returns {number} 0=bottom, 1=center, 2=top */
function anchorYCategory(anchor) {
    if (anchor.includes('bottom')) return 0;
    if (anchor.includes('top')) return 2;
    return 1;
}

/**
 * Format a position for concise TUI display.
 * @param {{ x: number, y: number, z: number }} pos
 * @returns {string}
 */
function fmtPos(pos) {
    return `(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`;
}

// ──────────────────────────────────────────────────────────────
//  Attach position mapping
// ──────────────────────────────────────────────────────────────

/**
 * Mapping from attach position name to { sourceAnchor, targetAnchor }.
 * The source anchor is the edge of the source that touches the target,
 * and the target anchor is the corresponding edge of the target.
 */
const ATTACH_MAP = {
    'left':         { sourceAnchor: 'trailing',     targetAnchor: 'leading' },
    'right':        { sourceAnchor: 'leading',      targetAnchor: 'trailing' },
    'above':        { sourceAnchor: 'bottom',       targetAnchor: 'top' },
    'below':        { sourceAnchor: 'top',          targetAnchor: 'bottom' },
    'top-left':     { sourceAnchor: 'bottom-right', targetAnchor: 'top-left' },
    'top-right':    { sourceAnchor: 'bottom-left',  targetAnchor: 'top-right' },
    'bottom-left':  { sourceAnchor: 'top-right',    targetAnchor: 'bottom-left' },
    'bottom-right': { sourceAnchor: 'top-left',     targetAnchor: 'bottom-right' },
};

const ATTACH_POSITIONS = new Set(Object.keys(ATTACH_MAP));
const STACK_DIRECTIONS = new Set(['horizontal', 'vertical', 'depth']);

// ──────────────────────────────────────────────────────────────
//  Command registration
// ──────────────────────────────────────────────────────────────

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerCompositionCommands(router) {

    // ================================================================
    //  grid.align <source> <target> <source-anchor> <target-anchor> [gap]
    //
    //  Move source grid so its source-anchor aligns with target's
    //  target-anchor, with an optional gap in world units.
    // ================================================================

    router.register('grid.align', (args, ctx) => {
        if (args.length < 4) {
            return {
                text: 'ERR: usage: grid.align <source> <target> <source-anchor> <target-anchor> [gap]\n' +
                      '  Anchors: ' + ANCHOR_NAMES.join(', '),
                data: null
            };
        }

        const srcRes = resolveGridByIdOrIndex(ctx, args[0], 'source');
        if (srcRes.error) return { text: srcRes.error, data: null };
        const tgtRes = resolveGridByIdOrIndex(ctx, args[1], 'target');
        if (tgtRes.error) return { text: tgtRes.error, data: null };

        if (srcRes.idx === tgtRes.idx) {
            return { text: 'ERR: source and target must be different grids', data: null };
        }

        const sourceAnchor = args[2].toLowerCase();
        const targetAnchor = args[3].toLowerCase();

        if (!resolveAnchor({ min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }, sourceAnchor)) {
            return { text: `ERR: unknown source anchor '${sourceAnchor}'. Valid: ${ANCHOR_NAMES.join(', ')}`, data: null };
        }
        if (!resolveAnchor({ min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }, targetAnchor)) {
            return { text: `ERR: unknown target anchor '${targetAnchor}'. Valid: ${ANCHOR_NAMES.join(', ')}`, data: null };
        }

        const gap = args.length >= 5 ? parseFloat(args[4]) : 0;
        if (isNaN(gap)) {
            return { text: 'ERR: gap must be a number', data: null };
        }

        // Get world bounds (forces matrix update)
        const srcBounds = getWorldBounds(srcRes.grid);
        if (!srcBounds) return { text: `ERR: grid #${srcRes.idx} has no content bounds`, data: null };
        const tgtBounds = getWorldBounds(tgtRes.grid);
        if (!tgtBounds) return { text: `ERR: grid #${tgtRes.idx} has no content bounds`, data: null };

        // Compute anchor points in world space
        const srcAnchorPt = resolveAnchor(srcBounds, sourceAnchor);
        const tgtAnchorPt = resolveAnchor(tgtBounds, targetAnchor);

        // Offset to move source's anchor to target's anchor
        const offsetX = tgtAnchorPt.x - srcAnchorPt.x;
        const offsetY = tgtAnchorPt.y - srcAnchorPt.y;
        const offsetZ = tgtAnchorPt.z - srcAnchorPt.z;

        // Gap direction: push source away from target
        const gapDir = getGapDirection(sourceAnchor, targetAnchor);

        const src = srcRes.grid;
        const newX = src.position.x + offsetX + gapDir.x * gap;
        const newY = src.position.y + offsetY + gapDir.y * gap;
        const newZ = src.position.z + offsetZ + gapDir.z * gap;

        src.position.set(newX, newY, newZ);

        const srcName = src.getFilename?.() || `#${srcRes.idx}`;
        const tgtName = tgtRes.grid.getFilename?.() || `#${tgtRes.idx}`;

        return {
            text: `OK: aligned ${srcName} [${sourceAnchor}] to ${tgtName} [${targetAnchor}]` +
                  (gap !== 0 ? ` (gap: ${gap})` : '') +
                  ` -> ${fmtPos({ x: newX, y: newY, z: newZ })}`,
            data: {
                source: srcRes.idx,
                target: tgtRes.idx,
                sourceAnchor,
                targetAnchor,
                gap,
                newPosition: { x: newX, y: newY, z: newZ }
            }
        };
    }, {
        description: 'Align source grid anchor to target grid anchor with optional gap',
        usage: '<source-index> <target-index> <source-anchor> <target-anchor> [gap]'
    });

    // ================================================================
    //  grid.attach <source> <target> <position> [gap]
    //
    //  Simplified relative positioning. Positions: above, below,
    //  left, right, top-left, top-right, bottom-left, bottom-right.
    // ================================================================

    router.register('grid.attach', (args, ctx) => {
        if (args.length < 3) {
            return {
                text: 'ERR: usage: grid.attach <source> <target> <position> [gap]\n' +
                      '  Positions: ' + [...ATTACH_POSITIONS].join(', '),
                data: null
            };
        }

        const srcRes = resolveGridByIdOrIndex(ctx, args[0], 'source');
        if (srcRes.error) return { text: srcRes.error, data: null };
        const tgtRes = resolveGridByIdOrIndex(ctx, args[1], 'target');
        if (tgtRes.error) return { text: tgtRes.error, data: null };

        if (srcRes.idx === tgtRes.idx) {
            return { text: 'ERR: source and target must be different grids', data: null };
        }

        const position = args[2].toLowerCase();
        if (!ATTACH_POSITIONS.has(position)) {
            return {
                text: `ERR: unknown position '${position}'. Valid: ${[...ATTACH_POSITIONS].join(', ')}`,
                data: null
            };
        }

        // Default gap=2 for attach (readable spacing out of the box)
        const gap = args.length >= 4 ? parseFloat(args[3]) : 2;
        if (isNaN(gap)) {
            return { text: 'ERR: gap must be a number', data: null };
        }

        const { sourceAnchor, targetAnchor } = ATTACH_MAP[position];

        const srcBounds = getWorldBounds(srcRes.grid);
        if (!srcBounds) return { text: `ERR: grid #${srcRes.idx} has no content bounds`, data: null };
        const tgtBounds = getWorldBounds(tgtRes.grid);
        if (!tgtBounds) return { text: `ERR: grid #${tgtRes.idx} has no content bounds`, data: null };

        const srcAnchorPt = resolveAnchor(srcBounds, sourceAnchor);
        const tgtAnchorPt = resolveAnchor(tgtBounds, targetAnchor);

        const offsetX = tgtAnchorPt.x - srcAnchorPt.x;
        const offsetY = tgtAnchorPt.y - srcAnchorPt.y;
        const offsetZ = tgtAnchorPt.z - srcAnchorPt.z;

        const gapDir = getGapDirection(sourceAnchor, targetAnchor);

        const src = srcRes.grid;
        const newX = src.position.x + offsetX + gapDir.x * gap;
        const newY = src.position.y + offsetY + gapDir.y * gap;
        const newZ = src.position.z + offsetZ + gapDir.z * gap;

        src.position.set(newX, newY, newZ);

        const srcName = src.getFilename?.() || `#${srcRes.idx}`;
        const tgtName = tgtRes.grid.getFilename?.() || `#${tgtRes.idx}`;

        return {
            text: `OK: attached ${srcName} ${position} of ${tgtName}` +
                  (gap !== 2 ? ` (gap: ${gap})` : '') +
                  ` -> ${fmtPos({ x: newX, y: newY, z: newZ })}`,
            data: {
                source: srcRes.idx,
                target: tgtRes.idx,
                position,
                resolvedAnchors: { sourceAnchor, targetAnchor },
                gap,
                newPosition: { x: newX, y: newY, z: newZ }
            }
        };
    }, {
        description: 'Attach source grid to a named position on target grid',
        usage: '<source-index> <target-index> <position> [gap]'
    });

    // ================================================================
    //  grid.stack <idx1> <idx2> [idx3...] <direction> [gap]
    //
    //  Arrange multiple grids in a line. First grid stays fixed;
    //  subsequent grids are positioned after the previous one.
    //
    //  Directions:
    //    horizontal -> left-to-right (trailing-to-leading chain)
    //    vertical   -> top-to-bottom (bottom-to-top chain)
    //    depth      -> front-to-back (along Z axis)
    // ================================================================

    router.register('grid.stack', (args, ctx) => {
        if (args.length < 3) {
            return {
                text: 'ERR: usage: grid.stack <idx1> <idx2> [idx3...] <direction> [gap]\n' +
                      '  Directions: horizontal, vertical, depth',
                data: null
            };
        }

        // Parse from the end: last arg might be gap (number), second-to-last is direction
        let gap = 3; // default gap
        let directionArg;
        let indexArgs;

        const lastArg = args[args.length - 1];
        const secondLastArg = args[args.length - 2];

        if (!isNaN(parseFloat(lastArg)) && STACK_DIRECTIONS.has(secondLastArg?.toLowerCase())) {
            gap = parseFloat(lastArg);
            directionArg = secondLastArg.toLowerCase();
            indexArgs = args.slice(0, -2);
        } else if (STACK_DIRECTIONS.has(lastArg?.toLowerCase())) {
            directionArg = lastArg.toLowerCase();
            indexArgs = args.slice(0, -1);
        } else {
            return {
                text: 'ERR: could not parse direction. Last args must be <direction> [gap].\n' +
                      '  Directions: horizontal, vertical, depth',
                data: null
            };
        }

        if (indexArgs.length < 2) {
            return { text: 'ERR: need at least 2 grid indices to stack', data: null };
        }

        // Resolve all grid indices
        const resolved = [];
        for (const raw of indexArgs) {
            const res = resolveGridByIdOrIndex(ctx, raw, 'grid');
            if (res.error) return { text: res.error, data: null };
            resolved.push(res);
        }

        // Check for duplicates
        const idxSet = new Set(resolved.map(r => r.idx));
        if (idxSet.size !== resolved.length) {
            return { text: 'ERR: duplicate grid indices in stack', data: null };
        }

        // Stack: first stays fixed, each subsequent placed after previous
        const positions = [];
        positions.push({
            idx: resolved[0].idx,
            position: {
                x: resolved[0].grid.position.x,
                y: resolved[0].grid.position.y,
                z: resolved[0].grid.position.z
            }
        });

        for (let i = 1; i < resolved.length; i++) {
            const prev = resolved[i - 1];
            const curr = resolved[i];

            // Re-read bounds after previous grid was moved
            const prevBounds = getWorldBounds(prev.grid);
            if (!prevBounds) return { text: `ERR: grid #${prev.idx} has no content bounds`, data: null };
            const currBounds = getWorldBounds(curr.grid);
            if (!currBounds) return { text: `ERR: grid #${curr.idx} has no content bounds`, data: null };

            let newX = curr.grid.position.x;
            let newY = curr.grid.position.y;
            let newZ = curr.grid.position.z;

            if (directionArg === 'horizontal') {
                // Place curr's left edge at prev's right edge + gap
                const offsetX = (prevBounds.max.x + gap) - currBounds.min.x;
                newX = curr.grid.position.x + offsetX;
                // Align tops
                const offsetY = prevBounds.max.y - currBounds.max.y;
                newY = curr.grid.position.y + offsetY;
            } else if (directionArg === 'vertical') {
                // Place curr's top edge at prev's bottom edge - gap (going down)
                const offsetY = (prevBounds.min.y - gap) - currBounds.max.y;
                newY = curr.grid.position.y + offsetY;
                // Align left edges
                const offsetX = prevBounds.min.x - currBounds.min.x;
                newX = curr.grid.position.x + offsetX;
            } else if (directionArg === 'depth') {
                // Place curr behind prev along Z
                const offsetZ = (prevBounds.min.z - gap) - currBounds.max.z;
                newZ = curr.grid.position.z + offsetZ;
                // Align left edges and tops
                const offsetX = prevBounds.min.x - currBounds.min.x;
                const offsetY = prevBounds.max.y - currBounds.max.y;
                newX = curr.grid.position.x + offsetX;
                newY = curr.grid.position.y + offsetY;
            }

            curr.grid.position.set(newX, newY, newZ);

            positions.push({
                idx: curr.idx,
                position: { x: newX, y: newY, z: newZ }
            });
        }

        const names = resolved.map(r => r.grid.getFilename?.() || `#${r.idx}`);

        return {
            text: `OK: stacked ${names.join(', ')} ${directionArg} (gap: ${gap})\n` +
                  positions.map(p => `  #${p.idx} -> ${fmtPos(p.position)}`).join('\n'),
            data: {
                indices: resolved.map(r => r.idx),
                direction: directionArg,
                gap,
                positions
            }
        };
    }, {
        description: 'Arrange grids in a line (horizontal, vertical, or depth)',
        usage: '<idx1> <idx2> [idx3...] <direction> [gap]'
    });
}

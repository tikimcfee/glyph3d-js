# Phase 0 -- Composition Agent: Spatial Relationship Commands

Agent: **composition**
Focus: `grid.align`, `grid.attach`, `grid.stack` -- relative positioning with semantic anchors.

---

## 1. Anchor Point Computation

The core abstraction: given a grid's world-space bounding box, compute a named anchor point.

CodeGrid.getBounds() returns a THREE.Box3 in world coordinates (after `applyMatrix4(this.matrixWorld)`).
The anchor system maps semantic names to specific (x, y, z) coordinates on that box.

```
    top-left ---- top ------- top-right
       |                         |
    leading     center      trailing
       |                         |
  bottom-left -- bottom -- bottom-right
```

"leading" = left edge center, "trailing" = right edge center.
Y grows upward (Three.js convention). Text starts at top-left and flows down.

### Anchor vocabulary

| Name           | X                    | Y                    | Z          |
|----------------|----------------------|----------------------|------------|
| `top-left`     | min.x                | max.y                | center z   |
| `top`          | center x             | max.y                | center z   |
| `top-right`    | max.x                | max.y                | center z   |
| `leading`      | min.x                | center y             | center z   |
| `center`       | center x             | center y             | center z   |
| `trailing`     | max.x                | center y             | center z   |
| `bottom-left`  | min.x                | min.y                | center z   |
| `bottom`       | center x             | min.y                | center z   |
| `bottom-right` | max.x                | min.y                | center z   |

---

## 2. Implementation: `spatialCommands.js`

This is a complete, runnable command handler module. Drop it into
`examples/github-viewer/websocket/commands/spatialCommands.js` and
wire it into the command index.

```javascript
/**
 * Spatial relationship commands: grid.align, grid.attach, grid.stack, grid.bounds
 *
 * Position grids relative to each other using semantic anchors.
 * All commands read world-space bounds via CodeGrid.getBounds() (THREE.Box3).
 */

import { box, kvLines, table } from '../TUIFormatter.js';

// ============================================================
//  Anchor computation
// ============================================================

/**
 * Valid anchor names.
 * @type {Set<string>}
 */
const ANCHOR_NAMES = new Set([
    'top-left', 'top', 'top-right',
    'leading', 'center', 'trailing',
    'bottom-left', 'bottom', 'bottom-right',
]);

/**
 * Compute a named anchor point on a THREE.Box3.
 *
 * @param {THREE.Box3} bounds - world-space bounding box (has .min and .max as Vector3)
 * @param {string} anchor - anchor name (see ANCHOR_NAMES)
 * @returns {{ x: number, y: number, z: number }} world-space point
 */
function getAnchorPoint(bounds, anchor) {
    const minX = bounds.min.x;
    const maxX = bounds.max.x;
    const minY = bounds.min.y;
    const maxY = bounds.max.y;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const centerZ = (bounds.min.z + bounds.max.z) / 2;

    switch (anchor) {
        case 'top-left':     return { x: minX,    y: maxY,    z: centerZ };
        case 'top':          return { x: centerX, y: maxY,    z: centerZ };
        case 'top-right':    return { x: maxX,    y: maxY,    z: centerZ };
        case 'leading':      return { x: minX,    y: centerY, z: centerZ };
        case 'center':       return { x: centerX, y: centerY, z: centerZ };
        case 'trailing':     return { x: maxX,    y: centerY, z: centerZ };
        case 'bottom-left':  return { x: minX,    y: minY,    z: centerZ };
        case 'bottom':       return { x: centerX, y: minY,    z: centerZ };
        case 'bottom-right': return { x: maxX,    y: minY,    z: centerZ };
        default:
            return null;
    }
}

/**
 * Compute the gap direction vector for an anchor.
 * Gap pushes the source AWAY from the target along the axis
 * implied by the anchor name.
 *
 * @param {string} sourceAnchor - anchor on the source grid
 * @param {string} targetAnchor - anchor on the target grid
 * @returns {{ x: number, y: number, z: number }} unit-ish direction for gap
 */
function getGapDirection(sourceAnchor, targetAnchor) {
    // Determine primary axis from which anchors differ
    const sx = anchorXCategory(sourceAnchor);
    const tx = anchorXCategory(targetAnchor);
    const sy = anchorYCategory(sourceAnchor);
    const ty = anchorYCategory(targetAnchor);

    let dx = 0, dy = 0;

    // If source is on the left side and target is on the right (or vice versa), gap is horizontal
    if (sx !== tx) {
        dx = sx < tx ? -1 : 1; // push source away from target
    }
    if (sy !== ty) {
        dy = sy < ty ? -1 : 1;
    }

    // If no axis differs, default to horizontal push based on source anchor
    if (dx === 0 && dy === 0) {
        if (sx === 0) dx = -1;      // source on left edge -> push left
        else if (sx === 2) dx = 1;  // source on right edge -> push right
        else dy = 1;                // center -> push up
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

// ============================================================
//  Shared helpers
// ============================================================

/**
 * Validate a grid index and return the grid, or return an error result.
 * @param {Array} grids
 * @param {string} rawIndex
 * @param {string} label - e.g. "source" or "target"
 * @returns {{ grid: Object, idx: number } | { error: { text: string, data: null } }}
 */
function resolveGrid(grids, rawIndex, label = 'grid') {
    const idx = parseInt(rawIndex);
    if (isNaN(idx) || idx < 0 || idx >= grids.length) {
        return {
            error: {
                text: `ERR: invalid ${label} index ${rawIndex} (valid: 0-${grids.length - 1})`,
                data: null
            }
        };
    }
    return { grid: grids[idx], idx };
}

/**
 * Get world-space bounds for a grid, or return an error result.
 * @param {Object} grid - CodeGrid instance
 * @param {number} idx
 * @returns {{ bounds: THREE.Box3 } | { error: { text: string, data: null } }}
 */
function getGridBounds(grid, idx) {
    // Force world matrix update so bounds are current
    grid.updateWorldMatrix(true, true);
    const bounds = grid.getBounds();
    if (!bounds || bounds.isEmpty()) {
        return {
            error: {
                text: `ERR: grid #${idx} has no content (empty bounds)`,
                data: null
            }
        };
    }
    return { bounds };
}

/**
 * Format a position for display.
 * @param {{ x: number, y: number, z: number }} pos
 * @returns {string}
 */
function fmtPos(pos) {
    return `(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`;
}

// ============================================================
//  Command registration
// ============================================================

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerSpatialCommands(router) {

    // ================================================================
    //  grid.bounds <index>
    //  Diagnostic: show a grid's world-space bounding box and anchors
    // ================================================================

    router.register('grid.bounds', (args, ctx) => {
        const grids = ctx.getGrids();
        if (args.length < 1) {
            return { text: 'ERR: usage: grid.bounds <index>', data: null };
        }

        const res = resolveGrid(grids, args[0]);
        if (res.error) return res.error;

        const bRes = getGridBounds(res.grid, res.idx);
        if (bRes.error) return bRes.error;
        const bounds = bRes.bounds;

        const size = {
            width: (bounds.max.x - bounds.min.x).toFixed(1),
            height: (bounds.max.y - bounds.min.y).toFixed(1),
            depth: (bounds.max.z - bounds.min.z).toFixed(1),
        };

        const data = {
            'index': String(res.idx),
            'min': `${bounds.min.x.toFixed(1)}, ${bounds.min.y.toFixed(1)}, ${bounds.min.z.toFixed(1)}`,
            'max': `${bounds.max.x.toFixed(1)}, ${bounds.max.y.toFixed(1)}, ${bounds.max.z.toFixed(1)}`,
            'size': `${size.width} x ${size.height} x ${size.depth}`,
        };

        // Show all anchor points
        for (const name of ANCHOR_NAMES) {
            const pt = getAnchorPoint(bounds, name);
            data[name] = `${pt.x.toFixed(1)}, ${pt.y.toFixed(1)}, ${pt.z.toFixed(1)}`;
        }

        return {
            text: box(`BOUNDS #${res.idx}`, kvLines(data, 16), 55) + '\nOK: bounds',
            data: {
                index: res.idx,
                min: { x: bounds.min.x, y: bounds.min.y, z: bounds.min.z },
                max: { x: bounds.max.x, y: bounds.max.y, z: bounds.max.z },
                size: { width: parseFloat(size.width), height: parseFloat(size.height), depth: parseFloat(size.depth) },
            }
        };
    }, {
        description: 'Show grid world-space bounds and anchor points',
        usage: '<index>'
    });

    // ================================================================
    //  grid.align <source> <target> <source-anchor> <target-anchor> [gap]
    //
    //  Move source grid so its source-anchor aligns with target's
    //  target-anchor, with an optional gap in world units.
    //
    //  The alignment works by:
    //  1. Compute target anchor point in world space
    //  2. Compute source anchor point in world space
    //  3. Compute offset = target_anchor - source_anchor
    //  4. Apply gap along the natural separation direction
    //  5. Translate source.position by that offset
    // ================================================================

    router.register('grid.align', (args, ctx) => {
        const grids = ctx.getGrids();
        if (args.length < 4) {
            return {
                text: 'ERR: usage: grid.align <source-index> <target-index> <source-anchor> <target-anchor> [gap]\n' +
                      '  Anchors: top-left, top, top-right, leading, center, trailing, bottom-left, bottom, bottom-right',
                data: null
            };
        }

        // Parse source and target
        const srcRes = resolveGrid(grids, args[0], 'source');
        if (srcRes.error) return srcRes.error;
        const tgtRes = resolveGrid(grids, args[1], 'target');
        if (tgtRes.error) return tgtRes.error;

        if (srcRes.idx === tgtRes.idx) {
            return { text: 'ERR: source and target must be different grids', data: null };
        }

        // Parse anchors
        const sourceAnchor = args[2].toLowerCase();
        const targetAnchor = args[3].toLowerCase();

        if (!ANCHOR_NAMES.has(sourceAnchor)) {
            return { text: `ERR: unknown source anchor '${sourceAnchor}'. Valid: ${[...ANCHOR_NAMES].join(', ')}`, data: null };
        }
        if (!ANCHOR_NAMES.has(targetAnchor)) {
            return { text: `ERR: unknown target anchor '${targetAnchor}'. Valid: ${[...ANCHOR_NAMES].join(', ')}`, data: null };
        }

        // Optional gap
        const gap = args.length >= 5 ? parseFloat(args[4]) : 0;
        if (isNaN(gap)) {
            return { text: 'ERR: gap must be a number', data: null };
        }

        // Get bounds
        const srcBounds = getGridBounds(srcRes.grid, srcRes.idx);
        if (srcBounds.error) return srcBounds.error;
        const tgtBounds = getGridBounds(tgtRes.grid, tgtRes.idx);
        if (tgtBounds.error) return tgtBounds.error;

        // Compute anchor points in world space
        const srcAnchorPt = getAnchorPoint(srcBounds.bounds, sourceAnchor);
        const tgtAnchorPt = getAnchorPoint(tgtBounds.bounds, targetAnchor);

        // Offset needed to move source's anchor to target's anchor
        const offsetX = tgtAnchorPt.x - srcAnchorPt.x;
        const offsetY = tgtAnchorPt.y - srcAnchorPt.y;
        const offsetZ = tgtAnchorPt.z - srcAnchorPt.z;

        // Gap direction: push source away from target
        const gapDir = getGapDirection(sourceAnchor, targetAnchor);

        // Apply offset + gap to source position
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
    //
    //  Each position implies a specific source-anchor/target-anchor pair:
    //    left  -> source trailing aligns to target leading
    //    right -> source leading aligns to target trailing
    //    above -> source bottom aligns to target top
    //    below -> source top aligns to target bottom
    //    etc.
    // ================================================================

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

    router.register('grid.attach', (args, ctx) => {
        const grids = ctx.getGrids();
        if (args.length < 3) {
            return {
                text: 'ERR: usage: grid.attach <source-index> <target-index> <position> [gap]\n' +
                      '  Positions: left, right, above, below, top-left, top-right, bottom-left, bottom-right',
                data: null
            };
        }

        // Parse source and target
        const srcRes = resolveGrid(grids, args[0], 'source');
        if (srcRes.error) return srcRes.error;
        const tgtRes = resolveGrid(grids, args[1], 'target');
        if (tgtRes.error) return tgtRes.error;

        if (srcRes.idx === tgtRes.idx) {
            return { text: 'ERR: source and target must be different grids', data: null };
        }

        // Parse position
        const position = args[2].toLowerCase();
        if (!ATTACH_POSITIONS.has(position)) {
            return {
                text: `ERR: unknown position '${position}'. Valid: ${[...ATTACH_POSITIONS].join(', ')}`,
                data: null
            };
        }

        // Optional gap (default 2 world units for readability)
        const gap = args.length >= 4 ? parseFloat(args[3]) : 2;
        if (isNaN(gap)) {
            return { text: 'ERR: gap must be a number', data: null };
        }

        // Resolve to anchor pairs
        const { sourceAnchor, targetAnchor } = ATTACH_MAP[position];

        // Get bounds
        const srcBounds = getGridBounds(srcRes.grid, srcRes.idx);
        if (srcBounds.error) return srcBounds.error;
        const tgtBounds = getGridBounds(tgtRes.grid, tgtRes.idx);
        if (tgtBounds.error) return tgtBounds.error;

        // Compute anchor points
        const srcAnchorPt = getAnchorPoint(srcBounds.bounds, sourceAnchor);
        const tgtAnchorPt = getAnchorPoint(tgtBounds.bounds, targetAnchor);

        // Offset to align anchors
        const offsetX = tgtAnchorPt.x - srcAnchorPt.x;
        const offsetY = tgtAnchorPt.y - srcAnchorPt.y;
        const offsetZ = tgtAnchorPt.z - srcAnchorPt.z;

        // Gap direction
        const gapDir = getGapDirection(sourceAnchor, targetAnchor);

        // Apply
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
    //  grid.stack <index1> <index2> [index3...] <direction> [gap]
    //
    //  Arrange multiple grids in a line. The first grid stays in
    //  place; subsequent grids are positioned relative to the
    //  previous one.
    //
    //  Directions:
    //    horizontal -> left-to-right (trailing-to-leading chain)
    //    vertical   -> top-to-bottom (bottom-to-top chain)
    //    depth      -> front-to-back (along Z axis)
    // ================================================================

    const STACK_DIRECTIONS = new Set(['horizontal', 'vertical', 'depth']);

    router.register('grid.stack', (args, ctx) => {
        const grids = ctx.getGrids();

        // We need at least: <idx1> <idx2> <direction>
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
            // Last arg is gap, second-to-last is direction
            gap = parseFloat(lastArg);
            directionArg = secondLastArg.toLowerCase();
            indexArgs = args.slice(0, -2);
        } else if (STACK_DIRECTIONS.has(lastArg?.toLowerCase())) {
            // Last arg is direction, no gap
            directionArg = lastArg.toLowerCase();
            indexArgs = args.slice(0, -1);
        } else {
            return {
                text: `ERR: could not parse direction. Last args must be <direction> [gap].\n` +
                      `  Directions: horizontal, vertical, depth`,
                data: null
            };
        }

        if (indexArgs.length < 2) {
            return { text: 'ERR: need at least 2 grid indices to stack', data: null };
        }

        // Resolve all grid indices
        const resolved = [];
        for (const raw of indexArgs) {
            const res = resolveGrid(grids, raw, `grid`);
            if (res.error) return res.error;
            resolved.push(res);
        }

        // Check for duplicates
        const idxSet = new Set(resolved.map(r => r.idx));
        if (idxSet.size !== resolved.length) {
            return { text: 'ERR: duplicate grid indices in stack', data: null };
        }

        // Stack grids: first stays fixed, each subsequent is placed
        // after the previous one along the chosen axis.
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

            // Get bounds of previous grid (must re-read after we moved it)
            prev.grid.updateWorldMatrix(true, true);
            const prevBoundsRes = getGridBounds(prev.grid, prev.idx);
            if (prevBoundsRes.error) return prevBoundsRes.error;
            const prevBounds = prevBoundsRes.bounds;

            curr.grid.updateWorldMatrix(true, true);
            const currBoundsRes = getGridBounds(curr.grid, curr.idx);
            if (currBoundsRes.error) return currBoundsRes.error;
            const currBounds = currBoundsRes.bounds;

            // Compute the offset needed to place curr after prev
            let newX = curr.grid.position.x;
            let newY = curr.grid.position.y;
            let newZ = curr.grid.position.z;

            if (directionArg === 'horizontal') {
                // Place curr's left edge at prev's right edge + gap
                // Offset = (prevBounds.max.x + gap) - currBounds.min.x
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
```

---

## 3. Wiring Into the Command Index

Add to `examples/github-viewer/websocket/commands/index.js`:

```javascript
import registerSpatialCommands from './spatialCommands.js';

// Inside registerAllCommands():
    registerSpatialCommands(router);
```

---

## 4. Wire Protocol Examples

### grid.bounds -- inspect before positioning

```
>>> grid.bounds 0
╔══ BOUNDS #0 ══════════════════════════════════════════╗
║ index:          0                                     ║
║ min:            0.0, -45.2, 0.0                       ║
║ max:            38.4, 1.2, 0.0                        ║
║ size:           38.4 x 46.4 x 0.0                     ║
║ top-left:       0.0, 1.2, 0.0                         ║
║ top:            19.2, 1.2, 0.0                        ║
║ trailing:       38.4, -22.0, 0.0                      ║
║ center:         19.2, -22.0, 0.0                      ║
╚═══════════════════════════════════════════════════════╝
OK: bounds
```

### grid.align -- precise anchor-to-anchor

```
>>> grid.align 5 3 trailing leading 3
OK: aligned annotation.md [trailing] to index.js [leading] (gap: 3) -> (-41.4, 0.0, 0.0)
```

JSON data returned:
```json
{
  "source": 5,
  "target": 3,
  "sourceAnchor": "trailing",
  "targetAnchor": "leading",
  "gap": 3,
  "newPosition": { "x": -41.4, "y": 0.0, "z": 0.0 }
}
```

### grid.attach -- simple relative positioning

```
>>> grid.attach 5 3 left 3
OK: attached annotation.md left of index.js -> (-41.4, -22.0, 0.0)
```

This is equivalent to `grid.align 5 3 trailing leading 3` but with vertical centering -- the source's trailing edge aligns to the target's leading edge.

```
>>> grid.attach 6 3 above
OK: attached README.md above of index.js -> (0.0, 49.6, 0.0)
```

### grid.stack -- multi-grid layout

```
>>> grid.stack 0 1 2 horizontal 5
OK: stacked index.js, utils.js, main.js horizontal (gap: 5)
  #0 -> (0.0, 0.0, 0.0)
  #1 -> (43.4, 0.0, 0.0)
  #2 -> (78.2, 0.0, 0.0)
```

```
>>> grid.stack 3 4 5 vertical 2
OK: stacked api.js, routes.js, middleware.js vertical (gap: 2)
  #3 -> (100.0, 0.0, 0.0)
  #4 -> (100.0, -48.4, 0.0)
  #5 -> (100.0, -82.6, 0.0)
```

---

## 5. Example CLI Sessions

### Session: "Position my annotation flush-left of this code file"

```
# First, list grids to find indices
>>> grid.list
#   filename               glyphs  lines  position
--- ---------------------- ------- ------ ----------
0   src/index.js           2340    87     0,0,0
1   src/utils.js           1856    62     50,0,0
2   (unnamed)              120     4      0,0,0       <-- this is the annotation

# Check the annotation bounds
>>> grid.bounds 2
  size: 18.0 x 5.8 x 0.0

# Attach annotation to the left of index.js with 3 units gap
>>> grid.attach 2 0 left 3
OK: attached (unnamed) left of src/index.js -> (-21.0, -20.6, 0.0)

# Or using grid.align for more control -- tops flush:
>>> grid.align 2 0 top-left top-left 0
OK: aligned (unnamed) [top-left] to src/index.js [top-left] -> (0.0, 0.0, 0.0)
# That puts them overlapping! We want the annotation's right edge at the file's left edge:
>>> grid.align 2 0 trailing leading 3
OK: aligned (unnamed) [trailing] to src/index.js [leading] (gap: 3) -> (-21.0, 0.0, 0.0)
```

### Session: "Line up three files side by side"

```
>>> grid.list
#   filename               glyphs  lines  position
0   src/index.js           2340    87     0,0,0
1   src/utils.js           1856    62     0,0,0
2   src/main.js            950     34     0,0,0

# They're all at origin. Stack them horizontally with 5 units between:
>>> grid.stack 0 1 2 horizontal 5
OK: stacked src/index.js, src/utils.js, src/main.js horizontal (gap: 5)
  #0 -> (0.0, 0.0, 0.0)
  #1 -> (43.4, 0.0, 0.0)
  #2 -> (78.2, 0.0, 0.0)

# Now put a label above the group:
>>> grid.create "Source Files" overview-label
OK: created grid #3 (12 glyphs, 1 lines)

>>> grid.attach 3 0 above 3
OK: attached overview-label above of src/index.js -> (0.0, 4.2, 0.0)
```

### Session: "Create a code review layout with notes beside each file"

```
# Start with files stacked vertically
>>> grid.stack 0 1 2 vertical 8
OK: stacked controller.js, model.js, view.js vertical (gap: 8)
  #0 -> (0.0, 0.0, 0.0)
  #1 -> (0.0, -55.4, 0.0)
  #2 -> (0.0, -98.2, 0.0)

# Create review notes for each file
>>> grid.create "LGTM - clean separation\nof concerns" review-0
OK: created grid #3

>>> grid.create "TODO: add input\nvalidation on line 23" review-1
OK: created grid #4

>>> grid.create "Bug: race condition\nin async handler" review-2
OK: created grid #5

# Attach each review note to the right of its file
>>> grid.attach 3 0 right 5
OK: attached review-0 right of controller.js -> (43.4, 0.0, 0.0)

>>> grid.attach 4 1 right 5
OK: attached review-1 right of model.js -> (43.4, -55.4, 0.0)

>>> grid.attach 5 2 right 5
OK: attached review-2 right of view.js -> (43.4, -98.2, 0.0)
```

---

## 6. Design Decisions and Trade-offs

### Why world-space bounds (not local)?

`CodeGrid.getBounds()` returns world-space bounds via `box.applyMatrix4(this.matrixWorld)`. This is correct for relative positioning because grids may have different parents, scales, or rotations. By working in world space, `grid.align` handles all transform hierarchies correctly.

The one catch: we call `updateWorldMatrix(true, true)` before reading bounds to ensure the matrix is current (in case position was just changed in the same frame).

### Why gap direction is inferred from anchor names

Rather than requiring a separate gap-axis argument, the gap direction is computed from the relationship between source and target anchors. If the source anchor is on the left (leading) and target anchor is on the right (trailing), the gap pushes the source further left. This is intuitive: "put my annotation's right edge at the file's left edge, then push it 3 more units to the left."

### grid.attach defaults to gap=2

Unlike grid.align (which defaults to gap=0 for precise placement), grid.attach defaults to gap=2 world units. This provides readable spacing out of the box for the common case of "put this next to that."

### grid.stack aligns secondary axes

When stacking horizontally, tops are aligned. When stacking vertically, left edges are aligned. This matches the natural expectation for code file layouts where you want consistent alignment.

### No persistent relationships

These commands are one-shot positioning operations. They do not create live constraints. If you move the target grid later, the source does not follow. For live constraints, a future `grid.bind` command could store relationships and re-evaluate on layout changes.

---

## 7. Anchor Computation -- Worked Example

Given grid #0 at position (0, 0, 0) with content 80 chars wide, 50 lines tall:
- charWidth ~ 0.6 (from CHAR_DIMENSIONS), worldScale 0.025 -> effective width varies
- Suppose getBounds() returns: min=(-1, -46.2, -0.5), max=(39.4, 1.2, 0)

Anchor points:
- `top-left`:     (-1.0, 1.2, -0.25)
- `top`:          (19.2, 1.2, -0.25)
- `top-right`:    (39.4, 1.2, -0.25)
- `leading`:      (-1.0, -22.5, -0.25)
- `center`:       (19.2, -22.5, -0.25)
- `trailing`:     (39.4, -22.5, -0.25)
- `bottom-left`:  (-1.0, -46.2, -0.25)
- `bottom`:       (19.2, -46.2, -0.25)
- `bottom-right`: (39.4, -46.2, -0.25)

To align grid #1's `trailing` to grid #0's `leading` with gap=3:
1. Get grid #1's trailing anchor: say (58.0, -10.0, 0)
2. Get grid #0's leading anchor: (-1.0, -22.5, -0.25)
3. Offset = (-1.0 - 58.0, -22.5 - (-10.0), -0.25 - 0) = (-59.0, -12.5, -0.25)
4. Gap direction: source=trailing (right), target=leading (left) -> push source left -> dx=-1
5. Final offset = (-59.0 + -1*3, -12.5, -0.25) = (-62.0, -12.5, -0.25)
6. New position = grid #1.position + offset

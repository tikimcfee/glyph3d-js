/**
 * walkTreeLayout — the "walk-tree" scheme, as a pure layout component for ContentTree.
 *
 * A directory is a section: its own files pack into a square-ish cluster (flowBoxes), and
 * its child directories cascade BELOW the files (−Y) and one step BACK (−Z) — a stairway you
 * fly forward to descend, Reingold-Tilford in spirit (each subtree's footprint measured
 * bottom-up so siblings never collide). Lifted from the old absolute treeLayout into a
 * RELATIVE placement: each node positions its children in its OWN local frame (a child dir
 * sits at local z = −zStep, composing through the node transforms), so the subtree rides its
 * node — move a dir, its contents follow — and the root is the project's single handle.
 *
 * Pure: tree-structure + leaf sizes → positions, no side effects beyond writing
 * child.position and caching measurements on node.userData. Operates on ContentTree nodes
 * (THREE.Group; children split by userData.isDir). Leaf sizes come from leaf.layoutBounds()
 * (a grid's local content Box3) when present, else a centered box from userData.size (mocks).
 */

import { flowBoxes, squareWrap } from './flowBoxes.js';
import { leafBox, partitionChildren } from './nodeUtils.js';

export const WALK_DEFAULTS = { margin: 16, gap: 60, zStep: 170, yStep: 70, minW: 50, minH: 30 };

/** Post-order: cache each node's packed footprint + measured size. Returns {w,h}. */
function measure(node, opts) {
    const { files, dirs } = partitionChildren(node);   // deterministic order; markers excluded

    const fileBoxes = files.map(leafBox);
    const fSizes = fileBoxes.map((b) => ({ w: b.max.x - b.min.x, h: b.max.y - b.min.y }));
    const fileFlow = flowBoxes(fSizes, { margin: opts.margin, wrapWidth: squareWrap(fSizes, opts.margin) });

    const childSizes = dirs.map((d) => measure(d, opts));
    // Child dirs cascade in canonical order, snaking across wraps so the ordered-arrow
    // chain steps to a neighbor instead of backtracking to the left margin each row.
    const childPack = flowBoxes(childSizes, { margin: opts.gap, wrapWidth: squareWrap(childSizes, opts.gap), serpentine: true });

    // A truly-empty node (no files, no child dirs — e.g. a dir left empty after a removal)
    // measures to ZERO so it occupies no space and siblings close the gap. Non-empty
    // sections get a minimum footprint for visual consistency.
    const empty = files.length === 0 && dirs.length === 0;
    const w = empty ? 0 : Math.max(fileFlow.width, childPack.width, opts.minW);
    // children stack BELOW the files → height is additive (reserve room for the cascade).
    const stackedH = fileFlow.height + (childPack.height > 0 ? opts.yStep + childPack.height : 0);
    const h = empty ? 0 : Math.max(stackedH, opts.minH);

    node.userData._wt = { files, dirs, fileBoxes, fileFlow, childSizes, childPack };
    node.userData.size = { x: w, y: h, z: 0 };
    return { w, h };
}

/** Pre-order: place children in the node's LOCAL frame (origin = footprint top-center). Files
 *  fill the top, centered on x; child dirs cascade below + one z-step back. Recurses. */
function place(node, opts) {
    const wt = node.userData._wt;
    if (!wt) return;
    const { files, dirs, fileBoxes, fileFlow, childSizes, childPack } = wt;

    const fLeft = -fileFlow.width / 2;
    files.forEach((leaf, i) => {
        const s = fileFlow.slots[i];                // top-left of this file's cell
        const b = fileBoxes[i];                     // local content box
        // position the leaf so its content's top-left lands at the cell (subtract the
        // content offset from the leaf origin → works for any origin/nesting).
        leaf.position.set(fLeft + s.x - b.min.x, s.y - b.max.y, 0);
    });

    if (childPack.slots.length === 0) return;
    const pLeft = -childPack.width / 2;
    const pTop = -fileFlow.height - opts.yStep;     // below the files
    dirs.forEach((child, i) => {
        const s = childPack.slots[i];               // top-left of this child's footprint
        const cw = childSizes[i].w;
        child.position.set(pLeft + s.x + cw / 2, pTop + s.y, -opts.zStep); // origin = footprint top-center, one z back
        place(child, opts);
    });
}

/**
 * Lay out a ContentTree subtree in place. Default ContentTree layout.
 * @param {THREE.Object3D} root the node to lay out (its children positioned in its local frame)
 * @param {object} [opts] overrides for WALK_DEFAULTS (margin/gap/zStep/yStep/minW/minH)
 * @returns {{w:number,h:number}} the root's measured footprint
 */
export default function walkTreeLayout(root, opts = {}) {
    const o = { ...WALK_DEFAULTS, ...opts };
    const size = measure(root, o);
    place(root, o);
    return size;
}

/**
 * treeLayout — the directory tree as a compact 3D layered tree. Each axis carries one idea, and the
 * whole thing stays ~√(file count) across so it fits the view instead of smearing into the void:
 *
 *   X, Y — a directory's FILES pack into a standing square-ish WALL of sheets; and a directory's CHILD
 *          directories pack (left-to-right, wrapping) into a square-ish BLOCK. So breadth grows like a
 *          square root, not linearly — a repo stays a bounded slab, never a kilometers-wide row.
 *   Z    — DEPTH: a directory's whole child block sits one `depthStep` BEHIND it (nearer = shallower).
 *          Sheets are flat (~1 unit deep), so Z is free real estate — depth gets a generous step and
 *          becomes the distance you fly into, the thing that reads as hierarchy.
 *
 * A parent's wall sits in front of its children's block, centered over it, so the structure recedes as
 * a tree growing away from you. No wrapping into a drum, no truncation (every file gets a slot). Units
 * are calibrated to the REAL scale (a sheet is ~70–170 wide × ~80–210 tall), matching the other
 * schemes — gaps in the tens, a depth step in the hundreds. Pure + tree-resident: measure the subtree
 * footprint bottom-up (post-order), place top-down (pre-order), children in the node's LOCAL frame.
 * Files stay direct children of their directory node — no grouping nodes to normalize away.
 */

import { partitionChildren, leafBox } from './nodeUtils.js';
import { flowBoxes, squareWrap } from './flowBoxes.js';

export const TREE_DEFAULTS = {
    depthStep: 600,   // −Z between a directory and its child block — a few sheet-widths of real depth
    dirGap: 200,      // gap between sibling child blocks in the packed 2D block
    fileGap: 30,      // gap between file sheets within a directory's wall
};

/** Post-order: pack this directory's files into a wall and its child subtrees into a 2D block; cache
 *  both and report the directory's XY FOOTPRINT (the larger of wall and block on each axis — they sit
 *  at different Z, centered, so they overlap in projection). */
function measure(node, opts) {
    const { files, dirs } = partitionChildren(node);

    // Files → a square-ish wall of sheets (squareWrap favors more rows over an endless row for wide
    // code sheets); flowBoxes returns each sheet's top-left slot + the wall extent.
    const fileSizes = files.map((f) => { const b = leafBox(f); return { w: b.max.x - b.min.x, h: b.max.y - b.min.y, b, leaf: f }; });
    const fileWrap = squareWrap(fileSizes, opts.fileGap);
    const fileFlow = flowBoxes(fileSizes, { margin: opts.fileGap, wrapWidth: fileWrap });

    // Child subtrees → their own footprints, packed into a square-ish block (left-to-right, wrapping).
    const childFps = dirs.map((d) => measure(d, opts));   // each { w, h }
    const childSizes = childFps.map((c) => ({ w: c.w, h: c.h }));
    const childWrap = squareWrap(childSizes, opts.dirGap);
    const childFlow = flowBoxes(childSizes, { margin: opts.dirGap, wrapWidth: childWrap });

    const w = Math.max(fileFlow.width, childFlow.width);
    const h = Math.max(fileFlow.height, childFlow.height);
    node.userData._tree = {
        fileSizes, fileSlots: fileFlow.slots, wallW: fileFlow.width, wallH: fileFlow.height,
        dirs, childFps, childSlots: childFlow.slots, blockW: childFlow.width, blockH: childFlow.height,
    };
    node.userData.size = { x: w, y: h, z: dirs.length ? opts.depthStep : 1 };
    return { w, h };
}

/** Pre-order: lay this directory's file sheets into its wall (centered on the node origin, z = 0), then
 *  place each child directory at its slot in the child block (centered on the origin, z = −depthStep)
 *  and recurse. Both wall and block are centered on the origin so a parent sits square in front of its
 *  children. */
function apply(node, opts) {
    const t = node.userData._tree;

    // Files: content-box center → slot center, wall centered on the origin (slots are top-left, y down).
    t.fileSizes.forEach((s, i) => {
        const slot = t.fileSlots[i];
        const bcx = (s.b.min.x + s.b.max.x) / 2, bcy = (s.b.min.y + s.b.max.y) / 2;   // leaf box offset from its origin
        const targetX = slot.x + s.w / 2 - t.wallW / 2;
        const targetY = slot.y - s.h / 2 + t.wallH / 2;
        s.leaf.position.set(targetX - bcx, targetY - bcy, 0);
        s.leaf.rotation.set(0, 0, 0);
    });

    // Child directories: each subtree's origin (its own wall center) → its slot center, block centered
    // on the origin, one depth step back.
    t.dirs.forEach((c, i) => {
        const slot = t.childSlots[i];
        const fp = t.childFps[i];
        const cx = slot.x + fp.w / 2 - t.blockW / 2;
        const cy = slot.y - fp.h / 2 + t.blockH / 2;
        c.position.set(cx, cy, -opts.depthStep);
        c.rotation.set(0, 0, 0);
        apply(c, opts);
    });
}

/**
 * Lay out a ContentTree subtree as a compact 3D layered tree: files + child blocks packed square in XY,
 * hierarchy receding in Z. @param {import('three').Object3D} root @param {object} [opts] overrides for
 * TREE_DEFAULTS @returns {{w:number,h:number}} the root subtree's XY footprint.
 */
export default function treeLayout(root, opts = {}) {
    const o = { ...TREE_DEFAULTS, ...opts };
    const fp = measure(root, o);
    apply(root, o);
    return { w: fp.w, h: fp.h };
}

/**
 * districtLayout — the "nested district" scheme, a pure layout component for ContentTree.
 *
 * Every directory is a PLOT: its files and its child directories' plots pack TOGETHER
 * into one square-ish mosaic (flowBoxes), so the project reads like a city map — a
 * district contains its buildings (files) and its sub-districts (child dirs), each
 * sub-district inset by a pad inside its parent's footprint and one small step back in
 * Z (depth recedes gently, composing per nesting level). Where the walk-tree is a
 * stairway you fly forward to descend, the district is a map you read at a glance:
 * containment IS the hierarchy.
 *
 * Same contract as every scheme: pure (tree-structure + leaf sizes → positions, writes
 * only child.position + node.userData), relative (children placed in the node's LOCAL
 * frame, origin = footprint top-center), measure post-order / place pre-order.
 */

import { flowBoxes, squareWrap } from './flowBoxes.js';
import { leafBox, partitionChildren } from './nodeUtils.js';

export const DISTRICT_DEFAULTS = { margin: 16, pad: 24, zInset: 24, minW: 50, minH: 30 };

/** Post-order: pack files + padded child plots into one mosaic. Returns {w,h}. */
function measure(node, opts) {
    const { files, dirs } = partitionChildren(node);   // deterministic order; markers excluded

    const fileBoxes = files.map(leafBox);
    const dirSizes = dirs.map((d) => measure(d, opts));
    // One mosaic per plot: files at their content size, child plots padded on all
    // sides (the pad is the sub-district's margin inside the parent's footprint).
    const items = [
        ...fileBoxes.map((b) => ({ w: b.max.x - b.min.x, h: b.max.y - b.min.y })),
        ...dirSizes.map((s) => ({ w: s.w + 2 * opts.pad, h: s.h + 2 * opts.pad })),
    ];
    const pack = flowBoxes(items, { margin: opts.margin, wrapWidth: squareWrap(items, opts.margin) });

    // Truly-empty plot → zero footprint (siblings close the gap); otherwise a floor
    // for visual consistency. The clamp only grows the reported size, so children
    // (placed by the pack) always stay inside it.
    const empty = items.length === 0;
    const w = empty ? 0 : Math.max(pack.width, opts.minW);
    const h = empty ? 0 : Math.max(pack.height, opts.minH);

    node.userData._dt = { files, dirs, fileBoxes, dirSizes, pack };
    node.userData.size = { x: w, y: h, z: 0 };
    return { w, h };
}

/** Pre-order: place files + child plots at their mosaic slots in the node's LOCAL
 *  frame (origin = footprint top-center). Child plots inset by pad, one z-step back. */
function place(node, opts) {
    const dt = node.userData._dt;
    if (!dt) return;
    const { files, dirs, fileBoxes, dirSizes, pack } = dt;

    const left = -pack.width / 2;
    files.forEach((leaf, i) => {
        const s = pack.slots[i];                    // top-left of this file's cell
        const b = fileBoxes[i];                     // local content box
        leaf.position.set(left + s.x - b.min.x, s.y - b.max.y, 0);
        leaf.rotation.set(0, 0, 0);             // a 2D scheme owns identity rotation (cf. jellyfish, which turns each panel outward)
    });

    dirs.forEach((child, j) => {
        const s = pack.slots[files.length + j];     // top-left of this child's PADDED cell
        const sz = dirSizes[j];
        // child origin = its footprint top-center, inset pad inside the padded cell,
        // one z-step back — nesting depth accumulates through the node transforms.
        child.position.set(left + s.x + opts.pad + sz.w / 2, s.y - opts.pad, -opts.zInset);
        child.rotation.set(0, 0, 0);
        place(child, opts);
    });
}

/**
 * Lay out a ContentTree subtree in place as nested districts.
 * @param {import('three').Object3D} root the node to lay out (children positioned in its local frame)
 * @param {object} [opts] overrides for DISTRICT_DEFAULTS (margin/pad/zInset/minW/minH)
 * @returns {{w:number,h:number}} the root's measured footprint
 */
export default function districtLayout(root, opts = {}) {
    const o = { ...DISTRICT_DEFAULTS, ...opts };
    const size = measure(root, o);
    place(root, o);
    return size;
}

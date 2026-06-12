/**
 * packedLayout — the "packed" scheme, a pure layout component for ContentTree.
 *
 * The tightest lens: a GrandPerspective/Codemap-style packed sheet that reads like a
 * tree. Every directory shelf-packs its own files into one dense block (tallest-first,
 * square-ish target) at the TOP of its footprint, then packs its child directories'
 * blocks in a second tier BELOW it — so the root's own files sit at the visual top of
 * the whole field and depth cascades down the screen and back in Z. Hierarchy is
 * encoded in DEPTH, not insets: each child directory sits one depthZ step behind its
 * parent, so nesting accumulates through the transform chain into z = −depth × depthZ —
 * layered topography you read at a glance, with related blocks adjacent because the
 * tree IS the packing order.
 *
 * Harvested from the v1 managers: TreemapLayoutManager's height-sorted packing,
 * contiguous per-dir blocks + dirGap, and the depthZ formula; HierarchicalLayoutManager's
 * area-based wrap target (sqrt(totalArea × aspect)) in place of a rigid column count.
 *
 * Same contract as every scheme: pure (writes only child.position + node.userData),
 * relative (children placed in the node's LOCAL frame, origin = footprint top-center),
 * measure post-order / place pre-order.
 */

import { flowBoxes } from './flowBoxes.js';
import { leafBox, partitionChildren } from './nodeUtils.js';

// depthZ is in WORLD units and must read against panel-sized content — below ~50 the
// layering disappears entirely; 500 is where Ivan found the hierarchy snaps into an
// obvious structure on a repo-sized tree (walk's stairway steps 170 for reference).
export const PACKED_DEFAULTS = { margin: 6, dirGap: 14, depthZ: 500, aspect: 1.5, minW: 50, minH: 30 };

/** Wrap width targeting a footprint of the given aspect (w ≈ aspect × h): from the
 *  total packed area, never narrower than the widest item. Infinity for 0–1 items. */
function areaWrapWidth(sizes, margin, aspect) {
    if (sizes.length <= 1) return Infinity;
    let area = 0, maxW = 0;
    for (const s of sizes) {
        area += (s.w + margin) * (s.h + margin);
        maxW = Math.max(maxW, s.w);
    }
    return Math.max(Math.sqrt(area * aspect), maxW + margin);
}

/** Dense shelf pack: items sorted tallest-first (stable — index breaks ties, so two
 *  identically-sized trees pack identically), wrapped to an area-derived width. Slots
 *  come back in the CALLER's original item order. */
function packBlock(sizes, { margin, aspect }) {
    const order = sizes.map((_, i) => i).sort((a, b) => (sizes[b].h - sizes[a].h) || (a - b));
    const flow = flowBoxes(order.map((i) => sizes[i]), {
        margin,
        wrapWidth: areaWrapWidth(sizes, margin, aspect),
    });
    const slots = new Array(sizes.length);
    order.forEach((orig, k) => { slots[orig] = flow.slots[k]; });
    return { slots, width: flow.width, height: flow.height };
}

/** Post-order: files → one dense block (the TOP tier); child-dir blocks → a second
 *  packed tier BELOW it. Footprint = the union of both tiers. */
function measure(node, opts) {
    const { files, dirs } = partitionChildren(node);   // deterministic order; markers excluded

    const fileBoxes = files.map(leafBox);
    const fileBlock = files.length
        ? packBlock(fileBoxes.map((b) => ({ w: b.max.x - b.min.x, h: b.max.y - b.min.y })),
            { margin: opts.margin, aspect: opts.aspect })
        : null;
    const dirSizes = dirs.map((d) => measure(d, opts));
    const childPack = dirs.length ? packBlock(dirSizes, { margin: opts.dirGap, aspect: opts.aspect }) : null;

    // Truly-empty node → zero footprint (siblings close the gap); otherwise a floor for
    // visual consistency. The clamp only grows the reported size, so packed content
    // always stays inside it.
    const empty = !fileBlock && !childPack;
    const w = empty ? 0 : Math.max(fileBlock?.width ?? 0, childPack?.width ?? 0, opts.minW);
    const stackedH = (fileBlock?.height ?? 0)
        + (fileBlock && childPack ? opts.dirGap : 0)
        + (childPack?.height ?? 0);
    const h = empty ? 0 : Math.max(stackedH, opts.minH);

    node.userData._pk = { files, dirs, fileBoxes, fileBlock, dirSizes, childPack };
    node.userData.size = { x: w, y: h, z: 0 };
    return { w, h };
}

/** Pre-order: the file tier centered at the top of the node's LOCAL frame (origin =
 *  footprint top-center), the child tier centered below it — and one depthZ step back,
 *  so the root reads at the visual top and depth cascades down/backward. */
function place(node, opts) {
    const pk = node.userData._pk;
    if (!pk) return;
    const { files, dirs, fileBoxes, fileBlock, dirSizes, childPack } = pk;

    if (fileBlock) {
        const fLeft = -fileBlock.width / 2;
        files.forEach((leaf, i) => {
            const s = fileBlock.slots[i];
            const b = fileBoxes[i];
            leaf.position.set(fLeft + s.x - b.min.x, s.y - b.max.y, 0);
        });
    }
    if (!childPack) return;
    const cLeft = -childPack.width / 2;
    const cTop = -(fileBlock ? fileBlock.height + opts.dirGap : 0);
    dirs.forEach((child, j) => {
        const s = childPack.slots[j];
        // child origin = its footprint top-center; depth accumulates: −depthZ per level.
        child.position.set(cLeft + s.x + dirSizes[j].w / 2, cTop + s.y, -opts.depthZ);
        place(child, opts);
    });
}

/**
 * Lay out a ContentTree subtree in place as a packed sheet with depth topography.
 * @param {import('three').Object3D} root the node to lay out (children positioned in its local frame)
 * @param {object} [opts] overrides for PACKED_DEFAULTS (margin/dirGap/depthZ/aspect/minW/minH)
 * @returns {{w:number,h:number}} the root's measured footprint
 */
export default function packedLayout(root, opts = {}) {
    const o = { ...PACKED_DEFAULTS, ...opts };
    const size = measure(root, o);
    place(root, o);
    return size;
}

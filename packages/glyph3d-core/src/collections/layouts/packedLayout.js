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
// rakeZ is the GRAVITY cascade: each descending row of a node's child dirs steps this
// far further back in Z, so the serpentine snake falls as a curtain that leans gently
// away (never toward the camera) — lower rows recede and compress instead of piling up
// a taller flat wall. Modest against depthZ so the downward −Y hang always dominates.
export const PACKED_DEFAULTS = { margin: 6, dirGap: 14, depthZ: 500, rakeZ: 120, aspect: 1.5, minW: 50, minH: 30 };

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
 *  come back in the CALLER's original item order.
 *
 *  With `ordered`, the size sort is skipped: items pack in their GIVEN sequence and the
 *  rows boustrophedon (serpentine). This is the child-DIRECTORY tier — directory order is
 *  a first-class spatial axis there (a small early sibling stays early, not size-sunk),
 *  so the ordered-arrow chain threads a clean snake. Files keep the dense tallest-first
 *  pack: they carry no arrows, so density wins for them. */
function packBlock(sizes, { margin, aspect, ordered = false }) {
    const wrapWidth = areaWrapWidth(sizes, margin, aspect);
    if (ordered) {
        const flow = flowBoxes(sizes, { margin, wrapWidth, serpentine: true });
        return { slots: flow.slots, width: flow.width, height: flow.height };
    }
    const order = sizes.map((_, i) => i).sort((a, b) => (sizes[b].h - sizes[a].h) || (a - b));
    const flow = flowBoxes(order.map((i) => sizes[i]), { margin, wrapWidth });
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
    // Child dirs pack in canonical order (serpentine), not by size — directory order is
    // the priority here, so the arrow chain reads as a clean snake.
    const childPack = dirs.length ? packBlock(dirSizes, { margin: opts.dirGap, aspect: opts.aspect, ordered: true }) : null;

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
            leaf.rotation.set(0, 0, 0);             // a 2D scheme owns identity rotation (cf. jellyfish, which turns each panel outward)
        });
    }
    if (!childPack) return;
    const cLeft = -childPack.width / 2;
    const cTop = -(fileBlock ? fileBlock.height + opts.dirGap : 0);
    dirs.forEach((child, j) => {
        const s = childPack.slots[j];
        // child origin = its footprint top-center; depth accumulates: −depthZ per level,
        // plus a gravity rake — each descending row leans one rakeZ further back, so the
        // hanging snake reads as a curtain falling down-and-away.
        child.position.set(cLeft + s.x + dirSizes[j].w / 2, cTop + s.y, -opts.depthZ - s.row * opts.rakeZ);
        child.rotation.set(0, 0, 0);
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

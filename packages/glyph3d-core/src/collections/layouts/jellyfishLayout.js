/**
 * jellyfishLayout — the "jellyfish" scheme: a radial HUB-AND-SPOKE that descends into a
 * reverse cone, mirroring the directory tree.
 *
 * The mental model (Ivan's donut): take a disc, cut radial notches from the center, and
 * slide a business card into each notch — the card's LEADING edge on the spoke (at the
 * center), its TRAILING edge at the rim. Each FILE is one such card: a grid standing
 * vertically, its width running radially outward from the hub axis, rotated around Y by an
 * even angular step so the files fan around the hub like a Rolodex. Equivalently: node at
 * origin, add a grid, rotate the parent a step around Y, add the next — a radial fan.
 *
 * A directory is the hub of its file-fan; its child directories hang BELOW it and become
 * hubs of their own, so the whole structure descends as a reverse cone (root near the top,
 * leaves trailing toward the floor) that IS the directory hierarchy.
 *
 * The breakthrough over every earlier attempt: files are NOT packed (shelves, discs,
 * circles, piles all obscured the hierarchy and fought file sizes). Radial blades from a
 * common axis never intersect regardless of count — they just fan tighter — so there is
 * nothing to pack. The only sizing is the child ring radius, set so sibling subtrees don't
 * overlap (what keeps a tree drawing legible).
 *
 * Same contract as every scheme: pure (writes only child.position/rotation + node.userData),
 * relative (children in the node's LOCAL frame, origin = footprint top-center = the hub
 * top), measure post-order / place pre-order. Footprint is a real prism (size carries z).
 */

import { leafBox, partitionChildren } from './nodeUtils.js';

export const JELLYFISH_DEFAULTS = { hubRadius: 40, drop: 320, childGap: 0.4, minRadius: 40 };

/** Evenly space N child-subtree bodies on a horizontal ring (XZ). Ring radius sized so the
 *  chord between adjacent slots clears the two biggest neighbors. One body → center. */
function ringSlots(radii, gap, minRadius) {
    const n = radii.length;
    if (n === 0) return { slots: [], outerRadius: 0 };
    const maxR = Math.max(...radii);
    if (n === 1) return { slots: [{ x: 0, z: 0 }], outerRadius: Math.max(maxR, minRadius) };
    const ringRadius = Math.max((maxR * (1 + gap)) / Math.sin(Math.PI / n), minRadius);
    const slots = [];
    for (let i = 0; i < n; i++) {
        const a = (i * 2 * Math.PI) / n;
        slots.push({ x: ringRadius * Math.cos(a), z: ringRadius * Math.sin(a) });
    }
    return { slots, outerRadius: ringRadius + maxR };
}

/** Post-order: size the file fan + the child ring, cache, report {radius, height}. */
function measure(node, opts) {
    const { files, dirs } = partitionChildren(node);   // deterministic order; markers excluded

    const fileBoxes = files.map(leafBox);
    const maxFileW = files.length ? Math.max(...fileBoxes.map((b) => b.max.x - b.min.x)) : 0;
    const maxFileH = files.length ? Math.max(...fileBoxes.map((b) => b.max.y - b.min.y)) : 0;
    const fanRadius = files.length ? opts.hubRadius + maxFileW : 0;   // blade rim reach

    const childMeasures = dirs.map((d) => measure(d, opts));
    // Ring sized by each child's OWN FAN radius (its hub's blades — bounded by file size),
    // NOT its full subtree radius. Subtree-radius sizing compounds MULTIPLICATIVELY up the
    // tree (and one big branch flings every sibling out by its radius), exploding to
    // thousands of units. Fan-bounded → the cone grows roughly linearly with depth, and
    // sibling HUBS stay clear; deeper descendants are separated by the −Y drop.
    const childRing = ringSlots(childMeasures.map((m) => m.fanRadius), opts.childGap, opts.minRadius);

    const fanY = -maxFileH / 2;                          // blade tops near origin (anchor)
    const childRingY = -(maxFileH + (dirs.length ? opts.drop : 0));   // hubs hang below the fan
    const maxChildH = childMeasures.reduce((m, c) => Math.max(m, c.height), 0);

    const fanRadiusOut = Math.max(fanRadius, opts.minRadius);   // this hub's reach, for the parent's ring
    const radius = Math.max(fanRadius, childRing.outerRadius, opts.minRadius);
    const height = Math.max(maxFileH, dirs.length ? maxFileH + opts.drop + maxChildH : 0, opts.minRadius);

    node.userData._jf = { files, fileBoxes, dirs, childRing, fanY, childRingY };
    node.userData.size = { x: 2 * radius, y: height, z: 2 * radius };
    return { radius, height, fanRadius: fanRadiusOut };
}

/** Pre-order: fan the file blades around the hub, hang the child hubs below, recurse. */
function place(node, opts) {
    const jf = node.userData._jf;
    if (!jf) return;
    const { files, fileBoxes, dirs, childRing, fanY, childRingY } = jf;

    const n = files.length;
    files.forEach((leaf, i) => {
        const theta = (i * 2 * Math.PI) / n;             // even angular fan, full circle
        const b = fileBoxes[i];
        const cy = (b.min.y + b.max.y) / 2, cz = (b.min.z + b.max.z) / 2;
        const cos = Math.cos(theta), sin = Math.sin(theta);
        // blade: width runs radially outward (local +X → radial dir), normal tangential.
        // leading edge (b.min.x) sits at hubRadius; content's vertical center at fanY.
        const k = opts.hubRadius - b.min.x;
        leaf.position.set(k * cos + cz * sin, fanY - cy, k * sin - cz * cos);
        leaf.rotation.set(0, -theta, 0);
    });

    dirs.forEach((child, j) => {
        const s = childRing.slots[j];
        child.position.set(s.x, childRingY, s.z);
        child.rotation.set(0, 0, 0);
        place(child, opts);
    });
}

/**
 * Lay out a ContentTree subtree as a radial hub-and-spoke reverse cone (jellyfish).
 * @param {import('three').Object3D} root the node to lay out (children positioned in its local frame)
 * @param {object} [opts] overrides for JELLYFISH_DEFAULTS (hubRadius/drop/childGap/minRadius)
 * @returns {{w:number,h:number}} the root's footprint (w = diameter, h = drop); the
 *   volumetric extent lives on node.userData.size.
 */
export default function jellyfishLayout(root, opts = {}) {
    const o = { ...JELLYFISH_DEFAULTS, ...opts };
    const { radius, height } = measure(root, o);
    place(root, o);
    return { w: 2 * radius, h: height };
}

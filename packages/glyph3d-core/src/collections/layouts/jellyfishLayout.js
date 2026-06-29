/**
 * jellyfishLayout — the "jellyfish" scheme: a directory is a tall cylindrical COLUMN, and the
 * tree descends as a reverse cone of these columns.
 *
 * The mental model: a directory's files pack into PANELS (panelPack.js — bounded `panelW × panelH`
 * blocks, each a VStack of grids), and the panels tile the surface of one cylinder. The cylinder
 * has a TARGET RADIUS (a configured "how wide should a column be") — NOT a radius that grows with
 * file count. From that radius we get how many panels sit abreast around the rim (`n = round(π /
 * atan(faceW / 2R))`); each panel is a face of that n-gon, turned to read OUTWARD, tiling edge to
 * edge (the proven polygon math). Overflow goes DOWN: panel i lands at angular slot `i mod n` and
 * stacks beneath the previous panel in that slot (`i div n`). So more files make the column TALLER,
 * never wider — a few big files give a BLOCKY cylinder (few fat faces), hundreds of little files a
 * fine MOSAIC (many small faces), both at the same target width.
 *
 * A directory is the top of its column; its child directories hang BELOW it on a ring and become
 * columns of their own, so the whole structure descends as a reverse cone (root near the top,
 * leaves trailing toward the floor) that IS the directory hierarchy.
 *
 * STRUCTURAL scheme (unlike the pure 2D schemes): measure builds + inserts the panel nodes and
 * re-parents the grids into them. ContentTree.relayout normalizes these groups away (_flattenGroups)
 * before any relayout, so the wrap is idempotent and reversible — switching to a flat scheme
 * dissolves the panels and restores the bare file grids. Otherwise the same contract: relative
 * (children in the node's LOCAL frame, origin = footprint top-center = the column top), measure
 * post-order / place pre-order. Footprint is a real prism (size carries z).
 */

import { leafBox, partitionChildren } from './nodeUtils.js';
import { packPanels, PANEL_DEFAULTS } from './panelPack.js';

export const JELLYFISH_DEFAULTS = {
    targetRadius: 860,   // preferred column radius — sets how many panels sit abreast; width ≈ 2R
    hubRadius: 155,      // minimum radius (the bare pole), floors the apothem for 1–2 faces
    panelGap: 66,        // vertical gap between panels stacked down one face/column
    faceGap: 0.4,        // tangential gap fraction between abreast faces
    drop: 800,           // −Y descent from a column's base to its child-directory ring
    childGap: 0.2,       // ring spacing between sibling child columns
    minRadius: 290,      // floor for the various radii (keeps a lone column/ring legible)
    ...PANEL_DEFAULTS,   // panelW / panelH / colGap / rowGap — the panel packing budget
};

/** Apothem (pole-center → face-midline distance) of the cylinder: a regular N-gon whose edges are
 *  `w` wide with a tangential `gap` fraction of breathing room, floored at `minR` (the bare pole).
 *  N < 3 can't tile, so 1–2 faces just sit at the pole radius (one face, or two back-to-back). */
function cylinderApothem(n, w, gap, minR) {
    if (n < 3) return minR;
    return Math.max(minR, (w * (1 + gap)) / (2 * Math.tan(Math.PI / n)));
}

/** How many panels of width `w` sit abreast around a cylinder of preferred radius `R` — the n that
 *  makes the regular n-gon's apothem land near R. Clamped to [1, cap] (cap = panel count, so a tiny
 *  directory makes a small FULL ring rather than a sparse partial one). */
function facesAround(w, R, cap) {
    if (w <= 0 || cap <= 0) return 0;
    const n = Math.round(Math.PI / Math.atan(w / (2 * Math.max(R, 1e-3))));
    return Math.max(1, Math.min(n, cap));
}

/** Evenly space N child-subtree bodies on a horizontal ring (XZ). Ring radius sized so the chord
 *  between adjacent slots clears the two biggest neighbors. One body → center. */
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

/** Post-order: pack the grids into panels, size the column (panels abreast × stacked down) + the
 *  child ring, cache, report {radius, height}. */
function measure(node, opts) {
    const { files, dirs } = partitionChildren(node);   // deterministic order; markers excluded

    // Pack the grids into panels (real VStack nodes) and hang them off this node. The panels tile
    // the cylinder surface; the apothem reads the target radius, not the panel/file count.
    const panels = packPanels(files, opts);
    for (const p of panels) node.add(p);

    const panelBoxes = panels.map(leafBox);            // each panel already .layout()'d in packPanels
    const faceW = panels.length ? Math.max(...panelBoxes.map((b) => b.max.x - b.min.x)) : 0;
    const nAround = facesAround(faceW, opts.targetRadius, panels.length);
    const apothem = nAround ? cylinderApothem(nAround, faceW, opts.faceGap, opts.hubRadius) : 0;
    // Outer reach = a face corner's distance from the pole (the polygon's circumradius). This is the
    // cylinder's footprint radius and what a parent ring must clear.
    const reach = nAround ? Math.hypot(apothem, faceW / 2) : 0;

    // Column heights: panel i stacks in face (i mod nAround), so each face's height is the summed
    // height (+ gaps) of its panels. The tallest face is the column's height.
    const colH = new Array(nAround).fill(0);
    panelBoxes.forEach((b, i) => {
        const k = i % nAround;
        colH[k] += (colH[k] > 0 ? opts.panelGap : 0) + (b.max.y - b.min.y);
    });
    const maxColH = colH.length ? Math.max(...colH) : 0;

    const childMeasures = dirs.map((d) => measure(d, opts));
    // Ring sized by each child's OWN column REACH (its panels — bounded by the target radius), NOT
    // its full subtree radius. Subtree-radius sizing compounds MULTIPLICATIVELY up the tree (and one
    // big branch flings every sibling out by its radius), exploding to thousands of units. Reach-
    // bounded → the cone grows roughly linearly with depth, and sibling POLES stay clear; deeper
    // descendants are separated by the −Y drop.
    const childRing = ringSlots(childMeasures.map((m) => m.reach), opts.childGap, opts.minRadius);

    const childRingY = -(maxColH + (dirs.length ? opts.drop : 0));   // child columns hang below
    const maxChildH = childMeasures.reduce((m, c) => Math.max(m, c.height), 0);

    const reachOut = Math.max(reach, opts.minRadius);   // this column's reach, for the parent's ring
    const radius = Math.max(reach, childRing.outerRadius, opts.minRadius);
    const height = Math.max(maxColH, dirs.length ? maxColH + opts.drop + maxChildH : 0, opts.minRadius);

    node.userData._jf = { panels, panelBoxes, nAround, apothem, dirs, childRing, childRingY };
    node.userData.size = { x: 2 * radius, y: height, z: 2 * radius };
    return { radius, height, reach: reachOut };
}

/** Pre-order: tile the panels around the column (faces) and down each face, hang child columns
 *  below, recurse. */
function place(node, opts) {
    const jf = node.userData._jf;
    if (!jf) return;
    const { panels, panelBoxes, nAround, apothem, dirs, childRing, childRingY } = jf;

    const colY = new Array(nAround).fill(0);   // cumulative downward offset per face/column
    panels.forEach((panel, i) => {
        const k = i % nAround;
        const theta = (k * 2 * Math.PI) / nAround;       // this face's angle around the pole
        const b = panelBoxes[i];
        const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
        const cos = Math.cos(theta), sin = Math.sin(theta);
        // face: readable side (local +Z) turned to the OUTWARD radial, width (local +X) tangential.
        // rotation.y = π/2 − θ lands +Z on (cosθ,0,sinθ); the panel's content center sits at the
        // apothem; its top hangs at −colY[k] so panels stack DOWN the face. (Proper rotation → text
        // never mirrors.)
        panel.position.set(
            apothem * cos - cx * sin - cz * cos,
            -colY[k] - b.max.y,
            apothem * sin + cx * cos - cz * sin,
        );
        panel.rotation.set(0, Math.PI / 2 - theta, 0);
        colY[k] += (b.max.y - b.min.y) + opts.panelGap;
    });

    dirs.forEach((child, j) => {
        const s = childRing.slots[j];
        child.position.set(s.x, childRingY, s.z);
        child.rotation.set(0, 0, 0);
        place(child, opts);
    });
}

/**
 * Lay out a ContentTree subtree as a reverse cone of cylindrical columns (jellyfish).
 * @param {import('three').Object3D} root the node to lay out (children positioned in its local frame)
 * @param {object} [opts] overrides for JELLYFISH_DEFAULTS — cylinder (targetRadius/hubRadius/
 *   panelGap/faceGap/drop/childGap/minRadius) + panel packing (panelW/panelH/colGap/rowGap)
 * @returns {{w:number,h:number}} the root's footprint (w = diameter, h = column+cone height); the
 *   volumetric extent lives on node.userData.size.
 */
export default function jellyfishLayout(root, opts = {}) {
    const o = { ...JELLYFISH_DEFAULTS, ...opts };
    const { radius, height } = measure(root, o);
    place(root, o);
    return { w: 2 * radius, h: height };
}

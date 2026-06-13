// arrows-check.mjs — headless, GPU-free check for ContentTreeArrows (the ordered-arrow
// overlay that threads each directory's child dirs in canonical order).
//
//   bun tools/arrows-check.mjs
//
// Pure three (Group/Object3D/BufferGeometry) — no WebGPU — so it runs anywhere. Asserts
// the structural invariants: one chain per parent with ≥2 child dirs, segCount = dirs−1,
// 6 verts/segment, chains parented INTO the parent node, isMarker (so schemes ignore
// them), rebuild on relayout/scheme-switch, and the first segment honoring sibling order.

import * as THREE from 'three';
import ContentTree from '../packages/glyph3d-core/src/collections/ContentTree.js';
import { walkTreeLayout, districtLayout, packedLayout } from '../packages/glyph3d-core/src/collections/layouts/index.js';
import { flowBoxes } from '../packages/glyph3d-core/src/collections/layouts/flowBoxes.js';
import { partitionChildren, subtreeContentBounds } from '../packages/glyph3d-core/src/collections/layouts/nodeUtils.js';
import ContentTreeArrows from '../packages/glyph3d-core/src/collections/ContentTreeArrows.js';
import ContentTreeProbes from '../packages/glyph3d-core/src/collections/ContentTreeProbes.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };

const makeLeaf = (path) => {
    const name = path.split('/').filter(Boolean).pop() || path;
    const o = new THREE.Object3D();
    o.userData = { size: { x: 8 + name.length, y: 4, z: 1 } };
    return o;
};

// readme.md keeps root from being all-dirs; src has two child dirs (util, components);
// src/util has one (deep) → no chain there; components/b/bc have zero.
const PATHS = [
    'readme.md',
    'src/index.js',
    'src/util/log.js',
    'src/util/deep/a.txt',
    'src/components/Button.jsx',
    'b/one.js',
    'bc/two.js',
];

const build = (layout = districtLayout) => {
    const t = new ContentTree({ layout });
    for (const p of PATHS) t.insert(makeLeaf(p), p);
    t.relayout();
    return t;
};

const chainFor = (arrows, path) => arrows._chains.get(path);
const childDirCount = (tree, path) => partitionChildren(tree.getNode(path)).dirs.length;

// ───────────────────────── structural invariants ─────────────────────────
{
    const t = build();
    const arrows = new ContentTreeArrows(t);

    // root has 3 child dirs (src, b, bc) → a chain of 2 segments.
    const root = chainFor(arrows, '');
    ok(childDirCount(t, '') === 3, `root should have 3 child dirs, got ${childDirCount(t, '')}`);
    ok(!!root, 'root chain exists (3 child dirs)');
    ok(root && root.mesh.parent === t.root, 'root chain parented INTO the root node');
    ok(root && root.geo.getAttribute('position').count === 2 * 6, 'root chain = 2 segments × 6 verts');
    ok(root && root.mesh.userData.isMarker === true, 'chain mesh carries isMarker (schemes/picking ignore it)');

    // src has 2 child dirs (util, components) → 1 segment.
    const src = chainFor(arrows, 'src');
    ok(childDirCount(t, 'src') === 2, `src should have 2 child dirs, got ${childDirCount(t, 'src')}`);
    ok(src && src.geo.getAttribute('position').count === 1 * 6, 'src chain = 1 segment × 6 verts');

    // src/util has 1 child dir (deep) → no chain. components/b/bc have 0 → none.
    ok(!chainFor(arrows, 'src/util'), 'src/util (1 child dir) gets no chain');
    ok(!chainFor(arrows, 'src/components'), 'src/components (0 child dirs) gets no chain');
    ok(!chainFor(arrows, 'b'), 'b (0 child dirs) gets no chain');

    // Adding arrows must NOT change what the scheme sees as content.
    const dirsBefore = partitionChildren(t.root).dirs.map((d) => d.userData.name);
    ok(JSON.stringify(dirsBefore) === JSON.stringify(['b', 'bc', 'src']),
        `partitionChildren still excludes arrow meshes, got ${JSON.stringify(dirsBefore)}`);

    // First segment's shaft start should sit at the first child dir's anchor (canonical
    // order = dirs-first then name: b, bc, src). Anchor.x = node.position.x.
    const firstDir = partitionChildren(t.root).dirs[0];
    const pos = root.geo.getAttribute('position');
    ok(Math.abs(pos.getX(0) - firstDir.position.x) < 1e-6,
        'first segment starts at the first child dir (canonical order honored)');

    arrows.dispose();
    ok(arrows._chains.size === 0, 'dispose removes all chains');
    ok(t.root.children.every((c) => !c.userData?.isMarker), 'dispose detaches chain meshes from nodes');
}

// ───────────────────── rebuild on relayout / scheme switch ─────────────────────
{
    const t = build(districtLayout);
    const arrows = new ContentTreeArrows(t);
    ok(!!chainFor(arrows, 'src'), 'src chain exists under district');

    // A scheme switch fires onRelayout → arrows rebuild against the new layout.
    t.setLayout(walkTreeLayout);
    t.relayout();
    const src = chainFor(arrows, 'src');
    ok(src && src.mesh.parent === t.getNode('src'), 'src chain re-parented after scheme switch');
    ok(src && src.geo.getAttribute('position').count === 1 * 6, 'src chain still 1 segment after switch');

    // Disable hides; re-enable restores.
    arrows.setEnabled(false);
    ok([...arrows._chains.values()].every((c) => !c.mesh.visible), 'setEnabled(false) hides chains');
    arrows.setEnabled(true);
    ok(chainFor(arrows, 'src').mesh.visible, 'setEnabled(true) restores chains');

    arrows.dispose();
}

// ─────────────────────────── chains follow a drag ───────────────────────────
{
    const t = build(districtLayout);
    const arrows = new ContentTreeArrows(t);
    const src = t.getNode('src');
    const chain = chainFor(arrows, 'src');
    // The chain is parented INTO src, so moving src carries it without any relayout.
    src.position.x += 1234;
    src.updateWorldMatrix(true, false);
    const worldPos = new THREE.Vector3();
    chain.mesh.getWorldPosition(worldPos);
    ok(Math.abs(worldPos.x - src.position.x) < 1e-3, 'chain rides a drag (parented, no relayout needed)');
    arrows.dispose();
}

// ──────────────── serpentine packing: the dir tier snakes, in order ────────────────
{
    // Six equal boxes, wrapWidth fits 3 per row → two rows. Row 0 runs left→right,
    // row 1 mirrors → right→left. Sequence order is preserved in the slots array.
    const boxes = Array.from({ length: 6 }, () => ({ w: 10, h: 10 }));
    const flow = flowBoxes(boxes, { margin: 2, wrapWidth: 36, serpentine: true });
    ok(flow.rows === 2, `serpentine: 6 boxes / width-3 → 2 rows, got ${flow.rows}`);
    // Row 0 (slots 0,1,2): x strictly increasing.
    ok(flow.slots[0].x < flow.slots[1].x && flow.slots[1].x < flow.slots[2].x, 'serpentine row 0 runs left→right');
    // Row 1 (slots 3,4,5): x strictly DECREASING (mirrored).
    ok(flow.slots[3].x > flow.slots[4].x && flow.slots[4].x > flow.slots[5].x, 'serpentine row 1 runs right→left');
    // The turn is local: last of row 0 and first of row 1 share the right edge.
    ok(Math.abs(flow.slots[2].x - flow.slots[3].x) < 1e-6, 'serpentine turn is vertical (no backtrack)');
    // Default (no serpentine) still left-starts every row — existing callers unchanged.
    const plain = flowBoxes(boxes, { margin: 2, wrapWidth: 36 });
    ok(plain.slots[0].x === plain.slots[3].x, 'non-serpentine rows both start at the left margin');
}

// Scheme-level: under packed, a parent's child dirs pack in CANONICAL order and snake
// across rows (no size-sort sinking small early siblings to the bottom).
{
    const t = new ContentTree({ layout: packedLayout });
    for (let i = 0; i < 6; i++) t.insert(makeLeaf(`proj/d${i}/f.js`), `proj/d${i}/f.js`);
    t.relayout();
    const dirs = partitionChildren(t.getNode('proj')).dirs;   // d0..d5 canonical
    ok(dirs.map((d) => d.userData.name).join() === 'd0,d1,d2,d3,d4,d5', 'child dirs in canonical order');
    // Group child dirs by row (their y), then assert each row is monotonic and rows
    // alternate direction — the boustrophedon signature.
    const byRow = new Map();
    dirs.forEach((d, i) => {
        const key = Math.round(d.position.y * 100);
        if (!byRow.has(key)) byRow.set(key, []);
        byRow.get(key).push({ i, x: d.position.x });
    });
    const rows = [...byRow.entries()].sort((a, b) => b[0] - a[0]).map(([, r]) => r);
    ok(rows.length >= 2, `packed dir tier should wrap to ≥2 rows, got ${rows.length}`);
    let snaked = true;
    rows.forEach((r, ri) => {
        // canonical index increases along the sequence; x should be monotonic per row,
        // its direction flipping each row.
        for (let k = 1; k < r.length; k++) {
            const ascending = r[k].x > r[k - 1].x;
            if (ascending !== (ri % 2 === 0)) snaked = false;
        }
    });
    ok(snaked, 'packed child dirs snake (row 0 →, row 1 ←, …) in canonical order');

    // Gravity rake: lower rows (more-negative y) hang further BACK in z (more-negative),
    // never toward the camera. Each row's z is constant; rows step away as they descend.
    const dirByZ = new Map();   // round(y) → z (constant per row)
    dirs.forEach((d) => dirByZ.set(Math.round(d.position.y * 100), d.position.z));
    const rowKeysTopDown = [...dirByZ.keys()].sort((a, b) => b - a);   // highest y first
    let rakedBack = true;
    for (let k = 1; k < rowKeysTopDown.length; k++) {
        if (!(dirByZ.get(rowKeysTopDown[k]) < dirByZ.get(rowKeysTopDown[k - 1]))) rakedBack = false;
    }
    ok(rowKeysTopDown.length >= 2 && rakedBack, 'gravity rake: each lower row hangs further back in −z (curtain leans away)');
}

// ──────── anchors land on the dir's content VOLUME, not the footprint origin ────────
{
    const t = build(districtLayout);
    const dirs = partitionChildren(t.root).dirs;   // b, bc, src
    const src = dirs.find((d) => d.userData.name === 'src');
    const idx = dirs.indexOf(src);                  // src is the `to` of segment idx-1
    const vTo = (idx - 1) * 6 + 1;                  // shaft-end vertex of that segment

    const a = new ContentTreeArrows(t);
    const pos = a._chains.get('').geo.getAttribute('position');
    const to = { x: pos.getX(vTo), y: pos.getY(vTo), z: pos.getZ(vTo) };
    // The endpoint must sit on src's bounded box (carried into the root frame) — on the
    // box you can see, not at a bare floating point.
    const b = subtreeContentBounds(src);
    const eps = 1e-3;
    ok(to.x >= src.position.x + b.min.x - eps && to.x <= src.position.x + b.max.x + eps, 'anchor x within the box');
    ok(Math.abs(to.y - (src.position.y + b.max.y)) < eps, 'anchor y on the box top edge');
    ok(Math.abs(to.z - (src.position.z + b.max.z + a.opts.zLift)) < eps, 'anchor z on the box front face (+zLift)');
    a.dispose();
}

// THE container-dir case: a dir with NO files of its own has content a full depthZ BACK.
// The fix is NOT to chase the content back — it's to give the dir a box that reaches its
// origin, so the origin-front anchor lands ON the box (not floating in the empty bell).
{
    const t = new ContentTree({ layout: packedLayout });
    // app/ holds only sub1/ and sub2/, each itself fileless until a deeper dir with a file.
    t.insert(makeLeaf('app/sub1/deep/a.js'), 'app/sub1/deep/a.js');
    t.insert(makeLeaf('app/sub2/deep/b.js'), 'app/sub2/deep/b.js');
    t.relayout();
    const a = new ContentTreeArrows(t);
    const app = t.getNode('app');
    const subs = partitionChildren(app).dirs;       // sub1, sub2 — both fileless containers
    const pos = a._chains.get('app').geo.getAttribute('position');
    const toZ = pos.getZ(1);                         // segment 0 to-vertex = sub2's anchor
    const sub2 = subs[1];
    const b = subtreeContentBounds(sub2);
    ok(b.min.z < -1, 'fileless container: its box still encloses content a depthZ BACK');
    ok(Math.abs(b.max.z) < 1e-6, 'fileless container: its box reaches the ORIGIN front plane (z=0)');
    ok(Math.abs(toZ - (sub2.position.z + a.opts.zLift)) < 1e-6,
        `anchor lands on the box front at the origin plane (got ${Math.round(toZ)}, origin ${Math.round(sub2.position.z)})`);
    a.dispose();
}

// ──────── diagnostic probes: content dot == the arrow anchor, origin dot at 0 ────────
{
    const t = build(districtLayout);
    const src = partitionChildren(t.root).dirs.find((d) => d.userData.name === 'src');
    const a = new ContentTreeArrows(t);
    const p = new ContentTreeProbes(t);
    const anchor = a._anchor(src);                         // in root (parent) frame
    const probe = p._probes.get('src');
    ok(probe.origin.position.x === 0 && probe.origin.position.y === 0 && probe.origin.position.z === 0,
        'probe origin dot sits at the node origin (0,0,0)');
    // content dot is parented INTO the node, so its local pos + node.position == the arrow anchor.
    ok(Math.abs((src.position.x + probe.content.position.x) - anchor.x) < 1e-6, 'probe content dot x == arrow anchor x');
    ok(Math.abs((src.position.y + probe.content.position.y) - anchor.y) < 1e-6, 'probe content dot y == arrow anchor y');
    ok(Math.abs((src.position.z + probe.content.position.z) - anchor.z) < 1e-6, 'probe content dot z == arrow anchor z');
    p.dispose(); a.dispose();
}

console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

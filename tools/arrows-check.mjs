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
import { partitionChildren } from '../packages/glyph3d-core/src/collections/layouts/nodeUtils.js';
import ContentTreeArrows from '../packages/glyph3d-core/src/collections/ContentTreeArrows.js';

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
}

console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

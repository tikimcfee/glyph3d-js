// arrows-check.mjs — headless, GPU-free check for ContentTreeArrows (the OWNERSHIP-line
// overlay: each directory's hub wired to every file it holds and every child dir's hub)
// plus the layout facts the arrows ride on (serpentine dir tiers, the packed rake).
//
//   bun tools/arrows-check.mjs
//
// Pure three (Group/Object3D/BufferGeometry) — no WebGPU — so it runs anywhere. Asserts
// the structural invariants of the CURRENT ownership model (_links: one LineSegments per
// dir, hub→child verts, parented INTO the node, isMarker), the library-VOLUME exemption
// (a hub→volume wire is a line from the dir to itself — skipped), rebuild-on-relayout,
// and the ride-a-drag property. (The earlier sibling-order arrow CHAINS this file once
// asserted were replaced by ownership lines; the serpentine/rake layout sections remain.)

import * as THREE from 'three';
import ContentTree from '../packages/glyph3d-core/src/collections/ContentTree.js';
import { walkTreeLayout, districtLayout, packedLayout, libraryLayout } from '../packages/glyph3d-core/src/collections/layouts/index.js';
import { flowBoxes } from '../packages/glyph3d-core/src/collections/layouts/flowBoxes.js';
import { partitionChildren } from '../packages/glyph3d-core/src/collections/layouts/nodeUtils.js';
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

// readme.md keeps root from being all-dirs; src holds 1 file + 2 child dirs; b/bc are
// the substring-trap pair.
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

const linkFor = (arrows, path) => arrows._links.get(path);
const vertCount = (link) => link.geo.getAttribute('position').count;

// ───────────────────────── structural invariants ─────────────────────────
{
    const t = build();
    const arrows = new ContentTreeArrows(t);

    // root owns 1 file (readme's book) + 3 child dirs → 4 lines × 2 verts.
    const root = linkFor(arrows, '');
    ok(!!root, 'root link exists');
    ok(root && root.mesh.parent === t.root, 'root link parented INTO the root node');
    ok(root && vertCount(root) === 4 * 2, `root link = 4 lines × 2 verts, got ${root && vertCount(root)}`);
    ok(root && root.mesh.userData.isMarker === true, 'link mesh carries isMarker (schemes/picking ignore it)');

    // src owns 1 file + 2 child dirs → 3 lines. src/util: 1 file + 1 dir → 2 lines.
    ok(vertCount(linkFor(arrows, 'src')) === 3 * 2, 'src link = 3 lines');
    ok(vertCount(linkFor(arrows, 'src/util')) === 2 * 2, 'src/util link = 2 lines');

    // Every line starts at the hub (the dir's own origin).
    const pos = root.geo.getAttribute('position');
    let hubbed = true;
    for (let i = 0; i < vertCount(root); i += 2) {
        if (pos.getX(i) !== 0 || pos.getY(i) !== 0 || pos.getZ(i) !== 0) hubbed = false;
    }
    ok(hubbed, 'every line starts at the hub (dir origin)');

    // Adding arrows must NOT change what the scheme sees as content.
    const dirsAfter = partitionChildren(t.root).dirs.map((d) => d.userData.name);
    ok(JSON.stringify(dirsAfter) === JSON.stringify(['b', 'bc', 'src']),
        `partitionChildren still excludes link meshes, got ${JSON.stringify(dirsAfter)}`);

    arrows.dispose();
    ok(arrows._links.size === 0, 'dispose removes all links');
    ok(t.root.children.every((c) => !c.userData?.isMarker), 'dispose detaches link meshes from nodes');
}

// ──────────── the library VOLUME exemption: no wire from a dir to itself ────────────
{
    const t = new ContentTree({ layout: libraryLayout, layoutOpts: { surface: false, pageW: 20, pageH: 30 } });
    t.insert(makeLeaf('d/a.js'), 'd/a.js');
    t.insert(makeLeaf('d/b.js'), 'd/b.js');
    t.insert(makeLeaf('d/sub/c.js'), 'd/sub/c.js');
    t.relayout();
    const arrows = new ContentTreeArrows(t);
    // d's files ride its VOLUME (one body at the dir's own origin) — no file wire; the
    // one child-dir wire (d → sub) remains, because that ownership is real information.
    const d = linkFor(arrows, 'd');
    ok(!!d && vertCount(d) === 1 * 2, `volume'd dir wires only its child dirs, got ${d && vertCount(d)} verts`);
    // sub's own volume is its whole content → no lines at all.
    ok(!linkFor(arrows, 'd/sub'), "a volume-only dir gets no link mesh");
    arrows.dispose();
}

// ───────────────────── rebuild on relayout / scheme switch ─────────────────────
{
    const t = build(districtLayout);
    const arrows = new ContentTreeArrows(t);
    ok(!!linkFor(arrows, 'src'), 'src link exists under district');

    t.setLayout(walkTreeLayout);
    t.relayout();
    const src = linkFor(arrows, 'src');
    ok(src && src.mesh.parent === t.getNode('src'), 'src link re-parented after scheme switch');
    ok(src && vertCount(src) === 3 * 2, 'src link still 3 lines after switch');

    arrows.setEnabled(false);
    ok([...arrows._links.values()].every((c) => !c.mesh.visible), 'setEnabled(false) hides links');
    arrows.setEnabled(true);
    ok(linkFor(arrows, 'src').mesh.visible, 'setEnabled(true) restores links');

    arrows.dispose();
}

// ─────────────────────────── links follow a drag ───────────────────────────
{
    const t = build(districtLayout);
    const arrows = new ContentTreeArrows(t);
    const src = t.getNode('src');
    const link = linkFor(arrows, 'src');
    // The link is parented INTO src, so moving src carries it without any relayout.
    src.position.x += 1234;
    src.updateWorldMatrix(true, false);
    const worldPos = new THREE.Vector3();
    link.mesh.getWorldPosition(worldPos);
    ok(Math.abs(worldPos.x - src.position.x) < 1e-3, 'link rides a drag (parented, no relayout needed)');
    arrows.dispose();
}

// ──────────────── serpentine packing: the dir tier snakes, in order ────────────────
{
    // Six equal boxes, wrapWidth fits 3 per row → two rows. Row 0 runs left→right,
    // row 1 mirrors → right→left. Sequence order is preserved in the slots array.
    const boxes = Array.from({ length: 6 }, () => ({ w: 10, h: 10 }));
    const flow = flowBoxes(boxes, { margin: 2, wrapWidth: 36, serpentine: true });
    ok(flow.rows === 2, `serpentine: 6 boxes / width-3 → 2 rows, got ${flow.rows}`);
    ok(flow.slots[0].x < flow.slots[1].x && flow.slots[1].x < flow.slots[2].x, 'serpentine row 0 runs left→right');
    ok(flow.slots[3].x > flow.slots[4].x && flow.slots[4].x > flow.slots[5].x, 'serpentine row 1 runs right→left');
    ok(Math.abs(flow.slots[2].x - flow.slots[3].x) < 1e-6, 'serpentine turn is vertical (no backtrack)');
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
        for (let k = 1; k < r.length; k++) {
            const ascending = r[k].x > r[k - 1].x;
            if (ascending !== (ri % 2 === 0)) snaked = false;
        }
    });
    ok(snaked, 'packed child dirs snake (row 0 →, row 1 ←, …) in canonical order');

    // Gravity rake: lower rows (more-negative y) hang further BACK in z, never toward
    // the camera. Each row's z is constant; rows step away as they descend.
    const dirByZ = new Map();
    dirs.forEach((d) => dirByZ.set(Math.round(d.position.y * 100), d.position.z));
    const rowKeysTopDown = [...dirByZ.keys()].sort((a, b) => b - a);
    let rakedBack = true;
    for (let k = 1; k < rowKeysTopDown.length; k++) {
        if (!(dirByZ.get(rowKeysTopDown[k]) < dirByZ.get(rowKeysTopDown[k - 1]))) rakedBack = false;
    }
    ok(rowKeysTopDown.length >= 2 && rakedBack, 'gravity rake: each lower row hangs further back in −z');
}

// ──────── diagnostic probes: origin dot at the hub, content dot inside the box ────────
{
    const t = build(districtLayout);
    const p = new ContentTreeProbes(t);
    p.setEnabled(true);   // diagnostic is off by default — build it to inspect
    const probe = p._probes.get('src');
    ok(!!probe, 'probe exists for src');
    ok(probe && probe.origin.position.x === 0 && probe.origin.position.y === 0 && probe.origin.position.z === 0,
        'probe origin dot sits at the node origin (the hub)');
    p.dispose();
}

console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

// contenttree.test.mjs — headless, GPU-free unit test for the directory recursion in
// ContentTree (the place directory handling always goes wrong: off-by-one descents,
// load-order assumptions, early returns that skip a branch, substring-path collisions).
//
//   bun tools/contenttree.test.mjs
//
// Pure three (Group/Object3D/Box3) — no WebGPU — so it runs anywhere, fast & deterministic.

import * as THREE from 'three';
import ContentTree from '../packages/glyph3d-core/src/collections/ContentTree.js';
import { walkTreeLayout, districtLayout, packedLayout, libraryLayout, PACKED_DEFAULTS, LIBRARY_DEFAULTS } from '../packages/glyph3d-core/src/collections/layouts/index.js';
import ContentTreeMarkers from '../packages/glyph3d-core/src/collections/ContentTreeMarkers.js';
import { collectDirLabels, LABEL_DEFAULTS } from '../packages/glyph3d-core/src/collections/ContentTreeLabels.js';
import { subtreeContentBounds } from '../packages/glyph3d-core/src/collections/layouts/nodeUtils.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}\n      got  ${JSON.stringify(a)}\n      want ${JSON.stringify(b)}`);
const r2 = (n) => Math.round(n * 100) / 100;

// A synthetic leaf, sized DETERMINISTICALLY from its name so two independently-built
// trees (different insert orders) measure identically. insert() preserves userData.size.
const makeLeaf = (path) => {
  const name = path.split('/').filter(Boolean).pop() || path;
  const o = new THREE.Object3D();
  o.userData = { size: { x: 8 + name.length, y: 4, z: 1 } };
  return o;
};

// The gnarly fixture: root-level file, deep empty chain, a dir reused by two files,
// sibling dirs, and the b/bc substring trap.
const PATHS = [
  'readme.md',
  'src/index.js',
  'src/util/log.js',
  'src/util/math.js',                 // reuses src/util
  'src/util/deep/a/b/c/leaf.txt',     // long empty-intermediate chain
  'src/components/Button.jsx',
  'src/components/Modal.jsx',
  'b/one.js',                         // substring trap vs bc
  'bc/two.js',
];

// Structure tests pin the WALK scheme explicitly (they assert walk's invariants);
// the tree's factory default is packed — covered by its own section below.
const build = (paths, order = paths) => {
  const t = new ContentTree({ layout: walkTreeLayout });
  for (const p of order) t.insert(makeLeaf(p), p);
  t.relayout();
  return t;
};

// Serialize the whole tree to a comparable shape: per node (by path) its rounded size,
// its sorted child names, and (for leaves) rounded position. Used for order-independence.
const snapshot = (tree) => {
  const out = {};
  const walk = (node) => {
    // A durable Book records as THE leaf entry — its position is the layout slot, its
    // inner leaf rides at the origin — and its interior is form, not tree structure.
    if (node.userData.isBook) {
      const s = node.leaf.userData.size;
      out[node.userData.path] = {
        isDir: false,
        size: s ? { x: r2(s.x), y: r2(s.y), z: r2(s.z) } : null,
        children: [],
        pos: { x: r2(node.position.x), y: r2(node.position.y), z: r2(node.position.z) },
      };
      return;
    }
    const key = node.userData.path ?? '';
    out[key] = {
      isDir: !!node.userData.isDir,
      size: node.userData.size ? { x: r2(node.userData.size.x), y: r2(node.userData.size.y), z: r2(node.userData.size.z) } : null,
      children: node.children.map((c) => c.userData.name),
      pos: { x: r2(node.position.x), y: r2(node.position.y), z: r2(node.position.z) },
    };
    node.children.forEach(walk);
  };
  walk(tree.root);
  return out;
};

// ───────────────────────────── tests ─────────────────────────────

// 1. create-once: the dir node for src/util is the SAME object both files land under.
{
  const t = new ContentTree();
  const d1 = t.insert(makeLeaf('src/util/log.js'), 'src/util/log.js');
  const d2 = t.insert(makeLeaf('src/util/math.js'), 'src/util/math.js');
  ok(d1 === d2, 'src/util created once and reused across two files');
  ok(t.getNode('src/util') === d1, 'getNode resolves to that same node');
  ok(t.getNode('src').children.includes(t.getNode('src/util')), 'src/util is a child of src');
}

// 2. substring-path trap: b and bc are distinct nodes, each holding its own file.
{
  const t = build(['b/one.js', 'bc/two.js']);
  const b = t.getNode('b'), bc = t.getNode('bc');
  ok(b && bc && b !== bc, 'b and bc are distinct nodes (no substring collision)');
  ok(t.getNode('b').children.some((c) => c.userData.name === 'one.js'), 'b holds one.js');
  ok(t.getNode('bc').children.some((c) => c.userData.name === 'two.js'), 'bc holds two.js');
}

// 3. degenerate single file → parented straight under root.
{
  const t = new ContentTree();
  const leaf = makeLeaf('solo.js');
  const dir = t.insert(leaf, 'solo.js');
  t.relayout();
  ok(dir === t.root, 'lone file parents under root');
  ok(leaf.parent.userData.isBook && leaf.parent.parent === t.root, 'leaf rides its book, book under root');
  ok(t.root.userData.size.x > 0 && t.root.userData.size.y > 0, 'root has a real footprint for one file');
}

// 4. full fixture: every ancestor exists, leaves parented correctly, deep chain intact.
{
  const t = build(PATHS);
  for (const dir of ['src', 'src/util', 'src/util/deep', 'src/util/deep/a', 'src/util/deep/a/b', 'src/util/deep/a/b/c', 'src/components', 'b', 'bc']) {
    ok(t.getNode(dir), `dir node exists: ${dir}`);
  }
  ok(t.getNode('readme.md') === null, 'a file path is NOT a dir node');
  ok(t._leaves.get('readme.md').parent.parent === t.root, 'root-level file (via its book) under root');
  ok(t._leaves.get('src/util/deep/a/b/c/leaf.txt').parent.parent === t.getNode('src/util/deep/a/b/c'), 'deep leaf (via its book) under its (deep) dir');
  // empty-intermediate chain: each link has exactly one child
  for (const dir of ['src/util/deep', 'src/util/deep/a', 'src/util/deep/a/b']) {
    eq(t.getNode(dir).children.length, 1, `single-child empty-intermediate: ${dir}`);
  }
}

// 5. ordering: dirs first then alpha, at root and within a dir.
{
  const t = build(PATHS);
  eq(t.root.children.map((c) => c.userData.name), ['b', 'bc', 'src', 'readme.md'], 'root sorted: dirs (alpha) then files');
  eq(t.getNode('src').children.map((c) => c.userData.name), ['components', 'util', 'index.js'], 'src sorted: dirs then file');
}

// 6. walk sizing: a dir with files has a real footprint that covers its widest file.
{
  const t = build(['x/aa.js', 'x/bbbb.js']);   // file widths 8+name.length → 13, 15
  const x = t.getNode('x');
  ok(x.userData.size.x > 0 && x.userData.size.y > 0, 'dir with files has a real footprint');
  ok(x.userData.size.x >= 15 - 0.01, 'dir footprint covers its widest file');
}

// 7. walk invariants — the optical properties: depth→Z (deeper sits further back), and
//    sibling files in a directory are flow-packed without overlapping.
{
  const t = build(PATHS);
  const wpos = (p) => { const v = new THREE.Vector3(); t._leaves.get(p).getWorldPosition(v); return v; };
  const shallowZ = wpos('readme.md').z;                       // root, depth 0
  const deepZ = wpos('src/util/deep/a/b/c/leaf.txt').z;       // depth 6
  ok(deepZ < shallowZ - 0.01, `depth→Z: deeper file further back (deep ${r2(deepZ)} < shallow ${r2(shallowZ)})`);

  const box = (p) => { const g = t._leaves.get(p); const v = new THREE.Vector3(); g.getWorldPosition(v); const s = g.userData.size; return { x0: v.x - s.x / 2, x1: v.x + s.x / 2, y0: v.y - s.y / 2, y1: v.y + s.y / 2 }; };
  const a = box('src/components/Button.jsx'), b = box('src/components/Modal.jsx');
  const overlap = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  ok(!overlap, 'sibling files in a dir are flow-packed without overlap');
}

// 8. THE BIG ONE — insert-order independence: forward vs reversed insertion → identical tree.
{
  const fwd = build(PATHS, PATHS);
  const rev = build(PATHS, [...PATHS].reverse());
  eq(snapshot(fwd), snapshot(rev), 'tree is identical regardless of insert order');
}

// 9. removal: leaf gone; empty dir KEPT by default (measures ~0); prune drops the chain.
{
  const t = build(['keep/a.js', 'gone/b.js']);
  t.remove('gone/b.js');
  t.relayout();
  ok(!t.has('gone/b.js'), 'removed leaf is gone');
  ok(t.getNode('gone'), 'empty dir node kept by default');
  eq(r2(t.getNode('gone').userData.size.y), 0, 'empty dir measures to zero (siblings close the gap)');

  const t2 = build(['keep/a.js', 'x/y/z/deep.js']);
  t2.remove('x/y/z/deep.js', { prune: true });
  t2.relayout();
  ok(t2.getNode('x') === null && t2.getNode('x/y/z') === null, 'prune drops the now-empty ancestor chain');
  ok(t2.getNode('keep'), 'prune leaves non-empty siblings alone');
}

// 10. replace: re-inserting a path swaps the leaf, count unchanged.
{
  const t = new ContentTree();
  const a = makeLeaf('f.js'), b = makeLeaf('f.js');
  t.insert(a, 'dir/f.js'); t.insert(b, 'dir/f.js');
  eq(t.paths().length, 1, 'replace keeps a single leaf for the path');
  ok(t.getNode('dir').children.length === 1 && t.getNode('dir').children[0].leaf === b, 'latest leaf wins (riding a fresh book)');
}

// 11. world bounds non-empty + encompasses content (for ground anchoring).
{
  const t = build(PATHS);
  const box = t.getWorldBounds();
  ok(!box.isEmpty(), 'getWorldBounds is non-empty with content');
  const size = new THREE.Vector3(); box.getSize(size);
  ok(size.x > 0 && size.y > 0, 'world bounds have real extent');
}

// 12. restAbove: content rests on the fixed floor (bottom at floorY, grows upward).
{
  const t = build(PATHS);
  t.restAbove(0);
  const min = t.getWorldBounds().min;
  ok(Math.abs(r2(min.y) - 0) <= 0.01, `content bottom rests at floor 0 (got ${r2(min.y)})`);
  t.restAbove(50);
  ok(Math.abs(r2(t.getWorldBounds().min.y) - 50) <= 0.01, 'content bottom follows a non-zero floor');
}

// 13. the dynamic repro property: add-then-remove returns to the EXACT pre-add layout.
// This is what makes live load/unload trustworthy — the relayout is stable, not drifting.
{
  const t = build(PATHS);
  const before = snapshot(t);
  t.insert(makeLeaf('new/extra.js'), 'new/extra.js'); t.relayout();
  ok(t.has('new/extra.js'), 'added a file');
  t.remove('new/extra.js', { prune: true }); t.relayout();
  eq(snapshot(t), before, 'add then remove returns to the exact pre-add layout (idempotent)');
}

// ───────────────────────── district scheme ─────────────────────────

const buildDistrict = (paths, order = paths) => {
  const t = new ContentTree({ layout: districtLayout });
  for (const p of order) t.insert(makeLeaf(p), p);
  t.relayout();
  return t;
};

// A node's world-space plot rect (origin = footprint top-center, content below).
const plotRect = (node) => {
  const v = new THREE.Vector3();
  node.getWorldPosition(v);
  const s = node.userData.size;
  return { x0: v.x - s.x / 2, x1: v.x + s.x / 2, y0: v.y - s.y, y1: v.y };
};

// 14. district containment — the scheme's defining property: every child dir's plot
//     sits INSIDE its parent's footprint (nesting IS the hierarchy).
{
  const t = buildDistrict(PATHS);
  const eps = 0.01;
  const inside = (c, p) => c.x0 >= p.x0 - eps && c.x1 <= p.x1 + eps && c.y0 >= p.y0 - eps && c.y1 <= p.y1 + eps;
  // Pass-through chain dirs (layout compression) are unmeasured — walk THROUGH
  // them, carrying the last measured ancestor as the containment parent.
  const walk = (node, plotParent) => {
    for (const child of node.children.filter((c) => c.userData.isDir)) {
      const measured = !child.userData.isPassThrough && child.userData.size?.x > 0;
      if (measured) {
        ok(inside(plotRect(child), plotRect(plotParent)), `district: ${child.userData.path} plot inside ${plotParent.userData.path || '(root)'}`);
      }
      walk(child, measured ? child : plotParent);
    }
  };
  walk(t.root, t.root);
}

// 15. district depth — nesting recedes in Z, one inset step per level (cumulative).
{
  const t = buildDistrict(PATHS);
  const wz = (p) => { const v = new THREE.Vector3(); t._leaves.get(p).getWorldPosition(v); return v.z; };
  ok(wz('src/index.js') < wz('readme.md') - 0.01, 'district: depth-1 file behind root file');
  ok(wz('src/util/deep/a/b/c/leaf.txt') < wz('src/index.js') - 0.01, 'district: deeper nesting further back');
}

// 16. district siblings don't overlap (files AND child plots share one mosaic).
{
  const t = buildDistrict(PATHS);
  const src = t.getNode('src');
  const rects = src.children
    .filter((c) => !c.userData.isDir || c.userData.size?.x > 0)
    .map((c) => {
      if (c.userData.isDir) return plotRect(c);
      const v = new THREE.Vector3(); c.getWorldPosition(v); const s = c.leaf.userData.size; // file child = a Book
      return { x0: v.x - s.x / 2, x1: v.x + s.x / 2, y0: v.y - s.y / 2, y1: v.y + s.y / 2 };
    });
  let overlaps = 0;
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i], b = rects[j];
    if (a.x0 < b.x1 - 0.01 && b.x0 < a.x1 - 0.01 && a.y0 < b.y1 - 0.01 && b.y0 < a.y1 - 0.01) overlaps++;
  }
  eq(overlaps, 0, 'district: src children (files + child plots) pack without overlap');
}

// 17. district order independence — same property as the walk (test 8).
{
  const fwd = buildDistrict(PATHS, PATHS);
  const rev = buildDistrict(PATHS, [...PATHS].reverse());
  eq(snapshot(fwd), snapshot(rev), 'district tree identical regardless of insert order');
}

// 18. scheme switching round-trips — walk → district → walk reproduces each layout
//     exactly (switching lenses is lossless; nothing drifts).
{
  const t = build(PATHS);                  // default walk
  const walkSnap = snapshot(t);
  t.setLayout(districtLayout); t.relayout();
  const districtSnap = snapshot(t);
  ok(JSON.stringify(walkSnap) !== JSON.stringify(districtSnap), 'walk and district are genuinely different layouts');
  t.setLayout(walkTreeLayout); t.relayout();
  eq(snapshot(t), walkSnap, 'switching back to walk reproduces the walk layout exactly');
  t.setLayout(districtLayout); t.relayout();
  eq(snapshot(t), districtSnap, 'switching back to district reproduces the district layout exactly');
}

// ───────────────────────── packed scheme ─────────────────────────

const buildPacked = (paths, order = paths) => {
  const t = new ContentTree({ layout: packedLayout });
  for (const p of order) t.insert(makeLeaf(p), p);
  t.relayout();
  return t;
};

// 19. packed depth topography — THE defining property: a leaf's world z is exactly
//     −(dir depth × depthZ), accumulated through the transform chain. Pin rakeZ:0 to
//     isolate the per-nesting depth step (the gravity row-rake is checked in arrows-check).
{
  const t = new ContentTree({ layout: packedLayout, layoutOpts: { rakeZ: 0 } });
  for (const p of PATHS) t.insert(makeLeaf(p), p);
  t.relayout();
  const dz = PACKED_DEFAULTS.depthZ;
  const wz = (p) => { const v = new THREE.Vector3(); t._leaves.get(p).getWorldPosition(v); return v.z; };
  eq(r2(wz('readme.md')), 0, 'packed: root file at z=0');
  eq(r2(wz('src/index.js')), r2(-1 * dz), 'packed: depth-1 file at −1×depthZ');
  eq(r2(wz('src/util/log.js')), r2(-2 * dz), 'packed: depth-2 file at −2×depthZ');
  // deep/a/b/c is a single-child chain → layout compression collapses it to ONE
  // level: the leaf steps −3 (src → util → the compressed chain), not −6. Dead
  // corridors add no spatial depth.
  eq(r2(wz('src/util/deep/a/b/c/leaf.txt')), r2(-3 * dz), 'packed: chain-compressed deep file at −3×depthZ');
}

// 20. packed containment + sibling non-overlap: child blocks stay inside the parent
//     footprint; a node's file block and child blocks never collide in XY.
{
  const t = buildPacked(PATHS);
  const eps = 0.01;
  const inside = (c, p) => c.x0 >= p.x0 - eps && c.x1 <= p.x1 + eps && c.y0 >= p.y0 - eps && c.y1 <= p.y1 + eps;
  const checkNode = (node) => {
    const dirs = node.children.filter((c) => c.userData.isDir && c.userData.size?.x > 0);
    for (const child of dirs) {
      ok(inside(plotRect(child), plotRect(node)), `packed: ${child.userData.path} block inside ${node.userData.path || '(root)'}`);
      checkNode(child);
    }
    // dir blocks don't collide with each other (files are at a different z anyway,
    // but blocks share the parent's sheet).
    for (let i = 0; i < dirs.length; i++) for (let j = i + 1; j < dirs.length; j++) {
      const a = plotRect(dirs[i]), b = plotRect(dirs[j]);
      ok(!(a.x0 < b.x1 - eps && b.x0 < a.x1 - eps && a.y0 < b.y1 - eps && b.y0 < a.y1 - eps),
        `packed: sibling blocks ${dirs[i].userData.path} / ${dirs[j].userData.path} don't overlap`);
    }
  };
  checkNode(t.root);
}

// 21. packed file packing: siblings in one dir don't overlap (height-sorted shelves).
{
  const t = buildPacked(PATHS);
  const box = (p) => { const g = t._leaves.get(p); const v = new THREE.Vector3(); g.getWorldPosition(v); const s = g.userData.size; return { x0: v.x - s.x / 2, x1: v.x + s.x / 2, y0: v.y - s.y / 2, y1: v.y + s.y / 2 }; };
  const a = box('src/components/Button.jsx'), b = box('src/components/Modal.jsx');
  ok(!(a.x0 < b.x1 - 0.01 && b.x0 < a.x1 - 0.01 && a.y0 < b.y1 - 0.01 && b.y0 < a.y1 - 0.01),
    'packed: sibling files shelf-pack without overlap');
}

// 21b. packed reads like a tree: a node's OWN files sit ABOVE its child-dir blocks
//      (root files at the visual top; depth cascades down/backward).
{
  const t = buildPacked(PATHS);
  const v = new THREE.Vector3();
  const rootFileBottoms = [...t._leaves.entries()]
    .filter(([p]) => !p.includes('/'))
    .map(([, leaf]) => { leaf.getWorldPosition(v); return v.y - leaf.userData.size.y / 2; });
  const depth1Tops = t.root.children
    .filter((c) => c.userData.isDir && c.userData.size?.x > 0)
    .map((d) => { d.getWorldPosition(v); return v.y; });   // dir origin = footprint TOP-center
  ok(Math.min(...rootFileBottoms) >= Math.max(...depth1Tops) - 0.01,
    'packed: root files sit above every depth-1 dir block');
}

// 22. packed order independence (the height-sort is stable, so this must hold).
{
  const fwd = buildPacked(PATHS, PATHS);
  const rev = buildPacked(PATHS, [...PATHS].reverse());
  eq(snapshot(fwd), snapshot(rev), 'packed tree identical regardless of insert order');
}

// 23. three-way scheme switching is lossless (walk → district → packed → walk …).
{
  const t = build(PATHS);                  // default walk
  const walkSnap = snapshot(t);
  t.setLayout(packedLayout); t.relayout();
  const packedSnap = snapshot(t);
  ok(JSON.stringify(packedSnap) !== JSON.stringify(walkSnap), 'packed and walk are genuinely different layouts');
  t.setLayout(districtLayout); t.relayout();
  t.setLayout(packedLayout); t.relayout();
  eq(snapshot(t), packedSnap, 'returning to packed reproduces the packed layout exactly');
  t.setLayout(walkTreeLayout); t.relayout();
  eq(snapshot(t), walkSnap, 'returning to walk reproduces the walk layout exactly');
}

// ───────────────────────── bounding prisms ─────────────────────────

// Content-only snapshot: leaf + dir world positions, ignoring marker meshes.
const contentSnapshot = (tree) => {
  const out = {};
  const v = new THREE.Vector3();
  for (const [p, leaf] of tree._leaves) { leaf.getWorldPosition(v); out[p] = { x: r2(v.x), y: r2(v.y), z: r2(v.z) }; }
  for (const [p, node] of tree._dirs) { if (!p) continue; node.getWorldPosition(v); out[`dir:${p}`] = { x: r2(v.x), y: r2(v.y), z: r2(v.z) }; }
  return out;
};

// 24. markers do NOT perturb layout — the scheme must ignore marker children entirely.
{
  const plain = buildPacked(PATHS);
  const marked = buildPacked(PATHS);
  const markers = new ContentTreeMarkers(marked);
  marked.relayout();   // relayout WITH prisms parented inside the dir nodes
  eq(contentSnapshot(marked), contentSnapshot(plain), 'layout identical with and without markers');
  ok(markers._prisms.size > 0, 'markers actually built prisms for that test to mean anything');
}

// 25. every non-empty dir gets a prism, parented INTO its node; the root gets none.
{
  const t = buildPacked(PATHS);
  const markers = new ContentTreeMarkers(t);
  for (const dir of ['src', 'src/util', 'src/util/deep/a/b/c', 'b', 'bc']) {
    const prism = markers._prisms.get(dir);
    ok(prism && prism.mesh.parent === t.getNode(dir), `prism exists and is parented in ${dir}`);
  }
  ok(![...t.root.children].some((c) => c.userData.isMarker), 'no prism directly on the root');
}

// 26. containment: each prism's world box encloses every leaf in its subtree.
{
  const t = buildPacked(PATHS);
  const markers = new ContentTreeMarkers(t);
  t.root.updateMatrixWorld(true);
  const eps = 0.01;
  for (const [dir, { mesh }] of markers._prisms) {
    const c = new THREE.Vector3(); mesh.getWorldPosition(c);
    const s = mesh.scale; // unit box scaled, unrotated → world box = center ± scale/2
    const pb = { x0: c.x - s.x / 2, x1: c.x + s.x / 2, y0: c.y - s.y / 2, y1: c.y + s.y / 2, z0: c.z - s.z / 2, z1: c.z + s.z / 2 };
    for (const [p, leaf] of t._leaves) {
      if (p !== dir && !p.startsWith(dir + '/')) continue;
      const v = new THREE.Vector3(); leaf.getWorldPosition(v);
      const sz = leaf.userData.size;
      ok(v.x - sz.x / 2 >= pb.x0 - eps && v.x + sz.x / 2 <= pb.x1 + eps
        && v.y - sz.y / 2 >= pb.y0 - eps && v.y + sz.y / 2 <= pb.y1 + eps
        && v.z >= pb.z0 - eps && v.z <= pb.z1 + eps,
        `prism ${dir} encloses ${p}`);
    }
  }
}

// 27. depth gradient: shallow and deep prisms get different colors; same-depth match.
{
  const t = buildPacked(PATHS);
  const markers = new ContentTreeMarkers(t);
  const hex = (d) => markers._prisms.get(d).mesh.material.color.getHexString();
  ok(hex('src') !== hex('src/util/deep/a/b/c'), 'gradient: depth-1 and depth-6 colors differ');
  eq(hex('b'), hex('bc'), 'gradient: same-depth dirs share a color');
}

// 28. removal + prune still works with prisms attached (markers are not content),
//     and the pruned dir's prism is dropped + the survivors stay correct.
{
  const t = buildPacked(['keep/a.js', 'x/y/z/deep.js']);
  const markers = new ContentTreeMarkers(t);
  ok(markers._prisms.has('x/y/z'), 'prism existed on the doomed chain');
  t.remove('x/y/z/deep.js', { prune: true });
  t.relayout();
  ok(t.getNode('x') === null, 'prune drops the empty chain despite prism children');
  ok(!markers._prisms.has('x/y/z') && !markers._prisms.has('x'), 'pruned dirs lost their prisms');
  ok(markers._prisms.has('keep'), 'surviving dir keeps its prism');
}

// 29. disabled markers hide; re-enabling rebuilds against the CURRENT layout.
{
  const t = buildPacked(PATHS);
  const markers = new ContentTreeMarkers(t);
  markers.setEnabled(false);
  ok([...markers._prisms.values()].every((p) => !p.mesh.visible), 'off → all prisms hidden');
  t.insert(makeLeaf('src/new.js'), 'src/new.js'); t.relayout();
  markers.setEnabled(true);
  ok([...markers._prisms.values()].every((p) => p.mesh.visible), 'on → prisms visible again');
}

// 30. canonical absolute keys: a leading slash is PRESERVED through every seam —
//     userData.path byte-matches the registry's canonical id space (relay mode).
{
  const t = buildPacked([]);
  const leaf = makeLeaf('/home/u/proj/src/a.js');
  t.insert(leaf, '/home/u/proj/src/a.js');
  eq(leaf.userData.path, '/home/u/proj/src/a.js', 'canonical: leaf userData.path keeps the leading slash');
  ok(t.has('/home/u/proj/src/a.js'), 'canonical: has() by canonical key');
  const dir = t.getNode('/home/u/proj/src');
  ok(dir !== null && dir.userData.path === '/home/u/proj/src', 'canonical: dir chain keys carry the slash');
  eq(t.parentOf(leaf), dir, 'canonical: parentOf resolves through the slashed key space');
  // The chain tops out at the content root, exactly like relative keys.
  const top = t.getNode('/home');
  ok(top !== null && t.parentOf(top) === t.root, 'canonical: top-level absolute dir parents to the root');
  // Idempotent re-listing: normalized lookups tolerate duplicate slashes.
  ok(t.getNode('//home/u//proj/src') === dir, 'canonical: lookup normalizes duplicate slashes, prefix intact');
}

// 31. absolute and repo-relative keys coexist without collision ('/src' vs 'src').
{
  const t = buildPacked(['src/rel.js']);
  t.insert(makeLeaf('/src/abs.js'), '/src/abs.js');
  ok(t.getNode('src') !== null && t.getNode('/src') !== null, 'coexist: both key spaces materialize');
  ok(t.getNode('src') !== t.getNode('/src'), 'coexist: they are DIFFERENT nodes (no collision)');
  t.remove('/src/abs.js', { prune: true });
  ok(t.getNode('/src') === null, 'coexist: pruning the absolute chain leaves the relative one');
  ok(t.getNode('src') !== null, 'coexist: relative chain untouched');
}

// 32. chain compression (layout-level): a canonical-absolute load's dead ancestor
//     chain collapses — intermediates zero out and flag isPassThrough, the tail
//     carries the joined displayName, and NOTHING structural changes (paths,
//     parentOf, getNode all still canonical).
{
  const t = buildPacked([]);
  t.insert(makeLeaf('/home/u/dev/proj/a.js'), '/home/u/dev/proj/a.js');
  t.insert(makeLeaf('/home/u/dev/proj/src/b.js'), '/home/u/dev/proj/src/b.js');
  t.relayout();
  const head = t.getNode('/home');
  const mid = t.getNode('/home/u/dev');
  const tail = t.getNode('/home/u/dev/proj');
  ok(head.userData.isPassThrough && mid.userData.isPassThrough, 'compress: chain intermediates flagged pass-through');
  ok(!tail.userData.isPassThrough, 'compress: the tail (first dir with real content) is NOT a pass-through');
  eq(tail.userData.displayName, 'home/u/dev/proj', 'compress: tail displayName = the joined chain');
  ok(head.position.x === 0 && head.position.y === 0 && head.position.z === 0, 'compress: head transform zeroed');
  ok(mid.position.x === 0 && mid.position.y === 0 && mid.position.z === 0, 'compress: intermediate transform zeroed');
  // Structure untouched: canonical navigation still walks the real chain.
  eq(t.parentOf(tail), t.getNode('/home/u/dev'), 'compress: parentOf still canonical');
  // src (a real subdir with content) is laid out — it got a size from the scheme.
  ok(t.getNode('/home/u/dev/proj/src').userData.size != null, 'compress: content subdir still laid out');
}

// 33. compression self-heals when a chain breaks: inserting a file into an
//     intermediate un-flags it on the next relayout.
{
  const t = buildPacked([]);
  t.insert(makeLeaf('/home/u/proj/a.js'), '/home/u/proj/a.js');
  t.relayout();
  ok(t.getNode('/home/u').userData.isPassThrough, 'self-heal precondition: /home/u is pass-through');
  t.insert(makeLeaf('/home/u/notes.md'), '/home/u/notes.md');
  t.relayout();
  ok(!t.getNode('/home/u').userData.isPassThrough, 'self-heal: /home/u un-flagged once it holds a file');
  // The label rides the TAIL: /home stays a pass-through, /home/u is the new tail.
  eq(t.getNode('/home/u').userData.displayName, 'home/u', 'self-heal: the shorter chain re-labels its new tail');
  ok(t.getNode('/home').userData.isPassThrough, 'self-heal: /home remains the (shorter) chain\'s pass-through');
}

// 34. pass-through dirs draw no prism (they'd stack N identical boxes on the tail's).
{
  const t = buildPacked([]);
  t.insert(makeLeaf('/home/u/proj/a.js'), '/home/u/proj/a.js');
  const markers = new ContentTreeMarkers(t);
  t.relayout();
  markers.update();
  ok(!markers._prisms.has('/home') && !markers._prisms.has('/home/u'), 'markers: pass-throughs skipped');
  ok(markers._prisms.has('/home/u/proj'), 'markers: the tail keeps its prism');
}

// ───────────────────────── library scheme ─────────────────────────

// surface:false keeps the test scene pure (no page-face meshes) — a book node then
// holds exactly its one grid, which the structural assertions below rely on.
const buildLibrary = (paths, opts = {}, order = paths) => {
  const t = new ContentTree({ layout: libraryLayout, layoutOpts: { surface: false, ...opts } });
  for (const p of order) t.insert(makeLeaf(p), p);
  t.relayout();
  return t;
};

// 35. books: every leaf rides its durable Book (the same object bookAt addresses),
//     fitted by the exact UNIFORM contain-fit (never a skew, capped at maxUpscale);
//     the grid's own transform authority untouched.
{
  const opts = { pageW: 20, pageH: 30, maxUpscale: 10 };   // small page so the width term binds on mock leaves
  const t = buildLibrary(PATHS, opts);
  for (const [p, leaf] of t._leaves) {
    const book = leaf.parent;
    ok(book.userData?.isBook && t.bookAt(p) === book, `library: ${p} rides its addressable book`);
    ok(book.fitted, `library: ${p} book holds page form under the library scheme`);
    ok(book.scale.x === book.scale.y && book.scale.y === book.scale.z, `library: ${p} book scale is uniform (no skew)`);
    eq([leaf.scale.x, leaf.scale.y, leaf.scale.z], [1, 1, 1], `library: ${p} grid's own scale untouched`);
    const sz = leaf.userData.size;
    eq(r2(book.scale.x), r2(Math.min(opts.pageW / sz.x, opts.pageH / sz.y, opts.maxUpscale)),
      `library: ${p} book carries the exact contain-fit`);
  }
}

// 36. the deck (stack 'z', the default): a directory's books are CO-LOCATED — same x,y,
//     page-centered — and step back exactly one gap each, front book at z=0, name order.
{
  const t = buildLibrary(PATHS);
  const { pageH, gap } = LIBRARY_DEFAULTS;
  const bookOf = (p) => t._leaves.get(p).parent;
  const button = bookOf('src/components/Button.jsx'), modal = bookOf('src/components/Modal.jsx');
  eq([button.position.x, button.position.y], [0, -pageH / 2], 'library: deck book sits page-centered under the stack origin');
  eq([button.position.x, button.position.y], [modal.position.x, modal.position.y], 'library: deck books co-located in x,y');
  eq(r2(button.position.z), 0, 'library: first book (by name) fronts the deck at z=0');
  eq(r2(modal.position.z), r2(-gap), 'library: next book exactly one gap back');
}

// 37. sort orders are real questions: size (content area, big first) and ext (genre)
//     reorder the same deck; reverse flips it.
{
  const paths = ['lib/aa.js', 'lib/zzzzzzzz.js', 'lib/b.css'];   // name↑ aa<b<z · width: zzz > b.css > aa
  const z = (t, p) => r2(t._leaves.get(p).parent.position.z);
  const byNameT = buildLibrary(paths);
  ok(z(byNameT, 'lib/aa.js') > z(byNameT, 'lib/b.css') && z(byNameT, 'lib/b.css') > z(byNameT, 'lib/zzzzzzzz.js'),
    'library: name sort decks aa → b.css → zzz front-to-back');
  const bySize = buildLibrary(paths, { sort: 'size' });
  eq(z(bySize, 'lib/zzzzzzzz.js'), 0, 'library: size sort fronts the biggest book');
  const byExt = buildLibrary(paths, { sort: 'ext' });
  eq(z(byExt, 'lib/b.css'), 0, 'library: ext sort shelves css before js');
  const reversed = buildLibrary(paths, { reverse: true });
  eq(z(reversed, 'lib/zzzzzzzz.js'), 0, 'library: reverse flips the name deck (zzz now fronts)');
}

// 38. stack axes: 'x' shelves books abreast (full page + gap steps), 'y' piles them
//     descending; footprints report the pure page arithmetic (the deck's depth is honest z).
{
  const opts = { pageW: 20, pageH: 30, gap: 5 };
  const deck = buildLibrary(['solo/a.js', 'solo/b.js', 'solo/c.js'], opts);
  eq(deck.getNode('solo').userData.size, { x: 20, y: 30, z: 10 }, 'library: deck footprint = one page, (n−1)·gap deep');

  const shelf = buildLibrary(['solo/a.js', 'solo/b.js', 'solo/c.js'], { ...opts, stack: 'x' });
  eq(shelf.getNode('solo').userData.size, { x: 70, y: 30, z: 0 }, 'library: shelf footprint = n pages + gaps wide');
  const sx = ['solo/a.js', 'solo/b.js', 'solo/c.js'].map((p) => r2(shelf._leaves.get(p).parent.position.x));
  eq(sx, [-25, 0, 25], 'library: shelf books step one page+gap apart, centered');

  const pile = buildLibrary(['solo/a.js', 'solo/b.js'], { ...opts, stack: 'y' });
  eq(pile.getNode('solo').userData.size, { x: 20, y: 65, z: 0 }, 'library: pile footprint = n pages + gaps tall');
  const py = ['solo/a.js', 'solo/b.js'].map((p) => r2(pile._leaves.get(p).parent.position.y));
  eq(py, [-15, -50], 'library: pile books descend one page+gap apart');
}

// 39. child collections sit BELOW the parent's stack and one depthZ step back —
//     the same depth-is-hierarchy reading as packed.
{
  const t = buildLibrary(['top.js', 'sub/inner.js'], { pageW: 20, pageH: 30, depthZ: 100, dirGap: 8 });
  const wp = (p) => { const v = new THREE.Vector3(); t._leaves.get(p).getWorldPosition(v); return v; };
  eq(r2(wp('top.js').z), 0, 'library: root book fronts at z=0');
  eq(r2(wp('sub/inner.js').z), -100, 'library: child collection exactly one depthZ back');
  ok(t.getNode('sub').position.y <= -(30 + 8) + 0.01, 'library: child collection hangs below the parent stack');
}

// 40. switching lenses is lossless AND books are durable: walk → library → walk
//     reproduces the walk layout exactly — the SAME book objects persist, released
//     back to natural form (no page, no scale), never dissolved or recreated.
{
  const t = build(PATHS);                  // walk
  const walkSnap = snapshot(t);
  const bookIds = new Map(t.paths().map((p) => [p, t.bookAt(p)]));
  ok([...bookIds.values()].every((bk) => bk && !bk.fitted), 'books exist (released) under walk already');
  t.setLayout(libraryLayout, { surface: false }); t.relayout();
  ok(t.paths().every((p) => t.bookAt(p) === bookIds.get(p)), 'library: fit re-uses the SAME durable books');
  ok(t.books().every((bk) => bk.fitted), 'library: every book holds page form while active');
  t.setLayout(walkTreeLayout, {}); t.relayout();
  eq(snapshot(t), walkSnap, 'library: switching back to walk reproduces the walk layout exactly');
  ok(t.paths().every((p) => t.bookAt(p) === bookIds.get(p)), 'books survive the switch with identity intact');
  ok(t.books().every((bk) => !bk.fitted && bk.scale.x === 1 && bk.parent.userData.isDir),
    'books released to natural form, back under their dir nodes');
  ok([...t._leaves.values()].every((l) => l.scale.x === 1 && l.scale.y === 1 && l.scale.z === 1),
    'no fit scale leaked onto any grid');
}

// 41. order independence — the same library regardless of insert order (the sort is
//     the spatial truth, not arrival time).
{
  // contentSnapshot keys ride _leaves' INSERTION order — canonicalize before comparing,
  // so this asserts positions (the spatial truth), not map arrival order.
  const canon = (snap) => Object.fromEntries(Object.entries(snap).sort(([a], [b]) => a.localeCompare(b)));
  const fwd = buildLibrary(PATHS);
  const rev = buildLibrary(PATHS, {}, [...PATHS].reverse());
  eq(canon(contentSnapshot(fwd)), canon(contentSnapshot(rev)), 'library: identical regardless of insert order');
}

// 42. the Book as a first-class Measurable: fitted world bounds ARE the page (the bound
//     form, what markers/framing see), and getWorldBounds unions pages so a fitted
//     field rests on the floor by its books, not its loose text.
{
  const t = buildLibrary(['solo/a.js'], { pageW: 20, pageH: 30 });
  const bk = t.bookAt('solo/a.js');
  const size = new THREE.Vector3();
  bk.getBounds().getSize(size);
  eq([r2(size.x), r2(size.y)], [20, 30], 'fitted book world bounds = the exact page');
  t.restAbove(0);
  ok(Math.abs(r2(t.getWorldBounds().min.y)) <= 0.01, 'fitted field rests on the floor by its pages');
  bk.release();
  bk.getBounds().getSize(size);
  ok(size.x < 20 - 0.01, 'released book bounds shrink back to the content');
  eq(bk.fitInfo, null, 'released book reports no fit');
}

// ───────────────────────── container labels ─────────────────────────

const LM = { rowH: 4, charW: 2 };   // mock cell metrics (world units at scale 1)

// 43. collectDirLabels — the chain-compression displayName finally has its consumer:
//     pass-throughs yield NO label, the tail labels itself with the JOINED chain name,
//     real subdirs label with their own name, and counts are recursive file totals.
{
  const t = buildPacked([]);
  t.insert(makeLeaf('/home/u/dev/proj/a.js'), '/home/u/dev/proj/a.js');
  t.insert(makeLeaf('/home/u/dev/proj/src/b.js'), '/home/u/dev/proj/src/b.js');
  t.relayout();
  const items = collectDirLabels(t, {}, LM);
  const byPath = new Map(items.map((i) => [i.path, i]));
  ok(!byPath.has('/home') && !byPath.has('/home/u') && !byPath.has('/home/u/dev'), 'labels: pass-throughs get no label');
  eq(byPath.get('/home/u/dev/proj')?.text, 'home/u/dev/proj', 'labels: the tail speaks the joined chain');
  eq(byPath.get('/home/u/dev/proj')?.countText, '2 files', 'labels: the stat line counts recursively');
  eq(byPath.get('/home/u/dev/proj/src')?.text, 'src', 'labels: a content subdir speaks its own name');
  eq(byPath.get('/home/u/dev/proj/src')?.countText, '1 file', 'labels: the stat line speaks singular');
  eq(items.length, 2, 'labels: exactly the visible containers are labeled');
}

// 44. physical LOD is the container FIT: glyph scale makes the text span `fit` of the
//     container's width (clamped to [scaleMin, scaleMax]); visible depth survives the
//     compressed chain (tail = 1, subdir = 2); showCount 0 drops the suffix.
{
  const t = buildPacked([]);
  t.insert(makeLeaf('/home/u/dev/proj/a.js'), '/home/u/dev/proj/a.js');
  t.insert(makeLeaf('/home/u/dev/proj/src/b.js'), '/home/u/dev/proj/src/b.js');
  t.relayout();
  const items = collectDirLabels(t, { showCount: 0 }, LM);
  const byPath = new Map(items.map((i) => [i.path, i]));
  eq(byPath.get('/home/u/dev/proj')?.depth, 1, 'labels: compressed tail is VISIBLE depth 1');
  eq(byPath.get('/home/u/dev/proj/src')?.depth, 2, 'labels: its subdir is visible depth 2');
  const src = byPath.get('/home/u/dev/proj/src');
  const w = subtreeContentBounds(t.getNode('/home/u/dev/proj/src'));
  const expected = Math.min(Math.max(LABEL_DEFAULTS.fit * (w.max.x - w.min.x) / ([...src.text].length * LM.charW), LABEL_DEFAULTS.scaleMin), LABEL_DEFAULTS.scaleMax);
  eq(r2(src.scale), r2(expected), 'labels: scale = clamp(fit × containerW / textW)');
  eq(byPath.get('/home/u/dev/proj')?.countText, null, 'labels: showCount 0 drops the stat line');
  // The clamps bind at the extremes: a vanishing fit floors at scaleMin, a huge one caps at scaleMax.
  ok(collectDirLabels(t, { fit: 1e-6 }, LM).every((i) => i.scale === LABEL_DEFAULTS.scaleMin), 'labels: tiny fit floors at scaleMin');
  ok(collectDirLabels(t, { fit: 1e6 }, LM).every((i) => i.scale === LABEL_DEFAULTS.scaleMax), 'labels: huge fit caps at scaleMax');
}

// 45. placement: a label sits ABOVE its container's content (root-local frame), at the
//     container's left edge — and an empty tree yields no labels at all.
{
  const t = build(['d/a.js', 'd/b.js']);
  const items = collectDirLabels(t, {}, LM);
  eq(items.length, 1, 'labels: one container, one label');
  const top = t.getLocalBounds().max.y;
  ok(items[0].y > top - 0.01, `labels: label rides above the container top (y=${r2(items[0].y)} vs top=${r2(top)})`);
  ok(collectDirLabels(new ContentTree(), {}, LM).length === 0, 'labels: empty tree, silent field');
}

console.log(`\ncontenttree: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

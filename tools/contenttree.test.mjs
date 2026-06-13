// contenttree.test.mjs — headless, GPU-free unit test for the directory recursion in
// ContentTree (the place directory handling always goes wrong: off-by-one descents,
// load-order assumptions, early returns that skip a branch, substring-path collisions).
//
//   bun tools/contenttree.test.mjs
//
// Pure three (Group/Object3D/Box3) — no WebGPU — so it runs anywhere, fast & deterministic.

import * as THREE from 'three';
import ContentTree from '../packages/glyph3d-core/src/collections/ContentTree.js';
import { walkTreeLayout, districtLayout, packedLayout, PACKED_DEFAULTS } from '../packages/glyph3d-core/src/collections/layouts/index.js';
import ContentTreeMarkers from '../packages/glyph3d-core/src/collections/ContentTreeMarkers.js';

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
  ok(leaf.parent === t.root, 'leaf.parent is root');
  ok(t.root.userData.size.x > 0 && t.root.userData.size.y > 0, 'root has a real footprint for one file');
}

// 4. full fixture: every ancestor exists, leaves parented correctly, deep chain intact.
{
  const t = build(PATHS);
  for (const dir of ['src', 'src/util', 'src/util/deep', 'src/util/deep/a', 'src/util/deep/a/b', 'src/util/deep/a/b/c', 'src/components', 'b', 'bc']) {
    ok(t.getNode(dir), `dir node exists: ${dir}`);
  }
  ok(t.getNode('readme.md') === null, 'a file path is NOT a dir node');
  ok(t._leaves.get('readme.md').parent === t.root, 'root-level file under root');
  ok(t._leaves.get('src/util/deep/a/b/c/leaf.txt').parent === t.getNode('src/util/deep/a/b/c'), 'deep leaf under its (deep) dir');
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
  ok(t.getNode('dir').children.length === 1 && t.getNode('dir').children[0] === b, 'latest leaf wins');
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
  const walk = (node) => {
    for (const child of node.children.filter((c) => c.userData.isDir)) {
      if (child.userData.size.x > 0) {  // empty plots have no extent to contain
        ok(inside(plotRect(child), plotRect(node)), `district: ${child.userData.path} plot inside ${node.userData.path || '(root)'}`);
      }
      walk(child);
    }
  };
  walk(t.root);
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
    .filter((c) => !c.userData.isDir || c.userData.size.x > 0)
    .map((c) => {
      if (c.userData.isDir) return plotRect(c);
      const v = new THREE.Vector3(); c.getWorldPosition(v); const s = c.userData.size;
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
  eq(r2(wz('src/util/deep/a/b/c/leaf.txt')), r2(-6 * dz), 'packed: depth-6 file at −6×depthZ');
}

// 20. packed containment + sibling non-overlap: child blocks stay inside the parent
//     footprint; a node's file block and child blocks never collide in XY.
{
  const t = buildPacked(PATHS);
  const eps = 0.01;
  const inside = (c, p) => c.x0 >= p.x0 - eps && c.x1 <= p.x1 + eps && c.y0 >= p.y0 - eps && c.y1 <= p.y1 + eps;
  const checkNode = (node) => {
    const dirs = node.children.filter((c) => c.userData.isDir && c.userData.size.x > 0);
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
    .filter((c) => c.userData.isDir && c.userData.size.x > 0)
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

console.log(`\ncontenttree: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

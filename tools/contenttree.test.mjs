// contenttree.test.mjs — headless, GPU-free unit test for the directory recursion in
// ContentTree (the place directory handling always goes wrong: off-by-one descents,
// load-order assumptions, early returns that skip a branch, substring-path collisions).
//
//   bun tools/contenttree.test.mjs
//
// Pure three (Group/Object3D/Box3) — no WebGPU — so it runs anywhere, fast & deterministic.

import * as THREE from 'three';
import ContentTree from '../packages/glyph3d-core/src/collections/ContentTree.js';

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

const build = (paths, order = paths) => {
  const t = new ContentTree();
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
  ok(r2(t.root.userData.size.x) === r2(8 + 'solo.js'.length + 4 * 2), 'root size = leaf width + padding'); // pad=4 each side
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

// 6. size propagation: a leaf dir's size = widest child + pad*2, sum heights + gaps + pad*2.
{
  const t = build(['x/aa.js', 'x/bbbb.js']);   // names len 5 ('aa.js') and 7 ('bbbb.js') → widths 13,15; heights 4,4
  const x = t.getNode('x');
  const gap = 6, pad = 4;
  eq(r2(x.userData.size.x), r2(15 + pad * 2), 'dir width = widest child + pad');
  eq(r2(x.userData.size.y), r2(4 + 4 + gap + pad * 2), 'dir height = sum heights + gap + pad');
}

// 7. placement: siblings stack descending in -Y with no overlap (gap respected).
{
  const t = build(['x/aa.js', 'x/bb.js', 'x/cc.js']);
  const kids = t.getNode('x').children; // sorted
  for (let i = 0; i + 1 < kids.length; i++) {
    const top = kids[i], bot = kids[i + 1];
    ok(top.position.y > bot.position.y, `sibling ${i} sits above ${i + 1}`);
    const topBottomEdge = top.position.y - top.userData.size.y / 2;
    const botTopEdge = bot.position.y + bot.userData.size.y / 2;
    ok(r2(topBottomEdge - botTopEdge) >= r2(t.gap) - 0.01, `gap respected between ${i} and ${i + 1} (no overlap)`);
  }
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

console.log(`\ncontenttree: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

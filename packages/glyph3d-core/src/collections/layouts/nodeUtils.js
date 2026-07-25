/**
 * nodeUtils — the tree-node helpers every ContentTree layout scheme shares.
 * Pure: ContentTree nodes (THREE.Group, children split by userData.isDir) in,
 * ordering/sizing facts out. No side effects.
 */

import * as THREE from 'three';

/** Directories first, then case-insensitive name — the deterministic sibling order.
 *  Marker meshes (bounding prisms etc.) sort last, out of the content's way. */
export function childSort(a, b) {
    const am = !!a.userData.isMarker, bm = !!b.userData.isMarker;
    if (am !== bm) return am ? 1 : -1;
    const ad = !!a.userData.isDir, bd = !!b.userData.isDir;
    if (ad !== bd) return ad ? -1 : 1;
    return String(a.userData.name).localeCompare(String(b.userData.name), undefined, { sensitivity: 'base' });
}

/** Sort a node's children deterministically and split them into the layout's inputs:
 *  file leaves and child dirs. Markers (userData.isMarker — visual annotations parented
 *  into the tree, e.g. bounding prisms) are NOT content: every scheme must ignore them,
 *  so the split lives here rather than in each scheme.
 *
 *  Single-child directory CHAINS compress here — the one traversal seam every scheme
 *  shares. A dir holding exactly one dir and nothing else (canonical-absolute keys make
 *  /home/u/dev/proj a four-deep chain of these) is a presentation pass-through: the
 *  chain's tail is returned in its place, so every scheme lays the tail out at the
 *  head's slot with no per-level nesting cost. See collapseChain for the mechanics. */
export function partitionChildren(node) {
    node.children.sort(childSort);
    const files = [], dirs = [];
    for (const c of node.children) {
        if (c.userData && c.userData.isMarker) continue;
        if (c.userData && c.userData.isDir) dirs.push(collapseChain(c));
        else files.push(c);
    }
    return { files, dirs };
}

/** Follow a single-child directory chain (dir → exactly one dir, no file leaves) to its
 *  tail. Layout/label-level ONLY — paths, _dirs bookkeeping, and navigation stay
 *  canonical: the intermediates' transforms are zeroed so the tail composes in space as
 *  if it sat at the chain head's slot, they're flagged userData.isPassThrough (markers
 *  skip boxing them — they'd double-box the same content), and the tail carries the
 *  joined chain as userData.displayName for label consumers. Self-healing: a later
 *  insert into an intermediate breaks the chain, and the next partition re-walks it
 *  fresh, clearing stale flags. */
export function collapseChain(dir) {
    let tail = dir;
    const names = [String(dir.userData.name ?? '')];
    for (;;) {
        const kids = tail.children.filter((c) => !(c.userData && c.userData.isMarker));
        if (kids.length !== 1 || !kids[0].userData?.isDir) break;
        tail = kids[0];
        names.push(String(tail.userData.name ?? ''));
    }
    if (tail === dir) {
        if (dir.userData.isPassThrough) dir.userData.isPassThrough = false;
        if (dir.userData.displayName) dir.userData.displayName = null;
        return dir;
    }
    for (let n = dir; n !== tail; n = n.children.find((c) => c.userData?.isDir)) {
        n.userData.isPassThrough = true;
        if (n.userData.displayName) n.userData.displayName = null;
        n.position.set(0, 0, 0);
        n.rotation.set(0, 0, 0);
    }
    tail.userData.isPassThrough = false;
    tail.userData.displayName = names.join('/');
    return tail;
}

/** A leaf's LOCAL content box (frame-independent). Real grid → layoutBounds(); mock → a box
 *  centered on the origin from userData.size, so placement and getWorldBounds stay consistent. */
export function leafBox(leaf) {
    if (typeof leaf.layoutBounds === 'function') {
        const b = leaf.layoutBounds();
        if (b && !b.isEmpty()) return b;
    }
    const s = (leaf.userData && leaf.userData.size) || { x: 1, y: 1, z: 1 };
    const hx = s.x / 2, hy = s.y / 2, hz = (s.z || 0) / 2;
    return new THREE.Box3(new THREE.Vector3(-hx, -hy, -hz), new THREE.Vector3(hx, hy, hz));
}

const _ORIGIN = new THREE.Vector3(0, 0, 0);

/** A directory subtree's content bounds in `node`'s LOCAL frame: every descendant leaf's box
 *  carried through the intermediate dir transforms (markers skipped). The single source of
 *  truth for "where is this directory in space" — markers size their prism to it, arrows
 *  anchor to it, probes mark it.
 *
 *  With `includeOrigin` (the default), the node's own origin (0,0,0) is unioned in, so the
 *  box always reaches the directory's front plane. This gives every dir — even a pure
 *  CONTAINER whose content sits a depthZ step back, or an empty stub — a bounded box that
 *  includes its origin, so an origin-anchored arrow lands ON the box instead of floating in
 *  the empty space in front of the content. */
export function subtreeContentBounds(node, target = new THREE.Box3(), includeOrigin = true) {
    target.makeEmpty();
    const tmp = new THREE.Box3();
    const walk = (n, mat) => {
        for (const c of n.children) {
            if (c.userData?.isMarker) continue;
            c.updateMatrix();
            const m = new THREE.Matrix4().multiplyMatrices(mat, c.matrix);
            // Descend dirs AND layout-group containers (jellyfish panels/rows) so the bounds come
            // from the real grids at their CURRENT transforms — a warped panel's grids ride an arc,
            // so its own flat layoutBounds would understate the extent. Only true leaves get boxed.
            if (c.userData?.isDir || c.userData?.isLayoutGroup) { walk(c, m); continue; }
            tmp.copy(leafBox(c)).applyMatrix4(m);
            target.union(tmp);
        }
    };
    walk(node, new THREE.Matrix4());
    if (includeOrigin) target.expandByPoint(_ORIGIN);
    return target;
}

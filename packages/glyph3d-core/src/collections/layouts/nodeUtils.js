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
 *  so the split lives here rather than in each scheme. */
export function partitionChildren(node) {
    node.children.sort(childSort);
    const files = [], dirs = [];
    for (const c of node.children) {
        if (c.userData && c.userData.isMarker) continue;
        if (c.userData && c.userData.isDir) dirs.push(c);
        else files.push(c);
    }
    return { files, dirs };
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
            if (c.userData?.isDir) { walk(c, m); continue; }
            tmp.copy(leafBox(c)).applyMatrix4(m);
            target.union(tmp);
        }
    };
    walk(node, new THREE.Matrix4());
    if (includeOrigin) target.expandByPoint(_ORIGIN);
    return target;
}

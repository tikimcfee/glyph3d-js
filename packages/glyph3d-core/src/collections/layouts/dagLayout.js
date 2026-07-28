/**
 * dagLayout — the "dag" scheme: the tree laid out as a layered graph via dagre (Sugiyama).
 *
 * The one scheme that is NOT hand-rolled packing. Where packed/walk/district/tree pack
 * boxes by geometric rules, this hands the graph to an external solver (@dagrejs/dagre)
 * and reads back ranked coordinates — layered ranks with crossing-minimized ordering, the
 * canonical "node graph" read this repo otherwise lacks. It stays inside the same scheme
 * contract (pure, `fn(root, opts) → {w,h}`, writes child.position + node.userData.size), so
 * `layout.scheme dag` and the Layout panel reach it like any other lens. Dagre is
 * synchronous, so relayout stays a one-shot sync pass — no tick loop, no async seam.
 *
 * EDGES are a provider seam (opts.edges). Phase 1 default = CONTAINMENT: parent dir → each
 * child (file or dir), so dagre draws the directory tree as a proper layered graph and the
 * existing ContentTreeArrows render the edges for free. A phase-2 provider can return
 * import/require edges (from the tree-sitter grammars) to turn this into a true dependency
 * DAG — additive, no change here.
 *
 * COORDINATE MAP. Dagre lays out in a flat 2D global frame (x across a rank, y down the
 * ranks; node coords are CENTERS). We map:
 *   dagre.x → local X (centered on 0)              — spread within a rank
 *   dagre.y → local −Y (rankAxis:'y', a graph facing you) or local −Z (rankAxis:'z', a
 *             flat graph receding into depth like the other schemes)
 * The top rank sits at the origin and the graph hangs down/back — matching the shared
 * anchor convention (origin = footprint top-center, content extends −Y / children −Z).
 *
 * NESTING. Content nodes keep their THREE parenting (files are children of their dir), but
 * dagre positions everything in ONE global frame. So we compute each node's frame-origin
 * (its target center minus its content-box offset) and write child.position RELATIVE to its
 * parent's frame-origin — leaving `root` itself where the caller rested it. Files anchor by
 * their box center; dir hubs are points at their rank coordinate (arrows radiate from them).
 */

import dagre from '@dagrejs/dagre';
import { partitionChildren, leafBox } from './nodeUtils.js';

export const DAG_DEFAULTS = {
    rankAxis: 'y',   // 'y' → graph faces the camera (ranks hang −Y); 'z' → flat, ranks recede −Z
    rankdir: 'TB',   // dagre rank direction: TB | BT | LR | RL (passed straight through)
    nodeSep: 60,     // gap between siblings within a rank (world units)
    rankSep: 220,    // gap between ranks — the depth/hierarchy step (files are ~100 tall)
    edgeSep: 20,     // gap between edges within a rank
    dirNodeW: 40,    // a directory hub's nominal graph-node size (the hub itself is a point)
    dirNodeH: 40,
};

/** Content-node subtree in canonical order: markers skipped, dirs+files partitioned, root
 *  first (pre-order). Returns flat [{ node, isDir, parent }] with `parent` the nearest
 *  collected ancestor (null for root) — the containment edge source and the nesting map. */
function collect(root) {
    const out = [];
    const walk = (node, parent) => {
        const isDir = node === root || !!node.userData?.isDir;
        const entry = { node, isDir, parent };
        out.push(entry);
        if (!isDir) return;                     // leaves have no content children
        const { files, dirs } = partitionChildren(node);   // deterministic; markers excluded
        for (const d of dirs) walk(d, entry);
        for (const f of files) walk(f, entry);
    };
    walk(root, null);
    return out;
}

/** A node's graph-node size + box-center offset. Files use their real content box; dir hubs
 *  are treated as points (center 0) sized to a nominal marker so ranks stay legible. */
function nodeMetrics(entry, opts) {
    if (entry.isDir) return { w: opts.dirNodeW, h: opts.dirNodeH, cx: 0, cy: 0 };
    const b = leafBox(entry.node);
    return {
        w: Math.max(1, b.max.x - b.min.x),
        h: Math.max(1, b.max.y - b.min.y),
        cx: (b.min.x + b.max.x) / 2,
        cy: (b.min.y + b.max.y) / 2,
    };
}

/**
 * Lay out a ContentTree subtree as a layered graph via dagre.
 * @param {import('three').Object3D} root the node to lay out (descendants placed in its local frame)
 * @param {object} [opts] overrides for DAG_DEFAULTS, plus optional `edges`:
 *   `(entries, byNode) => Array<[srcNode, dstNode]>` — extra/replacement edges. Default provider
 *   is containment (parent → child). Return `{ containment:false, edges:[...] }` to replace rather
 *   than augment the containment edges (for a pure dependency DAG).
 * @returns {{w:number, h:number}} the graph's footprint (dagre's total extent).
 */
export default function dagLayout(root, opts = {}) {
    const o = { ...DAG_DEFAULTS, ...opts };
    const entries = collect(root);

    // Nothing to lay out beyond the root itself → zero footprint (siblings close the gap).
    if (entries.length <= 1) {
        root.userData.size = { x: 0, y: 0, z: 0 };
        return { w: 0, h: 0 };
    }

    const byNode = new Map(entries.map((e) => [e.node, e]));
    const idOf = new Map(entries.map((e, i) => [e.node, String(i)]));
    const metrics = new Map(entries.map((e) => [e.node, nodeMetrics(e, o)]));

    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({ rankdir: o.rankdir, nodesep: o.nodeSep, ranksep: o.rankSep, edgesep: o.edgeSep });
    g.setDefaultEdgeLabel(() => ({}));
    for (const e of entries) {
        const m = metrics.get(e.node);
        g.setNode(idOf.get(e.node), { width: m.w, height: m.h });
    }

    // Edges: containment by default; a provider may augment (dependency edges) or replace.
    let containment = true;
    let extra = [];
    if (typeof o.edges === 'function') {
        const r = o.edges(entries, byNode);
        if (Array.isArray(r)) extra = r;
        else if (r && typeof r === 'object') { containment = r.containment !== false; extra = r.edges || []; }
    }
    if (containment) {
        for (const e of entries) {
            if (e.parent) g.setEdge(idOf.get(e.parent.node), idOf.get(e.node), {}, 'own');
        }
    }
    for (const [src, dst] of extra) {
        const si = idOf.get(src), di = idOf.get(dst);
        if (si != null && di != null && si !== di) g.setEdge(si, di, {}, 'dep');
    }

    dagre.layout(g);

    const gg = g.graph();
    const width = gg.width || 0;
    const height = gg.height || 0;
    const rankToZ = o.rankAxis === 'z';

    // Frame-origin per node: the local position its ORIGIN would take in the graph's own
    // (root-local) frame = rank-mapped target center − the node's box-center offset. X is
    // centered on 0; the rank axis hangs from the origin (−Y or −Z).
    const frameOrigin = new Map();
    for (const e of entries) {
        const gnode = g.node(idOf.get(e.node));       // { x, y } centers
        const m = metrics.get(e.node);
        const tx = gnode.x - width / 2;               // center the spread on the origin
        const tRank = gnode.y;                         // grows with rank from ~0 at the top
        const ox = tx - m.cx;
        if (rankToZ) frameOrigin.set(e.node, { x: ox, y: -m.cy, z: -tRank });
        else frameOrigin.set(e.node, { x: ox, y: -tRank - m.cy, z: 0 });
    }

    // Write each non-root node's position RELATIVE to its parent's frame-origin, so the
    // THREE nesting reproduces the flat dagre layout and `root` stays where it was rested.
    for (const e of entries) {
        if (!e.parent) continue;                       // root: caller owns its position
        const fo = frameOrigin.get(e.node);
        const po = frameOrigin.get(e.parent.node);
        e.node.position.set(fo.x - po.x, fo.y - po.y, fo.z - po.z);
        e.node.rotation.set(0, 0, 0);                  // a layered scheme owns identity rotation
        if (e.isDir) {
            const m = metrics.get(e.node);
            e.node.userData.size = { x: m.w, y: m.h, z: 0 };
        }
    }

    root.userData.size = { x: width, y: rankToZ ? height : height, z: rankToZ ? height : 0 };
    return { w: width, h: height };
}

/**
 * Layout commands: layout.info, layout.list, layout.flow, layout.tree
 *
 * Spatial arrangers built on ONE primitive — flowBoxes — that packs sized boxes
 * into a wrapping shelf. layout.flow runs it once over all grids; layout.tree
 * runs it RECURSIVELY over the directory hierarchy: a directory's children
 * (sub-directory clusters + leaf files) are themselves boxes flowed inside the
 * parent. "A group contains subgroups OR leaf-terminals" — the recursion is the
 * tree. Leaves stay as their real rendered content (glyph3d renders the file,
 * not a symbol), so the layout carries hierarchy without collapsing the leaves.
 */

import * as THREE from 'three';
import CodeGrid from '@glyph3d/core/collections/CodeGrid.js';
import { box, kvLines } from '../formatResponse.js';

/**
 * Pack sized boxes into a wrapping shelf. Top-aligned per row; wraps when a row
 * would exceed wrapWidth. Returns each box's TOP-LEFT slot (y descends: rows go
 * downward, slot.y <= 0) plus the cluster's total extent.
 *
 * @param {Array<{w:number,h:number}>} sizes
 * @param {{margin?:number, wrapWidth?:number}} [opts]
 * @returns {{slots: Array<{x:number,y:number}>, width:number, height:number, rows:number}}
 */
export function flowBoxes(sizes, { margin = 16, wrapWidth = Infinity } = {}) {
    const slots = [];
    let cx = 0, topY = 0, rowH = 0, rows = 1, maxW = 0;
    for (const s of sizes) {
        if (cx > 0 && cx + s.w > wrapWidth) {
            maxW = Math.max(maxW, cx - margin);
            cx = 0; topY -= rowH + margin; rowH = 0; rows++;
        }
        slots.push({ x: cx, y: topY });
        cx += s.w + margin;
        rowH = Math.max(rowH, s.h);
    }
    maxW = Math.max(maxW, cx - margin);
    return { slots, width: maxW, height: -topY + rowH, rows };
}

/** Measure a grid's world extent + how its content sits relative to its origin. */
function measureGrid(g) {
    g.updateMatrixWorld(true);
    const b = g.getBounds?.();
    if (!b || b.isEmpty()) return null;
    return {
        grid: g,
        w: b.max.x - b.min.x,
        h: b.max.y - b.min.y,
        localMinX: b.min.x - g.position.x, // content-left relative to origin
        localMaxY: b.max.y - g.position.y, // content-top relative to origin
    };
}

/** Place a grid so its content top-left lands at world (x, y, z). */
function placeGrid(m, x, y, z = 0) {
    m.grid.position.set(x - m.localMinX, y - m.localMaxY, z);
    m.grid.updateMatrixWorld(true);
    m.grid._markBoundsDirty?.(); // position changed → bounds cache stale
}

/**
 * Flow-pack grids into a wrapping shelf (the flat case). Shared primitive:
 * layout.flow runs it on all grids, file.open runs it after adding a grid so
 * opening never stacks them.
 *
 * @param {Array} grids - CodeGrid instances
 * @param {{margin?: number, wrapWidth?: number}} [opts]
 * @returns {{placed:number, rows:number, width:number, height:number}}
 */
export function flowLayout(grids, { margin = 16, wrapWidth } = {}) {
    const items = grids.map(measureGrid).filter(Boolean);
    if (items.length === 0) return { placed: 0, rows: 0, width: 0, height: 0 };

    // Default wrap: ~3 of the widest grid per row, adapting to content scale.
    if (!wrapWidth || wrapWidth <= 0) {
        wrapWidth = Math.max(...items.map((i) => i.w)) * 3;
    }
    const flow = flowBoxes(items.map((i) => ({ w: i.w, h: i.h })), { margin, wrapWidth });
    items.forEach((m, i) => placeGrid(m, flow.slots[i].x, flow.slots[i].y));
    return { placed: items.length, rows: flow.rows, width: flow.width, height: flow.height };
}

// ── tree layout ───────────────────────────────────────────────────────────

/** Build a {name, dirs:Map, files:[grid], path} tree from grids by sourcePath. */
function buildPathTree(grids) {
    const root = { name: '', dirs: new Map(), files: [], path: '' };
    for (const g of grids) {
        const raw = g.getSourcePath?.() || g.getFilename?.() || '';
        const parts = String(raw).replace(/^file:\/\/+/, '').replace(/^\/+/, '').split('/').filter(Boolean);
        if (parts.length <= 1) { root.files.push(g); continue; } // root-level file
        let node = root;
        for (let i = 0; i < parts.length - 1; i++) {
            const d = parts[i];
            if (!node.dirs.has(d)) {
                node.dirs.set(d, { name: d, dirs: new Map(), files: [], path: (node.path ? node.path + '/' : '') + d });
            }
            node = node.dirs.get(d);
        }
        node.files.push(g);
    }
    return root;
}

// The walk-tree: a library is a cubic tree. Each directory is a "section" (its
// own files, packed into a small cluster) sitting at a depth (Z); sibling
// sections spread along X; the parent→child structure is drawn as branch edges —
// the walkway you follow, flying forward (−Z) to go deeper. Reingold-Tilford in
// spirit: measure each subtree's X width bottom-up, then place children centered
// under the parent so subtrees never collide.

// Wrap width that makes the packed footprint roughly square IN WORLD UNITS — not
// in box count. Code files are much wider than tall, so a sqrt(n)-column grid
// comes out very wide; aspect-correcting (cols ∝ sqrt(n·avgH/avgW)) uses fewer
// columns for wide items → more rows → the Y we want instead of endless X.
function squareWrap(sizes, gap) {
    const n = sizes.length;
    if (n <= 1) return Infinity; // single box (or none): no wrap
    const maxW = Math.max(...sizes.map((s) => s.w));
    const avgW = sizes.reduce((a, s) => a + s.w, 0) / n;
    const avgH = sizes.reduce((a, s) => a + s.h, 0) / n;
    const cols = Math.max(1, Math.round(Math.sqrt(n * (avgH / Math.max(avgW, 1)))));
    return cols * (maxW + gap);
}

/** Bottom-up: pack a node's own files into a section, and its child subtrees into
 *  a 2D grid (X AND Y) — so siblings wrap into rows instead of marching out
 *  along X forever. Returns the subtree's 2D footprint. */
function measureWalk(node, opts) {
    const fileItems = node.files
        .slice().sort((a, b) => (a.getFilename?.() || '').localeCompare(b.getFilename?.() || ''))
        .map(measureGrid).filter(Boolean);
    const fSizes = fileItems.map((m) => ({ w: m.w, h: m.h }));
    node._fileItems = fileItems;
    node._fileFlow = flowBoxes(fSizes, { margin: opts.margin, wrapWidth: squareWrap(fSizes, opts.margin) });

    // Children: pack their 2D footprints into a world-square grid (the Y win).
    node._children = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    node._childSizes = node._children.map((c) => measureWalk(c, opts));
    node._childPack = flowBoxes(node._childSizes, { margin: opts.gap, wrapWidth: squareWrap(node._childSizes, opts.gap) });

    node._w = Math.max(node._fileFlow.width, node._childPack.width, opts.minW);
    // Children stack BELOW the files (the stairway), so total height is additive,
    // not the max — the parent must reserve room for the whole cascade.
    const stackedH = node._fileFlow.height
        + (node._childPack.height > 0 ? opts.yStep + node._childPack.height : 0);
    node._h = Math.max(stackedH, opts.minH);
    return { w: node._w, h: node._h };
}

/** Top-down: place a node's files with their TOP at (cx, topY, depth·Z), then its
 *  child subtrees one Z-layer deeper AND below the files — a stairway descending
 *  down (Y) and back (Z) as nesting deepens. */
function placeWalk(node, cx, topY, depth, opts) {
    const z = -depth * opts.zStep;
    const fLeft = cx - node._fileFlow.width / 2;
    node._fileItems.forEach((m, i) => {
        const s = node._fileFlow.slots[i];
        placeGrid(m, fLeft + s.x, topY + s.y, z); // slot.y ≤ 0 → descends from top
    });
    node._anchor = new THREE.Vector3(cx, topY - node._fileFlow.height / 2, z); // section center

    const cp = node._childPack;
    if (cp.slots.length === 0) return;
    const pLeft = cx - cp.width / 2;
    const pTop = topY - node._fileFlow.height - opts.yStep; // below the files
    node._children.forEach((child, i) => {
        const s = cp.slots[i];               // top-left of this child's footprint
        const cw = node._childSizes[i].w;
        placeWalk(child, pLeft + s.x + cw / 2, pTop + s.y, depth + 1, opts);
    });
}

/**
 * Lay grids out as a walk-tree: directory sections spread in X, deeper in Z,
 * connected by branch edges. Files in a directory cluster at that directory's
 * section.
 *
 * @param {Array} grids
 * @param {{margin?:number, zStep?:number, gap?:number}} [opts]
 * @returns {{placed:number, dirs:number, depth:number, root:Object}}
 */
export function treeLayout(grids, { margin = 16, zStep = 170, gap = 60 } = {}) {
    if (!grids.length) return { placed: 0, dirs: 0, depth: 0 };
    const root = buildPathTree(grids);
    const opts = { margin, zStep, gap, yStep: 70, minW: 50, minH: 30 };
    measureWalk(root, opts);
    placeWalk(root, 0, 0, 0, opts);

    let dirs = 0, depth = 0, placed = 0;
    const walk = (n, d) => {
        depth = Math.max(depth, d);
        placed += n.files.length;
        for (const c of n.dirs.values()) { dirs++; walk(c, d + 1); }
    };
    walk(root, 0);
    return { placed, dirs, depth, root };
}

// ── walk-tree markers: section volumes + labels + branch edges ──────────────

/** One LineSegments holding all parent→child branch edges (the walkway). */
function makeEdges(points) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    const edges = new THREE.LineSegments(
        geo,
        new THREE.LineBasicMaterial({ color: 0x4a7f9a, transparent: true, opacity: 0.45, depthWrite: false }),
    );
    edges.renderOrder = -50;
    edges.userData.treeMarker = 'edges';
    return edges;
}

/** A translucent volume + edge outline sized to a cluster's bounds, hued by depth. */
function makeVolume(b, depth) {
    const size = b.getSize(new THREE.Vector3());
    const center = b.getCenter(new THREE.Vector3());
    const geo = new THREE.BoxGeometry(Math.max(size.x, 1), Math.max(size.y, 1), Math.max(size.z, 8));
    const color = new THREE.Color().setHSL((0.58 - depth * 0.09 + 1) % 1, 0.5, 0.55);
    const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.05, depthWrite: false, side: THREE.DoubleSide,
    }));
    fill.position.copy(center);
    fill.renderOrder = -100 + depth;       // behind the glyphs
    fill.userData.treeMarker = 'volume';
    const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.28, depthWrite: false }),
    );
    fill.add(edges);
    return fill;
}

/** A directory-name label (a tiny CodeGrid) with its top-left at (x, y, z). */
function makeLabelAt(ctx, name, depth, x, y, z) {
    const label = new CodeGrid(ctx.scene, ctx.atlas, {
        name: `dir:${name}`, worldScale: 0.06, showBackground: false,
    });
    label.loadFile(name, name);
    label.userData.treeMarker = 'label';
    ctx.scene.add(label);
    label.updateMatrixWorld(true);
    const lb = label.getBounds();
    const lLeft = lb.min.x - label.position.x, lTop = lb.max.y - label.position.y;
    label.position.set(x - lLeft, y - lTop, z);
    label.updateMatrixWorld(true);
    label._markBoundsDirty?.();
    return label;
}

/** Remove + dispose all tree markers from a previous layout.tree. */
export function clearTreeMarkers(ctx) {
    const markers = ctx._treeMarkers;
    if (!markers || !markers.length) { ctx._treeMarkers = []; return; }
    for (const m of markers) {
        ctx.scene.remove(m);
        if (m.userData?.treeMarker === 'label') { m.dispose?.(); continue; }
        m.geometry?.dispose?.();
        m.material?.dispose?.();
        m.traverse?.((c) => { if (c !== m) { c.geometry?.dispose?.(); c.material?.dispose?.(); } });
    }
    ctx._treeMarkers = [];
}

/**
 * Clear old markers, tree-lay the loaded grids, and draw fresh directory volumes
 * + labels. The reusable core behind the layout.tree command AND file.openDir.
 * @returns {{placed:number, dirs:number, depth:number, volumes:number}}
 */
export function applyTreeLayout(ctx, { margin, zStep, gap } = {}) {
    clearTreeMarkers(ctx);
    const r = treeLayout(ctx.getGrids(), { margin, zStep, gap });
    if (r.placed === 0) return { placed: 0, dirs: 0, depth: 0, volumes: 0 };
    const volumes = buildWalkMarkers(ctx, r.root, { margin: margin ?? 16 });
    return { placed: r.placed, dirs: r.dirs, depth: r.depth, volumes };
}

/**
 * Per directory: a translucent volume around its OWN files (its "section" — a
 * place with corners), a name label above it, and branch edges to its children.
 * The volumes are the rooms; the edges are the walkway between them.
 */
function buildWalkMarkers(ctx, root, { margin }) {
    const markers = [];
    const edgePts = [];
    const visit = (node, depth) => {
        if (node.path) {
            const b = new THREE.Box3();
            for (const m of node._fileItems) { m.grid._markBoundsDirty?.(); b.union(m.grid.getBounds()); }
            if (!b.isEmpty()) {
                b.expandByScalar(margin * 0.6);
                const v = makeVolume(b, depth);
                ctx.scene.add(v);
                markers.push(v);
            }
            // Label above the section's top-left (anchor is the section center).
            const fw = node._fileFlow.width, fh = node._fileFlow.height;
            const lx = node._anchor.x - fw / 2;
            const ly = node._anchor.y + fh / 2 + 14;
            markers.push(makeLabelAt(ctx, node.name, depth, lx, ly, node._anchor.z + 2));
        }
        for (const c of node._children) {
            const a = node._anchor, ca = c._anchor;
            edgePts.push(a.x, a.y, a.z, ca.x, ca.y, ca.z);
            visit(c, depth + 1);
        }
    };
    visit(root, 0);
    if (edgePts.length) {
        const e = makeEdges(edgePts);
        ctx.scene.add(e);
        markers.push(e);
    }
    ctx._treeMarkers = markers;
    return markers.filter((m) => m.userData?.treeMarker === 'volume').length;
}

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerLayoutCommands(router) {
    router.register('layout.flow', (args, ctx) => {
        const margin = args[0] != null ? parseFloat(args[0]) : undefined;
        const wrapWidth = args[1] != null ? parseFloat(args[1]) : undefined;
        clearTreeMarkers(ctx); // flow is flat — drop any directory volumes
        const r = flowLayout(ctx.getGrids(), { margin, wrapWidth });
        if (r.placed === 0) return { text: 'OK: nothing to lay out', data: r };
        return { text: `OK: laid out ${r.placed} grids in ${r.rows} row(s)`, data: r };
    }, {
        description: 'Arrange all loaded grids into a wrapping shelf (bounds + margin)',
        usage: '[margin] [wrapWidth]',
        returns: '{ placed, rows, width, height }',
    });

    router.register('layout.tree', (args, ctx) => {
        const margin = args[0] != null ? parseFloat(args[0]) : undefined;
        const zStep = args[1] != null ? parseFloat(args[1]) : undefined;
        const r = applyTreeLayout(ctx, { margin, zStep });
        if (r.placed === 0) return { text: 'OK: nothing to lay out', data: r };
        return {
            text: `OK: tree-laid ${r.placed} file(s) across ${r.dirs} dir(s) (depth ${r.depth}), ${r.volumes} volume(s)`,
            data: r,
        };
    }, {
        description: 'Arrange loaded grids by directory hierarchy (recursive flow clusters)',
        usage: '[margin] [zStep]',
        returns: '{ placed, dirs, depth }',
    });

    router.register('layout.info', (args, ctx) => {
        const active = ctx.getActiveLayout ? ctx.getActiveLayout() : 'unknown';
        const data = {
            'active': active,
            'available': Object.keys(ctx.layoutManagers || {}).join(', ') || 'none',
        };
        return {
            text: box('LAYOUT', kvLines(data), 40),
            data: { active, available: Object.keys(ctx.layoutManagers || {}) },
        };
    }, { description: 'Show current layout details' });

    router.register('layout.list', (args, ctx) => {
        const managers = ctx.layoutManagers || {};
        const active = ctx.getActiveLayout ? ctx.getActiveLayout() : null;
        const names = Object.keys(managers);
        if (names.length === 0) {
            return { text: 'No layout managers available', data: { layouts: [] } };
        }
        const lines = names.map(n => (n === active ? `> ${n} (active)` : `  ${n}`));
        return { text: box('LAYOUTS', lines, 30), data: { layouts: names, active } };
    }, { description: 'List available layout modes' });
}

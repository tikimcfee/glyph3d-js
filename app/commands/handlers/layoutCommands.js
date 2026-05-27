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

/**
 * Bottom-up measure: each directory's children (sub-dir clusters first, then
 * leaf files) become sized boxes, flowed into a roughly-square cluster. Stashes
 * the item list + slots on the node for the place pass; returns the cluster size.
 */
function measureNode(node, opts) {
    const items = [];
    for (const d of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        const sz = measureNode(d, opts);
        items.push({ kind: 'dir', dir: d, w: sz.w, h: sz.h });
    }
    for (const g of node.files.slice().sort((a, b) => (a.getFilename?.() || '').localeCompare(b.getFilename?.() || ''))) {
        const m = measureGrid(g);
        if (m) items.push({ kind: 'file', ...m });
    }
    node._items = items;

    const sizes = items.map((it) => ({ w: it.w, h: it.h }));
    // Roughly-square cluster: ~sqrt(n) columns, sized to fit the widest child.
    const maxW = sizes.length ? Math.max(...sizes.map((s) => s.w)) : 0;
    const cols = Math.max(1, Math.ceil(Math.sqrt(sizes.length)));
    node._flow = flowBoxes(sizes, { margin: opts.margin, wrapWidth: cols * (maxW + opts.margin) });
    return { w: node._flow.width, h: node._flow.height };
}

/** Top-down place: each item at parent origin + its slot; recurse into dirs. */
function placeNode(node, ox, oy, depth, opts) {
    node._items.forEach((it, i) => {
        const s = node._flow.slots[i];
        const x = ox + s.x, y = oy + s.y; // item top-left
        if (it.kind === 'file') placeGrid(it, x, y, -depth * opts.zStep);
        else placeNode(it.dir, x, y, depth + 1, opts);
    });
}

/**
 * Arrange loaded grids by directory hierarchy: recursive flow clusters. Files in
 * a directory group together; sub-directories nest as sub-clusters; depth can be
 * pushed into Z (zStep) to "fly into the tree".
 *
 * @param {Array} grids
 * @param {{margin?:number, zStep?:number}} [opts]
 * @returns {{placed:number, dirs:number, depth:number}}
 */
export function treeLayout(grids, { margin = 24, zStep = 0 } = {}) {
    if (!grids.length) return { placed: 0, dirs: 0, depth: 0 };
    const root = buildPathTree(grids);
    measureNode(root, { margin });
    placeNode(root, 0, 0, 0, { margin, zStep });

    let dirs = 0, depth = 0, placed = 0;
    const walk = (n, d) => {
        depth = Math.max(depth, d);
        placed += n.files.length;
        for (const c of n.dirs.values()) { dirs++; walk(c, d + 1); }
    };
    walk(root, 0);
    return { placed, dirs, depth, root };
}

// ── directory markers: translucent volumes + name labels ────────────────────

/** Union the world bounds of every grid under a node into `box`. */
function unionNodeBounds(node, box) {
    for (const it of node._items || []) {
        if (it.kind === 'file') { it.grid._markBoundsDirty?.(); box.union(it.grid.getBounds()); }
        else unionNodeBounds(it.dir, box);
    }
    return box;
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

/** A directory-name label (a tiny CodeGrid) anchored at the cluster's top-left. */
function makeLabel(ctx, b, name, depth) {
    const label = new CodeGrid(ctx.scene, ctx.atlas, {
        name: `dir:${name}`, worldScale: 0.05, showBackground: false,
    });
    label.loadFile(name, name);
    label.userData.treeMarker = 'label';
    ctx.scene.add(label);
    label.updateMatrixWorld(true);
    const lb = label.getBounds();
    const lh = lb.max.y - lb.min.y;
    const lLeft = lb.min.x - label.position.x, lTop = lb.max.y - label.position.y;
    // sit just above the cluster's top-left, nudged forward in z
    label.position.set(b.min.x - lLeft, b.max.y + lh * 0.6 - lTop, b.max.z + 1);
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
export function applyTreeLayout(ctx, { margin = 24, zStep = 0 } = {}) {
    clearTreeMarkers(ctx);
    const r = treeLayout(ctx.getGrids(), { margin, zStep });
    if (r.placed === 0) return { placed: 0, dirs: 0, depth: 0, volumes: 0 };
    const volumes = buildTreeMarkers(ctx, r.root, { margin });
    return { placed: r.placed, dirs: r.dirs, depth: r.depth, volumes };
}

/** Build a volume + label for every directory node (skips the path-less root). */
function buildTreeMarkers(ctx, root, { margin }) {
    const markers = [];
    const visit = (node, depth) => {
        if (node.path) {
            const b = unionNodeBounds(node, new THREE.Box3());
            if (!b.isEmpty()) {
                b.expandByScalar(margin * 0.4 + depth * 2); // outer dirs breathe a bit more
                markers.push(makeVolume(b, depth));
                ctx.scene.add(markers[markers.length - 1]);
                markers.push(makeLabel(ctx, b, node.name, depth));
            }
        }
        for (const it of node._items || []) if (it.kind === 'dir') visit(it.dir, depth + 1);
    };
    visit(root, 0);
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

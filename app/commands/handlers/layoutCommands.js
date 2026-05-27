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
    return { placed, dirs, depth };
}

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerLayoutCommands(router) {
    router.register('layout.flow', (args, ctx) => {
        const margin = args[0] != null ? parseFloat(args[0]) : undefined;
        const wrapWidth = args[1] != null ? parseFloat(args[1]) : undefined;
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
        const r = treeLayout(ctx.getGrids(), { margin, zStep });
        if (r.placed === 0) return { text: 'OK: nothing to lay out', data: r };
        return {
            text: `OK: tree-laid ${r.placed} file(s) across ${r.dirs} dir(s), depth ${r.depth}`,
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

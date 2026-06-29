/**
 * panelPack — shelf-pack a directory's file grids into PANELS for the cylindrical (jellyfish)
 * scheme. A panel is the tiling unit of the cylinder's surface: a bounded `panelW × panelH`
 * block, built as a real `VStack` of `HStack` rows, so the grids are re-parented into honest
 * layout nodes. The panels become the cylinder's faces (the n-gon edges) — see jellyfishLayout.
 *
 * The pack is a deterministic 2D shelf (the classic strip-pack), walking grids in the caller's
 * order (canonical childSort):
 *   1. Fill an HStack row left→right until the next grid would exceed `panelW` → start a new row.
 *   2. Stack rows down a VStack panel until the next row would exceed `panelH` → start a new panel.
 *   3. The first grid of a row, and the first row of a panel, ALWAYS go in — so a grid wider or
 *      taller than a whole panel simply lands in a solo, "oversized" panel that otherwise behaves
 *      like any other. Nothing is dropped or truncated (faithfulness over density).
 *
 * Panels are the unit the cylinder tiles: tiny files pack many-to-a-panel (a fine MOSAIC around a
 * dir), a few big files give one-per-panel (a BLOCKY cylinder). The panel size is a pure packing
 * bound; the cylinder's radius comes from the target radius, not the panel/file count.
 *
 * Pure over its input ORDER (caller pre-sorts). Side effect by design: it builds + lays the panel
 * nodes and re-parents the grids into them. Panels/rows carry userData.isLayoutGroup so ContentTree
 * normalizes them away before any non-cylinder relayout (see ContentTree._flattenGroups).
 */

import { VStack, HStack } from './StackContainer.js';
import { leafBox } from './nodeUtils.js';

export const PANEL_DEFAULTS = {
    // A panel is a TILE of the cylinder surface, so its budget must stay small relative to the
    // column's target radius — a grid wider than panelW becomes its own (solo) face, smaller grids
    // pack a few to a tile. Big files → few fat tiles (blocky); tiny files → many small tiles (mosaic).
    panelW: 1090,   // a row spills to the next row past this width (a panel's tangential bound)
    panelH: 960,    // a panel spills to the next panel past this stacked height
    colGap: 32,     // HStack gap between grids within a row
    rowGap: 48,     // VStack gap between rows within a panel
};

const widthOf = (leaf) => { const b = leafBox(leaf); return b.max.x - b.min.x; };
const heightOf = (leaf) => { const b = leafBox(leaf); return b.max.y - b.min.y; };

/**
 * Pack file grids into laid-out panel VStacks.
 * @param {import('three').Object3D[]} grids file grids in canonical order
 * @param {object} [opts] overrides for PANEL_DEFAULTS
 * @returns {import('three').Object3D[]} panel VStacks (grids re-parented in, each `.layout()`'d);
 *   empty array for no grids. Caller tiles the panels onto the cylinder surface.
 */
export function packPanels(grids, opts = {}) {
    const o = { ...PANEL_DEFAULTS, ...opts };
    if (!grids.length) return [];

    // phase 1 — grids → rows, bounded by width.
    const rows = [];
    let row = null, rowW = 0;
    for (const g of grids) {
        const w = widthOf(g);
        if (!row) { row = [g]; rowW = w; }
        else if (rowW + o.colGap + w <= o.panelW) { row.push(g); rowW += o.colGap + w; }
        else { rows.push(row); row = [g]; rowW = w; }
    }
    if (row) rows.push(row);

    // phase 2 — rows → panels, bounded by stacked height (a row's height = its tallest grid).
    const rowHeight = (r) => Math.max(...r.map(heightOf));
    const panels = [];
    let panelRows = null, panelH = 0;
    for (const r of rows) {
        const h = rowHeight(r);
        if (!panelRows) { panelRows = [r]; panelH = h; }
        else if (panelH + o.rowGap + h <= o.panelH) { panelRows.push(r); panelH += o.rowGap + h; }
        else { panels.push(panelRows); panelRows = [r]; panelH = h; }
    }
    if (panelRows) panels.push(panelRows);

    // build real nodes: VStack panel → HStack rows → grids (re-parented in by the constructors).
    return panels.map((rowsOfGrids) => {
        const rowStacks = rowsOfGrids.map((gs) => {
            const hs = new HStack({ spacing: o.colGap, children: gs });
            hs.userData.isLayoutGroup = true;
            hs.userData.isPanelRow = true;
            return hs;
        });
        const panel = new VStack({ spacing: o.rowGap, children: rowStacks });
        panel.userData.isLayoutGroup = true;
        panel.userData.isPanel = true;
        panel.layout();   // lay rows + grids in the panel's local frame; sets its box + userData.size
        return panel;
    });
}

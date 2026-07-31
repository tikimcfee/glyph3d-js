/**
 * dockLayoutPrune — make a saved dockview layout safe to `fromJSON` against the
 * CURRENT panel catalog.
 *
 * A serialized dockview layout names its panels in TWO places: the `panels` map
 * (id → panel record, with the component name) and the `grid` tree (leaf nodes
 * carry `views: [panelId]`). A panel whose component no longer exists must be
 * removed from BOTH — dropping it from the map alone leaves a dangling view id,
 * and dockview's deserializer throws on it, reverting the whole dock to EMPTY
 * (that was the cascade that erased saved layouts). Floating/popout/edge groups
 * carry the same `views` shape and get the same treatment.
 *
 * Pure data → data. Returns `{ layout, dropped }`: the pruned layout (null when
 * nothing usable survives — caller falls back to defaults) plus the list of
 * dropped `{ id, component }` for clear-with-log reporting.
 */

/** @param {object} layout serialized dockview layout @param {string[]} knownComponents */
export function pruneDockLayout(layout, knownComponents) {
  const known = new Set(knownComponents || []);
  if (!layout || typeof layout !== 'object' || !layout.grid?.root || !layout.panels) {
    return { layout: null, dropped: [] };
  }

  const dropped = [];
  const panels = {};
  for (const [id, p] of Object.entries(layout.panels)) {
    const comp = p?.contentComponent;
    if (comp && !known.has(comp)) { dropped.push({ id, component: comp }); continue; }
    panels[id] = p;
  }
  const liveView = (id) => Object.prototype.hasOwnProperty.call(panels, id);

  // Group data ({views, activeView, …}) → pruned group data, or null when it empties.
  // An activeView that died falls to the last survivor (dockview's own fallback rule).
  const pruneGroup = (g) => {
    if (!g || !Array.isArray(g.views)) return null;
    const views = g.views.filter(liveView);
    if (!views.length) return null;
    const activeView = views.includes(g.activeView) ? g.activeView : views[views.length - 1];
    return { ...g, views, activeView };
  };

  // Grid node → pruned node: leaves prune their group, branches drop emptied children
  // and collapse away when none remain.
  const pruneNode = (node) => {
    if (!node || typeof node !== 'object') return null;
    if (node.type === 'leaf') {
      const data = pruneGroup(node.data);
      return data ? { ...node, data } : null;
    }
    if (node.type === 'branch' && Array.isArray(node.data)) {
      const children = node.data.map(pruneNode).filter(Boolean);
      return children.length ? { ...node, data: children } : null;
    }
    return null;
  };

  const root = pruneNode(layout.grid.root);
  if (!root || root.type !== 'branch') return { layout: null, dropped };

  const out = { ...layout, grid: { ...layout.grid, root }, panels };

  if (Array.isArray(layout.floatingGroups)) {
    out.floatingGroups = layout.floatingGroups
      .map((fg) => { const data = pruneGroup(fg?.data); return data ? { ...fg, data } : null; })
      .filter(Boolean);
  }
  if (Array.isArray(layout.popoutGroups)) {
    out.popoutGroups = layout.popoutGroups
      .map((pg) => { const data = pruneGroup(pg?.data); return data ? { ...pg, data } : null; })
      .filter(Boolean);
  }
  if (layout.edgeGroups && typeof layout.edgeGroups === 'object') {
    const edges = {};
    for (const [pos, entry] of Object.entries(layout.edgeGroups)) {
      const group = pruneGroup(entry?.group);
      if (group) edges[pos] = { ...entry, group };
    }
    out.edgeGroups = edges;
  }

  // activeGroup must name a surviving group (group ids live on leaf/floating/popout data).
  const groupIds = new Set();
  const collect = (n) => { if (n.type === 'leaf') groupIds.add(n.data.id); else for (const c of n.data) collect(c); };
  collect(root);
  for (const fg of out.floatingGroups || []) groupIds.add(fg.data.id);
  for (const pg of out.popoutGroups || []) groupIds.add(pg.data.id);
  if (out.activeGroup != null && !groupIds.has(out.activeGroup)) delete out.activeGroup;

  return { layout: out, dropped };
}

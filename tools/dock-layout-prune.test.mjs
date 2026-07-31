// dock-layout-prune.test.mjs — headless unit test for pruneDockLayout, the pure
// saved-dockview-layout sanitizer. The invariant under test: a panel whose component
// the current catalog no longer knows is removed from BOTH the panels map AND the
// grid tree (leaves/branches collapse, activeView/activeGroup re-point) — a dangling
// view id makes dockview's fromJSON throw and revert the dock to EMPTY, which was
// the cascade that erased saved layouts from the session file.
//
//   bun tools/dock-layout-prune.test.mjs

import { pruneDockLayout } from '../app/client/dockLayoutPrune.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)} want ${JSON.stringify(b)})`);

const KNOWN = ['files', 'editor', 'terminals'];
const panel = (id, component = id) => ({ id, contentComponent: component, title: id });
const leaf = (id, views, activeView) => ({ type: 'leaf', data: { id, views, activeView: activeView ?? views[0] }, size: 100 });

// A two-group layout with one orphaned panel ('trail', component removed) tabbed
// into the first group.
const twoGroups = () => ({
  grid: {
    root: { type: 'branch', data: [leaf('g1', ['files', 'trail'], 'trail'), leaf('g2', ['editor'])] },
    width: 800, height: 600, orientation: 'HORIZONTAL',
  },
  panels: { files: panel('files'), trail: panel('trail'), editor: panel('editor') },
  activeGroup: 'g1',
});

// orphan pruned from panels AND the grid tree; dead activeView falls to the last survivor
{
  const { layout, dropped } = pruneDockLayout(twoGroups(), KNOWN);
  eq(dropped, [{ id: 'trail', component: 'trail' }], 'orphan reported');
  eq(Object.keys(layout.panels), ['files', 'editor'], 'orphan gone from panels map');
  eq(layout.grid.root.data[0].data.views, ['files'], 'orphan gone from the grid leaf');
  eq(layout.grid.root.data[0].data.activeView, 'files', 'dead activeView → last survivor');
  eq(layout.activeGroup, 'g1', 'surviving activeGroup kept');
}

// clean layout passes through unchanged
{
  const input = { grid: { root: { type: 'branch', data: [leaf('g1', ['files', 'editor'])] }, width: 800, height: 600 }, panels: { files: panel('files'), editor: panel('editor') } };
  const { layout, dropped } = pruneDockLayout(input, KNOWN);
  eq(dropped, [], 'clean: nothing dropped');
  eq(layout, input, 'clean: layout unchanged');
}

// a fully-orphaned group collapses out of its branch; activeGroup re-points away from it
{
  const input = twoGroups();
  input.grid.root.data[0] = leaf('g1', ['trail']);   // only the orphan
  const { layout } = pruneDockLayout(input, KNOWN);
  eq(layout.grid.root.data.length, 1, 'emptied leaf dropped from branch');
  eq(layout.grid.root.data[0].data.id, 'g2', 'surviving leaf is the other group');
  ok(!('activeGroup' in layout), 'dead activeGroup removed');
}

// nested branches collapse recursively
{
  const input = {
    grid: {
      root: {
        type: 'branch',
        data: [
          { type: 'branch', data: [leaf('g1', ['trail']), leaf('g2', ['trail'])] },
          leaf('g3', ['editor']),
        ],
      },
      width: 800, height: 600,
    },
    panels: { trail: panel('trail'), editor: panel('editor') },
  };
  const { layout } = pruneDockLayout(input, KNOWN);
  eq(layout.grid.root.data.length, 1, 'fully-orphaned sub-branch collapsed away');
  eq(layout.grid.root.data[0].data.views, ['editor'], 'survivor intact');
}

// nothing usable survives → layout null (caller falls back to defaults), dropped still reported
{
  const input = { grid: { root: { type: 'branch', data: [leaf('g1', ['trail'])] }, width: 800, height: 600 }, panels: { trail: panel('trail') } };
  const { layout, dropped } = pruneDockLayout(input, KNOWN);
  eq(layout, null, 'all-orphan layout → null');
  eq(dropped.length, 1, 'drops still reported');
}

// malformed input → null, never a throw
{
  eq(pruneDockLayout(null, KNOWN).layout, null, 'null layout → null');
  eq(pruneDockLayout({}, KNOWN).layout, null, 'no grid → null');
  eq(pruneDockLayout({ grid: {}, panels: {} }, KNOWN).layout, null, 'no root → null');
  eq(pruneDockLayout({ grid: { root: { type: 'leaf', data: { id: 'g', views: ['files'] } } }, panels: { files: panel('files') } }, KNOWN).layout,
     null, 'non-branch root → null (dockview asserts branch)');
}

// a panel with no contentComponent is kept (matches the old filter's comp-guard)
{
  const input = { grid: { root: { type: 'branch', data: [leaf('g1', ['mystery'])] }, width: 800, height: 600 }, panels: { mystery: { id: 'mystery', title: 'x' } } };
  const { layout, dropped } = pruneDockLayout(input, KNOWN);
  eq(dropped, [], 'component-less panel not dropped');
  eq(layout.grid.root.data[0].data.views, ['mystery'], 'component-less panel survives in the tree');
}

// floating groups get the same treatment: pruned in place, dropped when emptied
{
  const input = twoGroups();
  input.floatingGroups = [
    { data: { id: 'f1', views: ['editor', 'trail'], activeView: 'trail' }, position: { left: 10, top: 10, width: 200, height: 150 } },
    { data: { id: 'f2', views: ['trail'], activeView: 'trail' }, position: { left: 30, top: 30, width: 200, height: 150 } },
  ];
  const { layout } = pruneDockLayout(input, KNOWN);
  eq(layout.floatingGroups.length, 1, 'emptied floating group dropped');
  eq(layout.floatingGroups[0].data.views, ['editor'], 'surviving floating group pruned');
  eq(layout.floatingGroups[0].data.activeView, 'editor', 'floating activeView re-pointed');
}

console.log(fail === 0 ? `\nPASS — ${pass} assertions` : `\nFAIL — ${fail} of ${pass + fail} assertions`);
process.exit(fail === 0 ? 0 : 1);

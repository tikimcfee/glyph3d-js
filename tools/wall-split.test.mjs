// wall-split.test.mjs — splits (wall/splitTree.js, WallGroups' split layout), headless. The tree: a
// cut inserts beside its pane, a pane that goes gives its sibling the room, the panes partition the
// rect exactly (gaps included), minSize sums along a cut, a divider is hit in its gap and dragged
// within both sides' minimums, neighbours are found in four directions, a group's members become
// even rows. On a stand-in wall with the real store (terminals as cell grids with padding, resized
// as termd would): splitting re-wraps both halves in whole cells inside their panes, the title bar's
// room kept above each; a split that wouldn't fit is refused; a pane leaving gives its room back;
// a divider drag and an outer resize re-wrap; bars toggle; a tiled group becomes a split and back;
// the store keeps the tree; an open Agent View takes its share of its pane (growing the split when it must). Run: bun test tools/wall-split.test.mjs
import { test, expect, beforeEach } from 'bun:test';

const mem = new Map();
globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
};
const T = await import('../wall/splitTree.js');
const { default: WallStore } = await import('../wall/WallStore.js');
const { default: WallGroups } = await import('../wall/WallGroups.js');
const { WALL_CONFIG } = await import('../wall/wallConfig.js');
const AV = await import('../wall/wallAgentView.js');
const { overlaps } = await import('../wall/wallLayout.js');

beforeEach(() => mem.clear());

const R = (minX, maxX, minY, maxY) => ({ minX, maxX, minY, maxY });

// ── the tree ──────────────────────────────────────────────────────────────

test('insert cuts a pane beside itself; remove gives the sibling the room; leaves read in order', () => {
    let t = { id: 'a' };
    t = T.insert(t, 'a', 'b', 'row');
    t = T.insert(t, 'b', 'c', 'col');
    expect(T.leaves(t)).toEqual(['a', 'b', 'c']);
    expect(t).toEqual({ dir: 'row', ratio: 0.5, a: { id: 'a' }, b: { dir: 'col', ratio: 0.5, a: { id: 'b' }, b: { id: 'c' } } });
    expect(T.insert({ id: 'a' }, 'a', 'z', 'row', 'before')).toEqual({ dir: 'row', ratio: 0.5, a: { id: 'z' }, b: { id: 'a' } });
    expect(T.remove(t, 'b')).toEqual({ dir: 'row', ratio: 0.5, a: { id: 'a' }, b: { id: 'c' } });
    expect(T.remove({ id: 'a' }, 'a')).toBe(null);
    expect(T.remove(t, 'nope')).toBe(t);
});

test('panes partition the rect exactly, the gap between each cut', () => {
    const t = { dir: 'row', ratio: 0.25, a: { id: 'a' }, b: { dir: 'col', ratio: 0.5, a: { id: 'b' }, b: { id: 'c' } } };
    const ps = T.panes(t, R(0, 101, -61, 0), 1);
    expect(ps.get('a')).toEqual(R(0, 25, -61, 0));
    expect(ps.get('b')).toEqual(R(26, 101, -30, 0));
    expect(ps.get('c')).toEqual(R(26, 101, -61, -31));
    const area = [...ps.values()].reduce((n, r) => n + (r.maxX - r.minX) * (r.maxY - r.minY), 0);
    expect(area).toBe(101 * 61 - 61 * 1 - 75 * 1);   // the rect less the two gaps
});

test('minSize sums along a cut and takes the larger across it', () => {
    const t = { dir: 'row', ratio: 0.5, a: { id: 'a' }, b: { dir: 'col', ratio: 0.5, a: { id: 'b' }, b: { id: 'c' } } };
    expect(T.minSize(t, () => ({ w: 10, h: 4 }), 1)).toEqual({ w: 21, h: 9 });
});

test('a divider is hit in its gap (widened by tol), the deepest first, and drags within both minimums', () => {
    const t = { dir: 'row', ratio: 0.5, a: { id: 'a' }, b: { dir: 'col', ratio: 0.5, a: { id: 'b' }, b: { id: 'c' } } };
    const rect = R(0, 101, -61, 0);
    expect(T.dividerAt(t, rect, 1, { x: 50.5, y: -10 }, 0).path).toEqual([]);
    expect(T.dividerAt(t, rect, 1, { x: 49.8, y: -10 }, 0.5).path).toEqual([]);
    expect(T.dividerAt(t, rect, 1, { x: 70, y: -30.5 }, 0)).toMatchObject({ path: ['b'], axis: 'y' });
    expect(T.dividerAt(t, rect, 1, { x: 20, y: -20 }, 0.5)).toBe(null);
    const min = () => ({ w: 20, h: 10 });
    expect(T.ratioFor(t, rect, 1, [], 30.5, min)).toBeCloseTo(0.3);
    expect(T.ratioFor(t, rect, 1, [], 5, min)).toBeCloseTo(20 / 100);      // a's minimum
    expect(T.ratioFor(t, rect, 1, [], 99, min)).toBeCloseTo(80 / 100);     // b's minimum
    expect(T.setRatio(t, ['b'], 0.25).b.ratio).toBe(0.25);
    expect(() => T.setRatio({ id: 'a' }, [], 0.3)).toThrow(/no divider/);
});

test('neighbours in four directions: nearest beyond the edge, overlapping across', () => {
    const t = { dir: 'row', ratio: 0.5, a: { id: 'a' }, b: { dir: 'col', ratio: 0.5, a: { id: 'b' }, b: { id: 'c' } } };
    const ps = T.panes(t, R(0, 101, -61, 0), 1);
    expect(T.neighbor(ps, 'a', 'right')).toBe('b');   // both overlap a; b overlaps as much, first wins a tie
    expect(T.neighbor(ps, 'b', 'down')).toBe('c');
    expect(T.neighbor(ps, 'c', 'up')).toBe('b');
    expect(T.neighbor(ps, 'c', 'left')).toBe('a');
    expect(T.neighbor(ps, 'a', 'left')).toBe(null);
});

test('a group becomes even rows of `columns`; checkTree holds the tree to its members', () => {
    const t = T.fromMembers(['a', 'b', 'c', 'd', 'e'], 2);
    expect(T.leaves(t)).toEqual(['a', 'b', 'c', 'd', 'e']);
    const ps = T.panes(t, R(0, 100, -90, 0), 0);
    expect(ps.get('a')).toEqual(R(0, 50, -30, 0));
    expect(ps.get('d')).toEqual(R(50, 100, -60, -30));
    expect(ps.get('e')).toEqual(R(0, 100, -90, -60));
    expect(T.checkTree(t, ['e', 'd', 'c', 'b', 'a'])).toBe(t);
    expect(() => T.checkTree(t, ['a', 'b'])).toThrow(/not its members/);
    expect(() => T.checkTree({ dir: 'row', ratio: 1, a: { id: 'a' }, b: { id: 'b' } }, ['a', 'b'])).toThrow(/ratio/);
});

// ── on the wall ───────────────────────────────────────────────────────────

/** The grid's own padding round its cells, world units; a cell is 1 × 2. */
const PAD = 0.3, SX = 1, SY = 2;

/** A wall of terminals as cell grids (panel = cells + PAD each side, top-left at position), resized as termd would. */
function fakeWall(sizes) {
    const terminals = new Map(Object.entries(sizes).map(([id, [cols, rows, x = 0, y = 0]]) => [id, { cols, rows, position: { x, y }, cellStride: { x: SX, y: SY } }]));
    const bars = new Map();
    const wall = {
        store: new WallStore(8099),
        config: { ...WALL_CONFIG, splitGap: 0.5, splitBarRows: 1.5, splitBars: true },
        order: [...terminals.keys()],
        _emit() {},
        terminal: (id) => terminals.get(id),
        isShown: (id) => terminals.has(id) && !wall.store.hidden(id),
        onCanvas: (id) => wall.isShown(id),
        terminalRect(id) { const g = terminals.get(id); return R(g.position.x, g.position.x + g.cols * SX + 2 * PAD, g.position.y - g.rows * SY - 2 * PAD, g.position.y); },
        windowRect(id) { const r = this.terminalRect(id); return { ...r, maxY: r.maxY + (bars.get(id) ?? 1) }; },
        placeBody(id, p) { const g = terminals.get(id); g.position.x = p.x; g.position.y = p.y; },
        rememberPosition(id) { wall.store.setPosition(id, terminals.get(id).position); },
        router: { execute: (cmd) => { if (cmd[0] === 'terminal.resize') { const g = terminals.get(cmd[1]); g.cols = +cmd[2]; g.rows = +cmd[3]; } } },
        names: { setBarRoom: (id, room) => (room == null ? bars.delete(id) : bars.set(id, room)) },
        add(id, cols, rows) { terminals.set(id, { cols, rows, position: { x: 999, y: 999 }, cellStride: { x: SX, y: SY } }); wall.order.push(id); },
    };
    wall.groups = new WallGroups(wall, { atlas: null, scene: null });
    return { wall, terminals, bars };
}

/** Every pane's terminal sits inside its pane, below the bar room, in whole cells, and fills it to under a cell. */
function expectFilled(wall, gid) {
    const g = wall.groups.get(gid), room = g.split.bars ? wall.config.splitBarRows * SY : 0;
    for (const [id, pr] of wall.groups.paneRects(gid)) {
        const r = wall.terminalRect(id);
        expect({ id, left: r.minX, top: r.maxY }).toEqual({ id, left: pr.minX, top: pr.maxY - room });
        expect(r.maxX).toBeLessThanOrEqual(pr.maxX + 1e-9);
        expect(r.minY).toBeGreaterThanOrEqual(pr.minY - 1e-9);
        expect(pr.maxX - r.maxX).toBeLessThan(SX);
        expect(r.minY - pr.minY).toBeLessThan(SY);
    }
}

test('splitting a terminal right makes a split round its window: both halves re-wrapped in their panes, bar room above', () => {
    const { wall, terminals, bars } = fakeWall({ a: [80, 24, 10, -5] });
    wall.add('b', 80, 24);
    const gid = wall.groups.insertPane('a', 'b', 'right');
    const g = wall.groups.get(gid);
    expect(g.layout).toBe('split');
    expect(g.members).toEqual(['a', 'b']);
    expect(g.origin).toEqual({ x: 10, y: -5 + 1.5 * SY });            // the window: the bar room above the old panel
    expect(g.split.w).toBeCloseTo(80 * SX + 2 * PAD);
    expectFilled(wall, gid);
    expect(terminals.get('a').cols).toBe(terminals.get('b').cols);   // an even cut
    expect(terminals.get('a').cols).toBe(Math.floor(((80 + 2 * PAD - 0.5) / 2 - 2 * PAD) / SX));
    expect(bars.get('a')).toBe(1.5 * SY);
    // Down from b: b's pane cut in two, stacked.
    wall.add('c', 80, 24);
    wall.groups.insertPane('b', 'c', 'down');
    expect(wall.groups.get(gid).members).toEqual(['a', 'b', 'c']);
    expectFilled(wall, gid);
    expect(T.neighbor(wall.groups.paneRects(gid), 'b', 'down')).toBe('c');
});

test('a split that would leave a half under 20×5 is refused, and nothing changes', () => {
    const { wall } = fakeWall({ a: [30, 24] });
    wall.add('b', 30, 24);
    expect(() => wall.groups.canSplit('a', 'right')).toThrow(/no room to split 'a' right/);
    expect(() => wall.groups.insertPane('a', 'b', 'right')).toThrow(/at least 20×5/);
    expect(wall.store.groups()).toEqual({});
    expect(() => wall.groups.canSplit('a', 'down')).not.toThrow();
});

test('a pane that leaves gives its room to its sibling; the split re-wraps', () => {
    const { wall, terminals } = fakeWall({ a: [80, 24] });
    wall.add('b', 80, 24);
    const gid = wall.groups.insertPane('a', 'b', 'right');
    wall.groups.remove(['b']);
    expect(wall.groups.get(gid).members).toEqual(['a']);
    expect(wall.groups.get(gid).split.tree).toEqual({ id: 'a' });
    expectFilled(wall, gid);
    expect(terminals.get('a').cols).toBe(80);                         // the whole rect again
    // The store collapses the tree when a terminal is forgotten too (a kill, a prune).
    wall.add('c', 80, 24);
    wall.groups.insertPane('a', 'c', 'down');
    wall.store.forget('a');
    expect(wall.store.group(gid).split.tree).toEqual({ id: 'c' });
});

test('a divider drag moves the cut within both minimums; an outer resize grows every pane', () => {
    const { wall, terminals } = fakeWall({ a: [100, 24] });
    wall.add('b', 80, 24);
    const gid = wall.groups.insertPane('a', 'b', 'right');
    const sr = wall.groups.splitRect(gid);
    wall.groups.dragDivider(gid, [], sr.minX + 30);
    expectFilled(wall, gid);
    expect(terminals.get('a').cols).toBeLessThan(terminals.get('b').cols);
    wall.groups.dragDivider(gid, [], sr.minX + 1);                   // held at a's 20 cells
    expect(terminals.get('a').cols).toBe(20);
    const before = terminals.get('b').cols;
    wall.groups.resizeSplit(gid, { ...sr, maxX: sr.maxX + 10 * SX });
    expect(terminals.get('b').cols).toBeGreaterThan(before);
    expectFilled(wall, gid);
    wall.groups.resizeSplit(gid, { ...sr, maxX: sr.minX + 1 });       // never under the panes' minimum
    const min = T.minSize(wall.groups.get(gid).split.tree, () => ({ w: 20 * SX + 2 * PAD, h: 5 * SY + 2 * PAD + 1.5 * SY }), 0.5);
    expect(wall.groups.get(gid).split.w).toBeCloseTo(min.w);
});

test("an inner border drags the divider beside it; an outer one the split", () => {
    const { wall } = fakeWall({ a: [80, 24] });
    wall.add('b', 80, 24);
    const gid = wall.groups.insertPane('a', 'b', 'right');
    expect(wall.groups.splitEdge('a', { right: true })).toMatchObject({ gid, outer: null, divider: { path: [], axis: 'x' } });
    expect(wall.groups.splitEdge('b', { left: true }).divider).toMatchObject({ path: [], axis: 'x' });
    expect(wall.groups.splitEdge('a', { left: true, top: true })).toMatchObject({ outer: { left: true, top: true, right: false, bottom: false }, divider: null });
});

test('bars toggle: hidden, the room goes and the panes re-wrap taller; back on, it returns', () => {
    const { wall, terminals, bars } = fakeWall({ a: [80, 24] });
    wall.add('b', 80, 24);
    const gid = wall.groups.insertPane('a', 'b', 'right');
    const rows = terminals.get('a').rows;
    wall.groups.setBars(gid, false);
    expect(bars.get('a')).toBe(0);
    expect(terminals.get('a').rows).toBe(rows + 1);                  // 1.5 rows of room freed: one more whole row
    expectFilled(wall, gid);
    wall.groups.setBars(gid, true);
    expect(terminals.get('a').rows).toBe(rows);
});

test('a tiled group becomes a split of even rows and back; leaving a split gives the title bars back', () => {
    const { wall, terminals, bars } = fakeWall({ a: [80, 24, 0, 0], b: [80, 24, 90, 0], c: [80, 24, 0, -60], d: [80, 24, 90, -60] });
    const gid = wall.groups.create(['a', 'b', 'c', 'd'], { layout: 'tile', columns: 2 });
    wall.groups.setLayout(gid, 'split');
    const g = wall.groups.get(gid);
    expect(T.leaves(g.split.tree)).toEqual(['a', 'b', 'c', 'd']);
    expectFilled(wall, gid);
    expect(T.neighbor(wall.groups.paneRects(gid), 'a', 'right')).toBe('b');
    expect(T.neighbor(wall.groups.paneRects(gid), 'a', 'down')).toBe('c');
    const size = { cols: terminals.get('a').cols, rows: terminals.get('a').rows };
    wall.groups.setLayout(gid, 'tile');
    expect(wall.groups.get(gid).split).toBe(null);
    expect({ cols: terminals.get('a').cols, rows: terminals.get('a').rows }).toEqual(size);   // sizes kept
    expect(bars.has('a')).toBe(false);                                // the usual bar again
});

test('the store keeps a split whole across a reload', () => {
    const { wall } = fakeWall({ a: [80, 24] });
    wall.add('b', 80, 24);
    const gid = wall.groups.insertPane('a', 'b', 'down');
    const back = new WallStore(8099);
    expect(back.group(gid)).toEqual(wall.store.group(gid));
    expect(back.group(gid).split.tree).toEqual({ dir: 'col', ratio: 0.5, a: { id: 'a' }, b: { id: 'b' } });
});

test('an Agent View open on a pane takes its share of that pane: the terminal re-wraps beside it, no neighbour under it; closing gives it back', () => {
    const { wall, terminals } = fakeWall({ a: [80, 24] });
    wall.add('b', 80, 24);
    wall.add('c', 80, 24);
    const gid = wall.groups.insertPane('a', 'b', 'right');
    wall.groups.insertPane('a', 'c', 'down');
    const dims = { width: 12, height: 8, gap: 0.5 };
    const open = new Map();
    const { agentInset, agentViewRect } = AV;
    wall.agents = { inset: (id) => agentInset(open.get(id) ?? null, dims) };
    const room = wall.config.splitBarRows * SY;
    const before = { cols: terminals.get('a').cols, rows: terminals.get('a').rows };
    for (const side of AV.AGENT_SIDES) {
        open.set('a', side);
        wall.groups.relayout(gid);
        const pr = wall.groups.paneRects(gid).get('a'), body = wall.terminalRect('a');
        const view = agentViewRect(body, room, side, dims);
        // The view and the terminal's window both sit inside a's pane …
        for (const r of [view, { ...body, maxY: body.maxY + room }]) {
            expect(r.minX).toBeGreaterThanOrEqual(pr.minX - 1e-9);
            expect(r.maxX).toBeLessThanOrEqual(pr.maxX + 1e-9);
            expect(r.minY).toBeGreaterThanOrEqual(pr.minY - 1e-9);
            expect(r.maxY).toBeLessThanOrEqual(pr.maxY + 1e-9);
        }
        // … so it covers no other pane's terminal.
        for (const other of ['b', 'c']) expect(overlaps(view, wall.windowRect(other))).toBe(false);
    }
    open.delete('a');
    wall.groups.relayout(gid);
    expect({ cols: terminals.get('a').cols, rows: terminals.get('a').rows }).toEqual(before);
    expectFilled(wall, gid);
});

test('a pane too small for its Agent View grows the split to fit, as a resize to the minimum does, and closing gives it back', () => {
    const { wall } = fakeWall({ a: [44, 24] });
    wall.add('b', 44, 24);
    const gid = wall.groups.insertPane('a', 'b', 'right');
    const w0 = wall.groups.get(gid).split.w;
    const dims = { width: 30, height: 8, gap: 0.5 };
    wall.agents = { inset: (id) => AV.agentInset(id === 'a' ? 'left' : null, dims) };
    wall.groups.relayout(gid);
    const g = wall.groups.get(gid);
    expect(g.split.w).toBeGreaterThan(w0);
    const pa = wall.groups.paneRects(gid).get('a'), body = wall.terminalRect('a');
    expect(body.minX - pa.minX).toBeCloseTo(30.5);                         // the view's room on the left
    expect(wall.terminal('a').cols).toBeGreaterThanOrEqual(20);
    expect(body.maxX).toBeLessThanOrEqual(pa.maxX + 1e-9);
    // Closing it gives the split back its old shape (size and divider), and both halves their old sizes.
    wall.agents = { inset: () => AV.agentInset(null, dims) };
    wall.groups.relayout(gid);
    expect(wall.groups.get(gid).split.w).toBe(w0);
    expect(wall.groups.get(gid).split.tree.ratio).toBe(0.5);
    expect(wall.terminal('a').cols).toBe(wall.terminal('b').cols);
    expectFilled(wall, gid);
});

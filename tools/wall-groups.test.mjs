// wall-groups.test.mjs — the wall's groups, headless, on a stand-in wall (terminals are plain rects):
// a group tiles its shown members from where they were gathered, re-tiles as members come, go, hide,
// show and change columns, moves whole, takes a dropped member into the nearest tile, leaves a
// freeform group's members where they are, and refuses what it can't do.
// Run: bun test tools/wall-groups.test.mjs
import { test, expect, beforeEach } from 'bun:test';

const mem = new Map();
globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
};
const { default: WallStore } = await import('../wall/WallStore.js');
const { default: WallGroups } = await import('../wall/WallGroups.js');
const { WALL_CONFIG } = await import('../wall/wallConfig.js');
const { tileLayout, BAR_ROOM } = await import('../wall/wallLayout.js');

/** A wall with terminals as w×h rects whose position is their body's top-left. */
function fakeWall(sizes) {
    const terminals = new Map(Object.entries(sizes).map(([id, [w, h, x = 0, y = 0]]) => [id, { position: { x, y }, w, h }]));
    const wall = {
        store: new WallStore(8099),
        config: { ...WALL_CONFIG, groupGap: 2 },
        emits: 0,
        _emit() { this.emits++; },
        terminal: (id) => terminals.get(id),
        isShown: (id) => terminals.has(id) && !wall.store.hidden(id),
        terminalRect(id) { const t = terminals.get(id); return { minX: t.position.x, maxX: t.position.x + t.w, maxY: t.position.y, minY: t.position.y - t.h }; },
        windowRect(id) { const r = this.terminalRect(id); return { ...r, maxY: r.maxY + BAR_ROOM }; },
        placeBody(id, p) { const t = terminals.get(id); t.position.x = p.x; t.position.y = p.y; },
        rememberPosition(id) { wall.store.setPosition(id, terminals.get(id).position); },
    };
    wall.groups = new WallGroups(wall, { atlas: null, scene: null });
    return wall;
}
const at = (w, id) => ({ ...w.terminal(id).position });

beforeEach(() => mem.clear());

test('a new group tiles its members in ⌈√n⌉ columns from where they were gathered, and remembers their spots', () => {
    const w = fakeWall({ a: [100, 50, 300, -40], b: [100, 50, 500, -90], c: [100, 50, 310, -200], d: [100, 50, 50, -60] });
    const gid = w.groups.create(['a', 'b', 'c', 'd']);
    expect(gid).toBe('g-1');
    const g = w.groups.get(gid);
    expect(g.columns).toBe(2);
    expect(g.origin).toEqual({ x: 50, y: -40 + BAR_ROOM });   // the bodies' top-left, a bar's room above
    const { places } = tileLayout(Array(4).fill({ w: 100, h: 50 }), { origin: g.origin, columns: 2, gap: 2 });
    expect(['a', 'b', 'c', 'd'].map((id) => at(w, id))).toEqual(places);
    expect(w.store.position('d')).toEqual(places[3]);
    expect(w.groups.nameOf(gid)).toBe('group 1');
    expect(w.groups.tiles('a')).toBe(true);
});

test('columns, hiding and showing re-tile; a shown member comes back to its own tile', () => {
    const w = fakeWall({ a: [100, 50], b: [100, 50], c: [100, 50] });
    const gid = w.groups.create(['a', 'b', 'c'], { columns: 3 });
    const before = ['a', 'b', 'c'].map((id) => at(w, id));
    expect(before[1].y).toBe(before[0].y);                       // one row
    w.groups.setColumns(gid, 1);
    expect(at(w, 'b').x).toBe(at(w, 'a').x);                      // one column
    w.groups.setColumns(gid, 3);
    w.store.setHidden('b', true); w.groups.relayoutOf('b');
    expect(at(w, 'c')).toEqual(before[1]);                        // c closes the gap
    w.store.setHidden('b', false); w.groups.relayoutOf('b');
    expect(['a', 'b', 'c'].map((id) => at(w, id))).toEqual(before);
});

test('a group moves whole — members and tiling — and keeps where it was left', () => {
    const w = fakeWall({ a: [100, 50], b: [100, 50] });
    const gid = w.groups.create(['a', 'b']);
    const a0 = at(w, 'a'), o0 = { ...w.groups.get(gid).origin };
    w.groups.move(gid, 30, -20);
    expect(at(w, 'a')).toEqual({ x: a0.x + 30, y: a0.y - 20 });
    expect(w.groups.get(gid).origin).toEqual({ x: o0.x + 30, y: o0.y - 20 });
    expect(w.store.position('a')).toEqual(at(w, 'a'));
    w.groups.relayout(gid);                                       // and a re-tile lands it there again
    expect(at(w, 'a')).toEqual({ x: a0.x + 30, y: a0.y - 20 });
});

test('a tiled member dropped elsewhere takes the nearest tile; the others shift along', () => {
    const w = fakeWall({ a: [100, 50], b: [100, 50], c: [100, 50] });
    const gid = w.groups.create(['a', 'b', 'c'], { columns: 3 });
    const places = ['a', 'b', 'c'].map((id) => at(w, id));
    w.terminal('a').position = { x: places[2].x + 10, y: places[2].y - 5 };   // dragged over the third tile
    w.groups.dropMember('a');
    expect(w.groups.get(gid).members).toEqual(['b', 'c', 'a']);
    expect(['b', 'c', 'a'].map((id) => at(w, id))).toEqual(places);
});

test('removing, ungrouping and regrouping: members stay where they are; an emptied group goes', () => {
    const w = fakeWall({ a: [100, 50], b: [100, 50], c: [100, 50] });
    const g1 = w.groups.create(['a', 'b', 'c'], { columns: 3 });
    const cAt = at(w, 'c');
    w.groups.remove(['c']);
    expect(w.groups.get(g1).members).toEqual(['a', 'b']);
    expect(at(w, 'c')).toEqual(cAt);
    const g2 = w.groups.create(['a', 'b'], { layout: 'freeform' });
    expect(w.store.group(g1)).toBeNull();                          // its members left: it went
    expect(w.groups.groupOf('a')).toBe(g2);
    const aAt = at(w, 'a');
    w.groups.ungroup(g2);
    expect(w.groups.groupOf('a')).toBeNull();
    expect(at(w, 'a')).toEqual(aAt);
});

test('a freeform group leaves its members where they are; switching to tile starts at their top-left', () => {
    const w = fakeWall({ a: [100, 50, 0, 0], b: [80, 40, 400, -300] });
    const gid = w.groups.create(['a', 'b'], { layout: 'freeform' });
    expect(at(w, 'b')).toEqual({ x: 400, y: -300 });
    expect(w.groups.tiles('b')).toBe(false);
    w.groups.setLayout(gid, 'tile', { columns: 2 });
    expect(at(w, 'a')).toEqual({ x: 0, y: 0 });
    expect(at(w, 'b')).toEqual({ x: 102, y: 0 });
    w.groups.setLayout(gid, 'freeform');
    expect(at(w, 'b')).toEqual({ x: 102, y: 0 });                 // freeform keeps where the tiling left it
});

test('it refuses what it cannot do, and says why', () => {
    const w = fakeWall({ a: [100, 50] });
    expect(() => w.groups.create([])).toThrow(/at least one/);
    expect(() => w.groups.create(['nope'])).toThrow(/no terminal 'nope'/);
    const gid = w.groups.create(['a']);
    expect(() => w.groups.setColumns(gid, 0)).toThrow(/columns/);
    expect(() => w.groups.setLayout(gid, 'grid')).toThrow(/tile' or 'freeform/);
    expect(() => w.groups.get('g-9')).toThrow(/no group 'g-9'/);
    expect(() => w.groups.remove(['a', 'a'])).not.toThrow();
    expect(() => w.groups.remove(['a'])).toThrow(/in no group/);
});

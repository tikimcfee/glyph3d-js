// wall-store.test.mjs — the wall's durable names, spots, hidden terminals, groups and sidebar: scoped
// per relay (ids are each relay's own), pruned against the relay's live terminals (ids recycle once a
// session is gone; a group loses its dead members and goes with its last), forgotten on purpose by a
// kill, and round-tripped through storage. Run: bun test tools/wall-store.test.mjs
import { test, expect, beforeEach } from 'bun:test';

const mem = new Map();
globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
};
const { default: WallStore } = await import('../wall/WallStore.js');

beforeEach(() => mem.clear());

test('each relay port has its own names and spots', () => {
    const a = new WallStore(8099), b = new WallStore(8093);
    a.setName('term-1', 'build');
    a.setPosition('term-1', { x: 3, y: -4 });
    expect(b.name('term-1')).toBeNull();
    expect(b.position('term-1')).toBeNull();
    expect(new WallStore(8099).name('term-1')).toBe('build');           // durable, per relay
    expect(JSON.parse(mem.get(a.keys.positions))).toEqual({ 'term-1': { x: 3, y: -4 } });
    expect(a.keys.names).not.toBe(b.keys.names);
});

test('prune forgets every terminal the relay no longer has, keeps the live ones', () => {
    const s = new WallStore(8099);
    s.setName('term-1', 'build'); s.setPosition('term-1', { x: 1, y: 1 });
    s.setName('term-2', 'logs');
    s.setPosition('term-3', { x: 2, y: 2 });
    expect(s.prune(new Set(['term-2'])).sort()).toEqual(['term-1', 'term-3']);
    expect(s.name('term-1')).toBeNull();
    expect(s.position('term-1')).toBeNull();
    expect(s.position('term-3')).toBeNull();
    expect(s.name('term-2')).toBe('logs');
    const again = new WallStore(8099);                                   // and it's written through
    expect(again.name('term-1')).toBeNull();
    expect(again.name('term-2')).toBe('logs');
});

test('forget drops one terminal now', () => {
    const s = new WallStore(8099);
    s.setName('term-5', 'db'); s.setPosition('term-5', { x: 0, y: 0 });
    s.forget('term-5');
    expect(s.name('term-5')).toBeNull();
    expect(s.position('term-5')).toBeNull();
});

const group = (members, o = {}) => ({ name: '', layout: 'tile', columns: 2, gap: 2, origin: { x: 0, y: 0 }, members, ...o });

test('hidden terminals, groups and the sidebar round-trip through storage, per relay', () => {
    const s = new WallStore(8099);
    s.setHidden('term-2', true);
    s.setGroup(s.newGroupId(), group(['term-1', 'term-2'], { name: 'build' }));
    s.setGroup(s.newGroupId(), group(['term-3'], { layout: 'freeform', origin: null }));
    s.setSidebar({ open: true, side: 'left', collapsed: ['g-1'] });
    const back = new WallStore(8099);
    expect(back.hidden('term-2')).toBe(true);
    expect(back.hidden('term-1')).toBe(false);
    expect(back.groups()).toEqual({
        'g-1': group(['term-1', 'term-2'], { name: 'build' }),
        'g-2': group(['term-3'], { layout: 'freeform', origin: null }),
    });
    expect(back.groupOf('term-3')).toBe('g-2');
    expect(back.sidebar()).toEqual({ open: true, side: 'left', float: { x: 80, y: 80 }, collapsed: ['g-1'] });
    expect(new WallStore(8093).groups()).toEqual({});                    // another relay's are its own
    expect(new WallStore(8093).sidebar().open).toBe(false);
    expect(back.newGroupId()).toBe('g-3');
});

test('a terminal is in one group at most: joining another takes it out of the first, which goes when emptied', () => {
    const s = new WallStore(8099);
    s.setGroup('g-1', group(['term-1', 'term-2']));
    s.setGroup('g-2', group(['term-3']));
    s.setGroup('g-2', group(['term-3', 'term-2']));
    expect(s.group('g-1').members).toEqual(['term-1']);
    s.setSidebar({ collapsed: ['g-1'] });
    s.setGroup('g-2', group(['term-3', 'term-2', 'term-1']));
    expect(s.group('g-1')).toBeNull();
    expect(s.sidebar().collapsed).toEqual([]);                           // a gone group isn't folded
    expect(new WallStore(8099).group('g-1')).toBeNull();
});

test('prune drops dead members from groups, the groups left empty, and dead hidden marks', () => {
    const s = new WallStore(8099);
    s.setGroup('g-1', group(['term-1', 'term-2']));
    s.setGroup('g-2', group(['term-3']));
    s.setHidden('term-2', true);
    s.setHidden('term-4', true);
    expect(s.prune(new Set(['term-1'])).sort()).toEqual(['term-2', 'term-3', 'term-4']);
    expect(s.group('g-1').members).toEqual(['term-1']);
    expect(s.group('g-2')).toBeNull();
    expect(s.hidden('term-2')).toBe(false);
    expect(s.hidden('term-4')).toBe(false);
    const again = new WallStore(8099);
    expect(Object.keys(again.groups())).toEqual(['g-1']);
    expect(again.hidden('term-4')).toBe(false);
});

test('a kill (forget) takes the terminal out of its group and unhides it', () => {
    const s = new WallStore(8099);
    s.setGroup('g-1', group(['term-1']));
    s.setHidden('term-1', true);
    s.forget('term-1');
    expect(s.group('g-1')).toBeNull();
    expect(s.hidden('term-1')).toBe(false);
    expect(s.groupOf('term-1')).toBeNull();
});

// wall-store.test.mjs — the wall's durable names + spots: scoped per relay (ids are each relay's
// own), pruned against the relay's live terminals (ids recycle once a session is gone), forgotten on
// purpose by a kill. Run: bun test tools/wall-store.test.mjs
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

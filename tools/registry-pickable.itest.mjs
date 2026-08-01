#!/usr/bin/env bun
// registry-pickable.itest — the incremental pickable index on SceneRegistry.
// Pure JS (no three/browser): the index bookkeeping is the risky part, so test it
// directly. The input layer's hover wire reads registry.pickables() each change.
//   bun tools/registry-pickable.itest.mjs

import SceneRegistry from '../packages/glyph3d-core/src/services/SceneRegistry.js';

let pass = 0, fail = 0;
const ids = (r) => r.pickables().map((e) => e.id).sort();
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function check(name, cond, got) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}  got ${JSON.stringify(got)}`); }
}
const obj = (n) => ({ name: n });

// 1 — default pickable types: grid/terminal/frame in, others out
{
    const r = new SceneRegistry();
    r.register('g1', obj('g1'), { type: 'grid' });
    r.register('t1', obj('t1'), { type: 'terminal' });
    r.register('f1', obj('f1'), { type: 'frame' });
    r.register('a1', obj('a1'), { type: 'annotation' });   // not pickable
    check('default pickables = grid/terminal/frame', eq(ids(r), ['f1', 'g1', 't1']), ids(r));
}

// 2 — setPickable back-fills existing AND admits new entries of the type
{
    const r = new SceneRegistry();
    r.register('tg1', obj('tg1'), { type: 'book.group' });   // registered BEFORE opt-in
    check('book.group not pickable yet', eq(ids(r), []), ids(r));
    r.setPickable('book.group');
    check('setPickable back-fills existing', eq(ids(r), ['tg1']), ids(r));
    r.register('tg2', obj('tg2'), { type: 'book.group' });   // new, after opt-in
    check('new entry of opted-in type is pickable', eq(ids(r), ['tg1', 'tg2']), ids(r));
}

// 3 — unregister + unregisterByType prune the index
{
    const r = new SceneRegistry();
    r.register('g1', obj('g1'), { type: 'grid' });
    r.register('g2', obj('g2'), { type: 'grid' });
    r.register('t1', obj('t1'), { type: 'terminal' });
    r.unregister('g1');
    check('unregister prunes pickable', eq(ids(r), ['g2', 't1']), ids(r));
    r.unregisterByType('grid');
    check('unregisterByType prunes pickable', eq(ids(r), ['t1']), ids(r));
}

// 4 — register overwrite swaps the entry object cleanly (no stale ref left pickable)
{
    const r = new SceneRegistry();
    r.register('x', obj('old'), { type: 'grid' });
    const before = r.pickables()[0];
    r.register('x', obj('new'), { type: 'grid' });   // overwrite same id
    const after = r.pickables();
    check('overwrite keeps exactly one pickable for the id', after.length === 1, after.length);
    check('overwrite replaced the entry (no stale ref)', after[0] !== before && after[0].grid.name === 'new', after[0]?.grid?.name);
}

// 5 — setPickable(type, false) removes a type from the index
{
    const r = new SceneRegistry();
    r.register('f1', obj('f1'), { type: 'frame' });
    r.register('g1', obj('g1'), { type: 'grid' });
    r.setPickable('frame', false);
    check('setPickable off removes the type', eq(ids(r), ['g1']), ids(r));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

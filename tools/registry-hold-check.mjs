// registry-hold-check.mjs — SceneRegistry.holdChanges: the bulk-load notification
// window. Listeners are state-scanners, so N mutations inside a hold must produce
// ONE fire per distinct type at the outermost close (plus explicit flushHeld
// heartbeats) — never the per-grid listener storm a launch used to pay.
//
//   bun tools/registry-hold-check.mjs

import SceneRegistry from '../packages/glyph3d-core/src/services/SceneRegistry.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}\n      got  ${JSON.stringify(a)}\n      want ${JSON.stringify(b)}`);

const mk = () => {
    const reg = new SceneRegistry();
    const fires = [];
    reg.addChangeListener((t) => fires.push(t));
    return { reg, fires };
};
const grid = () => ({});

// One fire per DISTINCT type at close, however many mutations happened.
{
    const { reg, fires } = mk();
    reg.holdChanges(() => {
        for (let i = 0; i < 50; i++) reg.register(`g${i}`, grid(), { type: 'grid' });
        for (let i = 0; i < 5; i++) reg.register(`t${i}`, grid(), { type: 'terminal' });
    });
    eq(fires.sort(), ['grid', 'terminal'], 'hold: 55 registrations → one fire per distinct type');
    eq(reg.size, 55, 'hold: every mutation landed');
}

// Outside a hold, every mutation fires (the interactive path is untouched).
{
    const { reg, fires } = mk();
    reg.register('a', grid(), { type: 'grid' });
    reg.register('b', grid(), { type: 'grid' });
    eq(fires.length, 2, 'no hold: per-mutation fires as before');
}

// flushHeld is the mid-stream heartbeat: fires what's recorded, keeps holding.
{
    const { reg, fires } = mk();
    reg.holdChanges(() => {
        reg.register('a', grid(), { type: 'grid' });
        reg.flushHeld();
        eq(fires, ['grid'], 'flushHeld: fires mid-hold');
        reg.register('b', grid(), { type: 'grid' });
        eq(fires.length, 1, 'flushHeld: hold continues after the heartbeat');
    });
    eq(fires.length, 2, 'hold close fires what accrued after the heartbeat');
}

// Nested holds coalesce to the OUTERMOST close; async fn supported.
{
    const { reg, fires } = mk();
    await reg.holdChanges(async () => {
        reg.register('a', grid(), { type: 'grid' });
        await reg.holdChanges(async () => reg.register('b', grid(), { type: 'terminal' }));
        eq(fires.length, 0, 'nested: inner close does not fire');
    });
    eq(fires.sort(), ['grid', 'terminal'], 'nested: outermost close fires everything once');
}

// A throw still closes the hold and fires what was recorded.
{
    const { reg, fires } = mk();
    try { reg.holdChanges(() => { reg.register('a', grid(), { type: 'grid' }); throw new Error('boom'); }); }
    catch { /* expected */ }
    eq(fires, ['grid'], 'throw: the hold closes and fires');
    reg.register('b', grid(), { type: 'grid' });
    eq(fires.length, 2, 'throw: the registry is not left held');
}

// An empty window fires nothing; unregister coalesces the same way.
{
    const { reg, fires } = mk();
    reg.holdChanges(() => {});
    eq(fires.length, 0, 'empty window: silent');
    reg.register('a', grid(), { type: 'grid' });
    reg.register('b', grid(), { type: 'grid' });
    fires.length = 0;
    reg.holdChanges(() => { reg.unregister('a'); reg.unregister('b'); });
    eq(fires, ['grid'], 'removal hold: one fire for the batch');
    eq(reg.size, 0, 'removal hold: entries gone');
}

// The meta index: findByMeta answers from a maintained index (armed on first
// query of a key), matching the old linear scan's semantics exactly — including
// re-register, unregister, unregisterByType, and the undefined-value match.
{
    const { reg } = mk();
    const a = grid(), b = grid(), c = grid();
    reg.register('a', a, { type: 'grid', sourcePath: 'file:///x/a.js' });
    reg.register('b', b, { type: 'grid', sourcePath: 'file:///x/b.js' });
    reg.register('c', c, { type: 'terminal' });   // no sourcePath at all
    eq(reg.findByMeta('sourcePath', 'file:///x/a.js').map((e) => e.id), ['a'], 'meta: exact match');
    eq(reg.findByMeta('sourcePath', 'file:///x/nope.js').length, 0, 'meta: miss is empty');
    // The scan matched entries LACKING the key when value is undefined — the index must too.
    eq(reg.findByMeta('sourcePath', undefined).map((e) => e.id), ['c'], 'meta: undefined matches keyless');

    // Registrations AFTER the index armed still land in it.
    reg.register('d', grid(), { type: 'grid', sourcePath: 'file:///x/d.js' });
    eq(reg.findByMeta('sourcePath', 'file:///x/d.js').map((e) => e.id), ['d'], 'meta: post-arm register indexed');

    // Re-register under the same id with a DIFFERENT sourcePath: old value unindexed.
    reg.register('a', a, { type: 'grid', sourcePath: 'file:///y/a.js' });
    eq(reg.findByMeta('sourcePath', 'file:///x/a.js').length, 0, 'meta: re-register drops the old value');
    eq(reg.findByMeta('sourcePath', 'file:///y/a.js').map((e) => e.id), ['a'], 'meta: re-register indexes the new value');

    // unregister + unregisterByType both unindex.
    reg.unregister('b');
    eq(reg.findByMeta('sourcePath', 'file:///x/b.js').length, 0, 'meta: unregister unindexes');
    reg.unregisterByType('grid');
    eq(reg.findByMeta('sourcePath', 'file:///y/a.js').length, 0, 'meta: unregisterByType unindexes');
    eq(reg.findByMeta('sourcePath', undefined).map((e) => e.id), ['c'], 'meta: survivors still answer');

    // A second key arms independently.
    reg.register('e', grid(), { type: 'grid', owner: 'client-1' });
    eq(reg.findByMeta('owner', 'client-1').map((e) => e.id), ['e'], 'meta: second key arms on demand');
}

console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

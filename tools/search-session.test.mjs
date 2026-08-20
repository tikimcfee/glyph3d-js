// search-session.test.mjs — headless behavior lock for SearchSession, the browser
// half of directory content search (the cache + lifecycle behind the search book).
//
//   bun tools/search-session.test.mjs
//
// The invariants that matter are all about STATE THIS OBJECT SET, THIS OBJECT UNSETS:
// a cancelled or disposed run must stop writing into the cache even though its
// notifications are already in flight, a refinement must not blend with the query it
// replaced, and clear/dispose must leave nothing behind. Those are exactly the
// failures that don't reproduce by hand — so they are locked here, with no GPU, no
// relay, and no scene: a fake provider and a fake bridge are the whole world.

import SearchSession from '../packages/glyph3d-core/src/services/data/SearchSession.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };
const tick = () => new Promise((r) => setTimeout(r, 5));

/** A bridge whose notification fan-out the test drives by hand. */
function fakeBridge() {
    const handlers = new Set();
    return {
        handlers,
        onRpcNotification(fn) { handlers.add(fn); return () => handlers.delete(fn); },
        emit(method, params) { for (const fn of [...handlers]) fn(method, params); },
    };
}

/** A provider that records the RPCs it was asked to make. */
function fakeProvider({ failStart = false } = {}) {
    const calls = { search: [], cancel: [] };
    return {
        calls,
        async search(params) {
            calls.search.push(params);
            if (failStart) throw new Error('bad pattern');
            return { id: params.id, base: '/proj', started: true };
        },
        async cancelSearch(id) { calls.cancel.push(id); return { id, cancelled: true }; },
    };
}

const mk = (opts) => {
    const bridge = fakeBridge();
    const provider = fakeProvider(opts);
    const session = new SearchSession({ getProvider: () => provider, getBridge: () => bridge, id: 's' });
    return { bridge, provider, session };
};

const match = (path, line, col = 0, length = 3, text = 'x') => ({ path, line, col, length, text });

// ── a run streams into a grouped cache ──
{
    const { bridge, session } = mk();
    await session.start('needle');
    const runId = session.runId;
    ok(session.state === 'running', 'state is running after start');

    bridge.emit('fs/searchMatch', { id: runId, matches: [match('a.js', 0), match('a.js', 4), match('b.js', 2)] });
    ok(session.total === 3, `3 matches cached (got ${session.total})`);
    ok(session.fileCount === 2, `grouped into 2 files (got ${session.fileCount})`);
    ok(session.fileAt(0).path === 'a.js' && session.fileAt(0).matches.length === 2, 'a.js holds both of its hits');
    ok(session.files[0].path === 'a.js' && session.files[1].path === 'b.js', 'files keep first-match order');

    bridge.emit('fs/searchDone', { id: runId, scanned: 9, matched: 3, truncated: false, cancelled: false });
    ok(session.state === 'done', 'done notification lands the terminal state');
    ok(session.scanned === 9, 'scanned reported');
    ok(session.runId === null, 'run id retired on done');
}

// ── the window is a clamped slice — the book's page address space ──
{
    const { bridge, session } = mk();
    await session.start('q');
    bridge.emit('fs/searchMatch', { id: session.runId, matches: Array.from({ length: 10 }, (_, i) => match(`f${i}.js`, 0)) });
    ok(session.window(0, 4).length === 4, 'a full window is the requested size');
    ok(session.window(8, 4).length === 2, 'a window past the end is SHORT, not padded');
    ok(session.window(50, 4).length === 0, 'a window entirely past the end is empty');
    ok(session.window(-5, 3)[0].path === 'f0.js', 'a negative start clamps to 0');
}

// ── a cancelled run stops writing, but KEEPS what it found ──
{
    const { bridge, provider, session } = mk();
    await session.start('needle');
    const runId = session.runId;
    bridge.emit('fs/searchMatch', { id: runId, matches: [match('a.js', 0)] });

    await session.cancel();
    ok(session.state === 'cancelled', 'state is cancelled');
    ok(provider.calls.cancel[0] === runId, 'the relay was told to stop THIS run');
    ok(session.total === 1, 'a cancel keeps the results already found');

    // The batches already in flight when the cancel went out still arrive.
    bridge.emit('fs/searchMatch', { id: runId, matches: [match('c.js', 0), match('d.js', 0)] });
    ok(session.total === 1, 'in-flight matches for a cancelled run are DROPPED, not merged');
    bridge.emit('fs/searchDone', { id: runId, scanned: 99, matched: 3, truncated: true, cancelled: true });
    ok(session.state === 'cancelled' && session.scanned === 0, 'a retired run cannot write the terminal state either');
}

// ── a refinement replaces the old answer and cannot blend with it ──
{
    const { bridge, session } = mk();
    await session.start('alpha');
    const first = session.runId;
    bridge.emit('fs/searchMatch', { id: first, matches: [match('a.js', 0), match('b.js', 0)] });
    ok(session.total === 2, 'first run cached');

    await session.start('bravo');
    const second = session.runId;
    ok(second !== first, 'a refinement mints a NEW run id');
    ok(session.total === 0 && session.fileCount === 0, 'the refinement starts from an empty cache');

    // The superseded run's last batch lands late. It must not appear in the new results.
    bridge.emit('fs/searchMatch', { id: first, matches: [match('stale.js', 0)] });
    ok(session.total === 0, 'a superseded run\'s late batch is dropped');

    bridge.emit('fs/searchMatch', { id: second, matches: [match('fresh.js', 0)] });
    ok(session.fileCount === 1 && session.fileAt(0).path === 'fresh.js', 'only the live run fills the cache');
}

// ── clear() returns to idle with nothing held ──
{
    const { bridge, session } = mk();
    await session.start('q');
    bridge.emit('fs/searchMatch', { id: session.runId, matches: [match('a.js', 0)] });
    await session.clear();
    ok(session.state === 'idle', 'clear → idle');
    ok(session.total === 0 && session.fileCount === 0 && session.base === '', 'clear drops the whole cache');
    ok(session.params === null, 'clear forgets the query');
}

// ── dispose() unsubscribes: a disposed session is inert ──
{
    const { bridge, provider, session } = mk();
    await session.start('q');
    const runId = session.runId;
    ok(bridge.handlers.size === 1, 'subscribed to the match stream while live');

    session.dispose();
    ok(bridge.handlers.size === 0, 'dispose unsubscribes from the bridge');
    ok(provider.calls.cancel.includes(runId), 'dispose cancels the in-flight walk');

    bridge.emit('fs/searchMatch', { id: runId, matches: [match('a.js', 0)] });
    ok(session.total === 0, 'a disposed session ingests nothing');
    session.dispose();
    ok(true, 'dispose is idempotent');
}

// ── a start that cannot start reports it, and does not strand the state ──
{
    const { session } = mk({ failStart: true });
    let threw = false;
    try { await session.start('a('); } catch (_e) { threw = true; }
    ok(threw, 'a failed start rejects');
    ok(session.state === 'error', 'a failed start lands in error, NOT a permanent running');
    ok(session.runId === null, 'a failed start holds no run');
}

// ── change notifications are coalesced, not per-batch ──
{
    const { bridge, session } = mk();
    let fires = 0;
    session.onChange(() => fires++);
    await session.start('q');
    for (let i = 0; i < 20; i++) bridge.emit('fs/searchMatch', { id: session.runId, matches: [match(`f${i}.js`, 0)] });
    await tick();
    ok(session.fileCount === 20, 'every batch landed in the cache');
    ok(fires <= 2, `20 batches coalesced into ≤2 notifications (got ${fires})`);
}

// ── unrelated notifications on the shared channel are ignored ──
{
    const { bridge, session } = mk();
    await session.start('q');
    bridge.emit('fs/didChange', { id: session.runId, uri: 'file:///a.js' });
    bridge.emit('textDocument/publishDiagnostics', { id: session.runId });
    ok(session.total === 0 && session.state === 'running', 'other subsystems\' notifications pass through untouched');
}

console.log(`\n${fail === 0 ? '✓' : '✗'} search-session: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

// command-caller.test.mjs — the caller is PER CALL (CommandRouter): each handler sees its own
// sender / caller / cid however calls interleave, and a nested call inherits the outer one.
//
//   bun tools/command-caller.test.mjs
//
// Locks:
//   - two async verbs from two senders, interleaved across awaits, each read their own identity
//     before and after the other ran
//   - a nested call (ctx.execute, and a raw router.execute inside a handler's synchronous span)
//     inherits the outer sender and caller; an explicit option overrides; a top-level call after
//     it is anonymous again
//   - writes through ctx land in the shared bag (handlers keep state there); the call's own
//     fields are read-only
//   - teeth: the same checks against the old shared-ctx dispatch (sender written onto the one bag)
//     must FAIL

import CommandRouter from '../packages/glyph3d-core/src/services/orchestration/CommandRouter.js';

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };

const tick = () => new Promise((r) => setTimeout(r, 1));

/** A router with the probe verbs; returns what each saw. @param {boolean} shared the old dispatch */
async function scenario(shared) {
    const bag = { sender: null, caller: null, cid: 0, execute: null, counter: 0 };
    const router = new CommandRouter(bag);
    if (shared) {
        // The old dispatch: the call's identity written onto the ONE shared bag.
        router._viewFor = (frame) => { Object.assign(bag, { sender: frame.sender, caller: frame.caller, cid: frame.cid, execute: (i, o = {}) => router.execute(i, { ...o, parent: frame }) }); return bag; };
    }
    const seen = {};
    router.register('probe.slow', async (args, ctx) => {
        const before = { sender: ctx.sender, caller: ctx.caller, cid: ctx.cid };
        await tick(); await tick();
        const after = { sender: ctx.sender, caller: ctx.caller, cid: ctx.cid };
        seen[args[0]] = { before, after };
        return { text: 'OK', data: null };
    });
    router.register('probe.who', (args, ctx) => {
        seen[args[0]] = { sender: ctx.sender, caller: ctx.caller, parent: ctx.cid };
        return { text: 'OK', data: { sender: ctx.sender, caller: ctx.caller } };
    });
    router.register('probe.nest', async (_args, ctx) => {
        router.execute(['probe.who', 'raw-sync']);            // a service's raw call, synchronous span
        await tick();
        await ctx.execute(['probe.who', 'nested-after-await']);
        await ctx.execute(['probe.who', 'nested-override'], { caller: 'someone-else' });
        ctx.counter += 1;                                      // shared state, written through the view
        return { text: 'OK', data: null };
    });
    // Two senders, interleaved: A starts, B starts, both await, both finish.
    await Promise.all([
        router.execute(['probe.slow', 'A'], { sender: 'ctrl-1', caller: 'agent-a' }),
        router.execute(['probe.slow', 'B'], { sender: 'ctrl-2', caller: 'agent-b' }),
    ]);
    await router.execute(['probe.nest'], { sender: 'ctrl-3', caller: 'agent-c' });
    await router.execute(['probe.who', 'top-anon']);
    let threw;
    router.register('probe.write', (_a, ctx) => { ctx.sender = 'forged'; return 'OK'; });
    const err = console.error, log = console.log;
    console.error = () => {}; console.log = () => {};   // the error tracker reports the throw; expected here
    const w = await router.execute(['probe.write'], { sender: 'ctrl-4' });
    console.error = err; console.log = log;
    threw = w.text.startsWith('ERR:');
    return { seen, bag, threw };
}

// The per-call dispatch.
{
    const { seen, bag, threw } = await scenario(false);
    ok(seen.A.before.sender === 'ctrl-1' && seen.A.after.sender === 'ctrl-1', `A sees its own sender across awaits (${JSON.stringify(seen.A)})`);
    ok(seen.B.before.sender === 'ctrl-2' && seen.B.after.sender === 'ctrl-2', `B sees its own sender across awaits (${JSON.stringify(seen.B)})`);
    ok(seen.A.after.caller === 'agent-a' && seen.B.after.caller === 'agent-b', 'each sees its own caller name');
    ok(seen.A.before.cid === seen.A.after.cid && seen.A.after.cid !== seen.B.after.cid, 'each keeps its own cid');
    ok(seen['raw-sync'].sender === 'ctrl-3' && seen['raw-sync'].caller === 'agent-c', `a raw router.execute in a handler's synchronous span inherits (${JSON.stringify(seen['raw-sync'])})`);
    ok(seen['nested-after-await'].sender === 'ctrl-3' && seen['nested-after-await'].caller === 'agent-c', `ctx.execute after an await inherits (${JSON.stringify(seen['nested-after-await'])})`);
    ok(seen['nested-override'].caller === 'someone-else' && seen['nested-override'].sender === 'ctrl-3', 'an explicit option overrides, the rest inherits');
    ok(seen['top-anon'].sender === null && seen['top-anon'].caller === null, `a top-level call after them is anonymous (${JSON.stringify(seen['top-anon'])})`);
    ok(bag.counter === 1, 'a write through ctx lands in the shared bag');
    ok(bag.sender === null && bag.caller === null, 'the shared bag never carries a call identity');
    ok(threw, "writing the call's own sender throws (and the verb says ERR)");
}

// Teeth: the old shared-ctx dispatch fails the interleaving and the after-await nesting.
{
    const { seen } = await scenario(true);
    const interleaved = seen.A.after.sender === 'ctrl-1' && seen.B.after.sender === 'ctrl-2' && seen.A.before.sender === 'ctrl-1';
    ok(!interleaved, `teeth: the shared ctx mixes up interleaved senders (A after: ${seen.A.after.sender})`);
    ok(seen['top-anon'].sender === null, 'teeth sanity: the shared variant still runs');
}

console.log(`${fails ? 'FAIL' : 'ok'} command-caller: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);

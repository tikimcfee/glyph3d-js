// multica-flow.test.mjs — behavior lock for the Multica binding.
//
//   bun tools/multica-flow.test.mjs                     bridge mapping only (no backend)
//   MULTICA_URL=http://localhost:8099 \
//   MULTICA_TOKEN=... MULTICA_WORKSPACE=... \
//     bun tools/multica-flow.test.mjs                   + the live round trip
//
// Two halves. The mapping half is the one that must never regress: it pins which
// glyph3d verb each Multica event becomes, driving MulticaBridge with a fake socket
// and a recording `execute`. The live half runs only when a backend is configured
// (tools/multica-up.sh prints the values) and proves the wire shapes we encoded are
// the ones a real server actually speaks — envelope keys, PUT-not-PATCH, 1-based
// stages.

import { MulticaClient, MulticaBridge, bookIdForAgent } from '../packages/glyph3d-multica/src/index.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };

/** A socket stand-in: records subscriptions, lets a test push frames synchronously. */
class FakeSocket {
    constructor() { this.handlers = new Map(); this.any = new Set(); this.authenticated = true; }
    on(type, fn) {
        if (!this.handlers.has(type)) this.handlers.set(type, new Set());
        this.handlers.get(type).add(fn);
        return () => this.handlers.get(type).delete(fn);
    }
    onAny(fn) { this.any.add(fn); return () => this.any.delete(fn); }
    /** @returns {Promise<void>} resolves once every handler's async work settled */
    async emit(type, payload) {
        for (const fn of this.handlers.get(type) || []) await fn(payload, { type, payload });
        for (const fn of this.any) fn({ type, payload });
    }
}

/** A client stand-in returning fixed rosters. */
const fakeClient = (agents = [], issues = []) => ({
    listAgents: async () => agents,
    listIssues: async () => issues,
    listChildren: async () => [],
});

const AGENT = { id: 'aaaaaaaa-1111-2222-3333-444444444444', name: 'Cartographer', status: 'idle', runtime_id: 'rt-1' };
const BOOK = bookIdForAgent(AGENT.id);

/** Build a started bridge over fakes, recording every dispatched command. */
async function harness({ agents = [AGENT], issues = [] } = {}) {
    const calls = [];
    const socket = new FakeSocket();
    const bridge = new MulticaBridge({
        client: fakeClient(agents, issues),
        socket,
        execute: async (input) => { calls.push(input); return { text: 'ok', data: null }; },
    });
    const counts = await bridge.start();
    return { calls, socket, bridge, counts };
}

const verbs = (calls) => calls.map(c => c[0]);
const find = (calls, verb) => calls.filter(c => c[0] === verb);

// ── hydration: every agent becomes a book with provenance ────────────────────
{
    const { calls, counts } = await harness();
    ok(counts.agents === 1, `one agent bound (got ${counts.agents})`);
    ok(verbs(calls).includes('agent.spawn'), 'hydration spawns a book');

    const spawn = find(calls, 'agent.spawn')[0];
    ok(spawn[1] === BOOK && spawn[2] === 'multica', `book id + source stamped (got ${spawn.slice(1).join(' ')})`);

    const meta = find(calls, 'agent.meta')[0];
    const parsed = JSON.parse(meta[2]);
    ok(parsed.title === 'Cartographer', 'meta carries the display name for the nameplate');
    ok(parsed.multica_agent_id === AGENT.id, 'meta keeps the full agent id for round-tripping');
}

// ── status → book lifecycle state ────────────────────────────────────────────
{
    const cases = [
        ['working', 'active'],
        ['idle', 'idle'],
        ['blocked', 'stalled'],
        ['error', 'stalled'],
        ['offline', 'idle'],
    ];
    for (const [status, expected] of cases) {
        const { calls, socket } = await harness();
        const before = find(calls, 'agent.state').length;
        await socket.emit('agent:status', { id: AGENT.id, status });
        const states = find(calls, 'agent.state');
        ok(states.length > before && states.at(-1)[2] === expected,
            `agent:status ${status} → agent.state ${expected} (got ${states.at(-1)?.[2]})`);
    }
}

// ── task lifecycle → activity + state, on the right book ─────────────────────
{
    const { calls, socket } = await harness();
    await socket.emit('task:running', { agent_id: AGENT.id, id: 'task-1', title: 'Survey the API surface' });

    const activity = find(calls, 'agent.activity').at(-1);
    ok(activity[1] === BOOK, 'task activity lands on the agent\'s book');
    ok(activity[3] === 'run', `task:running → 'run' action (got ${activity[3]})`);
    ok(activity.includes('Survey the API surface'), 'the task title rides through unquoted');
    ok(find(calls, 'agent.state').at(-1)[2] === 'active', 'task:running also marks the book active');

    await socket.emit('task:failed', { agent_id: AGENT.id, id: 'task-1', error: 'boom' });
    ok(find(calls, 'agent.state').at(-1)[2] === 'stalled', 'task:failed → stalled');
}

// ── a task naming its agent by assignee_id still resolves ────────────────────
{
    const { calls, socket } = await harness();
    await socket.emit('task:queued', { assignee_id: AGENT.id, id: 'task-2' });
    ok(find(calls, 'agent.activity').at(-1)?.[1] === BOOK,
        'assignee_id resolves the book when agent_id is absent');
}

// ── messages become say-sheets, with spaces intact ───────────────────────────
{
    const { calls, socket } = await harness();
    const text = 'mapped 41 endpoints — issues, agents, chat';
    await socket.emit('chat:message', { agent_id: AGENT.id, content: text });
    const msg = find(calls, 'agent.message').at(-1);
    ok(msg && msg[1] === BOOK && msg[3] === 'say', 'chat:message → agent.message say');
    ok(msg && msg[4] === text, 'message body survives verbatim (array dispatch, no quoting)');
}

// ── issues assigned to an agent become lines; stage is carried ───────────────
{
    const issue = {
        id: 'i-1', identifier: 'GLY-4', title: 'Survey the API surface',
        status: 'todo', stage: 1, assignee_type: 'agent', assignee_id: AGENT.id,
    };
    const { calls, counts } = await harness({ issues: [issue] });
    ok(counts.issues === 1, 'assigned issue placed at hydration');
    const line = find(calls, 'agent.activity').at(-1);
    ok(line[3] === 'issue' && line[4] === 'GLY-4', 'issue activity is keyed by its identifier');
    ok(String(line[6]).includes('stage 1'), `stage rides in the detail (got ${line[6]})`);
}

// ── an unassigned issue has no book, and must not invent one ─────────────────
{
    const orphan = { id: 'i-2', identifier: 'GLY-9', title: 'unowned', status: 'todo', assignee_type: null };
    const { counts, calls } = await harness({ issues: [orphan] });
    ok(counts.issues === 0, 'unassigned issue is skipped');
    ok(find(calls, 'agent.activity').length === 0, 'no activity dispatched for an unassigned issue');
}

// ── wire shapes as the live server actually sends them ───────────────────────
// Each of these was found by dumping real frames; each silently mapped to nothing
// before it was fixed, which is exactly the failure a mapping test must catch.
{
    // issue frames are wrapped: { issue: {...} }
    const { calls, socket } = await harness();
    await socket.emit('issue:created', {
        issue: {
            id: 'i-9', identifier: 'GLY-11', title: 'payload dump probe', status: 'todo',
            stage: null, assignee_type: 'agent', assignee_id: AGENT.id,
        },
    });
    const line = find(calls, 'agent.activity').at(-1);
    ok(line?.[3] === 'issue' && line?.[4] === 'GLY-11', 'wrapped issue:created still lands on the book');
}
{
    // comment frames are wrapped, and name their writer author_* not actor_*
    const { calls, socket } = await harness();
    const text = 'claude exited with error: exit status 1';
    await socket.emit('comment:created', {
        comment: { author_id: AGENT.id, author_type: 'agent', content: text, issue_id: 'i-9' },
    });
    const msg = find(calls, 'agent.message').at(-1);
    ok(msg?.[1] === BOOK && msg?.[4] === text, 'an agent comment becomes its say-sheet');
}
{
    // a human's comment belongs to the issue, not to any agent's book
    const { calls, socket } = await harness();
    await socket.emit('comment:created', {
        comment: { author_id: 'some-member', author_type: 'member', content: 'looks good' },
    });
    ok(find(calls, 'agent.message').length === 0, 'a member comment does not land in an agent book');
}
{
    // task:progress carries only { task_id, summary, step, total } — the ledger routes it
    const { calls, socket, bridge } = await harness();
    await socket.emit('task:running', { agent_id: AGENT.id, task_id: 't-7', issue_id: 'i-9' });
    ok(bridge.taskOwners.get('t-7') === BOOK, 'dispatch records the task owner');

    await socket.emit('task:progress', { task_id: 't-7', summary: 'Launching claude', step: 1, total: 2 });
    const prog = find(calls, 'agent.activity').at(-1);
    ok(prog?.[1] === BOOK, 'an agent-less progress frame still routes via the ledger');
    ok(String(prog?.[5]).includes('Launching claude') && String(prog?.[5]).includes('1/2'),
        `progress summary + step ride through (got ${prog?.[5]})`);

    await socket.emit('task:completed', { agent_id: AGENT.id, task_id: 't-7' });
    ok(!bridge.taskOwners.has('t-7'), 'a terminal event releases the ledger entry');
}

// ── unmapped events are counted, not logged per frame ────────────────────────
{
    const { bridge, socket, calls } = await harness();
    const before = calls.length;
    for (let i = 0; i < 50; i++) await socket.emit('billing:updated', { n: i });
    ok(calls.length === before, 'an unmapped event dispatches nothing');
    ok(bridge.unhandled.get('billing:updated') === 50,
        `unmapped frames are tallied (got ${bridge.unhandled.get('billing:updated')})`);
}

// ── stop() unbinds ───────────────────────────────────────────────────────────
{
    const { bridge, socket, calls } = await harness();
    bridge.stop();
    const before = calls.length;
    await socket.emit('agent:status', { id: AGENT.id, status: 'working' });
    ok(calls.length === before, 'no dispatches after stop()');
}

// ── live round trip (opt-in) ─────────────────────────────────────────────────
const LIVE = process.env.MULTICA_URL;
if (LIVE) {
    const client = new MulticaClient({
        baseUrl: LIVE,
        token: process.env.MULTICA_TOKEN,
        workspaceId: process.env.MULTICA_WORKSPACE,
    });

    const agents = await client.listAgents();
    ok(Array.isArray(agents), `live: listAgents answered an array (${agents.length})`);

    const issues = await client.listIssues();
    ok(Array.isArray(issues), `live: listIssues unwrapped the {issues:[…]} envelope (${issues.length})`);

    // The backend rejects a same-titled active issue with 409 unless allow_duplicate is
    // set, so every probe below is uniquely tagged AND flagged — otherwise a second run
    // of this file fails on the server's dedupe rather than on anything we changed.
    const tag = `probe-${Date.now().toString(36)}`;
    const make = (input) => client.createIssue({ allow_duplicate: true, ...input });

    // 1-based stages: the server rejects 0. Locking this because the natural guess is 0.
    let rejected = false;
    try {
        await make({ title: `${tag} stage-zero`, stage: 0 });
    } catch (err) {
        rejected = err.status === 400;
    }
    ok(rejected, 'live: stage 0 is rejected — stages are 1-based');

    // PUT, not PATCH. Prove the client's chosen verb actually updates.
    const probe = await make({ title: `${tag} update`, status: 'todo', priority: 'low' });
    const updated = await client.updateIssue(probe.id, { priority: 'urgent' });
    ok(updated.priority === 'urgent', `live: updateIssue (PUT) took effect (got ${updated.priority})`);

    const parent = await make({ title: `${tag} parent`, status: 'in_progress' });
    await make({ title: `${tag} child a`, parent_issue_id: parent.id, stage: 1 });
    await make({ title: `${tag} child b`, parent_issue_id: parent.id, stage: 2 });
    const children = await client.listChildren(parent.id);
    ok(children.length === 2, `live: children round-tripped (${children.length})`);
    ok(children.some(c => c.stage === 1) && children.some(c => c.stage === 2),
        'live: the stage ladder survives the round trip');
} else {
    console.log('  (live round trip skipped — set MULTICA_URL, MULTICA_TOKEN, MULTICA_WORKSPACE)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

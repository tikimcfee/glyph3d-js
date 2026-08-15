// agent-waiting.test.mjs — behavior lock for THE RAISED HAND: "this agent is waiting on
// you", derived from the same records the agent books render, and the verb surface the
// wait panel (app/client/AgentWaitPanel.jsx) projects.
//
//   bun tools/agent-waiting.test.mjs
//
// Locks the pure layer (packages/glyph3d-core/src/collections/agentWaiting.js):
//   - waitFromPreTool: blocking tools only (AskUserQuestion / ExitPlanMode, per the tool
//     registry's `blocking` flag) — every other tool passes as null
//   - waitFromRecord: an `ask` still missing its answer waits; an answered one does not
//   - waitFromTurnEnd: prose ends the turn ON you; `think` is transparent; a trailing
//     tool call is not a wait; a pending question still holds the hand up
//
// …and the state machine + verbs on top of it:
//   - agent.pretool raises the hand for a blocking call (and builds NO sheet), passes
//     for everything else (and creates no lane)
//   - any activity lowers the hand — the agent is working again
//   - agent.stop (the turn-end hook) raises it from the turn's last prose
//   - agent.request raises it by hand; agent.answered lowers it; agent.waiting reports
//   - hydrate raises NOTHING: opening an archive is reading a record, not being asked
//   - waiting() is ordered longest-wait-first, and a re-raise of the same words keeps
//     its place in that queue
//
// Headless: the 2d-canvas stub stands in for the DOM, the shaper-less atlas feeds the
// fields — real sheets, no ink.

import './headless-canvas.mjs';
import { HEADLESS_ATLAS } from './headless-atlas.mjs';
import * as THREE from 'three';

globalThis.window ??= { addEventListener() {} };

const { default: AgentBooks } = await import('../packages/glyph3d-core/src/collections/AgentBooks.js');
const { normalizeToolCall } = await import('../packages/glyph3d-core/src/collections/toolRegistry.js');
const { waitFromPreTool, waitFromRecord, waitFromTurnEnd } =
    await import('../packages/glyph3d-core/src/collections/agentWaiting.js');
const { default: registerAgentCommands } = await import('../app/commands/handlers/agentCommands.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const handlers = {};
registerAgentCommands({ register: (name, fn) => { handlers[name] = fn; } });
const books = new AgentBooks({ scene: new THREE.Scene(), atlas: HEADLESS_ATLAS, registry: null });
const ctx = { agentBooks: books, sessionProvider: null };
const run = (name, ...args) => handlers[name](args, ctx);

const QUESTIONS = { questions: [{ question: 'Ship it or keep polishing?' }, { question: 'Which branch?' }] };

// ── the pure layer: what counts as a wait ──
{
    ok(waitFromPreTool('Read', { file_path: '/x/y.js' }) === null, 'pre-tool Read does not block');
    ok(waitFromPreTool('Bash', { command: 'ls' }) === null, 'pre-tool Bash does not block');

    const ask = waitFromPreTool('AskUserQuestion', QUESTIONS);
    ok(ask?.reason === 'ask', 'pre-tool AskUserQuestion blocks (reason "ask")');
    ok(ask?.message === 'Ship it or keep polishing?\nWhich branch?',
        `the questions ARE the message, whole (got ${JSON.stringify(ask?.message)})`);
    const plan = waitFromPreTool('ExitPlanMode', { plan: 'step one\nstep two' });
    ok(plan?.reason === 'ask' && plan.message === 'step one\nstep two', 'pre-tool ExitPlanMode blocks on the plan');
    ok(waitFromPreTool('AskUserQuestion', {}) === null, 'a blocking call with nothing to show raises nothing');

    const pending = normalizeToolCall('AskUserQuestion', QUESTIONS, null);
    ok(waitFromRecord(pending)?.reason === 'ask', 'an unanswered ask record waits');
    const answered = normalizeToolCall('AskUserQuestion', QUESTIONS, { content: 'Ship it' });
    ok(waitFromRecord(answered) === null, 'an answered ask record does not wait');
    ok(waitFromRecord(normalizeToolCall('Read', { file_path: '/x/y.js' })) === null, 'a read record does not wait');

    const say = { action: 'say', result: 'here is what I found' };
    const think = { action: 'think', result: 'hmm' };
    const read = { action: 'read', target: 'x.js' };
    ok(waitFromTurnEnd([]) === null, 'an empty turn is not a wait');
    ok(waitFromTurnEnd([read, say])?.reason === 'say', 'a turn ending on prose ends on YOU');
    ok(waitFromTurnEnd([read, say])?.message === 'here is what I found', 'the prose IS the message');
    ok(waitFromTurnEnd([say, think])?.reason === 'say', 'trailing reasoning is transparent — the speech still counts');
    ok(waitFromTurnEnd([say, read]) === null, 'a turn ending on a tool call is the agent stopping, not asking');
    ok(waitFromTurnEnd([say, pending])?.reason === 'ask', 'a turn ending on a pending question still holds the hand up');
}

// ── agent.pretool: the live "about to block" ingress ──
{
    const passes = run('agent.pretool', 'dev', 'claude', 'Read', JSON.stringify({ file_path: '/x/y.js' }));
    ok(passes.data?.blocking === false, 'agent.pretool on a plain tool reports not-blocking');
    ok(!books.lanes.has('dev'), 'a non-blocking pre-tool creates NO lane (page-side no-op)');

    const r = run('agent.pretool', 'dev', 'claude', 'AskUserQuestion', JSON.stringify(QUESTIONS));
    ok(r.data?.blocking === true && r.data.reason === 'ask', 'agent.pretool on a blocking tool reports the wait');
    const lane = books.lanes.get('dev');
    ok(!!lane, 'the blocking pre-tool spawned the lane');
    ok(lane.waiting?.reason === 'ask', 'the hand is up on the lane');
    ok(lane.waiting?.message === 'Ship it or keep polishing?\nWhich branch?', 'the lane carries the whole question');
    ok(lane.entries.length === 0, 'the pre-tool event builds NO sheet — the answered call pages its own');

    const listed = run('agent.waiting');
    ok(listed.data?.count === 1 && listed.data.waiting[0].id === 'dev', 'agent.waiting reports the raised hand');
    ok(listed.data.waiting[0].message.includes('Which branch?'), 'agent.waiting carries the message');
    ok(books.agents().find((a) => a.id === 'dev')?.waiting?.reason === 'ask', 'agents() exposes the hand per lane');
}

// ── activity lowers it; the answered call pages its sheet ──
{
    run('agent.tool', 'dev', 'claude', 'AskUserQuestion', JSON.stringify(QUESTIONS), JSON.stringify({ content: 'Ship it' }));
    const lane = books.lanes.get('dev');
    ok(lane.waiting === null, 'the answered call lowers the hand — the agent is working again');
    ok(lane.entries.length === 1 && lane.entries[0].record.action === 'ask', 'the answered call paged its own sheet');
    ok(run('agent.waiting').data.count === 0, 'agent.waiting is empty again');
}

// ── the turn ends on prose → agent.stop raises the hand ──
{
    run('agent.message', 'dev', 'claude', 'thinking', 'weighing the two options');
    run('agent.message', 'dev', 'claude', 'text', 'I shipped it. Want me to tag a release too?');
    ok(books.lanes.get('dev').waiting === null, 'mid-turn prose alone is not a wait (the turn may go on)');

    ok(run('agent.stop', 'dev').text.startsWith('OK'), 'agent.stop OK');
    const lane = books.lanes.get('dev');
    ok(lane.state === 'done', 'agent.stop still marks the lane done');
    ok(lane.waiting?.reason === 'say', 'the turn ended on prose → the hand goes up (reason "say")');
    ok(lane.waiting?.message === 'I shipped it. Want me to tag a release too?', 'it carries the agent\'s exact words');

    // A turn that ends on a tool call is the agent stopping, not asking.
    run('agent.activity', 'quiet', 'claude', 'bash', '', 'ls');
    run('agent.stop', 'quiet');
    ok(books.lanes.get('quiet').waiting === null, 'a turn ending on a tool call raises nothing');
}

// ── agent.answered / agent.request ──
{
    ok(run('agent.answered', 'dev').data?.waiting === false, 'agent.answered lowers the hand');
    ok(books.lanes.get('dev').waiting === null, 'the lane agrees');
    ok(run('agent.answered', 'dev').text.startsWith('ERR'), 'agent.answered on a lowered hand is an honest ERR');
    ok(run('agent.answered', 'phantom').text.startsWith('ERR'), 'agent.answered on an unknown lane is an ERR');

    run('agent.request', 'dev', 'which', 'way', 'do', 'you', 'want', 'this?');
    const w = books.lanes.get('dev').waiting;
    ok(w?.reason === 'request' && w.message === 'which way do you want this?', 'agent.request raises by hand');
}

// ── hydrate raises nothing, even ending on prose ──
{
    await books.hydrate('past', [
        { action: 'read', target: 'a.js', detail: '', result: '', meta: null },
        { action: 'say', target: '', detail: '', result: 'that is everything I found', meta: null },
    ], {});
    ok(books.lanes.get('past').entries.length === 2, 'the archived turns hydrated');
    ok(books.lanes.get('past').waiting === null, 'opening an archived session raises NO hand');
}

// ── the queue: longest wait first, and a re-raise keeps its place ──
{
    run('agent.pretool', 'later', 'claude', 'AskUserQuestion', JSON.stringify({ questions: [{ question: 'me too?' }] }));
    const order = books.waiting().map((w) => w.id);
    ok(order[0] === 'dev' && order[1] === 'later', `longest-waiting first (got ${JSON.stringify(order)})`);

    const ts = books.lanes.get('later').waiting.ts;
    await sleep(5);
    run('agent.pretool', 'later', 'claude', 'AskUserQuestion', JSON.stringify({ questions: [{ question: 'me too?' }] }));
    ok(books.lanes.get('later').waiting.ts === ts, 'the same words re-raised keep their place in the queue');

    let changes = 0;
    const off = books.onChange(() => { changes++; });
    run('agent.answered', 'later');
    ok(changes === 1, 'lowering a hand notifies the panels');
    off();
}

console.log(`\n${fail ? '✗ FAIL' : '✓ PASS'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

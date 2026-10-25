// gomux-hub.test.mjs — behavior lock for the gomuxai hub's LIVE FOLLOW:
//
//   bun tools/gomux-hub.test.mjs
//
// GomuxHub follows each agent's transcript forward from a byte cursor as the relay's
// tree push reports it growing. This gate locks:
//   - the cursor lands past the last COMPLETE line (a line mid-write is re-read whole),
//   - a tool call whose result isn't written yet is HELD: nothing at or after it commits,
//     the cursor stays, and the next read commits it WITH its result — once,
//   - a held window that outgrows the pending cap commits anyway (an interrupted call
//     must not pin the cursor forever),
//   - single-flight: a push landing mid-read re-reads once after,
//   - the agent's status rides the lane (meta.gomux, lifecycle, the waiting hand),
//   - ONE book per Claude session: the hub claims its agents' sessions, a hook book already
//     born for one is cleared, and the hook verbs (agent.tool/message/meta) defer to the hub.
//
// The provider mocks cli/gomux.go's gomux/read window over a growing byte buffer; the
// books are a recorder. No carrels in ctx — the desk layout stands down.

import GomuxHub from '../app/client/GomuxHub.js';
import registerAgentCommands from '../app/commands/handlers/agentCommands.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); } };
const J = (v) => JSON.stringify(v);
const eq = (a, b, msg) => ok(J(a) === J(b), `${msg}\n      got  ${J(a)}\n      want  ${J(b)}`);

const enc = new TextEncoder();
let ts = 1754700000000;
const L = (obj) => JSON.stringify({ cwd: '/p', timestamp: new Date(ts += 1000).toISOString(), ...obj }) + '\n';
const say = (text) => L({ message: { role: 'assistant', content: [{ type: 'text', text }] } });
const use = (id, command) => L({ message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const res = (id, out) => L({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: out }] } });

/** A transcript that grows; read() serves gomux/read's forward window. */
function makeProvider() {
    let text = '';
    const p = {
        reads: 0,
        append(s) { text += s; },
        get size() { return enc.encode(text).byteLength; },
        async read(_name, { fromOffset = 0 } = {}) {
            p.reads++;
            const all = enc.encode(text);
            // the relay starts a mid-file window on a line boundary; our cursors always are one
            return { bytes: all.slice(fromOffset), offset: fromOffset, size: all.byteLength, truncated: fromOffset > 0, mtime: 0, cwd: null };
        },
        onChange() { return () => {}; },
        onPaneSize() { return () => {}; },
        async list() { return { gen: 0, dirs: [], agents: [] }; },
    };
    return p;
}

function makeBooks() {
    const lanes = new Map();
    const books = {
        lanes, appended: [],
        cfg: { tailReadBytes: 1 << 20, headMetaBytes: 0 },
        ensure(id) { if (!lanes.has(id)) lanes.set(id, { agentId: id, state: 'idle', beacon: null, meta: {} }); return lanes.get(id); },
        async hydrate(id, events) { books.ensure(id); for (const e of events) books.appended.push(e); lanes.get(id).state = 'idle'; return events.length; },
        setLaneMeta(id, meta) { const l = lanes.get(id); l.meta = { ...l.meta, ...meta }; return true; },
        state(id, s) { lanes.get(id).state = s; return true; },
        request(id, msg) { lanes.get(id).beacon = msg; return true; },
        clearRequest(id) { lanes.get(id).beacon = null; return true; },
    };
    return books;
}

const names = (books) => books.appended.map((e) => e.kind === 'tool' ? `tool:${e.input.command}${e.response == null ? '(no result)' : ''}` : `say:${e.text}`);

// ── follow: complete lines, held pending tool, single commit ────────────────────
{
    const provider = makeProvider();
    const books = makeBooks();
    const hub = new GomuxHub({ agentBooks: books }, provider);
    const node = { name: 'a', live: true, status: 'processing', detail: 'Bash: ls', transcript: '/t', harness: 'claude', createdAt: new Date().toISOString() };
    hub.nodes.set('a', node);
    books.ensure('a');
    hub.lanes.set('a', { name: 'a', phase: 'open', cursor: 0, skip: 0, reading: false, again: false, harness: 'claude', desk: null });

    provider.append(say('hello'));
    provider.append(use('t1', 'ls'));
    const torn = say('half');
    provider.append(torn.slice(0, 20));               // a line mid-write
    await hub._follow('a');
    eq(names(books), ['say:hello'], 'pending tool is held; the torn line is not parsed');
    const hl = hub.lanes.get('a');
    eq([hl.cursor, hl.skip], [0, 1], 'held: cursor stays at the window start, the committed event is skipped next time');

    provider.append(torn.slice(20));
    provider.append(res('t1', 'a.txt'));
    provider.append(say('done'));
    await hub._follow('a');
    eq(names(books), ['say:hello', 'tool:ls', 'say:half', 'say:done'], 'the held tool commits once, with its result, then the rest');
    eq([hl.cursor, hl.skip], [provider.size, 0], 'all complete: cursor at the end, nothing to skip');

    await hub._follow('a');
    eq(books.appended.length, 4, 'a read with nothing new appends nothing');

    const late = say('late');
    provider.append(say('early'));
    provider.append(late.slice(0, 15));               // mid-write behind a complete line, nothing pending
    await hub._follow('a');
    eq(names(books).at(-1), 'say:early', 'the complete line commits; the line mid-write waits');
    provider.append(late.slice(15));
    await hub._follow('a');
    eq(names(books).at(-1), 'say:late', 'and arrives whole once written (the cursor stopped before it)');

    // status rides the lane
    eq(books.lanes.get('a').state, 'active', 'processing → active (the agent\'s status wins over hydrate\'s idle)');
    eq(books.lanes.get('a').meta.gomux?.detail, 'Bash: ls', 'meta.gomux carries the node');
    node.status = 'waiting'; node.detail = 'Bash: rm -rf build';
    hub._status(node);
    eq(books.lanes.get('a').beacon, 'waiting · Bash: rm -rf build', 'waiting raises the hand with what it waits on');
    node.status = 'idle';
    hub._status(node);
    eq([books.lanes.get('a').beacon, books.lanes.get('a').state], [null, 'idle'], 'idle lowers it');
    node.live = false;
    hub._status(node);
    eq(books.lanes.get('a').state, 'done', 'a cleaned-up agent is done');
}

// ── an interrupted call doesn't pin the cursor forever ──────────────────────────
{
    const provider = makeProvider();
    const books = makeBooks();
    const hub = new GomuxHub({ agentBooks: books }, provider);
    hub.nodes.set('b', { name: 'b', live: true, status: 'processing', transcript: '/t', harness: 'claude', createdAt: '' });
    books.ensure('b');
    hub.lanes.set('b', { name: 'b', phase: 'open', cursor: 0, skip: 0, reading: false, again: false, harness: 'claude', desk: null });
    provider.append(use('t9', 'sleep 1000'));
    const big = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 70; i++) provider.append(say(big));   // > 4MB after the dangling call
    await hub._follow('b');
    eq(books.appended.length, 71, 'past the pending cap the window commits whole (the dangling call without a result)');
    eq(hub.lanes.get('b').cursor, provider.size, 'and the cursor moves on');
}

// ── single-flight: a push mid-read re-reads once after ─────────────────────────
{
    const provider = makeProvider();
    const books = makeBooks();
    const hub = new GomuxHub({ agentBooks: books }, provider);
    hub.nodes.set('c', { name: 'c', live: true, status: 'idle', transcript: '/t', harness: 'claude', createdAt: '' });
    books.ensure('c');
    hub.lanes.set('c', { name: 'c', phase: 'open', cursor: 0, skip: 0, reading: false, again: false, harness: 'claude', desk: null });
    provider.append(say('one'));
    const first = hub._follow('c');
    provider.append(say('two'));
    hub._follow('c');                                  // lands mid-read
    await first;
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 5 && hub.lanes.get('c').reading; i++) await new Promise((r) => setTimeout(r, 5));
    eq(names(books), ['say:one', 'say:two'], 'the second push is served by one follow-up read');
    eq(provider.reads, 2, 'two reads, not three');
}

// ── one book per Claude session: the hub's claim beats the project hook's ──────
{
    const books = makeBooks();
    books.remove = (id) => books.lanes.delete(id);
    const hub = new GomuxHub({ agentBooks: books }, makeProvider());
    books.ensure('coord');
    hub.lanes.set('coord', { name: 'coord', phase: 'open', cursor: 0, skip: 0, reading: false, again: false, harness: 'claude', desk: null });
    books.ensure('5a795230');                          // the hook booked coord's session before the claim
    books.ensure('3f34adff');                          // a session no gomuxai agent runs
    hub._claimSessions([
        { name: 'coord', harness: 'claude', sessionId: '5a795230-061d-45b7-afc2-beebe47be48e' },
        { name: 'gem', harness: 'agy', sessionId: 'abcdef12-0000' },
        { name: 'quiet', harness: 'claude' },
    ]);
    eq(hub.follows('5a795230'), 'coord', "the hook's id for coord's session resolves to coord");
    eq([hub.follows('3f34adff'), hub.follows('abcdef12')], [null, null], 'other sessions (and non-claude harnesses) stay the hook\'s');
    eq([...books.lanes.keys()].sort(), ['3f34adff', 'coord'], "the hook's duplicate book is cleared; coord's own and the unclaimed one stay");

    const verbs = new Map();
    registerAgentCommands({ register: (name, fn) => verbs.set(name, fn) });
    const ctx = { agentBooks: books, gomuxHub: hub };
    const replies = [
        verbs.get('agent.tool')(['5a795230', 'claude', 'Bash', '{"command":"ls"}', '"x"', '/p'], ctx),
        verbs.get('agent.message')(['5a795230', 'claude', 'text', 'hello'], ctx),
        verbs.get('agent.meta')(['5a795230', '{"slug":"s"}'], ctx),
    ];
    ok(replies.every((r) => r.data?.followedBy === 'coord'), `the hook verbs defer to the hub: ${J(replies.map((r) => r.text))}`);
    ok(!books.lanes.has('5a795230'), 'and draw no second book');
}

console.log(`gomux-hub: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// session-books.test.mjs — behavior lock for agent books fed by the relay's event wire
// (CUTOVER: gomuxai is the one reader of transcripts; the relay forwards its lines):
//
//   bun tools/session-books.test.mjs
//
// The real AgentSessionProvider over a fake bridge that plays the relay (agentSessions/list|
// changed, agentEvents/read|follow|unfollow, agentEvents/lines|ended pushes) over synthetic
// event streams; real AgentBooks (headless atlas), Carrel, Holding, SessionBooks, GomuxHub,
// SessionDesk, agent.open and SessionStore. Locks:
//   - open = a tail read (cfg.tailReadBytes) → hydrate → follow {from: the last `at` read};
//   - live lines append; a tool's result update rebuilds its sheet in place; lines that beat
//     the follow's {ok} are taken; a provisional reply never becomes the resume point;
//   - ended (any code, -1 included) → the provisional replies drop and the book re-follows
//     from its last `at`;
//   - paging back reads by `at`: from the start once (exact numbers), windowed after;
//   - the hub: a workgroup agent's book is its name, opened from its session; its own status
//     wins over a live batch; a new session opens into the same book (the old unfollowed);
//     a live edit taps the delta books with its patch;
//   - the agents desk: live + recent local sessions get books (lane = session id), old ones
//     and workgroup ones don't; a subagent sits on its parent's team desk; a re-pushed list
//     that changes nothing shown rebuilds nothing; agent.clear stops following and the desk
//     doesn't reopen it; agent.open opens an older session (by prefix; a workgroup agent by
//     its name) and the desk seats it;
//   - restore reopens saved books through the same path (limit, head); capture saves them by
//     session, never the hub's.

import './headless-canvas.mjs';
import * as THREE from 'three';
import { HEADLESS_ATLAS } from './headless-atlas.mjs';

const store = new Map();
globalThis.localStorage ??= {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
};
globalThis.window ??= { addEventListener() {}, dispatchEvent() {} };
globalThis.window.dispatchEvent ??= () => {};

const { default: AgentBooks } = await import('../packages/glyph3d-core/src/collections/AgentBooks.js');
const { default: AgentSessionProvider } = await import('../packages/glyph3d-core/src/services/data/AgentSessionProvider.js');
const { default: WorkspaceModel } = await import('../app/client/WorkspaceModel.js');
const { default: Holding } = await import('../app/client/Holding.js');
const { default: SessionBooks, laneForSession, resolveSession } = await import('../app/client/SessionBooks.js');
const { default: SessionDesk, AGENTS_DESK } = await import('../app/client/SessionDesk.js');
const { default: GomuxHub, GOMUX_HUB } = await import('../app/client/GomuxHub.js');
const { default: SessionStore } = await import('../app/client/SessionStore.js');
const { default: registerAgentCommands } = await import('../app/commands/handlers/agentCommands.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } };
const J = (v) => JSON.stringify(v);
const eq = (a, b, m) => ok(J(a) === J(b), `${m}\n      got  ${J(a)}\n      want ${J(b)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => sleep(0);

// ── synthetic streams ────────────────────────────────────────────────────────────────
const LINE = 200;   // every event line is LINE bytes: event k sits at k * LINE
const iso = (k) => new Date(Date.UTC(2026, 9, 25, 10, 0, k)).toISOString();
const turn = { id: 't1', index: 1, derived: false };
const say = (k, text, extra = {}) => ({ type: 'event', id: `say-${k}`, op: 'add', seq: k, at: k * LINE, line: k, ts: iso(k), turn, kind: 'say', say: { text, ...extra } });
const bash = (k, cmd, result = { status: 'pending' }, op = 'add', at = k * LINE) =>
    ({ type: 'event', id: `tool-${k}`, op, seq: k, at, line: at / LINE, ts: iso(at / LINE), turn, kind: 'tool',
       tool: { name: 'Bash', input: { command: cmd }, result, action: 'bash', detail: cmd } });
const edit = (k, file, patch, op, at) =>
    ({ type: 'event', id: `edit-${k}`, op, seq: k, at, line: at / LINE, ts: iso(at / LINE), turn, kind: 'tool',
       tool: { name: 'Edit', input: { file_path: `/w/${file}` }, result: { status: op === 'add' ? 'pending' : 'ok' }, action: 'edit', target: file,
               meta: op === 'add' ? { added: 1, removed: 1 } : { added: 1, removed: 1, ranges: [[1, 1]], patch } } });
const sessionLine = (s) => ({ type: 'session', ...s });
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const session = (id, extra = {}) => ({ session_id: id, harness: 'claude', path: `/t/${id}.jsonl`, size: 0, mtime: ago(0.1),
    cwd: '/w', project: 'w', title: `title ${id}`, workgroup: null, status: 'idle', ...extra });

/**
 * The fake relay: a bridge whose rpcRequest answers the wire, whose notifications reach
 * the provider. Each transcript is its session's frames; size grows past the last line.
 */
function makeRelay() {
    const transcripts = new Map();   // session id → { info, events: [] }
    let notify = null;
    const calls = [];
    const relay = {
        calls, transcripts, sessions: [], beforeOk: null,
        add(info, events = []) { transcripts.set(info.session_id, { info, events: [...events] }); return info; },
        size(id) { const t = transcripts.get(id); return t.events.length ? Math.max(...t.events.map((e) => e.at)) + LINE : 0; },
        push(id, frames) { for (const f of frames) if (f.type === 'event') relay.transcripts.get(id).events.push(f); notify('agentEvents/lines', { session: id, lines: frames.map(J) }); },
        end(id, code, error) { notify('agentEvents/ended', { session: id, code, ...(error ? { error } : {}) }); },
        list(sessions) { relay.sessions = sessions; notify('agentSessions/changed', { gen: Date.now(), sessions }); },
    };
    const bridge = {
        onRpcNotification(fn) { notify = fn; return () => { notify = null; }; },
        async rpcRequest(method, params) {
            calls.push({ method, params });
            if (method === 'agentSessions/list') return { gen: 1, sessions: relay.sessions };
            const t = transcripts.get(params.session);
            if (method === 'agentEvents/follow') {
                if (relay.beforeOk) { const f = relay.beforeOk; relay.beforeOk = null; f(params); }   // lines beat the {ok}
                return { ok: true };
            }
            if (method === 'agentEvents/unfollow') return { ok: true };
            if (method === 'agentEvents/read') {
                if (!t) throw new Error(`no session ${params.session}`);
                const size = relay.size(params.session);
                let lo = -1, hi = size;
                if (params.tail > 0) lo = Math.max(-1, size - params.tail - 1);
                if (params.from != null) lo = params.from;
                if (params.until != null) hi = Math.min(size, params.until);
                const evs = t.events.filter((e) => e.at > lo && e.at < hi);
                return { lines: [sessionLine({ ...t.info, size }), ...evs].map(J), size };
            }
            throw new Error(`unexpected ${method}`);
        },
    };
    return { relay, bridge };
}

function makeWorld() {
    const scene = new THREE.Scene();
    const entries = new Map();
    const listeners = new Set();
    const registry = {
        register(id, grid, meta = {}) { entries.set(id, { id, grid, ...meta }); for (const fn of listeners) fn(); },
        unregister(id) { const e = entries.get(id); entries.delete(id); for (const fn of listeners) fn(); return e; },
        get: (id) => entries.get(id) || null,
        has: (id) => entries.has(id),
        getIdByGrid: (g) => { for (const e of entries.values()) if (e.grid === g) return e.id; return null; },
        list: () => [...entries.values()],
        findByType: (t) => [...entries.values()].filter((e) => e.type === t),
        findByMeta: () => [],
        addChangeListener: (fn) => listeners.add(fn),
        removeChangeListener: (fn) => listeners.delete(fn),
    };
    const world = { register() {}, unregister() {}, relayout() {} };
    const ctx = { scene, atlas: HEADLESS_ATLAS, registry, world, carrels: new Map(), workspace: new WorkspaceModel(),
                  cameraDock: null, camera: null, getSurfaces: () => [], getGrids: () => [], deltaBooks: null };
    ctx.holding = new Holding(ctx);
    ctx.agentBooks = new AgentBooks(ctx);
    ctx.agentBooks.cfg.maxSheets = 4;
    ctx.agentBooks.cfg.tailReadBytes = 3 * LINE;
    const { relay, bridge } = makeRelay();
    ctx.sessionProvider = new AgentSessionProvider(bridge);
    ctx.sessionBooks = new SessionBooks(ctx, ctx.sessionProvider);
    const verbs = new Map();
    registerAgentCommands({ register: (n, fn) => verbs.set(n, fn) });
    const run = (name, ...args) => verbs.get(name)(args.map(String), ctx);
    return { ctx, relay, run, books: ctx.agentBooks, sb: ctx.sessionBooks };
}
const ids = (lane) => lane.entries.map((e) => e.record.id);
const opened = (w, sid) => w.sb.streams.get(sid)?.opening;
const reads = (w, sid) => w.relay.calls.filter((c) => c.method === 'agentEvents/read' && c.params.session === sid).map((c) => c.params);
const follows = (w, sid) => w.relay.calls.filter((c) => c.method === 'agentEvents/follow' && c.params.session === sid).map((c) => c.params);
const holderName = (w, lane) => w.ctx.holding.holderOf(w.books.lanes.get(lane).groupId)?.carrelName ?? null;

// ── 1. the hub: open = tail read + follow; live lines; updates in place; status; ended ──
{
    const w = makeWorld();
    const taps = [];
    w.ctx.deltaBooks = { ingestTool: (lane, rec, cwd) => taps.push({ lane, rec, cwd }) };
    const evs = [];
    for (let k = 0; k < 10; k++) evs.push(k === 7 ? bash(k, 'make') : say(k, `s${k}`));
    evs.push(bash(7, 'make', { status: 'ok', output: 'built' }, 'update', 10 * LINE));
    w.relay.add(session('S1', { workgroup: { name: 'coord' }, status: 'processing' }), evs);
    const gomux = { onChange: () => () => {}, onPaneSize: () => () => {} };
    const hub = new GomuxHub(w.ctx, gomux, w.sb);
    const node = { name: 'coord', parent: '', backend: 'claude', harness: 'claude', sessionId: 'S1', live: true, status: 'processing',
                   createdAt: new Date().toISOString(), transcriptSize: 2200 };
    hub.apply({ gen: 1, dirs: [], agents: [node] });
    ok(w.books.lanes.has('coord') && hub.phase('coord') === 'opening', "the hub's book is born at once, under the agent's name");
    ok(holderName(w, 'coord') === GOMUX_HUB, 'and seated at the hub desk before anything else can');
    const r = await opened(w, 'S1');
    const lane = w.books.lanes.get('coord');
    eq(reads(w, 'S1'), [{ session: 'S1', tail: 3 * LINE }, { session: 'S1', tail: 6 * LINE }],
        'open: a tail read, doubled until it holds the book\'s cap of records');
    eq(ids(lane), ['say-6', 'tool-7', 'say-8', 'say-9'], 'hydrated with the newest records (cap 4)');
    ok(lane.entries[1].record.status === 'ok' && /built/.test(lane.entries[1].record.result), 'a result inside the window folded into its call');
    eq(follows(w, 'S1'), [{ session: 'S1', from: 10 * LINE }], 'then follow from the last `at` read (the update\'s line)');
    ok(r.lane === 'coord' && hub.phase('coord') === 'open' && lane.sessionId === 'S1' && lane.meta.title === 'title S1', 'open; the session line is the book\'s meta');
    ok(lane.state === 'active' && lane.meta.gomux?.status === 'processing', "the agent's status rides the book (processing → active)");
    ok(lane.book.headState().count === 4 && w.books.headState('coord').sheets === 5 && !w.books.headState('coord').exact,
        'sheet numbers count from an estimate until a page back makes them exact');

    // live: an add appends; a pending call's result updates it in place
    node.status = 'idle';
    hub.apply({ gen: 2, dirs: [], agents: [node] });
    ok(lane.state === 'idle', 'idle on the next tree push');
    w.relay.push('S1', [say(11, 'live one'), bash(12, 'ls')]);
    eq(ids(lane).slice(-2), ['say-11', 'tool-12'], 'live lines append');
    ok(lane.state === 'idle', "the agent's own status wins over the batch that marked the book active");
    const before = lane.entries.length, node12 = lane.book.sheets.at(-1).node;
    w.relay.push('S1', [bash(12, 'ls', { status: 'ok', output: 'a b' }, 'update', 13 * LINE)]);
    ok(lane.entries.length === before && lane.entries.at(-1).record.status === 'ok' && lane.book.sheets.at(-1).node === node12,
        'a result update rebuilds its sheet in place (count, index, deck node kept)');
    // a live edit taps the delta books with its patch
    const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }];
    w.relay.push('S1', [edit(14, 'f.js', patch, 'add', 14 * LINE)]);
    ok(!taps.some((t) => t.rec.action === 'edit'), 'a pending edit taps nothing');
    w.relay.push('S1', [edit(14, 'f.js', patch, 'update', 15 * LINE)]);
    const et = taps.filter((t) => t.rec.action === 'edit');
    ok(et.length === 1 && et[0].lane === 'coord' && J(et[0].rec.meta.patch) === J(patch) && et[0].rec.target === 'f.js' && et[0].cwd === '/w' && taps.every((t) => t.rec.status === 'ok'),
        'its ok update taps the watch lane: the book\'s lane, the event record with its patch, the session cwd');

    // a provisional reply never becomes the resume point; ended drops it and re-follows
    w.relay.push('S1', [say(16, 'provisional', { final: true, provisional: true })]);
    ok(lane.entries.at(-1).record.provisional, 'a provisional reply is a sheet');
    w.relay.end('S1', -1);
    ok(!lane.entries.some((e) => e.record.provisional), 'ended: the provisional reply drops');
    await sleep(1100);
    eq(follows(w, 'S1').at(-1), { session: 'S1', from: 15 * LINE }, 'and the book re-follows from its last `at` (not the provisional line)');
    w.relay.push('S1', [say(17, 'after resume')]);
    eq(ids(lane).at(-1), 'say-17', 'lines after the re-follow land');

    // paging back: from the start once (exact), windowed after
    const n0 = w.relay.calls.length;
    lane.book.pageTo(0);
    for (let i = 0; i < 50 && lane.history.loading; i++) await lane.history.loading;
    const back = w.relay.calls.slice(n0).filter((c) => c.method === 'agentEvents/read').map((c) => c.params);
    ok(back.length === 1 && back[0].from === undefined && Number.isFinite(back[0].until), `the first page back reads from the start (${J(back)})`);
    ok(w.books.headState('coord').exact && lane.older.length > 0, 'and makes the numbers exact');

    // the agent moves on to a new session: same book, the old stream closed
    w.relay.add(session('S2', { workgroup: { name: 'coord' } }), [say(0, 'fresh session')]);
    node.sessionId = 'S2';
    lane.book.pageTo(Infinity);   // back to live: the new session's records join the window
    hub.apply({ gen: 3, dirs: [], agents: [node] });
    await opened(w, 'S2');
    ok(w.relay.calls.some((c) => c.method === 'agentEvents/unfollow' && c.params.session === 'S1') && !w.sb.streams.has('S1'), 'the old session unfollowed');
    ok(ids(lane).at(-1) === 'say-0' && w.sb.streamOfLane('coord')?.session === 'S2', 'the new session opened into the same book');
    ok(lane.history.done && lane.sessionId === 'S2', "its history is sealed: the new session's offsets can't page into the old one's sheets");
    hub.dispose();
}

// ── 2. lines that beat the follow's {ok} ──────────────────────────────────────────────
{
    const w = makeWorld();
    w.relay.add(session('E1'), [say(0, 'a'), say(1, 'b')]);
    w.relay.beforeOk = () => w.relay.push('E1', [say(2, 'early')]);
    await w.sb.open('E1');
    eq(ids(w.books.lanes.get('E1')), ['say-0', 'say-1', 'say-2'], 'lines pushed before the follow answered are taken');
}

// ── 3. the agents desk: which sessions get books, teams, a quiet re-push, clear ───────
{
    const w = makeWorld();
    const desk = new SessionDesk(w.ctx, w.ctx.sessionProvider, w.sb);
    w.ctx.sessionDesk = desk;
    const L1 = w.relay.add(session('L1-aaaa', { status: 'idle' }), [say(0, 'main'), say(1, 'more')]);
    const SUB = w.relay.add(session('agent-x1', { status: 'unknown', parent_session: { session_id: 'L1-aaaa' }, title: 'helper' }),
        [{ ...say(0, 'sub work'), agent: 'x1' }]);
    const OLD = w.relay.add(session('0ld5e55-1on', { status: 'exited', mtime: ago(72) }), [say(0, 'long ago'), say(1, 'still')]);
    const WG = w.relay.add(session('W1', { workgroup: { name: 'builder' }, status: 'processing' }), [say(0, 'wg')]);
    const RECENT = w.relay.add(session('R1', { status: 'exited', mtime: ago(1) }), [say(0, 'recent')]);
    w.relay.list([L1, SUB, OLD, WG, RECENT]);
    await Promise.all([...w.sb.streams.values()].map((s) => s.opening));
    eq([...w.books.lanes.keys()].sort(), ['L1-aaaa', 'R1', 'agent-x1'], 'live + recently written local sessions get books, under their session ids');
    eq(ids(w.books.lanes.get('agent-x1')), ['say-0'], "a subagent's own stream feeds its own book (its events' agent id isn't its session id)");
    ok(w.ctx.carrels.get(AGENTS_DESK)?.derived, "the 'agents' desk stands, derived (rebuilt from the list every boot)");
    eq([holderName(w, 'L1-aaaa'), holderName(w, 'agent-x1'), holderName(w, 'R1')], ['agents/L1-aaaa', 'agents/L1-aaaa', AGENTS_DESK],
        "a session with a subagent sits on its own team desk with it; the others at the agents desk");
    ok(w.ctx.carrels.get('agents/L1-aaaa')?.title?.text === 'title L1-aaaa · 1 helper', 'the team desk wears `<name> · N helpers`');
    ok(w.books.lanes.get('L1-aaaa').state === 'idle' && w.books.lanes.get('R1').state === 'done', 'session status → lifecycle (idle; exited → done)');

    let layouts = 0;
    const inner = desk.tree.layout.bind(desk.tree);
    desk.tree.layout = (n) => { layouts++; inner(n); };
    w.relay.list([L1, SUB, OLD, WG, RECENT].map((s) => s === OLD ? { ...s, size: 999 } : s));
    ok(layouts === 0, 'a re-pushed list that changes nothing shown rebuilds no desk');
    w.relay.list([{ ...L1, status: 'waiting' }, SUB, OLD, WG, RECENT]);
    ok(layouts === 1 && w.books.lanes.get('L1-aaaa').beacon === 'waiting', 'a shown session\'s status change does (and waiting raises its hand)');

    // agent.clear stops following; the desk leaves it closed
    w.run('agent.clear', 'R1');
    ok(!w.sb.streams.has('R1') && w.relay.calls.some((c) => c.method === 'agentEvents/unfollow' && c.params.session === 'R1'), 'agent.clear: its stream unfollowed');
    w.relay.list([L1, SUB, OLD, WG, { ...RECENT, size: 5 }]);
    ok(!w.books.lanes.has('R1'), 'the desk does not reopen a book you cleared');

    // agent.open: an older session by prefix, seated at the desk; a workgroup agent by name
    const r = await w.run('agent.open', '0ld5e55', '1');
    ok(/^OK: opened 0ld5e55-1on as 0ld5e55-1on/.test(r.text), `agent.open by prefix (${r.text})`);
    ok(holderName(w, '0ld5e55-1on') === AGENTS_DESK && w.books.lanes.get('0ld5e55-1on').maxSheets === 1, 'seated at the agents desk, with its limit as the cap');
    eq(follows(w, '0ld5e55-1on'), [{ session: '0ld5e55-1on', from: LINE }], 'and following from its last `at`');
    const r2 = await w.run('agent.open', 'builder');
    ok(r2.data?.lane === 'builder' && w.books.lanes.has('builder') && holderName(w, 'builder') !== AGENTS_DESK + '/x',
        "a workgroup agent's session opens under its name");
    ok(laneForSession(WG) === 'builder' && laneForSession(L1) === 'L1-aaaa', 'laneForSession: the name for a workgroup agent, else the session id');
    let threw = '';
    try { resolveSession([L1, OLD, session('0ld5e55-2')], '0ld5e55'); } catch (e) { threw = e.message; }
    ok(/ambiguous/.test(threw), 'a prefix that matches two sessions is refused');
    const nope = await w.run('agent.open', 'zzz');
    ok(/^ERR: no session 'zzz'/.test(nope.text), 'an unknown session says so');
    desk.dispose();

    // ── 4. restore + capture ─────────────────────────────────────────────────────────
    const saved = new SessionStore({ ctx: w.ctx, router: null, bridge: null }).capture();
    const bySession = new Map(saved.agents.map((a) => [a.session, a]));
    ok(bySession.has('L1-aaaa') && bySession.has('0ld5e55-1on') && bySession.get('0ld5e55-1on').limit === 1, `capture saves books by session (${[...bySession.keys()]})`);

    const w2 = makeWorld();
    w2.relay.add(OLD, [say(0, 'long ago'), say(1, 'still'), say(2, 'third')]);
    w2.relay.sessions = [OLD];
    const ss = new SessionStore({ ctx: w2.ctx, router: { execute: async () => ({ text: 'OK' }) }, bridge: { rpcRequest: async () => ({}) } });
    await ss._restoreAgents({ agents: [{ session: '0ld5e55-1on', limit: 3, following: false, head: 0 }, { session: 'vanished', following: true }] });
    const lane = w2.books.lanes.get('0ld5e55-1on');
    ok(lane && ids(lane).length === 3 && lane.maxSheets === 3 && lane.book.head === 0, 'restore reopens a saved book through the open path (limit, head)');
    ok(follows(w2, '0ld5e55-1on').length === 1, 'and follows it');
    ok(!ss._failedSections.has('agents'), 'a vanished session stays closed without quarantining the section');
    const w3 = makeWorld();
    w3.ctx.sessionProvider.list = async () => { throw new Error('relay gone'); };
    const ss3 = new SessionStore({ ctx: w3.ctx, router: null, bridge: null });
    await ss3._restoreAgents({ agents: [{ session: 'x' }] });
    ok(ss3._failedSections.has('agents'), 'no session list: the section is quarantined, not overwritten');
}

// ── 5. the hub's books aren't saved by session (the hub reopens them) ─────────────────
{
    const w = makeWorld();
    w.relay.add(session('H1', { workgroup: { name: 'lead' } }), [say(0, 'x')]);
    const hub = new GomuxHub(w.ctx, { onChange: () => () => {}, onPaneSize: () => () => {} }, w.sb);
    w.ctx.gomuxHub = hub;
    hub.apply({ gen: 1, dirs: [], agents: [{ name: 'lead', parent: '', sessionId: 'H1', harness: 'claude', live: true, status: 'idle', createdAt: new Date().toISOString() }] });
    await opened(w, 'H1');
    const saved = new SessionStore({ ctx: w.ctx, router: null, bridge: null }).capture();
    ok(saved.agents.length === 0, "capture skips the hub's books");
    hub.dispose();
}

console.log(`session-books: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

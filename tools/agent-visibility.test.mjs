// agent-visibility.test.mjs — behavior lock for hidden agents (AgentVisibility):
//
//   bun tools/agent-visibility.test.mjs
//
// The real AgentSessionProvider over a fake relay, real AgentBooks (headless atlas), Holding,
// SessionBooks, GomuxHub, SessionDesk, the agent verbs and SessionStore. Locks:
//   - THE GATE: before the saved set is known the hub and the agents desk open NOTHING (no
//     read, no book); the restore's first stage puts it back and they open only what's shown —
//     a reload never touches a hidden agent, even briefly; _restoreAgents skips hidden books;
//   - agent.hide closes a book and its stream (and a hub agent's screen); agent.show opens it
//     again (a session outside the desks' windows too); agent.open of a hidden one shows it;
//   - agent.group: hidden closes the group and keeps a NEW agent closed; ended closes only the
//     ended ones (and one that ends later); shown drops the members' own overrides;
//   - agent.clear on a book the hub or the desk opened = hide (durable); on one opened from
//     history it only closes;
//   - capture saves the set (agentVisibility), and a fresh page restoring it opens none of it.

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
const { default: SessionBooks } = await import('../app/client/SessionBooks.js');
const { default: AgentVisibility } = await import('../app/client/AgentVisibility.js');
const { default: SessionDesk } = await import('../app/client/SessionDesk.js');
const { default: GomuxHub } = await import('../app/client/GomuxHub.js');
const { default: SessionStore } = await import('../app/client/SessionStore.js');
const { default: registerAgentCommands } = await import('../app/commands/handlers/agentCommands.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } };
const J = (v) => JSON.stringify(v);
const eq = (a, b, m) => ok(J(a) === J(b), `${m}\n      got  ${J(a)}\n      want ${J(b)}`);
const tick = () => new Promise((r) => setTimeout(r, 0));

// ── a fake relay (the wire SessionBooks speaks) ──────────────────────────────────────
const LINE = 200;
const turn = { id: 't1', index: 1, derived: false };
const say = (k, text) => ({ type: 'event', id: `say-${k}`, op: 'add', seq: k, at: k * LINE, line: k,
    ts: new Date(Date.UTC(2026, 9, 25, 10, 0, k)).toISOString(), turn, kind: 'say', say: { text } });
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const session = (id, extra = {}) => ({ session_id: id, harness: 'claude', path: `/t/${id}.jsonl`, size: 0, mtime: ago(0.1),
    cwd: '/w', project: 'w', title: `title ${id}`, workgroup: null, status: 'idle', ...extra });

function makeWorld() {
    const transcripts = new Map();
    let notify = null;
    const calls = [];
    const relay = {
        calls, sessions: [],
        add(info) { transcripts.set(info.session_id, { info, events: [say(0, info.session_id)] }); return info; },
        list(sessions) { relay.sessions = sessions; notify?.('agentSessions/changed', { gen: Date.now(), sessions }); },
    };
    const bridge = {
        onRpcNotification(fn) { notify = fn; return () => { notify = null; }; },
        async rpcRequest(method, params) {
            calls.push({ method, params });
            if (method === 'agentSessions/list') return { gen: 1, sessions: relay.sessions };
            if (method === 'agentEvents/follow' || method === 'agentEvents/unfollow') return { ok: true };
            if (method === 'agentEvents/read') {
                const t = transcripts.get(params.session);
                if (!t) throw new Error(`no session ${params.session}`);
                return { lines: [{ type: 'session', ...t.info, size: LINE }, ...t.events].map(J), size: LINE };
            }
            throw new Error(`unexpected ${method}`);
        },
    };
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
    const ctx = { scene: new THREE.Scene(), atlas: HEADLESS_ATLAS, registry, world: { register() {}, unregister() {}, relayout() {} },
                  carrels: new Map(), workspace: new WorkspaceModel(), cameraDock: null, camera: null,
                  getSurfaces: () => [], getGrids: () => [], deltaBooks: null };
    ctx.holding = new Holding(ctx);
    ctx.agentBooks = new AgentBooks(ctx);
    ctx.agentBooks.cfg.maxSheets = 4;
    ctx.sessionProvider = new AgentSessionProvider(bridge);
    ctx.agentVisibility = new AgentVisibility(ctx);   // NOT settled: the gate is closed until a restore
    ctx.sessionBooks = new SessionBooks(ctx, ctx.sessionProvider);
    const verbs = new Map();
    registerAgentCommands({ register: (n, fn) => verbs.set(n, fn), execute: async () => ({ text: 'OK' }) });
    const run = (name, ...args) => verbs.get(name)(args.map(String), ctx);
    const execs = [];
    const exec = async (cmd) => { execs.push(cmd); if (cmd[0] === 'terminal.kill') registry.unregister(cmd[1]); return { text: 'OK' }; };
    const gomux = { onChange: () => () => {}, onPaneSize: () => () => {} };
    ctx.gomuxHub = new GomuxHub(ctx, gomux, ctx.sessionBooks, { exec });
    ctx.sessionDesk = new SessionDesk(ctx, ctx.sessionProvider, ctx.sessionBooks);
    const store = new SessionStore({ ctx, router: { execute: async () => ({ text: 'OK' }) }, bridge: { rpcRequest: async () => ({}) } });
    return { ctx, relay, run, execs, store, books: ctx.agentBooks, sb: ctx.sessionBooks, vis: ctx.agentVisibility,
             hub: ctx.gomuxHub, desk: ctx.sessionDesk };
}
const reads = (w, sid) => w.relay.calls.filter((c) => c.method === 'agentEvents/read' && c.params.session === sid).length;
const unfollows = (w, sid) => w.relay.calls.filter((c) => c.method === 'agentEvents/unfollow' && c.params.session === sid).length;
const settle = async (w) => { await tick(); await Promise.all([...w.sb.streams.values()].map((s) => s.opening?.catch(() => {}))); await tick(); };
const lanes = (w) => [...w.books.lanes.keys()].sort();
const node = (name, sessionId, extra = {}) => ({ name, parent: '', backend: 'claude', harness: 'claude', sessionId, live: true,
    status: 'idle', attached: false, createdAt: new Date().toISOString(), ...extra });

/** One host: two hub agents (their sessions carry the workgroup), two local sessions, an old one. */
function host(w) {
    const S = {
        H1: w.relay.add(session('H1', { workgroup: { name: 'lead' } })),
        H2: w.relay.add(session('H2', { workgroup: { name: 'helper' } })),
        L1: w.relay.add(session('L1')),
        L2: w.relay.add(session('L2', { status: 'ended', mtime: ago(1) })),
        OLD: w.relay.add(session('OLD', { status: 'ended', mtime: ago(200) })),
    };
    w.relay.sessions = Object.values(S);
    const tree = { gen: 1, dirs: [], agents: [node('lead', 'H1'), node('helper', 'H2', { parent: 'lead' })] };
    return { S, tree };
}

// ── 1. the gate: nothing opens before the saved set is known; then only what's shown ──
let savedSnap;
{
    const w = makeWorld();
    const { S, tree } = host(w);
    w.hub.apply(tree);                 // the tree beat the session file to the page
    w.relay.list(Object.values(S));    // so did the session list
    await settle(w);
    eq(lanes(w), [], 'before the saved set is known: no book is born');
    ok(w.relay.calls.every((c) => c.method !== 'agentEvents/read'), 'and nothing is read');

    const snap = { version: 2, agentVisibility: { agents: { helper: true, L2: true, OLD: true }, groups: {} },
                   agents: [{ session: 'L1', following: true }, { session: 'L2', following: false }, { session: 'OLD', following: false, pinned: [0, 0, 0] }] };
    await w.store.restore(snap);
    await settle(w);
    ok(w.vis.ready, 'the restore opened the gate');
    eq(lanes(w), ['L1', 'lead'], 'then the hub and the desk open only the shown agents');
    eq([reads(w, 'H2'), reads(w, 'L2'), reads(w, 'OLD')], [0, 0, 0], 'a hidden agent is never read — not even briefly');
    ok(w.store.lastRestore.phases.some((p) => p.name === 'visibility' && p.ok), 'the visibility phase ran in the restore');
    eq(w.hub.hiddenAgents().map((a) => a.name), ['helper'], 'the hub lists its hidden agent');
    eq(w.desk.hiddenSessions().map((s) => s.session_id), ['L2'], 'the desk lists its hidden session');
    ok(w.hub.rows().find((r) => r.agent.name === 'helper')?.hidden === true, 'gomux.list rows say hidden');

    // ── 2. show / hide ───────────────────────────────────────────────────────────────
    let r = await w.run('agent.show', 'helper');
    await settle(w);
    ok(/^OK: showed helper/.test(r.text) && w.books.lanes.has('helper') && reads(w, 'H2') === 1, `agent.show opens a hub agent's book (${r.text})`);
    ok(w.vis.override('helper') === null, 'showing an agent of a shown group hands it back to the group (no override left)');
    r = await w.run('agent.show', 'OLD');
    await settle(w);
    ok(w.books.lanes.has('OLD') && reads(w, 'OLD') === 1, `agent.show opens a session outside the desks' windows (${r.text})`);

    const screen = new THREE.Object3D();   // a terminal-shaped window
    screen.getLocalBounds = () => new THREE.Box3(new THREE.Vector3(0, -50, 0), new THREE.Vector3(160, 0, 0));
    w.ctx.registry.register(w.hub.screenId('lead'), screen, { type: 'terminal' });
    r = await w.run('agent.hide', 'lead');
    await settle(w);
    ok(!w.books.lanes.has('lead') && !w.sb.streams.has('H1') && unfollows(w, 'H1') === 1, `agent.hide closes the book and its stream (${r.text})`);
    ok(w.execs.some((c) => c[0] === 'terminal.kill' && c[1] === 'gx-lead'), "and the hub agent's screen");
    w.hub.apply({ ...tree, gen: 2 });
    await settle(w);
    ok(!w.books.lanes.has('lead'), 'a tree push keeps a hidden agent closed');
    eq(reads(w, 'H1'), 1, 'and reads nothing for it');

    // agent.open of a hidden session shows it
    await w.run('agent.hide', 'L2');
    r = await w.run('agent.open', 'L2');
    await settle(w);
    ok(w.books.lanes.has('L2') && !w.vis.isHidden(w.vis.who('L2')), `agent.open of a hidden session shows it (${r.text})`);

    // ── 3. agent.clear: a desk's book is hidden; one opened from history only closes ──
    r = await w.run('agent.clear', 'L1');
    await settle(w);
    ok(!w.books.lanes.has('L1') && w.vis.isHidden(w.vis.who('L1')) && /hidden/.test(r.text), `agent.clear on a desk's book hides it (${r.text})`);
    w.relay.list([...w.relay.sessions]);
    await settle(w);
    ok(!w.books.lanes.has('L1'), 'and the desk keeps it closed');
    r = await w.run('agent.clear', 'OLD');
    ok(!w.books.lanes.has('OLD') && !w.vis.isHidden(w.vis.who('OLD')), 'agent.clear on a book opened from history only closes it');

    // ── 4. capture → a fresh page restores the set and opens none of it ────────────────
    savedSnap = w.store.capture();
    eq(savedSnap.agentVisibility, { agents: { lead: true, L1: true }, groups: {} }, 'capture saves the hidden set');
    ok(!savedSnap.agents.some((a) => a.session === 'L1'), "a hidden book isn't in the saved roster either");
}
{
    const w = makeWorld();
    const { S, tree } = host(w);
    w.hub.apply(tree);
    w.relay.list(Object.values(S));
    await w.store.restore({ ...savedSnap, agents: [...savedSnap.agents, { session: 'L1', following: true }] });
    await settle(w);
    eq(lanes(w), ['L2', 'helper'], 'a fresh page restoring the set opens only the shown agents');
    eq([reads(w, 'H1'), reads(w, 'L1')], [0, 0], 'the hidden ones are never read — a stale roster entry included');
}

// ── 5. groups: hidden (a new agent stays closed), ended, shown drops overrides ────────
{
    const w = makeWorld();
    const { S, tree } = host(w);
    w.vis.settle();
    w.hub.apply(tree);
    w.relay.list(Object.values(S));
    await settle(w);
    eq(lanes(w), ['L1', 'L2', 'helper', 'lead'], 'nothing hidden: every agent of both desks gets its book');
    await w.run('agent.show', 'lead');   // no-op (already shown)
    await w.run('agent.hide', 'helper');
    let r = await w.run('agent.group', 'gomux', 'hidden');
    await settle(w);
    eq(lanes(w), ['L1', 'L2'], `agent.group gomux hidden closes the hub's books (${r.text})`);
    w.relay.add(session('H3', { workgroup: { name: 'newcomer' } }));
    w.hub.apply({ ...tree, gen: 3, agents: [...tree.agents, node('newcomer', 'H3')] });
    await settle(w);
    ok(!w.books.lanes.has('newcomer') && reads(w, 'H3') === 0, 'a new agent in a hidden group stays closed');
    await w.run('agent.show', 'newcomer');
    await settle(w);
    ok(w.books.lanes.has('newcomer') && w.vis.override('newcomer') === false, 'showing one agent of a hidden group gives it its own override');
    r = await w.run('agent.group', 'gomux', 'shown');
    await settle(w);
    eq(lanes(w), ['L1', 'L2', 'helper', 'lead', 'newcomer'], 'agent.group gomux shown: every agent back — the members\' overrides (helper\'s hide) dropped');
    eq(w.vis.state().agents, {}, 'no override left');

    r = await w.run('agent.group', 'local', 'ended');
    await settle(w);
    eq(lanes(w), ['L1', 'helper', 'lead', 'newcomer'], `agent.group local ended closes the ended session's book (${r.text})`);
    w.relay.list(w.relay.sessions.map((s) => (s.session_id === 'L1' ? { ...s, status: 'ended' } : s)));
    await settle(w);
    ok(!w.books.lanes.has('L1'), 'and one that ends later');
    const hidden = await w.run('agent.hidden');
    ok(hidden.data.groups.local === 'ended' && J(hidden.data.hidden.local.sort()) === J(['L1', 'L2']), `agent.hidden reports the rule and who it hides (${J(hidden.data)})`);
    const bad = await w.run('agent.group', 'history', 'hidden');
    ok(/^ERR/.test(bad.text), 'an unknown group is refused');
}

// ── 6. the desk's window: a hidden session keeps its slot (no older book backfills) ───
{
    const w = makeWorld();
    w.vis.settle();
    const { setSetting, resetSetting } = await import('../app/client/settings.js');
    setSetting(w.ctx, 'agents.maxBooks', 2);
    const ss = ['A', 'B', 'C'].map((id) => w.relay.add(session(id)));
    await w.run('agent.group', 'local', 'shown');
    w.vis.setAgent('A', true);
    w.relay.list(ss);
    await settle(w);
    eq(lanes(w), ['B'], 'agents.maxBooks counts a hidden session: hiding never opens an older one in its place');
    await w.run('agent.show', 'A');
    await settle(w);
    eq(lanes(w), ['A', 'B'], 'shown again, it opens in its slot');
    resetSetting(w.ctx, 'agents.maxBooks');
}

console.log(`agent-visibility: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

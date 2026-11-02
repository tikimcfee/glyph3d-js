// carrel-session.test.mjs — shared carrels: presence, attribution, and attention staying the
// person's (app/client/Participants.js; carrel.attach / detach / who in carrelCommands.js; the
// identified-caller refusal in attentionCommands.js and point.go).
//
//   bun tools/carrel-session.test.mjs
//
// Locks, through the REAL CommandRouter (the per-call caller) and a real AttentionManager:
//   - an anonymous carrel.attach / detach fails loud; an identified one is listed by carrel.who,
//     once (a repeat says "already"), oldest first, at a desk that exists (an unknown one fails)
//   - what an attached caller seats there carries its name (carrel.add's receipt + carrel.who);
//     a caller not attached there seats unattributed
//   - attention.set / clear / capture from an identified caller are refused and the slots don't
//     move; nested in another verb (ctx.execute) they are refused too; anonymous writes work;
//     attention.info answers anyone; point.go refuses an identified caller before moving anything
//   - TEETH: the old dispatch (a nested call starts anonymous) lets a nested attention.set from an
//     agent's verb through — the same check must fail there
//   - presence is ephemeral: gomuxai reporting an agent ended drops it everywhere; a desk that
//     dissolves takes its participants with it; detach with no desk leaves every desk
// (The other half of slice 7's gate — an agent's edit landing with the reading row held — is
// tools/agent-edits.test.mjs.)

import './headless-canvas.mjs';
import * as THREE from 'three';
import CommandRouter from '../packages/glyph3d-core/src/services/orchestration/CommandRouter.js';
import AttentionManager from '../packages/glyph3d-core/src/services/interaction/AttentionManager.js';
import Carrel from '../packages/glyph3d-core/src/services/interaction/Carrel.js';
import WorkspaceModel from '../app/client/WorkspaceModel.js';
import Holding from '../app/client/Holding.js';
import Participants from '../app/client/Participants.js';

globalThis.window ??= { addEventListener() {} };
const { default: registerCarrelCommands } = await import('../app/commands/handlers/carrelCommands.js');
const { default: registerAttentionCommands } = await import('../app/commands/handlers/attentionCommands.js');
const { default: registerDeixisCommands } = await import('../app/commands/handlers/deixisCommands.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };
const quiet = async (fn) => { const i = console.info; console.info = () => {}; try { return await fn(); } finally { console.info = i; } };

const makeGrid = () => {
    const g = new THREE.Object3D();
    g.getLocalBounds = (t = new THREE.Box3()) => t.set(new THREE.Vector3(-5, -6, -0.1), new THREE.Vector3(5, 0, 0.1));
    g.getBounds = (t = new THREE.Box3()) => { g.updateWorldMatrix(true, false); return g.getLocalBounds(t).applyMatrix4(g.matrixWorld); };
    return g;
};

/** A world with two desks, two files, the real router + attention. @param {boolean} oldDispatch */
function makeWorld(oldDispatch = false) {
    const scene = new THREE.Scene();
    const tree = new THREE.Group();
    scene.add(tree);
    const entries = new Map();
    const registry = {
        register(id, grid, meta = {}) { entries.set(id, { id, grid, ...meta }); },
        unregister(id) { const e = entries.get(id); entries.delete(id); return e; },
        get: (id) => entries.get(id) || null,
        has: (id) => entries.has(id),
        getIdByGrid: (g) => { for (const e of entries.values()) if (e.grid === g) return e.id; return null; },
        list: () => [...entries.values()],
    };
    const ctx = {
        scene, registry, cameraDock: null, agentBooks: { lanes: new Map(), resolveLane: () => null, agents: () => [] }, deltaBooks: null,
        carrels: new Map(), workspace: new WorkspaceModel(),
        getSurfaces: () => [...entries.values()].map((e) => e.grid),
        getGrids: () => [...entries.values()].filter((e) => e.type === 'grid').map((e) => e.grid),
        camera: null, world: null, cameraController: null,
        attentionManager: new AttentionManager(),
        deixis: null, sender: null, caller: null, cid: 0, execute: null,
    };
    ctx.holding = new Holding(ctx);
    ctx.participants = new Participants(ctx);
    for (const name of ['A', 'B']) {
        const c = new Carrel({ name, radius: 15 });
        scene.add(c);
        ctx.carrels.set(name, c);
        registry.register(`carrel:${name}`, c, { type: 'carrel' });
    }
    for (const id of ['/p/a.js', '/p/b.js']) {
        const g = makeGrid();
        tree.add(g);
        registry.register(id, g, { type: 'grid' });
    }
    const router = new CommandRouter(ctx);
    if (oldDispatch) {
        // The dispatch before the per-call caller: a nested call is a fresh, anonymous one.
        router._viewFor = (frame) => {
            const own = { sender: frame.sender, caller: frame.caller, cid: frame.cid, execute: (i, o = {}) => router.execute(i, { ...o, parent: { sender: null, caller: null, cid: 0 } }) };
            return new Proxy(ctx, { get: (t, k) => (Object.hasOwn(own, k) ? own[k] : Reflect.get(t, k)) });
        };
    }
    registerCarrelCommands(router);
    registerAttentionCommands(router);
    registerDeixisCommands(router);
    // An agent's verb that, inside, writes the focus — the nested path the refusal must also see.
    router.register('probe.focus', async (args, c) => c.execute(['attention.set', 'primary', args[0]]));
    const as = (name) => (line) => quiet(() => router.execute(line, { caller: name, sender: `ctrl-${name}` }));
    const anon = (line) => quiet(() => router.execute(line));
    return { ctx, router, as, anon };
}

// ── presence ──
{
    const w = makeWorld();
    const cam = w.as('agent-cam'), pix = w.as('agent-pix');
    const a0 = await w.anon(['carrel.attach', 'A']);
    ok(a0.text.startsWith('ERR') && /identified caller/.test(a0.text), `anonymous carrel.attach fails loud (got "${a0.text}")`);
    const d0 = await w.anon(['carrel.detach']);
    ok(d0.text.startsWith('ERR'), `anonymous carrel.detach fails loud (got "${d0.text}")`);
    const bad = await cam(['carrel.attach', 'nowhere']);
    ok(bad.text.startsWith('ERR'), `attach to an unknown desk fails (got "${bad.text}")`);
    const noArg = await cam(['carrel.attach']);
    ok(noArg.text.startsWith('ERR') && /usage/.test(noArg.text), `attach with no desk names its usage (got "${noArg.text}")`);

    const a1 = await cam(['carrel.attach', 'A']);
    ok(a1.text.startsWith('OK') && a1.data?.already === false, `an identified caller attaches (got "${a1.text}")`);
    const a2 = await cam(['carrel.attach', 'A']);
    ok(a2.data?.already === true, 'a repeat attach says already');
    await new Promise((r) => setTimeout(r, 2));
    await pix(['carrel.attach', 'A']);
    await pix(['carrel.attach', 'B']);
    const whoA = await w.anon(['carrel.who', 'A']);
    ok(JSON.stringify(whoA.data?.participants.map((p) => p.name)) === '["agent-cam","agent-pix"]', `carrel.who A lists both, oldest first (got ${JSON.stringify(whoA.data)})`);
    const whoAll = await w.anon(['carrel.who']);
    ok(whoAll.data?.participants.length === 3, `carrel.who with no desk lists every attachment (got ${whoAll.data?.participants.length})`);
    ok(w.ctx.participants.who('A')[0].hue && Number.isFinite(w.ctx.participants.who('A')[0].hue.r), 'a participant carries its hue (the hue its points draw in)');

    // attribution
    const s1 = await cam(['carrel.add', '/p/a.js', 'A']);
    ok(s1.text.startsWith('OK') && s1.data?.by === 'agent-cam' && /\(by agent-cam\)/.test(s1.text), `a participant's seat carries its name (got "${s1.text}")`);
    const s2 = await cam(['carrel.add', '/p/b.js', 'B']);
    ok(s2.text.startsWith('OK') && s2.data?.by === null, `seating at a desk it isn't attached to is unattributed (got "${s2.text}")`);
    const who2 = await w.anon(['carrel.who', 'A']);
    ok(JSON.stringify(who2.data.participants.find((p) => p.name === 'agent-cam').seated) === '["/p/a.js"]', 'carrel.who lists what it seated there');

    // ephemeral: gomuxai reports agent-pix ended → gone from A and B
    w.ctx.participants.dropEnded([{ name: 'agent-pix', live: false }, { name: 'agent-cam', live: true }], (a) => a.live);
    ok(!w.ctx.participants.isAt('agent-pix', 'A') && !w.ctx.participants.isAt('agent-pix', 'B'), 'an agent gomuxai reports ended leaves every desk');
    ok(w.ctx.participants.isAt('agent-cam', 'A'), 'a running agent stays');
    // a dissolved desk takes its participants
    await pix(['carrel.attach', 'B']);
    w.ctx.carrels.get('B')._dissolving = true;
    const whoB = await w.anon(['carrel.who']);
    ok(!whoB.data.participants.some((p) => p.carrel === 'B'), 'a dissolving desk takes its participants with it');
    w.ctx.carrels.get('B')._dissolving = false;
    // detach with no desk leaves everywhere
    await cam(['carrel.attach', 'B']);
    const d1 = await cam(['carrel.detach']);
    ok(d1.text.startsWith('OK') && d1.data.left.length === 2 && w.ctx.participants.carrelsOf('agent-cam').length === 0, `detach with no desk leaves every desk (got "${d1.text}")`);
    const d2 = await cam(['carrel.detach', 'A']);
    ok(d2.text.startsWith('ERR'), `detaching where it isn't fails loud (got "${d2.text}")`);
}

// ── attention stays the person's ──
async function attentionScenario(oldDispatch) {
    const w = makeWorld(oldDispatch);
    const am = w.ctx.attentionManager;
    const cam = w.as('agent-cam');
    await w.anon(['attention.set', 'primary', '/p/a.js']);
    const r = {};
    r.anonSet = am.get('primary')?.id === '/p/a.js';
    const set = await cam(['attention.set', 'primary', '/p/b.js']);
    r.setRefused = set.text.startsWith('ERR') && /person's/.test(set.text) && am.get('primary')?.id === '/p/a.js';
    const clr = await cam(['attention.clear']);
    r.clearRefused = clr.text.startsWith('ERR') && am.get('primary')?.id === '/p/a.js';
    const cap = await cam(['attention.capture', 'on']);
    r.captureRefused = cap.text.startsWith('ERR');
    const info = await cam(['attention.info']);
    r.infoAnswers = info.text.startsWith('OK') || !!info.data;
    await cam(['probe.focus', '/p/b.js']);
    r.nestedRefused = am.get('primary')?.id === '/p/a.js';
    const go = await cam(['point.go']);
    r.goRefused = go.text.startsWith('ERR') && /person's verb/.test(go.text);
    await w.anon(['probe.focus', '/p/b.js']);
    r.anonNested = am.get('primary')?.id === '/p/b.js';
    return r;
}
{
    const r = await attentionScenario(false);
    ok(r.anonSet, 'an anonymous attention.set works (the UI, a person\'s own CLI)');
    ok(r.setRefused, 'attention.set from an identified caller is refused; primary does not move');
    ok(r.clearRefused, 'attention.clear from an identified caller is refused');
    ok(r.captureRefused, 'attention.capture from an identified caller is refused');
    ok(r.infoAnswers, 'attention.info answers an identified caller');
    ok(r.nestedRefused, 'a nested attention.set inside an agent\'s verb is refused too (the per-call caller)');
    ok(r.goRefused, 'point.go refuses an identified caller before moving anything');
    ok(r.anonNested, 'the same nested write from an anonymous call lands');
}
{
    // TEETH: the old dispatch starts a nested call anonymous — the agent's nested write slips through.
    const r = await attentionScenario(true);
    ok(r.setRefused, 'teeth harness: the direct refusal still holds under the old dispatch');
    ok(!r.nestedRefused, 'TEETH: under the old dispatch the nested attention.set gets through (the per-call caller is what stops it)');
}

console.log(`${fail ? 'FAIL' : 'ok'} carrel-session: ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);

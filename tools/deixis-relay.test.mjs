// deixis-relay.test.mjs — agents' points KEPT BY THE RELAY (cli/points.go, app/client/Deixis.js): a point
// made while no display is connected, and every live point across a reload, comes back when a display
// connects — shown as its owner. Driven through the real CommandRouter, deixis verbs and a real CodeGrid;
// the relay is a fake bridge answering points/list and points/sync exactly as cli/points.go does
// (Go-locked there: TestPoints_*).
//
//   bun tools/deixis-relay.test.mjs
//
// Locks: a kept point (made with no display) is shown on connect, as its owner, in its hue; nothing syncs
// before the kept set is loaded (a fresh page can't wipe it); a reload (a fresh Deixis) gets back what the
// last page had live (its show → sync); a point whose file isn't open yet waits (kept in the sync) and shows
// when the file opens; point.clear (an agent's own, or the person's) reaches the relay; a point shown live
// before the kept one loads wins.

import './headless-canvas.mjs';
import * as THREE from 'three';
import CodeGrid from '../packages/glyph3d-core/src/collections/CodeGrid.js';
import SceneRegistry from '../packages/glyph3d-core/src/services/SceneRegistry.js';
import CommandRouter from '../packages/glyph3d-core/src/services/orchestration/CommandRouter.js';
import Deixis from '../app/client/Deixis.js';
import registerDeixisCommands from '../app/commands/handlers/deixisCommands.js';

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };
const quiet = async (fn) => { const i = console.info, w = console.warn; console.info = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.info = i; console.warn = w; } };
const tick = (ms = 200) => new Promise((r) => setTimeout(r, ms));

const atlas = { getCharSize: () => ({ width: 28, height: 55, em: 48 }), _slugData: null, _shaper: null };
const ROOT = '/w';
const FILE = `${ROOT}/src/x.js`, OTHER = `${ROOT}/src/y.js`;

/** The relay's point store, as cli/points.go keeps it (one per agent; sync replaces). */
function fakeRelay() {
    const by = new Map();
    const calls = [];
    return {
        by, calls,
        keep(who, args) { by.set(who, { who, args, ts: Date.now() }); },   // a point.show answered with no display
        bridge: {
            connected: true,
            rpcRequest: async (method, params) => {
                calls.push(method);
                if (method === 'points/list') return { points: [...by.values()] };
                if (method === 'points/sync') { by.clear(); for (const p of params.points) by.set(p.who, p); return { kept: by.size }; }
                throw new Error(`unexpected ${method}`);
            },
        },
    };
}

/** A display: a code file open (and maybe another later), Deixis, the deixis verbs. */
async function display(relay, { files = [FILE] } = {}) {
    const scene = new THREE.Scene();
    const registry = new SceneRegistry();
    const open = async (path, lines) => {
        const g = new CodeGrid(scene, atlas, { showFilename: false });
        await g.loadText(lines.join('\n'));
        registry.register(path, g, { type: 'grid', sourcePath: path, filename: path.split('/').pop() });
        return g;
    };
    for (const f of files) await open(f, ['// head', 'const rec = load();', 'apply(rec);', 'export default rec;']);
    const ctx = { registry, fileProvider: { rootInfo: { root: ROOT } }, wsbridge: relay.bridge, sender: null, caller: null, cid: 0, execute: null };
    ctx.deixis = new Deixis(ctx);
    ctx.deixis._lastKey = -1e9;   // nobody typing
    const router = new CommandRouter(ctx);
    registerDeixisCommands(router);
    const exec = (argv, who) => quiet(() => router.execute(argv, { caller: who }));
    return { ctx, router, d: ctx.deixis, exec, open, as: (who) => (argv) => exec(argv, who) };
}

// ── a point made with no display is shown when one connects, as its owner ─────────────────────────
{
    const relay = fakeRelay();
    relay.keep('agent-a', ['src/x.js:2', '--say', 'look here']);
    const disp = await display(relay);
    ok(!relay.calls.includes('points/sync'), 'nothing syncs before the kept set is loaded');
    const r = await quiet(() => disp.d.reconnect(disp.exec, { waitMs: 300, everyMs: 30 }));
    const p = disp.d.points.get('agent-a');
    ok(r.shown === 1 && p && p.ref.durable.line === 2 && p.say === 'look here' && p.who === 'agent-a', `the kept point is shown, as its owner (${JSON.stringify({ shown: r.shown, line: p?.ref.durable.line })})`);
    ok(relay.calls.at(-1) === 'points/sync' && relay.by.get('agent-a')?.args[0].startsWith('{'), 'then the live set is synced back (as a ref JSON the display recreates exactly)');
}

// ── a reload: what the last page had live comes back ────────────────────────────────────────────────
{
    const relay = fakeRelay();
    const a = await display(relay);
    await quiet(() => a.d.reconnect(a.exec, { waitMs: 100, everyMs: 20 }));
    await a.as('agent-b')(['point.show', 'src/x.js:3', '--kind', 'suggest', '--with', 'apply(rec, opts);']);
    await tick();
    ok(relay.by.has('agent-b'), 'a live point.show is synced to the relay');
    const b = await display(relay);   // the page reloads
    await quiet(() => b.d.reconnect(b.exec, { waitMs: 100, everyMs: 20 }));
    const p = b.d.points.get('agent-b');
    ok(p && p.kind === 'suggest' && p.replace === 'apply(rec, opts);' && p.ref.durable.line === 3, `after a reload the agent's point is back, kind and proposal kept (${p?.ref.text})`);
    // the person clears it: the relay forgets it
    await quiet(() => b.router.execute(['point.clear', 'agent-b']));
    await tick();
    ok(!relay.by.has('agent-b'), 'point.clear reaches the relay');
    const c = await display(relay);
    await quiet(() => c.d.reconnect(c.exec, { waitMs: 100, everyMs: 20 }));
    ok(!c.d.points.has('agent-b'), 'a cleared point does not come back');
}

// ── a point whose file isn't open yet waits (kept), and shows when it opens ───────────────────────
{
    const relay = fakeRelay();
    relay.keep('agent-c', ['src/y.js:1']);
    const disp = await display(relay);   // y.js not open yet
    const r = await quiet(() => disp.d.reconnect(disp.exec, { waitMs: 2000, everyMs: 30 }));
    ok(r.shown === 0 && r.waiting === 1 && relay.by.has('agent-c'), 'its file not open: waiting, and still kept by the relay after the sync');
    await disp.open(OTHER, ['// y head', 'y();']);
    const total = await quiet(() => r.done);
    ok(total === 1 && disp.d.points.get('agent-c')?.ref.entity === OTHER, 'the file opens: it is shown');
}

// ── a point shown live before the kept one loads wins ─────────────────────────────────────────────
{
    const relay = fakeRelay();
    relay.keep('agent-d', ['src/x.js:1']);
    relay.keep('agent-e', ['src/x.js:2']);
    const disp = await display(relay);
    await disp.as('agent-d')(['point.show', 'src/x.js:4']);
    await tick();
    ok(relay.by.has('agent-e'), "a live point before the kept set loads syncs nothing over it (agent-e's kept point survives)");
    await quiet(() => disp.d.reconnect(disp.exec, { waitMs: 100, everyMs: 20 }));
    ok(disp.d.points.get('agent-e')?.ref.durable.line === 2, "and is shown when it loads");
    ok(disp.d.points.get('agent-d')?.ref.durable.line === 4 && relay.by.get('agent-d')?.args[0].includes('"line":4'), 'the newer, live point stands (and is what the relay keeps)');
}

console.log(`${fails ? 'FAIL' : 'ok'} deixis-relay: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);

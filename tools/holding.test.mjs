// holding.test.mjs — behavior lock for the shared holding controller (app/client/Holding.js):
// residence (carrel) vs vehicle (dock), the one holdable resolver, and the handoffs.
//
//   bun tools/holding.test.mjs
//
// Locks:
//   - resolve: exact registry id, surface index, an agent book's lane id / `agent:<id>` label →
//     its registry id `agent:book:<id>`; book pages, library volumes, and carrels are refused
//     with a reason
//   - borrow: docking a seated window keeps its seat; undocking puts it back in the seat
//   - carrel.add of a borrowed window at its own desk puts it back ('returned')
//   - unseat while borrowed: stays docked, the ride now ends at the desk's home (the tree)
//   - seat at desk B while borrowed from desk A: leaves A, ends the ride, carries A's home
//   - lift: out of dock AND desk, both facts cleared
//   - reconcile: a window claimed by a desk AND docked seats first, then rides FROM the seat
//   - fold: a desk folding while a member is borrowed re-homes that ride to the tree
//   - the carrel verbs accept every book form (B1: `carrel.release agent:<id>`)
//   - grid.* verbs address grids only: `grid.close` refuses a terminal, a book, a card
//
// Real CameraDock + Carrel + WorkspaceModel over a mock registry; GPU-free.

import './headless-canvas.mjs';
import { HEADLESS_ATLAS } from './headless-atlas.mjs';
import * as THREE from 'three';
import Carrel from '../packages/glyph3d-core/src/services/interaction/Carrel.js';
import CameraDock from '../packages/glyph3d-core/src/services/interaction/CameraDock.js';
import WorkspaceModel from '../app/client/WorkspaceModel.js';
import Holding from '../app/client/Holding.js';

globalThis.window ??= { addEventListener() {} };
const { default: registerCarrelCommands } = await import('../app/commands/handlers/carrelCommands.js');
const { default: registerGridCommands } = await import('../app/commands/handlers/gridCommands.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };
const near = (a, b, eps, m) => ok(Math.abs(a - b) <= eps, `${m} (got ${a}, want ${b}±${eps})`);

const makeGrid = (w = 10, h = 6) => {
    const g = new THREE.Object3D();
    g.getLocalBounds = (t = new THREE.Box3()) => t.set(new THREE.Vector3(-w / 2, -h, -0.1), new THREE.Vector3(w / 2, 0, 0.1));
    g.getBounds = (t = new THREE.Box3()) => { g.updateWorldMatrix(true, false); return g.getLocalBounds(t).applyMatrix4(g.matrixWorld); };
    return g;
};

function makeWorld() {
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
    const cameraDock = new CameraDock({ atlas: HEADLESS_ATLAS });
    scene.add(cameraDock);
    const lanes = new Map();
    const agentBooks = {
        lanes,
        resolveLane(ref) {
            const id = String(ref ?? '');
            if (lanes.has(id)) return [id, lanes.get(id)];
            for (const e of lanes.entries()) if (e[1].groupId === id) return e;
            if (id.startsWith('agent:') && lanes.has(id.slice(6))) return [id.slice(6), lanes.get(id.slice(6))];
            return null;
        },
        agents: () => [...lanes.keys()].map((id) => ({ id })),
    };
    const ctx = {
        scene, registry, cameraDock, agentBooks, deltaBooks: null,
        carrels: new Map(), workspace: new WorkspaceModel(),
        getSurfaces: () => [...entries.values()].map((e) => e.grid),
        getGrids: () => [...entries.values()].filter((e) => e.type === 'grid').map((e) => e.grid),
        camera: null, world: null,
    };
    ctx.holding = new Holding(ctx);
    const desk = (name, x = 0) => {
        const c = new Carrel({ name, radius: 15 });
        c.position.x = x;
        scene.add(c);
        ctx.carrels.set(name, c);
        registry.register(`carrel:${name}`, c, { type: 'carrel' });
        return c;
    };
    const file = (id, x = 40) => {
        const g = makeGrid();
        g.position.set(x, 12, -8);
        tree.add(g);
        registry.register(id, g, { type: 'grid' });
        return g;
    };
    const tick = () => { for (let i = 0; i < 10; i++) { cameraDock.update(0.05, null); for (const c of ctx.carrels.values()) c.update(0.05); } };
    return { ctx, scene, tree, registry, lanes, desk, file, tick };
}

// ── resolve ──
{
    const w = makeWorld();
    w.file('/p/a.js');
    const book = makeGrid();
    w.scene.add(book);
    w.lanes.set('abc123', { groupId: 'agent:book:abc123', book });
    w.registry.register('agent:book:abc123', book, { type: 'book', role: 'agent' });
    w.registry.register('card-1', makeGrid(), { type: 'grid', role: 'card' });
    w.registry.register('vol:/p', makeGrid(), { type: 'book', role: 'volume' });
    w.desk('d');
    const R = (a) => w.ctx.holding.resolve(a);
    ok(R('/p/a.js').id === '/p/a.js' && R('/p/a.js').kind === 'grid', 'resolve: exact registry id');
    ok(R('0').id === '/p/a.js', 'resolve: surface index');
    ok(R('abc123').id === 'agent:book:abc123', 'resolve: lane id → the book\'s registry id');
    ok(R('agent:abc123').id === 'agent:book:abc123', 'resolve: `agent:<id>` label → the book\'s registry id');
    ok(R('agent:book:abc123').kind === 'agent', 'resolve: the registry id itself');
    ok(/page of a book/.test(R('card-1').error ?? ''), `resolve: a card is refused with a reason (got ${JSON.stringify(R('card-1'))})`);
    ok(/library volume/.test(R('vol:/p').error ?? ''), 'resolve: a library volume is refused');
    ok(/carrel/.test(R('carrel:d').error ?? ''), 'resolve: a carrel is refused');
    ok(/nothing named/.test(R('nope').error ?? ''), 'resolve: an unknown address says so');
}

// ── borrow, return, unseat-while-borrowed, desk→desk while borrowed, lift ──
{
    const w = makeWorld();
    const H = w.ctx.holding, ws = w.ctx.workspace;
    const g = w.file('/p/a.js');
    const A = w.desk('A'), B = w.desk('B', 100);
    const r = H.resolve('/p/a.js');

    ok(H.seat(r, A) === 'seated', 'seat: seated at A');
    w.tick();
    const seat = g.position.clone();
    ok(ws.getSurface(r.id).view.carrel?.name === 'A', 'seat: view.carrel fact written');

    ok(H.dock.lock(r), 'borrow: dock a seated window');
    w.tick();
    ok(g.parent === w.ctx.cameraDock && A.has(r.id), 'borrow: rides the dock, still A\'s member');
    ok(H.residenceOf(r.id) === A && H.holderOf(r.id) === w.ctx.cameraDock, 'lookups: residence A, carried by the dock');
    ok(H.homeOf(r.id)?.parent === w.tree, 'homeOf: the true home is the tree, never the seat');

    H.dock.release(r.id);
    w.tick();
    ok(g.parent === A, 'undock: back to the seat');
    near(g.position.distanceTo(seat), 0, 1e-3, 'undock: the same seat');
    ok(ws.getSurface(r.id).view.carrel?.name === 'A' && !ws.getSurface(r.id).view.docked, 'undock: residence kept, ride fact cleared');

    H.dock.lock(r); w.tick();
    ok(H.seat(r, A) === 'returned', 'seat at its own desk while borrowed: put back');
    w.tick();
    ok(g.parent === A && !H.isDocked(r.id), 'returned: seated, not docked');

    H.dock.lock(r); w.tick();
    ok(H.unseat(r.id) === A, 'unseat while borrowed: leaves A');
    ok(H.isDocked(r.id) && !A.has(r.id), 'unseat while borrowed: still docked, no longer A\'s');
    ok(ws.getSurface(r.id).view.carrel == null, 'unseat: view.carrel cleared');
    H.dock.release(r.id); w.tick();
    ok(g.parent === w.tree, 'unseat while borrowed: the ride now ends in the tree');
    near(g.position.x, 40, 1e-3, 'at the original tree position');

    H.seat(r, A); w.tick();
    H.dock.lock(r); w.tick();
    ok(H.seat(r, B) === 'seated', 'seat at B while borrowed from A');
    w.tick();
    ok(g.parent === B && !A.has(r.id) && !H.isDocked(r.id), 'B holds it; A and the dock let go');
    ok(ws.getSurface(r.id).view.carrel?.name === 'B' && !ws.getSurface(r.id).view.docked, 'facts: B, not docked');
    B.release(r.id); w.tick();
    ok(g.parent === w.tree, 'release from B returns to the TREE (A\'s home carried over)');

    H.seat(r, A); w.tick();
    H.dock.lock(r); w.tick();
    ok(H.lift(r.id, { inPlace: true }) === 'dock+carrel', 'lift: reports both holders');
    w.tick();
    ok(g.parent === w.tree && !A.has(r.id) && !H.isDocked(r.id), 'lift: free, back in its home frame');
    const v = ws.getSurface(r.id).view;
    ok(v.carrel == null && !v.docked, 'lift: both facts cleared');
}

// ── reconcile: seat first, then ride from the seat ──
{
    const w = makeWorld();
    const H = w.ctx.holding, ws = w.ctx.workspace;
    const A = w.desk('A');
    ws.setSurfaceView('/p/r.js', undefined, { carrel: { name: 'A', order: 0 } });
    ws.setSurfaceView('/p/r.js', undefined, { docked: true, dockOrder: 0 });
    const g = w.file('/p/r.js');
    // The dock pass alone must defer to the pending seat.
    H.dock.reconcile((id) => H.carrels.awaitingSeat(id));
    ok(!H.isDocked('/p/r.js'), 'reconcile: the dock waits while the desk has yet to seat it');
    H.reconcile();
    w.tick();
    ok(A.has('/p/r.js') && H.isDocked('/p/r.js'), 'reconcile: seated, then docked');
    H.dock.release('/p/r.js'); w.tick();
    ok(g.parent === A, 'reconcile: undocking returns it to the seat (rode FROM the seat)');

    // A window that went live docked before its desk seated it (the mid-restore race).
    ws.setSurfaceView('/p/s.js', undefined, { carrel: { name: 'A', order: 1 } });
    const g2 = w.file('/p/s.js', 60);
    H.dock.lock({ id: '/p/s.js', grid: g2 });
    w.tick();
    H.reconcile();
    w.tick();
    ok(A.has('/p/s.js') && H.isDocked('/p/s.js'), 'race: seated and re-docked');
    H.dock.release('/p/s.js'); w.tick();
    ok(g2.parent === A, 'race: undock returns it to its seat');
    A.release('/p/s.js'); w.tick();
    near(g2.position.x, 60, 1e-3, 'race: its tree home survived the re-seat');
}

// ── fold while borrowed ──
{
    const w = makeWorld();
    const H = w.ctx.holding;
    const g = w.file('/p/f.js');
    const A = w.desk('A');
    const r = H.resolve('/p/f.js');
    H.seat(r, A); w.tick();
    H.dock.lock(r); w.tick();
    H.fold(A);
    A.dissolve();
    w.tick();
    ok(H.isDocked(r.id) && w.ctx.workspace.getSurface(r.id).view.carrel == null, 'fold: the borrowed member stays docked, residence cleared');
    H.dock.release(r.id); w.tick();
    ok(g.parent === w.tree, 'fold: its ride now ends in the tree, not a vanished seat');
}

// ── the carrel verbs take every book form (B1) ──
{
    const w = makeWorld();
    const handlers = {};
    registerCarrelCommands({ register: (n, fn) => { handlers[n] = fn; }, execute() {} });
    const book = makeGrid();
    w.tree.add(book);
    w.lanes.set('zz9', { groupId: 'agent:book:zz9', book });
    w.registry.register('agent:book:zz9', book, { type: 'book', role: 'agent' });
    const A = w.desk('A');
    const add = handlers['carrel.add'](['agent:zz9', 'A'], w.ctx);
    ok(add.text.startsWith('OK') && A.has('agent:book:zz9'), `carrel.add agent:<id> seats the book under its registry id (got "${add.text}")`);
    const rel = handlers['carrel.release'](['agent:zz9'], w.ctx);
    ok(rel.text.startsWith('OK') && !A.has('agent:book:zz9'), `carrel.release agent:<id> releases it (got "${rel.text}")`);
    const bad = handlers['carrel.add'](['vol:/x', 'A'], w.ctx);
    ok(bad.text.startsWith('ERR'), 'carrel.add refuses what resolve refuses');
}

// ── grid.* verbs address grids only ──
{
    const w = makeWorld();
    const handlers = {};
    registerGridCommands({ register: (n, fn) => { handlers[n] = fn; }, execute() {} });
    w.registry.register('term-1', makeGrid(), { type: 'terminal' });
    w.registry.register('card-1', makeGrid(), { type: 'grid', role: 'card' });
    w.registry.register('agent:book:q', makeGrid(), { type: 'book', role: 'agent' });
    for (const id of ['term-1', 'card-1', 'agent:book:q']) {
        const r = handlers['grid.close']([id], w.ctx);
        ok(r.text.startsWith('ERR') && /not a grid/.test(r.text), `grid.close refuses '${id}' (got "${r.text}")`);
        ok(w.registry.has(id), `grid.close left '${id}' alone`);
    }
}

console.log(`\nholding.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

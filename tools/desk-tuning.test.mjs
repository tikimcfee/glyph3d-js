// desk-tuning.test.mjs — behavior lock for PER-INSTANCE values on desks and shelf books
// (app/client/tuning.js): Settings are the defaults an instance is BORN with; a value set on
// one instance is its own and wins, and persists.
//
//   bun tools/desk-tuning.test.mjs
//
// Locks:
//   - a Settings ▸ Carrel default reaches only desks born after it — a standing desk keeps its value
//   - carrel.set on ONE desk changes that desk alone, records it as its own (carrel.get), and
//     'default' hands it back to what the desk was born as
//   - the gomuxai hub's desks are born in the hub's form (a cylinder hub, wall teams) and a value
//     set on one survives the hub's next tree push (no owner re-stamp); the agents desk is born a
//     cylinder and survives the carrel sweep the same way
//   - reload round-trip: SessionStore.capture saves each desk born-as-it-was (serialize) plus
//     every instance's own values (`tunings`, the hub's derived desks included); restore puts
//     the values back before the desks stand up — a saved desk and a rebuilt hub desk wear
//     them, and a desk the hub built BEFORE the restore ran is projected
//   - carrel.dissolve forgets the desk's values
//   - a shelf book's own deck value survives its shelf's re-apply (setDeckDefaults); 'default'
//     returns it to the shelf's current default; book.form records a shelf book's form; a
//     book registering later is projected; deskOf finds the desk a seated book's card sits at
//
// Real Carrel + Book + Holding + WorkspaceModel + GomuxHub + SessionStore over a mock
// registry and mock agent books; GPU-free.

import './headless-canvas.mjs';
import * as THREE from 'three';
import Book from '../packages/glyph3d-core/src/collections/Book.js';

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

const { default: WorkspaceModel } = await import('../app/client/WorkspaceModel.js');
const { default: Holding } = await import('../app/client/Holding.js');
const { default: GomuxHub, GOMUX_HUB } = await import('../app/client/GomuxHub.js');
const { default: SessionStore } = await import('../app/client/SessionStore.js');
const { default: registerCarrelCommands, buildCarrel, carrelSweep } = await import('../app/commands/handlers/carrelCommands.js');
const { default: registerBookCommands } = await import('../app/commands/handlers/bookCommands.js');
const { setSetting, resetSetting, getSetting } = await import('../app/client/settings.js');
const { tuneOf, tuneBook, projectTune, deskOf, readDesk } = await import('../app/client/tuning.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };

/** A seatable stand-in: a box W×H, top-anchored like a CodeGrid. */
const makeGrid = (w = 10, h = 6) => {
    const g = new THREE.Object3D();
    g.getLocalBounds = (t = new THREE.Box3()) => t.set(new THREE.Vector3(-w / 2, -h, -0.1), new THREE.Vector3(w / 2, 0, 0.1));
    g.getBounds = (t = new THREE.Box3()) => { g.updateWorldMatrix(true, false); return g.getLocalBounds(t).applyMatrix4(g.matrixWorld); };
    return g;
};

/** A verb table — the handlers run synchronously, as the router's do. */
function makeRouter() {
    const verbs = new Map();
    const router = { register: (name, fn) => verbs.set(name, fn) };
    registerCarrelCommands(router);
    registerBookCommands(router);
    return (ctx, name, ...args) => verbs.get(name)(args.map(String), ctx);
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
        addChangeListener: (fn) => listeners.add(fn),
        removeChangeListener: (fn) => listeners.delete(fn),
    };
    const lanes = new Map();
    const agentBooks = {
        lanes, cfg: { tailReadBytes: 1 << 20 },
        resolveLane(ref) {
            if (ref && typeof ref === 'object') { for (const e of lanes.entries()) if (e[1].book === ref) return e; return null; }
            const id = String(ref ?? '');
            if (lanes.has(id)) return [id, lanes.get(id)];
            for (const e of lanes.entries()) if (e[1].groupId === id) return e;
            return null;
        },
        agents: () => [...lanes.keys()].map((id) => ({ id })),
        limitOf: (id) => ({ agentId: id, override: null, cap: 0, count: 0 }),
    };
    const world = { relayouts: 0, register() {}, unregister() {}, relayout() { this.relayouts++; } };
    const ctx = {
        scene, registry, agentBooks, deltaBooks: null, world,
        carrels: new Map(), workspace: new WorkspaceModel(),
        cameraDock: null, camera: null,
        getSurfaces: () => [...entries.values()].map((e) => e.grid),
        getGrids: () => [],
    };
    ctx.holding = new Holding(ctx);
    /** An agent book: a real Book (so pageableBookOf and the deck knobs are real) with a card. */
    const agentBook = (id) => {
        const book = new Book(makeGrid(8, 5));
        book.getSeatBounds = book.getLocalBounds.bind(book);
        scene.add(book);
        const lane = { agentId: id, groupId: `agent:book:${id}`, book, pinned: false };
        lanes.set(id, lane);
        registry.register(lane.groupId, book, { type: 'book', role: 'agent' });
        return lane;
    };
    return { ctx, scene, registry, lanes, agentBook };
}

const run = makeRouter();

// ── a Settings default reaches only desks born after it ─────────────────────────────
{
    const w = makeWorld();
    const old = buildCarrel(w.ctx, 'old');
    ok(old.gapFrac === getSetting('carrel.gapFrac'), 'a desk is born with the Settings default');
    setSetting(w.ctx, 'carrel.gapFrac', 1.7);
    setSetting(w.ctx, 'carrel.radius', 555);
    ok(old.gapFrac === 0.9 && old.radius === 240, 'a Settings change never pushes onto a standing desk');
    const fresh = buildCarrel(w.ctx, 'fresh');
    ok(fresh.gapFrac === 1.7 && fresh.radius === 555, 'a desk born after the change takes it');
    ok(fresh.born.gapFrac === 1.7, 'and was born with it (born)');
    resetSetting(w.ctx, 'carrel.gapFrac');
    resetSetting(w.ctx, 'carrel.radius');
    ok(fresh.gapFrac === 1.7, 'resetting the Settings default leaves the desk alone too');
}

// ── carrel.set on one desk: its own value; carrel.get reads it; default hands it back ──
{
    const w = makeWorld();
    const a = buildCarrel(w.ctx, 'a');
    const b = buildCarrel(w.ctx, 'b');
    let r = run(w.ctx, 'carrel.set', 'a', 'radius', 700);
    ok(r.text.startsWith('OK') && a.radius === 700 && b.radius === 240, 'carrel.set tunes ONE desk');
    ok(tuneOf(w.ctx, 'carrel:a').radius === 700, 'its value is recorded as its own (the model\'s Tuning component)');
    ok(w.ctx.workspace.hasComponent('carrel:a', 'Tuning'), 'the Tuning component is present on the desk\'s surface');
    r = run(w.ctx, 'carrel.set', 'a', 'mode', 'grid');
    ok(a.mode === 'grid' && tuneOf(w.ctx, 'carrel:a').mode === 'grid', 'enum knobs are own values too (mode)');
    r = run(w.ctx, 'carrel.set', 'a', 'seat', 'natural');
    ok(a.seat === 'natural', 'seat is a desk knob');
    r = run(w.ctx, 'carrel.set', 'a', 'mode', 'sideways');
    ok(r.text.startsWith('ERR') && a.mode === 'grid', 'a bad enum value is refused, the desk untouched');
    r = run(w.ctx, 'carrel.set', 'a', 'nonsense', 3);
    ok(r.text.startsWith('ERR'), 'an unknown knob is refused');
    const g = run(w.ctx, 'carrel.get', 'a');
    ok(g.data.own.radius === 700 && g.data.born.radius === 240 && g.data.values.radius === 700, 'carrel.get: value, born, own');
    ok(/\*radius = 700 \(born 240\)/.test(g.text), 'carrel.get marks its own values');
    r = run(w.ctx, 'carrel.set', 'a', 'radius', 'default');
    ok(a.radius === 240 && !('radius' in tuneOf(w.ctx, 'carrel:a')) && r.data.own === false, "'default' returns the knob to what the desk was born as");
    run(w.ctx, 'carrel.set', 'a', 'mode', 'default');
    run(w.ctx, 'carrel.set', 'a', 'seat', 'default');
    ok(a.mode === 'ring' && a.seat === 'uniform', 'enum knobs return to born too');
    ok(!w.ctx.workspace.getSurface('carrel:a')?.view?.tune, 'a desk with no own values left has no record');
    ok(a.serialize().params.radius === 240, 'serialize saves what the desk was born as');
}

// ── the gomuxai hub: born in its form; an own value survives the next tree push ─────
/** Drive the hub's desk layout over a fixed tree: `lead` with helpers `h1`, `h2`, plus `solo`. */
function hubWorld() {
    const w = makeWorld();
    const hub = new GomuxHub(w.ctx, { onChange: () => () => {}, onPaneSize: () => () => {} }, { onStream: () => () => {}, streams: new Map() });
    const agents = [
        { name: 'lead', parent: '' }, { name: 'h1', parent: 'lead' }, { name: 'h2', parent: 'lead' }, { name: 'solo', parent: '' },
    ];
    hub.nodes = new Map(agents.map((a) => [a.name, a]));
    for (const a of agents) {
        w.agentBook(a.name);
        hub.lanes.set(a.name, { name: a.name, session: a.name, failed: null });
    }
    hub._layout();
    return { ...w, hub };
}
{
    const w = hubWorld();
    const hubDesk = w.ctx.carrels.get(GOMUX_HUB);
    const team = w.ctx.carrels.get('gomux/lead');
    ok(hubDesk && team, 'the hub builds its desk and the team desk');
    ok(hubDesk.mode === 'ring' && hubDesk.seat === 'natural' && hubDesk.radius === getSetting('carrel.cylinderRadius')
        && hubDesk.ringMaxRows === getSetting('carrel.cylinderMaxRows'), 'the hub desk is born a cylinder (Settings ▸ Carrel cylinder defaults)');
    ok(team.mode === 'grid' && team.derived && hubDesk.derived, 'a team desk is born a wall; hub desks are derived');
    ok(Math.abs(hubDesk.gapFrac * hubDesk.boxH - getSetting('gomux.gap')) < 1e-6, 'hub desks are born gomux.gap apart');
    ok(deskOf(w.ctx, w.lanes.get('h1').book.sheets[0].recto) === team, "deskOf: a seated book's card sits at its team desk");
    ok(deskOf(w.ctx, w.lanes.get('solo').book) === hubDesk, 'deskOf: a book seated at the hub');

    run(w.ctx, 'carrel.set', GOMUX_HUB, 'radius', 1500);
    run(w.ctx, 'carrel.set', GOMUX_HUB, 'ringMaxRows', 5);
    run(w.ctx, 'carrel.set', 'gomux/lead', 'gapFrac', 0.3);
    run(w.ctx, 'carrel.set', 'gomux/lead', 'mode', 'ring');
    w.hub._layout();   // the next tree push
    w.hub._layout();
    ok(hubDesk.radius === 1500 && hubDesk.ringMaxRows === 5, "the hub's own values survive its next tree push");
    ok(team.gapFrac === 0.3 && team.mode === 'ring', "a team desk's own values survive the push too");
    setSetting(w.ctx, 'carrel.cylinderRadius', 2222);
    w.hub._layout();
    ok(hubDesk.radius === 1500, 'a changed cylinder default doesn\'t reach the standing hub');
    resetSetting(w.ctx, 'carrel.cylinderRadius');

    // ── reload round-trip through capture / restore ──
    const saved = new SessionStore({ ctx: w.ctx, router: null, bridge: null }).capture();
    ok(Array.isArray(saved.tunings) && saved.tunings.some((t) => t.id === 'carrel:gomux' && t.tune.radius === 1500),
        'capture saves the hub desk\'s own values (it is derived — never in `carrels`)');
    ok(!saved.carrels.some((c) => c.name === GOMUX_HUB), 'the hub desk itself is not saved');

    // A fresh page: the hub builds BEFORE the restore runs (it can win the race to the relay).
    const w2 = hubWorld();
    const hub2 = w2.ctx.carrels.get(GOMUX_HUB);
    ok(hub2.radius === getSetting('carrel.cylinderRadius'), 'before the restore, a rebuilt hub desk is just born');
    const s2 = new SessionStore({ ctx: w2.ctx, router: null, bridge: null });
    s2._restoreTunings(saved);
    ok(hub2.radius === 1500 && hub2.ringMaxRows === 5, 'restore projects the values onto a hub desk built before it');
    ok(w2.ctx.carrels.get('gomux/lead').gapFrac === 0.3, '…and onto its team desk');

    // A fresh page where the restore runs FIRST: the hub's desks are born wearing them.
    const w3 = makeWorld();
    new SessionStore({ ctx: w3.ctx, router: null, bridge: null })._restoreTunings(saved);
    const hub3 = new GomuxHub(w3.ctx, { onChange: () => () => {}, onPaneSize: () => () => {} }, { onStream: () => () => {}, streams: new Map() });
    hub3.nodes = new Map([['solo', { name: 'solo', parent: '' }]]);
    w3.agentBook('solo');
    hub3.lanes.set('solo', { name: 'solo', session: 'solo', failed: null });
    hub3._layout();
    const born3 = w3.ctx.carrels.get(GOMUX_HUB);
    ok(born3.radius === 1500 && born3.born.radius === getSetting('carrel.cylinderRadius'), 'a hub desk built after the restore is born wearing its own values');
}

// ── the agents desk: born a cylinder; the sweep never re-stamps it ───────────────────
{
    const w = makeWorld();
    w.agentBook('x1');
    carrelSweep(w.ctx);
    const shelf = w.ctx.carrels.get('agents');
    ok(shelf && shelf.mode === 'ring' && shelf.seat === 'natural' && shelf.radius === getSetting('carrel.cylinderRadius'), 'the agents desk is born a cylinder');
    run(w.ctx, 'carrel.set', 'agents', 'radius', 1234);
    run(w.ctx, 'carrel.set', 'agents', 'mode', 'grid');
    w.agentBook('x2');
    carrelSweep(w.ctx);
    ok(shelf.radius === 1234 && shelf.mode === 'grid', "the agents desk's own values survive the next sweep");
    ok(shelf.has('agent:book:x2'), 'and the sweep still seats newcomers there');

    // Saved desk round-trip: born values in `carrels`, own values in `tunings`.
    const saved = new SessionStore({ ctx: w.ctx, router: null, bridge: null }).capture();
    const rec = saved.carrels.find((c) => c.name === 'agents');
    ok(rec && rec.params.radius === getSetting('carrel.cylinderRadius') && rec.params.mode === 'ring', 'the saved desk record is what it was born as');
    const w2 = makeWorld();
    const s2 = new SessionStore({ ctx: w2.ctx, router: null, bridge: null });
    s2._restoreTunings(saved);
    s2._restoreCarrels(saved);
    const back = w2.ctx.carrels.get('agents');
    ok(back.radius === 1234 && back.mode === 'grid', 'restored, the desk wears its own values');
    run(w2.ctx, 'carrel.set', 'agents', 'radius', 'default');
    ok(back.radius === getSetting('carrel.cylinderRadius'), "…and 'default' still knows what it was born as");

    // Dissolve forgets.
    run(w2.ctx, 'carrel.dissolve', 'agents');
    ok(!tuneOf(w2.ctx, 'carrel:agents').mode, 'carrel.dissolve forgets the desk\'s own values');
}

// ── books: an own deck value survives the shelf's re-apply ────────────────────────────
{
    const w = makeWorld();
    const lane = w.agentBook('bk');
    const book = lane.book;
    const shelfDefaults = (zPitch) => ({ zPitch, lerp: 9, turned: 0.25, slide: 1 });
    book.setDeckDefaults(shelfDefaults(90));
    const hit = { kind: 'agent', books: w.ctx.agentBooks, agentId: 'bk', book };
    let r = tuneBook(w.ctx, hit, 'zPitch', 300);
    ok(r.ok && book.deck.zPitch === 300 && tuneOf(w.ctx, 'agent:book:bk').zPitch === 300, 'a book takes its own deck value');
    book.setDeckDefaults(shelfDefaults(120));   // the shelf's Settings re-apply (applyScales)
    ok(book.deck.zPitch === 300, "the shelf's re-apply passes the book's own value by");
    ok(book.deck.lerp === 9, '…and still stamps the knobs it has no value for');
    r = run(w.ctx, 'book.set', 'bk', 'zPitch', 'default');
    ok(r.text.startsWith('OK') && book.deck.zPitch === 120 && !('zPitch' in tuneOf(w.ctx, 'agent:book:bk')), "'default' returns it to the shelf's current default");
    r = run(w.ctx, 'book.set', 'bk', 'slide', 4);
    ok(book.deck.slide === 4, 'book.set gives an addressed book its own value');
    r = run(w.ctx, 'book.set', 'bk', 'form', 'splay');
    ok(r.text.startsWith('ERR') && book.form === 'deck', 'the form is book.form, not book.set');
    r = run(w.ctx, 'book.form', 'bk', 'splay');
    ok(book.form === 'splay' && tuneOf(w.ctx, 'agent:book:bk').form === 'splay', 'book.form records a shelf book\'s form as its own');
    const g = run(w.ctx, 'book.get', 'bk');
    ok(g.data.form === 'splay' && g.data.own.slide === 4 && /\*slide = 4/.test(g.text), 'book.get reads form, values, and which are its own');
    run(w.ctx, 'book.form', 'bk', 'default');
    ok(book.form === 'deck' && !('form' in tuneOf(w.ctx, 'agent:book:bk')), "book.form default drops the book's own form");

    // A book that registers after its values were restored is projected on registration.
    const w2 = makeWorld();
    w2.ctx.workspace.setSurfaceView('agent:book:late', undefined, { tune: { zPitch: 444, form: 'splay' } });
    const late = w2.agentBook('late');
    ok(late.book.form === 'deck', 'a book is born in its shelf\'s form');
    new SessionStore({ ctx: w2.ctx, router: null, bridge: null })._projectSurfaces();   // the registry-change projector
    ok(late.book.deck.zPitch === 444 && late.book.form === 'splay' && 'zPitch' in late.book.deckOwn, '…as its own (the shelf\'s next re-apply passes them by)');
    ok(!projectTune(w2.ctx, 'agent:book:late', tuneOf(w2.ctx, 'agent:book:late')), 'projection is idempotent');
}

// ── the HUD's read: a desk's values + own, for the focused desk ─────────────────────
{
    const w = makeWorld();
    const d = buildCarrel(w.ctx, 'hud');
    run(w.ctx, 'carrel.set', 'hud', 'maxArcDeg', 200);
    const read = readDesk(w.ctx, d);
    ok(read.values.maxArcDeg === 200 && read.own.maxArcDeg === 200 && read.born.maxArcDeg === 300, 'readDesk: live, own, born');
}

console.log(`desk-tuning.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

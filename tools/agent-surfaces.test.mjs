// agent-surfaces.test.mjs — AGENT-OWNED SURFACES (client/AgentSurfaces.js): a terminal or desktop an
// identified caller (`glyph3d-cli --as <name>` — the per-call ctx.caller) creates is that agent's, seated
// at its plane desk gomux/<name>, kept there across a reload, marked (never stopped) when it ends.
//
//   bun tools/agent-surfaces.test.mjs
//
// Locks (through the real CommandRouter, SceneRegistry, WorkspaceModel, Holding, Participants, Carrel):
//   1. claim: an identified caller's desktop (a 1:1 FrameGrid) and terminal are pinned on gomux/<name> (a
//      plane desk, set down for a caller the hub doesn't know), their facts (view.owner, the residence)
//      saved, the registry meta names the agent (meta.owner — a terminal's controller — untouched), the
//      agent attached to its desk with the seats attributed; anonymous: nothing claimed, nothing seated;
//   2. terminal.spawn as an identified caller: claimed + seated, NEVER docked / spotlit / focused (the
//      person's); an anonymous spawn docks and focuses exactly as before; terminal.create from an
//      identified caller claims, the adapter's own (anonymous) create doesn't;
//   3. a reload (a fresh world from the saved model): the desk stands back up and Holding seats each
//      surface at its residence as it re-adopts — no second desk, no claim needed;
//   4. its owner ending marks the surfaces (fact + meta), stops and removes nothing; running again clears it;
//   5. the hub's agent: GomuxHub's ownsDesk counts owned surfaces (from the model — before they re-adopt);
//   6. agent.surfaces lists them.

import './headless-canvas.mjs';
import * as THREE from 'three';
import { HEADLESS_ATLAS } from './headless-atlas.mjs';
globalThis.window ??= { addEventListener() {} };
const { default: CommandRouter } = await import('../packages/glyph3d-core/src/services/orchestration/CommandRouter.js');
const { default: SceneRegistry } = await import('../packages/glyph3d-core/src/services/SceneRegistry.js');
const { default: FrameGrid } = await import('../packages/glyph3d-core/src/collections/FrameGrid.js');
const { default: WorkspaceModel } = await import('../app/client/WorkspaceModel.js');
const { default: Holding } = await import('../app/client/Holding.js');
const { default: Participants } = await import('../app/client/Participants.js');
const { agentSurfacesOf, ownerDesk } = await import('../app/client/AgentSurfaces.js');
const { default: registerTerminalCommands } = await import('../app/commands/handlers/terminalCommands.js');
const { default: registerSurfaceCommands } = await import('../app/commands/handlers/surfaceCommands.js');
const { buildCarrel } = await import('../app/commands/handlers/carrelCommands.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } };
const quiet = async (fn) => { const i = console.info; console.info = () => {}; try { return await fn(); } finally { console.info = i; } };

function makeWorld(workspace = new WorkspaceModel()) {
    const scene = new THREE.Scene();
    const registry = new SceneRegistry();
    const ctx = {
        scene, atlas: HEADLESS_ATLAS, registry, workspace, carrels: new Map(), cameraDock: null, camera: null, world: null,
        cameraController: null, agentBooks: { lanes: new Map(), resolveLane: () => null, agents: () => [] }, deltaBooks: null,
        getSurfaces: () => registry.list().map((e) => e.grid), getGrids: () => [], terminals: new Map(),
        sender: null, caller: null, cid: 0,
    };
    ctx.holding = new Holding(ctx);
    ctx.participants = new Participants(ctx);
    const router = new CommandRouter(ctx);
    const ran = [];
    const exec = router.execute.bind(router);
    router.execute = (input, o) => { ran.push(Array.isArray(input) ? input.join(' ') : String(input)); return exec(input, o); };
    for (const v of ['dock.lock', 'dock.spotlight', 'terminal.focus']) router.register(v, () => ({ text: `OK: ${v}` }));
    registerTerminalCommands(router);
    registerSurfaceCommands(router);
    // terminal.focus is the real module's; a stub after it records the call without needing a dock.
    router.register('terminal.focus', () => ({ text: 'OK: terminal.focus' }));
    const as = (name) => (line) => quiet(() => router.execute(line, { caller: name, sender: `ctrl-${name}` }));
    const anon = (line) => quiet(() => router.execute(line, { sender: 'ctrl-adapter' }));
    return { ctx, router, ran, as, anon };
}
/** A desktop's grid as desktop.start lands it: a 1:1 frame of known pixels. */
function desktop(w, id, px = [640, 360]) {
    const fg = new FrameGrid(w.ctx.scene, null, { name: id, cols: 1, rows: 1, width: 24, aspect: px[0] / px[1] });
    fg.setFrameTexture(new THREE.Texture({ width: px[0], height: px[1] }));
    w.ctx.registry.register(id, fg, { type: 'frame' });
    return fg;
}
const holderOf = (w, id) => w.ctx.holding.holderOf(id)?.carrelName ?? null;
const ME = 'scroll-agent';

// ── 1. claim ─────────────────────────────────────────────────────────────────────────────────
{
    const w = makeWorld();
    const S = agentSurfacesOf(w.ctx);
    desktop(w, 'desk-1');
    ok(await quiet(() => S.claim(null, 'desk-1', 'frame')) === null && holderOf(w, 'desk-1') === null && !w.ctx.workspace.getSurface('desk-1')?.view?.owner,
        'an anonymous caller claims nothing: the desktop stays loose, no owner fact');
    await quiet(() => S.claim(ME, 'desk-1', 'frame'));
    const desk = w.ctx.carrels.get(ownerDesk(ME));
    ok(desk && desk.mode === 'plane' && holderOf(w, 'desk-1') === ownerDesk(ME), `the desktop sits at gomux/${ME}, a plane desk (${holderOf(w, 'desk-1')})`);
    const f = w.ctx.workspace.getSurface('desk-1')?.view;
    ok(f?.owner === ME && f?.carrel?.name === ownerDesk(ME), 'its facts: the owner, and its residence at that desk');
    ok(w.ctx.registry.get('desk-1').meta.agent === ME && w.ctx.registry.findByMeta('agent', ME).length === 1, 'the registry meta names the agent (indexed)');
    ok(w.ctx.participants.isAt(ME, ownerDesk(ME)) && w.ctx.participants.who(ownerDesk(ME))[0]?.seated.includes('desk-1'), 'the agent is at its desk, the seat attributed to it');
    const pin = desk.pinRects?.().find((p) => p.id === 'desk-1');
    ok(pin && pin.rect.w === 640 && pin.rect.h === 360, `pinned 1:1 — one texel per device pixel (${pin ? `${pin.rect.w}×${pin.rect.h}` : 'no pin'})`);
}

// ── 2. terminal.spawn / terminal.create ──────────────────────────────────────────────────────
function bridgeFor(w, id) {
    let waiter = null;
    return {
        connected: true,
        waitForEvent: () => new Promise((r) => { waiter = r; }),
        send() {
            setTimeout(() => {
                waiter?.({ id });
                setTimeout(() => quiet(() => w.anon(`terminal.create ${id} 80 24`)), 5);   // the adapter's own create: anonymous
            }, 5);
        },
        push() {},
    };
}
{
    const w = makeWorld();
    w.ctx.wsbridge = bridgeFor(w, 'glyph-7');
    const r = await w.as(ME)('terminal.spawn');
    ok(holderOf(w, 'glyph-7') === ownerDesk(ME) && w.ctx.workspace.getSurface('glyph-7')?.view?.owner === ME,
        `an identified spawn: the terminal is the caller's, at its desk (${r.text})`);
    ok(!w.ran.some((l) => /^(dock\.lock|dock\.spotlight|terminal\.focus)/.test(l)), `never docked, spotlit or focused (ran: ${w.ran.join(' | ')})`);
    ok(w.ctx.registry.get('glyph-7').meta.owner === 'ctrl-adapter' && w.ctx.registry.get('glyph-7').meta.agent === ME, "meta.owner stays the adapter (input routing); meta.agent is the agent");
    const pin = w.ctx.carrels.get(ownerDesk(ME)).pinRects().find((p) => p.id === 'glyph-7');
    ok(pin && pin.rect.w > 0, 'pinned on the plane desk');

    const a = makeWorld();
    a.ctx.wsbridge = bridgeFor(a, 'glyph-8');
    await a.anon('terminal.spawn');
    ok(['dock.lock glyph-8', 'dock.spotlight glyph-8', 'terminal.focus glyph-8'].every((l) => a.ran.includes(l)) && holderOf(a, 'glyph-8') === null && !a.ctx.workspace.getSurface('glyph-8')?.view?.owner,
        'an anonymous spawn docks + spotlights + focuses as before, owned by no one');

    const c = makeWorld();
    await c.as(ME)('terminal.create made-by-me 40 10');
    await c.anon('terminal.create re-adopted 40 10');
    ok(holderOf(c, 'made-by-me') === ownerDesk(ME) && holderOf(c, 're-adopted') === null, "terminal.create: an identified caller's is claimed, an adapter's (anonymous) isn't");
}

// ── 3. a reload ──────────────────────────────────────────────────────────────────────────────
{
    const w = makeWorld();
    desktop(w, 'desk-1');
    await quiet(() => agentSurfacesOf(w.ctx).claim(ME, 'desk-1', 'frame'));
    await w.as(ME)('terminal.create made-by-me 40 10');
    // What a session SAVES → a fresh page: the residences (Holding's carrel membership — SessionStore's
    // carrelMembers) and the owners (AgentSurfaces.serialize); nothing else of the surfaces' views.
    const members = w.ctx.workspace.listSurfaces().filter((s) => s.view?.carrel).map((s) => ({ id: s.id, kind: s.kind, carrel: { ...s.view.carrel } }));
    const owners = agentSurfacesOf(w.ctx).serialize();
    ok(owners.length === 2 && owners.every((o) => o.owner === ME), 'serialize: both surfaces\' owners');
    const ws2 = new WorkspaceModel();
    for (const m of members) ws2.setSurfaceView(m.id, m.kind, { carrel: m.carrel });
    const r = makeWorld(ws2);
    agentSurfacesOf(r.ctx).restore(owners);   // the restore's first stage
    ok(agentSurfacesOf(r.ctx).ownsAny(ME), 'restored: the agent owns its surfaces again before they re-adopt (its desk can stand)');
    await quiet(() => buildCarrel(r.ctx, ownerDesk(ME), { managed: true, form: { mode: 'plane' } }));
    desktop(r, 'desk-1');                                    // the desktop re-adopts
    await r.anon('terminal.create made-by-me 40 10');        // the terminal's adapter re-creates it (anonymous)
    r.ctx.holding.reconcile();
    ok(holderOf(r, 'desk-1') === ownerDesk(ME) && holderOf(r, 'made-by-me') === ownerDesk(ME), 'after a reload both surfaces are back at the agent\'s desk');
    ok([...r.ctx.carrels.keys()].filter((n) => n === ownerDesk(ME)).length === 1 && r.ctx.carrels.size === 1, 'one desk — no second one set down');
    ok(r.ctx.registry.get('desk-1').meta.agent === ME && r.ctx.registry.get('made-by-me').meta.agent === ME
        && (await r.anon(`agent.surfaces ${ME}`)).data.surfaces.length === 2, 'and they are still the agent\'s (meta, agent.surfaces)');
}

// ── 4. its owner ends ────────────────────────────────────────────────────────────────────────
{
    const w = makeWorld();
    desktop(w, 'desk-1');
    const S = agentSurfacesOf(w.ctx);
    await quiet(() => S.claim(ME, 'desk-1', 'frame'));
    await quiet(() => S.noteRuns((o) => (o === ME ? false : null)));
    ok(w.ctx.workspace.getSurface('desk-1').view.ownerEnded === true && w.ctx.registry.get('desk-1')?.meta.ownerEnded === true && holderOf(w, 'desk-1') === ownerDesk(ME),
        'its owner ended: marked (fact + meta), still registered, still at its desk');
    await quiet(() => S.noteRuns(() => true));
    ok(w.ctx.workspace.getSurface('desk-1').view.ownerEnded === false, 'running again clears the mark');
    const r = await w.anon(`agent.surfaces ${ME}`);
    ok(r.data.surfaces.length === 1 && r.data.surfaces[0].id === 'desk-1' && r.data.surfaces[0].desk === ownerDesk(ME) && r.text.includes('desk-1'), `agent.surfaces lists it (${r.text.split('\n')[0]})`);
}

// ── 5. a hub agent's desk counts its surfaces (before they re-adopt) ─────────────────────────
{
    const { default: GomuxHub } = await import('../app/client/GomuxHub.js');
    const w = makeWorld();
    w.ctx.workspace.setSurfaceView('desk-9', 'frame', { owner: 'hub-agent' });   // a saved claim; the desktop not live yet
    const provider = { onChange: () => () => {}, onPaneSize: () => () => {}, list: async () => ({ agents: [] }) };
    const sessionBooks = { onStream: () => () => {}, streams: new Map() };
    const hub = new GomuxHub(w.ctx, provider, sessionBooks);
    ok(hub.tree._ownsDesk('hub-agent') === true && hub.tree._ownsDesk('nobody') === false, 'GomuxHub.ownsDesk: an agent with surfaces (even not live yet) gets its own desk');
    hub.dispose?.();
}

console.log(`agent-surfaces: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

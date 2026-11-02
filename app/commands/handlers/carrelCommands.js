/**
 * carrel.* commands — world-anchored reading desks (Carrel).
 *
 * The CameraDock's mirror: dock.* drives the bar that rides the camera;
 * carrel.* drives the desks that stay put in the world. A seated window is the
 * SAME live grid / terminal / book, dimensionally scaled into a ring slot
 * around the tabletop — stand at the center and the members read like a dock
 * around you. Any surface the dock takes, a carrel takes.
 *
 * Membership is recorded as a VIEW FACT on the workspace surface record
 * (view.carrel = {name, order}), the same shape as view.docked — the live
 * Carrel is a projection of it. Both facts, and every handoff between the dock
 * and a desk, go through the shared Holding (ctx.holding): a carrel is a
 * RESIDENCE, the dock a VEHICLE, and docking a seated window borrows it.
 *
 * The 'agents' desk is the agents desk's (client/SessionDesk.js: local sessions' books, their
 * subagents on team desks — a derived cylinder like the gomuxai hub). Any other new book no
 * owner seats is born onto it too (scheduleCarrelSweep's auto-shelf pass, driven by
 * AgentBooks.onChange). Settings ▸ Agent Books `book.autoShelf` turns that pass off.
 *
 * KNOBS (client/tuning.js): Settings ▸ Carrel are the values a NEW desk is born with,
 * then its owner's form (the hub's and the agents desk's cylinder — cylinderForm), then
 * the desk's OWN values (carrel.set), which win from then on: nothing re-stamps them, and
 * they persist by desk name — the gomuxai hub's derived desks included.
 *
 * Desks PERSIST: SessionStore captures each carrel's serialize() (pose, what it was
 * born as) and restores desks FIRST — restoreCarrel stands them back up at
 * their saved pose wearing their own values, pre-shaped for their member complement,
 * and the sweep's manifest pass seats each member IN PLACE as its window materializes.
 * The desk loads, then loads its elements — content never flies across the room.
 */

import * as THREE from 'three';
import Carrel, { clearSpot } from '@glyph3d/core/services/interaction/Carrel.js';
import { getSetting } from '../../client/settings.js';
import { enterPlaneView, planeUnitOf } from './planeCommands.js';
import { wirePanes } from '../../client/carrelPanes.js';
import { recordEntered, armEnteredLife } from '../../client/planeEntered.js';
import { focusPaneFront } from './paneCommands.js';
import { DESK_KNOBS, tuneOf, applyDeskTune, tuneDesk, readDesk, forgetTune } from '../../client/tuning.js';
/** @import { AppContext } from '../../client/CommandProvider.jsx' */

/** The knobs Settings ▸ Carrel stores — the values a NEW desk is born with. */
const CARREL_KNOBS = ['radius', 'boxH', 'boxAspect', 'gapFrac', 'growCap', 'maxArcDeg',
                      'tableFrac', 'shadowSoft', 'glowStrength'];

/**
 * The CYLINDER form an owner gives a desk at birth — the gomuxai hub, the agents desk: a
 * ring of members at their own size, stacking Settings ▸ Carrel `carrel.cylinderMaxRows`
 * rows before it widens past its least radius, `carrel.cylinderRadius`.
 * @returns {{mode:'ring', seat:'natural', radius:number, ringMaxRows:number}}
 */
export function cylinderForm() {
    return {
        mode: 'ring', seat: 'natural',
        radius: Number(getSetting('carrel.cylinderRadius')),
        ringMaxRows: Number(getSetting('carrel.cylinderMaxRows')),
    };
}

/** @param {AppContext} ctx */
function carrels(ctx) {
    return ctx.carrels instanceof Map ? ctx.carrels : null;
}

/**
 * Resolve a carrel by name, else the active one, else the most recently created. A desk
 * that's dissolving (folding while its members drain home) is already gone to the verbs.
 * @param {AppContext} ctx
 */
function findCarrel(ctx, name) {
    const map = carrels(ctx);
    if (!map) return null;
    const live = (c) => (c && !c._dissolving ? c : null);
    if (name) return live(map.get(String(name)));
    if (ctx.activeCarrel) { const c = live(map.get(ctx.activeCarrel)); if (c) return c; }
    let last = null;
    for (const c of map.values()) if (!c._dissolving) last = c;
    return last;
}

/** A world-managed desk's footprint changed by a VERB (seat/release/knob) — tell the
 *  world row. Footprint-diffed on the other side, so a no-move touch costs a measure.
 * @param {AppContext} ctx
 */
function worldTouch(ctx, carrel) {
    if (carrel?.worldManaged) ctx.world?.relayout();
}

/**
 * Construct a desk, dress it, set it down, make it a world citizen — the shared
 * birth path for carrel.create, the auto-created agent shelf and the gomuxai hub's desks.
 *
 * What it's born as, later layers winning: Settings ▸ Carrel (the defaults — read now,
 * never pushed onto a live desk), an explicit radius, the owner's `form` (the hub and the
 * agents desk are cylinders: cylinderForm). Then the desk's OWN values (its tuning record,
 * kept by name — a derived hub desk rebuilt from the tree wears what was set on it last
 * time). A FREE desk lands ON the camera's
 * view ray — where you're looking, not a floor projection of it (which parked
 * the desk at y=0 far below an elevated gaze, reading tiny-in-the-distance);
 * the tabletop sits half a slot below the ray point so row 0 rises into your
 * gaze, and the doorway (local +z) turns back toward the viewer. A MANAGED desk
 * (`managed`, the agents shelf) instead registers as a WorldLayout grouping —
 * a sibling of the file tree on the shared floor; the layout places it, and
 * carrel.move takes it back out (user-placed wins, the pin law). Registered
 * (type 'carrel') either way, so the camera's dynamic-speed / soft-bounds /
 * fit-all spine (getSurfaces) sees it — a desk is a PLACE, not cargo;
 * Holding.resolve refuses to treat it as one. A NESTED desk (`nested`) is
 * neither: its owner seats it at another desk with Carrel.lock (desks hold
 * desks only by their owner's hand — the gomuxai hub's teams), which parents
 * and places it.
 * @param {AppContext} ctx
 * @returns {Carrel}
 */
export function buildCarrel(ctx, name, { radius, managed = false, nested = false, form = null } = {}) {
    const born = {};
    for (const k of CARREL_KNOBS) {
        const v = getSetting(`carrel.${k}`);
        if (Number.isFinite(v)) born[k] = v;
    }
    if (Number.isFinite(radius)) born.radius = radius;
    const carrel = new Carrel({ name, ...born, ...(form || {}) });
    if (ctx.atlas) carrel.setPlaneUnit(planeUnitOf(ctx));
    applyDeskTune(carrel, tuneOf(ctx, carrel.name));
    wirePanes(ctx, carrel);

    if (nested) {
        // Seated at another desk by its owner (a gomuxai team inside the hub) — the
        // outer desk's lock() parents and places it, so it isn't set down anywhere.
    } else if (managed && ctx.world) {
        carrel.worldManaged = true;
        ctx.world.register(carrel.name, carrel, () => carrel.getLocalBounds());
    } else {
        carrel.userData.setDown = setDown(ctx, carrel);
        ctx.scene.add(carrel);
    }
    ctx.registry?.register?.(`carrel:${name}`, carrel, { type: 'carrel' });
    carrels(ctx)?.set(name, carrel);
    return carrel;
}

/**
 * Set a new desk down where you are looking — ahead of the camera, facing it; inside a plane, beside
 * the desk you are reading, facing as it does — and never over another desk: when that spot meets a
 * standing desk's airspace (Carrel.airspace, grown by `carrel.createGap`), the desk slides along its
 * own right to the nearest clear spot (Carrel's clearSpot).
 * @param {AppContext} ctx @param {Carrel} carrel
 * @returns {{at:{x:number,y:number,z:number}, slid:number, blockedBy:string[]}} where it stands, how
 *   far it slid from the wanted spot (world units, + = its right), and which desks were there
 */
function setDown(ctx, carrel) {
    const cam = ctx.camera;
    const entered = ctx.enteredCarrel ? carrels(ctx)?.get(ctx.enteredCarrel) : null;
    if (entered) {
        entered.updateWorldMatrix(true, false);
        entered.getWorldPosition(carrel.position);
        carrel.rotation.y = entered.rotation.y;
    } else if (cam) {
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
        const p = new THREE.Vector3().copy(cam.position).addScaledVector(fwd, carrel.radius * 1.6);
        carrel.position.set(p.x, Math.max(p.y - carrel.boxH * 0.5, 0), p.z);
        carrel.rotation.y = Math.atan2(cam.position.x - p.x, cam.position.z - p.z);
    }
    // Every standing desk at the top level (a desk seated in another stands inside its airspace).
    const others = [...(carrels(ctx)?.values() ?? [])].filter((d) => d !== carrel && !d._dissolving && (d.parent === ctx.scene || d.worldManaged));
    carrel.updateMatrixWorld(true);
    const right = new THREE.Vector3(Math.cos(carrel.rotation.y), 0, -Math.sin(carrel.rotation.y));
    const { offset, blockedBy } = clearSpot(carrel.airspace(), right, others.map((d) => d.airspace()), { gap: Number(getSetting('carrel.createGap')) });
    carrel.position.addScaledVector(right, offset);
    carrel.updateMatrixWorld(true);
    return {
        at: { x: carrel.position.x, y: carrel.position.y, z: carrel.position.z },
        slid: offset,
        blockedBy: blockedBy.map((i) => others[i].carrelName),
    };
}

/** The desk agent books call home by default. */
const AGENT_SHELF = 'agents';

/**
 * Rebuild a desk from its serialized record — the restore path (SessionStore's
 * carrels phase). The saved pose and born values are authoritative: no camera-ray
 * placement, no Settings fold — the desk stands back up exactly where it lived,
 * born as it was and wearing its own values (the tuning record, restored first), and
 * pre-shaped (expect) for the member complement the model claims for it, which seats
 * as windows materialize.
 * @param {AppContext} ctx
 * @param {{name:string, managed?:boolean, position?:{x,y,z}, yaw?:number, params?:Object}} saved
 * @param {number} [expected=0] members the model claims for this desk
 * @returns {Carrel|null}
 */
export function restoreCarrel(ctx, saved, expected = 0) {
    const map = carrels(ctx);
    if (!map || !ctx.scene || !saved?.name) return null;
    if (map.has(saved.name)) return map.get(saved.name);
    const carrel = new Carrel({ name: saved.name, ...(saved.params || {}) });
    if (ctx.atlas) carrel.setPlaneUnit(planeUnitOf(ctx));
    applyDeskTune(carrel, tuneOf(ctx, carrel.name));
    wirePanes(ctx, carrel);
    // A world-MANAGED desk re-registers as its grouping — the layout owns its pose
    // (saved pose ignored).
    const managed = !!saved.managed && !!ctx.world;
    if (managed) {
        carrel.worldManaged = true;
        ctx.world.register(carrel.name, carrel, () => carrel.getLocalBounds());
    } else {
        const p = saved.position || {};
        carrel.position.set(p.x || 0, p.y || 0, p.z || 0);
        carrel.rotation.y = Number(saved.yaw) || 0;
        ctx.scene.add(carrel);
    }
    ctx.registry?.register?.(`carrel:${saved.name}`, carrel, { type: 'carrel' });
    map.set(saved.name, carrel);
    carrel.expect(expected);
    return carrel;
}

/**
 * The carrel sweep — two passes, deferred one macrotask and coalesced (AgentBooks
 * fires onChange mid-mutation, and session restore pins books right AFTER the
 * hydrate that announces them; the sweep runs after the current job settles).
 *
 * 1. RESIDENCE (Holding.reconcile): model-claimed windows seat at their desk the
 *    moment they materialize — immediately (load-is-not-replay: a rebuilt desk
 *    re-seats its members in place, nothing flies), order threaded through, then
 *    the dock re-locks what rides, so a seated-and-docked window rides FROM its
 *    seat. Unserved claims persist as residence memory: a window reopened much
 *    later still comes home to its desk.
 * 2. AUTO-SHELF (the default residence): every NEW agent book no owner seated (the
 *    agents desk and the gomuxai hub seat theirs at birth) seats at the 'agents'
 *    desk, a cylinder auto-created on first need. Once per lane
 *    BIRTH, never a leash — released/re-seated/docked/pinned books stay where the
 *    user put them. Settings ▸ Agent Books `book.autoShelf` off disarms this pass.
 * @param {AppContext} ctx
 */
export function scheduleCarrelSweep(ctx) {
    if (ctx._carrelSweepTimer) return;
    ctx._carrelSweepTimer = setTimeout(() => {
        ctx._carrelSweepTimer = null;
        try { carrelSweep(ctx); }
        catch (e) { console.warn('[carrel] sweep failed', e); }
    }, 0);
}

/** The sweep body, callable synchronously (SessionStore runs one last pass at the
 *  end of restore to catch members that landed after the final change event).
 * @param {AppContext} ctx
 */
export function carrelSweep(ctx) {
    const map = carrels(ctx);
    if (!map || !ctx.scene) return;
    ctx.holding.reconcile();
    autoShelf(ctx, map);
}

/**
 * Pass 2 — the agents-shelf default for unclaimed newcomers. @see scheduleCarrelSweep
 * @param {AppContext} ctx
 */
function autoShelf(ctx, map) {
    const lanes = ctx.agentBooks?.lanes;
    if (!lanes) return;
    const existing = map.get(AGENT_SHELF);
    const seen = (ctx._agentShelfSeen ??= new Set());
    for (const id of [...seen]) if (!ctx.registry?.has?.(id)) seen.delete(id);   // cleared books may be reborn
    if (getSetting('book.autoShelf') === false) return;

    // Books are held by their registry id (lane.groupId) — the one key the dock uses too.
    // A book that's already placed — held, claimed by a desk, or pinned by hand — is seen:
    // the default is once per birth, never a leash, so letting it go later won't re-shelve it.
    const newcomers = [];
    for (const lane of lanes.values()) {
        const id = lane.groupId;
        if (seen.has(id)) continue;
        if (lane.pinned || ctx.holding.holderOf(id) || ctx.workspace?.getSurface?.(id)?.view?.carrel) seen.add(id);
        else newcomers.push(lane);
    }
    if (!newcomers.length) return;

    // A world sibling of the tree, born a cylinder like the gomuxai hub — the agents desk's
    // own (derived) when it runs, so the desk has one owner however it first stood up.
    const shelf = existing ?? ctx.sessionDesk?.tree.desk(AGENT_SHELF)
        ?? buildCarrel(ctx, AGENT_SHELF, { managed: true, form: cylinderForm() });
    if (shelf._dissolving) return;   // folding — the newcomers keep their cluster spots

    for (const lane of newcomers) {
        seen.add(lane.groupId);
        ctx.holding.seat({ id: lane.groupId, grid: lane.book }, shelf);
    }
}

/**
 * Enter a PLANE desk: the camera eases into the plane view squared to its board at the desk's own
 * scale (its unit — never the viewport), aimed at the focused pin (pins) or the frame (tiles), and
 * attention lands on the focused member at t = 0, before the camera does. The members are already
 * where they read: entering moves only the camera. Entering another plane while one is entered is
 * the camera's switch (its home stays the first one's).
 * @param {import('../../client/CommandProvider.jsx').AppContext} ctx @param {Object} carrel
 */
function enterPlaneDesk(ctx, carrel) {
    const cc = ctx.cameraController;
    const rect = carrel.getPlaneRect();
    if (!rect) return { text: `ERR: '${carrel.carrelName}' has no plane yet (no unit — the atlas isn't ready)`, data: null };
    const vp = cc.planeViewport();
    const prev = ctx.enteredCarrel;
    let aim = { x: 0, y: 0 };
    let focus = null;
    if (carrel.planeArrange === 'pins') {
        focus = carrel.focusedPin();
        const leftInset = ctx.strip?.leftInsetForCarrel?.(carrel) ?? 0;   // the strip's band stays clear of the pin
        aim = (focus && carrel.pinAim(focus, vp, Number(getSetting('plane.topMarginPx')) * (vp.dpr || 1), leftInset)) || aim;
        setFocusTo(ctx, focus);
    } else {
        focus = focusPaneFront(ctx, carrel);
    }
    ctx.activeCarrel = carrel.carrelName;
    const s = enterPlaneView(ctx, `carrel:${carrel.carrelName}`, {
        center: rect.center, normal: rect.normal, up: rect.up, pxPerUnit: rect.pxPerUnit, depth: 2 * Math.max(carrel._layoutD ?? 0, 1) * rect.scale,
        aim, origin: rect.origin,
    });
    if (prev && prev !== carrel.carrelName) ctx.carrelBack = prev;
    ctx.enteredCarrel = carrel.carrelName;
    ctx.pendingEnter = null;
    armEnteredLife(ctx);
    recordEntered(ctx, carrel.carrelName);
    const count = carrel.planeArrange === 'pins' ? carrel.pinRects().filter((p) => !p.ghost).length : carrel.paneRects().length;
    return {
        text: `OK: entered '${carrel.carrelName}' — ${count} ${carrel.planeArrange === 'pins' ? 'pin' : 'pane'}(s) at ${carrel.planeUnit.cellPx} px/column${focus ? `, focus '${focus}'` : ''}`,
        data: { name: carrel.carrelName, mode: 'plane', arrange: carrel.planeArrange, focus, ...s },
    };
}

/** Attention to one member: primary always, the keyboard when it's a terminal. */
function setFocusTo(ctx, id) {
    if (!id) return;
    const type = ctx.registry?.get?.(id)?.type;
    ctx.attentionManager?.set?.('primary', id, { registry: ctx.registry });
    ctx.attentionManager?.set?.('key', type === 'terminal' ? id : null, { registry: ctx.registry });
}

/**
 * @param {import('../../client/CommandProvider.jsx').AppRouter} router
 */
export default function registerCarrelCommands(router) {
    router.register('carrel.create', (args, ctx) => {
        const map = carrels(ctx);
        if (!map || !ctx.scene) return { text: 'ERR: carrels not ready', data: null };
        let name = String(args[0] ?? '').trim();
        if (!name) {
            let n = map.size + 1;
            while (map.has(`carrel-${n}`)) n++;
            name = `carrel-${n}`;
        }
        if (map.has(name)) return { text: `ERR: carrel '${name}' already exists`, data: null };
        const carrel = buildCarrel(ctx, name, { radius: parseFloat(args[1]), form: { mode: String(getSetting('carrel.createMode')) } });
        ctx.activeCarrel = name;
        const d = carrel.userData.setDown;
        const at = d ? ` at (${d.at.x.toFixed(1)}, ${d.at.y.toFixed(1)}, ${d.at.z.toFixed(1)})` : '';
        const moved = d?.blockedBy.length ? ` — slid ${Math.abs(d.slid).toFixed(1)} to its ${d.slid > 0 ? 'right' : 'left'}: ${d.blockedBy.map((n) => `'${n}'`).join(', ')} stood where you were looking` : '';
        return { text: `OK: carrel '${name}' set down${at} (${carrel.mode}, r=${carrel.radius})${moved}`, data: { name, mode: carrel.mode, radius: carrel.radius, setDown: d ?? null } };
    }, { description: 'Set down a new carrel (world-anchored desk) ahead of the camera — inside a plane, beside the desk you read — sliding to the nearest spot clear of other desks (carrel.createGap)', usage: '[name] [radius]', returns: '{ name, mode, radius, setDown:{at, slid, blockedBy} }' });

    router.register('carrel.add', (args, ctx) => {
        // Forgiving arg order: `<book> [carrel]` is canon, but container-first
        // (`carrel.add carrel-1 <book>`) is what English suggests — if the
        // carrel slot names no carrel and the id slot does, swap. Live
        // finding: the local-model driver wrote container-first and the old
        // blanket "no carrel" error convinced it the carrel itself was gone.
        const map = carrels(ctx);
        let idArg = args[0], carrelArg = args[1];
        if (map && args.length >= 2 && !map.has(String(carrelArg)) && map.has(String(idArg))) {
            [idArg, carrelArg] = [carrelArg, idArg];
        }
        const carrel = findCarrel(ctx, carrelArg);
        if (!carrel) {
            const have = map && map.size ? [...map.keys()].join(', ') : null;
            return { text: carrelArg != null && have
                ? `ERR: no carrel named '${carrelArg}' (have: ${have})`
                : 'ERR: no carrel (carrel.create first)', data: null };
        }
        const r = ctx.holding.resolve(idArg);
        if ('error' in r) return { text: `ERR: ${r.error}`, data: null };

        // The handoff (dock → desk, desk → desk, borrowed → back to its seat) is Holding's.
        const how = ctx.holding.seat(r, carrel);
        if (how === 'already') return { text: `OK: '${r.id}' already seated at '${carrel.carrelName}'`, data: { id: r.id, carrel: carrel.carrelName } };
        if (how === 'returned') return { text: `OK: '${r.id}' put back in its seat at '${carrel.carrelName}'`, data: { id: r.id, carrel: carrel.carrelName } };
        if (!how) return { text: `ERR: could not seat '${r.id}'`, data: null };
        worldTouch(ctx, carrel);
        // An attached caller's seat carries its name (carrel.who lists it).
        const by = ctx.participants?.noteSeated(ctx.caller, carrel.carrelName, r.id) ? ctx.caller : null;
        // Name the species in the receipt: a driver seating "books" by bare
        // index will read `seated terminal 'term-9'` and catch itself.
        const kindTag = r.kind ? `${r.kind} ` : '';
        return { text: `OK: seated ${kindTag}'${r.id}' at '${carrel.carrelName}'${by ? ` (by ${by})` : ''}`, data: { id: r.id, kind: r.kind ?? null, carrel: carrel.carrelName, by } };
    }, { description: 'Seat a window or whole book at a carrel (default: the active one); docked windows hand over cleanly, a borrowed one goes back to its seat', usage: '<id|index|book> [carrel]', returns: '{ id, carrel }' });

    router.register('carrel.release', (args, ctx) => {
        const r = ctx.holding.resolve(args[0]);
        if ('error' in r) return { text: `ERR: ${r.error}`, data: null };
        const id = r.id;
        // A borrowed (docked) member stays docked — its ride now ends at the desk's home.
        const owner = ctx.holding.unseat(id);
        if (!owner) return { text: `ERR: '${id}' is not seated at any carrel`, data: null };
        worldTouch(ctx, owner);
        return { text: `OK: '${id}' sent home from '${owner.carrelName}'`, data: { id, carrel: owner.carrelName } };
    }, { description: 'Send a seated surface home from its carrel', usage: '<id|index>', returns: '{ id, carrel }' });

    router.register('carrel.settle', (args, ctx) => {
        const carrel = findCarrel(ctx, args[0]);
        if (!carrel) return { text: `ERR: no carrel '${args[0] ?? ''}'`, data: null };
        carrel.settle();
        worldTouch(ctx, carrel);
        return { text: `OK: '${carrel.carrelName}' re-seated from its members' sizes now`, data: { carrel: carrel.carrelName } };
    }, { description: "Re-seat a desk's members by their sizes now — a seat otherwise only grows (a member shrinking keeps its room until the desk re-learns)", usage: '[name]', returns: '{ carrel }' });

    // ── Presence: who besides the person is at a desk (client/Participants.js) ──
    router.register('carrel.attach', (args, ctx) => {
        if (!ctx.participants) return { text: 'ERR: participants not wired', data: null };
        if (!ctx.caller) return { text: 'ERR: carrel.attach needs an identified caller — glyph3d-cli --as <name> (AGENT_NAME); an anonymous call has no one to list', data: null };
        const carrel = findCarrel(ctx, args[0]);
        if (!carrel || !args[0]) return { text: `ERR: usage: carrel.attach <carrel>${args[0] ? ` (no carrel '${args[0]}')` : ''}`, data: null };
        const r = ctx.participants.attach(ctx.caller, carrel.carrelName);
        if (!r.ok) return { text: `ERR: ${r.error}`, data: null };
        return { text: `OK: ${ctx.caller} ${r.already ? 'already at' : 'attached to'} '${carrel.carrelName}'`, data: { name: ctx.caller, carrel: carrel.carrelName, already: r.already } };
    }, { description: "Be present at a carrel as yourself (an identified caller): listed in carrel.who in your hue; what you seat there carries your name", usage: '<carrel>', returns: '{ name, carrel, already }' });

    router.register('carrel.detach', (args, ctx) => {
        if (!ctx.participants) return { text: 'ERR: participants not wired', data: null };
        if (!ctx.caller) return { text: 'ERR: carrel.detach needs an identified caller — glyph3d-cli --as <name> (AGENT_NAME)', data: null };
        const left = ctx.participants.detach(ctx.caller, args[0] != null ? String(args[0]) : null);
        if (!left.length) return { text: `ERR: ${ctx.caller} is not attached${args[0] != null ? ` to '${args[0]}'` : ' anywhere'}`, data: null };
        return { text: `OK: ${ctx.caller} left ${left.map((c) => `'${c}'`).join(', ')}`, data: { name: ctx.caller, left } };
    }, { description: 'Leave a carrel you attached to (every carrel when none is named)', usage: '[carrel]', returns: '{ name, left }' });

    router.register('carrel.who', (args, ctx) => {
        if (!ctx.participants) return { text: 'ERR: participants not wired', data: null };
        let name = null;
        if (args[0] != null) {
            const carrel = findCarrel(ctx, args[0]);
            if (!carrel) return { text: `ERR: no carrel '${args[0]}'`, data: null };
            name = carrel.carrelName;
        }
        ctx.participants.prune();
        const who = ctx.participants.who(name).map((p) => ({ name: p.name, carrel: p.carrel, since: p.since, seated: [...p.seated] }));
        const line = who.length ? who.map((p) => `${p.name}@${p.carrel}${p.seated.length ? ` [${p.seated.join(', ')}]` : ''}`).join('  ') : '(no one)';
        return { text: `OK: ${line}`, data: { carrel: name, participants: who } };
    }, { description: 'Who is attached to a carrel (or to any) — presence, oldest first, with what each seated there', usage: '[carrel]', returns: '{ carrel, participants:[{name,carrel,since,seated}] }' });

    router.register('carrel.list', (_args, ctx) => {
        const map = carrels(ctx);
        if (!map) return { text: 'ERR: carrels not ready', data: null };
        const desks = [...map.values()].map((c) => ({
            name: c.carrelName,
            active: c.carrelName === ctx.activeCarrel,
            members: c.list(),
        }));
        const summary = desks.length
            ? desks.map((d) => `${d.active ? '*' : ' '}${d.name}(${d.members.length}): ${d.members.map((m) => m.id).join(', ') || '(empty)'}`).join('  |  ')
            : '(no carrels)';
        return { text: `OK: ${summary}`, data: { carrels: desks } };
    }, { description: 'List every carrel and its seated members (* = active)', returns: '{ carrels:[{name,active,members}] }' });

    // A desk's members as the desk HOLDS them, against the registry: the object it carries is the
    // window's live one, under the desk, still in the scene. A member object swapped behind the desk's
    // back (a row materialized into its actor, a window re-made on restore) draws nothing in its seat.
    router.register('carrel.check', (args, ctx) => {
        const map = carrels(ctx);
        if (!map) return { text: 'ERR: carrels not ready', data: null };
        const desks = args[0] ? [findCarrel(ctx, args[0])].filter(Boolean) : [...map.values()];
        if (!desks.length) return { text: `ERR: no carrel '${args[0]}'`, data: null };
        const where = (o) => { const p = []; for (let n = o; n && p.length < 5; n = n.parent) p.push(String(n.name || n.type).split('/').pop()); return p.join(' ← ') || '(detached)'; };
        const rows = [];
        for (const desk of desks) {
            for (const e of desk.entries.values()) {
                const live = ctx.registry.get(e.id)?.grid ?? null;
                let under = false;
                for (let n = e.grid; n; n = n.parent) if (n === desk) under = true;
                let inScene = false;
                for (let n = e.grid; n; n = n.parent) if (n === ctx.scene) inScene = true;
                const g = e.grid, f = (v) => +Number(v).toFixed(2);
                const seat = e._seat ? { x: f(e._seat.x), y: f(e._seat.y), z: f(e._seat.z), eff: f(e._seat.eff) } : null;
                const pos = g ? { x: f(g.position.x), y: f(g.position.y), z: f(g.position.z), s: f(g.scale.x) } : null;
                const seated = !!seat && !!pos && Math.hypot(pos.x - seat.x, pos.y - seat.y, pos.z - seat.z) < 1e-2;
                const moving = !!desk.animator?.isAnimating;
                // In its seat (once the desk has given it one, and isn't sliding it there now).
                const ok = !!live && g === live && under && inScene && (!seat || seated || moving);
                rows.push({ desk: desk.carrelName, id: e.id, ok, held: g === live, heldKind: g?.constructor?.name ?? null, liveKind: live?.constructor?.name ?? null, under, inScene, heldAt: where(g), liveAt: live && live !== g ? where(live) : null, pos, seat, seated, borrowed: !!e._borrowed, moving, planeUnit: !!desk.planeUnit, mode: desk.mode });
            }
        }
        const bad = rows.filter((r) => !r.ok);
        const line = (r) => `  ${r.ok ? '✓' : '✗'} ${r.desk} · ${r.id}: holds ${r.heldKind}${r.held ? ' (the live one)' : ` — the registry's is a ${r.liveKind ?? 'nothing'} at ${r.liveAt ?? '—'}`} · ${r.under ? 'under the desk' : 'NOT under the desk'}${r.inScene ? '' : ' · NOT in the scene'} · at ${r.heldAt}`
            + `\n      pos ${JSON.stringify(r.pos)} · seat ${JSON.stringify(r.seat)}${r.seated ? ' (in it)' : r.seat ? ' (NOT in it)' : ''}${r.borrowed ? ' · borrowed' : ''}${r.moving ? ' · desk animating' : ''} · ${r.mode}${r.mode === 'plane' && !r.planeUnit ? ' (NO plane unit)' : ''}`;
        return {
            text: rows.map(line).join('\n') + (bad.length ? `\nFAIL: ${bad.length} member(s) not held live in their seats` : `\nOK: ${rows.length} member(s), each held live in its seat`),
            data: { members: rows },
        };
    }, { description: "Check each desk member: the desk holds the window's live object, under the desk, in the scene, standing in its seat (else where the live one is)", usage: '[name]', returns: '{ members:[{desk,id,ok,held,heldKind,liveKind,under,inScene,heldAt,liveAt}] }' });

    router.register('carrel.focus', (args, ctx) => {
        const carrel = findCarrel(ctx, args[0]);
        if (!carrel) return { text: `ERR: no carrel '${args[0] ?? ''}'`, data: null };
        ctx.activeCarrel = carrel.carrelName;
        carrel.updateWorldMatrix(true, false);   // fresh: getBounds reads matrixWorld as three last left it
        const framed = !!ctx.cameraController?.focusOnBox?.(carrel.getBounds());
        return { text: `OK: focused carrel '${carrel.carrelName}'`, data: { name: carrel.carrelName, framed } };
    }, { description: 'Make a carrel active and fly the camera to frame it', usage: '<name>', returns: '{ name, framed }' });

    router.register('carrel.enter', (args, ctx) => {
        const carrel = findCarrel(ctx, args[0]);
        if (!carrel) return { text: `ERR: no carrel '${args[0] ?? ''}'`, data: null };
        const cc = ctx.cameraController;
        if (!cc?.flyTo) return { text: 'ERR: no camera controller', data: null };
        if (carrel.mode === 'plane') return enterPlaneDesk(ctx, carrel);
        ctx.activeCarrel = carrel.carrelName;
        // Stand at the desk's center (its table origin), eyes at its members' mean height,
        // facing its back (local −z): a ring's arc centers ahead, a grid's wall stands ahead.
        carrel.updateWorldMatrix(true, true);
        const c = new THREE.Vector3();
        let ySum = 0, n = 0;
        for (const e of carrel.entries.values()) {
            if (e.grid.parent !== carrel) continue;   // borrowed — riding elsewhere
            const b = e.grid.getBounds?.();
            if (!b || b.isEmpty()) continue;
            ySum += b.getCenter(c).y; n++;
        }
        const eye = new THREE.Vector3(0, 0, 0).applyMatrix4(carrel.matrixWorld);
        eye.y = n ? ySum / n : eye.y + carrel.boxH * 0.5;
        const back = new THREE.Vector3(0, 0, -1).transformDirection(carrel.matrixWorld);
        const yaw = Math.atan2(-back.x, -back.z);
        cc.flyTo({ position: { x: eye.x, y: eye.y, z: eye.z }, pitch: 0, yaw }, { ms: 600 });
        return { text: `OK: standing in carrel '${carrel.carrelName}'`, data: { name: carrel.carrelName, position: { x: eye.x, y: eye.y, z: eye.z }, yaw } };
    }, { description: "Stand the camera at a carrel's center, facing its back — a ring's members are a turn away", usage: '[name]', returns: '{ name, position, yaw }' });

    router.register('carrel.leave', (_args, ctx) => {
        const cc = ctx.cameraController;
        const was = ctx.enteredCarrel ?? null;
        if (!was) return { text: 'ERR: not in a carrel (carrel.enter <name> on a plane desk)', data: null };
        if (!cc?.leavePlane?.({ ms: Number(getSetting('plane.leaveMs')) })) return { text: `ERR: '${was}' isn't entered as a plane`, data: null };
        return { text: `OK: leaving carrel '${was}'`, data: { name: was } };
    }, { description: 'Ease back out of the entered plane desk to exactly where you entered from', returns: '{ name }' });

    router.register('carrel.back', (_args, ctx) => {
        const name = ctx.carrelBack;
        const carrel = name ? findCarrel(ctx, name) : null;
        if (!carrel) return { text: 'ERR: no carrel to go back to (enter two plane desks first)', data: null };
        if (carrel.mode !== 'plane') return { text: `ERR: '${name}' is no longer a plane desk`, data: null };
        return enterPlaneDesk(ctx, carrel);
    }, { description: 'Back to the plane desk you were in before this one (i3 back-and-forth, tmux last-window)', returns: '{ name, focus, … plane.state }' });

    router.register('carrel.dissolve', (args, ctx) => {
        const map = carrels(ctx);
        const carrel = findCarrel(ctx, args[0]);
        if (!map || !carrel) return { text: `ERR: no carrel '${args[0] ?? ''}'`, data: null };
        const members = carrel.list();
        ctx.holding.fold(carrel);
        ctx.registry?.unregister?.(`carrel:${carrel.carrelName}`); // out of the world spine now
        if (carrel.worldManaged) {
            // Leave the world row before folding — the scene holds the desk while
            // its homeward slides drain, and the row closes up immediately.
            ctx.world?.unregister(carrel.name);
            carrel.worldManaged = false;
            ctx.scene?.add(carrel);
        }
        carrel.dissolve(); // members slide home; the runner sweeps the desk once drained
        forgetTune(ctx, carrel.name);   // a desk set down later under this name starts fresh
        if (ctx.activeCarrel === carrel.carrelName) ctx.activeCarrel = null;
        return { text: `OK: carrel '${carrel.carrelName}' dissolving (${members.length} member(s) sent home)`, data: { name: carrel.carrelName, released: members.length } };
    }, { description: 'Fold a carrel: every member slides home, then the desk vanishes', usage: '<name>', returns: '{ name, released }' });

    router.register('carrel.move', (args, ctx) => {
        const carrel = findCarrel(ctx, args[0]);
        if (!carrel) return { text: `ERR: no carrel '${args[0] ?? ''}'`, data: null };
        const [x, y, z] = [parseFloat(args[1]), parseFloat(args[2]), parseFloat(args[3])];
        if (![x, y, z].every(Number.isFinite)) return { text: 'ERR: usage: carrel.move <name> <x> <y> <z>', data: null };
        // Moving a world-managed desk takes it OUT of the world row — user-placed
        // wins, the pin law. The scene re-adopts it; the row closes up behind.
        if (carrel.worldManaged) {
            ctx.world?.unregister(carrel.name);
            carrel.worldManaged = false;
            ctx.scene?.add(carrel);
        }
        carrel.position.set(x, y, z);
        return { text: `OK: carrel '${carrel.carrelName}' → (${x}, ${y}, ${z})`, data: { name: carrel.carrelName, position: { x, y, z } } };
    }, { description: 'Move a carrel to a world position (members ride along); a world-managed desk becomes user-placed', usage: '<name> <x> <y> <z>', returns: '{ name, position }' });

    router.register('carrel.set', (args, ctx) => {
        const carrel = findCarrel(ctx, args[0]);
        if (!carrel) return { text: `ERR: no carrel '${args[0] ?? ''}'`, data: null };
        const key = String(args[1] ?? '');
        const r = tuneDesk(ctx, carrel, key, args[2] ?? '');
        if (!r.ok) return { text: `ERR: ${r.error} — usage: carrel.set <name> <knob> <value|default>`, data: null };
        worldTouch(ctx, carrel);
        const tag = r.own ? '' : ' (what it was born as)';
        return { text: `OK: carrel '${carrel.carrelName}' ${key} = ${r.value}${tag}`, data: { name: carrel.carrelName, key, value: r.value, own: r.own } };
    }, {
        description: "Give ONE desk its own value for a knob — it wins over the Settings defaults and every owner's dressing, and persists; 'default' hands the knob back to what the desk was born as",
        usage: `<name> <${DESK_KNOBS.map((k) => k.key).join('|')}> <value|default>`,
        returns: '{ name, key, value, own }',
    });

    router.register('carrel.get', (args, ctx) => {
        const carrel = findCarrel(ctx, args[0]);
        if (!carrel) return { text: `ERR: no carrel '${args[0] ?? ''}'`, data: null };
        const d = readDesk(ctx, carrel);
        const lines = DESK_KNOBS.map((k) => {
            const v = d.values[k.key];
            const shown = typeof v === 'number' ? Math.round(v * 1000) / 1000 : v;
            return `${k.key in d.own ? '*' : ' '}${k.key} = ${shown}${k.key in d.own ? ` (born ${d.born[k.key]})` : ''}`;
        });
        return { text: `OK: carrel '${d.name}' (* = its own value)\n${lines.join('\n')}`, data: d };
    }, {
        description: "Read one desk's knobs — the live value of each, what it was born as, and which are its own",
        usage: '[name]',
        returns: '{ name, values, born, own }',
    });
}

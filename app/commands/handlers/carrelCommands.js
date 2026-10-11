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
 * Agent books are born onto the 'agents' shelf — a grid-mode desk auto-created
 * on first agent sight (scheduleCarrelSweep's auto-shelf pass, driven by
 * AgentBooks.onChange). Settings ▸ Agent Books `book.autoShelf` turns it off.
 *
 * Desks PERSIST: SessionStore captures each carrel's serialize() (pose, knobs,
 * membership) and restores desks FIRST — restoreCarrel stands them back up at
 * their saved pose, pre-shaped for their member complement, and the sweep's
 * manifest pass seats each member IN PLACE as its window materializes. The desk
 * loads, then loads its elements — content never flies across the room.
 */

import * as THREE from 'three';
import Carrel from '@glyph3d/core/services/interaction/Carrel.js';
import { getSetting } from '../../client/settings.js';
/** @import { AppContext } from '../../client/CommandProvider.jsx' */

/** The knobs Settings ▸ Carrel stores — folded into a NEW desk at birth. */
const CARREL_KNOBS = ['radius', 'boxH', 'boxAspect', 'gapFrac', 'growCap', 'maxArcDeg',
                      'tableFrac', 'shadowSoft', 'glowStrength'];

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
 * birth path for carrel.create and the auto-created agent shelf.
 *
 * Stored Settings ▸ Carrel knobs are the DEFAULTS for a new desk — folded into
 * THIS desk only (existing desks keep their per-desk carrel.set tweaks); an
 * explicit radius wins over the stored one. A FREE desk lands ON the camera's
 * view ray — where you're looking, not a floor projection of it (which parked
 * the desk at y=0 far below an elevated gaze, reading tiny-in-the-distance);
 * the tabletop sits half a slot below the ray point so row 0 rises into your
 * gaze, and the doorway (local +z) turns back toward the viewer. A MANAGED desk
 * (`managed`, the agents shelf) instead registers as a WorldLayout grouping —
 * a sibling of the file tree on the shared floor; the layout places it, and
 * carrel.move takes it back out (user-placed wins, the pin law). Registered
 * (type 'carrel') either way, so the camera's dynamic-speed / soft-bounds /
 * fit-all spine (getSurfaces) sees it — a desk is a PLACE, not cargo;
 * Holding.resolve refuses to treat it as one.
 * @param {AppContext} ctx
 * @returns {Carrel}
 */
function buildCarrel(ctx, name, { radius, managed = false } = {}) {
    const carrel = new Carrel({ name });
    for (const k of CARREL_KNOBS) {
        const v = getSetting(`carrel.${k}`);
        if (Number.isFinite(v)) carrel.setParam(k, v);
    }
    if (Number.isFinite(radius)) carrel.setParam('radius', radius);

    if (managed && ctx.world) {
        carrel.worldManaged = true;
        ctx.world.register(carrel.name, carrel, () => carrel.localBounds());
    } else {
        const cam = ctx.camera;
        if (cam) {
            const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
            const dist = carrel.radius * 1.6;
            const p = new THREE.Vector3().copy(cam.position).addScaledVector(fwd, dist);
            carrel.position.set(p.x, Math.max(p.y - carrel.boxH * 0.5, 0), p.z);
            carrel.rotation.y = Math.atan2(cam.position.x - p.x, cam.position.z - p.z);
        }
        ctx.scene.add(carrel);
    }
    ctx.registry?.register?.(`carrel:${name}`, carrel, { type: 'carrel' });
    carrels(ctx)?.set(name, carrel);
    return carrel;
}

/** The desk agent books call home by default. */
const AGENT_SHELF = 'agents';

/**
 * Rebuild a desk from its serialized record — the restore path (SessionStore's
 * carrels phase). The saved pose and knobs are authoritative: no camera-ray
 * placement, no Settings fold — the desk stands back up exactly where it lived,
 * dressed as it was, and pre-shaped (expect) for the member complement the
 * model claims for it, which seats as windows materialize.
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
    // A world-MANAGED desk re-registers as its grouping — the layout owns its pose
    // (saved pose ignored).
    const managed = !!saved.managed && !!ctx.world;
    if (managed) {
        carrel.worldManaged = true;
        ctx.world.register(carrel.name, carrel, () => carrel.localBounds());
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
 * 2. AUTO-SHELF (the default residence): every NEW agent book seats at the
 *    'agents' desk, a grid-mode desk auto-created on first need. Once per lane
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

    const shelf = map.get(AGENT_SHELF) ?? (() => {
        const c = buildCarrel(ctx, AGENT_SHELF, { managed: true });   // a world sibling of the tree
        c.setMode('grid');
        return c;
    })();
    if (shelf._dissolving) return;   // folding — the newcomers keep their cluster spots

    for (const lane of newcomers) {
        seen.add(lane.groupId);
        ctx.holding.seat({ id: lane.groupId, grid: lane.book }, shelf);
    }
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
        const carrel = buildCarrel(ctx, name, { radius: parseFloat(args[1]) });
        ctx.activeCarrel = name;
        return { text: `OK: carrel '${name}' set down (r=${carrel.radius})`, data: { name, radius: carrel.radius } };
    }, { description: 'Set down a new carrel (world-anchored desk) ahead of the camera', usage: '[name] [radius]', returns: '{ name, radius }' });

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
        // Name the species in the receipt: a driver seating "books" by bare
        // index will read `seated terminal 'term-9'` and catch itself.
        const kindTag = r.kind ? `${r.kind} ` : '';
        return { text: `OK: seated ${kindTag}'${r.id}' at '${carrel.carrelName}'`, data: { id: r.id, kind: r.kind ?? null, carrel: carrel.carrelName } };
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

    router.register('carrel.focus', (args, ctx) => {
        const carrel = findCarrel(ctx, args[0]);
        if (!carrel) return { text: `ERR: no carrel '${args[0] ?? ''}'`, data: null };
        ctx.activeCarrel = carrel.carrelName;
        const framed = !!ctx.cameraController?.focusOnBox?.(carrel.getBounds());
        return { text: `OK: focused carrel '${carrel.carrelName}'`, data: { name: carrel.carrelName, framed } };
    }, { description: 'Make a carrel active and fly the camera to frame it', usage: '<name>', returns: '{ name, framed }' });

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
        if (key === 'facing') {
            const f = String(args[2] ?? '');
            if (!carrel.setFacing(f)) return { text: 'ERR: carrel.set <name> facing <in|out>', data: null };
            worldTouch(ctx, carrel);
            return { text: `OK: carrel '${carrel.carrelName}' facing ${f}`, data: { name: carrel.carrelName, key, value: f } };
        }
        if (key === 'mode') {
            const m = String(args[2] ?? '');
            if (!carrel.setMode(m)) return { text: 'ERR: carrel.set <name> mode <ring|grid>', data: null };
            worldTouch(ctx, carrel);
            return { text: `OK: carrel '${carrel.carrelName}' mode ${m}`, data: { name: carrel.carrelName, key, value: m } };
        }
        const value = parseFloat(args[2]);
        if (!carrel.setParam(key, value)) {
            return { text: 'ERR: usage: carrel.set <name> <radius|boxH|boxAspect|gapFrac|maxArcDeg|tableFrac|shadowSoft|glowStrength|animDur|yawRate|mode|facing> <value>', data: null };
        }
        worldTouch(ctx, carrel);
        return { text: `OK: carrel '${carrel.carrelName}' ${key} = ${value}`, data: { name: carrel.carrelName, key, value } };
    }, { description: 'Tune a carrel layout/chrome parameter live', usage: '<name> <param> <value>', returns: '{ name, key, value }' });
}

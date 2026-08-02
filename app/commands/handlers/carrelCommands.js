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
 * Carrel is a projection of it. Moving a window between the dock and a carrel
 * hands the HOME record over (CameraDock.homeOf / Carrel.homeOf) so home always
 * chains residence → residence, never through the vehicle.
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
import { resolveSurface } from './dockCommands.js';
import { getSetting } from '../../client/settings.js';

/** The knobs Settings ▸ Carrel stores — folded into a NEW desk at birth. */
const CARREL_KNOBS = ['radius', 'boxH', 'boxAspect', 'gapFrac', 'growCap', 'maxArcDeg',
                      'tableFrac', 'shadowSoft', 'glowStrength'];

function carrels(ctx) {
    return ctx.carrels instanceof Map ? ctx.carrels : null;
}

/** Resolve a carrel by name, else the active one, else the most recently created. */
function findCarrel(ctx, name) {
    const map = carrels(ctx);
    if (!map) return null;
    if (name) return map.get(String(name)) || null;
    if (ctx.activeCarrel && map.has(ctx.activeCarrel)) return map.get(ctx.activeCarrel);
    let last = null;
    for (const c of map.values()) last = c;
    return last;
}

/** The carrel currently holding a surface id, or null. (window.drop asks too.) */
export function findCarrelOwner(ctx, id) {
    const map = carrels(ctx);
    if (!map) return null;
    for (const c of map.values()) if (c.has(id)) return c;
    return null;
}

/** Record (or clear, with null) the carrel view fact for a surface. */
function setFact(ctx, id, value, kind) {
    ctx.workspace?.setSurfaceView?.(id, kind ?? ctx.registry?.get?.(id)?.type, { carrel: value });
}

/**
 * Lift a seated surface out of whichever desk holds it: clear the view fact and
 * release — optionally re-aimed at a caller-computed pose (`to`, the
 * Carrel.release re-aim; book.move pins a dragged book at its drop spot). The
 * one unseat path — the carrel.release verb and the drag-off ride it together.
 * @returns {Carrel|null} the desk it left, or null if it wasn't seated
 */
export function unseat(ctx, id, to = null) {
    const owner = findCarrelOwner(ctx, id);
    if (!owner) return null;
    setFact(ctx, id, null);
    owner.release(id, to ? { to } : {});
    return owner;
}

/**
 * Anything hostable at a desk: a registry surface (grid / terminal / frame) OR an
 * agent's book — the shelf's lanes are not registry surfaces, so they resolve here
 * by lane id. The returned `grid` is always a live Object3D the Carrel can seat;
 * a seated agent book keeps streaming (AgentBooks.update eases lanes, not root
 * children, so its deck stays live while borrowed).
 * @returns {{id:string, grid:Object, kind:string|undefined}|null}
 */
function resolveHostable(ctx, arg) {
    // book.list labels agent lanes `agent:<id>` — accept the label back here
    // too (drivers paste what they see; same round-trip rule as resolveBook).
    if (typeof arg === 'string' && arg.startsWith('agent:')) arg = arg.slice(6);
    const surf = resolveSurface(ctx, arg);
    if (surf) {
        const entry = ctx.registry?.get?.(surf.id);
        // An agent deck root (role 'agent') aliases a lane's book — seating it
        // would give one live object two member identities. Books seat by
        // their LANE id, below.
        if (entry?.role === 'agent') return null;
        return { ...surf, kind: entry?.type };
    }
    const key = String(arg ?? '');
    const lane = ctx.agentBooks?.lanes?.get?.(key);
    if (lane?.book) return { id: key, grid: lane.book, kind: 'agent-book' };
    return null;
}

/**
 * Construct a desk, dress it, set it down, make it a world citizen — the shared
 * birth path for carrel.create and the auto-created agent shelf.
 *
 * Stored Settings ▸ Carrel knobs are the DEFAULTS for a new desk — folded into
 * THIS desk only (existing desks keep their per-desk carrel.set tweaks); an
 * explicit radius wins over the stored one. The desk lands ON the camera's view
 * ray — where you're looking, not a floor projection of it (which parked the
 * desk at y=0 far below an elevated gaze, reading tiny-in-the-distance). The
 * tabletop sits half a slot below the ray point so row 0 rises into your gaze;
 * it never sinks below the world floor. Doorway (local +z) turns back toward
 * the viewer. Registered (type 'carrel') so the camera's dynamic-speed /
 * soft-bounds / fit-all spine (getSurfaces) sees it — a desk is a PLACE, not
 * cargo; resolveSurface refuses to treat it as one.
 * @returns {Carrel}
 */
function buildCarrel(ctx, name, { radius } = {}) {
    const carrel = new Carrel({ name });
    for (const k of CARREL_KNOBS) {
        const v = getSetting(`carrel.${k}`);
        if (Number.isFinite(v)) carrel.setParam(k, v);
    }
    if (Number.isFinite(radius)) carrel.setParam('radius', radius);

    const cam = ctx.camera;
    if (cam) {
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
        const dist = carrel.radius * 1.6;
        const p = new THREE.Vector3().copy(cam.position).addScaledVector(fwd, dist);
        carrel.position.set(p.x, Math.max(p.y - carrel.boxH * 0.5, 0), p.z);
        carrel.rotation.y = Math.atan2(cam.position.x - p.x, cam.position.z - p.z);
    }

    ctx.scene.add(carrel);
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
 * restore manifest will seat as windows materialize.
 * @param {Object} ctx
 * @param {{name:string, position?:{x,y,z}, yaw?:number, params?:Object, members?:Array}} saved
 * @returns {Carrel|null}
 */
export function restoreCarrel(ctx, saved) {
    const map = carrels(ctx);
    if (!map || !ctx.scene || !saved?.name) return null;
    if (map.has(saved.name)) return map.get(saved.name);
    const carrel = new Carrel({ name: saved.name, ...(saved.params || {}) });
    const p = saved.position || {};
    carrel.position.set(p.x || 0, p.y || 0, p.z || 0);
    carrel.rotation.y = Number(saved.yaw) || 0;
    ctx.scene.add(carrel);
    ctx.registry?.register?.(`carrel:${saved.name}`, carrel, { type: 'carrel' });
    map.set(saved.name, carrel);
    carrel.expect((saved.members || []).length);
    return carrel;
}

/**
 * The carrel sweep — two passes, deferred one macrotask and coalesced (AgentBooks
 * fires onChange mid-mutation, and session restore pins books right AFTER the
 * hydrate that announces them; the sweep runs after the current job settles).
 *
 * 1. MANIFEST (restored membership): ids the saved desks claim seat at their
 *    recorded desk the moment they materialize — immediately (load-is-not-replay:
 *    a rebuilt desk re-seats its members in place, nothing flies), order threaded
 *    through, cluster pins irrelevant (explicit membership outranks them). Claims
 *    are consumed on seat and otherwise persist as residence memory: a window
 *    reopened much later still comes home to its desk.
 * 2. AUTO-SHELF (the default residence): every NEW agent book seats at the
 *    'agents' desk, a grid-mode desk auto-created on first need. Once per lane
 *    BIRTH, never a leash — released/re-seated/docked/pinned books stay where the
 *    user put them. Settings ▸ Agent Books `book.autoShelf` off disarms this pass.
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
 *  end of restore to catch members that landed after the final change event). */
export function carrelSweep(ctx) {
    const map = carrels(ctx);
    if (!map || !ctx.scene) return;
    serveManifest(ctx, map);
    autoShelf(ctx, map);
}

/** Pass 1 — seat manifest-claimed ids at their recorded desks. @see scheduleCarrelSweep */
function serveManifest(ctx, map) {
    const manifest = ctx.carrelManifest;
    if (!(manifest instanceof Map) || !manifest.size) return;
    for (const [id, claim] of [...manifest.entries()]) {
        const desk = map.get(claim.name);
        if (!desk || desk._dissolving) { manifest.delete(id); continue; }
        if (desk.has(id)) { manifest.delete(id); continue; }
        if (ctx.cameraDock?.has?.(id)) { manifest.delete(id); continue; }   // riding — the dock holds it
        const r = resolveHostable(ctx, id);
        if (!r) continue;   // not materialized yet — a later change re-offers
        const prev = findCarrelOwner(ctx, r.id);
        if (prev && prev !== desk) prev.release(r.id);
        if (desk.lock(r.id, r.grid, { order: claim.order, immediate: true })) {
            setFact(ctx, r.id, { name: desk.carrelName, order: desk.entries.get(r.id).order }, r.kind);
            (ctx._agentShelfSeen ??= new Set()).add(r.id);   // the default pass never re-offers
        }
        manifest.delete(id);
    }
}

/** Pass 2 — the agents-shelf default for unclaimed newcomers. @see scheduleCarrelSweep */
function autoShelf(ctx, map) {
    const lanes = ctx.agentBooks?.lanes;
    if (!lanes) return;
    const seen = (ctx._agentShelfSeen ??= new Set());
    for (const id of [...seen]) if (!lanes.has(id)) seen.delete(id);   // cleared books may be reborn
    if (getSetting('book.autoShelf') === false) return;

    const manifest = ctx.carrelManifest;
    const newcomers = [...lanes.entries()].filter(([id, lane]) =>
        !seen.has(id) && !manifest?.has?.(id) && !lane.pinned
        && !ctx.cameraDock?.has?.(id) && !findCarrelOwner(ctx, id));
    if (!newcomers.length) return;

    const shelf = map.get(AGENT_SHELF) ?? (() => {
        const c = buildCarrel(ctx, AGENT_SHELF);
        c.setMode('grid');
        return c;
    })();
    if (shelf._dissolving) return;   // folding — the newcomers keep their cluster spots

    for (const [id, lane] of newcomers) {
        seen.add(id);
        if (shelf.lock(id, lane.book)) {
            setFact(ctx, id, { name: AGENT_SHELF, order: shelf.entries.get(id).order }, 'agent-book');
        }
    }
}

/**
 * @param {import('../CommandRouter.js').default} router
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
        const r = resolveHostable(ctx, idArg);
        if (!r) return { text: `ERR: nothing hostable for "${idArg}" (registry id, surface index, or agent id)`, data: null };
        if (carrel.has(r.id)) return { text: `OK: '${r.id}' already seated at '${carrel.carrelName}'`, data: { id: r.id, carrel: carrel.carrelName } };

        // Occupancy handoff: never capture a vehicle (the dock) or another residence's
        // slot pose as "home" — adopt the CURRENT holder's home record instead.
        let home = null;
        if (ctx.cameraDock?.has?.(r.id)) {
            home = ctx.cameraDock.homeOf(r.id);
            ctx.workspace?.setSurfaceView?.(r.id, undefined, { docked: false });
            ctx.cameraDock.release(r.id);
        } else {
            const prev = findCarrelOwner(ctx, r.id);
            if (prev) {
                home = prev.homeOf(r.id);
                prev.release(r.id);
            }
        }

        if (!carrel.lock(r.id, r.grid, home ? { home } : {})) {
            return { text: `ERR: could not seat '${r.id}'`, data: null };
        }
        setFact(ctx, r.id, { name: carrel.carrelName, order: carrel.entries.get(r.id).order }, r.kind);
        // Name the species in the receipt: a driver seating "books" by bare
        // index will read `seated terminal 'term-9'` and catch itself.
        const kindTag = r.kind ? `${r.kind} ` : '';
        return { text: `OK: seated ${kindTag}'${r.id}' at '${carrel.carrelName}'`, data: { id: r.id, kind: r.kind ?? null, carrel: carrel.carrelName } };
    }, { description: 'Seat a surface or agent book at a carrel (default: the active one); docked windows hand over cleanly', usage: '<id|index|agent> [carrel]', returns: '{ id, carrel }' });

    router.register('carrel.release', (args, ctx) => {
        const r = resolveSurface(ctx, args[0]);
        const id = r?.id ?? String(args[0] ?? '');
        const owner = unseat(ctx, id);
        if (!owner) return { text: `ERR: '${id}' is not seated at any carrel`, data: null };
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
        for (const m of members) setFact(ctx, m.id, null);
        ctx.registry?.unregister?.(`carrel:${carrel.carrelName}`); // out of the world spine now
        carrel.dissolve(); // members slide home; the runner sweeps the desk once drained
        if (ctx.activeCarrel === carrel.carrelName) ctx.activeCarrel = null;
        return { text: `OK: carrel '${carrel.carrelName}' dissolving (${members.length} member(s) sent home)`, data: { name: carrel.carrelName, released: members.length } };
    }, { description: 'Fold a carrel: every member slides home, then the desk vanishes', usage: '<name>', returns: '{ name, released }' });

    router.register('carrel.move', (args, ctx) => {
        const carrel = findCarrel(ctx, args[0]);
        if (!carrel) return { text: `ERR: no carrel '${args[0] ?? ''}'`, data: null };
        const [x, y, z] = [parseFloat(args[1]), parseFloat(args[2]), parseFloat(args[3])];
        if (![x, y, z].every(Number.isFinite)) return { text: 'ERR: usage: carrel.move <name> <x> <y> <z>', data: null };
        carrel.position.set(x, y, z);
        return { text: `OK: carrel '${carrel.carrelName}' → (${x}, ${y}, ${z})`, data: { name: carrel.carrelName, position: { x, y, z } } };
    }, { description: 'Move a carrel to a world position (members ride along)', usage: '<name> <x> <y> <z>', returns: '{ name, position }' });

    router.register('carrel.set', (args, ctx) => {
        const carrel = findCarrel(ctx, args[0]);
        if (!carrel) return { text: `ERR: no carrel '${args[0] ?? ''}'`, data: null };
        const key = String(args[1] ?? '');
        if (key === 'facing') {
            const f = String(args[2] ?? '');
            if (!carrel.setFacing(f)) return { text: 'ERR: carrel.set <name> facing <in|out>', data: null };
            return { text: `OK: carrel '${carrel.carrelName}' facing ${f}`, data: { name: carrel.carrelName, key, value: f } };
        }
        if (key === 'mode') {
            const m = String(args[2] ?? '');
            if (!carrel.setMode(m)) return { text: 'ERR: carrel.set <name> mode <ring|grid>', data: null };
            return { text: `OK: carrel '${carrel.carrelName}' mode ${m}`, data: { name: carrel.carrelName, key, value: m } };
        }
        const value = parseFloat(args[2]);
        if (!carrel.setParam(key, value)) {
            return { text: 'ERR: usage: carrel.set <name> <radius|boxH|boxAspect|gapFrac|maxArcDeg|tableFrac|shadowSoft|glowStrength|animDur|yawRate|mode|facing> <value>', data: null };
        }
        return { text: `OK: carrel '${carrel.carrelName}' ${key} = ${value}`, data: { name: carrel.carrelName, key, value } };
    }, { description: 'Tune a carrel layout/chrome parameter live', usage: '<name> <param> <value>', returns: '{ name, key, value }' });
}

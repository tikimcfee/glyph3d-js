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
 */

import * as THREE from 'three';
import Carrel from '@glyph3d/core/services/interaction/Carrel.js';
import { resolveSurface } from './dockCommands.js';
import { getSetting } from '../../client/settings.js';

/** The knobs Settings ▸ Carrel stores — folded into a NEW desk at birth. */
const CARREL_KNOBS = ['radius', 'boxH', 'boxAspect', 'gapFrac', 'growCap', 'maxArcDeg',
                      'tableFrac', 'auraHeadroom', 'glowStrength'];

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
        const carrel = new Carrel({ name });
        // Stored Settings ▸ Carrel knobs are the DEFAULTS for a new desk — folded into
        // THIS desk only (existing desks keep their per-desk carrel.set tweaks). An
        // explicit radius argument wins over the stored one.
        for (const k of CARREL_KNOBS) {
            const v = getSetting(`carrel.${k}`);
            if (Number.isFinite(v)) carrel.setParam(k, v);
        }
        const radius = parseFloat(args[1]);
        if (Number.isFinite(radius)) carrel.setParam('radius', radius);

        // Set the desk down ON the camera's view ray — where you're looking, not a
        // floor projection of it (which parked the desk at y=0 far below an elevated
        // gaze, reading tiny-in-the-distance). The tabletop sits half a slot below
        // the ray point so row 0 rises into your gaze; it never sinks below the
        // world floor. Doorway (local +z) turns back toward the viewer.
        const cam = ctx.camera;
        if (cam) {
            const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
            const dist = carrel.radius * 1.6;
            const p = new THREE.Vector3().copy(cam.position).addScaledVector(fwd, dist);
            carrel.position.set(p.x, Math.max(p.y - carrel.boxH * 0.5, 0), p.z);
            carrel.rotation.y = Math.atan2(cam.position.x - p.x, cam.position.z - p.z);
        }

        ctx.scene.add(carrel);
        // A desk is a world citizen: registered (type 'carrel') so the camera's
        // dynamic-speed / soft-bounds / fit-all spine (getSurfaces) sees it. It is
        // a PLACE, not cargo — resolveSurface refuses to treat it as one.
        ctx.registry?.register?.(`carrel:${name}`, carrel, { type: 'carrel' });
        map.set(name, carrel);
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
        const owner = findCarrelOwner(ctx, id);
        if (!owner) return { text: `ERR: '${id}' is not seated at any carrel`, data: null };
        setFact(ctx, id, null);
        owner.release(id);
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
        const value = parseFloat(args[2]);
        if (!carrel.setParam(key, value)) {
            return { text: 'ERR: usage: carrel.set <name> <radius|boxH|boxAspect|gapFrac|maxArcDeg|tableFrac|auraHeadroom|glowStrength|animDur|yawRate|facing> <value>', data: null };
        }
        return { text: `OK: carrel '${carrel.carrelName}' ${key} = ${value}`, data: { name: carrel.carrelName, key, value } };
    }, { description: 'Tune a carrel layout/chrome parameter live', usage: '<name> <param> <value>', returns: '{ name, key, value }' });
}

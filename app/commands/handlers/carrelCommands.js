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

/** The carrel currently holding a surface id, or null. */
function findOwner(ctx, id) {
    const map = carrels(ctx);
    if (!map) return null;
    for (const c of map.values()) if (c.has(id)) return c;
    return null;
}

/** Record (or clear, with null) the carrel view fact for a surface. */
function setFact(ctx, id, value) {
    ctx.workspace?.setSurfaceView?.(id, ctx.registry?.get?.(id)?.type, { carrel: value });
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
        const radius = parseFloat(args[1]);
        const carrel = new Carrel({ name, ...(Number.isFinite(radius) ? { radius } : {}) });

        // Set the desk down ahead of the camera, ON the world floor, its doorway
        // (local +z) turned back toward the viewer — you're looking into it.
        const cam = ctx.camera;
        if (cam) {
            const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
            fwd.y = 0;
            if (fwd.lengthSq() < 1e-9) fwd.set(0, 0, -1); // looking straight down: pick a side
            fwd.normalize();
            const dist = carrel.radius * 2.2;
            carrel.position.set(cam.position.x + fwd.x * dist, 0, cam.position.z + fwd.z * dist);
            carrel.rotation.y = Math.atan2(cam.position.x - carrel.position.x,
                                           cam.position.z - carrel.position.z);
        }

        ctx.scene.add(carrel);
        map.set(name, carrel);
        ctx.activeCarrel = name;
        return { text: `OK: carrel '${name}' set down (r=${carrel.radius})`, data: { name, radius: carrel.radius } };
    }, { description: 'Set down a new carrel (world-anchored desk) ahead of the camera', usage: '[name] [radius]', returns: '{ name, radius }' });

    router.register('carrel.add', (args, ctx) => {
        const carrel = findCarrel(ctx, args[1]);
        if (!carrel) return { text: 'ERR: no carrel (carrel.create first)', data: null };
        const r = resolveSurface(ctx, args[0]);
        if (!r) return { text: `ERR: no surface for "${args[0]}" (registry id or surface index)`, data: null };
        if (carrel.has(r.id)) return { text: `OK: '${r.id}' already seated at '${carrel.carrelName}'`, data: { id: r.id, carrel: carrel.carrelName } };

        // Occupancy handoff: never capture a vehicle (the dock) or another residence's
        // slot pose as "home" — adopt the CURRENT holder's home record instead.
        let home = null;
        if (ctx.cameraDock?.has?.(r.id)) {
            home = ctx.cameraDock.homeOf(r.id);
            ctx.workspace?.setSurfaceView?.(r.id, undefined, { docked: false });
            ctx.cameraDock.release(r.id);
        } else {
            const prev = findOwner(ctx, r.id);
            if (prev) {
                home = prev.homeOf(r.id);
                prev.release(r.id);
            }
        }

        if (!carrel.lock(r.id, r.grid, home ? { home } : {})) {
            return { text: `ERR: could not seat '${r.id}'`, data: null };
        }
        setFact(ctx, r.id, { name: carrel.carrelName, order: carrel.entries.get(r.id).order });
        return { text: `OK: seated '${r.id}' at '${carrel.carrelName}'`, data: { id: r.id, carrel: carrel.carrelName } };
    }, { description: 'Seat a surface at a carrel (default: the active one); docked windows hand over cleanly', usage: '<id|index> [carrel]', returns: '{ id, carrel }' });

    router.register('carrel.release', (args, ctx) => {
        const r = resolveSurface(ctx, args[0]);
        const id = r?.id ?? String(args[0] ?? '');
        const owner = findOwner(ctx, id);
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

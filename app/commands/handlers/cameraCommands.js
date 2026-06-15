/**
 * Camera commands: camera.move, camera.lookat, camera.focus, camera.reset, camera.speed, camera.info
 * camera.focus uses resolveGridByIdOrIndex + filename substring fallback.
 */

import * as THREE from 'three';
import { box, kvLines } from '../formatResponse.js';
import { resolveGridByIdOrIndex } from './spatialHelpers.js';

/**
 * Point the camera at a world point AND sync the controller's pitch/yaw. lookAt() writes the
 * quaternion, but VCC's per-frame _applyRotation rebuilds it from pitch/yaw (YXZ) and would
 * stomp the aim next frame — so extract pitch/yaw from the lookAt quaternion and write them
 * back. The only correct way to aim this camera. Shared by camera.aim + camera.lookat.
 */
function aimCameraAt(cc, cam, x, y, z) {
    cam.lookAt(x, y, z);
    const euler = new THREE.Euler(0, 0, 0, 'YXZ');
    euler.setFromQuaternion(cam.quaternion);
    cc.pitch = euler.x;
    cc.yaw = euler.y;
}

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerCameraCommands(router) {
    router.register('camera.move', (args, ctx) => {
        if (args.length < 3) return { text: 'ERR: usage: camera.move <x> <y> <z>', data: null };
        const [x, y, z] = args.map(Number);
        if ([x, y, z].some(isNaN)) return { text: 'ERR: x, y, z must be numbers', data: null };
        ctx.camera.position.set(x, y, z);
        return {
            text: `OK: camera moved to ${x}, ${y}, ${z}`,
            data: { x, y, z }
        };
    }, { description: 'Set camera position', usage: '<x> <y> <z>' });

    router.register('camera.lookat', (args, ctx) => {
        if (args.length < 3) return { text: 'ERR: usage: camera.lookat <x> <y> <z>', data: null };
        const [x, y, z] = args.map(Number);
        if ([x, y, z].some(isNaN)) return { text: 'ERR: x, y, z must be numbers', data: null };
        const cc = ctx.cameraController;
        if (!cc) return { text: 'ERR: no camera controller', data: null };
        // Persist the aim through pitch/yaw — a bare camera.lookAt is stomped next frame.
        aimCameraAt(cc, ctx.camera, x, y, z);
        return {
            text: `OK: camera looking at ${x}, ${y}, ${z}`,
            data: { x, y, z }
        };
    }, { description: 'Point camera at position', usage: '<x> <y> <z>' });

    router.register('camera.focus', (args, ctx) => {
        if (args.length < 1) return { text: 'ERR: usage: camera.focus <index|id|name>', data: null };
        const target = args.join(' ');
        const grids = ctx.getGrids();

        // Index, registry ID, or name/path — one resolver, declared fallback chain.
        const resolved = resolveGridByIdOrIndex(ctx, target, 'grid', { byName: true });
        if (resolved.error) return { text: `ERR: no grid matching '${target}'`, data: null };

        const idx = resolved.idx >= 0 ? resolved.idx : grids.indexOf(resolved.grid);
        let framed = false;
        if (idx >= 0) {
            ctx.cameraController.focusOnGrid(idx);
            if (ctx.spatialNav) ctx.spatialNav.focusGrid(idx, false);
            framed = true;
        } else if (resolved.grid) {
            // A non-grid window (e.g. a terminal): frame it by its world bounds. Terminals aren't
            // in getGrids('grid') so focusOnGrid can't reach them, but they carry getBounds, and
            // terminal.focus deliberately leaves framing to camera.focus. One focus verb, any window.
            framed = !!ctx.cameraController.focusOnObject?.(resolved.grid);
        }
        if (!framed) return { text: `ERR: resolved "${target}" but could not frame it`, data: null };
        const label = resolved.registryId || grids[idx]?.getFilename?.() || `#${idx}`;
        return {
            text: `OK: focusing on "${label}"`,
            data: { index: idx, registryId: resolved.registryId }
        };
    }, { description: 'Focus camera on grid by index, registry ID, or name', usage: '<index|id|name>' });

    router.register('camera.reset', (args, ctx) => {
        ctx.cameraController.reset();
        return { text: 'OK: camera reset', data: null };
    }, { description: 'Reset camera to default position' });

    router.register('camera.lock', (args, ctx) => {
        const cc = ctx.cameraController;
        if (!cc || typeof cc.setLocked !== 'function') return { text: 'ERR: camera controller not ready', data: null };
        const cur = cc.isLocked?.() ?? false;
        const arg = (args[0] || 'toggle').toLowerCase();
        const next = (arg === 'on' || arg === 'true' || arg === '1') ? true
                   : (arg === 'off' || arg === 'false' || arg === '0') ? false
                   : !cur;  // toggle (default / any other arg)
        cc.setLocked(next);
        return { text: `OK: camera ${next ? 'locked' : 'unlocked'}`, data: { locked: next } };
    }, { description: 'Freeze/unfreeze camera motion (the wheel still scrolls a focused framed grid)', usage: '[on|off|toggle]' });

    router.register('camera.speed', (args, ctx) => {
        if (args.length < 1) return { text: 'ERR: usage: camera.speed <value>', data: null };
        const speed = parseFloat(args[0]);
        if (isNaN(speed)) return { text: 'ERR: speed must be a number', data: null };
        ctx.cameraController.setSpeed(speed);
        return {
            text: `OK: camera speed set to ${speed}`,
            data: { speed }
        };
    }, { description: 'Set camera movement speed', usage: '<value>' });

    router.register('camera.info', (args, ctx) => {
        const cam = ctx.camera;
        const pos = cam.position;
        const rot = cam.rotation;
        const data = {
            'position': `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`,
            'rotation': `${rot.x.toFixed(2)}, ${rot.y.toFixed(2)}, ${rot.z.toFixed(2)}`,
            'fov': `${cam.fov}`,
            'near/far': `${cam.near} / ${cam.far}`,
        };
        if (ctx.cameraController) {
            data['speed'] = String(ctx.cameraController.cameraSpeed || 'N/A');
        }
        return {
            text: box('CAMERA', kvLines(data), 50) + '\nOK: camera info',
            data: {
                position: { x: pos.x, y: pos.y, z: pos.z },
                rotation: { x: rot.x, y: rot.y, z: rot.z },
                fov: cam.fov,
            }
        };
    }, { description: 'Show camera details' });

    router.register('camera.fitall', (args, ctx) => {
        // Cancel any in-flight camera animation
        ctx._cancelCameraAnimation?.();
        ctx.cameraController.focusOnGrids();
        return { text: 'OK: fitting all grids in view', data: null };
    }, { description: 'Fit all grids in camera view' });

    // ---- Debug/test: drive the camera through the same internal functions
    // the real input pipeline uses, from the WebSocket. Used by llm-exp's
    // camera-sim loop for iterating on zoom/orbit feel.

    router.register('camera.aim', (args, ctx) => {
        if (args.length < 3) return { text: 'ERR: usage: camera.aim <x> <y> <z>', data: null };
        const [tx, ty, tz] = args.map(Number);
        if ([tx, ty, tz].some(isNaN)) return { text: 'ERR: x, y, z must be numbers', data: null };
        const cc = ctx.cameraController;
        if (!cc) return { text: 'ERR: no camera controller', data: null };
        aimCameraAt(cc, ctx.camera, tx, ty, tz);
        return { text: `OK: aimed at ${tx}, ${ty}, ${tz}`, data: { pitch: cc.pitch, yaw: cc.yaw } };
    }, { description: 'Aim camera at a world point (persists: syncs pitch/yaw)', usage: '<x> <y> <z>' });

    router.register('camera.attend', (args, ctx) => {
        if (args.length < 1) return { text: 'ERR: usage: camera.attend <id|none>', data: null };
        const id = args[0] === 'none' ? null : args[0];

        // Routes through AttentionManager — the single writer for the
        // primary slot. Equivalent to `attention.set primary <id>`; the
        // verb name is kept because it's the historical handle.
        ctx.attentionManager.set('primary', id,
            { entity: id ? ctx.registry?.get?.(id) || null : null });

        return {
            text: `OK: attended = ${id ?? 'none'}`,
            data: { primaryId: id },
        };
    }, { description: 'Manually set the primary attention target (drives billboard attention blend)', usage: '<id|none>' });

    router.register('camera.sim', (args, ctx) => {
        if (args.length < 1) return { text: 'ERR: usage: camera.sim <dolly|look|pan> <args>', data: null };
        const cc = ctx.cameraController;
        if (!cc) return { text: 'ERR: no camera controller', data: null };
        const action = args[0];
        if (action === 'dolly') {
            const dy = Number(args[1]);
            if (isNaN(dy)) return { text: 'ERR: camera.sim dolly <deltaY>', data: null };
            cc._zoomBy(dy);
        } else if (action === 'look') {
            const dx = Number(args[1]), dy = Number(args[2]);
            if (isNaN(dx) || isNaN(dy)) return { text: 'ERR: camera.sim look <dx> <dy>', data: null };
            cc._lookBy(dx, dy);
        } else if (action === 'pan') {
            const dx = Number(args[1]), dy = Number(args[2]);
            if (isNaN(dx) || isNaN(dy)) return { text: 'ERR: camera.sim pan <dx> <dy>', data: null };
            cc._panBy(dx, dy);
        } else {
            return { text: `ERR: unknown action '${action}' (dolly|look|pan)`, data: null };
        }
        // Push the resulting rotation into the camera now (look sets pitch/yaw;
        // applyCamera would pick it up next frame, but we want it visible in an
        // immediate screenshot).
        cc._applyRotation?.();
        const p = ctx.camera.position;
        return {
            text: `OK: ${action} applied; cam at ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`,
            data: { position: { x: p.x, y: p.y, z: p.z } }
        };
    }, { description: 'Simulate camera input', usage: 'dolly <dy> | look <dx> <dy> | pan <dx> <dy>' });
}

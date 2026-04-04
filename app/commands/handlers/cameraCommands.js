/**
 * Camera commands: camera.move, camera.lookat, camera.focus, camera.reset, camera.speed, camera.info
 * camera.focus uses resolveGridByIdOrIndex + filename substring fallback.
 */

import { box, kvLines } from '../formatResponse.js';
import { resolveGridByIdOrIndex } from './spatialHelpers.js';

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
        ctx.camera.lookAt(x, y, z);
        return {
            text: `OK: camera looking at ${x}, ${y}, ${z}`,
            data: { x, y, z }
        };
    }, { description: 'Point camera at position', usage: '<x> <y> <z>' });

    router.register('camera.focus', (args, ctx) => {
        if (args.length < 1) return { text: 'ERR: usage: camera.focus <index|id|name>', data: null };
        const target = args.join(' ');
        const grids = ctx.getGrids();

        // Steps 1-2: try numeric index, then registry ID (via resolveGridByIdOrIndex)
        const resolved = resolveGridByIdOrIndex(ctx, target);
        if (!resolved.error) {
            const regIdx = resolved.idx >= 0 ? resolved.idx : grids.indexOf(resolved.grid);
            if (regIdx >= 0) {
                ctx.cameraController.focusOnGrid(regIdx);
                if (ctx.spatialNav) ctx.spatialNav.focusGrid(regIdx, false);
            }
            const label = resolved.registryId || `#${regIdx}`;
            return {
                text: `OK: focusing on "${label}"`,
                data: { index: regIdx, registryId: resolved.registryId }
            };
        }

        // Step 3: filename substring fallback
        const matchIdx = grids.findIndex(g => {
            const name = g.getFilename() || g.getSourcePath() || '';
            return name.toLowerCase().includes(target.toLowerCase());
        });
        if (matchIdx >= 0) {
            ctx.cameraController.focusOnGrid(matchIdx);
            if (ctx.spatialNav) ctx.spatialNav.focusGrid(matchIdx, false);
            const name = grids[matchIdx].getFilename();
            return {
                text: `OK: focusing on grid ${matchIdx} (${name})`,
                data: { index: matchIdx, name }
            };
        }

        return { text: `ERR: no grid matching '${target}'`, data: null };
    }, { description: 'Focus camera on grid by index, registry ID, or name', usage: '<index|id|name>' });

    router.register('camera.reset', (args, ctx) => {
        ctx.cameraController.reset();
        return { text: 'OK: camera reset', data: null };
    }, { description: 'Reset camera to default position' });

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
}

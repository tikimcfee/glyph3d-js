/**
 * Window commands: window.create, window.write, window.append,
 * window.clear, window.close, window.list, window.move, window.scale
 *
 * Backed by AgentGrid — a thin CodeGrid wrapper with identity and append I/O.
 * Content args use base64 encoding (decodeBase64) matching the grid.* pattern.
 */

import * as THREE from 'three';
import AgentGrid from '../../../src/collections/AgentGrid.js';
import { decodeBase64 } from '../../../src/utils/encoding.js';

// Tunable: seconds to reach ~63% of target weight (1 - 1/e). Smaller =
// snappier attention response, larger = calmer/more inertial.
const ATTENTION_TAU = 0.25;

/**
 * Framerate-independent exponential easing. Returns the new eased value.
 * Same shape as MRTK's Solver.SmoothTo for scalars.
 */
function easeTo(current, target, dt, tau) {
    if (tau <= 0) return target;
    const a = 1 - Math.exp(-dt / tau);
    return current + (target - current) * a;
}

// Scratch objects reused across billboard updates to avoid per-frame GC.
const _scratchQuatYaw = new THREE.Quaternion();
const _scratchQuatCam = new THREE.Quaternion();
const _scratchEulerYaw = new THREE.Euler(0, 0, 0, 'YXZ');
const _scratchOffset = new THREE.Vector3();
const _scratchDir = new THREE.Vector3();
const _scratchRight = new THREE.Vector3();
const _scratchUp = new THREE.Vector3();
const _scratchBasis = new THREE.Matrix4();
const _WORLD_UP = new THREE.Vector3(0, 1, 0);

// Agent grid registry: Map<string, AgentGrid>
// Lazily created on ctx so it persists across command calls.

/** Auto-position state for stacking agent grids. */
const _autoPos = { x: -100, y: 50, spacing: 30 };

function getOrCreateWindows(ctx) {
    if (!ctx._agentGrids) ctx._agentGrids = new Map();
    return ctx._agentGrids;
}

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerWindowCommands(router) {

    router.register('window.create', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: window.create <id> [cols] [rows] [title] [--scale N]', data: null };
        }

        const windows = getOrCreateWindows(ctx);

        // Parse flags
        let scale = 2.0;
        const cleanArgs = [];
        for (let i = 0; i < args.length; i++) {
            if (args[i] === '--scale' && args[i + 1]) {
                scale = parseFloat(args[++i]);
                if (isNaN(scale)) scale = 2.0;
            } else {
                cleanArgs.push(args[i]);
            }
        }

        const id = cleanArgs[0];
        const title = cleanArgs[3] || id;

        if (windows.has(id)) {
            return { text: `ERR: window '${id}' already exists`, data: null };
        }

        // Auto-position
        const position = { x: _autoPos.x, y: _autoPos.y, z: 0 };
        _autoPos.y -= _autoPos.spacing;
        if (_autoPos.y < -150) {
            _autoPos.y = 50;
            _autoPos.x += 80;
        }

        const agentGrid = new AgentGrid(id, ctx.scene, ctx.atlas, {
            title, scale, position,
        });

        windows.set(id, agentGrid);

        // Register in scene registry
        ctx.registry.register(id, agentGrid.grid, {
            type: 'agent',
            agentId: id,
            title,
        });

        const pos = agentGrid.getPosition();
        return {
            text: `OK: window '${id}' created at (${pos.x},${pos.y},${pos.z})`,
            data: { id, title, position: pos },
        };
    }, { description: 'Create an agent window', usage: '<id> [cols] [rows] [title] [--scale N]' });

    router.register('window.write', (args, ctx) => {
        if (args.length < 2) {
            return { text: 'ERR: usage: window.write <id> <base64-text>', data: null };
        }
        const windows = getOrCreateWindows(ctx);
        const ag = windows.get(args[0]);
        if (!ag) return { text: `ERR: no window '${args[0]}'`, data: null };

        let text;
        try { text = decodeBase64(args[1]); } catch { return { text: 'ERR: invalid base64', data: null }; }

        ag.write(text);
        return {
            text: `OK: window '${args[0]}' written (${ag.historyLength} lines)`,
            data: { id: args[0], historyLines: ag.historyLength },
        };
    }, { description: 'Replace window content', usage: '<id> <base64-text>' });

    router.register('window.append', (args, ctx) => {
        if (args.length < 2) {
            return { text: 'ERR: usage: window.append <id> <base64-text>', data: null };
        }
        const windows = getOrCreateWindows(ctx);
        const ag = windows.get(args[0]);
        if (!ag) return { text: `ERR: no window '${args[0]}'`, data: null };

        let text;
        try { text = decodeBase64(args[1]); } catch { return { text: 'ERR: invalid base64', data: null }; }

        ag.appendLine(text);
        return {
            text: `OK: window '${args[0]}' appended (${ag.historyLength} lines)`,
            data: { id: args[0], historyLines: ag.historyLength },
        };
    }, { description: 'Append text to window', usage: '<id> <base64-text>' });

    router.register('window.clear', (args, ctx) => {
        if (args.length < 1) return { text: 'ERR: usage: window.clear <id>', data: null };
        const windows = getOrCreateWindows(ctx);
        const ag = windows.get(args[0]);
        if (!ag) return { text: `ERR: no window '${args[0]}'`, data: null };
        ag.clear();
        return { text: `OK: window '${args[0]}' cleared`, data: { id: args[0] } };
    }, { description: 'Clear window content', usage: '<id>' });

    router.register('window.close', (args, ctx) => {
        if (args.length < 1) return { text: 'ERR: usage: window.close <id>', data: null };
        const windows = getOrCreateWindows(ctx);
        const ag = windows.get(args[0]);
        if (!ag) return { text: `ERR: no window '${args[0]}'`, data: null };
        ag.dispose();
        windows.delete(args[0]);
        ctx.registry.unregister(args[0]);
        return { text: `OK: window '${args[0]}' closed`, data: { id: args[0] } };
    }, { description: 'Close and dispose a window', usage: '<id>' });

    router.register('window.debug', (args, ctx) => {
        if (args.length < 1) return { text: 'ERR: usage: window.debug <id>', data: null };
        const windows = getOrCreateWindows(ctx);
        const ag = windows.get(args[0]);
        if (!ag) return { text: `ERR: no window '${args[0]}'`, data: null };
        const g = ag.grid;
        const q = g.quaternion;
        const b = typeof g.getContentBounds === 'function' ? g.getContentBounds() : null;
        return {
            text: `OK: ${args[0]} debug`,
            data: {
                pos: { x: g.position.x, y: g.position.y, z: g.position.z },
                quat: { x: q.x, y: q.y, z: q.z, w: q.w },
                eulerXYZ: { x: g.rotation.x, y: g.rotation.y, z: g.rotation.z },
                billboardTarget: ag._billboardTarget
                    ? { x: ag._billboardTarget.x, y: ag._billboardTarget.y, z: ag._billboardTarget.z }
                    : null,
                attentionWeight: ag._attentionWeight,
                bounds: b && b.min && b.max ? {
                    min: { x: b.min.x, y: b.min.y, z: b.min.z },
                    max: { x: b.max.x, y: b.max.y, z: b.max.z },
                } : null,
            },
        };
    }, { description: 'Dump AgentGrid diagnostic state', usage: '<id>' });

    router.register('window.list', (args, ctx) => {
        const windows = getOrCreateWindows(ctx);
        if (windows.size === 0) {
            return { text: 'OK: 0 windows', data: { windows: [], count: 0 } };
        }
        const list = [];
        for (const [id, ag] of windows) {
            list.push({
                id,
                title: ag.title,
                position: ag.getPosition(),
                historyLines: ag.historyLength,
            });
        }
        const lines = list.map(w =>
            `  ${w.id}: "${w.title}" (${w.historyLines} lines)`
        );
        return {
            text: lines.join('\n') + `\nOK: ${list.length} windows`,
            data: { windows: list, count: list.length },
        };
    }, { description: 'List all agent windows' });

    router.register('window.move', (args, ctx) => {
        if (args.length < 4) {
            return { text: 'ERR: usage: window.move <id> <x> <y> <z>', data: null };
        }
        const windows = getOrCreateWindows(ctx);
        const ag = windows.get(args[0]);
        if (!ag) return { text: `ERR: no window '${args[0]}'`, data: null };
        const [x, y, z] = args.slice(1, 4).map(Number);
        if ([x, y, z].some(isNaN)) return { text: 'ERR: x,y,z must be numbers', data: null };
        ag.setPosition(x, y, z);
        // Keep the billboard target in sync so rotation pivots around the
        // intended point, not the raw Object3D origin.
        setAgentTarget(ag, x, y, z);
        return {
            text: `OK: window '${args[0]}' moved to (${x},${y},${z})`,
            data: { id: args[0], position: { x, y, z } },
        };
    }, { description: 'Move window in 3D space', usage: '<id> <x> <y> <z>' });

    router.register('window.scale', (args, ctx) => {
        if (args.length < 2) {
            return { text: 'ERR: usage: window.scale <id> <factor>', data: null };
        }
        const windows = getOrCreateWindows(ctx);
        const ag = windows.get(args[0]);
        if (!ag) return { text: `ERR: no window '${args[0]}'`, data: null };
        const scale = parseFloat(args[1]);
        if (isNaN(scale) || scale <= 0) return { text: 'ERR: scale must be a positive number', data: null };
        ag.setScale(scale);
        return {
            text: `OK: window '${args[0]}' scale = ${scale}`,
            data: { id: args[0], scale },
        };
    }, { description: 'Set window scale', usage: '<id> <factor>' });

    router.register('window.billboard', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: window.billboard <id> [true|false]', data: null };
        }
        const windows = getOrCreateWindows(ctx);
        const ag = windows.get(args[0]);
        if (!ag) return { text: `ERR: no window '${args[0]}'`, data: null };
        // Default to true when flag is omitted; accept 'true'/'1'/'on'.
        const raw = (args[1] ?? 'true').toString().toLowerCase();
        const on = raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes';
        ag.billboard = on;
        return {
            text: `OK: window '${args[0]}' billboard = ${on}`,
            data: { id: args[0], billboard: on },
        };
    }, { description: 'Mark a window to face the camera each frame (Y-axis)', usage: '<id> [true|false]' });
}

/**
 * Per-frame updater: for every window with `.billboard = true`, rotate it
 * around its local Y so its visible content faces the camera — and shift
 * its position so the rotation pivot aligns with the *visible center*
 * rather than the CodeGrid's origin (which is at a content corner).
 *
 * Without the position compensation, spinning the yaw swings the rectangle
 * around a corner, so a window "in front of" the camera ends up showing its
 * face at an angle instead of straight-on. We:
 *   1. Treat `_billboardTarget` (world pos the user wanted the center at) as
 *      the logical anchor. window.create / window.move write this alongside
 *      setting `grid.position`.
 *   2. Compute yaw to aim the face from target → camera (XZ plane only, to
 *      keep text upright).
 *   3. Back out `grid.position = target − R(yaw) · contentCenterLocal`, so
 *      the visible center lands exactly at target after rotation.
 *
 * Mirrors the pattern NameplateManager uses, with the pivot correction.
 *
 * @param {import('../CommandRouter.js').CommandContext} ctx
 * @param {THREE.Camera} camera
 */
export function updateWindowBillboards(ctx, camera, deltaTime = 1 / 60) {
    if (!ctx._agentGrids) return;
    const attendedId = ctx.cameraController?.input?.focus?.attendedId ?? null;

    for (const ag of ctx._agentGrids.values()) {
        if (!ag.billboard || !ag.grid) continue;
        const grid = ag.grid;

        if (!ag._billboardTarget) {
            ag._billboardTarget = grid.position.clone();
        }
        const target = ag._billboardTarget;

        // Attention weight: 1.0 when this grid is the focus target (cursor
        // over it), 0.0 otherwise. Eased toward that with framerate-indep
        // damping so look-at-me / look-away transitions are smooth rather
        // than snap. Zero = world-anchored + yaw-only. One = full facing.
        if (ag._attentionWeight === undefined) ag._attentionWeight = 0;
        const targetK = (attendedId && attendedId === ag.id) ? 1 : 0;
        ag._attentionWeight = easeTo(ag._attentionWeight, targetK, deltaTime, ATTENTION_TAU);
        const k = ag._attentionWeight;

        // Content center in local space. Cheap — getContentBounds is cached
        // on the CodeGrid side and only recomputes when content changes.
        let cc = null;
        if (typeof grid.getContentBounds === 'function') {
            const b = grid.getContentBounds();
            if (b && b.min && b.max) {
                cc = { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 };
            }
        }

        // q_yaw: current yaw-only billboard — face camera on XZ plane only,
        // text stays upright regardless of camera pitch.
        const yaw = Math.atan2(camera.position.x - target.x, camera.position.z - target.z);
        _scratchEulerYaw.set(0, yaw, 0, 'YXZ');
        _scratchQuatYaw.setFromEuler(_scratchEulerYaw);

        // q_cam: align the grid's +Z face with target→camera while keeping
        // +Y aligned with world up so text stays level in the camera's eye.
        // Building the orthonormal basis explicitly (right/up/forward) and
        // feeding it to setFromRotationMatrix avoids the roll-ambiguity of
        // setFromUnitVectors, which only constrains the forward vector.
        _scratchDir.subVectors(camera.position, target).normalize();     // +Z
        _scratchRight.crossVectors(_WORLD_UP, _scratchDir).normalize();  // +X
        // Degenerate case: looking straight up/down, world-up is parallel
        // to forward. Fall back to the cheap alignment in that sliver so
        // the grid at least doesn't disappear.
        if (_scratchRight.lengthSq() < 1e-8) {
            _scratchQuatCam.setFromUnitVectors(
                new THREE.Vector3(0, 0, 1),
                _scratchDir
            );
        } else {
            _scratchUp.crossVectors(_scratchDir, _scratchRight);         // +Y
            _scratchBasis.makeBasis(_scratchRight, _scratchUp, _scratchDir);
            _scratchQuatCam.setFromRotationMatrix(_scratchBasis);
        }

        // Blend: 0 → yaw-only, 1 → full facing. Slerp keeps the rotation
        // smooth across the blend range (vs. Euler interpolation which
        // gimbal-locks near ±π/2).
        grid.quaternion.slerpQuaternions(_scratchQuatYaw, _scratchQuatCam, k);

        if (cc) {
            // Position compensation generalizes for any rotation: rotate the
            // local content-center offset by the final quaternion, then back
            // it out of the grid's position so the content-center lands at
            // `target` in world space after rotation.
            _scratchOffset.set(cc.x, cc.y, 0).applyQuaternion(grid.quaternion);
            grid.position.x = target.x - _scratchOffset.x;
            grid.position.y = target.y - _scratchOffset.y;
            grid.position.z = target.z - _scratchOffset.z;
        } else {
            grid.position.copy(target);
        }
    }
}

/** Helper: set/update the billboard target alongside a position change. */
function setAgentTarget(ag, x, y, z) {
    if (!ag) return;
    if (!ag._billboardTarget) {
        // Use the same THREE.Vector3 class the grid uses (avoid an import).
        ag._billboardTarget = ag.grid.position.clone();
    }
    ag._billboardTarget.set(x, y, z);
    // Also set raw position so non-billboard paths still work immediately.
    ag.grid.position.set(x, y, z);
}

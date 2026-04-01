/**
 * Shared spatial math helpers for geometry, composition, and navigation commands.
 * Pure functions -- no command router, no DOM, no side effects.
 *
 * Dependency graph:
 *   spatialHelpers.js          (this file, pure math)
 *       ^       ^       ^
 *       |       |       |
 *   spatialCommands  compositionCommands  navigationCommands
 */

import * as THREE from 'three';

// ──────────────────────────────────────────────────────────────
//  Grid Resolution
// ──────────────────────────────────────────────────────────────

/**
 * Validate a grid index from a raw string argument.
 * @param {Array} grids - array of CodeGrid instances
 * @param {string} arg - raw string index from command args
 * @param {string} [label='grid'] - label for error messages (e.g. 'source', 'target')
 * @returns {{ grid: Object, idx: number } | { error: string }}
 */
export function resolveGrid(grids, arg, label = 'grid') {
    const idx = parseInt(arg);
    if (isNaN(idx) || idx < 0 || idx >= grids.length) {
        return { error: `ERR: invalid ${label} index ${arg} (0-${grids.length - 1})` };
    }
    return { grid: grids[idx], idx };
}

/**
 * Resolve a grid by registry ID or array index.
 *
 * Integer-first rule: if arg is a pure digit string (/^\d+$/), treat as
 * numeric index first. Registry lookup only for args containing non-digit chars
 * (or when the integer index is out of range). This prevents ID "42" from
 * shadowing array index 42.
 *
 * @param {Object} ctx - command context bag (must have .registry and .getGrids)
 * @param {string} arg - registry ID or numeric index string
 * @param {string} [label='grid'] - label for error messages
 * @returns {{ grid: Object, idx: number, registryId: string|null } | { error: string }}
 */
export function resolveGridByIdOrIndex(ctx, arg, label = 'grid') {
    const grids = ctx.getGrids();
    const isPureInteger = /^\d+$/.test(arg);

    // 1. Pure integer -> numeric index first
    if (isPureInteger) {
        const idx = parseInt(arg);
        if (idx >= 0 && idx < grids.length) {
            const registryId = ctx.registry ? ctx.registry.getIdByGrid(grids[idx]) : null;
            return { grid: grids[idx], idx, registryId };
        }
        // Integer but out of range -- fall through to registry as last resort
        // (handles case where someone deliberately used a numeric registry ID)
    }

    // 2. Non-integer string (or out-of-range integer) -> registry lookup
    if (ctx.registry) {
        const entry = ctx.registry.get(arg);
        if (entry) {
            const idx = grids.indexOf(entry.grid);
            return { grid: entry.grid, idx, registryId: entry.id };
        }
    }

    // 3. Nothing found
    if (isPureInteger) {
        return { error: `ERR: invalid ${label} index ${arg} (0-${grids.length - 1})` };
    }
    return { error: `ERR: no ${label} found for "${arg}" (not a registry ID or valid index 0-${grids.length - 1})` };
}

// ──────────────────────────────────────────────────────────────
//  World-Space Bounds
// ──────────────────────────────────────────────────────────────

/**
 * Get world-space AABB for a grid as a canonical serializable object.
 * Forces matrix update before reading bounds -- handles just-repositioned grids.
 *
 * @param {Object} grid - CodeGrid instance
 * @returns {{ min: {x,y,z}, max: {x,y,z}, size: {x,y,z}, center: {x,y,z} } | null}
 */
export function getWorldBounds(grid) {
    grid.updateWorldMatrix(true, true);
    const box3 = grid.getBounds();
    if (!box3 || box3.isEmpty()) return null;
    return box3ToAABB(box3);
}

/**
 * Get raw THREE.Box3 for a grid in world space.
 * Forces matrix update. Returns null if empty.
 *
 * @param {Object} grid - CodeGrid instance
 * @returns {THREE.Box3 | null}
 */
export function getWorldBox3(grid) {
    grid.updateWorldMatrix(true, true);
    const box3 = grid.getBounds();
    if (!box3 || box3.isEmpty()) return null;
    return box3;
}

/**
 * Convert a THREE.Box3 to the canonical AABB plain object.
 * @param {THREE.Box3} box3
 * @returns {{ min: {x,y,z}, max: {x,y,z}, size: {x,y,z}, center: {x,y,z} }}
 */
export function box3ToAABB(box3) {
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box3.getSize(size);
    box3.getCenter(center);
    return {
        min: { x: box3.min.x, y: box3.min.y, z: box3.min.z },
        max: { x: box3.max.x, y: box3.max.y, z: box3.max.z },
        size: { x: size.x, y: size.y, z: size.z },
        center: { x: center.x, y: center.y, z: center.z },
    };
}

/**
 * Compute the union AABB of multiple grids by index.
 * Fails on invalid indices and empty grids -- never silently skips.
 *
 * @param {Array} grids - array of CodeGrid instances
 * @param {number[]} indices - grid indices to union
 * @returns {{ bounds: {min,max,size,center}, indices: number[] } | { error: string }}
 */
export function unionBounds(grids, indices) {
    const unionBox = new THREE.Box3();
    const validIndices = [];

    for (const idx of indices) {
        if (idx < 0 || idx >= grids.length) {
            return { error: `ERR: invalid grid index ${idx} (0-${grids.length - 1})` };
        }
        const box3 = getWorldBox3(grids[idx]);
        if (!box3) {
            return { error: `ERR: grid ${idx} has no content bounds` };
        }
        unionBox.union(box3);
        validIndices.push(idx);
    }

    if (validIndices.length === 0) {
        return { error: 'ERR: no valid grids provided' };
    }

    return { bounds: box3ToAABB(unionBox), indices: validIndices };
}

// ──────────────────────────────────────────────────────────────
//  Anchor Resolution
// ──────────────────────────────────────────────────────────────

/** @type {Record<string, (aabb: {min:{x,y,z}, max:{x,y,z}}) => {x:number,y:number,z:number}>} */
const ANCHORS = {
    'top-left':     (b) => ({ x: b.min.x, y: b.max.y, z: (b.min.z + b.max.z) / 2 }),
    'top':          (b) => ({ x: (b.min.x + b.max.x) / 2, y: b.max.y, z: (b.min.z + b.max.z) / 2 }),
    'top-right':    (b) => ({ x: b.max.x, y: b.max.y, z: (b.min.z + b.max.z) / 2 }),
    'leading':      (b) => ({ x: b.min.x, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 }),
    'center':       (b) => ({ x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 }),
    'trailing':     (b) => ({ x: b.max.x, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 }),
    'bottom-left':  (b) => ({ x: b.min.x, y: b.min.y, z: (b.min.z + b.max.z) / 2 }),
    'bottom':       (b) => ({ x: (b.min.x + b.max.x) / 2, y: b.min.y, z: (b.min.z + b.max.z) / 2 }),
    'bottom-right': (b) => ({ x: b.max.x, y: b.min.y, z: (b.min.z + b.max.z) / 2 }),
};

/** All valid anchor names. */
export const ANCHOR_NAMES = Object.keys(ANCHORS);

/**
 * Resolve a named anchor point on an AABB.
 * Accepts either canonical AABB ({min, max}) or THREE.Box3 (both have .min/.max).
 *
 * @param {Object} bounds - { min: {x,y,z}, max: {x,y,z} }
 * @param {string} name - anchor name (case-insensitive)
 * @returns {{ x: number, y: number, z: number } | null} null if name is invalid
 */
export function resolveAnchor(bounds, name) {
    const fn = ANCHORS[name.toLowerCase()];
    return fn ? fn(bounds) : null;
}

// ──────────────────────────────────────────────────────────────
//  Camera Math
// ──────────────────────────────────────────────────────────────

/**
 * Calculate the Z distance to fit a region of width x height in the viewport.
 * Uses camera FOV and aspect ratio. fillFraction < 1.0 adds margin.
 *
 * @param {Object} camera - THREE.PerspectiveCamera
 * @param {number} width
 * @param {number} height
 * @param {number} [fillFraction=0.85]
 * @returns {number}
 */
export function zDistanceForFit(camera, width, height, fillFraction = 0.85) {
    const fovRad = camera.fov * Math.PI / 180;
    const halfTan = Math.tan(fovRad / 2);
    const aspect = camera.aspect;

    const dH = (height / fillFraction) / (2 * halfTan);
    const dW = (width / fillFraction) / (2 * aspect * halfTan);

    return Math.max(dH, dW);
}

// ──────────────────────────────────────────────────────────────
//  Camera Helpers
// ──────────────────────────────────────────────────────────────

/** @param {number} t - 0..1 @returns {number} */
export function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Frame the camera on an AABB. Sets position, resets pitch/yaw.
 * Cancels any in-flight animation.
 * @param {Object} ctx - command context bag
 * @param {{ center: {x,y,z}, max: {x,y,z}, size: {x,y,z} }} bounds
 * @param {number} padding - extra world units per edge
 */
export function frameBounds(ctx, bounds, padding) {
    ctx._cancelCameraAnimation?.();
    const w = bounds.size.x + padding * 2;
    const h = bounds.size.y + padding * 2;
    const dist = zDistanceForFit(ctx.camera, w, h, 0.85);
    ctx.camera.position.set(bounds.center.x, bounds.center.y, bounds.max.z + dist);
    if (ctx.cameraController) {
        ctx.cameraController.pitch = 0;
        ctx.cameraController.yaw = 0;
    }
}

/**
 * Smoothly animate camera to a position over `duration` ms.
 * Returns a Promise that resolves on completion or cancellation.
 * @param {Object} ctx - command context bag
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} duration - ms
 * @returns {Promise<void>}
 */
export function animateCamera(ctx, x, y, z, duration) {
    return new Promise((resolve) => {
        const camera = ctx.camera;
        const startX = camera.position.x;
        const startY = camera.position.y;
        const startZ = camera.position.z;
        const startTime = performance.now();

        ctx._cancelCameraAnimation?.();

        let animId = null;

        function tick() {
            const elapsed = performance.now() - startTime;
            const t = Math.min(elapsed / duration, 1.0);
            const e = easeInOutCubic(t);
            camera.position.set(
                startX + (x - startX) * e,
                startY + (y - startY) * e,
                startZ + (z - startZ) * e,
            );
            if (t < 1.0) {
                animId = requestAnimationFrame(tick);
            } else {
                ctx._cancelCameraAnimation = null;
                resolve();
            }
        }

        animId = requestAnimationFrame(tick);

        ctx._cancelCameraAnimation = () => {
            if (animId != null) {
                cancelAnimationFrame(animId);
                animId = null;
            }
            ctx._cancelCameraAnimation = null;
            resolve();
        };
    });
}

// ──────────────────────────────────────────────────────────────
//  Formatting
// ──────────────────────────────────────────────────────────────

/**
 * Format a vec3 for TUI display.
 * @param {{ x: number, y: number, z: number }} v
 * @param {number} [decimals=2]
 * @returns {string}
 */
export function fmtVec(v, decimals = 2) {
    return `${v.x.toFixed(decimals)}, ${v.y.toFixed(decimals)}, ${v.z.toFixed(decimals)}`;
}

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
import { zDistanceForFit, easeInOutCubic } from '@glyph3d/core/services/spatial/spatialMath.js';

// The world floor (a fixed constant): content rests above it. The ground plane
// (SceneEnvironment) is drawn at this same Y. The world is a paused physics scene —
// a regular world with a floor and a down; loaded content sits on the floor.
export const WORLD_FLOOR_Y = 0;

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
 * The single grid resolver. Declared fallback chain:
 *   1. pure-integer string  -> array index
 *   2. registry ID
 *   3. (opt-in `byName`)     -> filename/sourcePath suffix, then case-insensitive
 *                               substring. Subsumes the old highlight `findGrid`
 *                               (sourcePath.endsWith) and camera.focus (filename
 *                               substring) wrappers — one matcher, not three.
 *
 * @param {Object} ctx - command context bag (must have .registry and .getGrids)
 * @param {string} arg - registry ID, numeric index, or (with byName) name/path
 * @param {string} [label='grid'] - label for error messages
 * @param {{ byName?: boolean }} [opts] - enable the name/path fallback (step 3)
 * @returns {{ grid: Object, idx: number, registryId: string|null } | { error: string }}
 */
export function resolveGridByIdOrIndex(ctx, arg, label = 'grid', { byName = false } = {}) {
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

    // 3. Opt-in name/path fallback: suffix match first (so "src/foo.js" pins an
    // exact tail), then loose case-insensitive substring across filename + path.
    if (byName) {
        const nameOf = (g) => g.getFilename?.() || '';
        const pathOf = (g) => g.getSourcePath?.() || '';
        let idx = grids.findIndex((g) => pathOf(g).endsWith(arg) || nameOf(g).endsWith(arg));
        if (idx < 0) {
            const needle = String(arg).toLowerCase();
            idx = grids.findIndex((g) =>
                pathOf(g).toLowerCase().includes(needle) || nameOf(g).toLowerCase().includes(needle));
        }
        if (idx >= 0) {
            const registryId = ctx.registry ? ctx.registry.getIdByGrid(grids[idx]) : null;
            return { grid: grids[idx], idx, registryId };
        }
    }

    // 4. Nothing found
    if (isPureInteger) {
        return { error: `ERR: invalid ${label} index ${arg} (0-${grids.length - 1})` };
    }
    const how = byName ? 'registry ID, name, or valid index' : 'registry ID or valid index';
    return { error: `ERR: no ${label} found for "${arg}" (not a ${how} 0-${grids.length - 1})` };
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
//  Directional Adjacency
// ──────────────────────────────────────────────────────────────

/**
 * Find the nearest adjacent entity in each of the four screen-plane directions
 * from a current entity, by grid-center distance. The axis with the larger
 * |delta| decides which direction bucket a candidate falls in; within a bucket
 * the smallest Euclidean distance wins. World XY == screen plane when the camera
 * is axis-aligned (pitch=yaw=0); off-axis it stays a reasonable world-space
 * heuristic. Considers grid / agent / terminal entries (anything framable).
 *
 * Pure: reads ctx.registry + world bounds, mutates nothing. The single neighbor
 * resolver — modeCommands' mode.jump/adjacencies and navigationCommands'
 * focus.neighbor both call it, so spatial nav has one definition.
 *
 * @param {Object} ctx - command context (needs .registry)
 * @param {string|null} currentId - registry id to navigate FROM
 * @returns {{ up: Object|null, down: Object|null, left: Object|null, right: Object|null }}
 *   each value a RegistryEntry or null
 */
export function resolveAdjacencies(ctx, currentId) {
    const empty = { up: null, down: null, left: null, right: null };
    if (!ctx.registry) return empty;
    const entries = ctx.registry.list().filter(
        e => e.type === 'grid' || e.type === 'agent' || e.type === 'terminal'
    );
    const currentEntry = entries.find(e => e.id === currentId);
    if (!currentEntry) return empty;
    const centerOf = (entry) => {
        const aabb = getWorldBounds(entry.grid);
        return aabb ? aabb.center : null;
    };
    const origin = centerOf(currentEntry);
    if (!origin) return empty;
    const best = { ...empty };
    const bestDist = { up: Infinity, down: Infinity, left: Infinity, right: Infinity };
    for (const entry of entries) {
        if (entry.id === currentId) continue;
        const c = centerOf(entry);
        if (!c) continue;
        const dx = c.x - origin.x;
        const dy = c.y - origin.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 1e-3) continue;
        const dir = Math.abs(dx) > Math.abs(dy)
            ? (dx > 0 ? 'right' : 'left')
            : (dy > 0 ? 'up'    : 'down');
        if (dist < bestDist[dir]) {
            best[dir] = entry;
            bestDist[dir] = dist;
        }
    }
    return best;
}

const _adjCenter = new THREE.Vector3();

/**
 * Nearest REAL SIBLING in each screen-plane direction from a focused node. The
 * candidate set is ONLY the node's tree-siblings (its parent's children — files AND
 * dirs, both selectable), so the boundary is enforced by construction: you can never
 * land in another branch, no gate needed. The layout packs a directory's siblings
 * contiguously in its own footprint, so "nearest sibling in a direction" is the
 * adjacent one — it never leaps across foreign content. A direction with no sibling
 * stops (null). Changing directory is i/o (focus.parent/child) or the palette.
 *
 * Nearest by EDGE distance (bounds, not center) so a large sub-dir block wins via its
 * near edge instead of losing to a small file on its center. Sibling-ness is
 * PATH-derived (parentOf), immune to reparenting (dock).
 *
 * @param {Object} ctx - command context (needs .contentTree)
 * @param {THREE.Object3D} node - the focused tree node (file leaf or dir node)
 * @returns {{ up: THREE.Object3D|null, down: THREE.Object3D|null, left: THREE.Object3D|null, right: THREE.Object3D|null }}
 */
export function resolveSiblingAdjacencies(ctx, node) {
    const empty = { up: null, down: null, left: null, right: null };
    const tree = ctx.contentTree;
    if (!tree || !node) return empty;
    const parent = tree.parentOf(node);    // PATH-derived: immune to reparenting (dock)
    if (!parent) return empty;             // root has no siblings
    const focusBox = getWorldBox3(node);
    if (!focusBox) return empty;
    const fc = focusBox.getCenter(new THREE.Vector3());

    const best = { ...empty };
    const bestDist = { up: Infinity, down: Infinity, left: Infinity, right: Infinity };
    for (const sib of tree.contentChildren(parent)) {
        if (sib === node) continue;
        const box = getWorldBox3(sib);
        if (!box) continue;
        const c = box.getCenter(_adjCenter);
        const dx = c.x - fc.x;
        const dy = c.y - fc.y;
        if (Math.abs(dx) < 1e-3 && Math.abs(dy) < 1e-3) continue;
        const dir = Math.abs(dx) > Math.abs(dy)
            ? (dx > 0 ? 'right' : 'left')
            : (dy > 0 ? 'up'    : 'down');
        const dist = box.distanceToPoint(fc); // edge distance — fair to large dir blocks
        if (dist < bestDist[dir]) {
            bestDist[dir] = dist;
            best[dir] = sib;
        }
    }
    return best;
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
//  Camera Helpers
// ──────────────────────────────────────────────────────────────

/**
 * Compute the target camera position to frame an AABB head-on.
 * Pure — does not mutate the camera.
 *
 * @param {Object} camera - THREE.PerspectiveCamera
 * @param {{ center: {x,y,z}, max: {x,y,z}, size: {x,y,z} }} bounds
 * @param {number} padding - extra world units per edge
 * @returns {{x:number,y:number,z:number}}
 */
export function computeBoundsFocus(camera, bounds, padding) {
    const w = bounds.size.x + padding * 2;
    const h = bounds.size.y + padding * 2;
    const dist = zDistanceForFit(camera, w, h, 0.85);
    return { x: bounds.center.x, y: bounds.center.y, z: bounds.max.z + dist };
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
    const target = computeBoundsFocus(ctx.camera, bounds, padding);
    ctx.camera.position.set(target.x, target.y, target.z);
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

# Phase 0: Navigation -- Camera Framing & Code Tours

Implementation-ready code for `camera.frame`, `camera.frame.bounds`, and the full tour system.

---

## 1. Browser-Side Command Handler

**File: `examples/github-viewer/websocket/commands/navigationCommands.js`**

```javascript
/**
 * Navigation commands: camera.frame, camera.frame.bounds, tour.*
 *
 * camera.frame computes the union AABB of listed grids and positions the camera
 * at the Z distance needed to fit it in the viewport. tour.* provides an ordered
 * sequence of camera-frame stops with optional annotations and timed playback.
 *
 * Depends on: ctx.camera, ctx.cameraController, ctx.getGrids(), ctx.annotations,
 *             ctx.scene, ctx.atlas, ctx._cancelCameraAnimation
 */

import { box, table, kvLines } from '../TUIFormatter.js';
import CodeGrid from '../../../../src/collections/CodeGrid.js';
import { COLORS } from './colorConstants.js';

/** @type {Map<string, TourDefinition>} */
const tours = new Map();

/**
 * @typedef {Object} TourStop
 * @property {number} gridIndex
 * @property {string|null} annotation - text to show (decoded)
 * @property {number} duration - ms to hold this stop before advancing
 * @property {string|null} annotationId - runtime: id of created annotation grid
 */

/**
 * @typedef {Object} TourDefinition
 * @property {string} name
 * @property {TourStop[]} stops
 */

// ────────────────────────────────────────────────────────────────
//  Shared geometry helpers
// ────────────────────────────────────────────────────────────────

/**
 * Compute the union AABB of multiple grids by index.
 * Returns null if no valid grids found.
 * @param {number[]} indices
 * @param {Array} grids
 * @returns {{ min: {x,y,z}, max: {x,y,z}, center: {x,y,z}, size: {x,y,z} } | null}
 */
function unionBoundsFromIndices(indices, grids) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let count = 0;

    for (const idx of indices) {
        if (idx < 0 || idx >= grids.length) continue;
        const b = grids[idx].getBounds();
        minX = Math.min(minX, b.min.x);
        minY = Math.min(minY, b.min.y);
        minZ = Math.min(minZ, b.min.z);
        maxX = Math.max(maxX, b.max.x);
        maxY = Math.max(maxY, b.max.y);
        maxZ = Math.max(maxZ, b.max.z);
        count++;
    }

    if (count === 0) return null;

    return {
        min: { x: minX, y: minY, z: minZ },
        max: { x: maxX, y: maxY, z: maxZ },
        center: {
            x: (minX + maxX) / 2,
            y: (minY + maxY) / 2,
            z: (minZ + maxZ) / 2,
        },
        size: {
            x: maxX - minX,
            y: maxY - minY,
            z: maxZ - minZ,
        },
    };
}

/**
 * Calculate the Z distance to fit a region of width x height in the viewport.
 * Uses camera FOV and aspect ratio. fillFraction < 1.0 adds margin.
 * @param {Object} camera - THREE.PerspectiveCamera
 * @param {number} width
 * @param {number} height
 * @param {number} [fillFraction=0.85]
 * @returns {number}
 */
function zDistanceForFit(camera, width, height, fillFraction = 0.85) {
    const fovRad = camera.fov * Math.PI / 180;
    const halfTan = Math.tan(fovRad / 2);
    const aspect = camera.aspect;

    const dH = (height / fillFraction) / (2 * halfTan);
    const dW = (width / fillFraction) / (2 * aspect * halfTan);

    return Math.max(dH, dW);
}

/**
 * Frame the camera on an AABB. Sets position, resets pitch/yaw.
 * @param {Object} ctx - command context bag
 * @param {{ min: {x,y,z}, max: {x,y,z}, center: {x,y,z}, size: {x,y,z} }} bounds
 * @param {number} padding - extra world units added to each edge
 */
function frameBounds(ctx, bounds, padding) {
    ctx._cancelCameraAnimation?.();

    const w = bounds.size.x + padding * 2;
    const h = bounds.size.y + padding * 2;
    const dist = zDistanceForFit(ctx.camera, w, h, 0.85);

    ctx.camera.position.set(
        bounds.center.x,
        bounds.center.y,
        bounds.max.z + dist
    );

    // Reset rotation to face -Z (perpendicular to content)
    if (ctx.cameraController) {
        ctx.cameraController.pitch = 0;
        ctx.cameraController.yaw = 0;
    }
}

/**
 * Smoothly animate camera to a position over `duration` ms.
 * Returns a Promise that resolves when animation completes.
 * @param {Object} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} duration
 * @returns {Promise<void>}
 */
function animateCamera(ctx, x, y, z, duration) {
    return new Promise((resolve) => {
        const camera = ctx.camera;
        const startX = camera.position.x;
        const startY = camera.position.y;
        const startZ = camera.position.z;
        const startTime = performance.now();

        ctx._cancelCameraAnimation?.();

        function easeInOutCubic(t) {
            return t < 0.5
                ? 4 * t * t * t
                : 1 - Math.pow(-2 * t + 2, 3) / 2;
        }

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
            resolve();  // resolve immediately on cancel so tour can continue
        };
    });
}

/**
 * Create an annotation grid positioned above a target grid.
 * Returns the annotation id.
 * @param {Object} ctx
 * @param {number} gridIndex
 * @param {string} text
 * @returns {string} annotation id
 */
function createTourAnnotation(ctx, gridIndex, text) {
    const grids = ctx.getGrids();
    const grid = grids[gridIndex];
    const bounds = grid.getBounds();

    // Place annotation above the grid, slightly forward in Z
    const x = bounds.min.x;
    const y = bounds.max.y + 2;
    const z = bounds.max.z + 1;

    const id = `tour-annot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const annotGrid = new CodeGrid(ctx.scene, ctx.atlas, {
        name: id,
        showBackground: true,
        showFilename: false,
        textColor: { ...COLORS.ANNOTATION },
        backgroundColor: 0x1a1a2e,
        backgroundOpacity: 0.92,
        backgroundPadding: 1.2,
        gridScale: 1.0,
    });

    annotGrid.loadText(text);
    annotGrid.position.set(x, y, z);

    ctx.scene.add(annotGrid);
    ctx.annotations.set(id, {
        type: 'tour-annotation',
        grid: annotGrid,
        text,
        position: { x, y, z },
        color: { ...COLORS.ANNOTATION },
    });

    return id;
}

/**
 * Remove a tour annotation by id.
 * @param {Object} ctx
 * @param {string} id
 */
function removeTourAnnotation(ctx, id) {
    const entry = ctx.annotations.get(id);
    if (!entry) return;
    entry.grid.dispose();
    ctx.scene.remove(entry.grid);
    ctx.annotations.delete(id);
}


// ────────────────────────────────────────────────────────────────
//  Command registration
// ────────────────────────────────────────────────────────────────

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerNavigationCommands(router) {

    // ================================================================
    //  camera.frame <index1> [index2...] [--padding <n>]
    //
    //  All numeric args before --padding are grid indices.
    //  Last numeric arg is treated as index, NOT padding, unless
    //  --padding flag is present.
    // ================================================================

    router.register('camera.frame', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: camera.frame <index1> [index2...] [--padding <n>]', data: null };
        }

        const grids = ctx.getGrids();
        let padding = 2;  // default padding in world units
        const indices = [];

        // Parse args: collect indices, extract --padding
        for (let i = 0; i < args.length; i++) {
            if (args[i] === '--padding' && i + 1 < args.length) {
                padding = parseFloat(args[i + 1]);
                if (isNaN(padding)) {
                    return { text: 'ERR: --padding value must be a number', data: null };
                }
                i++;  // skip value
                continue;
            }
            const idx = parseInt(args[i]);
            if (isNaN(idx)) {
                return { text: `ERR: invalid grid index '${args[i]}'`, data: null };
            }
            if (idx < 0 || idx >= grids.length) {
                return { text: `ERR: grid index ${idx} out of range (0-${grids.length - 1})`, data: null };
            }
            indices.push(idx);
        }

        if (indices.length === 0) {
            return { text: 'ERR: at least one grid index required', data: null };
        }

        const bounds = unionBoundsFromIndices(indices, grids);
        if (!bounds) {
            return { text: 'ERR: could not compute bounds for given indices', data: null };
        }

        frameBounds(ctx, bounds, padding);

        const names = indices.map(i => {
            const name = grids[i].getFilename?.() || `#${i}`;
            return `${i}:${name}`;
        });

        return {
            text: `OK: framing ${indices.length} grid(s): ${names.join(', ')}`,
            data: {
                indices,
                bounds,
                padding,
                cameraPosition: {
                    x: ctx.camera.position.x,
                    y: ctx.camera.position.y,
                    z: ctx.camera.position.z,
                },
            },
        };
    }, {
        description: 'Position camera to see all listed grids',
        usage: '<index1> [index2...] [--padding <n>]',
    });

    // ================================================================
    //  camera.frame.bounds <minX> <minY> <maxX> <maxY> [--padding <n>]
    //
    //  Frame an arbitrary 2D AABB. Z is taken from the camera's current
    //  Z position (or 0 if no grids are loaded).
    // ================================================================

    router.register('camera.frame.bounds', (args, ctx) => {
        if (args.length < 4) {
            return {
                text: 'ERR: usage: camera.frame.bounds <minX> <minY> <maxX> <maxY> [--padding <n>]',
                data: null,
            };
        }

        const [minX, minY, maxX, maxY] = args.slice(0, 4).map(Number);
        if ([minX, minY, maxX, maxY].some(isNaN)) {
            return { text: 'ERR: all coordinates must be numbers', data: null };
        }

        let padding = 2;
        for (let i = 4; i < args.length; i++) {
            if (args[i] === '--padding' && i + 1 < args.length) {
                padding = parseFloat(args[i + 1]);
                if (isNaN(padding)) {
                    return { text: 'ERR: --padding value must be a number', data: null };
                }
                break;
            }
        }

        // Use Z = 0 as the front face of the bounding box
        const bounds = {
            min: { x: minX, y: minY, z: 0 },
            max: { x: maxX, y: maxY, z: 0 },
            center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: 0 },
            size: { x: maxX - minX, y: maxY - minY, z: 0 },
        };

        frameBounds(ctx, bounds, padding);

        return {
            text: `OK: framing bounds (${minX}, ${minY}) to (${maxX}, ${maxY}) padding=${padding}`,
            data: {
                bounds,
                padding,
                cameraPosition: {
                    x: ctx.camera.position.x,
                    y: ctx.camera.position.y,
                    z: ctx.camera.position.z,
                },
            },
        };
    }, {
        description: 'Position camera to see an arbitrary AABB',
        usage: '<minX> <minY> <maxX> <maxY> [--padding <n>]',
    });

    // ================================================================
    //  tour.create <base64-name>
    // ================================================================

    router.register('tour.create', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: tour.create <base64-name>', data: null };
        }

        let name;
        try { name = atob(args[0]); } catch {
            return { text: 'ERR: invalid base64 name', data: null };
        }

        if (tours.has(name)) {
            return { text: `ERR: tour "${name}" already exists. Use tour.clear first.`, data: null };
        }

        tours.set(name, { name, stops: [] });

        return {
            text: `OK: tour "${name}" created (0 stops)`,
            data: { name, stops: 0 },
        };
    }, {
        description: 'Create a named tour (ordered list of camera stops)',
        usage: '<base64-name>',
    });

    // ================================================================
    //  tour.stop <base64-tour-name> <grid-index> [base64-annotation] [duration-ms]
    // ================================================================

    router.register('tour.stop', (args, ctx) => {
        if (args.length < 2) {
            return {
                text: 'ERR: usage: tour.stop <base64-tour-name> <grid-index> [base64-annotation] [duration-ms]',
                data: null,
            };
        }

        let tourName;
        try { tourName = atob(args[0]); } catch {
            return { text: 'ERR: invalid base64 tour name', data: null };
        }

        const tour = tours.get(tourName);
        if (!tour) {
            return { text: `ERR: tour "${tourName}" not found. Create it first with tour.create.`, data: null };
        }

        const gridIndex = parseInt(args[1]);
        const grids = ctx.getGrids();
        if (isNaN(gridIndex) || gridIndex < 0 || gridIndex >= grids.length) {
            return { text: `ERR: invalid grid index ${args[1]} (0-${grids.length - 1})`, data: null };
        }

        let annotation = null;
        if (args.length >= 3 && args[2] !== '-') {
            try { annotation = atob(args[2]); } catch {
                return { text: 'ERR: invalid base64 annotation', data: null };
            }
        }

        let duration = 3000;  // default hold time
        if (args.length >= 4) {
            duration = parseInt(args[3]);
            if (isNaN(duration) || duration < 100) {
                return { text: 'ERR: duration must be >= 100 ms', data: null };
            }
        }

        const stopIndex = tour.stops.length;
        tour.stops.push({ gridIndex, annotation, duration, annotationId: null });

        const gridName = grids[gridIndex].getFilename?.() || `#${gridIndex}`;

        return {
            text: `OK: stop #${stopIndex} added to "${tourName}": grid ${gridIndex} (${gridName}), ${duration}ms${annotation ? ', annotated' : ''}`,
            data: {
                tour: tourName,
                stopIndex,
                gridIndex,
                gridName,
                annotation,
                duration,
            },
        };
    }, {
        description: 'Add a stop to a tour',
        usage: '<base64-tour-name> <grid-index> [base64-annotation] [duration-ms]',
    });

    // ================================================================
    //  tour.play <base64-tour-name>
    //
    //  Async: animates camera through each stop sequentially.
    //  Returns immediately with "playing" status. The animation runs
    //  in the background. Cancel with ctx._cancelCameraAnimation().
    // ================================================================

    router.register('tour.play', async (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: tour.play <base64-tour-name>', data: null };
        }

        let tourName;
        try { tourName = atob(args[0]); } catch {
            return { text: 'ERR: invalid base64 tour name', data: null };
        }

        const tour = tours.get(tourName);
        if (!tour) {
            return { text: `ERR: tour "${tourName}" not found`, data: null };
        }

        if (tour.stops.length === 0) {
            return { text: `ERR: tour "${tourName}" has no stops`, data: null };
        }

        const grids = ctx.getGrids();
        const totalStops = tour.stops.length;

        // Reset pitch/yaw once at the start
        if (ctx.cameraController) {
            ctx.cameraController.pitch = 0;
            ctx.cameraController.yaw = 0;
        }

        // Play through stops sequentially
        let previousAnnotationId = null;

        for (let i = 0; i < tour.stops.length; i++) {
            const stop = tour.stops[i];
            const grid = grids[stop.gridIndex];
            if (!grid) continue;

            // Remove previous stop's annotation
            if (previousAnnotationId) {
                removeTourAnnotation(ctx, previousAnnotationId);
                previousAnnotationId = null;
            }

            // Compute frame target for this stop's grid
            const bounds = unionBoundsFromIndices([stop.gridIndex], grids);
            if (!bounds) continue;

            const padding = 2;
            const w = bounds.size.x + padding * 2;
            const h = bounds.size.y + padding * 2;
            const fovRad = ctx.camera.fov * Math.PI / 180;
            const halfTan = Math.tan(fovRad / 2);
            const aspect = ctx.camera.aspect;
            const dH = (h / 0.85) / (2 * halfTan);
            const dW = (w / 0.85) / (2 * aspect * halfTan);
            const dist = Math.max(dH, dW);

            const targetX = bounds.center.x;
            const targetY = bounds.center.y;
            const targetZ = bounds.max.z + dist;

            // Animate camera to the stop (transition time scales with distance)
            const dx = ctx.camera.position.x - targetX;
            const dy = ctx.camera.position.y - targetY;
            const dz = ctx.camera.position.z - targetZ;
            const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const transitionMs = Math.max(400, Math.min(2000, distance * 3));

            await animateCamera(ctx, targetX, targetY, targetZ, transitionMs);

            // Show annotation (after camera arrives)
            if (stop.annotation) {
                const annotId = createTourAnnotation(ctx, stop.gridIndex, stop.annotation);
                stop.annotationId = annotId;
                previousAnnotationId = annotId;
            }

            // Hold at this stop for the specified duration
            await new Promise(resolve => setTimeout(resolve, stop.duration));
        }

        // Clean up final annotation
        if (previousAnnotationId) {
            removeTourAnnotation(ctx, previousAnnotationId);
        }

        return {
            text: `OK: tour "${tourName}" complete (${totalStops} stops)`,
            data: { tour: tourName, stops: totalStops },
        };
    }, {
        description: 'Play a tour: animate camera through stops with annotations',
        usage: '<base64-tour-name>',
    });

    // ================================================================
    //  tour.list
    // ================================================================

    router.register('tour.list', (args, ctx) => {
        if (tours.size === 0) {
            return {
                text: box('TOURS', ['(none)'], 40) + '\nOK: 0 tours',
                data: { tours: [], count: 0 },
            };
        }

        const headers = ['name', 'stops', 'grids'];
        const rows = [];
        const data = [];

        for (const [name, tour] of tours) {
            const gridIndices = tour.stops.map(s => s.gridIndex);
            rows.push([
                name.length > 25 ? name.slice(0, 24) + '\u2026' : name,
                String(tour.stops.length),
                gridIndices.join(','),
            ]);
            data.push({
                name,
                stops: tour.stops.map((s, i) => ({
                    index: i,
                    gridIndex: s.gridIndex,
                    hasAnnotation: !!s.annotation,
                    duration: s.duration,
                })),
            });
        }

        return {
            text: table(headers, rows) + `\nOK: ${tours.size} tour(s)`,
            data: { tours: data, count: tours.size },
        };
    }, { description: 'List all tours' });

    // ================================================================
    //  tour.clear
    // ================================================================

    router.register('tour.clear', (args, ctx) => {
        // Clean up any live tour annotations
        for (const [name, tour] of tours) {
            for (const stop of tour.stops) {
                if (stop.annotationId) {
                    removeTourAnnotation(ctx, stop.annotationId);
                }
            }
        }

        const count = tours.size;
        tours.clear();

        return {
            text: `OK: cleared ${count} tour(s)`,
            data: { cleared: count },
        };
    }, { description: 'Remove all tours and their annotations' });
}
```

---

## 2. Wire Into Command Registry

**Edit: `examples/github-viewer/websocket/commands/index.js`**

Add one import and one call:

```javascript
import registerNavigationCommands from './navigationCommands.js';

// In registerAllCommands(), add:
registerNavigationCommands(router);
```

Full updated file:

```javascript
import registerSystemCommands from './systemCommands.js';
import registerCameraCommands from './cameraCommands.js';
import registerGridCommands from './gridCommands.js';
import registerSceneCommands from './sceneCommands.js';
import registerSelectCommands from './selectCommands.js';
import registerLayoutCommands from './layoutCommands.js';
import registerSearchCommands from './searchCommands.js';
import registerAgentLayoutCommands from './agentLayoutCommands.js';
import registerAnnotationCommands from './annotationCommands.js';
import registerNavigationCommands from './navigationCommands.js';

export function registerAllCommands(router) {
    registerSystemCommands(router);
    registerCameraCommands(router);
    registerGridCommands(router);
    registerSceneCommands(router);
    registerSelectCommands(router);
    registerLayoutCommands(router);
    registerSearchCommands(router);
    registerAgentLayoutCommands(router);
    registerAnnotationCommands(router);
    registerNavigationCommands(router);
}
```

---

## 3. CLI-Side CodeTour Class

**File: `examples/github-viewer/cli/CodeTour.mjs`**

```javascript
/**
 * CodeTour -- fluent API for building and playing camera tours via WebSocket.
 *
 * Usage:
 *   import CodeTour from './CodeTour.mjs';
 *   const tour = new CodeTour(conn, 'worker-pipeline');
 *   tour.addStop(111, 'WorkerBridge manages the pool', 4000);
 *   tour.addStop(113, 'Builders convert text to buffers');
 *   tour.addStop(72,  'GlyphAtlas provides the font texture');
 *   await tour.play();
 *
 * Requires a connected CliConnection instance.
 */

export default class CodeTour {
    /**
     * @param {import('./CliConnection.mjs').default} conn - connected CliConnection
     * @param {string} name - human-readable tour name
     */
    constructor(conn, name) {
        this.conn = conn;
        this.name = name;
        this._stops = [];
        this._created = false;
    }

    /**
     * Add a stop to the tour.
     * @param {number} gridIndex - index of the grid to focus on
     * @param {string} [annotation] - text annotation to display at the stop
     * @param {number} [durationMs=3000] - time in ms to hold at this stop
     * @returns {this} for chaining
     */
    addStop(gridIndex, annotation = null, durationMs = 3000) {
        this._stops.push({ gridIndex, annotation, durationMs });
        return this;
    }

    /**
     * Create the tour on the viewer, add all stops, and play it.
     * @param {Object} [options]
     * @param {number} [options.timeout=60000] - total timeout for tour playback
     * @returns {Promise<{text: string, data: any}>} result of tour.play
     */
    async play(options = {}) {
        const timeout = options.timeout || 60000;
        const nameB64 = Buffer.from(this.name).toString('base64');

        // 1. Create the tour
        const createResult = await this.conn.send(`tour.create ${nameB64}`);
        if (createResult.text.startsWith('ERR:')) {
            throw new Error(`Failed to create tour: ${createResult.text}`);
        }
        this._created = true;

        // 2. Add each stop
        for (const stop of this._stops) {
            const annotB64 = stop.annotation
                ? Buffer.from(stop.annotation).toString('base64')
                : '-';
            const cmd = `tour.stop ${nameB64} ${stop.gridIndex} ${annotB64} ${stop.durationMs}`;
            const result = await this.conn.send(cmd);
            if (result.text.startsWith('ERR:')) {
                throw new Error(`Failed to add stop: ${result.text}`);
            }
        }

        // 3. Play (this blocks until the tour completes on the viewer side)
        const totalDuration = this._stops.reduce((sum, s) => sum + s.durationMs, 0);
        const playTimeout = Math.max(timeout, totalDuration + 10000);

        const playResult = await this.conn.send(`tour.play ${nameB64}`, playTimeout);
        return playResult;
    }

    /**
     * Create the tour and add stops without playing.
     * Useful for building a tour that will be played later.
     * @returns {Promise<void>}
     */
    async build() {
        const nameB64 = Buffer.from(this.name).toString('base64');

        const createResult = await this.conn.send(`tour.create ${nameB64}`);
        if (createResult.text.startsWith('ERR:')) {
            throw new Error(`Failed to create tour: ${createResult.text}`);
        }
        this._created = true;

        for (const stop of this._stops) {
            const annotB64 = stop.annotation
                ? Buffer.from(stop.annotation).toString('base64')
                : '-';
            const cmd = `tour.stop ${nameB64} ${stop.gridIndex} ${stop.durationMs} ${annotB64}`;
            const result = await this.conn.send(cmd);
            if (result.text.startsWith('ERR:')) {
                throw new Error(`Failed to add stop: ${result.text}`);
            }
        }
    }

    /**
     * Clear this tour from the viewer.
     * Note: tour.clear removes ALL tours, not just this one.
     * @returns {Promise<{text: string, data: any}>}
     */
    async clear() {
        return this.conn.send('tour.clear');
    }

    /**
     * Frame specific grids without a full tour (convenience wrapper).
     * @param {number[]} indices - grid indices to frame together
     * @param {number} [padding=2] - padding in world units
     * @returns {Promise<{text: string, data: any}>}
     */
    static async frame(conn, indices, padding = 2) {
        const cmd = `camera.frame ${indices.join(' ')} --padding ${padding}`;
        return conn.send(cmd);
    }

    /**
     * Frame an arbitrary bounding box (convenience wrapper).
     * @param {number} minX
     * @param {number} minY
     * @param {number} maxX
     * @param {number} maxY
     * @param {number} [padding=2]
     * @returns {Promise<{text: string, data: any}>}
     */
    static async frameBounds(conn, minX, minY, maxX, maxY, padding = 2) {
        const cmd = `camera.frame.bounds ${minX} ${minY} ${maxX} ${maxY} --padding ${padding}`;
        return conn.send(cmd);
    }
}
```

---

## 4. Wire Protocol Examples

### camera.frame -- frame two grids together

```
# CLI sends:
camera.frame 111 116

# Viewer response (JSON):
{
  "response": "OK: framing 2 grid(s): 111:WorkerBridge.js, 116:buildBuffers.js",
  "data": {
    "indices": [111, 116],
    "bounds": {
      "min": { "x": -45.2, "y": -180.3, "z": 0 },
      "max": { "x": 82.1, "y": 12.5, "z": 0 },
      "center": { "x": 18.45, "y": -83.9, "z": 0 },
      "size": { "x": 127.3, "y": 192.8, "z": 0 }
    },
    "padding": 2,
    "cameraPosition": { "x": 18.45, "y": -83.9, "z": 182.6 }
  }
}
```

### camera.frame with padding

```
# CLI sends:
camera.frame 72 --padding 10

# Viewer response:
{
  "response": "OK: framing 1 grid(s): 72:GlyphAtlas.js",
  "data": {
    "indices": [72],
    "bounds": { ... },
    "padding": 10,
    "cameraPosition": { "x": 15.2, "y": -45.1, "z": 95.3 }
  }
}
```

### camera.frame.bounds

```
# CLI sends:
camera.frame.bounds -100 -200 100 0 --padding 5

# Viewer response:
{
  "response": "OK: framing bounds (-100, -200) to (100, 0) padding=5",
  "data": {
    "bounds": {
      "min": { "x": -100, "y": -200, "z": 0 },
      "max": { "x": 100, "y": 0, "z": 0 },
      "center": { "x": 0, "y": -100, "z": 0 },
      "size": { "x": 200, "y": 200, "z": 0 }
    },
    "padding": 5,
    "cameraPosition": { "x": 0, "y": -100, "z": 164.7 }
  }
}
```

### tour.create

```
# CLI sends (name "worker-pipeline" base64-encoded):
tour.create d29ya2VyLXBpcGVsaW5l

# Response:
{
  "response": "OK: tour \"worker-pipeline\" created (0 stops)",
  "data": { "name": "worker-pipeline", "stops": 0 }
}
```

### tour.stop

```
# CLI sends (tour name b64, grid 111, annotation "WorkerBridge manages the pool" b64, 4000ms):
tour.stop d29ya2VyLXBpcGVsaW5l 111 V29ya2VyQnJpZGdlIG1hbmFnZXMgdGhlIHBvb2w= 4000

# Response:
{
  "response": "OK: stop #0 added to \"worker-pipeline\": grid 111 (WorkerBridge.js), 4000ms, annotated",
  "data": {
    "tour": "worker-pipeline",
    "stopIndex": 0,
    "gridIndex": 111,
    "gridName": "WorkerBridge.js",
    "annotation": "WorkerBridge manages the pool",
    "duration": 4000
  }
}
```

### tour.stop without annotation

```
# Use "-" as the annotation placeholder:
tour.stop d29ya2VyLXBpcGVsaW5l 113 - 3000

# Response:
{
  "response": "OK: stop #1 added to \"worker-pipeline\": grid 113 (buildBuffers.js), 3000ms",
  "data": { ... }
}
```

### tour.play

```
# CLI sends:
tour.play d29ya2VyLXBpcGVsaW5l

# Response (after all stops complete):
{
  "response": "OK: tour \"worker-pipeline\" complete (3 stops)",
  "data": { "tour": "worker-pipeline", "stops": 3 }
}
```

### tour.list

```
# CLI sends:
tour.list

# Response:
{
  "response": "name                       stops  grids\n...\nOK: 1 tour(s)",
  "data": {
    "tours": [{
      "name": "worker-pipeline",
      "stops": [
        { "index": 0, "gridIndex": 111, "hasAnnotation": true, "duration": 4000 },
        { "index": 1, "gridIndex": 113, "hasAnnotation": true, "duration": 3000 },
        { "index": 2, "gridIndex": 72, "hasAnnotation": true, "duration": 3000 }
      ]
    }],
    "count": 1
  }
}
```

### tour.clear

```
# CLI sends:
tour.clear

# Response:
{ "response": "OK: cleared 1 tour(s)", "data": { "cleared": 1 } }
```

---

## 5. Example: 3-Stop Worker Pipeline Tour

### Using the CodeTour class (Node.js script)

**File: `examples/github-viewer/cli/demo-tour.mjs`**

```javascript
#!/usr/bin/env node
/**
 * Demo: narrated tour of the worker pipeline.
 *
 * Run with:
 *   node examples/github-viewer/cli/demo-tour.mjs
 *
 * Prerequisite: viewer open with a repo loaded, relay running (npm run ws).
 */

import CliConnection from './CliConnection.mjs';
import CodeTour from './CodeTour.mjs';

const conn = new CliConnection('ws://localhost:8765');
const ack = await conn.connect();
process.stderr.write(`${ack}\n`);

// First, frame all three files together to show the full pipeline
process.stderr.write('Framing worker pipeline files...\n');
await CodeTour.frame(conn, [111, 113, 72], 5);
await new Promise(r => setTimeout(r, 1500));

// Now play a narrated tour
const tour = new CodeTour(conn, 'worker-pipeline');

tour.addStop(111,
    'STOP 1: WorkerBridge.js\n' +
    '========================\n' +
    'The entry point for async buffer computation.\n' +
    'Maintains a pool of Web Workers (hardwareConcurrency - 1)\n' +
    'with round-robin job distribution and Promise-based API.\n' +
    'Falls back to main thread if workers are unavailable.',
    5000
);

tour.addStop(113,
    'STOP 2: buildBuffers.js\n' +
    '========================\n' +
    'Pure function: text + UV map -> Float32Array.\n' +
    'Single-pass algorithm with zero allocations in the hot loop.\n' +
    'Uses charCodeAt() + index math for maximum throughput.\n' +
    'Runs inside Web Workers -- no DOM or Three.js dependencies.',
    5000
);

tour.addStop(72,
    'STOP 3: GlyphAtlas.js\n' +
    '========================\n' +
    'Generates the font texture atlas using Canvas 2D.\n' +
    'Shelf-packing algorithm arranges glyphs into rows.\n' +
    'One-time ~200ms cost. The atlas map DataTexture\n' +
    'enables GPU-side codepoint -> UV resolution.',
    5000
);

process.stderr.write('Playing tour...\n');
const result = await tour.play();
process.stderr.write(`${result.text}\n`);

// Clean up
await tour.clear();
conn.close();
process.exit(0);
```

### Using raw CLI commands (pipe mode)

```bash
# Save as worker-tour.txt, run with: node glyph-cli.mjs < worker-tour.txt

# Create the tour
tour.create d29ya2VyLXBpcGVsaW5l

# Stop 1: WorkerBridge (index 111, 5s hold)
tour.stop d29ya2VyLXBpcGVsaW5l 111 V29ya2VyQnJpZGdlIG1hbmFnZXMgdGhlIHdvcmtlciBwb29s 5000

# Stop 2: buildBuffers (index 113, 5s hold)
tour.stop d29ya2VyLXBpcGVsaW5l 113 QnVpbGRlcnMgY29udmVydCB0ZXh0IHRvIEZsb2F0MzJBcnJheXM= 5000

# Stop 3: GlyphAtlas (index 72, 5s hold)
tour.stop d29ya2VyLXBpcGVsaW5l 72 R2x5cGhBdGxhcyBwcm92aWRlcyB0aGUgZm9udCB0ZXh0dXJl 5000

# Play
tour.play d29ya2VyLXBpcGVsaW5l

# Clean up
tour.clear
```

### Interactive REPL session

```
glyph> camera.frame 111 113 72
OK: framing 3 grid(s): 111:WorkerBridge.js, 113:buildBuffers.js, 72:GlyphAtlas.js

glyph> camera.frame 111 116 --padding 10
OK: framing 2 grid(s): 111:WorkerBridge.js, 116:textToGlyphs.js

glyph> camera.frame.bounds -50 -100 50 0
OK: framing bounds (-50, -100) to (50, 0) padding=2

glyph> tour.list
name                       stops  grids
─────────────────────────  ─────  ─────
(none)
OK: 0 tours
```

---

## 6. Design Notes

### Why `camera.frame` instead of extending `camera.focus`

`camera.focus` is a single-grid "reading" command -- it places the camera at a consistent reading distance where ~35 lines fill the viewport. `camera.frame` is a multi-grid "overview" command -- it computes the union bounding box and fits everything in view. Different intent, different math.

### Tour animation timing

Transition time between stops is computed from the Euclidean distance between the current camera position and the target, clamped to 400-2000ms. This prevents jarring snaps for close grids and excessively slow pans for distant ones. The `duration` on each stop is the hold time *after* arrival, not including transit.

### Annotation lifecycle

Tour annotations are created as `tour-annotation` type entries in `ctx.annotations`, using the same CodeGrid pattern as `scene.annotate`. Each stop's annotation is removed when the camera leaves for the next stop. `tour.clear` removes any surviving annotations.

### Base64 encoding

Tour names and annotations use base64 encoding over the wire, consistent with `label.create`, `scene.annotate`, and `grid.create`. The CodeTour class handles encoding automatically. When using raw CLI commands or pipe mode, encode with `echo -n "text" | base64`.

### Camera animation Promise

The `animateCamera` helper returns a Promise that resolves when the `requestAnimationFrame` loop reaches `t = 1.0` or when the animation is cancelled. This allows `tour.play` to use `await` for sequential stop playback within an async command handler. The CommandRouter already supports async handlers (`_run` uses `await`).

// src/services/tour/TourSequencer.js

import * as THREE from 'three';
import TourResolver from './TourResolver.js';
import TourAnnotator from './TourAnnotator.js';

const TAG_PREFIX = 'tour';

/**
 * @typedef {Object} TourStep
 * @property {string} id                   - unique step ID
 * @property {string} [title]              - step heading
 * @property {string} [description]        - narration text
 * @property {import('./TourResolver.js').ResolvedReference[]} refs
 * @property {string[]} annotations        - annotation IDs created for this step
 * @property {string[]} connections        - connection IDs created for this step
 * @property {{x,y,z}} [cameraTarget]      - explicit camera position override
 * @property {number} [cameraDuration]     - ms for camera animation (default 800)
 */

/**
 * @typedef {Object} TourData
 * @property {string} [id]                 - tour identifier
 * @property {string} [title]              - tour title
 * @property {TourStepInput[]} steps       - raw step definitions
 */

/**
 * @typedef {Object} TourStepInput
 * @property {string} [title]
 * @property {string} [description]
 * @property {import('../../parsing/parseFileRef.js').ParsedRef[]} refs
 * @property {{x,y,z}} [camera]            - explicit camera override
 * @property {number} [cameraDuration]
 */

/**
 * Step-based state machine for code tours.
 * States: idle -> loaded -> active -> idle (via clear).
 *
 * Connections delegate to ctx.connectionRenderer (ConnectionRenderer instance).
 * Camera uses static THREE import for zero-overhead Box3 operations.
 *
 * Spatial helpers (getWorldBounds, resolveAnchor, animateCamera, frameBounds)
 * are injected via the `helpers` parameter to avoid importing from app/ layer.
 */
export default class TourSequencer {
    /**
     * @param {Object} ctx - command context bag
     * @param {Object} helpers - spatial helper functions (injected from app layer)
     * @param {Function} helpers.getWorldBounds - (grid) => {min, max, center}
     * @param {Function} helpers.resolveAnchor - (bounds, name) => {x, y, z}
     * @param {Function} helpers.animateCamera - (ctx, x, y, z, duration) => Promise
     * @param {Function} helpers.frameBounds - (ctx, bounds, padding) => void
     */
    constructor(ctx, helpers) {
        this._ctx = ctx;
        this._helpers = helpers;
        this._resolver = new TourResolver(ctx.registry);
        this._annotator = new TourAnnotator(ctx);

        /** @type {'idle'|'loaded'|'active'} */
        this.state = 'idle';

        /** @type {TourData|null} */
        this.tourData = null;

        /** @type {TourStep[]} */
        this.steps = [];

        /** @type {number} */
        this.stepIndex = -1;
    }

    /** @returns {TourStep|null} */
    get currentStep() {
        return this.stepIndex >= 0 ? this.steps[this.stepIndex] : null;
    }

    /**
     * Load tour data: resolve all references, build steps.
     * Idempotent: re-loading clears previous state first.
     * @param {TourData} data
     * @returns {{ stepCount: number, unresolved: string[] }}
     */
    load(data) {
        if (this.state !== 'idle') {
            this.clear();
        }

        this.tourData = data;
        const unresolved = [];

        this.steps = data.steps.map((input, i) => {
            const resolved = this._resolver.resolveAll(input.refs || []);

            for (const r of resolved) {
                if (r.matchType === 'none' && r.ref.filePath) {
                    unresolved.push(r.ref.filePath);
                }
            }

            return {
                id: `${TAG_PREFIX}-step-${i}`,
                title: input.title || `Step ${i + 1}`,
                description: input.description || '',
                refs: resolved,
                annotations: [],
                connections: [],
                cameraTarget: input.camera || null,
                cameraDuration: input.cameraDuration || 800,
            };
        });

        this.state = 'loaded';
        return { stepCount: this.steps.length, unresolved };
    }

    /**
     * Navigate to a specific step by index.
     * Tears down the current step's visuals, applies the new step's visuals, animates camera.
     * @param {number} index - 0-based step index
     * @returns {Promise<TourStep>}
     */
    async goto(index) {
        if (this.state === 'idle') throw new Error('No tour loaded');
        if (index < 0 || index >= this.steps.length) {
            throw new Error(`Step ${index} out of range (0-${this.steps.length - 1})`);
        }

        // Already showing this step — no-op to avoid teardown/re-apply flicker
        if (index === this.stepIndex && this.state === 'active') {
            return this.steps[index];
        }

        // Tear down current step visuals
        if (this.state === 'active') {
            this._teardownStep(this.stepIndex);
        }

        this.stepIndex = index;
        this.state = 'active';

        const step = this.steps[index];

        // Apply annotations
        step.annotations = this._annotator.apply(step);

        // Draw connections between consecutive resolved grids
        step.connections = this._applyConnections(step);

        // Animate camera
        await this._animateToStep(step);

        return step;
    }

    /** @returns {Promise<TourStep>} */
    async next() {
        const target = this.state === 'loaded' ? 0 : this.stepIndex + 1;
        return this.goto(Math.min(target, this.steps.length - 1));
    }

    /** @returns {Promise<TourStep>} */
    async prev() {
        const target = this.state === 'loaded' ? 0 : this.stepIndex - 1;
        return this.goto(Math.max(target, 0));
    }

    /**
     * Clear all tour state and visuals. Returns to idle.
     */
    clear() {
        // Tear down current step
        if (this.state === 'active') {
            this._teardownStep(this.stepIndex);
        }

        // Remove all tour-tagged registry entries (label grids)
        const removed = this._ctx.registry.unregisterByType('tour-annotation');
        for (const entry of removed) {
            entry.grid.dispose?.();
            this._ctx.scene.remove(entry.grid);
        }

        // Clear all connection lines
        this._ctx.connectionRenderer?.clear();

        this.tourData = null;
        this.steps = [];
        this.stepIndex = -1;
        this.state = 'idle';
    }

    // -- Private ----------------------------------------------------------

    /**
     * Apply connection lines between consecutive resolved grids in a step.
     * @param {TourStep} step
     * @returns {string[]} connection IDs
     * @private
     */
    _applyConnections(step) {
        const cr = this._ctx.connectionRenderer;
        if (!cr) return [];

        const resolvedGrids = step.refs.filter(r => r.grid);
        if (resolvedGrids.length < 2) return [];

        const ids = [];

        for (let i = 0; i < resolvedGrids.length - 1; i++) {
            const fromResolved = resolvedGrids[i];
            const toResolved   = resolvedGrids[i + 1];

            const fromBounds = this._helpers.getWorldBounds(fromResolved.grid);
            const toBounds   = this._helpers.getWorldBounds(toResolved.grid);
            if (!fromBounds || !toBounds) continue;

            const from  = this._helpers.resolveAnchor(fromBounds, 'trailing');
            const to    = this._helpers.resolveAnchor(toBounds, 'leading');
            const color = { r: 0.3, g: 0.8, b: 1.0 }; // default connection color

            const connId = `${step.id}-conn-${i}`;
            cr.set(connId, from, to, color, {
                fromGrid: fromResolved.grid,
                toGrid:   toResolved.grid,
            });
            ids.push(connId);
        }

        return ids;
    }

    /**
     * Remove visuals for a step (highlights, labels, connections).
     * @param {number} index
     * @private
     */
    _teardownStep(index) {
        const step = this.steps[index];
        if (!step) return;

        // Clear glyph highlights tracked by the annotator
        this._annotator.removeHighlights(step.id);

        // Remove label grids
        this._annotator.remove(step.annotations);

        // Remove connection lines
        if (this._ctx.connectionRenderer) {
            for (const connId of step.connections) {
                this._ctx.connectionRenderer.remove(connId);
            }
        }

        step.annotations = [];
        step.connections = [];
    }

    /**
     * Compute and animate camera to frame all resolved refs in a step.
     * Uses static THREE import (no dynamic import overhead).
     * @param {TourStep} step
     * @private
     */
    async _animateToStep(step) {
        // Explicit camera target overrides auto-framing
        if (step.cameraTarget) {
            const { x, y, z } = step.cameraTarget;
            await this._helpers.animateCamera(this._ctx, x, y, z, step.cameraDuration);
            return;
        }

        // Auto-frame: union bounds of all resolved grids
        const grids = step.refs
            .filter(r => r.grid)
            .map(r => r.grid);

        if (grids.length === 0) return;

        const unionBox = new THREE.Box3();
        for (const grid of grids) {
            const bounds = this._helpers.getWorldBounds(grid);
            if (bounds) {
                unionBox.expandByPoint(new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z));
                unionBox.expandByPoint(new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z));
            }
        }

        if (!unionBox.isEmpty()) {
            const size   = new THREE.Vector3();
            const center = new THREE.Vector3();
            unionBox.getSize(size);
            unionBox.getCenter(center);
            const aabb = {
                min:    { x: unionBox.min.x, y: unionBox.min.y, z: unionBox.min.z },
                max:    { x: unionBox.max.x, y: unionBox.max.y, z: unionBox.max.z },
                size:   { x: size.x, y: size.y, z: size.z },
                center: { x: center.x, y: center.y, z: center.z },
            };
            this._helpers.frameBounds(this._ctx, aabb, 5);
        }
    }
}

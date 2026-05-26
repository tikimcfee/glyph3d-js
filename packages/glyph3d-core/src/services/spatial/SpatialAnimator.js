/**
 * SpatialAnimator -- frame-driven property animation engine.
 *
 * Animations are keyed by `${object.uuid}:${property}`. Starting a new
 * animation on the same key cancels any in-flight animation (last-write
 * wins). Called from the render loop via `update(dt)`.
 *
 * Supported properties:
 *   - 'position' -- vec3 lerp on object.position
 *   - 'scale'    -- scalar lerp on object.scale (uniform)
 *   - 'opacity'  -- float lerp on object._background.material.opacity
 */

import { easeInOutCubic } from './spatialMath.js';

/**
 * @typedef {Object} Animation
 * @property {Object} object - Three.js Object3D
 * @property {string} property - 'position' | 'scale' | 'opacity'
 * @property {Object} from - start value
 * @property {Object} to - target value
 * @property {number} duration - total seconds
 * @property {number} elapsed - seconds elapsed
 * @property {Function} easing - t => t easing function
 * @property {Function} [onComplete] - callback on finish
 */

export class SpatialAnimator {
    constructor() {
        /** @type {Map<string, Animation>} */
        this._active = new Map();
    }

    /**
     * Animate a property on an object to a target value.
     *
     * @param {Object} object - Three.js Object3D (must have .uuid)
     * @param {string} property - 'position' | 'scale' | 'opacity'
     * @param {Object|number} target - target value
     * @param {Object} [opts]
     * @param {number} [opts.duration=0.3] - seconds
     * @param {Function} [opts.easing] - t => t function
     * @param {Function} [opts.onComplete] - callback
     * @returns {string} animation key
     */
    animateTo(object, property, target, opts = {}) {
        const key = `${object.uuid}:${property}`;

        // Cancel in-flight animation on same key
        this._active.delete(key);

        const duration = opts.duration ?? 0.3;
        const easing = opts.easing ?? easeInOutCubic;

        let from;
        if (property === 'position') {
            from = { x: object.position.x, y: object.position.y, z: object.position.z };
        } else if (property === 'scale') {
            from = object.scale.x;
        } else if (property === 'opacity') {
            from = object._background?.material?.opacity ?? 1;
        } else {
            console.warn(`[SpatialAnimator] Unknown property: ${property}`);
            return key;
        }

        this._active.set(key, {
            object,
            property,
            from,
            to: target,
            duration,
            elapsed: 0,
            easing,
            onComplete: opts.onComplete || null,
        });

        return key;
    }

    /**
     * Animate multiple objects in a batch (e.g., group layout transitions).
     *
     * @param {Array<{ object: Object, property: string, target: *, opts?: Object }>} batch
     * @returns {string[]} animation keys
     */
    animateBatch(batch) {
        return batch.map(({ object, property, target, opts }) =>
            this.animateTo(object, property, target, opts)
        );
    }

    /**
     * Cancel a specific animation.
     * @param {string} key
     */
    cancel(key) {
        this._active.delete(key);
    }

    /**
     * Cancel all animations for an object.
     * @param {Object} object
     */
    cancelAll(object) {
        const prefix = object.uuid + ':';
        for (const key of this._active.keys()) {
            if (key.startsWith(prefix)) {
                this._active.delete(key);
            }
        }
    }

    /** @returns {boolean} True if any animations are in flight */
    get isAnimating() {
        return this._active.size > 0;
    }

    /**
     * Advance all active animations. Call once per frame.
     * @param {number} dt - seconds since last frame
     */
    update(dt) {
        if (this._active.size === 0) return;

        const completed = [];

        for (const [key, anim] of this._active) {
            anim.elapsed += dt;
            const rawT = Math.min(anim.elapsed / anim.duration, 1);
            const t = anim.easing(rawT);

            if (anim.property === 'position') {
                const f = anim.from;
                const to = anim.to;
                anim.object.position.set(
                    f.x + (to.x - f.x) * t,
                    f.y + (to.y - f.y) * t,
                    f.z + (to.z - f.z) * t,
                );
            } else if (anim.property === 'scale') {
                const s = anim.from + (anim.to - anim.from) * t;
                anim.object.scale.setScalar(s);
            } else if (anim.property === 'opacity') {
                const mat = anim.object._background?.material;
                if (mat) {
                    mat.opacity = anim.from + (anim.to - anim.from) * t;
                    mat.transparent = mat.opacity < 1;
                }
            }

            if (rawT >= 1) {
                completed.push(key);
            }
        }

        for (const key of completed) {
            const anim = this._active.get(key);
            this._active.delete(key);
            if (anim?.onComplete) {
                try { anim.onComplete(); } catch (e) {
                    console.error('[SpatialAnimator] onComplete error:', e);
                }
            }
        }
    }

    /**
     * Cancel all animations and clear state.
     */
    dispose() {
        this._active.clear();
    }
}

export default SpatialAnimator;

/**
 * Viewport Renderer
 *
 * Renders a wireframe frustum showing the hand tracking volume.
 * Fed by SceneContext.viewport data from the iPhone source.
 * Shares the same coordinate mapping (spread/depth/scale) as
 * HandRenderer so the frustum aligns with the rendered hand.
 */

import * as THREE from 'three';
import { HAND_RENDERER_DEFAULTS } from './defaults.js';

const FRUSTUM_COLOR = 0x335566;
const FRUSTUM_OPACITY = 0.25;

class ViewportRenderer {
    /**
     * @param {Object} options
     * @param {number} options.color - Wireframe color
     * @param {number} options.opacity - Line opacity
     * @param {number} options.spread - Must match HandRenderer's spread
     * @param {number} options.depth - Must match HandRenderer's depth
     * @param {number} options.scale - Must match HandRenderer's scale
     */
    constructor(options = {}) {
        this.color   = options.color   || FRUSTUM_COLOR;
        this.opacity = options.opacity || FRUSTUM_OPACITY;

        // Placement — same as HandRenderer, applied to group transform
        this._spread = options.spread ?? HAND_RENDERER_DEFAULTS.spread;
        this._depth  = options.depth  ?? HAND_RENDERER_DEFAULTS.depth;
        this._scale  = options.scale  ?? HAND_RENDERER_DEFAULTS.scale;

        this.group = new THREE.Group();
        this.group.visible = false;
        this._applyGroupTransform();

        // 12 edges: 4 near + 4 far + 4 connecting
        const positions = new Float32Array(12 * 2 * 3);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        const material = new THREE.LineBasicMaterial({
            color: this.color,
            transparent: true,
            opacity: this.opacity,
        });

        this.lines = new THREE.LineSegments(geometry, material);
        this.group.add(this.lines);

        this._geometry = geometry;

        // High-water-mark depth range: only expands, never shrinks.
        // Smooths out the "breathing" from live hand-position-based depth data.
        this._hwmNear = Infinity;
        this._hwmFar = -Infinity;
    }

    /** @private */
    _applyGroupTransform() {
        this.group.position.set(0, 0, this._depth);
        const s = this._spread * this._scale;
        this.group.scale.set(s, s, s);
    }

    get spread() { return this._spread; }
    set spread(v) { this._spread = v; this._applyGroupTransform(); }

    get depth() { return this._depth; }
    set depth(v) { this._depth = v; this._applyGroupTransform(); }

    get scale() { return this._scale; }
    set scale(v) { this._scale = v; this._applyGroupTransform(); }

    /**
     * Parent under `parent`, whose space is treated as camera-local.
     *
     * NOT the camera itself: `render(scene, camera)` traverses only the scene, so
     * a camera outside the scene graph never has its children drawn. Pass a
     * scene-resident rig that follows the camera (see HandPresence).
     *
     * @param {THREE.Object3D} parent
     */
    attachTo(parent) {
        parent.add(this.group);
    }

    /**
     * Detach from parent
     */
    detach() {
        if (this.group.parent) {
            this.group.parent.remove(this.group);
        }
    }

    /**
     * Update frustum from scene context.
     * @param {SceneContext|null} scene
     */
    updateFromScene(scene) {
        const vp = scene?.viewport;
        if (!vp) {
            this.group.visible = false;
            return;
        }

        // High-water-mark: only expand the observed range, never shrink.
        // This stabilizes the frustum even if the source sends live hand depth.
        const rawNear = (vp.depthRange?.[0] > 0) ? vp.depthRange[0] : 0.2;
        const rawFar  = (vp.depthRange?.[1] > 0) ? vp.depthRange[1] : 0.8;
        this._hwmNear = Math.min(this._hwmNear, rawNear);
        this._hwmFar  = Math.max(this._hwmFar, rawFar);
        const nearZ = this._hwmNear;
        const farZ  = this._hwmFar;

        const hw = vp.physicalWidth / 2;
        const hh = vp.physicalHeight / 2;

        // Frustum corners in local hand space (same as HandRenderer).
        // Centered around origin, y-flipped, z-negated.
        // The group transform handles placement in the scene.
        const nearCorners = [
            [-hw * nearZ,  hh * nearZ, -nearZ],
            [ hw * nearZ,  hh * nearZ, -nearZ],
            [ hw * nearZ, -hh * nearZ, -nearZ],
            [-hw * nearZ, -hh * nearZ, -nearZ],
        ];

        const farCorners = [
            [-hw * farZ,  hh * farZ, -farZ],
            [ hw * farZ,  hh * farZ, -farZ],
            [ hw * farZ, -hh * farZ, -farZ],
            [-hw * farZ, -hh * farZ, -farZ],
        ];

        // Write 12 line segments
        const arr = this._geometry.attributes.position.array;
        let idx = 0;

        function seg(a, b) {
            arr[idx++] = a[0]; arr[idx++] = a[1]; arr[idx++] = a[2];
            arr[idx++] = b[0]; arr[idx++] = b[1]; arr[idx++] = b[2];
        }

        const n = nearCorners, f = farCorners;
        // Near face
        seg(n[0], n[1]); seg(n[1], n[2]); seg(n[2], n[3]); seg(n[3], n[0]);
        // Far face
        seg(f[0], f[1]); seg(f[1], f[2]); seg(f[2], f[3]); seg(f[3], f[0]);
        // Connecting edges
        seg(n[0], f[0]); seg(n[1], f[1]); seg(n[2], f[2]); seg(n[3], f[3]);

        this._geometry.attributes.position.needsUpdate = true;
        this.group.visible = true;
    }

    /**
     * Show/hide
     * @param {boolean} visible
     */
    setVisible(visible) {
        this.group.visible = visible;
    }

    /**
     * Cleanup
     */
    dispose() {
        this._geometry.dispose();
        this.lines.material.dispose();
        this.detach();
    }
}

export default ViewportRenderer;

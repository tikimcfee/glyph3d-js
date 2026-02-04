/**
 * TouchController Component
 *
 * Handles touch input on the canvas for mobile/tablet:
 * - Single finger: camera look (yaw/pitch)
 * - Two fingers: pinch zoom + pan
 */

export class TouchController {
    /**
     * @param {HTMLCanvasElement} canvas - The Three.js canvas
     * @param {Object} viewer - Object with { yaw, pitch, camera, cameraSpeed } properties
     * @param {THREE} THREE - Three.js module reference
     */
    constructor(canvas, viewer, THREE) {
        this.canvas = canvas;
        this.viewer = viewer;
        this.THREE = THREE;
        this.activeTouches = new Map();
        this.lastPinchDist = 0;
        this.lastTwoCenter = null;

        canvas.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
        canvas.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
        canvas.addEventListener('touchend', (e) => this.onTouchEnd(e), { passive: false });
        canvas.addEventListener('touchcancel', (e) => this.onTouchEnd(e), { passive: false });
    }

    onTouchStart(e) {
        e.preventDefault();
        for (const t of e.changedTouches) {
            this.activeTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
        }
        if (this.activeTouches.size === 2) {
            const pts = [...this.activeTouches.values()];
            this.lastPinchDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
            this.lastTwoCenter = {
                x: (pts[0].x + pts[1].x) / 2,
                y: (pts[0].y + pts[1].y) / 2
            };
        }
    }

    onTouchMove(e) {
        e.preventDefault();
        const THREE = this.THREE;
        const touches = e.changedTouches;

        if (this.activeTouches.size === 1 && touches.length === 1) {
            // Single finger: look
            const t = touches[0];
            const prev = this.activeTouches.get(t.identifier);
            if (prev) {
                const dx = t.clientX - prev.x;
                const dy = t.clientY - prev.y;
                this.viewer.yaw -= dx * 0.003;
                this.viewer.pitch -= dy * 0.003;
                this.viewer.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.viewer.pitch));
                this.activeTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
            }
        } else if (this.activeTouches.size === 2) {
            // Update stored positions
            for (const t of touches) {
                this.activeTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
            }
            const pts = [...this.activeTouches.values()];
            const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
            const center = {
                x: (pts[0].x + pts[1].x) / 2,
                y: (pts[0].y + pts[1].y) / 2
            };

            // Pinch zoom
            if (this.lastPinchDist > 0) {
                const delta = dist - this.lastPinchDist;
                const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.viewer.camera.quaternion);
                this.viewer.camera.position.addScaledVector(forward, delta * this.viewer.cameraSpeed * 0.01);
            }

            // Two-finger pan
            if (this.lastTwoCenter) {
                const dx = center.x - this.lastTwoCenter.x;
                const dy = center.y - this.lastTwoCenter.y;
                const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.viewer.camera.quaternion);
                const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.viewer.camera.quaternion);
                this.viewer.camera.position.addScaledVector(right, -dx * this.viewer.cameraSpeed * 0.005);
                this.viewer.camera.position.addScaledVector(up, dy * this.viewer.cameraSpeed * 0.005);
            }

            this.lastPinchDist = dist;
            this.lastTwoCenter = center;
        }
    }

    onTouchEnd(e) {
        for (const t of e.changedTouches) {
            this.activeTouches.delete(t.identifier);
        }
        if (this.activeTouches.size < 2) {
            this.lastPinchDist = 0;
            this.lastTwoCenter = null;
        }
    }
}

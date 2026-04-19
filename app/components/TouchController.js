/**
 * TouchController Component
 *
 * Handles touch input on the canvas for mobile/tablet:
 * - Single finger: pan (translate camera)
 * - Two fingers: pinch zoom + pan
 *
 * Uses the CameraController's _applyDragTranslation for consistent
 * panning behavior across mouse and touch.
 */

export class TouchController {
    /**
     * @param {HTMLCanvasElement} canvas - The Three.js canvas
     * @param {CameraController} cameraController - Owns settings, ctx.camera, _applyDragTranslation
     * @param {THREE} THREE - Three.js module reference
     */
    constructor(canvas, cameraController, THREE) {
        this.canvas = canvas;
        this.cam = cameraController;
        this.camera = cameraController.ctx.camera;
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

        // Mobile touch needs higher sensitivity — no scroll wheel or
        // mouse precision, so amplify to make panning/zooming feel responsive.
        const TOUCH_SPEED = 5.0;

        if (this.activeTouches.size === 1 && touches.length === 1) {
            // Single finger: pan (translate)
            const t = touches[0];
            const prev = this.activeTouches.get(t.identifier);
            if (prev) {
                const dx = (t.clientX - prev.x) * TOUCH_SPEED;
                const dy = (t.clientY - prev.y) * TOUCH_SPEED;
                this.cam._applyDragTranslation(dx, dy);
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

            // Publish the pinch centroid into the camera controller's
            // input state so the rest of the pipeline (focus probe,
            // zoom-to-cursor parity) can reference where the gesture is
            // happening — same role the mouse cursor plays for wheel.
            const focus = this.cam.input?.focus;
            if (focus) {
                focus.clientX = center.x;
                focus.clientY = center.y;
            }

            // Pinch dolly: fingers spreading = zoom in (negative wheel
            // deltaY equivalent). Scale translates pinch-pixels into
            // wheel-pixels so one shared _zoomBy handles both inputs.
            if (this.lastPinchDist > 0) {
                const pinchDelta = dist - this.lastPinchDist;
                const PINCH_TO_WHEEL = 3.0; // empirical — feels close to one wheel tick per ~33px pinch
                this.cam._zoomBy(-pinchDelta * PINCH_TO_WHEEL);
            }

            // Two-finger pan — centroid drift translates into drag pixels.
            if (this.lastTwoCenter) {
                const dx = (center.x - this.lastTwoCenter.x) * TOUCH_SPEED;
                const dy = (center.y - this.lastTwoCenter.y) * TOUCH_SPEED;
                this.cam._applyDragTranslation(dx, dy);
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

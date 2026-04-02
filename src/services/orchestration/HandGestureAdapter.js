/**
 * HandGestureAdapter
 *
 * Bridges the hand tracking library (src/hand/) to the github-viewer IDE actions.
 * The adapter is the only file that knows about both systems; SelectionManager,
 * CameraController, and ShortcutManager are never modified — they see the same
 * events that mouse/keyboard produce.
 *
 * Gesture → IDE action mapping
 * ─────────────────────────────────────────────────────────────────────────────
 * Pinch (no movement) release     → `canvas-click` CustomEvent on canvas
 *                                    → SelectionManager.handleClick (via existing listener)
 *
 * Pinch + drag (hand moves while  → CameraController._applyDragTranslation(dx, dy)
 *   pinching)                       Maps landmark-space delta to pixel-scale delta
 *                                   so the camera pans at a natural rate.
 *
 * Open-palm swipe (wrist moves,   → CameraController._applyDragTranslation(dx, dy)
 *   no pinch)                       Slower factor than pinch-drag to feel distinct.
 *
 * Two-hand spread (index tips     → CameraController.focusOnGrids()
 *   moving apart)                   Fires once per gesture activation.
 *
 * Architecture notes
 * ──────────────────
 * - Landmark coordinates are 0–1 normalized (x left→right, y top→bottom).
 * - To map hand delta → pixel delta we scale by canvas dimensions, then
 *   multiply by a tuning constant. This keeps camera sensitivity consistent
 *   with the mouse's `dragSensitivity` setting.
 * - Pinch-click vs pinch-drag disambiguation: if the pinch-start to
 *   pinch-end displacement in screen space is below CLICK_THRESHOLD the
 *   release is treated as a click, otherwise it was a drag (no click emitted).
 * - The adapter owns the HandRenderer and attaches it to the camera.
 *   Callers only need to call `update(frames, deltaTime)` each frame.
 */

import HandRenderer from '../../hand/HandRenderer.js';
import GestureDetector from '../../hand/GestureDetector.js';
import MockHandSource from '../../hand/MockHandSource.js';
import { Joint, landmarkDistance } from '../../hand/HandData.js';

// ── Tuning constants ──────────────────────────────────────────────────────────

/** Normalized-coordinate displacement below which a pinch is a click, not a drag. */
const CLICK_THRESHOLD = 0.015;

/**
 * Multiplier: how many "pixel equivalents" one unit of normalized hand motion
 * translates to when fed into _applyDragTranslation.
 * _applyDragTranslation already scales by canvas height internally, so this
 * factor controls sensitivity relative to mouse drag.
 */
const PINCH_DRAG_SCALE  = 800;  // pinch drag — precise, similar to mouse
const SWIPE_DRAG_SCALE  = 400;  // open-palm swipe — coarser, intentional pan

/** Minimum wrist velocity (normalized/s) before an open-palm pan fires. */
const SWIPE_VELOCITY_THRESHOLD = 0.04;

/**
 * Two-hand spread: minimum distance between index tips (normalized) to trigger.
 * Below this the gesture is considered "closed" again.
 */
const SPREAD_OPEN_THRESHOLD  = 0.35;
const SPREAD_CLOSE_THRESHOLD = 0.25;

// ── HandGestureAdapter ────────────────────────────────────────────────────────

class HandGestureAdapter {
    /**
     * @param {Object} opts
     * @param {THREE.Camera}      opts.camera           - Scene camera (hand attaches here)
     * @param {HTMLCanvasElement} opts.canvas           - WebGL canvas for click events
     * @param {Object}            opts.cameraController - CameraController instance
     * @param {Object}            [opts.handRendererOptions] - Overrides for HandRenderer
     */
    constructor({ camera, canvas, cameraController, handRendererOptions = {} } = {}) {
        this._camera           = camera;
        this._canvas           = canvas;
        this._cameraController = cameraController;

        // ── Hand renderer — attached as child of camera ────────────────────
        this._handRenderer = new HandRenderer({
            lineColor:  0x00ff88,
            jointColor: 0x00ffcc,
            jointSize:  0.006,
            boneRadius: 0.003,
            spread:     0.45,
            depth:      -1.85,
            scale:      1.40,
            ...handRendererOptions,
        });
        this._handRenderer.attachToCamera(camera);

        // ── Gesture detectors — one per hand slot ─────────────────────────
        // Primary (right) hand
        this._gestureDetector = new GestureDetector({
            onPinchStart: (pos) => this._onPinchStart(pos),
            onPinchMove:  (pos, start) => this._onPinchMove(pos, start),
            onPinchEnd:   (pos) => this._onPinchEnd(pos),
        });

        // Secondary (left) hand — used for two-hand spread detection
        this._gestureDetectorLeft = new GestureDetector();

        // ── Per-frame state ───────────────────────────────────────────────
        /** @type {{x,y,z}|null} Previous wrist position for swipe velocity */
        this._prevWristPos  = null;
        /** @type {{x,y,z}|null} Previous left wrist position */
        this._prevWristLeft = null;

        /** Whether the current pinch has moved far enough to count as a drag. */
        this._pinchDragging = false;
        /** Normalized start position of the current pinch. */
        this._pinchStartNorm = null;
        /** Previous pinch position (normalized) for per-frame delta. */
        this._prevPinchPos   = null;

        // Two-hand spread state
        this._spreadActive = false;

        // Active source (null when adapter is disabled)
        this._source     = null;
        this._sourceType = null;

        // Whether the adapter is enabled at all
        this._enabled = false;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Enable the adapter with a given source type.
     * Can be called again to switch sources.
     * @param {'mock'|'websocket'} sourceType
     * @param {Object} [sourceOptions] - Extra options forwarded to source constructor
     */
    enable(sourceType = 'mock', sourceOptions = {}) {
        this._disposeSource();

        this._sourceType = sourceType;
        this._enabled    = true;

        if (sourceType === 'mock') {
            this._source = new MockHandSource({ canvas: this._canvas, ...sourceOptions });
        } else if (sourceType === 'websocket') {
            // Dynamic import to avoid hard dependency when not used
            import('../../hand/WebSocketHandSource.js').then(({ default: WebSocketHandSource }) => {
                this._source = new WebSocketHandSource({
                    url: sourceOptions.url || `ws://localhost:${(typeof window !== 'undefined' && window.location.port) || 8080}`,
                    ...sourceOptions,
                });
                this._source.connect();
            });
        }

        // Reset per-frame state on source change
        this._prevWristPos   = null;
        this._prevWristLeft  = null;
        this._pinchDragging  = false;
        this._pinchStartNorm = null;
        this._prevPinchPos   = null;
        this._spreadActive   = false;

        this._gestureDetector.reset();
        this._gestureDetectorLeft.reset();
    }

    /**
     * Disable the adapter: hides the hand, disposes the source, stops processing.
     */
    disable() {
        this._enabled = false;
        this._disposeSource();
        this._handRenderer.updateFromFrame(null);
    }

    /** Whether the adapter is currently active. */
    get enabled() {
        return this._enabled;
    }

    /**
     * Per-frame update. Call this once per frame from the animation loop.
     * When the adapter is disabled this is a no-op.
     * @param {number} deltaTime - seconds since last frame
     */
    update(deltaTime) {
        if (!this._enabled || !this._source) return;

        // ── Collect frames from source ─────────────────────────────────────
        let frames = null;
        if (this._sourceType === 'websocket') {
            frames = this._source.getLatestFrames?.() || null;
        } else if (this._source.detect) {
            frames = this._source.detect();
        }

        const primaryFrame   = frames ? (frames[0] || null) : null;
        const secondaryFrame = frames ? (frames[1] || null) : null;

        // ── Update 3D renderer (visual feedback) ──────────────────────────
        this._handRenderer.updateFromFrame(primaryFrame);

        // ── Visual color feedback for pinch ───────────────────────────────
        const primaryState = this._gestureDetector.update(primaryFrame);
        if (primaryState.pinching) {
            this._handRenderer.setColor(0xff4488);
            this._handRenderer.setJointColor(0xff88aa);
        } else {
            this._handRenderer.setColor(0x00ff88);
            this._handRenderer.setJointColor(0x00ffcc);
        }

        // ── Open-palm swipe (wrist velocity, no pinch) ────────────────────
        if (!primaryState.pinching && primaryFrame) {
            this._processPalmSwipe(primaryFrame, deltaTime);
        } else {
            this._prevWristPos = primaryFrame
                ? primaryFrame.landmarks[Joint.WRIST]
                : null;
        }

        // ── Two-hand spread ───────────────────────────────────────────────
        if (secondaryFrame) {
            this._gestureDetectorLeft.update(secondaryFrame);
            this._processTwoHandSpread(primaryFrame, secondaryFrame);
        } else {
            this._spreadActive = false;
        }
    }

    /**
     * Detach the hand renderer from the camera and dispose GPU resources.
     * Call when tearing down the app or removing hand tracking permanently.
     */
    dispose() {
        this._disposeSource();
        this._handRenderer.dispose();
    }

    // ── Gesture handlers (called by GestureDetector) ──────────────────────────

    /** @private */
    _onPinchStart(pos) {
        this._pinchStartNorm = { ...pos };
        this._prevPinchPos   = { ...pos };
        this._pinchDragging  = false;
    }

    /** @private */
    _onPinchMove(pos, startPos) {
        if (!this._prevPinchPos) {
            this._prevPinchPos = { ...pos };
            return;
        }

        // Frame delta in normalized coords
        const dx = pos.x - this._prevPinchPos.x;
        const dy = pos.y - this._prevPinchPos.y;
        this._prevPinchPos = { ...pos };

        // Check if displacement from start is large enough to call this a drag
        if (this._pinchStartNorm) {
            const totalDx = pos.x - this._pinchStartNorm.x;
            const totalDy = pos.y - this._pinchStartNorm.y;
            const totalDisp = Math.sqrt(totalDx * totalDx + totalDy * totalDy);
            if (totalDisp > CLICK_THRESHOLD) {
                this._pinchDragging = true;
            }
        }

        // Apply camera pan from pinch drag
        const pxDx = dx * PINCH_DRAG_SCALE;
        const pxDy = dy * PINCH_DRAG_SCALE;
        this._cameraController._applyDragTranslation(pxDx, pxDy);
    }

    /** @private */
    _onPinchEnd(pos) {
        if (!this._pinchDragging) {
            // Small movement: treat as click
            this._emitCanvasClick(pos);
        }

        this._pinchStartNorm = null;
        this._prevPinchPos   = null;
        this._pinchDragging  = false;
    }

    // ── Swipe / spread processors ─────────────────────────────────────────────

    /**
     * Detect open-palm swipe from wrist velocity and pan the camera.
     * @private
     * @param {HandFrame} frame
     * @param {number} deltaTime
     */
    _processPalmSwipe(frame, deltaTime) {
        const wrist = frame.landmarks[Joint.WRIST];

        if (this._prevWristPos && deltaTime > 0) {
            const vx = (wrist.x - this._prevWristPos.x) / deltaTime;
            const vy = (wrist.y - this._prevWristPos.y) / deltaTime;
            const speed = Math.sqrt(vx * vx + vy * vy);

            if (speed > SWIPE_VELOCITY_THRESHOLD) {
                const dx = (wrist.x - this._prevWristPos.x) * SWIPE_DRAG_SCALE;
                const dy = (wrist.y - this._prevWristPos.y) * SWIPE_DRAG_SCALE;
                this._cameraController._applyDragTranslation(dx, dy);
            }
        }

        this._prevWristPos = { ...wrist };
    }

    /**
     * Detect two-hand spread and trigger focusOnGrids when the gesture opens.
     * @private
     * @param {HandFrame} primary
     * @param {HandFrame} secondary
     */
    _processTwoHandSpread(primary, secondary) {
        if (!primary || !secondary) {
            this._spreadActive = false;
            return;
        }

        const indexTipR = primary.landmarks[Joint.INDEX_TIP];
        const indexTipL = secondary.landmarks[Joint.INDEX_TIP];

        const dist = landmarkDistance(indexTipR, indexTipL);

        if (!this._spreadActive && dist > SPREAD_OPEN_THRESHOLD) {
            this._spreadActive = true;
            // Fire fit-all
            if (this._cameraController.focusOnGrids) {
                this._cameraController.focusOnGrids();
            }
        } else if (this._spreadActive && dist < SPREAD_CLOSE_THRESHOLD) {
            this._spreadActive = false;
        }
    }

    // ── Click emission ────────────────────────────────────────────────────────

    /**
     * Convert a normalized pinch position to canvas pixel coords and emit a
     * `canvas-click` CustomEvent — the same event the mouse path emits.
     * SelectionManager's existing listener on the canvas handles it from there.
     * @private
     * @param {{x, y}} normalizedPos - 0–1 normalized position
     */
    _emitCanvasClick(normalizedPos) {
        const rect    = this._canvas.getBoundingClientRect();
        const clientX = rect.left + normalizedPos.x * rect.width;
        const clientY = rect.top  + normalizedPos.y * rect.height;

        this._canvas.dispatchEvent(new CustomEvent('canvas-click', {
            detail: {
                clientX,
                clientY,
                shiftKey: false,
                ctrlKey:  false,
                metaKey:  false,
            },
            bubbles: true,
        }));
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    /** @private */
    _disposeSource() {
        if (this._source) {
            this._source.dispose?.();
            this._source = null;
        }
    }
}

export { HandGestureAdapter };
export default HandGestureAdapter;

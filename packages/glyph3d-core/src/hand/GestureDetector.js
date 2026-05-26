/**
 * Gesture Detector
 *
 * Detects hand gestures from HandFrame landmark data.
 * Currently supports pinch (thumb tip to index tip).
 * Uses hysteresis thresholds to prevent flickering.
 */

import { Joint, landmarkDistance } from './HandData.js';
import { GESTURE_DEFAULTS } from './defaults.js';

class GestureDetector {
    /**
     * @param {Object} options
     * @param {number} options.pinchThreshold - Distance below which pinch starts
     * @param {number} options.pinchReleaseThreshold - Distance above which pinch ends
     * @param {Function} options.onPinchStart - Called with position when pinch begins
     * @param {Function} options.onPinchMove - Called with (position, startPosition) during pinch
     * @param {Function} options.onPinchEnd - Called with final position when pinch ends
     * @param {Function} options.onGestureUpdate - Called every frame with full gesture state
     */
    constructor(options = {}) {
        this.pinchThreshold = options.pinchThreshold || GESTURE_DEFAULTS.pinchThreshold;
        this.pinchReleaseThreshold = options.pinchReleaseThreshold || GESTURE_DEFAULTS.pinchReleaseThreshold;

        // Current gesture state
        this.state = {
            pinching: false,
            pinchStartPosition: null,
            pinchPosition: null,
        };

        // Callbacks
        this.onPinchStart = options.onPinchStart || null;
        this.onPinchMove = options.onPinchMove || null;
        this.onPinchEnd = options.onPinchEnd || null;
        this.onGestureUpdate = options.onGestureUpdate || null;
    }

    /**
     * Process a hand frame and update gesture state.
     * Call this every frame with the latest hand data.
     * @param {HandFrame|null} frame
     * @returns {Object} Current gesture state
     */
    update(frame) {
        if (!frame || !frame.landmarks || frame.landmarks.length < 21) {
            // Hand lost — end any active gesture
            if (this.state.pinching) {
                this._endPinch();
            }
            return this.state;
        }

        const landmarks = frame.landmarks;

        // Pinch: thumb tip ↔ index tip distance
        const thumbTip = landmarks[Joint.THUMB_TIP];
        const indexTip = landmarks[Joint.INDEX_TIP];
        const pinchDist = landmarkDistance(thumbTip, indexTip);

        // Midpoint between thumb and index tips = pinch location
        const pinchPoint = {
            x: (thumbTip.x + indexTip.x) / 2,
            y: (thumbTip.y + indexTip.y) / 2,
            z: (thumbTip.z + indexTip.z) / 2,
        };

        // State machine with hysteresis
        if (!this.state.pinching && pinchDist < this.pinchThreshold) {
            this._startPinch(pinchPoint);
        } else if (this.state.pinching && pinchDist > this.pinchReleaseThreshold) {
            this._endPinch();
        } else if (this.state.pinching) {
            this.state.pinchPosition = pinchPoint;
            if (this.onPinchMove) {
                this.onPinchMove(pinchPoint, this.state.pinchStartPosition);
            }
        }

        if (this.onGestureUpdate) {
            this.onGestureUpdate({
                ...this.state,
                pinchDistance: pinchDist,
                wristPosition: landmarks[Joint.WRIST],
                indexTipPosition: indexTip,
            });
        }

        return this.state;
    }

    /** @private */
    _startPinch(position) {
        this.state.pinching = true;
        this.state.pinchStartPosition = { ...position };
        this.state.pinchPosition = { ...position };
        if (this.onPinchStart) {
            this.onPinchStart(position);
        }
    }

    /** @private */
    _endPinch() {
        const lastPosition = this.state.pinchPosition;
        this.state.pinching = false;
        this.state.pinchStartPosition = null;
        this.state.pinchPosition = null;
        if (this.onPinchEnd) {
            this.onPinchEnd(lastPosition);
        }
    }

    /**
     * Reset all gesture state, ending active gestures
     */
    reset() {
        if (this.state.pinching) {
            this._endPinch();
        }
    }
}

export default GestureDetector;

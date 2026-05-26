/**
 * Webcam Hand Source
 *
 * Uses MediaPipe Hands (loaded from CDN) to detect hand landmarks
 * from a webcam feed. Detection runs synchronously on the main thread
 * with a configurable throttle. The render loop stays at 60fps by
 * returning cached results between detections.
 */

import { Joint, JOINT_COUNT } from './HandData.js';
import { WEBCAM_SOURCE_DEFAULTS as DEFAULTS } from './defaults.js';

const MEDIAPIPE_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18';
const VISION_BUNDLE_URL = `${MEDIAPIPE_CDN}/vision_bundle.mjs`;
const WASM_URL = `${MEDIAPIPE_CDN}/wasm`;
const HAND_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task';

class WebcamHandSource {
    /**
     * @param {Object} options
     * @param {number} options.numHands - Max hands to detect (default 1)
     * @param {number} options.detectInterval - Ms between detections (default 33)
     * @param {boolean} options.firstPerson - First-person corrections (default true)
     * @param {number} options.referenceSpan - Palm width reference for depth estimation
     * @param {number} options.depthScale - Depth estimation multiplier
     * @param {Function} options.onFrame - Called with array of HandFrames each detection
     * @param {Function} options.onReady - Called when initialization is complete
     * @param {Function} options.onError - Called on initialization error
     */
    constructor(options = {}) {
        this.videoElement = null;
        this.handLandmarker = null;
        this.lastDetectTime = 0;
        this.cachedFrames = null;

        const o = { ...DEFAULTS, ...options };
        this.detectInterval = o.detectInterval;
        this.numHands       = o.numHands;
        this.referenceSpan  = o.referenceSpan;
        this.depthScale     = o.depthScale;
        this.firstPerson    = o.firstPerson;

        this.onFrame = options.onFrame || null;
        this.onReady = options.onReady || null;
        this.onError = options.onError || null;
    }

    /**
     * Initialize MediaPipe and webcam.
     */
    async init() {
        try {
            const vision = await import(VISION_BUNDLE_URL);
            const { HandLandmarker, FilesetResolver } = vision;

            const wasmFileset = await FilesetResolver.forVisionTasks(WASM_URL);

            this.handLandmarker = await HandLandmarker.createFromOptions(wasmFileset, {
                baseOptions: {
                    modelAssetPath: HAND_MODEL_URL,
                    // CPU delegate — GPU delegate deadlocks with Three.js
                    // when both share the main thread's WebGL context.
                    delegate: 'CPU',
                },
                numHands: this.numHands,
                runningMode: 'VIDEO',
                minHandDetectionConfidence: 0.5,
                minHandPresenceConfidence: 0.5,
                minTrackingConfidence: 0.5,
            });

            this.videoElement = document.createElement('video');
            this.videoElement.setAttribute('playsinline', '');
            this.videoElement.setAttribute('autoplay', '');
            this.videoElement.style.cssText = 'position:fixed;top:0;right:0;width:160px;height:120px;opacity:0.3;z-index:100;pointer-events:none;transform:scaleX(-1);';
            document.body.appendChild(this.videoElement);

            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'user', width: 640, height: 480 },
            });
            this.videoElement.srcObject = stream;
            await this.videoElement.play();

            if (this.onReady) this.onReady();
        } catch (err) {
            console.error('[HandWebcam] Init failed:', err);
            if (this.onError) this.onError(err);
            throw err;
        }
    }

    /**
     * Detect hands in current video frame.
     * Throttled — returns cached results between detections.
     * @returns {Array<HandFrame>|null}
     */
    detect() {
        if (!this.handLandmarker || !this.videoElement || this.videoElement.readyState < 2) {
            return this.cachedFrames;
        }

        const now = performance.now();
        if (now - this.lastDetectTime < this.detectInterval) {
            return this.cachedFrames;
        }
        this.lastDetectTime = now;

        try {
            const results = this.handLandmarker.detectForVideo(this.videoElement, now);

            if (!results.landmarks || results.landmarks.length === 0) {
                this.cachedFrames = null;
                return null;
            }

            this.cachedFrames = results.landmarks.map((landmarks, i) => {
                const handedness = results.handednesses?.[i]?.[0]?.categoryName?.toLowerCase() || 'right';

                if (!this.firstPerson) {
                    return {
                        handedness,
                        landmarks: landmarks.map(lm => ({
                            x: 1 - lm.x,
                            y: lm.y,
                            z: lm.z * 0.3,
                        })),
                        timestamp: now,
                    };
                }

                const indexMcp = landmarks[Joint.INDEX_MCP];
                const pinkyMcp = landmarks[Joint.PINKY_MCP];
                const palmWidth = Math.sqrt(
                    (indexMcp.x - pinkyMcp.x) ** 2 +
                    (indexMcp.y - pinkyMcp.y) ** 2
                );
                const depthFromPalm = (palmWidth - this.referenceSpan) * this.depthScale;

                return {
                    handedness,
                    landmarks: landmarks.map(lm => ({
                        x: 1 - lm.x,
                        y: lm.y,
                        z: depthFromPalm - lm.z,
                    })),
                    timestamp: now,
                };
            });

            if (this.onFrame) this.onFrame(this.cachedFrames);
        } catch (err) {
            console.warn('[HandWebcam] Detection error:', err);
        }

        return this.cachedFrames;
    }

    /**
     * Cleanup
     */
    dispose() {
        if (this.videoElement) {
            const stream = this.videoElement.srcObject;
            if (stream) {
                stream.getTracks().forEach(t => t.stop());
            }
            this.videoElement.remove();
            this.videoElement = null;
        }
        if (this.handLandmarker) {
            this.handLandmarker.close();
            this.handLandmarker = null;
        }
    }
}

export default WebcamHandSource;

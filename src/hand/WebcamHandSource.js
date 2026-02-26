/**
 * Webcam Hand Source
 *
 * Uses MediaPipe Hands (loaded from CDN) to detect hand landmarks
 * from a webcam feed. Produces HandFrame objects compatible with
 * HandRenderer and GestureDetector.
 *
 * Quality: decent for basic tracking (~30fps, 21 landmarks).
 * Depth is estimated (not measured like LiDAR), but sufficient
 * for relative positioning and gesture detection.
 */

import { Joint, JOINT_COUNT } from './HandData.js';

// Default reference hand span (wrist-to-middle-fingertip) at a comfortable distance.
const DEFAULT_REFERENCE_SPAN = 0.2;
const DEFAULT_DEPTH_SCALE = 7.0;

const MEDIAPIPE_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18';
const VISION_BUNDLE_URL = `${MEDIAPIPE_CDN}/vision_bundle.mjs`;
const WASM_URL = `${MEDIAPIPE_CDN}/wasm`;
const HAND_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task';

class WebcamHandSource {
    /**
     * @param {Object} options
     * @param {number} options.numHands - Max hands to detect (default 1)
     * @param {Function} options.onFrame - Called with array of HandFrames each detection
     * @param {Function} options.onReady - Called when initialization is complete
     * @param {Function} options.onError - Called on initialization error
     */
    constructor(options = {}) {
        this.videoElement = null;
        this.handLandmarker = null;
        this.lastDetectTime = 0;
        this.detectInterval = options.detectInterval || 66; // ~15fps detection
        this.cachedFrames = null; // reuse between detections

        this.numHands = options.numHands || 1;
        this.referenceSpan = options.referenceSpan || DEFAULT_REFERENCE_SPAN;
        this.depthScale = options.depthScale || DEFAULT_DEPTH_SCALE;
        this.onFrame = options.onFrame || null;
        this.onReady = options.onReady || null;
        this.onError = options.onError || null;
    }

    /**
     * Initialize MediaPipe and webcam.
     * Must be called before detect().
     */
    async init() {
        try {
            // Dynamic import — no build step needed
            const vision = await import(VISION_BUNDLE_URL);
            const { HandLandmarker, FilesetResolver } = vision;

            const wasmFileset = await FilesetResolver.forVisionTasks(WASM_URL);

            this.handLandmarker = await HandLandmarker.createFromOptions(wasmFileset, {
                baseOptions: {
                    modelAssetPath: HAND_MODEL_URL,
                    // CPU delegate avoids WebGL context competition with Three.js
                    delegate: 'CPU',
                },
                numHands: this.numHands,
                runningMode: 'VIDEO',
                minHandDetectionConfidence: 0.5,
                minHandPresenceConfidence: 0.5,
                minTrackingConfidence: 0.5,
            });

            // Set up hidden video element for webcam feed
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
            console.error('WebcamHandSource init failed:', err);
            if (this.onError) this.onError(err);
            throw err;
        }
    }

    /**
     * Process current video frame and return hand data.
     * Call this in your render loop.
     * @returns {Array<HandFrame>|null}
     */
    /**
     * Process current video frame and return hand data.
     * Throttled to ~15fps to avoid blocking the render loop.
     * Returns cached results between detections.
     * @returns {Array<HandFrame>|null}
     */
    detect() {
        if (!this.handLandmarker || !this.videoElement || this.videoElement.readyState < 2) {
            return null;
        }

        const now = performance.now();

        // Throttle: only run detection every detectInterval ms
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

                // Estimate hand distance from palm width (index MCP to pinky MCP).
                // Palm width is stable across finger poses (fist, claw, open).
                const indexMcp = landmarks[Joint.INDEX_MCP];
                const pinkyMcp = landmarks[Joint.PINKY_MCP];
                const palmWidth = Math.sqrt(
                    (indexMcp.x - pinkyMcp.x) ** 2 +
                    (indexMcp.y - pinkyMcp.y) ** 2
                );

                // Larger palm in image = hand closer to camera = deeper into scene.
                const depthFromPalm = (palmWidth - this.referenceSpan) * this.depthScale;

                return {
                    handedness,
                    landmarks: landmarks.map(lm => ({
                        x: 1 - lm.x,
                        y: lm.y,
                        z: depthFromPalm + lm.z,
                    })),
                    timestamp: now,
                };
            });

            if (this.onFrame) this.onFrame(this.cachedFrames);
        } catch (err) {
            console.warn('MediaPipe detection error:', err);
            return this.cachedFrames;
        }

        return this.cachedFrames;
    }

    /**
     * Cleanup webcam stream and MediaPipe resources
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

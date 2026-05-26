/**
 * Hand Detection Worker
 *
 * Runs MediaPipe HandLandmarker in a Web Worker so detection
 * doesn't block the main thread render loop.
 *
 * Protocol:
 *   Main → Worker:
 *     { type: 'init', numHands: 1 }
 *     { type: 'detect', imageBitmap: ImageBitmap, timestamp: number }
 *     { type: 'dispose' }
 *
 *   Worker → Main:
 *     { type: 'ready' }
 *     { type: 'result', frames: HandFrame[] | null, timestamp: number }
 *     { type: 'error', message: string }
 */

const MEDIAPIPE_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18';
const VISION_BUNDLE_URL = `${MEDIAPIPE_CDN}/vision_bundle.mjs`;
const WASM_URL = `${MEDIAPIPE_CDN}/wasm`;
const HAND_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task';

let handLandmarker = null;
let frameTimestamp = 0; // monotonically increasing, required by VIDEO mode

self.onmessage = async (event) => {
    const { type } = event.data;

    if (type === 'init') {
        try {
            const vision = await import(VISION_BUNDLE_URL);
            const { HandLandmarker, FilesetResolver } = vision;

            const wasmFileset = await FilesetResolver.forVisionTasks(WASM_URL);

            handLandmarker = await HandLandmarker.createFromOptions(wasmFileset, {
                baseOptions: {
                    modelAssetPath: HAND_MODEL_URL,
                    // CPU delegate in the worker — detection runs off the main
                    // thread so rendering stays at 60fps regardless. GPU delegate
                    // has WebGL texture feedback issues in worker contexts.
                    delegate: 'CPU',
                },
                numHands: event.data.numHands || 1,
                runningMode: 'VIDEO',
                minHandDetectionConfidence: 0.5,
                minHandPresenceConfidence: 0.5,
                minTrackingConfidence: 0.5,
            });

            self.postMessage({ type: 'ready' });
        } catch (err) {
            self.postMessage({ type: 'error', message: err.message });
        }
        return;
    }

    if (type === 'detect') {
        if (!handLandmarker) {
            self.postMessage({ type: 'result', frames: null, timestamp: event.data.timestamp });
            return;
        }

        try {
            const { imageBitmap, timestamp } = event.data;

            // VIDEO mode requires strictly increasing timestamps
            frameTimestamp += 33;
            const results = handLandmarker.detectForVideo(imageBitmap, frameTimestamp);
            imageBitmap.close();

            if (!results.landmarks || results.landmarks.length === 0) {
                self.postMessage({ type: 'result', frames: null, timestamp });
                return;
            }

            const frames = results.landmarks.map((landmarks, i) => ({
                handedness: results.handednesses?.[i]?.[0]?.categoryName?.toLowerCase() || 'right',
                landmarks: landmarks.map(lm => ({ x: lm.x, y: lm.y, z: lm.z })),
                timestamp,
            }));

            self.postMessage({ type: 'result', frames, timestamp });
        } catch (err) {
            self.postMessage({ type: 'error', message: err.message });
        }
        return;
    }

    if (type === 'dispose') {
        if (handLandmarker) {
            handLandmarker.close();
            handLandmarker = null;
        }
        self.close();
    }
};

/**
 * WebSocket Hand Source
 *
 * Receives hand tracking data from an external source (e.g., iPhone ARKit app)
 * over WebSocket. Auto-reconnects on disconnect.
 *
 * Handles two message types:
 *
 * handFrame (every frame, ~30fps):
 * {
 *   "type": "handFrame",
 *   "hands": [{ "handedness": "right", "landmarks": [[x,y,z], ...] }],
 *   "timestamp": 1234567890.123,
 *   "scene": {                          // optional, from ARKit
 *     "intrinsics": { "fx", "fy", "cx", "cy" },
 *     "imageResolution": [1920, 1440],
 *     "cameraTransform": [16 floats, column-major],
 *     "trackingState": "normal",
 *     "lightIntensity": 1000.0
 *   }
 * }
 *
 * cameraFrame (~2fps, low-res preview):
 * {
 *   "type": "cameraFrame",
 *   "timestamp": 1234567890.123,
 *   "image": "<base64 JPEG>",
 *   "width": 320,
 *   "height": 240,
 *   "orientation": "landscapeRight"
 * }
 */

import { WEBSOCKET_SOURCE_DEFAULTS as DEFAULTS } from './defaults.js';

class WebSocketHandSource {
    /**
     * @param {Object} options
     * @param {string} options.url - WebSocket server URL (default ws://localhost:8765)
     * @param {number} options.reconnectInterval - Ms between reconnect attempts (default 3000)
     * @param {Function} options.onFrame - Called with array of HandFrames on each hand message
     * @param {Function} options.onCameraFrame - Called with CameraFrame on each camera snapshot
     * @param {Function} options.onConnect - Called when WebSocket connects
     * @param {Function} options.onDisconnect - Called when WebSocket disconnects
     * @param {Function} options.onError - Called on WebSocket error
     */
    constructor(options = {}) {
        this.url = options.url || DEFAULTS.url;
        this.reconnectInterval = options.reconnectInterval || DEFAULTS.reconnectInterval;

        this.ws = null;
        this.connected = false;
        this.latestFrames = null;
        this.latestScene = null;       // persists — not consumed on read
        this.latestCameraFrame = null;  // consumed on read — large data
        this._reconnectTimer = null;

        this.onFrame = options.onFrame || null;
        this.onCameraFrame = options.onCameraFrame || null;
        this.onConnect = options.onConnect || null;
        this.onDisconnect = options.onDisconnect || null;
        this.onError = options.onError || null;
    }

    /**
     * Open the WebSocket connection
     */
    connect() {
        try {
            this.ws = new WebSocket(this.url);

            this.ws.onopen = () => {
                this.connected = true;
                console.log(`[HandWS] Connected to ${this.url}`);
                if (this.onConnect) this.onConnect();
            };

            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this._handleMessage(data);
                } catch (err) {
                    console.warn('[HandWS] Failed to parse message:', err);
                }
            };

            this.ws.onclose = () => {
                this.connected = false;
                console.log('[HandWS] Disconnected');
                if (this.onDisconnect) this.onDisconnect();
                this._scheduleReconnect();
            };

            this.ws.onerror = (err) => {
                console.warn('[HandWS] Error:', err);
                if (this.onError) this.onError(err);
            };
        } catch (err) {
            console.error('[HandWS] Connection failed:', err);
            this._scheduleReconnect();
        }
    }

    /** @private */
    _handleMessage(data) {
        if (data.type === 'handFrame' && data.hands) {
            // Parse scene context if present
            if (data.scene) {
                this.latestScene = data.scene;
            }

            this.latestFrames = data.hands.map(hand => {
                const frame = {
                    handedness: hand.handedness || 'right',
                    landmarks: hand.landmarks.map(lm =>
                        Array.isArray(lm)
                            ? { x: lm[0], y: lm[1], z: lm[2] || 0 }
                            : { x: lm.x, y: lm.y, z: lm.z || 0 }
                    ),
                    timestamp: data.timestamp || performance.now(),
                };

                // Attach scene context to each frame
                if (this.latestScene) {
                    frame.scene = this.latestScene;
                }

                return frame;
            });

            if (this.onFrame) this.onFrame(this.latestFrames);

        } else if (data.type === 'cameraFrame') {
            this.latestCameraFrame = {
                image: data.image,
                width: data.width,
                height: data.height,
                timestamp: data.timestamp || performance.now(),
                orientation: data.orientation || null,
            };

            if (this.onCameraFrame) this.onCameraFrame(this.latestCameraFrame);
        }
    }

    /** @private */
    _scheduleReconnect() {
        if (this._reconnectTimer) return;
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            if (!this.connected) {
                console.log('[HandWS] Reconnecting...');
                this.connect();
            }
        }, this.reconnectInterval);
    }

    /**
     * Get latest hand frames (consuming — returns null until new data).
     * @returns {Array<HandFrame>|null}
     */
    getLatestFrames() {
        const frames = this.latestFrames;
        this.latestFrames = null;
        return frames;
    }

    /**
     * Get latest scene context (non-consuming — persists until updated).
     * @returns {SceneContext|null}
     */
    getLatestScene() {
        return this.latestScene;
    }

    /**
     * Get latest camera frame (consuming — large data, cleared after read).
     * @returns {CameraFrame|null}
     */
    getLatestCameraFrame() {
        const frame = this.latestCameraFrame;
        this.latestCameraFrame = null;
        return frame;
    }

    /**
     * Close the connection and stop reconnecting
     */
    disconnect() {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
    }

    /**
     * Cleanup
     */
    dispose() {
        this.disconnect();
    }
}

export default WebSocketHandSource;

/**
 * WebSocket Hand Source
 *
 * Receives hand tracking data from an external source (e.g., iPhone ARKit app)
 * over WebSocket. Auto-reconnects on disconnect.
 *
 * Expected message format from the sender:
 * {
 *   "type": "handFrame",
 *   "hands": [{
 *     "handedness": "right",
 *     "landmarks": [[x, y, z], [x, y, z], ...]  // 21 entries, array format
 *   }],
 *   "timestamp": 1234567890.123
 * }
 *
 * Also accepts object format for landmarks: { "x": 0.5, "y": 0.5, "z": 0.0 }
 */

class WebSocketHandSource {
    /**
     * @param {Object} options
     * @param {string} options.url - WebSocket server URL (default ws://localhost:8765)
     * @param {number} options.reconnectInterval - Ms between reconnect attempts (default 3000)
     * @param {Function} options.onFrame - Called with array of HandFrames on each message
     * @param {Function} options.onConnect - Called when WebSocket connects
     * @param {Function} options.onDisconnect - Called when WebSocket disconnects
     * @param {Function} options.onError - Called on WebSocket error
     */
    constructor(options = {}) {
        this.url = options.url || 'ws://localhost:8765';
        this.reconnectInterval = options.reconnectInterval || 3000;

        this.ws = null;
        this.connected = false;
        this.latestFrames = null;
        this._reconnectTimer = null;

        this.onFrame = options.onFrame || null;
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
                    if (data.type === 'handFrame' && data.hands) {
                        this.latestFrames = data.hands.map(hand => ({
                            handedness: hand.handedness || 'right',
                            landmarks: hand.landmarks.map(lm =>
                                Array.isArray(lm)
                                    ? { x: lm[0], y: lm[1], z: lm[2] || 0 }
                                    : { x: lm.x, y: lm.y, z: lm.z || 0 }
                            ),
                            timestamp: data.timestamp || performance.now(),
                        }));
                        if (this.onFrame) this.onFrame(this.latestFrames);
                    }
                } catch (err) {
                    console.warn('[HandWS] Failed to parse frame:', err);
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
     * Get latest frames (polling style, for render loop).
     * Consumes the data — returns null on subsequent calls until new data arrives.
     * @returns {Array<HandFrame>|null}
     */
    getLatestFrames() {
        const frames = this.latestFrames;
        this.latestFrames = null;
        return frames;
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
            this.ws.onclose = null; // prevent auto-reconnect
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

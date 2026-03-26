/**
 * WebSocketBridge - browser-side WebSocket client for command relay.
 *
 * Connects to the Python/Node relay server, registers as "display",
 * routes incoming commands through the CommandRouter, sends responses back.
 *
 * Features:
 * - Auto-reconnect with exponential backoff
 * - LAN address detection and display in status bar
 * - Connection modes: localhost, LAN, custom URL
 * - Structured JSON responses for programmatic controllers
 * - Status bar UI element showing connection state and address
 */

export default class WebSocketBridge {
    /**
     * @param {import('./CommandRouter.js').default} router
     * @param {Object} [options]
     * @param {string} [options.url] - override relay URL (default auto-detect)
     * @param {number} [options.port=8765] - relay server port
     * @param {boolean} [options.autoConnect=true] - connect on construction
     * @param {boolean} [options.showStatus=true] - show status bar element
     */
    constructor(router, options = {}) {
        this.router = router;
        this.port = options.port || 8765;
        this.url = options.url || null;

        this.ws = null;
        this.connected = false;
        this.clientId = null;  // assigned by relay on registration

        // Reconnect config
        this._reconnectDelay = 2000;
        this._maxReconnectDelay = 30000;
        this._currentDelay = this._reconnectDelay;
        this._reconnectTimer = null;
        this._intentionalClose = false;

        // LAN address detection
        this._lanAddress = null;
        this._detectLanAddress();

        // Status bar UI
        this._statusEl = null;
        if (options.showStatus !== false) {
            this._createStatusBar();
        }

        // Stats
        this._commandsReceived = 0;
        this._commandsSent = 0;
        this._connectedClients = new Set();

        if (options.autoConnect !== false) {
            this.connect();
        }
    }

    // ============ Connection ============

    /**
     * Connect to the relay server.
     * @param {string} [url] - override URL for this connection attempt
     */
    connect(url) {
        if (url) this.url = url;
        if (!this.url) {
            this.url = `ws://localhost:${this.port}`;
        }
        this._intentionalClose = false;
        this._doConnect();
    }

    /**
     * Connect via LAN address (for phone/tablet control).
     */
    connectLAN() {
        if (!this._lanAddress) {
            console.warn('[ws-bridge] LAN address not detected');
            return;
        }
        this.url = `ws://${this._lanAddress}:${this.port}`;
        this._intentionalClose = false;
        this._doConnect();
    }

    /**
     * Disconnect from the relay.
     */
    disconnect() {
        this._intentionalClose = true;
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
        this._updateStatus();
        console.log('[ws-bridge] disconnected');
    }

    /**
     * Send a raw message to the relay (for display->controller responses).
     * @param {string} raw
     */
    send(raw) {
        if (this.ws && this.connected) {
            this.ws.send(raw);
        }
    }

    // ============ LAN Detection ============

    /**
     * Detect the LAN address using WebRTC ICE candidates.
     * Falls back to page hostname if not localhost.
     * @private
     */
    _detectLanAddress() {
        // If the page was loaded via a LAN IP, use that
        const hostname = window.location.hostname;
        if (hostname && hostname !== 'localhost' && hostname !== '127.0.0.1' && !hostname.startsWith('[')) {
            this._lanAddress = hostname;
            return;
        }

        // Try WebRTC-based detection (works in most browsers)
        try {
            const pc = new RTCPeerConnection({ iceServers: [] });
            pc.createDataChannel('');
            pc.createOffer().then(offer => pc.setLocalDescription(offer));
            pc.onicecandidate = (event) => {
                if (!event || !event.candidate) return;
                const parts = event.candidate.candidate.split(' ');
                // ICE candidate format: ... <IP> <port> ...
                const ip = parts[4];
                if (ip && !ip.startsWith('127.') && !ip.includes(':')) {
                    this._lanAddress = ip;
                    this._updateStatus();
                    pc.close();
                }
            };
            // Cleanup after timeout
            setTimeout(() => { try { pc.close(); } catch(e) {} }, 5000);
        } catch (e) {
            // WebRTC not available
        }
    }

    /**
     * Get the detected LAN address.
     * @returns {string|null}
     */
    getLanAddress() {
        return this._lanAddress;
    }

    /**
     * Get the full connection URL for external controllers.
     * @returns {string}
     */
    getConnectionInfo() {
        const localhost = `ws://localhost:${this.port}`;
        const lan = this._lanAddress ? `ws://${this._lanAddress}:${this.port}` : null;
        return { localhost, lan, connected: this.connected, url: this.url };
    }

    // ============ Status Bar UI ============

    /**
     * Create and inject the status bar element into the page.
     * @private
     */
    _createStatusBar() {
        this._statusEl = document.createElement('div');
        this._statusEl.id = 'ws-status-bar';
        Object.assign(this._statusEl.style, {
            position: 'fixed',
            bottom: '8px',
            right: '8px',
            padding: '6px 12px',
            borderRadius: '6px',
            fontSize: '11px',
            fontFamily: 'monospace',
            color: '#888',
            backgroundColor: 'rgba(10, 10, 10, 0.85)',
            border: '1px solid #333',
            zIndex: '10000',
            cursor: 'pointer',
            userSelect: 'none',
            transition: 'all 0.3s ease',
            maxWidth: '350px',
        });

        this._statusEl.addEventListener('click', () => {
            this._showConnectionDetails();
        });

        document.body.appendChild(this._statusEl);
        this._updateStatus();
    }

    /**
     * Update the status bar text and color.
     * @private
     */
    _updateStatus() {
        if (!this._statusEl) return;

        if (this.connected) {
            const addr = this._lanAddress ? `LAN: ${this._lanAddress}:${this.port}` : `localhost:${this.port}`;
            this._statusEl.textContent = `WS: ${addr}`;
            this._statusEl.style.color = '#4ade80';
            this._statusEl.style.borderColor = '#166534';
        } else {
            this._statusEl.textContent = 'WS: disconnected';
            this._statusEl.style.color = '#888';
            this._statusEl.style.borderColor = '#333';
        }
    }

    /**
     * Show a temporary expanded view with full connection details.
     * @private
     */
    _showConnectionDetails() {
        if (!this._statusEl) return;

        const info = this.getConnectionInfo();
        const lines = [
            `Status: ${this.connected ? 'CONNECTED' : 'DISCONNECTED'}`,
            `URL: ${this.url || 'none'}`,
            `Localhost: ${info.localhost}`,
        ];
        if (info.lan) {
            lines.push(`LAN: ${info.lan}`);
        }
        lines.push(`Commands: ${this._commandsReceived} received`);

        this._statusEl.textContent = lines.join(' | ');
        this._statusEl.style.maxWidth = '600px';

        // Collapse back after 5 seconds
        setTimeout(() => {
            this._statusEl.style.maxWidth = '350px';
            this._updateStatus();
        }, 5000);
    }

    // ============ Internal Connection Logic ============

    /** @private */
    _doConnect() {
        try {
            this.ws = new WebSocket(this.url);
        } catch (err) {
            console.warn(`[ws-bridge] failed to create WebSocket: ${err.message}`);
            this._scheduleReconnect();
            return;
        }

        this.ws.onopen = () => {
            console.log(`[ws-bridge] connected to ${this.url}`);
            this.connected = true;
            this._currentDelay = this._reconnectDelay;
            // Register as display client
            this.ws.send('DISPLAY');
            this._updateStatus();
        };

        this.ws.onmessage = (event) => {
            this._handleMessage(event.data);
        };

        this.ws.onclose = () => {
            this.connected = false;
            this._updateStatus();
            if (!this._intentionalClose) {
                console.log('[ws-bridge] disconnected, will retry...');
                this._scheduleReconnect();
            }
        };

        this.ws.onerror = () => {
            // Errors are followed by onclose, so just log
            console.warn('[ws-bridge] connection error');
        };
    }

    /** @private */
    _scheduleReconnect() {
        if (this._reconnectTimer) return;
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            console.log(`[ws-bridge] reconnecting...`);
            this._doConnect();
            this._currentDelay = Math.min(this._currentDelay * 1.5, this._maxReconnectDelay);
        }, this._currentDelay);
    }

    /**
     * Handle an incoming message from the relay.
     * @param {string} raw
     * @private
     */
    async _handleMessage(raw) {
        let envelope;
        try {
            envelope = JSON.parse(raw);
        } catch {
            console.log(`[ws-bridge] non-JSON message: ${raw}`);
            return;
        }

        // Registration ack from relay
        if (envelope.ok !== undefined) {
            console.log('[ws-bridge] registered as display');
            return;
        }

        // Client connect/disconnect notifications
        if (envelope.event === 'client_connected') {
            this._connectedClients.add(envelope.clientId);
            console.log(`[ws-bridge] controller connected: ${envelope.clientId}`);
            return;
        }
        if (envelope.event === 'client_disconnected') {
            this._connectedClients.delete(envelope.clientId);
            console.log(`[ws-bridge] controller disconnected: ${envelope.clientId}`);
            return;
        }

        // Command from a controller
        if (envelope.from && envelope.cmd) {
            this._commandsReceived++;
            const result = await this.router.execute(envelope.cmd);

            // Send response back to the originating controller
            const response = {
                to: envelope.from,
                response: result.text,
            };

            // Include structured data if non-null (for programmatic controllers)
            if (result.data !== null) {
                response.data = result.data;
            }

            this.ws.send(JSON.stringify(response));
            return;
        }

        console.log('[ws-bridge] unhandled message:', envelope);
    }

    /**
     * Dispose: disconnect and remove UI elements.
     */
    dispose() {
        this.disconnect();
        if (this._statusEl && this._statusEl.parentNode) {
            this._statusEl.parentNode.removeChild(this._statusEl);
            this._statusEl = null;
        }
    }
}

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
     * @param {number} [options.port=8080] - relay server port
     * @param {boolean} [options.autoConnect=true] - connect on construction
     * @param {boolean} [options.showStatus=true] - show status bar element
     */
    constructor(router, options = {}) {
        this.router = router;
        this.port = options.port || 8080;
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

        // JSON-RPC 2.0 support
        this._rpcId = 0;
        this._rpcPending = new Map();  // id -> { resolve, reject, timer }
        this._rpcNotificationHandler = null;

        // Stats
        this._commandsReceived = 0;
        this._commandsSent = 0;
        this._connectedClients = new Set();

        // Command I/O log (ring buffer, max 200 entries)
        this._log = [];
        this._logMax = 200;
        this._logListeners = [];

        // Connection-state listeners — notified (true) on open, (false) on close.
        // Lets DOM chrome fetch-on-connect and refetch-on-reconnect instead of
        // racing a not-yet-open socket (the relay restarts often in dev).
        this._connectionListeners = new Set();
        // Last broadcast state — so a failed-reconnect storm (close after close,
        // each retry) doesn't spam listeners with repeated `false`.
        this._lastEmitted = null;

        // Binary data-plane frame demux: type byte → handler(id, payload). The bridge
        // is transport-only — byte/terminal semantics register here (terminal OUTPUT).
        this._binaryHandlers = new Map();

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
            // Auto-detect: if served from glyph3d-cli (unified server),
            // connect WebSocket to the same host:port as the page origin.
            const loc = typeof window !== 'undefined' && window.location;
            if (loc && loc.port && loc.protocol === 'http:') {
                this.url = `ws://${loc.hostname}:${loc.port}`;
            } else {
                this.url = `ws://localhost:${this.port}`;
            }
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

    /**
     * Push an event to a specific controller client.
     * Used to forward terminal input, notifications, etc. to the owning agent.
     * @param {string} clientId - target controller
     * @param {Object} payload - { event, data }
     */
    push(clientId, payload) {
        if (!this.connected || !this.ws) return;
        this.ws.send(JSON.stringify({ to: clientId, ...payload }));
    }

    // ============ JSON-RPC 2.0 ============

    /**
     * Send a JSON-RPC 2.0 request and await the response.
     * @param {string} method - e.g. "fs/readFile"
     * @param {Object} params
     * @param {number} [timeoutMs=10000]
     * @returns {Promise<any>} - result field from JSON-RPC response
     * @throws on JSON-RPC error response or timeout
     */
    rpcRequest(method, params, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            if (!this.ws || !this.connected) {
                reject(new Error('WebSocket not connected'));
                return;
            }

            const id = ++this._rpcId;
            const timer = setTimeout(() => {
                this._rpcPending.delete(id);
                reject(new Error(`RPC timeout: ${method} (id=${id})`));
            }, timeoutMs);

            this._rpcPending.set(id, { resolve, reject, timer });

            const msg = JSON.stringify({
                jsonrpc: '2.0',
                id,
                method,
                params,
            });
            this.ws.send(msg);
        });
    }

    /**
     * Subscribe to connection-state changes. The callback fires with `true` when
     * the socket opens (including reconnects) and `false` when it closes. If
     * already connected, fires `true` immediately so subscribers needn't special-
     * case the "subscribed after connect" race.
     * @param {(connected: boolean) => void} fn
     * @returns {() => void} unsubscribe
     */
    onConnectionChange(fn) {
        this._connectionListeners.add(fn);
        if (this.connected) {
            try { fn(true); } catch (e) { console.error('[ws-bridge] connection listener threw:', e); }
        }
        return () => this._connectionListeners.delete(fn);
    }

    /** @private */
    _emitConnection(state) {
        if (state === this._lastEmitted) return;  // ignore repeated false during a reconnect storm
        this._lastEmitted = state;
        for (const fn of this._connectionListeners) {
            try { fn(state); } catch (e) { console.error('[ws-bridge] connection listener threw:', e); }
        }
    }

    /**
     * Register a handler for JSON-RPC notifications (messages with method but no id).
     * Used for fs/didChange push notifications from the relay.
     * @param {Function} fn - (method, params) => void
     */
    setRpcNotificationHandler(fn) {
        this._rpcNotificationHandler = fn;
    }

    /**
     * Register a handler for binary data-plane frames of a given type byte. Wire
     * frame: [type:u8][idLen:u8][id:utf8][payload]; the handler receives
     * (id, payload:Uint8Array). Used for the terminal OUTPUT byte stream.
     * @param {number} type
     * @param {(id: string, payload: Uint8Array) => void} fn
     * @returns {() => void} unsubscribe
     */
    onBinaryFrame(type, fn) {
        this._binaryHandlers.set(type, fn);
        return () => this._binaryHandlers.delete(type);
    }

    /** @private — parse a binary frame and dispatch to its type handler. */
    _handleBinary(buf) {
        const view = new Uint8Array(buf);
        if (view.length < 2) return;
        const type = view[0];
        const idLen = view[1];
        if (view.length < 2 + idLen) return;
        const id = new TextDecoder().decode(view.subarray(2, 2 + idLen));
        const payload = view.subarray(2 + idLen);
        const handler = this._binaryHandlers.get(type);
        if (handler) handler(id, payload);
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
        // Close any existing socket before creating a new one
        if (this.ws) {
            try { this.ws.onopen = null; this.ws.onclose = null; this.ws.onerror = null; this.ws.close(); } catch (e) {}
        }

        try {
            this.ws = new WebSocket(this.url);
            this.ws.binaryType = 'arraybuffer'; // terminal OUTPUT frames arrive as ArrayBuffer
        } catch (err) {
            console.warn(`[ws-bridge] failed to create WebSocket: ${err.message}`);
            this._scheduleReconnect();
            return;
        }

        // Capture socket reference — if _doConnect is called again before
        // this socket opens, the closure must use the socket it was bound to.
        const socket = this.ws;

        socket.onopen = () => {
            if (this.ws !== socket) return; // stale socket, ignore
            console.log(`[ws-bridge] connected to ${this.url}`);
            this.connected = true;
            this._currentDelay = this._reconnectDelay;
            // Register as display client
            socket.send('DISPLAY');
            this._updateStatus();
            this._emitConnection(true);
        };

        socket.onmessage = (event) => {
            this._handleMessage(event.data);
        };

        socket.onclose = () => {
            if (this.ws !== socket) return; // stale socket, ignore
            this.connected = false;
            this._updateStatus();
            this._emitConnection(false);
            if (!this._intentionalClose) {
                // Debug-level: when no relay is running this fires on every retry —
                // the visible signal is the connection chip, not the console.
                console.debug('[ws-bridge] disconnected, will retry...');
                this._scheduleReconnect();
            }
        };

        this.ws.onerror = () => {
            // Errors are always followed by onclose (which schedules the retry), so
            // this is just a quiet breadcrumb — no warn-level spam while polling.
            console.debug('[ws-bridge] connection error');
        };
    }

    /** @private */
    _scheduleReconnect() {
        if (this._reconnectTimer) return;
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            console.debug(`[ws-bridge] reconnecting...`);
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
        // Binary frames are the terminal OUTPUT data plane — demux by type byte and
        // return before the JSON path (JSON.parse on an ArrayBuffer would throw).
        if (raw instanceof ArrayBuffer) {
            this._handleBinary(raw);
            return;
        }
        let envelope;
        try {
            envelope = JSON.parse(raw);
        } catch {
            console.log(`[ws-bridge] non-JSON message: ${raw}`);
            return;
        }

        // JSON-RPC 2.0 response or notification — route before command handling
        if (envelope.jsonrpc === '2.0') {
            if (envelope.id != null) {
                // Response to a pending rpcRequest
                const pending = this._rpcPending.get(envelope.id);
                if (pending) {
                    this._rpcPending.delete(envelope.id);
                    clearTimeout(pending.timer);
                    if (envelope.error) {
                        const err = new Error(envelope.error.message || 'RPC error');
                        err.code = envelope.error.code;
                        err.data = envelope.error.data;
                        pending.reject(err);
                    } else {
                        pending.resolve(envelope.result);
                    }
                }
            } else if (envelope.method) {
                // Notification (no id) — e.g. fs/didChange
                if (this._rpcNotificationHandler) {
                    this._rpcNotificationHandler(envelope.method, envelope.params);
                }
            }
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
            // Null out onInput for terminals owned by this client
            const registry = this.router.context?.registry;
            if (registry) {
                const owned = registry.findByMeta('owner', envelope.clientId) || [];
                for (const entry of owned) {
                    if (entry.grid && typeof entry.grid.onInput === 'function') {
                        entry.grid.onInput = null;
                    }
                }
            }
            console.log(`[ws-bridge] controller disconnected: ${envelope.clientId}`);
            return;
        }

        // Command from a controller
        if (envelope.from && envelope.cmd) {
            this._commandsReceived++;
            this._addLog('in', envelope.from, envelope.cmd);
            const result = await this.router.execute(envelope.cmd, { sender: envelope.from });

            // Send response back to the originating controller
            const response = {
                to: envelope.from,
                response: result.text,
            };

            // Include structured data if non-null (for programmatic controllers)
            if (result.data !== null) {
                response.data = result.data;
            }

            this._addLog('out', envelope.from, result.text);
            this.ws.send(JSON.stringify(response));
            return;
        }

        console.log('[ws-bridge] unhandled message:', envelope);
    }

    // ============ Command Log ============

    /** @private */
    _addLog(direction, clientId, text) {
        const entry = {
            time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            dir: direction,    // 'in' or 'out'
            client: clientId,
            text: text.length > 200 ? text.slice(0, 197) + '...' : text,
        };
        this._log.push(entry);
        if (this._log.length > this._logMax) this._log.shift();
        for (const fn of this._logListeners) fn(entry);
    }

    /**
     * Get all log entries.
     * @returns {Array<{time: string, dir: string, client: string, text: string}>}
     */
    getLog() { return this._log; }

    /**
     * Register a callback for new log entries.
     * @param {Function} fn - (entry) => void
     * @returns {Function} unsubscribe
     */
    onLog(fn) {
        this._logListeners.push(fn);
        return () => { this._logListeners = this._logListeners.filter(f => f !== fn); };
    }

    /**
     * Dispose: disconnect and remove UI elements.
     */
    dispose() {
        // Reject all pending RPC requests
        for (const [id, pending] of this._rpcPending) {
            clearTimeout(pending.timer);
            pending.reject(new Error('WebSocketBridge disposed'));
        }
        this._rpcPending.clear();

        this.disconnect();
        if (this._statusEl && this._statusEl.parentNode) {
            this._statusEl.parentNode.removeChild(this._statusEl);
            this._statusEl = null;
        }
    }
}

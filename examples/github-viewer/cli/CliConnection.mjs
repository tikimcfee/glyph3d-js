/**
 * CliConnection -- Node.js WebSocket client for the glyph3d-js relay.
 * Connects as a "controller" role. Sends string commands, receives responses.
 *
 * Protocol: sends `ping` as first message for clean registration
 * (relay assigns ctrl-N, returns ack, handles ping without forwarding to display).
 */

import WebSocket from 'ws';

export default class CliConnection {
    constructor(url = 'ws://localhost:8765') {
        this.url = url;
        this.ws = null;
        this.connected = false;
        this.clientId = null;
        this._registered = false;
        this._pendingResolve = null;
    }

    /**
     * Connect to relay. Sends 'ping' to trigger clean registration.
     * @returns {Promise<string>} Registration ack (e.g. "OK: connected as ctrl-0")
     */
    connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.url);
            let gotAck = false;

            this.ws.on('open', () => {
                this.connected = true;
                this.ws.send('ping');
            });

            this.ws.on('message', (raw) => {
                const msg = raw.toString();

                // Phase 1: registration ack "OK: connected as ctrl-N"
                if (!gotAck && msg.startsWith('OK: connected as')) {
                    gotAck = true;
                    this._registered = true;
                    this.clientId = msg.split('OK: connected as ')[1];
                    // Don't resolve yet — wait for pong
                    return;
                }

                // Phase 2: discard pong, THEN resolve connect
                if (gotAck && msg === 'pong' && !this._pendingResolve) {
                    resolve(`OK: connected as ${this.clientId}`);
                    return;
                }

                // Phase 3: command responses
                if (this._pendingResolve) {
                    const fn = this._pendingResolve;
                    this._pendingResolve = null;

                    try {
                        const parsed = JSON.parse(msg);
                        fn({ text: parsed.response || msg, data: parsed.data || null });
                    } catch {
                        fn({ text: msg, data: null });
                    }
                }
            });

            this.ws.on('error', (err) => {
                if (!this._registered) reject(err);
                else process.stderr.write(`[ws] error: ${err.message}\n`);
            });

            this.ws.on('close', () => {
                this.connected = false;
                if (!this._registered) reject(new Error('Connection closed before registration'));
            });
        });
    }

    /**
     * Send command, wait for response.
     * @param {string} cmd
     * @param {number} [timeout=5000]
     * @returns {Promise<{text: string, data: any}>}
     */
    send(cmd, timeout = 5000) {
        return new Promise((resolve, reject) => {
            if (!this.connected) {
                reject(new Error('Not connected'));
                return;
            }

            const timer = setTimeout(() => {
                this._pendingResolve = null;
                reject(new Error(`Timeout: ${cmd}`));
            }, timeout);

            this._pendingResolve = (result) => {
                clearTimeout(timer);
                resolve(result);
            };

            this.ws.send(cmd);
        });
    }

    close() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

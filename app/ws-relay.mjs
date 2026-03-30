#!/usr/bin/env node
/**
 * WebSocket relay server (Node.js) for glyph3d-js Command Center.
 *
 * Routes messages between a single browser "display" client and N "controller" clients.
 * Uses the `ws` package (already a devDependency).
 *
 * Usage:
 *   node examples/github-viewer/ws-relay.mjs [--port 8765] [--host 0.0.0.0]
 *   npm run ws
 *
 * Protocol: same as ws-relay.py — see that file for full docs.
 */

import { WebSocketServer } from 'ws';
import { networkInterfaces } from 'os';

// ---- Config ----
let host = '0.0.0.0';
let port = 8765;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) { port = parseInt(args[++i]); }
    if (args[i] === '--host' && args[i + 1]) { host = args[++i]; }
}

// ---- State ----
let display = null;
const controllers = new Map(); // id -> ws
let nextId = 0;

// ---- LAN address detection ----
function getLanAddresses() {
    const addrs = [];
    const ifaces = networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                addrs.push(iface.address);
            }
        }
    }
    return addrs;
}

// ---- Helpers ----
function sendJSON(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
}

function notifyDisplay(event, data) {
    if (!display) return;
    sendJSON(display, { event, ...data });
}

// ---- Server ----
const wss = new WebSocketServer({ host, port });

wss.on('connection', (ws, req) => {
    let role = null;
    let clientId = null;
    const remoteAddr = req.socket.remoteAddress;

    ws.on('message', async (rawBuf) => {
        const raw = rawBuf.toString();

        // First message determines role
        if (role === null) {
            if (raw.trim() === 'DISPLAY') {
                if (display !== null) {
                    sendJSON(ws, { error: 'display already connected' });
                    ws.close();
                    return;
                }
                display = ws;
                role = 'display';
                console.log(`[relay] display connected from ${remoteAddr}`);
                sendJSON(ws, {
                    ok: true,
                    role: 'display',
                    controllers: [...controllers.keys()]
                });
                return;
            } else {
                clientId = `ctrl-${nextId++}`;
                controllers.set(clientId, ws);
                role = 'controller';
                console.log(`[relay] controller '${clientId}' connected from ${remoteAddr}`);
                ws.send(`OK: connected as ${clientId}`);
                notifyDisplay('client_connected', { clientId });
                // Fall through to process first message as command
            }
        }

        if (role === 'controller') {
            const cmd = raw.trim();
            if (!cmd) return;

            if (cmd.toLowerCase() === 'ping') { ws.send('pong'); return; }
            if (cmd.toLowerCase() === 'whoami') {
                ws.send(`You are ${clientId}. Display: ${display ? 'connected' : 'not connected'}`);
                return;
            }

            if (!display) {
                ws.send('ERR: no display connected. Open the viewer in a browser first.');
                return;
            }

            sendJSON(display, { from: clientId, cmd });

        } else if (role === 'display') {
            try {
                const msg = JSON.parse(raw);
                const target = msg.to;
                const response = msg.response || '';
                const targetWs = controllers.get(target);

                if (targetWs) {
                    if (msg.data) {
                        sendJSON(targetWs, { response, data: msg.data });
                    } else {
                        targetWs.send(response);
                    }
                } else if (target) {
                    console.log(`[relay] target '${target}' not found`);
                }
            } catch (e) {
                console.log(`[relay] invalid JSON from display: ${raw.slice(0, 100)}`);
            }
        }
    });

    ws.on('close', () => {
        if (role === 'display') {
            display = null;
            console.log('[relay] display disconnected');
        } else if (role === 'controller' && clientId) {
            controllers.delete(clientId);
            console.log(`[relay] controller '${clientId}' disconnected`);
            notifyDisplay('client_disconnected', { clientId });
        }
    });

    ws.on('error', () => { /* handled by close */ });
});

// ---- Startup banner ----
const lanAddrs = getLanAddresses();

console.log('[relay] WebSocket Command Center Relay (Node.js)');
console.log('[relay] ========================================');
console.log(`[relay] Listening on ${host}:${port}`);
console.log('[relay]');
console.log('[relay] Connect from same machine:');
console.log(`[relay]   ws://localhost:${port}`);
if (host === '0.0.0.0' && lanAddrs.length > 0) {
    console.log('[relay]');
    console.log('[relay] Connect from LAN (phone/tablet):');
    for (const addr of lanAddrs) {
        console.log(`[relay]   ws://${addr}:${port}`);
    }
}
console.log('[relay]');
console.log('[relay] Usage:');
console.log(`[relay]   websocat ws://localhost:${port}`);
console.log('[relay]   Then type commands: help, status, camera.info, etc.');
console.log('[relay] ========================================');

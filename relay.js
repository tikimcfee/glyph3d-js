#!/usr/bin/env node
/**
 * Hand Tracking WebSocket Relay
 *
 * Bridges an iPhone (or any hand tracking source) and the browser.
 * Both connect to this relay; messages from any client are
 * broadcast to all other connected clients.
 *
 * Usage:
 *   node relay.js [port]
 *   npm run relay
 *
 * iPhone connects to:  ws://<your-lan-ip>:<port>
 * Browser connects to: ws://localhost:<port>
 *
 * Expected message format from iPhone:
 * {
 *   "type": "handFrame",
 *   "hands": [{
 *     "handedness": "right",
 *     "landmarks": [[x, y, z], ...] // 21 entries, meters or normalized
 *   }],
 *   "timestamp": 1234567890.123
 * }
 */

import { WebSocketServer } from 'ws';
import { networkInterfaces } from 'os';

const PORT = parseInt(process.argv[2] || '8765', 10);

const wss = new WebSocketServer({ port: PORT });

// Track clients with labels
let nextId = 1;
const clients = new Map();

wss.on('connection', (ws, req) => {
    const id = nextId++;
    const addr = req.socket.remoteAddress;
    clients.set(ws, { id, addr, frames: 0 });

    console.log(`[+] Client #${id} connected from ${addr} (${clients.size} total)`);

    ws.on('message', (data, isBinary) => {
        const client = clients.get(ws);
        client.frames++;

        // Convert to string — our protocol is JSON text.
        // ws library receives as Buffer; forwarding as-is sends binary,
        // which the browser receives as Blob and can't JSON.parse.
        const message = isBinary ? data : data.toString();

        // Broadcast to all other clients
        for (const [other] of clients) {
            if (other !== ws && other.readyState === 1) {
                other.send(message);
            }
        }

        // Log periodically
        if (client.frames === 1 || client.frames % 100 === 0) {
            const preview = data.toString().slice(0, 80);
            console.log(`[#${client.id}] frame ${client.frames}: ${preview}...`);
        }
    });

    ws.on('close', () => {
        const client = clients.get(ws);
        console.log(`[-] Client #${client.id} disconnected (sent ${client.frames} frames)`);
        clients.delete(ws);
    });

    ws.on('error', (err) => {
        console.warn(`[!] Client #${clients.get(ws)?.id} error:`, err.message);
    });
});

// Print connection info
const lanIps = Object.values(networkInterfaces())
    .flat()
    .filter(i => i.family === 'IPv4' && !i.internal)
    .map(i => i.address);

console.log(`\n  Hand Tracking Relay`);
console.log(`  ───────────────────`);
console.log(`  Port: ${PORT}`);
console.log(`  Browser:  ws://localhost:${PORT}`);
lanIps.forEach(ip => {
    console.log(`  iPhone:   ws://${ip}:${PORT}`);
});
console.log(`\n  Waiting for connections...\n`);

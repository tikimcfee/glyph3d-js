// relay-auth.test.mjs — browser + JS harness relay token handling:
//   - #token= fragment consumed on boot, scrubbed via history.replaceState, cached in tab sessionStorage (never localStorage)
//   - WebSocketBridge dials with Sec-WebSocket-Protocol ['glyph3d', 'g3d-token.<hex>'] and never puts tokens in ws:// URLs
//   - live token rotation reconciled in place via hashchange and setToken() without page reload
//   - readRelayToken enforces 0700 dir and 0600 file permissions

import { test, expect } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRelayToken, relayProtocols } from './lib/relay.mjs';

test('readRelayToken reads a 0600 token in a 0700 runtime dir and refuses group/world-readable files', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'g3d-relay-auth-'));
    try {
        const dir = path.join(tmp, 'rt');
        mkdirSync(dir, { mode: 0o700 });
        const file = path.join(dir, 'relay-18999.token');
        const secret = 'a'.repeat(64);
        writeFileSync(file, `${secret}\n`, { mode: 0o600 });
        expect(readRelayToken(18999, { G3D_RELAY_TOKEN_DIR: dir })).toBe(secret);
        expect(relayProtocols(secret)).toEqual(['glyph3d', `g3d-token.${secret}`]);
        expect(relayProtocols(null)).toEqual(['glyph3d']);

        if (process.platform !== 'win32') {
            chmodSync(file, 0o644);
            expect(() => readRelayToken(18999, { G3D_RELAY_TOKEN_DIR: dir })).toThrow(/unsafe relay token file/);
        }
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test('WebSocketBridge consumes #token=, scrubs URL bar, keeps token out of localStorage, and reconciles hashchange + setToken', async () => {
    const sessionMap = new Map();
    const localMap = new Map();
    const listeners = new Map();
    const dials = [];
    let replacedUrl = null;

    const prevWindow = globalThis.window;
    const prevWS = globalThis.WebSocket;
    try {
        globalThis.window = {
            location: {
                protocol: 'http:',
                hostname: 'localhost',
                port: '5180',
                pathname: '/',
                search: '?relay=8180',
                hash: '#token=first_secret_111&view=grid',
            },
            history: {
                state: { keep: 1 },
                replaceState(_st, _title, url) {
                    replacedUrl = url;
                    const hi = url.indexOf('#');
                    globalThis.window.location.hash = hi >= 0 ? url.slice(hi) : '';
                },
            },
            sessionStorage: {
                getItem: (k) => sessionMap.get(k) ?? null,
                setItem: (k, v) => sessionMap.set(k, String(v)),
                removeItem: (k) => sessionMap.delete(k),
            },
            localStorage: {
                getItem: (k) => localMap.get(k) ?? null,
                setItem: (k, v) => localMap.set(k, String(v)),
            },
            addEventListener(ev, fn) { listeners.set(ev, fn); },
            removeEventListener(ev, fn) { if (listeners.get(ev) === fn) listeners.delete(ev); },
        };
        globalThis.WebSocket = class FakeWS {
            constructor(url, protocols) {
                dials.push({ url, protocols });
                this.url = url;
                this.protocols = protocols;
                this.binaryType = 'blob';
            }
            close() {}
            send() {}
        };

        const { default: WebSocketBridge, consumeRelayTokenFromLocation, parseRelayTokenInput } =
            await import('../packages/glyph3d-core/src/services/orchestration/WebSocketBridge.js');

        expect(parseRelayTokenInput('http://localhost:5180/?relay=8180#token=abc123')).toBe('abc123');
        expect(parseRelayTokenInput('  raw_tok_99  ')).toBe('raw_tok_99');

        const router = { execute: async () => ({ text: 'OK', data: null }), context: {} };
        const bridge = new WebSocketBridge(router, {
            url: 'ws://localhost:8180',
            port: 8180,
            autoConnect: true,
            showStatus: false,
        });

        expect(bridge.token).toBe('first_secret_111');
        expect(replacedUrl).toBe('/?relay=8180#view=grid');
        expect(localMap.size).toBe(0);
        expect(sessionMap.get('g3d.relayToken.8180')).toBe('first_secret_111');
        expect(dials).toHaveLength(1);
        expect(dials[0]).toEqual({
            url: 'ws://localhost:8180',
            protocols: ['glyph3d', 'g3d-token.first_secret_111'],
        });

        // Same-tab reload (hash already scrubbed) recovers token from sessionStorage.
        expect(consumeRelayTokenFromLocation(8180)).toBe('first_secret_111');

        // Relay restarts with a fresh random token; user pastes #token=second_secret_222 in URL bar.
        globalThis.window.location.hash = '#token=second_secret_222';
        listeners.get('hashchange')?.();
        expect(bridge.token).toBe('second_secret_222');
        expect(globalThis.window.location.hash).toBe('');
        expect(dials).toHaveLength(2);
        expect(dials[1].protocols).toEqual(['glyph3d', 'g3d-token.second_secret_222']);

        // Direct verb reconciliation via setToken(fullUrl).
        bridge.setToken('http://localhost:5180/?relay=8180#token=third_secret_333');
        expect(dials).toHaveLength(3);
        expect(dials[2].protocols).toEqual(['glyph3d', 'g3d-token.third_secret_333']);
        expect(localMap.size).toBe(0);

        // A relay ADDRESS is not a token: a URL with no #token= parses to nothing (Go parseRelayTokenValue).
        for (const notToken of ['http://localhost:8081/', 'ws://localhost:8081', 'http://localhost:5180/?relay=8180#view=grid', 'a b', 'tok,en']) {
            expect(parseRelayTokenInput(notToken)).toBeNull();
        }

        // relay.connect — the verb the ButtonBar's port field and the CLI run.
        const handlers = new Map();
        const { default: registerRelayCommands } = await import('../app/commands/handlers/relayCommands.js');
        registerRelayCommands({ register: (name, fn) => handlers.set(name, fn) });
        const relayConnect = (...args) => handlers.get('relay.connect')(args, { wsbridge: bridge });

        // A plain relay URL keeps the held token (it used to become the token and break the dial).
        relayConnect('http://localhost:8180/');
        expect(bridge.token).toBe('third_secret_333');
        expect(sessionMap.get('g3d.relayToken.8180')).toBe('third_secret_333');
        expect(dials.at(-1).protocols).toEqual(['glyph3d', 'g3d-token.third_secret_333']);

        // Switching relays: the token follows the port, never relay A's token at relay B.
        relayConnect('8181');
        expect(bridge.port).toBe(8181);
        expect(bridge.token).toBeNull();
        expect(dials.at(-1)).toEqual({ url: 'ws://localhost:8181', protocols: ['glyph3d'] });

        // A #token= URL for another relay saves the token under THAT relay's port.
        relayConnect('http://localhost:8182/#token=fourth_secret_444');
        expect(bridge.port).toBe(8182);
        expect(sessionMap.get('g3d.relayToken.8182')).toBe('fourth_secret_444');
        expect(sessionMap.get('g3d.relayToken.8180')).toBe('third_secret_333');
        expect(dials.at(-1).protocols).toEqual(['glyph3d', 'g3d-token.fourth_secret_444']);

        // ...and back: relay A's saved token comes back with its port.
        relayConnect('8180');
        expect(bridge.token).toBe('third_secret_333');
        expect(dials.at(-1)).toEqual({ url: 'ws://localhost:8180', protocols: ['glyph3d', 'g3d-token.third_secret_333'] });

        // An explicit second-argument token lands under the port being connected to.
        relayConnect('8183', 'fifth_secret_555');
        expect(sessionMap.get('g3d.relayToken.8183')).toBe('fifth_secret_555');
        expect(sessionMap.get('g3d.relayToken.8180')).toBe('third_secret_333');

        expect(handlers.get('relay.token')(['http://localhost:8183/'], { wsbridge: bridge }).text).toMatch(/^ERR/);
        expect(bridge.token).toBe('fifth_secret_555');
        expect(localMap.size).toBe(0);

        bridge.dispose();
        expect(listeners.has('hashchange')).toBe(false);
    } finally {
        globalThis.window = prevWindow;
        globalThis.WebSocket = prevWS;
    }
});

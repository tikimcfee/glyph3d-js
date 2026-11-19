// relay-auth.test.mjs — browser + JS harness relay token & security boundary tests:
//   - relay.mjs resolves ~/.local/state/g3d/run (or /run/user/<uid>/g3d on Linux), parses #token= in G3D_RELAY_TOKEN,
//     rejects ?token= and invalid RFC 7230 TOKEN_CHARS, and enforces 0700 dir / 0600 file permissions
//   - privateTermd isolates both G3D_TERMD_DIR and G3D_RELAY_TOKEN_DIR and strips inherited G3D_RELAY_TOKEN
//   - WebSocketBridge keys sessionStorage by normalized host:port (g3d.relayToken.<host>:<port>, never localStorage),
//     scrubs #token= via history.replaceState, and rejects malformed #token= without poisoning storage or wiping auth
//   - relay.connect isolates cross-host same-port tokens, routes ?relay= URLs to the relay port, and restores boot URL
//   - relay.token refuses #token= URLs naming a different host or port
//   - CommandRouter dispatch telemetry and ErrorTracker redact relay.token, wall.token, and relay.connect secrets

import { test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRelayToken, relayProtocols, relayTokenDir, relayTokenPath } from './lib/relay.mjs';
import { privateTermd } from './lib/termd.mjs';

test('relay.mjs & termd.mjs: runtime dir resolution, 0700/0600 checks, G3D_RELAY_TOKEN #token= parsing, and TOKEN_CHARS', () => {
    if (process.platform === 'win32') {
        expect(() => relayTokenDir({})).toThrow(/unsupported on Windows/);
        expect(() => readRelayToken(18999, {})).toThrow(/unsupported on Windows/);
        return;
    }

    // Default runtime dir: Linux /run/user/<uid>/g3d when owned & 0700, else <homedir>/.local/state/g3d/run.
    const uid = process.getuid();
    let wantDefaultDir = path.join(os.userInfo().homedir, '.local', 'state', 'g3d', 'run');
    if (process.platform === 'linux') {
        try {
            const st = lstatSync(`/run/user/${uid}`);
            if (st.isDirectory() && !st.isSymbolicLink() && st.uid === uid && (st.mode & 0o077) === 0) {
                wantDefaultDir = `/run/user/${uid}/g3d`;
            }
        } catch { /* fallback applies */ }
    }
    expect(relayTokenDir({ HOME: '/tmp/ignored-when-passwd-resolves' })).toBe(wantDefaultDir);
    expect(relayTokenDir({})).not.toBe(`/tmp/g3d-${uid}`);
    expect(relayTokenDir({ G3D_RELAY_TOKEN_DIR: '  /custom/rt  ' })).toBe('/custom/rt');
    expect(relayTokenPath(8180, { G3D_RELAY_TOKEN_DIR: '/custom/rt' })).toBe('/custom/rt/relay-8180.token');

    // Even when a fresh Bun subprocess starts with HOME=/tmp/fake-home-x, relayTokenDir() resolves <pw_dir> by UID.
    const subOut = execFileSync(process.execPath, ['-e', 'import { relayTokenDir } from "./tools/lib/relay.mjs"; console.log(relayTokenDir());'], {
        env: { PATH: process.env.PATH, HOME: '/tmp/fake-home-x-adversarial' },
        encoding: 'utf8',
    }).trim();
    expect(subOut).toBe(wantDefaultDir);

    const tmp = mkdtempSync(path.join(os.tmpdir(), 'g3d-relay-auth-'));
    try {
        const dir = path.join(tmp, 'rt');
        mkdirSync(dir, { mode: 0o700 });
        chmodSync(dir, 0o700);
        const file = path.join(dir, 'relay-18999.token');
        const secret = 'a'.repeat(64);
        writeFileSync(file, `${secret}\n`, { mode: 0o600 });

        expect(readRelayToken(18999, { G3D_RELAY_TOKEN_DIR: dir })).toBe(secret);
        expect(readRelayToken(18998, { G3D_RELAY_TOKEN_DIR: dir })).toBeNull();
        expect(relayProtocols(secret)).toEqual(['glyph3d', `g3d-token.${secret}`]);
        expect(relayProtocols(null)).toEqual(['glyph3d']);
        expect(relayProtocols('')).toEqual(['glyph3d']);

        // Group/world-readable file or runtime dir is rejected.
        chmodSync(file, 0o644);
        expect(() => readRelayToken(18999, { G3D_RELAY_TOKEN_DIR: dir })).toThrow(/unsafe relay token file/);
        chmodSync(file, 0o600);
        chmodSync(dir, 0o755);
        expect(() => readRelayToken(18999, { G3D_RELAY_TOKEN_DIR: dir })).toThrow(/unsafe relay runtime dir/);
        chmodSync(dir, 0o700);

        // Invalid TOKEN_CHARS or empty file contents are rejected.
        writeFileSync(file, 'bad,subproto\n', { mode: 0o600 });
        expect(() => readRelayToken(18999, { G3D_RELAY_TOKEN_DIR: dir })).toThrow(/invalid relay token/);
        writeFileSync(file, '\n', { mode: 0o600 });
        expect(() => readRelayToken(18999, { G3D_RELAY_TOKEN_DIR: dir })).toThrow(/invalid relay token/);

        // G3D_RELAY_TOKEN accepts raw RFC 7230 tokens and #token= URLs/fragments.
        expect(readRelayToken(18999, { G3D_RELAY_TOKEN: 'raw_env_token_123' })).toBe('raw_env_token_123');
        expect(readRelayToken(18999, { G3D_RELAY_TOKEN: 'http://localhost:5180/?relay=8180#token=url_env_tok_456&view=grid' }))
            .toBe('url_env_tok_456');
        expect(readRelayToken(18999, { G3D_RELAY_TOKEN: '#view=grid&token=frag_env_tok_789' }))
            .toBe('frag_env_tok_789');

        // G3D_RELAY_TOKEN rejects ?token= query strings (case-insensitive, & or ;), tokenless URLs, and non-TOKEN_CHARS.
        for (const queryLeak of [
            'http://localhost:8080/?token=query_secret_leak',
            'http://localhost:8080/?TOKEN=query_secret_leak#token=good_tok',
            'http://localhost:8080/?a=1;token=query_secret_leak#token=good_tok',
            '?token=query_secret_leak',
        ]) {
            let caught = null;
            try { readRelayToken(18999, { G3D_RELAY_TOKEN: queryLeak }); } catch (e) { caught = e; }
            expect(caught).toBeInstanceOf(Error);
            expect(caught.message).toMatch(/query string/);
            expect(caught.message).not.toContain('query_secret_leak');
        }
        for (const noFrag of ['http://localhost:8080/', 'ws://localhost:8080', 'http://localhost:5180/?relay=8180#view=grid']) {
            expect(() => readRelayToken(18999, { G3D_RELAY_TOKEN: noFrag })).toThrow(/no #token=/);
        }
        for (const badChars of ['bad,subproto', 'bad space', 'http://localhost:8080/#token=bad,subproto', '#token=bad"quote']) {
            expect(() => readRelayToken(18999, { G3D_RELAY_TOKEN: badChars })).toThrow(/invalid relay token/);
        }
        for (const badProto of ['bad,subproto', 'bad space', 'tok=1']) {
            expect(() => relayProtocols(badProto)).toThrow(/invalid relay token/);
        }

        // privateTermd isolates both G3D_TERMD_DIR and G3D_RELAY_TOKEN_DIR and strips inherited G3D_RELAY_TOKEN.
        const prevRunDir = process.env.G3D_TEST_RUN_DIR;
        const prevTok = process.env.G3D_RELAY_TOKEN;
        process.env.G3D_TEST_RUN_DIR = path.join(tmp, 'termd-runs');
        process.env.G3D_RELAY_TOKEN = 'inherited_secret_should_be_stripped';
        try {
            const isolated = privateTermd('iso-1');
            expect(isolated.env.G3D_TERMD_DIR).toBe(isolated.dir);
            expect(isolated.env.G3D_RELAY_TOKEN_DIR).toBe(isolated.dir);
            expect(isolated.env.G3D_RELAY_TOKEN).toBeUndefined();
            expect(lstatSync(isolated.dir).mode & 0o777).toBe(0o700);
        } finally {
            if (prevRunDir === undefined) delete process.env.G3D_TEST_RUN_DIR;
            else process.env.G3D_TEST_RUN_DIR = prevRunDir;
            if (prevTok === undefined) delete process.env.G3D_RELAY_TOKEN;
            else process.env.G3D_RELAY_TOKEN = prevTok;
        }
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test('WebSocketBridge contract helpers: host/key normalization, endpoint parsing, ?token= rejection, and secret redaction', async () => {
    const {
        TOKEN_CHARS,
        normalizeRelayHost,
        relayTokenStorageKey,
        parseRelayTokenInput,
        parseRelayEndpoint,
        redactRelaySecrets,
        redactCommandArgs,
        isSecretCommand,
    } = await import('../packages/glyph3d-core/src/services/orchestration/WebSocketBridge.js');

    expect(TOKEN_CHARS.test('abcXYZ019-._~')).toBe(true);
    expect(TOKEN_CHARS.test('bad,subproto')).toBe(false);

    expect(normalizeRelayHost('  LOCALHOST  ')).toBe('localhost');
    expect(normalizeRelayHost('[::1]')).toBe('::1');
    expect(normalizeRelayHost('::1')).toBe('::1');
    expect(relayTokenStorageKey(8180, 'localhost')).toBe('g3d.relayToken.localhost:8180');
    expect(relayTokenStorageKey(8180, '[::1]')).toBe('g3d.relayToken.::1:8180');

    expect(parseRelayTokenInput('http://localhost:5180/?relay=8180#token=abc123')).toBe('abc123');
    expect(parseRelayTokenInput('  raw_tok_99  ')).toBe('raw_tok_99');
    for (const bad of [
        'http://localhost:8081/',
        'ws://localhost:8081',
        'http://localhost:5180/?relay=8180#view=grid',
        'http://localhost:8080/?token=abc123',
        'http://localhost:8080/?TOKEN=abc123#token=def456',
        'http://localhost:8080/?a=1;token=abc123#token=def456',
        '?token=abc123',
        'a b',
        'tok,en',
    ]) {
        expect(parseRelayTokenInput(bad)).toBeNull();
    }

    expect(parseRelayEndpoint('8080', { defaultHost: 'localhost', pageProtocol: 'http:' })).toEqual({
        ok: true,
        host: 'localhost',
        port: 8080,
        wsUrl: 'ws://localhost:8080',
        token: null,
        hadHashToken: false,
    });
    expect(parseRelayEndpoint(8443, { defaultHost: '[::1]', pageProtocol: 'https:' })).toEqual({
        ok: true,
        host: '::1',
        port: 8443,
        wsUrl: 'wss://[::1]:8443',
        token: null,
        hadHashToken: false,
    });
    expect(parseRelayEndpoint('http://localhost:5180/?relay=8180#token=frag_tok_1')).toEqual({
        ok: true,
        host: 'localhost',
        port: 8180,
        wsUrl: 'ws://localhost:8180',
        token: 'frag_tok_1',
        hadHashToken: true,
    });
    expect(parseRelayEndpoint('https://box.example:9443/#token=tls_tok_2')).toEqual({
        ok: true,
        host: 'box.example',
        port: 9443,
        wsUrl: 'wss://box.example:9443',
        token: 'tls_tok_2',
        hadHashToken: true,
    });

    for (const invalidEp of [
        '0',
        '70000',
        'raw_secret_not_a_port',
        'http://[::1/#token=raw_secret_not_a_port',
        'http://localhost:8080/?token=raw_secret_not_a_port',
        'http://localhost:8080/#token=bad,subproto',
        'http://localhost:5180/?relay=99999#token=raw_secret_not_a_port',
    ]) {
        const parsed = parseRelayEndpoint(invalidEp, { defaultHost: 'localhost', pageProtocol: 'http:' });
        expect(parsed.ok).toBe(false);
        expect(parsed.error).not.toContain('raw_secret_not_a_port');
        expect(parsed.error).not.toContain('bad,subproto');
    }

    const scrubbed = redactRelaySecrets('dial http://localhost:8180/#view=1&token=MY_HASH_TOK;x=1 and g3d-token.MY_PROTO_TOK and Bearer MY_BEARER_TOK');
    expect(scrubbed).not.toContain('MY_HASH_TOK');
    expect(scrubbed).not.toContain('MY_PROTO_TOK');
    expect(scrubbed).not.toContain('MY_BEARER_TOK');
    expect(scrubbed).toContain('token=[REDACTED]');
    expect(scrubbed).toContain('g3d-token.[REDACTED]');
    expect(scrubbed).toContain('Bearer [REDACTED]');

    expect(redactCommandArgs('relay.token', ['SECRET_1'])).toEqual(['[REDACTED]']);
    expect(redactCommandArgs('wall.token', ['SECRET_2'])).toEqual(['[REDACTED]']);
    expect(redactCommandArgs('relay.connect', ['8180', 'SECRET_3'])).toEqual(['8180', '[REDACTED]']);
    expect(redactCommandArgs('relay.connect', ['SWAPPED_SECRET_4'])).toEqual(['[REDACTED]']);
    expect(redactCommandArgs('relay.connect', ['http://localhost:5180/?relay=8180#token=SECRET_5']))
        .toEqual(['http://localhost:5180/?relay=8180#token=[REDACTED]']);

    expect(isSecretCommand('relay.token abc')).toBe(true);
    expect(isSecretCommand('wall token abc')).toBe(true);
    expect(isSecretCommand('relay.connect 8180 abc')).toBe(true);
    expect(isSecretCommand('relay.connect raw_secret')).toBe(true);
    expect(isSecretCommand('relay.connect http://localhost:8180/#token=abc')).toBe(true);
    expect(isSecretCommand('relay.connect 8180')).toBe(false);
    expect(isSecretCommand('relay.connect')).toBe(false);
    expect(isSecretCommand('grid.list')).toBe(false);
});

test('WebSocketBridge & relayCommands: host+port isolation, ?relay= routing, cross-port relay.token refusal, boot restore, and malformed #token= scrubbing', async () => {
    const sessionMap = new Map();
    const localMap = new Map();
    const listeners = new Set();
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
            addEventListener(ev, fn) { if (ev === 'hashchange') listeners.add(fn); },
            removeEventListener(ev, fn) { if (ev === 'hashchange') listeners.delete(fn); },
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

        const { default: WebSocketBridge, consumeRelayTokenFromLocation } =
            await import('../packages/glyph3d-core/src/services/orchestration/WebSocketBridge.js');

        const router = { execute: async () => ({ text: 'OK', data: null }), context: {} };
        const bridge = new WebSocketBridge(router, {
            url: 'ws://localhost:8180',
            port: 8180,
            autoConnect: true,
            showStatus: false,
        });

        expect(bridge.host).toBe('localhost');
        expect(bridge.port).toBe(8180);
        expect(bridge.token).toBe('first_secret_111');
        expect(replacedUrl).toBe('/?relay=8180#view=grid');
        expect(localMap.size).toBe(0);
        expect(sessionMap.get('g3d.relayToken.localhost:8180')).toBe('first_secret_111');
        expect(dials).toHaveLength(1);
        expect(dials[0]).toEqual({
            url: 'ws://localhost:8180',
            protocols: ['glyph3d', 'g3d-token.first_secret_111'],
        });

        // Same-tab reload (hash already scrubbed) recovers token from host:port sessionStorage key.
        expect(consumeRelayTokenFromLocation(8180, 'localhost')).toBe('first_secret_111');

        // Relay restarts with a fresh random token; user pastes #token=second_secret_222 in URL bar.
        globalThis.window.location.hash = '#token=second_secret_222';
        for (const fn of listeners) fn();
        expect(bridge.token).toBe('second_secret_222');
        expect(globalThis.window.location.hash).toBe('');
        expect(dials).toHaveLength(2);
        expect(dials[1].protocols).toEqual(['glyph3d', 'g3d-token.second_secret_222']);

        // Malformed #token=bad,subproto on hashchange is scrubbed without poisoning sessionStorage or wiping active auth.
        const dialsBeforeBadHash = dials.length;
        globalThis.window.location.hash = '#token=bad,subproto&keep=yes';
        for (const fn of listeners) fn();
        expect(globalThis.window.location.hash).toBe('#keep=yes');
        expect(bridge.token).toBe('second_secret_222');
        expect(sessionMap.get('g3d.relayToken.localhost:8180')).toBe('second_secret_222');
        expect(dials).toHaveLength(dialsBeforeBadHash);

        // Malformed #token=bad,subproto on initial page boot scrubs hash without poisoning sessionStorage.
        globalThis.window.location.hash = '#token=bad,subproto&boot=1';
        const badBootBridge = new WebSocketBridge(router, {
            url: 'ws://localhost:8199',
            port: 8199,
            autoConnect: true,
            showStatus: false,
        });
        expect(globalThis.window.location.hash).toBe('#boot=1');
        expect(badBootBridge.token).toBeNull();
        expect(sessionMap.has('g3d.relayToken.localhost:8199')).toBe(false);
        expect(dials.at(-1)).toEqual({ url: 'ws://localhost:8199', protocols: ['glyph3d'] });
        badBootBridge.dispose();

        // Pre-poisoned sessionStorage entry is evicted and never returned.
        sessionMap.set('g3d.relayToken.localhost:8199', 'bad,subproto');
        globalThis.window.location.hash = '';
        expect(consumeRelayTokenFromLocation(8199, 'localhost')).toBeNull();
        expect(sessionMap.has('g3d.relayToken.localhost:8199')).toBe(false);

        // Direct setToken reconciliation.
        bridge.setToken('http://localhost:5180/?relay=8180#token=third_secret_333');
        expect(bridge.token).toBe('third_secret_333');
        expect(sessionMap.get('g3d.relayToken.localhost:8180')).toBe('third_secret_333');
        expect(dials.at(-1).protocols).toEqual(['glyph3d', 'g3d-token.third_secret_333']);

        // Register relay.* commands.
        const handlers = new Map();
        const { default: registerRelayCommands } = await import('../app/commands/handlers/relayCommands.js');
        registerRelayCommands({ register: (name, fn) => handlers.set(name, fn) });
        const relayConnect = (...args) => handlers.get('relay.connect')(args, { wsbridge: bridge });
        const relayToken = (...args) => handlers.get('relay.token')(args, { wsbridge: bridge });

        // Plain relay URL keeps the held token for localhost:8180.
        relayConnect('http://localhost:8180/');
        expect(bridge.token).toBe('third_secret_333');
        expect(dials.at(-1)).toEqual({
            url: 'ws://localhost:8180',
            protocols: ['glyph3d', 'g3d-token.third_secret_333'],
        });

        // Cross-host same-port isolation: dialing ws://other.example:8180 NEVER sends localhost:8180's token.
        relayConnect('ws://other.example:8180');
        expect(bridge.host).toBe('other.example');
        expect(bridge.port).toBe(8180);
        expect(bridge.token).toBeNull();
        expect(dials.at(-1)).toEqual({ url: 'ws://other.example:8180', protocols: ['glyph3d'] });
        expect(sessionMap.get('g3d.relayToken.localhost:8180')).toBe('third_secret_333');

        // Storing a token for other.example:8180 keys under g3d.relayToken.other.example:8180 without clobbering localhost:8180.
        relayConnect('ws://other.example:8180', 'peer_tok_444');
        expect(sessionMap.get('g3d.relayToken.other.example:8180')).toBe('peer_tok_444');
        expect(sessionMap.get('g3d.relayToken.localhost:8180')).toBe('third_secret_333');
        expect(dials.at(-1)).toEqual({
            url: 'ws://other.example:8180',
            protocols: ['glyph3d', 'g3d-token.peer_tok_444'],
        });

        // No-arg relay.connect restores the boot endpoint (ws://localhost:8180) and its saved token.
        relayConnect();
        expect(bridge.host).toBe('localhost');
        expect(bridge.port).toBe(8180);
        expect(bridge.url).toBe('ws://localhost:8180');
        expect(bridge.token).toBe('third_secret_333');
        expect(dials.at(-1)).toEqual({
            url: 'ws://localhost:8180',
            protocols: ['glyph3d', 'g3d-token.third_secret_333'],
        });

        // Switching to another local port isolates tokens by port, then ?relay= URL routes to :8180 (never Vite :5180).
        relayConnect('8181');
        expect(bridge.host).toBe('localhost');
        expect(bridge.port).toBe(8181);
        expect(bridge.token).toBeNull();
        expect(dials.at(-1)).toEqual({ url: 'ws://localhost:8181', protocols: ['glyph3d'] });

        relayConnect('http://localhost:5180/?relay=8180#token=vite_routed_tok_555');
        expect(bridge.host).toBe('localhost');
        expect(bridge.port).toBe(8180);
        expect(bridge.token).toBe('vite_routed_tok_555');
        expect(dials.at(-1)).toEqual({
            url: 'ws://localhost:8180',
            protocols: ['glyph3d', 'g3d-token.vite_routed_tok_555'],
        });
        expect(sessionMap.get('g3d.relayToken.localhost:8180')).toBe('vite_routed_tok_555');
        expect(sessionMap.has('g3d.relayToken.localhost:5180')).toBe(false);

        // relay.token refuses a #token= URL naming a different port (8182 while on 8180) or different host.
        const dialsBeforeWrongPort = dials.length;
        const wrongPortRes = relayToken('http://localhost:8182/#token=wrong_port_tok_666');
        expect(wrongPortRes.text).toMatch(/^ERR/);
        expect(wrongPortRes.text).not.toContain('wrong_port_tok_666');
        expect(bridge.token).toBe('vite_routed_tok_555');
        expect(sessionMap.get('g3d.relayToken.localhost:8180')).toBe('vite_routed_tok_555');
        expect(sessionMap.has('g3d.relayToken.localhost:8182')).toBe(false);
        expect(dials).toHaveLength(dialsBeforeWrongPort);

        const wrongHostRes = relayToken('http://other.example:8180/#token=wrong_host_tok_777');
        expect(wrongHostRes.text).toMatch(/^ERR/);
        expect(wrongHostRes.text).not.toContain('wrong_host_tok_777');
        expect(bridge.token).toBe('vite_routed_tok_555');

        // Tokenless URL and swapped-arg relay.connect fail cleanly without echoing secrets.
        expect(relayToken('http://localhost:8180/').text).toMatch(/^ERR/);
        const swappedRes = relayConnect('swapped_raw_secret_888');
        expect(swappedRes.text).toMatch(/^ERR/);
        expect(swappedRes.text).not.toContain('swapped_raw_secret_888');
        expect(bridge.token).toBe('vite_routed_tok_555');
        expect(localMap.size).toBe(0);

        bridge.dispose();
        expect(listeners.size).toBe(0);
    } finally {
        globalThis.window = prevWindow;
        globalThis.WebSocket = prevWS;
    }
});

test('CommandRouter telemetry and ErrorTracker redact relay.token, wall.token, and relay.connect secrets', async () => {
    const { default: CommandRouter } = await import('../packages/glyph3d-core/src/services/orchestration/CommandRouter.js');
    const { recentConsole } = await import('../packages/glyph3d-core/src/services/orchestration/consoleForwarder.js');
    const { default: errorTracker } = await import('../packages/glyph3d-core/src/utils/ErrorTracker.js');

    errorTracker.clearErrors();
    const startIdx = recentConsole().length;

    const router = new CommandRouter({});
    let shouldThrow = false;
    router.register('relay.token', () => {
        if (shouldThrow) throw new Error('relay.token boom');
        return 'OK';
    });
    router.register('wall.token', () => {
        if (shouldThrow) throw new Error('wall.token boom');
        return 'OK';
    });
    router.register('relay.connect', () => {
        if (shouldThrow) throw new Error('relay.connect boom');
        return 'OK';
    });

    const secrets = [
        'TOP_SECRET_RELAY_OK_111',
        'TOP_SECRET_WALL_OK_222',
        'TOP_SECRET_WALL_SPACE_333',
        'TOP_SECRET_CONNECT_ARG_444',
        'TOP_SECRET_CONNECT_HASH_555',
        'TOP_SECRET_RELAY_ERR_666',
        'TOP_SECRET_WALL_ERR_777',
        'TOP_SECRET_CONNECT_ERR_888',
    ];

    await router.execute(`relay.token ${secrets[0]}`);
    await router.execute(`wall.token ${secrets[1]}`);
    await router.execute(`wall token ${secrets[2]}`);
    await router.execute(`relay.connect 8180 ${secrets[3]}`);
    await router.execute(`relay.connect http://localhost:5180/?relay=8180#token=${secrets[4]}`);

    shouldThrow = true;
    const err1 = await router.execute(`relay.token ${secrets[5]}`);
    const err2 = await router.execute(`wall.token ${secrets[6]}`);
    const err3 = await router.execute(`relay.connect 8180 ${secrets[7]}`);
    expect(err1.text).toMatch(/^ERR:/);
    expect(err2.text).toMatch(/^ERR:/);
    expect(err3.text).toMatch(/^ERR:/);

    const newRecords = recentConsole().slice(startIdx);
    const serializedLogs = JSON.stringify(newRecords);
    const capturedErrors = errorTracker.getErrors();
    const serializedErrors = JSON.stringify(capturedErrors);

    for (const s of secrets) {
        expect(serializedLogs).not.toContain(s);
        expect(serializedErrors).not.toContain(s);
    }

    const cmdTraces = newRecords.filter((r) => r.scope === 'command');
    expect(cmdTraces.length).toBeGreaterThanOrEqual(8);
    for (const rec of cmdTraces) {
        expect(JSON.stringify(rec.attrs?.args)).toContain('[REDACTED]');
    }

    const cmdErrors = capturedErrors.filter((e) => e.context?.type === 'command_error');
    expect(cmdErrors).toHaveLength(3);
    for (const entry of cmdErrors) {
        expect(JSON.stringify(entry.context?.args)).toContain('[REDACTED]');
    }
});

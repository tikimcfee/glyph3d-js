/**
 * relay.* commands — connect / disconnect / inspect the local relay.
 *
 * The relay is pure enhancement: the app runs client-only against GitHub, and a
 * relay (the glyph3d-cli binary, or a dev server) adds the local filesystem,
 * terminals, and the command bus on top. These verbs are the on/off switch —
 * driven by the ButtonBar's connection chip, the CLI, or Claude alike.
 *
 * The relay URL is resolved at boot (same-origin for the binary, ?relay=PORT for
 * dev) and stashed on the bridge; relay.connect with no arg reuses it. A bare port
 * (or a full ws/wss URL, optionally carrying `#token=…`) overrides it for this
 * connection; an optional second argument sets the capability token explicitly.
 */

import {
    TOKEN_CHARS,
    normalizeRelayHost,
    parseRelayEndpoint,
    parseRelayTokenInput,
    redactRelaySecrets,
} from '@glyph3d/core/services/orchestration/WebSocketBridge.js';

/**
 * @param {import('../../client/CommandProvider.jsx').AppRouter} router
 */
export default function registerRelayCommands(router) {
    router.register('relay.connect', (args, ctx) => {
        const bridge = ctx.wsbridge;
        if (!bridge) return { text: 'ERR: no relay bridge', data: null };
        const [arg, tokenArg] = args;
        const hasArg = arg !== undefined && arg !== null && String(arg).trim() !== '';
        const hasTokenArg = tokenArg !== undefined && tokenArg !== null;
        if (!hasArg && !hasTokenArg) {
            bridge.resetToBootEndpoint();
            bridge.connect();
            return {
                text: `OK: connecting to ${bridge.url}`,
                data: { url: bridge.url, hasToken: !!bridge.token },
            };
        }

        // Validate both endpoint and explicit token BEFORE mutating bridge host/port/token.
        let ep = null;
        if (hasArg) {
            ep = parseRelayEndpoint(arg, {
                defaultHost: typeof window !== 'undefined' ? window.location?.hostname : bridge.host,
                pageProtocol: typeof window !== 'undefined' ? window.location?.protocol : 'http:',
            });
            if (!ep.ok) {
                const rawStr = String(arg).trim();
                const looksSecret = TOKEN_CHARS.test(rawStr) || /token=/i.test(rawStr) || rawStr.includes('g3d-token.');
                const reason = (!ep.error || (looksSecret && ep.error.includes(rawStr)))
                    ? 'expected a port (1-65535) or ws/http URL'
                    : redactRelaySecrets(ep.error);
                return { text: `ERR: relay.connect: ${reason}`, data: null };
            }
        }

        let parsedTokenArg = null;
        if (hasTokenArg) {
            parsedTokenArg = parseRelayTokenInput(tokenArg);
            if (!parsedTokenArg) {
                return { text: 'ERR: relay.connect: the token is not a token or a #token=… URL', data: null };
            }
        }

        if (ep) {
            bridge.useEndpoint(ep.host, ep.port);
        }
        if (ep?.token) {
            bridge.setToken(ep.token, { reconnect: false });
        }
        if (parsedTokenArg) {
            bridge.setToken(parsedTokenArg, { reconnect: false });
        }
        bridge.connect(ep ? ep.wsUrl : undefined);
        const target = bridge.url;
        return { text: `OK: connecting to ${target}`, data: { url: target, hasToken: !!bridge.token } };
    }, {
        description: 'Connect to the local relay (no arg = the boot-resolved URL)',
        usage: '[port | ws-url] [token]',
        returns: '{ url, hasToken }',
    });

    router.register('relay.token', (args, ctx) => {
        const bridge = ctx.wsbridge;
        if (!bridge) return { text: 'ERR: no relay bridge', data: null };
        const raw = typeof args[0] === 'string' ? args[0].trim() : '';
        if (!raw) return { text: 'ERR: relay.token requires a token or #token=… URL', data: null };
        let tok;
        if (raw.includes('://')) {
            const ep = parseRelayEndpoint(raw, { defaultHost: bridge.host });
            if (!ep.ok || !ep.token) {
                return { text: 'ERR: relay.token requires a token or a valid URL carrying #token=…', data: null };
            }
            const bridgeHost = normalizeRelayHost(bridge.host);
            if (ep.host !== bridgeHost || ep.port !== bridge.port) {
                return {
                    text: `ERR: relay.token: URL targets ${ep.host}:${ep.port}, but relay is ${bridgeHost}:${bridge.port}`,
                    data: null,
                };
            }
            tok = ep.token;
        } else {
            tok = parseRelayTokenInput(raw);
            if (!tok) return { text: 'ERR: relay.token requires a token or #token=… URL', data: null };
        }
        bridge.setToken(tok);
        return {
            text: `OK: relay token updated — reconnecting to ${bridge.url || `:${bridge.port}`}`,
            data: { host: bridge.host, port: bridge.port, hasToken: true },
        };
    }, {
        description: 'Set the relay capability token (raw token or #token=… URL) and reconnect',
        usage: '<token | url#token=…>',
        returns: '{ host, port, hasToken }',
    });

    router.register('relay.disconnect', (_args, ctx) => {
        const bridge = ctx.wsbridge;
        if (!bridge) return { text: 'ERR: no relay bridge', data: null };
        bridge.disconnect();  // sets intentional-close → no auto-reconnect
        return { text: 'OK: disconnected', data: { connected: false } };
    }, { description: 'Disconnect from the relay and stop auto-reconnect' });

    router.register('relay.status', (_args, ctx) => {
        const bridge = ctx.wsbridge;
        const connected = !!bridge?.connected;
        return {
            text: connected ? `OK: connected — ${bridge.url}` : 'OK: disconnected',
            data: {
                connected,
                url: bridge?.url || null,
                host: bridge?.host || null,
                port: bridge?.port || null,
                hasToken: !!bridge?.token,
            },
        };
    }, { description: 'Report relay connection state', returns: '{ connected, url, host, port, hasToken }' });
}

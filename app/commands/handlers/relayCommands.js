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

import { parseRelayTokenInput } from '@glyph3d/core/services/orchestration/WebSocketBridge.js';

/**
 * @param {import('../../client/CommandProvider.jsx').AppRouter} router
 */
export default function registerRelayCommands(router) {
    router.register('relay.connect', (args, ctx) => {
        const bridge = ctx.wsbridge;
        if (!bridge) return { text: 'ERR: no relay bridge', data: null };
        const [arg, tokenArg] = args;
        // The port first: the token belongs to a relay, so usePort brings the new port's saved
        // token (or none), and a token given here is then saved under the new port's key.
        let url;
        if (arg) {
            if (/^(wss?|https?):\/\//i.test(arg)) {
                const u = new URL(arg);
                const secure = /^(wss|https):$/i.test(u.protocol);
                bridge.usePort(Number(u.port) || (secure ? 443 : 80));
                const tok = parseRelayTokenInput(arg);
                if (tok) bridge.setToken(tok, { reconnect: false });
                url = `${secure ? 'wss:' : 'ws:'}//${u.host}`;
            } else {
                // Bare port → dial the relay on the page host at that port (the dev case).
                const port = Number(arg);
                if (!Number.isInteger(port) || port <= 0) return { text: `ERR: relay.connect: '${arg}' is not a port or a URL`, data: null };
                bridge.usePort(port);
                url = `ws://${window.location.hostname}:${port}`;
            }
        }
        if (tokenArg) {
            if (!parseRelayTokenInput(tokenArg)) return { text: 'ERR: relay.connect: the token is not a token or a #token=… URL', data: null };
            bridge.setToken(tokenArg, { reconnect: false });
        }
        bridge.connect(url);  // undefined → the boot-resolved bridge.url
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
        const tok = parseRelayTokenInput(args[0]);
        if (!tok) return { text: 'ERR: relay.token requires a token or #token=… URL', data: null };
        bridge.setToken(tok);
        return { text: `OK: relay token updated — reconnecting to ${bridge.url || `:${bridge.port}`}`, data: { port: bridge.port, hasToken: true } };
    }, {
        description: 'Set the relay capability token (raw token or #token=… URL) and reconnect',
        usage: '<token | url#token=…>',
        returns: '{ port, hasToken }',
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
            data: { connected, url: bridge?.url || null, port: bridge?.port || null, hasToken: !!bridge?.token },
        };
    }, { description: 'Report relay connection state', returns: '{ connected, url, port, hasToken }' });
}

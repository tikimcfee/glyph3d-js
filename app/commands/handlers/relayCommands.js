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
 * (or a full ws/wss URL) overrides it for this connection.
 */

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerRelayCommands(router) {
    router.register('relay.connect', (args, ctx) => {
        const bridge = ctx.wsbridge;
        if (!bridge) return { text: 'ERR: no relay bridge', data: null };
        const arg = args[0];
        let url;
        if (arg) {
            if (/^wss?:\/\//i.test(arg)) {
                url = arg;
            } else {
                // Bare port → dial the relay on the page host at that port (the dev case).
                bridge.port = Number(arg) || bridge.port;
                url = `ws://${window.location.hostname}:${arg}`;
            }
        }
        bridge.connect(url);  // undefined → the boot-resolved bridge.url
        const target = url || bridge.url;
        return { text: `OK: connecting to ${target}`, data: { url: target } };
    }, {
        description: 'Connect to the local relay (no arg = the boot-resolved URL)',
        usage: '[port | ws-url]',
        returns: '{ url }',
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
            data: { connected, url: bridge?.url || null, port: bridge?.port || null },
        };
    }, { description: 'Report relay connection state', returns: '{ connected, url, port }' });
}

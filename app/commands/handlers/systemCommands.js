/**
 * System commands: help, status
 * Migrated from stale WebSocket branch to use context bag instead of raw viewer.
 */

import { box, kvLines } from '../formatResponse.js';

/**
 * Decode a base64 string to a UTF-8 JS string. `atob` alone yields a binary string that
 * mangles multibyte sequences (paths/commands with unicode, emoji) — round-trip the bytes
 * through TextDecoder so the bundle survives intact. Tolerates base64url (-/_) too.
 * @param {string} b64
 * @returns {string}
 */
function b64ToUtf8(b64) {
    const norm = b64.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(norm);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerSystemCommands(router) {
    router.register('help', (args, ctx) => {
        const cmds = router.listCommands();

        // help <name…> — the dot-free spelling reads here too ("help grid list"
        // asks after grid.list). An exact or unambiguous name gets the full verb
        // card (the only surface that shows `returns`); a wider prefix gets its
        // namespace table.
        if (args.length > 0) {
            const q = args.join('.').toLowerCase();
            const matched = cmds.filter(c => c.name.startsWith(q));
            if (matched.length === 0) {
                return { text: `No commands matching '${q}' — bare help maps the namespaces`, data: null };
            }
            const exact = cmds.find(c => c.name === q);
            if (exact || matched.length === 1) {
                const c = exact || matched[0];
                const lines = [c.description || '(no description)'];
                if (c.usage) lines.push('', `usage    ${c.name} ${c.usage}`);
                if (c.returns) lines.push(`returns  ${c.returns}`);
                // Exact-first hides namespace siblings (select vs select.*) —
                // point at them rather than silently swallowing the namespace.
                if (exact && matched.length > 1) {
                    lines.push('', `deeper: ${matched.length - 1} more under ${q}.* — help ${q}.`);
                }
                return { text: box(c.name, lines, 44), data: { commands: [c] } };
            }
            // One line per verb while it fits the palette's result box (~80
            // chars); a long usage or description wraps to a two-line row
            // instead of stretching the box into a horizontal scroll.
            const lines = matched.flatMap(c => {
                const head = c.usage ? `${c.name} ${c.usage}` : c.name;
                const one = head.padEnd(30) + (c.description || '');
                if (head.length <= 30 && one.length <= 76) return [one.trimEnd()];
                return c.description ? [head, `  ${c.description}`] : [head];
            });
            return { text: box(`COMMANDS: ${q}*`, lines, 70), data: { commands: matched } };
        }

        // Bare help is a MAP, not a dump — the palette already searches every
        // verb live, so this orients: namespaces by weight, then how to go
        // deeper. Computed from the registry each call; it cannot go stale.
        const ns = new Map();
        const solo = [];
        for (const c of cmds) {
            const dot = c.name.indexOf('.');
            if (dot === -1) { solo.push(c.name); continue; }
            const head = c.name.slice(0, dot);
            ns.set(head, (ns.get(head) || 0) + 1);
        }
        const cells = [...ns.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([name, n]) => `${name} ${n}`);
        const cellW = cells.length ? Math.max(...cells.map(s => s.length)) + 2 : 1;
        const perRow = Math.max(1, Math.floor(64 / cellW));
        const grid = [];
        for (let i = 0; i < cells.length; i += perRow) {
            grid.push(cells.slice(i, i + perRow).map(s => s.padEnd(cellW)).join('').trimEnd());
        }
        const lines = [
            `${cmds.length} verbs · ${ns.size} namespaces — typing in the palette searches them all`,
            '',
            ...grid,
            '',
            `single-word: ${solo.sort().join(' · ')}`,
            '',
            'help <namespace>   every verb in one namespace',
            'help <verb>        one verb in full (usage · returns)',
            'the dot is optional — "grid list" runs grid.list',
        ];
        return {
            text: box('COMMAND BUS', lines, 70),
            data: { count: cmds.length, namespaces: Object.fromEntries(ns), solo }
        };
    }, { description: 'Map the command bus; help <namespace|verb> for detail', usage: '[namespace|verb]' });

    router.register('status', (args, ctx) => {
        const cam = ctx.camera.position;
        const gridEntries = ctx.registry.findByType('grid');
        let totalGlyphs = 0;
        for (const e of gridEntries) totalGlyphs += e.grid.getGlyphCount();

        const wsConnected = ctx.wsbridge ? ctx.wsbridge.connected : false;

        // The path frame: where file.* verbs resolve. Every driver (human,
        // CLI script, model) gets its bearings from the standard first call.
        const fp = ctx.fileProvider;
        const repo = fp?._currentRepo;
        const filesLine = fp?.rootInfo?.root
            ? `relay · ${fp.rootInfo.root}`
            : repo
                ? `github · ${repo.owner}/${repo.repo}@${repo.branch || 'main'}`
                : 'no source loaded';

        const data = {
            'grids': String(gridEntries.length),
            'glyphs': totalGlyphs.toLocaleString(),
            'registry': String(ctx.registry.size),
            'camera': `${cam.x.toFixed(0)}, ${cam.y.toFixed(0)}, ${cam.z.toFixed(0)}`,
            'websocket': wsConnected ? 'connected' : 'disconnected',
            'files': filesLine,
        };

        const lines = kvLines(data);
        return {
            text: box('STATUS', lines, 40) + '\nOK: status',
            data: {
                gridCount: gridEntries.length,
                glyphCount: totalGlyphs,
                registryTotal: ctx.registry.size,
                camera: { x: cam.x, y: cam.y, z: cam.z },
                websocket: wsConnected,
                files: filesLine,
            }
        };
    }, { description: 'Show scene status' });

    router.register('batch', async (args, ctx) => {
        if (args.length < 1) return { text: 'ERR: usage: batch <json-array-of-commands>', data: null };
        let commands;
        try {
            commands = JSON.parse(args.join(' '));
        } catch {
            return { text: 'ERR: batch argument must be a JSON array of command strings', data: null };
        }
        if (!Array.isArray(commands)) {
            return { text: 'ERR: batch argument must be a JSON array', data: null };
        }

        const results = await router.executeBatch(commands);
        const failed = results.filter(r => r.text.startsWith('ERR:')).length;
        const succeeded = results.length - failed;

        return {
            text: `OK: batch completed (${succeeded}/${results.length} succeeded${failed ? `, ${failed} failed` : ''})`,
            data: { results, succeeded, failed }
        };
    }, { description: 'Execute multiple commands in one round-trip', usage: '<json-array>' });

    router.register('call', async (args, ctx) => {
        // The structured side-hatch: any command, invoked from a base64'd bundle instead
        // of a space-delimited line. The bundle decodes to the SAME [name, ...args] vector
        // a typed line produces — it's a serialization of the call, NOT a second calling
        // convention, so handlers are untouched (they still read positional args).
        //
        // Why base64 and not raw JSON-on-the-line: the bus tokenizer (parse) strips quotes
        // and splits on spaces, so a JSON payload typed inline loses its structure. base64's
        // alphabet (A-Za-z0-9+/=) has neither spaces nor quotes, so a bundle survives the
        // tokenizer AND any args.join(' ') intact — transport-agnostic across CLI/hook/agent.
        //
        // Payload (after decode) is JSON, either form:
        //   ["grid.layout", "3", "--mode", "newspaper"]        positional array
        //   {"cmd": "grid.layout", "args": ["3", "--mode"]}    object form
        // The object form reserves a "kwargs" slot for the future named-param layer; it is
        // NOT interpreted yet (positional-only, by design — named rides the arg-schema work).
        if (args.length < 1) {
            return { text: 'ERR: usage: call <base64-json>  (JSON: [name, ...args] or {cmd, args})', data: null };
        }
        let spec;
        try {
            spec = JSON.parse(b64ToUtf8(args[0]));
        } catch (e) {
            return { text: `ERR: call payload must be base64-encoded JSON: ${e.message}`, data: null };
        }
        let invocation;
        if (Array.isArray(spec)) {
            invocation = spec;
        } else if (spec && typeof spec === 'object' && typeof spec.cmd === 'string') {
            invocation = [spec.cmd, ...(Array.isArray(spec.args) ? spec.args : [])];
        } else {
            return { text: 'ERR: call payload must be [name, ...args] or {cmd, args}', data: null };
        }
        if (!invocation.length || typeof invocation[0] !== 'string') {
            return { text: 'ERR: call payload has no command name', data: null };
        }
        // A bundle that wraps `call` is a recursion bomb (and pointless) — refuse it.
        if (invocation[0].toLowerCase() === 'call') {
            return { text: 'ERR: call cannot wrap call', data: null };
        }
        // Coerce non-string args to strings: handlers read positional string tokens, and the
        // typed-CLI path always delivers strings — keep the hatch byte-identical to it.
        const argv = [invocation[0], ...invocation.slice(1).map(a => (typeof a === 'string' ? a : String(a)))];
        return router.execute(argv, { sender: ctx.sender });
    }, { description: 'Invoke any command from a base64-encoded JSON bundle ([name,...args] or {cmd,args})', usage: '<base64-json>' });

    router.register('reload', (args, ctx) => {
        // Schedule the reload after sending the response, so the caller gets the OK.
        // In --local mode the server sets Cache-Control: no-store, so a plain
        // reload always fetches fresh files — no query-param hack needed.
        setTimeout(() => location.reload(), 200);
        return { text: 'OK: reloading page in 200ms', data: null };
    }, { description: 'Reload the browser page (picks up code changes in --local mode)' });

    router.register('screenshot', (args, ctx) => {
        const canvas = ctx.renderer?.domElement;
        if (!canvas) {
            return { text: 'ERR: no renderer available', data: null };
        }
        // Force a render to ensure the buffer has current content
        ctx.renderer.render(ctx.scene, ctx.camera);
        const dataUrl = canvas.toDataURL('image/png');
        // Strip the data:image/png;base64, prefix — caller gets raw base64
        const base64 = dataUrl.split(',')[1];
        return {
            text: `OK: screenshot ${canvas.width}x${canvas.height}`,
            data: { width: canvas.width, height: canvas.height, image: base64 },
        };
    }, { description: 'Capture the 3D canvas as a PNG screenshot' });

    router.register('console.log', (args, ctx) => {
        // Capture and return recent console output — useful for remote debugging.
        // For now, return a confirmation. Future: hook console and buffer recent entries.
        const msg = args.join(' ');
        console.log(`[remote] ${msg}`);
        return { text: `OK: logged "${msg}"`, data: null };
    }, { description: 'Log a message to the browser console', usage: '<message>' });
}

/**
 * CommandRouter — shell-style command parsing and dispatch.
 *
 * Evolved from the stale WebSocket branch. Key changes:
 * - Accepts a context bag instead of raw viewer reference
 * - Handlers return { text, data } (dual-return for TUI + programmatic)
 * - Supports async handlers
 * - Works standalone: callable from console, shortcuts, WebSocket, or UI
 *
 * Command names are dot-separated namespaces: camera.move, grid.list, etc.
 * Partial-match autocomplete when a prefix is unambiguous.
 */

import errorTracker from '../../utils/ErrorTracker.js';
import metrics from '../../utils/Metrics.js';
import { emitLogRecord } from './consoleForwarder.js';

// Per-dispatch correlation id, attached to ctx.cid so anything a handler logs can be
// joined back to its dispatch record.
let _cid = 0;

export default class CommandRouter {
    /**
     * @param {Object} context - service registry bag with subsystem references
     */
    constructor(context) {
        /** @type {Object} */
        this.context = context;

        /** @type {Map<string, {handler: Function, description: string, usage: string, returns: string}>} */
        this.commands = new Map();

        /** @type {Array<Function>} Middleware called before each command: (name, args, ctx) => void */
        this._middleware = [];
    }

    /**
     * Register a command handler.
     * @param {string} name - dot-separated name like "camera.move"
     * @param {Function} handler - (args[], context) => { text: string, data: any } | string
     * @param {Object} [meta]
     * @param {string} [meta.description] - one-line description
     * @param {string} [meta.usage] - usage pattern like "<x> <y> <z>"
     * @param {string} [meta.returns] - description of structured return data
     */
    register(name, handler, { description = '', usage = '', returns = '' } = {}) {
        this.commands.set(name.toLowerCase(), { handler, description, usage, returns });
    }

    /**
     * Register multiple commands from an array of definitions.
     * @param {Array<{name: string, handler: Function, description: string, usage?: string, returns?: string}>} defs
     */
    registerAll(defs) {
        for (const def of defs) {
            this.register(def.name, def.handler, {
                description: def.description,
                usage: def.usage || '',
                returns: def.returns || '',
            });
        }
    }

    /**
     * Add middleware that runs before every command.
     * @param {Function} fn - (name, args, context) => void
     */
    use(fn) {
        this._middleware.push(fn);
    }

    /**
     * Parse a command string into tokens.
     * Supports double-quoted strings, escaped quotes, and backslash escaping.
     * @param {string} input
     * @returns {string[]}
     */
    parse(input) {
        const tokens = [];
        let current = '';
        let inQuote = false;
        let escaped = false;

        for (const ch of input) {
            if (escaped) {
                if (ch === 'n') current += '\n';
                else if (ch === 't') current += '\t';
                else current += ch;
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                escaped = true;
                continue;
            }
            if (ch === '"') {
                inQuote = !inQuote;
                continue;
            }
            if (ch === ' ' && !inQuote) {
                if (current.length > 0) {
                    tokens.push(current);
                    current = '';
                }
                continue;
            }
            current += ch;
        }
        if (current.length > 0) tokens.push(current);
        return tokens;
    }

    /**
     * Execute a command.
     * @param {string|string[]} input - raw command string or pre-parsed [name, ...args]
     * @returns {Promise<{text: string, data: any}>}
     */
    /**
     * Execute a command.
     * @param {string|string[]} input - raw command string or pre-parsed [name, ...args]
     * @param {Object} [options]
     * @param {string} [options.sender] - identity of the caller (controller ID, 'local', etc.)
     * @returns {Promise<{text: string, data: any}>}
     */
    async execute(input, options = {}) {
        let name, args;

        if (Array.isArray(input)) {
            name = input[0]?.toLowerCase();
            args = input.slice(1);
        } else {
            const trimmed = String(input).trim();
            if (!trimmed) return { text: 'ERR: empty command', data: null };
            const tokens = this.parse(trimmed);
            name = tokens[0].toLowerCase();
            args = tokens.slice(1);
        }

        const cmd = this.commands.get(name);
        if (!cmd) {
            // Try partial-match autocomplete
            const matches = [...this.commands.keys()].filter(k => k.startsWith(name));
            if (matches.length === 1) {
                return this._run(matches[0], args, options);
            }
            if (matches.length > 1) {
                return {
                    text: `ERR: ambiguous command '${name}'. Matches: ${matches.join(', ')}`,
                    data: { matches }
                };
            }
            return {
                text: `ERR: unknown command '${name}'. Try 'help'.`,
                data: null
            };
        }

        return this._run(name, args, options);
    }

    /**
     * Execute a batch of commands sequentially.
     * @param {string[]} commands - array of command strings
     * @returns {Promise<Array<{text: string, data: any}>>}
     */
    async executeBatch(commands) {
        const results = [];
        for (const cmd of commands) {
            results.push(await this.execute(cmd));
        }
        return results;
    }

    /**
     * Get sorted list of all registered commands.
     * @returns {Array<{name: string, description: string, usage: string, returns: string}>}
     */
    listCommands() {
        return [...this.commands.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, { description, usage, returns }]) => ({
                name, description, usage, returns
            }));
    }

    /**
     * Get commands filtered by namespace prefix.
     * @param {string} namespace - e.g. "camera" returns camera.move, camera.info, etc.
     * @returns {Array<{name: string, description: string, usage: string}>}
     */
    listNamespace(namespace) {
        const prefix = namespace.toLowerCase() + '.';
        return this.listCommands().filter(c => c.name.startsWith(prefix) || c.name === namespace.toLowerCase());
    }

    /**
     * Run a resolved command with middleware.
     * @private
     */
    /**
     * Run a resolved command with middleware.
     * @param {string} name
     * @param {string[]} args
     * @param {Object} [options]
     * @private
     */
    async _run(name, args, options = {}) {
        const cmd = this.commands.get(name);

        // Run middleware
        for (const mw of this._middleware) {
            try { mw(name, args, this.context); } catch (e) { /* ignore middleware errors */ }
        }

        // Attach sender to the shared context for this call.
        // We set it directly (not a shallow copy) so that command handlers
        // that mutate ctx (e.g., lazy-initializing ctx.terminals) persist
        // their changes across calls. Sender is overwritten on each call.
        const ctx = this.context;
        ctx.sender = options.sender || null;
        const cid = ++_cid;
        ctx.cid = cid;

        // Self-instrument: every verb is a timed, counted, logged event — so metric.list /
        // log.tail / error.list show live command telemetry, and the bus's own failures land
        // in the structured buffer the harness reads. (This is the seam Step 2's spans wrap.)
        // The dispatch trace is telemetry, not gated debug chatter: it emits structured
        // records directly (scope 'command'), bypassing Logger level gates entirely.
        const t0 = performance.now();
        try {
            const result = await cmd.handler(args, ctx);
            const ms = performance.now() - t0;
            metrics.timing('command.duration', ms, { command: name });
            metrics.counter('command.total', 1, { command: name, status: 'ok' });
            emitLogRecord('trace', 'command', name, {
                args, ms: Math.round(ms), status: 'ok', cid, sender: ctx.sender ?? null
            });
            // Normalize: if handler returned a plain string, wrap it
            if (typeof result === 'string') {
                return { text: result, data: null };
            }
            return result || { text: 'OK', data: null };
        } catch (err) {
            const ms = performance.now() - t0;
            metrics.timing('command.duration', ms, { command: name });
            metrics.counter('command.total', 1, { command: name, status: 'err' });
            emitLogRecord('trace', 'command', name, {
                args, ms: Math.round(ms), status: 'err', cid, sender: ctx.sender ?? null,
                error: err.message
            });
            // Expected failures RETURN {text:'ERR:…'} and never reach here — only genuine
            // exceptions do, so route them to ErrorTracker (type: command_error).
            errorTracker.captureException(err, { type: 'command_error', command: name, args });
            return { text: `ERR: ${err.message}`, data: null };
        }
    }
}

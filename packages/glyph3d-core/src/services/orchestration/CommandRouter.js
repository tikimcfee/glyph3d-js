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
 * The dot is canonical, not required: "grid list" resolves to grid.list — the
 * verb is the longest chain of leading tokens that names a registered command
 * (an exactly-typed first token still short-circuits, so a single-word verb
 * like `select` keeps its arguments). Partial-match autocomplete when a prefix
 * is unambiguous, on the typed name or its dot-joined form ("grid li").
 */

import errorTracker from '../../utils/ErrorTracker.js';
import metrics from '../../utils/Metrics.js';
import { emitLogRecord } from './consoleForwarder.js';

/**
 * A command handler: `(args, ctx) => { text, data } | string`, sync or async.
 * @template C
 * @typedef {(args: string[], ctx: C) => any} CommandHandler
 */

// Per-dispatch correlation id, answered by the call's ctx.cid so anything a handler logs can be
// joined back to its dispatch record.
let _cid = 0;

// The call whose handler is running SYNCHRONOUSLY right now (null between calls): a raw
// router.execute made inside it — a service the handler calls — inherits its caller. After an
// await that span is over; a handler's own nested calls go through ctx.execute, which carries
// the call wherever it runs.
/** @type {CallFrame|null} */
let _running = null;

/**
 * One call's identity: who sent it (the controller to answer — a relay routing id, 'local', …),
 * who that is by NAME (an identified agent; null = anonymous), and its correlation id.
 * @typedef {{sender: string|null, caller: string|null, cid: number, parentCid: number|null}} CallFrame
 */

/**
 * @template [C=Object] the context bag's shape — inferred from `new CommandRouter(ctx)`,
 *   so every registered handler's `ctx` is typed by its host app
 */
export default class CommandRouter {
    /**
     * @param {C} context - service registry bag with subsystem references
     */
    constructor(context) {
        /** @type {C} */
        this.context = context;

        /** @type {Map<string, {handler: CommandHandler<C>, description: string, usage: string, returns: string}>} */
        this.commands = new Map();

        /** @type {Array<Function>} Middleware called before each command: (name, args, ctx) => void */
        this._middleware = [];
    }

    /**
     * Register a command handler.
     * @param {string} name - dot-separated name like "camera.move"
     * @param {CommandHandler<C>} handler
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
     * @param {Array<{name: string, handler: CommandHandler<C>, description: string, usage?: string, returns?: string}>} defs
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
     * @param {(name: string, args: string[], ctx: C) => void} fn
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
     * Execute a command. Each call runs its handler on its own VIEW of the context (see _viewFor):
     * `ctx.sender` / `ctx.caller` / `ctx.cid` are THIS call's, whatever else runs in between, and
     * `ctx.execute` makes a nested call that inherits them.
     * @param {string|string[]} input - raw command string or pre-parsed [name, ...args]
     * @param {Object} [options]
     * @param {string|null} [options.sender] - the controller to answer (relay routing id, 'local', …);
     *   absent → inherited from the calling call, if any
     * @param {string|null} [options.caller] - the caller's NAME, when identified (`glyph3d-cli --as`);
     *   absent → inherited
     * @param {CallFrame} [options.parent] - the call this one is nested in (ctx.execute sets it)
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
            const r = this._resolveLoose(name, args);
            if (r.name) return this._run(r.name, r.args, options);
            if (r.matches.length > 0) {
                return {
                    text: `ERR: ambiguous command '${r.typed}'. Matches: ${r.matches.join(', ')}`,
                    data: { matches: r.matches }
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
     * Resolve a first token that isn't an exact command name.
     *
     * 1. Dot-free spelling — leading arg tokens join into the name, and the
     *    LONGEST registered chain wins: "camera frame bounds" means
     *    camera.frame.bounds, not camera.frame with a stray arg. A genuine
     *    argument can only be swallowed if it literally spells a deeper verb.
     * 2. Unambiguous prefix, typed ("gri.list") or dot-joined ("grid li").
     *
     * @param {string} name - lowercased first token
     * @param {string[]} args
     * @returns {{name: string, args: string[]} | {typed: string, matches: string[]}}
     * @private
     */
    _resolveLoose(name, args) {
        let chain = name, best = null;
        for (let i = 0; i < args.length; i++) {
            chain += '.' + String(args[i]).toLowerCase();
            if (this.commands.has(chain)) best = { name: chain, args: args.slice(i + 1) };
        }
        if (best) return best;

        const keys = [...this.commands.keys()];
        const byName = keys.filter(k => k.startsWith(name));
        if (byName.length === 1) return { name: byName[0], args };
        if (args.length > 0) {
            const joined = name + '.' + String(args[0]).toLowerCase();
            const byJoined = keys.filter(k => k.startsWith(joined));
            if (byJoined.length === 1) return { name: byJoined[0], args: args.slice(1) };
            // A joined-prefix ambiguity names the intent more tightly than the
            // bare-name one ("grid l" lists grid.list|grid.layout, not all grid.*).
            if (byJoined.length > 1) return { typed: joined, matches: byJoined };
        }
        return { typed: name, matches: byName };
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

        // This call's identity: given, else the calling call's (nested), else anonymous.
        const parent = options.parent ?? _running;
        const cid = ++_cid;
        /** @type {CallFrame} */
        const frame = {
            sender: options.sender !== undefined ? (options.sender || null) : (parent?.sender ?? null),
            caller: options.caller !== undefined ? (options.caller || null) : (parent?.caller ?? null),
            cid, parentCid: parent?.cid ?? null,
        };
        const ctx = this._viewFor(frame);

        // Run middleware
        for (const mw of this._middleware) {
            try { mw(name, args, ctx); } catch (e) { /* ignore middleware errors */ }
        }

        // Self-instrument: every verb is a timed, counted, logged event — so metric.list /
        // log.tail / error.list show live command telemetry, and the bus's own failures land
        // in the structured buffer the harness reads. (This is the seam Step 2's spans wrap.)
        // The dispatch trace is telemetry, not gated debug chatter: it emits structured
        // records directly (scope 'command'), bypassing Logger level gates entirely.
        const t0 = performance.now();
        try {
            // The handler's synchronous span runs as this call (a raw router.execute inside it inherits).
            const before = _running;
            _running = frame;
            let pending;
            try { pending = cmd.handler(args, ctx); } finally { _running = before; }
            const result = await pending;
            const ms = performance.now() - t0;
            metrics.timing('command.duration', ms, { command: name });
            metrics.counter('command.total', 1, { command: name, status: 'ok' });
            emitLogRecord('trace', 'command', name, {
                args, ms: Math.round(ms), status: 'ok', cid, sender: frame.sender, caller: frame.caller, parentCid: frame.parentCid,
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
                args, ms: Math.round(ms), status: 'err', cid, sender: frame.sender, caller: frame.caller, parentCid: frame.parentCid,
                error: err.message
            });
            // Expected failures RETURN {text:'ERR:…'} and never reach here — only genuine
            // exceptions do, so route them to ErrorTracker (type: command_error).
            errorTracker.captureException(err, { type: 'command_error', command: name, args });
            return { text: `ERR: ${err.message}`, data: null };
        }
    }
    /**
     * The context as ONE call sees it: `sender`, `caller`, `cid` and `execute` are the call's own
     * (writing them throws); everything else IS the shared bag — reads see it, writes land in it
     * (handlers keep shared state there: the active desk, lazy caches), getters run on it. A
     * Proxy rather than Object.create: a prototype view would keep a handler's writes on the view,
     * lost when the call ends. `ctx.execute(input, options?)` runs a nested call that inherits
     * this one's sender and caller (options override them).
     * @param {CallFrame} frame
     * @returns {C}
     * @private
     */
    _viewFor(frame) {
        const own = {
            sender: frame.sender, caller: frame.caller, cid: frame.cid,
            execute: (input, options = {}) => this.execute(input, { ...options, parent: frame }),
        };
        return /** @type {C} */ (new Proxy(/** @type {Object} */ (this.context), {
            get: (target, key) => (Object.hasOwn(own, key) ? own[key] : Reflect.get(target, key)),
            set: (target, key, value) => {
                if (Object.hasOwn(own, key)) throw new Error(`ctx.${String(key)} belongs to the call (cid ${frame.cid}) — read-only`);
                target[key] = value;
                return true;
            },
        }));
    }
}

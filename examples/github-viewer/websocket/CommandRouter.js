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
                current += ch;
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
    async execute(input) {
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
                return this._run(matches[0], args);
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

        return this._run(name, args);
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
    async _run(name, args) {
        const cmd = this.commands.get(name);

        // Run middleware
        for (const mw of this._middleware) {
            try { mw(name, args, this.context); } catch (e) { /* ignore middleware errors */ }
        }

        try {
            const result = await cmd.handler(args, this.context);
            // Normalize: if handler returned a plain string, wrap it
            if (typeof result === 'string') {
                return { text: result, data: null };
            }
            return result || { text: 'OK', data: null };
        } catch (err) {
            return { text: `ERR: ${err.message}`, data: null };
        }
    }
}

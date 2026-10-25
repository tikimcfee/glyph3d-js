/**
 * GomuxProvider — JSON-RPC client for the relay's gomuxai watcher (cli/gomux.go): the
 * agent orchestrator's tree, and each agent's transcript as raw bytes.
 *
 * A thin transport, the AgentSessionProvider's sibling: list() is the tree snapshot,
 * read() one agent's transcript window (bytes — decoding belongs to the codec), and
 * onChange() the relay's `gomux/changed` push, which carries the whole snapshot each time
 * the tree, a status, or a transcript's size moves.
 *
 * @typedef {Object} GomuxAgent
 * @property {string} name
 * @property {string} parent          spawner's name ('' = a person)
 * @property {string} backend         claude | agy | aider | custom
 * @property {string} session         tmux session (agent-<name>)
 * @property {string} dataDir         the .gomuxai store recording it
 * @property {string} [cwd]
 * @property {string} createdAt       RFC3339 UTC
 * @property {boolean} live           not cleaned up
 * @property {boolean} attached       its tmux session exists now
 * @property {string} [status]        idle|processing|waiting|error|exited|unknown
 * @property {string} [event] @property {string} [detail] @property {string} [tool]
 * @property {string} [toolInput]     a pending permission prompt's full call
 * @property {string} [statusAt] @property {string} [sessionId]
 * @property {string} [transcript]    path (served only through read())
 * @property {string} [harness]       claude | agy — which dialect reads it
 * @property {number} [transcriptSize] @property {number} [transcriptMtime]
 *
 * @typedef {{gen: number, dirs: string[], agents: GomuxAgent[]}} GomuxSnapshot
 */

export class GomuxProvider {
    /** @param {import('../orchestration/WebSocketBridge.js').default} bridge */
    constructor(bridge) {
        this._bridge = bridge;
    }

    /** @returns {Promise<GomuxSnapshot>} */
    async list() {
        return await this._bridge.rpcRequest('gomux/list', {});
    }

    /**
     * One agent's transcript window — agentSessions/read's window rules and return shape
     * (the `harness` opt readSessionTail passes is the snapshot's to know, so it's dropped).
     * @param {string} name
     * @param {{tailBytes?: number, fromOffset?: number, maxBytes?: number}} [opts]
     * @returns {Promise<{bytes: Uint8Array, offset: number, size: number|null,
     *          truncated: boolean, mtime: number|null, cwd: string|null}>}
     */
    async read(name, opts = {}) {
        const params = { name, binary: true };
        if (opts.tailBytes != null) params.tailBytes = opts.tailBytes;
        if (opts.fromOffset != null) params.fromOffset = opts.fromOffset;
        if (opts.maxBytes != null) params.maxBytes = opts.maxBytes;
        let r;
        try {
            r = await this._bridge.rpcRequest('gomux/read', params);
        } catch (e) {
            console.error('[gomux] gomux/read failed', params, e?.message || e);
            throw e;
        }
        const bytes = r?.bytes ?? new TextEncoder().encode(r?.content ?? '');
        return { bytes, offset: r?.offset ?? 0, size: r?.size ?? null,
                 truncated: !!r?.truncated, mtime: r?.mtime ?? null, cwd: r?.cwd || null };
    }

    /**
     * Subscribe to the relay's tree pushes. Returns the unsubscribe fn.
     * @param {(snap: GomuxSnapshot) => void} fn
     */
    onChange(fn) {
        return this._bridge.onRpcNotification((method, params) => {
            if (method === 'gomux/changed') fn(params);
        });
    }

    /**
     * Subscribe to screened agents' pane sizes changing (`gomux/paneSize` — the relay reads
     * them every couple of seconds). Returns the unsubscribe fn.
     * @param {(e: {name: string, id: string, cols: number, rows: number}) => void} fn
     */
    onPaneSize(fn) {
        return this._bridge.onRpcNotification((method, params) => {
            if (method === 'gomux/paneSize') fn(params);
        });
    }
}

export default GomuxProvider;

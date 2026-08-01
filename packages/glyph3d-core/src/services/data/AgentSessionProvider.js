/**
 * AgentSessionProvider — JSON-RPC client for the relay's agent-session archive
 * (the transcript files the relay serves via agentSessions/*).
 *
 * A thin transport, nothing more: list() enumerates the archive, read()
 * fetches one session's raw content (optionally just the tail window). No
 * parsing happens here — the adapter that turns transcript content into
 * sheets owns the semantics.
 */

export class AgentSessionProvider {
    /**
     * @param {import('../orchestration/WebSocketBridge.js').default} bridge
     */
    constructor(bridge) {
        this._bridge = bridge;
    }

    /**
     * Enumerate archived sessions, newest first (server-ordered).
     * @returns {Promise<{ id: string, size: number, mtime: number }[]>} mtime is unix ms
     */
    async list() {
        const r = await this._bridge.rpcRequest('agentSessions/list', {});
        return r?.sessions || [];
    }

    /**
     * Read one session's raw content.
     * @param {string} id - session id as returned by list()
     * @param {Object} [opts]
     * @param {number} [opts.tailBytes] - read only the trailing byte window
     * @returns {Promise<{ content: string, truncated: boolean, mtime: number|null }>}
     */
    async read(id, opts = {}) {
        const params = { id };
        if (opts.tailBytes != null) params.tailBytes = opts.tailBytes;
        const r = await this._bridge.rpcRequest('agentSessions/read', params);
        return { content: r?.content ?? '', truncated: !!r?.truncated, mtime: r?.mtime ?? null };
    }
}

export default AgentSessionProvider;

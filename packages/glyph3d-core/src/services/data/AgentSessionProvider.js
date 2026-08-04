/**
 * AgentSessionProvider — JSON-RPC client for the relay's agent-session archive
 * (the transcript files the relay serves via agentSessions/*).
 *
 * A thin transport, nothing more: list() enumerates the archive, read()
 * fetches one session's raw BYTES (optionally just the tail window). No
 * parsing AND no decoding happens here — the codec stage (the session
 * parse pool) owns bytes→text→events; transport moves bytes.
 */

export class AgentSessionProvider {
    /**
     * @param {import('../orchestration/WebSocketBridge.js').default} bridge
     */
    constructor(bridge) {
        this._bridge = bridge;
    }

    /**
     * Enumerate archived sessions, newest first (server-ordered). Both harnesses
     * ride the one list — each entry's `harness` field ("claude" | "kimi") says
     * which adapter can open it.
     * @returns {Promise<{ id: string, size: number, mtime: number, harness: string }[]>} mtime is unix ms
     */
    async list() {
        const r = await this._bridge.rpcRequest('agentSessions/list', {});
        return r?.sessions || [];
    }

    /**
     * Read one session's raw content. Transport is transport: the transcript
     * crosses as BYTES end-to-end (the binary result plane; a legacy JSON
     * relay's string is encoded here, same return shape either way). DECODE
     * is the codec stage's job — the session parse pool (parseSessionOffThread)
     * decodes + parses off the main thread; nothing here ever sees a string.
     * @param {string} id - session id as returned by list()
     * @param {Object} [opts]
     * @param {number} [opts.tailBytes] - read only the trailing byte window
     * @param {string} [opts.harness] - which archive the id resolves against (default 'claude')
     * @returns {Promise<{ bytes: Uint8Array, truncated: boolean, mtime: number|null, cwd: string|null }>}
     *          cwd is the index's workDir for kimi sessions (their transcript doesn't
     *          reliably carry one), null otherwise
     */
    async read(id, opts = {}) {
        const params = { id, binary: true };
        if (opts.tailBytes != null) params.tailBytes = opts.tailBytes;
        if (opts.harness != null) params.harness = opts.harness;
        const r = await this._bridge.rpcRequest('agentSessions/read', params);
        const bytes = r?.bytes ?? new TextEncoder().encode(r?.content ?? '');
        return { bytes, truncated: !!r?.truncated, mtime: r?.mtime ?? null, cwd: r?.cwd ?? null };
    }
}

export default AgentSessionProvider;

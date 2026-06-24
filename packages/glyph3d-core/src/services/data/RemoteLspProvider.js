/**
 * RemoteLspProvider — thin client for the relay-hosted LSP supervisor.
 *
 * Mirrors RemoteFileSystemProvider: each method is a JSON-RPC call over the
 * WebSocketBridge to the Go relay, which owns the language-server lifecycle
 * (spawn, initialize, document sync, request correlation — see cli/lsp.go). This
 * class adds no protocol logic; it's the browser end of the lsp/* surface.
 *
 * Positions on the wire are LSP-encoded (UTF-16 `character` offsets) — the caller
 * (lspCommands.js) converts codepoint↔UTF-16 at the seam. `text`, when provided,
 * is the grid's live buffer so the server answers against what's on screen rather
 * than disk; omit it to let the relay read the file.
 */
class RemoteLspProvider {
    constructor(bridge) {
        this._bridge = bridge;
    }

    /**
     * Go-to-definition for the symbol at (line, character) in `uri`.
     * @returns {Promise<{ locations: Array<{ uri: string, range: { start: {line,character}, end: {line,character} } }> }>}
     */
    definition(uri, line, character, text) {
        return this._rpc('lsp/definition', { uri, line, character, text });
    }

    /** Find references to the symbol at (line, character). Same result shape as definition. */
    references(uri, line, character, text) {
        return this._rpc('lsp/references', { uri, line, character, text });
    }

    /** Server availability + run state. @returns {Promise<{ root: string, servers: object[] }>} */
    status() {
        return this._bridge.rpcRequest('lsp/status', {});
    }

    // Position queries get a generous timeout: a cold language server indexes the
    // project before its first answer (the relay retries empty results until then).
    _rpc(method, params) {
        if (!this._bridge) throw new Error('LSP bridge not connected');
        return this._bridge.rpcRequest(method, params, 35000);
    }
}

export default RemoteLspProvider;

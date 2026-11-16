/**
 * GomuxProvider — JSON-RPC client for the relay's gomuxai watcher (cli/gomux.go): the
 * agent orchestrator's tree.
 *
 * A thin transport, the AgentSessionProvider's sibling (which carries each agent's events —
 * an agent's book follows its `sessionId`): list() is the tree snapshot, onChange() the
 * relay's `gomux/changed` push, which carries the whole snapshot each time the tree or a
 * status moves, and onPaneSize() the screens' pane sizes.
 *
 * @typedef {Object} GomuxAgent
 * @property {string} name
 * @property {string} [host]          the bus's name for the machine it runs on (the snapshot's `host`: this one)
 * @property {string} parent          spawner's name ('' = a person)
 * @property {string} backend         claude | agy | aider | custom
 * @property {string} session         tmux session (agent-<name>)
 * @property {string} dataDir         the .gomuxai store recording it ('' for another host's agent)
 * @property {string} [cwd]
 * @property {string} createdAt       RFC3339 UTC
 * @property {boolean} live           not cleaned up
 * @property {boolean} [attached]     its tmux session exists now; absent when its host couldn't say
 * @property {string} [status]        idle|processing|waiting|error|ended|unknown (gomuxai's `agent statuses`)
 * @property {string} [endReason]     with ended: quit|gone|replaced|finished|parent|closed
 * @property {string} [event] @property {string} [detail] @property {string} [tool]
 * @property {string} [toolInput]     a pending permission prompt's full call
 * @property {string} [statusAt]
 * @property {string} [sessionId]     the harness session its current transcript records
 * @property {string} [transcript]    that transcript's path
 * @property {string} [harness]       claude | agy — the harness writing it
 * @property {number} [transcriptSize] @property {number} [transcriptMtime]
 *
 * @typedef {{gen: number, host?: string, dirs: string[], agents: GomuxAgent[]}} GomuxSnapshot
 *   `host`: this machine's name on the bus. A relay following the bus (`serve --gomuxai-hosts`)
 *   lists other hosts' agents too: no store, transcript or screen here, one node per (host, name).
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

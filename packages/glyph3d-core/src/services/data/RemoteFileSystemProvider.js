/**
 * RemoteFileSystemProvider — JSON-RPC 2.0 client for local filesystem access
 * via the Go relay.
 *
 * Implements the FileSystemProvider interface using `bridge.rpcRequest()`
 * for transport. Mirrors RepositoryAdapter's public surface so the viewer
 * can swap providers without changing the grid creation / layout pipeline.
 *
 * Reads (readFile / readRange / listTree / stat) flow through here. Writes do
 * NOT — file.save issues fs/writeFile on the bridge directly. The one write-side
 * affordance this provider adds is getFileWithStat: it surfaces the disk mtime
 * alongside content so the editor can stash a sync token for the save-time
 * stale-write check (the GitHub adapter has no mtime and omits this method).
 */

import { FileSystemError } from './types.js';
import { RepositoryAdapter } from './RepositoryAdapter.js';

// Shared filter logic — reuse RepositoryAdapter's blacklist
const _filterProto = RepositoryAdapter.prototype.filterCodeFiles;

export class RemoteFileSystemProvider {
    /**
     * @param {import('../orchestration/WebSocketBridge.js').default} bridge
     * @param {Object} [options]
     * @param {string} [options.root] - display label for the root path
     */
    constructor(bridge, options = {}) {
        this.scheme = 'file';
        this._bridge = bridge;
        this._root = options.root || '.';
        this._disposed = false;

        // State matching RepositoryAdapter surface
        this._currentTree = null;
        this._progress = { loaded: 0, total: 0, current: null };
    }

    // ---- FileSystemProvider interface ----

    /**
     * Read a file from the relay.
     * @param {string} uri - e.g. "file:///src/index.js"
     * @returns {Promise<import('./types.js').FileContent>}
     */
    async readFile(uri) {
        return this._rpc('fs/readFile', { uri });
    }

    /**
     * Read a raw byte window from a file — the memory-viewer / demand-paging tap.
     * Binary-safe (no UTF-8 gate) and large-file-safe (only the window is read,
     * capped server-side at 4MB/call). Decodes the base64 payload to bytes here
     * so callers get a Uint8Array directly.
     * @param {string} uri - e.g. "file:///vmlinux"
     * @param {number} offset - byte offset into the file (the "address")
     * @param {number} length - bytes requested (actual may be fewer at EOF)
     * @returns {Promise<{ uri: string, offset: number, length: number, totalSize: number, bytes: Uint8Array }>}
     */
    async readRange(uri, offset, length) {
        const r = await this._rpc('fs/readRange', { uri, offset, length });
        const bin = atob(r.content || '');
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return { uri: r.uri, offset: r.offset, length: r.length, totalSize: r.totalSize, bytes };
    }

    /**
     * Read a whole file as bytes — the image / binary transport. Loops readRange until
     * EOF, so a large file is fetched in server-capped windows rather than one slurp.
     * Mirrors getFile()'s path→uri convention. Pass { maxBytes } to stop early (a head
     * sniff for magic bytes); reads stop at the cap or EOF, whichever comes first.
     * @param {string} path
     * @param {{ maxBytes?: number, chunk?: number }} [opts]
     * @returns {Promise<Uint8Array>}
     */
    async getBytes(path, { maxBytes = Infinity, chunk = 1 << 20 } = {}) {
        const uri = `file:///${String(path).replace(/^\/+/, '')}`;   // strip leading slashes → canonical (matches file.open)
        const parts = [];
        let offset = 0, total = Infinity, size = 0;
        while (offset < total && size < maxBytes) {
            const want = Math.min(chunk, maxBytes - size);
            const r = await this.readRange(uri, offset, want);
            total = r.totalSize;
            if (!r.bytes.length) break;          // EOF / empty
            parts.push(r.bytes);
            offset += r.bytes.length;
            size += r.bytes.length;
            if (r.bytes.length < want) break;    // short read = EOF
        }
        if (parts.length === 1) return parts[0];
        const out = new Uint8Array(size);
        let p = 0;
        for (const b of parts) { out.set(b, p); p += b.length; }
        return out;
    }

    /**
     * Recursively list a directory. "file:///" (or empty) walks the served
     * root; any other path resolves with the same precedence rules as content
     * read/write, so added roots (fs/addRoot) are walkable too. Entries come
     * back relative to the walked directory, with an explicit truncated flag
     * when the server's entry cap stopped the walk.
     * @param {string} uri - e.g. "file:///" (root) or "file:///home/x/proj"
     * @param {Object} [options]
     * @returns {Promise<import('./types.js').TreeListing>}
     */
    async listTree(uri, options = {}) {
        return this._rpc('fs/listTree', { uri, ...options });
    }

    /**
     * Stat a single path.
     * @param {string} uri
     * @returns {Promise<import('./types.js').FileStat>}
     */
    async stat(uri) {
        return this._rpc('fs/stat', { uri });
    }

    // ---- RepositoryAdapter surface (swap-compatible) ----

    /**
     * Load the repository tree. Mirrors RepositoryAdapter.loadRepository().
     * @returns {Promise<Object>} - { tree: { tree: DirEntry[] }, owner, repo, branch }
     */
    async loadRepository() {
        const { entries } = await this.listTree('file:///');
        this._currentTree = { tree: entries };
        return {
            tree: this._currentTree,
            owner: 'local',
            repo: this._root,
            branch: 'disk',
        };
    }

    /**
     * Get the repository tree structure.
     * Mirrors RepositoryAdapter.getRepositoryTree().
     * @returns {Promise<Object>} - { tree: DirEntry[] }
     */
    async getRepositoryTree() {
        if (this._currentTree) return this._currentTree;
        const { entries } = await this.listTree('file:///');
        this._currentTree = { tree: entries };
        return this._currentTree;
    }

    /**
     * Filter code files from tree. Delegates to RepositoryAdapter's blacklist.
     * @param {Object} tree - { tree: DirEntry[] }
     * @param {Object} [options]
     * @returns {Object[]}
     */
    filterCodeFiles(tree, options = {}) {
        // DirEntry uses 'file'/'directory' in .type; RepositoryAdapter expects 'blob'.
        // Adapt on the fly.
        const adapted = {
            tree: tree.tree.map(e => ({
                path: e.path,
                type: e.type === 'file' ? 'blob' : e.type === 'directory' ? 'tree' : e.type,
                size: e.size,
            }))
        };
        return _filterProto.call(this, adapted, options);
    }

    /**
     * Fetch multiple files in parallel. Mirrors RepositoryAdapter.getMultipleFiles().
     * @param {string} _owner - ignored (local mode)
     * @param {string} _repo - ignored
     * @param {string[]} paths
     * @param {string} [_branch] - ignored
     * @returns {Promise<Map<string, { content: string }>>}
     */
    async getMultipleFiles(_owner, _repo, paths, _branch) {
        const results = new Map();
        const concurrency = 8;

        for (let i = 0; i < paths.length; i += concurrency) {
            const batch = paths.slice(i, i + concurrency);
            const settled = await Promise.allSettled(
                batch.map(async (path) => {
                    const uri = `file:///${String(path).replace(/^\/+/, '')}`;   // strip leading slashes → canonical (matches file.open)
                    const fc = await this.readFile(uri);
                    return { path, content: fc.content };
                })
            );
            for (const result of settled) {
                if (result.status === 'fulfilled') {
                    results.set(result.value.path, { content: result.value.content });
                }
            }
            this._progress.loaded = Math.min(i + concurrency, paths.length);
        }
        return results;
    }

    /**
     * Async generator yielding file contents. Mirrors RepositoryAdapter.streamFiles().
     * @param {Object} [options]
     * @yields {{ path: string, content: string, size: number }}
     */
    async *streamFiles(options = {}) {
        const tree = await this.getRepositoryTree();
        const files = this.filterCodeFiles(tree, options);
        this._progress.total = files.length;
        this._progress.loaded = 0;

        for (const file of files) {
            this._progress.current = file.path;
            try {
                const uri = `file:///${file.path}`;
                const fc = await this.readFile(uri);
                this._progress.loaded++;
                yield { path: file.path, content: fc.content, size: file.size };
            } catch (err) {
                console.warn(`RemoteFileSystemProvider: failed to read ${file.path}: ${err.message}`);
                this._progress.loaded++;
            }
        }
        this._progress.current = null;
    }

    /**
     * Get a single file's content. Mirrors RepositoryAdapter.getFile().
     * @param {string} path
     * @returns {Promise<string>}
     */
    async getFile(path) {
        const uri = `file:///${String(path).replace(/^\/+/, '')}`;   // strip leading slashes → canonical (matches file.open)
        const fc = await this.readFile(uri);
        return fc.content;
    }

    /**
     * Like getFile, but also returns the disk mtime the content was read at —
     * the sync token the editor stashes so a later fs/writeFile can pass it as
     * baseMtime and the relay can refuse the write if the file changed on disk
     * underneath us. Local-only; the GitHub adapter has no mtime and does not
     * offer this method (callers feature-detect it).
     * @param {string} path
     * @returns {Promise<{ content: string, mtime: number|null }>}
     */
    async getFileWithStat(path) {
        const uri = `file:///${String(path).replace(/^\/+/, '')}`;   // strip leading slashes → canonical (matches file.open)
        const fc = await this.readFile(uri);
        return { content: fc.content, mtime: fc.stat?.mtime ?? null };
    }

    /**
     * Get loading progress.
     * @returns {{ loaded: number, total: number, current: string|null }}
     */
    getProgress() {
        return { ...this._progress };
    }

    /**
     * Stub: adapter stats. Local provider doesn't track GitHub-style stats.
     * @returns {Object}
     */
    getStats() {
        return {
            totalRequests: 0,
            cacheHits: 0,
            apiRequests: 0,
            rawRequests: 0,
            failures: 0,
            cacheHitRate: '0%',
            cache: {},
            rateLimitRemaining: Infinity,
            useRawUrls: false,
        };
    }

    /**
     * Clean up.
     */
    dispose() {
        this._disposed = true;
    }

    // ---- Internal ----

    /**
     * Send a JSON-RPC request via the bridge.
     * @param {string} method
     * @param {Object} params
     * @returns {Promise<any>}
     * @private
     */
    async _rpc(method, params) {
        if (this._disposed) {
            throw new FileSystemError('Provider disposed', -32000);
        }
        return this._bridge.rpcRequest(method, params);
    }
}

export default RemoteFileSystemProvider;

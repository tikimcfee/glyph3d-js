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

// Content arrives on the binary result plane as raw bytes (providers opt in per
// request); one decoder for every text payload. Legacy JSON responses (an older
// relay, or an error path) still carry string content — callers branch on `bytes`.
const _utf8 = new TextDecoder();

/** Decode a binary-plane result to its content string; legacy results pass through. */
function contentOf(r) {
    return r?.bytes ? _utf8.decode(r.bytes) : (r?.content ?? '');
}

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

        // What the binary is serving + can reach — {root, extraRoots, home, sep},
        // null until refreshRoots() has run (CommandProvider calls it on connect,
        // BEFORE session restore, so path normalization knows the served root).
        this.rootInfo = null;

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
        const r = await this._rpc('fs/readFile', { uri, binary: true });
        return { ...r, content: contentOf(r) };
    }

    /**
     * Read a raw byte window from a file — the memory-viewer / demand-paging tap.
     * Binary-safe (no UTF-8 gate) and large-file-safe (only the window is read,
     * capped server-side at 4MB/call). Rides the binary result plane: the payload
     * arrives as bytes (an older relay falls back to base64-in-JSON — decoded here,
     * same return shape either way).
     * @param {string} uri - e.g. "file:///vmlinux"
     * @param {number} offset - byte offset into the file (the "address")
     * @param {number} length - bytes requested (actual may be fewer at EOF)
     * @returns {Promise<{ uri: string, offset: number, length: number, totalSize: number, bytes: Uint8Array }>}
     */
    async readRange(uri, offset, length) {
        const r = await this._rpc('fs/readRange', { uri, offset, length, binary: true });
        let bytes = r.bytes;
        if (!bytes) {
            const bin = atob(r.content || '');
            bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        }
        return { uri: r.uri, offset: r.offset, length: r.length, totalSize: r.totalSize, bytes };
    }

    /**
     * Read a whole file as bytes — the image / binary transport. The first window
     * establishes totalSize; the rest of the file then reads as PARALLEL windows
     * (6 in flight) instead of a serial walk — whole-file slurps scale with the
     * pipe, not the chunk count. Pass { maxBytes } to stop early (a head sniff for
     * magic bytes); reads stop at the cap or EOF, whichever comes first.
     * @param {string} path
     * @param {{ maxBytes?: number, chunk?: number }} [opts]
     * @returns {Promise<Uint8Array>}
     */
    async getBytes(path, { maxBytes = Infinity, chunk = 1 << 20 } = {}) {
        const uri = `file:///${String(path).replace(/^\/+/, '')}`;   // strip leading slashes → canonical (matches file.open)
        const size = Math.min(chunk, maxBytes);
        const first = await this.readRange(uri, 0, size);
        const total = Math.min(first.totalSize, maxBytes);
        if (!first.bytes.length || first.bytes.length >= total) return first.bytes.subarray(0, total);

        const out = new Uint8Array(total);
        out.set(first.bytes, 0);
        const CONCURRENCY = 6;
        for (let off = first.bytes.length; off < total;) {
            const windows = [];
            for (let i = 0; i < CONCURRENCY && off < total; i++, off += chunk) {
                windows.push({ off, len: Math.min(chunk, total - off) });
            }
            const parts = await Promise.all(windows.map((w) => this.readRange(uri, w.off, w.len)));
            for (let i = 0; i < parts.length; i++) {
                out.set(parts[i].bytes.subarray(0, windows[i].len), windows[i].off);
            }
        }
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

    /**
     * Raw `git diff` text over the served root — the delta books' git lane
     * (delta.git). Both refs empty = working tree vs HEAD; base only = vs that
     * ref; base+head = ref..ref. The per-file split happens client-side
     * (services/state/deltaSource.js splitUnifiedDiff) — the relay stays transport.
     * @param {{ base?: string, head?: string, path?: string }} [opts]
     * @returns {Promise<{ root: string, base: string, head: string, diff: string, truncated: boolean }>}
     */
    async gitDiff({ base = '', head = '', path = '' } = {}) {
        return this._rpc('fs/gitDiff', { base, head, path });
    }

    // ---- Browse surface (relay-only) ----

    /**
     * Shallow, unfiltered listing of ONE directory — the browse primitive.
     * Absolute paths only (the server refuses relative URIs) and deliberately
     * wider than the read/write sandbox: hidden files, binaries, symlinks all
     * list, exactly what the operator would see with ls -a.
     * @param {string} path - absolute directory path (e.g. "/home/x/dev")
     * @returns {Promise<{ path: string, entries: {name:string,type:('file'|'directory'|'symlink'),size:number}[], truncated: boolean }>}
     */
    async readDir(path) {
        const uri = `file:///${String(path).replace(/^\/+/, '')}`;   // strip leading slashes → canonical (matches file.open)
        return this._rpc('fs/readDir', { uri });
    }

    /**
     * Register a directory as a runtime reach root — the dynamic form of
     * --reach. After this, content read/write and listTree work under it.
     * Keeps the cached rootInfo's reach list current from the response.
     * @param {string} path - absolute directory path
     * @returns {Promise<{ root: string, added: boolean, extraRoots: string[] }>}
     */
    async addRoot(path) {
        const uri = `file:///${String(path).replace(/^\/+/, '')}`;   // strip leading slashes → canonical (matches file.open)
        const res = await this._rpc('fs/addRoot', { uri });
        if (this.rootInfo && Array.isArray(res?.extraRoots)) this.rootInfo.extraRoots = res.extraRoots;
        return res;
    }

    /**
     * Fetch + cache what the binary is attached to: {root, extraRoots, home, sep}.
     * @returns {Promise<{ root: string, extraRoots: string[], home: string, sep: string }>}
     */
    async refreshRoots() {
        this.rootInfo = await this._rpc('fs/roots', {});
        return this.rootInfo;
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

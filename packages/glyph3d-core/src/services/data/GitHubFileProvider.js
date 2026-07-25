/**
 * GitHubFileProvider — client-only fileProvider backed by the GitHub API.
 *
 * The baseline file source: browses any public GitHub repo with zero backend
 * (pure `fetch` of api.github.com + raw.githubusercontent.com, via the inherited
 * RepositoryAdapter). It is a drop-in `ctx.fileProvider` — it exposes the same
 * surface RemoteFileSystemProvider does, so FileTree / file.open / file.openDir
 * work against GitHub unchanged. The relay (RemoteFileSystemProvider) is the
 * *additional* local source you get when the binary serves a project; this one
 * always works, relay or not.
 *
 * Extends RepositoryAdapter (the GitHub fetch+cache engine), adding the three
 * pieces the fileProvider interface needs that the adapter doesn't already have
 * in the right shape: listTree (DirEntry view of the loaded tree), a
 * shape-adapting filterCodeFiles, and a getMultipleFiles that fills owner/repo
 * from the loaded repo.
 */

import { RepositoryAdapter } from './RepositoryAdapter.js';

export class GitHubFileProvider extends RepositoryAdapter {
    constructor(options = {}) {
        super(options);
        this.scheme = 'github';
    }

    /**
     * List the loaded repo tree as a TreeListing — the same contract the relay
     * provider honors: entries relative to the listed directory, an explicit
     * truncated flag (GitHub's tree API sets one past ~100k entries).
     * `loadRepository(url)` must have run.
     * @param {string} [uri] - subtree to list (any scheme; path part is used); root lists all
     * @returns {Promise<import('./types.js').TreeListing>}
     */
    async listTree(uri = 'github:///', _options = {}) {
        const tree = this._currentTree;
        if (!tree || !Array.isArray(tree.tree)) return { entries: [], truncated: false };
        const dir = String(uri).replace(/^[a-z]+:\/\//, '').replace(/^\/+|\/+$/g, '');
        const prefix = dir ? dir + '/' : '';
        const entries = [];
        for (const e of tree.tree) {
            if (dir && !(e.path.startsWith(prefix))) continue;
            entries.push({
                path: dir ? e.path.slice(prefix.length) : e.path,
                type: e.type === 'tree' ? 'directory' : 'file',
                size: e.size || 0,
            });
        }
        return { entries, truncated: !!tree.truncated };
    }

    /**
     * Dual-shape, because RepositoryAdapter (parent) and RemoteFileSystemProvider
     * disagree on this method's signature:
     *   - no-arg → the cached tree as DirEntry[] (RemoteFileSystemProvider parity).
     *   - (owner, repo, branch) → the parent's cached GitHub fetch — this is what
     *     the inherited loadRepository() calls, so it MUST reach super (overriding
     *     it no-arg-only is what silently emptied the tree).
     * @returns {Promise<Object>}
     */
    async getRepositoryTree(owner, repo, branch) {
        if (owner == null) return { tree: (await this.listTree()).entries };
        return super.getRepositoryTree(owner, repo, branch);
    }

    /**
     * Filter code files. Accepts the DirEntry shape (`file`/`directory`) that
     * listTree emits OR the raw GitHub blob/tree shape (internal streamFiles);
     * normalizes to blob/tree and delegates to RepositoryAdapter's blacklist.
     * @param {{ tree: Array }} tree
     * @param {Object} [options]
     * @returns {Object[]}
     */
    filterCodeFiles(tree, options = {}) {
        const adapted = {
            tree: (tree?.tree || []).map((e) => ({
                path: e.path,
                type: e.type === 'file' ? 'blob' : e.type === 'directory' ? 'tree' : e.type,
                size: e.size,
                sha: e.sha,
            })),
        };
        return super.filterCodeFiles(adapted, options);
    }

    /**
     * Fetch many files. The viewer calls `getMultipleFiles(null, null, paths)`;
     * fill owner/repo/branch from the loaded repo (the adapter needs them).
     * @param {string|null} owner
     * @param {string|null} repo
     * @param {string[]} paths
     * @param {string} [branch]
     * @returns {Promise<Map<string, { content: string }>>}
     */
    async getMultipleFiles(owner, repo, paths, branch) {
        const r = this._currentRepo || {};
        return super.getMultipleFiles(
            owner || r.owner,
            repo || r.repo,
            paths,
            branch || r.branch || 'main'
        );
    }

    /** Provider lifecycle parity with RemoteFileSystemProvider. */
    dispose() {
        this.cancel();
    }
}

export default GitHubFileProvider;

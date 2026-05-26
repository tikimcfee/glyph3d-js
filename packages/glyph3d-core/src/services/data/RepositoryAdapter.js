/**
 * RepositoryAdapter - High-level adapter for fetching repository content
 *
 * Coordinates GitHubRepositorySource with RepositoryContentCache.
 * Provides convenient methods for fetching trees and files with caching.
 */

import GitHubRepositorySource, { GitHubError, RateLimitError } from './GitHubRepositorySource.js';
import RepositoryContentCache from './RepositoryContentCache.js';

// Re-export error classes
export { GitHubError, RateLimitError };

export class RepositoryAdapter {
    constructor(options = {}) {
        // Initialize cache
        this.cache = new RepositoryContentCache({
            ttl: options.cacheTtl || 5 * 60 * 1000, // 5 minutes default
            maxSize: options.cacheMaxSize || 1000,
        });

        // Initialize GitHub source
        this.source = new GitHubRepositorySource({
            token: options.token,
            timeout: options.timeout || 10000,
        });

        // Use raw.githubusercontent.com for file content (default: true)
        // - Handles UTF-8 natively (no base64 decoding issues)
        // - Does NOT count against GitHub API rate limit
        // - Faster for most files
        this.useRawUrls = options.useRawUrls !== false;

        // Statistics
        this.stats = {
            totalRequests: 0,
            cacheHits: 0,
            apiRequests: 0,
            rawRequests: 0,
            failures: 0,
        };

        // Current repository state
        this._currentRepo = null;
        this._currentTree = null;
        this._abortController = null;

        // Progress tracking
        this._progress = {
            loaded: 0,
            total: 0,
            current: null,
        };
    }

    /**
     * Load repository from URL
     * @param {string} url - GitHub URL or 'owner/repo' format
     * @returns {Promise<Object>} - Repo info with tree
     */
    async loadRepository(url) {
        const parsed = GitHubRepositorySource.parseGitHubUrl(url);
        if (!parsed) {
            throw new GitHubError(`Invalid GitHub URL: ${url}`);
        }

        this._currentRepo = parsed;
        this._abortController = new AbortController();
        this._progress = { loaded: 0, total: 0, current: 'Loading repository info...' };

        // Get repo info
        const repoInfo = await this.source.getRepositoryInfo(`${parsed.owner}/${parsed.repo}`);

        // Use the repo's default branch if no branch specified
        const branch = parsed.branch || (repoInfo?.defaultBranch) || 'main';
        this._currentRepo.branch = branch;

        // Get tree
        this._progress.current = 'Loading file tree...';
        const tree = await this.getRepositoryTree(parsed.owner, parsed.repo, branch);
        this._currentTree = tree;

        if (tree) {
            this._progress.total = tree.tree.filter(item => item.type === 'blob').length;
        }

        return {
            ...repoInfo,
            tree: tree,
            owner: parsed.owner,
            repo: parsed.repo,
            branch: branch,
        };
    }

    /**
     * Get all files as async iterator
     * @param {Object} options - Filter options
     * @param {Array} options.extensions - File extensions to include
     * @param {number} options.maxSize - Max file size to fetch
     * @yields {{path: string, content: string}}
     */
    async *streamFiles(options = {}) {
        if (!this._currentTree || !this._currentRepo) {
            throw new GitHubError('No repository loaded. Call loadRepository first.');
        }

        const files = this.filterCodeFiles(this._currentTree, options);
        this._progress.total = files.length;
        this._progress.loaded = 0;

        for (const file of files) {
            // Check for cancellation
            if (this._abortController?.signal.aborted) {
                break;
            }

            this._progress.current = file.path;

            try {
                const content = await this.getFileContent(
                    this._currentRepo.owner,
                    this._currentRepo.repo,
                    file.path,
                    this._currentRepo.branch
                );

                this._progress.loaded++;

                if (content) {
                    yield {
                        path: file.path,
                        content: content.content,
                        size: file.size,
                        sha: file.sha,
                    };
                }
            } catch (error) {
                console.warn(`RepositoryAdapter: Failed to fetch ${file.path}: ${error.message}`);
                this._progress.loaded++;
            }
        }

        this._progress.current = null;
    }

    /**
     * Get single file content (simplified API)
     * @param {string} path - File path in repo
     * @returns {Promise<string>} - File content
     */
    async getFile(path) {
        if (!this._currentRepo) {
            throw new GitHubError('No repository loaded. Call loadRepository first.');
        }

        const file = await this.getFileContent(
            this._currentRepo.owner,
            this._currentRepo.repo,
            path,
            this._currentRepo.branch
        );

        return file ? file.content : null;
    }

    /**
     * Get repository tree (returns cached tree if loaded)
     * @returns {Object|null} - Tree structure
     */
    getTree() {
        return this._currentTree;
    }

    /**
     * Get loading progress
     * @returns {Object} - Progress {loaded, total, current}
     */
    getProgress() {
        return { ...this._progress };
    }

    /**
     * Cancel loading
     */
    cancel() {
        if (this._abortController) {
            this._abortController.abort();
        }
    }

    /**
     * Get repository tree (with caching)
     * @param {string} owner - Repository owner
     * @param {string} repo - Repository name
     * @param {string} branch - Branch name (default: 'main')
     * @returns {Promise<Object|null>} - Tree data or null
     */
    async getRepositoryTree(owner, repo, branch = 'main') {
        this.stats.totalRequests++;

        const cacheKey = RepositoryContentCache.makeKey('tree', owner, repo, '', branch);

        // Check cache first
        const cached = await this.cache.get(cacheKey);
        if (cached) {
            this.stats.cacheHits++;
            return cached;
        }

        // Fetch from source
        try {
            const tree = await this.source.fetchTree(owner, repo, branch);

            if (tree) {
                await this.cache.set(cacheKey, tree);
                this.stats.apiRequests++;
                return tree;
            }

            this.stats.failures++;
            return null;

        } catch (error) {
            this.stats.failures++;
            throw error;
        }
    }

    /**
     * Get file content (with caching)
     * Uses raw.githubusercontent.com by default for better UTF-8 handling.
     *
     * @param {string} owner - Repository owner
     * @param {string} repo - Repository name
     * @param {string} path - File path
     * @param {string} branch - Branch name (default: 'main')
     * @returns {Promise<Object|null>} - File content or null
     */
    async getFileContent(owner, repo, path, branch = 'main') {
        this.stats.totalRequests++;

        const cacheKey = RepositoryContentCache.makeKey('file', owner, repo, path, branch);

        // Check cache first
        const cached = await this.cache.get(cacheKey);
        if (cached) {
            this.stats.cacheHits++;
            return cached;
        }

        // Fetch from source - prefer raw URLs for UTF-8 support
        try {
            let file;
            if (this.useRawUrls) {
                file = await this.source.fetchRawFile(owner, repo, path, branch);
                if (file) this.stats.rawRequests++;
            } else {
                file = await this.source.fetchFile(owner, repo, path, branch);
                if (file) this.stats.apiRequests++;
            }

            if (file) {
                await this.cache.set(cacheKey, file);
                return file;
            }

            this.stats.failures++;
            return null;

        } catch (error) {
            this.stats.failures++;
            throw error;
        }
    }

    /**
     * Get multiple files (batch operation with parallel fetching)
     * More efficient than calling getFileContent multiple times sequentially.
     *
     * @param {string} owner - Repository owner
     * @param {string} repo - Repository name
     * @param {string[]} paths - Array of file paths
     * @param {string} branch - Branch name (default: 'main')
     * @returns {Promise<Map<string, Object>>} - Map of path -> file content
     */
    async getMultipleFiles(owner, repo, paths, branch = 'main') {
        if (!Array.isArray(paths)) {
            throw new Error('getMultipleFiles expects an array of paths');
        }

        const results = new Map();
        const toFetch = [];

        // First pass: check cache for all files
        for (const path of paths) {
            const cacheKey = RepositoryContentCache.makeKey('file', owner, repo, path, branch);
            const cached = await this.cache.get(cacheKey);

            if (cached) {
                results.set(path, cached);
                this.stats.cacheHits++;
                this.stats.totalRequests++;
            } else {
                toFetch.push(path);
            }
        }

        // Second pass: fetch missing files in parallel
        if (toFetch.length > 0) {
            const fetchPromises = toFetch.map(path =>
                this.getFileContent(owner, repo, path, branch)
                    .then(content => ({ path, content }))
                    .catch(error => ({ path, content: null, error }))
            );

            const fetchedResults = await Promise.all(fetchPromises);

            for (const { path, content } of fetchedResults) {
                if (content) {
                    results.set(path, content);
                }
            }
        }

        return results;
    }

    /**
     * Get text/code files from tree (blacklist known binary formats)
     * Includes files with no extension - we want anything "texty".
     *
     * @param {Object} tree - Repository tree
     * @param {Object} options - Filter options
     * @returns {Object[]} - Filtered tree items
     */
    filterCodeFiles(tree, options = {}) {
        if (!tree || !tree.tree) {
            return [];
        }

        const {
            maxSize = 10 * 1024 * 1024, // 10MB default max (generous)
            // Blacklist: known binary/non-text extensions
            excludeExtensions = [
                // Images
                'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'icns', 'webp', 'svg', 'tiff', 'tif', 'psd', 'ai',
                // Audio/Video
                'mp3', 'mp4', 'wav', 'ogg', 'flac', 'aac', 'wma', 'avi', 'mov', 'mkv', 'webm', 'flv', 'm4a', 'm4v',
                // Archives
                'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'tgz',
                // Binaries/Executables
                'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'lib', 'app', 'dmg', 'msi', 'deb', 'rpm',
                // Compiled/Bytecode
                'pyc', 'pyo', 'class', 'jar', 'war', 'wasm',
                // Fonts
                'ttf', 'otf', 'woff', 'woff2', 'eot',
                // Documents (binary)
                'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
                // Database
                'db', 'sqlite', 'sqlite3', 'mdb',
                // Other binary
                'DS_Store', 'thumbs.db',
            ],
            // Path patterns to exclude
            excludePatterns = [
                /node_modules\//,
                /\.git\//,
                /dist\//,
                /build\//,
                /\.min\./,
                /package-lock\.json$/,
                /yarn\.lock$/,
                /\.lock$/,
                /vendor\//,
                /__pycache__\//,
                /\.egg-info\//,
            ],
        } = options;

        // Build a Set for fast extension lookup
        const excludeExtSet = new Set(excludeExtensions.map(e => e.toLowerCase()));

        return tree.tree.filter(item => {
            // Only include blobs (files), not trees (directories)
            if (item.type !== 'blob') {
                return false;
            }

            // Check size limit
            if (item.size > maxSize) {
                return false;
            }

            // Check excluded path patterns
            for (const pattern of excludePatterns) {
                if (pattern.test(item.path)) {
                    return false;
                }
            }

            // Get extension (empty string if no extension - that's fine, we include those)
            const filename = item.path.split('/').pop() || '';
            const dotIndex = filename.lastIndexOf('.');
            const ext = dotIndex > 0 ? filename.slice(dotIndex + 1).toLowerCase() : '';

            // Exclude if extension is in blacklist
            if (ext && excludeExtSet.has(ext)) {
                return false;
            }

            return true;
        });
    }

    /**
     * Clear cache for a specific repository
     * @param {string} owner - Repository owner
     * @param {string} repo - Repository name
     * @returns {number} - Number of entries cleared
     */
    clearRepositoryCache(owner, repo) {
        return this.cache.invalidateRepository(owner, repo);
    }

    /**
     * Clear entire cache
     */
    clearCache() {
        this.cache.clear();
    }

    /**
     * Get adapter statistics
     * @returns {Object}
     */
    getStats() {
        const rateLimit = this.source.getRateLimitStatus();

        return {
            totalRequests: this.stats.totalRequests,
            cacheHits: this.stats.cacheHits,
            apiRequests: this.stats.apiRequests,
            rawRequests: this.stats.rawRequests,
            failures: this.stats.failures,
            cacheHitRate: this.stats.totalRequests > 0
                ? ((this.stats.cacheHits / this.stats.totalRequests) * 100).toFixed(2) + '%'
                : '0%',
            cache: this.cache.getStats(),
            rateLimitRemaining: rateLimit.remaining,
            rateLimitReset: rateLimit.resetDate,
            useRawUrls: this.useRawUrls,
        };
    }

    /**
     * Get source information
     * @returns {Object}
     */
    getSourceInfo() {
        return this.source.getInfo();
    }

    /**
     * Check if the source is available
     * @returns {Promise<boolean>}
     */
    async isAvailable() {
        return this.source.isAvailable();
    }

    /**
     * Get rate limit status from source
     * @returns {Object}
     */
    getRateLimitStatus() {
        return this.source.getRateLimitStatus();
    }
}

export default RepositoryAdapter;

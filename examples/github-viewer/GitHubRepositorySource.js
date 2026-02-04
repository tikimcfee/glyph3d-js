/**
 * GitHubRepositorySource - Fetches repository content from GitHub API
 *
 * Handles tree and file content fetching with rate limit awareness.
 * API: https://docs.github.com/en/rest
 */

/**
 * GitHubError - Base error for GitHub API issues
 */
export class GitHubError extends Error {
    constructor(message, statusCode = null, response = null) {
        super(message);
        this.name = 'GitHubError';
        this.statusCode = statusCode;
        this.response = response;
    }
}

/**
 * RateLimitError - Thrown when GitHub rate limit is exceeded
 */
export class RateLimitError extends GitHubError {
    constructor(resetTime) {
        super('Rate limit exceeded');
        this.name = 'RateLimitError';
        this.resetTime = resetTime;
        this.resetDate = new Date(resetTime * 1000);
    }
}

export class GitHubRepositorySource {
    constructor(options = {}) {
        this.name = 'github';
        this.baseUrl = 'https://api.github.com';
        this.token = options.token || null;
        this.timeout = options.timeout || 10000; // 10 second timeout
        this.defaultBranch = options.branch || 'main';

        // Rate limit tracking
        this.rateLimit = {
            limit: null,
            remaining: null,
            reset: null,
        };
    }

    /**
     * Parse GitHub URL to extract owner and repo
     * @param {string} url - GitHub URL (e.g., https://github.com/owner/repo)
     * @returns {{owner: string, repo: string, branch: string|null}|null}
     */
    static parseGitHubUrl(url) {
        if (!url || typeof url !== 'string') {
            return null;
        }

        // Handle various GitHub URL formats
        const patterns = [
            // https://github.com/owner/repo
            /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?(?:\/tree\/([^\/]+))?(?:\/.*)?$/,
            // git@github.com:owner/repo.git
            /^git@github\.com:([^\/]+)\/([^\/]+?)(?:\.git)?$/,
            // owner/repo format
            /^([^\/]+)\/([^\/]+)$/,
        ];

        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) {
                return {
                    owner: match[1],
                    repo: match[2].replace(/\.git$/, ''),
                    branch: match[3] || null,
                };
            }
        }

        return null;
    }

    /**
     * Get repository tree using repoPath format
     * @param {string} repoPath - 'owner/repo' format
     * @param {Object} options - Options
     * @returns {Promise<Object|null>}
     */
    async getRepositoryTree(repoPath, options = {}) {
        const parsed = GitHubRepositorySource.parseGitHubUrl(repoPath);
        if (!parsed) {
            throw new GitHubError(`Invalid repository path: ${repoPath}`);
        }
        return this.fetchTree(parsed.owner, parsed.repo, options.branch || parsed.branch || this.defaultBranch);
    }

    /**
     * Get file content using repoPath format
     * @param {string} repoPath - 'owner/repo' format
     * @param {string} filePath - Path to file in repo
     * @returns {Promise<string>} - File content as text
     */
    async getFileContent(repoPath, filePath) {
        const parsed = GitHubRepositorySource.parseGitHubUrl(repoPath);
        if (!parsed) {
            throw new GitHubError(`Invalid repository path: ${repoPath}`);
        }
        const file = await this.fetchFile(parsed.owner, parsed.repo, filePath, parsed.branch || this.defaultBranch);
        return file ? file.content : null;
    }

    /**
     * Get repository info/metadata
     * @param {string} repoPath - 'owner/repo' format
     * @returns {Promise<Object>} - Repo metadata
     */
    async getRepositoryInfo(repoPath) {
        const parsed = GitHubRepositorySource.parseGitHubUrl(repoPath);
        if (!parsed) {
            throw new GitHubError(`Invalid repository path: ${repoPath}`);
        }

        try {
            const url = `${this.baseUrl}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeout);

            const response = await fetch(url, {
                signal: controller.signal,
                headers: this._getHeaders(),
            });

            clearTimeout(timeoutId);
            this._updateRateLimit(response);

            if (!response.ok) {
                if (response.status === 404) {
                    return null;
                }
                if (response.status === 403 && this.rateLimit.remaining === 0) {
                    throw new RateLimitError(this.rateLimit.reset);
                }
                throw new GitHubError(`HTTP ${response.status}: ${response.statusText}`, response.status);
            }

            const data = await response.json();
            return {
                owner: data.owner.login,
                repo: data.name,
                fullName: data.full_name,
                description: data.description,
                defaultBranch: data.default_branch,
                language: data.language,
                stars: data.stargazers_count,
                forks: data.forks_count,
                size: data.size,
                private: data.private,
                htmlUrl: data.html_url,
                fetchedAt: Date.now(),
            };

        } catch (error) {
            if (error.name === 'AbortError') {
                throw new GitHubError('Timeout fetching repository info');
            }
            throw error;
        }
    }

    /**
     * Check if the source is available
     * @returns {Promise<boolean>}
     */
    async isAvailable() {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeout);

            const response = await fetch(`${this.baseUrl}/rate_limit`, {
                signal: controller.signal,
                headers: this._getHeaders(),
            });

            clearTimeout(timeoutId);
            this._updateRateLimit(response);
            return response.ok;
        } catch (error) {
            console.warn(`GitHubRepositorySource: Availability check failed: ${error.message}`);
            return false;
        }
    }

    /**
     * Fetch repository tree (recursive)
     * @param {string} owner - Repository owner
     * @param {string} repo - Repository name
     * @param {string} branch - Branch name (default: 'main')
     * @returns {Promise<Object|null>} - Tree data or null
     */
    async fetchTree(owner, repo, branch = 'main') {
        if (!owner || !repo) {
            throw new Error('Owner and repo are required');
        }

        try {
            const url = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeout);

            const response = await fetch(url, {
                signal: controller.signal,
                headers: this._getHeaders(),
            });

            clearTimeout(timeoutId);
            this._updateRateLimit(response);

            if (!response.ok) {
                if (response.status === 404) {
                    console.log(`GitHubRepositorySource: Repository or branch not found: ${owner}/${repo}@${branch}`);
                    return null;
                }
                if (response.status === 403) {
                    const rateLimited = this.rateLimit.remaining === 0;
                    if (rateLimited) {
                        throw new Error(`Rate limit exceeded. Resets at ${new Date(this.rateLimit.reset * 1000).toISOString()}`);
                    }
                }
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            return this._parseTreeResponse(data);

        } catch (error) {
            if (error.name === 'AbortError') {
                console.warn(`GitHubRepositorySource: Timeout fetching tree for ${owner}/${repo}`);
            } else {
                console.warn(`GitHubRepositorySource: Error fetching tree: ${error.message}`);
            }
            throw error;
        }
    }

    /**
     * Fetch file content
     * @param {string} owner - Repository owner
     * @param {string} repo - Repository name
     * @param {string} path - File path within repo
     * @param {string} branch - Branch name (default: 'main')
     * @returns {Promise<Object|null>} - File content or null
     */
    async fetchFile(owner, repo, path, branch = 'main') {
        if (!owner || !repo || !path) {
            throw new Error('Owner, repo, and path are required');
        }

        try {
            const url = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}?ref=${encodeURIComponent(branch)}`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeout);

            const response = await fetch(url, {
                signal: controller.signal,
                headers: this._getHeaders(),
            });

            clearTimeout(timeoutId);
            this._updateRateLimit(response);

            if (!response.ok) {
                if (response.status === 404) {
                    console.log(`GitHubRepositorySource: File not found: ${owner}/${repo}/${path}@${branch}`);
                    return null;
                }
                if (response.status === 403) {
                    const rateLimited = this.rateLimit.remaining === 0;
                    if (rateLimited) {
                        throw new Error(`Rate limit exceeded. Resets at ${new Date(this.rateLimit.reset * 1000).toISOString()}`);
                    }
                }
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            return this._parseFileResponse(data);

        } catch (error) {
            if (error.name === 'AbortError') {
                console.warn(`GitHubRepositorySource: Timeout fetching file ${path}`);
            } else {
                console.warn(`GitHubRepositorySource: Error fetching file: ${error.message}`);
            }
            throw error;
        }
    }

    /**
     * Fetch raw file content directly from raw.githubusercontent.com
     * This is the preferred method - no base64 encoding, handles UTF-8 natively.
     * Does NOT count against API rate limit (separate CDN).
     *
     * @param {string} owner - Repository owner
     * @param {string} repo - Repository name
     * @param {string} path - File path within repo
     * @param {string} branch - Branch name (default: 'main')
     * @returns {Promise<Object|null>} - File content or null
     */
    async fetchRawFile(owner, repo, path, branch = 'main') {
        if (!owner || !repo || !path) {
            throw new GitHubError('Owner, repo, and path are required');
        }

        // Raw URL format: https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}
        const rawUrl = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/${path}`;

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeout);

            const response = await fetch(rawUrl, {
                signal: controller.signal,
                // Note: No auth headers needed for public repos on raw.githubusercontent.com
                // For private repos, we'd need to use a different approach
                headers: this.token ? {
                    'Authorization': `Bearer ${this.token}`,
                } : {},
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                if (response.status === 404) {
                    console.log(`GitHubRepositorySource: Raw file not found: ${owner}/${repo}/${path}@${branch}`);
                    return null;
                }
                throw new GitHubError(`HTTP ${response.status}: ${response.statusText}`, response.status);
            }

            // Get content as text - handles UTF-8 automatically
            const content = await response.text();

            return {
                content: content,
                encoding: 'utf-8',
                size: content.length,
                sha: null, // Not available from raw endpoint
                name: path.split('/').pop(),
                path: path,
                type: 'file',
                rawUrl: rawUrl,
                fetchedAt: Date.now(),
            };

        } catch (error) {
            if (error.name === 'AbortError') {
                throw new GitHubError(`Timeout fetching raw file: ${path}`);
            }
            throw error;
        }
    }

    /**
     * Build raw.githubusercontent.com URL for a file
     * Useful when you want to construct URLs without fetching.
     *
     * @param {string} owner - Repository owner
     * @param {string} repo - Repository name
     * @param {string} path - File path within repo
     * @param {string} branch - Branch name (default: 'main')
     * @returns {string} - Raw file URL
     */
    static buildRawUrl(owner, repo, path, branch = 'main') {
        return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/${path}`;
    }

    /**
     * Fetch branches for a repository
     * @param {string} owner - Repository owner
     * @param {string} repo - Repository name
     * @returns {Promise<Array<{name: string, isDefault: boolean}>>} - Array of branch info
     */
    async fetchBranches(owner, repo) {
        if (!owner || !repo) {
            throw new GitHubError('Owner and repo are required');
        }

        try {
            const url = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeout);

            const response = await fetch(url, {
                signal: controller.signal,
                headers: this._getHeaders(),
            });

            clearTimeout(timeoutId);
            this._updateRateLimit(response);

            if (!response.ok) {
                if (response.status === 404) {
                    return [];
                }
                if (response.status === 403 && this.rateLimit.remaining === 0) {
                    throw new RateLimitError(this.rateLimit.reset);
                }
                throw new GitHubError(`HTTP ${response.status}: ${response.statusText}`, response.status);
            }

            const data = await response.json();
            return data.map(branch => ({
                name: branch.name,
                isDefault: false, // Will be set by caller if repo info is available
            }));

        } catch (error) {
            if (error.name === 'AbortError') {
                throw new GitHubError(`Timeout fetching branches for ${owner}/${repo}`);
            }
            throw error;
        }
    }

    /**
     * Get current rate limit status
     * @returns {Object} - Rate limit info
     */
    getRateLimitStatus() {
        return {
            limit: this.rateLimit.limit,
            remaining: this.rateLimit.remaining,
            reset: this.rateLimit.reset,
            resetDate: this.rateLimit.reset ? new Date(this.rateLimit.reset * 1000) : null,
        };
    }

    /**
     * Fetch pull request metadata
     * @param {string} owner - Repository owner
     * @param {string} repo - Repository name
     * @param {number} prNumber - Pull request number
     * @returns {Promise<Object>} - PR metadata (title, body, base/head refs, etc.)
     */
    async fetchPullRequest(owner, repo, prNumber) {
        if (!owner || !repo || !prNumber) {
            throw new GitHubError('Owner, repo, and PR number are required');
        }

        try {
            const url = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(prNumber)}`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeout);

            const response = await fetch(url, {
                signal: controller.signal,
                headers: this._getHeaders(),
            });

            clearTimeout(timeoutId);
            this._updateRateLimit(response);

            if (!response.ok) {
                if (response.status === 404) {
                    throw new GitHubError(`Pull request #${prNumber} not found`, 404);
                }
                if (response.status === 403 && this.rateLimit.remaining === 0) {
                    throw new RateLimitError(this.rateLimit.reset);
                }
                throw new GitHubError(`HTTP ${response.status}: ${response.statusText}`, response.status);
            }

            const data = await response.json();
            return {
                number: data.number,
                title: data.title,
                body: data.body,
                state: data.state,
                author: data.user?.login,
                baseRef: data.base?.ref,
                baseSha: data.base?.sha,
                headRef: data.head?.ref,
                headSha: data.head?.sha,
                additions: data.additions,
                deletions: data.deletions,
                changedFiles: data.changed_files,
                htmlUrl: data.html_url,
                fetchedAt: Date.now(),
            };
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new GitHubError(`Timeout fetching PR #${prNumber}`);
            }
            throw error;
        }
    }

    /**
     * Fetch pull request changed files with patches
     * @param {string} owner - Repository owner
     * @param {string} repo - Repository name
     * @param {number} prNumber - Pull request number
     * @returns {Promise<Array>} - Array of changed file objects
     */
    async fetchPullRequestFiles(owner, repo, prNumber) {
        if (!owner || !repo || !prNumber) {
            throw new GitHubError('Owner, repo, and PR number are required');
        }

        try {
            const url = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(prNumber)}/files?per_page=100`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeout);

            const response = await fetch(url, {
                signal: controller.signal,
                headers: this._getHeaders(),
            });

            clearTimeout(timeoutId);
            this._updateRateLimit(response);

            if (!response.ok) {
                if (response.status === 404) {
                    throw new GitHubError(`Pull request #${prNumber} not found`, 404);
                }
                if (response.status === 403 && this.rateLimit.remaining === 0) {
                    throw new RateLimitError(this.rateLimit.reset);
                }
                throw new GitHubError(`HTTP ${response.status}: ${response.statusText}`, response.status);
            }

            const data = await response.json();
            return data.map(file => ({
                filename: file.filename,
                status: file.status, // 'added', 'removed', 'modified', 'renamed'
                additions: file.additions,
                deletions: file.deletions,
                changes: file.changes,
                patch: file.patch || '',
                previousFilename: file.previous_filename || null,
            }));
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new GitHubError(`Timeout fetching PR #${prNumber} files`);
            }
            throw error;
        }
    }

    /**
     * Get source information
     * @returns {Object}
     */
    getInfo() {
        return {
            name: this.name,
            displayName: 'GitHub API',
            description: 'GitHub repository content API',
            url: 'https://github.com',
            apiUrl: this.baseUrl,
            timeout: this.timeout,
            authenticated: !!this.token,
            rateLimit: this.getRateLimitStatus(),
            features: [
                'Repository trees',
                'File content',
                'Rate limit tracking',
                'Branch support',
            ],
        };
    }

    /**
     * Build request headers
     * @private
     */
    _getHeaders() {
        const headers = {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'GitHub-3D-Viewer',
        };

        if (this.token) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }

        return headers;
    }

    /**
     * Update rate limit info from response headers
     * @private
     */
    _updateRateLimit(response) {
        const limit = response.headers.get('X-RateLimit-Limit');
        const remaining = response.headers.get('X-RateLimit-Remaining');
        const reset = response.headers.get('X-RateLimit-Reset');

        if (limit) this.rateLimit.limit = parseInt(limit, 10);
        if (remaining) this.rateLimit.remaining = parseInt(remaining, 10);
        if (reset) this.rateLimit.reset = parseInt(reset, 10);
    }

    /**
     * Parse tree response into standardized format
     * @private
     */
    _parseTreeResponse(data) {
        if (!data || !data.tree) {
            return null;
        }

        return {
            sha: data.sha,
            truncated: data.truncated || false,
            tree: data.tree.map(item => ({
                path: item.path,
                type: item.type, // 'blob' or 'tree'
                size: item.size || 0,
                sha: item.sha,
                mode: item.mode,
            })),
            fetchedAt: Date.now(),
        };
    }

    /**
     * Parse file response into standardized format
     * @private
     */
    _parseFileResponse(data) {
        if (!data) {
            return null;
        }

        // Handle directory case (API returns array for directories)
        if (Array.isArray(data)) {
            throw new Error('Path is a directory, not a file');
        }

        // Decode base64 content
        let content = null;
        if (data.encoding === 'base64' && data.content) {
            try {
                content = atob(data.content.replace(/\n/g, ''));
            } catch (e) {
                console.warn('GitHubRepositorySource: Failed to decode base64 content');
                content = null;
            }
        } else if (data.content) {
            content = data.content;
        }

        return {
            content: content,
            encoding: data.encoding,
            size: data.size,
            sha: data.sha,
            name: data.name,
            path: data.path,
            type: data.type,
            downloadUrl: data.download_url,
            htmlUrl: data.html_url,
            fetchedAt: Date.now(),
        };
    }
}

export default GitHubRepositorySource;

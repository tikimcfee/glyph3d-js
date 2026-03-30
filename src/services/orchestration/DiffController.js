/**
 * DiffController - Orchestrates PR diff fetching, parsing, and 3D grid creation
 *
 * Handles the full pipeline:
 * 1. Fetch PR metadata and changed files list from GitHub API
 * 2. Fetch base and head versions of each changed file (parallel)
 * 3. Parse unified diffs into aligned side-by-side line arrays
 * 4. Create paired CodeGrids (left=base, right=head) with per-line coloring
 * 5. Layout grid pairs in 3D space
 */

import { CodeGrid, GridLayoutManager } from '../../index.js';
import { buildAlignedDiff, parsePatchAligned, getDiffColor } from '../state/DiffParser.js';

/**
 * Color constants for diff grid backgrounds
 */
const DIFF_COLORS = {
    baseBg: 0x1a1a2e,    // Dark blue-purple (same as CodeGrid default)
    headBg: 0x1a2e1a,    // Slightly green-tinted dark
    addedBg: 0x1a2e1a,   // Green tint for new files
    removedBg: 0x2e1a1a, // Red tint for deleted files
    filenameBase: { r: 0.9, g: 0.6, b: 0.6 },  // Warm red for base label
    filenameHead: { r: 0.6, g: 0.9, b: 0.6 },  // Warm green for head label
};

export class DiffController {
    /**
     * @param {Object} options
     * @param {THREE.Scene} options.scene - Three.js scene
     * @param {GlyphAtlas} options.atlas - Glyph atlas
     * @param {GitHubRepositorySource} options.githubSource - GitHub API client
     * @param {RepositoryAdapter} options.repoAdapter - Repo adapter for file fetching
     */
    constructor({ scene, atlas, githubSource, repoAdapter }) {
        this.scene = scene;
        this.atlas = atlas;
        this.githubSource = githubSource;
        this.repoAdapter = repoAdapter;

        this.layoutManager = new GridLayoutManager({
            horizontalSpacing: 5,
            verticalSpacing: 15,
            planeSpacing: 300,
        });

        // State
        this.grids = [];
        this.prData = null;
        this.fileData = [];
    }

    /**
     * Parse a PR URL or shorthand into owner, repo, and PR number
     * @param {string} input - PR URL or "owner/repo#123" format
     * @returns {{ owner: string, repo: string, prNumber: number }|null}
     */
    static parsePRInput(input) {
        if (!input || typeof input !== 'string') return null;

        const trimmed = input.trim();

        // Full URL: https://github.com/owner/repo/pull/123
        const urlMatch = trimmed.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
        if (urlMatch) {
            return {
                owner: urlMatch[1],
                repo: urlMatch[2].replace(/\.git$/, ''),
                prNumber: parseInt(urlMatch[3], 10)
            };
        }

        // Shorthand: owner/repo#123
        const shortMatch = trimmed.match(/^([^\/]+)\/([^#]+)#(\d+)$/);
        if (shortMatch) {
            return {
                owner: shortMatch[1],
                repo: shortMatch[2],
                prNumber: parseInt(shortMatch[3], 10)
            };
        }

        return null;
    }

    /**
     * Load a pull request diff and create 3D grid pairs
     * @param {string} owner - Repository owner
     * @param {string} repo - Repository name
     * @param {number} prNumber - PR number
     * @param {Function} onProgress - Progress callback (ratio, message)
     * @returns {Promise<{grids: Array, prData: Object, fileData: Array}>}
     */
    async loadPR(owner, repo, prNumber, onProgress = () => {}) {
        // Phase 1: Fetch PR metadata
        onProgress(0.05, `Fetching PR #${prNumber} metadata...`);
        this.prData = await this.githubSource.fetchPullRequest(owner, repo, prNumber);
        console.log(`[Diff] PR #${prNumber}: "${this.prData.title}" (${this.prData.changedFiles} files)`);

        // Phase 2: Fetch changed files list with patches
        onProgress(0.1, `Fetching changed files...`);
        this.fileData = await this.githubSource.fetchPullRequestFiles(owner, repo, prNumber);
        console.log(`[Diff] ${this.fileData.length} changed files fetched`);

        // Phase 3: Fetch full file contents for base and head versions (parallel)
        onProgress(0.15, `Fetching file contents (${this.fileData.length} files)...`);
        const contentMap = await this._fetchFileContents(owner, repo, this.prData.baseRef, this.prData.headRef);
        onProgress(0.5, `Creating diff grids...`);

        // Phase 4: Create grid pairs for each changed file (parallel via workers)
        const gridPromises = this.fileData.map((file, idx) => {
            const baseContent = contentMap.base.get(file.filename) || '';
            const headContent = contentMap.head.get(file.filename) || '';
            return this._createDiffGridPair(file, baseContent, headContent, idx);
        });

        const gridPairs = await Promise.all(gridPromises);
        onProgress(0.8, `Laying out ${gridPairs.length} diff pairs...`);

        // Phase 5: Layout grid pairs
        this.grids = [];
        this.layoutManager.clear();

        for (const pair of gridPairs) {
            if (!pair) continue;

            // Position right grid next to left grid.
            // updateMatrixWorld after each placement so the next
            // getBounds() call returns correct world-space bounds
            // (no render loop has run yet to update matrices).
            this.layoutManager.addAuto(pair.left);
            pair.left.updateMatrixWorld(true);
            this.layoutManager.addTrailing(pair.right);
            pair.right.updateMatrixWorld(true);

            this.scene.add(pair.left);
            this.scene.add(pair.right);
            this.grids.push(pair.left, pair.right);
        }

        onProgress(1.0, 'Done');
        console.log(`[Diff] Created ${this.grids.length} grids (${gridPairs.length} pairs)`);

        return {
            grids: this.grids,
            prData: this.prData,
            fileData: this.fileData
        };
    }

    /**
     * Fetch base and head versions of all changed files in parallel
     * @private
     */
    async _fetchFileContents(owner, repo, baseRef, headRef) {
        const filenames = this.fileData
            .filter(f => f.status !== 'removed')
            .map(f => f.filename);

        const removedFilenames = this.fileData
            .filter(f => f.status === 'removed')
            .map(f => f.filename);

        const renamedFiles = this.fileData
            .filter(f => f.status === 'renamed' && f.previousFilename);

        // Files to fetch from base: modified + removed + renamed (previous name)
        const baseFilenames = [
            ...this.fileData.filter(f => f.status === 'modified').map(f => f.filename),
            ...removedFilenames,
            ...renamedFiles.map(f => f.previousFilename),
        ];

        // Files to fetch from head: modified + added + renamed (new name)
        const headFilenames = filenames;

        // Parallel fetch both branches
        const [baseMap, headMap] = await Promise.all([
            this._fetchBranchFiles(owner, repo, baseFilenames, baseRef),
            this._fetchBranchFiles(owner, repo, headFilenames, headRef),
        ]);

        // For renamed files, map old name content to new name in base map
        for (const file of renamedFiles) {
            if (file.previousFilename && baseMap.has(file.previousFilename)) {
                baseMap.set(file.filename, baseMap.get(file.previousFilename));
            }
        }

        return { base: baseMap, head: headMap };
    }

    /**
     * Fetch multiple files from a branch, returning a Map<filename, content>
     * @private
     */
    async _fetchBranchFiles(owner, repo, filenames, branch) {
        const results = new Map();
        if (filenames.length === 0) return results;

        const fetchPromises = filenames.map(filename =>
            this.githubSource.fetchRawFile(owner, repo, filename, branch)
                .then(file => ({ filename, content: file?.content || '' }))
                .catch(() => ({ filename, content: '' }))
        );

        const fetched = await Promise.all(fetchPromises);
        for (const { filename, content } of fetched) {
            results.set(filename, content);
        }

        return results;
    }

    /**
     * Create a side-by-side grid pair for a single changed file
     * @private
     */
    async _createDiffGridPair(file, baseContent, headContent, index) {
        const { filename, status, patch } = file;

        // Build aligned left/right line arrays
        let aligned;
        if (status === 'added') {
            // New file: everything is an addition
            aligned = buildAlignedDiff('', headContent, patch);
        } else if (status === 'removed') {
            // Deleted file: everything is a removal
            aligned = buildAlignedDiff(baseContent, '', patch);
        } else if (patch) {
            // Modified or renamed: use full diff alignment
            aligned = buildAlignedDiff(baseContent, headContent, patch);
        } else {
            // No patch — use patch-only parser as fallback
            aligned = parsePatchAligned(patch);
        }

        if (aligned.left.length === 0 && aligned.right.length === 0) {
            return null;
        }

        // Create left (base) grid
        const baseLabel = status === 'renamed' && file.previousFilename
            ? `${file.previousFilename} (base)`
            : `${filename} (base)`;
        const leftGrid = await this._createDiffGrid(baseLabel, aligned.left, {
            backgroundColor: status === 'removed' ? DIFF_COLORS.removedBg : DIFF_COLORS.baseBg,
            filenameColor: DIFF_COLORS.filenameBase,
        });
        leftGrid.userData.sourcePath = filename;
        leftGrid.userData.diffSide = 'base';
        leftGrid.userData.diffIndex = index;

        // Create right (head) grid
        const headLabel = `${filename} (head)`;
        const rightGrid = await this._createDiffGrid(headLabel, aligned.right, {
            backgroundColor: status === 'added' ? DIFF_COLORS.addedBg : DIFF_COLORS.headBg,
            filenameColor: DIFF_COLORS.filenameHead,
        });
        rightGrid.userData.sourcePath = filename;
        rightGrid.userData.diffSide = 'head';
        rightGrid.userData.diffIndex = index;

        return { left: leftGrid, right: rightGrid, filename };
    }

    /**
     * Create a single diff grid with per-line coloring
     * @private
     */
    async _createDiffGrid(label, lines, options = {}) {
        const grid = new CodeGrid(this.scene, this.atlas, {
            showFilename: true,
            showBackground: true,
            backgroundColor: options.backgroundColor || DIFF_COLORS.baseBg,
            filenameColor: options.filenameColor || { r: 0.6, g: 0.8, b: 1.0 },
            // Use a neutral default — we override per-line below
            textColor: { r: 0.65, g: 0.65, b: 0.65 },
        });

        // Bypass CodeGrid's normal loadFile flow — we need per-line color control.
        // Access the underlying GlyphCollection directly.
        const collection = grid.getCollection();
        const metrics = collection._getMetrics();
        let currentY = 0;

        // Add filename label
        collection.addText(label, { x: 0, y: currentY, z: 0 }, {
            color: options.filenameColor || { r: 0.6, g: 0.8, b: 1.0 }
        });
        currentY -= metrics.lineSpacing * 1.5;

        // Add each line with its diff color
        for (const line of lines) {
            const color = getDiffColor(line.type);
            const displayText = line.text || ' '; // space for spacer lines to maintain vertical rhythm

            collection.addText(displayText, { x: 0, y: currentY, z: 0 }, { color });
            currentY -= metrics.lineSpacing;
        }

        // Flush to GPU via worker pipeline
        await collection.flushAsync();

        // Update the background to fit content
        grid._updateBackground();

        return grid;
    }

    /**
     * Clear all diff grids from the scene
     */
    clearGrids() {
        for (const grid of this.grids) {
            grid.dispose();
            this.scene.remove(grid);
        }
        this.grids = [];
        this.layoutManager.clear();
        this.prData = null;
        this.fileData = [];
    }

    /**
     * Get layout bounds for camera fitting
     * @returns {Object|null}
     */
    getTotalBounds() {
        return this.layoutManager.getTotalBounds();
    }
}

export default DiffController;

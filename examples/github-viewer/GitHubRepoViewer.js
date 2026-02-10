/**
 * GitHubRepoViewer - Main Application
 *
 * Orchestrates the 3D GitHub repository viewer:
 * - Three.js scene setup and render loop
 * - Repository loading and grid creation
 * - Camera controls (keyboard + mouse)
 * - UI component wiring
 */

import {
    GlyphAtlas,
    CodeGrid,
    GridLayoutManager,
    HierarchicalLayoutManager
} from '../../src/index.js';

import { RepositoryAdapter } from './RepositoryAdapter.js';
import { GitHubRepositorySource } from './GitHubRepositorySource.js';
import { DiffController } from './DiffController.js';
import { BackdropManager } from './BackdropManager.js';
import { NameplateManager } from './NameplateManager.js';

import { createHeader, createLoadingOverlay, createFPSBadge, createToast } from './components/AppShell.js';
import {
    DrawerController,
    repoPanelHTML,
    filesPanelHTML,
    settingsPanelHTML,
    statsPanelHTML,
    controlsPanelHTML
} from './components/Drawer.js';
import { TouchController } from './components/TouchController.js';
import { logCapturePanelHTML, initLogCapturePanel } from './components/LogCapturePanel.js';
import { diffPanelHTML, initDiffPanel } from './components/DiffPanel.js';

/**
 * Parse GitHub URL to owner/repo
 * @param {string} url
 * @returns {{ owner: string, repo: string } | null}
 */
function parseGitHubUrl(url) {
    const patterns = [
        /github\.com\/([^\/]+)\/([^\/]+)/,
        /^([^\/]+)\/([^\/]+)$/
    ];
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) {
            return {
                owner: match[1],
                repo: match[2].replace(/\.git$/, '').split('/')[0]
            };
        }
    }
    return null;
}

export class GitHubRepoViewer {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {Object} THREE - Three.js module
     */
    constructor(canvas, THREE) {
        this.THREE = THREE;
        this.canvas = canvas;

        // UI components (created in init)
        this.header = null;
        this.loading = null;
        this.fpsBadge = null;
        this.toastUI = null;
        this.drawer = null;

        // Three.js
        this.scene = null;
        this.camera = null;
        this.renderer = null;

        // Components
        this.atlas = null;
        this.layoutManager = null;
        this.hierarchicalManager = null;
        this.repoAdapter = null;
        this.githubSource = new GitHubRepositorySource();
        this.diffController = null;
        this.diffPanel = null;

        // Visual overlay managers
        this.backdropManager = null;
        this.nameplateManager = null;

        // State
        this.grids = [];
        this.repoPath = null;
        this.tree = [];
        this.isLoading = false;
        this.branches = [];
        this.defaultBranch = null;

        // Camera controls
        this.keys = {};
        this.isPointerLocked = false;
        this.cameraSpeed = 100;
        this.lookSensitivity = 0.002;
        this.pitch = 0;
        this.yaw = 0;

        // Animation
        this.lastTime = performance.now();
        this.frameCount = 0;
        this.fpsTime = 0;
    }

    async init() {
        const THREE = this.THREE;
        const body = document.body;

        console.log('Initializing GitHub 3D Repo Viewer...');

        // Create UI components
        this.header = createHeader(body);
        this.loading = createLoadingOverlay(body);
        this.fpsBadge = createFPSBadge(body);

        this.loading.show('Generating glyph atlas...');

        // Create drawer with panels
        this.drawer = new DrawerController(body, [
            { id: 'repo',     label: 'Repo',     html: repoPanelHTML() },
            { id: 'files',    label: 'Files',    html: filesPanelHTML() },
            { id: 'settings', label: 'Settings', html: settingsPanelHTML() },
            { id: 'stats',    label: 'Stats',    html: statsPanelHTML() },
            { id: 'controls', label: 'Controls', html: controlsPanelHTML() },
        ]);

        // Add log capture panel
        const logPanel = this.drawer.addPanel({
            id: 'logs',
            label: 'Logs',
            html: logCapturePanelHTML()
        });
        initLogCapturePanel(logPanel);

        // Add diff panel
        const diffPanelEl = this.drawer.addPanel({
            id: 'diff',
            label: 'Diff',
            html: diffPanelHTML()
        });
        this.diffPanel = initDiffPanel(diffPanelEl, {
            onLoadPR: (input) => this.loadDiff(input),
            onFileClick: (idx) => this.focusOnDiffFile(idx),
        });

        // Toast (must come after drawer for z-order)
        this.toastUI = createToast(body);

        // Cache frequently-used DOM elements
        this.repoInput = document.getElementById('repo-input');
        this.branchInput = document.getElementById('branch-input');
        this.fetchBranchesBtn = document.getElementById('fetch-branches-btn');
        this.branchListEl = document.getElementById('branch-list');
        this.branchStatusEl = document.getElementById('branch-status');
        this.loadBtn = document.getElementById('load-btn');
        this.treeContent = document.getElementById('tree-content');
        this.statFpsEl = document.getElementById('stat-fps');
        this.fileCountEl = document.getElementById('file-count');
        this.gridCountEl = document.getElementById('grid-count');
        this.glyphCountEl = document.getElementById('glyph-count');
        this.cameraPosEl = document.getElementById('camera-pos');

        // Generate atlas
        this.atlas = new GlyphAtlas();
        await this.atlas.generate((current, total) => {
            this.loading.update(current / total, `Generating glyphs: ${current}/${total}`);
        });

        // Three.js setup
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0a0a0a);

        this.camera = new THREE.PerspectiveCamera(
            70, window.innerWidth / window.innerHeight, 0.1, 10000
        );
        this.camera.position.set(0, 0, 500);

        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

        this.layoutManager = new GridLayoutManager();
        this.repoAdapter = new RepositoryAdapter();
        this.diffController = new DiffController({
            scene: this.scene,
            atlas: this.atlas,
            githubSource: this.githubSource,
            repoAdapter: this.repoAdapter,
        });

        // Touch controls
        this.touchController = new TouchController(this.canvas, this, THREE);

        this.addGridHelper();
        this.setupEventListeners();

        this.loading.hide();
        this.animate();

        console.log('GitHub 3D Repo Viewer ready!');
        this.toastUI.show('Ready! Open the Repo tab to load a repository', 'success');
        this.drawer.openToTab('repo');
    }

    setupEventListeners() {
        this.loadBtn.addEventListener('click', () => this.loadRepository());
        this.repoInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.loadRepository();
        });
        this.branchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.loadRepository();
        });

        this.fetchBranchesBtn.addEventListener('click', () => this.fetchBranches());

        this.repoInput.addEventListener('input', () => {
            this.branches = [];
            this.defaultBranch = null;
            this.branchListEl.classList.add('hidden');
            this.branchListEl.innerHTML = '';
            this.branchStatusEl.textContent = '';
        });

        // Keyboard
        document.addEventListener('keydown', (e) => { this.keys[e.code] = true; });
        document.addEventListener('keyup', (e) => { this.keys[e.code] = false; });

        // Pointer lock for mouse look
        this.canvas.addEventListener('click', () => { this.canvas.requestPointerLock(); });
        document.addEventListener('pointerlockchange', () => {
            this.isPointerLocked = document.pointerLockElement === this.canvas;
        });
        document.addEventListener('mousemove', (e) => {
            if (this.isPointerLocked) {
                this.yaw -= e.movementX * this.lookSensitivity;
                this.pitch -= e.movementY * this.lookSensitivity;
                this.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.pitch));
            }
        });

        // Window resize
        window.addEventListener('resize', () => this.onResize());

        // Settings sliders
        const gridsScaleSlider = document.getElementById('grids-scale');
        const gridsScaleValue = document.getElementById('grids-scale-value');
        gridsScaleSlider.addEventListener('input', (e) => {
            const scale = parseFloat(e.target.value);
            gridsScaleValue.textContent = scale.toFixed(1);
            for (const grid of this.grids) { grid.scale.setScalar(scale); }
        });

        const layoutSpacingSlider = document.getElementById('layout-spacing');
        const layoutSpacingValue = document.getElementById('layout-spacing-value');
        layoutSpacingSlider.addEventListener('input', (e) => {
            const spacing = parseFloat(e.target.value);
            layoutSpacingValue.textContent = spacing.toFixed(0);
            if (this.layoutManager) {
                this.layoutManager.spacing.horizontal = spacing;
                this.layoutManager.spacing.vertical = spacing * 0.8;
                this.relayoutGrids();
            }
        });

        const camSpeedSlider = document.getElementById('cam-speed');
        const camSpeedValue = document.getElementById('cam-speed-value');
        camSpeedSlider.addEventListener('input', (e) => {
            const speed = parseFloat(e.target.value);
            camSpeedValue.textContent = speed.toFixed(1);
            this.cameraSpeed = speed * 20;
        });

        document.getElementById('reset-camera').addEventListener('click', () => {
            this.camera.position.set(0, 0, 500);
            this.pitch = 0;
            this.yaw = 0;
        });

        document.getElementById('fit-all').addEventListener('click', () => {
            this.focusOnGrids();
        });
    }

    addGridHelper() {
        const THREE = this.THREE;
        const grid = new THREE.GridHelper(2000, 40, 0x222222, 0x111111);
        grid.rotation.x = Math.PI / 2;
        grid.position.z = -10;
        this.scene.add(grid);
    }

    relayoutGrids() {
        if (this.grids.length === 0) return;
        if (this.hierarchicalManager) {
            this.hierarchicalManager.options.siblingSpacing = 8;
            this.hierarchicalManager.options.dirPadding = 15;
            this.hierarchicalManager.clear();
            this.hierarchicalManager.layoutHierarchy(this.grids);
            this._updateOverlays();
        } else {
            this.layoutManager.clear();
            for (const grid of this.grids) { this.layoutManager.addAuto(grid); }
        }
    }

    async fetchBranches() {
        const url = this.repoInput.value.trim();
        if (!url) { this.toastUI.show('Please enter a GitHub URL first', 'error'); return; }

        const parsed = parseGitHubUrl(url);
        if (!parsed) { this.toastUI.show('Invalid GitHub URL', 'error'); return; }

        const { owner, repo } = parsed;
        this.fetchBranchesBtn.disabled = true;
        this.branchStatusEl.textContent = 'Fetching branches...';

        try {
            const repoInfo = await this.githubSource.getRepositoryInfo(`${owner}/${repo}`);
            this.defaultBranch = repoInfo?.defaultBranch || 'main';

            const branches = await this.githubSource.fetchBranches(owner, repo);
            this.branches = branches;

            for (const branch of this.branches) {
                branch.isDefault = branch.name === this.defaultBranch;
            }

            this.branches.sort((a, b) => {
                if (a.isDefault) return -1;
                if (b.isDefault) return 1;
                return a.name.localeCompare(b.name);
            });

            this.renderBranchList();
            this.branchStatusEl.textContent = `${this.branches.length} branches found`;

            if (!this.branchInput.value.trim()) {
                this.branchInput.value = this.defaultBranch;
            }
        } catch (err) {
            console.error('Failed to fetch branches:', err);
            this.branchStatusEl.textContent = `Error: ${err.message}`;
            this.branchListEl.classList.add('hidden');
        } finally {
            this.fetchBranchesBtn.disabled = false;
        }
    }

    renderBranchList() {
        this.branchListEl.innerHTML = '';
        const selectedBranch = this.branchInput.value.trim();

        for (const branch of this.branches) {
            const item = document.createElement('div');
            item.className = 'branch-item';
            if (branch.name === selectedBranch) item.classList.add('selected');

            let html = `<span>${branch.name}</span>`;
            if (branch.isDefault) {
                html += `<span class="branch-default-badge">default</span>`;
            }
            item.innerHTML = html;

            item.addEventListener('click', () => {
                this.branchInput.value = branch.name;
                this.branchListEl.querySelectorAll('.branch-item').forEach(el => el.classList.remove('selected'));
                item.classList.add('selected');
            });

            this.branchListEl.appendChild(item);
        }

        this.branchListEl.classList.remove('hidden');
    }

    async loadRepository() {
        const url = this.repoInput.value.trim();
        if (!url) { this.toastUI.show('Please enter a GitHub URL', 'error'); return; }

        const parsed = parseGitHubUrl(url);
        if (!parsed) { this.toastUI.show('Invalid GitHub URL', 'error'); return; }

        const { owner, repo } = parsed;
        const branch = this.branchInput.value.trim() || this.defaultBranch || 'main';
        this.repoPath = `${owner}/${repo}`;
        console.log(`Loading repository: ${this.repoPath}@${branch}`);
        this.isLoading = true;
        this.loadBtn.disabled = true;

        try {
            this.clearGrids();
            this.loading.show(`Fetching repository tree (${branch})...`);

            const treeResult = await this.repoAdapter.getRepositoryTree(owner, repo, branch);
            console.log(`Found ${treeResult.tree.length} files`);

            const sourceFiles = this.repoAdapter.filterCodeFiles(treeResult);
            this.tree = sourceFiles;
            this.loading.update(0.1, `Loading ${sourceFiles.length} files...`);

            const totalStart = performance.now();

            // Phase 1: Parallel fetch all files
            const fetchStart = performance.now();
            this.loading.update(0.1, `Fetching ${sourceFiles.length} files in parallel...`);

            const paths = sourceFiles.map(f => f.path);
            const fileMap = await this.repoAdapter.getMultipleFiles(owner, repo, paths, branch);

            const fetchTime = performance.now() - fetchStart;
            console.log(`[1] Parallel fetch: ${sourceFiles.length} files in ${fetchTime.toFixed(0)}ms`);

            // Phase 2: Create grids using Web Workers
            const gridStart = performance.now();
            this.loading.update(0.5, `Creating ${fileMap.size} grids with workers...`);

            const gridPromises = [];
            for (const file of sourceFiles) {
                const fileData = fileMap.get(file.path);
                if (fileData && fileData.content) {
                    gridPromises.push(this.createGridForFileAsync(file.path, fileData.content));
                }
            }

            const createdGrids = await Promise.all(gridPromises);
            const gridTime = performance.now() - gridStart;
            console.log(`[2] Grid creation (Workers): ${createdGrids.length} grids in ${gridTime.toFixed(0)}ms`);

            // Phase 2b: Hierarchical layout
            const layoutStart = performance.now();
            this.loading.update(0.7, `Computing hierarchical layout...`);

            const HLM = HierarchicalLayoutManager;
            this.hierarchicalManager = new HLM({
                dirPadding: 15,
                dirPaddingDecay: 0.7,       // padding shrinks at deeper nesting
                siblingSpacing: 8,
                maxRowWidth: 8000,           // generous cap for adaptive layout
                targetAspectRatio: 3.0,      // aim for 3:1 wide directories
                directoriesInZ: false,       // dirs flow horizontally with files
                siblingDirection: 'horizontal'
            });

            this.hierarchicalManager.layoutHierarchy(createdGrids);

            for (const grid of createdGrids) {
                this.scene.add(grid);
                this.grids.push(grid);
            }

            console.log('Directory structure:');
            this.hierarchicalManager.printTree();

            const layoutTime = performance.now() - layoutStart;
            console.log(`[2b] Hierarchical layout: ${createdGrids.length} grids in ${layoutTime.toFixed(0)}ms`);

            // Phase 2c: Create visual overlays (backdrops + nameplates)
            const overlayStart = performance.now();
            this.loading.update(0.8, `Creating visual overlays...`);
            this._createOverlays();
            const overlayTime = performance.now() - overlayStart;
            console.log(`[2c] Visual overlays: ${overlayTime.toFixed(0)}ms`);

            // Phase 3: UI updates - hierarchical file tree
            const uiStart = performance.now();
            this.updateFileTree();
            const uiTime = performance.now() - uiStart;
            console.log(`[3] File tree UI: ${uiTime.toFixed(0)}ms`);

            // Phase 5: Force GPU sync
            const gpuStart = performance.now();
            this.renderer.render(this.scene, this.camera);
            const gpuTime = performance.now() - gpuStart;
            console.log(`[5] First render (GPU): ${gpuTime.toFixed(0)}ms`);

            const totalTime = performance.now() - totalStart;
            console.log(`[TOTAL] All phases: ${totalTime.toFixed(0)}ms`);

            requestAnimationFrame(() => {
                const afterFrame = performance.now() - totalStart;
                console.log(`[AFTER FRAME] Real wall time: ${afterFrame.toFixed(0)}ms`);
            });

            this.loading.hide();

            const stats = this.repoAdapter.getStats();
            console.log('Adapter stats:', stats);
            this.toastUI.show(`Loaded ${this.grids.length} files from ${this.repoPath}@${branch}`, 'success');
            this.header.repoLabel.textContent = `${this.repoPath}@${branch}`;
            this.drawer.openToTab('files');

        } catch (err) {
            console.error('Failed to load repository:', err);
            this.loading.hide();
            this.toastUI.show(`Error: ${err.message}`, 'error');
        } finally {
            this.isLoading = false;
            this.loadBtn.disabled = false;
        }
    }

    async createGridForFileAsync(path, content) {
        const filename = path.split('/').pop();
        const grid = new CodeGrid(this.scene, this.atlas);
        await grid.loadFileAsync(filename, content);
        grid.userData.sourcePath = path;
        return grid;
    }

    clearGrids() {
        for (const grid of this.grids) {
            grid.dispose();
            this.scene.remove(grid);
        }
        this.grids = [];
        this.layoutManager.clear();
        if (this.hierarchicalManager) this.hierarchicalManager.clearAll();
        if (this.diffController) this.diffController.clearGrids();

        // Clean up overlay managers
        if (this.backdropManager) {
            this.backdropManager.destroy();
            this.backdropManager = null;
        }
        if (this.nameplateManager) {
            this.nameplateManager.destroy();
            this.nameplateManager = null;
        }
    }

    async loadDiff(input) {
        const parsed = DiffController.parsePRInput(input);
        if (!parsed) {
            this.toastUI.show('Invalid PR input. Use owner/repo#123 or a full PR URL.', 'error');
            return;
        }

        const { owner, repo, prNumber } = parsed;
        this.diffPanel.setLoading(true);
        this.diffPanel.setStatus(`Loading PR #${prNumber}...`, 'info');

        try {
            // Clear existing content
            this.clearGrids();

            const result = await this.diffController.loadPR(
                owner, repo, prNumber,
                (ratio, message) => {
                    this.loading.show(message);
                    this.loading.update(ratio, message);
                }
            );

            // Update the grids array so stats/navigation work
            this.grids = result.grids;

            // Update diff panel UI
            this.diffPanel.showSummary(result.prData);
            this.diffPanel.showFileList(result.fileData);
            this.diffPanel.setStatus(`Loaded ${result.fileData.length} changed files`, 'success');

            // Update header
            this.header.repoLabel.textContent = `${owner}/${repo} PR #${prNumber}`;

            // Force first render
            this.renderer.render(this.scene, this.camera);
            this.loading.hide();

            // Focus camera on diff grids
            this.focusOnDiffGrids();

            this.toastUI.show(
                `PR #${prNumber}: ${result.fileData.length} files, +${result.prData.additions}/-${result.prData.deletions}`,
                'success'
            );
        } catch (err) {
            console.error('Failed to load diff:', err);
            this.loading.hide();
            this.diffPanel.setStatus(`Error: ${err.message}`, 'error');
            this.toastUI.show(`Error: ${err.message}`, 'error');
        } finally {
            this.diffPanel.setLoading(false);
        }
    }

    focusOnDiffFile(fileIndex) {
        // Each file has 2 grids (left + right), so multiply by 2
        const gridIndex = fileIndex * 2;
        if (gridIndex >= 0 && gridIndex < this.grids.length) {
            this.focusOnGrid(gridIndex);
        }
    }

    focusOnDiffGrids() {
        const THREE = this.THREE;
        if (this.grids.length === 0) return;

        const bounds = this.diffController.getTotalBounds();
        if (!bounds) return;

        const center = new THREE.Vector3();
        bounds.getCenter(center);
        const size = new THREE.Vector3();
        bounds.getSize(size);

        const maxDim = Math.max(size.x, size.y);
        const distance = Math.min(maxDim * 0.5, 800);
        this.camera.position.set(center.x, center.y, center.z + distance + 100);
        this.pitch = 0;
        this.yaw = 0;
    }

    /**
     * Build hierarchical file tree in the drawer panel.
     * Walks the layout manager's tree to create an indented,
     * collapsible directory structure.
     */
    updateFileTree() {
        this.treeContent.innerHTML = '';

        if (!this.hierarchicalManager || !this.hierarchicalManager.root) {
            this.treeContent.innerHTML = '<div class="tree-empty">No files loaded</div>';
            return;
        }

        // Build tree DOM recursively from the hierarchy root
        this._buildTreeDOM(this.hierarchicalManager.root, this.treeContent, 0);
    }

    /**
     * Recursively build DOM for a tree node and its children
     * @private
     */
    _buildTreeDOM(node, container, depth) {
        // Skip the virtual root node (empty path) — render its children directly
        if (node.path === '' && node.isDirectory) {
            for (const child of node.children) {
                this._buildTreeDOM(child, container, depth);
            }
            return;
        }

        if (node.isDirectory) {
            // Directory item
            const isCollapsed = this.hierarchicalManager.isCollapsed(node.path);
            const dirItem = document.createElement('div');
            dirItem.className = 'tree-item tree-dir';
            if (isCollapsed) dirItem.classList.add('collapsed');
            dirItem.style.paddingLeft = `${depth * 16 + 8}px`;
            dirItem.dataset.path = node.path;

            const chevron = isCollapsed ? '\u25B6' : '\u25BC';  // ▶ or ▼
            const childCount = this._countDescendants(node);

            dirItem.innerHTML = `
                <span class="tree-chevron">${chevron}</span>
                <span class="tree-icon tree-icon-dir">\uD83D\uDCC1</span>
                <span class="tree-name">${node.name}</span>
                <span class="tree-count">${childCount}</span>
            `;

            // Click chevron to toggle collapse
            const chevronEl = dirItem.querySelector('.tree-chevron');
            chevronEl.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleDirectoryCollapse(node.path);
            });

            // Click directory name to focus camera
            dirItem.addEventListener('click', () => {
                this.focusOnDirectory(node.path);
            });

            container.appendChild(dirItem);

            // Children container (hidden if collapsed)
            const childrenContainer = document.createElement('div');
            childrenContainer.className = 'tree-children';
            if (isCollapsed) childrenContainer.classList.add('hidden');
            childrenContainer.dataset.parentPath = node.path;

            for (const child of node.children) {
                this._buildTreeDOM(child, childrenContainer, depth + 1);
            }

            container.appendChild(childrenContainer);
        } else {
            // File item
            const fileItem = document.createElement('div');
            fileItem.className = 'tree-item tree-file';
            fileItem.style.paddingLeft = `${depth * 16 + 8}px`;
            fileItem.dataset.path = node.path;

            const gridIndex = node.grid ? this.grids.indexOf(node.grid) : -1;

            fileItem.innerHTML = `
                <span class="tree-icon tree-icon-file">\uD83D\uDCC4</span>
                <span class="tree-name">${node.name}</span>
            `;

            if (gridIndex >= 0) {
                fileItem.addEventListener('click', () => this.focusOnGrid(gridIndex));
            }

            container.appendChild(fileItem);
        }
    }

    /**
     * Count total file descendants of a directory node
     * @private
     */
    _countDescendants(node) {
        let count = 0;
        for (const child of node.children) {
            if (child.isDirectory) {
                count += this._countDescendants(child);
            } else {
                count++;
            }
        }
        return count;
    }

    /**
     * Toggle collapse state for a directory — updates 3D scene + UI
     */
    toggleDirectoryCollapse(dirPath) {
        if (!this.hierarchicalManager) return;

        const nowCollapsed = this.hierarchicalManager.toggleCollapse(dirPath);

        // Re-layout the 3D scene (recompute bounds, reposition, set visibility)
        this.hierarchicalManager.relayout();

        // Update visual overlays
        this._updateOverlays();

        // Rebuild the file tree UI to reflect new state
        this.updateFileTree();
    }

    /**
     * Focus camera on a directory's bounds in 3D space
     */
    focusOnDirectory(dirPath) {
        const THREE = this.THREE;
        if (!this.hierarchicalManager) return;

        const bounds = this.hierarchicalManager.getDirectoryBounds(dirPath);
        if (!bounds) return;

        const center = new THREE.Vector3();
        bounds.getCenter(center);
        const size = new THREE.Vector3();
        bounds.getSize(size);

        // Straight-on view, zoom to fit the directory's extent
        const distance = this._zDistanceForFit(size.x, size.y, 0.85);
        this.camera.position.set(center.x, center.y, bounds.max.z + distance);
        this.pitch = 0;
        this.yaw = 0;
    }

    /**
     * Create visual overlay managers (backdrops + nameplates)
     * @private
     */
    _createOverlays() {
        if (!this.hierarchicalManager || !this.hierarchicalManager.root) return;

        // Dispose old managers if they exist
        if (this.backdropManager) this.backdropManager.destroy();
        if (this.nameplateManager) this.nameplateManager.destroy();

        // Create backdrop manager
        this.backdropManager = new BackdropManager(this.scene, {
            baseOpacity: 0.12,
            opacityDecay: 0.7,
            showEdges: true,
            edgeOpacity: 0.2,
        });
        this.backdropManager.createBackdrops(
            this.hierarchicalManager.root,
            this.hierarchicalManager.collapsedPaths
        );

        // Create nameplate manager
        this.nameplateManager = new NameplateManager(this.scene, this.atlas, {
            color: { r: 0.0, g: 1.0, b: 0.53 },
            scale: 1.5,
            yOffset: 5,
            zOffset: 5,
            billboard: true,
        });
        this.nameplateManager.createNameplates(
            this.hierarchicalManager.root,
            this.hierarchicalManager.collapsedPaths
        );
    }

    /**
     * Update visual overlays after re-layout
     * @private
     */
    _updateOverlays() {
        if (!this.hierarchicalManager || !this.hierarchicalManager.root) return;

        if (this.backdropManager) {
            this.backdropManager.updateBackdrops(
                this.hierarchicalManager.root,
                this.hierarchicalManager.collapsedPaths
            );
        }

        if (this.nameplateManager) {
            this.nameplateManager.updateNameplates(
                this.hierarchicalManager.root,
                this.hierarchicalManager.collapsedPaths
            );
        }
    }

    formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    /**
     * Calculate the Z distance needed so that a region of `width` x `height`
     * fills approximately `fillFraction` of the viewport.
     * Uses the camera's vertical FOV and aspect ratio.
     * @private
     */
    _zDistanceForFit(width, height, fillFraction = 0.85) {
        const fovRad = this.camera.fov * Math.PI / 180;
        const aspect = this.camera.aspect;

        // Distance needed to fit the height
        const dH = (height / fillFraction) / (2 * Math.tan(fovRad / 2));
        // Distance needed to fit the width
        const dW = (width / fillFraction) / (2 * aspect * Math.tan(fovRad / 2));

        return Math.max(dH, dW);
    }

    /**
     * Focus camera on a file for reading.
     *
     * Sets camera to a consistent reading distance where ~35 lines of text
     * fill the viewport — like opening a file in an editor. The distance
     * is derived from actual line spacing, not the file's total bounds,
     * so text is always the same readable size regardless of file length.
     * Short files show entirely; tall files show the top and you fly through.
     */
    focusOnGrid(index) {
        const THREE = this.THREE;
        if (index < 0 || index >= this.grids.length) return;

        const grid = this.grids[index];
        const bounds = grid.getBounds();
        const size = new THREE.Vector3();
        bounds.getSize(size);

        // Straight-on: reset rotation so camera faces -Z (perpendicular to content)
        this.pitch = 0;
        this.yaw = 0;

        // --- Reading distance from line metrics ---
        // Derive line spacing from the grid's actual content and bounds.
        // This avoids dependence on padding/background/transforms.
        const lineCount = grid.lines ? grid.lines.length : 1;
        const lineSpacing = size.y / Math.max(lineCount, 1);

        // Show this many lines — a comfortable screenful, like an editor.
        const READABLE_LINES = 35;
        const visibleLines = Math.min(lineCount, READABLE_LINES);
        const targetViewHeight = visibleLines * lineSpacing;

        const fovRad = this.camera.fov * Math.PI / 180;
        const halfTan = Math.tan(fovRad / 2);

        // Primary: distance so targetViewHeight fills 85% of viewport height
        const distForHeight = (targetViewHeight / 0.85) / (2 * halfTan);

        // Secondary: back up if file is wider than viewport at reading distance
        const distForWidth = (size.x / 0.85) / (2 * this.camera.aspect * halfTan);

        const distance = Math.max(distForHeight, distForWidth, 5);

        // Position at the top of the file, centered horizontally.
        const centerX = (bounds.min.x + bounds.max.x) / 2;
        const topY = bounds.max.y;

        // Offset camera Y so file's top sits near the top of the viewport.
        const visibleHalfH = distance * halfTan;
        const topMargin = 0.08;
        const cameraY = topY - visibleHalfH * (1 - 2 * topMargin);

        this.camera.position.set(centerX, cameraY, bounds.max.z + distance);

        document.querySelectorAll('.tree-item').forEach((item, i) => {
            item.classList.toggle('selected', i === index);
        });
    }

    focusOnGrids() {
        const THREE = this.THREE;
        if (this.grids.length === 0) return;

        const bounds = this.hierarchicalManager
            ? this.hierarchicalManager.getTotalBounds()
            : this.layoutManager.getTotalBounds();

        const center = new THREE.Vector3();
        bounds.getCenter(center);
        const size = new THREE.Vector3();
        bounds.getSize(size);

        const distance = this._zDistanceForFit(size.x, size.y, 0.85);
        this.camera.position.set(center.x, center.y, bounds.max.z + distance);
        this.pitch = 0;
        this.yaw = 0;
    }

    updateCamera(deltaTime) {
        const THREE = this.THREE;
        const moveDir = new THREE.Vector3();

        if (this.keys['KeyW']) moveDir.z -= 1;
        if (this.keys['KeyS']) moveDir.z += 1;
        if (this.keys['KeyA']) moveDir.x -= 1;
        if (this.keys['KeyD']) moveDir.x += 1;
        if (this.keys['Space']) moveDir.y += 1;
        if (this.keys['ShiftLeft'] || this.keys['ShiftRight']) moveDir.y -= 1;

        if (moveDir.length() > 0) {
            moveDir.normalize();
            moveDir.applyQuaternion(this.camera.quaternion);
            moveDir.multiplyScalar(this.cameraSpeed * deltaTime);
            this.camera.position.add(moveDir);
        }

        const quaternion = new THREE.Quaternion();
        quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
        this.camera.quaternion.copy(quaternion);
    }

    updateStats(deltaTime) {
        this.frameCount++;
        this.fpsTime += deltaTime;
        if (this.fpsTime >= 1) {
            this.fpsBadge.fpsSpan.textContent = this.frameCount;
            this.statFpsEl.textContent = this.frameCount;
            this.frameCount = 0;
            this.fpsTime = 0;
        }

        this.fileCountEl.textContent = this.tree.length;
        this.gridCountEl.textContent = this.grids.length;

        let totalGlyphs = 0;
        for (const grid of this.grids) { totalGlyphs += grid.getGlyphCount(); }
        this.glyphCountEl.textContent = totalGlyphs;

        const pos = this.camera.position;
        this.cameraPosEl.textContent = `${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)}`;
    }

    onResize() {
        const width = window.innerWidth;
        const height = window.innerHeight;
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
    }

    animate() {
        requestAnimationFrame(() => this.animate());
        const now = performance.now();
        const deltaTime = (now - this.lastTime) / 1000;
        this.lastTime = now;

        this.updateCamera(deltaTime);
        this.updateStats(deltaTime);

        // Update billboard-style nameplates to face camera
        if (this.nameplateManager) {
            this.nameplateManager.updateBillboards(this.camera);
        }

        this.renderer.render(this.scene, this.camera);
    }
}

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
    HierarchicalLayoutManager,
    SpiralLayoutManager,
    TreemapLayoutManager
} from '../../src/index.js';

import { SelectionManager } from './SelectionManager.js';
import { RepositoryAdapter } from './RepositoryAdapter.js';
import { GitHubRepositorySource } from './GitHubRepositorySource.js';
import { DiffController } from './DiffController.js';
import { BackdropManager } from './BackdropManager.js';
import { NameplateManager } from './NameplateManager.js';
import { SceneContext } from './SceneContext.js';
import { CameraController } from './CameraController.js';
import { FileStateManager } from './FileStateManager.js';
import { CodeColorManager } from './CodeColorManager.js';
import { HeatmapProvider } from './providers/HeatmapProvider.js';

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
import { StatePersistence, resetAllAndReload } from './StatePersistence.js';

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
        this.spiralManager = null;
        this.treemapManager = null;
        this._activeLayout = 'hierarchical';
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

        // Extracted subsystems
        this.sceneContext = null;
        this.cameraController = null;
        this.fileStateManager = null;
        this.codeColorManager = null;
        this.heatmapProvider = null;
        this.statePersistence = null;
        this.selectionManager = null;

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
            onFileClick: (idx) => this.cameraController.focusOnDiffFile(idx),
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

        // Create shared context for subsystems
        this.sceneContext = new SceneContext({
            THREE,
            scene: this.scene,
            camera: this.camera,
            renderer: this.renderer,
            canvas: this.canvas,
            atlas: this.atlas,
            getGrids: () => this.grids,
        });
        this.sceneContext.layoutManager = this.layoutManager;

        // Camera controller (replaces inline camera state + listeners)
        this.cameraController = new CameraController(this.sceneContext);
        this.cameraController.setupEventListeners();

        // Touch controls (pass cameraController — it owns yaw, pitch, cameraSpeed, camera)
        this.touchController = new TouchController(this.canvas, this.cameraController, THREE);

        // File state + visualization pipeline
        this.fileStateManager = new FileStateManager();
        this.codeColorManager = new CodeColorManager(this.sceneContext, this.fileStateManager);
        this.codeColorManager.registerLayer('heatmap', {
            priority: 10,
            watchProperties: ['heatMetric'],
            colorFn: HeatmapProvider.createColorFn(),
        });

        // Selection manager — owns selection state, raycasting, Z-pop
        this.selectionManager = new SelectionManager(THREE, this.fileStateManager);

        // Selection color layer (priority 15 — above heatmap, below future search at 30)
        // A deep teal tint distinguishes selected files from heatmap coloring.
        this.codeColorManager.registerLayer('selection', {
            priority: 15,
            watchProperties: ['selected'],
            colorFn: (sourcePath, fileProps) => {
                if (!fileProps?.selected) return null;
                // Teal selection tint: overrides heatmap color for selected files
                return { r: 0.2, g: 0.9, b: 0.6 };
            },
        });

        // Listen for camera focus events to sync tree UI
        window.addEventListener('camera-focus-changed', (e) => {
            const { index } = e.detail;
            document.querySelectorAll('.tree-item').forEach((item, i) => {
                item.classList.toggle('selected', i === index);
            });
        });

        // Listen for canvas clicks — forward to selection manager
        this.canvas.addEventListener('canvas-click', (e) => {
            const { clientX, clientY, ctrlKey, metaKey } = e.detail;
            const additive = ctrlKey || metaKey;
            this.selectionManager.handleClick(
                clientX, clientY,
                this.canvas,
                this.camera,
                this.grids,
                additive
            );
        });

        // Escape key deselects all
        document.addEventListener('keydown', (e) => {
            if (e.code === 'Escape') {
                this.selectionManager.clear(this.grids);
            }
        });

        // file-selected event: sync tree panel .selected class by sourcePath
        window.addEventListener('file-selected', (e) => {
            const { selected } = e.detail;
            const selectedSet = new Set(selected);
            document.querySelectorAll('.tree-item.tree-file').forEach((item) => {
                const path = item.dataset?.path;
                item.classList.toggle('selected', path ? selectedSet.has(path) : false);
            });
        });

        this.addGridHelper();
        this.setupEventListeners();

        this.loading.hide();
        this.animate();

        // Create reset button next to the drawer toggle
        this._createResetButton();

        // State persistence: restore UI, start camera saving, auto-load
        this.statePersistence = new StatePersistence(this);
        const shouldAutoLoad = this.statePersistence.restoreUI();
        this.statePersistence.startCameraSaving();

        console.log('GitHub 3D Repo Viewer ready!');

        if (shouldAutoLoad) {
            // Auto-load the last repo; restore camera after grids load
            this.toastUI.show('Restoring previous session...', 'success');
            this.loadRepository({ restoreCamera: true });
        } else {
            this.toastUI.show('Ready! Open the Repo tab to load a repository', 'success');
            this.drawer.openToTab('repo');
        }
    }

    /**
     * Create a small reset button next to the drawer toggle (hamburger).
     * Clears all localStorage and reloads the page.
     * @private
     */
    _createResetButton() {
        const btn = document.createElement('button');
        btn.id = 'state-reset-btn';
        btn.setAttribute('aria-label', 'Reset all settings');
        btn.innerHTML = '&#8634;';  // ↺
        btn.title = 'Reset all settings & reload';
        document.body.appendChild(btn);
        btn.addEventListener('click', () => {
            if (confirm('Clear all saved state and reload?')) {
                resetAllAndReload();
            }
        });
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

        // Window resize (renderer-side only; camera-side handled by CameraController)
        window.addEventListener('resize', () => {
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        });

        // Settings sliders
        const gridsScaleSlider = document.getElementById('grids-scale');
        const gridsScaleValue = document.getElementById('grids-scale-value');
        gridsScaleSlider.addEventListener('input', (e) => {
            const scale = parseFloat(e.target.value);
            gridsScaleValue.textContent = scale.toFixed(1);
            for (const grid of this.grids) { grid.scale.setScalar(scale); }
            if (this.statePersistence) this.statePersistence.onGridsScaleChanged(scale);
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
            if (this.statePersistence) this.statePersistence.onLayoutSpacingChanged(spacing);
        });

        // Layout mode selector
        const layoutSelect = document.getElementById('layout-mode');
        if (layoutSelect) {
            layoutSelect.addEventListener('change', (e) => {
                this._activeLayout = e.target.value;
                this.relayoutGrids();
                this.cameraController.focusOnGrids();
                if (this.statePersistence) this.statePersistence.onLayoutChanged(e.target.value);
            });
        }

        // cam-speed, reset-camera, fit-all listeners handled by CameraController
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

        // Always run hierarchical first (needed for tree UI + overlays)
        if (this.hierarchicalManager) {
            this.hierarchicalManager.options.siblingSpacing = 8;
            this.hierarchicalManager.options.dirPadding = 15;
            this.hierarchicalManager.clear();
            this.hierarchicalManager.layoutHierarchy(this.grids);
        }

        // Alternate layouts reposition grids on top of hierarchical
        if (this._activeLayout === 'spiral') {
            if (!this.spiralManager) this.spiralManager = new SpiralLayoutManager();
            this.spiralManager.clear();
            this.spiralManager.layoutSpiral(this.grids);
            this.sceneContext.spiralManager = this.spiralManager;
            this.sceneContext.treemapManager = null;
        } else if (this._activeLayout === 'treemap') {
            if (!this.treemapManager) this.treemapManager = new TreemapLayoutManager();
            this.treemapManager.clear();
            this.treemapManager.layoutTreemap(this.grids);
            this.sceneContext.treemapManager = this.treemapManager;
            this.sceneContext.spiralManager = null;
        } else {
            this.sceneContext.spiralManager = null;
            this.sceneContext.treemapManager = null;
        }

        this._updateOverlays();
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

    async loadRepository(options = {}) {
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

            // Phase 2b: Layout
            const layoutStart = performance.now();
            this.loading.update(0.7, `Computing layout...`);

            // Always create hierarchical manager (needed for tree UI)
            const HLM = HierarchicalLayoutManager;
            this.hierarchicalManager = new HLM({
                dirPadding: 15,
                dirPaddingDecay: 0.7,
                siblingSpacing: 8,
                maxRowWidth: 8000,
                targetAspectRatio: 3.0,
                directoriesInZ: false,
                siblingDirection: 'horizontal'
            });
            this.sceneContext.hierarchicalManager = this.hierarchicalManager;

            // Add grids to scene + tracking before layout
            for (const grid of createdGrids) {
                this.scene.add(grid);
                this.grids.push(grid);
            }

            // Always run hierarchical layout (builds tree for UI + positions grids)
            this.hierarchicalManager.layoutHierarchy(createdGrids);

            // Alternate layouts reposition on top of hierarchical
            if (this._activeLayout === 'spiral') {
                this.spiralManager = new SpiralLayoutManager();
                this.spiralManager.layoutSpiral(createdGrids);
                this.sceneContext.spiralManager = this.spiralManager;
            } else if (this._activeLayout === 'treemap') {
                this.treemapManager = new TreemapLayoutManager();
                this.treemapManager.layoutTreemap(createdGrids);
                this.sceneContext.treemapManager = this.treemapManager;
            } else {
                this.sceneContext.spiralManager = null;
                this.sceneContext.treemapManager = null;
            }

            console.log('Directory structure:');
            this.hierarchicalManager.printTree();

            const layoutTime = performance.now() - layoutStart;
            console.log(`[2b] Hierarchical layout: ${createdGrids.length} grids in ${layoutTime.toFixed(0)}ms`);

            // Phase 2c: Create visual overlays (backdrops + nameplates)
            const overlayStart = performance.now();
            this.loading.update(0.8, `Creating visual overlays...`);
            this._createOverlays();
            // Non-hierarchical: hide backdrops immediately
            if (this._activeLayout !== 'hierarchical') {
                this._updateOverlays();
            }
            const overlayTime = performance.now() - overlayStart;
            console.log(`[2c] Visual overlays: ${overlayTime.toFixed(0)}ms`);

            // Phase 2d: Compute heatmap metrics → triggers CodeColorManager coloring
            const heatStart = performance.now();
            this.heatmapProvider = new HeatmapProvider(this.sceneContext, this.fileStateManager);
            this.heatmapProvider.computeMetrics();
            const heatTime = performance.now() - heatStart;
            console.log(`[2d] Heatmap metrics: ${heatTime.toFixed(0)}ms`);

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

            // Persist successful load
            if (this.statePersistence) {
                this.statePersistence.onRepoLoaded(url, branch);

                // Restore camera position if this was an auto-load from persistence
                if (options.restoreCamera) {
                    this.statePersistence.restoreCamera();
                }
            }

            // Apply persisted grids scale to newly loaded grids
            if (this.statePersistence) {
                const scale = this.statePersistence.state.gridsScale;
                if (scale != null && scale !== 1.0) {
                    for (const grid of this.grids) { grid.scale.setScalar(scale); }
                }
            }

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

        // Clean up visualization pipeline (clear data, keep managers alive)
        if (this.fileStateManager) this.fileStateManager.clear();
        if (this.codeColorManager) this.codeColorManager.resetAllColors();
        if (this.selectionManager) this.selectionManager.dispose();
        this.heatmapProvider = null;

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
            this.cameraController.focusOnDiffGrids(this.diffController);

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

    // focusOnDiffFile, focusOnDiffGrids → CameraController

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
                this.cameraController.focusOnDirectory(node.path);
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
                fileItem.addEventListener('click', () => {
                    this.cameraController.focusOnGrid(gridIndex);
                    // Also set selection state so visual tint and tree sync apply
                    if (this.selectionManager && node.path) {
                        this.selectionManager.select(node.path, { grids: this.grids });
                    }
                });
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

    // focusOnDirectory → CameraController

    /**
     * Create visual overlay managers (backdrops + nameplates)
     * @private
     */
    _createOverlays() {
        if (!this.hierarchicalManager || !this.hierarchicalManager.root) return;

        // Dispose old managers if they exist
        if (this.backdropManager) this.backdropManager.destroy();
        if (this.nameplateManager) this.nameplateManager.destroy();

        // Non-hierarchical modes: no backdrops, no nameplates
        if (this._activeLayout === 'spiral' || this._activeLayout === 'treemap') {
            this.backdropManager = null;
            this.nameplateManager = null;
            // Add spiral guide line
            if (this._spiralGuide) {
                this.scene.remove(this._spiralGuide);
                this._spiralGuide.geometry.dispose();
                this._spiralGuide.material.dispose();
            }
            if (this.spiralManager) {
                this._spiralGuide = this.spiralManager.createSpiralGuide(this.THREE);
                this.scene.add(this._spiralGuide);
            }
            return;
        }

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

        if (this._activeLayout === 'spiral' || this._activeLayout === 'treemap') {
            // Non-hierarchical mode: hide backdrops/nameplates
            if (this.backdropManager) this.backdropManager.setVisible(false);
            if (this.nameplateManager) this.nameplateManager.setVisible(false);

            // Add or update spiral guide line
            if (this._spiralGuide) {
                this.scene.remove(this._spiralGuide);
                this._spiralGuide.geometry.dispose();
                this._spiralGuide.material.dispose();
            }
            if (this.spiralManager) {
                this._spiralGuide = this.spiralManager.createSpiralGuide(this.THREE);
                this.scene.add(this._spiralGuide);
            }
        } else {
            // Hierarchical mode: show backdrops/nameplates, remove spiral guide
            if (this._spiralGuide) {
                this.scene.remove(this._spiralGuide);
                this._spiralGuide.geometry.dispose();
                this._spiralGuide.material.dispose();
                this._spiralGuide = null;
            }

            if (this.backdropManager) {
                this.backdropManager.setVisible(true);
                this.backdropManager.updateBackdrops(
                    this.hierarchicalManager.root,
                    this.hierarchicalManager.collapsedPaths
                );
            }

            if (this.nameplateManager) {
                this.nameplateManager.setVisible(true);
                this.nameplateManager.updateNameplates(
                    this.hierarchicalManager.root,
                    this.hierarchicalManager.collapsedPaths
                );
            }
        }
    }

    formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    // _zDistanceForFit, focusOnGrid, focusOnGrids, updateCamera → CameraController

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

    // onResize → split: camera-side in CameraController, renderer-side inlined in setupEventListeners

    animate() {
        requestAnimationFrame(() => this.animate());
        const now = performance.now();
        const deltaTime = (now - this.lastTime) / 1000;
        this.lastTime = now;

        this.cameraController.update(deltaTime);
        if (this.statePersistence) this.statePersistence.markCameraDirty();
        this.updateStats(deltaTime);

        // Update billboard-style nameplates to face camera
        if (this.nameplateManager) {
            this.nameplateManager.updateBillboards(this.camera);
        }

        this.renderer.render(this.scene, this.camera);
    }
}

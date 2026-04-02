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
    TreemapLayoutManager,
    StackLayoutManager
} from '../src/index.js';

import { PickingSystem } from '../src/picking/PickingSystem.js';
import GridVirtualizer from '../src/collections/GridVirtualizer.js';
import { getCanvasViewportSize } from '../src/core/canvasSize.js';
import { SelectionManager } from '../src/services/interaction/SelectionManager.js';
import { ShortcutManager } from '../src/services/interaction/ShortcutManager.js';
import { TreemapLabelManager } from '../src/services/visual/TreemapLabelManager.js';
import { MinimapOverlay } from '../src/components/MinimapOverlay.js';
import { RepositoryAdapter } from '../src/services/data/RepositoryAdapter.js';
import { GitHubRepositorySource } from '../src/services/data/GitHubRepositorySource.js';
import { RemoteFileSystemProvider } from '../src/services/data/RemoteFileSystemProvider.js';
import { DiffController } from '../src/services/orchestration/DiffController.js';
import { BackdropManager } from '../src/services/visual/BackdropManager.js';
import { NameplateManager } from '../src/services/visual/NameplateManager.js';
import { SceneContext } from '../src/services/SceneContext.js';
import { ViewerCameraController } from '../src/services/camera/ViewerCameraController.js';
import { FileStateManager } from '../src/services/state/FileStateManager.js';
import { CodeColorManager } from '../src/services/interaction/CodeColorManager.js';
import { HeatmapProvider } from '../src/services/data/HeatmapProvider.js';

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
import { stateController } from '../src/services/state/StateController.js';
import { getTextExts, getTextNames, setTextExts, setTextNames, getDefaults, resetToDefaults } from '../src/services/data/textFileFilter.js';
import { HandGestureAdapter } from '../src/services/orchestration/HandGestureAdapter.js';
import { initCommandCenter } from './commands/index.js';
import SceneRegistry from '../src/services/SceneRegistry.js';
import { SpatialAnimator } from '../src/services/spatial/SpatialAnimator.js';
import { SpatialWindowManager } from '../src/services/spatial/SpatialWindowManager.js';
import { HitDispatcher } from '../src/services/interaction/HitDispatcher.js';

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
        this.stackManager = null;
        this._activeLayout = 'hierarchical';
        this.repoAdapter = null;
        this.githubSource = new GitHubRepositorySource();
        this.diffController = null;
        this.diffPanel = null;

        // Visual overlay managers
        this.backdropManager = null;
        this.nameplateManager = null;

        // State -- registry is the single source of truth for scene objects.
        // `this.grids` is a getter that returns a frozen cached array from the registry.
        this.registry = new SceneRegistry();
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
        this.shortcutManager = null;

        // Overlay components
        this.minimapOverlay = null;
        this.treemapLabelManager = null;

        // Hand tracking adapter (optional, toggled via Settings panel)
        this.handGestureAdapter = null;

        // Source mode: 'local' (Go relay FS) or 'github' (default)
        // URL param takes priority, then saved state, then default 'github'.
        const params = new URLSearchParams(window.location.search);
        const urlSource = params.get('source');
        this._sourceMode = urlSource || stateController.get('source.mode', 'github');
        this._localRoot = stateController.get('source.localRoot', '.');

        // Tab traversal index (tracks which file is "focused" via Tab key)
        this._tabIndex = -1;

        // Animation
        this.lastTime = performance.now();
        this.frameCount = 0;
        this.fpsTime = 0;
    }

    /** @returns {Object[]} frozen array of CodeGrid instances from registry */
    get grids() {
        return this.registry.toArray('grid');
    }

    /** Setter trap -- catches stale `this.grids = ...` assignments */
    set grids(_) {
        throw new Error('Cannot assign to grids -- use registry.register() / registry.unregister()');
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

        // Atlas config from persisted settings
        this._atlasFont = stateController.get('atlas.font', 'Monaco, Menlo, Courier New, monospace');
        this._atlasFontSize = stateController.get('atlas.fontSize', 48);
        this._atlasSize = stateController.get('atlas.size', 2048);

        // Atlas: try relay cache, then static pre-baked asset, then generate
        this.loading.show('Loading glyph atlas...');

        // 1. Try WebSocket relay cache (local dev)
        let _cachedAtlas = await this._tryLoadCachedAtlas();
        if (_cachedAtlas) {
            console.log('[atlas] Loaded from relay cache');
            this.atlas = _cachedAtlas;
        } else {
            // 2. Try static pre-baked asset (remote deployment)
            _cachedAtlas = await this._tryLoadStaticAtlas();
            if (_cachedAtlas) {
                console.log('[atlas] Loaded from static asset');
                this.atlas = _cachedAtlas;
            } else {
                // 3. Generate at runtime (first run)
                console.log(`[atlas] Generating ${this._atlasSize}x${this._atlasSize} (${this._atlasFont} ${this._atlasFontSize}px)...`);
                this.atlas = new GlyphAtlas(this._atlasFont, this._atlasFontSize, this._atlasSize);
                await this.atlas.generate((current, total) => {
                    this.loading.update(current / total, `Generating glyphs: ${current}/${total}`);
                });
                // Cache for next time (fire-and-forget)
                this._cacheAtlasToRelay();
            }
        }
        // Track atlas version at load time — if ensureGraphemes adds glyphs
        // during file loading, we'll re-cache the expanded atlas afterward.
        this._atlasVersionAtLoad = this.atlas.uvMapVersion;

        // Three.js setup
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0a0a0a);

        const { width: initW, height: initH } = getCanvasViewportSize(this.canvas);

        this.camera = new THREE.PerspectiveCamera(70, initW / initH, 0.1, 10000);
        this.camera.position.set(0, 0, 500);

        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, preserveDrawingBuffer: true });
        this.renderer.setSize(initW, initH);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

        this.layoutManager = new GridLayoutManager();

        // GPU picking system — character-level hit testing
        // Full resolution needed: at distant camera positions, glyphs are small
        // and sub-pixel at reduced resolution
        this.pickingSystem = new PickingSystem(this.renderer, { resolutionScale: 1.0 });
        this._lastPickHit = null;
        this._lastPickSlot = -1;

        // Wire WebGL context restore to picking system render target recreation
        this.renderer.domElement.addEventListener('webglcontextrestored', () => {
            this.pickingSystem?.onContextRestored();
        });

        // Frustum-based grid virtualization — only render visible grids
        this.gridVirtualizer = new GridVirtualizer(this.scene, this.camera);

        // repoAdapter is set after the WebSocket bridge is created (below)
        // so local mode can use it as transport.
        this.repoAdapter = null;
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
        this.cameraController = new ViewerCameraController(this.sceneContext);
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

        // Spatial animation engine (update() called from animate loop)
        this.spatialAnimator = new SpatialAnimator();

        // Spatial window manager — group membership, color layers, lifecycle
        this.spatialManager = new SpatialWindowManager({
            registry: this.registry,
            selectionManager: this.selectionManager,
            fileStateManager: this.fileStateManager,
            codeColorManager: this.codeColorManager,
            animator: this.spatialAnimator,
        });

        // Hit dispatcher — intercepts mousedown on windows before camera drag
        this.hitDispatcher = new HitDispatcher({
            canvas: this.canvas,
            camera: this.camera,
            scene: this.scene,
            registry: this.registry,
            spatialManager: this.spatialManager,
            virtualizer: this.gridVirtualizer,
        });
        this.hitDispatcher.attach();

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

        // file-selected event: sync tree panel .selected class by sourcePath
        window.addEventListener('file-selected', (e) => {
            const { selected } = e.detail;
            const selectedSet = new Set(selected);
            document.querySelectorAll('.tree-item.tree-file').forEach((item) => {
                const path = item.dataset?.path;
                item.classList.toggle('selected', path ? selectedSet.has(path) : false);
            });
        });

        // ---- Phase 2: Keyboard Shortcuts ----
        this.shortcutManager = new ShortcutManager();
        this._registerShortcuts();
        this.shortcutManager.attach();

        // ---- Phase 3: Minimap Overlay ----
        this.minimapOverlay = new MinimapOverlay({
            THREE,
            camera: this.camera,
            getGrids: () => this.grids,
            getLayoutBounds: () => {
                if (this.stackManager && this._activeLayout === 'stack') return this.stackManager.getTotalBounds();
                if (this.treemapManager) return this.treemapManager.getTotalBounds();
                if (this.spiralManager)  return this.spiralManager.getTotalBounds();
                if (this.hierarchicalManager) return this.hierarchicalManager.getTotalBounds();
                return null;
            },
            onNavigate: ({ x, y }) => {
                // Jump camera to that world XY while keeping current Z
                this.camera.position.x = x;
                this.camera.position.y = y;
            },
        });

        // Hand gesture adapter — created now so the camera already exists.
        // The adapter attaches HandRenderer as a child of this.camera.
        // It is disabled until the user toggles the setting on.
        this.handGestureAdapter = new HandGestureAdapter({
            camera:           this.camera,
            canvas:           this.canvas,
            cameraController: this.cameraController,
        });
        // The camera must be in the scene graph for hand meshes (camera children) to render.
        this.scene.add(this.camera);

        // ---- WebSocket Command Center ----
        // Wires CommandRouter, ViewerAPI (window.viewer), and WebSocketBridge (off by default).
        // Start the relay with `glyph3d-cli serve`, then call `window.viewer.connect()` or
        // enable via settings to connect.
        const { router, bridge, api } = initCommandCenter(this, {
            port: this._wsPort(),
            autoConnect: false,
            showStatus: true,
        });
        this._commandRouter = router;
        this._wsBridge = bridge;
        this._viewerAPI = api;

        // Wire data provider — must come after bridge creation so local mode
        // can use the WebSocket as transport.
        if (this._sourceMode === 'local') {
            this.repoAdapter = new RemoteFileSystemProvider(bridge, {
                root: this._localRoot,
            });
        } else {
            this.repoAdapter = new RepositoryAdapter();
        }
        // Backfill repoAdapter into diffController
        this.diffController.repoAdapter = this.repoAdapter;

        this.addGridHelper();
        this.setupEventListeners();
        this._setupHandTrackingToggle();
        this._setupWebSocketToggle();

        this.loading.hide();
        this.animate();

        // Create reset button next to the drawer toggle
        this._createResetButton();

        // State persistence: restore UI, start camera saving, auto-load
        this.statePersistence = new StatePersistence(this);
        const shouldAutoLoad = this.statePersistence.restoreUI();
        this.statePersistence.startCameraSaving();

        console.log('GitHub 3D Repo Viewer ready!');

        if (this._sourceMode === 'local') {
            // Local mode: connect WebSocket, wait for it, then load from disk
            this.toastUI.show(`Connecting to relay for local files...`, 'success');
            this._connectAndLoadLocal(bridge, { restoreCamera: true });
        } else if (shouldAutoLoad) {
            // Auto-load the last repo; restore camera after grids load
            this.toastUI.show('Restoring previous session...', 'success');
            this.loadRepository({ restoreCamera: true });
        } else {
            this.toastUI.show('Ready! Open the Repo tab to load a repository', 'success');
            this.drawer.openToTab('repo');
        }
    }

    /**
     * Derive the WebSocket port from the page origin (unified server),
     * falling back to 8080 (glyph3d-cli default).
     * @returns {number}
     * @private
     */
    _wsPort() {
        const loc = typeof window !== 'undefined' && window.location;
        if (loc && loc.port) return parseInt(loc.port, 10);
        return 8080;
    }

    /**
     * Build a WebSocket URL for the relay on the current server.
     * @returns {string}
     * @private
     */
    _wsUrl() {
        const loc = typeof window !== 'undefined' && window.location;
        if (loc && loc.hostname && loc.port) {
            return `ws://${loc.hostname}:${loc.port}`;
        }
        return `ws://localhost:${this._wsPort()}`;
    }

    /**
     * Try to load a pre-baked atlas from the WebSocket relay cache.
     * Opens a temporary WebSocket connection, sends atlas.get, waits for the
     * response, then closes cleanly. Does NOT send "DISPLAY" so it does not
     * compete with the main CommandCenter connection.
     *
     * @param {number} [timeoutMs=2000] - Milliseconds before giving up
     * @returns {Promise<GlyphAtlas|null>}
     * @private
     */
    async _tryLoadCachedAtlas(timeoutMs = 2000) {
        return new Promise((resolve) => {
            try {
                const ws = new WebSocket(this._wsUrl());
                const timer = setTimeout(() => { ws.close(); resolve(null); }, timeoutMs);

                ws.onopen = () => {
                    ws.send(JSON.stringify({
                        relay: 'atlas.get',
                        font: this._atlasFont,
                        size: this._atlasSize,
                    }));
                };

                ws.onmessage = async (e) => {
                    clearTimeout(timer);
                    try {
                        const msg = JSON.parse(e.data);
                        if (msg.event === 'atlas.result' && msg.hit) {
                            const img = await new Promise((res, rej) => {
                                const image = new Image();
                                image.onload = () => res(image);
                                image.onerror = rej;
                                image.src = `data:image/png;base64,${msg.png}`;
                            });
                            const atlas = GlyphAtlas.fromPrebuilt(msg.descriptor, img);
                            ws.close();
                            resolve(atlas);
                        } else {
                            ws.close();
                            resolve(null);
                        }
                    } catch (_err) {
                        ws.close();
                        resolve(null);
                    }
                };

                ws.onerror = () => { clearTimeout(timer); resolve(null); };
            } catch (_e) {
                resolve(null);
            }
        });
    }

    /**
     * Try to load a pre-baked atlas from static HTTP assets shipped with the
     * deployment. Expects `/assets/atlas-prebaked.png` and
     * `/assets/atlas-prebaked.json` to be present with HTTP 200.
     *
     * @returns {Promise<GlyphAtlas|null>}
     * @private
     */
    async _tryLoadStaticAtlas() {
        try {
            const [pngRes, jsonRes] = await Promise.all([
                fetch('/assets/atlas-prebaked.png'),
                fetch('/assets/atlas-prebaked.json'),
            ]);
            if (!pngRes.ok || !jsonRes.ok) return null;

            const [blob, descriptor] = await Promise.all([
                pngRes.blob(),
                jsonRes.json(),
            ]);

            const img = await new Promise((res, rej) => {
                const image = new Image();
                image.onload = () => res(image);
                image.onerror = rej;
                image.src = URL.createObjectURL(blob);
            });

            return GlyphAtlas.fromPrebuilt(descriptor, img);
        } catch (_e) {
            return null;
        }
    }

    /**
     * Fire-and-forget: send the freshly generated atlas to the relay so it can
     * be served on the next startup. Opens a temporary WebSocket, sends
     * atlas.cache, then closes after a short delay. Errors are swallowed —
     * the relay may not be running in all environments.
     *
     * @private
     */
    _cacheAtlasToRelay() {
        try {
            const { image: dataUrl, descriptor } = this.atlas.exportAtlas();
            const png = dataUrl.replace(/^data:image\/png;base64,/, '');

            const ws = new WebSocket(this._wsUrl());
            ws.onopen = () => {
                ws.send(JSON.stringify({
                    relay: 'atlas.cache',
                    font: descriptor.fontFamily || 'Monaco, Menlo, Courier New, monospace',
                    size: descriptor.textureWidth || 2048,
                    png,
                    descriptor,
                }));
                setTimeout(() => ws.close(), 500);
            };
            ws.onerror = () => {}; // Relay may not be running — silently ignore
        } catch (_e) {
            // Atlas caching is optional — do not propagate errors
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

    /**
     * Wire the hand-tracking enable checkbox and source selector in the Settings panel.
     * The DOM elements are created by settingsPanelHTML() in Drawer.js.
     * @private
     */
    _setupHandTrackingToggle() {
        const checkbox    = document.getElementById('hand-tracking-enabled');
        const sourceGroup = document.getElementById('hand-tracking-source-group');
        const sourceSelect = document.getElementById('hand-tracking-source');
        const hint        = document.getElementById('hand-tracking-hint');

        if (!checkbox) return; // Settings panel not yet in DOM — skip

        const updateHint = (sourceType) => {
            if (!hint) return;
            if (sourceType === 'mock') {
                hint.textContent = 'Mock source: move mouse to position hand, Space to pinch';
            } else if (sourceType === 'websocket') {
                hint.textContent = `WebSocket source: connect ${this._wsUrl()} (iPhone / external)`;
            }
        };

        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                const src = sourceSelect ? sourceSelect.value : 'mock';
                this.handGestureAdapter.enable(src);
                if (sourceGroup) sourceGroup.style.display = '';
                updateHint(src);
                this.toastUI?.show('Hand tracking enabled (mock source)', 'success');
            } else {
                this.handGestureAdapter.disable();
                if (sourceGroup) sourceGroup.style.display = 'none';
                this.toastUI?.show('Hand tracking disabled', 'success');
            }
        });

        if (sourceSelect) {
            sourceSelect.addEventListener('change', () => {
                updateHint(sourceSelect.value);
                if (checkbox.checked) {
                    // Re-enable with new source
                    this.handGestureAdapter.enable(sourceSelect.value);
                }
            });
        }
    }

    _setupWebSocketToggle() {
        const checkbox = document.getElementById('ws-enabled');
        const portGroup = document.getElementById('ws-port-group');
        const statusGroup = document.getElementById('ws-status-group');
        const portInput = document.getElementById('ws-port');
        const statusEl = document.getElementById('ws-connection-status');

        if (!checkbox) return;

        const updateStatus = () => {
            if (!statusEl || !this._wsBridge) return;
            statusEl.textContent = this._wsBridge.connected ? 'Connected' : 'Disconnected';
            statusEl.style.color = this._wsBridge.connected ? '#00ff88' : '#888';
        };

        // Restore saved state
        const savedWsEnabled = stateController.get('ui.wsEnabled', false);
        if (savedWsEnabled) {
            checkbox.checked = true;
            if (portGroup) portGroup.style.display = '';
            if (statusGroup) statusGroup.style.display = '';
            const port = portInput ? parseInt(portInput.value, 10) : this._wsPort();
            if (this._wsBridge) {
                this._wsBridge.port = port;
                this._wsBridge.connect();
            }
            const poll = setInterval(() => {
                updateStatus();
                if (this._wsBridge?.connected) clearInterval(poll);
            }, 500);
            setTimeout(() => clearInterval(poll), 10000);
        }

        checkbox.addEventListener('change', () => {
            stateController.set('ui.wsEnabled', checkbox.checked);
            if (checkbox.checked) {
                if (portGroup) portGroup.style.display = '';
                if (statusGroup) statusGroup.style.display = '';
                const port = portInput ? parseInt(portInput.value, 10) : this._wsPort();
                if (this._wsBridge) {
                    this._wsBridge.port = port;
                    this._wsBridge.connect();
                }
                this.toastUI?.show(`Connecting to ws://localhost:${port}...`, 'success');
                // Poll status briefly
                const poll = setInterval(() => {
                    updateStatus();
                    if (this._wsBridge?.connected) clearInterval(poll);
                }, 500);
                setTimeout(() => clearInterval(poll), 10000);
            } else {
                if (this._wsBridge) {
                    this._wsBridge.disconnect();
                }
                if (portGroup) portGroup.style.display = 'none';
                if (statusGroup) statusGroup.style.display = 'none';
                updateStatus();
                this.toastUI?.show('WebSocket disconnected', 'success');
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

        // Source selector — toggle between GitHub and Local fields
        const sourceSelect = document.getElementById('source-select');
        const githubFields = document.getElementById('github-fields');
        const localFields = document.getElementById('local-fields');
        if (sourceSelect) {
            // Set initial state from _sourceMode
            sourceSelect.value = this._sourceMode;
            if (this._sourceMode === 'local') {
                if (githubFields) githubFields.style.display = 'none';
                if (localFields) localFields.style.display = '';
            }
            sourceSelect.addEventListener('change', () => {
                const mode = sourceSelect.value;
                this._switchSourceMode(mode);
                if (githubFields) githubFields.style.display = mode === 'github' ? '' : 'none';
                if (localFields) localFields.style.display = mode === 'local' ? '' : 'none';
            });
        }

        this.repoInput.addEventListener('input', () => {
            this.branches = [];
            this.defaultBranch = null;
            this.branchListEl.classList.add('hidden');
            this.branchListEl.innerHTML = '';
            this.branchStatusEl.textContent = '';
        });

        // Window resize — use canvas container size, not window size.
        // In IDE mode, IDEShell._onEditorResize() handles sizing from the editor area.
        // This handler covers standalone (viewer.html) and as a fallback.
        window.addEventListener('resize', () => {
            const { width: w, height: h } = getCanvasViewportSize(this.canvas);
            this.renderer.setSize(w, h);
            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();
            this.pickingSystem?.onResize();
        });

        // Picking system mouse wiring — document-level so pointer lock
        // and UI overlays don't block canvas mousemove
        document.addEventListener('mousemove', (e) => {
            if (!this.pickingSystem) return;
            const rect = this.canvas.getBoundingClientRect();
            const cssX = e.clientX - rect.left;
            const cssY = e.clientY - rect.top;
            if (cssX >= 0 && cssY >= 0 && cssX <= rect.width && cssY <= rect.height) {
                this.pickingSystem.setMousePosition(cssX, cssY);
            }
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

        // Minimap size slider (drives CSS custom property for mobile layout)
        const minimapSizeSlider = document.getElementById('minimap-size');
        const minimapSizeValue = document.getElementById('minimap-size-value');
        if (minimapSizeSlider) {
            minimapSizeSlider.addEventListener('input', (e) => {
                const pct = parseInt(e.target.value, 10);
                minimapSizeValue.textContent = `${pct}%`;
                document.documentElement.style.setProperty('--minimap-size', pct);
            });
        }

        // cam-speed, reset-camera, fit-all listeners handled by CameraController

        // ---- Atlas settings ----
        const atlasFontInput = document.getElementById('atlas-font');
        const atlasFontSizeSlider = document.getElementById('atlas-fontsize');
        const atlasFontSizeValue = document.getElementById('atlas-fontsize-value');
        const atlasSizeSelect = document.getElementById('atlas-size');
        const atlasClearCacheBtn = document.getElementById('atlas-clear-cache');

        if (atlasFontInput) {
            atlasFontInput.value = this._atlasFont;
            atlasFontInput.addEventListener('change', (e) => {
                stateController.set('atlas.font', e.target.value);
            });
        }
        if (atlasFontSizeSlider) {
            atlasFontSizeSlider.value = this._atlasFontSize;
            atlasFontSizeValue.textContent = this._atlasFontSize;
            atlasFontSizeSlider.addEventListener('input', (e) => {
                const v = parseInt(e.target.value, 10);
                atlasFontSizeValue.textContent = v;
                stateController.set('atlas.fontSize', v);
            });
        }
        if (atlasSizeSelect) {
            atlasSizeSelect.value = this._atlasSize;
            atlasSizeSelect.addEventListener('change', (e) => {
                stateController.set('atlas.size', parseInt(e.target.value, 10));
            });
        }
        if (atlasClearCacheBtn) {
            atlasClearCacheBtn.addEventListener('click', () => {
                // Tell relay to delete the cached atlas for current settings
                try {
                    const ws = new WebSocket(this._wsUrl());
                    ws.onopen = () => {
                        ws.send(JSON.stringify({
                            relay: 'atlas.clear',
                            font: stateController.get('atlas.font', this._atlasFont),
                            size: stateController.get('atlas.size', this._atlasSize),
                        }));
                        setTimeout(() => ws.close(), 300);
                    };
                    ws.onerror = () => {};
                } catch (_e) { /* relay may not be running */ }
                console.log('[atlas] Cache cleared — reload to regenerate');
            });
        }

        // ---- File type whitelist ----
        const extTextarea = document.getElementById('ext-whitelist');
        const extApplyBtn = document.getElementById('ext-apply');
        const extResetBtn = document.getElementById('ext-reset');

        if (extTextarea) {
            extTextarea.value = [...getTextExts(), ...getTextNames()].join(', ');
        }

        if (extApplyBtn) {
            extApplyBtn.addEventListener('click', () => {
                this._applyFileTypeWhitelist(extTextarea.value);
            });
        }

        if (extResetBtn) {
            extResetBtn.addEventListener('click', () => {
                resetToDefaults();
                const { exts, names } = getDefaults();
                if (extTextarea) extTextarea.value = [...exts, ...names].join(', ');
                this._pushFilterToRelay();
                this.statePersistence?.onFileTypesChanged(null);
                this.toastUI.show('File types reset to defaults', 'success');
            });
        }
    }

    /**
     * Register all keyboard shortcuts.
     * Called once during init, after ShortcutManager is created.
     * @private
     */
    _registerShortcuts() {
        const sm = this.shortcutManager;

        // Escape — deselect all
        sm.register('escape', () => {
            if (this.selectionManager) this.selectionManager.clear(this.grids);
        }, { description: 'Deselect all' });

        // Tab — select next file
        sm.register('tab', () => {
            this._tabTraverse(1);
        }, { description: 'Select next file' });

        // Shift+Tab — select previous file
        sm.register('shift+tab', () => {
            this._tabTraverse(-1);
        }, { description: 'Select previous file' });

        // Enter — focus camera on selected file
        sm.register('enter', () => {
            if (this.selectionManager?.primary) {
                const idx = this.grids.findIndex(
                    g => g.userData?.sourcePath === this.selectionManager.primary
                );
                if (idx >= 0) this.cameraController.focusOnGrid(idx);
            } else if (this._tabIndex >= 0 && this._tabIndex < this.grids.length) {
                this.cameraController.focusOnGrid(this._tabIndex);
            }
        }, { description: 'Focus camera on selected file' });

        // F — fit all grids in view
        sm.register('f', () => {
            this.cameraController.focusOnGrids();
        }, { description: 'Fit all grids in view' });

        // M — toggle minimap
        sm.register('m', () => {
            if (this.minimapOverlay) {
                const isNow = this.minimapOverlay.toggle();
                this.toastUI?.show(`Minimap ${isNow ? 'shown' : 'hidden'}`, 'success');
            }
        }, { description: 'Toggle minimap' });

        // 1 — hierarchical layout
        sm.register('1', () => {
            this._switchLayout('hierarchical');
        }, { description: 'Switch to hierarchical layout' });

        // 2 — spiral layout
        sm.register('2', () => {
            this._switchLayout('spiral');
        }, { description: 'Switch to spiral layout' });

        // 3 — treemap layout
        sm.register('3', () => {
            this._switchLayout('treemap');
        }, { description: 'Switch to treemap layout' });

        // 4 — stack layout
        sm.register('4', () => {
            this._switchLayout('stack');
        }, { description: 'Switch to stack layout' });

        // R — return all files from stack workspace
        sm.register('r', () => {
            if (this.stackManager && this._activeLayout === 'stack') {
                this.stackManager.returnAll();
            }
        }, { description: 'Return all files from stack workspace' });

        // V — toggle dynamic speed (pan/zoom scales with camera distance)
        sm.register('v', () => {
            const on = this.cameraController.toggleDynamicSpeed();
            this.toastUI?.show(`Dynamic speed ${on ? 'ON' : 'OFF'}`, 'success');
        }, { description: 'Toggle dynamic camera speed' });

        // G — group selected files
        sm.register('g', () => {
            if (!this.spatialManager || !this.selectionManager) return;
            const selected = [...this.selectionManager.getSelected()];
            if (selected.length < 2) {
                this.toastUI?.show('Select 2+ files to group', 'warn');
                return;
            }
            const name = `group-${Date.now().toString(36)}`;
            this.spatialManager.createGroup(name);
            let added = 0;
            for (const path of selected) {
                const entries = this.registry.findByMeta('sourcePath', path);
                if (entries.length > 0) {
                    this.spatialManager.addToGroup(name, entries[0].id);
                    added++;
                }
            }
            this.toastUI?.show(`Grouped ${added} files as "${name}"`, 'success');
        }, { description: 'Group selected files' });

        // U — ungroup: dissolve the group of the primary selected file
        sm.register('u', () => {
            if (!this.spatialManager || !this.selectionManager) return;
            const primary = this.selectionManager.primary;
            if (!primary) {
                this.toastUI?.show('Select a grouped file first', 'warn');
                return;
            }
            const entries = this.registry.findByMeta('sourcePath', primary);
            if (entries.length === 0) return;
            const groupName = this.spatialManager.getGroupForGrid(entries[0].id);
            if (!groupName) {
                this.toastUI?.show('Selected file is not in a group', 'warn');
                return;
            }
            this.spatialManager.dissolveGroup(groupName);
            this.toastUI?.show(`Dissolved group "${groupName}"`, 'success');
        }, { description: 'Dissolve group of selected file' });
    }

    /**
     * Switch layout programmatically and update the UI select element.
     * @private
     * @param {string} mode - 'hierarchical'|'spiral'|'treemap'
     */
    _switchLayout(mode) {
        this._activeLayout = mode;
        this.relayoutGrids();
        this.cameraController.focusOnGrids();
        if (this.statePersistence) this.statePersistence.onLayoutChanged(mode);

        // Sync the settings panel select element
        const layoutSelect = document.getElementById('layout-mode');
        if (layoutSelect) layoutSelect.value = mode;
    }

    /**
     * Traverse files by Tab key — select next/prev file.
     * Tab order follows the grids array (matches file-load order / hierarchical).
     * @private
     * @param {number} delta - +1 for next, -1 for prev
     */
    _tabTraverse(delta) {
        if (this.grids.length === 0) return;

        // Start from current selection if possible
        if (this._tabIndex < 0 && this.selectionManager?.primary) {
            const idx = this.grids.findIndex(
                g => g.userData?.sourcePath === this.selectionManager.primary
            );
            if (idx >= 0) this._tabIndex = idx;
        }

        this._tabIndex = (this._tabIndex + delta + this.grids.length) % this.grids.length;

        const grid = this.grids[this._tabIndex];
        if (!grid) return;

        const sourcePath = grid.userData?.sourcePath;
        if (sourcePath && this.selectionManager) {
            this.selectionManager.select(sourcePath, { grids: this.grids });
        }
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

        // Destroy treemap label manager before switching layouts
        if (this.treemapLabelManager) {
            this.treemapLabelManager.destroy();
            this.treemapLabelManager = null;
        }

        // Tear down stack interaction if leaving stack layout
        if (this._activeLayout !== 'stack') {
            this._teardownStackInteraction();
        }

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
            this.sceneContext.stackManager = null;
        } else if (this._activeLayout === 'treemap') {
            if (!this.treemapManager) this.treemapManager = new TreemapLayoutManager();
            this.treemapManager.clear();
            this.treemapManager.layoutTreemap(this.grids);
            this.sceneContext.treemapManager = this.treemapManager;
            this.sceneContext.spiralManager = null;
            this.sceneContext.stackManager = null;

            // Phase 4: rebuild treemap label manager after re-layout
            this.treemapLabelManager = new TreemapLabelManager(
                this.scene,
                this.atlas,
                this.treemapManager,
                this.camera
            );
            this.treemapLabelManager.build().catch(err => {
                console.warn('[TreemapLabelManager] build error:', err);
            });
        } else if (this._activeLayout === 'stack') {
            if (!this.stackManager) this.stackManager = new StackLayoutManager();
            this.stackManager.clear();
            this.stackManager.layout(this.grids);
            this.sceneContext.stackManager = this.stackManager;
            this.sceneContext.spiralManager = null;
            this.sceneContext.treemapManager = null;
            this._initStackInteraction();
        } else {
            this.sceneContext.spiralManager = null;
            this.sceneContext.treemapManager = null;
            this.sceneContext.stackManager = null;
        }

        this._updateOverlays();

        // Refresh virtualizer bounds after layout change
        if (this.gridVirtualizer) {
            this.gridVirtualizer.refreshAllBounds();
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

    /**
     * Switch source mode and re-create the data provider.
     * @param {'github'|'local'} mode
     */
    _switchSourceMode(mode) {
        if (mode === this._sourceMode) return;
        this._sourceMode = mode;
        if (mode === 'local') {
            const rootInput = document.getElementById('local-root-input');
            this._localRoot = rootInput?.value?.trim() || '.';
            this.repoAdapter = new RemoteFileSystemProvider(this._wsBridge, {
                root: this._localRoot,
            });
        } else {
            this.repoAdapter = new RepositoryAdapter();
        }
        this.diffController.repoAdapter = this.repoAdapter;
        this.statePersistence?.onSourceModeChanged(mode, this._localRoot);
    }

    /**
     * Parse a comma-separated string of extensions/names and apply as the active filter.
     * @param {string} raw
     */
    _applyFileTypeWhitelist(raw) {
        const entries = raw.split(',').map(s => s.trim()).filter(Boolean);
        const exts = entries.filter(e => e.startsWith('.'));
        const names = entries.filter(e => !e.startsWith('.'));
        setTextExts(exts);
        setTextNames(names);
        this._pushFilterToRelay();
        this.statePersistence?.onFileTypesChanged(entries);
        this.toastUI.show(`File types updated (${exts.length} extensions, ${names.length} names)`, 'success');
    }

    /**
     * Push current JS-side filter to the Go relay via RPC.
     * No-op if WebSocket is not connected.
     */
    async _pushFilterToRelay() {
        if (!this._wsBridge?.connected) return;
        try {
            await this._wsBridge.rpcRequest('fs/setFilter', {
                exts: getTextExts(),
                names: getTextNames(),
            });
        } catch (err) {
            console.warn('[viewer] failed to push filter to relay:', err.message);
        }
    }

    async loadRepository(options = {}) {
        if (this._sourceMode === 'local') {
            const rootInput = document.getElementById('local-root-input');
            this._localRoot = rootInput?.value?.trim() || '.';
            return this._loadLocalRepository(options);
        }

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

        // Mark load in progress — if the page OOMs before onRepoLoaded(),
        // the next session detects the crash and skips auto-loading this repo
        if (this.statePersistence) this.statePersistence.onRepoLoadStarted();

        try {
            this.clearGrids();
            this.loading.show(`Fetching repository tree (${branch})...`);

            const treeResult = await this.repoAdapter.getRepositoryTree(owner, repo, branch);
            console.debug(`Found ${treeResult.tree.length} files`);

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
            console.debug(`[1] Parallel fetch: ${sourceFiles.length} files in ${fetchTime.toFixed(0)}ms`);

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
            console.debug(`[2] Grid creation: ${createdGrids.length} grids in ${gridTime.toFixed(0)}ms`);

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

            // Register grids in registry (sorted by source path for deterministic order)
            createdGrids.sort((a, b) =>
                (a.userData.sourcePath || '').localeCompare(b.userData.sourcePath || '')
            );
            for (const grid of createdGrids) {
                this.scene.add(grid);
                const sp = grid.userData.sourcePath || grid.name;
                this.registry.register(sp, grid, {
                    type: 'grid',
                    sourcePath: grid.userData.sourcePath,
                });
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
            } else if (this._activeLayout === 'stack') {
                this.stackManager = new StackLayoutManager();
                this.stackManager.layout(createdGrids);
                this.sceneContext.stackManager = this.stackManager;
                this._initStackInteraction();
            } else {
                this.sceneContext.spiralManager = null;
                this.sceneContext.treemapManager = null;
                this.sceneContext.stackManager = null;
            }

            const layoutTime = performance.now() - layoutStart;
            console.debug(`[2b] Layout: ${createdGrids.length} grids in ${layoutTime.toFixed(0)}ms`);

            // Phase 2c: Create visual overlays (backdrops + nameplates)
            const overlayStart = performance.now();
            this.loading.update(0.8, `Creating visual overlays...`);
            this._createOverlays();
            // Non-hierarchical: hide backdrops immediately
            if (this._activeLayout !== 'hierarchical') {
                this._updateOverlays();
            }
            const overlayTime = performance.now() - overlayStart;
            console.debug(`[2c] Overlays: ${overlayTime.toFixed(0)}ms`);

            // Phase 2d: Compute heatmap metrics → triggers CodeColorManager coloring
            const heatStart = performance.now();
            this.heatmapProvider = new HeatmapProvider(this.sceneContext, this.fileStateManager);
            this.heatmapProvider.computeMetrics();
            const heatTime = performance.now() - heatStart;
            console.debug(`[2d] Heatmap: ${heatTime.toFixed(0)}ms`);

            // Phase 3: UI updates - hierarchical file tree
            const uiStart = performance.now();
            this.updateFileTree();
            const uiTime = performance.now() - uiStart;
            console.debug(`[3] File tree UI: ${uiTime.toFixed(0)}ms`);

            // Phase 5: Force GPU sync (also computes matrixWorld for all grids)
            const gpuStart = performance.now();
            this.renderer.render(this.scene, this.camera);
            const gpuTime = performance.now() - gpuStart;
            console.debug(`[5] First render (GPU): ${gpuTime.toFixed(0)}ms`);

            // Phase 5b: Register grids with virtualizer (bounds are valid after first render)
            if (this.gridVirtualizer) {
                console.debug(`[5b] Registering ${createdGrids.length} grids with virtualizer...`);
                this.gridVirtualizer.registerAll(createdGrids);
                this.gridVirtualizer.update(); // immediately cull invisible grids
                const vs = this.gridVirtualizer.getStats();
                console.debug(`[5b] GridVirtualizer: ${vs.active}/${vs.total} grids active`);
            }

            const totalTime = performance.now() - totalStart;
            console.debug(`[TOTAL] All phases: ${totalTime.toFixed(0)}ms`);

            requestAnimationFrame(() => {
                const afterFrame = performance.now() - totalStart;
                console.debug(`[AFTER FRAME] Wall time: ${afterFrame.toFixed(0)}ms`);
            });

            // Re-cache atlas if ensureGraphemes added glyphs during file loading.
            if (this.atlas.uvMapVersion !== this._atlasVersionAtLoad) {
                const added = this.atlas.uvMapVersion - this._atlasVersionAtLoad;
                console.log(`[atlas] Re-caching: ${added} new grapheme batches discovered during load`);
                this._cacheAtlasToRelay();
                this._atlasVersionAtLoad = this.atlas.uvMapVersion;
            }

            this.loading.hide();

            console.debug('Adapter stats:', this.repoAdapter.getStats());
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
                const scale = stateController.get('ui.gridsScale', 1.0);
                if (scale != null && scale !== 1.0) {
                    for (const grid of this.grids) { grid.scale.setScalar(scale); }
                }
            }

        } catch (err) {
            console.error('Failed to load repository:', err);
            this.loading.hide();
            this.toastUI.show(`Error: ${err.message}`, 'error');
            // Clear loading flag so a caught error doesn't trigger crash detection
            if (this.statePersistence) {
                this.statePersistence.clearLoadingFlag();
            }
        } finally {
            this.isLoading = false;
            this.loadBtn.disabled = false;
        }
    }

    /**
     * Connect the WebSocket bridge and load the local repository once connected.
     * @param {Object} bridge - WebSocketBridge instance
     * @param {Object} [options] - passed to loadRepository
     * @private
     */
    async _connectAndLoadLocal(bridge, options = {}) {
        if (!bridge.connected) {
            bridge.connect();
            // Wait for the WebSocket to open (poll with short intervals)
            const deadline = Date.now() + 10000;
            while (!bridge.connected && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 100));
            }
            if (!bridge.connected) {
                this.toastUI.show('Failed to connect to relay. Start it with: glyph3d-cli serve --root <path>', 'error');
                return;
            }
        }
        // Sync file type filter to relay before loading
        await this._pushFilterToRelay();
        this.toastUI.show(`Loading local files from ${this._localRoot}...`, 'success');
        this.loadRepository(options);
    }

    /**
     * Load files from the local filesystem via the Go relay.
     * Mirrors loadRepository() but uses RemoteFileSystemProvider instead
     * of GitHub API calls. Grid creation and layout are identical.
     * @param {Object} [options]
     */
    async _loadLocalRepository(options = {}) {
        this.repoPath = `local:${this._localRoot}`;
        console.log(`Loading local repository: ${this._localRoot}`);
        this.isLoading = true;
        this.loadBtn.disabled = true;

        if (this.statePersistence) this.statePersistence.onRepoLoadStarted();

        try {
            this.clearGrids();
            this.loading.show('Fetching local file tree...');

            const treeResult = await this.repoAdapter.getRepositoryTree();
            console.debug(`Found ${treeResult.tree.length} entries`);

            const sourceFiles = this.repoAdapter.filterCodeFiles(treeResult);
            this.tree = sourceFiles;
            this.loading.update(0.1, `Loading ${sourceFiles.length} local files...`);

            const totalStart = performance.now();

            // Phase 1: Parallel fetch all files via relay
            const fetchStart = performance.now();
            this.loading.update(0.1, `Reading ${sourceFiles.length} files from disk...`);

            const paths = sourceFiles.map(f => f.path);
            const fileMap = await this.repoAdapter.getMultipleFiles(null, null, paths);

            const fetchTime = performance.now() - fetchStart;
            console.debug(`[1] Local fetch: ${sourceFiles.length} files in ${fetchTime.toFixed(0)}ms`);

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
            console.debug(`[2] Grid creation: ${createdGrids.length} grids in ${gridTime.toFixed(0)}ms`);

            // Phase 2b: Layout — identical to GitHub path
            const layoutStart = performance.now();
            this.loading.update(0.7, 'Computing layout...');

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

            createdGrids.sort((a, b) =>
                (a.userData.sourcePath || '').localeCompare(b.userData.sourcePath || '')
            );
            for (const grid of createdGrids) {
                this.scene.add(grid);
                const sp = grid.userData.sourcePath || grid.name;
                this.registry.register(sp, grid, {
                    type: 'grid',
                    sourcePath: grid.userData.sourcePath,
                });
            }

            this.hierarchicalManager.layoutHierarchy(createdGrids);

            if (this._activeLayout === 'spiral') {
                this.spiralManager = new SpiralLayoutManager();
                this.spiralManager.layoutSpiral(createdGrids);
                this.sceneContext.spiralManager = this.spiralManager;
            } else if (this._activeLayout === 'treemap') {
                this.treemapManager = new TreemapLayoutManager();
                this.treemapManager.layoutTreemap(createdGrids);
                this.sceneContext.treemapManager = this.treemapManager;
            } else if (this._activeLayout === 'stack') {
                this.stackManager = new StackLayoutManager();
                this.stackManager.layout(createdGrids);
                this.sceneContext.stackManager = this.stackManager;
                this._initStackInteraction();
            } else {
                this.sceneContext.spiralManager = null;
                this.sceneContext.treemapManager = null;
                this.sceneContext.stackManager = null;
            }

            const layoutTime = performance.now() - layoutStart;
            console.debug(`[2b] Layout: ${createdGrids.length} grids in ${layoutTime.toFixed(0)}ms`);

            // Phase 2c: Visual overlays
            const overlayStart = performance.now();
            this.loading.update(0.8, 'Creating visual overlays...');
            this._createOverlays();
            if (this._activeLayout !== 'hierarchical') {
                this._updateOverlays();
            }
            console.debug(`[2c] Overlays: ${(performance.now() - overlayStart).toFixed(0)}ms`);

            // Phase 2d: Heatmap
            const heatStart = performance.now();
            this.heatmapProvider = new HeatmapProvider(this.sceneContext, this.fileStateManager);
            this.heatmapProvider.computeMetrics();
            console.debug(`[2d] Heatmap: ${(performance.now() - heatStart).toFixed(0)}ms`);

            // Phase 3: UI
            this.updateFileTree();

            // Phase 5: First render
            this.renderer.render(this.scene, this.camera);

            // Phase 5b: Virtualizer
            if (this.gridVirtualizer) {
                this.gridVirtualizer.registerAll(createdGrids);
                this.gridVirtualizer.update();
                const vs = this.gridVirtualizer.getStats();
                console.debug(`[5b] GridVirtualizer: ${vs.active}/${vs.total} grids active`);
            }

            const totalTime = performance.now() - totalStart;
            console.debug(`[TOTAL] All phases: ${totalTime.toFixed(0)}ms`);

            // Re-cache atlas if ensureGraphemes added glyphs during file loading.
            // Next startup will load the full charset without any runtime packing.
            if (this.atlas.uvMapVersion !== this._atlasVersionAtLoad) {
                const added = this.atlas.uvMapVersion - this._atlasVersionAtLoad;
                console.log(`[atlas] Re-caching: ${added} new grapheme batches discovered during load`);
                this._cacheAtlasToRelay();
                this._atlasVersionAtLoad = this.atlas.uvMapVersion;
            }

            this.loading.hide();
            this.toastUI.show(`Loaded ${this.grids.length} files from ${this._localRoot}`, 'success');
            this.header.repoLabel.textContent = `local:${this._localRoot}`;
            this.drawer.openToTab('files');

            if (this.statePersistence) {
                this.statePersistence.onRepoLoaded(`local:${this._localRoot}`, 'disk');
                if (options.restoreCamera) {
                    this.statePersistence.restoreCamera();
                }
            }

            if (this.statePersistence) {
                const scale = stateController.get('ui.gridsScale', 1.0);
                if (scale != null && scale !== 1.0) {
                    for (const grid of this.grids) { grid.scale.setScalar(scale); }
                }
            }

        } catch (err) {
            console.error('Failed to load local repository:', err);
            this.loading.hide();
            this.toastUI.show(`Error: ${err.message}`, 'error');
            if (this.statePersistence) {
                this.statePersistence.clearLoadingFlag();
            }
        } finally {
            this.isLoading = false;
            this.loadBtn.disabled = false;
        }
    }

    async createGridForFileAsync(path, content) {
        const filename = path.split('/').pop();
        const grid = new CodeGrid(this.scene, this.atlas);
        // Wire picking before load so flush auto-registers
        if (this.pickingSystem) {
            grid.getCollection().setPickingSystem(this.pickingSystem);
        }
        await grid.loadFileAsync(filename, content);
        grid.userData.sourcePath = path;
        return grid;
    }

    clearGrids() {
        const removed = this.registry.unregisterByType('grid');
        for (const entry of removed) {
            if (this.gridVirtualizer) this.gridVirtualizer.unregister(entry.grid);
            entry.grid.dispose();
            this.scene.remove(entry.grid);
        }
        this.layoutManager.clear();
        if (this.hierarchicalManager) this.hierarchicalManager.clearAll();
        if (this.diffController) this.diffController.clearGrids();

        // Clear picking state (grid.dispose() unregisters from PickingSystem,
        // but the animate loop's cached hit must also be cleared)
        this._lastPickHit = null;
        this._lastPickSlot = -1;

        // Clean up visualization pipeline (clear data, keep managers alive)
        if (this.fileStateManager) this.fileStateManager.clear();
        if (this.codeColorManager) this.codeColorManager.resetAllColors();
        if (this.selectionManager) this.selectionManager.dispose();
        if (this.spatialManager) this.spatialManager.clear();
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
        if (this.treemapLabelManager) {
            this.treemapLabelManager.destroy();
            this.treemapLabelManager = null;
        }

        // Reset tab traversal index
        this._tabIndex = -1;

        // Reset minimap layout data
        if (this.minimapOverlay) {
            this.minimapOverlay.rebuildLayout();
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

            // Register diff grids in registry (sorted by source path)
            const diffGrids = result.grids.slice().sort((a, b) =>
                (a.userData?.sourcePath || '').localeCompare(b.userData?.sourcePath || '')
            );
            for (const grid of diffGrids) {
                const sp = grid.userData?.sourcePath || `diff:${diffGrids.indexOf(grid)}`;
                this.registry.register(sp, grid, {
                    type: 'grid',
                    sourcePath: sp,
                });
            }

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
                    if (this.selectionManager && node.path) {
                        this.selectionManager.select(node.path, { grids: this.grids });
                    }
                    // Close drawer after a beat so user sees the 3D view
                    if (this.drawerController) {
                        setTimeout(() => this.drawerController.setOpen(false), 150);
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
     * Create visual overlay managers (backdrops + nameplates + treemap labels)
     * @private
     */
    // ============ Stack Layout Interaction ============

    /**
     * Set up hover (fan-out) and click (pull-to-workspace) for stack layout.
     * Attaches mousemove + click listeners on the canvas.
     * @private
     */
    _initStackInteraction() {
        // Tear down any previous stack interaction listeners
        this._teardownStackInteraction();

        const THREE = this.THREE;
        const raycaster = new THREE.Raycaster();
        const mouse = new THREE.Vector2();

        /** @type {string|null} Currently hovered directory path */
        let hoveredDir = null;

        const getMouseNDC = (e) => {
            const rect = this.canvas.getBoundingClientRect();
            mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        };

        /**
         * Find which stack/grid the mouse is over by raycasting background meshes.
         * @returns {{ grid: CodeGrid|null, dirPath: string|null }}
         */
        const raycastStacks = (e) => {
            getMouseNDC(e);
            raycaster.setFromCamera(mouse, this.camera);

            const bgMeshes = [];
            for (const grid of this.grids) {
                if (grid._background && grid._background.visible) {
                    bgMeshes.push(grid._background);
                }
            }

            const hits = raycaster.intersectObjects(bgMeshes, false);
            if (hits.length === 0) return { grid: null, dirPath: null };

            const hitMesh = hits[0].object;
            const hitGrid = this.grids.find(g => g._background === hitMesh);
            if (!hitGrid) return { grid: null, dirPath: null };

            const dirPath = this.stackManager.getDirectoryForGrid(hitGrid);
            return { grid: hitGrid, dirPath };
        };

        // --- Mousemove: fan-out on hover ---
        this._stackMousemoveHandler = (e) => {
            if (!this.stackManager || this._activeLayout !== 'stack') return;

            const { dirPath } = raycastStacks(e);

            if (dirPath !== hoveredDir) {
                // Collapse old
                if (hoveredDir !== null) {
                    this.stackManager.collapse(hoveredDir);
                }
                // Fan new
                if (dirPath !== null) {
                    this.stackManager.fanOut(dirPath);
                }
                hoveredDir = dirPath;
            }
        };

        // --- Click: pull file to workspace or return ---
        this._stackClickHandler = (e) => {
            if (!this.stackManager || this._activeLayout !== 'stack') return;

            const { grid } = raycastStacks(e);
            if (!grid) return;

            if (this.stackManager.isPulled(grid)) {
                // Clicking a pulled file returns it
                this.stackManager.returnToStack(grid);
                this.toastUI?.show(`Returned ${grid.filename || 'file'} to stack`, 'info');
            } else {
                // Pull file to workspace
                this.stackManager.pullToWorkspace(grid);
                this.toastUI?.show(`Pulled ${grid.filename || 'file'} to workspace`, 'success');
            }
        };

        this.canvas.addEventListener('mousemove', this._stackMousemoveHandler);
        this.canvas.addEventListener('click', this._stackClickHandler);
    }

    /**
     * Remove stack interaction listeners.
     * @private
     */
    _teardownStackInteraction() {
        if (this._stackMousemoveHandler) {
            this.canvas.removeEventListener('mousemove', this._stackMousemoveHandler);
            this._stackMousemoveHandler = null;
        }
        if (this._stackClickHandler) {
            this.canvas.removeEventListener('click', this._stackClickHandler);
            this._stackClickHandler = null;
        }
    }

    _createOverlays() {
        if (!this.hierarchicalManager || !this.hierarchicalManager.root) return;

        // Dispose old managers if they exist
        if (this.backdropManager) this.backdropManager.destroy();
        if (this.nameplateManager) this.nameplateManager.destroy();

        // Dispose previous treemap label manager
        if (this.treemapLabelManager) {
            this.treemapLabelManager.destroy();
            this.treemapLabelManager = null;
        }

        // Non-hierarchical modes: no backdrops, no nameplates
        if (this._activeLayout === 'spiral' || this._activeLayout === 'treemap' || this._activeLayout === 'stack') {
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

            // Phase 4: treemap labels
            if (this._activeLayout === 'treemap' && this.treemapManager) {
                this.treemapLabelManager = new TreemapLabelManager(
                    this.scene,
                    this.atlas,
                    this.treemapManager,
                    this.camera
                );
                // Build asynchronously (flushAsync uses workers)
                this.treemapLabelManager.build().catch(err => {
                    console.warn('[TreemapLabelManager] build error:', err);
                });
            }

            // Rebuild minimap layout data after switching to non-hierarchical mode
            if (this.minimapOverlay) {
                this.minimapOverlay.rebuildLayout();
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

        // Rebuild minimap layout data for hierarchical mode
        if (this.minimapOverlay) {
            this.minimapOverlay.rebuildLayout();
        }
    }

    /**
     * Update visual overlays after re-layout
     * @private
     */
    _updateOverlays() {
        if (!this.hierarchicalManager || !this.hierarchicalManager.root) return;

        if (this._activeLayout === 'spiral' || this._activeLayout === 'treemap' || this._activeLayout === 'stack') {
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

        // Minimap: rebuild after any layout change
        if (this.minimapOverlay) {
            this.minimapOverlay.rebuildLayout();
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
        if (this.spatialAnimator) this.spatialAnimator.update(deltaTime);
        if (this.statePersistence) this.statePersistence.markCameraDirty();
        this.updateStats(deltaTime);

        // Hand gesture adapter — no-op when disabled
        if (this.handGestureAdapter) {
            this.handGestureAdapter.update(deltaTime);
        }

        // Update billboard-style nameplates to face camera
        if (this.nameplateManager) {
            this.nameplateManager.updateBillboards(this.camera);
        }

        // Phase 3: minimap — update viewport rectangle each frame
        if (this.minimapOverlay) {
            this.minimapOverlay.update();
        }

        // Phase 4: treemap labels LOD update
        if (this.treemapLabelManager) {
            this.treemapLabelManager.update();
        }

        // Frustum-based grid virtualization — add/remove grids from scene
        if (this.gridVirtualizer) {
            this.gridVirtualizer.update();
        }

        // Hide/show connection lines when endpoint grids enter/leave frustum
        if (this._commandRouter?.context?.connectionRenderer) {
            this._commandRouter.context.connectionRenderer.refreshVisibility();
        }

        // GPU picking pass (only runs when mouse has moved).
        // renderAndReadAsync wraps the sync WebGL2 readback in a Promise so
        // callers are forward-compatible with a future WebGPU async path.
        // A pending-result guard prevents overlapping async frames: if a pick
        // is already in flight we skip the new one and rely on the dirty flag
        // (_needsPick) being re-set on the next mousemove.
        if (this.pickingSystem && !this._pickPending) {
            this._pickPending = true;
            this.pickingSystem.renderAndReadAsync(this.camera, this.scene).then(pickId => {
                this._pickPending = false;
                const hit = this.pickingSystem?.resolve(pickId);

                // Clear previous highlight (guard against disposed renderer)
                if (this._lastPickHit?.renderer?.instanceMesh && this._lastPickSlot >= 0) {
                    this._lastPickHit.renderer.setGlyphHighlight(this._lastPickSlot, null);
                }

                if (hit) {
                    hit.renderer.setGlyphHighlight(hit.slotIndex, { r: 0.3, g: 0.3, b: 0.0 });
                    this._lastPickHit = hit;
                    this._lastPickSlot = hit.slotIndex;
                } else {
                    this._lastPickHit = null;
                    this._lastPickSlot = -1;
                }
            });
        }

        this.renderer.render(this.scene, this.camera);
    }
}

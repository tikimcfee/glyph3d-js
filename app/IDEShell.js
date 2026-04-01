/**
 * IDEShell -- Orchestrator for the VS Code-like IDE layout.
 *
 * Manages:
 * - Activity bar panel switching
 * - Sidebar collapse / resize
 * - Tab bar (open file tabs from SelectionManager state)
 * - Bottom panel collapse / resize / tab switching
 * - Status bar updates (FPS, glyph count, camera pos, WS status, layout mode)
 * - Keyboard shortcuts for panel toggling (Cmd+B sidebar, Cmd+J bottom panel)
 * - ResizeObserver on #editor-area so the Three.js renderer stays in sync
 *
 * The IDEShell does NOT own the GitHubRepoViewer -- it wraps around it.
 * GitHubRepoViewer still creates its own UI elements (loading overlay, toast,
 * drawer) via init(), but the IDE shell takes over layout duties by providing
 * the sidebar panels and status bar. The old Drawer, header, and FPS badge
 * are hidden so they do not conflict.
 */

import {
    repoPanelHTML,
    filesPanelHTML,
    settingsPanelHTML,
    statsPanelHTML,
    controlsPanelHTML,
} from './components/Drawer.js';
import { logCapturePanelHTML } from './components/LogCapturePanel.js';
import { diffPanelHTML } from './components/DiffPanel.js';
import { primaryMod } from '../src/services/utils/platform.js';

// Panel title labels keyed by data-panel attribute
const PANEL_TITLES = {
    'explorer':      'EXPLORER',
    'search':        'SEARCH',
    'repo':          'REPOSITORY',
    'diff':          'SOURCE CONTROL',
    'settings':      'SETTINGS',
    'groups':        'WINDOW GROUPS',
    'state':         'STATE INSPECTOR',
    'hand-tracking': 'HAND TRACKING',
    'controls':      'KEYBOARD SHORTCUTS',
};

export class IDEShell {
    constructor() {
        /** @type {import('./GitHubRepoViewer.js').GitHubRepoViewer|null} */
        this._viewer = null;

        // DOM references
        this._shell = document.getElementById('ide-shell');
        this._activityBtns = document.querySelectorAll('#activity-bar .activity-btn');
        this._sidebar = document.getElementById('sidebar');
        this._sidebarTitle = document.getElementById('sidebar-title');
        this._sidebarContent = document.getElementById('sidebar-content');
        this._sidebarCollapseBtn = document.getElementById('sidebar-collapse-btn');
        this._sidebarResize = document.getElementById('sidebar-resize');
        this._tabBar = document.getElementById('editor-tab-bar');
        this._tabBarEmpty = document.getElementById('tab-bar-empty');
        this._breadcrumbPath = document.getElementById('breadcrumb-path');
        this._editorArea = document.getElementById('editor-area');
        this._canvas = document.getElementById('canvas');
        this._bottomPanel = document.getElementById('bottom-panel');
        this._panelResize = document.getElementById('panel-resize');
        this._panelCloseBtn = document.getElementById('panel-close-btn');
        this._panelTabs = document.querySelectorAll('#panel-tab-bar .panel-tab');
        this._panelContent = document.getElementById('panel-content');

        // Status bar elements
        this._statusSource = document.getElementById('status-source');
        this._statusBranch = document.getElementById('status-branch');
        this._statusLayout = document.getElementById('status-layout');
        this._statusFilePath = document.getElementById('status-file-path');
        this._statusGlyphCount = document.getElementById('status-glyph-count');
        this._statusGridCount = document.getElementById('status-grid-count');
        this._statusCamera = document.getElementById('status-camera');
        this._statusFps = document.getElementById('status-fps');
        this._statusWs = document.getElementById('status-ws');

        // State
        this._activePanel = 'explorer';
        this._sidebarVisible = true;
        this._bottomPanelVisible = true;
        this._activePanelTab = 'output';
        this._openTabs = [];        // [{path, name}]
        this._activeTabPath = null;

        // Frame counting for status bar FPS
        this._frameCount = 0;
        this._fpsTime = 0;
        this._lastFps = 0;
        this._running = false;

        // Mobile detection
        this._mobileQuery = window.matchMedia('(max-width: 768px)');
        this._isMobile = this._mobileQuery.matches;
        this._mobileQuery.addEventListener('change', (e) => {
            this._isMobile = e.matches;
            if (this._isMobile && this._sidebarVisible) {
                this._collapseSidebar();
            }
        });

        // Wire events
        this._wireActivityBar();
        this._wireSidebar();
        this._wireSidebarBackdrop();
        this._wireBottomPanel();
        this._wireKeyboardShortcuts();
        this._wireResizeObserver();
        this._wireSidebarResize();
        this._wireStatusBarClicks();

        // On mobile: start with sidebar and bottom panel collapsed
        if (this._isMobile) {
            this._collapseSidebar();
            this._shell.classList.add('panel-collapsed');
            this._bottomPanelVisible = false;
        }
    }

    // ================================================================
    // Public API
    // ================================================================

    /**
     * Inject HTML content into sidebar panels.
     * Called before viewer.init() so DOM IDs exist when the viewer wires listeners.
     */
    injectPanelContent() {
        // Repo panel
        const repoPanel = document.getElementById('sp-repo');
        if (repoPanel) repoPanel.innerHTML = repoPanelHTML();

        // Settings panel
        const settingsPanel = document.getElementById('sp-settings');
        if (settingsPanel) settingsPanel.innerHTML = settingsPanelHTML();

        // Controls panel
        const controlsPanel = document.getElementById('sp-controls');
        if (controlsPanel) controlsPanel.innerHTML = controlsPanelHTML();

        // Diff panel
        const diffPanel = document.getElementById('sp-diff');
        if (diffPanel) diffPanel.innerHTML = diffPanelHTML();

        // Hand tracking panel -- extract from settings and put in its own panel
        const htPanel = document.getElementById('sp-hand-tracking');
        if (htPanel) {
            htPanel.innerHTML = `
                <div class="setting-group">
                    <div class="setting-label">
                        <span>Enable Hand Tracking</span>
                        <label class="setting-toggle">
                            <input type="checkbox" id="hand-tracking-enabled">
                            <span class="setting-toggle-track"></span>
                        </label>
                    </div>
                    <div class="setting-hint" id="hand-tracking-hint">
                        Mock source: move mouse to position hand, Space to pinch
                    </div>
                </div>
                <div class="setting-group" id="hand-tracking-source-group" style="display:none">
                    <div class="setting-label"><span>Source</span></div>
                    <select class="setting-select" id="hand-tracking-source">
                        <option value="mock">Mock (mouse)</option>
                        <option value="websocket">WebSocket</option>
                    </select>
                </div>
            `;
        }

        // Output panel (stats) in bottom panel
        const outputView = document.getElementById('pv-output');
        if (outputView) outputView.innerHTML = statsPanelHTML();

        // Console (log capture) in bottom panel
        const consoleView = document.getElementById('pv-console');
        if (consoleView) consoleView.innerHTML = logCapturePanelHTML();
    }

    /**
     * Attach the viewer instance so the IDE shell can read state from it.
     * @param {import('./GitHubRepoViewer.js').GitHubRepoViewer} viewer
     */
    attachViewer(viewer) {
        this._viewer = viewer;

        // Hide the old Drawer UI elements that the viewer creates
        this._hideOldUI();

        // Mirror the viewer's header.repoLabel to the IDE titlebar
        const titlebarRepoLabel = document.getElementById('titlebar-repo-label');
        if (titlebarRepoLabel) {
            // Observe changes to the viewer's header repoLabel (created in init)
            const mirrorRepoLabel = new MutationObserver(() => {
                const oldLabel = document.getElementById('header-repo-label');
                if (oldLabel) {
                    titlebarRepoLabel.textContent = oldLabel.textContent;
                    // Also update status bar branch
                    const text = oldLabel.textContent || '';
                    const branchMatch = text.match(/@(.+)$/);
                    if (branchMatch) {
                        this._statusBranch.innerHTML = `<span class="status-icon">&#9733;</span> ${branchMatch[1]}`;
                    }
                }
            });
            // Start observing once the header exists
            const checkHeader = setInterval(() => {
                const oldLabel = document.getElementById('header-repo-label');
                if (oldLabel) {
                    clearInterval(checkHeader);
                    mirrorRepoLabel.observe(oldLabel, { childList: true, characterData: true, subtree: true });
                }
            }, 200);
        }

        // Listen for selection events to update tab bar
        window.addEventListener('file-selected', (e) => {
            this._onFileSelected(e.detail);
        });

        // Listen for camera focus events to update breadcrumb
        window.addEventListener('camera-focus-changed', (e) => {
            this._onCameraFocusChanged(e.detail);
        });
    }

    /**
     * Start the IDE shell frame loop for status bar updates.
     * Call after viewer.init() completes.
     */
    start() {
        this._running = true;
        this._lastTime = performance.now();

        // Initialize log capture if available
        this._initLogCapture();

        // Initialize search panel wiring
        this._wireSearch();

        // Force initial resize
        this._onEditorResize();
    }

    // ================================================================
    // Activity Bar
    // ================================================================

    /** @private */
    _wireActivityBar() {
        this._activityBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const panel = btn.dataset.panel;
                if (panel === this._activePanel && this._sidebarVisible) {
                    // Same panel clicked while visible -- collapse sidebar
                    this._collapseSidebar();
                } else {
                    this._showSidebarPanel(panel);
                }
            });
        });
    }

    /** @private */
    _showSidebarPanel(panelId) {
        this._activePanel = panelId;

        // Update activity bar active state
        this._activityBtns.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.panel === panelId);
        });

        // Update sidebar title
        this._sidebarTitle.textContent = PANEL_TITLES[panelId] || panelId.toUpperCase();

        // Show the matching panel
        const panels = this._sidebarContent.querySelectorAll('.sidebar-panel');
        panels.forEach(p => {
            p.classList.toggle('active', p.id === `sp-${panelId}`);
        });

        // Ensure sidebar is visible
        if (!this._sidebarVisible) {
            this._expandSidebar();
        }
    }

    // ================================================================
    // Sidebar collapse / expand
    // ================================================================

    /** @private */
    _wireSidebar() {
        this._sidebarCollapseBtn.addEventListener('click', () => {
            this._collapseSidebar();
        });
    }

    /** @private Wire the backdrop element to dismiss sidebar on tap (mobile) */
    _wireSidebarBackdrop() {
        const backdrop = document.getElementById('sidebar-backdrop');
        if (backdrop) {
            backdrop.addEventListener('click', () => {
                this._collapseSidebar();
            });
        }
    }

    /** @private */
    _collapseSidebar() {
        this._sidebarVisible = false;
        this._shell.classList.add('sidebar-collapsed');
        this._activityBtns.forEach(btn => btn.classList.remove('active'));
        this._onEditorResize();
    }

    /** @private */
    _expandSidebar() {
        this._sidebarVisible = true;
        this._shell.classList.remove('sidebar-collapsed');
        this._onEditorResize();
    }

    // ================================================================
    // Sidebar resize (drag handle)
    // ================================================================

    /** @private */
    _wireSidebarResize() {
        let startX = 0;
        let startWidth = 0;

        const onMouseMove = (e) => {
            const delta = e.clientX - startX;
            const newWidth = Math.max(150, Math.min(600, startWidth + delta));
            document.documentElement.style.setProperty('--sidebar-width', `${newWidth}px`);
        };

        const onMouseUp = () => {
            this._sidebarResize.classList.remove('dragging');
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            this._onEditorResize();
        };

        this._sidebarResize.addEventListener('mousedown', (e) => {
            e.preventDefault();
            startX = e.clientX;
            startWidth = this._sidebar.getBoundingClientRect().width;
            this._sidebarResize.classList.add('dragging');
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }

    // ================================================================
    // Bottom Panel
    // ================================================================

    /** @private */
    _wireBottomPanel() {
        // Close button
        this._panelCloseBtn.addEventListener('click', () => {
            this._toggleBottomPanel();
        });

        // Panel tab switching
        this._panelTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const panelId = tab.dataset.panel;
                this._switchPanelTab(panelId);

                // If bottom panel was collapsed, expand it
                if (!this._bottomPanelVisible) {
                    this._toggleBottomPanel();
                }
            });
        });

        // Panel resize handle
        let startY = 0;
        let startHeight = 0;

        const onMouseMove = (e) => {
            const delta = startY - e.clientY;
            const newHeight = Math.max(80, Math.min(600, startHeight + delta));
            document.documentElement.style.setProperty('--panel-height', `${newHeight}px`);
        };

        const onMouseUp = () => {
            this._panelResize.classList.remove('dragging');
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            this._onEditorResize();
        };

        this._panelResize.addEventListener('mousedown', (e) => {
            e.preventDefault();
            startY = e.clientY;
            startHeight = this._bottomPanel.getBoundingClientRect().height;
            this._panelResize.classList.add('dragging');
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }

    /** @private */
    _wireStatusBarClicks() {
        // WS status → open WebSocket log tab
        if (this._statusWs) {
            this._statusWs.addEventListener('click', () => {
                this._switchPanelTab('ws-log');
                if (!this._bottomPanelVisible) this._toggleBottomPanel();
            });
        }
        // Panel toggle icon → toggle bottom panel
        const toggleBtn = document.getElementById('status-panel-toggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => this._toggleBottomPanel());
        }
    }

    /** @private */
    _toggleBottomPanel() {
        this._bottomPanelVisible = !this._bottomPanelVisible;
        this._shell.classList.toggle('panel-collapsed', !this._bottomPanelVisible);
        this._onEditorResize();
    }

    /** @private */
    _switchPanelTab(panelId) {
        this._activePanelTab = panelId;
        this._panelTabs.forEach(t => {
            t.classList.toggle('active', t.dataset.panel === panelId);
        });
        const views = this._panelContent.querySelectorAll('.panel-view');
        views.forEach(v => {
            v.classList.toggle('active', v.id === `pv-${panelId}`);
        });
    }

    // ================================================================
    // Tab Bar (open file tabs)
    // ================================================================

    /** @private */
    _onFileSelected(detail) {
        const { selected, primary } = detail;
        if (!selected || selected.length === 0) {
            // All deselected -- clear tabs
            this._openTabs = [];
            this._activeTabPath = null;
            this._renderTabs();
            this._breadcrumbPath.textContent = '';
            this._statusFilePath.textContent = '';
            return;
        }

        // Add any newly selected files to the tab list
        for (const path of selected) {
            if (!this._openTabs.find(t => t.path === path)) {
                const name = path.split('/').pop();
                this._openTabs.push({ path, name });
            }
        }

        // Set active tab to primary
        this._activeTabPath = primary || selected[0];
        this._renderTabs();

        // Update breadcrumb
        this._breadcrumbPath.textContent = this._activeTabPath || '';
        this._statusFilePath.textContent = this._activeTabPath || '';

        // On mobile, auto-dismiss sidebar overlay after file selection
        if (this._isMobile && this._sidebarVisible) {
            this._collapseSidebar();
        }
    }

    /** @private */
    _onCameraFocusChanged(detail) {
        if (!this._viewer) return;
        const { index } = detail;
        const grids = this._viewer.grids;
        if (index >= 0 && index < grids.length) {
            const path = grids[index].userData?.sourcePath || '';
            this._breadcrumbPath.textContent = path;
            this._statusFilePath.textContent = path;
        }
    }

    /** @private */
    _renderTabs() {
        // Clear existing tabs
        this._tabBar.innerHTML = '';

        if (this._openTabs.length === 0) {
            const hint = document.createElement('div');
            hint.id = 'tab-bar-empty';
            hint.className = 'tab-bar-hint';
            hint.textContent = 'No files open';
            this._tabBar.appendChild(hint);
            return;
        }

        for (const tab of this._openTabs) {
            const el = document.createElement('div');
            el.className = 'editor-tab';
            if (tab.path === this._activeTabPath) el.classList.add('active');
            el.dataset.path = tab.path;

            const ext = tab.name.includes('.') ? tab.name.split('.').pop().toUpperCase().slice(0, 2) : '--';

            el.innerHTML = `
                <span class="tab-icon">${ext}</span>
                <span class="tab-name">${tab.name}</span>
                <button class="tab-close">&times;</button>
            `;

            // Click tab to select/focus
            el.addEventListener('click', (e) => {
                if (e.target.classList.contains('tab-close')) return;
                this._activateTab(tab.path);
            });

            // Close button
            el.querySelector('.tab-close').addEventListener('click', (e) => {
                e.stopPropagation();
                this._closeTab(tab.path);
            });

            this._tabBar.appendChild(el);
        }
    }

    /** @private */
    _activateTab(path) {
        this._activeTabPath = path;
        this._renderTabs();

        // Focus camera on this file
        if (this._viewer) {
            const idx = this._viewer.grids.findIndex(
                g => g.userData?.sourcePath === path
            );
            if (idx >= 0) {
                this._viewer.cameraController.focusOnGrid(idx);
            }
            if (this._viewer.selectionManager) {
                this._viewer.selectionManager.select(path, { grids: this._viewer.grids });
            }
        }

        this._breadcrumbPath.textContent = path;
        this._statusFilePath.textContent = path;
    }

    /** @private */
    _closeTab(path) {
        this._openTabs = this._openTabs.filter(t => t.path !== path);

        // Deselect from selection manager
        if (this._viewer && this._viewer.selectionManager) {
            this._viewer.selectionManager.deselect(path, { grids: this._viewer.grids });
        }

        // If closed the active tab, switch to last remaining or clear
        if (path === this._activeTabPath) {
            if (this._openTabs.length > 0) {
                this._activeTabPath = this._openTabs[this._openTabs.length - 1].path;
            } else {
                this._activeTabPath = null;
                this._breadcrumbPath.textContent = '';
                this._statusFilePath.textContent = '';
            }
        }

        this._renderTabs();
    }

    // ================================================================
    // Keyboard Shortcuts for IDE shell panels
    // ================================================================

    /** @private */
    _wireKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Primary mod + B -- toggle sidebar (⌘ on Mac, Ctrl on Linux/Win)
            if (primaryMod(e) && e.key === 'b') {
                e.preventDefault();
                if (this._sidebarVisible) {
                    this._collapseSidebar();
                } else {
                    this._showSidebarPanel(this._activePanel);
                }
                return;
            }

            // Primary mod + J -- toggle bottom panel
            if (primaryMod(e) && e.key === 'j') {
                e.preventDefault();
                this._toggleBottomPanel();
                return;
            }

            // Primary mod + P -- command palette
            if (primaryMod(e) && e.key === 'p') {
                e.preventDefault();
                this._toggleCommandPalette();
                return;
            }
        });
    }

    // ================================================================
    // Command Palette
    // ================================================================

    /** @private */
    _toggleCommandPalette() {
        const palette = document.getElementById('command-palette');
        const input = document.getElementById('palette-input');
        const results = document.getElementById('palette-results');

        if (!palette) return;

        const isHidden = palette.classList.contains('hidden');
        palette.classList.toggle('hidden', !isHidden);

        if (isHidden) {
            // Opening -- focus and wire
            input.value = '';
            results.innerHTML = '';
            input.focus();

            // Remove old listeners by replacing the element trick
            const newInput = input.cloneNode(true);
            input.parentNode.replaceChild(newInput, input);

            newInput.addEventListener('input', () => {
                this._updatePaletteResults(newInput.value, results);
            });

            newInput.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    palette.classList.add('hidden');
                } else if (e.key === 'Enter') {
                    const active = results.querySelector('.palette-item.active');
                    if (active) {
                        active.click();
                        palette.classList.add('hidden');
                    }
                } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    this._navigatePaletteResults(results, e.key === 'ArrowDown' ? 1 : -1);
                }
            });

            newInput.focus();
        }
    }

    /** @private */
    _updatePaletteResults(query, container) {
        container.innerHTML = '';
        if (!query || !this._viewer) return;

        const q = query.toLowerCase();
        const grids = this._viewer.grids;
        const matches = grids
            .map((g, i) => ({ path: g.userData?.sourcePath || '', index: i }))
            .filter(m => m.path.toLowerCase().includes(q))
            .slice(0, 20);

        matches.forEach((m, idx) => {
            const item = document.createElement('div');
            item.className = 'palette-item' + (idx === 0 ? ' active' : '');
            const name = m.path.split('/').pop();
            const dir = m.path.split('/').slice(0, -1).join('/');
            item.innerHTML = `
                <span>${name}</span>
                <span class="palette-item-path">${dir}</span>
            `;
            item.addEventListener('click', () => {
                this._viewer.cameraController.focusOnGrid(m.index);
                if (this._viewer.selectionManager) {
                    this._viewer.selectionManager.select(m.path, { grids: this._viewer.grids });
                }
            });
            container.appendChild(item);
        });
    }

    /** @private */
    _navigatePaletteResults(container, direction) {
        const items = container.querySelectorAll('.palette-item');
        if (items.length === 0) return;

        let activeIdx = -1;
        items.forEach((item, i) => {
            if (item.classList.contains('active')) activeIdx = i;
        });

        items.forEach(item => item.classList.remove('active'));
        const newIdx = (activeIdx + direction + items.length) % items.length;
        items[newIdx].classList.add('active');
        items[newIdx].scrollIntoView({ block: 'nearest' });
    }

    // ================================================================
    // Search (sidebar)
    // ================================================================

    /** @private */
    _wireSearch() {
        const searchInput = document.getElementById('sidebar-search-input');
        const searchResults = document.getElementById('sidebar-search-results');
        if (!searchInput || !searchResults) return;

        searchInput.addEventListener('input', () => {
            const query = searchInput.value.trim().toLowerCase();
            searchResults.innerHTML = '';

            if (!query || !this._viewer) return;

            const grids = this._viewer.grids;
            const matches = grids
                .map((g, i) => ({ path: g.userData?.sourcePath || '', index: i }))
                .filter(m => m.path.toLowerCase().includes(query))
                .slice(0, 50);

            for (const m of matches) {
                const item = document.createElement('div');
                item.className = 'sidebar-result-item';
                item.textContent = m.path;
                item.addEventListener('click', () => {
                    this._viewer.cameraController.focusOnGrid(m.index);
                    if (this._viewer.selectionManager) {
                        this._viewer.selectionManager.select(m.path, { grids: this._viewer.grids });
                    }
                });
                searchResults.appendChild(item);
            }
        });
    }

    // ================================================================
    // ResizeObserver for editor area
    // ================================================================

    /** @private */
    _wireResizeObserver() {
        this._resizeObserver = new ResizeObserver(() => {
            this._onEditorResize();
        });
        this._resizeObserver.observe(this._editorArea);
    }

    /** @private */
    _onEditorResize() {
        if (!this._viewer || !this._viewer.renderer) return;

        const rect = this._editorArea.getBoundingClientRect();
        const width = Math.floor(rect.width);
        const height = Math.floor(rect.height);

        if (width <= 0 || height <= 0) return;

        const dpr = Math.min(window.devicePixelRatio, 2);
        this._viewer.renderer.setSize(width, height);
        this._viewer.renderer.setPixelRatio(dpr);

        if (this._viewer.camera) {
            this._viewer.camera.aspect = width / height;
            this._viewer.camera.updateProjectionMatrix();
        }
    }

    // ================================================================
    // Status Bar updates (called each frame via animate patch)
    // ================================================================

    /**
     * Update status bar. Called from the patched animate loop.
     * @param {number} deltaTime - seconds
     */
    updateStatusBar(deltaTime) {
        if (!this._viewer) return;

        // FPS
        this._frameCount++;
        this._fpsTime += deltaTime;
        if (this._fpsTime >= 1) {
            this._lastFps = this._frameCount;
            this._statusFps.textContent = `${this._frameCount} fps`;
            this._frameCount = 0;
            this._fpsTime = 0;
        }

        // Glyph count
        let totalGlyphs = 0;
        const grids = this._viewer.grids;
        for (const grid of grids) { totalGlyphs += grid.getGlyphCount(); }
        this._statusGlyphCount.textContent = `${totalGlyphs} glyphs`;

        // Grid count
        this._statusGridCount.textContent = `${grids.length} grids`;

        // Camera position
        if (this._viewer.camera) {
            const pos = this._viewer.camera.position;
            this._statusCamera.textContent = `${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}, ${pos.z.toFixed(0)}`;
        }

        // Source provider
        if (this._statusSource) {
            this._statusSource.textContent = this._viewer._sourceMode === 'local' ? 'Local' : 'GitHub';
        }

        // Layout mode
        if (this._viewer._activeLayout) {
            this._statusLayout.textContent = this._viewer._activeLayout;
        }

        // WebSocket status
        if (this._viewer._wsBridge) {
            const ws = this._viewer._wsBridge;
            if (ws.connected) {
                this._statusWs.textContent = 'WS: connected';
                this._statusWs.classList.add('connected');
            } else {
                this._statusWs.textContent = 'WS: disconnected';
                this._statusWs.classList.remove('connected');
            }
        }
    }

    // ================================================================
    // Hide old UI elements that conflict with IDE shell
    // ================================================================

    /** @private */
    _hideOldUI() {
        // The viewer's init() creates these dynamically. We use a MutationObserver
        // to catch them as they appear and hide them.
        const observer = new MutationObserver(() => {
            // Hide old drawer toggle, scrim, drawer
            const drawerToggle = document.getElementById('drawer-toggle');
            if (drawerToggle) drawerToggle.style.display = 'none';

            const drawerScrim = document.getElementById('drawer-scrim');
            if (drawerScrim) drawerScrim.style.display = 'none';

            const drawer = document.getElementById('drawer');
            if (drawer) drawer.style.display = 'none';

            // Hide old header
            const header = document.getElementById('header');
            if (header) header.style.display = 'none';

            // Hide old FPS badge
            const fpsBadge = document.getElementById('fps-badge');
            if (fpsBadge) fpsBadge.style.display = 'none';

            // Hide old state reset button
            const resetBtn = document.getElementById('state-reset-btn');
            if (resetBtn) resetBtn.style.display = 'none';

            // Hide old WebSocket status bar (created by WebSocketBridge)
            const wsStatus = document.getElementById('ws-status-bar');
            if (wsStatus) wsStatus.style.display = 'none';
        });

        observer.observe(document.body, { childList: true, subtree: true });

        // Also do an immediate pass
        setTimeout(() => {
            ['drawer-toggle', 'drawer-scrim', 'drawer', 'header',
             'fps-badge', 'state-reset-btn', 'ws-status-bar'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.style.display = 'none';
            });
        }, 100);
    }

    // ================================================================
    // Log capture panel wiring
    // ================================================================

    /** @private */
    _initLogCapture() {
        // The log capture panel was injected into pv-console.
        // initLogCapturePanel expects the panel element.
        // We import it dynamically to avoid circular deps.
        import('./components/LogCapturePanel.js').then(({ initLogCapturePanel }) => {
            const consoleView = document.getElementById('pv-console');
            if (consoleView) {
                initLogCapturePanel(consoleView);
            }
        });
    }

    // ================================================================
    // WebSocket log panel wiring
    // ================================================================

    /**
     * Wire the WebSocket tab to show command I/O from the WebSocketBridge.
     * Call after the command center is initialized.
     * @param {import('../src/services/orchestration/WebSocketBridge.js').default} bridge
     */
    initWsLog(bridge) {
        const panel = document.getElementById('pv-ws-log');
        if (!panel || !bridge) return;

        panel.innerHTML = '';
        panel.style.cssText = 'overflow-y: auto; font-family: var(--font-mono, monospace); font-size: 12px; padding: 4px 8px;';

        // Render existing log entries
        for (const entry of bridge.getLog()) {
            panel.appendChild(this._makeLogLine(entry));
        }

        // Stream new entries
        bridge.onLog((entry) => {
            panel.appendChild(this._makeLogLine(entry));
            // Auto-scroll to bottom
            panel.scrollTop = panel.scrollHeight;
        });
    }

    /** @private */
    _makeLogLine(entry) {
        const line = document.createElement('div');
        line.style.cssText = 'white-space: pre; padding: 1px 0; border-bottom: 1px solid var(--border, #ffffff10);';
        const arrow = entry.dir === 'in' ? '→' : '←';
        const color = entry.dir === 'in' ? '#6ca8f7' : '#7cc87c';
        line.innerHTML = `<span style="color:var(--text-secondary)">${entry.time}</span> <span style="color:${color}">${arrow} ${entry.client}</span> ${this._escapeHtml(entry.text)}`;
        return line;
    }

    /** @private */
    _escapeHtml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ================================================================
    // Expose sidebar panel switching for viewer compatibility
    // ================================================================

    /**
     * Open the sidebar to a specific panel.
     * Matches the DrawerController.openToTab() API so the viewer can call
     * `this.drawer.openToTab('files')` and it still works.
     * @param {string} tabId - panel id (e.g. 'files' maps to 'explorer')
     */
    openToTab(tabId) {
        // Map old drawer tab ids to sidebar panel ids
        const mapping = {
            'files':    'explorer',
            'repo':     'repo',
            'settings': 'settings',
            'stats':    'output',  // stats moved to bottom panel
            'controls': 'controls',
            'logs':     'console', // logs moved to bottom panel
            'diff':     'diff',
        };

        const panelId = mapping[tabId] || tabId;

        // Check if it's a bottom-panel tab
        if (panelId === 'output' || panelId === 'console' || panelId === 'ws-log') {
            this._switchPanelTab(panelId);
            if (!this._bottomPanelVisible) {
                this._toggleBottomPanel();
            }
        } else {
            this._showSidebarPanel(panelId);
        }
    }

    /**
     * switchTab compatibility -- same as openToTab but does not force sidebar open.
     * @param {string} tabId
     */
    switchTab(tabId) {
        this.openToTab(tabId);
    }

    /**
     * addPanel compatibility -- mirrors DrawerController.addPanel().
     * The viewer calls this for log-capture and diff panels.
     * In the IDE shell these are already created in the HTML, so we just
     * return the existing element.
     * @param {Object} panel - {id, label, html}
     * @returns {HTMLElement}
     */
    addPanel(panel) {
        // Map drawer panel IDs to sidebar or bottom-panel IDs
        const sidebarMapping = {
            'diff': 'sp-diff',
        };
        const bottomMapping = {
            'logs': 'pv-console',
        };

        let el = null;

        if (sidebarMapping[panel.id]) {
            el = document.getElementById(sidebarMapping[panel.id]);
            if (el && panel.html) el.innerHTML = panel.html;
        } else if (bottomMapping[panel.id]) {
            el = document.getElementById(bottomMapping[panel.id]);
            if (el && panel.html) el.innerHTML = panel.html;
        } else {
            // Generic: try sidebar panel first
            el = document.getElementById(`sp-${panel.id}`);
            if (!el) {
                // Create a new sidebar panel
                const panelEl = document.createElement('div');
                panelEl.className = 'sidebar-panel';
                panelEl.id = `sp-${panel.id}`;
                if (panel.html) panelEl.innerHTML = panel.html;
                this._sidebarContent.appendChild(panelEl);
                el = panelEl;
            } else if (panel.html) {
                el.innerHTML = panel.html;
            }
        }

        return el;
    }

    /**
     * getPanel compatibility -- mirrors DrawerController.getPanel().
     * @param {string} panelId
     * @returns {HTMLElement|null}
     */
    getPanel(panelId) {
        return document.getElementById(`sp-${panelId}`)
            || document.getElementById(`pv-${panelId}`)
            || document.getElementById(`panel-${panelId}`);
    }

    /**
     * setOpen compatibility -- no-op in IDE shell (sidebar is managed via activity bar).
     * @param {boolean} _open
     */
    setOpen(_open) {
        // No-op: the IDE shell does not have a drawer open/close concept
    }

    /**
     * isOpen getter for compatibility.
     * @returns {boolean}
     */
    get isOpen() {
        return this._sidebarVisible;
    }

    // ================================================================
    // Drawer-compatible API shim
    // ================================================================

    /**
     * Create a DrawerShim that can be assigned to viewer.drawer.
     * This allows the viewer code that calls this.drawer.openToTab(),
     * this.drawer.addPanel(), etc. to work unchanged.
     * @returns {IDEShell} - this (the methods are defined on IDEShell itself)
     */
    asDrawer() {
        return this;
    }
}

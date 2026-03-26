/**
 * Drawer Component
 *
 * Creates the slide-out drawer with tab bar and panel system.
 * Panels are registered by name; the drawer manages switching between them.
 */

/**
 * @typedef {Object} DrawerPanel
 * @property {string} id - Panel identifier (used as tab data-tab)
 * @property {string} label - Tab button label text
 * @property {string} html - Initial HTML content for the panel
 */

export class DrawerController {
    /**
     * Create the drawer UI
     * @param {HTMLElement} container - Parent element to append drawer into
     * @param {DrawerPanel[]} panels - Array of panel definitions
     */
    constructor(container, panels = []) {
        this.isOpen = false;
        this.panels = panels;

        // Create toggle button
        this.toggleBtn = document.createElement('button');
        this.toggleBtn.id = 'drawer-toggle';
        this.toggleBtn.setAttribute('aria-label', 'Toggle panel');
        this.toggleBtn.innerHTML = '&#9776;';
        container.appendChild(this.toggleBtn);

        // Create scrim
        this.scrim = document.createElement('div');
        this.scrim.id = 'drawer-scrim';
        container.appendChild(this.scrim);

        // Create drawer
        this.drawer = document.createElement('div');
        this.drawer.id = 'drawer';
        this.drawer.innerHTML = this._buildDrawerHTML(panels);
        container.appendChild(this.drawer);

        // Cache DOM references
        this.tabBtns = this.drawer.querySelectorAll('.tab-btn');
        this.tabPanels = this.drawer.querySelectorAll('.tab-panel');

        this._wireEvents();
    }

    /**
     * Build the inner HTML for the drawer
     * @param {DrawerPanel[]} panels
     * @returns {string}
     */
    _buildDrawerHTML(panels) {
        const tabButtons = panels.map((p, i) =>
            `<button class="tab-btn${i === 0 ? ' active' : ''}" data-tab="${p.id}">${p.label}</button>`
        ).join('');

        const tabPanels = panels.map((p, i) =>
            `<div class="tab-panel${i === 0 ? ' active' : ''}" id="panel-${p.id}">${p.html}</div>`
        ).join('');

        return `
            <div id="drawer-handle"></div>
            <div id="tab-bar">${tabButtons}</div>
            <div id="tab-panels">${tabPanels}</div>
        `;
    }

    /**
     * Wire up all drawer events
     */
    _wireEvents() {
        this.toggleBtn.addEventListener('click', () => this.setOpen(!this.isOpen));

        // Close on scrim click only when the scrim itself is directly clicked (not
        // a click that originated on the 3D canvas beneath it). The scrim uses
        // pointer-events:auto and sits above the canvas in z-order, so every canvas
        // mousedown reaches the scrim. We prevent this by checking: if the click
        // position is NOT within the drawer's own bounds, close only if it's NOT
        // within the canvas element's bounds.
        this.scrim.addEventListener('click', (e) => {
            const drawerRect = this.drawer.getBoundingClientRect();
            const overDrawer = (
                e.clientX >= drawerRect.left && e.clientX <= drawerRect.right &&
                e.clientY >= drawerRect.top  && e.clientY <= drawerRect.bottom
            );
            if (overDrawer) return;

            // If clicking in the 3D canvas area, do NOT close the drawer.
            // Let the user interact with the 3D view while the drawer stays open.
            const canvas = document.getElementById('canvas');
            if (canvas) {
                const canvasRect = canvas.getBoundingClientRect();
                const overCanvas = (
                    e.clientX >= canvasRect.left && e.clientX <= canvasRect.right &&
                    e.clientY >= canvasRect.top  && e.clientY <= canvasRect.bottom
                );
                if (overCanvas) return;
            }

            this.setOpen(false);
        });

        this.tabBtns.forEach(btn => {
            btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
        });

        // Swipe-to-dismiss on drawer handle
        const handle = this.drawer.querySelector('#drawer-handle');
        let startY = 0;
        handle.addEventListener('touchstart', (e) => {
            startY = e.touches[0].clientY;
        }, { passive: true });
        handle.addEventListener('touchend', (e) => {
            const dy = e.changedTouches[0].clientY - startY;
            if (dy > 40) this.setOpen(false);
        }, { passive: true });
    }

    /**
     * Open or close the drawer
     * @param {boolean} open
     */
    setOpen(open) {
        this.isOpen = open;
        this.drawer.classList.toggle('open', open);
        this.scrim.classList.toggle('visible', open);
        this.toggleBtn.classList.toggle('open', open);
        this.toggleBtn.innerHTML = open ? '&#10005;' : '&#9776;';
    }

    /**
     * Switch to a tab by id
     * @param {string} tabId
     */
    switchTab(tabId) {
        this.tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
        this.tabPanels.forEach(p => p.classList.toggle('active', p.id === `panel-${tabId}`));
    }

    /**
     * Open the drawer to a specific tab
     * @param {string} tabId
     */
    openToTab(tabId) {
        this.switchTab(tabId);
        this.setOpen(true);
    }

    /**
     * Get a panel element by id
     * @param {string} panelId
     * @returns {HTMLElement|null}
     */
    getPanel(panelId) {
        return this.drawer.querySelector(`#panel-${panelId}`);
    }

    /**
     * Add a new tab/panel dynamically after construction
     * @param {DrawerPanel} panel
     */
    addPanel(panel) {
        const tabBar = this.drawer.querySelector('#tab-bar');
        const tabPanels = this.drawer.querySelector('#tab-panels');

        const btn = document.createElement('button');
        btn.className = 'tab-btn';
        btn.dataset.tab = panel.id;
        btn.textContent = panel.label;
        btn.addEventListener('click', () => this.switchTab(panel.id));
        tabBar.appendChild(btn);

        const panelEl = document.createElement('div');
        panelEl.className = 'tab-panel';
        panelEl.id = `panel-${panel.id}`;
        panelEl.innerHTML = panel.html;
        tabPanels.appendChild(panelEl);

        // Update cached references
        this.tabBtns = this.drawer.querySelectorAll('.tab-btn');
        this.tabPanels = this.drawer.querySelectorAll('.tab-panel');

        this.panels.push(panel);

        return panelEl;
    }
}

// ============================================================
// Panel HTML Builders
// ============================================================

/** Repo panel: URL input, branch selection, load button */
export function repoPanelHTML() {
    return `
        <div class="repo-section">
            <label class="repo-label" for="repo-input">Repository URL</label>
            <input type="text" id="repo-input" class="repo-input"
                   placeholder="github.com/owner/repo"
                   value="https://github.com/tikimcfee/glyph3d-js">
        </div>
        <div class="repo-section">
            <label class="repo-label" for="branch-input">Branch</label>
            <div class="branch-input-row">
                <input type="text" id="branch-input" class="repo-input"
                       placeholder="main" value="">
                <button id="fetch-branches-btn" class="repo-btn-sm" title="Fetch available branches">&#8635;</button>
            </div>
            <div id="branch-list" class="branch-list hidden"></div>
            <div id="branch-status" class="branch-status"></div>
        </div>
        <div class="repo-section">
            <button id="load-btn" class="repo-btn">Load Repository</button>
        </div>
    `;
}

/** Files panel: file tree list */
export function filesPanelHTML() {
    return `
        <div id="tree-content">
            <div class="tree-empty">Load a repository to see files</div>
        </div>
    `;
}

/** Settings panel: sliders and action buttons */
export function settingsPanelHTML() {
    return `
        <div class="setting-group">
            <div class="setting-label">
                <span>All Grids Scale</span>
                <span class="setting-value" id="grids-scale-value">1.0</span>
            </div>
            <input type="range" class="setting-slider" id="grids-scale"
                   min="0.1" max="10" step="0.1" value="1.0">
        </div>
        <div class="setting-group">
            <div class="setting-label">
                <span>Layout Spacing</span>
                <span class="setting-value" id="layout-spacing-value">10</span>
            </div>
            <input type="range" class="setting-slider" id="layout-spacing"
                   min="0" max="500" step="10" value="10">
        </div>
        <div class="setting-group">
            <div class="setting-label">
                <span>Layout</span>
            </div>
            <select class="setting-select" id="layout-mode">
                <option value="hierarchical">Hierarchical</option>
                <option value="spiral">Spiral</option>
                <option value="treemap">Treemap</option>
            </select>
        </div>
        <div class="setting-group setting-section-header">Navigation</div>
        <div class="setting-group">
            <div class="setting-label">
                <span>Camera Speed</span>
                <span class="setting-value" id="cam-speed-value">5.0</span>
            </div>
            <input type="range" class="setting-slider" id="cam-speed"
                   min="1" max="50" step="1" value="5">
        </div>
        <div class="setting-group">
            <div class="setting-label">
                <span>Drag Sensitivity</span>
                <span class="setting-value" id="drag-sensitivity-value">1.0</span>
            </div>
            <input type="range" class="setting-slider" id="drag-sensitivity"
                   min="0.1" max="5" step="0.1" value="1.0">
        </div>
        <div class="setting-group">
            <div class="setting-label">
                <span>Scroll Sensitivity</span>
                <span class="setting-value" id="scroll-sensitivity-value">1.0</span>
            </div>
            <input type="range" class="setting-slider" id="scroll-sensitivity"
                   min="0.1" max="5" step="0.1" value="1.0">
        </div>
        <div class="setting-group">
            <button class="setting-btn" id="reset-camera">Reset Camera</button>
            <button class="setting-btn" id="fit-all">Fit All Grids</button>
        </div>
    `;
}

/** Stats panel: FPS, file count, grid count, etc. */
export function statsPanelHTML() {
    return `
        <div class="stat-row">
            <span class="stat-label">FPS</span>
            <span class="stat-value" id="stat-fps">--</span>
        </div>
        <div class="stat-row">
            <span class="stat-label">Files</span>
            <span class="stat-value" id="file-count">0</span>
        </div>
        <div class="stat-row">
            <span class="stat-label">Grids</span>
            <span class="stat-value" id="grid-count">0</span>
        </div>
        <div class="stat-row">
            <span class="stat-label">Glyphs</span>
            <span class="stat-value" id="glyph-count">0</span>
        </div>
        <div class="stat-row">
            <span class="stat-label">Camera</span>
            <span class="stat-value" id="camera-pos">0,0,0</span>
        </div>
    `;
}

/** Controls panel: keyboard/mouse/touch help */
export function controlsPanelHTML() {
    return `
        <div class="controls-section">
            <h4>Navigation</h4>
            <div class="control-row"><span class="key">W</span>Forward</div>
            <div class="control-row"><span class="key">S</span>Backward</div>
            <div class="control-row"><span class="key">A</span>Left</div>
            <div class="control-row"><span class="key">D</span>Right</div>
            <div class="control-row"><span class="key">Space</span>Up</div>
            <div class="control-row"><span class="key">Shift</span>Down</div>

            <h4>Selection</h4>
            <div class="control-row"><span class="key">Click</span>Select file</div>
            <div class="control-row"><span class="key">Ctrl+Click</span>Add to selection</div>
            <div class="control-row"><span class="key">Tab</span>Next file</div>
            <div class="control-row"><span class="key">Shift+Tab</span>Prev file</div>
            <div class="control-row"><span class="key">Enter</span>Focus on selection</div>
            <div class="control-row"><span class="key">Esc</span>Deselect all</div>

            <h4>View</h4>
            <div class="control-row"><span class="key">F</span>Fit all grids</div>
            <div class="control-row"><span class="key">M</span>Toggle minimap</div>
            <div class="control-row"><span class="key">1</span>Hierarchical layout</div>
            <div class="control-row"><span class="key">2</span>Spiral layout</div>
            <div class="control-row"><span class="key">3</span>Treemap layout</div>

            <h4>Mouse</h4>
            <div class="control-row"><span class="key">Drag</span>Pan (translate)</div>
            <div class="control-row"><span class="key">Scroll</span>Zoom in/out</div>
            <div class="control-row"><span class="key">Alt+Scroll</span>Zoom</div>

            <h4>Touch</h4>
            <div class="control-row"><span class="key">1 finger</span>Drag to pan</div>
            <div class="control-row"><span class="key">2 finger</span>Drag to pan</div>
            <div class="control-row"><span class="key">Pinch</span>Zoom in/out</div>
        </div>
    `;
}

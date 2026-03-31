/**
 * StatePersistence — localStorage persistence for the github-viewer app.
 *
 * Saves and restores: repo URL, branch, loaded flag, active layout,
 * settings slider values, and camera position.
 *
 * All data lives under a single localStorage key ('glyph3d-viewer-state').
 * Camera position is saved on a debounced timer (every 5s) and on
 * visibilitychange to avoid per-frame writes.
 */

import { setTextExts, setTextNames } from '../src/services/data/textFileFilter.js';

const STORAGE_KEY = 'glyph3d-viewer-state';
const CAMERA_STORAGE_KEY = 'glyph3d-camera-settings';
const SAVE_INTERVAL_MS = 5000;

/**
 * @typedef {Object} ViewerState
 * @property {string}  repoUrl       - Last successfully loaded repo URL
 * @property {string}  branch        - Last successfully loaded branch
 * @property {boolean} wasLoaded     - Whether a repo was loaded (triggers auto-load)
 * @property {string}  activeLayout  - 'hierarchical' | 'spiral' | 'treemap'
 * @property {number}  gridsScale    - Grids scale slider value
 * @property {number}  layoutSpacing - Layout spacing slider value
 * @property {{ x: number, y: number, z: number }} cameraPosition
 */

const DEFAULTS = {
    repoUrl: '',
    branch: '',
    wasLoaded: false,
    activeLayout: 'hierarchical',
    gridsScale: 1.0,
    layoutSpacing: 10,
    cameraPosition: null,
    sourceMode: 'github',
    localRoot: '.',
    customFileTypes: null,
};

/**
 * Load persisted state from localStorage.
 * @returns {ViewerState}
 */
export function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch { /* ignore corrupt data */ }
    return { ...DEFAULTS };
}

/**
 * Save state to localStorage (synchronous, cheap).
 * @param {ViewerState} state
 */
export function saveState(state) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch { /* quota exceeded or private mode — ignore */ }
}

/**
 * Clear all app localStorage keys and reload the page.
 */
export function resetAllAndReload() {
    try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(CAMERA_STORAGE_KEY);
    } catch { /* ignore */ }
    window.location.reload();
}

/**
 * StatePersistence controller — wires into the viewer to save/restore state.
 */
export class StatePersistence {
    /**
     * @param {Object} viewer - GitHubRepoViewer instance
     */
    constructor(viewer) {
        this.viewer = viewer;
        this.state = loadState();
        this._saveTimer = null;
        this._cameraDirty = false;
    }

    /**
     * Restore UI fields from persisted state. Call after UI is fully created.
     * @returns {boolean} true if auto-load should be triggered
     */
    restoreUI() {
        const { state, viewer } = this;

        // Crash detection: if loadingInProgress is still set, the previous load
        // caused an OOM/crash before onRepoLoaded() could clear it. Don't auto-load
        // the same repo — it will just crash again in a loop.
        if (state.loadingInProgress) {
            console.warn('[StatePersistence] Previous load crashed (OOM?). Clearing saved repo to break reload loop.');
            state.wasLoaded = false;
            state.loadingInProgress = false;
            this._save();
        }

        // Source mode & local root
        const sourceSelect = document.getElementById('source-select');
        const githubFields = document.getElementById('github-fields');
        const localFields = document.getElementById('local-fields');
        const localRootInput = document.getElementById('local-root-input');

        // URL param overrides saved state (allows ?source=local bookmarks)
        const params = new URLSearchParams(window.location.search);
        const urlSource = params.get('source');
        const effectiveMode = urlSource || state.sourceMode || 'github';

        if (sourceSelect) sourceSelect.value = effectiveMode;
        if (githubFields) githubFields.style.display = effectiveMode === 'github' ? '' : 'none';
        if (localFields) localFields.style.display = effectiveMode === 'local' ? '' : 'none';
        viewer._sourceMode = effectiveMode;

        if (state.localRoot && localRootInput) {
            localRootInput.value = state.localRoot;
            viewer._localRoot = state.localRoot;
        }

        // Repo URL
        if (state.repoUrl && viewer.repoInput) {
            viewer.repoInput.value = state.repoUrl;
        }

        // Branch
        if (state.branch && viewer.branchInput) {
            viewer.branchInput.value = state.branch;
        }

        // Layout mode
        const layoutSelect = document.getElementById('layout-mode');
        if (layoutSelect && state.activeLayout) {
            layoutSelect.value = state.activeLayout;
            viewer._activeLayout = state.activeLayout;
        }

        // Grids scale slider
        const gridsScaleSlider = document.getElementById('grids-scale');
        const gridsScaleValue = document.getElementById('grids-scale-value');
        if (gridsScaleSlider && state.gridsScale != null) {
            gridsScaleSlider.value = state.gridsScale;
            if (gridsScaleValue) gridsScaleValue.textContent = state.gridsScale.toFixed(1);
        }

        // Layout spacing slider
        const layoutSpacingSlider = document.getElementById('layout-spacing');
        const layoutSpacingValue = document.getElementById('layout-spacing-value');
        if (layoutSpacingSlider && state.layoutSpacing != null) {
            layoutSpacingSlider.value = state.layoutSpacing;
            if (layoutSpacingValue) layoutSpacingValue.textContent = state.layoutSpacing.toFixed(0);
            // Apply spacing to layout manager
            if (viewer.layoutManager) {
                viewer.layoutManager.spacing.horizontal = state.layoutSpacing;
                viewer.layoutManager.spacing.vertical = state.layoutSpacing * 0.8;
            }
        }

        // Restore custom file types
        if (state.customFileTypes != null) {
            const exts = state.customFileTypes.filter(e => e.startsWith('.'));
            const names = state.customFileTypes.filter(e => !e.startsWith('.'));
            setTextExts(exts);
            setTextNames(names);
        }

        // Don't auto-load if the saved repo type doesn't match the active source mode.
        const savedSource = state.repoUrl?.startsWith('local:') ? 'local' : 'github';
        if (effectiveMode !== savedSource) {
            return false;
        }

        return state.wasLoaded && !!state.repoUrl;
    }

    /**
     * Restore camera position. Call after grids are loaded.
     */
    restoreCamera() {
        const pos = this.state.cameraPosition;
        if (pos && this.viewer.camera) {
            this.viewer.camera.position.set(pos.x, pos.y, pos.z);
        }
    }

    /**
     * Record that a repo load is starting. If the page crashes/reloads before
     * onRepoLoaded() clears this flag, the next session will detect the crash
     * and skip auto-loading the same repo.
     */
    onRepoLoadStarted() {
        this.state.loadingInProgress = true;
        this._save();
    }

    /**
     * Record a successful repo load. Clears the crash-detection flag.
     * @param {string} repoUrl
     * @param {string} branch
     */
    onRepoLoaded(repoUrl, branch) {
        this.state.repoUrl = repoUrl;
        this.state.branch = branch;
        this.state.wasLoaded = true;
        this.state.loadingInProgress = false;
        this._save();
    }

    /**
     * Record a source mode change.
     * @param {'github'|'local'} mode
     * @param {string} [localRoot]
     */
    onSourceModeChanged(mode, localRoot) {
        this.state.sourceMode = mode;
        if (localRoot != null) this.state.localRoot = localRoot;
        this._save();
    }

    /**
     * Record a file type filter change.
     * @param {string[]|null} entries — combined list, or null to clear (use defaults)
     */
    onFileTypesChanged(entries) {
        this.state.customFileTypes = entries;
        this._save();
    }

    /**
     * Record a layout change.
     * @param {string} layout
     */
    onLayoutChanged(layout) {
        this.state.activeLayout = layout;
        this._save();
    }

    /**
     * Record a grids scale change.
     * @param {number} scale
     */
    onGridsScaleChanged(scale) {
        this.state.gridsScale = scale;
        this._debouncedSave();
    }

    /**
     * Record a layout spacing change.
     * @param {number} spacing
     */
    onLayoutSpacingChanged(spacing) {
        this.state.layoutSpacing = spacing;
        this._debouncedSave();
    }

    /**
     * Mark camera as dirty so next periodic save captures it.
     */
    markCameraDirty() {
        this._cameraDirty = true;
    }

    /**
     * Start periodic camera position saving. Call once after init.
     */
    startCameraSaving() {
        // Periodic save
        this._cameraInterval = setInterval(() => {
            this._saveCameraIfDirty();
        }, SAVE_INTERVAL_MS);

        // Save on tab hide / close
        this._onVisChange = () => {
            if (document.visibilityState === 'hidden') {
                this._saveCameraIfDirty();
            }
        };
        document.addEventListener('visibilitychange', this._onVisChange);
    }

    /**
     * Stop periodic saving. Call on dispose.
     */
    stopCameraSaving() {
        if (this._cameraInterval) {
            clearInterval(this._cameraInterval);
            this._cameraInterval = null;
        }
        if (this._onVisChange) {
            document.removeEventListener('visibilitychange', this._onVisChange);
            this._onVisChange = null;
        }
    }

    // ---- Private ----

    _saveCameraIfDirty() {
        if (!this._cameraDirty) return;
        this._cameraDirty = false;
        const pos = this.viewer.camera?.position;
        if (pos) {
            this.state.cameraPosition = { x: pos.x, y: pos.y, z: pos.z };
            this._save();
        }
    }

    _save() {
        saveState(this.state);
    }

    _debouncedSave() {
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => {
            this._save();
            this._saveTimer = null;
        }, 500);
    }
}

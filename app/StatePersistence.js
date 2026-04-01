/**
 * StatePersistence -- per-field localStorage persistence via StateController.
 *
 * Each on*Changed() writes only its field(s) via stateController.set().
 * restoreUI() reads each field individually via stateController.get(key, default).
 * No in-memory blob. No ghost-state. Camera dirty-check compares positions.
 */

import { setTextExts, setTextNames } from '../src/services/data/textFileFilter.js';
import { stateController } from '../src/services/state/StateController.js';

const SAVE_INTERVAL_MS = 5000;

// Default values -- exported so the StatePanel can offer "reset to defaults"
export const STATE_DEFAULTS = {
    'repo.url':              '',
    'repo.branch':           '',
    'repo.wasLoaded':        false,
    'repo.loadingInProgress': false,
    'source.mode':           'github',
    'source.localRoot':      '.',
    'source.customFileTypes': null,
    'ui.layout':             'hierarchical',
    'ui.gridsScale':         1.0,
    'ui.layoutSpacing':      10,
    'ui.wsEnabled':          false,
    'camera.position':       null,
    'groups':                null,
};

/**
 * Clear all g3d.* keys and reload the page.
 */
export function resetAllAndReload() {
    stateController.clearAll();
    window.location.reload();
}

/**
 * StatePersistence controller -- wires into the viewer to save/restore state.
 */
export class StatePersistence {
    /**
     * @param {Object} viewer - GitHubRepoViewer instance
     */
    constructor(viewer) {
        this.viewer = viewer;
        this._cameraDirty = false;
        this._lastSavedCameraPos = null;  // for real dirty check
        this._cameraInterval = null;
        this._onVisChange = null;
        this._saveTimer = null;
    }

    /**
     * Restore UI fields from persisted state. Call after UI is fully created.
     * @returns {boolean} true if auto-load should be triggered
     */
    restoreUI() {
        const viewer = this.viewer;

        // Crash detection: if loadingInProgress is still set, the previous load
        // caused an OOM/crash before onRepoLoaded() could clear it.
        if (stateController.get('repo.loadingInProgress', false)) {
            console.warn('[StatePersistence] Previous load crashed (OOM?). Clearing saved repo to break reload loop.');
            stateController.set('repo.wasLoaded', false);
            stateController.set('repo.loadingInProgress', false);
        }

        // Source mode & local root
        const sourceSelect = document.getElementById('source-select');
        const githubFields = document.getElementById('github-fields');
        const localFields = document.getElementById('local-fields');
        const localRootInput = document.getElementById('local-root-input');

        // URL param overrides saved state (allows ?source=local bookmarks)
        const params = new URLSearchParams(window.location.search);
        const urlSource = params.get('source');
        const savedMode = stateController.get('source.mode', 'github');
        const effectiveMode = urlSource || savedMode;

        if (sourceSelect) sourceSelect.value = effectiveMode;
        if (githubFields) githubFields.style.display = effectiveMode === 'github' ? '' : 'none';
        if (localFields) localFields.style.display = effectiveMode === 'local' ? '' : 'none';
        viewer._sourceMode = effectiveMode;

        const localRoot = stateController.get('source.localRoot', '.');
        if (localRoot && localRootInput) {
            localRootInput.value = localRoot;
            viewer._localRoot = localRoot;
        }

        // Repo URL
        const repoUrl = stateController.get('repo.url', '');
        if (repoUrl && viewer.repoInput) {
            viewer.repoInput.value = repoUrl;
        }

        // Branch
        const branch = stateController.get('repo.branch', '');
        if (branch && viewer.branchInput) {
            viewer.branchInput.value = branch;
        }

        // Layout mode
        const activeLayout = stateController.get('ui.layout', 'hierarchical');
        const layoutSelect = document.getElementById('layout-mode');
        if (layoutSelect && activeLayout) {
            layoutSelect.value = activeLayout;
            viewer._activeLayout = activeLayout;
        }

        // Grids scale slider
        const gridsScale = stateController.get('ui.gridsScale', 1.0);
        const gridsScaleSlider = document.getElementById('grids-scale');
        const gridsScaleValue = document.getElementById('grids-scale-value');
        if (gridsScaleSlider && gridsScale != null) {
            gridsScaleSlider.value = gridsScale;
            if (gridsScaleValue) gridsScaleValue.textContent = gridsScale.toFixed(1);
        }

        // Layout spacing slider
        const layoutSpacing = stateController.get('ui.layoutSpacing', 10);
        const layoutSpacingSlider = document.getElementById('layout-spacing');
        const layoutSpacingValue = document.getElementById('layout-spacing-value');
        if (layoutSpacingSlider && layoutSpacing != null) {
            layoutSpacingSlider.value = layoutSpacing;
            if (layoutSpacingValue) layoutSpacingValue.textContent = layoutSpacing.toFixed(0);
            // Apply spacing to layout manager
            if (viewer.layoutManager) {
                viewer.layoutManager.spacing.horizontal = layoutSpacing;
                viewer.layoutManager.spacing.vertical = layoutSpacing * 0.8;
            }
        }

        // Restore custom file types
        const customFileTypes = stateController.get('source.customFileTypes', null);
        if (customFileTypes != null) {
            const exts = customFileTypes.filter(e => e.startsWith('.'));
            const names = customFileTypes.filter(e => !e.startsWith('.'));
            setTextExts(exts);
            setTextNames(names);
        }

        // Don't auto-load if the saved repo type doesn't match the active source mode.
        const savedSource = repoUrl?.startsWith('local:') ? 'local' : 'github';
        if (effectiveMode !== savedSource) {
            return false;
        }

        const wasLoaded = stateController.get('repo.wasLoaded', false);
        return wasLoaded && !!repoUrl;
    }

    /**
     * Restore camera position and window groups. Call after grids are loaded.
     */
    restoreCamera() {
        const pos = stateController.get('camera.position', null);
        if (pos && this.viewer.camera) {
            this.viewer.camera.position.set(pos.x, pos.y, pos.z);
        }
        // Restore window groups (must run after grids are registered)
        const groups = stateController.get('groups', null);
        if (groups && this.viewer.spatialManager) {
            this.viewer.spatialManager.deserialize(groups);
        }
    }

    /**
     * Record that a repo load is starting. If the page crashes/reloads before
     * onRepoLoaded() clears this flag, the next session will detect the crash.
     */
    onRepoLoadStarted() {
        stateController.set('repo.loadingInProgress', true);
    }

    /**
     * Record a successful repo load. Clears the crash-detection flag.
     * @param {string} repoUrl
     * @param {string} branch
     */
    onRepoLoaded(repoUrl, branch) {
        stateController.set('repo.url', repoUrl);
        stateController.set('repo.branch', branch);
        stateController.set('repo.wasLoaded', true);
        stateController.set('repo.loadingInProgress', false);
    }

    /**
     * Record a source mode change.
     * @param {'github'|'local'} mode
     * @param {string} [localRoot]
     */
    onSourceModeChanged(mode, localRoot) {
        stateController.set('source.mode', mode);
        if (localRoot != null) stateController.set('source.localRoot', localRoot);
    }

    /**
     * Record a file type filter change.
     * @param {string[]|null} entries -- combined list, or null to clear
     */
    onFileTypesChanged(entries) {
        stateController.set('source.customFileTypes', entries);
    }

    /**
     * Record a layout change.
     * @param {string} layout
     */
    onLayoutChanged(layout) {
        stateController.set('ui.layout', layout);
    }

    /**
     * Record a grids scale change.
     * @param {number} scale
     */
    onGridsScaleChanged(scale) {
        stateController.set('ui.gridsScale', scale);
    }

    /**
     * Record a layout spacing change.
     * @param {number} spacing
     */
    onLayoutSpacingChanged(spacing) {
        stateController.set('ui.layoutSpacing', spacing);
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

    /**
     * Clear the crash-detection loading flag.
     * Called from external error handlers.
     */
    clearLoadingFlag() {
        stateController.set('repo.loadingInProgress', false);
    }

    /**
     * Read a persisted value by key (convenience proxy to stateController).
     * @param {string} key
     * @param {*} fallback
     * @returns {*}
     */
    getState(key, fallback) {
        return stateController.get(key, fallback);
    }

    // ---- Private ----

    _saveCameraIfDirty() {
        if (!this._cameraDirty) return;
        this._cameraDirty = false;

        const pos = this.viewer.camera?.position;
        if (!pos) return;

        // Real dirty check: compare to last saved position
        const newPos = { x: pos.x, y: pos.y, z: pos.z };
        const last = this._lastSavedCameraPos;
        if (last && last.x === newPos.x && last.y === newPos.y && last.z === newPos.z) {
            return; // no actual movement -- skip write
        }

        this._lastSavedCameraPos = newPos;
        stateController.set('camera.position', newPos);
    }

    /** Call explicitly to persist current group state. */
    saveGroups() {
        stateController.set('groups', this.viewer.spatialManager?.serialize() ?? null);
    }
}

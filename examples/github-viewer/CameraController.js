/**
 * CameraController — extracted camera subsystem
 *
 * Translation-first navigation: click-drag pans, scroll zooms,
 * WASD translates in camera-relative directions.
 *
 * All user-adjustable settings are persisted to localStorage under
 * the 'glyph3d-camera-settings' key.
 *
 * Receives a SceneContext for shared references (camera, canvas, etc.).
 * Emits 'camera-focus-changed' window events for tree UI sync.
 */

const STORAGE_KEY = 'glyph3d-camera-settings';

const DEFAULTS = {
    cameraSpeed: 100,
    dragSensitivity: 1.0,
    scrollSensitivity: 1.0,
    invertDragX: false,
    invertDragY: false,
    invertScroll: false,
};

function loadSettings() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    return { ...DEFAULTS };
}

function saveSettings(settings) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch { /* ignore */ }
}

export class CameraController {
    /**
     * @param {SceneContext} ctx
     */
    constructor(ctx) {
        this.ctx = ctx;
        this.THREE = ctx.THREE;

        // Load persisted settings
        this.settings = loadSettings();

        // Movement state
        this.keys = {};
        this.cameraSpeed = this.settings.cameraSpeed;

        // Drag state (translation, not rotation)
        this.isDragging = false;
        this._dragPrevX = 0;
        this._dragPrevY = 0;

        // Rotation state (only set programmatically via focus methods)
        this.pitch = 0;
        this.yaw = 0;

        // Bound listener refs for cleanup
        this._onKeyDown = null;
        this._onKeyUp = null;
        this._onMouseDown = null;
        this._onMouseUp = null;
        this._onMouseMove = null;
        this._onWheel = null;
        this._onResize = null;
        this._onSpeedChange = null;
        this._onDragSensChange = null;
        this._onScrollSensChange = null;
        this._onReset = null;
        this._onFitAll = null;
    }

    /**
     * Bind all event listeners. Call once after construction.
     */
    setupEventListeners() {
        const camera = this.ctx.camera;
        const canvas = this.ctx.canvas;

        // --- Keyboard ---
        this._onKeyDown = (e) => { this.keys[e.code] = true; };
        this._onKeyUp = (e) => { this.keys[e.code] = false; };
        document.addEventListener('keydown', this._onKeyDown);
        document.addEventListener('keyup', this._onKeyUp);

        // --- Click-drag to pan (translation) ---
        this._onMouseDown = (e) => {
            if (e.target === canvas || canvas.contains(e.target)) {
                this.isDragging = true;
                this._dragPrevX = e.clientX;
                this._dragPrevY = e.clientY;
                canvas.style.cursor = 'grabbing';
            }
        };
        this._onMouseUp = () => {
            this.isDragging = false;
            canvas.style.cursor = 'grab';
        };
        this._onMouseMove = (e) => {
            if (!this.isDragging) return;

            const dx = e.clientX - this._dragPrevX;
            const dy = e.clientY - this._dragPrevY;
            this._dragPrevX = e.clientX;
            this._dragPrevY = e.clientY;

            this._applyDragTranslation(dx, dy);
        };

        canvas.addEventListener('mousedown', this._onMouseDown);
        document.addEventListener('mouseup', this._onMouseUp);
        document.addEventListener('mousemove', this._onMouseMove);

        // --- Scroll to zoom ---
        this._onWheel = (e) => {
            if (e.target === canvas || canvas.contains(e.target)) {
                e.preventDefault();
                const delta = this.settings.invertScroll ? e.deltaY : -e.deltaY;
                const zoomAmount = delta * this.settings.scrollSensitivity * 0.5;
                const forward = new this.THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
                camera.position.addScaledVector(forward, zoomAmount);
            }
        };
        canvas.addEventListener('wheel', this._onWheel, { passive: false });

        // Set default cursor
        canvas.style.cursor = 'grab';

        // --- Window resize (camera-side: aspect ratio + projection) ---
        this._onResize = () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
        };
        window.addEventListener('resize', this._onResize);

        // --- Speed slider ---
        this._bindSlider('cam-speed', 'cam-speed-value', (val) => {
            this.setSpeed(val);
        });

        // --- Drag sensitivity slider ---
        this._bindSlider('drag-sensitivity', 'drag-sensitivity-value', (val) => {
            this.settings.dragSensitivity = val;
            this._persistSettings();
        });

        // --- Scroll sensitivity slider ---
        this._bindSlider('scroll-sensitivity', 'scroll-sensitivity-value', (val) => {
            this.settings.scrollSensitivity = val;
            this._persistSettings();
        });

        // --- Reset button ---
        const resetBtn = document.getElementById('reset-camera');
        if (resetBtn) {
            this._onReset = () => this.reset();
            resetBtn.addEventListener('click', this._onReset);
            this._resetBtn = resetBtn;
        }

        // --- Fit all button ---
        const fitAllBtn = document.getElementById('fit-all');
        if (fitAllBtn) {
            this._onFitAll = () => this.focusOnGrids();
            fitAllBtn.addEventListener('click', this._onFitAll);
            this._fitAllBtn = fitAllBtn;
        }

        // Restore slider UI from persisted settings
        this._restoreUI();
    }

    /**
     * Apply drag translation: maps screen-pixel deltas to camera-relative
     * world-space panning. Scale factor accounts for camera distance so
     * dragging feels proportional at any zoom level.
     * @param {number} dx - screen pixels horizontal
     * @param {number} dy - screen pixels vertical
     */
    _applyDragTranslation(dx, dy) {
        const THREE = this.THREE;
        const camera = this.ctx.camera;
        const sens = this.settings.dragSensitivity;

        // Scale panning by distance from origin for consistent feel across zoom levels
        const dist = camera.position.length() || 1;
        const fovFactor = 2 * Math.tan((camera.fov * Math.PI / 180) / 2);
        const pixelScale = (dist * fovFactor) / window.innerHeight;

        const moveX = (this.settings.invertDragX ? dx : -dx) * pixelScale * sens;
        const moveY = (this.settings.invertDragY ? -dy : dy) * pixelScale * sens;

        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);

        camera.position.addScaledVector(right, moveX);
        camera.position.addScaledVector(up, moveY);
    }

    /**
     * Bind a slider element to a callback, with value label sync.
     * @private
     */
    _bindSlider(sliderId, labelId, onChange) {
        const slider = document.getElementById(sliderId);
        const label = document.getElementById(labelId);
        if (!slider) return;
        const handler = (e) => {
            const val = parseFloat(e.target.value);
            if (label) label.textContent = val.toFixed(1);
            onChange(val);
        };
        slider.addEventListener('input', handler);
        this['_slider_' + sliderId] = { slider, handler };
    }

    /**
     * Restore UI elements from persisted settings.
     * @private
     */
    _restoreUI() {
        const s = this.settings;

        // Speed slider: stored value is raw cameraSpeed, slider is speed/20
        const speedSlider = document.getElementById('cam-speed');
        const speedLabel = document.getElementById('cam-speed-value');
        if (speedSlider) {
            const sliderVal = s.cameraSpeed / 20;
            speedSlider.value = sliderVal;
            if (speedLabel) speedLabel.textContent = sliderVal.toFixed(1);
        }

        const dragSlider = document.getElementById('drag-sensitivity');
        const dragLabel = document.getElementById('drag-sensitivity-value');
        if (dragSlider) {
            dragSlider.value = s.dragSensitivity;
            if (dragLabel) dragLabel.textContent = s.dragSensitivity.toFixed(1);
        }

        const scrollSlider = document.getElementById('scroll-sensitivity');
        const scrollLabel = document.getElementById('scroll-sensitivity-value');
        if (scrollSlider) {
            scrollSlider.value = s.scrollSensitivity;
            if (scrollLabel) scrollLabel.textContent = s.scrollSensitivity.toFixed(1);
        }
    }

    /**
     * Save current settings to localStorage.
     * @private
     */
    _persistSettings() {
        saveSettings(this.settings);
    }

    /**
     * Remove all event listeners. Called by dispose().
     */
    teardownEventListeners() {
        document.removeEventListener('keydown', this._onKeyDown);
        document.removeEventListener('keyup', this._onKeyUp);

        if (this.ctx.canvas) {
            this.ctx.canvas.removeEventListener('mousedown', this._onMouseDown);
            this.ctx.canvas.removeEventListener('wheel', this._onWheel);
        }
        document.removeEventListener('mouseup', this._onMouseUp);
        document.removeEventListener('mousemove', this._onMouseMove);
        window.removeEventListener('resize', this._onResize);

        // Cleanup bound sliders
        for (const key of Object.keys(this)) {
            if (key.startsWith('_slider_') && this[key]) {
                this[key].slider.removeEventListener('input', this[key].handler);
            }
        }

        if (this._resetBtn && this._onReset) {
            this._resetBtn.removeEventListener('click', this._onReset);
        }
        if (this._fitAllBtn && this._onFitAll) {
            this._fitAllBtn.removeEventListener('click', this._onFitAll);
        }

        // Restore cursor
        if (this.ctx.canvas) {
            this.ctx.canvas.style.cursor = '';
        }
    }

    // ============ Per-frame update ============

    /**
     * Update camera position from WASD + rotation from pitch/yaw.
     * Call this once per frame from the animation loop.
     * @param {number} deltaTime - seconds since last frame
     */
    update(deltaTime) {
        const THREE = this.THREE;
        const camera = this.ctx.camera;
        const moveDir = new THREE.Vector3();

        if (this.keys['KeyW']) moveDir.z -= 1;
        if (this.keys['KeyS']) moveDir.z += 1;
        if (this.keys['KeyA']) moveDir.x -= 1;
        if (this.keys['KeyD']) moveDir.x += 1;
        if (this.keys['Space']) moveDir.y += 1;
        if (this.keys['ShiftLeft'] || this.keys['ShiftRight']) moveDir.y -= 1;

        if (moveDir.length() > 0) {
            moveDir.normalize();
            moveDir.applyQuaternion(camera.quaternion);
            moveDir.multiplyScalar(this.cameraSpeed * deltaTime);
            camera.position.add(moveDir);
        }

        const quaternion = new THREE.Quaternion();
        quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
        camera.quaternion.copy(quaternion);
    }

    // ============ Focus methods ============

    /**
     * Focus camera on a file for reading.
     *
     * Sets camera to a consistent reading distance where ~35 lines of text
     * fill the viewport — like opening a file in an editor. The distance
     * is derived from actual line spacing, not the file's total bounds,
     * so text is always the same readable size regardless of file length.
     * Short files show entirely; tall files show the top and you fly through.
     *
     * Emits 'camera-focus-changed' with { detail: { index } } for tree UI sync.
     *
     * @param {number} index - grid index
     */
    focusOnGrid(index) {
        const THREE = this.THREE;
        const grids = this.ctx.getGrids();
        if (index < 0 || index >= grids.length) return;

        const grid = grids[index];
        const bounds = grid.getBounds();
        const size = new THREE.Vector3();
        bounds.getSize(size);

        // Straight-on: reset rotation so camera faces -Z (perpendicular to content)
        this.pitch = 0;
        this.yaw = 0;

        // --- Reading distance from line metrics ---
        const lineCount = grid.lines ? grid.lines.length : 1;
        const lineSpacing = size.y / Math.max(lineCount, 1);

        const READABLE_LINES = 35;
        const visibleLines = Math.min(lineCount, READABLE_LINES);
        const targetViewHeight = visibleLines * lineSpacing;

        const fovRad = this.ctx.camera.fov * Math.PI / 180;
        const halfTan = Math.tan(fovRad / 2);

        const distForHeight = (targetViewHeight / 0.85) / (2 * halfTan);
        const distForWidth = (size.x / 0.85) / (2 * this.ctx.camera.aspect * halfTan);
        const distance = Math.max(distForHeight, distForWidth, 5);

        // Position at the top of the file, centered horizontally
        const centerX = (bounds.min.x + bounds.max.x) / 2;
        const topY = bounds.max.y;

        const visibleHalfH = distance * halfTan;
        const topMargin = 0.08;
        const cameraY = topY - visibleHalfH * (1 - 2 * topMargin);

        this.ctx.camera.position.set(centerX, cameraY, bounds.max.z + distance);

        // Emit event for tree UI sync (replaces inline DOM manipulation)
        window.dispatchEvent(new CustomEvent('camera-focus-changed', {
            detail: { index }
        }));
    }

    /**
     * Focus camera to fit all grids in view.
     */
    focusOnGrids() {
        const THREE = this.THREE;
        const grids = this.ctx.getGrids();
        if (grids.length === 0) return;

        const bounds = this.ctx.spiralManager
            ? this.ctx.spiralManager.getTotalBounds()
            : this.ctx.hierarchicalManager
                ? this.ctx.hierarchicalManager.getTotalBounds()
                : this.ctx.layoutManager.getTotalBounds();

        const center = new THREE.Vector3();
        bounds.getCenter(center);
        const size = new THREE.Vector3();
        bounds.getSize(size);

        const distance = this._zDistanceForFit(size.x, size.y, 0.85);
        this.ctx.camera.position.set(center.x, center.y, bounds.max.z + distance);
        this.pitch = 0;
        this.yaw = 0;
    }

    /**
     * Focus camera on a directory's bounds in 3D space.
     * @param {string} dirPath
     */
    focusOnDirectory(dirPath) {
        const THREE = this.THREE;
        if (!this.ctx.hierarchicalManager) return;

        const bounds = this.ctx.hierarchicalManager.getDirectoryBounds(dirPath);
        if (!bounds) return;

        const center = new THREE.Vector3();
        bounds.getCenter(center);
        const size = new THREE.Vector3();
        bounds.getSize(size);

        const distance = this._zDistanceForFit(size.x, size.y, 0.85);
        this.ctx.camera.position.set(center.x, center.y, bounds.max.z + distance);
        this.pitch = 0;
        this.yaw = 0;
    }

    /**
     * Focus camera on diff grids (when viewing a PR).
     * @param {Object} diffController - DiffController instance
     */
    focusOnDiffGrids(diffController) {
        const THREE = this.THREE;
        const grids = this.ctx.getGrids();
        if (grids.length === 0) return;

        const bounds = diffController.getTotalBounds();
        if (!bounds) return;

        const center = new THREE.Vector3();
        bounds.getCenter(center);
        const size = new THREE.Vector3();
        bounds.getSize(size);

        const maxDim = Math.max(size.x, size.y);
        const distance = Math.min(maxDim * 0.5, 800);
        this.ctx.camera.position.set(center.x, center.y, center.z + distance + 100);
        this.pitch = 0;
        this.yaw = 0;
    }

    /**
     * Focus camera on a diff file by file index.
     * Each file has 2 grids (left + right), so multiply by 2.
     * @param {number} fileIndex
     */
    focusOnDiffFile(fileIndex) {
        const gridIndex = fileIndex * 2;
        const grids = this.ctx.getGrids();
        if (gridIndex >= 0 && gridIndex < grids.length) {
            this.focusOnGrid(gridIndex);
        }
    }

    // ============ Controls ============

    /**
     * Set camera movement speed from slider value.
     * @param {number} speed - raw slider value (multiplied by 20 internally)
     */
    setSpeed(speed) {
        this.cameraSpeed = speed * 20;
        this.settings.cameraSpeed = this.cameraSpeed;
        this._persistSettings();
    }

    /**
     * Reset camera to default position and rotation.
     */
    reset() {
        this.ctx.camera.position.set(0, 0, 500);
        this.pitch = 0;
        this.yaw = 0;
    }

    /**
     * Reset all settings to defaults and update UI.
     */
    resetSettings() {
        this.settings = { ...DEFAULTS };
        this.cameraSpeed = this.settings.cameraSpeed;
        this._persistSettings();
        this._restoreUI();
    }

    // ============ Helpers ============

    /**
     * Calculate the Z distance needed so that a region of `width` x `height`
     * fills approximately `fillFraction` of the viewport.
     * Uses the camera's vertical FOV and aspect ratio.
     * @private
     */
    _zDistanceForFit(width, height, fillFraction = 0.85) {
        const fovRad = this.ctx.camera.fov * Math.PI / 180;
        const aspect = this.ctx.camera.aspect;

        const dH = (height / fillFraction) / (2 * Math.tan(fovRad / 2));
        const dW = (width / fillFraction) / (2 * aspect * Math.tan(fovRad / 2));

        return Math.max(dH, dW);
    }

    // ============ Lifecycle ============

    /**
     * Full cleanup — remove all listeners, exit pointer lock.
     */
    dispose() {
        this.teardownEventListeners();
    }
}

export default CameraController;

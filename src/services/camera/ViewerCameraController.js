/**
 * ViewerCameraController — extracted camera subsystem
 *
 * Translation-first navigation: click-drag pans, scroll zooms,
 * WASD translates in camera-relative directions.
 *
 * All user-adjustable settings are persisted to localStorage under
 * namespaced g3d.camera.* keys via StateController.
 *
 * Receives a SceneContext for shared references (camera, canvas, etc.).
 * Emits 'camera-focus-changed' window events for tree UI sync.
 */

import { primaryMod, secondaryMod } from '../utils/platform.js';
import { getCanvasViewportSize } from '../../core/canvasSize.js';
import { stateController } from '../state/StateController.js';

const CAMERA_DEFAULTS = {
    cameraSpeed: 100,
    dragSensitivity: 1.0,
    scrollSensitivity: 1.0,
    invertDragX: false,
    invertDragY: false,
    invertScroll: false,
    dynamicSpeed: true,
};

export class ViewerCameraController {
    /**
     * @param {SceneContext} ctx
     */
    constructor(ctx) {
        this.ctx = ctx;
        this.THREE = ctx.THREE;

        // Load persisted settings (per-field from StateController)
        this.settings = {
            cameraSpeed:       stateController.get('camera.speed', CAMERA_DEFAULTS.cameraSpeed),
            dragSensitivity:   stateController.get('camera.dragSensitivity', CAMERA_DEFAULTS.dragSensitivity),
            scrollSensitivity: stateController.get('camera.scrollSensitivity', CAMERA_DEFAULTS.scrollSensitivity),
            invertDragX:       stateController.get('camera.invertDragX', CAMERA_DEFAULTS.invertDragX),
            invertDragY:       stateController.get('camera.invertDragY', CAMERA_DEFAULTS.invertDragY),
            invertScroll:      stateController.get('camera.invertScroll', CAMERA_DEFAULTS.invertScroll),
            dynamicSpeed:      stateController.get('camera.dynamicSpeed', CAMERA_DEFAULTS.dynamicSpeed),
        };

        // Movement state
        this.keys = {};
        this.cameraSpeed = this.settings.cameraSpeed;

        // Drag state (translation, not rotation)
        this.isDragging = false;
        this._dragPrevX = 0;
        this._dragPrevY = 0;

        // Click disambiguation: track mousedown position to distinguish
        // click (displacement < 5px) from drag (displacement >= 5px)
        this._mouseDownX = 0;
        this._mouseDownY = 0;

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

        // Focus pivot — the one point that zoom dollies toward and orbit
        // rotates around. Defaults to world origin; focus sources (implicit
        // raycast under cursor, explicit window.focus command) update it so
        // "zoom in" always means "zoom in on the thing I'm looking at".
        this._focusPivot = new this.THREE.Vector3(0, 0, 0);

        // --- Click-drag to pan (translation); Shift+drag = orbit (rotation) ---
        this._onMouseDown = (e) => {
            if (e.target === canvas || canvas.contains(e.target)) {
                this.isDragging = true;
                this.dragMode = e.shiftKey ? 'orbit' : 'pan';
                this._dragPrevX = e.clientX;
                this._dragPrevY = e.clientY;
                this._mouseDownX = e.clientX;
                this._mouseDownY = e.clientY;
                canvas.style.cursor = this.dragMode === 'orbit' ? 'move' : 'grabbing';
            }
        };
        this._onMouseUp = (e) => {
            if (this.isDragging) {
                const dx = e.clientX - this._mouseDownX;
                const dy = e.clientY - this._mouseDownY;
                const displacement = Math.sqrt(dx * dx + dy * dy);

                // Displacement under threshold → treat as a click, not a drag
                if (displacement < 5) {
                    canvas.dispatchEvent(new CustomEvent('canvas-click', {
                        detail: {
                            clientX: e.clientX,
                            clientY: e.clientY,
                            shiftKey: e.shiftKey,
                            ctrlKey: e.ctrlKey,
                            metaKey: e.metaKey
                        },
                        bubbles: true
                    }));
                }
            }
            this.isDragging = false;
            canvas.style.cursor = 'grab';
        };
        this._onMouseMove = (e) => {
            // Focus-pivot probe: while NOT dragging, throttle-raycast under the
            // cursor so `_focusPivot` tracks whatever window the user is
            // pointing at. Explicit focus (later step) will set a lock flag
            // that suppresses this update.
            if (!this.isDragging) {
                this._updateFocusPivotFromCursor(e.clientX, e.clientY);
                return;
            }

            const dx = e.clientX - this._dragPrevX;
            const dy = e.clientY - this._dragPrevY;
            this._dragPrevX = e.clientX;
            this._dragPrevY = e.clientY;

            if (this.dragMode === 'orbit') {
                this._applyDragRotation(dx, dy);
            } else {
                this._applyDragTranslation(dx, dy);
            }
        };

        canvas.addEventListener('mousedown', this._onMouseDown);
        document.addEventListener('mouseup', this._onMouseUp);
        document.addEventListener('mousemove', this._onMouseMove);

        // --- Scroll: pan by default, zoom with Alt/Option or pinch (ctrlKey) ---
        this._onWheel = (e) => {
            if (e.target === canvas || canvas.contains(e.target)) {
                e.preventDefault();
                if (secondaryMod(e) || e.ctrlKey) {
                    // Secondary mod + scroll = zoom (Alt on Mac, Shift on Linux/Win)
                    // ctrlKey = trackpad pinch-to-zoom (browsers set ctrlKey for pinch)
                    //
                    // Zoom dollies the camera *toward the focus pivot*, not
                    // along its own forward axis. That way "zoom in" always
                    // converges on the thing you're focused on — the window
                    // you're reading stays centered and grows in the view,
                    // instead of sliding sideways as the camera moves along
                    // an abstract axis.
                    const delta = this.settings.invertScroll ? e.deltaY : -e.deltaY;
                    const toPivot = this._focusPivot.clone().sub(camera.position);
                    const dist = toPivot.length();
                    if (dist > 0.01) {
                        const zoomScale = this.settings.dynamicSpeed
                            ? dist / 200
                            : 1;
                        let zoomAmount = delta * this.settings.scrollSensitivity * 0.5 * zoomScale;
                        // Clamp so we never dolly past the pivot; leave a
                        // small buffer so we can still orbit close-up.
                        const maxIn = dist - 1;
                        if (zoomAmount > maxIn) zoomAmount = maxIn;
                        const dir = toPivot.divideScalar(dist);
                        camera.position.addScaledVector(dir, zoomAmount);
                    }
                } else {
                    // Scroll = pan (translate)
                    this._applyDragTranslation(-e.deltaX, -e.deltaY);
                }
            }
        };
        canvas.addEventListener('wheel', this._onWheel, { passive: false });

        // Set default cursor
        canvas.style.cursor = 'grab';

        // --- Window resize (camera-side: aspect ratio + projection) ---
        this._onResize = () => {
            const { width, height } = getCanvasViewportSize(canvas);
            camera.aspect = width / height;
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
     * Get the effective view distance for speed scaling.
     * Uses camera Z (distance to content plane) rather than distance from
     * ORBIT rotation. Shift+drag rotates the camera *around* `_focusPivot`,
     * keeping it at the same distance from the pivot but swinging its
     * position along a sphere. Syncs yaw/pitch afterward so WASD keeps
     * working in the new orientation.
     *
     * @private
     */
    /**
     * Throttled raycast under the cursor. When the cursor hovers a window,
     * update `_focusPivot` to that window's world-space center so subsequent
     * zoom/orbit operations treat it as the anchor. When the cursor is over
     * empty space, leave the pivot alone — we don't want it flicking back to
     * origin every time the user moves to the canvas edge.
     *
     * @private
     */
    _updateFocusPivotFromCursor(clientX, clientY) {
        if (this._focusLocked) return;   // explicit focus (step 3) overrides
        const now = performance.now();
        if (now - (this._lastFocusProbe || 0) < 60) return;
        this._lastFocusProbe = now;

        const hd = this.ctx?.hitDispatcher;
        if (!hd || typeof hd.raycastAtClient !== 'function') return;
        const hit = hd.raycastAtClient(clientX, clientY);
        if (!hit || !hit.point) return;

        // Use the exact world-space intersection point — zoom lands on the
        // precise line/glyph the cursor is over, not just the window center.
        this._focusPivot.copy(hit.point);
    }

    _applyDragRotation(dx, dy) {
        const camera = this.ctx.camera;
        const pivot = this._focusPivot;
        const offset = camera.position.clone().sub(pivot);
        const radius = offset.length();
        if (radius < 0.001) return;

        // Camera → pivot vector in spherical coords.
        let theta = Math.atan2(offset.x, offset.z);
        let phi   = Math.acos(Math.max(-1, Math.min(1, offset.y / radius)));

        const sens = this.settings?.rotateSensitivity ?? 0.005;
        theta -= dx * sens;
        phi   -= dy * sens;

        const eps = 0.02;
        phi = Math.max(eps, Math.min(Math.PI - eps, phi));

        offset.x = radius * Math.sin(phi) * Math.sin(theta);
        offset.y = radius * Math.cos(phi);
        offset.z = radius * Math.sin(phi) * Math.cos(theta);

        camera.position.copy(pivot).add(offset);
        camera.lookAt(pivot);

        // lookAt wrote a fresh quaternion. The per-frame update() loop will
        // re-derive the camera's quaternion from this.pitch/this.yaw using
        // a 'YXZ' Euler, so we must extract our new pitch/yaw from the
        // quaternion in that same order — otherwise the next frame resets
        // the rotation and the orbit appears to do nothing.
        const euler = new this.THREE.Euler(0, 0, 0, 'YXZ');
        euler.setFromQuaternion(camera.quaternion);
        this.pitch = euler.x;
        this.yaw = euler.y;
    }

    /**
     * world origin, so pan/zoom feel consistent regardless of X/Y offset.
     * @returns {number}
     */
    _getViewDistance() {
        // Camera faces -Z; content lives near Z=0. Camera Z ≈ view distance.
        return Math.max(Math.abs(this.ctx.camera.position.z), 1);
    }

    /**
     * Apply drag translation: maps screen-pixel deltas to camera-relative
     * world-space panning. When dynamicSpeed is on, the scale factor tracks
     * the camera's Z distance so dragging feels proportional at any zoom.
     * @param {number} dx - screen pixels horizontal
     * @param {number} dy - screen pixels vertical
     */
    _applyDragTranslation(dx, dy) {
        const THREE = this.THREE;
        const camera = this.ctx.camera;
        const sens = this.settings.dragSensitivity;

        const dist = this.settings.dynamicSpeed ? this._getViewDistance() : 200;
        const fovFactor = 2 * Math.tan((camera.fov * Math.PI / 180) / 2);
        const { height: vpHeight } = getCanvasViewportSize(this.ctx.canvas);
        const pixelScale = (dist * fovFactor) / vpHeight;

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
     * Save current settings to localStorage (per-field).
     * @private
     */
    _persistSettings() {
        const s = this.settings;
        stateController.set('camera.speed', s.cameraSpeed);
        stateController.set('camera.dragSensitivity', s.dragSensitivity);
        stateController.set('camera.scrollSensitivity', s.scrollSensitivity);
        stateController.set('camera.invertDragX', s.invertDragX);
        stateController.set('camera.invertDragY', s.invertDragY);
        stateController.set('camera.invertScroll', s.invertScroll);
        stateController.set('camera.dynamicSpeed', s.dynamicSpeed);
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
        if (this.keys['Space'] || this.keys['KeyQ']) moveDir.y += 1;
        if (this.keys['KeyE']) moveDir.y -= 1;

        if (moveDir.length() > 0) {
            moveDir.normalize();
            moveDir.applyQuaternion(camera.quaternion);
            // Scale WASD speed by view distance so movement feels consistent
            const speedScale = this.settings.dynamicSpeed
                ? this._getViewDistance() / 200   // 200 = baseline distance
                : 1;
            moveDir.multiplyScalar(this.cameraSpeed * deltaTime * speedScale);
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

        const bounds = this.ctx.stackManager
            ? this.ctx.stackManager.getTotalBounds()
            : this.ctx.treemapManager
                ? this.ctx.treemapManager.getTotalBounds()
                : this.ctx.spiralManager
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
     * Toggle dynamic speed scaling (pan/WASD/zoom scale with camera distance).
     * @returns {boolean} New state
     */
    toggleDynamicSpeed() {
        this.settings.dynamicSpeed = !this.settings.dynamicSpeed;
        this._persistSettings();
        return this.settings.dynamicSpeed;
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
        this.settings = { ...CAMERA_DEFAULTS };
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

export default ViewerCameraController;

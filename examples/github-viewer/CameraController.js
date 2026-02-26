/**
 * CameraController — extracted camera subsystem
 *
 * Owns: WASD movement, mouse look, pointer lock, focus methods,
 * speed slider, reset button, window resize (camera-side only).
 *
 * Receives a SceneContext for shared references (camera, canvas, etc.).
 * Emits 'camera-focus-changed' window events for tree UI sync.
 */

export class CameraController {
    /**
     * @param {SceneContext} ctx
     */
    constructor(ctx) {
        this.ctx = ctx;
        this.THREE = ctx.THREE;

        // Movement state
        this.keys = {};
        this.cameraSpeed = 100;
        this.lookSensitivity = 0.002;

        // Rotation state
        this.pitch = 0;
        this.yaw = 0;

        // Pointer lock
        this.isPointerLocked = false;

        // Bound listener refs for cleanup
        this._onKeyDown = null;
        this._onKeyUp = null;
        this._onCanvasClick = null;
        this._onPointerLockChange = null;
        this._onMouseMove = null;
        this._onResize = null;
        this._onSpeedChange = null;
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

        // --- Pointer lock for mouse look ---
        this._onCanvasClick = () => { canvas.requestPointerLock(); };
        canvas.addEventListener('click', this._onCanvasClick);

        this._onPointerLockChange = () => {
            this.isPointerLocked = document.pointerLockElement === canvas;
            canvas.style.cursor = this.isPointerLocked ? 'none' : '';
        };
        document.addEventListener('pointerlockchange', this._onPointerLockChange);

        this._onMouseMove = (e) => {
            if (this.isPointerLocked) {
                this.yaw -= e.movementX * this.lookSensitivity;
                this.pitch -= e.movementY * this.lookSensitivity;
                this.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.pitch));
            }
        };
        document.addEventListener('mousemove', this._onMouseMove);

        // --- Window resize (camera-side: aspect ratio + projection) ---
        this._onResize = () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
        };
        window.addEventListener('resize', this._onResize);

        // --- Speed slider ---
        const slider = document.getElementById('cam-speed');
        const valueLabel = document.getElementById('cam-speed-value');
        if (slider) {
            this._onSpeedChange = (e) => {
                const speed = parseFloat(e.target.value);
                if (valueLabel) valueLabel.textContent = speed.toFixed(1);
                this.setSpeed(speed);
            };
            slider.addEventListener('input', this._onSpeedChange);
            this._speedSlider = slider;
        }

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
    }

    /**
     * Remove all event listeners. Called by dispose().
     */
    teardownEventListeners() {
        document.removeEventListener('keydown', this._onKeyDown);
        document.removeEventListener('keyup', this._onKeyUp);

        if (this.ctx.canvas) {
            this.ctx.canvas.removeEventListener('click', this._onCanvasClick);
        }
        document.removeEventListener('pointerlockchange', this._onPointerLockChange);
        document.removeEventListener('mousemove', this._onMouseMove);
        window.removeEventListener('resize', this._onResize);

        if (this._speedSlider && this._onSpeedChange) {
            this._speedSlider.removeEventListener('input', this._onSpeedChange);
        }
        if (this._resetBtn && this._onReset) {
            this._resetBtn.removeEventListener('click', this._onReset);
        }
        if (this._fitAllBtn && this._onFitAll) {
            this._fitAllBtn.removeEventListener('click', this._onFitAll);
        }

        // Exit pointer lock if active
        if (this.isPointerLocked) {
            document.exitPointerLock();
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

        const bounds = this.ctx.hierarchicalManager
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
    }

    /**
     * Reset camera to default position and rotation.
     */
    reset() {
        this.ctx.camera.position.set(0, 0, 500);
        this.pitch = 0;
        this.yaw = 0;
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

/**
 * Hand Tracking Example App
 *
 * Demonstrates hand tracking with three swappable sources:
 * - Mock: mouse-driven procedural hand (for dev/testing)
 * - Webcam: MediaPipe Hands via browser camera
 * - WebSocket: external source (e.g., iPhone ARKit + LiDAR)
 *
 * Features WASD camera movement and wireframe hand rendering
 * with pinch gesture detection.
 */

import * as THREE from 'three';
import HandRenderer from '@glyph3d/core/hand/HandRenderer.js';
import GestureDetector from '@glyph3d/core/hand/GestureDetector.js';
import MockHandSource from '@glyph3d/core/hand/MockHandSource.js';
import WebcamHandSource from '@glyph3d/core/hand/WebcamHandSource.js';
import WebSocketHandSource from '@glyph3d/core/hand/WebSocketHandSource.js';
import ViewportRenderer from '@glyph3d/core/hand/ViewportRenderer.js';
import CameraController from '@glyph3d/core/camera/CameraController.js';
import InputManager from '@glyph3d/core/camera/InputManager.js';

class HandTrackingApp {
    constructor(canvas, config = {}) {
        this.canvas = canvas;
        this.config = config;
        this.source = null;
        this.sourceType = null;
        this._animating = false;
        this._lastFrame = null;
        this._cameraPreview = null;

        // Three.js core
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0a0a0a);

        this.camera = new THREE.PerspectiveCamera(
            60,
            window.innerWidth / window.innerHeight,
            0.01,
            1000
        );
        this.camera.position.set(0, 0, 5);
        // Camera must be in the scene graph for children (hand) to render
        this.scene.add(this.camera);

        // Input & camera control
        this.inputManager = new InputManager();
        this.inputManager.init(canvas);

        this.cameraController = new CameraController(this.camera, this.inputManager, {
            CAMERA_SPEED: 5,
            CAMERA_ACCELERATION: 8,
            CAMERA_SENSITIVITY: 0.002,
            CAMERA_ROTATION_X_MIN: -Math.PI / 2,
            CAMERA_ROTATION_X_MAX: Math.PI / 2,
        });

        // Hand wireframe renderer — attached as child of camera
        this.handRenderer = new HandRenderer({
            lineColor:  config.lineColor  ?? 0x00ff88,
            jointColor: config.jointColor ?? 0x00ffcc,
            jointSize:  config.jointSize  ?? 0.006,
            boneRadius: config.boneRadius ?? 0.003,
            spread:     config.spread     ?? 0.45,
            depth:      config.depth      ?? -1.85,
            scale:      config.scale      ?? 1.40,
        });
        this.handRenderer.attachToCamera(this.camera);

        // Viewport frustum — shows tracking volume from iPhone source.
        // Shares spread/depth/scale so the frustum aligns with the hand.
        this.viewportRenderer = new ViewportRenderer({
            spread: config.spread ?? 0.45,
            depth:  config.depth  ?? -1.85,
            scale:  config.scale  ?? 1.40,
        });
        this.viewportRenderer.attachToCamera(this.camera);

        // Gesture detection
        this.gestureDetector = new GestureDetector({
            onPinchStart: (pos) => this._onPinchStart(pos),
            onPinchEnd: (pos) => this._onPinchEnd(pos),
            onPinchMove: (pos, startPos) => this._onPinchMove(pos, startPos),
        });

        // Scene reference objects
        this._addSceneObjects();

        // UI references
        this.statusEl = document.getElementById('status');
        this.gestureEl = document.getElementById('gesture-info');

        // Resize
        window.addEventListener('resize', () => this._onResize());

        this.clock = new THREE.Clock();
    }

    /**
     * Initialize with a given source type.
     * Can be called multiple times to switch sources.
     * @param {'mock'|'webcam'|'websocket'} sourceType
     */
    async init(sourceType = 'mock') {
        // Clean up previous source
        if (this.source) {
            this.source.dispose?.();
            this.source = null;
        }
        this._removeCameraPreview();

        this.sourceType = sourceType;

        switch (sourceType) {
            case 'webcam':
                this._setStatus('Loading MediaPipe model...');
                this.source = new WebcamHandSource({
                    referenceSpan: this.config.refSpan,
                    depthScale: this.config.depthScale,
                    firstPerson: this.config.firstPerson ?? true,
                    onReady: () => this._setStatus('Webcam active — tracking hands'),
                    onError: (err) => {
                        this._setStatus(`Webcam failed: ${err.message} — falling back to mock`);
                        this._initMockSource();
                    },
                });

                // Re-enable pointer lock for camera control
                this.inputManager.lockElement = this.canvas;
                try {
                    await this.source.init();
                } catch {
                    this._initMockSource();
                }
                break;

            case 'websocket':
                this._setStatus('Connecting to WebSocket...');
                this.source = new WebSocketHandSource({
                    url: this._getWSUrl(),
                    onConnect: () => this._setStatus('WebSocket connected — receiving hand data'),
                    onDisconnect: () => this._setStatus('WebSocket disconnected — reconnecting...'),
                    onCameraFrame: (frame) => this._showCameraPreview(frame),
                });

                // Re-enable pointer lock for camera control
                this.inputManager.lockElement = this.canvas;
                this.source.connect();
                break;

            default:
                this._initMockSource();
        }

        // Start render loop (idempotent — only starts once)
        if (!this._animating) {
            this._animating = true;
            this._animate();
        }
    }

    /** @private */
    _initMockSource() {
        this.sourceType = 'mock';
        // Disable pointer lock so mouse can drive the mock hand
        this.inputManager.lockElement = null;
        this.source = new MockHandSource({ canvas: this.canvas });
        this._setStatus('Mock mode — move mouse for hand, Space to pinch, WASD to move');
    }

    /** @private */
    _getWSUrl() {
        const params = new URLSearchParams(window.location.search);
        return params.get('ws') || `ws://localhost:${window.location.port || 8080}`;
    }

    /** @private */
    _animate() {
        requestAnimationFrame(() => this._animate());

        const dt = this.clock.getDelta();

        // Camera movement (rotation only works when pointer is locked)
        this.cameraController.update(dt);

        // Get hand data from active source
        let frames = null;
        if (this.sourceType === 'websocket') {
            frames = this.source?.getLatestFrames?.();
        } else if (this.source?.detect) {
            frames = this.source.detect();
        }

        // Cache last valid frame so the hand persists between updates
        if (frames) {
            this._lastFrame = frames[0] || null;
        }
        const frame = frames ? (frames[0] || null) : this._lastFrame;
        this.handRenderer.updateFromFrame(frame);
        this.viewportRenderer.updateFromScene(frame?.scene || null);
        const gesture = this.gestureDetector.update(frame);

        // Visual feedback: change hand color on pinch
        if (gesture.pinching) {
            this.handRenderer.setColor(0xff4488);
            this.handRenderer.setJointColor(0xff88aa);
        } else {
            this.handRenderer.setColor(0x00ff88);
            this.handRenderer.setJointColor(0x00ffcc);
        }

        this._updateGestureUI(gesture);

        this.renderer.render(this.scene, this.camera);
    }

    /** @private */
    _addSceneObjects() {
        // Grid floor
        const grid = new THREE.GridHelper(20, 20, 0x333333, 0x222222);
        grid.position.y = -2;
        this.scene.add(grid);

        // Reference cubes at various positions
        const cubeGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
        const colors = [0xff4444, 0x44ff44, 0x4444ff, 0xffff44, 0xff44ff];
        for (let i = 0; i < 5; i++) {
            const mat = new THREE.MeshBasicMaterial({
                color: colors[i],
                wireframe: true,
                transparent: true,
                opacity: 0.6,
            });
            const cube = new THREE.Mesh(cubeGeo, mat);
            cube.position.set((i - 2) * 1.5, 0, 0);
            this.scene.add(cube);
        }

        // Axes helper for orientation
        const axes = new THREE.AxesHelper(1);
        this.scene.add(axes);
    }

    /** @private */
    _onPinchStart(pos) {
        console.log('[Gesture] Pinch start', pos);
    }

    /** @private */
    _onPinchEnd(pos) {
        console.log('[Gesture] Pinch end', pos);
    }

    /** @private */
    _onPinchMove(pos, startPos) {
        // TODO: implement drag behavior for moving objects
    }

    /** @private */
    _setStatus(text) {
        if (this.statusEl) this.statusEl.textContent = text;
        console.log(`[HandTracking] ${text}`);
    }

    /** @private */
    _updateGestureUI(gesture) {
        if (!this.gestureEl) return;
        if (gesture.pinching) {
            this.gestureEl.textContent = 'PINCH';
            this.gestureEl.classList.add('active');
        } else {
            this.gestureEl.textContent = 'open';
            this.gestureEl.classList.remove('active');
        }
    }

    /** @private */
    _showCameraPreview(frame) {
        if (!this._cameraPreview) {
            this._cameraPreview = document.createElement('img');
            this._cameraPreview.style.cssText = 'position:fixed;top:0;right:0;width:160px;height:auto;opacity:0.4;z-index:100;pointer-events:none;border-bottom-left-radius:6px;';
            document.body.appendChild(this._cameraPreview);
        }
        this._cameraPreview.src = `data:image/jpeg;base64,${frame.image}`;
    }

    /** @private */
    _removeCameraPreview() {
        if (this._cameraPreview) {
            this._cameraPreview.remove();
            this._cameraPreview = null;
        }
    }

    /** @private */
    _onResize() {
        const w = window.innerWidth;
        const h = window.innerHeight;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
    }

    /**
     * Cleanup all resources
     */
    dispose() {
        this._animating = false;
        this.source?.dispose?.();
        this._removeCameraPreview();
        this.handRenderer.dispose();
        this.viewportRenderer.dispose();
        this.inputManager.dispose();
        this.renderer.dispose();
    }
}

export { HandTrackingApp };

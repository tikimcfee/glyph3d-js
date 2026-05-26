/**
 * Camera Wrapper
 *
 * Wraps Three.js PerspectiveCamera with configuration and helper methods.
 * Separates camera creation from camera control logic (handled by CameraController).
 */

import * as THREE from 'three';

class Camera {
    /**
     * Create and configure a perspective camera
     * @param {Object} config - Configuration object
     */
    constructor(config) {
        this.config = config;

        // Create Three.js camera
        this.camera = new THREE.PerspectiveCamera(
            this.config.CAMERA_FOV,
            window.innerWidth / window.innerHeight,
            this.config.CAMERA_NEAR,
            this.config.CAMERA_FAR
        );

        // Set initial position
        this.setPosition(
            this.config.CAMERA_POSITION.x,
            this.config.CAMERA_POSITION.y,
            this.config.CAMERA_POSITION.z
        );

        // Look at origin
        this.camera.lookAt(0, 0, 0);
    }

    /**
     * Set camera position
     * @param {number} x - X coordinate
     * @param {number} y - Y coordinate
     * @param {number} z - Z coordinate
     */
    setPosition(x, y, z) {
        this.camera.position.set(x, y, z);
    }

    /**
     * Point camera at target
     * @param {number|THREE.Vector3} x - Target x or Vector3
     * @param {number} y - Target y (if x is number)
     * @param {number} z - Target z (if x is number)
     */
    lookAt(x, y, z) {
        if (x instanceof THREE.Vector3) {
            this.camera.lookAt(x);
        } else {
            this.camera.lookAt(x, y, z);
        }
    }

    /**
     * Update camera aspect ratio
     * @param {number} aspect - New aspect ratio (width / height)
     */
    updateAspect(aspect) {
        this.camera.aspect = aspect;
        this.camera.updateProjectionMatrix();
    }

    /**
     * Update aspect ratio from window dimensions
     */
    updateAspectFromWindow() {
        this.updateAspect(window.innerWidth / window.innerHeight);
    }

    /**
     * Get the underlying Three.js camera
     * @returns {THREE.PerspectiveCamera}
     */
    getCamera() {
        return this.camera;
    }

    /**
     * Get camera position
     * @returns {THREE.Vector3}
     */
    getPosition() {
        return this.camera.position;
    }

    /**
     * Get camera rotation
     * @returns {THREE.Euler}
     */
    getRotation() {
        return this.camera.rotation;
    }
}

export default Camera;
